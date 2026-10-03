"""Worktree changes one at a time per repository (the `git worktree add` race when lanes verify at the same moment), and
the controller's own Git calls against a shared .git a lane may have changed (C25).

Real temporary repositories, real Git, threads and separate processes; nothing touches the user's state.
"""
import contextlib
import hashlib
import io
import json
import os
import re
import shlex
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from .sessions import claude_env, git, prepare, read_json, save_json
from .worktrees import (ATTEMPTS, BACKOFF_SECONDS, LOCK_NAME, WorktreeError, controller_git_config, entry_digest, git_config_entries, git_worktree,
                        shared_git_changes, shared_git_state, without_controller_git_config, worktree_lock)

TOOL = Path(__file__).resolve().parents[1]
# A separate process adding one worktree once its stdin closes, so the test can release every child at once.
CHILD = "import sys; from workflow.worktrees import git_worktree; sys.stdin.read(); git_worktree(sys.argv[1], 'add', '--detach', sys.argv[2], 'HEAD')"


class Repository(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name).resolve()
        self.repo = self.root / "repo"
        self.repo.mkdir()
        subprocess.run(["git", "init", "-q", str(self.repo)], check=True)
        (self.repo / "README.md").write_text("Base\n")
        subprocess.run(["git", "-C", str(self.repo), "add", "."], check=True)
        subprocess.run(["git", "-C", str(self.repo), "-c", "user.email=test@example.invalid", "-c", "user.name=Test",
                        "commit", "-qm", "Base"], check=True)

    def registered(self) -> set[str]:
        listing = subprocess.check_output(["git", "-C", str(self.repo), "worktree", "list", "--porcelain"], text=True)
        return {line.removeprefix("worktree ") for line in listing.splitlines() if line.startswith("worktree ")}

    def child(self, path: Path, repo: Path | None = None, stdin=subprocess.PIPE) -> subprocess.Popen:
        log = (self.root / f"{path.parent.name}.log").open("w")
        self.addCleanup(log.close)
        return subprocess.Popen([sys.executable, "-c", CHILD, str(repo or self.repo), str(path)], cwd=TOOL,
                                stdin=stdin, stdout=log, stderr=subprocess.STDOUT, text=True)

    def log(self, path: Path) -> str:
        return (self.root / f"{path.parent.name}.log").read_text()


class ConcurrentWorktrees(Repository):
    def test_threads_and_processes_adding_at_once_all_register(self):
        # Every path ends in `worktree`, like the verification worktrees, so Git picks numbered ids for all but one.
        paths = [self.root / f"verification-{index}" / "worktree" for index in range(12)]
        for path in paths:
            path.parent.mkdir()
        go, errors = threading.Event(), []

        def add(path):
            go.wait()
            try:
                git_worktree(self.repo, "add", "--detach", str(path), "HEAD")
            except Exception as error:  # Reported below with the failing path.
                errors.append((path, error))

        threads = [threading.Thread(target=add, args=(path,)) for path in paths[:6]]
        children = {path: self.child(path) for path in paths[6:]}
        for thread in threads:
            thread.start()
        go.set()
        for child in children.values():
            child.stdin.close()
        for thread in threads:
            thread.join(30)
        for path, child in children.items():
            self.assertEqual(child.wait(30), 0, self.log(path))
        self.assertEqual(errors, [])
        self.assertLessEqual({str(path) for path in paths}, self.registered())
        base = subprocess.check_output(["git", "-C", str(self.repo), "rev-parse", "HEAD"], text=True).strip()
        for path in paths:
            self.assertEqual(subprocess.check_output(["git", "-C", str(path), "rev-parse", "HEAD"], text=True).strip(), base)
        # One lock file for the repository, in its common Git directory.
        self.assertTrue((self.repo / ".git" / LOCK_NAME).is_file())

    def test_a_held_lock_blocks_other_threads_and_processes_until_released(self):
        threaded, spawned = self.root / "threaded" / "worktree", self.root / "spawned" / "worktree"
        for path in (threaded, spawned):
            path.parent.mkdir()
        with worktree_lock(self.repo):
            thread = threading.Thread(target=git_worktree, args=(self.repo, "add", "--detach", str(threaded), "HEAD"))
            thread.start()
            child = self.child(spawned, stdin=subprocess.DEVNULL)
            time.sleep(0.5)
            self.assertTrue(thread.is_alive())
            self.assertIsNone(child.poll())
            self.assertFalse(threaded.exists() or spawned.exists())
        thread.join(10)
        self.assertEqual(child.wait(10), 0, self.log(spawned))
        self.assertLessEqual({str(threaded), str(spawned)}, self.registered())

    def test_linked_worktrees_of_one_repository_share_the_lock(self):
        linked = self.root / "linked"
        git_worktree(self.repo, "add", "--detach", str(linked), "HEAD")
        path = self.root / "through-main" / "worktree"
        path.parent.mkdir()
        # Held through the linked worktree, it still blocks an add issued through the main checkout.
        with worktree_lock(linked):
            thread = threading.Thread(target=git_worktree, args=(self.repo, "add", "--detach", str(path), "HEAD"))
            thread.start()
            time.sleep(0.3)
            self.assertTrue(thread.is_alive())
        thread.join(10)
        self.assertIn(str(path), self.registered())
        self.assertFalse((linked / LOCK_NAME).exists())


