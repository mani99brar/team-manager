"""What a run cost (C49): each session's spend, from the records Claude Code itself writes, never estimated.

A native session (a worker, a native reviewer) is priced when its stop is confirmed (`Pipeline.stop_session`): its transcript,
`<projects>/*/<session_id>.jsonl`, carries `cost-state` rows, the running totals of one process of the session (its
`startTime`). The last row of each startTime counts once, and a resumed session's processes are summed. The row type is
undocumented: a transcript without such rows, or none at all, records null. The record is `<node>.cost.json` beside the
stop intent. A session resumed after its stop is not counted.

A print job (a challenge attempt, a print reviewer, a sidecar pass) reports `total_cost_usd`, `duration_ms` and
`modelUsage` in its JSON result, `<node>.stdout.json`.

The export's `costs` section lists them by role with a run total; the outcome block prints the total in one line, with the
count of sessions it could not price.
"""
from __future__ import annotations

import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

from .sessions import plan_workers, read_json, review_node, reviewer_ids, save_json

ROLES = ("workers", "reviewers", "sidecar", "challenge")
COST_KEYS = ("cost_usd", "duration_ms", "models")


def transcripts_root() -> Path:
    """Where Claude Code keeps session transcripts: `projects/` under its config directory."""
    return Path(os.environ.get("CLAUDE_CONFIG_DIR") or Path.home() / ".claude") / "projects"


def number(value) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def session_cost(session_id: str, root: Path | None = None) -> dict | None:
    """`{cost_usd, duration_ms, models}` from the session's transcript: the last cost-state row per startTime, summed across
    startTimes; None when no transcript holds a cost-state row."""
    latest = {}
    for path in sorted((root or transcripts_root()).glob(f"*/{session_id}.jsonl")):
        try:
            with path.open(errors="replace") as handle:
                for line in handle:
                    if '"cost-state"' not in line:
                        continue
                    try:
                        row = json.loads(line)
                    except ValueError:
                        continue
                    # A startTime that is neither a number nor a string (the row type is undocumented) cannot name a process: skipped.
                    if isinstance(row, dict) and row.get("type") == "cost-state" and number(row.get("totalCostUSD")) \
                            and (number(row.get("startTime")) or isinstance(row.get("startTime"), str)):
                        latest[row["startTime"]] = row  # Running totals: the last row of a process is its whole spend.
        except OSError:
            continue
    if not latest:
        return None
    rows = list(latest.values())
    durations = [row.get("totalDuration") for row in rows]
    return {"cost_usd": round(sum(row["totalCostUSD"] for row in rows), 6),
            "duration_ms": sum(durations) if all(number(item) for item in durations) else None,
            "models": sorted({model for row in rows if isinstance(row.get("modelUsage"), dict) for model in row["modelUsage"]})}


def record_session_cost(directory: Path, node: str, session_id: str, root: Path | None = None) -> None:
    """`<node>.cost.json` for a stopped native session. A record: a read or write that fails is said on stderr and never
    fails the stop."""
    try:
        cost = session_cost(session_id, root)
        save_json(directory / f"{node}.cost.json", {"session_id": session_id, **(cost or dict.fromkeys(COST_KEYS)),
                                                     "recorded_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")})
    except Exception as error:  # noqa: BLE001 - a record only: whatever fails, the stop it follows stands.
        print(f"Warning: {node}.cost.json not written: {error}", file=sys.stderr, flush=True)


def print_cost(stdout: Path) -> dict:
    """`{cost_usd, duration_ms, models}` from a print job's JSON result; each null when it cannot be read."""
    try:
        result = read_json(stdout)
    except (OSError, ValueError):
        result = None
    if not isinstance(result, dict):
        return dict.fromkeys(COST_KEYS)
    usage = result.get("modelUsage")
    return {"cost_usd": result["total_cost_usd"] if number(result.get("total_cost_usd")) else None,
            "duration_ms": result["duration_ms"] if number(result.get("duration_ms")) else None,
            "models": sorted(usage) if isinstance(usage, dict) else None}


def native_cost(path: Path) -> dict:
    """A native session's `<node>.cost.json`; each value null when it is absent or unreadable."""
    try:
        item = read_json(path) if path.is_file() and not path.is_symlink() else None
    except ValueError:
        item = None
    if not isinstance(item, dict):
        return dict.fromkeys(COST_KEYS)
    models = item.get("models")
    return {"cost_usd": item["cost_usd"] if number(item.get("cost_usd")) else None,
            "duration_ms": item["duration_ms"] if number(item.get("duration_ms")) else None,
            "models": list(models) if isinstance(models, list) else None}


def numbered(directory: Path, prefix: str) -> list[int]:
    """The `n` of every `<prefix>-<n>.stdout.json` print job, in order."""
    pattern = re.compile(rf"{re.escape(prefix)}-(\d+)\.stdout\.json")
    return sorted(int(match.group(1)) for path in directory.iterdir() if (match := pattern.fullmatch(path.name)))


def costs_section(directory: Path, plan: dict) -> dict:
    """`{total_usd, by_role, nodes}`: one entry per session the run started (node, role, transport, cost_usd, duration_ms,
    models), workers, reviewers, sidecar passes and challenge attempts in that order. Unknown values are null; a role's and
    the run's total sum what is known, null when nothing is."""
    nodes = []

    def add(node: str, role: str, transport: str, cost: dict) -> None:
        nodes.append({"node": node, "role": role, "transport": transport, **cost})

    for node in plan_workers(plan):
        if any((directory / f"{node}.{suffix}").exists() for suffix in ("interactive.json", "stop.json", "cost.json")):
            add(node, "workers", "native", native_cost(directory / f"{node}.cost.json"))
    for reviewer_id in reviewer_ids(plan):
        node = review_node(reviewer_id)
        if (directory / f"{node}.stdout.json").exists():
            add(node, "reviewers", "print", print_cost(directory / f"{node}.stdout.json"))
        elif any((directory / f"{node}.{suffix}").exists() for suffix in ("interactive.json", "stop.json", "cost.json")):
            add(node, "reviewers", "native", native_cost(directory / f"{node}.cost.json"))
    for prefix, role in (("sidecar", "sidecar"), ("challenge", "challenge")):
        for n in numbered(directory, prefix):
            add(f"{prefix}-{n}", role, "print", print_cost(directory / f"{prefix}-{n}.stdout.json"))

    def total(items: list) -> float | None:
        known = [item["cost_usd"] for item in items if item["cost_usd"] is not None]
        return round(sum(known), 6) if known else None

    return {"total_usd": total(nodes), "by_role": {role: total([item for item in nodes if item["role"] == role]) for role in ROLES},
            "nodes": nodes}


def cost_line(section: dict) -> str | None:
    """`Cost: $X (workers $a, reviewers $b, sidecar $c, challenge $d)`, leaving out the parts that are unknown, then
    `; n sessions unpriced` when some session's cost is unknown, since the total sums the known ones only; None when
    nothing is known."""
    if section["total_usd"] is None:
        return None
    parts = [f"{role} ${section['by_role'][role]:.2f}" for role in ROLES if section["by_role"][role] is not None]
    unpriced = sum(item["cost_usd"] is None for item in section["nodes"])
    tail = f"; {unpriced} {'session' if unpriced == 1 else 'sessions'} unpriced" if unpriced else ""
    return f"Cost: ${section['total_usd']:.2f} ({', '.join(parts)}){tail}"
