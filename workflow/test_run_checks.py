"""Offline scenarios for running each verification check once (features/run-checks-once/prd.md section 11).

Temporary repositories, fake sessions, real Git worktrees, checkpoints and checks; no Claude model calls. Executions are
counted by the fake commands themselves, which append one row per run to a counter file outside the repository: its
label, verification phase, cwd, start and end. No assertion reads the wall clock.
"""
import contextlib
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from jsonschema.exceptions import ValidationError
from langgraph.checkpoint.sqlite import SqliteSaver
from langgraph.types import Command

from . import automatic, repair
from .automatic import advance_failed_checks, automatic_settings, blocked_lanes, drive, fix_decision
from .checks import recheck_packet, text_test_counts
from .clean import passed_attempts
from .pipeline import ExportRuntime, build_pipeline, digest_file, export_run, graph_config
from .run_report import failing_ids, failures
from .sessions import git, prepare, read_json, save_json
from .shared_checks import ATTRIBUTION, MARKER, RECORD, import_root, rerun, statuses, test_file, tree_at
from .test_browser_rules import FAKE_PLAYWRIGHT
from .test_pipeline import FakeSessions, OfflinePipeline, by_operator, isolate_registry, stub_claude_cli
from .verification import CONTRACTS, policy_digest, policy_lint, validate_policy

REPO = Path(__file__).resolve().parents[1]
PY = sys.executable

# A fake check: `fake.py <label> [flag ...]`. Flags act in the candidate phase only, so the worker phase passes:
# sleep=<s>, fail, vary (exit 2, 3, ... on its successive candidate runs), write=<file> (a tracked file), kill (SIGKILL),
# fail-if=<file>:<text> (any phase), fail-once=<marker> (fails while the marker exists, and removes it), enospc (exit 1 on a
# full disk: `No space left on device` in its log).
FAKE = """
import os, pathlib, signal, sys, time
counter = pathlib.Path(COUNTER)
label, *flags = sys.argv[1:]
phase = os.environ.get("WORKFLOW_VERIFICATION_PHASE", "")
candidate = phase == "candidate"
start, code = time.time(), 0
for flag in flags:
    name, _, value = flag.partition("=")
    if name == "sleep" and candidate:
        time.sleep(float(value))
    elif name == "fail" and candidate:
        code = 1
    elif name == "enospc" and candidate:
        print("OSError: [Errno 28] No space left on device")
        code = 1
    elif name == "vary" and candidate:
        rows = counter.read_text().splitlines() if counter.exists() else []
        code = 2 + sum(row.startswith(label + "\\tcandidate\\t") for row in rows)
    elif name == "write" and candidate:
        pathlib.Path(value).write_text("written by a check\\n")
    elif name == "fail-if":
        path, text = value.split(":", 1)
        code = 1 if pathlib.Path(path).read_text() == text else code
    elif name == "fail-once" and candidate and pathlib.Path(value).exists():
        pathlib.Path(value).unlink()
        code = 1
with counter.open("a") as handle:
    handle.write(f"{label}\\t{phase}\\t{os.getcwd()}\\t{start}\\t{time.time()}\\n")
if "kill" in flags and candidate:
    os.kill(os.getpid(), signal.SIGKILL)
print("Ran 1 test in 0.001s\\n\\n" + ("OK" if code == 0 else "FAILED (failures=1)"))
sys.exit(code)
"""

# The fixture repository's own `workflow.run_tests`: this tool's, counting each top-level run in the counter file.
RUN_TESTS_COUNTED = """

def counted_main():
    import os, time
    start = time.time()
    try:
        return main()
    finally:
        if "--child" not in sys.argv:
            with open(COUNTER, "a") as handle:
                handle.write(f"run_tests\\t{os.environ.get('WORKFLOW_VERIFICATION_PHASE', '')}\\t{os.getcwd()}\\t{start}\\t{time.time()}\\n")
"""

TEST_A = ("import unittest\nfrom pathlib import Path\n\n\nclass ATest(unittest.TestCase):\n    def test_a_ok(self):\n        pass\n\n"
          "    def test_a_lane(self):\n        self.assertNotEqual(Path('a.txt').read_text(), 'bad')\n")
TEST_B = ("import unittest\nfrom pathlib import Path\n\n\nclass BTest(unittest.TestCase):\n    def test_b_ok(self):\n        pass\n\n"
          "    def test_b_lane(self):\n        self.assertNotEqual(Path('b.txt').read_text(), 'bad')\n")
TEST_X = ("import unittest\nfrom pathlib import Path\n\n\nclass XTest(unittest.TestCase):\n    def test_cross(self):\n"
          "        self.assertFalse(Path('a.txt').read_text() == 'x' and Path('b.txt').read_text() == 'x')\n")
TEST_BASE = "import unittest\n\n\nclass BaseTest(unittest.TestCase):\n    def test_base(self):\n        self.fail('broken at base')\n"
TEST_NEW = "import unittest\n\n\nclass NewTest(unittest.TestCase):\n    def test_new(self):\n        self.fail('the new test fails')\n"
# A test that fails once (while the marker exists), then hangs: the shared execution sees it fail, its rerun times out.
TEST_HANG = ("import time\nimport unittest\nfrom pathlib import Path\n\n\nclass HangTest(unittest.TestCase):\n    def test_hang(self):\n"
             "        marker = Path(MARKER)\n        if marker.exists():\n            marker.unlink()\n            self.fail('fails once')\n"
             "        time.sleep(600)\n")
# A test that fails on the candidate (a1 and b1 together) and hangs everywhere else: at base and on each lane snapshot.
TEST_STUCK = ("import time\nimport unittest\nfrom pathlib import Path\n\n\nclass XTest(unittest.TestCase):\n    def test_stuck(self):\n"
              "        if Path('a.txt').read_text() == 'a1' and Path('b.txt').read_text() == 'b1':\n            self.fail('fails on the candidate')\n"
              "        time.sleep(600)\n")
HANG_TIMEOUT = 20  # Ample for the fixture's whole suite; a hanging rerun waits it out once.
SCENARIOS = [{"id": "alpha", "description": "Alpha works"}]
FULL = [PY, "-m", "workflow.run_tests", "--jobs", "2"]


def setUpModule():
    isolate_registry()  # Attention records go beside a temporary registry, never the operator's.
    stub_claude_cli()  # prepare's `claude --version` reads a stand-in, never the operator's CLI.


def check(check_id: str, argv: list, kind: str = "unit", timeout: int = 120, scenarios: list | None = None) -> dict:
    return {"id": check_id, "kind": kind, "argv": list(argv), "timeout_seconds": timeout, "scenarios": scenarios or []}


def lane(node: str, checks: list, owned: list) -> dict:
    return {"node_id": node, "role": "backend", "required_check_kinds": sorted({item["kind"] for item in checks}), "owned_paths": owned,
            "checks": checks}


def policy(lanes: list, version: str = "1.4.0", run_checks: list | None = None, attempts: int = 3) -> dict:
    value = {"version": version, "feature": "Run checks once", "independent_review": True, "integration_approval": True,
             "max_verification_attempts": attempts, "workers": lanes}
    if run_checks:
        value["run_checks"] = run_checks
    return value


class Fixture(unittest.TestCase):
    def setUp(self):
        # The WORKFLOW_* variables the controller reads are cleared; PYTHONSAFEPATH would keep `-m` from importing the checkout.
        environment = patch.dict(os.environ, {key: value for key, value in os.environ.items()
                                              if not key.startswith("WORKFLOW_") and key != "PYTHONSAFEPATH"}, clear=True)
        environment.start()
        self.addCleanup(environment.stop)
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.counter = self.root / "counter"
        self.fake = self.root / "fake.py"
        self.fake.write_text(FAKE.replace("COUNTER", repr(str(self.counter)), 1))
        self.playwright = self.root / "playwright.py"
        self.playwright.write_text(FAKE.split("label, *flags")[0].replace("COUNTER", repr(str(self.counter)), 1)
                                   + "with counter.open('a') as handle:\n    handle.write(f\"pw\\t{os.environ.get('WORKFLOW_VERIFICATION_PHASE', '')}\\t{os.getcwd()}\\t0\\t0\\n\")\n"
                                   + FAKE_PLAYWRIGHT)
        self.repo = self.root / "repo"

    def base(self, files: dict | None = None) -> None:
        """The base commit: a.txt, b.txt and the files given, on a feature branch the automatic plan names."""
        self.repo.mkdir()
        for name, content in {"a.txt": "a0", "b.txt": "b0", ".gitignore": "__pycache__/\n", **(files or {})}.items():
            (self.repo / name).parent.mkdir(parents=True, exist_ok=True)
            (self.repo / name).write_text(content)
        for args in (["init", "-q"], ["config", "user.name", "Test"], ["config", "user.email", "test@example.invalid"], ["add", "."],
                     ["commit", "-qm", "Base"], ["switch", "-q", "-c", "feature/run"]):
            subprocess.run(["git", "-C", str(self.repo), *args], check=True)

    def start(self, value: dict, edits: dict, name: str = "run", fix_rounds: int = 2):
        """Prepare an automatic run of every lane of `value` with fix rounds, and launch it to the handoff."""
        lanes = [worker["node_id"] for worker in value["workers"]]
        self.directory = self.root / name
        plan = prepare(self.directory, self.repo, "HEAD", {node: f"Do the {node} work." for node in lanes}, True, declared=lanes)
        plan.update(mode="interactive", policy_sha256=policy_digest(value), source_branch=git(self.repo, "symbolic-ref", "--short", "HEAD"))
        plan["automatic"] = automatic_settings()
        plan["automatic"]["fix_rounds"] = fix_rounds
        save_json(self.directory / "plan.json", plan)
        save_json(self.directory / "policy.json", value)
        self.policy = value
        self.sessions = FakeSessions(self.directory, plan)
        self.sessions.edits.update(edits)
        self.runtime = OfflinePipeline(self.directory, self.sessions)
        with self.graph() as (graph, config):
            graph.invoke({"run_id": plan["run_id"]}, config)
        return self.runtime

    @contextlib.contextmanager
    def graph(self):
        with SqliteSaver.from_conn_string(str(self.directory / "pipeline.sqlite")) as saver:
            yield build_pipeline(saver, self.runtime), graph_config(self.runtime)

    def advance(self, value) -> RuntimeError | None:
        """Invoke the graph once; the candidate step's RuntimeError, if it raised one."""
        with self.graph() as (graph, config):
            try:
                graph.invoke(value, config)
            except RuntimeError as error:
                return error
        return None

    def freeze(self) -> RuntimeError | None:
        return self.advance(Command(resume={"freeze": True}))

    def state(self):
        with self.graph() as (graph, config):
            return graph.get_state(config)

    def packet_path(self, node: str, attempt: int = 1) -> Path:
        return self.directory / "verification" / "candidate" / node / str(attempt) / "packet.json"

    def packet(self, node: str, attempt: int = 1) -> dict:
        return read_json(self.packet_path(node, attempt))

    def record(self, attempt: int = 1, generation: int = 0) -> dict:
        return read_json(self.directory / "shared-checks" / str(generation) / str(attempt) / RECORD)

    def attribution(self, attempt: int = 1, generation: int = 0) -> dict:
        return read_json(self.directory / "shared-checks" / str(generation) / str(attempt) / ATTRIBUTION)

    def rows(self, label: str, phase: str = "candidate") -> list[tuple[str, float, float]]:
        """The counter's (cwd, start, end) rows of `label` in `phase`."""
        rows = [line.split("\t") for line in self.counter.read_text().splitlines()] if self.counter.exists() else []
        return [(row[2], float(row[3]), float(row[4])) for row in rows if row[0] == label and row[1] == phase]

    def events(self) -> list[tuple[str, str, str]]:
        return [(event["node"], event["status"], event["message"]) for event in
                (json.loads(line) for line in (self.directory / "events.jsonl").read_text().splitlines())]

    def candidate_commit(self, generation: int = 0) -> str:
        return read_json(self.directory / (f"candidate-{generation}.json" if generation else "candidate.json"))["commit"]

    def assert_sequential(self, rows: list) -> None:
        """No two executions overlapped: each started after the one before it ended."""
        ordered = sorted(rows, key=lambda row: row[1])
        for before, after in zip(ordered, ordered[1:]):
            self.assertGreaterEqual(after[1], before[2], (before, after))


