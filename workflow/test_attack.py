"""The attack pass engine (docs/PRD_ATTACK_PASS.md section 8), with no model calls: fake jobs, a temporary secret-file list
and a toy repository whose attack_check is a shell test."""
import contextlib
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

from . import attack
from .sessions import save_json, read_json, run_lock
from .verification import validate_schema

ROOT = Path(__file__).resolve().parents[1]


def appendix_example() -> dict:
    prd = (ROOT / "docs" / "PRD_ATTACK_PASS.md").read_text()
    block = re.search(r"```json\n(.*?)\n```", prd[prd.index("## Appendix A"):], re.S).group(1)
    return json.loads(block)


SETTINGS = {"budget_usd": 15, "timeout_minutes": 60, "skeptic_budget_usd": 5, "skeptic_timeout_minutes": 20, "max_findings": 8}


def plan_with_attack(run_id="attack-smoke-001", **over):
    item = {"angles": ["auth-funds"], **SETTINGS, "requirements": ["docs/security/requirements.md"],
            "secret_files": ["/nonexistent/vps-wallet.env"], "requirement_docs": {"docs/security/requirements.md": "SEC-1: text"},
            "briefs": {"auth-funds": {"path": str(attack.BUILTIN_BRIEFS / "auth-funds.md"), "sha256": "x"}},
            "skeptic_brief": {"path": str(attack.BUILTIN_BRIEFS / "skeptic.md"), "sha256": "y"},
            "attack_check": {"argv": ["sh", "-c", "sh {file}"], "timeout_seconds": 60}, "worktree": "/w", "rerun": "/r"}
    item.update(over)
    return {"run_id": run_id, "attack": item, "nodes": {}}


# ---- the seam --------------------------------------------------------------------------------------------------------

class Seam(unittest.TestCase):
    def test_appendix_a_example_validates_verbatim(self):
        """Scenario seam: the PRD's Appendix A example validates against contracts/workflow/attack.schema.json."""
        validate_schema("attack", appendix_example())

    def test_refused_failed_timed_out_and_pending_records_validate(self):
        plan = plan_with_attack()
        pending = attack.pending_record(plan)
        self.assertEqual(pending["status"], "pending")
        # pending is export-only; the file schema takes the four record statuses.
        for status in ("running", "succeeded", "failed", "refused"):
            record = {**pending, "status": status}
            validate_schema("attack", record)
        # An attacker that timed out, a skeptic not_run with null times, a null rerun and an unjudged finding all validate.
        record = {**attack.initial_record(plan, "c" * 40, "t"), "status": "succeeded", "finished_at": "t"}
        record["attackers"] = [{"id": "auth-funds", "angle": "auth-funds", "status": "timed_out", "started_at": "t",
                                "finished_at": "t", "error": "timed_out", "session_id": None, "cost_usd": None, "summary": None,
                                "out_of_reach": [], "skeptic": {"status": "not_run", "started_at": None, "finished_at": None,
                                "error": None, "session_id": None, "cost_usd": None}}]
        record["findings"] = [{"id": "A-1", "ref": "f1", "attacker": "auth-funds", "severity": "P2", "title": "t", "threat": "t",
                               "requirement": None, "test_file": "attack/auth-funds/A-1.test.ts", "expected": "e", "observed": "o",
                               "rerun": None, "skeptic": None, "status": "unjudged", "labels": []}]
        validate_schema("attack", record)

    def test_output_and_skeptic_output_schemas_are_self_contained(self):
        from jsonschema import Draft202012Validator
        Draft202012Validator.check_schema(attack.output_schema())
        Draft202012Validator.check_schema(attack.skeptic_output_schema())


# ---- configuration ---------------------------------------------------------------------------------------------------

class Config(unittest.TestCase):
    def test_attack_is_refused_before_2_5_0(self):
        with self.assertRaisesRegex(ValueError, "2.5.0"):
            attack.declared({"version": "2.4.0", "attack": {"angles": ["auth-funds"]}})

    def test_declared_fills_defaults_and_checks_bounds(self):
        value = attack.declared({"version": "2.5.0", "attack": {"angles": ["auth-funds"]}})
        self.assertEqual(value["budget_usd"], 15)
        with self.assertRaises(ValueError):
            attack.declared({"version": "2.5.0", "attack": {"angles": []}})
        with self.assertRaises(ValueError):
            attack.declared({"version": "2.5.0", "attack": {"angles": ["auth-funds"], "budget_usd": 0}})
        with self.assertRaises(ValueError):
            attack.declared({"version": "2.5.0", "attack": {"angles": ["nope"]}})

    def test_requirements_must_be_inside_the_repository(self):
        for bad in (["/etc/x.md"], ["../x.md"], ["docs/../../x.md"]):
            with self.assertRaises(ValueError):
                attack.requirements_of({"requirements": bad})
        self.assertEqual(attack.requirements_of({"requirements": ["docs/x.md"]}), ["docs/x.md"])

    def test_attack_check_needs_file_exactly_once(self):
        with self.assertRaises(ValueError):
            attack.validate_attack_check({"argv": ["vitest", "run"], "timeout_seconds": 60})
        with self.assertRaises(ValueError):
            attack.validate_attack_check({"argv": ["vitest", "{file}", "{file}"], "timeout_seconds": 60})
        self.assertEqual(attack.validate_attack_check({"argv": ["vitest", "{file}"], "timeout_seconds": 60})["timeout_seconds"], 60)

    def test_record_settings_is_the_eight_keys_built_from_plan(self):
        plan = plan_with_attack()
        self.assertEqual(set(attack.record_settings(plan)), set(attack.SETTINGS_KEYS))
        self.assertNotIn("attack_check", attack.record_settings(plan))


# ---- the export section ----------------------------------------------------------------------------------------------

class ExportSection(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())

    def test_null_without_attack(self):
        self.assertIsNone(attack.export_section(self.dir, {"run_id": "r"}))

    def test_pending_while_no_record(self):
        section = attack.export_section(self.dir, plan_with_attack())
        self.assertEqual(section["status"], "pending")
        self.assertEqual(section["attackers"], [])

    def test_failed_when_record_invalid(self):
        (self.dir / "attack.json").write_text(json.dumps({"version": "1.0.0", "bogus": True}))
        section = attack.export_section(self.dir, plan_with_attack())
        self.assertEqual(section["status"], "failed")
        self.assertTrue(section["error"].startswith("attack.json is not valid"))

    def test_record_as_read_when_valid(self):
        plan = plan_with_attack()
        record = {**attack.initial_record(plan, "c" * 40, "t"), "status": "succeeded", "finished_at": "t"}
        save_json(self.dir / "attack.json", record)
        self.assertEqual(attack.export_section(self.dir, plan)["status"], "succeeded")


# ---- the attacker command and environment ([L6], [L8]) ---------------------------------------------------------------

