"""One attention record for every state of a run that needs the operator (operator decision 2 of 3 Oct 2026).

A record goes to two places. `<run>/attention.json` holds the run's latest record, replaced atomically:
`{version, run_id, kind, node, text, at}`. One JSON line `{at, run_id, run_dir, kind, node, text}` is appended to
`attention.jsonl` in the Projects registry's folder (registry.registry_path()'s), the one feed of every run, which a
Monitor or the Telegram bot tails. A record that repeats the run's latest (the same kind, node and text) writes nothing,
so a controller that restarts or polls again never repeats a line.

Attention never stops a controller: `attention` never raises. What fails (a kind it does not know, a folder it cannot
write, a run directory that is gone) is printed to stderr and returns None.
"""
from __future__ import annotations

import contextlib
import fcntl
import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

from .sessions import read_json, save_json

VERSION = "1.0.0"
RECORD = "attention.json"
FEED = "attention.jsonl"
KINDS = frozenset({"question", "pane", "challenge_paused", "review_blocked", "controller_blocked", "finished"})
# Named for the units that add them, and refused until they join KINDS: a review sidecar finding no lane could take
# (C41) and a run paused on a usage limit (C46).
RESERVED_KINDS = frozenset({"sidecar", "usage_limit"})


def feed_path(env: dict | None = None) -> Path:
    """attention.jsonl beside the Projects registry: in MD_MANAGER_PROJECTS_CONFIG's folder when it is set, else in
    ~/.config/md-manager/. `env` defaults to this process's environment."""
    from .registry import registry_path  # registry imports export_state, which imports modules that record attention.
    return registry_path(env).parent / FEED


def iso(timestamp: float) -> str:
    return datetime.fromtimestamp(timestamp, timezone.utc).isoformat().replace("+00:00", "Z")


def run_id_of(directory: Path) -> str:
    """The run id plan.json pins, else the directory's name (prepare names the run after it)."""
    try:
        value = read_json(directory / "plan.json").get("run_id")
    except (OSError, ValueError, AttributeError):
        value = None
    return value if isinstance(value, str) and value else directory.name


def latest(directory: Path) -> tuple | None:
    """(kind, node, text) of the run's latest record; None without one, or for a file that holds no record (replaced)."""
    try:
        record = read_json(directory / RECORD)
    except (OSError, ValueError):
        return None
    return (record.get("kind"), record.get("node"), record.get("text")) if isinstance(record, dict) else None


def attention(directory: Path, kind: str, text: str, *, node: str | None = None, clock=time.time, env: dict | None = None) -> dict | None:
    """Record that the run in `directory` needs the operator: `kind` (one of KINDS), the graph node or lane it concerns
    (None for the run as a whole) and one line of text saying what to do. Returns the record written to attention.json,
    or None when nothing was written: the run's latest record already says it, or something failed.

    The line is appended under an exclusive lock on the feed, which also serialises the comparison with the run's latest
    record, and before attention.json is replaced: a failure between the two repeats the line on the next call rather
    than losing it.
    """
    try:
        if kind not in KINDS:
            raise ValueError(f"{kind!r} is not an attention kind" + (" yet: it is reserved for a later unit" if kind in RESERVED_KINDS else ""))
        if not isinstance(text, str) or not text.strip():
            raise ValueError("an attention record needs a text")
        if node is not None and (not isinstance(node, str) or not node.strip()):
            raise ValueError(f"an attention record's node is a name or None, not {node!r}")
        directory = Path(directory).resolve()
        if not directory.is_dir():
            raise ValueError(f"no run directory at {directory}")
        run_id, at = run_id_of(directory), iso(clock())
        feed = feed_path(env)
        feed.parent.mkdir(parents=True, exist_ok=True)
        with feed.open("a") as handle:
            fcntl.flock(handle, fcntl.LOCK_EX)  # Released when the file is closed.
            if latest(directory) == (kind, node, text):
                return None
            handle.write(json.dumps({"at": at, "run_id": run_id, "run_dir": str(directory), "kind": kind, "node": node, "text": text}) + "\n")
            handle.flush()
            os.fsync(handle.fileno())
            record = {"version": VERSION, "run_id": run_id, "kind": kind, "node": node, "text": text, "at": at}
            save_json(directory / RECORD, record)
        return record
    except Exception as error:  # Whatever it is, the controller that asked goes on.
        with contextlib.suppress(Exception):
            print(f"Attention record not written ({kind}): {error}", file=sys.stderr, flush=True)
        return None
