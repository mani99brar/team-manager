"""`run-report`: a worker's test command run with its output in a log and only a bounded summary printed.

Importable without LangGraph (the prompt test imports `automatic` inside the test); no real `claude` runs: the haiku job
is a fake executable named by WORKFLOW_CLAUDE, as in test_panel.
"""
import io
import json
import os
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

from . import run_report
from .run_report import default_log, failures, main, summary

UNITTEST_LOG = """\
..F.E
======================================================================
ERROR: test_load (pkg.test_store.StoreTests.test_load)
----------------------------------------------------------------------
Traceback (most recent call last):
  File "/w/pkg/test_store.py", line 12, in test_load
    store.load("missing")
  File "/w/pkg/store.py", line 4, in load
    raise KeyError(name)
KeyError: 'missing'

======================================================================
FAIL: test_add (pkg.test_math.MathTests.test_add)
----------------------------------------------------------------------
Traceback (most recent call last):
  File "/w/pkg/test_math.py", line 8, in test_add
    self.assertEqual(add(1, 2), 4)
AssertionError: 3 != 4

----------------------------------------------------------------------
Ran 5 tests in 0.012s

FAILED (failures=1, errors=1)
"""

VITEST_LOG = """\
 \x1b[31m❯\x1b[39m src/math.test.ts (2 tests | 1 failed) 4ms
   \x1b[31m×\x1b[39m math > adds 3ms

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  src/math.test.ts > math > adds
AssertionError: expected 3 to be 4 // Object.is equality

- Expected
+ Received

 ❯ src/math.test.ts:5:22
      3|   it('adds', () => {
      4|     expect(add(1, 2)).toBe(4)

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯

 Test Files  1 failed | 5 passed (6)
      Tests  1 failed | 69 passed (70)
   Start at  10:00:00
   Duration  1.20s
"""

TAP_LOG = """\
TAP version 13
# Subtest: parses
ok 1 - parses
  ---
  duration_ms: 0.5
  ...
# Subtest: rejects bad input
not ok 2 - rejects bad input
  ---
  duration_ms: 0.7
  failureType: 'testCodeFailure'
  error: 'Expected values to be strictly equal:\\n\\n1 !== 2\\n'
  code: 'ERR_ASSERTION'
  ...
1..2
# tests 2
# suites 0
# pass 1
# fail 1
# cancelled 0
# skipped 0
# todo 0
# duration_ms 40.1
"""

FAKE_CLAUDE = r'''#!/usr/bin/env python3
import json, os, sys, time
from pathlib import Path
CONTROL = Path(%(control)r)
argv = sys.argv[1:]
spec = json.loads(CONTROL.read_text()) if CONTROL.exists() else {}
assert argv[argv.index("--tools") + 1] == "Read,Glob,Grep"
assert "--add-dir" not in argv
prompt = sys.stdin.read()
Path(%(seen)r).write_text(json.dumps({"argv": argv, "cwd": os.getcwd(), "prompt": prompt, "env": dict(os.environ)}))
time.sleep(spec.get("delay", 0))
result = {"session_id": argv[argv.index("--session-id") + 1], "is_error": bool(spec.get("is_error", False)), "subtype": "success",
          "structured_output": {"lines": spec.get("lines", [])}}
sys.stdout.write(json.dumps(result) + "\n")
sys.exit(int(spec.get("exit", 0)))
'''


def emit(text: str, code: int = 0) -> list[str]:
    """A command that prints `text` (split over stdout and stderr) and exits with `code`."""
    half = len(text) // 2
    return [sys.executable, "-c", f"import sys; sys.stdout.write({text[:half]!r}); sys.stdout.flush(); "
                                  f"sys.stderr.write({text[half:]!r}); sys.exit({code})"]


