"""`python -m workflow abandon <run> --reason "<text>" --by operator` (C30): close a run that will not go on.

A run blocked by its review, ended by a usage limit or left paused stays open until the operator decides it is dead; its
follow-up is a new run (`launch --follows <run>`, with `brief <run>`). Abandoning is the operator's decision, never
mechanical recovery, so the maintainer is refused (actor.OPERATOR_ONLY). It takes the supervisor and controller locks as
`repair` does, and refuses while a controller holds either. It stops each worker and reviewer session the run recorded
(`<node>.interactive.json`) that is still live, by its exact ids through Pipeline.stop_session, so nothing keeps using
quota: a bound receipt by its ids in the listing, one the launch never bound by the id its launch log printed (locate), and
an unfinished stop intent by its ids or its process. A session that is gone is recorded as not running. Then it writes `abandon.json` and one
`controller` event with the status `cancelled`, which the viewer reads as the run's own status.

Afterwards every command that would change the run refuses it (refuse_abandoned): automatic, automatic-step, start,
attach, freeze, retry, reconcile, review, approve, resume, answer, note, repair and sidecar-pass. status, export and brief
still read it; clean removes its worktrees and keeps its source checkout, which brief reads (clean.run_worktrees), and
ledger reads it like any other run.
"""
from __future__ import annotations

import argparse
import re
import subprocess
from pathlib import Path

from .actor import actor_record, actor_text, add_actor_argument, require_actor
from .checks import now
from .pipeline import pid_alive
from .sessions import plan_workers, read_json, review_nodes, run_lock, save_json

ABANDON = "abandon.json"
ABANDON_VERSION = "1.0.0"


def abandoned(directory: Path) -> dict | None:
    """The run's abandon record, or None. An unreadable record still counts: the run was abandoned."""
    path = Path(directory) / ABANDON
    if not path.exists():
        return None
    try:
        record = read_json(path)
    except (OSError, ValueError):
        return {"reason": "abandon.json is unreadable", "by": None, "abandoned_at": None}
    return record if isinstance(record, dict) else {"reason": "abandon.json is malformed", "by": None, "abandoned_at": None}


def refuse_abandoned(directory: Path) -> None:
    """ValueError when the run was abandoned: only status, export and brief read it any more."""
    record = abandoned(directory)
    if record is not None:
        by = f" by the {record['by']}" if record.get("by") else ""
        when = f" at {record['abandoned_at']}" if record.get("abandoned_at") else ""
        raise ValueError(f"The run was abandoned{by}{when} ({record.get('reason')}); nothing changes it any more. status, export and brief "
                         "still read it; follow it up with a new run: launch <feature> --repo <target repo> --run-id <next> --follows <this run>")


def recorded_nodes(plan: dict, directory: Path) -> list[str]:
    """Every worker and native reviewer session the run launched or began to launch, in lane then reviewer order."""
    return [node for node in (*plan_workers(plan), *review_nodes(plan)) if (directory / f"{node}.interactive.json").exists()]


def listed_live(rows: list[dict], *records: dict) -> bool:
    """The listing shows one of these records' sessions with a process: by its background id or its session UUID."""
    background_ids = {record.get("background_id") for record in records} - {None}
    session_ids = {record.get("session_id") for record in records} - {None}
    return any(row.get("pid") and (row.get("id") in background_ids or row.get("sessionId") in session_ids) for row in rows)


# What locate says of a listed row with no process behind it: the session is not running.
NOT_RUNNING = ("No live native PID", "Native process is unavailable", "Session is not attachable")


def unbound_live(runtime, node: str, rows: list[dict]) -> bool:
    """A receipt the launch never bound (its settle step failed: Claude Code unavailable, or Ctrl-C) still has a session when
    its launch log printed one: locate binds that id and checks its identity, as a stop does. A launch log that printed no
    id launched nothing; a listed row without a process is not running. Any other refusal (an ambiguous id, another run's
    session) raises, and is a failure, never 'not running'."""
    log = runtime.directory / f"{node}.launch.log"
    if not log.exists() or not re.search(r"claude attach [a-f0-9-]{8,36}\s", log.read_text(errors="replace")):
        return False
    try:
        return runtime.sessions.locate(node, rows) is not None
    except RuntimeError as error:
        if str(error).startswith(NOT_RUNNING):
            return False
        raise


