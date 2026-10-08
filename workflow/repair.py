"""`python -m workflow repair`: an operator's fix commit becomes a new lane snapshot after freeze, before review.

Frozen snapshots never change, so a lane blocked at `verify_<lane>` or at the combined candidate used to need a new
run. `repair` records the fix in `repairs.json`, builds one deterministic snapshot commit per named lane (the lane's
snapshot with the fix's files it owns, parent the run's base), raises the attempt counters past the existing evidence
and forks the run's LangGraph thread at the freeze boundary with the new snapshots. It launches no session, runs no
check and never invokes the graph: `automatic --live` (or `retry` for a manual run) re-verifies the repaired lanes,
rechecks the others, checks a new candidate generation for every lane and only then reaches review. Every apply step
is idempotent, so a crash is completed by rerunning the identical command. `--workspace` makes a detached worktree at
the right base to commit the fix in, never in the source checkout (RUNBOOK "Blocked after freeze: repair a lane").

`--session --live` launches one native repair session for the lane in such a workspace, narrowed to what blocked it, waits
for its completion, stops it, captures the workspace as the fix commit and applies it through the same steps; the
controller's in-run fix loop runs the same `repair_session` as `controller`, on review blocks too (RUNBOOK "In-run fix loop").
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shlex
import subprocess
import sys
import tempfile
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

from langgraph.checkpoint.sqlite import SqliteSaver

from .actor import BY_OPERATOR, actor_record, add_actor_argument, require_actor
from .checks import now
from .pipeline import Pipeline, build_pipeline, commit_env, digest_file, graph_config, report
from .sessions import git, read_json, run_lock, save_json
from .verification import owns, safe_path
from .worktrees import git_worktree

MAX_REPAIRS = 3
JOURNAL_VERSION = "1.0.0"
# Once any of these exists a reviewer has seen a candidate: code changes then need a new run.
REVIEW_FILES = ("review-bundle.json", "review.json", "integration-intent.json")


# ---- The journal, as the graph reads it --------------------------------------------------------------------------

def load_repairs(directory: Path) -> list[dict]:
    path = directory / "repairs.json"
    return read_json(path)["repairs"] if path.exists() else []


def applied_repairs(directory: Path) -> list[dict]:
    return [entry for entry in load_repairs(directory) if entry["status"] == "applied"]


def attempt_floor(directory: Path, phase: str, node: str) -> int:
    """The first attempt of the lane's current revision in this phase: the latest applied repair's floor for it, else 1.

    The attempt limit counts from here, so it is per lane, phase and revision; MAX_REPAIRS bounds the revisions.
    """
    for entry in reversed(applied_repairs(directory)):
        if f"{phase}:{node}" in entry["attempt_floors"]:
            return entry["attempt_floors"][f"{phase}:{node}"]
    return 1


# A check killed under memory pressure (checks.memory_killed) does not spend the attempt budget: up to this many such attempts
# per lane, phase and revision are added to max_verification_attempts. Past it they count like any failure, so a machine that
# never frees memory still ends the run.
MAX_TRANSIENT_RERUNS = 3


def transient_packet(path: Path) -> bool:
    """A blocked packet whose every gate reason is a check killed for memory (result.transient_checks): its id's reasons, or
    `Executed check failed: <its command>`. A real failure beside a kill makes the attempt a real failure; the kill is only listed."""
    if not path.is_file():
        return False
    packet = read_json(path)
    result, gate = packet.get("result", {}), packet.get("gate", {})
    killed = result.get("transient_checks") or []
    if gate.get("status") != "blocked" or not killed or not gate.get("reasons"):
        return False
    commands = {f"Executed check failed: {check.get('command')}" for check in result.get("checks", []) if check.get("transient") == "memory"}
    prefixes = tuple(f"{check_id}{separator}" for check_id in killed for separator in (":", "/"))
    return all(reason in commands or reason.startswith(prefixes) for reason in gate["reasons"])


def attempt_limit(directory: Path, policy: dict, phase: str, node: str, through: int) -> int:
    """The first attempt past the budget of the lane's current revision: its floor plus max_verification_attempts plus its
    transient attempts from the floor up to `through` (at most MAX_TRANSIENT_RERUNS)."""
    floor = attempt_floor(directory, phase, node)
    folder = directory / "verification" / phase / node
    transient = sum(transient_packet(folder / str(attempt) / "packet.json") for attempt in range(floor, through + 1))
    return floor + policy.get("max_verification_attempts", 3) + min(transient, MAX_TRANSIENT_RERUNS)


def candidate_paths(directory: Path, generation: int) -> tuple[Path, Path]:
    """`candidate.json` and `candidate/` before any repair; `candidate-<g>.json` and `candidate-<g>/` after g applied repairs."""
    suffix = f"-{generation}" if generation else ""
    return directory / f"candidate{suffix}.json", directory / f"candidate{suffix}"


def repair_command(directory: Path, entry: dict) -> str:
    return (f"{sys.executable} -m workflow repair {shlex.quote(str(directory))} {','.join(entry['lanes'])} "
            f"--commit {entry['source_commit']} --reason {shlex.quote(entry['reason'])} {BY_OPERATOR}")


def refuse_recorded(directory: Path, controller_ok: bool = False) -> None:
    """While a repair is recorded its refs and counters may already exist: the failed branch never resumes, completing it is the way on.
    `controller_ok`: drive's own check, where the fix loop completes a round the controller recorded."""
    for entry in load_repairs(directory):
        if entry["status"] == "recorded" and not (controller_ok and entry.get("by") == "controller"):
            raise RuntimeError(f"Repair {entry['n']} is recorded but not applied; rerun exactly: {repair_command(directory, entry)}")


def repaired_by(entry: dict) -> str:
    """Who recorded the repair: the journal's `by` (C17); entries recorded before it was kept were the operator's."""
    return f"the {entry.get('by', 'operator')}" + (" (via a Claude Code session)" if entry.get("via") == "claude-code" else "")


def repair_note(directory: Path) -> str:
    """The reviewer prompt's line per applied repair: the lanes the operator changed, why, and where that change is."""
    note = ""
    for entry in applied_repairs(directory):
        diff = directory / f"repair-{entry['n']}.diff"
        by = f"the {entry.get('by', 'operator')}"
        note += (f" Lane(s) {', '.join(entry['lanes'])} were repaired by {by} before review (repair {entry['n']}: {entry['reason']}); "
                 f"{by}'s change is {diff}; the rest of review.diff is the workers' work.")
    return note


def repaired_snapshot(previous: dict, entry: dict, lane: str) -> dict:
    """The lane's snapshot after `entry`: the new commit and files, the worker's own session and handoff, the provenance.

    A repair session's id joins `prior_session_ids`, the other sessions that wrote the lane's code: no reviewer may be one."""
    item = entry["lanes"][lane]
    summary = (f"{previous['summary']}\n\n{entry.get('by', 'operator').capitalize()} repair {entry['n']}: {entry['reason']} "
               f"(files {', '.join(item['fix_files'])}; source {entry['source_commit']} on {entry['base_kind']} {entry['base_commit'][:8]})")
    snapshot = {"commit": item["commit"], "changed_files": item["changed_files"], "session_id": previous["session_id"],
                "summary": summary, "open_assumptions": previous["open_assumptions"],
                "repair": {"n": entry["n"], "mode": entry["mode"], "base_kind": entry["base_kind"], "base_commit": entry["base_commit"],
                           "previous_commit": item["previous_commit"], "source_commit": entry["source_commit"], "fix_files": item["fix_files"],
                           "reason": entry["reason"], "recorded_at": entry["recorded_at"]}}
    prior = list(previous.get("prior_session_ids", []))
    if entry.get("session", {}).get("session_id"):
        prior.append(entry["session"]["session_id"])
    if prior:
        snapshot["prior_session_ids"] = prior
    return snapshot


def writer_ids(snapshots: dict) -> set:
    """Every session that wrote a lane's code: each lane's worker and its repair sessions (prior_session_ids)."""
    return {item["session_id"] for item in snapshots.values()} | {sid for item in snapshots.values() for sid in item.get("prior_session_ids", [])}


def effective_snapshots(directory: Path, entries: list[dict]) -> dict:
    """snapshots.json, the generation-0 record that is never rewritten, overlaid by `entries` in order."""
    snapshots = read_json(directory / "snapshots.json")
    for entry in entries:
        for lane in entry["lanes"]:
            snapshots[lane] = repaired_snapshot(snapshots[lane], entry, lane)
    return snapshots