class Isolated(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.tmp = Path(temp.name)
        self.cwd = self.tmp / "worktree"
        self.cwd.mkdir()
        self.scratch = self.tmp / "scratch"
        self.scratch.mkdir()
        environment = mock.patch.dict(os.environ, {"TMPDIR": str(self.scratch), "WORKFLOW_CLAUDE": str(self.tmp / "no-claude")})
        environment.start()
        self.addCleanup(environment.stop)
        tempfile.tempdir = None  # gettempdir() reads TMPDIR again.
        self.addCleanup(setattr, tempfile, "tempdir", None)
        previous = os.getcwd()
        os.chdir(self.cwd)
        self.addCleanup(os.chdir, previous)

    def run_main(self, *argv) -> tuple[int, str]:
        output = io.StringIO()
        with redirect_stdout(output), self.assertRaises(SystemExit) as exit:
            main(list(argv))
        return exit.exception.code, output.getvalue()


class SummaryTests(Isolated):
    def test_a_unittest_log_gives_counts_each_failing_test_and_its_exception_line(self):
        code, out = self.run_main("--", *emit(UNITTEST_LOG, 1))
        self.assertEqual(code, 1)
        self.assertIn("exit 1", out)
        self.assertIn("counts: 3 passed, 2 failed, 0 skipped", out)
        self.assertIn("ERROR: test_load (pkg.test_store.StoreTests.test_load)", out)
        self.assertIn("KeyError: 'missing'", out)
        self.assertIn("FAIL: test_add (pkg.test_math.MathTests.test_add)", out)
        self.assertIn("AssertionError: 3 != 4", out)
        self.assertNotIn("self.assertEqual(add(1, 2), 4)", out)  # Source lines of the traceback stay in the log.

    def test_a_vitest_log_gives_counts_the_failing_test_and_its_first_error(self):
        code, out = self.run_main("--", *emit(VITEST_LOG, 1))
        self.assertEqual(code, 1)
        self.assertIn("counts: 69 passed, 2 failed, 0 skipped", out)  # text_test_counts: the failed test file counts too.
        self.assertIn("FAIL  src/math.test.ts > math > adds", out)
        self.assertIn("AssertionError: expected 3 to be 4", out)
        self.assertNotIn("\x1b[", out)

    def test_a_tap_log_gives_counts_and_each_not_ok_line_with_its_error(self):
        code, out = self.run_main("--", *emit(TAP_LOG, 1))
        self.assertEqual(code, 1)
        self.assertIn("counts: 1 passed, 1 failed, 0 skipped", out)
        self.assertIn("not ok 2 - rejects bad input", out)
        self.assertIn("error: 'Expected values to be strictly equal:", out)
        self.assertNotIn("ok 1 - parses", out.split("failing (1):", 1)[1])

    def test_a_log_without_a_summary_says_so_and_shows_its_last_lines_on_failure(self):
        code, out = self.run_main("--", *emit("compiling\nsrc/x.ts(3,1): error TS2304: Cannot find name 'y'.\n", 2))
        self.assertEqual(code, 2)
        self.assertIn("no summary parsed", out)
        self.assertIn("error TS2304", out)

    def test_the_exit_code_is_the_commands_and_the_full_log_holds_everything(self):
        for code in (0, 3, 1):
            got, out = self.run_main("--", *emit("Ran 1 test in 0.001s\n\nOK\n", code))
            self.assertEqual(got, code)
            self.assertIn(f"exit {code}", out)
        log = Path(out.rsplit("full log: ", 1)[1].split(" (", 1)[0])
        self.assertEqual(log.read_text(), "Ran 1 test in 0.001s\n\nOK\n")
        self.assertIn(f"({log.stat().st_size} bytes)", out)
        missing, out = self.run_main("--", str(self.tmp / "no-such-command"))
        self.assertEqual(missing, 127)
        self.assertIn("cannot run", out)

    def test_the_command_runs_without_a_shell_in_the_cwd_with_colour_off(self):
        probe = "import json, os; print(json.dumps([os.getcwd(), os.environ.get('NO_COLOR'), os.environ.get('FORCE_COLOR'), os.environ.get('CI')]))"
        log = self.tmp / "probe.log"
        code, _ = self.run_main("--log", str(log), "--", sys.executable, "-c", probe, "$HOME")
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(log.read_text()), [str(self.cwd.resolve()), "1", "0", "1"])

    def test_the_default_log_lies_under_the_temporary_directory_never_inside_the_cwd(self):
        code, out = self.run_main("--", *emit("hello\n"))
        log = Path(out.rsplit("full log: ", 1)[1].split(" (", 1)[0])
        self.assertTrue(log.is_file())
        self.assertTrue(log.resolve().is_relative_to(self.scratch.resolve()))
        self.assertFalse(log.resolve().is_relative_to(self.cwd.resolve()))
        self.assertEqual(list(self.cwd.iterdir()), [])
        self.assertEqual(default_log(self.cwd).parent, log.parent)  # Named for a hash of the cwd.
        other = self.tmp / "other"
        other.mkdir()
        self.assertNotEqual(default_log(other).parent, log.parent)
        # A cwd that lies under the temporary directory still gets a log outside itself.
        inner = self.scratch / "inner"
        inner.mkdir()
        self.assertFalse(default_log(inner).resolve().is_relative_to(inner.resolve()))

    def test_an_empty_command_or_a_missing_separator_is_refused(self):
        for argv in ([], ["--"], ["--log", "x"], [sys.executable]):
            with self.subTest(argv=argv), redirect_stdout(io.StringIO()), mock.patch("sys.stderr", io.StringIO()), self.assertRaises(SystemExit) as exit:
                main(argv)
            self.assertEqual(exit.exception.code, 2)

    def test_the_summary_keeps_to_its_line_and_byte_caps_and_always_ends_with_the_log(self):
        many = "".join(f"======\nFAIL: test_{n} (m.T.test_{n})\n------\nTraceback (most recent call last):\n  File \"x\"\n"
                       f"AssertionError: {'x' * 400}\n\n" for n in range(200)) + "------\nRan 200 tests in 1s\n\nFAILED (failures=200)\n"
        code, out = self.run_main("--", *emit(many, 1))
        lines = out.rstrip("\n").split("\n")
        self.assertLessEqual(len(lines), 60)
        self.assertLessEqual(len(out.encode()), 6 * 1024)
        self.assertTrue(lines[-1].startswith("full log: "))
        self.assertTrue(any("more" in line for line in lines))
        self.assertTrue(all(len(line) <= 240 for line in lines[:-1]))
        code, out = self.run_main("--max-lines", "12", "--", *emit(many, 1))
        lines = out.rstrip("\n").split("\n")
        self.assertEqual(len(lines), 12)
        self.assertTrue(lines[-1].startswith("full log: "))

    def test_failures_are_read_from_each_format(self):
        self.assertEqual([name for name, _ in failures(UNITTEST_LOG)],
                         ["ERROR: test_load (pkg.test_store.StoreTests.test_load)", "FAIL: test_add (pkg.test_math.MathTests.test_add)"])
        self.assertEqual(failures(TAP_LOG)[0][0], "not ok 2 - rejects bad input")
        self.assertEqual(failures("all good\n"), [])

    def test_summary_is_deterministic(self):
        log = self.tmp / "same.log"
        log.write_text(UNITTEST_LOG)
        args = (["python", "-m", "unittest"], 1, 1.5, log, 60, 6 * 1024)
        self.assertEqual(summary(*args), summary(*args))


