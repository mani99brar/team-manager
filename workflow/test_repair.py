"""Lane repair after freeze: `repair --commit`, its journal and fork, and what the unchanged graph does next.

Fake worker sessions and a fake reviewer; real Git repositories, worktrees, checkpoints and checks. The ui lane's
build check is recorded but not gated in the worker phase, so a wrong ui.txt first blocks the combined candidate,
as workflow-guardrails-001's browser rule did. No Claude model calls and no Playwright.
"""
import contextlib
import hashlib
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from langgraph.checkpoint.sqlite import SqliteSaver
from langgraph.pregel.main import Pregel
from langgraph.types import Command

from . import checks, pipeline, repair
from .automatic import advance_failed_checks, automatic_settings, drive
from .pipeline import ExportRuntime, Pipeline, build_pipeline, export_run, graph_config
from .sessions import git, prepare, read_json, run_lock, save_json
from .test_pipeline import FakeSessions, OfflinePipeline
from .verification import policy_digest
from .worktrees import WorktreeError

# Declared order: the candidate checks adapter before ui, as 001's checked controller before ui. docs is never selected.
LANES = ["adapter", "ui", "docs"]
FAN_OUT = {"verify_adapter", "verify_ui"}
REASON = "the ui build needs the final text"


def repair_policy() -> dict:
    return {"version": "1.2.0", "feature": "Lane repair", "independent_review": True, "integration_approval": True,
            "max_verification_attempts": 3,
            "workers": [
                {"node_id": "adapter", "role": "backend", "required_check_kinds": ["unit"], "owned_paths": ["backend.py"], "checks": [
                    {"id": "unit", "kind": "unit", "argv": ["python", "-m", "unittest", "discover", "-s", "tests", "-p", "test_*.py"],
                     "timeout_seconds": 30, "scenarios": []}]},
                {"node_id": "ui", "role": "frontend", "required_check_kinds": ["build"], "owned_paths": ["ui.txt", "web"], "checks": [
                    {"id": "ui-build", "kind": "build", "argv": ["python", "-c", "from pathlib import Path; assert Path('ui.txt').read_text() == 'after'"],
                     "timeout_seconds": 30, "scenarios": []}]},
                {"node_id": "docs", "role": "writer", "required_check_kinds": ["unit"], "owned_paths": ["docs"], "checks": [
                    {"id": "docs-unit", "kind": "unit", "argv": ["python", "-c", "print('Ran 1 test in 0.001s\\n\\nOK')"], "timeout_seconds": 30, "scenarios": []}]}]}


class RepairFixture(unittest.TestCase):
    """A repository whose ui worker writes `almost` where the ui build check wants `after`."""

    automatic = True

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.repo = self.root / "repo"
        (self.repo / "tests").mkdir(parents=True)
        (self.repo / "docs").mkdir()
        (self.repo / "ui.txt").write_text("before")
        (self.repo / "backend.py").write_text("VALUE = 1\n")
        (self.repo / "docs/README.md").write_text("docs\n")
        (self.repo / ".gitignore").write_text("__pycache__/\n")
        (self.repo / "tests/test_backend.py").write_text("import unittest\nfrom backend import VALUE\n\nclass BackendTest(unittest.TestCase):\n"
                                                         "    def test_value(self):\n        self.assertEqual(VALUE, 2)\n")
        for args in (["init", "-q"], ["config", "user.name", "Test"], ["config", "user.email", "test@example.invalid"], ["add", "."], ["commit", "-qm", "Base"]):
            subprocess.run(["git", "-C", str(self.repo), *args], check=True)
        if self.automatic:
            git(self.repo, "switch", "-q", "-c", "feature/repair")
        self.prepare("run")

    def prepare(self, name: str) -> OfflinePipeline:
        directory = self.root / name
        policy = repair_policy()
        plan = prepare(directory, self.repo, "HEAD", {"adapter": "Make VALUE 2.", "ui": "Write the final text."}, True, declared=LANES)
        plan.update(mode="interactive", policy_sha256=policy_digest(policy), source_branch=git(self.repo, "symbolic-ref", "--short", "HEAD"))
        if self.automatic:
            plan["automatic"] = automatic_settings()
        save_json(directory / "plan.json", plan)
        save_json(directory / "policy.json", policy)
        self.directory = directory
        self.sessions = FakeSessions(directory, plan)
        self.sessions.edits["ui"] = ("ui.txt", "almost")
        self.runtime = OfflinePipeline(directory, self.sessions)
        return self.runtime

    @contextlib.contextmanager
    def graph(self, runtime=None):
        runtime = runtime or self.runtime
        with SqliteSaver.from_conn_string(str(runtime.directory / "pipeline.sqlite")) as saver:
            yield build_pipeline(saver, runtime), graph_config(runtime)

    def start(self):
        with self.graph() as (graph, config):
            graph.invoke({"run_id": self.runtime.plan["run_id"]}, config)

    def block_at_candidate(self):
        """Launch, freeze, verify both lanes, then fail the candidate once: its ui build check reads `almost`."""
        self.start()
        with self.graph() as (graph, config), self.assertRaisesRegex(RuntimeError, "Combined candidate failed ui checks"):
            graph.invoke(Command(resume={"freeze": True}), config)

    def cli(self, *arguments: str) -> tuple[int, str, str]:
        out, err = io.StringIO(), io.StringIO()
        code = 0
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            try:
                repair.repair_main([str(self.directory), *arguments])
            except SystemExit as exit:
                code = exit.code
        return code, out.getvalue(), err.getvalue()

    def pipeline_cli(self, *arguments: str) -> tuple[int, str, str]:
        out, err = io.StringIO(), io.StringIO()
        code = 0
        with patch.object(sys, "argv", ["workflow", *arguments]), contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            try:
                pipeline.main()
            except SystemExit as exit:
                code = exit.code
        return code, out.getvalue(), err.getvalue()

    def worktree(self, base: str) -> Path:
        path = self.root / f"fix-{len(list(self.root.glob('fix-*')))}"
        git(self.repo, "worktree", "add", "-q", "--detach", str(path), base)
        return path

    def commit_on(self, base: str, files: dict) -> str:
        """The operator's fix: a commit on `base` in a scratch worktree outside the run (None deletes a file)."""
        path = self.worktree(base)
        for name, content in files.items():
            if content is None:
                (path / name).unlink()
            else:
                (path / name).parent.mkdir(parents=True, exist_ok=True)
                (path / name).write_text(content)
        git(path, "add", "-A")
        git(path, "commit", "-qm", "operator fix")
        return git(path, "rev-parse", "HEAD")

    def candidate_commit(self, generation: int = 0) -> str:
        return read_json(self.directory / (f"candidate-{generation}.json" if generation else "candidate.json"))["commit"]

    def snapshot(self, lane: str) -> str:
        return read_json(self.directory / "snapshots.json")[lane]["commit"]

    def tree(self, commit: str) -> str:
        return git(self.repo, "rev-parse", f"{commit}^{{tree}}")

    def entries(self) -> list:
        return read_json(self.directory / "repairs.json")["repairs"]

    def events(self) -> list:
        return [json.loads(line) for line in (self.directory / "events.jsonl").read_text().splitlines()]

    def head(self) -> str:
        with self.graph() as (graph, config):
            return graph.get_state(config).config["configurable"]["checkpoint_id"]

    def untouched(self) -> tuple:
        """What a refusal must leave as it was."""
        attempts = self.directory / "attempts.json"
        refs = git(self.repo, "for-each-ref", "--format=%(refname)", "refs/workflow-repair")
        return ((self.directory / "repairs.json").exists(), attempts.read_bytes() if attempts.exists() else None, self.head(),
                (self.directory / "events.jsonl").read_bytes(), refs)


