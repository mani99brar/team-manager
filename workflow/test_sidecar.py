"""The review sidecar (docs/PRD_REVIEW_SIDECAR.md section 6, lane engine): one test class per scenario id.

Targets are temporary Git repositories with real lane worktrees. The pass's `claude --print` job is a fake executable
that follows a script of outputs, failures and hangs; Herdr is a patched subprocess; workers are fake sessions. No
Claude model calls.
"""
import contextlib
import copy
import fcntl
import io
import json
import os
import signal
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from langgraph.checkpoint.sqlite import SqliteSaver

from . import sidecar
from .automatic import DEFAULTS as AUTOMATIC, automatic_settings, drive, wait_handoffs
from .export_state import graph_nodes
from .guardrails import input_shown, iso
from .interactive import SIDECAR_NOTE, worker_prompt
from .launch import TOOL, launch_commands
from .pipeline import ExportRuntime, build_pipeline, export_run
from .sessions import TransientInfraError, git, prepare, read_json, save_json
from .test_guardrails import FEATURE, LANES, GuardedFeature, attached_pane, claude_screen, input_at_bottom, pane_process_info, two_lane_policy
from .test_pipeline import FakeSessions, OfflinePipeline, isolate_registry
from .test_portable import commit_all
from .verification import policy_digest, validate_schema

PY = sys.executable
REAL_RUN = subprocess.run  # Patching workflow.herdr.subprocess.run patches it for every module: Git calls pass through.
PRD = TOOL / "docs" / "PRD_REVIEW_SIDECAR.md"
BRIEF = "Review like a senior engineer. BRIEF-MARKER-7."
SETTINGS = dict(sidecar.DEFAULTS)


def setUpModule():
    isolate_registry()  # Attention records go beside a temporary registry, never the operator's.


def appendix_b() -> dict:
    """The ledger example of the PRD's Appendix B, verbatim."""
    text = PRD.read_text().split("## Appendix B", 1)[1]
    return json.loads(text.split("```json\n", 1)[1].split("\n```", 1)[0])


def upsert(ref="new-1", finding_id=None, lane="ui", disposition="open", evidence="", note=None, **fields) -> dict:
    return {"id": finding_id, "ref": ref if finding_id is None else None, "category": "defect", "severity": "P1", "lane": lane,
            "file": "ui.txt", "locator": "", "revision": "working-tree", "problem": "The ui text is wrong.", "evidence": evidence,
            "remedy": "Write the right text.", "disposition": disposition, "note": note, **fields}


def output(findings=(), messages=(), escalations=(), handoff=None, summary="One pass over both lanes.") -> dict:
    return {"summary": summary, "findings": list(findings), "messages": list(messages), "escalations": list(escalations), "handoff": handoff}


def message(lane="ui", finding_ids=("new-1",), text="Please fix the ui text.\nIt is wrong.") -> dict:
    return {"lane": lane, "finding_ids": list(finding_ids), "text": text}


def fake_job(path: Path, script: Path, calls: Path) -> None:
    """A `claude --print` stand-in: it checks the read-only flags, logs its call and plays the next step of `script`
    (an output, an exit status, another session id, raw text, a child process in its group, a hang, or a wait for a release file)."""
    path.write_text(f'''#!{PY}
import json, os, sys, time
from pathlib import Path
args = sys.argv
assert args[args.index('--tools') + 1] == 'Read,Glob,Grep', args
assert '--print' in args and '--json-schema' in args and '--bg' not in args and '--dangerously-skip-permissions' not in args, args
assert 'Bash' not in args[args.index('--tools') + 1]
prompt = sys.stdin.read()
calls = Path({str(calls)!r})
index = len(calls.read_text().splitlines()) if calls.exists() else 0
add_dirs = [args[i + 1] for i, item in enumerate(args) if item == '--add-dir']
with calls.open('a') as handle:
    handle.write(json.dumps({{"cwd": os.getcwd(), "prompt": prompt, "add_dirs": add_dirs, "args": args}}) + '\\n')
script = json.loads(Path({str(script)!r}).read_text())
step = script[index] if index < len(script) else {{}}
if step.get("wait_for"):
    while not Path(step["wait_for"]).exists():
        time.sleep(0.02)
if step.get("child"):
    import subprocess
    child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(600)"])  # In the job's process group.
    Path(step["child"]).write_text(str(child.pid))
if step.get("hang"):
    time.sleep(600)
if "exit" in step:
    sys.exit(step["exit"])
if "raw" in step:
    print(step["raw"])
    sys.exit(0)
default = {{"summary": "Nothing new.", "findings": [], "messages": [], "escalations": [], "handoff": None}}
print(json.dumps({{"session_id": step.get("session") or args[args.index('--session-id') + 1], "is_error": False, "subtype": "success",
                  "structured_output": step.get("output", default)}}))
''')
    path.chmod(0o700)