class HaikuTests(Isolated):
    def setUp(self):
        super().setUp()
        self.control = self.tmp / "control.json"
        self.seen = self.tmp / "seen.json"
        self.fake = self.tmp / "fake-claude"
        self.fake.write_text(FAKE_CLAUDE % {"control": str(self.control), "seen": str(self.seen)})
        self.fake.chmod(0o755)
        os.environ["WORKFLOW_CLAUDE"] = str(self.fake)

    def test_off_by_default(self):
        self.control.write_text(json.dumps({"lines": ["never"]}))
        code, out = self.run_main("--", *emit(UNITTEST_LOG, 1))
        self.assertNotIn("summary (haiku)", out)
        self.assertFalse(self.seen.exists())

    def test_a_successful_job_appends_its_lines_after_the_deterministic_summary(self):
        self.control.write_text(json.dumps({"lines": [f"line {n}" for n in range(14)]}))
        with mock.patch.dict(os.environ, {"CLAUDECODE": "1"}):
            code, out = self.run_main("--summarise", "haiku", "--", *emit(UNITTEST_LOG, 1))
        self.assertEqual(code, 1)
        self.assertLess(out.index("full log: "), out.index("summary (haiku):"))
        self.assertIn("line 0", out)
        self.assertIn("line 9", out)
        self.assertNotIn("line 10", out)  # At most ten lines.
        seen = json.loads(self.seen.read_text())
        argv = seen["argv"]
        self.assertEqual(argv[:2], ["--print", "--output-format"])
        self.assertEqual(argv[argv.index("--model") + 1], "claude-haiku-4-5-20251001")
        self.assertIn("--max-budget-usd", argv)
        self.assertIn("--json-schema", argv)
        self.assertIn("AssertionError: 3 != 4", seen["prompt"])
        self.assertNotIn("CLAUDECODE", seen["env"])  # sessions.scrub_env.
        self.assertEqual(seen["cwd"], str(self.cwd.resolve()))

    def test_only_the_last_lines_of_a_long_log_reach_the_job(self):
        self.control.write_text(json.dumps({"lines": ["ok"]}))
        text = "".join(f"noise {n}\n" for n in range(1000)) + UNITTEST_LOG
        self.run_main("--summarise", "haiku", "--", *emit(text, 1))
        prompt = json.loads(self.seen.read_text())["prompt"]
        self.assertNotIn("noise 700\n", prompt)
        self.assertIn("noise 999", prompt)

    def test_a_failing_job_prints_one_line_and_keeps_the_exit_code(self):
        for spec in ({"exit": 1}, {"is_error": True, "lines": ["x"]}):
            self.control.write_text(json.dumps(spec))
            code, out = self.run_main("--summarise", "haiku", "--", *emit(UNITTEST_LOG, 1))
            self.assertEqual(code, 1)
            self.assertIn("AssertionError: 3 != 4", out)
            tail = out.split("summary (haiku):", 1)[1].strip().splitlines()
            self.assertEqual(len(tail), 1)
            self.assertIn("unavailable", tail[0])

    def test_a_slow_job_is_stopped_and_reported(self):
        self.control.write_text(json.dumps({"delay": 30, "lines": ["late"]}))
        with mock.patch.object(run_report, "HAIKU_TIMEOUT", 1):
            code, out = self.run_main("--summarise", "haiku", "--", *emit("Ran 1 test in 0.001s\n\nOK\n", 0))
        self.assertEqual(code, 0)
        self.assertIn("unavailable", out)
        self.assertIn("1 s", out)
        self.assertNotIn("late", out)

    def test_a_missing_executable_is_reported(self):
        os.environ["WORKFLOW_CLAUDE"] = str(self.tmp / "no-claude")
        code, out = self.run_main("--summarise", "haiku", "--", *emit(UNITTEST_LOG, 1))
        self.assertEqual(code, 1)
        self.assertIn("summary (haiku): unavailable", out)


if __name__ == "__main__":
    unittest.main()
