"""Automatic supervision of the existing LangGraph, never a second agent scheduler.

Workers remain native interactive Claude sessions. Review is a separate read-only
Claude invocation owned by the graph's review node. No push or main integration.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import time
import uuid
from datetime import datetime
from pathlib import Path

from langgraph.checkpoint.sqlite import SqliteSaver
from langgraph.types import Command

from .checks import now
from .sessions import DEFAULT_REVIEWER, git, plan_reviewers, plan_workers, read_json, review_node, reviewer_ids, run_lock, save_json, terminate

DEFAULTS = {"finish": "verified-feature-branch", "permission_mode": "bypassPermissions",
            "worker_timeout_seconds": 4 * 3600, "review_timeout_seconds": 1800, "reviewer_transport": "native"}
TIMEOUT_KEYS = ("worker_timeout_seconds", "review_timeout_seconds")
REVIEWER_TRANSPORTS = ("native", "print")
# Plans pinned before the native reviewer existed lack reviewer_transport; they mean native.
REQUIRED_KEYS = frozenset(DEFAULTS) - {"reviewer_transport"}


def automatic_settings(worker_timeout_seconds: int | None = None, review_timeout_seconds: int | None = None,
                       reviewer_transport: str | None = None) -> dict:
    """Run-scoped automatic configuration; deadlines and transport are pinned into plan.json at prepare."""
    settings = dict(DEFAULTS)
    for key, value in (("worker_timeout_seconds", worker_timeout_seconds), ("review_timeout_seconds", review_timeout_seconds),
                       ("reviewer_transport", reviewer_transport)):
        if value is not None:
            settings[key] = value
    validate_automatic({"automatic": settings, "source_branch": "feature/validation-only"})
    return settings


def validate_automatic(plan: dict) -> None:
    settings = plan.get("automatic")
    if not isinstance(settings, dict) or not REQUIRED_KEYS <= set(settings) <= set(DEFAULTS):
        raise ValueError("Malformed automatic run configuration")
    if settings["finish"] != DEFAULTS["finish"] or settings["permission_mode"] != "bypassPermissions":
        raise ValueError("Unsupported automatic authority")
    for key in TIMEOUT_KEYS:
        if type(settings[key]) is not int or not 1 <= settings[key] <= 86400:
            raise ValueError("Automatic timeouts must be bounded positive seconds (at most 86400)")
    if "reviewer_transport" in settings and settings["reviewer_transport"] not in REVIEWER_TRANSPORTS:
        raise ValueError("Unsupported reviewer transport; expected native or print")
    if not plan.get("source_branch", "").startswith("feature/"):
        raise ValueError("Automatic completion is restricted to a feature/ branch")


def reviewer_transport(plan: dict) -> str:
    """Effective transport: plans that predate the setting are native, though they never launch a new reviewer."""
    return plan["automatic"].get("reviewer_transport", "native")


def completion_prompt(directory: Path, plan: dict, node: str) -> str:
    example = {"version": "1.0.0", "run_id": plan["run_id"], "node_id": node,
               "launch_token": plan["nodes"][node]["session_id"], "status": "completed",
               "summary": "Describe actual work and checks executed", "open_assumptions": []}
    return ("\n\nAUTOMATIC MODE: permission checks are bypassed and Bash is available. "
            "Do not wait for a human handoff. Stay within assigned ownership; do not commit, merge, push, "
            "launch agents, change runtime evidence or switch billing/provider. "
            "On completion write the following JSON shape atomically (temporary file then rename) to "
            f"{directory / (node + '.completion.json')}. This one output file is allowed outside your worktree. "
            "Use status blocked if you cannot finish; never manufacture checks. Write it as your last action, "
            "then finish your turn and do not modify more files. Controller checks and independent review "
            "still determine acceptance.\n" + json.dumps(example))


def read_completion(runtime, node: str) -> dict:
    path = runtime.directory / f"{node}.completion.json"
    if path.is_symlink() or not path.is_file() or path.stat().st_size > 65536:
        raise ValueError(f"Invalid completion file for {node}")
    item = read_json(path)
    expected = {"version", "run_id", "node_id", "launch_token", "status", "summary", "open_assumptions"}
    if not isinstance(item, dict) or set(item) != expected:
        raise ValueError("Malformed completion signal")
    if (item["version"] != "1.0.0" or item["run_id"] != runtime.plan["run_id"] or item["node_id"] != node
            or item["launch_token"] != runtime.plan["nodes"][node]["session_id"]):
        raise ValueError("Stale or foreign worker completion signal")
    if item["status"] not in {"completed", "blocked"} or not isinstance(item["summary"], str) or not item["summary"].strip():
        raise ValueError("Invalid completion status/summary")
    if not isinstance(item["open_assumptions"], list) or any(not isinstance(x, str) for x in item["open_assumptions"]):
        raise ValueError("Invalid completion assumptions")
    if item["status"] == "blocked":
        raise RuntimeError(f"Worker {node} explicitly blocked: {item['summary']}")
    return {"summary": item["summary"], "open_assumptions": item["open_assumptions"]}


def lanes(runtime) -> list[str]:
    """The run's selected lanes, from the runtime when it resolved them or from its plan."""
    return list(getattr(runtime, "workers", None) or plan_workers(runtime.plan))


