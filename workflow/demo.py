"""Run with python -m workflow.demo --help."""
import argparse
import json
import subprocess
from pathlib import Path

from langgraph.checkpoint.sqlite import SqliteSaver
from langgraph.types import Command

from .graph import AttemptLedger, build_graph


def main():
    parser = argparse.ArgumentParser(description="Stub-only durable workflow lab; no Claude calls or Git writes")
    parser.add_argument("action", choices=["start", "resume", "approve", "status"])
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--data-dir", type=Path, default=Path(".workflow-state"))
    parser.add_argument("--fail-adapter-once", action="store_true")
    args = parser.parse_args()
    args.data_dir.mkdir(parents=True, exist_ok=True)
    ledger = AttemptLedger(args.data_dir / "attempts.sqlite")
    config = {"configurable": {"thread_id": args.run_id}, "max_concurrency": 2}
    with SqliteSaver.from_conn_string(str(args.data_dir / "checkpoints.sqlite")) as saver:
        graph = build_graph(saver, ledger)
        snapshot = graph.get_state(config)
        if args.action == "start":
            if snapshot.values:
                parser.error("Run already exists; use resume or a new run ID")
            base = subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip()
            value = {"run_id": args.run_id, "base_commit": base, "fail_adapter_once": args.fail_adapter_once}
        elif args.action == "status":
            print(json.dumps({"state": snapshot.values, "next": snapshot.next, "actual_worker_starts": ledger.counts(args.run_id)}, indent=2))
            return
        else:
            if not snapshot.values:
                parser.error("Run does not exist")
            pending_approval = any(task.interrupts for task in snapshot.tasks)
            if args.action == "approve" and not pending_approval:
                parser.error("No approval is pending")
            if args.action == "resume" and pending_approval:
                parser.error("Run awaits approval; use approve")
            value = Command(resume={"approve_stub_completion": True}) if args.action == "approve" else None
        try:
            result = graph.invoke(value, config)
            print(json.dumps(result, indent=2, default=str))
        except RuntimeError as error:
            print(json.dumps({"error": str(error), "actual_worker_starts": ledger.counts(args.run_id)}))
            raise SystemExit(1) from error
        print(json.dumps({"actual_worker_starts": ledger.counts(args.run_id)}))


if __name__ == "__main__":
    main()
