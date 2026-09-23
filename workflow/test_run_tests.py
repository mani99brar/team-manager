import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from .checks import text_test_counts
from .run_tests import counts


class RunTestsSummaryTests(unittest.TestCase):
    def test_child_summaries_are_counted_and_a_missing_summary_is_an_error(self):
        self.assertEqual(counts("...\nRan 3 tests in 0.1s\n\nOK (skipped=1)\n"), {"tests": 3, "failures": 0, "errors": 0, "skipped": 1})
        self.assertEqual(counts("Ran 4 tests in 1s\n\nFAILED (failures=1, errors=2)\n"), {"tests": 4, "failures": 1, "errors": 2, "skipped": 0})
        self.assertEqual(counts("Traceback: ImportError"), {"tests": 0, "failures": 0, "errors": 1, "skipped": 0})

    def test_parallel_summary_parses_like_a_plain_run_and_fails_when_a_class_fails(self):
        with tempfile.TemporaryDirectory() as root:
            package = Path(root) / "pkg"
            package.mkdir()
            (package / "__init__.py").write_text("")
            (package / "test_sample.py").write_text(
                "import unittest\n"
                "class A(unittest.TestCase):\n    def test_one(self): pass\n    def test_two(self): pass\n"
                "class B(unittest.TestCase):\n    def test_fails(self): self.fail('Ran 99 tests in 0s')\n"
                "    @unittest.skip('x')\n    def test_skipped(self): pass\n")
            result = subprocess.run([sys.executable, "-m", "workflow.run_tests", "--jobs", "2", "pkg"], cwd=root, capture_output=True, text=True,
                                    env={"PYTHONPATH": str(Path(__file__).resolve().parents[1]), "PATH": ""})
            self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
            # Child output is indented, so a child's own "Ran" line cannot be taken for the summary.
            self.assertEqual(text_test_counts(result.stdout), {"passed": 2, "failed": 1, "skipped": 1})
            self.assertIn("FAILED (failures=1, skipped=1)", result.stdout)
            (package / "test_sample.py").write_text("import unittest\nclass A(unittest.TestCase):\n    def test_one(self): pass\n")
            result = subprocess.run([sys.executable, "-m", "workflow.run_tests", "pkg"], cwd=root, capture_output=True, text=True,
                                    env={"PYTHONPATH": str(Path(__file__).resolve().parents[1]), "PATH": ""})
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertEqual(text_test_counts(result.stdout), {"passed": 1, "failed": 0, "skipped": 0})


class RunTestsEchoTests(unittest.TestCase):
    def test_failed_classes_echo_their_whole_traceback_in_order_and_the_counts_still_parse(self):
        with tempfile.TemporaryDirectory() as root:
            package = Path(root) / "pkg"
            package.mkdir()
            (package / "__init__.py").write_text("")
            (package / "test_sample.py").write_text(
                "import subprocess, sys, unittest\n"
                "class Fails(unittest.TestCase):\n"
                "    def test_fails(self):\n"
                "        print('first, on stdout'); sys.stderr.write('second, on stderr\\n'); print('third, on stdout')\n"
                "        self.assertEqual(1, 2, 'the final failure line')\n"
                "    def test_passes(self): pass\n"
                "class Errors(unittest.TestCase):\n"
                "    def test_command(self):\n"
                "        subprocess.run([sys.executable, '-c', 'import sys; sys.stderr.write(\"fatal: the cause, on stderr\\\\n\"); sys.exit(128)'],\n"
                "                       check=True, capture_output=True)\n"
                "    def test_stray_bytes(self):\n"
                "        sys.stdout.buffer.write(b'\\xff not utf-8\\n'); sys.stdout.flush()\n"
                "        raise ValueError('the final error line, errors=7')\n")
            result = subprocess.run([sys.executable, "-m", "workflow.run_tests", "--jobs", "2", "pkg"], cwd=root, capture_output=True, text=True,
                                    env={"PYTHONPATH": str(Path(__file__).resolve().parents[1]), "PATH": ""})
            self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
            output = result.stdout
            # Every traceback reaches the log with its exception line; a failed command's stderr is noted under it.
            self.assertEqual(output.count("    Traceback (most recent call last):"), 3, output)
            self.assertIn("    AssertionError: 1 != 2 : the final failure line\n", output)
            self.assertRegex(output, r"\n    subprocess\.CalledProcessError: Command .* returned non-zero exit status 128\.\n(    .*\n)*?    fatal: the cause, on stderr\n")
            # Undecodable output neither stops the run nor hides the exception; child counts are respelled only.
            self.assertIn("\ufffd not utf-8\n", output)
            self.assertIn("    ValueError: the final error line, errors: 7\n", output)
            # stdout and stderr keep the order they were written in.
            self.assertIn("    first, on stdout\n    second, on stderr\n    third, on stdout\n", output)
            self.assertEqual(text_test_counts(output), {"passed": 1, "failed": 3, "skipped": 0})
            self.assertTrue(output.endswith("FAILED (failures=1, errors=2)\n"), output)

    def test_only_the_child_summary_line_counts(self):
        # A traceback or a noted command output quoting a summary is not the child's own result.
        output = ("E\nValueError: FAILED (errors=7)\nstderr of the failed command:\nRan 9 tests in 1s\n\nFAILED (failures=5)\n"
                  "----\nRan 2 tests in 0.1s\n\nFAILED (errors=1, skipped=1)\nsys:1: ResourceWarning: unclosed file\n")
        self.assertEqual(counts(output), {"tests": 2, "failures": 0, "errors": 1, "skipped": 1})
