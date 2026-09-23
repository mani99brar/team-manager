"""Workflow guardrails slice 2 (docs/PRD_PORTABLE_WORKFLOW.md, section 6, lane controller): one test per scenario id.

Targets are temporary Git repositories; HOME and the registry path point into temporary directories, and Herdr is
a patched subprocess. Workers are FakeSessions; the design challenge is a fake `claude --print` executable. No
Claude model calls.
"""
import contextlib
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from langgraph.checkpoint.sqlite import SqliteSaver
from langgraph.types import Command

from . import pipeline
from .automatic import DEFAULTS, read_completion, read_signal, review_prompt, wait_handoffs
from .checks import now
from .export_state import EXPORT_VERSION, graph_nodes, inputs_section
from .guardrails import answer_main, brief_problems, repin, resume_main
from .interactive import worker_prompt
from .launch import TOOL, launch_commands
from .pipeline import ExportRuntime, build_pipeline, combine_imported_reviews, export_run, graph_config
from .sessions import read_json, save_json
from .test_export import legacy_run
from .test_pipeline import FakeSessions, OfflinePipeline
from .test_portable import Isolated, commit_all, git
from .verification import validate_schema

PY = sys.executable
FEATURE = "guarded"
LANES = ["ui", "adapter"]
BRIEF = "## Goal\n\nChange {lane}.\n\n## Acceptance\n\nThe {lane} check passes.\n\n## Stop\n\nAfter three failed fixes, report blocked.\n"
DECISIONS = "# Decisions\n\n## Decisions\n\n- Keep the lanes apart: DECISION-MARKER-42.\n\n## Assumptions\n\nNone.\n\n## Deferred\n\nNothing.\n"


def two_lane_policy() -> dict:
    check = {"kind": "unit", "argv": ["python", "-c", "print('Ran 1 test in 0.001s\\n\\nOK')"], "timeout_seconds": 10, "scenarios": []}
    return {"version": "1.2.0", "feature": "Guarded", "independent_review": True, "integration_approval": True, "max_verification_attempts": 3,
            "workers": [{"node_id": "ui", "role": "frontend", "required_check_kinds": ["unit"], "owned_paths": ["ui.txt"], "checks": [{"id": "ui-unit", **check}]},
                        {"node_id": "adapter", "role": "backend", "required_check_kinds": ["unit"], "owned_paths": ["backend.py"], "checks": [{"id": "unit", **check}]}]}


def concern(severity: str, message: str = "A concern") -> dict:
    return {"severity": severity, "kind": "assumption", "message": message, "consequence": f"{message} breaks the run"}


class GuardedFeature(Isolated):
    """A committed target with a 2.2.0 feature over two lanes, a PRD and decisions.md; runs use FakeSessions."""

    def setUp(self):
        super().setUp()
        self.repo = self.root / "target"
        self.folder = self.repo / "features" / FEATURE
        self.folder.mkdir(parents=True)
        (self.repo / "ui.txt").write_text("before")
        (self.repo / "backend.py").write_text("VALUE = 1\n")
        (self.repo / "docs").mkdir()
        (self.repo / "docs/PRD.md").write_text("# PRD\n\nThe guarded feature.\n")
        save_json(self.folder / "policy.json", two_lane_policy())
        for lane in LANES:
            (self.folder / f"{lane}-task.md").write_text(BRIEF.format(lane=lane))
        (self.folder / "decisions.md").write_text(DECISIONS)
        self.manifest = {"version": "2.2.0", "name": "Guarded", "branch_prefix": f"feature/{FEATURE}", "prd": "docs/PRD.md", "policy": "policy.json",
                         "workers": [{"node_id": lane, "task": f"{lane}-task.md"} for lane in LANES],
                         "reviewers": [{"reviewer_id": "general", "prompt": "builtin:general"}, {"reviewer_id": "coverage", "prompt": "builtin:coverage"}]}
        save_json(self.folder / "feature.json", self.manifest)
        git(self.repo, "init", "-q")
        git(self.repo, "config", "user.name", "Test")
        git(self.repo, "config", "user.email", "test@example.invalid")
        commit_all(self.repo, "Base")
        self.runs = self.root / "runs"
        self.output = self.root / "challenge-output.json"
        self.calls = self.root / "challenge-calls.jsonl"
        self.challenge_says([concern("P2")])
        self.executable = self.root / "fake-claude"
        self.executable.write_text(f'''#!{PY}
import json, os, sys
from pathlib import Path
args = sys.argv
assert args[args.index('--tools') + 1] == 'Read,Glob,Grep', args
assert '--print' in args and '--bg' not in args and '--dangerously-skip-permissions' not in args, args
prompt = sys.stdin.read()
add_dirs = [args[index + 1] for index, item in enumerate(args) if item == '--add-dir']
with open({str(self.calls)!r}, 'a') as handle:
    handle.write(json.dumps({{"cwd": os.getcwd(), "prompt": prompt, "add_dirs": add_dirs}}) + '\\n')
with (Path.cwd().parent / 'fake-launches.log').open('a') as log:  # The worker fake logs its launches to the same file.
    log.write('challenge\\n')
print(json.dumps({{"session_id": args[args.index('--session-id') + 1], "is_error": False, "subtype": "success",
                  "structured_output": json.loads(Path({str(self.output)!r}).read_text())}}))
''')
        self.executable.chmod(0o700)

    def challenge_says(self, concerns: list) -> None:
        save_json(self.output, {"concerns": concerns, "simpler_alternative": "One lane instead of two",
                                "cheap_experiment": "Prototype the ui change first"})

    def challenge_calls(self) -> list:
        return [json.loads(line) for line in self.calls.read_text().splitlines()] if self.calls.exists() else []

    def prepare(self, run_id: str) -> Path:
        """The exact prepare command a launch runs, executed against the target."""
        run, commands, _ = launch_commands(self.repo, FEATURE, run_id, self.runs, herdr=False)
        result = subprocess.run(commands[2], cwd=TOOL, capture_output=True, text=True, timeout=120)
        self.assertEqual(result.returncode, 0, result.stderr)
        return run

    def sessions(self, directory: Path) -> FakeSessions:
        sessions = FakeSessions(directory, read_json(directory / "plan.json"))
        sessions.executable = str(self.executable)
        return sessions

    def runtime(self, directory: Path) -> OfflinePipeline:
        return OfflinePipeline(directory, self.sessions(directory))

    def launches(self, directory: Path) -> list:
        """Every challenge job and worker launch in order; the parallel worker launches of one step sorted."""
        log = directory / "fake-launches.log"
        entries = log.read_text().split() if log.exists() else []
        challenges = [entry for entry in entries if entry == "challenge"]
        self.assertEqual(entries[:len(challenges)], challenges, "A worker launched before a challenge job")
        return challenges + sorted(entries[len(challenges):])

    def cli(self, module_main, argv: list) -> tuple[str, int]:
        """A `python -m workflow` action in process, with FakeSessions in place of native sessions; (stdout, exit code)."""
        output = io.StringIO()
        code = 0
        with patch("workflow.pipeline.InteractiveSessions", side_effect=lambda directory, timeout: self.sessions(directory)), \
                contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
            try:
                if module_main is pipeline.main:
                    with patch.object(sys, "argv", ["workflow", *argv]):
                        module_main()
                else:
                    module_main(argv)
            except SystemExit as exit_:
                code = exit_.code
        return output.getvalue(), code

    def graph_values(self, directory: Path) -> dict:
        runtime = self.runtime(directory)
        with SqliteSaver.from_conn_string(str(directory / "pipeline.sqlite")) as saver:
            return build_pipeline(saver, runtime).get_state(graph_config(runtime)).values


