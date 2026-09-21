"""Atomic read-only-consumer export. Producing state never launches an agent."""
from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone

from .sessions import read_json, save_json

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
    value = {"version": "1.0.0", "run_id": runtime.plan["run_id"], "base_commit": runtime.plan["base_commit"],
             "created_at": created, "definition": {"name": "Feature implementation", "nodes": GRAPH_NODES},
             "values": dict(state.values), "next": list(state.next), "tasks": tasks, "events": events,
             "verification_packets": packets}
    if previous and {key: item for key, item in previous.items() if key != "updated_at"} == value:
        return previous
    value["updated_at"] = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    save_json(path, value)
    return value
