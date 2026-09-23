import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from .herdr import herdr
from .sessions import ClaudeSessions, prepare, read_json, run_lock, save_json


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

    def test_cancelled_controller_never_launches(self):
        sessions = self.sessions()
        sessions.cancelled.set()
        with self.assertRaisesRegex(RuntimeError, "cancelled before launch"):
            sessions.run("ui")
        self.assertFalse((self.directory / "starts.log").exists())


if __name__ == "__main__":
    unittest.main()