class CandidateRepairEndToEnd(RepairFixture):
    """The 001 regression: a candidate blocked twice identically is repaired on top of the candidate and reaches review."""

    def test_repair_candidate_defect_end_to_end(self):
        directory = self.directory
        self.start()
        with patch("workflow.automatic.wait_handoffs"), self.assertRaisesRegex(RuntimeError, "candidate/ui failed identically on attempts 1 and 2"):
            drive(self.runtime)
        # The identical-failure guard ends the controller with a timeline event, not silently after "controller running".
        self.assertEqual((self.events()[-1]["node"], self.events()[-1]["status"]), ("controller", "blocked"))
        self.assertIn("failed identically", self.events()[-1]["message"])
        candidate = self.candidate_commit()
        frozen = {path: path.read_bytes() for path in [directory / "snapshots.json", directory / "candidate.json",
                                                         *sorted((directory / "verification").glob("*/*/*/packet.json"))]}
        lane_ref = f"refs/workflow/{hashlib.sha256(str(directory).encode()).hexdigest()[:16]}/ui"
        self.assertEqual(git(self.repo, "rev-parse", lane_ref), self.snapshot("ui"))

        # The workspace is a detached checkout of the failing candidate with a brief of what blocked it.
        code, out, err = self.cli("ui", "--workspace")
        self.assertEqual(code, 0, err)
        workspace = directory / "repair-workspace-1"
        self.assertEqual(git(workspace, "rev-parse", "HEAD"), candidate)
        brief = (directory / "repair-workspace-1.brief.md").read_text()
        failing = directory / "verification/candidate/ui/2"
        for expected in ("ui-build: exit 1", str(failing / "packet.json"), str(failing / "check-0.log"), "ui.txt, web",
                         "python -c 'from pathlib import Path;", "never on the source branch"):
            self.assertIn(expected, brief)
        self.assertNotIn("screenshot:<id>", brief)  # The browser evidence rules are for lanes with a browser check.
        self.assertIn(f"--commit $(git -C {workspace} rev-parse HEAD)", out)
        self.assertFalse((directory / "repairs.json").exists())
        (workspace / "ui.txt").write_text("after")
        git(workspace, "commit", "-qam", "ui: the final text")
        fix = git(workspace, "rev-parse", "HEAD")

        code, out, err = self.cli("ui", "--commit", fix, "--reason", REASON)
        self.assertEqual(code, 0, err)
        self.assertIn(f"{sys.executable} -m workflow automatic {directory} --live", out)
        [entry] = self.entries()
        self.assertEqual((entry["status"], entry["base_kind"], entry["base_commit"], entry["source_commit"], entry["expected_candidate_tree"]),
                         ("applied", "candidate", candidate, fix, self.tree(fix)))
        self.assertEqual(entry["attempt_targets"], {"worker:ui": 2, "candidate:adapter": 2, "candidate:ui": 3})
        self.assertEqual(entry["attempt_floors"], entry["attempt_targets"])
        self.assertEqual(entry["blocked"]["step"], "candidate")
        self.assertEqual([(packet["path"], packet["attempt"]) for packet in entry["blocked"]["packets"]], [("verification/candidate/ui/2/packet.json", 2)])
        repaired = entry["lanes"]["ui"]["commit"]
        self.assertEqual((entry["lanes"]["ui"]["previous_commit"], entry["lanes"]["ui"]["fix_files"], entry["lanes"]["ui"]["changed_files"]),
                         (self.snapshot("ui"), ["ui.txt"], ["ui.txt"]))
        self.assertEqual(git(self.repo, "rev-parse", f"{repaired}^"), self.runtime.plan["base_commit"])
        self.assertEqual(git(self.repo, "show", f"{repaired}:ui.txt"), "after")
        self.assertIn("ui.txt", (directory / "repair-1.diff").read_text())

        with patch("workflow.automatic.wait_handoffs"):
            commit = drive(self.runtime)
        # The repaired lane got a fresh worker attempt at its new snapshot; the other lane was rechecked, not rerun.
        worker = read_json(directory / "verification/worker/ui/2/packet.json")
        self.assertEqual((worker["expected"]["output_commit"], worker["gate"]["status"]), (repaired, "passed"))
        self.assertIn(f"Operator repair 1: {REASON}", worker["result"]["summary"])
        self.assertFalse((directory / "verification/worker/adapter/2").exists())
        # A new candidate generation, checked for every lane at the raised attempts, then review and the feature branch.
        generation = read_json(directory / "candidate-1.json")
        self.assertTrue((directory / "candidate-1").is_dir())
        for lane, attempt in (("adapter", 2), ("ui", 3)):
            packet = read_json(directory / f"verification/candidate/{lane}/{attempt}/packet.json")
            self.assertEqual((packet["expected"]["output_commit"], packet["gate"]["status"]), (generation["commit"], "passed"))
        bundle = read_json(directory / "review-bundle.json")
        self.assertEqual(bundle["candidate_commit"], generation["commit"])
        self.assertEqual((bundle["snapshots"]["ui"]["commit"], bundle["snapshots"]["ui"]["repair"]["n"], bundle["snapshots"]["ui"]["repair"]["source_commit"]),
                         (repaired, 1, fix))
        self.assertEqual(bundle["snapshots"]["ui"]["session_id"], read_json(directory / "snapshots.json")["ui"]["session_id"])
        self.assertEqual((git(self.repo, "rev-parse", "HEAD"), self.tree(commit)), (commit, self.tree(fix)))
        self.assertEqual(sorted(self.sessions.starts), ["adapter", "review", "ui"])
        prompt = (directory / "review.prompt.txt").read_text()
        self.assertIn(f"Lane(s) ui were repaired by the operator before review (repair 1: {REASON}); the operator's change is {directory / 'repair-1.diff'}", prompt)
        # Generation 0 and every earlier packet and ref stay as they were.
        for path, content in frozen.items():
            self.assertEqual(path.read_bytes(), content, path)
        self.assertEqual(git(self.repo, "rev-parse", lane_ref), self.snapshot("ui"))

        # The timeline, the export, the report and status show the repair.
        repair_events = [(event["node"], event["status"]) for event in self.events() if event["message"].startswith("Repair 1")]
        self.assertEqual(repair_events, [("verify_ui", "paused"), ("candidate", "paused"), ("controller", "running")])
        paused = next(event["message"] for event in self.events() if event["node"] == "verify_ui" and event["status"] == "paused")
        self.assertIn(f"on candidate {candidate[:8]} (ui.txt). Reason: {REASON}. Answers candidate/ui attempt 2: ", paused)
        self.assertIn("automatic", paused)
        exported = read_json(directory / "run-state.json")
        self.assertEqual(exported["values"]["snapshots"]["ui"]["repair"]["reason"], REASON)
        listed = {(packet["phase"], packet["node_id"], packet["attempt"]) for packet in exported["verification_packets"]}
        self.assertLessEqual({("worker", "ui", 1), ("worker", "ui", 2), ("candidate", "ui", 2), ("candidate", "ui", 3)}, listed)
        self.assertIn("<h2>Repairs</h2>", (directory / "report.html").read_text())
        code, out, err = self.pipeline_cli("status", str(directory))
        self.assertEqual(code, 0, err)
        status = json.loads(out[:out.rindex("}") + 1])
        self.assertEqual(status["repairs"], [{"n": 1, "status": "applied", "lanes": ["ui"], "commit": fix}])
        self.assertEqual(status["repair_workspaces"], ["repair-workspace-1"])
        before = (directory / "run-state.json").read_bytes()
        export_run(ExportRuntime(directory))
        self.assertEqual((directory / "run-state.json").read_bytes(), before)


