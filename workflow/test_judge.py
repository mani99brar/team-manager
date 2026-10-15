"""The judged review panel's judge lane (feature.json 2.11.0; features/review-panel-registry/prd.md 7.2-7.6, Appendix A and B;
RUNBOOK "Judged review panel (feature.json 2.11.0)"): the regression of runs without a judged panel, the frozen literals, the
output checks, the job itself, review.json and its validators, judged graph runs on both transports, fallback and resume, and
the candidate-level test over the seats lane's real ports.

The frozen examples (features/review-panel-registry/examples/) and PRD Appendix B's literals are loaded verbatim. Values are
compared only within one example; across examples only key sets and types ([L6])."""
import copy
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import unittest
import uuid
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from .sessions import read_json, save_json
from . import test_automatic
from . import test_pipeline as fixtures

REPO = Path(__file__).resolve().parents[1]
TESTDATA = Path(__file__).resolve().parent / "testdata" / "judge"
FEATURE = REPO / "features" / "review-panel-registry"
RECORD_GOLDEN = os.environ.get("JUDGE_RECORD_GOLDEN") == "1"  # Set once, on the code before the judge lane, to write the goldens.


def setUpModule():
    fixtures.isolate_registry()
    fixtures.stub_claude_cli()


UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
TIME = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?")


def normalized(value, roots: list[Path]) -> str:
    """`value` as indented JSON with what differs between two runs of one scenario replaced: the temporary roots, commits and
    digests, timestamps, and UUIDs (numbered in order of first appearance, so the structure still shows)."""
    text = json.dumps(value, indent=2)  # Key order kept: save_json writes insertion order.
    for root in roots:
        text = text.replace(str(root.resolve()), "<ROOT>").replace(str(root), "<ROOT>")
    text = re.sub(r"\b[0-9a-f]{64}\b", "<SHA256>", text)
    text = re.sub(r"\b[0-9a-f]{40}\b", "<COMMIT>", text)
    text = TIME.sub("<TIME>", text)
    seen: dict[str, str] = {}
    return UUID.sub(lambda match: seen.setdefault(match.group(0), f"<UUID{len(seen) + 1}>"), text) + "\n"


class NoJudgedPanelRegressionTests(test_automatic.GraphFixture):
    """PRD 10.9 (judge lane's part): a run whose plan has no judged panel writes review.json, panel.json and the export's review
    and panels sections byte for byte as before the judge lane, on today's 2.10.0 fixtures with a report-only panel. The
    goldens in workflow/testdata/judge/ were recorded from the controller before this lane (JUDGE_RECORD_GOLDEN=1); the judge
    ports are patched in and must never be called."""

    reviewers = ["general", "coverage"]
    P1 = {"severity": "P1", "message": "The retry loop never ends. Consequence: the worker hangs.", "disposition": "open", "worker": "adapter",
          "requirement": None}
    P2 = {"severity": "P2", "message": "No test asserts the empty state.", "disposition": "open", "worker": "ui", "requirement": None}

    def setUp(self):
        super().setUp()
        f = self.fixture
        scratch = f.root / "panel-fakes"
        scratch.mkdir()
        (scratch / "control.json").write_text(json.dumps({
            "claude": {"findings": [{"severity": "P1", "file": "ui.txt", "line": 1, "title": "Content changed without a test", "detail": "ui.txt changed"}],
                       "cost": 0.021},
            "pi": {"findings": [{"severity": "high", "file": "ui.txt", "line": 1, "title": "ui content change lacks a test", "detail": "no test"}],
                   "cost": 0.0047}}))
        shutil.copyfile(TESTDATA / "fake-panel-claude.py", scratch / "fake-claude.py")
        fake_claude = scratch / "fake-claude"
        fake_claude.write_text(f"#!/bin/sh\nexec {sys.executable} -I {scratch / 'fake-claude.py'} \"$@\"\n")
        fake_claude.chmod(0o755)
        pi_bin = scratch / "pi-bin"
        pi_bin.mkdir()
        shutil.copyfile(TESTDATA / "fake-panel-pi.py", scratch / "fake-pi.py")
        (pi_bin / "pi").write_text(f"#!/bin/sh\nexec {sys.executable} -I {scratch / 'fake-pi.py'} \"$@\"\n")
        (pi_bin / "pi").chmod(0o755)
        f.plan["panels"] = [{"id": "review-panel", "stage": "review",
                             "providers": [{"transport": "claude", "model": None, "effort": "high"},
                                           {"transport": "pi", "model": "openai-codex/gpt-6-sol", "effort": None}],
                             "prompt": {"source": "builtin:review", "text": "PINNED BRIEF: review the material and reply with findings.", "sha256": "x"},
                             "requirements": [], "requirement_docs": {}, "budget_usd": 5, "timeout_minutes": 15, "overlap_threshold": 2,
                             "report_only": True, "pi_bin": str(pi_bin), "prd_label": None}]
        f.plan["feature_version"] = "2.10.0"
        save_json(f.directory / "plan.json", f.plan)
        f.sessions = fixtures.FakeSessions(f.directory, f.plan)
        f.sessions.reviewer_verdict_file = self.verdict
        f.sessions.executable = str(fake_claude)
        f.runtime = fixtures.OfflinePipeline(f.directory, f.sessions)

    def drive(self, blocked: bool):
        from .automatic import drive
        ports = []
        try:
            from . import judge  # noqa: F401 - absent before the judge lane, when the goldens were recorded.
            ports = [patch("workflow.panel.settle", create=True), patch("workflow.panel.record_judge", create=True), patch("workflow.judge.run")]
        except ImportError:
            pass
        mocks = [port.start() for port in ports]
        for port in ports:
            self.addCleanup(port.stop)
        with patch("workflow.automatic.wait_handoffs"):
            if blocked:
                with self.assertRaisesRegex(RuntimeError, "Non-retryable"):
                    drive(self.fixture.runtime)
            else:
                drive(self.fixture.runtime)
        for mock in mocks:
            mock.assert_not_called()

    def assert_golden(self, name: str, value) -> None:
        path = TESTDATA / f"regression-{name}.golden.json"
        text = normalized(value, [self.fixture.root])
        if RECORD_GOLDEN:
            path.write_text(text)
        self.assertEqual(text, path.read_text())

    def outputs(self) -> dict:
        f = self.fixture
        exported = read_json(f.directory / "run-state.json")
        return {"review.json": read_json(f.directory / "review.json"), "panel.json": read_json(f.directory / "panel.json"),
                "export.review": exported["review"], "export.panels": exported["panels"]}

    def test_an_approved_two_reviewer_run_with_a_report_only_panel_is_byte_identical(self):
        self.fixture.sessions.reviewer_findings = {"general": [self.P2]}
        self.drive(blocked=False)
        for name, value in self.outputs().items():
            with self.subTest(name):
                self.assert_golden(f"approved-{name}", value)

    def test_a_blocked_two_reviewer_run_with_a_report_only_panel_is_byte_identical(self):
        self.fixture.sessions.reviewer_findings = {"general": [self.P2], "coverage": [self.P1]}
        self.drive(blocked=True)
        for name, value in self.outputs().items():
            with self.subTest(name):
                self.assert_golden(f"blocked-{name}", value)



# ---- The frozen literals ---------------------------------------------------------------------------------------------

def frozen(relative: str) -> Path:
    """A frozen file of the feature: features/review-panel-registry/<relative> while that folder exists, else the byte copy
    in testdata/judge/feature/ (the feature folders are removed once a feature is finished; FrozenCopyTests pins the copy)."""
    live = FEATURE / relative
    return live if live.exists() else TESTDATA / "feature" / relative


def example(name: str) -> dict:
    return json.loads(frozen(f"examples/{name}.example.json").read_text())


def literal(marker: str) -> dict:
    """A fenced JSON block of PRD Appendix B, by its `<!-- literal: <marker> -->` line ([L2])."""
    after = frozen("prd.md").read_text().split(f"<!-- literal: {marker} -->", 1)[1]
    return json.loads(after.split("```json\n", 1)[1].split("\n```", 1)[0])


def epoch(text: str) -> float:
    return datetime.fromisoformat(text.replace("Z", "+00:00")).timestamp()


def settled(record: dict) -> list[dict]:
    """What `panel.settle` returns for a record (design-challenge note 6): each `providers[]` entry plus `findings`, the
    panel findings whose ids are in its `finding_ids`, cut to exactly {id, severity, file, line, title, detail}."""
    entry = record["panels"][0]
    findings = {finding["id"]: finding for finding in entry["findings"]}
    return [{**provider, "findings": [{key: findings[i][key] for key in ("id", "severity", "file", "line", "title", "detail")}
                                      for i in provider["finding_ids"]]} for provider in entry["providers"]]


def reviewers_of(judge: dict) -> dict:
    """judge.run's `reviewers` argument that reproduces a judge object's reviewer inputs and reviewer_findings."""
    findings = {}
    for item in judge["reviewer_findings"]:
        findings.setdefault(item["reviewer"], []).append({"severity": item["severity"], "message": item["message"], "disposition": "open",
                                                          "worker": item["worker"], "requirement": None})
    return {entry["source"]: {"status": entry["status"], "findings": findings.get(entry["source"], [])}
            for entry in judge["inputs"] if entry["kind"] == "reviewer"}


def raw(rulings: list[dict]) -> list[dict]:
    """Recorded rulings back to the job's raw output: without the `id` and `worker` the code adds."""
    return [{key: value for key, value in ruling.items() if key not in ("id", "worker")} for ruling in rulings]


def shape(value):
    """Key sets and types only ([L6]): a dict's keys with each value's shape, a list's item shapes, a scalar's type name."""
    if isinstance(value, dict):
        return {key: shape(item) for key, item in value.items()}
    if isinstance(value, list):
        return [shape(item) for item in value]
    return type(value).__name__


class FrozenCopyTests(unittest.TestCase):
    def test_the_testdata_copies_equal_the_feature_files_while_the_feature_folder_exists(self):
        if not FEATURE.exists():
            self.skipTest("the feature folder is gone; the copies are the frozen files now")
        for relative in ("prd.md", *(f"examples/{name}.example.json" for name in ("judge-output", "panel-judged", "panel-fallback", "review-judged"))):
            with self.subTest(relative):
                self.assertEqual((TESTDATA / "feature" / relative).read_bytes(), (FEATURE / relative).read_bytes())


