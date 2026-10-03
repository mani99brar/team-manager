"""`git worktree` changes, one at a time per repository, and the controller's own Git calls against a shared .git.

Git does not serialise worktree administration: two `git worktree add` in one repository can read each other's
half-written `.git/worktrees/<id>/` and die (`failed to read .../commondir`), which lanes verifying at the same
moment hit. Every worktree add, move, prune, remove and repair under workflow/ goes through git_worktree.

Every lane worktree shares the repository's .git, so what a lane plants there (a hook, an fsmonitor command, a filter
or diff driver, an attributes line) reaches the controller's own Git calls. `python -m workflow` turns hooks and
fsmonitor off for all of them (controller_git_config); Claude sessions and checks run without that, as the target's
code expects (without_controller_git_config). prepare records shared_git_record, and freeze, review and integrate
report what changed since: a tripwire and a warning, never a refusal and never a boundary.
"""
from __future__ import annotations

import fcntl
import hashlib
import json
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


# What `python -m workflow` adds to its own environment, after any GIT_CONFIG_<n> entries already there, so that every Git
# command the controller runs (a worktree add, a status, freeze's `git add -A`) runs no hook and no fsmonitor command.
CONTROLLER_GIT_CONFIG = (("core.hooksPath", "/dev/null"), ("core.fsmonitor", "false"))


def git_config_entries(env) -> list[tuple] | None:
    """The (key, value) entries GIT_CONFIG_COUNT declares in `env`: [] without a count, None for a count Git refuses."""
    count = env.get("GIT_CONFIG_COUNT")
    if count is None:
        return []
    if not re.fullmatch(r"[0-9]+", count):
        return None
    return [(env.get(f"GIT_CONFIG_KEY_{index}"), env.get(f"GIT_CONFIG_VALUE_{index}")) for index in range(int(count))]


def controller_git_config(env) -> None:
    """Add CONTROLLER_GIT_CONFIG to `env` (os.environ, at controller entry) after the entries it already has, extending
    GIT_CONFIG_COUNT. Once only: a controller another one starts (automatic-step, launch's steps) inherits them. A count
    Git refuses is left as it is; Git then runs nothing at all."""
    entries = git_config_entries(env)
    if entries is None or entries[-len(CONTROLLER_GIT_CONFIG):] == list(CONTROLLER_GIT_CONFIG):
        return
    for index, (key, value) in enumerate(CONTROLLER_GIT_CONFIG, len(entries)):
        env[f"GIT_CONFIG_KEY_{index}"] = key
        env[f"GIT_CONFIG_VALUE_{index}"] = value
    env["GIT_CONFIG_COUNT"] = str(len(entries) + len(CONTROLLER_GIT_CONFIG))


def without_controller_git_config(env) -> dict:
    """A copy of `env` without exactly the entries controller_git_config added; the operator's own entries stay.

    Claude processes and checks get this: a check runs the target's hooks as written, and Claude Code's background
    service, which a controller's `claude` call may start, would otherwise pass hooks-off to every later session.
    """
    result = dict(env)
    entries, size = git_config_entries(result), len(CONTROLLER_GIT_CONFIG)
    if not entries or entries[-size:] != list(CONTROLLER_GIT_CONFIG):
        return result
    for index in range(len(entries) - size, len(entries)):
        del result[f"GIT_CONFIG_KEY_{index}"], result[f"GIT_CONFIG_VALUE_{index}"]
    if len(entries) > size:
        result["GIT_CONFIG_COUNT"] = str(len(entries) - size)
    else:
        del result["GIT_CONFIG_COUNT"]
    return result


# Config keys that can make a Git command run a program, read attributes from elsewhere or send a request elsewhere. Git
# prints section and variable names in lower case; `include` covers include.path and includeIf.<condition>.path.
WATCHED_KEYS = frozenset({"core.hookspath", "core.fsmonitor", "core.sshcommand", "core.askpass", "core.attributesfile"})
WATCHED_PREFIXES = ("filter.", "diff.", "merge.", "include", "credential.", "url.")
USERINFO = re.compile(r"(?<=://)[^/@\s]*@")  # A token in a URL key (url.https://<token>@host/.insteadof) is never named.
SHARED_GIT_CHANGED = "Shared .git changed during the run: "


def entry_digest(path: Path) -> str:
    """A file's bytes and whether it is executable (a hook runs only then), a symbolic link's target, or a directory."""
    try:
        if path.is_symlink():
            data = b"symlink:" + str(path.readlink()).encode()
        elif path.is_dir():
            data = b"directory"
        else:
            data = (b"executable:" if path.stat().st_mode & 0o111 else b"file:") + path.read_bytes()
    except OSError:
        data = b"unreadable"
    return hashlib.sha256(data).hexdigest()


def shared_git_state(repository) -> dict[str, str]:
    """A digest per entry of the shared .git that can make a Git command run something: each watched config key in every
    scope but the command line (named `<scope> <key>`, its origins and values hashed in order), each entry of hooks/,
    info/attributes, info/exclude, the main worktree's config.worktree and each worktrees/<id>/config.worktree."""
    listing = subprocess.run(["git", "-C", str(repository), "config", "--list", "--show-scope", "--show-origin", "-z"],
                             capture_output=True, check=True).stdout.split(b"\0")
    values = {}
    for scope, origin, item in zip(listing[0::3], listing[1::3], listing[2::3]):
        key, newline, value = (part.decode(errors="replace") for part in item.partition(b"\n"))
        if scope == b"command" or not (key in WATCHED_KEYS or key.startswith(WATCHED_PREFIXES)):
            continue  # The command line holds the controller's own entries, which no lane can change.
        name = f"{scope.decode(errors='replace')} {USERINFO.sub('<redacted>@', key)}"
        values.setdefault(name, []).append([origin.decode(errors="replace"), value if newline else None])
    state = {name: hashlib.sha256(json.dumps(items).encode()).hexdigest() for name, items in values.items()}
    common = common_dir(repository)
    hooks = common / "hooks"
    files = [*(sorted(hooks.iterdir()) if hooks.is_dir() else []), common / "info" / "attributes", common / "info" / "exclude",
             common / "config.worktree", *sorted(common.glob("worktrees/*/config.worktree"))]
    for path in files:
        if path.is_symlink() or path.exists():
            state[path.relative_to(common).as_posix()] = entry_digest(path)
    return state


def shared_git_record(repository) -> dict:
    """What prepare pins as plan.shared_git: shared_git_state's entries and one digest of them."""
    entries = shared_git_state(repository)
    return {"sha256": hashlib.sha256(json.dumps(entries, sort_keys=True).encode()).hexdigest(), "entries": entries}


def shared_git_changes(before: dict, after: dict) -> list[str]:
    """The names whose digest differs between two shared_git_state records, sorted. A worktrees/<id>/config.worktree
    that is new and holds what a config.worktree held before is the copy `git worktree add` makes of the main worktree's
    under extensions.worktreeConfig (each verification, candidate and review worktree a run adds), not a change."""
    copies = {digest for name, digest in before.items() if name.endswith("config.worktree")}
    return sorted(name for name in before.keys() | after.keys() if before.get(name) != after.get(name)
                  and not (name not in before and name.startswith("worktrees/") and after[name] in copies))
