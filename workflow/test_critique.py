"""Tests for the critique reviewer (feature.json 2.9.0, docs/PRD_USER_CRITIQUE.md).

No model call and no network: a fake `claude` (print mode) and a fake app (a tiny HTTP server script), every path under a
temporary directory and HOME. The engine lane of PRD_USER_CRITIQUE section 6.
"""
from __future__ import annotations

import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

from . import critique
from .sessions import read_json, save_json, worker_settings

ROOT = str(Path(__file__).resolve().parents[1])


# ---- Configuration --------------------------------------------------------------------------------------------------

class Config(unittest.TestCase):
    def test_declared_fills_defaults_and_refuses_before_2_9_0(self):
        self.assertIsNone(critique.declared({"version": "2.9.0"}))
        self.assertIsNone(critique.declared({"version": "2.9.0", "critique": False}))
        value = critique.declared({"version": "2.9.0", "critique": {"lanes": ["pages"]}})
        self.assertEqual(value, {"lanes": ["pages"], "skills": ["impeccable"], "max_budget_usd": 15, "timeout_minutes": 45})
        self.assertEqual(critique.declared({"version": "2.10.0", "critique": {"lanes": ["pages"]}}), value)  # 2.10.0 keeps critique
        with self.assertRaisesRegex(ValueError, "version 2.9.0"):
            critique.declared({"version": "2.8.0", "critique": {"lanes": ["pages"]}})

    def test_declared_refuses_bad_lanes_and_bounds(self):
        for bad in ({"lanes": []}, {"lanes": ["Pages"]}, {"lanes": ["a", "a"]}, {"lanes": "pages"}):
            with self.assertRaises(ValueError):
                critique.declared({"version": "2.9.0", "critique": bad})
        for bad in ({"lanes": ["p"], "timeout_minutes": 9}, {"lanes": ["p"], "timeout_minutes": 121},
                    {"lanes": ["p"], "max_budget_usd": 0}, {"lanes": ["p"], "max_budget_usd": 101},
                    {"lanes": ["p"], "skills": []}, {"lanes": ["p"], "extra": 1}):
            with self.assertRaises(ValueError):
                critique.declared({"version": "2.9.0", "critique": bad})

    def test_validate_critique_app(self):
        ok = {"argv": ["npm", "run", "dev"], "ready_path": "/", "timeout_seconds": 120}
        self.assertEqual(critique.validate_critique_app(ok), ok)
        for bad in ({"argv": [], "ready_path": "/", "timeout_seconds": 1},
                    {"argv": ["x"], "ready_path": "health", "timeout_seconds": 1},
                    {"argv": ["x"], "ready_path": "/", "timeout_seconds": 0},
                    {"argv": ["x"], "ready_path": "/", "timeout_seconds": 1, "extra": 1}):
            with self.assertRaises(ValueError):
                critique.validate_critique_app(bad)

    def test_pin_intersects_lanes_with_selected_and_refuses_empty(self):
        plan = {}
        app = {"argv": ["x"], "ready_path": "/", "timeout_seconds": 10}
        critique.pin(plan, {"lanes": ["pages", "shell"], "skills": ["impeccable"], "max_budget_usd": 15, "timeout_minutes": 45},
                     ["pages"], [{"name": "impeccable", "sha256": "a" * 64}], "d" * 64, None, app, "/wt")
        self.assertEqual(plan["critique"]["lanes"], ["pages"])  # shell not selected
        self.assertEqual(plan["feature_version"], "2.9.0")
        critique.validate_plan(plan)
        with self.assertRaisesRegex(ValueError, "no selected lane"):
            critique.pin({}, {"lanes": ["other"], "skills": ["impeccable"], "max_budget_usd": 15, "timeout_minutes": 45},
                         ["pages"], [], "d" * 64, None, app, "/wt")

    def test_validate_plan_refuses_malformed(self):
        with self.assertRaises(ValueError):
            critique.validate_plan({"critique": {"lanes": ["p"]}})  # missing keys
        self.assertIsNone(critique.validate_plan({}))  # a plan without critique

    def test_refuse_print_transport(self):
        critique.refuse_print_transport("native")  # ok
        critique.refuse_print_transport(None)       # ok (a manual run, or roles pinned before transports)
        with self.assertRaisesRegex(ValueError, "print"):
            critique.refuse_print_transport("print")

    def test_builtin_critique_brief_states_the_whole_rubric(self):
        # The false-P1 guard rests on the brief (PRD 4.4/7): P1-only rule, the P0..P3 -> P2 mapping, numbered steps inline
        # in the message, at least one screenshot, and "never write P0/P3". An edit that weakens it fails here (P2 #55).
        text = critique.BUILTIN_BRIEF.read_text()
        self.assertIn("**P1** — and only P1 —", text)
        self.assertIn("**P2** for everything else", text)
        self.assertIn("P0, P1, P2 or P3 outside the rule above is **P2**", text)
        self.assertIn("never write P0", text)
        self.assertIn("numbered steps to reproduce **inline in the `message`**", text)
        self.assertIn("at least one screenshot", text)
        self.assertIn("under the round folder", text)

    def test_current_round_fails_closed_on_a_malformed_journal(self):
        tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, tmp, ignore_errors=True)
        self.assertEqual(critique.current_round(tmp), 1)  # absent journal: the first review round
        (tmp / "review-rounds.json").write_text("{ not json")
        with self.assertRaises(critique.MalformedRounds):
            critique.current_round(tmp)  # never a silent round 1 that would overwrite another round's evidence
        save_json(tmp / "review-rounds.json", {"version": "1.0.0", "rounds": "nope"})
        with self.assertRaises(critique.MalformedRounds):
            critique.current_round(tmp)


# ---- The output schema ----------------------------------------------------------------------------------------------

class OutputSchema(unittest.TestCase):
    def setUp(self):
        self.lanes = ["pages", "shell"]

    def valid(self, severity="P1", worker="pages"):
        return {"verdict": "blocked", "findings": [{"severity": severity, "worker": worker, "message": "m",
                "evidence": {"steps": ["s"], "screenshots": [{"path": "a.png", "caption": "c"}]}}]}

    def test_accepts_p1_and_p2_only(self):
        critique.validate_output(self.valid("P1"), self.lanes)
        critique.validate_output(self.valid("P2"), self.lanes)
        critique.validate_output({"verdict": "approved", "findings": []}, self.lanes)

    def test_rejects_p0_p3_and_foreign_lane(self):
        for bad in (self.valid("P0"), self.valid("P3"), self.valid(worker="other")):
            with self.assertRaises(Exception):
                critique.validate_output(bad, self.lanes)

    def test_rejects_missing_evidence_or_too_many_steps(self):
        bad = {"verdict": "blocked", "findings": [{"severity": "P1", "worker": "pages", "message": "m"}]}
        with self.assertRaises(Exception):
            critique.validate_output(bad, self.lanes)
        over = self.valid()
        over["findings"][0]["evidence"]["steps"] = [f"s{i}" for i in range(21)]
        with self.assertRaises(Exception):
            critique.validate_output(over, self.lanes)


# ---- Evidence keying and artifacts ----------------------------------------------------------------------------------