def wait_handoffs(runtime, *, clock=time.time, sleep=time.sleep) -> None:
    """Idle alone never means completion. Deadlines survive controller restart."""
    validate_automatic(runtime.plan)
    workers = lanes(runtime)
    if any((runtime.directory / f"{node}.stop.json").exists() for node in workers):
        # Recover a controller crash after durable handoffs/stop intent, before snapshot.
        for node in workers:
            if read_completion(runtime, node) != read_json(runtime.directory / f"{node}.handoff.json"):
                raise RuntimeError("Handoff changed after stop intent")
        return
    attention: set[str] = set()
    while True:
        rows = runtime.sessions.inventory()
        handoffs = {}
        for node in workers:
            receipt = read_json(runtime.directory / f"{node}.interactive.json")
            started = datetime.fromisoformat(receipt["launch_requested_at"]).timestamp()
            if clock() >= started + runtime.plan["automatic"]["worker_timeout_seconds"]:
                raise RuntimeError(f"Worker {node} deadline exhausted; no automatic relaunch")
            row = runtime.sessions.locate(node, rows)
            if row is None:
                raise RuntimeError("Native worker missing; reconciliation required")
            if row["state"] == "blocked" and node not in attention:
                # A native session reports `blocked` when its turn ended needing a human: a question,
                # a permission prompt or a refusal the harness could not continue past. That is not a
                # failure of the lane, and the other lanes keep working. The operator may answer in the
                # pane; the worker deadline bounds the wait. No billing/provider fallback.
                attention.add(node)
                runtime.event(node, "interactive", f"Worker {node} needs attention in its pane (native state blocked); "
                                                   "waiting until its deadline")
            elif row["state"] != "blocked":
                attention.discard(node)
            path = runtime.directory / f"{node}.completion.json"
            if row["state"] in {"idle", "done"} and path.exists():
                handoffs[node] = read_completion(runtime, node)
        if set(handoffs) == set(workers):
            for node, value in handoffs.items():
                save_json(runtime.directory / f"{node}.handoff.json", value)
            return
        sleep(2)


# Finding attributions that name no single lane; the run's lane ids complete the vocabulary.
FINDING_ATTRIBUTIONS = ("multiple", "none")


def finding_workers(runtime) -> list[str]:
    """The `worker` vocabulary of this run's findings: its lane ids, then multiple and none."""
    return [*lanes(runtime), *FINDING_ATTRIBUTIONS]


def worker_vocabulary(runtime) -> str:
    """How the prompts spell the vocabulary: `ui, adapter, multiple or none`."""
    words = finding_workers(runtime)
    return ", ".join(words[:-1]) + " or " + words[-1]


def review_schema(runtime) -> dict:
    """The structured-output schema of the print-mode reviewer, generated from the run's lanes."""
    return {
        "type": "object", "additionalProperties": False, "required": ["verdict", "findings"],
        "properties": {
            "verdict": {"enum": ["approved", "blocked"]},
            "findings": {"type": "array", "items": {
                "type": "object", "additionalProperties": False,
                "required": ["severity", "message", "disposition", "worker", "requirement"],
                "properties": {"severity": {"enum": ["P0", "P1", "P2"]}, "message": {"type": "string", "minLength": 1},
                               "disposition": {"enum": ["open", "resolved", "accepted"]},
                               "worker": {"enum": finding_workers(runtime)},
                               "requirement": {"type": ["string", "null"], "minLength": 1}}}}}
    }


def check_finding_lanes(runtime, findings: list) -> None:
    """A finding's `worker` is one of this run's selected lanes, `multiple` or `none`; anything else is refused."""
    allowed = set(finding_workers(runtime))
    for finding in findings:
        worker = finding.get("worker") if isinstance(finding, dict) else None
        if worker not in allowed:
            raise RuntimeError(f"Review finding names worker {worker!r}, which is not a lane of this run ({worker_vocabulary(runtime)})")


REVIEW_COMPLETION_LIMIT = 262144
REVIEW_RESUME_NOTE = ("Controller interrupted while waiting for the reviewers. The native reviewer sessions were NOT stopped "
                      "and keep running; resume with: python -m workflow automatic {directory} --live")
BUILTIN_REVIEW_BRIEF = Path(__file__).resolve().parent / "prompts" / "review.md"


def reviewers(runtime) -> list[dict]:
    """The run's declared reviewers in order; a plan without `reviewers` runs the single default reviewer."""
    return plan_reviewers(runtime.plan)


def review_brief(reviewer: dict | None) -> str:
    """A reviewer's own brief (pinned into the plan at prepare) or the built-in one from workflow/prompts/review.md."""
    text = (reviewer or {}).get("prompt") or BUILTIN_REVIEW_BRIEF.read_text()
    return " ".join(text.split())


def review_prompt(runtime, patch: Path, reviewer: dict | None = None) -> str:
    """The brief followed by the fixed blocks every reviewer gets: bundle paths, task locations, lane vocabulary."""
    return (review_brief(reviewer) + " "
            f"Diff: {patch}. Bundle: {runtime.directory / 'review-bundle.json'}. "
            f"Requirements: each worker's task text pinned in {runtime.directory / 'plan.json'} under nodes.<worker>.task, "
            "and the feature/contract READMEs those tasks cite (for this repository, features/<feature>/README.md and contracts/projects/README.md). "
            f"This run's worker lanes are: {', '.join(lanes(runtime))}. "
            f"For every finding name the worker it concerns ({worker_vocabulary(runtime)}: multiple when it concerns several lanes, "
            "none for cross-cutting/policy findings) and, as `requirement`, a verbatim quote from that worker's task text that the "
            "finding relates to, or null when no single requirement applies. Never paraphrase a quote.")


