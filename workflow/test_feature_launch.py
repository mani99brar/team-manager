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