class Evidence(unittest.TestCase):
    def test_evidence_key_distinguishes_duplicates(self):
        a = critique.evidence_key("P1", "pages", "m", 0)
        b = critique.evidence_key("P1", "pages", "m", 1)
        self.assertNotEqual(a, b)
        self.assertEqual(a, critique.evidence_key("P1", "pages", "m", 0))

    def test_finding_evidence_keys_by_digest_and_occurrence(self):
        tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, tmp, ignore_errors=True)
        (tmp / "critique" / "1").mkdir(parents=True)
        k0 = critique.evidence_key("P1", "pages", "dup", 0)
        k1 = critique.evidence_key("P1", "pages", "dup", 1)
        save_json(tmp / "critique" / "1" / "evidence.json", {"version": "1.0.0", "round": 1, "evidence": {
            k0: {"steps": ["first"], "screenshots": [{"artifact_id": "critique-1-aaa", "path": "p", "caption": "c0"}]},
            k1: {"steps": ["second"], "screenshots": [{"artifact_id": "critique-1-bbb", "path": "p", "caption": "c1"}]}}})
        findings = [{"severity": "P1", "worker": "pages", "message": "dup", "reviewer": "critique"},
                    {"severity": "P1", "worker": "pages", "message": "dup", "reviewer": "critique"},
                    {"severity": "P2", "worker": "pages", "message": "x", "reviewer": "general"}]
        ev = critique.finding_evidence(tmp, 1, findings)
        self.assertEqual(ev[0]["steps"], ["first"])
        self.assertEqual(ev[1]["steps"], ["second"])  # the duplicate keeps its own evidence
        self.assertNotIn(2, ev)  # a non-critique finding carries none

    def test_export_review_section_carries_evidence_and_the_artifact_list(self):
        from .export_state import review_section
        tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, tmp, ignore_errors=True)
        (tmp / "critique" / "1").mkdir(parents=True)
        (tmp / "critique" / "1" / "s.png").write_bytes(critique.PNG_SIGNATURE + b"body")
        aid = critique.artifact_id(1, tmp / "critique" / "1" / "s.png")
        key = critique.evidence_key("P1", "pages", "spins", 0)
        save_json(tmp / "critique" / "1" / "evidence.json", {"version": "1.0.0", "round": 1, "evidence": {
            key: {"steps": ["open", "click"], "screenshots": [{"artifact_id": aid, "path": "critique/1/s.png", "caption": "c"}]}}})
        save_json(tmp / "review.json", {"run_id": "r", "bundle_sha256": "b" * 64, "candidate_commit": "c" * 40,
                  "reviewer": "s", "independent": True, "verdict": "blocked",
                  "reviewers": [{"reviewer_id": "critique", "session_id": "s", "verdict": "blocked", "accepted_at": None}],
                  "findings": [{"severity": "P1", "message": "spins", "disposition": "open", "worker": "pages", "requirement": None, "reviewer": "critique"},
                               {"severity": "P2", "message": "other", "disposition": "open", "worker": "pages", "requirement": None, "reviewer": "general"}]})
        section = review_section(tmp, {"critique": {"lanes": ["pages"]}})
        self.assertEqual(section["findings"][0]["evidence"]["steps"], ["open", "click"])
        self.assertEqual(section["findings"][0]["evidence"]["screenshots"][0]["artifact_id"], aid)
        self.assertNotIn("evidence", section["findings"][1])  # the non-critique finding carries none
        self.assertEqual([a["id"] for a in section["critique_artifacts"]], [aid])

    def _review_json(self, tmp, reviewers, findings):
        save_json(tmp / "review.json", {"run_id": "r", "bundle_sha256": "b" * 64, "candidate_commit": "c" * 40,
                  "reviewer": "s", "independent": True, "verdict": "blocked", "reviewers": reviewers, "findings": findings})

    def test_export_critique_reviewer_entry_has_launch_time_and_blocked_status(self):
        from .export_state import review_section
        tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, tmp, ignore_errors=True)
        (tmp / "critique" / "1").mkdir(parents=True)
        # The RECORD the export reads for the critique's launch time and status (PRD 4.4/4.5). Its status is `accepted`
        # whenever the critique produced a decision, even a blocking one, so the exported status must follow the verdict.
        save_json(tmp / critique.RECORD, {"reviewer_id": "critique", "status": "accepted", "reason": None,
                  "session_id": "s", "round": 1, "launched_at": "2026-01-01T10:00:00Z", "finished_at": "2026-01-01T10:40:00Z"})
        self._review_json(tmp, [{"reviewer_id": "critique", "session_id": "s", "verdict": "blocked", "accepted_at": None}], [])
        entry = review_section(tmp, {"critique": {"lanes": ["pages"]}})["reviewers"][0]
        self.assertEqual(entry["reviewer_id"], "critique")
        self.assertEqual(entry["status"], "blocked")  # a blocking critique is named among the blockers, never 'accepted'
        self.assertEqual(entry["launched_at"], "2026-01-01T10:00:00Z")  # from automatic-review-critique.json, not a native receipt

    def test_export_failed_critique_entry_is_blocked_with_its_launch_time(self):
        from .export_state import review_section
        tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, tmp, ignore_errors=True)
        save_json(tmp / critique.RECORD, {"reviewer_id": "critique", "status": "failed", "reason": "the app did not answer /",
                  "session_id": None, "round": 1, "launched_at": "2026-01-01T10:00:00Z", "finished_at": "2026-01-01T10:05:00Z"})
        self._review_json(tmp, [{"reviewer_id": "critique", "session_id": None, "verdict": None, "accepted_at": None}], [])
        entry = review_section(tmp, {"critique": {"lanes": ["pages"]}})["reviewers"][0]
        self.assertEqual(entry["status"], "blocked")  # 'failed' is not a reviewer status; a failed critique blocks the review
        self.assertEqual(entry["launched_at"], "2026-01-01T10:00:00Z")

    def test_export_omits_evidence_when_a_finding_has_none(self):
        from .export_state import review_section
        tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, tmp, ignore_errors=True)
        (tmp / "critique" / "1").mkdir(parents=True)
        # No evidence.json entry for this finding: Appendix A has 1 to 20 steps, so the export omits the `evidence` key
        # rather than emit a zero-step block (the viewer treats a missing key as no evidence, review finding 11).
        self._review_json(tmp, [{"reviewer_id": "critique", "session_id": "s", "verdict": "blocked", "accepted_at": None}],
                          [{"severity": "P1", "message": "no shot", "disposition": "open", "worker": "pages", "requirement": None, "reviewer": "critique"}])
        section = review_section(tmp, {"critique": {"lanes": ["pages"]}})
        self.assertNotIn("evidence", section["findings"][0])

    def test_read_side_confinement_drops_a_screenshot_pointing_outside_its_round(self):
        tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, tmp, ignore_errors=True)
        (tmp / "critique" / "1").mkdir(parents=True)
        (tmp / "critique" / "1" / "in.png").write_bytes(critique.PNG_SIGNATURE + b"inside")
        outside = tmp / "secret.png"
        outside.write_bytes(critique.PNG_SIGNATURE + b"outside")
        # A rewritten evidence.json: one valid in-folder PNG, one pointing at a host file outside the round folder.
        save_json(tmp / "critique" / "1" / "evidence.json", {"version": "1.0.0", "round": 1, "evidence": {
            "k": {"steps": ["s"], "screenshots": [
                {"artifact_id": "critique-1-in", "path": "critique/1/in.png", "caption": "c"},
                {"artifact_id": "critique-1-out", "path": str(outside), "caption": "c"}]}}})
        shots = critique.round_evidence(tmp, 1)["k"]["screenshots"]
        self.assertEqual([s["artifact_id"] for s in shots], ["critique-1-in"])  # the out-of-folder path is dropped on read
        self.assertEqual([a["id"] for a in critique.artifacts(tmp)], ["critique-1-in"])

    def test_archived_round_export_attaches_each_findings_own_evidence(self):
        # export_state.review_round_entry enriches an archived round's critique findings with their evidence, keyed by the
        # digest of (severity, worker, message) plus occurrence; each finding gets ITS OWN screenshots (followup P2 #48,
        # Acceptance 8 "an archived round exports the right finding's screenshots").
        from .export_state import review_round_entry
        tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, tmp, ignore_errors=True)
        (tmp / "critique" / "2").mkdir(parents=True)
        for name in ("a.png", "b.png"):
            (tmp / "critique" / "2" / name).write_bytes(critique.PNG_SIGNATURE + name.encode())
        a_id = critique.artifact_id(2, tmp / "critique" / "2" / "a.png")
        b_id = critique.artifact_id(2, tmp / "critique" / "2" / "b.png")
        k_spin = critique.evidence_key("P1", "pages", "spins", 0)
        k_badge = critique.evidence_key("P2", "shell", "badges", 0)
        save_json(tmp / "critique" / "2" / "evidence.json", {"version": "1.0.0", "round": 2, "evidence": {
            k_spin: {"steps": ["open", "click run"], "screenshots": [{"artifact_id": a_id, "path": "critique/2/a.png", "caption": "spins"}]},
            k_badge: {"steps": ["open at 390px"], "screenshots": [{"artifact_id": b_id, "path": "critique/2/b.png", "caption": "badges"}]}}})
        entry = {"round": 2, "verdict": "blocked", "candidate": "c" * 40, "lane": "pages", "archived": True,
                 "reviewer_sessions": [], "started_at": "2026-01-01T00:00:00Z",
                 "findings": [{"severity": "P1", "message": "spins", "disposition": "open", "worker": "pages", "requirement": None, "reviewer": "critique"},
                              {"severity": "P2", "message": "badges", "disposition": "open", "worker": "shell", "requirement": None, "reviewer": "critique"}]}
        out = review_round_entry(tmp, entry, [])
        self.assertEqual(out["findings"][0]["evidence"]["screenshots"][0]["artifact_id"], a_id)  # the P1 keeps its own shot
        self.assertEqual(out["findings"][1]["evidence"]["screenshots"][0]["artifact_id"], b_id)  # not swapped with the other finding's
        self.assertEqual(out["findings"][0]["evidence"]["steps"], ["open", "click run"])

    def test_a_png_whose_content_is_not_a_png_is_refused(self):
        # followup P2 #31: a .png inside the round folder whose bytes are not a PNG (a copied host file) is refused by the
        # magic-byte check, on write and on read, so a prompt-injected copy is not published through the artifact route.
        tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, tmp, ignore_errors=True)
        (tmp / "critique" / "1").mkdir(parents=True)
        (tmp / "critique" / "1" / "real.png").write_bytes(critique.PNG_SIGNATURE + b"body")
        (tmp / "critique" / "1" / "fake.png").write_bytes(b"not a png: a copied /etc/passwd\n")
        self.assertIsNotNone(critique.confined_png(tmp, 1, "critique/1/real.png", base=tmp))
        self.assertIsNone(critique.confined_png(tmp, 1, "critique/1/fake.png", base=tmp))
        save_json(tmp / "critique" / "1" / "evidence.json", {"version": "1.0.0", "round": 1, "evidence": {
            "k": {"steps": ["s"], "screenshots": [
                {"artifact_id": "critique-1-real", "path": "critique/1/real.png", "caption": "c"},
                {"artifact_id": "critique-1-fake", "path": "critique/1/fake.png", "caption": "c"}]}}})
        self.assertEqual([s["artifact_id"] for s in critique.round_evidence(tmp, 1)["k"]["screenshots"]], ["critique-1-real"])

    def test_artifacts_lists_live_and_archived_rounds(self):
        tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, tmp, ignore_errors=True)
        for rnd, body in (("1", critique.PNG_SIGNATURE + b"one"), ("2", critique.PNG_SIGNATURE + b"two")):
            (tmp / "critique" / rnd).mkdir(parents=True)
            (tmp / "critique" / rnd / "shot.png").write_bytes(body)
            aid = critique.artifact_id(int(rnd), tmp / "critique" / rnd / "shot.png")
            save_json(tmp / "critique" / rnd / "evidence.json", {"version": "1.0.0", "round": int(rnd), "evidence": {
                "k": {"steps": ["s"], "screenshots": [{"artifact_id": aid, "path": f"critique/{rnd}/shot.png", "caption": "c"}]}}})
        arts = critique.artifacts(tmp)
        self.assertEqual({a["path"] for a in arts}, {"critique/1/shot.png", "critique/2/shot.png"})
        self.assertTrue(all(a["kind"] == "screenshot" and a["id"].startswith("critique-") for a in arts))


