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

Version 1.6.0 (additive, docs/PRD_REVIEW_SIDECAR.md section 4.7) records the review
sidecar of feature.json 2.3.0 runs: the top-level `sidecar` section is the ledger as
written (`<run>/sidecar.ledger.json`, contracts/workflow/sidecar.schema.json), the
empty ledger before its first pass, and `null` for a run without a sidecar (every run
prepared before) or a ledger that fails the schema. The definition of a run with a
sidecar has the `sidecar` node right after `challenge` (first without one), before
every launch, and `handoff` depends on it last. Everything else is 1.5.0 unchanged.

Version 1.7.0 (additive, C52) records what prepare pinned about who runs the run:
`inputs.roles` (the workers' and the judges' model and effort, plan.roles),
`inputs.controller` (the controller checkout's commit, its dirty flag and the
`claude --version` line, plan.controller) and `inputs.automatic.profile`
(attended or unattended). Each key is left out for a run prepared before it,
as it was; everything else is 1.6.0 unchanged. Within 1.7.0 (C8), `inputs.challenge`
gains `hold` ({held_at, released_at, released_by, dropped}) when `challenge-hold.json`
records a run held after a passing challenge, and its release. A record marked `"held": false`
(a rerun that passed under resume --launch, never held) exports no `hold`. The
status stays `passed`; the key is left out for every other run. Within 1.7.0 (C7, C29),
`inputs.tryout` ({required, verdicts, allow_untried}) carries plan.tryout, the verdicts of
`tryout.json` and the reason a launch went past the untried-feature limit (only when
pinned); the key is left out for a run prepared before it.
Within 1.7.0 (C49), `inputs.challenge`
gains `history`: each archived attempt (`challenge-<n>.json`) with its status, decision time and P0/P1 concerns, left
out when no earlier record was archived; and the top-level `costs` section (workflow/costs.py) lists what each session cost by role, with
a run total, null where unknown.

Version 1.8.0 (additive, docs/PRD_ATTACK_PASS.md Appendix A) records the attack pass of
feature.json 2.5.0 runs: the top-level `attack` section is `<run>/attack.json` as written
(contracts/workflow/attack.schema.json), a `pending` record while the plan has `attack` but
no attack.json exists yet, a `failed` record when attack.json does not validate, and `null`
for a run without `plan.attack` (every run prepared before). The definition of a run with an
attack pass has the `attack` node right after `review` (same depends_on), and `approval`
depends on both `review` and `attack`. Everything else is 1.7.0 unchanged.

Version 1.9.0 (additive, docs/PRD_MULTI_PROVIDER_PANEL.md Appendix A) records the multi-provider
panels of feature.json 2.6.0 runs: the top-level `panels` section is `<run>/panel.json` verbatim
(contracts/workflow/panel.schema.json, the object `{version, panels: [...]}`), a `pending` record
built from `plan.panels` while no panel.json exists yet, a `failed` record (each panel with its
`error`) when panel.json does not validate, and `null` for a run without `plan.panels` (every run
prepared before). The graph definition is NOT changed (no panel node this slice) and the `costs`
section is not changed (panel costs live in panel.json only), so every older run exports
byte-for-byte as under 1.8.0 apart from the version and the null section.