class JobCommand(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())
        save_json(self.dir / "plan.json", {"run_id": "r"})  # worker_settings reads nothing from it but takes the directory.

    def test_attacker_argv_carries_the_deny_rules_tools_budget_and_add_dir(self):
        command = attack.attacker_command("claude", "sid-1", {"type": "object"}, Path("/wt"), self.dir, 15)
        self.assertIn("--dangerously-skip-permissions", command)
        self.assertEqual(command[command.index("--permission-mode") + 1], "bypassPermissions")
        self.assertEqual(command[command.index("--tools") + 1], "Read,Glob,Grep,Edit,Write,Bash")
        self.assertEqual(command[command.index("--max-budget-usd") + 1], "15")
        self.assertEqual(command[command.index("--add-dir") + 1], "/wt")
        settings = json.loads(command[command.index("--settings") + 1])
        deny = settings["permissions"]["deny"]
        self.assertTrue(any("vps-wallet.env" in rule for rule in deny))
        self.assertIn("Bash(git push:*)", deny)
        self.assertIn("Bash(git commit:*)", deny)
        self.assertIn("Bash(pkill:*)", deny)

    def test_attacker_env_keeps_the_auth_token_and_drops_secrets(self):
        environ = {"CLAUDE_CODE_OAUTH_TOKEN": "keep", "GITHUB_TOKEN": "drop", "SOME_KEY": "drop",
                   "PATH": "/usr/bin", "ANTHROPIC_BASE_URL": "https://x"}
        env = attack.attacker_env(environ)
        self.assertEqual(env.get("CLAUDE_CODE_OAUTH_TOKEN"), "keep")
        self.assertNotIn("GITHUB_TOKEN", env)
        self.assertNotIn("SOME_KEY", env)
        self.assertEqual(env.get("ANTHROPIC_BASE_URL"), "https://x")

    def test_skeptic_command_is_read_only_with_a_budget(self):
        command = attack.skeptic_command("claude", "sid-2", {"type": "object"}, Path("/wt"), 5)
        self.assertEqual(command[command.index("--tools") + 1], "Read,Glob,Grep")
        self.assertEqual(command[command.index("--max-budget-usd") + 1], "5")
        self.assertEqual(command[-2], "--json-schema")


# ---- the re-run's reason detection ([L5]) ----------------------------------------------------------------------------

class RerunReason(unittest.TestCase):
    def test_passed_no_test_and_error_are_read_from_the_output(self):
        self.assertEqual(attack.reason_from_output("1 passed", 0), ("not_reproduced", "passed"))
        self.assertEqual(attack.reason_from_output("No test files found", 1), ("not_reproduced", "no_test"))
        self.assertEqual(attack.reason_from_output("Error: Cannot find module 'x'", 1), ("not_reproduced", "error"))
        self.assertEqual(attack.reason_from_output("AssertionError: expected 201 to be 403", 1), ("reproduced", None))

    def test_tail_keeps_the_last_200_lines_under_the_cap(self):
        text = "\n".join(f"line {n}" for n in range(1000))
        tail = attack.tail_output(text)
        self.assertLessEqual(len(tail), 20000)
        self.assertEqual(tail.splitlines()[-1], "line 999")
        self.assertEqual(len(tail.splitlines()), 200)
        self.assertLessEqual(len(attack.tail_output("x" * 50000)), 19000)


# ---- the skeptic's severity clamp (PRD 4.5) --------------------------------------------------------------------------

class SkepticClamp(unittest.TestCase):
    def _finding(self, severity):
        return {"id": "A-1", "severity": severity, "status": "unjudged", "skeptic": None, "labels": []}

    def test_a_higher_severity_is_clamped_and_a_lower_one_is_kept(self):
        child = attack.AttackChild.__new__(attack.AttackChild)
        high = self._finding("P1")
        child.apply_verdicts([high], {"A-1": {"id": "A-1", "verdict": "verified", "reason": "r", "severity": "P0"}})
        self.assertEqual((high["status"], high["skeptic"]["severity"], high["severity"]), ("verified", "P1", "P1"))
        low = self._finding("P1")
        child.apply_verdicts([low], {"A-1": {"id": "A-1", "verdict": "verified", "reason": "r", "severity": "P2"}})
        self.assertEqual((low["status"], low["severity"]), ("verified", "P2"))
        refuted = self._finding("P1")
        child.apply_verdicts([refuted], {"A-1": {"id": "A-1", "verdict": "refuted", "reason": "r", "severity": "P1"}})
        self.assertEqual(refuted["status"], "refuted")

    def test_a_reproduced_finding_with_no_verdict_is_unjudged(self):
        child = attack.AttackChild.__new__(attack.AttackChild)
        finding = self._finding("P1")
        child.apply_verdicts([finding], {})
        self.assertEqual((finding["status"], finding["skeptic"]), ("unjudged", None))


# ---- worker prompt independence (PRD 4.8) ----------------------------------------------------------------------------

class WorkerPromptIndependence(unittest.TestCase):
    def test_one_line_with_attack_and_none_without_and_no_angle(self):
        from . import interactive
        self.assertIn("independent attack pass", interactive.ATTACK_NOTE)
        self.assertNotIn("auth-funds", interactive.ATTACK_NOTE)
        self.assertNotIn("angle", interactive.ATTACK_NOTE.lower())


# ---- attack-label ----------------------------------------------------------------------------------------------------

class Label(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())
        self.plan = plan_with_attack()
        save_json(self.dir / "plan.json", self.plan)
        record = {**attack.initial_record(self.plan, "c" * 40, "t"), "status": "succeeded", "finished_at": "t"}
        record["attackers"] = [{"id": "auth-funds", "angle": "auth-funds", "status": "succeeded", "started_at": "t",
                                "finished_at": "t", "error": None, "session_id": "s", "cost_usd": 1.0, "summary": None,
                                "out_of_reach": [], "skeptic": {"status": "succeeded", "started_at": "t", "finished_at": "t",
                                "error": None, "session_id": "s", "cost_usd": 0.5}}]
        record["findings"] = [
            {"id": "A-1", "ref": "f1", "attacker": "auth-funds", "severity": "P1", "title": "t", "threat": "t",
             "requirement": None, "test_file": "attack/auth-funds/A-1.test.ts", "expected": "e", "observed": "o",
             "rerun": {"status": "reproduced", "reason": None, "exit_code": 1, "duration_seconds": 1.0, "output_tail": "FAIL", "at": "t"},
             "skeptic": {"verdict": "verified", "reason": "r", "severity": "P1"}, "status": "verified", "labels": []},
            {"id": "A-2", "ref": "f2", "attacker": "auth-funds", "severity": "P2", "title": "t", "threat": "t",
             "requirement": None, "test_file": "attack/auth-funds/A-2.test.ts", "expected": "e", "observed": "o",
             "rerun": {"status": "not_reproduced", "reason": "passed", "exit_code": 0, "duration_seconds": 1.0, "output_tail": "1 passed", "at": "t"},
             "skeptic": None, "status": "not_reproduced", "labels": []}]
        attack.save_record(self.dir, record)

    def test_records_a_label_on_a_verified_finding(self):
        attack.label_main([str(self.dir), "A-1", "--label", "real", "--review-found", "no", "--by", "operator"])
        record = attack.load_record(self.dir)
        self.assertEqual(record["findings"][0]["labels"][-1], {"label": "real", "review_found": "no", "note": None,
                                                               "by": "operator", "at": record["findings"][0]["labels"][-1]["at"]})

    def test_refuses_the_maintainer(self):
        with self.assertRaisesRegex(ValueError, "maintainer"):
            attack.label_main([str(self.dir), "A-1", "--label", "real", "--by", "maintainer"])

    def test_refuses_an_unknown_id_and_a_finding_that_is_not_verified(self):
        with self.assertRaises(SystemExit):
            attack.label_main([str(self.dir), "A-9", "--label", "real", "--by", "operator"])
        with self.assertRaises(SystemExit):
            attack.label_main([str(self.dir), "A-2", "--label", "false", "--by", "operator"])


# ---- attack-tally ----------------------------------------------------------------------------------------------------

