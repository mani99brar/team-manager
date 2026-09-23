"""The verifier's browser scenario rules, told to the lanes: `check-report`, the worker-phase gate and the task texts."""
import io
import json
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

from .checks import Capture, browser_evidence, check_report_main, verify_revision
from .guardrails import brief_problems, pinned_task
from .scaffold import feature_files
from .sessions import git, save_json

TOOL = Path(__file__).resolve().parents[1]
PNG = b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15\xc4\x89"


def browser_policy(argv: list[str], scenarios=("alpha", "beta")) -> dict:
    """Lane `ui` with one browser check, lane `api` with only a unit check."""
    return {"version": "1.2.0", "feature": "Browser rules", "independent_review": True, "integration_approval": True,
            "workers": [{"node_id": "ui", "role": "frontend", "required_check_kinds": ["browser"], "owned_paths": ["src"],
                         "checks": [{"id": "ui-browser", "kind": "browser", "argv": argv, "timeout_seconds": 60,
                                     "scenarios": [{"id": item, "description": f"{item} works"} for item in scenarios]}]},
                        {"node_id": "api", "role": "backend", "required_check_kinds": ["unit"], "owned_paths": ["server"],
                         "checks": [{"id": "api-unit", "kind": "unit", "argv": ["python", "-m", "unittest"], "timeout_seconds": 60, "scenarios": []}]}]}


class CheckReport(unittest.TestCase):
    """`python -m workflow check-report` on synthetic Playwright JSON reports."""

    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.policy = self.root / "policy.json"
        save_json(self.policy, browser_policy(["npx", "--no-install", "playwright", "test"]))
        self.files = 0

    def attachment(self, name: str, content_type="image/png", write=True) -> dict:
        self.files += 1
        path = self.root / f"attachment-{self.files}.png"
        if write:
            path.write_bytes(PNG)
        return {"name": name, "contentType": content_type, "path": str(path)}

    def spec(self, scenario: str, attachments=None, status="passed") -> dict:
        """One test titled `[scenario:<id>]` with one result; by default it attaches `screenshot:<id>`."""
        if attachments is None:
            attachments = [self.attachment(f"screenshot:{scenario}")]
        passed = status == "passed"
        return {"title": f"[scenario:{scenario}] {scenario} works", "tests": [
            {"status": "expected" if passed else "unexpected", "expectedStatus": "passed", "results": [{"status": status, "attachments": attachments}]}]}

    def report(self, *specs, errors=()) -> Path:
        path = self.root / "report.json"
        save_json(path, {"errors": list(errors), "suites": [{"title": "rules.spec.ts", "specs": list(specs), "suites": []}]})
        return path

    def check(self, *args) -> tuple[int, str]:
        output = io.StringIO()
        with redirect_stdout(output), redirect_stderr(output):
            try:
                check_report_main([str(arg) for arg in args])
                code = 0
            except SystemExit as exit:
                code = exit.code
        return code, output.getvalue()

    def test_valid_report_passes_and_other_attachments_are_fine(self):
        trace = self.attachment("trace", "application/zip")
        report = self.report(self.spec("alpha", [self.attachment("screenshot:alpha"), trace]), self.spec("beta"))
        code, output = self.check(self.policy, "ui", report)
        self.assertEqual(code, 0, output)
        self.assertIn("ui-browser/alpha: ok\n", output)
        self.assertIn("ui-browser/beta: ok\n", output)
        self.assertIn("ui-browser: 2 passed, 0 failed, 0 skipped\n", output)

    def test_two_screenshots_with_other_names_fail_with_the_verifiers_words(self):
        """workflow-guardrails-001: the inert-markdown test attached a file and a decisions screenshot, not `screenshot:inert-markdown`."""
        report = self.report(self.spec("alpha", [self.attachment("screenshot:alpha-file"), self.attachment("screenshot:alpha-decisions")]),
                             self.spec("beta"))
        code, output = self.check(self.policy, "ui", report)
        self.assertEqual(code, 1, output)
        self.assertIn("ui-browser/alpha: Expected one screenshot attachment for alpha\n", output)
        self.assertIn("ui-browser/beta: ok\n", output)
        # The verifier raises the same words for the same report.
        requirement = browser_policy([])["workers"][0]["checks"][0]
        (self.root / "captured").mkdir()
        with self.assertRaisesRegex(ValueError, "^Expected one screenshot attachment for alpha$"):
            browser_evidence(report, self.root, requirement, Capture(self.root / "captured"))

    def test_missing_screenshot(self):
        report = self.report(self.spec("alpha", []), self.spec("beta", [self.attachment("screenshot:beta", write=False)]))
        code, output = self.check(self.policy, "ui", report)
        self.assertEqual(code, 1, output)
        self.assertIn("ui-browser/alpha: Expected one screenshot attachment for alpha\n", output)
        self.assertRegex(output, r"ui-browser/beta: \[Errno 2\] No such file or directory: '.*attachment-1\.png'\n")
        # Named right but not a PNG: the verifier's name and content type rule.
        code, output = self.check(self.policy, "ui", self.report(self.spec("alpha", [self.attachment("screenshot:alpha", "image/jpeg")]), self.spec("beta")))
        self.assertEqual(code, 1, output)
        self.assertIn("ui-browser/alpha: Expected one screenshot attachment for alpha\n", output)

    def test_duplicated_scenario_title(self):
        code, output = self.check(self.policy, "ui", self.report(self.spec("alpha"), self.spec("alpha"), self.spec("beta")))
        self.assertEqual(code, 1, output)
        self.assertIn("ui-browser/alpha: Duplicate browser scenario/project result: alpha\n", output)
        self.assertIn("ui-browser/beta: ok\n", output)

    def test_failing_test_and_global_errors(self):
        code, output = self.check(self.policy, "ui", self.report(self.spec("alpha", [], status="failed"), self.spec("beta")))
        self.assertEqual(code, 1, output)
        self.assertIn("ui-browser/alpha: browser scenario did not pass\n", output)
        self.assertIn("ui-browser: 1 passed, 1 failed, 0 skipped\n", output)
        self.assertIn("ui-browser: no passing test evidence or failed tests\n", output)
        code, output = self.check(self.policy, "ui", self.report(self.spec("alpha"), self.spec("beta"), errors=[{"message": "SyntaxError"}]))
        self.assertEqual(code, 1, output)
        self.assertIn("ui-browser: Playwright reported global errors\n", output)

    def test_partial_report_fails_only_with_all(self):
        report = self.report(self.spec("alpha"))
        code, output = self.check(self.policy, "ui", report)
        self.assertEqual(code, 0, output)
        self.assertIn("ui-browser/alpha: ok\n", output)
        self.assertIn("ui-browser/beta: not in this report\n", output)
        code, output = self.check(self.policy, "ui", report, "--all")
        self.assertEqual(code, 1, output)
        self.assertIn("ui-browser/beta: not in this report\n", output)

    def test_lane_without_browser_checks_and_unknown_lane(self):
        report = self.report(self.spec("alpha"), self.spec("beta"))
        code, output = self.check(self.policy, "api", report)
        self.assertEqual(code, 1, output)
        self.assertIn("Lane api has no browser check, so it has no scenarios to check", output)
        code, output = self.check(self.policy, "web", report)
        self.assertEqual(code, 1, output)
        self.assertIn("web is not a lane of this policy (ui, api)", output)

    def test_feature_directory_through_python_m_workflow(self):
        folder = self.root / "features/rules"
        folder.mkdir(parents=True)
        self.policy.rename(folder / "lanes.json")
        save_json(folder / "feature.json", {"version": "2.0.0", "name": "Rules", "branch_prefix": "feature/rules", "policy": "lanes.json",
                                            "workers": [{"node_id": "ui", "task": "ui-task.md"}, {"node_id": "api", "task": "api-task.md"}]})
        report = self.report(self.spec("alpha", [self.attachment("screenshot:alpha-file")]), self.spec("beta"))
        result = subprocess.run([sys.executable, "-m", "workflow", "check-report", str(folder), "ui", str(report)],
                                cwd=TOOL, capture_output=True, text=True, timeout=120)
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIn("ui-browser/alpha: Expected one screenshot attachment for alpha\n", result.stdout)


