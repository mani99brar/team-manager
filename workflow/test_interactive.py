import os
import subprocess
import unittest
from unittest.mock import patch

from langgraph.checkpoint.sqlite import SqliteSaver

from .interactive import InteractiveSessions, attach_panels, attach_reviewer_pane, build_interactive_graph, require_shell
from .sessions import read_json, save_json


class InteractiveTests(unittest.TestCase):
    def setUp(self):
        from .test_sessions import SessionTests
        SessionTests.setUp(self)
        self.plan["mode"] = "interactive"
        save_json(self.directory / "plan.json", self.plan)
        self.sessions = InteractiveSessions(self.directory, executable="claude")

    def row(self, node="ui", **updates):
        native_id = {"ui": "11111111-1111-4111-8111-111111111111", "adapter": "22222222-2222-4222-8222-222222222222",
                     "review": "33333333-3333-4333-8333-333333333333"}[node]
        return {"sessionId": native_id, "id": native_id[:8], "name": self.sessions.launch_name(node),
                "kind": "background", "cwd": str(self.sessions.worktree_of(node)), "state": "idle", "pid": os.getpid(), **updates}

    def automatic_plan(self):
        from .automatic import DEFAULTS
        self.plan.update(automatic=dict(DEFAULTS), source_branch="feature/test")
        save_json(self.directory / "plan.json", self.plan)
        self.sessions = InteractiveSessions(self.directory, executable="claude")

    def started(self, node="ui"):
        def launch(*args, **kwargs):
            kwargs["stdout"].write(f"claude attach {self.row(node)['id']}    open in this terminal\n")
            return subprocess.CompletedProcess([], 0)
        return launch

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

    def test_reviewer_launches_in_the_review_worktree_with_read_only_tools_and_one_allowed_write(self):
        self.automatic_plan()
        (self.directory / "review-worktree").mkdir()
        completion = self.directory / "review.completion.json"
        with patch.object(self.sessions, "inventory", side_effect=[[], [self.row("review")]]), patch("workflow.interactive.git", return_value=""), \
                patch("workflow.interactive.subprocess.run", side_effect=self.started("review")) as launch:
            receipt = self.sessions.run_reviewer("Review this candidate. Schema: {}", completion)
        self.assertEqual(receipt["session_id"], self.row("review")["sessionId"])
        self.assertEqual(receipt["status"], "attached_session_available")
        self.assertEqual(launch.call_args.kwargs["cwd"], self.directory / "review-worktree")
        command = launch.call_args.args[0]
        self.assertEqual(command[command.index("--name") + 1], f"workflow-{self.plan['run_id']}-reviewer")
        self.assertEqual(command[command.index("--tools") + 1], "Read,Glob,Grep,Write")
        # Write follows Edit rules; a `Write(...)` rule is ignored by the CLI (found by the live smoke test).
        self.assertEqual(command[command.index("--allowedTools") + 1], f"Edit(//{completion.resolve().as_posix().lstrip('/')})")
        self.assertEqual(command[command.index("--permission-mode") + 1], "dontAsk")
        self.assertEqual(command[command.index("--add-dir") + 1], str(self.directory))
        self.assertNotIn("--dangerously-skip-permissions", command)
        self.assertNotIn("bypassPermissions", command)
        self.assertNotIn("Bash", command[command.index("--tools") + 1])
        self.assertTrue(command[-1].startswith("Review this candidate"))
        # A second call reconciles the same session; it never launches again.
        with patch.object(self.sessions, "inventory", return_value=[self.row("review")]), patch("workflow.interactive.subprocess.run") as relaunch:
            self.assertEqual(self.sessions.run_reviewer("ignored", completion)["background_id"], self.row("review")["id"])
            relaunch.assert_not_called()
        self.assertEqual(self.sessions.launched_nodes(), ("ui", "adapter", "review"))

    def test_reviewer_requires_an_automatic_plan_and_an_existing_clean_worktree(self):
        with self.assertRaisesRegex(ValueError, "automatic"):
            self.sessions.run_reviewer("x", self.directory / "review.completion.json")
        self.automatic_plan()
        with self.assertRaisesRegex(RuntimeError, "worktree missing"):
            self.sessions.run_reviewer("x", self.directory / "review.completion.json")

    def test_reviewer_pane_is_added_to_the_existing_workflow_tab(self):
        from .sessions import plan_digest
        for node in ("ui", "adapter", "review"):
            save_json(self.directory / f"{node}.interactive.json", {"plan_digest": plan_digest(self.plan), "background_id": self.row(node)["id"], "session_id": self.row(node)["sessionId"]})
        self.assertIsNone(attach_reviewer_pane(self.sessions), "no terminal mapping means no pane, not an error")
        save_json(self.directory / "terminals.json", {"ui": {"pane_id": "w1:p2", "tab_id": "w1:t2", "mode": "attach_requested"},
                                                        "adapter": {"pane_id": "w1:p3", "tab_id": "w1:t2", "mode": "attach_requested"}})
        calls = []
        def fake_herdr(*args):
            calls.append(args)
            if args[:2] == ("pane", "get"):
                return {"result": {"pane": {"pane_id": args[2], "tab_id": "w1:t2", "workspace_id": "w1"}}}
            if args[:2] == ("pane", "split"):
                return {"result": {"pane": {"pane_id": "w1:p4"}}}
            if args[:2] == ("pane", "process-info"):
                return {"result": {"process_info": {"shell_pid": 1, "foreground_processes": [{"pid": 1}]}}}
            return {}
        rows = [self.row(), self.row("adapter"), self.row("review")]
        with patch.object(self.sessions, "inventory", return_value=rows), patch("workflow.interactive.herdr", side_effect=fake_herdr):
            mapping = attach_reviewer_pane(self.sessions)
        self.assertEqual(mapping["review"]["pane_id"], "w1:p4")
        self.assertEqual(mapping["review"]["session_id"], self.row("review")["sessionId"])
        split = next(call for call in calls if call[:2] == ("pane", "split"))
        self.assertEqual(split[3], "w1:p3")
        self.assertIn("--no-focus", split)
        self.assertIn(("pane", "rename", "w1:p4", "Claude: reviewer"), calls)
        run = next(call for call in calls if call[:2] == ("pane", "run"))
        self.assertIn("attach-one", run[3])
        self.assertIn("--node review", run[3])
        self.assertEqual(read_json(self.directory / "terminals.json")["review"]["mode"], "attach_requested")
        # Idempotent: an existing reviewer pane is left alone.
        with patch("workflow.interactive.herdr", side_effect=AssertionError("must not touch panes")):
            self.assertEqual(attach_reviewer_pane(self.sessions)["review"]["pane_id"], "w1:p4")

    def test_attach_after_review_launch_creates_three_panes(self):
        from .sessions import plan_digest
        for node in ("ui", "adapter", "review"):
            save_json(self.directory / f"{node}.interactive.json", {"plan_digest": plan_digest(self.plan), "background_id": self.row(node)["id"], "session_id": self.row(node)["sessionId"]})
        splits = iter(["w1:p3", "w1:p4"])
        renames = []
        def fake_herdr(*args):
            if args[:2] == ("pane", "current"):
                return {"result": {"pane": {"workspace_id": "w1", "tab_id": "w1:t1"}}}
            if args[:2] == ("tab", "create"):
                return {"result": {"tab": {"tab_id": "w1:t2"}, "root_pane": {"pane_id": "w1:p2"}}}
            if args[:2] == ("pane", "split"):
                return {"result": {"pane": {"pane_id": next(splits)}}}
            if args[:2] == ("pane", "process-info"):
                return {"result": {"process_info": {"shell_pid": 1, "foreground_processes": [{"pid": 1}]}}}
            if args[:2] == ("pane", "rename"):
                renames.append(args[3])
            return {}
        rows = [self.row(), self.row("adapter"), self.row("review")]
        with patch.object(self.sessions, "inventory", return_value=rows), patch("workflow.interactive.herdr", side_effect=fake_herdr):
            mapping = attach_panels(self.sessions)
        self.assertEqual({node: entry["pane_id"] for node, entry in mapping.items()}, {"ui": "w1:p2", "adapter": "w1:p3", "review": "w1:p4"})
        self.assertEqual(renames, ["Claude: ui", "Claude: adapter", "Claude: reviewer"])


if __name__ == "__main__":
    unittest.main()
