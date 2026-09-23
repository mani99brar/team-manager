"""Atomic read-only-consumer export. Producing state never launches an agent.

Version 1.2.0 adds two sections derived from the run's own files: `review`
(the persisted verdict) and `inputs` (what the run was asked to do). Missing
evidence is `null`; a malformed optional receipt is `null` too, never guessed.
The reviewer transport of a plan pinned before that setting existed is the one
the run's receipts record, or `null` before any reviewer ran; never a default.

Version 1.3.0 (additive) takes the worker lanes from the run's plan: the graph
definition has one `launch_<lane>` and one `verify_<lane>` node per selected
lane, `inputs.workers` is keyed by those lanes in policy order with each lane's
`required_check_kinds`, and `inputs` records `selected_workers` and
`excluded_workers`. A run exported before keeps its stored definition when it
names the same nodes, so re-exporting an old run changes no labels.

Version 1.4.0 (additive) records the run's reviewers: the `review` section gains
`reviewers` (one entry per reviewer: id, transport, session id, verdict, its
findings, launch and acceptance times, status) and each combined finding gains
`reviewer`. A review recorded before parallel reviewers has one reviewer named
`review`; the export fills the list from the single record it has.

Version 1.5.0 (additive, docs/PRD_PORTABLE_WORKFLOW.md section 4.7) records the
guardrails of feature.json 2.2.0 runs: `inputs.decisions` (the pinned decisions.md
text), `inputs.challenge` (the latest `challenge.json` without `run_id` and
`version`, plus `attempts`), the completion evidence `untested`, `falsifying_check`
and `verify_yourself` (null for a 1.0.0 completion) with the `question` status, and
`inputs.workers.<lane>.questions`. Every addition is null or `[]` for older runs.
The definition of a run with a design challenge starts with the `challenge` node.
A completion is served only as the controller reads it, with its `version` and the
text of a `question` not recorded yet; a fourth question is served as `blocked`.
"""
from __future__ import annotations

import hashlib
import json
import shlex
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace

from .guardrails import MAX_QUESTIONS, decisions_text, has_challenge
from .sessions import DEFAULT_REVIEWER, plan_excluded, plan_workers, read_json, review_node, save_json
from .verification import required_kinds

EXPORT_VERSION = "1.5.0"
# The controller's per-reviewer status words, as the viewer contract spells them; anything else is still pending.
REVIEWER_STATUS = {"succeeded": "accepted", "accepted": "accepted", "blocked": "blocked", "superseded": "superseded"}

GRAPH_TAIL = [
    {"node_id": "candidate", "label": "Verify combined candidate", "kind": "verification"},
    {"node_id": "review", "label": "Independent review", "kind": "review", "depends_on": ["candidate"]},
    {"node_id": "approval", "label": "Integration approval", "kind": "integration", "depends_on": ["review"]},
    {"node_id": "integrate", "label": "Integrate candidate", "kind": "integration", "depends_on": ["approval"]},
]


CHALLENGE_NODE = {"node_id": "challenge", "label": "Design challenge", "kind": "review", "depends_on": []}


def graph_nodes(workers: list[str], challenge: bool = False) -> list[dict]:
    """The pinned graph of a run over `workers`: per-lane launch and verify fan-outs around the fixed tail.

    A 2.2.0 run with its design challenge starts with the `challenge` node, and every launch depends on it.
    """
    launches = [f"launch_{node}" for node in workers]
    verifies = [f"verify_{node}" for node in workers]
    first = [CHALLENGE_NODE["node_id"]] if challenge else []
    nodes = [dict(CHALLENGE_NODE, depends_on=[])] if challenge else []
    nodes.extend({"node_id": name, "label": f"Launch {node} worker", "kind": "worker", "depends_on": list(first)} for node, name in zip(workers, launches))
    nodes.append({"node_id": "handoff", "label": "Freeze worker handoffs", "kind": "prepare", "depends_on": launches})
    nodes.extend({"node_id": name, "label": f"Verify {node}", "kind": "verification", "depends_on": ["handoff"]} for node, name in zip(workers, verifies))
    for item in GRAPH_TAIL:
        nodes.append({**item, "depends_on": list(item.get("depends_on", verifies))})
    return nodes