class Tally(unittest.TestCase):
    def test_counts_across_registered_runs(self):
        root = Path(tempfile.mkdtemp())
        runs_root = root / "runs"
        runs_root.mkdir()
        run = runs_root / "attack-pass-001"
        run.mkdir()
        plan = plan_with_attack("attack-pass-001")
        save_json(run / "plan.json", plan)
        record = {**attack.initial_record(plan, "c" * 40, "t"), "status": "succeeded", "finished_at": "t"}
        record["attackers"] = [{"id": "auth-funds", "angle": "auth-funds", "status": "succeeded", "started_at": "t",
                                "finished_at": "t", "error": None, "session_id": "s", "cost_usd": None, "summary": None,
                                "out_of_reach": [], "skeptic": {"status": "succeeded", "started_at": "t", "finished_at": "t",
                                "error": None, "session_id": "s", "cost_usd": None}}]
        record["findings"] = [{"id": "A-1", "ref": "f1", "attacker": "auth-funds", "severity": "P1", "title": "t", "threat": "t",
                               "requirement": None, "test_file": "attack/auth-funds/A-1.test.ts", "expected": "e", "observed": "o",
                               "rerun": {"status": "reproduced", "reason": None, "exit_code": 1, "duration_seconds": 1.0, "output_tail": "FAIL", "at": "t"},
                               "skeptic": {"verdict": "verified", "reason": "r", "severity": "P1"}, "status": "verified",
                               "labels": [{"label": "real", "review_found": "yes", "note": None, "by": "operator", "at": "t"}]}]
        attack.save_record(run, record)
        registry = root / "registry.json"
        save_json(registry, {"version": 1, "projects": [{"project_id": "p", "repository": str(root),
                  "workflows": [{"workflow_id": "attack-pass", "runs_root": str(runs_root)}]}]})
        import io, contextlib
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            attack.tally_main(["--registry", str(registry)])
        text = out.getvalue()
        self.assertIn("1 verified", text)
        self.assertIn("real the review also found 1", text)


# ---- add_findings assigns global A-ids and copies the test files (G9) ------------------------------------------------

class AddFindings(unittest.TestCase):
    def test_global_ids_and_test_copies(self):
        root = Path(tempfile.mkdtemp())
        child = attack.AttackChild.__new__(attack.AttackChild)
        child.directory = root
        child.worktree = root / "wt"
        child.item = {"max_findings": 8}
        child.src = {}
        child.attack_dir = root / "attack"
        (child.worktree / "attack-tests").mkdir(parents=True)
        (child.worktree / "attack-tests" / "foo.test.ts").write_text("test('x', () => {})")
        record = {"findings": []}
        child.add_findings(record, "auth-funds", [{"id": "f1", "severity": "P1", "title": "t", "threat": "t",
                          "requirement": None, "test_file": "attack-tests/foo.test.ts", "expected": "e", "observed": "o"}])
        self.assertEqual(record["findings"][0]["id"], "A-1")
        self.assertEqual(record["findings"][0]["ref"], "f1")
        self.assertEqual(record["findings"][0]["test_file"], "attack/auth-funds/A-1.test.ts")
        self.assertTrue((root / "attack/auth-funds/A-1.test.ts").is_file())
        # A second attacker's findings keep counting globally.
        child.add_findings(record, "inputs-state", [{"id": "g1", "severity": "P2", "title": "t", "threat": "t",
                          "requirement": None, "test_file": "attack-tests/foo.test.ts", "expected": "e", "observed": "o"}])
        self.assertEqual(record["findings"][1]["id"], "A-2")


# ---- close_or_wait fails fast when the child died with no terminal record (new-2, L4) ---------------------------------

class CloseOrWaitDeadChild(unittest.TestCase):
    def test_a_decided_review_with_a_dead_child_records_failed_without_waiting_the_bound(self):
        root = Path(tempfile.mkdtemp())
        save_json(root / "policy.json", {"version": "1.3.0", "setup": []})
        (root / "review.json").write_text("{}")  # The review decided.
        plan = plan_with_attack()

        class Runtime:
            directory = root
        rt = Runtime()
        rt.plan = plan
        ticks = iter([0, 100, 100000])
        attack.close_or_wait_attack(rt, None, clock=lambda: next(ticks), sleep=lambda _: None)
        record = read_json(root / "attack.json")
        self.assertEqual(record["status"], "failed")
        events = [json.loads(line) for line in (root / "events.jsonl").read_text().splitlines()]
        self.assertEqual(events[-1]["message"], "Attack pass ended: failed")


# ---- the real child, refused path ([L11], the guard) -----------------------------------------------------------------

class RefusedChild(unittest.TestCase):
    def test_a_listed_secret_file_present_makes_the_pass_refused_from_a_temporary_cwd(self):
        root = Path(tempfile.mkdtemp())
        run = root / "run"
        run.mkdir()
        secret = root / "wallet.env"
        secret.write_text("SECRET")
        plan = plan_with_attack(secret_files=[str(secret)])
        save_json(run / "plan.json", plan)
        save_json(run / "policy.json", {"version": "1.3.0", "feature": "f", "independent_review": True,
                  "integration_approval": True, "workers": [{"node_id": "x", "role": "backend", "required_check_kinds": ["unit"],
                  "owned_paths": ["a"], "checks": [{"id": "c", "kind": "unit", "argv": ["true"], "timeout_seconds": 60, "scenarios": []}]}],
                  "attack_check": {"argv": ["sh", "{file}"], "timeout_seconds": 60}})
        save_json(run / "review-bundle.json", {"candidate_commit": "c" * 40})
        # Started from a temporary cwd (not the run directory), as the controller starts it from its own checkout ([L11]).
        env = {**os.environ, "WORKFLOW_CLAUDE": "/bin/false", "PYTHONPATH": str(ROOT)}
        subprocess.run([sys.executable, "-m", "workflow.attack", str(run)], cwd=str(tempfile.mkdtemp()), env=env, check=True,
                       capture_output=True, timeout=60)
        record = read_json(run / "attack.json")
        self.assertEqual(record["status"], "refused")
        self.assertIn(str(secret), record["error"])
        events = [json.loads(line) for line in (run / "events.jsonl").read_text().splitlines()]
        closing = [event for event in events if event["node"] == "attack"]
        self.assertEqual(closing[-1]["status"], "succeeded")
        self.assertEqual(closing[-1]["message"], "Attack pass ended: refused")


# ---- an in-process child over a toy repository with a fake claude (PRD section 8, [L2], [L5], [L15]) -----------------

FAKE_CLAUDE = r'''#!/usr/bin/env python3
import json, os, sys, time
from pathlib import Path
argv = sys.argv[1:]
def opt(name):
    return argv[argv.index(name) + 1] if name in argv else None
session_id = opt("--session-id")
tools = opt("--tools") or ""
is_attacker = "Write" in tools or "Edit" in tools or "Bash" in tools
control = {}
cpath = os.environ.get("FAKE_CLAUDE_CONTROL")
if cpath and os.path.exists(cpath):
    control = json.loads(Path(cpath).read_text())
key = "attacker" if is_attacker else "skeptic"
spec = control.get(key, {})
# Block until a sentinel file appears (orders a job against the review decision), then optionally never return (timeout).
sentinel = spec.get("wait")
if sentinel:
    for _ in range(600):
        if os.path.exists(sentinel):
            break
        time.sleep(0.05)
if spec.get("hang"):
    time.sleep(3600)
exit_code = int(spec.get("exit", 0))
if spec.get("not_json"):
    sys.stdout.write("this is not json\n")
    sys.exit(exit_code)
if is_attacker:
    cwd = Path.cwd()
    findings = []
    for f in spec.get("findings", []):
        rel = f["test_file"]
        dest = cwd / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        if f.get("symlink_to"):
            if dest.exists() or dest.is_symlink():
                dest.unlink()
            os.symlink(f["symlink_to"], dest)
        elif not f.get("skip_write"):
            dest.write_text(f.get("body", "exit 1\n"))
        findings.append({k: f.get(k) for k in ("id", "severity", "title", "threat", "requirement",
                                                "test_file", "expected", "observed")})
    structured = {"findings": findings, "summary": spec.get("summary", "an attacker summary"), "out_of_reach": []}
else:
    structured = {"verdicts": list(spec.get("verdicts", []))}
result = {"session_id": session_id, "is_error": bool(spec.get("is_error", False)),
          "subtype": spec.get("subtype", "success"), "total_cost_usd": spec.get("cost", 1.0),
          "structured_output": structured}
if spec.get("bad_structured"):
    result["structured_output"] = {"unexpected": True}
sys.stdout.write(json.dumps(result) + "\n")
sys.exit(exit_code)
'''