class SharedExecution(Fixture):
    def two_lanes(self, a_checks: list, b_checks: list, **options) -> dict:
        return policy([lane("a", a_checks, ["a.txt"]), lane("b", b_checks, ["b.txt"])], **options)

    def test_two_lanes_declaring_one_command_run_it_once_and_each_packet_cites_the_record(self):
        """PRD 11.1."""
        self.base()
        shared = [PY, str(self.fake), "shared"]
        value = self.two_lanes([check("a-unit", shared)], [check("b-unit", shared)])
        self.start(value, {"a": ("a.txt", "a1"), "b": ("b.txt", "b1")})
        self.assertIsNone(self.freeze())
        self.assertEqual(len(self.rows("shared", "worker")), 2)  # The worker phase is unchanged: once per lane snapshot.
        [(cwd, _, _)] = self.rows("shared")
        record_path = self.directory / "shared-checks/0/1" / RECORD
        record = read_json(record_path)
        self.assertEqual((cwd, record["worktree"]), (str(self.directory / "shared-checks/0/1/worktree"),) * 2)
        self.assertEqual([(item["lane"], item["id"]) for item in record["executions"][0]["lanes"]], [("a", "a-unit"), ("b", "b-unit")])
        for node in ("a", "b"):
            path = self.packet_path(node)
            packet = read_json(path)
            self.assertEqual(packet["shared_record"], {"path": "shared-checks/0/1/record.json", "sha256": digest_file(record_path)})
            self.assertNotIn("reused_from", packet)
            self.assertEqual(recheck_packet(read_json(path), value, self.directory)["gate"], packet["gate"])
            self.assertEqual(packet["gate"]["status"], "passed")
            self.assertEqual(packet["result"]["checks"][0]["cwd"], record["worktree"])
            self.assertEqual((path.parent / "check-0.log").read_bytes(), (record_path.parent / "check-0.log").read_bytes())
            for artifact in packet["artifact_paths"].values():
                self.assertEqual(Path(artifact).parent, path.parent / "artifacts")
                self.assertTrue(Path(artifact).is_file())
        self.runtime.validate_bundle()
        self.assertIn(("candidate", "running", f"Shared checks: 1 commands for 2 lane checks on {self.candidate_commit()}"), self.events())
        # The passed shared attempt was pruned like a passed check attempt; clean finds nothing left and never removes the record.
        self.assertFalse((record_path.parent / "worktree").exists())
        prune, kept = passed_attempts(self.directory)
        self.assertNotIn(record_path.parent, [folder for folder, _ in prune] + kept)

    def test_one_execution_serves_different_ids_kinds_and_timeouts_and_a_shorter_timeout_blocks_its_lane(self):
        """PRD 11.2 and the 1.4.0 regression of [L3]: on its own, lane a's check would be killed at its 1 s timeout and blocked
        with `a-unit: exit 124` among its reasons; the shared run at b's 30 s blocks it for the timeout alone."""
        self.base()
        slow = [PY, str(self.fake), "slow", "sleep=1.5"]
        value = policy([lane("b", [check("b-build", slow, "build", 30)], ["b.txt"]), lane("a", [check("a-unit", slow, "unit", 1)], ["a.txt"])])
        self.start(value, {"a": ("a.txt", "a1"), "b": ("b.txt", "b1")})
        error = self.freeze()
        self.assertRegex(str(error), "Combined candidate failed a checks")
        self.assertEqual(len(self.rows("slow")), 1)
        self.assertEqual(self.record()["executions"][0]["timeout_seconds"], 30)
        b, a = self.packet("b"), self.packet("a")
        self.assertEqual((b["gate"]["status"], b["evidence"]["checks"][0]["tests"]), ("passed", None))  # A build kind: no counts read.
        self.assertEqual(a["evidence"]["checks"][0]["tests"], {"passed": 1, "failed": 0, "skipped": 0})
        self.assertEqual(a["gate"]["reasons"], ["a-unit: execution exceeded approved timeout"])
        self.assertEqual(self.events()[-1], ("candidate_a", "blocked", "Candidate gate blocked on attempt 1: a-unit: execution exceeded approved timeout"))
        self.assertEqual(fix_decision(self.runtime, self.state()), ("a", "candidate"))
        # It exited 0, yet a's gate failed on it: the shared attempt is a failed one, kept whole, its worktree included.
        self.assertTrue((self.directory / "shared-checks/0/1/worktree").is_dir())
        self.assertIn(self.directory / "shared-checks/0/1", passed_attempts(self.directory)[1])

    def test_a_shared_execution_without_passing_counts_for_a_test_kind_is_kept_whole(self):
        """A unit check that exits 0 with no parsable counts fails its gate: its shared attempt is never pruned."""
        self.base()
        quiet = [PY, "-c", "import os; print('nothing counted' if os.environ['WORKFLOW_VERIFICATION_PHASE'] == 'candidate' else 'Ran 1 test in 0.001s\\n\\nOK')"]
        value = self.two_lanes([check("a-unit", quiet)], [check("b-unit", [PY, str(self.fake), "b"])])
        self.start(value, {"a": ("a.txt", "a1"), "b": ("b.txt", "b1")})
        self.assertRegex(str(self.freeze()), "Combined candidate failed a checks")
        self.assertEqual(self.record()["executions"][0]["exit_code"], 0)
        self.assertTrue((self.directory / "shared-checks/0/1/worktree").is_dir())
        self.assertIn(self.directory / "shared-checks/0/1", passed_attempts(self.directory)[1])

    def test_a_lane_check_and_a_run_check_with_one_argv_run_once_and_gate_independently(self):
        """PRD 11.2 and 11.7: the lanes pass on the shared execution, the run check fails its own shorter timeout, and
        attribution applies (it reruns the whole check: its output names no test id). The rerun times out too, so it is
        `not run` and names no lane (decisions [L7]): it is never rerun at base."""
        self.base()
        slow = [PY, str(self.fake), "slow", "sleep=1.5"]
        value = policy([lane("a", [check("a-unit", slow, timeout=30)], ["a.txt"]), lane("b", [check("b-unit", [PY, str(self.fake), "b"])], ["b.txt"])],
                       version="1.5.0", run_checks=[check("full", slow, timeout=1)])
        self.start(value, {"a": ("a.txt", "a1"), "b": ("b.txt", "b1")})
        self.assertRegex(str(self.freeze()), "Combined candidate failed a checks")
        record = self.record()
        shared = [row for row in self.rows("slow") if row[0] == record["worktree"]]
        self.assertEqual(len(shared), 1)
        self.assertEqual([item["id"] for item in record["executions"][0]["run_checks"]], ["full"])
        reason = "run check full failed, unattributed: not run (a rerun timed out, was killed or its setup failed): full"
        for node in ("a", "b"):
            packet = self.packet(node)
            self.assertEqual((packet["gate"]["reasons"], packet[MARKER]["kind"]), ([reason], "unattributed"))
        attribution = self.attribution()
        self.assertEqual((attribution["checks"][0]["mode"], attribution["checks"][0]["outcomes"]["full"]["result"]), ("whole", "not run"))
        self.assertEqual([(rerun["target"], rerun["exit_code"]) for rerun in attribution["checks"][0]["reruns"]], [("candidate", 124)])

    def test_browser_checks_run_per_lane_and_a_lane_with_both_kinds_cites_the_record_with_two_cwds(self):
        """PRD 11.3."""
        self.base()
        browser = check("browser", [PY, str(self.playwright), "ok"], "browser", scenarios=SCENARIOS)
        value = self.two_lanes([check("a-unit", [PY, str(self.fake), "unit"]), {**browser, "id": "a-browser"}], [{**browser, "id": "b-browser"}])
        self.start(value, {"a": ("a.txt", "a1"), "b": ("b.txt", "b1")})
        self.assertIsNone(self.freeze())
        runs = sorted(row[0] for row in self.rows("pw"))
        self.assertEqual(runs, [str(self.directory / f"verification/candidate/{node}/1/worktree") for node in ("a", "b")])
        record = self.record()
        a = self.packet("a")
        self.assertEqual({item["cwd"] for item in a["result"]["checks"]}, {record["worktree"], str(self.directory / "verification/candidate/a/1/worktree")})
        self.assertEqual(a["expected"]["verification_cwd"], str(self.directory / "verification/candidate/a/1/worktree"))
        self.assertEqual(recheck_packet(self.packet("a"), value, self.directory)["gate"]["status"], "passed")
        # The citing rule admits exactly those two: a non-browser check run in the lane's own worktree is refused.
        moved = self.packet("a")
        moved["result"]["checks"][0]["cwd"] = moved["expected"]["verification_cwd"]
        with self.assertRaisesRegex(ValueError, "differs from the shared record"):
            recheck_packet(moved, value, self.directory)
        self.runtime.validate_bundle()

    def test_a_browser_lane_whose_own_setup_fails_saves_a_blocked_packet_citing_the_record(self):
        """The setup passes in the shared worktree and fails in lane a's own browser worktree: a's packet is saved, blocked
        for the setup, and rechecks to the same gate; the fix loop takes it as an ordinary candidate failure."""
        self.base()
        browser = check("a-browser", [PY, str(self.playwright), "ok"], "browser", scenarios=SCENARIOS)
        value = self.two_lanes([check("a-unit", [PY, str(self.fake), "unit"]), browser], [check("b-unit", [PY, str(self.fake), "b"])])
        value["setup"] = [{"argv": [PY, "-c", "import os, sys; sys.exit(1 if '/verification/candidate/' in os.getcwd() else 0)"],
                           "timeout_seconds": 60}]
        self.start(value, {"a": ("a.txt", "a1"), "b": ("b.txt", "b1")})
        self.assertRegex(str(self.freeze()), "Combined candidate failed a checks")
        self.assertEqual(self.record()["setup_errors"], [])
        packet = self.packet("a")
        self.assertEqual((packet["gate"]["status"], packet["evidence"]["checks"]), ("blocked", []))
        self.assertIn("Setup 0 failed with exit 1", packet["gate"]["reasons"])
        self.assertIn("shared_record", packet)
        self.assertEqual(recheck_packet(self.packet("a"), value, self.directory)["gate"], packet["gate"])
        self.assertEqual(fix_decision(self.runtime, self.state()), ("a", "candidate"))

    def test_a_failing_shared_lane_check_blocks_the_first_declaring_lane_and_the_fix_loop_repairs_it(self):
        """PRD 11.4, as on 1.4.0 before: the first declaring lane in declared order."""
        self.base()
        failing = [PY, str(self.fake), "shared", "fail"]
        value = self.two_lanes([check("a-unit", failing)], [check("b-unit", failing)])
        self.start(value, {"a": ("a.txt", "a1"), "b": ("b.txt", "b1")})
        self.assertRegex(str(self.freeze()), "Combined candidate failed a checks")
        self.assertEqual(len(self.rows("shared")), 1)
        self.assertEqual(self.packet("a")["gate"]["reasons"], [f"Executed check failed: {' '.join(failing)}", "a-unit: no passing test evidence or failed tests",
                                                               "a-unit: exit 1"])
        self.assertFalse(self.packet_path("b").exists())
        self.assertEqual(fix_decision(self.runtime, self.state()), ("a", "candidate"))
        # A failed shared attempt is kept whole by clean, its worktree included.
        self.assertTrue((self.directory / "shared-checks/0/1/worktree").is_dir())
        self.assertIn(self.directory / "shared-checks/0/1", passed_attempts(self.directory)[1])

    def unstartable(self, label: str):
        """The shared execution of the fake check `label` cannot start, as a missing executable cannot."""
        from .checks import execute

        def launch(argv, *args):
            if argv[2:3] == [label]:
                raise FileNotFoundError(2, "No such file or directory", argv[0])
            return execute(argv, *args)
        return patch("workflow.shared_checks.execute", launch)

    def test_a_later_command_that_cannot_start_keeps_an_earlier_lanes_failure_and_its_repair(self):
        """Lane review P1: lane b's command cannot start; lane a's failure before it still blocks a, as when each lane ran
        its own checks, and nothing after the unstartable command runs."""
        self.base()
        value = self.two_lanes([check("a-unit", [PY, str(self.fake), "a", "fail"])],
                               [check("b-unit", [PY, str(self.fake), "b"]), check("b-more", [PY, str(self.fake), "more"])])
        self.start(value, {"a": ("a.txt", "a1"), "b": ("b.txt", "b1")})
        with self.unstartable("b"):
            self.assertRegex(str(self.freeze()), "Combined candidate failed a checks")
        record = self.record()
        self.assertEqual([item["lanes"][0]["id"] for item in record["executions"]], ["a-unit"])
        self.assertEqual((record["launch_error"]["execution"], record["launch_error"]["command"]), (1, f"{PY} {self.fake} b"))
        self.assertEqual(len(self.rows("more")), 0)
        self.assertIn("a-unit: exit 1", self.packet("a")["gate"]["reasons"])
        self.assertFalse(self.packet_path("b").parent.exists())
        self.assertEqual(fix_decision(self.runtime, self.state()), ("a", "candidate"))
        self.assertTrue((self.directory / "shared-checks/0/1/worktree").is_dir())
        self.assertIn(self.directory / "shared-checks/0/1", passed_attempts(self.directory)[1])

    def test_a_command_that_cannot_start_after_passing_lanes_stops_the_step_without_a_verdict(self):
        """As before checks were shared: the lane whose command cannot start, or the run checks, get no packet or gate,
        and a rerun of the attempt reuses the record and stops the same way."""
        self.base()
        value = self.two_lanes([check("a-unit", [PY, str(self.fake), "a"])], [check("b-unit", [PY, str(self.fake), "b"])])
        self.start(value, {"a": ("a.txt", "a1"), "b": ("b.txt", "b1")})
        with self.unstartable("b"):
            error = self.freeze()
        self.assertRegex(str(error), r"Shared check `.* b` could not start \(.*No such file or directory.*\); no verdict")
        self.assertEqual(self.packet("a")["gate"]["status"], "passed")
        self.assertFalse(self.packet_path("b").parent.exists())
        with self.assertRaisesRegex(RuntimeError, "could not start"):
            self.runtime.candidate(dict(self.state().values))
        self.assertEqual(len(self.rows("a")), 1)
        self.assertIn(self.directory / "shared-checks/0/1", passed_attempts(self.directory)[1])
        # A run check that cannot start: every lane passes on its own checks, and the run checks are neither gated nor attributed.
        missing = str(self.root / "missing-tool")
        value = policy([lane("a", [check("a-unit", [PY, str(self.fake), "a"])], ["a.txt"]), lane("b", [check("b-unit", [PY, str(self.fake), "b"])], ["b.txt"])],
                       version="1.5.0", run_checks=[check("full", [missing])])
        self.start(value, {"a": ("a.txt", "a1"), "b": ("b.txt", "b1")}, name="run-check")
        self.assertRegex(str(self.freeze()), rf"Shared check `{re.escape(missing)}` could not start .*; see .*record.json")
        self.assertEqual([self.packet(node)["gate"]["status"] for node in ("a", "b")], ["passed", "passed"])
        self.assertNotIn(MARKER, self.packet("a"))
        self.assertFalse((self.directory / "shared-checks/0/1" / ATTRIBUTION).exists())

    def test_a_check_that_dirties_the_shared_worktree_blocks_only_the_lanes_that_ran_on_the_dirty_tree(self):
        """Challenge note 2, on 1.4.0: lane b's command writes a tracked file; lane a's command ran before it on a clean tree."""
        self.base()
        value = self.two_lanes([check("a-unit", [PY, str(self.fake), "a"])], [check("b-unit", [PY, str(self.fake), "b", "write=a.txt"])])
        self.start(value, {"a": ("a.txt", "a1"), "b": ("b.txt", "b1")})
        self.assertRegex(str(self.freeze()), "Combined candidate failed b checks")
        self.assertEqual(self.packet("a")["gate"]["status"], "passed")
        self.assertEqual(self.packet("b")["gate"]["reasons"], ["Verification modified the tested source revision"])
        self.assertEqual(fix_decision(self.runtime, self.state()), ("b", "candidate"))

    def test_a_rerun_of_the_attempt_reuses_the_record_and_a_changed_record_fails_recheck(self):
        """PRD 11.5: the cache and the tamper check."""
        self.base()
        shared = [PY, str(self.fake), "shared"]
        value = self.two_lanes([check("a-unit", shared)], [check("b-unit", shared)])
        self.start(value, {"a": ("a.txt", "a1"), "b": ("b.txt", "b1")})
        self.assertIsNone(self.freeze())
        self.runtime.candidate(dict(self.state().values))  # The same attempt again (a controller that stopped before its bundle).
        self.assertEqual(len(self.rows("shared")), 1)
        self.runtime.validate_bundle()
        path = self.directory / "shared-checks/0/1" / RECORD
        path.chmod(0o600)
        path.write_text(path.read_text().replace('"exit_code": 0', '"exit_code": 0 '))
        with self.assertRaisesRegex(ValueError, r"Shared record shared-checks/0/1/record.json changed after it was cited"):
            recheck_packet(self.packet("a"), value, self.directory)
        with self.assertRaisesRegex(ValueError, "changed after it was cited"):
            self.runtime.validate_bundle()

    def test_retrying_one_lane_reverifies_the_other_at_the_same_attempt_on_1_4_0(self):
        """[L2], the one retry-target difference on 1.0.0-1.4.0: both lanes at the new attempt, one new record."""
        self.base()
        marker = self.root / "b-fails-once"
        marker.write_text("")  # b's check fails once, at the candidate.
        value = self.two_lanes([check("a-unit", [PY, str(self.fake), "a"])], [check("b-unit", [PY, str(self.fake), "b", f"fail-once={marker}"])])
        self.start(value, {"a": ("a.txt", "a1"), "b": ("b.txt", "b1")})
        error = self.freeze()
        self.assertRegex(str(error), "Combined candidate failed b checks")
        self.assertEqual((self.packet("a")["gate"]["status"], self.packet("b")["gate"]["status"]), ("passed", "blocked"))
        self.runtime.retry_check("candidate", "b")
        self.assertIsNone(self.advance(None))
        record = self.directory / "shared-checks/0/2" / RECORD
        for node in ("a", "b"):
            self.assertEqual(self.runtime.attempt("candidate", node), 2)
            packet = self.packet(node, 2)
            self.assertEqual((packet["gate"]["status"], packet["shared_record"]["path"]), ("passed", "shared-checks/0/2/record.json"))
            self.assertEqual(packet["shared_record"]["sha256"], digest_file(record))
        self.assertEqual(len(self.rows("a")), 2)  # Lane a ran again at attempt 2 though only b was retried.
        self.runtime.validate_bundle()