def definition(workers: list[str], previous: dict | None, challenge: bool = False) -> dict:
    """A stored definition over the same nodes is kept verbatim (labels included); anything else is rebuilt."""
    nodes = graph_nodes(workers, challenge)
    stored = (previous or {}).get("definition")
    if isinstance(stored, dict) and isinstance(stored.get("nodes"), list) and stored.get("name") and \
            [item.get("node_id") for item in stored["nodes"]] == [item["node_id"] for item in nodes]:
        return stored
    return {"name": "Feature implementation", "nodes": nodes}


def utc(timestamp: float) -> str:
    return datetime.fromtimestamp(timestamp, timezone.utc).isoformat().replace("+00:00", "Z")


def zulu(value: str) -> str:
    """Receipts store a +00:00 offset; the export spells UTC with a trailing Z."""
    return value.replace("+00:00", "Z")


def load_optional(path: Path):
    """An absent, non-regular or malformed optional file is None: absent evidence, never invented."""
    if path.is_symlink() or not path.is_file():
        return None
    try:
        return read_json(path)
    except ValueError:
        return None


def read_events(directory: Path) -> list:
    path = directory / "events.jsonl"
    return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []


def string_list(value) -> bool:
    return isinstance(value, list) and all(isinstance(item, str) and item.strip() for item in value)


def recorded_transport(directory: Path) -> str | None:
    """The transport the run's own reviewer receipts record; None when no reviewer has run."""
    if (directory / "review.interactive.json").exists() or any(directory.glob("review-*.interactive.json")):
        return "native"
    if (directory / "automatic-review.json").exists():
        return "print"
    return None


def reviewer_entries(directory: Path, review: dict, findings: list, transport: str, reviewed_at: str) -> list[dict]:
    """One entry per reviewer of the combined record; a record without `reviewers` is the single default reviewer."""
    recorded = review.get("reviewers")
    entries = recorded if recorded is not None else [{"reviewer_id": DEFAULT_REVIEWER, "session_id": review["reviewer"], "verdict": review["verdict"], "accepted_at": None}]
    result = []
    for entry in entries:
        node = review_node(entry["reviewer_id"])
        status_file = load_optional(directory / f"automatic-{node}.json") or {}
        receipt = load_optional(directory / f"{node}.interactive.json") or {}
        launched = receipt.get("launch_requested_at")
        accepted = entry.get("accepted_at")
        if not isinstance(accepted, str) and entry["verdict"] is not None:
            accepted = reviewed_at  # A record before per-reviewer acceptance times: the review's own time.
        status = REVIEWER_STATUS.get(status_file.get("status")) or {"approved": "accepted", "blocked": "blocked"}.get(entry["verdict"]) or "pending"
        result.append({"reviewer_id": entry["reviewer_id"], "transport": transport, "session_id": entry["session_id"], "verdict": entry["verdict"],
                       "findings": [finding for finding in findings if finding["reviewer"] == entry["reviewer_id"]],
                       "launched_at": zulu(launched) if isinstance(launched, str) else None,
                       "accepted_at": accepted if isinstance(accepted, str) else None, "status": status})
    return result


def review_section(directory: Path) -> dict | None:
    review = load_optional(directory / "review.json")
    if review is None:
        return None
    receipt = load_optional(directory / "automatic-review.json") or {}
    transport = recorded_transport(directory) or "manual"
    reviewed_at = receipt.get("accepted_at")
    if not isinstance(reviewed_at, str):
        times = [event["time"] for event in read_events(directory) if event.get("node") == "review"]
        reviewed_at = times[-1] if times else utc((directory / "review.json").stat().st_mtime)
    diff = None
    patch = directory / "review.diff"
    if patch.is_file() and not patch.is_symlink():
        with patch.open("rb") as handle:
            diff = {"path": "review.diff", "sha256": hashlib.file_digest(handle, "sha256").hexdigest(), "bytes": patch.stat().st_size}
    findings = [{"severity": finding["severity"], "message": finding["message"], "disposition": finding["disposition"],
                 "worker": finding.get("worker"), "requirement": finding.get("requirement"),
                 "reviewer": finding.get("reviewer", DEFAULT_REVIEWER)} for finding in review["findings"]]
    return {"attempt": 1, "transport": transport, "reviewer_session_id": review["reviewer"], "independent": review["independent"],
            "bundle_sha256": review["bundle_sha256"], "candidate_commit": review["candidate_commit"], "verdict": review["verdict"],
            "findings": findings, "reviewers": reviewer_entries(directory, review, findings, transport, reviewed_at),
            "reviewed_at": reviewed_at, "diff": diff}


