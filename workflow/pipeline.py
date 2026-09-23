"""Complete operator-driven graph: launch → freeze → verify → review → approve → integrate.

No agent starts without `start --live`. Operator controls are local CLI-only.

The worker lanes come from the run's plan (`plan.workers`, pinned at prepare from the policy
and an optional `--workers` selection): one `launch_<lane>` and one `verify_<lane>` node per
selected lane around the fixed tail. Excluded lanes keep their owned paths off-limits.
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
from typing import Annotated, TypedDict

from langgraph.checkpoint.sqlite import SqliteSaver
from langgraph.graph import END, START, StateGraph
from langgraph.types import Command, interrupt

from .checks import now, recheck_packet, verify_revision
from .export_state import export_state
from .interactive import REVIEW, InteractiveSessions, attach_panels, attach_reviewer_panel
from .sessions import (DEFAULT_REVIEWER, git, plan_excluded, plan_workers, prepare, read_json, review_node, reviewer_ids, run_lock, save_json,
                       validate_node_id, validate_reviewer_id)
from .verification import owns, policy_digest, safe_path, validate_policy
from .worktrees import git_worktree

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
    def __init__(self, directory: Path, sessions=None):
        self.directory = directory.resolve()
        self.plan = read_json(self.directory / "plan.json")
        if "automatic" in self.plan:
            from .automatic import validate_automatic
            validate_automatic(self.plan)
        self.policy = validate_pipeline_policy(read_json(self.directory / "policy.json"))
        if self.plan.get("policy_sha256") != policy_digest(self.policy):
            raise ValueError("Pinned policy changed")
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

    def stop_session(self, node: str) -> None:
        """Persist native identity before stopping. Never signal guessed/reused PIDs."""
        marker = self.directory / f"{node}.stop.json"
        if marker.exists():
            intent = read_json(marker)
        else:
            row = self.sessions.locate(node, self.sessions.inventory())
            if row is None:
                raise RuntimeError(f"{node} session missing before stop; reconcile before continuing")
            intent = {"background_id": row["id"], "session_id": row["sessionId"], "pid": row["pid"], "stopped": False}
            save_json(marker, intent)
        if not intent["stopped"]:
            rows = self.sessions.inventory()
            matching = [row for row in rows if row.get("sessionId") == intent["session_id"] and row.get("pid")]
            if matching:
                row = self.sessions.locate(node, rows)
                if row is None or row["id"] != intent["background_id"] or row["pid"] != intent["pid"]:
                    raise RuntimeError(f"Native {node} session identity changed after stop intent; reconcile manually")
                result = subprocess.run([self.sessions.executable, "stop", intent["background_id"]], capture_output=True, text=True, timeout=20)
                if result.returncode != 0:
                    raise RuntimeError(f"Stop failed for {node}; inspect native session before retrying")
            # Recover stop-before-receipt without issuing another stop command.
            rows = self.sessions.inventory()
            if any(row.get("sessionId") == intent["session_id"] and row.get("pid") for row in rows) or pid_alive(intent["pid"]):
                raise RuntimeError(f"{node} termination is not established; retry after reconciliation")
            intent["stopped"] = True
            save_json(marker, intent)

    def stop_workers(self):
        for node in self.workers:
            self.stop_session(node)
        stopped_ids = {read_json(self.directory / f"{node}.stop.json")["session_id"] for node in self.workers}
        if any(row.get("sessionId") in stopped_ids and row.get("pid") for row in self.sessions.inventory()):
            raise RuntimeError("A stopped worker was restarted; reconcile before snapshot capture")
        self.event("freeze", "stopped", f"Native workers stopped before snapshot capture: {', '.join(self.workers)}")

    def stop_reviewer(self, reviewer_id: str = DEFAULT_REVIEWER):
        self.stop_session(review_node(reviewer_id))
        self.event(REVIEW, "stopped", f"Reviewer {reviewer_id} session stopped; its transcript stays resumable")

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
        self.stop_workers()
        # Ownership is enforced from the full declared policy: an excluded lane's paths are off-limits to every selected lane.
        excluded_paths = [(other, safe_path(prefix)) for other in self.excluded for prefix in self.worker_policy(other)["owned_paths"]]
        snapshots = {}
        for node in self.workers:
            worker = self.worker_policy(node)
            cwd = Path(self.plan["nodes"][node]["worktree"])
            if git(cwd, "rev-parse", "HEAD") != self.plan["base_commit"]:
                raise ValueError("Worker changed HEAD; reconcile commits rather than silently accepting them")
            changed = changed_files(cwd, self.plan["base_commit"])
            for name in changed:
                safe_path(name)
                for other, prefix in excluded_paths:
                    if owns(name, prefix):
                        raise ValueError(f"Ownership violation: {node} edited {name}, owned by excluded lane {other}")
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
                for node in self.workers}

    def verify(self, node: str, snapshots: dict) -> str:
        snap = snapshots[node]
        attempt = self.attempt("worker", node)
        self.event(f"verify_{node}", "running", f"Attempt {attempt}; revision {snap['commit']}")
        packet = verify_revision(self.directory, self.plan, self.policy, node, snap["commit"], snap["changed_files"], snap["session_id"], attempt=attempt)
        path = self.directory / "verification" / "worker" / node / str(attempt) / "packet.json"
        drill = self.failure_drill()
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
        passed = "Required tests and artifacts passed"
        if packet["gate"].get("deferred_checks"):
            passed += "; recorded for the candidate gate: " + ", ".join(packet["gate"]["deferred_checks"])
        self.event(f"verify_{node}", packet["gate"]["status"], "; ".join(packet["gate"]["reasons"]) or passed)
        if packet["gate"]["status"] != "passed":
            raise RuntimeError(f"{node} verification blocked; see {path}. Retry explicitly or start a revised run.")
        return str(path)

    def candidate(self, state: PipelineState) -> str:
        # Validate branch evidence again before combining anything.
        worker_paths = [Path(state["packets"][node]) for node in self.workers]
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
            git_worktree(self.plan["repository"], "add", "--detach", str(cwd), self.plan["base_commit"])
            for node in self.workers:  # Declared order, selected lanes only.
                commit = state["snapshots"][node]["commit"]
                if commit != self.plan["base_commit"]:
                    subprocess.run(["git", "-C", str(cwd), "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "cherry-pick", commit], env=commit_env(), check=True, capture_output=True)
            candidate = {"commit": git(cwd, "rev-parse", "HEAD"), "worktree": str(cwd)}
            save_json(saved, candidate)
        candidate_paths = []
        for node in self.workers:
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
                     "workers_with_changed_launch_evidence": [node for node in self.workers if before.get(node) != after.get(node)],
                     "verification_attempts": {node: sorted(int(item.name) for item in (self.directory / "verification" / "worker" / node).iterdir() if item.is_dir() and item.name.isdigit()) for node in self.workers},
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

    def validate_review(self, review: dict, require_approved: bool = True) -> None:
        """The combined record must name exactly this run's declared reviewers; approval needs every one of them."""
        bundle, digest = self.validate_bundle()
        check_review(review, bundle, digest, require_approved=require_approved, reviewers=reviewer_ids(self.plan))

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


