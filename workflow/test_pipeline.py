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

from .checks import execute, now
from .pipeline import Pipeline, build_pipeline, check_review, digest_file, report, validate_pipeline_policy
from .sessions import git, plan_workers, prepare, read_json, review_node, reviewer_ids, save_json
from .verification import CONTRACTS, policy_digest

# What each fake lane writes into its worktree: the two classic lanes edit fixture files the checks read;
# any other lane creates a file under a directory named after it.
LANE_EDITS = {"ui": ("ui.txt", "after"), "adapter": ("backend.py", "VALUE = 2\n")}


class FakeSessions:
    """Offline stand-in for InteractiveSessions. Receipts on disk are its only cross-process state.

    Reviewer knobs take either one value for every reviewer or a dict keyed by reviewer id (`review` for the default).
    """

    REVIEWER_UUID = "33333333-3333-4333-8333-333333333333"

    def __init__(self, directory, plan):
        self.directory, self.plan = directory, plan
        self.workers = plan_workers(plan)
        self.edits = dict(LANE_EDITS)          # Per-lane (path, content) a fake worker writes; tests override to violate ownership.
        self.starts = []
        self.reviewer_verdict_file = None  # A file whose text is the fake reviewer's verdict (default approved).
        self.reviewer_verdicts = {}        # Per-reviewer verdict overriding the file: {"coverage": "blocked"}.
        self.reviewer_findings = []        # Findings the fake reviewer reports (a list for every reviewer, or a dict per reviewer id).
        self.reviewer_mutate = None        # Callable applied to the completion payload before it is written (or a dict per reviewer id).
        self.reviewer_writes_file = True   # False: no reviewer writes a file; a set of ids: only those write one.
        self.reviewer_session_id = None    # Override of one native UUID for every reviewer (a worker's: not independent), or a dict per reviewer id.
        self.reviewer_states = {}          # Per-reviewer native state instead of idle: {"general": "working"}.
        self.reviewer_after_file = None    # Callable run right after a completion file is written (dirty the worktree, rewrite the diff).
        self.reviewer_row_after_file = None  # Once a completion file exists: a dict merged into the located reviewer row, or "missing" for None.

    def reviewer_nodes(self):
        return [review_node(reviewer_id) for reviewer_id in reviewer_ids(self.plan)]

    def per_reviewer(self, knob, reviewer_id, default=None):
        """A knob given as a dict applies per reviewer id; anything else applies to every reviewer."""
        if isinstance(knob, dict):
            return knob.get(reviewer_id, default)
        return knob

    def native_id(self, node):
        """The UUID the native registry reports for a session; receipts record it, they do not define it."""
        if node in self.plan["nodes"]:
            return self.plan["nodes"][node]["session_id"]
        reviewer_id = node[len("review-"):] if node.startswith("review-") else "review"
        override = self.per_reviewer(self.reviewer_session_id, reviewer_id)
        if override:
            return override
        if node == "review":
            return self.REVIEWER_UUID
        index = self.reviewer_nodes().index(node) + 1
        return f"{index:08d}-3333-4333-8333-333333333333"  # Distinct per declared reviewer.

    def background_id(self, node):
        return self.native_id(node)[:8] if node.startswith("review") else f"fake-{node}"

    def record(self, node):
        self.starts.append(node)
        with (self.directory / "fake-launches.log").open("a") as log:
            log.write(node + "\n")

    def run(self, node):
        self.record(node)
        cwd = Path(self.plan["nodes"][node]["worktree"])
        path, content = self.edits.get(node, (f"{node}/{node}.md", f"# {node}\n"))
        (cwd / path).parent.mkdir(parents=True, exist_ok=True)
        (cwd / path).write_text(content)
        receipt = {"node_id": node, "session_id": self.native_id(node), "launch_token": self.plan["nodes"][node]["session_id"],
                   "background_id": self.background_id(node), "status": "fake-worker-completed", "attempt": 1, "launcher_invocations": 1,
                   "launch_requested_at": now(), "observed_state": "idle", "native_started_at": None}
        save_json(self.directory / f"{node}.interactive.json", receipt)
        save_json(self.directory / f"{node}.handoff.json", {"summary": "Synthetic implementation for offline test", "open_assumptions": []})
        return receipt

    def run_reviewer(self, reviewer_id, prompt, launch_token, candidate_commit):
        node = review_node(reviewer_id)
        self.record(node)
        receipt = {"node_id": node, "session_id": self.native_id(node), "launch_token": launch_token, "background_id": self.background_id(node),
                   "worktree": str(self.directory / "review-worktree"), "candidate_commit": candidate_commit,
                   "status": "attached_session_available", "attempt": 1, "launcher_invocations": 1,
                   "launch_requested_at": now(), "observed_state": "idle", "native_started_at": None}
        save_json(self.directory / f"{node}.interactive.json", receipt)
        (self.directory / f"{node}.prompt.txt").write_text(prompt)
        writes = self.reviewer_writes_file if isinstance(self.reviewer_writes_file, bool) else reviewer_id in self.reviewer_writes_file
        if writes:
            verdict = Path(self.reviewer_verdict_file).read_text().strip() if self.reviewer_verdict_file else "approved"
            verdict = self.reviewer_verdicts.get(reviewer_id, verdict)
            findings = self.reviewer_findings.get(reviewer_id, []) if isinstance(self.reviewer_findings, dict) else self.reviewer_findings
            completion = {"version": "1.2.0", "run_id": self.plan["run_id"], "node_id": node, "launch_token": launch_token,
                          "bundle_sha256": digest_file(self.directory / "review-bundle.json"), "candidate_commit": candidate_commit,
                          "verdict": verdict, "findings": copy.deepcopy(findings)}
            mutate = self.per_reviewer(self.reviewer_mutate, reviewer_id)
            if mutate:
                completion = mutate(completion)
            save_json(self.directory / f"{node}.completion.json", completion)
            if self.reviewer_after_file:
                self.reviewer_after_file()
        return receipt

    def reconcile(self, node, path, receipt):
        """Mirror of InteractiveSessions.reconcile: bind the one surviving session; never launch."""
        row = self.locate(node, self.inventory())
        if row is None:
            raise RuntimeError("Existing launch cannot be reconciled; no automatic relaunch")
        receipt.update(status="attached_session_available", background_id=row["id"], session_id=row["sessionId"], observed_state=row["state"])
        receipt.pop("error", None)
        save_json(path, receipt)
        return receipt

    def inventory(self):
        """The native registry: one row per session this fake launched, whatever its receipt recorded so far."""
        rows = []
        for node in (*self.workers, *self.reviewer_nodes()):
            if (self.directory / f"{node}.interactive.json").exists():
                reviewer_id = node[len("review-"):] if node.startswith("review-") else node
                rows.append({"id": self.background_id(node), "sessionId": self.native_id(node), "state": self.reviewer_states.get(reviewer_id, "idle"),
                             "pid": os.getpid(), "kind": "background"})
        return rows

    def locate(self, node, rows):
        if not (self.directory / f"{node}.interactive.json").exists():
            return None
        row = next((row for row in rows if row["id"] == self.background_id(node)), None)
        if node.startswith("review") and row is not None and self.reviewer_row_after_file is not None and (self.directory / f"{node}.completion.json").exists():
            return None if self.reviewer_row_after_file == "missing" else {**row, **self.reviewer_row_after_file}
        return row