class ForkPoint(RepairFixture):
    """The fork is taken at the freeze boundary, never on the failed head."""

    automatic = False

    def test_repair_forks_at_the_freeze_boundary_and_a_second_repair_forks_from_the_first(self):
        self.block_at_candidate()
        with self.graph() as (graph, config):
            failed = graph.get_state(config).config["configurable"]["checkpoint_id"]
            boundary = next(item for item in graph.get_state_history(config) if set(item.next) == FAN_OUT).config["configurable"]["checkpoint_id"]
        first_candidate = self.candidate_commit()
        fix = self.commit_on(first_candidate, {"ui.txt": "closer"})
        with patch.object(Pregel, "update_state", autospec=True, side_effect=Pregel.update_state) as update:
            code, out, err = self.cli("ui", "--commit", fix, "--reason", "first try")
        self.assertEqual(code, 0, err)
        self.assertIn(f"{sys.executable} -m workflow retry {self.directory}", out)
        # Never the bare thread config: the fork point's own config, which carries its checkpoint_id.
        self.assertEqual(update.call_count, 1)
        self.assertEqual(update.call_args.args[1]["configurable"]["checkpoint_id"], boundary)
        self.assertEqual(update.call_args.kwargs["as_node"], "handoff")
        with self.graph() as (graph, config):
            head = graph.get_state(config)
            self.assertEqual(set(head.next), FAN_OUT)
            self.assertEqual((head.values.get("packets", {}), [task.error for task in head.tasks if task.error]), ({}, []))
            self.assertEqual((head.metadata["source"], head.parent_config["configurable"]["checkpoint_id"]), ("update", boundary))
            self.assertEqual(head.values["snapshots"]["ui"]["commit"], self.entries()[0]["lanes"]["ui"]["commit"])
            self.assertIn(failed, [item.config["configurable"]["checkpoint_id"] for item in graph.get_state_history(config)])
            first_fork = head.config["configurable"]["checkpoint_id"]
            self.assertEqual(self.entries()[0]["head_after"], first_fork)
            mark = len(self.events())
            with self.assertRaisesRegex(RuntimeError, "Combined candidate failed ui checks"):
                graph.invoke(None, config)
        # The candidate ran once, after both verifies, as generation 1.
        steps = [event["node"] for event in self.events()[mark:]]
        self.assertEqual(sorted(steps[:4]), ["verify_adapter", "verify_adapter", "verify_ui", "verify_ui"])
        self.assertEqual(steps[4:], ["candidate_adapter", "candidate_ui"])
        second_candidate = self.candidate_commit(1)
        self.assertNotEqual(second_candidate, first_candidate)

        # A fix on the superseded candidate is stale; on the current one it forks from the first repair's fork.
        stale = self.commit_on(first_candidate, {"ui.txt": "after"})
        code, _, err = self.cli("ui", "--commit", stale, "--reason", "second try")
        self.assertEqual(code, 1)
        self.assertIn("earlier generation", err)
        fix = self.commit_on(second_candidate, {"ui.txt": "after"})
        code, out, err = self.cli("ui", "--commit", fix, "--reason", "second try")
        self.assertEqual(code, 0, err)
        second = self.entries()[1]
        self.assertEqual((second["n"], second["fork_from"], second["base_commit"]), (2, first_fork, second_candidate))
        self.assertEqual(second["attempt_targets"], {"worker:ui": 3, "candidate:adapter": 3, "candidate:ui": 3})
        with self.graph() as (graph, config):
            self.assertEqual(graph.get_state(config).parent_config["configurable"]["checkpoint_id"], first_fork)
            outcome = graph.invoke(None, config)
        self.assertEqual(outcome["__interrupt__"][0].value["kind"], "independent_review")
        self.assertEqual(read_json(self.directory / "review-bundle.json")["candidate_commit"], self.candidate_commit(2))
        summary = read_json(self.directory / "review-bundle.json")["snapshots"]["ui"]["summary"]
        self.assertIn("Operator repair 1: first try", summary)
        self.assertIn("Operator repair 2: second try", summary)

    def test_a_head_update_would_check_the_candidate_with_stale_packets_and_is_refused(self):
        """The rejected alternative: update_state on the failed head schedules the candidate beside the verifies with the
        new snapshots and the old packets. candidate() refuses to bundle packets of another revision."""
        self.block_at_candidate()
        fix = self.commit_on(self.snapshot("ui"), {"ui.txt": "after"})
        with self.graph() as (graph, config):
            values = graph.get_state(config).values
            snapshots = {**values["snapshots"], "ui": {**values["snapshots"]["ui"], "commit": fix}}
            graph.update_state(config, {"snapshots": snapshots}, as_node="handoff")
            head = graph.get_state(config)
            self.assertIn("candidate", head.next)
            with self.assertRaisesRegex(ValueError, "Worker evidence for ui is not of its snapshot"):
                self.runtime.candidate(head.values)


