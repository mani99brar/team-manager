"""Complete operator-driven graph: launch → freeze → verify → review → approve → integrate.

No agent starts without `start --live`. Operator controls are local CLI-only.

The worker lanes come from the run's plan (`plan.workers`, pinned at prepare from the policy
and an optional `--workers` selection): one `launch_<lane>` and one `verify_<lane>` node per
selected lane around the fixed tail. Excluded lanes keep their owned paths off-limits.
"""
from __future__ import annotations

import argparse
import fcntl
import hashlib
import html
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Annotated, TypedDict

from langgraph.checkpoint.sqlite import SqliteSaver
from langgraph.graph import END, START, StateGraph
from langgraph.types import Command, interrupt

from .actor import BY_OPERATOR, actor_text, add_actor_argument, require_actor
from .attention import attention
from .checks import now, recheck_packet, reuse_packet, verify_revision
from .export_state import export_state
from .outcome import outcome_block
from .interactive import REVIEW, InteractiveSessions, SessionGap, UpdateGaps, attach_panels, attach_reviewer_panel
from .sessions import (DEFAULT_REVIEWER, EFFORT_LEVELS, TransientInfraError, controller_record, git, override_note, pin_roles, plan_excluded, run_claude, plan_workers,
                       prepare, read_json, review_node, reviewer_ids, run_lock, save_json, stale_claude_warning, validate_node_id, validate_reviewer_id,
                       worker_authority, worker_effort)
from .verification import owns, policy_digest, safe_path, slow_checks, validate_policy
from .worktrees import SHARED_GIT_CHANGED, controller_git_config, git_worktree, shared_git_changes, shared_git_state

# The gate actions of this CLI: each requires --by (actor.require_actor) and records who ran it in one `controller` event.
GATE_ACTIONS = frozenset({"start", "automatic", "retry", "reconcile", "approve"})
REVIEW_KEYS = frozenset({"run_id", "bundle_sha256", "candidate_commit", "reviewer", "independent", "verdict", "findings"})
# The combined record of a run with declared reviewers lists them; reviews recorded before parallel reviewers have no list.
REVIEWER_ENTRY_KEYS = frozenset({"reviewer_id", "session_id", "verdict", "accepted_at"})
FINDING_KEYS = frozenset({"severity", "message", "disposition"})
FINDING_LINK_KEYS = frozenset({"worker", "requirement", "reviewer"})
# A finding names one lane of the run, several (`multiple`) or none. `both` is the legacy spelling of
# `multiple` from two-lane runs; only reviews recorded before configured lanes may still carry it.
FINDING_ATTRIBUTIONS = frozenset({"multiple", "none"})
LEGACY_FINDING_ATTRIBUTIONS = FINDING_ATTRIBUTIONS | {"both"}


def validate_pipeline_policy(policy: dict) -> dict:
    """The policy's own rules (schema, ownership, required check kinds) plus the lane-id rules the graph needs."""
    validate_policy(policy)
    for worker in policy["workers"]:
        validate_node_id(worker["node_id"])
    return policy


def policy_workers(policy: dict) -> list[str]:
    return [worker["node_id"] for worker in policy["workers"]]


def parse_lane_selection(value: str | None, declared: list[str]) -> list[str]:
    """`--workers a,b`: a non-empty subset of the declared lanes, without duplicates, in declared order."""
    if value is None:
        return list(declared)
    selected = [item.strip() for item in value.split(",")]
    if not selected or any(not item for item in selected):
        raise ValueError("--workers needs a comma-separated list of lane ids")
    if len(set(selected)) != len(selected):
        raise ValueError(f"--workers lists a lane twice: {value}")
    unknown = [item for item in selected if item not in declared]
    if unknown:
        raise ValueError(f"--workers names lanes the policy does not declare: {', '.join(unknown)} (declared: {', '.join(declared)})")
    return [node for node in declared if node in selected]


def parse_lane_files(values: list[str] | None, flag: str) -> dict[str, Path]:
    """`--task id=path` / `--handoff id=path`, once per lane."""
    result = {}
    for item in values or []:
        node, separator, path = item.partition("=")
        if not separator or not node or not path:
            raise ValueError(f"{flag} expects <lane>=<path>, got {item!r}")
        validate_node_id(node)
        if node in result:
            raise ValueError(f"{flag} given twice for lane {node}")
        result[node] = Path(path)
    return result


def parse_reviewer_files(values: list[str] | None, lanes: list[str]) -> list[dict]:
    """`--reviewer id=path` at prepare: each declared reviewer with its brief text, pinned into the plan in the given order."""
    reviewers = []
    for item in values or []:
        reviewer_id, separator, path = item.partition("=")
        if not separator or not reviewer_id or not path:
            raise ValueError(f"--reviewer expects <id>=<path>, got {item!r}")
        validate_reviewer_id(reviewer_id, lanes)
        if any(existing["reviewer_id"] == reviewer_id for existing in reviewers):
            raise ValueError(f"--reviewer given twice for {reviewer_id}")
        text = Path(path).read_text()
        if not text.strip():
            raise ValueError(f"Reviewer brief for {reviewer_id} is empty: {path}")
        reviewers.append({"reviewer_id": reviewer_id, "prompt": text})
    return reviewers


def blocking_findings(findings: list) -> list:
    """A P0/P1 finding blocks integration unless it is resolved; accepting it is not resolving it."""
    return [finding for finding in findings if finding.get("severity") in {"P0", "P1"} and finding.get("disposition") != "resolved"]


def check_reviewers(entries, worker_ids: set, declared: list[str] | None, verdict: str, require_approved: bool) -> list[str]:
    """The combined record's `reviewers` list: declared order, distinct independent identities, unanimous approval when approved."""
    if not isinstance(entries, list) or not entries:
        raise ValueError("Review reviewers must be a non-empty list")
    ids, sessions = [], []
    for entry in entries:
        if (not isinstance(entry, dict) or set(entry) != REVIEWER_ENTRY_KEYS or not isinstance(entry["reviewer_id"], str) or not entry["reviewer_id"].strip()
                or entry["verdict"] not in {"approved", "blocked", None} or (entry["accepted_at"] is not None and not isinstance(entry["accepted_at"], str))):
            raise ValueError("Malformed review reviewers entry")
        session = entry["session_id"]
        if session is not None and (not isinstance(session, str) or not session.strip() or session in worker_ids or session in sessions):
            raise ValueError(f"Independent reviewer identity required for reviewer {entry['reviewer_id']}")
        if session is not None:
            sessions.append(session)
        ids.append(entry["reviewer_id"])
    if len(set(ids)) != len(ids):
        raise ValueError("Review reviewers must be distinct")
    if declared is not None and ids != list(declared):
        raise ValueError(f"Review reviewers ({', '.join(ids)}) are not this run's declared reviewers ({', '.join(declared)})")
    if verdict == "approved" and any(entry["verdict"] != "approved" for entry in entries):
        raise ValueError("An approved review requires every reviewer's approval")
    if require_approved and any(entry["verdict"] != "approved" for entry in entries):
        raise ValueError("Review is not approved by every reviewer")
    return ids


def check_review(review: dict, bundle: dict, digest: str, *, require_approved: bool = True, allow_legacy: bool = False,
                 reviewers: list[str] | None = None) -> None:
    """Shape and identity of a persisted review against its exact bundle; approval is checked only when required.

    `allow_legacy` accepts the two-lane `both` attribution of reviews recorded before configured lanes (export only).
    `reviewers` is the run's declared reviewer list: the record must then list exactly those reviewers and tag every
    finding with one of them. Without it (export), a record without `reviewers` is the single-reviewer shape.
    """
    if (not isinstance(review, dict) or not REVIEW_KEYS <= set(review) <= REVIEW_KEYS | {"reviewers"} or review["run_id"] != bundle["run_id"]
            or review["bundle_sha256"] != digest or review["candidate_commit"] != bundle["candidate_commit"]):
        raise ValueError("Review must reference this exact run, bundle hash and candidate")
    worker_ids = {item["session_id"] for item in bundle["snapshots"].values()}
    if review["independent"] is not True or not isinstance(review["reviewer"], str) or not review["reviewer"].strip() or review["reviewer"] in worker_ids:
        raise ValueError("Independent reviewer identity required")
    if review["verdict"] not in {"approved", "blocked"} or not isinstance(review["findings"], list):
        raise ValueError("Malformed review verdict or findings")
    if require_approved and review["verdict"] != "approved":
        raise ValueError("Review is not approved")
    ids = None
    if "reviewers" in review:
        ids = check_reviewers(review["reviewers"], worker_ids, reviewers, review["verdict"], require_approved)
    elif reviewers is not None and list(reviewers) != [DEFAULT_REVIEWER]:
        raise ValueError(f"Review lacks the reviewers list this run requires ({', '.join(reviewers)})")
    # The bundle's snapshots are exactly the run's selected lanes.
    workers = set(bundle["snapshots"]) | (LEGACY_FINDING_ATTRIBUTIONS if allow_legacy else FINDING_ATTRIBUTIONS)
    for finding in review["findings"]:
        if (not isinstance(finding, dict) or not FINDING_KEYS <= set(finding) <= FINDING_KEYS | FINDING_LINK_KEYS
                or finding["severity"] not in {"P0", "P1", "P2"} or finding["disposition"] not in {"open", "resolved", "accepted"}
                or not isinstance(finding["message"], str) or not finding["message"].strip()):
            raise ValueError("Malformed review finding")
        if "worker" in finding and finding["worker"] not in workers:
            raise ValueError(f"Malformed review finding worker: expected one of {', '.join(sorted(workers))}, got {finding['worker']!r}")
        requirement = finding.get("requirement")
        if requirement is not None and (not isinstance(requirement, str) or not requirement.strip()):
            raise ValueError("Malformed review finding requirement")
        if ids is not None:
            if finding.get("reviewer") not in ids:
                raise ValueError(f"Review finding names reviewer {finding.get('reviewer')!r}; expected one of {', '.join(ids)}")
        elif "reviewer" in finding and (not isinstance(finding["reviewer"], str) or not finding["reviewer"].strip()):
            raise ValueError("Malformed review finding reviewer")
        if review["verdict"] == "approved" and blocking_findings([finding]):
            raise ValueError("Unresolved blocking review finding")


def combine_imported_reviews(bundle: dict, digest: str, imports: dict) -> dict:
    """Manual mode: one imported single-reviewer file per declared reviewer becomes the combined review.json record."""
    entries, findings = [], []
    for reviewer_id, item in imports.items():
        review = item["review"]
        entries.append({"reviewer_id": reviewer_id, "session_id": review["reviewer"], "verdict": review["verdict"], "accepted_at": item["imported_at"]})
        findings.extend({**finding, "reviewer": reviewer_id} for finding in review["findings"])
    blocked = any(item["review"]["verdict"] != "approved" or blocking_findings(item["review"]["findings"]) for item in imports.values())
    return {"run_id": bundle["run_id"], "bundle_sha256": digest, "candidate_commit": bundle["candidate_commit"],
            "reviewer": ", ".join(entry["session_id"] for entry in entries), "independent": True,
            "verdict": "blocked" if blocked else "approved", "findings": findings, "reviewers": entries}


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


