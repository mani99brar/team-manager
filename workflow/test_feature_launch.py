import contextlib
import fcntl
import io
import json
import os
import shutil
import subprocess
import tempfile
import time
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from .export_state import export_state
from .guardrails import LAUNCH_NOTE_ENV
from .launch import TOOL, launch_commands, main
from .registry import previous_policy
from .sessions import git, read_json, save_json
from .worktrees import LOCK_NAME
from .test_pipeline import stub_claude_cli

TESTDATA = Path(__file__).resolve().parent / "testdata"


def fixture_target(root: Path) -> Path:
    """A committed Git repository holding a copy of the finished project-workflows feature."""
    repo = root / "target"
    shutil.copytree(TESTDATA / "project-workflows", repo / "features/project-workflows")
    for args in (["init", "-q"], ["config", "user.name", "Test"], ["config", "user.email", "test@example.invalid"], ["add", "."], ["commit", "-qm", "Feature"]):
        subprocess.run(["git", "-C", str(repo), *args], check=True)
    return repo


def setUpModule():
    stub_claude_cli()  # prepare's `claude --version` reads a stand-in, never the operator's CLI.


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
        workflow, environments, locked = [], [], []
        lock = Path(self.git("rev-parse", "--absolute-git-dir")) / LOCK_NAME

        def run(command, cwd, check, env=None):
            if command[0] == "git":  # The real Git command; the workflow commands are recorded only.
                # `git worktree add` runs under the worktree lock every add under workflow/ takes.
                with lock.open("a") as handle:
                    try:
                        fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
                        fcntl.flock(handle, fcntl.LOCK_UN)
                        locked.append(False)
                    except BlockingIOError:
                        locked.append(True)
                subprocess.run(command, cwd=cwd, check=check, capture_output=True)
            else:
                workflow.append(command)
                environments.append(env)

        with patch("workflow.launch.run_command", side_effect=run), contextlib.redirect_stdout(io.StringIO()) as output, \
                contextlib.redirect_stderr(io.StringIO()):
            main(["project-workflows", "--repo", str(self.repo), "--live", "--by", "operator", "--automatic", "--no-herdr", "--run-root", str(runs)])
        source = (runs / "project-workflows-001.source").resolve()
        run_branch = "feature/project-workflows/project-workflows-001"
        self.assertEqual((self.git("symbolic-ref", "--short", "HEAD"), self.git("rev-parse", "HEAD"), self.git("status", "--porcelain")), (branch, head, ""))
        self.assertEqual(subprocess.run(["git", "-C", str(source), "symbolic-ref", "--short", "HEAD"], capture_output=True, text=True).stdout.strip(), run_branch)
        self.assertIn(f"worktree {source}", self.git("worktree", "list", "--porcelain"))
        self.assertEqual([command[3] for command in workflow], ["preflight", "prepare", "start", "automatic"])
        self.assertEqual(locked, [True])
        # Only `automatic` is told that launch prints the finished note itself, so it is printed once, in launch's -C form.
        self.assertEqual([None if env is None else env.get(LAUNCH_NOTE_ENV) for env in environments], [None, None, None, "1"])
        printed = output.getvalue()
        self.assertIn(f"Source checkout: {source}", printed)
        # The finished message: merge from your checkout without switching, then remove the run's worktree.
        self.assertIn(f"git -C {self.repo} merge --ff-only {run_branch}", printed)
        self.assertIn(f"git -C {self.repo} worktree remove {source}", printed)
        # The registry names your checkout, never the run's worktree.
        project = json.loads((self.root / "projects.json").read_text())["projects"]
        self.assertEqual([(item["name"], item["repository"]) for item in project], [("target", str(self.repo))])
        # A second run from the same checkout gets its own worktree; your checkout still does not move.
        with patch("workflow.launch.run_command", side_effect=run), contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            main(["project-workflows", "--repo", str(self.repo), "--live", "--by", "operator", "--automatic", "--no-herdr", "--run-root", str(runs), "--run-id", "second"])
        self.assertTrue((runs / "second.source").is_dir())
        self.assertEqual((self.git("symbolic-ref", "--short", "HEAD"), self.git("rev-parse", "HEAD")), (branch, head))
        self.assertEqual(len(json.loads((self.root / "projects.json").read_text())["projects"]), 1)

    def test_a_manual_launch_says_how_its_branch_merges_once_it_integrates(self):
        runs = self.root / "runs"
        with patch("workflow.launch.run_command") as command, contextlib.redirect_stdout(io.StringIO()) as output, \
                contextlib.redirect_stderr(io.StringIO()):
            main(["project-workflows", "--repo", str(self.repo), "--live", "--by", "operator", "--no-herdr", "--run-root", str(runs)])
        self.assertTrue(all("env" not in call.kwargs for call in command.call_args_list))
        source, branch = (runs / "project-workflows-001.source").resolve(), "feature/project-workflows/project-workflows-001"
        self.assertIn(f"Once it integrates: Merge the run branch from your checkout without switching it: git -C {self.repo} merge --ff-only "
                      f"{branch}. Once the run is finished, `python -m workflow clean {source.with_name('project-workflows-001')} --by operator` removes "
                      "its checkouts, its source checkout last\n", output.getvalue())

    def test_a_launch_from_a_runs_own_source_checkout_is_refused(self):
        # The cwd rule would take the run's worktree for the target: a project named after it, branched from the run's branch.
        runs = self.root / "runs"
        source = runs / "a-001.source"
        self.git("worktree", "add", "-q", "-b", "feature/project-workflows/a-001", str(source), "HEAD")
        (runs / "a-001").mkdir()
        save_json(runs / "a-001" / "plan.json", {"run_id": "a-001", "repository": str(source.resolve())})
        for argv in (["--repo", str(source / "features")], ["--repo", str(source), "--live", "--by", "operator"]):
            with self.subTest(argv=argv), patch("workflow.launch.run_command") as command, contextlib.redirect_stdout(io.StringIO()), \
                    contextlib.redirect_stderr(io.StringIO()) as errors:
                with self.assertRaises(SystemExit) as exited:
                    main(["project-workflows", *argv, "--run-id", "b-001", "--dry-run" if "--live" not in argv else "--no-herdr"])
            command.assert_not_called()
            self.assertEqual(exited.exception.code, 1)
            self.assertIn(f"{source.resolve()} is the source checkout of the run {(runs / 'a-001').resolve()}; launch from your own checkout: "
                          f"{self.repo}", errors.getvalue())
        self.assertFalse((self.root / "projects.json").exists())
        # A directory named like one, without the run's plan naming it, is an ordinary target.
        save_json(runs / "a-001" / "plan.json", {"run_id": "a-001", "repository": str(self.repo)})
        with patch("workflow.launch.run_command"), contextlib.redirect_stdout(io.StringIO()) as output:
            main(["project-workflows", "--repo", str(source), "--run-id", "b-001", "--dry-run"])
        self.assertEqual(json.loads(output.getvalue())["repository"], str(source.resolve()))

    def test_a_feature_file_git_does_not_track_is_refused_before_any_git_action(self):
        # Ignored or excluded files pass preflight's clean check, but `git worktree add` never brings them to the run.
        shutil.copytree(self.repo / "features/project-workflows", self.repo / "features/hidden")
        (self.repo / ".git/info/exclude").write_text("features/hidden/\n")
        self.assertEqual(self.git("status", "--porcelain"), "")
        # One refusal names every file, as new, ignored or excluded.
        with self.assertRaisesRegex(ValueError, r"^Not committed at HEAD \(new, ignored or excluded\): features/hidden/policy\.json, "
                                                r"features/hidden/[a-z-]+\.md, .*\. The run's worktree holds only committed files; commit them "
                                                r"\(git add -f for an ignored file\), then launch again\.$"):
            launch_commands(self.repo, "hidden", "hidden-001", self.root / "runs")
        runs = self.root / "runs"
        with patch("workflow.launch.run_command") as command, contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()) as errors:
            with self.assertRaises(SystemExit):
                main(["hidden", "--repo", str(self.repo), "--live", "--by", "operator", "--no-herdr", "--run-root", str(runs)])
        command.assert_not_called()
        self.assertIn("Not committed at HEAD (new, ignored or excluded): features/hidden/policy.json", errors.getvalue())
        self.assertEqual(self.git("branch", "--list", "feature/*"), "")
        # One excluded, untracked task file among committed ones is named the same way.
        (self.repo / ".git/info/exclude").write_text("")
        self.git("add", "features/hidden/policy.json", "features/hidden/feature.json", "features/hidden/ui-task.md")
        self.git("commit", "-qm", "Partial")
        (self.repo / ".git/info/exclude").write_text("features/hidden/adapter-task.md\n")
        with self.assertRaisesRegex(ValueError, r"\(new, ignored or excluded\): features/hidden/adapter-task\.md\. The run's"):
            launch_commands(self.repo, "hidden", "hidden-001", self.root / "runs")
        # A new file, never added, is named the same way.
        (self.repo / ".git/info/exclude").write_text("")
        self.assertIn("adapter-task.md", self.git("status", "--porcelain"))
        with self.assertRaisesRegex(ValueError, r"\(new, ignored or excluded\): features/hidden/adapter-task\.md\. The run's"):
            launch_commands(self.repo, "hidden", "hidden-001", self.root / "runs")

    def test_a_repository_without_a_commit_gets_a_readable_refusal(self):
        empty = self.root / "empty"
        shutil.copytree(self.repo / "features", empty / "features")
        subprocess.run(["git", "init", "-q", str(empty)], check=True)
        with self.assertRaisesRegex(ValueError, r"^The repository has no commit yet: .*empty\. Commit the feature, then launch again\.$"):
            launch_commands(empty, "project-workflows", "project-workflows-001", self.root / "runs")

    def test_a_leftover_source_checkout_names_its_branch_for_deletion_only_when_your_head_holds_it(self):
        runs = self.root / "runs"
        branch = "feature/project-workflows/project-workflows-001"
        source = (runs / "project-workflows-001.source").resolve()
        self.git("worktree", "add", "-q", "-b", branch, str(source), "HEAD")  # What a launch whose prepare failed leaves.
        with patch("workflow.launch.run_command") as command, contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()) as errors:
            with self.assertRaises(SystemExit):
                main(["project-workflows", "--repo", str(self.repo), "--live", "--by", "operator", "--no-herdr", "--run-root", str(runs)])
        command.assert_not_called()
        # -d, which refuses a branch that is not merged: the branch is named for deletion only while your HEAD holds its tip.
        self.assertIn(f"Source checkout already exists: {source}. A run's worktree is never reused; remove it (git -C {self.repo} worktree "
                      f"remove {source}) and its branch, which holds no commit of its own (git -C {self.repo} branch -d {branch}), or launch "
                      "with another --run-id.", errors.getvalue())
        # A branch with its own commits (a challenge revision, an integrated run not merged yet) is never suggested for deletion.
        (source / "revision.md").write_text("revised\n")
        subprocess.run(["git", "-C", str(source), "add", "revision.md"], check=True)
        subprocess.run(["git", "-C", str(source), "commit", "-qm", "Revision"], check=True)
        with patch("workflow.launch.run_command"), contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()) as errors:
            with self.assertRaises(SystemExit):
                main(["project-workflows", "--repo", str(self.repo), "--live", "--by", "operator", "--no-herdr", "--run-root", str(runs)])
        self.assertNotIn("branch -d", errors.getvalue())
        self.assertNotIn("branch -D", errors.getvalue())
        self.assertIn(f"remove it (git -C {self.repo} worktree remove {source}) or launch with another --run-id. Its branch {branch} has "
                      f"commits your HEAD does not: inspect them (git -C {self.repo} log HEAD..{branch}) before you delete it.", errors.getvalue())
        # Without the branch, the refusal names the worktree only.
        self.git("worktree", "remove", str(source))
        self.git("branch", "-D", branch)
        source.mkdir(parents=True)
        with patch("workflow.launch.run_command"), contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()) as errors:
            with self.assertRaises(SystemExit):
                main(["project-workflows", "--repo", str(self.repo), "--live", "--by", "operator", "--no-herdr", "--run-root", str(runs)])
        self.assertIn(f"remove it (git -C {self.repo} worktree remove {source}) or launch with another --run-id.", errors.getvalue())

    def test_an_existing_source_checkout_path_is_refused_before_any_command(self):
        runs = self.root / "runs"
        (runs / "project-workflows-001.source").mkdir(parents=True)
        with patch("workflow.launch.run_command") as command, contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()) as errors:
            with self.assertRaises(SystemExit) as exited:
                main(["project-workflows", "--repo", str(self.repo), "--live", "--by", "operator", "--no-herdr", "--run-root", str(runs)])
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
        with patch("workflow.launch.run_command") as command, contextlib.redirect_stdout(io.StringIO()) as output:
            main(["project-workflows", "--repo", str(self.repo), "--dry-run", "--run-root", str(self.root / "runs")])
        command.assert_not_called()
        printed = json.loads(output.getvalue())
        source = str((self.root / "runs/project-workflows-001.source").resolve())
        self.assertEqual(printed["commands"][1], ["git", "worktree", "add", "-b", "feature/project-workflows/project-workflows-001", source, "HEAD"])
        self.assertEqual((printed["repository"], printed["source_checkout"]), (str(self.repo), source))
        self.assertEqual(printed["registry"]["entry"]["repository"], str(self.repo))

    def test_launch_passes_its_by_to_start_and_automatic_and_refuses_the_maintainer(self):
        """C17: the steps a launch runs carry its --by; a launch is the operator's decision."""
        _, commands, _ = launch_commands(self.repo, "project-workflows", "by-test", Path("/tmp/workflow-launch-tests"), automatic=True, by="operator")
        self.assertEqual([command[3:] for command in commands if command[3:4] in (["start"], ["automatic"])],
                         [["start", "/tmp/workflow-launch-tests/by-test", "--live", "--repo", "/tmp/workflow-launch-tests/by-test.source", "--by", "operator", "--herdr"],
                          ["automatic", "/tmp/workflow-launch-tests/by-test", "--live", "--repo", "/tmp/workflow-launch-tests/by-test.source", "--by", "operator"]])
        calls = []
        with tempfile.TemporaryDirectory() as root, patch("workflow.launch.run_command", side_effect=lambda command, cwd, check, **_: calls.append(command)), \
                contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            main(["project-workflows", "--repo", str(self.repo), "--live", "--by", "operator", "--automatic", "--no-herdr", "--run-root", root])
        self.assertEqual([command[-2:] for command in calls if command[3:4] in (["start"], ["automatic"])], [["--by", "operator"]] * 2)
        # The missing --by names only the actor a launch takes; a dry run prints no commands the maintainer would be refused.
        for argv, refusal in (([], "launch requires --by operator: "), (["--by", "maintainer"], "launch is the operator's decision"),
                              (["--dry-run", "--by", "maintainer"], "launch is the operator's decision")):
            with self.subTest(argv=argv), patch("workflow.launch.run_command") as command, contextlib.redirect_stderr(io.StringIO()) as errors, \
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
        with patch("workflow.launch.run_command") as command, contextlib.redirect_stdout(io.StringIO()) as output:
            main(["project-workflows", "--repo", str(self.repo), "--dry-run", "--automatic", "--reviewer-transport", "print"])
        command.assert_not_called()
        printed = json.loads(output.getvalue())
        self.assertIn("print", printed["commands"][2])

    def test_automatic_launch_passes_a_resumable_exit_on_and_still_blocks_on_a_failure(self):
        # `automatic` exits 75 when Claude Code itself was unavailable: the launch says how to resume, not that it is blocked.
        for returncode, expected_code, expected in ((75, 75, "Claude Code was unavailable; nothing was stopped"), (1, 1, "Launch blocked")):
            def run(command, cwd, check, env=None):
                if command[3:4] == ["automatic"]:
                    raise subprocess.CalledProcessError(returncode, command)
            with self.subTest(returncode=returncode), patch("workflow.launch.run_command", side_effect=run), \
                    contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()) as errors:
                with self.assertRaises(SystemExit) as exited:
                    main(["project-workflows", "--repo", str(self.repo), "--live", "--by", "operator", "--automatic", "--no-herdr",
                          "--run-id", f"auto-{returncode}", "--run-root", str(self.root / "runs")])
                self.assertEqual(exited.exception.code, expected_code)
                self.assertIn(expected, errors.getvalue())
                if returncode == 75:
                    self.assertIn(f"-m workflow automatic {self.root / 'runs' / 'auto-75'} --live", errors.getvalue())

    def test_an_automatic_launch_prints_the_outcome_block_once_after_its_finished_line(self):
        # C43: launch's own copy, after `automatic` printed its own above (it shares the terminal); then the source checkout's
        # finished note (C56a), which `automatic` leaves to launch.
        with patch("workflow.launch.run_command"), patch("workflow.pipeline.outcome_block", return_value="Outcome: blocked\nReviewers:"), \
                contextlib.redirect_stdout(io.StringIO()) as output, contextlib.redirect_stderr(io.StringIO()):
            main(["project-workflows", "--repo", str(self.repo), "--live", "--by", "operator", "--automatic", "--no-herdr",
                  "--run-id", "outcome-001", "--run-root", str(self.root / "runs")])
        lines = output.getvalue().splitlines()
        index = next(i for i, line in enumerate(lines) if line.startswith("Automatic run finished. Evidence: "))
        self.assertEqual(lines[index + 1:index + 3], ["Outcome: blocked", "Reviewers:"])
        self.assertEqual(len(lines), index + 4)  # The finished note, last.
        self.assertEqual(output.getvalue().count("Outcome:"), 1)

    def test_an_attended_launch_stopped_for_approval_says_so_instead_of_finished(self):
        # C51: `automatic` exits 0 at the approval stop, as `start` does at a challenge pause; launch reads the run's state.
        stop = "Automatic run awaiting your approval: ...\nApprove with: python -m workflow approve run --bundle-sha256 abc --by operator\nOpen items: none recorded.\n"
        with patch("workflow.launch.run_command"), patch("workflow.pipeline.approval_stop", return_value=stop), \
                contextlib.redirect_stdout(io.StringIO()) as output, contextlib.redirect_stderr(io.StringIO()):
            main(["project-workflows", "--repo", str(self.repo), "--live", "--by", "operator", "--automatic", "--profile", "attended",
                  "--no-herdr", "--run-id", "approval-001", "--run-root", str(self.root / "runs")])
        printed = output.getvalue()
        self.assertIn("automatic, finish approval (the attended profile): once every reviewer approves, the run stops for your approval", printed)
        self.assertIn("Launch stopped for your approval; nothing was fast-forwarded.", printed)
        self.assertIn("--bundle-sha256 abc --by operator", printed)
        self.assertNotIn("Automatic run finished", printed)

    def test_a_live_launch_first_says_how_the_run_finishes(self):
        # From the automatic settings prepare pins (plan.automatic), not from plan.mode, which is "interactive" for every run.
        finishes = {True: "automatic, finish verified-feature-branch: once every reviewer approves, the controller fast-forwards {branch} "
                          "itself; it does not stop for integration approval, and nothing merges main or pushes",
                    False: "manual: you freeze the workers, import each review and approve the fast-forward of {branch}; nothing is pushed"}
        for automatic, finish in finishes.items():
            run_id = "finish-automatic" if automatic else "finish-manual"
            with self.subTest(automatic=automatic), patch("workflow.launch.run_command"), contextlib.redirect_stdout(io.StringIO()) as output, \
                    contextlib.redirect_stderr(io.StringIO()):
                main(["project-workflows", "--repo", str(self.repo), "--live", "--by", "operator", "--no-herdr", "--run-id", run_id, "--run-root", str(self.root / "runs"),
                      *(["--automatic"] if automatic else [])])
                run = (self.root / "runs" / run_id).resolve()
                profile = " (profile unattended)" if automatic else ""
                self.assertEqual(output.getvalue().splitlines()[0],
                                 f"Run {run}{profile}: {finish.format(branch=f'feature/project-workflows/{run_id}')}.")

    def test_an_omitted_profile_pins_unattended_the_first_line_names_it_and_an_unknown_one_is_refused(self):
        # C52, decisions 1 and 3. The role pins reach prepare only when given: the worker effort's default is read there, once.
        _, commands, _ = launch_commands(self.repo, "project-workflows", "auto-test", Path("/tmp/workflow-launch-tests"), automatic=True)
        prepare = commands[2]
        self.assertEqual(prepare[prepare.index("--profile") + 1], "unattended")
        self.assertFalse({"--worker-model", "--worker-effort", "--judge-model", "--judge-effort"} & set(prepare))
        _, commands, _ = launch_commands(self.repo, "project-workflows", "auto-test", Path("/tmp/workflow-launch-tests"), automatic=True, profile="attended",
                                         roles={"worker_model": "claude-sonnet-5", "worker_effort": "low", "judge_model": None, "judge_effort": "max"})
        prepare = commands[2]
        self.assertEqual([prepare[prepare.index(flag) + 1] for flag in ("--profile", "--worker-model", "--worker-effort", "--judge-effort")],
                         ["attended", "claude-sonnet-5", "low", "max"])
        self.assertNotIn("--judge-model", prepare)
        _, commands, _ = launch_commands(self.repo, "project-workflows", "manual-test", Path("/tmp/workflow-launch-tests"), roles={"judge_effort": "max"})
        self.assertNotIn("--profile", commands[2])  # A manual run has no profile; its roles are pinned all the same.
        self.assertEqual(commands[2][commands[2].index("--judge-effort") + 1], "max")
        with self.assertRaisesRegex(ValueError, "profile"):
            launch_commands(self.repo, "project-workflows", "auto-test", Path("/tmp/workflow-launch-tests"), automatic=True, profile="supervised")
        with self.assertRaisesRegex(ValueError, "automatic runs only"):
            launch_commands(self.repo, "project-workflows", "auto-test", Path("/tmp/workflow-launch-tests"), profile="attended")
        with self.assertRaisesRegex(ValueError, "judge-effort"):
            launch_commands(self.repo, "project-workflows", "auto-test", Path("/tmp/workflow-launch-tests"), roles={"judge_effort": "extreme"})
        for argv in (["--automatic", "--profile", "supervised"], ["--automatic", "--worker-effort", "med"]):
            with self.subTest(argv), patch("workflow.launch.run_command") as command, contextlib.redirect_stderr(io.StringIO()) as errors, \
                    self.assertRaises(SystemExit) as refused:
                main(["project-workflows", "--repo", str(self.repo), "--live", "--run-root", str(self.root / "runs"), *argv])
            self.assertEqual(refused.exception.code, 2)
            self.assertIn("invalid choice", errors.getvalue())
            command.assert_not_called()
        with patch("workflow.launch.run_command"), contextlib.redirect_stdout(io.StringIO()) as output, contextlib.redirect_stderr(io.StringIO()):
            main(["project-workflows", "--repo", str(self.repo), "--live", "--by", "operator", "--no-herdr", "--run-id", "attended", "--run-root", str(self.root / "runs"),
                  "--automatic", "--profile", "attended"])
        self.assertTrue(output.getvalue().splitlines()[0].startswith(f"Run {(self.root / 'runs' / 'attended').resolve()} (profile attended): automatic"))

    def test_a_dry_run_says_when_a_scrubbed_model_override_would_have_chosen_the_model(self):
        # A live launch leaves the note to prepare, whose output it shows; a dry run runs no prepare, so it says it itself.
        with patch.dict(os.environ, {"ANTHROPIC_MODEL": "claude-opus-5-5", "CLAUDE_CODE_EFFORT_LEVEL": ""}), patch("workflow.launch.run_command"), \
                contextlib.redirect_stdout(io.StringIO()) as output, contextlib.redirect_stderr(io.StringIO()) as errors:
            main(["project-workflows", "--repo", str(self.repo), "--dry-run", "--worker-model", "claude-opus-5-5"])
        note = ("ANTHROPIC_MODEL is set here but never reaches the run's sessions, which the workflow starts without it: pin it with "
                "--judge-model; unpinned, a session runs Claude Code's default model.")
        self.assertIn(note, json.loads(output.getvalue())["notes"])
        self.assertIn(f"Note: {note}", errors.getvalue())
        with patch.dict(os.environ, {"ANTHROPIC_MODEL": "claude-opus-5-5"}), patch("workflow.launch.run_command"), \
                contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()) as errors:
            main(["project-workflows", "--repo", str(self.repo), "--live", "--by", "operator", "--no-herdr", "--run-id", "noted", "--run-root", str(self.root / "runs")])
        self.assertNotIn("ANTHROPIC_MODEL", errors.getvalue())

    def test_restore_from_is_resolved_and_passed_to_prepare_and_the_dry_run_shows_it(self):
        # C12: launch resolves --restore-from in the target before any Git action and hands prepare the commit.
        head = subprocess.check_output(["git", "-C", str(self.repo), "rev-parse", "HEAD"], text=True).strip()
        _, commands, _ = launch_commands(self.repo, "project-workflows", "restore-test", Path("/tmp/workflow-launch-tests"), automatic=True, restore_from="HEAD")
        prepare = commands[2]
        self.assertEqual(prepare[prepare.index("--restore-from") + 1], head)
        _, commands, _ = launch_commands(self.repo, "project-workflows", "restore-test", Path("/tmp/workflow-launch-tests"))
        self.assertNotIn("--restore-from", commands[2])
        with self.assertRaisesRegex(ValueError, "--restore-from no-such-commit is not a commit"):
            launch_commands(self.repo, "project-workflows", "restore-test", Path("/tmp/workflow-launch-tests"), automatic=True, restore_from="no-such-commit")
        with self.assertRaisesRegex(ValueError, "--restore-from needs --automatic"):  # A manual worker has no shell.
            launch_commands(self.repo, "project-workflows", "restore-test", Path("/tmp/workflow-launch-tests"), restore_from="HEAD")
        with patch("workflow.launch.run_command") as command, contextlib.redirect_stdout(io.StringIO()) as output:
            main(["project-workflows", "--repo", str(self.repo), "--dry-run", "--automatic", "--restore-from", "HEAD"])
        command.assert_not_called()
        printed = json.loads(output.getvalue())
        self.assertEqual(printed["restore_from"], {"name": "HEAD", "commit": head})
        self.assertIn(head, printed["commands"][2])

    def test_dry_run_does_not_execute_anything(self):
        with patch("workflow.launch.run_command") as command, contextlib.redirect_stdout(io.StringIO()):
            main(["project-workflows", "--repo", str(self.repo), "--dry-run"])
        command.assert_not_called()

    def test_missing_live_consent_never_runs_commands(self):
        with patch("workflow.launch.run_command") as command, contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit):
                main(["project-workflows", "--repo", str(self.repo)])
        command.assert_not_called()

    def test_duplicate_run_is_not_relaunched(self):
        with tempfile.TemporaryDirectory() as root:
            (Path(root) / "project-workflows-001").mkdir()
            with patch("workflow.launch.run_command") as command, contextlib.redirect_stderr(io.StringIO()):
                with self.assertRaises(SystemExit):
                    main(["project-workflows", "--repo", str(self.repo), "--live", "--by", "operator", "--run-root", root])
            command.assert_not_called()

    def test_run_id_cannot_escape_storage(self):
        for run_id in ("../other", "/tmp/other", "bad/id"):
            with self.assertRaises(ValueError):
                launch_commands(self.repo, "project-workflows", run_id, Path("/tmp/workflow-launch-tests"))

    def followed(self, name: str, **files) -> Path:
        """A finished run's directory: plan.json plus the given files ({name: JSON value})."""
        directory = self.root / "runs" / name
        directory.mkdir(parents=True)
        save_json(directory / "plan.json", {"run_id": name, "base_commit": "a" * 40})
        for file, value in files.items():
            save_json(directory / file.replace("_", "-").replace("-json", ".json"), value)
        return directory

    def test_follows_reaches_prepare_and_a_run_without_plan_json_is_refused_before_any_git_action(self):
        """C30: a follow-up is a new run of the same feature; --follows names the run it follows (a directory, or a run id under the run root)."""
        old = self.followed("project-workflows-001")
        _, commands, _ = launch_commands(self.repo, "project-workflows", "project-workflows-002", self.root / "runs", follows=str(old))
        self.assertEqual(commands[2][commands[2].index("--follows") + 1], str(old))
        _, commands, _ = launch_commands(self.repo, "project-workflows", "project-workflows-002", self.root / "runs", follows="project-workflows-001")
        self.assertEqual(commands[2][commands[2].index("--follows") + 1], str(old.resolve()))
        _, commands, _ = launch_commands(self.repo, "project-workflows", "project-workflows-002", self.root / "runs")
        self.assertNotIn("--follows", commands[2])
        (self.root / "runs" / "empty").mkdir()
        for value in (str(self.root / "runs" / "empty"), "missing-001"):
            with self.subTest(follows=value), patch("workflow.launch.run_command") as command, contextlib.redirect_stderr(io.StringIO()) as errors:
                with self.assertRaises(SystemExit):
                    main(["project-workflows", "--repo", str(self.repo), "--live", "--by", "operator", "--run-id", "project-workflows-002",
                          "--run-root", str(self.root / "runs"), "--follows", value])
                command.assert_not_called()
                self.assertIn("has no plan.json", errors.getvalue())

    def test_prepare_pins_what_the_run_follows(self):
        from .test_pipeline import pipeline_cli
        folder = self.repo / "features" / "project-workflows"
        tasks = ["--task", f"ui={folder / 'ui-task.md'}", "--task", f"adapter={folder / 'adapter-task.md'}"]
        blocked = self.followed("blocked-001", review_json={"verdict": "blocked", "candidate_commit": "c" * 40})
        limited = self.followed("limited-001", candidate_json={"commit": "d" * 40, "worktree": "/gone"})
        bare = self.followed("bare-001")
        for followed, expected in ((blocked, {"run_id": "blocked-001", "verdict": "blocked", "candidate_commit": "c" * 40}),
                                   (limited, {"run_id": "limited-001", "verdict": None, "candidate_commit": "d" * 40}),
                                   (bare, {"run_id": "bare-001", "verdict": None, "candidate_commit": None})):
            with self.subTest(followed=followed.name):
                run = self.root / "follow-ups" / followed.name
                code, out, err = pipeline_cli("prepare", str(run), "--repo", str(self.repo), "--policy", str(folder / "policy.json"), *tasks,
                                              "--follows", str(followed))
                self.assertEqual(code, 0, err)
                self.assertEqual(json.loads((run / "plan.json").read_text())["follows"], expected)
        code, _, err = pipeline_cli("prepare", str(self.root / "follow-ups" / "refused"), "--repo", str(self.repo), "--policy", str(folder / "policy.json"),
                                    *tasks, "--follows", str(self.root / "runs" / "nothing-here"))
        self.assertEqual(code, 1)
        self.assertIn("has no plan.json", err)
        self.assertFalse((self.root / "follow-ups" / "refused" / "plan.json").exists())

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


