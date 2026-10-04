"""The macOS process queries (workflow/processes.py): ps, lsof and libproc where Linux reads /proc.

ps, lsof and libproc are fakes that give injected answers, so these run on any platform; RealProcesses asks the real
tools on macOS. The fixtures here (on_platform and the answer builders) also serve the tests of the three callers.
"""
import contextlib
import errno
import os
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from . import processes
from .processes import LIBPROC, LSOF, PS

try:
    import ctypes
except ImportError:  # A CPython built without _ctypes: the tests that fake or load libproc are skipped, not the run.
    ctypes = None


def need_ctypes():
    if ctypes is None:
        raise unittest.SkipTest("ctypes unavailable")


class FakeTools:
    """ps and lsof as processes.query runs them: `answers` maps a command (a tuple) to its output, to None for a nonzero
    exit (what ps does for no such process), or to the exception running it raises. Each call is recorded with its options."""

    def __init__(self, answers=()):
        self.answers, self.calls = dict(answers), []

    def run(self, command, **options):
        self.calls.append((command, options))
        answer = self.answers.get(tuple(command))
        if isinstance(answer, BaseException):
            raise answer
        return subprocess.CompletedProcess(command, 1 if answer is None else 0, answer or "", "")


class FakeLibproc:
    """libproc as processes.executable_deleted loads it: `paths` maps a pid to its executable's path, or to the errno
    proc_pidpath fails with; any other pid fails with ESRCH (no such process)."""

    def __init__(self, paths=()):
        self.paths = dict(paths)

    def proc_pidpath(self, pid, buffer, size):
        found = self.paths.get(pid, errno.ESRCH)
        if isinstance(found, int):
            ctypes.set_errno(found)
            return 0
        buffer.value = found.encode()
        return len(found)


@contextlib.contextmanager
def on_platform(name, answers=(), paths=()):
    """sys.platform reads `name`; ps and lsof give `answers` (FakeTools), libproc `paths` (FakeLibproc). Yields the FakeTools.

    libproc is loaded afresh inside (the loaded one is cached), so a further patch of ctypes.CDLL also applies."""
    need_ctypes()
    tools = FakeTools(answers)
    processes.libproc.cache_clear()
    try:
        with patch.object(sys, "platform", name), patch("workflow.processes.run", side_effect=tools.run), \
                patch("ctypes.CDLL", return_value=FakeLibproc(paths)):
            yield tools
    finally:
        processes.libproc.cache_clear()


def ps_stat(pid, answer) -> dict:
    return {(PS, "-o", "stat=", "-p", str(pid)): answer}


def ps_command(pid, answer) -> dict:
    return {(PS, "-ww", "-o", "command=", "-p", str(pid)): answer}


def ps_listing(answer) -> dict:
    return {(PS, "-ww", "-U", str(os.getuid()), "-o", "pid=,command="): answer}


def lsof_cwd(pid, path) -> dict:
    """lsof's answer for the process's cwd (`-Fn`: its pid, fd and name lines), or None for no answer."""
    return {(LSOF, "-a", "-p", str(pid), "-d", "cwd", "-Fn"): None if path is None else f"p{pid}\nfcwd\nn{path}\n"}


def lsof_txt(pid, path) -> dict:
    """lsof's answer for the process's text files: its executable first, then the dynamic loader; None for no answer."""
    return {(LSOF, "-a", "-p", str(pid), "-d", "txt", "-Fn"): None if path is None else f"p{pid}\nftxt\nn{path}\nftxt\nn/usr/lib/dyld\n"}