def deferred_exits(packet: dict) -> list[str]:
    """Each check the worker gate recorded for the candidate gate, with the exit code its run ended with: `build (exit 1)`."""
    executions = packet["result"]["checks"]
    indexes = {receipt["id"]: receipt["worker_check_index"] for receipt in packet["evidence"]["checks"]}
    named = []
    for check_id in packet["gate"].get("deferred_checks", []):
        index = indexes.get(check_id)
        code = executions[index]["exit_code"] if index is not None and 0 <= index < len(executions) else None
        named.append(check_id if code is None else f"{check_id} (exit {code})")
    return named


def failed_before(directory: Path, phase: str, node: str, attempt: int, commit: str) -> bool:
    """Attempt `attempt - 1` of this lane's check in `phase` recorded a blocked gate on the same revision. A lane repair's
    new revision starts over, and an attempt that recorded no packet (an interrupted check) failed nothing."""
    previous = directory / "verification" / phase / node / str(attempt - 1) / "packet.json"
    if attempt < 2 or not previous.exists():
        return False
    try:
        packet = read_json(previous)
    except ValueError:
        return False
    return packet.get("expected", {}).get("output_commit") == commit and packet.get("gate", {}).get("status") == "blocked"


def passed_message(packet: dict, retried: int | None = None) -> str:
    """The verify event of a passing worker gate. It names each check recorded for the candidate gate with its exit code,
    and a pass on attempt `retried` after the attempt before failed on the same revision. The viewer reads the
    `Required tests and artifacts passed; recorded for the candidate gate: ` prefix, so the retry follows the checks."""
    deferred = deferred_exits(packet)
    retry = f"passed on attempt {retried} after attempt {retried - 1} failed" if retried else None
    if not deferred:
        return f"Required tests and artifacts {retry}" if retry else "Required tests and artifacts passed"
    return "Required tests and artifacts passed; recorded for the candidate gate: " + ", ".join(deferred) + (f"; {retry}" if retry else "")