def ago(hours: float) -> str:
    return (datetime.now(timezone.utc) - timedelta(hours=hours)).isoformat().replace("+00:00", "Z")


class LaunchNotes(unittest.TestCase):
    """C23 and C27: notes at launch, dry runs included, that prepare records as one run event. Never a refusal."""

    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.repo = fixture_target(self.root)
        # The launched feature's adapter lane also owns package.json.
        policy_path = self.repo / "features/project-workflows/policy.json"
        policy = json.loads(policy_path.read_text())
        policy["workers"][1]["owned_paths"].append("package.json")
        policy_path.write_text(json.dumps(policy, indent=2) + "\n")
        git(self.repo, "commit", "-qam", "adapter owns package.json")
        self.base = git(self.repo, "rev-parse", "HEAD")
        self.registry = self.root / "config" / "projects.json"
        environment = patch.dict(os.environ, {"MD_MANAGER_PROJECTS_CONFIG": str(self.registry), "HOME": str(self.root / "home")})
        environment.start()
        self.addCleanup(environment.stop)
        self.runs = self.root / "runs"
        self.own_root = self.runs / "project-workflows"
        # Another feature of the same repository, still running: its web lane owns package.json too.
        self.first = self.make_run(self.runs / "first" / "first-001", self.repo, [{"node_id": "web", "owned_paths": ["package.json", "web"]}])
        self.registry.parent.mkdir(parents=True)
        save_json(self.registry, {"version": 1, "projects": [{"project_id": "target", "name": "target", "repository": str(self.repo), "workflows": [
            {"workflow_id": "first", "runs_root": str(self.runs / "first")},
            {"workflow_id": "project-workflows", "runs_root": str(self.own_root)}]}]})

    def make_run(self, directory: Path, repository: Path, lanes: list[dict], *, hours: float = 1, kinds: dict | None = None) -> Path:
        """A run directory as prepare and the controller leave it: plan, pinned policy and an event `hours` ago."""
        workers = [{"node_id": lane["node_id"], "role": "backend", "required_check_kinds": (kinds or {}).get(lane["node_id"], ["unit"]),
                    "owned_paths": lane["owned_paths"], "checks": [
                        {"id": f"{lane['node_id']}-{kind}", "kind": kind, "argv": ["npm", "run", f"{lane['node_id']}-{kind}"], "timeout_seconds": 60, "scenarios": []}
                        for kind in (kinds or {}).get(lane["node_id"], ["unit"])]} for lane in lanes]
        directory.mkdir(parents=True, exist_ok=True)
        save_json(directory / "plan.json", {"run_id": directory.name, "repository": str(repository), "base_commit": self.base, "created_at": ago(hours),
                                            "workers": [lane["node_id"] for lane in lanes], "excluded_workers": []})
        save_json(directory / "policy.json", {"version": "1.2.0", "feature": directory.parent.name, "independent_review": True,
                                              "integration_approval": True, "workers": workers})
        (directory / "events.jsonl").write_text(json.dumps({"sequence": 1, "time": ago(hours), "node": "controller", "status": "running", "message": "x"}) + "\n")
        return directory

    def notes(self, run_id: str = "project-workflows-002") -> list[str]:
        _, _, notes = launch_commands(self.repo, "project-workflows", run_id, self.own_root, herdr=False)
        return notes

    def overlaps(self) -> list[str]:
        return [note for note in self.notes() if "overlaps" in note]

    def test_a_running_feature_of_the_same_repository_that_owns_the_same_path_is_named(self):
        [note] = self.overlaps()
        self.assertIn("package.json", note)
        self.assertIn("first-001", note)
        self.assertIn("no candidate yet", note)
        # The dry run prints it among its notes and runs nothing.
        with patch("workflow.launch.run_command") as command, contextlib.redirect_stdout(io.StringIO()) as output, \
                contextlib.redirect_stderr(io.StringIO()) as errors:
            main(["project-workflows", "--repo", str(self.repo), "--dry-run", "--run-root", str(self.own_root)])
        command.assert_not_called()
        self.assertEqual([item for item in json.loads(output.getvalue())["notes"] if "overlaps" in item], [note])
        self.assertIn(f"Note: {note}", errors.getvalue())
        # A candidate that is not in the new base still counts.
        git(self.repo, "switch", "-qc", "side")
        (self.repo / "package.json").write_text("{}\n")
        git(self.repo, "add", "package.json")
        git(self.repo, "commit", "-qm", "side")
        side = git(self.repo, "rev-parse", "HEAD")
        git(self.repo, "switch", "-q", "-")
        save_json(self.first / "review-bundle.json", {"candidate_commit": side})
        [note] = self.overlaps()
        self.assertIn(f"candidate {side[:12]} is not in this base", note)

    def test_a_finished_run_whose_source_checkout_was_removed_is_still_named(self):
        # A launched (C56) run: plan.repository is its <run>.source worktree, which clean or the operator removes once it finished.
        source = self.runs / "first" / "first-001.source"
        git(self.repo, "worktree", "add", "-q", "-b", "feature/first/first-001", str(source), "HEAD")
        (source / "package.json").write_text("{}\n")
        git(source, "add", "package.json")
        git(source, "commit", "-qm", "first's work")
        integrated = git(source, "rev-parse", "HEAD")
        plan = json.loads((self.first / "plan.json").read_text())
        save_json(self.first / "plan.json", {**plan, "repository": str(source)})
        save_json(self.first / "review-bundle.json", {"candidate_commit": integrated})
        [note] = self.overlaps()
        git(self.repo, "worktree", "remove", str(source))
        # Its commit is still in the repository, not in the new base: the registry's checkout of the project names the repository.
        self.assertEqual(self.overlaps(), [note])
        self.assertIn(f"candidate {integrated[:12]} is not in this base", note)

    def test_runs_whose_work_is_in_the_base_idle_runs_earlier_runs_of_the_feature_and_other_repositories_give_none(self):
        with self.subTest("candidate in the new base"):
            save_json(self.first / "review-bundle.json", {"candidate_commit": self.base})
            self.assertEqual(self.overlaps(), [])
            (self.first / "review-bundle.json").unlink()
        with self.subTest("idle for more than 48 hours"):
            self.make_run(self.first, self.repo, [{"node_id": "web", "owned_paths": ["package.json"]}], hours=49)
            self.assertEqual(self.overlaps(), [])
        with self.subTest("an earlier run of the same feature"):
            self.make_run(self.own_root / "project-workflows-001", self.repo, [{"node_id": "adapter", "owned_paths": ["package.json"]}])
            self.assertEqual(self.overlaps(), [])
        with self.subTest("another repository"):
            other = self.root / "other"
            other.mkdir()
            for args in (["init", "-q"], ["config", "user.name", "Test"], ["config", "user.email", "test@example.invalid"], ["commit", "-q", "--allow-empty", "-m", "Other"]):
                subprocess.run(["git", "-C", str(other), *args], check=True)
            self.make_run(self.first, other, [{"node_id": "web", "owned_paths": ["package.json"]}])
            self.assertEqual(self.overlaps(), [])
        with self.subTest("a checkout that is gone"):
            # Neither the run's checkout nor its project's registered one is left: nothing names its repository.
            self.make_run(self.first, self.root / "gone", [{"node_id": "web", "owned_paths": ["package.json"]}])
            registry = json.loads(self.registry.read_text())
            registry["projects"][0]["repository"] = str(self.root / "gone")
            save_json(self.registry, registry)
            self.assertEqual(self.overlaps(), [])

    def test_a_timeline_last_modified_before_the_window_is_not_read(self):
        # Events are appended at their own time, so a file older than RECENT holds no recent event: it is not even parsed.
        # (Its one event is stamped an hour ago here only to show that it was not read.)
        old = time.time() - 49 * 3600
        os.utime(self.first / "events.jsonl", (old, old))
        self.assertEqual(self.overlaps(), [])
        # previous_policy reads plan.json and policy.json only, never a timeline.
        self.make_run(self.own_root / "project-workflows-001", self.repo, [{"node_id": "adapter", "owned_paths": ["server"]}])
        with patch("workflow.registry.run_record", side_effect=AssertionError("a timeline was read")):
            run_id, policy = previous_policy(self.own_root, self.own_root / "project-workflows-002")
        self.assertEqual((run_id, [worker["node_id"] for worker in policy["workers"]]), ("project-workflows-001", ["adapter"]))

    def test_a_malformed_previous_policy_or_registry_root_never_refuses_the_launch(self):
        previous = self.make_run(self.own_root / "project-workflows-001", self.repo, [{"node_id": "adapter", "owned_paths": ["server"]}])
        valid = read_json(previous / "policy.json")
        for workers in (None, ["adapter"]):  # Hand-edited or corrupt: no list, or an entry that is not an object.
            with self.subTest(workers=workers):
                save_json(previous / "policy.json", {**read_json(previous / "policy.json"), "workers": workers})
                self.assertIsInstance(self.notes(), list)
        save_json(previous / "policy.json", valid)
        # A registry runs_root naming an unknown user: Path.expanduser raises RuntimeError.
        save_json(self.registry, {"version": 1, "projects": [{"project_id": "target", "name": "target", "repository": str(self.repo), "workflows": [
            {"workflow_id": "first", "runs_root": "~no-such-user-m5/runs"},
            {"workflow_id": "project-workflows", "runs_root": str(self.own_root)}]}]})
        self.assertIsInstance(self.notes(), list)

    def test_a_linked_worktree_and_a_clone_of_the_same_repository_each_give_one(self):
        worktree, clone = self.root / "linked", self.root / "clone"
        git(self.repo, "worktree", "add", "-q", "--detach", str(worktree))
        subprocess.run(["git", "clone", "-q", str(self.repo), str(clone)], check=True)
        for checkout in (worktree, clone):
            with self.subTest(checkout=checkout.name):
                self.make_run(self.first, checkout, [{"node_id": "web", "owned_paths": ["package.json"]}])
                self.assertEqual(len(self.overlaps()), 1)

    def test_a_kind_removed_since_the_previous_run_is_noted_and_prepare_records_the_notes(self):
        self.make_run(self.own_root / "project-workflows-001", self.repo, [{"node_id": "ui", "owned_paths": ["src"]}, {"node_id": "adapter", "owned_paths": ["server"]}],
                 kinds={"ui": ["build", "browser"], "adapter": ["unit", "contract", "integration"]})
        removed = ("Lane adapter requires fewer checks than the policy of project-workflows-001: required kind contract removed; "
                   "required kind integration removed; check adapter-contract removed; check adapter-integration removed; check adapter-unit removed.")
        with patch("workflow.launch.run_command"), contextlib.redirect_stdout(io.StringIO()) as output, contextlib.redirect_stderr(io.StringIO()):
            main(["project-workflows", "--repo", str(self.repo), "--dry-run", "--run-root", str(self.own_root), "--run-id", "project-workflows-002"])
        notes = json.loads(output.getvalue())["notes"]
        self.assertIn(removed, notes)
        # prepare (the real command, no agent) records the launch's notes as one run event.
        run, commands, expected = launch_commands(self.repo, "project-workflows", "project-workflows-002", self.own_root, herdr=False)
        self.assertEqual(expected, notes)
        subprocess.run(commands[1], cwd=self.repo, check=True, capture_output=True)  # The run's own worktree, as launch adds it.
        result = subprocess.run(commands[2], cwd=TOOL, capture_output=True, text=True, timeout=120)
        self.assertEqual(result.returncode, 0, result.stderr)
        events = [json.loads(line) for line in (run / "events.jsonl").read_text().splitlines()]
        launch = [event for event in events if event["message"].startswith("Launch notes: ")]
        self.assertEqual([(event["node"], event["status"]) for event in launch], [("controller", "running")])
        for note in expected:
            if "browser check" not in note:  # C7's tryout note is launch's own, about the feature file; prepare records the lane notes.
                self.assertIn(note, launch[0]["message"])