def export_run(runtime: ExportRuntime) -> dict:
    """Re-export from the persisted checkpoint. Reading state never invokes a node or a session."""
    from types import SimpleNamespace
    database = runtime.directory / "pipeline.sqlite"
    if database.exists():
        config = {"configurable": {"thread_id": runtime.plan["run_id"]}}
        with SqliteSaver.from_conn_string(str(database)) as saver:
            state = carry_legacy_lanes(runtime, build_pipeline(saver, runtime).get_state(config), saver)
    else:
        state = SimpleNamespace(values={}, next=tuple(f"launch_{node}" for node in runtime.workers), tasks=[])  # Prepared, never started.
    return export_state(runtime, state)


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
            graph.invoke({"run_id": runtime.plan["run_id"]}, config)
        finally:
            print(f"Report: {report(runtime, graph.get_state(config))}")
    if attach:
        print(json.dumps(attach_panels(runtime.sessions), indent=2))


def graph_config(runtime) -> dict:
    """One LangGraph thread per run; every lane's fan-out step may run concurrently."""
    return {"configurable": {"thread_id": runtime.plan["run_id"]}, "max_concurrency": max(2, len(runtime.workers))}


def report(runtime: Pipeline, state) -> Path:
    """Escaped local results viewer, generated on every CLI boundary; no server needed."""
    state = carry_legacy_lanes(runtime, state)  # `status` on a legacy run must export the same evidence as `export`.
    export_state(runtime, state)
    events_path = runtime.directory / "events.jsonl"
    events = [json.loads(line) for line in events_path.read_text().splitlines()] if events_path.exists() else []
    packets = list((runtime.directory / "verification").glob("*/*/*/packet.json"))
    flow = ("Launch workers → completion signals → isolated checks → combined checks → independent review → verified feature branch (no main merge or push)"
            if runtime.plan.get("automatic") else "Launch workers → human handoff → isolated checks → combined checks → independent review → approval → integration")
    parts = ['<!doctype html><meta charset="utf-8"><title>Workflow report</title><style>body{font:16px system-ui;max-width:1100px;margin:40px auto;background:#151820;color:#eee}pre{white-space:pre-wrap}a{color:#8dcaff}img{max-width:100%}section{border:1px solid #555;padding:16px;margin:16px 0}</style>',
             '<h1>Workflow report</h1><p>' + html.escape(flow) + '</p>',
             '<h2>Current state</h2><pre>' + html.escape(json.dumps({"next": state.next, "interrupts": [str(task.interrupts) for task in state.tasks if task.interrupts], "errors": [str(task.error) for task in state.tasks if task.error], "integrated_commit": state.values.get("integrated_commit")}, indent=2)) + '</pre>',
             '<h2>Timeline</h2><pre>' + html.escape(json.dumps(events, indent=2)) + '</pre>']
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
    destination = runtime.directory / "report.html"
    destination.write_text("\n".join(parts))
    return destination


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["preflight", "prepare", "start", "automatic", "automatic-step", "attach", "freeze", "retry", "reconcile", "review", "approve", "status", "export"],
                        help="resume and answer (feature.json 2.2.0 runs) have their own options: python -m workflow resume|answer --help")
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
    args = parser.parse_args()
    directory = args.directory.resolve()
    try:
        if args.action == "preflight":
            if not args.policy:
                parser.error("preflight requires --policy")
            policy = validate_pipeline_policy(read_json(args.policy))
            if git(args.repo.resolve(), "status", "--porcelain"):
                raise ValueError("Source must be clean before prepare")
            for executable in ("git", "claude", "node"):
                if not shutil.which(executable):
                    raise ValueError(f"Missing executable: {executable}")
            help_text = subprocess.check_output(["claude", "--help"], text=True, timeout=15)
            required_flags = ["--bg", "--safe-mode", "--tools", "--permission-mode"]
            if args.automatic:
                # Workers: --dangerously-skip-permissions. Native reviewer: --add-dir and --allowedTools.
                # Print-mode reviewer (--reviewer-transport print): --json-schema, --print, --permission-prompts.
                required_flags += ["--dangerously-skip-permissions", "--add-dir", "--allowedTools", "--json-schema", "--print", "--permission-prompts"]
            if not all(flag in help_text for flag in required_flags):
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
            elif args.decisions or args.prd or args.no_challenge:
                parser.error("--decisions, --prd and --no-challenge apply to prepare --guardrails (feature.json 2.2.0) only")
            tasks = {}
            for worker in policy["workers"]:
                node = worker["node_id"]
                if node in selected:
                    tasks[node] = pinned_task(task_files[node].read_text(), worker)
            reviewers = parse_reviewer_files(args.reviewer, declared)
            plan = prepare(directory, args.repo, "HEAD", tasks, True, declared=declared)
            if reviewers:
                plan["reviewers"] = reviewers
            drill = policy.get("failure_drill")
            drill_skipped = bool(drill) and drill["node_id"] not in selected
            plan.update(mode="interactive", policy_sha256=policy_digest(policy), created_at=now(), source_branch=git(args.repo.resolve(), "symbolic-ref", "--short", "HEAD"),
                        failure_drill=None if drill_skipped else drill)
            if args.guardrails:
                pin_guardrails(plan, directory, {node: task_files[node] for node in selected}, args.decisions, args.prd, not args.no_challenge)
            if args.automatic:
                from .automatic import automatic_settings
                plan["automatic"] = automatic_settings(args.worker_timeout_seconds, args.review_timeout_seconds, args.reviewer_transport)
            elif args.worker_timeout_seconds or args.review_timeout_seconds or args.reviewer_transport:
                parser.error("Timeouts and the reviewer transport apply to --automatic runs only; manual runs have operator-controlled lifetimes and review")
            save_json(directory / "policy.json", policy)
            save_json(directory / "plan.json", plan)
            from types import SimpleNamespace
            runtime = Pipeline(directory)
            if drill_skipped:
                runtime.event("controller", "running", f"Failure drill skipped: its lane {drill['node_id']} is not selected for this run")
            export_state(runtime, SimpleNamespace(values={}, next=tuple(f"launch_{node}" for node in selected), tasks=[]))
            print(f"Prepared {directory}; no agents launched. Pin: {plan['base_commit']}. Lanes: {', '.join(selected)}"
                  + (f" (excluded: {', '.join(plan['excluded_workers'])})" if plan["excluded_workers"] else "")
                  + f". Reviewers: {', '.join(reviewer_ids(plan))}")
            return
        if args.action == "automatic":
            if not args.live:
                parser.error("automatic requires --live because it can launch an independent reviewer")
            from .automatic import supervise
            supervise(directory)
            print(f"Automatic run reached a verified feature branch. Evidence: {directory / 'report.html'}. No main merge or push.")
            return
        if args.action == "export":
            # Re-export an existing run (for example one recorded before a newer export version).
            with run_lock(directory):
                exported = export_run(ExportRuntime(directory))
            print(f"Exported run-state.json version {exported['version']}: {directory / 'run-state.json'}. No agents launched.")
            return
        with run_lock(directory):
            runtime = Pipeline(directory)
            if args.action == "automatic-step":
                if not args.live:
                    parser.error("automatic requires --live because it can launch an independent reviewer")
                from .automatic import drive
                commit = drive(runtime, single_step=True)
                if commit is None:
                    parser.exit(75, "Checkpoint persisted; continuing in a new controller process.\n")
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
                    # A 2.2.0 run's design challenge decides before any worker launch; a pause exits 0 with the resume commands.
                    if not challenge_gate(runtime):
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
                        if args.node not in runtime.workers:
                            parser.error(f"--node must be a lane of this run ({', '.join(runtime.workers)}), got {args.node!r}")
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
                    status = {"workers": runtime.workers, "excluded_workers": runtime.excluded, "next": state.next, "pending": pending,
                              "errors": [str(task.error) for task in state.tasks if task.error]}
                    if (directory / "challenge.json").exists():
                        status["challenge"] = read_json(directory / "challenge.json")["status"]
                    print(json.dumps(status, indent=2))
                    print(f"Report: {report(runtime, state)}")
    except (ValueError, RuntimeError, OSError, subprocess.SubprocessError) as error:
        parser.exit(1, f"Blocked: {error}\nAll work/evidence retained at {directory}. No automatic fallback or push.\n")


if __name__ == "__main__":
    main()