class BriefHeadings(GuardedFeature):
    def test_brief_headings_are_required_and_non_empty_for_2_2_0_and_2_1_0_launches_with_the_migration_note(self):
        """Scenario brief-headings."""
        branches = git(self.repo, "branch", "--list")
        task = self.folder / "ui-task.md"
        task.write_text("## Goal\n\nChange ui.\n\n## Acceptance\n\nIt works.\n")
        commit_all(self.repo)
        errors = self.refused(FEATURE, "--repo", str(self.repo), "--no-herdr", "--live")
        self.assertIn("ui-task.md: missing ## Stop", errors)
        self.assertNotIn("adapter-task.md", errors)
        task.write_text("## Goal\n\nChange ui.\n\n## Acceptance\n\n\n## Stop\n\nAfter one failure.\n")
        errors = self.refused(FEATURE, "--repo", str(self.repo), "--no-herdr", "--dry-run")
        self.assertIn("ui-task.md: empty ## Acceptance", errors)
        # A heading inside a code fence is body text, not a section.
        self.assertEqual(brief_problems("## Goal\n\nx\n\n## Acceptance\n\n```\n## Stop\n```\n"), ["missing ## Stop"])
        self.assertEqual(git(self.repo, "branch", "--list"), branches)  # Refused before any Git action.
        self.assertFalse(self.registry.exists())
        # Three headings with one line each pass, and the prepare command pins the guardrails.
        task.write_text("## Goal\nChange ui.\n## Acceptance\nIt works.\n## Stop\nAfter one failure.\n")
        commit_all(self.repo)
        printed = self.dry_run(FEATURE, "--repo", str(self.repo), "--no-herdr")
        prepare = printed["commands"][2]
        self.assertEqual(prepare[prepare.index("--guardrails"):], ["--guardrails", "--decisions", str(self.folder / "decisions.md"),
                                                                     "--prd", str(self.repo / "docs/PRD.md")])
        self.assertEqual(printed["guardrails"], {"feature_version": "2.2.0", "enforced": True, "challenge": True, "migration_note": None})
        self.assertEqual(printed["registry"]["entry"]["workflows"][0]["definition"]["nodes"][0]["node_id"], "challenge")
        # The same feature at 2.1.0: nothing is refused (not even a task without headings), the commands carry no
        # guardrail flag and the launch prints the migration note beside its (empty) notes.
        task.write_text("# ui\n\nJust do it.\n")
        (self.folder / "decisions.md").unlink()
        manifest = {key: value for key, value in self.manifest.items() if key != "prd"}
        save_json(self.folder / "feature.json", {**manifest, "version": "2.1.0"})
        commit_all(self.repo)
        with patch("workflow.launch.subprocess.run") as command, contextlib.redirect_stdout(io.StringIO()) as output, \
                contextlib.redirect_stderr(io.StringIO()) as errors:
            from .launch import main as launch_main
            launch_main([FEATURE, "--repo", str(self.repo), "--no-herdr", "--dry-run"])
        command.assert_not_called()
        printed = json.loads(output.getvalue())
        self.assertEqual(printed["notes"], [])
        self.assertFalse({"--guardrails", "--decisions", "--prd", "--no-challenge"} & set(printed["commands"][2]))
        self.assertEqual([node["node_id"] for node in printed["registry"]["entry"]["workflows"][0]["definition"]["nodes"]][:2], ["launch_ui", "launch_adapter"])
        self.assertIn("Note: feature.json 2.1.0: no guardrail is enforced", errors.getvalue())
        self.assertIn('set "version": "2.2.0"', printed["guardrails"]["migration_note"])
        # A 2.1.0 file cannot use the 2.2.0 keys.
        save_json(self.folder / "feature.json", {**manifest, "version": "2.1.0", "challenge": False})
        self.assertIn("challenge and prd need version 2.2.0", self.refused(FEATURE, "--repo", str(self.repo), "--no-herdr", "--dry-run"))


class DecisionsRequired(GuardedFeature):
    def test_decisions_required_before_git_pinned_in_the_plan_and_in_every_worker_and_reviewer_prompt(self):
        """Scenario decisions-required."""
        branches = git(self.repo, "branch", "--list")
        decisions = self.folder / "decisions.md"
        decisions.unlink()
        commit_all(self.repo)
        errors = self.refused(FEATURE, "--repo", str(self.repo), "--no-herdr", "--live")
        self.assertIn("decisions.md is missing or empty", errors)
        decisions.write_text("\n  \n")
        self.assertIn("decisions.md is missing or empty", self.refused(FEATURE, "--repo", str(self.repo), "--no-herdr", "--dry-run"))
        decisions.write_text(DECISIONS)
        save_json(self.folder / "feature.json", {**self.manifest, "prd": "docs/missing.md"})
        self.assertIn("prd 'docs/missing.md' does not exist in the target", self.refused(FEATURE, "--repo", str(self.repo), "--no-herdr", "--dry-run"))
        save_json(self.folder / "feature.json", {**self.manifest, "prd": "../outside.md"})
        self.assertIn("feature.json is invalid: '../outside.md' does not match", self.refused(FEATURE, "--repo", str(self.repo), "--no-herdr", "--dry-run"))
        self.assertEqual(git(self.repo, "branch", "--list"), branches)
        self.assertFalse(self.registry.exists())
        save_json(self.folder / "feature.json", self.manifest)
        commit_all(self.repo)
        # Pinned at prepare like the task text.
        directory = self.prepare("decisions-001")
        plan = read_json(directory / "plan.json")
        self.assertEqual(plan["decisions"], {"path": str(decisions.resolve()), "text": DECISIONS})
        self.assertEqual((plan["completion_version"], plan["challenge"], plan["feature_version"]), ("1.1.0", True, "2.2.0"))
        self.assertEqual(plan["task_files"], {lane: str((self.folder / f"{lane}-task.md").resolve()) for lane in LANES})
        self.assertEqual(read_json(directory / "run-state.json")["inputs"]["decisions"], DECISIONS)
        # Every worker prompt, manual and automatic, has it after the task; every reviewer prompt has it too.
        for automatic in (False, True):
            if automatic:
                plan["automatic"] = dict(DEFAULTS)
            for lane in LANES:
                prompt = worker_prompt(directory, plan, lane)
                self.assertIn("DECISION-MARKER-42", prompt)
                self.assertLess(prompt.index(f"Change {lane}."), prompt.index("DECISION-MARKER-42"))
        runtime = SimpleNamespace(directory=directory, plan=plan, workers=LANES)
        for reviewer in [None, *plan["reviewers"]]:
            self.assertIn("DECISION-MARKER-42", review_prompt(runtime, directory / "review.diff", reviewer))
        # A run without decisions (every run before slice 2) gets no decisions block.
        plan.pop("decisions")
        self.assertNotIn("Decisions recorded before launch", worker_prompt(directory, plan, "ui") + review_prompt(runtime, directory / "review.diff"))