class WorkerPhaseRepair(RepairFixture):
    """A lane blocked by its own unit check is repaired on its snapshot and gets a fresh worker attempt."""

    def test_worker_phase_block_is_repaired(self):
        directory = self.directory
        self.sessions.edits.update(adapter=("backend.py", "VALUE = 5\n"), ui=("ui.txt", "after"))
        self.start()
        with patch("workflow.automatic.wait_handoffs"), self.assertRaisesRegex(RuntimeError, "worker/adapter failed identically on attempts 1 and 2"):
            drive(self.runtime)
        ui_packet = directory / "verification/worker/ui/1/packet.json"
        ui_bytes = ui_packet.read_bytes()
        snapshot = self.snapshot("adapter")
        self.assertEqual(self.cli("adapter,ui", "--workspace")[0], 1)  # Several lanes need a candidate base.
        code, out, err = self.cli("adapter", "--workspace")
        self.assertEqual(code, 0, err)
        workspace = directory / "repair-workspace-1"
        self.assertEqual(git(workspace, "rev-parse", "HEAD"), snapshot)
        brief = (directory / "repair-workspace-1.brief.md").read_text()
        for expected in ("unit: exit 1", str(directory / "verification/worker/adapter/2/check-0.log"), "backend.py", "-m unittest discover"):
            self.assertIn(expected, brief)
        (workspace / "backend.py").write_text("VALUE = 2\n")
        git(workspace, "commit", "-qam", "adapter: VALUE is 2")
        fix = git(workspace, "rev-parse", "HEAD")
        code, out, err = self.cli("adapter", "--commit", fix, "--reason", "VALUE must be 2")
        self.assertEqual(code, 0, err)
        [entry] = self.entries()
        self.assertEqual((entry["base_kind"], entry["base_commit"], entry["expected_candidate_tree"]), ("snapshot", snapshot, None))
        # A worker-phase block raises no candidate counter: no candidate attempt directory exists yet.
        self.assertEqual(entry["attempt_targets"], {"worker:adapter": 3})
        with patch("workflow.automatic.wait_handoffs"):
            commit = drive(self.runtime)
        packet = read_json(directory / "verification/worker/adapter/3/packet.json")
        self.assertEqual((packet["expected"]["output_commit"], packet["gate"]["status"]), (entry["lanes"]["adapter"]["commit"], "passed"))
        self.assertEqual(ui_packet.read_bytes(), ui_bytes)
        self.assertFalse((directory / "verification/worker/ui/2").exists())
        self.assertFalse((directory / "candidate.json").exists())
        self.assertEqual(read_json(directory / "candidate-1.json")["commit"], commit)
        self.assertEqual(git(self.repo, "show", "HEAD:backend.py"), "VALUE = 2")


class RepairAfterWorkerRefailure(RepairFixture):
    """A repair whose continuation fails the lane's own check again: a failed verify writes no checkpoint, so the head
    stays the repair's fork with the error pending, and that is a continued run a second repair may fork from."""

    def test_second_repair_after_the_first_fails_its_worker_check(self):
        directory = self.directory
        self.sessions.edits.update(adapter=("backend.py", "VALUE = 5\n"), ui=("ui.txt", "after"))
        self.start()
        with patch("workflow.automatic.wait_handoffs"), self.assertRaisesRegex(RuntimeError, "worker/adapter failed identically on attempts 1 and 2"):
            drive(self.runtime)
        wrong = self.commit_on(self.snapshot("adapter"), {"backend.py": "VALUE = 3\n"})
        self.assertEqual(self.cli("adapter", "--commit", wrong, "--reason", "first try")[0], 0)
        first = self.entries()[0]
        # Not continued yet: an applied repair is not replaced, and there is nothing to make a workspace for.
        before = self.untouched()
        for arguments in (("adapter", "--commit", self.commit_on(self.snapshot("adapter"), {"backend.py": "VALUE = 2\n"}), "--reason", "again"),
                          ("adapter", "--workspace")):
            code, _, err = self.cli(*arguments)
            self.assertEqual(code, 1)
            self.assertIn("Repair 1 is applied and the run has not continued from it", err)
        self.assertEqual(self.untouched(), before)
        self.assertFalse((directory / "repair-workspace-1").exists())

        with patch("workflow.automatic.wait_handoffs"), self.assertRaisesRegex(RuntimeError, "worker/adapter failed identically on attempts 3 and 4"):
            drive(self.runtime)
        self.assertEqual(self.head(), first["head_after"])  # The failed verify superstep left the fork as the head.
        code, out, err = self.cli("adapter", "--workspace")
        self.assertEqual(code, 0, err)
        workspace = directory / "repair-workspace-1"
        self.assertEqual(git(workspace, "rev-parse", "HEAD"), first["lanes"]["adapter"]["commit"])
        (workspace / "backend.py").write_text("VALUE = 2\n")
        git(workspace, "commit", "-qam", "adapter: VALUE is 2")
        fix = git(workspace, "rev-parse", "HEAD")
        code, out, err = self.cli("adapter", "--commit", fix, "--reason", "second try")
        self.assertEqual(code, 0, err)
        second = self.entries()[1]
        self.assertEqual((second["fork_from"], second["base_kind"], second["base_commit"], second["attempt_targets"]),
                         (first["head_after"], "snapshot", first["lanes"]["adapter"]["commit"], {"worker:adapter": 5}))
        with self.graph() as (graph, config):
            head = graph.get_state(config)
            self.assertEqual((set(head.next), [task.error for task in head.tasks if task.error]), (FAN_OUT, []))

        with patch("workflow.automatic.wait_handoffs"):
            commit = drive(self.runtime)
        packet = read_json(directory / "verification/worker/adapter/5/packet.json")
        self.assertEqual((packet["expected"]["output_commit"], packet["gate"]["status"]), (second["lanes"]["adapter"]["commit"], "passed"))
        self.assertEqual(read_json(directory / "candidate-2.json")["commit"], commit)
        self.assertEqual(git(self.repo, "show", "HEAD:backend.py"), "VALUE = 2")
        self.assertIn("(repair 2: second try)", (directory / "review.prompt.txt").read_text())