class LockContention(Repository):
    def setUp(self):
        super().setUp()
        # Git's own ref lock, as left by another process: `add -b lane` cannot create the branch while it exists.
        self.ref_lock = self.repo / ".git" / "refs" / "heads" / "lane.lock"
        self.ref_lock.touch()
        self.path = self.root / "lane"

    def test_contention_is_retried_after_a_backoff(self):
        with patch("workflow.worktrees.time.sleep", side_effect=lambda seconds: self.ref_lock.unlink()) as sleep:
            git_worktree(self.repo, "add", "-b", "lane", str(self.path), "HEAD")
        self.assertEqual(sleep.call_count, 1)
        self.assertIn(str(self.path), self.registered())

    def test_persistent_contention_raises_with_git_stderr(self):
        with patch("workflow.worktrees.time.sleep") as sleep, self.assertRaises(WorktreeError) as raised:
            git_worktree(self.repo, "add", "-b", "lane", str(self.path), "HEAD")
        self.assertEqual([call.args[0] for call in sleep.call_args_list],
                         [BACKOFF_SECONDS * 2 ** attempt for attempt in range(ATTEMPTS - 1)])
        self.assertIn("lane.lock': File exists", str(raised.exception))
        self.assertIsInstance(raised.exception, subprocess.CalledProcessError)  # Call sites keep check=True semantics.
        self.assertNotIn(str(self.path), self.registered())

    def test_other_failures_raise_at_once_with_git_stderr(self):
        with patch("workflow.worktrees.time.sleep") as sleep, self.assertRaises(WorktreeError) as raised:
            git_worktree(self.repo, "add", "--detach", str(self.path), "no-such-revision")
        sleep.assert_not_called()
        self.assertIn("no-such-revision", str(raised.exception).splitlines()[-1])
        with self.assertRaisesRegex(ValueError, "Not a worktree change"):
            git_worktree(self.repo, "list")


