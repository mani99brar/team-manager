"""Offline end-to-end graph tests: fake workers, real Git/unit/browser checks."""
import contextlib
import copy
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from langgraph.checkpoint.sqlite import SqliteSaver
from langgraph.types import Command

from .actor import OPERATOR_ONLY
from .automatic import automatic_settings
from .checks import execute, now
from .costs import record_session_cost
from .guardrails import completion_version
from .pipeline import Pipeline, build_pipeline, check_review, digest_file, report, validate_pipeline_policy
from .sessions import git, plan_workers, prepare, read_json, review_node, reviewer_ids, run_lock, save_json
from .verification import CONTRACTS, policy_digest

# What each fake lane writes into its worktree: the two classic lanes edit fixture files the checks read;
# any other lane creates a file under a directory named after it.
LANE_EDITS = {"ui": ("ui.txt", "after"), "adapter": ("backend.py", "VALUE = 2\n")}


CLAUDE_VERSION_STUB = "2.1.288 (Claude Code)"


def isolate_registry() -> None:
    """setUpModule of every test module whose runs can record attention (an integration, a paused design challenge, the
    automatic controller's waits): until the module's last test, MD_MANAGER_PROJECTS_CONFIG names a registry in a
    temporary directory, so attention.jsonl never lands beside the operator's registry. Child processes inherit it, and
    a test that sets the variable itself still wins. CLAUDECODE is emptied too: run from a Claude Code session the event texts
    would name it (actor.actor_text), and the tests that expect the marker set it themselves. CLAUDE_CONFIG_DIR names an empty
    directory there as well, so a confirmed stop's cost record (costs.record_session_cost) never reads the operator's
    transcripts."""
    temp = tempfile.TemporaryDirectory()
    environment = patch.dict(os.environ, {"MD_MANAGER_PROJECTS_CONFIG": str(Path(temp.name) / "config" / "projects.json"), "CLAUDECODE": "",
                                          "CLAUDE_CONFIG_DIR": str(Path(temp.name) / "claude")})
    environment.start()
    unittest.addModuleCleanup(temp.cleanup)
    unittest.addModuleCleanup(environment.stop)


def stub_claude_cli() -> None:
    """setUpModule of every test module that prepares a run: until the module's last test, a stand-in `claude` comes first on
    PATH, so prepare's `claude --version` (sessions.controller_record) never runs the operator's CLI, in process or in a
    child. It answers --version with CLAUDE_VERSION_STUB and fails anything else; a test that sets PATH itself still wins.
    The model and effort overrides the sessions never see (scrub_env) are unset too, so an operator's shell that sets
    ANTHROPIC_MODEL adds no override note (override_note) to what prepare or a dry run prints."""
    from .sessions import scrub_env
    temp = tempfile.TemporaryDirectory()
    stub = Path(temp.name) / "claude"
    stub.write_text(f"#!/bin/sh\n[ \"$1\" = --version ] || exit 2\necho '{CLAUDE_VERSION_STUB}'\n")
    stub.chmod(0o755)
    environment = patch.dict(os.environ, {"PATH": f"{temp.name}{os.pathsep}{os.environ.get('PATH', '')}"})
    environment.start()
    for key in set(os.environ) - set(scrub_env(os.environ)):  # Restored with the rest of the environment.
        del os.environ[key]
    unittest.addModuleCleanup(temp.cleanup)
    unittest.addModuleCleanup(environment.stop)


def setUpModule():
    isolate_registry()
    stub_claude_cli()


GATES = frozenset({"start", "automatic", "retry", "reconcile", "approve"})


def by_operator(argv: list, gate: bool | None = None) -> list:
    """`argv` with `--by operator` when it runs a gate action (C17) and names no actor itself: the pipeline's own gates by
    their action word, `gate=True` for resume, answer, repair and note. The tests of the actor rule name theirs."""
    argv = list(argv)
    if "--by" in argv or not (gate if gate is not None else bool(argv) and argv[0] in GATES):
        return argv
    return [*argv, "--by", "operator"]


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
        self.repair_edits = {}             # Per-lane {path: content} a fake repair session writes in its workspace (None deletes; a callable gets the node).
        self.repair_status = "completed"   # The fake repair session's completion status, or None to write no completion file.
        self.repair_state = "idle"         # The native state the registry lists for a repair session.
        self.repair_prompts = {}           # The prompt each repair session was launched with.

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
        if node.startswith("repair-"):
            return f"{int(node[len('repair-'):]):08d}-4444-4444-8444-444444444444"
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

    def run_repair(self, node, prompt, launch_token, cwd, launched_at, extra):
        """A repair session: writes repair_edits[lane] in its workspace, then its completion file (repair_status)."""
        path = self.directory / f"{node}.interactive.json"
        if path.exists():
            return self.reconcile(node, path, read_json(path))
        self.record(node)
        self.repair_prompts[node] = prompt
        receipt = {"node_id": node, "session_id": self.native_id(node), "launch_token": launch_token, "background_id": self.background_id(node),
                   "worktree": str(cwd), "base_commit": self.plan["base_commit"], "workspace_commit": git(Path(cwd), "rev-parse", "HEAD"),
                   "status": "attached_session_available", "attempt": 1, "launcher_invocations": 1, "launch_requested_at": launched_at,
                   "observed_state": "idle", "native_started_at": None, **extra}
        save_json(path, receipt)
        (self.directory / f"{node}.prompt.txt").write_text(prompt)
        for name, content in self.repair_edits.get(extra["lane"], {}).items():
            target = Path(cwd) / name
            if content is None:
                target.unlink()
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(content(node) if callable(content) else content)
        if self.repair_status:
            completion = {"version": completion_version(self.plan), "run_id": self.plan["run_id"], "node_id": node, "launch_token": launch_token,
                          "status": self.repair_status, "summary": f"Synthetic repair ({self.repair_status})", "open_assumptions": []}
            if completion["version"] == "1.1.0":
                done = self.repair_status == "completed"
                completion.update(untested=[], falsifying_check="unit" if done else None, verify_yourself="the fix" if done else None, question=None)
            save_json(self.directory / f"{node}.completion.json", completion)
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
        repairs = sorted(path.name.removesuffix(".interactive.json") for path in self.directory.glob("repair-*.interactive.json"))
        for node in (*self.workers, *self.reviewer_nodes(), *repairs):
            if (self.directory / f"{node}.interactive.json").exists():
                if node.startswith("repair-"):
                    if not (self.directory / f"{node}.stop.json").exists():
                        rows.append({"id": self.background_id(node), "sessionId": self.native_id(node), "state": self.repair_state,
                                     "pid": os.getpid(), "kind": "background"})
                    continue
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

    def stop_repair(self, node):
        # A fake repair session has no process either: the stop intent the real path persists, confirmed.
        receipt = read_json(self.directory / f"{node}.interactive.json")
        save_json(self.directory / f"{node}.stop.json", {"background_id": receipt["background_id"], "session_id": receipt["session_id"],
                                                         "pid": None, "stopped": True, "synthetic": True})

    def stop_reviewer(self, reviewer_id="review"):
        # Fake sessions have no process to stop; record the intent the real path would persist.
        node = review_node(reviewer_id)
        receipt = read_json(self.directory / f"{node}.interactive.json")
        save_json(self.directory / f"{node}.stop.json", {"background_id": receipt["background_id"], "session_id": receipt["session_id"],
                                                         "pid": None, "stopped": True, "synthetic": True})
        # And its cost record, as the real stop writes it for a session without a transcript (C49): all null.
        record_session_cost(self.directory, node, receipt["session_id"], root=self.directory / "no-transcripts")
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
            self.assertEqual(exported["version"], "1.9.0")
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
        # The drill fails an attempt whose checks passed: it is kept whole, as a failed attempt is (C47); ui's is pruned.
        self.assertTrue((self.directory / "verification/worker/adapter/1/worktree").is_dir())
        self.assertFalse((self.directory / "verification/worker/ui/1/worktree").exists())
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

    def test_a_confirmed_stop_records_the_session_cost_from_its_transcript(self):
        # C49: the transcript's last cost-state row per startTime, summed; a session without a transcript records null, and a
        # cost that cannot be written never fails the stop.
        live = self.native_rows()
        self.set_native(live)
        projects = self.directory / "transcripts"
        (projects / "worktree-ui").mkdir(parents=True)
        rows = [{"type": "cost-state", "totalCostUSD": cost, "totalDuration": 1000, "startTime": start, "modelUsage": {"claude-opus-5-5": {}}}
                for start, cost in ((1, 0.5), (1, 2.0), (2, 1.0))]
        (projects / "worktree-ui" / "session-ui.jsonl").write_text("".join(json.dumps(row) + "\n" for row in rows))
        def stop(argv, **_kwargs):
            live.pop(argv[-1].removeprefix("id-"))
            return subprocess.CompletedProcess(argv, 0)
        with patch("workflow.pipeline.subprocess.run", side_effect=stop), patch("workflow.pipeline.pid_alive", return_value=False), \
                patch("workflow.costs.transcripts_root", return_value=projects):
            Pipeline.stop_workers(self.runtime)
        cost = read_json(self.directory / "ui.cost.json")
        self.assertEqual((cost["session_id"], cost["cost_usd"], cost["duration_ms"], cost["models"]), ("session-ui", 3.0, 2000, ["claude-opus-5-5"]))
        self.assertEqual({key: read_json(self.directory / "adapter.cost.json")[key] for key in ("session_id", "cost_usd", "duration_ms", "models")},
                         {"session_id": "session-adapter", "cost_usd": None, "duration_ms": None, "models": None})
        (self.directory / "ui.cost.json").unlink()
        with patch("workflow.costs.save_json", side_effect=OSError("disk full")), patch("workflow.costs.transcripts_root", return_value=projects), \
                contextlib.redirect_stderr(io.StringIO()) as errors:
            self.runtime.stop_session("ui")  # A stopped intent without its cost record: recorded now, and a failure only warns.
        self.assertIn("ui.cost.json not written: disk full", errors.getvalue())
        with patch("workflow.costs.session_cost", side_effect=TypeError("unhashable type: 'dict'")), \
                contextlib.redirect_stderr(io.StringIO()) as errors:
            self.runtime.stop_session("ui")  # Any failure of the record, not only I/O, leaves the confirmed stop standing.
        self.assertIn("ui.cost.json not written: unhashable type", errors.getvalue())
        self.assertTrue(read_json(self.directory / "ui.stop.json")["stopped"])

    def test_stopping_a_fake_session_never_reads_the_operators_transcripts(self):
        # isolate_registry points CLAUDE_CONFIG_DIR at a temporary directory: every stop records its cost from there.
        from .costs import transcripts_root
        self.assertNotEqual(transcripts_root(), Path.home() / ".claude" / "projects")
        self.assertTrue(str(transcripts_root()).startswith(tempfile.gettempdir()))

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

    def test_a_stop_that_failed_is_issued_again_to_the_session_an_update_respawned(self):
        # `claude stop` exited non-zero, hung past its timeout (as `claude` calls can while the background service restarts) or
        # could not be executed while an update restarted the service, which then respawned the idle session under a new PID.
        # The retry in that gap found the session left out of the listing and the old PID ended, and recorded `stopped: true`
        # with no stop issued: the respawned session kept running. A stop that failed is still owed: the retry looks through
        # the gap, records nothing while it lasts, and stops the respawned process once.
        import errno
        from .sessions import TransientInfraError
        save_json(self.directory / "ui.interactive.json", {"background_id": "id-ui", "session_id": "session-ui"})
        marker = self.directory / "ui.stop.json"
        fake = SimpleNamespace(now=0.0, listings=iter(()), answers=iter(()))
        self.runtime.sessions = SimpleNamespace(executable="claude", inventory=lambda: next(fake.listings),
                                               locate=lambda node, rows: next((item for item in rows if item["id"] == f"id-{node}"), None))
        def answer(argv, **_kwargs):
            result = next(fake.answers)
            if isinstance(result, BaseException):
                raise result
            return subprocess.CompletedProcess(argv, result)
        def run(listings, answers):
            fake.listings, fake.answers = iter(listings), iter(answers)
            with patch("workflow.pipeline.time") as fake_time, patch("workflow.pipeline.pid_alive", return_value=False), \
                    patch("workflow.pipeline.subprocess.run", side_effect=answer) as command:
                fake_time.monotonic.side_effect = lambda: fake.now
                fake_time.sleep.side_effect = lambda seconds: setattr(fake, "now", fake.now + seconds)
                try:
                    self.runtime.stop_session("ui")
                finally:
                    self.commands = [item.args[0] for item in command.call_args_list]
        failures = {"exited non-zero": (1, RuntimeError, "^Stop failed for ui"),
                    "timed out": (subprocess.TimeoutExpired(["claude", "stop", "id-ui"], 20), subprocess.TimeoutExpired, "timed out after 20 seconds"),
                    "could not be executed": (OSError(errno.EACCES, "Permission denied"), PermissionError, "Permission denied")}
        for failure, (refusal, error, message) in failures.items():
            with self.subTest(failure):
                marker.unlink(missing_ok=True)
                old = subprocess.Popen(["sleep", "60"])
                self.addCleanup(old.wait)
                self.addCleanup(old.kill)
                row = {**self.native_rows()["ui"], "pid": old.pid}
                respawned = {**row, "pid": os.getpid()}
                with self.assertRaisesRegex(error, message):
                    run([[row], [row]], [refusal])
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
        # A Ctrl-C while `claude stop` runs leaves it issued, as a controller killed then does: the stop may have been sent.
        marker.unlink()
        with self.assertRaises(KeyboardInterrupt):
            run([[respawned], [respawned]], [KeyboardInterrupt()])
        self.assertEqual(read_json(marker), {"background_id": "id-ui", "session_id": "session-ui", "pid": os.getpid(), "stopped": False, "issued": True})

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
        with patch("workflow.pipeline.subprocess.run", return_value=subprocess.CompletedProcess([], 0)), patch("workflow.pipeline.pid_alive", return_value=True), \
                patch("workflow.pipeline.STOP_TERMINATION_GRACE_SECONDS", 0):
            with self.assertRaisesRegex(RuntimeError, "termination"):
                Pipeline.stop_workers(self.runtime)

    def test_a_process_that_exits_within_the_grace_is_not_a_failed_stop(self):
        # `claude stop` returns while the process is still exiting: the first look sees the PID, the next does not.
        live = self.native_rows()
        self.set_native(live)
        looks = iter([True, True, False] + [False] * 20)

        def stop(argv, **_kwargs):  # The listing drops the session at once; only the process lingers.
            live.pop(argv[-1].removeprefix("id-"), None)
            return subprocess.CompletedProcess([], 0)
        with patch("workflow.pipeline.subprocess.run", side_effect=stop), \
                patch("workflow.pipeline.pid_alive", side_effect=lambda pid: next(looks)), patch("workflow.pipeline.time.sleep") as nap:
            Pipeline.stop_workers(self.runtime)
        self.assertGreaterEqual(nap.call_count, 1)
        self.assertTrue(read_json(self.directory / "ui.stop.json")["stopped"])

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

    def test_freeze_records_non_ascii_and_quoted_names_as_written(self):
        # Git quotes these names in diff-tree output unless -z ("docs/caf\303\251.md"; a double quote even with
        # core.quotepath=false), and freeze then refused a snapshot that matched the worktree.
        self.policy["workers"][0]["owned_paths"].append("docs")
        self.plan["policy_sha256"] = policy_digest(self.policy)
        save_json(self.directory / "policy.json", self.policy)
        save_json(self.directory / "plan.json", self.plan)
        self.runtime = OfflinePipeline(self.directory, self.sessions)
        self.sessions.run("ui"); self.sessions.run("adapter")
        worktree = Path(self.plan["nodes"]["ui"]["worktree"])
        names = ["docs/café.md", 'docs/say "hi".md']
        (worktree / "docs").mkdir()
        for name in names:
            (worktree / name).write_text(f"# {name}\n")
        snapshots = self.runtime.freeze()
        self.assertEqual(snapshots["ui"]["changed_files"], sorted(["ui.txt", *names]))
        tree = subprocess.check_output(["git", "-C", str(self.repo), "ls-tree", "-r", "-z", "--name-only", snapshots["ui"]["commit"]]).decode()
        self.assertLessEqual(set(names), set(tree.split("\0")))

    def test_freeze_keeps_a_gitignored_file_the_lane_tracks(self):
        # A `--restore-from` run restores a file that a repository-wide ignore rule (`.env*`) matches, and stages it. `git add -A` in
        # the private snapshot index skips it, so changed_files and the captured tree disagreed and freeze refused the run.
        self.policy["workers"][0]["owned_paths"].append("docs")
        self.plan["policy_sha256"] = policy_digest(self.policy)
        save_json(self.directory / "policy.json", self.policy)
        save_json(self.directory / "plan.json", self.plan)
        self.runtime = OfflinePipeline(self.directory, self.sessions)
        self.sessions.run("ui"); self.sessions.run("adapter")
        worktree = Path(self.plan["nodes"]["ui"]["worktree"])
        exclude = Path(subprocess.check_output(["git", "-C", str(worktree), "rev-parse", "--path-format=absolute", "--git-path", "info/exclude"], text=True).strip())
        exclude.parent.mkdir(parents=True, exist_ok=True)
        with exclude.open("a") as handle:
            handle.write("docs/*.example\n")
        (worktree / "docs").mkdir()
        (worktree / "docs" / "app.example").write_text("KEY=\n")
        (worktree / "docs" / "other.example").write_text("untracked and ignored\n")
        subprocess.run(["git", "-C", str(worktree), "add", "-f", "docs/app.example"], check=True)
        snapshots = self.runtime.freeze()
        self.assertEqual(snapshots["ui"]["changed_files"], sorted(["ui.txt", "docs/app.example"]))
        tree = subprocess.check_output(["git", "-C", str(self.repo), "ls-tree", "-r", "-z", "--name-only", snapshots["ui"]["commit"]]).decode().split("\0")
        self.assertIn("docs/app.example", tree)
        self.assertNotIn("docs/other.example", tree)  # an ignored file nothing tracks stays out

    def test_freeze_captures_a_file_the_lane_deleted(self):
        # The exact-path `git add` after `add -A` got every changed path, deletions included, and Git refuses a pathspec that
        # matches nothing (exit 128): a lane that deleted a base file could not freeze.
        self.sessions.run("ui"); self.sessions.run("adapter")
        (Path(self.plan["nodes"]["adapter"]["worktree"]) / "backend.py").unlink()
        snapshots = self.runtime.freeze()
        self.assertEqual(snapshots["adapter"]["changed_files"], ["backend.py"])
        tree = subprocess.check_output(["git", "-C", str(self.repo), "ls-tree", "-r", "-z", "--name-only", snapshots["adapter"]["commit"]]).decode().split("\0")
        self.assertNotIn("backend.py", tree)