class LiteralTests(unittest.TestCase):
    """Appendix A's `judge.judged` port, the pending object, the settings and the job's output schema."""

    def test_judged_is_the_plans_one_panel_with_report_only_false_and_none_otherwise(self):
        from .judge import judged
        item = literal("plan-panel-judged")
        report_only = {**item, "report_only": True}
        self.assertIs(judged({"panels": [item]}), item)
        self.assertIsNone(judged({"panels": [report_only]}))  # A 2.6.0-2.11.0 report-only panel.
        self.assertIsNone(judged({}))  # A plan pinned before panels.
        self.assertIsNone(judged({"panels": None}))

    def test_pending_is_the_judge_states_pending_literal(self):
        from .judge import pending
        self.assertEqual(pending(literal("plan-panel-judged"), {}), literal("judge-states")["pending"])

    def test_settings_fill_every_default_and_the_effort_is_always_high(self):
        from .judge import settings
        plan = {"roles": {"worker": {"model": "w", "effort": "low"}, "judges": {"model": "judges-model", "effort": "low"}}}
        self.assertEqual(settings({"id": "review"}, plan),
                         {"model": "judges-model", "effort": "high", "timeout_minutes": 30, "budget_usd": 15, "input_cap_bytes": 600_000})
        self.assertEqual(settings(literal("plan-panel-judged"), plan), literal("plan-panel-judged")["judge"])

    def test_the_output_schema_has_an_object_root_and_takes_the_judge_output_example(self):
        from jsonschema import ValidationError, validate
        from .judge import output_schema
        schema, output = output_schema(), example("judge-output")
        self.assertEqual(schema["type"], "object")
        validate(output, schema)
        self.assertEqual(set(schema["properties"]["rulings"]["items"]["required"]), set(output["rulings"][0]))
        for bad in ({"rulings": [{**output["rulings"][0], "ruling": "dismissed"}]}, {"rulings": [{**output["rulings"][0], "severity": "P3"}]},
                    {"rulings": [{**output["rulings"][0], "extra": 1}]}, {"rulings": [{**output["rulings"][0], "sources": []}]}, []):
            with self.subTest(bad=bad), self.assertRaises(ValidationError):
                validate(bad, schema)


class CheckTests(unittest.TestCase):
    """PRD 7.3's output checks in code ([G32]), on the judge-output example's own values."""

    ENTRIES = [{"id": "general-1", "severity": "P2"}, {"id": "coverage-1", "severity": "P1"}, {"id": "C1", "severity": "P1"},
               {"id": "C2", "severity": "P2"}, {"id": "G1", "severity": "P0"}, {"id": "M1", "severity": "P1"}]
    OWNERS = {"workflow/panel.py": "engine", "workflow/judge.py": "engine", "tests/unit/panels.test.ts": "viewer"}

    def lane(self, file):
        return self.OWNERS.get(file, "none")

    def test_every_ruling_gets_its_j_id_in_output_order_and_the_lane_of_its_file(self):
        from .judge import check
        rulings, problem = check(example("judge-output")["rulings"], self.ENTRIES, self.lane)
        self.assertIsNone(problem)
        self.assertEqual([(r["id"], r["ruling"], r["worker"]) for r in rulings],
                         [("J1", "confirmed", "engine"), ("J2", "confirmed", "viewer"), ("J3", "refuted", "engine"), ("J4", "deferred", "none")])
        self.assertEqual(raw(rulings), example("judge-output")["rulings"])  # Nothing else is changed.

    def test_worker_follows_the_selected_lanes_owned_paths_and_is_none_without_an_owner(self):
        from .judge import worker_of
        runtime = SimpleNamespace(plan={}, workers=["engine", "viewer"], policy={"workers": [
            {"node_id": "engine", "owned_paths": ["workflow/panel.py", "workflow/judge"]}, {"node_id": "viewer", "owned_paths": ["tests/unit"]},
            {"node_id": "excluded", "owned_paths": ["docs"]}]})
        lane = worker_of(runtime)
        self.assertEqual([lane(file) for file in ("workflow/panel.py", "./workflow/judge/x.py", "tests/unit/a.test.ts", "workflow/panelx.py",
                                                   "docs/a.md", None, "", "(no file)")],
                         ["engine", "engine", "viewer", "none", "none", "none", "none", "none"])

    def test_a_missing_source_id_makes_the_judge_incomplete_with_the_judge_states_error(self):
        from .judge import FALLBACK, check
        incomplete = literal("judge-states")["incomplete"]
        ids = [i for entry in incomplete["inputs"] for i in entry["finding_ids"]]
        entries = [{"id": i, "severity": "P1"} for i in ids]
        ruling = {**example("judge-output")["rulings"][0], "sources": [i for i in ids if i not in ("G1", "M1")]}
        rulings, problem = check([ruling], entries, self.lane)
        self.assertEqual((rulings, f"{problem}; {FALLBACK}"), ([], incomplete["error"]))

    def test_a_duplicated_or_unknown_source_id_makes_the_judge_incomplete(self):
        from .judge import check
        first, second = example("judge-output")["rulings"][:2]
        entries = [{"id": "C1", "severity": "P1"}, {"id": "C2", "severity": "P2"}]
        self.assertEqual(check([{**first, "sources": ["C1", "C2"]}, {**second, "sources": ["C2"]}], entries, self.lane),
                         ([], "judge output incomplete: source ids in more than one ruling: C2"))
        self.assertEqual(check([{**first, "sources": ["C1", "C2", "X9"]}], entries, self.lane),
                         ([], "judge output incomplete: source ids unknown to the input: X9"))
        self.assertEqual(check([{**first, "sources": ["C1", "C1", "C2"]}], entries, self.lane)[1],
                         "judge output incomplete: source ids in more than one ruling: C1")

    def test_a_refuted_ruling_without_path_line_evidence_is_recorded_confirmed_at_the_highest_source_severity(self):
        from .judge import check
        refuted = example("judge-output")["rulings"][2]
        entries = [{"id": "C2", "severity": "P2"}, {"id": "G1", "severity": "P0"}, {"id": "M1", "severity": "P1"}]
        for evidence in ("", "The cited line is fine.", "judge.py", "line 88"):
            with self.subTest(evidence=evidence):
                rulings, problem = check([{**refuted, "sources": ["C2", "G1", "M1"], "severity": "P2", "evidence": evidence}], entries, self.lane)
                self.assertIsNone(problem)
                self.assertEqual((rulings[0]["ruling"], rulings[0]["severity"]), ("confirmed", "P0"))
                self.assertIn("must cite path:line evidence", rulings[0]["reason"])
        for evidence in ("workflow/judge.py:88", "see src/app.ts:120-131", "a.py:3"):
            rulings, _ = check([{**refuted, "sources": ["C2", "G1", "M1"], "evidence": evidence}], entries, self.lane)
            self.assertEqual((rulings[0]["ruling"], rulings[0]["severity"]), ("refuted", refuted["severity"]))


def git_run(repo: Path, *args: str) -> str:
    return subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True, text=True).stdout.strip()


def gone(pid: int) -> bool:
    try:
        status = Path(f"/proc/{pid}/status").read_text()
    except OSError:
        return True
    return bool(re.search(r"^State:\s+Z", status, re.M))


class JudgeRunHarness(unittest.TestCase):
    """judge.run over a toy repository (base, then a candidate that adds workflow/panel.py) and a run directory, with the fake
    judge job of testdata/judge/fake-judge.py, a fake clock and `panel.record_judge` patched in at its Appendix A signature
    (unless `real_ports`)."""

    real_ports = False

    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.repo = self.root / "repo"
        self.repo.mkdir()
        git_run(self.repo, "init", "-q", "-b", "main")
        git_run(self.repo, "config", "user.name", "Test")
        git_run(self.repo, "config", "user.email", "test@example.invalid")
        (self.repo / "app.txt").write_text("base\n")
        git_run(self.repo, "add", ".")
        git_run(self.repo, "commit", "-qm", "base")
        self.base = git_run(self.repo, "rev-parse", "HEAD")
        (self.repo / "workflow").mkdir()
        (self.repo / "workflow" / "panel.py").write_text("DIFF-MARKER = 1\n")
        git_run(self.repo, "add", ".")
        git_run(self.repo, "commit", "-qm", "candidate")
        self.candidate = git_run(self.repo, "rev-parse", "HEAD")
        self.directory = self.root / "run"
        self.directory.mkdir()
        save_json(self.directory / "review-bundle.json", {"run_id": "judge-test", "candidate_commit": self.candidate})
        (self.directory / "review.diff").write_text(git_run(self.repo, "diff", self.base, self.candidate) + "\n")
        (self.directory / "prd.copy.md").write_text("# PRD\nPRD-MARKER: the judge rules on every finding.\n")
        self.plan = {"run_id": "judge-test", "repository": str(self.repo), "base_commit": self.base, "workers": ["engine", "viewer"],
                     "prd": {"copy": "prd.copy.md", "path": "features/example/prd.md"},
                     "decisions": {"text": "# Decisions\n\n## Operator decisions\n\n- [O1] DECISIONS-MARKER\n"},
                     "roles": {"worker": {"model": "claude-opus-5-5", "effort": "medium"}, "judges": {"model": "claude-opus-5-5", "effort": "medium"}}}
        policy = {"workers": [{"node_id": "engine", "owned_paths": ["workflow/panel.py", "workflow/judge.py"]},
                              {"node_id": "viewer", "owned_paths": ["tests/unit"]}]}
        self.item = literal("plan-panel-judged")
        self.item["requirement_docs"] = {"features/example/prd.md": "# PRD\nPRD-MARKER: the judge rules on every finding.\n",
                                         "features/example/decisions.md": "REQ-DOC-MARKER\n"}
        self.scratch = self.root / "fakes"
        self.scratch.mkdir()
        shutil.copyfile(TESTDATA / "fake-judge.py", self.scratch / "fake-judge.py")
        self.executable = self.scratch / "claude"
        self.executable.write_text(f"#!/bin/sh\nexec {sys.executable} -I {self.scratch / 'fake-judge.py'} \"$@\"\n")
        self.executable.chmod(0o755)
        self.seen = self.scratch / "seen.json"
        self.runtime = SimpleNamespace(directory=self.directory, plan=self.plan, sessions=SimpleNamespace(executable=str(self.executable)),
                                       workers=["engine", "viewer"], policy=policy)
        self.records = []
        self.refuse = None  # A status whose record_judge write raises.

        def record_judge(runtime, panel_id: str, judge: dict) -> None:
            if judge["status"] == self.refuse:
                raise ValueError("judge object violates the panel record 1.1.0 schema")
            self.records.append((panel_id, copy.deepcopy(judge)))
        if not self.real_ports:
            port = patch("workflow.panel.record_judge", create=True, side_effect=record_judge)
            port.start()
            self.addCleanup(port.stop)
        self.now = epoch("2026-10-15T10:24:03Z")
        self.end = None  # With a value, the first sleep jumps the clock there.

    def control(self, **spec) -> None:
        (self.scratch / "judge-control.json").write_text(json.dumps({"seen": str(self.seen), "pid": str(self.scratch / "judge.pid"), **spec}))

    def clock(self) -> float:
        return self.now

    def sleep(self, seconds: float) -> None:
        self.now = self.end if self.end is not None else self.now + seconds
        time.sleep(0.05)

    def runs(self) -> list:
        return json.loads(self.seen.read_text()) if self.seen.exists() else []

    def run_judge(self, seats: list, reviewers: dict, *, session: str | None = None, sleep=None) -> dict:
        from . import judge
        with patch("workflow.judge.uuid.uuid4", return_value=uuid.UUID(session or "5f0c2a8e-7d4b-4f1e-9a63-2b8d1c0e4f71")):
            return judge.run(self.runtime, self.item, seats, reviewers, clock=self.clock, sleep=sleep or self.sleep)

    def worktrees(self) -> str:
        return git_run(self.repo, "worktree", "list", "--porcelain")

    def small(self) -> tuple[list, dict]:
        seats = [{"name": "claude", "prefix": "C", "status": "ok", "finding_ids": ["C1"],
                  "findings": [{"id": "C1", "severity": "P1", "file": "workflow/panel.py", "line": 1, "title": "SEAT-TITLE", "detail": "SEAT-DETAIL"}]}]
        reviewers = {"general": {"status": "blocked", "findings": [{"severity": "P1", "message": "REVIEWER-MESSAGE", "disposition": "open",
                                                                    "worker": "engine", "requirement": None}]},
                     "coverage": {"status": "approved", "findings": []}}
        return seats, reviewers


