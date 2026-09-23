import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from .herdr import herdr
from .sessions import ClaudeSessions, TransientInfraError, prepare, read_json, run_lock, save_json


class SessionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.repo = self.root / "repo"
        self.repo.mkdir()
        subprocess.run(["git", "init", "-q", str(self.repo)], check=True)
        subprocess.run(["git", "-C", str(self.repo), "config", "user.email", "test@example.invalid"], check=True)
        subprocess.run(["git", "-C", str(self.repo), "config", "user.name", "Test"], check=True)
        (self.repo / "README.md").write_text("A target without contracts/\n")  # The tool bundles the schemas.
        subprocess.run(["git", "-C", str(self.repo), "add", "."], check=True)
        subprocess.run(["git", "-C", str(self.repo), "commit", "-qm", "Base"], check=True)
        self.directory = self.root / "run"
        self.plan = prepare(self.directory, self.repo, "HEAD", {"ui": "Read UI", "adapter": "Read adapter"}, False)
        self.executable = self.root / "fake-claude"
        self.executable.write_text('''#!/usr/bin/env python3
import json, pathlib, sys
session = sys.argv[sys.argv.index('--session-id') + 1]
root = pathlib.Path.cwd()
with (root.parent / 'starts.log').open('a') as log:
    log.write(root.name + '\\n')
sys.stdin.read()
print(json.dumps({'type': 'assistant', 'message': {'content': [{'type': 'text', 'text': 'hello'}]}}), flush=True)
if (root.parent / 'fail').exists():
    print(json.dumps({'type':'result','session_id':session,'subtype':'error_during_execution','is_error':True}), flush=True)
    sys.exit(1)
print(json.dumps({'type':'result','session_id':session,'subtype':'success','is_error':False,'result':'done'}), flush=True)
''')
        self.executable.chmod(0o700)

    def sessions(self):
        return ClaudeSessions(self.directory, str(self.executable), timeout=5)

    def test_exact_revision_and_distinct_worktrees(self):
        nodes = self.plan["nodes"]
        self.assertNotEqual(nodes["ui"]["worktree"], nodes["adapter"]["worktree"])
        for info in nodes.values():
            self.assertEqual(info["observed_start_commit"], self.plan["base_commit"])

    def test_each_lane_launches_once_and_receipts_are_reused(self):
        self.assertEqual((self.plan["workers"], self.plan["excluded_workers"]), (["ui", "adapter"], []))
        sessions = self.sessions()
        self.assertEqual(sessions.workers, ["ui", "adapter"])
        receipts = {node: sessions.run(node) for node in sessions.workers}
        self.assertEqual(receipts["ui"]["status"], "succeeded")
        self.assertNotEqual(receipts["ui"]["session_id"], receipts["adapter"]["session_id"])
        # Durable receipts protect even a fresh controller instance.
        self.sessions().run("ui")
        self.sessions().run("adapter")
        self.assertEqual(len((self.directory / "starts.log").read_text().splitlines()), 2)
        with self.assertRaisesRegex(ValueError, "Unknown worker"):
            self.sessions().run("docs")

    def test_failed_session_is_not_relaunched(self):
        (self.directory / "fail").touch()
        with self.assertRaisesRegex(RuntimeError, "did not succeed"):
            self.sessions().run("ui")
        (self.directory / "fail").unlink()
        with self.assertRaisesRegex(RuntimeError, "reconcile"):
            self.sessions().run("ui")
        self.assertEqual(len((self.directory / "starts.log").read_text().splitlines()), 1)
        self.assertTrue((self.directory / "ui.patch").exists())

    def test_ambiguous_launch_blocks_and_modified_plan_blocks_reuse(self):
        self.sessions().run("ui")
        state = read_json(self.directory / "ui.json")
        state["status"] = "launching"
        save_json(self.directory / "ui.json", state)
        with self.assertRaisesRegex(RuntimeError, "reconcile"):
            self.sessions().run("ui")
        plan = read_json(self.directory / "plan.json")
        plan["nodes"]["ui"]["task"] = "different task"
        save_json(self.directory / "plan.json", plan)
        with self.assertRaisesRegex(RuntimeError, "plan changed"):
            self.sessions().run("ui")

    def test_lock_and_dirty_worktree_fail_closed(self):
        with run_lock(self.directory):
            with self.assertRaisesRegex(RuntimeError, "Another controller"):
                with run_lock(self.directory):
                    pass
        (Path(self.plan["nodes"]["ui"]["worktree"]) / "unexpected").touch()
        with self.assertRaisesRegex(RuntimeError, "changed since preparation"):
            self.sessions().run("ui")

    def test_nonzero_timeout_terminates_session(self):
        self.executable.write_text("#!/usr/bin/env python3\nimport time\ntime.sleep(30)\n")
        with self.assertRaisesRegex(RuntimeError, "timed out"):
            ClaudeSessions(self.directory, str(self.executable), timeout=0.05).run("ui")
        self.assertEqual(read_json(self.directory / "ui.json")["status"], "blocked")

    def test_herdr_silent_success_and_environment_guard(self):
        with patch.dict(os.environ, {"HERDR_ENV": "1"}), patch("workflow.herdr.subprocess.run") as run:
            run.return_value.stdout = ""
            self.assertEqual(herdr("pane", "rename", "w1:p1", "label"), {})
        with patch.dict(os.environ, {"HERDR_ENV": "0"}):
            with self.assertRaisesRegex(RuntimeError, "Herdr-managed"):
                herdr("pane", "current", "--current")

    def test_missing_terminal_receipt_blocks_even_with_exit_zero(self):
        self.executable.write_text("#!/usr/bin/env python3\nprint('not a terminal receipt')\n")
        with self.assertRaisesRegex(RuntimeError, "Missing or mismatched"):
            self.sessions().run("ui")
        self.assertEqual(read_json(self.directory / "ui.json")["status"], "blocked")

    def test_print_launch_waits_out_a_claude_update_with_the_auto_updater_off(self):
        # An exec that failed ran nothing, so it is repeated; the session that started is the only one.
        import errno
        real_popen = subprocess.Popen
        attempts = []
        def popen(command, *args, **kwargs):
            if command[0] == str(self.executable):
                attempts.append((kwargs["env"].get("DISABLE_AUTOUPDATER"), kwargs["env"]["TMPDIR"]))
                if len(attempts) == 1:
                    raise FileNotFoundError(errno.ENOENT, "No such file or directory", command[0])
            return real_popen(command, *args, **kwargs)
        with patch("workflow.sessions.subprocess.Popen", side_effect=popen), patch("workflow.sessions.time.sleep") as sleep:
            self.assertEqual(self.sessions().run("ui")["status"], "succeeded")
        self.assertEqual(attempts, [("1", str(self.directory / "tmp-ui"))] * 2)
        sleep.assert_called_once_with(2)
        self.assertEqual(len((self.directory / "starts.log").read_text().splitlines()), 1)

    def test_cancelled_controller_never_launches(self):
        sessions = self.sessions()
        sessions.cancelled.set()
        with self.assertRaisesRegex(RuntimeError, "cancelled before launch"):
            sessions.run("ui")
        self.assertFalse((self.directory / "starts.log").exists())


