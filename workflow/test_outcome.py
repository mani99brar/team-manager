"""The outcome block (C43): built from the run record, printed by status, the success lines and the Blocked handlers, and at
the top of report.html. Run directories here are written by hand in the shapes the controller writes; no agent runs."""
import contextlib
import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from .outcome import outcome_block
from .sessions import save_json
from .test_pipeline import isolate_registry, pipeline_cli

REVIEWERS = ["general", "coverage"]


def setUpModule():
    isolate_registry()


def finding(severity: str, message: str, disposition: str = "open", reviewer: str = "general") -> dict:
    return {"severity": severity, "message": message, "disposition": disposition, "worker": "ui", "requirement": None, "reviewer": reviewer}


class OutcomeRun(unittest.TestCase):
    """A run with one lane (ui) and two reviewers, written as the automatic controller leaves it."""

    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.directory = Path(temp.name) / "run"
        self.directory.mkdir()
        self.plan = {"run_id": "run", "repository": str(Path(temp.name) / "repo"), "base_commit": "0" * 40, "allow_edits": True,
                     "workers": ["ui"], "excluded_workers": [], "completion_version": "1.1.0",
                     "nodes": {"ui": {"worktree": str(self.directory / "worktree-ui"), "task": "Change ui.", "session_id": "ui-token",
                                      "observed_start_commit": "0" * 40}},
                     "reviewers": [{"reviewer_id": reviewer, "prompt": f"{reviewer} brief"} for reviewer in REVIEWERS]}
        save_json(self.directory / "plan.json", self.plan)

    def lane(self, untested=(), verify_yourself="Open the page and see the new heading.") -> None:
        save_json(self.directory / "ui.completion.json", {
            "version": "1.1.0", "run_id": "run", "node_id": "ui", "launch_token": "ui-token", "status": "completed", "summary": "Changed ui.",
            "open_assumptions": [], "untested": list(untested), "falsifying_check": "The ui check fails on the old text.",
            "verify_yourself": verify_yourself, "question": None})

    def review(self, verdict: str, entries: list, findings: list = ()) -> None:
        """review.json as combined_review writes it; `entries` are (reviewer, derived verdict or None)."""
        save_json(self.directory / "review.json", {
            "run_id": "run", "bundle_sha256": "1" * 64, "candidate_commit": "2" * 40, "reviewer": "s-general, s-coverage", "independent": True,
            "verdict": verdict, "findings": list(findings),
            "reviewers": [{"reviewer_id": reviewer, "session_id": f"s-{reviewer}", "verdict": derived,
                           "accepted_at": "2026-10-01T23:10:53Z" if derived else None} for reviewer, derived in entries]})
        save_json(self.directory / "automatic-review.json", {"transport": "native", "status": "blocked" if verdict == "blocked" else "succeeded",
                                                             "reviewers": REVIEWERS, "accepted_at": "2026-10-01T23:13:00Z"})

    def status(self, reviewer: str, **status) -> None:
        save_json(self.directory / f"automatic-review-{reviewer}.json", {"reviewer_id": reviewer, "node_id": f"review-{reviewer}", **status})

    def decision(self, verdict: str, findings: list = ()) -> dict:
        return {"verdict": verdict, "findings": [{key: value for key, value in item.items() if key != "reviewer"} for item in findings]}

    def completion(self, reviewer: str, verdict: str) -> None:
        save_json(self.directory / f"review-{reviewer}.completion.json", {"version": "1.2.0", "run_id": "run", "node_id": f"review-{reviewer}",
                                                                        "verdict": verdict, "findings": []})


