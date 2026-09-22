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

from .automatic import DEFAULTS, automatic_settings, drive, read_completion, validate_automatic, wait_handoffs, wait_review, supervise
from .pipeline import build_pipeline
from .sessions import git, read_json, save_json
from .verification import policy_digest
from . import test_pipeline as fixtures

REVIEWER_UUID = "dd7bdcd1-adec-4efe-bcd4-bbadc3525d95"


class FakeReviewerSessions(fixtures.FakeSessions):
    """Offline native reviewer: journals the launch receipt and writes a completion file at once.

    The completion template lives in a file next to the run so that separate controller processes
    (recovery tests) share it. A missing template means the reviewer idles without a verdict.
    """

    def __init__(self, directory, plan):
        super().__init__(directory, plan)
        self.reviewer_launches = directory.parent / "reviewer-launches"
        self.template = directory.parent / "review-completion.json"
        self.state = "idle"

    def run_reviewer(self, prompt, completion_path):
        receipt_path = self.directory / "review.interactive.json"
        if receipt_path.exists():
            receipt = read_json(receipt_path)
            receipt["status"] = "attached_session_available"
            save_json(receipt_path, receipt)
            return receipt
        count = int(self.reviewer_launches.read_text()) + 1 if self.reviewer_launches.exists() else 1
        self.reviewer_launches.write_text(str(count))
        assert "review.completion.json" in prompt and "Schema:" in prompt
        from datetime import datetime, timezone
        from .sessions import plan_digest
        receipt = {"node_id": "review", "session_id": REVIEWER_UUID, "background_id": REVIEWER_UUID[:8], "launch_token": None,
                   "plan_digest": plan_digest(self.plan), "worktree": str(self.directory / "review-worktree"), "role": "reviewer",
                   "status": "attached_session_available", "attempt": 1, "launcher_invocations": 1,
                   "launch_requested_at": datetime.now(timezone.utc).isoformat()}
        save_json(receipt_path, receipt)
        if self.template.exists():
            bundle = read_json(self.directory / "review-bundle.json")
            from .pipeline import digest_file
            completion = {"version": "1.0.0", "run_id": self.plan["run_id"], "node_id": "review",
                          "bundle_sha256": digest_file(self.directory / "review-bundle.json"),
                          "candidate_commit": bundle["candidate_commit"], "reviewer_session": REVIEWER_UUID,
                          **read_json(self.template)}
            save_json(completion_path, completion)
        return receipt

    def inventory(self):
        if not (self.directory / "review.interactive.json").exists() or (self.directory / "review.stop.json").exists():
            return []
        return [{"id": REVIEWER_UUID[:8], "sessionId": REVIEWER_UUID, "state": self.state, "pid": 4242,
                 "name": f"workflow-{self.plan['run_id']}-reviewer", "kind": "background", "cwd": str(self.directory / "review-worktree")}]

    def locate(self, node, rows):
        if node != "review":
            return None
        return next((row for row in rows if row["sessionId"] == REVIEWER_UUID), None)


class OfflineNativePipeline(fixtures.OfflinePipeline):
    def stop_session(self, node):
        marker = self.directory / f"{node}.stop.json"
        if marker.exists():
            return read_json(marker)
        row = self.sessions.locate(node, self.sessions.inventory())
        if row is None:
            raise RuntimeError(f"{node} session missing before stop; reconcile before continuing")
        intent = {"background_id": row["id"], "session_id": row["sessionId"], "pid": row["pid"], "stopped": True}
        save_json(marker, intent)
        return intent