def append_event(directory: Path, node: str, status: str, message: str) -> None:
    """One events.jsonl line, numbered after the last one: Pipeline.event, and the commands that need no Pipeline (`answer`, `note`).

    `answer` and `note` append from their own processes beside a running controller, so events.lock is held from the read
    of the last sequence to the append: two lines never share a sequence, which the viewer refuses (readEvents)."""
    path = directory / "events.jsonl"
    with (directory / "events.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            prior = path.read_text().splitlines() if path.exists() else []
            sequence = json.loads(prior[-1])["sequence"] + 1 if prior else 1
            record = {"sequence": sequence, "time": now(), "node": node, "status": status, "message": message}
            with path.open("a") as handle:
                handle.write(json.dumps(record) + "\n")
                handle.flush()
                os.fsync(handle.fileno())
        finally:
            fcntl.flock(lock, fcntl.LOCK_UN)


def action_event(event, actor: str, action: str, detail: str = "") -> None:
    """`<Action> by the operator|maintainer[ (via a Claude Code session)][: detail]` through `event` (Pipeline.event, or a
    writer of the same shape): a `controller` row with the plain record status `note`, which the server serves with no
    status, so the viewer reads it as a log line. Never `running`: the server would take it for the controller's last
    state, and an `automatic --live` that wrote its row and then stopped (a held run lock, a changed policy, a kill) would
    show a paused run running while nothing runs."""
    event("controller", "note", f"{action.capitalize()} by {actor_text(actor)}" + (f": {detail}" if detail else ""))


CANDIDATE_REF = "candidate"


def run_ref(directory: Path, name: str) -> str:
    """`refs/workflow/<run hash>/<name>`: a lane's snapshot (freeze) or the run's candidate (`candidate`), so each stays
    reachable after the run's worktrees are cleaned up; `brief` restores from them."""
    return f"refs/workflow/{hashlib.sha256(str(Path(directory).resolve()).encode()).hexdigest()[:16]}/{name}"


def merge_lanes(left: dict | None, right: dict | None) -> dict:
    """Parallel lane nodes each write their own key; the channel keeps every lane."""
    return {**(left or {}), **(right or {})}


class PipelineState(TypedDict, total=False):
    run_id: str
    lanes: Annotated[dict, merge_lanes]      # launch receipts by lane id
    snapshots: dict
    packets: Annotated[dict, merge_lanes]    # worker verification packet paths by lane id
    bundle: str
    review: dict
    approved_bundle: str
    integrated_commit: str


def lane_positions(workers: list[str]) -> tuple[dict, list, int, int]:
    """Report layout: one row per lane for the fan-outs, the fixed tail centred on them."""
    rows = [70 + 140 * index for index in range(len(workers))]
    centre = (rows[0] + rows[-1]) // 2
    positions = {}
    for node, y in zip(workers, rows):
        positions[f"launch_{node}"] = (90, y)
    positions["handoff"] = (280, centre)
    for node, y in zip(workers, rows):
        positions[f"verify_{node}"] = (470, y)
    positions.update(candidate=(660, centre), review=(850, centre), approval=(1040, centre), integrate=(1230, centre))
    edges = [(f"launch_{node}", "handoff") for node in workers] + [("handoff", f"verify_{node}") for node in workers] \
        + [(f"verify_{node}", "candidate") for node in workers] + [("candidate", "review"), ("review", "approval"), ("approval", "integrate")]
    return positions, edges, 1330, rows[-1] + 70


class Pipeline:
    def __init__(self, directory: Path, sessions=None, abandoned_ok: bool = False):
        """`abandoned_ok` is `abandon`'s own: every other command that builds a Pipeline changes the run, so an abandoned run is
        refused here (status, export and brief never build one)."""
        self.directory = directory.resolve()
        if not abandoned_ok:
            from .abandon import refuse_abandoned
            refuse_abandoned(self.directory)
        self.plan = read_json(self.directory / "plan.json")
        if "automatic" in self.plan:
            from .automatic import validate_automatic
            validate_automatic(self.plan)
        self.policy = validate_pipeline_policy(read_json(self.directory / "policy.json"))
        if self.plan.get("policy_sha256") != policy_digest(self.policy):
            raise ValueError("Pinned policy changed")
        from .sidecar import validate_plan
        validate_plan(self.plan)
        self.workers, self.excluded = lanes_of(self.plan, self.policy)
        self.sessions = sessions or InteractiveSessions(self.directory, timeout=45)
        self._events_lock = threading.Lock()

    def worker_policy(self, node: str) -> dict:
        return next(item for item in self.policy["workers"] if item["node_id"] == node)

    def failure_drill(self) -> dict | None:
        """The pinned drill: null when prepare skipped it for an excluded lane; the policy's for plans pinned before."""
        return self.plan["failure_drill"] if "failure_drill" in self.plan else self.policy.get("failure_drill")

    def event(self, node: str, status: str, message: str):
        with self._events_lock:
            append_event(self.directory, node, status, message)

    def launch(self, node: str) -> dict:
        self.event(node, "running", "Launching or reconciling the exact native session")
        try:
            receipt = self.sessions.run(node)
        except Exception as error:
            self.event(node, "blocked", str(error))
            raise
        self.event(node, "interactive", "Awaiting explicit completion signal; idle is not acceptance")
        return receipt

    def launch_reviewer(self, reviewer_id: str, prompt: str, launch_token: str, candidate_commit: str) -> dict:
        node = review_node(reviewer_id)
        self.event(REVIEW, "running", f"Launching the native reviewer session {reviewer_id}")
        try:
            receipt = self.sessions.run_reviewer(reviewer_id, prompt, launch_token, candidate_commit)
        except Exception as error:
            self.event(REVIEW, "blocked", f"Reviewer {reviewer_id}: {error}")
            raise
        self.event(REVIEW, "interactive", f"Reviewer {reviewer_id} session {receipt['session_id']} launched; awaiting {node}.completion.json")
        if (self.directory / "terminals.json").exists() and os.environ.get("HERDR_ENV") == "1":
            # The pane is a convenience for the operator; its absence never fails the review. The
            # session is launched by now, so a Ctrl-C here is recorded, then propagated as an
            # interruption (the review node keeps the running session), never as a launch failure.
            try:
                attach_reviewer_panel(self.sessions)
                self.event(REVIEW, "running", f"Reviewer {reviewer_id} pane attached")
            except BaseException as error:
                self.event(REVIEW, "running", f"Reviewer {reviewer_id} pane not attached: {str(error) or type(error).__name__}")
                if not isinstance(error, Exception):
                    raise
        return receipt

    def reconcile_reviewer(self, reviewer_id: str = DEFAULT_REVIEWER) -> dict:
        """Bind the session an interrupted reviewer launch produced; nothing is launched."""
        node = review_node(reviewer_id)
        path = self.directory / f"{node}.interactive.json"
        if not path.exists():
            raise RuntimeError(f"No durable launch intent for reviewer {reviewer_id}; cannot reconcile without potentially launching a new reviewer")
        self.event(REVIEW, "running", f"Reconciling the interrupted launch of reviewer {reviewer_id}; nothing is relaunched")
        try:
            receipt = self.sessions.reconcile(node, path, read_json(path))
        except Exception as error:
            self.event(REVIEW, "blocked", f"Reviewer {reviewer_id}: {error}")
            raise
        self.event(REVIEW, "interactive", f"Reviewer {reviewer_id} session {receipt['session_id']} reconciled; awaiting {node}.completion.json")
        return receipt

    def stop_row(self, node: str, rows: list[dict]) -> dict | None:
        """locate for a stop, under the controller's rule for an update's respawn gap (UpdateGaps): a bound session the
        listing does not show live yet is listed again every 2 seconds for the grace, then TransientInfraError."""
        gaps = UpdateGaps(self.sessions, self.directory, time.monotonic)
        while True:
            try:
                return gaps.row(node, rows)
            except SessionGap:
                time.sleep(2)
                rows = self.sessions.inventory()

    def stop_session(self, node: str) -> None:
        """Persist native identity before stopping. Never signal guessed/reused PIDs."""
        marker = self.directory / f"{node}.stop.json"
        if marker.exists():
            intent = read_json(marker)
        else:
            row = self.stop_row(node, self.sessions.inventory())
            if row is None:
                raise RuntimeError(f"{node} session missing before stop; reconcile before continuing")
            intent = {"background_id": row["id"], "session_id": row["sessionId"], "pid": row["pid"], "stopped": False, "issued": False}
            save_json(marker, intent)
        if not intent["stopped"]:
            rows = self.sessions.inventory()
            matching = [row for row in rows if row.get("sessionId") == intent["session_id"] and row.get("pid")]
            # A session the listing leaves out (or lists without a PID) counts as stopped only once its stop was issued (an
            # intent recorded before `issued` existed counts as issued); a stop never issued looks through an update's respawn gap.
            if matching or intent.get("issued") is False:
                # Its session UUID listed under another background id is a changed identity, never a gap.
                row = self.stop_row(node, rows) if not matching or any(item.get("id") == intent["background_id"] for item in matching) else None
                if row is None or row["id"] != intent["background_id"] or row["sessionId"] != intent["session_id"]:
                    raise RuntimeError(f"Native {node} session identity changed after stop intent; reconcile manually")
                # The process this stop is for (an update respawns a session under a new PID, same background id and UUID),
                # and that the stop is issued, are recorded before it runs.
                intent.update(pid=row["pid"], issued=True)
                save_json(marker, intent)
                try:
                    result = run_claude([self.sessions.executable, "stop", intent["background_id"]], capture_output=True, text=True, timeout=20)
                    if result.returncode != 0:
                        raise RuntimeError(f"Stop failed for {node}; inspect native session before retrying")
                except Exception:
                    # Nothing confirms it: its exec failed (nothing ran), or it exited non-zero or hung past its timeout, as
                    # `claude` calls can while the background service restarts, which then respawns the session. It is still
                    # owed, so a retry looks through the respawn gap instead of trusting absence. A Ctrl-C while it runs
                    # leaves it issued, as a controller killed then does.
                    intent["issued"] = False
                    save_json(marker, intent)
                    raise
            # Recover stop-before-receipt without issuing another stop command.
            rows = self.sessions.inventory()
            if any(row.get("sessionId") == intent["session_id"] and row.get("pid") for row in rows) or pid_alive(intent["pid"]):
                raise RuntimeError(f"{node} termination is not established; retry after reconciliation")
            intent["stopped"] = True
            save_json(marker, intent)

    def stop_workers(self):
        """Stop every lane, continuing past failures, so no session keeps using quota for a run that cannot continue (the lane
        that blocked a wait is often one whose stop is refused); the unconfirmed ones are then raised together, by lane."""
        failures = {}
        for node in self.workers:
            try:
                self.stop_session(node)
            except Exception as error:
                failures[node] = error
        if failures:
            # Claude Code unavailable for each of them keeps a freeze resumable; any other refusal decides the run.
            transient = all(isinstance(error, TransientInfraError) for error in failures.values())
            raise (TransientInfraError if transient else RuntimeError)("; ".join(f"{node}: {error}" for node, error in failures.items()))
        stopped_ids = {read_json(self.directory / f"{node}.stop.json")["session_id"] for node in self.workers}
        if any(row.get("sessionId") in stopped_ids and row.get("pid") for row in self.sessions.inventory()):
            raise RuntimeError("A stopped worker was restarted; reconcile before snapshot capture")
        self.event("freeze", "stopped", f"Native workers stopped before snapshot capture: {', '.join(self.workers)}")

    def stop_reviewer(self, reviewer_id: str = DEFAULT_REVIEWER):
        self.stop_session(review_node(reviewer_id))
        self.event(REVIEW, "stopped", f"Reviewer {reviewer_id} session stopped; its transcript stays resumable")

    def check_ownership(self, node: str, changed: list[str]) -> None:
        """Every changed path is an exact repository path the lane owns: at freeze, and in a lane repair's snapshot."""
        # Ownership is enforced from the full declared policy: an excluded lane's paths are off-limits to every selected lane.
        excluded_paths = [(other, safe_path(prefix)) for other in self.excluded for prefix in self.worker_policy(other)["owned_paths"]]
        worker = self.worker_policy(node)
        for name in changed:
            safe_path(name)
            for other, prefix in excluded_paths:
                if owns(name, prefix):
                    raise ValueError(f"Ownership violation: {node} edited {name}, owned by excluded lane {other}")
            if not any(owns(name, safe_path(prefix)) for prefix in worker["owned_paths"]):
                raise ValueError(f"{node} edited unowned path: {name}")

    def check_shared_git(self, node: str) -> None:
        """C25's tripwire, a warning and never a refusal: the shared .git against the digest prepare recorded
        (plan.shared_git), at freeze once the workers stopped, in the review node before the review diff is written, and
        before integrate. A change is one `warning` event on `node` naming the keys and files that differ from prepare
        (`Shared .git changed during the run: ...`); a text already recorded is not recorded again, and `status` shows the
        latest. A run prepared before the digest compares nothing."""
        pinned = self.plan.get("shared_git")
        if not isinstance(pinned, dict):
            return
        try:
            changed = shared_git_changes(pinned["entries"], shared_git_state(self.plan["repository"]))
        except (OSError, KeyError, TypeError, ValueError, subprocess.SubprocessError) as error:
            message = f"Shared .git not compared: {error}"
        else:
            if not changed:
                return
            message = SHARED_GIT_CHANGED + ", ".join(changed)
        if any(event.get("message") == message for event in complete_events(self.directory)):
            return
        self.event(node, "warning", message)

    def freeze(self) -> dict:
        record = self.directory / "snapshots.json"
        if record.exists():
            return read_json(record)
        handoffs = {}
        for node in self.workers:
            handoff_path = self.directory / f"{node}.handoff.json"
            if not handoff_path.exists():
                raise ValueError(f"Missing {node} handoff: summary and open_assumptions are required")
            handoff = read_json(handoff_path)
            if set(handoff) != {"summary", "open_assumptions"} or not isinstance(handoff["summary"], str) or not handoff["summary"].strip() or not isinstance(handoff["open_assumptions"], list) or any(not isinstance(item, str) for item in handoff["open_assumptions"]):
                raise ValueError("Malformed worker handoff")
            handoffs[node] = handoff
        from .sidecar import close
        close(self, "freeze")  # The review sidecar ends here, whatever its ledger says; it never raises.
        self.stop_workers()
        self.check_shared_git("freeze")  # No worker can change the shared .git any more; nothing is captured yet.
        snapshots = {}
        for node in self.workers:
            cwd = Path(self.plan["nodes"][node]["worktree"])
            if git(cwd, "rev-parse", "HEAD") != self.plan["base_commit"]:
                raise ValueError("Worker changed HEAD; reconcile commits rather than silently accepting them")
            changed = changed_files(cwd, self.plan["base_commit"])
            self.check_ownership(node, changed)
            for name in changed:
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
            # Validate paths from the actual captured tree, including staged renames/deletes. NUL-separated, as changed_files
            # reads them: without -z Git quotes a name with a non-ASCII byte, a double quote or a backslash.
            captured = subprocess.check_output(["git", "-C", str(cwd), "diff-tree", "-z", "--no-commit-id", "--no-renames", "--name-only", "-r",
                                                self.plan["base_commit"], tree]).decode().split("\0")
            if sorted(filter(None, captured)) != changed:
                raise ValueError("Files changed during snapshot; refuse inconsistent evidence")
            commit = self.plan["base_commit"]
            if changed:
                commit = subprocess.check_output(["git", "-C", str(cwd), "-c", "commit.gpgsign=false", "commit-tree", tree,
                                                  "-p", self.plan["base_commit"], "-m", f"Workflow {self.plan['run_id']}: {node}"], env=env, text=True).strip()
            subprocess.run(["git", "-C", str(cwd), "update-ref", run_ref(self.directory, node), commit], check=True)
            receipt = read_json(self.directory / f"{node}.interactive.json")
            snapshots[node] = {"commit": commit, "changed_files": changed, "session_id": receipt["session_id"], **handoffs[node]}
        save_json(record, snapshots)
        self.event("freeze", "succeeded", "Immutable snapshots captured; worker-reported checks are not trusted")
        return snapshots

    def attempt(self, phase: str, node: str) -> int:
        """The lane's current attempt: from the floor of its revision (1, or the one a lane repair set) to the run's limit past it."""
        from .repair import attempt_floor
        path = self.directory / "attempts.json"
        value = read_json(path).get(f"{phase}:{node}", 1) if path.exists() else 1
        floor = attempt_floor(self.directory, phase, node)
        if type(value) is not int or value < floor or value >= floor + self.policy.get("max_verification_attempts", 3):
            raise ValueError("Verification attempt exceeds the run's hard limit")
        return value

    def retry_check(self, phase: str, node: str) -> int:
        from .repair import attempt_floor
        value = self.attempt(phase, node) + 1
        if value >= attempt_floor(self.directory, phase, node) + self.policy.get("max_verification_attempts", 3):
            raise ValueError("Verification attempt limit reached; inspect evidence and create an explicitly revised run")
        path = self.directory / "attempts.json"
        attempts = read_json(path) if path.exists() else {}
        attempts[f"{phase}:{node}"] = value
        save_json(path, attempts)
        return value

    def native_evidence(self) -> dict:
        return {node: {key: read_json(self.directory / f"{node}.interactive.json").get(key)
                       for key in ("session_id", "background_id", "launcher_invocations", "native_started_at")}
                for node in self.workers}

    def verify(self, node: str, snapshots: dict) -> str:
        snap = snapshots[node]
        attempt = self.attempt("worker", node)
        self.event(f"verify_{node}", "running", f"Attempt {attempt}; revision {snap['commit']}")
        drill = self.failure_drill()
        drilled = bool(drill) and drill["node_id"] == node and attempt == 1
        # The drill fails this attempt whatever its checks say, so it is kept whole like any failed attempt (C47).
        packet = verify_revision(self.directory, self.plan, self.policy, node, snap["commit"], snap["changed_files"], snap["session_id"],
                                 attempt=attempt, prune=not drilled)
        path = self.directory / "verification" / "worker" / node / str(attempt) / "packet.json"
        if drilled:
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
        retried = attempt if failed_before(self.directory, "worker", node, attempt, snap["commit"]) else None
        self.event(f"verify_{node}", packet["gate"]["status"], ("; ".join(packet["gate"]["reasons"]) or passed_message(packet, retried)) + self.slow_note(node, packet))
        if packet["gate"]["status"] != "passed":
            raise RuntimeError(f"{node} verification blocked; see {path}. Retry explicitly or start a revised run.")
        return str(path)

    def slow_note(self, node: str, packet: dict) -> str:
        """`; slow: <check> took <s> s of its <t> s timeout (<p>%)` for each check over SLOW_SHARE of its timeout (C27), else ""."""
        slow = slow_checks(self.worker_policy(node), packet["result"], packet["evidence"])
        return f"; slow: {', '.join(slow)}" if slow else ""

    def reusable_packet(self, node: str, attempt: int, commit: str, state: PipelineState, repaired: bool) -> Path | None:
        """The worker packet the candidate gate of `node` reuses (C28), or None when its checks run again.

        Only a run of one selected lane, whose candidate is that lane's snapshot, on the lane's first candidate attempt (a
        retry runs the checks), before any lane repair, and only a lane without a browser check: md-manager's browser
        harness depends on the phase. Several lanes and repaired candidates run every check, as before.
        """
        if len(self.workers) != 1 or attempt != 1 or repaired or state["snapshots"][node]["commit"] != commit:
            return None
        if any(check["kind"] == "browser" for check in self.worker_policy(node)["checks"]):
            return None
        return Path(state["packets"][node])

    def candidate(self, state: PipelineState) -> str:
        from .repair import applied_repairs, candidate_paths as generation_paths
        # Validate branch evidence again before combining anything.
        worker_paths = [Path(state["packets"][node]) for node in self.workers]
        for node, path in zip(self.workers, worker_paths):
            packet = recheck_packet(read_json(path), self.policy, self.directory)
            if packet["gate"]["status"] != "passed":
                raise ValueError("Worker evidence no longer passes")
            # The bundle binds these packets to these snapshots: a packet of another revision (a repair written onto a
            # failed head instead of the freeze boundary would bring the old ones) is never combined or reviewed.
            if packet["expected"]["output_commit"] != state["snapshots"][node]["commit"]:
                raise ValueError(f"Worker evidence for {node} is not of its snapshot {state['snapshots'][node]['commit']}; contradictory run state")
        # One candidate generation per applied lane repair: candidate.json and candidate/ stay generation 0's evidence.
        repairs = applied_repairs(self.directory)
        saved, cwd = generation_paths(self.directory, len(repairs))
        if saved.exists():
            candidate = read_json(saved)
        else:
            if cwd.exists():
                raise ValueError("Partial candidate worktree exists; inspect before recovery")
            git_worktree(self.plan["repository"], "add", "--detach", str(cwd), self.plan["base_commit"])
            for node in self.workers:  # Declared order, selected lanes only.
                commit = state["snapshots"][node]["commit"]
                if commit != self.plan["base_commit"]:
                    # --ff: the first snapshot's parent is the base, so it becomes the candidate commit itself (C28).
                    subprocess.run(["git", "-C", str(cwd), "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "cherry-pick", "--ff", commit], env=commit_env(), check=True, capture_output=True)
            candidate = {"commit": git(cwd, "rev-parse", "HEAD"), "worktree": str(cwd)}
            save_json(saved, candidate)
        # The latest generation's commit, also when a controller stopped before it was written: update-ref is idempotent.
        subprocess.run(["git", "-C", self.plan["repository"], "update-ref", run_ref(self.directory, CANDIDATE_REF), candidate["commit"]], check=True)
        expected_tree = repairs[-1]["expected_candidate_tree"] if repairs else None
        if expected_tree and git(Path(self.plan["repository"]), "rev-parse", f"{candidate['commit']}^{{tree}}") != expected_tree:
            raise ValueError(f"Candidate {candidate['commit']} differs from the repaired tree of repair {repairs[-1]['n']}; inspect")
        candidate_paths = []
        for node in self.workers:
            attempt = self.attempt("candidate", node)
            reused = self.reusable_packet(node, attempt, candidate["commit"], state, repaired=bool(repairs))
            if reused:
                packet = reuse_packet(self.directory, self.plan, self.policy, node, candidate["commit"], reused, attempt=attempt)
                # A regular candidate packet already cached at this attempt (an earlier controller ran the checks) comes back as it is.
                note = (f"; worker checks reused from {packet['reused_from']['path']} (one lane, no browser check, the candidate is its snapshot)"
                        if "reused_from" in packet else self.slow_note(node, packet))
            else:
                packet = verify_revision(self.directory, self.plan, self.policy, node, candidate["commit"],
                                         changed_files(Path(candidate["worktree"]), self.plan["base_commit"]),
                                         state["snapshots"][node]["session_id"], phase="candidate", attempt=attempt)
                note = self.slow_note(node, packet)
            path = self.directory / "verification" / "candidate" / node / str(attempt) / "packet.json"
            self.event(f"candidate_{node}", packet["gate"]["status"], f"Combined revision {candidate['commit']}{note}")
            # A second event says why, or that this attempt passed after the one before failed; the first stays as the viewer reads it.
            if packet["gate"]["status"] != "passed":
                self.event(f"candidate_{node}", packet["gate"]["status"], f"Candidate gate blocked on attempt {attempt}: {'; '.join(packet['gate']['reasons'])}")
                raise RuntimeError(f"Combined candidate failed {node} checks; see {path}")
            if failed_before(self.directory, "candidate", node, attempt, candidate["commit"]):
                self.event(f"candidate_{node}", "passed", f"Candidate gate passed on attempt {attempt} after attempt {attempt - 1} failed")
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
                     "workers_with_changed_launch_evidence": [node for node in self.workers if before.get(node) != after.get(node)],
                     "verification_attempts": {node: sorted(int(item.name) for item in (self.directory / "verification" / "worker" / node).iterdir() if item.is_dir() and item.name.isdigit()) for node in self.workers},
                     "scope": "Pipeline-issued sessions; native launch times/counts are null when unavailable. Out-of-band manual restarts are not certified."}
            save_json(self.directory / "failure-report.json", audit)
            bundle["failure_drill"] = audit
        save_json(path, bundle)
        return str(path)

    def validate_bundle(self) -> tuple[dict, str]:
        """review-bundle.json as the candidate step writes it, and its digest: this run, policy and base, and per selected lane
        exactly one passing worker packet of its snapshot and one passing candidate packet of the combined revision, each
        packet named by its own phase, lane and commit. A lane repair's later candidate generation is bundled the same way."""
        path = self.directory / "review-bundle.json"
        bundle = read_json(path)
        if bundle["run_id"] != self.plan["run_id"] or bundle["policy_sha256"] != policy_digest(self.policy):
            raise ValueError("Bundle identity/policy changed")
        if bundle.get("base_commit") != self.plan["base_commit"]:
            raise ValueError(f"Bundle base {bundle.get('base_commit')} is not the run's base {self.plan['base_commit']}")
        found = {}
        for reference in bundle["packets"]:
            packet_path = Path(reference["path"]).resolve()
            if not packet_path.is_relative_to(self.directory) or digest_file(packet_path) != reference["sha256"]:
                raise ValueError("Review evidence changed")
            packet = recheck_packet(read_json(packet_path), self.policy, self.directory)
            if packet["gate"]["status"] != "passed":
                raise ValueError("Review artifact missing, changed or failing")
            phase, node = packet["phase"], packet["expected"]["node_id"]
            if (phase, node) in found:
                raise ValueError(f"Bundle has two {phase} packets of {node}")
            found[phase, node] = packet["expected"]["output_commit"]
        for node in self.workers:
            for phase, commit in (("worker", (bundle["snapshots"].get(node) or {}).get("commit")), ("candidate", bundle["candidate_commit"])):
                if (phase, node) not in found:
                    raise ValueError(f"Bundle has no {phase} packet of {node}")
                verified = found.pop((phase, node))
                if verified != commit:
                    raise ValueError(f"Bundle's {phase} packet of {node} is of {verified}, not {commit}")
        if found:
            raise ValueError(f"Bundle has packets of no lane it combines: {', '.join(f'{phase} {node}' for phase, node in found)}")
        return bundle, digest_file(path)

    def validate_review(self, review: dict, require_approved: bool = True) -> None:
        """The combined record must name exactly this run's declared reviewers; approval needs every one of them."""
        bundle, digest = self.validate_bundle()
        check_review(review, bundle, digest, require_approved=require_approved, reviewers=reviewer_ids(self.plan))

    def integrate(self, approved: str) -> str:
        self.check_shared_git("integrate")
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
                self.record_finished(candidate)  # A controller stopped after the fast-forward: recorded once, whichever writes it.
                return candidate
        if git(repo, "rev-parse", "HEAD") != self.plan["base_commit"]:
            raise ValueError("Source advanced since preparation; rebase/review explicitly")
        save_json(intent, {"bundle_sha256": digest, "candidate_commit": candidate})
        subprocess.run(["git", "-C", str(repo), "-c", "core.hooksPath=/dev/null", "merge", "--ff-only", candidate], check=True, capture_output=True)
        self.event("integrate", "succeeded", f"Fast-forwarded to {candidate}; no push performed")
        self.record_finished(candidate)
        return candidate

    def record_finished(self, commit: str) -> None:
        """The attention record of a run that reached its end (never raises): pushing is the operator's, and so is merging the
        branch, unless the run's branch was main itself."""
        branch = self.plan["source_branch"]
        attention(self.directory, "finished", f"{branch} fast-forwarded to {commit}: the run is finished. "
                                              f"Nothing was pushed{untouched_main(self.plan.get('repository'), branch)}.", node="integrate")


class ExportRuntime:
    """Read-only view of a run directory for re-exporting run-state.json.

    It constructs no sessions and touches no worktree, so a copied or finished
    run whose worktrees are gone still exports. Contradictory files are refused.
    """

    def __init__(self, directory: Path):
        self.directory = directory.resolve()
        self.plan = read_json(self.directory / "plan.json")
        if "automatic" in self.plan:
            from .automatic import validate_automatic
            validate_automatic(self.plan)
        self.policy = None
        policy_path = self.directory / "policy.json"
        if policy_path.exists():
            self.policy = validate_pipeline_policy(read_json(policy_path))
            if self.plan.get("policy_sha256") != policy_digest(self.policy):
                raise ValueError("Pinned policy changed")
        self.workers, self.excluded = lanes_of(self.plan, self.policy)
        review_path = self.directory / "review.json"
        if review_path.exists():
            bundle_path = self.directory / "review-bundle.json"
            if not bundle_path.exists():
                raise ValueError("review.json exists without review-bundle.json; contradictory run directory")
            # Packet hashes are not rechecked here; the adapter re-verifies packets itself. Reviews recorded
            # before configured lanes may attribute a finding to `both`; the viewer renders it as several lanes.
            check_review(read_json(review_path), read_json(bundle_path), digest_file(bundle_path), require_approved=False,
                         allow_legacy="workers" not in self.plan)


def lanes_of(plan: dict, policy: dict | None) -> tuple[list[str], list[str]]:
    """The run's selected and excluded lanes, checked against the pinned policy when it is present."""
    workers, excluded = plan_workers(plan), plan_excluded(plan)
    if policy is not None:
        declared = policy_workers(policy)
        if not set(workers) <= set(declared) or not set(excluded) <= set(declared):
            raise ValueError("Plan names lanes the pinned policy does not declare")
        if "workers" in plan and set(workers) | set(excluded) != set(declared):
            raise ValueError("Plan does not account for every declared lane")
    if set(plan.get("nodes", {})) != set(workers):
        raise ValueError("Plan nodes do not match the selected lanes; inspect retained allocation state")
    return workers, excluded


def carry_legacy_lanes(runtime: ExportRuntime, state, saver: SqliteSaver | None = None):
    """Carry a pre-lane checkpoint's per-lane evidence into the lane state shape.

    A checkpoint written before configured lanes stored each lane under `<lane>` and
    `<lane>_packet`; the graph no longer has those channels, so `get_state` drops them.
    Read them from the raw checkpoint and carry them under `lanes`/`packets` so the launch
    evidence survives every export, whether from `export` or from the report written at
    each CLI boundary. Runs with configured lanes are returned unchanged.
    """
    from types import SimpleNamespace
    database = runtime.directory / "pipeline.sqlite"
    if "workers" in runtime.plan or not database.exists():
        return state
    config = {"configurable": {"thread_id": runtime.plan["run_id"]}}

    def carry(saver: SqliteSaver):
        stored = saver.get_tuple(config)
        raw = stored.checkpoint.get("channel_values", {}) if stored else {}
        values = dict(state.values)
        for node in runtime.workers:
            if node in raw:
                values.setdefault("lanes", {}).setdefault(node, raw[node])
            if f"{node}_packet" in raw:
                values.setdefault("packets", {}).setdefault(node, raw[f"{node}_packet"])
        return SimpleNamespace(values=values, next=state.next, tasks=state.tasks)

    if saver is not None:
        return carry(saver)
    with SqliteSaver.from_conn_string(str(database)) as own:
        return carry(own)


def persisted_state(runtime: ExportRuntime):
    """The run's graph state from its persisted checkpoint. Reading state never invokes a node or a session."""
    from types import SimpleNamespace
    database = runtime.directory / "pipeline.sqlite"
    if not database.exists():
        return SimpleNamespace(values={}, next=tuple(f"launch_{node}" for node in runtime.workers), tasks=[])  # Prepared, never started.
    config = {"configurable": {"thread_id": runtime.plan["run_id"]}}
    with SqliteSaver.from_conn_string(str(database)) as saver:
        return carry_legacy_lanes(runtime, build_pipeline(saver, runtime).get_state(config), saver)


def export_run(runtime: ExportRuntime) -> dict:
    """Re-export from the persisted checkpoint."""
    return export_state(runtime, persisted_state(runtime))


def build_pipeline(checkpointer, runtime):
    """The graph over the runtime's plan: `launch_<lane>` and `verify_<lane>` per selected lane, then the fixed tail."""
    workers = list(runtime.workers)
    def launcher(node):
        return lambda _state: {"lanes": {node: runtime.launch(node)}}
    def verifier(node):
        return lambda state: {"packets": {node: runtime.verify(node, state["snapshots"])}}
    def handoff(_state):
        message = ("Awaiting explicit completion signals and automatic freeze." if runtime.plan.get("automatic")
                   else f"Type in Claude terminals; provide a handoff for every lane ({', '.join(workers)}), then explicitly freeze.")
        decision = interrupt({"kind": "worker_handoff", "message": message})
        if decision != {"freeze": True}:
            raise ValueError("Explicit freeze required")
        return {"snapshots": runtime.freeze()}
    def candidate(state): return {"bundle": runtime.candidate(state)}
    def review(_state):
        runtime.check_shared_git("review")  # Before review_candidate writes review.diff, which every reviewer starts from.
        _, digest = runtime.validate_bundle()
        if runtime.plan.get("automatic"):
            from .automatic import review_candidate
            decision = review_candidate(runtime)
        else:
            decision = interrupt({"kind": "independent_review", "bundle_sha256": digest,
                                  "bundle_path": str(runtime.directory / "review-bundle.json")})
        runtime.validate_review(decision)
        save_json(runtime.directory / "review.json", decision)
        runtime.event("review", "approved", decision["reviewer"])
        return {"review": decision}
    def approval(_state):
        _, digest = runtime.validate_bundle()
        if runtime.plan.get("automatic"):
            from .automatic import validate_automatic
            validate_automatic(runtime.plan)
            decision = {"approve": digest}  # Explicit run-level authority: feature branch only.
        else:
            decision = interrupt({"kind": "integration_approval", "bundle_sha256": digest,
                                  "message": "Approve fast-forward of source branch; no push."})
        if decision != {"approve": digest}:
            raise ValueError("Explicit exact-bundle approval required")
        return {"approved_bundle": digest}
    def integrate(state): return {"integrated_commit": runtime.integrate(state["approved_bundle"])}
    graph = StateGraph(PipelineState)
    launches = [f"launch_{node}" for node in workers]
    verifies = [f"verify_{node}" for node in workers]
    for node, name in zip(workers, launches):
        graph.add_node(name, launcher(node))
    for node, name in zip(workers, verifies):
        graph.add_node(name, verifier(node))
    for name, function in (("handoff", handoff), ("candidate", candidate), ("review", review), ("approval", approval), ("integrate", integrate)):
        graph.add_node(name, function)
    for name in launches:
        graph.add_edge(START, name)
    graph.add_edge(launches, "handoff")
    for name in verifies:
        graph.add_edge("handoff", name)
    graph.add_edge(verifies, "candidate")
    graph.add_edge("candidate", "review"); graph.add_edge("review", "approval")
    graph.add_edge("approval", "integrate"); graph.add_edge("integrate", END)
    return graph.compile(checkpointer=checkpointer)


def start_workers(runtime, attach: bool = False) -> None:
    """The first graph step (every launch) after `resume` decided the design challenge; `start` does the same inline."""
    from .guardrails import challenge_gate
    if not challenge_gate(runtime):
        raise RuntimeError("The design challenge has not passed; no worker is launched")
    config = graph_config(runtime)
    with SqliteSaver.from_conn_string(str(runtime.directory / "pipeline.sqlite")) as saver:
        graph = build_pipeline(saver, runtime)
        if graph.get_state(config).values:
            raise RuntimeError("Run already started; use status/explicit controls, never start again")
        try:
            advance(runtime, graph, {"run_id": runtime.plan["run_id"]}, config)
        finally:
            print(f"Report: {report(runtime, graph.get_state(config))}")
    if attach:
        print(json.dumps(attach_panels(runtime.sessions), indent=2))


def advance(runtime, graph, value, config) -> None:
    """`graph.invoke`, re-exporting after every step: one invoke can run freeze, checks, candidate and review, and the
    viewer reads run-state.json, which otherwise stays at the last boundary for all of them. Each step's checkpoint is
    persisted before it is exported; a failed export never fails the step (the caller exports again when it ends)."""
    for _ in graph.stream(value, config, stream_mode="updates", durability="sync"):
        try:
            report(runtime, graph.get_state(config))
        except Exception as error:
            print(f"Report after a step failed; the run continues: {error}", file=sys.stderr)


def graph_config(runtime) -> dict:
    """One LangGraph thread per run; every lane's fan-out step may run concurrently."""
    return {"configurable": {"thread_id": runtime.plan["run_id"]}, "max_concurrency": max(2, len(runtime.workers))}


def report(runtime: Pipeline, state) -> Path:
    """Escaped local results viewer, generated on every CLI boundary and by `export`; no server needed."""
    state = carry_legacy_lanes(runtime, state)  # A CLI boundary on a legacy run must export the same evidence as `export`.
    export_state(runtime, state)
    events_path = runtime.directory / "events.jsonl"
    events = [json.loads(line) for line in events_path.read_text().splitlines()] if events_path.exists() else []
    packets = list((runtime.directory / "verification").glob("*/*/*/packet.json"))
    flow = ("Launch workers → completion signals → isolated checks → combined checks → independent review → verified feature branch (no main merge or push)"
            if runtime.plan.get("automatic") else "Launch workers → human handoff → isolated checks → combined checks → independent review → approval → integration")
    parts = ['<!doctype html><meta charset="utf-8"><title>Workflow report</title><style>body{font:16px system-ui;max-width:1100px;margin:40px auto;background:#151820;color:#eee}pre{white-space:pre-wrap}a{color:#8dcaff}img{max-width:100%}section{border:1px solid #555;padding:16px;margin:16px 0}</style>',
             '<h1>Workflow report</h1>' + outcome_html(runtime.directory) + '<p>' + html.escape(flow) + '</p>',
             '<h2>Current state</h2><pre>' + html.escape(json.dumps({"next": state.next, "interrupts": [str(task.interrupts) for task in state.tasks if task.interrupts], "errors": [str(task.error) for task in state.tasks if task.error], "integrated_commit": state.values.get("integrated_commit")}, indent=2)) + '</pre>',
             '<h2>Timeline</h2><pre>' + html.escape(json.dumps(events, indent=2)) + '</pre>']
    authority = runtime.plan.get("worker_authority")  # Pinned at prepare; runs prepared before have none.
    if authority is not None:
        parts.insert(3, '<h2>Worker authority</h2><pre>' + html.escape(json.dumps(authority, indent=2)) + '</pre>')
    positions, edges, width, height = lane_positions(list(runtime.workers))
    svg = [f'<h2>Execution graph</h2><svg role="img" aria-label="Workflow execution graph" viewBox="0 0 {width} {height}">']
    for left, right in edges:
        x1, y1 = positions[left]; x2, y2 = positions[right]
        svg.append(f'<line x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" stroke="#9aa"/>')
    for name, (x, y) in positions.items():
        color = '#665000' if name in state.next else '#263747'
        svg.append(f'<rect x="{x-75}" y="{y-23}" width="150" height="46" rx="8" fill="{color}" stroke="#9aa"/><text x="{x}" y="{y+5}" text-anchor="middle" fill="white" font-size="14">{html.escape(name)}</text>')
    lanes = ", ".join(runtime.workers) + (f" (excluded: {', '.join(runtime.excluded)})" if runtime.excluded else "")
    svg.append(f'</svg><p>Lanes: {html.escape(lanes)}. Highlighted nodes are pending. A completed launch is not a completed worker task.</p>')
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
    repairs = runtime.directory / "repairs.json"
    if repairs.exists():
        parts.append('<h2>Repairs</h2><pre>' + html.escape(repairs.read_text()) + '</pre>')
        parts.extend(f'<p><a href="{path.name}">{html.escape(path.name)}</a></p>' for path in sorted(runtime.directory.glob("repair-*.diff")))
    destination = runtime.directory / "report.html"
    destination.write_text("\n".join(parts))
    return destination


def outcome_html(directory: Path) -> str:
    """The outcome block at the top of report.html (C43); nothing while the run records no outcome yet."""
    block = outcome_block(directory)
    return f'<h2>Outcome</h2><pre>{html.escape(block)}</pre>' if block else ""


def outcome_lines(directory: Path) -> str:
    """The outcome block on its own lines after a success or Blocked line; empty while the run records no outcome yet."""
    block = outcome_block(directory)
    return f"{block}\n" if block else ""


def finish_policy(automatic: dict | None, branch: str) -> str:
    """How the run ends, from its automatic settings (plan.automatic, or what prepare pins from launch's flags), never from
    plan.mode, the transport tag every run records as "interactive". An automatic run approves its own integration: the
    policy's integration_approval is a schema constant, true in every policy, and no stop for it."""
    if automatic and automatic.get("finish") == "verified-feature-branch":
        return (f"automatic, finish {automatic['finish']}: once every reviewer approves, the controller fast-forwards {branch} "
                "itself; it does not stop for integration approval, and nothing merges main or pushes")
    if automatic:
        return f"automatic, finish {automatic.get('finish')}"  # A finish this controller does not describe; it says no more than the plan.
    return f"manual: you freeze the workers, import each review and approve the fast-forward of {branch}; nothing is pushed"


def untouched_main(repository, branch: str) -> str:
    """`, and main is untouched` when the source repository has a branch named main other than the run's: approve, and an
    automatic run's controller, fast-forward the run's own branch only. Empty for a run on main itself (a manual run may
    be prepared on any named branch) and for a repository without main, whose main line has another name."""
    if branch == "main":
        return ""
    try:
        found = subprocess.run(["git", "-C", str(repository), "rev-parse", "--verify", "-q", "refs/heads/main"], capture_output=True).returncode == 0
    except (OSError, subprocess.SubprocessError):
        found = False
    return ", and main is untouched" if found else ""


def challenge_step(directory: Path, plan: dict) -> str | None:
    """What the design challenge waits for before any worker starts, as `resume` acts on it; None when it waits for nothing.

    The override is offered only for a paused attempt that read what the plan pins, with no edit waiting: `resume`
    refuses it otherwise (guardrails.refuse_unused_edits). A bare `resume` is promised to commit the edits only when its
    read-only checks pass (guardrails.resume_refusal); otherwise the step names its refusal. A bare `resume` reruns the challenge on the edits, or with no
    edit after a rerun that failed before its job decided (guardrails.unchanged_since). A job still running under `start`
    or `resume` looks the same as one a Ctrl-C or a kill left undecided, so the step says when it applies. The run does
    not record whether its `start` was given --herdr, so the commands come with the hint to add it.
    """
    from .guardrails import HERDR_HINT, REVISION_INTENT, edited_in, load_challenge, resume_command, resume_refusal, stale_pins, unused_edits
    record = load_challenge(directory)
    running = directory / "challenge.running.json"
    started = read_json(running).get("attempt", 0) if running.exists() else 0
    rerun = f"if no start or resume is running, {resume_command(directory)} reruns it (no edit needed; {HERDR_HINT})"
    if (directory / REVISION_INTENT).exists():
        return (f"an interrupted resume has not finished moving the run to the revised feature files: if no resume is running, "
                f"{resume_command(directory)} finishes it and reruns the design challenge ({HERDR_HINT})")
    if started > (record["attempt"] if record else 0):
        return f"design challenge attempt {started} was started and not decided: {rerun}"
    if record is None or record.get("status") != "paused":
        return None
    if stale_pins(directory, plan, record):  # A rerun re-pinned the files, then failed before its job (its checkout, a kill).
        return f"design challenge attempt {record['attempt']} read other feature files than the plan now pins, and no later attempt was decided: {rerun}"
    try:
        edits = unused_edits(directory, plan)
    except (OSError, ValueError, subprocess.SubprocessError) as error:  # `resume` reads the same checkout, with or without the override.
        return (f"design challenge attempt {record['attempt']} paused the run, and its source checkout {plan['repository']} could not "
                f"be read ({error}): resume needs it")
    if edits:
        refusal = resume_refusal(plan)  # resume's read-only checks first: never send the operator to a command that refuses.
        if refusal:
            return (f"design challenge attempt {record['attempt']} paused the run, and feature files changed since it read them, but "
                    f"resume refuses: {refusal}; --accept-challenge is refused until the changes are reverted")
        return (f"design challenge attempt {record['attempt']} paused the run, and feature files changed since it read them: "
                f"{resume_command(directory)} commits them and reruns the design challenge ({HERDR_HINT}); --accept-challenge is "
                "refused until the changes are reverted")
    return (f"design challenge attempt {record['attempt']} paused the run: edit the task files, decisions.md or the PRD {edited_in(plan)}, then "
            f"{resume_command(directory)}, or accept it with {resume_command(directory, accept=True)} ({HERDR_HINT})")


def next_step(directory: Path, plan: dict, exported: dict | None) -> str:
    """`status`'s next step: the run's finish policy from where its last graph step left it, with the command that goes on.
    Without run-state.json it says so rather than guess: `export` writes that file from the run's checkpoint."""
    branch = plan.get("source_branch") or "the source branch"
    run = lambda action: f"{sys.executable} -m workflow {action} {shlex.quote(str(directory))}"
    automatic = plan.get("automatic")
    if exported is None:
        return f"unknown until `export` writes run-state.json: {run('export')}, then status again. {finish_policy(automatic, branch)}"
    values, tasks = exported.get("values") or {}, exported.get("tasks") or []
    gates = {item.get("kind"): item for task in tasks for item in task.get("interrupts") or [] if isinstance(item, dict)}
    if values.get("integrated_commit") and not exported.get("next"):
        from .guardrails import run_finished_note
        note = run_finished_note(directory, plan)
        return (f"none: {branch} was fast-forwarded to {values['integrated_commit']}; nothing was pushed{untouched_main(plan.get('repository'), branch)}"
                + (f". {note}" if note else ""))
    if not values:
        waiting = challenge_step(directory, plan)
        if waiting:
            return f"{waiting}. Then: {finish_policy(automatic, branch)}"
        from .guardrails import HERDR_HINT
        supervise = f", then supervise them: {run('automatic')} --live {BY_OPERATOR}" if automatic else ""
        return f"no worker started yet: {run('start')} --live {BY_OPERATOR} ({HERDR_HINT}){supervise}. Then: {finish_policy(automatic, branch)}"
    if automatic:
        return (f"{finish_policy(automatic, branch)}. Its supervisor continues the run; if none is running: {run('automatic')} --live {BY_OPERATOR} "
                "(it says why when the run cannot go on)")
    if "integration_approval" in gates:
        return f"approve the fast-forward of {branch}: {run('approve')} --bundle-sha256 {gates['integration_approval'].get('bundle_sha256')} {BY_OPERATOR}; nothing is pushed"
    if "independent_review" in gates:
        reviewer = " --reviewer <id>" if plan.get("reviewers") else ""
        return f"import each reviewer's review: {run('review')} --review-file <review.json>{reviewer}; then approve the fast-forward of {branch}"
    if "worker_handoff" in gates:
        handoffs = " ".join(f"--handoff {lane}=<handoff.json>" for lane in plan_workers(plan))
        return f"freeze the workers with their handoffs: {run('freeze')} {handoffs}; then import each review and approve the fast-forward of {branch}"
    recovery = f"RUNBOOK \"Status, failures and recovery\" says which `retry` or `reconcile` goes on. {finish_policy(None, branch)}"
    if any(task.get("error") for task in tasks):
        return f"a step failed (see errors): {recovery}"
    # No gate waits and no step failed: a freeze, review, approve or retry is running that step now, or was stopped in it.
    steps = ", ".join(exported.get("next") or []) or "the next step"
    return f"{steps}: running now, or stopped mid-step (no step recorded an error). If no workflow command is running on this run, {recovery}"


def abandoned_step(directory: Path, record: dict) -> str:
    """`status`'s next step of an abandoned run: nothing goes on in it; its brief feeds a follow-up run."""
    run = shlex.quote(str(directory))
    by = f" by the {record['by']}" if record.get("by") else ""
    return (f"none: the run was abandoned{by} ({record.get('reason')}), and every command that would change it refuses. For a follow-up: "
            f"{sys.executable} -m workflow brief {run}, then {sys.executable} -m workflow launch <feature> --repo <target repo> --run-id <feature>-00N --follows {run} "
            f"--live --automatic {BY_OPERATOR}")


def complete_events(directory: Path) -> list[dict]:
    """events.jsonl as a reader beside a running controller sees it: a line counts once its newline is written."""
    path = directory / "events.jsonl"
    data = path.read_bytes() if path.exists() else b""
    events = []
    for line in data[:data.rfind(b"\n") + 1].splitlines():
        try:
            event = json.loads(line)
        except ValueError:
            continue
        if isinstance(event, dict):
            events.append(event)
    return events


def run_status(directory: Path) -> tuple[dict, str]:
    """`status` without the controller lock, so it answers while a controller holds the run. It reads plan.json,
    run-state.json (the export of the last graph step), events.jsonl and the run's other JSON files, which the
    controller replaces atomically, and writes nothing. Returns what it prints and the note on how current it is."""
    plan = read_json(directory / "plan.json")
    exported = read_json(directory / "run-state.json") if (directory / "run-state.json").exists() else None
    tasks = (exported or {}).get("tasks") or []
    # The checkout the run's branch is on, where a paused run's feature files are edited: its own worktree since launch adds one.
    status = {"source_checkout": plan.get("repository"), "workers": plan_workers(plan), "excluded_workers": plan_excluded(plan),
              "next": exported.get("next") if exported else None,
              "pending": [item.get("kind") if isinstance(item, dict) else None for task in tasks for item in task.get("interrupts") or []] if exported else None,
              "errors": [task["error"] for task in tasks if task.get("error")] if exported else None}
    if (directory / "challenge.json").exists():
        status["challenge"] = read_json(directory / "challenge.json")["status"]
    if (directory / "repairs.json").exists():
        from .repair import load_repairs
        status["repairs"] = [{"n": entry["n"], "status": entry["status"], "lanes": list(entry["lanes"]), "commit": entry["source_commit"]}
                             for entry in load_repairs(directory)]
    workspaces = sorted(path.name for path in directory.glob("repair-workspace-*") if path.is_dir())
    if workspaces:
        status["repair_workspaces"] = workspaces  # Cleanup is the operator's decision.
    from .abandon import abandoned
    record = abandoned(directory)
    if record is not None:
        status["abandoned"] = {key: record.get(key) for key in ("reason", "by", "abandoned_at", "stopped", "not_running")}
    status["next_step"] = abandoned_step(directory, record) if record is not None else next_step(directory, plan, exported)
    events = complete_events(directory)
    shared_git = [event["message"] for event in events if str(event.get("message", "")).startswith("Shared .git ")]
    if shared_git:
        status["shared_git"] = shared_git[-1]  # The latest comparison that found a change (Pipeline.check_shared_git).
    status["last_event"] = events[-1] if events else None
    note = (f"Next, pending and errors are as of the last graph step (run-state.json, updated {exported.get('updated_at')}); the timeline "
            "can be ahead of them, and last_event is its newest entry." if exported else
            "No run-state.json yet: next, pending and errors are unknown until the controller or `export` writes it.")
    return status, note


def main():
    controller_git_config(os.environ)  # As `python -m workflow` does, for `python -m workflow.pipeline`; added once only.
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["preflight", "prepare", "start", "automatic", "automatic-step", "attach", "freeze", "retry", "reconcile", "review", "approve", "status", "export"],
                        help="resume and answer (feature.json 2.2.0 runs), sidecar-pass (2.3.0 runs with a review sidecar), repair, note, brief, "
             "abandon, clean and ledger have their own options: python -m workflow resume|answer|sidecar-pass|repair|note|brief|abandon|clean|ledger --help")
    parser.add_argument("directory", type=Path)
    parser.add_argument("--repo", type=Path, default=Path.cwd())
    parser.add_argument("--policy", type=Path)
    parser.add_argument("--workers", help="prepare: comma-separated subset of the policy's lanes to launch (default: every declared lane)")
    parser.add_argument("--task", action="append", metavar="LANE=PATH", help="prepare: task file for one selected lane; repeat once per lane")
    parser.add_argument("--reviewer", action="append", metavar="ID[=PATH]",
                        help="prepare: a declared reviewer and its brief file (repeat per reviewer; omitted means the single built-in reviewer). "
                             "review: the reviewer id an imported review file belongs to")
    parser.add_argument("--live", action="store_true")
    parser.add_argument("--automatic", action="store_true", help="Prepare run-scoped permission bypass and automatic feature-branch completion")
    parser.add_argument("--worker-timeout-seconds", type=int, help="Automatic mode: deadline per worker from launch until its completion signal (default 4h)")
    parser.add_argument("--review-timeout-seconds", type=int, help="Automatic mode: reviewer deadline from its launch to its completion file (default 30m)")
    parser.add_argument("--reviewer-transport", choices=["native", "print"], help="Automatic mode: native attachable reviewer session (default) or headless claude --print")
    parser.add_argument("--profile", choices=["attended", "unattended"], help="prepare --automatic: the run's profile (default unattended), pinned")
    parser.add_argument("--worker-model", help="prepare: the workers' model, pinned (default: Claude Code's default; no --model is passed)")
    parser.add_argument("--worker-effort", choices=EFFORT_LEVELS, help="prepare: the workers' effort, pinned (default: WORKFLOW_WORKER_EFFORT, read now)")
    parser.add_argument("--judge-model", help="prepare: the model of the design challenge, the reviewers and the review sidecar, pinned (default: Claude Code's default)")
    parser.add_argument("--judge-effort", choices=EFFORT_LEVELS, help="prepare: their effort, pinned (default high)")
    parser.add_argument("--herdr", action="store_true")
    parser.add_argument("--handoff", action="append", metavar="LANE=PATH", help="freeze: handoff file for one selected lane; repeat once per lane")
    parser.add_argument("--review-file", type=Path)
    parser.add_argument("--bundle-sha256")
    parser.add_argument("--node", help="retry: the lane whose failed check reruns (validated against the run's lanes)")
    parser.add_argument("--phase", choices=["worker", "candidate"], default="worker")
    parser.add_argument("--guardrails", action="store_true", help="prepare: a feature.json 2.2.0 run: completion 1.1.0, decisions.md pinned, "
                                                                  "and the design challenge before any worker launch")
    parser.add_argument("--decisions", type=Path, help="prepare --guardrails: the feature's decisions.md, pinned into the plan")
    parser.add_argument("--prd", type=Path, help="prepare --guardrails: the PRD the design challenge reads, copied into the run")
    parser.add_argument("--no-challenge", action="store_true", help="prepare --guardrails: the feature sets challenge: false")
    parser.add_argument("--sidecar-brief", type=Path, help="prepare --guardrails: the review sidecar's brief (feature.json 2.3.0 sidecar.prompt), pinned "
                                                         "into plan.sidecar")
    parser.add_argument("--sidecar-settings", help="prepare --sidecar-brief: the sidecar's bounds as JSON (cadence_seconds, pass_timeout_seconds, "
                                                   "max_passes, max_messages_per_lane; omitted ones take the defaults)")
    parser.add_argument("--restore-from", metavar="COMMIT", help="prepare: a follow-up run restores the lanes' owned paths from this commit "
                                                                   "(pinned as plan.restore_from; the challenge reads a read-only copy)")
    parser.add_argument("--follows", type=Path, metavar="RUN", help="prepare: the run directory this run follows up (C30), pinned as plan.follows "
                                                                   "{run_id, verdict, candidate_commit}")
    add_actor_argument(parser)
    args = parser.parse_args()
    if args.action != "prepare" and any(value is not None for value in (args.profile, args.worker_model, args.worker_effort,
                                                                         args.judge_model, args.judge_effort, args.restore_from)):
        # Prepare pins them (C52, C12); any other action would ignore them silently, `automatic --live` resuming a run included.
        parser.error("--profile, --restore-from and the role flags apply to prepare only; the pins cannot change after it")
    directory = args.directory.resolve()
    try:
        # Before anything reads the run: a gate without --by, or the maintainer at approve, changes nothing.
        actor = require_actor(args, args.action) if args.action in GATE_ACTIONS else None
        if args.follows and args.action != "prepare":
            parser.error("--follows applies to prepare only")
        if args.action not in {"preflight", "prepare", "status", "export"}:
            from .abandon import refuse_abandoned
            refuse_abandoned(directory)  # Before `automatic` records its action: an abandoned run changes no more.
        if args.action == "preflight":
            if not args.policy:
                parser.error("preflight requires --policy")
            policy = validate_pipeline_policy(read_json(args.policy))
            if git(args.repo.resolve(), "status", "--porcelain"):
                raise ValueError("Source must be clean before prepare")
            for executable in ("git", "claude", "node"):
                if not shutil.which(executable):
                    raise ValueError(f"Missing executable: {executable}")
            help_text = run_claude(["claude", "--help"], stdout=subprocess.PIPE, text=True, check=True, timeout=15).stdout
            # Every --bg launch passes --settings: the auto-updater off inside its session (sessions.background_settings).
            required_flags = ["--bg", "--settings", "--safe-mode", "--tools", "--permission-mode"]
            if args.automatic:
                # Workers: --dangerously-skip-permissions. Native reviewer: --add-dir and --allowedTools.
                # Print-mode reviewer (--reviewer-transport print): --json-schema, --print, --permission-prompts.
                required_flags += ["--dangerously-skip-permissions", "--add-dir", "--allowedTools", "--json-schema", "--print", "--permission-prompts"]
            # The judges always pass --effort (high unless --judge-effort says otherwise); WORKFLOW_WORKER_EFFORT is validated here too.
            worker_effort()
            required_flags.append("--effort")
            if not all(flag in help_text for flag in required_flags):
                raise ValueError("Installed Claude CLI lacks required flags")
            auth = json.loads(run_claude(["claude", "auth", "status"], stdout=subprocess.PIPE, text=True, check=True, timeout=15).stdout)
            if auth.get("loggedIn") is not True:
                raise ValueError("Claude is not authenticated")
            if args.herdr and os.environ.get("HERDR_ENV") != "1":
                raise ValueError("Herdr attachment requires a managed caller pane")
            print(json.dumps({"preflight": "passed", "base_commit": git(args.repo.resolve(), "rev-parse", "HEAD"),
                              "policy_sha256": policy_digest(policy), "note": "No agents launched. Actual dependency/test availability is checked in isolated verification worktrees."}, indent=2))
            return
        if args.action == "prepare":
            if not args.policy or not args.task:
                parser.error("prepare requires --policy and --task <lane>=<path> for every selected lane")
            policy = validate_pipeline_policy(read_json(args.policy))
            declared = policy_workers(policy)
            selected = parse_lane_selection(args.workers, declared)
            task_files = parse_lane_files(args.task, "--task")
            if set(task_files) != set(selected):
                parser.error(f"--task must be given exactly once for each selected lane ({', '.join(selected)}); got {', '.join(task_files) or 'none'}")
            if args.automatic and not git(args.repo.resolve(), "symbolic-ref", "--short", "HEAD").startswith("feature/"):
                raise ValueError("Automatic preparation requires a feature/ branch")
            from .guardrails import brief_problems, pin_guardrails, pinned_task
            if args.guardrails:
                if not args.decisions:
                    parser.error("prepare --guardrails requires --decisions <decisions.md>")
                for node, path in task_files.items():
                    problems = brief_problems(path.read_text())
                    if problems:
                        raise ValueError(f"Task {path} for lane {node}: {', '.join(problems)}")
                if not args.decisions.is_file() or not args.decisions.read_text().strip():
                    raise ValueError(f"decisions.md is missing or empty: {args.decisions}")
                if args.prd and not args.prd.is_file():
                    raise ValueError(f"PRD does not exist: {args.prd}")
            elif args.decisions or args.prd or args.no_challenge or args.sidecar_brief:
                parser.error("--decisions, --prd, --no-challenge and --sidecar-brief apply to prepare --guardrails (feature.json 2.2.0 and 2.3.0) only")
            if args.sidecar_settings is not None and not args.sidecar_brief:
                parser.error("--sidecar-settings applies to prepare --sidecar-brief only")
            sidecar_settings = None
            if args.sidecar_brief:
                from .sidecar import settings as sidecar_bounds
                try:
                    sidecar_settings = json.loads(args.sidecar_settings) if args.sidecar_settings else {}
                except ValueError as error:
                    raise ValueError(f"--sidecar-settings is not JSON: {error}") from None
                if not isinstance(sidecar_settings, dict):
                    raise ValueError("--sidecar-settings must be a JSON object")
                sidecar_bounds(sidecar_settings, "--sidecar-settings ")
                if not args.sidecar_brief.is_file() or not args.sidecar_brief.read_text().strip():
                    raise ValueError(f"Sidecar brief is missing or empty: {args.sidecar_brief}")
            tasks = {}
            for worker in policy["workers"]:
                node = worker["node_id"]
                if node in selected:
                    tasks[node] = pinned_task(task_files[node].read_text(), worker)
            reviewers = parse_reviewer_files(args.reviewer, declared)
            # C52: the roles' models and efforts, refused before anything is written; WORKFLOW_WORKER_EFFORT is read here, once.
            roles = pin_roles(args.worker_model, args.worker_effort, args.judge_model, args.judge_effort)
            note = override_note(os.environ, args.worker_model, args.worker_effort, args.judge_model, args.judge_effort)
            if note:
                print(f"Note: {note}", file=sys.stderr, flush=True)
            if args.profile and not args.automatic:
                parser.error("--profile applies to --automatic runs only")
            from .guardrails import check_restore, pin_restore, resolve_commit
            restore = None
            if args.restore_from is not None:  # Before the run directory.
                check_restore(args.automatic, selected)
                restore = resolve_commit(args.repo.resolve(), args.restore_from)
            from .brief import follows_record
            follows = follows_record(args.follows) if args.follows else None  # Refused before the run directory is made.
            from .launch import launch_notes
            notes = launch_notes(args.repo.resolve(), policy, selected, directory)  # As the launch printed them, before this run exists.
            plan = prepare(directory, args.repo, "HEAD", tasks, True, declared=declared)
            if follows:
                plan["follows"] = follows
            if reviewers:
                plan["reviewers"] = reviewers
            drill = policy.get("failure_drill")
            drill_skipped = bool(drill) and drill["node_id"] not in selected
            # Every launch runs as the operator's account, with no sandbox (C14 slice 1): the run records it with the digest of
            # the workers' --settings. There is no per-launch choice.
            plan.update(mode="interactive", policy_sha256=policy_digest(policy), created_at=now(), source_branch=git(args.repo.resolve(), "symbolic-ref", "--short", "HEAD"),
                        failure_drill=None if drill_skipped else drill, worker_authority=worker_authority(directory),
                        roles=roles, controller=controller_record())
            if args.guardrails:
                pin_guardrails(plan, directory, {node: task_files[node] for node in selected}, args.decisions, args.prd, not args.no_challenge)
            if args.sidecar_brief:
                from .sidecar import pin
                pin(plan, args.sidecar_brief, sidecar_settings)
            if restore:
                pin_restore(plan, directory, policy, restore)
            if args.automatic:
                from .automatic import automatic_settings
                plan["automatic"] = automatic_settings(args.worker_timeout_seconds, args.review_timeout_seconds, args.reviewer_transport, args.profile)
            elif args.worker_timeout_seconds or args.review_timeout_seconds or args.reviewer_transport:
                parser.error("Timeouts and the reviewer transport apply to --automatic runs only; manual runs have operator-controlled lifetimes and review")
            # C45: what the base holds that no approved run reviewed, pinned and printed. It changes nothing else, and a
            # registry or run it cannot read only costs the record.
            from .ledger import base_unreviewed, describe, runs_roots
            try:
                plan["base_unreviewed"] = base_unreviewed(Path(plan["repository"]), plan["base_commit"], runs_roots(extra=[directory.parent]))
            except Exception as error:  # The run is already allocated: whatever the ledger raises, prepare finishes.
                print(f"Warning: base_unreviewed not pinned: {error}", file=sys.stderr)
            save_json(directory / "policy.json", policy)
            save_json(directory / "plan.json", plan)
            if args.sidecar_brief:
                from .sidecar import write_initial
                write_initial(directory, plan)  # The viewer shows the sidecar node from prepare, with no pass yet.
            from types import SimpleNamespace
            runtime = Pipeline(directory)
            if drill_skipped:
                runtime.event("controller", "running", f"Failure drill skipped: its lane {drill['node_id']} is not selected for this run")
            if notes:
                runtime.event("controller", "running", "Launch notes: " + " ".join(notes))
            export_state(runtime, SimpleNamespace(values={}, next=tuple(f"launch_{node}" for node in selected), tasks=[]))
            print(f"Prepared {directory}; no agents launched. Pin: {plan['base_commit']}. Lanes: {', '.join(selected)}"
                  + (f" (excluded: {', '.join(plan['excluded_workers'])})" if plan["excluded_workers"] else "")
                  + f". Reviewers: {', '.join(reviewer_ids(plan))}")
            if "base_unreviewed" in plan:
                print(describe(plan["base_unreviewed"], plan["base_commit"]))
            return
        if args.action == "automatic":
            if not args.live:
                parser.error("automatic requires --live because it can launch an independent reviewer")
            from .automatic import supervise
            from .guardrails import LAUNCH_NOTE_ENV, run_finished_note
            # Launch's word to this process only, so removed before supervise: steps, checks, workers and reviewers inherit os.environ.
            launch_prints_note = os.environ.pop(LAUNCH_NOTE_ENV, None) == "1"
            try:
                supervise(directory, actor)
            except TransientInfraError as error:
                # Resumable, not blocked: 75 (EX_TEMPFAIL). Stale long-lived sessions are the usual source of an update.
                warning = stale_claude_warning()
                parser.exit(75, f"Interrupted: {error}\n" + (f"{warning}\n" if warning else ""))
            print(f"Automatic run reached a verified feature branch. Evidence: {directory / 'report.html'}. No main merge or push.")
            print(outcome_lines(directory), end="")
            note = run_finished_note(directory, read_json(directory / "plan.json"))
            if note and not launch_prints_note:
                print(note)
            return
        if args.action == "export":
            # Re-export an existing run (for example one recorded before a newer export version), and refresh its report.html.
            with run_lock(directory):
                runtime = ExportRuntime(directory)
                state = persisted_state(runtime)
                exported = export_state(runtime, state)
                page = report(runtime, state)  # Exports the same state again, which leaves run-state.json as it is.
            print(f"Exported run-state.json version {exported['version']}: {directory / 'run-state.json'}. Report: {page}. No agents launched.")
            return
        if args.action == "status":
            # No lock: it reads the files the controller replaces atomically and writes nothing, so it answers while a controller runs.
            status, note = run_status(directory)
            print(json.dumps(status, indent=2))
            print(f"Report: {directory / 'report.html'}")
            print(note)
            print(outcome_lines(directory), end="")  # Last: what precedes `Report:` stays one JSON document.
            return
        with run_lock(directory):
            runtime = Pipeline(directory)
            if args.action == "automatic-step":
                if not args.live:
                    parser.error("automatic requires --live because it can launch an independent reviewer")
                from .automatic import UNAVAILABLE_EXIT, drive
                try:
                    commit = drive(runtime, single_step=True)
                except TransientInfraError as error:
                    parser.exit(UNAVAILABLE_EXIT, f"Interrupted: {error}\nNothing was stopped; the supervisor exits resumable.\n")
                if commit is None:
                    parser.exit(75, "Checkpoint persisted; continuing in a new controller process.\n")
                # No outcome block here: this child shares the terminal of `automatic`, `resume` or `launch`, which print it.
                print(f"Verified feature branch: {runtime.plan['source_branch']} at {commit}. No main merge or push.")
                return
            if args.action == "attach":
                print(json.dumps(attach_panels(runtime.sessions), indent=2)); return
            with SqliteSaver.from_conn_string(str(directory / "pipeline.sqlite")) as saver:
                graph = build_pipeline(saver, runtime)
                config = graph_config(runtime)
                state = graph.get_state(config)
                pending = [item.value.get("kind") for task in state.tasks for item in task.interrupts]
                value = None
                if args.action == "start":
                    if not args.live:
                        parser.error("start requires --live; do not use it for offline tests")
                    if state.values:
                        parser.error("Run already started; use status/explicit controls, never start again")
                    from .guardrails import challenge_gate, paused_message
                    warning = stale_claude_warning()
                    if warning:
                        print(warning, file=sys.stderr)
                    # A 2.2.0 run's design challenge decides before any worker launch; a pause exits 0 with the resume commands.
                    if not challenge_gate(runtime, args.herdr, lambda: action_event(runtime.event, actor, "start")):
                        print(paused_message(directory, args.herdr))
                        print(f"Report: {report(runtime, state)}")
                        return
                    value = {"run_id": runtime.plan["run_id"]}
                elif args.action == "freeze":
                    if pending != ["worker_handoff"]:
                        parser.error("Run is not waiting for worker handoff")
                    handoffs = parse_lane_files(args.handoff, "--handoff")
                    if set(handoffs) != set(runtime.workers):
                        parser.error(f"freeze requires --handoff <lane>=<path> once for each lane of this run ({', '.join(runtime.workers)})")
                    for node, handoff_path in handoffs.items():
                        save_json(directory / f"{node}.handoff.json", read_json(handoff_path))
                    value = Command(resume={"freeze": True})
                elif args.action == "review":
                    if pending != ["independent_review"] or not args.review_file:
                        parser.error("Review requires pending review and --review-file")
                    declared = reviewer_ids(runtime.plan)
                    reviewer_flags = args.reviewer or []
                    if len(reviewer_flags) > 1 or any("=" in item for item in reviewer_flags):
                        parser.error("review takes one --reviewer <id>")
                    reviewer = reviewer_flags[0] if reviewer_flags else (declared[0] if len(declared) == 1 else None)
                    if reviewer is None:
                        parser.error(f"--reviewer <id> is required: this run declares the reviewers {', '.join(declared)}")
                    if reviewer not in declared:
                        parser.error(f"--reviewer must be one of this run's reviewers ({', '.join(declared)}), got {reviewer!r}")
                    imported = read_json(args.review_file)
                    if isinstance(imported, dict) and "reviewers" in imported:
                        parser.error("--review-file is one reviewer's review (no reviewers list); the controller combines the imports")
                    bundle, digest = runtime.validate_bundle()
                    check_review(imported, bundle, digest)  # One reviewer's approved review, bound to the exact bundle.
                    save_json(directory / f"{review_node(reviewer)}.imported.json", {"reviewer_id": reviewer, "imported_at": now(), "review": imported})
                    imports = {}
                    for item in declared:
                        path = directory / f"{review_node(item)}.imported.json"
                        if path.exists():
                            imports[item] = read_json(path)
                    missing = [item for item in declared if item not in imports]
                    if missing:
                        print(f"Imported the {reviewer} review; still waiting for: {', '.join(missing)}. The run stays at the review gate.")
                        return
                    decision = combine_imported_reviews(bundle, digest, imports)
                    runtime.validate_review(decision)
                    value = Command(resume=decision)
                elif args.action == "approve":
                    if pending == ["independent_review"]:
                        imported = [item for item in reviewer_ids(runtime.plan) if (directory / f"{review_node(item)}.imported.json").exists()]
                        parser.error("Run is waiting for independent review: approve needs every declared reviewer imported and approved "
                                     f"(reviewers: {', '.join(reviewer_ids(runtime.plan))}; imported: {', '.join(imported) or 'none'})")
                    if pending != ["integration_approval"]:
                        parser.error("Run is not waiting for integration approval")
                    _, digest = runtime.validate_bundle()
                    if args.bundle_sha256 != digest:
                        parser.error("Provide the exact --bundle-sha256 displayed at approval")
                    runtime.validate_review(read_json(directory / "review.json"))  # Every declared reviewer approved.
                    action_event(runtime.event, actor, "approve", f"the fast-forward of bundle {digest[:12]}")
                    value = Command(resume={"approve": digest})
                elif args.action == "reconcile":
                    if pending or not state.next or not any(step.startswith("launch_") for step in state.next):
                        parser.error("Reconcile requires failed launch steps")
                    launches = [step.removeprefix("launch_") for step in state.next if step.startswith("launch_")]
                    if not all((directory / f"{node}.interactive.json").exists() for node in launches):
                        parser.error("No durable launch intent; cannot reconcile without potentially launching a new agent")
                    action_event(runtime.event, actor, "reconcile", ", ".join(launches))
                    for node in launches:
                        runtime.sessions.run(node)  # Existing receipt path never starts a new process.
                elif args.action == "retry":
                    from .repair import refuse_recorded
                    refuse_recorded(directory)  # Its counters and refs may exist already: only rerunning the repair continues.
                    if not state.values or pending or not state.next:
                        parser.error("Retry requires a failed graph step, not an interrupt/completed run")
                    if args.node:
                        if args.node not in runtime.workers:
                            parser.error(f"--node must be a lane of this run ({', '.join(runtime.workers)}), got {args.node!r}")
                        step = f"verify_{args.node}" if args.phase == "worker" else "candidate"
                        if step not in state.next:
                            parser.error("Selected check is not a failed/pending step")
                        if runtime.plan.get("automatic"):
                            from .automatic import RETRY_REQUESTS
                            from .repair import continuation
                            requests = read_json(directory / RETRY_REQUESTS) if (directory / RETRY_REQUESTS).exists() else {}
                            current = runtime.attempt(args.phase, args.node)
                            if (requests.get(f"{args.phase}:{args.node}") == current
                                    and not (directory / "verification" / args.phase / args.node / str(current)).exists()):
                                # Raised by an earlier retry and not run yet: raising it again would skip an attempt that never ran.
                                print(f"{args.phase}/{args.node} attempt {current} is already requested and has not run; nothing changed. "
                                      f"An automatic run continues under its supervisor: {continuation(runtime)}")
                                return
                        attempt = runtime.retry_check(args.phase, args.node)
                        action_event(runtime.event, actor, "retry", f"{args.phase}/{args.node} attempt {attempt}")
                        if runtime.plan.get("automatic"):
                            # Invoked here, the graph would run the review node, reviewer launches included, in this
                            # process; the supervisor's controller reruns the check at the raised attempt instead.
                            from .automatic import request_retry
                            from .repair import continuation
                            request_retry(runtime, args.phase, args.node, attempt)
                            print(f"{args.phase}/{args.node} will run attempt {attempt}; nothing ran. An automatic run continues "
                                  f"under its supervisor: {continuation(runtime)}")
                            return
                    # No new agent launch is ever permitted during retry.
                    if any(step.startswith("launch_") for step in state.next):
                        parser.error("Launch failure requires explicit session reconciliation; do not blindly retry")
                    if runtime.plan.get("automatic") and not (directory / "review.json").exists():
                        # Review is still ahead: invoked here, the graph would launch the reviewers in this process, without --live.
                        from .repair import continuation
                        parser.error(f"An automatic run continues under its supervisor until its review is recorded: {continuation(runtime)} "
                                     f"(a check or candidate step that left no verdict first needs retry --phase <phase> --node <lane> {BY_OPERATOR})")
                    if not args.node:
                        action_event(runtime.event, actor, "retry", ", ".join(state.next))
                try:
                    advance(runtime, graph, value, config)
                finally:
                    print(f"Report: {report(runtime, graph.get_state(config))}")
                if args.action == "approve" and graph.get_state(config).values.get("integrated_commit"):
                    from .guardrails import run_finished_note
                    note = run_finished_note(directory, runtime.plan)
                    if note:
                        print(note)
                if args.action == "start" and args.herdr:
                    print(json.dumps(attach_panels(runtime.sessions), indent=2))
    except (ValueError, RuntimeError, OSError, subprocess.SubprocessError) as error:
        # The supervisor's own Blocked line says only that a step exited 1: the outcome block says what the record holds.
        outcome = outcome_lines(directory) if args.action == "automatic" else ""
        parser.exit(1, f"Blocked: {error}\nAll work/evidence retained at {directory}. No automatic fallback or push.\n{outcome}")


if __name__ == "__main__":
    main()
