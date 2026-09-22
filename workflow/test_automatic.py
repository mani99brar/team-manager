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

from .automatic import (DEFAULTS, automatic_settings, drive, read_completion, read_review_completion,
                        transport, validate_automatic, wait_handoffs, wait_review, supervise)
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


class ReviewCompletionTests(unittest.TestCase):
    """The reviewer's file is the verdict; schema validity alone is never acceptance."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.plan = {"run_id": "test", "source_branch": "feature/test", "automatic": dict(DEFAULTS)}
        self.bundle = {"run_id": "test", "candidate_commit": "b" * 40, "snapshots": {}}
        self.digest = "e" * 64
        self.token = "a2f1c0d4-1111-4111-8111-111111111111"
        self.state = "idle"
        sessions = SimpleNamespace(receipt_path=lambda node: self.root / "review.interactive.json",
                                   inventory=lambda: [], locate=lambda node, rows: {"state": self.state})
        self.runtime = SimpleNamespace(directory=self.root, plan=self.plan, sessions=sessions)
        save_json(self.root / "review.interactive.json", {"launch_requested_at": "1970-01-01T00:00:00+00:00"})

    def completion(self, **changes):
        item = {"contract_version": "1.0.0", "run_id": "test", "node_id": "review", "launch_token": self.token,
                "bundle_sha256": self.digest, "candidate_commit": self.bundle["candidate_commit"],
                "verdict": "approved",
                "findings": [{"severity": "P2", "message": "Non-blocking observation", "disposition": "open",
                              "worker": "ui", "requirement": "Distinguish no workflows from no runs"}]}
        item.update(changes)
        save_json(self.root / "review.completion.json", item)
        return item

    def read(self):
        return read_review_completion(self.runtime, self.bundle, self.digest, self.token)

    def test_bound_completion_carries_worker_and_requirement(self):
        self.completion()
        decision = self.read()
        self.assertEqual(decision["verdict"], "approved")
        self.assertEqual(decision["findings"][0]["worker"], "ui")
        self.assertEqual(decision["findings"][0]["requirement"], "Distinguish no workflows from no runs")

    def test_foreign_run_token_bundle_or_candidate_fails_closed(self):
        for change in ({"run_id": "other"}, {"launch_token": "11111111-2222-4333-8444-555555555555"},
                       {"bundle_sha256": "f" * 64}, {"candidate_commit": "c" * 40}):
            self.completion(**change)
            with self.assertRaisesRegex(ValueError, "Stale or foreign"):
                self.read()

    def test_schema_violations_fail_closed(self):
        from jsonschema.exceptions import ValidationError
        for change in ({"node_id": "candidate"}, {"contract_version": "1.1.0"}, {"reviewer": "someone"},
                       {"findings": [{"severity": "P2", "message": "No worker named", "disposition": "open"}]},
                       {"findings": [{"severity": "P4", "message": "Unknown severity", "disposition": "open",
                                      "worker": "ui", "requirement": None}]}):
            self.completion(**change)
            with self.assertRaises(ValidationError):
                self.read()

    def test_a_verdict_cannot_contradict_its_own_findings(self):
        self.completion(verdict="blocked", findings=[])
        with self.assertRaisesRegex(ValueError, "blocked verdict"):
            self.read()
        open_defect = {"severity": "P1", "message": "Unredacted path in the response", "disposition": "open",
                       "worker": "adapter", "requirement": None}
        self.completion(findings=[open_defect])
        with self.assertRaisesRegex(ValueError, "unresolved P0/P1"):
            self.read()
        self.completion(verdict="blocked", findings=[open_defect])
        self.assertEqual(self.read()["verdict"], "blocked")

    def test_symlinked_or_oversized_completion_is_never_read(self):
        self.completion()
        payload = self.root / "elsewhere.json"
        (self.root / "review.completion.json").replace(payload)
        (self.root / "review.completion.json").symlink_to(payload)
        with self.assertRaisesRegex(ValueError, "Invalid reviewer completion file"):
            self.read()
        (self.root / "review.completion.json").unlink()
        self.completion(findings=[{"severity": "P2", "message": "x" * 70000, "disposition": "open",
                                   "worker": "ui", "requirement": None}])
        with self.assertRaisesRegex(ValueError, "Invalid reviewer completion file"):
            self.read()

    def test_idle_without_a_file_times_out_without_a_second_reviewer(self):
        ticks = iter([1, 1, DEFAULTS["review_timeout_seconds"] + 1])
        with self.assertRaisesRegex(RuntimeError, "deadline exhausted"):
            wait_review(self.runtime, self.bundle, self.digest, self.token,
                        clock=lambda: next(ticks), sleep=lambda _: None)

    def test_completion_written_while_working_is_not_accepted(self):
        self.completion()
        self.state = "working"
        ticks = iter([1, 1, DEFAULTS["review_timeout_seconds"] + 1])
        with self.assertRaisesRegex(RuntimeError, "deadline exhausted"):
            wait_review(self.runtime, self.bundle, self.digest, self.token,
                        clock=lambda: next(ticks), sleep=lambda _: None)
        self.state = "idle"
        self.assertEqual(wait_review(self.runtime, self.bundle, self.digest, self.token, clock=lambda: 1)["verdict"], "approved")

    def test_a_missing_or_blocked_reviewer_stops_rather_than_relaunching(self):
        self.completion()
        self.runtime.sessions.locate = lambda node, rows: None
        with self.assertRaisesRegex(RuntimeError, "reconciliation required"):
            wait_review(self.runtime, self.bundle, self.digest, self.token, clock=lambda: 1)
        self.runtime.sessions.locate = lambda node, rows: {"state": "blocked"}
        with self.assertRaisesRegex(RuntimeError, "Reviewer blocked"):
            wait_review(self.runtime, self.bundle, self.digest, self.token, clock=lambda: 1)

    def test_only_an_interrupted_review_of_a_live_session_resumes(self):
        """An error recorded against the review node is not a licence to review again."""
        from .automatic import advance_failed_checks
        live = {"row": None}
        runtime = SimpleNamespace(directory=self.root, plan=self.plan, policy={},
                                  sessions=SimpleNamespace(inventory=lambda: [], locate=lambda node, rows: live["row"]))
        state = SimpleNamespace(next=("review",), tasks=[SimpleNamespace(name="review", error="interrupted")])
        self.assertFalse(advance_failed_checks(runtime, state))  # No reviewer was ever launched.
        save_json(self.root / "automatic-review.json", {"transport": "native", "status": "running"})
        self.assertFalse(advance_failed_checks(runtime, state))  # The session is gone; reconcile instead.
        live["row"] = {"state": "idle"}
        self.assertTrue(advance_failed_checks(runtime, state))
        for receipt in ({"transport": "native", "status": "blocked"}, {"transport": "native", "status": "succeeded"},
                        {"transport": "print", "status": "running"}):
            save_json(self.root / "automatic-review.json", receipt)
            self.assertFalse(advance_failed_checks(runtime, state))
        save_json(self.root / "automatic-review.json", {"transport": "native", "status": "running"})
        self.plan["automatic"]["reviewer_transport"] = "print"
        self.assertFalse(advance_failed_checks(runtime, state))
        self.plan["automatic"]["reviewer_transport"] = "native"
        # A review failure alongside a failed check is never advanced automatically.
        mixed = SimpleNamespace(next=("review", "candidate"),
                                tasks=[SimpleNamespace(name="review", error="x"), SimpleNamespace(name="candidate", error="y")])
        self.assertFalse(advance_failed_checks(runtime, mixed))

    def test_transport_defaults_to_native_and_is_bounded(self):
        self.assertEqual(transport(self.plan), "native")
        self.assertEqual(transport({"automatic": {"reviewer_transport": "print"}}), "print")
        self.assertEqual(transport({"automatic": {}}), "native")  # Runs prepared before this slice.
        self.plan["automatic"]["reviewer_transport"] = "herdr"
        with self.assertRaisesRegex(ValueError, "transport"):
            validate_automatic(self.plan)
        with self.assertRaises(ValueError):
            automatic_settings(reviewer_transport="print-mode")


class AutomaticGraphTests(unittest.TestCase):
    """Default transport: a reviewer session with a pane, a completion file and a stop."""

    transport = "native"

    def setUp(self):
        self.fixture = fixtures.PipelineTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        f = self.fixture
        self.original_branch = f.plan["source_branch"]
        git(f.repo, "switch", "-c", "feature/automatic-test")
        f.policy.update(version="1.1.0", max_verification_attempts=3,
                        failure_drill={"node_id": "adapter", "phase": "worker", "attempt": 1})
        f.plan.update(source_branch="feature/automatic-test", policy_sha256=policy_digest(f.policy),
                      automatic=automatic_settings(reviewer_transport=self.transport))
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

    def reviews_started(self) -> int:
        """Reviewer launches, however this transport starts one."""
        if self.transport == "native":
            return len(self.fixture.sessions.reviewer_launches)
        return int(self.counter.read_text()) if self.counter.exists() else 0

    def block_review(self):
        self.verdict.write_text("blocked")
        self.fixture.sessions.reviewer_verdict = {"verdict": "blocked", "findings": [
            {"severity": "P1", "message": "Synthetic blocking defect", "disposition": "open",
             "worker": "adapter", "requirement": None}]}

    def events(self) -> list[dict]:
        return [json.loads(line) for line in (self.fixture.directory / "events.jsonl").read_text().splitlines()]

    def test_automatic_drill_review_and_feature_only_finish(self):
        f = self.fixture
        # Completion protocol has separate tests; FakeSessions already supplied handoffs.
        with patch("workflow.automatic.wait_handoffs"):
            commit = drive(f.runtime)
        self.assertEqual(git(f.repo, "rev-parse", "HEAD"), commit)
        self.assertEqual(git(f.repo, "rev-parse", self.original_branch), f.plan["base_commit"])
        self.assertEqual(git(f.repo, "symbolic-ref", "--short", "HEAD"), "feature/automatic-test")
        self.assertEqual(sorted(f.sessions.starts), ["adapter", "ui"])
        self.assertEqual(self.reviews_started(), 1)
        self.assertEqual(read_json(f.directory / "failure-report.json")["verification_attempts"], {"ui": [1], "adapter": [1, 2]})
        self.assertEqual(drive(f.runtime), commit)
        self.assertEqual(self.reviews_started(), 1)
        self.assertFalse(git(f.repo, "remote"))

    def test_review_node_records_the_reviewer_session_and_its_findings(self):
        f = self.fixture
        with patch("workflow.automatic.wait_handoffs"):
            drive(f.runtime)
        review = read_json(f.directory / "review.json")
        self.assertEqual(review["verdict"], "approved")
        if self.transport == "print":
            self.assertEqual(review["findings"], [])
            return
        receipt = read_json(f.directory / "review.interactive.json")
        self.assertEqual(receipt["node_id"], "review")
        self.assertEqual(review["reviewer"], receipt["session_id"])
        self.assertNotIn(review["reviewer"], {f.plan["nodes"][node]["session_id"] for node in ("ui", "adapter")})
        self.assertEqual(read_json(f.directory / "automatic-review.json")["transport"], "native")
        # Findings carry the fields slice C links to tasks with.
        self.assertEqual([(item["worker"], item["requirement"]) for item in review["findings"]], [("ui", "UI")])
        session_events = [event for event in self.events() if event["node"] == "review"]
        self.assertTrue(any(receipt["session_id"] in event["message"] for event in session_events))
        self.assertEqual([event["status"] for event in session_events][-2:], ["stopped", "approved"])
        self.assertTrue((f.directory / "review.stop.json").exists())

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
if Path(sys.argv[3]).exists():
    def interrupt_the_operator(*arguments, **keywords):
        raise KeyboardInterrupt
    automatic.wait_review = interrupt_the_operator
try:
    commit = automatic.drive(runtime, single_step=True)
except KeyboardInterrupt:
    assert (directory / 'review.interactive.json').exists(), 'Interrupt lost the reviewer receipt'
    sys.exit(130)
assert not sessions.starts, 'Restart launched workers again'
assert not sessions.reviewer_launches, 'Restart launched a second reviewer'
sys.exit(0 if commit else 75)
'''
        marker = f.root / "interrupt-review"
        marker.touch()
        codes, launched = [], None
        for _ in range(5):
            result = subprocess.run([sys.executable, "-c", script, str(f.directory), f.sessions.executable, str(marker)],
                                    cwd=Path(__file__).resolve().parents[1], capture_output=True, text=True, timeout=90)
            codes.append(result.returncode)
            self.assertIn(result.returncode, (0, 75, 130), result.stderr)
            if result.returncode == 130:
                # Interrupted mid-review: the reviewer session is left running.
                launched = read_json(f.directory / "review.interactive.json")
                self.assertEqual(read_json(f.directory / "automatic-review.json")["status"], "running")
                self.assertFalse((f.directory / "review.stop.json").exists())
                marker.unlink()
            if result.returncode == 0:
                break
        self.assertEqual(codes, [75, 130, 75, 0])  # Interrupted at the review step, then resumed.
        # The resumed process reused the same reviewer session rather than launching one.
        self.assertEqual(read_json(f.directory / "review.interactive.json")["launch_token"], launched["launch_token"])
        self.assertEqual(read_json(f.directory / "review.json")["reviewer"], launched["session_id"])
        controller = [event for event in self.events() if event["node"] == "controller"]
        self.assertGreaterEqual(len({event["message"] for event in controller}), 4)
        self.assertTrue(any(event["status"] == "interrupted" for event in controller))
        self.assertEqual(read_json(f.directory / "failure-report.json")["verification_attempts"], {"ui": [1], "adapter": [1, 2]})
        self.assertEqual(git(f.repo, "rev-parse", self.original_branch), f.plan["base_commit"])

    def test_interrupt_during_worker_wait_keeps_workers_and_resumes(self):
        f = self.fixture
        with patch("workflow.automatic.wait_handoffs", side_effect=KeyboardInterrupt), patch.object(f.runtime, "stop_workers") as stop:
            with self.assertRaises(KeyboardInterrupt):
                drive(f.runtime)
        stop.assert_not_called()
        self.assertTrue(any(event["status"] == "interrupted" and "resume with" in event["message"] for event in self.events()))
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
        self.block_review()
        with patch("workflow.automatic.wait_handoffs"), self.assertRaisesRegex(RuntimeError, "Non-retryable"):
            drive(f.runtime)
        self.assertEqual(git(f.repo, "rev-parse", "HEAD"), f.plan["base_commit"])
        self.assertEqual(read_json(f.directory / "automatic-review.json")["status"], "blocked")
        with self.assertRaisesRegex(RuntimeError, "Non-retryable"):
            drive(f.runtime)
        self.assertEqual(self.reviews_started(), 1)

    def test_a_foreign_completion_file_is_not_a_verdict(self):
        f = self.fixture
        launch = f.sessions.run_reviewer

        def foreign(prompt, token, commit):
            receipt = launch(prompt, token, commit)
            item = read_json(f.directory / "review.completion.json")
            item["bundle_sha256"] = "f" * 64  # A verdict on some other evidence.
            save_json(f.directory / "review.completion.json", item)
            return receipt
        f.sessions.run_reviewer = foreign
        with patch("workflow.automatic.wait_handoffs"), self.assertRaisesRegex(RuntimeError, "Non-retryable"):
            drive(f.runtime)
        receipt = read_json(f.directory / "automatic-review.json")
        self.assertEqual(receipt["status"], "blocked")
        self.assertIn("Stale or foreign", receipt["error"])
        self.assertEqual(git(f.repo, "rev-parse", "HEAD"), f.plan["base_commit"])
        self.assertFalse((f.directory / "review.json").exists())
        with self.assertRaisesRegex(RuntimeError, "Non-retryable"):
            drive(f.runtime)
        self.assertEqual(self.reviews_started(), 1)

    def test_a_reviewer_that_writes_no_file_times_out_with_evidence_retained(self):
        f = self.fixture
        f.sessions.reviewer_writes_completion = False
        f.runtime.plan["automatic"]["review_timeout_seconds"] = 1
        with patch("workflow.automatic.wait_handoffs"), patch("workflow.automatic.time.sleep"), \
                self.assertRaisesRegex(RuntimeError, "Non-retryable"):
            drive(f.runtime)
        receipt = read_json(f.directory / "automatic-review.json")
        self.assertEqual(receipt["status"], "blocked")
        self.assertIn("deadline exhausted", receipt["error"])
        self.assertFalse((f.directory / "review.completion.json").exists())
        self.assertTrue((f.directory / "review.diff").exists())
        self.assertEqual(self.reviews_started(), 1)
        # No second reviewer is launched for the same blocked review.
        with patch("workflow.automatic.time.sleep"), self.assertRaisesRegex(RuntimeError, "Non-retryable"):
            drive(f.runtime)
        self.assertEqual(self.reviews_started(), 1)


class PrintReviewerTests(AutomaticGraphTests):
    """`--reviewer-transport print`: the retained fallback for hosts without Herdr."""

    transport = "print"
    # Graph recovery, interruption and the completion protocol are exercised by the
    # native class; print mode has no session, pane or completion file of its own.
    test_recovery_in_actual_new_controller_processes = None
    test_interrupt_during_worker_wait_keeps_workers_and_resumes = None
    test_deadline_or_blocked_worker_stops_workers = None
    test_a_foreign_completion_file_is_not_a_verdict = None
    test_a_reviewer_that_writes_no_file_times_out_with_evidence_retained = None


if __name__ == "__main__":
    unittest.main()