def completion_protocol_prompt(runtime, launch_token: str, digest: str, candidate_commit: str, reviewer_id: str = DEFAULT_REVIEWER) -> str:
    """The native reviewer reports its verdict only through a bound completion file of its own."""
    node = review_node(reviewer_id)
    completion = runtime.directory / f"{node}.completion.json"
    example = {"version": "1.2.0", "run_id": runtime.plan["run_id"], "node_id": node, "launch_token": launch_token,
               "bundle_sha256": digest, "candidate_commit": candidate_commit, "verdict": "approved",
               "findings": [{"severity": "P2", "message": "Describe the concrete defect and where it is", "disposition": "open",
                             "worker": lanes(runtime)[0], "requirement": "a verbatim quote from that worker's task text, or null"}]}
    others = [item["reviewer_id"] for item in reviewers(runtime) if item["reviewer_id"] != reviewer_id]
    independence = (f" You are reviewer `{reviewer_id}`; the reviewers {', '.join(others)} review the same candidate independently "
                    "in their own sessions. Do not read their completion files or wait for them; every reviewer must approve." if others else "")
    return ("\n\nREVIEW COMPLETION PROTOCOL: you run as a native session. A human may type in this terminal; the transcript "
            f"is the record, but your verdict is only the file {completion}. Write exactly this JSON shape there "
            "(schema: contracts/workflow/reviewCompletion.schema.json in this checkout when present):\n" + json.dumps(example) + "\n"
            "Keep version, run_id, node_id, launch_token, bundle_sha256 and candidate_commit exactly as shown; the controller "
            "rejects any other binding without launching another reviewer. verdict is approved or blocked. Each finding "
            "has severity P0, P1 or P2 (P2 is the lowest; there is no P3, use P2 for minor items), disposition open, "
            f"resolved or accepted, worker ({worker_vocabulary(runtime)}; never both) and requirement (a verbatim quote from that "
            "worker's task text in plan.json under nodes.<worker>.task, or null); no other keys. A file that does not "
            "match this shape exactly is rejected as a whole. This completion file is the only write you are allowed. It cannot "
            "be written under a temporary name and renamed, so write it once, complete, as your last action, then end your "
            "turn and do not modify it afterwards. The controller accepts it only when your session is idle. A blocked verdict "
            "or any unresolved P0/P1 finding ends the run; no second reviewer is launched." + independence)


def combined_status_path(runtime) -> Path:
    return runtime.directory / "automatic-review.json"


def reviewer_status_path(runtime, reviewer_id: str) -> Path:
    """`automatic-review-<id>.json`; the default reviewer's own status lives in the combined file."""
    return runtime.directory / f"automatic-{review_node(reviewer_id)}.json"


class ReviewStatus:
    """The combined review status plus one status per reviewer, persisted together.

    The default reviewer keeps today's single file: its own keys (launch token, session, decision) are
    merged into `automatic-review.json`, whose combined `status` wins. Declared reviewers each get
    `automatic-review-<id>.json` beside the combined file.
    """

    def __init__(self, runtime, combined: dict, statuses: dict):
        self.runtime, self.combined, self.statuses = runtime, combined, statuses
        # Accepted decisions live here until the combined decision persists them (or a deadline/rejection retains them).
        self.decisions: dict = {}

    @property
    def ids(self) -> list[str]:
        return list(self.statuses)

    @classmethod
    def load(cls, runtime) -> "ReviewStatus":
        combined = read_json(combined_status_path(runtime))
        ids = combined.get("reviewers") or reviewer_ids(runtime.plan)
        statuses = {}
        for reviewer_id in ids:
            path = reviewer_status_path(runtime, reviewer_id)
            statuses[reviewer_id] = read_json(path) if path.exists() else {"reviewer_id": reviewer_id, "node_id": review_node(reviewer_id), "status": "pending"}
        return cls(runtime, combined, statuses)

    def save(self) -> None:
        merged = {}
        for reviewer_id, status in self.statuses.items():
            path = reviewer_status_path(self.runtime, reviewer_id)
            if path == combined_status_path(self.runtime):
                merged = status
            else:
                save_json(path, status)
        save_json(combined_status_path(self.runtime), {**merged, **self.combined})

    def record_decisions(self) -> None:
        for reviewer_id, decision in self.decisions.items():
            self.statuses[reviewer_id]["decision"] = decision

    def supersede_running(self) -> None:
        """A reviewer still working when the run is decided is stopped; its status records why nothing waited for it."""
        for status in self.statuses.values():
            if status.get("status") in {"pending", "launching", "running"}:
                status["status"] = "superseded"


def read_review_completion(runtime, reviewer_id: str = DEFAULT_REVIEWER) -> dict:
    """Accept a reviewer's file only when it validates and is bound to this exact run, reviewer, launch, bundle and candidate."""
    from jsonschema.exceptions import ValidationError
    from .verification import validate_schema
    node = review_node(reviewer_id)
    path = runtime.directory / f"{node}.completion.json"
    if path.is_symlink() or not path.is_file() or path.stat().st_size > REVIEW_COMPLETION_LIMIT:
        raise RuntimeError(f"Invalid review completion file ({reviewer_id})")
    try:
        item = read_json(path)
    except ValueError as error:
        raise RuntimeError(f"Malformed review completion signal ({reviewer_id}): {error}") from None
    try:
        validate_schema("reviewCompletion", item)
    except ValidationError as error:
        raise RuntimeError(f"Review completion signal ({reviewer_id}) violates the schema: {error.message}") from None
    status = read_json(reviewer_status_path(runtime, reviewer_id))
    bundle, digest = runtime.validate_bundle()
    if (item["run_id"] != runtime.plan["run_id"] or item["node_id"] != node or item["launch_token"] != status.get("launch_token")
            or item["bundle_sha256"] != digest or item["candidate_commit"] != bundle["candidate_commit"]):
        raise RuntimeError(f"Stale or foreign review completion signal ({reviewer_id})")
    check_finding_lanes(runtime, item["findings"])
    return {"verdict": item["verdict"], "findings": item["findings"]}


