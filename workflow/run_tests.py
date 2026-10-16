"""Run the workflow unit suite with test classes spread over parallel processes.

`python -m workflow.run_tests [--jobs N] [--tests ID [ID ...] | start_dir]` discovers every test class like `unittest
discover -s workflow -t .` (or, with `--tests`, only the named module, class and method ids), runs each class in its own process (at most N at a time, default the CPU count or `WORKFLOW_TEST_JOBS`), and
prints one unittest-style summary, so the verifier's log parser counts it like a plain run. A child is `python -m unittest
<class>` that also notes a failed command's captured output under its CalledProcessError. Failed children's output is
echoed indented with its counts respelled, so only the final summary is parsed. Classes are the unit of
parallelism because each fixture class owns its temporary repositories; tests within a class keep their order. An id
`--tests` cannot load is one failing class line with a `WORKFLOW: no test named <id>` line under it, never a crash
(run-checks-once PRD 8.1: attribution reruns a run check's failing ids this way, and an id missing on a snapshot is
not applicable there).
"""
import argparse
import os
import re
import subprocess
import sys
import time
import unittest
from concurrent.futures import ThreadPoolExecutor


def test_classes(start_dir: str) -> list[tuple[str, int]]:
    """Each discovered class id with its test count, largest first so the slowest classes start early."""
    counts: dict[str, int] = {}

    def walk(suite):
        for item in suite:
            if isinstance(item, unittest.TestSuite):
                walk(item)
            elif isinstance(item, unittest.loader._FailedTest):
                raise SystemExit(f"Cannot import {item.id()}:\n{item._exception}")
            else:
                name = f"{type(item).__module__}.{type(item).__qualname__}"
                counts[name] = counts.get(name, 0) + 1

    walk(unittest.defaultTestLoader.discover(start_dir, top_level_dir="."))
    return sorted(counts.items(), key=lambda entry: (-entry[1], entry[0]))


NO_TEST = "WORKFLOW: no test named"  # The line under an unknown --tests id's failing class line (run_report.failing_ids).


def selected_classes(ids: list[str]) -> tuple[list[tuple[str, int, list[str]]], list[tuple[str, str]]]:
    """`--tests`: each class with its selected test count and the method ids its child runs, largest first, and each id
    that loads no test with why (an import or attribute error: the loader's _FailedTest)."""
    methods: dict[str, list[str]] = {}
    unknown = []
    for name in dict.fromkeys(ids):
        found, failed = [], []

        def walk(suite):
            for item in suite:
                if isinstance(item, unittest.TestSuite):
                    walk(item)
                elif isinstance(item, unittest.loader._FailedTest):
                    failed.append(str(item._exception).strip().splitlines()[-1] if str(item._exception).strip() else type(item._exception).__name__)
                else:
                    found.append(item)
        try:
            walk(unittest.defaultTestLoader.loadTestsFromName(name))
        except Exception as error:  # A name the loader refuses outright (an empty part, a non-test object).
            failed.append(f"{type(error).__name__}: {error}")
        if failed or not found:
            unknown.append((name, failed[0] if failed else "it names no test"))
            continue
        for item in found:
            listed = methods.setdefault(f"{type(item).__module__}.{type(item).__qualname__}", [])
            if item.id() not in listed:
                listed.append(item.id())
    classes = [(name, len(tests), tests) for name, tests in methods.items()]
    return sorted(classes, key=lambda entry: (-entry[1], entry[0])), unknown


def counts(output: str) -> dict:
    """Totals from one child's unittest summary; a child without a summary counts as one error.

    Only the status line after the last "Ran" line counts: a traceback or a noted command output may quote "errors=7".
    """
    ran = list(re.finditer(r"^Ran (\d+) tests? in", output, re.MULTILINE))
    status = re.compile(r"^(?:OK(?:\s|$)|FAILED\s*\().*", re.MULTILINE).search(output, ran[-1].end()) if ran else None
    if not status:
        return {"tests": 0, "failures": 0, "errors": 1, "skipped": 0}
    found = {key: sum(int(value) for value in re.findall(rf"\b{key}=(\d+)", status[0])) for key in ("failures", "errors", "skipped")}
    return {"tests": int(ran[-1][1]), **found}


def run_class(name: str, tests: list[str] | None = None) -> tuple[str, int, str]:
    # One unbuffered stream keeps prints next to the test that wrote them; bytes that are not UTF-8 are replaced,
    # never allowed to stop the run and lose every later class's traceback.
    result = subprocess.run([sys.executable, "-m", "workflow.run_tests", "--child", *(tests or [name])], stdout=subprocess.PIPE,
                            stderr=subprocess.STDOUT, env={**os.environ, "PYTHONUNBUFFERED": "1"})
    return name, result.returncode, result.stdout.decode(errors="replace")


