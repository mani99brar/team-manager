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

    def add(self, source: Path, kind: str) -> str:
        if not source.is_file() or source.is_symlink():
            raise ValueError("Evidence must be a regular file")
        content = source.read_bytes()
        digest = hashlib.sha256(content).hexdigest()
        artifact_id = f"{kind}-{len(self.artifacts)}-{digest[:12]}"
        destination = self.directory / artifact_id
        with destination.open("xb") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        destination.chmod(0o400)
        self.artifacts.append({"artifact_id": artifact_id, "kind": kind,
                               "uri": destination.name, "sha256": digest})
        self.paths[artifact_id] = destination
        return artifact_id


def browser_evidence(report_path: Path, output_root: Path, requirement: dict, capture: Capture) -> tuple[dict, list]:
    report = json.loads(report_path.read_text())
    if report.get("errors"):
        raise ValueError("Playwright reported global errors")
    specs = []
    def walk(suite):
        specs.extend(suite.get("specs", []))
        for child in suite.get("suites", []):
            walk(child)
    walk(report)
    required = {case["id"] for case in requirement["scenarios"]}
    found = {}
    counts = {"passed": 0, "failed": 0, "skipped": 0}
    for spec in specs:
        for test in spec.get("tests", []):
            results = test.get("results", [])
            # No flaky retries or expected failures counted as passing verification.
            passed = test.get("status") == "expected" and test.get("expectedStatus") == "passed" and len(results) == 1 and results[0].get("status") == "passed"
            skipped = test.get("status") == "skipped"
            counts["passed" if passed else "skipped" if skipped else "failed"] += 1
            matches = set(re.findall(r"\[scenario:([^\]]+)\]", spec.get("title", ""))) & required
            for scenario_id in matches:
                if scenario_id in found:
                    raise ValueError(f"Duplicate browser scenario/project result: {scenario_id}")
                screenshot = None
                if passed:
                    attachments = [item for item in results[0].get("attachments", [])
                                   if item.get("name") == f"screenshot:{scenario_id}" and item.get("contentType") == "image/png"]
                    if len(attachments) != 1:
                        raise ValueError(f"Expected one screenshot attachment for {scenario_id}")
                    path = Path(attachments[0].get("path", "")).resolve(strict=True)
                    if not path.is_relative_to(output_root.resolve()):
                        raise ValueError("Screenshot attachment outside isolated browser output directory")
                    screenshot = capture.add(path, "screenshot")
                found[scenario_id] = {"id": scenario_id, "status": "passed" if passed else "skipped" if skipped else "failed",
                                      "screenshot_artifact_id": screenshot}
    if set(found) != required:
        raise ValueError("Playwright report does not cover every required scenario")
    return counts, list(found.values())


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
    subprocess.run(["git", "-C", plan["repository"], "worktree", "add", "--detach", str(worktree), commit], check=True, capture_output=True)
    if git(worktree, "rev-parse", "HEAD") != commit or git(worktree, "status", "--porcelain"):
        raise RuntimeError("Verification worktree did not start clean at expected revision")
    artifacts_dir = directory / "artifacts"
    artifacts_dir.mkdir()
    capture = Capture(artifacts_dir)
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
    executions, receipts, errors, effective_commands = [], [], [], []
    try:
        run_lane_commands(policy, worker, worktree, directory, env, capture, executions, receipts, errors, effective_commands)
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
              "summary": f"Trusted {phase} check capture; not integration approval", "error": None}
    evidence = {"version": "1.0.0", "policy_sha256": policy_digest(policy),
                **{key: expected[key] for key in ("run_id", "node_id", "attempt", "output_commit")}, "checks": receipts}
    packet = {"phase": phase, "expected": expected, "result": result, "evidence": evidence,
              "artifact_root": str(artifacts_dir), "artifact_paths": {key: str(path) for key, path in capture.paths.items()},
              "capture_errors": errors, "effective_commands": effective_commands, "tmpdir": str(tmpdir)}
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
                      executions: list, receipts: list, errors: list, effective_commands: list) -> None:
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
    if gate["reasons"]:
        gate["status"] = "blocked"
    packet["gate"] = gate
    return packet
