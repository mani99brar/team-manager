"""Export sections (`review`, `inputs`) and re-export of run directories produced by earlier export versions."""
import shutil
import subprocess
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

from .automatic import drive
from .export_state import EXPORT_VERSION, TASK_BYTE_LIMIT, TASK_TRUNCATED_MARKER, export_inputs
from .pipeline import export_run
from .sessions import read_json, save_json
from . import test_automatic


class ExportTests(unittest.TestCase):
    """A completed print-mode run stands in for a run directory written under export 1.0.0."""

    def setUp(self):
        test_automatic.prepare_graph(self, "print")
        f = self.fixture
        executable = f.root / "fake-reviewer"
        executable.write_text('''#!/usr/bin/env python3
import json, sys
args = sys.argv
print(json.dumps({"session_id": args[args.index('--session-id') + 1], "is_error": False, "subtype": "success",
                  "structured_output": {"verdict": "approved", "findings": [
                      {"severity": "P2", "message": "Reuse evidence is stated", "disposition": "accepted", "worker": "adapter", "requirement": "Backend"}]}}))
''')
        executable.chmod(0o700)
        f.sessions.executable = str(executable)
        with patch("workflow.automatic.wait_handoffs"):
            self.commit = drive(f.runtime)
        self.directory = f.directory
        # Files a native worker run leaves behind, which the fake workers do not write.
        for node in ("ui", "adapter"):
            save_json(self.directory / f"{node}.completion.json", {"version": "1.0.0", "run_id": "run", "node_id": node, "launch_token": f.plan["nodes"][node]["session_id"],
                                                                      "status": "completed", "summary": "Synthetic implementation for offline test", "open_assumptions": []})
            save_json(self.directory / f"{node}.stop.json", {"background_id": node, "session_id": node, "pid": 1, "stopped": True})
            receipt = read_json(self.directory / f"{node}.interactive.json")
            receipt.update(launch_token=f.plan["nodes"][node]["session_id"], launch_requested_at="2026-09-21T14:33:25.331982+00:00",
                           native_started_at=1790001207771, observed_state="working", launcher_invocations=1)
            save_json(self.directory / f"{node}.interactive.json", receipt)

    def downgrade_to_1_0_0(self, directory: Path) -> None:
        """Shape the directory as the first live run left it: no transport key, findings without link fields."""
        plan = read_json(directory / "plan.json")
        plan["automatic"].pop("reviewer_transport")
        plan.pop("feature")
        save_json(directory / "plan.json", plan)
        review = read_json(directory / "review.json")
        for finding in review["findings"]:
            finding.pop("worker"); finding.pop("requirement")
        save_json(directory / "review.json", review)
        receipt = read_json(directory / "automatic-review.json")
        receipt.pop("transport")
        save_json(directory / "automatic-review.json", receipt)
        state = read_json(directory / "run-state.json")
        state["version"] = "1.0.0"
        state.pop("review"); state.pop("inputs")
        save_json(directory / "run-state.json", state)

    def test_completed_run_exports_review_and_inputs(self):
        state = read_json(self.directory / "run-state.json")
        self.assertEqual(state["version"], EXPORT_VERSION)
        review = state["review"]
        self.assertEqual((review["verdict"], review["transport"], review["attempt"], review["independent"]), ("approved", "print", 1, True))
        self.assertEqual(review["reviewer"], read_json(self.directory / "review.json")["reviewer"])
        self.assertEqual(review["findings"][0]["worker"], "adapter")
        self.assertEqual(review["diff"]["path"], "review.diff")
        self.assertRegex(review["reviewed_at"], r"^\d{4}-\d{2}-\d{2}T.*Z$")
        self.assertIsNone(review["session"], "print mode has no native session receipt")
        # The inputs section is rebuilt from the run's own files at the next reporting boundary.
        export_run(self.directory)
        inputs = read_json(self.directory / "run-state.json")["inputs"]
        self.assertEqual((inputs["feature"], inputs["source_branch"], inputs["mode"]), ("offline-feature", "feature/automatic-test", "interactive"))
        self.assertEqual(inputs["automatic"]["reviewer_transport"], "print")
        self.assertEqual(inputs["max_verification_attempts"], 3)
        ui = next(worker for worker in inputs["workers"] if worker["node_id"] == "ui")
        self.assertEqual((ui["role"], ui["task"], ui["task_truncated"]), ("frontend", "UI", False))
        self.assertEqual(ui["owned_paths"], ["ui.txt"])
        self.assertEqual([check["id"] for check in ui["checks"]], ["build", "browser"])
        self.assertEqual(ui["checks"][1]["scenarios"], [{"id": "ready", "description": "Worker content visible"}])
        self.assertTrue(ui["checks"][0]["command"].startswith("python -c "))
        self.assertEqual(ui["launch"]["launch_requested_at"], "2026-09-21T14:33:25.331982Z")
        self.assertEqual(ui["launch"]["native_started_at"], "2026-09-21T14:33:27.771000Z")
        self.assertEqual(ui["completion"]["status"], "completed")
        self.assertEqual(ui["handoff"]["summary"], ui["completion"]["summary"])
        self.assertTrue(ui["stopped"])
        self.assertIsNone(ui["stopped_at"], "markers written before 1.2.0 carry no time")

    def test_reexport_of_a_1_0_0_run_directory_copy(self):
        copy = self.fixture.root / "run-copy"
        shutil.copytree(self.directory, copy, ignore=shutil.ignore_patterns("worktree-*", "candidate", "review-worktree", "worktree"))
        self.downgrade_to_1_0_0(copy)
        self.assertEqual(read_json(copy / "run-state.json")["version"], "1.0.0")
        result = subprocess.run([sys.executable, "-m", "workflow", "export", str(copy)], cwd=Path(__file__).resolve().parents[1],
                                capture_output=True, text=True, timeout=60)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Exported", result.stdout)
        state = read_json(copy / "run-state.json")
        self.assertEqual(state["version"], EXPORT_VERSION)
        self.assertEqual(state["values"]["integrated_commit"], self.commit, "graph state comes from the persisted checkpoint")
        self.assertEqual(state["review"]["transport"], "print", "a receipt without a transport key predates the native reviewer")
        self.assertEqual(state["review"]["findings"][0], {"severity": "P2", "message": "Reuse evidence is stated", "disposition": "accepted", "worker": None, "requirement": None})
        self.assertIsNone(state["inputs"]["feature"])
        self.assertNotIn("reviewer_transport", state["inputs"]["automatic"])
        self.assertEqual(len(state["inputs"]["workers"]), 2)
        self.assertFalse((copy / "candidate").exists(), "export needs no worktrees")
        # Idempotent: exporting again leaves the file byte-identical.
        before = (copy / "run-state.json").read_bytes()
        export_run(copy)
        self.assertEqual((copy / "run-state.json").read_bytes(), before)

    def test_export_refuses_an_invalid_review_record(self):
        review = read_json(self.directory / "review.json")
        review["verdict"] = "maybe"
        save_json(self.directory / "review.json", review)
        with self.assertRaisesRegex(ValueError, "verdict"):
            export_run(self.directory)
        review["verdict"] = "approved"
        review["bundle_sha256"] = "0" * 64
        save_json(self.directory / "review.json", review)
        with self.assertRaisesRegex(ValueError, "exact run"):
            export_run(self.directory)

    def test_export_takes_the_controller_lock_and_launches_nothing(self):
        from .sessions import run_lock
        with run_lock(self.directory):
            result = subprocess.run([sys.executable, "-m", "workflow", "export", str(self.directory)], cwd=Path(__file__).resolve().parents[1],
                                    capture_output=True, text=True, timeout=60)
        self.assertEqual(result.returncode, 1)
        self.assertIn("Another controller owns this run", result.stderr)
        self.assertEqual(sorted(self.fixture.sessions.starts), ["adapter", "ui"])

    def test_blocked_review_is_exported_with_its_findings(self):
        review = read_json(self.directory / "review.json")
        review.update(verdict="blocked", findings=[{"severity": "P0", "message": "Serves raw paths", "disposition": "open", "worker": "adapter", "requirement": None}])
        save_json(self.directory / "review.json", review)
        export_run(self.directory)
        exported = read_json(self.directory / "run-state.json")["review"]
        self.assertEqual((exported["verdict"], exported["findings"][0]["severity"]), ("blocked", "P0"))

    def test_runs_without_review_or_policy_export_null_sections(self):
        (self.directory / "review.json").unlink()
        export_run(self.directory)
        state = read_json(self.directory / "run-state.json")
        self.assertIsNone(state["review"])
        self.assertIsNotNone(state["inputs"])
        self.assertIsNone(export_inputs(self.directory, read_json(self.directory / "plan.json"), None))

    def test_oversized_task_text_is_truncated_with_a_marker(self):
        plan = read_json(self.directory / "plan.json")
        plan["nodes"]["ui"]["task"] = "x" * (TASK_BYTE_LIMIT + 10)
        inputs = export_inputs(self.directory, plan, read_json(self.directory / "policy.json"))
        ui = next(worker for worker in inputs["workers"] if worker["node_id"] == "ui")
        self.assertTrue(ui["task_truncated"])
        self.assertTrue(ui["task"].endswith(TASK_TRUNCATED_MARKER))
        self.assertEqual(len(ui["task"]), TASK_BYTE_LIMIT + len(TASK_TRUNCATED_MARKER))


if __name__ == "__main__":
    unittest.main()