def continuation(runtime, executable: str = sys.executable) -> str:
    """Automatic plans continue only under the supervisor; manual plans with retry, up to the review gate."""
    directory = shlex.quote(str(runtime.directory))
    if runtime.plan.get("automatic"):
        return f"{executable} -m workflow automatic {directory} --live {BY_OPERATOR}"
    return f"{executable} -m workflow retry {directory} {BY_OPERATOR}"


def check_retry(runtime, phase: str, nodes: list[str], executable: str = sys.executable) -> str:
    """Rerunning checks at their next attempts: `retry` runs each on a manual plan; on an automatic plan `retry` only raises
    the attempts, and the supervisor's controller runs them."""
    directory = shlex.quote(str(runtime.directory))
    commands = ", ".join(f"{executable} -m workflow retry {directory} --phase {phase} --node {node} {BY_OPERATOR}" for node in nodes)
    return f"{commands}, then {continuation(runtime, executable)}" if runtime.plan.get("automatic") else commands


# ---- State refusals (S0) -----------------------------------------------------------------------------------------

def parse_lanes(value: str, workers: list[str]) -> list[str]:
    """`<lane>[,<lane>]`: distinct lanes of this run, returned in the run's lane order."""
    named = [item.strip() for item in value.split(",")]
    if any(not item for item in named):
        raise ValueError(f"The lanes are a comma-separated list of lane ids, like ui or ui,adapter; got {value!r}")
    if len(set(named)) != len(named):
        raise ValueError(f"The lane list names a lane twice: {value}")
    unknown = [item for item in named if item not in workers]
    if unknown:
        raise ValueError(f"Not a lane of this run: {', '.join(unknown)} (lanes: {', '.join(workers)})")
    return [node for node in workers if node in named]


def raw_attempt(directory: Path, phase: str, node: str) -> int:
    path = directory / "attempts.json"
    return read_json(path).get(f"{phase}:{node}", 1) if path.exists() else 1


def attempt_directories(directory: Path, phase: str, node: str) -> list[int]:
    folder = directory / "verification" / phase / node
    return sorted(int(item.name) for item in folder.iterdir() if item.is_dir() and item.name.isdigit()) if folder.is_dir() else []


def check_before_review(runtime, state) -> None:
    pending = [item.value.get("kind") for task in state.tasks for item in task.interrupts]
    if (any((runtime.directory / name).exists() for name in REVIEW_FILES) or state.values.get("integrated_commit")
            or {"independent_review", "integration_approval"} & set(pending)):
        raise ValueError("Reviewers have seen a candidate; code changes need a new run")


def blocked_phase(blocked: dict) -> str:
    """The phase a fix of `blocked` belongs to: a review block's is the reviewed candidate's."""
    return blocked.get("phase") or blocked["packets"][0]["phase"]


def blocked_step(runtime, state, after_review: bool = False) -> dict:
    """The check verdict the run stopped at: a blocked packet of the candidate, or of a failed verify_<lane>. `after_review`
    (the controller's fix loop only, its review round archived first) also takes a blocked review of the current candidate."""
    directory = runtime.directory
    pending = [item.value.get("kind") for task in state.tasks for item in task.interrupts]
    failed = [task.name for task in state.tasks if task.error and task.name in state.next]
    if after_review and state.values and failed == ["review"] and tuple(state.next) == ("review",):
        candidate = read_json(candidate_paths(directory, len(applied_repairs(directory)))[0])["commit"]
        return {"step": "review", "phase": "candidate", "candidate_commit": candidate, "packets": []}
    if not state.values:
        raise ValueError("The run was never started; there is no frozen lane to repair")
    if any(step.startswith("launch_") for step in state.next):
        raise ValueError("A launch step is pending or failed; use reconcile")
    if pending == ["worker_handoff"] or not (directory / "snapshots.json").exists():
        raise ValueError("A lane blocked before freeze: repair needs frozen snapshots, and an automatic run blocked there needs a new run "
                         "(RUNBOOK, Blocked after freeze: repair a lane)")
    for phase in ("worker", "candidate"):
        for node in runtime.workers:
            folder = directory / "verification" / phase / node / str(raw_attempt(directory, phase, node))
            if folder.is_dir() and not (folder / "packet.json").exists():
                raise ValueError(f"Interrupted check at {folder}; rerun it at its next attempt with: {check_retry(runtime, phase, [node])}")
    failed = [task.name for task in state.tasks if task.error and task.name in state.next]
    verifies = {f"verify_{node}" for node in runtime.workers}
    if failed == ["candidate"] and tuple(state.next) == ("candidate",):
        phase, nodes = "candidate", runtime.workers
    elif failed and set(state.next) <= verifies:
        phase, nodes = "worker", [name.removeprefix("verify_") for name in failed]
    else:
        # A failed handoff was refused as before freeze, review onwards by check_before_review: nothing failed here, a controller
        # stopped between steps.
        raise ValueError("The run did not stop at a check verdict of the candidate or a verify_<lane> step; inspect, then continue it "
                         f"with: {continuation(runtime)}")
    packets, unverified = [], []
    for node in nodes:
        attempt = raw_attempt(directory, phase, node)
        path = directory / "verification" / phase / node / str(attempt) / "packet.json"
        packet = read_json(path) if path.exists() else None
        if packet and packet["gate"]["status"] == "blocked":
            packets.append({"phase": phase, "node_id": node, "path": str(path.relative_to(directory)), "sha256": digest_file(path),
                            "attempt": attempt, "output_commit": packet["expected"]["output_commit"], "reasons": packet["gate"]["reasons"]})
        elif packet is None:
            unverified.append(node)
    if not packets:
        # Plain retry reruns the step on a manual plan. The supervisor reruns only a raised attempt: every failed verify_<lane>
        # needs one, the candidate step one lane's (it reuses every passing packet), best a lane without one.
        from .automatic import RETRY_REQUESTS
        requests = read_json(directory / RETRY_REQUESTS) if (directory / RETRY_REQUESTS).exists() else {}
        requested = any(requests.get(f"{phase}:{node}") == raw_attempt(directory, phase, node)
                        and not (directory / "verification" / phase / node / str(raw_attempt(directory, phase, node))).exists() for node in nodes)
        # An attempt a retry already raised, not run yet, is the supervisor's to run: another retry would skip it.
        rerun = continuation(runtime) if not runtime.plan.get("automatic") or requested else check_retry(
            runtime, phase, nodes if phase == "worker" else (unverified or nodes)[:1])
        raise ValueError("The failed step has no blocked packet at its current attempt, so it is not a check verdict "
                         f"(an infrastructure error, a cherry-pick conflict, a partial candidate); inspect, then rerun it with: {rerun}")
    return {"step": "candidate" if phase == "candidate" else ", ".join(failed), "packets": packets}


def check_source(runtime) -> None:
    """integrate()'s own checks, done early: a fix committed on the pinned source branch is outside every gate."""
    plan, repo = runtime.plan, Path(runtime.plan["repository"])
    elsewhere = f"commit fixes in a repair workspace (repair {runtime.directory} <lane> --workspace), never in the source checkout"
    branch = subprocess.run(["git", "-C", str(repo), "symbolic-ref", "-q", "--short", "HEAD"], capture_output=True, text=True).stdout.strip()
    if branch != plan["source_branch"]:
        raise ValueError(f"The source checkout is on {branch or 'a detached HEAD'}, not the run's branch {plan['source_branch']}; {elsewhere}")
    head = git(repo, "rev-parse", "HEAD")
    if head != plan["base_commit"]:
        raise ValueError(f"The source branch {branch} moved from the run's base {plan['base_commit'][:8]} to {head[:8]}, which integration "
                         f"refuses; {elsewhere}")
    if git(repo, "status", "--porcelain"):
        raise ValueError(f"The source checkout has uncommitted changes, which integration refuses; {elsewhere}")


def fork_point(graph, config, runtime, previous: dict, checkpoint_id: str | None = None):
    """The freeze boundary: the newest checkpoint whose next step is exactly the verify fan-out (the handoff's output or the
    previous repair's fork), or the recorded one. Its snapshots must be snapshots.json overlaid by the applied repairs."""
    fan_out = {f"verify_{node}" for node in runtime.workers}
    fork = next((item for item in graph.get_state_history(config)
                 if (item.config["configurable"]["checkpoint_id"] == checkpoint_id if checkpoint_id else set(item.next) == fan_out)), None)
    if fork is None or set(fork.next) != fan_out or fork.values.get("snapshots") != previous:
        raise RuntimeError("Contradictory run state: no freeze-boundary checkpoint holds snapshots.json plus the applied repairs; inspect")
    return fork


