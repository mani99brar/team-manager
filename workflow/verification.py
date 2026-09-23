"""Reusable policy/evidence gates. No agents, browsers, shells or graph launches.

Inputs must come from a trusted verifier plus backend-owned artifact registry, not
unchecked agent prose. Passing this evidence gate never authorizes integration.
"""
from __future__ import annotations

import hashlib
import json
import shlex
from datetime import datetime
from pathlib import Path

from jsonschema import Draft202012Validator, FormatChecker
from jsonschema.exceptions import ValidationError

CONTRACTS = Path(__file__).resolve().parents[1] / "contracts" / "workflow"


# Check kinds that only mean something on the whole application: a lane's build and browser
# suite compile against contracts and a server that another lane of the same run may be
# changing. The worker phase still runs and records them on the lane's isolated snapshot,
# but only the candidate phase, where every lane's work is combined, gates on them.
# Lane-local kinds (unit, contract, integration) gate in both phases.
DEFERRED_WORKER_KINDS = frozenset({"build", "browser"})


def validate_schema(name: str, value: dict) -> None:
    schema = json.loads((CONTRACTS / f"{name}.schema.json").read_text())
    Draft202012Validator(schema, format_checker=FormatChecker()).validate(value)


def policy_digest(policy: dict) -> str:
    """Canonical UTF-8 JSON: sorted keys, no whitespace, literal Unicode."""
    return hashlib.sha256(json.dumps(policy, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()


def safe_path(value: str) -> str:
    normalized = value.rstrip("/")
    if not normalized or normalized.startswith("/") or any(char in normalized for char in "\\:*?[]") or any(part in {"", ".", ".."} for part in normalized.split("/")):
        raise ValueError(f"Not an exact repository-relative path/prefix: {value}")
    return normalized


def owns(path: str, prefix: str) -> bool:
    return path == prefix or path.startswith(prefix + "/")


def unique(items: list[dict], key: str) -> dict:
    result = {item[key]: item for item in items}
    if len(result) != len(items):
        raise ValueError(f"Duplicate {key}")
    return result


# Policies before 1.2.0 derived the required check kinds from the role; the export of an old run keeps them.
ROLE_REQUIRED_KINDS = {"frontend": ("build", "browser"), "backend": ("unit",)}


def required_kinds(policy: dict, worker: dict) -> list[str]:
    """The check kinds a lane must pass: declared from policy 1.2.0, derived from the role before."""
    if "required_check_kinds" in worker:
        return list(worker["required_check_kinds"])
    if policy.get("version") in {"1.0.0", "1.1.0"} and worker.get("role") in ROLE_REQUIRED_KINDS:
        return list(ROLE_REQUIRED_KINDS[worker["role"]])
    raise ValueError(f"{worker.get('node_id')} declares no required_check_kinds")


def validate_policy(policy: dict) -> dict:
    validate_schema("verification", policy)
    workers = unique(policy["workers"], "node_id")
    claimed = []
    for worker in workers.values():
        paths = [safe_path(path) for path in worker["owned_paths"]]
        for other_node, other_path in claimed:
            if any(owns(path, other_path) or owns(other_path, path) for path in paths):
                raise ValueError(f"Overlapping ownership: {worker['node_id']} and {other_node}")
        claimed.extend((worker["node_id"], path) for path in paths)
        checks = unique(worker["checks"], "id")
        if len({tuple(check["argv"]) for check in checks.values()}) != len(checks):
            raise ValueError("Each check needs a distinct command")
        kinds = {check["kind"] for check in checks.values()}
        required = set(required_kinds(policy, worker))
        if not required <= kinds:
            raise ValueError(f"{worker['node_id']} requires {sorted(required)} checks; missing {sorted(required - kinds)}")
        for check in checks.values():
            unique(check["scenarios"], "id")
            if (check["kind"] == "browser") != bool(check["scenarios"]):
                raise ValueError("Browser checks require named scenarios; other checks must not have scenarios")
    drill = policy.get("failure_drill")
    if drill and (drill["node_id"] not in workers or policy.get("max_verification_attempts", 3) < 2):
        raise ValueError("Failure drill requires a configured worker and at least two allowed verification attempts")
    return policy


def evaluate_worker(policy: dict, result: dict, evidence: dict, *, expected: dict,
                    artifact_root: Path, artifact_paths: dict[str, Path], enforce_ownership: bool = True,
                    phase: str = "candidate") -> dict:
    """Fail closed on absent, stale or inconsistent evidence.

    `expected` is backend-owned: run_id, node_id, attempt, base_commit,
    output_commit and verification_cwd. Caller must freeze edits and independently
    derive the full Git diff/commit before invoking; this function cannot prove
    that an agent has reported all changed files.

    In the `worker` phase, checks of a DEFERRED_WORKER_KINDS kind are verified for
    integrity (approved argv, worktree, timeout) and recorded, but their outcome does
    not gate; the returned `deferred_checks` names them. Every other phase gates on all.
    """
    reasons = []
    deferred = []
    try:
        validate_policy(policy)
        validate_schema("workerResult", result)
        validate_schema("verificationEvidence", evidence)
        workers = {worker["node_id"]: worker for worker in policy["workers"]}
        worker = workers[expected["node_id"]]
        for field in ("run_id", "node_id", "attempt", "base_commit", "output_commit"):
            if result[field] != expected[field]:
                raise ValueError(f"Worker result has stale/mismatched {field}")
        for field in ("run_id", "node_id", "attempt", "output_commit"):
            if evidence[field] != expected[field]:
                raise ValueError(f"Verification evidence has stale/mismatched {field}")
        if evidence["policy_sha256"] != policy_digest(policy):
            raise ValueError("Verification policy changed after evidence capture")
        if result["status"] != "succeeded" or result["output_commit"] is None or result["error"] is not None:
            raise ValueError("Worker did not produce a successful durable result")
        prefixes = [safe_path(path) for path in worker["owned_paths"]]
        for changed in result["changed_files"]:
            if enforce_ownership and not any(owns(safe_path(changed), prefix) for prefix in prefixes):
                reasons.append(f"Changed file outside ownership: {changed}")
        artifacts = unique(result["artifacts"], "artifact_id")
        root = artifact_root.resolve(strict=True)
        resolved = {}
        for artifact_id, artifact in artifacts.items():
            path = artifact_paths[artifact_id].resolve(strict=True)
            if not path.is_relative_to(root) or not path.is_file():
                raise ValueError(f"Artifact escapes registry root: {artifact_id}")
            with path.open("rb") as handle:
                digest = hashlib.file_digest(handle, "sha256").hexdigest()
            if digest != artifact["sha256"]:
                raise ValueError(f"Artifact hash mismatch: {artifact_id}")
            resolved[artifact_id] = path
        # Captured files (PRD_VIEWER_CLARITY 4.1): each changed path at most once, captured or listed with a reason.
        accounted = [artifact["path"] for artifact in artifacts.values() if artifact["kind"] == "file"]
        accounted += [entry["path"] for entry in result.get("files_not_captured", [])]
        if len(set(accounted)) != len(accounted) or not set(accounted) <= set(result["changed_files"]):
            raise ValueError("Captured files must be distinct changed files")
        supplied = unique(evidence["checks"], "id")
        required = {check["id"]: check for check in worker["checks"]}
        if set(supplied) != set(required):
            raise ValueError("Required check evidence missing or contains unknown check IDs")
        indexes = [check["worker_check_index"] for check in supplied.values()]
        if len(set(indexes)) != len(indexes):
            raise ValueError("A command execution cannot satisfy multiple check IDs")
        if phase == "worker":
            deferred = sorted(check_id for check_id, check in required.items() if check["kind"] in DEFERRED_WORKER_KINDS)
        deferred_indexes = {supplied[check_id]["worker_check_index"] for check_id in deferred}
        for index, check in enumerate(result["checks"]):
            if artifacts.get(check["log_artifact_id"], {}).get("kind") != "log":
                reasons.append("Executed check is missing a log artifact")
            if datetime.fromisoformat(check["finished_at"]) < datetime.fromisoformat(check["started_at"]):
                reasons.append("Check finish precedes start")
            if check["exit_code"] != 0 and index not in deferred_indexes:
                reasons.append(f"Executed check failed: {check['command']}")
        for check_id, requirement in required.items():
            receipt = supplied[check_id]
            execution = result["checks"][receipt["worker_check_index"]]
            if execution["command"] != shlex.join(requirement["argv"]):
                reasons.append(f"{check_id}: executed command differs from approved argv")
            if Path(execution["cwd"]).resolve() != Path(expected["verification_cwd"]).resolve():
                reasons.append(f"{check_id}: wrong verification worktree")
            duration = (datetime.fromisoformat(execution["finished_at"]) - datetime.fromisoformat(execution["started_at"])).total_seconds()
            if duration > requirement["timeout_seconds"]:
                reasons.append(f"{check_id}: execution exceeded approved timeout")
            if check_id in deferred:
                continue  # Executed and recorded; the candidate phase gates on the outcome.
            if requirement["kind"] in {"unit", "browser", "integration", "contract"}:
                tests = receipt["tests"]
                if tests is None or tests["passed"] < 1 or tests["failed"] > 0:
                    reasons.append(f"{check_id}: no passing test evidence or failed tests")
            scenarios = unique(receipt["scenarios"], "id")
            if requirement["kind"] == "browser" and receipt["tests"] is not None and receipt["tests"]["passed"] < len(requirement["scenarios"]):
                reasons.append(f"{check_id}: fewer passing tests than required browser scenarios")
            if set(scenarios) != {scenario["id"] for scenario in requirement["scenarios"]}:
                reasons.append(f"{check_id}: missing/unknown browser scenarios")
            screenshot_ids = []
            for scenario in scenarios.values():
                artifact_id = scenario["screenshot_artifact_id"]
                if scenario["status"] != "passed":
                    reasons.append(f"{check_id}/{scenario['id']}: browser scenario did not pass")
                if artifact_id is None or artifacts.get(artifact_id, {}).get("kind") != "screenshot":
                    reasons.append(f"{check_id}/{scenario['id']}: screenshot required")
                    continue
                screenshot_ids.append(artifact_id)
                # Format sanity only, not proof of visual correctness/authenticity.
                with resolved[artifact_id].open("rb") as image:
                    header = image.read(24)
                if len(header) < 24 or header[:8] != b"\x89PNG\r\n\x1a\n" or header[12:16] != b"IHDR" or int.from_bytes(header[16:20], "big") == 0 or int.from_bytes(header[20:24], "big") == 0:
                    reasons.append(f"{check_id}/{scenario['id']}: expected a PNG screenshot")
            if len(set(screenshot_ids)) != len(screenshot_ids):
                reasons.append(f"{check_id}: each scenario needs a distinct screenshot artifact")
    except (ValueError, KeyError, IndexError, TypeError, OSError) as error:
        reasons.append(str(error))
    except ValidationError as error:
        reasons.append(error.message)
    return {"status": "blocked" if reasons else "passed", "reasons": reasons, "deferred_checks": deferred,
            "pending_gates": ["independent_review", "integration_approval"],
            "integration_allowed": False}