def decision_blocks(decision: dict) -> bool:
    """A blocked verdict or an unresolved P0/P1 from any one reviewer blocks the run."""
    from .pipeline import blocking_findings
    return decision["verdict"] != "approved" or bool(blocking_findings(decision["findings"]))


def wait_reviews(runtime, state: ReviewStatus | None = None, *, clock=None, sleep=None) -> dict:
    """Poll every reviewer's receipt. Idle alone never means a verdict; each deadline counts from that reviewer's own launch.

    Returns the accepted decisions by reviewer id (also kept in `state.decisions`) as soon as every reviewer approved,
    or as soon as one accepted file blocks (the others are not waited for). A rejected file, an expired deadline or
    a missing session raises.
    """
    clock = clock or time.time
    sleep = sleep or time.sleep
    validate_automatic(runtime.plan)
    state = state or ReviewStatus.load(runtime)
    timeout = runtime.plan["automatic"]["review_timeout_seconds"]
    started = {}
    for reviewer_id in state.ids:
        receipt = read_json(runtime.directory / f"{review_node(reviewer_id)}.interactive.json")
        started[reviewer_id] = datetime.fromisoformat(receipt["launch_requested_at"]).timestamp()
    decisions = state.decisions
    attention = set()
    while True:
        rows = runtime.sessions.inventory()
        for reviewer_id in state.ids:
            if reviewer_id in decisions:
                continue
            node = review_node(reviewer_id)
            status = state.statuses[reviewer_id]
            if clock() >= started[reviewer_id] + timeout:
                status.update(status="blocked", error="Reviewer deadline exhausted; no second reviewer is launched")
                state.save()
                raise RuntimeError(f"Reviewer {reviewer_id} deadline exhausted; no second reviewer is launched")
            row = runtime.sessions.locate(node, rows)
            if row is None:
                raise RuntimeError(f"Native reviewer {reviewer_id} missing; reconciliation required")
            if row["state"] == "blocked" and reviewer_id not in attention:
                # A native session reports `blocked` when it needs a human: a question or a prompt
                # it cannot answer itself. The operator may answer in the pane; the deadline bounds it.
                attention.add(reviewer_id)
                runtime.event("review", "interactive", f"Reviewer {reviewer_id} needs attention in its pane (native state blocked); waiting until the deadline")
            if row["state"] in {"idle", "done"} and (runtime.directory / f"{node}.completion.json").exists():
                try:
                    decision = read_review_completion(runtime, reviewer_id)
                except RuntimeError as error:
                    status.update(status="blocked", error=str(error))
                    state.save()
                    raise
                decisions[reviewer_id] = decision
                status.update(status="accepted", accepted_at=now())
                state.save()
                if decision_blocks(decision):
                    return decisions  # The first block decides; nobody waits for the other reviewers.
        if set(decisions) == set(state.ids):
            return decisions
        sleep(2)


def review_candidate(runtime) -> dict:
    """Called only by the LangGraph review node. Ambiguous invocations never replay."""
    validate_automatic(runtime.plan)
    bundle, digest = runtime.validate_bundle()
    if combined_status_path(runtime).exists():
        state = ReviewStatus.load(runtime)
        combined = state.combined
        if combined.get("bundle_sha256") == digest and combined.get("status") == "succeeded":
            runtime.validate_review(combined["review"])
            if combined.get("transport") == "native":
                # Accepted earlier, but a stop was not confirmed: retry it (the stop intent makes it idempotent).
                for reviewer_id in state.ids:
                    if not reviewer_stopped(runtime, reviewer_id):
                        runtime.stop_reviewer(reviewer_id)
            return combined["review"]
        if combined.get("bundle_sha256") == digest and combined.get("transport") == "native" and combined.get("status") in {"running", "needs_reconciliation"}:
            # The reviewers kept running while the controller was away: bind what the launches produced, never launch again.
            rebind_reviewers(runtime, state)
            return _accept_native(runtime, bundle, digest, state)
        raise RuntimeError("Prior reviewer invocation needs reconciliation; no automatic relaunch")
    cwd = runtime.directory / "review-worktree"
    if cwd.exists():
        raise RuntimeError("Partial review worktree exists; reconcile rather than overwrite")
    subprocess.run(["git", "-C", runtime.plan["repository"], "worktree", "add", "--detach", str(cwd), bundle["candidate_commit"]],
                   check=True, capture_output=True)
    patch = runtime.directory / "review.diff"
    with patch.open("w") as handle:
        subprocess.run(["git", "-C", str(cwd), "diff", "--binary", runtime.plan["base_commit"], bundle["candidate_commit"]], stdout=handle, check=True)
    if reviewer_transport(runtime.plan) == "print":
        return _review_print(runtime, bundle, digest, cwd, patch)
    return _review_native(runtime, bundle, digest, patch)


