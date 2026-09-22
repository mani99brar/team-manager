"""Atomic read-only-consumer export. Producing state never launches an agent.

Export versions: 1.0.0 graph state, events and packets; 1.1.0 adds the `review` section;
1.2.0 adds the `inputs` section. Sections are additive and `null` when their files are absent.
"""
from __future__ import annotations

import hashlib
import json
import shlex
from datetime import datetime, timezone
from pathlib import Path

from .sessions import NODES, read_json, save_json

EXPORT_VERSION = "1.2.0"
TASK_BYTE_LIMIT = 256 * 1024
TASK_TRUNCATED_MARKER = "\n[task text truncated by the export at 256 KiB]"

GRAPH_NODES = [
    {"node_id": "launch_ui", "label": "Launch UI worker", "kind": "worker", "depends_on": []},
    {"node_id": "launch_adapter", "label": "Launch adapter worker", "kind": "worker", "depends_on": []},
    {"node_id": "handoff", "label": "Freeze worker handoffs", "kind": "prepare", "depends_on": ["launch_ui", "launch_adapter"]},
    {"node_id": "verify_ui", "label": "Verify UI", "kind": "verification", "depends_on": ["handoff"]},
    {"node_id": "verify_adapter", "label": "Verify adapter", "kind": "verification", "depends_on": ["handoff"]},
    {"node_id": "candidate", "label": "Verify combined candidate", "kind": "verification", "depends_on": ["verify_ui", "verify_adapter"]},
    {"node_id": "review", "label": "Independent review", "kind": "review", "depends_on": ["candidate"]},
    {"node_id": "approval", "label": "Integration approval", "kind": "integration", "depends_on": ["review"]},
    {"node_id": "integrate", "label": "Integrate candidate", "kind": "integration", "depends_on": ["approval"]},
]


def iso(value) -> str | None:
    """Receipts store native start times as epoch milliseconds; the export speaks ISO 8601."""
    if isinstance(value, (int, float)):
        return datetime.fromtimestamp(value / 1000, timezone.utc).isoformat().replace("+00:00", "Z")
    if isinstance(value, str) and value:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return parsed.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    return None


def optional_json(path: Path) -> dict | None:
    return read_json(path) if path.exists() and not path.is_symlink() else None


def export_review(directory: Path, events: list[dict]) -> dict | None:
    """The recorded review, for either verdict. `None` until `review.json` exists."""
    review = optional_json(directory / "review.json")
    if review is None:
        return None
    receipt = optional_json(directory / "automatic-review.json") or {}
    launch = optional_json(directory / "review.interactive.json")
    transport = receipt.get("transport") or ("print" if receipt else "manual")
    reviewed_at = next((event["time"] for event in reversed(events) if event["node"] == "review" and event["status"] in {"approved", "stopped"}), None)
    if reviewed_at is None:
        reviewed_at = datetime.fromtimestamp((directory / "review.json").stat().st_mtime, timezone.utc).isoformat().replace("+00:00", "Z")
    patch = directory / "review.diff"
    diff = None
    if patch.is_file() and not patch.is_symlink():
        diff = {"path": "review.diff", "sha256": hashlib.sha256(patch.read_bytes()).hexdigest(), "bytes": patch.stat().st_size}
    session = None
    if launch:
        session = {key: launch.get(key) for key in ("session_id", "background_id", "status", "launch_requested_at", "observed_state", "launcher_invocations")}
        session["native_started_at"] = iso(launch.get("native_started_at"))
    findings = [{"severity": f["severity"], "message": f["message"], "disposition": f["disposition"],
                 "worker": f.get("worker"), "requirement": f.get("requirement")} for f in review["findings"]]
    return {"verdict": review["verdict"], "reviewer": review["reviewer"], "independent": review["independent"],
            "transport": transport, "attempt": 1, "bundle_sha256": review["bundle_sha256"], "candidate_commit": review["candidate_commit"],
            "findings": findings, "reviewed_at": reviewed_at, "session": session, "diff": diff}