def abandon(runtime, reason: str, actor: str) -> dict:
    """Stop the run's live recorded sessions, then record the abandon. A stop that is not confirmed records neither
    abandon.json nor the event: the error names each one, and the identical command is rerun once they are dealt with
    (the stops it did confirm keep their markers, so they are not issued again)."""
    directory = runtime.directory
    if abandoned(directory) is not None:
        raise ValueError(f"The run is already abandoned ({abandoned(directory).get('reason')}); nothing was changed")
    if (directory / "integration-intent.json").exists():
        raise ValueError("The run reached integration: it is finished or finishing, not abandoned")
    stopped, not_running, failures = [], [], {}
    listing: list = []

    def rows() -> list[dict]:
        # Listed once, and only when a node needs it: a run that never launched is abandoned while Claude Code is unavailable.
        if not listing:
            listing.append(runtime.sessions.inventory())
        return listing[0]
    for node in recorded_nodes(runtime.plan, directory):
        receipt = read_json(directory / f"{node}.interactive.json")
        marker = directory / f"{node}.stop.json"
        try:
            if marker.exists():
                intent = read_json(marker)
                if intent.get("stopped") is True:
                    not_running.append(node)  # The controller stopped it before.
                    continue
                # An unfinished stop intent (a controller stop that failed or was interrupted): completed by stop_session, never
                # issued twice, while its session or process is still there. Once both are gone there is nothing to stop, and
                # stop_session would wait out a respawn gap on every attempt.
                pid = intent.get("pid")
                if not listed_live(rows(), intent, receipt) and not (isinstance(pid, int) and pid > 0 and pid_alive(pid)):
                    not_running.append(node)
                    continue
            elif not (listed_live(rows(), receipt) if receipt.get("background_id") else unbound_live(runtime, node, rows())):
                not_running.append(node)
                continue
            runtime.stop_session(node)
            stopped.append(node)
        except Exception as error:
            failures[node] = error
    if failures:
        raise RuntimeError("Not abandoned; stops not confirmed: " + "; ".join(f"{node}: {error}" for node, error in failures.items())
                           + ". Inspect `claude agents`, then rerun the same abandon")
    record = {"version": ABANDON_VERSION, "run_id": runtime.plan["run_id"], "reason": reason, **actor_record(actor), "abandoned_at": now(),
              "stopped": stopped, "not_running": not_running}
    save_json(directory / ABANDON, record)
    detail = "; ".join(part for part in (f"Stopped: {', '.join(stopped)}" if stopped else "", f"not running: {', '.join(not_running)}" if not_running else "") if part)
    runtime.event("controller", "cancelled", f"Abandoned by {actor_text(actor)}: {reason}" + (f". {detail}" if detail else ""))
    return record


def abandon_main(argv=None):
    parser = argparse.ArgumentParser(prog="python -m workflow abandon", description="Close a run that will not go on: stop its recorded "
                                     "sessions by exact id, record why, and refuse every command that would change it. The operator's decision.")
    parser.add_argument("directory", type=Path)
    parser.add_argument("--reason", required=True, help="Why the run is abandoned: recorded in abandon.json and on the timeline")
    add_actor_argument(parser)
    args = parser.parse_args(argv)
    directory = args.directory.resolve()
    try:
        actor = require_actor(args, "abandon")
        if not args.reason.strip():
            raise ValueError("--reason must not be empty")
        from .pipeline import Pipeline
        with run_lock(directory, "automatic-supervisor.lock"), run_lock(directory):
            record = abandon(Pipeline(directory, abandoned_ok=True), args.reason.strip(), actor)
    except (ValueError, RuntimeError, OSError, subprocess.SubprocessError) as error:
        parser.exit(1, f"Blocked: {error}\nAll work/evidence retained at {directory}.\n")
    print(f"Abandoned {directory}: {record['reason']}. Stopped: {', '.join(record['stopped']) or 'none'}; not running: "
          f"{', '.join(record['not_running']) or 'none'}. status, export and brief still read it.")
