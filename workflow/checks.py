"""Local, isolated check execution and artifact capture. Never launches agents.

RUNBOOK "Verification policy and evidence" and §1: every setup and check command runs with one environment
(verification_environment), the controller's interpreter first on PATH."""
from __future__ import annotations

import hashlib
import json
import os
import re
import shlex
import shutil
import signal
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

from .browser_queue import browser_slot
from .sessions import git, save_json, scrub_env, terminate
from .verification import evaluate_worker, policy_digest
from .worktrees import WorktreeError, git_worktree, without_controller_git_config


def now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def execute(argv: list[str], cwd: Path, log: Path, timeout: int, env: dict) -> tuple[int, str, str]:
    started = now()
    with log.open("wb") as output:
        process = subprocess.Popen(argv, cwd=cwd, env=env, stdin=subprocess.DEVNULL,
                                   stdout=output, stderr=subprocess.STDOUT, start_new_session=True)
        try:
            code = process.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            terminate(process)
            output.write(b"\nWORKFLOW: timeout; process group terminated\n")
            code = 124
        except BaseException:
            terminate(process)
            raise
        finally:
            # Test runners must not leave servers or descendant writers alive.
            # terminate also signals the group after the group leader has exited.
            terminate(process)
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            output.flush()
            os.fsync(output.fileno())
    return code, started, now()


# A check killed under memory pressure is no verdict on the code (15 verify failures in 7 pine runs were vitest workers the
# kernel killed): its process ended on SIGKILL (-9, or 137 from a shell), or one of the last 20 lines of its log is the
# shell's bare `Killed` or names an out-of-memory failure. Any other signal (a SIGSEGV) and a marker inside a longer line
# about something else (a test named test_killed, a log that mentions SIGKILL) are failures like any other. The gate still
# blocks; automatic.check_retries reruns it free.
MEMORY_LINE = "Killed"  # The shell's report of a child the kernel killed: the whole line.
MEMORY_MARKERS = ("FATAL ERROR: Reached heap limit", "JavaScript heap out of memory", "ENOMEM", "Cannot allocate memory",
                  "Killed process", "out of memory")
MEMORY_TAIL_LINES = 20


def memory_killed(code: int, log: Path) -> bool:
    """Whether a failed check's process was killed for memory: SIGKILL, or a memory line in its log's last 20 lines.

    A timeout (exit 124, execute's own kill), another signal and a passing check never are."""
    if code in (0, 124):
        return False
    if code in (-signal.SIGKILL, 128 + signal.SIGKILL):
        return True
    try:
        tail = [line.strip() for line in log.read_text(errors="replace").splitlines()[-MEMORY_TAIL_LINES:]]
    except OSError:
        return False
    return any(line == MEMORY_LINE or any(marker in line for marker in MEMORY_MARKERS) for line in tail)


def disk_killed(code: int, log: Path) -> bool:
    """Whether a failed check ran out of disk: its log's last lines name a full disk or quota (repair.disk_full_text, the
    signatures and errno forms a disk-full attempt is recognised by). A passing check never is."""
    from .repair import DISK_TAIL_LINES, disk_full_text
    if code == 0:
        return False
    try:
        return disk_full_text("\n".join(log.read_text(errors="replace").splitlines()[-DISK_TAIL_LINES:]))
    except OSError:
        return False


# A check that hit its timeout while the host was overloaded is no verdict on the code either (workflow-collected-fixes-001: the
# workflow suite took 2400 s of 2400 s at load average 12-21 on 4 cores beside another run's browser suites, and 556-576 s on a
# quiet host). It is a timeout (exit 124, execute's own kill) and, when it ended, the 5- or 15-minute load average was at least
# LOAD_FACTOR times the CPU count (WORKFLOW_LOAD_FACTOR overrides it). A check's own parallel work keeps the load near the CPU
# count, so it alone never qualifies; a timeout on a quiet host is a failure like any other. automatic.check_retries reruns it
# free, as a memory kill.
LOAD_FACTOR = 2.0


def load_factor() -> float:
    try:
        return float(os.environ.get("WORKFLOW_LOAD_FACTOR", LOAD_FACTOR))
    except ValueError:
        return LOAD_FACTOR


def overloaded_timeout(code: int, read=None, cores=None) -> bool:
    """Whether a failed check timed out (exit 124) while the 5- or 15-minute load average was at least load_factor() times the
    CPU count. Any other exit, and a load that cannot be read, never is."""
    if code != 124:
        return False
    try:
        _, five, fifteen = (read or os.getloadavg)()
    except OSError:
        return False
    return max(five, fifteen) >= load_factor() * ((cores or os.cpu_count)() or 1)


def transient_kind(code: int, log: Path) -> str | None:
    """The execution's `transient`: "memory" for a memory kill (memory_killed), else "disk" for a full disk (disk_killed), else
    "load" for a timeout under host load (overloaded_timeout), else None."""
    if memory_killed(code, log):
        return "memory"
    if disk_killed(code, log):
        return "disk"
    return "load" if overloaded_timeout(code) else None


def text_test_counts(log: str) -> dict | None:
    text = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", log)
    unit = re.search(r"^Ran (\d+) tests? in .+$", text, re.MULTILINE)
    if unit:
        total = int(unit[1])
        skipped = re.search(r"\bskipped=(\d+)", text)
        skipped = int(skipped[1]) if skipped else 0
        failures = sum(int(value) for value in re.findall(r"\b(?:failures|errors|unexpected successes)=(\d+)", text))
        if not re.search(r"^(?:OK(?:\s|$)|FAILED\s*\()", text, re.MULTILINE):
            return None
        return {"passed": max(0, total - skipped - failures), "failed": failures, "skipped": skipped}
    # Vitest's summary and Node's TAP and spec reporters. A log can hold several (a script that runs both, or a
    # reporter that restates vitest's counts), so each field takes the largest count: a failure anywhere stays
    # a failure and a restated summary is not counted twice. Any summary that does not add up is no evidence.
    found = [counts for counts in (vitest_counts(text), node_counts(text)) if counts is not None]
    if not found or any(counts is INVALID for counts in found):
        return None
    return {key: max(counts[key] for counts in found) for key in ("passed", "failed", "skipped")}


# A summary that is present but not self-consistent: the whole log is then no test evidence.
INVALID = {"passed": 0, "failed": 0, "skipped": 0, "invalid": True}


def node_counts(text: str) -> dict | None:
    """Node's TAP and spec reporters (`# tests 4`, `ℹ pass 3`): a complete self-consistent summary, else INVALID."""
    counts = {}
    for key in ("tests", "pass", "fail", "skipped", "cancelled", "todo"):
        found = re.findall(rf"^[#ℹ]\s+{key}\s+(\d+)\s*$", text, re.MULTILINE)
        if found:
            counts[key] = int(found[-1])
    if not counts:
        return None
    if {"tests", "pass", "fail", "skipped"} <= counts.keys():
        if sum(counts.get(key, 0) for key in ("pass", "fail", "skipped", "cancelled", "todo")) == counts["tests"]:
            return {"passed": counts["pass"], "failed": counts["fail"] + counts.get("cancelled", 0),
                    "skipped": counts["skipped"] + counts.get("todo", 0)}
    return INVALID