class BundleTests(unittest.TestCase):
    """validate_bundle on the bundle the candidate step wrote; the lanes run build and unit checks only (no browser)."""

    def setUp(self):
        self.fixture = PipelineTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)

    def review_gate(self, drill: dict | None = None) -> Path:
        """Launch, freeze, verify and combine both lanes up to the review gate; a drill's lane is retried once."""
        f = self.fixture
        f.policy.update(version="1.2.0", **({"failure_drill": drill} if drill else {}))
        f.policy["workers"][0].update(required_check_kinds=["build"], checks=f.policy["workers"][0]["checks"][:1])
        f.policy["workers"][1]["required_check_kinds"] = ["unit"]
        f.plan["policy_sha256"] = policy_digest(f.policy)
        save_json(f.directory / "policy.json", f.policy)
        save_json(f.directory / "plan.json", f.plan)
        f.runtime = OfflinePipeline(f.directory, f.sessions)
        with SqliteSaver.from_conn_string(str(f.directory / "graph.sqlite")) as saver:
            graph = build_pipeline(saver, f.runtime)
            graph.invoke({"run_id": "run"}, f.config)
            if drill:
                with self.assertRaisesRegex(RuntimeError, f"{drill['node_id']} verification blocked"):
                    graph.invoke(Command(resume={"freeze": True}), f.config)
                f.runtime.retry_check("worker", drill["node_id"])
                outcome = graph.invoke(None, f.config)
            else:
                outcome = graph.invoke(Command(resume={"freeze": True}), f.config)
        self.assertEqual(outcome["__interrupt__"][0].value["kind"], "independent_review")
        return f.directory / "review-bundle.json"

    def test_validate_bundle_needs_one_worker_and_one_candidate_packet_per_lane_on_the_runs_base(self):
        path = self.review_gate()
        runtime = self.fixture.runtime
        bundle, digest = runtime.validate_bundle()
        references = {Path(item["path"]).parts[-4:-2]: item for item in bundle["packets"]}
        self.assertEqual(sorted(references), [("candidate", "adapter"), ("candidate", "ui"), ("worker", "adapter"), ("worker", "ui")])
        others = [item for key, item in references.items() if key != ("candidate", "adapter")]
        for change, refusal in (({"packets": []}, "Bundle has no worker packet of ui"),
                                ({"packets": others}, "Bundle has no candidate packet of adapter"),
                                ({"packets": [*others, references[("worker", "adapter")]]}, "Bundle has two worker packets of adapter"),
                                ({"base_commit": "f" * 40}, f"Bundle base {'f' * 40} is not the run's base {bundle['base_commit']}"),
                                ({"snapshots": {**bundle["snapshots"], "ui": {**bundle["snapshots"]["ui"], "commit": bundle["base_commit"]}}},
                                 f"Bundle's worker packet of ui is of {bundle['snapshots']['ui']['commit']}, not {bundle['base_commit']}"),
                                # Candidate packets that verified another combined revision than the one the bundle names.
                                ({"candidate_commit": bundle["base_commit"]},
                                 f"Bundle's candidate packet of ui is of {bundle['candidate_commit']}, not {bundle['base_commit']}")):
            with self.subTest(refusal):
                save_json(path, {**bundle, **change})
                with self.assertRaisesRegex(ValueError, f"^{re.escape(refusal)}"):
                    runtime.validate_bundle()
        save_json(path, bundle)
        # Leftover packets of a lane the run does not combine (here the run combines ui alone).
        with self.subTest("a lane the run does not combine"), patch.object(runtime, "workers", ["ui"]):
            with self.assertRaisesRegex(ValueError, "^Bundle has packets of no lane it combines: worker adapter, candidate adapter$"):
                runtime.validate_bundle()
        self.assertEqual(runtime.validate_bundle(), (bundle, digest))

    def test_a_failure_drill_bundle_combines_the_retried_attempt(self):
        path = self.review_gate(drill={"node_id": "adapter", "phase": "worker", "attempt": 1})
        bundle, _ = self.fixture.runtime.validate_bundle()
        self.assertEqual(bundle["failure_drill"]["verification_attempts"], {"ui": [1], "adapter": [1, 2]})
        self.assertEqual(sorted(Path(item["path"]).parts[-4:-1] for item in bundle["packets"]),
                         [("candidate", "adapter", "1"), ("candidate", "ui", "1"), ("worker", "adapter", "2"), ("worker", "ui", "1")])
        self.assertEqual(read_json(path), bundle)


def pipeline_cli(*arguments: str) -> tuple[int, str, str]:
    """`python -m workflow <action> ...` in this process: (exit code, stdout, stderr). The controller's Git configuration
    main() adds to the environment stays with the call, as it would with its own process."""
    from . import pipeline
    out, err = io.StringIO(), io.StringIO()
    code = 0
    with patch.object(sys, "argv", ["workflow", *by_operator(arguments)]), patch.dict(os.environ), contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        try:
            pipeline.main()
        except SystemExit as exit_:
            code = exit_.code
    return code, out.getvalue(), err.getvalue()


