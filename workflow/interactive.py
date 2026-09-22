"""LangGraph launches persistent Claude terminals; Herdr attaches with input enabled."""
from __future__ import annotations

import argparse
import json
import os
import re
import shlex
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

from langgraph.checkpoint.sqlite import SqliteSaver
from langgraph.graph import END, START, StateGraph
from langgraph.types import interrupt

from .live import SessionState
from .observer import herdr
from .sessions import ClaudeSessions, NODES, REVIEWER, file_prefix, git, plan_digest, prepare, read_json, run_lock, save_json


class InteractiveSessions(ClaudeSessions):
    """Native Claude background sessions, not print-mode jobs or Herdr-owned agents."""

    def worktree(self, node: str) -> Path:
        """The reviewer's worktree is created by the review node, not by prepare."""
        return self.directory / "review-worktree" if node == REVIEWER else Path(self.plan["nodes"][node]["worktree"])

    def receipt_path(self, node: str) -> Path:
        return self.directory / f"{file_prefix(node)}.interactive.json"

    def inventory(self) -> list[dict]:
        response = subprocess.run([self.executable, "agents", "--json"],
                                  capture_output=True, text=True, check=True, timeout=15)
        rows = json.loads(response.stdout)
        if not isinstance(rows, list):
            raise RuntimeError("Unexpected Claude inventory response")
        return rows

    def launch_name(self, node: str) -> str:
        return f"workflow-{self.plan['run_id']}-{node}"

    def locate(self, node: str, rows: list[dict]) -> dict | None:
        path = self.receipt_path(node)
        if not path.exists():
            return None
        receipt = read_json(path)
        if receipt["plan_digest"] != plan_digest(self.plan):
            raise RuntimeError("Plan changed; cannot reconcile session")
        background_id = receipt.get("background_id")
        if not background_id:
            log = self.directory / f"{file_prefix(node)}.launch.log"
            if not log.exists():
                return None
            # --bg assigns its own UUID. Bind the ID printed by this launch;
            # never adopt a guessed UUID or a name-only match.
            ids = set(re.findall(r"claude attach ([a-f0-9-]{8,36})\s", log.read_text(errors="replace")))
            if len(ids) != 1:
                raise RuntimeError("Missing/ambiguous native launch ID; reconcile manually")
            background_id = ids.pop()
        matches = [row for row in rows if row.get("id") == background_id]
        if not matches:
            return None
        if len(matches) != 1:
            raise RuntimeError("Ambiguous Claude session identity")
        row = matches[0]
        if row.get("kind") != "background" or Path(row.get("cwd", "")).resolve() != self.worktree(node).resolve() or row.get("name") != self.launch_name(node):
            raise RuntimeError("Claude session identity/worktree mismatch")
        if receipt.get("background_id") and row.get("sessionId") != receipt.get("session_id"):
            raise RuntimeError("Native Claude UUID changed; refusing attachment")
        if not isinstance(row.get("sessionId"), str) or not re.fullmatch(r"[a-f0-9-]{36}", row["sessionId"]):
            raise RuntimeError("Missing native Claude UUID")
        # `done` is a finished TURN, not a terminated terminal. Require the
        # native live PID as well; stale registry rows must not imply restart.
        if row.get("state") not in {"idle", "working", "blocked", "done"}:
            raise RuntimeError(f"Session is not attachable: {row.get('state')!r}; reconcile manually")
        pid = row.get("pid")
        if not isinstance(pid, int) or pid <= 0:
            raise RuntimeError("No live native PID; reconcile session before attaching")
        try:
            os.kill(pid, 0)
        except OSError as error:
            raise RuntimeError("Native process is unavailable; refusing implicit restart") from error
        return row

    settle_seconds = 30.0

    def settle(self, node: str) -> dict:
        """Bind the row created by the launch we just issued.

        `claude --bg` exits before the native session has fully registered: the
        inventory row can appear without a PID for a moment. Poll for the exact
        row until it is attachable; identity mismatches still fail immediately
        and nothing is ever launched again from here.
        """
        deadline = time.monotonic() + self.settle_seconds
        while True:
            try:
                row = self.locate(node, self.inventory())
            except RuntimeError as error:
                if "No live native PID" not in str(error) or time.monotonic() >= deadline:
                    raise
                row = None
            if row is not None:
                return row
            if time.monotonic() >= deadline:
                raise RuntimeError("No exact matching background session after launch")
            time.sleep(1)

    def run(self, node: str) -> dict:
        if node not in NODES or self.plan.get("mode") != "interactive":
            raise ValueError("Expected an interactive worker plan")
        info = self.plan["nodes"][node]
        path = self.receipt_path(node)
        digest = plan_digest(self.plan)
        if path.exists():
            receipt = read_json(path)
            if receipt["plan_digest"] != digest:
                raise RuntimeError("Plan changed; refusing session reuse")
            row = self.locate(node, self.inventory())
            if row is None:
                raise RuntimeError("Existing launch cannot be reconciled; no automatic relaunch")
            receipt.update(status="attached_session_available", background_id=row["id"], session_id=row["sessionId"], observed_state=row["state"], native_started_at=row.get("startedAt"))
            receipt.pop("error", None)
            save_json(path, receipt)
            return receipt
        cwd = Path(info["worktree"])
        if git(cwd, "rev-parse", "HEAD") != self.plan["base_commit"] or git(cwd, "status", "--porcelain"):
            raise RuntimeError("Worktree changed since preparation")
        # Native IDs do not exist until launch. Reject conflicting terminal names.
        if any(row.get("name") == self.launch_name(node) for row in self.inventory()):
            raise RuntimeError("Unowned session already exists with this launch name")
        receipt = {"node_id": node, "session_id": None, "launch_token": info["session_id"], "plan_digest": digest,
                   "worktree": str(cwd), "base_commit": self.plan["base_commit"],
                   "status": "launching", "attempt": 1, "launcher_invocations": 1,
                   "launch_requested_at": datetime.now(timezone.utc).isoformat()}
        save_json(path, receipt)
        automatic = bool(self.plan.get("automatic"))
        if automatic:
            from .automatic import validate_automatic
            validate_automatic(self.plan)
        tools = "Read,Glob,Grep,Edit,Write" if self.plan["allow_edits"] else "Read,Glob,Grep"
        if automatic:
            tools += ",Bash"
        prompt = ("You are a workflow worker in your own worktree. A human can type directly into this terminal. "
                  "Do not launch agents, commit, merge, push or modify shared contracts. Stay within this worktree. "
                  "Report changed files, checks actually executed, and open assumptions. "
                  "Completion of a turn is not workflow approval.\n\n" + info["task"])
        if automatic:
            from .automatic import completion_prompt
            prompt += completion_prompt(self.directory, self.plan, node)
        command = [self.executable, "--bg", "--name", self.launch_name(node),
                   "--safe-mode", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
                   "--tools", tools, "--permission-mode", "bypassPermissions" if automatic else "manual"]
        if automatic:
            command.append("--dangerously-skip-permissions")
        command.append(prompt)
        env = {key: value for key, value in os.environ.items() if not key.startswith("HERDR_")}
        try:
            # This command creates Claude's own persistent terminal, then exits.
            # Killing this short helper is NOT evidence that the session stopped.
            with (self.directory / f"{node}.launch.log").open("w") as log:
                try:
                    result = subprocess.run(command, cwd=cwd, env=env, stdout=log,
                                            stderr=subprocess.STDOUT, text=True, timeout=self.timeout)
                finally:
                    log.flush()
                    os.fsync(log.fileno())
            if result.returncode != 0:
                raise RuntimeError(f"Claude background launch exited {result.returncode}; inspect launch log")
            row = self.settle(node)
            receipt.update(status="attached_session_available", background_id=row["id"], session_id=row["sessionId"], observed_state=row["state"], native_started_at=row.get("startedAt"))
        except BaseException as error:
            receipt.update(status="needs_reconciliation", error=str(error))
            raise
        finally:
            save_json(path, receipt)
        return receipt

    # Analysis tools plus the single completion file the protocol requires. The
    # reviewer never edits the candidate: its worktree is re-checked clean afterwards.
    reviewer_tools = "Read,Glob,Grep,Write"
    reviewer_permission_mode = "dontAsk"

    def run_reviewer(self, prompt: str, launch_token: str, commit: str) -> dict:
        """The reviewer is a native session with a worker's lifecycle and read-only reach."""
        if self.plan.get("mode") != "interactive" or not self.plan.get("automatic"):
            raise ValueError("A native reviewer belongs to an automatic interactive run")
        from .automatic import validate_automatic
        validate_automatic(self.plan)
        path = self.receipt_path(REVIEWER)
        digest = plan_digest(self.plan)
        cwd = self.worktree(REVIEWER)
        if path.exists():
            receipt = read_json(path)
            if receipt["plan_digest"] != digest or receipt["launch_token"] != launch_token:
                raise RuntimeError("Reviewer launch intent changed; refusing session reuse")
            row = self.locate(REVIEWER, self.inventory())
            if row is None:
                raise RuntimeError("Existing reviewer launch cannot be reconciled; no automatic relaunch")
            receipt.update(status="attached_session_available", background_id=row["id"], session_id=row["sessionId"],
                           observed_state=row["state"], native_started_at=row.get("startedAt"))
            receipt.pop("error", None)
            save_json(path, receipt)
            return receipt
        if git(cwd, "rev-parse", "HEAD") != commit or git(cwd, "status", "--porcelain"):
            raise RuntimeError("Reviewer worktree is not the clean reviewed candidate")
        if any(row.get("name") == self.launch_name(REVIEWER) for row in self.inventory()):
            raise RuntimeError("Unowned session already exists with this launch name")
        receipt = {"node_id": "review", "session_id": None, "launch_token": launch_token, "plan_digest": digest,
                   "worktree": str(cwd), "candidate_commit": commit,
                   "status": "launching", "attempt": 1, "launcher_invocations": 1,
                   "launch_requested_at": datetime.now(timezone.utc).isoformat()}
        save_json(path, receipt)
        command = [self.executable, "--bg", "--name", self.launch_name(REVIEWER),
                   "--safe-mode", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
                   "--tools", self.reviewer_tools, "--permission-mode", self.reviewer_permission_mode,
                   "--add-dir", str(self.directory), prompt]
        env = {key: value for key, value in os.environ.items() if not key.startswith("HERDR_")}
        try:
            with (self.directory / f"{file_prefix(REVIEWER)}.launch.log").open("w") as log:
                try:
                    result = subprocess.run(command, cwd=cwd, env=env, stdout=log,
                                            stderr=subprocess.STDOUT, text=True, timeout=self.timeout)
                finally:
                    log.flush()
                    os.fsync(log.fileno())
            if result.returncode != 0:
                raise RuntimeError(f"Claude background launch exited {result.returncode}; inspect launch log")
            row = self.settle(REVIEWER)
            receipt.update(status="attached_session_available", background_id=row["id"], session_id=row["sessionId"],
                           observed_state=row["state"], native_started_at=row.get("startedAt"))
        except BaseException as error:
            receipt.update(status="needs_reconciliation", error=str(error))
            raise
        finally:
            save_json(path, receipt)
        return receipt

    def status(self) -> dict:
        rows = self.inventory()
        result = {}
        for node in NODES:
            path = self.directory / f"{node}.interactive.json"
            row = self.locate(node, rows)
            result[node] = {"receipt": read_json(path) if path.exists() else None,
                            "current_session": row, "verified": False}
        return result