def prepare_graph(test, transport):
    """Shared automatic-run fixture on top of the offline pipeline repository."""
    test.fixture = fixtures.PipelineTests()
    test.fixture.setUp()
    test.addCleanup(test.fixture.doCleanups)
    f = test.fixture
    test.original_branch = f.plan["source_branch"]
    git(f.repo, "switch", "-c", "feature/automatic-test")
    f.policy.update(version="1.1.0", max_verification_attempts=3,
                    failure_drill={"node_id": "adapter", "phase": "worker", "attempt": 1})
    f.plan.update(source_branch="feature/automatic-test", automatic=automatic_settings(reviewer_transport=transport),
                  policy_sha256=policy_digest(f.policy), feature="offline-feature")
    save_json(f.directory / "plan.json", f.plan)
    save_json(f.directory / "policy.json", f.policy)
    if transport == "native":
        f.sessions = FakeReviewerSessions(f.directory, f.plan)
        f.runtime = OfflineNativePipeline(f.directory, f.sessions)
    else:
        f.runtime = fixtures.OfflinePipeline(f.directory, f.sessions)
    with SqliteSaver.from_conn_string(str(f.directory / "pipeline.sqlite")) as saver:
        graph = build_pipeline(saver, f.runtime)
        first = graph.invoke({"run_id": "run"}, f.config)
        test.assertEqual(first["__interrupt__"][0].value["kind"], "worker_handoff")


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
        ticks = iter([1, 1, DEFAULTS["worker_timeout_seconds"] + 1])
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
        ticks = iter([1, 1, DEFAULTS["worker_timeout_seconds"] + 1])
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

    def test_supervisor_interrupt_reports_resume_without_stopping_workers(self):
        save_json(self.root / "plan.json", self.plan)
        with patch("workflow.automatic.subprocess.run", side_effect=KeyboardInterrupt) as run:
            with self.assertRaisesRegex(RuntimeError, "NOT stopped.*resume with"):
                supervise(self.root)
        self.assertEqual(run.call_count, 1)

    def test_deadlines_are_configurable_and_bounded(self):
        self.assertEqual(automatic_settings()["worker_timeout_seconds"], 4 * 3600)
        custom = automatic_settings(7200, 600)
        self.assertEqual((custom["worker_timeout_seconds"], custom["review_timeout_seconds"]), (7200, 600))
        self.assertEqual(custom["permission_mode"], DEFAULTS["permission_mode"])
        for bad in (0, -1, 86401):
            with self.assertRaisesRegex(ValueError, "bounded"):
                automatic_settings(worker_timeout_seconds=bad)
        with self.assertRaises(ValueError):
            automatic_settings(review_timeout_seconds=90000)
        self.plan["automatic"] = automatic_settings(7200)
        validate_automatic(self.plan)

    def test_identical_failures_are_not_retried(self):
        from .automatic import advance_failed_checks
        policy = {"max_verification_attempts": 3}
        attempts = {"worker:adapter": 2}
        bumped = []
        runtime = SimpleNamespace(directory=self.root, policy=policy,
                                  attempt=lambda phase, node: attempts.get(f"{phase}:{node}", 1),
                                  retry_check=lambda phase, node: bumped.append((phase, node)))
        state = SimpleNamespace(next=("verify_adapter",), tasks=[SimpleNamespace(name="verify_adapter", error="blocked")])
        reasons = ["backend-unit: exit 1", "backend-unit: no passing test evidence or failed tests"]
        for attempt in (1, 2):
            (self.root / "verification" / "worker" / "adapter" / str(attempt)).mkdir(parents=True)
            save_json(self.root / "verification" / "worker" / "adapter" / str(attempt) / "packet.json",
                      {"gate": {"status": "blocked", "reasons": list(reasons)}})
        with self.assertRaisesRegex(RuntimeError, "failed identically on attempts 1 and 2"):
            advance_failed_checks(runtime, state)
        self.assertEqual(bumped, [])
        # A different failure on the latest attempt is still retried within the cap.
        save_json(self.root / "verification" / "worker" / "adapter" / "2" / "packet.json",
                  {"gate": {"status": "blocked", "reasons": ["browser: Playwright reported global errors"]}})
        self.assertTrue(advance_failed_checks(runtime, state))
        self.assertEqual(bumped, [("worker", "adapter")])

    def test_stale_error_on_a_completed_sibling_does_not_block_retry(self):
        from .automatic import advance_failed_checks
        attempts = {}
        bumped = []
        runtime = SimpleNamespace(directory=self.root, policy={"max_verification_attempts": 3},
                                  attempt=lambda phase, node: attempts.get(f"{phase}:{node}", 1),
                                  retry_check=lambda phase, node: bumped.append((phase, node)))
        for node, status, reasons in (("ui", "passed", []), ("adapter", "blocked", ["Intentional lab drill"])):
            (self.root / "verification" / "worker" / node / "1").mkdir(parents=True)
            save_json(self.root / "verification" / "worker" / node / "1" / "packet.json", {"gate": {"status": status, "reasons": reasons}})
        # verify_ui carries an error from an earlier attempt but has since succeeded: it is not pending.
        state = SimpleNamespace(next=("verify_adapter",),
                                tasks=[SimpleNamespace(name="verify_ui", error="CalledProcessError(128, git worktree add)"),
                                       SimpleNamespace(name="verify_adapter", error="blocked")])
        self.assertTrue(advance_failed_checks(runtime, state))
        self.assertEqual(bumped, [("worker", "adapter")])

    def test_main_and_unbounded_authority_rejected(self):
        self.plan["source_branch"] = "main"
        with self.assertRaises(ValueError):
            validate_automatic(self.plan)
        self.plan["source_branch"] = "feature/test"
        self.plan["automatic"]["worker_timeout_seconds"] = 0
        with self.assertRaises(ValueError):
            validate_automatic(self.plan)