class PreflightAttackGuard(unittest.TestCase):
    """Run 003 fix 8 ([L16]): preflight gates the attack guard on the `--attack` flag (from the feature's attack), not on
    policy.attack_check. A policy that keeps attack_check without --attack is not guarded."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.repo = self.tmp / "repo"
        self.repo.mkdir()
        for args in (["init", "-q"], ["config", "user.email", "t@t"], ["config", "user.name", "t"]):
            subprocess.run(["git", "-C", str(self.repo), *args], check=True)
        (self.repo / "f.txt").write_text("x\n")
        subprocess.run(["git", "-C", str(self.repo), "add", "-A"], check=True)
        subprocess.run(["git", "-C", str(self.repo), "commit", "-qm", "c"], check=True)
        self.policy = self.tmp / "policy.json"  # Outside the repo, so preflight's clean check still passes.
        save_json(self.policy, {"version": "1.3.0", "feature": "f", "independent_review": True, "integration_approval": True,
                  "workers": [{"node_id": "x", "role": "backend", "required_check_kinds": ["unit"], "owned_paths": ["a"],
                               "checks": [{"id": "c", "kind": "unit", "argv": ["true"], "timeout_seconds": 60, "scenarios": []}]}],
                  "attack_check": {"argv": ["sh", "{file}"], "timeout_seconds": 60}})
        stub = self.tmp / "claude"  # --help lacks --max-budget-usd on purpose; everything else preflight needs is present.
        stub.write_text('#!/bin/sh\ncase "$1" in\n  --version) echo stub;;\n'
                        '  --help) echo "--bg --settings --safe-mode --tools --permission-mode --effort";;\n'
                        '  auth) echo \'{"loggedIn": true}\';;\n  *) exit 2;;\nesac\n')
        stub.chmod(0o755)
        path = patch.dict(os.environ, {"PATH": f"{self.tmp}{os.pathsep}{os.environ.get('PATH', '')}"})
        path.start()
        self.addCleanup(path.stop)
        secrets = patch("workflow.attack.default_secret_files", return_value=[])
        secrets.start()
        self.addCleanup(secrets.stop)

    def test_the_attack_guard_fires_only_with_the_flag(self):
        # Without --attack: the policy's attack_check does not trigger the budget guard; preflight passes.
        code, out, err = pipeline_cli("preflight", str(self.repo), "--repo", str(self.repo), "--policy", str(self.policy))
        self.assertEqual(code, 0, err)
        self.assertIn('"preflight": "passed"', out)
        # With --attack: the missing --max-budget-usd in claude --help refuses preflight (pipeline.py attack guard).
        code, out, err = pipeline_cli("preflight", str(self.repo), "--repo", str(self.repo), "--policy", str(self.policy), "--attack")
        self.assertEqual(code, 1)
        self.assertIn("--max-budget-usd", err)


class RecordTests(unittest.TestCase):
    """The run's record says what happened and what happens next: deferred checks' exit codes, the candidate gate's reasons,
    a pass after a failed attempt, the attention record of a finished run, and a status that reads beside a running controller.
    The lanes run build and unit checks only (no browser): ui's build is recorded for the candidate gate, adapter's unit gates."""

    def setUp(self):
        self.fixture = PipelineTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        f = self.fixture
        f.policy["version"] = "1.2.0"
        f.policy["workers"][0].update(required_check_kinds=["build"], checks=f.policy["workers"][0]["checks"][:1])
        f.policy["workers"][1]["required_check_kinds"] = ["unit"]
        self.feed = f.root / "config" / "attention.jsonl"
        environment = patch.dict(os.environ, {"MD_MANAGER_PROJECTS_CONFIG": str(f.root / "config" / "projects.json")})
        environment.start()
        self.addCleanup(environment.stop)

    def pin(self, **plan) -> None:
        f = self.fixture
        f.plan.update(plan, policy_sha256=policy_digest(f.policy))
        save_json(f.directory / "policy.json", f.policy)
        save_json(f.directory / "plan.json", f.plan)
        f.runtime = OfflinePipeline(f.directory, f.sessions)

    def guard(self) -> None:
        """The feature files of a feature.json 2.2.0 run, pinned as guardrails.pin_guardrails pins them: the lanes' task files
        and decisions.md, committed in the target at the run's base. A paused challenge's next step compares them."""
        from .guardrails import pinned_task
        f = self.fixture
        folder = f.repo / "features" / "record"
        folder.mkdir(parents=True)
        tasks = {worker["node_id"]: folder / f"{worker['node_id']}-task.md" for worker in f.policy["workers"]}
        for worker in f.policy["workers"]:
            tasks[worker["node_id"]].write_text(f"## Goal\n\nChange {worker['node_id']}.\n\n## Acceptance\n\nIt changed.\n\n## Stop\n\nWhen it changed.\n")
            f.plan["nodes"][worker["node_id"]]["task"] = pinned_task(tasks[worker["node_id"]].read_text(), worker)
        (folder / "decisions.md").write_text("# Decisions\n\n- Keep the lanes apart.\n")
        git(f.repo, "add", "features")
        git(f.repo, "commit", "-qm", "Feature files")
        self.pin(base_commit=git(f.repo, "rev-parse", "HEAD"), task_files={lane: str(path) for lane, path in tasks.items()},
                 decisions={"path": str(folder / "decisions.md"), "text": (folder / "decisions.md").read_text()})

    @contextlib.contextmanager
    def graph(self):
        """The run's own checkpoint, the one `status`, `export` and `approve` read."""
        with SqliteSaver.from_conn_string(str(self.fixture.directory / "pipeline.sqlite")) as saver:
            yield build_pipeline(saver, self.fixture.runtime)

    def events(self, node: str) -> list:
        lines = [json.loads(line) for line in (self.fixture.directory / "events.jsonl").read_text().splitlines()]
        return [(event["status"], event["message"]) for event in lines if event["node"] == node]

    def review_gate(self, graph) -> dict:
        f = self.fixture
        graph.invoke({"run_id": "run"}, f.config)
        outcome = graph.invoke(Command(resume={"freeze": True}), f.config)
        self.assertEqual(outcome["__interrupt__"][0].value["kind"], "independent_review")
        report(f.runtime, graph.get_state(f.config))  # The controller's export at the end of its step.
        return f.review()

    def status(self) -> tuple[dict, str]:
        code, out, err = pipeline_cli("status", str(self.fixture.directory))
        self.assertEqual(code, 0, err)
        return json.loads(out.split("\nReport:")[0]), out

    def test_deferred_checks_show_their_exit_codes_and_a_blocked_candidate_gives_its_reasons(self):
        f = self.fixture
        f.policy["workers"][0]["checks"][0]["argv"] = ["python", "-c", "import sys; sys.exit(1)"]  # A ui build that never passes.
        self.pin()
        with self.graph() as graph:
            graph.invoke({"run_id": "run"}, f.config)
            with self.assertRaisesRegex(RuntimeError, "Combined candidate failed ui checks"):
                graph.invoke(Command(resume={"freeze": True}), f.config)
        # The worker gate records the failing build for the candidate gate, as before, and no longer hides its exit code.
        self.assertEqual(self.events("verify_ui")[-1], ("passed", "Required tests and artifacts passed; recorded for the candidate gate: build (exit 1)"))
        self.assertEqual(self.events("verify_adapter")[-1], ("passed", "Required tests and artifacts passed"))
        # The candidate's event keeps its message; a second one gives the gate's reasons.
        commit = read_json(f.directory / "candidate.json")["commit"]
        self.assertEqual(self.events("candidate_ui"), [
            ("running", f"Attempt 1; combined revision {commit}"),
            ("blocked", f"Combined revision {commit}"),
            ("blocked", "Candidate gate blocked on attempt 1: Executed check failed: python -c 'import sys; sys.exit(1)'; build: exit 1")])

    def test_a_check_that_passes_after_a_failed_attempt_on_the_same_revision_says_so(self):
        f = self.fixture
        worker, candidate = f.root / "fail-worker-once", f.root / "fail-candidate-once"
        script = ("import os, pathlib, sys\n"
                  f"marker = pathlib.Path({str(worker)!r} if os.environ['WORKFLOW_VERIFICATION_PHASE'] == 'worker' else {str(candidate)!r})\n"
                  "if marker.exists():\n    marker.unlink()\n    print('Ran 1 test in 0.001s\\n\\nFAILED (failures=1)')\n    sys.exit(1)\n"
                  "print('Ran 1 test in 0.001s\\n\\nOK')\n")
        f.policy["workers"][1]["checks"][0]["argv"] = ["python", "-c", script]  # Fails once in each phase, then passes.
        worker.touch()
        candidate.touch()
        self.pin()
        with self.graph() as graph:
            graph.invoke({"run_id": "run"}, f.config)
            with self.assertRaisesRegex(RuntimeError, "adapter verification blocked"):
                graph.invoke(Command(resume={"freeze": True}), f.config)
            f.runtime.retry_check("worker", "adapter")
            with self.assertRaisesRegex(RuntimeError, "Combined candidate failed adapter checks"):
                graph.invoke(None, f.config)
            f.runtime.retry_check("candidate", "adapter")
            self.assertEqual(graph.invoke(None, f.config)["__interrupt__"][0].value["kind"], "independent_review")
        self.assertEqual(self.events("verify_adapter")[-1], ("passed", "Required tests and artifacts passed on attempt 2 after attempt 1 failed"))
        self.assertEqual(self.events("verify_ui"), [("running", f"Attempt 1; revision {read_json(f.directory / 'snapshots.json')['ui']['commit']}"),
                                                    ("passed", "Required tests and artifacts passed; recorded for the candidate gate: build (exit 0)")])
        commit = read_json(f.directory / "candidate.json")["commit"]
        self.assertEqual(self.events("candidate_adapter")[-2:], [("passed", f"Combined revision {commit}"),
                                                                ("passed", "Candidate gate passed on attempt 2 after attempt 1 failed")])
        self.assertEqual(self.events("candidate_ui"), [("running", f"Attempt 1; combined revision {commit}"),
                                                       ("passed", f"Combined revision {commit}")] * 2)  # Restated by the rerun step, which runs the checks again; not a retry.

    def test_a_check_over_sixty_percent_of_its_timeout_is_named_in_its_verify_and_candidate_events(self):
        f = self.fixture
        # About 70% of a 4 s timeout; ui's quick build is not named.
        f.policy["workers"][1]["checks"][0].update(timeout_seconds=4, argv=["python", "-c", "import time; time.sleep(2.8); print('Ran 1 test in 2.8s\\n\\nOK')"])
        self.pin()
        with self.graph() as graph:
            self.review_gate(graph)
        slow = r"; slow: unit took \d s of its 4 s timeout \((6[1-9]|[7-9]\d)%\)$"
        self.assertRegex(self.events("verify_adapter")[-1][1], r"^Required tests and artifacts passed" + slow)
        self.assertRegex(self.events("candidate_adapter")[-1][1], r"^Combined revision [0-9a-f]{40}" + slow)
        self.assertEqual(self.events("verify_ui")[-1], ("passed", "Required tests and artifacts passed; recorded for the candidate gate: build (exit 0)"))

    def test_the_verify_message_keeps_the_viewers_prefix_and_puts_the_retry_last(self):
        from .pipeline import passed_message
        packet = {"gate": {"deferred_checks": ["build", "browser", "lint"]},
                  "evidence": {"checks": [{"id": "unit", "worker_check_index": 0}, {"id": "build", "worker_check_index": 1},
                                          {"id": "browser", "worker_check_index": 2}]},
                  "result": {"checks": [{"exit_code": 0}, {"exit_code": 1}, {"exit_code": 124}]}}
        prefix = "Required tests and artifacts passed; recorded for the candidate gate: "  # contracts/projects/triage.ts reads this prefix.
        self.assertEqual(passed_message(packet), prefix + "build (exit 1), browser (exit 124), lint")  # lint: no receipt to read.
        self.assertEqual(passed_message(packet, 3), prefix + "build (exit 1), browser (exit 124), lint; passed on attempt 3 after attempt 2 failed")
        packet["gate"]["deferred_checks"] = []
        self.assertEqual(passed_message(packet), "Required tests and artifacts passed")
        self.assertEqual(passed_message(packet, 2), "Required tests and artifacts passed on attempt 2 after attempt 1 failed")

    def test_only_a_blocked_attempt_of_the_same_revision_counts_as_failed_before(self):
        from .pipeline import failed_before
        directory = self.fixture.root / "attempts"
        def packet(attempt: int, commit: str, status: str):
            path = directory / "verification" / "worker" / "ui" / str(attempt) / "packet.json"
            path.parent.mkdir(parents=True)
            save_json(path, {"phase": "worker", "expected": {"output_commit": commit}, "gate": {"status": status, "reasons": []}})
        packet(1, "a" * 40, "blocked")
        self.assertTrue(failed_before(directory, "worker", "ui", 2, "a" * 40))
        self.assertFalse(failed_before(directory, "worker", "ui", 2, "b" * 40))  # A lane repair's new revision starts over.
        self.assertFalse(failed_before(directory, "candidate", "ui", 2, "a" * 40))
        self.assertFalse(failed_before(directory, "worker", "ui", 1, "a" * 40))
        self.assertFalse(failed_before(directory, "worker", "ui", 3, "a" * 40))  # Attempt 2 recorded nothing (an interrupted check).
        packet(2, "a" * 40, "passed")
        self.assertFalse(failed_before(directory, "worker", "ui", 3, "a" * 40))

    def test_a_finished_run_records_attention_once(self):
        f = self.fixture
        # The run's branch beside the repository's main branch, which approve never touches.
        git(f.repo, "branch", "-m", "main")
        git(f.repo, "checkout", "-q", "-b", "feature/record")
        self.pin(source_branch="feature/record")
        with self.graph() as graph:
            decision = self.review_gate(graph)
            graph.invoke(Command(resume=decision), f.config)
            commit = graph.invoke(Command(resume={"approve": decision["bundle_sha256"]}), f.config)["integrated_commit"]
        self.assertEqual((git(f.repo, "rev-parse", "main"), git(f.repo, "rev-parse", "feature/record")), (f.plan["base_commit"], commit))
        text = f"feature/record fast-forwarded to {commit}: the run is finished. Nothing was pushed, and main is untouched."
        [line] = [json.loads(line) for line in self.feed.read_text().splitlines()]
        self.assertEqual({key: line[key] for key in ("run_id", "run_dir", "kind", "node", "text")},
                         {"run_id": "run", "run_dir": str(f.directory.resolve()), "kind": "finished", "node": "integrate", "text": text})
        record = read_json(f.directory / "attention.json")
        self.assertEqual((record["kind"], record["node"], record["text"], record["at"]), ("finished", "integrate", text, line["at"]))
        # Integrating again (a controller stopped right after the fast-forward) finds the branch there and records nothing more.
        self.assertEqual(f.runtime.integrate(decision["bundle_sha256"]), commit)
        self.assertEqual(len(self.feed.read_text().splitlines()), 1)

    def test_approve_integrates_an_automatic_run_that_waits_for_approval_and_records_the_actor(self):
        # C51: an automatic run with finish "approval" (attended, or a critical feature) stops at the same gate as a manual run;
        # the operator's approve integrates it and the approval node records who approved. The maintainer is refused (C17).
        f = self.fixture
        git(f.repo, "checkout", "-q", "-b", "feature/record")
        self.pin(source_branch="feature/record")
        with self.graph() as graph:
            decision = self.review_gate(graph)
            self.pin(source_branch="feature/record", automatic=automatic_settings(profile="attended"))
            graph = build_pipeline(graph.checkpointer, f.runtime)
            stopped = graph.invoke(Command(resume=decision), f.config)
            self.assertEqual(stopped["__interrupt__"][0].value["kind"], "integration_approval")
            report(f.runtime, graph.get_state(f.config))
        digest = decision["bundle_sha256"]
        printed, _ = self.status()
        self.assertIn("finish approval (the attended profile)", printed["next_step"])
        self.assertIn(f"-m workflow approve {f.directory} --bundle-sha256 {digest} --by operator", printed["next_step"])
        code, _, err = pipeline_cli("approve", str(f.directory), "--bundle-sha256", digest, "--by", "maintainer")
        self.assertEqual(code, 1)
        self.assertIn("approve is the operator's decision: --by maintainer is refused", err)
        self.assertEqual(git(f.repo, "rev-parse", "HEAD"), f.plan["base_commit"])
        self.assertEqual(self.events("approval"), [])
        code, out, err = pipeline_cli("approve", str(f.directory), "--bundle-sha256", digest)
        self.assertEqual(code, 0, err)
        commit = read_json(f.directory / "run-state.json")["values"]["integrated_commit"]
        self.assertEqual(git(f.repo, "rev-parse", "HEAD"), commit)
        [(status, message)] = self.events("approval")
        self.assertEqual(status, "approved")
        self.assertRegex(message, rf"^Approved by the operator( \(via a Claude Code session\))?: the fast-forward of bundle {digest[:12]}$")
        self.assertEqual(self.events("integrate"), [("succeeded", f"Fast-forwarded to {commit}; no push performed")])

    def test_status_reads_beside_a_running_controller_and_writes_nothing(self):
        f = self.fixture
        self.pin()
        with self.graph() as graph:
            self.review_gate(graph)
        last = json.loads((f.directory / "events.jsonl").read_text().splitlines()[-1])
        # The controller holds the run and is writing its next event: half a line, no newline yet.
        with (f.directory / "events.jsonl").open("a") as handle:
            handle.write('{"sequence": 99, "time": "2026-10-03T12:00:00Z", "node": "review", "sta')
        with run_lock(f.directory):
            files = {path.name: (path.read_bytes(), path.stat().st_mtime_ns) for path in f.directory.iterdir() if path.is_file()}
            printed, out = self.status()
            self.assertEqual({path.name: (path.read_bytes(), path.stat().st_mtime_ns) for path in f.directory.iterdir() if path.is_file()}, files)
        self.assertIn("report.html", files)  # Written by the controller's export; status refreshes nothing.
        self.assertEqual((printed["workers"], printed["excluded_workers"], printed["next"], printed["pending"], printed["errors"]),
                         (["ui", "adapter"], [], ["review"], ["independent_review"], []))
        self.assertEqual(printed["last_event"], last)
        self.assertIn(f"\nReport: {f.directory / 'report.html'}\n", out)
        self.assertEqual(out.count("as of the last graph step"), 1)

    def test_status_says_what_happens_next_from_the_finish_policy(self):
        f = self.fixture
        self.pin()
        with self.graph() as graph:
            decision = self.review_gate(graph)
            printed, _ = self.status()
            self.assertIn(f"-m workflow review {f.directory} --review-file ", printed["next_step"])
            graph.invoke(Command(resume=decision), f.config)
            report(f.runtime, graph.get_state(f.config))
            # A manual run stops for approval: the step names the exact bundle to approve.
            printed, _ = self.status()
            self.assertEqual(printed["pending"], ["integration_approval"])
            self.assertIn(f"-m workflow approve {f.directory} --bundle-sha256 {decision['bundle_sha256']}", printed["next_step"])
            # plan.mode is "interactive" for every run; an automatic plan's finish policy approves its own integration.
            self.assertEqual(f.plan["mode"], "interactive")
            manual = dict(f.plan)
            self.pin(automatic=automatic_settings(), source_branch="feature/record")
            printed, _ = self.status()
            self.assertIn("finish verified-feature-branch", printed["next_step"])
            self.assertIn("does not stop for integration approval", printed["next_step"])
            self.assertIn(f"-m workflow automatic {f.directory} --live", printed["next_step"])
            self.assertNotIn("-m workflow approve", printed["next_step"])
            save_json(f.directory / "plan.json", manual)
            commit = graph.invoke(Command(resume={"approve": decision["bundle_sha256"]}), f.config)["integrated_commit"]
            report(f.runtime, graph.get_state(f.config))
        printed, _ = self.status()
        # The fixture's repository has no main branch (its main line is master): the line names none.
        self.assertEqual(printed["next_step"], f"none: {manual['source_branch']} was fast-forwarded to {commit}; nothing was pushed")

    def test_a_finished_run_on_main_claims_nothing_about_main(self):
        # A manual run may be prepared on main itself: approve then fast-forwards main, so neither the finished record nor
        # status may say that main is untouched. Beside a main branch they say so; without one they name none.
        from .pipeline import next_step
        f = self.fixture
        commit = "c" * 40
        finished = {"values": {"integrated_commit": commit}, "next": [], "tasks": []}
        git(f.repo, "branch", "-m", "main")
        plan = {**f.plan, "source_branch": "main"}
        Pipeline.record_finished(SimpleNamespace(directory=f.directory, plan=plan), commit)
        self.assertEqual(read_json(f.directory / "attention.json")["text"], f"main fast-forwarded to {commit}: the run is finished. Nothing was pushed.")
        self.assertEqual(next_step(f.directory, plan, finished), f"none: main was fast-forwarded to {commit}; nothing was pushed")
        git(f.repo, "checkout", "-q", "-b", "feature/record")
        self.assertEqual(next_step(f.directory, {**plan, "source_branch": "feature/record"}, finished),
                         f"none: feature/record was fast-forwarded to {commit}; nothing was pushed, and main is untouched")
        git(f.repo, "branch", "-m", "main", "master")
        self.assertEqual(next_step(f.directory, {**plan, "source_branch": "master"}, finished), f"none: master was fast-forwarded to {commit}; nothing was pushed")

    def test_status_names_what_goes_on_from_an_undecided_challenge_a_step_in_progress_or_no_export(self):
        from .guardrails import REVISION_INTENT, pinned_digests
        from .pipeline import next_step
        f = self.fixture
        self.pin()
        self.guard()
        run = lambda action: f"{sys.executable} -m workflow {action} {f.directory}"
        # Whether start was given --herdr is not recorded: every start and resume command says to add it for the worker panes.
        hint = "add --herdr for the worker panes, as launch opens them unless --no-herdr"
        # (c) No run-state.json: a run from before the export, or one whose file is gone. What goes on is unknown until export.
        self.assertFalse((f.directory / "run-state.json").exists())
        printed, _ = self.status()
        self.assertEqual(printed["next_step"], f"unknown until `export` writes run-state.json: {run('export')}, then status again. "
                                               f"manual: you freeze the workers, import each review and approve the fast-forward of "
                                               f"{f.plan['source_branch']}; nothing is pushed")
        code, _, err = pipeline_cli("export", str(f.directory))
        self.assertEqual(code, 0, err)
        printed, _ = self.status()
        self.assertTrue(printed["next_step"].startswith(f"no worker started yet: {run('start')} --live --by operator ({hint}). Then: "), printed["next_step"])
        # (a) A challenge job started and never decided (Ctrl-C during it, or start or resume still running it): resume reruns
        # it with no edit, and the override is refused without a paused record, so it is never offered.
        running = f.directory / "challenge.running.json"
        save_json(running, {"attempt": 1, "session_id": "00000000-0000-4000-8000-000000000001", "started_at": now()})
        rerun = f"if no start or resume is running, {run('resume')} --by operator reruns it (no edit needed; {hint}). Then: "
        printed, _ = self.status()
        self.assertTrue(printed["next_step"].startswith(f"design challenge attempt 1 was started and not decided: {rerun}"), printed["next_step"])
        self.assertNotIn("--accept-challenge", printed["next_step"])
        # Paused: an edit then resume, or the override.
        running.unlink()
        paused = {"status": "paused", "attempt": 1, "pinned": pinned_digests(f.directory, f.plan)}
        save_json(f.directory / "challenge.json", paused)
        printed, _ = self.status()
        self.assertTrue(printed["next_step"].startswith(
            f"design challenge attempt 1 paused the run: edit the task files, decisions.md or the PRD in the source checkout {f.plan['repository']}, "
            f"then {run('resume')} --by operator, "
            f"or accept it with {run('resume')} --by operator --accept-challenge \"<reason>\" ({hint}). Then: "), printed["next_step"])
        # A rerun started after the pause and never decided; a resume that stopped before it pinned the revised files; one that
        # pinned them and failed before its job (its checkout): each is rerun by resume, and the override is refused.
        for state, said in ((lambda: save_json(running, {"attempt": 2, "session_id": "00000000-0000-4000-8000-000000000002", "started_at": now()}),
                             f"design challenge attempt 2 was started and not decided: {rerun}"),
                            (lambda: save_json(f.directory / REVISION_INTENT, {"base_commit": f.plan["base_commit"], "paths": []}),
                             f"an interrupted resume has not finished moving the run to the revised feature files: if no resume is running, "
                             f"{run('resume')} --by operator finishes it and reruns the design challenge ({hint}). Then: "),
                            (lambda: save_json(f.directory / "challenge.json", {**paused, "pinned": {**paused["pinned"], "tasks_sha256": "0" * 64}}),
                             f"design challenge attempt 1 read other feature files than the plan now pins, and no later attempt was decided: {rerun}")):
            with self.subTest(said.split(":")[0]):
                state()
                printed, _ = self.status()
                self.assertTrue(printed["next_step"].startswith(said), printed["next_step"])
                self.assertNotIn("--accept-challenge", printed["next_step"])
                for path in (running, f.directory / REVISION_INTENT):
                    path.unlink(missing_ok=True)
                save_json(f.directory / "challenge.json", paused)
        # (b) A manual step running now (freeze, review, approve, retry), or stopped mid-step: no gate waits and no step recorded
        # an error, so it is not called failed.
        exported = {"values": {"lanes": {}}, "next": ["verify_ui", "verify_adapter"],
                    "tasks": [{"node_id": node, "error": None, "interrupts": [], "result": None} for node in ("verify_ui", "verify_adapter")]}
        step = next_step(f.directory, f.plan, exported)
        self.assertTrue(step.startswith("verify_ui, verify_adapter: running now, or stopped mid-step (no step recorded an error). If no workflow "
                                        "command is running on this run, RUNBOOK \"Status, failures and recovery\" says which `retry` or "
                                        "`reconcile` goes on."), step)
        self.assertNotIn("failed", step)
        exported["tasks"][0]["error"] = "RuntimeError('ui verification blocked; see packet.json')"
        self.assertTrue(next_step(f.directory, f.plan, exported).startswith("a step failed (see errors): RUNBOOK"))

    def test_status_offers_no_override_while_edited_feature_files_wait(self):
        # After a pause the operator edits a pinned feature file. `resume --accept-challenge` refuses then (refuse_unused_edits),
        # so status names the bare resume, which commits the edit and reruns the challenge, and offers no override until the
        # edit is reverted. It reads the source checkout without writing its index: that lock is for the resume's commit.
        from .guardrails import pinned_digests, refuse_unused_edits
        f = self.fixture
        self.pin()
        self.guard()
        code, _, err = pipeline_cli("export", str(f.directory))
        self.assertEqual(code, 0, err)
        save_json(f.directory / "challenge.json", {"status": "paused", "attempt": 1, "pinned": pinned_digests(f.directory, f.plan)})
        resume = f"{sys.executable} -m workflow resume {f.directory} --by operator"
        hint = "add --herdr for the worker panes, as launch opens them unless --no-herdr"
        offered = f"or accept it with {resume} --accept-challenge \"<reason>\" ({hint}). Then: "
        self.assertIn(offered, self.status()[0]["next_step"])
        decisions = Path(f.plan["decisions"]["path"])
        pinned = decisions.read_text()
        decisions.write_text(pinned + "- The adapter owns the format.\n")
        os.utime(f.repo / "ui.txt", (1_600_000_000, 1_600_000_000))  # Stat data a plain `git status` writes back to the index.
        index = f.repo / ".git" / "index"
        before = (index.read_bytes(), index.stat().st_mtime_ns)
        printed, _ = self.status()
        self.assertEqual((index.read_bytes(), index.stat().st_mtime_ns), before)
        self.assertTrue(printed["next_step"].startswith(
            f"design challenge attempt 1 paused the run, and feature files changed since it read them: {resume} commits them and "
            f"reruns the design challenge ({hint}); --accept-challenge is refused until the changes are reverted. Then: "), printed["next_step"])
        with self.assertRaisesRegex(ValueError, r"^Feature files changed since they were pinned \(features/record/decisions\.md\)"):
            refuse_unused_edits(f.directory, f.plan)  # What `resume --accept-challenge` does now.
        # An edit resume would refuse (a re-grill's unanswered question): status names the refusal, never the commit.
        decisions.write_text(pinned + "TODO: Q2 Who owns contracts/?\n")
        step = self.status()[0]["next_step"]
        self.assertIn(f"feature files changed since it read them, but resume refuses: {decisions}:4: TODO: Q2 Who owns contracts/? "
                      "(launch refuses it too", step)
        self.assertNotIn("commits them", step)
        decisions.write_text(pinned)
        self.assertIn(offered, self.status()[0]["next_step"])
        # A source checkout that cannot be read (moved, or git fails in it): resume needs it too, so status offers nothing.
        with patch("workflow.guardrails.dirty_paths", side_effect=subprocess.CalledProcessError(128, ["git", "status"])):
            printed, _ = self.status()
        self.assertTrue(printed["next_step"].startswith(
            f"design challenge attempt 1 paused the run, and its source checkout {f.repo} could not be read (Command '['git', 'status']' "
            "returned non-zero exit status 128.): resume needs it. Then: "), printed["next_step"])

    def test_export_refreshes_report_html(self):
        f = self.fixture
        self.pin()
        with self.graph() as graph:
            self.review_gate(graph)
        (f.directory / "report.html").unlink()
        code, out, err = pipeline_cli("export", str(f.directory))
        self.assertEqual(code, 0, err)
        self.assertIn(f"Report: {f.directory / 'report.html'}", out)
        self.assertIn("<h1>Workflow report</h1>", (f.directory / "report.html").read_text())

    def test_report_html_starts_with_the_outcome_block(self):
        # C43: the outcome block from the run record, at the top of report.html; nothing before a review is recorded.
        f = self.fixture
        self.pin()
        with self.graph() as graph:
            decision = self.review_gate(graph)
            self.assertNotIn("<h2>Outcome</h2>", (f.directory / "report.html").read_text())
            graph.invoke(Command(resume=decision), f.config)
            report(f.runtime, graph.get_state(f.config))
        page = (f.directory / "report.html").read_text()
        self.assertIn("<h1>Workflow report</h1><h2>Outcome</h2><pre>Outcome: approved by review; no open P0/P1.</pre>", page)

    def test_prepare_pins_the_worker_authority_and_the_report_shows_it(self):
        # C14 slice 1: no sandbox on this host; every launch runs as the operator's account, and the run records it with the
        # digest of the exact --settings its workers get (sessions.worker_settings), in plan.json and report.html.
        import hashlib
        from .sessions import worker_settings
        f = self.fixture
        policy = f.root / "policy.json"
        save_json(policy, f.policy)
        tasks = []
        for node in ("ui", "adapter"):
            (f.root / f"{node}-task.md").write_text(f"Change {node}.\n")
            tasks += ["--task", f"{node}={f.root / f'{node}-task.md'}"]
        run = f.root / "cli-run"
        code, out, err = pipeline_cli("prepare", str(run), "--repo", str(f.repo), "--policy", str(policy), *tasks)
        self.assertEqual(code, 0, err)
        authority = {"worker_settings_sha256": hashlib.sha256(worker_settings(run)[1].encode()).hexdigest(), "sandbox": False, "authority": "account"}
        plan = read_json(run / "plan.json")
        self.assertEqual(plan["worker_authority"], authority)
        self.assertEqual(plan["shared_git"]["entries"], read_json(f.directory / "plan.json")["shared_git"]["entries"])
        code, _, err = pipeline_cli("export", str(run))
        self.assertEqual(code, 0, err)
        page = (run / "report.html").read_text()
        self.assertIn("<h2>Worker authority</h2>", page)
        self.assertIn(authority["worker_settings_sha256"], page)
        self.assertIn("&quot;authority&quot;: &quot;account&quot;", page)
        # A run prepared before the record says nothing about it.
        self.pin()
        report(f.runtime, SimpleNamespace(values={}, next=(), tasks=[]))
        self.assertNotIn("Worker authority", (f.directory / "report.html").read_text())

    def prepare_cli(self, name: str, *flags: str, env: dict | None = None) -> tuple[Path, int, str]:
        f = self.fixture
        policy = f.root / "policy.json"
        save_json(policy, f.policy)
        tasks = []
        for node in ("ui", "adapter"):
            (f.root / f"{node}-task.md").write_text(f"Change {node}.\n")
            tasks += ["--task", f"{node}={f.root / f'{node}-task.md'}"]
        run = f.root / name
        with patch.dict(os.environ, env or {}), patch("workflow.sessions.claude_version", return_value="2.1.288 (Claude Code)"):
            code, _, err = pipeline_cli("prepare", str(run), "--repo", str(f.repo), "--policy", str(policy), *tasks, *flags)
        return run, code, err

    def test_prepare_pins_the_roles_the_controller_and_the_cli_version_and_nothing_changes_them_later(self):
        # C52: the roles from prepare's flags (the worker effort from WORKFLOW_WORKER_EFFORT, read once; the judges at high), the
        # controller checkout's commit and dirty flag, and `claude --version`.
        from .guardrails import resume_main
        from .sessions import CONTROLLER, role_flags, worker_effort
        run, code, err = self.prepare_cli("pinned-run", env={"WORKFLOW_WORKER_EFFORT": "medium"})
        self.assertEqual(code, 0, err)
        plan = read_json(run / "plan.json")
        self.assertEqual(plan["roles"], {"worker": {"model": "claude-opus-4-8", "effort": "medium"}, "judges": {"model": None, "effort": "high"}})
        self.assertEqual(plan["controller"], {"commit": git(CONTROLLER, "rev-parse", "HEAD"),
                                              "dirty": bool(git(CONTROLLER, "status", "--porcelain", "--untracked-files=no")),
                                              "claude_version": "2.1.288 (Claude Code)"})
        run, code, err = self.prepare_cli("flagged-run", "--worker-model", "claude-sonnet-5", "--worker-effort", "low",
                                          "--judge-model", "claude-opus-5-5", "--judge-effort", "max", env={"WORKFLOW_WORKER_EFFORT": "medium"})
        self.assertEqual(code, 0, err)
        plan = read_json(run / "plan.json")
        self.assertEqual(plan["roles"], {"worker": {"model": "claude-sonnet-5", "effort": "low"}, "judges": {"model": "claude-opus-5-5", "effort": "max"}})
        # Later commands read the pins, never the variable again; resume takes no role flag.
        with patch.dict(os.environ, {"WORKFLOW_WORKER_EFFORT": "xhigh"}):
            self.assertEqual(worker_effort(plan=plan), ["--effort", "low"])
            self.assertEqual(role_flags(plan, "worker"), ["--model", "claude-sonnet-5", "--effort", "low"])
        for flag in ("--worker-model", "--worker-effort", "--judge-model", "--judge-effort", "--profile"):
            with self.subTest(flag), contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as refused:
                resume_main([str(run), flag, "low"])
            self.assertEqual(refused.exception.code, 2)
        self.assertEqual(read_json(run / "plan.json"), plan)
        # A bad level or model is refused before anything is written.
        for flags in (["--worker-effort", "med"], ["--judge-model", "--effort"], ["--profile", "attended"]):
            with self.subTest(flags):
                run, code, err = self.prepare_cli("refused-run", *flags)
                self.assertNotEqual(code, 0)
                self.assertFalse(run.exists(), err)
        _, code, err = self.prepare_cli("refused-run", env={"WORKFLOW_WORKER_EFFORT": "med"})
        self.assertIn("not one of low, medium, high, xhigh, max", err)

    def test_prepare_records_each_lanes_worker_pin_and_refuses_a_bad_one_before_anything_is_written(self):
        # feature.json 2.7.0: --lane-model/--lane-effort <lane>=<value>; every selected lane gets its effective pin in
        # plan.nodes[<lane>].roles (the lane's field, else the run-wide worker pin); plan.roles keeps only worker and judges.
        from .sessions import role_flags
        run, code, err = self.prepare_cli("lane-run", "--worker-effort", "low", "--lane-model", "ui=claude-sonnet-5", "--lane-effort", "adapter=max")
        self.assertEqual(code, 0, err)
        plan = read_json(run / "plan.json")
        self.assertEqual(plan["roles"], {"worker": {"model": "claude-opus-4-8", "effort": "low"}, "judges": {"model": None, "effort": "high"}})
        self.assertEqual(plan["nodes"]["ui"]["roles"], {"model": "claude-sonnet-5", "effort": "low"})
        self.assertEqual(plan["nodes"]["adapter"]["roles"], {"model": "claude-opus-4-8", "effort": "max"})
        self.assertEqual(role_flags(plan, "worker", node="adapter"), ["--model", "claude-opus-4-8", "--effort", "max"])
        run, code, err = self.prepare_cli("plain-run")
        self.assertEqual(code, 0, err)
        plan = read_json(run / "plan.json")
        self.assertEqual({node: plan["nodes"][node]["roles"] for node in ("ui", "adapter")},
                         {node: {"model": "claude-opus-4-8", "effort": None} for node in ("ui", "adapter")})
        for flags, pattern in ((["--workers", "ui", "--lane-model", "adapter=claude-sonnet-5"], "adapter"),
                               (["--lane-model", "ui=two words"], "model"), (["--lane-effort", "ui=med"], "not one of"),
                               (["--lane-model", "ui=a", "--lane-model", "ui=b"], "twice"), (["--lane-effort", "ui"], "<lane>=")):
            with self.subTest(flags):
                run, code, err = self.prepare_cli("refused-lane-run", *flags)
                self.assertNotEqual(code, 0)
                self.assertIn(pattern, err)
                self.assertFalse(run.exists(), err)
        code, _, err = pipeline_cli("start", str(self.fixture.root / "lane-run"), "--lane-model", "ui=claude-sonnet-5")
        self.assertNotEqual(code, 0)
        self.assertIn("apply to prepare only", err)

    def test_prepare_says_when_a_scrubbed_model_or_effort_override_would_have_chosen_the_model(self):
        # The sessions' environment drops ANTHROPIC_MODEL and the CLI's other overrides (scrub_env): a launch line that relied on
        # one is told which flags pin it now. A role pinned by its flag needs no note.
        overrides = {"ANTHROPIC_MODEL": "claude-opus-5-5", "CLAUDE_CODE_EFFORT_LEVEL": "", "CLAUDE_CODE_SUBAGENT_MODEL": ""}
        _, code, err = self.prepare_cli("model-run", env=overrides)
        self.assertEqual(code, 0, err)
        self.assertIn("Note: ANTHROPIC_MODEL is set here but never reaches the run's sessions, which the workflow starts without it: "
                      "pin it with --judge-model; unpinned, the judges run Claude Code's default model.", err)
        _, code, err = self.prepare_cli("pinned-model-run", "--worker-model", "claude-opus-5-5", env={**overrides, "CLAUDE_CODE_EFFORT_LEVEL": "low"})
        self.assertIn("Note: ANTHROPIC_MODEL, CLAUDE_CODE_EFFORT_LEVEL are set here but never reach the run's sessions, which the workflow starts "
                      "without them: pin them with --judge-model, --worker-effort and --judge-effort; unpinned, the judges run Claude Code's "
                      "default model, the workers take WORKFLOW_WORKER_EFFORT and the judges high effort.", err)
        _, code, err = self.prepare_cli("all-pinned-run", "--worker-model", "a", "--judge-model", "b", env=overrides)
        self.assertNotIn("never reach", err)

    def test_prepare_in_this_suite_reads_the_stand_in_cli_never_the_operators(self):
        # setUpModule puts a stand-in `claude` first on PATH (stub_claude_cli), for prepare in process and in a child.
        from .sessions import controller_record
        self.assertEqual(controller_record()["claude_version"], CLAUDE_VERSION_STUB)
        child = subprocess.run([sys.executable, "-c", "from workflow.sessions import claude_version; print(claude_version())"],
                               capture_output=True, text=True, check=True, cwd=Path(__file__).resolve().parents[1])
        self.assertEqual(child.stdout.strip(), CLAUDE_VERSION_STUB)

    def test_a_run_prepared_before_roles_and_the_controller_record_loads_and_launches_as_before(self):
        from .sessions import role_flags
        f = self.fixture
        self.pin()
        self.assertNotIn("roles", f.plan)
        runtime = Pipeline(f.directory, f.sessions)
        with patch.dict(os.environ, {"WORKFLOW_WORKER_EFFORT": "medium"}):
            self.assertEqual((role_flags(runtime.plan, "worker"), role_flags(runtime.plan, "judges")), (["--effort", "medium"], []))
        self.pin(automatic=automatic_settings(), source_branch="feature/test")
        del f.plan["automatic"]["profile"]
        self.pin()
        Pipeline(f.directory, f.sessions)  # An automatic plan without profile validates.

    def test_the_role_flags_and_the_profile_are_refused_on_every_action_but_prepare(self):
        # The pins never change after prepare: a role flag or --profile on another action would be ignored silently, so it is
        # refused before the run is read (`automatic --live` resumes a run; an operator who passes a pin believes it changed).
        f = self.fixture
        self.pin()
        plan = read_json(f.directory / "plan.json")
        for argv in (["automatic", str(f.directory), "--live", "--judge-effort", "low"], ["status", str(f.directory), "--worker-model", "x"],
                     ["start", str(f.directory), "--live", "--profile", "attended"], ["automatic", str(f.directory), "--live", "--restore-from", "HEAD"]):
            with self.subTest(argv):
                code, _, err = pipeline_cli(*argv)
                self.assertEqual(code, 2, err)
                self.assertIn("--profile, --restore-from and the role flags apply to prepare only; the pins cannot change after it", err)
        # The hold (C8) and the finish (C51) are pinned at prepare too: on any other action they would be ignored silently.
        for argv, message in ((["start", str(f.directory), "--live", "--hold-challenge"],
                               "--hold-challenge applies to prepare only: the hold is pinned there (launch --hold-challenge, or prepare --hold-challenge)"),
                              (["automatic", str(f.directory), "--live", "--hold-challenge"],
                               "--hold-challenge applies to prepare only: the hold is pinned there (launch --hold-challenge, or prepare --hold-challenge)"),
                              (["automatic", str(f.directory), "--live", "--critical"],
                               "--critical applies to prepare only; the finish it pins cannot change after it")):
            with self.subTest(argv):
                code, _, err = pipeline_cli(*argv)
                self.assertEqual(code, 2, err)
                self.assertIn(message, err)
        self.assertEqual(read_json(f.directory / "plan.json"), plan)

    def test_the_drift_check_reads_only_the_controller_head_and_prepare_reads_dirt_without_optional_locks(self):
        # The drift check runs at every checkpoint against the operator's live checkout: `git rev-parse HEAD` only, never a
        # `git status`, which may refresh and lock its index. Prepare's one dirty check runs with GIT_OPTIONAL_LOCKS=0.
        from . import sessions
        from .automatic import note_controller_drift
        calls = []
        real = subprocess.check_output

        def record(command, *args, **kwargs):
            calls.append((command[3:], (kwargs.get("env") or {}).get("GIT_OPTIONAL_LOCKS")))
            return real(command, *args, **kwargs)
        f = self.fixture
        self.pin(controller={"commit": "a" * 40, "dirty": False, "claude_version": None})
        with patch("workflow.sessions.subprocess.check_output", side_effect=record):
            note_controller_drift(f.runtime)
        self.assertEqual(calls, [(["rev-parse", "HEAD"], None)])
        calls.clear()
        with patch("workflow.sessions.subprocess.check_output", side_effect=record), patch("workflow.sessions.claude_version", return_value=None):
            record_ = sessions.controller_record()
        self.assertEqual(calls, [(["rev-parse", "HEAD"], None), (["status", "--porcelain", "--untracked-files=no"], "0")])
        self.assertIsInstance(record_["dirty"], bool)

    def test_a_step_on_another_controller_commit_than_the_pinned_one_writes_one_warning(self):
        from .automatic import note_controller_drift
        f = self.fixture
        events = lambda: [event for event in map(json.loads, (f.directory / "events.jsonl").read_text().splitlines()) if event["status"] == "warning"] \
            if (f.directory / "events.jsonl").exists() else []
        note_controller_drift(f.runtime, "b" * 40)  # A plan pinned before the record compares nothing.
        self.pin(controller={"commit": "a" * 40, "dirty": False, "claude_version": "2.1.288 (Claude Code)"})
        note_controller_drift(f.runtime, "a" * 40)
        self.assertEqual(events(), [])
        for _ in range(3):  # Every checkpoint runs a new automatic-step: the same drift is said once.
            note_controller_drift(f.runtime, "b" * 40)
        [warning] = events()
        self.assertEqual((warning["node"], warning["message"]),
                         ("controller", f"Controller commit {'b' * 12} runs this step, not {'a' * 12} pinned at prepare: the controller checkout "
                                        "moved during the run"))
        note_controller_drift(f.runtime, "c" * 40)
        self.assertEqual(len(events()), 2)
        # A malformed line in the log (the tolerant reader, as the shared .git check uses) never stops the step.
        path = f.directory / "events.jsonl"
        path.write_text("{not json\n" + path.read_text())
        note_controller_drift(f.runtime, "c" * 40)
        self.assertEqual(len([line for line in path.read_text().splitlines() if '"warning"' in line]), 2)

    def test_a_changed_shared_git_is_a_warning_at_freeze_review_and_integrate_never_a_refusal(self):
        # C25: prepare recorded a digest of what in the shared .git can make a Git command run something. Freeze (after the
        # workers stop), the review node (before the review diff) and integrate compare against it; a change is one named
        # event naming the keys or files, and the run goes on. The same report is never repeated; status shows the latest.
        f = self.fixture
        self.pin()
        common = f.repo / ".git"
        with self.graph() as graph:
            graph.invoke({"run_id": "run"}, f.config)
            with (common / "info" / "attributes").open("a") as handle:
                handle.write("*.txt -diff\n")  # Turns a text change into an opaque binary patch in review.diff.
            outcome = graph.invoke(Command(resume={"freeze": True}), f.config)
            self.assertEqual(outcome["__interrupt__"][0].value["kind"], "independent_review")
            decision = f.review()
            hook = common / "hooks" / "post-checkout"
            hook.write_text("#!/bin/sh\nexit 0\n")
            hook.chmod(0o755)
            outcome = graph.invoke(Command(resume=decision), f.config)  # The review node runs again from its start.
            self.assertEqual(outcome["__interrupt__"][0].value["kind"], "integration_approval")
            git(f.repo, "config", "filter.planted.clean", "cat")
            commit = graph.invoke(Command(resume={"approve": decision["bundle_sha256"]}), f.config)["integrated_commit"]
            report(f.runtime, graph.get_state(f.config))
        self.assertEqual(git(f.repo, "rev-parse", "HEAD"), commit)
        warnings = [(event["node"], event["message"]) for event in map(json.loads, (f.directory / "events.jsonl").read_text().splitlines())
                    if event["status"] == "warning"]
        self.assertEqual(warnings, [("freeze", "Shared .git changed during the run: info/attributes"),
                                    ("review", "Shared .git changed during the run: hooks/post-checkout, info/attributes"),
                                    ("integrate", "Shared .git changed during the run: hooks/post-checkout, info/attributes, local filter.planted.clean")])
        freeze = [message for status, message in self.events("freeze")]
        self.assertLess(freeze.index("Fake workers have no background processes"), freeze.index(warnings[0][1]))
        self.assertLess(freeze.index(warnings[0][1]), freeze.index("Immutable snapshots captured; worker-reported checks are not trusted"))
        self.assertEqual(self.status()[0]["shared_git"], warnings[-1][1])
        # Compared again with nothing new: nothing more is recorded.
        f.runtime.check_shared_git("integrate")
        self.assertEqual(len([line for line in (f.directory / "events.jsonl").read_text().splitlines() if '"warning"' in line]), 3)

    def test_runs_prepared_before_the_shared_git_digest_compare_nothing(self):
        f = self.fixture
        f.plan.pop("shared_git")
        self.pin()
        (f.repo / ".git" / "info" / "attributes").write_text("*.txt -diff\n")
        f.runtime.check_shared_git("freeze")
        self.assertFalse((f.directory / "events.jsonl").exists())
        self.assertNotIn("shared_git", self.status()[0])