class JudgeRunTests(JudgeRunHarness):
    def test_a_judged_job_records_the_panel_judged_examples_judge_object(self):
        judged = example("panel-judged")
        expected = judged["panels"][0]["judge"]
        self.control(rulings=raw(expected["rulings"]), cost=expected["cost_usd"], delay=0.3)
        self.now, self.end = epoch(expected["started_at"]), epoch(expected["ended_at"])
        result = self.run_judge(settled(judged), reviewers_of(expected), session=expected["session_id"])
        self.assertEqual(result, expected)
        self.assertEqual([(panel_id, judge["status"]) for panel_id, judge in self.records], [("review", "running"), ("review", "judged")])
        self.assertEqual(self.records[-1][1], expected)
        self.assertIs(result["fallback"], False)

    def test_the_running_and_incomplete_records_are_the_judge_states_literals(self):
        states = literal("judge-states")
        running, incomplete = states["running"], states["incomplete"]
        seats = [{"name": entry["source"], "status": entry["status"],
                  "findings": [{"id": i, "severity": "P1", "file": "workflow/panel.py", "line": 1, "title": f"title {i}", "detail": f"detail {i}"}
                               for i in entry["finding_ids"]]} for entry in running["inputs"] if entry["kind"] == "seat"]
        ruling = {**example("judge-output")["rulings"][0], "sources": ["general-1", "coverage-1", "C1", "C2"]}  # G1 and M1 left out.
        self.control(rulings=[ruling], cost=incomplete["cost_usd"], delay=0.3)
        self.now, self.end = epoch(incomplete["started_at"]), epoch(incomplete["ended_at"])
        result = self.run_judge(seats, reviewers_of(running), session=running["session_id"])
        self.assertEqual(self.records[0][1], running)
        self.assertEqual(result, incomplete)
        self.assertEqual(self.records[-1][1], incomplete)

    def test_a_timed_out_job_records_the_panel_fallback_examples_judge_object_and_its_group_is_killed(self):
        fallback = example("panel-fallback")
        expected = fallback["panels"][0]["judge"]
        self.control(hang=True)
        self.now = epoch(expected["started_at"])
        ticks = []

        def sleep(seconds):
            ticks.append(seconds)
            if (self.scratch / "judge.pid").exists():  # The clock runs only once the job is up, so the kill finds it running.
                self.now += 600
            time.sleep(0.05)
        result = self.run_judge(settled(fallback), reviewers_of(expected), sleep=sleep)
        self.assertEqual(result, expected)
        self.assertEqual(self.records[-1][1], expected)
        pid = int((self.scratch / "judge.pid").read_text())
        self.assertTrue(gone(pid))
        self.assertFalse(Path(self.runs()[0]["cwd"]).exists())
        self.assertNotIn(self.runs()[0]["cwd"], self.worktrees())

    def test_the_job_is_a_read_only_high_effort_print_job_with_its_input_on_stdin_in_its_own_worktree(self):
        seats, reviewers = self.small()
        self.control(auto="confirmed", delay=0.2)
        result = self.run_judge(seats, reviewers, session="11111111-2222-4333-8444-555566667777")
        self.assertEqual(result["status"], "judged")
        [seen] = self.runs()
        argv = seen["argv"]
        flag = lambda name: argv[argv.index(name) + 1]  # noqa: E731
        self.assertEqual((flag("--model"), flag("--effort"), flag("--max-budget-usd"), flag("--tools"), flag("--permission-mode")),
                         ("claude-opus-5-5", "high", "15", "Read,Glob,Grep", "dontAsk"))  # The judges' pinned effort is medium here.
        self.assertIn("--safe-mode", argv)
        self.assertIn("--strict-mcp-config", argv)
        self.assertNotIn("--add-dir", argv)
        self.assertEqual((flag("--print"), flag("--session-id")), ("--output-format", "11111111-2222-4333-8444-555566667777"))
        self.assertEqual(result["session_id"], "11111111-2222-4333-8444-555566667777")
        # The prompt goes on stdin; argv carries none of it.
        from .judge import BRIEF
        brief_start = BRIEF.read_text().split(".")[0]
        joined = " ".join(argv)
        for marker in (brief_start, "REVIEWER-MESSAGE", "SEAT-DETAIL", "PRD-MARKER", "DECISIONS-MARKER", "DIFF-MARKER"):
            self.assertNotIn(marker, joined)
            self.assertIn(marker, seen["stdin"])
        self.assertIn("REQ-DOC-MARKER", seen["stdin"])
        self.assertEqual((self.directory / "judge" / "judge-1.input.txt").read_text(), seen["stdin"])
        self.assertEqual((self.directory / "judge" / "judge-1.input.txt").stat().st_mode & 0o777, 0o600)
        # Its cwd: a throwaway worktree of the candidate, outside the run directory and ~/dev, removed after.
        cwd = Path(seen["cwd"])
        self.assertEqual(seen["head"], self.candidate)
        self.assertFalse(cwd.is_relative_to(self.directory))
        self.assertFalse(cwd.is_relative_to(Path.home() / "dev"))
        self.assertTrue(cwd.name.startswith("review-judge-"))
        self.assertFalse(cwd.exists())
        self.assertNotIn(str(cwd), self.worktrees())
        self.assertNotEqual(seen["pgid"], os.getpgid(0))  # Its own process group.

    def test_the_input_holds_every_finding_with_its_id_source_and_place(self):
        seats, reviewers = self.small()
        reviewers["coverage"]["findings"] = [{"severity": "P2", "message": "x" * 5000, "disposition": "open", "worker": "viewer", "requirement": "REQ"}]
        self.control(auto="confirmed")
        self.run_judge(seats, reviewers)
        stdin = self.runs()[0]["stdin"]
        block = stdin.split("=== FINDINGS (3; rule on every id exactly once) ===\n", 1)[1].split("\n\n=== ", 1)[0]
        lines = [json.loads(line) for line in block.splitlines()]
        self.assertEqual([(line["id"], line["source"], line["kind"], line["severity"]) for line in lines],
                         [("general-1", "general", "reviewer", "P1"), ("coverage-1", "coverage", "reviewer", "P2"), ("C1", "claude", "seat", "P1")])
        self.assertEqual((lines[2]["file"], lines[2]["line"], lines[2]["title"], lines[2]["detail"]), ("workflow/panel.py", 1, "SEAT-TITLE", "SEAT-DETAIL"))
        self.assertEqual(len(lines[1]["message"]), 2000)  # Cut to 2,000 characters.
        self.assertEqual(lines[1]["requirement"], "REQ")
        labels = re.findall(r"^=== (.+) ===$", stdin, re.M)
        self.assertEqual(labels[1:], ["the candidate diff (the run's base to the candidate)", "the PRD, features/example/prd.md", "decisions.md",
                                      "requirement document features/example/decisions.md"])  # The PRD's copy is given once.

    def test_documents_are_cut_to_the_cap_and_findings_over_it_run_no_job(self):
        from .judge import OVER_CAP, build_input
        seats, reviewers = self.small()
        (self.directory / "review.diff").write_text("+" + "d" * 50_000 + "\n")
        cap = 20_000
        self.item["judge"]["input_cap_bytes"] = cap
        self.control(auto="confirmed")
        self.run_judge(seats, reviewers)
        stdin = self.runs()[0]["stdin"]
        self.assertLessEqual(len(stdin.encode()), cap)
        self.assertIn("=== truncated: kept ", stdin)
        self.assertIn("SEAT-DETAIL", stdin)
        self.assertEqual(self.item["judge"]["input_cap_bytes"], cap)
        # The default cap is 600 KB; findings that alone exceed the cap start no job, and today's rule decides.
        self.assertEqual(literal("plan-panel-judged")["judge"]["input_cap_bytes"], 600_000)
        many = {"general": {"status": "blocked", "findings": [{"severity": "P1", "message": "m" * 1900, "disposition": "open", "worker": "engine",
                                                               "requirement": None} for _ in range(12)]}}
        self.seen.unlink()
        self.records.clear()
        result = self.run_judge(seats, many)
        self.assertFalse(self.seen.exists())  # No job.
        self.assertEqual((result["status"], result["fallback"], result["session_id"], result["rulings"]), ("failed", True, None, []))
        self.assertTrue(result["error"].startswith(OVER_CAP), result["error"])
        self.assertEqual([judge["status"] for _, judge in self.records], ["failed"])
        with self.assertRaises(ValueError):
            build_input(self.runtime, self.item, [{"id": "C1", "detail": "y" * cap}], cap)

    def test_a_large_diff_never_costs_the_requirements_and_every_cut_document_is_named(self):
        from .judge import DIFF_LABEL, build_input
        (self.directory / "review.diff").write_text("+DIFF-MARKER " + "d" * 500_000 + "\n")
        cap = 20_000
        stdin = build_input(self.runtime, self.item, [{"id": "C1", "detail": "SEAT-DETAIL"}], cap)
        self.assertLessEqual(len(stdin.encode()), cap)
        for marker in ("SEAT-DETAIL", "DIFF-MARKER", "PRD-MARKER", "DECISIONS-MARKER", "REQ-DOC-MARKER"):
            self.assertIn(marker, stdin)
        self.assertIn(f"of 500014 bytes of {DIFF_LABEL}; the candidate's files are in your worktree ===", stdin)
        # Requirements over the room: they keep at least half of it, the diff the rest, and a document with no room is named.
        self.item["requirement_docs"] = {"features/example/big.md": "BIG-DOC " + "r" * 500_000, "features/example/tail.md": "TAIL-DOC " + "t" * 500_000}
        stdin = build_input(self.runtime, self.item, [{"id": "C1", "detail": "SEAT-DETAIL"}], cap)
        self.assertLessEqual(len(stdin.encode()), cap)
        for marker in ("DIFF-MARKER", "PRD-MARKER", "DECISIONS-MARKER", "BIG-DOC"):
            self.assertIn(marker, stdin)
        self.assertIn("=== omitted: requirement document features/example/tail.md, 500009 bytes, over the input cap ===", stdin)
        diff = stdin.split(f"=== {DIFF_LABEL} ===\n", 1)[1].split("\n=== truncated: ", 1)[0]
        self.assertGreater(len(diff), 5_000)
        self.assertLess(len(diff), cap // 2)

    def test_a_failed_job_or_malformed_output_falls_back_and_removes_the_worktree(self):
        seats, reviewers = self.small()
        cases = [({"auto": "confirmed", "exit": 1}, "failed", "judge job failed (exit 1"),
                 ({"output": "not json"}, "failed", "judge job failed (exit 0): its output is not JSON"),
                 ({"rulings": [{"ruling": "dismissed"}]}, "incomplete", "judge output malformed: "),
                 ({"output": json.dumps({"session_id": "other", "is_error": False, "subtype": "success", "structured_output": {"rulings": []}})},
                  "failed", "judge job failed (exit 0")]
        for spec, status, error in cases:
            with self.subTest(spec=spec):
                self.records.clear()
                self.seen.unlink(missing_ok=True)
                self.control(**spec)
                result = self.run_judge(seats, reviewers)
                self.assertEqual((result["status"], result["fallback"], result["rulings"]), (status, True, []))
                self.assertTrue(result["error"].startswith(error), result["error"])
                self.assertTrue(result["error"].endswith("the panel findings stay unjudged"), result["error"])
                self.assertEqual([judge["status"] for _, judge in self.records], ["running", status])
                self.assertFalse(Path(self.runs()[0]["cwd"]).exists())

    def test_ctrl_c_during_the_job_kills_its_group_removes_its_worktree_and_leaves_the_record_running(self):
        seats, reviewers = self.small()
        self.control(hang=True)

        def interrupted(seconds):
            if (self.scratch / "judge.pid").exists():
                raise KeyboardInterrupt
            time.sleep(0.05)
        with self.assertRaises(KeyboardInterrupt):
            self.run_judge(seats, reviewers, sleep=interrupted)
        self.assertTrue(gone(int((self.scratch / "judge.pid").read_text())))
        self.assertFalse(Path(self.runs()[0]["cwd"]).exists())
        self.assertEqual([judge["status"] for _, judge in self.records], ["running"])  # Non-terminal: a resume reruns it.

    def test_a_group_member_that_ignores_sigterm_is_killed_when_the_leader_exits_on_it(self):
        """PRD 7.6: on a timeout or Ctrl-C nothing of the judge's group outlives it, even a child that ignores SIGTERM."""
        seats, reviewers = self.small()
        for path in ("timeout", "interrupt"):
            with self.subTest(path):
                child = self.scratch / f"child-{path}.pid"
                self.control(hang=True, stubborn_child=str(child))
                (self.scratch / "judge.pid").unlink(missing_ok=True)
                self.seen.unlink(missing_ok=True)

                def survivor(child=child):
                    if child.exists() and child.read_text() and not gone(int(child.read_text())):  # Never a pid already gone.
                        try:
                            os.kill(int(child.read_text()), signal.SIGKILL)
                        except ProcessLookupError:
                            pass
                self.addCleanup(survivor)

                def sleep(seconds, path=path):
                    if (self.scratch / "judge.pid").exists():  # The child is up before the leader writes its pid.
                        if path == "interrupt":
                            raise KeyboardInterrupt
                        self.now += 600
                    time.sleep(0.05)
                if path == "interrupt":
                    with self.assertRaises(KeyboardInterrupt):
                        self.run_judge(seats, reviewers, sleep=sleep)
                else:
                    self.assertEqual(self.run_judge(seats, reviewers, sleep=sleep)["status"], "timed_out")
                pid = int(child.read_text())
                deadline = time.monotonic() + 10  # Generous for a loaded host; a pass returns at once.
                while not gone(pid) and time.monotonic() < deadline:
                    time.sleep(0.05)
                self.assertTrue(gone(pid))
                self.assertFalse(Path(self.runs()[0]["cwd"]).exists())

    def test_a_transient_infrastructure_error_is_raised_and_leaves_the_record_running(self):
        from .sessions import TransientInfraError
        seats, reviewers = self.small()
        self.control(auto="confirmed")
        with patch("workflow.judge.popen_claude", side_effect=TransientInfraError("claude is being updated")), self.assertRaises(TransientInfraError):
            self.run_judge(seats, reviewers)
        self.assertEqual([judge["status"] for _, judge in self.records], ["running"])
        self.assertEqual(self.worktrees().count("worktree "), 1)  # Only the repository itself.

    def test_any_other_failure_never_raises(self):
        seats, reviewers = self.small()
        self.control(auto="confirmed")
        with patch("workflow.judge.popen_claude", side_effect=OSError("exec failed")):
            result = self.run_judge(seats, reviewers)
        self.assertEqual((result["status"], result["fallback"]), ("failed", True))
        self.assertIn("OSError: exec failed", result["error"])
        self.assertEqual(self.worktrees().count("worktree "), 1)
        self.records.clear()
        self.refuse = "running"  # The port refuses the record: the judge fails, the review step goes on.
        result = self.run_judge(seats, reviewers)
        self.assertEqual((result["status"], result["fallback"]), ("failed", True))
        self.assertIn("judge record refused: ValueError", result["error"])
        self.refuse = "judged"
        self.records.clear()
        result = self.run_judge(seats, reviewers)
        self.assertEqual((result["status"], result["fallback"], result["rulings"]), ("failed", True, []))
        self.assertEqual([judge["status"] for _, judge in self.records], ["running", "failed"])

    def test_an_orphan_job_from_a_crashed_controller_is_killed_and_its_worktree_removed_before_the_rerun(self):
        seats, reviewers = self.small()
        orphan = self.root / "orphan-worktree"
        git_run(self.repo, "worktree", "add", "--detach", str(orphan), self.candidate)
        process = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)", "--session-id", "orphan-session"], cwd=orphan,
                                   start_new_session=True)
        self.addCleanup(lambda: process.poll() is None and os.killpg(process.pid, signal.SIGKILL))
        (self.directory / "judge").mkdir()
        save_json(self.directory / "judge" / "judge-1.pid", {"pid": process.pid, "cwd": str(orphan.resolve()), "marker": "--session-id orphan-session",
                                                             "worktree": str(orphan.resolve())})
        self.control(auto="confirmed")
        result = self.run_judge(seats, reviewers)
        self.assertEqual(result["status"], "judged")
        self.assertIsNotNone(process.wait(timeout=10))
        self.assertFalse(orphan.exists())
        self.assertTrue((self.directory / "judge" / "judge-2.input.txt").exists())  # The rerun's own numbered files.


    def test_a_crash_before_the_pid_is_written_still_leaves_the_job_and_its_worktree_to_the_rerun(self):
        seats, reviewers = self.small()
        orphan = self.root / "orphan-worktree"
        git_run(self.repo, "worktree", "add", "--detach", str(orphan), self.candidate)
        process = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)", "--session-id", "early-session"], cwd=orphan,
                                   start_new_session=True)
        self.addCleanup(lambda: process.poll() is None and os.killpg(process.pid, signal.SIGKILL))
        (self.directory / "judge").mkdir()
        # The record a crash between the worktree's creation and the launch leaves: no pid yet, only the worktree and the marker.
        save_json(self.directory / "judge" / "judge-1.pid", {"pid": None, "cwd": str(orphan.resolve()), "marker": "--session-id early-session",
                                                             "worktree": str(orphan.resolve())})
        self.control(auto="confirmed")
        result = self.run_judge(seats, reviewers)
        self.assertEqual(result["status"], "judged")
        self.assertIsNotNone(process.wait(timeout=10))
        self.assertFalse(orphan.exists())
        self.assertEqual(self.worktrees().count("worktree "), 1)

    def test_the_pid_file_names_the_worktree_and_marker_before_the_worktree_is_added(self):
        seats, reviewers = self.small()
        self.control(auto="confirmed")
        from . import worktrees
        seen = []
        real = worktrees.git_worktree

        def spy(repository, *args):
            if args[:1] == ("add",):
                seen.append(read_json(self.directory / "judge" / "judge-1.pid"))
            return real(repository, *args)
        with patch.object(worktrees, "git_worktree", spy):
            result = self.run_judge(seats, reviewers)
        self.assertEqual(result["status"], "judged")
        self.assertEqual(len(seen), 1)
        self.assertIsNone(seen[0]["pid"])
        self.assertEqual(seen[0]["marker"], f"--session-id {result['session_id']}")
        self.assertEqual(seen[0]["cwd"], seen[0]["worktree"])
        self.assertIsInstance(read_json(self.directory / "judge" / "judge-1.pid")["pid"], int)