class RunClaudeTests(unittest.TestCase):
    def test_a_briefly_missing_executable_is_retried_and_a_lasting_one_raises(self):
        from unittest.mock import patch
        from .sessions import run_claude
        done = subprocess.CompletedProcess(["claude"], 0, "[]", "")
        sleeps = []
        with patch("workflow.sessions.subprocess.run", side_effect=[FileNotFoundError("claude"), FileNotFoundError("claude"), done]) as run:
            self.assertIs(run_claude(["claude", "agents", "--json"], sleep=sleeps.append, capture_output=True), done)
        self.assertEqual((run.call_count, sleeps), (3, [2, 2]))
        # A lasting one is Claude Code being unavailable, by type: callers never read the message to classify it.
        with patch("workflow.sessions.subprocess.run", side_effect=FileNotFoundError("claude")) as run:
            with self.assertRaises(TransientInfraError) as raised:
                run_claude(["claude", "agents", "--json"], grace=4, sleep=lambda seconds: None)
        self.assertEqual(run.call_count, 3)
        self.assertIsInstance(raised.exception.__cause__, FileNotFoundError)
        # A binary half written by an update (ENOEXEC) is retried too; an empty inventory is retried when asked.
        import errno as errnos
        with patch("workflow.sessions.subprocess.run", side_effect=[OSError(errnos.ENOEXEC, "Exec format error"), done]) as run:
            self.assertIs(run_claude(["claude", "agents", "--json"], sleep=lambda seconds: None), done)
        empty = subprocess.CompletedProcess(["claude"], 0, "", "")
        with patch("workflow.sessions.subprocess.run", side_effect=[empty, done]) as run:
            self.assertIs(run_claude(["claude", "agents", "--json"], sleep=lambda seconds: None, retry_output=lambda result: not result.stdout.strip()), done)
        with patch("workflow.sessions.subprocess.run", side_effect=OSError(errnos.EACCES, "Permission denied")) as run:
            with self.assertRaises(PermissionError):
                run_claude(["claude"], sleep=lambda seconds: None)
        self.assertEqual(run.call_count, 1)
        # A command that started and failed is not retried.
        with patch("workflow.sessions.subprocess.run", side_effect=subprocess.CalledProcessError(1, "claude")) as run:
            with self.assertRaises(subprocess.CalledProcessError):
                run_claude(["claude", "stop", "x"], sleep=lambda seconds: None, check=True)
        self.assertEqual(run.call_count, 1)

    def test_output_that_stays_rejected_is_returned_once_the_grace_is_spent(self):
        # An inventory that stays empty is retried every 2 seconds for the grace, then handed back, never polled in a tight loop.
        from .sessions import run_claude
        empty = subprocess.CompletedProcess(["claude"], 0, "", "")
        sleeps = []
        with patch("workflow.sessions.subprocess.run", side_effect=[empty] * 10) as run:
            self.assertIs(run_claude(["claude", "agents", "--json"], grace=4, sleep=sleeps.append,
                                     retry_output=lambda result: not result.stdout.strip()), empty)
        self.assertEqual((run.call_count, sleeps), (3, [2, 2]))

    def test_every_claude_process_runs_with_the_auto_updater_off_and_keeps_its_environment(self):
        from .sessions import run_claude
        done = subprocess.CompletedProcess(["claude"], 0, "[]", "")
        env = {"TMPDIR": "/tmp/lane"}
        with patch.dict(os.environ, {"OPERATOR_SETTING": "kept"}), patch("workflow.sessions.subprocess.run", return_value=done) as run:
            run_claude(["claude", "agents", "--json"], capture_output=True)
            run_claude(["claude", "--bg", "task"], env=env, cwd="/work")
        inherited, given = (call.kwargs["env"] for call in run.call_args_list)
        self.assertEqual((inherited["DISABLE_AUTOUPDATER"], inherited["OPERATOR_SETTING"]), ("1", "kept"))
        self.assertEqual(given, {"TMPDIR": "/tmp/lane", "DISABLE_AUTOUPDATER": "1"})
        self.assertEqual(run.call_args_list[1].kwargs["cwd"], "/work")
        self.assertEqual(env, {"TMPDIR": "/tmp/lane"})  # The caller's own mapping is not modified.

    def test_a_timeout_is_repeated_only_for_a_command_that_only_reads(self):
        # A listing that hangs while the background service restarts is asked again, each timeout spending its own
        # seconds of the grace; then the timeout is raised. A launch or a stop that timed out ran, so it never runs twice.
        from .sessions import run_claude
        done = subprocess.CompletedProcess(["claude"], 0, "[]", "")
        hung = subprocess.TimeoutExpired(["claude", "agents", "--json"], 15)
        listing = {"retry_output": lambda result: False, "timeout": 15}
        sleeps = []
        with patch("workflow.sessions.subprocess.run", side_effect=[hung, done]) as run:
            self.assertIs(run_claude(["claude", "agents", "--json"], sleep=sleeps.append, **listing), done)
        self.assertEqual((run.call_count, sleeps), (2, [2]))
        sleeps = []
        with patch("workflow.sessions.subprocess.run", side_effect=hung) as run:
            with self.assertRaises(subprocess.TimeoutExpired):
                run_claude(["claude", "agents", "--json"], sleep=sleeps.append, **listing)
        self.assertEqual((run.call_count, sleeps), (4, [2, 2, 2]))  # 15 + 2 + 15 + 2 + 15 + 2 + 15 seconds: the 60s grace.
        for command in (["claude", "--bg", "task"], ["claude", "stop", "abcd1234"]):
            with patch("workflow.sessions.subprocess.run", side_effect=subprocess.TimeoutExpired(command, 45)) as run:
                with self.assertRaises(subprocess.TimeoutExpired):
                    run_claude(command, sleep=lambda seconds: self.fail("Unexpected wait"), timeout=45)
            self.assertEqual(run.call_count, 1)


