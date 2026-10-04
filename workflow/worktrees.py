"""`git worktree` changes, one at a time per repository, and the controller's own Git calls against a shared .git.

Git does not serialise worktree administration: two `git worktree add` in one repository can read each other's
half-written `.git/worktrees/<id>/` and die (`failed to read .../commondir`), which lanes verifying at the same
moment hit. Every worktree add, move, prune, remove and repair under workflow/ goes through git_worktree.

Every lane worktree shares the repository's .git, so what a lane plants there (a hook, an fsmonitor command, a filter
or diff driver, an attributes line) reaches the controller's own Git calls. `python -m workflow`, and pipeline.main and
launch.main for `python -m workflow.pipeline|launch`, turn hooks and fsmonitor off for all of them
(controller_git_config); Claude sessions and checks run without that, as the target's code expects
(without_controller_git_config). prepare records shared_git_record, and freeze, review and integrate report what changed
since: a tripwire and a warning, never a refusal and never a boundary.
"""
from __future__ import annotations

import fcntl
import hashlib
import json
import os
import re
import stat
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
# Git reads GIT_CONFIG_COUNT with strtoul and refuses anything after the digits. White space (C's isspace) and a sign may
# lead them; with no digits at all strtoul reads nothing, so an empty count is 0 but " " or "+" is refused. A negative
# count wraps past INT_MAX, which Git refuses too ("too many entries"); -0 is 0.
GIT_CONFIG_COUNT = re.compile(r"[ \t\n\v\f\r]*([+-]?)0*([0-9]+)")
GIT_CONFIG_COUNT_MAX = 2**31 - 1


def git_config_count(value: str) -> int | None:
    """GIT_CONFIG_COUNT's value as Git reads it, or None for one Git refuses."""
    if value == "":
        return 0
    match = GIT_CONFIG_COUNT.fullmatch(value)
    if match is None or len(match[2]) > len(str(GIT_CONFIG_COUNT_MAX)):
        return None
    count = int(match[2])
    return None if count > GIT_CONFIG_COUNT_MAX or (match[1] == "-" and count) else count


def git_config_entries(env) -> list[tuple] | None:
    """The (key, value) entries GIT_CONFIG_COUNT declares in `env`, as Git reads them: [] without a count, None when Git
    refuses them, a count it cannot read or a declared key or value that is missing, and then runs no command at all."""
    count = env.get("GIT_CONFIG_COUNT")
    if count is None:
        return []
    count = git_config_count(count)
    if count is None:
        return None
    entries = []
    for index in range(count):  # Up to the first missing entry, as Git reads them: a huge count costs nothing.
        key, value = env.get(f"GIT_CONFIG_KEY_{index}"), env.get(f"GIT_CONFIG_VALUE_{index}")
        if key is None or value is None:
            return None
        entries.append((key, value))
    return entries


def controller_git_config(env) -> None:
    """Add CONTROLLER_GIT_CONFIG to `env` (os.environ, at each controller entry: `python -m workflow`, pipeline.main and
    launch.main) after the entries it already has, and write GIT_CONFIG_COUNT again as plain digits: a count Git reads
    as 0, such as an empty one, puts them at 0 and 1. Once only: a controller another one starts (automatic-step, launch's
    steps) inherits them. Entries Git refuses are left as they are; Git then runs nothing at all."""
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
# A file is hashed in chunks up to DIGEST_LIMIT bytes; past it, its size, modification time and change time stand in for the
# rest. A change time cannot be set back without root, so a rewrite of the same size whose modification time was restored
# still shows. Hooks, attributes and config files are far smaller than the limit, a compiled hook may not be.
DIGEST_CHUNK = 1 << 16
DIGEST_LIMIT = 1 << 20
KINDS = {stat.S_IFDIR: b"directory", stat.S_IFIFO: b"fifo", stat.S_IFSOCK: b"socket", stat.S_IFCHR: b"character device",
         stat.S_IFBLK: b"block device"}


