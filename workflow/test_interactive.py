import os
import subprocess
import unittest
from unittest.mock import patch

from langgraph.checkpoint.sqlite import SqliteSaver

from .interactive import (InteractiveSessions, attach_panels, attach_reviewer_pane,
                          build_interactive_graph, require_shell)
from .sessions import REVIEWER, plan_digest, read_json, save_json


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

    def automatic(self):
        """An automatic run whose review node is about to launch its reviewer."""
        from .automatic import automatic_settings
        self.plan.update(automatic=automatic_settings(), source_branch="feature/test")
        save_json(self.directory / "plan.json", self.plan)
        self.sessions = InteractiveSessions(self.directory, executable="claude")
        (self.directory / "review-worktree").mkdir()
        return "c" * 40

    def reviewer_row(self, **updates):
        native = "33333333-3333-4333-8333-333333333333"
        return {"sessionId": native, "id": native[:8], "name": self.sessions.launch_name(REVIEWER),
                "kind": "background", "cwd": str(self.directory / "review-worktree"),
                "state": "idle", "pid": os.getpid(), **updates}

    def test_reviewer_launches_read_only_in_the_candidate_worktree(self):
        commit = self.automatic()
        def started(*args, **kwargs):
            kwargs["stdout"].write(f"claude attach {self.reviewer_row()['id']}    open in this terminal\n")
            return subprocess.CompletedProcess([], 0)
        with patch.object(self.sessions, "inventory", side_effect=[[], [self.reviewer_row()]]), \
                patch("workflow.interactive.git", side_effect=[commit, ""]), \
                patch("workflow.interactive.subprocess.run", side_effect=started) as launch:
            receipt = self.sessions.run_reviewer("Review this candidate", "token-1", commit)
        command = launch.call_args.args[0]
        self.assertEqual(receipt["session_id"], self.reviewer_row()["sessionId"])
        self.assertEqual(receipt["node_id"], "review")
        self.assertEqual(launch.call_args.kwargs["cwd"], self.directory / "review-worktree")
        self.assertIn("--bg", command)
        self.assertEqual(command[command.index("--name") + 1], f"workflow-{self.plan['run_id']}-reviewer")
        self.assertNotIn("Edit", command[command.index("--tools") + 1])
        self.assertNotIn("Bash", command[command.index("--tools") + 1])
        self.assertEqual(command[command.index("--permission-mode") + 1], "dontAsk")
        self.assertEqual(command[command.index("--add-dir") + 1], str(self.directory))
        self.assertNotIn("--dangerously-skip-permissions", command)
        self.assertNotIn("bypassPermissions", command)
        self.assertFalse(any(key.startswith("HERDR_") for key in launch.call_args.kwargs["env"]))

    def test_reviewer_reconciles_its_own_session_and_never_launches_twice(self):
        commit = self.automatic()
        def started(*args, **kwargs):
            kwargs["stdout"].write(f"claude attach {self.reviewer_row()['id']}    open in this terminal\n")
            return subprocess.CompletedProcess([], 0)
        with patch.object(self.sessions, "inventory", return_value=[self.reviewer_row()]), \
                patch("workflow.interactive.git", side_effect=[commit, ""]), \
                patch("workflow.interactive.subprocess.run", side_effect=started) as launch:
            with patch.object(self.sessions, "inventory", side_effect=[[], [self.reviewer_row()]]):
                self.sessions.run_reviewer("Review", "token-1", commit)
            self.assertEqual(self.sessions.run_reviewer("Review", "token-1", commit)["status"], "attached_session_available")
            self.assertEqual(launch.call_count, 1)
            # A different launch intent is a reconciliation problem, never a relaunch.
            with self.assertRaisesRegex(RuntimeError, "launch intent changed"):
                self.sessions.run_reviewer("Review", "token-2", commit)
            self.assertEqual(launch.call_count, 1)

    def test_reviewer_refuses_a_worktree_that_is_not_the_reviewed_candidate(self):
        commit = self.automatic()
        with patch.object(self.sessions, "inventory", return_value=[]), \
                patch("workflow.interactive.git", side_effect=[commit, "?? scratch.md"]), \
                patch("workflow.interactive.subprocess.run") as launch:
            with self.assertRaisesRegex(RuntimeError, "clean reviewed candidate"):
                self.sessions.run_reviewer("Review", "token-1", commit)
        launch.assert_not_called()

    def pane_mapping(self):
        for node in ("ui", "adapter"):
            save_json(self.directory / f"{node}.interactive.json",
                      {"plan_digest": plan_digest(self.plan), "background_id": self.row(node)["id"],
                       "session_id": self.row(node)["sessionId"]})
        save_json(self.directory / "terminals.json",
                  {"ui": {"pane_id": "w1:p2", "tab_id": "w1:t2", "mode": "attach_requested"},
                   "adapter": {"pane_id": "w1:p3", "tab_id": "w1:t2", "mode": "attach_requested"}})

    def test_reviewer_pane_joins_the_workers_tab_once(self):
        commit = self.automatic()
        self.pane_mapping()
        save_json(self.directory / "review.interactive.json",
                  {"plan_digest": plan_digest(self.plan), "background_id": self.reviewer_row()["id"],
                   "session_id": self.reviewer_row()["sessionId"], "launch_token": "token-1",
                   "candidate_commit": commit})
        calls = []
        def fake_herdr(*args):
            calls.append(args)
            if args[:2] == ("pane", "split"):
                return {"result": {"pane": {"pane_id": "w1:p4"}}}
            if args[:2] == ("pane", "process-info"):
                return {"result": {"process_info": {"shell_pid": 1, "foreground_processes": [{"pid": 1}]}}}
            return {}
        with patch.object(self.sessions, "inventory", return_value=[self.reviewer_row()]), \
                patch("workflow.interactive.herdr", side_effect=fake_herdr):
            mapping = attach_reviewer_pane(self.sessions)
            self.assertEqual(mapping[REVIEWER]["tab_id"], "w1:t2")
            self.assertEqual(mapping[REVIEWER]["pane_id"], "w1:p4")
            self.assertEqual(mapping[REVIEWER]["session_id"], self.reviewer_row()["sessionId"])
            self.assertEqual([call for call in calls if call[:2] == ("pane", "rename")][0][3], "Claude: reviewer")
            run = next(call for call in calls if call[:2] == ("pane", "run"))
            self.assertIn("attach-one", run[3])
            self.assertIn("--node reviewer", run[3])
            # A second call re-attaches nothing: panes are never allocated twice.
            before = len(calls)
            attach_reviewer_pane(self.sessions)
            self.assertEqual(len(calls), before)
        self.assertEqual({entry["tab_id"] for entry in read_json(self.directory / "terminals.json").values()}, {"w1:t2"})

    def test_reviewer_pane_needs_a_verified_session_and_a_workers_tab(self):
        self.automatic()
        with patch("workflow.interactive.herdr", side_effect=AssertionError("No Herdr call before verification")):
            with self.assertRaisesRegex(RuntimeError, "No workflow tab"):
                attach_reviewer_pane(self.sessions)
            self.pane_mapping()
            with patch.object(self.sessions, "inventory", return_value=[]):
                with self.assertRaisesRegex(RuntimeError, "unverified/missing reviewer"):
                    attach_reviewer_pane(self.sessions)

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

    def test_panels_attach_to_native_sessions_in_one_new_tab(self):
        from .sessions import plan_digest
        for node in ("ui", "adapter"):
            save_json(self.directory / f"{node}.interactive.json", {"plan_digest": plan_digest(self.plan), "background_id": self.row(node)["id"], "session_id": self.row(node)["sessionId"]})
        calls = []
        def fake_herdr(*args):
            calls.append(args)
            if args[:2] == ("pane", "current"):
                return {"result": {"pane": {"workspace_id": "w1", "tab_id": "w1:t1"}}}
            if args[:2] == ("tab", "create"):
                return {"result": {"tab": {"tab_id": "w1:t2"}, "root_pane": {"pane_id": "w1:p2"}}}
            if args[:2] == ("pane", "split"):
                return {"result": {"pane": {"pane_id": "w1:p3"}}}
            if args[:2] == ("pane", "process-info"):
                return {"result": {"process_info": {"shell_pid": 1, "foreground_processes": [{"pid": 1}]}}}
            return {}
        with patch.object(self.sessions, "inventory", return_value=[self.row(), self.row("adapter")]), patch("workflow.interactive.herdr", side_effect=fake_herdr):
            mapping = attach_panels(self.sessions)
        self.assertEqual({entry["tab_id"] for entry in mapping.values()}, {"w1:t2"})
        for call in calls:
            if call[:2] == ("pane", "run"):
                self.assertIn("workflow.interactive attach-one", call[3])
                self.assertNotIn("workflow.observer", call[3])
            if call[:2] in (("tab", "create"), ("pane", "split")):
                self.assertIn("--no-focus", call)


if __name__ == "__main__":
    unittest.main()