class ClaudeLaunchTests(unittest.TestCase):
    """popen_claude (print jobs) waits out an update only while the exec fails, with the auto-updater off."""

    def test_a_print_job_is_started_again_only_when_its_exec_failed(self):
        import errno
        from .sessions import popen_claude
        process = object()
        sleeps = []
        busy = OSError(errno.ETXTBSY, "Text file busy", "claude")
        with patch("workflow.sessions.subprocess.Popen", side_effect=[busy, process]) as popen:
            self.assertIs(popen_claude(["claude", "--print"], sleep=sleeps.append, env={"A": "b"}, cwd="/work"), process)
        self.assertEqual((popen.call_count, sleeps), (2, [2]))
        self.assertEqual(popen.call_args.kwargs["env"], {"A": "b", "DISABLE_AUTOUPDATER": "1"})
        # A job that started is never started again, whatever it does afterwards.
        with patch("workflow.sessions.subprocess.Popen", return_value=process) as popen:
            self.assertIs(popen_claude(["claude", "--print"], sleep=lambda seconds: self.fail("Unexpected wait")), process)
        self.assertEqual(popen.call_count, 1)
        # Any other exec failure is raised at once; a lasting update is TransientInfraError.
        with patch("workflow.sessions.subprocess.Popen", side_effect=OSError(errno.EACCES, "Permission denied", "claude")) as popen:
            with self.assertRaises(PermissionError):
                popen_claude(["claude", "--print"], sleep=lambda seconds: None)
        self.assertEqual(popen.call_count, 1)
        with patch("workflow.sessions.subprocess.Popen", side_effect=FileNotFoundError(errno.ENOENT, "No such file or directory", "claude")) as popen:
            with self.assertRaises(TransientInfraError):
                popen_claude(["claude", "--print"], grace=2, sleep=lambda seconds: None)
        self.assertEqual(popen.call_count, 2)


