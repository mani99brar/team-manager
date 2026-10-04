"""Process queries on macOS, which has no /proc: ps, lsof and libproc answer what Linux reads under /proc/<pid>.

The callers keep their /proc reads for Linux and come here only on sys.platform == "darwin". ps and lsof run by absolute
path, without a shell, under a short timeout, with LC_CTYPE=UTF-8 (and any inherited LC_ALL dropped): in the C locale they
print a non-ASCII byte as an escape, and would name a working directory that does not exist. A query that gets no answer
(the tool fails, hangs or lists no such process) returns None, where Linux's read raises OSError. Each caller then gives
the answer its Linux read gives on OSError, except sidecar.process_gone: a process that kill(pid, 0) still finds reads as
not gone there (gone on Linux), and its next poll settles it.
"""
from __future__ import annotations

import errno
import functools
import os
import subprocess
# Bound at import: tests fake `claude` and Git by patching subprocess.run, which every module shares, and such a fake must
# not catch ps and lsof any more than it catches Linux's /proc reads.
from subprocess import run

PS = "/bin/ps"
LSOF = "/usr/sbin/lsof"
LIBPROC = "/usr/lib/libproc.dylib"
PROC_PIDPATHINFO_MAXSIZE = 4096
TIMEOUT_SECONDS = 5


def query(*command: str) -> str | None:
    """The command's output, or None when it could not run, timed out or exited nonzero (ps: no such process)."""
    env = {name: value for name, value in os.environ.items() if name != "LC_ALL"}
    try:
        result = run(command, capture_output=True, encoding="utf-8", errors="replace", timeout=TIMEOUT_SECONDS, env={**env, "LC_CTYPE": "UTF-8"})
    except (OSError, subprocess.SubprocessError):
        return None
    return result.stdout if result.returncode == 0 else None


def state(pid: int) -> str | None:
    """The process's state letter (`Z`: exited, not collected yet), or None."""
    return (query(PS, "-o", "stat=", "-p", str(pid)) or "").strip()[:1] or None


def gone(pid: int) -> bool:
    """No such process, or a zombie (sidecar.process_gone)."""
    try:
        os.kill(pid, 0)
    except PermissionError:
        pass  # Another user's process: it exists.
    except (OSError, OverflowError):
        return True
    return state(pid) == "Z"


def command_line(pid: int) -> str | None:
    """The process's arguments joined by spaces (Linux's /proc/<pid>/cmdline with its NULs replaced), or None."""
    found = query(PS, "-ww", "-o", "command=", "-p", str(pid))
    return None if found is None else found.strip()


def named(pid: int, descriptor: str) -> str | None:
    """The first name lsof lists for the process's `descriptor` (`-Fn`: its pid, fd and name lines), or None."""
    found = query(LSOF, "-a", "-p", str(pid), "-d", descriptor, "-Fn")
    return next((line[1:] for line in (found or "").splitlines() if line.startswith("n")), None)


def cwd(pid: int) -> str | None:
    """The process's working directory, or None."""
    return named(pid, "cwd")


def executable(pid: int) -> str | None:
    """The path the process's executable was run from, the first text file lsof lists (the binary, before its libraries),
    or None. lsof still names it after the file is deleted."""
    return named(pid, "txt")


@functools.cache
def libproc():
    """libproc, loaded once; None where it cannot be loaded."""
    import ctypes  # Only macOS has libproc: Linux never loads ctypes for it.
    try:
        return ctypes.CDLL(LIBPROC, use_errno=True)
    except OSError:
        return None


def executable_deleted(pid: int) -> bool:
    """Whether the process runs an executable whose file was deleted (Linux's ` (deleted)` on /proc/<pid>/exe).

    libproc's proc_pidpath then fails with ENOENT; for no such process, or a zombie, it fails with ESRCH.
    """
    import ctypes
    library = libproc()
    if library is None:
        return False
    path = ctypes.create_string_buffer(PROC_PIDPATHINFO_MAXSIZE)
    return library.proc_pidpath(pid, path, PROC_PIDPATHINFO_MAXSIZE) <= 0 and ctypes.get_errno() == errno.ENOENT


def own_processes() -> list[tuple[int, str]]:
    """`(pid, command line)` of every process of this user (its real uid), by pid; nothing when ps cannot run."""
    listed = []
    for line in (query(PS, "-ww", "-U", str(os.getuid()), "-o", "pid=,command=") or "").splitlines():
        pid, _, command = line.strip().partition(" ")
        if pid.isdigit():
            listed.append((int(pid), command.strip()))
    return sorted(listed)


def stale_claude() -> list[dict]:
    """sessions.stale_claude_processes: this user's processes whose executable an update deleted and whose executable's
    path mentions claude, as Linux checks /proc/<pid>/exe, `{pid, cwd, command}` each, by pid.

    libproc tells a deleted executable, and lsof, asked only for those, still names the path it was run from. An executable
    replaced at the same path (renamed over) is not seen on macOS: proc_pidpath then finds the new file. A process whose
    executable or working directory cannot be read is left out, as Linux leaves out an entry it cannot read.
    """
    found = []
    for pid, command in own_processes():
        if not executable_deleted(pid) or "claude" not in (executable(pid) or "").lower():
            continue
        directory = cwd(pid)
        if directory is not None:
            found.append({"pid": pid, "cwd": directory, "command": command})
    return found