class AdvanceTests(unittest.TestCase):
    def test_every_step_is_exported_as_it_ends_and_a_failed_export_never_fails_the_step(self):
        from typing import TypedDict
        from langgraph.graph import END, START, StateGraph
        from . import pipeline

        class State(TypedDict, total=False):
            first: str
            second: str
        seen = []
        def second(state):
            # The first step's export happened before this one ran: the viewer does not wait for the whole invoke.
            self.assertEqual(seen, [({"first": "done"}, ("second",))])
            return {"second": "done"}
        builder = StateGraph(State)
        builder.add_node("first", lambda _state: {"first": "done"})
        builder.add_node("second", second)
        builder.add_edge(START, "first")
        builder.add_edge("first", "second")
        builder.add_edge("second", END)
        def exported(_runtime, state):
            seen.append((dict(state.values), tuple(state.next)))
            if len(seen) == 2:
                raise OSError("disk full")
        with tempfile.TemporaryDirectory() as root, SqliteSaver.from_conn_string(str(Path(root) / "graph.sqlite")) as saver:
            graph = builder.compile(checkpointer=saver)
            config = {"configurable": {"thread_id": "run"}}
            with patch.object(pipeline, "report", exported), patch("sys.stderr") as stderr:
                pipeline.advance(SimpleNamespace(), graph, {}, config)
            self.assertEqual(graph.get_state(config).values, {"first": "done", "second": "done"})
        self.assertEqual(seen[1], ({"first": "done", "second": "done"}, ()))
        self.assertIn("disk full", "".join(str(call) for call in stderr.write.call_args_list))


