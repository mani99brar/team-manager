"""Export version 1.2.0: review/inputs sections from a run directory, stability, and the export CLI."""
import contextlib
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from .export_state import EXPORT_VERSION, export_state, inputs_section, review_section
from .pipeline import ExportRuntime, digest_file, export_run
from .sessions import read_json, save_json
from .verification import policy_digest

REPO = Path(__file__).resolve().parents[1]
# Copies of the finished features' files; the feature directories themselves are gone.
TESTDATA = Path(__file__).resolve().parent / "testdata"
REVIEWER = "dd7bdcd1-adec-4efe-bcd4-bbadc3525d95"


def legacy_run(root: Path, *, with_policy: bool = True, automatic: bool = True) -> Path:
    """A finished run directory shaped like the first live 1.0.0 run, whose worktrees no longer exist."""
    directory = root / "legacy-001"
    directory.mkdir()
    # The committed policy is 1.2.0 now; the first live run pinned its 1.1.0 predecessor (roles, no required kinds).
    policy = read_json(TESTDATA / "project-workflows/policy.json")
    policy["version"] = "1.1.0"
    for worker in policy["workers"]:
        worker.pop("required_check_kinds", None)
    plan = {"run_id": "legacy-001", "repository": str(root / "gone-repo"), "base_commit": "c" * 40, "allow_edits": True,
            "nodes": {node: {"worktree": str(directory / f"worktree-{node}"), "task": f"# {node} task\n\nDo the {node} work.\n\nApproved ownership and checks:\n{{}}",
                             "session_id": f"{node[0] * 8}-0000-4000-8000-000000000000", "observed_start_commit": "c" * 40} for node in ("ui", "adapter")},
            "mode": "interactive", "policy_sha256": policy_digest(policy), "created_at": "2026-09-21T14:33:23.528543Z",
            "source_branch": "feature/project-workflows/legacy-001"}
    if automatic:
        # Pinned before reviewer_transport existed: four keys only.
        plan["automatic"] = {"finish": "verified-feature-branch", "permission_mode": "bypassPermissions",
                             "worker_timeout_seconds": 3600, "review_timeout_seconds": 1800}
    save_json(directory / "plan.json", plan)
    if with_policy:
        save_json(directory / "policy.json", policy)
    for node in ("ui", "adapter"):
        save_json(directory / f"{node}.interactive.json", {
            "node_id": node, "session_id": f"{node[0] * 8}-1111-4111-8111-111111111111", "launch_token": plan["nodes"][node]["session_id"],
            "plan_digest": "x" * 64, "worktree": plan["nodes"][node]["worktree"], "base_commit": "c" * 40, "status": "attached_session_available",
            "attempt": 1, "launcher_invocations": 1, "launch_requested_at": "2026-09-21T14:33:25.331982+00:00",
            "background_id": node[0] * 8, "observed_state": "working", "native_started_at": 1790001207771})
        save_json(directory / f"{node}.completion.json", {"version": "1.0.0", "run_id": "legacy-001", "node_id": node,
                                                          "launch_token": plan["nodes"][node]["session_id"], "status": "completed",
                                                          "summary": f"{node} implemented", "open_assumptions": ["assumed"]})
        save_json(directory / f"{node}.handoff.json", {"summary": f"{node} implemented", "open_assumptions": ["assumed"]})
        save_json(directory / f"{node}.stop.json", {"background_id": node[0] * 8, "session_id": f"{node[0] * 8}-1111-4111-8111-111111111111", "pid": 1, "stopped": True})
    bundle = {"run_id": "legacy-001", "base_commit": "c" * 40, "candidate_commit": "d" * 40, "policy_sha256": policy_digest(policy),
              "snapshots": {node: {"commit": "d" * 40, "changed_files": [], "session_id": f"{node[0] * 8}-1111-4111-8111-111111111111"} for node in ("ui", "adapter")},
              "packets": []}
    save_json(directory / "review-bundle.json", bundle)
    review = {"run_id": "legacy-001", "bundle_sha256": digest_file(directory / "review-bundle.json"), "candidate_commit": "d" * 40,
              "reviewer": REVIEWER, "independent": True, "verdict": "approved",
              "findings": [{"severity": "P2", "message": "Stale task error overrides verified success", "disposition": "open"},
                           {"severity": "P2", "message": "Root Playwright suite is not in the policy", "disposition": "accepted"}]}
    save_json(directory / "review.json", review)
    save_json(directory / "automatic-review.json", {"session_id": REVIEWER, "bundle_sha256": review["bundle_sha256"], "candidate_commit": "d" * 40,
                                                    "status": "succeeded", "patch_sha256": "0" * 64, "pid": 1, "review": review})
    (directory / "review.diff").write_text("diff --git a/ui.txt b/ui.txt\n--- a/ui.txt\n+++ b/ui.txt\n@@ -1 +1 @@\n-before\n+after\n")
    events = [{"sequence": 1, "time": "2026-09-21T14:33:25.000000Z", "node": "ui", "status": "running", "message": "Launching"},
              {"sequence": 2, "time": "2026-09-21T15:42:27.848828Z", "node": "review", "status": "approved", "message": REVIEWER},
              {"sequence": 3, "time": "2026-09-21T15:52:04.611348Z", "node": "controller", "status": "running", "message": "PID 1"}]
    (directory / "events.jsonl").write_text("".join(json.dumps(event) + "\n" for event in events))
    old = {"version": "1.0.0", "run_id": "legacy-001", "base_commit": "c" * 40, "created_at": plan["created_at"],
           "definition": {"name": "Feature implementation", "nodes": []}, "values": {"run_id": "legacy-001", "review": review},
           "next": [], "tasks": [], "events": events, "verification_packets": [], "updated_at": "2026-09-21T15:52:04.675731Z"}
    save_json(directory / "run-state.json", old)
    return directory


class ExportSectionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def test_review_section_derives_transport_time_and_diff_from_files(self):
        directory = legacy_run(self.root)
        section = review_section(directory)
        self.assertEqual((section["attempt"], section["transport"], section["reviewer_session_id"], section["independent"]), (1, "print", REVIEWER, True))
        self.assertEqual((section["verdict"], section["candidate_commit"]), ("approved", "d" * 40))
        self.assertEqual(section["reviewed_at"], "2026-09-21T15:42:27.848828Z")  # Last review event; the old receipt has no accepted_at.
        self.assertEqual(section["diff"], {"path": "review.diff", "sha256": digest_file(directory / "review.diff"), "bytes": (directory / "review.diff").stat().st_size})
        self.assertEqual([(finding["worker"], finding["requirement"]) for finding in section["findings"]], [(None, None), (None, None)])
        self.assertEqual(section["findings"][0]["message"], "Stale task error overrides verified success")
        # A record before parallel reviewers is the single reviewer `review`: one entry, every finding tagged with it.
        self.assertEqual([finding["reviewer"] for finding in section["findings"]], ["review", "review"])
        self.assertEqual([(entry["reviewer_id"], entry["transport"], entry["session_id"], entry["verdict"], entry["status"], entry["launched_at"], entry["accepted_at"], len(entry["findings"]))
                          for entry in section["reviewers"]], [("review", "print", REVIEWER, "approved", "accepted", None, section["reviewed_at"], 2)])
        # Native receipts win over print receipts; accepted_at wins over events; no diff → null.
        save_json(directory / "review.interactive.json", {"node_id": "review"})
        receipt = read_json(directory / "automatic-review.json")
        receipt["accepted_at"] = "2026-09-21T16:00:00.000000Z"
        save_json(directory / "automatic-review.json", receipt)
        (directory / "review.diff").unlink()
        section = review_section(directory)
        self.assertEqual((section["transport"], section["reviewed_at"], section["diff"]), ("native", "2026-09-21T16:00:00.000000Z", None))
        # Manual reviews: no receipts at all, time from the review file itself when no event exists.
        (directory / "review.interactive.json").unlink()
        (directory / "automatic-review.json").unlink()
        (directory / "events.jsonl").unlink()
        section = review_section(directory)
        expected = datetime.fromtimestamp((directory / "review.json").stat().st_mtime, timezone.utc).isoformat().replace("+00:00", "Z")
        self.assertEqual((section["transport"], section["reviewed_at"]), ("manual", expected))
        (directory / "review.json").unlink()
        self.assertIsNone(review_section(directory))

    def test_inputs_section_pins_plan_policy_and_receipts(self):
        directory = legacy_run(self.root)
        plan, policy = read_json(directory / "plan.json"), read_json(directory / "policy.json")
        (directory / "ui.prompt.txt").write_text("You are a workflow worker.\n\n# ui task")
        section = inputs_section(directory, plan, policy)
        self.assertEqual((section["feature"], section["policy_version"], section["base_commit"], section["source_branch"], section["mode"]),
                         (policy["feature"], "1.1.0", "c" * 40, "feature/project-workflows/legacy-001", "automatic"))
        # Pinned before reviewer_transport existed: the export reports the transport the run recorded (a print receipt), never a default.
        self.assertEqual(section["automatic"], {"finish": "verified-feature-branch", "permission_mode": "bypassPermissions",
                                                "worker_timeout_seconds": 3600, "review_timeout_seconds": 1800, "reviewer_transport": "print"})
        self.assertEqual(section["setup"], [{"argv": ["npm", "ci"], "command": "npm ci", "timeout_seconds": 600}])
        self.assertEqual((section["max_verification_attempts"], section["failure_drill"]), (3, {"node_id": "adapter", "phase": "worker", "attempt": 1}))
        self.assertEqual(list(section["workers"]), ["ui", "adapter"])
        # A plan pinned before configured lanes: both lanes selected, nothing excluded, kinds derived from the 1.1.0 roles.
        self.assertEqual((section["selected_workers"], section["excluded_workers"]), (["ui", "adapter"], []))
        self.assertEqual([worker["required_check_kinds"] for worker in section["workers"].values()], [["build", "browser"], ["unit"]])
        ui = section["workers"]["ui"]
        self.assertEqual((ui["role"], ui["task"], ui["prompt"]), ("frontend", plan["nodes"]["ui"]["task"], "You are a workflow worker.\n\n# ui task"))
        self.assertIsNone(section["workers"]["adapter"]["prompt"])
        self.assertEqual(ui["owned_paths"], policy["workers"][0]["owned_paths"])
        browser = next(check for check in ui["checks"] if check["kind"] == "browser")
        self.assertEqual(browser["command"], "npx --no-install playwright test --config=tests/project-workflows/playwright.config.ts")
        self.assertEqual(len(browser["scenarios"]), len(next(check for check in policy["workers"][0]["checks"] if check["kind"] == "browser")["scenarios"]))
        self.assertEqual(ui["launch"], {"session_id": "uuuuuuuu-1111-4111-8111-111111111111", "launch_token": plan["nodes"]["ui"]["session_id"],
                                        "launch_requested_at": "2026-09-21T14:33:25.331982Z", "native_started_at": 1790001207771,
                                        "observed_state": "working", "status": "attached_session_available", "launcher_invocations": 1, "background_id": "uuuuuuuu"})
        # A 1.0.0 completion (runs before slice 2) exports the 1.1.0 evidence as nulls, and there are no questions.
        self.assertEqual(ui["completion"], {"version": "1.0.0", "status": "completed", "summary": "ui implemented", "open_assumptions": ["assumed"],
                                            "untested": None, "falsifying_check": None, "verify_yourself": None, "question": None})
        self.assertEqual((ui["questions"], section["decisions"], section["challenge"]), ([], None, None))
        self.assertEqual(ui["handoff"], {"summary": "ui implemented", "open_assumptions": ["assumed"]})
        stop = directory / "ui.stop.json"
        self.assertEqual(ui["stop"], {"stopped": True, "confirmed_at": datetime.fromtimestamp(stop.stat().st_mtime, timezone.utc).isoformat().replace("+00:00", "Z")})
        # Absent or malformed receipts are null, a manual plan has no automatic block, an unconfirmed stop has no time.
        (directory / "adapter.completion.json").write_text("{not json")
        (directory / "adapter.handoff.json").unlink()
        (directory / "adapter.interactive.json").unlink()
        save_json(directory / "adapter.stop.json", {"stopped": False})
        del plan["automatic"]
        section = inputs_section(directory, plan, policy)
        adapter = section["workers"]["adapter"]
        self.assertEqual((section["mode"], section["automatic"]), ("manual", None))
        self.assertEqual((adapter["completion"], adapter["handoff"], adapter["launch"], adapter["stop"]), (None, None, None, {"stopped": False, "confirmed_at": None}))
        plan["automatic"] = {"finish": "verified-feature-branch", "permission_mode": "bypassPermissions", "worker_timeout_seconds": 1,
                             "review_timeout_seconds": 1, "reviewer_transport": "print"}
        self.assertEqual(inputs_section(directory, plan, policy)["automatic"]["reviewer_transport"], "print")

    def test_legacy_plan_reports_the_recorded_reviewer_transport_or_null(self):
        directory = legacy_run(self.root)
        plan, policy = read_json(directory / "plan.json"), read_json(directory / "policy.json")
        self.assertNotIn("reviewer_transport", plan["automatic"])
        # A print receipt without a native receipt: the run reviewed headlessly.
        self.assertEqual(inputs_section(directory, plan, policy)["automatic"]["reviewer_transport"], "print")
        # A native receipt wins, exactly as the review section derives it.
        save_json(directory / "review.interactive.json", {"node_id": "review"})
        self.assertEqual(inputs_section(directory, plan, policy)["automatic"]["reviewer_transport"], "native")
        self.assertEqual(review_section(directory)["transport"], "native")
        # No reviewer receipt at all (the run has not reviewed yet): null, never a guessed default.
        (directory / "review.interactive.json").unlink()
        (directory / "automatic-review.json").unlink()
        (directory / "review.json").unlink()
        self.assertIsNone(inputs_section(directory, plan, policy)["automatic"]["reviewer_transport"])
        # A plan that pins the key reports the key regardless of receipts.
        plan["automatic"]["reviewer_transport"] = "native"
        self.assertEqual(inputs_section(directory, plan, policy)["automatic"]["reviewer_transport"], "native")
        save_json(directory / "automatic-review.json", {"status": "running"})
        plan["automatic"]["reviewer_transport"] = "print"
        self.assertEqual(inputs_section(directory, plan, policy)["automatic"]["reviewer_transport"], "print")
        # The full export of a legacy run carries the recorded transport in both sections.
        (directory / "automatic-review.json").unlink()
        del plan["automatic"]["reviewer_transport"]
        save_json(directory / "plan.json", plan)
        exported = export_run(ExportRuntime(directory))
        self.assertIsNone(exported["review"])
        self.assertIsNone(exported["inputs"]["automatic"]["reviewer_transport"])


