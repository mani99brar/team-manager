"""The outcome block (C43): built from the run record, printed by status, the success lines and the Blocked handlers, and at
the top of report.html. Run directories here are written by hand in the shapes the controller writes; no agent runs."""
import contextlib
import io
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
        self.assertEqual(block, "Outcome: approved by general and coverage; nothing open.")

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

    def test_an_approval_with_lane_items_is_no_longer_one_line_and_a_run_without_a_record_has_no_block(self):
        self.assertEqual(outcome_block(self.directory), "")
        self.assertEqual(outcome_block(self.directory.parent / "missing"), "")
        self.review("approved", [("general", "approved"), ("coverage", "approved")])
        self.lane()
        lines = outcome_block(self.directory).splitlines()
        self.assertEqual(lines[0], "Outcome: approved by general and coverage")
        self.assertIn("  verify yourself: Open the page and see the new heading.", lines)

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
                resume_main([str(self.directory)])
        self.assertEqual(raised.exception.code, 1)
        self.assertIn("Outcome: blocked\n", output.getvalue())


if __name__ == "__main__":
    unittest.main()