class SnapshotBaseAndSpanningFixes(RepairFixture):
    automatic = False

    def test_lane_snapshot_base(self):
        self.block_at_candidate()
        fix = self.commit_on(self.snapshot("ui"), {"ui.txt": "after", "web/page.txt": "new\n"})
        code, _, err = self.cli("ui", "--commit", fix, "--reason", REASON)
        self.assertEqual(code, 0, err)
        [entry] = self.entries()
        repaired = entry["lanes"]["ui"]["commit"]
        self.assertEqual((entry["base_kind"], entry["base_commit"], entry["expected_candidate_tree"]), ("snapshot", self.snapshot("ui"), None))
        self.assertEqual((self.tree(repaired), git(self.repo, "rev-parse", f"{repaired}^")), (self.tree(fix), self.runtime.plan["base_commit"]))
        changed = git(self.repo, "diff-tree", "-r", "--no-renames", "--name-only", self.runtime.plan["base_commit"], repaired).splitlines()
        self.assertEqual(entry["lanes"]["ui"]["changed_files"], sorted(changed))
        self.assertEqual(entry["lanes"]["ui"]["fix_files"], ["ui.txt", "web/page.txt"])
        with self.graph() as (graph, config):
            self.assertEqual(graph.invoke(None, config)["__interrupt__"][0].value["kind"], "independent_review")

    def test_one_fix_spanning_two_lanes(self):
        self.block_at_candidate()
        fix = self.commit_on(self.candidate_commit(), {"ui.txt": "after", "backend.py": "VALUE = 2  # checked\n"})
        before = self.untouched()
        code, _, err = self.cli("ui", "--commit", fix, "--reason", REASON)
        self.assertEqual(code, 1)
        self.assertIn("backend.py, owned by lane adapter, which this repair does not name", err)
        # On a lane snapshot, overlaying base content onto a second lane would discard its work: one lane only.
        spanning = self.commit_on(self.snapshot("ui"), {"ui.txt": "after", "backend.py": "VALUE = 2\n"})
        code, _, err = self.cli("adapter,ui", "--commit", spanning, "--reason", REASON)
        self.assertEqual(code, 1)
        self.assertIn("one lane", err)
        self.assertEqual(self.untouched(), before)
        code, _, err = self.cli("ui,adapter", "--commit", fix, "--reason", REASON)
        self.assertEqual(code, 0, err)
        [entry] = self.entries()
        self.assertEqual(list(entry["lanes"]), ["adapter", "ui"])
        self.assertEqual([entry["lanes"][lane]["fix_files"] for lane in ("adapter", "ui")], [["backend.py"], ["ui.txt"]])
        self.assertEqual([entry["lanes"][lane]["changed_files"] for lane in ("adapter", "ui")], [["backend.py"], ["ui.txt"]])
        with self.graph() as (graph, config):
            self.assertEqual(graph.invoke(None, config)["__interrupt__"][0].value["kind"], "independent_review")
        self.assertEqual(self.tree(self.candidate_commit(1)), self.tree(fix))


class RefusedCommits(RepairFixture):
    automatic = False

    def commit_with(self, base: str, change) -> str:
        path = self.worktree(base)
        change(path)
        git(path, "commit", "-qm", "operator fix")
        return git(path, "rev-parse", "HEAD")

    def test_refused_commits_change_nothing(self):
        self.block_at_candidate()
        candidate, base = self.candidate_commit(), self.runtime.plan["base_commit"]
        good = self.commit_on(candidate, {"ui.txt": "after"})

        def symlink(path):
            (path / "web").mkdir()
            (path / "web/link").symlink_to("../ui.txt")
            git(path, "add", "-A")

        def gitlink(path):
            git(path, "update-index", "--add", "--cacheinfo", f"160000,{base},web/module")

        cases = {
            "an unknown sha": (("ui", "--commit", "f" * 40, "--reason", REASON), "is not a commit"),
            "an unrelated commit": (("ui", "--commit", self.commit_on(base, {"ui.txt": "after"}), "--reason", REASON), "descends from neither"),
            "the same tree": (("ui", "--commit", candidate, "--reason", REASON), "changes nothing in the ui snapshot"),
            "an unowned path": (("ui", "--commit", self.commit_on(candidate, {"ui.txt": "after", "notes.txt": "x"}), "--reason", REASON),
                                "notes.txt, which no lane owns"),
            "an excluded lane's path": (("ui", "--commit", self.commit_on(candidate, {"ui.txt": "after", "docs/extra.md": "x"}), "--reason", REASON),
                                        "docs/extra.md, owned by excluded lane docs"),
            "a symlink": (("ui", "--commit", self.commit_with(candidate, symlink), "--reason", REASON), "Symlink changes"),
            "a gitlink": (("ui", "--commit", self.commit_with(candidate, gitlink), "--reason", REASON), "Gitlink"),
            "an unknown lane": (("docs", "--commit", good, "--reason", REASON), "Not a lane of this run: docs"),
            "a repeated lane": (("ui,ui", "--commit", good, "--reason", REASON), "twice"),
            "a malformed lane list": (("ui,", "--commit", good, "--reason", REASON), "comma-separated"),
            "an empty reason": (("ui", "--commit", good, "--reason", "  "), "--reason"),
            "no reason": (("ui", "--commit", good), "--reason"),
            "--commit with --workspace": (("ui", "--commit", good, "--reason", REASON, "--workspace"), "exactly one of --commit"),
            "neither --commit nor --workspace": (("ui", "--reason", REASON), "exactly one of --commit"),
        }
        before = self.untouched()
        for label, (arguments, message) in cases.items():
            with self.subTest(label):
                code, out, err = self.cli(*arguments)
                self.assertEqual(code, 1, out)
                self.assertIn(f"Blocked: ", err)
                self.assertIn(message, err)
                self.assertEqual(self.untouched(), before)


