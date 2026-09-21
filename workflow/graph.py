"""Small durable graph with independently addressable worker nodes.

This is a recovery lab, not a production Claude runner. Stub results are explicitly
marked synthetic; verification and integration do not execute project checks or Git.
"""
from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import TypedDict

from jsonschema import Draft202012Validator, FormatChecker
from langgraph.graph import END, START, StateGraph
from langgraph.types import interrupt

CONTRACTS = Path(__file__).resolve().parents[1] / "contracts" / "workflow"


class State(TypedDict, total=False):
    run_id: str
    base_commit: str
    fail_adapter_once: bool
    ui_result: dict
    adapter_result: dict
    browser_gate: str
    adapter_gate: str
    review: dict
    integration: str


def validate_result(result: dict) -> None:
    schema = json.loads((CONTRACTS / "workerResult.schema.json").read_text())
    Draft202012Validator(schema, format_checker=FormatChecker()).validate(result)


class AttemptLedger:
    """Separate durable actual-start evidence; survives failed graph supersteps."""

    def __init__(self, path: Path):
        self.path = path
        path.parent.mkdir(parents=True, exist_ok=True)
        with sqlite3.connect(path) as db:
            db.execute("CREATE TABLE IF NOT EXISTS attempts (run_id TEXT, node_id TEXT, attempt INTEGER, PRIMARY KEY(run_id, node_id, attempt))")

    def start(self, run_id: str, node_id: str) -> int:
        with sqlite3.connect(self.path, timeout=30) as db:
            db.execute("BEGIN IMMEDIATE")
            attempt = db.execute("SELECT COALESCE(MAX(attempt), 0) + 1 FROM attempts WHERE run_id=? AND node_id=?", (run_id, node_id)).fetchone()[0]
            db.execute("INSERT INTO attempts VALUES (?, ?, ?)", (run_id, node_id, attempt))
            return attempt

    def counts(self, run_id: str) -> dict[str, int]:
        with sqlite3.connect(self.path) as db:
            return dict(db.execute("SELECT node_id, COUNT(*) FROM attempts WHERE run_id=? GROUP BY node_id", (run_id,)))


def build_graph(checkpointer, ledger: AttemptLedger):
    def worker(state: State, node_id: str) -> dict:
        attempt = ledger.start(state["run_id"], node_id)
        if node_id == "adapter" and state.get("fail_adapter_once") and attempt == 1:
            raise RuntimeError("Injected adapter failure (once per run)")
        result = {
            "contract_version": "1.0.0", "run_id": state["run_id"],
            "node_id": node_id, "attempt": attempt,
            "session_id": f"stub:{state['run_id']}:{node_id}:{attempt}",
            "status": "succeeded", "base_commit": state["base_commit"],
            "output_commit": state["base_commit"], "changed_files": [],
            "checks": [], "open_assumptions": ["Synthetic stub: no agent, implementation, or checks executed"],
            "artifacts": [], "summary": "Stub completed without changing files", "error": None,
        }
        validate_result(result)
        return {f"{node_id}_result": result}

    def ui(state: State):
        return worker(state, "ui")

    def adapter(state: State):
        return worker(state, "adapter")

    def browser_gate(state: State):
        validate_result(state["ui_result"])
        return {"browser_gate": "stub_only_not_browser_verified"}

    def adapter_gate(state: State):
        validate_result(state["adapter_result"])
        return {"adapter_gate": "stub_only_not_tested"}

    def review(state: State):
        for node_id in ("ui", "adapter"):
            result = state[f"{node_id}_result"]
            validate_result(result)
            if result["run_id"] != state["run_id"] or result["base_commit"] != state["base_commit"] or result["node_id"] != node_id:
                raise ValueError("Join identity/base mismatch")
        return {"review": {"mode": "stub", "production_ready": False,
                           "summary": "Both worker payloads conform; real verification remains unimplemented"}}

    def integrate(state: State):
        # No external side effect before interrupt: this node restarts on resume.
        approval = interrupt({"action": "approve_stub_completion", "review": state["review"]})
        if approval != {"approve_stub_completion": True}:
            return {"integration": "rejected"}
        return {"integration": "stub_completed_no_merge"}

    graph = StateGraph(State)
    for name, function in (("ui", ui), ("adapter", adapter), ("browser_gate", browser_gate),
                           ("adapter_gate", adapter_gate), ("review", review), ("integrate", integrate)):
        graph.add_node(name, function)
    graph.add_edge(START, "ui")
    graph.add_edge(START, "adapter")
    graph.add_edge("ui", "browser_gate")
    graph.add_edge("adapter", "adapter_gate")
    graph.add_edge(["browser_gate", "adapter_gate"], "review")
    graph.add_edge("review", "integrate")
    graph.add_edge("integrate", END)
    return graph.compile(checkpointer=checkpointer)
