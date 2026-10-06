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
        # A launch records workspace trust in Claude Code's config: a temporary one, never the operator's ~/.claude.json.
        config = patch.dict(os.environ, {"CLAUDE_CONFIG_DIR": str(self.root / "claude-config")})
        config.start()
        self.addCleanup(config.stop)
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

    def test_prepare_records_the_shared_git_digest_once_the_worktrees_exist(self):
        # Freeze, review and integrate compare the shared .git against it (C25). The worker authority is the pipeline's to pin.
        import hashlib, json
        from .worktrees import shared_git_state
        entries = shared_git_state(self.repo)
        self.assertEqual(self.plan["shared_git"], {"sha256": hashlib.sha256(json.dumps(entries, sort_keys=True).encode()).hexdigest(), "entries": entries})
        self.assertIn("info/exclude", entries)
        self.assertEqual(read_json(self.directory / "plan.json")["shared_git"], self.plan["shared_git"])
        self.assertNotIn("worker_authority", self.plan)

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

    def test_herdr_runs_without_the_controllers_git_config(self):
        # A tab or pane Herdr creates may start from the caller's environment: the operator's shell and attach-one there run
        # Git and Claude Code with their own configuration, never the controller's hooks-off.
        from .worktrees import controller_git_config
        with patch.dict(os.environ, {"HERDR_ENV": "1"}), patch("workflow.herdr.subprocess.run") as run:
            for key in [key for key in os.environ if key.startswith("GIT_CONFIG")]:
                del os.environ[key]
            controller_git_config(os.environ)
            run.return_value.stdout = "{}"
            herdr("pane", "current", "--current")
        env = run.call_args.kwargs["env"]
        self.assertEqual([key for key in env if key.startswith("GIT_CONFIG")], [])
        self.assertEqual(env["HERDR_ENV"], "1")

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

    def test_worker_effort_comes_from_the_environment_and_refuses_unknown_levels(self):
        from .sessions import worker_effort
        self.assertEqual(worker_effort({}), [])
        self.assertEqual(worker_effort({"WORKFLOW_WORKER_EFFORT": " "}), [])
        self.assertEqual(worker_effort({"WORKFLOW_WORKER_EFFORT": "medium"}), ["--effort", "medium"])
        with self.assertRaisesRegex(ValueError, "not one of low, medium, high, xhigh, max"):
            worker_effort({"WORKFLOW_WORKER_EFFORT": "med"})

    def test_scrub_env_drops_the_session_effort_and_model_overrides_and_keeps_config_auth_and_provider(self):
        # C52: an explicit denylist. A prefix scrub would drop CLAUDE_CONFIG_DIR, the OAuth token and the provider switches.
        from .sessions import scrub_env
        kept = {"PATH": "/usr/bin", "HOME": "/home/operator", "CLAUDE_CONFIG_DIR": "/home/operator/.claude", "CLAUDE_CODE_OAUTH_TOKEN": "token",
                "CLAUDE_CODE_USE_BEDROCK": "1", "CLAUDE_CODE_USE_VERTEX": "1", "ANTHROPIC_BASE_URL": "https://proxy.invalid",
                "CLAUDE_BG_ISOLATION": "none", "DISABLE_AUTOUPDATER": "1"}
        dropped = {"CLAUDECODE": "1", "CLAUDE_CODE_ENTRYPOINT": "cli", "CLAUDE_CODE_SESSION_ID": "s", "CLAUDE_CODE_CHILD_SESSION": "1",
                   "CLAUDE_CODE_MESSAGING_SOCKET": "/tmp/x", "CLAUDE_CODE_MESSAGING_TOKEN": "t", "CLAUDE_PID": "42", "CLAUDE_EFFORT": "max",
                   "CLAUDE_CODE_EFFORT_LEVEL": "low", "ANTHROPIC_MODEL": "claude-haiku", "ANTHROPIC_DEFAULT_OPUS_MODEL": "x",
                   "ANTHROPIC_DEFAULT_HAIKU_MODEL": "y", "CLAUDE_CODE_SUBAGENT_MODEL": "z"}
        environ = {**kept, **dropped}
        self.assertEqual(scrub_env(environ), kept)
        self.assertEqual(environ, {**kept, **dropped})  # The caller's mapping is not modified.

    def test_roles_are_pinned_from_flags_with_the_worker_effort_read_once_and_the_judges_at_high(self):
        from .sessions import pin_roles, role_flags, worker_effort
        env = {"WORKFLOW_WORKER_EFFORT": "medium"}
        self.assertEqual(pin_roles(env=env), {"worker": {"model": None, "effort": "medium"}, "judges": {"model": None, "effort": "high"}})
        self.assertEqual(pin_roles(env={}), {"worker": {"model": None, "effort": None}, "judges": {"model": None, "effort": "high"}})
        roles = pin_roles(worker_model="claude-sonnet-5", worker_effort="low", judge_model="claude-opus-5-5", judge_effort="xhigh", env=env)
        self.assertEqual(roles, {"worker": {"model": "claude-sonnet-5", "effort": "low"}, "judges": {"model": "claude-opus-5-5", "effort": "xhigh"}})
        for bad in ({"worker_effort": "med"}, {"judge_effort": "extreme"}, {"worker_model": "--effort"}, {"judge_model": "two words"}, {"worker_model": ""}):
            with self.subTest(bad), self.assertRaises(ValueError):
                pin_roles(env={}, **bad)
        plan = {"roles": roles}
        # The pins win over the environment at launch: the variable is read once, at prepare.
        self.assertEqual(role_flags(plan, "worker", {"WORKFLOW_WORKER_EFFORT": "max"}), ["--model", "claude-sonnet-5", "--effort", "low"])
        self.assertEqual(worker_effort({"WORKFLOW_WORKER_EFFORT": "max"}, plan), ["--effort", "low"])
        self.assertEqual(role_flags(plan, "judges"), ["--model", "claude-opus-5-5", "--effort", "xhigh"])
        unset = {"roles": pin_roles(env={})}
        self.assertEqual((role_flags(unset, "worker", env), role_flags(unset, "judges")), ([], ["--effort", "high"]))
        # A plan pinned before roles: the variable for workers, nothing for the judges, as before.
        self.assertEqual((role_flags({}, "worker", env), role_flags({}, "judges", env)), (["--effort", "medium"], []))
        with self.assertRaisesRegex(ValueError, "roles"):
            role_flags({"roles": {"worker": {"model": None}}}, "worker")

    def test_a_print_jobs_role_file_records_the_requested_pins_and_the_models_it_used(self):
        from .sessions import pin_roles, record_role
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            plan = {"roles": pin_roles(judge_model="claude-opus-5-5", env={})}
            stdout = root / "challenge-1.stdout.json"
            record_role(root, "challenge-1", plan, "judges")
            self.assertEqual(read_json(root / "challenge-1.role.json"),
                             {"requested": {"model": "claude-opus-5-5", "effort": "high"}, "observed_models": None})
            stdout.write_text('{"type": "result", "modelUsage": {"claude-opus-5-5": {"inputTokens": 3}, "claude-haiku-4-5": {}}}')
            record_role(root, "challenge-1", plan, "judges", stdout)
            self.assertEqual(read_json(root / "challenge-1.role.json")["observed_models"], ["claude-haiku-4-5", "claude-opus-5-5"])
            stdout.write_text("not json")
            record_role(root, "challenge-1", {}, "judges", stdout)  # A plan before roles, an unreadable output.
            self.assertEqual(read_json(root / "challenge-1.role.json"), {"requested": {"model": None, "effort": None}, "observed_models": []})

    def test_a_background_session_gets_the_same_setting_in_its_arguments(self):
        # `claude --bg` only hands its session to the background service, which starts it with the service's own
        # environment: the helper's DISABLE_AUTOUPDATER never reaches it. The helper's arguments do, as --settings.
        # bgIsolation "none" (and CLAUDE_BG_ISOLATION, which 2.1.288 reads first) drops the --bg system prompt's
        # EnterWorktree paragraph and its "commit before finishing ... and push" one.
        import json
        from .sessions import background_settings, claude_env
        flag, value = background_settings()
        self.assertEqual((flag, json.loads(value)), ("--settings", {"env": {"DISABLE_AUTOUPDATER": "1", "CLAUDE_BG_ISOLATION": "none"},
                                                                    "worktree": {"bgIsolation": "none"}}))
        self.assertLessEqual(claude_env({}).items(), json.loads(value)["env"].items())

    def test_a_worker_gets_the_background_settings_plus_its_deny_rules_and_git_variables(self):
        import json
        from .sessions import background_settings, worker_settings
        controller = Path(__file__).resolve().parents[1]
        run = Path(tempfile.gettempdir()) / "runs" / "run"
        flag, value = worker_settings(run)
        settings = json.loads(value)
        background = json.loads(background_settings()[1])
        self.assertEqual(flag, "--settings")
        self.assertEqual(set(settings), {"env", "worktree", "permissions"})
        self.assertEqual(settings["worktree"], background["worktree"])
        self.assertEqual(settings["env"], {**background["env"], "HUSKY": "0", "GIT_TERMINAL_PROMPT": "0"})
        secrets = ["~/.ssh/**", "~/.config/gh/**", "~/.git-credentials", "~/.pi/**", "~/.claude/.credentials.json", "~/.config/vps-wallet.env"]
        # Under ~/.claude/projects only the transcripts and memory are unreadable: Claude Code saves a large tool output in the
        # session's tool-results/ there and tells the worker to Read it. Nothing under it is editable.
        transcripts = ["~/.claude/projects/**/*.jsonl", "~/.claude/projects/**/memory/**"]
        protected = ["~/.claude/projects/**", "~/.bashrc", "~/.profile", "~/.config/systemd/**", "~/.gitconfig", "~/.config/git/**",
                     "~/.claude/settings*.json", f"/{controller}/**"]
        self.assertEqual(settings["permissions"], {"deny": [*(f"{tool}({path})" for path in secrets for tool in ("Read", "Edit")),
                                                            *(f"Read({path})" for path in transcripts),
                                                            *(f"Edit({path})" for path in protected),
                                                            "Bash(pkill:*)", "Bash(killall:*)", "Bash(git push:*)", "Bash(git commit:*)"]})
        self.assertNotIn("Read(~/.claude/projects/**)", settings["permissions"]["deny"])
        # The job's tmp lives under ~/.claude/jobs and pine's worktrees under ~/dev/pine-runs: neither tree is ever denied whole.
        for rule in settings["permissions"]["deny"]:
            self.assertNotRegex(rule, r"^(Read|Edit)\((~|/+home/[^/]+)/(dev|\.claude)(/\*\*)?\)$")
        # A run kept inside the controller checkout keeps its worktrees and completion files writable: that rule is left out.
        inside = json.loads(worker_settings(controller / "runs" / "run")[1])
        self.assertEqual(inside["permissions"]["deny"], [rule for rule in settings["permissions"]["deny"] if rule != f"Edit(/{controller}/**)"])
        self.assertEqual(worker_settings(run), worker_settings(run))  # Deterministic: prepare pins its digest.

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


class ClaudeVersionTests(unittest.TestCase):
    """prepare records `claude --version` (C52): the real call path, run against a stand-in binary, never the operator's CLI."""

    def test_the_version_is_the_first_line_of_a_successful_call_and_none_otherwise(self):
        from .sessions import claude_version
        with tempfile.TemporaryDirectory() as temp:
            stub = Path(temp) / "claude"
            stub.write_text("#!/bin/sh\n[ \"$1\" = --version ] || exit 2\necho '2.1.288 (Claude Code)'\necho 'second line'\n")
            stub.chmod(0o755)
            self.assertEqual(claude_version(str(stub)), "2.1.288 (Claude Code)")
            stub.write_text("#!/bin/sh\necho '2.1.288 (Claude Code)'\nexit 1\n")
            self.assertIsNone(claude_version(str(stub)))
            self.assertIsNone(claude_version(str(Path(temp) / "missing")))


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