class OutcomeBlock(OutcomeRun):
    def test_a_clean_approval_is_one_line(self):
        self.review("approved", [("general", "approved"), ("coverage", "approved")])
        for reviewer in REVIEWERS:
            self.status(reviewer, status="succeeded", accepted_decision=self.decision("approved"), derived=True)
        block = outcome_block(self.directory)
        self.assertEqual(block, "Outcome: approved by general and coverage; no open P0/P1.")

    def test_a_clean_approval_counts_the_open_p2_it_leaves_and_never_says_nothing_open(self):
        # Most approved runs keep open P2s in review.json: the one line says what is not open, and how many P2s are.
        p2s = [finding("P2", "The empty state could say more."), finding("P2", "A test name is vague.", reviewer="coverage"),
               finding("P2", "Fixed already.", "resolved")]
        self.review("approved", [("general", "approved"), ("coverage", "approved")], p2s)
        for reviewer in REVIEWERS:
            self.status(reviewer, status="succeeded", accepted_decision=self.decision("approved"), derived=True)
        self.assertEqual(outcome_block(self.directory), "Outcome: approved by general and coverage; no open P0/P1 (2 open P2 in review.json).")

    def test_a_blocked_run_with_a_missing_verdict_prints_the_reason_and_that_no_file_was_written(self):
        self.review("blocked", [("general", None), ("coverage", "approved")])
        self.status("general", status="blocked", error="Reviewer general deadline exhausted; no second reviewer is launched")
        self.status("coverage", status="accepted", accepted_decision=self.decision("approved"), derived=True)
        lines = outcome_block(self.directory).splitlines()
        self.assertEqual(lines[0], "Outcome: blocked")
        self.assertIn("  general: no verdict accepted (deadline exhausted); no file written", lines)
        self.assertIn("  coverage: approved", lines)

    def test_a_file_written_and_never_accepted_prints_both_facts(self):
        # viewer-revamp-005: both reviewers wrote approved; the general reviewer's file was never accepted.
        self.review("blocked", [("general", None), ("coverage", "approved")])
        self.status("general", status="blocked", error="Reviewer general deadline exhausted; no second reviewer is launched")
        self.status("coverage", status="accepted", accepted_decision=self.decision("approved"), derived=True)
        self.completion("general", "approved")
        self.assertIn("  general: no verdict accepted (deadline exhausted); its file says approved", outcome_block(self.directory).splitlines())

    def test_the_block_lists_raw_and_late_verdicts_open_p0_p1_known_limits_lane_items_and_the_sidecar(self):
        p1 = finding("P1", "The empty state never renders. It returns before the list is read.", reviewer="coverage")
        limit = finding("P2", "A 2-tile dead spot remains at the dock corner.", "accepted")
        self.review("blocked", [("general", "approved"), ("coverage", "blocked")], [limit, p1])
        self.status("general", status="accepted", accepted_decision=self.decision("blocked", [limit]), derived=True)
        self.status("coverage", status="blocked", accepted_decision=self.decision("blocked", [p1]), derived=True, late=True)
        self.lane(untested=["Safari layout"])
        lines = outcome_block(self.directory).splitlines()
        self.assertIn("  general: approved (its file says blocked)", lines)
        self.assertIn("  coverage: blocked, late", lines)
        self.assertIn("Open P0/P1:", lines)
        self.assertIn("  [P1 coverage] The empty state never renders.", lines)
        self.assertIn("Known limits (accepted P2):", lines)
        self.assertIn("  [general] A 2-tile dead spot remains at the dock corner.", lines)
        self.assertIn("Lane ui:", lines)
        self.assertIn("  untested: Safari layout", lines)
        self.assertIn("  verify yourself: Open the page and see the new heading.", lines)
        # The open items alone, for the approval stop (unit T4): no outcome line, no reviewer verdicts.
        items = outcome_block(self.directory, open_items_only=True).splitlines()
        self.assertEqual(items[0], "Open P0/P1:")
        self.assertNotIn("  general: approved (its file says blocked)", items)
        self.assertIn("  verify yourself: Open the page and see the new heading.", items)

    def test_a_clean_approval_of_a_completed_1_1_0_lane_is_one_line(self):
        # Every completed 1.1.0 lane carries a verify_yourself line: on its own it does not make an approval unclean.
        self.review("approved", [("general", "approved"), ("coverage", "approved")])
        for reviewer in REVIEWERS:
            self.status(reviewer, status="succeeded", accepted_decision=self.decision("approved"), derived=True)
        self.lane()
        self.assertEqual(outcome_block(self.directory), "Outcome: approved by general and coverage; no open P0/P1.")
        # The approval stop (unit T4) still lists it among the open items.
        self.assertEqual(outcome_block(self.directory, open_items_only=True).splitlines(),
                         ["Lane ui:", "  verify yourself: Open the page and see the new heading."])

    def test_the_approval_stop_lists_the_open_p2s_below_the_block_threshold(self):
        # C51: the stop lists the findings below the block threshold too; the outcome line still only counts them.
        nit = finding("P2", "The label wraps at 320 px. It reads fine otherwise.", reviewer="general")
        self.review("approved", [("general", "approved"), ("coverage", "approved")], [nit])
        for reviewer in REVIEWERS:
            self.status(reviewer, status="succeeded", accepted_decision=self.decision("approved", [nit] if reviewer == "general" else []), derived=True)
        self.assertEqual(outcome_block(self.directory), "Outcome: approved by general and coverage; no open P0/P1 (1 open P2 in review.json).")
        self.assertEqual(outcome_block(self.directory, open_items_only=True).splitlines(),
                         ["Open P2 (below the block threshold):", "  [P2 general] The label wraps at 320 px."])

    def test_an_approval_with_lane_items_is_no_longer_one_line_and_a_run_without_a_record_has_no_block(self):
        self.assertEqual(outcome_block(self.directory), "")
        self.assertEqual(outcome_block(self.directory.parent / "missing"), "")
        self.review("approved", [("general", "approved"), ("coverage", "approved")])
        self.lane(untested=["Safari layout"])
        lines = outcome_block(self.directory).splitlines()
        self.assertEqual(lines[0], "Outcome: approved by general and coverage")
        self.assertIn("  untested: Safari layout", lines)
        self.assertIn("  verify yourself: Open the page and see the new heading.", lines)  # Listed once the block is more than one line.

    def test_without_review_json_the_reviewers_come_from_their_status_files(self):
        # A single reviewer ran out its deadline, or none gave a verdict: _record_partial writes no review.json.
        self.plan["reviewers"].append({"reviewer_id": "security", "prompt": "security brief"})
        save_json(self.directory / "plan.json", self.plan)
        save_json(self.directory / "automatic-review.json", {"transport": "native", "status": "blocked", "reviewers": [*REVIEWERS, "security"]})
        self.status("general", status="accepted", accepted_decision=self.decision("blocked", [finding("P1", "The key is lost. Twice.")]), derived=True)
        self.status("coverage", status="blocked", error="Reviewer coverage deadline exhausted; no second reviewer is launched")
        self.status("security", status="superseded")
        with (self.directory / "events.jsonl").open("w") as events:
            events.write(json.dumps({"sequence": 1, "time": "2026-10-01T23:13:00Z", "node": "review", "status": "note",
                                     "message": "Reviewer security gave no verdict and ends superseded: general blocked the candidate"}) + "\n")
        lines = outcome_block(self.directory).splitlines()
        self.assertEqual(lines[:2], ["Outcome: no review.json recorded", "Reviewers:"])
        self.assertIn("  general: blocked", lines)
        self.assertIn("  coverage: no verdict accepted (deadline exhausted); no file written", lines)
        self.assertIn("  security: no verdict accepted (superseded: general blocked the candidate); no file written", lines)
        self.assertIn("  [P1 general] The key is lost.", lines)

    def test_a_running_reviewer_says_still_running(self):
        save_json(self.directory / "automatic-review.json", {"transport": "native", "status": "running", "reviewers": REVIEWERS})
        self.status("general", status="running")
        self.status("coverage", status="launching")
        lines = outcome_block(self.directory).splitlines()
        self.assertIn("  general: no verdict accepted (still running); no file written", lines)
        self.assertIn("  coverage: no verdict accepted (still running); no file written", lines)

    def test_a_print_reviewer_reports_its_job_output_never_a_file(self):
        # Print-transport reviewers write no completion file: the fact is their job's stdout.
        save_json(self.directory / "automatic-review.json", {"transport": "print", "status": "blocked", "reviewers": REVIEWERS})
        self.status("general", transport="print", status="superseded", late_error="Reviewer general stdout refused: no structured output")
        self.status("coverage", transport="print", status="blocked", error="Reviewer coverage deadline exhausted")
        (self.directory / "review-general.stdout.json").write_text('{"is_error": true}')
        lines = outcome_block(self.directory).splitlines()
        self.assertIn("  general: no verdict accepted (Reviewer general stdout refused: no structured output); "
                      "its print job's output was not accepted", lines)
        self.assertIn("  coverage: no verdict accepted (deadline exhausted); its print job wrote no output", lines)

    def test_a_superseded_print_reviewer_says_what_its_job_output_holds(self):
        # claims-005 and the like: the job exited with a valid structured verdict after the reviewer was superseded. The block
        # says what that output says, with its open P0/P1, not only that it was not accepted.
        save_json(self.directory / "automatic-review.json", {"transport": "print", "status": "blocked", "reviewers": REVIEWERS})
        self.status("general", transport="print", status="superseded")
        self.status("coverage", transport="print", status="superseded")
        save_json(self.directory / "review-general.stdout.json", {"type": "result", "is_error": False, "structured_output": {
            "verdict": "blocked", "findings": [finding("P1", "Tokens leak into the log."), finding("P2", "Naming.")]}})
        save_json(self.directory / "review-coverage.stdout.json", {"type": "result", "is_error": False, "structured_output": {
            "verdict": "approved", "findings": []}})
        lines = outcome_block(self.directory).splitlines()
        self.assertIn("  general: no verdict accepted (superseded); its print job's output says blocked (1 open P1)", lines)
        self.assertIn("  coverage: no verdict accepted (superseded); its print job's output says approved (no open P0/P1)", lines)
        # An error result, or output without a verdict, is still only "not accepted".
        save_json(self.directory / "review-general.stdout.json", {"type": "result", "is_error": True, "structured_output": {"verdict": "blocked"}})
        save_json(self.directory / "review-coverage.stdout.json", {"type": "result", "is_error": False, "result": "no structured output"})
        lines = outcome_block(self.directory).splitlines()
        self.assertIn("  general: no verdict accepted (superseded); its print job's output was not accepted", lines)
        self.assertIn("  coverage: no verdict accepted (superseded); its print job's output was not accepted", lines)

    def test_an_unreadable_plan_never_raises(self):
        self.review("approved", [("general", "approved"), ("coverage", "approved")])
        with patch("workflow.outcome.load_optional", side_effect=PermissionError(13, "Permission denied")):
            self.assertEqual(outcome_block(self.directory), "Outcome: unavailable (PermissionError: [Errno 13] Permission denied)")

    def test_the_sidecar_unresolved_list_is_listed(self):
        from .sidecar import initial_ledger
        self.plan["sidecar"] = {"prompt": "Watch the lanes.", "cadence_seconds": 600, "pass_timeout_seconds": 600, "max_passes": 6, "max_messages_per_lane": 3}
        save_json(self.directory / "plan.json", self.plan)
        ledger = initial_ledger(self.plan)
        ledger["handoff"] = {"unresolved": ["The ui lane still reads the old key."], "structural": [], "verified_resolved": [], "withdrawn": [], "gaps": []}
        save_json(self.directory / "sidecar.ledger.json", ledger)
        self.review("approved", [("general", "approved"), ("coverage", "approved")])
        lines = outcome_block(self.directory).splitlines()
        self.assertIn("Sidecar unresolved:", lines)
        self.assertIn("  The ui lane still reads the old key.", lines)


