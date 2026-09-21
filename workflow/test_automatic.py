"""Offline automatic-controller tests: synthetic Claude, real Git/checkpoints/checks."""
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from langgraph.checkpoint.sqlite import SqliteSaver

from .automatic import DEFAULTS, drive, read_completion, validate_automatic, wait_handoffs, supervise
from .pipeline import build_pipeline
from .sessions import git, read_json, save_json
from .verification import policy_digest
from . import test_pipeline as fixtures


class CompletionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.plan = {"run_id": "test", "source_branch": "feature/test", "automatic": dict(DEFAULTS),
                     "nodes": {node: {"session_id": node + "-token"} for node in ("ui", "adapter")}}
        sessions = SimpleNamespace(inventory=lambda: [], locate=lambda node, rows: {"state": "idle"})
        self.runtime = SimpleNamespace(directory=self.root, plan=self.plan, sessions=sessions)
        for node in self.plan["nodes"]:
            save_json(self.root / f"{node}.interactive.json", {"launch_requested_at": "1970-01-01T00:00:00+00:00"})

    def completion(self, node):
        return {"version": "1.0.0", "run_id": "test", "node_id": node, "launch_token": node + "-token",
                "status": "completed", "summary": "Synthetic work", "open_assumptions": []}

    def test_idle_without_signal_times_out_not_completes(self):
        ticks = iter([1, 1, 3601])
        with self.assertRaisesRegex(RuntimeError, "deadline exhausted"):
            wait_handoffs(self.runtime, clock=lambda: next(ticks), sleep=lambda _: None)
        self.assertFalse((self.root / "ui.handoff.json").exists())

    def test_both_explicit_signals_create_handoffs(self):
        for node in self.plan["nodes"]:
            save_json(self.root / f"{node}.completion.json", self.completion(node))
        wait_handoffs(self.runtime, clock=lambda: 1, sleep=lambda _: self.fail("Unexpected wait"))
        self.assertEqual(read_json(self.root / "ui.handoff.json")["summary"], "Synthetic work")

    def test_foreign_and_blocked_signals_fail_closed(self):
        item = self.completion("ui")
        item["launch_token"] = "foreign"
        save_json(self.root / "ui.completion.json", item)
        with self.assertRaisesRegex(ValueError, "foreign"):
            read_completion(self.runtime, "ui")
        item = self.completion("ui")
        item["status"] = "blocked"
        save_json(self.root / "ui.completion.json", item)
        with self.assertRaisesRegex(RuntimeError, "explicitly blocked"):
            read_completion(self.runtime, "ui")

    def test_completion_while_working_is_not_accepted(self):
        for node in self.plan["nodes"]:
            save_json(self.root / f"{node}.completion.json", self.completion(node))
        self.runtime.sessions.locate = lambda node, rows: {"state": "working"}
        ticks = iter([1, 1, 3601])
        with self.assertRaisesRegex(RuntimeError, "deadline exhausted"):
            wait_handoffs(self.runtime, clock=lambda: next(ticks), sleep=lambda _: None)
        self.assertFalse((self.root / "ui.handoff.json").exists())

    def test_stop_intent_recovery_uses_existing_validated_handoffs(self):
        for node in self.plan["nodes"]:
            save_json(self.root / f"{node}.completion.json", self.completion(node))
            save_json(self.root / f"{node}.handoff.json", read_completion(self.runtime, node))
        save_json(self.root / "ui.stop.json", {"stopped": True})
        self.runtime.sessions.inventory = lambda: self.fail("Must not locate a stopped worker")
        wait_handoffs(self.runtime)

    def test_supervisor_restarts_only_for_checkpoint_continuation(self):
        save_json(self.root / "plan.json", self.plan)
        with patch("workflow.automatic.subprocess.run", side_effect=[subprocess.CompletedProcess([], 75), subprocess.CompletedProcess([], 0)]) as run:
            supervise(self.root)
        self.assertEqual(run.call_count, 2)
        self.assertEqual(run.call_args.args[0][3:], ["automatic-step", str(self.root), "--live"])
        with patch("workflow.automatic.subprocess.run", return_value=subprocess.CompletedProcess([], 1)) as run:
            with self.assertRaisesRegex(RuntimeError, "controller blocked"):
                supervise(self.root)
        self.assertEqual(run.call_count, 1)

    def test_main_and_unbounded_authority_rejected(self):
        self.plan["source_branch"] = "main"
        with self.assertRaises(ValueError):
            validate_automatic(self.plan)
        self.plan["source_branch"] = "feature/test"
        self.plan["automatic"]["worker_timeout_seconds"] = 0
        with self.assertRaises(ValueError):
            validate_automatic(self.plan)


