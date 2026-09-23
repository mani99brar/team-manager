"""Local, isolated check execution and artifact capture. Never launches agents."""
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

from .sessions import git, save_json, terminate
from .verification import evaluate_worker, policy_digest
from .worktrees import git_worktree


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
    # Node's TAP and spec reporters. Require a complete self-consistent summary.
    counts = {}
    for key in ("tests", "pass", "fail", "skipped", "cancelled", "todo"):
        found = re.findall(rf"^[#ℹ]\s+{key}\s+(\d+)\s*$", text, re.MULTILINE)
        if found:
            counts[key] = int(found[-1])
    if {"tests", "pass", "fail", "skipped"} <= counts.keys():
        if sum(counts.get(key, 0) for key in ("pass", "fail", "skipped", "cancelled", "todo")) == counts["tests"]:
            return {"passed": counts["pass"], "failed": counts["fail"] + counts.get("cancelled", 0),
                    "skipped": counts["skipped"] + counts.get("todo", 0)}
    return None


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


def verify_revision(run: Path, plan: dict, policy: dict, node: str, commit: str, changed: list[str],
                    session_id: str, phase: str = "worker", attempt: int = 1) -> dict:
    """One fresh verification worktree per node/phase/attempt, artifacts retained."""
    worker = next(worker for worker in policy["workers"] if worker["node_id"] == node)
    directory = run / "verification" / phase / node / str(attempt)
    packet_path = directory / "packet.json"
    if packet_path.exists():
        packet = json.loads(packet_path.read_text())
        if packet["expected"]["output_commit"] != commit or packet["evidence"]["policy_sha256"] != policy_digest(policy):
            raise ValueError("Existing verification belongs to a different revision/policy")
        return recheck_packet(packet, policy, run)
    if directory.exists():
        raise RuntimeError("Interrupted check attempt exists; use an explicitly incremented attempt")
    directory.mkdir(parents=True, mode=0o700)
    worktree = directory / "worktree"
    git_worktree(plan["repository"], "add", "--detach", str(worktree), commit)
    if git(worktree, "rev-parse", "HEAD") != commit or git(worktree, "status", "--porcelain"):
        raise RuntimeError("Verification worktree did not start clean at expected revision")
    artifacts_dir = directory / "artifacts"
    artifacts_dir.mkdir()
    capture = Capture(artifacts_dir)
    # Captured before any check runs, so a check that rewrites a file cannot change what is recorded; the
    # post-check cleanliness rule below invalidates the evidence if one does. The candidate phase captures nothing.
    files_not_captured = capture_changed_files(worktree, changed, capture) if phase == "worker" else None
    env = {key: value for key, value in os.environ.items() if not key.startswith("HERDR_")}
    for key in list(env):
        if key.startswith("PLAYWRIGHT_JSON_OUTPUT"):
            del env[key]  # The runner owns JSON capture, not inherited reporter paths.
    # Share installed browser executables read-only, not profiles or test caches.
    if sys.platform == "linux":
        env.setdefault("PLAYWRIGHT_BROWSERS_PATH", str(Path(env.get("XDG_CACHE_HOME", str(Path.home() / ".cache"))) / "ms-playwright"))
    env.update(PATH=str(Path(sys.executable).parent) + os.pathsep + env.get("PATH", ""),
               PYTHONDONTWRITEBYTECODE="1", NO_COLOR="1", FORCE_COLOR="0", CI="1",
               WORKFLOW_VERIFICATION_PHASE=phase)
    for name in ("XDG_CACHE_HOME", "npm_config_cache"):
        path = directory / name.lower()
        path.mkdir()
        env[name] = str(path)
    # Unix domain sockets (tsx IPC, Chromium) are limited to ~107 bytes of path, so the
    # lane's TMPDIR cannot live under the run directory. It is private to this lane,
    # holds no evidence, and is removed once the checks finish.
    tmpdir = lane_tmpdir()
    env["TMPDIR"] = str(tmpdir)
    executions, receipts, errors, effective_commands, scenario_errors = [], [], [], [], []
    try:
        run_lane_commands(policy, worker, worktree, directory, env, capture, executions, receipts, errors, effective_commands, scenario_errors)
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)
    # Source edits by checks invalidate the evidence. Ignored caches are allowed.
    if git(worktree, "rev-parse", "HEAD") != commit or git(worktree, "status", "--porcelain"):
        errors.append("Verification modified the tested source revision")
    expected = {"run_id": plan["run_id"], "node_id": node, "attempt": attempt, "base_commit": plan["base_commit"],
                "output_commit": commit, "verification_cwd": str(worktree)}
    result = {"contract_version": "1.0.0", **{key: value for key, value in expected.items() if key != "verification_cwd"},
              "session_id": session_id, "status": "succeeded", "changed_files": changed,
              "checks": executions, "open_assumptions": [], "artifacts": capture.artifacts,
              "summary": f"Trusted {phase} check capture; not integration approval", "error": None,
              **({"files_not_captured": files_not_captured} if files_not_captured is not None else {})}
    evidence = {"version": "1.0.0", "policy_sha256": policy_digest(policy),
                **{key: expected[key] for key in ("run_id", "node_id", "attempt", "output_commit")}, "checks": receipts}
    packet = {"phase": phase, "expected": expected, "result": result, "evidence": evidence,
              "artifact_root": str(artifacts_dir), "artifact_paths": {key: str(path) for key, path in capture.paths.items()},
              "capture_errors": errors, "scenario_errors": scenario_errors, "effective_commands": effective_commands, "tmpdir": str(tmpdir)}
    packet = recheck_packet(packet, policy, run)
    save_json(packet_path, packet)
    return packet


