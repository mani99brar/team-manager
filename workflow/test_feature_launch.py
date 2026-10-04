import contextlib
import fcntl
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
from .guardrails import LAUNCH_NOTE_ENV
from .launch import launch_commands, main
from .sessions import save_json
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
                      f"{branch}. Once the run is finished, remove its source checkout: git -C {self.repo} worktree remove {source}", output.getvalue())

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
