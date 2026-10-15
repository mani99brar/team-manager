"""The multi-provider panel engine (docs/PRD_MULTI_PROVIDER_PANEL.md sections 3, 4, Appendix A; the engine task's acceptance),
with no model calls: fake `claude` and fake `pi` jobs over a toy repository, the captured `pi --mode json` fixture and the
captured `claude --print` probe under workflow/testdata/panel/."""
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
from types import SimpleNamespace
from unittest import mock

from . import panel
from .sessions import read_json, save_json
from .verification import validate_schema

ROOT = Path(__file__).resolve().parents[1]


def setUpModule():
    """As test_automatic/test_pipeline: the attention feed and registry go to a temporary folder (never the operator's), and
    prepare's `claude --version` reads a stand-in."""
    from .test_pipeline import isolate_registry, stub_claude_cli
    isolate_registry()
    stub_claude_cli()
TESTDATA = Path(__file__).resolve().parent / "testdata" / "panel"


def appendix_records() -> list[dict]:
    """Both JSON records of the PRD's Appendix A (they sit indented inside a bullet, so the closing fence tolerates whitespace)."""
    prd = (ROOT / "docs" / "PRD_MULTI_PROVIDER_PANEL.md").read_text()
    blocks = re.findall(r"```json\n(.*?)\n\s*```", prd[prd.index("## Appendix A"):], re.S)
    return [json.loads(block) for block in blocks]


PROVIDERS = [{"transport": "claude", "model": None, "effort": "high"}, {"transport": "pi", "model": "openai-codex/gpt-6-sol", "effort": None}]


def plan_item(**over) -> dict:
    item = {"id": "review-panel", "stage": "review", "providers": [dict(p) for p in PROVIDERS],
            "prompt": {"source": "builtin:review", "text": "PINNED BRIEF: review the material and reply with findings.", "sha256": "x"},
            "requirements": ["docs/req.md"], "requirement_docs": {"docs/req.md": "REQ-1: the pinned requirements text\n"},
            "budget_usd": 5, "timeout_minutes": 15, "overlap_threshold": 2, "report_only": True, "pi_bin": "/nvm/bin", "prd_label": None}
    item.update(over)
    return item


# ---- the seam: schema, Appendix A, pending/running records -----------------------------------------------------------

class Seam(unittest.TestCase):
    def test_both_appendix_a_records_validate_verbatim(self):
        records = appendix_records()
        self.assertEqual([record["panels"][0]["status"] for record in records], ["succeeded", "pending"])
        for record in records:
            validate_schema("panel", record)

    def test_pending_running_and_every_provider_status_validate_and_nothing_outside_appendix_a(self):
        plan = {"panels": [plan_item()]}
        record = panel.pending_record(plan)
        validate_schema("panel", record)
        self.assertEqual(record["panels"][0]["providers"][1]["effort"], None)
        running = json.loads(json.dumps(record))
        running["panels"][0].update(status="running", started_at="2026-10-06T07:00:00Z")
        for provider in running["panels"][0]["providers"]:
            provider["status"] = "running"
        validate_schema("panel", running)
        for status in ("ok", "timed_out", "error", "parse_failed"):
            item = json.loads(json.dumps(running))
            item["panels"][0]["providers"][0]["status"] = status
            validate_schema("panel", item)
        for threshold in ("all", 1, 3):
            item = json.loads(json.dumps(record))
            item["panels"][0]["overlap_threshold"] = threshold
            validate_schema("panel", item)
        schema = json.loads(panel.SCHEMA.read_text())
        appendix = {"id", "stage", "status", "overlap_threshold", "context_bytes", "providers", "findings", "started_at", "ended_at", "budget_usd", "error"}
        self.assertEqual(set(schema["$defs"]["panel"]["required"]), appendix)
        self.assertEqual(set(schema["$defs"]["panel"]["properties"]), appendix | {"delta_from", "context_truncated"})  # Optional, added within 1.0.0.
        self.assertEqual(set(schema["$defs"]["provider"]["properties"]), {"transport", "model", "effort", "status", "cost_usd", "context_bytes", "finding_ids", "error"})
        self.assertEqual(schema["$defs"]["output"]["type"], "object")  # The claude provider's --json-schema needs an object root.


class ContextCap(unittest.TestCase):
    """cap_sections' order on small caps: bodies largest first, then file diffs largest first, then the documents."""

    def sections(self):
        return [panel.Section("a.py", "--- diff ---\n" + "a\n" * 200, body="A" * 3000), panel.Section("b.py", "--- diff ---\n" + "b\n" * 100, body="B" * 1000),
                panel.Section("docs/prd.md", "P\n" * 2000, document=True)]

    def render(self, sections):
        return "".join(section.render() for section in sections)

    def test_dropping_the_largest_body_is_enough(self):
        sections = self.sections()
        original = len(self.render(sections).encode())
        truncated = panel.cap_sections(sections, original - 2000)
        self.assertEqual(truncated, {"original_bytes": original, "omitted_bodies": ["a.py"], "truncated": [], "omitted_sections": []})
        self.assertIn("--- full file omitted: 3000 bytes, over the context cap ---", self.render(sections))
        self.assertIn("--- full file at the candidate ---\nBBB", self.render(sections))
        self.assertIn("P\n" * 2000, self.render(sections))

    def test_the_documents_are_cut_to_half_the_cap_after_the_bodies_and_before_any_diff(self):
        sections = self.sections()
        truncated = panel.cap_sections(sections, 2500)
        self.assertEqual((truncated["omitted_bodies"], truncated["truncated"], truncated["omitted_sections"]), (["a.py", "b.py"], ["docs/prd.md"], []))
        text = self.render(sections)
        self.assertLessEqual(len(text.encode()), 2500)
        self.assertLessEqual(sections[2].size(), 1250)
        self.assertEqual(len(re.findall(r"^=== truncated: kept \d+ of \d+ bytes ===$", text, re.M)), 1)
        self.assertIn("a\n" * 200, text)  # Both diffs whole.
        self.assertIn("b\n" * 100, text)
        self.assertEqual(panel.context_labels(text), ["a.py", "b.py", "docs/prd.md"])

    def test_documents_alone_over_the_cap_leave_the_diffs_intact(self):
        sections = [panel.Section("a.py", "--- diff ---\n" + "a\n" * 200), panel.Section("docs/prd.md", "P\n" * 3000, document=True),
                    panel.Section("docs/req.md", "R\n" * 2000, document=True)]
        truncated = panel.cap_sections(sections, 4000)
        self.assertEqual((truncated["omitted_bodies"], truncated["truncated"], truncated["omitted_sections"]), ([], ["docs/prd.md", "docs/req.md"], []))
        self.assertEqual(sections[0].diff, "--- diff ---\n" + "a\n" * 200)
        self.assertLessEqual(sections[1].size() + sections[2].size(), 2000)
        self.assertLessEqual(len(self.render(sections).encode()), 4000)

    def test_an_overflow_of_labels_and_notes_alone_drops_whole_sections_largest_first(self):
        """Many touched files with tiny diffs: once every body is omitted (each leaving its note) and no diff can shrink, the
        labels and notes alone are over the cap, so whole sections go, largest first, each leaving one line."""
        def build():
            sections = [panel.Section(f"pkg/m{index:03d}.py", "--- diff ---\n+x\n", body="y" * 100) for index in range(40)]
            sections.append(panel.Section("pkg/the_biggest_module.py", "--- diff ---\n+x\n", body="y" * 120))
            return sections
        floor = build()
        for section in floor:  # What is left once every body is omitted: the diffs are too short to cut.
            section.tail += panel.OMITTED.format(size=len(section.body))
            section.body = None
        cap = len(self.render(floor).encode()) - 300
        sections = build()
        truncated = panel.cap_sections(sections, cap)
        text = self.render(sections)
        self.assertLessEqual(len(text.encode()), cap)
        self.assertEqual((len(truncated["omitted_bodies"]), truncated["truncated"]), (41, []))
        self.assertTrue(truncated["omitted_sections"])
        self.assertEqual(truncated["omitted_sections"][0], "pkg/the_biggest_module.py")
        self.assertIn("--- section omitted: pkg/the_biggest_module.py, ", text)
        self.assertNotIn("pkg/the_biggest_module.py", panel.context_labels(text))
        self.assertEqual(len(panel.context_labels(text)), 41 - len(truncated["omitted_sections"]))

    def test_a_context_that_cannot_fit_is_refused_not_sent(self):
        sections = [panel.Section("docs/prd.md", "P\n", document=True)]
        with self.assertRaisesRegex(ValueError, "after the cap of 5"):
            panel.cap_sections(sections, 5)

    def test_a_context_under_the_cap_is_untouched(self):
        sections = self.sections()
        before = self.render(sections)
        self.assertIsNone(panel.cap_sections(sections, len(before.encode())))
        self.assertEqual(self.render(sections), before)


# ---- configuration and the launch guards (PRD 3, 4.2) ---------------------------------------------------------------

FEATURE_PANEL = {"id": "review-panel", "stage": "review", "providers": [{"transport": "claude", "effort": "high"}, {"transport": "pi", "model": "openai-codex/gpt-6-sol"}],
                 "prompt": "panels/review.md", "requirements": ["docs/security/requirements.md"], "budget_usd": 5, "timeout_minutes": 15,
                 "overlap_threshold": 2, "report_only": True}


class Config(unittest.TestCase):
    def test_panels_are_refused_before_2_6_0_and_declared_with_defaults_at_2_6_0(self):
        with self.assertRaisesRegex(ValueError, "panels needs version 2.6.0"):
            panel.declared({"version": "2.5.0", "panels": [FEATURE_PANEL]})
        [item] = panel.declared({"version": "2.6.0", "panels": [{"id": "p", "stage": "review", "providers": [{"transport": "claude"}], "prompt": "builtin:review", "report_only": True}]})
        self.assertEqual((item["budget_usd"], item["timeout_minutes"], item["overlap_threshold"], item["requirements"]), (5, 15, 2, []))
        self.assertEqual(item["providers"], [{"transport": "claude", "model": None, "effort": None}])
        self.assertIsNone(panel.declared({"version": "2.6.0"}))

    def test_each_refusal_names_its_key(self):
        def refused(pattern, **over):
            with self.assertRaisesRegex(ValueError, pattern):
                panel.declared({"version": "2.6.0", "panels": [{**FEATURE_PANEL, **over}]})
        refused("report_only must be true", report_only=False)
        refused("report_only must be true", report_only="yes")
        refused("needs a model of the form provider/id", providers=[{"transport": "pi"}])
        refused("needs a model of the form provider/id", providers=[{"transport": "pi", "model": "gpt-6-sol"}])
        refused("effort applies to a claude provider only", providers=[{"transport": "pi", "model": "openai-codex/gpt-6-sol", "effort": "high"}])
        refused("transport must be one of", providers=[{"transport": "codex"}])
        refused("distinct by model", providers=[{"transport": "claude"}, {"transport": "claude"}])
        refused("overlap_threshold must be", overlap_threshold=0)
        refused("overlap_threshold must be", overlap_threshold="any")
        refused("timeout_minutes must be an integer", timeout_minutes=0)
        refused("budget_usd must be a number", budget_usd=0)
        refused("is not a panel setting", extra=True)
        refused("stage must be one of", stage="build")
        refused("requirements path", requirements=["../x.md"])
        with self.assertRaisesRegex(ValueError, "panel id twice"):
            panel.declared({"version": "2.6.0", "panels": [FEATURE_PANEL, FEATURE_PANEL]})
        with self.assertRaisesRegex(ValueError, "non-empty list"):
            panel.declared({"version": "2.6.0", "panels": []})

    def test_the_challenge_stage_is_refused_at_launch_this_slice(self):
        [item] = panel.declared({"version": "2.6.0", "panels": [{**FEATURE_PANEL, "stage": "challenge"}]})
        with self.assertRaisesRegex(ValueError, "review stage only"):
            panel.check_launch([item])
        panel.check_launch(panel.declared({"version": "2.6.0", "panels": [FEATURE_PANEL]}))

    def test_the_deepseek_key_guard(self):
        tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, tmp, ignore_errors=True)
        fingerprint = tmp / "panel-deepseek.fingerprint"
        [item] = panel.declared({"version": "2.6.0", "panels": [{**FEATURE_PANEL, "providers": [{"transport": "pi", "model": "deepseek/deepseek-v4-pro"}]}]})
        import hashlib
        key = "sk-rotated"
        good = {"WORKFLOW_PANEL_ALLOW_DEEPSEEK": "1", "DEEPSEEK_API_KEY": key}
        with self.assertRaisesRegex(ValueError, "Blocked: the DeepSeek key"):
            panel.check_launch([item], good, fingerprint)  # absent file
        fingerprint.write_text(hashlib.sha256(key.encode()).hexdigest() + "\n")
        os.chmod(fingerprint, 0o644)
        with self.assertRaisesRegex(ValueError, "Blocked: the DeepSeek key"):
            panel.check_launch([item], good, fingerprint)  # not 0600
        os.chmod(fingerprint, 0o600)
        panel.check_launch([item], good, fingerprint)  # satisfied
        with self.assertRaisesRegex(ValueError, "Blocked: the DeepSeek key"):
            panel.check_launch([item], {**good, "DEEPSEEK_API_KEY": "sk-old"}, fingerprint)  # mismatch
        with self.assertRaisesRegex(ValueError, "Blocked: the DeepSeek key"):
            panel.check_launch([item], {"DEEPSEEK_API_KEY": key}, fingerprint)  # variable unset
        # The key may live only in pi's own login store: the same fingerprint check applies to it.
        store = tmp / "auth.json"
        store.write_text(json.dumps({"deepseek": {"type": "api_key", "key": key}}))
        only_flag = {"WORKFLOW_PANEL_ALLOW_DEEPSEEK": "1"}
        panel.check_launch([item], only_flag, fingerprint, store)  # unset variable, store key matches
        store.write_text(json.dumps({"deepseek": {"type": "api_key", "key": "sk-old"}}))
        with self.assertRaisesRegex(ValueError, "Blocked: the DeepSeek key"):
            panel.check_launch([item], only_flag, fingerprint, store)  # store key does not match the fingerprint
        store.write_text("not json")
        with self.assertRaisesRegex(ValueError, "Blocked: the DeepSeek key"):
            panel.check_launch([item], only_flag, fingerprint, store)  # unreadable store
        with self.assertRaisesRegex(ValueError, "Blocked: the DeepSeek key"):
            panel.check_launch([item], only_flag, fingerprint)  # a plain environment never reads the real store
        # A non-DeepSeek pi provider never consults the guard.
        panel.check_launch(panel.declared({"version": "2.6.0", "panels": [FEATURE_PANEL]}), {}, fingerprint)

    def test_prove_transports_behind_the_runner_seam(self):
        panels = panel.declared({"version": "2.6.0", "panels": [FEATURE_PANEL]})
        calls = []

        def run(argv, **kwargs):
            calls.append(argv)
            if argv[1] == "--help":
                return SimpleNamespace(returncode=0, stdout="--print --max-budget-usd --effort")
            return SimpleNamespace(returncode=0, stdout="0.85.1\n")
        which = lambda name, path=None: {"claude": "/x/claude", "pi": "/nvm/bin/pi"}.get(name)
        self.assertEqual(panel.prove_transports(panels, run=run, environ={"PATH": "/x"}, which=which), {"pi_bin": "/nvm/bin"})
        self.assertEqual([argv[1] for argv in calls], ["--help", "--version"])
        with self.assertRaisesRegex(ValueError, "lacks --max-budget-usd"):
            panel.prove_transports(panels, run=lambda argv, **kw: SimpleNamespace(returncode=0, stdout="--print"), environ={}, which=which)
        with self.assertRaisesRegex(ValueError, "needs `pi`"):
            panel.prove_transports(panels, run=run, environ={"PATH": "/x"}, which=lambda name, path=None: "/x/claude" if name == "claude" else None)
        with self.assertRaisesRegex(ValueError, "exited 3"):
            panel.prove_transports(panels, run=lambda argv, **kw: SimpleNamespace(returncode=0 if argv[1] == "--help" else 3, stdout="--max-budget-usd"), environ={}, which=which)
        # A claude-only panel never resolves pi; a pi-only panel never reads claude --help.
        claude_only = panel.declared({"version": "2.6.0", "panels": [{**FEATURE_PANEL, "providers": [{"transport": "claude"}]}]})
        self.assertEqual(panel.prove_transports(claude_only, run=run, environ={}, which=which), {"pi_bin": None})
        pi_only = panel.declared({"version": "2.6.0", "panels": [{**FEATURE_PANEL, "providers": [{"transport": "pi", "model": "openai-codex/gpt-6-sol"}]}]})
        calls.clear()
        panel.prove_transports(pi_only, run=run, environ={}, which=which)
        self.assertEqual([argv[1] for argv in calls], ["--version"])

    def test_pin_keeps_the_brief_text_and_sha_and_runs_last(self):
        plan = {"feature_version": "2.5.0"}
        panels = panel.declared({"version": "2.6.0", "panels": [FEATURE_PANEL]})
        panel.pin(plan, panels, {"review-panel": ("/src/panels/review.md", "BRIEF TEXT")}, {"docs/security/requirements.md": "SEC"}, "/nvm/bin", "docs/PRD.md")
        [item] = plan["panels"]
        self.assertEqual(item["prompt"], {"source": "/src/panels/review.md", "text": "BRIEF TEXT", "sha256": panel.digest_text("BRIEF TEXT")})
        self.assertEqual(item["requirement_docs"], {"docs/security/requirements.md": "SEC"})
        self.assertEqual((item["pi_bin"], item["prd_label"], plan["feature_version"]), ("/nvm/bin", "docs/PRD.md", "2.6.0"))
        panel.validate_plan(plan)
        with self.assertRaisesRegex(ValueError, "Malformed plan.panels"):
            panel.validate_plan({"panels": [{"id": "x"}]})


# ---- the transport adapter: command builders, environments, parsers (PRD 4.3) -------------------------------------------