def session_refusals(runtime, graph, config) -> None:
    """The refusals of a controller round that need no blocked step: a recorded repair, the repair limit, an applied repair
    not continued from, a moved or dirty source. The fix loop runs them before it archives a review round."""
    directory = runtime.directory
    refuse_recorded(directory, controller_ok=True)
    applied = applied_repairs(directory)
    state = graph.get_state(config)
    if len(applied) >= MAX_REPAIRS:
        raise ValueError(f"{len(applied)} repairs are already applied to this run (at most {MAX_REPAIRS}); start a revised run")
    if applied and state.config["configurable"]["checkpoint_id"] == applied[-1]["head_after"] and not any(task.error for task in state.tasks):
        raise ValueError(f"Repair {applied[-1]['n']} is applied and the run has not continued from it")
    check_source(runtime)


def blocked_run(runtime, graph, config, applied: list[dict], after_review: bool = False) -> tuple:
    """Every state refusal. Returns the head, the blocked step, the fork point and the effective snapshots. `after_review` is
    the controller's fix loop on a review block: the round's review files are archived by then, so check_before_review
    passes; blocked_step takes the review step."""
    state = graph.get_state(config)
    check_before_review(runtime, state)
    if len(applied) >= MAX_REPAIRS:
        raise ValueError(f"{len(applied)} repairs are already applied to this run (at most {MAX_REPAIRS}); start a revised run")
    # A failed verify superstep writes no checkpoint: a continuation that failed a lane's check again leaves the fork as
    # the head with the error pending. Only a fork nothing has failed from is a repair not yet continued.
    if applied and state.config["configurable"]["checkpoint_id"] == applied[-1]["head_after"] and not any(task.error for task in state.tasks):
        raise ValueError(f"Repair {applied[-1]['n']} is applied and the run has not continued from it; an applied repair is not "
                         f"replaced. Continue with: {continuation(runtime)}")
    blocked = blocked_step(runtime, state, after_review)
    check_source(runtime)
    previous = effective_snapshots(runtime.directory, applied)
    return state, blocked, fork_point(graph, config, runtime, previous), previous


# ---- The commit: its base, the fix per lane, each lane's tree (S0) -----------------------------------------------

def resolve_commit(repo: Path, value: str) -> str:
    result = None if value.startswith("-") else subprocess.run(["git", "-C", str(repo), "rev-parse", "--verify", "--quiet", f"{value}^{{commit}}"],
                                                                capture_output=True, text=True)
    if result is None or result.returncode != 0 or not result.stdout.strip():
        raise ValueError(f"--commit {value} is not a commit in {repo}")
    return result.stdout.strip()


def descends(repo: Path, ancestor: str, commit: str) -> bool:
    return subprocess.run(["git", "-C", str(repo), "merge-base", "--is-ancestor", ancestor, commit], capture_output=True).returncode == 0


def changed_paths(repo: Path, old: str, new: str) -> list[str]:
    output = subprocess.check_output(["git", "-C", str(repo), "diff-tree", "-r", "--no-renames", "--name-only", "-z", old, new]).decode()
    return sorted(filter(None, output.split("\0")))


def lane_owner(runtime, path: str) -> str | None:
    """The declared lane (selected or excluded) whose owned paths hold `path`; lanes never overlap."""
    return next((worker["node_id"] for worker in runtime.policy["workers"]
                 if any(owns(path, safe_path(prefix)) for prefix in worker["owned_paths"])), None)


def tree_entries(repo: Path, commit: str, paths: list[str]) -> dict:
    """`path -> ls-tree line` for the paths present in `commit`."""
    if not paths:
        return {}
    output = subprocess.check_output(["git", "-C", str(repo), "ls-tree", "-r", "-z", commit, "--", *paths]).decode()
    return {line.split("\t", 1)[1]: line for line in filter(None, output.split("\0"))}


def overlay_tree(repo: Path, snapshot: str, paths: list[str], entries: dict) -> str:
    """The snapshot's tree with `paths` as the fix has them (removed where it deletes them), built in a private index.

    The index lives in a temporary directory: the source checkout's own index and the run directory are never written.
    """
    with tempfile.TemporaryDirectory(prefix="workflow-repair-") as scratch:
        env = {**os.environ, "GIT_INDEX_FILE": str(Path(scratch) / "index")}
        command = ["git", "-C", str(repo)]
        subprocess.run([*command, "read-tree", snapshot], env=env, check=True, capture_output=True)
        removed = [path for path in paths if path not in entries]
        if removed:
            subprocess.run([*command, "update-index", "--force-remove", "--", *removed], env=env, check=True, capture_output=True)
        present = "".join(entries[path] + "\0" for path in paths if path in entries)
        if present:
            subprocess.run([*command, "update-index", "-z", "--index-info"], input=present.encode(), env=env, check=True, capture_output=True)
        return subprocess.check_output([*command, "write-tree"], env=env, text=True).strip()


def derive(runtime, lanes: list[str], source: str, phase: str, previous: dict) -> dict:
    """The fix's base, the files of each named lane and each lane's new tree, checked with freeze's rules. Read only
    (Git writes the trees' objects, which nothing references)."""
    directory, repo = runtime.directory, Path(runtime.plan["repository"])
    generation = len(applied_repairs(directory))
    saved = [candidate_paths(directory, number)[0] for number in range(generation + 1)]
    commits = [read_json(path)["commit"] if path.exists() else None for path in saved]
    current, older = commits[-1], [commit for commit in commits[:-1] if commit]
    if phase == "candidate" and current and descends(repo, current, source):
        base_kind, base = "candidate", current
    elif any(descends(repo, commit, source) for commit in older):
        raise ValueError(f"--commit {source[:8]} is on the candidate of an earlier generation, not the current one ({(current or 'none')[:8]}); "
                         "commit the fix on the current candidate")
    elif any(descends(repo, previous[lane]["commit"], source) for lane in lanes):
        if len(lanes) > 1:
            raise ValueError("A fix on a lane snapshot repairs one lane only: overlaying base content onto another lane would discard its "
                             "changes. Commit a fix spanning lanes on the failing candidate (repair <run> <lanes> --workspace)")
        base_kind, base = "snapshot", previous[lanes[0]]["commit"]
    else:
        bases = ([f"the current candidate {current[:8]}"] if phase == "candidate" and current else []) + \
                [f"the {lane} snapshot {previous[lane]['commit'][:8]}" for lane in lanes]
        raise ValueError(f"--commit {source[:8]} descends from neither {' nor '.join(bases)}; make it in a repair workspace "
                         f"(repair {directory} <lane> --workspace)")
    fix = changed_paths(repo, base, source)
    for path in fix:
        safe_path(path)
        owner = lane_owner(runtime, path)
        if owner is None:
            raise ValueError(f"The fix changes {path}, which no lane owns")
        if owner in runtime.excluded:
            raise ValueError(f"Ownership violation: the fix changes {path}, owned by excluded lane {owner}")
        if owner not in lanes:
            raise ValueError(f"The fix changes {path}, owned by lane {owner}, which this repair does not name; name {owner} too or leave the file alone")
    entries = tree_entries(repo, source, fix)
    for path, line in entries.items():
        mode = line.split(" ", 1)[0]
        if mode == "120000":
            raise ValueError(f"Symlink changes require manual review before snapshot: {path}")
        if mode == "160000":
            raise ValueError(f"Gitlink (submodule) changes are refused: {path}")
    result = {}
    for lane in lanes:
        snapshot = previous[lane]["commit"]
        paths = [path for path in fix if lane_owner(runtime, path) == lane]
        tree = overlay_tree(repo, snapshot, paths, entries)
        if tree == git(repo, "rev-parse", f"{snapshot}^{{tree}}"):
            raise ValueError(f"The fix changes nothing in the {lane} snapshot {snapshot[:8]}: a repair is not a retry (use retry for a transient failure)")
        changed = changed_paths(repo, runtime.plan["base_commit"], tree)
        runtime.check_ownership(lane, changed)
        result[lane] = {"previous_commit": snapshot, "fix_files": paths, "tree": tree, "changed_files": changed}
    return {"base_kind": base_kind, "base_commit": base, "lanes": result,
            "expected_candidate_tree": git(repo, "rev-parse", f"{source}^{{tree}}") if base_kind == "candidate" else None}


