"""LangGraph-owned Claude processes. Herdr never launches these processes.

Execution receipts are internal state, NOT verified WorkerResult evidence. Interrupted
or failed launches require operator reconciliation; this module never retries them.
"""
from __future__ import annotations

import fcntl
import hashlib
import json
import os
import signal
import subprocess
import threading
import uuid
from contextlib import contextmanager
from pathlib import Path

NODES = ("ui", "adapter")
REVIEWER = "reviewer"
TERMINAL = {"succeeded", "failed", "blocked"}


def file_prefix(node: str) -> str:
    """Worker files are named after the worker; the reviewer's after its graph node."""
    return "review" if node == REVIEWER else node


def read_json(path: Path) -> dict:
    return json.loads(path.read_text())


def save_json(path: Path, value: dict) -> None:
    temporary = path.with_name(f".{path.name}.{uuid.uuid4()}.tmp")
    with temporary.open("x") as handle:
        os.chmod(temporary, 0o600)
        json.dump(value, handle, indent=2)
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)
    descriptor = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


@contextmanager
def run_lock(directory: Path, lock_name: str = "controller.lock"):
    """Only the controller takes this lock. Observers need no lock or write access."""
    with (directory / lock_name).open("a") as handle:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise RuntimeError("Another controller owns this run") from error
        try:
            yield
        finally:
            fcntl.flock(handle, fcntl.LOCK_UN)


def git(repo: Path, *arguments: str) -> str:
    return subprocess.check_output(["git", "-C", str(repo), *arguments], text=True).strip()


def prepare(directory: Path, repo: Path, base: str, tasks: dict[str, str], allow_edits: bool) -> dict:
    if set(tasks) != set(NODES) or any(not text.strip() for text in tasks.values()):
        raise ValueError("Exactly two nonempty tasks are required: ui and adapter")
    repo = repo.resolve()
    if git(repo, "status", "--porcelain"):
        raise ValueError("Commit or preserve source changes before creating worker worktrees")
    revision = git(repo, "rev-parse", "--verify", f"{base}^{{commit}}")
    # Require the pinned revision to include the shared contract.
    git(repo, "cat-file", "-e", f"{revision}:contracts/workflow/workerResult.schema.json")
    directory = directory.resolve()
    if directory == repo or repo in directory.parents:
        raise ValueError("Run data/worktrees must be outside the source repository")
    directory.mkdir(parents=True, mode=0o700, exist_ok=False)
    os.chmod(directory, 0o700)
    plan = {"run_id": directory.name, "repository": str(repo), "base_commit": revision,
            "allow_edits": allow_edits, "nodes": {}}
    # Journal before allocation. Partial worktrees are retained on failure.
    save_json(directory / "plan.json", plan)
    for node in NODES:
        worktree = directory / f"worktree-{node}"
        plan["nodes"][node] = {"worktree": str(worktree), "task": tasks[node],
                               "session_id": str(uuid.uuid4()), "observed_start_commit": None}
        save_json(directory / "plan.json", plan)
        subprocess.run(["git", "-C", str(repo), "worktree", "add", "--detach", str(worktree), revision], check=True, capture_output=True)
        observed = git(worktree, "rev-parse", "HEAD")
        if observed != revision or git(worktree, "status", "--porcelain"):
            raise RuntimeError(f"Unclean or mismatched initial worktree: {worktree}")
        plan["nodes"][node]["observed_start_commit"] = observed
        save_json(directory / "plan.json", plan)
    return plan


def plan_digest(plan: dict) -> str:
    return hashlib.sha256(json.dumps(plan, sort_keys=True).encode()).hexdigest()


def terminate(process: subprocess.Popen) -> None:
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        process.wait()