def export_inputs(directory: Path, plan: dict, policy: dict | None) -> dict | None:
    """What the run and each worker were given, from the run's own pinned files. `None` without a policy."""
    if policy is None or "source_branch" not in plan:
        return None
    workers = []
    for worker in policy["workers"]:
        node = worker["node_id"]
        task = plan["nodes"][node]["task"]
        truncated = len(task.encode()) > TASK_BYTE_LIMIT
        if truncated:
            task = task.encode()[:TASK_BYTE_LIMIT].decode(errors="ignore") + TASK_TRUNCATED_MARKER
        launch = optional_json(directory / f"{node}.interactive.json")
        completion = optional_json(directory / f"{node}.completion.json")
        stop = optional_json(directory / f"{node}.stop.json")
        workers.append({
            "node_id": node, "role": worker["role"], "task": task, "task_truncated": truncated,
            "owned_paths": list(worker["owned_paths"]),
            "checks": [{"id": check["id"], "kind": check["kind"], "command": shlex.join(check["argv"]),
                        "timeout_seconds": check["timeout_seconds"], "scenarios": [dict(s) for s in check.get("scenarios", [])]}
                       for check in worker["checks"]],
            "launch": None if launch is None else {
                "status": launch.get("status"), "session_id": launch.get("session_id"), "launch_token": launch.get("launch_token"),
                "launch_requested_at": iso(launch.get("launch_requested_at")), "native_started_at": iso(launch.get("native_started_at")),
                "observed_state": launch.get("observed_state"), "launcher_invocations": launch.get("launcher_invocations", 0)},
            "completion": None if completion is None else {key: completion.get(key) for key in ("status", "summary", "open_assumptions")},
            "handoff": optional_json(directory / f"{node}.handoff.json"),
            "stopped": None if stop is None else bool(stop.get("stopped")),
            "stopped_at": None if stop is None else iso(stop.get("stopped_at")),
        })
    return {"feature": plan.get("feature"), "base_commit": plan["base_commit"], "source_branch": plan["source_branch"],
            "mode": plan.get("mode"), "created_at": plan.get("created_at"), "automatic": plan.get("automatic"),
            "setup": [{"command": shlex.join(step["argv"]), "timeout_seconds": step["timeout_seconds"]} for step in policy.get("setup", [])],
            "max_verification_attempts": policy.get("max_verification_attempts", 3), "workers": workers}


def export_state(runtime, state) -> dict:
    path = runtime.directory / "run-state.json"
    previous = read_json(path) if path.exists() else None
    events_path = runtime.directory / "events.jsonl"
    events = [json.loads(line) for line in events_path.read_text().splitlines()] if events_path.exists() else []
    tasks = [{"node_id": task.name, "error": str(task.error) if task.error else None,
              "interrupts": [item.value for item in task.interrupts],
              "result": getattr(task, "result", None)} for task in state.tasks]
    created = runtime.plan.get("created_at") or datetime.fromtimestamp((runtime.directory / "plan.json").stat().st_mtime, timezone.utc).isoformat().replace("+00:00", "Z")
    packets = []
    for packet_path in sorted((runtime.directory / "verification").glob("*/*/*/packet.json")):
        relative = packet_path.relative_to(runtime.directory)
        _, phase, node, attempt, _ = relative.parts
        packets.append({"phase": phase, "node_id": node, "attempt": int(attempt), "path": str(relative),
                        "sha256": hashlib.sha256(packet_path.read_bytes()).hexdigest()})
    policy = getattr(runtime, "policy", None) or optional_json(runtime.directory / "policy.json")
    value = {"version": EXPORT_VERSION, "run_id": runtime.plan["run_id"], "base_commit": runtime.plan["base_commit"],
             "created_at": created, "definition": {"name": "Feature implementation", "nodes": GRAPH_NODES},
             "values": dict(state.values), "next": list(state.next), "tasks": tasks, "events": events,
             "verification_packets": packets,
             "review": export_review(runtime.directory, events),
             "inputs": export_inputs(runtime.directory, runtime.plan, policy)}
    if previous and {key: item for key, item in previous.items() if key != "updated_at"} == value:
        return previous
    value["updated_at"] = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    save_json(path, value)
    return value