class LockstepBudget(Fixture):
    def test_a_repaired_lane_failing_until_its_limit_ends_with_the_retry_limit_error(self):
        """Challenge note 1: under lockstep every lane gets the same candidate floor after a repair, so raising lane b beside lane
        a never passes b's own budget; the run ends with check_retries' limit error, never Pipeline.attempt's ValueError."""
        self.base()
        value = policy([lane("a", [check("a-unit", [PY, str(self.fake), "a", "vary"])], ["a.txt"]),
                        lane("b", [check("b-unit", [PY, str(self.fake), "b"])], ["b.txt"])])
        self.start(value, {"a": ("a.txt", "a1"), "b": ("b.txt", "b1")})
        self.assertRegex(str(self.freeze()), "Combined candidate failed a checks")
        self.assertFalse(self.packet_path("b").exists())
        fix = self.root / "fix"
        git(self.repo, "worktree", "add", "-q", "--detach", str(fix), self.candidate_commit())
        (fix / "a.txt").write_text("a2")
        git(fix, "commit", "-qam", "operator fix")
        with contextlib.redirect_stdout(open(os.devnull, "w")), contextlib.redirect_stderr(open(os.devnull, "w")):
            try:
                repair.repair_main(by_operator([str(self.directory), "a", "--commit", git(fix, "rev-parse", "HEAD"), "--reason", "fix a"], True))
            except SystemExit as exit:
                self.assertEqual(exit.code, 0)
        [entry] = read_json(self.directory / "repairs.json")["repairs"]
        self.assertEqual((entry["attempt_targets"]["candidate:a"], entry["attempt_targets"]["candidate:b"]), (2, 2))
        attempts = []
        with patch("workflow.automatic.wait_for_memory"):
            while True:
                error = self.advance(None)
                self.assertIsNotNone(error)
                attempts.append(self.runtime.attempt("candidate", "a"))
                self.assertEqual(self.runtime.attempt("candidate", "b"), attempts[-1])
                try:
                    advance_failed_checks(self.runtime, self.state())
                except RuntimeError as stop:
                    self.assertEqual(str(stop), "Verification retry limit exhausted; work and evidence retained")
                    break
        self.assertEqual(attempts, [2, 3, 4])
        self.assertEqual([self.packet("a", attempt)["gate"]["reasons"][-1] for attempt in attempts], ["a-unit: exit 3", "a-unit: exit 4", "a-unit: exit 5"])


