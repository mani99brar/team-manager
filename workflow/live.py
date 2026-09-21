"""CLI for LangGraph-owned Claude sessions and optional Herdr observers."""
from __future__ import annotations

import argparse
import json
import shutil
import signal
from pathlib import Path
from typing import TypedDict

from langgraph.checkpoint.sqlite import SqliteSaver
from langgraph.graph import END, START, StateGraph
from langgraph.types import interrupt

from .observer import open_panels
from .sessions import ClaudeSessions, NODES, prepare, read_json, run_lock


class SessionState(TypedDict, total=False):
    run_id: str
    ui: dict
    adapter: dict


def build_session_graph(checkpointer, sessions: ClaudeSessions):
    def ui(_state: SessionState):
        return {"ui": sessions.run("ui")}

    def adapter(_state: SessionState):
        return {"adapter": sessions.run("adapter")}

    def join(state: SessionState):
        # This slice cannot approve or merge: actual verification/review comes next.
        interrupt({"kind": "verification_required", "run_id": state["run_id"],
                   "message": "Claude sessions finished. Collect checks, browser evidence and independent review before integration."})
        raise RuntimeError("Integration is intentionally unavailable in this session-launch slice")

    graph = StateGraph(SessionState)
    graph.add_node("ui", ui)
    graph.add_node("adapter", adapter)
    graph.add_node("join", join)
    graph.add_edge(START, "ui")
    graph.add_edge(START, "adapter")
    graph.add_edge(["ui", "adapter"], "join")
    graph.add_edge("join", END)
    return graph.compile(checkpointer=checkpointer)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["prepare", "run", "status", "observe"])
    parser.add_argument("directory", type=Path, help="New run directory OUTSIDE the source repository")
    parser.add_argument("--repo", type=Path, default=Path.cwd())
    parser.add_argument("--base", default="HEAD")
    parser.add_argument("--ui-task", type=Path)
    parser.add_argument("--adapter-task", type=Path)
    parser.add_argument("--allow-edits", action="store_true", help="Allow file edits (no shell tools); defaults to read-only")
    parser.add_argument("--live", action="store_true", help="Explicit consent to launch billable/authenticated Claude sessions")
    parser.add_argument("--herdr", action="store_true", help="Create passive observer panes before running")
    parser.add_argument("--timeout", type=float, default=1800)
    args = parser.parse_args()
    directory = args.directory.resolve()
    try:
        if args.action == "prepare":
            if not args.ui_task or not args.adapter_task:
                parser.error("prepare requires --ui-task and --adapter-task")
            plan = prepare(directory, args.repo, args.base,
                           {"ui": args.ui_task.read_text(), "adapter": args.adapter_task.read_text()}, args.allow_edits)
            print(json.dumps(plan, indent=2))
            return
        if not (directory / "plan.json").is_file():
            parser.error("Prepare the run first")
        if args.action == "status":
            print(json.dumps({node: read_json(directory / f"{node}.json") if (directory / f"{node}.json").exists()
                              else {"status": "pending"} for node in NODES}, indent=2))
            return
        with run_lock(directory):
            if args.action == "observe":
                print(json.dumps(open_panels(directory), indent=2))
                return
            if not args.live:
                parser.error("run requires --live; this can consume your Claude usage")
            if args.timeout <= 0:
                parser.error("timeout must be positive")
            if not shutil.which("claude"):
                parser.error("Claude CLI unavailable")
            if args.herdr:
                print(json.dumps(open_panels(directory), indent=2))
            sessions = ClaudeSessions(directory, timeout=args.timeout)
            previous = {sig: signal.signal(sig, lambda _sig, _frame: sessions.cancelled.set())
                        for sig in (signal.SIGINT, signal.SIGTERM)}
            try:
                with SqliteSaver.from_conn_string(str(directory / "checkpoints.sqlite")) as saver:
                    graph = build_session_graph(saver, sessions)
                    config = {"configurable": {"thread_id": sessions.plan["run_id"]}, "max_concurrency": 2}
                    snapshot = graph.get_state(config)
                    if any(task.interrupts for task in snapshot.tasks):
                        print("Sessions are awaiting verification/review; no agents relaunched.")
                        return
                    result = graph.invoke(None if snapshot.values else {"run_id": sessions.plan["run_id"]}, config)
                    print(json.dumps(result, indent=2, default=str))
            finally:
                for sig, handler in previous.items():
                    signal.signal(sig, handler)
    except (RuntimeError, ValueError, OSError) as error:
        parser.exit(1, f"Blocked: {error}\nRun state/partial work retained at {directory}\n")


if __name__ == "__main__":
    main()