class ReviewJsonTests(unittest.TestCase):
    """PRD 7.4: review.json of a judged run, from the panel-judged example's judge object; review-judged by key sets and types."""

    def state(self, verdicts: dict):
        from .automatic import ReviewStatus
        statuses = {rid: {"reviewer_id": rid, "session_id": f"0a1b2c3d-{n}111-4222-8333-444455556666", "accepted_at": "2026-10-15T10:14:02Z",
                          "status": "accepted"} for n, rid in enumerate(verdicts, 1)}
        runtime = SimpleNamespace(plan={"run_id": "example-001"}, directory=Path("/nonexistent"))
        return runtime, ReviewStatus(runtime, {}, statuses)

    def decision(self, verdict: str, severity: str):
        return {"verdict": verdict, "findings": [{"severity": severity, "message": "Built-in finding.", "disposition": "open", "worker": "engine",
                                                  "requirement": None}]}

    def combined(self, judge, decisions=None, crit=None):
        from .automatic import combined_review
        decisions = decisions or {"general": self.decision("blocked", "P1"), "coverage": self.decision("blocked", "P1")}
        runtime, state = self.state(decisions)
        bundle = {"run_id": "example-001", "candidate_commit": "9b2e4c6a8d0f1b3e5c7a9d1f3b5e7c9a1d3f5b7e"}
        with patch("workflow.critique.review_entry", return_value=crit):
            return combined_review(runtime, bundle, "3f1c" + "0" * 60, state, decisions, judge)

    def test_a_judged_review_has_the_review_judged_examples_shape_and_the_judge_decides(self):
        judge = example("panel-judged")["panels"][0]["judge"]
        review = self.combined(judge)
        target = example("review-judged")
        self.assertEqual(shape(review), shape(target))  # [L6]: key sets and types only across examples.
        self.assertEqual([(e["reviewer_id"], e["verdict"]) for e in review["reviewers"]], [("general", "blocked"), ("coverage", "blocked"), ("judge", "blocked")])
        self.assertEqual((review["reviewers"][2]["session_id"], review["reviewers"][2]["accepted_at"]), (judge["session_id"], judge["ended_at"]))
        self.assertEqual(review["reviewer"].split(", ")[-1], judge["session_id"])
        self.assertEqual(review["verdict"], "blocked")
        # The confirmed rulings only (J1 P1, J2 P2), tagged judge, open, with their lane; J3 refuted and J4 deferred stay in panel.json.
        self.assertEqual([(f["severity"], f["reviewer"], f["disposition"], f["worker"], f["message"].split("]")[0]) for f in review["findings"]],
                         [("P1", "judge", "open", "engine", "[J1 from general-1, C1, M1"), ("P2", "judge", "open", "viewer", "[J2 from coverage-1")])
        self.assertEqual(review["findings"][0]["requirement"], judge["rulings"][0]["requirement"])
        self.assertNotIn("requirement", review["findings"][1])  # Only when given.
        self.assertEqual(review["findings"][0]["message"], f"[J1 from general-1, C1, M1] {judge['rulings'][0]['title']} (workflow/panel.py:212): "
                                                           f"{judge['rulings'][0]['detail']}")
        self.assertEqual(review["findings"][1]["message"], f"[J2 from coverage-1] {judge['rulings'][1]['title']} (tests/unit/panels.test.ts): "
                                                           f"{judge['rulings'][1]['detail']}")
        # The example's own messages follow the same form.
        for finding in target["findings"]:
            self.assertRegex(finding["message"], r"^\[J\d+ from [^\]]+\] .+ \([^)]+\): .+$")

    def test_the_message_form(self):
        from .judge import message
        ruling = {"id": "J3", "sources": ["C1", "general-2"], "title": "T", "detail": "D", "file": "a.py", "line": 4}
        self.assertEqual(message(ruling), "[J3 from C1, general-2] T (a.py:4): D")
        self.assertEqual(message({**ruling, "line": None}), "[J3 from C1, general-2] T (a.py): D")
        self.assertEqual(message({**ruling, "file": None, "line": None}), "[J3 from C1, general-2] T: D")

    def test_a_built_in_block_does_not_block_a_judge_approval_and_critique_still_blocks_on_its_own(self):
        judge = copy.deepcopy(example("panel-judged")["panels"][0]["judge"])
        judge["rulings"] = [ruling for ruling in judge["rulings"] if ruling["severity"] == "P2" or ruling["ruling"] != "confirmed"]
        review = self.combined(judge)
        self.assertEqual((review["verdict"], [e["verdict"] for e in review["reviewers"]]), ("approved", ["blocked", "blocked", "approved"]))
        self.assertEqual([f["severity"] for f in review["findings"]], ["P2"])
        crit = {"reviewer_id": "critique", "session_id": "c0c0c0c0-1111-4222-8333-444455556666", "verdict": "blocked", "accepted_at": "2026-10-15T10:40:00Z",
                "findings": [{"severity": "P1", "message": "The banner overlaps.", "disposition": "open", "worker": "viewer", "requirement": None,
                              "reviewer": "critique"}]}
        review = self.combined(judge, crit=crit)
        self.assertEqual((review["verdict"], [e["reviewer_id"] for e in review["reviewers"]]), ("blocked", ["general", "coverage", "judge", "critique"]))
        self.assertEqual([f["reviewer"] for f in review["findings"]], ["judge", "critique"])

    def test_a_judge_that_fell_back_leaves_todays_review_byte_for_byte(self):
        fallback = example("panel-fallback")["panels"][0]["judge"]
        decisions = {"general": self.decision("approved", "P1"), "coverage": self.decision("approved", "P2")}
        self.assertEqual(json.dumps(self.combined(fallback, decisions)), json.dumps(self.combined(None, decisions)))
        self.assertEqual(self.combined(fallback, decisions)["verdict"], "blocked")  # A built-in P1 blocks directly again ([G10]).