# A stand-in for `playwright test`: reads the runner's --output flag and PLAYWRIGHT_JSON_OUTPUT_FILE like Playwright,
# and writes one `[scenario:alpha]` test whose outcome and attachments depend on the mode in argv[1].
FAKE_PLAYWRIGHT = """
import json, os, pathlib, sys
mode = sys.argv[1]
if mode == "no-report":
    sys.exit(1)
output = pathlib.Path(next(arg[len("--output="):] for arg in sys.argv if arg.startswith("--output=")))
output.mkdir(parents=True, exist_ok=True)
names = {"ok": ["screenshot:alpha"], "failing": [], "misnamed": ["screenshot:alpha-file", "screenshot:alpha-decisions"],
         "misnamed-and-global-errors": ["screenshot:alpha-file", "screenshot:alpha-decisions"]}[mode]
attachments = []
for index, name in enumerate(names):
    path = output / f"{index}.png"
    path.write_bytes(bytes.fromhex(PNG_HEX))
    attachments.append({"name": name, "contentType": "image/png", "path": str(path)})
passed = mode != "failing"
test = {"status": "expected" if passed else "unexpected", "expectedStatus": "passed",
        "results": [{"status": "passed" if passed else "failed", "attachments": attachments}]}
errors = [{"message": "a spec file failed to load"}] if mode == "misnamed-and-global-errors" else []
report = {"errors": errors, "suites": [{"title": "alpha.spec.ts", "specs": [{"title": "[scenario:alpha] alpha works", "tests": [test]}]}]}
pathlib.Path(os.environ["PLAYWRIGHT_JSON_OUTPUT_FILE"]).write_text(json.dumps(report))
sys.exit(0 if passed and not errors else 1)
""".replace("PNG_HEX", repr(PNG.hex()))