class ServedCompletionTests(unittest.TestCase):
    """Export 1.5.0: a lane's completion is served only as the controller reads it, with the version the run pinned."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = legacy_run(Path(self.temp.name))
        self.plan, self.policy = read_json(self.directory / "plan.json"), read_json(self.directory / "policy.json")
        self.token = self.plan["nodes"]["ui"]["session_id"]

    def served(self):
        return inputs_section(self.directory, self.plan, self.policy)["workers"]["ui"]["completion"]

    def write(self, **fields):
        save_json(self.directory / "ui.completion.json", {
            "version": "1.1.0", "run_id": "legacy-001", "node_id": "ui", "launch_token": self.token, "status": "blocked", "summary": "Stuck",
            "open_assumptions": [], "untested": None, "falsifying_check": "", "verify_yourself": None, "question": None, **fields})

    def questions(self, count: int):
        save_json(self.directory / "ui.questions.json", {"node_id": "ui", "questions": [
            {"n": n, "question": f"Q{n}?", "asked_at": "2026-09-23T10:00:00Z", "answer": "A", "answered_at": "2026-09-23T10:01:00Z"} for n in range(1, count + 1)]})

    def test_a_1_0_0_completion_is_served_as_1_0_0_only_where_the_run_reads_it(self):
        # A run prepared before slice 2 reads 1.0.0: served with its version and null evidence.
        self.assertEqual(self.served(), {"version": "1.0.0", "status": "completed", "summary": "ui implemented", "open_assumptions": ["assumed"],
                                         "untested": None, "falsifying_check": None, "verify_yourself": None, "question": None})
        # A run pinned at 1.1.0 refuses the same file (read_signal blocks the run on it): it is not the worker's signal.
        self.plan["completion_version"] = "1.1.0"
        self.assertIsNone(self.served())
        # And a 1.1.0 file in a run pinned before slice 2, or a stale launch token, is refused as well.
        del self.plan["completion_version"]
        self.write(status="completed")
        self.assertIsNone(self.served())
        self.plan["completion_version"] = "1.1.0"
        self.write(launch_token="another-launch")
        self.assertIsNone(self.served())

    def test_a_1_1_0_blocked_completion_without_evidence_is_served_as_1_1_0(self):
        self.plan["completion_version"] = "1.1.0"
        self.write()
        self.assertEqual(self.served(), {"version": "1.1.0", "status": "blocked", "summary": "Stuck", "open_assumptions": [],
                                         "untested": None, "falsifying_check": None, "verify_yourself": None, "question": None})

    def test_a_question_is_served_with_its_text_and_a_fourth_as_blocked(self):
        self.plan["completion_version"] = "1.1.0"
        # Not recorded yet (the controller has not polled it): a question with its text.
        self.write(status="question", question="Option A or B?")
        self.questions(2)
        self.assertEqual({key: self.served()[key] for key in ("version", "status", "question")}, {"version": "1.1.0", "status": "question", "question": "Option A or B?"})
        # After three recorded questions, record_question refuses it and the lane is blocked: served as blocked, with the question.
        self.questions(3)
        self.assertEqual({key: self.served()[key] for key in ("status", "summary", "question")}, {"status": "blocked", "summary": "Stuck", "question": "Option A or B?"})
        # A worker's own blocked file carries no question, whatever it wrote there.
        self.write(question="Ignored?")
        self.assertIsNone(self.served()["question"])


class ReviewerExportTests(unittest.TestCase):
    """Export 1.4.0: the review section's per-reviewer entries from the combined record and the reviewers' own files."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def test_two_reviewer_record_exports_one_entry_per_reviewer_with_its_findings_and_times(self):
        directory = legacy_run(self.root)
        plan = read_json(directory / "plan.json")
        plan["reviewers"] = [{"reviewer_id": "general", "prompt": "General."}, {"reviewer_id": "coverage", "prompt": "Coverage."}]
        save_json(directory / "plan.json", plan)
        (directory / "automatic-review.json").unlink()
        review = read_json(directory / "review.json")
        general = {"severity": "P2", "message": "Stale task error overrides verified success", "disposition": "open", "worker": "ui", "requirement": None, "reviewer": "general"}
        coverage = {"severity": "P2", "message": "No test covers the stale error", "disposition": "open", "worker": "ui", "requirement": None, "reviewer": "coverage"}
        review.update(reviewer=f"{REVIEWER}, 11111111-adec-4efe-bcd4-bbadc3525d95", verdict="blocked", findings=[general, coverage],
                      reviewers=[{"reviewer_id": "general", "session_id": REVIEWER, "verdict": "approved", "accepted_at": "2026-09-21T15:40:00.000000Z"},
                                 {"reviewer_id": "coverage", "session_id": "11111111-adec-4efe-bcd4-bbadc3525d95", "verdict": "approved", "accepted_at": "2026-09-21T15:41:00.000000Z"}])
        save_json(directory / "review.json", review)
        save_json(directory / "automatic-review.json", {"transport": "native", "status": "blocked", "reviewers": ["general", "coverage"], "accepted_at": "2026-09-21T15:41:30.000000Z",
                                                        "error": "Independent reviewer blocked the candidate (coverage)"})
        save_json(directory / "automatic-review-general.json", {"reviewer_id": "general", "node_id": "review-general", "transport": "native", "session_id": REVIEWER, "status": "accepted"})
        save_json(directory / "automatic-review-coverage.json", {"reviewer_id": "coverage", "node_id": "review-coverage", "transport": "native", "session_id": "1111", "status": "blocked"})
        save_json(directory / "review-general.interactive.json", {"node_id": "review-general", "launch_requested_at": "2026-09-21T15:30:00.100000+00:00"})
        save_json(directory / "review-coverage.interactive.json", {"node_id": "review-coverage", "launch_requested_at": "2026-09-21T15:30:02+00:00"})
        section = review_section(directory)
        self.assertEqual((section["transport"], section["verdict"], section["reviewed_at"]), ("native", "blocked", "2026-09-21T15:41:30.000000Z"))
        self.assertEqual([finding["reviewer"] for finding in section["findings"]], ["general", "coverage"])
        self.assertEqual(section["reviewers"], [
            {"reviewer_id": "general", "transport": "native", "session_id": REVIEWER, "verdict": "approved", "findings": [general],
             "launched_at": "2026-09-21T15:30:00.100000Z", "accepted_at": "2026-09-21T15:40:00.000000Z", "status": "accepted"},
            {"reviewer_id": "coverage", "transport": "native", "session_id": "11111111-adec-4efe-bcd4-bbadc3525d95", "verdict": "approved", "findings": [coverage],
             "launched_at": "2026-09-21T15:30:02Z", "accepted_at": "2026-09-21T15:41:00.000000Z", "status": "blocked"}])
        # A superseded reviewer without a verdict, and one whose status file is missing, stay pending or superseded, never guessed as accepted.
        review["reviewers"][1].update(verdict=None, accepted_at=None)
        review["findings"] = [general]
        save_json(directory / "review.json", review)
        save_json(directory / "automatic-review-coverage.json", {"reviewer_id": "coverage", "status": "superseded"})
        (directory / "automatic-review-general.json").unlink()
        section = review_section(directory)
        self.assertEqual([(entry["reviewer_id"], entry["verdict"], entry["status"], entry["accepted_at"], len(entry["findings"])) for entry in section["reviewers"]],
                         [("general", "approved", "accepted", "2026-09-21T15:40:00.000000Z", 1), ("coverage", None, "superseded", None, 0)])
        exported = export_run(ExportRuntime(directory))
        self.assertEqual(exported["version"], "1.5.0")
        self.assertEqual([entry["reviewer_id"] for entry in exported["review"]["reviewers"]], ["general", "coverage"])
        self.assertEqual(exported["inputs"]["automatic"]["reviewer_transport"], "native")  # A per-reviewer receipt records the native transport.
        # The controller's own validation refuses a record whose reviewers are not the plan's, or whose findings name a stranger.
        review["reviewers"][0]["reviewer_id"] = "security"
        save_json(directory / "review.json", review)
        with self.assertRaisesRegex(ValueError, "names reviewer 'general'"):
            ExportRuntime(directory)


class ExportRunTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def test_legacy_run_directory_re_exports_to_current_version_and_stays_stable(self):
        directory = legacy_run(self.root)
        # The checkpoint of a finished run: no pending work, integrated commit recorded.
        from langgraph.checkpoint.sqlite import SqliteSaver
        from .pipeline import build_pipeline
        runtime = ExportRuntime(directory)
        self.assertFalse(Path(runtime.plan["repository"]).exists())  # Worktrees and repository are gone.
        with SqliteSaver.from_conn_string(str(directory / "pipeline.sqlite")) as saver:
            graph = build_pipeline(saver, runtime)
            graph.update_state({"configurable": {"thread_id": "legacy-001"}}, {"run_id": "legacy-001", "integrated_commit": "d" * 40}, as_node="integrate")
        before = read_json(directory / "run-state.json")
        exported = export_run(runtime)
        self.assertEqual(exported["version"], EXPORT_VERSION)
        self.assertEqual(exported["version"], "1.5.0")
        self.assertNotEqual(exported["updated_at"], before["updated_at"])
        self.assertEqual(exported["created_at"], before["created_at"])
        self.assertEqual(exported["values"]["integrated_commit"], "d" * 40)
        self.assertEqual(exported["next"], [])
        self.assertEqual((exported["review"]["transport"], exported["review"]["reviewer_session_id"], exported["review"]["verdict"]), ("print", REVIEWER, "approved"))
        self.assertEqual(exported["inputs"]["mode"], "automatic")
        self.assertEqual(exported["inputs"]["workers"]["ui"]["launch"]["launch_requested_at"], "2026-09-21T14:33:25.331982Z")
        self.assertEqual(len(exported["definition"]["nodes"]), 9)
        written = (directory / "run-state.json").read_bytes()
        self.assertEqual(export_run(ExportRuntime(directory)), exported)
        self.assertEqual((directory / "run-state.json").read_bytes(), written)  # Unchanged content does not bump updated_at.
        self.assertFalse((directory / "review-worktree").exists())
        self.assertFalse(any(path.name.endswith(".launch.log") for path in directory.iterdir()))

    def test_prepared_run_without_checkpoint_exports_the_prepare_shape(self):
        directory = legacy_run(self.root)
        (directory / "run-state.json").unlink()
        exported = export_run(ExportRuntime(directory))
        self.assertEqual((exported["values"], exported["next"], exported["tasks"]), ({}, ["launch_ui", "launch_adapter"], []))
        self.assertFalse((directory / "pipeline.sqlite").exists())

    def test_run_without_policy_exports_null_inputs(self):
        directory = legacy_run(self.root, with_policy=False)
        exported = export_run(ExportRuntime(directory))
        self.assertIsNone(exported["inputs"])
        self.assertIsNotNone(exported["review"])

    def test_malformed_or_contradictory_runs_are_refused(self):
        directory = legacy_run(self.root)
        review = read_json(directory / "review.json")
        review["findings"][0]["worker"] = "reviewer"
        save_json(directory / "review.json", review)
        with self.assertRaisesRegex(ValueError, "finding"):
            ExportRuntime(directory)
        review["findings"][0]["worker"] = "ui"
        review["findings"][0]["requirement"] = "Do the ui work."
        review["verdict"] = "blocked"
        save_json(directory / "review.json", review)
        exported = export_run(ExportRuntime(directory))  # A blocked review exports; only approval is not required.
        self.assertEqual(exported["review"]["verdict"], "blocked")
        self.assertEqual(exported["review"]["findings"][0]["requirement"], "Do the ui work.")
        review["candidate_commit"] = "e" * 40
        save_json(directory / "review.json", review)
        with self.assertRaisesRegex(ValueError, "exact run"):
            ExportRuntime(directory)
        (directory / "review-bundle.json").unlink()
        with self.assertRaisesRegex(ValueError, "contradictory"):
            ExportRuntime(directory)
        (directory / "review.json").unlink()
        policy = read_json(directory / "policy.json")
        policy["feature"] = "edited after pinning"
        save_json(directory / "policy.json", policy)
        with self.assertRaisesRegex(ValueError, "policy changed"):
            ExportRuntime(directory)
        plan = read_json(directory / "plan.json")
        plan["automatic"]["reviewer_transport"] = "stdio"
        save_json(directory / "plan.json", plan)
        with self.assertRaisesRegex(ValueError, "reviewer transport"):
            ExportRuntime(directory)

    def test_export_cli_takes_the_lock_and_launches_nothing(self):
        directory = legacy_run(self.root)
        result = subprocess.run([sys.executable, "-m", "workflow", "export", str(directory)], cwd=REPO, capture_output=True, text=True, timeout=60)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("version 1.5.0", result.stdout)
        self.assertIn("No agents launched", result.stdout)
        exported = read_json(directory / "run-state.json")
        self.assertEqual((exported["version"], exported["review"]["reviewer_session_id"]), ("1.5.0", REVIEWER))
        self.assertTrue((directory / "controller.lock").exists())
        self.assertFalse((directory / "review.interactive.json").exists())
        review = read_json(directory / "review.json")
        review["reviewer"] = "uuuuuuuu-1111-4111-8111-111111111111"  # A worker reviewing itself is not independent.
        save_json(directory / "review.json", review)
        result = subprocess.run([sys.executable, "-m", "workflow", "export", str(directory)], cwd=REPO, capture_output=True, text=True, timeout=60)
        self.assertEqual(result.returncode, 1)
        self.assertIn("Independent reviewer identity required", result.stderr)
        self.assertEqual(read_json(directory / "run-state.json"), exported)  # A refused export leaves the previous file untouched.


if __name__ == "__main__":
    unittest.main()