# ---- The child end to end -------------------------------------------------------------------------------------------

FAKE_CLAUDE = r'''#!/usr/bin/env python3
import json, os, sys, time
from pathlib import Path
argv = sys.argv[1:]
def opt(name):
    return argv[argv.index(name) + 1] if name in argv else None
session_id = opt("--session-id")
Path(os.environ["FAKE_CLAUDE_ARGV"]).write_text(json.dumps(argv))
control = json.loads(Path(os.environ["FAKE_CLAUDE_CONTROL"]).read_text()) if os.environ.get("FAKE_CLAUDE_CONTROL") and os.path.exists(os.environ["FAKE_CLAUDE_CONTROL"]) else {}
if control.get("hang"):
    time.sleep(3600)
findings = []
for f in control.get("findings", []):
    shots = []
    for s in f.get("screenshots", []):
        p = Path(s["path"])
        if s.get("write"):
            p.parent.mkdir(parents=True, exist_ok=True)
            if s.get("symlink_to"):
                if p.exists() or p.is_symlink(): p.unlink()
                os.symlink(s["symlink_to"], p)
            else:
                p.write_bytes(bytes.fromhex("89504e470d0a1a0a") + b"fake png body")
        shots.append({"path": str(p), "caption": s.get("caption", "c")})
    findings.append({"severity": f["severity"], "worker": f["worker"], "message": f["message"],
                     "evidence": {"steps": f.get("steps", ["step one"]), "screenshots": shots}})
result = {"session_id": session_id, "is_error": bool(control.get("is_error", False)),
          "subtype": control.get("subtype", "success"), "total_cost_usd": 1.0,
          "structured_output": {"verdict": control.get("verdict", "blocked"), "findings": findings}}
if control.get("bad_structured"):
    result["structured_output"] = {"unexpected": True}
sys.stdout.write(json.dumps(result) + "\n")
sys.exit(int(control.get("exit", 0)))
'''

FAKE_APP = r'''#!/usr/bin/env python3
import json, os, sys, time
from http.server import BaseHTTPRequestHandler, HTTPServer
port = int(os.environ["CRITIQUE_WEB_PORT"])
mode = sys.argv[1] if len(sys.argv) > 1 else "ok"
probe = os.environ.get("CRITIQUE_PROBE")
if probe:
    # What the app was started with: the ports, its cwd and whether a secret env var reached it (O6, G5).
    with open(probe, "w") as handle:
        json.dump({"web_port": os.environ.get("CRITIQUE_WEB_PORT"), "api_port": os.environ.get("CRITIQUE_API_PORT"),
                   "cwd": os.getcwd(), "secret": os.environ.get("CRITIQUE_FAKE_SECRET_TOKEN")}, handle)
if mode == "crash":
    sys.exit(3)
if mode == "never":
    time.sleep(3600)
class H(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200); self.end_headers(); self.wfile.write(b"ok")
    def log_message(self, *a): pass
HTTPServer(("127.0.0.1", port), H).serve_forever()
'''


def git(repo, *args):
    subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True, text=True)