class ChallengePasses(GuardedFeature):
    def test_challenge_passes_with_only_p2_concerns_then_workers_launch_and_disabled_has_no_node(self):
        """Scenario challenge-passes."""
        directory = self.prepare("pass-001")
        definition = read_json(directory / "run-state.json")["definition"]["nodes"]
        self.assertEqual(definition[0], {"node_id": "challenge", "label": "Design challenge", "kind": "review", "depends_on": []})
        self.assertEqual([(node["node_id"], node["depends_on"]) for node in definition[1:3]], [("launch_ui", ["challenge"]), ("launch_adapter", ["challenge"])])
        self.challenge_says([concern("P2", "Naming is loose"), concern("P2", "One test is slow")])
        output, code = self.cli(pipeline.main, ["start", str(directory), "--live"])
        self.assertEqual(code, 0, output)
        record = read_json(directory / "challenge.json")
        validate_schema("challenge", record)
        self.assertEqual((record["status"], record["attempt"], record["accepted_reason"]), ("passed", 1, None))
        from jsonschema.exceptions import ValidationError
        for invalid in ({**record, "status": "accepted"}, {**record, "accepted_reason": "r"}, {**record, "session_id": None},
                        {**record, "status": "disabled"}, {**record, "concerns": [{**concern("P3")}]}):
            with self.assertRaises(ValidationError):
                validate_schema("challenge", invalid)
        self.assertEqual([item["message"] for item in record["concerns"]], ["Naming is loose", "One test is slow"])
        # The challenge ran first, alone; the workers launched after it.
        self.assertEqual(self.launches(directory), ["challenge", "adapter", "ui"])
        [call] = self.challenge_calls()
        self.assertEqual(Path(call["cwd"]), directory / "challenge-worktree")
        self.assertEqual(git(directory / "challenge-worktree", "rev-parse", "HEAD"), read_json(directory / "plan.json")["base_commit"])
        self.assertIn("DECISION-MARKER-42", call["prompt"])
        self.assertIn("Change ui.", call["prompt"])
        self.assertIn(str(directory / "challenge-inputs/prd.md"), call["prompt"])
        self.assertEqual(call["add_dirs"], [str(directory / "challenge-inputs")])
        events = [(event["node"], event["status"]) for event in map(json.loads, (directory / "events.jsonl").read_text().splitlines())]
        self.assertLess(events.index(("challenge", "succeeded")), events.index(("ui", "running")))
        exported = read_json(directory / "run-state.json")["inputs"]["challenge"]
        self.assertEqual((exported["status"], exported["attempts"], "run_id" in exported, "version" in exported), ("passed", 1, False, False))
        # challenge: false writes `disabled`, runs no job and the graph has no challenge node.
        save_json(self.folder / "feature.json", {**self.manifest, "challenge": False})
        commit_all(self.repo, "No challenge")
        off = self.prepare("off-001")
        self.assertEqual(read_json(off / "plan.json")["challenge"], False)
        self.assertNotIn("challenge", [node["node_id"] for node in read_json(off / "run-state.json")["definition"]["nodes"]])
        self.assertEqual(graph_nodes(LANES)[0]["depends_on"], [])
        output, code = self.cli(pipeline.main, ["start", str(off), "--live"])
        self.assertEqual(code, 0, output)
        disabled = read_json(off / "challenge.json")
        validate_schema("challenge", disabled)
        self.assertEqual((disabled["status"], disabled["attempt"], disabled["session_id"], disabled["concerns"]), ("disabled", 0, None, []))
        self.assertEqual(self.launches(off), ["adapter", "ui"])
        self.assertEqual(len(self.challenge_calls()), 1)


class ChallengePauses(GuardedFeature):
    def test_challenge_pauses_on_p1_launches_nothing_and_resume_reruns_or_accepts(self):
        """Scenario challenge-pauses."""
        directory = self.prepare("pause-001")
        self.challenge_says([concern("P1", "The lanes overlap"), concern("P2", "Minor")])
        output, code = self.cli(pipeline.main, ["start", str(directory), "--live"])
        self.assertEqual(code, 0, output)  # Exits 0 with the concerns and the resume commands.
        self.assertIn("P1 [assumption] The lanes overlap", output)
        self.assertIn(f"-m workflow resume {directory}", output)
        self.assertIn('--accept-challenge "<reason>"', output)
        paused = read_json(directory / "challenge.json")
        self.assertEqual((paused["status"], paused["attempt"]), ("paused", 1))
        self.assertEqual(self.launches(directory), ["challenge"])
        self.assertFalse(any(directory.glob("*.interactive.json")))
        self.assertEqual(self.graph_values(directory), {})
        # Starting again neither reruns the challenge nor launches a worker.
        output, code = self.cli(pipeline.main, ["start", str(directory), "--live"])
        self.assertEqual(code, 1)
        self.assertIn("paused this run", output)
        self.assertEqual(self.launches(directory), ["challenge"])
        # A resume whose rerun still finds a P1 stays paused, as attempt 2, and launches nothing.
        output, code = self.cli(resume_main, [str(directory)])
        self.assertEqual((code, read_json(directory / "challenge.json")["status"], read_json(directory / "challenge.json")["attempt"]), (0, "paused", 2))
        self.assertEqual(self.launches(directory), ["challenge", "challenge"])
        # The operator edits a task; resume re-pins it and reruns the challenge as attempt 3, which passes, then launches the workers.
        task = self.folder / "ui-task.md"
        task.write_text(task.read_text() + "\nOnly ui.txt; the adapter lane owns backend.py.\n")
        self.challenge_says([concern("P2", "Minor")])
        output, code = self.cli(resume_main, [str(directory)])
        self.assertEqual(code, 0, output)
        record = read_json(directory / "challenge.json")
        self.assertEqual((record["status"], record["attempt"]), ("passed", 3))
        self.assertEqual(read_json(directory / "challenge-1.json"), paused)
        self.assertEqual(read_json(directory / "challenge-2.json")["status"], "paused")
        plan = read_json(directory / "plan.json")
        self.assertIn("the adapter lane owns backend.py", plan["nodes"]["ui"]["task"])
        self.assertIn("Approved ownership and checks:", plan["nodes"]["ui"]["task"])
        self.assertNotEqual(record["pinned"]["tasks_sha256"], paused["pinned"]["tasks_sha256"])
        self.assertEqual(record["pinned"]["decisions_sha256"], paused["pinned"]["decisions_sha256"])
        self.assertIn("the adapter lane owns backend.py", self.challenge_calls()[-1]["prompt"])
        self.assertEqual(self.launches(directory), ["challenge"] * 3 + ["adapter", "ui"])
        # The launch ran on the re-pinned plan (a fresh runtime after the re-pin), which the export records.
        self.assertIn("the adapter lane owns backend.py", read_json(directory / "run-state.json")["inputs"]["workers"]["ui"]["task"])
        # Once workers run, resume refuses.
        output, code = self.cli(resume_main, [str(directory)])
        self.assertEqual(code, 1)
        self.assertIn("Workers already launched", output)
        # --accept-challenge records the override with its reason, reruns nothing and launches the workers.
        self.challenge_says([concern("P0", "Cannot work")])
        self.assertEqual(git(self.repo, "status", "--porcelain"), "")  # resume committed the edit, so prepare finds a clean source.
        other = self.prepare("accept-001")
        self.cli(pipeline.main, ["start", str(other), "--live"])
        self.assertEqual(read_json(other / "challenge.json")["status"], "paused")
        output, code = self.cli(resume_main, [str(other), "--accept-challenge", " "])
        self.assertEqual(code, 1)
        self.assertIn("needs a non-empty reason", output)
        output, code = self.cli(resume_main, [str(other), "--accept-challenge", "r"])
        self.assertEqual(code, 0, output)
        accepted = read_json(other / "challenge.json")
        validate_schema("challenge", accepted)
        self.assertEqual((accepted["status"], accepted["accepted_reason"], accepted["attempt"]), ("accepted", "r", 1))
        self.assertEqual(read_json(other / "challenge-1.json")["status"], "paused")
        self.assertEqual(self.launches(other), ["challenge", "adapter", "ui"])
        exported = read_json(other / "run-state.json")["inputs"]["challenge"]
        self.assertEqual((exported["status"], exported["accepted_reason"], exported["attempts"]), ("accepted", "r", 1))

    def test_challenge_pauses_a_live_launch_before_the_automatic_supervisor(self):
        """Scenario challenge-pauses: the launch stops after a paused start and exits 0."""
        calls = []

        def run(command, cwd, check):
            calls.append(command)
            if command[3:4] == ["start"]:
                directory = Path(command[4])
                directory.mkdir(parents=True, exist_ok=True)
                save_json(directory / "challenge.json", {"status": "paused"})

        from .launch import main as launch_main
        with patch("workflow.launch.subprocess.run", side_effect=run), contextlib.redirect_stdout(io.StringIO()) as output, \
                contextlib.redirect_stderr(io.StringIO()):
            launch_main([FEATURE, "--repo", str(self.repo), "--no-herdr", "--live", "--automatic", "--run-root", str(self.runs)])
        self.assertEqual([command[3] if command[0] != "git" else "git" for command in calls], ["preflight", "git", "prepare", "start"])
        self.assertIn("Launch paused at the design challenge; no worker was launched", output.getvalue())