class Adapter(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.dir, ignore_errors=True)

    def test_claude_command_is_read_only_with_one_effort_a_budget_an_object_schema_and_no_run_dir_add_dir(self):
        from .sessions import pin_roles
        plan = {"roles": pin_roles(judge_model="claude-opus-5-5", judge_effort="medium", env={})}
        item = plan_item()
        command = panel.claude_command("claude", "sid-1", item["providers"][0], item, self.dir, plan)
        self.assertEqual(command.count("--effort"), 1)
        self.assertEqual(command[command.index("--effort") + 1], "high")  # The entry's effort replaces the judges' pin.
        self.assertEqual(command[command.index("--model") + 1], "claude-opus-5-5")  # No entry model: the judges' pin stands.
        self.assertEqual(command[command.index("--tools") + 1], "Read,Glob,Grep")
        self.assertEqual(command[command.index("--permission-mode") + 1], "dontAsk")
        self.assertNotIn("--add-dir", command)
        self.assertEqual(command[command.index("--max-budget-usd") + 1], "5")
        self.assertEqual(command[-2], "--json-schema")
        schema = json.loads(command[-1])
        self.assertEqual((schema["type"], list(schema["properties"])), ("object", ["findings"]))
        deny = json.loads(command[command.index("--settings") + 1])["permissions"]["deny"]
        self.assertTrue(any("vps-wallet.env" in rule for rule in deny))  # The C14 worker rules.
        self.assertIn(f"Read(/{self.dir.resolve()}/*.json)", deny)  # The run directory's siblings of the review worktree.
        self.assertIn(f"Read(/{self.dir.resolve()}/attack/**)", deny)
        # A plan pinned before roles: the entry's effort is the only one; an entry model is pinned.
        command = panel.claude_command("claude", "sid-1", {"transport": "claude", "model": "claude-sonnet-5-5", "effort": "low"}, item, self.dir, {})
        self.assertEqual((command.count("--effort"), command[command.index("--effort") + 1], command[command.index("--model") + 1]), (1, "low", "claude-sonnet-5-5"))

    def test_pi_command_passes_the_brief_positionally_and_the_context_as_a_relative_at_file(self):
        command = panel.pi_command("/nvm/bin", PROVIDERS[1], "THE BRIEF")
        self.assertEqual(command[:11], ["/nvm/bin/pi", "-p", "--mode", "json", "--no-session", "-nt", "-nc", "-ns", "-ne", "-np", "--model"])
        self.assertEqual(command[11:], ["openai-codex/gpt-6-sol", "THE BRIEF", "@context.txt"])

    def test_pi_env_is_the_scrubbed_set_with_path_home_lang_tmpdir_and_only_the_providers_credential(self):
        environ = {"PATH": "/usr/bin", "HOME": "/home/x", "LANG": "en_US.UTF-8", "TMPDIR": "/t", "DEEPSEEK_API_KEY": "sk", "OPENAI_API_KEY": "no",
                   "CLAUDECODE": "1", "ANTHROPIC_API_KEY": "no", "userEmail": "no"}
        env = panel.pi_env("/nvm/bin", "openai-codex/gpt-6-sol", environ)
        self.assertEqual(env, {"PATH": "/nvm/bin:/usr/local/bin:/usr/bin:/bin", "HOME": "/home/x", "LANG": "en_US.UTF-8", "TMPDIR": "/t"})
        env = panel.pi_env("/nvm/bin", "deepseek/deepseek-v4-pro", environ)
        self.assertEqual(set(env), {"PATH", "HOME", "LANG", "TMPDIR", "DEEPSEEK_API_KEY"})
        self.assertTrue(env["PATH"].startswith("/nvm/bin:"))

    def test_the_normalizer_parses_a_bare_array_an_object_and_one_fence(self):
        self.assertEqual(panel.parse_reply('[{"a": 1}]'), [{"a": 1}])
        self.assertEqual(panel.parse_reply('{"findings": [{"a": 1}]}'), [{"a": 1}])
        self.assertEqual(panel.parse_reply('```json\n[{"a": 1}]\n```'), [{"a": 1}])
        self.assertEqual(panel.parse_reply('```\n{"findings": []}\n```'), [])
        for bad in ("not json", '{"verdict": "x"}', '"text"', "```json\n```json\n[]\n```\n```"):
            with self.assertRaises(ValueError):
                panel.parse_reply(bad)

    def test_the_pi_parser_reads_the_committed_fixture_skips_thinking_and_extracts_the_cost_and_a_freelanced_severity(self):
        """Acceptance item 8: the real `pi --mode json` capture (workflow/testdata/panel/pi-mode-json.jsonl, header lines `#`)."""
        text = (TESTDATA / "pi-mode-json.jsonl").read_text()
        header = [line for line in text.splitlines() if line.startswith("#")]
        self.assertTrue(any("pi --version: 0.85.1" in line for line in header))
        self.assertTrue(any("context_bytes=427378" in line for line in header))
        self.assertTrue(any("argv: pi -p --mode json --no-session -nt -nc -ns -ne -np --model openai-codex/gpt-6-sol" in line for line in header))
        stream = panel.parse_pi_stream(text)
        self.assertIsNone(stream["error"])
        self.assertEqual(stream["cost_usd"], 0.234784)
        raw = panel.parse_reply(stream["text"])
        self.assertEqual([item["severity"] for item in raw], ["high", "high"])  # Freelanced: the enum-removed brief (header).
        events = [json.loads(line) for line in text.splitlines() if line.startswith("{")]
        self.assertEqual(sum(1 for event in events if event["type"] == "message_end"), 2)  # The user echo, then the assistant.
        self.assertTrue(any(part.get("type") == "thinking" for event in events if event["type"] == "message_end"
                            for part in event["message"]["content"]))
        labels = ["packages/api/src/modules/claims/reconcile.ts", "packages/api/src/modules/claims/integrity.ts", "docs/security/requirements.md"]
        findings = panel.normalize_findings(raw, labels, "/nowhere")
        self.assertEqual([(f["severity"], f["file"], f["unanchored"]) for f in findings],
                         [("P1", "packages/api/src/modules/claims/reconcile.ts", False), ("P1", "packages/api/src/modules/claims/integrity.ts", False)])
        self.assertEqual(findings[0]["line"], 66)
        # Thinking-only events and a stream with no assistant reply.
        self.assertEqual(panel.parse_pi_stream('{"type":"thinking","text":"x"}\n{"type":"message_end","message":{"role":"user","content":[]}}\n')["error"],
                         "no assistant message_end event in the pi stream")
        # Via the transport: ok with the findings; a non-JSON reply is parse_failed with its raw text.
        path = self.dir / "pi.stdout.jsonl"
        path.write_text(text)
        result = panel.PiTransport.parse(path, 0, "sid")
        self.assertEqual((len(result["findings"]), result["cost_usd"], result["error"]), (2, 0.234784, None))
        path.write_text('{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"I could not review this."}],"usage":{"cost":{"total":0.01}}}}\n')
        result = panel.PiTransport.parse(path, 0, "sid")
        self.assertEqual((result["findings"], result["raw"], result["cost_usd"]), (None, "I could not review this.", 0.01))

    def test_the_claude_parser_reads_the_committed_probe_and_refuses_an_array_root_result(self):
        probe = read_json(TESTDATA / "claude-print-probe.json")
        path = self.dir / "claude.stdout.json"
        save_json(path, probe["stdout_object"])
        result = panel.ClaudeTransport.parse(path, 0, probe["stdout_object"]["session_id"])
        self.assertEqual(result["error"], None)
        self.assertEqual([f["file"] for f in result["findings"]], ["workflow/x.py"] * 4)  # The canonical label, verbatim.
        self.assertEqual(result["cost_usd"], probe["stdout_object"]["total_cost_usd"])
        self.assertTrue(any("DENIED" in f["detail"] or "denied" in f["detail"] for f in result["findings"] if f["title"] == "PROBE"))
        self.assertEqual(panel.ClaudeTransport.parse(path, 0, "another-session")["findings"], None)
        save_json(path, probe["stdout_array"])
        result = panel.ClaudeTransport.parse(path, 1, probe["stdout_array"]["session_id"])
        self.assertIsNone(result["findings"])
        self.assertIn("Input should be 'object'", result["error"])
        self.assertEqual(json.loads(probe["argv_object"][probe["argv_object"].index("--json-schema") + 1])["type"], "object")
        path.write_text("garbage")
        self.assertIn("wrote no JSON result", panel.ClaudeTransport.parse(path, 0, "s")["error"])


# ---- findings: normalization and overlap (PRD 4.4, Appendix A; acceptance item 2) ----------------------------------------

def finding(file, line=None, title="t", severity="P2", detail="d"):
    return {"severity": severity, "file": file, "line": line, "title": title, "detail": detail}


class Overlap(unittest.TestCase):
    LABELS = ["workflow/x.py", "docs/req.md"]
    WT = "/runs/r/review-worktree"

    def normalized(self, raw):
        return panel.normalize_findings(raw, self.LABELS, self.WT)

    def test_prefixes_and_the_worktree_path_normalize_to_the_label_and_overlap_is_accepted_at_two(self):
        a = self.normalized([finding("b/workflow/x.py", 10, "missing owner check", "P1")])
        b = self.normalized([finding(f"{self.WT}/workflow/x.py", 12, "owner is never checked", "high")])
        c = self.normalized([finding("./workflow/x.py", 40, "unrelated", "P2"), finding("a/docs/req.md", None, "req", "P2")])
        self.assertEqual([f["file"] for f in a + b + c], ["workflow/x.py", "workflow/x.py", "workflow/x.py", "docs/req.md"])
        self.assertFalse(any(f["unanchored"] for f in a + b + c))
        findings, ids = panel.overlap([("claude", a), ("openai-codex/gpt-6-sol", b), ("deepseek/x", c)], 2, 3)
        self.assertEqual([(f["id"], f["providers_raised"], f["accepted"], f["severity"], f["title"]) for f in findings],
                         [("f1", ["claude", "openai-codex/gpt-6-sol"], True, "P1", "missing owner check"),
                          ("f2", ["deepseek/x"], False, "P2", "unrelated"), ("f3", ["deepseek/x"], False, "P2", "req")])
        self.assertEqual(ids, {"claude": ["f1"], "openai-codex/gpt-6-sol": ["f1"], "deepseek/x": ["f2", "f3"]})
        self.assertEqual(findings[0]["line"], 10)  # The first-raising provider's line.

    def test_a_challenge_label_set_anchors_the_prd_and_an_unknown_file_is_unanchored_and_folded(self):
        labels = ["docs/PRD_X.md", "features/x/engine-task.md", "features/x/decisions.md", "operator-request"]
        raw = [finding("docs/PRD_X.md", None, "contradiction"), finding("operator-request", None, "scope"), finding("src/nothing.ts", 3, "ghost"),
               finding("", None, "no file")]
        found = panel.normalize_findings(raw, labels, None)
        # A finding with no file is unanchored and carries the `(no file)` placeholder, never an empty string the viewer's min-length rule would drop the whole panel over (P1).
        self.assertEqual([(f["file"], f["unanchored"]) for f in found], [("docs/PRD_X.md", False), ("operator-request", False), ("src/nothing.ts", True), ("(no file)", True)])
        self.assertTrue(all(f["file"] for f in found))
        findings, _ = panel.overlap([("claude", found), ("openai-codex/gpt-6-sol", [found[2]])], 1, 2)
        ghost = [f for f in findings if f["title"] == "ghost"]
        self.assertEqual([(f["unanchored"], f["accepted"], f["providers_raised"]) for f in ghost], [(True, False, ["claude"]), (True, False, ["openai-codex/gpt-6-sol"])])
        self.assertTrue(all(f["accepted"] for f in findings if not f["unanchored"]))  # Threshold 1: any anchored finding.

    def test_threshold_all_needs_every_configured_provider_and_a_file_line_suffix_is_read(self):
        a = self.normalized([finding("workflow/x.py:10", None, "owner check")])
        b = self.normalized([finding("workflow/x.py", 11, "owner check")])
        self.assertEqual((a[0]["file"], a[0]["line"]), ("workflow/x.py", 10))
        findings, _ = panel.overlap([("claude", a), ("openai-codex/gpt-6-sol", b)], "all", 2)
        self.assertEqual([(f["providers_raised"], f["accepted"]) for f in findings], [(["claude", "openai-codex/gpt-6-sol"], True)])
        findings, _ = panel.overlap([("claude", a), ("openai-codex/gpt-6-sol", b)], "all", 3)  # A third provider timed out: never all.
        self.assertEqual([f["accepted"] for f in findings], [False])
        findings, _ = panel.overlap([("claude", a), ("openai-codex/gpt-6-sol", [])], 1, 2)
        self.assertEqual([f["accepted"] for f in findings], [True])

    def test_same_provider_findings_never_merge_and_the_chain_merges_deterministically(self):
        same = self.normalized([finding("workflow/x.py", 10, "first bug"), finding("workflow/x.py", 13, "second bug")])
        findings, _ = panel.overlap([("claude", same)], 1, 1)
        self.assertEqual(len(findings), 2)  # Three lines apart, one provider: two findings (design-challenge note 6).
        a = self.normalized([finding("workflow/x.py", 10, "alpha")])
        b = self.normalized([finding("workflow/x.py", 14, "beta")])
        c = self.normalized([finding("workflow/x.py", 18, "gamma", "P0")])
        findings, _ = panel.overlap([("claude", a), ("openai-codex/gpt-6-sol", b), ("deepseek/x", c)], 2, 3)
        self.assertEqual([(f["providers_raised"], f["severity"], f["title"], f["accepted"]) for f in findings],
                         [(["claude", "openai-codex/gpt-6-sol", "deepseek/x"], "P0", "alpha", True)])  # A–B–C: one stable cluster.
        # Title Jaccard without lines; a different label never matches.
        a = self.normalized([finding("workflow/x.py", None, "missing owner authorization check")])
        b = self.normalized([finding("workflow/x.py", None, "owner authorization check missing")])
        d = self.normalized([finding("docs/req.md", None, "missing owner authorization check")])
        findings, _ = panel.overlap([("claude", a), ("openai-codex/gpt-6-sol", b + d)], 2, 2)
        self.assertEqual([(f["providers_raised"], f["accepted"]) for f in findings], [(["claude", "openai-codex/gpt-6-sol"], True), (["openai-codex/gpt-6-sol"], False)])

    def test_severity_map(self):
        self.assertEqual([panel.normalize_severity(v) for v in ("P0", "p1", "critical", "high", "medium", "low", "", None, "P9")],
                         ["P0", "P1", "P0", "P1", "P2", "P2", "P2", "P2", "P2"])


# ---- fake providers over a toy repository: the in-process review-step hooks (acceptance items 1, 3, 4, 5, 6) --------------

FAKE_CLAUDE = r'''#!/usr/bin/env python3
import json, os, sys, time
from pathlib import Path
CONTROL = Path(%(control)r)
argv = sys.argv[1:]
spec = (json.loads(CONTROL.read_text()) if CONTROL.exists() else {}).get("claude", {})
assert argv[argv.index("--tools") + 1] == "Read,Glob,Grep"
assert "--add-dir" not in argv
prompt = sys.stdin.read()
Path(%(seen)r).write_text(json.dumps({"argv": argv, "cwd": os.getcwd(), "prompt": prompt, "env": dict(os.environ)}))
if spec.get("hang"):
    time.sleep(3600)
time.sleep(spec.get("delay", 0))
if spec.get("not_json"):
    sys.stdout.write("this is not json\n")
    sys.exit(0)
result = {"session_id": argv[argv.index("--session-id") + 1], "is_error": bool(spec.get("is_error", False)), "subtype": "success",
          "total_cost_usd": spec.get("cost", 0.021), "structured_output": {"findings": spec.get("findings", [])}}
sys.stdout.write(json.dumps(result) + "\n")
sys.exit(int(spec.get("exit", 0)))
'''

FAKE_PI = r'''
import json, os, sys, time
from pathlib import Path
CONTROL = Path(%(control)r)
argv = sys.argv[1:]
spec = (json.loads(CONTROL.read_text()) if CONTROL.exists() else {}).get("pi", {})
Path(%(seen)r).write_text(json.dumps({"argv": argv, "cwd": os.getcwd(), "env": dict(os.environ), "context_exists": os.path.exists("context.txt"),
                                      "context_bytes": os.path.getsize("context.txt") if os.path.exists("context.txt") else None}))
if spec.get("hang"):
    time.sleep(3600)
time.sleep(spec.get("delay", 0))
echo = Path("context.txt").read_text() if os.path.exists("context.txt") else ""
def line(event):
    sys.stdout.write(json.dumps(event) + "\n")
line({"type": "session", "version": 3, "id": "fake"})
line({"type": "message_start", "message": {"role": "user", "content": [{"type": "text", "text": "<file name=\"context.txt\">\n" + echo + "\n</file>"}]}})
line({"type": "message_end", "message": {"role": "user", "content": [{"type": "text", "text": "<file name=\"context.txt\">\n" + echo + "\n</file>"}]}})
line({"type": "thinking_start"})
line({"type": "thinking", "text": "[{\"severity\":\"P0\",\"title\":\"decoy in a thinking event\"}]"})
line({"type": "thinking_end"})
reply = "this is not json" if spec.get("not_json") else json.dumps(spec.get("findings", []))
if spec.get("fenced"):
    reply = "```json\n" + reply + "\n```"
line({"type": "message_end", "message": {"role": "assistant", "content": [{"type": "thinking", "thinking": "hmm"}, {"type": "text", "text": reply}],
                                          "usage": {"input": 10, "output": 5, "cost": {"input": 0.004, "output": 0.0007, "total": spec.get("cost", 0.0047)}}}})
line({"type": "agent_end"})
sys.exit(int(spec.get("exit", 0)))
'''


def git(repo, *args):
    return subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True, text=True).stdout.strip()


