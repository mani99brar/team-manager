import os
import subprocess
import unittest
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
                require_shell("w1:p1")

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