def git(repo, *args):
    subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True, text=True)


class ChildHarness(unittest.TestCase):
    """A real AttackChild over a toy git repository with a fake claude; no model call, no network."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.repo = self.tmp / "repo"
        self.repo.mkdir()
        git(self.repo, "init", "-q")
        git(self.repo, "config", "user.email", "t@t")
        git(self.repo, "config", "user.name", "t")
        (self.repo / "app.txt").write_text("the candidate\n")
        (self.repo / ".gitignore").write_text("build/\n")  # Where a policy setup leaves its (ignored) outputs.
        git(self.repo, "add", "-A")
        git(self.repo, "commit", "-qm", "candidate")
        self.commit = subprocess.run(["git", "-C", str(self.repo), "rev-parse", "HEAD"],
                                     capture_output=True, text=True, check=True).stdout.strip()
        self.run = self.tmp / "run"
        self.run.mkdir()
        self.fake = self.tmp / "fake-claude.py"
        self.fake.write_text(FAKE_CLAUDE)
        os.chmod(self.fake, 0o755)
        self.control = self.tmp / "control.json"
        self.control.write_text("{}")

    def build(self, angles=("auth-funds",), setup=(), **over):
        item = {"angles": list(angles), **SETTINGS, "requirements": [], "secret_files": [],
                "requirement_docs": {}, "briefs": {a: {"path": str(attack.BUILTIN_BRIEFS / f"{a}.md"), "sha256": "x"} for a in angles},
                "skeptic_brief": {"path": str(attack.BUILTIN_BRIEFS / "skeptic.md"), "sha256": "y"},
                "attack_check": {"argv": ["sh", "{file}"], "timeout_seconds": 60},
                "worktree": str(self.tmp / "attack" / "worktree"), "rerun": str(self.tmp / "attack" / "rerun")}
        item.update(over)
        plan = {"run_id": "toy-001", "repository": str(self.repo), "base_commit": self.commit,
                "nodes": {}, "conventions": None, "attack": item}
        save_json(self.run / "plan.json", plan)
        save_json(self.run / "policy.json", {"version": "1.3.0", "feature": "f", "independent_review": True,
                  "integration_approval": True, "setup": list(setup),
                  "workers": [{"node_id": "x", "role": "backend", "required_check_kinds": ["unit"], "owned_paths": ["a"],
                               "checks": [{"id": "c", "kind": "unit", "argv": ["true"], "timeout_seconds": 60, "scenarios": []}]}],
                  "attack_check": {"argv": ["sh", "{file}"], "timeout_seconds": 60}})
        save_json(self.run / "review-bundle.json", {"run_id": "toy-001", "candidate_commit": self.commit})
        return plan

    def set_control(self, **spec):
        self.control.write_text(json.dumps(spec))

    def env(self):
        return {**os.environ, "WORKFLOW_CLAUDE": str(self.fake), "FAKE_CLAUDE_CONTROL": str(self.control),
                "MD_MANAGER_PROJECTS_CONFIG": str(self.tmp / "registry.json")}

    def run_child(self):
        with mock.patch.dict(os.environ, self.env(), clear=True):
            attack.AttackChild(self.run).run()
        return read_json(self.run / "attack.json")


class HappyPath(ChildHarness):
    def test_verified_finding_flows_through_rerun_and_skeptic(self):
        """run_angle -> rerun_findings -> skeptic_job -> finish, with a failing test reproduced then verified (PRD 8)."""
        self.build()
        self.set_control(
            attacker={"findings": [{"id": "f1", "severity": "P1", "title": "t", "threat": "th", "requirement": "R",
                                    "test_file": "attack-tests/t1.sh", "body": "exit 1\n", "expected": "e", "observed": "o"}]},
            skeptic={"verdicts": [{"id": "A-1", "verdict": "verified", "reason": "sound", "severity": "P1"}]})
        record = self.run_child()
        self.assertEqual(record["status"], "succeeded")
        self.assertEqual(record["findings"][0]["status"], "verified")
        self.assertEqual(record["findings"][0]["rerun"]["status"], "reproduced")
        self.assertEqual(record["attackers"][0]["skeptic"]["status"], "succeeded")
        validate_schema("attack", record)
        events = [json.loads(line) for line in (self.run / "events.jsonl").read_text().splitlines() if line.strip()]
        closing = [e for e in events if e["node"] == "attack"]
        self.assertEqual(closing[-1]["message"], "Attack pass: 1 finding(s), 1 reproduced, 1 verified")
        attn = read_json(self.run / "attention.json")
        self.assertTrue(any(s.get("kind") == "attack" for s in attn.get("states", [])))

    def test_a_passing_test_is_not_reproduced_and_never_reaches_the_skeptic(self):
        self.build()
        self.set_control(
            attacker={"findings": [{"id": "f1", "severity": "P1", "title": "t", "threat": "th", "requirement": None,
                                    "test_file": "attack-tests/pass.sh", "body": "exit 0\n", "expected": "e", "observed": "o"}]},
            skeptic={"verdicts": [{"id": "A-1", "verdict": "verified", "reason": "x", "severity": "P1"}]})
        record = self.run_child()
        self.assertEqual(record["status"], "succeeded")
        self.assertEqual(record["findings"][0]["rerun"]["reason"], "passed")
        self.assertEqual(record["findings"][0]["status"], "not_reproduced")
        self.assertEqual(record["attackers"][0]["skeptic"]["status"], "not_run")

    def test_refuted_finding(self):
        self.build()
        self.set_control(
            attacker={"findings": [{"id": "f1", "severity": "P1", "title": "t", "threat": "th", "requirement": None,
                                    "test_file": "attack-tests/t.sh", "body": "exit 1\n", "expected": "e", "observed": "o"}]},
            skeptic={"verdicts": [{"id": "A-1", "verdict": "refuted", "reason": "benign", "severity": "P1"}]})
        record = self.run_child()
        self.assertEqual(record["findings"][0]["status"], "refuted")


class AttackerFailure(ChildHarness):
    def test_a_timed_out_attacker_leaves_the_pass_succeeded_and_no_skeptic(self):
        self.build()
        self.set_control(attacker={"findings": []})
        with mock.patch.object(attack.AttackChild, "attacker_job", lambda self, angle, n, sid: (None, 0.5)):
            with mock.patch.dict(os.environ, self.env(), clear=True):
                attack.AttackChild(self.run).run()
        record = read_json(self.run / "attack.json")
        self.assertEqual(record["status"], "succeeded")
        self.assertEqual(record["attackers"][0]["status"], "timed_out")
        validate_schema("attack", record)

    def test_an_attacker_that_crashes_is_failed_and_the_pass_integrates(self):
        self.build()
        self.set_control(attacker={"findings": []})

        def boom(self, angle, n, sid):
            raise attack.JobFailed("the attacker print job did not succeed")
        with mock.patch.object(attack.AttackChild, "attacker_job", boom):
            with mock.patch.dict(os.environ, self.env(), clear=True):
                attack.AttackChild(self.run).run()
        record = read_json(self.run / "attack.json")
        self.assertEqual(record["status"], "succeeded")  # the pass itself ends cleanly; the attacker is failed
        self.assertEqual(record["attackers"][0]["status"], "failed")
        validate_schema("attack", record)

    def test_invalid_structured_output_fails_the_attacker(self):
        self.build()
        self.set_control(attacker={"bad_structured": True, "findings": []})
        record = self.run_child()
        self.assertEqual(record["status"], "succeeded")
        self.assertEqual(record["attackers"][0]["status"], "failed")


class TestFileGuard(ChildHarness):
    """[L16]/fix 7: a reported test_file is accepted only as a regular file under an attack-tests directory, no symlink."""

    def test_a_path_outside_attack_tests_is_not_reproduced_no_test(self):
        self.build()
        self.set_control(
            attacker={"findings": [{"id": "f1", "severity": "P1", "title": "t", "threat": "th", "requirement": None,
                                    "test_file": "src/sneaky.sh", "body": "exit 1\n", "expected": "e", "observed": "o"}]})
        record = self.run_child()
        self.assertEqual(record["findings"][0]["rerun"]["reason"], "no_test")
        self.assertEqual(record["findings"][0]["status"], "not_reproduced")
        self.assertEqual(record["attackers"][0]["skeptic"]["status"], "not_run")

    def test_a_symlink_under_attack_tests_is_rejected(self):
        self.build()
        # The attacker's job writes attack-tests/link.sh as a symlink to the tracked candidate file; the guard rejects it.
        self.set_control(
            attacker={"findings": [{"id": "f1", "severity": "P1", "title": "t", "threat": "th", "requirement": None,
                                    "test_file": "attack-tests/link.sh", "symlink_to": "../app.txt", "expected": "e", "observed": "o"}]})
        record = self.run_child()
        self.assertEqual(record["findings"][0]["rerun"]["reason"], "no_test")
        self.assertEqual(record["findings"][0]["status"], "not_reproduced")


class TwoAngleIsolation(ChildHarness):
    """[L2]: a two-angle pass runs the second attacker on a clean worktree; a test left by one finding never re-runs next."""

    def test_second_angle_starts_clean_and_prior_test_does_not_re_run(self):
        self.build(angles=("inputs-state", "auth-funds"))
        self.set_control(
            attacker={"findings": [{"id": "g1", "severity": "P2", "title": "t", "threat": "th", "requirement": None,
                                    "test_file": "attack-tests/first.sh", "body": "exit 1\n", "expected": "e", "observed": "o"}]},
            skeptic={"verdicts": []})
        record = self.run_child()
        # Both attackers used the one worktree; the first angle's finding is A-1, the second angle's is A-2 (same body).
        self.assertEqual([a["angle"] for a in record["attackers"]], ["inputs-state", "auth-funds"])
        ids = [f["id"] for f in record["findings"]]
        self.assertEqual(ids, ["A-1", "A-2"])
        # The re-run worktree is reset before each finding: the first finding's test is gone before the second runs.
        self.assertEqual(record["findings"][0]["attacker"], "inputs-state")
        self.assertEqual(record["findings"][1]["attacker"], "auth-funds")
        # Each re-run copied only its own test; a left-over test from A-1 never affects A-2's re-run.
        self.assertTrue(all(f["rerun"]["status"] == "reproduced" for f in record["findings"]))


class Resume(ChildHarness):
    """[L15]/fix 1: a child interrupted after the attacker saved runs the owed re-runs and skeptic on resume, recovering
    each finding's test source from disk (never memory only)."""

    def test_interrupt_after_attacker_then_resume_verifies(self):
        self.build()
        self.set_control(
            attacker={"findings": [{"id": "f1", "severity": "P1", "title": "t", "threat": "th", "requirement": None,
                                    "test_file": "attack-tests/t1.sh", "body": "exit 1\n", "expected": "e", "observed": "o"}]},
            skeptic={"verdicts": [{"id": "A-1", "verdict": "verified", "reason": "sound", "severity": "P1"}]})
        calls = {"n": 0}
        original = attack.AttackChild.rerun_findings

        def once(self, record, angle):
            calls["n"] += 1
            if calls["n"] == 1:
                raise KeyboardInterrupt
            return original(self, record, angle)
        with mock.patch.dict(os.environ, self.env(), clear=True):
            with mock.patch.object(attack.AttackChild, "rerun_findings", once):
                with self.assertRaises(KeyboardInterrupt):
                    attack.AttackChild(self.run).run()
            # The interrupt landed after run_angle saved: attacker succeeded, the finding owes its re-run (rerun is null).
            interrupted = read_json(self.run / "attack.json")
            self.assertEqual(interrupted["status"], "running")
            self.assertEqual(interrupted["attackers"][0]["status"], "succeeded")
            self.assertIsNone(interrupted["findings"][0]["rerun"])
            validate_schema("attack", interrupted)
            # A fresh child (empty memory) resumes: it must recover the test source path from disk and finish.
            attack.AttackChild(self.run).run()
        record = read_json(self.run / "attack.json")
        self.assertEqual(record["status"], "succeeded")
        self.assertEqual(record["findings"][0]["status"], "verified")
        self.assertEqual(record["attackers"][0]["skeptic"]["status"], "succeeded")
        validate_schema("attack", record)