class Harness(unittest.TestCase):
    """A toy repository with a base and a candidate commit, a run directory with its review worktree, a fake `claude` and a fake
    `pi` bin directory; no model call, no network."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.repo = self.tmp / "repo"
        (self.repo / "workflow").mkdir(parents=True)
        (self.repo / "docs").mkdir()
        git(self.repo, "init", "-q")
        git(self.repo, "config", "user.email", "t@t")
        git(self.repo, "config", "user.name", "t")
        (self.repo / "workflow" / "x.py").write_text("def withdraw(balance, amount, caller, owner):\n    if caller != owner:\n        raise PermissionError\n    return balance - amount\n")
        (self.repo / "docs" / "req.md").write_text("REQ-1: only the owner withdraws\n")
        (self.repo / "logo.bin").write_bytes(b"\x00\x01binary\x00")
        git(self.repo, "add", "-A")
        git(self.repo, "commit", "-qm", "base")
        self.base = git(self.repo, "rev-parse", "HEAD")
        (self.repo / "workflow" / "x.py").write_text("def withdraw(balance, amount, caller, owner):\n    # the owner check is gone\n    return balance - amount\n")
        (self.repo / "workflow" / "new.py").write_text("NEW = 1\n")
        (self.repo / "logo.bin").write_bytes(b"\x00\x02binary\x00")
        (self.repo / "docs" / "req.md").write_text("REQ-1: edited by the candidate (the pinned text is what the panel reads)\n")
        git(self.repo, "add", "-A")
        git(self.repo, "commit", "-qm", "candidate")
        self.candidate = git(self.repo, "rev-parse", "HEAD")
        self.run = self.tmp / "run"
        self.run.mkdir()
        git(self.repo, "worktree", "add", "--detach", str(self.run / "review-worktree"), self.candidate)
        save_json(self.run / "review-bundle.json", {"run_id": "panel-001", "candidate_commit": self.candidate})
        self.control = self.tmp / "control.json"
        self.control.write_text("{}")
        self.claude_seen = self.tmp / "claude-seen.json"
        self.pi_seen = self.tmp / "pi-seen.json"
        self.fake_claude = self.tmp / "fake-claude"
        self.fake_claude.write_text(FAKE_CLAUDE % {"control": str(self.control), "seen": str(self.claude_seen)})
        self.fake_claude.chmod(0o755)
        self.pi_bin = self.tmp / "pi-bin"
        self.pi_bin.mkdir()
        (self.pi_bin / "fake-pi.py").write_text(FAKE_PI % {"control": str(self.control), "seen": str(self.pi_seen)})
        (self.pi_bin / "pi").write_text(f"#!/bin/sh\nexec {sys.executable} -I {self.pi_bin / 'fake-pi.py'} \"$@\"\n")
        (self.pi_bin / "pi").chmod(0o755)
        self.registry = self.tmp / "registry.json"
        environment = mock.patch.dict(os.environ, {"MD_MANAGER_PROJECTS_CONFIG": str(self.registry)})
        environment.start()
        self.addCleanup(environment.stop)
        self.addCleanup(self.kill_leftovers)

    def kill_leftovers(self):
        """No fake provider outlives its test: every pid file's group under <run>/panel is killed (a hung fake a test never collected)."""
        import signal
        for pid_file in (self.run / "panel").glob("*/*.pid") if (self.run / "panel").exists() else []:
            try:
                os.killpg(read_json(pid_file)["pid"], signal.SIGKILL)
            except (OSError, ValueError, KeyError):
                pass

    def plan(self, **over) -> dict:
        item = plan_item(pi_bin=str(self.pi_bin), **over)
        plan = {"run_id": "panel-001", "repository": str(self.repo), "base_commit": self.base, "nodes": {}, "conventions": None,
                "panels": [item], "prd": None}
        save_json(self.run / "plan.json", plan)
        return plan

    def follow_up(self, plan: dict) -> str:
        """Make this run a follow-up: a followed candidate kept on no branch (the candidate's x.py, an older new.py, main's
        docs/elsewhere.md), plan.follows naming it, and a policy whose lanes own workflow/ and src/ only."""
        env = {**os.environ, "GIT_INDEX_FILE": str(self.tmp / "followed.index")}

        def run(*args, text=None):
            return subprocess.run(["git", "-C", str(self.repo), *args], check=True, capture_output=True, text=True, env=env, input=text).stdout.strip()
        run("read-tree", self.candidate)
        for name, content in (("workflow/new.py", "NEW = 0\n"), ("docs/elsewhere.md", "main moved\n"), ("docs/req.md", "REQ-1: only the owner withdraws\n")):
            run("update-index", "--add", "--cacheinfo", f"100644,{run('hash-object', '-w', '--stdin', text=content)},{name}")
        followed = run("commit-tree", run("write-tree"), "-p", self.base, "-m", "followed candidate")
        plan["follows"] = {"run_id": "panel-000", "verdict": "blocked", "candidate_commit": followed}
        save_json(self.run / "plan.json", plan)
        save_json(self.run / "policy.json", {"workers": [{"node_id": "ui", "owned_paths": ["workflow"]}, {"node_id": "adapter", "owned_paths": ["src"]}]})
        return followed

    def runtime(self, plan=None):
        return SimpleNamespace(directory=self.run, plan=plan or read_json(self.run / "plan.json"), sessions=SimpleNamespace(executable=str(self.fake_claude)))

    def set_control(self, **spec):
        self.control.write_text(json.dumps(spec))

    def decide(self):
        (self.run / "review.json").write_text(json.dumps({"verdict": "approved", "reviewers": []}))

    def record(self):
        record = read_json(self.run / "panel.json")
        validate_schema("panel", record)
        return record

    def attention_lines(self):
        feed = self.registry.parent / "attention.jsonl"
        return [json.loads(line) for line in feed.read_text().splitlines()] if feed.exists() else []


CLAUDE_FINDINGS = [{"severity": "P0", "file": "b/workflow/x.py", "line": 2, "title": "Missing owner check in withdraw", "detail": "anyone withdraws"},
                   {"severity": "P2", "file": "workflow/new.py", "line": 1, "title": "Unused constant", "detail": "NEW is never read"}]
PI_FINDINGS = [{"severity": "high", "file": "workflow/x.py", "line": 3, "title": "Owner check removed", "detail": "the owner comparison was deleted"},
               {"severity": "P2", "file": "src/elsewhere.ts", "line": 9, "title": "Ghost", "detail": "cites no label"}]