def rebind_reviewers(runtime, state: ReviewStatus) -> None:
    """Resume: every reviewer receipt is rebound to the one session its launch produced; a reviewer without a receipt
    (its launch was never issued) leaves the run at needs_reconciliation and nothing is launched."""
    combined = state.combined
    partial = combined.get("status") == "needs_reconciliation"
    for reviewer_id in state.ids:
        status = state.statuses[reviewer_id]
        receipt = runtime.directory / f"{review_node(reviewer_id)}.interactive.json"
        if not receipt.exists():
            status.update(status="needs_reconciliation", error=status.get("error") or "No launch receipt; the launch was never issued")
            combined.update(status="needs_reconciliation", error=f"Reviewer {reviewer_id} needs reconciliation; no automatic relaunch")
            state.save()
            raise RuntimeError(f"Reviewer {reviewer_id} needs reconciliation; no automatic relaunch")
        if partial or not status.get("session_id"):
            try:
                bound = runtime.reconcile_reviewer(reviewer_id)
            except Exception as error:
                status.update(status="needs_reconciliation", error=str(error))
                combined.update(status="needs_reconciliation", error=str(error))
                state.save()
                raise
            status.update(session_id=bound["session_id"], background_id=bound.get("background_id"), status="running")
            status.pop("error", None)
            state.save()
    combined["status"] = "running"
    combined.pop("error", None)
    state.save()


def reviewer_stopped(runtime, reviewer_id: str = DEFAULT_REVIEWER) -> bool:
    """Only a confirmed stop intent counts; an absent or unconfirmed one means the stop is still owed."""
    marker = runtime.directory / f"{review_node(reviewer_id)}.stop.json"
    return marker.exists() and read_json(marker).get("stopped") is True


def stop_reviewers(runtime, ids: list[str]) -> list[str]:
    """Stop every reviewer, continuing past failures; the unconfirmed ones are returned."""
    errors = []
    for reviewer_id in ids:
        try:
            runtime.stop_reviewer(reviewer_id)
        except Exception as error:
            errors.append(f"{reviewer_id}: {error}")
    return errors


def combined_review(runtime, bundle: dict, digest: str, state: ReviewStatus, decisions: dict) -> dict:
    """review.json over the set: unanimous approval passes; any block, unresolved P0/P1, missing or rejected verdict blocks."""
    entries, findings = [], []
    for reviewer_id in state.ids:
        status = state.statuses[reviewer_id]
        decision = decisions.get(reviewer_id)
        entries.append({"reviewer_id": reviewer_id, "session_id": status.get("session_id"),
                        "verdict": decision["verdict"] if decision else None, "accepted_at": status.get("accepted_at") if decision else None})
        if decision:
            findings.extend({**finding, "reviewer": reviewer_id} for finding in decision["findings"])
    blocked = any(reviewer_id not in decisions or decision_blocks(decisions[reviewer_id]) for reviewer_id in state.ids)
    sessions = [entry["session_id"] for entry in entries if entry["session_id"]]
    return {"run_id": bundle["run_id"], "bundle_sha256": digest, "candidate_commit": bundle["candidate_commit"],
            "reviewer": ", ".join(sessions), "independent": True, "verdict": "blocked" if blocked else "approved",
            "findings": findings, "reviewers": entries}


def _decide(runtime, bundle: dict, digest: str, state: ReviewStatus, decisions: dict) -> dict:
    """Persist review.json for any verdict; only unanimous approval without blocking findings passes."""
    review = combined_review(runtime, bundle, digest, state, decisions)
    save_json(runtime.directory / "review.json", review)
    state.record_decisions()
    blockers = [reviewer_id for reviewer_id in state.ids if reviewer_id in decisions and decision_blocks(decisions[reviewer_id])]
    undecided = [reviewer_id for reviewer_id in state.ids if reviewer_id not in decisions]
    if blockers or undecided:
        for reviewer_id in blockers:
            state.statuses[reviewer_id]["status"] = "blocked"  # An approval with an unresolved P0/P1 is contradictory; the run is blocked.
        state.save()
        raise RuntimeError(f"Independent reviewer blocked the candidate ({', '.join(blockers or undecided)})")
    runtime.validate_review(review)
    for status in state.statuses.values():
        status["status"] = "succeeded"
    state.combined.update(status="succeeded", review=review, accepted_at=now())
    state.save()
    return review


def _record_partial(runtime, bundle: dict, digest: str, state: ReviewStatus) -> None:
    """A run blocked by one reviewer's deadline or rejected file still records the verdicts it accepted, tagged by reviewer."""
    if state.decisions and not (runtime.directory / "review.json").exists():
        state.record_decisions()
        state.save()
        save_json(runtime.directory / "review.json", combined_review(runtime, bundle, digest, state, state.decisions))