class UntriedLimit(unittest.TestCase):
    """C29 (decision 10): a new tryout launch stops when 3 other features are untried, across every registered project. A
    feature is untried when its latest integrated run asks for a tryout and has no verdict (C7's tryout.json)."""

    def setUp(self):
        from .test_guardrails import BRIEF, DECISIONS, two_lane_policy
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        # A committed 2.4.0 feature that asks for a tryout.
        self.repo = self.root / "target"
        self.folder = self.repo / "features" / "board"
        self.folder.mkdir(parents=True)
        (self.repo / "docs").mkdir()
        (self.repo / "docs/PRD.md").write_text("# PRD\n\nThe board.\n")
        save_json(self.folder / "policy.json", two_lane_policy())
        for lane in ("ui", "adapter"):
            (self.folder / f"{lane}-task.md").write_text(BRIEF.format(lane=lane))
        (self.folder / "decisions.md").write_text(DECISIONS)
        self.manifest = {"version": "2.4.0", "name": "Board", "branch_prefix": "feature/board", "prd": "docs/PRD.md", "policy": "policy.json",
                         "challenge": False, "tryout": True, "workers": [{"node_id": lane, "task": f"{lane}-task.md"} for lane in ("ui", "adapter")]}
        save_json(self.folder / "feature.json", self.manifest)
        for args in (["init", "-q"], ["config", "user.name", "Test"], ["config", "user.email", "test@example.invalid"], ["add", "."], ["commit", "-qm", "Base"]):
            subprocess.run(["git", "-C", str(self.repo), *args], check=True)
        self.registry = self.root / "config" / "projects.json"
        environment = patch.dict(os.environ, {"MD_MANAGER_PROJECTS_CONFIG": str(self.registry), "HOME": str(self.root / "home"), "CLAUDECODE": ""})
        environment.start()
        self.addCleanup(environment.stop)
        self.runs = self.root / "runs"
        self.own_root = self.runs / "target" / "board"
        # Three other features waiting for their tryout: two in another project, one beside this feature in its own.
        self.waiting = [self.integrated(self.runs / "alpha" / "login" / "login-001"), self.integrated(self.runs / "alpha" / "search" / "search-002"),
                        self.integrated(self.runs / "target" / "chart" / "chart-001")]
        self.registry.parent.mkdir(parents=True)
        save_json(self.registry, {"version": 1, "projects": [
            {"project_id": "alpha", "name": "alpha", "repository": str(self.root / "alpha"), "workflows": [
                {"workflow_id": "login", "runs_root": str(self.runs / "alpha" / "login")},
                {"workflow_id": "search", "runs_root": str(self.runs / "alpha" / "search")}]},
            {"project_id": "target", "name": "target", "repository": str(self.repo), "workflows": [
                {"workflow_id": "chart", "runs_root": str(self.runs / "target" / "chart")},
                {"workflow_id": "board", "runs_root": str(self.own_root)}]}]})

    def integrated(self, directory: Path, tryout: bool = True, hours: float = 1, fast_forward: bool = True) -> Path:
        """A run that integrated `hours` ago (its integrate event), its plan asking for a tryout or not."""
        directory.mkdir(parents=True, exist_ok=True)
        save_json(directory / "plan.json", {"run_id": directory.name, "created_at": ago(hours + 1), "tryout": tryout})
        events = [{"sequence": 1, "time": ago(hours), "node": "integrate", "status": "succeeded",
                   "message": f"Fast-forwarded to {'a' * 40}"} if fast_forward else
                  {"sequence": 1, "time": ago(hours), "node": "review", "status": "blocked", "message": "Blocked"}]
        (directory / "events.jsonl").write_text("".join(json.dumps(event) + "\n" for event in events))
        return directory

    def launch(self, run_id: str = "board-001", **options):
        return launch_commands(self.repo, "board", run_id, self.own_root, herdr=False, **options)

    def refused(self, **options) -> str:
        with self.assertRaises(ValueError) as refusal:
            self.launch(**options)
        return str(refusal.exception)

    def dry_run(self, *argv: str) -> tuple[int, str, str]:
        code = 0
        with patch("workflow.launch.run_command") as command, contextlib.redirect_stdout(io.StringIO()) as output, \
                contextlib.redirect_stderr(io.StringIO()) as errors:
            try:
                main(["board", "--repo", str(self.repo), "--dry-run", "--run-root", str(self.own_root), *argv])
            except SystemExit as exit_:
                code = exit_.code or 0
        command.assert_not_called()
        return code, output.getvalue(), errors.getvalue()

    def test_three_untried_features_in_any_registered_project_refuse_a_fourths_tryout_launch_dry_runs_included(self):
        message = self.refused()
        self.assertIn("3 other features wait for your tryout, and a new tryout launch stops at 3", message)
        for name in ("alpha/login", "alpha/search", "target/chart"):
            self.assertIn(name, message)
        self.assertIn("python -m workflow tryout <run> --result works|broken|skipped --by operator", message)
        self.assertIn('--allow-untried "<reason>" --by operator', message)
        code, output, errors = self.dry_run()
        self.assertEqual(code, 1)
        self.assertIn("3 other features wait for your tryout", errors)
        self.assertEqual(output, "")
        # A live launch stops before any Git action: no worktree, no branch, no run directory.
        with patch("workflow.launch.run_command") as command, contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()), \
                self.assertRaises(SystemExit):
            main(["board", "--repo", str(self.repo), "--live", "--by", "operator", "--no-herdr", "--run-root", str(self.own_root)])
        command.assert_not_called()
        self.assertFalse(self.own_root.exists())
        # Two untried others pass.
        save_json(self.waiting[0] / "tryout.json", {"verdicts": [{"result": "works", "note": None, "at": ago(0), "by": "operator"}]})
        self.launch()

    def test_tryout_false_features_runs_not_integrated_and_launches_without_a_tryout_never_count(self):
        with self.subTest("a feature whose latest integrated run asks for no tryout"):
            self.integrated(self.waiting[1], tryout=False)
            self.launch()
        with self.subTest("a later run that did not integrate leaves the latest integrated one deciding"):
            self.integrated(self.waiting[1], tryout=True, hours=5)
            self.integrated(self.runs / "alpha" / "search" / "search-003", tryout=False, hours=0.5, fast_forward=False)
            self.refused()
        with self.subTest("a newer integrated run without a tryout clears its feature"):
            self.integrated(self.runs / "alpha" / "search" / "search-004", tryout=False, hours=0.2)
            self.launch()
        with self.subTest("a launch of a feature that asks for no tryout"):
            self.integrated(self.runs / "alpha" / "search" / "search-004", tryout=True, hours=0.2)
            self.refused()
            save_json(self.folder / "feature.json", {**self.manifest, "tryout": False})
            git(self.repo, "commit", "-qam", "No tryout")
            _, commands, _ = self.launch()
            self.assertNotIn("--tryout", commands[2])

    def test_a_recorded_verdict_clears_its_feature_whatever_it_says(self):
        for result in ("broken", "skipped"):
            with self.subTest(result=result):
                save_json(self.waiting[2] / "tryout.json", {"verdicts": [{"result": result, "note": None, "at": ago(0), "by": "operator"}]})
                self.launch()

    def test_a_verdict_on_an_older_run_leaves_a_newer_untried_run_counting(self):
        # The latest integrated run is the one whose `Fast-forwarded to` row is latest, not the one written to last: the tryout
        # row (and `automatic --live`'s action row) on an older run moves its last event, never its integration.
        older = self.integrated(self.runs / "alpha" / "search" / "search-001", hours=10)
        save_json(older / "tryout.json", {"verdicts": [{"result": "skipped", "note": None, "at": ago(0), "by": "operator"}]})
        with (older / "events.jsonl").open("a") as events:
            events.write(json.dumps({"sequence": 2, "time": ago(0), "node": "controller", "status": "note",
                                     "message": "Tryout recorded by the operator: skipped"}) + "\n")
        self.assertIn("alpha/search (run " + str(self.waiting[1]), self.refused())

    def test_a_continuation_still_launches(self):
        with self.subTest("a follow-up run"):
            _, commands, _ = self.launch(follows=str(self.waiting[0]))
            self.assertIn("--tryout", commands[2])
        with self.subTest("a run of a feature that is untried itself"):
            self.integrated(self.own_root / "board-001")
            _, commands, _ = self.launch("board-002")
            self.assertIn("--tryout", commands[0])

    def test_launch_passes_tryout_to_preflight_and_prepare_which_pins_it(self):
        save_json(self.waiting[0] / "tryout.json", {"verdicts": [{"result": "works", "note": None, "at": ago(0), "by": "operator"}]})
        run, commands, notes = self.launch()
        self.assertIn("--tryout", commands[0])
        self.assertIn("--tryout", commands[2])
        self.assertFalse([note for note in notes if "tryout" in note])
        subprocess.run(commands[1], cwd=self.repo, check=True, capture_output=True)
        result = subprocess.run(commands[2], cwd=TOOL, capture_output=True, text=True, timeout=120)
        self.assertEqual(result.returncode, 0, result.stderr)
        plan = read_json(run / "plan.json")
        self.assertIs(plan["tryout"], True)
        self.assertNotIn("allow_untried", plan)
        self.assertEqual(read_json(run / "run-state.json")["inputs"]["tryout"], {"required": True, "verdicts": []})

    def test_preflight_refuses_a_tryout_launch_past_the_limit_before_anything_else(self):
        _, commands, _ = self.launch(allow_untried="demo")  # The commands a launch past the limit would run, without the override.
        preflight = commands[0][:commands[0].index("--allow-untried")]
        result = subprocess.run(preflight, cwd=TOOL, capture_output=True, text=True, timeout=120)
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn("3 other features wait for your tryout", result.stderr)
        # The override passes this check (the rest of preflight then reads the real environment).
        self.assertIn("--allow-untried", commands[0])
        self.assertEqual(commands[0][commands[0].index("--by") + 1], "operator")

    def test_the_override_is_pinned_and_printed_and_refused_for_the_maintainer(self):
        run, commands, notes = self.launch(allow_untried="The demo is tomorrow")
        [note] = [note for note in notes if "untried" in note]
        self.assertIn("Launched past 3 untried features", note)
        self.assertIn("The demo is tomorrow", note)
        self.assertEqual(commands[2][commands[2].index("--allow-untried") + 1], "The demo is tomorrow")
        self.assertEqual(commands[2][commands[2].index("--by") + 1], "operator")
        code, output, errors = self.dry_run("--allow-untried", "The demo is tomorrow")
        self.assertEqual(code, 0, errors)
        self.assertIn(note, json.loads(output)["notes"])
        subprocess.run(commands[1], cwd=self.repo, check=True, capture_output=True)
        result = subprocess.run(commands[2], cwd=TOOL, capture_output=True, text=True, timeout=120)
        self.assertEqual(result.returncode, 0, result.stderr)
        pinned = read_json(run / "plan.json")["allow_untried"]
        self.assertEqual((pinned["reason"], pinned["by"]), ("The demo is tomorrow", "operator"))
        self.assertTrue(pinned["at"].endswith("Z"))
        status = subprocess.run([*commands[2][:3], "status", str(run)], cwd=TOOL, capture_output=True, text=True, timeout=120)
        self.assertEqual(status.returncode, 0, status.stderr)
        printed = json.loads(status.stdout.split("\nReport:")[0])
        self.assertEqual(printed["tryout"]["allow_untried"]["reason"], "The demo is tomorrow")
        self.assertEqual(read_json(run / "run-state.json")["inputs"]["tryout"]["allow_untried"]["reason"], "The demo is tomorrow")
        # The maintainer is refused at launch (its dry run too) and at prepare and preflight.
        code, _, errors = self.dry_run("--allow-untried", "x", "--by", "maintainer")
        self.assertEqual(code, 1)
        self.assertIn("--by maintainer is refused", errors)
        for action in ("prepare", "preflight"):
            with self.subTest(action=action):
                argv = [*commands[2][:3], action, str(self.root / "other-run"), "--repo", str(self.repo), "--tryout", "--allow-untried", "x", "--by", "maintainer"]
                result = subprocess.run(argv, cwd=TOOL, capture_output=True, text=True, timeout=120)
                self.assertEqual(result.returncode, 1, result.stderr)
                self.assertIn("--allow-untried is the operator's decision: --by maintainer is refused", result.stderr)
                self.assertFalse((self.root / "other-run").exists())