class Attribution(Fixture):
    """A repository whose own `workflow.run_tests` runs its tests: lanes a and b own a.txt and b.txt and their test files."""

    def base(self, files: dict | None = None) -> None:
        source = (REPO / "workflow" / "run_tests.py").read_text()
        source = source.replace('if __name__ == "__main__":\n    sys.exit(main())', RUN_TESTS_COUNTED.replace("COUNTER", repr(str(self.counter)))
                                + '\n\nif __name__ == "__main__":\n    sys.exit(counted_main())')
        super().base({"workflow/__init__.py": "", "workflow/run_tests.py": source, "workflow/test_a.py": TEST_A, "workflow/test_b.py": TEST_B,
                      "workflow/test_x.py": TEST_X, **(files or {})})

    def run_policy(self, run_check: list | None = None, owner_x: str | None = None, lanes: tuple = ("a", "b"), kind: str = "unit") -> dict:
        owned = {"a": ["a.txt", "workflow/test_a.py"], "b": ["b.txt", "workflow/test_b.py", "workflow/test_new.py"]}
        if owner_x:
            owned[owner_x].append("workflow/test_x.py")
        return policy([lane(node, [check(f"{node}-unit", [PY, "-c", "print('Ran 1 test in 0.001s\\n\\nOK')", node])], owned[node]) for node in lanes],
                      version="1.5.0", run_checks=[check("full", run_check or FULL, kind)])

    def reruns(self) -> list:
        """The run check's runs after its shared execution: the attribution's reruns."""
        record = self.record()
        return [row for row in self.rows("run_tests") if row[0] != record["worktree"]]

    def test_a_test_failing_only_on_one_snapshot_blocks_that_lane_and_its_repair_brief_shows_the_failure(self):
        """PRD 11.8 a, g and 11.10; challenge note 6; [L3]: the reruns never overlap."""
        self.base()
        value = self.run_policy()
        self.start(value, {"a": ("a.txt", "a1"), "b": ("b.txt", "bad")})
        self.assertRegex(str(self.freeze()), "Combined candidate failed b checks")
        self.assertEqual(self.rows("run_tests", "worker"), [])  # Never in the worker phase.
        test_id = "workflow.test_b.BTest.test_b_lane"
        reason = f"run check full failed: 1 test(s) attributed to b: {test_id}"
        a, b = self.packet("a"), self.packet("b")
        self.assertEqual((a["gate"]["status"], MARKER in a), ("passed", False))
        self.assertEqual((b["gate"]["reasons"], b[MARKER]["kind"], b[MARKER]["lane"]), ([reason], "attributed", "b"))
        [attributed] = self.attribution()["checks"]
        # Only the failing method reruns, never its class, whose test_b_ok passes.
        self.assertEqual((attributed["mode"], attributed["ids"]), ("run_tests", [test_id]))
        self.assertEqual(attributed["outcomes"][test_id], {"candidate": "failed", "base": "passed", "lanes": {"a": "passed", "b": "failed"},
                                                           "result": "snapshot", "lane": "b"})
        self.assertEqual([rerun["target"] for rerun in attributed["reruns"]], ["candidate", "base", "lane-a", "lane-b"])
        self.assertEqual(attributed["reruns"][0]["argv"], [PY, "-m", "workflow.run_tests", "--tests", test_id])
        self.assertEqual(len(self.reruns()), 4)
        self.assert_sequential(self.rows("run_tests"))
        self.assertIn(("candidate", "blocked", f"Run check full failed; 1 test(s) attributed to b: {test_id}"), self.events())
        self.assertEqual(self.events()[-1], ("candidate_b", "blocked", f"Candidate gate blocked on attempt 1: {reason}"))
        self.assertEqual(fix_decision(self.runtime, self.state()), ("b", "candidate"))
        self.assertEqual(recheck_packet(self.packet("b"), value, self.directory)["gate"]["reasons"], [reason])
        # The repair brief: the run check's log beside the packet, the attributed id and the command that reruns it.
        self.assertTrue((self.packet_path("b").parent / "run-check-0.log").is_file())
        lines = "\n".join(repair.failing_checks(self.runtime, "b", {"path": "verification/candidate/b/1/packet.json", "reasons": [reason]}))
        self.assertIn(f"Failing tests attributed to this lane: {test_id}", lines)
        self.assertIn(f"Rerun them: `{PY} -m workflow.run_tests --tests {test_id}`", lines)
        self.assertIn(f"FAIL: test_b_lane ({test_id})", lines)
        self.assertIn(self.packet_path("b").parent / "run-check-0.log", repair.packet_evidence(self.directory, {"path": "verification/candidate/b/1/packet.json"})[1])

    def test_a_test_failing_at_base_blocks_every_lane_without_a_repair_after_one_candidate_and_one_base_rerun(self):
        """PRD 11.8 b; challenge note 5 (no lane reruns once nothing remains)."""
        self.base({"workflow/test_base.py": TEST_BASE})
        self.start(self.run_policy(), {"a": ("a.txt", "a1"), "b": ("b.txt", "b1")})
        self.assertRegex(str(self.freeze()), "Combined candidate failed a checks")
        reason = "run check full failed, unattributed: pre-existing at base: workflow.test_base.BaseTest.test_base"
        for node in ("a", "b"):
            self.assertEqual((self.packet(node)["gate"]["reasons"], self.packet(node)[MARKER]["kind"]), ([reason], "unattributed"))
            self.assertTrue(repair.unattributed_block(self.packet(node)))
        self.assertEqual(len(self.reruns()), 2)
        outcome = self.attribution()["checks"][0]["outcomes"]["workflow.test_base.BaseTest.test_base"]
        self.assertEqual(outcome["lanes"], {"a": "not run", "b": "not run"})
        self.assertIsNone(fix_decision(self.runtime, self.state()))

    def test_a_failure_that_does_not_reproduce_blocks_every_lane_after_one_rerun(self):
        """PRD 11.8 c; challenge note 5."""
        marker = self.root / "flaky"
        marker.write_text("")
        self.base({"workflow/test_flaky.py": f"import unittest\nfrom pathlib import Path\n\n\nclass FlakyTest(unittest.TestCase):\n"
                                             f"    def test_flaky(self):\n        marker = Path({str(marker)!r})\n"
                                             "        if marker.exists():\n            marker.unlink()\n            self.fail('once')\n"})
        self.start(self.run_policy(), {"a": ("a.txt", "a1"), "b": ("b.txt", "b1")})
        self.assertRegex(str(self.freeze()), "Combined candidate failed a checks")
        reason = "run check full failed, unattributed: did not reproduce: workflow.test_flaky.FlakyTest.test_flaky"
        self.assertEqual([self.packet(node)["gate"]["reasons"] for node in ("a", "b")], [[reason], [reason]])
        self.assertEqual(len(self.reruns()), 1)
        self.assertIsNone(fix_decision(self.runtime, self.state()))

    def test_a_cross_lane_failure_goes_to_the_one_lane_owning_its_test_file_and_is_unattributed_without_one(self):
        """PRD 11.8 d, [G3]: failing on no snapshot, after the reproduction and base checks."""
        self.base()
        test_id = "workflow.test_x.XTest.test_cross"
        self.start(self.run_policy(owner_x="a"), {"a": ("a.txt", "x"), "b": ("b.txt", "x")}, name="owned")
        self.assertRegex(str(self.freeze()), "Combined candidate failed a checks")
        self.assertEqual(self.packet("a")["gate"]["reasons"], [f"run check full failed: 1 test(s) attributed to a: {test_id} (owner-attributed: {test_id})"])
        self.assertEqual(self.packet("b")["gate"]["status"], "passed")
        outcome = self.attribution()["checks"][0]["outcomes"][test_id]
        self.assertEqual((outcome["result"], outcome["lane"], outcome["file"], outcome["lanes"]), ("owner", "a", "workflow/test_x.py", {"a": "passed", "b": "passed"}))
        self.assertEqual(fix_decision(self.runtime, self.state()), ("a", "candidate"))
        self.start(self.run_policy(), {"a": ("a.txt", "x"), "b": ("b.txt", "x")}, name="unowned")
        self.assertRegex(str(self.freeze()), "Combined candidate failed a checks")
        self.assertEqual(self.packet("b")["gate"]["reasons"], [f"run check full failed, unattributed: unattributed: {test_id}"])

    def test_ids_naming_two_lanes_make_the_failure_unattributed(self):
        """PRD 11.8 e."""
        self.base()
        self.start(self.run_policy(), {"a": ("a.txt", "bad"), "b": ("b.txt", "bad")})
        self.assertRegex(str(self.freeze()), "Combined candidate failed a checks")
        reason = ("run check full failed, unattributed: attributed to several lanes: workflow.test_a.ATest.test_a_lane (a), "
                  "workflow.test_b.BTest.test_b_lane (b)")
        self.assertEqual([self.packet(node)["gate"]["reasons"] for node in ("a", "b")], [[reason], [reason]])
        self.assertIsNone(fix_decision(self.runtime, self.state()))

    def test_a_test_missing_on_a_snapshot_is_not_applicable_there(self):
        """PRD 11.8 f: lane b adds a failing test file the base and lane a do not have."""
        self.base()
        self.start(self.run_policy(), {"a": ("a.txt", "a1"), "b": ("workflow/test_new.py", TEST_NEW)})
        self.assertRegex(str(self.freeze()), "Combined candidate failed b checks")
        outcome = self.attribution()["checks"][0]["outcomes"]["workflow.test_new.NewTest.test_new"]
        self.assertEqual((outcome["candidate"], outcome["base"], outcome["lanes"], outcome["result"]),
                         ("failed", "not applicable", {"a": "not applicable", "b": "failed"}, "snapshot"))
        self.assertEqual(self.packet("a")["gate"]["status"], "passed")

    def test_without_parsed_ids_the_whole_check_reruns_one_target_at_a_time(self):
        """PRD 11.8 i, [G4]: another runner reruns whole on the candidate, the base and each snapshot, never concurrently."""
        self.base()
        value = self.run_policy(run_check=[PY, str(self.fake), "whole", "fail-if=a.txt:bad"], kind="build")
        self.start(value, {"a": ("a.txt", "bad"), "b": ("b.txt", "b1")})
        self.assertRegex(str(self.freeze()), "Combined candidate failed a checks")
        [attributed] = self.attribution()["checks"]
        self.assertEqual((attributed["mode"], attributed["ids"], attributed["outcomes"]["full"]["result"]), ("whole", ["full"], "snapshot"))
        self.assertEqual(self.packet("a")["gate"]["reasons"], ["run check full failed: 1 test(s) attributed to a: full"])
        rows = self.rows("whole")
        self.assertEqual(len(rows), 5)  # The shared execution, then the candidate, the base, lane a and lane b.
        self.assert_sequential(rows)

    def test_an_interrupted_rerun_whose_worktree_git_still_lists_is_unregistered_before_the_rerun(self):
        """A controller killed mid-rerun leaves `attribution/<index>/<name>/worktree` registered: resuming removes it through
        Git, so the same path is added again, and Git lists no attribution worktree after."""
        self.base()
        commit = git(self.repo, "rev-parse", "HEAD")
        folder = self.root / "attempt"
        leftover = folder / "attribution" / "0" / "candidate" / "worktree"
        leftover.parent.mkdir(parents=True)
        subprocess.run(["git", "-C", str(self.repo), "worktree", "add", "-q", "--detach", str(leftover), commit], check=True)
        (leftover.parent / "check.log").write_text("interrupted")
        result = rerun({"repository": str(self.repo)}, {}, folder, "candidate", commit, check("full", [PY, "-c", "print('ok')"], "build"),
                       ["full"], None)
        self.assertEqual((result["exit_code"], result["statuses"]), (0, {"full": "passed"}))
        self.assertEqual((leftover.parent / "check.log").read_text(), "ok\n")
        self.assertFalse(leftover.exists())
        self.assertNotIn(str(folder), git(self.repo, "worktree", "list", "--porcelain"))

    def test_two_failed_run_checks_keep_every_rerun_log_their_attribution_cites(self):
        """Each failed run check reruns under its own `attribution/<policy index>/`: the second never replaces the first's logs."""
        self.base()
        value = self.run_policy(run_check=[PY, str(self.fake), "first", "fail-if=a.txt:bad"], kind="build")
        value["run_checks"].append(check("second", [PY, str(self.fake), "second", "fail-if=a.txt:bad"], "build"))
        self.start(value, {"a": ("a.txt", "bad"), "b": ("b.txt", "b1")})
        self.assertRegex(str(self.freeze()), "Combined candidate failed a checks")
        folder = self.directory / "shared-checks/0/1"
        checks = self.attribution()["checks"]
        self.assertEqual([item["id"] for item in checks], ["full", "second"])
        logs = [rerun["log"] for item in checks for rerun in item["reruns"]]
        self.assertEqual(len(logs), 8)  # The candidate, the base and each lane, for each run check.
        self.assertEqual(logs[:4], [f"attribution/0/{target}/check.log" for target in ("candidate", "base", "lane-a", "lane-b")])
        self.assertEqual(logs[4:], [f"attribution/1/{target}/check.log" for target in ("candidate", "base", "lane-a", "lane-b")])
        for log in logs:
            self.assertTrue((folder / log).is_file(), log)
        self.assertEqual(self.packet("a")["gate"]["reasons"], ["run check full failed: 1 test(s) attributed to a: full",
                                                               "run check second failed: 1 test(s) attributed to a: second"])

    def test_a_memory_killed_run_check_takes_the_transient_path_without_attribution_on_one_lane(self):
        """PRD 11.8 i; challenge note 3: blocked_lanes and fix_decision leave it to the retry path, which reruns it free."""
        self.base()
        value = self.run_policy(run_check=[PY, str(self.fake), "oom", "kill"], lanes=("a",), kind="build")
        self.start(value, {"a": ("a.txt", "a1")})
        self.assertRegex(str(self.freeze()), "Combined candidate failed a checks")
        packet = self.packet("a")
        self.assertEqual((packet[MARKER]["kind"], packet["result"]["transient_checks"]), ("transient", ["full"]))
        self.assertEqual(packet["gate"]["reasons"], ["full: exit -9"])
        self.assertFalse((self.directory / "shared-checks/0/1" / ATTRIBUTION).exists())
        self.assertEqual(len(self.rows("oom")), 1)
        self.assertTrue(repair.transient_packet(self.packet_path("a")))
        state = self.state()
        self.assertIsNone(blocked_lanes(self.runtime, "candidate", ["a"]))
        self.assertIsNone(fix_decision(self.runtime, state))
        with patch("workflow.automatic.wait_for_memory"):
            self.assertTrue(advance_failed_checks(self.runtime, state))
        self.assertIn(("controller", "running", "candidate/a killed under memory pressure: transient, rerun without spending an attempt"), self.events())
        self.assertFalse([start for start in self.sessions.starts if start.startswith("repair")])

    def retry_waits(self) -> tuple[bool, dict]:
        """advance_failed_checks on the current state with every wait patched: its return and which waits it called."""
        with patch("workflow.automatic.wait_for_memory") as memory, patch("workflow.automatic.wait_for_quiet") as load, \
                patch("workflow.automatic.wait_for_disk") as disk:
            advanced = advance_failed_checks(self.runtime, self.state())
        return advanced, {"memory": memory.called, "load": load.called, "disk": disk.called}

    def test_a_run_check_out_of_disk_takes_the_transient_path_and_waits_for_disk(self):
        """checks.TRANSIENT_KINDS: a shared execution recorded `transient: "disk"` is transient as a lane check's is, with no
        attribution, and the retry path waits on disk only, never on memory."""
        self.base()
        value = self.run_policy(run_check=[PY, str(self.fake), "full", "enospc"], lanes=("a",), kind="build")
        self.start(value, {"a": ("a.txt", "a1")})
        self.assertRegex(str(self.freeze()), "Combined candidate failed a checks")
        self.assertEqual([item.get("transient") for item in self.record()["executions"]][-1], "disk")
        packet = self.packet("a")
        self.assertEqual((packet[MARKER]["kind"], packet["result"].get("transient_checks")), ("transient", ["full"]))
        self.assertEqual(packet[MARKER]["transients"], {"full": "disk"})
        self.assertFalse((self.directory / "shared-checks/0/1" / ATTRIBUTION).exists())
        self.assertEqual((repair.transient_packet(self.packet_path("a"), ("disk",)), repair.transient_packet(self.packet_path("a"))),
                         (True, False))
        self.assertEqual(repair.transient_kinds(self.packet_path("a")), {"disk"})
        self.assertIn(("candidate", "blocked", "Run check full failed; out of disk: transient, rerun without attribution"), self.events())
        self.assertIsNone(fix_decision(self.runtime, self.state()))
        self.assertEqual(self.retry_waits(), (True, {"memory": False, "load": False, "disk": True}))
        self.assertIn(("controller", "running", "candidate/a failed on a full disk: transient, rerun once the disk floor holds"), self.events())

    def test_a_run_check_that_timed_out_under_host_load_takes_the_transient_path_and_waits_for_a_quieter_host(self):
        """checks.overloaded_timeout: a shared execution that hit its timeout at a load average over twice the CPUs is
        recorded `transient: "load"` and waits on load only."""
        self.base()
        value = self.run_policy(run_check=[PY, str(self.fake), "full", "sleep=30"], lanes=("a",), kind="build")
        value["run_checks"][0]["timeout_seconds"] = 1
        self.start(value, {"a": ("a.txt", "a1")})
        with patch("workflow.checks.os.getloadavg", return_value=(1000.0, 1000.0, 1000.0)):
            self.assertRegex(str(self.freeze()), "Combined candidate failed a checks")
        self.assertEqual(self.record()["executions"][-1].get("transient"), "load")
        packet = self.packet("a")
        self.assertEqual((packet[MARKER]["kind"], packet["result"].get("transient_checks")), ("transient", ["full"]))
        self.assertEqual(packet[MARKER]["transients"], {"full": "load"})
        self.assertEqual(repair.transient_kinds(self.packet_path("a")), {"load"})
        self.assertIsNone(fix_decision(self.runtime, self.state()))
        self.assertEqual(self.retry_waits(), (True, {"memory": False, "load": True, "disk": False}))
        self.assertIn(("controller", "running", "candidate/a timed out under host load: transient, rerun without spending an attempt"), self.events())

    def test_a_deterministic_run_check_failure_stays_real_beside_the_transient_kinds(self):
        """A plain exit 1 records no `transient`: it is attributed, never rerun free."""
        self.base()
        value = self.run_policy(run_check=[PY, str(self.fake), "full", "fail"], lanes=("a",), kind="build")
        self.start(value, {"a": ("a.txt", "a1")})
        self.assertRegex(str(self.freeze()), "Combined candidate failed a checks")
        self.assertNotIn("transient", self.record()["executions"][-1])
        packet = self.packet("a")
        self.assertNotEqual(packet[MARKER]["kind"], "transient")
        self.assertNotIn("transient_checks", packet["result"])
        self.assertTrue((self.directory / "shared-checks/0/1" / ATTRIBUTION).exists())
        self.assertFalse(repair.transient_attempt(self.packet_path("a")))
        self.assertEqual(repair.transient_kinds(self.packet_path("a")), set())

    def test_run_checks_killed_for_memory_and_out_of_disk_wait_on_each_kind(self):
        """A packet whose run checks recorded several kinds waits on each, as a lane packet does (repair.transient_kinds)."""
        self.base()
        value = self.run_policy(run_check=[PY, str(self.fake), "oom", "kill"], lanes=("a",), kind="build")
        value["run_checks"].append(check("second", [PY, str(self.fake), "second", "enospc"], "build"))
        self.start(value, {"a": ("a.txt", "a1")})
        self.assertRegex(str(self.freeze()), "Combined candidate failed a checks")
        packet = self.packet("a")
        self.assertEqual((packet[MARKER]["kind"], packet["result"].get("transient_checks")), ("transient", ["full", "second"]))
        self.assertEqual(packet[MARKER]["transients"], {"full": "memory", "second": "disk"})
        self.assertEqual(repair.transient_kinds(self.packet_path("a")), {"memory", "disk"})
        self.assertEqual(self.retry_waits(), (True, {"memory": True, "load": False, "disk": True}))

    def test_a_memory_kill_beside_a_real_run_check_failure_makes_the_attempt_a_real_failure(self):
        """PRD 6.2: as for lane checks (repair.transient_packet), the real failure is attributed and the kill only listed."""
        self.base()
        value = self.run_policy(run_check=[PY, str(self.fake), "oom", "kill"], kind="build")
        value["run_checks"].append(check("second", [PY, str(self.fake), "second", "fail-if=a.txt:bad"], "build"))
        self.start(value, {"a": ("a.txt", "bad"), "b": ("b.txt", "b1")})
        self.assertRegex(str(self.freeze()), "Combined candidate failed a checks")
        a, b = self.packet("a"), self.packet("b")
        self.assertEqual(a["gate"]["reasons"], ["run check second failed: 1 test(s) attributed to a: second", "full: exit -9"])
        self.assertEqual((a[MARKER]["kind"], a[MARKER]["lane"], a[MARKER]["checks"], a["result"]["transient_checks"]),
                         ("attributed", "a", ["second"], ["full"]))
        self.assertEqual((b["gate"]["status"], "transient_checks" in b["result"]), ("passed", False))
        self.assertEqual([item["id"] for item in self.attribution()["checks"]], ["second"])
        self.assertEqual(len(self.rows("oom")), 1)  # The kill gets no attribution rerun.
        self.assertFalse(repair.transient_packet(self.packet_path("a")))
        self.assertIn(("candidate", "blocked", "Run check full failed; killed for memory: listed beside the real failure, not attributed"), self.events())
        self.assertIn(("candidate", "blocked", "Run check second failed; 1 test(s) attributed to a: second"), self.events())
        self.assertEqual(fix_decision(self.runtime, self.state()), ("a", "candidate"))

    def test_a_slow_run_check_is_named_on_the_candidate_event(self):
        """PRD 6.2, C27: a run check over 60% of its own timeout is named as a lane check is."""
        self.base()
        value = self.run_policy(run_check=[PY, str(self.fake), "slow", "sleep=2.5"], kind="build")
        value["run_checks"][0]["timeout_seconds"] = 4
        self.start(value, {"a": ("a.txt", "a1"), "b": ("b.txt", "b1")})
        self.assertIsNone(self.freeze())
        [note] = [message for node, status, message in self.events() if node == "candidate" and "slow:" in message]
        self.assertRegex(note, rf"^Run checks on {self.candidate_commit()}; slow: full took \d s of its 4 s timeout \((6[3-9]|[7-9]\d|100)%\)$")

    def test_a_lane_that_attribution_clears_passes_and_the_kill_is_dropped_from_its_packet(self):
        """[L4], PRD 6.2: beside a real failure attributed to b, lane a passes on its own checks, and the kill listed beside
        that failure is no transient check of a's packet: neither the retry path nor a recheck reruns a for it."""
        self.base()
        value = self.run_policy(run_check=[PY, str(self.fake), "oom", "kill"], kind="build")
        value["run_checks"].append(check("second", [PY, str(self.fake), "second", "fail-if=b.txt:bad"], "build"))
        self.start(value, {"a": ("a.txt", "a1"), "b": ("b.txt", "bad")})
        self.assertRegex(str(self.freeze()), "Combined candidate failed b checks")
        a, b = self.packet("a"), self.packet("b")
        self.assertEqual((a["gate"]["status"], a["gate"]["reasons"], MARKER in a, "transient_checks" in a["result"]), ("passed", [], False, False))
        gated = recheck_packet(self.packet("a"), value, self.directory)
        self.assertEqual((gated["gate"]["status"], MARKER in gated, "transient_checks" in gated["result"]), ("passed", False, False))
        self.assertFalse(repair.transient_packet(self.packet_path("a")))
        self.assertEqual((b[MARKER]["kind"], b[MARKER]["lane"], b["result"]["transient_checks"]), ("attributed", "b", ["full"]))
        self.assertEqual(b["gate"]["reasons"], ["run check second failed: 1 test(s) attributed to b: second", "full: exit -9"])
        self.assertFalse([event for event in self.events() if event[0] == "candidate_a" and event[1] == "blocked"])
        self.assertEqual(fix_decision(self.runtime, self.state()), ("b", "candidate"))

    def test_a_slow_run_check_is_named_when_a_lane_check_blocks_before_the_run_checks_gate(self):
        """[L5], PRD 6.2; challenge note 3: lane a's own check fails, so the step raises before the run checks are gated, and
        the slow note is still on the candidate event, once. 2.5 s is over 60% of 4 s whatever the load (a timeout is 100%)."""
        self.base()
        value = self.run_policy(run_check=[PY, str(self.fake), "slow", "sleep=2.5"], kind="build")
        value["run_checks"][0]["timeout_seconds"] = 4
        value["workers"][0]["checks"][0]["argv"] = [PY, str(self.fake), "a", "fail"]
        self.start(value, {"a": ("a.txt", "a1"), "b": ("b.txt", "b1")})
        self.assertRegex(str(self.freeze()), "Combined candidate failed a checks")
        self.assertIn("a-unit: exit 1", self.packet("a")["gate"]["reasons"])
        self.assertNotIn(MARKER, self.packet("a"))
        self.assertFalse((self.directory / "shared-checks/0/1" / ATTRIBUTION).exists())
        [note] = [message for node, status, message in self.events() if node == "candidate" and "slow:" in message]
        self.assertRegex(note, rf"^Run checks on {self.candidate_commit()}; slow: full took \d+ s of its 4 s timeout \(\d+%\)$")

    def test_an_id_the_rerun_never_reached_is_not_run_and_names_no_lane(self):
        """[L7], PRD 7.3 and 11.8 i; challenge note 5: the candidate rerun of [A, B] under run_tests prints A's class first
        (its name sorts first) and A fails; B hangs until the run check's timeout ends the rerun. B is `not run`, never
        `passed`, and no lane is chosen on it, though A alone would name lane a."""
        marker = self.root / "hang-fails-once"
        marker.write_text("")
        self.base({"workflow/test_hang.py": TEST_HANG.replace("MARKER", repr(str(marker)))})
        value = self.run_policy()
        value["run_checks"][0]["timeout_seconds"] = HANG_TIMEOUT
        self.start(value, {"a": ("a.txt", "bad"), "b": ("b.txt", "b1")})
        self.assertRegex(str(self.freeze()), "Combined candidate failed a checks")
        a_id, hang = "workflow.test_a.ATest.test_a_lane", "workflow.test_hang.HangTest.test_hang"
        [attributed] = self.attribution()["checks"]
        self.assertEqual(attributed["ids"], [a_id, hang])
        first = attributed["reruns"][0]
        self.assertEqual((first["target"], first["exit_code"], first["statuses"]), ("candidate", 124, {a_id: "failed", hang: "not run"}))
        self.assertEqual(attributed["outcomes"][a_id]["result"], "snapshot")
        self.assertEqual((attributed["outcomes"][hang]["result"], attributed["outcomes"][hang]["lane"]), ("not run", None))
        self.assertEqual([rerun["target"] for rerun in attributed["reruns"]], ["candidate", "base", "lane-a", "lane-b"])
        self.assertTrue(all(hang not in rerun["statuses"] for rerun in attributed["reruns"][1:]))  # Never rerun after.
        reason = f"run check full failed, unattributed: not run (a rerun timed out, was killed or its setup failed): {hang}"
        for node in ("a", "b"):
            self.assertEqual((self.packet(node)["gate"]["reasons"], self.packet(node)[MARKER]["kind"]), ([reason], "unattributed"))
        self.assertIsNone(fix_decision(self.runtime, self.state()))

    def test_a_test_hanging_at_base_is_not_run_and_never_reaches_the_owner_rule(self):
        """Challenge note 1, [L7], [G3], [G5]: a test that fails on the candidate and hangs at base is `not run` there, so
        though lane a owns its file it is never owner-attributed: every lane is blocked unattributed, the reason names it
        `not run`, no lane snapshot reruns it and no repair starts."""
        self.base({"workflow/test_x.py": TEST_STUCK})
        value = self.run_policy(owner_x="a")
        value["run_checks"][0]["timeout_seconds"] = HANG_TIMEOUT
        self.start(value, {"a": ("a.txt", "a1"), "b": ("b.txt", "b1")})
        self.assertRegex(str(self.freeze()), "Combined candidate failed a checks")
        stuck = "workflow.test_x.XTest.test_stuck"
        [attributed] = self.attribution()["checks"]
        self.assertEqual([(rerun["target"], rerun["exit_code"]) for rerun in attributed["reruns"]], [("candidate", 1), ("base", 124)])
        self.assertEqual(attributed["outcomes"][stuck], {"candidate": "failed", "base": "not run", "lanes": {"a": "not run", "b": "not run"},
                                                         "result": "not run", "lane": None})
        reason = f"run check full failed, unattributed: not run (a rerun timed out, was killed or its setup failed): {stuck}"
        for node in ("a", "b"):
            self.assertEqual((self.packet(node)["gate"]["reasons"], self.packet(node)[MARKER]["kind"]), ([reason], "unattributed"))
            self.assertTrue(repair.unattributed_block(self.packet(node)))
        self.assertIsNone(fix_decision(self.runtime, self.state()))
        self.assertFalse([start for start in self.sessions.starts if start.startswith("repair")])

    def test_a_rerun_whose_setup_fails_or_times_out_runs_no_id(self):
        """[L7]: a setup step that exits non-zero or on its timeout (124) leaves every selected id `not run`, never
        `failed`, and the rerun cites the setup's log."""
        self.base()
        commit = git(self.repo, "rev-parse", "HEAD")
        for name, argv, timeout in (("exits", [PY, "-c", "import sys; sys.exit(1)"], 30), ("hangs", [PY, "-c", "import time; time.sleep(30)"], 1)):
            result = rerun({"repository": str(self.repo)}, {"setup": [{"argv": argv, "timeout_seconds": timeout}]}, self.root / name, "lane-a",
                           commit, check("full", FULL), ["workflow.test_a.ATest.test_a_lane", "workflow.test_b.BTest.test_b_lane"], ("run_tests", 1))
            self.assertEqual((result["exit_code"], result["setup_failed"], result["log"], set(result["statuses"].values())),
                             (None, 0, "attribution/0/lane-a/setup-0.log", {"not run"}), name)
            self.assertEqual(result["setup_exit_code"] == 124, name == "hangs")
        self.assertEqual(self.rows("run_tests"), [])  # No check ran.

    def test_a_setup_failing_in_one_attribution_rerun_names_no_lane_and_spares_the_later_snapshots(self):
        """[L7], PRD 7.3 c: the cross-lane failure passes at base; setup fails in lane a's snapshot rerun only. The id is
        `not run` there, not `failed`, so lane a is not blamed, lane b's snapshot never reruns it, every lane is blocked
        unattributed and no repair starts. A setup failing at base likewise never makes an id pre-existing at base."""
        self.base()
        test_id = "workflow.test_x.XTest.test_cross"
        reason = f"run check full failed, unattributed: not run (a rerun timed out, was killed or its setup failed): {test_id}"
        for target, targets in (("lane-a", ["candidate", "base", "lane-a"]), ("base", ["candidate", "base"])):
            value = self.run_policy()
            value["setup"] = [{"argv": [PY, "-c", f"import os, sys; sys.exit(1 if '/attribution/0/{target}/' in os.getcwd() else 0)"],
                               "timeout_seconds": 60}]
            self.start(value, {"a": ("a.txt", "x"), "b": ("b.txt", "x")}, name=target)
            self.assertRegex(str(self.freeze()), "Combined candidate failed a checks")
            [attributed] = self.attribution()["checks"]
            self.assertEqual([rerun["target"] for rerun in attributed["reruns"]], targets, target)
            failed = attributed["reruns"][-1]
            self.assertEqual((failed["exit_code"], failed["setup_failed"], failed["statuses"]), (None, 0, {test_id: "not run"}))
            outcome = attributed["outcomes"][test_id]
            self.assertEqual((outcome["candidate"], outcome["result"], outcome["lane"]), ("failed", "not run", None))
            self.assertEqual(outcome["lanes"]["b"], "not run")
            for node in ("a", "b"):
                self.assertEqual((self.packet(node)["gate"]["reasons"], self.packet(node)[MARKER]["kind"]), ([reason], "unattributed"))
            self.assertIsNone(fix_decision(self.runtime, self.state()))
            self.assertFalse([start for start in self.sessions.starts if start.startswith("repair")])

    def test_one_lane_with_an_unattributed_failure_retries_to_controller_blocked_without_a_repair(self):
        """PRD 11.8 h, [L1], [G5]; challenge note 4: the identical-failure stop ends it after attempt 2."""
        self.base({"workflow/test_base.py": TEST_BASE})
        self.start(self.run_policy(lanes=("a",)), {"a": ("a.txt", "a1")})
        with patch("workflow.automatic.wait_handoffs"), self.assertRaisesRegex(RuntimeError, "failed identically on attempts 1 and 2"):
            drive(self.runtime)
        first, second = self.packet("a", 1), self.packet("a", 2)
        self.assertEqual((first["reused_from"]["path"], first["shared_record"]["path"]), ("verification/worker/a/1/packet.json", "shared-checks/0/1/record.json"))
        self.assertNotIn("reused_from", second)
        reason = "run check full failed, unattributed: pre-existing at base: workflow.test_base.BaseTest.test_base"
        self.assertEqual([first["gate"]["reasons"], second["gate"]["reasons"]], [[reason], [reason]])
        self.assertTrue(repair.unattributed_block(second))
        from .attention import load_record, states
        self.assertEqual([item["kind"] for item in states(load_record(self.directory))], ["controller_blocked"])
        messages = [message for _, _, message in self.events()]
        self.assertFalse(any("fix loop exhausted" in message or "memory pressure" in message for message in messages))
        self.assertFalse([start for start in self.sessions.starts if start.startswith("repair")])
        self.assertFalse((self.directory / "repairs.json").exists())

    def test_retrying_one_lane_raises_every_lane_and_one_record_attributes_the_run_check(self):
        """[L2] on 1.5.0, and challenge note 7: lane b's own check fails at attempt 1 beside a failing run check, so the packets
        are written as before (no run-check status) and the fix loop repairs b; after `retry --node b` both lanes run attempt
        2, cite one new record, and the run check failing on it blocks lane a, the lane attribution names."""
        self.base()
        marker = self.root / "b-fails-once"
        value = self.run_policy()
        value["workers"][1]["checks"][0]["argv"] = [PY, str(self.fake), "b", f"fail-once={marker}"]
        marker.write_text("")  # b's own check fails once, at the candidate.
        self.start(value, {"a": ("a.txt", "bad"), "b": ("b.txt", "b1")})
        error = self.freeze()
        self.assertFalse(marker.exists())
        self.assertRegex(str(error), "Combined candidate failed b checks")
        self.assertEqual((self.packet("a")["gate"]["status"], MARKER in self.packet("a")), ("passed", False))
        self.assertEqual(self.packet("b")["gate"]["reasons"][-1], "b-unit: exit 1")
        self.assertFalse((self.directory / "shared-checks/0/1" / ATTRIBUTION).exists())
        self.assertEqual(fix_decision(self.runtime, self.state()), ("b", "candidate"))
        self.runtime.retry_check("candidate", "b")
        self.assertRegex(str(self.advance(None)), "Combined candidate failed a checks")
        record = self.directory / "shared-checks/0/2" / RECORD
        for node in ("a", "b"):
            self.assertEqual(self.runtime.attempt("candidate", node), 2)
            self.assertEqual(self.packet(node, 2)["shared_record"], {"path": "shared-checks/0/2/record.json", "sha256": digest_file(record)})
        self.assertEqual(self.packet("a", 2)["gate"]["reasons"], ["run check full failed: 1 test(s) attributed to a: workflow.test_a.ATest.test_a_lane"])
        self.assertEqual(self.packet("b", 2)["gate"]["status"], "passed")

    def test_a_discover_run_check_reruns_its_ids_from_its_start_directory_and_attributes_the_lane(self):
        """[L14] (triage C): `unittest discover -s tests` names ids from `tests/`, so each rerun imports from there and is
        snapshot-attributed, never `not applicable`; the record and the brief's rerun line name the root, and test_file
        resolves the id's file under it."""
        Fixture.base(self, {"tests/test_a.py": TEST_A, "tests/test_b.py": TEST_B})
        argv = [PY, "-m", "unittest", "discover", "-s", "tests"]
        value = policy([lane(node, [check(f"{node}-unit", [PY, "-c", "print('Ran 1 test in 0.001s\\n\\nOK')", node])], [f"{node}.txt", f"tests/test_{node}.py"])
                        for node in ("a", "b")], version="1.5.0", run_checks=[check("full", argv)])
        self.start(value, {"a": ("a.txt", "a1"), "b": ("b.txt", "bad")})
        self.assertRegex(str(self.freeze()), "Combined candidate failed b checks")
        test_id = "test_b.BTest.test_b_lane"
        [attributed] = self.attribution()["checks"]
        self.assertEqual((attributed["mode"], attributed["ids"]), ("unittest", [test_id]))
        self.assertEqual(attributed["outcomes"][test_id], {"candidate": "failed", "base": "passed", "lanes": {"a": "passed", "b": "failed"},
                                                           "result": "snapshot", "lane": "b"})
        self.assertEqual([(item["target"], item["import_root"], item["argv"]) for item in attributed["reruns"]],
                         [(target, "tests", [PY, "-P", "-m", "unittest", test_id]) for target in ("candidate", "base", "lane-a", "lane-b")])
        self.assertEqual(self.packet("b")["gate"]["reasons"], [f"run check full failed: 1 test(s) attributed to b: {test_id}"])
        self.assertEqual(self.packet("a")["gate"]["status"], "passed")
        self.assertEqual(fix_decision(self.runtime, self.state()), ("b", "candidate"))
        lines = "\n".join(repair.failing_checks(self.runtime, "b", {"path": "verification/candidate/b/1/packet.json", "reasons": []}))
        self.assertIn(f"Rerun them: `PYTHONPATH=tests:.${{PYTHONPATH:+:$PYTHONPATH}} {PY} -P -m unittest {test_id}`", lines)
        self.assertEqual(test_file(str(self.repo), self.candidate_commit(), test_id, import_root(argv)), "tests/test_b.py")
        self.assertIsNone(test_file(str(self.repo), self.candidate_commit(), test_id))  # Read from `.`, the id names no file.

    def discover_run(self, files: dict, edits: dict, owned: dict | None = None) -> dict:
        """A 1.5.0 run whose one run check is `unittest discover -s tests`, over `files` at base; lane checks always pass."""
        Fixture.base(self, files)
        owned = owned or {node: [f"{node}.txt", f"tests/test_{node}.py"] for node in ("a", "b")}
        value = policy([lane(node, [check(f"{node}-unit", [PY, "-c", "print('Ran 1 test in 0.001s\\n\\nOK')", node])], owned[node])
                        for node in ("a", "b")], version="1.5.0", run_checks=[check("full", [PY, "-m", "unittest", "discover", "-s", "tests"])])
        self.start(value, edits)
        return value

    def brief_command(self, node: str) -> str:
        lines = "\n".join(repair.failing_checks(self.runtime, node, {"path": f"verification/candidate/{node}/1/packet.json", "reasons": []}))
        return re.search(r"Rerun them: `(.*)`", lines)[1]

    def test_a_root_module_shadowing_a_discovered_test_never_hides_its_failure(self):
        """f2 ([L15]): a root-level `test_b.py` that passes shadows `tests/test_b.py` unless the rerun imports from the discover
        root first, as discover does; the lane-caused failure reproduces and is snapshot-attributed to b, never `did not
        reproduce` (every lane blocked, no repair)."""
        shadow = TEST_B.replace("self.assertNotEqual(Path('b.txt').read_text(), 'bad')", "pass")
        self.discover_run({"tests/test_a.py": TEST_A, "tests/test_b.py": TEST_B, "test_b.py": shadow}, {"a": ("a.txt", "a1"), "b": ("b.txt", "bad")})
        self.assertRegex(str(self.freeze()), "Combined candidate failed b checks")
        test_id = "test_b.BTest.test_b_lane"
        [attributed] = self.attribution()["checks"]
        self.assertEqual(attributed["outcomes"][test_id], {"candidate": "failed", "base": "passed", "lanes": {"a": "passed", "b": "failed"},
                                                           "result": "snapshot", "lane": "b"})
        self.assertEqual(self.packet("b")["gate"]["reasons"], [f"run check full failed: 1 test(s) attributed to b: {test_id}"])
        self.assertEqual(self.packet("a")["gate"]["status"], "passed")

    def test_a_root_helper_shadowing_the_discover_roots_helper_never_blames_the_wrong_lane(self):
        """f2 ([L15]): `tests/test_x.py` imports `helper`, which discover finds in `tests/` (b's file) and the worktree root
        holds another (a's). Both lanes break their own helper; the failure is b's, and only b is blocked."""
        helper = "from pathlib import Path\n\n\ndef ok():\n    return Path({!r}).read_text() != 'bad'\n"
        test_x = "import unittest\n\nfrom helper import ok\n\n\nclass XTest(unittest.TestCase):\n    def test_helper(self):\n        self.assertTrue(ok())\n"
        self.discover_run({"tests/helper.py": helper.format("b.txt"), "helper.py": helper.format("a.txt"), "tests/test_x.py": test_x},
                          {"a": ("a.txt", "bad"), "b": ("b.txt", "bad")}, owned={"a": ["a.txt", "helper.py"], "b": ["b.txt", "tests/helper.py"]})
        self.assertRegex(str(self.freeze()), "Combined candidate failed b checks")
        test_id = "test_x.XTest.test_helper"
        [attributed] = self.attribution()["checks"]
        self.assertEqual(attributed["outcomes"][test_id], {"candidate": "failed", "base": "passed", "lanes": {"a": "passed", "b": "failed"},
                                                           "result": "snapshot", "lane": "b"})
        self.assertEqual(self.packet("a")["gate"]["status"], "passed")
        self.assertEqual(fix_decision(self.runtime, self.state()), ("b", "candidate"))

    def test_an_existing_pythonpath_stays_reachable_and_the_briefs_printed_command_reruns_the_discover_roots_test(self):
        """f2 ([L15]): with PYTHONPATH already naming a directory the tests import from, the rerun keeps it after the root
        and the worktree, and the brief's printed command, run through a shell from a checkout of the candidate with that
        PYTHONPATH, fails the discover root's test rather than passing the root-level shadow."""
        extra = self.root / "extra"
        extra.mkdir()
        (extra / "extra.py").write_text("NAME = 'extra'\n")
        os.environ["PYTHONPATH"] = str(extra)
        shadow = TEST_B.replace("self.assertNotEqual(Path('b.txt').read_text(), 'bad')", "pass")
        self.discover_run({"tests/test_a.py": TEST_A, "tests/test_b.py": "import extra\n" + TEST_B, "test_b.py": shadow},
                          {"a": ("a.txt", "a1"), "b": ("b.txt", "bad")})
        self.assertRegex(str(self.freeze()), "Combined candidate failed b checks")
        test_id = "test_b.BTest.test_b_lane"
        [attributed] = self.attribution()["checks"]
        self.assertEqual((attributed["outcomes"][test_id]["result"], attributed["outcomes"][test_id]["lane"]), ("snapshot", "b"))
        command = self.brief_command("b")
        self.assertEqual(command, "PYTHONPATH=tests:.${PYTHONPATH:+:$PYTHONPATH} " + shlex.join([PY, "-P", "-m", "unittest", test_id]))
        checkout = self.root / "checkout"
        subprocess.run(["git", "-C", str(self.repo), "worktree", "add", "-q", "--detach", str(checkout), self.candidate_commit()], check=True)
        done = subprocess.run(["bash", "-c", command], cwd=checkout, env={**os.environ, "PYTHONPATH": str(extra)}, capture_output=True, text=True, timeout=60)
        self.assertEqual(done.returncode, 1, done.stderr)
        self.assertIn("FAIL: test_b_lane (test_b.BTest.test_b_lane)", done.stderr)
        self.assertNotIn("No module named", done.stderr)
        without = {key: value for key, value in os.environ.items() if key != "PYTHONPATH"}
        done = subprocess.run(["bash", "-c", command], cwd=checkout, env=without, capture_output=True, text=True, timeout=60)
        self.assertIn("No module named 'extra'", done.stderr)  # The existing entry is what made `extra` importable.


