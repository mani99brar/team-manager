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
