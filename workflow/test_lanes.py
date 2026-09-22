"""Offline scenarios for worker lanes from configuration (docs/PRD_WORKER_LANES.md, section 6).

Three declared lanes (`ui`, `adapter`, `docs`) in a temporary repository; each test selects the lanes it
launches. Fake sessions, real Git worktrees, checkpoints and checks; no Claude model calls.
"""
import contextlib
import copy
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from typing import TypedDict
from unittest.mock import patch

from jsonschema.exceptions import ValidationError
from langgraph.checkpoint.sqlite import SqliteSaver
from langgraph.graph import END, START, StateGraph
from langgraph.types import Command

from .automatic import DEFAULTS, advance_failed_checks, automatic_settings, check_finding_lanes, drive, read_review_completion, review_prompt, review_schema
from .export_state import graph_nodes
from .interactive import InteractiveSessions, attach_panels
from .launch import DEPRECATED_FEATURE_NOTE, launch_commands, main as launch_main
from .pipeline import ExportRuntime, build_pipeline, check_review, digest_file, export_run, graph_config, lane_positions, parse_lane_selection, report, validate_pipeline_policy
from .sessions import git, plan_digest, prepare, read_json, save_json, validate_node_id
from .test_export import legacy_run
from .test_pipeline import FakeSessions, OfflinePipeline
from .verification import CONTRACTS, policy_digest, required_kinds, validate_policy

REPO = Path(__file__).resolve().parents[1]
PY = sys.executable
LANES = ["ui", "adapter", "docs"]


def three_lane_policy(fail_marker: Path | None = None, drill: dict | None = None) -> dict:
    """Policy 1.2.0 over three lanes with fast checks; the docs check fails once while `fail_marker` exists."""
    docs_check = ("import pathlib, sys\n"
                  f"marker = pathlib.Path({str(fail_marker or '/nonexistent/marker')!r})\n"
                  "if marker.exists():\n    marker.unlink()\n    sys.exit(1)\n"
                  "assert pathlib.Path('docs/docs.md').exists()")
    policy = {"version": "1.2.0", "feature": "Three configured lanes", "independent_review": True, "integration_approval": True,
              "max_verification_attempts": 3,
              "workers": [
                  {"node_id": "ui", "role": "frontend", "required_check_kinds": ["build"], "owned_paths": ["ui.txt"], "checks": [
                      {"id": "ui-build", "kind": "build", "argv": ["python", "-c", "from pathlib import Path; assert Path('ui.txt').read_text() == 'after'"], "timeout_seconds": 10, "scenarios": []}]},
                  {"node_id": "adapter", "role": "backend", "required_check_kinds": ["unit"], "owned_paths": ["backend.py"], "checks": [
                      {"id": "unit", "kind": "unit", "argv": ["python", "-m", "unittest", "discover", "-s", "tests", "-p", "test_*.py"], "timeout_seconds": 10, "scenarios": []}]},
                  {"node_id": "docs", "role": "technical writer", "required_check_kinds": ["build"], "owned_paths": ["docs"], "checks": [
                      {"id": "docs-build", "kind": "build", "argv": ["python", "-c", docs_check], "timeout_seconds": 10, "scenarios": []}]},
              ]}
    if drill:
        policy["failure_drill"] = drill
    return policy