class WorktreeCallSites(Repository):
    def test_every_worktree_change_under_workflow_takes_the_lock(self):
        unlocked = [source.name for source in sorted((TOOL / "workflow").glob("*.py"))
                    if not source.name.startswith("test_") and source.name != "worktrees.py"
                    and re.search(r'"worktree",\s*"(?:add|move|prune|remove|repair)"', source.read_text())]
        self.assertEqual(unlocked, [])

    def test_prepare_waits_for_the_lock(self):
        directory, plans = self.root / "run", []
        with worktree_lock(self.repo):
            thread = threading.Thread(target=lambda: plans.append(prepare(directory, self.repo, "HEAD", {"ui": "Read UI"}, False)))
            thread.start()
            time.sleep(0.3)
            self.assertTrue(thread.is_alive())
            self.assertFalse((directory / "worktree-ui").exists())
        thread.join(10)
        self.assertEqual(plans[0]["nodes"]["ui"]["observed_start_commit"], plans[0]["base_commit"])

    def test_every_diff_writer_turns_off_external_diff_drivers_and_textconv(self):
        # A diff.external or textconv driver planted in the shared .git would otherwise rewrite review.diff, a lane's patch,
        # a repair's diff or the sidecar's inputs. Only a names-only diff runs neither.
        writers, unsafe = set(), []
        for source in sorted((TOOL / "workflow").glob("*.py")):
            if source.name.startswith("test_"):
                continue
            for number, line in enumerate(source.read_text().splitlines(), 1):
                if '"diff",' not in line or '"--name-only"' in line:
                    continue
                writers.add(source.name)
                if '"--no-ext-diff"' not in line or '"--no-textconv"' not in line:
                    unsafe.append(f"{source.name}:{number}")
        self.assertEqual(unsafe, [])
        self.assertLessEqual({"automatic.py", "sessions.py", "repair.py", "sidecar.py"}, writers)  # The scan finds the known writers.


def without_git_config(environment: dict) -> dict:
    """`environment` with no GIT_CONFIG_* entry at all, as a shell outside the controller has (the test runner may run under one)."""
    return {key: value for key, value in environment.items() if not key.startswith("GIT_CONFIG")}