class ImportRoot(unittest.TestCase):
    def test_the_import_root_of_a_discover_run_check_reads_unittests_own_forms(self):
        """[L14] and design challenge note 1 of run 004: `-t` wins over `-s`, positionals are start, pattern and top,
        `--opt=value` and `-sVALUE` are read, and a root outside the worktree or any other runner is `.`."""
        discover = [PY, "-m", "unittest", "discover"]
        cases = {("-s", "tests"): "tests", ("--start-directory", "tests"): "tests", ("--start-directory=tests",): "tests", ("-stests",): "tests",
                 ("-s", "workflow", "-t", "."): ".", ("-t", "src", "-s", "src/tests"): "src", ("--top-level-directory=src", "-s", "src/t"): "src",
                 ("tests",): "tests", ("tests", "test*.py"): "tests", ("tests", "test*.py", "."): ".", ("-v", "-k", "x", "./tests/"): "tests",
                 ("-s", "/abs/tests"): ".", ("-s", "../elsewhere"): ".", ("-s", "tests/../.."): ".", (): ".", ("-s",): "."}
        for arguments, root in cases.items():
            self.assertEqual(import_root([*discover, *arguments]), root, arguments)
        for argv in ([PY, "-m", "unittest", "tests.test_x"], [PY, "-m", "unittest", "-s", "tests"], [PY, "-m", "workflow.run_tests", "tests"],
                     ["npm", "run", "test:contracts"]):
            self.assertEqual(import_root(argv), ".", argv)

    def test_g3_discover_matches_any_case_and_a_start_that_is_no_directory_is_the_worktree_root(self):
        """G3 ([L15]): unittest reads `discover` case-insensitively, and a start that is not a directory at the commit (a
        dotted `pkg.tests`) is imported as a module from the top level, the worktree root, so its root is `.`; `-t` still
        wins, and with no commit to look at a start is taken as a directory."""
        for word in ("Discover", "DISCOVER"):
            self.assertEqual(import_root([PY, "-m", "unittest", word, "-s", "tests"]), "tests", word)
        only_tests = lambda path: path == "tests"
        discover = [PY, "-m", "unittest", "discover"]
        cases = {("-s", "pkg.tests"): ".", ("pkg.tests",): ".", ("-s", "tests"): "tests", ("-t", "src", "-s", "pkg.tests"): "src"}
        for arguments, root in cases.items():
            self.assertEqual(import_root([*discover, *arguments], only_tests), root, arguments)
        self.assertEqual(import_root([*discover, "-s", "pkg.tests"]), "pkg.tests")
        with tempfile.TemporaryDirectory() as temp:
            repository = Path(temp)
            (repository / "pkg/tests").mkdir(parents=True)
            for name in ("pkg/__init__.py", "pkg/tests/__init__.py"):
                (repository / name).write_text("")
            (repository / "pkg/tests/test_x.py").write_text(TEST_X)
            for args in (["init", "-q"], ["add", "."], ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "Base"]):
                subprocess.run(["git", "-C", str(repository), *args], check=True)
            commit = subprocess.check_output(["git", "-C", str(repository), "rev-parse", "HEAD"], text=True).strip()
            at = tree_at(str(repository), commit)
            self.assertEqual(import_root([*discover, "-s", "pkg.tests"], at), ".")
            self.assertEqual(import_root([*discover, "-s", "pkg/tests"], at), "pkg/tests")
            # The owner fallback finds the file of a dotted-start id again (a regression since c451d93).
            root = import_root([*discover, "-s", "pkg.tests"], at)
            self.assertEqual(test_file(str(repository), commit, "pkg.tests.test_x.XTest.test_cross", root), "pkg/tests/test_x.py")