def _review_native(runtime, bundle: dict, digest: str, patch: Path) -> dict:
    from .pipeline import digest_file
    declared = reviewers(runtime)
    combined = {"transport": "native", "bundle_sha256": digest, "candidate_commit": bundle["candidate_commit"],
                "patch_sha256": digest_file(patch), "status": "launching", "reviewers": [item["reviewer_id"] for item in declared]}
    statuses = {item["reviewer_id"]: {"reviewer_id": item["reviewer_id"], "node_id": review_node(item["reviewer_id"]), "transport": "native",
                                      "launch_token": str(uuid.uuid4()), "bundle_sha256": digest, "candidate_commit": bundle["candidate_commit"],
                                      "status": "pending"} for item in declared}
    state = ReviewStatus(runtime, combined, statuses)
    state.save()
    for reviewer in declared:
        reviewer_id = reviewer["reviewer_id"]
        status = statuses[reviewer_id]
        status["status"] = "launching"
        state.save()
        prompt = review_prompt(runtime, patch, reviewer) + completion_protocol_prompt(runtime, status["launch_token"], digest, bundle["candidate_commit"], reviewer_id)
        try:
            launched = runtime.launch_reviewer(reviewer_id, prompt, status["launch_token"], bundle["candidate_commit"])
        except KeyboardInterrupt:
            issued = runtime.directory / f"{review_node(reviewer_id)}.interactive.json"
            if not issued.exists():
                # No launch command was issued for this reviewer. Nothing is guessed either way: the operator reconciles;
                # the reviewers launched before it keep running and nothing is relaunched.
                status.update(status="needs_reconciliation", error="Interrupted before the reviewer launch was issued")
                combined.update(status="needs_reconciliation", error=f"Reviewer {reviewer_id}: interrupted before its launch was issued; nothing is relaunched")
                state.save()
                running = [other for other, item in statuses.items() if item["status"] == "running"]
                if running:
                    runtime.event("review", "interrupted", f"Reviewer {reviewer_id} was never launched; reviewers {', '.join(running)} were NOT stopped and keep running. "
                                  "Resume rebinds them and launches nothing; the run needs reconciliation")
                raise
            # `claude --bg` was issued (settle poll or pane attach interrupted): the session exists or is
            # registering and keeps running. Record what is bound so far; resume binds the rest through
            # reconciliation, never through a relaunch.
            bound = read_json(issued)
            status.update({key: bound[key] for key in ("session_id", "background_id") if bound.get(key)}, status="running")
            combined["status"] = "running"
            state.save()
            runtime.event("review", "interrupted", REVIEW_RESUME_NOTE.format(directory=runtime.directory))
            raise
        except BaseException as error:
            # The launch may or may not have produced a session; only an operator can tell. Never launch again.
            status.update(status="needs_reconciliation", error=str(error))
            combined.update(status="needs_reconciliation", error=str(error))
            state.save()
            raise
        status.update(session_id=launched["session_id"], background_id=launched.get("background_id"), status="running")
        state.save()
    combined["status"] = "running"
    state.save()
    return _accept_native(runtime, bundle, digest, state)


def check_independence(runtime, bundle: dict, state: ReviewStatus, rows: list) -> None:
    """Every reviewer is the session its launch bound, and its UUID differs from every worker's and every other reviewer's."""
    worker_ids = {item["session_id"] for item in bundle["snapshots"].values()}
    seen = set()
    for reviewer_id in state.ids:
        row = runtime.sessions.locate(review_node(reviewer_id), rows)
        session_id = state.statuses[reviewer_id].get("session_id")
        if row is None or not session_id or row.get("sessionId") != session_id or session_id in worker_ids or session_id in seen:
            raise RuntimeError(f"Reviewer identity changed or is not independent ({reviewer_id}); refusing the verdict")
        seen.add(session_id)


def _accept_native(runtime, bundle: dict, digest: str, state: ReviewStatus) -> dict:
    from .pipeline import digest_file
    cwd = runtime.directory / "review-worktree"
    patch = runtime.directory / "review.diff"
    combined = state.combined
    waited = False
    try:
        decisions = wait_reviews(runtime, state)
        waited = True  # From here a failure refuses the whole review: nothing accepted so far is trusted.
        check_independence(runtime, bundle, state, runtime.sessions.inventory())
        if git(cwd, "rev-parse", "HEAD") != bundle["candidate_commit"] or git(cwd, "status", "--porcelain"):
            raise RuntimeError("Reviewer worktree changed")
        if runtime.validate_bundle()[1] != digest or digest_file(patch) != combined["patch_sha256"]:
            raise RuntimeError("Evidence changed during review")
        review = _decide(runtime, bundle, digest, state, decisions)
    except KeyboardInterrupt:
        # Operator/terminal interruption is not a reviewer failure: the native sessions keep
        # running and `automatic --live` resumes waiting for their completion files.
        runtime.event("review", "interrupted", REVIEW_RESUME_NOTE.format(directory=runtime.directory))
        raise
    except BaseException as error:
        # Deadline, blocked session, rejected file or blocked verdict: stop every reviewer so none
        # consumes usage for a run that cannot continue. Nothing is relaunched.
        combined.update(status="blocked", error=str(error))
        state.supersede_running()
        state.save()
        if not waited:
            _record_partial(runtime, bundle, digest, state)
        for failure in stop_reviewers(runtime, state.ids):
            runtime.event("review", "blocked", f"Could not confirm reviewer stop: {failure}")
        raise
    failures = stop_reviewers(runtime, state.ids)
    if failures:
        # The verdict is durable (status succeeded, review.json written); only a stop is unconfirmed.
        # review_candidate retries it on resume before handing the accepted review back.
        runtime.event("review", "running", f"Could not confirm reviewer stop: {'; '.join(failures)}; resume retries the stop")
        raise RuntimeError("; ".join(failures))
    return review


