"""Run the workflow unit suite with test classes spread over parallel processes.

`python -m workflow.run_tests [--jobs N] [start_dir]` discovers every test class like `unittest discover -s workflow
-t .`, runs each class in its own `python -m unittest` process (at most N at a time, default the CPU count or
`WORKFLOW_TEST_JOBS`), and prints one unittest-style summary, so the verifier's log parser counts it like a plain run.
Failed children's output is echoed indented with its counts respelled, so only the final summary is parsed. Classes are the unit of
parallelism because each fixture class owns its temporary repositories; tests within a class keep their order.
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


def counts(output: str) -> dict:
    """Totals from one child's unittest summary; a child without a summary counts as one error."""
    ran = re.search(r"^Ran (\d+) tests? in", output, re.MULTILINE)
    if not ran or not re.search(r"^(?:OK(?:\s|$)|FAILED\s*\()", output, re.MULTILINE):
        return {"tests": 0, "failures": 0, "errors": 1, "skipped": 0}
    found = {key: sum(int(value) for value in re.findall(rf"\b{key}=(\d+)", output)) for key in ("failures", "errors", "skipped")}
    return {"tests": int(ran[1]), **found}


def run_class(name: str) -> tuple[str, int, str]:
    result = subprocess.run([sys.executable, "-m", "unittest", name], capture_output=True, text=True)
    return name, result.returncode, result.stdout + result.stderr


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("start_dir", nargs="?", default="workflow")
    parser.add_argument("--jobs", type=int, default=int(os.environ.get("WORKFLOW_TEST_JOBS") or os.cpu_count() or 1))
    args = parser.parse_args(argv)
    if args.jobs < 1:
        parser.error("--jobs must be at least 1")
    started = time.monotonic()
    classes = test_classes(args.start_dir)
    totals = {"tests": 0, "failures": 0, "errors": 0, "skipped": 0}
    with ThreadPoolExecutor(max_workers=args.jobs) as pool:
        for name, code, output in pool.map(run_class, [name for name, _ in classes]):
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
