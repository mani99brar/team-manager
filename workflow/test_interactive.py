import contextlib
import io
import itertools
import json
import os
import subprocess
import time
import unittest
from pathlib import Path
from unittest.mock import Mock, call, patch

from .interactive import InteractiveSessions, attach_panels, require_shell
from .sessions import read_json, save_json


class InteractiveTests(unittest.TestCase):
    def setUp(self):
        from .test_sessions import SessionTests
        SessionTests.setUp(self)
        self.plan["mode"] = "interactive"
        save_json(self.directory / "plan.json", self.plan)
        self.sessions = InteractiveSessions(self.directory, executable="claude")

    def row(self, node="ui", **updates):
        info = self.plan["nodes"][node]
        native_id = "11111111-1111-4111-8111-111111111111" if node == "ui" else "22222222-2222-4222-8222-222222222222"
        return {"sessionId": native_id, "id": native_id[:8], "name": self.sessions.launch_name(node),
                "kind": "background", "cwd": info["worktree"], "state": "idle", "pid": os.getpid(), **updates}

    def test_native_launch_and_reconciliation_never_spawn_duplicate(self):
        with patch.object(self.sessions, "inventory", side_effect=[[], [self.row()], [self.row()]]), patch("workflow.interactive.git", side_effect=[self.plan["base_commit"], ""]), patch("workflow.interactive.subprocess.run") as launch:
            def started(*args, **kwargs):
                kwargs["stdout"].write(f"claude attach {self.row()['id']}    open in this terminal\n")
                return subprocess.CompletedProcess([], 0)
            launch.side_effect = started
            result = self.sessions.run("ui")
            self.assertEqual(result["session_id"], self.row()["sessionId"])
            self.assertNotEqual(result["session_id"], self.plan["nodes"]["ui"]["session_id"])
            self.assertEqual(self.sessions.run("ui")["status"], "attached_session_available")
            self.assertEqual(launch.call_count, 1)
            command = launch.call_args.args[0]
            self.assertIn("--bg", command)
            self.assertIn("manual", command)
            self.assertNotIn("--print", command)
            self.assertNotIn("bypassPermissions", command)
            self.assertFalse(any(key.startswith("HERDR_") for key in launch.call_args.kwargs["env"]))

    def test_launch_waits_for_native_pid_to_register(self):
        def started(*args, **kwargs):
            kwargs["stdout"].write(f"claude attach {self.row()['id']}    open in this terminal\n")
            return subprocess.CompletedProcess([], 0)
        unregistered = {key: value for key, value in self.row().items() if key != "pid"}
        # Pre-launch name check, then: row absent, row without PID, row without PID, row ready.
        inventories = [[], [], [unregistered], [unregistered], [self.row()]]
        with patch.object(self.sessions, "inventory", side_effect=inventories) as inventory, \
                patch("workflow.interactive.git", side_effect=[self.plan["base_commit"], ""]), \
                patch("workflow.interactive.subprocess.run", side_effect=started) as launch, \
                patch("workflow.interactive.time.sleep") as sleep:
            result = self.sessions.run("ui")
        self.assertEqual(result["status"], "attached_session_available")
        self.assertEqual(result["background_id"], self.row()["id"])
        self.assertEqual(launch.call_count, 1)
        self.assertEqual(inventory.call_count, 5)
        self.assertEqual(sleep.call_count, 3)

    def test_launch_gives_up_when_pid_never_registers_without_relaunch(self):
        def started(*args, **kwargs):
            kwargs["stdout"].write(f"claude attach {self.row()['id']}    open in this terminal\n")
            return subprocess.CompletedProcess([], 0)
        unregistered = {key: value for key, value in self.row().items() if key != "pid"}
        self.sessions.settle_seconds = 0
        with patch.object(self.sessions, "inventory", side_effect=[[], [unregistered]]), \
                patch("workflow.interactive.git", side_effect=[self.plan["base_commit"], ""]), \
                patch("workflow.interactive.subprocess.run", side_effect=started) as launch:
            with self.assertRaisesRegex(RuntimeError, "No live native PID"):
                self.sessions.run("ui")
        self.assertEqual(launch.call_count, 1)
        self.assertEqual(read_json(self.directory / "ui.interactive.json")["status"], "needs_reconciliation")

    def test_launch_identity_mismatch_fails_immediately(self):
        def started(*args, **kwargs):
            kwargs["stdout"].write(f"claude attach {self.row()['id']}    open in this terminal\n")
            return subprocess.CompletedProcess([], 0)
        wrong_cwd = self.row(cwd="/elsewhere")
        with patch.object(self.sessions, "inventory", side_effect=[[], [wrong_cwd]]) as inventory, \
                patch("workflow.interactive.git", side_effect=[self.plan["base_commit"], ""]), \
                patch("workflow.interactive.subprocess.run", side_effect=started), \
                patch("workflow.interactive.time.sleep") as sleep:
            with self.assertRaisesRegex(RuntimeError, "identity/worktree mismatch"):
                self.sessions.run("ui")
        self.assertEqual(inventory.call_count, 2)
        sleep.assert_not_called()

    def test_automatic_permission_bypass_is_run_scoped(self):
        from .automatic import DEFAULTS
        self.plan.update(automatic=dict(DEFAULTS), source_branch="feature/test")
        save_json(self.directory / "plan.json", self.plan)
        self.sessions = InteractiveSessions(self.directory, executable="claude")
        def started(*args, **kwargs):
            kwargs["stdout"].write(f"claude attach {self.row()['id']}    open in this terminal\n")
            return subprocess.CompletedProcess([], 0)
        with patch.object(self.sessions, "inventory", side_effect=[[], [self.row()]]), patch("workflow.interactive.git", side_effect=[self.plan["base_commit"], ""]), patch("workflow.interactive.subprocess.run", side_effect=started) as launch:
            self.sessions.run("ui")
        command = launch.call_args.args[0]
        self.assertIn("--dangerously-skip-permissions", command)
        self.assertIn("bypassPermissions", command)
        self.assertIn("Bash", command[command.index("--tools") + 1])
        self.assertIn("ui.completion.json", command[-1])
        self.assertIn(self.plan["nodes"]["ui"]["session_id"], command[-1])
        self.assertNotIn("manual", command)

    def test_ambiguous_launch_never_retries_when_session_missing(self):
        with patch.object(self.sessions, "inventory", return_value=[]), patch("workflow.interactive.git", side_effect=[self.plan["base_commit"], ""]), patch("workflow.interactive.subprocess.run", side_effect=subprocess.TimeoutExpired("claude", 45)) as launch:
            with self.assertRaises(subprocess.TimeoutExpired):
                self.sessions.run("ui")
            with self.assertRaisesRegex(RuntimeError, "reconcile|relaunch"):
                self.sessions.run("ui")
            self.assertEqual(launch.call_count, 1)
        self.assertEqual(read_json(self.directory / "ui.interactive.json")["status"], "needs_reconciliation")

    def test_launch_waits_out_a_claude_update_and_never_runs_a_helper_that_ran_again(self):
        # An update makes `claude` briefly missing: that exec failed and ran nothing, so the helper runs once `claude`
        # is back, with the auto-updater off. A helper that ran and failed is never run again: its session may exist.
        import errno
        from .sessions import TransientInfraError
        outcomes = [FileNotFoundError(errno.ENOENT, "No such file or directory", "claude")]
        def started(*args, **kwargs):
            if outcomes:
                raise outcomes.pop()
            kwargs["stdout"].write(f"claude attach {self.row()['id']}    open in this terminal\n")
            return subprocess.CompletedProcess([], 0)
        with patch.dict(os.environ, {"HERDR_PANE_ID": "w1:p1"}), patch.object(self.sessions, "inventory", side_effect=[[], [self.row()]]), \
                patch("workflow.interactive.git", side_effect=[self.plan["base_commit"], ""]), \
                patch("workflow.interactive.subprocess.run", side_effect=started) as launch, patch("workflow.sessions.time.sleep") as sleep:
            self.assertEqual(self.sessions.run("ui")["status"], "attached_session_available")
        self.assertEqual(launch.call_count, 2)
        sleep.assert_called_once_with(2)
        env = launch.call_args.kwargs["env"]
        self.assertEqual(env["DISABLE_AUTOUPDATER"], "1")
        self.assertFalse(any(key.startswith("HERDR_") for key in env))
        with patch.object(self.sessions, "inventory", return_value=[]), patch("workflow.interactive.git", side_effect=[self.plan["base_commit"], ""]), \
                patch("workflow.interactive.subprocess.run", return_value=subprocess.CompletedProcess([], 1)) as launch, \
                patch("workflow.sessions.time.sleep", side_effect=AssertionError("waited after the helper ran")):
            with self.assertRaisesRegex(RuntimeError, "launch exited 1"):
                self.sessions.run("adapter")
        self.assertEqual(launch.call_count, 1)
        self.assertEqual(read_json(self.directory / "adapter.interactive.json")["status"], "needs_reconciliation")
        # `claude` missing for the whole grace: Claude Code is unavailable. Nothing ran, and the receipt still asks for reconciliation.
        (self.directory / "adapter.interactive.json").unlink()
        with patch.object(self.sessions, "inventory", return_value=[]), patch("workflow.interactive.git", side_effect=[self.plan["base_commit"], ""]), \
                patch("workflow.interactive.subprocess.run", side_effect=FileNotFoundError(errno.ENOENT, "No such file or directory", "claude")) as launch, \
                patch("workflow.sessions.time.sleep"):
            with self.assertRaises(TransientInfraError):
                self.sessions.run("adapter")
        self.assertEqual(launch.call_count, 31)
        self.assertEqual(read_json(self.directory / "adapter.interactive.json")["status"], "needs_reconciliation")

    def test_a_failing_inventory_is_asked_again_and_then_claude_code_unavailable_not_a_session_verdict(self):
        # A reinstall restarts the background service: for a moment the listing exits nonzero, prints nothing or no list,
        # or hangs. It only reads, so it is asked again within the grace; a launch, a print job or a stop never is.
        import json
        from .sessions import TransientInfraError
        listing = subprocess.CompletedProcess(["claude"], 0, json.dumps([self.row()]), "")
        with patch("workflow.interactive.subprocess.run", return_value=listing) as run:
            self.assertEqual(self.sessions.inventory(), [self.row()])
        self.assertEqual(run.call_args.kwargs["env"]["DISABLE_AUTOUPDATER"], "1")
        answers = {"exited nonzero": subprocess.CompletedProcess(["claude"], 1, "", "Couldn't reach the background service"),
                   "empty": subprocess.CompletedProcess(["claude"], 0, "", ""),
                   "unparseable": subprocess.CompletedProcess(["claude"], 0, "{not json", ""),
                   "not a list": subprocess.CompletedProcess(["claude"], 0, "{}", "")}
        hung = subprocess.TimeoutExpired(["claude", "agents", "--json"], 15, output=b"partial", stderr=b"slow")
        with patch("workflow.interactive.subprocess.run", side_effect=[hung, *answers.values(), listing]) as run, \
                patch("workflow.sessions.time.sleep") as sleep:
            self.assertEqual(self.sessions.inventory(), [self.row()])
        self.assertEqual((run.call_count, sleep.call_count), (6, 5))
        # An answer that stays unavailable for the whole grace (60s, every 2s) is Claude Code unavailable, by type.
        for name, answer in answers.items():
            with self.subTest(name), patch("workflow.interactive.subprocess.run", return_value=answer) as run, patch("workflow.sessions.time.sleep"):
                with self.assertRaisesRegex(TransientInfraError, "Claude session inventory unavailable for 60s") as raised:
                    self.sessions.inventory()
            self.assertEqual(run.call_count, 31)
            if name == "exited nonzero":
                self.assertIn("exited 1: Couldn't reach the background service", str(raised.exception))
        # A listing that keeps hanging spends 15 seconds of the grace per attempt.
        with patch("workflow.interactive.subprocess.run", side_effect=hung) as run, patch("workflow.sessions.time.sleep"):
            with self.assertRaisesRegex(TransientInfraError, "timed out after 15 seconds"):
                self.sessions.inventory()
        self.assertEqual(run.call_count, 4)

    def test_attach_one_starts_claude_attach_with_the_auto_updater_off(self):
        # However attach-one starts `claude attach` (an exec, or a child it reattaches), the auto-updater is off for it.
        from .interactive import main
        from .sessions import plan_digest
        save_json(self.directory / "ui.interactive.json", {"plan_digest": plan_digest(self.plan), "background_id": self.row()["id"], "session_id": self.row()["sessionId"]})
        seen = []
        def execvp(file, args):
            seen.append((args, os.environ.get("DISABLE_AUTOUPDATER")))
            raise SystemExit(0)  # A real exec replaces the process; the mock ends it the same way.
        def run(args, **kwargs):
            seen.append((args, (kwargs.get("env") or os.environ).get("DISABLE_AUTOUPDATER")))
            return subprocess.CompletedProcess(args, 0)  # The operator detached.
        with patch.dict(os.environ), patch("workflow.interactive.sys.argv", ["interactive", "attach-one", str(self.directory), "--node", "ui"]), \
                patch("workflow.interactive.sys.stdin") as stdin, patch.object(InteractiveSessions, "inventory", return_value=[self.row()]), \
                patch("workflow.interactive.os.chdir"), patch("workflow.interactive.os.execvp", side_effect=execvp), \
                patch("workflow.interactive.subprocess.run", side_effect=run):
            os.environ.pop("DISABLE_AUTOUPDATER", None)
            stdin.isatty.return_value = True
            with contextlib.suppress(SystemExit):
                main()
        self.assertEqual(seen, [(["claude", "attach", self.row()["id"]], "1")])

    def test_launch_intent_can_reconcile_exact_surviving_session(self):
        from .sessions import plan_digest
        save_json(self.directory / "ui.interactive.json", {"status": "launching", "plan_digest": plan_digest(self.plan), "session_id": None})
        (self.directory / "ui.launch.log").write_text(f"claude attach {self.row()['id']}    open\n")
        with patch.object(self.sessions, "inventory", return_value=[self.row()]), patch("workflow.interactive.subprocess.run") as launch:
            self.assertEqual(self.sessions.run("ui")["background_id"], self.row()["id"])
            launch.assert_not_called()

    def test_foreign_or_exited_sessions_cannot_be_attached(self):
        from .sessions import plan_digest
        save_json(self.directory / "ui.interactive.json", {"plan_digest": plan_digest(self.plan), "background_id": self.row()["id"], "session_id": self.row()["sessionId"]})
        for row in [self.row(cwd=str(self.root)), self.row(kind="interactive"), self.row(state="exited"), self.row(state="done", pid=None)]:
            with self.assertRaises(RuntimeError):
                self.sessions.locate("ui", [row])
        with self.assertRaisesRegex(RuntimeError, "Ambiguous"):
            self.sessions.locate("ui", [self.row(), self.row()])

    def test_occupied_pane_is_never_sent_a_command(self):
        with patch("workflow.interactive.herdr", return_value={"result": {"process_info": {"shell_pid": 1, "foreground_processes": [{"pid": 2}]}}}):
            with self.assertRaisesRegex(RuntimeError, "occupied"):
                require_shell("w1:p1", settle_seconds=0)

    def test_freshly_created_pane_is_given_time_for_its_shell_to_start(self):
        def info(**fields):
            return {"result": {"process_info": {"pane_id": "w1:p1", **fields}}}
        # Herdr reports the pane before its shell exists, then the shell while it runs
        # startup files with a child in the foreground, then the idle shell.
        states = [info(shell_pid=None, foreground_processes=[]),
                  info(shell_pid=7, foreground_processes=[{"pid": 8, "name": "bash"}]),
                  info(shell_pid=7, foreground_processes=[{"pid": 7, "name": "bash"}])]
        with patch("workflow.interactive.herdr", side_effect=states) as query, patch("workflow.interactive.time.sleep") as sleep:
            require_shell("w1:p1")
        self.assertEqual(query.call_count, 3)
        self.assertEqual(sleep.call_count, 2)
        with patch("workflow.interactive.herdr", return_value=info(shell_pid=None, foreground_processes=[])), patch("workflow.interactive.time.sleep"):
            with self.assertRaisesRegex(RuntimeError, "occupied"):
                require_shell("w1:p1", settle_seconds=0)

    def fake_herdr(self, calls):
        splits = iter(["w1:p3", "w1:p4"])
        def herdr(*args):
            calls.append(args)
            if args[:2] == ("pane", "current"):
                return {"result": {"pane": {"workspace_id": "w1", "tab_id": "w1:t1"}}}
            if args[:2] == ("tab", "create"):
                return {"result": {"tab": {"tab_id": "w1:t2"}, "root_pane": {"pane_id": "w1:p2"}}}
            if args[:2] == ("pane", "split"):
                return {"result": {"pane": {"pane_id": next(splits)}}}
            if args[:2] == ("pane", "process-info"):
                return {"result": {"process_info": {"shell_pid": 1, "foreground_processes": [{"pid": 1}]}}}
            return {}
        return herdr

    def test_panels_attach_to_native_sessions_in_one_new_tab(self):
        from .sessions import plan_digest
        for node in ("ui", "adapter"):
            save_json(self.directory / f"{node}.interactive.json", {"plan_digest": plan_digest(self.plan), "background_id": self.row(node)["id"], "session_id": self.row(node)["sessionId"]})
        calls = []
        with patch.object(self.sessions, "inventory", return_value=[self.row(), self.row("adapter")]), patch("workflow.interactive.herdr", side_effect=self.fake_herdr(calls)):
            mapping = attach_panels(self.sessions)
        self.assertEqual(set(mapping), {"ui", "adapter"})
        self.assertEqual({entry["tab_id"] for entry in mapping.values()}, {"w1:t2"})
        self.assertEqual(len([call for call in calls if call[:2] == ("pane", "split")]), 1)
        for call in calls:
            if call[:2] == ("pane", "run"):
                self.assertIn("workflow.interactive attach-one", call[3])
                self.assertNotIn("workflow.observer", call[3])
            if call[:2] in (("tab", "create"), ("pane", "split")):
                self.assertIn("--no-focus", call)

    # ---- Native reviewer session -------------------------------------------------------------------

    REVIEWER_UUID = "33333333-3333-4333-8333-333333333333"
    TOKEN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"

    def reviewer_row(self, **updates):
        return {"sessionId": self.REVIEWER_UUID, "id": self.REVIEWER_UUID[:8], "name": self.sessions.launch_name("review"),
                "kind": "background", "cwd": str(self.directory / "review-worktree"), "state": "idle", "pid": os.getpid(), **updates}

    def reviewer_receipt(self):
        from .sessions import plan_digest
        save_json(self.directory / "review.interactive.json", {"plan_digest": plan_digest(self.plan), "background_id": self.reviewer_row()["id"],
                                                               "session_id": self.REVIEWER_UUID, "node_id": "review"})

    def started(self, *args, **kwargs):
        kwargs["stdout"].write(f"claude attach {self.reviewer_row()['id']}    open in this terminal\n")
        return subprocess.CompletedProcess([], 0)

    def test_reviewer_launch_is_read_only_except_its_completion_file(self):
        (self.directory / "review-worktree").mkdir()
        candidate = self.plan["base_commit"]
        with patch.object(self.sessions, "inventory", side_effect=[[], [self.reviewer_row()], [self.reviewer_row()]]), \
                patch("workflow.interactive.git", side_effect=[candidate, ""]), \
                patch("workflow.interactive.subprocess.run", side_effect=self.started) as launch:
            receipt = self.sessions.run_reviewer("review", "Review this candidate.", self.TOKEN, candidate)
            # A second call reconciles the same session and never launches again.
            self.assertEqual(self.sessions.run_reviewer("review", "Review this candidate.", self.TOKEN, candidate)["status"], "attached_session_available")
        self.assertEqual(launch.call_count, 1)
        self.assertEqual(self.sessions.launch_name("review"), f"workflow-{self.plan['run_id']}-reviewer")
        self.assertEqual((receipt["node_id"], receipt["session_id"], receipt["launch_token"], receipt["candidate_commit"]),
                         ("review", self.REVIEWER_UUID, self.TOKEN, candidate))
        self.assertEqual((receipt["worktree"], receipt["base_commit"], receipt["attempt"], receipt["launcher_invocations"]),
                         (str(self.directory / "review-worktree"), self.plan["base_commit"], 1, 1))
        self.assertEqual(receipt["background_id"], self.reviewer_row()["id"])
        self.assertIn("launch_requested_at", receipt)
        command = launch.call_args.args[0]
        self.assertEqual(command[command.index("--name") + 1], f"workflow-{self.plan['run_id']}-reviewer")
        self.assertIn("--bg", command)
        self.assertEqual(command[command.index("--tools") + 1], "Read,Glob,Grep,Write")
        self.assertEqual(command[command.index("--permission-mode") + 1], "dontAsk")
        self.assertEqual(command[command.index("--allowedTools") + 1], f"Edit(//{str(self.directory / 'review.completion.json').lstrip('/')})")
        self.assertEqual(command[command.index("--add-dir") + 1], str(self.directory))
        self.assertEqual(command[command.index("--mcp-config") + 1], '{"mcpServers":{}}')
        for forbidden in ("--dangerously-skip-permissions", "--print", "bypassPermissions", "Bash", "Edit"):
            self.assertNotIn(forbidden, command)
        self.assertEqual(command[-1], "Review this candidate.")
        # --tools, --allowedTools and --add-dir are variadic: the prompt must directly follow a
        # single-value option, or the CLI swallows it and the session starts idle (seen live).
        self.assertEqual(command[-3:-1], ["--permission-mode", "dontAsk"])
        for option in ("--tools", "--allowedTools", "--add-dir"):
            self.assertLess(command.index(option), command.index("--permission-mode"))
        self.assertEqual(launch.call_args.kwargs["cwd"], self.directory / "review-worktree")
        self.assertFalse(any(key.startswith("HERDR_") for key in launch.call_args.kwargs["env"]))
        prompt = self.directory / "review.prompt.txt"
        self.assertEqual(prompt.read_text(), "Review this candidate.")
        self.assertEqual(prompt.stat().st_mode & 0o777, 0o600)
        self.assertIn("claude attach", (self.directory / "review.launch.log").read_text())

    def test_background_sessions_get_the_auto_updater_off_in_their_arguments(self):
        # `claude --bg` only hands its session to Claude Code's background service, which starts it with the service's own
        # environment and an allowlist of the helper's: DISABLE_AUTOUPDATER on the helper never reaches the session (seen
        # live: workers showed "Update installed" mid-run). The helper's arguments do, so every --bg command carries it.
        from .automatic import DEFAULTS
        (self.directory / "review-worktree").mkdir()
        candidate = self.plan["base_commit"]
        ids = {row["name"]: row["id"] for row in (self.row(), self.reviewer_row(), self.row("adapter"))}
        def started(command, **kwargs):
            kwargs["stdout"].write(f"claude attach {ids[command[command.index('--name') + 1]]}    open in this terminal\n")
            return subprocess.CompletedProcess([], 0)
        with patch.dict(os.environ, {"HERDR_PANE_ID": "w1:p1"}), patch("workflow.interactive.subprocess.run", side_effect=started) as launch:
            with patch.object(self.sessions, "inventory", side_effect=[[], [self.row()]]), patch("workflow.interactive.git", side_effect=[self.plan["base_commit"], ""]):
                self.sessions.run("ui")
            with patch.object(self.sessions, "inventory", side_effect=[[], [self.reviewer_row()]]), patch("workflow.interactive.git", side_effect=[candidate, ""]):
                self.sessions.run_reviewer("review", "Review this candidate.", self.TOKEN, candidate)
            self.plan.update(automatic=dict(DEFAULTS), source_branch="feature/test")
            save_json(self.directory / "plan.json", self.plan)
            self.sessions = InteractiveSessions(self.directory, executable="claude")
            with patch.object(self.sessions, "inventory", side_effect=[[], [self.row("adapter")]]), patch("workflow.interactive.git", side_effect=[self.plan["base_commit"], ""]):
                self.sessions.run("adapter")
        self.assertEqual(launch.call_count, 3)
        for call in launch.call_args_list:
            command = call.args[0]
            with self.subTest(command[command.index("--name") + 1]):
                self.assertEqual(command[:2], ["claude", "--bg"])
                self.assertEqual(command.count("--settings"), 1)
                self.assertEqual(json.loads(command[command.index("--settings") + 1]), {"env": {"DISABLE_AUTOUPDATER": "1"}})
                # The helper itself still runs with the auto-updater off and without the controller's Herdr variables.
                self.assertEqual(call.kwargs["env"]["DISABLE_AUTOUPDATER"], "1")
                self.assertFalse(any(key.startswith("HERDR_") for key in call.kwargs["env"]))
        # The prompts still come last, after the permission options.
        worker, reviewer, automatic = (call.args[0] for call in launch.call_args_list)
        self.assertEqual(worker[-2], "manual")
        self.assertEqual(reviewer[-3:], ["--permission-mode", "dontAsk", "Review this candidate."])
        self.assertEqual(automatic[-3:-1], ["bypassPermissions", "--dangerously-skip-permissions"])

    def test_reviewer_launch_waits_for_native_pid_then_gives_up_without_relaunch(self):
        (self.directory / "review-worktree").mkdir()
        candidate = self.plan["base_commit"]
        unregistered = {key: value for key, value in self.reviewer_row().items() if key != "pid"}
        inventories = [[], [], [unregistered], [unregistered], [self.reviewer_row()]]
        with patch.object(self.sessions, "inventory", side_effect=inventories) as inventory, \
                patch("workflow.interactive.git", side_effect=[candidate, ""]), \
                patch("workflow.interactive.subprocess.run", side_effect=self.started) as launch, \
                patch("workflow.interactive.time.sleep") as sleep:
            result = self.sessions.run_reviewer("review", "prompt", self.TOKEN, candidate)
        self.assertEqual((result["status"], result["background_id"]), ("attached_session_available", self.reviewer_row()["id"]))
        self.assertEqual((launch.call_count, inventory.call_count, sleep.call_count), (1, 5, 3))
        # A reviewer whose PID never registers is left for reconciliation, never relaunched.
        (self.directory / "review.interactive.json").unlink()
        self.sessions.settle_seconds = 0
        with patch.object(self.sessions, "inventory", side_effect=[[], [unregistered]]), \
                patch("workflow.interactive.git", side_effect=[candidate, ""]), \
                patch("workflow.interactive.subprocess.run", side_effect=self.started) as launch:
            with self.assertRaisesRegex(RuntimeError, "No live native PID"):
                self.sessions.run_reviewer("review", "prompt", self.TOKEN, candidate)
        self.assertEqual(launch.call_count, 1)
        receipt = read_json(self.directory / "review.interactive.json")
        self.assertEqual(receipt["status"], "needs_reconciliation")
        with patch.object(self.sessions, "inventory", return_value=[]), patch("workflow.interactive.subprocess.run") as launch:
            with self.assertRaisesRegex(RuntimeError, "reconcile|relaunch"):
                self.sessions.run_reviewer("review", "prompt", self.TOKEN, candidate)
            launch.assert_not_called()

    def test_reviewer_launch_requires_the_clean_candidate_worktree(self):
        candidate = self.plan["base_commit"]
        with patch("workflow.interactive.subprocess.run") as launch:
            with self.assertRaisesRegex(RuntimeError, "worktree"):
                self.sessions.run_reviewer("review", "prompt", self.TOKEN, candidate)
            (self.directory / "review-worktree").mkdir()
            with patch("workflow.interactive.git", side_effect=["0" * 40, ""]):
                with self.assertRaisesRegex(RuntimeError, "candidate"):
                    self.sessions.run_reviewer("review", "prompt", self.TOKEN, candidate)
            with patch("workflow.interactive.git", side_effect=[candidate, " M file"]):
                with self.assertRaisesRegex(RuntimeError, "candidate"):
                    self.sessions.run_reviewer("review", "prompt", self.TOKEN, candidate)
            with patch("workflow.interactive.git", side_effect=[candidate, ""]), \
                    patch.object(self.sessions, "inventory", return_value=[self.reviewer_row()]):
                with self.assertRaisesRegex(RuntimeError, "launch name"):
                    self.sessions.run_reviewer("review", "prompt", self.TOKEN, candidate)
            launch.assert_not_called()
        self.assertFalse((self.directory / "review.interactive.json").exists())

    def test_locate_reviewer_binds_the_review_worktree(self):
        self.reviewer_receipt()
        self.assertEqual(self.sessions.node_worktree("review"), self.directory / "review-worktree")
        self.assertEqual(self.sessions.node_worktree("ui"), Path(self.plan["nodes"]["ui"]["worktree"]))
        self.assertEqual(self.sessions.locate("review", [self.reviewer_row(), self.row()])["sessionId"], self.REVIEWER_UUID)
        for row in [self.reviewer_row(cwd=self.plan["nodes"]["ui"]["worktree"]), self.reviewer_row(name=self.sessions.launch_name("ui")),
                    self.reviewer_row(state="exited"), self.reviewer_row(pid=None)]:
            with self.assertRaises(RuntimeError):
                self.sessions.locate("review", [row])
        self.assertIsNone(self.sessions.locate("review", [self.row()]))
        with self.assertRaisesRegex(RuntimeError, "UUID changed"):
            self.sessions.locate("review", [self.reviewer_row(sessionId="44444444-4444-4444-8444-444444444444")])

    def test_worker_launch_records_the_exact_prompt(self):
        def started(*args, **kwargs):
            kwargs["stdout"].write(f"claude attach {self.row()['id']}    open in this terminal\n")
            return subprocess.CompletedProcess([], 0)
        with patch.object(self.sessions, "inventory", side_effect=[[], [self.row()]]), patch("workflow.interactive.git", side_effect=[self.plan["base_commit"], ""]), \
                patch("workflow.interactive.subprocess.run", side_effect=started) as launch:
            self.sessions.run("ui")
        prompt = self.directory / "ui.prompt.txt"
        self.assertEqual(prompt.read_text(), launch.call_args.args[0][-1])
        self.assertIn(self.plan["nodes"]["ui"]["task"], prompt.read_text())
        self.assertEqual(prompt.stat().st_mode & 0o777, 0o600)

    def test_panels_attach_reviewer_as_third_pane_when_its_receipt_exists(self):
        from .sessions import plan_digest
        for node in ("ui", "adapter"):
            save_json(self.directory / f"{node}.interactive.json", {"plan_digest": plan_digest(self.plan), "background_id": self.row(node)["id"], "session_id": self.row(node)["sessionId"]})
        self.reviewer_receipt()
        calls = []
        with patch.object(self.sessions, "inventory", return_value=[self.row(), self.row("adapter"), self.reviewer_row()]), \
                patch("workflow.interactive.herdr", side_effect=self.fake_herdr(calls)):
            mapping = attach_panels(self.sessions)
        self.assertEqual(list(mapping), ["ui", "adapter", "review"])
        self.assertEqual(mapping["review"], {"pane_id": "w1:p4", "tab_id": "w1:t2", "mode": "attach_requested", "session_id": self.REVIEWER_UUID})
        splits = [call for call in calls if call[:2] == ("pane", "split")]
        self.assertEqual(len(splits), 2)
        self.assertEqual((splits[1][splits[1].index("--pane") + 1], splits[1][splits[1].index("--direction") + 1]), ("w1:p3", "right"))
        self.assertIn(("pane", "rename", "w1:p4", "Claude: reviewer"), calls)
        runs = [call for call in calls if call[:2] == ("pane", "run") and call[2] == "w1:p4"]
        self.assertEqual(len(runs), 1)
        self.assertIn("attach-one", runs[0][3])
        self.assertIn("--node review", runs[0][3])
        self.assertEqual(read_json(self.directory / "terminals.json"), mapping)

    def test_attach_reviewer_panel_extends_existing_mapping_and_refuses_duplicates(self):
        from .interactive import attach_reviewer_panel
        calls = []
        with patch("workflow.interactive.herdr", side_effect=self.fake_herdr(calls)), \
                patch.object(self.sessions, "inventory", return_value=[self.row(), self.row("adapter"), self.reviewer_row()]):
            with self.assertRaisesRegex(RuntimeError, "terminal"):
                attach_reviewer_panel(self.sessions)  # No worker panes yet.
            mapping = {"ui": {"pane_id": "w1:p2", "tab_id": "w1:t2", "mode": "attach_requested", "session_id": self.row()["sessionId"]},
                       "adapter": {"pane_id": "w1:p3", "tab_id": "w1:t2", "mode": "attach_requested", "session_id": self.row("adapter")["sessionId"]}}
            save_json(self.directory / "terminals.json", mapping)
            with self.assertRaisesRegex(RuntimeError, "reviewer"):
                attach_reviewer_panel(self.sessions)  # No reviewer receipt yet.
            self.reviewer_receipt()
            result = attach_reviewer_panel(self.sessions)
            self.assertEqual(result["review"], {"pane_id": "w1:p3", "tab_id": "w1:t2", "mode": "attach_requested", "session_id": self.REVIEWER_UUID})
            self.assertEqual(result["ui"], mapping["ui"])
            self.assertEqual(read_json(self.directory / "terminals.json"), result)
            with self.assertRaisesRegex(RuntimeError, "already"):
                attach_reviewer_panel(self.sessions)
        splits = [call for call in calls if call[:2] == ("pane", "split")]
        self.assertEqual(len(splits), 1)
        self.assertEqual(splits[0][splits[0].index("--pane") + 1], "w1:p3")
        self.assertIn(("pane", "rename", "w1:p3", "Claude: reviewer"), calls)
        self.assertEqual(len([call for call in calls if call[:2] == ("pane", "run")]), 1)

    def test_attach_adds_the_reviewer_pane_to_the_existing_workflow_tab(self):
        # `attach` after the review node started: the workers' tab exists, the reviewer does not have a pane yet.
        from .sessions import plan_digest
        for node in ("ui", "adapter"):
            save_json(self.directory / f"{node}.interactive.json", {"plan_digest": plan_digest(self.plan), "background_id": self.row(node)["id"], "session_id": self.row(node)["sessionId"]})
        existing = {"ui": {"pane_id": "w1:p5", "tab_id": "w1:t2", "mode": "attach_requested", "session_id": self.row()["sessionId"]},
                    "adapter": {"pane_id": "w1:p6", "tab_id": "w1:t2", "mode": "attach_requested", "session_id": self.row("adapter")["sessionId"]}}
        save_json(self.directory / "terminals.json", existing)
        calls = []
        with patch.object(self.sessions, "inventory", return_value=[self.row(), self.row("adapter"), self.reviewer_row()]), \
                patch("workflow.interactive.herdr", side_effect=self.fake_herdr(calls)):
            with self.assertRaisesRegex(RuntimeError, "already exist"):
                attach_panels(self.sessions)  # No reviewer yet: the existing refusal stands.
            self.reviewer_receipt()
            mapping = attach_panels(self.sessions)
            with self.assertRaisesRegex(RuntimeError, "already exist"):
                attach_panels(self.sessions)  # The reviewer pane exists now: refuse again rather than duplicate it.
        self.assertEqual(list(mapping), ["ui", "adapter", "review"])
        self.assertEqual((mapping["ui"], mapping["adapter"]), (existing["ui"], existing["adapter"]))
        self.assertEqual(mapping["review"], {"pane_id": "w1:p3", "tab_id": "w1:t2", "mode": "attach_requested", "session_id": self.REVIEWER_UUID})
        self.assertEqual(read_json(self.directory / "terminals.json"), mapping)
        self.assertFalse(any(call[:2] == ("tab", "create") for call in calls))
        splits = [call for call in calls if call[:2] == ("pane", "split")]
        self.assertEqual(len(splits), 1)
        self.assertEqual((splits[0][splits[0].index("--pane") + 1], splits[0][splits[0].index("--direction") + 1]), ("w1:p6", "right"))
        self.assertIn(("pane", "rename", "w1:p3", "Claude: reviewer"), calls)
        runs = [call for call in calls if call[:2] == ("pane", "run")]
        self.assertEqual(len(runs), 1)
        self.assertEqual(runs[0][2], "w1:p3")
        self.assertIn("workflow.interactive attach-one", runs[0][3])
        self.assertIn("--node review", runs[0][3])

    # ---- Declared reviewers: one session, one pane and one completion file per reviewer ---------------------

    REVIEWERS = ["general", "coverage"]

    def declare_reviewers(self):
        self.plan["reviewers"] = [{"reviewer_id": reviewer_id, "prompt": f"Look at {reviewer_id}."} for reviewer_id in self.REVIEWERS]
        save_json(self.directory / "plan.json", self.plan)
        self.sessions = InteractiveSessions(self.directory, executable="claude")

    def declared_row(self, reviewer_id, **updates):
        uuid = {"general": "55555555-5555-4555-8555-555555555555", "coverage": "66666666-6666-4666-8666-666666666666"}[reviewer_id]
        return {"sessionId": uuid, "id": uuid[:8], "name": self.sessions.launch_name(f"review-{reviewer_id}"), "kind": "background",
                "cwd": str(self.directory / "review-worktree"), "state": "idle", "pid": os.getpid(), **updates}

    def declared_receipt(self, reviewer_id):
        from .sessions import plan_digest
        row = self.declared_row(reviewer_id)
        save_json(self.directory / f"review-{reviewer_id}.interactive.json", {"plan_digest": plan_digest(self.plan), "background_id": row["id"],
                                                                                "session_id": row["sessionId"], "node_id": f"review-{reviewer_id}"})

    def test_declared_reviewer_launches_under_its_own_node_name_and_files(self):
        self.declare_reviewers()
        (self.directory / "review-worktree").mkdir()
        candidate = self.plan["base_commit"]
        def started(*args, **kwargs):
            kwargs["stdout"].write(f"claude attach {self.declared_row('coverage')['id']}    open in this terminal\n")
            return subprocess.CompletedProcess([], 0)
        with patch.object(self.sessions, "inventory", side_effect=[[], [self.declared_row("coverage")], [self.declared_row("coverage")]]), \
                patch("workflow.interactive.git", side_effect=[candidate, ""]), \
                patch("workflow.interactive.subprocess.run", side_effect=started) as launch:
            receipt = self.sessions.run_reviewer("coverage", "Coverage brief.", self.TOKEN, candidate)
            self.assertEqual(self.sessions.run_reviewer("coverage", "Coverage brief.", self.TOKEN, candidate)["status"], "attached_session_available")
        self.assertEqual(launch.call_count, 1)
        self.assertEqual((receipt["node_id"], receipt["session_id"], receipt["worktree"]), ("review-coverage", self.declared_row("coverage")["sessionId"], str(self.directory / "review-worktree")))
        command = launch.call_args.args[0]
        self.assertEqual(command[command.index("--name") + 1], f"workflow-{self.plan['run_id']}-reviewer-coverage")
        self.assertEqual(self.sessions.launch_name("review-coverage"), f"workflow-{self.plan['run_id']}-reviewer-coverage")
        self.assertEqual(self.sessions.launch_name("review"), f"workflow-{self.plan['run_id']}-reviewer")
        self.assertEqual(command[command.index("--allowedTools") + 1], f"Edit(//{str(self.directory / 'review-coverage.completion.json').lstrip('/')})")
        self.assertEqual(command[-1], "Coverage brief.")
        self.assertEqual((self.directory / "review-coverage.prompt.txt").read_text(), "Coverage brief.")
        self.assertIn("claude attach", (self.directory / "review-coverage.launch.log").read_text())
        self.assertFalse((self.directory / "review.interactive.json").exists())
        self.assertEqual(self.sessions.node_worktree("review-coverage"), self.directory / "review-worktree")
        # The other reviewer's session is not this one: locate binds by the exact background id and name.
        self.assertIsNone(self.sessions.locate("review-general", [self.declared_row("coverage")]))
        with self.assertRaises(RuntimeError):
            self.sessions.locate("review-coverage", [self.declared_row("coverage", name=self.sessions.launch_name("review-general"))])

    def test_declared_reviewers_get_one_pane_each_in_declared_order_right_of_the_workers(self):
        from .sessions import plan_digest
        self.declare_reviewers()
        for node in ("ui", "adapter"):
            save_json(self.directory / f"{node}.interactive.json", {"plan_digest": plan_digest(self.plan), "background_id": self.row(node)["id"], "session_id": self.row(node)["sessionId"]})
        for reviewer_id in self.REVIEWERS:
            self.declared_receipt(reviewer_id)
        calls = []
        splits = iter(["w1:p3", "w1:p4", "w1:p5"])
        def herdr(*args):
            calls.append(args)
            if args[:2] == ("pane", "current"):
                return {"result": {"pane": {"workspace_id": "w1", "tab_id": "w1:t1"}}}
            if args[:2] == ("tab", "create"):
                return {"result": {"tab": {"tab_id": "w1:t2"}, "root_pane": {"pane_id": "w1:p2"}}}
            if args[:2] == ("pane", "split"):
                return {"result": {"pane": {"pane_id": next(splits)}}}
            if args[:2] == ("pane", "process-info"):
                return {"result": {"process_info": {"shell_pid": 1, "foreground_processes": [{"pid": 1}]}}}
            return {}
        rows = [self.row(), self.row("adapter"), self.declared_row("general"), self.declared_row("coverage")]
        with patch.object(self.sessions, "inventory", return_value=rows), patch("workflow.interactive.herdr", side_effect=herdr):
            mapping = attach_panels(self.sessions)
        self.assertEqual(list(mapping), ["ui", "adapter", "review-general", "review-coverage"])
        self.assertEqual([entry["pane_id"] for entry in mapping.values()], ["w1:p2", "w1:p3", "w1:p4", "w1:p5"])
        splits_made = [(call[call.index("--pane") + 1], call[call.index("--direction") + 1]) for call in calls if call[:2] == ("pane", "split")]
        self.assertEqual(splits_made, [("w1:p2", "right"), ("w1:p3", "right"), ("w1:p4", "right")])
        self.assertIn(("pane", "rename", "w1:p4", "Claude: reviewer general"), calls)
        self.assertIn(("pane", "rename", "w1:p5", "Claude: reviewer coverage"), calls)
        runs = [call for call in calls if call[:2] == ("pane", "run")]
        self.assertIn("--node review-general", runs[2][3])
        self.assertIn("--node review-coverage", runs[3][3])
        self.assertEqual(mapping["review-coverage"]["session_id"], self.declared_row("coverage")["sessionId"])
        # attach-one accepts every reviewer node of the plan and reconnects it in the shared review worktree.
        from .interactive import main
        with patch("workflow.interactive.sys.argv", ["interactive", "attach-one", str(self.directory), "--node", "review"]), \
                patch("workflow.interactive.sys.stdin") as stdin, contextlib.redirect_stderr(io.StringIO()) as errors:
            stdin.isatty.return_value = True
            with self.assertRaises(SystemExit):
                main()
        self.assertIn("--node must be a lane of this run (ui, adapter) or review-general, review-coverage", errors.getvalue())
        with patch("workflow.interactive.sys.argv", ["interactive", "attach-one", str(self.directory), "--node", "review-coverage"]), \
                patch("workflow.interactive.sys.stdin") as stdin, patch.object(InteractiveSessions, "inventory", return_value=[self.declared_row("coverage")]), \
                patch("workflow.interactive.subprocess.run", return_value=subprocess.CompletedProcess([], 0)) as attach:
            stdin.isatty.return_value = True
            main()  # `claude attach` exited 0 with the session alive: the operator detached.
        attach.assert_called_once_with(["claude", "attach", self.declared_row("coverage")["id"]], cwd=self.directory / "review-worktree")

    def test_reviewer_panes_are_added_one_at_a_time_as_the_review_node_launches_each_reviewer(self):
        from .interactive import attach_reviewer_panel
        self.declare_reviewers()
        mapping = {"ui": {"pane_id": "w1:p2", "tab_id": "w1:t2", "mode": "attach_requested", "session_id": self.row()["sessionId"]},
                   "adapter": {"pane_id": "w1:p3", "tab_id": "w1:t2", "mode": "attach_requested", "session_id": self.row("adapter")["sessionId"]}}
        save_json(self.directory / "terminals.json", mapping)
        calls = []
        splits = iter(["w1:p4", "w1:p5"])
        def herdr(*args):
            calls.append(args)
            if args[:2] == ("pane", "split"):
                return {"result": {"pane": {"pane_id": next(splits)}}}
            if args[:2] == ("pane", "process-info"):
                return {"result": {"process_info": {"shell_pid": 1, "foreground_processes": [{"pid": 1}]}}}
            return {}
        rows = [self.row(), self.row("adapter"), self.declared_row("general"), self.declared_row("coverage")]
        with patch("workflow.interactive.herdr", side_effect=herdr), patch.object(self.sessions, "inventory", return_value=rows):
            with self.assertRaisesRegex(RuntimeError, "No reviewer session receipt"):
                attach_reviewer_panel(self.sessions)
            self.declared_receipt("general")  # The review node launched the first reviewer.
            first = attach_reviewer_panel(self.sessions)
            self.assertEqual(list(first), ["ui", "adapter", "review-general"])
            self.assertEqual(first["review-general"]["pane_id"], "w1:p4")
            with self.assertRaisesRegex(RuntimeError, "already allocated; use attach-one --node review-general"):
                attach_reviewer_panel(self.sessions)
            self.declared_receipt("coverage")  # Then the second: its pane splits right of the first reviewer's.
            second = attach_reviewer_panel(self.sessions)
            self.assertEqual(list(second), ["ui", "adapter", "review-general", "review-coverage"])
            self.assertEqual(second["review-coverage"]["pane_id"], "w1:p5")
            with self.assertRaisesRegex(RuntimeError, "already allocated"):
                attach_reviewer_panel(self.sessions)
            with self.assertRaisesRegex(RuntimeError, "already exist"):
                attach_panels(self.sessions)
        splits_made = [(call[call.index("--pane") + 1], call[call.index("--direction") + 1]) for call in calls if call[:2] == ("pane", "split")]
        self.assertEqual(splits_made, [("w1:p3", "right"), ("w1:p4", "right")])
        self.assertIn(("pane", "rename", "w1:p4", "Claude: reviewer general"), calls)
        self.assertIn(("pane", "rename", "w1:p5", "Claude: reviewer coverage"), calls)
        self.assertEqual(read_json(self.directory / "terminals.json"), second)

    def test_attach_one_reconnects_the_reviewer_in_its_worktree(self):
        from .interactive import main
        self.reviewer_receipt()
        with patch("workflow.interactive.sys.argv", ["interactive", "attach-one", str(self.directory), "--node", "review"]), \
                patch("workflow.interactive.sys.stdin") as stdin, patch.object(InteractiveSessions, "inventory", return_value=[self.reviewer_row()]), \
                patch("workflow.interactive.subprocess.run", return_value=subprocess.CompletedProcess([], 0)) as attach:
            stdin.isatty.return_value = True
            main()  # `claude attach` exited 0 with the session alive: the operator detached.
        attach.assert_called_once_with(["claude", "attach", self.reviewer_row()["id"]], cwd=self.directory / "review-worktree")