class ReviewStep(Harness):
    def test_two_providers_run_in_process_over_one_labelled_context_and_the_controller_writes_the_record(self):
        """Acceptance items 1 and 8: the context file, both bounded subprocesses, the record, costs, the pinned brief, no events."""
        self.set_control(claude={"findings": CLAUDE_FINDINGS, "cost": 0.021}, pi={"findings": PI_FINDINGS, "cost": 0.0047})
        plan = self.plan()
        runtime = self.runtime(plan)
        panel.ensure_started(runtime)
        running = self.record()["panels"][0]
        self.assertEqual((running["status"], [p["status"] for p in running["providers"]]), ("running", ["running", "running"]))  # Note 5: the running record.
        self.assertIsNotNone(running["started_at"])
        jobs = runtime.panel_jobs["review-panel"]
        self.assertEqual(len(jobs), 2)
        for job in jobs:
            self.assertIsNone(job.process.stdout)  # A file handle was given, never a PIPE.
            self.assertTrue(job.stdout.is_relative_to(self.run / "panel" / "review-panel"))
        context = (self.run / "panel" / "review-panel" / "context.txt").read_text()
        labels = panel.context_labels(context)
        self.assertEqual(labels, ["docs/req.md", "workflow/new.py", "workflow/x.py", "docs/req.md"])
        self.assertNotIn("logo.bin", context)  # Binary skipped.
        self.assertIn("--- full file at the candidate ---\ndef withdraw", context)
        self.assertEqual(context.count("--- full file at the candidate ---"), 2)  # The two files that existed at the base; ...
        self.assertIn("--- new file: the diff above is its whole text ---", context)  # ... a new file is not sent twice.
        self.assertIn("REQ-1: the pinned requirements text", context)  # The pinned text, not the candidate's edit.
        self.assertIn("edited by the candidate", context)  # The candidate's own edit of the file appears as a touched file.
        self.assertNotIn("userEmail", context)  # Never the operator identity or a credential.
        self.decide()
        panel.collect(runtime, None, sleep=lambda _: time.sleep(0.05))
        record = self.record()
        entry = record["panels"][0]
        self.assertEqual(entry["status"], "succeeded")
        self.assertEqual(entry["context_bytes"], len(context.encode()))
        self.assertIsNone(entry["delta_from"])  # Not a follow-up: the whole candidate against the base.
        self.assertEqual([(p["status"], p["cost_usd"], p["context_bytes"]) for p in entry["providers"]],
                         [("ok", 0.021, entry["context_bytes"]), ("ok", 0.0047, entry["context_bytes"])])
        self.assertEqual([(f["id"], f["file"], f["severity"], f["providers_raised"], f["accepted"], f["unanchored"]) for f in entry["findings"]],
                         [("f1", "workflow/x.py", "P0", ["claude", "openai-codex/gpt-6-sol"], True, False),
                          ("f2", "workflow/new.py", "P2", ["claude"], False, False),
                          ("f3", "src/elsewhere.ts", "P2", ["openai-codex/gpt-6-sol"], False, True)])
        self.assertEqual([p["finding_ids"] for p in entry["providers"]], [["f1", "f2"], ["f1", "f3"]])
        self.assertIsNotNone(entry["ended_at"])
        self.assertFalse((self.run / "events.jsonl").exists())  # No panel events this slice.
        # The claude job: the pinned brief then the context, cwd the review worktree, exactly one --effort, no run-dir --add-dir.
        seen = read_json(self.claude_seen)
        self.assertTrue(seen["prompt"].startswith(plan["panels"][0]["prompt"]["text"]))
        self.assertIn("=== workflow/x.py ===", seen["prompt"])
        self.assertEqual(Path(seen["cwd"]).resolve(), (self.run / "review-worktree").resolve())
        self.assertEqual(seen["argv"].count("--effort"), 1)
        self.assertEqual(seen["argv"][seen["argv"].index("--max-budget-usd") + 1], "5")
        # The pi job: the brief positional, @context.txt relative to the scratch cwd, env -i with PATH, no credential variable.
        seen = read_json(self.pi_seen)
        self.assertEqual(seen["argv"][-2:], [plan["panels"][0]["prompt"]["text"], "@context.txt"])
        # The pi scratch cwd is a neutral temp root outside the run/state tree, so the absolute path pi expands `@context.txt` to carries no user/feature/run/panel layout (P1).
        self.assertFalse(str(Path(seen["cwd"]).resolve()).startswith(str(self.run.resolve())))
        self.assertTrue(seen["context_exists"])
        self.assertEqual(seen["context_bytes"], entry["context_bytes"])
        self.assertEqual(set(seen["env"]) - {"PWD", "SHLVL", "_", "OLDPWD"}, {"PATH", "HOME", "LANG", "TMPDIR"})
        self.assertTrue(seen["env"]["PATH"].startswith(str(self.pi_bin)))
        self.assertTrue((self.run / "panel" / "review-panel" / "openai-codex-gpt-6-sol-1.stdout.jsonl").stat().st_size > 1000)  # The echoed context, in a file.
        self.assertTrue((self.run / "panel" / "review-panel" / "claude-1.stdout.json").exists())
        [line] = [item for item in self.attention_lines() if item["kind"] == "panel"]
        self.assertEqual(line["text"], f"Panel review-panel (report-only): 1 accepted finding(s) of 3 across 2 responding provider(s): read {self.run / 'panel.json'}")
        self.assertEqual(panel.status_lines(self.run, plan), ["panel review-panel: 1 accepted of 3"])
        self.assertEqual(panel.outcome_lines(self.run, plan), ["Panel review-panel (report-only): 3 finding(s), 1 accepted at threshold 2; "
                                                              "providers: claude ok, openai-codex/gpt-6-sol ok."])
        # A wholly terminal record is not rerun.
        again = self.runtime(plan)
        panel.ensure_started(again)
        self.assertEqual(again.panel_jobs, {})
        self.assertFalse((self.run / "panel" / "review-panel" / "claude-2.stdout.json").exists())
        panel.collect(again, None)
        self.assertEqual(self.record()["panels"][0]["status"], "succeeded")

    def test_a_follow_up_panel_reads_the_delta_since_the_followed_candidate_over_the_owned_paths(self):
        self.set_control(claude={"findings": []}, pi={"findings": []})
        plan = self.plan()
        followed = self.follow_up(plan)
        runtime = self.runtime(plan)
        panel.ensure_started(runtime)
        context = (self.run / "panel" / "review-panel" / "context.txt").read_text()
        # x.py is the same at both candidates; docs/req.md and docs/elsewhere.md differ but no lane owns docs/: only new.py.
        self.assertEqual(panel.context_labels(context), ["workflow/new.py", "docs/req.md"])
        self.assertIn("-NEW = 0\n+NEW = 1", context)
        self.assertIn("--- full file at the candidate ---\nNEW = 1", context)  # It existed at the followed candidate: its body.
        self.assertNotIn("owner check is gone", context)
        self.assertNotIn("elsewhere", context)
        self.assertEqual(self.record()["panels"][0]["delta_from"], followed)
        self.decide()
        panel.collect(runtime, None, sleep=lambda _: time.sleep(0.05))
        self.assertEqual(self.record()["panels"][0]["delta_from"], followed)

    def test_a_follow_up_whose_candidate_no_longer_resolves_reads_the_whole_candidate(self):
        self.set_control(claude={"findings": []}, pi={"findings": []})
        plan = self.plan()
        self.follow_up(plan)
        plan["follows"]["candidate_commit"] = "0" * 40
        save_json(self.run / "plan.json", plan)
        runtime = self.runtime(plan)
        panel.ensure_started(runtime)
        context = (self.run / "panel" / "review-panel" / "context.txt").read_text()
        self.assertEqual(panel.context_labels(context), ["docs/req.md", "workflow/new.py", "workflow/x.py", "docs/req.md"])
        self.assertIsNone(self.record()["panels"][0]["delta_from"])
        self.decide()
        panel.collect(runtime, None, sleep=lambda _: time.sleep(0.05))

    def test_a_context_over_the_cap_drops_full_bodies_first_then_cuts_diffs_and_never_the_requirements(self):
        """A 1 MB generated file rewritten line by line: about 3 MB of context. Every full body goes (largest first), then the
        largest diff is cut to fit; the pinned requirement text stays whole and context_truncated records it all."""
        lines = [f"line {index:06d} of the generated module, padded to fifty\n" for index in range(20000)]
        (self.repo / "big.txt").write_text("".join(lines))
        git(self.repo, "add", "-A")
        git(self.repo, "commit", "-qm", "base with a large file")
        base = git(self.repo, "rev-parse", "HEAD")
        (self.repo / "big.txt").write_text("".join(line.replace("line", "LINE") for line in lines))
        x_py = "def withdraw(balance, amount, caller, owner):\n    return balance - amount  # no owner check\n"
        (self.repo / "workflow" / "x.py").write_text(x_py)
        git(self.repo, "add", "-A")
        git(self.repo, "commit", "-qm", "candidate rewriting it")
        save_json(self.run / "review-bundle.json", {"run_id": "panel-001", "candidate_commit": git(self.repo, "rev-parse", "HEAD")})
        self.set_control(claude={"findings": []}, pi={"findings": []})
        plan = self.plan()
        plan["base_commit"] = base
        save_json(self.run / "plan.json", plan)
        runtime = self.runtime(plan)
        panel.ensure_started(runtime)
        data = (self.run / "panel" / "review-panel" / "context.txt").read_bytes()
        context = data.decode()
        self.assertLessEqual(len(data), panel.MAX_CONTEXT_BYTES)
        self.assertEqual(panel.context_labels(context), ["big.txt", "workflow/x.py", "docs/req.md"])  # The marker is no label.
        def has(text):  # assertIn would print three megabytes on a failure.
            return text in context
        self.assertFalse(has("--- full file at the candidate ---"))
        self.assertTrue(has("=== big.txt ===\n--- diff ---\n"))
        self.assertTrue(has(f"--- full file omitted: {len(''.join(lines).encode())} bytes, over the context cap ---"))
        self.assertTrue(has(f"--- full file omitted: {len(x_py.encode())} bytes, over the context cap ---"))  # x.py's body too: still over the cap.
        [(kept, total)] = re.findall(r"^=== truncated: kept (\d+) of (\d+) bytes ===$", context, re.M)
        big = context[context.index("=== big.txt ===\n") + len("=== big.txt ===\n"):context.index("=== truncated")]
        self.assertEqual(int(kept), len(big.encode()))
        self.assertTrue(big.endswith("\n") and int(total) > 2_000_000)
        self.assertTrue(big.startswith("--- diff ---\ndiff --git a/big.txt b/big.txt\n"))  # Kept from the start, cut at a line break.
        self.assertTrue(has("=== docs/req.md ===\nREQ-1: the pinned requirements text\n"))  # Requirements whole.
        self.assertTrue(has("+    return balance - amount  # no owner check"))  # The smaller diff is whole: the big one's cut was enough.
        entry = self.record()["panels"][0]
        self.assertEqual(entry["context_bytes"], len(data))
        truncated = entry["context_truncated"]
        self.assertEqual((truncated["omitted_bodies"], truncated["truncated"]), (["big.txt", "workflow/x.py"], ["big.txt"]))
        self.assertGreater(truncated["original_bytes"], 3_000_000)
        self.decide()
        panel.collect(runtime, None, sleep=lambda _: time.sleep(0.05))
        self.assertEqual(self.record()["panels"][0]["context_truncated"], truncated)
        again = self.runtime(plan)  # A resume reuses the file and keeps what the first assembly recorded.
        record = self.record()
        record["panels"][0]["status"] = "running"
        record["panels"][0]["providers"][0]["status"] = "running"
        save_json(self.run / "panel.json", record)
        panel.ensure_started(again)
        self.assertEqual(self.record()["panels"][0]["context_truncated"], truncated)
        panel.collect(again, None, sleep=lambda _: time.sleep(0.05))

    def test_a_context_under_the_cap_records_no_truncation(self):
        self.set_control(claude={"findings": []}, pi={"findings": []})
        runtime = self.runtime(self.plan())
        panel.ensure_started(runtime)
        self.assertIsNone(self.record()["panels"][0]["context_truncated"])
        self.decide()
        panel.collect(runtime, None, sleep=lambda _: time.sleep(0.05))

    def test_a_fenced_pi_reply_and_a_claude_model_entry(self):
        self.set_control(claude={"findings": []}, pi={"findings": PI_FINDINGS[:1], "fenced": True})
        plan = self.plan(providers=[{"transport": "claude", "model": "claude-sonnet-5-5", "effort": "low"}, {"transport": "pi", "model": "openai-codex/gpt-6-sol", "effort": None}])
        runtime = self.runtime(plan)
        panel.ensure_started(runtime)
        self.decide()
        panel.collect(runtime, None, sleep=lambda _: time.sleep(0.05))
        entry = self.record()["panels"][0]
        self.assertEqual([p["status"] for p in entry["providers"]], ["ok", "ok"])
        self.assertEqual([(f["providers_raised"], f["severity"]) for f in entry["findings"]], [(["openai-codex/gpt-6-sol"], "P1")])
        self.assertEqual(entry["providers"][0]["model"], "claude-sonnet-5-5")
        seen = read_json(self.claude_seen)
        self.assertEqual(seen["argv"][seen["argv"].index("--model") + 1], "claude-sonnet-5-5")

    def test_a_provider_past_its_own_timeout_is_terminated_and_timed_out_while_the_other_is_kept(self):
        """Acceptance items 3 and 4: the timeout bounds the collect from the provider's own launch; reap-first keeps an exited one."""
        self.set_control(claude={"findings": CLAUDE_FINDINGS}, pi={"hang": True})
        plan = self.plan(timeout_minutes=2)
        runtime = self.runtime(plan)
        clock = {"now": 1000.0}
        panel.ensure_started(runtime, clock=lambda: clock["now"])
        pi_job = [job for job in runtime.panel_jobs["review-panel"] if job.entry["transport"] == "pi"][0]
        for _ in range(100):  # The fake claude exits on its own; wait for it so the clock jump below exercises reap-first.
            if not [job for job in runtime.panel_jobs["review-panel"] if job.entry["transport"] == "claude"][0].running():
                break
            time.sleep(0.05)
        self.decide()
        sleeps = []

        def sleep(seconds):
            sleeps.append(seconds)
            clock["now"] += 60  # Each poll is a minute: past the 2-minute bound at the third poll.
        panel.collect(runtime, None, clock=lambda: clock["now"], sleep=sleep)
        entry = self.record()["panels"][0]
        self.assertEqual(entry["status"], "succeeded")  # One ok provider: succeeded, with its findings.
        self.assertEqual([p["status"] for p in entry["providers"]], ["ok", "timed_out"])
        self.assertIn("timed_out after 120 s", entry["providers"][1]["error"])
        self.assertIn("context bytes", entry["providers"][1]["error"])
        self.assertEqual([f["providers_raised"] for f in entry["findings"]], [["claude"], ["claude"]])
        self.assertIsNotNone(pi_job.process.returncode)  # Terminated, no orphan.
        self.assertLessEqual(len(sleeps), 4)
        self.assertEqual(panel.outcome_lines(self.run, plan)[0], "Panel review-panel (report-only): 2 finding(s), 0 accepted at threshold 2; "
                                                                "providers: claude ok, openai-codex/gpt-6-sol timed_out.")
        self.assertEqual([item for item in self.attention_lines() if item["kind"] == "panel"], [])  # Nothing accepted: no record.

    def test_an_exited_provider_keeps_its_findings_whatever_the_clock_says(self):
        """Acceptance item 4: a native review longer than timeout_minutes never fails a panel whose providers exited."""
        self.set_control(claude={"findings": CLAUDE_FINDINGS}, pi={"findings": PI_FINDINGS})
        plan = self.plan(timeout_minutes=1)
        runtime = self.runtime(plan)
        panel.ensure_started(runtime, clock=lambda: 0.0)
        for job in runtime.panel_jobs["review-panel"]:
            job.process.wait(timeout=30)
        self.decide()
        panel.collect(runtime, None, clock=lambda: 10 ** 6, sleep=lambda _: self.fail("nothing to wait for"))
        entry = self.record()["panels"][0]
        self.assertEqual((entry["status"], [p["status"] for p in entry["providers"]]), ("succeeded", ["ok", "ok"]))
        self.assertEqual(len(entry["findings"]), 3)

    def collect_hung_pi(self, timeout_minutes: int, decided_at: float, start: float = 1000.0, collect_at: float | None = None) -> tuple[dict, list]:
        """The claude provider exits on its own, the pi one hangs; both launch at `start` on the fake clock, the verdict's time
        is `decided_at` (the review.json mtime) and the collect begins at `collect_at` (default: `start`); each poll is a
        minute. The record's pi provider and the sleeps the collect took."""
        self.set_control(claude={"findings": CLAUDE_FINDINGS}, pi={"hang": True})
        plan = self.plan(timeout_minutes=timeout_minutes)
        runtime = self.runtime(plan)
        clock = {"now": start}
        panel.ensure_started(runtime, clock=lambda: clock["now"])
        claude = [job for job in runtime.panel_jobs["review-panel"] if job.entry["transport"] == "claude"][0]
        claude.process.wait(timeout=30)
        self.decide()
        os.utime(self.run / "review.json", (decided_at, decided_at))
        clock["now"] = start if collect_at is None else collect_at
        sleeps = []

        def sleep(seconds):
            sleeps.append(clock["now"])
            clock["now"] += 60
        panel.collect(runtime, None, clock=lambda: clock["now"], sleep=sleep)
        entry = self.record()["panels"][0]
        self.assertEqual([p["status"] for p in entry["providers"]], ["ok", "timed_out"])
        self.assertEqual(entry["status"], "succeeded")
        return entry["providers"][1], sleeps

    def test_a_provider_still_running_ten_minutes_after_the_verdict_is_terminated(self):
        """A 30-minute provider no longer holds the review step: 600 s after the verdict it is timed_out, its own bound unused."""
        provider, sleeps = self.collect_hung_pi(timeout_minutes=30, decided_at=1000.0)
        self.assertEqual(provider["error"], f"timed_out after the review verdict: {panel.PANEL_GRACE_AFTER_VERDICT_SECONDS} s grace")
        self.assertEqual(panel.PANEL_GRACE_AFTER_VERDICT_SECONDS, 600)
        self.assertEqual(len(sleeps), 10)  # Ten one-minute polls from the verdict, then terminated at 1600.

    def test_the_providers_own_timeout_still_applies_when_it_ends_before_the_grace(self):
        provider, sleeps = self.collect_hung_pi(timeout_minutes=2, decided_at=1000.0)
        self.assertIn("timed_out after 120 s (", provider["error"])
        self.assertEqual(len(sleeps), 2)

    def test_a_verdict_older_than_the_grace_ends_the_wait_at_once(self):
        """The attack wait (before the collect) may have used the grace already: the first pass terminates the provider."""
        provider, sleeps = self.collect_hung_pi(timeout_minutes=30, decided_at=1050.0, start=1000.0, collect_at=1700.0)
        self.assertEqual(provider["error"], "timed_out after the review verdict: 600 s grace")
        self.assertEqual(sleeps, [])

    def test_a_provider_relaunched_after_the_verdict_gets_a_fresh_grace(self):
        """A resume of a decided review relaunches the non-terminal providers long after the verdict: their grace counts from
        their own launch, so they are not killed at once."""
        provider, sleeps = self.collect_hung_pi(timeout_minutes=30, decided_at=1000.0, start=5000.0)
        self.assertEqual(provider["error"], "timed_out after the review verdict: 600 s grace")
        self.assertEqual(len(sleeps), 10)  # 5000 + 600, not at once.

    def test_the_grace_counts_from_the_decided_at_the_controller_saved(self):
        """automatic-review.json's decided_at (review.json's key set is closed), not the file's mtime."""
        self.set_control(claude={"findings": []}, pi={"hang": True})
        runtime = self.runtime(self.plan(timeout_minutes=30))
        clock = {"now": 1000.0}
        panel.ensure_started(runtime, clock=lambda: clock["now"])
        self.decide()
        os.utime(self.run / "review.json", (1000.0, 1000.0))
        save_json(self.run / "automatic-review.json", {"status": "succeeded", "decided_at": panel.iso(1300.0)})
        sleeps = []

        def sleep(_):
            sleeps.append(clock["now"])
            clock["now"] += 60
        panel.collect(runtime, None, clock=lambda: clock["now"], sleep=sleep)
        self.assertEqual(len(sleeps), 15)  # 1300 + 600: fifteen one-minute polls from 1000.
        self.assertEqual(self.record()["panels"][0]["providers"][1]["error"], "timed_out after the review verdict: 600 s grace")

    def test_a_non_json_reply_is_parse_failed_with_its_raw_text_and_every_provider_timing_out_is_timed_out(self):
        self.set_control(claude={"not_json": True}, pi={"not_json": True})
        plan = self.plan()
        runtime = self.runtime(plan)
        panel.ensure_started(runtime)
        self.decide()
        panel.collect(runtime, None, sleep=lambda _: time.sleep(0.05))
        entry = self.record()["panels"][0]
        self.assertEqual([p["status"] for p in entry["providers"]], ["error", "parse_failed"])  # claude wrote no JSON result; pi replied prose.
        self.assertIn("this is not json", entry["providers"][1]["error"])
        self.assertEqual(entry["providers"][1]["cost_usd"], 0.0047)  # The cost is still read from the stream.
        self.assertEqual(entry["status"], "failed")
        self.assertIn("no provider returned findings", entry["error"])
        self.assertEqual(entry["findings"], [])
        # Both hanging: every provider timed out → the panel is timed_out.
        shutil.rmtree(self.run / "panel")
        (self.run / "panel.json").unlink()
        self.set_control(claude={"hang": True}, pi={"hang": True})
        runtime = self.runtime(plan)
        clock = {"now": 0.0}
        panel.ensure_started(runtime, clock=lambda: clock["now"])

        def sleep(_):
            clock["now"] += 10 ** 4
        panel.collect(runtime, None, clock=lambda: clock["now"], sleep=sleep)
        entry = self.record()["panels"][0]
        self.assertEqual((entry["status"], [p["status"] for p in entry["providers"]], entry["error"]), ("timed_out", ["timed_out", "timed_out"], "every provider timed out"))

    def test_a_panel_whose_every_provider_fails_to_launch_is_finalized_failed_not_left_running(self):
        """P1: a single-provider panel whose pinned pi_bin is missing at review time records `failed` from ensure_started itself
        (no job ever reaches collect), never a perpetual `running` the operator never learns ended."""
        plan = self.plan(providers=[{"transport": "pi", "model": "openai-codex/gpt-6-sol", "effort": None}])
        plan["panels"][0]["pi_bin"] = str(self.tmp / "no-such-bin")  # Missing at review time: Popen raises, the only provider cannot launch.
        runtime = self.runtime(plan)
        panel.ensure_started(runtime)
        self.assertEqual(runtime.panel_jobs.get("review-panel", []), [])  # Nothing launched.
        entry = self.record()["panels"][0]
        self.assertEqual((entry["status"], [p["status"] for p in entry["providers"]]), ("failed", ["error"]))
        self.assertIn("no provider returned findings", entry["error"])
        self.assertIsNotNone(entry["ended_at"])
        self.assertEqual(entry["findings"], [])

    def test_a_generic_non_decided_exit_records_a_terminal_failed_record_never_a_perpetual_running(self):
        """Acceptance item 4: a failed reviewer launch (no review.json, not an interrupt) terminates the jobs and records failed."""
        self.set_control(claude={"findings": CLAUDE_FINDINGS}, pi={"hang": True})
        plan = self.plan()
        runtime = self.runtime(plan)
        panel.ensure_started(runtime)
        claude_job = [job for job in runtime.panel_jobs["review-panel"] if job.entry["transport"] == "claude"][0]
        claude_job.process.wait(timeout=30)
        panel.collect(runtime, RuntimeError("Reviewer general needs reconciliation; no automatic relaunch"), sleep=lambda _: self.fail("no wait on a non-decided exit"))
        entry = self.record()["panels"][0]
        self.assertEqual(entry["status"], "failed")
        self.assertEqual(entry["error"], "review exited with no review.json (RuntimeError)")
        self.assertEqual([p["status"] for p in entry["providers"]], ["ok", "error"])  # Exited first: reaped; still running: terminated.
        self.assertIn("terminated: review exited with no review.json", entry["providers"][1]["error"])
        self.assertEqual(len(entry["findings"]), 2)  # The exited provider's findings stand.
        self.assertIsNotNone(entry["ended_at"])
        self.assertIsNone(runtime.panel_jobs)
        # Nothing runs: every provider process exited (the hung pi was terminated with its group).
        pi_stdout = self.run / "panel" / "review-panel" / "openai-codex-gpt-6-sol-1.pid"
        pid = read_json(pi_stdout)["pid"]
        self.assertFalse(Path(f"/proc/{pid}").exists())

    def test_an_interrupt_forwarded_from_the_attack_close_collects_without_waiting_and_resume_reruns_only_the_non_terminal_provider(self):
        """Acceptance item 5: KeyboardInterrupt as the exit error → terminate, non-terminal record, no wait; resume reruns only
        the non-terminal provider, bounded from its own start, into a new numbered file; the terminal one keeps its cost."""
        self.set_control(claude={"findings": CLAUDE_FINDINGS, "cost": 0.021}, pi={"hang": True})
        plan = self.plan()
        runtime = self.runtime(plan)
        panel.ensure_started(runtime, clock=lambda: 50.0)
        jobs = runtime.panel_jobs["review-panel"]
        claude_job = [job for job in jobs if job.entry["transport"] == "claude"][0]
        pi_job = [job for job in jobs if job.entry["transport"] == "pi"][0]
        claude_job.process.wait(timeout=30)
        self.decide()
        panel.collect(runtime, KeyboardInterrupt(), clock=lambda: 60.0, sleep=lambda _: self.fail("an interrupt never waits"))
        self.assertIsNotNone(pi_job.process.returncode)  # Terminated with its group: no orphan.
        entry = self.record()["panels"][0]
        self.assertEqual((entry["status"], [p["status"] for p in entry["providers"]]), ("running", ["ok", "running"]))  # Non-terminal.
        self.assertEqual(entry["providers"][0]["cost_usd"], 0.021)
        self.assertIsNone(entry["ended_at"])
        started_at = entry["started_at"]
        # Resume: a new controller process reruns only the pi provider, from its own start, into `-2`.
        self.set_control(claude={"findings": [{"severity": "P2", "file": "workflow/x.py", "line": 1, "title": "DOUBLE BILL", "detail": "must not run"}]},
                         pi={"findings": PI_FINDINGS, "cost": 0.005})
        self.claude_seen.unlink()
        resumed = self.runtime(plan)
        clock = {"now": 5000.0}
        panel.ensure_started(resumed, clock=lambda: clock["now"])
        rerun = resumed.panel_jobs["review-panel"]
        self.assertEqual([job.entry["transport"] for job in rerun], ["pi"])
        self.assertEqual((rerun[0].number, rerun[0].launched), (2, 5000.0))  # Bounded from the rerun's own start.
        self.assertTrue(rerun[0].stdout.name.endswith("openai-codex-gpt-6-sol-2.stdout.jsonl"))
        self.assertFalse(self.claude_seen.exists())  # The terminal provider was not rerun: no double bill.
        self.assertEqual(self.record()["panels"][0]["started_at"], started_at)  # The original started_at is kept.
        panel.collect(resumed, None, clock=lambda: clock["now"], sleep=lambda _: time.sleep(0.05))
        entry = self.record()["panels"][0]
        self.assertEqual((entry["status"], [p["status"] for p in entry["providers"]], entry["started_at"]), ("succeeded", ["ok", "ok"], started_at))
        self.assertEqual([p["cost_usd"] for p in entry["providers"]], [0.021, 0.005])
        self.assertEqual([(f["providers_raised"], f["accepted"]) for f in entry["findings"]],
                         [(["claude", "openai-codex/gpt-6-sol"], True), (["claude"], False), (["openai-codex/gpt-6-sol"], False)])  # Re-merged with the kept findings.

    def test_a_running_record_whose_providers_all_exited_is_finalized_on_resume_without_a_rerun(self):
        """An interrupt (or crash) after every provider exited but before the terminal save: resume owes no provider, so the
        record is finalized from the side files, never left `running` forever."""
        self.set_control(claude={"findings": CLAUDE_FINDINGS, "cost": 0.021}, pi={"findings": PI_FINDINGS, "cost": 0.0047})
        plan = self.plan()
        runtime = self.runtime(plan)
        panel.ensure_started(runtime)
        for job in runtime.panel_jobs["review-panel"]:
            job.process.wait(timeout=30)
        self.decide()
        panel.collect(runtime, KeyboardInterrupt(), sleep=lambda _: self.fail("no wait"))  # Both reaped `ok`, the panel still running.
        entry = self.record()["panels"][0]
        self.assertEqual((entry["status"], [p["status"] for p in entry["providers"]], entry["findings"]), ("running", ["ok", "ok"], []))
        self.claude_seen.unlink()
        self.pi_seen.unlink()
        resumed = self.runtime(plan)
        panel.ensure_started(resumed)
        self.assertEqual(resumed.panel_jobs, {})  # Nothing rerun.
        self.assertFalse(self.claude_seen.exists() or self.pi_seen.exists())
        entry = self.record()["panels"][0]
        self.assertEqual((entry["status"], len(entry["findings"]), entry["findings"][0]["accepted"]), ("succeeded", 3, True))
        self.assertIsNotNone(entry["ended_at"])
        self.assertEqual([p["cost_usd"] for p in entry["providers"]], [0.021, 0.0047])
        panel.collect(resumed, None, sleep=lambda _: self.fail("no wait"))
        self.assertEqual(self.record()["panels"][0]["status"], "succeeded")

    def test_a_ctrl_c_inside_the_wait_terminates_the_jobs_leaves_the_record_non_terminal_and_propagates(self):
        """Design-challenge note 5: a fresh KeyboardInterrupt in collect's own wait loop."""
        self.set_control(claude={"hang": True}, pi={"hang": True})
        plan = self.plan()
        runtime = self.runtime(plan)
        panel.ensure_started(runtime, clock=lambda: 0.0)
        jobs = list(runtime.panel_jobs["review-panel"])
        self.decide()

        def interrupt(_):
            raise KeyboardInterrupt
        with self.assertRaises(KeyboardInterrupt):
            panel.collect(runtime, None, clock=lambda: 1.0, sleep=interrupt)
        for job in jobs:
            self.assertIsNotNone(job.process.returncode)
        entry = self.record()["panels"][0]
        self.assertEqual((entry["status"], [p["status"] for p in entry["providers"]]), ("running", ["running", "running"]))
        # A TransientInfraError as the exit error behaves like the interrupt (the attack split).
        from .sessions import TransientInfraError
        again = self.runtime(plan)
        panel.ensure_started(again, clock=lambda: 0.0)
        panel.collect(again, TransientInfraError("claude is updating"), clock=lambda: 1.0, sleep=lambda _: self.fail("no wait"))
        self.assertEqual(self.record()["panels"][0]["status"], "running")

    def test_an_orphan_from_a_crashed_controller_is_terminated_before_its_rerun(self):
        """Design-challenge note 1: the rerun kills a live pid whose /proc cmdline carries the provider's marker and cwd."""
        self.set_control(claude={"findings": CLAUDE_FINDINGS}, pi={"hang": True})
        plan = self.plan()
        runtime = self.runtime(plan)
        panel.ensure_started(runtime, clock=lambda: 0.0)
        pi_job = [job for job in runtime.panel_jobs["review-panel"] if job.entry["transport"] == "pi"][0]
        orphan = pi_job.process.pid
        self.assertTrue(Path(f"/proc/{orphan}").exists())
        # The controller "crashes": the record stays running and nothing collects. A new controller reruns the pi provider.
        self.set_control(claude={"findings": CLAUDE_FINDINGS}, pi={"findings": PI_FINDINGS})
        resumed = self.runtime(plan)
        panel.ensure_started(resumed)
        self.assertTrue(panel._gone(orphan))  # Killed (a zombie until the old Popen reaps it, which counts as gone).
        self.assertEqual(len([job for job in resumed.panel_jobs["review-panel"] if job.entry["transport"] == "pi"]), 1)  # Exactly one new pi job.
        pi_job.process.wait(timeout=5)  # Reap the fake's zombie (the old runtime is the parent).
        self.decide()
        panel.collect(resumed, None, sleep=lambda _: time.sleep(0.05))
        self.assertEqual(self.record()["panels"][0]["status"], "succeeded")

    def test_a_context_assembly_failure_records_the_panel_failed_and_never_raises(self):
        self.plan()
        shutil.rmtree(self.run / "review-worktree")
        runtime = self.runtime()
        panel.ensure_started(runtime)
        entry = self.record()["panels"][0]
        self.assertEqual(entry["status"], "failed")
        self.assertTrue(entry["error"].startswith("context assembly failed"))
        self.assertEqual([p["status"] for p in entry["providers"]], ["error", "error"])
        self.assertEqual(runtime.panel_jobs, {})
        self.decide()
        panel.collect(runtime, None)
        self.assertEqual(self.record()["panels"][0]["status"], "failed")

    def test_a_plan_without_panels_touches_nothing(self):
        plan = self.plan()
        del plan["panels"]
        runtime = self.runtime(plan)
        panel.ensure_started(runtime)
        self.decide()
        panel.collect(runtime, RuntimeError("x"))
        self.assertFalse((self.run / "panel.json").exists())
        self.assertFalse((self.run / "panel").exists())
        self.assertEqual(panel.status_lines(self.run, plan), [])
        self.assertEqual(panel.outcome_lines(self.run, plan), [])
        self.assertIsNone(panel.export_section(self.run, plan))

    def test_collect_without_a_start_leaves_the_record_alone(self):
        """The reconciliation raise: nothing was started by this process, so the record (non-terminal or absent) is left for resume."""
        plan = self.plan()
        runtime = self.runtime(plan)
        panel.collect(runtime, RuntimeError("Prior reviewer invocation needs reconciliation"))
        self.assertFalse((self.run / "panel.json").exists())