Version 1.10.0 (additive, docs/PRD_VIEWER_REFINE.md Appendix A.1) records the in-run fix loop (RUNBOOK "In-run fix loop"):
the top-level `fix_loop` section (`{version, rounds, repairs, review_rounds}`) is built from `<run>/repairs.json` (session
repairs only; an operator `--commit` repair stays a timeline marker), `<run>/review-rounds.json`, the repair receipts
`repair-<n>.interactive.json` and the archived `review.round-<k>.json`; it is `null` for a plan without
`automatic.fix_rounds` and without a `repairs.json`, and the error form `{version, error, rounds: null, repairs: [],
review_rounds: []}` for a journal that is malformed (never a crash). `review` gains `round` (1 + the archived rounds; 1
without rounds), `delta_from` and `delta_diff` (an artifact reference to `review.delta.diff`, null without the file);
`inputs.automatic` gains `fix_rounds` (left out for a plan without it) and `inputs.workers.<lane>` gains `roles`
(plan.nodes.<lane>.roles, null before lane pins) and `skills` (plan.nodes.<lane>.skills, [] without). The graph
definition is NOT changed: the server projects one `repair-<n>` node per session repair from `fix_loop`. A run without
those records exports its 1.9.0 content plus the version and the new keys.
"""
from __future__ import annotations

import hashlib
import json
import re
import shlex
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace

from .costs import costs_section
from .guardrails import HOLD, MAX_QUESTIONS, decisions_text, has_challenge
from .attack import export_section as attack_section, has_attack
from .panel import export_section as panel_section
from .sidecar import has_sidecar, initial_ledger, ledger_path
from .sessions import DEFAULT_REVIEWER, plan_excluded, plan_workers, read_json, review_node, save_json
from .verification import required_kinds

EXPORT_VERSION = "1.10.0"
# The controller's per-reviewer status words, as the viewer contract spells them; anything else is still pending.
REVIEWER_STATUS = {"succeeded": "accepted", "accepted": "accepted", "blocked": "blocked", "superseded": "superseded"}

GRAPH_TAIL = [
    {"node_id": "candidate", "label": "Verify combined candidate", "kind": "verification"},
    {"node_id": "review", "label": "Independent review", "kind": "review", "depends_on": ["candidate"]},
    {"node_id": "approval", "label": "Integration approval", "kind": "integration", "depends_on": ["review"]},
    {"node_id": "integrate", "label": "Integrate candidate", "kind": "integration", "depends_on": ["approval"]},
]


CHALLENGE_NODE = {"node_id": "challenge", "label": "Design challenge", "kind": "review", "depends_on": []}
# The workflow v1 node kinds are frozen: the sidecar, an agent beside the workers, is a `review` node like the challenge.
SIDECAR_NODE = {"node_id": "sidecar", "label": "Review sidecar", "kind": "review", "depends_on": []}
# The attack pass of feature.json 2.5.0: a `review` node right after `review`, with the same depends_on; `approval` then
# depends on both (docs/PRD_ATTACK_PASS.md Appendix A). Only a plan with `attack` has it; every other graph is unchanged.
ATTACK_NODE = {"node_id": "attack", "label": "Attack pass", "kind": "review", "depends_on": ["candidate"]}


def graph_nodes(workers: list[str], challenge: bool = False, sidecar: bool = False, attack: bool = False) -> list[dict]:
    """The pinned graph of a run over `workers`: per-lane launch and verify fan-outs around the fixed tail.

    A 2.2.0 run with its design challenge starts with the `challenge` node, and every launch depends on it. A 2.3.0 run
    with a review sidecar has the `sidecar` node next (depending on the challenge, if any) and `handoff` depends on it last.
    A 2.5.0 run with an attack pass has the `attack` node right after `review` (same depends_on), and `approval` depends on
    both `review` and `attack`.
    """
    launches = [f"launch_{node}" for node in workers]
    verifies = [f"verify_{node}" for node in workers]
    first = [CHALLENGE_NODE["node_id"]] if challenge else []
    nodes = [dict(CHALLENGE_NODE, depends_on=[])] if challenge else []
    if sidecar:
        nodes.append(dict(SIDECAR_NODE, depends_on=list(first)))
    nodes.extend({"node_id": name, "label": f"Launch {node} worker", "kind": "worker", "depends_on": list(first)} for node, name in zip(workers, launches))
    nodes.append({"node_id": "handoff", "label": "Freeze worker handoffs", "kind": "prepare", "depends_on": launches + ([SIDECAR_NODE["node_id"]] if sidecar else [])})
    nodes.extend({"node_id": name, "label": f"Verify {node}", "kind": "verification", "depends_on": ["handoff"]} for node, name in zip(workers, verifies))
    for item in GRAPH_TAIL:
        node = {**item, "depends_on": list(item.get("depends_on", verifies))}
        if attack and node["node_id"] == "approval":
            node["depends_on"] = ["review", ATTACK_NODE["node_id"]]
        nodes.append(node)
        if attack and node["node_id"] == "review":
            nodes.append(dict(ATTACK_NODE, depends_on=list(ATTACK_NODE["depends_on"])))
    return nodes


def definition(workers: list[str], previous: dict | None, challenge: bool = False, sidecar: bool = False, attack: bool = False) -> dict:
    """A stored definition over the same nodes is kept verbatim (labels included); anything else is rebuilt."""
    nodes = graph_nodes(workers, challenge, sidecar, attack)
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


DELTA_DIFF = "review.delta.diff"


def artifact_reference(directory: Path, name: str) -> dict | None:
    """`{path, sha256, bytes}` of a regular file of the run directory, served as `review.diff` is; null without it."""
    path = directory / name
    if path.is_symlink() or not path.is_file():
        return None
    with path.open("rb") as handle:
        return {"path": name, "sha256": hashlib.file_digest(handle, "sha256").hexdigest(), "bytes": path.stat().st_size}


def raw_review_rounds(directory: Path) -> list[dict]:
    """The records of review-rounds.json that are objects; [] when it is absent or malformed (the `review` section never fails on it)."""
    item = load_optional(directory / "review-rounds.json")
    rounds = item.get("rounds") if isinstance(item, dict) else None
    return [entry for entry in rounds if isinstance(entry, dict)] if isinstance(rounds, list) else []


def delta_from(receipt: dict, plan: dict | None, delta_diff: dict | None) -> str | None:
    """The combined status's `delta_from` when recorded, else the followed run's candidate when a delta diff exists, else null."""
    if isinstance(receipt.get("delta_from"), str):
        return receipt["delta_from"]
    follows = (plan or {}).get("follows")
    if delta_diff is not None and isinstance(follows, dict) and isinstance(follows.get("candidate_commit"), str):
        return follows["candidate_commit"]
    return None


def review_section(directory: Path, plan: dict | None = None) -> dict | None:
    review = load_optional(directory / "review.json")
    if review is None:
        return None
    receipt = load_optional(directory / "automatic-review.json") or {}
    transport = recorded_transport(directory) or "manual"
    reviewed_at = receipt.get("accepted_at")
    if not isinstance(reviewed_at, str):
        times = [event["time"] for event in read_events(directory) if event.get("node") == "review"]
        reviewed_at = times[-1] if times else utc((directory / "review.json").stat().st_mtime)
    diff = artifact_reference(directory, "review.diff")
    delta_diff = artifact_reference(directory, DELTA_DIFF)
    findings = [{"severity": finding["severity"], "message": finding["message"], "disposition": finding["disposition"],
                 "worker": finding.get("worker"), "requirement": finding.get("requirement"),
                 "reviewer": finding.get("reviewer", DEFAULT_REVIEWER)} for finding in review["findings"]]
    return {"attempt": 1, "transport": transport, "reviewer_session_id": review["reviewer"], "independent": review["independent"],
            "bundle_sha256": review["bundle_sha256"], "candidate_commit": review["candidate_commit"], "verdict": review["verdict"],
            "findings": findings, "reviewers": reviewer_entries(directory, review, findings, transport, reviewed_at),
            "reviewed_at": reviewed_at, "diff": diff,
            "round": 1 + sum(1 for entry in raw_review_rounds(directory) if entry.get("archived") is True),
            "delta_from": delta_from(receipt, plan, delta_diff), "delta_diff": delta_diff}


FIX_LOOP_VERSION = "1.0.0"
REPAIR_STATUSES = ("launched", "captured", "recorded", "applied", "blocked")
REPAIR_TRIGGERS = ("verify", "candidate", "review")
DELTA_BRIEF = re.compile(r"review\.delta(?:\.round-\d+)?\.diff")


def fix_loop_error(why: str) -> dict:
    return {"version": FIX_LOOP_VERSION, "error": why, "rounds": None, "repairs": [], "review_rounds": []}


def string_or_none(value) -> str | None:
    return value if isinstance(value, str) else None


def blocked_step(trigger: str, lane: str) -> str:
    """The pinned step a repair answers, as the server's repair node `depends_on` names it."""
    return {"verify": f"verify_{lane}", "candidate": "candidate", "review": "review"}[trigger]