VITEST_TOTAL = re.compile(r"^\s*(Test Files|Tests)\s+(\d+ [a-z ]+?(?: \| \d+ [a-z ]+?)*)\s+\((\d+)\)\s*$", re.MULTILINE)
VITEST_ERRORS = re.compile(r"^\s*Errors\s+(\d+) errors?\b", re.MULTILINE)
# `expected fail` is a `test.fails` test that failed as it should: a pass.
VITEST_STATES = {"passed": "passed", "expected fail": "passed", "failed": "failed", "skipped": "skipped", "todo": "skipped"}


def vitest_counts(text: str) -> dict | None:
    """Vitest's run summaries (`Tests  1 failed | 69 passed (70)`), summed over every run in the log; INVALID when a
    summary does not add up or names an unknown state.

    A test file that failed to load and an unhandled error are failures too, though no test in the count failed.
    """
    totals = {"passed": 0, "failed": 0, "skipped": 0}
    seen = False
    for label, parts, total in VITEST_TOTAL.findall(text):
        counts = {}
        for part in parts.split(" | "):
            number, state = part.split(" ", 1)
            if state not in VITEST_STATES:
                return INVALID
            counts[state] = counts.get(state, 0) + int(number)
        if sum(counts.values()) != int(total):
            return INVALID
        if label == "Tests":
            seen = True
            for state, number in counts.items():
                totals[VITEST_STATES[state]] += number
        else:
            totals["failed"] += counts.get("failed", 0)
    if not seen:
        return INVALID if totals["failed"] else None
    totals["failed"] += sum(int(value) for value in VITEST_ERRORS.findall(text))
    return totals


class Capture:
    def __init__(self, directory: Path):
        self.directory = directory
        self.artifacts = []
        self.paths = {}

    def add(self, source: Path, kind: str, path: str | None = None, content: bytes | None = None) -> str:
        if not source.is_file() or source.is_symlink():
            raise ValueError("Evidence must be a regular file")
        if content is None:
            content = source.read_bytes()
        digest = hashlib.sha256(content).hexdigest()
        artifact_id = f"{kind}-{len(self.artifacts)}-{digest[:12]}"
        destination = self.directory / artifact_id
        with destination.open("xb") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        destination.chmod(0o400)
        self.artifacts.append({"artifact_id": artifact_id, "kind": kind, **({"path": path} if path is not None else {}),
                               "uri": destination.name, "sha256": digest})
        self.paths[artifact_id] = destination
        return artifact_id


FILE_CAPTURE_LIMIT = 512 * 1024              # Bytes of one changed file captured as a `file` artifact.
PACKET_FILE_CAPTURE_LIMIT = 8 * 1024 * 1024  # Bytes of captured files per worker-phase packet.


def is_text(content: bytes) -> bool:
    """Text is UTF-8 without a NUL byte."""
    try:
        content.decode("utf-8")
    except UnicodeDecodeError:
        return False
    return b"\0" not in content


def capture_changed_files(worktree: Path, changed: list[str], capture: Capture) -> list[dict]:
    """Copy each changed text file of the snapshot into the packet as a `file` artifact, in order.

    Returns `files_not_captured`: every other changed path with its reason. `missing` covers anything that is not
    a regular file inside the worktree (deleted, renamed away, a symbolic link or a submodule).
    """
    root = worktree.resolve()
    skipped, total = [], 0
    for path in changed:
        source = worktree / path
        try:
            regular = not source.is_symlink() and source.is_file() and source.resolve(strict=True).is_relative_to(root)
        except OSError:
            regular = False
        if not regular:
            skipped.append({"path": path, "reason": "missing"})
            continue
        with source.open("rb") as handle:
            content = handle.read(FILE_CAPTURE_LIMIT + 1)
        if len(content) > FILE_CAPTURE_LIMIT:
            skipped.append({"path": path, "reason": "too_large"})
            continue
        if not is_text(content):
            skipped.append({"path": path, "reason": "binary"})
        elif total + len(content) > PACKET_FILE_CAPTURE_LIMIT:
            skipped.append({"path": path, "reason": "budget"})
        else:
            capture.add(source, "file", path=path, content=content)
            total += len(content)
    return skipped


SCENARIO_TITLE = re.compile(r"\[scenario:([^\]]+)\]")
NOT_COVERED = "Playwright report does not cover every required scenario"


def scenario_evidence(report: dict, required: set[str], screenshot) -> tuple[dict, dict, list[tuple[str | None, str]]]:
    """The verifier's scenario rules for a parsed Playwright JSON report; `check-report` applies the same function.

    Each required scenario id appears in exactly one test title as `[scenario:<id>]`, and its test, when it passed
    (status expected, one result, no retries), has exactly one image/png attachment named `screenshot:<id>`; other
    attachments are ignored. `screenshot(scenario_id, path)` gets that attachment's path, in report order, and returns
    what the scenario records; a ValueError or OSError it raises is that scenario's problem.

    Returns the test counts, the scenarios found by id (`{id, status, screenshot}`) and every problem in report order
    as (scenario id, message). Report-wide problems have no scenario id: global errors first, NOT_COVERED last. A
    scenario's own problems concern only its test's title and screenshot, which are the lane's own work whatever
    another lane changes; a failed or skipped scenario is no problem here, the gate reports it.
    """
    problems = []
    if report.get("errors"):
        problems.append((None, "Playwright reported global errors"))
    specs = []
    def walk(suite):
        specs.extend(suite.get("specs", []))
        for child in suite.get("suites", []):
            walk(child)
    walk(report)
    found = {}
    counts = {"passed": 0, "failed": 0, "skipped": 0}
    for spec in specs:
        for test in spec.get("tests", []):
            results = test.get("results", [])
            # No flaky retries or expected failures counted as passing verification.
            passed = test.get("status") == "expected" and test.get("expectedStatus") == "passed" and len(results) == 1 and results[0].get("status") == "passed"
            skipped = test.get("status") == "skipped"
            counts["passed" if passed else "skipped" if skipped else "failed"] += 1
            matches = set(SCENARIO_TITLE.findall(spec.get("title", ""))) & required
            for scenario_id in matches:
                if scenario_id in found:
                    problems.append((scenario_id, f"Duplicate browser scenario/project result: {scenario_id}"))
                    continue
                recorded = None
                if passed:
                    attachments = [item for item in results[0].get("attachments", [])
                                   if item.get("name") == f"screenshot:{scenario_id}" and item.get("contentType") == "image/png"]
                    if len(attachments) != 1:
                        problems.append((scenario_id, f"Expected one screenshot attachment for {scenario_id}"))
                    else:
                        try:
                            recorded = screenshot(scenario_id, attachments[0].get("path", ""))
                        except (ValueError, OSError) as error:
                            problems.append((scenario_id, str(error)))
                found[scenario_id] = {"id": scenario_id, "status": "passed" if passed else "skipped" if skipped else "failed",
                                      "screenshot": recorded}
    if set(found) != required:
        problems.append((None, NOT_COVERED))
    return counts, found, problems