# ---- the review step end to end: the graph over the offline pipeline (acceptance items 1, 5, 6) ---------------------------

from .test_automatic import GraphFixture  # noqa: E402
from . import test_pipeline as fixtures  # noqa: E402


class GraphRun(GraphFixture):
    """A native-transport automatic run (the default) with a review panel: the provider jobs start at the attack `ensure_started`
    point and are collected in review_candidate's finally; definition() and the costs export are byte-identical to a run without."""

    transport = "native"

    def setUp(self):
        super().setUp()
        f = self.fixture
        self.scratch = f.root / "panel-fakes"
        self.scratch.mkdir()
        self.control = self.scratch / "control.json"
        # The offline pipeline's candidate touches ui.txt and backend.py: both providers raise the same ui.txt finding (one cites b/ui.txt).
        self.control.write_text(json.dumps({
            "claude": {"findings": [{"severity": "P1", "file": "b/ui.txt", "line": 1, "title": "Content changed without a test", "detail": "ui.txt changed"}], "cost": 0.021},
            "pi": {"findings": [{"severity": "high", "file": "ui.txt", "line": 1, "title": "ui content change lacks a test", "detail": "no test covers it"}], "cost": 0.0047}}))
        self.claude_seen = self.scratch / "claude-seen.json"
        self.pi_seen = self.scratch / "pi-seen.json"
        fake_claude = self.scratch / "fake-claude"
        fake_claude.write_text(FAKE_CLAUDE % {"control": str(self.control), "seen": str(self.claude_seen)})
        fake_claude.chmod(0o755)
        pi_bin = self.scratch / "pi-bin"
        pi_bin.mkdir()
        (pi_bin / "fake-pi.py").write_text(FAKE_PI % {"control": str(self.control), "seen": str(self.pi_seen)})
        (pi_bin / "pi").write_text(f"#!/bin/sh\nexec {sys.executable} -I {pi_bin / 'fake-pi.py'} \"$@\"\n")
        (pi_bin / "pi").chmod(0o755)
        f.plan["panels"] = [plan_item(pi_bin=str(pi_bin), requirements=[], requirement_docs={})]
        f.plan["feature_version"] = "2.6.0"
        save_json(f.directory / "plan.json", f.plan)
        self.fake_claude = fake_claude
        # The runtime re-reads the pinned plan (as the resumed controller of the other graph tests does); the native review never
        # runs `claude --print`, so the sessions' executable is the panel's claude provider here.
        f.sessions = fixtures.FakeSessions(f.directory, f.plan)
        f.sessions.reviewer_verdict_file = self.verdict
        f.sessions.executable = str(fake_claude)
        f.runtime = fixtures.OfflinePipeline(f.directory, f.sessions)
        f.runtime.sessions = f.sessions

    def test_a_native_run_writes_a_terminal_record_inside_the_review_step_with_no_events_and_an_identical_definition(self):
        from .automatic import drive
        from .export_state import definition, graph_nodes
        f = self.fixture
        with mock.patch("workflow.automatic.wait_handoffs"):
            commit = drive(f.runtime)
        self.assertEqual(git(f.repo, "rev-parse", "HEAD"), commit)  # The run integrated exactly as without a panel.
        record = read_json(f.directory / "panel.json")
        validate_schema("panel", record)
        entry = record["panels"][0]
        self.assertEqual((entry["status"], [p["status"] for p in entry["providers"]]), ("succeeded", ["ok", "ok"]))
        self.assertEqual([p["cost_usd"] for p in entry["providers"]], [0.021, 0.0047])
        self.assertEqual([(f["file"], f["severity"], f["providers_raised"], f["accepted"]) for f in entry["findings"]],
                         [("ui.txt", "P1", ["claude", "openai-codex/gpt-6-sol"], True)])
        self.assertEqual(panel.context_labels((f.directory / "panel" / "review-panel" / "context.txt").read_text())[:2], ["backend.py", "ui.txt"])
        self.assertEqual([event for event in self.events() if str(event.get("node", "")).startswith("panel")], [])
        exported = read_json(f.directory / "run-state.json")
        self.assertEqual(exported["version"], "1.12.0")
        self.assertEqual(exported["panels"], record)
        self.assertEqual(exported["definition"]["nodes"], graph_nodes(["ui", "adapter"]))
        self.assertEqual(exported["definition"], definition(["ui", "adapter"], None))
        self.assertEqual(set(exported["costs"]["by_role"]), {"workers", "reviewers", "sidecar", "challenge", "attack"})
        self.assertNotIn("panel", json.dumps(exported["costs"]))
        self.assertIn(("panel", None, f"Panel review-panel (report-only): 1 accepted finding(s) of 1 across 2 responding provider(s): read {f.directory / 'panel.json'}"),
                      self.attention_lines())
        seen = read_json(self.pi_seen)
        self.assertEqual(set(seen["env"]) - {"PWD", "SHLVL", "_", "OLDPWD"}, {"PATH", "HOME", "LANG", "TMPDIR"})
        from .outcome import outcome_block
        self.assertIn("Panel review-panel (report-only): 1 finding(s), 1 accepted at threshold 2; providers: claude ok, openai-codex/gpt-6-sol ok.", outcome_block(f.directory))
        from .pipeline import run_status
        self.assertEqual(run_status(f.directory)[0]["panels"], ["panel review-panel: 1 accepted of 1"])

    def test_a_blocked_review_still_writes_a_terminal_record(self):
        from .automatic import drive
        f = self.fixture
        self.verdict.write_text("blocked")
        with mock.patch("workflow.automatic.wait_handoffs"), self.assertRaisesRegex(RuntimeError, "Non-retryable"):
            drive(f.runtime)
        self.assertEqual(self.combined()["status"], "blocked")
        record = read_json(f.directory / "panel.json")
        validate_schema("panel", record)
        self.assertEqual(record["panels"][0]["status"], "succeeded")
        self.assertIsNotNone(record["panels"][0]["ended_at"])
        self.assertEqual([event for event in self.events() if str(event.get("node", "")).startswith("panel")], [])


# ---- the judged panel (feature.json 2.11.0; features/review-panel-registry, seats task Acceptance 4-9) ---------------------

REGISTRY_FEATURE = ROOT / "features" / "review-panel-registry"
REGISTRY_EXAMPLES = REGISTRY_FEATURE / "examples"
# review.md as it is today: the report-only panels' brief stays byte-identical (design-challenge note 1; operator answer: option A).
REVIEW_BRIEF_SHA256 = "d69daeefffd43cbb143392cac1bfed33fd657dbdfaad9f44c43a89362a407128"


def registry_example(name: str) -> dict:
    return json.loads((REGISTRY_EXAMPLES / f"{name}.example.json").read_text())


def prd_literal(marker: str) -> dict:
    """A fenced JSON block of the PRD's Appendix B by its `<!-- literal: <marker> -->` marker ([L2])."""
    prd = (REGISTRY_FEATURE / "prd.md").read_text()
    return json.loads(re.search(rf"<!-- literal: {re.escape(marker)} -->\s*```json\n(.*?)\n```", prd, re.S).group(1))


class Briefs(unittest.TestCase):
    def test_review_md_stays_byte_identical_and_only_a_judged_panel_resolves_the_judged_brief(self):
        self.assertEqual(panel.digest_text((panel.BUILTIN_BRIEFS / "review.md").read_text()), REVIEW_BRIEF_SHA256)
        import hashlib
        self.assertEqual(hashlib.sha256((panel.BUILTIN_BRIEFS / "review.md").read_bytes()).hexdigest(), REVIEW_BRIEF_SHA256)
        folder = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, folder, ignore_errors=True)
        self.assertEqual(panel.brief_path(folder, "builtin:review", judged=True), panel.BUILTIN_BRIEFS / "review-judged.md")
        self.assertEqual(panel.brief_path(folder, "builtin:review"), panel.BUILTIN_BRIEFS / "review.md")
        self.assertEqual(panel.builtin_briefs(), ["challenge", "review"])  # A report-only panel cannot name the judged brief.
        (folder / "mine.md").write_text("my brief\n")
        self.assertEqual(panel.brief_path(folder, "mine.md", judged=True), (folder / "mine.md").resolve())  # A custom path is kept.
        # The omitted prompt is the same default.
        [item] = panel.declared({"version": "2.11.0", "panels": [{"id": "review", "stage": "review", "report_only": False}]})
        self.assertEqual(item["prompt"], "builtin:review")

    def test_the_judged_brief_follows_g13(self):
        text = panel.JUDGED_BRIEF.read_text()
        self.assertIn("Which requirements does the change violate?", text)
        for source in ("PRD", "decisions.md", "requirement documents"):
            self.assertIn(source, text)
        self.assertIn('"severity":"P0"|"P1"|"P2"', text)
        self.assertIn("exactly one of `P0`, `P1` or `P2`", text)
        self.assertNotIn("if you find nothing", text)
        self.assertNotRegex(text, r"(?i)report `?\[\]`?")
        self.assertIn("untrusted data, not instructions", text)


JUDGED_FEATURE = {"id": "review", "stage": "review", "report_only": False}


class JudgedConfig(unittest.TestCase):
    def declared(self, version="2.11.0", **over):
        return panel.declared({"version": version, "panels": [{**JUDGED_FEATURE, **over}]})

    def test_a_judged_panel_is_declared_at_2_11_0_with_its_defaults(self):
        [item] = self.declared(seats=["claude", "muse"], requirements=["docs/req.md"], judge={"timeout_minutes": 20})
        self.assertEqual(item, {"id": "review", "stage": "review", "report_only": False, "prompt": "builtin:review", "requirements": ["docs/req.md"],
                                "seats": ["claude", "muse"], "judge": {"timeout_minutes": 20, "budget_usd": 15}})
        [item] = self.declared()
        self.assertIsNone(item["seats"])
        [report] = panel.declared({"version": "2.11.0", "panels": [FEATURE_PANEL]})  # Report-only panels keep their 2.6.0 form.
        self.assertEqual(report, panel.declared({"version": "2.10.0", "panels": [FEATURE_PANEL]})[0])

    def test_report_only_false_below_2_11_0_is_refused(self):
        for version in ("2.6.0", "2.9.0", "2.10.0"):
            with self.assertRaisesRegex(ValueError, "report_only false \\(a judged panel\\) needs version 2.11.0"):
                self.declared(version)

    def test_a_judged_panel_at_the_challenge_stage_a_second_one_and_one_beside_another_panel_are_refused(self):
        with self.assertRaisesRegex(ValueError, "stage challenge: a judged panel runs at the review stage only"):
            self.declared(stage="challenge")
        with self.assertRaisesRegex(ValueError, "second judged panel"):
            panel.declared({"version": "2.11.0", "panels": [JUDGED_FEATURE, {**JUDGED_FEATURE, "id": "again"}]})
        for others in ([FEATURE_PANEL, JUDGED_FEATURE], [JUDGED_FEATURE, FEATURE_PANEL]):
            with self.assertRaisesRegex(ValueError, "judged panel beside another panel.*\\[L5\\]"):
                panel.declared({"version": "2.11.0", "panels": others})

    def test_a_judged_panel_with_providers_overlap_or_a_panel_budget_is_refused(self):
        for key, value in (("providers", [{"transport": "claude"}]), ("overlap_threshold", 2), ("budget_usd", 5), ("timeout_minutes", 15)):
            with self.assertRaisesRegex(ValueError, f"{key} is not a judged-panel setting"):
                self.declared(**{key: value})

    def test_a_feature_cannot_inline_a_seat_a_list_digest_or_the_judge_model(self):
        """Design-challenge note 5: resolved seat objects, `reviewers_file` and `judge.model` ride only in --panel-settings and the plan."""
        seat = prd_literal("plan-panel-judged")["seats"][2]
        with self.assertRaisesRegex(ValueError, "seats must be 1 to 16 distinct reviewer names.*never inline"):
            self.declared(seats=[seat])
        with self.assertRaisesRegex(ValueError, "reviewers_file is not a judged-panel setting"):
            self.declared(reviewers_file={"label": "x", "sha256": "0" * 64})
        with self.assertRaisesRegex(ValueError, "judge.model is not a judge setting"):
            self.declared(judge={"model": "claude-opus-5-5"})
        for bad in ([], ["a"] * 2, ["Bad"], [f"s{i}" for i in range(17)]):
            with self.assertRaisesRegex(ValueError, "seats must be"):
                self.declared(seats=bad)
        for judge, pattern in (({"timeout_minutes": 4}, "from 5 to 60"), ({"budget_usd": 51}, "from 1 to 50"), ({"effort": "low"}, "not a judge setting")):
            with self.assertRaisesRegex(ValueError, pattern):
                self.declared(judge=judge)

    def test_validate_plan_accepts_the_plan_panel_judged_literal_and_refuses_it_beside_another_panel(self):
        literal = prd_literal("plan-panel-judged")
        panel.validate_plan({"panels": [literal]})
        self.assertEqual([seat["name"] for seat in literal["seats"]], ["claude", "gpt", "muse", "argon"])
        self.assertEqual(panel.judged_item({"panels": [literal]}), literal)
        report = {**plan_item(), "id": "other"}
        with self.assertRaisesRegex(ValueError, "beside another panel"):
            panel.validate_plan({"panels": [literal, report]})
        for mutate, pattern in ((lambda item: item.pop("reviewers_file"), "a judged panel expects"),
                                (lambda item: item["judge"].update(model=None), "judge.model must be"),
                                (lambda item: item["seats"][2]["cli"]["argv"].append("{prompt}"), "placeholder"),
                                (lambda item: item["seats"][0].update(bin=None), "needs its resolved absolute bin"),
                                (lambda item: item["seats"][1].update(prefix="C"), "repeat a prefix")):
            item = json.loads(json.dumps(literal))
            mutate(item)
            with self.assertRaisesRegex(ValueError, pattern):
                panel.validate_plan({"panels": [item]})

    def test_check_launch_runs_the_deepseek_guard_over_resolved_pi_seats(self):
        item = prd_literal("plan-panel-judged")
        item["seats"][1]["model"] = "deepseek/deepseek-v4"
        with self.assertRaisesRegex(ValueError, "DeepSeek key"):
            panel.check_launch([item], environ={})
        item["seats"][1].update(status="unavailable", error="disabled in the reviewer list")
        panel.check_launch([item], environ={})  # An unavailable seat never runs, so it needs no key.


class Schemas(unittest.TestCase):
    def test_every_example_and_the_judge_states_validate_and_record_1_0_0_still_does(self):
        for name in ("panel-judged", "panel-fallback"):
            validate_schema("panel", registry_example(name))
            panel.validate_record(registry_example(name))
        validate_schema("reviewers", registry_example("reviewers"))
        record = registry_example("panel-judged")
        for status, judge in prd_literal("judge-states").items():
            self.assertEqual(judge["status"], status)
            record["panels"][0]["judge"] = judge
            validate_schema("panel", record)
        for item in appendix_records():  # The 1.0.0 records of the multi-provider panel PRD still validate.
            validate_schema("panel", item)
            panel.validate_record(item)
        from jsonschema.exceptions import ValidationError
        for mutate in (lambda r: r.update(version="1.2.0"), lambda r: r["panels"][0].pop("judge"), lambda r: r["panels"][0].update(judged=False),
                       lambda r: r["panels"][0]["providers"][2].update(transport="codex"), lambda r: r["panels"].append(r["panels"][0]),
                       lambda r: r["panels"][0]["judge"].update(fallback=True), lambda r: r["panels"][0]["findings"][0].update(id="f1"),
                       lambda r: r["panels"][0]["providers"][0].update(status="succeeded")):
            item = registry_example("panel-judged")
            mutate(item)
            with self.assertRaises(ValidationError):
                validate_schema("panel", item)
        legacy = appendix_records()[0]
        legacy["panels"][0]["providers"][0]["transport"] = "cli"  # A 1.0.0 record keeps claude|pi only.
        with self.assertRaises(ValidationError):
            validate_schema("panel", legacy)


def fake_run_probes(argv, **kwargs):
    """Probes for reviewers.resolve in the seat harness: claude --help lists --max-budget-usd, every version probe succeeds."""
    name = Path(argv[0]).name
    out = "  --max-budget-usd <n>\n" if argv[1:] == ["--help"] else ("Muse Code 1.4.7 (1.4.7-R6101.1)\n" if name == "muse" else f"{name} 1.0\n")
    return subprocess.CompletedProcess(argv, 0, stdout=out)