def kill_quietly(pid: int) -> None:
    try:
        os.kill(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass


class FakeHerdr:
    """`herdr` as subprocess.run sees it: process-info shows each lane's pane attached to its session, `pane read` an empty
    Claude Code input line unless a screen is set, and `fail` maps a verb (read, send-text, ...), or a verb and a pane
    (`read pane-ui`), to the error it raises; `fail_after` maps such a key to (n, error): the first n matching calls succeed."""

    def __init__(self, root: Path, background=lambda lane: f"bg-{lane}"):
        self.root, self.background = root, background
        self.calls, self.screens, self.processes, self.fail, self.fail_after = [], {}, {}, {}, {}

    def run(self, command, *args, **kwargs):
        if command[:1] != ["herdr"]:
            return REAL_RUN(command, *args, **kwargs)
        self.calls.append(command)
        verb = command[2]
        pane = command[4] if verb == "process-info" else command[3]
        for key in (f"{verb} {pane}", verb):
            if key in self.fail:
                raise self.fail[key]
            if key in self.fail_after:
                left, error = self.fail_after[key]
                if left <= 0:
                    raise error
                self.fail_after[key] = (left - 1, error)
        lane = pane.removeprefix("pane-")
        if verb == "process-info":
            return subprocess.CompletedProcess(command, 0, json.dumps(self.processes.get(pane) or attached_pane(pane, self.root, lane, self.background(lane))), "")
        if verb == "read":
            return subprocess.CompletedProcess(command, 0, self.screens.get(pane, claude_screen()), "")
        return subprocess.CompletedProcess(command, 0, "", "")

    def typed(self) -> list:
        return [command[4] for command in self.calls if command[2] == "send-text"]

    def verbs(self) -> list:
        return [command[2] for command in self.calls]


class SidecarRun(unittest.TestCase):
    """A prepared two-lane automatic run with a sidecar: real worktrees, fake sessions (rows by lane state), the fake job."""

    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.repo = self.root / "repo"
        self.repo.mkdir()
        (self.repo / "ui.txt").write_text("before\n")
        (self.repo / "backend.py").write_text("VALUE = 1\n")
        for args in (["init", "-q"], ["config", "user.name", "Test"], ["config", "user.email", "test@example.invalid"], ["add", "."], ["commit", "-qm", "Base"]):
            subprocess.run(["git", "-C", str(self.repo), *args], check=True)
        self.directory = self.root / "run"
        self.plan = prepare(self.directory, self.repo, "HEAD", {"ui": "Change ui. TASK-UI", "adapter": "Change backend. TASK-ADAPTER"}, True)
        self.policy = two_lane_policy()
        self.plan.update(mode="interactive", policy_sha256=policy_digest(self.policy), source_branch="feature/test", automatic=dict(AUTOMATIC),
                         sidecar={"prompt": BRIEF, **SETTINGS}, created_at="2026-10-01T12:00:00Z")
        save_json(self.directory / "plan.json", self.plan)
        save_json(self.directory / "policy.json", self.policy)
        sidecar.write_initial(self.directory, self.plan)
        for lane in LANES:
            save_json(self.directory / f"{lane}.interactive.json", {"launch_requested_at": "1970-01-01T00:00:00+00:00", "background_id": f"bg-{lane}"})
        save_json(self.directory / "terminals.json", {lane: {"pane_id": f"pane-{lane}", "tab_id": "t", "mode": "attach_requested"} for lane in LANES})
        self.states = {"ui": "working", "adapter": "working"}
        self.inventories = 0
        self.script = self.root / "job-script.json"
        self.calls = self.root / "job-calls.jsonl"
        self.script_steps([])
        self.executable = self.root / "fake-claude"
        fake_job(self.executable, self.script, self.calls)
        self.sessions = SimpleNamespace(executable=str(self.executable), inventory=self.inventory, locate=self.locate)
        self.events = []
        self.runtime = SimpleNamespace(directory=self.directory, plan=self.plan, sessions=self.sessions, workers=list(LANES), event=self.event)
        self.now = 10.0
        self.herdr = FakeHerdr(self.directory)
        for context in (patch.dict(os.environ, {"HERDR_ENV": "1"}), patch("workflow.herdr.subprocess.run", side_effect=self.herdr.run)):
            context.start()
            self.addCleanup(context.stop)

    def inventory(self):
        self.inventories += 1
        return []

    def locate(self, node, rows):
        return {"id": f"bg-{node}", "state": self.states[node], "pid": os.getpid()}

    def event(self, node, status, message):
        self.events.append((node, status, message))

    def clock(self):
        return self.now

    def script_steps(self, steps: list) -> None:
        save_json(self.script, steps)

    def job_calls(self) -> list:
        return [json.loads(line) for line in self.calls.read_text().splitlines()] if self.calls.exists() else []

    def ledger(self) -> dict:
        return read_json(self.directory / "sidecar.ledger.json")

    def ledger_bytes(self) -> bytes:
        return (self.directory / "sidecar.ledger.json").read_bytes()

    def run_pass(self, trigger="manual") -> dict | None:
        return sidecar.run_pass(self.runtime, trigger, clock=self.clock, sleep=lambda _: time.sleep(0.02))

    def sidecar_events(self) -> list:
        return [(status, text) for node, status, text in self.events if node == "sidecar"]

    def completion(self, lane: str) -> None:
        save_json(self.directory / f"{lane}.completion.json", {"version": "1.0.0", "run_id": self.plan["run_id"], "node_id": lane,
                                                              "launch_token": self.plan["nodes"][lane]["session_id"], "status": "completed",
                                                              "summary": f"{lane} done", "open_assumptions": []})

    def wait_job(self, scheduler) -> None:
        deadline = time.monotonic() + 30
        while scheduler.current is not None and scheduler.current.process is not None and scheduler.current.process.poll() is None:
            self.assertLess(time.monotonic(), deadline, "the fake job never ended")
            time.sleep(0.02)

    def wait_logged(self, calls: int) -> None:
        """Until the fake job logged its call (a job terminated before it would replay its step in the next pass)."""
        deadline = time.monotonic() + 30
        while len(self.job_calls()) < calls:
            self.assertLess(time.monotonic(), deadline, "the fake job never started")
            time.sleep(0.02)

    def assert_node_statuses(self) -> None:
        self.assertLessEqual({status for status, _ in self.sidecar_events()}, {"running", "interactive", "succeeded"})


# ---- declare ---------------------------------------------------------------------------------------------------------

class Declare(GuardedFeature):
    def with_sidecar(self, value, version="2.3.0") -> None:
        save_json(self.folder / "feature.json", {**self.manifest, "version": version, "sidecar": value})

    def test_declare_a_2_3_0_sidecar_launches_and_every_bad_declaration_is_refused_before_git(self):
        """Scenario declare."""
        # Without a sidecar, 2.3.0 runs the 2.2.0 commands; sidecar: false is no sidecar.
        legacy = launch_commands(self.repo, FEATURE, "a-001", self.runs, herdr=False)[1]
        save_json(self.folder / "feature.json", {**self.manifest, "version": "2.3.0"})
        plain = launch_commands(self.repo, FEATURE, "a-001", self.runs, herdr=False)[1]
        self.assertEqual(plain, legacy)
        self.with_sidecar(False)
        self.assertEqual(launch_commands(self.repo, FEATURE, "a-001", self.runs, herdr=False)[1], legacy)
        self.assertNotIn("sidecar", self.dry_run(FEATURE, "--repo", str(self.repo), "--no-herdr"))
        # builtin:senior-review: prepare pins the bundled brief and the default bounds.
        self.with_sidecar({"prompt": "builtin:senior-review"})
        commit_all(self.repo, "Sidecar")
        printed = self.dry_run(FEATURE, "--repo", str(self.repo), "--no-herdr")
        brief = TOOL / "workflow/prompts/sidecar/senior-review.md"
        self.assertEqual(printed["sidecar"], {"prompt": "builtin:senior-review", **SETTINGS, "brief": str(brief)})
        prepare_command = printed["commands"][2]
        self.assertEqual(prepare_command[prepare_command.index("--sidecar-brief") + 1], str(brief))
        self.assertEqual(json.loads(prepare_command[prepare_command.index("--sidecar-settings") + 1]), SETTINGS)
        self.assertEqual(brief.read_text(), (TOOL / "features/review-sidecar/senior-review-brief.md").read_text())
        directory = self.prepare("builtin-001")
        plan = read_json(directory / "plan.json")
        self.assertEqual(plan["sidecar"], {"prompt": brief.read_text(), **SETTINGS})
        self.assertEqual((plan["feature_version"], sorted(plan["nodes"])), ("2.3.0", sorted(LANES)))
        self.assertEqual(read_json(directory / "sidecar.ledger.json"), sidecar.initial_ledger(plan))
        # A feature file brief with its own bounds.
        (self.folder / "sidecar-brief.md").write_text("Look at the adapter first.\n")
        self.with_sidecar({"prompt": "sidecar-brief.md", "cadence_seconds": 120, "max_messages_per_lane": 0})
        commit_all(self.repo, "File brief")
        plan = read_json(self.prepare("file-001") / "plan.json")
        self.assertEqual(plan["sidecar"], {"prompt": "Look at the adapter first.\n", **SETTINGS, "cadence_seconds": 120, "max_messages_per_lane": 0})
        # Refusals name feature.json and the key, before any Git action (refused() asserts no command ran).
        (self.folder / "empty.md").write_text("  \n")
        commit_all(self.repo, "Empty brief")
        branches = git(self.repo, "branch", "--list")
        for value, version, expected in [
                ({"prompt": "builtin:senior-review"}, "2.2.0", "feature.json sidecar needs version 2.3.0"),
                ({"prompt": "builtin:nope"}, "2.3.0", "feature.json sidecar.prompt names an unknown bundled sidecar brief 'builtin:nope'; bundled: builtin:senior-review"),
                ({"prompt": "empty.md"}, "2.3.0", "feature.json sidecar.prompt 'empty.md' is missing or empty"),
                ({"prompt": "missing.md"}, "2.3.0", "feature.json sidecar.prompt 'missing.md' is missing or empty"),
                ({"prompt": "builtin:senior-review", "cadence_seconds": 30}, "2.3.0", "feature.json sidecar.cadence_seconds must be an integer from 60 to 7200, got 30"),
                ({"prompt": "builtin:senior-review", "max_passes": 65}, "2.3.0", "feature.json sidecar.max_passes must be an integer from 1 to 64, got 65"),
                ({"prompt": "builtin:senior-review", "pass_timeout_seconds": "600"}, "2.3.0", "feature.json sidecar.pass_timeout_seconds must be an integer"),
                ({"prompt": "builtin:senior-review", "max_messages_per_lane": 21}, "2.3.0", "feature.json sidecar.max_messages_per_lane must be an integer from 0 to 20"),
                ({"prompt": "builtin:senior-review", "brief_reviewers": True}, "2.3.0", "feature.json sidecar.brief_reviewers is not a sidecar setting"),
                (True, "2.3.0", "feature.json sidecar must be false or an object with a prompt")]:
            with self.subTest(value=value, version=version):
                self.with_sidecar(value, version)
                self.assertIn(expected, self.refused(FEATURE, "--repo", str(self.repo), "--no-herdr", "--dry-run"))
        # A lane named sidecar (or sidecar-*) is refused like every reserved name.
        for lane in ("sidecar", "sidecar-x"):
            with self.subTest(lane=lane):
                policy = two_lane_policy()
                policy["workers"][0]["node_id"] = lane
                save_json(self.folder / "policy.json", policy)
                (self.folder / f"{lane}-task.md").write_text((self.folder / "ui-task.md").read_text())
                save_json(self.folder / "feature.json", {**self.manifest, "version": "2.3.0", "workers": [{"node_id": lane, "task": f"{lane}-task.md"}, self.manifest["workers"][1]]})
                errors = self.refused(FEATURE, "--repo", str(self.repo), "--no-herdr", "--dry-run")
                self.assertIn("feature.json is invalid", errors)
                self.assertIn("(at workers/0/node_id)", errors)
        self.assertEqual(git(self.repo, "branch", "--list"), branches)
        from .sessions import validate_node_id
        for lane in ("sidecar", "sidecar-1"):
            with self.assertRaisesRegex(ValueError, "reserved"):
                validate_node_id(lane)
        validate_node_id("sidecars")


# ---- graph -----------------------------------------------------------------------------------------------------------

LEGACY_NODES = ["challenge", "launch_ui", "launch_adapter", "handoff", "verify_ui", "verify_adapter", "candidate", "review", "approval", "integrate"]


class Graph(GuardedFeature):
    def test_graph_the_sidecar_node_sits_after_the_challenge_before_every_launch_and_the_plan_keeps_lanes_only(self):
        """Scenario graph."""
        save_json(self.folder / "feature.json", {**self.manifest, "version": "2.3.0", "sidecar": {"prompt": "builtin:senior-review"}})
        commit_all(self.repo, "Sidecar")
        directory = self.prepare("graph-001")
        plan = read_json(directory / "plan.json")
        self.assertEqual(set(plan["sidecar"]), {"prompt", *sidecar.DEFAULTS})
        self.assertEqual(list(plan["nodes"]), LANES)
        nodes = read_json(directory / "run-state.json")["definition"]["nodes"]
        self.assertEqual([node["node_id"] for node in nodes], ["challenge", "sidecar", *LEGACY_NODES[1:]])
        self.assertEqual(nodes[1], {"node_id": "sidecar", "label": "Review sidecar", "kind": "review", "depends_on": ["challenge"]})
        handoff = next(node for node in nodes if node["node_id"] == "handoff")
        self.assertEqual(handoff["depends_on"], ["launch_ui", "launch_adapter", "sidecar"])
        self.assertEqual(read_json(directory / "run-state.json")["sidecar"], sidecar.initial_ledger(plan))
        entry = self.dry_run(FEATURE, "--repo", str(self.repo), "--no-herdr")["registry"]["entry"]
        self.assertEqual(entry["workflows"][0]["definition"]["nodes"], nodes)
        # Without the challenge the sidecar is first and depends on nothing.
        without = graph_nodes(LANES, challenge=False, sidecar=True)
        self.assertEqual((without[0]["node_id"], without[0]["depends_on"], without[1]["node_id"]), ("sidecar", [], "launch_ui"))
        self.assertEqual(without[1]["depends_on"], [])
        # A feature without it has the 1.5.0 node list.
        self.assertEqual([node["node_id"] for node in graph_nodes(LANES, True)], LEGACY_NODES)
        self.assertEqual(graph_nodes(LANES, True), graph_nodes(LANES, True, False))
        # sidecar-pass is refused while the supervisor lock is held.
        with (directory / "automatic-supervisor.lock").open("a") as handle:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
            output, code = self.cli(sidecar.pass_main, [str(directory)])
        self.assertEqual(code, 1)
        self.assertIn("An automatic supervisor owns this run (automatic-supervisor.lock is held)", output)
        # Two passes can never both create the running marker.
        sidecar.claim(directory, {"pass": 1})
        with self.assertRaisesRegex(RuntimeError, "already running"):
            sidecar.claim(directory, {"pass": 2})
        output, code = self.cli(sidecar.pass_main, [str(directory)])
        self.assertEqual(code, 1)
        self.assertIn("A sidecar pass is already running", output)


# ---- pass-inputs -----------------------------------------------------------------------------------------------------

class PassInputs(SidecarRun):
    def test_pass_inputs_hold_both_lanes_diffs_untracked_files_panes_and_the_job_is_read_only(self):
        """Scenario pass-inputs."""
        ui, adapter = (Path(self.plan["nodes"][lane]["worktree"]) for lane in LANES)
        (ui / "ui.txt").write_text("after\n")
        (ui / "notes.txt").write_text("untracked\n")
        (ui / "logo.bin").write_bytes(b"\x00\x01binary")
        subprocess.run(["git", "-C", str(ui), "add", "logo.bin"], check=True)
        (adapter / "backend.py").write_text("VALUE = 2\n")
        save_json(self.directory / "terminals.json", {"ui": {"pane_id": "pane-ui", "tab_id": "t", "mode": "attach_requested"}})
        self.herdr.screens["pane-ui"] = "\x1b[31mworker says: fixed\x1b[0m\x07 done\n"
        self.completion("adapter")
        environments = []
        real_run = subprocess.run

        def spy(command, *args, **kwargs):
            if command[:1] == ["git"]:
                environments.append((command, kwargs.get("env") or {}))
            return real_run(command, *args, **kwargs)
        with patch("workflow.sidecar.subprocess.run", side_effect=spy):
            record = self.run_pass()
        self.assertEqual(record["status"], "completed")
        [call] = self.job_calls()
        inputs = self.directory / "sidecar-inputs/1"
        self.assertEqual(call["add_dirs"], [str(inputs), str(ui), str(adapter)])
        self.assertEqual(Path(call["cwd"]), inputs)
        self.assertIn(BRIEF, call["prompt"])
        self.assertIn("Review sidecar protocol", call["prompt"])
        self.assertIn("ui (worktree", call["prompt"])
        self.assertIn("owns ui.txt", call["prompt"])
        self.assertIn(str(inputs), call["prompt"])
        schema = json.loads(call["args"][call["args"].index("--json-schema") + 1])
        self.assertNotIn("$ref", json.dumps(schema))
        manifest = read_json(inputs / "manifest.json")
        self.assertEqual((manifest["pass"], manifest["trigger"], manifest["base_commit"]), (1, "manual", self.plan["base_commit"]))
        self.assertEqual(list(manifest["lanes"]), LANES)
        lane = manifest["lanes"]["ui"]
        self.assertEqual((lane["state"], lane["question_waiting"], lane["completion"], lane["untracked"], lane["binary"]),
                         ("working", False, None, ["notes.txt"], ["logo.bin"]))
        diff = Path(lane["diff_file"]).read_text()
        self.assertIn("-before\n+after", diff)
        self.assertIn("Binary files", diff)
        self.assertIn("notes.txt", diff.split("# Untracked files")[1])
        self.assertEqual(Path(lane["pane_file"]).read_text(), "worker says: fixed done\n")
        self.assertIsNotNone(lane["deadline"])
        other = manifest["lanes"]["adapter"]
        self.assertEqual((other["pane_file"], other["completion"]), (None, {"status": "completed", "accepted": False}))
        self.assertIn("+VALUE = 2", Path(other["diff_file"]).read_text())
        self.assertEqual(read_json(Path(other["completion_file"]))["summary"], "adapter done")
        self.assertEqual(sorted(path.name for path in (inputs / "tasks").iterdir()), ["adapter.task.md", "policy.json", "ui.task.md"])
        self.assertEqual(read_json(inputs / "ledger.json"), sidecar.initial_ledger(self.plan))
        self.assertEqual(record["lanes"], {"ui": {"head_commit": self.plan["base_commit"], "pane_captured": True},
                                           "adapter": {"head_commit": self.plan["base_commit"], "pane_captured": False}})
        self.assertTrue(environments)
        self.assertTrue(all(env.get("GIT_OPTIONAL_LOCKS") == "0" for _, env in environments), environments)
        self.assertTrue(all("--binary" not in command for command, _ in environments))
        # Without Herdr nothing is captured: pane_file null for every lane.
        with patch.dict(os.environ, {"HERDR_ENV": ""}):
            self.run_pass()
        self.assertEqual([lane["pane_file"] for lane in read_json(self.directory / "sidecar-inputs/2/manifest.json")["lanes"].values()], [None, None])
        # A run keeps the inputs of its last eight passes.
        for _ in range(8):
            self.run_pass()
        self.assertEqual(sorted(int(path.name) for path in (self.directory / "sidecar-inputs").iterdir()), list(range(3, 11)))
        self.assertEqual(len(self.ledger()["passes"]), 10)


class PassPrompt(SidecarRun):
    def test_the_prompt_holds_the_operators_severity_rule_and_the_reviewer_briefs_are_inputs_only(self):
        # C41 (decisions 4 and 12): the prompt defined no severity, and all 23 findings of 35 live passes came out P2. The rule is
        # the operator's, not the reviewer briefs' (coverage's stricter bar would contradict decision 4): those are context.
        self.plan["reviewers"] = [{"reviewer_id": "general", "prompt": "Review like a staff engineer. GENERAL-BRIEF."},
                                  {"reviewer_id": "coverage", "prompt": "Block on every missing test. COVERAGE-BRIEF."}]
        self.run_pass()
        [call] = self.job_calls()
        prompt = " ".join(call["prompt"].split())
        self.assertIn("Severity, the operator's rule for your findings, whatever a reviewer brief says: P0 or P1 only for a defect shown by "
                      "the code, a check or a pane; work that contradicts a line of a task, of decisions.md or a safety line of the PRD; a "
                      "failure the worker disclosed; or a security or data-loss risk. P0 when the lane's work must not merge at all. "
                      "Untested behaviour, risks and suggestions are P2, however likely; P2 is the lowest.", prompt)
        self.assertIn("tasks/ holds the pinned tasks, decisions.md, the policy, the design challenge record and, in reviewers/, the briefs "
                      "of the run's reviewers: what review will look at, never a severity rule for your findings.", prompt)
        self.assertNotIn("GENERAL-BRIEF", prompt)
        tasks = self.directory / "sidecar-inputs" / "1" / "tasks"
        self.assertEqual({path.name: path.read_text() for path in (tasks / "reviewers").iterdir()},
                         {"general.md": "Review like a staff engineer. GENERAL-BRIEF.", "coverage.md": "Block on every missing test. COVERAGE-BRIEF."})
        # A run with the single built-in reviewer pins no brief: no folder, and the prompt names none.
        del self.plan["reviewers"]
        self.run_pass()
        self.assertFalse((self.directory / "sidecar-inputs" / "2" / "tasks" / "reviewers").exists())
        prompt = " ".join(self.job_calls()[-1]["prompt"].split())
        self.assertIn("tasks/ holds the pinned tasks, decisions.md, the policy and the design challenge record.", prompt)
        self.assertIn("Severity, the operator's rule for your findings", prompt)

    def test_the_prompt_carries_the_project_conventions_and_an_old_plan_none(self):
        # C15: the conventions block every role gets, from plan.conventions (pinned at prepare); a plan without one has none.
        self.run_pass()
        self.assertNotIn("Project conventions", self.job_calls()[-1]["prompt"])
        self.plan["conventions"] = {"text": "# Project conventions\n\nRun the unit tests with pytest -q. CONVENTIONS-MARKER-9.\n\n"}
        self.run_pass()
        prompt = self.job_calls()[-1]["prompt"]
        block = (f"\n\nProject conventions (CLAUDE.md at {self.plan['base_commit']}; the task and decisions.md take precedence):\n"
                 "# Project conventions\n\nRun the unit tests with pytest -q. CONVENTIONS-MARKER-9.\n")
        self.assertEqual(sidecar.conventions_block(self.plan), block)
        self.assertIn(BRIEF + block + "\n=== Review sidecar protocol", prompt)  # After the brief, before the protocol block.
        for value in ({"text": "  \n"}, {"text": None}, "not a record"):
            with self.subTest(conventions=value):
                self.plan["conventions"] = value
                self.run_pass()
                self.assertNotIn("Project conventions", self.job_calls()[-1]["prompt"])


# ---- ledger-merge ----------------------------------------------------------------------------------------------------

class LedgerMerge(SidecarRun):
    def test_ledger_merge_assigns_ids_records_history_and_rejects_bad_outputs_byte_identically(self):
        """Scenario ledger-merge."""
        self.script_steps([
            {"output": output([upsert()])},
            {"output": output([upsert(finding_id="S-1", disposition="fix_reported", evidence="pane: 'fixed it'", revision="b2c3d4e")])},
            {"output": output([upsert(finding_id="S-1", disposition="verified_resolved", evidence="ui.txt now says after", revision="c3d4e5f")])},
            {"output": output([upsert(finding_id="S-1", disposition="open")])},  # Reopened without evidence.
            {"output": output([upsert(finding_id="S-2")])},
            {"output": output([upsert(lane="docs")])},
            {"output": output([upsert(finding_id="S-1", disposition="withdrawn", evidence="x"), upsert(finding_id="S-1", disposition="withdrawn", evidence="y")])},
            {"output": output([upsert(), upsert()])},
            {"output": output([upsert(disposition="verified_resolved")])},
            {"output": output([upsert(disposition="accepted_trade_off")])},
            {"output": output([upsert()], [message(finding_ids=["new-9"])])},
            {"output": {"summary": "Malformed", "findings": [{"problem": "no shape"}], "messages": [], "escalations": [], "handoff": None}},
        ])
        self.assertEqual(self.run_pass()["counts"], {"new": 1, "changed": 0, "messages": 0})
        [finding] = self.ledger()["findings"]
        self.assertEqual((finding["id"], finding["disposition"], finding["messages"], len(finding["history"])), ("S-1", "open", [], 1))
        self.assertNotIn("ref", finding)
        self.assertEqual(self.run_pass()["counts"], {"new": 0, "changed": 1, "messages": 0})
        [finding] = self.ledger()["findings"]
        self.assertEqual([(entry["pass"], entry["disposition"], entry["revision"]) for entry in finding["history"]],
                         [(1, "open", "working-tree"), (2, "fix_reported", "b2c3d4e")])
        self.run_pass()
        [finding] = self.ledger()["findings"]
        self.assertEqual((finding["disposition"], finding["evidence"], finding["revision"]), ("verified_resolved", "ui.txt now says after", "c3d4e5f"))
        self.assertEqual([entry["disposition"] for entry in finding["history"]], ["open", "fix_reported", "verified_resolved"])
        self.assertEqual(finding["history"][1]["evidence"], "pane: 'fixed it'")
        validate_schema("sidecar", self.ledger())
        reasons = ["transition", "unknown_id", "unknown_lane", "duplicate", "duplicate", "transition", "transition", "unknown_ref", "schema"]
        for reason in reasons:
            with self.subTest(reason=reason):
                before = self.ledger_bytes()
                self.assertIsNone(self.run_pass())
                self.assertEqual(self.ledger_bytes(), before)
                self.assertEqual(self.sidecar_events()[-1][0], "interactive")
                self.assertIn(f"output rejected ({reason}); the ledger is unchanged", self.sidecar_events()[-1][1])
        self.assertFalse((self.directory / "sidecar.running.json").exists())
        # The rejected passes consumed their numbers; the next pass is 13.
        self.run_pass()
        self.assertEqual([item["n"] for item in self.ledger()["passes"]], [1, 2, 3, 13])
        self.assert_node_statuses()

    def test_the_merge_is_pure_and_resolves_refs_within_one_output(self):
        ledger = sidecar.initial_ledger(self.plan)
        frozen = copy.deepcopy(ledger)
        record = {"n": 1, "trigger": "cadence", "started_at": "t", "finished_at": "t", "status": "completed", "session_id": "s", "lanes": {}}
        merged, messages, escalations = sidecar.merge(ledger, output([upsert(), upsert(ref="new-2", lane="adapter")],
                                                                     [message(finding_ids=["new-2", "new-1", "new-2"], lane="adapter")],
                                                                     [{"finding_id": "new-2", "kind": "security", "text": "Leaks a token."}]),
                                                      record, LANES, "t")
        self.assertEqual(ledger, frozen)
        self.assertEqual([finding["id"] for finding in merged["findings"]], ["S-1", "S-2"])
        self.assertEqual(messages[0]["finding_ids"], ["S-2", "S-1"])
        self.assertEqual([finding["messages"] for finding in merged["findings"]], [["M-1"], ["M-1"]])
        self.assertEqual(escalations, [{"pass": 1, "finding_id": "S-2", "kind": "security", "text": "Leaks a token.", "at": "t"}])
        validate_schema("sidecar", merged)
        # An unchanged upsert is no change: no history entry.
        again, _, _ = sidecar.merge(merged, output([{**upsert(finding_id="S-1")}]), {**record, "n": 2}, LANES, "t")
        self.assertEqual((again["passes"][-1]["counts"]["changed"], len(again["findings"][0]["history"])), (0, 1))


# ---- messages --------------------------------------------------------------------------------------------------------

DIALOG = "\n".join(["╭──────────────────────────────╮", "│ Bash command                 │", "│ rm -rf build                 │",
                    "│ Do you want to proceed?      │", "│ ❯ 1. Yes                     │", "│   2. No                      │", "╰──────────────────────────────╯"])


class Messages(SidecarRun):
    def setUp(self):
        super().setUp()
        save_json(self.directory / "ui.deadline.json", {"node_id": "ui", "paused_seconds": 12.0, "paused_at": None})
        self.deadline = (self.directory / "ui.deadline.json").read_bytes()

    def deliver(self, *messages_, findings=None) -> list:
        """One pass whose output sends `messages_` (default one to ui citing its new finding); the messages it recorded."""
        self.herdr.calls.clear()
        before = len(self.ledger()["messages"])
        self.script_steps([*([{}] * len(self.job_calls())), {"output": output(findings or [upsert()], messages_ or [message()])}])
        self.run_pass()
        self.assertEqual((self.directory / "ui.deadline.json").read_bytes(), self.deadline)
        self.assertFalse(any(message["status"] == "pending" for message in self.ledger()["messages"]))
        return self.ledger()["messages"][before:]

    def assert_outcome(self, status, reason, typed=False, **kwargs):
        [recorded] = self.deliver(**kwargs)
        self.assertEqual((recorded["status"], recorded["reason"]), (status, reason))
        if not typed:
            self.assertEqual(self.herdr.typed(), [])
            self.assertNotIn("send-keys", self.herdr.verbs())
        return recorded

    def test_messages_are_typed_only_through_the_gate_and_refused_or_undeliverable_otherwise(self):
        """Scenario messages."""
        # Delivered to a working lane, and to an idle one: the prefix with the resolved id, newlines flattened, then Enter.
        recorded = self.assert_outcome("delivered", None, typed=True)
        self.assertEqual(self.herdr.typed(), [f"[Review sidecar {recorded['finding_ids'][0]}] Please fix the ui text. It is wrong."])
        self.assertEqual(self.herdr.verbs()[-2:], ["send-text", "send-keys"])
        self.assertEqual(self.herdr.calls[-1][-1], "Enter")
        self.assertEqual(recorded["finding_ids"], ["S-1"])
        self.states["ui"] = "idle"
        self.assert_outcome("delivered", None, typed=True)
        # Refused, nothing typed: a question waits, a second message to the same lane in one pass, a lane not launched.
        save_json(self.directory / "ui.questions.json", {"node_id": "ui", "questions": [{"n": 1, "question": "A or B?", "asked_at": "x", "answer": None, "answered_at": None}]})
        self.assert_outcome("refused", "question_waiting")
        (self.directory / "ui.questions.json").unlink()
        first, second = self.deliver(message(), message(text="Another one."))
        self.assertEqual([(first["status"], second["status"], second["reason"])], [("delivered", "refused", "rate_limited")])
        self.assertEqual(len(self.herdr.typed()), 1)
        os.rename(self.directory / "ui.interactive.json", self.directory / "ui.interactive.bak")
        self.assert_outcome("refused", "lane_not_launched")
        os.rename(self.directory / "ui.interactive.bak", self.directory / "ui.interactive.json")
        # Undeliverable, nothing typed: a blocked row, a permission dialog, a typed draft, a pane in its shell, Herdr timing out,
        # no Herdr at all, no pane recorded for the lane.
        self.states["ui"] = "blocked"
        self.assert_outcome("undeliverable", "lane_blocked")
        self.states["ui"] = "working"
        self.herdr.screens["pane-ui"] = DIALOG
        self.assert_outcome("undeliverable", "pane_busy")
        self.herdr.screens["pane-ui"] = claude_screen("my own draft")
        self.assert_outcome("undeliverable", "pane_busy")
        del self.herdr.screens["pane-ui"]
        self.herdr.processes["pane-ui"] = pane_process_info("pane-ui")
        self.assert_outcome("undeliverable", "pane_not_attached")
        del self.herdr.processes["pane-ui"]
        self.herdr.fail["process-info"] = subprocess.TimeoutExpired(["herdr"], 15)
        self.assert_outcome("undeliverable", "herdr_timeout")
        self.assertIn("message M-", self.sidecar_events()[-2][1])  # The error is one interactive event, by id.
        del self.herdr.fail["process-info"]
        with patch.dict(os.environ, {"HERDR_ENV": ""}):
            self.assert_outcome("undeliverable", "herdr_unavailable")
        save_json(self.directory / "terminals.json", {})
        self.assert_outcome("undeliverable", "pane_unknown")
        save_json(self.directory / "terminals.json", {lane: {"pane_id": f"pane-{lane}", "tab_id": "t", "mode": "attach_requested"} for lane in LANES})
        # The seventh message of a run (max_messages_per_lane 6): five reached ui so far; one more does, the next is refused.
        self.assertEqual(sum(1 for item in self.ledger()["messages"] if item["lane"] == "ui" and item["status"] == "delivered"), 3)
        for _ in range(3):
            self.assert_outcome("delivered", None, typed=True)
        self.assert_outcome("refused", "rate_limited")
        # A lane that wrote its completion is never messaged; after freeze every message is refused.
        self.completion("adapter")
        [recorded] = self.deliver(message(lane="adapter"))
        self.assertEqual((recorded["status"], recorded["reason"]), ("refused", "lane_finished"))
        (self.directory / "adapter.completion.json").unlink()
        (self.directory / "snapshots.json").write_text("{}")
        [recorded] = self.deliver(message(lane="adapter"))
        self.assertEqual((recorded["status"], recorded["reason"]), ("refused", "after_freeze"))
        self.assertEqual(self.herdr.typed(), [])
        validate_schema("sidecar", self.ledger())
        self.assert_node_statuses()

    def test_the_gate_reads_an_input_line_at_the_bottom_of_the_capture(self):
        # In 20 of the 25 `pane_busy` refusals in pine's sidecar ledgers Herdr's capture ended at the `❯` line with no closing rule
        # under it, 17 of them on an empty input. The input then runs to the end of the screen, so an empty one there takes the message.
        for screen in (input_at_bottom(), input_at_bottom() + "\n\n"):
            with self.subTest(screen=screen):
                self.herdr.screens["pane-ui"] = screen
                self.assert_outcome("delivered", None, typed=True)
        self.assertIsNone(input_shown(input_at_bottom(), ""))
        # A draft there is still refused (6 of the 25 held a typed `[Operator] ...` draft), and so is a screen whose `❯` line is
        # under no rule: a transcript line, or a dialog's option.
        draft = input_at_bottom("[Operator] The host is out of memory: hold the tests.", "Reply not needed.")
        for screen, shown in ((draft, "its input line shows '[Operator] The host is out of memory: hold the tests. Reply not needed.'"),
                              ("● Done.\n❯ Use option B\n", "Herdr shows no Claude Code input line in it"),
                              (DIALOG, "Herdr shows no Claude Code input line in it")):
            with self.subTest(shown=shown):
                self.assertEqual(input_shown(screen, ""), shown)
                self.herdr.screens["pane-ui"] = screen
                self.assert_outcome("undeliverable", "pane_busy")

    def test_a_message_citing_an_existing_finding_and_a_ref_is_typed_with_the_resolved_ids(self):
        self.deliver()
        [recorded] = self.deliver(message(finding_ids=["S-1", "new-1"], text="Two\r\nthings\tand \x1b[31mred\x1b[0m."), findings=[upsert()])
        self.assertEqual((recorded["status"], recorded["finding_ids"]), ("delivered", ["S-1", "S-2"]))
        self.assertEqual(self.herdr.typed(), ["[Review sidecar S-1, S-2] Two  things and red."])

    def test_the_first_herdr_timeout_of_a_pass_skips_every_later_herdr_call_of_that_pass(self):
        """PRD 4.3: lane ui's capture times out, so lane adapter's pane is not read and the pass's message to adapter is
        undeliverable (herdr_timeout) without another Herdr call; the next pass has a fresh budget."""
        self.herdr.fail["read pane-ui"] = subprocess.TimeoutExpired(["herdr"], 15)
        [recorded] = self.deliver(message(lane="adapter"), findings=[upsert(lane="adapter")])
        self.assertEqual((recorded["status"], recorded["reason"]), ("undeliverable", "herdr_timeout"))
        self.assertEqual(self.herdr.calls, [["herdr", "pane", "read", "pane-ui", "--source", "visible"]])  # Only the call that timed out.
        record = self.ledger()["passes"][-1]
        self.assertEqual(record["status"], "completed")
        self.assertEqual({lane: item["pane_captured"] for lane, item in record["lanes"].items()}, {"ui": False, "adapter": False})
        manifest = read_json(self.directory / "sidecar-inputs" / str(record["n"]) / "manifest.json")
        self.assertEqual({lane: item["pane_file"] for lane, item in manifest["lanes"].items()}, {"ui": None, "adapter": None})
        self.assertFalse(any("undeliverable after an error" in text for _, text in self.sidecar_events()))  # Skipped, not an error.
        # The skip is the pass's own: the next pass reads both panes and types its message.
        del self.herdr.fail["read pane-ui"]
        [recorded] = self.deliver(message(lane="adapter", finding_ids=["S-1"]), findings=[upsert(finding_id="S-1", lane="adapter")])
        self.assertEqual((recorded["status"], recorded["reason"]), ("delivered", None))
        self.assertEqual([command[3] for command in self.herdr.calls if command[2] == "read"][:2], ["pane-ui", "pane-adapter"])
        self.assertEqual(self.herdr.typed(), ["[Review sidecar S-1] Please fix the ui text. It is wrong."])

    def test_each_error_in_the_gate_ends_undeliverable_with_its_own_reason_one_event_and_nothing_typed(self):
        """PRD 4.5 and decisions.md: an error inside the gate is caught per message and mapped to its reason; the pass completes,
        writes one interactive event naming the message and the error type, and nothing reaches the pane."""
        def inventory_fails_in_the_gate():
            calls = []

            def inventory():
                calls.append(1)
                if len(calls) > 1:  # The pass's inputs read the rows first; the gate's fresh inventory is the second call.
                    raise TransientInfraError("background session inventory unavailable")
                return []
            self.sessions.inventory = inventory

        refused = subprocess.CalledProcessError(1, ["herdr"], "", "no such pane")
        captures = ["read", "read"]  # The pass's capture of both panes, which works in every case.
        cases = [
            # The pane closed between the pass's capture and the delivery: Herdr refuses the gate's process-info.
            ("pane closed", lambda: self.herdr.fail.update({"process-info pane-ui": refused}), "pane_unknown", "CalledProcessError",
             [*captures, "process-info"]),
            # It closed after the gate saw its process: the gate's read of the screen is refused (the capture was the first read).
            ("pane closed before the gate read", lambda: self.herdr.fail_after.update({"read pane-ui": (1, refused)}), "pane_unknown",
             "CalledProcessError", [*captures, "process-info", "read"]),
            # The gate's fresh inventory fails: the gate stops before any Herdr call.
            ("inventory", inventory_fails_in_the_gate, "lane_blocked", "TransientInfraError", captures),
            ("herdr error", lambda: self.herdr.fail.update({"process-info": RuntimeError("herdr: server not running")}), "herdr_unavailable",
             "RuntimeError", [*captures, "process-info"]),
        ]
        for name, inject, reason, error, verbs in cases:
            with self.subTest(name=name):
                self.sessions.inventory = self.inventory
                self.herdr.fail.clear()
                self.herdr.fail_after.clear()
                inject()
                before = len(self.events)
                [recorded] = self.deliver()
                self.assertEqual((recorded["status"], recorded["reason"]), ("undeliverable", reason))
                self.assertEqual(self.herdr.typed(), [])
                self.assertNotIn("send-keys", self.herdr.verbs())
                record = self.ledger()["passes"][-1]
                self.assertEqual(record["status"], "completed")
                self.assertTrue(record["lanes"]["ui"]["pane_captured"])  # The capture worked: the failure is the gate's own.
                interactive = [text for node, status, text in self.events[before:] if node == "sidecar" and status == "interactive"]
                self.assertEqual(interactive, [f"Review sidecar pass {record['n']} (manual): message {recorded['id']} to ui undeliverable after an error "
                                               f"({error}); see sidecar-{record['n']}.stderr.log"])
                self.assertIn("1 undeliverable", self.sidecar_events()[-1][1])
                self.assertIn(error, (self.directory / f"sidecar-{record['n']}.stderr.log").read_text())
                self.assertEqual(self.herdr.verbs(), verbs)
        self.assertFalse(any(node == "controller" for node, _, _ in self.events))
        validate_schema("sidecar", self.ledger())
        self.assert_node_statuses()


class Paging(SidecarRun):
    """C41 (decision 12): a P0/P1 a pass made that no lane took, and every escalation, reach the operator as one `sidecar`
    attention record on that lane; a P0/P1 delivered to its lane does not."""

    def setUp(self):
        super().setUp()
        environment = patch.dict(os.environ, {"MD_MANAGER_PROJECTS_CONFIG": str(self.root / "config" / "projects.json")})
        environment.start()
        self.addCleanup(environment.stop)

    def records(self) -> list:
        feed = self.root / "config" / "attention.jsonl"
        return [(line["kind"], line["node"], line["text"]) for line in map(json.loads, feed.read_text().splitlines())] if feed.exists() else []

    def run_output(self, findings=(), messages=(), escalations=()) -> list:
        """One pass returning this output; the attention records it added."""
        before = len(self.records())
        self.script_steps([*([{}] * len(self.job_calls())), {"output": output(findings, messages, escalations)}])
        self.assertEqual(self.run_pass()["status"], "completed")
        return self.records()[before:]

    def test_a_p1_no_lane_took_and_an_escalation_page_the_operator_and_a_delivered_p1_does_not(self):
        ledger = self.directory / "sidecar.ledger.json"
        where = f"Read it in {ledger} or on the run's sidecar page."
        # Delivered to its lane: the lane has it, nothing pages.
        self.assertEqual(self.run_output([upsert()], [message()]), [])
        self.assertEqual(self.ledger()["messages"][-1]["status"], "delivered")
        # Refused because the lane finished (a one-lane run's final pass reaches no worker): one record, on that lane.
        self.completion("ui")
        problem = "The ui text is still wrong after the fix. It says before."
        self.assertEqual(self.run_output([upsert(problem=problem)], [message()]),
                         [("sidecar", "ui", f"Review sidecar pass 2: P1 S-2 on lane ui did not reach the lane (refused, lane_finished): "
                                            f"The ui text is still wrong after the fix. {where}")])
        (self.directory / "ui.completion.json").unlink()
        # Not messaged at all, or undeliverable: each pages once.
        self.herdr.screens["pane-adapter"] = claude_screen("my own draft")
        self.assertEqual(self.run_output([upsert(lane="adapter", severity="P0", problem="Deletes the database. Always.")],
                                         [message(lane="adapter")]),
                         [("sidecar", "adapter", f"Review sidecar pass 3: P0 S-3 on lane adapter did not reach the lane (undeliverable, pane_busy): "
                                                 f"Deletes the database. {where}")])
        self.assertEqual(len(self.run_output([upsert(ref="new-1", lane="adapter")])), 1)
        # Not new and not raised: a P1 updated again, a P2, a P1 resolved, a delivered P1 upserted without a message.
        self.assertEqual(self.run_output([upsert(finding_id="S-1", note="Still open."), upsert(ref="new-1", severity="P2"),
                                          upsert(finding_id="S-4", lane="adapter", disposition="verified_resolved", evidence="Fixed in b2c3d4e.")]), [])
        # Raised from P2, and reopened from verified_resolved: each pages, with no message to it.
        raised = self.run_output([upsert(finding_id="S-5", severity="P1", problem="Now it loses data."),
                                  upsert(finding_id="S-4", lane="adapter", evidence="It broke again in c3d4e5f.")])
        self.assertEqual(raised, [  # In the ledger's order.
            ("sidecar", "adapter", f"Review sidecar pass 6: P1 S-4 on lane adapter did not reach the lane (no message to it): The ui text is wrong. {where}"),
            ("sidecar", "ui", f"Review sidecar pass 6: P1 S-5 on lane ui did not reach the lane (no message to it): Now it loses data. {where}")])
        # Every escalation pages, here of a finding delivered to its lane, which itself does not; its event keeps the fixed form.
        escalated = self.run_output([upsert(ref="new-1", problem="Leaks the token.")], [message()],
                                    [{"finding_id": "new-1", "kind": "security", "text": "The token reaches the log. Rotate it."}])
        self.assertEqual(escalated, [("sidecar", "ui", f"Review sidecar pass 7: escalation S-6 (security) on lane ui: The token reaches the log. {where}")])
        self.assertIn(("interactive", "escalation S-6 (security): see the sidecar page"), self.sidecar_events())
        self.assertEqual([item["status"] for item in self.ledger()["messages"]][-1], "delivered")
        # The run's record holds the latest record per lane.
        states = read_json(self.directory / "attention.json")["states"]
        self.assertEqual([(state["kind"], state["node"]) for state in states], [("sidecar", "adapter"), ("sidecar", "ui")])
        self.assert_node_statuses()

    def interrupted_pass(self, findings, messages, escalations=(), deliver=KeyboardInterrupt) -> None:
        """One pass returning this output whose delivery is cut short (a Ctrl-C, or a controller killed while typing)."""
        self.script_steps([*([{}] * len(self.job_calls())), {"output": output(findings, messages, escalations)}])
        with patch("workflow.sidecar.deliver_one", side_effect=deliver), self.assertRaises(KeyboardInterrupt):
            self.run_pass()

    def test_a_delivery_cut_short_loses_no_page_and_repeats_none(self):
        # The 3 Oct OOM, or a Ctrl-C, while a message is typed. What the merge wrote pages before anything is typed: an escalation,
        # a P0/P1 never sent to its lane (adapter's P0 rides only on ui's message) or refused there. An undeliverable one pages as its
        # delivery ends. The one whose message was left pending pages when the next controller records it interrupted. Each once.
        where = f"Read it in {self.directory / 'sidecar.ledger.json'} or on the run's sidecar page."
        self.interrupted_pass([upsert(problem="The ui text is wrong. It says before."),
                               upsert(ref="new-2", lane="adapter", severity="P0", problem="Deletes the database. Always."),
                               upsert(ref="new-3", problem="The ui title is wrong too.")],
                              [message(finding_ids=["new-1", "new-2"]), message(finding_ids=["new-3"], text="And the title.")],
                              [{"finding_id": "new-1", "kind": "security", "text": "The token reaches the log. Rotate it."}])
        self.assertEqual([(item["id"], item["status"], item["reason"]) for item in self.ledger()["messages"]],
                         [("M-1", "pending", None), ("M-2", "refused", "rate_limited")])
        merged = [("sidecar", "adapter", f"Review sidecar pass 1: P0 S-2 on lane adapter did not reach the lane (no message to it): Deletes the database. {where}"),
                  ("sidecar", "ui", f"Review sidecar pass 1: P1 S-3 on lane ui did not reach the lane (refused, rate_limited): The ui title is wrong too. {where}"),
                  ("sidecar", "ui", f"Review sidecar pass 1: escalation S-1 (security) on lane ui: The token reaches the log. {where}")]
        self.assertEqual(self.records(), merged)
        self.assertIn(("interactive", "escalation S-1 (security): see the sidecar page"), self.sidecar_events())
        # The next controller records M-1 interrupted and pages the P1 it carried; a later one pages nothing more.
        interrupted = ("sidecar", "ui", f"Review sidecar pass 1: P1 S-1 on lane ui did not reach the lane (undeliverable, interrupted): "
                                        f"The ui text is wrong. {where}")
        for _ in range(2):
            sidecar.recover(self.runtime, self.clock)
            self.assertEqual(self.records(), [*merged, interrupted])
        # ui's message ends undeliverable (a draft in its pane) and pages at once; adapter's delivery is then cut short, and the next
        # controller pages adapter's P1 only.
        real = sidecar.deliver_one

        def cut_short(runtime, pending, herdr):
            if pending["lane"] == "adapter":
                raise KeyboardInterrupt
            return real(runtime, pending, herdr)
        self.herdr.screens["pane-ui"] = claude_screen("my own draft")
        before = len(self.records())
        self.interrupted_pass([upsert(problem="The ui footer is wrong."), upsert(ref="new-2", lane="adapter", problem="The adapter drops a row.")],
                              [message(), message(lane="adapter", finding_ids=["new-2"])], deliver=cut_short)
        self.assertEqual(self.records()[before:], [
            ("sidecar", "ui", f"Review sidecar pass 2: P1 S-4 on lane ui did not reach the lane (undeliverable, pane_busy): The ui footer is wrong. {where}")])
        sidecar.recover(self.runtime, self.clock)
        self.assertEqual(self.records()[before + 1:], [
            ("sidecar", "adapter", f"Review sidecar pass 2: P1 S-5 on lane adapter did not reach the lane (undeliverable, interrupted): "
                                   f"The adapter drops a row. {where}")])
        self.assertEqual([(item["id"], item["status"], item["reason"]) for item in self.ledger()["messages"][2:]],
                         [("M-3", "undeliverable", "pane_busy"), ("M-4", "undeliverable", "interrupted")])
        validate_schema("sidecar", self.ledger())
        self.assert_node_statuses()

    def test_the_next_controller_pages_only_what_the_interrupted_pass_made_blocking(self):
        # As that delivery would have: the ledger the pass read (its inputs' ledger.json) says which findings it made an open P0/P1.
        # A P1 it only updated, and a P2, carried by the same message, page nothing.
        where = f"Read it in {self.directory / 'sidecar.ledger.json'} or on the run's sidecar page."
        self.assertEqual(self.run_output([upsert()], [message()]), [])  # S-1, a P1 delivered to ui.
        self.interrupted_pass([upsert(finding_id="S-1", evidence="It still says before in b2c3d4e."), upsert(ref="new-1", problem="The ui footer is wrong."),
                               upsert(ref="new-2", severity="P2")], [message(finding_ids=["S-1", "new-1", "new-2"])])
        self.assertEqual(self.records(), [])  # Its one new P1 waits for the message.
        sidecar.recover(self.runtime, self.clock)
        paged = [("sidecar", "ui", f"Review sidecar pass 2: P1 S-2 on lane ui did not reach the lane (undeliverable, interrupted): The ui footer is wrong. {where}")]
        self.assertEqual(self.records(), paged)
        # Its inputs gone (removed by hand, or pruned under a message left pending): a finding with a history entry of that pass counts
        # as new or raised there.
        self.interrupted_pass([upsert(ref="new-1", lane="adapter", problem="The adapter drops a row.")], [message(lane="adapter")])
        (self.directory / "sidecar-inputs" / "3" / "ledger.json").unlink()
        sidecar.recover(self.runtime, self.clock)
        self.assertEqual(self.records(), [*paged, ("sidecar", "adapter", f"Review sidecar pass 3: P1 S-4 on lane adapter did not reach the lane "
                                                                         f"(undeliverable, interrupted): The adapter drops a row. {where}")])


class LedgerLock(SidecarRun):
    """Every ledger write waits for <run>/sidecar.lock: held here by another open file, as `sidecar-pass` or freeze would."""

    def assert_waits_for_the_lock(self, action, reached=lambda: True) -> None:
        """`action` in a thread while the test holds the lock: once `reached`, it neither finishes nor changes the ledger
        until the lock is released; then it does both."""
        before = self.ledger_bytes()
        errors = []

        def run():
            try:
                action()
            except BaseException as error:  # Reported by the test thread.
                errors.append(error)
        with (self.directory / "sidecar.lock").open("a") as handle:
            fcntl.flock(handle, fcntl.LOCK_EX)
            thread = threading.Thread(target=run, daemon=True)
            thread.start()
            try:
                deadline = time.monotonic() + 30
                while not reached():
                    self.assertLess(time.monotonic(), deadline, "the action never reached its ledger write")
                    time.sleep(0.02)
                thread.join(0.5)
                self.assertTrue(thread.is_alive(), "the ledger write did not wait for sidecar.lock")
                self.assertEqual(self.ledger_bytes(), before)
            finally:
                fcntl.flock(handle, fcntl.LOCK_UN)
                thread.join(30)
        self.assertFalse(thread.is_alive())
        self.assertEqual(errors, [])
        self.assertNotEqual(self.ledger_bytes(), before)
        validate_schema("sidecar", self.ledger())

    def test_the_merge_a_delivery_flip_recover_and_close_wait_for_sidecar_lock(self):
        # A pass's merge write: its job has returned its output, and nothing is merged until the lock is free.
        self.script_steps([{"output": output([upsert()], [message()])}])
        stdout = self.directory / "sidecar-1.stdout.json"
        self.assert_waits_for_the_lock(self.run_pass, lambda: stdout.exists() and stdout.read_text().strip())
        self.assertEqual([(item["n"], item["status"]) for item in self.ledger()["passes"]], [(1, "completed")])
        self.assertEqual([(item["id"], item["status"]) for item in self.ledger()["messages"]], [("M-1", "delivered")])
        # A delivery's flip.
        self.assert_waits_for_the_lock(lambda: sidecar.flip(self.directory, self.plan, "M-1", "undeliverable", "interrupted", iso(self.now)))
        self.assertEqual((self.ledger()["messages"][0]["status"], self.ledger()["messages"][0]["reason"]), ("undeliverable", "interrupted"))
        # recover(): the running marker stays until the lock is free, then its pass is recorded interrupted.
        marker = self.directory / "sidecar.running.json"
        save_json(marker, {"pass": 2, "pid": None, "session_id": "s", "started_at": "2026-10-01T12:00:00Z", "trigger": "cadence"})
        self.assert_waits_for_the_lock(lambda: sidecar.recover(self.runtime, self.clock))
        self.assertFalse(marker.exists())
        self.assertEqual((self.ledger()["passes"][-1]["n"], self.ledger()["passes"][-1]["status"]), (2, "interrupted"))
        # close() at freeze.
        self.assert_waits_for_the_lock(lambda: sidecar.close(self.runtime, "freeze", clock=self.clock))
        self.assertIsNotNone(self.ledger()["closed_at"])
        self.assertEqual(self.sidecar_events()[-1][0], "succeeded")


# ---- seam ------------------------------------------------------------------------------------------------------------

class Seam(SidecarRun):
    def test_seam_appendix_b_validates_verbatim_and_three_hand_written_outputs_merge_into_it(self):
        """Scenario seam."""
        example = appendix_b()
        validate_schema("sidecar", example)
        lanes = ["engine", "viewer"]
        plan = {"run_id": "review-sidecar-smoke-001", "sidecar": {"prompt": "x", **SETTINGS}}
        ledger = sidecar.initial_ledger(plan)
        s1 = {"id": None, "ref": "new-1", "category": "defect", "severity": "P1", "lane": "engine", "file": "workflow/sidecar.py", "locator": "merge_output",
              "revision": "a1b2c3d", "problem": example["findings"][0]["problem"], "evidence": example["findings"][0]["history"][0]["evidence"],
              "remedy": example["findings"][0]["remedy"], "disposition": "open", "note": None}
        first = {"summary": example["passes"][0]["summary"], "findings": [s1],
                 "messages": [{"lane": "engine", "finding_ids": ["new-1"], "text": example["messages"][0]["text"]}], "escalations": [], "handoff": None}
        record = {key: example["passes"][0][key] for key in ("n", "trigger", "started_at", "finished_at", "status", "session_id", "lanes")}
        ledger, messages, _ = sidecar.merge(ledger, first, record, lanes, "t1")
        self.assertEqual([(item["id"], item["status"]) for item in messages], [("M-1", "pending")])
        ledger["messages"][0].update(status="delivered", reason=None)  # What the delivery's flip writes.
        ledger["passes"].append({**{key: example["passes"][1][key] for key in ("n", "trigger", "started_at", "finished_at", "status", "lanes")},
                                 "session_id": None, "counts": {"new": 0, "changed": 0, "messages": 0}, "summary": None})  # Pass 2 timed out.
        third = {"summary": example["passes"][2]["summary"],
                 "findings": [{**s1, "id": "S-1", "ref": None, "revision": "b2c3d4e", "evidence": example["findings"][0]["evidence"], "disposition": "fix_reported"},
                              {**{key: example["findings"][1][key] for key in sidecar.FINDING_FIELDS}, "id": None, "ref": "new-1"}],
                 "messages": [{"lane": "viewer", "finding_ids": ["new-1"], "text": example["messages"][1]["text"]}], "escalations": [], "handoff": None}
        record = {key: example["passes"][2][key] for key in ("n", "trigger", "started_at", "finished_at", "status", "session_id", "lanes")}
        ledger, messages, _ = sidecar.merge(ledger, third, record, lanes, "t3", refusal=lambda lane: "question_waiting" if lane == "viewer" else None)
        self.assertEqual([(item["id"], item["status"], item["reason"]) for item in messages], [("M-2", "refused", "question_waiting")])
        validate_schema("sidecar", ledger)

        def timeless(value):
            if isinstance(value, dict):
                return {key: timeless(item) for key, item in value.items() if key not in {"at", "started_at", "finished_at"}}
            return [timeless(item) for item in value] if isinstance(value, list) else value
        self.assertEqual(timeless(ledger), timeless(example))
        # An output that would push the ledger past 4 MiB is rejected (size) and the file stays byte-identical.
        big = sidecar.initial_ledger(self.plan)
        bulk = {**upsert(), "id": None, "problem": "p" * 2000, "remedy": "r" * 2000, "evidence": "e" * 2000}
        while sidecar.ledger_bytes(big) < sidecar.LEDGER_LIMIT - 150_000:
            big, _, _ = sidecar.merge(big, output([{**bulk, "ref": f"new-{k}"} for k in range(1, 31)]),
                                      {"n": len(big["passes"]) + 1, "trigger": "cadence", "started_at": "t", "finished_at": "t", "status": "completed",
                                       "session_id": "s", "lanes": {}}, LANES, "t")
        with sidecar.ledger_lock(self.directory):
            sidecar.save_ledger(self.directory, big)
        before = self.ledger_bytes()
        self.script_steps([{"output": output([{**bulk, "ref": f"new-{k}"} for k in range(1, 31)])}])
        self.assertIsNone(self.run_pass())
        self.assertEqual(self.ledger_bytes(), before)
        self.assertIn("output rejected (size)", self.sidecar_events()[-1][1])


# ---- scheduling ------------------------------------------------------------------------------------------------------

class Scheduling(SidecarRun):
    def scheduler(self):
        return sidecar.Scheduler(self.runtime, LANES, self.clock)

    def test_scheduling_cadence_completion_budget_and_nothing_while_a_pass_runs(self):
        """Scenario scheduling."""
        self.plan["sidecar"]["max_passes"] = 3
        release = self.root / "release-1"
        self.script_steps([{"wait_for": str(release)}])
        scheduler = self.scheduler()
        self.now = 899.0
        self.assertTrue(scheduler.tick([], {}, False))
        self.assertEqual(self.job_calls(), [])
        self.now = 900.0  # Launch (epoch 0) plus the cadence.
        scheduler.tick([], {}, False)
        self.assertEqual(scheduler.current.trigger, "cadence")
        self.assertEqual(self.sidecar_events()[0], ("running", f"Review sidecar pass 1 (cadence) started: one read-only print job, session {scheduler.current.session_id}"))
        self.now = 1400.0  # Inside the pass timeout, and a lane completed: nothing starts while the pass runs.
        for _ in range(3):
            scheduler.tick([], {"ui": {}}, False)
        time.sleep(0.2)
        self.assertEqual(len(self.job_calls()), 1)
        release.write_text("")
        self.wait_job(scheduler)
        scheduler.tick([], {"ui": {}}, False)  # Recorded.
        self.assertEqual([item["status"] for item in self.ledger()["passes"]], ["completed"])
        scheduler.tick([], {"ui": {}}, False)  # ui wrote `completed` since pass 1 started: a completion pass at once.
        self.assertEqual((scheduler.current.trigger, scheduler.current.detail), ("completion", "ui"))
        self.wait_job(scheduler)
        scheduler.tick([], {"ui": {}}, False)
        scheduler.tick([], {"ui": {}}, False)  # ui was reviewed: no second completion pass, and no cadence elapsed.
        self.assertIsNone(scheduler.current)
        self.now += 900
        scheduler.tick([], {"ui": {}}, False)
        self.assertEqual(scheduler.current.trigger, "cadence")
        self.wait_job(scheduler)
        scheduler.tick([], {"ui": {}}, False)
        self.now += 10_000  # max_passes (3) reached: no more cadence passes...
        scheduler.tick([], {"ui": {}}, False)
        self.assertIsNone(scheduler.current)
        self.assertFalse(scheduler.tick([], {"ui": {}, "adapter": {}}, True))  # ...except the final pass.
        self.assertEqual(scheduler.current.trigger, "final")
        self.wait_job(scheduler)
        self.assertTrue(scheduler.tick([], {"ui": {}, "adapter": {}}, True))
        self.assertEqual([(item["n"], item["trigger"], item["status"]) for item in self.ledger()["passes"]],
                         [(1, "cadence", "completed"), (2, "completion", "completed"), (3, "cadence", "completed"), (4, "final", "completed")])
        self.assertEqual(len(self.job_calls()), 4)
        self.assertIn("This is the final pass", self.job_calls()[-1]["prompt"])
        self.assert_node_statuses()

    def test_a_pass_past_its_timeout_is_timed_out_and_the_next_one_runs(self):
        self.script_steps([{"hang": True}])
        scheduler = self.scheduler()
        self.now = 900.0
        scheduler.tick([], {}, False)
        process = scheduler.current.process
        self.wait_logged(1)
        self.now = 900.0 + 599
        scheduler.tick([], {}, False)
        self.assertIsNone(process.poll())
        self.now = 900.0 + 600
        scheduler.tick([], {}, False)
        self.assertIsNotNone(process.poll())
        [record] = self.ledger()["passes"]
        self.assertEqual((record["status"], record["session_id"], record["summary"]), ("timed_out", None, None))
        self.assertIn("timed out after 600s", self.sidecar_events()[-1][1])
        self.now += 900
        scheduler.tick([], {}, False)
        self.wait_job(scheduler)
        scheduler.tick([], {}, False)
        self.assertEqual([item["status"] for item in self.ledger()["passes"]], ["timed_out", "completed"])

    def test_the_last_completion_interrupts_a_running_pass_and_only_the_final_pass_runs(self):
        self.script_steps([{"hang": True}])
        scheduler = self.scheduler()
        self.now = 900.0
        scheduler.tick([], {}, False)
        process = scheduler.current.process
        self.wait_logged(1)
        # The last completion is accepted in the poll that would also start a completion pass: only the final pass runs.
        self.assertFalse(scheduler.tick([], {"ui": {}, "adapter": {}}, True))
        self.assertIsNotNone(process.poll())
        self.assertEqual(scheduler.current.trigger, "final")
        self.wait_job(scheduler)
        self.assertTrue(scheduler.tick([], {"ui": {}, "adapter": {}}, True))
        self.assertEqual([(item["trigger"], item["status"]) for item in self.ledger()["passes"]], [("cadence", "interrupted"), ("final", "completed")])

    def test_handoffs_are_saved_only_after_the_final_pass_while_the_deadlines_keep_being_checked(self):
        release = self.root / "release-final"
        self.script_steps([{"wait_for": str(release)}])
        for lane in LANES:
            self.completion(lane)
        self.states.update(ui="idle", adapter="idle")
        polls = []

        def sleep(_):
            polls.append(self.now)
            self.assertFalse((self.directory / "ui.handoff.json").exists())
            self.now += 1
            time.sleep(0.01)
            if len(polls) == 20:
                release.write_text("")
        wait_handoffs(self.runtime, clock=self.clock, sleep=sleep)
        self.assertGreaterEqual(len(polls), 20)
        self.assertTrue((self.directory / "ui.handoff.json").exists())
        self.assertEqual([(item["trigger"], item["status"]) for item in self.ledger()["passes"]], [("final", "completed")])
        # Again, with a met lane working past the latest lane deadline during the final pass: the deadline still ends the
        # wait, the final pass's job is terminated and nothing is handed off.
        for lane in LANES:
            (self.directory / f"{lane}.handoff.json").unlink()
            (self.directory / f"{lane}.deadline.json").unlink(missing_ok=True)
        save_json(self.directory / "sidecar.ledger.json", sidecar.initial_ledger(self.plan))
        self.script_steps([{"hang": True}] * 5)
        self.calls.unlink()
        jobs = []

        def late(_):
            marker = self.directory / "sidecar.running.json"
            if marker.exists() and read_json(marker).get("pid"):
                jobs.append(read_json(marker)["pid"])
                self.states["ui"] = "working"
                self.now = AUTOMATIC["worker_timeout_seconds"] + 1
            time.sleep(0.01)
        with self.assertRaisesRegex(RuntimeError, "Worker ui deadline exhausted"):
            wait_handoffs(self.runtime, clock=self.clock, sleep=late)
        self.assertTrue(jobs)
        self.assertTrue(sidecar.process_gone(jobs[0]))
        self.assertFalse((self.directory / "ui.handoff.json").exists())
        self.assertTrue((self.directory / "sidecar.running.json").exists())  # Recorded by the next controller or the stop path.

    def test_the_gate_takes_a_fresh_inventory_and_pane_read_per_message(self):
        self.script_steps([{"output": output([upsert(), upsert(ref="new-2", lane="adapter")], [message(), message(lane="adapter", finding_ids=["new-2"])])}])
        self.inventories = 0
        self.run_pass()
        self.assertEqual(self.inventories, 3)  # One for the inputs, one per message.
        self.assertEqual(self.herdr.verbs().count("read"), 4)  # One capture per lane, one gate read per message.
        self.assertEqual(self.herdr.verbs().count("process-info"), 2)
        self.assertEqual([item["status"] for item in self.ledger()["messages"]], ["delivered", "delivered"])


# ---- never-blocks ----------------------------------------------------------------------------------------------------

class NeverBlocks(SidecarRun):
    def wait_with_passes(self, before_final=None) -> None:
        """wait_handoffs over working lanes: the cadence pass runs, then both lanes complete and the final pass runs."""
        def sleep(_):
            marker = self.directory / "sidecar.running.json"
            self.now += 1 if marker.exists() else 300
            if self.ledger()["passes"] or self.now > 3000:
                if before_final:
                    before_final()
                for lane in LANES:
                    self.completion(lane)
                    self.states[lane] = "idle"
            time.sleep(0.01)
        wait_handoffs(self.runtime, clock=self.clock, sleep=sleep)
        self.assertTrue(all((self.directory / f"{lane}.handoff.json").exists() for lane in LANES))
        self.assertFalse(any(node == "controller" and status == "blocked" for node, status, _ in self.events))
        self.assert_node_statuses()

    def test_failed_malformed_foreign_and_interrupted_jobs_are_recorded_and_the_wait_goes_on(self):
        """Scenario never-blocks (job outcomes)."""
        self.script_steps([{"exit": 1}, {"raw": "not json"}, {"session": "someone-else"}, {"output": {"summary": "x"}}])
        for expected in ("failed", "failed", "failed"):
            self.run_pass()
            self.assertEqual(self.ledger()["passes"][-1]["status"], expected)
            self.assertEqual(self.sidecar_events()[-1][0], "interactive")
            self.assertIn("failed (JobFailed)", self.sidecar_events()[-1][1])
        self.assertIsNone(self.run_pass())  # A malformed output is rejected.
        self.assertIn("output rejected (schema)", self.sidecar_events()[-1][1])
        log = (self.directory / "sidecar-1.stderr.log").read_text()
        self.assertIn("JobFailed", log)
        self.assertIn("failed: JobFailed", self.ledger()["passes"][0]["summary"])
        # An interrupted sidecar-pass stops its job and records the pass.
        self.script_steps([{"hang": True}])
        self.calls.unlink()

        def interrupt(_):
            if self.job_calls():
                raise KeyboardInterrupt
            time.sleep(0.02)
        with self.assertRaises(KeyboardInterrupt):
            sidecar.run_pass(self.runtime, "manual", clock=self.clock, sleep=interrupt)
        self.assertEqual(self.ledger()["passes"][-1]["status"], "interrupted")
        self.assertFalse((self.directory / "sidecar.running.json").exists())
        # Every pass of a wait failing still hands off: the cadence pass and the final pass both exit 1.
        self.script_steps([{"exit": 1}] * 3)
        self.calls.unlink()
        save_json(self.directory / "sidecar.ledger.json", sidecar.initial_ledger(self.plan))
        self.wait_with_passes()
        self.assertEqual([item["status"] for item in self.ledger()["passes"][-2:]], ["failed", "failed"])
        self.assertEqual(self.ledger()["passes"][-1]["trigger"], "final")

    def test_injected_errors_record_a_failed_pass_or_an_undeliverable_message_and_never_reach_the_wait(self):
        """Scenario never-blocks (injected errors)."""
        cases = {
            "pane capture": (lambda: self.herdr.fail.update(read=subprocess.CalledProcessError(1, ["herdr"], "", "no such pane")), "CalledProcessError"),
            "git": (lambda: patches.append(patch("workflow.sidecar.lane_git", side_effect=subprocess.CalledProcessError(128, ["git"]))), "CalledProcessError"),
            "job": (lambda: patches.append(patch("workflow.sidecar.popen_claude", side_effect=TransientInfraError("Claude Code unavailable"))), "TransientInfraError"),
            "merge": (lambda: patches.append(patch("workflow.sidecar.merge", side_effect=ZeroDivisionError("a bug"))), "ZeroDivisionError"),
        }
        for name, (inject, error) in cases.items():
            with self.subTest(name=name):
                patches = []
                self.events.clear()
                for lane in LANES:
                    for suffix in ("completion", "handoff", "deadline"):
                        (self.directory / f"{lane}.{suffix}.json").unlink(missing_ok=True)
                    self.states[lane] = "working"
                save_json(self.directory / "sidecar.ledger.json", sidecar.initial_ledger(self.plan))
                inject()
                for item in patches:
                    item.start()
                try:
                    self.wait_with_passes()
                finally:
                    for item in patches:
                        item.stop()
                    self.herdr.fail.clear()
                statuses = [item["status"] for item in self.ledger()["passes"]]
                self.assertEqual(statuses[-2:], ["failed", "failed"], name)
                self.assertTrue(any(f"failed ({error})" in text for _, text in self.sidecar_events()), self.sidecar_events())
                self.assertIn(error, self.ledger()["passes"][-1]["summary"])
        # A Herdr timeout while typing: the message is undeliverable, the wait goes on.
        self.events.clear()
        for lane in LANES:
            for suffix in ("completion", "handoff", "deadline"):
                (self.directory / f"{lane}.{suffix}.json").unlink(missing_ok=True)
            self.states[lane] = "working"
        save_json(self.directory / "sidecar.ledger.json", sidecar.initial_ledger(self.plan))
        self.script_steps([{"output": output([upsert()], [message()])}] * 50)
        self.herdr.fail["send-text"] = subprocess.TimeoutExpired(["herdr"], 15)
        self.wait_with_passes()
        [recorded] = self.ledger()["messages"][:1]
        self.assertEqual((recorded["status"], recorded["reason"]), ("undeliverable", "herdr_timeout"))
        self.assertTrue(any("undeliverable after an error (TimeoutExpired)" in text for _, text in self.sidecar_events()))

    def test_a_lane_git_call_that_hangs_fails_its_pass_and_the_wait_goes_on(self):
        # A FIFO planted at the shared .git's info/exclude blocks `git diff` and `git ls-files` in every lane worktree (Git 2.43).
        # The pass's Git calls run inside wait_handoffs' poll, so unbounded they would hold the whole controller in the worker phase.
        # Bounded, each pass is recorded failed, the wait hands off, and with the FIFO removed (RUNBOOK) the next pass completes.
        exclude = self.repo / ".git" / "info" / "exclude"
        exclude.unlink(missing_ok=True)
        os.mkfifo(exclude)
        errors = []

        def wait():
            try:
                self.wait_with_passes()
            except BaseException as error:  # Reported by the test thread.
                errors.append(error)
        with patch("workflow.sidecar.GIT_TIMEOUT_SECONDS", 1):
            thread = threading.Thread(target=wait, daemon=True)
            thread.start()
            thread.join(30)
            hung = thread.is_alive()
            if hung:  # A failing run leaves Git waiting on the FIFO: move it away and release the reader, so the suite goes on.
                stale = exclude.with_name("exclude.fifo")
                exclude.rename(stale)
                for _ in range(40):
                    with contextlib.suppress(OSError):  # No reader waits on it yet.
                        os.close(os.open(stale, os.O_WRONLY | os.O_NONBLOCK))
                    thread.join(0.5)
                    if not thread.is_alive():
                        break
        self.assertFalse(hung, "a lane Git call of the sidecar waited on the FIFO")
        self.assertEqual(errors, [])
        passes = self.ledger()["passes"]
        self.assertEqual([(item["trigger"], item["status"]) for item in passes], [("cadence", "failed"), ("final", "failed")])
        self.assertTrue(all(item["summary"].startswith("failed: TimeoutExpired: ") for item in passes), passes)
        self.assertEqual([text for status, text in self.sidecar_events() if status == "interactive"], [
            "Review sidecar pass 1 (cadence) failed (TimeoutExpired); the run continues without it, see sidecar-1.stderr.log",
            "Review sidecar pass 2 (final) failed (TimeoutExpired); the run continues without it, see sidecar-2.stderr.log"])
        exclude.unlink()
        self.assertEqual(self.run_pass()["status"], "completed")

    def test_a_controller_interrupted_between_the_merge_and_the_delivery_leaves_pane_and_ledger_agreeing(self):
        self.script_steps([{"output": output([upsert()], [message()])}])
        with patch("workflow.sidecar.deliver_one", side_effect=KeyboardInterrupt), self.assertRaises(KeyboardInterrupt):
            self.run_pass()
        self.assertEqual([(item["id"], item["status"]) for item in self.ledger()["messages"]], [("M-1", "pending")])
        self.assertEqual(self.herdr.typed(), [])
        sidecar.recover(self.runtime, self.clock)  # The next controller.
        [recorded] = self.ledger()["messages"]
        self.assertEqual((recorded["status"], recorded["reason"]), ("undeliverable", "interrupted"))
        self.assertEqual(self.ledger()["findings"][0]["messages"], ["M-1"])
        self.assertIn("recorded undeliverable (interrupted): M-1", self.sidecar_events()[-1][1])

    def test_stale_running_markers_are_recorded_and_only_the_pass_s_own_job_is_killed(self):
        session = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
        own = subprocess.Popen([PY, "-c", "import time; time.sleep(60)", session], start_new_session=True)
        other = subprocess.Popen([PY, "-c", "import time; time.sleep(60)", "unrelated"], start_new_session=True)
        gone = subprocess.Popen([PY, "-c", "pass"])
        gone.wait()
        self.addCleanup(lambda: [process.kill() for process in (own, other) if process.poll() is None])
        for n, pid in enumerate((gone.pid, own.pid, other.pid), 1):
            with self.subTest(pid=pid):
                save_json(self.directory / "sidecar.running.json", {"pass": n, "pid": pid, "session_id": session, "started_at": "2026-10-01T12:00:00Z", "trigger": "cadence"})
                sidecar.recover(self.runtime, self.clock)
                self.assertFalse((self.directory / "sidecar.running.json").exists())
                self.assertEqual((self.ledger()["passes"][-1]["n"], self.ledger()["passes"][-1]["status"]), (n, "interrupted"))
        own.wait(timeout=10)
        self.assertEqual(own.returncode, -signal.SIGTERM)
        self.assertIsNone(other.poll())
        events = [text for _, text in self.sidecar_events()]
        self.assertNotIn("orphaned job was stopped", events[0])
        self.assertIn("orphaned job was stopped", events[1])
        self.assertNotIn("orphaned job was stopped", events[2])

    def test_a_run_stopped_by_its_deadline_closes_the_node_and_escalations_carry_no_model_text(self):
        secret = "MODEL-WRITTEN-SECRET"
        self.script_steps([{"output": output([upsert(problem=f"{secret} problem")], [message(text=f"{secret} message")],
                                             [{"finding_id": "new-1", "kind": "security", "text": f"{secret} escalation"}], summary=f"{secret} summary")},
                           {"hang": True}])
        self.run_pass()
        self.assertIn(("interactive", "escalation S-1 (security): see the sidecar page"), self.sidecar_events())
        self.assertFalse(any(secret in text for _, _, text in self.events))
        # A deadline exhausted while a pass runs: the wait's error path terminates the job, the stop path records the pass and closes the node.
        self.now = AUTOMATIC["worker_timeout_seconds"] - 5
        pids = []

        def sleep(_):
            marker = self.directory / "sidecar.running.json"
            if marker.exists() and read_json(marker).get("pid"):
                pids.append(read_json(marker)["pid"])
                self.now = AUTOMATIC["worker_timeout_seconds"] + 1
            else:
                self.now = max(self.now, 3000.0)
            time.sleep(0.01)
        with self.assertRaisesRegex(RuntimeError, "deadline exhausted"):
            wait_handoffs(self.runtime, clock=self.clock, sleep=sleep)
        self.assertTrue(sidecar.process_gone(pids[0]))
        sidecar.close(self.runtime, "stopped", clock=self.clock)
        ledger = self.ledger()
        self.assertEqual(ledger["passes"][-1]["status"], "interrupted")
        self.assertIsNotNone(ledger["closed_at"])
        self.assertEqual(self.sidecar_events()[-1][0], "succeeded")
        self.assertTrue(self.sidecar_events()[-1][1].startswith("Review sidecar stopped with the run after 2 pass(es)"))
        self.assert_node_statuses()
        validate_schema("sidecar", ledger)


class SidecarGraph(unittest.TestCase):
    """The automatic graph over fake sessions and unit checks, with a sidecar whose job the test scripts."""

    def setUp(self):
        self.build()

    def build(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.repo = self.root / "repo"
        self.repo.mkdir()
        (self.repo / "ui.txt").write_text("before")
        (self.repo / "backend.py").write_text("VALUE = 1\n")
        for args in (["init", "-q"], ["config", "user.name", "Test"], ["config", "user.email", "test@example.invalid"], ["add", "."], ["commit", "-qm", "Base"],
                     ["switch", "-qc", "feature/sidecar-test"]):
            subprocess.run(["git", "-C", str(self.repo), *args], check=True)
        self.directory = self.root / "run"
        plan = prepare(self.directory, self.repo, "HEAD", {"ui": "UI", "adapter": "Backend"}, True)
        policy = two_lane_policy()
        for worker in policy["workers"]:
            worker["checks"][0]["argv"][0] = PY
        plan.update(mode="interactive", policy_sha256=policy_digest(policy), source_branch="feature/sidecar-test", automatic=automatic_settings(),
                    sidecar={"prompt": BRIEF, **SETTINGS})
        save_json(self.directory / "plan.json", plan)
        save_json(self.directory / "policy.json", policy)
        sidecar.write_initial(self.directory, plan)
        self.script = self.root / "job-script.json"
        save_json(self.script, [])
        self.executable = self.root / "fake-claude"
        fake_job(self.executable, self.script, self.root / "job-calls.jsonl")
        self.sessions = FakeSessions(self.directory, plan)
        self.sessions.executable = str(self.executable)
        self.runtime = OfflinePipeline(self.directory, self.sessions)
        with SqliteSaver.from_conn_string(str(self.directory / "pipeline.sqlite")) as saver:
            first = build_pipeline(saver, self.runtime).invoke({"run_id": "run"}, {"configurable": {"thread_id": "run"}})
        self.assertEqual(first["__interrupt__"][0].value["kind"], "worker_handoff")
        for lane in LANES:
            (self.directory / f"{lane}.handoff.json").unlink()  # The fake launch writes one; a real worker's comes from wait_handoffs.
            save_json(self.directory / f"{lane}.completion.json", {"version": "1.0.0", "run_id": "run", "node_id": lane,
                                                                  "launch_token": plan["nodes"][lane]["session_id"], "status": "completed",
                                                                  "summary": f"{lane} done", "open_assumptions": []})

    def events(self) -> list:
        return [json.loads(line) for line in (self.directory / "events.jsonl").read_text().splitlines()]

    def test_never_blocks_a_run_whose_every_pass_fails_reaches_its_verified_branch(self):
        """Scenario never-blocks (the verified branch) and freeze (the closing event)."""
        save_json(self.script, [{"exit": 1}])
        with patch("workflow.sidecar.merge", side_effect=AssertionError("never reached")):
            commit = drive(self.runtime)
        self.assertEqual(git(self.repo, "rev-parse", "HEAD"), commit)
        events = self.events()
        statuses = [(event["status"], event["message"]) for event in events if event["node"] == "sidecar"]
        self.assertEqual([status for status, _ in statuses], ["running", "interactive", "succeeded"])
        self.assertIn("failed (JobFailed)", statuses[1][1])
        self.assertEqual(statuses[2][1], "Review sidecar closed at freeze: 1 pass(es) (1 not completed), 0 open finding(s) (0 P0/P1), "
                                         "0 verified resolved, 0 message(s) delivered; final pass recorded")
        self.assertFalse(any(event["node"] == "controller" and event["status"] == "blocked" for event in events))
        sequence = [event["node"] for event in events]
        self.assertLess(sequence.index("sidecar"), next(index for index, event in enumerate(events) if event["node"] == "freeze"))
        exported = read_json(self.directory / "run-state.json")
        self.assertEqual(exported["version"], "1.6.0")
        self.assertEqual(exported["sidecar"]["passes"][0]["status"], "failed")
        self.assertIsNotNone(exported["sidecar"]["closed_at"])
        validate_schema("sidecar", exported["sidecar"])

    def test_never_blocks_each_injected_error_records_its_failure_and_the_run_reaches_its_verified_branch(self):
        """Scenario never-blocks: Herdr refusing the capture, Herdr timing out while typing, Git failing on the inputs, Claude Code
        unavailable for the job and a bug in the merge, each in a cadence pass (with a message to ui) and in the final pass."""
        from . import automatic
        real_wait = automatic.wait_handoffs
        cases = {
            "capture": (lambda herdr: herdr.fail.update(read=subprocess.CalledProcessError(1, ["herdr"], "", "no such pane")), None, "CalledProcessError"),
            "delivery": (lambda herdr: herdr.fail.update({"send-text": subprocess.TimeoutExpired(["herdr"], 15)}), None, None),
            "git": (None, patch("workflow.sidecar.lane_git", side_effect=subprocess.CalledProcessError(128, ["git", "diff"])), "CalledProcessError"),
            "job": (None, patch("workflow.sidecar.popen_claude", side_effect=TransientInfraError("Claude Code unavailable")), "TransientInfraError"),
            "merge": (None, patch("workflow.sidecar.merge", side_effect=ZeroDivisionError("a bug in the merge")), "ZeroDivisionError"),
        }
        for name, (herdr_failure, injected, error) in cases.items():
            with self.subTest(name=name):
                if name != "capture":
                    self.build()
                save_json(self.script, [{"output": output([upsert()], [message()])}] * 3)
                save_json(self.directory / "terminals.json", {lane: {"pane_id": f"pane-{lane}", "tab_id": "t", "mode": "attach_requested"} for lane in LANES})
                for lane in LANES:
                    os.rename(self.directory / f"{lane}.completion.json", self.directory / f"{lane}.completion.later")
                self.sessions.reviewer_states.update(ui="working", adapter="working")
                herdr = FakeHerdr(self.directory, self.sessions.background_id)
                if herdr_failure:
                    herdr_failure(herdr)
                now = [time.time()]

                def sleep(_):
                    running = (self.directory / "sidecar.running.json").exists()
                    now[0] += 1 if running else 400
                    if (self.directory / "sidecar.ledger.json").exists() and read_json(self.directory / "sidecar.ledger.json")["passes"]:
                        for lane in LANES:
                            later = self.directory / f"{lane}.completion.later"
                            if later.exists():
                                os.rename(later, self.directory / f"{lane}.completion.json")
                        self.sessions.reviewer_states.update(ui="idle", adapter="idle")
                    time.sleep(0.01)
                with contextlib.ExitStack() as stack:
                    stack.enter_context(patch.dict(os.environ, {"HERDR_ENV": "1"}))
                    stack.enter_context(patch("workflow.herdr.subprocess.run", side_effect=herdr.run))
                    stack.enter_context(patch("workflow.automatic.wait_handoffs", side_effect=lambda runtime: real_wait(runtime, clock=lambda: now[0], sleep=sleep)))
                    if injected:
                        stack.enter_context(injected)
                    commit = drive(self.runtime)
                self.assertEqual(git(self.repo, "rev-parse", "HEAD"), commit)
                events = self.events()
                self.assertFalse([event for event in events if event["status"] == "blocked"], name)
                sidecar_events = [(event["status"], event["message"]) for event in events if event["node"] == "sidecar"]
                self.assertLessEqual({status for status, _ in sidecar_events}, {"running", "interactive", "succeeded"})
                self.assertEqual(sidecar_events[-1][0], "succeeded")
                # Freeze stopped the workers only after the final pass; nothing stopped them before.
                stops = [index for index, event in enumerate(events) if event["status"] == "stopped" and event["node"] == "freeze"]
                self.assertEqual(len(stops), 1)
                self.assertLess(max(index for index, event in enumerate(events) if event["node"] == "sidecar"
                                    and event["status"] != "succeeded"), stops[0])
                ledger = read_json(self.directory / "sidecar.ledger.json")
                self.assertEqual([item["trigger"] for item in ledger["passes"]], ["cadence", "final"])
                if error:
                    self.assertEqual([item["status"] for item in ledger["passes"]], ["failed", "failed"])
                    self.assertTrue(all(error in item["summary"] for item in ledger["passes"]))
                    self.assertEqual(sum(f"failed ({error})" in text for _, text in sidecar_events), 2)
                else:
                    self.assertEqual([item["status"] for item in ledger["passes"]], ["completed", "completed"])
                    self.assertEqual([(item["lane"], item["status"], item["reason"]) for item in ledger["messages"]],
                                     [("ui", "undeliverable", "herdr_timeout"), ("ui", "refused", "lane_finished")])
                    self.assertTrue(any("undeliverable after an error (TimeoutExpired)" in text for _, text in sidecar_events))
                self.assertIsNotNone(ledger["closed_at"])

    def test_a_controller_interrupt_while_a_pass_runs_terminates_its_process_group_and_writes_nothing_for_the_sidecar(self):
        """Ctrl-C, or Claude Code unavailable (the resumable TransientInfraError), inside wait_handoffs while a pass's job runs:
        drive() leaves the workers running, the job and its child are gone, and the sidecar gets no event, no record and no close."""
        from . import automatic
        real_wait = automatic.wait_handoffs
        for interrupt in (KeyboardInterrupt(), TransientInfraError("Claude Code unavailable")):
            with self.subTest(interrupt=type(interrupt).__name__):
                self.build()
                child = self.root / "child.pid"
                save_json(self.script, [{"child": str(child), "hang": True}])
                for lane in LANES:
                    os.rename(self.directory / f"{lane}.completion.json", self.directory / f"{lane}.completion.later")
                self.sessions.reviewer_states.update(ui="working", adapter="working")
                ledger = (self.directory / "sidecar.ledger.json").read_bytes()
                now, pids = [time.time()], []

                def sleep(_):
                    marker = self.directory / "sidecar.running.json"
                    pid = read_json(marker).get("pid") if marker.exists() else None
                    if pid and child.exists() and child.read_text():
                        pids.extend([pid, int(child.read_text())])
                        for item in pids[-2:]:  # Only if this test fails: never leave the sleepers behind.
                            self.addCleanup(kill_quietly, item)
                        raise interrupt
                    now[0] += 1 if marker.exists() else 400
                    time.sleep(0.01)
                with contextlib.ExitStack() as stack:
                    stack.enter_context(patch.dict(os.environ, {"HERDR_ENV": ""}))
                    stack.enter_context(patch("workflow.automatic.wait_handoffs", side_effect=lambda runtime: real_wait(runtime, clock=lambda: now[0], sleep=sleep)))
                    with self.assertRaises(type(interrupt)):
                        drive(self.runtime)
                self.assertEqual(len(pids), 2)
                for pid in pids:  # The job and the child in its process group.
                    deadline = time.monotonic() + 10
                    while not sidecar.process_gone(pid):
                        self.assertLess(time.monotonic(), deadline, f"process {pid} of the pass survived the interrupt")
                        time.sleep(0.02)
                events = self.events()
                sidecar_events = [(event["status"], event["message"]) for event in events if event["node"] == "sidecar"]
                self.assertEqual([status for status, _ in sidecar_events], ["running"])  # Pass 1's start, before the interrupt.
                self.assertTrue(sidecar_events[0][1].startswith("Review sidecar pass 1 (cadence) started"))
                self.assertEqual(events[-1]["node"], "controller")
                self.assertEqual(events[-1]["status"], "interrupted")
                self.assertFalse([event for event in events if event["status"] in {"blocked", "stopped"}])
                self.assertEqual((self.directory / "sidecar.ledger.json").read_bytes(), ledger)  # No pass, no message, no closed_at.
                self.assertTrue((self.directory / "sidecar.running.json").exists())  # The next controller records the pass.
                self.assertFalse(any((self.directory / f"{lane}.stop.json").exists() for lane in LANES))

    def test_a_run_stopped_before_freeze_closes_the_sidecar_with_succeeded(self):
        with patch("workflow.automatic.lane_deadline", return_value=0.0), self.assertRaisesRegex(RuntimeError, "deadline exhausted"):
            for lane in LANES:
                (self.directory / f"{lane}.completion.json").unlink()
            drive(self.runtime)
        events = [(event["node"], event["status"], event["message"]) for event in self.events()]
        sidecar_events = [event for event in events if event[0] == "sidecar"]
        self.assertEqual([status for _, status, _ in sidecar_events], ["succeeded"])
        self.assertTrue(sidecar_events[0][2].startswith("Review sidecar stopped with the run after 0 pass(es)"))
        self.assertLess(events.index(next(event for event in events if event[:2] == ("controller", "blocked"))), events.index(sidecar_events[0]))
        self.assertIsNotNone(read_json(self.directory / "sidecar.ledger.json")["closed_at"])


# ---- freeze ----------------------------------------------------------------------------------------------------------

class Freeze(SidecarRun):
    def test_freeze_closes_the_node_once_says_no_final_pass_and_refuses_later_passes(self):
        """Scenario freeze."""
        self.run_pass()
        sidecar.close(self.runtime, "freeze", clock=self.clock)
        self.assertEqual(self.sidecar_events()[-1], ("succeeded", "Review sidecar closed at freeze: 1 pass(es) (0 not completed), 0 open finding(s) "
                                                                  "(0 P0/P1), 0 verified resolved, 0 message(s) delivered; no final pass"))
        closed_at = self.ledger()["closed_at"]
        self.assertEqual(closed_at, iso(self.now))
        sidecar.close(self.runtime, "freeze", clock=self.clock)
        self.assertEqual(len([event for event in self.sidecar_events() if event[0] == "succeeded"]), 1)
        output_, code = self.pass_cli()
        self.assertEqual(code, 1)
        self.assertIn("The run is frozen", output_)
        # A run without a sidecar: nothing is recorded, and sidecar-pass is refused.
        plan = {key: value for key, value in self.plan.items() if key != "sidecar"}
        save_json(self.directory / "plan.json", plan)
        self.events.clear()
        sidecar.close(SimpleNamespace(**{**vars(self.runtime), "plan": plan}), "freeze")
        self.assertEqual(self.events, [])
        output_, code = self.pass_cli()
        self.assertIn("This run has no review sidecar", output_)

    def pass_cli(self, *argv) -> tuple[str, int]:
        buffer = io.StringIO()
        with patch("workflow.pipeline.InteractiveSessions", side_effect=lambda directory, timeout: self.sessions), \
                contextlib.redirect_stdout(buffer), contextlib.redirect_stderr(buffer):
            try:
                sidecar.pass_main([str(self.directory), *argv])
                code = 0
            except SystemExit as exit_:
                code = exit_.code
        return buffer.getvalue(), code

    def test_sidecar_pass_runs_a_manual_and_a_final_pass_and_refuses_past_the_budget(self):
        self.plan["sidecar"]["max_passes"] = 1
        save_json(self.directory / "plan.json", self.plan)
        self.script_steps([{}, {"output": output(handoff={"unresolved": ["S-1 stays open"], "structural": [], "verified_resolved": [], "withdrawn": [], "gaps": ["No browser run"]})}])
        output_, code = self.pass_cli()
        self.assertEqual(code, 0, output_)
        self.assertIn("Pass 1 (manual) completed", output_)
        output_, code = self.pass_cli()
        self.assertEqual(code, 1)
        self.assertIn("max_passes (1) reached; only the final pass (--final) may run", output_)
        output_, code = self.pass_cli("--final")
        self.assertEqual(code, 0, output_)
        ledger = self.ledger()
        self.assertEqual(ledger["handoff"]["gaps"], ["No browser run"])
        self.assertEqual([item["trigger"] for item in ledger["passes"]], ["manual", "final"])
        output_, code = self.pass_cli("--final")
        self.assertIn("The final pass is already recorded", output_)


class ExportsAndPrompt(SidecarRun):
    def test_export_1_6_0_carries_the_ledger_and_null_without_a_sidecar(self):
        """Scenario freeze (export)."""
        self.script_steps([{"output": output([upsert()])}])
        self.run_pass()
        exported = export_run(ExportRuntime(self.directory))
        self.assertEqual(exported["version"], "1.6.0")
        self.assertEqual(exported["sidecar"], self.ledger())
        self.assertEqual([node["node_id"] for node in exported["definition"]["nodes"]][:2], ["sidecar", "launch_ui"])
        # A ledger that fails its schema is not evidence: null, never guessed.
        broken = self.ledger()
        broken["findings"][0]["severity"] = "P3"
        save_json(self.directory / "sidecar.ledger.json", broken)
        self.assertIsNone(export_run(ExportRuntime(self.directory))["sidecar"])
        plan = {key: value for key, value in self.plan.items() if key != "sidecar"}
        save_json(self.directory / "plan.json", plan)
        exported = export_run(ExportRuntime(self.directory))
        self.assertIsNone(exported["sidecar"])
        self.assertNotIn("sidecar", [node["node_id"] for node in exported["definition"]["nodes"]])

    def test_worker_prompt_holds_the_sidecar_paragraph_only_when_the_plan_has_a_sidecar(self):
        """Scenario worker-prompt."""
        with_sidecar = worker_prompt(self.directory, self.plan, "ui")
        self.assertIn("prefixed `[Review sidecar S-n]`", with_sidecar)
        self.assertIn("never stop or wait for the sidecar", with_sidecar)
        self.assertLess(with_sidecar.index("Review sidecar:"), with_sidecar.index("AUTOMATIC MODE"))
        plan = {key: value for key, value in self.plan.items() if key != "sidecar"}
        without = worker_prompt(self.directory, plan, "ui")
        self.assertNotIn("Review sidecar", without)
        self.assertEqual(with_sidecar.replace(SIDECAR_NOTE, ""), without)


class Notes(SidecarRun):
    """C17: `workflow note` types `[Note from the <actor> N-k]` through the sidecar's gate (sidecar.deliver_text), on the record."""

    def note(self, text="Hold the tests: the host is short of memory.", actor="operator", lane="ui"):
        from .notes import send_note
        self.herdr.calls.clear()
        return send_note(self.runtime, lane, actor, text, clock=self.clock)

    def notes(self, lane="ui") -> list:
        path = self.directory / f"{lane}.notes.json"
        return read_json(path)["notes"] if path.exists() else []

    def test_a_note_is_recorded_typed_with_its_author_and_said_once_on_the_timeline(self):
        with patch.dict(os.environ, {"CLAUDECODE": "1"}):
            entry = self.note("Keep the old\nlabel.")
        self.assertEqual(self.herdr.typed(), ["[Note from the operator N-1] Keep the old label."])
        self.assertEqual(self.herdr.verbs()[-2:], ["send-text", "send-keys"])
        self.assertEqual(self.notes(), [{"n": 1, "id": "N-1", "author": "operator", "via": "claude-code", "text": "Keep the old\nlabel.",
                                         "sent_at": iso(self.now), "delivery": "delivered", "reason": None}])
        self.assertEqual(entry, self.notes()[0])
        self.assertEqual(self.events, [("ui", "note", "Note N-1 from the operator (via a Claude Code session) to worker ui: typed into its pane")])
        with patch.dict(os.environ, {"CLAUDECODE": ""}):
            self.note("Run the unit tests first.", actor="maintainer")
        self.assertEqual(self.herdr.typed(), ["[Note from the maintainer N-2] Run the unit tests first."])
        self.assertEqual([(item["id"], item["author"], "via" in item) for item in self.notes()], [("N-1", "operator", True), ("N-2", "maintainer", False)])
        # Not a sidecar message: the ledger holds none.
        self.assertEqual(self.ledger()["messages"], [])

    def test_a_note_keeps_the_sidecars_refusals(self):
        """Refused (nothing recorded or typed): a waiting question, a finished lane, a lane not launched, a frozen run.
        Undeliverable (recorded, nothing typed): a pane not attached to the session, a non-empty input line."""
        save_json(self.directory / "ui.questions.json", {"node_id": "ui", "questions": [{"n": 1, "question": "A or B?", "asked_at": "x", "answer": None, "answered_at": None}]})
        with self.assertRaisesRegex(ValueError, r"A note to ui is refused \(question_waiting\); nothing was recorded or typed; answer its question"):
            self.note()
        (self.directory / "ui.questions.json").unlink()
        self.completion("adapter")
        with self.assertRaisesRegex(ValueError, r"refused \(lane_finished\)"):
            self.note(lane="adapter")
        (self.directory / "adapter.completion.json").unlink()
        os.rename(self.directory / "ui.interactive.json", self.directory / "ui.interactive.bak")
        with self.assertRaisesRegex(ValueError, r"refused \(lane_not_launched\)"):
            self.note()
        os.rename(self.directory / "ui.interactive.bak", self.directory / "ui.interactive.json")
        (self.directory / "snapshots.json").write_text("{}")
        with self.assertRaisesRegex(ValueError, r"refused \(after_freeze\)"):
            self.note()
        (self.directory / "snapshots.json").unlink()
        with self.assertRaisesRegex(ValueError, "not a lane of this run"):
            self.note(lane="nope")
        self.assertEqual((self.notes(), self.notes("adapter"), self.events, self.herdr.typed()), ([], [], [], []))
        self.herdr.processes["pane-ui"] = pane_process_info("pane-ui")
        self.assertEqual((self.note()["delivery"], self.notes()[-1]["reason"]), ("undeliverable", "pane_not_attached"))
        del self.herdr.processes["pane-ui"]
        self.herdr.screens["pane-ui"] = claude_screen("my own draft")
        self.assertEqual((self.note()["delivery"], self.notes()[-1]["reason"]), ("undeliverable", "pane_busy"))
        self.assertEqual(self.herdr.typed(), [])
        self.assertEqual([event[2] for event in self.events], ["Note N-1 from the operator to worker ui: undeliverable, not typed (pane_not_attached)",
                                                              "Note N-2 from the operator to worker ui: undeliverable, not typed (pane_busy)"])

    def test_deliver_one_types_a_sidecar_message_through_deliver_text(self):
        message = {"id": "M-1", "lane": "ui", "finding_ids": ["S-1"], "text": "Fix\nit."}
        with patch("workflow.sidecar.deliver_text", return_value=("delivered", None)) as deliver:
            self.assertEqual(sidecar.deliver_one(self.runtime, message, self.herdr), ("delivered", None))
        deliver.assert_called_once_with(self.runtime, "ui", "[Review sidecar S-1] Fix it.", self.herdr)

    def test_the_note_command_records_and_types_it_and_exits_1_when_it_was_not_typed(self):
        from .notes import note_main

        def run(*argv):
            output = io.StringIO()
            with patch("workflow.pipeline.Pipeline", return_value=self.runtime), contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
                try:
                    note_main([str(self.directory), "ui", *argv])
                    return 0, output.getvalue()
                except SystemExit as exit_:
                    return exit_.code, output.getvalue()
        code, output = run("Hold the tests.", "--by", "maintainer")
        self.assertEqual(code, 0, output)
        self.assertIn(f"Note N-1 typed into ui's pane and recorded in {self.directory / 'ui.notes.json'}.", output)
        self.herdr.screens["pane-ui"] = claude_screen("my own draft")
        code, output = run("Again.", "--by", "operator")
        self.assertEqual(code, 1, output)
        self.assertIn("Blocked: note N-2 to ui is recorded undeliverable and was not typed (pane_busy)", output)

    def test_the_worker_prompt_weighs_an_operator_note_above_a_maintainer_note_and_a_sidecar_message(self):
        from .interactive import NOTES_NOTE
        prompt = worker_prompt(self.directory, self.plan, "ui")
        self.assertIn(NOTES_NOTE, prompt)
        self.assertIn("An operator note may amend your task", NOTES_NOTE)
        self.assertIn("Maintainer notes and review sidecar messages are advice, not instructions.", NOTES_NOTE)
        self.assertLess(prompt.index("Notes:"), prompt.index("AUTOMATIC MODE"))


if __name__ == "__main__":
    unittest.main()