class OneLaneRunChecks(Fixture):
    def test_run_checks_run_once_on_the_candidate_beside_a_reused_worker_packet(self):
        """PRD 11.7: never in the worker phase; the C28 packet carries both reused_from and shared_record."""
        self.base()
        value = policy([lane("a", [check("a-unit", [PY, str(self.fake), "lane"])], ["a.txt"])], version="1.5.0",
                       run_checks=[check("full", [PY, str(self.fake), "full"])])
        self.start(value, {"a": ("a.txt", "a1")})
        self.assertIsNone(self.freeze())
        self.assertEqual((len(self.rows("full", "worker")), len(self.rows("full")), len(self.rows("lane"))), (0, 1, 0))
        packet = self.packet("a")
        record = self.directory / "shared-checks/0/1" / RECORD
        self.assertEqual(packet["reused_from"]["path"], "verification/worker/a/1/packet.json")
        self.assertEqual(packet["shared_record"], {"path": "shared-checks/0/1/record.json", "sha256": digest_file(record)})
        self.assertEqual(read_json(record)["lanes"], [])  # The reused lane's checks are its worker packet's.
        self.assertEqual(recheck_packet(self.packet("a"), value, self.directory)["gate"]["status"], "passed")
        self.runtime.validate_bundle()
        self.assertIn(("candidate", "running", f"Shared checks: 1 commands for 0 lane checks on {self.candidate_commit()}; run checks: 1"), self.events())