def _review_print(runtime, bundle: dict, digest: str, cwd: Path, patch: Path) -> dict:
    """Headless fallback (--reviewer-transport print): one `claude --print` job per reviewer, in parallel, no pane, no human input."""
    from jsonschema import validate
    from .pipeline import digest_file
    declared = reviewers(runtime)
    combined = {"transport": "print", "bundle_sha256": digest, "candidate_commit": bundle["candidate_commit"],
                "status": "launching", "patch_sha256": digest_file(patch), "reviewers": [item["reviewer_id"] for item in declared]}
    statuses = {item["reviewer_id"]: {"reviewer_id": item["reviewer_id"], "node_id": review_node(item["reviewer_id"]), "transport": "print",
                                      "session_id": str(uuid.uuid4()), "bundle_sha256": digest, "candidate_commit": bundle["candidate_commit"],
                                      "status": "launching"} for item in declared}
    state = ReviewStatus(runtime, combined, statuses)
    state.save()
    env = {key: value for key, value in os.environ.items() if not key.startswith("HERDR_")}
    timeout = runtime.plan["automatic"]["review_timeout_seconds"]
    processes = {}
    waited = False
    try:
        for reviewer in declared:
            reviewer_id = reviewer["reviewer_id"]
            node = review_node(reviewer_id)
            status = statuses[reviewer_id]
            prompt_path = runtime.directory / f"{node}.prompt.txt"
            prompt_path.write_text(review_prompt(runtime, patch, reviewer) + " Return the requested JSON schema.")
            os.chmod(prompt_path, 0o600)
            command = [runtime.sessions.executable, "--print", "--output-format", "json", "--session-id", status["session_id"],
                       "--safe-mode", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
                       "--tools", "Read,Glob,Grep", "--permission-mode", "dontAsk", "--permission-prompts", "none",
                       "--add-dir", str(runtime.directory), "--json-schema", json.dumps(review_schema(runtime))]
            with prompt_path.open() as stdin, (runtime.directory / f"{node}.stdout.json").open("w") as output, (runtime.directory / f"{node}.stderr.log").open("w") as errors:
                process = subprocess.Popen(command, cwd=cwd, env=env, stdin=stdin, stdout=output, stderr=errors, text=True, start_new_session=True)
            processes[reviewer_id] = (process, time.monotonic())
            status.update(status="running", pid=process.pid)
            state.save()
        combined["status"] = "running"
        state.save()
        decisions = state.decisions
        for reviewer_id in state.ids:  # Declared order; each deadline counts from that reviewer's own launch.
            process, launched = processes[reviewer_id]
            status = statuses[reviewer_id]
            try:
                try:
                    process.wait(timeout=max(0.0, timeout - (time.monotonic() - launched)))
                except subprocess.TimeoutExpired:
                    raise RuntimeError(f"Reviewer {reviewer_id} deadline exhausted; no second reviewer is launched") from None
                result = read_json(runtime.directory / f"{review_node(reviewer_id)}.stdout.json")
                if process.returncode != 0 or result.get("session_id") != status["session_id"] or result.get("is_error") is not False or result.get("subtype") != "success":
                    raise RuntimeError(f"Reviewer {reviewer_id} did not succeed; inspect retained output. No automatic retry/provider switch.")
                decision = result.get("structured_output")
                validate(decision, review_schema(runtime))
                check_finding_lanes(runtime, decision["findings"])
            except BaseException as error:
                status.update(status="blocked", error=str(error))
                raise
            decisions[reviewer_id] = decision
            status.update(status="accepted", accepted_at=now())
            state.save()
            if decision_blocks(decision):
                break  # The first block decides; the other reviewers are stopped below.
        waited = True
        if git(cwd, "rev-parse", "HEAD") != bundle["candidate_commit"] or git(cwd, "status", "--porcelain"):
            raise RuntimeError("Reviewer worktree changed")
        if runtime.validate_bundle()[1] != digest or digest_file(patch) != combined["patch_sha256"]:
            raise RuntimeError("Evidence changed during review")
        review = _decide(runtime, bundle, digest, state, decisions)
    except BaseException as error:
        for process, _ in processes.values():
            if process.poll() is None:
                terminate(process)
        combined.update(status="blocked", error=str(error))
        state.supersede_running()
        state.save()
        if not waited:
            _record_partial(runtime, bundle, digest, state)
        raise
    finally:
        for process, _ in processes.values():
            if process.poll() is None:
                terminate(process)
        state.save()
    return review


def gate_reasons(packet: Path) -> list[str]:
    """A packet's gate reasons with its own attempt directory neutralised.

    A reason may quote a path inside the attempt directory (a report the check never wrote),
    which would make every attempt look different from the last and defeat the identical-failure stop.
    """
    return [reason.replace(str(packet.parent), "<attempt>") for reason in read_json(packet)["gate"]["reasons"]]


def advance_failed_checks(runtime, state) -> bool:
    """Retry only recorded failing verification packets, never launches or review."""
    # A checkpoint can carry an error from an earlier attempt of a task that has since
    # succeeded (its writes are applied and it is no longer pending). Only pending
    # tasks with errors are failures to classify.
    workers = lanes(runtime)
    retryable = {f"verify_{node}" for node in workers} | {"candidate"}
    failures = [task.name for task in state.tasks if task.error and task.name in state.next]
    if not failures or any(name not in retryable for name in failures):
        return False
    targets = []
    for name in failures:
        phase = "candidate" if name == "candidate" else "worker"
        stage_targets = []
        for node in workers if phase == "candidate" else (name.removeprefix("verify_"),):
            attempt = runtime.attempt(phase, node)
            path = runtime.directory / "verification" / phase / node / str(attempt) / "packet.json"
            if path.exists() and read_json(path)["gate"]["status"] != "passed":
                previous = runtime.directory / "verification" / phase / node / str(attempt - 1) / "packet.json"
                if attempt > 1 and previous.exists() and gate_reasons(previous) == gate_reasons(path):
                    # Retries rerun immutable code; two identical failures mean the cause is
                    # deterministic (code or environment), and more attempts only burn time.
                    raise RuntimeError(f"{phase}/{node} failed identically on attempts {attempt - 1} and {attempt}; "
                                       f"not transient, inspect {path}")
                stage_targets.append((phase, node))
        if not stage_targets:
            return False
        targets.extend(stage_targets)
    if not targets:
        return False
    # Check all bounds before changing any counters.
    if any(runtime.attempt(p, n) >= runtime.policy.get("max_verification_attempts", 3) for p, n in targets):
        raise RuntimeError("Verification retry limit exhausted; work and evidence retained")
    for phase, node in targets:
        runtime.retry_check(phase, node)
    return True


