"""Worktree changes one at a time per repository (the `git worktree add` race when lanes verify at the same moment).

Real temporary repositories, real Git, threads and separate processes; nothing touches the user's state.
"""
import re
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from .sessions import prepare
from .worktrees import ATTEMPTS, BACKOFF_SECONDS, LOCK_NAME, WorktreeError, git_worktree, worktree_lock

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


if __name__ == "__main__":
    unittest.main()
