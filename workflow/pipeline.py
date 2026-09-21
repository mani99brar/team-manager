"""Complete operator-driven graph: launch → freeze → verify → review → approve → integrate.

No agent starts without `start --live`. Operator controls are local CLI-only.
"""
from __future__ import annotations

import argparse
import hashlib
import html
import json
import os
import re
import shutil
import subprocess
import threading
from pathlib import Path
from typing import TypedDict

from langgraph.checkpoint.sqlite import SqliteSaver
from langgraph.graph import END, START, StateGraph
from langgraph.types import Command, interrupt

from .checks import now, recheck_packet, verify_revision
from .export_state import export_state
from .interactive import InteractiveSessions, attach_panels
from .sessions import NODES, git, prepare, read_json, run_lock, save_json
from .verification import owns, policy_digest, safe_path, validate_policy


def validate_pipeline_policy(policy: dict) -> dict:
    validate_policy(policy)
    if {worker["node_id"]: worker["role"] for worker in policy["workers"]} != {"ui": "frontend", "adapter": "backend"}:
        raise ValueError("This graph requires ui/frontend and adapter/backend policies")
    return policy


def pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    return True


def digest_file(path: Path) -> str:
    with path.open("rb") as handle:
        return hashlib.file_digest(handle, "sha256").hexdigest()


def commit_env() -> dict:
    env = dict(os.environ)
    env.update(GIT_AUTHOR_NAME="Workflow snapshot", GIT_AUTHOR_EMAIL="workflow@localhost",
               GIT_COMMITTER_NAME="Workflow snapshot", GIT_COMMITTER_EMAIL="workflow@localhost")
    return env


def changed_files(cwd: Path, base: str) -> list[str]:
    tracked = subprocess.check_output(["git", "-C", str(cwd), "diff", "--no-renames", "--name-only", "-z", base]).decode().split("\0")
    untracked = subprocess.check_output(["git", "-C", str(cwd), "ls-files", "--others", "--exclude-standard", "-z"]).decode().split("\0")
    return sorted(set(filter(None, tracked + untracked)))


class PipelineState(TypedDict, total=False):
    run_id: str
    ui: dict
    adapter: dict
    snapshots: dict
    ui_packet: str
    adapter_packet: str
    bundle: str
    review: dict
    approved_bundle: str
    integrated_commit: str


