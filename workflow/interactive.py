"""LangGraph launches persistent Claude terminals; Herdr attaches with input enabled.

The pipeline (`python -m workflow`) is the only entry point that launches sessions. This module's own
CLI keeps one action: `attach-one`, which the Herdr panes run to reconnect one session in a terminal.
"""
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

from .herdr import herdr
from .sessions import ClaudeSessions, git, plan_digest, read_json, review_node, review_nodes, save_json

REVIEW = "review"


def is_review_node(node: str) -> bool:
    return node == REVIEW or node.startswith("review-")


def pane_label(node: str) -> str:
    """`Claude: <lane>`, `Claude: reviewer` for the default reviewer, `Claude: reviewer <id>` for a declared one."""
    if node == REVIEW:
        return "Claude: reviewer"
    if node.startswith("review-"):
        return f"Claude: reviewer {node[len('review-'):]}"
    return f"Claude: {node}"


class InteractiveSessions(ClaudeSessions):
    """Native Claude background sessions, not print-mode jobs or Herdr-owned agents."""

    def inventory(self) -> list[dict]:
        response = subprocess.run([self.executable, "agents", "--json"],
                                  capture_output=True, text=True, check=True, timeout=15)
        rows = json.loads(response.stdout)
        if not isinstance(rows, list):
            raise RuntimeError("Unexpected Claude inventory response")
        return rows

    def launch_name(self, node: str) -> str:
        """`workflow-<run>-<lane>`, `workflow-<run>-reviewer` for the default reviewer, `workflow-<run>-reviewer-<id>` otherwise."""
        if node == REVIEW:
            return f"workflow-{self.plan['run_id']}-reviewer"
        if node.startswith("review-"):
            return f"workflow-{self.plan['run_id']}-reviewer-{node[len('review-'):]}"
        return f"workflow-{self.plan['run_id']}-{node}"

    def node_worktree(self, node: str) -> Path:
        """Workers live in the plan's worktrees; every reviewer in the run's shared candidate checkout."""
        if is_review_node(node):
            return self.directory / "review-worktree"
        return Path(self.plan["nodes"][node]["worktree"])

    def locate(self, node: str, rows: list[dict]) -> dict | None:
        path = self.directory / f"{node}.interactive.json"
        if not path.exists():
            return None
        receipt = read_json(path)
        if receipt["plan_digest"] != plan_digest(self.plan):
            raise RuntimeError("Plan changed; cannot reconcile session")
        background_id = receipt.get("background_id")
        if not background_id:
            log = self.directory / f"{node}.launch.log"
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
        if row.get("kind") != "background" or Path(row.get("cwd", "")).resolve() != self.node_worktree(node).resolve() or row.get("name") != self.launch_name(node):
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

    def reconcile(self, node: str, path: Path, receipt: dict) -> dict:
        """An existing receipt binds the one session this intent produced; nothing is launched again."""
        if receipt["plan_digest"] != plan_digest(self.plan):
            raise RuntimeError("Plan changed; refusing session reuse")
        row = self.locate(node, self.inventory())
        if row is None:
            raise RuntimeError("Existing launch cannot be reconciled; no automatic relaunch")
        receipt.update(status="attached_session_available", background_id=row["id"], session_id=row["sessionId"], observed_state=row["state"], native_started_at=row.get("startedAt"))
        receipt.pop("error", None)
        save_json(path, receipt)
        return receipt

    def launch(self, node: str, path: Path, receipt: dict, command: list[str], cwd: Path) -> dict:
        """Run the short `claude --bg` helper once, then bind the exact row it created."""
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

    def run(self, node: str) -> dict:
        if node not in self.workers or self.plan.get("mode") != "interactive":
            raise ValueError("Expected an interactive worker plan")
        info = self.plan["nodes"][node]
        path = self.directory / f"{node}.interactive.json"
        if path.exists():
            return self.reconcile(node, path, read_json(path))
        cwd = Path(info["worktree"])
        if git(cwd, "rev-parse", "HEAD") != self.plan["base_commit"] or git(cwd, "status", "--porcelain"):
            raise RuntimeError("Worktree changed since preparation")
        # Native IDs do not exist until launch. Reject conflicting terminal names.
        if any(row.get("name") == self.launch_name(node) for row in self.inventory()):
            raise RuntimeError("Unowned session already exists with this launch name")
        receipt = {"node_id": node, "session_id": None, "launch_token": info["session_id"], "plan_digest": plan_digest(self.plan),
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
        # The exact prompt is run evidence (the viewer shows it); it is private like the receipts.
        write_private(self.directory / f"{node}.prompt.txt", prompt)
        command = [self.executable, "--bg", "--name", self.launch_name(node),
                   "--safe-mode", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
                   "--tools", tools, "--permission-mode", "bypassPermissions" if automatic else "manual"]
        if automatic:
            command.append("--dangerously-skip-permissions")
        command.append(prompt)
        return self.launch(node, path, receipt, command, cwd)

    def run_reviewer(self, reviewer_id: str, prompt: str, launch_token: str, candidate_commit: str) -> dict:
        """Launch (or reconcile) one native reviewer session for this candidate.

        Every reviewer reads the same candidate checkout and the run directory; its only
        permitted write is its own completion file, which the controller later validates.
        """
        if self.plan.get("mode") != "interactive":
            raise ValueError("Expected an interactive run plan")
        node = review_node(reviewer_id)
        path = self.directory / f"{node}.interactive.json"
        if path.exists():
            return self.reconcile(node, path, read_json(path))
        cwd = self.node_worktree(node)
        if not cwd.is_dir():
            raise RuntimeError("Review worktree is missing; the review node creates it before launching a reviewer")
        if git(cwd, "rev-parse", "HEAD") != candidate_commit or git(cwd, "status", "--porcelain"):
            raise RuntimeError("Review worktree is not at the clean candidate commit")
        if any(row.get("name") == self.launch_name(node) for row in self.inventory()):
            raise RuntimeError("Unowned session already exists with this launch name")
        receipt = {"node_id": node, "session_id": None, "launch_token": launch_token, "plan_digest": plan_digest(self.plan),
                   "worktree": str(cwd), "base_commit": self.plan["base_commit"], "candidate_commit": candidate_commit,
                   "status": "launching", "attempt": 1, "launcher_invocations": 1,
                   "launch_requested_at": datetime.now(timezone.utc).isoformat()}
        save_json(path, receipt)
        write_private(self.directory / f"{node}.prompt.txt", prompt)
        # Claude permission rules spell absolute paths as //absolute/path, and file writes are
        # governed by the Edit rule family (Write, Edit, NotebookEdit): under dontAsk a rule
        # spelled Write(...) never matches and every write is denied (seen live), while
        # Edit(//<path>) allows exactly that file and keeps every other write denied.
        completion = str(self.directory / f"{node}.completion.json").lstrip("/")
        # --tools, --allowedTools and --add-dir are variadic: any of them directly before the
        # positional prompt would swallow it (the session would start idle, without a task).
        # The prompt therefore follows --permission-mode, which takes exactly one value.
        command = [self.executable, "--bg", "--name", self.launch_name(node),
                   "--safe-mode", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
                   "--tools", "Read,Glob,Grep,Write", "--allowedTools", f"Edit(//{completion})",
                   "--add-dir", str(self.directory), "--permission-mode", "dontAsk", prompt]
        return self.launch(node, path, receipt, command, cwd)


def write_private(path: Path, text: str) -> None:
    path.write_text(text)
    os.chmod(path, 0o600)


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


def attach_panels(sessions: InteractiveSessions) -> dict:
    directory = sessions.directory
    mapping_path = directory / "terminals.json"
    workers = list(sessions.workers)
    reviewers = review_nodes(sessions.plan)
    if mapping_path.exists():
        mapping = read_json(mapping_path)
        if set(workers) <= set(mapping) and any(node not in mapping and (directory / f"{node}.interactive.json").exists() for node in reviewers):
            # The workers' tab exists and a reviewer appeared after it: add only the missing reviewer panes.
            return attach_reviewer_panel(sessions)
        raise RuntimeError("Terminal mappings already exist; use attach-one inside an available terminal to reconnect")
    rows = sessions.inventory()
    for node in workers:
        receipt = read_json(directory / f"{node}.interactive.json")
        if receipt["plan_digest"] != plan_digest(sessions.plan) or sessions.locate(node, rows) is None:
            raise RuntimeError("Cannot attach an unverified/missing session")
    caller = herdr("pane", "current", "--current")["result"]["pane"]
    source = Path(__file__).resolve().parents[1]
    # The first lane takes the tab's root pane; each following lane splits right of the previous one.
    created = herdr("tab", "create", "--workspace", caller["workspace_id"], "--cwd", str(source),
                    "--label", f"Workflow: {directory.name}", "--no-focus")["result"]
    tab_id = created["tab"]["tab_id"]
    mapping = {workers[0]: {"pane_id": created["root_pane"]["pane_id"], "tab_id": tab_id, "mode": "allocated"}}
    save_json(mapping_path, mapping)
    for previous, node in zip(workers, workers[1:]):
        split = herdr("pane", "split", "--pane", mapping[previous]["pane_id"], "--direction", "right", "--cwd", str(source), "--no-focus")["result"]
        mapping[node] = {"pane_id": split["pane"]["pane_id"], "tab_id": tab_id, "mode": "allocated"}
        save_json(mapping_path, mapping)
    # Reviewers that already exist (attach after the review node started) get their panes now, in declared
    # order; otherwise the review node adds them through attach_reviewer_panel as it launches them.
    for node in reviewers:
        if (directory / f"{node}.interactive.json").exists() and sessions.locate(node, rows) is not None:
            allocate_reviewer_pane(sessions, mapping, mapping_path, node)
    for node, entry in mapping.items():
        attach_pane(sessions, mapping, mapping_path, node, sessions.locate(node, rows)["sessionId"])
    return mapping


def allocate_reviewer_pane(sessions: InteractiveSessions, mapping: dict, mapping_path: Path, node: str = REVIEW) -> None:
    """A reviewer pane splits right of the previous pane: the last lane's for the first reviewer, then each reviewer's predecessor."""
    source = Path(__file__).resolve().parents[1]
    reviewers = review_nodes(sessions.plan)
    earlier = [item for item in reviewers[:reviewers.index(node)] if item in mapping] if node in reviewers else []
    last = mapping[earlier[-1] if earlier else sessions.workers[-1]]
    split = herdr("pane", "split", "--pane", last["pane_id"], "--direction", "right", "--cwd", str(source), "--no-focus")["result"]
    mapping[node] = {"pane_id": split["pane"]["pane_id"], "tab_id": last["tab_id"], "mode": "allocated"}
    save_json(mapping_path, mapping)


def attach_pane(sessions: InteractiveSessions, mapping: dict, mapping_path: Path, node: str, session_id: str) -> None:
    source = Path(__file__).resolve().parents[1]
    entry = mapping[node]
    require_shell(entry["pane_id"])
    herdr("pane", "rename", entry["pane_id"], pane_label(node))
    # Re-check identity in the actual attachment process immediately before exec.
    command = shlex.join([sys.executable, "-m", "workflow.interactive", "attach-one", str(sessions.directory), "--node", node])
    command = f"cd {shlex.quote(str(source))} && {command}"
    entry.update(mode="attach_requested", session_id=session_id)
    save_json(mapping_path, mapping)
    herdr("pane", "run", entry["pane_id"], command)


def attach_reviewer_panel(sessions: InteractiveSessions) -> dict:
    """Add a `Claude: reviewer <id>` pane beside the workers' panes for every launched reviewer that has none yet, in declared order."""
    directory = sessions.directory
    mapping_path = directory / "terminals.json"
    if not mapping_path.exists():
        raise RuntimeError("No terminal mappings; attach the worker panes before the reviewer pane")
    mapping = read_json(mapping_path)
    if not set(sessions.workers) <= set(mapping):
        raise RuntimeError("Terminal mappings lack the worker panes; refusing to add a reviewer pane")
    reviewers = review_nodes(sessions.plan)
    launched = [node for node in reviewers if (directory / f"{node}.interactive.json").exists()]
    if not launched:
        raise RuntimeError("No reviewer session receipt; nothing to attach")
    missing = [node for node in launched if node not in mapping]
    if not missing:
        raise RuntimeError(f"Reviewer pane already allocated; use attach-one --node {launched[-1]} inside an available terminal to reconnect")
    rows = sessions.inventory()
    for node in missing:
        if read_json(directory / f"{node}.interactive.json")["plan_digest"] != plan_digest(sessions.plan):
            raise RuntimeError("Plan changed; cannot attach the reviewer")
        row = sessions.locate(node, rows)
        if row is None:
            raise RuntimeError(f"Cannot attach an unverified/missing reviewer session ({node})")
        allocate_reviewer_pane(sessions, mapping, mapping_path, node)
        attach_pane(sessions, mapping, mapping_path, node, row["sessionId"])
    return mapping


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["attach-one"])
    parser.add_argument("directory", type=Path)
    parser.add_argument("--node", help="attach-one: a worker lane of the run, or a reviewer node (review, or review-<id>)")
    args = parser.parse_args()
    directory = args.directory.resolve()
    try:
        sessions = InteractiveSessions(directory, timeout=45)
        if sessions.plan.get("mode") != "interactive":
            parser.error("Not an interactive run; prepare a new run instead of converting print-mode sessions")
        if not args.node or not sys.stdin.isatty():
            parser.error("attach-one requires --node and an interactive terminal")
        if args.node not in sessions.workers and args.node not in review_nodes(sessions.plan):
            parser.error(f"--node must be a lane of this run ({', '.join(sessions.workers)}) or {', '.join(review_nodes(sessions.plan))}")
        receipt = read_json(directory / f"{args.node}.interactive.json")
        if receipt["plan_digest"] != plan_digest(sessions.plan):
            raise RuntimeError("Plan changed; cannot attach")
        row = sessions.locate(args.node, sessions.inventory())
        if row is None:
            raise RuntimeError("Session unavailable; refusing implicit restart")
        os.chdir(sessions.node_worktree(args.node))
        os.execvp(sessions.executable, [sessions.executable, "attach", row["id"]])
    except (RuntimeError, ValueError, OSError, subprocess.SubprocessError) as error:
        parser.exit(1, f"Blocked: {error}\nSession/worktree state retained at {directory}; no automatic stop or relaunch.\n")


if __name__ == "__main__":
    main()
