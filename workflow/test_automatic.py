"""Offline automatic-controller tests: synthetic Claude, real Git/checkpoints/checks."""
import json
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from langgraph.checkpoint.sqlite import SqliteSaver

from .automatic import DEFAULTS, automatic_settings, drive, read_completion, review_candidate, validate_automatic, wait_handoffs, supervise
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

    def test_reviewer_transport_defaults_to_native_and_legacy_plans_still_validate(self):
        from .automatic import reviewer_transport
        self.assertEqual(automatic_settings()["reviewer_transport"], "native")
        self.assertEqual(automatic_settings(reviewer_transport="print")["reviewer_transport"], "print")
        with self.assertRaisesRegex(ValueError, "reviewer transport"):
            automatic_settings(reviewer_transport="stdio")
        # Plans pinned before this slice have no reviewer_transport and mean native.
        legacy = {"run_id": "test", "source_branch": "feature/test",
                  "automatic": {key: value for key, value in DEFAULTS.items() if key != "reviewer_transport"}}
        validate_automatic(legacy)
        self.assertEqual(reviewer_transport(legacy), "native")
        self.assertEqual(reviewer_transport(self.plan), "native")
        self.plan["automatic"]["reviewer_transport"] = "print"
        validate_automatic(self.plan)
        self.assertEqual(reviewer_transport(self.plan), "print")
        for bad in ("stdio", None, 1):
            self.plan["automatic"]["reviewer_transport"] = bad
            with self.assertRaises(ValueError):
                validate_automatic(self.plan)
        self.plan["automatic"] = dict(DEFAULTS, extra=True)
        with self.assertRaises(ValueError):
            validate_automatic(self.plan)

    def test_main_and_unbounded_authority_rejected(self):
        self.plan["source_branch"] = "main"
        with self.assertRaises(ValueError):
            validate_automatic(self.plan)
        self.plan["source_branch"] = "feature/test"
        self.plan["automatic"]["worker_timeout_seconds"] = 0
        with self.assertRaises(ValueError):
            validate_automatic(self.plan)