def repair_entry(directory: Path, entry: dict) -> dict:
    """One session repair of repairs.json in the export's shape (Appendix A.1 item 2). `n`, `status`, `mode`, `trigger`, `round`,
    `rounds`, `lanes` (one key), `recorded_at`, `workspace_commit` and `by` must be there; every other key defaults to null or []."""
    for key, kind in (("n", int), ("round", int), ("rounds", int), ("status", str), ("trigger", str), ("by", str), ("recorded_at", str), ("workspace_commit", str)):
        if type(entry.get(key)) is not kind:
            raise ValueError(f"a repair entry has no {key}" if key not in entry else f"a repair entry has a malformed {key}")
    lanes = entry.get("lanes")
    if not isinstance(lanes, dict) or len(lanes) != 1:
        raise ValueError(f"repair {entry['n']} does not name exactly one lane")
    if entry["status"] not in REPAIR_STATUSES or entry["trigger"] not in REPAIR_TRIGGERS or entry["by"] not in ("controller", "operator", "maintainer"):
        raise ValueError(f"repair {entry['n']} has a status, trigger or actor the export does not know")
    lane = next(iter(lanes))
    trigger, number = entry["trigger"], entry["n"]
    step = blocked_step(trigger, lane)
    blocked = entry.get("blocked") if isinstance(entry.get("blocked"), dict) else {}
    packets = [packet for packet in (blocked.get("packets") if isinstance(blocked.get("packets"), list) else []) if isinstance(packet, dict)]
    reentered = list(dict.fromkeys(f"verify_{packet['node_id']}" for packet in packets if isinstance(packet.get("node_id"), str))) if trigger == "verify" else []
    brief = entry.get("brief") if isinstance(entry.get("brief"), dict) else {}
    findings = brief.get("findings")
    delta = brief.get("delta")
    receipt = load_optional(directory / f"repair-{number}.interactive.json")
    receipt = receipt if isinstance(receipt, dict) else {}
    requested = receipt.get("requested") if isinstance(receipt.get("requested"), dict) else None
    fix_files = lanes[lane].get("fix_files") if isinstance(lanes[lane], dict) else None
    gate = next((packet.get("reasons") for packet in packets if packet.get("node_id") == lane), None)
    session = entry.get("session") if isinstance(entry.get("session"), dict) else {}
    left_behind = entry.get("left_behind")
    return {"n": number, "node_id": f"repair-{number}", "mode": "session", "lane": lane, "trigger": trigger, "round": entry["round"], "rounds": entry["rounds"],
            "status": entry["status"], "by": entry["by"], **({"via": entry["via"]} if isinstance(entry.get("via"), str) else {}),
            "recorded_at": entry["recorded_at"], "applied_at": string_or_none(entry.get("applied_at")),
            "blocked_step": step, "reentered_steps": reentered or [step], "reason": string_or_none(entry.get("reason")),
            "workspace_commit": entry["workspace_commit"], "session_id": string_or_none(session.get("session_id")),
            "review_round": entry["review_round"] if type(entry.get("review_round")) is int else None,
            "findings": list(findings) if isinstance(findings, list) else [],
            "delta": isinstance(delta, str) and DELTA_BRIEF.fullmatch(Path(delta).name) is not None,
            "fix_files": strings(fix_files), "left_behind": strings(left_behind),
            "requested": {"model": requested.get("model"), "effort": requested.get("effort")} if requested is not None else None,
            "gate_reasons": list(gate) if isinstance(gate, list) else []}