class AttachOneTests(unittest.TestCase):
    """attach-one keeps a pane attached across a background-service restart, ends on the controller's stop, never restarts a session."""

    STOPPED_AT = "2026-09-23T20:08:49.736893Z"

    def setUp(self):
        from .sessions import plan_digest
        InteractiveTests.setUp(self)
        save_json(self.directory / "ui.interactive.json", {"plan_digest": plan_digest(self.plan), "background_id": self.row()["id"],
                                                           "session_id": self.row()["sessionId"], "node_id": "ui"})
        self.worktree = Path(self.plan["nodes"]["ui"]["worktree"])

    row = InteractiveTests.row

    def exited(self, code):
        return subprocess.CompletedProcess(["claude", "attach", self.row()["id"]], code)

    def process(self):
        """A live process for a row to list as the session's PID; killed and reaped at cleanup."""
        native = subprocess.Popen(["sleep", "60"])
        self.addCleanup(native.wait)
        self.addCleanup(native.kill)
        return native

    def respawned(self, code, native, reap=True):
        """`claude attach` ends as `code` while the service ends the attached process `native` (reaped, or left a zombie)."""
        def attach(*args, **kwargs):
            native.kill()
            if reap:
                native.wait()
            else:
                for _ in range(500):  # Uncollected: it still answers kill(pid, 0) until its parent reaps it.
                    if Path(f"/proc/{native.pid}/stat").read_text().rsplit(")", 1)[1].split()[0] == "Z":
                        break
                    time.sleep(0.01)
            return self.exited(code)
        return attach

    def in_turn(self, *ends):
        """`claude attach` ends as each of `ends` in turn: a result, or a callable that is that attach (a respawn)."""
        ends = iter(ends)
        def attach(*args, **kwargs):
            end = next(ends)
            return end(*args, **kwargs) if callable(end) else end
        return attach

    def attach_one(self, attaches, inventory, clock=None):
        """attach_one for lane ui: `claude attach` ends as `attaches`, the inventory answers `inventory`; the fakes stay on self."""
        from .interactive import attach_one
        self.sleep, self.errors = Mock(), io.StringIO()
        with patch.object(InteractiveSessions, "inventory", side_effect=inventory) as self.inventory, \
                patch("workflow.interactive.subprocess.run", side_effect=attaches) as self.attaches, contextlib.redirect_stderr(self.errors):
            return attach_one(self.sessions, "ui", clock=clock or (lambda: 0.0), sleep=self.sleep)

    def main(self, node="ui", attaches=None, inventory=()):
        """`python -m workflow.interactive attach-one <run> --node <node>` in a terminal; returns the exit status and stderr."""
        from .interactive import main
        errors = io.StringIO()
        with patch("workflow.interactive.sys.argv", ["interactive", "attach-one", str(self.directory), "--node", node]), \
                patch("workflow.interactive.sys.stdin") as stdin, patch.object(InteractiveSessions, "inventory", side_effect=inventory) as self.inventory, \
                patch("workflow.interactive.subprocess.run", side_effect=attaches) as self.attaches, contextlib.redirect_stderr(errors):
            stdin.isatty.return_value = True
            try:
                main()
            except SystemExit as error:
                return error.code, errors.getvalue()
        return 0, errors.getvalue()

    def record_stop(self, node="ui", confirmed=True, events=()):
        """What the controller's stop leaves: the identity-checked marker, then (once confirmed) the timeline event."""
        save_json(self.directory / f"{node}.stop.json", {"background_id": self.row()["id"], "session_id": self.row()["sessionId"],
                                                         "pid": self.row()["pid"], "stopped": confirmed})
        lines = [{"sequence": index + 1, "time": time, "node": event, "status": status, "message": message}
                 for index, (time, event, status, message) in enumerate(events)]
        (self.directory / "events.jsonl").write_text("".join(json.dumps(line) + "\n" for line in lines))

    def test_a_lost_connection_reattaches_the_same_session(self):
        # A Claude Code update restarts the background service: `claude attach` exits 1 ("Couldn't reconnect to <id> -
        # background service is unavailable"), the restarted service adopts the live session and the pane attaches it again.
        self.attach_one([self.exited(1), self.exited(0)], itertools.repeat([self.row()]))
        attach = call(["claude", "attach", self.row()["id"]], cwd=self.worktree)
        self.assertEqual(self.attaches.call_args_list, [attach, attach])
        self.sleep.assert_called_once_with(2)
        self.assertEqual(self.errors.getvalue(), f"Lost the connection to ui ({self.row()['id']}); the background service may be restarting. "
                                                 "Reattaching in 2s…\n")

    def test_a_detach_ends_attach_one_quietly(self):
        # Ctrl+Z, or ← to the agent view: `claude attach` exits 0 and the session keeps running. An attach the
        # operator interrupted (130, or killed by SIGINT) ends the same way.
        for code in (0, 130, -2):
            with self.subTest(code=code):
                self.assertIsNone(self.attach_one([self.exited(code)], itertools.repeat([self.row()])))
                self.attaches.assert_called_once_with(["claude", "attach", self.row()["id"]], cwd=self.worktree)
                self.sleep.assert_not_called()
                self.assertEqual(self.errors.getvalue(), "")

    def test_a_stop_recorded_by_the_controller_ends_attach_one_without_a_reattach(self):
        # The freeze stops the session under the attached pane: `claude attach` reports that it exited (0) or loses it (1).
        stopped = [(self.STOPPED_AT, "freeze", "stopped", "Native workers stopped before snapshot capture: ui, adapter")]
        for code in (0, 1):
            with self.subTest(code=code):
                def stop(*args, **kwargs):
                    self.record_stop(events=stopped)
                    return self.exited(code)
                self.assertIsNone(self.attach_one(stop, [[self.row()], []]))
                self.assertEqual(self.attaches.call_count, 1)
                self.sleep.assert_not_called()
                self.assertEqual(self.errors.getvalue(), "Worker ui was stopped by the controller at 2026-09-23 20:08:49 UTC "
                                                         "(Native workers stopped before snapshot capture: ui, adapter); nothing to attach.\n")
                (self.directory / "ui.stop.json").unlink()

    def test_attach_one_after_the_stop_reports_it_once_and_starts_nothing(self):
        # What a manual reconnect loop turned into endless spam: now one line, exit 0, and not even a listing.
        self.record_stop(events=[("2026-09-23T20:08:40.000000Z", "controller", "blocked", "Worker ui deadline exhausted; no automatic relaunch"),
                                 (self.STOPPED_AT, "freeze", "stopped", "Native workers stopped before snapshot capture: ui, adapter")])
        code, errors = self.main()
        self.assertEqual(code, 0)
        self.assertEqual(errors, "Worker ui was stopped by the controller at 2026-09-23 20:08:49 UTC "
                                 "(the run blocked: Worker ui deadline exhausted; no automatic relaunch); nothing to attach.\n")
        self.inventory.assert_not_called()
        self.attaches.assert_not_called()
        # A reviewer's stop is its own event; an intent the controller has not confirmed yet is still its stop.
        from .sessions import plan_digest
        save_json(self.directory / "review.interactive.json", {"plan_digest": plan_digest(self.plan), "background_id": "33333333", "node_id": "review"})
        self.record_stop("review", events=[(self.STOPPED_AT, "review", "stopped", "Reviewer review session stopped; its transcript stays resumable")])
        self.assertEqual(self.main("review"), (0, "Reviewer review was stopped by the controller at 2026-09-23 20:08:49 UTC "
                                                  "(Reviewer review session stopped; its transcript stays resumable); nothing to attach.\n"))
        self.record_stop(confirmed=False)
        code, errors = self.main()
        self.assertEqual(code, 0)
        self.assertRegex(errors, r"^The controller is stopping ui \(requested at \d{4}-\d\d-\d\d \d\d:\d\d:\d\d UTC, not yet confirmed\); "
                                 rf"not attaching\. Inspect it with `claude logs {self.row()['id']}` or `claude attach {self.row()['id']}`\.\n$")
        self.attaches.assert_not_called()

    def test_a_session_gone_without_a_recorded_stop_is_refused_once(self):
        # The native process ended (a crash, or /exit typed in the pane) and the controller recorded no stop.
        # `claude attach` would wake it again, so attach-one refuses once and never restarts it, after the grace a respawn
        # gets (zero here; test_an_ended_process_with_no_new_one_is_refused_after_a_grace waits it out).
        for code, listed in ((1, []), (0, [])):
            with self.subTest(code=code, listed=listed), patch("workflow.interactive.DEAD_PID_GRACE_SECONDS", 0):
                native = subprocess.Popen(["sleep", "60"])
                self.addCleanup(native.wait)
                self.addCleanup(native.kill)
                row = self.row(pid=native.pid)
                def ended(*args, **kwargs):
                    native.kill()  # Left uncollected, as a zombie, until its parent reaps it: it still answers kill(pid, 0).
                    for _ in range(500):
                        if Path(f"/proc/{native.pid}/stat").read_text().rsplit(")", 1)[1].split()[0] == "Z":
                            break
                        time.sleep(0.01)
                    return self.exited(code)
                status, errors = self.main(attaches=ended, inventory=[[row], listed])
                self.assertEqual(status, 1)
                self.assertEqual(errors.count("Blocked:"), 1)
                self.assertIn("Blocked: Session unavailable; refusing implicit restart\n", errors)
                self.assertNotIn("Reattaching", errors)
                self.assertEqual(self.attaches.call_count, 1)

    def test_a_listing_gap_while_the_process_lives_is_waited_out(self):
        # Mid-update the CLI is missing and the restarted service lists nothing yet, while the session's process runs on.
        missing = FileNotFoundError(2, "No such file or directory", "claude")
        self.attach_one([self.exited(1), missing, self.exited(0)], [[self.row()], missing, [], *[[self.row()]] * 4])
        self.assertEqual(self.sleep.call_args_list, [call(2), call(4), call(8)])
        self.assertEqual(self.attaches.call_count, 3)  # The second attach found the CLI missing: retried like a lost connection.
        self.assertEqual(self.inventory.call_count, 7)
        waiting = f"The background service does not list ui ({self.row()['id']}) yet; retrying in {{}}s…"
        lost = f"Lost the connection to ui ({self.row()['id']}); the background service may be restarting. Reattaching in {{}}s…"
        self.assertEqual(self.errors.getvalue().splitlines(), [lost.format(2), waiting.format(4), lost.format(8)])

    def test_every_listing_failure_while_the_process_lives_is_waited_out(self):
        # How the listing fails while the service restarts is Claude Code's business (a timeout, a non-zero exit,
        # output it cannot parse, raised as whatever error it chooses): while the attached process lives, each is a gap.
        class Unavailable(RuntimeError):
            pass
        unavailable = Unavailable("Claude session inventory unavailable: Command '['claude', 'agents', '--json']' returned non-zero exit status 1.")
        self.attach_one([self.exited(1), self.exited(0)], [[self.row()], unavailable, unavailable, [self.row()], [self.row()]])
        attach = call(["claude", "attach", self.row()["id"]], cwd=self.worktree)
        self.assertEqual(self.attaches.call_args_list, [attach, attach])
        self.assertEqual(self.sleep.call_args_list, [call(2), call(4)])
        self.assertEqual(self.errors.getvalue().splitlines(),
                         [f"Lost the connection to ui ({self.row()['id']}); the background service may be restarting. Reattaching in 2s…",
                          f"The background service does not list ui ({self.row()['id']}) yet; retrying in 4s…"])
        # A first attach has no process to wait for: the listing's failure is raised at once, as before.
        with self.assertRaises(Unavailable):
            self.attach_one([], [unavailable])
        self.attaches.assert_not_called()
        # A refusal of the session's identity is a verdict, not a gap: raised at once, even while the process lives.
        with self.assertRaisesRegex(RuntimeError, "identity/worktree mismatch"):
            self.attach_one([self.exited(1)], [[self.row()], [self.row(cwd=str(self.root))]])
        self.sleep.assert_not_called()

    def test_a_session_respawned_under_a_new_pid_is_reattached(self):
        # About 15 seconds after an update restarts the background service, it respawns each idle session onto the new binary:
        # the attached process ends and the same background id comes back under a new PID. On the way `claude attach` exits 1,
        # or 0 ("Session <id> has exited."), and the listing (A) lists the row without a PID yet, (B) fails, (C) already lists
        # the new PID, (D) still lists the ended one, or (E) omits the id: without --all `claude agents` skips a finished
        # (`done`) session that has no process. Each is followed to the new process; the pane is never left dead.
        from .sessions import TransientInfraError
        unavailable = TransientInfraError("Claude session inventory unavailable for 60s: `claude agents --json` exited 1")
        for case, code in (("A", 1), ("B", 1), ("C", 0), ("D", 1), ("E", 1), ("E", 0)):
            with self.subTest(case=case, code=code):
                old, new = self.process(), self.process()
                between = {"A": [[self.row(pid=None)], [self.row(state="starting", pid=None)]], "B": [unavailable],
                           "C": [], "D": [[self.row(pid=old.pid)]], "E": [[]]}[case]
                self.attach_one(self.in_turn(self.respawned(code, old), self.exited(0)),
                                itertools.chain([[self.row(pid=old.pid, state="done")]], between,
                                                itertools.repeat([self.row(pid=new.pid, state="done")])))
                attach = call(["claude", "attach", self.row()["id"]], cwd=self.worktree)
                self.assertEqual(self.attaches.call_args_list, [attach, attach])
                # After exit 0 a gap leaves the attach undecided until a row shows the new PID, one more wait.
                self.assertEqual(self.sleep.call_args_list, [call(2), call(4)][:max(len(between), 1) + (code == 0 and bool(between))])
                if case == "C":
                    self.assertEqual(self.errors.getvalue(), f"The background service respawned ui ({self.row()['id']}) as PID {new.pid}; "
                                                             "reattaching in 2s…\n")

    def test_an_attach_that_ends_cleanly_under_a_changed_pid_is_reattached(self):
        # An operator's detach (exit 0) never changes the session's PID, so a live row under a new PID after it is the service
        # moving the session, even while the old process lingers. The detach that follows ends attach-one quietly.
        new = self.process()
        self.attach_one([self.exited(0), self.exited(0)], itertools.chain([[self.row()]], itertools.repeat([self.row(pid=new.pid)])))
        self.assertEqual(self.attaches.call_count, 2)
        self.sleep.assert_called_once_with(2)
        self.assertEqual(self.inventory.call_count, 4)

    def test_an_ended_process_with_no_new_one_is_refused_after_a_grace(self):
        # A respawn lists its new PID within seconds. A row that still lists the ended process (reaped, or a zombie that locate's
        # kill(pid, 0) still answers for), or a listing that still omits the finished session, after DEAD_PID_GRACE_SECONDS
        # is a session that ended: refused, never restarted. Both count towards the same grace.
        from .interactive import DEAD_PID_GRACE_SECONDS
        ended, unavailable = "Native process is unavailable; refusing implicit restart", "Session unavailable; refusing implicit restart"
        for listed, reap, code, refusal in (("dead", True, 1, ended), ("dead", False, 1, ended), ("none", True, 1, unavailable),
                                            ("none", True, 0, unavailable), ("both", True, 1, unavailable)):
            with self.subTest(listed=listed, reap=reap, code=code):
                old = self.process()
                dead, gone = [self.row(pid=old.pid, state="done")], []
                listings = {"dead": itertools.repeat(dead), "none": itertools.repeat(gone), "both": itertools.cycle([dead, gone])}[listed]
                elapsed = lambda: float(sum(item.args[0] for item in self.sleep.call_args_list))
                with self.assertRaisesRegex(RuntimeError, rf"^{refusal}$"):
                    self.attach_one(self.respawned(code, old, reap=reap), itertools.chain([dead], listings), clock=elapsed)
                delays = [item.args[0] for item in self.sleep.call_args_list]
                self.assertEqual(delays, [2, 4, 8, 10, 10])
                self.assertLess(sum(delays[:-1]), DEAD_PID_GRACE_SECONDS)
                self.assertGreaterEqual(sum(delays), DEAD_PID_GRACE_SECONDS)
                self.assertEqual(self.attaches.call_count, 1)

    def test_a_terminal_state_or_a_first_attach_is_refused_at_once(self):
        # Not gaps, whatever became of the attached process: a row the service reports stopped or failed, and a first attach
        # that finds no row, since nothing was verified live and attached. Refused at once, never waited for, never restarted.
        with self.assertRaisesRegex(RuntimeError, r"^Session unavailable; refusing implicit restart$"):
            self.attach_one([], [[]])
        self.sleep.assert_not_called()
        self.attaches.assert_not_called()
        for state in ("stopped", "failed"):
            with self.subTest(state=state):
                with self.assertRaisesRegex(RuntimeError, rf"^Session is not attachable: '{state}'"):
                    self.attach_one([self.exited(1)], [[self.row()], [self.row(state=state, pid=None)]])
                self.sleep.assert_not_called()
                self.assertEqual(self.attaches.call_count, 1)

    def test_a_stop_recorded_while_the_session_is_listed_is_honoured_before_the_attach(self):
        # The freeze writes its intent while attach-one looks the session up: the records are read again right before
        # `claude attach`, which would otherwise attach a session the controller is stopping.
        for lost in (False, True):
            with self.subTest(lost=lost):
                listings = []
                def listed():
                    listings.append(None)
                    if len(listings) == (3 if lost else 1):
                        self.record_stop(confirmed=False)
                    return [self.row()]
                self.assertIsNone(self.attach_one([self.exited(1)], listed))
                self.assertEqual(self.attaches.call_count, 1 if lost else 0)
                last = self.errors.getvalue().splitlines()[-1]
                self.assertRegex(last, r"^The controller is stopping ui \(requested at .* UTC, not yet confirmed\); not attaching\. "
                                       r"Inspect it with `claude logs 11111111` or `claude attach 11111111`\.$")
                (self.directory / "ui.stop.json").unlink()

    def test_giving_up_names_the_last_error(self):
        from .interactive import REATTACH_LIMIT
        from .sessions import TransientInfraError
        unavailable = TransientInfraError("Claude session inventory unavailable for 60s: `claude agents --json` exited 1: "
                                          "Couldn't reach the background service")
        with self.assertRaises(RuntimeError) as raised:
            self.attach_one([self.exited(1)], itertools.chain([[self.row()]], itertools.repeat(unavailable)))
        self.assertEqual(str(raised.exception), f"Gave up reattaching ui ({self.row()['id']}) after {REATTACH_LIMIT} attempts in a row; the session "
                                                f"may still be running. Rerun attach-one once `claude agents` lists it again; last error: {unavailable}")

    def test_reattaching_backs_off_to_a_cap_and_gives_up_after_the_limit(self):
        from .interactive import REATTACH_LIMIT
        with self.assertRaisesRegex(RuntimeError, rf"^Gave up reattaching ui \({self.row()['id']}\) after {REATTACH_LIMIT} attempts in a row; "
                                                  r".*; last error: `claude attach` exited 1$"):
            self.attach_one(itertools.repeat(self.exited(1)), itertools.repeat([self.row()]))
        delays = [item.args[0] for item in self.sleep.call_args_list]
        self.assertEqual(delays[:5], [2, 4, 8, 10, 10])
        self.assertEqual(max(delays), 10)
        self.assertEqual(len(delays), REATTACH_LIMIT - 1)
        self.assertEqual(self.attaches.call_count, REATTACH_LIMIT)

    def test_a_connection_that_held_starts_a_new_count(self):
        # Two quick losses, then an hour attached before the next update: the backoff starts again from its first delay.
        clock = iter([0.0, 1.0, 10.0, 20.0, 30.0, 3630.0, 3640.0, 3650.0]).__next__
        self.attach_one([self.exited(1), self.exited(1), self.exited(1), self.exited(0)], itertools.repeat([self.row()]), clock=clock)
        self.assertEqual(self.sleep.call_args_list, [call(2), call(4), call(2)])
        self.assertEqual(self.attaches.call_count, 4)

    def test_ctrl_c_ends_attach_one_without_a_traceback_or_a_reattach(self):
        code, errors = self.main(attaches=KeyboardInterrupt, inventory=itertools.repeat([self.row()]))
        self.assertEqual(code, 130)
        self.assertNotIn("Traceback", errors)
        self.assertIn("the ui session keeps running", errors)
        self.assertEqual(self.attaches.call_count, 1)
        # Interrupted while waiting to reattach: nothing more is attached either.
        from .interactive import attach_one
        with patch.object(InteractiveSessions, "inventory", return_value=[self.row()]), \
                patch("workflow.interactive.subprocess.run", return_value=self.exited(1)) as attach, contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(KeyboardInterrupt):
                attach_one(self.sessions, "ui", clock=lambda: 0.0, sleep=Mock(side_effect=KeyboardInterrupt))
        self.assertEqual(attach.call_count, 1)


if __name__ == "__main__":
    unittest.main()