class ControllerGitConfig(Repository):
    """Hooks and fsmonitor are off for the controller's own Git calls (GIT_CONFIG_* set at `python -m workflow` entry), and
    on again for Claude sessions and the checks, which run the target's code as written."""

    def plant(self) -> tuple[Path, Path]:
        """A post-checkout hook and an fsmonitor command in the shared .git, each leaving a marker when it runs."""
        hook_marker, monitor_marker = self.root / "hook-ran", self.root / "fsmonitor-ran"
        hook = self.repo / ".git" / "hooks" / "post-checkout"
        hook.write_text(f"#!/bin/sh\ntouch {shlex.quote(str(hook_marker))}\n")
        hook.chmod(0o755)
        monitor = self.root / "fsmonitor.sh"
        monitor.write_text(f"#!/bin/sh\ntouch {shlex.quote(str(monitor_marker))}\n")
        monitor.chmod(0o755)
        subprocess.run(["git", "-C", str(self.repo), "config", "core.fsmonitor", str(monitor)], check=True)
        return hook_marker, monitor_marker

    def policy(self) -> dict:
        probe = ("import json, os\nprint('GIT ' + json.dumps(sorted(key for key in os.environ if key.startswith('GIT_CONFIG'))))\n"
                 "print('Ran 1 test in 0.001s\\n\\nOK')\n")
        return {"version": "1.0.0", "feature": "Planted hooks", "independent_review": True, "integration_approval": True,
                "workers": [{"node_id": "ui", "role": "backend", "owned_paths": ["README.md"],
                             "checks": [{"id": "unit", "kind": "unit", "argv": [sys.executable, "-c", probe], "timeout_seconds": 60, "scenarios": []}]}]}

    def test_a_planted_hook_and_fsmonitor_run_in_neither_prepare_nor_verify(self):
        from .checks import verify_revision
        hook_marker, monitor_marker = self.plant()
        bare = without_git_config(os.environ)
        # What the shared .git now does to any Git command: `git status` runs the monitor, a checkout runs the hook.
        subprocess.run(["git", "-C", str(self.repo), "status", "--porcelain"], env=bare, check=True, capture_output=True)
        subprocess.run(["git", "-C", str(self.repo), "worktree", "add", "--detach", str(self.root / "probe"), "HEAD"], env=bare, check=True, capture_output=True)
        self.assertTrue(hook_marker.exists() and monitor_marker.exists())
        hook_marker.unlink()
        monitor_marker.unlink()
        # `python -m workflow prepare`: status checks and `git worktree add` through the controller's own entry point.
        policy, task, run = self.root / "policy.json", self.root / "ui-task.md", self.root / "run"
        save_json(policy, self.policy())
        task.write_text("Change the README.\n")
        result = subprocess.run([sys.executable, "-m", "workflow", "prepare", str(run), "--repo", str(self.repo), "--policy", str(policy), "--task", f"ui={task}"],
                                cwd=TOOL, capture_output=True, text=True, timeout=120,
                                env={**bare, "MD_MANAGER_PROJECTS_CONFIG": str(self.root / "config" / "projects.json")})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((hook_marker.exists(), monitor_marker.exists()), (False, False))
        # The verifier's worktree add and cleanliness checks, in a controller process; the check itself sees no GIT_CONFIG_*.
        plan = read_json(run / "plan.json")
        with patch.dict(os.environ, clear=True):
            os.environ.update(bare)
            controller_git_config(os.environ)
            packet = verify_revision(run, plan, self.policy(), "ui", plan["base_commit"], [], "session")
        self.assertEqual(packet["gate"]["status"], "passed", packet["gate"]["reasons"])
        self.assertEqual((hook_marker.exists(), monitor_marker.exists()), (False, False))
        log = Path(packet["artifact_paths"][packet["result"]["checks"][0]["log_artifact_id"]]).read_text()
        self.assertIn("GIT []\n", log)

    def test_sessions_and_checks_inherit_none_of_it_while_the_controllers_git_calls_do(self):
        from .checks import check_environment
        bare = without_git_config(os.environ)
        operator = {"GIT_CONFIG_COUNT": "1", "GIT_CONFIG_KEY_0": "user.name", "GIT_CONFIG_VALUE_0": "Operator"}
        ours = {"GIT_CONFIG_KEY_1": "core.hooksPath", "GIT_CONFIG_VALUE_1": "/dev/null", "GIT_CONFIG_KEY_2": "core.fsmonitor", "GIT_CONFIG_VALUE_2": "false"}
        with patch.dict(os.environ, clear=True):
            os.environ.update({**bare, **operator})
            controller_git_config(os.environ)
            controller_git_config(os.environ)  # A child controller (automatic-step) inherits the entries: never added twice.
            self.assertEqual({key: value for key, value in os.environ.items() if key.startswith("GIT_CONFIG")}, {**operator, **ours, "GIT_CONFIG_COUNT": "3"})
            # The controller's own Git calls inherit them; the operator's own entry still applies.
            self.assertEqual(git(self.repo, "config", "--show-scope", "--get", "core.hooksPath"), "command\t/dev/null")
            self.assertEqual(git(self.repo, "config", "--get", "core.fsmonitor"), "false")
            self.assertEqual(git(self.repo, "config", "--get", "user.name"), "Operator")
            # Claude processes (and so Claude Code's shared background service) and the checks get exactly the operator's.
            for environment in (claude_env(), claude_env(dict(os.environ)), check_environment(os.environ)[0]):
                self.assertEqual({key: value for key, value in environment.items() if key.startswith("GIT_CONFIG")}, operator)
            # A copy without exactly those entries; the controller keeps its own.
            self.assertEqual(without_controller_git_config(os.environ), {**bare, **operator})
            self.assertEqual(os.environ["GIT_CONFIG_COUNT"], "3")
        with patch.dict(os.environ, clear=True):
            os.environ.update(bare)
            controller_git_config(os.environ)
            self.assertEqual(os.environ["GIT_CONFIG_COUNT"], "2")
            for environment in (claude_env(), check_environment(os.environ)[0]):
                self.assertEqual([key for key in environment if key.startswith("GIT_CONFIG")], [])
        # An unreadable count is left as it is: Git refuses every command then, so nothing runs a hook either.
        self.assertEqual(without_controller_git_config({"GIT_CONFIG_COUNT": "x"}), {"GIT_CONFIG_COUNT": "x"})
        bogus = {"GIT_CONFIG_COUNT": "x"}
        controller_git_config(bogus)
        self.assertEqual(bogus, {"GIT_CONFIG_COUNT": "x"})

    def test_the_count_is_read_as_git_reads_it(self):
        # Git reads GIT_CONFIG_COUNT with strtoul: an empty count is 0, and white space and a sign may lead the digits. It
        # refuses anything after the digits, a space or a sign with no digits, a negative or too large count and a declared
        # entry that is missing, and then runs no command at all. Only then does the controller add nothing.
        bare = without_git_config(os.environ)
        operator = {"GIT_CONFIG_KEY_0": "user.name", "GIT_CONFIG_VALUE_0": "Operator"}
        counts = ["", "0", "+0", "-0", " -0", "1", "01", " 1", "+1", " +1", "\t1", "\n\v\f\r 1", " ", "+", "-", "- 1", "1 ", "0x1", "x", "-1",
                  "2", "2147483647", "2147483648", "99999999999999999999"]
        cases = [{**operator, "GIT_CONFIG_COUNT": count} for count in counts] + [{"GIT_CONFIG_COUNT": "1", "GIT_CONFIG_KEY_0": "user.name"}]
        for case in cases:
            with self.subTest(case=case):
                shown = subprocess.run(["git", "-C", str(self.repo), "config", "--show-scope", "--get", "user.name"], env={**bare, **case},
                                       capture_output=True, text=True)
                refused, applied = shown.returncode == 128, shown.stdout.startswith("command\t")
                self.assertEqual(git_config_entries(case), None if refused else [("user.name", "Operator")] if applied else [], shown.stderr)

    def test_an_empty_or_padded_count_takes_the_entries_after_it_and_is_written_plain(self):
        # A shell's `export GIT_CONFIG_COUNT=` leaves Git reading no entry: hooks and fsmonitor go off all the same.
        from .checks import check_environment
        bare = without_git_config(os.environ)
        operator = {"GIT_CONFIG_KEY_0": "user.name", "GIT_CONFIG_VALUE_0": "Operator"}
        for count, before, after in (("", {}, {}), (" +1", operator, {"GIT_CONFIG_COUNT": "1", **operator})):
            with self.subTest(count=count), patch.dict(os.environ, clear=True):
                os.environ.update({**bare, **before, "GIT_CONFIG_COUNT": count})
                controller_git_config(os.environ)
                first = len(before) // 2
                self.assertEqual({key: value for key, value in os.environ.items() if key.startswith("GIT_CONFIG")},
                                 {**before, "GIT_CONFIG_COUNT": str(first + 2), f"GIT_CONFIG_KEY_{first}": "core.hooksPath",
                                  f"GIT_CONFIG_VALUE_{first}": "/dev/null", f"GIT_CONFIG_KEY_{first + 1}": "core.fsmonitor",
                                  f"GIT_CONFIG_VALUE_{first + 1}": "false"})
                self.assertEqual(git(self.repo, "config", "--show-scope", "--get", "core.hooksPath"), "command\t/dev/null")
                for environment in (claude_env(), check_environment(os.environ)[0]):
                    self.assertEqual({key: value for key, value in environment.items() if key.startswith("GIT_CONFIG")}, after)

    def test_the_pipeline_and_launch_modules_add_them_as_python_m_workflow_does(self):
        # `python -m workflow.pipeline ...` and `python -m workflow.launch ...` start without `python -m workflow`'s entry,
        # so their main() adds the entries too (once: a controller that another one starts inherits them).
        from . import launch, pipeline
        bare = without_git_config(os.environ)
        ours = {"GIT_CONFIG_COUNT": "2", "GIT_CONFIG_KEY_0": "core.hooksPath", "GIT_CONFIG_VALUE_0": "/dev/null",
                "GIT_CONFIG_KEY_1": "core.fsmonitor", "GIT_CONFIG_VALUE_1": "false"}
        for name, main in (("pipeline", pipeline.main), ("launch", launch.main)):
            with self.subTest(name), patch.dict(os.environ, clear=True), patch.object(sys, "argv", [name, "--help"]), \
                    contextlib.redirect_stdout(io.StringIO()):
                os.environ.update(bare)
                with self.assertRaises(SystemExit):
                    main()
                self.assertEqual({key: value for key, value in os.environ.items() if key.startswith("GIT_CONFIG")}, ours)
        # A prepare through `python -m workflow.pipeline` runs neither the planted hook nor the monitor.
        hook_marker, monitor_marker = self.plant()
        policy, task, run = self.root / "policy.json", self.root / "ui-task.md", self.root / "run"
        save_json(policy, self.policy())
        task.write_text("Change the README.\n")
        result = subprocess.run([sys.executable, "-m", "workflow.pipeline", "prepare", str(run), "--repo", str(self.repo), "--policy", str(policy),
                                 "--task", f"ui={task}"], cwd=TOOL, capture_output=True, text=True, timeout=120,
                                env={**bare, "MD_MANAGER_PROJECTS_CONFIG": str(self.root / "config" / "projects.json")})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((hook_marker.exists(), monitor_marker.exists()), (False, False))