class ChallengeRevision(GuardedFeature):
    """`resume` after an edit commits the re-pinned feature files on the run's branch and moves the run to that commit."""

    def paused(self, run_id: str) -> tuple[Path, str]:
        """A prepared run whose first challenge paused on a P1; its base commit."""
        directory = self.prepare(run_id)
        self.challenge_says([concern("P1", "The lanes overlap")])
        output, code = self.cli(pipeline.main, ["start", str(directory), "--live"])
        self.assertEqual((code, read_json(directory / "challenge.json")["status"]), (0, "paused"), output)
        return directory, read_json(directory / "plan.json")["base_commit"]

    def edit_task(self) -> Path:
        task = self.folder / "ui-task.md"
        task.write_text(task.read_text() + "\nOnly ui.txt; the adapter lane owns backend.py.\n")
        return task

    def run_worktrees(self, directory: Path) -> list[Path]:
        return [directory / f"worktree-{lane}" for lane in LANES] + [directory / "challenge-worktree"]

    def assert_moved(self, directory: Path, revision: str) -> None:
        plan = read_json(directory / "plan.json")
        self.assertEqual(plan["base_commit"], revision)
        self.assertEqual({lane: plan["nodes"][lane]["observed_start_commit"] for lane in LANES}, dict.fromkeys(LANES, revision))
        for path in self.run_worktrees(directory):
            self.assertEqual(git(path, "rev-parse", "HEAD"), revision, path)

    def test_resume_commits_the_edited_task_moves_the_run_to_that_commit_and_integrates_on_it(self):
        directory, base = self.paused("revise-001")
        self.edit_task()
        self.challenge_says([concern("P2", "Minor")])
        output, code = self.cli(resume_main, [str(directory)])
        self.assertEqual(code, 0, output)
        # One commit on the run's branch, exactly the edited task, with the pipeline's identity; the checkout is clean.
        revision = git(self.repo, "rev-parse", "HEAD")
        self.assertNotEqual(revision, base)
        self.assertEqual(git(self.repo, "status", "--porcelain"), "")
        self.assertEqual(git(self.repo, "rev-parse", f"{revision}^"), base)
        self.assertEqual(git(self.repo, "log", "-1", "--format=%s|%an <%ae>|%cn", revision),
                         "Workflow revise-001: feature files revised after design challenge attempt 1|Workflow snapshot <workflow@localhost>|Workflow snapshot")
        self.assertEqual(git(self.repo, "diff-tree", "--no-commit-id", "--name-only", "-r", revision), f"features/{FEATURE}/ui-task.md")
        # The plan, every lane worktree and the challenge worktree are on it, and the rerun challenge read it there.
        self.assert_moved(directory, revision)
        self.assertIn("the adapter lane owns backend.py", (directory / f"worktree-ui/features/{FEATURE}/ui-task.md").read_text())
        self.assertIn("the adapter lane owns backend.py", read_json(directory / "plan.json")["nodes"]["ui"]["task"])
        self.assertEqual(read_json(directory / "challenge.json")["attempt"], 2)
        self.assertEqual(self.launches(directory), ["challenge", "challenge", "adapter", "ui"])
        self.assertEqual(read_json(directory / "run-state.json")["base_commit"], revision)
        events = [event["message"] for event in map(json.loads, (directory / "events.jsonl").read_text().splitlines()) if event["node"] == "challenge"]
        self.assertTrue(any(f"as {revision}" in message and f"features/{FEATURE}/ui-task.md" in message for message in events), events)
        self.assertTrue(any(f"from base {base} to {revision}" in message for message in events), events)
        # The workers ran on the new base: freeze, checks, candidate, both reviewers and a fast-forward of the branch.
        runtime = self.runtime(directory)
        with SqliteSaver.from_conn_string(str(directory / "pipeline.sqlite")) as saver:
            graph = build_pipeline(saver, runtime)
            config = graph_config(runtime)
            verified = graph.invoke(Command(resume={"freeze": True}), config)
            self.assertEqual(verified["__interrupt__"][0].value["kind"], "independent_review")
            bundle, digest = runtime.validate_bundle()
            self.assertEqual(bundle["base_commit"], revision)
            imports = {reviewer: {"imported_at": now(), "review": {"run_id": "revise-001", "bundle_sha256": digest, "candidate_commit": bundle["candidate_commit"],
                                                                  "reviewer": f"{reviewer}-session", "independent": True, "verdict": "approved", "findings": []}}
                       for reviewer in ("general", "coverage")}
            approved = graph.invoke(Command(resume=combine_imported_reviews(bundle, digest, imports)), config)
            self.assertEqual(approved["__interrupt__"][0].value["kind"], "integration_approval")
            final = graph.invoke(Command(resume={"approve": digest}), config)
        self.assertEqual(final["integrated_commit"], git(self.repo, "rev-parse", "HEAD"))
        self.assertEqual(git(self.repo, "rev-list", "--count", f"{revision}..HEAD"), "2")  # The two lane snapshots, on the revision.
        self.assertEqual(((self.repo / "ui.txt").read_text(), (self.repo / "backend.py").read_text()), ("after", "VALUE = 2\n"))
        self.assertEqual(git(self.repo, "status", "--porcelain"), "")

    def test_resume_refuses_changes_it_does_not_re_pin_a_broken_brief_and_commits_it_did_not_make(self):
        directory, base = self.paused("unrelated-001")
        task = self.edit_task()
        (self.repo / "backend.py").write_text("VALUE = 3\n")
        (self.repo / "notes.txt").write_text("scratch\n")
        output, code = self.cli(resume_main, [str(directory)])
        self.assertEqual(code, 1, output)
        self.assertIn("changes resume does not re-pin: backend.py, notes.txt", output)
        # Nothing was committed or moved, the challenge did not rerun and the edits stay in the checkout.
        self.assertEqual((git(self.repo, "rev-parse", "HEAD"), read_json(directory / "plan.json")["base_commit"]), (base, base))
        self.assertEqual(len(self.challenge_calls()), 1)
        self.assertIn("the adapter lane owns backend.py", task.read_text())
        # A brief that lost a required section is refused before anything is committed.
        (self.repo / "backend.py").write_text("VALUE = 1\n")
        (self.repo / "notes.txt").unlink()
        edited = task.read_text()
        task.write_text(edited.replace("## Stop", "## Later"))
        output, code = self.cli(resume_main, [str(directory)])
        self.assertEqual(code, 1, output)
        self.assertIn("ui-task.md: missing ## Stop", output)
        self.assertEqual(git(self.repo, "rev-parse", "HEAD"), base)
        # A commit the operator made on the branch is refused: resume commits the feature files itself.
        task.write_text(edited)
        commit_all(self.repo, "My own commit")
        output, code = self.cli(resume_main, [str(directory)])
        self.assertEqual(code, 1, output)
        self.assertIn("commits resume did not make", output)
        self.assertIn(f"git reset --soft {base}", output)
        self.assertEqual((read_json(directory / "plan.json")["base_commit"], len(self.challenge_calls())), (base, 1))
        git(self.repo, "reset", "--soft", base)
        self.challenge_says([concern("P1", "The lanes still overlap")])
        output, code = self.cli(resume_main, [str(directory)])
        self.assertEqual(code, 0, output)
        revision = git(self.repo, "rev-parse", "HEAD")
        self.assertEqual(git(self.repo, "log", "-1", "--format=%an", revision), "Workflow snapshot")
        self.assert_moved(directory, revision)
        # Still paused: the export already records the moved base and the new attempt, as `start` does; nothing launched.
        exported = read_json(directory / "run-state.json")
        self.assertEqual((exported["base_commit"], exported["inputs"]["challenge"]["status"], exported["inputs"]["challenge"]["attempts"]), (revision, "paused", 2))
        self.assertEqual(self.launches(directory), ["challenge", "challenge"])

    def test_accept_challenge_refuses_edited_pinned_files_and_accepts_on_a_clean_checkout(self):
        directory, base = self.paused("accept-edited-001")
        decisions = self.folder / "decisions.md"
        decisions.write_text(DECISIONS + "\n- A late decision.\n")
        output, code = self.cli(resume_main, [str(directory), "--accept-challenge", "Known risk"])
        self.assertEqual(code, 1, output)
        self.assertIn(f"features/{FEATURE}/decisions.md", output)
        self.assertIn("without --accept-challenge", output)
        self.assertEqual((read_json(directory / "challenge.json")["status"], git(self.repo, "rev-parse", "HEAD")), ("paused", base))
        self.assertEqual(self.launches(directory), ["challenge"])
        # Committed by hand, the checkout is clean but the plan still pins the old text: compared by content, refused.
        git(self.repo, "checkout", "--", f"features/{FEATURE}/decisions.md")
        self.edit_task()
        commit_all(self.repo, "My own edit")
        output, code = self.cli(resume_main, [str(directory), "--accept-challenge", "Known risk"])
        self.assertEqual(code, 1, output)
        self.assertIn(f"Feature files changed since they were pinned (features/{FEATURE}/ui-task.md)", output)
        self.assertEqual((read_json(directory / "challenge.json")["status"], self.launches(directory)), ("paused", ["challenge"]))
        git(self.repo, "reset", "-q", "--hard", base)
        # Reverted, the override behaves as before: accepted, nothing committed or moved, the workers launch on the base.
        output, code = self.cli(resume_main, [str(directory), "--accept-challenge", "Known risk"])
        self.assertEqual(code, 0, output)
        self.assertEqual((read_json(directory / "challenge.json")["status"], git(self.repo, "rev-parse", "HEAD")), ("accepted", base))
        self.assert_moved(directory, base)
        self.assertEqual(self.launches(directory), ["challenge", "adapter", "ui"])

    def test_an_interrupted_resume_continues_from_its_commit_and_no_worker_launches_on_a_half_moved_run(self):
        directory, base = self.paused("interrupted-001")
        self.edit_task()
        self.challenge_says([concern("P2", "Minor")])
        with patch("workflow.guardrails.move_base", side_effect=RuntimeError("Interrupted after the commit")):
            output, code = self.cli(resume_main, [str(directory)])
        self.assertEqual(code, 1, output)
        revision = git(self.repo, "rev-parse", "HEAD")
        self.assertEqual((git(self.repo, "rev-parse", f"{revision}^"), git(self.repo, "status", "--porcelain")), (base, ""))
        self.assertEqual(read_json(directory / "plan.json")["base_commit"], base)
        # Interrupted again while moving: one lane worktree is already on the revision.
        git(directory / "worktree-ui", "checkout", "-q", "--detach", revision)
        # Neither start nor an override launches a worker on the half-moved run.
        self.assert_unfinished(directory)
        # The rerun continues from the commit it made: no second commit, the rest of the run moves, then the challenge and the workers.
        output, code = self.cli(resume_main, [str(directory)])
        self.assertEqual(code, 0, output)
        self.assertEqual(git(self.repo, "rev-parse", "HEAD"), revision)
        self.assert_moved(directory, revision)
        self.assertFalse((directory / "challenge-revision.json").exists())
        self.assertEqual(read_json(directory / "challenge.json")["attempt"], 2)
        self.assertEqual(self.launches(directory), ["challenge", "challenge", "adapter", "ui"])

    def assert_unfinished(self, directory: Path) -> None:
        """Neither start nor an override launches a worker while an interrupted resume has not finished moving the run."""
        launches = self.launches(directory)
        output, code = self.cli(pipeline.main, ["start", str(directory), "--live"])
        self.assertEqual(code, 1, output)
        self.assertIn("An interrupted resume has not finished moving this run", output)
        output, code = self.cli(resume_main, [str(directory), "--accept-challenge", "Known risk"])
        self.assertEqual(code, 1, output)
        self.assertIn("An interrupted resume has not finished moving this run", output)
        self.assertIn("without --accept-challenge", output)
        self.assertEqual(self.launches(directory), launches)

    def test_an_override_waits_for_a_resume_interrupted_around_its_single_plan_write(self):
        directory, base = self.paused("half-moved-001")
        self.edit_task()
        # Interrupted after the worktrees moved, before the re-pin: plan.json still pins the old base and the old task together.
        with patch("workflow.guardrails.repin", side_effect=RuntimeError("Interrupted before the re-pin")):
            output, code = self.cli(resume_main, [str(directory)])
        self.assertEqual(code, 1, output)
        revision = git(self.repo, "rev-parse", "HEAD")
        plan = read_json(directory / "plan.json")
        self.assertEqual((plan["base_commit"], {lane: plan["nodes"][lane]["observed_start_commit"] for lane in LANES}), (base, dict.fromkeys(LANES, base)))
        self.assertNotIn("the adapter lane owns backend.py", plan["nodes"]["ui"]["task"])
        self.assertEqual({git(path, "rev-parse", "HEAD") for path in self.run_worktrees(directory)}, {revision})
        self.assert_unfinished(directory)
        # Interrupted after the re-pin saved plan.json: base, start commits and task moved in one write; only the intent is left.
        def repin_then_interrupt(*args):
            repin(*args)
            raise RuntimeError("Interrupted after the re-pin")
        with patch("workflow.guardrails.repin", side_effect=repin_then_interrupt):
            output, code = self.cli(resume_main, [str(directory)])
        self.assertEqual(code, 1, output)
        self.assert_moved(directory, revision)
        self.assertIn("the adapter lane owns backend.py", read_json(directory / "plan.json")["nodes"]["ui"]["task"])
        self.assertEqual(read_json(directory / "challenge-revision.json")["base_commit"], base)
        self.assert_unfinished(directory)
        # The rerun finishes it: the same commit, attempt 2 on the revised task, then the workers on the revision.
        self.challenge_says([concern("P2", "Minor")])
        output, code = self.cli(resume_main, [str(directory)])
        self.assertEqual(code, 0, output)
        self.assertEqual(git(self.repo, "rev-parse", "HEAD"), revision)
        self.assert_moved(directory, revision)
        self.assertFalse((directory / "challenge-revision.json").exists())
        self.assertIn("the adapter lane owns backend.py", self.challenge_calls()[-1]["prompt"])
        self.assertEqual(self.launches(directory), ["challenge", "challenge", "adapter", "ui"])

    def test_start_waits_for_a_resume_before_the_first_challenge_that_was_interrupted_after_its_commit(self):
        directory = self.prepare("early-001")
        base = read_json(directory / "plan.json")["base_commit"]
        self.edit_task()
        with patch("workflow.guardrails.move_base", side_effect=RuntimeError("Interrupted after the commit")):
            output, code = self.cli(resume_main, [str(directory)])
        self.assertEqual(code, 1, output)
        revision = git(self.repo, "rev-parse", "HEAD")
        self.assertEqual(git(self.repo, "log", "-1", "--format=%s", revision), "Workflow early-001: feature files revised before the design challenge")
        # start would otherwise run attempt 1 and launch the workers on the old base, one commit behind the branch.
        output, code = self.cli(pipeline.main, ["start", str(directory), "--live"])
        self.assertEqual(code, 1, output)
        self.assertIn("An interrupted resume has not finished moving this run", output)
        self.assertEqual((self.launches(directory), (directory / "challenge.json").exists()), ([], False))
        self.assertEqual(read_json(directory / "plan.json")["base_commit"], base)
        output, code = self.cli(resume_main, [str(directory)])
        self.assertEqual(code, 0, output)
        self.assert_moved(directory, revision)
        self.assertEqual(read_json(directory / "challenge.json")["attempt"], 1)
        self.assertEqual(self.launches(directory), ["challenge", "adapter", "ui"])

    def test_a_run_worktree_that_is_not_the_clean_base_refuses_resume_before_anything_is_committed(self):
        directory, base = self.paused("dirty-worktree-001")
        task = self.edit_task()
        (directory / "worktree-ui/scratch.txt").write_text("scratch\n")
        output, code = self.cli(resume_main, [str(directory)])
        self.assertEqual(code, 1, output)
        self.assertIn(f"Run worktree {directory / 'worktree-ui'} is not a clean checkout of the base {base}", output)
        # A plain refusal: nothing committed or moved, the edit stays in the checkout and no resume is left to finish.
        self.assertEqual((git(self.repo, "rev-parse", "HEAD"), read_json(directory / "plan.json")["base_commit"]), (base, base))
        self.assertEqual(git(self.repo, "diff", "--name-only"), f"features/{FEATURE}/ui-task.md")
        self.assertIn("the adapter lane owns backend.py", task.read_text())
        self.assertFalse((directory / "challenge-revision.json").exists())
        self.assertEqual(len(self.challenge_calls()), 1)
        # So the override is still available once the edit is reverted.
        (directory / "worktree-ui/scratch.txt").unlink()
        git(self.repo, "checkout", "--", f"features/{FEATURE}/ui-task.md")
        output, code = self.cli(resume_main, [str(directory), "--accept-challenge", "Known risk"])
        self.assertEqual(code, 0, output)
        self.assertEqual((read_json(directory / "challenge.json")["status"], git(self.repo, "rev-parse", "HEAD")), ("accepted", base))
        self.assertEqual(self.launches(directory), ["challenge", "adapter", "ui"])