class ReviewCompletionTests(unittest.TestCase):
    """Unit-level acceptance of the reviewer's completion file and of the wait loop."""

    TOKEN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.bundle = {"run_id": "test", "candidate_commit": "c" * 40, "snapshots": {"ui": {"session_id": "ui-session"}, "adapter": {"session_id": "adapter-session"}}}
        self.digest = "b" * 64
        plan = {"run_id": "test", "source_branch": "feature/test", "automatic": dict(DEFAULTS)}
        self.rows = [{"sessionId": "33333333-3333-4333-8333-333333333333", "state": "idle"}]
        sessions = SimpleNamespace(inventory=lambda: list(self.rows), locate=lambda node, rows: rows[0] if rows else None)
        self.events = []
        self.runtime = SimpleNamespace(directory=self.root, plan=plan, sessions=sessions, validate_bundle=lambda: (self.bundle, self.digest),
                                       event=lambda node, status, message: self.events.append((node, status, message)))
        save_json(self.root / "automatic-review.json", {"transport": "native", "launch_token": self.TOKEN, "bundle_sha256": self.digest,
                                                         "candidate_commit": "c" * 40, "status": "running"})
        save_json(self.root / "review.interactive.json", {"launch_requested_at": "1970-01-01T00:00:00+00:00"})

    def completion(self, **updates):
        item = {"version": "1.0.0", "run_id": "test", "node_id": "review", "launch_token": self.TOKEN, "bundle_sha256": self.digest,
                "candidate_commit": "c" * 40, "verdict": "approved",
                "findings": [{"severity": "P2", "message": "Finding", "disposition": "open", "worker": "ui", "requirement": "Read UI"}]}
        item.update(updates)
        return item

    def test_completion_prompt_spells_out_every_enum_the_schema_enforces(self):
        # Seen live: a reviewer given only an example invented severity "P3" and its whole file was
        # rejected; the prompt must name every allowed value rather than rely on one example.
        from .automatic import completion_protocol_prompt
        prompt = completion_protocol_prompt(self.runtime, self.TOKEN, self.digest, "c" * 40)
        for value in ("P0, P1 or P2", "no P3", "open, resolved or accepted", "ui, adapter, both or none", "approved or blocked", "no other keys"):
            self.assertIn(value, prompt)
        self.assertIn(self.TOKEN, prompt)
        self.assertIn(self.digest, prompt)

    def test_valid_completion_is_reduced_to_the_decision(self):
        from .automatic import read_review_completion
        save_json(self.root / "review.completion.json", self.completion())
        self.assertEqual(read_review_completion(self.runtime), {"verdict": "approved", "findings": self.completion()["findings"]})

    def test_stale_foreign_or_malformed_completions_fail_closed(self):
        from .automatic import read_review_completion
        cases = {"wrong bundle": {"bundle_sha256": "0" * 64}, "wrong token": {"launch_token": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"},
                 "wrong candidate": {"candidate_commit": "d" * 40}, "wrong run": {"run_id": "other"}, "wrong node": {"node_id": "ui"},
                 "wrong version": {"version": "2.0.0"}, "extra key": {"extra": True}, "bad verdict": {"verdict": "maybe"},
                 "bad worker": {"findings": [{"severity": "P2", "message": "x", "disposition": "open", "worker": "reviewer", "requirement": None}]},
                 "missing finding link": {"findings": [{"severity": "P2", "message": "x", "disposition": "open"}]},
                 "empty requirement": {"findings": [{"severity": "P2", "message": "x", "disposition": "open", "worker": "ui", "requirement": ""}]}}
        for name, updates in cases.items():
            with self.subTest(name):
                save_json(self.root / "review.completion.json", self.completion(**updates))
                with self.assertRaises(RuntimeError):
                    read_review_completion(self.runtime)
        item = self.completion()
        del item["findings"]
        save_json(self.root / "review.completion.json", item)
        with self.assertRaises(RuntimeError):
            read_review_completion(self.runtime)
        (self.root / "review.completion.json").write_text("{not json")
        with self.assertRaises(RuntimeError):
            read_review_completion(self.runtime)
        (self.root / "review.completion.json").unlink()
        (self.root / "review.completion.json").symlink_to(self.root / "automatic-review.json")
        with self.assertRaises(RuntimeError):
            read_review_completion(self.runtime)

    def test_wait_accepts_only_an_idle_reviewer_with_a_file_and_never_relaunches(self):
        from .automatic import wait_review
        ticks = iter([1, 1, 1, DEFAULTS["review_timeout_seconds"] + 1])
        with self.assertRaisesRegex(RuntimeError, "deadline exhausted; no second reviewer"):
            wait_review(self.runtime, clock=lambda: next(ticks), sleep=lambda _: None)
        save_json(self.root / "review.completion.json", self.completion())
        self.rows[0]["state"] = "working"
        ticks = iter([1, 1, DEFAULTS["review_timeout_seconds"] + 1])
        with self.assertRaisesRegex(RuntimeError, "deadline exhausted"):
            wait_review(self.runtime, clock=lambda: next(ticks), sleep=lambda _: None)
        # `blocked` means the session needs a human (a question in its pane): the wait continues
        # until the deadline, recorded once, and never treated as a verdict or a failure.
        self.rows[0]["state"] = "blocked"
        ticks = iter([1, 1, 1, DEFAULTS["review_timeout_seconds"] + 1])
        with self.assertRaisesRegex(RuntimeError, "deadline exhausted"):
            wait_review(self.runtime, clock=lambda: next(ticks), sleep=lambda _: None)
        self.assertEqual([event[1] for event in self.events], ["interactive"])
        self.assertIn("needs attention", self.events[0][2])
        # Answered in the pane, the reviewer finishes: the file is accepted once the session is idle.
        states = iter(["blocked", "blocked", "idle"])
        self.rows[0]["state"] = "blocked"
        def settle(_seconds):
            self.rows[0]["state"] = next(states)
        self.assertEqual(wait_review(self.runtime, clock=lambda: 1, sleep=settle)["verdict"], "approved")
        self.rows[0]["state"] = "done"
        self.assertEqual(wait_review(self.runtime, clock=lambda: 1, sleep=lambda _: self.fail("Unexpected wait"))["verdict"], "approved")
        self.rows.clear()
        with self.assertRaisesRegex(RuntimeError, "missing; reconciliation"):
            wait_review(self.runtime, clock=lambda: 1, sleep=lambda _: None)


class GraphFixture(unittest.TestCase):
    """Automatic graph over the offline pipeline fixture; subclasses pick the reviewer transport."""

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
        f.plan.update(source_branch="feature/automatic-test", automatic=automatic_settings(reviewer_transport=self.transport),
                      policy_sha256=policy_digest(f.policy))
        save_json(f.directory / "plan.json", f.plan)
        save_json(f.directory / "policy.json", f.policy)
        f.runtime = fixtures.OfflinePipeline(f.directory, f.sessions)
        self.counter = f.root / "review-count"
        self.verdict = f.root / "review-verdict"
        self.verdict.write_text("approved")
        self.findings = f.root / "review-findings.json"  # Optional: the findings the fake print reviewer reports.
        f.sessions.reviewer_verdict_file = self.verdict
        executable = f.root / "fake-reviewer"
        executable.write_text(f'''#!/usr/bin/env python3
import json, sys
from pathlib import Path
args = sys.argv
assert args[args.index('--tools') + 1] == 'Read,Glob,Grep'
assert '--dangerously-skip-permissions' not in args
assert '--bg' not in args
counter = Path({str(self.counter)!r})
counter.write_text(str(int(counter.read_text()) + 1) if counter.exists() else '1')
verdict = Path({str(self.verdict)!r}).read_text()
findings_file = Path({str(self.findings)!r})
findings = json.loads(findings_file.read_text()) if findings_file.exists() else []
print(json.dumps({{"session_id": args[args.index('--session-id') + 1], "is_error": False, "subtype": "success",
                  "structured_output": {{"verdict": verdict, "findings": findings}}}}))
''')
        executable.chmod(0o700)
        f.sessions.executable = str(executable)
        with SqliteSaver.from_conn_string(str(f.directory / "pipeline.sqlite")) as saver:
            graph = build_pipeline(saver, f.runtime)
            first = graph.invoke({"run_id": "run"}, f.config)
            self.assertEqual(first["__interrupt__"][0].value["kind"], "worker_handoff")

    def reviewer_launches(self) -> int:
        if self.transport == "print":
            return int(self.counter.read_text()) if self.counter.exists() else 0
        log = self.fixture.directory / "fake-launches.log"
        return log.read_text().split().count("review") if log.exists() else 0

    def expected_starts(self) -> list:
        return sorted(["ui", "adapter"] + (["review"] if self.transport == "native" else []))

    def events(self) -> list:
        return [json.loads(line) for line in (self.fixture.directory / "events.jsonl").read_text().splitlines()]


class SharedGraphTests:
    """Behaviour that must hold for both reviewer transports."""

    def test_automatic_drill_review_and_feature_only_finish(self):
        f = self.fixture
        # Completion protocol has separate tests; FakeSessions already supplied handoffs.
        with patch("workflow.automatic.wait_handoffs"):
            commit = drive(f.runtime)
        self.assertEqual(git(f.repo, "rev-parse", "HEAD"), commit)
        self.assertEqual(git(f.repo, "rev-parse", self.original_branch), f.plan["base_commit"])
        self.assertEqual(git(f.repo, "symbolic-ref", "--short", "HEAD"), "feature/automatic-test")
        self.assertEqual(sorted(f.sessions.starts), self.expected_starts())
        self.assertEqual(self.reviewer_launches(), 1)
        self.assertEqual(read_json(f.directory / "failure-report.json")["verification_attempts"], {"ui": [1], "adapter": [1, 2]})
        receipt = read_json(f.directory / "automatic-review.json")
        self.assertEqual((receipt["transport"], receipt["status"]), (self.transport, "succeeded"))
        self.assertIn("accepted_at", receipt)
        self.assertEqual(read_json(f.directory / "review.json")["reviewer"], receipt["session_id"])
        self.assertEqual(drive(f.runtime), commit)
        self.assertEqual(self.reviewer_launches(), 1)
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
assert not [node for node in sessions.starts if node != 'review'], 'Restart launched workers again'
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
        self.assertEqual(len({event["message"] for event in self.events() if event["node"] == "controller"}), 3)
        self.assertEqual(read_json(f.directory / "failure-report.json")["verification_attempts"], {"ui": [1], "adapter": [1, 2]})
        self.assertEqual(git(f.repo, "rev-parse", self.original_branch), f.plan["base_commit"])
        self.assertEqual(self.reviewer_launches(), 1)

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
        self.assertEqual(sorted(f.sessions.starts), self.expected_starts())

    def test_deadline_or_blocked_worker_stops_workers(self):
        f = self.fixture
        with patch("workflow.automatic.wait_handoffs", side_effect=RuntimeError("Worker ui deadline exhausted; no automatic relaunch")), \
                patch.object(f.runtime, "stop_workers") as stop:
            with self.assertRaisesRegex(RuntimeError, "deadline exhausted"):
                drive(f.runtime)
        stop.assert_called_once()
        self.assertEqual(self.reviewer_launches(), 0)

    def test_reviewer_block_preserves_branch_and_does_not_relaunch(self):
        f = self.fixture
        self.verdict.write_text("blocked")
        with patch("workflow.automatic.wait_handoffs"), self.assertRaisesRegex(RuntimeError, "Non-retryable"):
            drive(f.runtime)
        self.assertEqual(git(f.repo, "rev-parse", "HEAD"), f.plan["base_commit"])
        receipt = read_json(f.directory / "automatic-review.json")
        self.assertEqual(receipt["status"], "blocked")
        self.assertIn("blocked the candidate", receipt["error"])
        review = read_json(f.directory / "review.json")
        self.assertEqual((review["verdict"], review["reviewer"]), ("blocked", receipt["session_id"]))
        with self.assertRaisesRegex(RuntimeError, "Non-retryable"):
            drive(f.runtime)
        self.assertEqual(self.reviewer_launches(), 1)


class AutomaticGraphTests(SharedGraphTests, GraphFixture):
    transport = "native"


class PrintReviewerGraphTests(SharedGraphTests, GraphFixture):
    transport = "print"

    def test_print_mode_never_starts_a_native_reviewer(self):
        f = self.fixture
        with patch("workflow.automatic.wait_handoffs"):
            drive(f.runtime)
        self.assertFalse((f.directory / "review.interactive.json").exists())
        self.assertFalse((f.directory / "review.completion.json").exists())
        self.assertTrue((f.directory / "review.stdout.json").exists())
        self.assertEqual(f.sessions.starts.count("review"), 0)

    def test_print_findings_carry_worker_and_requirement_into_review_and_export(self):
        f = self.fixture
        findings = [{"severity": "P2", "message": "Table lacks a disposition column", "disposition": "open", "worker": "ui", "requirement": "UI"},
                    {"severity": "P1", "message": "Fixed during review", "disposition": "resolved", "worker": "adapter", "requirement": None},
                    {"severity": "P2", "message": "Policy scoping", "disposition": "accepted", "worker": "none", "requirement": None}]
        self.findings.write_text(json.dumps(findings))
        with patch("workflow.automatic.wait_handoffs"):
            commit = drive(f.runtime)
        self.assertEqual(git(f.repo, "rev-parse", "HEAD"), commit)
        review = read_json(f.directory / "review.json")
        self.assertEqual((review["verdict"], review["findings"]), ("approved", findings))
        self.assertEqual([(item["worker"], item["requirement"]) for item in review["findings"]], [("ui", "UI"), ("adapter", None), ("none", None)])
        receipt = read_json(f.directory / "automatic-review.json")
        self.assertEqual((receipt["transport"], receipt["status"], receipt["decision"]["findings"]), ("print", "succeeded", findings))
        exported = read_json(f.directory / "run-state.json")
        self.assertEqual(exported["review"]["transport"], "print")
        self.assertEqual(exported["review"]["findings"], findings)
        self.assertEqual(exported["inputs"]["automatic"]["reviewer_transport"], "print")
        self.assertEqual(self.reviewer_launches(), 1)

    def test_print_finding_without_worker_is_rejected_by_the_schema_without_relaunch(self):
        f = self.fixture
        self.findings.write_text(json.dumps([{"severity": "P2", "message": "Legacy finding shape", "disposition": "open"}]))
        with patch("workflow.automatic.wait_handoffs"), self.assertRaisesRegex(RuntimeError, "Non-retryable"):
            drive(f.runtime)
        receipt = read_json(f.directory / "automatic-review.json")
        self.assertEqual((receipt["transport"], receipt["status"]), ("print", "blocked"))
        self.assertIn("'worker' is a required property", receipt["error"])
        self.assertNotIn("decision", receipt)
        self.assertFalse((f.directory / "review.json").exists())
        self.assertEqual(git(f.repo, "rev-parse", "HEAD"), f.plan["base_commit"])
        with patch("workflow.automatic.wait_handoffs"), self.assertRaisesRegex(RuntimeError, "Non-retryable"):
            drive(f.runtime)
        self.assertEqual(self.reviewer_launches(), 1)
        self.assertEqual(f.sessions.starts.count("review"), 0)


class NativeReviewerGraphTests(GraphFixture):
    transport = "native"

    def test_native_reviewer_session_findings_and_stop_are_recorded(self):
        f = self.fixture
        f.sessions.reviewer_findings = [
            {"severity": "P2", "message": "Table lacks a disposition column", "disposition": "open", "worker": "ui", "requirement": "UI"},
            {"severity": "P1", "message": "Fixed during review", "disposition": "resolved", "worker": "adapter", "requirement": None},
            {"severity": "P2", "message": "Policy scoping", "disposition": "accepted", "worker": "none", "requirement": None}]
        with patch("workflow.automatic.wait_handoffs"):
            commit = drive(f.runtime)
        self.assertEqual(git(f.repo, "rev-parse", "HEAD"), commit)
        receipt = read_json(f.directory / "review.interactive.json")
        self.assertEqual((receipt["node_id"], receipt["session_id"]), ("review", fixtures.FakeSessions.REVIEWER_UUID))
        completion = read_json(f.directory / "review.completion.json")
        self.assertEqual(completion["launch_token"], receipt["launch_token"])
        review = read_json(f.directory / "review.json")
        self.assertEqual(review["reviewer"], fixtures.FakeSessions.REVIEWER_UUID)
        self.assertEqual(review["verdict"], "approved")
        self.assertEqual([(item["worker"], item["requirement"]) for item in review["findings"]], [("ui", "UI"), ("adapter", None), ("none", None)])
        self.assertEqual(review["findings"], f.sessions.reviewer_findings)
        automatic_receipt = read_json(f.directory / "automatic-review.json")
        self.assertEqual((automatic_receipt["transport"], automatic_receipt["status"], automatic_receipt["session_id"], automatic_receipt["launch_token"]),
                         ("native", "succeeded", fixtures.FakeSessions.REVIEWER_UUID, receipt["launch_token"]))
        self.assertTrue(read_json(f.directory / "review.stop.json")["stopped"])
        prompt = (f.directory / "review.prompt.txt").read_text()
        for expected in (str(f.directory / "review.completion.json"), receipt["launch_token"], completion["bundle_sha256"],
                         completion["candidate_commit"], '"worker"', '"requirement"', "nodes.<worker>.task", "human"):
            self.assertIn(expected, prompt)
        review_events = [event for event in self.events() if event["node"] == "review"]
        self.assertTrue(any(fixtures.FakeSessions.REVIEWER_UUID in event["message"] and event["status"] == "interactive" for event in review_events))
        self.assertEqual([event["status"] for event in review_events][-2:], ["stopped", "approved"])
        exported = read_json(f.directory / "run-state.json")
        self.assertEqual((exported["review"]["transport"], exported["review"]["reviewer_session_id"], exported["review"]["reviewed_at"]),
                         ("native", fixtures.FakeSessions.REVIEWER_UUID, automatic_receipt["accepted_at"]))
        self.assertEqual(exported["inputs"]["automatic"]["reviewer_transport"], "native")

    def test_interrupted_reviewer_wait_keeps_the_reviewer_and_resumes_in_a_new_process(self):
        f = self.fixture
        marker = f.root / "interrupt-once"
        marker.touch()
        script = '''import sys
from pathlib import Path
from workflow import automatic
from workflow.sessions import read_json
from workflow.test_pipeline import OfflinePipeline, FakeSessions
directory, marker = Path(sys.argv[1]), Path(sys.argv[2])
sessions = FakeSessions(directory, read_json(directory / 'plan.json'))
runtime = OfflinePipeline(directory, sessions)
automatic.wait_handoffs = lambda runtime: None
real_wait = automatic.wait_review
def interrupted_once(runtime, **kwargs):
    if marker.exists():
        marker.unlink()
        raise KeyboardInterrupt
    return real_wait(runtime, **kwargs)
automatic.wait_review = interrupted_once
try:
    commit = automatic.drive(runtime, single_step=True)
except KeyboardInterrupt:
    sys.exit(130)
assert not [node for node in sessions.starts if node != 'review'], 'Restart launched workers again'
sys.exit(0 if commit else 75)
'''
        codes = []
        for _ in range(5):
            result = subprocess.run([sys.executable, "-c", script, str(f.directory), str(marker)],
                                    cwd=Path(__file__).resolve().parents[1], capture_output=True, text=True, timeout=90)
            codes.append(result.returncode)
            self.assertIn(result.returncode, (0, 75, 130), result.stderr)
            if result.returncode == 130:
                # The interrupted controller left the reviewer running: receipt still running, no stop, no error.
                receipt = read_json(f.directory / "automatic-review.json")
                self.assertEqual((receipt["transport"], receipt["status"]), ("native", "running"))
                self.assertNotIn("error", receipt)
                self.assertFalse((f.directory / "review.stop.json").exists())
                self.assertFalse((f.directory / "review.json").exists())
                self.assertTrue(any(event["node"] == "review" and event["status"] == "interrupted" and "NOT stopped" in event["message"] for event in self.events()))
                self.assertTrue(f.runtime.sessions.locate("review", f.runtime.sessions.inventory()))
            if result.returncode == 0:
                break
        self.assertEqual(codes, [75, 130, 75, 0])
        self.assertEqual(self.reviewer_launches(), 1)
        self.assertEqual(read_json(f.directory / "review.json")["verdict"], "approved")
        self.assertEqual(read_json(f.directory / "automatic-review.json")["status"], "succeeded")
        self.assertTrue(read_json(f.directory / "review.stop.json")["stopped"])
        self.assertEqual(git(f.repo, "rev-parse", self.original_branch), f.plan["base_commit"])

    def assert_rejected(self, mutate, error):
        f = self.fixture
        f.sessions.reviewer_mutate = mutate
        with patch("workflow.automatic.wait_handoffs"), patch.object(f.runtime, "stop_reviewer", wraps=f.runtime.stop_reviewer) as stop:
            with self.assertRaisesRegex(RuntimeError, "Non-retryable"):
                drive(f.runtime)
            stop.assert_called_once()
        receipt = read_json(f.directory / "automatic-review.json")
        self.assertEqual(receipt["status"], "blocked")
        self.assertIn(error, receipt["error"])
        self.assertTrue((f.directory / "review.stop.json").exists())
        self.assertEqual(git(f.repo, "rev-parse", "HEAD"), f.plan["base_commit"])
        with patch("workflow.automatic.wait_handoffs"), self.assertRaisesRegex(RuntimeError, "Non-retryable"):
            drive(f.runtime)
        self.assertEqual(self.reviewer_launches(), 1)

    def test_completion_with_wrong_bundle_hash_fails_closed(self):
        self.assert_rejected(lambda item: {**item, "bundle_sha256": "0" * 64}, "Stale or foreign")
        self.assertFalse((self.fixture.directory / "review.json").exists())

    def test_completion_with_wrong_launch_token_fails_closed(self):
        self.assert_rejected(lambda item: {**item, "launch_token": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"}, "Stale or foreign")

    def test_completion_with_wrong_candidate_fails_closed(self):
        self.assert_rejected(lambda item: {**item, "candidate_commit": "d" * 40}, "Stale or foreign")

    def test_completion_with_unknown_or_missing_keys_fails_closed(self):
        self.assert_rejected(lambda item: {**item, "surprise": 1}, "schema")

    def test_blocked_verdict_ends_the_run_with_review_recorded(self):
        self.assert_rejected(lambda item: {**item, "verdict": "blocked"}, "blocked the candidate")
        self.assertEqual(read_json(self.fixture.directory / "review.json")["verdict"], "blocked")

    def test_unresolved_p1_blocks_even_when_the_reviewer_says_approved(self):
        finding = {"severity": "P1", "message": "Unresolved defect", "disposition": "open", "worker": "adapter", "requirement": None}
        self.assert_rejected(lambda item: {**item, "findings": [finding]}, "blocked the candidate")
        review = read_json(self.fixture.directory / "review.json")
        self.assertEqual((review["verdict"], review["findings"]), ("blocked", [finding]))
        self.assertEqual(read_json(self.fixture.directory / "automatic-review.json")["decision"]["verdict"], "approved")

    # ---- Launch window and post-acceptance stop -----------------------------------------------------

    def assert_launch_window_interrupt_resumes(self, bound):
        """Ctrl-C after `claude --bg` returned: the reviewer exists and keeps running; resume accepts its file."""
        f = self.fixture
        uuid, background = fixtures.FakeSessions.REVIEWER_UUID, fixtures.FakeSessions.REVIEWER_UUID[:8]
        real_launch = f.runtime.launch_reviewer
        def launch_then_interrupt(prompt, launch_token, candidate_commit):
            real_launch(prompt, launch_token, candidate_commit)  # The launch command returned: the session exists.
            if not bound:
                # Ctrl-C inside the settle poll: the launcher journaled its intent but never bound the row.
                receipt = read_json(f.directory / "review.interactive.json")
                receipt.update(session_id=None, background_id=None, status="needs_reconciliation", error="")
                save_json(f.directory / "review.interactive.json", receipt)
            raise KeyboardInterrupt  # Ctrl-C in the settle poll or the pane attach.
        with patch("workflow.automatic.wait_handoffs"), patch.object(f.runtime, "launch_reviewer", side_effect=launch_then_interrupt), \
                patch.object(f.runtime, "stop_reviewer") as stop:
            with self.assertRaises(KeyboardInterrupt):
                drive(f.runtime)
        stop.assert_not_called()
        receipt = read_json(f.directory / "automatic-review.json")
        self.assertEqual((receipt["transport"], receipt["status"]), ("native", "running"))
        self.assertNotIn("error", receipt)
        if bound:
            self.assertEqual((receipt["session_id"], receipt["background_id"]), (uuid, background))
        else:
            self.assertNotIn("session_id", receipt)
            self.assertNotIn("background_id", receipt)
        self.assertFalse((f.directory / "review.stop.json").exists())
        self.assertFalse((f.directory / "review.json").exists())
        self.assertTrue(any(event["node"] == "review" and event["status"] == "interrupted" and "NOT stopped" in event["message"]
                            and "resume with" in event["message"] for event in self.events()))
        self.assertEqual(self.reviewer_launches(), 1)
        # Resume: the same session's file is accepted; nothing is launched again.
        with patch("workflow.automatic.wait_handoffs"), patch.object(f.sessions, "run_reviewer", side_effect=AssertionError("relaunched")):
            commit = drive(f.runtime)
        self.assertEqual(git(f.repo, "rev-parse", "HEAD"), commit)
        self.assertEqual(self.reviewer_launches(), 1)
        receipt = read_json(f.directory / "automatic-review.json")
        self.assertEqual((receipt["status"], receipt["session_id"], receipt["background_id"]), ("succeeded", uuid, background))
        interactive = read_json(f.directory / "review.interactive.json")
        self.assertEqual((interactive["status"], interactive["session_id"], interactive["background_id"]), ("attached_session_available", uuid, background))
        self.assertNotIn("error", interactive)
        self.assertEqual(read_json(f.directory / "review.json")["reviewer"], uuid)
        self.assertTrue(read_json(f.directory / "review.stop.json")["stopped"])
        reconciled = [event for event in self.events() if event["node"] == "review" and "reconcil" in event["message"]]
        self.assertEqual(bool(reconciled), not bound)
        if reconciled:
            self.assertIn(uuid, reconciled[-1]["message"])

    def test_interrupt_after_launch_with_a_bound_session_resumes_the_same_reviewer(self):
        self.assert_launch_window_interrupt_resumes(bound=True)

    def test_interrupt_inside_the_settle_poll_reconciles_the_reviewer_then_resumes(self):
        self.assert_launch_window_interrupt_resumes(bound=False)

    def test_interrupt_before_the_launch_was_issued_needs_reconciliation(self):
        f = self.fixture
        with patch("workflow.automatic.wait_handoffs"), patch.object(f.sessions, "run_reviewer", side_effect=KeyboardInterrupt), \
                patch.object(f.runtime, "stop_reviewer") as stop:
            with self.assertRaises(KeyboardInterrupt):
                drive(f.runtime)
        stop.assert_not_called()
        receipt = read_json(f.directory / "automatic-review.json")
        self.assertEqual((receipt["transport"], receipt["status"]), ("native", "needs_reconciliation"))
        self.assertFalse((f.directory / "review.interactive.json").exists())
        self.assertFalse(any(event["status"] == "interrupted" for event in self.events()))
        with patch("workflow.automatic.wait_handoffs"), patch.object(f.sessions, "run_reviewer", side_effect=AssertionError("relaunched")):
            with self.assertRaisesRegex(RuntimeError, "needs reconciliation; no automatic relaunch"):
                review_candidate(f.runtime)
        self.assertEqual(self.reviewer_launches(), 0)

    def test_failed_reviewer_launch_needs_reconciliation_and_never_relaunches(self):
        f = self.fixture
        error = "Claude background launch exited 1; inspect launch log"
        with patch("workflow.automatic.wait_handoffs"), patch.object(f.sessions, "run_reviewer", side_effect=RuntimeError(error)), \
                patch.object(f.runtime, "stop_reviewer") as stop:
            with self.assertRaisesRegex(RuntimeError, "Non-retryable"):
                drive(f.runtime)
        stop.assert_not_called()
        receipt = read_json(f.directory / "automatic-review.json")
        self.assertEqual((receipt["transport"], receipt["status"], receipt["error"]), ("native", "needs_reconciliation", error))
        self.assertNotIn("session_id", receipt)
        self.assertEqual(receipt["patch_sha256"], fixtures.digest_file(f.directory / "review.diff"))
        self.assertTrue(any(event["node"] == "review" and event["status"] == "blocked" and event["message"] == error for event in self.events()))
        self.assertFalse((f.directory / "review.interactive.json").exists())
        self.assertFalse((f.directory / "review.stop.json").exists())
        self.assertFalse((f.directory / "review.json").exists())
        self.assertEqual(git(f.repo, "rev-parse", "HEAD"), f.plan["base_commit"])
        with patch("workflow.automatic.wait_handoffs"), patch.object(f.sessions, "run_reviewer", side_effect=AssertionError("relaunched")):
            with self.assertRaisesRegex(RuntimeError, "Non-retryable"):
                drive(f.runtime)
            with self.assertRaisesRegex(RuntimeError, "needs reconciliation; no automatic relaunch"):
                review_candidate(f.runtime)
        self.assertEqual(self.reviewer_launches(), 0)

    def test_unconfirmed_stop_after_acceptance_keeps_the_verdict_and_is_retried_on_resume(self):
        f = self.fixture
        real_stop = f.runtime.stop_reviewer
        attempts = []
        def stop_failing_once():
            attempts.append(1)
            if len(attempts) == 1:
                raise RuntimeError("Stop failed for review; inspect native session before retrying")
            real_stop()
        with patch("workflow.automatic.wait_handoffs"), patch.object(f.runtime, "stop_reviewer", side_effect=stop_failing_once):
            with self.assertRaisesRegex(RuntimeError, "Reviewer stop not confirmed.*resume"):
                drive(f.runtime)
        self.assertEqual(len(attempts), 1)
        receipt = read_json(f.directory / "automatic-review.json")
        self.assertEqual((receipt["transport"], receipt["status"], receipt["session_id"]), ("native", "succeeded", fixtures.FakeSessions.REVIEWER_UUID))
        self.assertNotIn("error", receipt)
        self.assertFalse((f.directory / "review.stop.json").exists())
        self.assertEqual(read_json(f.directory / "review.json")["verdict"], "approved")
        self.assertEqual(git(f.repo, "rev-parse", "HEAD"), f.plan["base_commit"])
        last = [event for event in self.events() if event["node"] == "review"][-1]
        self.assertEqual(last["status"], "running")
        self.assertIn("Could not confirm reviewer stop: Stop failed for review", last["message"])
        self.assertIn("resume retries the stop", last["message"])
        # Resume: the accepted verdict is reused, the stop is retried and confirmed, nothing is relaunched.
        with patch("workflow.automatic.wait_handoffs"), patch.object(f.runtime, "stop_reviewer", side_effect=stop_failing_once), \
                patch.object(f.sessions, "run_reviewer", side_effect=AssertionError("relaunched")):
            commit = drive(f.runtime)
        self.assertEqual(len(attempts), 2)
        self.assertEqual(git(f.repo, "rev-parse", "HEAD"), commit)
        self.assertTrue(read_json(f.directory / "review.stop.json")["stopped"])
        self.assertEqual(read_json(f.directory / "automatic-review.json")["status"], "succeeded")
        self.assertEqual(self.reviewer_launches(), 1)
        self.assertEqual([event["status"] for event in self.events() if event["node"] == "review"][-2:], ["stopped", "approved"])

    # ---- Re-checks between the accepted file and the verdict --------------------------------------

    def assert_refused_after_wait(self, error):
        """The file was accepted by the wait; the re-check refuses it: blocked, stopped once, no verdict, no relaunch."""
        self.assert_rejected(None, error)
        self.assertFalse((self.fixture.directory / "review.json").exists())
        self.assertNotIn("decision", read_json(self.fixture.directory / "automatic-review.json"))

    def test_reviewer_identity_changed_after_the_file_is_refused(self):
        self.fixture.sessions.reviewer_row_after_file = {"sessionId": "44444444-4444-4444-8444-444444444444"}
        self.assert_refused_after_wait("Reviewer identity changed or is not independent")

    def test_reviewer_that_is_a_worker_session_is_not_independent(self):
        f = self.fixture
        f.sessions.reviewer_session_id = f.plan["nodes"]["ui"]["session_id"]  # The bundle snapshots carry the workers' UUIDs.
        self.assert_refused_after_wait("Reviewer identity changed or is not independent")

    def test_reviewer_missing_after_the_file_is_refused(self):
        from . import automatic
        f = self.fixture
        real_wait = automatic.wait_review
        def wait_then_vanish(runtime, **kwargs):
            decision = real_wait(runtime, **kwargs)
            f.sessions.reviewer_row_after_file = "missing"  # The session exits right after the wait accepted its file.
            return decision
        with patch("workflow.automatic.wait_review", side_effect=wait_then_vanish):
            self.assert_refused_after_wait("Reviewer identity changed or is not independent")

    def test_reviewer_worktree_change_is_refused(self):
        f = self.fixture
        f.sessions.reviewer_after_file = lambda: (f.directory / "review-worktree" / "ui.txt").write_text("edited during review")
        self.assert_refused_after_wait("Reviewer worktree changed")

    def test_evidence_change_during_review_is_refused(self):
        f = self.fixture
        f.sessions.reviewer_after_file = lambda: (f.directory / "review.diff").write_text("rewritten during review\n")
        self.assert_refused_after_wait("Evidence changed during review")

    def test_reviewer_deadline_without_a_file_stops_the_reviewer_and_launches_no_second(self):
        f = self.fixture
        f.sessions.reviewer_writes_file = False
        clock = SimpleNamespace(value=time.time())  # The deadline counts from the reviewer's real launch time.
        def tick():
            clock.value += DEFAULTS["review_timeout_seconds"] / 2 + 1
            return clock.value
        with patch("workflow.automatic.wait_handoffs"), patch("workflow.automatic.time") as fake_time, \
                patch.object(f.runtime, "stop_reviewer", wraps=f.runtime.stop_reviewer) as stop:
            fake_time.time.side_effect = tick
            fake_time.sleep.return_value = None
            with self.assertRaisesRegex(RuntimeError, "Non-retryable"):
                drive(f.runtime)
            stop.assert_called_once()
        receipt = read_json(f.directory / "automatic-review.json")
        self.assertEqual(receipt["status"], "blocked")
        self.assertIn("deadline exhausted; no second reviewer", receipt["error"])
        self.assertFalse((f.directory / "review.json").exists())
        with patch("workflow.automatic.wait_handoffs"), self.assertRaisesRegex(RuntimeError, "Non-retryable"):
            drive(f.runtime)
        self.assertEqual(self.reviewer_launches(), 1)


if __name__ == "__main__":
    unittest.main()