class SharedGitDigest(Repository):
    """What prepare records of the shared .git and what freeze, review and integrate name when it changed."""

    def test_command_capable_keys_and_files_are_named_and_others_are_not(self):
        hooks = self.repo / ".git" / "hooks"
        hooks.mkdir(exist_ok=True)
        (hooks / "post-merge").write_text("#!/bin/sh\nexit 0\n")
        (hooks / "post-merge").chmod(0o755)
        (self.repo / ".git" / "info").mkdir(exist_ok=True)
        (self.repo / ".git" / "info" / "exclude").write_text("# git ls-files --others --exclude-from=.git/info/exclude\n")
        before = shared_git_state(self.repo)
        self.assertLessEqual({"hooks/post-merge", "info/exclude"}, set(before))
        self.assertNotIn("info/attributes", before)
        # The controller's own entries (command scope) are never part of it, nor is a key that runs nothing.
        with patch.dict(os.environ):
            controller_git_config(os.environ)
            self.assertEqual(shared_git_state(self.repo), before)
        git(self.repo, "config", "user.name", "Someone else")
        self.assertEqual(shared_git_changes(before, shared_git_state(self.repo)), [])
        # A planted key, by scope; a credential inside a URL never reaches the record or the name.
        git(self.repo, "config", "url.https://user:s3cret@example.invalid/.insteadOf", "https://example.invalid/")
        git(self.repo, "config", "diff.planted.textconv", "cat")
        (self.repo / ".git" / "info" / "attributes").write_text("*.md -diff\n")
        (self.repo / ".git" / "info" / "exclude").write_text("planted.txt\n")
        (hooks / "pre-push").write_text("#!/bin/sh\nexit 0\n")
        (hooks / "post-merge").chmod(0o644)  # A hook switched off (or on) is a change too.
        after = shared_git_state(self.repo)
        self.assertEqual(shared_git_changes(before, after),
                         ["hooks/post-merge", "hooks/pre-push", "info/attributes", "info/exclude", "local diff.planted.textconv",
                          "local url.https://<redacted>@example.invalid/.insteadof"])
        self.assertNotIn("s3cret", json.dumps(after))
        self.assertEqual(shared_git_changes(after, after), [])
        # A removed file is named as well.
        (self.repo / ".git" / "info" / "exclude").unlink()
        self.assertIn("info/exclude", shared_git_changes(after, shared_git_state(self.repo)))

    def test_a_worktrees_copy_of_the_main_worktree_config_is_no_change(self):
        # With extensions.worktreeConfig, `git worktree add` copies the main worktree's config.worktree into the new one:
        # the verification and candidate worktrees a run adds are not a change; an edited lane copy is.
        git(self.repo, "config", "extensions.worktreeConfig", "true")
        git(self.repo, "config", "--worktree", "core.sparseCheckout", "false")
        lane = self.root / "lane"
        git_worktree(self.repo, "add", "--detach", str(lane), "HEAD")
        before = shared_git_state(self.repo)
        self.assertIn("worktrees/lane/config.worktree", before)
        git_worktree(self.repo, "add", "--detach", str(self.root / "verification" / "worktree"), "HEAD")
        after = shared_git_state(self.repo)
        self.assertIn("worktrees/worktree/config.worktree", after)
        self.assertEqual(shared_git_changes(before, after), [])
        with (self.repo / ".git" / "worktrees" / "lane" / "config.worktree").open("a") as handle:
            handle.write("[core]\n\tfsmonitor = /tmp/planted\n")
        self.assertEqual(shared_git_changes(before, shared_git_state(self.repo)), ["worktrees/lane/config.worktree"])

    def test_a_removed_worktree_or_a_reused_id_holding_a_known_copy_is_no_change(self):
        # A worktree that another run on this .git removes runs nothing any more, and an id that run reuses holds the copy
        # `git worktree add` makes of the main worktree's config.worktree.
        git(self.repo, "config", "extensions.worktreeConfig", "true")
        git(self.repo, "config", "--worktree", "core.sparseCheckout", "false")
        old, gone = self.root / "old" / "lane", self.root / "gone"
        for path in (old, gone):
            git_worktree(self.repo, "add", "--detach", str(path), "HEAD")
        git(self.repo, "config", "--worktree", "core.sparseCheckoutCone", "false")  # The main worktree's copy changes after them.
        before = shared_git_state(self.repo)
        self.assertNotEqual(before["worktrees/lane/config.worktree"], before["config.worktree"])
        for path in (gone, old):
            git_worktree(self.repo, "remove", str(path))
        git_worktree(self.repo, "add", "--detach", str(self.root / "new" / "lane"), "HEAD")
        after = shared_git_state(self.repo)
        self.assertNotIn("worktrees/gone/config.worktree", after)
        self.assertEqual(after["worktrees/lane/config.worktree"], before["config.worktree"])
        self.assertEqual(shared_git_changes(before, after), [])

    def test_a_fifo_is_named_by_its_kind_and_never_read(self):
        # Opening a FIFO waits for a writer: read, a FIFO planted in hooks/ (or in place of info/exclude) would hang freeze,
        # the review node and integrate. Each entry is looked at with one lstat, and only a regular file is opened.
        hooks, exclude = self.repo / ".git" / "hooks", self.repo / ".git" / "info" / "exclude"
        before = shared_git_state(self.repo)
        self.assertIn("info/exclude", before)
        os.mkfifo(hooks / "planted")
        exclude.unlink()
        os.mkfifo(exclude)
        states = []
        thread = threading.Thread(target=lambda: states.append(shared_git_state(self.repo)), daemon=True)
        thread.start()
        thread.join(10)
        hung = thread.is_alive()
        for _ in range(20):  # A failing run leaves a reader waiting on each FIFO in turn: release them, so the suite goes on.
            if not thread.is_alive():
                break
            for fifo in (hooks / "planted", exclude):
                with contextlib.suppress(OSError):  # No reader waits on this one yet.
                    os.close(os.open(fifo, os.O_WRONLY | os.O_NONBLOCK))
            thread.join(0.5)
        self.assertFalse(hung, "shared_git_state waited on a FIFO")
        self.assertEqual(shared_git_changes(before, states[0]), ["hooks/planted", "info/exclude"])
        self.assertEqual(entry_digest(exclude), hashlib.sha256(b"fifo").hexdigest())

    def test_a_file_is_read_in_chunks_up_to_a_cap(self):
        # Under the cap a file's digest is the one prepare has always recorded (whether it is executable, then its bytes), so
        # a run prepared before compares as it did. Past the cap its size and modification time stand in for the rest.
        exclude, hook = self.repo / ".git" / "info" / "exclude", self.repo / ".git" / "hooks" / "post-merge"
        exclude.write_bytes(b"x" * 40)
        hook.write_bytes(b"#!/bin/sh\nexit 0\n")
        hook.chmod(0o755)
        self.assertEqual(entry_digest(exclude), hashlib.sha256(b"file:" + b"x" * 40).hexdigest())
        self.assertEqual(entry_digest(hook), hashlib.sha256(b"executable:#!/bin/sh\nexit 0\n").hexdigest())
        with patch("workflow.worktrees.DIGEST_LIMIT", 16), patch("workflow.worktrees.DIGEST_CHUNK", 5):
            self.assertNotEqual(entry_digest(hook), hashlib.sha256(b"executable:#!/bin/sh\nexit 0\n").hexdigest())  # 17 bytes: one past.
            before, times = entry_digest(exclude), exclude.stat()

            def rewrite(data: bytes) -> str:
                exclude.write_bytes(data)
                os.utime(exclude, ns=(times.st_atime_ns, times.st_mtime_ns))
                return entry_digest(exclude)

            self.assertEqual(rewrite(b"x" * 16 + b"y" * 24), before)  # The same size and time: bytes past the cap are not read.
            self.assertNotEqual(rewrite(b"x" * 16 + b"y" * 25), before)
            self.assertNotEqual(rewrite(b"x" * 15 + b"z" + b"x" * 24), before)
            self.assertEqual(rewrite(b"x" * 16), hashlib.sha256(b"file:" + b"x" * 16).hexdigest())  # Exactly the cap: read whole.

    def test_the_global_attributes_file_and_the_xdg_git_config_are_watched(self):
        # Outside the .git, the controller's Git calls read the global attributes file (core.attributesFile, else
        # $XDG_CONFIG_HOME/git/attributes or ~/.config/git/attributes) and ~/.config/git/config beside ~/.gitconfig. A worker's
        # Edit is denied there, a Bash `echo` is not: `* -diff` would turn every file of review.diff into a binary patch.
        home = self.root / "home"
        home.mkdir()
        environment = {key: value for key, value in os.environ.items() if key != "XDG_CONFIG_HOME"}
        with patch.dict(os.environ, {**environment, "HOME": str(home)}, clear=True):
            before = shared_git_state(self.repo)
            xdg = home / ".config" / "git"
            xdg.mkdir(parents=True)
            (xdg / "attributes").write_text("* -diff\n")
            (xdg / "config").write_text("[core]\n\tpager = planted\n")  # A key the config digest does not watch.
            after = shared_git_state(self.repo)
            self.assertEqual(shared_git_changes(before, after), ["~/.config/git/attributes", "~/.config/git/config"])
            # core.attributesFile, when set, names the file Git reads instead, with `~/` expanded as Git does.
            (home / "planted.attributes").write_text("* -diff\n")
            git(self.repo, "config", "core.attributesFile", "~/planted.attributes")
            moved = shared_git_state(self.repo)
            self.assertEqual(shared_git_changes(after, moved), ["local core.attributesfile", "~/.config/git/attributes", "~/planted.attributes"])
            (home / "planted.attributes").write_text("*.md -diff\n")
            self.assertEqual(shared_git_changes(moved, shared_git_state(self.repo)), ["~/planted.attributes"])
            # XDG_CONFIG_HOME moves the default files, as it does for Git.
            git(self.repo, "config", "--unset", "core.attributesFile")
            os.environ["XDG_CONFIG_HOME"] = str(self.root / "xdg")
            moved = shared_git_state(self.repo)
            (self.root / "xdg" / "git").mkdir(parents=True)
            (self.root / "xdg" / "git" / "attributes").write_text("* -diff\n")
            (self.root / "xdg" / "git" / "config").write_text("[core]\n\tpager = planted\n")
            self.assertEqual(shared_git_changes(moved, shared_git_state(self.repo)), [f"{self.root}/xdg/git/attributes", f"{self.root}/xdg/git/config"])


if __name__ == "__main__":
    unittest.main()
