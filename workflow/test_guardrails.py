"""Workflow guardrails slice 2 (docs/PRD_PORTABLE_WORKFLOW.md, section 6, lane controller): one test per scenario id.

Targets are temporary Git repositories; HOME and the registry path point into temporary directories, and Herdr is
a patched subprocess. Workers are FakeSessions; the design challenge is a fake `claude --print` executable. No
Claude model calls.
"""
import contextlib
import hashlib
import io
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from langgraph.checkpoint.sqlite import SqliteSaver
from langgraph.types import Command

from . import guardrails, pipeline
from .automatic import DEFAULTS, read_completion, read_signal, review_prompt, wait_handoffs
from .checks import now
from .export_state import EXPORT_VERSION, graph_nodes, inputs_section
from .guardrails import CHECK_REPORT, PANE_ANSWER, answer_main, brief_problems, iso, pinned_task, repin, resume_main, stop_rule
from .interactive import worker_prompt, write_private
from .launch import TOOL, launch_commands
from .pipeline import ExportRuntime, build_pipeline, combine_imported_reviews, export_run, graph_config
from .sessions import plan_digest, read_json, save_json
from .test_export import legacy_run
from .test_pipeline import FakeSessions, OfflinePipeline, isolate_registry
from .test_portable import Isolated, commit_all, git
from .verification import validate_schema

PY = sys.executable
FEATURE = "guarded"
LANES = ["ui", "adapter"]
BRIEF = "## Goal\n\nChange {lane}.\n\n## Acceptance\n\nThe {lane} check passes.\n\n## Stop\n\nAfter three failed fixes, report blocked.\n"
DECISIONS = "# Decisions\n\n## Decisions\n\n- Keep the lanes apart: DECISION-MARKER-42.\n\n## Assumptions\n\nNone.\n\n## Deferred\n\nNothing.\n"
# What the workflow-grill skill writes since C4: the operator's answers apart from the grill's own defaults.
SPLIT_DECISIONS = ("# Decisions: guarded\n\nFrom the grill session of 3 Oct 2026 with the operator.\n\n## Operator decisions\n\n"
                   "- [O1] Q1: Keep the lanes apart. Operator: \"yes, DECISION-MARKER-42\".\n\n## Grill defaults\n\n"
                   "- [G1] The adapter keeps VALUE an integer [added, not asked].\n\n## Changes after launch\n\nNone yet.\n\n"
                   "## Deferred\n\n- Nothing.\n")
# A target's CLAUDE.md (C15): the project's conventions above the operator-notes heading, the operator's notes below it.
CONVENTIONS = "# Project conventions\n\n- Run the unit tests with `python -m unittest`: CONVENTION-MARKER-9.\n\n"
OPERATOR_NOTES = "\n\n- Workers run targeted tests only: OPERATOR-NOTE-3.\n"


def setUpModule():
    isolate_registry()  # Attention records go beside a temporary registry, never the operator's.


def two_lane_policy() -> dict:
    check = {"kind": "unit", "argv": ["python", "-c", "print('Ran 1 test in 0.001s\\n\\nOK')"], "timeout_seconds": 10, "scenarios": []}
    return {"version": "1.2.0", "feature": "Guarded", "independent_review": True, "integration_approval": True, "max_verification_attempts": 3,
            "workers": [{"node_id": "ui", "role": "frontend", "required_check_kinds": ["unit"], "owned_paths": ["ui.txt"], "checks": [{"id": "ui-unit", **check}]},
                        {"node_id": "adapter", "role": "backend", "required_check_kinds": ["unit"], "owned_paths": ["backend.py"], "checks": [{"id": "unit", **check}]}]}


def pane_process_info(pane: str, *argvs: list[str]) -> dict:
    """What `herdr pane process-info` prints (Herdr 0.9, probed live) for a pane whose shell (pid 100) runs these argvs in its
    foreground, as one process group; with none, the shell itself is its foreground."""
    foreground = [{"argv": argv, "cmdline": " ".join(argv), "name": Path(argv[0]).name, "pid": 101 + index} for index, argv in enumerate(argvs)]
    shell = [{"argv": ["/bin/bash"], "cmdline": "/bin/bash", "name": "bash", "pid": 100}]
    return {"id": "cli:pane:process_info", "type": "pane_process_info",
            "result": {"process_info": {"pane_id": pane, "shell_pid": 100, "foreground_process_group_id": 101 if argvs else 100,
                                        "foreground_processes": foreground or shell}}}


def attached_pane(pane: str, run: Path, lane: str, background_id: str) -> dict:
    """A pane whose attach-one (the command attach_pane types into it) runs `claude attach <background_id>`."""
    return pane_process_info(pane, [PY, "-m", "workflow.interactive", "attach-one", str(run), "--node", lane], ["claude", "attach", background_id])


def claude_screen(*typed: str) -> str:
    """What `herdr pane read --source visible` prints for a pane showing a Claude Code session (probed live): its transcript,
    then the input box, a labelled rule, `❯` and the input's first line, its wrapped lines, a closing rule; `typed` are those lines."""
    rule = "─" * 40
    return "\n".join(["● Option A or B? Use option B if the adapter owns it.", "", f"{rule} ui ─", "❯\xa0" + (typed[0] if typed else ""),
                      *(f"  {line}" for line in typed[1:]), rule, "  ⏵⏵ bypass permissions on (shift+tab to cycle)", ""])


def input_at_bottom(*typed: str) -> str:
    """A capture that ends at the Claude Code input, with no closing rule under it, as 20 of the 25 `pane_busy` refusals in
    pine's sidecar ledgers read (sidecar-inputs/<n>/<lane>.pane.txt): the working line, the labelled rule, `❯` and the input's
    lines, then nothing; `typed` are those lines."""
    return "\n".join(["✽ Cogitating… (30m 35s · ↓ 65.0k tokens · thought for 1s)", "  ⎿ Tip: Use /clear to start fresh when switching topics", "",
                      f"{'─' * 40} workflow-run-ui ─", "❯\xa0" + (typed[0] if typed else ""), *(f"  {line}" for line in typed[1:])]) + "\n"


def concern(severity: str, message: str = "A concern") -> dict:
    return {"severity": severity, "kind": "assumption", "message": message, "consequence": f"{message} breaks the run"}


class RecordingSessions(FakeSessions):
    """FakeSessions that keep what each worker launch was given: its session's plan digest and the prompt a native launch sends,
    which they also keep as `<lane>.prompt.txt`, as InteractiveSessions.run does (the viewer shows it). That file is the fake's
    own copy, so an assertion on it here passes by construction: test_interactive's test_worker_launch_records_the_exact_prompt
    pins what InteractiveSessions.run writes there, the challenge notes included."""

    def __init__(self, directory, plan, given: dict):
        super().__init__(directory, plan)
        self.given = given

    def run(self, node):
        prompt = worker_prompt(self.directory, self.plan, node)
        self.given[node] = {"plan_digest": plan_digest(self.plan), "prompt": prompt}
        write_private(self.directory / f"{node}.prompt.txt", prompt)
        return super().run(node)


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
    handle.write(json.dumps({{"cwd": os.getcwd(), "prompt": prompt, "add_dirs": add_dirs,
                              "schema": json.loads(args[args.index('--json-schema') + 1])}}) + '\\n')
with (Path.cwd().parent / 'fake-launches.log').open('a') as log:  # The worker fake logs its launches to the same file.
    log.write('challenge\\n')
print(json.dumps({{"session_id": args[args.index('--session-id') + 1], "is_error": False, "subtype": "success",
                  "structured_output": json.loads(Path({str(self.output)!r}).read_text())}}))
''')
        self.executable.chmod(0o700)
        self.given = {}  # Per lane, what its launch was given (RecordingSessions).

    def challenge_says(self, concerns: list) -> None:
        save_json(self.output, {"concerns": concerns, "simpler_alternative": "One lane instead of two",
                                "cheap_experiment": "Prototype the ui change first"})

    def challenge_calls(self) -> list:
        return [json.loads(line) for line in self.calls.read_text().splitlines()] if self.calls.exists() else []

    def prepare(self, run_id: str, automatic: bool = False) -> Path:
        """The exact worktree and prepare commands a launch runs, executed against the target.

        The run's own worktree is its source checkout from then on: self.repo and self.folder follow it, as the operator
        edits a paused run's feature files where the paused message says. A later prepare launches from there.
        """
        run, commands, _ = launch_commands(self.repo, FEATURE, run_id, self.runs, herdr=False, automatic=automatic)
        subprocess.run(commands[1], cwd=self.repo, check=True, capture_output=True)
        result = subprocess.run(commands[2], cwd=TOOL, capture_output=True, text=True, timeout=120)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.repo = Path(commands[1][-2])
        self.folder = self.repo / "features" / FEATURE
        return run

    def sessions(self, directory: Path) -> FakeSessions:
        sessions = RecordingSessions(directory, read_json(directory / "plan.json"), self.given)
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
        source = Path(printed["source_checkout"])  # The same committed files, in the run's own worktree.
        self.assertEqual(prepare[prepare.index("--guardrails"):], ["--guardrails", "--decisions", str(source / f"features/{FEATURE}/decisions.md"),
                                                                     "--prd", str(source / "docs/PRD.md")])
        self.assertEqual(printed["guardrails"], {"feature_version": "2.2.0", "enforced": True, "challenge": True, "migration_note": None,
                                                 "conventions": "none"})
        self.assertEqual(printed["registry"]["entry"]["workflows"][0]["definition"]["nodes"][0]["node_id"], "challenge")
        # The same feature at 2.1.0: nothing is refused (not even a task without headings), the commands carry no
        # guardrail flag and the launch prints the migration note beside its (empty) notes.
        task.write_text("# ui\n\nJust do it.\n")
        (self.folder / "decisions.md").unlink()
        manifest = {key: value for key, value in self.manifest.items() if key != "prd"}
        save_json(self.folder / "feature.json", {**manifest, "version": "2.1.0"})
        commit_all(self.repo)
        with patch("workflow.launch.run_command") as command, contextlib.redirect_stdout(io.StringIO()) as output, \
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
        self.assertIsNone(printed["guardrails"]["conventions"])  # Prepare pins no conventions for it (C15).
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
        decisions = self.folder / "decisions.md"  # In the run's source checkout, where a paused run's feature files are edited.
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
        # This file has no `## Operator decisions` heading: it binds as a whole, as every decisions.md before C4 did.
        self.assertIn("Decisions recorded before launch (decisions.md; they bind this run):\n" + DECISIONS, worker_prompt(directory, plan, "ui"))
        # A split file reaches the same prompts with its precedence: only the Operator decisions bind (DecisionsPrecedence).
        plan["decisions"]["text"] = SPLIT_DECISIONS
        for prompt in (worker_prompt(directory, plan, "ui"), *(review_prompt(runtime, directory / "review.diff", reviewer) for reviewer in plan["reviewers"])):
            self.assertIn(guardrails.decisions_block(plan), prompt)
            self.assertIn("Its Operator decisions are the operator's own answers: they bind this run and win over the task.", prompt)
        # A run without decisions (every run before slice 2) gets no decisions block.
        plan.pop("decisions")
        self.assertNotIn("Decisions recorded before launch", worker_prompt(directory, plan, "ui") + review_prompt(runtime, directory / "review.diff"))


class DecisionsPrecedence(unittest.TestCase):
    """C4 (decision 8): a decisions.md with the `## Operator decisions` heading binds only those, and they win over the task; the
    challenge may reopen one only as a P1 that shows it cannot hold, the rest like the tasks. A file without the heading (every
    one written before) keeps today's wording: all of it binds. Keyed on the heading alone; no section is parsed."""

    def plan(self, text: str) -> dict:
        return {"run_id": "precedence-001", "workers": ["ui"], "nodes": {"ui": {"task": BRIEF.format(lane="ui")}},
                "decisions": {"path": "/target/features/guarded/decisions.md", "text": text}}

    def challenge_prompt(self, plan: dict) -> str:
        with tempfile.TemporaryDirectory() as root:
            return guardrails.challenge_prompt(Path(root), plan)

    # What a split file tells reviewers (and the workers, who read the same block): a permitted departure from a grill default is
    # no contradicted requirement, so the rubric's "P1 at least" does not block the candidate for it.
    REVIEWER_RULE = ("For reviewers: a candidate behaviour that contradicts an Operator decision is P1 at least, and one that an Operator "
                     "decision requires contradicts no line of a task or of a document a task cites. A departure from another section that "
                     "is named so, stays inside the lane's owned paths and changes nothing another lane reads is no contradicted "
                     "requirement: judge only what it does. An unnamed or out-of-lane departure is a contradicted requirement.")

    def test_a_split_file_binds_only_the_operator_decisions_and_leaves_the_rest_open_to_the_challenge(self):
        plan = self.plan(SPLIT_DECISIONS)
        self.assertEqual(guardrails.decisions_block(plan),
                         "\n\nDecisions recorded before launch (decisions.md). Its Operator decisions are the operator's own answers: they bind "
                         "this run and win over the task. Workers follow its other sections too, and may depart from a grill default or a "
                         "change after launch only to apply a design-challenge note, or when the code shows the bullet cannot hold, and only "
                         "inside their own lane's owned paths; a departure that would change anything another lane reads is a question for "
                         "the operator instead. Each departure is named, with the bullet's id, in the completion's open_assumptions. "
                         + self.REVIEWER_RULE + " The file:\n" + SPLIT_DECISIONS.rstrip() + "\n")
        prompt = self.challenge_prompt(plan)
        self.assertIn("raise one only for a consequence you can name; reopen an Operator decision of decisions.md (the operator's own "
                      "answer) only by showing it cannot hold, and then as a P1; the rest of decisions.md is open to challenge, like the "
                      "tasks. kind is assumption", prompt)
        self.assertNotIn("do not reopen what decisions.md settles", prompt)
        self.assertIn(f"=== decisions.md ===\n{SPLIT_DECISIONS}", prompt)
        self.assertTrue(guardrails.has_operator_decisions("# D\n\n## Operator decisions  \n\n- [O1] Q1: x.\n"))  # Trailing blanks count.

    def test_a_file_without_the_heading_binds_as_a_whole_with_todays_wording(self):
        lookalikes = (DECISIONS, DECISIONS + "\n### Operator decisions\n\n- A level-3 heading.\n", DECISIONS + "\nSee ## Operator decisions.\n",
                      DECISIONS.replace("## Decisions", "## Operator decisions made"), DECISIONS.replace("## Decisions", "## Operator Decisions"),
                      # A legacy file that quotes the grill's template in a fence (a feature about the grill itself): as sections() reads it.
                      DECISIONS + "\n```markdown\n## Operator decisions\n\n- [O1] Q1: <the chosen option's text>.\n```\n")
        for text in lookalikes:
            with self.subTest(text=text):
                plan = self.plan(text)
                self.assertFalse(guardrails.has_operator_decisions(text))
                self.assertEqual(guardrails.decisions_block(plan), "\n\nDecisions recorded before launch (decisions.md; they bind this run):\n"
                                 + text.rstrip() + "\n")
                self.assertIn("raise one only for a consequence you can name; do not reopen what decisions.md settles unless you show it "
                              "cannot hold. kind is assumption", self.challenge_prompt(plan))
        self.assertEqual(guardrails.decisions_block({}), "")  # A run without decisions (every run before slice 2).

    def test_every_reviewer_of_a_split_file_gets_the_reviewer_rule_in_both_transports_and_a_legacy_file_reaches_them_unchanged(self):
        # The rubric makes a contradicted line of decisions.md P1 at least and says a disclosure never lowers a severity. For a split
        # file only an Operator decision is such a line: a worker's permitted, named departure from a grill default must not block the
        # candidate. A file without the heading still binds as a whole, in the wording runs always had.
        from .automatic import REVIEW_RUBRIC, completion_protocol_prompt, print_review_prompt, review_prompt
        self.assertIn("A candidate behaviour that contradicts a quoted requirement, a line of a task, of a document a task cites or of an "
                      "Operator decision in decisions.md (all of decisions.md when it has no Operator decisions heading) included, is P1 at "
                      "least", REVIEW_RUBRIC)
        self.assertNotIn("or of decisions.md is P1", REVIEW_RUBRIC)
        self.assertNotIn("or of decisions.md included", REVIEW_RUBRIC)
        coverage = {"reviewer_id": "coverage", "prompt": (TOOL / "workflow/prompts/reviewers/coverage.md").read_text()}
        with tempfile.TemporaryDirectory() as root:
            patch_path = Path(root) / "review.diff"
            for text, split in ((SPLIT_DECISIONS, True), (DECISIONS, False)):
                runtime = SimpleNamespace(directory=Path(root), plan=self.plan(text), workers=["ui"])
                for reviewer in (None, coverage):
                    printed = print_review_prompt(runtime, patch_path, reviewer)
                    native = review_prompt(runtime, patch_path, reviewer) + completion_protocol_prompt(runtime, "token", "0" * 64, "c" * 40)
                    for transport, prompt in (("print", printed), ("native", native)):
                        with self.subTest(split=split, reviewer=(reviewer or {}).get("reviewer_id", "review"), transport=transport):
                            self.assertIn(REVIEW_RUBRIC, prompt)
                            self.assertIn(guardrails.decisions_block(runtime.plan), prompt)
                            self.assertEqual(self.REVIEWER_RULE in prompt, split)
                            self.assertEqual("For reviewers" in prompt, split)
                            if not split:
                                self.assertIn("\n\nDecisions recorded before launch (decisions.md; they bind this run):\n" + DECISIONS.rstrip() + "\n", prompt)


class Conventions(GuardedFeature):
    """C15 (decision 6): sessions start with --safe-mode, which loads no CLAUDE.md, so prepare pins the target's CLAUDE.md as the
    run's base commit holds it, cut at the operator-notes heading, and every worker, challenge and reviewer prompt gets it
    before decisions.md. A target without the file pins an empty text; a plan pinned before C15 has no key; both get nothing."""

    def commit_claude(self, text: str) -> str:
        (self.repo / "CLAUDE.md").write_text(text)
        commit_all(self.repo, "CLAUDE.md")
        return git(self.repo, "rev-parse", "HEAD")

    def dry_run_output(self) -> tuple[dict, str]:
        """The dry run's JSON and its stderr (the notes)."""
        from .launch import main as launch_main
        with patch("workflow.launch.run_command") as command, contextlib.redirect_stdout(io.StringIO()) as output, \
                contextlib.redirect_stderr(io.StringIO()) as errors:
            launch_main([FEATURE, "--repo", str(self.repo), "--no-herdr", "--dry-run"])
        command.assert_not_called()
        return json.loads(output.getvalue()), errors.getvalue()

    def test_the_base_commits_claude_md_is_pinned_up_to_the_operator_notes_heading_whatever_the_tree_holds(self):
        # A heading quoted in a code fence cuts nothing; a section above the heading is a convention like any other.
        above = (CONVENTIONS + "Notes about runs go under this heading:\n\n```\n" + guardrails.OPERATOR_NOTES + "\n```\n\n"
                 "## Boundaries\n\n- Never change vendor/.\n\n")
        base = self.commit_claude(above + guardrails.OPERATOR_NOTES + OPERATOR_NOTES)
        directory = self.prepare("conventions-001")
        plan = read_json(directory / "plan.json")
        self.assertEqual(plan["base_commit"], base)
        self.assertEqual(plan["conventions"], {"commit": base, "sha256": hashlib.sha256(above.encode()).hexdigest(), "text": above})
        self.assertEqual(guardrails.conventions_block(plan), f"\n\nProject conventions (CLAUDE.md at {base}; the controller's rules, the "
                                                             f"task and decisions.md take precedence):\n{above.rstrip()}\n")
        # Always the base commit's text: neither an edit in the checkout nor a later commit changes what that base pins.
        (self.repo / "CLAUDE.md").write_text("# Edited in the checkout: TREE-MARKER\n")
        self.assertEqual(guardrails.conventions(plan), plan["conventions"])
        self.commit_claude("# Committed later: LATER-MARKER\n")
        self.assertEqual(guardrails.conventions(plan), plan["conventions"])
        # repin re-reads the feature files only: resume commits nothing else, so CLAUDE.md is the same at every base it moves to.
        (self.folder / "ui-task.md").write_text(BRIEF.format(lane="ui") + "\nRe-pinned.\n")
        repin(directory, plan, read_json(directory / "policy.json"))
        self.assertEqual(read_json(directory / "plan.json")["conventions"], {"commit": base, "sha256": hashlib.sha256(above.encode()).hexdigest(),
                                                                              "text": above})

    def test_a_file_without_the_heading_is_sent_whole_and_none_or_a_link_out_of_the_target_pins_an_empty_text(self):
        whole = self.commit_claude(CONVENTIONS)
        plan = {"repository": str(self.repo), "base_commit": whole}
        self.assertEqual(guardrails.conventions(plan), {"commit": whole, "sha256": hashlib.sha256(CONVENTIONS.encode()).hexdigest(), "text": CONVENTIONS})
        # A link inside the target is followed, as Claude Code follows it on disk.
        (self.repo / "AGENTS.md").write_text(CONVENTIONS + guardrails.OPERATOR_NOTES + OPERATOR_NOTES)
        (self.repo / "CLAUDE.md").unlink()
        (self.repo / "CLAUDE.md").symlink_to("AGENTS.md")
        commit_all(self.repo, "Linked")
        self.assertEqual(guardrails.conventions({**plan, "base_commit": git(self.repo, "rev-parse", "HEAD")})["text"], CONVENTIONS)
        empty = {"sha256": hashlib.sha256(b"").hexdigest(), "text": ""}
        (self.repo / "CLAUDE.md").unlink()
        (self.repo / "CLAUDE.md").symlink_to("../outside.md")
        commit_all(self.repo, "Linked out of the target")
        outside = git(self.repo, "rev-parse", "HEAD")
        self.assertEqual(guardrails.conventions({**plan, "base_commit": outside}), {"commit": outside, **empty})
        (self.repo / "CLAUDE.md").unlink()
        commit_all(self.repo, "No CLAUDE.md")
        directory = self.prepare("no-conventions-001")
        pinned = read_json(directory / "plan.json")
        self.assertEqual(pinned["conventions"], {"commit": pinned["base_commit"], **empty})
        self.assertEqual(guardrails.conventions_block(pinned), "")

    def test_the_dry_run_prints_the_source_and_size_or_none_and_notes_each_section_below_the_heading(self):
        (self.folder / "decisions.md").write_text(SPLIT_DECISIONS)  # No legacy Note: the notes below are the conventions' own.
        commit_all(self.repo, "Split decisions")
        printed, errors = self.dry_run_output()
        self.assertEqual((printed["guardrails"]["conventions"], printed["notes"]), ("none", []))
        head = self.commit_claude(CONVENTIONS + guardrails.OPERATOR_NOTES + OPERATOR_NOTES)
        (self.repo / "CLAUDE.md").write_text("# An edit not committed yet\n")  # The dry run reads HEAD, which prepare pins.
        printed, errors = self.dry_run_output()
        self.assertEqual(printed["guardrails"]["conventions"], f"CLAUDE.md at {head}: {len(CONVENTIONS.encode())} bytes, up to the operator-notes heading")
        self.assertEqual((printed["notes"], errors), ([], ""))
        head = self.commit_claude(CONVENTIONS)
        printed, _ = self.dry_run_output()
        self.assertEqual(printed["guardrails"]["conventions"],
                         f"CLAUDE.md at {head}: {len(CONVENTIONS.encode())} bytes, the whole file (it has no operator-notes heading)")
        # A section below the heading is cut with the operator's notes: the dry run names it, in its notes and on stderr. A
        # line inside a code fence is no section.
        head = self.commit_claude(CONVENTIONS + guardrails.OPERATOR_NOTES + OPERATOR_NOTES + "\n## Hazards\n\n- Chains differ.\n\n```\n## not a heading\n```\n")
        printed, errors = self.dry_run_output()
        self.assertEqual(printed["guardrails"]["conventions"], f"CLAUDE.md at {head}: {len(CONVENTIONS.encode())} bytes, up to the operator-notes heading")
        [note] = printed["notes"]
        self.assertEqual(note, f"CLAUDE.md at {head} has ## Hazards below '{guardrails.OPERATOR_NOTES}': that text is cut with the operator's "
                               "notes, so no session gets it. Move what sessions must follow above the heading.")
        self.assertIn(f"Note: {note}\n", errors)
        # Nothing above the heading: nothing is sent.
        self.commit_claude(guardrails.OPERATOR_NOTES + OPERATOR_NOTES)
        self.assertEqual(self.dry_run_output()[0]["guardrails"]["conventions"], "none")

    def test_every_worker_challenge_and_reviewer_prompt_gets_the_block_before_decisions_and_older_plans_get_none(self):
        from .automatic import completion_protocol_prompt, print_review_prompt
        self.commit_claude(CONVENTIONS + guardrails.OPERATOR_NOTES + OPERATOR_NOTES)
        directory = self.prepare("roles-001")
        output, code = self.cli(pipeline.main, ["start", str(directory), "--live"])
        self.assertEqual(code, 0, output)
        plan = read_json(directory / "plan.json")
        block, decisions = guardrails.conventions_block(plan), guardrails.decisions_block(plan)
        self.assertIn("CONVENTION-MARKER-9", block)
        challenge = self.challenge_calls()[-1]["prompt"]
        self.assertLess(challenge.index(block), challenge.index("=== decisions.md ==="))
        prompts = {"challenge": challenge, **{f"worker {lane}": self.given[lane]["prompt"] for lane in LANES},
                   "automatic worker": worker_prompt(directory, {**plan, "automatic": dict(DEFAULTS)}, "ui")}
        runtime = SimpleNamespace(directory=directory, plan=plan, workers=LANES)
        for reviewer in [None, *plan["reviewers"]]:
            name = (reviewer or {}).get("reviewer_id", "review")
            prompts[f"print reviewer {name}"] = print_review_prompt(runtime, directory / "review.diff", reviewer)
            prompts[f"native reviewer {name}"] = (review_prompt(runtime, directory / "review.diff", reviewer)
                                                  + completion_protocol_prompt(runtime, "token", "0" * 64, "c" * 40, name))
        for role, prompt in prompts.items():
            with self.subTest(role=role):
                self.assertEqual(prompt.count(block), 1)
                self.assertNotIn("OPERATOR-NOTE-3", prompt)
                if role != "challenge":
                    self.assertLess(prompt.index(block), prompt.index(decisions))
        # A plan pinned before C15 has no conventions key, and an empty text adds nothing either.
        for older in ({key: value for key, value in plan.items() if key != "conventions"}, {**plan, "conventions": {**plan["conventions"], "text": "\n"}}):
            with self.subTest(conventions=older.get("conventions")):
                self.assertEqual(guardrails.conventions_block(older), "")
                prompts = (worker_prompt(directory, older, "ui"), review_prompt(SimpleNamespace(directory=directory, plan=older, workers=LANES),
                                                                                  directory / "review.diff"), guardrails.challenge_prompt(directory, older))
                self.assertFalse(any("Project conventions" in prompt for prompt in prompts))


class FailingChallenge(GuardedFeature):
    """The design challenge's failure paths (RUNBOOK "The design challenge"): none counts as a pass. Each blocks `start`
    with a `blocked` event, launches no worker, writes no challenge.json and leaves the run for `resume`."""

    def setUp(self):
        super().setUp()
        self.mode = self.root / "challenge-mode"
        self.mode.write_text("pass")
        # One fake job per mode; like the default fake it logs its launch first.
        self.executable.write_text(f'''#!{PY}