def strings(value) -> list[str]:
    """The string items of a journal list (the live read filters the same way)."""
    return [item for item in value if isinstance(item, str)] if isinstance(value, list) else []


def round_reviewers(directory: Path, number: int) -> list[dict]:
    """The reviewers of an archived round, from `review.round-<k>.json`: id, verdict (`approved | blocked | null`) and session id.
    A record before parallel reviewers has the single reviewer `review`; an unreadable archive (or a restored round) has none."""
    review = load_optional(directory / f"review.round-{number}.json")
    if not isinstance(review, dict):
        return []
    recorded = review.get("reviewers")
    entries = recorded if isinstance(recorded, list) else [{"reviewer_id": DEFAULT_REVIEWER, "session_id": review.get("reviewer"), "verdict": review.get("verdict")}]
    return [{"reviewer_id": entry["reviewer_id"], "verdict": entry["verdict"] if entry.get("verdict") in ("approved", "blocked") else None,
             "session_id": string_or_none(entry.get("session_id"))} for entry in entries if isinstance(entry, dict) and isinstance(entry.get("reviewer_id"), str)]


def review_round_entry(directory: Path, entry: dict, repairs: list[dict]) -> dict:
    for key, kind in (("round", int), ("verdict", str), ("candidate", str), ("lane", str), ("findings", list), ("reviewer_sessions", list), ("started_at", str), ("archived", bool)):
        if type(entry.get(key)) is not kind:
            raise ValueError(f"a review round has no {key}" if key not in entry else f"a review round has a malformed {key}")
    return {"round": entry["round"], "verdict": entry["verdict"], "candidate": entry["candidate"], "lane": entry["lane"], "findings": list(entry["findings"]),
            "reviewer_sessions": list(entry["reviewer_sessions"]), "started_at": entry["started_at"], "archived": entry["archived"],
            "restored_at": string_or_none(entry.get("restored_at")),
            "repair_n": next((repair["n"] for repair in repairs if repair["review_round"] == entry["round"]), None),
            "reviewers": round_reviewers(directory, entry["round"]) if entry["archived"] else []}