class BrowserEvidenceError(ValueError):
    """A report that breaks the scenario rules. The message is the first problem, the one the verifier has always
    recorded; `scenario_problems` are the problems of single scenarios' tests (see scenario_evidence)."""

    def __init__(self, problems: list[tuple[str | None, str]]):
        super().__init__(problems[0][1])
        self.scenario_problems = [message for scenario_id, message in problems if scenario_id is not None]


def browser_evidence(report_path: Path, output_root: Path, requirement: dict, capture: Capture) -> tuple[dict, list]:
    report = json.loads(report_path.read_text())
    def screenshot(scenario_id, attachment):
        path = Path(attachment).resolve(strict=True)
        if not path.is_relative_to(output_root.resolve()):
            raise ValueError("Screenshot attachment outside isolated browser output directory")
        return capture.add(path, "screenshot")
    counts, found, problems = scenario_evidence(report, {case["id"] for case in requirement["scenarios"]}, screenshot)
    if problems:
        raise BrowserEvidenceError(problems)
    return counts, [{"id": item["id"], "status": item["status"], "screenshot_artifact_id": item["screenshot"]} for item in found.values()]


# What a passed attempt no longer needs (C47): the checkout and caches its checks ran in, and Playwright's raw output, whose
# screenshots are already artifacts. The folder, packet.json, the logs, artifacts/ and browser-report-<n>.json stay, and so
# does the raw output of a browser check that failed: deferred in the worker phase, it fails without failing the attempt,
# and its failure screenshots and traces may be in that output only.
PRUNED_CACHES = ("npm_config_cache", "xdg_cache_home")
RAW_BROWSER_OUTPUT = re.compile(r"browser-(\d+)")


def remove_tree(path: Path) -> None:
    """shutil.rmtree that also removes what a check left read-only (an npm cache entry, a Go module cache), or unreadable."""
    def writable(function, name, _):
        if function in (os.open, os.scandir, os.listdir):
            # A directory rmtree cannot open or list: make it the owner's again and remove it whole. rmtree goes on.
            os.chmod(name, 0o700)
            remove_tree(Path(name))
            return
        if function in (os.lstat, os.unlink):
            # In a directory its owner can list but not search (0o400, 0o600) every entry's lstat and unlink fail with
            # EACCES, and so would lexists below: search it first.
            os.chmod(os.path.dirname(name), 0o700)
        if not os.path.lexists(name):
            return  # Removed above, after a failed listing of it.
        os.chmod(os.path.dirname(name), 0o700)
        if os.path.isdir(name) and not os.path.islink(name):
            os.chmod(name, 0o700)
            if function is os.lstat:  # rmtree skipped the entry it could not stat: remove it whole, as an unlistable one.
                remove_tree(Path(name))
                return
        if function is os.lstat:
            os.unlink(name)
            return
        function(name)
    if sys.version_info >= (3, 12):
        shutil.rmtree(path, onexc=writable)
    else:
        shutil.rmtree(path, onerror=lambda function, name, info: writable(function, name, info[1]))


def registered_worktree(repository, path: Path) -> bool:
    """Whether `git worktree list` still names this path."""
    listed = git(repository, "worktree", "list", "--porcelain").splitlines()
    return f"worktree {path.resolve()}" in listed or f"worktree {path}" in listed


def remove_worktree(repository, path: Path) -> None:
    """`git worktree remove --force`, under the repository's worktree lock. A removal that fails partway (read-only content)
    still unregisters the worktree, and Git then refuses the leftover as "not a working tree" for good: once Git no longer
    lists the path, the leftover is deleted and pruned. An independent repository (a `.git` directory) is never deleted."""
    try:
        git_worktree(repository, "remove", "--force", str(path))
        return
    except WorktreeError:
        if not (path.exists() or path.is_symlink()) or registered_worktree(repository, path) or (path / ".git").is_dir():
            raise
    if path.is_symlink() or path.is_file():
        path.unlink()
    else:
        remove_tree(path)
    git_worktree(repository, "prune")


def failed_browser_output(directory: Path) -> set[str]:
    """The `browser-<n>` folders of the attempt's checks that failed, by its packet; none when there is no packet to read."""
    try:
        packet = json.loads((directory / "packet.json").read_text())
        receipts = packet["evidence"]["checks"]
        errors = [str(error) for error in [*packet.get("capture_errors", []), *packet.get("scenario_errors", [])]]
    except (OSError, ValueError, KeyError, TypeError):
        return set()
    failed = set()
    for receipt in receipts if isinstance(receipts, list) else []:
        if isinstance(receipt, dict) and any(error.startswith((f"{receipt.get('id')}:", f"{receipt.get('id')}/")) for error in errors):
            failed.add(f"browser-{receipt.get('worker_check_index')}")
    return failed


def prunable(directory: Path) -> list[Path]:
    """What prune_attempt removes from this attempt folder now, in order: the worktree, the caches, the raw browser output of
    the checks that did not fail."""
    if not directory.is_dir():
        return []
    keep = failed_browser_output(directory)
    raw = sorted((path for path in directory.iterdir() if RAW_BROWSER_OUTPUT.fullmatch(path.name) and path.name not in keep),
                 key=lambda path: int(path.name.removeprefix("browser-")))
    return [path for path in [directory / "worktree", *(directory / name for name in PRUNED_CACHES), *raw]
            if path.exists() or path.is_symlink()]


def prune_attempt(repository, directory: Path) -> list[Path]:
    """Remove a passed attempt's worktree (remove_worktree, under the repository's worktree lock), its caches and the raw
    browser output of its checks that did not fail; returns what it removed, nothing when it was already pruned.
    recheck_packet reads only the packet and artifacts/, so the attempt still rechecks and is still reused. Never called on
    an attempt that failed."""
    removed = []
    for path in prunable(directory):
        if path.name == "worktree":
            remove_worktree(repository, path)
        elif path.is_symlink() or path.is_file():
            path.unlink()
        else:
            remove_tree(path)
        removed.append(path)
    return removed