class RefusedStates(RepairFixture):
    def refused(self, message: str, *arguments: str):
        code, out, err = self.cli(*arguments)
        self.assertEqual(code, 1, out)
        self.assertIn(message, err)

    def test_refused_states(self):
        base = self.runtime.plan["base_commit"]
        early = ("ui", "--commit", base, "--reason", REASON)
        with self.subTest("before start"):
            self.refused("never started", *early)
            self.assertFalse((self.directory / "pipeline.sqlite").exists())
        self.start()
        with self.subTest("at worker_handoff"):
            self.refused("before freeze", *early)
        with self.graph() as (graph, config), self.assertRaises(RuntimeError):
            graph.invoke(Command(resume={"freeze": True}), config)
        arguments = ("ui", "--commit", self.commit_on(self.candidate_commit(), {"ui.txt": "after"}), "--reason", REASON)
        before = self.untouched()
        for name in ("review-bundle.json", "review.json", "integration-intent.json"):
            with self.subTest(name):
                (self.directory / name).write_text("{}")
                self.refused("Reviewers have seen a candidate", *arguments)
                (self.directory / name).unlink()
        for lock in ("controller.lock", "automatic-supervisor.lock"):
            with self.subTest(lock), run_lock(self.directory, lock):
                self.refused("Another controller owns this run", *arguments)
        with self.subTest("source moved"):
            git(self.repo, "commit", "-q", "--allow-empty", "-m", "a fix on the pinned branch")
            self.refused("moved from the run's base", *arguments)
            git(self.repo, "reset", "-q", "--hard", base)
        with self.subTest("source dirty"):
            (self.repo / "stray.txt").write_text("x")
            self.refused("uncommitted changes", *arguments)
            (self.repo / "stray.txt").unlink()
        with self.subTest("another branch"):
            git(self.repo, "switch", "-q", "-c", "other")
            self.refused("not the run's branch feature/repair", *arguments)
            git(self.repo, "switch", "-q", "feature/repair")
        with self.subTest("interrupted attempt"):
            save_json(self.directory / "attempts.json", {"candidate:ui": 2})
            (self.directory / "verification/candidate/ui/2").mkdir()
            self.refused("Interrupted check", *arguments)
            (self.directory / "verification/candidate/ui/2").rmdir()
        with self.subTest("no blocked packet"):
            self.refused("not a check verdict", *arguments)
            (self.directory / "attempts.json").unlink()
        self.assertEqual(self.untouched(), before)
        with self.subTest("MAX_REPAIRS"):
            save_json(self.directory / "repairs.json", {"version": "1.0.0", "repairs": [{"n": n, "status": "applied", "lanes": {}, "attempt_floors": {}}
                                                                                         for n in range(1, repair.MAX_REPAIRS + 1)]})
            self.refused("start a revised run", *arguments)
            (self.directory / "repairs.json").unlink()
        with self.subTest("a failed launch"):
            self.prepare("launch-failed")
            self.sessions.run = lambda node: (_ for _ in ()).throw(RuntimeError("launch failed"))
            with self.graph() as (graph, config), self.assertRaises(RuntimeError):
                graph.invoke({"run_id": "launch-failed"}, config)
            self.refused("use reconcile", *early)
        with self.subTest("a legacy plan"):
            self.prepare("legacy")
            plan = read_json(self.directory / "plan.json")
            del plan["workers"], plan["excluded_workers"]
            save_json(self.directory / "plan.json", plan)
            self.refused("pinned before configured lanes", *early)


def ui_worktree_fails_once():
    """Git cannot create the ui lane's worker verification worktree on attempt 1: its attempt directory keeps no packet."""
    real = checks.git_worktree
    def locked(repository, *arguments):
        if "/verification/worker/ui/1/" in arguments[-2]:
            raise WorktreeError(128, ["git", "worktree", *arguments], "", "fatal: cannot lock ref 'HEAD': File exists")
        return real(repository, *arguments)
    return patch("workflow.checks.git_worktree", side_effect=locked)


class InterruptedCheckOnAnAutomaticRun(RepairFixture):
    """A check whose attempt directory has no packet (Git could not create its worktree, or its verify was interrupted)
    is no verdict: repair refuses it and names the continuation of the run's mode."""

    def test_retry_raises_the_attempt_and_the_supervisor_reruns_the_check(self):
        directory = self.directory
        self.sessions.edits["ui"] = ("ui.txt", "after")
        self.start()
        with ui_worktree_fails_once(), patch("workflow.automatic.wait_handoffs"), self.assertRaisesRegex(RuntimeError, "Non-retryable"):
            drive(self.runtime)
        folder = directory / "verification/worker/ui/1"
        self.assertTrue(folder.is_dir() and not (folder / "packet.json").exists())
        retry = f"{sys.executable} -m workflow retry {directory} --phase worker --node ui"
        automatic = f"{sys.executable} -m workflow automatic {directory} --live"
        code, _, err = self.cli("ui", "--workspace")
        self.assertEqual(code, 1)
        self.assertIn(f"Interrupted check at {folder}; rerun it at its next attempt with: {retry}, then {automatic}\n", err)
        # retry only raises the attempt: it runs no check, and no review node, outside the supervisor.
        launches = (directory / "fake-launches.log").read_text()
        with patch("workflow.pipeline.InteractiveSessions", side_effect=lambda run, timeout: self.sessions):
            code, out, err = self.pipeline_cli("retry", str(directory), "--phase", "worker", "--node", "ui")
        self.assertEqual(code, 0, err)
        self.assertIn(f"worker/ui will run attempt 2; nothing ran. An automatic run continues under its supervisor: {automatic}", out)
        self.assertEqual(read_json(directory / "attempts.json"), {"worker:ui": 2})
        self.assertFalse((directory / "verification/worker/ui/2").exists())
        self.assertEqual((directory / "fake-launches.log").read_text(), launches)
        # A rerun that fails before its check starts is not rerun again: the request is consumed first.
        with patch.object(self.runtime, "verify", side_effect=RuntimeError("before the check")), patch("workflow.automatic.wait_handoffs"), \
                self.assertRaisesRegex(RuntimeError, "Non-retryable"):
            drive(self.runtime)
        self.assertFalse((directory / "retry-requests.json").exists())
        self.assertFalse((directory / "verification/worker/ui/2").exists())
        with patch("workflow.pipeline.InteractiveSessions", side_effect=lambda run, timeout: self.sessions):
            code, out, err = self.pipeline_cli("retry", str(directory), "--phase", "worker", "--node", "ui")
        self.assertEqual((code, read_json(directory / "retry-requests.json")), (0, {"worker:ui": 3}), err)
        # automatic --live's controller reruns the check at the raised attempt and carries the run to the feature branch.
        with patch("workflow.automatic.wait_handoffs"):
            commit = drive(self.runtime)
        self.assertEqual(read_json(directory / "verification/worker/ui/3/packet.json")["gate"]["status"], "passed")
        self.assertFalse((directory / "verification/worker/adapter/2").exists())
        self.assertFalse((directory / "retry-requests.json").exists())
        self.assertIn(("controller", "running", "Rerunning worker:ui at the attempt retry raised"),
                      [(event["node"], event["status"], event["message"]) for event in self.events()])
        self.assertEqual(git(self.repo, "rev-parse", "HEAD"), commit)
        self.assertEqual(sorted(self.sessions.starts), ["adapter", "review", "ui"])