class AutomaticGraphTests(unittest.TestCase):
    """Print-mode reviewer transport: the headless fallback keeps its original guarantees."""

    def setUp(self):
        prepare_graph(self, "print")
        f = self.fixture
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
schema = json.loads(args[args.index('--json-schema') + 1])
assert set(schema['properties']['findings']['items']['required']) >= {{'worker', 'requirement'}}
print(json.dumps({{"session_id": args[args.index('--session-id') + 1], "is_error": False, "subtype": "success",
                  "structured_output": {{"verdict": verdict, "findings": []}}}}))
''')
        executable.chmod(0o700)
        f.sessions.executable = str(executable)

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
        self.assertEqual(read_json(f.directory / "automatic-review.json")["transport"], "print")
        self.assertFalse((f.directory / "review.interactive.json").exists())

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

    def test_interrupt_during_worker_wait_keeps_workers_and_resumes(self):
        f = self.fixture
        with patch("workflow.automatic.wait_handoffs", side_effect=KeyboardInterrupt), patch.object(f.runtime, "stop_workers") as stop:
            with self.assertRaises(KeyboardInterrupt):
                drive(f.runtime)
        stop.assert_not_called()
        events = [json.loads(line) for line in (f.directory / "events.jsonl").read_text().splitlines()]
        self.assertTrue(any(event["status"] == "interrupted" and "resume with" in event["message"] for event in events))
        self.assertFalse((f.directory / "ui.stop.json").exists())
        # The same run resumes from the persisted checkpoint without relaunching anything.
        with patch("workflow.automatic.wait_handoffs"):
            commit = drive(f.runtime)
        self.assertEqual(git(f.repo, "rev-parse", "HEAD"), commit)
        self.assertEqual(sorted(f.sessions.starts), ["adapter", "ui"])

    def test_deadline_or_blocked_worker_stops_workers(self):
        f = self.fixture
        with patch("workflow.automatic.wait_handoffs", side_effect=RuntimeError("Worker ui deadline exhausted; no automatic relaunch")), \
                patch.object(f.runtime, "stop_workers") as stop:
            with self.assertRaisesRegex(RuntimeError, "deadline exhausted"):
                drive(f.runtime)
        stop.assert_called_once()

    def test_reviewer_block_preserves_branch_and_does_not_relaunch(self):
        f = self.fixture
        self.verdict.write_text("blocked")
        with patch("workflow.automatic.wait_handoffs"), self.assertRaisesRegex(RuntimeError, "Non-retryable"):
            drive(f.runtime)
        self.assertEqual(git(f.repo, "rev-parse", "HEAD"), f.plan["base_commit"])
        self.assertEqual(read_json(f.directory / "automatic-review.json")["status"], "blocked")
        self.assertEqual(read_json(f.directory / "review.json")["verdict"], "blocked")
        with self.assertRaisesRegex(RuntimeError, "Non-retryable"):
            drive(f.runtime)
        self.assertEqual(self.counter.read_text(), "1")


class NativeReviewTests(unittest.TestCase):
    """Default transport: the reviewer is a third native session with a completion-file protocol."""

    def setUp(self):
        prepare_graph(self, "native")
        self.sessions = self.fixture.sessions
        self.findings = [{"severity": "P2", "message": "Reuse evidence is stated rather than derived", "disposition": "accepted",
                          "worker": "adapter", "requirement": "Backend"},
                         {"severity": "P1", "message": "Fixed before approval", "disposition": "resolved", "worker": "ui", "requirement": None}]
        save_json(self.sessions.template, {"verdict": "approved", "findings": self.findings})

    def events(self):
        return [json.loads(line) for line in (self.fixture.directory / "events.jsonl").read_text().splitlines()]

    def test_completion_file_from_the_launched_reviewer_is_accepted_and_the_session_stopped(self):
        f = self.fixture
        with patch("workflow.automatic.wait_handoffs"):
            commit = drive(f.runtime)
        self.assertEqual(git(f.repo, "rev-parse", "HEAD"), commit)
        self.assertEqual(self.sessions.reviewer_launches.read_text(), "1")
        review = read_json(f.directory / "review.json")
        self.assertEqual((review["reviewer"], review["verdict"], review["findings"]), (REVIEWER_UUID, "approved", self.findings))
        receipt = read_json(f.directory / "automatic-review.json")
        self.assertEqual((receipt["transport"], receipt["status"], receipt["session_id"]), ("native", "succeeded", REVIEWER_UUID))
        self.assertEqual(read_json(f.directory / "review.interactive.json")["session_id"], REVIEWER_UUID)
        self.assertTrue(read_json(f.directory / "review.stop.json")["stopped"])
        messages = [event["message"] for event in self.events() if event["node"] == "review"]
        self.assertTrue(any("launched in review-worktree" in message for message in messages))
        self.assertTrue(any("stopped after its completion file was accepted" in message for message in messages))
        self.assertEqual(drive(f.runtime), commit)
        self.assertEqual(self.sessions.reviewer_launches.read_text(), "1")

    def test_rejected_completion_file_fails_closed_without_a_second_reviewer(self):
        f = self.fixture
        original = self.sessions.run_reviewer
        def tampered(prompt, completion_path):
            receipt = original(prompt, completion_path)
            save_json(completion_path, {**read_json(completion_path), "bundle_sha256": "0" * 64})
            return receipt
        self.sessions.run_reviewer = tampered
        with patch("workflow.automatic.wait_handoffs"), self.assertRaisesRegex(RuntimeError, "Non-retryable"):
            drive(f.runtime)
        self.assertEqual(git(f.repo, "rev-parse", "HEAD"), f.plan["base_commit"])
        receipt = read_json(f.directory / "automatic-review.json")
        self.assertEqual(receipt["status"], "blocked")
        self.assertIn("exact run, bundle hash and candidate", receipt["error"])
        self.assertFalse((f.directory / "review.json").exists())
        self.assertTrue(read_json(f.directory / "review.stop.json")["stopped"], "a rejected reviewer is stopped, evidence retained")
        with self.assertRaisesRegex(RuntimeError, "Non-retryable"):
            drive(f.runtime)
        self.assertEqual(self.sessions.reviewer_launches.read_text(), "1")

    def test_blocked_verdict_is_recorded_and_ends_the_run(self):
        f = self.fixture
        save_json(self.sessions.template, {"verdict": "blocked", "findings": [{"severity": "P0", "message": "Candidate serves raw paths", "disposition": "open", "worker": "adapter", "requirement": None}]})
        with patch("workflow.automatic.wait_handoffs"), self.assertRaisesRegex(RuntimeError, "Non-retryable"):
            drive(f.runtime)
        self.assertEqual(git(f.repo, "rev-parse", "HEAD"), f.plan["base_commit"])
        review = read_json(f.directory / "review.json")
        self.assertEqual((review["verdict"], review["reviewer"], review["findings"][0]["worker"]), ("blocked", REVIEWER_UUID, "adapter"))
        self.assertEqual(read_json(f.directory / "automatic-review.json")["status"], "blocked")
        self.assertTrue(read_json(f.directory / "review.stop.json")["stopped"])

    def test_reviewer_without_a_file_idles_until_the_deadline_then_is_stopped(self):
        f = self.fixture
        self.sessions.template.unlink()
        ticks = iter([0, 0, DEFAULTS["review_timeout_seconds"] + 1])
        expired = lambda runtime, digest, bundle: wait_review(runtime, digest, bundle, clock=lambda: 2_000_000_000 + next(ticks), sleep=lambda _: None)
        with patch("workflow.automatic.wait_handoffs"), patch("workflow.automatic.wait_review", side_effect=expired), \
                self.assertRaisesRegex(RuntimeError, "Non-retryable"):
            drive(f.runtime)
        receipt = read_json(f.directory / "automatic-review.json")
        self.assertEqual(receipt["status"], "blocked")
        self.assertIn("deadline exhausted", receipt["error"])
        self.assertTrue(read_json(f.directory / "review.stop.json")["stopped"])
        self.assertFalse((f.directory / "review.json").exists())
        with self.assertRaisesRegex(RuntimeError, "Non-retryable"):
            drive(f.runtime)
        self.assertEqual(self.sessions.reviewer_launches.read_text(), "1")

    def test_interrupt_during_review_leaves_the_reviewer_running_and_resumes(self):
        f = self.fixture
        with patch("workflow.automatic.wait_handoffs"), patch("workflow.automatic.wait_review", side_effect=KeyboardInterrupt), \
                patch.object(f.runtime, "stop_session") as stop:
            with self.assertRaises(KeyboardInterrupt):
                drive(f.runtime)
        stop.assert_not_called()
        self.assertEqual(read_json(f.directory / "automatic-review.json")["status"], "running")
        self.assertFalse((f.directory / "review.stop.json").exists())
        self.assertTrue(any(event["status"] == "interrupted" and event["node"] == "review" for event in self.events()))
        with patch("workflow.automatic.wait_handoffs"):
            commit = drive(f.runtime)
        self.assertEqual(git(f.repo, "rev-parse", "HEAD"), commit)
        self.assertEqual(self.sessions.reviewer_launches.read_text(), "1")
        self.assertEqual(read_json(f.directory / "review.json")["reviewer"], REVIEWER_UUID)

    def test_recovery_in_new_controller_processes_including_a_reviewer_interruption(self):
        f = self.fixture
        interrupt_marker = f.root / "review-interrupted-once"
        script = '''import sys