class SeatHarness(Harness):
    """The toy repository and run of Harness, plus fake `muse` and `agy` (workflow/testdata/panel/) on a fake bin dir, and a plan
    whose one judged panel pins seats resolved from the shipped reviewer list. Planted credentials in the controller's environment
    must never reach a cli seat."""

    def setUp(self):
        super().setUp()
        self.fakes = self.tmp / "fake-bin"
        self.fakes.mkdir()
        for name in ("muse", "agy"):
            shutil.copyfile(TESTDATA / f"fake-{name}", self.fakes / name)
            (self.fakes / name).chmod(0o755)
        self.seat_control = self.fakes / "control.json"
        self.seat_control.write_text("{}")
        planted = mock.patch.dict(os.environ, {"META_API_KEY": "planted-meta", "GEMINI_API_KEY": "planted-gemini",
                                               "DBUS_SESSION_BUS_ADDRESS": "unix:path=/run/user/1/bus",
                                               "XDG_RUNTIME_DIR": "/run/user/1"})
        planted.start()
        self.addCleanup(planted.stop)
        self.addCleanup(self.kill_grandchild)
        self.addCleanup(lambda: subprocess.run(["git", "-C", str(self.repo), "worktree", "prune"], capture_output=True))
        (self.repo / "features" / "demo").mkdir(parents=True)

    def kill_grandchild(self):
        import signal
        path = self.fakes / "grandchild.pid"
        if path.exists():
            try:
                os.kill(int(path.read_text()), signal.SIGKILL)
            except (OSError, ValueError):
                pass

    def seats(self, names=None, listing=None) -> list[dict]:
        from . import reviewers
        found = {"claude": str(self.fake_claude), "pi": str(self.pi_bin / "pi"), "muse": str(self.fakes / "muse"), "agy": str(self.fakes / "agy")}
        return reviewers.resolve(listing or registry_example("reviewers"), names, which=lambda name, path=None: found.get(name), run=fake_run_probes)

    def judged_plan(self, seats=None, **over) -> dict:
        from .sessions import pin_roles
        text = panel.JUDGED_BRIEF.read_text()
        item = {"id": "review", "stage": "review", "report_only": False,
                "prompt": {"source": str(panel.JUDGED_BRIEF), "text": text, "sha256": panel.digest_text(text)},
                "requirements": ["docs/req.md"], "requirement_docs": {"docs/req.md": "REQ-1: the pinned requirements text\n"},
                "pi_bin": str(self.pi_bin), "prd_label": None, "reviewers_file": {"label": "~/reviewers.json", "sha256": "a" * 64},
                "seats": self.seats() if seats is None else seats,
                "judge": {"model": "claude-opus-5-5", "effort": "high", "timeout_minutes": 30, "budget_usd": 15, "input_cap_bytes": 600000}}
        item.update(over)
        plan = {"run_id": "panel-001", "repository": str(self.repo), "base_commit": self.base, "nodes": {}, "conventions": None, "panels": [item],
                "prd": None, "roles": pin_roles(judge_model="claude-opus-5-5", env={}),
                "decisions": {"path": str(self.repo / "features" / "demo" / "decisions.md"), "text": "# Decisions\n- [O1] DECISION-ONE: the seat reads me\n"}}
        panel.validate_plan(plan)
        save_json(self.run / "plan.json", plan)
        return plan

    def control_seats(self, **spec):
        self.seat_control.write_text(json.dumps(spec))

    def seen(self) -> list[dict]:
        return [read_json(path) for path in sorted(self.fakes.glob("seen-*.json"), key=lambda p: int(p.stem.split("-")[1]))]

    def fresh_round(self):
        """A new round of the same run: no record, no panel dir, no fake records."""
        shutil.rmtree(self.run / "panel", ignore_errors=True)
        (self.run / "panel.json").unlink(missing_ok=True)
        for path in self.fakes.glob("seen-*.json"):
            path.unlink()

    def worktrees(self) -> str:
        return git(self.repo, "worktree", "list", "--porcelain")

    def pause(self, _):
        time.sleep(0.05)


MUSE_FINDINGS = [{"severity": "P1", "file": "workflow/x.py", "line": 2, "title": "Owner check gone", "detail": "PRD REQ-1: anyone withdraws"}]