class WorkerPhaseScenarioEvidence(unittest.TestCase):
    """A passed scenario test's evidence is the lane's own work and gates in the worker phase; the rest stays deferred."""

    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        root = Path(temp.name)
        self.repo = root / "repo"
        (self.repo / "src").mkdir(parents=True)
        (self.repo / "src/app.txt").write_text("before\n")
        for args in (["init", "-q"], ["config", "user.name", "Test"], ["config", "user.email", "test@example.invalid"], ["add", "."], ["commit", "-qm", "Base"]):
            subprocess.run(["git", "-C", str(self.repo), *args], check=True)
        self.plan = {"repository": str(self.repo), "run_id": "run", "base_commit": git(self.repo, "rev-parse", "HEAD")}
        (self.repo / "src/app.txt").write_text("after\n")
        for args in (["add", "."], ["commit", "-qm", "Snapshot"]):
            subprocess.run(["git", "-C", str(self.repo), *args], check=True)
        self.commit = git(self.repo, "rev-parse", "HEAD")
        self.run_dir = root / "run"
        self.run_dir.mkdir()
        self.attempts = 0

    def verify(self, mode: str, phase: str) -> dict:
        self.attempts += 1
        policy = browser_policy([sys.executable, "-c", FAKE_PLAYWRIGHT, mode], scenarios=("alpha",))
        return verify_revision(self.run_dir, self.plan, policy, "ui", self.commit, ["src/app.txt"], "session", phase=phase, attempt=self.attempts)

    def test_passed_test_with_two_misnamed_screenshots_blocks_the_worker_phase(self):
        packet = self.verify("ok", "worker")
        self.assertEqual(packet["gate"]["status"], "passed", packet["gate"]["reasons"])
        for mode in ("misnamed", "misnamed-and-global-errors"):
            packet = self.verify(mode, "worker")
            self.assertEqual(packet["gate"]["status"], "blocked", mode)
            self.assertEqual(packet["gate"]["reasons"], ["ui-browser: Expected one screenshot attachment for alpha"], mode)
            self.assertEqual(packet["gate"]["deferred_checks"], ["ui-browser"])
        # The first problem is still the one recorded; a global error on its own stays deferred.
        self.assertEqual(packet["capture_errors"], ["ui-browser: Playwright reported global errors"])
        # The candidate phase reports exactly what it did before.
        packet = self.verify("misnamed", "candidate")
        self.assertEqual(packet["gate"]["reasons"], ["ui-browser: no passing test evidence or failed tests", "ui-browser: missing/unknown browser scenarios",
                                                     "ui-browser: Expected one screenshot attachment for alpha"])

    def test_suite_that_did_not_start_and_failing_test_stay_deferred(self):
        packet = self.verify("no-report", "worker")
        self.assertEqual((packet["gate"]["status"], packet["gate"]["deferred_checks"]), ("passed", ["ui-browser"]), packet["gate"]["reasons"])
        self.assertEqual(packet["capture_errors"], ["ui-browser: no Playwright report written (exit 1); the suite did not start"])
        packet = self.verify("failing", "worker")
        self.assertEqual(packet["gate"]["status"], "passed", packet["gate"]["reasons"])
        self.assertEqual(packet["capture_errors"], ["ui-browser: exit 1"])
        packet = self.verify("failing", "candidate")
        self.assertEqual(packet["gate"]["status"], "blocked")
        self.assertIn("ui-browser/alpha: browser scenario did not pass", packet["gate"]["reasons"])


class BrowserRulesInTasks(unittest.TestCase):
    """The lanes read the rules and the check-report command where they read their task."""

    def test_pinned_task_of_a_browser_lane_points_at_check_report(self):
        policy = browser_policy(["npx", "--no-install", "playwright", "test"])
        ui, api = policy["workers"]
        task = pinned_task("## Goal\n\nBuild it.\n", ui)
        self.assertIn("Approved ownership and checks:\n" + json.dumps(ui), task)
        for text in ("`[scenario:<id>]`", "`screenshot:<id>`", "PLAYWRIGHT_JSON_OUTPUT_FILE=", "python -m workflow check-report ", " ui <tmp>/report.json"):
            self.assertIn(text, task)
        self.assertEqual(pinned_task("## Goal\n\nBuild it.\n", api), "## Goal\n\nBuild it.\n\nApproved ownership and checks:\n" + json.dumps(api))

    def test_init_task_template_states_the_rules_with_the_exact_commands(self):
        task = feature_files("skeleton")["main-task.md"]
        self.assertEqual(brief_problems(task), [])
        for text in ("`[scenario:<id>]`", "`screenshot:<id>`", "WORKFLOW_VERIFICATION_PHASE=", "--reporter=json",
                     "python -m workflow check-report features/skeleton main <tmp>/report.json"):
            self.assertIn(text, task)
        self.assertFalse([line for line in task.splitlines() if "check-report" in line and line.strip().startswith("TODO:")])


if __name__ == "__main__":
    unittest.main()