def port_open(port):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(0.3)
        return sock.connect_ex(("127.0.0.1", port)) == 0


class ChildHarness(unittest.TestCase):
    """A real CritiqueChild over a toy git repository with a fake claude and a fake app; no model call, no network."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.repo = self.tmp / "repo"
        self.repo.mkdir()
        git(self.repo, "init", "-q")
        git(self.repo, "config", "user.email", "t@t")
        git(self.repo, "config", "user.name", "t")
        (self.repo / "package.json").write_text('{"name":"x"}\n')
        (self.repo / "package-lock.json").write_text('{"v":1}\n')
        (self.repo / ".gitignore").write_text("setup.marker\n")
        git(self.repo, "add", "-A")
        git(self.repo, "commit", "-qm", "candidate")
        self.commit = subprocess.run(["git", "-C", str(self.repo), "rev-parse", "HEAD"], capture_output=True, text=True, check=True).stdout.strip()
        self.run = self.tmp / "run"
        self.run.mkdir()
        self.fake = self.tmp / "fake-claude.py"
        self.fake.write_text(FAKE_CLAUDE)
        os.chmod(self.fake, 0o755)
        self.app = self.tmp / "fake-app.py"
        self.app.write_text(FAKE_APP)
        os.chmod(self.app, 0o755)
        self.control = self.tmp / "control.json"
        self.control.write_text("{}")
        self.argv_file = self.tmp / "argv.json"
        # The pinned critique plugin tree a skills session loads.
        plugin = self.run / "skills" / "critique" / ".claude-plugin"
        plugin.mkdir(parents=True)
        save_json(plugin / "plugin.json", {"name": "workflow-critique", "description": "d", "version": "1.0.0"})

    def build(self, app_mode="ok", setup=(), **over):
        item = {"lanes": ["pages"], "skills": [{"name": "impeccable", "sha256": "a" * 64}], "max_budget_usd": 15,
                "timeout_minutes": 45, "settings_sha256": "d" * 64, "advisor_model": None,
                "critique_app": {"argv": [sys.executable, str(self.app), app_mode], "ready_path": "/", "timeout_seconds": 20},
                "worktree": str(self.tmp / "run.critique" / "worktree")}
        item.update(over)
        plan = {"run_id": "crit-001", "repository": str(self.repo), "base_commit": self.commit,
                "nodes": {"pages": {"task": "## Goal\nShow the pages.\n\nverify_yourself: open /pages"}}, "critique": item}
        save_json(self.run / "plan.json", plan)
        save_json(self.run / "policy.json", {"version": "1.4.0", "feature": "f", "independent_review": True,
                  "integration_approval": True, "setup": list(setup),
                  "workers": [{"node_id": "pages", "role": "frontend", "required_check_kinds": ["build"], "owned_paths": ["src"],
                               "checks": [{"id": "c", "kind": "build", "argv": ["true"], "timeout_seconds": 60, "scenarios": []}]}],
                  "critique_app": item["critique_app"]})
        save_json(self.run / "review-bundle.json", {"run_id": "crit-001", "candidate_commit": self.commit})
        return plan

    def set_control(self, **spec):
        self.control.write_text(json.dumps(spec))

    def env(self):
        return {**os.environ, "WORKFLOW_CLAUDE": str(self.fake), "FAKE_CLAUDE_CONTROL": str(self.control),
                "FAKE_CLAUDE_ARGV": str(self.argv_file), "MD_MANAGER_PROJECTS_CONFIG": str(self.tmp / "registry.json")}

    def run_child(self):
        with mock.patch.dict(os.environ, self.env(), clear=True):
            critique.CritiqueChild(self.run).run()

    def shot_path(self, name="after.png", round_number=1):
        return str((self.run / "critique" / str(round_number) / name))

    def test_happy_path_worktree_app_job_translate_persist(self):
        self.build()
        self.set_control(verdict="blocked", findings=[{"severity": "P1", "worker": "pages", "message": "Run spins forever",
                         "steps": ["Open /pages", "Click Run"], "screenshots": [{"path": self.shot_path(), "write": True, "caption": "spinner"}]}])
        self.run_child()
        status = read_json(self.run / "critique" / "1" / "status.json")
        decision = status["accepted_decision"]
        self.assertEqual(decision["verdict"], "blocked")
        self.assertEqual(decision["findings"][0], {"severity": "P1", "message": "Run spins forever", "disposition": "open",
                         "worker": "pages", "requirement": None, "reviewer": "critique"})
        evidence = read_json(self.run / "critique" / "1" / "evidence.json")["evidence"]
        key = critique.evidence_key("P1", "pages", "Run spins forever", 0)
        self.assertEqual(evidence[key]["steps"], ["Open /pages", "Click Run"])
        self.assertEqual(evidence[key]["screenshots"][0]["path"], "critique/1/after.png")
        self.assertTrue(evidence[key]["screenshots"][0]["artifact_id"].startswith("critique-1-"))
        record = read_json(self.run / critique.RECORD)
        self.assertEqual(record["status"], "accepted")
        # The worktree was set up and the app stopped: its port no longer answers.
        self.assertTrue((Path(self.tmp / "run.critique" / "worktree") / "package.json").exists())

    def test_full_argv_asserted(self):
        # PRD 4.4 "The full argv is asserted in a test." The transport flags, the schema, the add-dir and the judges'
        # model/effort pins are all asserted, so a regression that drops any of them fails here (followup P2 #40).
        self.build()
        plan = read_json(self.run / "plan.json")
        plan["roles"] = {"worker": {"model": "claude-worker", "effort": "medium"},
                         "judges": {"model": "claude-judge", "effort": "high"}}  # the reviewer role's pins (G4)
        save_json(self.run / "plan.json", plan)
        self.set_control(verdict="approved", findings=[])
        self.run_child()
        argv = read_json(self.argv_file)
        plugin = str((self.run / "skills" / "critique").resolve())
        worktree = str(Path(self.tmp / "run.critique" / "worktree"))
        # The headless print transport, its JSON output and the pinned output schema (not a native --bg reviewer).
        self.assertIn("--print", argv)
        self.assertEqual(argv[argv.index("--output-format") + 1], "json")
        session = argv[argv.index("--session-id") + 1]
        self.assertRegex(session, r"^[0-9a-f-]{36}$")
        schema = json.loads(argv[argv.index("--json-schema") + 1])
        self.assertEqual(schema["properties"]["findings"]["items"]["properties"]["severity"]["enum"], ["P1", "P2"])
        self.assertEqual(argv[argv.index("--add-dir") + 1], worktree)
        # The 2.8.0 skills mechanism, the empty MCP config, the tools, the attacker's permission mode, the budget.
        self.assertIn("--setting-sources", argv)
        self.assertEqual(argv[argv.index("--setting-sources") + 1], "")
        self.assertEqual(argv[argv.index("--plugin-dir") + 1], plugin)
        self.assertEqual(argv[argv.index("--mcp-config") + 1], '{"mcpServers":{}}')
        self.assertIn("--strict-mcp-config", argv)
        self.assertEqual(argv[argv.index("--tools") + 1], "Read,Glob,Grep,Bash,Skill,Write")
        self.assertEqual(argv[argv.index("--permission-mode") + 1], "bypassPermissions")
        self.assertIn("--dangerously-skip-permissions", argv)
        self.assertEqual(argv[argv.index("--max-budget-usd") + 1], "15")
        self.assertNotIn("--safe-mode", argv)
        # The reviewer role's model and effort pins (a dropped pin would otherwise pass, followup P2 #40).
        self.assertEqual(argv[argv.index("--model") + 1], "claude-judge")
        self.assertEqual(argv[argv.index("--effort") + 1], "high")
        # The settings deny Edit and Write on all of the run directory (design note 1), on top of the worker deny list
        # (the secret Read/Edit denies, pkill, git commit and git push), and the pinned plugin's Edit/Write denies.
        settings = json.loads(argv[argv.index("--settings") + 1])
        deny = settings["permissions"]["deny"]
        self.assertIn(f"Edit(/{self.run.resolve()}/**)", deny)
        self.assertIn(f"Write(/{self.run.resolve()}/**)", deny)
        self.assertIn(f"Edit(/{plugin}/**)", deny)
        self.assertIn(f"Write(/{plugin}/**)", deny)
        for rule in ("Bash(git push:*)", "Bash(git commit:*)", "Bash(pkill:*)", "Read(~/.ssh/**)", "Edit(~/.ssh/**)"):
            self.assertIn(rule, deny)

    def test_screenshot_outside_folder_is_dropped(self):
        self.build()
        outside = str(self.tmp / "outside.png")
        link = self.tmp / "link-target.png"
        link.write_bytes(b"x")
        self.set_control(verdict="blocked", findings=[{"severity": "P1", "worker": "pages", "message": "m",
                         "screenshots": [{"path": outside, "write": True, "caption": "a"},
                                         {"path": self.shot_path("sym.png"), "write": True, "symlink_to": str(link), "caption": "b"},
                                         {"path": self.shot_path("ok.png"), "write": True, "caption": "c"}]}])
        self.run_child()
        evidence = read_json(self.run / "critique" / "1" / "evidence.json")["evidence"]
        item = next(iter(evidence.values()))
        # Only the in-folder PNG is kept; the outside path and the symlink are refused.
        self.assertEqual([s["path"] for s in item["screenshots"]], ["critique/1/ok.png"])
        self.assertEqual(len(item.get("refused", [])), 2)

    def test_app_crash_is_a_failed_reviewer(self):
        self.build(app_mode="crash")
        self.set_control(verdict="blocked", findings=[])
        self.run_child()
        self.assertFalse((self.run / "critique" / "1" / "status.json").exists())
        record = read_json(self.run / critique.RECORD)
        self.assertEqual(record["status"], "failed")
        self.assertIn("app", record["reason"])

    def test_invalid_output_is_a_failed_reviewer(self):
        self.build()
        self.set_control(bad_structured=True)
        self.run_child()
        record = read_json(self.run / critique.RECORD)
        self.assertEqual(record["status"], "failed")

    def test_spent_budget_is_a_failed_reviewer(self):
        # PRD 4.4: a spent budget ends the job with is_error, which is a failed critique, never a decision (followup P2 #43).
        self.build()
        self.set_control(is_error=True, subtype="error_max_budget", findings=[])
        self.run_child()
        record = read_json(self.run / critique.RECORD)
        self.assertEqual(record["status"], "failed")
        self.assertFalse((self.run / "critique" / "1" / "status.json").exists())

    def test_setup_runs_before_the_browser_slot_is_taken(self):
        # PRD 4.4 Timing: setup runs OUTSIDE the slot, before it is taken (followup P2 #43). The order is recorded by a
        # setup command and a stand-in browser_slot; setup must come first.
        import contextlib as _contextlib
        order = self.tmp / "order.txt"
        self.build(setup=[{"argv": ["sh", "-c", f"echo setup >> {order}"], "timeout_seconds": 30}])
        self.set_control(verdict="approved", findings=[])

        @_contextlib.contextmanager
        def fake_slot(_label):
            with order.open("a") as handle:
                handle.write("slot\n")
            yield

        with mock.patch.dict(os.environ, self.env(), clear=True), mock.patch("workflow.browser_queue.browser_slot", fake_slot):
            critique.CritiqueChild(self.run).run()
        self.assertEqual(order.read_text().split(), ["setup", "slot"])

    def test_resume_reuses_a_persisted_decision(self):
        self.build()
        self.set_control(verdict="approved", findings=[])
        self.run_child()
        first = read_json(self.run / "critique" / "1" / "status.json")
        self.argv_file.unlink()  # If the job reran, it would rewrite this.
        self.run_child()
        self.assertFalse(self.argv_file.exists(), "a persisted decision is reused without rerunning the job")
        self.assertEqual(read_json(self.run / "critique" / "1" / "status.json"), first)

    def test_setup_reruns_when_lockfile_changes(self):
        marker = self.run / "setup-count.txt"
        # A setup command that appends a line each time it runs.
        self.build(setup=[{"argv": ["sh", "-c", f"echo x >> {marker}"], "timeout_seconds": 30}])
        self.set_control(verdict="approved", findings=[])
        self.run_child()
        self.assertEqual(marker.read_text().count("x"), 1)
        (self.run / "critique" / "1" / "status.json").unlink()  # Force a fresh round decision.
        self.run_child()  # No lockfile change: setup is not rerun.
        self.assertEqual(marker.read_text().count("x"), 1)
        # A repair changes package-lock.json in the candidate: the worktree checks it out and setup reruns (PRD 4.7).
        (self.repo / "package-lock.json").write_text('{"v":2}\n')
        git(self.repo, "commit", "-qam", "repair")
        new_commit = subprocess.run(["git", "-C", str(self.repo), "rev-parse", "HEAD"], capture_output=True, text=True, check=True).stdout.strip()
        save_json(self.run / "review-bundle.json", {"run_id": "crit-001", "candidate_commit": new_commit})
        (self.run / "critique" / "1" / "status.json").unlink()
        self.run_child()
        self.assertEqual(marker.read_text().count("x"), 2)

    def test_app_that_never_answers_is_a_failed_reviewer(self):
        self.build(app_mode="never")
        self.run.joinpath("plan.json")  # keep lint quiet
        plan = read_json(self.run / "plan.json")
        plan["critique"]["critique_app"]["timeout_seconds"] = 2
        save_json(self.run / "plan.json", plan)
        self.set_control(verdict="approved", findings=[])
        self.run_child()
        record = read_json(self.run / critique.RECORD)
        self.assertEqual(record["status"], "failed")
        self.assertFalse((self.run / "critique" / "1" / "status.json").exists())

    def test_job_timeout_is_a_failed_reviewer(self):
        self.build(timeout_minutes=45)
        plan = read_json(self.run / "plan.json")
        plan["critique"]["timeout_minutes"] = 0  # The child reads the plan directly; 0 minutes trips the deadline at once.
        save_json(self.run / "plan.json", plan)
        self.set_control(hang=True)
        self.run_child()
        record = read_json(self.run / critique.RECORD)
        self.assertEqual(record["status"], "failed")
        self.assertIn("timed out", record["reason"])
        # The app's port is free again after the child stops it.
        self.assertFalse((self.run / "critique" / "1" / "status.json").exists())

    def archive_round(self, k: int, findings=None):
        save_json(self.run / "review-rounds.json", {"version": "1.0.0", "rounds": [
            {"round": k, "archived": True, "lane": "pages", "verdict": "blocked", "candidate": self.commit,
             "findings": findings or [], "reviewer_sessions": [], "started_at": "2026-01-01T00:00:00Z"}]})

    def test_round_2_prompt_carries_previous_findings_and_the_live_delta(self):
        self.build()
        self.set_control(verdict="blocked", findings=[{"severity": "P1", "worker": "pages", "message": "Run spins forever",
                         "screenshots": [{"path": self.shot_path(), "write": True, "caption": "c"}]}])
        self.run_child()  # round 1, persisted at critique/1/
        self.archive_round(1)  # now current_round == 2
        (self.run / "review.delta.diff").write_text("DELTA-ROUND-2: pages/App.tsx changed\n")  # the LIVE delta the review step wrote for round 2
        self.set_control(verdict="approved", findings=[])
        self.run_child()  # round 2
        prompt = (self.run / "critique" / "2" / "prompt.txt").read_text()
        self.assertIn("Run spins forever", prompt)  # the previous round's finding
        self.assertIn("DELTA-ROUND-2", prompt)       # the live review.delta.diff, not an archived review.delta.round-1.diff
        self.assertFalse((self.run / "review.delta.round-1.diff").exists())

    def test_dirty_tracked_file_resets_to_the_new_candidate(self):
        self.build()
        self.set_control(verdict="approved", findings=[])
        self.run_child()  # round 1 creates the worktree at the first candidate
        wt = Path(self.tmp / "run.critique" / "worktree")
        (wt / "package.json").write_text('{"name":"DIRTY left from round 1"}\n')  # a dirty tracked file
        (self.repo / "package.json").write_text('{"name":"B"}\n')  # a repair advances the candidate to B
        git(self.repo, "commit", "-qam", "repair B")
        new_commit = subprocess.run(["git", "-C", str(self.repo), "rev-parse", "HEAD"], capture_output=True, text=True, check=True).stdout.strip()
        save_json(self.run / "review-bundle.json", {"run_id": "crit-001", "candidate_commit": new_commit})
        with mock.patch.dict(os.environ, self.env(), clear=True):
            child = critique.CritiqueChild(self.run)
            child.ensure_worktree()
        head = subprocess.run(["git", "-C", str(wt), "rev-parse", "HEAD"], capture_output=True, text=True, check=True).stdout.strip()
        self.assertEqual(head, new_commit)  # reset first, then the checkout succeeds despite the dirty file
        self.assertEqual(subprocess.run(["git", "-C", str(wt), "status", "--porcelain"], capture_output=True, text=True).stdout.strip(), "")

    def test_failed_critique_is_rerun_once_then_settled(self):
        self.build(app_mode="crash")  # the app exits before answering: a failed critique
        self.set_control(verdict="approved", findings=[])
        self.run_child()  # first failure
        self.assertEqual(read_json(self.run / critique.RECORD)["retries"], 0)
        self.assertFalse(critique.settled(self.run), "a failed critique before review.json is not settled: a resume reruns it once")
        self.run_child()  # the one rerun, fails again
        self.assertEqual(read_json(self.run / critique.RECORD)["retries"], 1)
        self.assertTrue(critique.settled(self.run), "after one rerun a failed critique is settled")

    def test_jobs_file_is_cleared_after_the_job_ends(self):
        self.build()
        self.set_control(verdict="approved", findings=[])
        self.run_child()
        self.assertFalse((self.run / "critique.jobs.json").exists(), "no stale job pid is left behind")

    def test_cleanup_kills_the_job_process_group_and_the_app(self):
        self.build()
        with mock.patch.dict(os.environ, self.env(), clear=True):
            child = critique.CritiqueChild(self.run)
        job = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(300)"], start_new_session=True)
        app = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(300)"], start_new_session=True)
        self.addCleanup(lambda: [p.kill() for p in (job, app) if p.poll() is None])
        child.job_process = job
        child.app = {"process": app, "log": None}
        child.cleanup()
        for process in (job, app):
            for _ in range(50):
                if process.poll() is not None:
                    break
                time.sleep(0.1)
            self.assertIsNotNone(process.poll(), "cleanup kills the job's own-session process group and the app")

    def test_cleanup_reaps_a_background_child_after_the_job_exited(self):
        # followup P2 #32: a process the job started with Bash (its own session group) is killed even after the job's main
        # process exited, so it does not outlive the round holding ports.
        self.build()
        with mock.patch.dict(os.environ, self.env(), clear=True):
            child = critique.CritiqueChild(self.run)
        pidfile = self.tmp / "bgchild.pid"
        # A short-lived leader that spawns a lingering child in its own session group, records its pid, then exits.
        leader = subprocess.Popen([sys.executable, "-c",
            f"import subprocess,time;p=subprocess.Popen([{sys.executable!r},'-c','import time;time.sleep(300)']);open({str(pidfile)!r},'w').write(str(p.pid));time.sleep(0.3)"],
            start_new_session=True)
        self.addCleanup(lambda: leader.poll() is None and leader.kill())
        for _ in range(50):
            if pidfile.exists() and leader.poll() is not None:
                break
            time.sleep(0.1)
        child_pid = int(pidfile.read_text())
        def _reap():
            try:
                os.kill(child_pid, 9)
            except (ProcessLookupError, PermissionError):
                pass
        self.addCleanup(_reap)
        child.job_process = leader
        child.app = None
        child.cleanup()
        for _ in range(50):
            if not Path(f"/proc/{child_pid}").exists():
                break
            time.sleep(0.1)
        self.assertFalse(Path(f"/proc/{child_pid}").exists(), "the background child the job left is reaped")

    def test_ensure_started_does_not_double_launch_before_running_exists(self):
        from types import SimpleNamespace
        self.build()
        runtime = SimpleNamespace(directory=self.run, plan=read_json(self.run / "plan.json"))
        calls = {"running": 0, "popen": 0}

        def fake_running(directory):
            calls["running"] += 1
            return calls["running"] > 1  # not running on the very first check, then up (the child claimed RUNNING)

        class FakePopen:
            def __init__(self, *a, **k):
                calls["popen"] += 1

        with mock.patch("workflow.critique.settled", return_value=False), \
             mock.patch("workflow.critique._child_running", side_effect=fake_running), \
             mock.patch("workflow.critique.subprocess.Popen", FakePopen):
            critique.ensure_started(runtime)
            critique.ensure_started(runtime)
        self.assertEqual(calls["popen"], 1, "the second ensure_started sees the live child and launches nothing")

    def test_prompt_carries_the_goal_and_the_workers_verify_yourself(self):
        # The critique walks each lane's task ## Goal and the worker's `verify_yourself` — a field of the lane's
        # completion file, never a line scraped from the task text (review finding 7, PRD 4.4, [O1]).
        self.build()
        save_json(self.run / "pages.completion.json", {"version": "1.1.0", "status": "completed", "summary": "s",
                  "verify_yourself": "CRITIQUE-VERIFY: open /projects/alpha and click Run; the verdict appears"})
        self.set_control(verdict="approved", findings=[])
        self.run_child()
        prompt = (self.run / "critique" / "1" / "prompt.txt").read_text()
        self.assertIn("Show the pages.", prompt)  # the lane task's ## Goal
        self.assertIn("CRITIQUE-VERIFY: open /projects/alpha and click Run; the verdict appears", prompt)  # from the completion
        self.assertIn("http://127.0.0.1:", prompt)  # the app URL

    def test_completion_verify_is_none_without_a_completion_file(self):
        self.build()
        self.assertIsNone(critique.completion_verify(self.run, "pages"))

    def test_wait_for_critique_keeps_the_childs_failure_and_does_not_rerun_mid_step(self):
        from types import SimpleNamespace
        # The child recorded its own failure (real reason, session id, launch time). wait_for_critique must neither
        # overwrite it with a generic reason nor rerun the critique inside the same live review step; the one rerun is a
        # resume's, through _review_candidate (review finding 3, PRD 4.4/[L2](c)).
        self.build()
        save_json(self.run / critique.RECORD, {"reviewer_id": "critique", "status": "failed",
                  "reason": "the app did not answer / within 20s", "session_id": "sess-1", "round": 1,
                  "retries": 0, "launched_at": "2026-01-01T10:00:00Z", "finished_at": "2026-01-01T10:05:00Z"})
        runtime = SimpleNamespace(directory=self.run, plan=read_json(self.run / "plan.json"),
                                  policy=read_json(self.run / "policy.json"))
        counter = {"n": 0}

        def clock():
            counter["n"] += 1
            return float(counter["n"])

        with mock.patch("workflow.critique.ensure_started") as started, mock.patch("workflow.critique.stop_child"):
            critique.wait_for_critique(runtime, clock=clock, sleep=lambda _s: None, bound=1)
        started.assert_not_called()  # a failure already recorded this round is not rerun inside the live review step
        record = read_json(self.run / critique.RECORD)
        self.assertEqual(record["reason"], "the app did not answer / within 20s")
        self.assertEqual(record["session_id"], "sess-1")
        self.assertEqual(record["launched_at"], "2026-01-01T10:00:00Z")

    def run_child_with(self, **extra_env):
        with mock.patch.dict(os.environ, {**self.env(), **extra_env}, clear=True):
            critique.CritiqueChild(self.run).run()

    def test_app_started_on_free_ports_in_the_worktree_with_a_scrubbed_env(self):
        # [O6]/G5: the app runs in the critique worktree with CRITIQUE_WEB_PORT and CRITIQUE_API_PORT set to distinct free
        # ports and the verifier's scrubbed check environment (a *_TOKEN secret is gone). The app's port is free after the
        # completion (its process group was stopped), followup P2 #53/#41.
        self.build()
        self.set_control(verdict="approved", findings=[])
        probe = self.tmp / "app-probe.json"
        self.run_child_with(CRITIQUE_PROBE=str(probe), CRITIQUE_FAKE_SECRET_TOKEN="shhh")
        seen = read_json(probe)
        web, api = int(seen["web_port"]), int(seen["api_port"])
        self.assertNotEqual(web, api)
        self.assertTrue(web > 0 and api > 0)
        self.assertEqual(Path(seen["cwd"]).resolve(), Path(self.tmp / "run.critique" / "worktree").resolve())
        self.assertIsNone(seen["secret"], "a *_TOKEN secret must not reach the app (checks.check_environment scrub, G5)")
        self.assertFalse(port_open(web), "the app's port is free after the completion (its process group was stopped)")

    def test_app_and_slot_free_after_a_timeout(self):
        # A job timeout stops the app's process group and releases the slot, not only a completion (followup P2 #41).
        queue = self.tmp / "queue"
        queue.mkdir()
        save_json(queue / "settings.json", {"enabled": True, "slots": 1})
        self.build(timeout_minutes=45)
        plan = read_json(self.run / "plan.json")
        plan["critique"]["timeout_minutes"] = 0  # trips the job deadline at once
        save_json(self.run / "plan.json", plan)
        self.set_control(hang=True)
        probe = self.tmp / "app-probe.json"
        with mock.patch.dict(os.environ, {**self.env(), "MD_MANAGER_BROWSER_QUEUE": str(queue), "CRITIQUE_PROBE": str(probe)}, clear=True):
            critique.CritiqueChild(self.run).run()
        self.assertEqual(read_json(self.run / critique.RECORD)["status"], "failed")
        web = int(read_json(probe)["web_port"])
        self.assertFalse(port_open(web), "the app's port is free after a job timeout")
        from . import browser_queue
        self.assertTrue(all(holder is None for holder in browser_queue.holders(queue, 1)), "the slot is free after a timeout")

    def test_browser_slot_is_released_after_a_completion(self):
        queue = self.tmp / "queue"
        queue.mkdir()
        save_json(queue / "settings.json", {"enabled": True, "slots": 1})
        self.build()
        self.set_control(verdict="approved", findings=[])
        with mock.patch.dict(os.environ, {**self.env(), "MD_MANAGER_BROWSER_QUEUE": str(queue)}, clear=True):
            critique.CritiqueChild(self.run).run()
        # The slot lock is not held by any live process after the child exits.
        from . import browser_queue
        self.assertTrue(all(holder is None for holder in browser_queue.holders(queue, 1)))


class ReviewIntegration(unittest.TestCase):
    """The critique joins review.json after the native reviewers, never through state.ids (PRD 4.5)."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.plan = {"run_id": "r", "critique": {"lanes": ["pages"]}}
        self.runtime = mock.Mock(directory=self.tmp, plan=self.plan)

    def persist(self, decision, status="accepted", session="s-1"):
        (self.tmp / "critique" / "1").mkdir(parents=True, exist_ok=True)
        save_json(self.tmp / "critique" / "1" / "status.json", {"reviewer_id": "critique", "round": 1,
                  "session_id": session, "launched_at": "2026-01-01T00:00:00Z", "accepted_decision": decision})
        save_json(self.tmp / critique.RECORD, {"reviewer_id": "critique", "status": status, "reason": None,
                  "session_id": session, "round": 1, "launched_at": "2026-01-01T00:00:00Z", "finished_at": "2026-01-01T00:01:00Z"})

    def test_review_entry_blocks_on_an_open_p1(self):
        self.persist({"verdict": "blocked", "findings": [{"severity": "P1", "message": "m", "disposition": "open",
                     "worker": "pages", "requirement": None, "reviewer": "critique"}]})
        entry = critique.review_entry(self.runtime)
        self.assertEqual(entry["reviewer_id"], "critique")
        self.assertEqual(entry["verdict"], "blocked")
        self.assertTrue(critique.blocks(self.runtime))

    def test_failed_critique_is_verdict_null_and_blocks(self):
        save_json(self.tmp / critique.RECORD, {"reviewer_id": "critique", "status": "failed", "reason": "app down",
                  "session_id": None, "round": 1, "launched_at": None, "finished_at": "2026-01-01T00:01:00Z"})
        entry = critique.review_entry(self.runtime)
        self.assertIsNone(entry["verdict"])  # combined_review counts a null verdict as blocking
        self.assertEqual(entry["findings"], [])
        self.assertTrue(critique.blocks(self.runtime))

    def test_no_critique_plan_has_no_entry(self):
        self.assertIsNone(critique.review_entry(mock.Mock(directory=self.tmp, plan={"run_id": "r"})))
        self.assertFalse(critique.blocks(mock.Mock(directory=self.tmp, plan={"run_id": "r"})))

    def test_combined_review_appends_the_critique_after_the_native_reviewers(self):
        from . import automatic
        self.persist({"verdict": "blocked", "findings": [{"severity": "P1", "message": "spins", "disposition": "open",
                     "worker": "pages", "requirement": None, "reviewer": "critique"}]})
        combined = {"reviewers": []}
        state = automatic.ReviewStatus(self.runtime, combined, {})  # No native reviewers.
        bundle = {"run_id": "r", "candidate_commit": "c" * 40}
        review = automatic.combined_review(self.runtime, bundle, "d" * 64, state, {})
        self.assertEqual(review["verdict"], "blocked")
        self.assertEqual([entry["reviewer_id"] for entry in review["reviewers"]], ["critique"])
        self.assertEqual(review["findings"][0]["reviewer"], "critique")
        self.assertEqual(review["findings"][0]["worker"], "pages")

    def test_combined_review_with_a_native_p1_and_a_failed_critique(self):
        from . import automatic
        save_json(self.tmp / critique.RECORD, {"reviewer_id": "critique", "status": "failed", "reason": "app down",
                  "session_id": None, "round": 1, "retries": 1, "launched_at": None, "finished_at": "2026-01-01T00:01:00Z"})
        combined = {"reviewers": []}
        statuses = {"general": {"reviewer_id": "general", "session_id": "g", "status": "blocked", "accepted_at": "2026-01-01T00:00:00Z"}}
        state = automatic.ReviewStatus(self.runtime, combined, statuses)
        decisions = {"general": {"verdict": "blocked", "findings": [{"severity": "P1", "message": "native pages bug",
                     "disposition": "open", "worker": "pages", "requirement": None}]}}
        review = automatic.combined_review(self.runtime, {"run_id": "r", "candidate_commit": "c" * 40}, "d" * 64, state, decisions)
        self.assertEqual(review["verdict"], "blocked")
        self.assertEqual([e["reviewer_id"] for e in review["reviewers"]], ["general", "critique"])  # critique appended last
        self.assertIsNone(next(e for e in review["reviewers"] if e["reviewer_id"] == "critique")["verdict"])  # failed -> null, which blocks
        self.assertTrue(any(f["worker"] == "pages" and f["reviewer"] == "general" for f in review["findings"]))


