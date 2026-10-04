"""The outcome block (C43): what the run record says about the run's result, for the operator to read before any summary.

It is built from the export's own section builders (review_section, each lane's completion_signal, sidecar_section) and the
reviewers' status files (`automatic-review*.json`), never from an orchestrator's memory. It lists each reviewer's verdict (the
derived one, and the one its file says when they differ), or `no verdict accepted` with the reason and whether a file was
written; late verdicts; open P0/P1 with their first sentences; accepted P2s as "Known limits"; each lane's untested and
verify_yourself items; and the review sidecar's unresolved list. A clean approval is one line.

`status`, the success lines, the Blocked handlers and report.html print it. It reads files the controller replaces atomically
and writes nothing, so `status` stays lock-free. The digest and PR pasting come later.
"""
from __future__ import annotations

from pathlib import Path

from .export_state import completion_signal, load_optional, review_section, sidecar_section, worker_questions
from .sessions import plan_workers, review_node, reviewer_ids

RUNNING = {"pending", "launching", "running"}


def listing(words: list[str]) -> str:
    return words[0] if len(words) == 1 else ", ".join(words[:-1]) + " and " + words[-1]


def reviewer_status(directory: Path, reviewer_id: str) -> dict:
    """The reviewer's own status file; the default reviewer's lives in the combined `automatic-review.json`."""
    item = load_optional(directory / f"automatic-{review_node(reviewer_id)}.json")
    return item if isinstance(item, dict) else {}


def superseded_reason(directory: Path, reviewer_id: str) -> str | None:
    """Why a reviewer ended superseded, as the timeline says it (automatic.supersede_late); None when it does not."""
    from .pipeline import complete_events
    prefix = f"Reviewer {reviewer_id} gave no verdict and ends superseded: "
    said = [str(event.get("message")) for event in complete_events(directory) if str(event.get("message", "")).startswith(prefix)]
    return said[-1][len(prefix):] if said else None


def no_verdict_reason(directory: Path, reviewer_id: str, status: dict) -> str:
    error = status.get("late_error") or status.get("error")
    if isinstance(error, str) and error.strip():
        return "deadline exhausted" if "deadline exhausted" in error else error.split("; ")[0]
    word = status.get("status")
    if word == "superseded":
        reason = superseded_reason(directory, reviewer_id)
        return f"superseded: {reason}" if reason else "superseded"
    if word in RUNNING:
        return "still running"
    return "no status recorded" if word is None else str(word)


def file_fact(directory: Path, reviewer_id: str) -> str:
    """Whether the reviewer wrote its completion file, and what verdict it says when it can be read."""
    path = directory / f"{review_node(reviewer_id)}.completion.json"
    if not path.exists():
        return "no file written"
    item = load_optional(path)
    verdict = item.get("verdict") if isinstance(item, dict) else None
    return f"its file says {verdict}" if verdict in {"approved", "blocked"} else "its file is unreadable"


def reviewer_lines(directory: Path, ids: list[str], derived: dict) -> tuple[list[str], bool]:
    """One line per reviewer, and whether any of them is more than a plain verdict (raw differs, late, or none)."""
    lines, caveat = [], False
    for reviewer_id in ids:
        status = reviewer_status(directory, reviewer_id)
        verdict = derived.get(reviewer_id)
        if verdict is None:
            lines.append(f"  {reviewer_id}: no verdict accepted ({no_verdict_reason(directory, reviewer_id, status)}); {file_fact(directory, reviewer_id)}")
            caveat = True
            continue
        decision = status.get("accepted_decision")
        raw = decision.get("verdict") if isinstance(decision, dict) else None
        line = f"  {reviewer_id}: {verdict}"
        if raw in {"approved", "blocked"} and raw != verdict:
            line += f" (its file says {raw})"
            caveat = True
        if status.get("late"):
            line += ", late"
            caveat = True
        lines.append(line)
    return lines, caveat


