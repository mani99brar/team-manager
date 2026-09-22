import contextlib
import io
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from .export_state import export_state
from .launch import launch_commands, main
from .sessions import save_json

REPO = Path(__file__).resolve().parents[1]


class FeatureLaunchTests(unittest.TestCase):
    def test_committed_feature_plans_preflight_branch_prepare_and_start(self):
        run, commands = launch_commands(REPO, "project-workflows", "project-workflows-001", Path("/tmp/workflow-launch-tests"))
        self.assertEqual(run.name, "project-workflows-001")
        self.assertEqual(commands[0][3], "preflight")
        self.assertEqual(commands[1], ["git", "switch", "-c", "feature/project-workflows/project-workflows-001"])
        self.assertEqual(commands[2][3], "prepare")
        self.assertEqual(commands[3][3], "start")
        self.assertIn("--live", commands[3])
        self.assertIn("--herdr", commands[3])

    def test_automatic_plan_keeps_launches_in_graph_and_adds_supervision(self):
        _, commands = launch_commands(REPO, "project-workflows", "auto-test", Path("/tmp/workflow-launch-tests"), automatic=True)
        self.assertIn("--automatic", commands[2])
        self.assertEqual(commands[-1][3], "automatic")
        self.assertIn("--live", commands[-1])
        self.assertFalse(any("push" in command for command in commands))
        self.assertFalse(any(command[0] == "claude" for command in commands))

    def test_automatic_deadlines_are_pinned_into_prepare(self):
        _, commands = launch_commands(REPO, "project-workflows", "auto-test", Path("/tmp/workflow-launch-tests"), automatic=True)
        prepare = commands[2]
        self.assertEqual(prepare[prepare.index("--worker-timeout-seconds") + 1], str(4 * 3600))
        self.assertEqual(prepare[prepare.index("--review-timeout-seconds") + 1], "1800")
        _, commands = launch_commands(REPO, "project-workflows", "auto-test", Path("/tmp/workflow-launch-tests"), automatic=True,
                                      worker_timeout_seconds=7200, review_timeout_seconds=600)
        prepare = commands[2]
        self.assertEqual(prepare[prepare.index("--worker-timeout-seconds") + 1], "7200")
        self.assertEqual(prepare[prepare.index("--review-timeout-seconds") + 1], "600")
        with self.assertRaisesRegex(ValueError, "bounded"):
            launch_commands(REPO, "project-workflows", "auto-test", Path("/tmp/workflow-launch-tests"), automatic=True, worker_timeout_seconds=0)
        with self.assertRaisesRegex(ValueError, "automatic runs only"):
            launch_commands(REPO, "project-workflows", "auto-test", Path("/tmp/workflow-launch-tests"), worker_timeout_seconds=7200)

    def test_review_visibility_features_are_launchable_with_the_native_reviewer_by_default(self):
        for feature in ("review-result", "run-inputs"):
            run, commands = launch_commands(REPO, feature, f"{feature}-001", Path("/tmp/workflow-launch-tests"), automatic=True)
            self.assertEqual(run.name, f"{feature}-001")
            self.assertEqual(commands[1], ["git", "switch", "-c", f"feature/{feature}/{feature}-001"])
            prepare = commands[2]
            self.assertEqual(prepare[prepare.index("--feature") + 1], feature)
            self.assertEqual(prepare[prepare.index("--reviewer-transport") + 1], "native")
        _, commands = launch_commands(REPO, "review-result", "x", Path("/tmp/workflow-launch-tests"), automatic=True, reviewer_transport="print")
        self.assertEqual(commands[2][commands[2].index("--reviewer-transport") + 1], "print")
        with self.assertRaises(ValueError):
            launch_commands(REPO, "review-result", "x", Path("/tmp/workflow-launch-tests"), automatic=True, reviewer_transport="pi")
        with self.assertRaisesRegex(ValueError, "automatic runs only"):
            launch_commands(REPO, "review-result", "x", Path("/tmp/workflow-launch-tests"), reviewer_transport="native")

    def test_run_defaults_follow_the_feature(self):
        with patch("workflow.launch.subprocess.run") as command, contextlib.redirect_stdout(io.StringIO()) as output:
            main(["run-inputs", "--dry-run"])
        command.assert_not_called()
        printed = output.getvalue()
        self.assertIn("md-manager-workflows/run-inputs/run-inputs-001", printed)

    def test_dry_run_does_not_execute_anything(self):
        with patch("workflow.launch.subprocess.run") as command, contextlib.redirect_stdout(io.StringIO()):
            main(["project-workflows", "--dry-run"])
        command.assert_not_called()

    def test_missing_live_consent_never_runs_commands(self):
        with patch("workflow.launch.subprocess.run") as command, contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit):
                main(["project-workflows"])
        command.assert_not_called()

    def test_duplicate_run_is_not_relaunched(self):
        with tempfile.TemporaryDirectory() as root:
            (Path(root) / "project-workflows-001").mkdir()
            with patch("workflow.launch.subprocess.run") as command, contextlib.redirect_stderr(io.StringIO()):
                with self.assertRaises(SystemExit):
                    main(["project-workflows", "--live", "--run-root", root])
            command.assert_not_called()

    def test_run_id_cannot_escape_storage(self):
        for run_id in ("../other", "/tmp/other", "bad/id"):
            with self.assertRaises(ValueError):
                launch_commands(REPO, "project-workflows", run_id, Path("/tmp/workflow-launch-tests"))

    def test_export_is_stable_until_state_changes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            plan = {"run_id": "demo", "base_commit": "a" * 40, "created_at": "2026-01-01T00:00:00Z"}
            save_json(root / "plan.json", plan)
            runtime = SimpleNamespace(directory=root, plan=plan)
            state = SimpleNamespace(values={}, next=("launch_ui", "launch_adapter"), tasks=[])
            first = export_state(runtime, state)
            contents = (root / "run-state.json").read_bytes()
            self.assertEqual(export_state(runtime, state), first)
            self.assertEqual((root / "run-state.json").read_bytes(), contents)
            state.values = {"ui": {"session_id": "observed"}}
            second = export_state(runtime, state)
            self.assertEqual(second["created_at"], first["created_at"])
            self.assertNotEqual(second["values"], first["values"])
            self.assertEqual(len(second["definition"]["nodes"]), 9)


if __name__ == "__main__":
    unittest.main()