def check_env(directory: Path, phase: str) -> tuple[dict, list[str], Path]:
    """The checks' environment for one attempt folder: verification_environment (the controller's interpreter first on PATH,
    the phase, caches inside the folder) and a private TMPDIR outside the run (lane_tmpdir), with the secret-like names it
    dropped. Nothing in it names a lane, so a shared execution (shared_checks) runs in exactly the environment each declaring
    lane's own attempt would have had."""
    env, dropped = verification_environment(directory, phase)
    # Unix domain sockets (tsx IPC, Chromium) are limited to ~107 bytes of path, so the
    # lane's TMPDIR cannot live under the run directory. It is private to this lane,
    # holds no evidence, and is removed once the checks finish.
    tmpdir = lane_tmpdir()
    env["TMPDIR"] = str(tmpdir)
    return env, dropped, tmpdir


def verify_revision(run: Path, plan: dict, policy: dict, node: str, commit: str, changed: list[str],
                    session_id: str, phase: str = "worker", attempt: int = 1, prune: bool = True, shared: dict | None = None) -> dict:
    """One fresh verification worktree per node/phase/attempt, artifacts retained. A passed attempt is pruned once its
    packet is saved (prune_attempt); a failed one is kept whole, and so is one the caller may still fail (`prune=False`:
    the failure drill's attempt).

    `shared` (candidate phase only): the shared record (shared_checks) this attempt cites, `{path, sha256}`. The lane's
    non-browser checks are then not run again: their executions, counts, errors and logs are the record's, copied into
    this folder as `check-<i>.log`. Only a lane with a browser check gets its own worktree, for those checks and their
    setup. The packet names the record in `shared_record`; the returned gate is the lane's own checks', since the
    candidate step gates the record's run checks once every lane's own checks pass (shared_checks.SharedCandidate)."""
    from .shared_checks import launch_failed, load_record
    worker = next(worker for worker in policy["workers"] if worker["node_id"] == node)
    directory = run / "verification" / phase / node / str(attempt)
    packet_path = directory / "packet.json"
    if packet_path.exists():
        packet = json.loads(packet_path.read_text())
        # What the packet verified is its own phase, lane and attempt, not its path: a worker packet at the candidate path
        # would pass a candidate whose checks were never run (recheck_packet gates it with the packet's own phase).
        found = (packet["phase"], packet["expected"]["node_id"], packet["expected"]["attempt"])
        if found != (phase, node, attempt):
            raise ValueError(f"Existing verification at {packet_path} is the {found[0]} packet of {found[1]} attempt {found[2]}, "
                             f"not the {phase} packet of {node} attempt {attempt}; it is never reused")
        # A reused candidate packet has no evidence of its own: recheck_packet gates its worker packet's against the policy.
        if packet["expected"]["output_commit"] != commit or ("evidence" in packet and packet["evidence"]["policy_sha256"] != policy_digest(policy)):
            raise ValueError("Existing verification belongs to a different revision/policy")
        # Lockstep (decisions [L2]): a packet of this attempt cites this attempt's one record, never an older one.
        if shared is not None and packet.get("shared_record") != shared and ("shared_record" in packet or policy.get("run_checks")):
            raise ValueError(f"Existing verification at {packet_path} cites another shared record than {shared['path']}; it is never reused beside it")
        return recheck_packet(packet, policy, run, run_checks=shared is None)
    if directory.exists():
        raise RuntimeError("Interrupted check attempt exists; use an explicitly incremented attempt")
    record = load_record(run, shared) if shared is not None else None
    unstarted = record is not None and launch_failed(record, [check["argv"] for check in worker["checks"] if check["kind"] != "browser"])
    if unstarted:  # Before the lane's folder exists: the step stops without a verdict on this lane, as before checks were shared.
        raise RuntimeError(f"{unstarted}; see {run / shared['path']}")
    own = shared is None or any(check["kind"] == "browser" for check in worker["checks"])
    directory.mkdir(parents=True, mode=0o700)
    # A citing lane without a browser check has no worktree of its own: every execution it cites ran in the record's.
    worktree = directory / "worktree" if own else Path(record["worktree"])
    if own:
        git_worktree(plan["repository"], "add", "--detach", str(worktree), commit)
        if git(worktree, "rev-parse", "HEAD") != commit or git(worktree, "status", "--porcelain"):
            raise RuntimeError("Verification worktree did not start clean at expected revision")
    artifacts_dir = directory / "artifacts"
    artifacts_dir.mkdir()
    capture = Capture(artifacts_dir)
    # Captured before any check runs, so a check that rewrites a file cannot change what is recorded; the
    # post-check cleanliness rule below invalidates the evidence if one does. The candidate phase captures nothing.
    files_not_captured = capture_changed_files(worktree, changed, capture) if phase == "worker" else None
    if own:
        env, dropped, tmpdir = check_env(directory, phase)
    else:
        env, dropped, tmpdir = {}, list(record["dropped_env_names"]), Path(record["tmpdir"])
    executions, receipts, errors, effective_commands, scenario_errors = [], [], [], [], []
    try:
        run_lane_commands(policy, worker, worktree, directory, env, capture, executions, receipts, errors, effective_commands, scenario_errors,
                          label=f"{plan['run_id']} {phase} {node} attempt {attempt}", shared=(record, (run / shared["path"]).parent) if record else None)
    finally:
        if own:
            shutil.rmtree(tmpdir, ignore_errors=True)
    # Source edits by checks invalidate the evidence. Ignored caches are allowed. A cited execution after which the shared
    # worktree was no longer clean carries `modified` (shared_checks.run_shared): only the lanes that cite it get the error.
    if (own and (git(worktree, "rev-parse", "HEAD") != commit or git(worktree, "status", "--porcelain"))) or (
            record is not None and any(cited_execution(record, check["argv"]).get("modified") for check in worker["checks"]
                                       if check["kind"] != "browser" and not record["setup_errors"])):
        errors.append("Verification modified the tested source revision")
    expected = {"run_id": plan["run_id"], "node_id": node, "attempt": attempt, "base_commit": plan["base_commit"],
                "output_commit": commit, "verification_cwd": str(worktree)}
    transient = transient_checks(worker, receipts, executions, phase)
    result = {"contract_version": "1.0.0", **{key: value for key, value in expected.items() if key != "verification_cwd"},
              "session_id": session_id, "status": "succeeded", "changed_files": changed,
              "checks": executions, "open_assumptions": [], "artifacts": capture.artifacts,
              "summary": f"Trusted {phase} check capture; not integration approval", "error": None,
              **({"files_not_captured": files_not_captured} if files_not_captured is not None else {}),
              **({"transient_checks": transient} if transient else {})}
    evidence = {"version": "1.0.0", "policy_sha256": policy_digest(policy),
                **{key: expected[key] for key in ("run_id", "node_id", "attempt", "output_commit")}, "checks": receipts}
    # The dropped names sit beside the evidence, whose schema is closed: a check that needed one shows why it failed.
    packet = {"phase": phase, "expected": expected, "result": result, "evidence": evidence,
              "artifact_root": str(artifacts_dir), "artifact_paths": {key: str(path) for key, path in capture.paths.items()},
              "capture_errors": errors, "scenario_errors": scenario_errors, "effective_commands": effective_commands, "tmpdir": str(tmpdir),
              "dropped_env_names": dropped, **({"shared_record": shared} if shared is not None else {})}
    packet = recheck_packet(packet, policy, run, run_checks=shared is None)
    save_json(packet_path, packet)
    if prune and packet["gate"]["status"] == "passed":
        try:
            prune_attempt(plan["repository"], directory)
        except Exception as error:  # Whatever the removal raises, the check passed.
            # The evidence is saved and passed; what is left only takes disk. `workflow clean` prunes it later.
            print(f"Warning: passed attempt {directory} was not pruned ({error}); `python -m workflow clean` prunes it", file=sys.stderr)
    return packet


