"""Offline end-to-end graph tests: fake workers, real Git/unit/browser checks."""
import copy
import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from langgraph.checkpoint.sqlite import SqliteSaver
from langgraph.types import Command

from .checks import execute
from .pipeline import Pipeline, build_pipeline, digest_file, report, validate_pipeline_policy
from .sessions import git, prepare, read_json, save_json
from .verification import CONTRACTS, policy_digest


class FakeSessions:
    def __init__(self, directory, plan):
        self.directory, self.plan = directory, plan
        self.starts = []

    def run(self, node):
        self.starts.append(node)
        cwd = Path(self.plan["nodes"][node]["worktree"])
        (cwd / ("ui.txt" if node == "ui" else "backend.py")).write_text("after" if node == "ui" else "VALUE = 2\n")
        receipt = {"session_id": self.plan["nodes"][node]["session_id"], "status": "fake-worker-completed"}
        save_json(self.directory / f"{node}.interactive.json", receipt)
        save_json(self.directory / f"{node}.handoff.json", {"summary": "Synthetic implementation for offline test", "open_assumptions": []})
        return receipt


class OfflinePipeline(Pipeline):
    def stop_workers(self):
        self.event("freeze", "stopped", "Fake workers have no background processes")


class PipelineTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.repo = self.root / "repo"
        self.repo.mkdir()
        (self.repo / "contracts/workflow").mkdir(parents=True)
        shutil.copyfile(CONTRACTS / "workerResult.schema.json", self.repo / "contracts/workflow/workerResult.schema.json")
        (self.repo / "ui.txt").write_text("before")
        (self.repo / "backend.py").write_text("VALUE = 1\n")
        (self.repo / ".gitignore").write_text("__pycache__/\n")
        (self.repo / "tests").mkdir()
        self.fail_marker = self.root / "fail-once"
        (self.repo / "tests/test_backend.py").write_text(f'''import unittest
from pathlib import Path
from backend import VALUE
class BackendTest(unittest.TestCase):
    def test_value(self):
        marker = Path({str(self.fail_marker)!r})
        if marker.exists():
            marker.unlink()
            self.fail('injected one-time check failure')
        self.assertEqual(VALUE, 2)
''')
        # Real Playwright, but local fixture content, no network or application server.
        repo_root = Path(__file__).resolve().parents[1]
        self.playwright = repo_root / "node_modules/playwright/cli.js"
        test_module = repo_root / "node_modules/@playwright/test"
        (self.repo / "tests/browser.spec.cjs").write_text(f'''const {{test, expect}} = require({json.dumps(str(test_module))});
const fs = require('node:fs');
const path = require('node:path');
test('[scenario:ready] shows the worker change', async ({{page}}, testInfo) => {{
 const content = fs.readFileSync(path.join(__dirname, '../ui.txt'), 'utf8');
 await page.setContent('<h1>' + content + '</h1>');
 await expect(page.getByRole('heading')).toHaveText('after');
 const screenshot = testInfo.outputPath('ready.png');
 await page.screenshot({{path: screenshot}});
 await testInfo.attach('screenshot:ready', {{path: screenshot, contentType: 'image/png'}});
}});
''')
        (self.repo / "playwright.config.cjs").write_text("module.exports = {testDir:'./tests', testMatch:'browser.spec.cjs', use:{headless:true}};\n")
        for args in (["init", "-q"], ["config", "user.name", "Test"], ["config", "user.email", "test@example.invalid"], ["add", "."], ["commit", "-qm", "Base contract"]):
            subprocess.run(["git", "-C", str(self.repo), *args], check=True)
        self.directory = self.root / "run"
        self.plan = prepare(self.directory, self.repo, "HEAD", {"ui": "UI", "adapter": "Backend"}, True)
        self.policy = {"version": "1.0.0", "feature": "Offline pipeline test", "independent_review": True, "integration_approval": True,
                       "workers": [
                           {"node_id": "ui", "role": "frontend", "owned_paths": ["ui.txt"], "checks": [
                               {"id": "build", "kind": "build", "argv": ["python", "-c", "from pathlib import Path; assert Path('ui.txt').read_text() == 'after'"], "timeout_seconds": 10, "scenarios": []},
                               {"id": "browser", "kind": "browser", "argv": ["node", str(self.playwright), "test", "--config=playwright.config.cjs"], "timeout_seconds": 60,
                                "scenarios": [{"id": "ready", "description": "Worker content visible"}]}
                           ]},
                           {"node_id": "adapter", "role": "backend", "owned_paths": ["backend.py"], "checks": [
                               {"id": "unit", "kind": "unit", "argv": ["python", "-m", "unittest", "discover", "-s", "tests", "-p", "test_*.py"], "timeout_seconds": 10, "scenarios": []}
                           ]}
                       ]}
        self.plan.update(mode="interactive", policy_sha256=policy_digest(self.policy), source_branch=git(self.repo, "symbolic-ref", "--short", "HEAD"))
        save_json(self.directory / "plan.json", self.plan)
        save_json(self.directory / "policy.json", self.policy)
        self.sessions = FakeSessions(self.directory, self.plan)
        self.runtime = OfflinePipeline(self.directory, self.sessions)
        self.config = {"configurable": {"thread_id": "run"}, "max_concurrency": 2}

    def review(self):
        bundle, digest = self.runtime.validate_bundle()
        return {"run_id": "run", "bundle_sha256": digest, "candidate_commit": bundle["candidate_commit"],
                "reviewer": "synthetic-test-reviewer", "independent": True, "verdict": "approved", "findings": []}

    def test_complete_offline_graph_with_real_browser_and_explicit_gates(self):
        self.assertTrue(self.playwright.exists(), "Install npm dependencies before running browser verification tests")
        with SqliteSaver.from_conn_string(str(self.directory / "graph.sqlite")) as saver:
            graph = build_pipeline(saver, self.runtime)
            first = graph.invoke({"run_id": "run"}, self.config)
            self.assertEqual(first["__interrupt__"][0].value["kind"], "worker_handoff")
            verified = graph.invoke(Command(resume={"freeze": True}), self.config)
            self.assertEqual(verified["__interrupt__"][0].value["kind"], "independent_review")
            self.assertEqual(git(self.repo, "rev-parse", "HEAD"), self.plan["base_commit"])
            decision = self.review()
            self.runtime.validate_review(decision)
            approved = graph.invoke(Command(resume=decision), self.config)
            self.assertEqual(approved["__interrupt__"][0].value["kind"], "integration_approval")
            final = graph.invoke(Command(resume={"approve": decision["bundle_sha256"]}), self.config)
            self.assertEqual(final["integrated_commit"], git(self.repo, "rev-parse", "HEAD"))
            self.assertEqual((self.repo / "ui.txt").read_text(), "after")
            self.assertEqual((self.repo / "backend.py").read_text(), "VALUE = 2\n")
            self.assertFalse(graph.get_state(self.config).next)
            report_path = report(self.runtime, graph.get_state(self.config))
            self.assertTrue(report_path.exists())
            script = f'''const {{chromium}} = require({json.dumps(str(self.playwright.parent))});
(async () => {{
 const browser = await chromium.launch();
 try {{
  const page = await browser.newPage();
  await page.goto({json.dumps(report_path.as_uri())});
  if (await page.getByRole('heading', {{name:'Workflow report', exact:true}}).count() !== 1) throw Error('Missing report title');
  if (!await page.locator('svg[aria-label="Workflow execution graph"]').isVisible()) throw Error('Missing graph');
  if (await page.locator('img').count() < 2) throw Error('Missing screenshot evidence');
  if (!await page.locator('img').first().evaluate(img => img.complete && img.naturalWidth > 0)) throw Error('Broken screenshot link');
  await page.screenshot({{path: {json.dumps(str(self.directory / 'report-viewer.png'))}, fullPage:true}});
 }} finally {{ await browser.close(); }}
}})().catch(error => {{ console.error(error); process.exitCode=1; }});
'''
            code, _, _ = execute(["node", "-e", script], self.directory, self.directory / "report-browser.log", 30, dict(os.environ))
            self.assertEqual(code, 0, (self.directory / "report-browser.log").read_text())
            self.assertEqual(sorted(self.sessions.starts), ["adapter", "ui"])
            screenshots = list((self.directory / "verification").glob("**/screenshot-*"))
            self.assertGreaterEqual(len(screenshots), 2)  # Worker + combined candidate.
            self.assertTrue(all(path.read_bytes().startswith(b"\x89PNG") for path in screenshots))

    def test_failed_check_reuses_worker_and_successful_sibling(self):
        self.fail_marker.touch()
        with SqliteSaver.from_conn_string(str(self.directory / "graph.sqlite")) as saver:
            graph = build_pipeline(saver, self.runtime)
            graph.invoke({"run_id": "run"}, self.config)
            with self.assertRaisesRegex(RuntimeError, "adapter verification blocked"):
                graph.invoke(Command(resume={"freeze": True}), self.config)
            first_ui = self.directory / "verification/worker/ui/1/packet.json"
            ui_digest = digest_file(first_ui)
        save_json(self.directory / "attempts.json", {"worker:adapter": 2})
        with SqliteSaver.from_conn_string(str(self.directory / "graph.sqlite")) as saver:
            graph = build_pipeline(saver, self.runtime)
            outcome = graph.invoke(None, self.config)
            self.assertEqual(outcome["__interrupt__"][0].value["kind"], "independent_review")
        self.assertEqual(digest_file(first_ui), ui_digest)
        self.assertFalse((self.directory / "verification/worker/ui/2").exists())
        self.assertTrue((self.directory / "verification/worker/adapter/2/packet.json").exists())
        self.assertEqual(sorted(self.sessions.starts), ["adapter", "ui"])
        decision = self.review()
        decision["bundle_sha256"] = "0" * 64
        with self.assertRaisesRegex(ValueError, "exact run"):
            self.runtime.validate_review(decision)
        packet = read_json(first_ui)
        artifact = Path(next(iter(packet["artifact_paths"].values())))
        artifact.chmod(0o600)
        artifact.write_text("tampered")
        with self.assertRaisesRegex(ValueError, "artifact"):
            self.runtime.validate_bundle()

    def test_configured_failure_drill_reopens_checkpoint_and_enforces_attempt_cap(self):
        self.policy.update(version="1.1.0", max_verification_attempts=2,
                           failure_drill={"node_id": "adapter", "phase": "worker", "attempt": 1})
        self.plan["policy_sha256"] = policy_digest(self.policy)
        save_json(self.directory / "policy.json", self.policy)
        save_json(self.directory / "plan.json", self.plan)
        self.runtime = OfflinePipeline(self.directory, self.sessions)
        with SqliteSaver.from_conn_string(str(self.directory / "graph.sqlite")) as saver:
            graph = build_pipeline(saver, self.runtime)
            graph.invoke({"run_id": "run"}, self.config)
            with self.assertRaisesRegex(RuntimeError, "adapter verification blocked"):
                graph.invoke(Command(resume={"freeze": True}), self.config)
            report(self.runtime, graph.get_state(self.config))
            exported = read_json(self.directory / "run-state.json")
            self.assertTrue(any(task["error"] for task in exported["tasks"]))
            self.assertTrue(exported["verification_packets"])
        ui_path = self.directory / "verification/worker/ui/1/packet.json"
        original = digest_file(ui_path)
        self.assertEqual(self.runtime.retry_check("worker", "adapter"), 2)
        with SqliteSaver.from_conn_string(str(self.directory / "graph.sqlite")) as saver:
            graph = build_pipeline(saver, self.runtime)
            outcome = graph.invoke(None, self.config)
            self.assertEqual(outcome["__interrupt__"][0].value["kind"], "independent_review")
            final_state = graph.get_state(self.config)
        audit = read_json(self.directory / "failure-report.json")
        self.assertIn("Checkpoint failure drill", report(self.runtime, final_state).read_text())
        self.assertEqual(audit["workers_with_changed_launch_evidence"], [])
        self.assertEqual(audit["verification_attempts"], {"ui": [1], "adapter": [1, 2]})
        self.assertEqual(sorted(self.sessions.starts), ["adapter", "ui"])
        self.assertEqual(digest_file(ui_path), original)
        with self.assertRaisesRegex(ValueError, "limit reached"):
            self.runtime.retry_check("worker", "adapter")
        self.assertEqual(self.runtime.attempt("worker", "adapter"), 2)

    def test_wrong_role_mapping_cannot_disable_required_gate_categories(self):
        for role in ("backend", "frontend"):
            policy = copy.deepcopy(self.policy)
            template = next(worker for worker in policy["workers"] if worker["role"] == role)
            for worker in policy["workers"]:
                worker["role"] = role
                worker["checks"] = copy.deepcopy(template["checks"])
            with self.assertRaisesRegex(ValueError, "ui/frontend"):
                validate_pipeline_policy(policy)

    def native_rows(self):
        return {node: {"id": f"id-{node}", "sessionId": f"session-{node}", "pid": 90000 + index}
                for index, node in enumerate(("ui", "adapter"))}

    def set_native(self, live):
        self.runtime.sessions = SimpleNamespace(executable="claude", inventory=lambda: list(live.values()),
                                               locate=lambda node, rows: next((row for row in rows if row["id"] == f"id-{node}"), None))

    def test_native_stop_success_and_partial_recovery(self):
        live = self.native_rows()
        self.set_native(live)
        def stop(argv, **_kwargs):
            node = argv[-1].removeprefix("id-")
            live.pop(node)
            return subprocess.CompletedProcess(argv, 0)
        with patch("workflow.pipeline.subprocess.run", side_effect=stop) as command, patch("workflow.pipeline.pid_alive", return_value=False):
            Pipeline.stop_workers(self.runtime)
            self.assertEqual(command.call_count, 2)
            Pipeline.stop_workers(self.runtime)
            self.assertEqual(command.call_count, 2)
        self.assertTrue(all(read_json(self.directory / f"{node}.stop.json")["stopped"] for node in ("ui", "adapter")))

    def test_completed_stop_intent_is_reconciled_without_another_stop(self):
        for node, row in self.native_rows().items():
            save_json(self.directory / f"{node}.stop.json", {"background_id": row["id"], "session_id": row["sessionId"], "pid": row["pid"], "stopped": False})
        self.set_native({})
        with patch("workflow.pipeline.subprocess.run") as command, patch("workflow.pipeline.pid_alive", return_value=False):
            Pipeline.stop_workers(self.runtime)
            command.assert_not_called()

    def test_failed_stop_and_lingering_pid_block_freeze(self):
        live = self.native_rows()
        self.set_native(live)
        with patch("workflow.pipeline.subprocess.run", return_value=subprocess.CompletedProcess([], 1)):
            with self.assertRaisesRegex(RuntimeError, "Stop failed"):
                Pipeline.stop_workers(self.runtime)
        self.assertFalse(read_json(self.directory / "ui.stop.json")["stopped"])
        with patch("workflow.pipeline.subprocess.run", return_value=subprocess.CompletedProcess([], 0)), patch("workflow.pipeline.pid_alive", return_value=True):
            with self.assertRaisesRegex(RuntimeError, "termination"):
                Pipeline.stop_workers(self.runtime)

    def test_missing_handoff_does_not_stop_workers(self):
        with patch.object(self.runtime, "stop_workers") as stop:
            with self.assertRaisesRegex(ValueError, "Missing ui handoff"):
                self.runtime.freeze()
            stop.assert_not_called()

    def test_ownership_violation_blocks_snapshot(self):
        self.sessions.run("ui"); self.sessions.run("adapter")
        (Path(self.plan["nodes"]["ui"]["worktree"]) / "backend.py").write_text("UNOWNED = True\n")
        with self.assertRaisesRegex(ValueError, "unowned"):
            self.runtime.freeze()


if __name__ == "__main__":
    unittest.main()
