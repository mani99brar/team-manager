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
from .sessions import (CLAUDE_MISSING_GRACE_SECONDS, ClaudeSessions, TransientInfraError, background_settings, claude_env, git, plan_digest, read_json, review_node,
                       review_nodes, run_claude, save_json)

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


def listed_rows(result: subprocess.CompletedProcess) -> list | None:
    """The rows of one `claude agents --json` answer, or None when it is not a listing: a nonzero exit, or output that is not a JSON list."""
    if result.returncode != 0:
        return None
    try:
        rows = json.loads(result.stdout)
    except (TypeError, ValueError):
        return None
    return rows if isinstance(rows, list) else None


class InteractiveSessions(ClaudeSessions):
    """Native Claude background sessions, not print-mode jobs or Herdr-owned agents."""

    def inventory(self) -> list[dict]:
        """`claude agents --json`. The listing only reads, so while the background service restarts (it exits nonzero,
        prints no list or hangs) it is asked again for the grace; a listing that stays unavailable is TransientInfraError.
        """
        try:
            response = run_claude([self.executable, "agents", "--json"], capture_output=True, text=True, timeout=15,
                                  retry_output=lambda result: listed_rows(result) is None)
        except subprocess.TimeoutExpired as error:
            raise TransientInfraError(f"Claude session inventory unavailable for {CLAUDE_MISSING_GRACE_SECONDS}s: {error}") from error
        rows = listed_rows(response)
        if rows is None:
            # Claude Code is unavailable, which says nothing about any session.
            answer = f"exited {response.returncode}" if response.returncode else "printed no session list"
            detail = ((response.stderr or "").strip() or (response.stdout or "").strip())[-300:]
            raise TransientInfraError(f"Claude session inventory unavailable for {CLAUDE_MISSING_GRACE_SECONDS}s: "
                                      f"`claude agents --json` {answer}" + (f": {detail}" if detail else ""))
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
                    # Only an exec that failed (nothing ran) is repeated; a helper that ran is never run twice.
                    result = run_claude(command, cwd=cwd, env=env, stdout=log,
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
        command = [self.executable, "--bg", "--name", self.launch_name(node), *background_settings(),
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
        command = [self.executable, "--bg", "--name", self.launch_name(node), *background_settings(),
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
# sessions run on (the restarted service adopts them), and about 15 seconds later respawns the idle ones
# onto the new binary under new PIDs. attach-one reattaches with a bounded backoff.
REATTACH_LIMIT = 30          # attempts in a row without a working attach before attach-one gives up
REATTACH_MAX_DELAY = 10      # seconds; the delay doubles from 2 up to this cap
ATTACH_STABLE_SECONDS = 60   # an attach that held this long was connected: its loss starts a new count
DEAD_PID_GRACE_SECONDS = 30  # an ended process with no new one listed (the controller: any gap): how long a respawn's new PID is awaited
# What a restarting service lists for a moment: a row still registering its PID, or in a state between two processes
# (starting, resuming). A failed listing is waited out whatever its error; a terminal state never is.
TRANSIENT_REFUSALS = ("No live native PID", "Session is not attachable")
TERMINAL_STATES = {"stopped", "failed"}
PROCESS_ENDED = "Native process is unavailable; refusing implicit restart"


class SessionGap(RuntimeError):
    """What a restarting background service shows for a while after an attach; waited out within REATTACH_LIMIT (the controller: UpdateGaps)."""


class ProcessEnded(SessionGap):
    """The attached process ended with no new one listed (its PID, or no row): waited out for DEAD_PID_GRACE_SECONDS, then refused."""


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
    """The controller's stop of this node's session as `{time, reason, confirmed, background_id}`, or None when it recorded none.

    `<node>.stop.json` is written before `claude stop` runs, so an attach that the stop itself ends
    already finds it; an unconfirmed intent counts too, since only the controller retries that stop.
    The time and reason come from the stop's timeline event (for workers stopped after a blocked
    wait, from that block), else from the marker.
    """
    marker = directory / f"{node}.stop.json"
    if not marker.is_file():
        return None
    try:
        intent = read_json(marker)
        confirmed = intent.get("stopped") is True
    except (ValueError, AttributeError):
        intent, confirmed = {}, False
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
    return {"time": when.strftime("%Y-%m-%d %H:%M:%S UTC"), "reason": reason, "confirmed": confirmed,
            "background_id": intent.get("background_id")}


def stop_reported(directory: Path, node: str) -> bool:
    """Whether the controller recorded a stop of this node's session; if so, one line says so."""
    stop = recorded_stop(directory, node)
    if stop is None:
        return False
    if stop["confirmed"]:
        message = f"{node_title(node)} was stopped by the controller at {stop['time']} ({stop['reason']}); nothing to attach."
    else:
        message = (f"The controller is stopping {node} (requested at {stop['time']}, not yet confirmed); not attaching. "
                   f"Inspect it with `claude logs {stop['background_id']}`, which only reads it: attaching could restart a session the stop "
                   "already ended.")
    print(message, file=sys.stderr, flush=True)
    return True


def observe(sessions: InteractiveSessions, node: str, attached: dict | None) -> dict:
    """The session's verified live row; SessionGap while a restarting service cannot confirm it yet.

    Only a background id verified live and attached before (`attached`, its row then) earns that wait,
    whatever became of its PID, since an update respawns the session under a new one. How the listing
    itself fails (a missing CLI, a timeout, a non-zero exit, output it cannot parse) is Claude Code's
    business and every such failure is a gap; what the listing says is judged by verified_row.
    """
    try:
        rows = sessions.inventory()
    except Exception as error:
        if attached is None:
            raise
        raise SessionGap(str(error)) from error
    return verified_row(sessions, node, rows, attached)


def verified_row(sessions: InteractiveSessions, node: str, rows: list[dict], attached: dict | None) -> dict:
    """The session's verified live row in one listing; SessionGap while an update's respawn hides it.

    For a background id verified live before (`attached`, a row with its id and last live PID) a row still
    registering its PID or in a state between two processes is a gap, as are a listing without the id while
    that process lives and (ProcessEnded) a row still listing a PID whose process ended or a listing without
    the id once it ended. A first attach, a terminal state and every identity refusal fail at once: nothing
    is attached without a verified live row. attach-one and the controller's waits (UpdateGaps) judge alike.
    """
    try:
        row = sessions.locate(node, rows)
    except RuntimeError as error:
        if attached is None:
            raise
        if str(error).startswith(PROCESS_ENDED):
            raise ProcessEnded(PROCESS_ENDED) from error
        terminal = any(listed.get("id") == attached["id"] and listed.get("state") in TERMINAL_STATES for listed in rows)
        if terminal or not str(error).startswith(TRANSIENT_REFUSALS):
            raise
        raise SessionGap(str(error)) from error
    if row is None:
        if attached is None:
            raise RuntimeError("Session unavailable; refusing implicit restart")
        if not process_alive(attached["pid"]):
            # Without --all `claude agents` omits a finished (`done`) session that has no process: an idle one between
            # the two processes of an update's respawn, or one that ended.
            raise ProcessEnded("Session unavailable; refusing implicit restart")
        raise SessionGap(f"`claude agents` does not list {attached['id']}")
    if not process_alive(row["pid"]):  # A zombie passes locate's kill(pid, 0).
        raise ProcessEnded(PROCESS_ENDED) if attached is not None else RuntimeError(PROCESS_ENDED)
    return row


class UpdateGaps:
    """The controller's waits and stops under attach-one's rules: an update's respawn gap is never a verdict on a session.

    A node whose receipt is bound (its background id verified live at launch) that the listing shows in a gap
    (verified_row) raises SessionGap, and the caller looks at it again (a wait at its next poll, a stop after
    2 seconds) for DEAD_PID_GRACE_SECONDS from when that gap was first seen; a gap that lasts longer is
    TransientInfraError, so the run stops nothing and resumes. A receipt not bound yet keeps locate's plain answer.
    """

    def __init__(self, sessions: InteractiveSessions, directory: Path, clock):
        self.sessions, self.directory, self.clock = sessions, directory, clock
        self.since: dict[str, float] = {}  # When each node's current gap was first seen.
        self.pids: dict[str, int] = {}     # Each node's last live PID.

    def row(self, node: str, rows: list[dict]) -> dict | None:
        """The node's verified live row, or locate's answer while its receipt is not bound; SessionGap while a gap lasts."""
        path = self.directory / f"{node}.interactive.json"
        bound = read_json(path).get("background_id") if path.exists() else None
        if not bound:
            return self.sessions.locate(node, rows)
        try:
            row = verified_row(self.sessions, node, rows, {"id": bound, "pid": self.pids.get(node)})
        except SessionGap as gap:
            now = self.clock()
            if now - self.since.setdefault(node, now) >= DEAD_PID_GRACE_SECONDS:
                raise TransientInfraError(f"Claude Code has not listed a live {node} session ({bound}) for {DEAD_PID_GRACE_SECONDS}s "
                                          f"({gap}); an update may still be respawning it") from gap
            raise
        self.since.pop(node, None)
        self.pids[node] = row["pid"]
        return row


def attach_one(sessions: InteractiveSessions, node: str, *, clock=time.monotonic, sleep=time.sleep) -> None:
    """Attach one session in this terminal, and attach it again after a lost connection.

    `claude attach` exits 0 when the operator detaches (Ctrl+Z, or ← to the agent view) or the session
    ended, and non-zero when it loses the background service. After each attach the run's own records
    decide: a stop the controller recorded ends attach-one with one line, a live session the controller
    has not stopped is attached again after a bounded backoff (also after exit 0 when the service respawned
    it under a new PID: a detach never changes the PID), and a session gone without a recorded stop is
    refused. `claude attach` would wake a missing session, so only an exact live row is ever attached.
    """
    failures, attached = 0, None  # attached: the row of the last attach
    ended = None  # How the last attach ended ("detached", "interrupted" or "lost"); None once decided, or before the first.
    dead_since = last_error = None  # When a row was first seen listing an ended process; what made the latest attempt fail.
    while True:
        if stop_reported(sessions.directory, node):
            return
        try:
            row = observe(sessions, node, attached)
        except ProcessEnded as gap:
            # A respawn lists its new PID within seconds; a session that keeps missing a live process has ended.
            now = clock()
            dead_since = now if dead_since is None else dead_since
            if now - dead_since >= DEAD_PID_GRACE_SECONDS:
                raise
            row, last_error = None, str(gap)
        except SessionGap as gap:
            row, last_error = None, str(gap)
        else:
            dead_since = None
        respawned = row is not None and ended is not None and row["pid"] != attached["pid"]
        if ended == "interrupted" or (ended == "detached" and row is not None and not respawned):
            return  # The operator detached or interrupted the attach; the session keeps running.
        if row is not None and ended is None:
            if stop_reported(sessions.directory, node):
                return  # The controller's stop intent precedes `claude stop`: a session it is stopping is never attached.
            attached, started = row, clock()
            try:
                code = subprocess.run([sessions.executable, "attach", row["id"]], cwd=sessions.node_worktree(node)).returncode
                failure = f"`claude attach` exited {code}"
            except OSError as error:
                code, failure = 1, str(error)  # An update is replacing the CLI itself: retried like a lost connection.
            if clock() - started >= ATTACH_STABLE_SECONDS:
                failures = 0  # It was connected for a while: its end starts a new count.
            # An attach the operator interrupted (Ctrl+C: 130, or killed by SIGINT) is never retried.
            ended = "interrupted" if code in (130, -signal.SIGINT) else "detached" if code == 0 else "lost"
            if ended == "lost":
                last_error = failure
            continue  # The records decide first: a stop, or a session that ended, is never waited for.
        failures += 1
        if failures >= REATTACH_LIMIT:
            raise RuntimeError(f"Gave up reattaching {node} ({attached['id']}) after {REATTACH_LIMIT} attempts in a row; the session may still "
                               f"be running. Rerun attach-one once `claude agents` lists it again"
                               + (f"; last error: {last_error}" if last_error else ""))
        delay = min(2 ** failures, REATTACH_MAX_DELAY)
        if respawned:
            print(f"The background service respawned {node} ({attached['id']}) as PID {row['pid']}; reattaching in {delay}s…",
                  file=sys.stderr, flush=True)
        elif ended == "lost":
            print(f"Lost the connection to {node} ({attached['id']}); the background service may be restarting. Reattaching in {delay}s…",
                  file=sys.stderr, flush=True)
        else:
            print(f"The background service does not list {node} ({attached['id']}) yet; retrying in {delay}s…", file=sys.stderr, flush=True)
        if row is not None or ended != "detached":
            ended = None  # A detach stays undecided until a row shows whether the PID changed.
        sleep(delay)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["attach-one"])
    parser.add_argument("directory", type=Path)
    parser.add_argument("--node", help="attach-one: a worker lane of the run, or a reviewer node (review, or review-<id>)")
    args = parser.parse_args()
    directory = args.directory.resolve()
    # Every `claude` this process starts (the listing, `claude attach`) inherits the auto-updater off.
    os.environ.update(claude_env())
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