TRANSIENT_KINDS = ("memory", "disk", "load")


def transient_checks(worker: dict, receipts: list, executions: list, phase: str) -> list[str]:
    """The ids of the checks that gate in this phase and were killed for memory, ran out of disk or timed out under host load
    (`transient` on their execution). A deferred worker-phase check's outcome never gates, so its kill makes no attempt transient."""
    from .verification import DEFERRED_WORKER_KINDS
    kinds = {check["id"]: check["kind"] for check in worker["checks"]}
    return [receipt["id"] for receipt in receipts
            if executions[receipt["worker_check_index"]].get("transient") in TRANSIENT_KINDS
            and not (phase == "worker" and kinds[receipt["id"]] in DEFERRED_WORKER_KINDS)]


# Secret-like names a check never inherits (C14 slice 1). *_URL names stay, though they may hold a key: pine-chain's fork
# check reads GNOSIS_RPC_URL. Matched without regard to case.
SECRET_SUFFIXES = ("_KEY", "_TOKEN", "_SECRET", "_PASSWORD")
SECRET_PREFIXES = ("GH_", "GITHUB_")


def check_environment(environ) -> tuple[dict, list[str]]:
    """The environment the checks start from, and the secret-like names it dropped (names only, sorted).

    The controller's, without the Herdr variables (a check never targets the controller's pane), inherited Playwright
    reporter paths (the runner owns JSON capture), the controller's own Git configuration (target suites run their hooks
    as written: worktrees.without_controller_git_config), a surrounding Claude Code session's variables and its model and
    effort overrides (sessions.scrub_env; not secrets, so not listed) and SECRET_SUFFIXES/SECRET_PREFIXES names; with
    HUSKY=0 and GIT_TERMINAL_PROMPT=0, so no install script switches hooks on and no Git command waits for a password.
    """
    env, dropped = {}, []
    for key, value in scrub_env(without_controller_git_config(environ)).items():
        if key.startswith(("HERDR_", "PLAYWRIGHT_JSON_OUTPUT")):
            continue
        name = key.upper()
        if not name.endswith("_URL") and (name.endswith(SECRET_SUFFIXES) or name.startswith(SECRET_PREFIXES)):
            dropped.append(key)
            continue
        env[key] = value
    env.update(HUSKY="0", GIT_TERMINAL_PROMPT="0")
    return env, sorted(dropped)


SOCKET_PATH_LIMIT = 107  # sun_path on Linux, excluding the terminating NUL.
SOCKET_NAME_ALLOWANCE = len("/tsx-4294967295/4294967295.pipe")


def verification_environment(cache_root: Path, phase: str, environ=None) -> tuple[dict, list[str]]:
    """The environment every setup and check command runs with (verify_revision, and preflight --setup), and the secret-like
    names check_environment dropped. The controller's interpreter directory comes first on PATH, so its venv's setuptools
    serves node-gyp's `import distutils` on Python 3.12 (RUNBOOK §1). Fresh `XDG_CACHE_HOME` and `npm_config_cache` are
    created under `cache_root`, which must exist and hold neither yet; the caller sets TMPDIR (lane_tmpdir)."""
    env, dropped = check_environment(os.environ if environ is None else environ)
    # Share installed browser executables read-only, not profiles or test caches.
    if sys.platform == "linux":
        env.setdefault("PLAYWRIGHT_BROWSERS_PATH", str(Path(env.get("XDG_CACHE_HOME", str(Path.home() / ".cache"))) / "ms-playwright"))
    env.update(PATH=str(Path(sys.executable).parent) + os.pathsep + env.get("PATH", ""),
               PYTHONDONTWRITEBYTECODE="1", NO_COLOR="1", FORCE_COLOR="0", CI="1",
               WORKFLOW_VERIFICATION_PHASE=phase)
    for name in ("XDG_CACHE_HOME", "npm_config_cache"):
        path = cache_root / name.lower()
        path.mkdir()
        env[name] = str(path)
    return env, dropped


def lane_tmpdir() -> Path:
    """A short private temp directory whose sockets fit within sun_path."""
    tmpdir = Path(tempfile.mkdtemp(prefix="mdwf-"))
    if len(str(tmpdir)) + SOCKET_NAME_ALLOWANCE > SOCKET_PATH_LIMIT:
        shutil.rmtree(tmpdir, ignore_errors=True)
        raise RuntimeError(f"System temp directory is too deep for Unix sockets: {tmpdir.parent}")
    return tmpdir


def cited_execution(record: dict, argv: list[str]) -> dict:
    """The shared record's execution of this argv (shared_checks.run_shared runs each distinct argv once)."""
    found = [execution for execution in record["executions"] if execution["argv"] == list(argv)]
    if len(found) != 1:
        raise ValueError(f"Shared record has {len(found)} executions of {shlex.join(argv)}")
    return found[0]


def cite_execution(check: dict, index: int, record: dict, folder: Path, directory: Path, capture: "Capture",
                   executions: list, receipts: list, errors: list, effective_commands: list) -> None:
    """A lane check the shared record ran: its execution as the lane's own, its log copied to `check-<index>.log`, its
    counts parsed once and read under the lane's kind, its errors under the lane's check id (PRD 4 E8)."""
    execution = cited_execution(record, check["argv"])
    log = directory / f"check-{index}.log"
    shutil.copyfile(folder / execution["log"], log)
    log_id = capture.add(log, "log")
    effective_commands.append(list(check["argv"]))
    executions.append({"command": shlex.join(check["argv"]), "cwd": execution["cwd"], "started_at": execution["started_at"],
                       "finished_at": execution["finished_at"], "exit_code": execution["exit_code"], "log_artifact_id": log_id,
                       **({"transient": execution["transient"]} if execution.get("transient") in TRANSIENT_KINDS else {})})
    errors.extend(f"{check['id']}: {message}" for message in execution["errors"])
    tests = execution["tests"] if check["kind"] in {"unit", "contract", "integration"} else None
    receipts.append({"id": check["id"], "worker_check_index": index, "tests": tests, "scenarios": []})