def fix_loop_section(directory: Path, plan: dict) -> dict | None:
    """The in-run fix loop (1.10.0): null for a plan without `automatic.fix_rounds` and without a repairs.json, the error form for
    a journal or round list that does not parse (the panel's `failed` precedent), else the repairs and the review rounds."""
    automatic = plan.get("automatic") if isinstance(plan.get("automatic"), dict) else {}
    journal = directory / "repairs.json"
    if "fix_rounds" not in automatic and not journal.exists():
        return None
    try:
        repairs_item = read_json(journal) if journal.exists() else {"repairs": []}
        rounds_path = directory / "review-rounds.json"
        rounds_item = read_json(rounds_path) if rounds_path.exists() else {"rounds": []}
        if not isinstance(repairs_item, dict) or not isinstance(repairs_item.get("repairs"), list):
            raise ValueError("repairs.json has no repairs list")
        if not isinstance(rounds_item, dict) or not isinstance(rounds_item.get("rounds"), list):
            raise ValueError("review-rounds.json has no rounds list")
        sessions = [item for item in repairs_item["repairs"] if isinstance(item, dict) and item.get("mode") == "session"]
        repairs = [repair_entry(directory, item) for item in sessions]
        if not all(isinstance(item, dict) for item in rounds_item["rounds"]):
            raise ValueError("review-rounds.json holds an entry that is not an object")
        rounds = [review_round_entry(directory, item, repairs) for item in rounds_item["rounds"]]
    except (ValueError, OSError) as error:
        return fix_loop_error(str(error))
    configured = automatic.get("fix_rounds")
    return {"version": FIX_LOOP_VERSION, "rounds": configured if type(configured) is int else (repairs[-1]["rounds"] if repairs else 0),
            "repairs": repairs, "review_rounds": rounds}


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