class AutomaticGraphTests(unittest.TestCase):
    def setUp(self):
        self.fixture = fixtures.PipelineTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        f = self.fixture
        self.original_branch = f.plan["source_branch"]
        git(f.repo, "switch", "-c", "feature/automatic-test")
        f.policy.update(version="1.1.0", max_verification_attempts=3,
                        failure_drill={"node_id": "adapter", "phase": "worker", "attempt": 1})
        f.plan.update(source_branch="feature/automatic-test", automatic=dict(DEFAULTS), policy_sha256=policy_digest(f.policy))
        save_json(f.directory / "plan.json", f.plan)
        save_json(f.directory / "policy.json", f.policy)
        f.runtime = fixtures.OfflinePipeline(f.directory, f.sessions)
        self.counter = f.root / "review-count"
        self.verdict = f.root / "review-verdict"
        self.verdict.write_text("approved")
        executable = f.root / "fake-reviewer"
        executable.write_text(f'''#!/usr/bin/env python3
import json, sys
from pathlib import Path
args = sys.argv
assert args[args.index('--tools') + 1] == 'Read,Glob,Grep'
assert '--dangerously-skip-permissions' not in args
counter = Path({str(self.counter)!r})
counter.write_text(str(int(counter.read_text()) + 1) if counter.exists() else '1')
verdict = Path({str(self.verdict)!r}).read_text()
print(json.dumps({{"session_id": args[args.index('--session-id') + 1], "is_error": False, "subtype": "success",
                  "structured_output": {{"verdict": verdict, "findings": []}}}}))
''')
        executable.chmod(0o700)
        f.sessions.executable = str(executable)
        with SqliteSaver.from_conn_string(str(f.directory / "pipeline.sqlite")) as saver:
            graph = build_pipeline(saver, f.runtime)
            first = graph.invoke({"run_id": "run"}, f.config)
            self.assertEqual(first["__interrupt__"][0].value["kind"], "worker_handoff")

    def test_automatic_drill_review_and_feature_only_finish(self):
        f = self.fixture
        # Completion protocol has separate tests; FakeSessions already supplied handoffs.
        with patch("workflow.automatic.wait_handoffs"):
            commit = drive(f.runtime)
        self.assertEqual(git(f.repo, "rev-parse", "HEAD"), commit)
        self.assertEqual(git(f.repo, "rev-parse", self.original_branch), f.plan["base_commit"])
        self.assertEqual(git(f.repo, "symbolic-ref", "--short", "HEAD"), "feature/automatic-test")
        self.assertEqual(sorted(f.sessions.starts), ["adapter", "ui"])
        self.assertEqual(self.counter.read_text(), "1")
        self.assertEqual(read_json(f.directory / "failure-report.json")["verification_attempts"], {"ui": [1], "adapter": [1, 2]})
        self.assertEqual(drive(f.runtime), commit)
        self.assertEqual(self.counter.read_text(), "1")
        self.assertFalse(git(f.repo, "remote"))

    def test_recovery_in_actual_new_controller_processes(self):
        f = self.fixture
        script = '''import sys
from pathlib import Path
from workflow import automatic
from workflow.sessions import read_json
from workflow.test_pipeline import OfflinePipeline, FakeSessions
directory = Path(sys.argv[1])
sessions = FakeSessions(directory, read_json(directory / 'plan.json'))
sessions.executable = sys.argv[2]
runtime = OfflinePipeline(directory, sessions)
automatic.wait_handoffs = lambda runtime: None
commit = automatic.drive(runtime, single_step=True)
assert not sessions.starts, 'Restart launched workers again'
sys.exit(0 if commit else 75)
'''
        codes = []
        for _ in range(4):
            result = subprocess.run([sys.executable, "-c", script, str(f.directory), f.sessions.executable],
                                    cwd=Path(__file__).resolve().parents[1], capture_output=True, text=True, timeout=90)
            codes.append(result.returncode)
            self.assertIn(result.returncode, (0, 75), result.stderr)
            if result.returncode == 0:
                break
        self.assertEqual(codes, [75, 75, 0])
        events = [json.loads(line) for line in (f.directory / "events.jsonl").read_text().splitlines()]
        self.assertEqual(len({event["message"] for event in events if event["node"] == "controller"}), 3)
        self.assertEqual(read_json(f.directory / "failure-report.json")["verification_attempts"], {"ui": [1], "adapter": [1, 2]})
        self.assertEqual(git(f.repo, "rev-parse", self.original_branch), f.plan["base_commit"])
        self.assertEqual(self.counter.read_text(), "1")

    def test_reviewer_block_preserves_branch_and_does_not_relaunch(self):
        f = self.fixture
        self.verdict.write_text("blocked")
        with patch("workflow.automatic.wait_handoffs"), self.assertRaisesRegex(RuntimeError, "Non-retryable"):
            drive(f.runtime)
        self.assertEqual(git(f.repo, "rev-parse", "HEAD"), f.plan["base_commit"])
        self.assertEqual(read_json(f.directory / "automatic-review.json")["status"], "blocked")
        with self.assertRaisesRegex(RuntimeError, "Non-retryable"):
            drive(f.runtime)
        self.assertEqual(self.counter.read_text(), "1")


if __name__ == "__main__":
    unittest.main()
