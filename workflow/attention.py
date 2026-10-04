"""One attention record for every state of a run that needs the operator (operator decision 2 of 3 Oct 2026).

A record goes to two places. `<run>/attention.json` holds the run's latest record, replaced atomically:
`{version, run_id, kind, node, text, at}`, plus `states`, the latest `{kind, node, text, at}` of each state (kind and
node) the run reported. One JSON line `{at, run_id, run_dir, kind, node, text}` is appended to `attention.jsonl` in the
Projects registry's folder (registry.registry_path()'s), the one feed of every run, which a Monitor or the Telegram bot
tails. A record that repeats its state's latest (the same kind, node and text) writes nothing, so a controller that
restarts or polls again never repeats a line, however many states are open at once. A state that ends calls `resolved`,
so the same text is recorded again when it comes back (a pane's text never changes).

Attention never stops a controller: `attention` never raises, and waits at most LOCK_WAIT_SECONDS for the feed's lock.
What fails (a kind it does not know, a folder it cannot write, a run directory that is gone, a feed another process
keeps locked) is printed to stderr and returns None.

automatic.py imports this module as `from . import attention as attention_record`, since its waits keep sets named
`attention`: the module is callable, so `attention_record(...)` records as `attention_record.attention(...)` does.
"""
from __future__ import annotations

import contextlib
import fcntl
import json
import os
import sys
import time
import types
from datetime import datetime, timezone
from pathlib import Path

from .sessions import read_json, save_json

VERSION = "1.0.0"
RECORD = "attention.json"
FEED = "attention.jsonl"
# `sidecar`: a review sidecar P0/P1 that reached no lane, or an escalation (C41), recorded on the finding's lane.
# `awaiting_approval`: an automatic run with finish "approval" stopped after review (C51), recorded on `approval` with the
# approve command; never `finished`, which says the branch was fast-forwarded.
KINDS = frozenset({"question", "pane", "challenge_paused", "review_blocked", "controller_blocked", "finished", "sidecar", "awaiting_approval"})
# Named for the unit that adds it, and refused until it joins KINDS: a run paused on a usage limit (C46).
RESERVED_KINDS = frozenset({"usage_limit"})
# The feed's lock is taken without blocking, retried every LOCK_RETRY_SECONDS for at most LOCK_WAIT_SECONDS: a holder that
# never lets go (a process suspended inside attention, a reader that locks the feed, a hung filesystem) costs a caller
# one bounded wait, never its run.
LOCK_WAIT_SECONDS = 5.0
LOCK_RETRY_SECONDS = 0.05
STATE_KEYS = ("kind", "node", "text", "at")


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


def load_record(directory: Path) -> dict:
    """The run's attention.json; {} without one, or for a file that holds no record (the next record replaces it)."""
    try:
        record = read_json(directory / RECORD)
    except (OSError, ValueError):
        return {}
    return record if isinstance(record, dict) else {}


def states(record: dict) -> list[dict]:
    """The latest `{kind, node, text, at}` of each state the record's run reported. A record written before the list
    existed holds one: its own."""
    found = record.get("states")
    if isinstance(found, list):
        return [item for item in found if isinstance(item, dict)]
    return [{key: record.get(key) for key in STATE_KEYS}] if "kind" in record else []


@contextlib.contextmanager
def feed_lock(env: dict | None):
    """The feed opened for appending under its exclusive lock, which also serialises every change of a run's attention.json.
    Raises TimeoutError once LOCK_WAIT_SECONDS passed without it."""
    feed = feed_path(env)
    feed.parent.mkdir(parents=True, exist_ok=True)
    with feed.open("a") as handle:  # Closing the file releases the lock.
        deadline = time.monotonic() + LOCK_WAIT_SECONDS
        while True:
            try:
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise TimeoutError(f"{feed} stayed locked for {LOCK_WAIT_SECONDS:g} s") from None
                time.sleep(LOCK_RETRY_SECONDS)
        yield handle


def attention(directory: Path, kind: str, text: str, *, node: str | None = None, clock=time.time, env: dict | None = None) -> dict | None:
    """Record that the run in `directory` needs the operator: `kind` (one of KINDS), the graph node or lane it concerns
    (None for the run as a whole) and one line of text saying what to do. Returns the record written to attention.json,
    or None when nothing was written: that state's latest record already says it, or something failed.

    The line is appended under the feed's lock, which also serialises the comparison with the state's latest record, and
    before attention.json is replaced: a failure between the two repeats the line on the next call rather than losing it.
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
        with feed_lock(env) as handle:
            known = states(load_record(directory))
            if any((item.get("kind"), item.get("node"), item.get("text")) == (kind, node, text) for item in known):
                return None
            handle.write(json.dumps({"at": at, "run_id": run_id, "run_dir": str(directory), "kind": kind, "node": node, "text": text}) + "\n")
            handle.flush()
            os.fsync(handle.fileno())
            record = {"version": VERSION, "run_id": run_id, "kind": kind, "node": node, "text": text, "at": at}
            others = [item for item in known if (item.get("kind"), item.get("node")) != (kind, node)]
            save_json(directory / RECORD, {**record, "states": [*others, {"kind": kind, "node": node, "text": text, "at": at}]})
        return record
    except Exception as error:  # Whatever it is, the controller that asked goes on.
        with contextlib.suppress(Exception):
            print(f"Attention record not written ({kind}): {error}", file=sys.stderr, flush=True)
        return None


def resolved(directory: Path, kind: str, *, node: str | None = None, env: dict | None = None) -> bool:
    """The state (kind and node) no longer needs the operator: forget its latest record, so the next `attention` for it is
    written even with the same text. Writes no line, and nothing at all when the run holds no record of that state, so a
    poll may call it each time it sees the state over. True when a record was forgotten; never raises."""
    try:
        directory = Path(directory).resolve()
        if not any((item.get("kind"), item.get("node")) == (kind, node) for item in states(load_record(directory))):
            return False
        with feed_lock(env):
            record = load_record(directory)
            known = states(record)
            remaining = [item for item in known if (item.get("kind"), item.get("node")) != (kind, node)]
            if len(remaining) == len(known):
                return False
            save_json(directory / RECORD, {**record, "states": remaining})
        return True
    except Exception as error:  # As for attention: the controller goes on.
        with contextlib.suppress(Exception):
            print(f"Attention state not resolved ({kind}): {error}", file=sys.stderr, flush=True)
        return False


class CallableModule(types.ModuleType):
    """This module as `from . import attention as attention_record` binds it: calling it is calling `attention`."""

    def __call__(self, *args, **kwargs):
        return attention(*args, **kwargs)


sys.modules[__name__].__class__ = CallableModule