def supervise(directory: Path) -> None:
    """Each recovery uses a new controller process, not just an in-memory replay."""
    validate_automatic(read_json(directory / "plan.json"))
    with run_lock(directory, "automatic-supervisor.lock"):
        for _ in range(45):
            try:
                result = subprocess.run([sys.executable, "-m", "workflow", "automatic-step", str(directory), "--live"],
                                        cwd=Path(__file__).resolve().parents[1])
            except KeyboardInterrupt:
                raise RuntimeError(RESUME_NOTE.format(directory=directory)) from None
            if result.returncode == 0:
                return
            if result.returncode != 75:
                raise RuntimeError(f"Automatic controller blocked (exit {result.returncode}); inspect retained run")
        raise RuntimeError("Automatic controller restart limit exhausted")


RESUME_NOTE = ("Supervisor interrupted. Native workers were NOT stopped and keep running; "
               "resume with: python -m workflow automatic {directory} --live")
REVIEW_STOP_NOTE = ("Reviewer stop not confirmed after acceptance: {error}. The verdict is kept; inspect the reviewer "
                    "session, then resume retries the stop with: python -m workflow automatic {directory} --live")


def reviewer_stop_pending(runtime, state) -> bool:
    """The review node failed after its verdict was accepted durably, before every reviewer stop was confirmed.

    Re-entering the node only retries that stop (review_candidate returns the persisted review)
    and launches nothing, so a resumed controller may do it; nothing else about review is retried.
    """
    if [task.name for task in state.tasks if task.error and task.name in state.next] != ["review"]:
        return False
    if not combined_status_path(runtime).exists():
        return False
    state = ReviewStatus.load(runtime)
    return (state.combined.get("transport") == "native" and state.combined.get("status") == "succeeded"
            and not all(reviewer_stopped(runtime, reviewer_id) for reviewer_id in state.ids))


def drive(runtime, *, single_step=False) -> str | None:
    """Advance persisted graph state; CLI supervision restarts this process at joins."""
    from .pipeline import build_pipeline, graph_config, report
    validate_automatic(runtime.plan)
    if git(Path(runtime.plan["repository"]), "symbolic-ref", "--short", "HEAD") != runtime.plan["source_branch"]:
        raise RuntimeError("Source feature branch changed; no automatic continuation")
    runtime.event("controller", "running", f"Automatic checkpoint controller PID {os.getpid()}")
    config = graph_config(runtime)
    while True:
        with SqliteSaver.from_conn_string(str(runtime.directory / "pipeline.sqlite")) as saver:
            graph = build_pipeline(saver, runtime)
            state = graph.get_state(config)
            if not state.values or any(name.startswith("launch_") for name in state.next):
                raise RuntimeError("Automatic supervision requires a completed start; reconcile uncertain launches explicitly")
            if not state.next:
                commit = state.values.get("integrated_commit")
                if (not commit or git(Path(runtime.plan["repository"]), "rev-parse", "HEAD") != commit
                        or git(Path(runtime.plan["repository"]), "status", "--porcelain")):
                    raise RuntimeError("No verified feature-branch completion")
                runtime.validate_review(read_json(runtime.directory / "review.json"))
                report(runtime, state)
                return commit
            pending = [item.value.get("kind") for task in state.tasks for item in task.interrupts]
            value = None
            if pending == ["worker_handoff"]:
                try:
                    wait_handoffs(runtime)
                except KeyboardInterrupt:
                    # Operator/terminal interruption is not a worker failure: leave the
                    # native sessions running so `automatic --live` can resume polling.
                    runtime.event("controller", "interrupted", RESUME_NOTE.format(directory=runtime.directory))
                    report(runtime, state)
                    raise
                except BaseException as error:
                    # Deadline, quota block, missing/blocked completion: stop the workers so
                    # no session keeps consuming usage for a run that cannot continue.
                    runtime.event("controller", "blocked", str(error))
                    try:
                        runtime.stop_workers()
                    except Exception as cleanup_error:
                        runtime.event("freeze", "blocked", f"Could not confirm worker stop: {cleanup_error}")
                    report(runtime, state)
                    raise
                value = Command(resume={"freeze": True})
            elif pending:
                raise RuntimeError("Unexpected manual gate in automatic run; inspect state")
            elif any(task.error for task in state.tasks) and not (advance_failed_checks(runtime, state) or reviewer_stop_pending(runtime, state)):
                raise RuntimeError("Non-retryable graph failure; inspect retained evidence")
            try:
                graph.invoke(value, config)
            except Exception as error:
                failed = graph.get_state(config)
                if not any(task.error for task in failed.tasks):
                    raise
                if reviewer_stop_pending(runtime, failed):
                    # Not retried in this loop: the operator inspects the session first; a resumed
                    # controller retries the stop once before continuing.
                    raise RuntimeError(REVIEW_STOP_NOTE.format(error=error, directory=runtime.directory)) from error
                # Next loop reopens the checkpointer and classifies the exact failure.
            finally:
                report(runtime, graph.get_state(config))
            if single_step:
                return None  # Exit 75: supervisor reopens this checkpoint in a fresh process.