def append_many(directory: str, node: str, count: int) -> None:
    from .pipeline import append_event
    for index in range(count):
        append_event(Path(directory), node, "running", f"{node} row {index}")


class EventLogTests(unittest.TestCase):
    def test_processes_appending_at_once_number_their_events_strictly_increasing(self):
        """`answer` and `note` append beside a running automatic controller, each from its own process: the events lock
        keeps one sequence per line, which the viewer's reader requires (server/projects.ts readEvents)."""
        import multiprocessing
        context = multiprocessing.get_context("fork")
        with tempfile.TemporaryDirectory() as temp:
            writers = [context.Process(target=append_many, args=(temp, f"lane{index}", 40)) for index in range(4)]
            for writer in writers:
                writer.start()
            for writer in writers:
                writer.join(60)
                self.assertEqual(writer.exitcode, 0)
            events = [json.loads(line) for line in (Path(temp) / "events.jsonl").read_text().splitlines()]
        self.assertEqual([event["sequence"] for event in events], list(range(1, 161)))


class CandidateRefTests(unittest.TestCase):
    """C47 via C30: the candidate commit gets refs/workflow/<run hash>/candidate when the candidate step creates it, so a follow-up
    run can restore it after the candidate worktree is cleaned up."""

    def test_the_candidate_step_writes_the_candidate_ref(self):
        from .pipeline import CANDIDATE_REF, run_ref
        from .test_brief import commit
        f = PipelineTests()
        f.setUp()
        self.addCleanup(f.doCleanups)
        snapshots, packets = {}, {}
        for lane, (path, text) in LANE_EDITS.items():
            sha = commit(f.repo, lane, {path: text})
            snapshots[lane] = {"commit": sha, "changed_files": [path], "session_id": f"{lane}-session", "summary": "done", "open_assumptions": []}
            packets[lane] = f.directory / "verification" / "worker" / lane / "1" / "packet.json"
            packets[lane].parent.mkdir(parents=True)
            save_json(packets[lane], {"gate": {"status": "passed"}, "expected": {"output_commit": sha}})

        def verified(directory, plan, policy, node, commit_, changed, session, phase="worker", attempt=1):
            # A packet with no checks: the candidate step reads its result and evidence for C27's slow note.
            packet = {"gate": {"status": "passed", "reasons": []}, "expected": {"output_commit": commit_}, "result": {"checks": []}, "evidence": {"checks": []}}
            path = directory / "verification" / phase / node / str(attempt) / "packet.json"
            path.parent.mkdir(parents=True, exist_ok=True)
            save_json(path, packet)
            return packet

        with patch("workflow.pipeline.recheck_packet", side_effect=lambda packet, *_: packet), patch("workflow.pipeline.verify_revision", side_effect=verified):
            f.runtime.candidate({"snapshots": snapshots, "packets": {lane: str(path) for lane, path in packets.items()}})
        candidate = read_json(f.directory / "candidate.json")["commit"]
        self.assertEqual(git(f.repo, "rev-parse", run_ref(f.directory, CANDIDATE_REF)), candidate)
        # The candidate worktree's removal leaves the commit reachable by its ref.
        git(f.repo, "worktree", "remove", "--force", str(f.directory / "candidate"))
        self.assertEqual(git(f.repo, "rev-parse", f"{run_ref(f.directory, CANDIDATE_REF)}^{{commit}}"), candidate)
        # The brief names the ref, so its recipe still works once Git prunes what no ref holds.
        from .test_brief import brief
        code, out, err = brief(f.directory)
        self.assertEqual(code, 0, err)
        self.assertIn(f"- Candidate: {candidate} (kept as {run_ref(f.directory, CANDIDATE_REF)})", out)