class AttackerPromptIndependence(ChildHarness):
    """PRD 4.8/O9: the attacker prompt carries none of the workers' completions, the sidecar ledger or review.json."""

    def test_prompt_excludes_completions_ledger_and_review(self):
        plan = self.build()
        # Seed the forbidden inputs in the run directory; the prompt must not include any of them.
        (self.run / "x.completion.json").write_text(json.dumps({"summary": "WORKER-COMPLETION-SECRET"}))
        (self.run / "sidecar.ledger.json").write_text(json.dumps({"messages": [{"text": "LEDGER-SECRET"}]}))
        (self.run / "review.json").write_text(json.dumps({"findings": [{"message": "REVIEW-SECRET"}]}))
        prompt = attack.attacker_prompt(self.run, plan, "auth-funds")
        for secret in ("WORKER-COMPLETION-SECRET", "LEDGER-SECRET", "REVIEW-SECRET"):
            self.assertNotIn(secret, prompt)
        self.assertIn("attack-tests", prompt)  # the protocol is present


class CloseOrWait(ChildHarness):
    """close_or_wait_attack ([L4], [L9]): decided review waits for the pass; no review.json fails it; an interrupt records nothing."""

    def _runtime(self, plan):
        rt = mock.Mock()
        rt.directory = self.run
        rt.plan = plan
        rt.policy = {"version": "1.3.0", "setup": []}
        return rt

    def _running_record_with_finding(self, plan):
        record = {**attack.initial_record(plan, self.commit, "2026-10-05T09:00:00Z")}  # status stays "running"
        record["attackers"] = [{"id": "auth-funds", "angle": "auth-funds", "status": "succeeded", "started_at": "t",
                                "finished_at": "t", "error": None, "session_id": "s", "cost_usd": 1.0, "summary": None,
                                "out_of_reach": [], "skeptic": {"status": "running", "started_at": "t", "finished_at": None,
                                "error": None, "session_id": "s", "cost_usd": None}}]
        record["findings"] = [{"id": "A-1", "ref": "f1", "attacker": "auth-funds", "severity": "P1", "title": "t", "threat": "t",
                               "requirement": None, "test_file": "attack/auth-funds/A-1.test.sh", "expected": "e", "observed": "o",
                               "rerun": {"status": "reproduced", "reason": None, "exit_code": 1, "duration_seconds": 1.0,
                               "output_tail": "FAIL", "at": "t"}, "skeptic": None, "status": "unjudged", "labels": []}]
        attack.save_record(self.run, record)

    def test_decided_review_keeps_a_succeeded_pass_that_ends_after_the_block(self):
        """[L9]/sidecar new-1: the child is still running when the review blocks; close_or_wait waits, and once the child
        writes its succeeded record (with its findings) the pass is kept succeeded, never overwritten failed."""
        plan = self.build()
        (self.run / "review.json").write_text(json.dumps({"verdict": "blocked", "reviewers": [
            {"reviewer_id": "review", "accepted_at": "2026-10-05T10:00:00Z"}]}))
        self._running_record_with_finding(plan)  # The pass is still running at the block.

        def finish_the_pass(_):  # The child ends after the block: it writes succeeded while close_or_wait waits.
            record = read_json(self.run / "attack.json")
            record.update(status="succeeded", finished_at="2026-10-05T10:05:00Z")
            record["findings"][0]["status"] = "verified"
            record["findings"][0]["skeptic"] = {"verdict": "verified", "reason": "r", "severity": "P1"}
            record["attackers"][0]["skeptic"].update(status="succeeded", finished_at="t")
            attack.save_record(self.run, record)
        attack.close_or_wait_attack(self._runtime(plan), RuntimeError("blocked"), clock=lambda: 0.0, sleep=finish_the_pass, bound=10000)
        record = read_json(self.run / "attack.json")
        self.assertEqual(record["status"], "succeeded")
        self.assertEqual([f["id"] for f in record["findings"]], ["A-1"])  # the attacker's finding is kept
        self.assertEqual(record["findings"][0]["status"], "verified")
        if (self.run / "events.jsonl").exists():
            messages = [json.loads(line)["message"] for line in (self.run / "events.jsonl").read_text().splitlines() if line.strip()]
            self.assertNotIn("Attack pass ended: failed", messages)

    def test_a_ctrl_c_during_the_decided_wait_stops_the_child_and_records_nothing(self):
        """sidecar new-2: a controller interrupt while waiting out a decided review stops the child and leaves the record
        running (records nothing) so the next controller resumes; the interrupt propagates."""
        plan = self.build()
        (self.run / "review.json").write_text(json.dumps({"verdict": "blocked", "reviewers": [
            {"reviewer_id": "review", "accepted_at": "2026-10-05T10:00:00Z"}]}))
        self._running_record_with_finding(plan)

        def interrupt(_):
            raise KeyboardInterrupt
        with mock.patch.object(attack, "stop_child") as stop:
            with self.assertRaises(KeyboardInterrupt):
                attack.close_or_wait_attack(self._runtime(plan), RuntimeError("blocked"), clock=lambda: 0.0, sleep=interrupt, bound=10000)
            stop.assert_called_once_with(self.run)  # the detached child is stopped before the interrupt propagates
        self.assertEqual(read_json(self.run / "attack.json")["status"], "running")  # records nothing

    def test_no_review_json_records_the_pass_failed_with_one_closing_event(self):
        plan = self.build()
        attack.close_or_wait_attack(self._runtime(plan), RuntimeError("review crashed"), clock=lambda: 0.0, sleep=lambda _: None)
        record = read_json(self.run / "attack.json")
        self.assertEqual(record["status"], "failed")
        events = [json.loads(line) for line in (self.run / "events.jsonl").read_text().splitlines() if line.strip()]
        closing = [e for e in events if e["node"] == "attack"]
        self.assertEqual(closing[-1]["status"], "succeeded")
        self.assertEqual(closing[-1]["message"], "Attack pass ended: failed")

    def test_a_keyboard_interrupt_with_no_review_json_records_nothing(self):
        plan = self.build()
        attack.close_or_wait_attack(self._runtime(plan), KeyboardInterrupt(), clock=lambda: 0.0, sleep=lambda _: None)
        self.assertFalse((self.run / "attack.json").exists())