def run_lane_commands(policy: dict, worker: dict, worktree: Path, directory: Path, env: dict, capture: "Capture",
                      executions: list, receipts: list, errors: list, effective_commands: list, scenario_errors: list,
                      label: str = "", shared: tuple[dict, Path] | None = None) -> None:
    """Setup, then every check in policy order. With `shared` (the record and its folder), the record's setup and
    executions stand for the lane's non-browser checks (cite_execution); setup runs again only in a browser lane's own
    worktree, logged as `setup-<i>-browser.log`."""
    own = shared is None or any(check["kind"] == "browser" for check in worker["checks"])
    if shared is not None:
        record, folder = shared
        for index, item in enumerate(record["setup"]):
            log = directory / f"setup-{index}.log"
            shutil.copyfile(folder / item["log"], log)
            capture.add(log, "log")
        errors.extend(record["setup_errors"])
    for index, setup in enumerate(policy.get("setup", []) if own and not errors else []):
        log = directory / (f"setup-{index}.log" if shared is None else f"setup-{index}-browser.log")
        code, _, _ = execute(setup["argv"], worktree, log, setup["timeout_seconds"], env)
        capture.add(log, "log")
        if code != 0:
            errors.append(f"Setup {index} failed with exit {code}")
            break
    if not errors:
        for index, check in enumerate(worker["checks"]):
            if shared is not None and check["kind"] != "browser":
                cite_execution(check, index, shared[0], shared[1], directory, capture, executions, receipts, errors, effective_commands)
                continue
            argv = list(check["argv"])
            log = directory / f"check-{index}.log"
            browser_output = directory / f"browser-{index}"
            browser_report = directory / f"browser-report-{index}.json"
            check_env = dict(env)
            if check["kind"] == "browser":
                # Runtime-owned reporter/output flags override project defaults.
                argv.extend(["--reporter=json", f"--output={browser_output}", "--workers=1", "--retries=0"])
                check_env["PLAYWRIGHT_JSON_OUTPUT_FILE"] = str(browser_report)
            effective_commands.append(argv)
            if check["kind"] == "browser":
                # One of the machine's browser slots when the queue is on (browser_queue); the timeout starts once it is taken.
                with browser_slot(f"{label} {check['id']}".strip()):
                    code, start, finish = execute(argv, worktree, log, check["timeout_seconds"], check_env)
            else:
                code, start, finish = execute(argv, worktree, log, check["timeout_seconds"], check_env)
            log_id = capture.add(log, "log")
            transient = transient_kind(code, log)
            executions.append({"command": shlex.join(check["argv"]), "cwd": str(worktree),
                               "started_at": start, "finished_at": finish, "exit_code": code, "log_artifact_id": log_id,
                               **({"transient": transient} if transient else {})})
            tests, scenarios = None, []
            try:
                if check["kind"] == "browser":
                    if not browser_report.exists():
                        # Playwright writes its report only once the suite starts; a config or fixture
                        # error leaves none. Say so without quoting a path that differs per attempt.
                        raise ValueError(f"no Playwright report written (exit {code}); the suite did not start")
                    # Keep structured results separate from npm/Node warnings in logs.
                    tests, scenarios = browser_evidence(browser_report, browser_output, check, capture)
                    capture.add(browser_report, "test_report")
                elif check["kind"] in {"unit", "contract", "integration"}:
                    tests = text_test_counts(log.read_text(errors="replace"))
                if code != 0:
                    errors.append(f"{check['id']}: exit {code}")
            except (ValueError, OSError, KeyError, TypeError) as error:
                errors.append(f"{check['id']}: {error}")
                scenario_errors.extend(f"{check['id']}: {problem}" for problem in getattr(error, "scenario_problems", []))
            receipts.append({"id": check["id"], "worker_check_index": index, "tests": tests, "scenarios": scenarios})


def reuse_packet(run: Path, plan: dict, policy: dict, node: str, commit: str, worker_path: Path, attempt: int = 1,
                 shared: dict | None = None) -> dict:
    """The candidate packet of a lane whose candidate is its own snapshot: the worker packet at `worker_path`, re-gated in the
    candidate phase, instead of a second verification worktree (C28). Nothing runs.

    The saved packet carries the call's own phase, lane and attempt and `reused_from`: the worker packet's run-relative path
    and sha256. recheck_packet loads that packet again, checks its digest and gates it as a candidate packet, so the cache
    rule of verify_revision (a packet of another phase, lane or attempt is never reused) still holds. Its `result` and
    `artifact_paths` are copies for readers of the file (the viewer, report.html); no gate trusts them.

    On a policy with run checks, `shared` names the record that ran them on this candidate attempt: the packet cites it
    in `shared_record` beside `reused_from`, and the candidate step gates them (shared_checks.SharedCandidate.finish).
    """
    directory = run / "verification" / "candidate" / node / str(attempt)
    packet_path = directory / "packet.json"
    if packet_path.exists():
        return verify_revision(run, plan, policy, node, commit, [], "", phase="candidate", attempt=attempt, shared=shared)
    if directory.exists():
        raise RuntimeError("Interrupted check attempt exists; use an explicitly incremented attempt")
    worker_path = Path(worker_path).resolve()
    if not worker_path.is_relative_to(run.resolve()):
        raise ValueError(f"Reused worker packet {worker_path} is outside the run")
    with worker_path.open("rb") as handle:
        digest = hashlib.file_digest(handle, "sha256").hexdigest()
    worker = json.loads(worker_path.read_text())
    expected = {"run_id": plan["run_id"], "node_id": node, "attempt": attempt, "base_commit": plan["base_commit"],
                "output_commit": commit, "verification_cwd": worker["expected"]["verification_cwd"]}
    packet = {"phase": "candidate", "expected": expected,
              "reused_from": {"path": str(worker_path.relative_to(run.resolve())), "sha256": digest},
              **({"shared_record": shared} if shared is not None else {})}
    gated = recheck_packet(packet, policy, run, run_checks=shared is None)
    reused = packet["reused_from"]["path"]
    directory.mkdir(parents=True, mode=0o700)
    result = {**gated["result"], "attempt": attempt, "summary": f"Worker check capture {reused} reused for the candidate gate; not integration approval"}
    save_json(packet_path, {**packet, "result": result, "artifact_root": gated["artifact_root"], "artifact_paths": gated["artifact_paths"],
                            "gate": gated["gate"]})
    return gated


