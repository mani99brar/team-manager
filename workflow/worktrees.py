"""`git worktree` changes, one at a time per repository.

Git does not serialise worktree administration: two `git worktree add` in one repository can read each other's
half-written `.git/worktrees/<id>/` and die (`failed to read .../commondir`), which lanes verifying at the same
moment hit. Every worktree add, move, prune, remove and repair under workflow/ goes through git_worktree.
"""
from __future__ import annotations

import fcntl
import re
import subprocess
import time
from contextlib import contextmanager
from pathlib import Path

# Kept in the repository's common Git directory, so every linked worktree of one repository shares it.
LOCK_NAME = "workflow-worktree.lock"
CHANGES = frozenset({"add", "move", "prune", "remove", "repair"})
ATTEMPTS = 5
BACKOFF_SECONDS = 0.25
# One of Git's own lock files is held by a process outside the controller (an operator's git, a crashed git).
CONTENTION = re.compile(r"could not lock|cannot lock|\.lock': File exists|is locked")


class WorktreeError(subprocess.CalledProcessError):
    """A failed `git worktree` command. Unlike CalledProcessError's, its message carries Git's stderr."""

    def __str__(self) -> str:
        return f"{super().__str__()}\n{self.stderr.strip()}"


def common_dir(repository) -> Path:
    output = subprocess.check_output(["git", "-C", str(repository), "rev-parse", "--git-common-dir"], text=True).strip()
    return Path(repository, output).resolve()  # Git prints it relative to the repository unless it is elsewhere.


@contextmanager
def worktree_lock(repository):
    """Exclusive across processes and threads: every holder opens its own descriptor, and flock locks belong to it."""
    with (common_dir(repository) / LOCK_NAME).open("a") as handle:
        fcntl.flock(handle, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(handle, fcntl.LOCK_UN)


def git_worktree(repository, *arguments: str) -> str:
    """`git -C <repository> worktree <arguments>` under the repository's worktree lock; returns its stdout.

    A failure naming one of Git's lock files is retried, ATTEMPTS times in all with a doubling backoff. Any
    other failure, or the last attempt's, raises WorktreeError.
    """
    if not arguments or arguments[0] not in CHANGES:
        raise ValueError(f"Not a worktree change: git worktree {' '.join(arguments)}")
    command = ["git", "-C", str(repository), "worktree", *arguments]
    with worktree_lock(repository):
        for attempt in range(ATTEMPTS):
            result = subprocess.run(command, capture_output=True, text=True)
            if result.returncode == 0:
                return result.stdout.strip()
            if attempt == ATTEMPTS - 1 or not CONTENTION.search(result.stderr):
                raise WorktreeError(result.returncode, command, result.stdout, result.stderr)
            time.sleep(BACKOFF_SECONDS * 2 ** attempt)