class ClaudeSessions:
    def __init__(self, directory: Path, executable: str = "claude", timeout: float = 1800):
        self.directory = directory.resolve()
        self.plan = read_json(self.directory / "plan.json")
        if set(self.plan["nodes"]) != set(NODES):
            raise RuntimeError("Run preparation is incomplete; inspect retained allocation state")
        for node in NODES:
            info = self.plan["nodes"][node]
            if Path(info["worktree"]).resolve() != self.directory / f"worktree-{node}" or info["observed_start_commit"] != self.plan["base_commit"]:
                raise RuntimeError("Invalid worktree identity/start revision in plan")
        self.executable = executable
        self.timeout = timeout
        self.cancelled = threading.Event()

    def run(self, node: str) -> dict:
        if node not in NODES:
            raise ValueError("Unknown worker")
        if self.cancelled.is_set():
            raise RuntimeError("Controller cancelled before launch")
        info = self.plan["nodes"][node]
        path = self.directory / f"{node}.json"
        digest = plan_digest(self.plan)
        if path.exists():
            previous = read_json(path)
            if previous["plan_digest"] != digest:
                raise RuntimeError("Run plan changed; refuse result reuse/relaunch")
            if previous["status"] == "succeeded":
                return previous
            raise RuntimeError(f"{node}: existing {previous['status']} session {previous['session_id']}; reconcile before any relaunch")
        cwd = Path(info["worktree"])
        record = {"node_id": node, "session_id": info["session_id"], "attempt": 1,
                  "status": "launching", "pid": None, "plan_digest": digest,
                  "worktree": str(cwd), "base_commit": self.plan["base_commit"]}
        save_json(path, record)  # A crash from here onward must never cause blind relaunch.
        tools = "Read,Glob,Grep,Edit,Write" if self.plan["allow_edits"] else "Read,Glob,Grep"
        command = [self.executable, "--print", "--verbose", "--output-format", "stream-json",
                   "--session-id", info["session_id"], "--safe-mode", "--strict-mcp-config",
                   "--mcp-config", '{"mcpServers":{}}', "--tools", tools,
                   "--permission-mode", "acceptEdits" if self.plan["allow_edits"] else "dontAsk",
                   "--permission-prompts", "none"]
        prompt = ("You are an independent workflow worker. Do not launch other agents, modify shared contract files, "
                  "commit, merge, push or change files outside your assigned worktree. "
                  "Report changed files, checks actually executed, and open assumptions. "
                  "No command execution tools are enabled in this initial session slice.\n\n" + info["task"])
        # Do not let detached workers target the controller's Herdr pane through hooks.
        env = {key: value for key, value in os.environ.items() if not key.startswith("HERDR_")}
        env["TMPDIR"] = str(self.directory / f"tmp-{node}")
        Path(env["TMPDIR"]).mkdir(exist_ok=True)
        process = None
        try:
            if git(cwd, "rev-parse", "HEAD") != self.plan["base_commit"] or git(cwd, "status", "--porcelain"):
                raise RuntimeError(f"{node}: worktree changed since preparation")
            prompt_path = self.directory / f"{node}.prompt.txt"
            prompt_path.write_text(prompt)
            os.chmod(prompt_path, 0o600)
            # A regular stdin file avoids blocking the controller on a full pipe.
            with prompt_path.open("rb") as input_handle, (self.directory / f"{node}.stream.jsonl").open("wb") as output:
                process = subprocess.Popen(command, cwd=cwd, env=env, stdin=input_handle,
                                           stdout=output, stderr=subprocess.STDOUT, start_new_session=True)
                record.update(status="running", pid=process.pid)
                save_json(path, record)
                import time
                deadline = time.monotonic() + self.timeout
                while process.poll() is None:
                    if self.cancelled.wait(0.1) or time.monotonic() > deadline:
                        terminate(process)
                        raise RuntimeError("Controller cancelled or session timed out; partial work preserved")
                output.flush()
                os.fsync(output.fileno())
            terminal = None
            with (self.directory / f"{node}.stream.jsonl").open(errors="replace") as output:
                for line in output:
                    try:
                        message = json.loads(line)
                    except ValueError:
                        continue
                    if isinstance(message, dict) and message.get("type") == "result":
                        terminal = message
            record["exit_code"] = process.returncode
            if not terminal or terminal.get("session_id") != info["session_id"]:
                raise RuntimeError("Missing or mismatched Claude terminal result; reconciliation required")
            record["claude_result"] = terminal
            if process.returncode != 0 or terminal.get("is_error") is not False or terminal.get("subtype") != "success":
                raise RuntimeError("Claude did not succeed; inspect retained result for usage, permission or execution failure. No automatic retry/provider switch.")
            record["status"] = "succeeded"
        except BaseException as error:
            if process is not None and process.poll() is None:
                terminate(process)
            record.update(status="blocked", error=str(error))
            raise
        finally:
            # Preserve work and a diff even after failure; untracked files remain in the worktree.
            try:
                record["git_status"] = git(cwd, "status", "--porcelain")
                with (self.directory / f"{node}.patch").open("w") as patch:
                    subprocess.run(["git", "-C", str(cwd), "diff", "--binary", self.plan["base_commit"]], stdout=patch, check=True)
            except Exception as error:
                record["evidence_error"] = str(error)
                record["status"] = "blocked"
            save_json(path, record)
        if record["status"] != "succeeded":
            raise RuntimeError("Session evidence capture failed")
        return record