class CompletionEvidence(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.plan = {"run_id": "run", "completion_version": "1.1.0", "nodes": {"ui": {"session_id": "ui-token"}}}
        self.runtime = SimpleNamespace(directory=self.root, plan=self.plan)

    def write(self, **fields):
        item = {"version": "1.1.0", "run_id": "run", "node_id": "ui", "launch_token": "ui-token", "status": "completed",
                "summary": "Done", "open_assumptions": [], "untested": ["Offline pane typing"], "falsifying_check": "ui-unit",
                "verify_yourself": "The pane accepts send-keys Enter", "question": None, **fields}
        item = {key: value for key, value in item.items() if value is not ...}
        save_json(self.root / "ui.completion.json", item)

    def test_completion_evidence_is_required_at_1_1_0_exported_and_1_0_0_stays_readable_for_older_runs(self):
        """Scenario completion-evidence."""
        for fields, error in (({"falsifying_check": ...}, "Malformed completion signal: version 1.1.0 needs"),
                              ({"verify_yourself": ...}, "Malformed completion signal"),
                              ({"falsifying_check": ""}, "non-empty falsifying_check and verify_yourself"),
                              ({"verify_yourself": "  "}, "non-empty falsifying_check and verify_yourself"),
                              ({"untested": None}, "untested must be a list"),
                              ({"question": "Why?"}, "question null")):
            self.write(**fields)
            with self.assertRaisesRegex(ValueError, error):
                read_completion(self.runtime, "ui")
        self.write(untested=[])
        self.assertEqual(read_completion(self.runtime, "ui"), {"summary": "Done", "open_assumptions": []})
        self.write()
        self.assertEqual(read_signal(self.runtime, "ui")["falsifying_check"], "ui-unit")
        # A run pinned at 1.1.0 refuses a 1.0.0 file; a run prepared before slice 2 still reads it.
        legacy = {"version": "1.0.0", "run_id": "run", "node_id": "ui", "launch_token": "ui-token", "status": "completed", "summary": "Done", "open_assumptions": []}
        save_json(self.root / "ui.completion.json", legacy)
        with self.assertRaisesRegex(ValueError, "Completion version 1.0.0 refused: this run is pinned at completion 1.1.0"):
            read_completion(self.runtime, "ui")
        del self.plan["completion_version"]
        self.assertEqual(read_completion(self.runtime, "ui"), {"summary": "Done", "open_assumptions": []})
        # Export: a valid 1.1.0 file carries the three fields; a 1.0.0 file serves them as nulls.
        directory = legacy_run(self.root)
        plan, policy = read_json(directory / "plan.json"), read_json(directory / "policy.json")
        plan["completion_version"] = "1.1.0"
        save_json(directory / "ui.completion.json", {**read_json(directory / "ui.completion.json"), "version": "1.1.0", "untested": ["Offline pane typing"],
                                                     "falsifying_check": "ui-unit", "verify_yourself": "The pane accepts Enter", "question": None})
        workers = inputs_section(directory, plan, policy)["workers"]
        self.assertEqual({key: workers["ui"]["completion"][key] for key in ("untested", "falsifying_check", "verify_yourself")},
                         {"untested": ["Offline pane typing"], "falsifying_check": "ui-unit", "verify_yourself": "The pane accepts Enter"})
        self.assertEqual({key: workers["adapter"]["completion"][key] for key in ("untested", "falsifying_check", "verify_yourself")},
                         {"untested": None, "falsifying_check": None, "verify_yourself": None})


class WorkerQuestion(unittest.TestCase):
    TIMEOUT = DEFAULTS["worker_timeout_seconds"]

    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.plan = {"run_id": "run", "source_branch": "feature/test", "automatic": dict(DEFAULTS), "completion_version": "1.1.0",
                     "workers": ["ui", "adapter"], "nodes": {lane: {"session_id": f"{lane}-token"} for lane in ("ui", "adapter")}}
        save_json(self.root / "plan.json", self.plan)
        self.states = {"ui": "idle", "adapter": "working"}
        sessions = SimpleNamespace(inventory=lambda: [], locate=lambda node, rows: {"state": self.states[node]})
        self.events = []
        self.runtime = SimpleNamespace(directory=self.root, plan=self.plan, sessions=sessions, workers=["ui", "adapter"],
                                       event=lambda node, status, message: self.events.append((node, status, message)))
        for lane in ("ui", "adapter"):
            save_json(self.root / f"{lane}.interactive.json", {"launch_requested_at": "1970-01-01T00:00:00+00:00", "background_id": f"bg-{lane}"})
        save_json(self.root / "terminals.json", {"ui": {"pane_id": "pane-ui", "tab_id": "t", "mode": "attach_requested"}})
        self.now = 10.0

    def completion(self, lane: str, **fields):
        save_json(self.root / f"{lane}.completion.json", {
            "version": "1.1.0", "run_id": "run", "node_id": lane, "launch_token": f"{lane}-token", "status": "completed", "summary": "Work",
            "open_assumptions": [], "untested": [], "falsifying_check": "unit", "verify_yourself": "It builds", "question": None, **fields})

    def ask(self, text: str):
        self.completion("ui", status="question", question=text, falsifying_check="", verify_yourself="", untested=None)

    def wait(self, on_sleep=None):
        def sleep(_):
            if on_sleep:
                on_sleep()
        wait_handoffs(self.runtime, clock=lambda: self.now, sleep=sleep)

    def answer(self, *argv):
        calls = []
        output = io.StringIO()
        with patch.dict(os.environ, {"HERDR_ENV": "1"}), patch("workflow.guardrails.time.time", lambda: self.now), \
                patch("workflow.herdr.subprocess.run", side_effect=lambda command, **_: calls.append(command) or subprocess.CompletedProcess(command, 0, "", "")), \
                contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
            try:
                answer_main([str(self.root), *argv])
                code = 0
            except SystemExit as exit_:
                code = exit_.code
        return calls, output.getvalue(), code

    def test_worker_question_pauses_only_its_lane_survives_restart_is_answered_through_the_pane_and_a_fourth_blocks(self):
        """Scenario worker-question."""
        self.ask("Option A or B?")
        ticks = iter([10.0, self.TIMEOUT + 5])

        def advance():
            self.now = next(ticks)
        advance()
        # ui asked at t=10: its deadline pauses; adapter's keeps running and expires.
        with self.assertRaisesRegex(RuntimeError, "Worker adapter deadline exhausted"):
            self.wait(on_sleep=advance)
        self.assertFalse((self.root / "ui.completion.json").exists())
        self.assertEqual(read_json(self.root / "ui.question-1.json")["question"], "Option A or B?")
        self.assertEqual(read_json(self.root / "ui.questions.json")["questions"],
                         [{"n": 1, "question": "Option A or B?", "asked_at": "1970-01-01T00:00:10Z", "answer": None, "answered_at": None}])
        self.assertEqual(read_json(self.root / "ui.deadline.json"), {"node_id": "ui", "paused_seconds": 0.0, "paused_at": "1970-01-01T00:00:10Z"})
        self.assertEqual([event[:2] for event in self.events], [("ui", "interactive")])
        self.assertIn("question 1 of 3", self.events[0][2])
        # A restarted controller long after ui's own deadline: the persisted pause keeps ui waiting. (adapter was relaunched meanwhile.)
        self.now = answered_at = self.TIMEOUT * 3
        save_json(self.root / "adapter.interactive.json", {"launch_requested_at": "1970-01-01T12:00:00+00:00", "background_id": "bg-adapter"})
        self.completion("adapter")
        self.states["adapter"] = "idle"
        extended = self.TIMEOUT + (answered_at - 10.0)
        rounds = []

        def operator_answers():
            rounds.append(self.now)
            if len(rounds) == 1:
                calls, output, code = self.answer("ui", "Use option B")
                self.assertEqual(code, 0, output)
                # A fake Herdr receives the text, then Enter, in the worker's pane.
                self.assertEqual(calls, [["herdr", "pane", "send-text", "pane-ui", "Use option B"], ["herdr", "pane", "send-keys", "pane-ui", "Enter"]])
            else:
                self.now = extended + 1  # The deadline runs again from the answer: past the extended deadline, ui expires.
        with self.assertRaisesRegex(RuntimeError, "Worker ui deadline exhausted"):
            self.wait(on_sleep=operator_answers)
        entry = read_json(self.root / "ui.questions.json")["questions"][0]
        self.assertEqual((entry["answer"], entry["answered_at"]), ("Use option B", "1970-01-01T12:00:00Z"))
        self.assertEqual(read_json(self.root / "ui.deadline.json"), {"node_id": "ui", "paused_seconds": answered_at - 10.0, "paused_at": None})
        self.assertIn(("ui", "interactive", "Worker ui question 1 answered; its deadline runs again"), self.events)
        # Just inside the extended deadline, ui's completion is accepted.
        self.now = extended - 1
        self.completion("ui")
        self.wait()
        self.assertEqual(read_json(self.root / "ui.handoff.json"), {"summary": "Work", "open_assumptions": []})
        # Nothing waits now: answer is refused.
        _, output, code = self.answer("ui", "Again")
        self.assertEqual(code, 1)
        self.assertIn("no unanswered question", output)
        # Typing in the pane answers too: the session working again after a question restarts the deadline.
        self.ask("Second?")
        steps = iter([lambda: self.states.update(ui="working"), lambda: (self.states.update(ui="idle"), self.completion("ui"))])
        self.wait(on_sleep=lambda: next(steps)())
        self.assertEqual(read_json(self.root / "ui.questions.json")["questions"][1]["answer"], "(answered by typing in the worker's pane)")
        self.assertIsNone(read_json(self.root / "ui.deadline.json")["paused_at"])
        # Without Herdr, answer prints the attach command for the operator to type the answer.
        self.ask("Third?")
        answers = []

        def answer_without_herdr():
            if not answers:
                answers.append(self.answer("ui", "Decide yourself", "--no-herdr"))
            else:
                self.completion("ui")
        self.wait(on_sleep=answer_without_herdr)
        calls, output, code = answers[0]
        self.assertEqual((calls, code), ([], 0), output)
        self.assertIn("claude attach bg-ui", output)
        # A fourth question is treated as blocked; the prompt said so from the start.
        self.ask("Fourth?")
        with self.assertRaisesRegex(RuntimeError, "Worker ui asked question 4; at most 3 are answered, so it is treated as blocked"):
            self.wait()
        self.assertTrue((self.root / "ui.completion.json").exists())
        self.assertEqual(len(read_json(self.root / "ui.questions.json")["questions"]), 3)
        from .automatic import completion_prompt
        self.plan["nodes"]["ui"]["task"] = BRIEF.format(lane="ui")
        prompt = completion_prompt(self.root, self.plan, "ui")
        self.assertIn("a fourth question is treated as blocked", prompt)
        self.assertIn("Stop (from your task, the bound on this work): After three failed fixes, report blocked.", prompt)


class ExportSeam(unittest.TestCase):
    def test_export_seam_1_5_0_carries_decisions_challenge_evidence_and_questions_and_older_runs_export_nulls(self):
        """Scenario export-seam (the Python half; contracts/projects/contract.test.ts and server/projects.test.ts serve it)."""
        with tempfile.TemporaryDirectory() as root:
            directory = legacy_run(Path(root))
            before = export_run(ExportRuntime(directory))
            self.assertEqual(before["version"], EXPORT_VERSION)
            self.assertEqual(EXPORT_VERSION, "1.5.0")
            self.assertEqual((before["inputs"]["decisions"], before["inputs"]["challenge"]), (None, None))
            self.assertEqual([worker["questions"] for worker in before["inputs"]["workers"].values()], [[], []])
            self.assertEqual(before["inputs"]["workers"]["ui"]["completion"]["falsifying_check"], None)
            self.assertNotIn("challenge", [node["node_id"] for node in before["definition"]["nodes"]])
            plan = read_json(directory / "plan.json")
            plan.update(completion_version="1.1.0", challenge=True, decisions={"path": "/x/decisions.md", "text": DECISIONS})
            save_json(directory / "plan.json", plan)
            record = {"version": "1.0.0", "run_id": "legacy-001", "status": "accepted", "attempt": 2, "session_id": "s-2",
                      "pinned": {"tasks_sha256": "a" * 64, "decisions_sha256": "b" * 64, "prd_sha256": None},
                      "concerns": [concern("P1")], "simpler_alternative": "One lane", "cheap_experiment": "A spike",
                      "accepted_reason": "Known risk", "decided_at": "2026-09-23T10:00:00Z"}
            save_json(directory / "challenge.json", record)
            save_json(directory / "ui.completion.json", {**read_json(directory / "ui.completion.json"), "version": "1.1.0", "untested": ["x"],
                                                         "falsifying_check": "unit", "verify_yourself": "y", "question": None})
            save_json(directory / "ui.questions.json", {"node_id": "ui", "questions": [
                {"n": 1, "question": "A?", "asked_at": "2026-09-23T10:01:00Z", "answer": "B", "answered_at": "2026-09-23T10:02:00Z"},
                {"n": 2, "question": "C?", "asked_at": "2026-09-23T10:03:00Z", "answer": None, "answered_at": None}]})
            exported = export_run(ExportRuntime(directory))
            inputs = exported["inputs"]
            self.assertEqual(inputs["decisions"], DECISIONS)
            self.assertEqual(inputs["challenge"], {**{key: value for key, value in record.items() if key not in {"run_id", "version"}}, "attempts": 2})
            self.assertEqual(inputs["workers"]["ui"]["completion"], {"status": "completed", "summary": "ui implemented", "open_assumptions": ["assumed"],
                                                                     "untested": ["x"], "falsifying_check": "unit", "verify_yourself": "y"})
            self.assertEqual([entry["answer"] for entry in inputs["workers"]["ui"]["questions"]], ["B", None])
            self.assertEqual(inputs["workers"]["adapter"]["questions"], [])
            self.assertEqual(exported["definition"]["nodes"][0], {"node_id": "challenge", "label": "Design challenge", "kind": "review", "depends_on": []})
            # An invalid challenge record is not evidence: null, never guessed.
            save_json(directory / "challenge.json", {**record, "status": "maybe"})
            self.assertIsNone(export_run(ExportRuntime(directory))["inputs"]["challenge"])



class GrillSkill(unittest.TestCase):
    def test_the_workflow_grill_skill_has_valid_frontmatter_follows_the_interview_rules_and_the_readme_links_it(self):
        """PRD section 4.4: the interview skill ships with the tool."""
        text = (TOOL / "workflow/skills/workflow-grill/SKILL.md").read_text()
        self.assertTrue(text.startswith("---\n"))
        header, body = text[4:].split("\n---\n", 1)
        fields = dict(line.split(": ", 1) for line in header.splitlines())
        self.assertEqual(fields["name"], "workflow-grill")
        self.assertGreater(len(fields["description"]), 40)
        for rule in ("at most five questions", "one at a time", "recommended default", "consequence", "features/<feature>/decisions.md",
                     "## Decisions", "## Assumptions", "## Deferred", "never writes code"):
            self.assertIn(rule.lower(), (fields["description"] + body).lower(), rule)
        readme = (TOOL / "workflow/README.md").read_text()
        self.assertIn('ln -s "$HOME/dev/md-manager/workflow/skills/workflow-grill" ~/.claude/skills/workflow-grill', readme)

if __name__ == "__main__":
    unittest.main()