# ---- the review's decision time, the tally runtime and the [L12] flag ([L18], fixes 2 and 3) ------------------------

class ReviewDecidedAt(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.dir, ignore_errors=True)

    def test_decision_time_is_the_latest_non_null_accepted_at_in_review_json_content(self):
        save_json(self.dir / "review.json", {"verdict": "approved", "reviewers": [
            {"reviewer_id": "general", "accepted_at": "2026-10-05T10:00:00Z"},
            {"reviewer_id": "coverage", "accepted_at": "2026-10-05T10:02:00Z"}]})
        # An approved run re-saves review.json after the pass waits: the file mtime is far later than the content time.
        os.utime(self.dir / "review.json", (time.time() + 10000, time.time() + 10000))
        decided, pending = attack._review_decided_at(self.dir)
        self.assertEqual(decided, "2026-10-05T10:02:00Z")
        self.assertFalse(pending)

    def test_a_null_accepted_at_marks_the_decision_time_as_an_upper_bound(self):
        save_json(self.dir / "review.json", {"verdict": "approved", "reviewers": [
            {"reviewer_id": "general", "accepted_at": "2026-10-05T10:00:00Z"},
            {"reviewer_id": "coverage", "accepted_at": None}]})
        decided, pending = attack._review_decided_at(self.dir)
        self.assertEqual(decided, "2026-10-05T10:00:00Z")
        self.assertTrue(pending)

    def test_no_review_json_is_none(self):
        self.assertEqual(attack._review_decided_at(self.dir), (None, False))