class JudgedSeats(SeatHarness):
    def test_seats_run_blind_beside_each_other_and_settle_returns_every_seat(self):
        """Acceptance 4-6: the three transports, the context with decisions.md, the record 1.1.0, <prefix><n> ids, settle's return,
        no attention, and collect a no-op afterwards."""
        self.set_control(claude={"findings": CLAUDE_FINDINGS, "cost": 0.021}, pi={"findings": PI_FINDINGS, "cost": 0.0047})
        self.control_seats(muse={"findings": MUSE_FINDINGS})
        plan = self.judged_plan()
        self.assertEqual([(s["name"], s["status"]) for s in plan["panels"][0]["seats"]], [("claude", "pending"), ("gpt", "pending"), ("muse", "pending")])
        runtime = self.runtime(plan)
        panel.ensure_started(runtime)
        running = self.record()
        self.assertEqual(running["version"], "1.1.0")
        self.assertEqual(running["panels"][0]["judge"], {**prd_literal("judge-states")["pending"]})
        self.assertEqual([p["status"] for p in running["panels"][0]["providers"]], ["running"] * 3)
        settled = panel.settle(runtime, sleep=self.pause)
        record = self.record()
        entry = record["panels"][0]
        self.assertEqual(entry["status"], "succeeded")
        self.assertEqual([(p["name"], p["prefix"], p["transport"], p["status"], p["finding_ids"]) for p in entry["providers"]],
                         [("claude", "C", "claude", "ok", ["C1", "C2"]), ("gpt", "G", "pi", "ok", ["G1", "G2"]), ("muse", "M", "cli", "ok", ["M1"])])
        self.assertEqual([(f["id"], f["providers_raised"], f["accepted"], f["file"]) for f in entry["findings"]],
                         [("C1", ["claude"], False, "workflow/x.py"), ("C2", ["claude"], False, "workflow/new.py"),
                          ("G1", ["gpt"], False, "workflow/x.py"), ("G2", ["gpt"], False, "src/elsewhere.ts"), ("M1", ["muse"], False, "workflow/x.py")])
        muse = entry["providers"][2]
        self.assertEqual((muse["served_model"], muse["cli_version"], muse["cost_usd"], muse["effort"]), ("muse-wonder-1.0", "Muse Code 1.4.7 (1.4.7-R6101.1)", None, None))
        self.assertEqual(entry["providers"][0]["effort"], "high")  # A null-effort claude seat runs the judges' pinned effort.
        # settle's return (design-challenge note 6): each providers[] entry plus its findings cut to six keys, every pinned seat.
        by_id = {f["id"]: f for f in entry["findings"]}
        self.assertEqual(settled, [{**p, "findings": [{k: by_id[i][k] for k in ("id", "severity", "file", "line", "title", "detail")} for i in p["finding_ids"]]}
                                   for p in entry["providers"]])
        # The context: today's sections plus the pinned decisions.md under its repository label.
        context = (self.run / "panel" / "review" / "context.txt").read_text()
        self.assertIn("=== features/demo/decisions.md ===\n# Decisions\n- [O1] DECISION-ONE", context)
        self.assertEqual(panel.context_labels(context), ["docs/req.md", "workflow/new.py", "workflow/x.py", "docs/req.md", "features/demo/decisions.md"])
        # No attention record for a judged panel; collect after settle changes nothing.
        self.assertEqual([line for line in self.attention_lines() if line["kind"] == "panel"], [])
        before = (self.run / "panel.json").read_bytes()
        self.decide()
        panel.collect(runtime, None)
        self.assertEqual((self.run / "panel.json").read_bytes(), before)
        self.assertEqual(panel.settle(self.runtime(plan)), settled)  # A terminal record is returned, never rerun.
        self.assertEqual(len(self.seen()), 1)

    def test_a_candidate_touching_decisions_md_still_gives_the_seats_the_pinned_decisions(self):
        """[G13]: the candidate's edit of decisions.md is a touched-file section; the pinned text still follows under the same label."""
        (self.repo / "features" / "demo" / "decisions.md").write_text("# Decisions\n- [O1] CANDIDATE-REWRITE: nothing is pinned\n")
        git(self.repo, "add", "-A")
        git(self.repo, "commit", "-qm", "candidate editing decisions.md")
        save_json(self.run / "review-bundle.json", {"run_id": "panel-001", "candidate_commit": git(self.repo, "rev-parse", "HEAD")})
        plan = self.judged_plan()
        path, _, _ = panel.assemble_review_context(self.run, plan, plan["panels"][0])
        context = path.read_text()
        self.assertEqual(panel.context_labels(context), ["docs/req.md", "features/demo/decisions.md", "workflow/new.py", "workflow/x.py",
                                                         "docs/req.md", "features/demo/decisions.md"])
        self.assertIn("CANDIDATE-REWRITE", context)
        self.assertIn("=== features/demo/decisions.md ===\n# Decisions\n- [O1] DECISION-ONE", context)

    def test_no_seat_prompt_names_the_run_directory_and_claude_and_pi_argv_equal_todays_builders(self):
        """[L1]: no seat's prompt file names a run-directory path; claude and pi seat argv equal claude_command / pi_command."""
        self.set_control(claude={"findings": []}, pi={"findings": []})
        self.control_seats(muse={"findings": []})
        plan = self.judged_plan()
        runtime = self.runtime(plan)
        panel.ensure_started(runtime)
        panel.settle(runtime, sleep=self.pause)
        run_dir = str(self.run.resolve())
        claude_seen, pi_seen = read_json(self.claude_seen), read_json(self.pi_seen)
        [muse_seen] = self.seen()
        session_id = claude_seen["argv"][claude_seen["argv"].index("--session-id") + 1]
        claude_seat, gpt_seat = plan["panels"][0]["seats"][:2]
        self.assertEqual(claude_seen["argv"], panel.claude_command(str(self.fake_claude), session_id, panel.seat_entry(claude_seat),
                                                                   {"budget_usd": 5}, self.run, plan)[1:])
        self.assertEqual(claude_seen["argv"][claude_seen["argv"].index("--model") + 1], "claude-opus-5-5")  # [L7]: the judges' model.
        self.assertEqual(pi_seen["argv"], panel.pi_command(str(self.pi_bin), panel.seat_entry(gpt_seat), plan["panels"][0]["prompt"]["text"])[1:])
        self.assertEqual(Path(claude_seen["cwd"]).resolve(), (self.run / "review-worktree").resolve())  # Today's placement.
        for prompt in (claude_seen["prompt"], muse_seen["prompt"], pi_seen["argv"][-2], (self.run / "panel" / "review" / "context.txt").read_text()):
            self.assertNotIn(run_dir, prompt)
            self.assertNotIn(str(self.run), prompt)
        self.assertTrue(muse_seen["prompt"].startswith(plan["panels"][0]["prompt"]["text"].rstrip()))

    def test_the_cli_seat_gets_no_prompt_in_argv_dev_null_stdin_an_env_from_nothing_and_a_removed_throwaway_worktree(self):
        """Acceptance 4: argv, stdin, the exact environment ([G14], [G18]) and the worktree and scratch dir, against the fake muse."""
        listing = registry_example("reviewers")
        login = self.tmp / "muse-login.json"
        login.write_text("{}")
        login.chmod(0)
        self.addCleanup(login.chmod, 0o600)
        listing["reviewers"][2]["credential"] = {"file": str(login), "env": "MUSE_LOGIN_FILE"}
        self.control_seats(muse={"findings": MUSE_FINDINGS, "write": True})
        plan = self.judged_plan(self.seats(["muse"], listing))
        runtime = self.runtime(plan)
        panel.settle(runtime, sleep=self.pause)  # Starts the seat itself (nothing started in this process), then waits.
        [seen] = self.seen()
        brief = plan["panels"][0]["prompt"]["text"]
        self.assertFalse(any(brief[:60] in argument or "DECISION-ONE" in argument for argument in seen["argv"]))
        self.assertFalse(any(str(self.run) in argument or str(self.run.resolve()) in argument for argument in seen["argv"]))
        self.assertNotIn(str(login), json.dumps(seen["argv"]))
        self.assertEqual(seen["stdin"], "/dev/null")
        self.assertEqual(seen["argv"][:3], ["exec", "--json", "--no-session-log"])
        prompt_file = Path(seen["argv"][seen["argv"].index("--prompt-file") + 1])
        worktree = Path(seen["argv"][seen["argv"].index("--workspace") + 1])
        self.assertEqual(Path(seen["cwd"]).resolve(), worktree.resolve())
        self.assertTrue(worktree.name.startswith("review-seat-") and prompt_file.parent.name.startswith("review-seat-ctx-"))
        for path in (worktree, prompt_file):
            self.assertFalse(str(path.resolve()).startswith(str(self.run.resolve())))
            self.assertFalse(str(path.resolve()).startswith(str(Path.home() / "dev")))
        self.assertEqual(set(seen["env"]) - {"PWD", "SHLVL", "_", "OLDPWD", "LC_CTYPE"},
                         {"PATH", "HOME", "LANG", "TMPDIR", "MUSE_NO_AUTO_UPDATE", "MUSE_LOGIN_FILE"})
        self.assertEqual(seen["env"]["PATH"], f"{self.fakes}:/usr/bin:/bin")
        self.assertEqual(seen["env"]["MUSE_LOGIN_FILE"], str(login))
        self.assertNotIn("META_API_KEY", seen["env"])
        self.assertNotIn("GEMINI_API_KEY", seen["env"])
        # The seat's write stayed in its throwaway worktree, which is gone with its scratch dir; the candidate is untouched.
        self.assertFalse(worktree.exists())
        self.assertFalse(prompt_file.parent.exists())
        self.assertNotIn(str(worktree), self.worktrees())
        self.assertFalse((self.run / "review-worktree" / "SEAT-WROTE-THIS.txt").exists())
        self.assertEqual(git(self.repo, "status", "--porcelain"), "")
        self.assertEqual(self.record()["panels"][0]["findings"][0]["id"], "M1")
        self.assertTrue((self.run / "panel" / "review" / "muse-1.stdout.txt").stat().st_size > 0)  # Kept for the record.

    def test_the_agy_entry_with_its_pass_names_and_a_stdin_prompt(self):
        listing = registry_example("reviewers")
        listing["reviewers"][3]["enabled"] = True
        listing["reviewers"][3]["cli"]["prompt_via"] = "stdin"
        self.control_seats(agy={"findings": [{"severity": "P2", "file": "workflow/new.py", "line": 1, "title": "t", "detail": "d"}]})
        plan = self.judged_plan(self.seats(["argon"], listing))
        panel.settle(self.runtime(plan), sleep=self.pause)
        [seen] = self.seen()
        self.assertEqual(set(seen["env"]) - {"PWD", "SHLVL", "_", "OLDPWD", "LC_CTYPE"},
                         {"PATH", "HOME", "LANG", "TMPDIR", "AGY_CLI_DISABLE_AUTO_UPDATE", "DBUS_SESSION_BUS_ADDRESS", "XDG_RUNTIME_DIR"})
        self.assertEqual((seen["env"]["DBUS_SESSION_BUS_ADDRESS"], seen["env"]["XDG_RUNTIME_DIR"]), ("unix:path=/run/user/1/bus", "/run/user/1"))
        self.assertTrue(seen["stdin_text"].startswith(plan["panels"][0]["prompt"]["text"].rstrip()))
        self.assertNotEqual(seen["stdin"], "/dev/null")
        self.assertEqual(seen["argv"][1], f"Read the review brief in {Path(seen['argv'][1].split(' in ')[1].split(' and')[0])} and follow it exactly.")
        self.assertEqual(seen["argv"][-1], "15m")
        self.assertEqual([(p["status"], p["finding_ids"], p["cli_version"]) for p in self.record()["panels"][0]["providers"]], [("ok", ["A1"], "agy 1.0")])

    def run_muse(self, spec: dict, **settle) -> dict:
        self.fresh_round()
        self.control_seats(muse=spec)
        plan = self.judged_plan(self.seats(["muse"]))
        panel.settle(self.runtime(plan), **({"sleep": self.pause} | settle))
        return self.record()["panels"][0]["providers"][0]

    def test_each_cli_status_is_produced_by_its_trigger(self):
        """PRD 5.1: ok, auth_required, usage_limit, model_mismatch, error (no terminal event at exit 0; exit != 0), parse_failed."""
        cases = [({"findings": MUSE_FINDINGS}, "ok", None),
                 ({"mode": "auth"}, "auth_required", "Error: Not logged in (run `muse login`)"),
                 ({"mode": "quota"}, "usage_limit", "Error: usage limit reached for your plan (tier_limit); try again later"),
                 ({"served": "muse-lite-0.9", "findings": MUSE_FINDINGS}, "model_mismatch", "served model 'muse-lite-0.9'"),
                 ({"mode": "no_terminal"}, "error", "no output matching"),
                 ({"exit": 2, "findings": MUSE_FINDINGS}, "error", "exit 2"),
                 ({"text": "I reviewed it and it looks fine."}, "parse_failed", "parse_failed: I reviewed it"),
                 ({"text": '["review failed"]'}, "parse_failed", 'parse_failed: ["review failed"]'),
                 ({"text": '{"findings": ["x"]}'}, "parse_failed", 'parse_failed: {"findings": ["x"]}')]
        for spec, status, error in cases:
            with self.subTest(status=status, spec=spec):
                provider = self.run_muse(spec)
                self.assertEqual(provider["status"], status)
                if error is None:
                    self.assertIsNone(provider["error"])
                    self.assertEqual(provider["finding_ids"], ["M1"])
                else:
                    self.assertIn(error, provider["error"])
                    self.assertEqual(provider["finding_ids"], [])
                self.assertEqual(self.record()["panels"][0]["findings"] != [], status == "ok")
                self.assertNotIn("review-seat-", self.worktrees())
        for text in ("[]", '{"findings": []}'):
            with self.subTest(empty=text):
                provider = self.run_muse({"text": text})
                self.assertEqual((provider["status"], provider["error"], provider["finding_ids"]), ("ok", None, []))
        provider = self.run_muse({"mode": "fenced", "findings": MUSE_FINDINGS})
        self.assertEqual(provider["status"], "ok")
        for spec, status in (({"mode": "auth"}, "auth_required"), ({"mode": "quota"}, "usage_limit"), ({"mode": "failed"}, "error")):
            with self.subTest(agy=status):
                self.fresh_round()
                listing = registry_example("reviewers")
                listing["reviewers"][3]["enabled"] = True
                self.control_seats(agy=spec)
                plan = self.judged_plan(self.seats(["argon"], listing))
                panel.settle(self.runtime(plan), sleep=self.pause)
                self.assertEqual(self.record()["panels"][0]["providers"][0]["status"], status)

    def test_a_seat_that_answers_and_exits_leaves_nothing_running_in_its_group(self):
        """Lane review: an exited seat's process group is killed when it is reaped, so a background process it spawned dies."""
        provider = self.run_muse({"mode": "spawn", "findings": MUSE_FINDINGS})
        self.assertEqual(provider["status"], "ok")
        grandchild = int((self.fakes / "grandchild.pid").read_text())
        for _ in range(50):
            if panel._gone(grandchild):
                break
            time.sleep(0.1)
        self.assertTrue(panel._gone(grandchild))
        self.assertNotIn("review-seat-", self.worktrees())

    def test_a_timeout_kills_the_process_group_and_removes_the_worktree(self):
        now = [1000.0]

        def sleep(_):
            time.sleep(0.05)
            if (self.fakes / "grandchild.pid").exists():
                now[0] += 16 * 60  # Past the 15-minute cap, from the seat's own start.
        provider = self.run_muse({"mode": "hang"}, clock=lambda: now[0], sleep=sleep)
        self.assertEqual((provider["status"], provider["error"]), ("timed_out", "timed out after 15 minutes"))
        grandchild = int((self.fakes / "grandchild.pid").read_text())
        for _ in range(50):
            if panel._gone(grandchild):
                break
            time.sleep(0.1)
        self.assertTrue(panel._gone(grandchild))
        self.assertNotIn("review-seat-", self.worktrees())
        self.assertEqual(self.record()["panels"][0]["status"], "timed_out")

    # ---- [L12] B1 / [L13]: the per-seat watchdog, armed at start_seat ----

    def gated_watchdog(self, grace: float = 0.2):
        """The watchdog factory patched: the timer fires as soon as `gate` is set (the seat's cap, reached on the test's word),
        KILL_GRACE_SECONDS patched small; every os.killpg is logged with its thread and the seat's `expired` at that moment."""
        import signal
        import threading
        gate, timers, kills = threading.Event(), [], []
        real_killpg = os.killpg
        main = threading.get_ident()

        def factory(seconds, callback):
            timer = threading.Timer(0.0, lambda: gate.wait(5) and callback())
            timers.append((seconds, timer, callback))
            return timer

        def killpg(pid, sig):
            jobs = [job for items in (self.jobs or {}).values() for job in items]
            kills.append((sig, threading.get_ident() != main, [job.expired for job in jobs if job.process.pid == pid]))
            return real_killpg(pid, sig)
        self.jobs = None
        for patch in (mock.patch.object(panel, "watchdog_timer", factory), mock.patch.object(panel, "KILL_GRACE_SECONDS", grace),
                      mock.patch.object(panel.os, "killpg", killpg)):
            patch.start()
            self.addCleanup(patch.stop)
        self.signal = signal
        return gate, timers, kills

    def start_muse(self, spec: dict, clock=time.time):
        self.control_seats(muse=spec)
        plan = self.judged_plan(self.seats(["muse"]))
        runtime = self.runtime(plan)
        panel.ensure_started(runtime, clock=clock)
        self.jobs = dict(runtime.panel_jobs)
        [job] = runtime.panel_jobs["review"]
        return runtime, job

    def wait_for(self, predicate, seconds: float = 4.0) -> bool:
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            if predicate():
                return True
            time.sleep(0.02)
        return predicate()

    def test_completed_seat_survives_late_settle(self):
        """[L13]: a cli seat that exits with findings at +1 minute keeps them when settle starts at launched + cap + 30 minutes."""
        now = [1000.0]
        runtime, job = self.start_muse({"findings": MUSE_FINDINGS}, clock=lambda: now[0])
        self.assertEqual(job.timeout, 15 * 60)
        self.assertTrue(self.wait_for(lambda: job.process.poll() is not None))
        now[0] = job.launched + job.timeout + 30 * 60
        panel.settle(runtime, clock=lambda: now[0], sleep=self.pause)
        provider = self.record()["panels"][0]["providers"][0]
        self.assertNotEqual(provider["status"], "timed_out")
        self.assertEqual((provider["status"], provider["error"], provider["finding_ids"]), ("ok", None, ["M1"]))
        self.assertEqual([f["id"] for f in self.record()["panels"][0]["findings"]], ["M1"])
        self.assertFalse(job.expired)
        self.assertTrue(job.watchdog_cancelled.is_set())

    def test_a_seat_exiting_past_its_cap_between_the_checks_keeps_its_result(self):
        """[L13]: a seat that exits between `_wait_seats`' running check and its clock comparison is re-checked and reaped on its
        result, not timed_out, when the clock is past its cap and its watchdog has not fired."""
        now = [1000.0]
        runtime, job = self.start_muse({"findings": MUSE_FINDINGS}, clock=lambda: now[0])
        self.assertTrue(self.wait_for(lambda: job.process.poll() is not None))
        real, calls = job.running, []

        def running():
            calls.append(None)
            return len(calls) == 1 or real()  # Still running at the first check, exited by the re-check.
        job.running = running
        now[0] = job.launched + job.timeout + 30 * 60
        panel.settle(runtime, clock=lambda: now[0], sleep=self.pause)
        provider = self.record()["panels"][0]["providers"][0]
        self.assertEqual(len(calls), 2)
        self.assertEqual((provider["status"], provider["error"], provider["finding_ids"]), ("ok", None, ["M1"]))
        self.assertFalse(job.expired)
        self.assertNotIn("review-seat-", self.worktrees())

    def test_watchdog_expires_without_settle(self):
        """[L12] B1 / [L13]: a cli seat outlives its cap while no settle runs: SIGTERMed at the cap with `expired` already set, its
        group gone by cap plus grace; settle then records it timed_out with no findings (the clock still inside the cap) and removes
        its worktree."""
        gate, timers, kills = self.gated_watchdog()
        runtime, job = self.start_muse({"mode": "hang", "findings": MUSE_FINDINGS}, clock=lambda: 1000.0)
        self.assertEqual([seconds for seconds, _, _ in timers], [15 * 60])  # Armed at start_seat with the seat's own cap.
        self.assertTrue(self.wait_for(lambda: (self.fakes / "grandchild.pid").exists()))
        grandchild = int((self.fakes / "grandchild.pid").read_text())
        self.assertEqual(kills, [])
        gate.set()  # The cap.
        self.assertTrue(self.wait_for(lambda: job.process.poll() is not None and panel._gone(grandchild)))
        timers[0][1].join(2)
        self.assertEqual(kills[0], (self.signal.SIGTERM, True, [True]))  # From the timer thread, `expired` set before the signal.
        self.assertTrue(job.expired)
        self.assertIsNone(job.result)  # The callback recorded nothing: the main thread does.
        self.assertIn("review-seat-", self.worktrees())
        panel.settle(runtime, clock=lambda: 1000.0, sleep=self.pause)
        record = self.record()
        provider = record["panels"][0]["providers"][0]
        self.assertNotIn(provider["status"], ("ok", "error"))
        self.assertEqual((provider["status"], provider["error"], provider["finding_ids"]), ("timed_out", "timed out after 15 minutes", []))
        self.assertEqual(record["panels"][0]["findings"], [])
        self.assertNotIn("review-seat-", self.worktrees())

    def test_reaped_seat_watchdog_is_inert(self):
        """[L13]: a reaped seat's watchdog callback, fired by hand, sends no signal and leaves `expired` unchanged."""
        gate, timers, kills = self.gated_watchdog()
        runtime, job = self.start_muse({"findings": MUSE_FINDINGS})
        panel.settle(runtime, sleep=self.pause)
        self.assertEqual(self.record()["panels"][0]["providers"][0]["status"], "ok")
        del kills[:]
        timers[0][2]()
        panel._expire_seat(job)
        self.assertEqual(kills, [])
        self.assertFalse(job.expired)
        gate.set()
        timers[0][1].join(2)  # Cancelled at the reap: the timer itself never runs the callback either.
        self.assertEqual(kills, [])
        self.assertFalse(job.expired)

    def test_stopping_a_seat_cancels_its_timer(self):
        """[L13]: stop_seat cancels the watchdog, before its cap and (challenge note 1) inside its grace: no SIGKILL from the
        watchdog thread after the cancel."""
        gate, timers, kills = self.gated_watchdog(grace=1.5)
        runtime, job = self.start_muse({"mode": "hang"})
        self.assertTrue(self.wait_for(lambda: (self.fakes / "grandchild.pid").exists()))
        panel.stop_seat(job)
        self.assertTrue(timers[0][1].finished.is_set() and job.watchdog_cancelled.is_set())
        gate.set()
        timers[0][1].join(2)
        self.assertFalse(job.expired)
        self.assertEqual([kill for kill in kills if kill[1]], [])  # Nothing from the watchdog thread.
        self.assertNotIn("review-seat-", self.worktrees())
        # Inside the grace: the callback has SIGTERMed, then a cancel stops its pending SIGKILL.
        self.fresh_round()
        gate.clear()
        del kills[:], timers[:]
        runtime, job = self.start_muse({"mode": "hang"})
        self.assertTrue(self.wait_for(lambda: (self.fakes / "grandchild.pid").exists()))
        gate.set()
        self.assertTrue(self.wait_for(lambda: any(kill[1] for kill in kills)))
        self.assertTrue(job.expired)
        panel.cancel_watchdog(job)  # Inside the 1.5 s grace.
        timers[0][1].join(3)
        self.assertEqual([kill[0] for kill in kills if kill[1]], [self.signal.SIGTERM])  # No SIGKILL after the cancel.
        panel.stop_seat(job)

    def test_stopping_a_seat_whose_leader_exits_on_sigterm_kills_the_rest_of_its_group(self):
        """PRD 5.1 / 7.6: a leader that exits on the SIGTERM inside the grace still has its group SIGKILLed, so a child that
        ignores SIGTERM does not outlive the seat."""
        import signal
        pid_file = self.tmp / "child.pid"
        child = f"import signal, time; signal.signal(signal.SIGTERM, signal.SIG_IGN); open({str(pid_file)!r}, 'w').write('ready'); time.sleep(60)"
        leader = f"import subprocess, sys, time; c = subprocess.Popen([sys.executable, '-c', {child!r}]); time.sleep(60)"
        process = subprocess.Popen([sys.executable, "-c", leader], start_new_session=True)
        children: list[str] = []

        def kill_survivors():
            if process.poll() is None or not all(panel._gone(int(pid)) for pid in children):  # The group still has a member.
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except (ProcessLookupError, PermissionError):
                    pass
            process.wait()
        self.addCleanup(kill_survivors)
        self.assertTrue(self.wait_for(lambda: pid_file.exists() and pid_file.read_text() == "ready", seconds=30))  # Two interpreter starts on a loaded host.
        children[:] = Path(f"/proc/{process.pid}/task/{process.pid}/children").read_text().split()
        self.assertEqual(len(children), 1)
        job = panel.Job(0, 0, {"transport": "cli", "name": "muse"}, process, 0.0, 900.0, self.tmp / "x.stdout", "s", 1)
        panel.stop_seat(job)
        self.assertEqual(process.poll(), -signal.SIGTERM)  # The leader took the SIGTERM path: only the group SIGKILL can end the child.
        self.assertTrue(self.wait_for(lambda: panel._gone(int(children[0])), seconds=10))

    def test_a_stop_interrupted_in_its_wait_still_kills_the_group_and_cleans_up(self):
        """A KeyboardInterrupt in stop_seat's wait still SIGKILLs the seat's group (a child ignoring SIGTERM) and removes its
        scratch dir, and the KeyboardInterrupt propagates."""
        import signal
        pid_file = self.tmp / "child.pid"
        child = f"import signal, time; signal.signal(signal.SIGTERM, signal.SIG_IGN); open({str(pid_file)!r}, 'w').write('ready'); time.sleep(60)"
        leader = f"import signal, subprocess, sys, time; signal.signal(signal.SIGTERM, signal.SIG_IGN); c = subprocess.Popen([sys.executable, '-c', {child!r}]); time.sleep(60)"
        process = subprocess.Popen([sys.executable, "-c", leader], start_new_session=True)
        children: list[str] = []

        def kill_survivors():
            if process.poll() is None or not all(panel._gone(int(pid)) for pid in children):  # The group still has a member.
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except (ProcessLookupError, PermissionError):
                    pass
            process.wait()
        self.addCleanup(kill_survivors)
        self.assertTrue(self.wait_for(lambda: pid_file.exists() and pid_file.read_text() == "ready", seconds=30))  # Two interpreter starts on a loaded host.
        children[:] = Path(f"/proc/{process.pid}/task/{process.pid}/children").read_text().split()
        self.assertEqual(len(children), 1)
        scratch = Path(tempfile.mkdtemp(prefix="seat-scratch-", dir=self.tmp))
        job = panel.Job(0, 0, {"transport": "cli", "name": "muse"}, process, 0.0, 900.0, self.tmp / "x.stdout", "s", 1)
        job.stderr, job.stem, job.worktree, job.scratch, job.repository = self.tmp / "x.stderr", self.tmp / "muse-1", None, scratch, str(self.repo)
        with mock.patch.object(process, "wait", side_effect=KeyboardInterrupt):
            with self.assertRaises(KeyboardInterrupt):
                panel.stop_seat(job)
        self.assertTrue(self.wait_for(lambda: process.poll() is not None, seconds=10))  # Both ignore SIGTERM: only the group SIGKILL ends them.
        self.assertEqual(process.returncode, -signal.SIGKILL)
        self.assertTrue(self.wait_for(lambda: panel._gone(int(children[0])), seconds=10))
        self.assertFalse(scratch.exists())

    def test_stopping_seats_interrupted_in_the_first_wait_still_stops_every_seat(self):
        """A KeyboardInterrupt in the first seat's stop wait (a second Ctrl-C) does not end _stop_seats: every seat's group
        (leader and child both ignoring SIGTERM) is killed, every worktree and scratch dir removed, and the interrupt propagates."""
        import signal
        jobs, processes, children = [], [], []
        self.addCleanup(lambda: subprocess.run(["git", "-C", str(self.repo), "worktree", "prune"], capture_output=True))
        for n in (1, 2):
            pid_file = self.tmp / f"child-{n}.pid"
            child = f"import signal, time; signal.signal(signal.SIGTERM, signal.SIG_IGN); open({str(pid_file)!r}, 'w').write('ready'); time.sleep(60)"
            leader = f"import signal, subprocess, sys, time; signal.signal(signal.SIGTERM, signal.SIG_IGN); c = subprocess.Popen([sys.executable, '-c', {child!r}]); time.sleep(60)"
            process = subprocess.Popen([sys.executable, "-c", leader], start_new_session=True)
            processes.append(process)

            def kill_survivors(process=process):
                if process.poll() is None or not all(panel._gone(int(pid)) for pid in children):  # A group may still have a member.
                    try:
                        os.killpg(process.pid, signal.SIGKILL)
                    except (ProcessLookupError, PermissionError):
                        pass
                process.wait()
            self.addCleanup(kill_survivors)
            self.assertTrue(self.wait_for(lambda: pid_file.exists() and pid_file.read_text() == "ready", seconds=30))  # Two interpreter starts on a loaded host.
            children.extend(Path(f"/proc/{process.pid}/task/{process.pid}/children").read_text().split())
            worktree = self.tmp / f"review-seat-{n}"
            git(self.repo, "worktree", "add", "--detach", str(worktree), self.candidate)
            scratch = Path(tempfile.mkdtemp(prefix="seat-scratch-", dir=self.tmp))
            job = panel.Job(0, n - 1, {"transport": "cli", "name": "muse"}, process, 0.0, 900.0, self.tmp / f"x{n}.stdout", "s", 1)
            job.stderr, job.stem, job.worktree, job.scratch, job.repository = self.tmp / f"x{n}.stderr", self.tmp / f"muse-{n}", worktree, scratch, str(self.repo)
            jobs.append(job)
        self.assertEqual(len(children), 2)
        left = [job.worktree for job in jobs] + [job.scratch for job in jobs]
        with mock.patch.object(processes[0], "wait", side_effect=KeyboardInterrupt):
            with self.assertRaises(KeyboardInterrupt):
                panel._stop_seats(jobs)
        for process in processes:
            self.assertTrue(self.wait_for(lambda: process.poll() is not None, seconds=10))  # Both ignore SIGTERM: only the group SIGKILL ends them.
            self.assertEqual(process.returncode, -signal.SIGKILL)
        for pid in children:
            self.assertTrue(self.wait_for(lambda: panel._gone(int(pid)), seconds=10))
        for path in left:
            self.assertFalse(path.exists(), path)
        self.assertNotIn("review-seat-", git(self.repo, "worktree", "list", "--porcelain"))

    def launch_failing(self, step: str) -> tuple[dict, dict]:
        """A muse seat whose `.pid` write (`step` "pid") or watchdog (`step` "watchdog") fails after the spawn, once the seat has
        a grandchild in its group: returns its provider record and the `.pid` record start_seat built (pid, worktree, scratch),
        plus `grandchild` (its pid, or None when it never came up)."""
        import signal
        built, real_save = {}, panel.save_json
        grandchild = self.fakes / "grandchild.pid"

        def wait_for_grandchild():
            ready = self.wait_for(lambda: grandchild.exists() and grandchild.read_text().strip().isdigit(), seconds=30)  # Interpreter start on a loaded host.
            built["grandchild"] = int(grandchild.read_text()) if ready else None

        def save(path, value):
            if str(path).endswith(".pid"):
                built.update(value)
                if step == "pid":
                    wait_for_grandchild()
                    raise OSError(28, "No space left on device")
            return real_save(path, value)

        def arm(job):
            wait_for_grandchild()
            raise RuntimeError("can't start new thread")

        def kill_leftover():
            pid = built.get("pid")
            if pid and not panel._gone(pid):
                try:
                    os.killpg(pid, signal.SIGKILL)
                except (ProcessLookupError, PermissionError):
                    pass
            if pid:
                try:
                    os.waitpid(pid, 0)
                except ChildProcessError:
                    pass
            for left in (built.get("worktree"), built.get("scratch")):  # What a failing run left behind.
                if left:
                    shutil.rmtree(left, ignore_errors=True)
        self.addCleanup(kill_leftover)
        self.control_seats(muse={"mode": "hang"})
        plan = self.judged_plan(self.seats(["muse"]))
        patches = [mock.patch.object(panel, "save_json", save)] + ([mock.patch.object(panel, "arm_watchdog", arm)] if step == "watchdog" else [])
        for patch in patches:
            patch.start()
        try:
            panel.ensure_started(self.runtime(plan))
        finally:
            for patch in patches:
                patch.stop()
        return self.record()["panels"][0]["providers"][0], built

    def assert_launch_failure_left_nothing(self, provider: dict, built: dict, error: str):
        self.assertEqual(provider["status"], "error")
        self.assertIn(f"launch failed: {error}", provider["error"])
        self.assertTrue(self.wait_for(lambda: panel._gone(built["pid"]), seconds=10))
        self.assertIsNotNone(built["grandchild"])  # The failure struck with a grandchild in the group: the whole group is killed.
        self.assertTrue(self.wait_for(lambda: panel._gone(built["grandchild"]), seconds=10))
        self.assertNotIn("review-seat-", self.worktrees())
        self.assertFalse(Path(built["worktree"]).exists())
        self.assertFalse(Path(built["scratch"]).exists())

    def test_a_seat_whose_pid_record_cannot_be_written_is_stopped_and_cleaned_up(self):
        """PRD 5.2 / 9: a `.pid` write failing after the spawn (ENOSPC) stops the seat's group and removes its worktree and
        scratch dir before the launch failure is recorded."""
        provider, built = self.launch_failing("pid")
        self.assert_launch_failure_left_nothing(provider, built, "OSError")

    def test_a_seat_whose_watchdog_cannot_be_armed_is_stopped_and_cleaned_up(self):
        """PRD 5.2 / 9: a watchdog that cannot start (Timer.start's RuntimeError) stops the seat the same way."""
        provider, built = self.launch_failing("watchdog")
        self.assert_launch_failure_left_nothing(provider, built, "RuntimeError")

    def test_an_expired_seat_is_timed_out_on_an_exit_with_no_review_json(self):
        """Challenge note 2: a seat killed at its cap during the built-in reviewers is recorded timed_out, not `error: exit -15`,
        when the review exits with no review.json."""
        gate, timers, kills = self.gated_watchdog()
        runtime, job = self.start_muse({"mode": "hang"})
        self.assertTrue(self.wait_for(lambda: (self.fakes / "grandchild.pid").exists()))
        gate.set()
        self.assertTrue(self.wait_for(lambda: job.process.poll() is not None))
        panel.collect(runtime, None)
        provider = self.record()["panels"][0]["providers"][0]
        self.assertEqual((provider["status"], provider["error"]), ("timed_out", "timed out after 15 minutes"))
        self.assertNotIn("review-seat-", self.worktrees())

    def test_ctrl_c_in_settle_stops_the_seats_and_resume_relaunches_and_awaits_them(self):
        """PRD 7.6: a KeyboardInterrupt kills the groups, removes the worktrees and leaves the seats non-terminal; settle on resume
        relaunches the non-terminal seat (a new numbered file) and returns only once it has ended."""
        self.set_control(claude={"findings": CLAUDE_FINDINGS}, pi={"findings": []})
        self.control_seats(muse={"mode": "hang"})
        plan = self.judged_plan()
        runtime = self.runtime(plan)
        panel.ensure_started(runtime)

        armed = []

        def interrupt(_):
            """Once claude and pi have answered and muse hangs: one more poll (which reaps them), then Ctrl-C."""
            if armed:
                raise KeyboardInterrupt
            time.sleep(0.05)
            if self.claude_seen.exists() and self.pi_seen.exists() and (self.fakes / "grandchild.pid").exists():
                time.sleep(1.0)
                armed.append(True)
        with self.assertRaises(KeyboardInterrupt):
            panel.settle(runtime, sleep=interrupt)
        record = self.record()
        self.assertEqual([p["status"] for p in record["panels"][0]["providers"]], ["ok", "ok", "running"])
        self.assertEqual(record["panels"][0]["status"], "running")
        [first] = self.seen()
        self.assertFalse(Path(first["cwd"]).exists())
        self.assertNotIn("review-seat-", self.worktrees())
        grandchild = int((self.fakes / "grandchild.pid").read_text())
        for _ in range(50):
            if panel._gone(grandchild):
                break
            time.sleep(0.1)
        self.assertTrue(panel._gone(grandchild))
        # Resume: a new controller process; only the muse seat reruns, and settle waits for it.
        (self.fakes / "grandchild.pid").unlink()
        self.control_seats(muse={"findings": MUSE_FINDINGS, "delay": 0})
        claude_runs = len(list((self.run / "panel" / "review").glob("claude-*.stdout.json")))
        resumed = self.runtime(plan)
        settled = panel.settle(resumed, sleep=self.pause)
        self.assertEqual([seat["status"] for seat in settled], ["ok", "ok", "ok"])
        self.assertEqual(settled[2]["findings"][0]["id"], "M1")
        self.assertEqual(len(self.seen()), 2)
        self.assertTrue((self.run / "panel" / "review" / "muse-2.stdout.txt").exists())
        self.assertEqual(len(list((self.run / "panel" / "review").glob("claude-*.stdout.json"))), claude_runs)  # Terminal seats kept.
        self.assertEqual(self.record()["panels"][0]["findings"][0]["id"], "C1")  # Their findings re-merged from the side files.

    def test_ctrl_c_while_starting_the_seats_stops_the_started_ones_and_leaves_them_non_terminal(self):
        """Lane review: a KeyboardInterrupt while a later seat starts stops the earlier ones (group killed, worktree removed),
        saves them `running` for resume, and propagates."""
        listing = registry_example("reviewers")
        listing["reviewers"][3]["enabled"] = True
        self.control_seats(muse={"mode": "hang"})
        plan = self.judged_plan(self.seats(["muse", "argon"], listing))
        self.assertEqual([seat["name"] for seat in plan["panels"][0]["seats"]], ["muse", "argon"])
        start = panel.start_seat

        def interrupted(runtime, index, *args):
            if index == 1:
                for _ in range(100):
                    if (self.fakes / "grandchild.pid").exists():
                        break
                    time.sleep(0.05)
                raise KeyboardInterrupt
            return start(runtime, index, *args)
        runtime = self.runtime(plan)
        with mock.patch.object(panel, "start_seat", interrupted), self.assertRaises(KeyboardInterrupt):
            panel.ensure_started(runtime)
        self.assertIsNone(runtime.panel_jobs)
        self.assertEqual([p["status"] for p in self.record()["panels"][0]["providers"]], ["running", "pending"])
        grandchild = int((self.fakes / "grandchild.pid").read_text())
        for _ in range(50):
            if panel._gone(grandchild):
                break
            time.sleep(0.1)
        self.assertTrue(panel._gone(grandchild))
        [seen] = self.seen()
        self.assertFalse(Path(seen["cwd"]).exists())
        self.assertNotIn("review-seat-", self.worktrees())

    def test_a_file_credential_reaches_claude_and_pi_seats_in_its_env(self):
        """Lane review: a `{file, env}` credential is passed to every transport, not only cli."""
        listing = registry_example("reviewers")
        logins = {}
        for index, name in ((0, "CLAUDE_LOGIN_FILE"), (1, "PI_LOGIN_FILE")):
            login = self.tmp / f"{name.lower()}.json"
            login.write_text("{}")
            listing["reviewers"][index]["credential"] = {"file": str(login), "env": name}
            logins[name] = str(login)
        self.set_control(claude={"findings": []}, pi={"findings": []})
        plan = self.judged_plan(self.seats(["claude", "gpt"], listing))
        panel.settle(self.runtime(plan), sleep=self.pause)
        claude_env, pi_env = read_json(self.claude_seen)["env"], read_json(self.pi_seen)["env"]
        self.assertEqual(claude_env.get("CLAUDE_LOGIN_FILE"), logins["CLAUDE_LOGIN_FILE"])
        self.assertNotIn("PI_LOGIN_FILE", claude_env)
        self.assertEqual(pi_env.get("PI_LOGIN_FILE"), logins["PI_LOGIN_FILE"])
        self.assertEqual(set(pi_env) - {"PWD", "SHLVL", "_", "OLDPWD"}, {"PATH", "HOME", "LANG", "TMPDIR", "PI_LOGIN_FILE"})

    def test_orphan_cleanup_on_resume_kills_a_leftover_seat_and_removes_its_worktree(self):
        self.control_seats(muse={"mode": "hang"})
        plan = self.judged_plan(self.seats(["muse"]))
        crashed = self.runtime(plan)
        panel.ensure_started(crashed)  # The controller "crashes" here: no collect, no settle.
        for _ in range(100):
            if self.seen():
                break
            time.sleep(0.05)
        [orphan] = self.seen()
        self.assertTrue(Path(orphan["cwd"]).exists())
        self.control_seats(muse={"findings": []})
        [seat] = panel.settle(self.runtime(plan), sleep=self.pause)
        self.assertEqual(seat["status"], "ok")
        self.assertTrue(panel._gone(orphan["pid"]) or not Path(f"/proc/{orphan['pid']}").exists())
        self.assertFalse(Path(orphan["cwd"]).exists())
        self.assertNotIn("review-seat-", self.worktrees())
        crashed.panel_jobs = None  # Nothing left for the crashed process's handles to do.

    def test_orphan_cleanup_kills_a_group_member_that_ignores_sigterm(self):
        """An orphan seat whose leader exits on the SIGTERM still has its group SIGKILLed (as stop_seat), so a child ignoring
        SIGTERM does not outlive it while its worktree is removed."""
        import signal
        orphan_cwd = Path(tempfile.mkdtemp(prefix="orphan-seat-", dir=self.tmp)).resolve()
        pid_file = self.tmp / "child.pid"
        child = f"import signal, time; signal.signal(signal.SIGTERM, signal.SIG_IGN); open({str(pid_file)!r}, 'w').write('ready'); time.sleep(60)"
        leader = f"import subprocess, sys, time; c = subprocess.Popen([sys.executable, '-c', {child!r}]); time.sleep(60)  # orphan-seat-leader"
        process = subprocess.Popen([sys.executable, "-c", leader], cwd=str(orphan_cwd), start_new_session=True)
        children: list[str] = []

        def kill_survivors():
            if process.poll() is None or not all(panel._gone(int(pid)) for pid in children):  # The group still has a member.
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except (ProcessLookupError, PermissionError):
                    pass
            process.wait()
        self.addCleanup(kill_survivors)
        self.assertTrue(self.wait_for(lambda: pid_file.exists() and pid_file.read_text() == "ready", seconds=30))  # Two interpreter starts on a loaded host.
        children[:] = Path(f"/proc/{process.pid}/task/{process.pid}/children").read_text().split()
        self.assertEqual(len(children), 1)
        panel_dir = self.run / "panel" / "review"
        panel_dir.mkdir(parents=True)
        save_json(panel_dir / "muse-1.pid", {"pid": process.pid, "cwd": str(orphan_cwd), "marker": "someone-elses-process",
                                             "worktree": None, "scratch": None})
        panel.kill_orphan_seat(panel_dir, "muse", str(self.repo))  # A live pid whose marker does not match is never signalled.
        self.assertFalse(self.wait_for(lambda: process.poll() is not None, seconds=1))
        self.assertFalse(panel._gone(int(children[0])))
        save_json(panel_dir / "muse-2.pid", {"pid": process.pid, "cwd": str(orphan_cwd), "marker": "orphan-seat-leader",
                                             "worktree": None, "scratch": str(orphan_cwd)})  # The latest record is the one read.
        panel.kill_orphan_seat(panel_dir, "muse", str(self.repo))
        self.assertTrue(self.wait_for(lambda: process.poll() is not None, seconds=10))
        self.assertTrue(self.wait_for(lambda: panel._gone(int(children[0])), seconds=10))
        self.assertFalse(orphan_cwd.exists())

    def test_an_unavailable_seat_is_recorded_and_an_all_unavailable_panel_still_settles(self):
        listing = registry_example("reviewers")
        plan = self.judged_plan(self.seats(["argon"], listing))
        settled = panel.settle(self.runtime(plan), sleep=self.pause)
        self.assertEqual([(s["status"], s["error"], s["context_bytes"], s["findings"]) for s in settled],
                         [("unavailable", "disabled in the reviewer list", None, [])])
        entry = self.record()["panels"][0]
        self.assertEqual((entry["status"], entry["error"]), ("failed", "no seat returned findings: argon unavailable"))
        self.assertEqual(self.seen(), [])

    def test_ctrl_c_before_settle_through_collect_leaves_the_seats_non_terminal_and_removes_worktrees(self):
        self.control_seats(muse={"mode": "hang"})
        plan = self.judged_plan(self.seats(["muse"]))
        runtime = self.runtime(plan)
        panel.ensure_started(runtime)
        for _ in range(100):
            if (self.fakes / "grandchild.pid").exists():
                break
            time.sleep(0.05)
        panel.collect(runtime, KeyboardInterrupt())
        self.assertEqual(self.record()["panels"][0]["providers"][0]["status"], "running")
        self.assertNotIn("review-seat-", self.worktrees())
        self.assertIsNone(runtime.panel_jobs)