class InterruptedCheckOnAManualRun(RepairFixture):
    automatic = False

    def test_retry_reruns_the_check_itself_up_to_the_review_gate(self):
        directory = self.directory
        self.sessions.edits["ui"] = ("ui.txt", "after")
        self.start()
        with ui_worktree_fails_once(), self.graph() as (graph, config), self.assertRaises(WorktreeError):
            graph.invoke(Command(resume={"freeze": True}), config)
        folder = directory / "verification/worker/ui/1"
        code, _, err = self.cli("ui", "--workspace")
        self.assertEqual(code, 1)
        self.assertIn(f"Interrupted check at {folder}; rerun it at its next attempt with: {sys.executable} -m workflow retry {directory} "
                      "--phase worker --node ui\n", err)
        with patch("workflow.pipeline.InteractiveSessions", side_effect=lambda run, timeout: self.sessions):
            code, out, err = self.pipeline_cli("retry", str(directory), "--phase", "worker", "--node", "ui")
        self.assertEqual(code, 0, err)
        self.assertEqual(read_json(directory / "verification/worker/ui/2/packet.json")["gate"]["status"], "passed")
        with self.graph() as (graph, config):
            state = graph.get_state(config)
        self.assertEqual([item.value["kind"] for task in state.tasks for item in task.interrupts], ["independent_review"])


class CrashRecovery(RepairFixture):
    def test_crash_at_each_repair_step_is_completed_by_rerunning_it(self):
        for index, step in enumerate(("commit_snapshots", "save_lanes", "raise_attempts", "fork_run", "finish_repair")):
            with self.subTest(crash_before=step):
                self.prepare(f"run-{index}")
                self.block_at_candidate()
                fix = self.commit_on(self.candidate_commit(), {"ui.txt": "after"})
                arguments = ("ui", "--commit", fix, "--reason", REASON)
                with patch(f"workflow.repair.{step}", side_effect=RuntimeError("injected crash")):
                    code, _, err = self.cli(*arguments)
                self.assertEqual(code, 1)
                self.assertIn("injected crash", err)
                self.assertEqual(self.entries()[0]["status"], "recorded")
                prefix = f"refs/workflow-repair/{hashlib.sha256(str(self.directory).encode()).hexdigest()[:16]}/1"
                crashed = git(self.repo, "for-each-ref", "--format=%(objectname)", f"{prefix}/ui")
                # The failed branch never resumes with raised counters, and only the identical command completes the repair.
                with self.assertRaisesRegex(RuntimeError, "Repair 1 is recorded but not applied"):
                    drive(self.runtime)
                code, _, err = self.pipeline_cli("retry", str(self.directory))
                self.assertEqual(code, 1)
                self.assertIn("Repair 1 is recorded but not applied", err)
                for other in (("ui", "--commit", fix, "--reason", "another reason"), ("ui", "--workspace")):
                    code, _, err = self.cli(*other)
                    self.assertEqual(code, 1)
                    self.assertIn("Repair 1 is recorded but not applied", err)
                code, out, err = self.cli(*arguments)
                self.assertEqual(code, 0, err)
                [entry] = self.entries()
                self.assertEqual(entry["status"], "applied")
                if crashed:
                    self.assertEqual(entry["lanes"]["ui"]["commit"], crashed)  # The pinned dates make the same commit.
                self.assertEqual(git(self.repo, "rev-parse", f"{prefix}/ui"), entry["lanes"]["ui"]["commit"])
                self.assertEqual(read_json(self.directory / "attempts.json"), entry["attempt_targets"])
                with self.graph() as (graph, config):
                    forks = [item for item in graph.get_state_history(config) if item.metadata.get("source") == "update"]
                    self.assertEqual(len(forks), 1)
                    self.assertEqual(forks[0].config["configurable"]["checkpoint_id"], entry["head_after"])
                with patch("workflow.automatic.wait_handoffs"):
                    drive(self.runtime)
                self.assertEqual(self.tree(git(self.repo, "rev-parse", "HEAD")), self.tree(fix))
                git(self.repo, "reset", "-q", "--hard", self.runtime.plan["base_commit"])  # The next subtest's run starts from the base again.