SOCKET_PATH_LIMIT = 107  # sun_path on Linux, excluding the terminating NUL.
SOCKET_NAME_ALLOWANCE = len("/tsx-4294967295/4294967295.pipe")


def lane_tmpdir() -> Path:
    """A short private temp directory whose sockets fit within sun_path."""
    tmpdir = Path(tempfile.mkdtemp(prefix="mdwf-"))
    if len(str(tmpdir)) + SOCKET_NAME_ALLOWANCE > SOCKET_PATH_LIMIT:
        shutil.rmtree(tmpdir, ignore_errors=True)
        raise RuntimeError(f"System temp directory is too deep for Unix sockets: {tmpdir.parent}")
    return tmpdir


def run_lane_commands(policy: dict, worker: dict, worktree: Path, directory: Path, env: dict, capture: "Capture",
                      executions: list, receipts: list, errors: list, effective_commands: list, scenario_errors: list) -> None:
    for index, setup in enumerate(policy.get("setup", [])):
        log = directory / f"setup-{index}.log"
        code, _, _ = execute(setup["argv"], worktree, log, setup["timeout_seconds"], env)
        capture.add(log, "log")
        if code != 0:
            errors.append(f"Setup {index} failed with exit {code}")
            break
    if not errors:
        for index, check in enumerate(worker["checks"]):
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
            code, start, finish = execute(argv, worktree, log, check["timeout_seconds"], check_env)
            log_id = capture.add(log, "log")
            executions.append({"command": shlex.join(check["argv"]), "cwd": str(worktree),
                               "started_at": start, "finished_at": finish, "exit_code": code, "log_artifact_id": log_id})
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


def recheck_packet(packet: dict, policy: dict, run: Path) -> dict:
    root = Path(packet["artifact_root"]).resolve()
    if not root.is_relative_to(run.resolve()):
        raise ValueError("Artifact root outside run")
    gate = evaluate_worker(policy, packet["result"], packet["evidence"], expected=packet["expected"],
                           artifact_root=root, artifact_paths={key: Path(value) for key, value in packet["artifact_paths"].items()},
                           enforce_ownership=packet["phase"] == "worker", phase=packet["phase"])
    # Capture errors are prefixed with their check id; a deferred check's errors are evidence, not a gate.
    deferred_prefixes = tuple(f"{check_id}{separator}" for check_id in gate["deferred_checks"] for separator in (":", "/"))
    gate["reasons"].extend(error for error in packet["capture_errors"] if not error.startswith(deferred_prefixes))
    # Except a passed scenario test's title and screenshot: the lane's own work, whatever another lane changes.
    # Other phases gate on these through the capture error already. Packets before this key have none.
    gate["reasons"].extend(error for error in packet.get("scenario_errors", []) if error.startswith(deferred_prefixes))
    if gate["reasons"]:
        gate["status"] = "blocked"
    packet["gate"] = gate
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