class Pipeline:
    def __init__(self, directory: Path, sessions=None):
        self.directory = directory.resolve()
        self.plan = read_json(self.directory / "plan.json")
        self.policy = validate_pipeline_policy(read_json(self.directory / "policy.json"))
        if self.plan.get("policy_sha256") != policy_digest(self.policy):
            raise ValueError("Pinned policy changed")
        if {worker["node_id"] for worker in self.policy["workers"]} != set(NODES):
            raise ValueError("This small graph requires policy nodes ui and adapter")
        self.sessions = sessions or InteractiveSessions(self.directory, timeout=45)
        self._events_lock = threading.Lock()

    def event(self, node: str, status: str, message: str):
        with self._events_lock:
            path = self.directory / "events.jsonl"
            prior = path.read_text().splitlines() if path.exists() else []
            sequence = json.loads(prior[-1])["sequence"] + 1 if prior else 1
            record = {"sequence": sequence, "time": now(), "node": node, "status": status, "message": message}
            with path.open("a") as handle:
                handle.write(json.dumps(record) + "\n")
                handle.flush()
                os.fsync(handle.fileno())

    def launch(self, node: str) -> dict:
        self.event(node, "running", "Launching or reconciling the exact native session")
        try:
            receipt = self.sessions.run(node)
        except Exception as error:
            self.event(node, "blocked", str(error))
            raise
        self.event(node, "interactive", "Awaiting explicit human handoff; idle is not acceptance")
        return receipt

    def stop_workers(self):
        """Persist native identity before stopping. Never signal guessed/reused PIDs."""
        for node in NODES:
            marker = self.directory / f"{node}.stop.json"
            if marker.exists():
                intent = read_json(marker)
            else:
                row = self.sessions.locate(node, self.sessions.inventory())
                if row is None:
                    raise RuntimeError("Worker missing before freeze; reconcile before snapshotting")
                intent = {"background_id": row["id"], "session_id": row["sessionId"], "pid": row["pid"], "stopped": False}
                save_json(marker, intent)
            if not intent["stopped"]:
                rows = self.sessions.inventory()
                matching = [row for row in rows if row.get("sessionId") == intent["session_id"] and row.get("pid")]
                if matching:
                    row = self.sessions.locate(node, rows)
                    if row is None or row["id"] != intent["background_id"] or row["pid"] != intent["pid"]:
                        raise RuntimeError("Native worker identity changed after stop intent; reconcile manually")
                    result = subprocess.run([self.sessions.executable, "stop", intent["background_id"]], capture_output=True, text=True, timeout=20)
                    if result.returncode != 0:
                        raise RuntimeError(f"Stop failed for {node}; inspect native session before retrying")
                # Recover stop-before-receipt without issuing another stop command.
                rows = self.sessions.inventory()
                if any(row.get("sessionId") == intent["session_id"] and row.get("pid") for row in rows) or pid_alive(intent["pid"]):
                    raise RuntimeError("Worker termination is not established; retry freeze after reconciliation")
                intent["stopped"] = True
                save_json(marker, intent)
        stopped_ids = {read_json(self.directory / f"{node}.stop.json")["session_id"] for node in NODES}
        if any(row.get("sessionId") in stopped_ids and row.get("pid") for row in self.sessions.inventory()):
            raise RuntimeError("A stopped worker was restarted; reconcile before snapshot capture")
        self.event("freeze", "stopped", "Both native workers stopped before snapshot capture")

    def freeze(self) -> dict:
        record = self.directory / "snapshots.json"
        if record.exists():
            return read_json(record)
        handoffs = {}
        for node in NODES:
            handoff_path = self.directory / f"{node}.handoff.json"
            if not handoff_path.exists():
                raise ValueError(f"Missing {node} handoff: summary and open_assumptions are required")
            handoff = read_json(handoff_path)
            if set(handoff) != {"summary", "open_assumptions"} or not isinstance(handoff["summary"], str) or not handoff["summary"].strip() or not isinstance(handoff["open_assumptions"], list) or any(not isinstance(item, str) for item in handoff["open_assumptions"]):
                raise ValueError("Malformed worker handoff")
            handoffs[node] = handoff
        self.stop_workers()
        snapshots = {}
        for node in NODES:
            worker = next(item for item in self.policy["workers"] if item["node_id"] == node)
            cwd = Path(self.plan["nodes"][node]["worktree"])
            if git(cwd, "rev-parse", "HEAD") != self.plan["base_commit"]:
                raise ValueError("Worker changed HEAD; reconcile commits rather than silently accepting them")
            changed = changed_files(cwd, self.plan["base_commit"])
            for name in changed:
                safe_path(name)
                if not any(owns(name, safe_path(prefix)) for prefix in worker["owned_paths"]):
                    raise ValueError(f"{node} edited unowned path: {name}")
                if (cwd / name).is_symlink():
                    raise ValueError("Symlink changes require manual review before snapshot")
            index = self.directory / f"{node}.snapshot-index"
            if index.exists():
                index.unlink()  # Only our private temporary index, never a user's index.
            env = commit_env()
            env["GIT_INDEX_FILE"] = str(index)
            subprocess.run(["git", "-C", str(cwd), "read-tree", self.plan["base_commit"]], env=env, check=True)
            subprocess.run(["git", "-C", str(cwd), "add", "-A", "--", "."], env=env, check=True)
            tree = subprocess.check_output(["git", "-C", str(cwd), "write-tree"], env=env, text=True).strip()
            # Validate paths from the actual captured tree, including staged renames/deletes.
            captured = git(cwd, "diff-tree", "--no-commit-id", "--no-renames", "--name-only", "-r", self.plan["base_commit"], tree).splitlines()
            if sorted(captured) != changed:
                raise ValueError("Files changed during snapshot; refuse inconsistent evidence")
            commit = self.plan["base_commit"]
            if changed:
                commit = subprocess.check_output(["git", "-C", str(cwd), "-c", "commit.gpgsign=false", "commit-tree", tree,
                                                  "-p", self.plan["base_commit"], "-m", f"Workflow {self.plan['run_id']}: {node}"], env=env, text=True).strip()
            ref = f"refs/workflow/{hashlib.sha256(str(self.directory).encode()).hexdigest()[:16]}/{node}"
            subprocess.run(["git", "-C", str(cwd), "update-ref", ref, commit], check=True)
            receipt = read_json(self.directory / f"{node}.interactive.json")
            snapshots[node] = {"commit": commit, "changed_files": changed, "session_id": receipt["session_id"], **handoffs[node]}
        save_json(record, snapshots)
        self.event("freeze", "succeeded", "Immutable snapshots captured; worker-reported checks are not trusted")
        return snapshots

    def attempt(self, phase: str, node: str) -> int:
        path = self.directory / "attempts.json"
        value = read_json(path).get(f"{phase}:{node}", 1) if path.exists() else 1
        if type(value) is not int or value < 1 or value > self.policy.get("max_verification_attempts", 3):
            raise ValueError("Verification attempt exceeds the run's hard limit")
        return value

    def retry_check(self, phase: str, node: str) -> int:
        value = self.attempt(phase, node) + 1
        if value > self.policy.get("max_verification_attempts", 3):
            raise ValueError("Verification attempt limit reached; inspect evidence and create an explicitly revised run")
        path = self.directory / "attempts.json"
        attempts = read_json(path) if path.exists() else {}
        attempts[f"{phase}:{node}"] = value
        save_json(path, attempts)
        return value

    def native_evidence(self) -> dict:
        return {node: {key: read_json(self.directory / f"{node}.interactive.json").get(key)
                       for key in ("session_id", "background_id", "launcher_invocations", "native_started_at")}
                for node in NODES}

    def verify(self, node: str, snapshots: dict) -> str:
        snap = snapshots[node]
        attempt = self.attempt("worker", node)
        self.event(f"verify_{node}", "running", f"Attempt {attempt}; revision {snap['commit']}")
        packet = verify_revision(self.directory, self.plan, self.policy, node, snap["commit"], snap["changed_files"], snap["session_id"], attempt=attempt)
        path = self.directory / "verification" / "worker" / node / str(attempt) / "packet.json"
        drill = self.policy.get("failure_drill")
        if drill and drill["node_id"] == node and attempt == 1:
            marker = "Intentional lab drill: verification branch failure, not a worker or test failure"
            if marker not in packet["capture_errors"]:
                packet["capture_errors"].append(marker)
                packet["gate"]["reasons"].append(marker)
            packet["gate"]["status"] = "blocked"
            drill_path = self.directory / "failure-drill.json"
            if not drill_path.exists():
                save_json(drill_path, {"node_id": node, "phase": "worker", "attempt": 1,
                                       "injected_at": now(), "native_before": self.native_evidence()})
        packet["result"]["summary"] = snap["summary"]
        packet["result"]["open_assumptions"] = snap["open_assumptions"]
        save_json(path, packet)
        self.event(f"verify_{node}", packet["gate"]["status"], "; ".join(packet["gate"]["reasons"]) or "Required tests and artifacts passed")
        if packet["gate"]["status"] != "passed":
            raise RuntimeError(f"{node} verification blocked; see {path}. Retry explicitly or start a revised run.")
        return str(path)

    def candidate(self, state: PipelineState) -> str:
        # Validate branch evidence again before combining anything.
        worker_paths = [Path(state[f"{node}_packet"]) for node in NODES]
        for path in worker_paths:
            packet = recheck_packet(read_json(path), self.policy, self.directory)
            if packet["gate"]["status"] != "passed":
                raise ValueError("Worker evidence no longer passes")
        saved = self.directory / "candidate.json"
        if saved.exists():
            candidate = read_json(saved)
        else:
            cwd = self.directory / "candidate"
            if cwd.exists():
                raise ValueError("Partial candidate worktree exists; inspect before recovery")
            subprocess.run(["git", "-C", self.plan["repository"], "worktree", "add", "--detach", str(cwd), self.plan["base_commit"]], check=True, capture_output=True)
            for node in NODES:
                commit = state["snapshots"][node]["commit"]
                if commit != self.plan["base_commit"]:
                    subprocess.run(["git", "-C", str(cwd), "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "cherry-pick", commit], env=commit_env(), check=True, capture_output=True)
            candidate = {"commit": git(cwd, "rev-parse", "HEAD"), "worktree": str(cwd)}
            save_json(saved, candidate)
        candidate_paths = []
        for node in NODES:
            attempt = self.attempt("candidate", node)
            packet = verify_revision(self.directory, self.plan, self.policy, node, candidate["commit"],
                                     changed_files(Path(candidate["worktree"]), self.plan["base_commit"]),
                                     state["snapshots"][node]["session_id"], phase="candidate", attempt=attempt)
            path = self.directory / "verification" / "candidate" / node / str(attempt) / "packet.json"
            self.event(f"candidate_{node}", packet["gate"]["status"], f"Combined revision {candidate['commit']}")
            if packet["gate"]["status"] != "passed":
                raise RuntimeError(f"Combined candidate failed {node} checks; see {path}")
            candidate_paths.append(path)
        bundle = {"run_id": self.plan["run_id"], "base_commit": self.plan["base_commit"],
                  "candidate_commit": candidate["commit"], "policy_sha256": policy_digest(self.policy),
                  "snapshots": state["snapshots"],
                  "packets": [{"path": str(path), "sha256": digest_file(path)} for path in worker_paths + candidate_paths]}
        path = self.directory / "review-bundle.json"
        drill_path = self.directory / "failure-drill.json"
        if drill_path.exists():
            before = read_json(drill_path)["native_before"]
            after = self.native_evidence()
            audit = {"run_id": self.plan["run_id"], "native_before": before, "native_after": after,
                     "workers_with_changed_launch_evidence": [node for node in NODES if before[node] != after[node]],
                     "verification_attempts": {node: sorted(int(item.name) for item in (self.directory / "verification" / "worker" / node).iterdir() if item.is_dir() and item.name.isdigit()) for node in NODES},
                     "scope": "Pipeline-issued sessions; native launch times/counts are null when unavailable. Out-of-band manual restarts are not certified."}
            save_json(self.directory / "failure-report.json", audit)
            bundle["failure_drill"] = audit
        save_json(path, bundle)
        return str(path)

    def validate_bundle(self) -> tuple[dict, str]:
        path = self.directory / "review-bundle.json"
        bundle = read_json(path)
        if bundle["run_id"] != self.plan["run_id"] or bundle["policy_sha256"] != policy_digest(self.policy):
            raise ValueError("Bundle identity/policy changed")
        for reference in bundle["packets"]:
            packet_path = Path(reference["path"]).resolve()
            if not packet_path.is_relative_to(self.directory) or digest_file(packet_path) != reference["sha256"]:
                raise ValueError("Review evidence changed")
            packet = recheck_packet(read_json(packet_path), self.policy, self.directory)
            if packet["gate"]["status"] != "passed":
                raise ValueError("Review artifact missing, changed or failing")
        return bundle, digest_file(path)

    def validate_review(self, review: dict) -> None:
        bundle, digest = self.validate_bundle()
        required = {"run_id", "bundle_sha256", "candidate_commit", "reviewer", "independent", "verdict", "findings"}
        if set(review) != required or review["run_id"] != bundle["run_id"] or review["bundle_sha256"] != digest or review["candidate_commit"] != bundle["candidate_commit"]:
            raise ValueError("Review must reference this exact run, bundle hash and candidate")
        worker_ids = {item["session_id"] for item in bundle["snapshots"].values()}
        if review["independent"] is not True or not isinstance(review["reviewer"], str) or not review["reviewer"].strip() or review["reviewer"] in worker_ids:
            raise ValueError("Independent reviewer identity required")
        if review["verdict"] != "approved" or not isinstance(review["findings"], list):
            raise ValueError("Review is not approved")
        for finding in review["findings"]:
            if not isinstance(finding, dict) or set(finding) != {"severity", "message", "disposition"} or finding["severity"] not in {"P0", "P1", "P2"} or finding["disposition"] not in {"open", "resolved", "accepted"} or not isinstance(finding["message"], str) or not finding["message"].strip():
                raise ValueError("Malformed review finding")
            if finding["severity"] in {"P0", "P1"} and finding["disposition"] != "resolved":
                raise ValueError("Unresolved blocking review finding")

    def integrate(self, approved: str) -> str:
        bundle, digest = self.validate_bundle()
        review = read_json(self.directory / "review.json")
        self.validate_review(review)
        if approved != digest:
            raise ValueError("Approval references stale evidence")
        repo = Path(self.plan["repository"])
        candidate = bundle["candidate_commit"]
        intent = self.directory / "integration-intent.json"
        if git(repo, "symbolic-ref", "--short", "HEAD") != self.plan["source_branch"]:
            raise ValueError("Source branch changed")
        if git(repo, "status", "--porcelain"):
            raise ValueError("Source worktree is dirty; refusing integration")
        if intent.exists():
            if read_json(intent) != {"bundle_sha256": digest, "candidate_commit": candidate}:
                raise ValueError("Integration intent changed")
            if git(repo, "rev-parse", "HEAD") == candidate:
                return candidate
        if git(repo, "rev-parse", "HEAD") != self.plan["base_commit"]:
            raise ValueError("Source advanced since preparation; rebase/review explicitly")
        save_json(intent, {"bundle_sha256": digest, "candidate_commit": candidate})
        subprocess.run(["git", "-C", str(repo), "-c", "core.hooksPath=/dev/null", "merge", "--ff-only", candidate], check=True, capture_output=True)
        self.event("integrate", "succeeded", f"Fast-forwarded to {candidate}; no push performed")
        return candidate


def build_pipeline(checkpointer, runtime: Pipeline):
    def ui(_state): return {"ui": runtime.launch("ui")}
    def adapter(_state): return {"adapter": runtime.launch("adapter")}
    def handoff(_state):
        decision = interrupt({"kind": "worker_handoff", "message": "Type in Claude terminals; provide both handoffs, then explicitly freeze."})
        if decision != {"freeze": True}:
            raise ValueError("Explicit freeze required")
        return {"snapshots": runtime.freeze()}
    def verify_ui(state): return {"ui_packet": runtime.verify("ui", state["snapshots"])}
    def verify_adapter(state): return {"adapter_packet": runtime.verify("adapter", state["snapshots"])}
    def candidate(state): return {"bundle": runtime.candidate(state)}
    def review(_state):
        _, digest = runtime.validate_bundle()
        decision = interrupt({"kind": "independent_review", "bundle_sha256": digest,
                              "bundle_path": str(runtime.directory / "review-bundle.json")})
        runtime.validate_review(decision)
        save_json(runtime.directory / "review.json", decision)
        runtime.event("review", "approved", decision["reviewer"])
        return {"review": decision}
    def approval(_state):
        _, digest = runtime.validate_bundle()
        decision = interrupt({"kind": "integration_approval", "bundle_sha256": digest,
                              "message": "Approve fast-forward of source branch; no push."})
        if decision != {"approve": digest}:
            raise ValueError("Explicit exact-bundle approval required")
        return {"approved_bundle": digest}
    def integrate(state): return {"integrated_commit": runtime.integrate(state["approved_bundle"])}
    graph = StateGraph(PipelineState)
    for name, function in (("launch_ui", ui), ("launch_adapter", adapter), ("handoff", handoff),
                           ("verify_ui", verify_ui), ("verify_adapter", verify_adapter), ("candidate", candidate),
                           ("review", review), ("approval", approval), ("integrate", integrate)):
        graph.add_node(name, function)
    graph.add_edge(START, "launch_ui"); graph.add_edge(START, "launch_adapter")
    graph.add_edge(["launch_ui", "launch_adapter"], "handoff")
    graph.add_edge("handoff", "verify_ui"); graph.add_edge("handoff", "verify_adapter")
    graph.add_edge(["verify_ui", "verify_adapter"], "candidate")
    graph.add_edge("candidate", "review"); graph.add_edge("review", "approval")
    graph.add_edge("approval", "integrate"); graph.add_edge("integrate", END)
    return graph.compile(checkpointer=checkpointer)


def report(runtime: Pipeline, state) -> Path:
    """Escaped local results viewer, generated on every CLI boundary; no server needed."""
    export_state(runtime, state)
    events_path = runtime.directory / "events.jsonl"
    events = [json.loads(line) for line in events_path.read_text().splitlines()] if events_path.exists() else []
    packets = list((runtime.directory / "verification").glob("*/*/*/packet.json"))
    parts = ['<!doctype html><meta charset="utf-8"><title>Workflow report</title><style>body{font:16px system-ui;max-width:1100px;margin:40px auto;background:#151820;color:#eee}pre{white-space:pre-wrap}a{color:#8dcaff}img{max-width:100%}section{border:1px solid #555;padding:16px;margin:16px 0}</style>',
             '<h1>Workflow report</h1><p>Launch workers → human handoff → isolated checks → combined checks → independent review → approval → integration</p>',
             '<h2>Current state</h2><pre>' + html.escape(json.dumps({"next": state.next, "interrupts": [str(task.interrupts) for task in state.tasks if task.interrupts], "errors": [str(task.error) for task in state.tasks if task.error], "integrated_commit": state.values.get("integrated_commit")}, indent=2)) + '</pre>',
             '<h2>Timeline</h2><pre>' + html.escape(json.dumps(events, indent=2)) + '</pre>']
    positions = {"launch_ui": (90, 70), "launch_adapter": (90, 210), "handoff": (280, 140),
                 "verify_ui": (470, 70), "verify_adapter": (470, 210), "candidate": (660, 140),
                 "review": (850, 140), "approval": (1040, 140), "integrate": (1230, 140)}
    edges = [("launch_ui", "handoff"), ("launch_adapter", "handoff"), ("handoff", "verify_ui"),
             ("handoff", "verify_adapter"), ("verify_ui", "candidate"), ("verify_adapter", "candidate"),
             ("candidate", "review"), ("review", "approval"), ("approval", "integrate")]
    svg = ['<h2>Execution graph</h2><svg role="img" aria-label="Workflow execution graph" viewBox="0 0 1330 280">']
    for left, right in edges:
        x1, y1 = positions[left]; x2, y2 = positions[right]
        svg.append(f'<line x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" stroke="#9aa"/>')
    for name, (x, y) in positions.items():
        color = '#665000' if name in state.next else '#263747'
        svg.append(f'<rect x="{x-75}" y="{y-23}" width="150" height="46" rx="8" fill="{color}" stroke="#9aa"/><text x="{x}" y="{y+5}" text-anchor="middle" fill="white" font-size="14">{name}</text>')
    svg.append('</svg><p>Highlighted nodes are pending. A completed launch is not a completed worker task.</p>')
    parts[2:2] = svg
    from urllib.parse import quote
    for path in packets:
        packet = read_json(path)
        parts.append('<section><h2>' + html.escape(str(path.relative_to(runtime.directory))) + '</h2><pre>' + html.escape(json.dumps({"gate": packet["gate"], "result": packet["result"]}, indent=2)) + '</pre>')
        for artifact in packet["result"]["artifacts"]:
            local = Path(packet["artifact_paths"][artifact["artifact_id"]]).resolve()
            if not local.is_relative_to(runtime.directory):
                continue
            url = quote(str(local.relative_to(runtime.directory)), safe="/")
            parts.append(f'<p><a href="{url}">{html.escape(artifact["artifact_id"])}</a></p>')
            if artifact["kind"] == "screenshot":
                parts.append(f'<img alt="Browser scenario screenshot" src="{url}">')
        parts.append('</section>')
    failure_report = runtime.directory / "failure-report.json"
    if failure_report.exists():
        parts.append('<h2>Checkpoint failure drill</h2><pre>' + html.escape(failure_report.read_text()) + '</pre>')
    destination = runtime.directory / "report.html"
    destination.write_text("\n".join(parts))
    return destination


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["preflight", "prepare", "start", "attach", "freeze", "retry", "reconcile", "review", "approve", "status"])
    parser.add_argument("directory", type=Path)
    parser.add_argument("--repo", type=Path, default=Path.cwd())
    parser.add_argument("--policy", type=Path)
    parser.add_argument("--ui-task", type=Path)
    parser.add_argument("--adapter-task", type=Path)
    parser.add_argument("--live", action="store_true")
    parser.add_argument("--herdr", action="store_true")
    parser.add_argument("--ui-handoff", type=Path)
    parser.add_argument("--adapter-handoff", type=Path)
    parser.add_argument("--review-file", type=Path)
    parser.add_argument("--bundle-sha256")
    parser.add_argument("--node", choices=NODES)
    parser.add_argument("--phase", choices=["worker", "candidate"], default="worker")
    args = parser.parse_args()
    directory = args.directory.resolve()
    try:
        if args.action == "preflight":
            if not args.policy:
                parser.error("preflight requires --policy")
            policy = validate_pipeline_policy(read_json(args.policy))
            if {worker["node_id"] for worker in policy["workers"]} != set(NODES):
                parser.error("Policy must name ui and adapter")
            if git(args.repo.resolve(), "status", "--porcelain"):
                raise ValueError("Source must be clean before prepare")
            for executable in ("git", "claude", "node"):
                if not shutil.which(executable):
                    raise ValueError(f"Missing executable: {executable}")
            help_text = subprocess.check_output(["claude", "--help"], text=True, timeout=15)
            if not all(flag in help_text for flag in ("--bg", "--safe-mode", "--tools", "--permission-mode")):
                raise ValueError("Installed Claude CLI lacks required flags")
            auth = json.loads(subprocess.check_output(["claude", "auth", "status"], text=True, timeout=15))
            if auth.get("loggedIn") is not True:
                raise ValueError("Claude is not authenticated")
            if args.herdr and os.environ.get("HERDR_ENV") != "1":
                raise ValueError("Herdr attachment requires a managed caller pane")
            print(json.dumps({"preflight": "passed", "base_commit": git(args.repo.resolve(), "rev-parse", "HEAD"),
                              "policy_sha256": policy_digest(policy), "note": "No agents launched. Actual dependency/test availability is checked in isolated verification worktrees."}, indent=2))
            return
        if args.action == "prepare":
            if not all((args.policy, args.ui_task, args.adapter_task)):
                parser.error("prepare requires --policy and both task files")
            policy = validate_pipeline_policy(read_json(args.policy))
            if {worker["node_id"] for worker in policy["workers"]} != set(NODES):
                parser.error("This graph requires policy nodes ui and adapter")
            tasks = {"ui": args.ui_task.read_text(), "adapter": args.adapter_task.read_text()}
            for worker in policy["workers"]:
                tasks[worker["node_id"]] += "\nApproved ownership and checks:\n" + json.dumps(worker)
            plan = prepare(directory, args.repo, "HEAD", tasks, True)
            plan.update(mode="interactive", policy_sha256=policy_digest(policy), created_at=now(), source_branch=git(args.repo.resolve(), "symbolic-ref", "--short", "HEAD"))
            save_json(directory / "policy.json", policy)
            save_json(directory / "plan.json", plan)
            from types import SimpleNamespace
            export_state(Pipeline(directory), SimpleNamespace(values={}, next=("launch_ui", "launch_adapter"), tasks=[]))
            print(f"Prepared {directory}; no agents launched. Pin: {plan['base_commit']}")
            return
        with run_lock(directory):
            runtime = Pipeline(directory)
            if args.action == "attach":
                print(json.dumps(attach_panels(runtime.sessions), indent=2)); return
            with SqliteSaver.from_conn_string(str(directory / "pipeline.sqlite")) as saver:
                graph = build_pipeline(saver, runtime)
                config = {"configurable": {"thread_id": runtime.plan["run_id"]}, "max_concurrency": 2}
                state = graph.get_state(config)
                pending = [item.value.get("kind") for task in state.tasks for item in task.interrupts]
                value = None
                if args.action == "start":
                    if not args.live:
                        parser.error("start requires --live; do not use it for offline tests")
                    if state.values:
                        parser.error("Run already started; use status/explicit controls, never start again")
                    value = {"run_id": runtime.plan["run_id"]}
                elif args.action == "freeze":
                    if pending != ["worker_handoff"]:
                        parser.error("Run is not waiting for worker handoff")
                    for node, handoff_path in (("ui", args.ui_handoff), ("adapter", args.adapter_handoff)):
                        if handoff_path:
                            save_json(directory / f"{node}.handoff.json", read_json(handoff_path))
                    value = Command(resume={"freeze": True})
                elif args.action == "review":
                    if pending != ["independent_review"] or not args.review_file:
                        parser.error("Review requires pending review and --review-file")
                    decision = read_json(args.review_file)
                    runtime.validate_review(decision)
                    value = Command(resume=decision)
                elif args.action == "approve":
                    if pending != ["integration_approval"]:
                        parser.error("Run is not waiting for integration approval")
                    _, digest = runtime.validate_bundle()
                    if args.bundle_sha256 != digest:
                        parser.error("Provide the exact --bundle-sha256 displayed at approval")
                    value = Command(resume={"approve": digest})
                elif args.action == "reconcile":
                    if pending or not state.next or not any(step.startswith("launch_") for step in state.next):
                        parser.error("Reconcile requires failed launch steps")
                    for step in state.next:
                        if step.startswith("launch_"):
                            node = step.removeprefix("launch_")
                            if not (directory / f"{node}.interactive.json").exists():
                                parser.error("No durable launch intent; cannot reconcile without potentially launching a new agent")
                            runtime.sessions.run(node)  # Existing receipt path never starts a new process.
                elif args.action == "retry":
                    if not state.values or pending or not state.next:
                        parser.error("Retry requires a failed graph step, not an interrupt/completed run")
                    if args.node:
                        step = f"verify_{args.node}" if args.phase == "worker" else "candidate"
                        if step not in state.next:
                            parser.error("Selected check is not a failed/pending step")
                        runtime.retry_check(args.phase, args.node)
                    # No new agent launch is ever permitted during retry.
                    if any(step.startswith("launch_") for step in state.next):
                        parser.error("Launch failure requires explicit session reconciliation; do not blindly retry")
                if args.action != "status":
                    try:
                        graph.invoke(value, config)
                    finally:
                        print(f"Report: {report(runtime, graph.get_state(config))}")
                    if args.action == "start" and args.herdr:
                        print(json.dumps(attach_panels(runtime.sessions), indent=2))
                else:
                    print(json.dumps({"next": state.next, "pending": pending, "errors": [str(task.error) for task in state.tasks if task.error]}, indent=2))
                    print(f"Report: {report(runtime, state)}")
    except (ValueError, RuntimeError, OSError, subprocess.SubprocessError) as error:
        parser.exit(1, f"Blocked: {error}\nAll work/evidence retained at {directory}. No automatic fallback or push.\n")


if __name__ == "__main__":
    main()