class LaneRun(unittest.TestCase):
    """A temporary repository with three declared lanes; each test selects the lanes it launches."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.repo = self.root / "repo"
        (self.repo / "contracts/workflow").mkdir(parents=True)
        shutil.copyfile(CONTRACTS / "workerResult.schema.json", self.repo / "contracts/workflow/workerResult.schema.json")
        (self.repo / "ui.txt").write_text("before")
        (self.repo / "backend.py").write_text("VALUE = 1\n")
        (self.repo / ".gitignore").write_text("__pycache__/\n")
        (self.repo / "tests").mkdir()
        (self.repo / "docs").mkdir()
        (self.repo / "docs/README.md").write_text("docs\n")
        (self.repo / "tests/test_backend.py").write_text("import unittest\nfrom backend import VALUE\n\nclass BackendTest(unittest.TestCase):\n    def test_value(self):\n        self.assertEqual(VALUE, 2)\n")
        for args in (["init", "-q"], ["config", "user.name", "Test"], ["config", "user.email", "test@example.invalid"], ["add", "."], ["commit", "-qm", "Base"]):
            subprocess.run(["git", "-C", str(self.repo), *args], check=True)
        self.fail_marker = self.root / "docs-fail-once"
        self.directory = self.root / "run"
        self.run_root = self.root / "runs"

    def prepare(self, selected: list[str], *, drill: dict | None = None, automatic: bool = False, name: str = "run"):
        self.directory = self.root / name
        self.policy = three_lane_policy(self.fail_marker, drill)
        if automatic:
            git(self.repo, "switch", "-c", "feature/lanes")
        tasks = {node: f"# {node} task\n\nDo the {node} work." for node in selected}
        self.plan = prepare(self.directory, self.repo, "HEAD", tasks, True, declared=LANES)
        skipped = bool(drill) and drill["node_id"] not in selected
        self.plan.update(mode="interactive", policy_sha256=policy_digest(self.policy), source_branch=git(self.repo, "symbolic-ref", "--short", "HEAD"),
                         failure_drill=None if skipped else drill)
        if automatic:
            self.plan["automatic"] = automatic_settings()
        save_json(self.directory / "plan.json", self.plan)
        save_json(self.directory / "policy.json", self.policy)
        self.attach(self.directory)
        return self.runtime

    def attach(self, directory: Path):
        self.directory = directory
        self.plan = read_json(directory / "plan.json")
        self.policy = read_json(directory / "policy.json")
        self.sessions = FakeSessions(directory, self.plan)
        self.runtime = OfflinePipeline(directory, self.sessions)
        self.config = graph_config(self.runtime)

    def manual_run(self) -> str:
        """Through every operator gate to a fast-forwarded source branch."""
        with SqliteSaver.from_conn_string(str(self.directory / "pipeline.sqlite")) as saver:
            graph = build_pipeline(saver, self.runtime)
            first = graph.invoke({"run_id": self.plan["run_id"]}, self.config)
            self.assertEqual(first["__interrupt__"][0].value["kind"], "worker_handoff")
            verified = graph.invoke(Command(resume={"freeze": True}), self.config)
            self.assertEqual(verified["__interrupt__"][0].value["kind"], "independent_review")
            bundle, digest = self.runtime.validate_bundle()
            decision = {"run_id": self.plan["run_id"], "bundle_sha256": digest, "candidate_commit": bundle["candidate_commit"],
                        "reviewer": "synthetic-test-reviewer", "independent": True, "verdict": "approved", "findings": []}
            approved = graph.invoke(Command(resume=decision), self.config)
            self.assertEqual(approved["__interrupt__"][0].value["kind"], "integration_approval")
            final = graph.invoke(Command(resume={"approve": digest}), self.config)
            report(self.runtime, graph.get_state(self.config))
            return final["integrated_commit"]

    def feature_dir(self, name: str = "lanes", *, drill: dict | None = None) -> Path:
        """A committed three-lane feature directory in the temporary repository."""
        folder = self.repo / "features" / name
        folder.mkdir(parents=True)
        save_json(folder / "policy.json", three_lane_policy(self.fail_marker, drill))
        for node in LANES:
            (folder / f"{node}-task.md").write_text(f"# {node}\n\nDo the {node} work.\n")
        save_json(folder / "feature.json", {"version": "2.0.0", "name": "Lanes", "branch_prefix": "feature/lanes", "policy": "policy.json",
                                            "workers": [{"node_id": node, "task": f"{node}-task.md"} for node in LANES]})
        subprocess.run(["git", "-C", str(self.repo), "add", "."], check=True)
        subprocess.run(["git", "-C", str(self.repo), "commit", "-qm", f"Feature {name}"], check=True)
        return folder

    def cli(self, *arguments: str, timeout: int = 300) -> subprocess.CompletedProcess:
        return subprocess.run([PY, "-m", "workflow", *arguments], cwd=REPO, capture_output=True, text=True, timeout=timeout)


class ThreeLaneRun(LaneRun):
    def test_three_lane_automatic_run_reaches_a_verified_branch_in_declared_order(self):
        self.prepare(LANES, automatic=True)
        with SqliteSaver.from_conn_string(str(self.directory / "pipeline.sqlite")) as saver:
            first = build_pipeline(saver, self.runtime).invoke({"run_id": self.plan["run_id"]}, self.config)
            self.assertEqual(first["__interrupt__"][0].value["kind"], "worker_handoff")
        with patch("workflow.automatic.wait_handoffs"):  # FakeSessions already supplied every lane's handoff.
            commit = drive(self.runtime)
        self.assertEqual(git(self.repo, "rev-parse", "HEAD"), commit)
        self.assertEqual(git(self.repo, "symbolic-ref", "--short", "HEAD"), "feature/lanes")
        subjects = git(self.repo, "log", "--reverse", "--format=%s", f"{self.plan['base_commit']}..HEAD").splitlines()
        self.assertEqual(subjects, [f"Workflow run: {node}" for node in LANES])
        self.assertEqual(sorted(self.sessions.starts), ["adapter", "docs", "review", "ui"])
        self.assertEqual((self.repo / "docs/docs.md").read_text(), "# docs\n")
        for node in LANES:
            for name in (f"{node}.interactive.json", f"{node}.handoff.json", f"{node}.snapshot-index", f"worktree-{node}",
                         f"verification/worker/{node}/1/packet.json", f"verification/candidate/{node}/1/packet.json"):
                self.assertTrue((self.directory / name).exists(), name)
        bundle = read_json(self.directory / "review-bundle.json")
        self.assertEqual(list(bundle["snapshots"]), LANES)
        exported = read_json(self.directory / "run-state.json")
        self.assertEqual(exported["version"], "1.3.0")
        self.assertEqual([node["node_id"] for node in exported["definition"]["nodes"]],
                         ["launch_ui", "launch_adapter", "launch_docs", "handoff", "verify_ui", "verify_adapter", "verify_docs", "candidate", "review", "approval", "integrate"])
        self.assertEqual(exported["definition"]["nodes"][2]["label"], "Launch docs worker")
        self.assertEqual(sorted(exported["values"]["lanes"]), sorted(LANES))
        self.assertEqual(sorted(exported["values"]["packets"]), sorted(LANES))
        self.assertEqual((exported["inputs"]["selected_workers"], exported["inputs"]["excluded_workers"]), (LANES, []))
        self.assertEqual([(lane, worker["role"], worker["required_check_kinds"]) for lane, worker in exported["inputs"]["workers"].items()],
                         [("ui", "frontend", ["build"]), ("adapter", "backend", ["unit"]), ("docs", "technical writer", ["build"])])
        self.assertEqual(exported["next"], [])
        html = (self.directory / "report.html").read_text()
        for node in LANES:
            self.assertIn(f">launch_{node}<", html)
            self.assertIn(f">verify_{node}<", html)
        self.assertIn("Lanes: ui, adapter, docs.", html)
        # The reviewer was told the run's lanes and the attribution vocabulary of this run.
        prompt = (self.directory / "review.prompt.txt").read_text()
        self.assertIn("ui, adapter, docs, multiple or none", prompt)
        self.assertNotIn("both or none", prompt)

    def test_one_lane_run_verifies_the_lane_in_both_phases_and_integrates_it(self):
        self.prepare(["adapter"])
        self.assertEqual((self.plan["workers"], self.plan["excluded_workers"], list(self.plan["nodes"])), (["adapter"], ["ui", "docs"], ["adapter"]))
        commit = self.manual_run()
        self.assertEqual(git(self.repo, "rev-parse", "HEAD"), commit)
        self.assertEqual((self.repo / "backend.py").read_text(), "VALUE = 2\n")
        self.assertEqual((self.repo / "ui.txt").read_text(), "before")
        self.assertEqual(self.sessions.starts, ["adapter"])
        self.assertTrue((self.directory / "verification/worker/adapter/1/packet.json").exists())
        self.assertTrue((self.directory / "verification/candidate/adapter/1/packet.json").exists())
        self.assertEqual(sorted(path.name for path in self.directory.glob("worktree-*")), ["worktree-adapter"])
        self.assertFalse((self.directory / "verification/worker/ui").exists())
        bundle = read_json(self.directory / "review-bundle.json")
        self.assertEqual(list(bundle["snapshots"]), ["adapter"])
        self.assertEqual(len(bundle["packets"]), 2)
        exported = read_json(self.directory / "run-state.json")
        self.assertEqual([node["node_id"] for node in exported["definition"]["nodes"]], ["launch_adapter", "handoff", "verify_adapter", "candidate", "review", "approval", "integrate"])
        self.assertEqual((exported["inputs"]["selected_workers"], exported["inputs"]["excluded_workers"], list(exported["inputs"]["workers"])), (["adapter"], ["ui", "docs"], ["adapter"]))
        self.assertEqual(exported["values"]["integrated_commit"], commit)
        positions, edges, width, height = lane_positions(["adapter"])
        self.assertEqual((positions["launch_adapter"], positions["handoff"], positions["integrate"], height), ((90, 70), (280, 70), (1230, 70), 140))
        self.assertEqual(len(edges), 6)

    def test_report_positions_follow_the_lane_count(self):
        positions, edges, width, height = lane_positions(LANES)
        self.assertEqual([positions[f"launch_{node}"] for node in LANES], [(90, 70), (90, 210), (90, 350)])
        self.assertEqual([positions[f"verify_{node}"][1] for node in LANES], [70, 210, 350])
        self.assertEqual((positions["handoff"], positions["candidate"], positions["review"]), ((280, 210), (660, 210), (850, 210)))
        self.assertEqual((width, height), (1330, 420))
        self.assertEqual(len(edges), 3 * len(LANES) + 3)
        two, _, _, two_height = lane_positions(["ui", "adapter"])
        self.assertEqual((two["launch_ui"], two["launch_adapter"], two["handoff"], two_height), ((90, 70), (90, 210), (280, 140), 280))  # Unchanged for two lanes.


class SubsetSelection(LaneRun):
    def test_subset_selection_is_pinned_and_prepares_only_those_worktrees(self):
        self.feature_dir(drill={"node_id": "adapter", "phase": "worker", "attempt": 1})
        run, commands, notes = launch_commands(self.repo, "lanes", "lanes-001", self.run_root, herdr=False, workers="docs,ui")
        prepare_command = commands[2]
        self.assertEqual(prepare_command[prepare_command.index("--workers") + 1], "ui,docs")  # Declared order, whatever was typed.
        tasks = [prepare_command[index + 1] for index, item in enumerate(prepare_command) if item == "--task"]
        self.assertEqual([task.split("=", 1)[0] for task in tasks], ["ui", "docs"])
        self.assertEqual(notes, ["Failure drill skipped: its lane adapter is not selected (selected: ui, docs)."])
        # Run the real prepare command: no agent launches, the selection is pinned, only the selected worktrees exist.
        result = subprocess.run(prepare_command, cwd=REPO, capture_output=True, text=True, timeout=120)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Lanes: ui, docs (excluded: adapter)", result.stdout)
        plan = read_json(run / "plan.json")
        self.assertEqual((plan["workers"], plan["excluded_workers"], plan["failure_drill"], list(plan["nodes"])), (["ui", "docs"], ["adapter"], None, ["ui", "docs"]))
        self.assertEqual(sorted(path.name for path in run.glob("worktree-*")), ["worktree-docs", "worktree-ui"])
        self.assertIn("Approved ownership and checks", plan["nodes"]["docs"]["task"])
        exported = read_json(run / "run-state.json")
        self.assertEqual((exported["inputs"]["selected_workers"], exported["inputs"]["excluded_workers"], list(exported["inputs"]["workers"])), (["ui", "docs"], ["adapter"], ["ui", "docs"]))
        self.assertIsNone(exported["inputs"]["failure_drill"])
        self.assertEqual(exported["next"], ["launch_ui", "launch_docs"])
        self.assertEqual([node["node_id"] for node in exported["definition"]["nodes"] if node["kind"] == "worker"], ["launch_ui", "launch_docs"])
        self.assertTrue(any("Failure drill skipped" in event["message"] for event in exported["events"]))
        status = self.cli("status", str(run))
        self.assertEqual(status.returncode, 0, status.stderr)
        printed = json.loads(status.stdout.split("\nReport:")[0])
        self.assertEqual((printed["workers"], printed["excluded_workers"], printed["pending"]), (["ui", "docs"], ["adapter"], []))
        # Without --workers every declared lane runs and the selection is not spelled out.
        _, commands, notes = launch_commands(self.repo, "lanes", "lanes-002", self.run_root, herdr=False)
        self.assertNotIn("--workers", commands[2])
        self.assertEqual([item.split("=", 1)[0] for item in commands[2][commands[2].index("--task") + 1::2] if "=" in item], LANES)
        self.assertEqual(notes, [])

    def test_selected_lane_touching_an_excluded_lanes_path_blocks_at_freeze(self):
        self.prepare(["ui", "docs"])
        self.sessions.edits["ui"] = ("backend.py", "UNOWNED = True\n")
        for node in ("ui", "docs"):
            self.sessions.run(node)
        with self.assertRaisesRegex(ValueError, "Ownership violation: ui edited backend.py, owned by excluded lane adapter"):
            self.runtime.freeze()
        self.assertFalse((self.directory / "snapshots.json").exists())
        # A path owned by nobody is still refused with the plain message.
        self.sessions.edits["ui"] = ("stray.txt", "x")
        (Path(self.plan["nodes"]["ui"]["worktree"]) / "backend.py").write_text("VALUE = 1\n")
        self.sessions.run("ui")
        with self.assertRaisesRegex(ValueError, "ui edited unowned path: stray.txt"):
            self.runtime.freeze()

    def test_unknown_or_duplicate_worker_selection_is_refused_before_any_git_action(self):
        self.feature_dir()
        for bad, message in (("ui,nope", "not declare"), ("ui,ui", "twice"), ("", "comma-separated"), ("ui,,docs", "comma-separated"), ("adapter,review", "not declare")):
            with self.assertRaisesRegex(ValueError, message):
                launch_commands(self.repo, "lanes", "lanes-001", self.run_root, herdr=False, workers=bad)
        self.assertFalse(self.run_root.exists())
        self.assertEqual(parse_lane_selection("docs,ui", LANES), ["ui", "docs"])
        self.assertEqual(parse_lane_selection(None, LANES), LANES)
        # Through the CLI on the committed feature: nothing runs, not even `git switch`.
        for bad in ("ui,nope", "ui,ui"):
            with patch("workflow.launch.subprocess.run") as command, contextlib.redirect_stderr(io.StringIO()) as errors:
                with self.assertRaises(SystemExit):
                    launch_main(["project-workflows", "--live", "--workers", bad, "--run-root", str(self.run_root)])
            command.assert_not_called()
            self.assertIn("Launch blocked", errors.getvalue())
        # The step-by-step path refuses the same selections before allocating anything.
        result = self.cli("prepare", str(self.run_root / "cli"), "--repo", str(self.repo), "--policy", str(self.repo / "features/lanes/policy.json"),
                          "--workers", "ui,nope", "--task", f"ui={self.repo / 'features/lanes/ui-task.md'}")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("nope", result.stderr)
        self.assertFalse((self.run_root / "cli").exists())
        result = self.cli("prepare", str(self.run_root / "cli"), "--repo", str(self.repo), "--policy", str(self.repo / "features/lanes/policy.json"),
                          "--workers", "ui,docs", "--task", f"ui={self.repo / 'features/lanes/ui-task.md'}")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("--task must be given exactly once for each selected lane (ui, docs)", result.stderr)
        self.assertFalse((self.run_root / "cli").exists())

    def test_drill_naming_an_excluded_lane_is_skipped_and_injects_nothing(self):
        self.feature_dir(drill={"node_id": "adapter", "phase": "worker", "attempt": 1})
        run, commands, notes = launch_commands(self.repo, "lanes", "lanes-001", self.run_root, herdr=False, workers="ui,docs")
        result = subprocess.run(commands[2], cwd=REPO, capture_output=True, text=True, timeout=120)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.attach(run)
        self.assertIsNone(self.plan["failure_drill"])
        self.assertIsNone(self.runtime.failure_drill())
        events = [json.loads(line) for line in (run / "events.jsonl").read_text().splitlines()]
        self.assertEqual([event["message"] for event in events if "drill" in event["message"].lower()],
                         ["Failure drill skipped: its lane adapter is not selected for this run"])
        commit = self.manual_run()
        self.assertEqual(git(self.repo, "rev-parse", "HEAD"), commit)
        self.assertFalse((run / "failure-drill.json").exists())
        self.assertFalse((run / "failure-report.json").exists())
        for node in ("ui", "docs"):
            self.assertEqual(sorted(item.name for item in (run / "verification/worker" / node).iterdir()), ["1"])
            self.assertEqual(read_json(run / f"verification/worker/{node}/1/packet.json")["gate"]["status"], "passed")
        self.assertNotIn("failure_drill", read_json(run / "review-bundle.json"))
        # The same drill fires when its lane is selected: the adapter's first attempt is blocked as before.
        self.prepare(LANES, drill={"node_id": "adapter", "phase": "worker", "attempt": 1}, name="run-with-drill")
        self.assertEqual(self.plan["failure_drill"], {"node_id": "adapter", "phase": "worker", "attempt": 1})
        with SqliteSaver.from_conn_string(str(self.directory / "pipeline.sqlite")) as saver:
            graph = build_pipeline(saver, self.runtime)
            graph.invoke({"run_id": self.plan["run_id"]}, self.config)
            with self.assertRaisesRegex(RuntimeError, "adapter verification blocked"):
                graph.invoke(Command(resume={"freeze": True}), self.config)
        self.assertTrue((self.directory / "failure-drill.json").exists())


class RetryAnyLane(LaneRun):
    def test_retry_reruns_only_the_failed_lanes_check(self):
        self.prepare(LANES)
        self.fail_marker.touch()
        with SqliteSaver.from_conn_string(str(self.directory / "pipeline.sqlite")) as saver:
            graph = build_pipeline(saver, self.runtime)
            graph.invoke({"run_id": self.plan["run_id"]}, self.config)
            with self.assertRaisesRegex(RuntimeError, "docs verification blocked"):
                graph.invoke(Command(resume={"freeze": True}), self.config)
            state = graph.get_state(self.config)
            self.assertIn("verify_docs", state.next)
            # The automatic classifier retries exactly that lane.
            self.assertTrue(advance_failed_checks(self.runtime, state))
        self.assertEqual(read_json(self.directory / "attempts.json"), {"worker:docs": 2})
        (self.directory / "attempts.json").unlink()
        digests = {node: digest_file(self.directory / f"verification/worker/{node}/1/packet.json") for node in ("ui", "adapter")}
        # The CLI validates --node against this run's lanes, then reruns only that lane's check.
        result = self.cli("retry", str(self.directory), "--phase", "worker", "--node", "nope")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("--node must be a lane of this run (ui, adapter, docs)", result.stderr)
        self.assertFalse((self.directory / "attempts.json").exists())
        result = self.cli("retry", str(self.directory), "--phase", "worker", "--node", "docs")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(read_json(self.directory / "attempts.json"), {"worker:docs": 2})
        self.assertEqual(read_json(self.directory / "verification/worker/docs/2/packet.json")["gate"]["status"], "passed")
        for node in ("ui", "adapter"):
            self.assertFalse((self.directory / f"verification/worker/{node}/2").exists())
            self.assertEqual(digest_file(self.directory / f"verification/worker/{node}/1/packet.json"), digests[node])
        self.assertEqual(sorted(self.sessions.starts), ["adapter", "docs", "ui"])  # The retry process launched nothing.
        self.assertFalse((self.directory / "fake-launches.log").read_text().count("\n") > 3)
        with SqliteSaver.from_conn_string(str(self.directory / "pipeline.sqlite")) as saver:
            state = build_pipeline(saver, self.runtime).get_state(self.config)
        self.assertEqual([item.value["kind"] for task in state.tasks for item in task.interrupts], ["independent_review"])

    def test_advance_failed_checks_knows_every_selected_lane(self):
        attempts, bumped = {}, []
        runtime = SimpleNamespace(directory=self.root, policy={"max_verification_attempts": 3}, workers=LANES,
                                  attempt=lambda phase, node: attempts.get(f"{phase}:{node}", 1),
                                  retry_check=lambda phase, node: bumped.append((phase, node)))
        (self.root / "verification/worker/docs/1").mkdir(parents=True)
        save_json(self.root / "verification/worker/docs/1/packet.json", {"gate": {"status": "blocked", "reasons": ["docs-build: exit 1"]}})
        state = SimpleNamespace(next=("verify_docs",), tasks=[SimpleNamespace(name="verify_docs", error="blocked")])
        self.assertTrue(advance_failed_checks(runtime, state))
        self.assertEqual(bumped, [("worker", "docs")])
        # A lane the run did not select is never a retry target.
        runtime.workers = ["ui", "adapter"]
        self.assertFalse(advance_failed_checks(runtime, state))


class PolicyRules(unittest.TestCase):
    def test_required_kinds_must_be_backed_by_checks_and_legacy_roles_derive_them(self):
        policy = three_lane_policy()
        validate_pipeline_policy(policy)
        policy["workers"][2]["required_check_kinds"] = ["browser"]
        with self.assertRaisesRegex(ValueError, "docs requires .*browser"):
            validate_policy(policy)
        policy = three_lane_policy()
        policy["workers"][0]["role"] = "anything goes, up to forty characters"  # A free label from 1.2.0.
        validate_pipeline_policy(policy)
        policy["workers"][0]["role"] = "r" * 41
        with self.assertRaises(ValidationError):
            validate_policy(policy)
        legacy = read_json(REPO / "features/worker-lanes/policy.json")
        self.assertEqual(legacy["version"], "1.1.0")
        validate_pipeline_policy(legacy)
        self.assertEqual([required_kinds(legacy, worker) for worker in legacy["workers"]], [["build", "browser"], ["unit"]])
        stripped = copy.deepcopy(legacy)
        stripped["workers"][0]["checks"] = [check for check in stripped["workers"][0]["checks"] if check["kind"] != "browser"]
        with self.assertRaisesRegex(ValueError, "ui requires .*browser"):
            validate_policy(stripped)
        for change in ({"required_check_kinds": ["build"]}, {"role": "writer"}):
            relabelled = copy.deepcopy(legacy)
            relabelled["workers"][0].update(change)
            with self.assertRaises(ValidationError):
                validate_policy(relabelled)
        # The committed 1.2.0 policy declares its kinds explicitly and still validates.
        committed = read_json(REPO / "features/project-workflows/policy.json")
        self.assertEqual(committed["version"], "1.2.0")
        validate_pipeline_policy(committed)
        self.assertEqual([required_kinds(committed, worker) for worker in committed["workers"]], [["build", "browser"], ["unit"]])
        self.assertEqual(json.loads((CONTRACTS / "verification.example.json").read_text())["version"], "1.2.0")
        validate_pipeline_policy(json.loads((CONTRACTS / "verification.example.json").read_text()))

    def test_reserved_lane_ids_are_refused(self):
        for bad in ("review", "none", "launch_x", "candidate", "handoff", "approval", "integrate", "multiple", "both", "review-x", "verify_ui", "candidate_ui", "Docs", "1docs", "", "d" * 33):
            policy = three_lane_policy()
            policy["workers"][2]["node_id"] = bad
            with self.assertRaises((ValueError, ValidationError)):
                validate_pipeline_policy(policy)
            with self.assertRaises(ValueError):
                validate_node_id(bad)
        policy = three_lane_policy()
        policy["failure_drill"] = {"node_id": "review", "phase": "worker", "attempt": 1}
        with self.assertRaises((ValueError, ValidationError)):
            validate_pipeline_policy(policy)
        policy["failure_drill"] = {"node_id": "docs", "phase": "worker", "attempt": 1}
        validate_pipeline_policy(policy)
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for tasks, message in (({"review": "task"}, "reserved"), ({}, "nonempty task"), ({"docs": " "}, "nonempty task"), ({"launch_x": "task"}, "must match")):
                with self.assertRaisesRegex(ValueError, message):
                    prepare(root / "run", root, "HEAD", tasks, True)
            with self.assertRaisesRegex(ValueError, "not declared"):
                prepare(root / "run", root, "HEAD", {"docs": "task"}, True, declared=["ui", "adapter"])
            self.assertFalse((root / "run").exists())


class FindingLanes(unittest.TestCase):
    TOKEN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.digest = "b" * 64

    def runtime(self, workers: list[str]):
        plan = {"run_id": "test", "source_branch": "feature/test", "automatic": dict(DEFAULTS), "workers": workers, "excluded_workers": [],
                "nodes": {node: {"task": f"Do the {node} work."} for node in workers}}
        bundle = {"run_id": "test", "candidate_commit": "c" * 40, "snapshots": {node: {"session_id": f"{node}-session"} for node in workers}}
        sessions = SimpleNamespace(inventory=lambda: [], locate=lambda node, rows: None, executable="claude")
        save_json(self.root / "automatic-review.json", {"transport": "native", "launch_token": self.TOKEN, "bundle_sha256": self.digest,
                                                         "candidate_commit": "c" * 40, "status": "running"})
        return SimpleNamespace(directory=self.root, plan=plan, workers=workers, sessions=sessions, validate_bundle=lambda: (bundle, self.digest),
                               event=lambda *args: None), bundle

    def completion(self, worker):
        return {"version": "1.1.0", "run_id": "test", "node_id": "review", "launch_token": self.TOKEN, "bundle_sha256": self.digest,
                "candidate_commit": "c" * 40, "verdict": "approved",
                "findings": [{"severity": "P2", "message": "Finding", "disposition": "open", "worker": worker, "requirement": None}]}

    def test_finding_lanes_follow_the_runs_selection(self):
        three, bundle = self.runtime(LANES)
        two, _ = self.runtime(["ui", "adapter"])
        for worker in ("docs", "multiple", "none", "ui"):
            save_json(self.root / "review.completion.json", self.completion(worker))
            self.assertEqual(read_review_completion(three)["findings"][0]["worker"], worker)
        for worker in ("multiple", "none", "adapter"):
            save_json(self.root / "review.completion.json", self.completion(worker))
            self.assertEqual(read_review_completion(two)["findings"][0]["worker"], worker)
        save_json(self.root / "review.completion.json", self.completion("docs"))
        with self.assertRaisesRegex(RuntimeError, "names worker 'docs', which is not a lane of this run \\(ui, adapter, multiple or none\\)"):
            read_review_completion(two)
        for runtime in (three, two):
            for worker in ("both", "review", "Docs"):
                save_json(self.root / "review.completion.json", self.completion(worker))
                with self.assertRaisesRegex(RuntimeError, "schema"):
                    read_review_completion(runtime)
        check_finding_lanes(three, [{"worker": "docs"}, {"worker": "multiple"}])
        with self.assertRaises(RuntimeError):
            check_finding_lanes(two, [{"worker": "docs"}])
        with self.assertRaises(RuntimeError):
            check_finding_lanes(three, [{"severity": "P2"}])
        # The print-mode schema and the prompts carry the same vocabulary.
        self.assertEqual(review_schema(three)["properties"]["findings"]["items"]["properties"]["worker"]["enum"], ["ui", "adapter", "docs", "multiple", "none"])
        self.assertEqual(review_schema(two)["properties"]["findings"]["items"]["properties"]["worker"]["enum"], ["ui", "adapter", "multiple", "none"])
        self.assertIn("(ui, adapter, docs, multiple or none:", review_prompt(three, self.root / "review.diff"))
        self.assertIn("worker lanes are: ui, adapter, docs.", review_prompt(three, self.root / "review.diff"))
        # The persisted review is bound to the bundle's lanes; `both` only survives from reviews recorded before configured lanes.
        base = {"run_id": "test", "bundle_sha256": self.digest, "candidate_commit": "c" * 40, "reviewer": "reviewer", "independent": True, "verdict": "approved"}
        finding = {"severity": "P2", "message": "x", "disposition": "open", "requirement": None}
        check_review({**base, "findings": [{**finding, "worker": "docs"}, {**finding, "worker": "multiple"}]}, bundle, self.digest)
        with self.assertRaisesRegex(ValueError, "finding worker"):
            check_review({**base, "findings": [{**finding, "worker": "both"}]}, bundle, self.digest)
        with self.assertRaisesRegex(ValueError, "finding worker"):
            check_review({**base, "findings": [{**finding, "worker": "contracts"}]}, bundle, self.digest)
        check_review({**base, "findings": [{**finding, "worker": "both"}]}, bundle, self.digest, allow_legacy=True)


class LegacyFeatureAndRun(LaneRun):
    def two_lane_features(self):
        """The same two-lane assignment committed twice: as a 2.0.0 file and as its 1.0.0 predecessor."""
        policy = read_json(REPO / "features/worker-lanes/policy.json")  # 1.1.0: ui/frontend and adapter/backend.
        for name, manifest in (("new", {"version": "2.0.0", "workers": [{"node_id": "ui", "task": "ui-task.md"}, {"node_id": "adapter", "task": "adapter-task.md"}]}),
                               ("old", {"version": "1.0.0", "ui_task": "ui-task.md", "adapter_task": "adapter-task.md"})):
            folder = self.repo / "features" / name
            folder.mkdir(parents=True)
            save_json(folder / "policy.json", policy)
            for node in ("ui", "adapter"):
                (folder / f"{node}-task.md").write_text(f"# {node}\n\nDo the {node} work.\n")
            save_json(folder / "feature.json", {"name": "Two lanes", "branch_prefix": "feature/two", "policy": "policy.json", **manifest})
        subprocess.run(["git", "-C", str(self.repo), "add", "."], check=True)
        subprocess.run(["git", "-C", str(self.repo), "commit", "-qm", "Features"], check=True)

    def test_legacy_feature_file_dry_runs_with_the_same_commands_plus_a_deprecation_line(self):
        self.two_lane_features()
        run_new, commands_new, notes_new = launch_commands(self.repo, "new", "r1", self.run_root, herdr=False, automatic=True)
        run_old, commands_old, notes_old = launch_commands(self.repo, "old", "r1", self.run_root, herdr=False, automatic=True)
        self.assertEqual(run_new, run_old)
        normalised = [[item.replace("/features/old/", "/features/new/") for item in command] for command in commands_old]
        self.assertEqual(normalised, commands_new)
        self.assertEqual((notes_new, notes_old), ([], [DEPRECATED_FEATURE_NOTE]))
        _, commands_old, _ = launch_commands(self.repo, "old", "r2", self.run_root, herdr=False, workers="adapter")
        self.assertEqual(commands_old[2][commands_old[2].index("--workers") + 1], "adapter")
        with self.assertRaisesRegex(ValueError, "not declare"):
            launch_commands(self.repo, "old", "r3", self.run_root, herdr=False, workers="docs")
        # A 2.0.0 file whose lanes differ from the policy's, or with a broken task file, is refused.
        manifest = read_json(self.repo / "features/new/feature.json")
        manifest["workers"].append({"node_id": "docs", "task": "ui-task.md"})
        save_json(self.repo / "features/new/feature.json", manifest)
        with self.assertRaisesRegex(ValueError, "must be the policy's lanes"):
            launch_commands(self.repo, "new", "r4", self.run_root, herdr=False)
        manifest["workers"] = [{"node_id": "ui", "task": "ui-task.md"}, {"node_id": "adapter", "task": "missing.md"}]
        save_json(self.repo / "features/new/feature.json", manifest)
        with self.assertRaises((ValueError, OSError)):
            launch_commands(self.repo, "new", "r4", self.run_root, herdr=False)
        manifest["workers"] = [{"node_id": "ui", "task": "ui-task.md"}, {"node_id": "review", "task": "adapter-task.md"}]
        save_json(self.repo / "features/new/feature.json", manifest)
        with self.assertRaises((ValueError, ValidationError)):
            launch_commands(self.repo, "new", "r4", self.run_root, herdr=False)
        # The committed worker-lanes feature is still 1.0.0: its dry run prints the deprecation line and executes nothing.
        with patch("workflow.launch.subprocess.run") as command, contextlib.redirect_stdout(io.StringIO()) as output, contextlib.redirect_stderr(io.StringIO()) as errors:
            launch_main(["worker-lanes", "--dry-run", "--automatic"])
        command.assert_not_called()
        printed = json.loads(output.getvalue())
        self.assertEqual((printed["workers"], printed["notes"], printed["executes"]), (["ui", "adapter"], [DEPRECATED_FEATURE_NOTE], False))
        self.assertIn("Deprecation: feature.json version 1.0.0", errors.getvalue())
        # The migrated project-workflows feature launches unchanged, without a note; --workers narrows it.
        with patch("workflow.launch.subprocess.run") as command, contextlib.redirect_stdout(io.StringIO()) as output, contextlib.redirect_stderr(io.StringIO()) as errors:
            launch_main(["project-workflows", "--dry-run", "--workers", "adapter"])
        command.assert_not_called()
        printed = json.loads(output.getvalue())
        self.assertEqual((printed["workers"], printed["notes"]), (["adapter"], []))  # The drill names adapter, which is selected.
        self.assertEqual(printed["commands"][2][printed["commands"][2].index("--workers") + 1], "adapter")
        self.assertEqual(errors.getvalue(), "")

    def test_legacy_run_exports_at_1_3_0_with_its_stored_definition_and_lane_evidence(self):
        directory = legacy_run(self.root)
        stored = read_json(directory / "run-state.json")
        old_nodes = graph_nodes(["ui", "adapter"])
        old_nodes[0]["label"], old_nodes[1]["label"], old_nodes[4]["label"], old_nodes[5]["label"] = "Launch UI worker", "Launch adapter worker", "Verify UI", "Verify adapter"
        stored["definition"] = {"name": "Feature implementation", "nodes": old_nodes}
        save_json(directory / "run-state.json", stored)
        # The checkpoint of the finished run was written by the two-lane graph: `ui`, `adapter`, `ui_packet`, `adapter_packet`.
        class OldState(TypedDict, total=False):
            run_id: str
            ui: dict
            adapter: dict
            snapshots: dict
            ui_packet: str
            adapter_packet: str
            bundle: str
            review: dict
            approved_bundle: str
            integrated_commit: str
        config = {"configurable": {"thread_id": "legacy-001"}}
        with SqliteSaver.from_conn_string(str(directory / "pipeline.sqlite")) as saver:
            old = StateGraph(OldState)
            old.add_node("integrate", lambda state: state)
            old.add_edge(START, "integrate")
            old.add_edge("integrate", END)
            old.compile(checkpointer=saver).update_state(config, {"run_id": "legacy-001", "ui": {"session_id": "ui-native"}, "adapter": {"session_id": "adapter-native"},
                                                                 "ui_packet": "/x", "adapter_packet": "/y", "integrated_commit": "d" * 40}, as_node="integrate")
        runtime = ExportRuntime(directory)
        self.assertEqual((runtime.workers, runtime.excluded), (["ui", "adapter"], []))
        exported = export_run(runtime)
        self.assertEqual(exported["version"], "1.3.0")
        self.assertEqual(exported["definition"], {"name": "Feature implementation", "nodes": old_nodes})  # Stored labels kept.
        self.assertEqual(exported["values"]["lanes"], {"ui": {"session_id": "ui-native"}, "adapter": {"session_id": "adapter-native"}})
        self.assertEqual(exported["values"]["packets"], {"ui": "/x", "adapter": "/y"})
        self.assertEqual(exported["values"]["integrated_commit"], "d" * 40)
        self.assertEqual((exported["inputs"]["selected_workers"], exported["inputs"]["excluded_workers"]), (["ui", "adapter"], []))
        self.assertEqual([worker["required_check_kinds"] for worker in exported["inputs"]["workers"].values()], [["build", "browser"], ["unit"]])
        self.assertEqual(exported["inputs"]["failure_drill"], {"node_id": "adapter", "phase": "worker", "attempt": 1})
        self.assertEqual(export_run(ExportRuntime(directory)), exported)  # Stable.
        # A review recorded with the legacy `both` attribution still exports; a plan with configured lanes refuses it.
        review = read_json(directory / "review.json")
        review["findings"][0]["worker"] = "both"
        save_json(directory / "review.json", review)
        self.assertEqual(export_run(ExportRuntime(directory))["review"]["findings"][0]["worker"], "both")
        plan = read_json(directory / "plan.json")
        plan.update(workers=["ui", "adapter"], excluded_workers=[])
        save_json(directory / "plan.json", plan)
        with self.assertRaisesRegex(ValueError, "finding worker"):
            ExportRuntime(directory)
        review["findings"][0]["worker"] = "multiple"
        save_json(directory / "review.json", review)
        self.assertEqual(export_run(ExportRuntime(directory))["review"]["findings"][0]["worker"], "multiple")


class Panes(unittest.TestCase):
    """Offline half of the panes scenario: one pane per selected lane in order, the reviewer right of the last."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        repo = self.root / "repo"
        (repo / "contracts/workflow").mkdir(parents=True)
        (repo / "contracts/workflow/workerResult.schema.json").write_text("{}")
        for args in (["init", "-q"], ["config", "user.name", "Test"], ["config", "user.email", "test@example.invalid"], ["add", "."], ["commit", "-qm", "Base"]):
            subprocess.run(["git", "-C", str(repo), *args], check=True)
        self.directory = self.root / "run"
        self.plan = prepare(self.directory, repo, "HEAD", {node: f"Read {node}" for node in LANES}, False)
        self.plan["mode"] = "interactive"
        save_json(self.directory / "plan.json", self.plan)
        self.sessions = InteractiveSessions(self.directory, executable="claude")

    def row(self, node):
        uuid = {"ui": "11111111-1111-4111-8111-111111111111", "adapter": "22222222-2222-4222-8222-222222222222",
                "docs": "44444444-4444-4444-8444-444444444444", "review": "33333333-3333-4333-8333-333333333333"}[node]
        return {"sessionId": uuid, "id": uuid[:8], "name": self.sessions.launch_name(node), "kind": "background",
                "cwd": str(self.sessions.node_worktree(node)), "state": "idle", "pid": os.getpid()}

    def test_three_lanes_get_three_panes_in_order_and_the_reviewer_splits_right_of_the_last(self):
        self.assertEqual(self.sessions.workers, LANES)
        for node in LANES + ["review"]:
            save_json(self.directory / f"{node}.interactive.json", {"plan_digest": plan_digest(self.plan), "background_id": self.row(node)["id"], "session_id": self.row(node)["sessionId"]})
        calls = []
        splits = iter(["w1:p3", "w1:p4", "w1:p5"])
        def herdr(*args):
            calls.append(args)
            if args[:2] == ("pane", "current"):
                return {"result": {"pane": {"workspace_id": "w1", "tab_id": "w1:t1"}}}
            if args[:2] == ("tab", "create"):
                return {"result": {"tab": {"tab_id": "w1:t2"}, "root_pane": {"pane_id": "w1:p2"}}}
            if args[:2] == ("pane", "split"):
                return {"result": {"pane": {"pane_id": next(splits)}}}
            if args[:2] == ("pane", "process-info"):
                return {"result": {"process_info": {"shell_pid": 1, "foreground_processes": [{"pid": 1}]}}}
            return {}
        with patch.object(self.sessions, "inventory", return_value=[self.row(node) for node in LANES + ["review"]]), patch("workflow.interactive.herdr", side_effect=herdr):
            mapping = attach_panels(self.sessions)
        self.assertEqual(list(mapping), ["ui", "adapter", "docs", "review"])
        self.assertEqual([entry["pane_id"] for entry in mapping.values()], ["w1:p2", "w1:p3", "w1:p4", "w1:p5"])
        splits_made = [(call[call.index("--pane") + 1], call[call.index("--direction") + 1]) for call in calls if call[:2] == ("pane", "split")]
        self.assertEqual(splits_made, [("w1:p2", "right"), ("w1:p3", "right"), ("w1:p4", "right")])
        self.assertIn(("pane", "rename", "w1:p4", "Claude: docs"), calls)
        runs = [call for call in calls if call[:2] == ("pane", "run")]
        self.assertEqual(len(runs), 4)
        self.assertIn("--node docs", runs[2][3])
        self.assertEqual(read_json(self.directory / "terminals.json"), mapping)
        # attach-one accepts any lane of the run or the reviewer, nothing else.
        from .interactive import main
        with patch("workflow.interactive.sys.argv", ["interactive", "attach-one", str(self.directory), "--node", "nope"]), \
                patch("workflow.interactive.sys.stdin") as stdin, contextlib.redirect_stderr(io.StringIO()) as errors:
            stdin.isatty.return_value = True
            with self.assertRaises(SystemExit):
                main()
        self.assertIn("--node must be a lane of this run (ui, adapter, docs) or review", errors.getvalue())
        with patch("workflow.interactive.sys.argv", ["interactive", "attach-one", str(self.directory), "--node", "docs"]), \
                patch("workflow.interactive.sys.stdin") as stdin, patch.object(InteractiveSessions, "inventory", return_value=[self.row("docs")]), \
                patch("workflow.interactive.os.chdir") as chdir, patch("workflow.interactive.os.execvp", side_effect=SystemExit(0)) as execvp:
            stdin.isatty.return_value = True
            with self.assertRaises(SystemExit):
                main()
        chdir.assert_called_once_with(Path(self.plan["nodes"]["docs"]["worktree"]))
        execvp.assert_called_once_with("claude", ["claude", "attach", self.row("docs")["id"]])


if __name__ == "__main__":
    unittest.main()