class TallyRuntime(unittest.TestCase):
    """fixes 2, 3 and notes 1/5: added runtime per run and total, and the [L12] early-finish flag, from review.json content."""

    def _run(self, root, run_id, review, attack_record):
        runs_root = root / "runs"
        runs_root.mkdir(exist_ok=True)
        run = runs_root / run_id
        run.mkdir()
        save_json(run / "plan.json", plan_with_attack(run_id))
        if review is not None:
            save_json(run / "review.json", review)
        if attack_record is not None:
            attack.save_record(run, attack_record)
        return runs_root

    def _record(self, finished_at, attacker_finished):
        plan = plan_with_attack()
        record = {**attack.initial_record(plan, "c" * 40, "2026-10-05T09:00:00Z"), "status": "succeeded", "finished_at": finished_at}
        record["attackers"] = [{"id": "auth-funds", "angle": "auth-funds", "status": "succeeded", "started_at": "t",
                                "finished_at": attacker_finished, "error": None, "session_id": "s", "cost_usd": None, "summary": None,
                                "out_of_reach": [], "skeptic": {"status": "not_run", "started_at": None, "finished_at": None,
                                "error": None, "session_id": None, "cost_usd": None}}]
        record["findings"] = []
        return record

    def _tally(self, root, runs_root):
        registry = root / "registry.json"
        save_json(registry, {"version": 1, "projects": [{"project_id": "p", "repository": str(root),
                  "workflows": [{"workflow_id": "attack-pass", "runs_root": str(runs_root)}]}]})
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            attack.tally_main(["--registry", str(registry)])
        return out.getvalue()

    def test_added_runtime_and_the_flag_use_review_json_content(self):
        root = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, root, ignore_errors=True)
        review = {"verdict": "approved", "reviewers": [{"reviewer_id": "r", "accepted_at": "2026-10-05T10:00:00Z"}]}
        # The attacker finished at 10:03, after the review decided at 10:00: not an early finish. The pass finished at 10:05:
        # added runtime is 300 s (max(0, finished − decision)).
        record = self._record("2026-10-05T10:05:00Z", "2026-10-05T10:03:00Z")
        runs_root = self._run(root, "attack-pass-001", review, record)
        os.utime(runs_root / "attack-pass-001" / "review.json", (time.time() + 10000, time.time() + 10000))
        text = self._tally(root, runs_root)
        self.assertIn("added runtime", text)
        self.assertIn("300", text)
        self.assertNotIn("finished before review decided", text)

    def test_an_attacker_that_finished_before_the_decision_is_flagged(self):
        root = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, root, ignore_errors=True)
        review = {"verdict": "approved", "reviewers": [{"reviewer_id": "r", "accepted_at": "2026-10-05T10:00:00Z"}]}
        record = self._record("2026-10-05T10:05:00Z", "2026-10-05T09:59:00Z")  # before the decision
        runs_root = self._run(root, "attack-pass-001", review, record)
        text = self._tally(root, runs_root)
        self.assertIn("finished before review decided: auth-funds", text)

    def test_a_null_reviewer_makes_runtime_and_flag_unknown(self):
        root = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, root, ignore_errors=True)
        review = {"verdict": "approved", "reviewers": [{"reviewer_id": "a", "accepted_at": "2026-10-05T10:00:00Z"},
                                                       {"reviewer_id": "b", "accepted_at": None}]}
        record = self._record("2026-10-05T10:05:00Z", "2026-10-05T09:30:00Z")
        runs_root = self._run(root, "attack-pass-001", review, record)
        text = self._tally(root, runs_root)
        self.assertIn("a reviewer ran past the decision", text)

    def test_a_missing_time_leaves_runtime_unknown_and_out_of_the_total(self):
        root = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, root, ignore_errors=True)
        # No review.json at all: the decision time is unknown, so the run's added runtime is unknown and left out of the total.
        record = self._record("2026-10-05T10:05:00Z", "2026-10-05T09:30:00Z")
        runs_root = self._run(root, "attack-pass-001", None, record)
        text = self._tally(root, runs_root)
        self.assertIn("unknown", text)


# ---- attack-pass holds both controller locks ([L14], fix 5) ----------------------------------------------------------

class PassLocks(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.dir, ignore_errors=True)
        save_json(self.dir / "plan.json", plan_with_attack())
        save_json(self.dir / "review-bundle.json", {"candidate_commit": "c" * 40})

    def test_refused_while_the_supervisor_lock_is_held(self):
        with run_lock(self.dir, "automatic-supervisor.lock"):
            with self.assertRaisesRegex(SystemExit, "Another controller owns this run"):
                attack.pass_main([str(self.dir), "--by", "operator"])

    def test_refused_while_the_controller_lock_is_held(self):
        with run_lock(self.dir):
            with self.assertRaisesRegex(SystemExit, "Another controller owns this run"):
                attack.pass_main([str(self.dir), "--by", "operator"])

    def test_a_supervisor_is_refused_during_a_pass_without_blocking(self):
        # While pass_main holds both locks (it runs run_child in the foreground), a supervisor starting then is refused the
        # supervisor lock, non-blocking, so the run is not blocked. Patch run_child to stand in for the pass's body.
        seen = {}

        def fake_run_child(run):
            try:
                with run_lock(Path(run), "automatic-supervisor.lock"):  # what a starting supervisor would attempt
                    seen["refused"] = None
            except RuntimeError as error:
                seen["refused"] = str(error)
        with mock.patch.object(attack, "run_child", fake_run_child):
            attack.pass_main([str(self.dir), "--by", "operator"])
        self.assertEqual(seen.get("refused"), "Another controller owns this run")


if __name__ == "__main__":
    unittest.main()


# ---- run 003 review P1s: setup in the worktrees, the guard on resume, recover(), a terminated child -------------------

ONE_FINDING = {"id": "f1", "severity": "P1", "title": "t", "threat": "th", "requirement": "R",
               "test_file": "attack-tests/t1.sh", "body": "exit 1\n", "expected": "e", "observed": "o"}
VERIFIED = {"id": "A-1", "verdict": "verified", "reason": "sound", "severity": "P1"}


def alive(pid: int) -> bool:
    """A live process (a zombie, already exited, counts as gone)."""
    try:
        state = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()[0]
    except (OSError, IndexError):
        return False
    return state != "Z"


def attack_events(run: Path) -> list:
    return [e for e in (json.loads(line) for line in (run / "events.jsonl").read_text().splitlines() if line.strip())
            if e["node"] == "attack"]


class SetupInWorktrees(ChildHarness):
    """The policy's setup runs in both attack worktrees before the attacker (PRD 4.3/4.4), its logs land in `<run>/attack/`,
    and a setup that was interrupted runs again when the child resumes."""

    SETUP = [{"argv": ["sh", "-c", "mkdir -p build && echo ready > build/out"], "timeout_seconds": 60}]

    def test_setup_runs_in_both_worktrees_and_the_pass_verifies(self):
        self.build(setup=self.SETUP)
        self.set_control(attacker={"findings": [ONE_FINDING]}, skeptic={"verdicts": [VERIFIED]})
        record = self.run_child()
        self.assertEqual(record["status"], "succeeded", record.get("error"))
        self.assertEqual(record["findings"][0]["status"], "verified")
        for name in ("worktree", "rerun"):
            self.assertTrue((self.run / "attack" / f"setup-{name}-0.log").is_file())
            self.assertTrue((self.run / "attack" / f"setup-{name}.done").is_file())
        # The reset before each re-run keeps ignored setup outputs ([L10]).
        self.assertEqual((self.tmp / "attack" / "rerun" / "build" / "out").read_text(), "ready\n")
        validate_schema("attack", record)

    def test_an_interrupted_setup_runs_again_on_resume(self):
        self.build(setup=self.SETUP)
        self.set_control(attacker={"findings": [ONE_FINDING]}, skeptic={"verdicts": [VERIFIED]})
        calls = []
        original = attack.run_setup

        def interrupted_once(policy, worktree, log_dir, env, prefix="setup"):
            calls.append(Path(worktree).name)
            if len(calls) == 1:
                raise KeyboardInterrupt
            return original(policy, worktree, log_dir, env, prefix=prefix)
        with mock.patch.dict(os.environ, self.env(), clear=True), mock.patch.object(attack, "run_setup", interrupted_once):
            with self.assertRaises(KeyboardInterrupt):
                attack.AttackChild(self.run).run()
            self.assertEqual(read_json(self.run / "attack.json")["status"], "running")
            attack.AttackChild(self.run).run()
        self.assertEqual(calls, ["worktree", "worktree", "rerun"])
        self.assertEqual(read_json(self.run / "attack.json")["findings"][0]["status"], "verified")