def build_interactive_graph(checkpointer, sessions: InteractiveSessions):
    def ui(_state: SessionState):
        return {"ui": sessions.run("ui")}

    def adapter(_state: SessionState):
        return {"adapter": sessions.run("adapter")}

    def handoff(state: SessionState):
        interrupt({"kind": "interactive_workers_active", "run_id": state["run_id"],
                   "message": "Type directly in the Claude panels. Idle is not completion. Explicit evidence/review handoff is still required."})
        raise RuntimeError("Verification/integration handoff is not implemented yet")

    graph = StateGraph(SessionState)
    graph.add_node("launch_ui", ui)
    graph.add_node("launch_adapter", adapter)
    graph.add_node("human_handoff", handoff)
    graph.add_edge(START, "launch_ui")
    graph.add_edge(START, "launch_adapter")
    graph.add_edge(["launch_ui", "launch_adapter"], "human_handoff")
    graph.add_edge("human_handoff", END)
    return graph.compile(checkpointer=checkpointer)


def require_shell(pane_id: str, settle_seconds: float = 10.0) -> None:
    """Only type into a pane whose sole foreground process is its own idle shell.

    A pane Herdr just created reports no shell, or a shell still running its
    startup files, for a moment. Poll briefly for the idle-shell state; a pane
    that is still occupied at the deadline is refused, never typed into.
    """
    deadline = time.monotonic() + settle_seconds
    while True:
        process = herdr("pane", "process-info", "--pane", pane_id)["result"]["process_info"]
        foreground = process.get("foreground_processes", [])
        shell_pid = process.get("shell_pid")
        if shell_pid and len(foreground) == 1 and foreground[0].get("pid") == shell_pid:
            return
        if time.monotonic() >= deadline:
            raise RuntimeError(f"Pane {pane_id} is occupied; refusing to type an attach command into it")
        time.sleep(0.5)