class AbandonTests(unittest.TestCase):
    """C30: `abandon <run> --reason --by operator` closes a dead run: it stops the recorded sessions by exact id, writes
    abandon.json and one controller `cancelled` event, and every gate command refuses the run afterwards; status and export read it."""

    REASON = "Usage limit hit during review; followed up by run-002"

    def setUp(self):
        self.fixture = PipelineTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        f = self.fixture
        self.directory = f.directory
        for node in ("ui", "adapter", "review"):
            save_json(f.directory / f"{node}.interactive.json", {"node_id": node, "background_id": f"id-{node}", "session_id": f"session-{node}"})
        # ui and the reviewer still run; adapter's session ended (a usage limit): it is not listed and gets no stop.
        self.live = {node: {"id": f"id-{node}", "sessionId": f"session-{node}", "pid": os.getpid(), "state": "idle"} for node in ("ui", "review")}
        live = self.live
        self.inventories = 0

        def inventory():
            self.inventories += 1
            return list(live.values())

        def locate(node, rows):
            # As InteractiveSessions.locate: the receipt's background id, else the one id its launch log printed.
            receipt = read_json(f.directory / f"{node}.interactive.json")
            background_id = receipt.get("background_id")
            if not background_id:
                log = f.directory / f"{node}.launch.log"
                if not log.exists():
                    return None
                ids = set(re.findall(r"claude attach ([a-z0-9-]+)\s", log.read_text()))
                if len(ids) != 1:
                    raise RuntimeError("Missing/ambiguous native launch ID; reconcile manually")
                background_id = ids.pop()
            row = next((row for row in rows if row["id"] == background_id), None)
            if row is not None and row.get("name", f"workflow-run-{node}") != f"workflow-run-{node}":
                raise RuntimeError("Claude session identity/worktree mismatch")
            if row is not None and row.get("state") not in {"idle", "working", "blocked", "done"}:
                raise RuntimeError(f"Session is not attachable: {row.get('state')!r}; reconcile manually")
            if row is not None and not row.get("pid"):
                raise RuntimeError("No live native PID; reconcile session before attaching")
            return row
        self.sessions = SimpleNamespace(executable="claude", directory=f.directory, inventory=inventory, locate=locate)

    def abandon(self, *argv: str) -> tuple[int, str, list]:
        from .abandon import abandon_main
        live = self.live

        def stop(argv, **_kwargs):
            for node in [node for node, row in live.items() if row["id"] == argv[-1]]:
                live.pop(node)
            return subprocess.CompletedProcess(argv, 0)
        output = io.StringIO()
        code = 0
        with patch("workflow.pipeline.InteractiveSessions", return_value=self.sessions), patch("workflow.pipeline.subprocess.run", side_effect=stop) as command, \
                patch("workflow.pipeline.pid_alive", return_value=False), contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
            try:
                abandon_main([str(self.directory), *argv])
            except SystemExit as exit_:
                code = exit_.code
        return code, output.getvalue(), [call.args[0] for call in command.call_args_list]

    def events(self) -> list:
        return [json.loads(line) for line in (self.directory / "events.jsonl").read_text().splitlines()] if (self.directory / "events.jsonl").exists() else []

    def test_abandon_stops_each_recorded_session_once_and_records_the_reason(self):
        code, output, stops = self.abandon("--reason", self.REASON, "--by", "operator")
        self.assertEqual(code, 0, output)
        self.assertEqual(stops, [["claude", "stop", "id-ui"], ["claude", "stop", "id-review"]])
        record = read_json(self.directory / "abandon.json")
        self.assertEqual((record["reason"], record["by"], record["stopped"], record["not_running"]), (self.REASON, "operator", ["ui", "review"], ["adapter"]))
        cancelled = [event for event in self.events() if event["status"] == "cancelled"]
        self.assertEqual([(event["node"], event["message"]) for event in cancelled],
                         [("controller", f"Abandoned by the operator: {self.REASON}. Stopped: ui, review; not running: adapter")])
        # Once abandoned, a second abandon changes nothing and stops nothing.
        code, output, stops = self.abandon("--reason", "again", "--by", "operator")
        self.assertEqual((code, stops), (1, []))
        self.assertIn("already abandoned", output)
        self.assertEqual(read_json(self.directory / "abandon.json")["reason"], self.REASON)
        self.assertEqual(len([event for event in self.events() if event["status"] == "cancelled"]), 1)

    def test_a_session_whose_launch_receipt_was_never_bound_is_stopped(self):
        # The settle step failed (Claude Code unavailable, or Ctrl-C): the receipt has no ids, but the launch log names the
        # session, which still runs and uses quota.
        save_json(self.directory / "review.interactive.json", {"node_id": "review", "session_id": None, "status": "needs_reconciliation"})
        self.live["review"]["id"] = "4f3a2b1c"
        (self.directory / "review.launch.log").write_text("Started in the background.\nclaude attach 4f3a2b1c \n")
        code, output, stops = self.abandon("--reason", self.REASON, "--by", "operator")
        self.assertEqual(code, 0, output)
        self.assertEqual(stops, [["claude", "stop", "id-ui"], ["claude", "stop", "4f3a2b1c"]])
        record = read_json(self.directory / "abandon.json")
        self.assertEqual((record["stopped"], record["not_running"]), (["ui", "review"], ["adapter"]))
        self.assertNotIn("review", self.live)

    def test_a_bound_session_listed_without_a_pid_is_stopped_through_the_respawn_gap(self):
        # A Claude Code restart: the service lists ui without a PID for about 15 s before it respawns it. The session is
        # still there, so abandon stops it (stop_session waits the gap out) rather than recording it as not running.
        listings = []
        inventory = self.sessions.inventory

        def respawning():
            rows = inventory()
            listings.append(1)
            return [{**row, "pid": None} if row["id"] == "id-ui" and len(listings) == 1 else row for row in rows]
        self.sessions.inventory = respawning
        code, output, stops = self.abandon("--reason", self.REASON, "--by", "operator")
        self.assertEqual(code, 0, output)
        self.assertEqual(stops, [["claude", "stop", "id-ui"], ["claude", "stop", "id-review"]])
        self.assertEqual(read_json(self.directory / "abandon.json")["stopped"], ["ui", "review"])

    def test_an_unbound_session_still_starting_is_a_failure_and_a_terminal_one_is_not_running(self):
        save_json(self.directory / "review.interactive.json", {"node_id": "review", "session_id": None, "status": "needs_reconciliation"})
        (self.directory / "review.launch.log").write_text("Started in the background.\nclaude attach 4f3a2b1c \n")
        self.live["review"] = {"id": "4f3a2b1c", "sessionId": "session-review", "pid": None, "state": "starting"}
        code, output, stops = self.abandon("--reason", self.REASON, "--by", "operator")
        self.assertEqual(code, 1, output)
        self.assertIn("review: Session is not attachable: 'starting'", output)
        self.assertFalse((self.directory / "abandon.json").exists())
        self.live["review"]["state"] = "failed"  # Rerun once it ended: a terminal row is not running.
        code, output, stops = self.abandon("--reason", self.REASON, "--by", "operator")
        self.assertEqual((code, stops), (0, []), output)
        # ui's stop was confirmed by the first attempt; its marker keeps it from being issued again.
        self.assertEqual(read_json(self.directory / "abandon.json")["not_running"], ["ui", "adapter", "review"])

    def test_an_unavailable_listing_is_waited_out_once_not_once_per_node(self):
        from .sessions import TransientInfraError

        def unavailable():
            self.inventories += 1
            raise TransientInfraError("Claude Code unavailable: `claude agents --json` exited 75")
        self.sessions.inventory = unavailable
        code, output, stops = self.abandon("--reason", self.REASON, "--by", "operator")
        self.assertEqual((code, stops, self.inventories), (1, [], 1), output)
        self.assertEqual(output.count("exited 75"), 1, output)
        self.assertFalse((self.directory / "abandon.json").exists())

    def test_a_listing_that_fails_inside_a_stop_ends_the_abandon_after_one_wait(self):
        # abandon's own listing worked; then Claude Code restarts (an update) while the first stop lists again.
        from .sessions import TransientInfraError
        listed = self.sessions.inventory

        def later_unavailable():
            if self.inventories == 0:
                return listed()
            self.inventories += 1
            raise TransientInfraError("Claude Code unavailable: inventory unavailable for 60s")
        self.sessions.inventory = later_unavailable
        code, output, stops = self.abandon("--reason", self.REASON, "--by", "operator")
        self.assertEqual(code, 1, output)
        self.assertEqual(self.inventories, 2, output)  # abandon's own listing, then the one waited listing of ui's stop.
        self.assertEqual(output.count("inventory unavailable for 60s"), 1, output)
        self.assertIn("Not abandoned: `claude agents --json` gave no session list", output)
        self.assertFalse((self.directory / "abandon.json").exists())

    def test_a_respawn_that_never_comes_fails_that_stop_and_the_other_sessions_are_still_stopped(self):
        # The listing works, but ui stays listed without a PID: its respawn gap outlasts the grace. That is ui's stop not
        # confirmed, not a failed listing, so the reviewer is still stopped and nothing blames `claude agents --json`.
        self.live["ui"]["pid"] = None
        with patch("workflow.interactive.DEAD_PID_GRACE_SECONDS", 0), patch("workflow.pipeline.time.sleep", return_value=None):
            code, output, stops = self.abandon("--reason", self.REASON, "--by", "operator")
        self.assertEqual(code, 1, output)
        self.assertEqual(stops, [["claude", "stop", "id-review"]])
        self.assertIn("Not abandoned; stops not confirmed: ui: Claude Code has not listed a live ui session (id-ui)", output)
        self.assertNotIn("gave no session list", output)
        self.assertNotIn("claude --version", output)
        self.assertFalse((self.directory / "abandon.json").exists())

    def test_an_identity_refusal_is_a_failure_not_a_session_that_is_not_running(self):
        self.live["review"]["name"] = "workflow-other-run-review"
        code, output, stops = self.abandon("--reason", self.REASON, "--by", "operator")
        self.assertEqual(code, 1, output)
        self.assertIn("review: Claude session identity/worktree mismatch", output)
        self.assertFalse((self.directory / "abandon.json").exists())
        self.assertEqual([event for event in self.events() if event["status"] == "cancelled"], [])

    def test_a_node_the_controller_stopped_before_is_not_running_and_gets_no_stop(self):
        self.live.pop("ui")
        save_json(self.directory / "ui.stop.json", {"background_id": "id-ui", "session_id": "session-ui", "pid": 999999, "stopped": True, "issued": True})
        code, output, stops = self.abandon("--reason", self.REASON, "--by", "operator")
        self.assertEqual(code, 0, output)
        self.assertEqual(stops, [["claude", "stop", "id-review"]])
        self.assertEqual(read_json(self.directory / "abandon.json")["not_running"], ["ui", "adapter"])

    def test_an_unfinished_stop_of_a_session_that_is_gone_completes_the_abandon(self):
        # A controller stop that failed (claude stop exited non-zero while the service restarted) left issued false; the
        # session has ended since. stop_session would look through the respawn gap and raise on every attempt.
        self.live.pop("ui")
        save_json(self.directory / "ui.stop.json", {"background_id": "id-ui", "session_id": "session-ui", "pid": 999999, "stopped": False, "issued": False})
        from .pipeline import Pipeline
        stop_row = Pipeline.stop_row

        def no_wait_for_ui(pipeline, node, rows):
            if node == "ui":
                raise AssertionError("waited for a respawn")
            return stop_row(pipeline, node, rows)
        with patch("workflow.abandon.pid_alive", return_value=False), patch.object(Pipeline, "stop_row", autospec=True, side_effect=no_wait_for_ui):
            code, output, stops = self.abandon("--reason", self.REASON, "--by", "operator")
        self.assertEqual(code, 0, output)
        self.assertEqual(stops, [["claude", "stop", "id-review"]])
        self.assertEqual(read_json(self.directory / "abandon.json")["not_running"], ["ui", "adapter"])

    def test_an_unfinished_stop_of_a_live_session_is_completed(self):
        save_json(self.directory / "ui.stop.json", {"background_id": "id-ui", "session_id": "session-ui", "pid": os.getpid(), "stopped": False, "issued": False})
        code, output, stops = self.abandon("--reason", self.REASON, "--by", "operator")
        self.assertEqual(code, 0, output)
        self.assertEqual(stops, [["claude", "stop", "id-ui"], ["claude", "stop", "id-review"]])
        self.assertTrue(read_json(self.directory / "ui.stop.json")["stopped"])

    def test_a_run_that_never_launched_is_abandoned_without_claude_code(self):
        for node in ("ui", "adapter", "review"):
            (self.directory / f"{node}.interactive.json").unlink()
        code, output, stops = self.abandon("--reason", self.REASON, "--by", "operator")
        self.assertEqual((code, stops, self.inventories), (0, [], 0), output)
        self.assertEqual(read_json(self.directory / "abandon.json")["not_running"], [])

    def test_listing_failures_on_the_real_sessions_restores_the_class_method(self):
        # The production path: inventory is InteractiveSessions' own method, shadowed by an instance attribute for the block
        # and deleted afterwards, after a normal exit and after an error alike.
        from .abandon import ListingUnavailable, listing_failures
        from .interactive import InteractiveSessions
        from .sessions import TransientInfraError
        sessions = InteractiveSessions(self.directory)
        with patch("workflow.interactive.run_claude", side_effect=subprocess.TimeoutExpired(["claude", "agents"], 15)):
            with listing_failures(sessions):
                self.assertIn("inventory", vars(sessions))
                with self.assertRaises(ListingUnavailable) as caught:
                    sessions.inventory()
                self.assertIsInstance(caught.exception.__cause__, TransientInfraError)
            self.assertNotIn("inventory", vars(sessions))
            self.assertIs(sessions.inventory.__func__, InteractiveSessions.inventory)
            with self.assertRaises(ListingUnavailable), listing_failures(sessions):
                sessions.inventory()
            self.assertNotIn("inventory", vars(sessions))
            self.assertIs(sessions.inventory.__func__, InteractiveSessions.inventory)
            with self.assertRaises(TransientInfraError):
                sessions.inventory()  # Outside the block, the class's own failure again.

    def test_abandon_is_the_operators_and_refuses_a_held_lock_or_an_empty_reason(self):
        for argv, refusal in ((["--reason", self.REASON, "--by", "maintainer"], "abandon is the operator's decision"),
                              (["--reason", self.REASON], "abandon requires --by operator"),
                              (["--reason", "  ", "--by", "operator"], "--reason")):
            with self.subTest(argv=argv):
                code, output, stops = self.abandon(*argv)
                self.assertEqual((code, stops), (1, []))
                self.assertIn(refusal, output)
        for lock in ("automatic-supervisor.lock", "controller.lock"):
            with self.subTest(lock=lock), run_lock(self.directory, lock):
                code, output, stops = self.abandon("--reason", self.REASON, "--by", "operator")
                self.assertEqual((code, stops), (1, []))
                self.assertIn("Another controller owns this run", output)
        self.assertFalse((self.directory / "abandon.json").exists())
        self.assertEqual([event for event in self.events() if event["status"] == "cancelled"], [])

    def test_every_gate_command_refuses_an_abandoned_run_while_status_and_export_read_it(self):
        from .guardrails import answer_main, resume_main
        from .notes import note_main
        from .repair import repair_main
        from .sidecar import pass_main
        from .tryout import tryout_main
        code, output, _ = self.abandon("--reason", self.REASON, "--by", "operator")
        self.assertEqual(code, 0, output)
        run = str(self.directory)
        events = len(self.events())
        for action in (["automatic", run, "--live"], ["automatic-step", run, "--live"], ["start", run, "--live"], ["retry", run], ["reconcile", run],
                       ["freeze", run], ["review", run, "--review-file", run], ["approve", run, "--bundle-sha256", "0" * 64], ["attach", run]):
            with self.subTest(action=action[0]):
                code, out, err = pipeline_cli(*action)
                self.assertEqual(code, 1, out + err)
                self.assertIn("abandoned", err)
        for name, main, argv in (("resume", resume_main, [run, "--by", "operator"]), ("resume --launch", resume_main, [run, "--launch", "--by", "operator"]),
                                 ("accept-challenge", resume_main, [run, "--accept-challenge", "fine", "--by", "operator"]), ("answer", answer_main, [run, "ui", "Yes", "--by", "operator"]),
                                 ("note", note_main, [run, "ui", "Hold", "--by", "operator"]), ("sidecar-pass", pass_main, [run]),
                                 ("repair", repair_main, [run, "ui", "--commit", "HEAD", "--reason", "fix", "--by", "operator"]),
                                 ("tryout", tryout_main, [run, "--result", "works", "--by", "operator"])):
            with self.subTest(action=name):
                err = io.StringIO()
                with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(err), self.assertRaises(SystemExit) as exit_:
                    main(argv)
                self.assertEqual(exit_.exception.code, 1)
                self.assertIn("abandoned", err.getvalue())
        self.assertEqual(len(self.events()), events)  # No refusal wrote an event.
        code, out, err = pipeline_cli("status", run)
        self.assertEqual(code, 0, err)
        status = json.loads(out.split("\nReport:")[0])
        self.assertEqual(status["abandoned"]["reason"], self.REASON)
        self.assertTrue(status["next_step"].startswith("none: the run was abandoned by the operator"), status["next_step"])
        self.assertIn("brief", status["next_step"])
        self.assertIn("launch <feature> --repo <target repo> --run-id", status["next_step"])
        code, out, err = pipeline_cli("export", run)
        self.assertEqual(code, 0, err)


