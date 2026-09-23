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
import signal
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

from .guardrails import decisions_block
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
        prompt = worker_prompt(self.directory, self.plan, node)
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


def worker_prompt(directory: Path, plan: dict, node: str) -> str:
    """What a native worker session receives: the rules, its pinned task, the run's decisions.md, and in automatic mode the completion protocol."""
    prompt = ("You are a workflow worker in your own worktree. A human can type directly into this terminal. "
              "Do not launch agents, commit, merge, push or modify shared contracts. Stay within this worktree. "
              "Report changed files, checks actually executed, and open assumptions. "
              "Completion of a turn is not workflow approval.\n\n" + plan["nodes"][node]["task"] + decisions_block(plan))
    if plan.get("automatic"):
        from .automatic import completion_prompt
        prompt += completion_prompt(directory, plan, node)
    return prompt


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


# A Claude Code update restarts the background service, which drops every attached client while the
# sessions run on (the restarted service adopts them). attach-one reattaches with a bounded backoff.
REATTACH_LIMIT = 30          # attempts in a row without a working attach before attach-one gives up
REATTACH_MAX_DELAY = 10      # seconds; the delay doubles from 2 up to this cap
ATTACH_STABLE_SECONDS = 60   # an attach that held this long was connected: its loss starts a new count
# What a restarting service lists for a moment: a row still registering its PID. A failed listing is waited out whatever its error.
TRANSIENT_REFUSALS = ("No live native PID", "Session is not attachable")


def node_title(node: str) -> str:
    """`Worker <lane>`, `Reviewer review` for the default reviewer, `Reviewer <id>` for a declared one."""
    if node.startswith("review-"):
        return f"Reviewer {node[len('review-'):]}"
    return f"Reviewer {node}" if is_review_node(node) else f"Worker {node}"


def process_alive(pid) -> bool:
    """A PID from the session's own verified row; no PID (nothing attached yet) is never alive.

    kill(pid, 0) also answers for a process that has exited but is not collected yet (a zombie,
    for as long as its parent or, for an adopted session, init has not reaped it).
    """
    if not isinstance(pid, int) or pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    try:
        return Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()[0] != "Z"
    except (OSError, IndexError):
        return True  # No /proc: kill(pid, 0) is all there is.


def recorded_stop(directory: Path, node: str) -> dict | None:
    """The controller's stop of this node's session as `{time, reason}`, or None when it recorded none.

    `<node>.stop.json` is written before `claude stop` runs, so an attach that the stop itself ends
    already finds it; an unconfirmed intent counts too, since only the controller retries that stop.
    The time and reason come from the stop's timeline event (for workers stopped after a blocked
    wait, from that block), else from the marker.
    """
    marker = directory / f"{node}.stop.json"
    if not marker.is_file():
        return None
    try:
        confirmed = read_json(marker).get("stopped") is True
    except (ValueError, AttributeError):
        confirmed = False
    when = datetime.fromtimestamp(marker.stat().st_mtime, timezone.utc)
    reason = "stop recorded" if confirmed else "stop requested, not yet confirmed"
    path = directory / "events.jsonl"
    lines = path.read_text(errors="replace").splitlines() if confirmed and path.is_file() else []
    events = []
    for line in lines:
        try:
            events.append(json.loads(line))
        except ValueError:
            continue  # A line the controller was still writing.
    phase, prefix = (REVIEW, f"{node_title(node)} session stopped") if is_review_node(node) else ("freeze", "Native workers stopped")
    for index in range(len(events) - 1, -1, -1):
        event = events[index]
        if event.get("node") == phase and event.get("status") == "stopped" and str(event.get("message", "")).startswith(prefix):
            when, reason = datetime.fromisoformat(event["time"]), event["message"]
            previous = events[index - 1] if index else {}
            if previous.get("node") == "controller" and previous.get("status") == "blocked":
                reason = f"the run blocked: {previous['message']}"
            break
    return {"time": when.strftime("%Y-%m-%d %H:%M:%S UTC"), "reason": reason}