def attempt_targets(directory: Path, lanes: list[str], workers: list[str]) -> dict:
    """The worker phase of each repaired lane and the candidate phase of every lane that has a candidate attempt directory
    start past their counter and past every existing attempt: nothing is moved, and no attempt directory is reused."""
    targets = {}
    for phase, nodes in (("worker", lanes), ("candidate", workers)):
        for node in nodes:
            existing = attempt_directories(directory, phase, node)
            if phase == "worker" or existing:
                targets[f"{phase}:{node}"] = max(raw_attempt(directory, phase, node), max(existing, default=0) + 1)
    return targets


# ---- Apply (S1 to S6), each step idempotent -----------------------------------------------------------------------

def save_entry(directory: Path, entry: dict) -> None:
    repairs = [item for item in load_repairs(directory) if item["n"] != entry["n"]] + [entry]
    save_json(directory / "repairs.json", {"version": JOURNAL_VERSION, "repairs": sorted(repairs, key=lambda item: item["n"])})


def record_repair(directory: Path, entry: dict) -> None:
    """S1: the entry, `recorded`: from here drive() and retry refuse until the identical command completes it."""
    save_entry(directory, entry)


def commit_snapshots(runtime, entry: dict, derived: dict) -> None:
    """S2: one commit per lane, parent the run's base, dated at the recorded time so a rerun makes the same commit; refs keep
    it and the operator's commit. Beside refs/workflow/, where no lane id can name them."""
    repo, plan = runtime.plan["repository"], runtime.plan
    stamp = f"{int(datetime.fromisoformat(entry['recorded_at']).timestamp())} +0000"
    env = {**commit_env(), "GIT_AUTHOR_DATE": stamp, "GIT_COMMITTER_DATE": stamp}
    prefix = f"refs/workflow-repair/{hashlib.sha256(str(runtime.directory).encode()).hexdigest()[:16]}/{entry['n']}"
    for lane, item in derived["lanes"].items():
        commit = plan["base_commit"]  # As freeze records a lane that changed nothing.
        if item["changed_files"]:
            commit = subprocess.check_output(["git", "-C", repo, "-c", "commit.gpgsign=false", "commit-tree", item["tree"], "-p", plan["base_commit"],
                                              "-m", f"Workflow {plan['run_id']}: {lane} repair {entry['n']}"], env=env, text=True).strip()
        item["commit"] = commit
        subprocess.run(["git", "-C", repo, "update-ref", f"{prefix}/{lane}", commit], check=True)
    subprocess.run(["git", "-C", repo, "update-ref", f"{prefix}/source_commit", entry["source_commit"]], check=True)


def save_lanes(runtime, entry: dict, derived: dict) -> None:
    """S3: each lane's commit and files into the journal, and the operator's change per lane as repair-<n>.diff."""
    for lane, item in derived["lanes"].items():
        entry["lanes"][lane].update(commit=item["commit"], changed_files=item["changed_files"])
    save_entry(runtime.directory, entry)
    with (runtime.directory / f"repair-{entry['n']}.diff").open("wb") as handle:
        for item in entry["lanes"].values():
            handle.write(subprocess.check_output(["git", "-C", runtime.plan["repository"], "diff", "--binary", "--no-ext-diff", "--no-textconv", item["previous_commit"], item["commit"]]))


def raise_attempts(directory: Path, entry: dict) -> None:
    """S4: each target counter raised, never lowered."""
    path = directory / "attempts.json"
    attempts = read_json(path) if path.exists() else {}
    for key, target in entry["attempt_targets"].items():
        attempts[key] = max(attempts.get(key, 1), target)
    save_json(path, attempts)


def fork_run(graph, config, runtime, entry: dict, fork, snapshots: dict) -> str:
    """S5: exactly one new checkpoint, as if `handoff` had written the repaired snapshots, forked from the freeze boundary.

    `fork.config` carries its checkpoint_id, and pending writes are not carried into a fork: the failed step's trigger
    and the old packets stay on the failed branch. The bare thread config would update the failed head instead, which
    runs the candidate beside the verifies with the new snapshots and the old packets. Neither the handoff's interrupt,
    nor freeze, nor the worker stop runs; only its edges fire.
    """
    head = graph.get_state(config)
    if head.config["configurable"]["checkpoint_id"] == entry["head_before"]:
        graph.update_state(fork.config, {"snapshots": snapshots}, as_node="handoff")
        head = graph.get_state(config)
    elif not (head.parent_config and head.parent_config["configurable"]["checkpoint_id"] == entry["fork_from"] and head.metadata.get("source") == "update"):
        raise RuntimeError(f"Checkpoint moved since repair {entry['n']} was recorded (head {head.config['configurable']['checkpoint_id']}); inspect")
    if set(head.next) != {f"verify_{node}" for node in runtime.workers} or any(task.error for task in head.tasks) or head.values.get("snapshots") != snapshots:
        raise RuntimeError(f"Contradictory run state after the fork of repair {entry['n']}: the next step is not the verify fan-out; inspect")
    return head.config["configurable"]["checkpoint_id"]


def finish_repair(runtime, graph, config, entry: dict, head_after: str) -> None:
    """S6: the timeline, the entry `applied`, then the report and run-state.json. Events a crash duplicated are harmless."""
    directory, n = runtime.directory, entry["n"]
    generation = len(applied_repairs(directory))  # Of the candidate this repair supersedes: blocked repair sessions take no generation.
    answers = " ".join(f"Answers {packet['phase']}/{packet['node_id']} attempt {packet['attempt']}: {'; '.join(packet['reasons'])}."
                       for packet in entry["blocked"]["packets"])
    for lane, item in entry["lanes"].items():
        runtime.event(f"verify_{lane}", "paused", f"Repair {n} by {repaired_by(entry)}: snapshot {item['commit'][:8]} = {item['previous_commit'][:8]} + "
                                                  f"{entry['source_commit'][:8]} on {entry['base_kind']} {entry['base_commit'][:8]} "
                                                  f"({', '.join(item['fix_files'])}). Reason: {entry['reason']}. {answers} "
                                                  f"Continue with {continuation(runtime, 'python')}")
    superseded = candidate_paths(directory, generation)[0]
    if superseded.exists():
        runtime.event("candidate", "paused", f"Repair {n} supersedes combined revision {read_json(superseded)['commit'][:8]}; "
                                             f"candidate-{generation + 1} is built after the lanes re-verify")
    runtime.event("controller", "running", f"Repair {n} applied: checkpoint forked from {entry['fork_from'][:8]} (after handoff); attempts "
                                           + ", ".join(f"{key} {value}" for key, value in entry["attempt_targets"].items()))
    entry.update(status="applied", applied_at=now(), head_after=head_after)
    save_entry(directory, entry)
    report(runtime, graph.get_state(config))


def apply_repair(runtime, graph, config, lanes: list[str], commit: str, reason: str, dry_run: bool, actor: str = "operator",
                 session: dict | None = None, after_review: bool = False) -> dict | None:
    """S0 to S6 for a fix commit. `session` is a repair session's journal entry (status `captured`): the repair keeps its number,
    its actor and its session fields."""
    directory, repo = runtime.directory, Path(runtime.plan["repository"])
    source = resolve_commit(repo, commit)
    entries = load_repairs(directory)
    applied = [entry for entry in entries if entry["status"] == "applied"]
    recorded = next((entry for entry in entries if entry["status"] == "recorded"), None)
    if recorded is None:
        state, blocked, fork, previous = blocked_run(runtime, graph, config, applied, after_review)
    elif list(recorded["lanes"]) != lanes or recorded["source_commit"] != source or recorded["reason"] != reason:
        raise RuntimeError(f"Repair {recorded['n']} is recorded but not applied; only the identical command completes it: "
                           f"{repair_command(directory, recorded)}")
    else:
        # Completing a crashed repair: the head may already be its fork, so the recorded step and fork point stand.
        check_before_review(runtime, graph.get_state(config))
        check_source(runtime)
        blocked, previous = recorded["blocked"], effective_snapshots(directory, applied)
        fork = fork_point(graph, config, runtime, previous, recorded["fork_from"])
    derived = derive(runtime, lanes, source, blocked_phase(blocked), previous)
    if recorded is None:
        targets = attempt_targets(directory, lanes, runtime.workers)
        entry = {"n": session["n"] if session else len(entries) + 1, "status": "recorded", "mode": "session" if session else "commit", "reason": reason,
                 **({key: session[key] for key in SESSION_KEYS if key in session} if session else actor_record(actor)),
                 "recorded_at": session["recorded_at"] if session else now(), "blocked": blocked,
                 "source_commit": source, "base_kind": derived["base_kind"], "base_commit": derived["base_commit"],
                 "expected_candidate_tree": derived["expected_candidate_tree"],
                 "lanes": {lane: {"previous_commit": item["previous_commit"], "fix_files": item["fix_files"]} for lane, item in derived["lanes"].items()},
                 "attempt_targets": targets, "attempt_floors": dict(targets),
                 "fork_from": fork.config["configurable"]["checkpoint_id"], "head_before": state.config["configurable"]["checkpoint_id"]}
    else:
        entry = recorded
        if any(entry[key] != derived[key] for key in ("base_kind", "base_commit", "expected_candidate_tree")) or \
                any(entry["lanes"][lane]["fix_files"] != item["fix_files"] for lane, item in derived["lanes"].items()):
            raise RuntimeError(f"Contradictory run state: repair {entry['n']} no longer derives the snapshots it recorded; inspect")
    if dry_run:
        print(f"Dry run of repair {entry['n']} (nothing written): {reason}\n{describe(entry, derived, dry_run)}\n"
              f"  fork from checkpoint {entry['fork_from']} (after handoff)\nApply: the same command without --dry-run. Then continue with: {continuation(runtime)}")
        return None
    if recorded is None:
        record_repair(directory, entry)                                                   # S1
    commit_snapshots(runtime, entry, derived)                                             # S2
    save_lanes(runtime, entry, derived)                                                   # S3
    raise_attempts(directory, entry)                                                      # S4
    snapshots = effective_snapshots(directory, applied + [entry])
    finish_repair(runtime, graph, config, entry, fork_run(graph, config, runtime, entry, fork, snapshots))  # S5, S6
    if entry.get("by") != "controller":  # The fix loop's own rounds are on the timeline; the controller continues by itself.
        print(f"Repair {entry['n']} applied: {reason}\n{describe(entry, derived, dry_run)}\n  checkpoint forked from {entry['fork_from']} "
              f"(after handoff); {'no check run' if session else 'nothing launched, no check run'}\nContinue with: {continuation(runtime)}")
    return entry