class ValidatorTests(unittest.TestCase):
    """PRD 7.4: check_review/check_reviewers keep their signatures; the judged rule needs the judged-plan context."""

    def setUp(self):
        self.review = example("review-judged")
        self.bundle = {"run_id": self.review["run_id"], "candidate_commit": self.review["candidate_commit"],
                       "snapshots": {"engine": {"session_id": "e0e0e0e0-0000-4000-8000-000000000000"}, "viewer": {"session_id": "f0f0f0f0-0000-4000-8000-000000000000"}}}
        self.digest = self.review["bundle_sha256"]

    def check(self, review, **keys):
        from .pipeline import check_review
        check_review(review, self.bundle, self.digest, **keys)

    def approved(self) -> dict:
        """The example with its judge approving (its J2 P2 finding only); the built-in entries still read blocked."""
        review = copy.deepcopy(self.review)
        review["reviewers"][2]["verdict"] = "approved"
        review.update(verdict="approved", findings=[finding for finding in review["findings"] if finding["severity"] == "P2"])
        return review

    def test_the_signatures_are_unchanged_but_for_an_optional_keyword(self):
        import inspect
        from .pipeline import check_review, check_reviewers
        self.assertEqual(list(inspect.signature(check_reviewers).parameters)[:5], ["entries", "worker_ids", "declared", "verdict", "require_approved"])
        for function in (check_review, check_reviewers):
            parameter = inspect.signature(function).parameters["judged"]
            self.assertEqual((parameter.kind, parameter.default), (inspect.Parameter.KEYWORD_ONLY, False))

    def test_the_review_judged_example_passes_only_with_judged_plan_context(self):
        self.check(self.review, require_approved=False, judged=True)
        self.check(self.review, require_approved=False, judged=True, reviewers=["general", "coverage", "judge"])
        for keys in ({}, {"reviewers": ["general", "coverage", "judge"]}):  # Legacy, report-only or missing context: judged=False.
            with self.subTest(keys=keys), self.assertRaisesRegex(ValueError, "reserved reviewer judge"):
                self.check(self.review, require_approved=False, **keys)

    def test_a_built_in_block_does_not_block_a_judge_approved_record(self):
        review = self.approved()
        self.check(review, judged=True)  # require_approved: the judge's approval is the one that counts.
        self.check(review, judged=True, reviewers=["general", "coverage", "judge"])
        with self.assertRaises(ValueError):
            self.check(review)
        with self.assertRaisesRegex(ValueError, "judge's approval"):
            self.check({**review, "reviewers": [*review["reviewers"][:2], {**review["reviewers"][2], "verdict": "blocked"}]}, require_approved=False, judged=True)

    def test_an_approved_judged_record_with_an_open_p1_or_a_built_in_finding_is_refused(self):
        review = self.approved()
        with self.assertRaisesRegex(ValueError, "Unresolved blocking"):
            self.check({**review, "findings": self.review["findings"]}, require_approved=False, judged=True)
        builtin = {"severity": "P2", "message": "Built-in.", "disposition": "open", "worker": "engine", "reviewer": "general"}
        with self.assertRaisesRegex(ValueError, "judge's and critique's only"):
            self.check({**review, "findings": [builtin]}, require_approved=False, judged=True)
        with self.assertRaisesRegex(ValueError, "needs a blocking judge or critique"):
            self.check({**review, "verdict": "blocked"}, require_approved=False, judged=True)

    def test_critique_still_blocks_on_its_own(self):
        review = self.approved()
        review["reviewers"].append({"reviewer_id": "critique", "session_id": "c0c0c0c0-1111-4222-8333-444455556666", "verdict": "blocked",
                                    "accepted_at": "2026-10-15T10:40:00Z"})
        with self.assertRaisesRegex(ValueError, "judge's approval"):
            self.check(review, require_approved=False, judged=True)
        self.check({**review, "verdict": "blocked"}, require_approved=False, judged=True)
        with self.assertRaisesRegex(ValueError, "not approved"):
            self.check({**review, "verdict": "blocked"}, judged=True)

    def test_a_record_without_judge_is_checked_as_today_with_or_without_the_context(self):
        review = copy.deepcopy(self.review)
        review["reviewers"] = review["reviewers"][:2]
        review["reviewer"] = ", ".join(entry["session_id"] for entry in review["reviewers"])
        review["findings"] = [{**finding, "reviewer": "general"} for finding in review["findings"]]
        for judged in (False, True):
            self.check(review, require_approved=False, judged=judged)
            with self.assertRaisesRegex(ValueError, "every reviewer's approval"):
                self.check({**review, "verdict": "approved", "findings": []}, require_approved=False, judged=judged)


class JudgedWaitTests(unittest.TestCase):
    """PRD 7.2 on the native transport, on a fake clock: on a judged run no block decides early and there is no grace; every
    reviewer is waited for to its verdict or its failure, which is recorded; with no verdict at all the step fails as today."""

    reviewers = ["general", "coverage"]
    ids = test_automatic.ReviewCompletionTests.ids
    node, token, uuid = (test_automatic.ReviewCompletionTests.node, test_automatic.ReviewCompletionTests.token,
                         test_automatic.ReviewCompletionTests.uuid)
    reviewer_of, completion, write = (test_automatic.ReviewCompletionTests.reviewer_of, test_automatic.ReviewCompletionTests.completion,
                                      test_automatic.ReviewCompletionTests.write)
    TOKEN = test_automatic.ReviewCompletionTests.TOKEN
    setUp = test_automatic.ReviewCompletionTests.setUp
    P1 = [{"severity": "P1", "message": "The retry loop never ends.", "disposition": "open", "worker": "adapter", "requirement": None}]

    def status(self, reviewer_id):
        return read_json(self.root / f"automatic-{self.node(reviewer_id)}.json")

    def wait(self, sleep, clock=None):
        from .automatic import wait_reviews
        self.now = 0.0
        return wait_reviews(self.runtime, clock=clock or (lambda: self.now), sleep=sleep, judged=True)

    def test_a_first_block_does_not_decide_and_the_other_reviewer_is_awaited_to_its_verdict(self):
        self.write("coverage", verdict="blocked", findings=self.P1)
        self.rows["general"]["state"] = "working"
        polls = []

        def sleep(seconds):
            polls.append(seconds)
            self.now += 300
            if len(polls) == 3:  # Fifteen minutes on, general's turn ends with its approval.
                self.write("general")
                self.rows["general"]["state"] = "idle"
        decisions = self.wait(sleep)
        self.assertEqual(sorted(decisions), ["coverage", "general"])
        self.assertEqual(len(polls), 3)
        self.assertEqual([self.status(rid)["status"] for rid in self.ids], ["accepted", "accepted"])
        self.assertFalse(any(self.status(rid).get("late") for rid in self.ids))
        self.assertFalse([e for e in self.events if "blocked the candidate" in e[2]])  # No grace announced.

    def test_a_reviewer_past_its_deadline_is_recorded_and_the_others_verdicts_returned(self):
        self.write("coverage", verdict="blocked", findings=self.P1)
        self.rows["general"]["state"] = "working"

        def sleep(seconds):
            self.now += 600
        decisions = self.wait(sleep)
        self.assertEqual(list(decisions), ["coverage"])
        self.assertEqual((self.status("general")["status"], self.status("general")["error"]),
                         ("blocked", "Reviewer general deadline exhausted; no second reviewer is launched"))
        self.assertIn(("review", "note", "Reviewer general gave no verdict: Reviewer general deadline exhausted; no second reviewer is launched; "
                                         "the judge rules on the others' findings"), self.events)

    def test_a_refused_file_or_a_missing_session_is_recorded_and_the_wait_goes_on(self):
        self.write("general", launch_token="00000000-0000-4000-8000-000000000000")  # Bound to another launch: refused.
        self.write("coverage", verdict="blocked", findings=self.P1)
        decisions = self.wait(lambda seconds: self.fail("Unexpected wait"))
        self.assertEqual(list(decisions), ["coverage"])
        self.assertIn("Stale or foreign review completion signal (general)", self.status("general")["error"])
        del self.rows["general"]
        (self.root / "review-general.completion.json").unlink()
        save_json(self.root / "automatic-review-general.json", {**self.status("general"), "status": "running", "error": None})
        decisions = self.wait(lambda seconds: self.fail("Unexpected wait"))
        self.assertEqual(list(decisions), ["coverage"])
        self.assertEqual(self.status("general")["error"], "Native reviewer general missing; reconciliation required")

    def test_no_built_in_verdict_at_all_fails_the_step_as_today(self):
        self.rows["general"]["state"] = self.rows["coverage"]["state"] = "working"

        def sleep(seconds):
            self.now += 900
        with self.assertRaisesRegex(RuntimeError, "Reviewer general deadline exhausted; no second reviewer is launched"):
            self.wait(sleep)
        self.assertEqual([self.status(rid)["status"] for rid in self.ids], ["blocked", "blocked"])