class ToolQueries(unittest.TestCase):
    def test_ps_and_lsof_run_by_absolute_path_without_a_shell_in_a_utf_8_locale_under_a_timeout(self):
        with on_platform("darwin", {**ps_stat(42, "S+  \n"), **ps_command(42, "claude --resume abc\n"), **lsof_cwd(42, "/work/vea"),
                                    **lsof_txt(42, "/Users/u/.local/share/claude/versions/2.1.288"),
                                    **ps_listing("  206 claude --resume abc\n   12 /usr/bin/python3 x.py\n")}) as tools, \
                patch.dict(os.environ, {"LC_ALL": "C", "LANG": "C"}):
            self.assertEqual((processes.state(42), processes.command_line(42), processes.cwd(42), processes.executable(42)),
                             ("S", "claude --resume abc", "/work/vea", "/Users/u/.local/share/claude/versions/2.1.288"))
            self.assertEqual(processes.own_processes(), [(12, "/usr/bin/python3 x.py"), (206, "claude --resume abc")])
        self.assertEqual((PS, LSOF), ("/bin/ps", "/usr/sbin/lsof"))
        self.assertEqual([command for command, _ in tools.calls],
                         [*ps_stat(42, ""), *ps_command(42, ""), *lsof_cwd(42, ""), *lsof_txt(42, ""), *ps_listing("")])
        for _, options in tools.calls:
            self.assertNotIn("shell", options)
            # In the C locale ps and lsof would escape every non-ASCII byte: an inherited LC_ALL is dropped, and the rest kept.
            self.assertEqual((options["timeout"], options["encoding"], options["env"]["LC_CTYPE"], options["env"]["LANG"]),
                             (processes.TIMEOUT_SECONDS, "utf-8", "UTF-8", "C"))
            self.assertNotIn("LC_ALL", options["env"])

    def setUp(self):
        need_ctypes()  # Before any subtest, which would take on_platform's skip as its own.

    def test_a_tool_that_fails_hangs_cannot_run_or_lists_no_such_process_gives_no_answer(self):
        commands = [*ps_stat(42, None), *ps_command(42, None), *lsof_cwd(42, None), *lsof_txt(42, None), *ps_listing(None)]
        for answer in (None, FileNotFoundError(errno.ENOENT, "No such file or directory", PS), subprocess.TimeoutExpired([PS], 5),
                       PermissionError(errno.EACCES, "Permission denied", LSOF)):
            with self.subTest(answer=answer), on_platform("darwin", dict.fromkeys(commands, answer)):
                self.assertEqual((processes.state(42), processes.command_line(42), processes.cwd(42), processes.executable(42), processes.own_processes()),
                                 (None, None, None, None, []))
        # A zombie's command line is `<defunct>`; lsof names no cwd for a process it cannot read.
        with on_platform("darwin", {**ps_stat(42, "Z   \n"), **ps_command(42, "<defunct>\n"),
                                    (LSOF, "-a", "-p", "42", "-d", "cwd", "-Fn"): "p42\nfcwd\n"}):
            self.assertEqual((processes.state(42), processes.command_line(42), processes.cwd(42)), ("Z", "<defunct>", None))

    def test_gone_is_no_such_process_or_a_zombie_and_a_process_ps_cannot_tell_about_is_still_there(self):
        cases = ((ProcessLookupError(), "S   \n", True), (None, "Z   \n", True), (None, "S   \n", False), (None, None, False),
                 (PermissionError(), "Z   \n", True), (PermissionError(), "R   \n", False), (OverflowError(), "S   \n", True))
        for killed, answer, expected in cases:
            with self.subTest(killed=killed, answer=answer), on_platform("darwin", ps_stat(42, answer)) as tools, \
                    patch("workflow.processes.os.kill", side_effect=killed) as kill:
                self.assertIs(processes.gone(42), expected)
                kill.assert_called_once_with(42, 0)
                self.assertEqual(len(tools.calls), 0 if isinstance(killed, (ProcessLookupError, OverflowError)) else 1)

    def test_proc_pidpath_failing_with_enoent_is_a_deleted_executable_and_esrch_or_a_path_is_not(self):
        library = FakeLibproc({7: errno.ENOENT, 8: "/Users/u/.local/share/claude/versions/2.1.288", 9: errno.ESRCH})
        with on_platform("darwin"), patch("ctypes.CDLL", return_value=library) as load:
            self.assertEqual([processes.executable_deleted(pid) for pid in (7, 8, 9, 10)], [True, False, False, False])
        load.assert_called_once_with(LIBPROC, use_errno=True)  # Loaded once, not once per process.
        with on_platform("darwin"), patch("ctypes.CDLL", side_effect=OSError("dlopen(/usr/lib/libproc.dylib): image not found")) as load:
            self.assertEqual((processes.executable_deleted(7), processes.executable_deleted(8)), (False, False))
        load.assert_called_once()


@unittest.skipUnless(sys.platform == "darwin", "asks the real ps, lsof and libproc")
class RealProcesses(unittest.TestCase):
    def test_a_live_child_then_its_zombie_then_its_reaped_pid(self):
        need_ctypes()
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        root = Path(temp.name).resolve()
        marker = "workflow-processes-marker"
        child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)", marker], cwd=root)
        self.addCleanup(child.wait)
        self.addCleanup(child.kill)
        deadline = time.monotonic() + 30
        while marker not in (processes.command_line(child.pid) or ""):  # Until the fork has exec'd the child's own command.
            self.assertLess(time.monotonic(), deadline, "the child never started")
            time.sleep(0.02)
        self.assertNotIn(processes.state(child.pid), {None, "Z"})
        self.assertEqual((processes.gone(child.pid), processes.cwd(child.pid), processes.executable_deleted(child.pid)), (False, str(root), False))
        self.assertIn((child.pid, processes.command_line(child.pid)), processes.own_processes())
        os.kill(child.pid, signal.SIGKILL)
        while processes.state(child.pid) != "Z":  # Not collected until child.wait().
            self.assertLess(time.monotonic(), deadline, "the child never became a zombie")
            time.sleep(0.02)
        self.assertEqual((processes.gone(child.pid), processes.command_line(child.pid), processes.executable_deleted(child.pid)), (True, "<defunct>", False))
        child.wait()
        self.assertEqual((processes.gone(child.pid), processes.state(child.pid), processes.command_line(child.pid), processes.cwd(child.pid)),
                         (True, None, None, None))


if __name__ == "__main__":
    unittest.main()