def describe(entry: dict, derived: dict, dry_run: bool) -> str:
    lines = [f"  base: {entry['base_kind']} {entry['base_commit']}"]
    for lane, item in derived["lanes"].items():
        new = f"a commit of tree {item['tree']} on the base" if dry_run else item["commit"]
        lines.append(f"  {lane}: {item['previous_commit']} -> {new}; fix files: {', '.join(item['fix_files'])}; "
                     f"changed files: {', '.join(item['changed_files'])}")
    lines.append("  attempts (each also the floor of its limit): " + ", ".join(f"{key} {value}" for key, value in entry["attempt_targets"].items()))
    return "\n".join(lines)


# ---- --workspace ----------------------------------------------------------------------------------------------------

BROWSER_RULES = ("Every required scenario id appears in exactly one test title as `[scenario:<id>]`, and that test, when it passes, "
                 "attaches exactly one `image/png` named `screenshot:<id>` (other attachments never count). RUNBOOK: Playwright evidence convention.")


def workspace_base(runtime, blocked: dict, previous: dict, lanes: list[str]) -> tuple[str, str]:
    """The commit a fix belongs on and what it is: the failing candidate for a candidate block, the lane's snapshot for a
    worker-phase one."""
    if blocked_phase(blocked) == "candidate":
        what = "the reviewed candidate" if blocked["step"] == "review" else "the combined candidate that failed"
        return read_json(candidate_paths(runtime.directory, len(applied_repairs(runtime.directory)))[0])["commit"], what
    if len(lanes) == 1:
        return previous[lanes[0]]["commit"], f"the {lanes[0]} snapshot"
    raise ValueError("A worker-phase block has no combined candidate: a fix on a lane snapshot repairs one lane only; name one lane")


def add_workspace(runtime, base: str) -> tuple[int, Path]:
    """A new detached worktree `repair-workspace-<m>` of the run at `base`."""
    directory = runtime.directory
    number = 1
    while (directory / f"repair-workspace-{number}").exists() or (directory / f"repair-workspace-{number}.brief.md").exists():
        number += 1
    path = directory / f"repair-workspace-{number}"
    git_worktree(Path(runtime.plan["repository"]), "add", "--detach", str(path), base)
    return number, path


def packet_evidence(directory: Path, packet: dict) -> tuple[Path, list[Path]]:
    """A blocked packet's attempt folder and its evidence files. A reused candidate packet (C28) holds only packet.json: its logs
    and reports are the worker packet's."""
    reused = read_json(directory / packet["path"]).get("reused_from")
    folder = (directory / (reused["path"] if reused else packet["path"])).parent
    evidence = ([folder / "packet.json"] if reused else []) + sorted(folder.glob("setup-*.log")) + sorted(folder.glob("check-*.log")) + sorted(folder.glob("browser-report-*.json"))
    return folder, evidence


def make_workspace(runtime, graph, config, lanes: list[str], reason: str | None) -> None:
    """A detached worktree at the base the fix belongs on, with a brief of what blocked the run. No journal, no graph state."""
    directory = runtime.directory
    refuse_recorded(directory)
    applied = applied_repairs(directory)
    _, blocked, _, previous = blocked_run(runtime, graph, config, applied)
    base, what = workspace_base(runtime, blocked, previous, lanes)
    number, path = add_workspace(runtime, base)
    command = (f"{sys.executable} -m workflow repair {shlex.quote(str(directory))} {','.join(lanes)} --commit $(git -C {shlex.quote(str(path))} rev-parse HEAD) "
               f"--reason {shlex.quote(reason or '<why the fix is needed>')} {BY_OPERATOR}")
    brief = [f"# Repair workspace {number} of run {runtime.plan['run_id']}", "",
             f"Detached at {base}, {what}. Commit the fix here, never on the source branch {runtime.plan['source_branch']}: "
             f"integration needs it at the run's base {runtime.plan['base_commit']}.", "", f"## Blocked: {blocked['step']}"]
    for packet in blocked["packets"]:
        _, evidence = packet_evidence(directory, packet)
        brief += ["", f"{packet['phase']}/{packet['node_id']} attempt {packet['attempt']} at {packet['output_commit']}, gate reasons verbatim:",
                  *(f"- {item}" for item in packet["reasons"]), "", "Evidence:", f"- {directory / packet['path']}", *(f"- {item}" for item in evidence)]
    brief += ["", "## Lanes to repair"]
    for lane in lanes:
        worker = runtime.worker_policy(lane)
        brief += ["", f"{lane} owns: {', '.join(worker['owned_paths'])}. The fix may change only paths the named lanes own.", "Checks:",
                  *(f"- {check['id']} ({check['kind']}): {shlex.join(check['argv'])}" for check in worker["checks"])]
    if any(check["kind"] == "browser" for lane in lanes for check in runtime.worker_policy(lane)["checks"]):
        brief += ["", "## Browser evidence", "", BROWSER_RULES]
    brief += ["", "## Then", "", f"git -C {shlex.quote(str(path))} commit -am '<what the fix does>'", command, ""]
    (directory / f"repair-workspace-{number}.brief.md").write_text("\n".join(brief))
    print(f"Repair workspace {number}: {path}, detached at {base} ({what}).\nBrief: {directory / f'repair-workspace-{number}.brief.md'}\n"
          f"Commit the fix there, never on the source branch, then:\n  {command}")


# ---- --session: a narrowed worker session repairs one lane ---------------------------------------------------------

# The journal keeps a repair session from its launch: `launched` (the receipt and the session), `captured` (stopped, its
# workspace committed as `source_commit`), then `recorded` and `applied` through the --commit path, or `blocked` with why.
SESSION_KEYS = ("by", "via", "trigger", "round", "rounds", "workspace", "workspace_commit", "what", "brief", "session", "captured_at", "summary",
                "review_round", "left_behind", "stop_pending", "stop_retried")
LOG_TAIL_LINES = 60
LOG_LINE_LIMIT = 400  # Characters of one log line in the brief: a minified bundle on one line must not fill the prompt.


class RepairBlocked(RuntimeError):
    """A repair session ended without a fix the run takes: its completion said blocked, its deadline passed, it changed
    nothing, or its change was refused. The round is recorded `blocked`; nothing is applied."""


def session_entries(directory: Path, lane: str | None = None) -> list[dict]:
    """The journal's repair sessions, of one lane when given."""
    return [entry for entry in load_repairs(directory) if entry.get("mode") == "session" and (lane is None or lane in entry["lanes"])]


def open_session(directory: Path) -> dict | None:
    """The repair session the journal says is not finished (launched, captured or recorded), if any."""
    return next((entry for entry in session_entries(directory) if entry["status"] in {"launched", "captured", "recorded"}), None)