class JudgeRecord(SeatHarness):
    def seed(self, name: str) -> dict:
        """The example's record as settle leaves it: every finding unaccepted, ended_at the seats' end, the judge pending."""
        example = registry_example(name)
        record = json.loads(json.dumps(example))
        entry = record["panels"][0]
        for finding in entry["findings"]:
            finding["accepted"] = False
        entry["ended_at"] = "2026-10-15T10:24:00Z"
        entry["judge"] = {**prd_literal("judge-states")["pending"]}
        panel.save_record(self.run, record)
        return example

    def test_record_judge_reproduces_the_judged_and_the_fallback_examples(self):
        """[L4]: accepted exactly for the sources of confirmed rulings of a judged record (all false on fallback); ended_at = the judge's."""
        runtime = self.runtime(self.judged_plan())
        for name in ("panel-judged", "panel-fallback"):
            with self.subTest(name):
                example = self.seed(name)
                panel.record_judge(runtime, "review", example["panels"][0]["judge"])
                self.assertEqual(read_json(self.run / "panel.json"), example)

    def test_record_judge_accepts_the_non_terminal_states_and_refuses_a_broken_object(self):
        runtime = self.runtime(self.judged_plan())
        self.seed("panel-judged")
        for status, judge in prd_literal("judge-states").items():
            panel.record_judge(runtime, "review", judge)
            entry = self.record()["panels"][0]
            self.assertEqual((entry["judge"], entry["ended_at"]), (judge, judge["ended_at"]))
            self.assertEqual([f["accepted"] for f in entry["findings"]], [False] * 4)
        unlinked = json.loads(json.dumps(prd_literal("judge-states")["running"]))
        unlinked["reviewer_findings"][0]["worker"] = None  # A built-in finding that names no lane (review.json's worker is optional).
        panel.record_judge(runtime, "review", unlinked)
        for status in ("failed", "timed_out"):
            judge = {**prd_literal("judge-states")["incomplete"], "status": status}
            panel.record_judge(runtime, "review", judge)
            self.assertEqual(self.record()["panels"][0]["judge"]["status"], status)
        before = (self.run / "panel.json").read_bytes()
        judged = registry_example("panel-judged")["panels"][0]["judge"]
        for broken in ({**judged, "fallback": True}, {**judged, "extra": 1}, {**judged, "status": "decided"},
                       {**prd_literal("judge-states")["running"], "ended_at": "2026-10-15T10:31:40Z"},
                       {**judged, "rulings": [{**judged["rulings"][0], "id": "X1"}]}, {**judged, "effort": "low"}):
            with self.assertRaisesRegex(ValueError, "breaks panel record 1.1.0"):
                panel.record_judge(runtime, "review", broken)
            self.assertEqual((self.run / "panel.json").read_bytes(), before)
        with self.assertRaisesRegex(ValueError, "no judged panel 'other'"):
            panel.record_judge(runtime, "other", judged)

    def test_the_export_status_and_outcome_of_a_judged_plan_before_during_and_after_the_judge(self):
        """Design-challenge note 2 and PRD 7.7: no panel.json, a running record, judged and fallback records."""
        plan = self.judged_plan()
        pending = panel.export_section(self.run, plan)
        validate_schema("panel", pending)
        self.assertEqual((pending["version"], pending["panels"][0]["judge"]), ("1.1.0", prd_literal("judge-states")["pending"]))
        self.assertEqual(panel.status_lines(self.run, plan), ["Panel (judged): runs at the review step."])
        self.assertEqual(panel.outcome_lines(self.run, plan), ["Panel (judged): runs at the review step."])
        running = json.loads(json.dumps(pending))
        running["panels"][0].update(status="running", started_at="2026-10-15T10:02:11Z")
        panel.save_record(self.run, running)
        self.assertEqual(panel.export_section(self.run, plan), running)
        self.assertEqual(panel.outcome_lines(self.run, plan), ["Panel (judged): seats running."])
        example = self.seed("panel-judged")
        self.assertEqual(panel.status_lines(self.run, plan), ["Panel (judged): 3 seats ok, 0 not ok; judge pending"])
        panel.record_judge(self.runtime(plan), "review", example["panels"][0]["judge"])
        self.assertEqual(panel.export_section(self.run, plan), example)  # Record 1.1.0 verbatim in the export.
        line = "Panel (judged): 3 seats ok, 0 not ok; judge: 2 confirmed (1 P0/P1), 1 deferred, 1 refuted"
        self.assertEqual((panel.status_lines(self.run, plan), panel.outcome_lines(self.run, plan)), ([line], [line]))
        example = self.seed("panel-fallback")
        panel.record_judge(self.runtime(plan), "review", example["panels"][0]["judge"])
        self.assertEqual(panel.outcome_lines(self.run, plan), ["Panel (judged): judge timed_out; today's rule decided"])
        self.assertNotIn("report-only", json.dumps(panel.outcome_lines(self.run, plan) + panel.status_lines(self.run, plan)))
        (self.run / "panel.json").write_text('{"version": "1.1.0", "panels": []}')
        broken = panel.export_section(self.run, plan)
        validate_schema("panel", broken)
        self.assertTrue(broken["panels"][0]["error"].startswith("panel.json is not valid"))
        self.assertEqual([line for line in self.attention_lines() if line["kind"] == "panel"], [])


class ReportOnlyRegression(Harness):
    def test_a_report_only_panel_writes_the_same_1_0_0_panel_json_bytes_as_before_the_judged_panel(self):
        """Acceptance 8: a report-only panel (as a 2.11.0 feature pins it, the same plan item as 2.10.0) writes panel.json 1.0.0 with
        the bytes of the golden record written by the code before this change (workflow/testdata/panel/report-only-panel.json)."""
        self.set_control(claude={"findings": CLAUDE_FINDINGS, "cost": 0.021}, pi={"findings": PI_FINDINGS, "cost": 0.0047})
        plan = self.plan()
        runtime = self.runtime(plan)
        clock = lambda: 1_790_000_000.0  # noqa: E731
        panel.ensure_started(runtime, clock=clock)
        self.decide()
        panel.collect(runtime, None, clock=clock, sleep=lambda _: time.sleep(0.05))
        self.assertEqual((self.run / "panel.json").read_bytes(), (TESTDATA / "report-only-panel.json").read_bytes())
        self.assertEqual(read_json(self.run / "panel.json")["version"], "1.0.0")


if __name__ == "__main__":
    unittest.main()