class Compatibility(Fixture):
    def test_a_1_5_0_run_exports_the_same_key_sets_and_its_citations_name_their_targets(self):
        """PRD 9 and 11.11: no new export keys, packets only at the lane paths, `reused_from` a worker packet and
        `shared_record` a shared record, both rechecked."""
        self.base()
        shared = [PY, str(self.fake), "shared"]
        value = policy([lane("a", [check("a-unit", shared)], ["a.txt"]), lane("b", [check("b-unit", shared)], ["b.txt"])], version="1.5.0",
                       run_checks=[check("full", [PY, str(self.fake), "full"])])
        self.start(value, {"a": ("a.txt", "a1"), "b": ("b.txt", "b1")})
        self.assertIsNone(self.freeze())
        exported = export_run(ExportRuntime(self.directory))
        self.assertEqual(set(exported), {"version", "run_id", "base_commit", "created_at", "definition", "values", "next", "tasks", "events",
                                         "verification_packets", "review", "inputs", "sidecar", "attack", "panels", "costs", "updated_at",
                                         "fix_loop", "accepted"})
        self.assertEqual(exported["version"], "1.12.0")
        inputs = exported["inputs"]
        self.assertEqual(set(inputs), {"feature", "policy_version", "base_commit", "source_branch", "mode", "automatic", "setup",
                                       "max_verification_attempts", "failure_drill", "selected_workers", "excluded_workers", "decisions",
                                       "challenge", "workers"})  # `roles` and `controller` too when launch pinned them; prepare alone does not.
        self.assertEqual(inputs["policy_version"], "1.5.0")
        for node in ("a", "b"):
            self.assertEqual(set(inputs["workers"][node]), {"role", "required_check_kinds", "task", "prompt", "owned_paths", "checks", "launch",
                                                            "completion", "handoff", "stop", "questions", "roles", "skills"})
            self.assertEqual([item["id"] for item in inputs["workers"][node]["checks"]], [f"{node}-unit"])  # Its lane checks only.
            self.assertEqual(set(inputs["workers"][node]["checks"][0]), {"id", "kind", "argv", "command", "timeout_seconds", "scenarios"})
        for entry in exported["verification_packets"]:
            self.assertEqual(set(entry), {"phase", "node_id", "attempt", "path", "sha256"})
        found = sorted(str(path.relative_to(self.directory)) for path in self.directory.rglob("packet.json") if "worktree" not in path.parts)
        self.assertEqual(found, sorted(entry["path"] for entry in exported["verification_packets"]))
        self.assertTrue(all(re.fullmatch(r"verification/(worker|candidate)/[a-z]+/\d+/packet\.json", path) for path in found))
        self.citations(value)

    def citations(self, value: dict) -> None:
        for path in sorted(self.directory.glob("verification/candidate/*/*/packet.json")):
            packet = read_json(path)
            if "reused_from" in packet:
                self.assertRegex(packet["reused_from"]["path"], r"^verification/worker/[^/]+/\d+/packet\.json$")
            self.assertRegex(packet["shared_record"]["path"], r"^shared-checks/\d+/\d+/record\.json$")
            self.assertEqual(recheck_packet(packet, value, self.directory)["gate"]["status"], "passed")
            target = read_json(self.directory / packet["shared_record"]["path"])
            self.assertNotIn("phase", target)  # A record, never a packet.

    def run_only(self, lanes: tuple, name: str) -> dict:
        """A passing 1.5.0 run of `lanes`, each with its own fake check, and one run check no lane declares."""
        value = policy([lane(node, [check(f"{node}-unit", [PY, str(self.fake), node])], [f"{node}.txt"]) for node in lanes], version="1.5.0",
                       run_checks=[check("full", [PY, str(self.fake), "full"])])
        self.start(value, {node: (f"{node}.txt", f"{node}1") for node in lanes}, name=name)
        self.assertIsNone(self.freeze())
        return value

    def test_a_changed_or_missing_run_only_log_fails_recheck(self):
        """[L6] (triage D), PRD 11.5: a run check's log belongs to no lane; every packet citing the record vouches for it,
        the reused C28 one too."""
        self.base()
        for lanes, name in ((("a", "b"), "two"), (("a",), "one")):
            value = self.run_only(lanes, name)
            self.assertEqual("reused_from" in self.packet("a"), name == "one")
            [execution] = [item for item in self.record()["executions"] if item["run_checks"]]
            log = self.directory / "shared-checks/0/1" / execution["log"]
            original = log.read_bytes()
            for tamper in (lambda: log.write_bytes(original + b"edited\n"), log.unlink):
                tamper()
                for node in lanes:
                    with self.subTest(run=name, node=node), self.assertRaisesRegex(ValueError, r"^run check full: the shared execution's log changed$"):
                        recheck_packet(self.packet(node), value, self.directory)
                with self.assertRaisesRegex(ValueError, "run check full: the shared execution's log changed"):
                    self.runtime.validate_bundle()
                log.write_bytes(original)
            self.runtime.validate_bundle()

    def test_a_1_5_0_candidate_packet_without_its_shared_record_fails_recheck_and_the_bundle(self):
        """[L6] (triage E), PRD 6.3 and 11.11: on the regular path and on the reused (C28) one. Worker packets cite no record
        and stay valid; the C28 packet's inner gate of its worker packet is not refused (challenge note 2)."""
        self.base()
        for lanes, name in ((("a", "b"), "two"), (("a",), "one")):
            value = self.run_only(lanes, name)
            for node in lanes:
                worker = read_json(self.directory / "verification/worker" / node / "1/packet.json")
                self.assertEqual((recheck_packet(worker, value, self.directory)["gate"]["status"], "shared_record" in worker), ("passed", False))
            path = self.packet_path("a")
            packet = read_json(path)
            self.assertEqual("reused_from" in packet, name == "one")
            del packet["shared_record"]
            with self.subTest(run=name), self.assertRaisesRegex(ValueError, r"^Candidate packet of a attempt 1 cites no shared record"):
                recheck_packet(dict(packet), value, self.directory)
            save_json(path, packet)
            # The bundle names the edited packet's new digest, so only the missing citation can refuse it.
            bundle_path = self.directory / "review-bundle.json"
            bundle = read_json(bundle_path)
            for reference in bundle["packets"]:
                if Path(reference["path"]).resolve() == path.resolve():
                    reference["sha256"] = digest_file(path)
            save_json(bundle_path, bundle)
            with self.subTest(run=name), self.assertRaisesRegex(ValueError, "cites no shared record"):
                self.runtime.validate_bundle()

    def test_the_c28_packet_cites_a_worker_packet_and_a_record(self):
        self.base()
        value = policy([lane("a", [check("a-unit", [PY, str(self.fake), "lane"])], ["a.txt"])], version="1.5.0",
                       run_checks=[check("full", [PY, str(self.fake), "full"])])
        self.start(value, {"a": ("a.txt", "a1")})
        self.assertIsNone(self.freeze())
        self.citations(value)
        # A `reused_from` that names a record is refused on recheck.
        packet = self.packet("a")
        packet["reused_from"] = dict(packet["shared_record"])
        with self.assertRaisesRegex(ValueError, "is not the worker packet of a"):
            recheck_packet(packet, value, self.directory)
        # And a `shared_record` that names a packet.
        packet = self.packet("a")
        packet["shared_record"] = {"path": "verification/worker/a/1/packet.json", "sha256": digest_file(self.directory / "verification/worker/a/1/packet.json")}
        with self.assertRaisesRegex(ValueError, "is not a shared record of the run"):
            recheck_packet(packet, value, self.directory)