def log_tail(path: Path, lines: int = LOG_TAIL_LINES) -> str:
    try:
        tail = path.read_text(errors="replace").splitlines()[-lines:]
    except OSError as error:
        return f"(log unreadable: {error})"
    return "\n".join(line if len(line) <= LOG_LINE_LIMIT else line[:LOG_LINE_LIMIT] + " [line cut]" for line in tail)


def failing_checks(runtime, lane: str, packet: dict) -> list[str]:
    """The brief's lines for a blocked packet's failing checks: id, kind, argv and the last LOG_TAIL_LINES of its log."""
    directory = runtime.directory
    folder, _ = packet_evidence(directory, packet)
    saved = read_json(folder / "packet.json")
    executions = saved.get("result", {}).get("checks", [])
    reasons = " ".join(packet["reasons"])
    lines = []
    for index, check in enumerate(runtime.worker_policy(lane)["checks"]):
        failed = index < len(executions) and executions[index]["exit_code"] != 0
        if not (failed or f"{check['id']}:" in reasons or f"{check['id']}/" in reasons):
            continue
        log = folder / f"check-{index}.log"
        exit_code = executions[index]["exit_code"] if index < len(executions) else "none"
        lines += ["", f"### {check['id']} ({check['kind']}), exit {exit_code}: {shlex.join(check['argv'])}", "",
                  f"Last {LOG_TAIL_LINES} lines of {log}:", "```", log_tail(log), "```"]
    for log in sorted(folder.glob("setup-*.log")) if any(reason.startswith("Setup ") for reason in packet["reasons"]) else []:
        lines += ["", f"### Setup log {log.name}", "", f"Last {LOG_TAIL_LINES} lines of {log}:", "```", log_tail(log), "```"]
    return lines


def session_brief(runtime, lane: str, entry: dict, rounds: int, deadline: str, findings: list[dict] | None = None,
                  delta: Path | None = None) -> str:
    """A repair session's prompt: the fixed worker rules and the failure case only, never the lane's whole task."""
    from .automatic import completion_prompt
    from .guardrails import RUN_REPORT, conventions_block, stop_rule
    from .interactive import setup_note
    directory, plan = runtime.directory, runtime.plan
    worker = runtime.worker_policy(lane)
    node = entry["session"]["node"]
    lines = [("You are a workflow worker in your own worktree. A human can type directly into this terminal. Do not launch agents, commit, "
              "merge, push or modify shared contracts. Stay within this worktree. Report changed files, checks actually executed, and "
              "open assumptions. Completion of a turn is not workflow approval." + setup_note(directory)), "",
             f"# Repair of lane {lane}, run {plan['run_id']}, round {entry['round']} of {rounds}", "",
             f"You are repairing lane {lane} of run {plan['run_id']}, round {entry['round']} of {rounds}: fix only what follows, inside your "
             f"owned paths; do not widen scope. Run targeted tests through `{RUN_REPORT} -- <command>`; the controller reruns the lane's "
             f"checks after you. This worktree is detached at {entry['workspace_commit']}; leave your changes uncommitted, the controller "
             "captures them. When done, write the completion file below."]
    if findings is None:
        for packet in entry["blocked"]["packets"]:
            lines += ["", f"## Gate reasons: {packet['phase']}/{packet['node_id']} attempt {packet['attempt']} at {packet['output_commit']} (verbatim)", "",
                      *(f"- {reason}" for reason in packet["reasons"]), "", "## Failing checks", *failing_checks(runtime, lane, packet)]
    else:
        lines += ["", "## Review findings on this lane (P0/P1, verbatim)", "", *(f"- {json.dumps(finding, ensure_ascii=False)}" for finding in findings)]
        if delta is not None:
            lines += ["", f"The diff the reviewers read (read it first): {delta}. This workspace is the candidate they reviewed."]
    lines += ["", "## Owned paths", "", f"{lane} owns: {', '.join(worker['owned_paths'])}. Change nothing outside them: another lane's "
              "paths are not yours, and a change there is refused with the whole round.", "", "Checks:",
              *(f"- {check['id']} ({check['kind']}): {shlex.join(check['argv'])}" for check in worker["checks"])]
    if any(check["kind"] == "browser" for check in worker["checks"]):
        lines += ["", "## Browser evidence", "", BROWSER_RULES]
    stop = stop_rule(plan["nodes"][lane]["task"])
    if stop:
        lines += ["", "## Stop (from the lane's task)", "", stop]
    return ("\n".join(lines) + conventions_block(plan)
            + completion_prompt(directory, plan, node, launch_token=entry["session"]["launch_token"], task=plan["nodes"][lane]["task"],
                                deadline=deadline))


def launch_session(runtime, graph, config, lane: str, actor: str, trigger: str, *, findings: list[dict] | None = None,
                   delta: Path | None = None, review_round: int | None = None) -> dict:
    """S-1: the round's journal entry (`launched`), its workspace at the failing base, and one native session in it."""
    from .automatic import fix_rounds
    directory = runtime.directory
    refuse_recorded(directory)
    applied = applied_repairs(directory)
    _, blocked, _, previous = blocked_run(runtime, graph, config, applied, after_review=trigger == "review")
    if trigger != "review" and lane not in {packet["node_id"] for packet in blocked["packets"]}:
        raise ValueError(f"Lane {lane} has no blocked packet at {blocked['step']}; repair a lane whose checks blocked the run")
    base, what = workspace_base(runtime, blocked, previous, [lane])
    number, path = add_workspace(runtime, base)
    n = len(load_repairs(directory)) + 1
    rounds = fix_rounds(runtime.plan) if actor == "controller" else max(fix_rounds(runtime.plan), len(session_entries(directory, lane)) + 1)
    entry = {"n": n, "status": "launched", "mode": "session", **({"by": "controller"} if actor == "controller" else actor_record(actor)),
             "trigger": trigger, "round": len(session_entries(directory, lane)) + 1, "rounds": rounds, "lanes": {lane: {}}, "recorded_at": now(),
             "blocked": blocked, "workspace": str(path), "workspace_commit": base, "what": what,
             **({"review_round": review_round} if review_round else {}),
             **({"brief": {"findings": findings, "delta": str(delta) if delta else None}} if findings is not None else {}),
             "session": {"node": f"repair-{n}", "launch_token": str(uuid.uuid4()), "session_id": None}}
    save_entry(directory, entry)
    return start_session(runtime, entry)


def start_session(runtime, entry: dict) -> dict:
    """The launch of a journaled round's session (a resumed controller completes one that died before its receipt): the brief,
    then run_repair. A launch that fails after `claude --bg` ran (its receipt exists) is stopped by identity before the round
    closes blocked, and the stop's outcome is recorded; an unconfirmed one stays owed (`stop_pending`)."""
    from .automatic import fix_rounds, repair_timeout
    from .guardrails import epoch, iso
    lane = next(iter(entry["lanes"]))
    node, path = entry["session"]["node"], Path(entry["workspace"])
    rounds = entry.get("rounds") or max(fix_rounds(runtime.plan), entry["round"])
    launched_at = datetime.now(timezone.utc).isoformat()
    timeout = repair_timeout(runtime.plan)
    deadline = (f" Your deadline is {iso(int(epoch(launched_at) + timeout))} (UTC), {timeout // 60} minutes after this launch: write your "
                "completion file before it; past it the controller stops this session and applies nothing.")
    brief = entry.get("brief") or {}
    prompt = session_brief(runtime, lane, entry, rounds, deadline, brief.get("findings"), Path(brief["delta"]) if brief.get("delta") else None)
    try:
        receipt = runtime.sessions.run_repair(node, prompt, entry["session"]["launch_token"], path, launched_at,
                                              {"lane": lane, "round": entry["round"], "trigger": entry["trigger"], "repair": entry["n"]})
    except Exception as error:
        reason = f"the repair session did not launch: {error}"
        if (runtime.directory / f"{node}.interactive.json").exists():  # `claude --bg` ran: a session may exist.
            reason += "; " + stop_outcome(runtime, entry, node)
        close_session(runtime, entry, "blocked", reason)
        runtime.event(f"repair_{lane}", "failed", f"round {entry['round']}: {entry['reason']}")
        return entry
    entry["session"]["session_id"] = receipt["session_id"]
    save_entry(runtime.directory, entry)
    runtime.event(f"repair_{lane}", "running", f"round {entry['round']}: repair session launched ({node}, {entry.get('what', 'at')} "
                                               f"{entry['workspace_commit'][:8]}, {entry['trigger']} block)")
    return entry