class ActorTests(unittest.TestCase):
    """C17: every gate action names who runs it (--by operator|maintainer, no default); the maintainer, a Claude session acting
    for the operator, is refused the operator's decisions. Both refusals come before the run directory is read."""

    def run_main(self, main, argv: list) -> tuple[int, str]:
        output = io.StringIO()
        code = 0
        with patch.object(sys, "argv", ["workflow", *argv]), patch.dict(os.environ), contextlib.redirect_stdout(output), \
                contextlib.redirect_stderr(output):
            try:
                main() if argv and main.__module__ == "workflow.pipeline" else main(argv)
            except SystemExit as exit_:
                code = exit_.code
        return code, output.getvalue()

    def gates(self, missing: Path) -> list:
        from . import pipeline
        from .guardrails import answer_main, resume_main
        from .launch import main as launch_main
        from .notes import note_main
        from .abandon import abandon_main
        from .repair import repair_main
        from .tryout import tryout_main
        run = str(missing)
        return [("start", pipeline.main, ["start", run, "--live"]), ("automatic", pipeline.main, ["automatic", run, "--live"]),
                ("retry", pipeline.main, ["retry", run]), ("reconcile", pipeline.main, ["reconcile", run]),
                ("approve", pipeline.main, ["approve", run, "--bundle-sha256", "0" * 64]), ("resume", resume_main, [run]),
                ("accept-challenge", resume_main, [run, "--accept-challenge", "fine"]), ("resume --launch", resume_main, [run, "--launch"]),
                ("answer", answer_main, [run, "ui", "A"]),
                ("repair", repair_main, [run, "ui", "--commit", "HEAD", "--reason", "fix"]),
                ("launch", launch_main, ["demo", "--repo", run, "--live"]), ("note", note_main, [run, "ui", "Hold the tests."]),
                ("abandon", abandon_main, [run, "--reason", "dead"]), ("tryout", tryout_main, [run, "--result", "works"])]

    def test_every_gate_refuses_a_missing_by_before_it_reads_the_run(self):
        with tempfile.TemporaryDirectory() as temp:
            for action, main, argv in self.gates(Path(temp) / "missing"):
                with self.subTest(action=action):
                    code, output = self.run_main(main, argv)
                    self.assertNotEqual(code, 0)
                    # An operator decision names only the operator: --by maintainer would be refused next.
                    self.assertIn(f"{action} requires --by operator: " if action in OPERATOR_ONLY else f"{action} requires --by operator|maintainer", output)
                    self.assertNotIn("No such file", output)

    def test_the_maintainer_is_refused_the_operators_decisions_before_it_reads_the_run(self):
        refused = {"approve", "accept-challenge", "resume --launch", "answer", "repair", "launch", "abandon", "tryout"}
        with tempfile.TemporaryDirectory() as temp:
            for action, main, argv in self.gates(Path(temp) / "missing"):
                code, output = self.run_main(main, [*argv, "--by", "maintainer"])
                with self.subTest(action=action):
                    self.assertNotEqual(code, 0)  # The run does not exist: every gate stops, the allowed ones on the missing run.
                    if action in refused:
                        self.assertIn(f"{action} is the operator's decision: --by maintainer is refused", output)
                    else:
                        self.assertNotIn("--by maintainer is refused", output)

    def test_the_actor_text_names_a_claude_code_session_without_refusing_it(self):
        from .actor import actor_text, require_actor
        with patch.dict(os.environ, {"CLAUDECODE": "1"}):
            self.assertEqual(actor_text("operator"), "the operator (via a Claude Code session)")
            self.assertEqual(require_actor(SimpleNamespace(by="operator"), "approve"), "operator")
        with patch.dict(os.environ, {"CLAUDECODE": ""}):
            self.assertEqual(actor_text("maintainer"), "the maintainer")


