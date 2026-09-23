"""LangGraph-owned Claude processes. Herdr never launches these processes.

Execution receipts are internal state, NOT verified WorkerResult evidence. Interrupted
or failed launches require operator reconciliation; this module never retries them.
"""
from __future__ import annotations

import errno
import fcntl
import hashlib
import json
import os
import re
import signal
import subprocess
import threading
import time
import uuid
from contextlib import contextmanager
from pathlib import Path

from .worktrees import git_worktree

TERMINAL = {"succeeded", "failed", "blocked"}

# Worker lanes come from configuration (policy 1.2.0, feature file 2.0.0). A lane id names the
# per-lane graph nodes (launch_<id>, verify_<id>), files (<id>.completion.json, ...) and the
# finding attribution vocabulary, so it can never collide with a fixed graph node, an
# attribution or a per-lane prefix. The design challenge (feature file 2.2.0) owns the node `challenge` and the
# run files `challenge.json`, `challenge-<n>.*`, `challenge-inputs/` and `challenge-worktree/`.
NODE_ID_PATTERN = re.compile(r"^[a-z][a-z0-9-]{0,31}$")
RESERVED_NODE_IDS = frozenset({"review", "candidate", "handoff", "approval", "integrate", "multiple", "none", "both", "challenge"})
RESERVED_NODE_PREFIXES = ("launch_", "verify_", "candidate_", "review-", "challenge-")
# Plans pinned before lanes were configurable (every existing run) launched exactly these two.
LEGACY_WORKERS = ("ui", "adapter")


def validate_node_id(node) -> str:
    if not isinstance(node, str) or not NODE_ID_PATTERN.fullmatch(node):
        raise ValueError(f"Worker lane id must match {NODE_ID_PATTERN.pattern}: {node!r}")
    if node in RESERVED_NODE_IDS or node.startswith(RESERVED_NODE_PREFIXES):
        raise ValueError(f"Worker lane id is reserved: {node}")
    return node


# Reviewers come from configuration too (feature file 2.1.0 `reviewers`). A plan without `reviewers` runs
# the single default reviewer, whose id is the fixed review node itself: its files keep the unprefixed
# names (`review.completion.json`, ...). A declared reviewer `<id>` owns the node `review-<id>` and the
# files `review-<id>.*`, so its id follows the lane rules and can never be a lane id or a reserved name.
DEFAULT_REVIEWER = "review"


def validate_reviewer_id(value, lanes: list[str] | None = None) -> str:
    if not isinstance(value, str) or not NODE_ID_PATTERN.fullmatch(value):
        raise ValueError(f"Reviewer id must match {NODE_ID_PATTERN.pattern}: {value!r}")
    if value in RESERVED_NODE_IDS or value.startswith(RESERVED_NODE_PREFIXES):
        raise ValueError(f"Reviewer id is reserved: {value}")
    if lanes and value in lanes:
        raise ValueError(f"Reviewer id {value} is a worker lane of this run")
    return value


def review_node(reviewer_id: str) -> str:
    """The completion-file node id and file prefix of a reviewer: `review` for the default, `review-<id>` otherwise."""
    return DEFAULT_REVIEWER if reviewer_id == DEFAULT_REVIEWER else f"review-{reviewer_id}"


def plan_reviewers(plan: dict) -> list[dict]:
    """The reviewers a run launches, in declared order: `{reviewer_id, prompt}` with `prompt` None for the built-in brief."""
    reviewers = plan.get("reviewers")
    if reviewers is None:
        return [{"reviewer_id": DEFAULT_REVIEWER, "prompt": None}]
    if not isinstance(reviewers, list) or not reviewers:
        raise ValueError("Plan reviewers must be a non-empty list")
    lanes = [*plan_workers(plan), *plan.get("excluded_workers", [])]
    result = []
    for item in reviewers:
        if not isinstance(item, dict) or set(item) != {"reviewer_id", "prompt"} or not isinstance(item["prompt"], str) or not item["prompt"].strip():
            raise ValueError("Plan reviewers need reviewer_id and a non-empty prompt")
        validate_reviewer_id(item["reviewer_id"], lanes)
        result.append({"reviewer_id": item["reviewer_id"], "prompt": item["prompt"]})
    ids = [item["reviewer_id"] for item in result]
    if len(set(ids)) != len(ids):
        raise ValueError("Plan reviewers must be distinct")
    return result


def reviewer_ids(plan: dict) -> list[str]:
    return [item["reviewer_id"] for item in plan_reviewers(plan)]


def review_nodes(plan: dict) -> list[str]:
    return [review_node(reviewer_id) for reviewer_id in reviewer_ids(plan)]


def reviewer_of_node(plan: dict, node: str) -> str | None:
    """The reviewer id behind a review node of this plan, or None when the node is not one of its reviewers."""
    return next((reviewer_id for reviewer_id in reviewer_ids(plan) if review_node(reviewer_id) == node), None)


def plan_workers(plan: dict) -> list[str]:
    """The lanes a run launches, in declared order. Plans without `workers` mean the legacy pair."""
    workers = plan.get("workers")
    if workers is None:
        return list(LEGACY_WORKERS)
    if not isinstance(workers, list) or not workers or len(set(workers)) != len(workers):
        raise ValueError("Plan workers must be a non-empty list of distinct lane ids")
    return [validate_node_id(node) for node in workers]