def recheck_reused(packet: dict, policy: dict, run: Path) -> dict:
    """A reused candidate packet (reuse_packet): its worker packet, unchanged since, of this lane and revision, gated as a
    candidate packet, under the candidate packet's own phase, expectation and reference."""
    reference = packet["reused_from"]
    path = (run / reference["path"]).resolve()
    if not path.is_relative_to(run.resolve()):
        raise ValueError(f"Reused worker packet {reference['path']} is outside the run")
    if not path.is_file():
        raise ValueError(f"Reused worker packet {reference['path']} is missing")
    with path.open("rb") as handle:
        if hashlib.file_digest(handle, "sha256").hexdigest() != reference["sha256"]:
            raise ValueError(f"Reused worker packet {reference['path']} changed after its reuse")
    worker = json.loads(path.read_text())
    expected = packet["expected"]
    if (worker.get("phase"), "reused_from" in worker) != ("worker", False) or any(
            worker["expected"][key] != expected[key] for key in ("run_id", "node_id", "base_commit", "output_commit")):
        raise ValueError(f"{reference['path']} is not the worker packet of {expected['node_id']} at {expected['output_commit']}")
    # The worker packet re-gated as a candidate one never cites a record: the citation is the outer packet's (decisions [L6]).
    gated = recheck_packet({**worker, "phase": "candidate"}, policy, run, cited=False)
    # The worker phase left its deferred checks out of transient_checks; at the candidate every check gates.
    lane = next(item for item in policy["workers"] if item["node_id"] == expected["node_id"])
    result = {key: value for key, value in gated["result"].items() if key != "transient_checks"}
    killed = transient_checks(lane, worker["evidence"]["checks"], worker["result"]["checks"], "candidate")
    return {**gated, "result": {**result, **({"transient_checks": killed} if killed else {})}, "phase": "candidate", "expected": expected,
            "reused_from": reference, **{key: packet[key] for key in ("shared_record", "run_check_block") if key in packet}}


def recheck_packet(packet: dict, policy: dict, run: Path, run_checks: bool = True, cited: bool = True) -> dict:
    """Gate a saved packet again from its evidence. A packet citing a shared record (`shared_record`) is gated on the
    record too (shared_checks.cited_record, gate_run_checks): its digest, its executions of the lane's argvs and, unless `run_checks` is
    False (the candidate step before every lane's own checks passed), the record's run checks and their attribution.
    On a policy with run checks a candidate packet that cites no record is refused, reused (C28) or not (decisions [L6]);
    `cited` is False only for recheck_reused's inner gate of the worker packet, which never cites one."""
    from .shared_checks import cited_record, gate_run_checks
    if cited and packet.get("phase") == "candidate" and policy.get("run_checks") and "shared_record" not in packet:
        raise ValueError(f"Candidate packet of {packet['expected']['node_id']} attempt {packet['expected']['attempt']} cites no shared "
                         "record; the policy's run checks gate every candidate packet")
    if "reused_from" in packet:
        packet = recheck_reused(packet, policy, run)
        if "shared_record" in packet:
            gate_run_checks(packet, policy, run, cited_record(packet, policy, run, lane_checks=False), run_checks)
        return packet
    record = cited_record(packet, policy, run) if "shared_record" in packet else None
    root = Path(packet["artifact_root"]).resolve()
    if not root.is_relative_to(run.resolve()):
        raise ValueError("Artifact root outside run")
    gate = evaluate_worker(policy, packet["result"], packet["evidence"], expected=packet["expected"],
                           artifact_root=root, artifact_paths={key: Path(value) for key, value in packet["artifact_paths"].items()},
                           enforce_ownership=packet["phase"] == "worker", phase=packet["phase"],
                           shared_cwd=record["worktree"] if record is not None else None)
    # Capture errors are prefixed with their check id; a deferred check's errors are evidence, not a gate.
    deferred_prefixes = tuple(f"{check_id}{separator}" for check_id in gate["deferred_checks"] for separator in (":", "/"))
    gate["reasons"].extend(error for error in packet["capture_errors"] if not error.startswith(deferred_prefixes))
    # Except a passed scenario test's title and screenshot: the lane's own work, whatever another lane changes.
    # Other phases gate on these through the capture error already. Packets before this key have none.
    gate["reasons"].extend(error for error in packet.get("scenario_errors", []) if error.startswith(deferred_prefixes))
    if gate["reasons"]:
        gate["status"] = "blocked"
    packet["gate"] = gate
    if record is not None:
        gate_run_checks(packet, policy, run, record, run_checks)
    return packet


def report_policy(source: Path) -> dict:
    """A policy file, or the policy a feature directory's feature.json names.

    feature.json is read here, with launch.feature_file's escape check, rather than through launch, which imports
    LangGraph: a lane runs check-report in its own worktree, and any Python with jsonschema and this tool on
    PYTHONPATH must do.
    """
    from .verification import validate_policy
    if source.is_dir():
        manifest = json.loads((source / "feature.json").read_text())
        name = manifest.get("policy") if isinstance(manifest, dict) else None
        if not isinstance(name, str):
            raise ValueError(f"{source / 'feature.json'} names no policy")
        path = (source / name).resolve(strict=True)
        if not path.is_relative_to(source.resolve()):
            raise ValueError("Feature file escapes feature directory")
        source = path
    return validate_policy(json.loads(source.read_text()))


def check_report(policy: dict, lane: str, report: dict, require_all: bool = False) -> tuple[list[str], bool]:
    """`check-report`: a line per required scenario of the lane's browser checks and whether the report passes.

    The rules are the verifier's (scenario_evidence), with its wording. A scenario the report does not include
    fails only with `require_all`, since a worker may run only some spec files. A screenshot must exist, but may
    live anywhere: the verifier also requires its own output directory, which only its run has.
    """
    workers = {worker["node_id"]: worker for worker in policy["workers"]}
    if lane not in workers:
        raise ValueError(f"{lane} is not a lane of this policy ({', '.join(workers)})")
    browser = [check for check in workers[lane]["checks"] if check["kind"] == "browser"]
    if not browser:
        raise ValueError(f"Lane {lane} has no browser check, so it has no scenarios to check")
    def screenshot(scenario_id, attachment):
        path = Path(attachment).resolve(strict=True)
        if not path.is_file():
            raise ValueError("Evidence must be a regular file")
        return str(path)
    lines, passed = [], True
    for check in browser:
        counts, found, problems = scenario_evidence(report, {scenario["id"] for scenario in check["scenarios"]}, screenshot)
        for scenario_id, message in problems:
            if scenario_id is None and message != NOT_COVERED:
                lines.append(f"{check['id']}: {message}")
                passed = False
        for scenario in check["scenarios"]:
            prefix = f"{check['id']}/{scenario['id']}"
            own = [message for scenario_id, message in problems if scenario_id == scenario["id"]]
            if own:
                lines.extend(f"{prefix}: {message}" for message in own)
                passed = False
            elif scenario["id"] not in found:
                lines.append(f"{prefix}: not in this report")
                passed = passed and not require_all
            elif found[scenario["id"]]["status"] != "passed":
                lines.append(f"{prefix}: browser scenario did not pass")
                passed = False
            else:
                lines.append(f"{prefix}: ok")
        lines.append(f"{check['id']}: {counts['passed']} passed, {counts['failed']} failed, {counts['skipped']} skipped")
        if counts["passed"] < 1 or counts["failed"] > 0:
            lines.append(f"{check['id']}: no passing test evidence or failed tests")
            passed = False
    return lines, passed