class JudgedCollectTests(unittest.TestCase):
    """PRD 7.2 on the print transport, on a fake clock: every job is read at its exit or stopped at its own deadline; a failure
    is recorded and never raised unless no job gave a verdict; no verdict is late."""

    P1 = test_automatic.PrintCollectionTests.P0 | {"severity": "P1"}

    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.now, self.events, self.terminated = 0.0, [], []

    def collect(self, jobs: dict):
        from .automatic import ReviewStatus, collect_print
        from .sessions import review_node
        plan = {"run_id": "test", "source_branch": "feature/test", "automatic": dict(test_automatic.DEFAULTS, reviewer_transport="print"),
                "reviewers": [{"reviewer_id": reviewer_id, "prompt": f"Check {reviewer_id}."} for reviewer_id in jobs]}
        runtime = SimpleNamespace(directory=self.root, plan=plan, event=lambda node, status, message: self.events.append((node, status, message)))
        statuses, processes = {}, {}
        for n, (reviewer_id, (exits_at, output, *code)) in enumerate(jobs.items()):
            session = f"{n + 1:08d}-4444-4444-8444-444444444444"
            statuses[reviewer_id] = {"reviewer_id": reviewer_id, "node_id": review_node(reviewer_id), "transport": "print", "session_id": session, "status": "running"}
            save_json(self.root / f"{review_node(reviewer_id)}.stdout.json", {"session_id": session, "is_error": False, "subtype": "success", "structured_output": output})
            processes[reviewer_id] = (test_automatic.FakeJob(self, exits_at, *code), 0.0)
        self.state = state = ReviewStatus(runtime, {"transport": "print", "status": "running", "reviewers": list(jobs)}, statuses)
        with patch("workflow.automatic.time", SimpleNamespace(monotonic=lambda: self.now, time=lambda: self.now)), \
                patch("workflow.automatic.terminate", side_effect=self.terminated.append):
            collect_print(runtime, state, processes, test_automatic.DEFAULTS["review_timeout_seconds"], judged=True)
        return state

    def test_a_first_block_does_not_decide_and_a_later_job_is_read_on_time_not_late(self):
        state = self.collect({"general": (60, {"verdict": "blocked", "findings": [self.P1]}), "coverage": (1500, {"verdict": "approved", "findings": []})})
        self.assertEqual(sorted(state.decisions), ["coverage", "general"])
        self.assertEqual(self.now, 1500)
        self.assertFalse(any(status.get("late") for status in state.statuses.values()))
        self.assertFalse([e for e in self.events if "blocked the candidate" in e[2]])

    def test_a_failed_or_late_job_is_recorded_and_the_others_kept(self):
        state = self.collect({"general": (60, {"verdict": "blocked", "findings": [self.P1]}), "coverage": (None, {}), "security": (30, {}, 1)})
        self.assertEqual(list(state.decisions), ["general"])
        self.assertEqual((state.statuses["coverage"]["status"], state.statuses["coverage"]["error"]),
                         ("blocked", "Reviewer coverage deadline exhausted; no second reviewer is launched"))
        self.assertEqual(state.statuses["security"]["status"], "blocked")
        self.assertIn("did not succeed", state.statuses["security"]["error"])
        self.assertEqual(len(self.terminated), 1)

    def test_no_job_with_a_verdict_fails_the_step_as_today(self):
        with self.assertRaisesRegex(RuntimeError, "Reviewer general did not succeed"):
            self.collect({"general": (30, {}, 1), "coverage": (None, {})})


class JudgedGraphFixture(test_automatic.GraphFixture):
    """An automatic run of the offline pipeline whose plan has a judged panel (PRD Appendix B's plan-panel-judged item), two
    built-in reviewers and the fake judge job; the print reviewers' jobs pass through it to GraphFixture's fake reviewer.
    The seats lane's hooks are absent in this lane's worktree: ensure_started, collect and the export's panels section are
    patched out, and `panel.settle` / `panel.record_judge` are patched in (create=True) at their Appendix A signatures, the
    record kept in panel.json as the real port keeps it."""

    reviewers = ["general", "coverage"]
    P1 = {"severity": "P1", "message": "The retry loop never ends. Consequence: the worker hangs.", "disposition": "open", "worker": "adapter", "requirement": None}
    P2 = {"severity": "P2", "message": "No test asserts the empty state.", "disposition": "open", "worker": "ui", "requirement": None}
    SEATS = [{"name": "claude", "prefix": "C", "transport": "claude", "model": None, "served_model": None, "cli_version": None, "effort": "high", "status": "ok",
              "cost_usd": 0.5, "context_bytes": 100, "finding_ids": ["C1"], "error": None,
              "findings": [{"id": "C1", "severity": "P1", "file": "backend.py", "line": 1, "title": "Unbounded retry", "detail": "The loop never ends."}]},
             {"name": "muse", "prefix": "M", "transport": "cli", "model": "muse-wonder-1.0", "served_model": None, "cli_version": "Muse Code 1.4.7",
              "effort": None, "status": "auth_required", "cost_usd": None, "context_bytes": 100, "finding_ids": [], "error": "Not logged in", "findings": []}]
    BLOCKING = [{"ruling": "confirmed", "severity": "P1", "sources": ["coverage-1", "C1"], "file": "backend.py", "line": 1, "title": "The retry loop never ends",
                 "detail": "Nothing bounds the retries.", "requirement": None, "reason": "Read backend.py.", "evidence": "backend.py:1"},
                {"ruling": "refuted", "severity": "P2", "sources": ["general-1"], "file": "ui.txt", "line": 1, "title": "Empty state untested",
                 "detail": "It is tested.", "requirement": None, "reason": "A test covers it.", "evidence": "ui.txt:1"}]
    APPROVING = [{**BLOCKING[0], "ruling": "refuted", "reason": "The loop is bounded."}, BLOCKING[1]]

    def setUp(self):
        super().setUp()
        f = self.fixture
        item = literal("plan-panel-judged")
        item.update(requirements=[], requirement_docs={}, prd_label=None)
        self.item = item
        f.plan["panels"] = [item]
        f.plan["feature_version"] = "2.11.0"
        save_json(f.directory / "plan.json", f.plan)
        scratch = f.root / "judge-fakes"
        scratch.mkdir()
        shutil.copyfile(TESTDATA / "fake-judge.py", scratch / "fake-judge.py")
        wrapper = scratch / "claude"
        wrapper.write_text(f"#!/bin/sh\nexec {sys.executable} -I {scratch / 'fake-judge.py'} \"$@\"\n")
        wrapper.chmod(0o755)
        self.scratch, self.seen, self.reviewer_executable = scratch, scratch / "seen.json", f.sessions.executable
        f.sessions = fixtures.FakeSessions(f.directory, f.plan)
        f.sessions.reviewer_verdict_file = self.verdict
        f.sessions.executable = str(wrapper)
        f.runtime = fixtures.OfflinePipeline(f.directory, f.sessions)
        self.order = []
        self.seats = copy.deepcopy(self.SEATS)
        for target, value in (("workflow.panel.ensure_started", None), ("workflow.panel.collect", None), ("workflow.export_state.panel_section", None),
                              ("workflow.panel.status_lines", []), ("workflow.panel.outcome_lines", [])):
            port = patch(target, return_value=value)
            port.start()
            self.addCleanup(port.stop)
        for target, effect in (("workflow.panel.settle", self.settle), ("workflow.panel.record_judge", self.record_judge)):
            port = patch(target, create=True, side_effect=effect)
            self.mock = port.start()
            self.addCleanup(port.stop)
        self.control(rulings=self.BLOCKING)

    def control(self, **spec):
        (self.scratch / "judge-control.json").write_text(json.dumps({"seen": str(self.seen), "pid": str(self.scratch / "judge.pid"),
                                                                     "reviewer": self.reviewer_executable, **spec}))

    def settle(self, runtime, *, clock=time.time, sleep=time.sleep):
        """Appendix A's settle: every built-in reviewer already has its verdict or its failure when it is called."""
        self.order.append(("settle", {rid: self.status(rid).get("status") for rid in self.ids}))
        return copy.deepcopy(self.seats)

    def record_judge(self, runtime, panel_id: str, judge: dict) -> None:
        self.order.append(("record", judge["status"]))
        save_json(Path(runtime.directory) / "panel.json", {"version": "1.1.0", "panels": [{"id": panel_id, "judge": copy.deepcopy(judge)}]})

    def judge_record(self) -> dict:
        return read_json(self.fixture.directory / "panel.json")["panels"][0]["judge"]

    def runs(self) -> list:
        return json.loads(self.seen.read_text()) if self.seen.exists() else []

    def set_findings(self, general: list, coverage: list, coverage_verdict: str = "approved") -> None:
        """The built-in reviewers' findings and coverage's verdict, on either transport."""
        f = self.fixture
        f.sessions.reviewer_findings = {"general": general, "coverage": coverage}
        f.sessions.reviewer_verdicts = {"coverage": coverage_verdict}
        self.knobs.write_text(json.dumps({"general": {"findings": general}, "coverage": {"findings": coverage, "verdict": coverage_verdict}}))

    def drive(self, blocked: bool):
        from .automatic import drive
        with patch("workflow.automatic.wait_handoffs"):
            if blocked:
                with self.assertRaisesRegex(RuntimeError, "Non-retryable"):
                    drive(self.fixture.runtime)
                return None
            return drive(self.fixture.runtime)

    def todays_review(self) -> str:
        """What today's rule writes for the reviewers' recorded verdicts (combined_review without a judge), as save_json writes it."""
        from .automatic import ReviewStatus, combined_review
        f = self.fixture
        state = ReviewStatus.load(f.runtime)
        decisions = {rid: state.statuses[rid]["accepted_decision"] for rid in state.ids if "accepted_decision" in state.statuses[rid]}
        bundle = read_json(f.directory / "review-bundle.json")
        from .pipeline import digest_file
        return json.dumps(combined_review(f.runtime, bundle, digest_file(f.directory / "review-bundle.json"), state, decisions), indent=2) + "\n"