class OutcomePrinted(OutcomeRun):
    def blocked_run(self) -> None:
        self.review("blocked", [("general", None), ("coverage", "approved")])
        self.status("general", status="blocked", error="Reviewer general deadline exhausted; no second reviewer is launched")
        self.status("coverage", status="accepted", accepted_decision=self.decision("approved"), derived=True)
        self.completion("general", "approved")

    def test_status_prints_the_block(self):
        self.blocked_run()
        code, out, err = pipeline_cli("status", str(self.directory))
        self.assertEqual(code, 0, err)
        self.assertIn("\nOutcome: blocked\n", out)
        self.assertIn("general: no verdict accepted (deadline exhausted); its file says approved", out)

    def test_the_automatic_blocked_handler_prints_the_block(self):
        self.blocked_run()
        with patch("workflow.automatic.supervise", side_effect=RuntimeError("Automatic controller blocked (exit 1); inspect retained run")):
            code, out, err = pipeline_cli("automatic", str(self.directory), "--live")
        self.assertEqual(code, 1)
        self.assertTrue(err.startswith("Blocked: Automatic controller blocked (exit 1)"), err)
        self.assertIn("Outcome: blocked\n", err)
        self.assertIn("general: no verdict accepted (deadline exhausted); its file says approved", err)

    def test_the_resume_blocked_handler_prints_the_block(self):
        from .guardrails import resume_main
        self.blocked_run()
        output = io.StringIO()
        with patch("workflow.guardrails.resume_challenge", side_effect=RuntimeError("Automatic controller blocked (exit 1)")), \
                patch("workflow.pipeline.Pipeline"), contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
            with self.assertRaises(SystemExit) as raised:
                resume_main([str(self.directory), "--by", "operator"])
        self.assertEqual(raised.exception.code, 1)
        self.assertIn("Outcome: blocked\n", output.getvalue())

    def test_automatic_prints_the_block_once_after_its_evidence_line_and_automatic_step_leaves_it_to_its_caller(self):
        self.blocked_run()
        with patch("workflow.automatic.supervise"):
            code, out, err = pipeline_cli("automatic", str(self.directory), "--live")
        self.assertEqual(code, 0, err)
        lines = out.splitlines()
        self.assertTrue(lines[0].startswith("Automatic run reached a verified feature branch. Evidence: "), out)
        self.assertEqual(lines[1], "Outcome: blocked")
        self.assertEqual(out.count("Outcome:"), 1)
        # The step's child shares the supervisor's terminal: the block comes once, from `automatic`, `resume` or `launch`.
        with patch("workflow.automatic.drive", return_value="3" * 40), patch("workflow.pipeline.Pipeline"):
            code, out, err = pipeline_cli("automatic-step", str(self.directory), "--live")
        self.assertEqual(code, 0, err)
        self.assertIn("Verified feature branch: ", out)
        self.assertNotIn("Outcome:", out)

    def test_resume_prints_the_block_once_after_its_success_line(self):
        from .guardrails import resume_main
        self.blocked_run()
        output = io.StringIO()
        with patch("workflow.guardrails.resume_challenge", return_value={"status": "passed", "attempt": 1}), \
                patch("workflow.pipeline.Pipeline"), patch("workflow.pipeline.start_workers"), patch("workflow.automatic.supervise"), \
                contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
            resume_main([str(self.directory), "--by", "operator"])
        lines = output.getvalue().splitlines()
        index = next(i for i, line in enumerate(lines) if line.startswith("Automatic run reached a verified feature branch. Evidence: "))
        self.assertEqual(lines[index + 1], "Outcome: blocked")
        self.assertEqual(output.getvalue().count("Outcome:"), 1)


if __name__ == "__main__":
    unittest.main()