def reviews(directory: Path, plan: dict) -> tuple[str | None, list[str], dict, list]:
    """The combined verdict (None without review.json), the reviewer ids, each one's derived verdict and every finding."""
    from .automatic import derived_verdict
    section = review_section(directory)
    if section is not None:
        return (section["verdict"], [entry["reviewer_id"] for entry in section["reviewers"]],
                {entry["reviewer_id"]: entry["verdict"] for entry in section["reviewers"]}, section["findings"])
    combined = load_optional(directory / "automatic-review.json")
    if not isinstance(combined, dict):
        return None, [], {}, []
    ids = combined.get("reviewers") if isinstance(combined.get("reviewers"), list) else reviewer_ids(plan)
    derived, findings = {}, []
    for reviewer_id in ids:
        decision = reviewer_status(directory, reviewer_id).get("accepted_decision")
        if isinstance(decision, dict):
            derived[reviewer_id] = derived_verdict(decision)
            findings.extend({**item, "reviewer": reviewer_id} for item in decision.get("findings", []))
    return None, list(ids), derived, findings


def open_items(directory: Path, plan: dict, findings: list) -> list[str]:
    """The sections that need the operator: open P0/P1, known limits, each lane's evidence, the sidecar's unresolved list."""
    from .automatic import first_sentence
    from .pipeline import blocking_findings
    lines = []
    blocking = sorted(blocking_findings(findings), key=lambda item: item["severity"])
    if blocking:
        lines.append("Open P0/P1:")
        lines += [f"  [{item['severity']} {item.get('reviewer')}] {first_sentence(item['message'])}" for item in blocking]
    limits = [item for item in findings if item.get("severity") == "P2" and item.get("disposition") == "accepted"]
    if limits:
        lines.append("Known limits (accepted P2):")
        lines += [f"  [{item.get('reviewer')}] {item['message']}" for item in limits]
    for node in plan_workers(plan):
        signal = completion_signal(directory, plan, node, worker_questions(directory / f"{node}.questions.json"))
        if signal is None:
            continue
        items = [f"  untested: {item}" for item in signal["untested"] or []]
        if signal["verify_yourself"]:
            items.append(f"  verify yourself: {signal['verify_yourself']}")
        if items:
            lines += [f"Lane {node}:", *items]
    ledger = sidecar_section(directory, plan)
    unresolved = ((ledger or {}).get("handoff") or {}).get("unresolved") or []
    if unresolved:
        lines += ["Sidecar unresolved:", *(f"  {item}" for item in unresolved)]
    return lines


def outcome_block(directory: Path, open_items_only: bool = False) -> str:
    """The run's outcome as text; "" when the run records nothing to report yet (no review, no lane evidence, no sidecar list).

    `open_items_only`: just the sections that need the operator (open P0/P1, known limits, lane items, the sidecar's
    unresolved list), without the outcome line and the reviewers' verdicts, for a stop that lists its open items.
    """
    directory = Path(directory)
    plan = load_optional(directory / "plan.json")
    if not isinstance(plan, dict):
        return ""
    try:
        verdict, ids, derived, findings = reviews(directory, plan)
        items = open_items(directory, plan, findings)
        if open_items_only:
            return "\n".join(items)
        if not ids:
            return "\n".join(["Outcome: no review recorded yet", *items]) if items else ""
        lines, caveat = reviewer_lines(directory, ids, derived)
        if verdict == "approved":
            header = f"Outcome: approved by {listing(ids)}"
            if not caveat and not items:
                return header + "; nothing open."
            return "\n".join([header, "Reviewers:", *lines, *items])
        header = f"Outcome: {verdict}" if verdict else "Outcome: no review.json recorded"
        return "\n".join([header, "Reviewers:", *lines, *items])
    except (OSError, ValueError, KeyError, TypeError, AttributeError) as error:
        return f"Outcome: unavailable ({type(error).__name__}: {error})"