class SecretGuardOnResume(ChildHarness):
    """PRD 4.2 and O13: the pinned secret-file list is checked again whenever the child starts, a resumed one included, and
    before each angle; a file that reappeared refuses the pass and nothing more runs."""

    def test_a_secret_file_that_reappears_refuses_the_resumed_pass(self):
        secret = self.tmp / "wallet.env"
        self.build(secret_files=[str(secret)])
        self.set_control(attacker={"findings": [ONE_FINDING]}, skeptic={"verdicts": [VERIFIED]})
        original = attack.AttackChild.rerun_findings

        def interrupted(child, record, angle):
            raise KeyboardInterrupt
        with mock.patch.dict(os.environ, self.env(), clear=True):
            with mock.patch.object(attack.AttackChild, "rerun_findings", interrupted), self.assertRaises(KeyboardInterrupt):
                attack.AttackChild(self.run).run()
            self.assertIsNone(read_json(self.run / "attack.json")["findings"][0]["rerun"])  # The re-run is still owed.
            secret.write_text("KEY=not-a-real-key\n")  # The listed file reappears before the next controller resumes.
            with mock.patch.object(attack.AttackChild, "rerun_findings", side_effect=AssertionError("re-ran")) as rerun:
                attack.AttackChild(self.run).run()
            rerun.assert_not_called()
        self.assertIs(original, attack.AttackChild.rerun_findings)
        record = read_json(self.run / "attack.json")
        self.assertEqual(record["status"], "refused")
        self.assertIn(str(secret), record["error"])
        self.assertIsNone(record["findings"][0]["rerun"])  # Kept as recorded: nothing re-ran.
        self.assertEqual(record["attackers"][0]["skeptic"]["status"], "not_run")
        self.assertFalse((self.tmp / "attack" / "rerun" / "attack-tests" / "t1.sh").exists())
        events = attack_events(self.run)
        self.assertEqual((events[-2]["status"], events[-2]["message"]), ("interactive", f"Attack pass refused: {secret} exists on this host"))
        self.assertEqual((events[-1]["status"], events[-1]["message"]), ("succeeded", "Attack pass ended: refused"))
        validate_schema("attack", record)

    def test_a_secret_file_that_appears_between_angles_refuses_the_second_attacker(self):
        secret = self.tmp / "wallet.env"
        self.build(angles=("inputs-state", "auth-funds"), secret_files=[str(secret)])
        self.set_control(attacker={"findings": []}, skeptic={"verdicts": []})
        original = attack.AttackChild.run_attacker

        def then_the_file_appears(child, record, angle, n):
            attacker = original(child, record, angle, n)
            secret.write_text("KEY=not-a-real-key\n")
            return attacker
        with mock.patch.dict(os.environ, self.env(), clear=True), \
                mock.patch.object(attack.AttackChild, "run_attacker", then_the_file_appears):
            attack.AttackChild(self.run).run()
        record = read_json(self.run / "attack.json")
        self.assertEqual([(a["angle"], a["status"]) for a in record["attackers"]],
                         [("inputs-state", "succeeded"), ("auth-funds", "refused")])
        self.assertEqual(record["status"], "refused")
        self.assertEqual(list(read_json(self.run / attack.JOBS)), ["inputs-state"])  # The second attacker never started.
        self.assertEqual(attack_events(self.run)[-1]["message"], "Attack pass ended: refused")
        validate_schema("attack", record)


def attacker_entry(angle: str, status: str, skeptic: str = "not_run") -> dict:
    return {"id": angle, "angle": angle, "status": status, "started_at": "2026-10-05T10:00:00Z", "finished_at": None,
            "error": None, "session_id": f"s-{angle}", "cost_usd": None, "summary": None, "out_of_reach": [],
            "skeptic": {"status": skeptic, "started_at": None, "finished_at": None, "error": None, "session_id": None, "cost_usd": None}}


class Recover(ChildHarness):
    """[L3], G7: a resumed child kills a recorded orphan (only through sidecar.kill_orphan's pid-and-session check) and
    records an attacker or skeptic left running as failed (interrupted); nothing reruns it."""

    def test_running_attacker_and_skeptic_become_failed_interrupted_and_orphans_are_killed(self):
        plan = self.build(angles=("inputs-state", "auth-funds"))
        record = attack.initial_record(plan, self.commit, "2026-10-05T10:00:00Z")
        record["attackers"] = [attacker_entry("inputs-state", "running"), attacker_entry("auth-funds", "succeeded", skeptic="running")]
        save_json(self.run / attack.JOBS, {"inputs-state": {"pid": 4242, "session_id": "sa"},
                                           "auth-funds.skeptic": {"pid": 4343, "session_id": "sb"}})
        with mock.patch("workflow.sidecar.kill_orphan") as kill:
            attack.AttackChild(self.run).recover(record)
        self.assertEqual(sorted(call.args for call in kill.call_args_list), [(4242, "sa"), (4343, "sb")])
        saved = read_json(self.run / "attack.json")
        first, second = saved["attackers"]
        self.assertEqual((first["status"], first["error"]), ("failed", "interrupted"))
        self.assertEqual((second["status"], second["skeptic"]["status"], second["skeptic"]["error"]), ("succeeded", "failed", "interrupted"))
        validate_schema("attack", saved)


class TerminatedChild(ChildHarness):
    """[L3]: stopping the child (stop_child: SIGTERM to its process group) also ends its attacker job, which runs in its own
    session; nothing is left running, the stop records nothing, and the next child records the attacker interrupted."""

    def test_stop_child_leaves_no_attacker_process_and_resume_records_it_interrupted(self):
        self.build()
        self.set_control(attacker={"hang": True})
        env = {**self.env(), "PYTHONPATH": str(ROOT)}
        child = subprocess.Popen([sys.executable, "-m", "workflow.attack", str(self.run)], cwd=str(self.tmp), env=env,
                                 start_new_session=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.addCleanup(lambda: child.poll() is None and child.kill())
        jobs = self.run / attack.JOBS
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline and not (jobs.exists() and read_json(jobs).get("auth-funds")):
            time.sleep(0.1)
        attacker_pid = read_json(jobs)["auth-funds"]["pid"]
        self.assertTrue(alive(attacker_pid))
        attack.stop_child(self.run)
        child.wait(timeout=30)
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline and alive(attacker_pid):
            time.sleep(0.1)
        self.assertFalse(alive(attacker_pid))
        self.assertEqual(read_json(self.run / "attack.json")["attackers"][0]["status"], "running")  # The stop recorded nothing.
        with mock.patch.dict(os.environ, self.env(), clear=True):
            attack.AttackChild(self.run).run()
        record = read_json(self.run / "attack.json")
        self.assertEqual((record["attackers"][0]["status"], record["attackers"][0]["error"]), ("failed", "interrupted"))
        self.assertEqual(record["status"], "succeeded")
        validate_schema("attack", record)


class SetupMarkerAfterWorktreeLoss(SetupInWorktrees):
    """Hardening: if a worktree is gone but its done-marker survives, a re-added fresh worktree is set up again, never skipped."""

    def test_a_fresh_worktree_whose_marker_survives_is_set_up_again(self):
        self.build(setup=self.SETUP)
        self.set_control(attacker={"findings": [ONE_FINDING]}, skeptic={"verdicts": [VERIFIED]})
        self.assertEqual(self.run_child()["status"], "succeeded")
        rerun_wt = self.tmp / "attack" / "rerun"
        self.assertTrue((self.tmp / "attack" / "rerun" / "build" / "out").is_file())
        # The worktree is removed (its build output with it) but the done marker is left behind.
        from workflow.worktrees import git_worktree
        git_worktree(str(self.repo), "remove", "--force", str(rerun_wt))
        self.assertTrue((self.run / "attack" / "setup-rerun.done").is_file())
        self.assertFalse(rerun_wt.exists())
        # Force the pass to resume (not terminal) and run again: the re-added worktree must be set up afresh.
        record = read_json(self.run / "attack.json")
        record["status"] = "running"
        save_json(self.run / "attack.json", record)
        with mock.patch.dict(os.environ, self.env(), clear=True):
            attack.AttackChild(self.run).run()
        self.assertEqual((self.tmp / "attack" / "rerun" / "build" / "out").read_text(), "ready\n")