def plan_excluded(plan: dict) -> list[str]:
    """Declared lanes the launch left out; their owned paths stay off-limits."""
    excluded = plan.get("excluded_workers", [])
    if not isinstance(excluded, list) or len(set(excluded)) != len(excluded) or set(excluded) & set(plan_workers(plan)):
        raise ValueError("Plan excluded_workers must be distinct lane ids that are not selected")
    return [validate_node_id(node) for node in excluded]


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


def prepare(directory: Path, repo: Path, base: str, tasks: dict[str, str], allow_edits: bool,
            declared: list[str] | None = None) -> dict:
    """Allocate one worktree per selected lane.

    `tasks` maps each selected lane id to its task text. `declared` is the policy's full lane
    list in declared order; the selection is pinned in that order and the remaining lanes are
    pinned as `excluded_workers`. Without `declared`, the mapping's own order is the declared order.
    """
    if not isinstance(tasks, dict) or not tasks:
        raise ValueError("At least one worker lane with a nonempty task is required")
    for node, text in tasks.items():
        validate_node_id(node)
        if not isinstance(text, str) or not text.strip():
            raise ValueError(f"Worker lane {node} needs a nonempty task")
    if declared is None:
        declared = list(tasks)
    if len(set(declared)) != len(declared):
        raise ValueError("Declared worker lanes must be distinct")
    unknown = sorted(set(tasks) - set(declared))
    if unknown:
        raise ValueError(f"Worker lanes not declared in the pinned policy: {', '.join(unknown)}")
    workers = [node for node in declared if node in tasks]
    excluded = [node for node in declared if node not in tasks]
    repo = repo.resolve()
    if git(repo, "status", "--porcelain"):
        raise ValueError("Commit or preserve source changes before creating worker worktrees")
    # The target needs no copy of the contracts: the controller validates against the schemas bundled
    # with the tool (workflow.verification.CONTRACTS), so any repository with a commit can be pinned.
    revision = git(repo, "rev-parse", "--verify", f"{base}^{{commit}}")
    directory = directory.resolve()
    if directory == repo or repo in directory.parents:
        raise ValueError("Run data/worktrees must be outside the source repository")
    directory.mkdir(parents=True, mode=0o700, exist_ok=False)
    os.chmod(directory, 0o700)
    plan = {"run_id": directory.name, "repository": str(repo), "base_commit": revision,
            "allow_edits": allow_edits, "workers": workers, "excluded_workers": excluded, "nodes": {}}
    # Journal before allocation. Partial worktrees are retained on failure.
    save_json(directory / "plan.json", plan)
    for node in workers:
        worktree = directory / f"worktree-{node}"
        plan["nodes"][node] = {"worktree": str(worktree), "task": tasks[node],
                               "session_id": str(uuid.uuid4()), "observed_start_commit": None}
        save_json(directory / "plan.json", plan)
        git_worktree(repo, "add", "--detach", str(worktree), revision)
        observed = git(worktree, "rev-parse", "HEAD")
        if observed != revision or git(worktree, "status", "--porcelain"):
            raise RuntimeError(f"Unclean or mismatched initial worktree: {worktree}")
        plan["nodes"][node]["observed_start_commit"] = observed
        save_json(directory / "plan.json", plan)
    return plan


def plan_digest(plan: dict) -> str:
    return hashlib.sha256(json.dumps(plan, sort_keys=True).encode()).hexdigest()


CLAUDE_MISSING_GRACE_SECONDS = 60
UPDATE_ERRNOS = {errno.ENOENT, errno.ENOEXEC, errno.ETXTBSY}


def run_claude(command: list[str], *, grace: float = CLAUDE_MISSING_GRACE_SECONDS, sleep=time.sleep, **kwargs) -> subprocess.CompletedProcess:
    """`subprocess.run` for a `claude` command that waits out a Claude Code update in progress.

    An update replaces the installed binary: for a moment the command is missing (ENOENT), half written
    (ENOEXEC) or busy (ETXTBSY), and the call fails before anything runs. That is retried every 2 seconds for
    `grace` seconds, so an update during a run does not block it. `retry_output`, when given, also retries a
    command that ran but printed output it rejects (an empty inventory from a restarting background service).
    Any other failure is not retried.
    """
    retry_output = kwargs.pop("retry_output", None)
    waited = 0.0
    while True:
        try:
            result = subprocess.run(command, **kwargs)
            if retry_output is None or not retry_output(result) or waited >= grace:
                return result
        except OSError as error:
            if not (isinstance(error, FileNotFoundError) or error.errno in UPDATE_ERRNOS) or waited >= grace:
                raise
            sleep(2)
            waited += 2


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
        self.workers = plan_workers(self.plan)
        self.excluded = plan_excluded(self.plan)
        if set(self.plan["nodes"]) != set(self.workers):
            raise RuntimeError("Run preparation is incomplete; inspect retained allocation state")
        for node in self.workers:
            info = self.plan["nodes"][node]
            if Path(info["worktree"]).resolve() != self.directory / f"worktree-{node}" or info["observed_start_commit"] != self.plan["base_commit"]:
                raise RuntimeError("Invalid worktree identity/start revision in plan")
        self.executable = executable
        self.timeout = timeout
        self.cancelled = threading.Event()

    def run(self, node: str) -> dict:
        if node not in self.workers:
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