HOLD_KEYS = ("held_at", "released_at", "released_by", "dropped")
ARCHIVED_CHALLENGE = re.compile(r"challenge-(\d+)\.json")


def challenge_history(directory: Path) -> list[dict]:
    """1.7.0 (C49): each attempt save_challenge archived (`challenge-<n>.json`), in order, as `{attempt, status, decided_at,
    concerns}` with its P0/P1 concerns only. An archive that fails the schema is left out, never guessed."""
    from jsonschema.exceptions import ValidationError
    from .verification import validate_schema
    archives = sorted((int(match.group(1)), path) for path in directory.iterdir() if (match := ARCHIVED_CHALLENGE.fullmatch(path.name)))
    history = []
    for _, path in archives:
        item = load_optional(path)
        try:
            validate_schema("challenge", item)
        except ValidationError:
            continue
        history.append({"attempt": item["attempt"], "status": item["status"], "decided_at": item["decided_at"],
                        "concerns": [concern for concern in item["concerns"] if concern["severity"] in {"P0", "P1"}]})
    return history


def challenge_section(directory: Path) -> dict | None:
    """The latest `challenge.json` without `run_id` and `version`, plus `attempts`; null when absent or invalid. With
    `hold` (C8) when `challenge-hold.json` records that attempt held: held, and once released when, by whom and the notes dropped.
    An attempt that passed under `resume --launch` was never held and has no `hold`."""
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
    hold = load_optional(directory / HOLD)
    # 1.7.0, C8: only the hold of the attempt shown, and never a release marked `"held": false` (a rerun that passed under --launch).
    if isinstance(hold, dict) and hold.get("attempt") == item["attempt"] and hold.get("held") is not False:
        section["hold"] = {key: hold.get(key) for key in HOLD_KEYS}
    history = challenge_history(directory)
    if history:  # 1.7.0, C49: left out when no earlier record was archived, as for every run exported before.
        section["history"] = history
    return section


def sidecar_section(directory: Path, plan: dict) -> dict | None:
    """The ledger as written; the empty ledger before it exists; null without a sidecar or for a ledger that fails its schema."""
    if not has_sidecar(plan):
        return None
    path = ledger_path(directory)
    if not path.exists():
        return initial_ledger(plan)
    item = load_optional(path)
    if item is None:
        return None
    from jsonschema.exceptions import ValidationError
    from .verification import validate_schema
    try:
        validate_schema("sidecar", item)
    except ValidationError:
        return None
    return item


def accepted_handoff(item) -> dict | None:
    if not isinstance(item, dict) or not isinstance(item.get("summary"), str) or not item["summary"].strip() or not string_list(item.get("open_assumptions")):
        return None
    return {"summary": item["summary"], "open_assumptions": list(item["open_assumptions"])}


def stop_confirmation(path: Path) -> dict | None:
    item = load_optional(path)
    if not isinstance(item, dict) or not isinstance(item.get("stopped"), bool):
        return None
    return {"stopped": item["stopped"], "confirmed_at": utc(path.stat().st_mtime) if item["stopped"] else None}


def lane_roles(plan: dict, node: str) -> dict | None:
    """plan.nodes.<lane>.roles as `{model, effort}`; null for a plan without lane pins (never the run-wide pin)."""
    roles = plan["nodes"][node].get("roles")
    return {"model": roles.get("model"), "effort": roles.get("effort")} if isinstance(roles, dict) else None