def launch_receipt(item) -> dict | None:
    if (not isinstance(item, dict) or not isinstance(item.get("launch_requested_at"), str) or not isinstance(item.get("launch_token"), str)
            or not isinstance(item.get("status"), str) or type(item.get("launcher_invocations")) is not int):
        return None
    optional = {key: item.get(key) if isinstance(item.get(key), str) else None for key in ("session_id", "observed_state", "background_id")}
    started = item.get("native_started_at")
    return {"session_id": optional["session_id"], "launch_token": item["launch_token"], "launch_requested_at": zulu(item["launch_requested_at"]),
            "native_started_at": started if type(started) is int else None, "observed_state": optional["observed_state"],
            "status": item["status"], "launcher_invocations": item["launcher_invocations"], "background_id": optional["background_id"]}


def optional_text(value) -> str | None:
    return value if isinstance(value, str) and value.strip() else None


def completion_signal(directory: Path, plan: dict, node: str, questions: list) -> dict | None:
    """The worker's completion file as the controller reads it (`automatic.read_signal`); null when the controller refuses it.

    A missing, malformed, stale or foreign file, or one of another version than the run pinned, is not the worker's signal.
    `version` is that pinned version: a 1.0.0 completion has no evidence (null), and an empty 1.1.0 field is null too. A
    `question` after the lane's third recorded question is served as `blocked`, as `record_question` treats it; `question`
    carries the text of a question the controller has not recorded, and is null for every other completion.
    """
    from .automatic import read_signal
    try:
        item = read_signal(SimpleNamespace(directory=directory, plan=plan), node)
    except ValueError:
        return None
    status = "blocked" if item["status"] == "question" and len(questions) >= MAX_QUESTIONS else item["status"]
    untested = item.get("untested")
    return {"version": item["version"], "status": status, "summary": item["summary"], "open_assumptions": list(item["open_assumptions"]),
            "untested": list(untested) if isinstance(untested, list) else None,
            "falsifying_check": optional_text(item.get("falsifying_check")), "verify_yourself": optional_text(item.get("verify_yourself")),
            "question": item["question"] if item["status"] == "question" else None}


QUESTION_KEYS = ("n", "question", "asked_at", "answer", "answered_at")


def worker_questions(path: Path) -> list:
    """`<node>.questions.json` as `{n, question, asked_at, answer, answered_at}` entries; `[]` when absent or malformed."""
    item = load_optional(path)
    questions = item.get("questions") if isinstance(item, dict) else None
    if not isinstance(questions, list):
        return []
    result = []
    for entry in questions:
        if (not isinstance(entry, dict) or type(entry.get("n")) is not int or not optional_text(entry.get("question"))
                or not isinstance(entry.get("asked_at"), str) or not (entry.get("answer") is None or isinstance(entry.get("answer"), str))
                or not (entry.get("answered_at") is None or isinstance(entry.get("answered_at"), str))
                or (entry.get("answer") is None) != (entry.get("answered_at") is None)):
            return []
        result.append({key: entry.get(key) for key in QUESTION_KEYS})
    return result


def challenge_section(directory: Path) -> dict | None:
    """The latest `challenge.json` without `run_id` and `version`, plus `attempts`; null when absent or invalid."""
    item = load_optional(directory / "challenge.json")
    if item is None:
        return None
    from jsonschema.exceptions import ValidationError
    from .verification import validate_schema
    try:
        validate_schema("challenge", item)
    except ValidationError:
        return None
    section = {key: value for key, value in item.items() if key not in {"run_id", "version"}}
    section["attempts"] = item["attempt"]
    return section


def accepted_handoff(item) -> dict | None:
    if not isinstance(item, dict) or not isinstance(item.get("summary"), str) or not item["summary"].strip() or not string_list(item.get("open_assumptions")):
        return None
    return {"summary": item["summary"], "open_assumptions": list(item["open_assumptions"])}


def stop_confirmation(path: Path) -> dict | None:
    item = load_optional(path)
    if not isinstance(item, dict) or not isinstance(item.get("stopped"), bool):
        return None
    return {"stopped": item["stopped"], "confirmed_at": utc(path.stat().st_mtime) if item["stopped"] else None}