class FixLoopGate(unittest.TestCase):
    """The fix loop repairs a critique P1's lane, and loops on an attack+critique plan where an attack-only plan does not
    (PRD 4.6). The gate in automatic.fix_decision is exercised with a constructed runtime and graph state."""

    def setUp(self):
        from types import SimpleNamespace
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        # A review blocked by a critique open P1 naming lane `pages`, every reviewer stopped.
        save_json(self.tmp / "review.json", {"run_id": "r", "bundle_sha256": "b" * 64, "candidate_commit": "c" * 40,
                  "reviewer": "s", "independent": True, "verdict": "blocked", "reviewers": [{"reviewer_id": "general", "session_id": "s", "verdict": "approved", "accepted_at": None}],
                  "findings": [{"severity": "P1", "message": "spins", "disposition": "open", "worker": "pages", "requirement": None, "reviewer": "critique"}]})
        save_json(self.tmp / "automatic-review.json", {"status": "blocked", "transport": "native"})
        save_json(self.tmp / "review-general.stop.json", {"stopped": True})
        self.task = SimpleNamespace(name="review", error=RuntimeError("blocked"))
        self.state = SimpleNamespace(tasks=[self.task], next={"review"})

    def runtime(self, attack, critique_):
        from types import SimpleNamespace
        plan = {"run_id": "r", "automatic": {"fix_rounds": 2}, "workers": ["pages"],
                "reviewers": [{"reviewer_id": "general", "prompt": "builtin:general"}]}
        if attack:
            plan["attack"] = {"angles": ["auth-funds"]}
        if critique_:
            plan["critique"] = {"lanes": ["pages"]}
        return SimpleNamespace(directory=self.tmp, plan=plan, workers=["pages"])

    def test_critique_p1_repairs_its_lane_on_an_attack_plus_critique_plan(self):
        from .automatic import fix_decision
        self.assertEqual(fix_decision(self.runtime(attack=True, critique_=True), self.state), ("pages", "review"))

    def test_critique_only_plan_repairs_its_lane(self):
        from .automatic import fix_decision
        self.assertEqual(fix_decision(self.runtime(attack=False, critique_=True), self.state), ("pages", "review"))

    def test_attack_only_plan_does_not_loop(self):
        from .automatic import fix_decision
        self.assertIsNone(fix_decision(self.runtime(attack=True, critique_=False), self.state))

    def test_native_p1_with_a_failed_critique_writes_the_block_and_repairs_pages(self):
        from .automatic import fix_decision
        # review.json as _decide would write it: a native general P1 on `pages`, and the critique entry a null verdict
        # (a failed critique), which combined_review counts as blocking. open_blockers sees only the native P1 -> pages.
        save_json(self.tmp / "review.json", {"run_id": "r", "bundle_sha256": "b" * 64, "candidate_commit": "c" * 40,
                  "reviewer": "g", "independent": True, "verdict": "blocked",
                  "reviewers": [{"reviewer_id": "general", "session_id": "g", "verdict": "blocked", "accepted_at": None},
                                {"reviewer_id": "critique", "session_id": None, "verdict": None, "accepted_at": None}],
                  "findings": [{"severity": "P1", "message": "native pages bug", "disposition": "open", "worker": "pages", "requirement": None, "reviewer": "general"}]})
        save_json(self.tmp / critique.RECORD, {"reviewer_id": "critique", "status": "failed", "reason": "app down",
                  "session_id": None, "round": 1, "retries": 1, "launched_at": None, "finished_at": "2026-01-01T00:01:00Z"})
        self.assertEqual(fix_decision(self.runtime(attack=False, critique_=True), self.state), ("pages", "review"))