class PolicyRules(unittest.TestCase):
    def lanes(self) -> list:
        return [lane("a", [check("a-unit", ["python", "-m", "unittest"])], ["a"]), lane("b", [check("b-unit", ["python", "-c", "pass"])], ["b"])]

    def test_policy_1_5_0_accepts_run_checks_and_refuses_four_kinds_of_run_check(self):
        """PRD 11.6."""
        full = check("full", ["python", "-m", "workflow.run_tests"])
        validate_policy(policy(self.lanes(), "1.5.0", [full]))
        validate_policy(policy(self.lanes(), "1.5.0"))
        with self.assertRaises(ValidationError):
            validate_policy(policy(self.lanes(), "1.5.0", [check("e2e", ["npx", "playwright", "test"], "browser", scenarios=SCENARIOS)]))
        with self.assertRaisesRegex(ValueError, "Run check a-unit has the id of a lane check"):
            validate_policy(policy(self.lanes(), "1.5.0", [check("a-unit", ["python", "-m", "workflow.run_tests"])]))
        with self.assertRaisesRegex(ValueError, "Each run check needs a distinct command"):
            validate_policy(policy(self.lanes(), "1.5.0", [full, {**full, "id": "again"}]))
        with self.assertRaises(ValidationError):
            validate_policy(policy(self.lanes(), "1.4.0", [full]))
        with self.assertRaisesRegex(ValueError, "Duplicate id"):
            validate_policy(policy(self.lanes(), "1.5.0", [full, {**full, "argv": ["python", "-V"]}]))
        # A run check never satisfies a lane's required kind.
        lanes = self.lanes()
        lanes[1]["required_check_kinds"] = ["unit", "contract"]
        with self.assertRaisesRegex(ValueError, r"b requires \['contract', 'unit'\] checks; missing \['contract'\]"):
            validate_policy(policy(lanes, "1.5.0", [check("contracts", ["npm", "run", "test:contracts"], "contract")]))

    def test_policy_1_5_0_keeps_everything_1_4_0_accepts(self):
        """The keeps-everything test (learning version-gates-are-sets): every committed policy, example and fixture still
        validates, and each 1.2.0-1.4.0 one validates as 1.5.0 too, attack_check and critique_app included."""
        found = [*REPO.glob("features/*/policy.json"), CONTRACTS / "verification.example.json", *(REPO / "workflow" / "testdata").rglob("policy.json")]
        self.assertTrue(found)
        for path in found:
            with self.subTest(path=str(path.relative_to(REPO))):
                value = json.loads(path.read_text())
                validate_policy(value)
                if value["version"] not in ("1.0.0", "1.1.0"):
                    validate_policy({**value, "version": "1.5.0"})
        extras = {"attack_check": {"argv": ["npx", "vitest", "run", "{file}"], "timeout_seconds": 60},
                  "critique_app": {"argv": ["npm", "run", "dev"], "ready_path": "/", "timeout_seconds": 60}}
        for version in ("1.4.0", "1.5.0"):
            validate_policy({**policy(self.lanes(), version), **extras})

    def test_the_lint_note_names_lanes_sharing_a_command(self):
        """PRD 11.12."""
        shared = ["python", "-m", "workflow.run_tests", "--jobs", "4"]
        two = policy([lane("a", [check("a-unit", shared)], ["a"]), lane("b", [check("b-unit", shared)], ["b"])])
        self.assertEqual(policy_lint(two, None), [
            "lanes a, b declare python -m workflow.run_tests --jobs 4: it runs once at the candidate but once per lane in the worker phase; "
            "move it to run_checks (policy 1.5.0) and give the lanes targeted checks"])
        one = policy([lane("a", [check("a-unit", shared)], ["a"]), lane("b", [check("b-unit", ["python", "-c", "pass"])], ["b"])])
        self.assertEqual(policy_lint(one, None), [])
        browser = check("e2e", ["npx", "playwright", "test"], "browser", scenarios=SCENARIOS)
        self.assertEqual(policy_lint(policy([lane("a", [browser], ["a"]), lane("b", [{**browser, "id": "e2e-b"}], ["b"])]), None), [])


class RunTestsSelection(unittest.TestCase):
    """`run_tests --tests` (PRD 11.9) and the failing-id parser (PRD 11.10), on a package of tests in a temporary directory."""

    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.ran = self.root / "ran"
        (self.root / "pkg").mkdir()
        (self.root / "pkg/__init__.py").write_text("")
        record = f"open({str(self.ran)!r}, 'a').write(self.id() + '\\n')"
        (self.root / "pkg/test_m.py").write_text(
            "import unittest\n\n\nclass C(unittest.TestCase):\n"
            f"    def test_ok(self):\n        {record}\n\n    def test_bad(self):\n        {record}\n        self.assertEqual(1, 2)\n\n\n"
            f"class D(unittest.TestCase):\n    def test_d(self):\n        {record}\n")
        (self.root / "pkg/test_crash.py").write_text("import unittest\n\n\nclass E(unittest.TestCase):\n    @classmethod\n    def setUpClass(cls):\n"
                                                     "        raise RuntimeError('crashed')\n\n    def test_e(self):\n        pass\n")

    def run_tests(self, *arguments: str) -> subprocess.CompletedProcess:
        environment = {key: value for key, value in os.environ.items() if not key.startswith("WORKFLOW_") and key != "PYTHONSAFEPATH"}
        return subprocess.run([PY, "-m", "workflow.run_tests", "--jobs", "2", *arguments], cwd=self.root, capture_output=True, text=True,
                              env={**environment, "PYTHONPATH": str(REPO)}, timeout=120)

    def test_tests_runs_exactly_the_named_ids_and_reports_an_unknown_one_as_a_failing_class(self):
        result = self.run_tests("--tests", "pkg.test_m.C.test_ok", "pkg.test_m.D", "pkg.missing.Nope")
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertEqual(sorted(self.ran.read_text().split()), ["pkg.test_m.C.test_ok", "pkg.test_m.D.test_d"])
        self.assertIn("ok   pkg.test_m.C (1 tests)", result.stdout)
        self.assertIn("FAIL pkg.missing.Nope (0 tests)\n    WORKFLOW: no test named pkg.missing.Nope: ", result.stdout)
        self.assertEqual(text_test_counts(result.stdout), {"passed": 1, "failed": 1, "skipped": 0})
        self.ran.unlink()
        result = self.run_tests("--tests", "pkg.test_m")
        self.assertEqual(sorted(self.ran.read_text().split()), ["pkg.test_m.C.test_bad", "pkg.test_m.C.test_ok", "pkg.test_m.D.test_d"])
        self.assertEqual(text_test_counts(result.stdout), {"passed": 2, "failed": 1, "skipped": 0})
        refused = self.run_tests("pkg", "--tests", "pkg.test_m")
        self.assertEqual(refused.returncode, 2)
        self.assertIn("--tests names the tests to run: it takes no start_dir", refused.stderr)

    def test_the_failing_ids_of_run_tests_and_plain_unittest_output(self):
        result = self.run_tests("--tests", "pkg.test_m", "pkg.test_crash")
        # A class with passing and failing methods gives its failing method; a crashed class its class id.
        self.assertEqual(failing_ids(result.stdout), ["pkg.test_m.C.test_bad", "pkg.test_crash.E"])
        listed = [name for name, _ in failures(result.stdout)]
        self.assertEqual(listed, ["FAIL: test_bad (pkg.test_m.C.test_bad)", "ERROR: setUpClass (pkg.test_crash.E)"])
        self.assertEqual(failures(result.stdout)[0][1], "AssertionError: 1 != 2")
        plain = subprocess.run([PY, "-m", "unittest", "pkg.test_m", "pkg.test_crash"], cwd=self.root, capture_output=True, text=True, timeout=60)
        self.assertEqual(failing_ids(plain.stderr), ["pkg.test_crash.E", "pkg.test_m.C.test_bad"] if plain.stderr.index("setUpClass") < plain.stderr.index("test_bad")
                         else ["pkg.test_m.C.test_bad", "pkg.test_crash.E"])
        self.assertIn(("FAIL: test_bad (pkg.test_m.C.test_bad)", "AssertionError: 1 != 2"), failures(plain.stderr))


    def test_an_interrupted_rerun_passes_no_id(self):
        """[L7]: a rerun that timed out (124) or was killed passes no id; a failure header still fails its id, an absent
        test stays not applicable, and a crash before any summary still fails every id."""
        selected = self.run_tests("--tests", "pkg.test_m.C.test_bad", "pkg.test_m.C.test_ok", "pkg.test_gone.X.test_x")
        ids = ["pkg.test_m.C.test_bad", "pkg.test_m.C.test_ok", "pkg.test_gone.X.test_x"]
        self.assertEqual(statuses(ids, selected.stdout, selected.returncode, {"kind": "unit"}, ("run_tests", 1)),
                         {ids[0]: "failed", ids[1]: "passed", ids[2]: "not applicable"})
        cut = selected.stdout.split("-" * 70)[0] + "\nWORKFLOW: timeout; process group terminated\n"
        for code in (124, -9, 137):
            self.assertEqual(statuses(ids, cut, code, {"kind": "unit"}, ("run_tests", 1)),
                             {ids[0]: "failed", ids[1]: "not run", ids[2]: "not applicable"}, code)
            self.assertEqual(statuses(["full"], "", code, {"kind": "build"}, None), {"full": "not run"}, code)
        self.assertEqual(statuses(ids[1:2], "Traceback (most recent call last):\n", 1, {"kind": "unit"}, ("run_tests", 1)), {ids[1]: "failed"})
        self.assertEqual(statuses(["full"], "", 1, {"kind": "build"}, None), {"full": "failed"})

    def test_a_module_that_fails_to_import_is_a_failing_id_that_reproduces(self):
        """PRD 8.2 and 7.3 a: plain unittest names an unimportable module by its loader pseudo-id; the parser gives the
        module, and a rerun of it fails, while a module or attribute absent at a commit is not applicable."""
        (self.root / "pkg/test_broken.py").write_text("import unittest\nimport no_such_dependency\n\n\nclass B(unittest.TestCase):\n"
                                                      "    def test_b(self):\n        pass\n")
        environment = {key: value for key, value in os.environ.items() if key != "PYTHONSAFEPATH"}
        discover = subprocess.run([PY, "-m", "unittest", "discover", "-s", "pkg", "-t", "."], cwd=self.root, capture_output=True, text=True, timeout=60, env=environment)
        self.assertIn("ERROR: pkg.test_broken (unittest.loader._FailedTest.pkg.test_broken)", discover.stderr)
        self.assertIn("pkg.test_broken", failing_ids(discover.stderr))
        self.assertFalse([item for item in failing_ids(discover.stderr) if item.startswith("unittest.loader")])
        ids = ["pkg.test_broken", "pkg.test_absent.X.test_x", "pkg.test_m.C.test_none", "pkg.test_m.C.test_ok"]
        plain = subprocess.run([PY, "-m", "unittest", *ids], cwd=self.root, capture_output=True, text=True, timeout=60, env=environment)
        expected = {"pkg.test_broken": "failed", "pkg.test_absent.X.test_x": "not applicable", "pkg.test_m.C.test_none": "not applicable",
                    "pkg.test_m.C.test_ok": "passed"}
        self.assertEqual(statuses(ids, plain.stderr, plain.returncode, {"kind": "unit"}, ("unittest", 1)), expected)
        selected = self.run_tests("--tests", *ids)
        self.assertEqual(statuses(ids, selected.stdout, selected.returncode, {"kind": "unit"}, ("run_tests", 1)), expected)


if __name__ == "__main__":
    unittest.main()