def worker_inputs(directory: Path, plan: dict, policy: dict, worker: dict) -> dict:
    node = worker["node_id"]
    prompt = directory / f"{node}.prompt.txt"
    questions = worker_questions(directory / f"{node}.questions.json")
    return {"role": worker["role"], "required_check_kinds": required_kinds(policy, worker), "task": plan["nodes"][node]["task"],
            "prompt": prompt.read_text() if prompt.is_file() and not prompt.is_symlink() else None,
            "owned_paths": list(worker["owned_paths"]),
            "checks": [{"id": check["id"], "kind": check["kind"], "argv": list(check["argv"]), "command": shlex.join(check["argv"]),
                        "timeout_seconds": check["timeout_seconds"],
                        "scenarios": [{"id": scenario["id"], "description": scenario["description"]} for scenario in check["scenarios"]]}
                       for check in worker["checks"]],
            "launch": launch_receipt(load_optional(directory / f"{node}.interactive.json")),
            "completion": completion_signal(directory, plan, node, questions),
            "handoff": accepted_handoff(load_optional(directory / f"{node}.handoff.json")),
            "stop": stop_confirmation(directory / f"{node}.stop.json"),
            "questions": questions}


def inputs_section(directory: Path, plan: dict, policy: dict) -> dict:
    automatic = plan.get("automatic")
    workers = plan_workers(plan)
    declared = [worker["node_id"] for worker in policy["workers"]]
    if not set(workers) <= set(declared):
        raise ValueError("Plan selects lanes the pinned policy does not declare")
    return {"feature": policy["feature"], "policy_version": policy["version"], "base_commit": plan["base_commit"],
            "source_branch": plan.get("source_branch"), "mode": "automatic" if automatic else "manual",
            "automatic": None if not automatic else {
                "finish": automatic["finish"], "permission_mode": automatic["permission_mode"],
                "worker_timeout_seconds": automatic["worker_timeout_seconds"], "review_timeout_seconds": automatic["review_timeout_seconds"],
                # Plans pinned before the setting: the transport the receipts record, null before any reviewer ran.
                "reviewer_transport": automatic["reviewer_transport"] if "reviewer_transport" in automatic else recorded_transport(directory)},
            "setup": [{"argv": list(item["argv"]), "command": shlex.join(item["argv"]), "timeout_seconds": item["timeout_seconds"]}
                      for item in policy.get("setup", [])],
            "max_verification_attempts": policy.get("max_verification_attempts", 3),
            # A drill naming an excluded lane is pinned as null at prepare; plans before the selection keep the policy's.
            "failure_drill": plan["failure_drill"] if "failure_drill" in plan else policy.get("failure_drill"),
            "selected_workers": list(workers), "excluded_workers": plan_excluded(plan),
            "decisions": decisions_text(plan), "challenge": challenge_section(directory),
            "workers": {worker["node_id"]: worker_inputs(directory, plan, policy, worker) for worker in policy["workers"] if worker["node_id"] in workers}}


def export_state(runtime, state) -> dict:
    """Needs only runtime.directory and runtime.plan; policy comes from runtime.policy or policy.json when present."""
    path = runtime.directory / "run-state.json"
    previous = read_json(path) if path.exists() else None
    events = read_events(runtime.directory)
    tasks = [{"node_id": task.name, "error": str(task.error) if task.error else None,
              "interrupts": [item.value for item in task.interrupts],
              "result": getattr(task, "result", None)} for task in state.tasks]
    created = runtime.plan.get("created_at") or utc((runtime.directory / "plan.json").stat().st_mtime)
    packets = []
    for packet_path in sorted((runtime.directory / "verification").glob("*/*/*/packet.json")):
        relative = packet_path.relative_to(runtime.directory)
        _, phase, node, attempt, _ = relative.parts
        packets.append({"phase": phase, "node_id": node, "attempt": int(attempt), "path": str(relative),
                        "sha256": hashlib.sha256(packet_path.read_bytes()).hexdigest()})
    policy = getattr(runtime, "policy", None) or load_optional(runtime.directory / "policy.json")
    value = {"version": EXPORT_VERSION, "run_id": runtime.plan["run_id"], "base_commit": runtime.plan["base_commit"],
             "created_at": created, "definition": definition(plan_workers(runtime.plan), previous, has_challenge(runtime.plan)),
             "values": dict(state.values), "next": list(state.next), "tasks": tasks, "events": events,
             "verification_packets": packets,
             "review": review_section(runtime.directory),
             "inputs": inputs_section(runtime.directory, runtime.plan, policy) if policy else None}
    if previous and {key: item for key, item in previous.items() if key != "updated_at"} == value:
        return previous
    value["updated_at"] = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    save_json(path, value)
    return value