if __name__ == "__main__":
    unittest.main()


class PanelLaunchGuards(unittest.TestCase):
    """feature.json 2.6.0 `panels` (docs/PRD_MULTI_PROVIDER_PANEL.md 4.2; engine acceptance item 7): every launch refusal, dry run
    included, through launch_commands with the transport proofs behind the injectable seam (no binary spawned); and a full
    2.6.0 feature carrying prd + sidecar + attack + critical + a review panel launches, with prepare pinning plan.panels last."""

    TASK = "## Goal\n\nBuild it.\n\n## Acceptance\n\nIt runs.\n\n## Stop\n\nAfter three failed fixes.\n"

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.repo = self.tmp / "target"
        shutil.copytree(Path(__file__).resolve().parent / "testdata" / "project-workflows", self.repo / "features/project-workflows")
        self.folder = self.repo / "features/project-workflows"
        for name in ("ui-task.md", "adapter-task.md"):
            (self.folder / name).write_text(self.TASK)
        (self.folder / "decisions.md").write_text("# Decisions\n\n## Operator decisions\n\n- [O1] Build it.\n")
        (self.folder / "panels").mkdir()
        (self.folder / "panels" / "review.md").write_text("THE FEATURE'S PANEL BRIEF\n")
        (self.repo / "docs" / "security").mkdir(parents=True)
        (self.repo / "docs" / "PRD.md").write_text("# PRD\n")
        (self.repo / "docs" / "security" / "requirements.md").write_text("SEC-1: text\n")
        policy = read_json(self.folder / "policy.json")
        policy["version"] = "1.3.0"
        policy["attack_check"] = {"argv": ["sh", "{file}"], "timeout_seconds": 60}
        save_json(self.folder / "policy.json", policy)
        self.panel = {"id": "review-panel", "stage": "review", "providers": [{"transport": "claude", "effort": "high"}, {"transport": "pi", "model": "openai-codex/gpt-6-sol"}],
                      "prompt": "panels/review.md", "requirements": ["docs/security/requirements.md"], "budget_usd": 5, "timeout_minutes": 15,
                      "overlap_threshold": 2, "report_only": True}
        self.write_feature()
        environment = patch.dict(os.environ, {"MD_MANAGER_PROJECTS_CONFIG": str(self.tmp / "projects.json"), "HOME": str(self.tmp / "home")})
        environment.start()
        self.addCleanup(environment.stop)
        secrets = patch("workflow.attack.default_secret_files", return_value=[])
        secrets.start()
        self.addCleanup(secrets.stop)

    def write_feature(self, version="2.6.0", **over):
        manifest = read_json(self.folder / "feature.json")
        manifest.update(version=version, prd="docs/PRD.md", critical=True, sidecar={"prompt": "builtin:senior-review"},
                        attack={"angles": ["auth-funds"], "requirements": ["docs/security/requirements.md"]}, panels=[dict(self.panel)])
        manifest.update(over)
        save_json(self.folder / "feature.json", manifest)
        for args in (["init", "-q"], ["config", "user.name", "Test"], ["config", "user.email", "test@example.invalid"], ["add", "."], ["commit", "-qm", "Feature", "--allow-empty"]):
            subprocess.run(["git", "-C", str(self.repo), *args], check=True, capture_output=True)

    @staticmethod
    def prove(help_text="--print --max-budget-usd --effort", pi="/nvm/bin/pi"):
        from . import panel

        def run(argv, **kwargs):
            return SimpleNamespace(returncode=0, stdout=help_text if argv[1] == "--help" else "0.85.1\n")
        which = lambda name, path=None: {"claude": "/x/claude", "pi": pi}.get(name)
        return lambda panels: panel.prove_transports(panels, run=run, environ={"PATH": "/x"}, which=which)

    def launch(self, **kwargs):
        from .launch import launch_commands
        return launch_commands(self.repo, "project-workflows", "pw-001", self.tmp / "runs", automatic=True, prove=kwargs.pop("prove", self.prove()), **kwargs)

    def test_each_refusal_before_any_git_action(self):
        self.write_feature(version="2.5.0")
        with self.assertRaisesRegex(ValueError, "panels needs version 2.6.0"):
            self.launch()
        for over, pattern in (({"panels": [{**self.panel, "report_only": False}]}, "report_only must be true"),
                              ({"panels": [{**self.panel, "providers": [{"transport": "pi"}]}]}, "needs a model of the form provider/id"),
                              ({"panels": [{**self.panel, "providers": [{"transport": "pi", "model": "deepseek/deepseek-v4-pro"}]}]}, "Blocked: the DeepSeek key"),
                              ({"panels": [{**self.panel, "stage": "challenge"}]}, "review stage only"),
                              ({"panels": [{**self.panel, "prompt": "panels/missing.md"}]}, "missing or empty")):
            self.write_feature(**over)
            with self.assertRaisesRegex(ValueError, pattern):
                self.launch()
        self.write_feature()
        with self.assertRaisesRegex(ValueError, "lacks --max-budget-usd"):
            self.launch(prove=self.prove(help_text="--print --effort"))
        with self.assertRaisesRegex(ValueError, "needs `pi`"):
            self.launch(prove=self.prove(pi=None))
        self.assertFalse((self.tmp / "runs").exists())

    def test_a_full_2_6_0_feature_launches_and_the_dry_run_prints_the_panels(self):
        run, commands, _ = self.launch()
        preflight, prepare = commands[0], commands[2]
        self.assertIn("--attack", preflight)
        self.assertEqual(preflight[preflight.index("--panels") + 1], "claude,pi")
        self.assertIn("--critical", prepare)
        self.assertIn("--sidecar-brief", prepare)
        self.assertIn("--attack-settings", prepare)
        settings = json.loads(prepare[prepare.index("--panel-settings") + 1])
        self.assertEqual(settings["pi_bin"], "/nvm/bin")
        [item] = settings["panels"]
        self.assertTrue(item["prompt"].endswith("features/project-workflows/panels/review.md"))
        self.assertNotIn(str(self.repo), item["prompt"])  # The brief at its path in the run's source checkout, as the tasks are.
        self.assertEqual((item["requirements"], item["overlap_threshold"], item["report_only"]), (["docs/security/requirements.md"], 2, True))
        # The dry run prints what prepare pins, and executes only the two probes (patched here).
        from .launch import main
        out = io.StringIO()
        with patch("workflow.panel.prove_transports", return_value={"pi_bin": "/nvm/bin"}), contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()):
            main(["project-workflows", "--repo", str(self.repo), "--run-root", str(self.tmp / "runs"), "--dry-run", "--automatic"])
        printed = json.loads(out.getvalue())
        self.assertFalse(printed["executes"])
        self.assertEqual(printed["panels"]["pi_bin"], "/nvm/bin")
        self.assertEqual(printed["panels"]["panels"][0]["id"], "review-panel")
        self.assertEqual(printed["guardrails"]["feature_version"], "2.6.0")
        self.assertFalse((self.tmp / "runs").exists())

    def test_a_2_7_0_feature_keeps_every_gate_a_2_6_0_feature_has(self):
        # The version gates are sets, not ranges: a 2.4.0 bump once silently dropped every guardrail. A 2.7.0 feature (per-lane
        # worker pins) keeps the guardrails, the sidecar, the attack pass, the panels and `critical` exactly as 2.6.0 does.
        from . import attack, guardrails, panel, sidecar
        from .launch import load_feature
        flags = {}
        for version in ("2.6.0", "2.7.0"):
            self.write_feature(version=version)
            manifest = load_feature(self.folder)
            self.assertTrue(guardrails.is_guarded(manifest), version)
            self.assertEqual(sidecar.declared(manifest)["prompt"], "builtin:senior-review")
            self.assertEqual(attack.declared(manifest)["angles"], ["auth-funds"])
            self.assertEqual(panel.declared(manifest)[0]["id"], "review-panel")
            _, commands, _ = self.launch()
            preflight, prepare = commands[0], commands[2]
            flags[version] = ({flag for flag in preflight if flag.startswith("--")},
                              {flag for flag in prepare if flag.startswith("--")})
            for flag in ("--guardrails", "--decisions", "--prd", "--critical", "--sidecar-brief", "--attack-settings", "--panel-settings"):
                self.assertIn(flag, prepare, version)
        self.assertEqual(flags["2.7.0"], flags["2.6.0"])
        self.write_feature(version="2.7.0", tryout=True)
        self.assertTrue(load_feature(self.folder)["tryout"])

    def test_a_2_7_0_lane_pin_reaches_prepare_for_its_selected_lane_only(self):
        workers = [{"node_id": "ui", "task": "ui-task.md", "model": "claude-sonnet-5", "effort": "xhigh"},
                   {"node_id": "adapter", "task": "adapter-task.md", "effort": "low"}]
        self.write_feature(version="2.7.0", workers=workers)
        prepare = self.launch()[1][2]
        lane_flags = [(flag, prepare[index + 1]) for index, flag in enumerate(prepare) if flag in ("--lane-model", "--lane-effort")]
        self.assertEqual(lane_flags, [("--lane-model", "ui=claude-sonnet-5"), ("--lane-effort", "ui=xhigh"), ("--lane-effort", "adapter=low")])
        prepare = self.launch(workers="adapter")[1][2]
        self.assertEqual([prepare[index + 1] for index, flag in enumerate(prepare) if flag.startswith("--lane-")], ["adapter=low"])
        self.write_feature(version="2.6.0", workers=workers)
        with self.assertRaisesRegex(ValueError, r"workers\[ui\]\.model needs version 2\.7\.0"):
            self.launch()
        self.assertFalse((self.tmp / "runs").exists())

    def test_prepare_pins_plan_panels_last_with_the_brief_text_and_sha(self):
        from . import panel
        from .sidecar import BUILTIN_BRIEFS
        run = self.tmp / "runs" / "pw-001"
        subprocess.run(["git", "-C", str(self.repo), "switch", "-q", "-c", "feature/project-workflows/pw-001"], check=True)  # As the launch's worktree is.
        brief = self.folder / "panels" / "review.md"
        settings = {"panels": [{**self.panel, "prompt": str(brief)}], "pi_bin": "/nvm/bin"}
        code, out, err = pipeline_cli("prepare", str(run), "--repo", str(self.repo), "--policy", str(self.folder / "policy.json"),
                                      "--task", f"ui={self.folder / 'ui-task.md'}", "--task", f"adapter={self.folder / 'adapter-task.md'}",
                                      "--guardrails", "--decisions", str(self.folder / "decisions.md"), "--prd", str(self.repo / "docs" / "PRD.md"),
                                      "--sidecar-brief", str(BUILTIN_BRIEFS / "senior-review.md"),
                                      "--attack-settings", json.dumps({"angles": ["auth-funds"], "requirements": ["docs/security/requirements.md"]}),
                                      "--panel-settings", json.dumps(settings), "--automatic", "--critical")
        self.assertEqual(code, 0, err)
        plan = read_json(run / "plan.json")
        self.assertEqual(plan["feature_version"], "2.6.0")  # Pinned last: not the attack's 2.5.0 nor the sidecar's 2.3.0.
        self.assertTrue(plan["attack"]["angles"] == ["auth-funds"] and plan["sidecar"]["prompt"])
        [item] = plan["panels"]
        self.assertEqual(item["prompt"], {"source": str(brief), "text": "THE FEATURE'S PANEL BRIEF\n", "sha256": panel.digest_text("THE FEATURE'S PANEL BRIEF\n")})
        self.assertEqual(item["requirement_docs"], {"docs/security/requirements.md": "SEC-1: text\n"})
        self.assertEqual((item["pi_bin"], item["prd_label"], item["stage"]), ("/nvm/bin", "docs/PRD.md", "review"))
        self.assertEqual(item["providers"], [{"transport": "claude", "model": None, "effort": "high"}, {"transport": "pi", "model": "openai-codex/gpt-6-sol", "effort": None}])
        panel.validate_plan(plan)
        from .export_state import export_state
        from .pipeline import ExportRuntime
        exported = export_state(ExportRuntime(run), SimpleNamespace(tasks=[], values={}, next=[]))
        self.assertEqual(exported["panels"]["panels"][0]["status"], "pending")
        # --panel-settings outside --guardrails, and --panels outside preflight, are refused.
        code, _, err = pipeline_cli("prepare", str(self.tmp / "runs" / "pw-002"), "--repo", str(self.repo), "--policy", str(self.folder / "policy.json"),
                                    "--task", f"ui={self.folder / 'ui-task.md'}", "--task", f"adapter={self.folder / 'adapter-task.md'}",
                                    "--panel-settings", json.dumps(settings))
        self.assertNotEqual(code, 0)
        self.assertIn("--panel-settings applies to prepare --guardrails", err)
