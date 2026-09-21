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

    def test_malformed_payload_blocks(self):
        del self.result["open_assumptions"]
        self.assertEqual(self.evaluate()["status"], "blocked")


if __name__ == "__main__":
    unittest.main()