def attach_panels(sessions: InteractiveSessions, reuse_observers: Path | None = None) -> dict:
    directory = sessions.directory
    mapping_path = directory / "terminals.json"
    if mapping_path.exists():
        raise RuntimeError("Terminal mappings already exist; use attach-one inside an available terminal to reconnect")
    rows = sessions.inventory()
    for node in NODES:
        receipt = read_json(directory / f"{node}.interactive.json")
        if receipt["plan_digest"] != plan_digest(sessions.plan) or sessions.locate(node, rows) is None:
            raise RuntimeError("Cannot attach an unverified/missing session")
    caller = herdr("pane", "current", "--current")["result"]["pane"]
    source = Path(__file__).resolve().parents[1]
    if reuse_observers:
        mapping = read_json(reuse_observers)
        if set(mapping) != set(NODES) or any(value.get("mode") != "read-only-observer" for value in mapping.values()):
            raise RuntimeError("Can only replace explicitly identified read-only observer panels")
        if len({value["pane_id"] for value in mapping.values()}) != len(NODES):
            raise RuntimeError("Observer pane identities must be distinct")
        tabs = set()
        for entry in mapping.values():
            pane = herdr("pane", "get", entry["pane_id"])["result"]["pane"]
            if pane["workspace_id"] != caller["workspace_id"] or pane["tab_id"] != entry["tab_id"] or pane["tab_id"] == caller["tab_id"]:
                raise RuntimeError("Observer pane moved or is not in a dedicated tab in this workspace")
            require_shell(entry["pane_id"])
            tabs.add(pane["tab_id"])
        if len(tabs) != 1:
            raise RuntimeError("Workers must share a dedicated workflow tab")
        # Consume the old observer mapping before any attach command is sent.
        for entry in mapping.values():
            entry.update(mode="transferred-to-interactive", transferred_to=str(directory))
        save_json(reuse_observers, mapping)
        save_json(mapping_path, mapping)
        herdr("tab", "rename", next(iter(tabs)), f"Workflow: {directory.name}")
    else:
        created = herdr("tab", "create", "--workspace", caller["workspace_id"], "--cwd", str(source),
                        "--label", f"Workflow: {directory.name}", "--no-focus")["result"]
        mapping = {"ui": {"pane_id": created["root_pane"]["pane_id"], "tab_id": created["tab"]["tab_id"], "mode": "allocated"}}
        save_json(mapping_path, mapping)
        split = herdr("pane", "split", "--pane", mapping["ui"]["pane_id"], "--direction", "right", "--cwd", str(source), "--no-focus")["result"]
        mapping["adapter"] = {"pane_id": split["pane"]["pane_id"], "tab_id": created["tab"]["tab_id"], "mode": "allocated"}
        save_json(mapping_path, mapping)
    for node in list(mapping):
        attach_pane(sessions, node, mapping, mapping_path, rows)
    return mapping


