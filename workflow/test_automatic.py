"""Offline automatic-controller tests: synthetic Claude, real Git/checkpoints/checks."""
import contextlib
import io
import json
import os
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
from .sessions import git, read_json, review_node, save_json
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
        self.events = []
        self.runtime = SimpleNamespace(directory=self.root, plan=self.plan, sessions=sessions,
                                       event=lambda node, status, message: self.events.append((node, status, message)))
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

    def test_blocked_worker_waits_for_attention_instead_of_ending_the_run(self):
        # A native session reports `blocked` when its turn ended needing a human (a question, a permission
        # prompt, a refusal the harness could not continue past). The run waits until that lane's deadline,
        # records the need for attention once, and never stops the other lanes because of it.
        states = {"ui": "blocked", "adapter": "working"}
        self.runtime.sessions.locate = lambda node, rows: {"state": states[node]}
        ticks = iter([1] * 6 + [DEFAULTS["worker_timeout_seconds"] + 1])
        with self.assertRaisesRegex(RuntimeError, "Worker ui deadline exhausted"):
            wait_handoffs(self.runtime, clock=lambda: next(ticks), sleep=lambda _: None)
        self.assertEqual(self.events, [("ui", "interactive", "Worker ui needs attention in its pane (native state blocked); waiting until its deadline")])
        self.assertFalse((self.root / "ui.handoff.json").exists())
        # Answered in the pane, the worker finishes: its completion file is accepted once its session is idle.
        for node in self.plan["nodes"]:
            save_json(self.root / f"{node}.completion.json", self.completion(node))
        self.events.clear()
        sequence = iter(["blocked", "blocked", "idle"])
        states["adapter"] = "idle"
        def settle(_seconds):
            states["ui"] = next(sequence)
        wait_handoffs(self.runtime, clock=lambda: 1, sleep=settle)
        self.assertEqual(read_json(self.root / "ui.handoff.json")["summary"], "Synthetic work")
        self.assertEqual([event[1] for event in self.events], ["interactive"])

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

    def test_an_update_respawn_gap_is_waited_out_not_a_missing_worker(self):
        # Seen in workflow-guardrails-001: an update restarts Claude Code's background service, which about 15 seconds later
        # respawns each idle session (a finished lane, a lane paused on a question) under a new PID. In between the listing
        # omits the session or still lists its ended PID. The lane is looked at again at the next poll, for a bounded grace;
        # a gap that outlasts it is Claude Code unavailable (the run exits 75 and stops nothing), never a missing worker.
        from .interactive import DEAD_PID_GRACE_SECONDS
        from .sessions import TransientInfraError
        ended = subprocess.Popen(["sleep", "60"])
        ended.kill()
        ended.wait()
        for node in self.plan["nodes"]:
            save_json(self.root / f"{node}.interactive.json", {"launch_requested_at": "1970-01-01T00:00:00+00:00", "background_id": f"{node}-bg"})
            save_json(self.root / f"{node}.completion.json", self.completion(node))
        ui, adapter = {"id": "ui-bg", "state": "working", "pid": os.getpid()}, {"id": "adapter-bg", "state": "idle", "pid": os.getpid()}
        self.runtime.sessions.locate = lambda node, rows: next((row for row in rows if row["id"] == f"{node}-bg"), None)
        listings = iter([[ui, adapter], [ui], [ui, {**adapter, "pid": ended.pid}], [{**ui, "state": "idle"}, {**adapter, "pid": os.getppid()}]])
        self.runtime.sessions.inventory = lambda: next(listings)
        wait_handoffs(self.runtime, clock=lambda: 1, sleep=lambda _: None)
        self.assertEqual({node: read_json(self.root / f"{node}.handoff.json")["summary"] for node in self.plan["nodes"]},
                         {"ui": "Synthetic work", "adapter": "Synthetic work"})
        self.assertEqual(self.events, [])
        for node in self.plan["nodes"]:
            (self.root / f"{node}.handoff.json").unlink()
        # The finished lane stays missing: after the grace the wait ends as Claude Code unavailable.
        now = [1.0]
        listings = iter([[ui, adapter], *[[ui]] * 10])
        with self.assertRaisesRegex(TransientInfraError, rf"^Claude Code has not listed a live adapter session \(adapter-bg\) for {DEAD_PID_GRACE_SECONDS}s"):
            wait_handoffs(self.runtime, clock=lambda: now[0], sleep=lambda seconds: now.__setitem__(0, now[0] + 10))
        self.assertEqual(now[0], 1 + 10 + DEAD_PID_GRACE_SECONDS)
        self.assertFalse((self.root / "adapter.handoff.json").exists())

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

    def test_supervisor_stops_resumable_when_claude_code_was_unavailable(self):
        from .automatic import UNAVAILABLE_EXIT
        from .sessions import TransientInfraError
        save_json(self.root / "plan.json", self.plan)
        with patch("workflow.automatic.subprocess.run", return_value=subprocess.CompletedProcess([], UNAVAILABLE_EXIT)) as run:
            with self.assertRaisesRegex(TransientInfraError, "Nothing was stopped.*resume with: python -m workflow automatic .* --live"):
                supervise(self.root)
        self.assertEqual(run.call_count, 1)  # Not restarted: the operator reruns it once `claude` works.

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
        runtime = SimpleNamespace(directory=self.root, policy=policy, workers=["ui", "adapter"],
                                  attempt=lambda phase, node: attempts.get(f"{phase}:{node}", 1),
                                  retry_check=lambda phase, node: bumped.append((phase, node)))
        state = SimpleNamespace(next=("verify_adapter",), tasks=[SimpleNamespace(name="verify_adapter", error="blocked")])
        for attempt in (1, 2):
            directory = self.root / "verification" / "worker" / "adapter" / str(attempt)
            directory.mkdir(parents=True)
            # A reason may quote a path inside its own attempt directory; that must not make the attempts look different.
            reasons = ["backend-unit: exit 1", "backend-unit: no passing test evidence or failed tests",
                       f"browser: [Errno 2] No such file or directory: '{directory / 'browser-report-2.json'}'"]
            save_json(directory / "packet.json", {"gate": {"status": "blocked", "reasons": reasons}})
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
        runtime = SimpleNamespace(directory=self.root, policy={"max_verification_attempts": 3}, workers=["ui", "adapter"],
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


class SupervisorTimelineTests(unittest.TestCase):
    """The supervisor's terminal follows events.jsonl, whoever appends to it, and prints each event once."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        save_json(self.root / "plan.json", {"run_id": "test", "source_branch": "feature/test", "automatic": dict(DEFAULTS)})
        poll = patch("workflow.automatic.TIMELINE_POLL_SECONDS", 0.01)
        poll.start()
        self.addCleanup(poll.stop)
        self.sequence = 0

    def append(self, node, status, message, at="2026-09-23T20:08:49.123456Z") -> str:
        """Append one event the way Pipeline.event does; return the line the supervisor should print for it."""
        self.sequence += 1
        with (self.root / "events.jsonl").open("a") as handle:
            handle.write(json.dumps({"sequence": self.sequence, "time": at, "node": node, "status": status, "message": message}) + "\n")
        return f"{at[11:19]}  {node:<22} {status:<12} {message}"

    def supervise(self, *steps) -> list[str]:
        """supervise() with fake automatic-step children: each (action, exit code) runs action(output) then exits."""
        import contextlib
        import io
        output = io.StringIO()
        pending = iter(steps)

        def step(command, **_):
            action, code = next(pending)
            action(output)
            return subprocess.CompletedProcess(command, code)
        with patch("workflow.automatic.subprocess.run", side_effect=step), contextlib.redirect_stdout(output):
            supervise(self.root)
        return output.getvalue().splitlines()

    def printed_while_running(self, output, line):
        deadline = time.monotonic() + 10
        while line not in output.getvalue().splitlines():
            if time.monotonic() > deadline:
                self.fail(f"Not printed while the step was still running: {line!r}")
            time.sleep(0.01)

    def test_events_appended_by_the_steps_print_as_they_happen_in_order_exactly_once(self):
        expected = []

        def first(output):
            expected.append(self.append("controller", "running", "Automatic checkpoint controller PID 1"))
            expected.append(self.append("verify_ui", "running", "Attempt 1; revision abc"))
            self.printed_while_running(output, expected[-1])

        def second(output):
            expected.append(self.append("controller", "running", "Automatic checkpoint controller PID 2"))
            expected.append(self.append("verify_ui", "passed", "Required tests and artifacts passed"))
        printed = self.supervise((first, 75), (lambda output: None, 75), (second, 0))
        self.assertIn("no events yet", printed[0])
        self.assertEqual(printed[1:], expected)

    def test_a_resume_prints_the_recent_tail_then_only_new_events(self):
        from .automatic import TIMELINE_TAIL
        earlier = [self.append("controller", "blocked", f"Blocked {number}") for number in range(1, TIMELINE_TAIL + 4)]
        new = []
        printed = self.supervise((lambda output: new.append(self.append("controller", "running", "Resumed")), 0))
        self.assertIn(f"last {TIMELINE_TAIL} of {len(earlier)} events", printed[0])
        self.assertEqual(printed[1:], earlier[-TIMELINE_TAIL:] + new)
        # Supervising again shows the tail once more as context, and nothing twice.
        printed = self.supervise((lambda output: None, 0))
        self.assertEqual(printed[1:], (earlier + new)[-TIMELINE_TAIL:])

    def test_a_partly_written_event_prints_only_once_its_line_is_complete(self):
        record = json.dumps({"sequence": 1, "time": "2026-09-23T20:08:49Z", "node": "freeze", "status": "succeeded",
                             "message": "Immutable snapshots captured"}) + "\n"
        line = f"20:08:49  {'freeze':<22} {'succeeded':<12} Immutable snapshots captured"

        def half(output):
            with (self.root / "events.jsonl").open("a") as handle:
                handle.write(record[:30])
            time.sleep(0.2)  # Many polls see the partial line.

        def rest(output):
            self.assertEqual(output.getvalue().splitlines()[1:], [])
            with (self.root / "events.jsonl").open("a") as handle:
                handle.write(record[30:])
            self.printed_while_running(output, line)
        printed = self.supervise((half, 75), (rest, 0))
        self.assertEqual(printed[1:], [line])

    def test_a_rewritten_timeline_prints_only_events_not_yet_shown(self):
        shown = [self.append("controller", "running", "A long message " + "x" * 200) for _ in range(3)]
        events = self.root / "events.jsonl"
        added = []

        def rewrite(output):
            # Shorter than what was read: reread from the start, and the sequence numbers skip what was shown.
            kept = [json.loads(line) for line in events.read_text().splitlines()]
            events.write_text("".join(json.dumps(dict(event, message="short")) + "\n" for event in kept))
            self.sequence = len(kept)
            added.append(self.append("controller", "running", "New after the rewrite"))
            self.printed_while_running(output, added[-1])
        printed = self.supervise((rewrite, 0))
        self.assertEqual(printed[1:], shown + added)

    def test_each_event_is_one_line_in_utc(self):
        self.append("candidate_ui", "blocked", "Executed check failed:\nbrowser: exit 1", at="2026-09-23T22:24:50.5+02:00")
        printed = self.supervise((lambda output: None, 0))
        self.assertEqual(printed[1:], [f"20:24:50  {'candidate_ui':<22} {'blocked':<12} Executed check failed: browser: exit 1"])


class ReviewCompletionTests(unittest.TestCase):
    """Unit-level acceptance of a reviewer's completion file and of the wait loop, with the single default reviewer."""

    TOKEN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    reviewers = None  # None: the single default reviewer `review`; a list: declared reviewer ids.

    @property
    def ids(self):
        return list(self.reviewers or ["review"])

    def node(self, reviewer_id):
        return review_node(reviewer_id)

    def token(self, reviewer_id):
        return self.TOKEN if reviewer_id == "review" else self.TOKEN.replace("aaaaaaaa", f"{self.ids.index(reviewer_id) + 1:08d}")

    def uuid(self, reviewer_id):
        return f"{self.ids.index(reviewer_id) + 3:08d}-3333-4333-8333-333333333333"

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.bundle = {"run_id": "test", "candidate_commit": "c" * 40, "snapshots": {"ui": {"session_id": "ui-session"}, "adapter": {"session_id": "adapter-session"}}}
        self.digest = "b" * 64
        plan = {"run_id": "test", "source_branch": "feature/test", "automatic": dict(DEFAULTS)}
        if self.reviewers:
            plan["reviewers"] = [{"reviewer_id": reviewer_id, "prompt": f"Check {reviewer_id}."} for reviewer_id in self.reviewers]
        self.rows = {reviewer_id: {"id": self.uuid(reviewer_id)[:8], "sessionId": self.uuid(reviewer_id), "state": "idle"} for reviewer_id in self.ids}
        sessions = SimpleNamespace(inventory=lambda: [dict(row) for row in self.rows.values()],
                                   locate=lambda node, rows: next((row for row in rows if row["id"] == self.uuid(self.reviewer_of(node))[:8]), None))
        self.events = []
        self.runtime = SimpleNamespace(directory=self.root, plan=plan, sessions=sessions, validate_bundle=lambda: (self.bundle, self.digest),
                                       event=lambda node, status, message: self.events.append((node, status, message)))
        combined = {"transport": "native", "bundle_sha256": self.digest, "candidate_commit": "c" * 40, "status": "running", "reviewers": self.ids}
        for reviewer_id in self.ids:
            status = {"reviewer_id": reviewer_id, "node_id": self.node(reviewer_id), "transport": "native", "launch_token": self.token(reviewer_id),
                      "session_id": self.uuid(reviewer_id), "bundle_sha256": self.digest, "candidate_commit": "c" * 40, "status": "running"}
            if self.node(reviewer_id) == "review":
                combined = {**status, **combined}
            else:
                save_json(self.root / f"automatic-{self.node(reviewer_id)}.json", status)
            save_json(self.root / f"{self.node(reviewer_id)}.interactive.json", {"launch_requested_at": "1970-01-01T00:00:00+00:00"})
        save_json(self.root / "automatic-review.json", combined)

    def reviewer_of(self, node):
        return node[len("review-"):] if node.startswith("review-") else "review"

    def completion(self, reviewer_id="review", **updates):
        item = {"version": "1.2.0", "run_id": "test", "node_id": self.node(reviewer_id), "launch_token": self.token(reviewer_id), "bundle_sha256": self.digest,
                "candidate_commit": "c" * 40, "verdict": "approved",
                "findings": [{"severity": "P2", "message": "Finding", "disposition": "open", "worker": "ui", "requirement": "Read UI"}]}
        item.update(updates)
        return item

    def write(self, reviewer_id="review", **updates):
        save_json(self.root / f"{self.node(reviewer_id)}.completion.json", self.completion(reviewer_id, **updates))

    def test_completion_prompt_spells_out_every_enum_the_schema_enforces(self):
        # Seen live: a reviewer given only an example invented severity "P3" and its whole file was
        # rejected; the prompt must name every allowed value rather than rely on one example.
        from .automatic import completion_protocol_prompt
        for reviewer_id in self.ids:
            prompt = completion_protocol_prompt(self.runtime, self.token(reviewer_id), self.digest, "c" * 40, reviewer_id)
            for value in ("P0, P1 or P2", "no P3", "open, resolved or accepted", "ui, adapter, multiple or none", "never both", "approved or blocked", "no other keys"):
                self.assertIn(value, prompt)
            self.assertIn(self.token(reviewer_id), prompt)
            self.assertIn(self.digest, prompt)
            self.assertIn(f'"node_id": "{self.node(reviewer_id)}"', prompt)
            self.assertIn(str(self.root / f"{self.node(reviewer_id)}.completion.json"), prompt)
            others = [other for other in self.ids if other != reviewer_id]
            self.assertEqual(f"You are reviewer `{reviewer_id}`" in prompt, bool(others))
            for other in others:
                self.assertIn(other, prompt)
        self.assertEqual(completion_protocol_prompt(self.runtime, self.TOKEN, self.digest, "c" * 40),
                         completion_protocol_prompt(self.runtime, self.TOKEN, self.digest, "c" * 40, "review"))

    def test_review_prompt_is_the_brief_plus_the_fixed_blocks(self):
        from .automatic import BUILTIN_REVIEW_BRIEF, review_brief, review_prompt
        builtin = review_prompt(self.runtime, self.root / "review.diff")
        self.assertTrue(builtin.startswith(review_brief(None)))
        self.assertIn("Do not infer approval merely from test success.", BUILTIN_REVIEW_BRIEF.read_text())
        custom = review_prompt(self.runtime, self.root / "review.diff", {"reviewer_id": "coverage", "prompt": "Only look at\n test coverage. "})
        self.assertTrue(custom.startswith("Only look at test coverage. Diff: "))
        self.assertNotIn("Do not infer approval", custom)
        # The fixed blocks (bundle paths, task locations, lane vocabulary) are identical for every brief.
        fixed = builtin[len(review_brief(None)):]
        self.assertEqual(custom[len("Only look at test coverage."):], fixed)
        for expected in (str(self.root / "review.diff"), str(self.root / "review-bundle.json"), "nodes.<worker>.task", "worker lanes are: ui, adapter.", "(ui, adapter, multiple or none:"):
            self.assertIn(expected, fixed)

    def test_valid_completion_is_reduced_to_the_decision(self):
        from .automatic import read_review_completion
        for reviewer_id in self.ids:
            self.write(reviewer_id)
            self.assertEqual(read_review_completion(self.runtime, reviewer_id), {"verdict": "approved", "findings": self.completion(reviewer_id)["findings"]})
        if self.reviewers is None:
            self.assertEqual(read_review_completion(self.runtime), {"verdict": "approved", "findings": self.completion()["findings"]})

    def test_stale_foreign_or_malformed_completions_fail_closed(self):
        from .automatic import read_review_completion
        for reviewer_id in self.ids:
            other = next((item for item in self.ids if item != reviewer_id), None)
            cases = {"wrong bundle": {"bundle_sha256": "0" * 64}, "wrong token": {"launch_token": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"},
                     "wrong candidate": {"candidate_commit": "d" * 40}, "wrong run": {"run_id": "other"}, "wrong node": {"node_id": self.node(other) if other else "ui"},
                     "other reviewer's token": {"launch_token": self.token(other) if other else "cccccccc-cccc-4ccc-8ccc-cccccccccccc"},
                     "wrong version": {"version": "2.0.0"}, "extra key": {"extra": True}, "bad verdict": {"verdict": "maybe"},
                     "bad worker": {"findings": [{"severity": "P2", "message": "x", "disposition": "open", "worker": "Reviewer", "requirement": None}]},
                     "lane not in this run": {"findings": [{"severity": "P2", "message": "x", "disposition": "open", "worker": "docs", "requirement": None}]},
                     "legacy both": {"findings": [{"severity": "P2", "message": "x", "disposition": "open", "worker": "both", "requirement": None}]},
                     "missing finding link": {"findings": [{"severity": "P2", "message": "x", "disposition": "open"}]},
                     "empty requirement": {"findings": [{"severity": "P2", "message": "x", "disposition": "open", "worker": "ui", "requirement": ""}]}}
            for name, updates in cases.items():
                with self.subTest(reviewer=reviewer_id, case=name):
                    self.write(reviewer_id, **updates)
                    with self.assertRaises(RuntimeError):
                        read_review_completion(self.runtime, reviewer_id)
            item = self.completion(reviewer_id)
            del item["findings"]
            path = self.root / f"{self.node(reviewer_id)}.completion.json"
            save_json(path, item)
            with self.assertRaises(RuntimeError):
                read_review_completion(self.runtime, reviewer_id)
            path.write_text("{not json")
            with self.assertRaises(RuntimeError):
                read_review_completion(self.runtime, reviewer_id)
            path.unlink()
            path.symlink_to(self.root / "automatic-review.json")
            with self.assertRaises(RuntimeError):
                read_review_completion(self.runtime, reviewer_id)
            path.unlink()

    def test_wait_accepts_only_idle_reviewers_with_files_and_never_relaunches(self):
        from .automatic import wait_reviews
        first, last = self.ids[0], self.ids[-1]
        def ticks():
            return iter([1] * (2 * len(self.ids) + 1) + [DEFAULTS["review_timeout_seconds"] + 1] * len(self.ids))
        with self.assertRaisesRegex(RuntimeError, "Reviewer (review|general|coverage) deadline exhausted; no second reviewer") as expired:
            wait_reviews(self.runtime, clock=lambda clock=ticks(): next(clock), sleep=lambda _: None)
        expired_id = str(expired.exception).split()[1]
        self.assertIn("deadline exhausted", read_json(self.root / f"automatic-{self.node(expired_id)}.json")["error"])
        for reviewer_id in self.ids:
            self.write(reviewer_id)
        self.rows[last]["state"] = "working"
        with self.assertRaisesRegex(RuntimeError, "deadline exhausted"):
            wait_reviews(self.runtime, clock=lambda clock=ticks(): next(clock), sleep=lambda _: None)
        # `blocked` means the session needs a human (a question in its pane): the wait continues
        # until the deadline, recorded once per reviewer, and never treated as a verdict or a failure.
        self.rows[last]["state"] = "blocked"
        with self.assertRaisesRegex(RuntimeError, "deadline exhausted"):
            wait_reviews(self.runtime, clock=lambda clock=ticks(): next(clock), sleep=lambda _: None)
        self.assertEqual([event[1] for event in self.events], ["interactive"])
        self.assertIn(f"Reviewer {last} needs attention", self.events[0][2])
        # Answered in the pane, the reviewer finishes: the file is accepted once the session is idle.
        states = iter(["blocked", "blocked", "idle"])
        self.rows[last]["state"] = "blocked"
        def settle(_seconds):
            self.rows[last]["state"] = next(states)
        decisions = wait_reviews(self.runtime, clock=lambda: 1, sleep=settle)
        self.assertEqual({reviewer_id: decision["verdict"] for reviewer_id, decision in decisions.items()}, {reviewer_id: "approved" for reviewer_id in self.ids})
        self.rows[last]["state"] = "done"
        self.assertEqual(list(wait_reviews(self.runtime, clock=lambda: 1, sleep=lambda _: self.fail("Unexpected wait"))), self.ids)
        if len(self.ids) > 1:
            # A reviewer's file with another reviewer's node id is a foreign signal; nothing is relaunched.
            self.write(last, node_id=self.node(first))
            with self.assertRaisesRegex(RuntimeError, f"Stale or foreign review completion signal \\({last}\\)"):
                wait_reviews(self.runtime, clock=lambda: 1, sleep=lambda _: None)
            self.assertEqual(read_json(self.root / f"automatic-{self.node(last)}.json")["status"], "blocked")
            # One blocked verdict returns at once; the other reviewers are not waited for.
            self.write(last, verdict="blocked")
            self.rows[first]["state"] = "working"
            self.assertEqual(list(wait_reviews(self.runtime, clock=lambda: 1, sleep=lambda _: self.fail("Unexpected wait"))), [last])
            self.rows[first]["state"] = "idle"
            self.write(last)
        del self.rows[last]
        with self.assertRaisesRegex(RuntimeError, f"Native reviewer {last} missing; reconciliation"):
            wait_reviews(self.runtime, clock=lambda: 1, sleep=lambda _: None)

    def test_an_update_respawn_gap_is_waited_out_not_a_missing_reviewer(self):
        # A reviewer that wrote its file and went idle is what an update respawns under a new PID. While the listing omits it,
        # the wait looks at it again at the next poll, for a bounded grace; after that Claude Code is unavailable, not a verdict.
        from .automatic import wait_reviews
        from .interactive import DEAD_PID_GRACE_SECONDS
        from .sessions import TransientInfraError
        for reviewer_id in self.ids:
            path = self.root / f"{self.node(reviewer_id)}.interactive.json"
            save_json(path, {**read_json(path), "background_id": self.uuid(reviewer_id)[:8]})
            self.rows[reviewer_id]["pid"] = os.getpid()
            self.write(reviewer_id)
        last = self.ids[-1]
        respawned = {**self.rows.pop(last), "pid": os.getppid()}
        decisions = wait_reviews(self.runtime, clock=lambda: 1, sleep=lambda _: self.rows.update({last: respawned}))
        self.assertEqual(list(decisions), self.ids)
        self.assertEqual(self.events, [])
        del self.rows[last]
        now = [1.0]
        with self.assertRaisesRegex(TransientInfraError, rf"^Claude Code has not listed a live {self.node(last)} session "
                                                         rf"\({self.uuid(last)[:8]}\) for {DEAD_PID_GRACE_SECONDS}s"):
            wait_reviews(self.runtime, clock=lambda: now[0], sleep=lambda seconds: now.__setitem__(0, now[0] + 10))
        self.assertEqual(now[0], 1 + DEAD_PID_GRACE_SECONDS)
        self.assertNotIn("error", read_json(self.root / f"automatic-{self.node(last)}.json"))

    def bind_live(self):
        """Every reviewer's receipt bound to its background id, each listed with a live PID (this process's), each file written."""
        for reviewer_id in self.ids:
            path = self.root / f"{self.node(reviewer_id)}.interactive.json"
            save_json(path, {**read_json(path), "background_id": self.uuid(reviewer_id)[:8]})
            self.rows[reviewer_id]["pid"] = os.getpid()
            self.write(reviewer_id)

    def test_the_identity_check_after_the_files_waits_out_an_update_respawn_gap(self):
        # The identity check lists the reviewers once more right after the wait accepted their files, when they are idle: what an
        # update respawns under a new PID. A listing in that gap is taken again 2 seconds later, as the wait does: the session back
        # under a new PID passes, a gap that outlasts the grace is Claude Code unavailable. A changed UUID is still refused at once.
        from .automatic import ReviewStatus, check_independence
        from .interactive import DEAD_PID_GRACE_SECONDS
        from .sessions import TransientInfraError
        self.bind_live()
        state = ReviewStatus.load(self.runtime)
        first, last = self.ids[0], self.ids[-1]
        listed = [dict(row) for reviewer_id, row in self.rows.items() if reviewer_id != last]
        listings = iter([listed, [*listed, {**self.rows[last], "pid": os.getppid()}]])
        self.runtime.sessions.inventory = lambda: next(listings)
        sleeps = []
        check_independence(self.runtime, self.bundle, state, clock=lambda: 1, sleep=sleeps.append)
        self.assertEqual(sleeps, [2])
        self.runtime.sessions.inventory = lambda: [{**self.rows[first], "sessionId": "44444444-4444-4444-8444-444444444444"}]
        with self.assertRaisesRegex(RuntimeError, rf"^Reviewer identity changed or is not independent \({first}\); refusing the verdict"):
            check_independence(self.runtime, self.bundle, state, clock=lambda: 1, sleep=sleeps.append)
        self.assertEqual(sleeps, [2])
        now = [1.0]
        self.runtime.sessions.inventory = lambda: [dict(row) for row in listed]
        with self.assertRaisesRegex(TransientInfraError, rf"^Claude Code has not listed a live {self.node(last)} session "
                                                         rf"\({self.uuid(last)[:8]}\) for {DEAD_PID_GRACE_SECONDS}s"):
            check_independence(self.runtime, self.bundle, state, clock=lambda: now[0], sleep=lambda seconds: now.__setitem__(0, now[0] + seconds))
        self.assertEqual(now[0], 1 + DEAD_PID_GRACE_SECONDS)

    def test_a_respawn_gap_that_outlasts_the_grace_after_the_files_interrupts_the_review_and_stops_no_reviewer(self):
        # Used to: one listing without the idle reviewer refused the verdict ("identity changed"), blocked the review and stopped
        # every reviewer. Now the review node records the interruption the next `automatic --live` re-enters; nothing is stopped.
        from unittest.mock import Mock
        from .automatic import ReviewStatus, _accept_native, review_interrupted
        from .sessions import TransientInfraError
        self.bind_live()
        last = self.ids[-1]
        listings = iter([[dict(row) for row in self.rows.values()]])  # The wait accepts every file; then the respawn gap starts.
        self.runtime.sessions.inventory = lambda: next(listings, [dict(row) for reviewer_id, row in self.rows.items() if reviewer_id != last])
        self.runtime.stop_reviewer = Mock()
        clock = SimpleNamespace(now=1.0)
        with patch("workflow.automatic.time") as fake_time, self.assertRaises(TransientInfraError):
            fake_time.time.side_effect = lambda: clock.now
            fake_time.sleep.side_effect = lambda seconds: setattr(clock, "now", clock.now + seconds)
            _accept_native(self.runtime, self.bundle, self.digest, ReviewStatus.load(self.runtime))
        self.runtime.stop_reviewer.assert_not_called()
        combined = read_json(self.root / "automatic-review.json")
        self.assertEqual(combined["status"], "running")
        self.assertTrue(combined["interrupted"].startswith(f"Claude Code has not listed a live {self.node(last)} session"), combined["interrupted"])
        self.assertNotIn("error", combined)
        self.assertFalse(any((self.root / f"{self.node(reviewer_id)}.stop.json").exists() for reviewer_id in self.ids))
        self.assertEqual([event[:2] for event in self.events], [("review", "interrupted")])
        failed = SimpleNamespace(next=("review",), tasks=[SimpleNamespace(name="review", error="TransientInfraError('Claude Code has not listed')")])
        self.assertTrue(review_interrupted(self.runtime, failed))

    def test_claude_code_unavailable_during_the_wait_stops_no_reviewer_and_is_resumed_once(self):
        from unittest.mock import Mock
        from .automatic import ReviewStatus, _accept_native, resume_interrupted_review, review_interrupted, settle_interruption
        from .sessions import TransientInfraError
        self.runtime.stop_reviewer = Mock()
        self.runtime.sessions.inventory = Mock(side_effect=TransientInfraError("Claude session inventory unavailable: timed out"))
        with self.assertRaises(TransientInfraError):
            _accept_native(self.runtime, self.bundle, self.digest, ReviewStatus.load(self.runtime))
        self.runtime.stop_reviewer.assert_not_called()
        combined = read_json(self.root / "automatic-review.json")
        self.assertEqual((combined["status"], combined["interrupted"]), ("running", "Claude session inventory unavailable: timed out"))
        self.assertNotIn("error", combined)
        state = ReviewStatus.load(self.runtime)
        self.assertEqual([state.statuses[reviewer_id]["status"] for reviewer_id in self.ids], ["running"] * len(self.ids))
        self.assertFalse(any((self.root / f"{self.node(reviewer_id)}.stop.json").exists() for reviewer_id in self.ids))
        self.assertEqual(len(self.events), 1)
        self.assertEqual(self.events[0][:2], ("review", "interrupted"))
        self.assertIn("NOT stopped", self.events[0][2])
        self.assertIn(f"python -m workflow automatic {self.root} --live", self.events[0][2])
        # The graph recorded the node's error; the next controller re-enters the node once, and only for this state.
        failed = SimpleNamespace(next=("review",), tasks=[SimpleNamespace(name="review", error="TransientInfraError('Claude session inventory unavailable')")])
        self.assertTrue(review_interrupted(self.runtime, failed))
        self.assertTrue(resume_interrupted_review(self.runtime, failed))
        self.assertEqual(self.events[-1][:2], ("review", "running"))
        self.assertIn("rebound, not relaunched", self.events[-1][2])
        # The marker stays until the re-entry's outcome is known: one cut short (Ctrl-C) is re-entered by the next controller,
        # and one interrupted again keeps it.
        self.assertTrue(resume_interrupted_review(self.runtime, failed))
        settle_interruption(self.runtime, failed)
        self.assertTrue(review_interrupted(self.runtime, failed))
        settle_interruption(self.runtime)  # The re-entry ended, or failed for another reason.
        self.assertNotIn("interrupted", read_json(self.root / "automatic-review.json"))
        self.assertFalse(resume_interrupted_review(self.runtime, failed))  # Consumed: a second failure is classified as itself.
        for status in ("blocked", "needs_reconciliation", "succeeded"):
            save_json(self.root / "automatic-review.json", {**combined, "status": status})
            self.assertFalse(review_interrupted(self.runtime, failed), status)


class TwoReviewerCompletionTests(ReviewCompletionTests):
    """The same acceptance rules with two declared reviewers, each bound to its own node, token and files."""
    reviewers = ["general", "coverage"]


class PrintReviewerLaunchTests(unittest.TestCase):
    """The headless reviewer job at unit level (no graph, no checks): a failed exec is repeated, a started job never."""

    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.cwd = self.root / "review-worktree"
        self.cwd.mkdir()
        for args in (["init", "-q"], ["config", "user.name", "Test"], ["config", "user.email", "test@example.invalid"], ["commit", "-q", "--allow-empty", "-m", "Candidate"]):
            subprocess.run(["git", "-C", str(self.cwd), *args], check=True)
        self.patch_file = self.root / "review.diff"
        self.patch_file.write_text("")
        self.executable = self.root / "fake-reviewer"
        self.reviewer(0)
        self.bundle = {"run_id": "test", "candidate_commit": git(self.cwd, "rev-parse", "HEAD"), "snapshots": {}}
        self.runtime = SimpleNamespace(directory=self.root, plan={"run_id": "test", "source_branch": "feature/test", "automatic": dict(DEFAULTS, reviewer_transport="print")},
                                       sessions=SimpleNamespace(executable=str(self.executable)), validate_bundle=lambda: (self.bundle, "b" * 64),
                                       validate_review=lambda review: None)

    def reviewer(self, exit_code: int) -> None:
        """A fake `claude --print` reviewer that records DISABLE_AUTOUPDATER once per start, approves, and exits `exit_code`."""
        self.executable.write_text(f'''#!/usr/bin/env python3
import json, os, sys
with open({str(self.root / "starts")!r}, "a") as handle:
    handle.write(os.environ.get("DISABLE_AUTOUPDATER", "-") + "\\n")
sys.stdin.read()
print(json.dumps({{"session_id": sys.argv[sys.argv.index("--session-id") + 1], "is_error": False, "subtype": "success",
                  "structured_output": {{"verdict": "approved", "findings": []}}}}))
sys.exit({exit_code})
''')
        self.executable.chmod(0o700)

    def review(self, failures: list):
        """_review_print with each of `failures` failing the reviewer's exec first; (review or error, execs, update waits)."""
        from .automatic import _review_print
        real_popen, real_sleep = subprocess.Popen, time.sleep
        execs, waits = [], []
        def popen(command, *args, **kwargs):
            if command[0] == str(self.executable):
                execs.append(kwargs["env"].get("DISABLE_AUTOUPDATER"))
                if failures:
                    raise failures.pop(0)
            return real_popen(command, *args, **kwargs)
        def sleep(seconds):  # Record the update waits; `process.wait` polls with short sleeps of its own.
            if seconds == 2:
                waits.append(seconds)
            else:
                real_sleep(seconds)
        with patch("workflow.sessions.subprocess.Popen", side_effect=popen), patch("workflow.sessions.time.sleep", side_effect=sleep):
            try:
                result = _review_print(self.runtime, self.bundle, "b" * 64, self.cwd, self.patch_file)
            except RuntimeError as error:
                result = error
        return result, execs, waits

    def starts(self) -> list:
        return (self.root / "starts").read_text().splitlines()

    def test_a_print_reviewer_is_started_again_only_when_its_exec_failed(self):
        import errno
        review, execs, waits = self.review([OSError(errno.ETXTBSY, "Text file busy", str(self.executable))])
        self.assertEqual(review["verdict"], "approved")
        self.assertEqual((execs, waits, self.starts()), (["1", "1"], [2], ["1"]))
        # A reviewer job that ran and failed is not started again.
        self.reviewer(1)
        error, execs, waits = self.review([])
        self.assertRegex(str(error), "did not succeed.*No automatic retry")
        self.assertEqual((execs, waits, self.starts()), (["1"], [], ["1", "1"]))


class GraphFixture(unittest.TestCase):
    """Automatic graph over the offline pipeline fixture; subclasses pick the reviewer transport and the reviewers."""

    transport = "native"
    reviewers = None  # None: the single default reviewer `review`; a list: declared reviewer ids with their own briefs.

    @property
    def ids(self):
        return list(self.reviewers or ["review"])

    def node(self, reviewer_id):
        return review_node(reviewer_id)

    def file(self, reviewer_id, suffix):
        return self.fixture.directory / f"{self.node(reviewer_id)}.{suffix}"

    def status(self, reviewer_id):
        """The reviewer's own status file (`automatic-review.json` itself for the default reviewer)."""
        return read_json(self.fixture.directory / f"automatic-{self.node(reviewer_id)}.json")

    def combined(self):
        return read_json(self.fixture.directory / "automatic-review.json")

    def uuid(self, reviewer_id):
        return self.fixture.sessions.native_id(self.node(reviewer_id))

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
        if self.reviewers:
            f.plan["reviewers"] = [{"reviewer_id": reviewer_id, "prompt": f"Review only the {reviewer_id} aspects of this candidate."} for reviewer_id in self.reviewers]
        save_json(f.directory / "plan.json", f.plan)
        save_json(f.directory / "policy.json", f.policy)
        f.sessions = fixtures.FakeSessions(f.directory, f.plan)
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
with counter.open('a') as handle:  # One appended line per launch: parallel jobs cannot lose a count.
    handle.write('launch\\n')
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
            return len(self.counter.read_text().splitlines()) if self.counter.exists() else 0
        log = self.fixture.directory / "fake-launches.log"
        return sum(log.read_text().split().count(self.node(reviewer_id)) for reviewer_id in self.ids) if log.exists() else 0

    def expected_starts(self) -> list:
        return sorted(["ui", "adapter"] + ([self.node(reviewer_id) for reviewer_id in self.ids] if self.transport == "native" else []))

    def events(self) -> list:
        return [json.loads(line) for line in (self.fixture.directory / "events.jsonl").read_text().splitlines()]

    def sessions_joined(self) -> str:
        return ", ".join(self.status(reviewer_id)["session_id"] for reviewer_id in self.ids)

    def untagged(self, findings: list) -> list:
        return [{key: value for key, value in finding.items() if key != "reviewer"} for finding in findings]


class SharedGraphTests:
    """Behaviour that must hold for both reviewer transports, with one and with two reviewers."""

    def test_automatic_drill_review_and_feature_only_finish(self):
        f = self.fixture
        # Completion protocol has separate tests; FakeSessions already supplied handoffs.
        with patch("workflow.automatic.wait_handoffs"):
            commit = drive(f.runtime)
        self.assertEqual(git(f.repo, "rev-parse", "HEAD"), commit)
        self.assertEqual(git(f.repo, "rev-parse", self.original_branch), f.plan["base_commit"])
        self.assertEqual(git(f.repo, "symbolic-ref", "--short", "HEAD"), "feature/automatic-test")
        self.assertEqual(sorted(f.sessions.starts), self.expected_starts())
        self.assertEqual(self.reviewer_launches(), len(self.ids))
        self.assertEqual(read_json(f.directory / "failure-report.json")["verification_attempts"], {"ui": [1], "adapter": [1, 2]})
        receipt = self.combined()
        self.assertEqual((receipt["transport"], receipt["status"], receipt["reviewers"]), (self.transport, "succeeded", self.ids))
        self.assertIn("accepted_at", receipt)
        review = read_json(f.directory / "review.json")
        self.assertEqual(review["reviewer"], self.sessions_joined())
        self.assertEqual([(entry["reviewer_id"], entry["verdict"], entry["session_id"]) for entry in review["reviewers"]],
                         [(reviewer_id, "approved", self.status(reviewer_id)["session_id"]) for reviewer_id in self.ids])
        self.assertTrue(all(isinstance(entry["accepted_at"], str) for entry in review["reviewers"]))
        for reviewer_id in self.ids:
            self.assertEqual((self.status(reviewer_id)["status"], self.status(reviewer_id)["decision"]["verdict"]), ("succeeded", "approved"))
        self.assertEqual(drive(f.runtime), commit)
        self.assertEqual(self.reviewer_launches(), len(self.ids))
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
assert not [node for node in sessions.starts if not node.startswith('review')], 'Restart launched workers again'
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
        self.assertEqual(self.reviewer_launches(), len(self.ids))

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
        receipt = self.combined()
        self.assertEqual(receipt["status"], "blocked")
        self.assertIn("blocked the candidate", receipt["error"])
        review = read_json(f.directory / "review.json")
        self.assertEqual((review["verdict"], review["reviewer"]), ("blocked", self.sessions_joined()))
        # The first reviewer's block decides; nobody waits for the others, whose status records that.
        first = self.ids[0]
        self.assertEqual((self.status(first)["status"], self.status(first)["decision"]["verdict"]), ("blocked", "blocked"))
        self.assertEqual([entry["verdict"] for entry in review["reviewers"]], ["blocked"] + [None] * (len(self.ids) - 1))
        for other in self.ids[1:]:
            self.assertEqual(self.status(other)["status"], "superseded")
            self.assertNotIn("decision", self.status(other))
        with self.assertRaisesRegex(RuntimeError, "Non-retryable"):
            drive(f.runtime)
        self.assertEqual(self.reviewer_launches(), len(self.ids))


class ClaudeUnavailableTests(GraphFixture):
    """Claude Code itself unavailable (an update, a restarting background service): nothing is stopped, the run resumes.

    Every test stops before verification: the checks never run here. A deadline still stops the workers
    (SharedGraphTests.test_deadline_or_blocked_worker_stops_workers).
    """

    def unavailable(self):
        from .sessions import TransientInfraError
        return TransientInfraError("Claude session inventory unavailable: Command '['claude', 'agents', '--json']' timed out after 15 seconds")

    def test_unavailable_during_the_worker_wait_stops_no_worker_and_the_run_resumes(self):
        from .sessions import TransientInfraError
        f = self.fixture
        f.sessions.inventory = lambda: (_ for _ in ()).throw(self.unavailable())
        with patch.object(f.runtime, "stop_workers") as stop:
            with self.assertRaises(TransientInfraError):
                drive(f.runtime)
        stop.assert_not_called()
        event = self.events()[-1]
        self.assertEqual((event["node"], event["status"]), ("controller", "interrupted"))
        for expected in ("Claude session inventory unavailable", "Nothing was stopped", f"python -m workflow automatic {f.directory} --live"):
            self.assertIn(expected, event["message"])
        self.assertFalse(any((f.directory / f"{node}.stop.json").exists() for node in ("ui", "adapter")))
        # Once `claude` works, a new controller goes back to the same wait; nothing is launched or stopped.
        del f.sessions.inventory
        starts = list(f.sessions.starts)
        with patch("workflow.automatic.wait_handoffs", side_effect=KeyboardInterrupt) as wait, patch.object(f.runtime, "stop_workers") as stop:
            with self.assertRaises(KeyboardInterrupt):
                drive(f.runtime)
        wait.assert_called_once_with(f.runtime)
        stop.assert_not_called()
        self.assertEqual(f.sessions.starts, starts)

    def cli(self, argv):
        """`python -m workflow <argv>` in process with the fake sessions; (exit code, stderr)."""
        from . import pipeline
        errors = io.StringIO()
        with patch("workflow.pipeline.InteractiveSessions", side_effect=lambda directory, timeout: self.fixture.sessions), \
                patch("sys.argv", ["workflow", *argv]), contextlib.redirect_stderr(errors), contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaises(SystemExit) as exited:
                pipeline.main()
        return exited.exception.code, errors.getvalue()

    def test_the_step_exits_69_and_automatic_exits_75_resumable(self):
        from .automatic import UNAVAILABLE_EXIT
        from .pipeline import Pipeline
        f = self.fixture
        f.sessions.inventory = lambda: (_ for _ in ()).throw(self.unavailable())
        with patch.object(Pipeline, "stop_workers") as stop:
            code, errors = self.cli(["automatic-step", str(f.directory), "--live"])
        stop.assert_not_called()
        self.assertEqual(code, UNAVAILABLE_EXIT)
        self.assertIn("Interrupted: Claude session inventory unavailable", errors)
        # The supervisor turns that step exit into its own resumable 75, with the stale sessions to restart.
        stale = "Warning: 1 running Claude Code process(es) still run an executable that an update deleted.\n  pid 7 in /work: claude"
        with patch("workflow.automatic.subprocess.run", return_value=subprocess.CompletedProcess([], UNAVAILABLE_EXIT)) as step, \
                patch("workflow.pipeline.stale_claude_warning", return_value=stale):
            code, errors = self.cli(["automatic", str(f.directory), "--live"])
        self.assertEqual((code, step.call_count), (75, 1))
        self.assertIn("Interrupted: Claude Code was unavailable", errors)
        self.assertIn(f"resume with: python -m workflow automatic {f.directory} --live", errors)
        self.assertIn("pid 7 in /work: claude", errors)
        self.assertNotIn("Blocked", errors)
        # A blocked step is still blocked.
        with patch("workflow.automatic.subprocess.run", return_value=subprocess.CompletedProcess([], 1)):
            code, errors = self.cli(["automatic", str(f.directory), "--live"])
        self.assertEqual(code, 1)
        self.assertIn("Blocked: Automatic controller blocked (exit 1)", errors)

    def test_review_interrupted_by_unavailable_claude_code_is_re_entered_once(self):
        # The review node itself is covered at unit level; here a stand-in graph checks how drive treats its failure.
        from .sessions import TransientInfraError
        f = self.fixture
        combined = f.directory / "automatic-review.json"
        graph = SimpleNamespace(error=None, invokes=[], outcome=None)
        def state(config):
            return SimpleNamespace(values={"run_id": "run"}, next=("review",),
                                   tasks=[SimpleNamespace(name="review", error=graph.error, interrupts=())])
        def invoke(value, config):
            graph.invokes.append(value)
            outcome, graph.outcome = graph.outcome, None
            if outcome:
                if isinstance(outcome, Exception):  # LangGraph records a node's error; an interrupted step records nothing.
                    graph.error = repr(outcome)
                raise outcome
            graph.error = None
        graph.get_state, graph.invoke = state, invoke
        with patch("workflow.pipeline.build_pipeline", return_value=graph), patch("workflow.pipeline.report"):
            # The review wait lost `claude`: the node kept its reviewers running and marked the interruption.
            save_json(combined, {"transport": "native", "status": "running", "reviewers": ["review"], "interrupted": "timed out"})
            graph.outcome = self.unavailable()
            with self.assertRaises(TransientInfraError):
                drive(f.runtime)
            self.assertEqual(graph.invokes, [None])
            # A new controller re-enters the node; a Ctrl-C (a closed terminal, a kill) during that re-entry keeps the marker.
            graph.outcome = KeyboardInterrupt()
            with self.assertRaises(KeyboardInterrupt):
                drive(f.runtime, single_step=True)
            self.assertEqual(read_json(combined)["interrupted"], "timed out")
            # The next controller re-enters it again and consumes the marker once the node ends.
            self.assertIsNone(drive(f.runtime, single_step=True))
            self.assertEqual(graph.invokes, [None, None, None])
            self.assertNotIn("interrupted", read_json(combined))
            self.assertIn("Resuming the review interrupted by: timed out", self.events()[-1]["message"])
            # Without the marker (a reviewer launch the outage interrupted leaves the review at needs_reconciliation) the step
            # still ends as Claude Code unavailable, exit 69, never as a persisted checkpoint (75) that the supervisor would
            # continue from; the next controller finds the review non-retryable. Nothing loops or relaunches.
            graph.outcome = self.unavailable()
            save_json(combined, {"transport": "native", "status": "needs_reconciliation", "reviewers": ["review"]})
            with self.assertRaises(TransientInfraError):
                drive(f.runtime, single_step=True)
            event = self.events()[-1]
            self.assertEqual((event["node"], event["status"]), ("controller", "interrupted"))
            self.assertIn(f"python -m workflow automatic {f.directory} --live", event["message"])
            with self.assertRaisesRegex(RuntimeError, "Non-retryable graph failure"):
                drive(f.runtime)
            self.assertEqual(graph.invokes, [None, None, None, None])

    def lanes_live(self):
        """Each lane's session as a live `sleep` process listed by a registry the test controls; `claude stop` ends it."""
        from .sessions import TransientInfraError
        f = self.fixture
        self.processes, self.live, self.stops = {}, {}, []
        self.outage = False
        for node in ("ui", "adapter"):
            process = self.processes[node] = subprocess.Popen(["sleep", "60"])
            self.addCleanup(process.wait)
            self.addCleanup(process.kill)
            self.live[node] = {"id": f.sessions.background_id(node), "sessionId": f.sessions.native_id(node), "kind": "background",
                               "state": "idle", "pid": process.pid}
            # Every lane finished: its completion signal says what FakeSessions' handoff says.
            save_json(f.directory / f"{node}.completion.json", {"version": "1.0.0", "run_id": f.plan["run_id"], "node_id": node,
                                                                "launch_token": f.plan["nodes"][node]["session_id"], "status": "completed",
                                                                **read_json(f.directory / f"{node}.handoff.json")})
        def inventory():
            if self.outage:
                raise TransientInfraError("Claude session inventory unavailable for 60s: `claude agents --json` exited 1")
            return [dict(row) for row in self.live.values()]
        def stop(command, **kwargs):
            node = next(node for node, row in self.live.items() if command[-2:] == ["stop", row["id"]])
            self.stops.append(node)
            self.processes[node].kill()
            self.processes[node].wait()
            del self.live[node]
            self.outage = len(self.stops) == 1  # The background service goes away right after the freeze's first stop.
            return subprocess.CompletedProcess(command, 0)
        f.sessions.inventory = inventory
        return stop

    def test_an_outage_while_the_freeze_stops_the_workers_is_resumed_and_relaunches_nothing(self):
        # Every lane finished and the freeze stops them before the snapshots. Claude Code goes away right after ui's `claude stop`,
        # before that stop is confirmed: the step exits 69 (automatic then exits 75), not 75 "checkpoint persisted", after which
        # the next step used to find no next graph step and block ("No verified feature-branch completion"). The next
        # `automatic --live` completes the recorded stop, stops adapter once and captures the snapshots; nothing is relaunched.
        from .automatic import UNAVAILABLE_EXIT
        f = self.fixture
        stop = self.lanes_live()
        starts = list(f.sessions.starts)
        with patch("workflow.pipeline.run_claude", side_effect=stop):
            code, errors = self.cli(["automatic-step", str(f.directory), "--live"])
            self.assertEqual(code, UNAVAILABLE_EXIT, errors)
            self.assertIn("Interrupted: Claude session inventory unavailable", errors)
            self.assertEqual(self.stops, ["ui"])
            self.assertEqual(read_json(f.directory / "ui.stop.json")["stopped"], False)
            self.assertFalse((f.directory / "adapter.stop.json").exists())
            self.assertFalse((f.directory / "snapshots.json").exists())
            event = self.events()[-1]
            self.assertEqual((event["node"], event["status"]), ("freeze", "interrupted"))
            for expected in ("Claude session inventory unavailable", "stops it recorded", f"python -m workflow automatic {f.directory} --live"):
                self.assertIn(expected, event["message"])
            # Claude Code works again. Verification is not run here: the graph reaching it is the point.
            self.outage = False
            with patch("workflow.pipeline.Pipeline.verify", side_effect=RuntimeError("Verification is not run in this test")) as verify:
                code, errors = self.cli(["automatic-step", str(f.directory), "--live"])
            self.assertEqual(code, 75, errors)
        self.assertIn("Checkpoint persisted", errors)
        self.assertEqual(verify.call_count, 2)
        self.assertEqual(self.stops, ["ui", "adapter"])  # The recorded ui stop was confirmed, not issued again.
        self.assertTrue(all(read_json(f.directory / f"{node}.stop.json")["stopped"] for node in ("ui", "adapter")))
        self.assertEqual(sorted(read_json(f.directory / "snapshots.json")), ["adapter", "ui"])
        self.assertEqual(f.sessions.starts, starts)
        self.assertFalse((f.directory / "freeze-interrupted.json").exists())
        messages = [(event["node"], event["status"], event["message"]) for event in self.events()]
        self.assertIn(("freeze", "running", "Resuming the freeze interrupted by: Claude session inventory unavailable for 60s: "
                                            "`claude agents --json` exited 1; its recorded stops are completed, nothing is relaunched"), messages)
        self.assertEqual([status for node, status, _ in messages if node == "freeze"], ["interrupted", "running", "stopped", "succeeded"])

    def test_a_freeze_re_entry_cut_short_is_re_entered_by_the_next_controller(self):
        # The re-entered freeze can wait up to 60 seconds on a listing: a Ctrl-C then (or a closed terminal, a kill) records
        # nothing, so the checkpoint keeps the old TransientInfraError. The marker used to be consumed before the re-entry, and
        # every later controller stopped at "Freeze failed: ...; non-retryable". It now stays until the re-entry's outcome is
        # known: the next `automatic --live` re-enters the freeze and completes it.
        from .sessions import TransientInfraError
        f = self.fixture
        marker = f.directory / "freeze-interrupted.json"
        real_stop = f.runtime.stop_workers
        outcomes = [self.unavailable(), KeyboardInterrupt()]
        def stop_workers():
            if outcomes:
                raise outcomes.pop(0)
            real_stop()
        with patch("workflow.automatic.wait_handoffs"), patch.object(f.runtime, "stop_workers", side_effect=stop_workers), \
                patch("workflow.pipeline.Pipeline.verify", side_effect=RuntimeError("Verification is not run in this test")) as verify:
            with self.assertRaises(TransientInfraError):
                drive(f.runtime, single_step=True)
            self.assertTrue(marker.exists())
            with self.assertRaises(KeyboardInterrupt):
                drive(f.runtime, single_step=True)
            self.assertEqual(read_json(marker), {"error": str(self.unavailable())})
            self.assertIsNone(drive(f.runtime, single_step=True))
        self.assertEqual(verify.call_count, 2)
        self.assertFalse(marker.exists())
        self.assertEqual(sorted(read_json(f.directory / "snapshots.json")), ["adapter", "ui"])
        self.assertEqual([event["status"] for event in self.events() if event["node"] == "freeze"], ["interrupted", "running", "running", "stopped", "succeeded"])

    def test_a_freeze_that_failed_for_another_reason_is_named_and_never_re_entered(self):
        # A stop that failed, an ownership violation, a moved HEAD: the freeze is not re-entered (the supervisor would loop),
        # and the next controller names that failure instead of "No verified feature-branch completion".
        f = self.fixture
        failure = "Stop failed for ui; inspect native session before retrying"
        with patch("workflow.automatic.wait_handoffs"), patch.object(f.runtime, "stop_workers", side_effect=RuntimeError(failure)) as stop:
            self.assertIsNone(drive(f.runtime, single_step=True))
            for _ in range(2):
                with self.assertRaisesRegex(RuntimeError, rf"^Freeze failed: .*{failure}.*; non-retryable graph failure, inspect retained evidence"):
                    drive(f.runtime)
        stop.assert_called_once()
        self.assertFalse((f.directory / "snapshots.json").exists())


class AutomaticGraphTests(SharedGraphTests, GraphFixture):
    transport = "native"


class AutomaticTwoReviewerGraphTests(SharedGraphTests, GraphFixture):
    transport = "native"
    reviewers = ["general", "coverage"]


class PrintReviewerTests(SharedGraphTests):
    """The headless fallback, with one and with two reviewers."""

    def test_print_mode_never_starts_a_native_reviewer(self):
        f = self.fixture
        with patch("workflow.automatic.wait_handoffs"):
            drive(f.runtime)
        for reviewer_id in self.ids:
            self.assertFalse(self.file(reviewer_id, "interactive.json").exists())
            self.assertFalse(self.file(reviewer_id, "completion.json").exists())
            self.assertTrue(self.file(reviewer_id, "stdout.json").exists())
            self.assertTrue(self.file(reviewer_id, "stderr.log").exists())
            self.assertIn("Return the requested JSON schema.", self.file(reviewer_id, "prompt.txt").read_text())
        self.assertEqual([node for node in f.sessions.starts if node.startswith("review")], [])
        # Every print reviewer has its own session UUID, distinct from every worker's and every other reviewer's.
        sessions = [self.status(reviewer_id)["session_id"] for reviewer_id in self.ids]
        self.assertEqual(len(set(sessions)), len(self.ids))
        self.assertTrue(set(sessions).isdisjoint({f.plan["nodes"][node]["session_id"] for node in ("ui", "adapter")}))

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
        self.assertEqual((review["verdict"], self.untagged(review["findings"])), ("approved", findings * len(self.ids)))
        self.assertEqual([finding["reviewer"] for finding in review["findings"]], [reviewer_id for reviewer_id in self.ids for _ in findings])
        self.assertEqual([(item["worker"], item["requirement"]) for item in review["findings"]], [("ui", "UI"), ("adapter", None), ("none", None)] * len(self.ids))
        for reviewer_id in self.ids:
            receipt = self.status(reviewer_id)
            self.assertEqual((receipt["transport"], receipt["status"], receipt["decision"]["findings"]), ("print", "succeeded", findings))
        exported = read_json(f.directory / "run-state.json")
        self.assertEqual(exported["review"]["transport"], "print")
        self.assertEqual(self.untagged(exported["review"]["findings"]), findings * len(self.ids))
        self.assertEqual([entry["reviewer_id"] for entry in exported["review"]["reviewers"]], self.ids)
        self.assertEqual([len(entry["findings"]) for entry in exported["review"]["reviewers"]], [len(findings)] * len(self.ids))
        self.assertEqual(exported["inputs"]["automatic"]["reviewer_transport"], "print")
        self.assertEqual(self.reviewer_launches(), len(self.ids))

    def test_print_finding_without_worker_is_rejected_by_the_schema_without_relaunch(self):
        f = self.fixture
        self.findings.write_text(json.dumps([{"severity": "P2", "message": "Legacy finding shape", "disposition": "open"}]))
        with patch("workflow.automatic.wait_handoffs"), self.assertRaisesRegex(RuntimeError, "Non-retryable"):
            drive(f.runtime)
        receipt = self.combined()
        self.assertEqual((receipt["transport"], receipt["status"]), ("print", "blocked"))
        self.assertIn("'worker' is a required property", receipt["error"])
        for reviewer_id in self.ids:
            self.assertNotIn("decision", self.status(reviewer_id))
        self.assertFalse((f.directory / "review.json").exists())
        self.assertEqual(git(f.repo, "rev-parse", "HEAD"), f.plan["base_commit"])
        # The first rejection stops the other jobs, which under load may be killed before the fake records itself,
        # so the count after the first drive is at most one per reviewer; the second drive must launch none.
        launched = self.reviewer_launches()
        self.assertTrue(1 <= launched <= len(self.ids), launched)
        with patch("workflow.automatic.wait_handoffs"), self.assertRaisesRegex(RuntimeError, "Non-retryable"):
            drive(f.runtime)
        self.assertEqual(self.reviewer_launches(), launched)
        self.assertEqual([node for node in f.sessions.starts if node.startswith("review")], [])


class PrintReviewerGraphTests(PrintReviewerTests, GraphFixture):
    transport = "print"


class PrintTwoReviewerGraphTests(PrintReviewerTests, GraphFixture):
    transport = "print"
    reviewers = ["general", "coverage"]


class NativeReviewerTests:
    """The native completion protocol, with one and with two reviewers."""

    def test_native_reviewer_session_findings_and_stop_are_recorded(self):
        f = self.fixture
        f.sessions.reviewer_findings = [
            {"severity": "P2", "message": "Table lacks a disposition column", "disposition": "open", "worker": "ui", "requirement": "UI"},
            {"severity": "P1", "message": "Fixed during review", "disposition": "resolved", "worker": "adapter", "requirement": None},
            {"severity": "P2", "message": "Policy scoping", "disposition": "accepted", "worker": "none", "requirement": None}]
        with patch("workflow.automatic.wait_handoffs"):
            commit = drive(f.runtime)
        self.assertEqual(git(f.repo, "rev-parse", "HEAD"), commit)
        review = read_json(f.directory / "review.json")
        self.assertEqual(review["reviewer"], self.sessions_joined())
        self.assertEqual(review["verdict"], "approved")
        self.assertEqual([(item["worker"], item["requirement"]) for item in review["findings"]], [("ui", "UI"), ("adapter", None), ("none", None)] * len(self.ids))
        self.assertEqual(self.untagged(review["findings"]), f.sessions.reviewer_findings * len(self.ids))
        self.assertEqual([finding["reviewer"] for finding in review["findings"]], [reviewer_id for reviewer_id in self.ids for _ in f.sessions.reviewer_findings])
        self.assertEqual([entry["reviewer_id"] for entry in review["reviewers"]], self.ids)
        combined = self.combined()
        self.assertEqual((combined["transport"], combined["status"], combined["reviewers"]), ("native", "succeeded", self.ids))
        for reviewer_id in self.ids:
            node = self.node(reviewer_id)
            receipt = read_json(self.file(reviewer_id, "interactive.json"))
            self.assertEqual((receipt["node_id"], receipt["session_id"]), (node, self.uuid(reviewer_id)))
            completion = read_json(self.file(reviewer_id, "completion.json"))
            status = self.status(reviewer_id)
            self.assertEqual((completion["node_id"], completion["launch_token"]), (node, status["launch_token"]))
            self.assertEqual((status["transport"], status["status"], status["session_id"], status["reviewer_id"], status["node_id"]),
                             ("native", "succeeded", self.uuid(reviewer_id), reviewer_id, node))
            self.assertTrue(read_json(self.file(reviewer_id, "stop.json"))["stopped"])
            prompt = self.file(reviewer_id, "prompt.txt").read_text()
            for expected in (str(self.file(reviewer_id, "completion.json")), status["launch_token"], completion["bundle_sha256"],
                             completion["candidate_commit"], '"worker"', '"requirement"', "nodes.<worker>.task", "human", f'"node_id": "{node}"'):
                self.assertIn(expected, prompt)
            if self.reviewers:
                self.assertTrue(prompt.startswith(f"Review only the {reviewer_id} aspects of this candidate. Diff: "))
            else:
                self.assertTrue(prompt.startswith("Independently review this immutable candidate"))
            self.assertTrue(any(self.uuid(reviewer_id) in event["message"] and event["status"] == "interactive" for event in self.events() if event["node"] == "review"))
        # Every session UUID is distinct: from the workers' and from the other reviewers'.
        self.assertEqual(len({self.uuid(reviewer_id) for reviewer_id in self.ids}), len(self.ids))
        review_events = [event for event in self.events() if event["node"] == "review"]
        self.assertEqual([event["status"] for event in review_events][-len(self.ids) - 1:], ["stopped"] * len(self.ids) + ["approved"])
        exported = read_json(f.directory / "run-state.json")
        self.assertEqual((exported["review"]["transport"], exported["review"]["reviewer_session_id"], exported["review"]["reviewed_at"]),
                         ("native", self.sessions_joined(), combined["accepted_at"]))
        self.assertEqual([(entry["reviewer_id"], entry["transport"], entry["session_id"], entry["verdict"], entry["status"], len(entry["findings"])) for entry in exported["review"]["reviewers"]],
                         [(reviewer_id, "native", self.uuid(reviewer_id), "approved", "accepted", 3) for reviewer_id in self.ids])
        for entry in exported["review"]["reviewers"]:
            self.assertTrue(entry["launched_at"].endswith("Z") and entry["accepted_at"].endswith("Z"))
        self.assertEqual(exported["inputs"]["automatic"]["reviewer_transport"], "native")
        if self.reviewers is None:
            # The default reviewer keeps slice A's files and shape, plus the one-entry reviewers list.
            self.assertEqual(review["reviewers"], [{"reviewer_id": "review", "session_id": self.uuid("review"), "verdict": "approved", "accepted_at": review["reviewers"][0]["accepted_at"]}])
            for name in ("review.interactive.json", "review.prompt.txt", "review.completion.json", "review.stop.json", "automatic-review.json"):
                self.assertTrue((f.directory / name).exists(), name)
            self.assertFalse(list(f.directory.glob("automatic-review-*.json")))
            self.assertEqual(read_json(f.directory / "review.json")["reviewer"], self.uuid("review"))

    def test_interrupted_reviewer_wait_keeps_the_reviewers_and_resumes_in_a_new_process(self):
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
real_wait = automatic.wait_reviews
def interrupted_once(runtime, state=None, **kwargs):
    if marker.exists():
        marker.unlink()
        raise KeyboardInterrupt
    return real_wait(runtime, state, **kwargs)
automatic.wait_reviews = interrupted_once
try:
    commit = automatic.drive(runtime, single_step=True)
except KeyboardInterrupt:
    sys.exit(130)
assert not [node for node in sessions.starts if not node.startswith('review')], 'Restart launched workers again'
sys.exit(0 if commit else 75)
'''
        codes = []
        for _ in range(5):
            result = subprocess.run([sys.executable, "-c", script, str(f.directory), str(marker)],
                                    cwd=Path(__file__).resolve().parents[1], capture_output=True, text=True, timeout=90)
            codes.append(result.returncode)
            self.assertIn(result.returncode, (0, 75, 130), result.stderr)
            if result.returncode == 130:
                # The interrupted controller left every reviewer running: status running, no stop, no error.
                receipt = self.combined()
                self.assertEqual((receipt["transport"], receipt["status"]), ("native", "running"))
                self.assertNotIn("error", receipt)
                for reviewer_id in self.ids:
                    self.assertEqual(self.status(reviewer_id)["status"], "running")
                    self.assertFalse(self.file(reviewer_id, "stop.json").exists())
                    self.assertTrue(f.runtime.sessions.locate(self.node(reviewer_id), f.runtime.sessions.inventory()))
                self.assertFalse((f.directory / "review.json").exists())
                self.assertTrue(any(event["node"] == "review" and event["status"] == "interrupted" and "NOT stopped" in event["message"] for event in self.events()))
            if result.returncode == 0:
                break
        self.assertEqual(codes, [75, 130, 75, 0])
        self.assertEqual(self.reviewer_launches(), len(self.ids))
        self.assertEqual(read_json(f.directory / "review.json")["verdict"], "approved")
        self.assertEqual(self.combined()["status"], "succeeded")
        for reviewer_id in self.ids:
            self.assertTrue(read_json(self.file(reviewer_id, "stop.json"))["stopped"])
        self.assertEqual(git(f.repo, "rev-parse", self.original_branch), f.plan["base_commit"])

    def assert_rejected(self, mutate, error):
        f = self.fixture
        f.sessions.reviewer_mutate = mutate
        with patch("workflow.automatic.wait_handoffs"), patch.object(f.runtime, "stop_reviewer", wraps=f.runtime.stop_reviewer) as stop:
            with self.assertRaisesRegex(RuntimeError, "Non-retryable"):
                drive(f.runtime)
            self.assertEqual([call.args[0] for call in stop.call_args_list], self.ids)  # Every reviewer is stopped, once.
        receipt = self.combined()
        self.assertEqual(receipt["status"], "blocked")
        self.assertIn(error, receipt["error"])
        for reviewer_id in self.ids:
            self.assertTrue(self.file(reviewer_id, "stop.json").exists())
        self.assertEqual(git(f.repo, "rev-parse", "HEAD"), f.plan["base_commit"])
        with patch("workflow.automatic.wait_handoffs"), self.assertRaisesRegex(RuntimeError, "Non-retryable"):
            drive(f.runtime)
        self.assertEqual(self.reviewer_launches(), len(self.ids))

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
        first = self.ids[0]  # The first accepted file already blocks; the combined record keeps the reviewer's raw approval.
        self.assertEqual((review["verdict"], review["findings"]), ("blocked", [{**finding, "reviewer": first}]))
        self.assertEqual(self.status(first)["decision"]["verdict"], "approved")
        self.assertEqual([entry["verdict"] for entry in review["reviewers"]], ["approved"] + [None] * (len(self.ids) - 1))

    # ---- Launch window and post-acceptance stop -----------------------------------------------------

    def assert_launch_window_interrupt_resumes(self, bound):
        """Ctrl-C after the last reviewer's `claude --bg` returned: every reviewer exists and keeps running; resume accepts their files."""
        f = self.fixture
        last = self.ids[-1]
        uuid, background = self.uuid(last), self.uuid(last)[:8]
        real_launch = f.runtime.launch_reviewer
        def launch_then_interrupt(reviewer_id, prompt, launch_token, candidate_commit):
            receipt = real_launch(reviewer_id, prompt, launch_token, candidate_commit)  # The launch command returned: the session exists.
            if reviewer_id != last:
                return receipt
            if not bound:
                # Ctrl-C inside the settle poll: the launcher journaled its intent but never bound the row.
                receipt = read_json(self.file(last, "interactive.json"))
                receipt.update(session_id=None, background_id=None, status="needs_reconciliation", error="")
                save_json(self.file(last, "interactive.json"), receipt)
            raise KeyboardInterrupt  # Ctrl-C in the settle poll or the pane attach.
        with patch("workflow.automatic.wait_handoffs"), patch.object(f.runtime, "launch_reviewer", side_effect=launch_then_interrupt), \
                patch.object(f.runtime, "stop_reviewer") as stop:
            with self.assertRaises(KeyboardInterrupt):
                drive(f.runtime)
        stop.assert_not_called()
        receipt = self.combined()
        self.assertEqual((receipt["transport"], receipt["status"]), ("native", "running"))
        self.assertNotIn("error", receipt)
        status = self.status(last)
        if bound:
            self.assertEqual((status["session_id"], status["background_id"]), (uuid, background))
        else:
            self.assertNotIn("session_id", status)
            self.assertNotIn("background_id", status)
        for reviewer_id in self.ids[:-1]:
            self.assertEqual((self.status(reviewer_id)["status"], self.status(reviewer_id)["session_id"]), ("running", self.uuid(reviewer_id)))
        for reviewer_id in self.ids:
            self.assertFalse(self.file(reviewer_id, "stop.json").exists())
        self.assertFalse((f.directory / "review.json").exists())
        self.assertTrue(any(event["node"] == "review" and event["status"] == "interrupted" and "NOT stopped" in event["message"]
                            and "resume with" in event["message"] for event in self.events()))
        self.assertEqual(self.reviewer_launches(), len(self.ids))
        # Resume: the same sessions' files are accepted; nothing is launched again.
        with patch("workflow.automatic.wait_handoffs"), patch.object(f.sessions, "run_reviewer", side_effect=AssertionError("relaunched")):
            commit = drive(f.runtime)
        self.assertEqual(git(f.repo, "rev-parse", "HEAD"), commit)
        self.assertEqual(self.reviewer_launches(), len(self.ids))
        self.assertEqual(self.combined()["status"], "succeeded")
        status = self.status(last)
        self.assertEqual((status["status"], status["session_id"], status["background_id"]), ("succeeded", uuid, background))
        interactive = read_json(self.file(last, "interactive.json"))
        self.assertEqual((interactive["status"], interactive["session_id"], interactive["background_id"]), ("attached_session_available", uuid, background))
        self.assertNotIn("error", interactive)
        self.assertEqual(read_json(f.directory / "review.json")["reviewer"], self.sessions_joined())
        for reviewer_id in self.ids:
            self.assertTrue(read_json(self.file(reviewer_id, "stop.json"))["stopped"])
        reconciled = [event for event in self.events() if event["node"] == "review" and "reconcil" in event["message"]]
        self.assertEqual(bool(reconciled), not bound)
        if reconciled:
            self.assertIn(uuid, reconciled[-1]["message"])
            self.assertTrue(all(last in event["message"] for event in reconciled))  # Only the unbound reviewer is rebound.

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
        receipt = self.combined()
        self.assertEqual((receipt["transport"], receipt["status"]), ("native", "needs_reconciliation"))
        for reviewer_id in self.ids:
            self.assertFalse(self.file(reviewer_id, "interactive.json").exists())
        self.assertEqual(self.status(self.ids[0])["status"], "needs_reconciliation")
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
        receipt = self.combined()
        self.assertEqual((receipt["transport"], receipt["status"], receipt["error"]), ("native", "needs_reconciliation", error))
        for reviewer_id in self.ids:
            self.assertNotIn("session_id", self.status(reviewer_id))
            self.assertFalse(self.file(reviewer_id, "interactive.json").exists())
            self.assertFalse(self.file(reviewer_id, "stop.json").exists())
        self.assertEqual(receipt["patch_sha256"], fixtures.digest_file(f.directory / "review.diff"))
        self.assertTrue(any(event["node"] == "review" and event["status"] == "blocked" and event["message"].endswith(error) for event in self.events()))
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
        first = self.ids[0]
        attempts = []
        def stop_failing_once(reviewer_id="review"):
            attempts.append(reviewer_id)
            if reviewer_id == first and attempts.count(first) == 1:
                raise RuntimeError(f"Stop failed for {self.node(first)}; inspect native session before retrying")
            real_stop(reviewer_id)
        with patch("workflow.automatic.wait_handoffs"), patch.object(f.runtime, "stop_reviewer", side_effect=stop_failing_once):
            with self.assertRaisesRegex(RuntimeError, "Reviewer stop not confirmed.*resume"):
                drive(f.runtime)
        self.assertEqual(attempts, self.ids)  # The failing stop does not skip the other reviewers' stops.
        receipt = self.combined()
        self.assertEqual((receipt["transport"], receipt["status"]), ("native", "succeeded"))
        self.assertNotIn("error", receipt)
        self.assertFalse(self.file(first, "stop.json").exists())
        for other in self.ids[1:]:
            self.assertTrue(read_json(self.file(other, "stop.json"))["stopped"])
        self.assertEqual(read_json(f.directory / "review.json")["verdict"], "approved")
        self.assertEqual(git(f.repo, "rev-parse", "HEAD"), f.plan["base_commit"])
        last = [event for event in self.events() if event["node"] == "review"][-1]
        self.assertEqual(last["status"], "running")
        self.assertIn("Could not confirm reviewer stop", last["message"])
        self.assertIn(f"Stop failed for {self.node(first)}", last["message"])
        self.assertIn("resume retries the stop", last["message"])
        # Resume: the accepted verdict is reused, only the unconfirmed stop is retried and confirmed, nothing is relaunched.
        with patch("workflow.automatic.wait_handoffs"), patch.object(f.runtime, "stop_reviewer", side_effect=stop_failing_once), \
                patch.object(f.sessions, "run_reviewer", side_effect=AssertionError("relaunched")):
            commit = drive(f.runtime)
        self.assertEqual(attempts, self.ids + [first])
        self.assertEqual(git(f.repo, "rev-parse", "HEAD"), commit)
        for reviewer_id in self.ids:
            self.assertTrue(read_json(self.file(reviewer_id, "stop.json"))["stopped"])
        self.assertEqual(self.combined()["status"], "succeeded")
        self.assertEqual(self.reviewer_launches(), len(self.ids))
        self.assertEqual([event["status"] for event in self.events() if event["node"] == "review"][-2:], ["stopped", "approved"])

    # ---- Re-checks between the accepted files and the verdict -------------------------------------

    def assert_refused_after_wait(self, error):
        """The files were accepted by the wait; the re-check refuses them: blocked, stopped once each, no verdict, no relaunch."""
        self.assert_rejected(None, error)
        self.assertFalse((self.fixture.directory / "review.json").exists())
        for reviewer_id in self.ids:
            self.assertNotIn("decision", self.status(reviewer_id))

    def test_reviewer_identity_changed_after_the_file_is_refused(self):
        self.fixture.sessions.reviewer_row_after_file = {"sessionId": "44444444-4444-4444-8444-444444444444"}
        self.assert_refused_after_wait("Reviewer identity changed or is not independent")

    def test_reviewer_that_is_a_worker_session_is_not_independent(self):
        f = self.fixture
        f.sessions.reviewer_session_id = {self.ids[-1]: f.plan["nodes"]["ui"]["session_id"]}  # The bundle snapshots carry the workers' UUIDs.
        self.assert_refused_after_wait("Reviewer identity changed or is not independent")

    def test_reviewer_worktree_change_is_refused(self):
        f = self.fixture
        f.sessions.reviewer_after_file = lambda: (f.directory / "review-worktree" / "ui.txt").write_text("edited during review")
        self.assert_refused_after_wait("Reviewer worktree changed")

    def test_evidence_change_during_review_is_refused(self):
        f = self.fixture
        f.sessions.reviewer_after_file = lambda: (f.directory / "review.diff").write_text("rewritten during review\n")
        self.assert_refused_after_wait("Evidence changed during review")

    def test_reviewer_deadline_without_a_file_stops_the_reviewers_and_launches_no_second(self):
        f = self.fixture
        f.sessions.reviewer_writes_file = False
        clock = SimpleNamespace(value=time.time())  # Each deadline counts from that reviewer's real launch time.
        def tick():
            clock.value += DEFAULTS["review_timeout_seconds"] / 2 + 1
            return clock.value
        with patch("workflow.automatic.wait_handoffs"), patch("workflow.automatic.time") as fake_time, \
                patch.object(f.runtime, "stop_reviewer", wraps=f.runtime.stop_reviewer) as stop:
            fake_time.time.side_effect = tick
            fake_time.sleep.return_value = None
            with self.assertRaisesRegex(RuntimeError, "Non-retryable"):
                drive(f.runtime)
            self.assertEqual([call.args[0] for call in stop.call_args_list], self.ids)
        receipt = self.combined()
        self.assertEqual(receipt["status"], "blocked")
        self.assertIn("deadline exhausted; no second reviewer", receipt["error"])
        self.assertFalse((f.directory / "review.json").exists())
        with patch("workflow.automatic.wait_handoffs"), self.assertRaisesRegex(RuntimeError, "Non-retryable"):
            drive(f.runtime)
        self.assertEqual(self.reviewer_launches(), len(self.ids))


class NativeReviewerGraphTests(NativeReviewerTests, GraphFixture):
    transport = "native"


class NativeTwoReviewerGraphTests(NativeReviewerTests, GraphFixture):
    transport = "native"
    reviewers = ["general", "coverage"]


class ParallelReviewerScenarios(GraphFixture):
    """docs/PRD_PARALLEL_REVIEWERS.md section 6: two declared reviewers over one bundle, native transport."""

    transport = "native"
    reviewers = ["general", "coverage"]
    GENERAL = [{"severity": "P2", "message": "Table lacks a disposition column", "disposition": "open", "worker": "ui", "requirement": "UI"}]
    COVERAGE = [{"severity": "P2", "message": "No test asserts the disposition column", "disposition": "open", "worker": "ui", "requirement": "UI"},
                {"severity": "P2", "message": "Table lacks a disposition column", "disposition": "open", "worker": "ui", "requirement": "UI"}]

    def review_entries(self):
        return [(entry["reviewer_id"], entry["verdict"], entry["session_id"]) for entry in read_json(self.fixture.directory / "review.json")["reviewers"]]

    def test_two_approve(self):
        f = self.fixture
        f.sessions.reviewer_findings = {"general": self.GENERAL, "coverage": self.COVERAGE}
        with patch("workflow.automatic.wait_handoffs"):
            commit = drive(f.runtime)
        self.assertEqual(git(f.repo, "rev-parse", "HEAD"), commit)
        review = read_json(f.directory / "review.json")
        self.assertEqual(review["verdict"], "approved")
        self.assertEqual(self.review_entries(), [("general", "approved", self.uuid("general")), ("coverage", "approved", self.uuid("coverage"))])
        # The union keeps the duplicate the two reviewers both reported, tagged by reviewer.
        self.assertEqual(review["findings"], [{**item, "reviewer": "general"} for item in self.GENERAL] + [{**item, "reviewer": "coverage"} for item in self.COVERAGE])
        self.assertEqual(self.reviewer_launches(), 2)
        self.assertNotEqual(self.uuid("general"), self.uuid("coverage"))
        for reviewer_id in self.ids:
            self.assertTrue(read_json(self.file(reviewer_id, "stop.json"))["stopped"])
        exported = read_json(f.directory / "run-state.json")
        self.assertEqual([(entry["reviewer_id"], entry["verdict"], entry["status"], len(entry["findings"])) for entry in exported["review"]["reviewers"]],
                         [("general", "approved", "accepted", 1), ("coverage", "approved", "accepted", 2)])
        self.assertEqual([finding["reviewer"] for finding in exported["review"]["findings"]], ["general", "coverage", "coverage"])

    def test_one_blocks_while_the_other_is_still_working(self):
        f = self.fixture
        f.sessions.reviewer_states = {"general": "working"}  # General never reaches idle: its file, if any, is never read.
        f.sessions.reviewer_verdicts = {"coverage": "blocked"}
        with patch("workflow.automatic.wait_handoffs"), patch.object(f.runtime, "stop_reviewer", wraps=f.runtime.stop_reviewer) as stop:
            with self.assertRaisesRegex(RuntimeError, "Non-retryable"):
                drive(f.runtime)
            self.assertEqual([call.args[0] for call in stop.call_args_list], ["general", "coverage"])
        self.assertEqual((self.combined()["status"], self.status("general")["status"], self.status("coverage")["status"]), ("blocked", "superseded", "blocked"))
        self.assertIn("blocked the candidate (coverage)", self.combined()["error"])
        self.assertNotIn("decision", self.status("general"))
        review = read_json(f.directory / "review.json")
        self.assertEqual(review["verdict"], "blocked")
        self.assertEqual(self.review_entries(), [("general", None, self.uuid("general")), ("coverage", "blocked", self.uuid("coverage"))])
        for reviewer_id in self.ids:
            self.assertTrue(read_json(self.file(reviewer_id, "stop.json"))["stopped"])
        self.assertEqual(git(f.repo, "rev-parse", "HEAD"), f.plan["base_commit"])
        with patch("workflow.automatic.wait_handoffs"), self.assertRaisesRegex(RuntimeError, "Non-retryable"):
            drive(f.runtime)
        self.assertEqual(self.reviewer_launches(), 2)
        exported = read_json(f.directory / "run-state.json")
        self.assertEqual([(entry["reviewer_id"], entry["verdict"], entry["status"]) for entry in exported["review"]["reviewers"]],
                         [("general", None, "superseded"), ("coverage", "blocked", "blocked")])

    def test_p1_anywhere(self):
        f = self.fixture
        open_p1 = {"severity": "P1", "message": "Unresolved defect", "disposition": "open", "worker": "adapter", "requirement": None}
        f.sessions.reviewer_findings = {"general": self.GENERAL, "coverage": [open_p1]}
        with patch("workflow.automatic.wait_handoffs"), self.assertRaisesRegex(RuntimeError, "Non-retryable"):
            drive(f.runtime)
        review = read_json(f.directory / "review.json")
        self.assertEqual(review["verdict"], "blocked")
        self.assertEqual(self.review_entries(), [("general", "approved", self.uuid("general")), ("coverage", "approved", self.uuid("coverage"))])
        self.assertEqual(review["findings"], [{**self.GENERAL[0], "reviewer": "general"}, {**open_p1, "reviewer": "coverage"}])
        self.assertEqual((self.status("general")["status"], self.status("coverage")["status"]), ("accepted", "blocked"))
        self.assertEqual(self.status("coverage")["decision"]["verdict"], "approved")  # B's raw decision is kept.
        self.assertIn("blocked the candidate (coverage)", self.combined()["error"])
        self.assertEqual(git(f.repo, "rev-parse", "HEAD"), f.plan["base_commit"])
        self.assertEqual(self.reviewer_launches(), 2)

    def test_one_times_out(self):
        f = self.fixture
        f.sessions.reviewer_writes_file = {"general"}
        f.sessions.reviewer_findings = {"general": self.GENERAL}
        clock = SimpleNamespace(value=time.time())
        def tick():
            clock.value += DEFAULTS["review_timeout_seconds"] / 4 + 1
            return clock.value
        with patch("workflow.automatic.wait_handoffs"), patch("workflow.automatic.time") as fake_time, \
                patch.object(f.runtime, "stop_reviewer", wraps=f.runtime.stop_reviewer) as stop:
            fake_time.time.side_effect = tick
            fake_time.sleep.return_value = None
            with self.assertRaisesRegex(RuntimeError, "Non-retryable"):
                drive(f.runtime)
            self.assertEqual([call.args[0] for call in stop.call_args_list], ["general", "coverage"])
        self.assertIn("Reviewer coverage deadline exhausted; no second reviewer", self.combined()["error"])
        self.assertEqual((self.status("general")["status"], self.status("coverage")["status"]), ("accepted", "blocked"))
        self.assertEqual(self.status("general")["decision"]["verdict"], "approved")  # A's accepted verdict is retained.
        review = read_json(f.directory / "review.json")
        self.assertEqual(review["verdict"], "blocked")
        self.assertEqual(self.review_entries(), [("general", "approved", self.uuid("general")), ("coverage", None, self.uuid("coverage"))])
        self.assertEqual(review["findings"], [{**self.GENERAL[0], "reviewer": "general"}])
        self.assertEqual(self.reviewer_launches(), 2)
        with patch("workflow.automatic.wait_handoffs"), self.assertRaisesRegex(RuntimeError, "Non-retryable"):
            drive(f.runtime)
        self.assertEqual(self.reviewer_launches(), 2)

    def test_wrong_node(self):
        f = self.fixture
        f.sessions.reviewer_mutate = {"coverage": lambda item: {**item, "node_id": "review-general"}}
        with patch("workflow.automatic.wait_handoffs"), self.assertRaisesRegex(RuntimeError, "Non-retryable"):
            drive(f.runtime)
        self.assertIn("Stale or foreign review completion signal (coverage)", self.combined()["error"])
        self.assertEqual((self.status("general")["status"], self.status("coverage")["status"]), ("accepted", "blocked"))
        self.assertEqual(read_json(f.directory / "review-coverage.completion.json")["node_id"], "review-general")
        self.assertEqual(self.review_entries(), [("general", "approved", self.uuid("general")), ("coverage", None, self.uuid("coverage"))])
        for reviewer_id in self.ids:
            self.assertTrue(read_json(self.file(reviewer_id, "stop.json"))["stopped"])
        self.assertEqual(git(f.repo, "rev-parse", "HEAD"), f.plan["base_commit"])
        self.assertEqual(self.reviewer_launches(), 2)

    def test_shared_identity(self):
        f = self.fixture
        f.sessions.reviewer_session_id = {"coverage": f.sessions.native_id("review-general")}  # Two receipts, one session UUID.
        with patch("workflow.automatic.wait_handoffs"), self.assertRaisesRegex(RuntimeError, "Non-retryable"):
            drive(f.runtime)
        self.assertIn("Reviewer identity changed or is not independent (coverage)", self.combined()["error"])
        self.assertEqual(read_json(f.directory / "review-general.interactive.json")["session_id"], read_json(f.directory / "review-coverage.interactive.json")["session_id"])
        self.assertFalse((f.directory / "review.json").exists())
        self.assertEqual(git(f.repo, "rev-parse", "HEAD"), f.plan["base_commit"])
        self.assertEqual(self.reviewer_launches(), 2)

    def test_interrupted_launch(self):
        f = self.fixture
        real_launch = f.runtime.launch_reviewer
        def interrupt_before_second(reviewer_id, prompt, launch_token, candidate_commit):
            if reviewer_id == "coverage":
                raise KeyboardInterrupt  # Ctrl-C after general's `claude --bg`, before coverage's was issued.
            return real_launch(reviewer_id, prompt, launch_token, candidate_commit)
        with patch("workflow.automatic.wait_handoffs"), patch.object(f.runtime, "launch_reviewer", side_effect=interrupt_before_second), \
                patch.object(f.runtime, "stop_reviewer") as stop:
            with self.assertRaises(KeyboardInterrupt):
                drive(f.runtime)
        stop.assert_not_called()
        self.assertEqual((self.combined()["status"], self.status("general")["status"], self.status("coverage")["status"]), ("needs_reconciliation", "running", "needs_reconciliation"))
        self.assertTrue((f.directory / "review-general.interactive.json").exists())
        self.assertFalse((f.directory / "review-coverage.interactive.json").exists())
        self.assertTrue(any(event["status"] == "interrupted" and "general" in event["message"] and "NOT stopped" in event["message"] for event in self.events()))
        self.assertEqual(self.reviewer_launches(), 1)
        # Resume: the first reviewer's receipt is reconciled, nothing is launched, the run needs reconciliation.
        with patch("workflow.automatic.wait_handoffs"), patch.object(f.sessions, "run_reviewer", side_effect=AssertionError("relaunched")):
            with self.assertRaisesRegex(RuntimeError, "Reviewer coverage needs reconciliation; no automatic relaunch"):
                review_candidate(f.runtime)
        self.assertTrue(any("Reconciling the interrupted launch of reviewer general" in event["message"] for event in self.events()))
        self.assertEqual((self.status("general")["status"], self.status("general")["session_id"]), ("running", self.uuid("general")))
        self.assertEqual(self.status("coverage")["status"], "needs_reconciliation")
        self.assertEqual(self.combined()["status"], "needs_reconciliation")
        self.assertEqual(self.reviewer_launches(), 1)
        self.assertFalse((f.directory / "review.json").exists())


if __name__ == "__main__":
    unittest.main()