def stop_outcome(runtime, entry: dict, node: str) -> str:
    """Stop the round's session by its recorded identity and say how it went; an unconfirmed stop is owed (`stop_pending`), and
    retry_stops issues it again before the next controller goes on."""
    try:
        runtime.stop_repair(node)
    except Exception as error:
        if "missing before stop" in str(error):
            return "no session of it was listed to stop"
        entry["stop_pending"] = True
        runtime.event(f"repair_{next(iter(entry['lanes']))}", "warning", f"repair session {node} stop not confirmed: {error}")
        return f"stop not confirmed: {error}"
    entry.pop("stop_pending", None)
    return "its session was stopped"


def retry_stops(runtime) -> None:
    """Issue again every repair session stop that was not confirmed (a round closed with `stop_pending`), as a reviewer stop is
    retried: before the controller (or a repair command) goes on. A stop still unconfirmed stays owed and is said again."""
    for entry in session_entries(runtime.directory):
        if entry.get("stop_pending"):
            outcome = stop_outcome(runtime, entry, entry["session"]["node"])
            entry["stop_retried"] = outcome
            save_entry(runtime.directory, entry)
            if not entry.get("stop_pending"):
                runtime.event(f"repair_{next(iter(entry['lanes']))}", "stopped", f"repair session {entry['session']['node']}: {outcome} (retried)")


def close_session(runtime, entry: dict, status: str, reason: str) -> None:
    entry.update(status=status, reason=reason, closed_at=now())
    save_entry(runtime.directory, entry)


def wait_session(runtime, entry: dict, *, clock=None, sleep=None) -> tuple[dict, bool]:
    """The repair session's accepted completion, as wait_handoffs accepts a lane's: a valid file once its turn is over, and
    whether the session had already ended on its own. A session that ended (its row in a terminal state, gone past an update's
    respawn gap, or never bound) is judged by its completion file. RepairBlocked for a completion that is blocked or asks a
    question, a session that ended without one, or the deadline."""
    from .automatic import read_signal, repair_timeout, turn_over
    from .guardrails import epoch
    from .interactive import TERMINAL_STATES, SessionGap, UpdateGaps
    from .sessions import TransientInfraError
    clock, sleep = clock or time.time, sleep or time.sleep
    directory, node = runtime.directory, entry["session"]["node"]
    receipt = read_json(directory / f"{node}.interactive.json")
    deadline = epoch(receipt["launch_requested_at"]) + repair_timeout(runtime.plan)
    gaps = UpdateGaps(runtime.sessions, directory, clock)
    path = directory / f"{node}.completion.json"

    def judged(ended: bool) -> tuple[dict, bool]:
        try:
            item = read_signal(runtime, node, launch_token=entry["session"]["launch_token"])
        except ValueError as error:
            raise RepairBlocked(f"its completion file was refused: {error}") from error
        if item["status"] == "completed":
            return item, ended
        raise RepairBlocked(f"the repair session ended {item['status']}: {item.get('question') or item['summary']}")
    while True:
        rows = runtime.sessions.inventory()
        bound = read_json(directory / f"{node}.interactive.json").get("background_id")
        ended = bool(bound) and any(row.get("id") == bound and row.get("state") in TERMINAL_STATES for row in rows)
        row = None
        if not ended:
            try:
                row = gaps.row(node, rows)
            except SessionGap:
                row = {}  # An update is respawning it: no verdict yet.
            except TransientInfraError:
                ended = True  # Not listed live past the respawn gap: it ended.
            ended = ended or row is None
        if ended:
            if path.exists():
                return judged(True)
            raise RepairBlocked(f"the repair session {node} ended without a completion file")
        if row and (turn_over(row) or row.get("state") == "blocked") and path.exists():
            return judged(False)
        if clock() >= deadline:
            raise RepairBlocked(f"the repair session's deadline ({repair_timeout(runtime.plan) // 60} minutes) passed without a completion file")
        sleep(2)


def capture_session(runtime, entry: dict) -> tuple[str, list[str]]:
    """The workspace as one commit on its HEAD, built in a private index (the workspace's own index and HEAD are never
    written), and the untracked paths it left behind. Every tracked change is taken, so an edit of another lane's file is
    refused with the round (derive); a new file only under the lane's owned paths: the leftovers of the session's own runs
    (coverage output, reports, caches git does not ignore) are listed as `left_behind`, never captured. A ref keeps the
    commit until the repair's own."""
    directory, repo = runtime.directory, Path(runtime.plan["repository"])
    workspace = Path(entry["workspace"])
    lane = next(iter(entry["lanes"]))
    prefixes = [safe_path(prefix) for prefix in runtime.worker_policy(lane)["owned_paths"]]
    head = git(workspace, "rev-parse", "HEAD")
    untracked = sorted(filter(None, subprocess.check_output(["git", "-C", str(workspace), "ls-files", "--others", "--exclude-standard", "-z"]).decode().split("\0")))
    owned = [path for path in untracked if any(owns(path, prefix) for prefix in prefixes)]
    left_behind = [path for path in untracked if path not in owned]
    with tempfile.TemporaryDirectory(prefix="workflow-repair-") as scratch:
        env = {**commit_env(), "GIT_INDEX_FILE": str(Path(scratch) / "index")}
        subprocess.run(["git", "-C", str(workspace), "read-tree", head], env=env, check=True, capture_output=True)
        subprocess.run(["git", "-C", str(workspace), "add", "-u", "--", "."], env=env, check=True, capture_output=True)
        if owned:
            subprocess.run(["git", "-C", str(workspace), "--literal-pathspecs", "add", "--pathspec-from-file=-", "--pathspec-file-nul"],
                           env=env, input="\0".join(owned).encode() + b"\0", check=True, capture_output=True)
        tree = subprocess.check_output(["git", "-C", str(workspace), "write-tree"], env=env, text=True).strip()
        if tree == git(workspace, "rev-parse", f"{head}^{{tree}}"):
            raise RepairBlocked("the repair session changed nothing" + (f" in lane {lane}'s owned paths (left behind: {', '.join(left_behind)})"
                                                                         if left_behind else ""))
        commit = subprocess.check_output(["git", "-C", str(workspace), "-c", "commit.gpgsign=false", "commit-tree", tree, "-p", head, "-m",
                                          f"Workflow {runtime.plan['run_id']}: repair session {entry['n']}"], env=env, text=True).strip()
    subprocess.run(["git", "-C", str(repo), "update-ref", f"refs/workflow-repair/{hashlib.sha256(str(directory).encode()).hexdigest()[:16]}/{entry['n']}/capture", commit], check=True)
    return commit, left_behind


def session_reason(entry: dict) -> str:
    return f"repair session round {entry['round']}: {entry['trigger']}"


class StopNotConfirmed(RepairBlocked):
    """The round's session could not be stopped: nothing is captured, and the stop stays owed (retry_stops)."""


def ended_stop(runtime, node: str) -> None:
    """A session that ended on its own needs no `claude stop`: its stop is recorded confirmed, so nothing retries it."""
    receipt = read_json(runtime.directory / f"{node}.interactive.json")
    save_json(runtime.directory / f"{node}.stop.json", {"background_id": receipt.get("background_id"), "session_id": receipt.get("session_id"),
                                                        "pid": None, "stopped": True, "ended": True})


def session_result(runtime, entry: dict, lane: str) -> dict:
    """The completion of a launched session: waited for, then the session is stopped. A stop already confirmed (a controller died
    before the capture) reads the file again. An interruption or an outage leaves the session running for the next controller.
    A stop that is not confirmed captures nothing (StopNotConfirmed)."""
    directory, node = runtime.directory, entry["session"]["node"]
    stop = directory / f"{node}.stop.json"
    if stop.exists() and read_json(stop).get("stopped") is True:
        from .automatic import read_signal
        try:
            item = read_signal(runtime, node, launch_token=entry["session"]["launch_token"])
        except ValueError as error:
            raise RepairBlocked(f"its completion file was refused: {error}") from error
        if item["status"] != "completed":
            raise RepairBlocked(f"the repair session ended {item['status']}: {item.get('question') or item['summary']}")
        return item
    try:
        item, ended = wait_session(runtime, entry)
    except RepairBlocked as blocked:
        outcome = stop_outcome(runtime, entry, node)
        if entry.get("stop_pending"):
            raise StopNotConfirmed(f"{blocked}; {outcome}") from blocked
        raise
    if ended:
        ended_stop(runtime, node)
        return item
    outcome = stop_outcome(runtime, entry, node)
    if entry.get("stop_pending"):
        raise StopNotConfirmed(f"its completion was accepted but the session's {outcome}; nothing was captured")
    return item