def attach_pane(sessions: InteractiveSessions, node: str, mapping: dict, mapping_path: Path, rows: list[dict]) -> None:
    """Type one attach command into a pane whose own shell is idle."""
    entry = mapping[node]
    source = Path(__file__).resolve().parents[1]
    require_shell(entry["pane_id"])
    herdr("pane", "rename", entry["pane_id"], f"Claude: {node}")
    # Re-check identity in the actual attachment process immediately before exec.
    command = shlex.join([sys.executable, "-m", "workflow.interactive", "attach-one", str(sessions.directory), "--node", node])
    command = f"cd {shlex.quote(str(source))} && {command}"
    entry.update(mode="attach_requested", session_id=sessions.locate(node, rows)["sessionId"])
    save_json(mapping_path, mapping)
    herdr("pane", "run", entry["pane_id"], command)


def attach_reviewer_pane(sessions: InteractiveSessions) -> dict:
    """Third pane in the workers' own tab, created when the review node starts.

    The reviewer session does not exist at `start`, so this runs later. It only
    ever adds a pane to the tab the workers already share, and re-attaching an
    existing reviewer pane is a no-op rather than a second allocation.
    """
    directory = sessions.directory
    mapping_path = directory / "terminals.json"
    if not mapping_path.exists():
        raise RuntimeError("No workflow tab exists; attach the workers before the reviewer")
    mapping = read_json(mapping_path)
    if REVIEWER in mapping:
        return mapping
    tabs = {mapping[node]["tab_id"] for node in NODES if node in mapping}
    if len(tabs) != 1 or not set(NODES) <= set(mapping):
        raise RuntimeError("Workers do not share one dedicated workflow tab")
    rows = sessions.inventory()
    if sessions.locate(REVIEWER, rows) is None:
        raise RuntimeError("Cannot attach an unverified/missing reviewer session")
    source = Path(__file__).resolve().parents[1]
    split = herdr("pane", "split", "--pane", mapping["adapter"]["pane_id"], "--direction", "down",
                  "--cwd", str(source), "--no-focus")["result"]
    mapping[REVIEWER] = {"pane_id": split["pane"]["pane_id"], "tab_id": tabs.pop(), "mode": "allocated"}
    save_json(mapping_path, mapping)
    attach_pane(sessions, REVIEWER, mapping, mapping_path, rows)
    return mapping


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["prepare", "run", "status", "attach", "attach-one"])
    parser.add_argument("directory", type=Path)
    parser.add_argument("--repo", type=Path, default=Path.cwd())
    parser.add_argument("--base", default="HEAD")
    parser.add_argument("--ui-task", type=Path)
    parser.add_argument("--adapter-task", type=Path)
    parser.add_argument("--allow-edits", action="store_true")
    parser.add_argument("--live", action="store_true")
    parser.add_argument("--herdr", action="store_true")
    parser.add_argument("--reuse-observers", type=Path)
    parser.add_argument("--node", choices=[*NODES, REVIEWER])
    args = parser.parse_args()
    directory = args.directory.resolve()
    try:
        if args.action == "prepare":
            if not args.ui_task or not args.adapter_task:
                parser.error("prepare requires both task files")
            plan = prepare(directory, args.repo, args.base,
                           {"ui": args.ui_task.read_text(), "adapter": args.adapter_task.read_text()}, args.allow_edits)
            plan["mode"] = "interactive"
            save_json(directory / "plan.json", plan)
            print(json.dumps(plan, indent=2))
            return
        sessions = InteractiveSessions(directory, timeout=45)
        if sessions.plan.get("mode") != "interactive":
            parser.error("Not an interactive run; prepare a new run instead of converting print-mode sessions")
        if args.action == "status":
            print(json.dumps(sessions.status(), indent=2))
            return
        if args.action == "attach-one":
            if not args.node or not sys.stdin.isatty():
                parser.error("attach-one requires --node and an interactive terminal")
            receipt = read_json(sessions.receipt_path(args.node))
            if receipt["plan_digest"] != plan_digest(sessions.plan):
                raise RuntimeError("Plan changed; cannot attach")
            row = sessions.locate(args.node, sessions.inventory())
            if row is None:
                raise RuntimeError("Session unavailable; refusing implicit restart")
            os.chdir(sessions.worktree(args.node))
            os.execvp(sessions.executable, [sessions.executable, "attach", row["id"]])
        with run_lock(directory):
            if args.action == "attach":
                print(json.dumps(attach_panels(sessions, args.reuse_observers), indent=2))
                return
            if not args.live:
                parser.error("run requires --live (consumes Claude usage)")
            with SqliteSaver.from_conn_string(str(directory / "interactive-checkpoints.sqlite")) as saver:
                graph = build_interactive_graph(saver, sessions)
                config = {"configurable": {"thread_id": sessions.plan["run_id"]}, "max_concurrency": 2}
                snapshot = graph.get_state(config)
                if any(task.interrupts for task in snapshot.tasks):
                    print("Interactive handoff pending; no agents relaunched.")
                else:
                    result = graph.invoke(None if snapshot.values else {"run_id": sessions.plan["run_id"]}, config)
                    print(json.dumps(result, indent=2, default=str))
            if args.herdr:
                print(json.dumps(attach_panels(sessions, args.reuse_observers), indent=2))
    except (RuntimeError, ValueError, OSError, subprocess.SubprocessError) as error:
        parser.exit(1, f"Blocked: {error}\nSession/worktree state retained at {directory}; no automatic stop or relaunch.\n")


if __name__ == "__main__":
    main()