PROCESS_OUTPUT_LINES = 20


def note_process_output(error: BaseException | None) -> None:
    """Note a failed command's captured output under its exception: CalledProcessError's message omits it, and
    it holds the cause (git's stderr says why `worktree add` exited 128)."""
    seen = set()
    while error is not None and id(error) not in seen:
        seen.add(id(error))
        if isinstance(error, subprocess.CalledProcessError):
            for label, value in (("stdout", error.stdout), ("stderr", error.stderr)):
                lines = (value.decode(errors="replace") if isinstance(value, bytes) else value or "").rstrip().splitlines()
                if not lines:
                    continue
                shown = f" (last {PROCESS_OUTPUT_LINES} lines)" if len(lines) > PROCESS_OUTPUT_LINES else ""
                note = f"{label} of the failed command{shown}:\n" + "\n".join(lines[-PROCESS_OUTPUT_LINES:])
                if note not in getattr(error, "__notes__", []):
                    error.add_note(note)
        # The chain the traceback prints: the explicit cause, else the implicit context unless it is suppressed.
        error = error.__cause__ if error.__cause__ is not None or error.__suppress_context__ else error.__context__


class NotedResult(unittest.TextTestResult):
    def addError(self, test, err):
        note_process_output(err[1])
        super().addError(test, err)

    def addFailure(self, test, err):
        note_process_output(err[1])
        super().addFailure(test, err)

    def addSubTest(self, test, subtest, err):
        if err is not None:
            note_process_output(err[1])
        super().addSubTest(test, subtest, err)


class NotedRunner(unittest.TextTestRunner):
    resultclass = NotedResult


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("start_dir", nargs="?", default=None, help="Where discovery starts (default workflow)")
    parser.add_argument("--jobs", type=int, default=int(os.environ.get("WORKFLOW_TEST_JOBS") or os.cpu_count() or 1))
    parser.add_argument("--tests", nargs="+", metavar="ID", help="Run only these module, class or method ids, not the discovered suite")
    parser.add_argument("--child", nargs="+", metavar="CLASS", help=argparse.SUPPRESS)
    args = parser.parse_args(argv)
    if args.child:
        # Exactly `python -m unittest <class>` (same output, warnings and exit codes), with the noting result.
        unittest.main(module=None, argv=["python -m unittest", *args.child], testRunner=NotedRunner)
    if args.jobs < 1:
        parser.error("--jobs must be at least 1")
    if args.tests and args.start_dir is not None:
        parser.error("--tests names the tests to run: it takes no start_dir")
    started = time.monotonic()
    totals = {"tests": 0, "failures": 0, "errors": 0, "skipped": 0}
    if args.tests:
        selected, unknown = selected_classes(args.tests)
        classes = [(name, count) for name, count, _ in selected]
        runs = [(name, tests) for name, _, tests in selected]
        for name, why in unknown:
            totals["errors"] += 1
            print(f"FAIL {name} (0 tests)\n    {NO_TEST} {name}: {why}", flush=True)
    else:
        classes = test_classes(args.start_dir or "workflow")
        runs = [(name, None) for name, _ in classes]
    with ThreadPoolExecutor(max_workers=args.jobs) as pool:
        for name, code, output in pool.map(lambda entry: run_class(*entry), runs):
            found = counts(output)
            if code != 0 and not (found["failures"] or found["errors"]):
                found["errors"] += 1  # A non-zero exit always fails the run, whatever the child printed.
            for key in totals:
                totals[key] += found[key]
            failed = code != 0
            print(f"{'FAIL' if failed else 'ok  '} {name} ({found['tests']} tests)", flush=True)
            if failed:
                # The verifier's parser reads the first "Ran" line and sums every "failures=N" in the log, so the
                # echoed child output is indented and its counts are respelled; only the final summary counts.
                echoed = re.sub(r"\b(failures|errors|skipped|unexpected successes)=", r"\1: ", output)
                print("\n".join("    " + line for line in echoed.splitlines()), flush=True)
    print("-" * 70)
    print(f"Ran {totals['tests']} tests in {time.monotonic() - started:.3f}s (parallel: {len(classes)} classes, {args.jobs} jobs)\n")
    details = ", ".join(f"{key}={totals[key]}" for key in ("failures", "errors", "skipped") if totals[key])
    if totals["failures"] or totals["errors"]:
        print(f"FAILED ({details})")
        return 1
    print(f"OK{f' ({details})' if details else ''}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