class OfflinePipeline(Pipeline):
    def stop_workers(self):
        self.event("freeze", "stopped", "Fake workers have no background processes")

    def stop_reviewer(self, reviewer_id="review"):
        # Fake sessions have no process to stop; record the intent the real path would persist.
        node = review_node(reviewer_id)
        receipt = read_json(self.directory / f"{node}.interactive.json")
        save_json(self.directory / f"{node}.stop.json", {"background_id": receipt["background_id"], "session_id": receipt["session_id"],
                                                         "pid": None, "stopped": True, "synthetic": True})
        self.event("review", "stopped", f"Fake reviewer {reviewer_id} has no background process")


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
            self.assertEqual(sorted(self.sessions.starts), ["adapter", "ui"])  # Manual review: no reviewer session.
            exported = read_json(self.directory / "run-state.json")
            self.assertEqual(exported["version"], "1.5.0")
            self.assertEqual((exported["review"]["transport"], exported["review"]["reviewer_session_id"]), ("manual", "synthetic-test-reviewer"))
            # A manual review of the single default reviewer exports one reviewer named `review`.
            self.assertEqual([(entry["reviewer_id"], entry["transport"], entry["session_id"], entry["verdict"], entry["status"], entry["launched_at"]) for entry in exported["review"]["reviewers"]],
                             [("review", "manual", "synthetic-test-reviewer", "approved", "accepted", None)])
            self.assertEqual(exported["review"]["reviewers"][0]["accepted_at"], exported["review"]["reviewed_at"])
            self.assertEqual(exported["inputs"]["mode"], "manual")
            self.assertEqual(exported["inputs"]["workers"]["ui"]["launch"]["session_id"], self.plan["nodes"]["ui"]["session_id"])
            screenshots = list((self.directory / "verification").glob("**/screenshot-*"))
            self.assertGreaterEqual(len(screenshots), 2)  # Worker + combined candidate.
            self.assertTrue(all(path.read_bytes().startswith(b"\x89PNG") for path in screenshots))
            # Lane temp directories must be short enough for Unix sockets (tsx IPC, Chromium)
            # and must not linger after the lane, while all evidence stays inside the run.
            from .checks import SOCKET_NAME_ALLOWANCE, SOCKET_PATH_LIMIT
            for packet_path in (self.directory / "verification").glob("*/*/*/packet.json"):
                tmpdir = Path(read_json(packet_path)["tmpdir"])
                self.assertFalse(tmpdir.is_relative_to(self.directory))
                self.assertLessEqual(len(str(tmpdir)) + SOCKET_NAME_ALLOWANCE, SOCKET_PATH_LIMIT)
                self.assertFalse(tmpdir.exists())

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

    def test_relabelling_a_lane_cannot_disable_its_required_check_kinds(self):
        # Before policy 1.2.0 the role decides the kinds: relabelling the adapter as frontend demands build and browser checks.
        policy = copy.deepcopy(self.policy)
        policy["workers"][1]["role"] = "frontend"
        with self.assertRaisesRegex(ValueError, "adapter requires .*browser"):
            validate_pipeline_policy(policy)
        # From 1.2.0 the lane declares its kinds and the role is a free label; a kind without a check is refused.
        policy = copy.deepcopy(self.policy)
        policy["version"] = "1.2.0"
        policy["workers"][0].update(role="pixel pusher", required_check_kinds=["build", "browser"])
        policy["workers"][1].update(role="plumbing", required_check_kinds=["unit"])
        validate_pipeline_policy(policy)
        policy["workers"][1]["required_check_kinds"] = ["unit", "browser"]
        with self.assertRaisesRegex(ValueError, "adapter requires .*browser"):
            validate_pipeline_policy(policy)

    def test_check_review_accepts_finding_links_and_blocked_verdicts_only_when_asked(self):
        bundle = {"run_id": "run", "candidate_commit": "c" * 40, "snapshots": {"ui": {"session_id": "ui-session"}, "adapter": {"session_id": "adapter-session"}}}
        digest = "b" * 64
        base = {"run_id": "run", "bundle_sha256": digest, "candidate_commit": "c" * 40, "reviewer": "reviewer-session", "independent": True}
        plain = {"severity": "P2", "message": "Legacy finding", "disposition": "open"}
        linked = {"severity": "P2", "message": "Linked finding", "disposition": "accepted", "worker": "ui", "requirement": "Show every finding"}
        unlinked = {"severity": "P1", "message": "Cross-cutting", "disposition": "resolved", "worker": "none", "requirement": None}
        check_review({**base, "verdict": "approved", "findings": [plain, linked, unlinked]}, bundle, digest)
        for bad in ({**linked, "worker": "reviewer"}, {**linked, "worker": "both"}, {**linked, "requirement": ""}, {**linked, "requirement": 3}, {**linked, "extra": True},
                    {**linked, "worker": None}, {**plain, "severity": "P3"}, {**plain, "message": " "}):
            with self.assertRaisesRegex(ValueError, "finding"):
                check_review({**base, "verdict": "approved", "findings": [bad]}, bundle, digest)
        # `multiple` replaces `both`; the legacy spelling is accepted only for reviews recorded before configured lanes.
        check_review({**base, "verdict": "approved", "findings": [{**linked, "worker": "multiple"}]}, bundle, digest)
        check_review({**base, "verdict": "approved", "findings": [{**linked, "worker": "both"}]}, bundle, digest, allow_legacy=True)
        open_p1 = {**unlinked, "disposition": "open"}
        with self.assertRaisesRegex(ValueError, "Unresolved blocking"):
            check_review({**base, "verdict": "approved", "findings": [open_p1]}, bundle, digest)
        with self.assertRaisesRegex(ValueError, "not approved"):
            check_review({**base, "verdict": "blocked", "findings": [open_p1]}, bundle, digest)
        check_review({**base, "verdict": "blocked", "findings": [open_p1]}, bundle, digest, require_approved=False)
        # Export-time validation still enforces identity, shape and the approved/blocking rule.
        with self.assertRaisesRegex(ValueError, "Unresolved blocking"):
            check_review({**base, "verdict": "approved", "findings": [open_p1]}, bundle, digest, require_approved=False)
        with self.assertRaisesRegex(ValueError, "Independent"):
            check_review({**base, "reviewer": "ui-session", "verdict": "blocked", "findings": []}, bundle, digest, require_approved=False)
        with self.assertRaisesRegex(ValueError, "verdict"):
            check_review({**base, "verdict": "maybe", "findings": []}, bundle, digest, require_approved=False)
        with self.assertRaisesRegex(ValueError, "exact run"):
            check_review({**base, "candidate_commit": "d" * 40, "verdict": "blocked", "findings": []}, bundle, digest, require_approved=False)
        # The combined record of declared reviewers lists them in declared order; every finding names one of them.
        entries = [{"reviewer_id": "general", "session_id": "general-session", "verdict": "approved", "accepted_at": "2026-09-22T10:00:00Z"},
                   {"reviewer_id": "coverage", "session_id": "coverage-session", "verdict": "approved", "accepted_at": "2026-09-22T10:01:00Z"}]
        tagged = [{**linked, "reviewer": "general"}, {**unlinked, "reviewer": "coverage"}]
        combined = {**base, "reviewer": "general-session, coverage-session", "verdict": "approved", "findings": tagged, "reviewers": entries}
        check_review(combined, bundle, digest, reviewers=["general", "coverage"])
        check_review(combined, bundle, digest)  # Export: no declared list to match.
        with self.assertRaisesRegex(ValueError, "declared reviewers"):
            check_review(combined, bundle, digest, reviewers=["coverage", "general"])
        with self.assertRaisesRegex(ValueError, "lacks the reviewers list"):
            check_review({**base, "verdict": "approved", "findings": []}, bundle, digest, reviewers=["general", "coverage"])
        check_review({**base, "verdict": "approved", "findings": [plain]}, bundle, digest, reviewers=["review"])  # The default reviewer's legacy shape.
        with self.assertRaisesRegex(ValueError, "names reviewer 'security'"):
            check_review({**combined, "findings": [{**linked, "reviewer": "security"}]}, bundle, digest)
        with self.assertRaisesRegex(ValueError, "names reviewer None"):
            check_review({**combined, "findings": [linked]}, bundle, digest)
        with self.assertRaisesRegex(ValueError, "every reviewer's approval"):
            check_review({**combined, "reviewers": [entries[0], {**entries[1], "verdict": "blocked"}]}, bundle, digest, require_approved=False)
        with self.assertRaisesRegex(ValueError, "not approved"):
            check_review({**combined, "verdict": "blocked", "reviewers": [entries[0], {**entries[1], "verdict": None, "accepted_at": None}]}, bundle, digest)
        check_review({**combined, "verdict": "blocked", "reviewers": [entries[0], {**entries[1], "verdict": None, "accepted_at": None}]}, bundle, digest, require_approved=False)
        for bad_entries in ([], [entries[0], entries[0]], [entries[0], {**entries[1], "session_id": "general-session"}],
                            [entries[0], {**entries[1], "session_id": "ui-session"}], [{**entries[0], "verdict": "maybe"}], [{**entries[0], "extra": 1}]):
            with self.assertRaises(ValueError):
                check_review({**combined, "reviewers": bad_entries, "findings": []}, bundle, digest, require_approved=False)

    def native_rows(self):
        return {node: {"id": f"id-{node}", "sessionId": f"session-{node}", "pid": 90000 + index}
                for index, node in enumerate(("ui", "adapter", "review"))}

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

    def test_native_reviewer_stop_rechecks_identity_and_records_intent(self):
        live = self.native_rows()
        self.set_native(live)
        def stop(argv, **_kwargs):
            live.pop(argv[-1].removeprefix("id-"))
            return subprocess.CompletedProcess(argv, 0)
        with patch("workflow.pipeline.subprocess.run", side_effect=stop) as command, patch("workflow.pipeline.pid_alive", return_value=False):
            Pipeline.stop_reviewer(self.runtime)
            self.assertEqual(command.call_args.args[0], ["claude", "stop", "id-review"])
            Pipeline.stop_reviewer(self.runtime)  # Completed intent: no second stop command.
            self.assertEqual(command.call_count, 1)
        intent = read_json(self.directory / "review.stop.json")
        self.assertEqual((intent["session_id"], intent["stopped"]), ("session-review", True))
        self.assertTrue(all(row["sessionId"] != "session-review" for row in live.values()))
        self.assertFalse((self.directory / "ui.stop.json").exists())
        events = [json.loads(line) for line in (self.directory / "events.jsonl").read_text().splitlines()]
        self.assertEqual([event["status"] for event in events if event["node"] == "review"], ["stopped", "stopped"])
        # A reviewer whose identity changed after the stop intent (another background id for its session UUID) is never signalled.
        (self.directory / "review.stop.json").unlink()
        live["review"] = self.native_rows()["review"]
        save_json(self.directory / "review.stop.json", {"background_id": "id-other", "session_id": "session-review", "pid": live["review"]["pid"], "stopped": False})
        with patch("workflow.pipeline.subprocess.run") as command:
            with self.assertRaisesRegex(RuntimeError, "identity changed"):
                Pipeline.stop_reviewer(self.runtime)
            command.assert_not_called()

    def test_a_stop_follows_a_session_an_update_respawned_under_a_new_pid(self):
        # The first `claude stop` failed while an update restarted the background service, which then respawned the idle session
        # onto the new binary: same background id and session UUID, a new PID. The retry stops that process, once, instead of
        # refusing the recorded stop forever as a changed identity.
        live = self.native_rows()
        self.set_native(live)
        respawned = live["ui"]["pid"] + 7
        save_json(self.directory / "ui.stop.json", {"background_id": "id-ui", "session_id": "session-ui", "pid": live["ui"]["pid"], "stopped": False})
        live["ui"] = {**live["ui"], "pid": respawned}
        def stop(argv, **_kwargs):
            live.pop(argv[-1].removeprefix("id-"))
            return subprocess.CompletedProcess(argv, 0)
        with patch("workflow.pipeline.subprocess.run", side_effect=stop) as command, patch("workflow.pipeline.pid_alive", return_value=False) as alive:
            self.runtime.stop_session("ui")
        self.assertEqual([item.args[0] for item in command.call_args_list], [["claude", "stop", "id-ui"]])
        alive.assert_called_once_with(respawned)  # Termination is established for the process that was stopped.
        self.assertEqual(read_json(self.directory / "ui.stop.json"),
                         {"background_id": "id-ui", "session_id": "session-ui", "pid": respawned, "stopped": True, "issued": True})

    def test_a_stop_waits_out_an_update_respawn_gap_of_a_bound_session(self):
        # Every lane is idle at the freeze, which is what an update respawns: the listing omits the session, then lists its
        # ended PID, then the new one. The stop waits that out as the controller's waits do, records its intent from the live
        # row and stops that process; a recorded stop resumed in such a gap follows the new PID the same way. A gap that
        # outlasts the grace is Claude Code unavailable (resumable): nothing is recorded and nothing is stopped.
        from .interactive import DEAD_PID_GRACE_SECONDS
        from .sessions import TransientInfraError
        ended = subprocess.Popen(["sleep", "60"])
        ended.kill()
        ended.wait()
        save_json(self.directory / "ui.interactive.json", {"background_id": "id-ui", "session_id": "session-ui"})
        row = {**self.native_rows()["ui"], "pid": os.getpid()}
        clock = SimpleNamespace(now=0.0, listings=iter(()))
        self.runtime.sessions = SimpleNamespace(executable="claude", inventory=lambda: next(clock.listings),
                                               locate=lambda node, rows: next((item for item in rows if item["id"] == f"id-{node}"), None))
        def stop(listings, intent=None):
            clock.listings = iter(listings)
            if intent:
                save_json(self.directory / "ui.stop.json", intent)
            with patch("workflow.pipeline.time") as fake_time, patch("workflow.pipeline.subprocess.run", return_value=subprocess.CompletedProcess([], 0)) as command, \
                    patch("workflow.pipeline.pid_alive", return_value=False):
                fake_time.monotonic.side_effect = lambda: clock.now
                fake_time.sleep.side_effect = lambda seconds: setattr(clock, "now", clock.now + seconds)
                try:
                    self.runtime.stop_session("ui")
                finally:
                    self.commands, self.sleeps = [item.args[0] for item in command.call_args_list], fake_time.sleep.call_count
        stop([[], [{**row, "pid": ended.pid}], [row], [row], []])
        self.assertEqual((self.commands, self.sleeps), ([["claude", "stop", "id-ui"]], 2))
        self.assertEqual(read_json(self.directory / "ui.stop.json"), {"background_id": "id-ui", "session_id": "session-ui", "pid": os.getpid(), "stopped": True,
                                                                     "issued": True})
        stop([[{**row, "pid": ended.pid}], [row], []], intent={"background_id": "id-ui", "session_id": "session-ui", "pid": ended.pid, "stopped": False})
        self.assertEqual((self.commands, self.sleeps), ([["claude", "stop", "id-ui"]], 1))
        self.assertEqual(read_json(self.directory / "ui.stop.json")["pid"], os.getpid())
        (self.directory / "ui.stop.json").unlink()
        with self.assertRaisesRegex(TransientInfraError, f"Claude Code has not listed a live ui session \\(id-ui\\) for {DEAD_PID_GRACE_SECONDS}s"):
            stop([[]] * 20)
        self.assertEqual((self.commands, self.sleeps), ([], DEAD_PID_GRACE_SECONDS // 2))
        self.assertFalse((self.directory / "ui.stop.json").exists())

    def test_a_stop_never_issued_is_issued_to_the_session_an_update_respawned(self):
        # An outage right after the freeze recorded ui's stop intent, before `claude stop` ran. The restarted service respawns the
        # idle lane under a new PID, and the resumed stop lists it in that gap: left out, then listed anew. Left out of the
        # listing means stopped only for a stop that was issued; this one is looked up through the gap and issued once, and
        # `stopped` is recorded only after it. Used to: no stop, `stopped: true`, then "A stopped worker was restarted".
        import contextlib
        from unittest.mock import Mock
        from .sessions import TransientInfraError
        ended = subprocess.Popen(["sleep", "60"])
        ended.kill()
        ended.wait()
        save_json(self.directory / "ui.interactive.json", {"background_id": "id-ui", "session_id": "session-ui"})
        respawned = {**self.native_rows()["ui"], "pid": os.getpid()}
        marker = self.directory / "ui.stop.json"
        intent = {"background_id": "id-ui", "session_id": "session-ui", "pid": ended.pid, "stopped": False, "issued": False}
        fake = SimpleNamespace(listings=iter(()), during=[])
        self.runtime.sessions = SimpleNamespace(executable="claude", inventory=lambda: next(fake.listings),
                                               locate=lambda node, rows: next((item for item in rows if item["id"] == f"id-{node}"), None))
        def stop(argv, **_kwargs):
            fake.during.append(read_json(marker))  # What the marker says while `claude stop` runs.
            return subprocess.CompletedProcess(argv, 0)
        def run(listings, saved=None, run_claude=None):
            fake.listings = iter(listings)
            if saved:
                save_json(marker, saved)
            with patch("workflow.pipeline.time") as fake_time, patch("workflow.pipeline.subprocess.run", side_effect=stop) as command, \
                    patch("workflow.pipeline.pid_alive", return_value=False), \
                    patch("workflow.pipeline.run_claude", run_claude) if run_claude else contextlib.nullcontext():
                fake_time.monotonic.return_value = 0.0
                try:
                    self.runtime.stop_session("ui")
                finally:
                    self.commands = [item.args[0] for item in command.call_args_list]
        run([[], [respawned], []], intent)
        self.assertEqual(self.commands, [["claude", "stop", "id-ui"]])
        self.assertEqual(fake.during, [{**intent, "pid": os.getpid(), "issued": True}])
        self.assertEqual(read_json(marker), {**intent, "pid": os.getpid(), "issued": True, "stopped": True})
        # An issued stop (or one recorded before `issued` existed) whose session the listing leaves out is confirmed, not issued again.
        for saved in ({**intent, "issued": True}, {key: value for key, value in intent.items() if key != "issued"}):
            run([[], []], saved)
            self.assertEqual((self.commands, read_json(marker)["stopped"]), ([], True))
        # A new stop records its intent unissued; a `claude stop` whose exec failed for the whole grace ran nothing and stays unissued.
        marker.unlink()
        with self.assertRaises(TransientInfraError):
            run([[respawned], [respawned]], run_claude=Mock(side_effect=TransientInfraError("Claude Code unavailable for 60s")))
        self.assertEqual(read_json(marker), {**intent, "pid": os.getpid()})

    def test_a_stop_that_exited_non_zero_is_issued_again_to_the_session_an_update_respawned(self):
        # `claude stop` ran and exited non-zero while an update restarted the background service, which then respawned the idle
        # session under a new PID. The retry in that gap found the session left out of the listing and the old PID ended, and
        # recorded `stopped: true` with no stop issued: the respawned session kept running. A stop that failed is still owed:
        # the retry looks through the gap, records nothing while it lasts, and stops the respawned process once.
        from .sessions import TransientInfraError
        old = subprocess.Popen(["sleep", "60"])
        self.addCleanup(old.wait)
        self.addCleanup(old.kill)
        save_json(self.directory / "ui.interactive.json", {"background_id": "id-ui", "session_id": "session-ui"})
        row = {**self.native_rows()["ui"], "pid": old.pid}
        respawned = {**row, "pid": os.getpid()}
        marker = self.directory / "ui.stop.json"
        fake = SimpleNamespace(now=0.0, listings=iter(()), codes=iter(()))
        self.runtime.sessions = SimpleNamespace(executable="claude", inventory=lambda: next(fake.listings),
                                               locate=lambda node, rows: next((item for item in rows if item["id"] == f"id-{node}"), None))
        def run(listings, codes):
            fake.listings, fake.codes = iter(listings), iter(codes)
            with patch("workflow.pipeline.time") as fake_time, patch("workflow.pipeline.pid_alive", return_value=False), \
                    patch("workflow.pipeline.subprocess.run", side_effect=lambda argv, **_: subprocess.CompletedProcess(argv, next(fake.codes))) as command:
                fake_time.monotonic.side_effect = lambda: fake.now
                fake_time.sleep.side_effect = lambda seconds: setattr(fake, "now", fake.now + seconds)
                try:
                    self.runtime.stop_session("ui")
                finally:
                    self.commands = [item.args[0] for item in command.call_args_list]
        with self.assertRaisesRegex(RuntimeError, "Stop failed for ui"):
            run([[row], [row]], [1])
        self.assertEqual(self.commands, [["claude", "stop", "id-ui"]])
        self.assertEqual(read_json(marker), {"background_id": "id-ui", "session_id": "session-ui", "pid": old.pid, "stopped": False, "issued": False})
        old.kill()
        old.wait()  # The restart ended the process the failed stop was for.
        with self.assertRaises(TransientInfraError):
            run([[]] * 20, [])
        self.assertEqual((self.commands, read_json(marker)["stopped"]), ([], False))
        run([[], [respawned], []], [0])
        self.assertEqual(self.commands, [["claude", "stop", "id-ui"]])
        self.assertEqual(read_json(marker), {"background_id": "id-ui", "session_id": "session-ui", "pid": os.getpid(), "stopped": True, "issued": True})

    def test_stop_workers_stops_every_lane_and_names_each_stop_it_could_not_confirm(self):
        # A blocked wait stops the workers, and the lane that blocked it (a `stopped` or `failed` row, a changed identity) is
        # usually one whose stop is refused. The lanes after it used to keep running, and using quota, after the run was blocked.
        from .sessions import TransientInfraError
        live, refusals = {}, {}
        def locate(node, rows):
            if node in refusals:
                raise refusals[node]
            return next((row for row in rows if row["id"] == f"id-{node}"), None)
        self.runtime.sessions = SimpleNamespace(executable="claude", inventory=lambda: list(live.values()), locate=locate)
        def stop(argv, **_kwargs):
            live.pop(argv[-1].removeprefix("id-"))
            return subprocess.CompletedProcess(argv, 0)
        def run(refused):
            live.clear()
            live.update(self.native_rows())
            refusals.clear()
            refusals.update(refused)
            for node in ("ui", "adapter"):
                (self.directory / f"{node}.stop.json").unlink(missing_ok=True)
            with patch("workflow.pipeline.subprocess.run", side_effect=stop) as command, patch("workflow.pipeline.pid_alive", return_value=False):
                try:
                    Pipeline.stop_workers(self.runtime)
                finally:
                    self.commands = [item.args[0] for item in command.call_args_list]
        with self.assertRaisesRegex(RuntimeError, r"^ui: Native Claude UUID changed; refusing attachment$") as raised:
            run({"ui": RuntimeError("Native Claude UUID changed; refusing attachment")})
        self.assertNotIsInstance(raised.exception, TransientInfraError)
        self.assertEqual(self.commands, [["claude", "stop", "id-adapter"]])
        self.assertFalse((self.directory / "ui.stop.json").exists())
        self.assertTrue(read_json(self.directory / "adapter.stop.json")["stopped"])
        self.assertFalse((self.directory / "events.jsonl").exists())  # No "Native workers stopped": one was not.
        # Claude Code unavailable for every failing lane keeps a freeze resumable; any other refusal decides the run.
        unavailable = TransientInfraError("Claude session inventory unavailable for 60s: `claude agents --json` exited 1")
        with self.assertRaisesRegex(TransientInfraError, r"^ui: Claude session inventory unavailable"):
            run({"ui": unavailable})
        self.assertEqual(self.commands, [["claude", "stop", "id-adapter"]])
        with self.assertRaisesRegex(RuntimeError, r"^ui: Session is not attachable: 'stopped'; reconcile manually; adapter: Claude session") as raised:
            run({"ui": RuntimeError("Session is not attachable: 'stopped'; reconcile manually"), "adapter": unavailable})
        self.assertNotIsInstance(raised.exception, TransientInfraError)
        self.assertEqual(self.commands, [])

    def test_launch_reviewer_pane_is_best_effort_and_launch_failure_is_recorded(self):
        receipt = {"session_id": "33333333-3333-4333-8333-333333333333", "background_id": "33333333", "status": "attached_session_available"}
        launches = []
        def run_reviewer(reviewer_id, prompt, launch_token, candidate_commit):
            launches.append((reviewer_id, prompt, launch_token, candidate_commit))
            return dict(receipt)
        self.runtime.sessions = SimpleNamespace(run_reviewer=run_reviewer)
        def review_events():
            return [(event["status"], event["message"]) for event in
                    (json.loads(line) for line in (self.directory / "events.jsonl").read_text().splitlines()) if event["node"] == "review"]
        # No terminals.json: nothing to attach to, no attach attempted.
        with patch.dict(os.environ, {"HERDR_ENV": "1"}), patch("workflow.pipeline.attach_reviewer_panel") as attach:
            self.assertEqual(self.runtime.launch_reviewer("review", "prompt", "token", "c" * 40), receipt)
        attach.assert_not_called()
        self.assertEqual([status for status, _ in review_events()], ["running", "interactive"])
        self.assertIn("33333333-3333-4333-8333-333333333333", review_events()[-1][1])
        self.assertIn("awaiting review.completion.json", review_events()[-1][1])
        # The tab exists but the pane cannot be attached: the launch still succeeds, the reason is on the timeline.
        save_json(self.directory / "terminals.json", {"ui": {"pane_id": "w1:p2"}, "adapter": {"pane_id": "w1:p3"}})
        with patch.dict(os.environ, {"HERDR_ENV": "1"}), patch("workflow.pipeline.attach_reviewer_panel", side_effect=RuntimeError("Pane w1:p3 is occupied")) as attach:
            self.assertEqual(self.runtime.launch_reviewer("coverage", "prompt", "token", "c" * 40), receipt)
        attach.assert_called_once_with(self.runtime.sessions)
        self.assertIn(("running", "Reviewer coverage pane not attached: Pane w1:p3 is occupied"), review_events())
        self.assertIn("awaiting review-coverage.completion.json", review_events()[-2][1])
        # Ctrl-C during the attach: the session was launched; the interruption is recorded and propagated as such.
        with patch.dict(os.environ, {"HERDR_ENV": "1"}), patch("workflow.pipeline.attach_reviewer_panel", side_effect=KeyboardInterrupt):
            with self.assertRaises(KeyboardInterrupt):
                self.runtime.launch_reviewer("review", "prompt", "token", "c" * 40)
        self.assertIn(("running", "Reviewer review pane not attached: KeyboardInterrupt"), review_events())
        # Outside a managed Herdr pane no attach is attempted even with the tab mapping present.
        with patch.dict(os.environ, {"HERDR_ENV": "0"}), patch("workflow.pipeline.attach_reviewer_panel") as attach:
            self.runtime.launch_reviewer("review", "prompt", "token", "c" * 40)
        attach.assert_not_called()
        self.assertEqual(len(launches), 4)
        self.assertEqual([launch[0] for launch in launches], ["review", "coverage", "review", "review"])
        # A launch that fails is a blocked review event; the pane is never touched.
        self.runtime.sessions = SimpleNamespace(run_reviewer=lambda *args: (_ for _ in ()).throw(RuntimeError("Claude background launch exited 1; inspect launch log")))
        with patch.dict(os.environ, {"HERDR_ENV": "1"}), patch("workflow.pipeline.attach_reviewer_panel") as attach:
            with self.assertRaisesRegex(RuntimeError, "exited 1"):
                self.runtime.launch_reviewer("general", "prompt", "token", "c" * 40)
        attach.assert_not_called()
        self.assertEqual(review_events()[-1], ("blocked", "Reviewer general: Claude background launch exited 1; inspect launch log"))

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