class IdenticalFailureGuard(unittest.TestCase):
    """advance_failed_checks compares two failures only when both checked the same revision."""

    def test_identical_failure_guard_compares_only_the_same_revision(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        root = Path(temp.name)
        attempts = {"candidate:ui": 3}
        bumped = []
        runtime = type("Runtime", (), {})()
        runtime.directory, runtime.policy, runtime.workers = root, {"max_verification_attempts": 3}, ["ui", "adapter"]
        runtime.attempt = lambda phase, node: attempts.get(f"{phase}:{node}", 1)
        runtime.retry_check = lambda phase, node: bumped.append((phase, node))
        state = type("State", (), {"next": ("candidate",), "tasks": [type("Task", (), {"name": "candidate", "error": "blocked"})()]})()
        save_json(root / "repairs.json", {"version": "1.0.0", "repairs": [{"n": 1, "status": "applied", "lanes": {}, "attempt_floors": {"candidate:ui": 3}}]})
        reasons = ["ui-build: exit 1", "Executed check failed: python -c ..."]
        for attempt, commit in ((2, "a" * 40), (3, "b" * 40)):
            (root / "verification/candidate/ui" / str(attempt)).mkdir(parents=True)
            save_json(root / "verification/candidate/ui" / str(attempt) / "packet.json",
                      {"expected": {"output_commit": commit}, "gate": {"status": "blocked", "reasons": reasons}})
        # The repaired revision's first failure gets the normal retry, within its own budget.
        self.assertTrue(advance_failed_checks(runtime, state))
        self.assertEqual(bumped, [("candidate", "ui")])
        save_json(root / "verification/candidate/ui/3/packet.json", {"expected": {"output_commit": "a" * 40}, "gate": {"status": "blocked", "reasons": reasons}})
        with self.assertRaisesRegex(RuntimeError, "candidate/ui failed identically on attempts 2 and 3"):
            advance_failed_checks(runtime, state)


class AttemptBudget(unittest.TestCase):
    """The attempt limit is per lane, phase and revision: a repair's floor starts its revision's budget."""

    def test_attempt_budget_is_per_revision(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        root = Path(temp.name)
        runtime = Pipeline.__new__(Pipeline)
        runtime.directory, runtime.policy, runtime.workers = root, {"max_verification_attempts": 3}, ["ui"]
        save_json(root / "repairs.json", {"version": "1.0.0", "repairs": [{"n": 1, "status": "applied", "lanes": {}, "attempt_floors": {"candidate:ui": 3}},
                                                                          {"n": 2, "status": "recorded", "lanes": {}, "attempt_floors": {"worker:ui": 9}}]})
        for value in (3, 4, 5):
            save_json(root / "attempts.json", {"candidate:ui": value})
            self.assertEqual(runtime.attempt("candidate", "ui"), value)
        for value in (2, 6):
            save_json(root / "attempts.json", {"candidate:ui": value})
            with self.assertRaisesRegex(ValueError, "hard limit"):
                runtime.attempt("candidate", "ui")
        save_json(root / "attempts.json", {"candidate:ui": 4, "worker:ui": 3})
        self.assertEqual(runtime.retry_check("candidate", "ui"), 5)
        with self.assertRaisesRegex(ValueError, "limit reached"):
            runtime.retry_check("candidate", "ui")
        # A key no applied repair floors keeps 1..3; a recorded entry's floors do not count until it is applied.
        with self.assertRaisesRegex(ValueError, "limit reached"):
            runtime.retry_check("worker", "ui")
        (root / "verification/candidate/ui/5").mkdir(parents=True)
        save_json(root / "verification/candidate/ui/5/packet.json", {"expected": {"output_commit": "c" * 40}, "gate": {"status": "blocked", "reasons": ["x"]}})
        state = type("State", (), {"next": ("candidate",), "tasks": [type("Task", (), {"name": "candidate", "error": "blocked"})()]})()
        with self.assertRaisesRegex(RuntimeError, "retry limit exhausted"):
            advance_failed_checks(runtime, state)
        save_json(root / "attempts.json", {"candidate:ui": 4})
        (root / "verification/candidate/ui/5").rename(root / "verification/candidate/ui/4")
        self.assertTrue(advance_failed_checks(runtime, state))
        self.assertEqual(read_json(root / "attempts.json")["candidate:ui"], 5)


class CandidateGenerations(RepairFixture):
    automatic = False

    def test_candidate_generation_paths_and_tree_assertion(self):
        self.block_at_candidate()
        fix = self.commit_on(self.candidate_commit(), {"ui.txt": "after"})
        self.assertEqual(self.cli("ui", "--commit", fix, "--reason", REASON)[0], 0)
        (self.directory / "candidate-1").mkdir()
        with self.graph() as (graph, config), self.assertRaisesRegex(ValueError, "Partial candidate worktree"):
            graph.invoke(None, config)
        (self.directory / "candidate-1").rmdir()
        journal = read_json(self.directory / "repairs.json")
        tampered = json.loads(json.dumps(journal))
        tampered["repairs"][0]["expected_candidate_tree"] = self.tree(self.runtime.plan["base_commit"])
        save_json(self.directory / "repairs.json", tampered)
        with self.graph() as (graph, config), self.assertRaisesRegex(ValueError, "differs from the repaired tree"):
            graph.invoke(None, config)
        save_json(self.directory / "repairs.json", journal)
        with self.graph() as (graph, config):
            self.assertEqual(graph.invoke(None, config)["__interrupt__"][0].value["kind"], "independent_review")
        self.assertTrue((self.directory / "candidate-1").is_dir())
        self.assertEqual(read_json(self.directory / "review-bundle.json")["candidate_commit"], self.candidate_commit(1))
        self.assertEqual(self.tree(self.candidate_commit(1)), self.tree(fix))


class RepairCommandLine(RepairFixture):
    """The real command in its own process: a dry run writes nothing, and nothing ever calls claude."""

    def listing(self) -> dict:
        return {str(path.relative_to(self.directory)): path.read_bytes() if path.is_file() and not path.is_symlink() else None
                for path in sorted(self.directory.rglob("*"))}

    def test_repair_cli_launches_nothing(self):
        self.block_at_candidate()
        fix = self.commit_on(self.candidate_commit(), {"ui.txt": "after"})
        bin_directory = self.root / "bin"
        bin_directory.mkdir()
        calls = self.root / "claude-calls.log"
        (bin_directory / "claude").write_text(f"#!/bin/sh\necho \"$@\" >> {calls}\nexit 1\n")
        (bin_directory / "claude").chmod(0o700)
        env = {**os.environ, "PATH": f"{bin_directory}{os.pathsep}{os.environ['PATH']}"}
        for lock in ("controller.lock", "automatic-supervisor.lock"):
            (self.directory / lock).touch()  # A real run's controllers made them.
        command = [sys.executable, "-m", "workflow", "repair", str(self.directory), "ui", "--commit", fix, "--reason", REASON]
        cwd = Path(__file__).resolve().parents[1]
        before, launches = self.listing(), (self.directory / "fake-launches.log").read_text()
        result = subprocess.run([*command, "--dry-run"], cwd=cwd, env=env, capture_output=True, text=True, timeout=120)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Dry run", result.stdout)
        self.assertIn("worker:ui 2, candidate:adapter 2, candidate:ui 2", result.stdout)  # One candidate failure: attempt 1 of each.
        self.assertEqual(self.listing(), before)
        self.assertEqual(git(self.repo, "for-each-ref", "refs/workflow-repair"), "")
        result = subprocess.run(command, cwd=cwd, env=env, capture_output=True, text=True, timeout=120)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(f"-m workflow automatic {self.directory} --live", result.stdout)
        self.assertFalse(calls.exists())
        self.assertEqual((self.directory / "fake-launches.log").read_text(), launches)
        self.assertEqual(self.entries()[0]["status"], "applied")


if __name__ == "__main__":
    unittest.main()
