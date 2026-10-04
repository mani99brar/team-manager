"""`python -m workflow note <run> <lane> --by operator|maintainer "<text>"`: a note typed into a worker's pane, on the record (C17).

The note is kept in `<lane>.notes.json` (author, text, sent_at, delivery) and said once on the timeline, then typed as
`[Note from the operator N-k] <text>` (or `the maintainer`) through the review sidecar's gate (sidecar.deliver_text), so
it keeps the sidecar's refusals: nothing is recorded or typed after freeze, for a lane not launched, a lane that went on
or a lane waiting on a question (answer it instead); the note is recorded `undeliverable` when the pane is not attached to
the lane's session or its input line is not empty. The worker prompt says an operator note may amend the task, while a
maintainer note, like a sidecar message, is advice; review_prompt lists the notes that reached a worker (notes_note).
"""
from __future__ import annotations

import argparse
import fcntl
import re
import subprocess
import time
from contextlib import contextmanager
from pathlib import Path

from .actor import actor_record, actor_text, add_actor_argument, require_actor
from .sessions import plan_workers, read_json, save_json

NOTES_VERSION = "1.0.0"


def notes_path(directory: Path, lane: str) -> Path:
    return directory / f"{lane}.notes.json"


def load_notes(directory: Path, lane: str) -> list[dict]:
    path = notes_path(directory, lane)
    return read_json(path)["notes"] if path.exists() else []


@contextmanager
def notes_lock(directory: Path):
    """Two `note` commands on one run number their notes one after the other."""
    with (directory / "notes.lock").open("a") as handle:
        fcntl.flock(handle, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(handle, fcntl.LOCK_UN)


def save_note(directory: Path, lane: str, entry: dict) -> None:
    """The note file with `entry` added or replaced; the caller holds notes_lock."""
    notes = [item for item in load_notes(directory, lane) if item["n"] != entry["n"]] + [entry]
    save_json(notes_path(directory, lane), {"version": NOTES_VERSION, "node_id": lane, "notes": sorted(notes, key=lambda item: item["n"])})


def typed_note(entry: dict) -> str:
    """`[Note from the operator N-2] <text>`: newlines become spaces, escape and control bytes are dropped (as a sidecar message)."""
    from .sidecar import safe_text
    text = safe_text(re.sub(r"[\r\n\t]", " ", entry["text"]))
    return f"[Note from the {entry['author']} {entry['id']}] {text}"


def send_note(runtime, lane: str, actor: str, text: str, clock=None) -> dict:
    """Record the note `pending`, type it through the gate, record its delivery and one event; the note entry.

    A refusal of the gate's state checks records and types nothing (ValueError). A crash while typing leaves the note
    `pending`: it may have reached the pane."""
    from .guardrails import iso
    from .sidecar import deliver_text, failure_reason, refusal
    directory, plan = runtime.directory, runtime.plan
    if not text.strip():
        raise ValueError("The note is empty")
    if lane not in plan_workers(plan):
        raise ValueError(f"{lane} is not a lane of this run ({', '.join(plan_workers(plan))})")
    reason = refusal(directory, plan, lane)
    if reason:
        raise ValueError(f"A note to {lane} is refused ({reason}); nothing was recorded or typed"
                         + ("; answer its question with `workflow answer` instead" if reason == "question_waiting" else ""))
    with notes_lock(directory):
        number = len(load_notes(directory, lane)) + 1
        entry = {"n": number, "id": f"N-{number}", **actor_record(actor, "author"), "text": text,
                 "sent_at": iso((clock or time.time)()), "delivery": "pending", "reason": None}
        save_note(directory, lane, entry)
    try:
        status, reason = deliver_text(runtime, lane, typed_note(entry))
    except (OSError, RuntimeError, ValueError, subprocess.SubprocessError) as error:
        status, reason = "undeliverable", failure_reason(error)
    entry.update(delivery=status, reason=reason)
    with notes_lock(directory):
        save_note(directory, lane, entry)
    outcome = "typed into its pane" if status == "delivered" else f"{status}, not typed ({reason})"
    # A plain record (status `note`, served as a log line): never a lane status, so it cannot end an interruption's scope
    # or read as the lane running while no controller does.
    runtime.event(lane, "note", f"Note {entry['id']} from {actor_text(actor)} to worker {lane}: {outcome}")
    return entry


def notes_note(directory: Path, lanes: list[str]) -> str:
    """The reviewer prompt's line on the notes that reached the workers: an operator's may amend a lane's task, a
    maintainer's is advice. The review sidecar's messages are never listed (decision 11)."""
    listed = []
    for lane in lanes:
        for entry in load_notes(directory, lane):
            if entry["delivery"] not in {"delivered", "pending"}:
                continue
            weight = "may amend its task" if entry["author"] == "operator" else "advice"
            unconfirmed = ", delivery unconfirmed" if entry["delivery"] == "pending" else ""
            listed.append(f"{entry['id']} to {lane} from the {entry['author']} ({weight}{unconfirmed}): {entry['text']!r}")
    if not listed:
        return ""
    return (" Notes typed into the workers' panes during the run (an operator note may amend that lane's task; judge the work "
            "against the task as amended): " + "; ".join(listed) + ".")


def note_main(argv=None):
    parser = argparse.ArgumentParser(prog="python -m workflow note", description="Type a note into a worker's pane, on the record: "
                                     "<lane>.notes.json and the timeline. An operator note may amend the lane's task; a maintainer "
                                     "note is advice.")
    parser.add_argument("directory", type=Path)
    parser.add_argument("node", help="The lane the note is for")
    parser.add_argument("text")
    add_actor_argument(parser)
    args = parser.parse_args(argv)
    directory = args.directory.resolve()
    try:
        actor = require_actor(args, "note")
        from .abandon import refuse_abandoned
        refuse_abandoned(directory)
        from .pipeline import Pipeline
        entry = send_note(Pipeline(directory), args.node, actor, args.text)
    except (ValueError, RuntimeError, OSError, subprocess.SubprocessError) as error:
        parser.exit(1, f"Blocked: {error}\n")
    if entry["delivery"] != "delivered":
        parser.exit(1, f"Blocked: note {entry['id']} to {args.node} is recorded {entry['delivery']} and was not typed ({entry['reason']}). "
                       "Look at the pane, then send it again as a new note.\n")
    print(f"Note {entry['id']} typed into {args.node}'s pane and recorded in {notes_path(directory, args.node)}.")