def observe(sessions: InteractiveSessions, node: str, pid) -> dict | None:
    """The session's verified row, or None while a restarting service cannot confirm it yet.

    Only the process attached before (its PID still alive) earns that wait. A first attach, a session
    whose process ended and every identity refusal fail at once, exactly as before. How the listing
    itself fails (a missing CLI, a timeout, a non-zero exit, output it cannot parse) is Claude Code's
    business and every such failure is a gap: nothing is attached without a verified live row.
    """
    waiting = process_alive(pid)
    try:
        rows = sessions.inventory()
    except Exception:
        if not waiting:
            raise
        return None
    try:
        row = sessions.locate(node, rows)
    except RuntimeError as error:
        if not waiting or not str(error).startswith(TRANSIENT_REFUSALS):
            raise
        return None
    if row is None and not waiting:
        raise RuntimeError("Session unavailable; refusing implicit restart")
    if row is not None and not process_alive(row["pid"]):
        raise RuntimeError("Native process is unavailable; refusing implicit restart")  # A zombie passes locate's kill(pid, 0).
    return row


def attach_one(sessions: InteractiveSessions, node: str, *, clock=time.monotonic, sleep=time.sleep) -> None:
    """Attach one session in this terminal, and attach it again after a lost connection.

    `claude attach` exits 0 when the operator detaches (Ctrl+Z, or ← to the agent view) or the session
    ended, and non-zero when it loses the background service. After each attach the run's own records
    decide: a stop the controller recorded ends attach-one with one line, a live session the controller
    has not stopped is attached again after a bounded backoff, and a session gone without a recorded stop
    is refused. `claude attach` would wake a missing session, so only an exact live row is ever attached.
    """
    failures, pid, background_id = 0, None, None
    ended = None  # How the last attach ended ("detached" or "lost"); None once waited out, or before the first.
    while True:
        stop = recorded_stop(sessions.directory, node)
        if stop is not None:
            print(f"{node_title(node)} was stopped by the controller at {stop['time']} ({stop['reason']}); nothing to attach.",
                  file=sys.stderr, flush=True)
            return
        row = observe(sessions, node, pid)
        if ended == "detached":
            return  # The operator detached; the session keeps running.
        if row is not None and ended is None:
            pid, background_id = row["pid"], row["id"]
            started = clock()
            try:
                code = subprocess.run([sessions.executable, "attach", background_id], cwd=sessions.node_worktree(node)).returncode
            except OSError:
                code = 1  # An update is replacing the CLI itself: retried like a lost connection.
            if code != 0 and clock() - started >= ATTACH_STABLE_SECONDS:
                failures = 0  # It was connected for a while: this loss starts a new count.
            # An attach the operator interrupted (Ctrl+C: 130, or killed by SIGINT) ends like a detach, never retried.
            ended = "detached" if code in (0, 130, -signal.SIGINT) else "lost"
            continue  # The records decide first: a stop, or a session that ended, is never waited for.
        failures += 1
        if failures >= REATTACH_LIMIT:
            raise RuntimeError(f"Gave up reattaching {node} ({background_id}) after {REATTACH_LIMIT} attempts in a row; the session may still "
                               f"be running. Rerun attach-one once `claude agents` lists it again")
        delay = min(2 ** failures, REATTACH_MAX_DELAY)
        if ended == "lost":
            print(f"Lost the connection to {node} ({background_id}); the background service may be restarting. Reattaching in {delay}s…",
                  file=sys.stderr, flush=True)
        else:
            print(f"The background service does not list {node} ({background_id}) yet; retrying in {delay}s…", file=sys.stderr, flush=True)
        ended = None
        sleep(delay)


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
        attach_one(sessions, args.node)
    except KeyboardInterrupt:
        parser.exit(130, f"\nattach-one interrupted; the {args.node} session keeps running (only the controller stops it).\n")
    except (RuntimeError, ValueError, OSError, subprocess.SubprocessError) as error:
        parser.exit(1, f"Blocked: {error}\nSession/worktree state retained at {directory}; no automatic stop or relaunch.\n")


if __name__ == "__main__":
    main()