class JudgedGraphTests:
    """PRD 10.5-10.7 on both reviewer transports."""

    def test_the_judge_runs_after_every_reviewer_and_settle_and_its_confirmed_p1_blocks_and_routes_to_its_lane(self):
        from .automatic import review_block
        f = self.fixture
        self.set_findings([self.P2], [self.P1])
        self.drive(blocked=True)
        # Every built-in reviewer had its verdict before settle, settle before the judge, the judge recorded running then judged.
        self.assertEqual(self.order, [("settle", {"general": "accepted", "coverage": "accepted"}), ("record", "running"), ("record", "judged")])
        self.assertEqual(len(self.runs()), 1)
        review = read_json(f.directory / "review.json")
        judge = self.judge_record()
        self.assertEqual([(e["reviewer_id"], e["verdict"]) for e in review["reviewers"]], [("general", "approved"), ("coverage", "blocked"), ("judge", "blocked")])
        self.assertEqual(review["reviewers"][2]["session_id"], judge["session_id"])
        self.assertEqual(review["findings"], [{"severity": "P1", "message": "[J1 from coverage-1, C1] The retry loop never ends (backend.py:1): Nothing bounds the retries.",
                                               "disposition": "open", "worker": "adapter", "reviewer": "judge"}])
        self.assertEqual([(i["source"], i["kind"], i["status"], i["finding_ids"]) for i in judge["inputs"]],
                         [("general", "reviewer", "approved", ["general-1"]), ("coverage", "reviewer", "blocked", ["coverage-1"]),
                          ("claude", "seat", "ok", ["C1"]), ("muse", "seat", "auth_required", [])])
        self.assertFalse(any(self.status(rid).get("late") for rid in self.ids))
        f.runtime.validate_review(review, require_approved=False)  # Valid with the plan's judged context.
        self.assertTrue(self.combined()["error"].startswith("Independent reviewer blocked the candidate (judge): [P1 judge] [J1 from coverage-1, C1]"),
                        self.combined()["error"])
        self.assertIn("Review blocked by judge (1 confirmed P0/P1: J1)", [e["message"] for e in self.events() if e["status"] == "blocked"])
        self.assertEqual(read_json(f.directory / "run-state.json")["review"]["verdict"], "blocked")
        state = SimpleNamespace(tasks=[SimpleNamespace(name="review", error="blocked")], next=("review",))
        self.assertEqual(review_block(f.runtime, state), ("adapter", review["findings"]))  # The fix loop repairs the J1 lane.

    def test_a_built_in_p1_the_judge_refutes_no_longer_blocks(self):
        f = self.fixture
        self.set_findings([self.P2], [self.P1], coverage_verdict="blocked")
        self.control(rulings=self.APPROVING)
        commit = self.drive(blocked=False)
        self.assertEqual(test_automatic.git(f.repo, "rev-parse", "HEAD"), commit)  # Integrated.
        review = read_json(f.directory / "review.json")
        self.assertEqual((review["verdict"], [e["verdict"] for e in review["reviewers"]], review["findings"]),
                         ("approved", ["approved", "blocked", "approved"], []))
        self.assertEqual(read_json(f.directory / "run-state.json")["review"]["verdict"], "approved")



class JudgedFallbackTests:
    """PRD 10.7 on both reviewer transports: a judge that fails, is incomplete, is over the cap or times out leaves review.json
    byte for byte what today's rule writes for the same reviewer verdicts, and `judge.fallback: true`."""

    def fallback(self, **spec):
        f = self.fixture
        self.set_findings([self.P2], [self.P1])
        self.control(**spec)
        self.drive(blocked=True)
        judge = self.judge_record()
        self.assertIs(judge["fallback"], True)
        self.assertEqual((f.directory / "review.json").read_text(), self.todays_review())
        review = read_json(f.directory / "review.json")
        self.assertEqual([e["reviewer_id"] for e in review["reviewers"]], ["general", "coverage"])
        self.assertTrue(self.combined()["error"].startswith("Independent reviewer blocked the candidate (coverage)"), self.combined()["error"])
        return judge

    def test_a_failed_judge_falls_back_to_todays_review_byte_for_byte(self):
        self.assertEqual(self.fallback(rulings=self.BLOCKING, exit=1)["status"], "failed")

    def test_an_incomplete_judge_falls_back_to_todays_review_byte_for_byte(self):
        judge = self.fallback(rulings=self.BLOCKING[:1])
        self.assertEqual((judge["status"], judge["error"].split(";")[0]), ("incomplete", "judge output incomplete: source ids missing from the rulings: general-1"))

    def test_an_over_cap_input_falls_back_to_todays_review_byte_for_byte(self):
        self.item["judge"]["input_cap_bytes"] = 1000
        for plan in (self.fixture.plan, self.fixture.runtime.plan):
            plan["panels"] = [self.item]
        save_json(self.fixture.directory / "plan.json", self.fixture.plan)
        judge = self.fallback(rulings=self.BLOCKING)
        self.assertTrue(judge["error"].startswith("judge input over the cap"), judge["error"])
        self.assertEqual(self.runs(), [])

    def test_a_timed_out_judge_falls_back_to_todays_review_byte_for_byte(self):
        from . import judge as judge_module
        real, clock = judge_module.run, [0.0]

        def sleep(seconds):
            clock[0] += 900
            time.sleep(0.05)
        with patch("workflow.judge.run", side_effect=lambda *args, **keys: real(*args, clock=lambda: clock[0], sleep=sleep)):
            judge = self.fallback(hang=True)
        self.assertEqual((judge["status"], judge["session_id"]), ("timed_out", None))


class NativeJudgedGraphTests(JudgedGraphTests, JudgedGraphFixture):
    transport = "native"

    def test_a_failed_reviewer_is_recorded_and_the_judge_rules_on_the_others(self):
        f = self.fixture
        self.set_findings([self.P2], [self.P1])
        f.sessions.reviewer_mutate = {"general": lambda completion: {**completion, "launch_token": "00000000-0000-4000-8000-000000000000"}}
        self.drive(blocked=True)
        self.assertEqual(self.order[0], ("settle", {"general": "blocked", "coverage": "accepted"}))
        judge = self.judge_record()
        self.assertEqual(judge["status"], "incomplete")  # The fake judge's rulings still name general-1, which no longer exists.
        self.assertEqual([(i["source"], i["status"], i["finding_ids"]) for i in judge["inputs"][:2]], [("general", "error", []), ("coverage", "blocked", ["coverage-1"])])

    def test_no_built_in_verdict_blocks_review_step_failed_and_no_judge_runs(self):
        f = self.fixture
        f.sessions.reviewer_mutate = lambda completion: {**completion, "launch_token": "00000000-0000-4000-8000-000000000000"}
        self.drive(blocked=True)
        self.assertEqual((self.order, self.runs()), ([], []))
        self.assertTrue([e for e in self.events() if e["node"] == "controller"
                         and e["message"].startswith("Controller blocked: the review step failed: Stale or foreign review completion signal (general)")])



class NativeJudgedFallbackTests(JudgedFallbackTests, JudgedGraphFixture):
    transport = "native"


class NativeJudgedResumeTests(JudgedGraphFixture):
    """PRD 10.8 and 7.6: a terminal judge is never rerun, a non-terminal one is, and Ctrl-C leaves the records non-terminal."""

    transport = "native"

    def test_a_crash_after_the_judge_reuses_its_terminal_record_on_resume(self):
        from . import judge as judge_module
        real = judge_module.run
        self.set_findings([self.P2], [self.P1])

        def crash(*args, **keys):
            real(*args, **keys)
            raise KeyboardInterrupt  # The controller dies between the judge's end and review.json.
        with patch("workflow.judge.run", side_effect=crash), self.assertRaises(KeyboardInterrupt):
            self.drive(blocked=False)
        self.assertFalse((self.fixture.directory / "review.json").exists())
        self.assertEqual(self.judge_record()["status"], "judged")
        self.drive(blocked=True)
        self.assertEqual(len(self.runs()), 1)  # Never rerun.
        self.assertEqual([step for step in self.order if step[0] == "settle"].__len__(), 1)
        self.assertEqual(read_json(self.fixture.directory / "review.json")["reviewers"][2]["session_id"], self.judge_record()["session_id"])
        self.assertIn("Judge judged before this controller started: its record is reused, not rerun", [e["message"] for e in self.events()])

    def test_ctrl_c_during_the_judge_leaves_it_running_and_the_resume_reruns_it(self):
        from . import judge as judge_module
        real = judge_module.run
        self.set_findings([self.P2], [self.P1])
        self.control(rulings=self.BLOCKING, delay=30)

        def interrupted(seconds):
            if self.runs():
                raise KeyboardInterrupt
            time.sleep(0.05)
        with patch("workflow.judge.run", side_effect=lambda *args, **keys: real(*args, sleep=interrupted)), self.assertRaises(KeyboardInterrupt):
            self.drive(blocked=False)
        self.assertEqual(self.judge_record()["status"], "running")
        first = self.runs()[0]
        self.assertTrue(gone(first["pid"]))
        self.assertFalse(Path(first["cwd"]).exists())
        self.control(rulings=self.BLOCKING)
        self.drive(blocked=True)
        self.assertEqual(len(self.runs()), 2)
        self.assertEqual(self.judge_record()["status"], "judged")
        self.assertEqual([e["reviewer_id"] for e in read_json(self.fixture.directory / "review.json")["reviewers"]], ["general", "coverage", "judge"])

    def test_ctrl_c_during_the_wait_starts_no_judge_and_the_resume_judges(self):
        from . import automatic
        real = automatic.wait_reviews
        self.set_findings([self.P2], [self.P1])
        calls = []

        def interrupted(*args, **keys):
            calls.append(keys)
            if len(calls) == 1:
                raise KeyboardInterrupt
            return real(*args, **keys)
        with patch("workflow.automatic.wait_reviews", side_effect=interrupted), self.assertRaises(KeyboardInterrupt):
            self.drive(blocked=False)
        self.assertEqual((self.order, self.runs()), ([], []))
        self.assertEqual(calls[0], {"judged": True})
        with patch("workflow.automatic.wait_reviews", side_effect=interrupted):
            self.drive(blocked=True)
        self.assertEqual(len(self.runs()), 1)
        self.assertEqual(read_json(self.fixture.directory / "review.json")["reviewers"][2]["reviewer_id"], "judge")


