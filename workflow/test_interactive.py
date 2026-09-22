import os
import subprocess
import unittest
from pathlib import Path
from unittest.mock import patch

from langgraph.checkpoint.sqlite import SqliteSaver

from .interactive import InteractiveSessions, attach_panels, build_interactive_graph, require_shell
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

    def test_graph_launch_returns_human_handoff_not_verified_completion(self):
        with SqliteSaver.from_conn_string(str(self.directory / "interactive.sqlite")) as saver:
            with patch.object(self.sessions, "run", side_effect=lambda node: {"node": node, "status": "attached_session_available"}) as launch:
                graph = build_interactive_graph(saver, self.sessions)
                config = {"configurable": {"thread_id": "interactive"}, "max_concurrency": 2}
                result = graph.invoke({"run_id": "interactive"}, config)
                self.assertEqual(result["__interrupt__"][0].value["kind"], "interactive_workers_active")
                self.assertEqual(launch.call_count, 2)
                graph.invoke(None, config)
                self.assertEqual(launch.call_count, 2)

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
            receipt = self.sessions.run_reviewer("Review this candidate.", self.TOKEN, candidate)
            # A second call reconciles the same session and never launches again.
            self.assertEqual(self.sessions.run_reviewer("Review this candidate.", self.TOKEN, candidate)["status"], "attached_session_available")
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

    def test_reviewer_launch_waits_for_native_pid_then_gives_up_without_relaunch(self):
        (self.directory / "review-worktree").mkdir()
        candidate = self.plan["base_commit"]
        unregistered = {key: value for key, value in self.reviewer_row().items() if key != "pid"}
        inventories = [[], [], [unregistered], [unregistered], [self.reviewer_row()]]
        with patch.object(self.sessions, "inventory", side_effect=inventories) as inventory, \
                patch("workflow.interactive.git", side_effect=[candidate, ""]), \
                patch("workflow.interactive.subprocess.run", side_effect=self.started) as launch, \
                patch("workflow.interactive.time.sleep") as sleep:
            result = self.sessions.run_reviewer("prompt", self.TOKEN, candidate)
        self.assertEqual((result["status"], result["background_id"]), ("attached_session_available", self.reviewer_row()["id"]))
        self.assertEqual((launch.call_count, inventory.call_count, sleep.call_count), (1, 5, 3))
        # A reviewer whose PID never registers is left for reconciliation, never relaunched.
        (self.directory / "review.interactive.json").unlink()
        self.sessions.settle_seconds = 0
        with patch.object(self.sessions, "inventory", side_effect=[[], [unregistered]]), \
                patch("workflow.interactive.git", side_effect=[candidate, ""]), \
                patch("workflow.interactive.subprocess.run", side_effect=self.started) as launch:
            with self.assertRaisesRegex(RuntimeError, "No live native PID"):
                self.sessions.run_reviewer("prompt", self.TOKEN, candidate)
        self.assertEqual(launch.call_count, 1)
        receipt = read_json(self.directory / "review.interactive.json")
        self.assertEqual(receipt["status"], "needs_reconciliation")
        with patch.object(self.sessions, "inventory", return_value=[]), patch("workflow.interactive.subprocess.run") as launch:
            with self.assertRaisesRegex(RuntimeError, "reconcile|relaunch"):
                self.sessions.run_reviewer("prompt", self.TOKEN, candidate)
            launch.assert_not_called()

    def test_reviewer_launch_requires_the_clean_candidate_worktree(self):
        candidate = self.plan["base_commit"]
        with patch("workflow.interactive.subprocess.run") as launch:
            with self.assertRaisesRegex(RuntimeError, "worktree"):
                self.sessions.run_reviewer("prompt", self.TOKEN, candidate)
            (self.directory / "review-worktree").mkdir()
            with patch("workflow.interactive.git", side_effect=["0" * 40, ""]):
                with self.assertRaisesRegex(RuntimeError, "candidate"):
                    self.sessions.run_reviewer("prompt", self.TOKEN, candidate)
            with patch("workflow.interactive.git", side_effect=[candidate, " M file"]):
                with self.assertRaisesRegex(RuntimeError, "candidate"):
                    self.sessions.run_reviewer("prompt", self.TOKEN, candidate)
            with patch("workflow.interactive.git", side_effect=[candidate, ""]), \
                    patch.object(self.sessions, "inventory", return_value=[self.reviewer_row()]):
                with self.assertRaisesRegex(RuntimeError, "launch name"):
                    self.sessions.run_reviewer("prompt", self.TOKEN, candidate)
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

    def test_attach_one_reconnects_the_reviewer_in_its_worktree(self):
        from .interactive import main
        self.reviewer_receipt()
        with patch("workflow.interactive.sys.argv", ["interactive", "attach-one", str(self.directory), "--node", "review"]), \
                patch("workflow.interactive.sys.stdin") as stdin, patch.object(InteractiveSessions, "inventory", return_value=[self.reviewer_row()]), \
                patch("workflow.interactive.os.chdir") as chdir, patch("workflow.interactive.os.execvp", side_effect=SystemExit(0)) as execvp:
            stdin.isatty.return_value = True
            with self.assertRaises(SystemExit):
                main()  # A real execvp replaces the process; the mock ends it the same way.
        chdir.assert_called_once_with(self.directory / "review-worktree")
        execvp.assert_called_once_with("claude", ["claude", "attach", self.reviewer_row()["id"]])


if __name__ == "__main__":
    unittest.main()