class CloseOrWait(unittest.TestCase):
    """close_or_wait_critique stops the detached child on EVERY exit before the critique settled (PRD 4.4): its and the
    app's process groups and the browser slot are freed on a native error AND on an interrupt. On an interrupt it records
    nothing, so a resume reruns the job (PRD 6); on a hard error it records the critique failed (panel item 9)."""

    def setUp(self):
        from types import SimpleNamespace
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.runtime = SimpleNamespace(directory=self.tmp, plan={"run_id": "r", "critique": {"lanes": ["pages"]}})

    def test_a_native_error_stops_the_child_and_records_failed(self):
        with mock.patch("workflow.critique.stop_child") as stop, mock.patch("workflow.critique._record_failed") as rec:
            critique.close_or_wait_critique(self.runtime, RuntimeError("native reviewer failed"))
        stop.assert_called_once()
        rec.assert_called_once()  # the slot and app are freed instead of held for the whole critique deadline

    def test_an_interrupt_stops_the_child_without_recording_so_resume_reruns(self):
        # PRD 4.4: a Ctrl-C kills the job's and the app's process groups and releases the slot. The child is detached
        # (start_new_session), so the terminal SIGINT never reaches it; the controller must stop it. Nothing is recorded,
        # so the next controller resumes and reruns the job with a new app process group (PRD 6).
        with mock.patch("workflow.critique.stop_child") as stop, mock.patch("workflow.critique._record_failed") as rec:
            critique.close_or_wait_critique(self.runtime, KeyboardInterrupt())
        stop.assert_called_once()
        rec.assert_not_called()

    def test_a_partial_record_still_stops_the_child(self):
        # _record_partial writes review.json while the critique is still unsettled (a native reviewer's deadline after
        # another was accepted). review.json existing is NOT the guard: the detached child must still be stopped so it
        # does not hold the app and the slot for its whole deadline (review finding 2).
        save_json(self.tmp / "review.json", {"verdict": "blocked"})
        with mock.patch("workflow.critique.stop_child") as stop, mock.patch("workflow.critique._record_failed") as rec:
            critique.close_or_wait_critique(self.runtime, RuntimeError("a native reviewer's deadline"))
        stop.assert_called_once()
        rec.assert_called_once()

    def test_a_settled_critique_is_left_alone(self):
        # A persisted decision for the round: the child is already gone and the review incorporated it; do nothing.
        (self.tmp / "critique" / "1").mkdir(parents=True)
        save_json(self.tmp / "critique" / "1" / "status.json", {"accepted_decision": {"verdict": "approved", "findings": []}})
        with mock.patch("workflow.critique.stop_child") as stop, mock.patch("workflow.critique._record_failed") as rec:
            critique.close_or_wait_critique(self.runtime, None)
        stop.assert_not_called()
        rec.assert_not_called()

    def test_no_critique_plan_is_a_noop(self):
        from types import SimpleNamespace
        with mock.patch("workflow.critique.stop_child") as stop:
            critique.close_or_wait_critique(SimpleNamespace(directory=self.tmp, plan={"run_id": "r"}), RuntimeError())
        stop.assert_not_called()


if __name__ == "__main__":
    unittest.main()
