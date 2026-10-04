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
        source = run.parent / "project-workflows-001.source"
        self.assertEqual(commands[0][3], "preflight")
        self.assertEqual(commands[0][commands[0].index("--repo") + 1], str(self.repo))  # The clean check runs on your checkout.
        # The run's own worktree beside the run directory, on the new branch; your checkout is never switched.
        self.assertEqual(commands[1], ["git", "worktree", "add", "-b", "feature/project-workflows/project-workflows-001", str(source), "HEAD"])
        self.assertEqual(commands[2][3], "prepare")
        self.assertNotIn("--workers", commands[2])  # Every declared lane: the selection is not spelled out.
        tasks = [commands[2][index + 1] for index, item in enumerate(commands[2]) if item == "--task"]
        self.assertEqual([task.split("=", 1)[0] for task in tasks], ["ui", "adapter"])
        # The same committed files, read from the run's worktree.
        folder = "features/project-workflows"
        self.assertEqual([task.split("=", 1)[1] for task in tasks], [str(source / folder / "ui-task.md"), str(source / folder / "adapter-task.md")])
        self.assertTrue(all((self.repo / Path(task.split("=", 1)[1]).relative_to(source)).is_file() for task in tasks))
        self.assertEqual(commands[2][commands[2].index("--policy") + 1], str(source / folder / "policy.json"))
        self.assertEqual(commands[3][3], "start")
        self.assertIn("--live", commands[3])
        self.assertIn("--herdr", commands[3])
        for command in commands[2:]:
            self.assertEqual(command[command.index("--repo") + 1], str(source))

    def git(self, *args: str) -> str:
        return subprocess.run(["git", "-C", str(self.repo), *args], check=True, capture_output=True, text=True).stdout.strip()

    def test_a_live_launch_adds_the_run_worktree_and_leaves_your_checkout_on_its_branch(self):
        branch, head = self.git("symbolic-ref", "--short", "HEAD"), self.git("rev-parse", "HEAD")
        runs = self.root / "runs"
        workflow = []
        real_run = subprocess.run  # The patch replaces the module's attribute.

        def run(command, cwd, check):
            if command[0] == "git":  # The real Git command; the workflow commands are recorded only.
                real_run(command, cwd=cwd, check=check, capture_output=True)
            else:
                workflow.append(command)

        with patch("workflow.launch.subprocess.run", side_effect=run), contextlib.redirect_stdout(io.StringIO()) as output, \
                contextlib.redirect_stderr(io.StringIO()):
            main(["project-workflows", "--repo", str(self.repo), "--live", "--automatic", "--no-herdr", "--run-root", str(runs)])
        source = (runs / "project-workflows-001.source").resolve()
        run_branch = "feature/project-workflows/project-workflows-001"
        self.assertEqual((self.git("symbolic-ref", "--short", "HEAD"), self.git("rev-parse", "HEAD"), self.git("status", "--porcelain")), (branch, head, ""))
        self.assertEqual(subprocess.run(["git", "-C", str(source), "symbolic-ref", "--short", "HEAD"], capture_output=True, text=True).stdout.strip(), run_branch)
        self.assertIn(f"worktree {source}", self.git("worktree", "list", "--porcelain"))
        self.assertEqual([command[3] for command in workflow], ["preflight", "prepare", "start", "automatic"])
        printed = output.getvalue()
        self.assertIn(f"Source checkout: {source}", printed)
        # The finished message: merge from your checkout without switching, then remove the run's worktree.
        self.assertIn(f"git -C {self.repo} merge --ff-only {run_branch}", printed)
        self.assertIn(f"git -C {self.repo} worktree remove {source}", printed)
        # The registry names your checkout, never the run's worktree.
        project = json.loads((self.root / "projects.json").read_text())["projects"]
        self.assertEqual([(item["name"], item["repository"]) for item in project], [("target", str(self.repo))])
        # A second run from the same checkout gets its own worktree; your checkout still does not move.
        with patch("workflow.launch.subprocess.run", side_effect=run), contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            main(["project-workflows", "--repo", str(self.repo), "--live", "--automatic", "--no-herdr", "--run-root", str(runs), "--run-id", "second"])
        self.assertTrue((runs / "second.source").is_dir())
        self.assertEqual((self.git("symbolic-ref", "--short", "HEAD"), self.git("rev-parse", "HEAD")), (branch, head))
        self.assertEqual(len(json.loads((self.root / "projects.json").read_text())["projects"]), 1)

    def test_an_existing_source_checkout_path_is_refused_before_any_command(self):
        runs = self.root / "runs"
        (runs / "project-workflows-001.source").mkdir(parents=True)
        with patch("workflow.launch.subprocess.run") as command, contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()) as errors:
            with self.assertRaises(SystemExit) as exited:
                main(["project-workflows", "--repo", str(self.repo), "--live", "--no-herdr", "--run-root", str(runs)])
        command.assert_not_called()
        self.assertEqual(exited.exception.code, 1)
        self.assertIn(f"Source checkout already exists: {(runs / 'project-workflows-001.source').resolve()}", errors.getvalue())
        self.assertFalse((runs / "project-workflows-001").exists())
        self.assertFalse((self.root / "projects.json").exists())
        # A source checkout that would be the repository itself is refused too.
        named = self.root / "named.source"
        shutil.copytree(self.repo, named)
        with self.assertRaisesRegex(ValueError, "Source checkout must be outside the repository"):
            launch_commands(named, "project-workflows", "named", self.root)

    def test_dry_run_prints_the_worktree_command(self):
        with patch("workflow.launch.subprocess.run") as command, contextlib.redirect_stdout(io.StringIO()) as output:
            main(["project-workflows", "--repo", str(self.repo), "--dry-run", "--run-root", str(self.root / "runs")])
        command.assert_not_called()
        printed = json.loads(output.getvalue())
        source = str((self.root / "runs/project-workflows-001.source").resolve())
        self.assertEqual(printed["commands"][1], ["git", "worktree", "add", "-b", "feature/project-workflows/project-workflows-001", source, "HEAD"])
        self.assertEqual((printed["repository"], printed["source_checkout"]), (str(self.repo), source))
        self.assertEqual(printed["registry"]["entry"]["repository"], str(self.repo))

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
                    main(["project-workflows", "--repo", str(self.repo), "--live", "--automatic", "--no-herdr",
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
                main(["project-workflows", "--repo", str(self.repo), "--live", "--no-herdr", "--run-id", run_id, "--run-root", str(self.root / "runs"),
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
                    main(["project-workflows", "--repo", str(self.repo), "--live", "--run-root", root])
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
