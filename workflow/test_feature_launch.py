import contextlib
import io
import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from .export_state import export_state
from .launch import launch_commands, main
from .sessions import save_json

TESTDATA = Path(__file__).resolve().parent / "testdata"


def fixture_target(root: Path) -> Path:
    """A committed Git repository holding a copy of the finished project-workflows feature."""
    repo = root / "target"
    shutil.copytree(TESTDATA / "project-workflows", repo / "features/project-workflows")
    for args in (["init", "-q"], ["config", "user.name", "Test"], ["config", "user.email", "test@example.invalid"], ["add", "."], ["commit", "-qm", "Feature"]):
        subprocess.run(["git", "-C", str(repo), *args], check=True)
    return repo


class FeatureLaunchTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.repo = fixture_target(self.root)
        # A live launch registers the run: never in the operator's real registry.
        environment = patch.dict(os.environ, {"MD_MANAGER_PROJECTS_CONFIG": str(self.root / "projects.json"), "HOME": str(self.root / "home")})
        environment.start()
        self.addCleanup(environment.stop)

    def test_committed_feature_plans_preflight_branch_prepare_and_start(self):
        run, commands, _ = launch_commands(self.repo, "project-workflows", "project-workflows-001", Path("/tmp/workflow-launch-tests"))
        self.assertEqual(run.name, "project-workflows-001")
        self.assertEqual(commands[0][3], "preflight")
        self.assertEqual(commands[1], ["git", "switch", "-c", "feature/project-workflows/project-workflows-001"])
        self.assertEqual(commands[2][3], "prepare")
        self.assertNotIn("--workers", commands[2])  # Every declared lane: the selection is not spelled out.
        tasks = [commands[2][index + 1] for index, item in enumerate(commands[2]) if item == "--task"]
        self.assertEqual([task.split("=", 1)[0] for task in tasks], ["ui", "adapter"])
        self.assertTrue(all(Path(task.split("=", 1)[1]).is_file() for task in tasks))
        self.assertEqual(commands[3][3], "start")
        self.assertIn("--live", commands[3])
        self.assertIn("--herdr", commands[3])

    def test_launch_passes_its_by_to_start_and_automatic_and_refuses_the_maintainer(self):
        """C17: the steps a launch runs carry its --by; a launch is the operator's decision."""
        _, commands, _ = launch_commands(self.repo, "project-workflows", "by-test", Path("/tmp/workflow-launch-tests"), automatic=True, by="operator")
        self.assertEqual([command[3:] for command in commands if command[3:4] in (["start"], ["automatic"])],
                         [["start", "/tmp/workflow-launch-tests/by-test", "--live", "--by", "operator", "--herdr"],
                          ["automatic", "/tmp/workflow-launch-tests/by-test", "--live", "--by", "operator"]])
        calls = []
        with tempfile.TemporaryDirectory() as root, patch("workflow.launch.subprocess.run", side_effect=lambda command, cwd, check: calls.append(command)), \
                contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            main(["project-workflows", "--repo", str(self.repo), "--live", "--by", "operator", "--automatic", "--no-herdr", "--run-root", root])
        self.assertEqual([command[-2:] for command in calls if command[3:4] in (["start"], ["automatic"])], [["--by", "operator"]] * 2)
        # The missing --by names only the actor a launch takes; a dry run prints no commands the maintainer would be refused.
        for argv, refusal in (([], "launch requires --by operator: "), (["--by", "maintainer"], "launch is the operator's decision"),
                              (["--dry-run", "--by", "maintainer"], "launch is the operator's decision")):
            with self.subTest(argv=argv), patch("workflow.launch.subprocess.run") as command, contextlib.redirect_stderr(io.StringIO()) as errors, \
                    contextlib.redirect_stdout(io.StringIO()) as printed:
                with self.assertRaises(SystemExit):
                    main(["project-workflows", "--repo", str(self.repo), *([] if "--dry-run" in argv else ["--live"]), *argv])
            command.assert_not_called()
            self.assertIn(refusal, errors.getvalue())
            self.assertNotIn("--by maintainer", printed.getvalue())

    def test_automatic_plan_keeps_launches_in_graph_and_adds_supervision(self):
        _, commands, _ = launch_commands(self.repo, "project-workflows", "auto-test", Path("/tmp/workflow-launch-tests"), automatic=True)
        self.assertIn("--automatic", commands[2])
        self.assertEqual(commands[-1][3], "automatic")
        self.assertIn("--live", commands[-1])
        self.assertFalse(any("push" in command for command in commands))
        self.assertFalse(any(command[0] == "claude" for command in commands))

    def test_automatic_deadlines_are_pinned_into_prepare(self):
        _, commands, _ = launch_commands(self.repo, "project-workflows", "auto-test", Path("/tmp/workflow-launch-tests"), automatic=True)
        prepare = commands[2]
        self.assertEqual(prepare[prepare.index("--worker-timeout-seconds") + 1], str(4 * 3600))
        self.assertEqual(prepare[prepare.index("--review-timeout-seconds") + 1], "1800")
        _, commands, _ = launch_commands(self.repo, "project-workflows", "auto-test", Path("/tmp/workflow-launch-tests"), automatic=True,
                                      worker_timeout_seconds=7200, review_timeout_seconds=600)
        prepare = commands[2]
        self.assertEqual(prepare[prepare.index("--worker-timeout-seconds") + 1], "7200")
        self.assertEqual(prepare[prepare.index("--review-timeout-seconds") + 1], "600")
        with self.assertRaisesRegex(ValueError, "bounded"):
            launch_commands(self.repo, "project-workflows", "auto-test", Path("/tmp/workflow-launch-tests"), automatic=True, worker_timeout_seconds=0)
        with self.assertRaisesRegex(ValueError, "automatic runs only"):
            launch_commands(self.repo, "project-workflows", "auto-test", Path("/tmp/workflow-launch-tests"), worker_timeout_seconds=7200)

    def test_reviewer_transport_is_pinned_into_prepare(self):
        _, commands, _ = launch_commands(self.repo, "project-workflows", "auto-test", Path("/tmp/workflow-launch-tests"), automatic=True)
        prepare = commands[2]
        self.assertEqual(prepare[prepare.index("--reviewer-transport") + 1], "native")
        _, commands, _ = launch_commands(self.repo, "project-workflows", "auto-test", Path("/tmp/workflow-launch-tests"), automatic=True,
                                      reviewer_transport="print")
        prepare = commands[2]
        self.assertEqual(prepare[prepare.index("--reviewer-transport") + 1], "print")
        with self.assertRaisesRegex(ValueError, "reviewer transport"):
            launch_commands(self.repo, "project-workflows", "auto-test", Path("/tmp/workflow-launch-tests"), automatic=True, reviewer_transport="stdio")
        with self.assertRaisesRegex(ValueError, "automatic runs only"):
            launch_commands(self.repo, "project-workflows", "auto-test", Path("/tmp/workflow-launch-tests"), reviewer_transport="print")
        with patch("workflow.launch.subprocess.run") as command, contextlib.redirect_stdout(io.StringIO()) as output:
            main(["project-workflows", "--repo", str(self.repo), "--dry-run", "--automatic", "--reviewer-transport", "print"])
        command.assert_not_called()
        printed = json.loads(output.getvalue())
        self.assertIn("print", printed["commands"][2])

    def test_automatic_launch_passes_a_resumable_exit_on_and_still_blocks_on_a_failure(self):
        # `automatic` exits 75 when Claude Code itself was unavailable: the launch says how to resume, not that it is blocked.
        for returncode, expected_code, expected in ((75, 75, "Claude Code was unavailable; nothing was stopped"), (1, 1, "Launch blocked")):
            def run(command, cwd, check):
                if command[3:4] == ["automatic"]:
                    raise subprocess.CalledProcessError(returncode, command)
            with self.subTest(returncode=returncode), patch("workflow.launch.subprocess.run", side_effect=run), \
                    contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()) as errors:
                with self.assertRaises(SystemExit) as exited:
                    main(["project-workflows", "--repo", str(self.repo), "--live", "--by", "operator", "--automatic", "--no-herdr",
                          "--run-id", f"auto-{returncode}", "--run-root", str(self.root / "runs")])
                self.assertEqual(exited.exception.code, expected_code)
                self.assertIn(expected, errors.getvalue())
                if returncode == 75:
                    self.assertIn(f"-m workflow automatic {self.root / 'runs' / 'auto-75'} --live", errors.getvalue())

    def test_a_live_launch_first_says_how_the_run_finishes(self):
        # From the automatic settings prepare pins (plan.automatic), not from plan.mode, which is "interactive" for every run.
        finishes = {True: "automatic, finish verified-feature-branch: once every reviewer approves, the controller fast-forwards {branch} "
                          "itself; it does not stop for integration approval, and nothing merges main or pushes",
                    False: "manual: you freeze the workers, import each review and approve the fast-forward of {branch}; nothing is pushed"}
        for automatic, finish in finishes.items():
            run_id = "finish-automatic" if automatic else "finish-manual"
            with self.subTest(automatic=automatic), patch("workflow.launch.subprocess.run"), contextlib.redirect_stdout(io.StringIO()) as output, \
                    contextlib.redirect_stderr(io.StringIO()):
                main(["project-workflows", "--repo", str(self.repo), "--live", "--by", "operator", "--no-herdr", "--run-id", run_id, "--run-root", str(self.root / "runs"),
                      *(["--automatic"] if automatic else [])])
                run = (self.root / "runs" / run_id).resolve()
                self.assertEqual(output.getvalue().splitlines()[0],
                                 f"Run {run}: {finish.format(branch=f'feature/project-workflows/{run_id}')}.")

    def test_dry_run_does_not_execute_anything(self):
        with patch("workflow.launch.subprocess.run") as command, contextlib.redirect_stdout(io.StringIO()):
            main(["project-workflows", "--repo", str(self.repo), "--dry-run"])
        command.assert_not_called()

    def test_missing_live_consent_never_runs_commands(self):
        with patch("workflow.launch.subprocess.run") as command, contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit):
                main(["project-workflows", "--repo", str(self.repo)])
        command.assert_not_called()

    def test_duplicate_run_is_not_relaunched(self):
        with tempfile.TemporaryDirectory() as root:
            (Path(root) / "project-workflows-001").mkdir()
            with patch("workflow.launch.subprocess.run") as command, contextlib.redirect_stderr(io.StringIO()):
                with self.assertRaises(SystemExit):
                    main(["project-workflows", "--repo", str(self.repo), "--live", "--by", "operator", "--run-root", root])
            command.assert_not_called()

    def test_run_id_cannot_escape_storage(self):
        for run_id in ("../other", "/tmp/other", "bad/id"):
            with self.assertRaises(ValueError):
                launch_commands(self.repo, "project-workflows", run_id, Path("/tmp/workflow-launch-tests"))

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