class TryoutFlag(unittest.TestCase):
    """C7: feature.json 2.4.0's optional `tryout`; a feature with a browser check that leaves it out gets a note."""

    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.repo = fixture_target(self.root)
        environment = patch.dict(os.environ, {"MD_MANAGER_PROJECTS_CONFIG": str(self.root / "projects.json"), "HOME": str(self.root / "home")})
        environment.start()
        self.addCleanup(environment.stop)

    def test_a_feature_with_a_browser_check_that_leaves_the_flag_out_gets_the_note(self):
        _, commands, notes = launch_commands(self.repo, "project-workflows", "project-workflows-001", self.root / "runs", herdr=False)
        [note] = [note for note in notes if "tryout" in note]
        self.assertIn("ui has a browser check", note)
        self.assertIn('"tryout": true', note)
        self.assertNotIn("--tryout", commands[2])
        # A lane subset without the browser check gets none.
        _, _, notes = launch_commands(self.repo, "project-workflows", "project-workflows-002", self.root / "runs", herdr=False, workers="adapter")
        self.assertFalse([note for note in notes if "tryout" in note])

    def test_tryout_needs_2_4_0(self):
        from .launch import load_feature
        folder = self.repo / "features/project-workflows"
        save_json(folder / "feature.json", {**read_json(folder / "feature.json"), "tryout": True})
        with self.assertRaisesRegex(ValueError, "feature.json tryout needs version 2.4.0"):
            load_feature(folder)


if __name__ == "__main__":
    unittest.main()