import json, sys, time
from pathlib import Path
args = sys.argv
sys.stdin.read()
with (Path.cwd().parent / 'fake-launches.log').open('a') as log:
    log.write('challenge\\n')
mode = Path({str(self.mode)!r}).read_text()
output = {{"concerns": [], "simpler_alternative": "One lane", "cheap_experiment": "A spike"}}
result = {{"session_id": args[args.index('--session-id') + 1], "is_error": False, "subtype": "success", "structured_output": output}}
if mode == 'is_error':
    result.update(is_error=True, subtype='error_during_execution')
elif mode == 'session':
    result['session_id'] = '00000000-0000-4000-8000-000000000000'
elif mode == 'schema':
    output['concerns'] = [{{"severity": "P3", "kind": "assumption", "message": "m", "consequence": "c"}}]
elif mode == 'timeout':
    time.sleep(60)
elif mode == 'slow':
    time.sleep(0.6)
elif mode == 'worktree':
    Path('stray.txt').write_text('A read-only job changed its checkout')
if mode == 'not-an-object':
    print('[]')
elif mode != 'missing':
    print(json.dumps(result))
sys.exit(1 if mode == 'exit' else 0)
''')

    def events(self, directory: Path) -> list:
        return [(event["node"], event["status"], event["message"]) for event in map(json.loads, (directory / "events.jsonl").read_text().splitlines())]

    def fails(self, run_id: str, mode: str, message: str, jobs: list | None = None) -> Path:
        """A fresh run whose first challenge job fails in `mode`: blocked, no worker, no decision, and resumable."""
        jobs = ["challenge"] if jobs is None else jobs
        self.mode.write_text(mode)
        directory = self.prepare(run_id)
        with self.subTest(run_id):
            output, code = self.cli(pipeline.main, ["start", str(directory), "--live"])
            self.assertEqual(code, 1, output)
            self.assertIn("Blocked:", output)
            self.assertIn(message, output)
            self.assertNotIn("Traceback", output)
            blocked = [event for event in self.events(directory) if event[:2] == ("challenge", "blocked")]
            self.assertEqual(len(blocked), 1, self.events(directory))
            self.assertIn(message, blocked[0][2])
            self.assertNotIn(("challenge", "succeeded"), [event[:2] for event in self.events(directory)])
            self.assertFalse((directory / "challenge.json").exists())
            self.assertEqual(read_json(directory / "challenge.running.json")["attempt"], 1)
            self.assertEqual(self.launches(directory), jobs)
            self.assertFalse(any(directory.glob("*.interactive.json")))
            self.assertEqual(self.graph_values(directory), {})
            # Starting again neither reruns the job nor launches a worker: it points at resume.
            output, code = self.cli(pipeline.main, ["start", str(directory), "--live"])
            self.assertEqual(code, 1)
            self.assertIn(f"A design challenge job was started and never decided; rerun it with: {PY} -m workflow resume {directory}", output)
            self.assertEqual(self.launches(directory), jobs)
        return directory


class ChallengeJobFails(FailingChallenge):
    def test_a_failed_or_malformed_challenge_job_is_never_a_pass(self):
        runs = {mode: self.fails(f"fail-{number:03}", mode, message) for number, (mode, message) in enumerate((
            ("exit", "did not succeed"), ("is_error", "did not succeed"), ("session", "did not succeed"), ("missing", "did not succeed"),
            ("not-an-object", "did not succeed"), ("schema", "output violates challenge.schema.json")), 1)}
        directory = runs["exit"]
        self.assertIn(f"inspect {directory / 'challenge-1.stdout.json'}. No worker was launched.", self.events(directory)[-1][2])
        # The job works again: resume reruns it as attempt 2, which passes, then the workers launch.
        self.mode.write_text("pass")
        output, code = self.cli(resume_main, [str(directory)])
        self.assertEqual(code, 0, output)
        record = read_json(directory / "challenge.json")
        self.assertEqual((record["status"], record["attempt"]), ("passed", 2))
        self.assertFalse((directory / "challenge.running.json").exists())
        self.assertEqual(self.launches(directory), ["challenge", "challenge", "adapter", "ui"])


class ChallengeJobStops(FailingChallenge):
    def test_a_challenge_job_that_times_out_cannot_start_or_changes_its_worktree_is_never_a_pass(self):
        with patch("workflow.guardrails.challenge_timeout", return_value=1):
            self.fails("timeout-001", "timeout", "Design challenge attempt 1 deadline exhausted; no worker was launched")
        executable, self.executable = self.executable, self.root / "missing-claude"
        self.fails("missing-cli-001", "pass", f"No such file or directory: '{self.executable}'", jobs=[])
        self.executable = executable
        directory = self.fails("worktree-001", "worktree", "Challenge worktree changed during the job; refusing its result")
        # The changed worktree refuses a rerun until it is reconciled; then resume passes.
        self.mode.write_text("pass")
        output, code = self.cli(resume_main, [str(directory)])
        self.assertEqual(code, 1)
        # resume checks every run worktree before it commits or re-pins anything (fix/challenge-resume).
        self.assertIn("challenge-worktree is not a clean checkout of the base", output)
        self.assertIn("reconcile before resume", output)
        self.assertEqual(self.launches(directory), ["challenge"])
        # Nothing was re-pinned, so the challenge node's last status is still attempt 1's refusal, never `running`.
        self.assertEqual([event for event in self.events(directory) if event[0] == "challenge"][-1],
                         ("challenge", "blocked", "Challenge worktree changed during the job; refusing its result"))
        git(directory / "challenge-worktree", "clean", "-fdq")
        output, code = self.cli(resume_main, [str(directory)])
        self.assertEqual(code, 0, output)
        self.assertEqual(read_json(directory / "challenge.json")["status"], "passed")
        self.assertEqual(self.launches(directory), ["challenge", "challenge", "adapter", "ui"])


class ChallengeCheckoutFails(FailingChallenge):
    def test_a_challenge_checkout_that_cannot_be_created_blocks_start_and_a_later_start_reruns_it(self):
        directory = self.prepare("checkout-001")
        (directory / "challenge-worktree").symlink_to(self.root / "nowhere")  # `git worktree add` refuses an existing path.
        output, code = self.cli(pipeline.main, ["start", str(directory), "--live"])
        self.assertEqual(code, 1, output)
        self.assertIn("Blocked:", output)
        self.assertNotIn("Traceback", output)
        [event] = [event for event in self.events(directory) if event[0] == "challenge"]
        self.assertEqual(event[1], "blocked")
        self.assertIn("worktree", event[2])
        self.assertFalse((directory / "challenge.json").exists() or (directory / "challenge.running.json").exists())
        self.assertEqual(self.launches(directory), [])
        # The refusal says what runs once the checkout is fixed: `launch` refuses the run directory it already prepared.
        self.assertIn(f"no job ran; fix it, then run the challenge and launch the workers with: {PY} -m workflow resume {directory} "
                      "(add --herdr for the worker panes, as launch opens them unless --no-herdr)\n", output)
        # No job ran, so nothing is left undecided: once the path is free, start runs attempt 1.
        (directory / "challenge-worktree").unlink()
        output, code = self.cli(pipeline.main, ["start", str(directory), "--live"])
        self.assertEqual(code, 0, output)
        self.assertEqual((read_json(directory / "challenge.json")["status"], read_json(directory / "challenge.json")["attempt"]), ("passed", 1))
        self.assertEqual(self.launches(directory), ["challenge", "adapter", "ui"])

    def test_after_a_launch_whose_challenge_checkout_failed_resume_runs_attempt_1_and_supervises_the_automatic_run(self):
        directory = self.prepare("checkout-auto-001", automatic=True)
        (directory / "challenge-worktree").symlink_to(self.root / "nowhere")
        output, code = self.cli(pipeline.main, ["start", str(directory), "--live"])  # The start a `launch --automatic` runs.
        self.assertEqual(code, 1, output)
        self.assertIn(f"then run the challenge and launch the workers with: {PY} -m workflow resume {directory} (add --herdr", output)
        (directory / "challenge-worktree").unlink()
        supervised = []
        with patch("workflow.automatic.supervise", side_effect=lambda run: supervised.append((run, self.launches(run)))):
            output, code = self.cli(resume_main, [str(directory)])
        self.assertEqual(code, 0, output)
        self.assertEqual((read_json(directory / "challenge.json")["status"], read_json(directory / "challenge.json")["attempt"]), ("passed", 1))
        # Supervised once, after the workers launched: `start` alone would have left them unsupervised.
        self.assertEqual(supervised, [(directory, ["challenge", "adapter", "ui"])])
        self.assertIn("Automatic run reached a verified feature branch", output)


class ChallengeHeartbeat(FailingChallenge):
    """A challenge job runs for minutes: the terminal hears from it once a minute, and Ctrl-C says how to go on."""

    def test_a_running_challenge_prints_a_heartbeat_line_to_the_terminal_and_none_to_the_timeline(self):
        self.mode.write_text("slow")
        directory = self.prepare("heartbeat-001")
        with patch("workflow.guardrails.CHALLENGE_HEARTBEAT_SECONDS", 0.1):
            output, code = self.cli(pipeline.main, ["start", str(directory), "--live"])
        self.assertEqual(code, 0, output)
        beats = re.findall(r"^Design challenge attempt 1 still running \(\d+ min\)$", output, re.MULTILINE)
        self.assertGreaterEqual(len(beats), 2, output)
        self.assertNotIn("still running", (directory / "events.jsonl").read_text())
        self.assertEqual(read_json(directory / "challenge.json")["status"], "passed")

    def test_the_wait_prints_the_minutes_once_per_heartbeat_and_ends_at_the_deadline(self):
        from .guardrails import wait_challenge
        clock = SimpleNamespace(now=1000.0)

        class Job:
            """A print job that is still running for `beats` waits, then exits."""
            def __init__(self, beats: int):
                self.beats, self.waits = beats, []

            def wait(self, timeout):
                self.waits.append(timeout)
                if len(self.waits) <= self.beats:
                    clock.now += timeout
                    raise subprocess.TimeoutExpired("claude", timeout)
                return 0

        job = Job(3)
        with contextlib.redirect_stdout(io.StringIO()) as output:
            wait_challenge(job, 2, 1800, clock=lambda: clock.now)
        self.assertEqual(output.getvalue().splitlines(), [f"Design challenge attempt 2 still running ({minutes} min)" for minutes in (1, 2, 3)])
        self.assertEqual(job.waits, [60, 60, 60, 60])
        # The last wait is what is left of the deadline; then the job's deadline is exhausted.
        job = Job(10)
        with contextlib.redirect_stdout(io.StringIO()) as output, self.assertRaises(subprocess.TimeoutExpired):
            wait_challenge(job, 1, 150, clock=lambda: clock.now)
        self.assertEqual(job.waits, [60, 60, 30])
        self.assertEqual(output.getvalue().splitlines(), [f"Design challenge attempt 1 still running ({minutes} min)" for minutes in (1, 2)])

    def test_ctrl_c_during_the_challenge_prints_the_resume_command_and_stops_the_job(self):
        self.mode.write_text("timeout")  # A job that would run for a minute.
        directory = self.prepare("interrupt-001")
        output = io.StringIO()
        # Ctrl-C reaches the controller while it waits for the job.
        with patch("workflow.guardrails.wait_challenge", side_effect=KeyboardInterrupt), \
                patch("workflow.guardrails.terminate", wraps=guardrails.terminate) as stop, \
                patch("workflow.pipeline.InteractiveSessions", side_effect=lambda directory, timeout: self.sessions(directory)), \
                patch.object(sys, "argv", ["workflow", "start", str(directory), "--live"]), \
                contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
            with self.assertRaises(KeyboardInterrupt):
                pipeline.main()
        self.assertIn(f"Design challenge attempt 1 interrupted; no worker was launched. Run the challenge again and launch the workers with:\n"
                      f"  {PY} -m workflow resume {directory}\n", output.getvalue())
        self.assertEqual(stop.call_count, 1)  # The job was stopped, not left running.
        self.assertEqual((read_json(directory / "challenge.running.json")["attempt"], (directory / "challenge.json").exists()), (1, False))
        self.assertEqual([event[1:] for event in self.events(directory) if event[0] == "challenge"][-1], ("blocked", "KeyboardInterrupt"))
        self.assertFalse(any(directory.glob("*.interactive.json")))
        # The command it names runs the challenge as attempt 2, then launches the workers.
        self.mode.write_text("pass")
        output, code = self.cli(resume_main, [str(directory)])
        self.assertEqual(code, 0, output)
        self.assertEqual((read_json(directory / "challenge.json")["status"], read_json(directory / "challenge.json")["attempt"]), ("passed", 2))

    def test_ctrl_c_during_a_launchs_challenge_names_resume_not_the_supervisor(self):
        runs = []

        def run(command, cwd, check):
            if command[3:4] == ["start"]:  # Interrupted while its challenge job runs.
                directory = Path(command[4])
                directory.mkdir(parents=True, exist_ok=True)
                save_json(directory / "challenge.running.json", {"attempt": 1, "session_id": "s", "started_at": "2026-10-03T12:00:00Z"})
                runs.append(directory)
                raise KeyboardInterrupt

        from .launch import main as launch_main
        with patch("workflow.launch.run_command", side_effect=run), contextlib.redirect_stdout(io.StringIO()), \
                contextlib.redirect_stderr(io.StringIO()) as errors:
            with self.assertRaises(SystemExit) as exit_:
                launch_main([FEATURE, "--repo", str(self.repo), "--live", "--automatic", "--run-root", str(self.runs)])
        self.assertEqual(exit_.exception.code, 130)
        self.assertIn(f"run the design challenge and launch the workers with:  {PY} -m workflow resume {runs[0]} --herdr\n", errors.getvalue())
        self.assertNotIn("-m workflow automatic", errors.getvalue())


class ChallengeAttention(GuardedFeature):
    def test_a_paused_challenge_records_attention_once_per_attempt(self):
        directory = self.prepare("attention-001")
        feed = self.registry.parent / "attention.jsonl"
        lines = lambda: [json.loads(line) for line in feed.read_text().splitlines()] if feed.exists() else []
        self.challenge_says([concern("P1", "The lanes overlap"), concern("P2", "Minor")])
        output, code = self.cli(pipeline.main, ["start", str(directory), "--live"])
        self.assertEqual(code, 0, output)
        text = (f"Design challenge attempt 1 paused the run before any worker launch: 1 P0/P1 concern(s). Edit the task files, decisions.md "
                f"or the PRD in the source checkout {self.repo}, then run: {PY} -m workflow resume {directory}; or accept it: {PY} -m workflow resume {directory} "
                '--accept-challenge "<reason>"')
        [line] = lines()
        self.assertEqual({key: line[key] for key in ("run_id", "run_dir", "kind", "node", "text")},
                         {"run_id": "attention-001", "run_dir": str(directory), "kind": "challenge_paused", "node": "challenge", "text": text})
        self.assertEqual(read_json(directory / "attention.json")["text"], text)
        # Starting again is refused and records nothing; a rerun that pauses again is attempt 2's record.
        output, code = self.cli(pipeline.main, ["start", str(directory), "--live"])
        self.assertEqual((code, len(lines())), (1, 1))
        task = self.folder / "ui-task.md"
        task.write_text(task.read_text() + "\nOnly ui.txt.\n")
        self.challenge_says([concern("P0", "The lanes cannot merge")])
        output, code = self.cli(resume_main, [str(directory), "--herdr"])
        self.assertEqual((code, [(line["kind"], line["text"].split(":")[0]) for line in lines()]),
                         (0, [("challenge_paused", "Design challenge attempt 1 paused the run before any worker launch"),
                              ("challenge_paused", "Design challenge attempt 2 paused the run before any worker launch")]))
        # Paused under `resume --herdr`, the record's commands keep the flag, as the printed ones do.
        self.assertTrue(lines()[-1]["text"].endswith(f"then run: {PY} -m workflow resume {directory} --herdr; or accept it: {PY} -m workflow "
                                                     f'resume {directory} --accept-challenge "<reason>" --herdr'), lines()[-1]["text"])
        # A challenge that passes needs nobody: no record.
        task.write_text(task.read_text() + "\nThe adapter owns backend.py.\n")
        self.challenge_says([concern("P2", "Minor")])
        output, code = self.cli(resume_main, [str(directory)])
        self.assertEqual((code, read_json(directory / "challenge.json")["status"], len(lines())), (0, "passed", 2))


class LaneNamedLikeARunFile(GuardedFeature):
    """Lanes `plan` and `policy` share their names with the run's plan.json and policy.json: neither is a launch receipt."""

    def setUp(self):
        super().setUp()
        policy = two_lane_policy()
        for worker, lane in zip(policy["workers"], ("plan", "policy")):
            worker["node_id"] = lane
            (self.folder / f"{lane}-task.md").write_text(BRIEF.format(lane=lane))
        save_json(self.folder / "policy.json", policy)
        save_json(self.folder / "feature.json", {**self.manifest, "workers": [{"node_id": lane, "task": f"{lane}-task.md"} for lane in ("plan", "policy")]})
        commit_all(self.repo, "Lanes plan and policy")

    def test_lanes_named_plan_and_policy_resume_a_paused_challenge_then_launch(self):
        directory = self.prepare("lanes-001")
        self.assertTrue((directory / "plan.json").exists() and (directory / "policy.json").exists())
        self.challenge_says([concern("P1", "The lanes overlap")])
        output, code = self.cli(pipeline.main, ["start", str(directory), "--live"])
        self.assertEqual((code, read_json(directory / "challenge.json")["status"]), (0, "paused"), output)
        self.challenge_says([concern("P2", "Minor")])
        task = self.folder / "plan-task.md"  # resume reruns the challenge after an edit, and commits it.
        task.write_text(task.read_text() + "\nOnly the plan lane's files.\n")
        output, code = self.cli(resume_main, [str(directory)])
        self.assertEqual(code, 0, output)
        self.assertEqual(read_json(directory / "challenge.json")["status"], "passed")
        self.assertEqual(self.launches(directory), ["challenge", "challenge", "plan", "policy"])
        # Their launch receipts, not the run files, make resume refuse once they run.
        output, code = self.cli(resume_main, [str(directory)])
        self.assertEqual(code, 1)
        self.assertIn("Workers already launched (plan, policy)", output)


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
        # A disabled challenge gives the workers no notes (C9).
        self.assertEqual(guardrails.challenge_block(off, read_json(off / "plan.json")), "")
        self.assertFalse(any("Design challenge notes" in self.given[lane]["prompt"] for lane in LANES))

    # What a passed attempt's P2 concerns become in every worker prompt (C9, decision 11): numbered as in challenge.json, with
    # severity, kind, message and consequence, under one header line; for a manual run the operator is asked in the pane.
    NOTES = ("\n\nDesign challenge notes (advisory, attempt 1)\nDo each note's recommendation, or say in your completion why not; a "
             "fallback such as \"or at least\" is not the recommendation. A note marked \"Acts: operator\" is the operator's decision: if "
             "your work depends on it, ask in this pane instead of choosing.\n"
             "1. P2 [assumption] Naming is loose\n   Consequence: Naming is loose breaks the run\n"
             "2. P2 [assumption] One test is slow\n   Consequence: One test is slow breaks the run\n")

    def test_the_workers_get_the_final_challenge_as_numbered_advisory_notes_and_the_reviewers_never_do(self):
        from .automatic import completion_protocol_prompt, print_review_prompt
        directory = self.prepare("notes-001")
        self.challenge_says([concern("P2", "Naming is loose"), concern("P2", "One test is slow")])
        output, code = self.cli(pipeline.main, ["start", str(directory), "--live"])
        self.assertEqual(code, 0, output)
        plan = read_json(directory / "plan.json")
        self.assertEqual(guardrails.challenge_block(directory, plan), self.NOTES)
        for lane in LANES:
            for prompt in (self.given[lane]["prompt"], (directory / f"{lane}.prompt.txt").read_text()):
                with self.subTest(lane=lane):
                    self.assertEqual(prompt.count(self.NOTES), 1)
                    self.assertLess(prompt.index(guardrails.decisions_block(plan)), prompt.index(self.NOTES))  # Right after decisions.md.
                    for left_out in ("One lane instead of two", "Prototype the ui change first"):  # The alternative and the experiment.
                        self.assertNotIn(left_out, prompt)
            self.assertNotIn("Naming is loose", plan["nodes"][lane]["task"])  # Never pinned into the task.
        # An automatic worker asks with a question.
        automatic = worker_prompt(directory, {**plan, "automatic": dict(DEFAULTS)}, "ui")
        self.assertIn(self.NOTES.replace("ask in this pane", "write the completion file with status question"), automatic)
        # Reviewers never get the notes, in either transport (decision 11).
        runtime = SimpleNamespace(directory=directory, plan=plan, workers=LANES)
        for reviewer in [None, *plan["reviewers"]]:
            native = review_prompt(runtime, directory / "review.diff", reviewer) + completion_protocol_prompt(runtime, "token", "0" * 64, "c" * 40)
            for prompt in (print_review_prompt(runtime, directory / "review.diff", reviewer), native):
                self.assertNotIn("Design challenge notes", prompt)
                self.assertNotIn("Naming is loose", prompt)
        # The seam for slice 3's --drop at a hold release: a dropped note is left out, its neighbours keep their numbers.
        self.assertEqual(guardrails.challenge_block(directory, plan, {1}),
                         self.NOTES.replace("1. P2 [assumption] Naming is loose\n   Consequence: Naming is loose breaks the run\n", ""))
        self.assertEqual(guardrails.challenge_block(directory, plan, {1, 2}), "")

    def test_an_accepted_challenge_lists_the_overridden_p0_p1_apart_as_context_only(self):
        directory = self.prepare("accepted-notes-001")
        # The overridden P1 is the kind of concern most likely marked "Acts: operator": the header's rule to ask about such a note
        # applies to the advisory notes only, since the operator already decided the accepted ones.
        overlap = {**concern("P1", "The lanes overlap\nRecommendation: split the lanes\nActs: operator"), "consequence": "The lanes overlap breaks the run"}
        self.challenge_says([overlap, concern("P2", "Minor")])
        output, code = self.cli(pipeline.main, ["start", str(directory), "--live"])
        self.assertEqual((code, read_json(directory / "challenge.json")["status"]), (0, "paused"), output)
        output, code = self.cli(resume_main, [str(directory), "--accept-challenge", "Ownership is checked at freeze"])
        self.assertEqual(code, 0, output)
        expected = ("\n\nDesign challenge notes (advisory, attempt 1)\n"
                    "Do each note's recommendation, or say in your completion why not; a fallback such as \"or at least\" is not the "
                    "recommendation. A note marked \"Acts: operator\" is the operator's decision: if your work depends on it, ask in this "
                    "pane instead of choosing.\n"
                    "2. P2 [assumption] Minor\n   Consequence: Minor breaks the run\n"
                    "Accepted by the operator: context only. Do not act on them and do not ask about them, whatever their \"Acts:\" line "
                    "says: the operator decided them. These P0/P1 concerns paused the run, and the operator launched it with the reason: "
                    "Ownership is checked at freeze\n"
                    "1. P1 [assumption] The lanes overlap\nRecommendation: split the lanes\nActs: operator\n"
                    "   Consequence: The lanes overlap breaks the run\n")
        for lane in LANES:
            self.assertIn(expected, self.given[lane]["prompt"])
            self.assertIn(expected, (directory / f"{lane}.prompt.txt").read_text())

    def test_the_challenge_asks_for_a_recommendation_its_actor_and_file_evidence_and_its_schema_is_unchanged(self):
        # C10, prompt only: each concern's message ends with a recommendation and who acts on it; the severity sentence and the
        # pause rule stay, and the job gets the same schema (challenge 1.0.0), so an operator's P2 pauses nothing.
        directory = self.prepare("acts-001")
        message = "The adapter's interface is unsettled.\nRecommendation: keep VALUE an integer; done when the unit check passes.\nActs: operator"
        self.challenge_says([concern("P2", message)])
        output, code = self.cli(pipeline.main, ["start", str(directory), "--live"])
        self.assertEqual(code, 0, output)
        self.assertEqual(read_json(directory / "challenge.json")["status"], "passed")
        self.assertEqual(self.launches(directory), ["challenge", "adapter", "ui"])
        [call] = self.challenge_calls()
        prompt = " ".join(call["prompt"].split())
        for asked in ("End each concern's message with two lines: \"Recommendation: <one action and its done-condition>\" and \"Acts: "
                      "operator | worker | note\"", "A recommendation never offers a fallback such as \"or at least\": when two options "
                      "remain, the concern is a decision for the operator (Acts: operator), with the recommended option first.",
                      "Each P0 and P1 message cites the file:line it rests on, or says \"no file evidence\".",
                      "A P0 or P1 pauses the run for the operator, so raise one only for a consequence you can name;",
                      "P0 when the plan cannot work as written, P1 when it is likely to produce the wrong result or major rework and must "
                      "be settled before any worker starts, P2 when it is worth recording and the run can continue."):
            self.assertIn(asked, prompt)
        schema = call["schema"]
        self.assertEqual(schema, guardrails.output_schema())
        self.assertEqual((schema["required"], schema["additionalProperties"]), (["concerns", "simpler_alternative", "cheap_experiment"], False))
        item = schema["properties"]["concerns"]["items"]
        self.assertEqual((item["required"], item["additionalProperties"]), (["severity", "kind", "message", "consequence"], False))
        self.assertEqual(guardrails.challenge_schema()["properties"]["version"], {"const": "1.0.0"})
        self.assertIn(f"1. P2 [assumption] {message}\n   Consequence: ", self.given["ui"]["prompt"])


class ClaudeUpdateAroundTheChallenge(GuardedFeature):
    """A Claude Code update during a run: the challenge job waits it out, and start/resume name the sessions that cause it."""

    def popen(self, failures: list):
        """A Popen that fails the fake claude's exec with each of `failures` first; every environment it was given is kept."""
        real_popen = subprocess.Popen
        environments = []

        def popen(command, *args, **kwargs):
            if command[0] == str(self.executable):
                environments.append(kwargs["env"])
                if failures:
                    raise failures.pop(0)
            return real_popen(command, *args, **kwargs)
        return popen, environments

    def waits(self):
        """time.sleep that records the 2-second update waits and really sleeps the short polls of `process.wait`."""
        real_sleep = time.sleep
        waits = []

        def sleep(seconds):
            if seconds == 2:
                waits.append(seconds)
            else:
                real_sleep(seconds)
        return sleep, waits

    def test_the_challenge_job_waits_out_an_update_without_the_auto_updater_and_never_starts_twice(self):
        import errno
        from .guardrails import run_challenge
        directory = self.prepare("update-001")
        popen, environments = self.popen([FileNotFoundError(errno.ENOENT, "No such file or directory", str(self.executable))])
        sleep, waits = self.waits()
        with patch.dict(os.environ, {"HERDR_PANE_ID": "w1:p1"}), patch("workflow.sessions.subprocess.Popen", side_effect=popen), \
                patch("workflow.sessions.time.sleep", side_effect=sleep):
            self.assertEqual(run_challenge(self.runtime(directory), 1)["status"], "passed")
        self.assertEqual(waits, [2])
        self.assertEqual((len(environments), len(self.challenge_calls())), (2, 1))  # The failed exec ran nothing.
        for environment in environments:
            self.assertEqual(environment["DISABLE_AUTOUPDATER"], "1")
            self.assertFalse(any(key.startswith("HERDR_") for key in environment))
        # A job that ran and failed is not started again.
        self.output.write_text("{not json")
        popen, environments = self.popen([])
        sleep, waits = self.waits()
        with patch("workflow.sessions.subprocess.Popen", side_effect=popen), patch("workflow.sessions.time.sleep", side_effect=sleep):
            with self.assertRaisesRegex(RuntimeError, "did not succeed"):
                run_challenge(self.runtime(directory), 2)
        self.assertEqual((len(environments), len(self.challenge_calls()), waits), (1, 2, []))

    def test_start_and_resume_name_stale_claude_sessions_and_resume_exits_75_when_claude_code_is_unavailable(self):
        from .sessions import TransientInfraError
        stale = "Warning: 1 running Claude Code process(es) still run an executable that an update deleted.\n  pid 7 in /work: claude"
        run, commands, _ = launch_commands(self.repo, FEATURE, "auto-001", self.runs, herdr=False, automatic=True)
        subprocess.run(commands[1], cwd=self.repo, check=True, capture_output=True)
        result = subprocess.run(commands[2], cwd=TOOL, capture_output=True, text=True, timeout=120)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.challenge_says([concern("P1", "The lanes overlap")])
        with patch("workflow.pipeline.stale_claude_warning", return_value=stale):
            output, code = self.cli(pipeline.main, ["start", str(run), "--live"])
        self.assertEqual(code, 0, output)
        self.assertLess(output.index("pid 7 in /work: claude"), output.index("P1 [assumption] The lanes overlap"))
        with patch("workflow.guardrails.stale_claude_warning", return_value=stale), \
                patch("workflow.automatic.supervise", side_effect=TransientInfraError("Claude Code was unavailable; nothing was stopped")) as supervise:
            output, code = self.cli(resume_main, [str(run), "--accept-challenge", "r"])
        self.assertEqual(code, 75, output)
        supervise.assert_called_once_with(run)
        self.assertIn("pid 7 in /work: claude", output)
        self.assertIn("Interrupted: Claude Code was unavailable; nothing was stopped", output)
        self.assertNotIn("Blocked", output)
        self.assertEqual(self.launches(run), ["challenge", "adapter", "ui"])


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
        # After an edit, a resume whose rerun still finds a P0 stays paused, as attempt 2, and launches nothing. The rerun was
        # given attempt 1's P1 and the edited file.
        adapter_task = self.folder / "adapter-task.md"
        adapter_task.write_text(adapter_task.read_text() + "\nKeep the adapter's interface.\n")
        self.challenge_says([concern("P0", "The lanes cannot merge")])
        output, code = self.cli(resume_main, [str(directory)])
        self.assertEqual((code, read_json(directory / "challenge.json")["status"], read_json(directory / "challenge.json")["attempt"]), (0, "paused", 2))
        self.assertIn("P0 [assumption] The lanes cannot merge", output)
        self.assertEqual(self.launches(directory), ["challenge", "challenge"])
        rerun = self.challenge_calls()[-1]["prompt"]
        self.assertIn("\n- P1 [assumption] The lanes overlap\n", rerun)
        self.assertNotIn("Minor", rerun)  # Only the P0/P1 concerns.
        self.assertIn(f"Changed since then: the task of lane adapter (features/{FEATURE}/adapter-task.md).", rerun)
        # The viewer shows attempt 2's concerns, not the ones attempt 1 raised.
        exported = read_json(directory / "run-state.json")["inputs"]["challenge"]
        self.assertEqual((exported["attempts"], [item["message"] for item in exported["concerns"]]), (2, ["The lanes cannot merge"]))
        # The operator edits a task, decisions.md and the PRD; resume re-pins all three and reruns the challenge as attempt 3,
        # which passes, then launches the workers.
        task = self.folder / "ui-task.md"
        task.write_text(task.read_text() + "\nOnly ui.txt; the adapter lane owns backend.py.\n")
        (self.folder / "decisions.md").write_text(DECISIONS + "\n- ui.txt is the only file the ui lane writes: DECISION-MARKER-43.\n")
        (self.repo / "docs/PRD.md").write_text("# PRD\n\nThe guarded feature, on one screen: PRD-MARKER-7.\n")
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
        self.assertIn("DECISION-MARKER-43", plan["decisions"]["text"])
        self.assertIn("PRD-MARKER-7", (directory / "challenge-inputs/prd.md").read_text())
        for key in ("tasks_sha256", "decisions_sha256", "prd_sha256"):
            self.assertNotEqual(record["pinned"][key], paused["pinned"][key], key)
        self.assertIn("the adapter lane owns backend.py", self.challenge_calls()[-1]["prompt"])
        self.assertIn("DECISION-MARKER-43", self.challenge_calls()[-1]["prompt"])
        self.assertEqual(self.launches(directory), ["challenge"] * 3 + ["adapter", "ui"])
        # The workers launched from the re-pinned plan (the sessions of a runtime built after the re-pin): their receipts
        # bind its digest and their prompts carry the edited task and decisions.
        self.assertEqual({lane: self.given[lane]["plan_digest"] for lane in LANES}, dict.fromkeys(LANES, plan_digest(plan)))
        self.assertIn("the adapter lane owns backend.py", self.given["ui"]["prompt"])
        self.assertTrue(all("DECISION-MARKER-43" in self.given[lane]["prompt"] for lane in LANES))
        self.assertIn("the adapter lane owns backend.py", read_json(directory / "run-state.json")["inputs"]["workers"]["ui"]["task"])
        # Once workers run, resume refuses, and a refusal that changed nothing does not rewrite the export under the lock.
        exported = (directory / "run-state.json").read_bytes()
        output, code = self.cli(resume_main, [str(directory)])
        self.assertEqual(code, 1)
        self.assertIn("Workers already launched", output)
        self.assertNotIn("Report:", output)
        self.assertEqual((directory / "run-state.json").read_bytes(), exported)
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
        with patch("workflow.launch.run_command", side_effect=run), contextlib.redirect_stdout(io.StringIO()) as output, \
                contextlib.redirect_stderr(io.StringIO()):
            launch_main([FEATURE, "--repo", str(self.repo), "--no-herdr", "--live", "--automatic", "--run-root", str(self.runs)])
        self.assertEqual([command[3] if command[0] != "git" else "git" for command in calls], ["preflight", "git", "prepare", "start"])
        run = (self.runs / f"{FEATURE}-001").resolve()
        self.assertIn(f"Launch paused at the design challenge; no worker was launched. Run: {run}\nSource checkout: {run}.source\n", output.getvalue())


class ChallengeResumeSupervises(GuardedFeature):
    def test_resume_hands_an_automatic_run_to_the_supervisor_only_after_the_workers_launched(self):
        """Scenario challenge-pauses: after a paused automatic launch, `resume` is what starts the supervisor."""
        directory = self.prepare("auto-001", automatic=True)
        self.assertIsInstance(read_json(directory / "plan.json")["automatic"], dict)
        self.challenge_says([concern("P1", "The lanes overlap")])
        output, code = self.cli(pipeline.main, ["start", str(directory), "--live"])
        self.assertEqual((code, read_json(directory / "challenge.json")["status"]), (0, "paused"), output)
        supervised = []
        with patch("workflow.automatic.supervise", side_effect=lambda run: supervised.append((run, self.launches(run)))):
            # After an edit, paused again: nothing launched, nothing supervised.
            task = self.folder / "ui-task.md"
            task.write_text(task.read_text() + "\nOnly ui.txt.\n")
            output, code = self.cli(resume_main, [str(directory)])
            self.assertEqual((code, read_json(directory / "challenge.json")["attempt"]), (0, 2), output)
            self.assertEqual(supervised, [])
            output, code = self.cli(resume_main, [str(directory), "--accept-challenge", "Known risk"])
        self.assertEqual(code, 0, output)
        # Supervised once, with the run directory, after both workers launched.
        self.assertEqual(supervised, [(directory, ["challenge", "challenge", "adapter", "ui"])])
        self.assertIn("Automatic run reached a verified feature branch", output)
        # The run's branch is in its own worktree: merged from your checkout without switching, then the worktree removed.
        self.assertIn(f"git merge --ff-only feature/{FEATURE}/auto-001. Once the run is finished, remove its source checkout: "
                      f"git worktree remove {self.repo}", output)


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
        # A detached HEAD is refused like another branch, before anything is committed.
        branch = git(self.repo, "symbolic-ref", "--short", "HEAD")
        git(self.repo, "checkout", "-q", "--detach")
        output, code = self.cli(resume_main, [str(directory)])
        self.assertEqual(code, 1, output)
        self.assertIn(f"The source checkout is not on the run's branch {branch} (its HEAD is detached)", output)
        step = pipeline.challenge_step(directory, read_json(directory / "plan.json"))  # status runs resume's read-only checks first.
        self.assertIn(f"but resume refuses: The source checkout is not on the run's branch {branch} (its HEAD is detached)", step)
        git(self.repo, "checkout", "-q", branch)
        self.assertIn("commits them and reruns the design challenge", pipeline.challenge_step(directory, read_json(directory / "plan.json")))
        self.assertEqual((git(self.repo, "rev-parse", "HEAD"), git(self.repo, "diff", "--name-only")), (base, f"features/{FEATURE}/ui-task.md"))
        (self.repo / "backend.py").write_text("VALUE = 3\n")
        (self.repo / "notes.txt").write_text("scratch\n")
        output, code = self.cli(resume_main, [str(directory)])
        self.assertEqual(code, 1, output)
        self.assertIn("changes resume does not re-pin: backend.py, notes.txt", output)
        self.assertIn("but resume refuses: The source checkout has changes resume does not re-pin: backend.py, notes.txt",
                      pipeline.challenge_step(directory, read_json(directory / "plan.json")))
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
        self.assertIn("resume refuses: ", pipeline.challenge_step(directory, read_json(directory / "plan.json")))
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

    def test_resume_refuses_a_todo_line_in_decisions_or_a_task_before_anything_is_committed_or_re_pinned(self):
        """C5: a grill question never answered (`TODO: Q<n>`) or any line that begins with `TODO:`, as launch refuses it."""
        directory, base = self.paused("todo-001")
        plan = (directory / "plan.json").read_bytes()

        def refused(path: Path, line: str) -> None:
            output, code = self.cli(resume_main, [str(directory)])
            self.assertEqual(code, 1, output)
            number = path.read_text().splitlines().index(line) + 1
            self.assertIn(f"{path.resolve()}:{number}: {line.strip()}", output)
            self.assertIn("launch refuses it too", output)
            # Nothing was committed, moved or re-pinned, the challenge did not rerun and the edit stays in the checkout.
            self.assertEqual((git(self.repo, "rev-parse", "HEAD"), (directory / "plan.json").read_bytes()), (base, plan))
            self.assertFalse((directory / guardrails.REVISION_INTENT).exists())
            self.assertEqual(len(self.challenge_calls()), 1)
            self.assertIn(line, path.read_text())
            # The override and status name the refusal instead of promising that resume commits the edit (C5 makes such a line
            # a designed output of a re-grill during a pause).
            output, code = self.cli(resume_main, [str(directory), "--accept-challenge", "Fine as it is"])
            self.assertEqual(code, 1, output)
            self.assertIn(f"the override would launch the workers without them. resume refuses: {path.resolve()}:{number}: {line.strip()}", output)
            self.assertNotIn("to commit them and rerun the challenge", output)
            step = pipeline.challenge_step(directory, read_json(directory / "plan.json"))
            self.assertIn(f"feature files changed since it read them, but resume refuses: {path.resolve()}:{number}: {line.strip()}", step)
            self.assertNotIn("commits them", step)

        decisions = self.folder / "decisions.md"
        decisions.write_text(SPLIT_DECISIONS.replace("## Grill defaults", "TODO: Q2 Who owns contracts/?\n\n## Grill defaults"))
        refused(decisions, "TODO: Q2 Who owns contracts/?")
        git(self.repo, "checkout", "--", f"features/{FEATURE}/decisions.md")
        task = self.edit_task()
        task.write_text(task.read_text() + "  TODO: name the adapter's port.\n")  # Indented, as launch reads it: stripped.
        refused(task, "  TODO: name the adapter's port.")
        # Answered, resume commits the task and reruns the challenge on it.
        task.write_text(task.read_text().replace("  TODO: name the adapter's port.\n", "The adapter listens on port 8080.\n"))
        self.challenge_says([concern("P2", "Minor")])
        output, code = self.cli(resume_main, [str(directory)])
        self.assertEqual(code, 0, output)
        self.assertIn("port 8080", read_json(directory / "plan.json")["nodes"]["ui"]["task"])
        self.assertEqual(self.launches(directory), ["challenge", "challenge", "adapter", "ui"])

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

    def test_an_override_after_a_failed_rerun_waits_for_a_challenge_that_read_the_re_pinned_files(self):
        directory, _ = self.paused("failed-rerun-001")
        self.edit_task()
        save_json(self.output, {"concerns": "none"})  # The rerun's output violates the schema: the job fails and decides nothing.
        output, code = self.cli(resume_main, [str(directory)])
        self.assertEqual(code, 1, output)
        self.assertIn("Design challenge attempt 2 output violates challenge.schema.json", output)
        revision = git(self.repo, "rev-parse", "HEAD")
        self.assert_moved(directory, revision)
        self.assertIn("the adapter lane owns backend.py", read_json(directory / "plan.json")["nodes"]["ui"]["task"])
        self.assertEqual((read_json(directory / "challenge.json")["attempt"], read_json(directory / "challenge.running.json")["attempt"]), (1, 2))
        # The export follows plan.json (the viewer refuses a run whose export names another base) and shows the failed attempt.
        exported = read_json(directory / "run-state.json")
        self.assertEqual(exported["base_commit"], revision)
        self.assertIn("the adapter lane owns backend.py", exported["inputs"]["workers"]["ui"]["task"])
        self.assertEqual((exported["events"][-1]["node"], exported["events"][-1]["status"]), ("challenge", "blocked"))
        # Attempt 1 read the task before the edit and the workers would get the edited one: the override is refused.
        output, code = self.cli(resume_main, [str(directory), "--accept-challenge", "Known risk"])
        self.assertEqual(code, 1, output)
        self.assertIn("Design challenge attempt 1 read other feature files than the plan now pins (tasks)", output)
        self.assertIn("rerun resume without --accept-challenge", output)
        self.assertEqual((read_json(directory / "challenge.json")["status"], self.launches(directory)), ("paused", ["challenge", "challenge"]))
        # A rerun that reads them and pauses again can be accepted: attempt 3 read what the workers get.
        self.challenge_says([concern("P1", "The lanes still overlap")])
        output, code = self.cli(resume_main, [str(directory)])
        self.assertEqual((code, read_json(directory / "challenge.json")["attempt"], git(self.repo, "rev-parse", "HEAD")), (0, 3, revision), output)
        output, code = self.cli(resume_main, [str(directory), "--accept-challenge", "Known risk"])
        self.assertEqual(code, 0, output)
        accepted = read_json(directory / "challenge.json")
        self.assertEqual((accepted["status"], accepted["attempt"], accepted["accepted_reason"]), ("accepted", 3, "Known risk"))
        self.assertEqual(self.launches(directory), ["challenge"] * 3 + ["adapter", "ui"])
        self.assertIn("the adapter lane owns backend.py", self.given["ui"]["prompt"])

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

    def test_a_bare_resume_on_unchanged_feature_files_is_refused_and_changes_nothing(self):
        # A rerun on the files attempt 1 read would only sample the same challenge again: a paused P1 could be re-rolled away.
        directory, base = self.paused("unchanged-001")
        names = ("plan.json", "challenge.json", "events.jsonl", "run-state.json")
        before = {name: (directory / name).read_bytes() for name in names}
        task = self.folder / "ui-task.md"
        written = task.read_text()
        for edit, flags in (("none", []), ("reverted", []), ("none, resumed with --herdr", ["--herdr"])):
            with self.subTest(edit):
                if edit == "reverted":  # An edit undone before resume is no change.
                    self.edit_task()
                    task.write_text(written)
                output, code = self.cli(resume_main, [str(directory), *flags])
                self.assertEqual(code, 1, output)
                self.assertIn("Blocked: Design challenge attempt 1 paused this run, and nothing it read has changed since", output)
                # The commands it suggests keep --herdr, as the paused message does: without it the workers launch with no panes.
                herdr = " --herdr" if flags else ""
                # It names the run's own worktree, where the edit is made; an edit in the target checkout is not seen.
                self.assertIn(f"Edit the task files, decisions.md or the PRD in the source checkout {self.repo}, then rerun the challenge: "
                              f"{PY} -m workflow resume {directory}{herdr}\n", output)
                self.assertIn(f'Or record an override and launch the workers: {PY} -m workflow resume {directory} --accept-challenge "<reason>"{herdr}\n', output)
                self.assertIn("A concern outside the feature files (the code at the base, the policy) needs a new run.", output)
                self.assertNotIn("Report:", output)
                self.assertEqual({name: (directory / name).read_bytes() for name in names}, before)
                self.assertFalse((directory / "challenge.running.json").exists() or (directory / "challenge-revision.json").exists())
                self.assertEqual((git(self.repo, "rev-parse", "HEAD"), git(self.repo, "status", "--porcelain")), (base, ""))
                self.assertEqual((self.launches(directory), len(self.challenge_calls())), (["challenge"], 1))
        # After an edit the same command reruns the challenge as attempt 2. Its prompt lists attempt 1's P0/P1 concerns and the
        # changed file, and asks for each again unless the change resolves it.
        self.edit_task()
        self.challenge_says([concern("P2", "Minor")])
        output, code = self.cli(resume_main, [str(directory)])
        self.assertEqual((code, read_json(directory / "challenge.json")["attempt"]), (0, 2), output)
        self.assertEqual(self.launches(directory), ["challenge", "challenge", "adapter", "ui"])
        rerun = self.challenge_calls()[-1]["prompt"]
        self.assertIn("\n\n=== Design challenge attempt 1 ===\nIt paused the run on these concerns:\n- P1 [assumption] The lanes overlap\n"
                      f"Changed since then: the task of lane ui (features/{FEATURE}/ui-task.md). Raise each of these concerns again, at its "
                      "severity, unless the change resolves it; challenge the rest of the plan as before.", rerun)
        self.assertNotIn("Design challenge attempt", self.challenge_calls()[0]["prompt"])

    def test_a_rerun_whose_challenge_checkout_failed_after_its_re_pin_is_rerun_by_the_next_bare_resume(self):
        # The rerun committed and re-pinned the edit, then failed before its job: the checkout could not be made (or the process
        # was killed). No running file, intent, unused revision or edited file is left, but attempt 1 read other files than
        # the plan pins now, so the override is refused and a bare resume must rerun, not be refused too.
        directory, base = self.paused("rerun-checkout-001")
        self.edit_task()
        with patch("workflow.guardrails.challenge_worktree", side_effect=RuntimeError("Challenge worktree could not be created")):
            output, code = self.cli(resume_main, [str(directory)])
        self.assertEqual(code, 1, output)
        self.assertIn("Blocked: Challenge worktree could not be created", output)
        revision = git(self.repo, "rev-parse", "HEAD")
        self.assertNotEqual(revision, base)
        self.assert_moved(directory, revision)
        self.assertFalse((directory / "challenge.running.json").exists() or (directory / "challenge-revision.json").exists())
        self.assertEqual((git(self.repo, "status", "--porcelain"), read_json(directory / "challenge.json")["attempt"]), ("", 1))
        output, code = self.cli(resume_main, [str(directory), "--accept-challenge", "Known risk"])
        self.assertEqual(code, 1, output)
        self.assertIn("Design challenge attempt 1 read other feature files than the plan now pins (tasks)", output)
        self.challenge_says([concern("P2", "Minor")])
        output, code = self.cli(resume_main, [str(directory)])
        self.assertEqual((code, read_json(directory / "challenge.json")["attempt"]), (0, 2), output)
        self.assertEqual(self.launches(directory), ["challenge", "challenge", "adapter", "ui"])
        # Attempt 1 read the task before the edit: the rerun names it, though nothing was left to commit this time.
        self.assertIn(f"Changed since then: the task of lane ui (features/{FEATURE}/ui-task.md).", self.challenge_calls()[-1]["prompt"])

    def test_a_bare_resume_reruns_when_a_later_attempt_was_started_and_never_decided(self):
        # A rerun on these same files started a job that never decided (a controller before this rule, then a kill or a deadline):
        # challenge.running.json names attempt 2, newer than the paused attempt 1, so the bare resume reruns it as attempt 3.
        directory, _ = self.paused("undecided-001")
        save_json(directory / "challenge.running.json", {"attempt": 2, "session_id": "00000000-0000-4000-8000-000000000002", "started_at": now()})
        self.challenge_says([concern("P1", "The lanes still overlap")])
        output, code = self.cli(resume_main, [str(directory)])
        self.assertEqual((code, read_json(directory / "challenge.json")["status"], read_json(directory / "challenge.json")["attempt"]), (0, "paused", 3), output)
        self.assertIn("\n- P1 [assumption] The lanes overlap\nNone of the feature files changed since then. Raise each of these concerns again, "
                      "at its severity; challenge the rest of the plan as before.", self.challenge_calls()[-1]["prompt"])
        # Paused by attempt 3 on unchanged files: now a bare resume is refused.
        output, code = self.cli(resume_main, [str(directory)])
        self.assertEqual(code, 1, output)
        self.assertIn("Design challenge attempt 3 paused this run, and nothing it read has changed since", output)
        self.assertEqual(len(self.challenge_calls()), 2)


class PerRunCheckout(GuardedFeature):
    """C56: each run gets its own worktree of the target (`<run>.source`), so the target checkout never switches."""

    paused, edit_task, run_worktrees, assert_moved = (ChallengeRevision.paused, ChallengeRevision.edit_task, ChallengeRevision.run_worktrees,
                                                      ChallengeRevision.assert_moved)

    def integrate(self, directory: Path) -> str:
        """From the workers' handoff through freeze, both reviewers and the approval to the fast-forward; the integrated commit."""
        runtime = self.runtime(directory)
        with SqliteSaver.from_conn_string(str(directory / "pipeline.sqlite")) as saver:
            graph = build_pipeline(saver, runtime)
            config = graph_config(runtime)
            verified = graph.invoke(Command(resume={"freeze": True}), config)
            self.assertEqual(verified["__interrupt__"][0].value["kind"], "independent_review")
            bundle, digest = runtime.validate_bundle()
            imports = {reviewer: {"imported_at": now(), "review": {"run_id": directory.name, "bundle_sha256": digest, "candidate_commit": bundle["candidate_commit"],
                                                                  "reviewer": f"{reviewer}-session", "independent": True, "verdict": "approved", "findings": []}}
                       for reviewer in ("general", "coverage")}
            approved = graph.invoke(Command(resume=combine_imported_reviews(bundle, digest, imports)), config)
            self.assertEqual(approved["__interrupt__"][0].value["kind"], "integration_approval")
            return graph.invoke(Command(resume={"approve": digest}), config)["integrated_commit"]

    def test_two_runs_from_one_checkout_integrate_in_their_own_worktrees_and_a_revision_commits_there(self):
        from .guardrails import paused_message
        target = self.repo
        mine = (git(target, "symbolic-ref", "--short", "HEAD"), git(target, "rev-parse", "HEAD"))
        first, base = self.paused("first-001")
        first_source = self.repo
        self.assertEqual(first_source, self.runs.resolve() / "first-001.source")
        self.assertEqual(read_json(first / "plan.json")["source_branch"], f"feature/{FEATURE}/first-001")
        # The paused message, start's refusal and status name the run's worktree, where its feature files are edited.
        self.assertIn(f"Edit the task files, decisions.md or the PRD in the source checkout {first_source}, then rerun", paused_message(first))
        output, code = self.cli(pipeline.main, ["start", str(first), "--live"])
        self.assertEqual(code, 1, output)
        self.assertIn(f"edit the feature files in the source checkout {first_source}, then:", output)
        output, code = self.cli(pipeline.main, ["status", str(first)])
        self.assertEqual(json.loads(output.split("\nReport:")[0])["source_checkout"], str(first_source))
        # A second run launched from the same checkout while the first is paused gets its own worktree and branch.
        self.repo, self.folder = target, target / "features" / FEATURE
        self.challenge_says([concern("P2", "Minor")])
        second = self.prepare("second-001")
        second_source = self.repo
        output, code = self.cli(pipeline.main, ["start", str(second), "--live"])
        self.assertEqual(code, 0, output)
        self.assertEqual((git(target, "symbolic-ref", "--short", "HEAD"), git(target, "rev-parse", "HEAD")), mine)
        # The first run's revision is edited and committed in its own worktree; the target and the second run do not move.
        self.repo, self.folder = first_source, first_source / "features" / FEATURE
        self.edit_task()
        output, code = self.cli(resume_main, [str(first)])
        self.assertEqual(code, 0, output)
        revision = git(first_source, "rev-parse", "HEAD")
        self.assertEqual((git(first_source, "rev-parse", f"{revision}^"), git(first_source, "symbolic-ref", "--short", "HEAD")),
                         (base, f"feature/{FEATURE}/first-001"))
        self.assertEqual(git(first_source, "diff-tree", "--no-commit-id", "--name-only", "-r", revision), f"features/{FEATURE}/ui-task.md")
        self.assert_moved(first, revision)
        self.assertEqual((git(target, "symbolic-ref", "--short", "HEAD"), git(target, "rev-parse", "HEAD"), git(target, "status", "--porcelain")), (*mine, ""))
        self.assertEqual(git(second_source, "rev-parse", "HEAD"), base)
        # Both reach integrate: each fast-forwards its own branch in its own worktree.
        for directory, source in ((first, first_source), (second, second_source)):
            commit = self.integrate(directory)
            self.assertEqual((git(source, "rev-parse", "HEAD"), git(source, "status", "--porcelain")), (commit, ""))
        self.assertEqual(git(first_source, "rev-list", "--count", f"{revision}..HEAD"), "2")
        self.assertEqual((git(target, "symbolic-ref", "--short", "HEAD"), git(target, "rev-parse", "HEAD")), mine)
        # Merged from the target without switching it, as the finished message says.
        git(target, "merge", "-q", "--ff-only", f"feature/{FEATURE}/first-001")
        self.assertEqual((git(target, "symbolic-ref", "--short", "HEAD"), git(target, "rev-parse", "HEAD")), (mine[0], git(first_source, "rev-parse", "HEAD")))


class OverrideFromAnotherController(GuardedFeature):
    """The override and the rerun prompt compare the feature files as written, not the rules and check-report command the
    controller appends to a browser lane's pinned task, which name the interpreter and checkout of the process that pinned it."""

    def paused_browser_run(self, run_id: str) -> tuple[Path, str]:
        """A run whose ui lane has a browser check (so its pinned task names this checkout's check-report command), paused by
        its first challenge on a P1; and that command as another worktree of the tool, with another interpreter, spells it."""
        policy = two_lane_policy()
        policy["workers"][0]["checks"].append({"id": "ui-browser", "kind": "browser", "argv": ["npx", "--no-install", "playwright", "test"],
                                               "timeout_seconds": 10, "scenarios": [{"id": "alpha", "description": "alpha works"}]})
        save_json(self.folder / "policy.json", policy)
        commit_all(self.repo, "A browser check on the ui lane")
        directory = self.prepare(run_id)
        self.assertIn(CHECK_REPORT, read_json(directory / "plan.json")["nodes"]["ui"]["task"])
        self.challenge_says([concern("P1", "The lanes overlap")])
        output, code = self.cli(pipeline.main, ["start", str(directory), "--live"])
        self.assertEqual((code, read_json(directory / "challenge.json")["status"]), (0, "paused"), output)
        elsewhere = CHECK_REPORT.replace(str(TOOL), str(self.root / "md-manager-ctl")).replace(PY, PY + "3")
        self.assertNotEqual(elsewhere, CHECK_REPORT)
        return directory, elsewhere

    def test_a_rerun_from_another_checkout_names_only_the_feature_files_the_operator_changed(self):
        # Only decisions.md is edited. The resume runs from another checkout of the tool, so the re-pinned ui task carries
        # another check-report command: that is no change of the task the operator wrote, and the rerun is not told it is.
        directory, elsewhere = self.paused_browser_run("elsewhere-002")
        (self.folder / "decisions.md").write_text(DECISIONS + "\n- The ui lane renders first.\n")
        self.challenge_says([concern("P2", "Minor")])
        with patch("workflow.guardrails.CHECK_REPORT", elsewhere):
            output, code = self.cli(resume_main, [str(directory)])
        self.assertEqual((code, read_json(directory / "challenge.json")["attempt"]), (0, 2), output)
        rerun = self.challenge_calls()[-1]["prompt"]
        self.assertIn(elsewhere, rerun)  # The task as re-pinned from the other checkout.
        self.assertIn(f"Changed since then: decisions.md (features/{FEATURE}/decisions.md). Raise each of these concerns again", rerun)

    def test_accept_challenge_from_another_interpreter_and_checkout_accepts_unchanged_files_and_refuses_an_edit(self):
        directory, elsewhere = self.paused_browser_run("elsewhere-001")
        base = read_json(directory / "plan.json")["base_commit"]
        # The override runs from another worktree of the tool, with another spelling of the interpreter.
        with patch("workflow.guardrails.CHECK_REPORT", elsewhere):
            # An edit of the browser lane's task, committed by hand, is still refused.
            task = self.folder / "ui-task.md"
            task.write_text(task.read_text() + "\nA late edit.\n")
            commit_all(self.repo, "My own edit")
            output, code = self.cli(resume_main, [str(directory), "--accept-challenge", "Known risk"])
            self.assertEqual(code, 1, output)
            self.assertIn(f"Feature files changed since they were pinned (features/{FEATURE}/ui-task.md)", output)
            self.assertEqual((read_json(directory / "challenge.json")["status"], self.launches(directory)), ("paused", ["challenge"]))
            # The unchanged files are accepted: nothing to revert, nothing re-pinned.
            git(self.repo, "reset", "-q", "--hard", base)
            pinned = read_json(directory / "plan.json")["nodes"]
            output, code = self.cli(resume_main, [str(directory), "--accept-challenge", "Known risk"])
        self.assertEqual(code, 0, output)
        self.assertEqual((read_json(directory / "challenge.json")["status"], read_json(directory / "challenge.json")["attempt"]), ("accepted", 1))
        self.assertEqual(read_json(directory / "plan.json")["nodes"], pinned)
        self.assertEqual(self.launches(directory), ["challenge", "adapter", "ui"])


class StopRule(unittest.TestCase):
    def test_the_stop_rule_of_a_pinned_task_is_the_authored_section_without_the_approved_checks_or_browser_rules(self):
        # ## Stop is the last section of most briefs, and the pinned task appends the approved ownership and checks after it
        # (and the browser rules for a browser lane): every guarded worker prompt used to repeat them in its Stop line.
        worker = two_lane_policy()["workers"][0]
        browser = {**worker, "checks": [*worker["checks"], {"id": "ui-browser", "kind": "browser", "argv": ["npx", "--no-install", "playwright", "test"],
                                                            "timeout_seconds": 10, "scenarios": [{"id": "alpha", "description": "alpha works"}]}]}
        for lane, appended in ((worker, "Approved ownership and checks:"), (browser, "Browser scenarios:")):
            with self.subTest(appended):
                task = pinned_task(BRIEF.format(lane="ui"), lane)
                self.assertIn(appended, task)
                self.assertEqual(stop_rule(task), "After three failed fixes, report blocked.")
        # The task file as written, and a Stop section before other sections, read as before.
        self.assertEqual(stop_rule(BRIEF.format(lane="ui")), "After three failed fixes, report blocked.")
        self.assertEqual(stop_rule(pinned_task("## Stop\n\nAt once.\n\n## Goal\n\nChange ui.\n", worker)), "At once.")


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
        # Export: a valid 1.1.0 file carries the three fields; the run refuses a 1.0.0 file, so it is not served at all.
        directory = legacy_run(self.root)
        plan, policy = read_json(directory / "plan.json"), read_json(directory / "policy.json")
        plan["completion_version"] = "1.1.0"
        save_json(directory / "ui.completion.json", {**read_json(directory / "ui.completion.json"), "version": "1.1.0", "untested": ["Offline pane typing"],
                                                     "falsifying_check": "ui-unit", "verify_yourself": "The pane accepts Enter", "question": None})
        workers = inputs_section(directory, plan, policy)["workers"]
        self.assertEqual({key: workers["ui"]["completion"][key] for key in ("version", "untested", "falsifying_check", "verify_yourself")},
                         {"version": "1.1.0", "untested": ["Offline pane typing"], "falsifying_check": "ui-unit", "verify_yourself": "The pane accepts Enter"})
        self.assertIsNone(workers["adapter"]["completion"])
        # A run prepared before slice 2 exports its 1.0.0 file as 1.0.0 with null evidence.
        del plan["completion_version"]
        self.assertEqual({key: inputs_section(directory, plan, policy)["workers"]["adapter"]["completion"][key] for key in ("version", "untested", "falsifying_check", "verify_yourself")},
                         {"version": "1.0.0", "untested": None, "falsifying_check": None, "verify_yourself": None})


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
        # A bound receipt's row is judged like a real one (UpdateGaps): it lists a live PID, this process's.
        sessions = SimpleNamespace(inventory=lambda: [], locate=lambda node, rows: {"state": self.states[node], "pid": os.getpid()})
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
        # The scenarios reuse ui after a wait saved its handoff; a real lane is stopped then, and `answer` refuses it.
        (self.root / "ui.handoff.json").unlink(missing_ok=True)
        self.completion("ui", status="question", question=text, falsifying_check="", verify_yourself="", untested=None)

    def wait(self, on_sleep=None):
        def sleep(_):
            if on_sleep:
                on_sleep()
        wait_handoffs(self.runtime, clock=lambda: self.now, sleep=sleep)

    def said(self) -> list:
        """The events but each lane's `completion accepted` line (C41), which test_automatic's CompletionAcceptedTests covers."""
        return [event for event in self.events if not re.match(r"Worker \S+ completion accepted: ", event[2])]

    def answer(self, *argv):
        calls = []
        output = io.StringIO()
        with patch.dict(os.environ, {"HERDR_ENV": "1"}), patch("workflow.guardrails.time.time", lambda: self.now), \
                patch("workflow.herdr.subprocess.run", side_effect=lambda command, **_: calls.append(command) or subprocess.CompletedProcess(
                    command, 0, json.dumps(attached_pane("pane-ui", self.root, "ui", "bg-ui")) if command[2] == "process-info" else "", "")), \
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
        # A restarted controller long after ui's own deadline: the persisted pause keeps ui waiting. adapter keeps its real launch
        # time: finished (a completion signal while idle), it met its deadline and is not held to it while ui waits.
        self.now = answered_at = self.TIMEOUT * 3
        self.completion("adapter")
        self.states["adapter"] = "idle"
        extended = self.TIMEOUT + (answered_at - 10.0)
        rounds = []

        def operator_answers():
            rounds.append(self.now)
            if len(rounds) == 1:
                calls, output, code = self.answer("ui", "Use option B")
                self.assertEqual(code, 0, output)
                # A fake Herdr shows the worker's session attached in its pane, then receives the text, then Enter. The text
                # restates the lane's deadline in UTC as the wait moved it: launch + 4 h + the 43190 s the question waited.
                self.assertEqual(iso(extended), "1970-01-01T15:59:50Z")
                typed = "Use option B [Controller: your deadline is now 1970-01-01T15:59:50Z (UTC); the time your question waited was added to it.]"
                self.assertEqual(calls, [["herdr", "pane", "process-info", "--pane", "pane-ui"], ["herdr", "pane", "send-text", "pane-ui", typed],
                                         ["herdr", "pane", "send-keys", "pane-ui", "Enter"]])
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
        self.assertEqual(read_json(self.root / "ui.questions.json")["questions"][1]["answer"], PANE_ANSWER)
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
        # A fourth question is treated as blocked, naming the question; the prompt said so from the start.
        self.ask("Fourth?")
        with self.assertRaisesRegex(RuntimeError, "Worker ui asked question 4; at most 3 are answered, so it is treated as blocked: Fourth\\?"):
            self.wait()
        self.assertTrue((self.root / "ui.completion.json").exists())
        self.assertEqual(len(read_json(self.root / "ui.questions.json")["questions"]), 3)
        # The export serves the lane as the controller treats it: blocked, with the refused question's text.
        for lane in ("ui", "adapter"):
            self.plan["nodes"][lane]["task"] = BRIEF.format(lane=lane)
        served = inputs_section(self.root, {**self.plan, "base_commit": "c" * 40}, two_lane_policy())["workers"]["ui"]
        self.assertEqual((served["completion"]["status"], served["completion"]["question"], len(served["questions"])), ("blocked", "Fourth?", 3))
        from .automatic import completion_prompt
        self.plan["nodes"]["ui"]["task"] = BRIEF.format(lane="ui")
        prompt = completion_prompt(self.root, self.plan, "ui")
        self.assertIn("a fourth question is treated as blocked", prompt)
        self.assertIn("Stop (from your task, the bound on this work): After three failed fixes, report blocked.", prompt)

    def test_a_finished_lane_is_not_held_to_its_deadline_while_another_lane_waits_on_a_question(self):
        # Both lanes launched at t=0. adapter finished at t=100; ui asks at T-600 and is answered after adapter's deadline.
        self.runtime.stop_workers = lambda: self.fail("No worker is stopped")
        self.states.update(ui="working", adapter="idle")
        self.now = 100.0
        self.completion("adapter")
        steps = iter([lambda: (self.states.update(ui="idle"), self.ask("Option A or B?")),
                      lambda: None,  # T+1: adapter's own deadline has passed and the question still waits.
                      lambda: (self.assertEqual(self.answer("ui", "Use option B")[2], 0), self.states.update(ui="working")),
                      lambda: None,
                      lambda: (self.states.update(ui="idle"), self.completion("ui"))])
        times = iter([self.TIMEOUT - 600, self.TIMEOUT + 1, self.TIMEOUT + 60, self.TIMEOUT + 600, self.TIMEOUT + 650])

        def poll():
            self.now = next(times)
            next(steps)()
        # The answer at T+60 moves ui's deadline to T+660: ui finishes inside it and nothing expires.
        self.wait(on_sleep=poll)
        self.assertEqual(read_json(self.root / "ui.deadline.json"), {"node_id": "ui", "paused_seconds": 660.0, "paused_at": None,
                                                                    "met_at": "1970-01-01T04:10:50Z"})
        for lane in ("ui", "adapter"):
            self.assertEqual(read_json(self.root / f"{lane}.handoff.json"), {"summary": "Work", "open_assumptions": []})
        self.assertFalse([event for event in self.events if "deadline exhausted" in event[2]])

    def test_a_finished_lane_that_works_again_keeps_its_deadline_met_across_a_controller_restart(self):
        # adapter finished at t=100. After its own deadline, while ui's question waits, the operator prompts adapter's pane:
        # it works, then blocks on the operator. Its completion signal met its deadline, so nothing expires, in this
        # controller and in a restarted one that never saw adapter idle.
        self.runtime.stop_workers = lambda: self.fail("No worker is stopped")
        self.states.update(ui="working", adapter="idle")
        self.now = 100.0
        self.completion("adapter")
        steps = iter([lambda: (self.states.update(ui="idle"), self.ask("Option A or B?")),
                      lambda: self.states.update(adapter="working"),  # T+1, after adapter's original deadline.
                      lambda: self.states.update(adapter="blocked"),
                      lambda: (_ for _ in ()).throw(KeyboardInterrupt)])  # The controller is interrupted here.
        times = iter([self.TIMEOUT - 600, self.TIMEOUT + 1, self.TIMEOUT + 30, self.TIMEOUT + 40])

        def poll():
            self.now = next(times)
            next(steps)()
        with self.assertRaises(KeyboardInterrupt):
            self.wait(on_sleep=poll)
        # Accepted at t=100 with its turn ended, while ui still worked: kept for the next controller.
        self.assertEqual(read_json(self.root / "adapter.deadline.json")["met_at"], "1970-01-01T00:01:40Z")
        # A new controller: adapter is still working in its pane, ui's question is answered, then both turns end.
        self.states.update(adapter="working")
        steps = iter([lambda: (self.assertEqual(self.answer("ui", "Use option B")[2], 0), self.states.update(ui="working")),
                      lambda: (self.states.update(ui="idle", adapter="idle"), self.completion("ui"))])
        times = iter([self.TIMEOUT + 60, self.TIMEOUT + 600])

        def resumed():
            self.now = next(times)
            next(steps)()
        self.now = self.TIMEOUT + 50
        self.wait(on_sleep=resumed)
        for lane in ("ui", "adapter"):
            self.assertEqual(read_json(self.root / f"{lane}.handoff.json"), {"summary": "Work", "open_assumptions": []})
        self.assertFalse([event for event in self.events if "deadline exhausted" in event[2]])

    def test_a_finished_lane_that_works_again_once_every_lane_finished_is_held_to_the_latest_lane_deadline(self):
        # adapter finished at t=100 while ui worked; ui asks at T-600 and is answered at T+60, which moves ui's deadline to
        # T+660. Meanwhile the operator prompts adapter's pane. Its met deadline kept the run alive while ui worked and waited;
        # once ui finished too it protects no other lane, so adapter is held to the latest lane deadline, T+660: the run never
        # waits longer than its lanes' own deadlines allowed. Past it, the wait ends as a deadline (drive stops the workers).
        for state in ("blocked", "working"):
            with self.subTest(state=state):
                self.setUp()  # A fresh run for each state.
                self.states.update(ui="working", adapter="idle")
                self.now = 100.0
                self.completion("adapter")
                steps = iter([lambda: (self.states.update(ui="idle"), self.ask("Option A or B?")),
                              lambda: (self.assertEqual(self.answer("ui", "Use option B")[2], 0), self.states.update(ui="working", adapter=state)),
                              lambda: (self.states.update(ui="idle"), self.completion("ui")),
                              lambda: None,   # T+659: inside the latest lane deadline.
                              lambda: None])  # T+660: at it.
                times = iter([self.TIMEOUT - 600, self.TIMEOUT + 60, self.TIMEOUT + 600, self.TIMEOUT + 659, self.TIMEOUT + 660])

                def poll():
                    self.now = next(times, None) or self.fail("adapter's wait has no bound")
                    next(steps)()
                with self.assertRaisesRegex(RuntimeError, "Worker adapter deadline exhausted; no automatic relaunch"):
                    self.wait(on_sleep=poll)
                self.assertEqual(read_json(self.root / "ui.deadline.json")["met_at"], "1970-01-01T04:10:00Z")
                self.assertFalse((self.root / "ui.handoff.json").exists())
                messages = [message for node, _, message in self.events if node == "adapter"]
                bound = (f"Worker adapter is {state} again after its completion signal was accepted, and so was every other lane's: "
                         "the run waits for its turn to end until 1970-01-01T04:11:00Z, the latest lane deadline")
                attention = ("Worker adapter needs attention in its pane (native state blocked); its completion signal met its deadline, so "
                             "the run waits for it while another lane works or waits on a question, then until the latest lane deadline")
                accepted = "Worker adapter completion accepted: 0 untested, verify_yourself given"
                self.assertEqual(messages, [accepted, attention, bound] if state == "blocked" else [accepted, bound])

    def test_a_finished_lane_that_works_again_and_ends_its_turn_inside_the_latest_lane_deadline_is_handed_off(self):
        self.runtime.stop_workers = lambda: self.fail("No worker is stopped")
        self.states.update(ui="working", adapter="idle")
        self.now = 100.0
        self.completion("adapter")
        steps = iter([lambda: self.states.update(adapter="working"),  # The operator prompts adapter's pane.
                      lambda: (self.states.update(ui="idle"), self.completion("ui")),
                      lambda: None,
                      lambda: (self.states.update(adapter="idle"), self.completion("adapter", summary="Follow-up"))])
        times = iter([200.0, self.TIMEOUT - 100, self.TIMEOUT - 50, self.TIMEOUT - 10])

        def poll():
            self.now = next(times)
            next(steps)()
        self.wait(on_sleep=poll)
        self.assertEqual(read_json(self.root / "adapter.handoff.json"), {"summary": "Follow-up", "open_assumptions": []})
        self.assertEqual(read_json(self.root / "ui.handoff.json"), {"summary": "Work", "open_assumptions": []})
        self.assertEqual(self.events, [("adapter", "interactive", "Worker adapter completion accepted: 0 untested, verify_yourself given"),
                                       ("ui", "interactive", "Worker ui completion accepted: 0 untested, verify_yourself given"),
                                       ("adapter", "interactive", "Worker adapter is working again after its completion signal was accepted, and "
                                        "so was every other lane's: the run waits for its turn to end until 1970-01-01T04:00:00Z, the latest lane deadline")])

    def test_a_question_written_before_the_deadline_pauses_it_though_the_controller_first_reads_it_after(self):
        # The controller was away across ui's deadline (Claude Code unavailable, exit 75, or a Ctrl-C): ui wrote its question
        # at T-300 and the controller reads it at T+600. The completion file carries no time of its own; its modification time
        # says when ui asked, so the pause starts there and the answer leaves ui the 300 seconds it had left.
        self.runtime.stop_workers = lambda: self.fail("No worker is stopped")
        self.states.update(ui="blocked", adapter="idle")
        self.completion("adapter")
        self.ask("Option A or B?")
        os.utime(self.root / "ui.completion.json", (self.TIMEOUT - 300,) * 2)

        def pane_reply():
            # The operator types the reply in ui's pane and no poll sees ui working. ui writes its next question at T+650, read at
            # T+700: question 1's pause is counted until then, so question 2's starts there, not at T+650 (never counted twice).
            self.ask("Second?")
            os.utime(self.root / "ui.completion.json", (self.TIMEOUT + 650,) * 2)
            self.now = self.TIMEOUT + 700

        def answer():
            self.now = self.TIMEOUT + 800
            self.assertEqual(self.answer("ui", "Use option C")[2], 0)
            self.states["ui"] = "working"
        steps = iter([pane_reply, answer, lambda: (setattr(self, "now", self.TIMEOUT + 1050), self.states.update(ui="done"), self.completion("ui"))])
        self.now = self.TIMEOUT + 600
        self.wait(on_sleep=lambda: next(steps)())
        self.assertEqual([(entry["n"], entry["asked_at"], entry["answer"]) for entry in read_json(self.root / "ui.questions.json")["questions"]],
                         [(1, "1970-01-01T03:55:00Z", PANE_ANSWER), (2, "1970-01-01T04:11:40Z", "Use option C")])
        # Paused from T-300 to T+700, then from T+700 to the answer at T+800: ui's deadline is T+1100 and it finished at T+1050.
        self.assertEqual(read_json(self.root / "ui.deadline.json"), {"node_id": "ui", "paused_seconds": 1100.0, "paused_at": None,
                                                                    "met_at": "1970-01-01T04:17:30Z"})
        self.assertEqual(read_json(self.root / "ui.handoff.json"), {"summary": "Work", "open_assumptions": []})
        self.assertFalse([event for event in self.events if "deadline exhausted" in event[2]])
        # A question written after ui's deadline is refused as before: nothing is recorded, and the deadline ends the wait.
        self.setUp()
        self.states.update(ui="blocked", adapter="idle")
        self.completion("adapter")
        self.ask("Too late?")
        os.utime(self.root / "ui.completion.json", (self.TIMEOUT + 10,) * 2)
        self.now = self.TIMEOUT + 600
        with self.assertRaisesRegex(RuntimeError, "Worker ui deadline exhausted; no automatic relaunch"):
            self.wait(on_sleep=lambda: self.fail("Unexpected wait"))
        self.assertFalse((self.root / "ui.questions.json").exists())
        self.assertTrue((self.root / "ui.completion.json").exists())
        self.assertEqual(self.events, [])

    def test_a_question_is_recorded_in_every_state_a_turn_ends_in(self):
        # A session whose turn ended on a question reports idle or done, or blocked: real sessions whose last message
        # waits on the operator report blocked. In each the file is final; the pause and `answer` work the same.
        for state in ("idle", "done", "blocked"):
            with self.subTest(state=state):
                self.setUp()  # A fresh run for each state.
                self.states.update(ui=state, adapter="idle")
                self.completion("adapter")
                self.ask("Option A or B?")

                def answer():
                    self.assertEqual(read_json(self.root / "ui.questions.json")["questions"][0]["question"], "Option A or B?")
                    self.assertEqual(read_json(self.root / "ui.deadline.json")["paused_at"], "1970-01-01T00:00:10Z")
                    self.now = 70.0
                    calls, output, code = self.answer("ui", "Use option B")
                    self.assertEqual((len(calls), code), (3, 0), output)
                    self.states["ui"] = "working"
                steps = iter([answer, lambda: (self.states.update(ui="done"), self.completion("ui"))])
                self.wait(on_sleep=lambda: next(steps)())
                entry = read_json(self.root / "ui.questions.json")["questions"][0]
                self.assertEqual((entry["answer"], entry["delivered"]), ("Use option B", True))
                self.assertEqual(read_json(self.root / "ui.deadline.json"), {"node_id": "ui", "paused_seconds": 60.0, "paused_at": None,
                                                                            "met_at": "1970-01-01T00:01:10Z"})
                self.assertEqual(read_json(self.root / "ui.handoff.json"), {"summary": "Work", "open_assumptions": []})
                # The question event and its answer; a blocked session waiting on its question needs no other attention event.
                self.assertEqual([message.split(";")[0] for _, _, message in self.said()],
                                 ["Worker ui asked question 1 of 3", "Worker ui question 1 answered"])

    def test_a_session_working_again_without_an_answer_keeps_the_question_answerable_and_a_concurrent_answer_is_no_error(self):
        # ui asks at t=10; at t=40 its session works again though nobody answered (a background command it started ended).
        self.states["adapter"] = "idle"
        self.completion("adapter")
        self.ask("Option A or B?")
        answers = []

        def operator_answers():
            self.states["ui"] = "idle"  # Its turn ends again, still waiting on the question.
            self.now = 50.0
            answers.append(self.answer("ui", "Use option B"))
        steps = iter([lambda: (self.states.update(ui="working"), setattr(self, "now", 40.0)),
                      operator_answers,
                      lambda: self.states.update(ui="working"),  # The answer arrives in the pane.
                      lambda: self.states.update(ui="idle"),     # working -> idle -> working with no question waiting.
                      lambda: self.states.update(ui="working"),
                      lambda: (self.states.update(ui="done"), self.completion("ui"))])
        self.wait(on_sleep=lambda: next(steps)())
        calls, output, code = answers[0]
        self.assertEqual((len(calls), code), (3, 0), output)
        entry = read_json(self.root / "ui.questions.json")["questions"][0]
        self.assertEqual((entry["answer"], entry["answered_at"], entry["delivered"]), ("Use option B", "1970-01-01T00:00:50Z", True))
        # The deadline ran again from t=40, when the session worked; `answer` moved nothing.
        self.assertEqual(read_json(self.root / "ui.deadline.json"), {"node_id": "ui", "paused_seconds": 30.0, "paused_at": None,
                                                                    "met_at": "1970-01-01T00:00:50Z"})
        self.assertFalse((self.root / "adapter.questions.json").exists())
        self.assertEqual(len(self.said()), 2)
        self.assertIn("Worker ui is working again while question 1 waits", self.said()[1][2])
        # `answer` lands between the controller seeing the waiting question and recording the session at work: not an error.
        from . import guardrails
        self.ask("Second?")
        self.states["ui"] = "idle"
        real, raced = guardrails.waiting_question, []

        def answered_meanwhile(directory, node):
            entry = real(directory, node)
            if entry and self.states[node] == "working" and not raced:
                raced.append(self.answer(node, "Use option C"))
            return entry
        steps = iter([lambda: self.states.update(ui="working"), lambda: (self.states.update(ui="done"), self.completion("ui"))])
        with patch("workflow.guardrails.waiting_question", answered_meanwhile):
            self.wait(on_sleep=lambda: next(steps)())
        self.assertEqual(raced[0][2], 0, raced[0][1])
        self.assertEqual(read_json(self.root / "ui.questions.json")["questions"][1]["answer"], "Use option C")
        self.assertIn(("ui", "interactive", "Worker ui question 2 answered; its deadline runs again"), self.events)

    def test_a_stale_working_row_with_an_idle_status_is_no_pane_answer_and_a_busy_status_is(self):
        # Claude Code 2.1.288 can list a session whose turn ended as state working while its status says idle (C18). Read as the
        # session working again, that would record a pane answer nobody typed and restart the paused deadline. Only a busy
        # status is the session working again.
        statuses = {"ui": "waiting", "adapter": "busy"}
        self.runtime.sessions.locate = lambda node, rows: {"state": self.states[node], "status": statuses[node], "pid": os.getpid()}
        self.ask("Option A or B?")
        self.states.update(ui="blocked", adapter="working")  # The question's turn ends waiting on the operator.
        steps = iter([lambda: (self.states.update(ui="working"), statuses.update(ui="idle")),  # The stale row.
                      lambda: None,
                      lambda: setattr(self, "now", self.TIMEOUT + 5)])
        with self.assertRaises(RuntimeError) as raised:
            self.wait(on_sleep=lambda: next(steps)())
        self.assertEqual([(entry["n"], entry["answer"]) for entry in read_json(self.root / "ui.questions.json")["questions"]], [(1, None)])
        self.assertEqual(read_json(self.root / "ui.deadline.json")["paused_at"], "1970-01-01T00:00:10Z")  # Still paused.
        self.assertEqual(str(raised.exception), "Worker adapter deadline exhausted; no automatic relaunch")
        self.assertEqual([message.split(";")[0] for _, _, message in self.events], ["Worker ui asked question 1 of 3"])
        # A busy status is the session at work again: the pane answer is recorded and the deadline runs again.
        statuses["ui"] = "busy"
        with self.assertRaisesRegex(RuntimeError, "Worker adapter deadline exhausted"):
            self.wait()
        entry = read_json(self.root / "ui.questions.json")["questions"][0]
        self.assertEqual((entry["answer"], entry["answered_at"]), (PANE_ANSWER, iso(self.TIMEOUT + 5)))
        self.assertIsNone(read_json(self.root / "ui.deadline.json")["paused_at"])
        self.assertIn("Worker ui is working again while question 1 waits", self.events[-1][2])

    def test_a_completion_signal_written_while_a_question_waits_shows_the_session_worked_again(self):
        # A reply typed in the pane may never show `working`: the registry can report the whole reply turn as blocked, or
        # keep done. The next completion signal proves the session worked again: the waiting question gets the placeholder
        # and its deadline runs again before that signal is recorded or accepted, so only the latest question ever waits.
        for state, ending in (("blocked", "question"), ("blocked", "completed"), ("done", "question"), ("done", "completed")):
            with self.subTest(state=state, ending=ending):
                self.setUp()  # A fresh run for each case.
                self.states.update(ui=state, adapter="idle")
                self.completion("adapter")
                self.ask("Option A or B?")

                def reply_turn_ends():
                    self.now = 100.0
                    if ending == "question":
                        self.ask("Second?")
                    else:
                        self.states["ui"] = "done"
                        self.completion("ui")
                    # Not read yet: the worker went on from question 1, so `answer` types nothing.
                    calls, output, code = self.answer("ui", "Use option B")
                    self.assertEqual((calls, code), ([], 1), output)
                    self.assertIn("Blocked: Worker ui has no unanswered question: it went on from question 1 (its next completion signal written)", output)

                def answer_second():
                    self.assertEqual([(entry["n"], entry["answer"]) for entry in read_json(self.root / "ui.questions.json")["questions"]],
                                     [(1, PANE_ANSWER), (2, None)])
                    self.assertEqual(read_json(self.root / "ui.deadline.json"), {"node_id": "ui", "paused_seconds": 90.0, "paused_at": "1970-01-01T00:01:40Z"})
                    self.now = 130.0
                    calls, output, code = self.answer("ui", "Use option C")
                    self.assertEqual((len(calls), code), (3, 0), output)
                    self.states["ui"] = "done"
                    self.completion("ui")
                steps = iter([reply_turn_ends, answer_second])
                self.wait(on_sleep=lambda: next(steps)())
                questions = read_json(self.root / "ui.questions.json")["questions"]
                self.assertEqual(read_json(self.root / "ui.handoff.json"), {"summary": "Work", "open_assumptions": []})
                self.assertIn(("ui", "interactive", "Worker ui wrote its next completion signal while question 1 waited: it worked again "
                                                    "(an answer typed in its pane, or a command of its own) though no poll saw it working. "
                                                    "Its deadline runs again, and `answer` is refused for question 1"), self.events)
                if ending == "question":
                    self.assertEqual([(entry["n"], entry["answer"]) for entry in questions], [(1, PANE_ANSWER), (2, "Use option C")])
                    self.assertEqual(read_json(self.root / "ui.deadline.json"), {"node_id": "ui", "paused_seconds": 120.0, "paused_at": None,
                                                                                "met_at": "1970-01-01T00:02:10Z"})
                    self.assertEqual([message.split(":")[0].split(";")[0] for _, _, message in self.said()],
                                     ["Worker ui asked question 1 of 3", "Worker ui wrote its next completion signal while question 1 waited",
                                      "Worker ui asked question 2 of 3", "Worker ui question 2 answered"])
                else:
                    self.assertEqual([(entry["n"], entry["answer"]) for entry in questions], [(1, PANE_ANSWER)])
                    self.assertEqual(read_json(self.root / "ui.deadline.json"), {"node_id": "ui", "paused_seconds": 90.0, "paused_at": None,
                                                                                "met_at": "1970-01-01T00:01:40Z"})
                    self.assertEqual(len(self.said()), 2)

    def test_answer_types_nothing_once_the_worker_went_on_from_its_question(self):
        # The operator typed the answer in ui's pane and the controller recorded the placeholder: `answer` may replace it
        # only while ui is on that question. Not once ui wrote its next completion signal, its handoff was saved or the
        # controller stopped it: a stopped worker's pane is a shell, which would run the text as a command.
        self.states["adapter"] = "idle"
        self.completion("adapter")
        self.ask("Option A or B?")

        def refused(reason):
            calls, output, code = self.answer("ui", "Use option B")
            self.assertEqual((calls, code), ([], 1), output)
            self.assertIn(f"Blocked: Worker ui has no unanswered question: it went on from question 1 ({reason}); nothing is typed into its pane", output)
        steps = iter([lambda: self.states.update(ui="working"),
                      lambda: (self.completion("ui"), refused("its next completion signal written")),  # Still working: not read yet.
                      lambda: self.states.update(ui="done")])
        self.wait(on_sleep=lambda: next(steps)())
        self.assertIn("Worker ui is working again while question 1 waits", self.said()[1][2])
        self.assertIn("until the worker writes its next completion signal", self.said()[1][2])
        refused("its handoff saved")
        # freeze records the stop intent and stops the worker; its pane is back at a shell.
        save_json(self.root / "ui.stop.json", {"background_id": "bg-ui", "session_id": "s", "pid": 1, "stopped": True})
        refused("stopped by the controller")
        self.assertEqual(read_json(self.root / "ui.questions.json")["questions"][0]["answer"], PANE_ANSWER)


class AnswerDelivery(unittest.TestCase):
    """`answer` records first (the deadline restarts, PRD 4.6), then delivers; a failed delivery is retried by rerunning it."""

    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        save_json(self.root / "plan.json", {"run_id": "run", "workers": ["ui", "adapter"], "nodes": {"ui": {}, "adapter": {}}})
        for lane in ("ui", "adapter"):
            save_json(self.root / f"{lane}.interactive.json", {"launch_requested_at": "1970-01-01T00:00:00+00:00", "background_id": f"bg-{lane}"})
        from .guardrails import record_question
        runtime = SimpleNamespace(directory=self.root, event=lambda *_: None)
        for lane in ("ui", "adapter"):
            save_json(self.root / f"{lane}.completion.json", {"status": "question"})
            record_question(runtime, lane, {"question": "Option A or B?"}, clock=lambda: 10.0)
        self.now = 100.0

    def answer(self, *argv, herdr_env=True, fail=False, pane=None, fail_at=None, screen=""):
        """(herdr commands, output, exit code); `fail` makes every Herdr command exit 1, as for a closed pane, and `fail_at`
        maps one pane command (send-text, send-keys, read) to the error it raises. `pane` is what process-info shows: by
        default the lane's attach-one attached to its session; `screen` is what `pane read` prints."""
        calls = []

        def run(command, **_):
            calls.append(command)
            if fail:
                raise subprocess.CalledProcessError(1, command, "", "no such pane")
            if command[2] in (fail_at or {}):
                raise fail_at[command[2]]
            if command[2] == "process-info":
                lane = "adapter" if command[-1] == "pane-adapter" else "ui"
                return subprocess.CompletedProcess(command, 0, json.dumps(pane or attached_pane(command[-1], self.root, lane, f"bg-{lane}")), "")
            if command[2] == "read":
                return subprocess.CompletedProcess(command, 0, screen, "")
            return subprocess.CompletedProcess(command, 0, "", "")
        output = io.StringIO()
        environment = {key: value for key, value in os.environ.items() if key != "HERDR_ENV"} | ({"HERDR_ENV": "1"} if herdr_env else {})
        with patch.dict(os.environ, environment, clear=True), patch("workflow.guardrails.time.time", lambda: self.now), \
                patch("workflow.herdr.subprocess.run", side_effect=run), contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
            try:
                answer_main([str(self.root), *argv])
                code = 0
            except SystemExit as exit_:
                code = exit_.code
        return calls, output.getvalue(), code

    def entry(self, lane: str = "ui") -> dict:
        return read_json(self.root / f"{lane}.questions.json")["questions"][-1]

    def test_a_failed_delivery_keeps_the_answer_and_a_rerun_delivers_it_exactly_once(self):
        save_json(self.root / "terminals.json", {"ui": {"pane_id": "pane-ui", "tab_id": "t", "mode": "attach_requested"}})
        # Outside a Herdr pane: recorded and the deadline runs again from now (PRD 4.6), but nothing reached the worker.
        calls, output, code = self.answer("ui", "Use option B", herdr_env=False)
        self.assertEqual((calls, code), ([], 1), output)
        self.assertIn("Recorded the answer to question 1 of ui; its deadline runs again.", output)
        self.assertIn("Blocked: Herdr controls require a Herdr-managed caller pane", output)
        self.assertIn("did not reach the worker", output)
        self.assertIn(f"-m workflow answer {self.root.resolve()} ui 'Use option B'\n", output)
        self.assertIn(f"-m workflow answer {self.root.resolve()} ui 'Use option B' --no-herdr\n", output)
        recorded = self.entry()
        self.assertEqual((recorded["answer"], recorded["answered_at"], recorded["delivered"]), ("Use option B", "1970-01-01T00:01:40Z", False))
        deadline = read_json(self.root / "ui.deadline.json")
        self.assertEqual(deadline, {"node_id": "ui", "paused_seconds": 90.0, "paused_at": None})
        # A different answer to the answered question is refused, and nothing is typed.
        self.now = 150.0
        calls, output, code = self.answer("ui", "Use option C")
        self.assertEqual((calls, code), ([], 1), output)
        self.assertIn("already answered", output)
        self.assertIn("'Use option B'", output)
        # The pane is gone: the same command fails again, reading the pane, and records nothing.
        calls, output, code = self.answer("ui", "Use option B", fail=True)
        self.assertEqual((len(calls), code), (1, 1), output)
        self.assertIn("Blocked: Command '['herdr', 'pane', 'process-info'", output)
        self.assertNotIn("Recorded the answer", output)
        # The pane is back: the rerun types the recorded answer once, and neither the answer nor the deadline changes.
        self.now = 200.0
        calls, output, code = self.answer("ui", "Use option B")
        self.assertEqual(code, 0, output)
        self.assertEqual(calls, [["herdr", "pane", "process-info", "--pane", "pane-ui"], ["herdr", "pane", "send-text", "pane-ui", "Use option B"],
                                 ["herdr", "pane", "send-keys", "pane-ui", "Enter"]])
        self.assertIn("never delivered; delivering it now", output)
        self.assertNotIn("Recorded the answer", output)
        self.assertEqual(self.entry(), {**recorded, "typed": True, "typed_text": "Use option B", "delivered": True})
        self.assertEqual(read_json(self.root / "ui.deadline.json"), deadline)
        self.assertEqual(len(read_json(self.root / "ui.questions.json")["questions"]), 1)
        # Delivered: every further answer is refused, with or without Herdr.
        for argv in (("ui", "Use option B"), ("ui", "Use option B", "--no-herdr")):
            calls, output, code = self.answer(*argv)
            self.assertEqual((calls, code), ([], 1), output)
            self.assertIn("no unanswered question", output)
        # The export serves the entry without the delivery flag.
        from .export_state import worker_questions
        self.assertEqual(worker_questions(self.root / "ui.questions.json"), [{key: recorded[key] for key in ("n", "question", "asked_at", "answer", "answered_at")}])

    def test_a_pane_that_does_not_show_the_session_is_never_typed_into(self):
        # attach-one ended (a detach with Ctrl+Z, an interrupt, a give-up) and left the pane at its shell, which would run
        # the text as a command; it waits between two attaches, and the text would wait for whatever reads the terminal
        # next; or the pane shows another session. Only the pane is read: the answer stays recorded and undelivered.
        save_json(self.root / "terminals.json", {"ui": {"pane_id": "pane-ui", "tab_id": "t", "mode": "attach_requested"}})
        wrapper = [PY, "-m", "workflow.interactive", "attach-one", str(self.root), "--node", "ui"]
        for pane, shown in ((pane_process_info("pane-ui"), "its shell is in the foreground (attach-one ended: a detach, an interrupt or a give-up)"),
                            (pane_process_info("pane-ui", wrapper), "attach-one is between two attaches"),
                            (pane_process_info("pane-ui", [*wrapper[:-1], "adapter"], ["claude", "attach", "bg-adapter"]), "it runs `claude attach bg-adapter`"),
                            ({"id": "cli:pane:process_info"}, "Herdr lists no foreground process in it")):
            with self.subTest(shown=shown):
                calls, output, code = self.answer("ui", "Use B > A; record it", pane=pane)
                self.assertEqual((calls, code), ([["herdr", "pane", "process-info", "--pane", "pane-ui"]], 1), output)
                self.assertIn(f"Blocked: Pane pane-ui (ui) is not attached to its session bg-ui: {shown}; nothing is typed into it. ", output)
                self.assertIn(f"-m workflow.interactive attach-one {self.root.resolve()} --node ui", output)
                self.assertIn("`claude attach bg-ui`", output)
                self.assertIn("did not reach the worker", output)
                self.assertIn(f"-m workflow answer {self.root.resolve()} ui 'Use B > A; record it' --no-herdr\n", output)
                entry = self.entry()
                self.assertEqual((entry["answer"], entry["delivered"], "typed" in entry), ("Use B > A; record it", False, False))
        # Attached again (here with `claude attach` typed by hand in the pane's shell): the rerun types it, once.
        calls, output, code = self.answer("ui", "Use B > A; record it", pane=pane_process_info("pane-ui", ["claude", "attach", "bg-ui"]))
        self.assertEqual(code, 0, output)
        self.assertEqual(calls, [["herdr", "pane", "process-info", "--pane", "pane-ui"], ["herdr", "pane", "send-text", "pane-ui", "Use B > A; record it"],
                                 ["herdr", "pane", "send-keys", "pane-ui", "Enter"]])
        self.assertEqual((self.entry()["typed"], self.entry()["delivered"]), (True, True))

    def test_a_rerun_after_a_failed_enter_presses_enter_only_while_the_input_shows_the_text(self):
        # The text reached the session's input and Enter failed: a rerun must not type it again into that input. It may
        # be gone by the rerun (an update respawned the idle session under a new PID, whose input is empty): Enter then
        # would submit nothing and the answer would count as delivered, so it is pressed only under the text.
        save_json(self.root / "terminals.json", {lane: {"pane_id": f"pane-{lane}", "tab_id": "t", "mode": "attach_requested"} for lane in ("ui", "adapter")})
        for lane in ("ui", "adapter"):
            calls, output, code = self.answer(lane, "Use option B", fail_at={"send-keys": subprocess.TimeoutExpired(["herdr"], 15)})
            self.assertEqual(([call[2] for call in calls], code), (["process-info", "send-text", "send-keys"], 1), output)
            self.assertIn("The answer to question 1 was typed into the worker's pane but not submitted", output)
            self.assertIn("presses Enter only, never types the text again, and only while the pane shows the answer in the session's input", output)
            self.assertIn("press Enter if the session's input holds the answer, else type it first", output)
            self.assertNotIn("did not reach the worker", output)
            self.assertEqual((self.entry(lane)["typed"], self.entry(lane)["delivered"]), (True, False))
        # Back at a shell, Enter would run the typed text: refused, nothing sent.
        calls, output, code = self.answer("ui", "Use option B", pane=pane_process_info("pane-ui"))
        self.assertEqual(([call[2] for call in calls], code), (["process-info"], 1), output)
        self.assertIn("was typed into the worker's pane but not submitted", output)
        # Attached, but the input does not show the text (a respawned session's empty input; other text; no input line
        # at all, as when the session shows a dialog; Herdr failing to read it; the answer in the transcript alone never
        # counts): nothing is pressed and the operator is told to look at the pane.
        for screen, fail_at, shown in ((claude_screen(), None, "its input line is empty"),
                                       (claude_screen("Use option C"), None, "its input line shows 'Use option C'"),
                                       ("● Option A or B? Use option B\n", None, "Herdr shows no Claude Code input line in it"),
                                       (claude_screen("Use option B"), {"read": subprocess.CalledProcessError(1, ["herdr"], "", "no such pane")}, None)):
            with self.subTest(shown=shown):
                calls, output, code = self.answer("ui", "Use option B", screen=screen, fail_at=fail_at)
                self.assertEqual((calls, code), ([["herdr", "pane", "process-info", "--pane", "pane-ui"],
                                                  ["herdr", "pane", "read", "pane-ui", "--source", "visible"]], 1), output)
                if shown:
                    self.assertIn(f"Blocked: Pane pane-ui (ui) does not show the answer typed before in its session's input: {shown}; "
                                  "Enter is not pressed. Look at the pane", output)
                self.assertIn(f"-m workflow answer {self.root.resolve()} ui 'Use option B' --no-herdr\n", output)
                self.assertEqual((self.entry()["typed"], self.entry()["delivered"]), (True, False))
        # The input shows it (wrapped, here even inside a word): the rerun presses Enter only.
        calls, output, code = self.answer("ui", "Use option B", screen=claude_screen("Use opt", "ion B"))
        self.assertEqual(code, 0, output)
        self.assertEqual(calls, [["herdr", "pane", "process-info", "--pane", "pane-ui"], ["herdr", "pane", "read", "pane-ui", "--source", "visible"],
                                 ["herdr", "pane", "send-keys", "pane-ui", "Enter"]])
        self.assertIn("typed into its pane, not submitted", output)
        self.assertEqual((self.entry()["typed"], self.entry()["delivered"]), (True, True))
        # With --no-herdr the operator is told the text may already be in the input, not to type it again blindly.
        calls, output, code = self.answer("adapter", "Use option B", "--no-herdr")
        self.assertEqual((calls, code), ([], 0), output)
        self.assertIn("The answer is typed in the worker's session but not submitted: claude attach bg-adapter, then press Enter", output)
        self.assertEqual((self.entry("adapter")["typed"], self.entry("adapter")["delivered"]), (True, True))

    def test_a_capture_that_ends_at_the_input_line_still_shows_the_input(self):
        # Herdr's capture can end at the `❯` line, with no closing rule under it (20 of the 25 sidecar `pane_busy` refusals on pine).
        # The input then runs to the end of the screen: the answer typed before gets its Enter, and a draft there is refused.
        save_json(self.root / "terminals.json", {"ui": {"pane_id": "pane-ui", "tab_id": "t", "mode": "attach_requested"}})
        calls, output, code = self.answer("ui", "Use option B", fail_at={"send-keys": subprocess.TimeoutExpired(["herdr"], 15)})
        self.assertEqual(([call[2] for call in calls], code), (["process-info", "send-text", "send-keys"], 1), output)
        for screen, shown in ((input_at_bottom("[Operator] The host is out of memory: hold the tests.", "Reply not needed."),
                               "its input line shows '[Operator] The host is out of memory: hold the tests. Reply not needed.'"),
                              (input_at_bottom(), "its input line is empty"),
                              ("● Option A or B?\n❯ Use option B\n", "Herdr shows no Claude Code input line in it")):  # No rule above the `❯`.
            with self.subTest(shown=shown):
                calls, output, code = self.answer("ui", "Use option B", screen=screen)
                self.assertEqual(([call[2] for call in calls], code), (["process-info", "read"], 1), output)
                self.assertIn(f"does not show the answer typed before in its session's input: {shown}; Enter is not pressed", output)
                self.assertEqual((self.entry()["typed"], self.entry()["delivered"]), (True, False))
        calls, output, code = self.answer("ui", "Use option B", screen=input_at_bottom("Use opt", "ion B") + "\n\n")
        self.assertEqual(([call[2] for call in calls], code), (["process-info", "read", "send-keys"], 0), output)
        self.assertIs(self.entry()["delivered"], True)

    def test_a_rerun_after_a_failed_send_text_types_the_answer_and_a_timeout_says_to_look_first(self):
        save_json(self.root / "terminals.json", {"ui": {"pane_id": "pane-ui", "tab_id": "t", "mode": "attach_requested"}})
        # Herdr refused the text: nothing was typed.
        calls, output, code = self.answer("ui", "Use option B", fail_at={"send-text": subprocess.CalledProcessError(1, ["herdr"], "", "no such pane")})
        self.assertEqual(([call[2] for call in calls], code), (["process-info", "send-text"], 1), output)
        self.assertIn("did not reach the worker", output)
        self.assertNotIn("typed", self.entry())
        # Herdr did not answer: the text may be in the input already, so the operator looks before rerunning.
        calls, output, code = self.answer("ui", "Use option B", fail_at={"send-text": subprocess.TimeoutExpired(["herdr"], 15)})
        self.assertEqual(([call[2] for call in calls], code), (["process-info", "send-text"], 1), output)
        self.assertIn("Blocked: Herdr did not confirm the text within 15s, so it may be in pane pane-ui's input already", output)
        self.assertNotIn("typed", self.entry())
        # The rerun types the text and presses Enter.
        calls, output, code = self.answer("ui", "Use option B")
        self.assertEqual(code, 0, output)
        self.assertEqual([call[2] for call in calls], ["process-info", "send-text", "send-keys"])
        self.assertEqual((self.entry()["typed"], self.entry()["delivered"]), (True, True))

    def test_a_run_without_a_pane_for_the_lane_delivers_the_recorded_answer_with_no_herdr(self):
        # Launched without Herdr: no terminals.json, a clear refusal instead of a missing-file error.
        calls, output, code = self.answer("ui", "Use option B")
        self.assertEqual((calls, code), ([], 1), output)
        self.assertIn("Blocked: No Herdr pane is recorded for ui", output)
        self.assertNotIn("Errno", output)
        self.assertIs(self.entry()["delivered"], False)
        # A terminals.json without the lane.
        save_json(self.root / "terminals.json", {"ui": {"pane_id": "pane-ui", "tab_id": "t", "mode": "attach_requested"}})
        calls, output, code = self.answer("adapter", "Keep the adapter")
        self.assertEqual((calls, code), ([], 1), output)
        self.assertIn("Blocked: No Herdr pane is recorded for adapter", output)
        # --no-herdr delivers the recorded answer: the attach command to type it, nothing recorded again.
        answered_at = self.entry()["answered_at"]
        self.now = 300.0
        calls, output, code = self.answer("ui", "Use option B", "--no-herdr")
        self.assertEqual((calls, code), ([], 0), output)
        self.assertIn("Type the answer in the worker's session: claude attach bg-ui", output)
        self.assertNotIn("Recorded the answer", output)
        self.assertEqual((self.entry()["answered_at"], self.entry()["delivered"]), (answered_at, True))
        # Exactly once: the plain command does not type it a second time.
        calls, output, code = self.answer("ui", "Use option B")
        self.assertEqual((calls, code), ([], 1), output)
        self.assertIn("no unanswered question", output)

    def test_in_an_automatic_run_the_typed_text_restates_the_lanes_new_deadline_in_utc(self):
        # Both lanes launched at t=0 with a one-hour deadline and asked at t=10. ui is answered at t=100: its deadline moves
        # by the 90 s its question waited. Only the typed text carries the deadline; the recorded answer is the operator's.
        save_json(self.root / "plan.json", {**read_json(self.root / "plan.json"), "automatic": {**DEFAULTS, "worker_timeout_seconds": 3600}})
        save_json(self.root / "terminals.json", {"ui": {"pane_id": "pane-ui", "tab_id": "t", "mode": "attach_requested"}})
        typed = "Use option B [Controller: your deadline is now 1970-01-01T01:01:30Z (UTC); the time your question waited was added to it.]"
        calls, output, code = self.answer("ui", "Use option B", fail_at={"send-keys": subprocess.TimeoutExpired(["herdr"], 15)})
        self.assertEqual((calls, code), ([["herdr", "pane", "process-info", "--pane", "pane-ui"], ["herdr", "pane", "send-text", "pane-ui", typed],
                                          ["herdr", "pane", "send-keys", "pane-ui", "Enter"]], 1), output)
        # The entry keeps the exact text typed, which the Enter-only rerun looks for.
        self.assertEqual((self.entry()["answer"], self.entry()["typed"], self.entry()["typed_text"]), ("Use option B", True, typed))
        # Later, the rerun finds the same text in the session's input and presses Enter; the bare answer alone is not the text
        # that was typed.
        self.now = 500.0
        calls, output, code = self.answer("ui", "Use option B", screen=claude_screen("Use option B"))
        self.assertEqual(([call[2] for call in calls], code), (["process-info", "read"], 1), output)
        calls, output, code = self.answer("ui", "Use option B", screen=claude_screen(typed[:50], typed[50:]))
        self.assertEqual(code, 0, output)
        self.assertEqual([call[2] for call in calls], ["process-info", "read", "send-keys"])
        # --no-herdr prints the text to type: adapter answered at t=500 has 490 s more.
        calls, output, code = self.answer("adapter", "Keep the adapter", "--no-herdr")
        self.assertEqual((calls, code), ([], 0), output)
        self.assertIn("Type the answer in the worker's session: claude attach bg-adapter\nThe text to type, with the controller's deadline note: "
                      "Keep the adapter [Controller: your deadline is now 1970-01-01T01:08:10Z (UTC); the time your question waited was added to it.]",
                      output)

    def test_a_lane_whose_completion_was_accepted_is_told_the_deadline_the_controller_applies(self):
        # automatic._poll_handoffs holds a lane whose completion it accepted (met_at) to no deadline while another lane works or
        # waits on its answer, and to the latest lane deadline once every lane's completion was accepted; never to its own.
        # ui's completion was accepted at t=5, then its session worked again and asked at t=10; adapter asked at t=10 too.
        from .guardrails import answer_text, mark_deadline_met
        save_json(self.root / "plan.json", {**read_json(self.root / "plan.json"), "automatic": {**DEFAULTS, "worker_timeout_seconds": 3600}})
        save_json(self.root / "terminals.json", {lane: {"pane_id": f"pane-{lane}", "tab_id": "t", "mode": "attach_requested"} for lane in ("ui", "adapter")})
        mark_deadline_met(self.root, "ui", 5.0)
        unbounded = ("Use option B [Controller: your completion was accepted before this question, so no deadline applies to you while another "
                     "lane works or waits on its answer; after that, the latest lane deadline does.]")
        calls, output, code = self.answer("ui", "Use option B", fail_at={"send-keys": subprocess.TimeoutExpired(["herdr"], 15)})
        self.assertEqual((calls[1], code), (["herdr", "pane", "send-text", "pane-ui", unbounded], 1), output)
        # adapter's completion was not accepted: its own deadline, moved by the 390 s its question waited.
        self.now = 400.0
        calls, output, code = self.answer("adapter", "Keep the adapter")
        self.assertEqual((calls[1][-1], code), ("Keep the adapter [Controller: your deadline is now 1970-01-01T01:06:30Z (UTC); the time your "
                                                "question waited was added to it.]", 0), output)
        # Once adapter's is accepted too, every lane's is: ui is held to the latest lane deadline, adapter's 01:06:30, not its own 01:01:30.
        mark_deadline_met(self.root, "adapter", 450.0)
        self.assertEqual(answer_text(self.root, "ui", "Use option B"), "Use option B [Controller: your deadline is now 1970-01-01T01:06:30Z (UTC), "
                                                                       "the latest lane deadline: every lane's completion was accepted.]")
        # The rerun after ui's failed Enter looks for the text that was typed, though the note would read otherwise now.
        self.now = 500.0
        calls, output, code = self.answer("ui", "Use option B", screen=claude_screen(unbounded[:70], unbounded[70:140], unbounded[140:]))
        self.assertEqual(([call[2] for call in calls], code), (["process-info", "read", "send-keys"], 0), output)
        self.assertIs(self.entry()["delivered"], True)

    def test_no_herdr_promises_no_new_deadline_to_a_lane_whose_completion_was_accepted(self):
        # ui's completion was accepted, then it asked while adapter still works: the note says no deadline applies to ui, and
        # the label of the text to type promises none either.
        from .guardrails import mark_deadline_met
        save_json(self.root / "plan.json", {**read_json(self.root / "plan.json"), "automatic": {**DEFAULTS, "worker_timeout_seconds": 3600}})
        mark_deadline_met(self.root, "ui", 5.0)
        calls, output, code = self.answer("ui", "Use option B", "--no-herdr")
        self.assertEqual((calls, code), ([], 0), output)
        self.assertIn("Type the answer in the worker's session: claude attach bg-ui\nThe text to type, with the controller's deadline note: Use "
                      "option B [Controller: your completion was accepted before this question, so no deadline applies to you while another lane "
                      "works or waits on its answer; after that, the latest lane deadline does.]", output)
        self.assertNotIn("new deadline", output)

    def test_an_answer_the_previous_controller_typed_and_did_not_submit_is_submitted_by_its_bare_text(self):
        # A controller before the deadline note typed the bare answer, and its Enter failed: the entry is typed, not delivered, and
        # holds no typed text. After the upgrade an automatic run's text carries the note, but the session's input holds the bare
        # answer: the rerun presses Enter under that.
        from .guardrails import load_questions, record_answer, save_questions
        save_json(self.root / "plan.json", {**read_json(self.root / "plan.json"), "automatic": {**DEFAULTS, "worker_timeout_seconds": 3600}})
        save_json(self.root / "terminals.json", {"ui": {"pane_id": "pane-ui", "tab_id": "t", "mode": "attach_requested"}})
        record_answer(self.root, "ui", "Use option B", clock=lambda: 100.0, delivered=False)
        questions = load_questions(self.root, "ui")
        questions[-1]["typed"] = True
        save_questions(self.root, "ui", questions)
        calls, output, code = self.answer("ui", "Use option B", screen=claude_screen("Use option B"))
        self.assertEqual(code, 0, output)
        self.assertEqual([call[2] for call in calls], ["process-info", "read", "send-keys"])
        self.assertIs(self.entry()["delivered"], True)

    def test_a_rerun_types_nothing_once_the_worker_went_on(self):
        # The delivery failed and the operator typed the answer in the pane: the worker went on. Its next completion
        # signal, its saved handoff or its stop (its pane a shell then) refuses the rerun, which types nothing.
        save_json(self.root / "terminals.json", {"ui": {"pane_id": "pane-ui", "tab_id": "t", "mode": "attach_requested"}})
        calls, output, code = self.answer("ui", "Use option B", herdr_env=False)
        self.assertEqual((calls, code), ([], 1), output)
        for name, reason in (("completion", "its next completion signal written"), ("handoff", "its handoff saved"), ("stop", "stopped by the controller")):
            save_json(self.root / f"ui.{name}.json", {})
            for argv in (("ui", "Use option B"), ("ui", "Use option B", "--no-herdr")):
                calls, output, code = self.answer(*argv)
                self.assertEqual((calls, code), ([], 1), output)
                self.assertIn(f"Blocked: Question 1 of ui is answered but that answer was never delivered, and the worker went on from it ({reason}); "
                              "nothing is typed into its pane", output)
        self.assertIs(self.entry()["delivered"], False)


class ExportSeam(unittest.TestCase):
    def test_export_seam_1_6_0_carries_decisions_challenge_evidence_and_questions_and_older_runs_export_nulls(self):
        """Scenario export-seam (the Python half; contracts/projects/contract.test.ts and server/projects.test.ts serve it)."""
        with tempfile.TemporaryDirectory() as root:
            directory = legacy_run(Path(root))
            before = export_run(ExportRuntime(directory))
            self.assertEqual(before["version"], EXPORT_VERSION)
            self.assertEqual(EXPORT_VERSION, "1.6.0")
            self.assertIsNone(before["sidecar"])  # A run prepared without a sidecar (every run before 1.6.0).
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
            self.assertEqual(inputs["workers"]["ui"]["completion"], {"version": "1.1.0", "status": "completed", "summary": "ui implemented", "open_assumptions": ["assumed"],
                                                                     "untested": ["x"], "falsifying_check": "unit", "verify_yourself": "y", "question": None})
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
                     "## Operator decisions", "## Grill defaults", "## Changes after launch", "## Deferred", "never writes code"):
            self.assertIn(rule.lower(), (fields["description"] + body).lower(), rule)
        readme = (TOOL / "workflow/README.md").read_text()
        self.assertIn('ln -s "$HOME/dev/md-manager/workflow/skills/workflow-grill" ~/.claude/skills/workflow-grill', readme)

    def test_the_skill_plays_back_limits_commits_no_riders_records_answers_verbatim_and_always_reads_back_before_launch(self):
        """C1-C5 (slice 2): phrases only; whether a model follows them needs a live grill, which belongs to a replay case (C39)."""
        body = " ".join((TOOL / "workflow/skills/workflow-grill/SKILL.md").read_text().split("\n---\n", 1)[1].split())
        intro, read, ask, write, back = (body[body.index(start):body.index(end)] for start, end in (
            ("You interview", "## 1."), ("## 1.", "## 2."), ("## 2.", "## 3."), ("## 3.", "## 4."), ("## 4.", "The design challenge then")))
        # Line 10: both guarded versions, and only the operator's answers bind (C4, decision 8).
        self.assertIn("A `feature.json` 2.2.0 or 2.3.0 feature cannot launch without a non-empty `decisions.md`", intro)
        self.assertIn("Only the operator's answers bind the run", intro)
        self.assertNotIn("binds the whole run", body)
        # §1: the target's CLAUDE.md, values kept by hand that the repository records (C3), and every limit played back (C1).
        self.assertIn("Read the target's `CLAUDE.md`, `feature.json`", read)
        self.assertIn("values the drafts or your defaults keep by hand that the repository already records (ids, routes, address lists; "
                      "cite the file that records them)", read)
        self.assertIn("A limit on what the feature delivers (only, never, except, excluded, deferred), one that excludes data or behaviour, "
                      "never counts as settled by the documents, even when it quotes the operator's own words. Ownership lines are not limits.", read)
        self.assertIn('Question 1 plays them all back in one question: "You wrote X; the drafts read it as Y, so Z is excluded. Correct?"', read)
        # §2: no riders (C2), the repository's own mechanism and run limits (C3), restated answers, scoped delegations, open questions (C5).
        self.assertIn("Options differ only on the dimension the question asks.", ask)
        self.assertIn("The `decisions.md` bullet an answer writes commits to nothing its option did not state (the plain-text line, or an "
                      "AskUserQuestion option's label and description).", ask)
        self.assertIn("(an interface, a data shape or field, a rule about another file, a scope change) becomes its own question, or a "
                      "Grill default tagged `[added, not asked]`.", ask)
        self.assertIn("When the drafts or your defaults keep a table, a list or a generator by hand, offer the repository's own mechanism for "
                      "the analogous artifact as an option, citing its file", ask)
        self.assertIn("is a run limit, not a product reason: label it as a run limit and name the setup that would lift it.", ask)
        # The read-back's question is not a sixth question: the limit of five never skips or softens it (C1).
        self.assertIn("never more than five questions in total. The read-back's confirm question (§4) is not one of the five.", ask)
        self.assertIn("After the fifth answer, ask nothing more until the read-back.", ask)
        # Only what was never asked takes a default: a question asked and not answered stays a TODO line, which launch refuses (C5).
        self.assertIn("Resolve what is still open and was never asked yourself with its recommended default (a Grill default), or move it to "
                      "`## Deferred` when it does not block this feature; a question asked and not answered stays a `TODO: Q<n>` line.", ask)
        self.assertNotIn("Resolve what is still open yourself", ask)
        self.assertIn("restate the answer in one sentence at the start of your next message", ask)
        self.assertIn("record it as a Grill default that names the items it covers", ask)
        self.assertIn("A question asked but not answered, including a \"clarify\" reply that was never settled, stays open: write it as "
                      "`TODO: Q<n> <question>` under `## Operator decisions`.", ask)
        # §3: four sections in order; each Operator decision with its question number, the option's text and the words verbatim (C2, C4).
        template = write[write.index("```markdown"):write.index("``` -")]
        self.assertEqual([heading for heading in re.findall(r"## [A-Z][a-z]+(?: [a-z]+)*", template)],
                         ["## Operator decisions", "## Grill defaults", "## Changes after launch", "## Deferred"])
        self.assertIn('- [O1] Q1: <the chosen option\'s text>. Operator: "<the operator\'s words, verbatim>".', template)
        self.assertIn("## Changes after launch None yet.", template)
        self.assertIn("Each `[O<n>]` records its question number, the chosen option's text and the operator's words verbatim", write)
        self.assertIn("Never edit one in place: a later reading or change is a new bullet that cites the id it changes.", write)
        self.assertIn("riders tagged `[added, not asked]`", write)
        self.assertIn("`## Changes after launch` holds `[L<n>]` items, each with the run id and attempt", write)
        self.assertNotIn("No `TODO:` line may remain", body)
        self.assertNotIn("## Assumptions", body)
        self.assertIn("Do not edit the tasks, the policy, the PRD or any code.", write)
        # An older file says nothing of whose each bullet was: its bullets become grill defaults until the operator names them as their
        # own at the read-back, so a re-grill neither binds the grill's guesses nor silently demotes the operator's decisions.
        self.assertIn("An older file without `## Operator decisions` does not record which bullets were the operator's answers: carry its "
                      "decisions and assumptions over as Grill defaults and its deferrals as they are, then ask at the read-back which "
                      "carried-over bullets are the operator's own (§4).", write)
        self.assertNotIn("that you cannot trace to an operator's answer", body)
        # A re-grill keeps the changes recorded at a paused challenge: the template's "None yet." is only for a new file.
        self.assertIn("An existing file keeps its Operator decisions and its Changes after launch as they are; number new bullets after them.", write)
        # §4: the read-back always runs before the hand-back, the bullets the operator did not choose first, then one short question (C1).
        self.assertIn("Always read back before the hand-back, also when the operator asked up front to grill and launch.", back)
        self.assertIn("lists in full every bullet the operator did not choose (every Grill default, `[added, not asked]` riders included, "
                      "every Deferred bullet, every Changes after launch item `[L<n>]` an existing file holds and any `TODO:` line), then "
                      "each Operator decision on one line.", back)
        self.assertIn("End it with one short question: confirm, or say what to change. After carrying over an older file, the same question "
                      "also asks which carried-over bullets are the operator's own.", back)
        self.assertLess(back.index("Always read back"), back.index("--dry-run"))
        # The read-back's answer is the operator's: it becomes an Operator decision, never an edit of a grill default in place (C4).
        self.assertIn("The answer is the operator's own: record it before you hand back. Each bullet the answer changes, and each one it "
                      "confirms by its id, becomes a new `[O<n>]` with the date and the operator's words verbatim, citing what it changes", back)
        self.assertIn("A Grill default or Deferred bullet so replaced leaves its section, and a `TODO: Q<n>` line it answers gives way to its "
                      "`[O<n>]`, since launch refuses the line; an Operator decision stays as written. A plain \"confirm\" changes nothing.", back)
        self.assertNotIn("Change `decisions.md` as the answer says", body)
        self.assertLess(back.index("The answer is the operator's own"), back.index("--dry-run"))

if __name__ == "__main__":
    unittest.main()