from pathlib import Path
from workflow import automatic
from workflow.sessions import read_json
from workflow.test_automatic import FakeReviewerSessions, OfflineNativePipeline
directory = Path(sys.argv[1])
sessions = FakeReviewerSessions(directory, read_json(directory / 'plan.json'))
runtime = OfflineNativePipeline(directory, sessions)
automatic.wait_handoffs = lambda runtime: None
marker = Path(sys.argv[2])
real_wait = automatic.wait_review
def wait_once(runtime, digest, bundle, **kwargs):
    if not marker.exists():
        marker.write_text('interrupted')
        raise KeyboardInterrupt
    return real_wait(runtime, digest, bundle, **kwargs)
automatic.wait_review = wait_once
try:
    commit = automatic.drive(runtime, single_step=True)
except KeyboardInterrupt:
    sys.exit(130)
assert not sessions.starts, 'Restart launched workers again'
sys.exit(0 if commit else 75)
'''
        codes = []
        for _ in range(6):
            result = subprocess.run([sys.executable, "-c", script, str(f.directory), str(interrupt_marker)],
                                    cwd=Path(__file__).resolve().parents[1], capture_output=True, text=True, timeout=90)
            codes.append(result.returncode)
            self.assertIn(result.returncode, (0, 75, 130), result.stderr)
            if result.returncode == 130:
                self.assertEqual(read_json(f.directory / "automatic-review.json")["status"], "running")
                self.assertFalse((f.directory / "review.stop.json").exists(), "interruption must not stop the reviewer")
            if result.returncode == 0:
                break
        # Persisted steps continue in fresh processes; exactly one of them was interrupted mid-review.
        self.assertEqual((len(codes), codes.count(130), codes[-1]), (4, 1, 0), codes)
        self.assertEqual(self.sessions.reviewer_launches.read_text(), "1")
        self.assertEqual(read_json(f.directory / "review.json")["reviewer"], REVIEWER_UUID)
        self.assertTrue(read_json(f.directory / "review.stop.json")["stopped"])
        self.assertEqual(git(f.repo, "rev-parse", self.original_branch), f.plan["base_commit"])


class WaitReviewTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.plan = {"run_id": "test", "source_branch": "feature/test", "automatic": dict(DEFAULTS),
                     "nodes": {node: {"session_id": node + "-token"} for node in ("ui", "adapter")}}
        self.row = {"id": "dd7bdcd1", "sessionId": REVIEWER_UUID, "state": "idle", "pid": 1}
        sessions = SimpleNamespace(inventory=lambda: [self.row], locate=lambda node, rows: rows[0] if rows else None)
        self.events = []
        self.runtime = SimpleNamespace(directory=self.root, plan=self.plan, sessions=sessions,
                                       event=lambda node, status, message: self.events.append((node, status, message)))
        self.worker_uuid = "68269267-a9d2-4dd7-a2fd-26fa776567b5"
        self.bundle = {"candidate_commit": "b" * 40, "snapshots": {"ui": {"session_id": self.worker_uuid}, "adapter": {"session_id": "adapter-native"}}}
        self.digest = "d" * 64
        save_json(self.root / "review.interactive.json", {"launch_requested_at": "1970-01-01T00:00:00+00:00"})

    def completion(self, **changes):
        return {"version": "1.0.0", "run_id": "test", "node_id": "review", "bundle_sha256": self.digest,
                "candidate_commit": "b" * 40, "reviewer_session": REVIEWER_UUID, "verdict": "approved", "findings": [], **changes}

    def wait(self, clock=lambda: 1):
        return wait_review(self.runtime, self.digest, self.bundle, clock=clock, sleep=lambda _: None)

    def test_idle_without_file_times_out(self):
        ticks = iter([1, 1, DEFAULTS["review_timeout_seconds"] + 1])
        with self.assertRaisesRegex(RuntimeError, "deadline exhausted"):
            self.wait(clock=lambda: next(ticks))

    def test_file_while_working_is_not_accepted_until_idle(self):
        save_json(self.root / "review.completion.json", self.completion())
        self.row["state"] = "working"
        ticks = iter([1, 1, DEFAULTS["review_timeout_seconds"] + 1])
        with self.assertRaisesRegex(RuntimeError, "deadline exhausted"):
            self.wait(clock=lambda: next(ticks))
        self.row["state"] = "idle"
        self.assertEqual(self.wait()["verdict"], "approved")

    def test_foreign_bindings_are_rejected(self):
        for change in ({"bundle_sha256": "0" * 64}, {"candidate_commit": "c" * 40}, {"run_id": "other"},
                       {"reviewer_session": "0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f"}, {"node_id": "ui"},
                       {"findings": [{"severity": "P2", "message": "no link fields", "disposition": "open"}]}):
            save_json(self.root / "review.completion.json", self.completion(**change))
            with self.subTest(change=change), self.assertRaises(Exception):
                self.wait()

    def test_worker_session_cannot_pose_as_reviewer(self):
        self.row["sessionId"] = self.worker_uuid
        save_json(self.root / "review.completion.json", self.completion(reviewer_session=self.worker_uuid))
        with self.assertRaisesRegex(ValueError, "independent reviewer"):
            self.wait()

    def test_missing_reviewer_fails_without_relaunch(self):
        self.runtime.sessions.inventory = lambda: []
        with self.assertRaisesRegex(RuntimeError, "missing"):
            self.wait()

    def test_blocked_reviewer_is_a_waiting_state_until_the_deadline(self):
        # Observed live: a reviewer that ends its turn asking a person shows as `blocked`.
        self.row["state"] = "blocked"
        ticks = iter([1, 1, 1, DEFAULTS["review_timeout_seconds"] + 1])
        with self.assertRaisesRegex(RuntimeError, "deadline exhausted"):
            self.wait(clock=lambda: next(ticks))
        self.assertEqual([status for _, status, _ in self.events], ["interactive"], "noted once, not every poll")
        self.assertIn("waiting for input", self.events[0][2])
        # An answer in the pane can still lead to the file; it is accepted in the blocked state too.
        save_json(self.root / "review.completion.json", self.completion())
        self.assertEqual(self.wait()["verdict"], "approved")

    def test_stopped_reviewer_recovery_rereads_the_accepted_file(self):
        save_json(self.root / "review.completion.json", self.completion())
        save_json(self.root / "review.stop.json", {"session_id": REVIEWER_UUID, "stopped": True})
        self.runtime.sessions.inventory = lambda: self.fail("Must not poll a stopped reviewer")
        self.assertEqual(self.wait()["reviewer_session"], REVIEWER_UUID)


if __name__ == "__main__":
    unittest.main()