def bind_session(runtime, entry: dict) -> None:
    """A round whose controller died between the receipt and the journal: the receipt's session id (reconciled when the launch
    never bound one) joins the journal, so the repaired snapshot names its writer (prior_session_ids)."""
    path = runtime.directory / f"{entry['session']['node']}.interactive.json"
    if entry["session"].get("session_id") or not path.exists():
        return
    session_id = read_json(path).get("session_id")
    if not session_id:
        try:
            session_id = runtime.sessions.reconcile(entry["session"]["node"], path, read_json(path))["session_id"]
        except RuntimeError as error:
            from .sessions import TransientInfraError
            if isinstance(error, TransientInfraError):
                raise
            raise RepairBlocked(f"its launch never bound a session and none can be reconciled: {error}") from error
    entry["session"]["session_id"] = session_id
    save_entry(runtime.directory, entry)


def finish_session(runtime, graph, config, entry: dict) -> dict:
    """From a launched (or captured, or recorded) session to its applied repair or its blocked round: wait, stop, capture, then
    the --commit path S1 to S6. Each step is resumable: a controller that died mid-round continues it here."""
    directory = runtime.directory
    lane = next(iter(entry["lanes"]))
    try:
        if entry["status"] == "launched":
            if not (directory / f"{entry['session']['node']}.interactive.json").exists():
                entry = start_session(runtime, entry)  # The controller died before the launch: complete it.
                if entry["status"] == "blocked":
                    return entry
            bind_session(runtime, entry)
            item = session_result(runtime, entry, lane)
            commit, left_behind = capture_session(runtime, entry)
            entry.update(status="captured", source_commit=commit, captured_at=now(), summary=item["summary"], left_behind=left_behind)
            save_entry(directory, entry)
    except RepairBlocked as error:
        close_session(runtime, entry, "blocked", str(error))
        runtime.event(f"repair_{lane}", "failed", f"round {entry['round']}: {error}")
        return entry
    try:
        applied = apply_repair(runtime, graph, config, [lane], entry["source_commit"], session_reason(entry), False, entry.get("by", "operator"),
                               session=None if entry["status"] == "recorded" else entry, after_review=entry["trigger"] == "review")
    except (ValueError, RuntimeError, subprocess.SubprocessError) as error:
        if load_entry(directory, entry["n"])["status"] != "captured":
            raise  # S1 is written: only the identical command completes it (refuse_recorded says which).
        close_session(runtime, entry, "blocked", f"its change was refused: {error}")
        runtime.event(f"repair_{lane}", "failed", f"round {entry['round']}: its change was refused: {error}")
        return entry
    runtime.event(f"repair_{lane}", "passed", f"round {entry['round']}: repair {applied['n']} applied; {lane} is verified again")
    return applied


def load_entry(directory: Path, n: int) -> dict:
    return next(entry for entry in load_repairs(directory) if entry["n"] == n)


def repair_session(runtime, graph, config, lane: str, *, actor: str, trigger: str, findings: list[dict] | None = None,
                   delta: Path | None = None, review_round: int | None = None) -> dict:
    """One round: launch a narrowed session for `lane` (or continue the one the journal has open), wait, stop, capture, apply.
    Returns the journal entry: `applied`, or `blocked` with its reason. Never invokes the graph; the caller holds the locks."""
    entry = open_session(runtime.directory)
    if entry is not None and next(iter(entry["lanes"])) != lane:
        raise ValueError(f"Repair session {entry['n']} of lane {next(iter(entry['lanes']))} is not finished; it is continued first")
    if entry is None:
        entry = launch_session(runtime, graph, config, lane, actor, trigger, findings=findings, delta=delta, review_round=review_round)
        if entry["status"] == "blocked":
            return entry
    return finish_session(runtime, graph, config, entry)


def run_session_command(runtime, graph, config, lanes: list[str], actor: str) -> None:
    """`repair <run> <lane> --session --live`: one round for one lane, then the continuation; never the graph itself."""
    if not runtime.plan.get("automatic"):
        raise ValueError("A repair session completes like an automatic worker: --session needs an automatic run; use --workspace")
    if len(lanes) != 1:
        raise ValueError("A repair session repairs one lane; name one")
    retry_stops(runtime)  # A stop a round left unconfirmed is issued again first.
    entry = repair_session(runtime, graph, config, lanes[0], actor=actor, trigger=blocked_trigger(runtime, graph, config))
    if entry["status"] != "applied":
        raise ValueError(f"Repair session {entry['n']} (round {entry['round']} of lane {lanes[0]}) ended blocked: {entry['reason']}. "
                         f"Its workspace stays at {entry['workspace']}; commit a fix there by hand: repair {runtime.directory} {lanes[0]} --commit <sha> "
                         f"--reason <why> {BY_OPERATOR}")
    print(f"Repair session {entry['n']} applied (round {entry['round']} of lane {lanes[0]}). Continue with: {continuation(runtime)}")


def blocked_trigger(runtime, graph, config) -> str:
    """What a session repairs from: `candidate` or `verify` (a continued session keeps its own)."""
    entry = open_session(runtime.directory)
    if entry is not None:
        return entry["trigger"]
    state = graph.get_state(config)
    return "candidate" if tuple(state.next) == ("candidate",) else "verify"


def repair_main(argv=None):
    parser = argparse.ArgumentParser(prog="python -m workflow repair", description="Turn an operator's fix commit into new snapshots of "
                                     "frozen lanes blocked at their checks or at the combined candidate, before review. --commit and "
                                     "--workspace launch nothing and run no check; --session --live launches one narrowed worker session "
                                     "for the lane and applies what it changes. automatic --live (or retry for a manual run) re-verifies.")
    parser.add_argument("directory", type=Path)
    parser.add_argument("lanes", help="The lane the fix belongs to, or comma-separated lanes for a fix on the combined candidate")
    parser.add_argument("--commit", metavar="SHA", help="The fix commit, on the failing candidate or on the lane's snapshot")
    parser.add_argument("--reason", help="Why: recorded in the journal, the timeline, the snapshot summary and the reviewer prompt")
    parser.add_argument("--workspace", action="store_true", help="Create a detached worktree at the right base, with a brief, to commit the fix in")
    parser.add_argument("--dry-run", action="store_true", help="Validate and print what --commit would do; write nothing")
    parser.add_argument("--session", action="store_true", help="Launch one repair session for the lane, narrowed to what blocked it, in a "
                                                                "repair workspace; wait for it, stop it and apply its change (needs --live)")
    parser.add_argument("--live", action="store_true", help="--session: really launch the native session")
    add_actor_argument(parser)
    args = parser.parse_args(argv)
    directory = args.directory.resolve()
    try:
        actor = require_actor(args, "repair")
        from .abandon import refuse_abandoned
        refuse_abandoned(directory)
        if [bool(args.commit), args.workspace, args.session].count(True) != 1:
            raise ValueError("Give exactly one of --commit <sha> (apply a fix), --workspace (make a worktree to commit one in) and "
                             "--session --live (a repair session makes the fix)")
        if args.session and not args.live:
            raise ValueError("--session launches a native Claude session for the lane: add --live")
        if args.live and not args.session:
            raise ValueError("--live applies to --session")
        if args.session and args.reason:
            raise ValueError("--reason applies to --commit: a repair session's reason is its round and what blocked the lane")
        if args.commit and not (args.reason or "").strip():
            raise ValueError("--reason is required with --commit and must not be empty")
        if args.dry_run and args.workspace:
            raise ValueError("--dry-run applies to --commit")
        with run_lock(directory, "automatic-supervisor.lock"), run_lock(directory):
            runtime = Pipeline(directory)
            if "workers" not in runtime.plan:
                raise ValueError("A plan pinned before configured lanes cannot be repaired; start a revised run")
            lanes = parse_lanes(args.lanes, runtime.workers)
            if not (directory / "pipeline.sqlite").exists():
                raise ValueError("The run was never started; there is no frozen lane to repair")
            with SqliteSaver.from_conn_string(str(directory / "pipeline.sqlite")) as saver:
                graph, config = build_pipeline(saver, runtime), graph_config(runtime)
                if args.workspace:
                    make_workspace(runtime, graph, config, lanes, args.reason)
                elif args.session:
                    run_session_command(runtime, graph, config, lanes, actor)
                else:
                    apply_repair(runtime, graph, config, lanes, args.commit, args.reason.strip(), args.dry_run, actor)
    except (ValueError, RuntimeError, OSError, subprocess.SubprocessError) as error:
        parser.exit(1, f"Blocked: {error}\nAll work/evidence retained at {directory}. Nothing launched.\n")