def check_report_main(argv=None):
    import argparse
    from jsonschema.exceptions import ValidationError
    parser = argparse.ArgumentParser(prog="python -m workflow check-report", description="Check a Playwright JSON report against a "
                                     "lane's browser scenarios with the verifier's own rules, before completing the lane.")
    parser.add_argument("policy", type=Path, help="The feature directory, or a policy.json")
    parser.add_argument("lane")
    parser.add_argument("report", type=Path, help="The report written with --reporter=json to PLAYWRIGHT_JSON_OUTPUT_FILE")
    parser.add_argument("--all", action="store_true", help="Also fail on required scenarios this report does not include")
    args = parser.parse_args(argv)
    try:
        lines, passed = check_report(report_policy(args.policy), args.lane, json.loads(args.report.read_text()), args.all)
    except (ValueError, OSError, KeyError, TypeError, ValidationError) as error:
        parser.exit(1, f"Blocked: {getattr(error, 'message', error)}\n")
    print("\n".join(lines))
    if not passed:
        print("Blocked: the verifier would refuse this report for the reasons above")
        sys.exit(1)
    print("The scenarios in this report follow the verifier's rules")


# ---- The disk and inode floor (RUNBOOK §2 and "Status, failures and recovery") ----------------------------------------

DISK_FLOOR_MB = 5120
INODE_FLOOR_PCT = 5
DISK_FLOOR_ENV = "WORKFLOW_DISK_FLOOR_MB"
INODE_FLOOR_ENV = "WORKFLOW_INODE_FLOOR_PCT"


def disk_floors(environ=None) -> tuple[float, float]:
    """(MB, % inodes) a run needs free: DISK_FLOOR_MB and INODE_FLOOR_PCT, or WORKFLOW_DISK_FLOOR_MB and
    WORKFLOW_INODE_FLOOR_PCT when set; 0 disables that floor. A value that is not a non-negative number is refused, naming
    the variable."""
    environ = os.environ if environ is None else environ
    floors = []
    for name, default in ((DISK_FLOOR_ENV, DISK_FLOOR_MB), (INODE_FLOOR_ENV, INODE_FLOOR_PCT)):
        raw = environ.get(name, "").strip()
        try:
            value = float(raw) if raw else float(default)
        except ValueError:
            value = -1.0
        if not value >= 0 or value == float("inf"):
            raise ValueError(f"{name} must be a number of {'MB' if name == DISK_FLOOR_ENV else 'percent'} (0 disables that floor), got {raw!r}")
        floors.append(value)
    return floors[0], floors[1]


def nearest_existing(path: Path) -> Path:
    """`path`, or its nearest ancestor that exists: what statvfs can read for a run directory not created yet."""
    path = Path(path).absolute()
    while not path.exists() and path != path.parent:
        path = path.parent
    return path


def disk_free(path: Path) -> tuple[float, float | None]:
    """(MB free to an unprivileged user, % of inodes free or None on a filesystem that reports no inode count) at `path`."""
    stat = os.statvfs(path)
    inodes = 100.0 * stat.f_favail / stat.f_files if stat.f_files else None
    return stat.f_bavail * stat.f_frsize / (1024 * 1024), inodes


def disk_shortfalls(paths, environ=None) -> list[str]:
    """Each floor `paths` (the run root, the repository) fail, with the measured value; empty when every floor holds."""
    mb_floor, inode_floor = disk_floors(environ)
    if not mb_floor and not inode_floor:
        return []
    shortfalls = []
    for path in dict.fromkeys(nearest_existing(path) for path in paths):
        free, inodes = disk_free(path)
        if mb_floor and free < mb_floor:
            shortfalls.append(f"{path} has {free:.0f} MB of free space, under the {mb_floor:g} MB floor ({DISK_FLOOR_ENV})")
        if inode_floor and inodes is not None and inodes < inode_floor:
            shortfalls.append(f"{path} has {inodes:.1f} % of its inodes free, under the {inode_floor:g} % floor ({INODE_FLOOR_ENV})")
    return shortfalls


def disk_refusal(paths, environ=None) -> str | None:
    """Preflight's and launch's refusal when a floor fails (disk_shortfalls), naming each and how to free space; None when they hold."""
    shortfalls = disk_shortfalls(paths, environ)
    if not shortfalls:
        return None
    return (f"Not enough free disk for a run: {'; '.join(shortfalls)}. Check with df -h and df -i, then free space (for example "
            f"python -m workflow clean \"$RUN\" --by operator on a finished or abandoned run) and launch again; {DISK_FLOOR_ENV} and "
            f"{INODE_FLOOR_ENV} set the floors (0 disables one)")


# ---- preflight --setup (RUNBOOK §2) -----------------------------------------------------------------------------------

def preflight_setup(repository: Path, policy: dict, clock=None) -> str:
    """`preflight --setup`: the policy's setup commands, once, in order, each with its timeout and verify_revision's own
    environment (verification_environment, a fresh TMPDIR), in a throwaway detached worktree of the repository's HEAD under
    the system temp directory, outside any run directory. `setup: passed (<seconds> s)`, or `setup: none` for a policy
    without setup; the first failure raises ValueError naming `setup <index>`, its argv, its exit code and the last 20 lines
    of its log. The worktree and every temporary directory are removed in a `finally`, a Ctrl-C included. The worktree add
    and remove take the worktree lock themselves (git_worktree, remove_worktree); setup runs outside it."""
    import time
    clock = clock or time.monotonic
    setup = policy.get("setup", [])
    if not setup:
        return "setup: none"
    root = Path(tempfile.mkdtemp(prefix="mdwf-setup-"))
    worktree, tmpdir = root / "worktree", None
    try:
        git_worktree(repository, "add", "--detach", str(worktree), "HEAD")
        (root / "caches").mkdir()
        env, _ = verification_environment(root / "caches", "worker")
        tmpdir = lane_tmpdir()
        env["TMPDIR"] = str(tmpdir)
        started = clock()
        for index, item in enumerate(setup):
            log = root / f"setup-{index}.log"
            code, _, _ = execute(item["argv"], worktree, log, item["timeout_seconds"], env)
            if code != 0:
                tail = log.read_text(errors="replace").splitlines()[-MEMORY_TAIL_LINES:]
                raise ValueError(f"setup {index} failed: {shlex.join(item['argv'])} exited {code}. Last {MEMORY_TAIL_LINES} lines of its log:\n"
                                 + "\n".join(tail))
        return f"setup: passed ({clock() - started:.0f} s)"
    finally:
        if tmpdir is not None:
            shutil.rmtree(tmpdir, ignore_errors=True)
        try:
            if worktree.exists() or registered_worktree(repository, worktree):
                remove_worktree(repository, worktree)
        finally:
            shutil.rmtree(root, ignore_errors=True)