def lane_skills(plan: dict, node: str) -> list[dict]:
    """plan.nodes.<lane>.skills (`[{name, sha256}]`, feature.json 2.8.0); [] for a plan without."""
    skills = plan["nodes"][node].get("skills")
    return [{"name": item["name"], "sha256": item["sha256"]} for item in skills if isinstance(item, dict)] if isinstance(skills, list) else []


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
            "questions": questions,
            "roles": lane_roles(plan, node), "skills": lane_skills(plan, node)}


def inputs_section(directory: Path, plan: dict, policy: dict) -> dict:
    automatic = plan.get("automatic")
    workers = plan_workers(plan)
    declared = [worker["node_id"] for worker in policy["workers"]]
    if not set(workers) <= set(declared):
        raise ValueError("Plan selects lanes the pinned policy does not declare")
    section = {"feature": policy["feature"], "policy_version": policy["version"], "base_commit": plan["base_commit"],
               "source_branch": plan.get("source_branch"), "mode": "automatic" if automatic else "manual",
               "automatic": None if not automatic else {
                   "finish": automatic["finish"], "permission_mode": automatic["permission_mode"],
                   "worker_timeout_seconds": automatic["worker_timeout_seconds"], "review_timeout_seconds": automatic["review_timeout_seconds"],
                   # Plans pinned before the setting: the transport the receipts record, null before any reviewer ran.
                   "reviewer_transport": automatic["reviewer_transport"] if "reviewer_transport" in automatic else recorded_transport(directory),
                   **({"profile": automatic["profile"]} if "profile" in automatic else {}),
                   **({"fix_rounds": automatic["fix_rounds"]} if "fix_rounds" in automatic else {})},
               "setup": [{"argv": list(item["argv"]), "command": shlex.join(item["argv"]), "timeout_seconds": item["timeout_seconds"]}
                         for item in policy.get("setup", [])],
               "max_verification_attempts": policy.get("max_verification_attempts", 3),
               # A drill naming an excluded lane is pinned as null at prepare; plans before the selection keep the policy's.
               "failure_drill": plan["failure_drill"] if "failure_drill" in plan else policy.get("failure_drill"),
               "selected_workers": list(workers), "excluded_workers": plan_excluded(plan),
               "decisions": decisions_text(plan), "challenge": challenge_section(directory),
               "workers": {worker["node_id"]: worker_inputs(directory, plan, policy, worker) for worker in policy["workers"] if worker["node_id"] in workers}}
    # 1.7.0: the roles and the controller record prepare pinned; a run prepared before them exports without them.
    section.update({key: plan[key] for key in ("roles", "controller") if key in plan})
    # Within 1.7.0 (C7, C29): the tryout prepare pinned, the operator's verdicts and any launch past the untried limit.
    if "tryout" in plan:
        from .tryout import verdicts
        section["tryout"] = {"required": plan["tryout"] is True, "verdicts": verdicts(directory),
                             **({"allow_untried": plan["allow_untried"]} if "allow_untried" in plan else {})}
    return section


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
             "created_at": created, "definition": definition(plan_workers(runtime.plan), previous, has_challenge(runtime.plan), has_sidecar(runtime.plan), has_attack(runtime.plan)),
             "values": dict(state.values), "next": list(state.next), "tasks": tasks, "events": events,
             "verification_packets": packets,
             "review": review_section(runtime.directory, runtime.plan),
             "inputs": inputs_section(runtime.directory, runtime.plan, policy) if policy else None,
             "sidecar": sidecar_section(runtime.directory, runtime.plan),
             "attack": attack_section(runtime.directory, runtime.plan),
             "panels": panel_section(runtime.directory, runtime.plan),
             "costs": costs_section(runtime.directory, runtime.plan),
             "fix_loop": fix_loop_section(runtime.directory, runtime.plan)}
    if previous and {key: item for key, item in previous.items() if key != "updated_at"} == value:
        return previous
    value["updated_at"] = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    save_json(path, value)
    return value
