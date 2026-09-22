import base64
import copy
import hashlib
import json
import shlex
import tempfile
import unittest
from pathlib import Path

from jsonschema.exceptions import ValidationError

from .verification import CONTRACTS, evaluate_worker, policy_digest, validate_policy


class VerificationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.policy = json.loads((CONTRACTS / "verification.example.json").read_text())
        self.expected = {"run_id": "test-run", "node_id": "ui", "attempt": 1,
                         "base_commit": "a" * 40, "output_commit": "b" * 40,
                         "verification_cwd": str(self.root / "review-worktree")}
        self.result = {"contract_version": "1.0.0", **{key: value for key, value in self.expected.items() if key != "verification_cwd"},
                       "session_id": "session-ui", "status": "succeeded", "changed_files": ["src/workflow/Viewer.tsx"],
                       "checks": [], "open_assumptions": [], "artifacts": [], "summary": "Synthetic test evidence", "error": None}
        self.evidence = {"version": "1.0.0", "policy_sha256": policy_digest(self.policy),
                         **{key: self.expected[key] for key in ("run_id", "node_id", "attempt", "output_commit")}, "checks": []}
        self.paths = {}
        png = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=")
        for index, check in enumerate(self.policy["workers"][0]["checks"]):
            log_id = f"log-{index}"
            self.artifact(log_id, "log", b"synthetic test log\n")
            self.result["checks"].append({"command": shlex.join(check["argv"]), "cwd": self.expected["verification_cwd"],
                                          "started_at": "2026-01-01T12:00:00Z", "finished_at": "2026-01-01T12:00:01Z", "exit_code": 0, "log_artifact_id": log_id})
            scenarios = []
            for scenario in check["scenarios"]:
                screenshot_id = f"screenshot-{scenario['id']}"
                self.artifact(screenshot_id, "screenshot", png)
                scenarios.append({"id": scenario["id"], "status": "passed", "screenshot_artifact_id": screenshot_id})
            self.evidence["checks"].append({"id": check["id"], "worker_check_index": index,
                                             "tests": {"passed": 2, "failed": 0, "skipped": 0} if scenarios else None,
                                             "scenarios": scenarios})

    def artifact(self, artifact_id, kind, content):
        path = self.root / artifact_id
        path.write_bytes(content)
        self.paths[artifact_id] = path
        self.result["artifacts"].append({"artifact_id": artifact_id, "kind": kind,
                                          "uri": f"artifact://test/{artifact_id}", "sha256": hashlib.sha256(content).hexdigest()})

    def evaluate(self):
        return evaluate_worker(self.policy, self.result, self.evidence, expected=self.expected,
                               artifact_root=self.root, artifact_paths=self.paths)

    def test_valid_frontend_evidence_still_requires_review_and_approval(self):
        result = self.evaluate()
        self.assertEqual(result["status"], "passed", result)
        self.assertFalse(result["integration_allowed"])
        self.assertEqual(result["pending_gates"], ["independent_review", "integration_approval"])

    def test_policy_requires_frontend_build_browser_and_backend_unit(self):
        for worker_index, kind in [(0, "build"), (0, "browser"), (1, "unit")]:
            policy = copy.deepcopy(self.policy)
            worker = policy["workers"][worker_index]
            worker["checks"] = [check for check in worker["checks"] if check["kind"] != kind]
            with self.assertRaises((ValueError, ValidationError)):
                validate_policy(policy)

    def test_overlapping_ownership_and_unsafe_paths_are_rejected(self):
        for path in ["src", "../workflow", "/workflow", "src/*", "src//workflow"]:
            policy = copy.deepcopy(self.policy)
            policy["workers"][1]["owned_paths"] = [path]
            with self.assertRaises(ValueError):
                validate_policy(policy)

    def test_missing_screenshot_blocks_even_when_browser_tests_pass(self):
        self.evidence["checks"][1]["scenarios"][0]["screenshot_artifact_id"] = None
        self.assertEqual(self.evaluate()["status"], "blocked")

    def test_skipped_scenario_and_zero_tests_block(self):
        self.evidence["checks"][1]["scenarios"][0]["status"] = "skipped"
        self.assertEqual(self.evaluate()["status"], "blocked")
        self.evidence["checks"][1]["scenarios"][0]["status"] = "passed"
        self.evidence["checks"][1]["tests"]["passed"] = 0
        self.assertEqual(self.evaluate()["status"], "blocked")

    def test_changed_policy_and_stale_attempt_block(self):
        self.evidence["attempt"] = 2
        self.assertEqual(self.evaluate()["status"], "blocked")
        self.evidence["attempt"] = 1
        self.policy["feature"] = "A different feature"
        self.assertEqual(self.evaluate()["status"], "blocked")

    def test_tampered_artifact_and_registry_escape_block(self):
        self.paths["log-0"].write_text("tampered")
        self.assertEqual(self.evaluate()["status"], "blocked")
        self.paths["log-0"] = Path(__file__).resolve()
        self.assertEqual(self.evaluate()["status"], "blocked")

    def test_missing_checks_and_nonzero_exit_block(self):
        self.result["checks"][0]["exit_code"] = 1
        self.assertEqual(self.evaluate()["status"], "blocked")
        self.result["checks"][0]["exit_code"] = 0
        self.evidence["checks"].pop()
        self.assertEqual(self.evaluate()["status"], "blocked")

    def test_wrong_command_and_verification_worktree_block(self):
        self.result["checks"][0]["command"] = "true"
        self.assertEqual(self.evaluate()["status"], "blocked")
        self.result["checks"][0]["command"] = "npm run build"
        self.result["checks"][0]["cwd"] = str(self.root / "wrong")
        self.assertEqual(self.evaluate()["status"], "blocked")

    def test_path_prefix_is_not_a_glob(self):
        self.result["changed_files"] = ["src/workflow-other/secret.ts"]
        self.assertEqual(self.evaluate()["status"], "blocked")

    def test_backend_unit_and_contract_evidence(self):
        worker = self.policy["workers"][1]
        self.expected["node_id"] = "adapter"
        self.result["node_id"] = "adapter"
        self.result["changed_files"] = ["workflow/graph.py"]
        self.evidence["node_id"] = "adapter"
        for index, check in enumerate(worker["checks"]):
            self.result["checks"][index]["command"] = shlex.join(check["argv"])
            self.evidence["checks"][index].update(id=check["id"], scenarios=[], tests={"passed": 3, "failed": 0, "skipped": 0})
        self.assertEqual(self.evaluate()["status"], "passed")

    def fail_build_and_browser(self):
        """An isolated lane snapshot whose build fails and whose browser suite cannot load."""
        checks = {check["id"]: check for check in self.policy["workers"][0]["checks"]}
        build_index = self.evidence["checks"][[c["id"] for c in self.evidence["checks"]].index("frontend-build")]["worker_check_index"]
        self.result["checks"][build_index]["exit_code"] = 2
        browser = next(receipt for receipt in self.evidence["checks"] if receipt["id"] == "workflow-browser")
        self.result["checks"][browser["worker_check_index"]]["exit_code"] = 1
        browser.update(tests={"passed": 0, "failed": 0, "skipped": 0}, scenarios=[])
        self.assertEqual({checks["frontend-build"]["kind"], checks["workflow-browser"]["kind"]}, {"build", "browser"})

    def test_worker_phase_records_build_and_browser_without_gating(self):
        self.fail_build_and_browser()
        result = evaluate_worker(self.policy, self.result, self.evidence, expected=self.expected,
                                 artifact_root=self.root, artifact_paths=self.paths, phase="worker")
        self.assertEqual(result["status"], "passed", result)
        self.assertEqual(result["deferred_checks"], ["frontend-build", "workflow-browser"])
        self.assertFalse(result["integration_allowed"])

    def test_candidate_phase_gates_on_build_and_browser(self):
        self.fail_build_and_browser()
        for phase in ("candidate", None):
            result = evaluate_worker(self.policy, self.result, self.evidence, expected=self.expected,
                                     artifact_root=self.root, artifact_paths=self.paths, **({"phase": phase} if phase else {}))
            self.assertEqual(result["status"], "blocked")
            self.assertEqual(result["deferred_checks"], [])
            self.assertTrue(any(reason.startswith("Executed check failed: ") for reason in result["reasons"]), result)
            self.assertIn("workflow-browser: no passing test evidence or failed tests", result["reasons"])

    def test_worker_phase_still_checks_deferred_command_integrity_and_lane_local_kinds(self):
        self.fail_build_and_browser()
        self.result["checks"][0]["command"] = "npm run build -- --unapproved"
        result = evaluate_worker(self.policy, self.result, self.evidence, expected=self.expected,
                                 artifact_root=self.root, artifact_paths=self.paths, phase="worker")
        self.assertEqual(result["status"], "blocked")
        self.assertEqual(result["reasons"], ["frontend-build: executed command differs from approved argv"])
        # Lane-local kinds gate in the worker phase exactly as before.
        worker = self.policy["workers"][1]
        self.expected["node_id"] = self.result["node_id"] = self.evidence["node_id"] = "adapter"
        self.result["changed_files"] = ["workflow/graph.py"]
        for index, check in enumerate(worker["checks"]):
            self.result["checks"][index].update(command=shlex.join(check["argv"]), exit_code=0)
            self.evidence["checks"][index].update(id=check["id"], scenarios=[], tests={"passed": 3, "failed": 1, "skipped": 0})
        result = evaluate_worker(self.policy, self.result, self.evidence, expected=self.expected,
                                 artifact_root=self.root, artifact_paths=self.paths, phase="worker")
        self.assertEqual(result["status"], "blocked")
        self.assertEqual(result["deferred_checks"], [])
        self.assertIn("backend-unit: no passing test evidence or failed tests", result["reasons"])

    def test_recheck_packet_keeps_deferred_capture_errors_out_of_the_worker_gate(self):
        from .checks import recheck_packet
        self.fail_build_and_browser()
        packet = {"phase": "worker", "expected": self.expected, "result": self.result, "evidence": self.evidence,
                  "artifact_root": str(self.root), "artifact_paths": {key: str(path) for key, path in self.paths.items()},
                  "capture_errors": ["frontend-build: exit 2", "workflow-browser: [Errno 2] No such file or directory: 'browser-report.json'",
                                     "workflow-browser/viewer: screenshot missing"]}
        gate = recheck_packet(copy.deepcopy(packet), self.policy, self.root)["gate"]
        self.assertEqual((gate["status"], gate["reasons"]), ("passed", []))
        packet["capture_errors"].append("Intentional lab drill: verification branch failure, not a worker or test failure")
        gate = recheck_packet(copy.deepcopy(packet), self.policy, self.root)["gate"]
        self.assertEqual((gate["status"], gate["reasons"]), ("blocked", ["Intentional lab drill: verification branch failure, not a worker or test failure"]))
        packet["phase"] = "candidate"
        gate = recheck_packet(copy.deepcopy(packet), self.policy, self.root)["gate"]
        self.assertEqual(gate["status"], "blocked")
        self.assertIn("frontend-build: exit 2", gate["reasons"])

    def test_malformed_payload_blocks(self):
        del self.result["open_assumptions"]
        self.assertEqual(self.evaluate()["status"], "blocked")


if __name__ == "__main__":
    unittest.main()