def entry_digest(path: Path) -> str | None:
    """One entry's digest, from one lstat: a regular file's bytes and whether it is executable (a hook runs only then), a
    symbolic link's target, and any other entry (a directory, a FIFO, a socket, a device) by its kind alone. None when
    there is no entry.

    Only a regular file is opened, without following a link or waiting for a writer, and what was opened is checked
    again: opening a FIFO for reading waits for a writer, so a FIFO planted in hooks/ would hang freeze, review and
    integrate. Past DIGEST_LIMIT bytes a file is not read.
    """
    try:
        status = path.lstat()
    except (FileNotFoundError, NotADirectoryError):
        return None
    except OSError:
        return hashlib.sha256(b"unreadable").hexdigest()
    try:
        if stat.S_ISLNK(status.st_mode):
            return hashlib.sha256(b"symlink:" + os.fsencode(os.readlink(path))).hexdigest()
        if not stat.S_ISREG(status.st_mode):
            return hashlib.sha256(KINDS.get(stat.S_IFMT(status.st_mode), b"other")).hexdigest()
        with open(os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK), "rb") as handle:
            status = os.fstat(handle.fileno())  # A FIFO swapped in since the lstat is named, not read.
            if not stat.S_ISREG(status.st_mode):
                return hashlib.sha256(KINDS.get(stat.S_IFMT(status.st_mode), b"other")).hexdigest()
            digest = hashlib.sha256(b"executable:" if status.st_mode & 0o111 else b"file:")
            left = DIGEST_LIMIT
            while left and (chunk := handle.read(min(DIGEST_CHUNK, left))):
                digest.update(chunk)
                left -= len(chunk)
            if not left and handle.read(1):
                digest.update(f"\0past {DIGEST_LIMIT} bytes: size {status.st_size}, modified {status.st_mtime_ns}, changed {status.st_ctime_ns}".encode())
            return digest.hexdigest()
    except OSError:
        return hashlib.sha256(b"unreadable").hexdigest()


def global_git_files(repository) -> list[Path]:
    """The files outside the .git that the controller's Git calls read and a lane's Bash could write, found as Git finds
    them: the global attributes file (core.attributesFile when set, else $XDG_CONFIG_HOME/git/attributes or
    ~/.config/git/attributes) and the global config beside ~/.gitconfig ($XDG_CONFIG_HOME/git/config or
    ~/.config/git/config). Their watched keys are in the config listing too; ~/.gitconfig is watched by key only."""
    home = os.environ.get("HOME")
    xdg = os.environ.get("XDG_CONFIG_HOME") or (None if home is None else f"{home}/.config")
    configured = subprocess.run(["git", "-C", str(repository), "config", "--type=path", "-z", "--get", "core.attributesFile"],
                                capture_output=True)
    if configured.returncode == 0:
        value = os.fsdecode(configured.stdout.split(b"\0")[0])
        attributes = Path(repository, value) if value else None  # Set but empty: Git reads no global attributes file.
    else:
        attributes = Path(xdg, "git", "attributes") if xdg else None
    return [path for path in (attributes, Path(xdg, "git", "config") if xdg else None) if path is not None]


def home_name(path: Path) -> str:
    """A path outside the .git as shared_git_state names it: `~/...` under $HOME, else the absolute path."""
    home = os.environ.get("HOME")
    return f"~/{path.relative_to(home).as_posix()}" if home and path.is_relative_to(home) else path.as_posix()


def shared_git_state(repository) -> dict[str, str]:
    """A digest per entry that can make the controller's Git commands run something or read other attributes: each
    watched config key in every scope but the command line (named `<scope> <key>`, its origins and values hashed in
    order); each entry of hooks/, info/attributes, info/exclude, the main worktree's config.worktree and each
    worktrees/<id>/config.worktree (named by their path in the common .git); and global_git_files (home_name)."""
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
    named = [*((path.relative_to(common).as_posix(), path) for path in files), *((home_name(path), path) for path in global_git_files(repository))]
    for name, path in named:
        digest = entry_digest(path)
        if digest is not None:
            state[name] = digest
    return state


def shared_git_record(repository) -> dict:
    """What prepare pins as plan.shared_git: shared_git_state's entries and one digest of them."""
    entries = shared_git_state(repository)
    return {"sha256": hashlib.sha256(json.dumps(entries, sort_keys=True).encode()).hexdigest(), "entries": entries}


def shared_git_changes(before: dict, after: dict) -> list[str]:
    """The names whose digest differs between two shared_git_state records, sorted. Two differences under worktrees/ are
    no change: a worktree removed since, which runs nothing any more, and a config.worktree, new or changed, that holds
    what a config.worktree held before. That is the copy `git worktree add` makes of the main worktree's under
    extensions.worktreeConfig: each verification, candidate and review worktree a run adds, or another run on the same
    .git reusing a removed worktree's id."""
    copies = {digest for name, digest in before.items() if name == "config.worktree" or name.startswith("worktrees/")}
    return sorted(name for name in before.keys() | after.keys() if before.get(name) != after.get(name)
                  and not (name.startswith("worktrees/") and (name not in after or after[name] in copies)))