class PrintJudgedFallbackTests(JudgedFallbackTests, JudgedGraphFixture):
    transport = "print"


class PrintJudgedGraphTests(JudgedGraphTests, JudgedGraphFixture):
    transport = "print"

    def test_a_first_print_block_does_not_decide_and_a_slower_job_is_recorded_on_time(self):
        f = self.fixture
        self.knobs.write_text(json.dumps({"coverage": {"findings": [self.P1], "verdict": "blocked"}, "general": {"findings": [self.P2], "sleep": 1.5}}))
        self.drive(blocked=True)
        self.assertEqual(self.order[0], ("settle", {"general": "accepted", "coverage": "accepted"}))
        self.assertFalse(any(self.status(rid).get("late") for rid in self.ids))
        self.assertEqual([e["verdict"] for e in read_json(f.directory / "review.json")["reviewers"]], ["approved", "blocked", "blocked"])

    def refuse_launch(self, *refused):
        """popen_claude for the reviewers' jobs, refusing to exec the jobs of `refused` (read from their prompt's file name)."""
        from . import automatic
        from .sessions import review_node
        real = automatic.popen_claude

        def popen(command, **keys):
            if any(Path(keys["stdin"].name).name == f"{review_node(rid)}.prompt.txt" for rid in refused):
                raise PermissionError(13, "Permission denied", command[0])
            return real(command, **keys)
        return patch("workflow.automatic.popen_claude", side_effect=popen)

    def test_a_reviewer_whose_job_fails_to_launch_is_recorded_and_the_judge_rules_on_the_others(self):
        self.set_findings([self.P2], [self.P1])
        with self.refuse_launch("general"):
            self.drive(blocked=True)
        self.assertEqual(self.order[0], ("settle", {"general": "blocked", "coverage": "accepted"}))
        self.assertTrue(self.status("general")["error"].startswith("Reviewer general launch failed: [Errno 13] Permission denied"), self.status("general"))
        self.assertNotIn("pid", self.status("general"))
        self.assertIn(f"Reviewer general gave no verdict: {self.status('general')['error']}; the judge rules on the others' findings",
                      [e["message"] for e in self.events() if e["status"] == "note"])
        judge = self.judge_record()
        self.assertEqual(judge["status"], "incomplete")  # The fake judge's rulings still name general-1, which no longer exists.
        self.assertEqual([(i["source"], i["status"], i["finding_ids"]) for i in judge["inputs"][:2]], [("general", "error", []), ("coverage", "blocked", ["coverage-1"])])

    def test_no_reviewer_job_launched_blocks_review_step_failed_and_no_judge_runs(self):
        with self.refuse_launch("general", "coverage"):
            self.drive(blocked=True)
        self.assertEqual((self.order, self.runs()), ([], []))
        self.assertEqual([self.status(rid)["status"] for rid in self.ids], ["blocked", "blocked"])
        self.assertTrue([e for e in self.events() if e["node"] == "controller"
                         and e["message"].startswith("Controller blocked: the review step failed: PermissionError(13, 'Permission denied')")])


class JudgedCandidateTests(JudgeRunHarness):
    """[L8]: the candidate-level test. The seats lane's real `panel.ensure_started`, `panel.settle` and `panel.record_judge`
    (no mocks of these ports) and the real validators: running->judged and running->incomplete persist with panel.json valid
    against the panel schema at each write, a non-terminal judge is rerun on resume, and a successful judging writes
    `fallback: false` and the judged review.json. Every seat is pinned `unavailable` (disabled in the list), so no seat runs.
    In the judge lane's worktree the two ports do not exist yet and the class skips; it runs at candidate verification."""

    real_ports = True

    def setUp(self):
        from . import panel
        if not (callable(getattr(panel, "settle", None)) and callable(getattr(panel, "record_judge", None))):
            self.skipTest("seats ports absent (lane worktree)")
        super().setUp()
        worktree = self.directory / "review-worktree"
        git_run(self.repo, "worktree", "add", "--detach", str(worktree), self.candidate)
        self.addCleanup(lambda: subprocess.run(["git", "-C", str(self.repo), "worktree", "remove", "--force", str(worktree)], capture_output=True))
        self.item["id"] = "review"
        for seat in self.item["seats"]:
            seat.update(enabled=False, status="unavailable", error="disabled in the reviewer list", bin=None, cli_version=None)
        self.item["requirements"], self.item["requirement_docs"] = [], {}
        self.plan.update(panels=[self.item], feature_version="2.11.0")
        save_json(self.directory / "plan.json", self.plan)
        self.writes = []
        real = panel.record_judge

        def record_judge(runtime, panel_id, judge):
            real(runtime, panel_id, judge)
            from .verification import validate_schema
            record = read_json(self.directory / "panel.json")
            validate_schema("panel", record)  # Valid at each write.
            self.writes.append(copy.deepcopy(next(entry for entry in record["panels"] if entry["id"] == panel_id)["judge"]))
        port = patch("workflow.panel.record_judge", side_effect=record_judge)
        port.start()
        self.addCleanup(port.stop)
        self.reviewers = {"general": {"status": "blocked", "findings": [{"severity": "P1", "message": "REVIEWER-MESSAGE", "disposition": "open",
                                                                         "worker": "engine", "requirement": None}]},
                          "coverage": {"status": "approved", "findings": [{"severity": "P2", "message": "A test gap.", "disposition": "open",
                                                                           "worker": "viewer", "requirement": None}]}}

    def seats(self) -> list:
        from . import panel
        panel.ensure_started(self.runtime)
        return panel.settle(self.runtime, clock=self.clock, sleep=lambda seconds: None)

    def test_running_to_judged_persists_and_writes_the_judged_review(self):
        from .automatic import ReviewStatus, combined_review
        from .pipeline import check_review
        seats = self.seats()
        self.assertEqual(sorted(seat["status"] for seat in seats), ["unavailable"] * len(self.item["seats"]))
        self.control(auto="confirmed", delay=0.2)
        result = self.run_judge(seats, self.reviewers)
        self.assertEqual([write["status"] for write in self.writes], ["running", "judged"])
        self.assertEqual((result["status"], result["fallback"]), ("judged", False))
        self.assertEqual(self.writes[-1], result)
        statuses = {rid: {"reviewer_id": rid, "session_id": f"{n}a1b2c3d-1111-4222-8333-444455556666", "accepted_at": "2026-10-15T10:14:02Z"}
                    for n, rid in enumerate(self.reviewers, 1)}
        runtime = SimpleNamespace(plan=self.plan, directory=self.directory)
        decisions = {rid: {"verdict": item["status"], "findings": item["findings"]} for rid, item in self.reviewers.items()}
        bundle = {"run_id": "judge-test", "candidate_commit": self.candidate, "snapshots": {"engine": {"session_id": "w-engine"}, "viewer": {"session_id": "w-viewer"}}}
        review = combined_review(runtime, bundle, "0" * 64, ReviewStatus(runtime, {}, statuses), decisions, result)
        self.assertEqual([e["reviewer_id"] for e in review["reviewers"]], ["general", "coverage", "judge"])
        check_review(review, bundle, "0" * 64, require_approved=False, reviewers=["general", "coverage", "judge"], judged=True)

    def test_running_to_incomplete_persists_with_the_fallback(self):
        seats = self.seats()
        self.control(rulings=[{"ruling": "confirmed", "severity": "P1", "sources": ["general-1"], "file": "workflow/panel.py", "line": 1, "title": "t",
                               "detail": "d", "requirement": None, "reason": "r", "evidence": "workflow/panel.py:1"}])
        result = self.run_judge(seats, self.reviewers)
        self.assertEqual([write["status"] for write in self.writes], ["running", "incomplete"])
        self.assertEqual((result["fallback"], result["rulings"]), (True, []))
        self.assertTrue(result["error"].startswith("judge output incomplete: source ids missing from the rulings: coverage-1"))

    def test_a_non_terminal_judge_is_rerun_on_resume(self):
        from .automatic import judge_outcome
        from .judge import current
        seats = self.seats()
        self.control(hang=True)

        def interrupted(seconds):
            if (self.scratch / "judge.pid").exists():
                raise KeyboardInterrupt
            time.sleep(0.05)
        with self.assertRaises(KeyboardInterrupt):
            self.run_judge(seats, self.reviewers, sleep=interrupted)
        self.assertEqual(current(self.directory, "review")["status"], "running")
        self.control(auto="confirmed")
        self.runtime.event = lambda *args: None
        state = SimpleNamespace(ids=list(self.reviewers), statuses={rid: {} for rid in self.reviewers})
        decisions = {rid: {"verdict": item["status"], "findings": item["findings"]} for rid, item in self.reviewers.items()}
        result = judge_outcome(self.runtime, self.item, state, decisions)
        self.assertEqual((result["status"], result["fallback"]), ("judged", False))
        self.assertEqual(len(self.runs()), 2)
        self.assertEqual(current(self.directory, "review"), result)


class RoundArchiveTests(unittest.TestCase):
    """PRD 7.6: each fix-loop round runs a fresh judge; archive_review moves the judge object (inside panel.json) and judge/."""

    def test_archive_review_moves_the_judge_record_and_its_files_and_the_next_round_finds_no_judge(self):
        from .automatic import archive_review, restore_review, review_archive
        from .judge import current
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp)
            plan = {"run_id": "r", "repository": str(directory / "repo"), "workers": ["engine"],
                    "reviewers": [{"reviewer_id": "general", "prompt": "General."}], "panels": [literal("plan-panel-judged")]}
            runtime = SimpleNamespace(directory=directory, plan=plan)
            judge = example("panel-judged")["panels"][0]["judge"]
            save_json(directory / "panel.json", {"version": "1.1.0", "panels": [{"id": "review", "judge": judge}]})
            (directory / "judge").mkdir()
            (directory / "judge" / "judge-1.input.txt").write_text("input")
            self.assertIn((directory / "judge", directory / "review-round-1" / "judge"), review_archive(runtime, 1))
            archive_review(runtime, 1)
            self.assertIsNone(current(directory, "review"))  # The next round's judge starts afresh.
            self.assertFalse((directory / "judge").exists())
            self.assertEqual(read_json(directory / "panel.round-1.json")["panels"][0]["judge"], judge)
            self.assertEqual((directory / "review-round-1" / "judge" / "judge-1.input.txt").read_text(), "input")
            restore_review(runtime, 1)  # A round whose repair ended blocked: its record, judge included, is the run's again.
            self.assertEqual(current(directory, "review"), judge)
            self.assertTrue((directory / "judge" / "judge-1.input.txt").exists())