class StaleClaudeTests(unittest.TestCase):
    def test_processes_running_a_deleted_claude_executable_are_named_from_proc(self):
        from .sessions import stale_claude_processes, stale_claude_warning
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        proc = Path(temp.name)

        def process(pid, exe=None, cwd=None, cmdline=None):
            entry = proc / str(pid)
            entry.mkdir()
            if exe:
                (entry / "exe").symlink_to(exe)
            if cwd:
                (entry / "cwd").symlink_to(cwd)
            if cmdline is not None:
                (entry / "cmdline").write_bytes(cmdline)

        # Seen live: sessions started before an update keep the deleted npm build (and reinstall it).
        process(1107463, "/home/u/.nvm/lib/node_modules/@anthropic-ai/.claude-code-WwJCDfoB/bin/claude.exe (deleted)", "/work/md-manager", b"claude\0")
        process(12, "/usr/bin/python3.12 (deleted)", "/work/other", b"python3\0")          # Deleted, but not Claude Code.
        process(13, "/home/u/.local/bin/claude", "/work/current", b"claude\0")             # Claude Code, current binary.
        process(14, "/home/u/.local/share/claude/versions/2.1.281 (deleted)")            # Its cwd cannot be read.
        process(15)                                                                      # Another user's process: nothing readable.
        process(206, "/home/u/.local/share/claude/versions/2.1.281 (deleted)", "/work/vea", b"claude\0--resume\0abc\0")
        (proc / "self").mkdir()
        self.assertEqual(stale_claude_processes(proc), [{"pid": 206, "cwd": "/work/vea", "command": "claude --resume abc"},
                                                        {"pid": 1107463, "cwd": "/work/md-manager", "command": "claude"}])
        warning = stale_claude_warning(proc)
        self.assertTrue(warning.startswith("Warning: 2 running Claude Code process(es)"))
        self.assertIn("keep reinstalling Claude Code", warning)
        self.assertIn("restart them before the run", warning)
        self.assertEqual(warning.splitlines()[1:], ["  pid 206 in /work/vea: claude --resume abc", "  pid 1107463 in /work/md-manager: claude"])
        # No /proc (not Linux): nothing to report and nothing refused.
        self.assertEqual((stale_claude_processes(proc / "absent"), stale_claude_warning(proc / "absent")), ([], ""))


if __name__ == "__main__":
    unittest.main()
