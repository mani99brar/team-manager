"""`python -m workflow repair`: an operator's fix commit becomes a new lane snapshot after freeze, before review.

Frozen snapshots never change, so a lane blocked at `verify_<lane>` or at the combined candidate used to need a new
run. `repair` records the fix in `repairs.json`, builds one deterministic snapshot commit per named lane (the lane's
snapshot with the fix's files it owns, parent the run's base), raises the attempt counters past the existing evidence
and forks the run's LangGraph thread at the freeze boundary with the new snapshots. It launches no session, runs no
check and never invokes the graph: `automatic --live` (or `retry` for a manual run) re-verifies the repaired lanes,
rechecks the others, checks a new candidate generation for every lane and only then reaches review. Every apply step
is idempotent, so a crash is completed by rerunning the identical command. `--workspace` makes a detached worktree at
the right base to commit the fix in, never in the source checkout.
"""
from __future__ import annotations

import argparse
import hashlib
import os
import shlex
import subprocess
import sys
import tempfile
from datetime import datetime
from pathlib import Path

from langgraph.checkpoint.sqlite import SqliteSaver

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


def candidate_paths(directory: Path, generation: int) -> tuple[Path, Path]:
    """`candidate.json` and `candidate/` before any repair; `candidate-<g>.json` and `candidate-<g>/` after g applied repairs."""
    suffix = f"-{generation}" if generation else ""
    return directory / f"candidate{suffix}.json", directory / f"candidate{suffix}"


def repair_command(directory: Path, entry: dict) -> str:
    return (f"{sys.executable} -m workflow repair {shlex.quote(str(directory))} {','.join(entry['lanes'])} "
            f"--commit {entry['source_commit']} --reason {shlex.quote(entry['reason'])}")


def refuse_recorded(directory: Path) -> None:
    """While a repair is recorded its refs and counters may already exist: the failed branch never resumes, completing it is the way on."""
    for entry in load_repairs(directory):
        if entry["status"] == "recorded":
            raise RuntimeError(f"Repair {entry['n']} is recorded but not applied; rerun exactly: {repair_command(directory, entry)}")


def repair_note(directory: Path) -> str:
    """The reviewer prompt's line per applied repair: the lanes the operator changed, why, and where that change is."""
    note = ""
    for entry in applied_repairs(directory):
        diff = directory / f"repair-{entry['n']}.diff"
        note += (f" Lane(s) {', '.join(entry['lanes'])} were repaired by the operator before review (repair {entry['n']}: {entry['reason']}); "
                 f"the operator's change is {diff}; the rest of review.diff is the workers' work.")
    return note


def repaired_snapshot(previous: dict, entry: dict, lane: str) -> dict:
    """The lane's snapshot after `entry`: the new commit and files, the worker's own session and handoff, the provenance."""
    item = entry["lanes"][lane]
    summary = (f"{previous['summary']}\n\nOperator repair {entry['n']}: {entry['reason']} (files {', '.join(item['fix_files'])}; "
               f"source {entry['source_commit']} on {entry['base_kind']} {entry['base_commit'][:8]})")
    return {"commit": item["commit"], "changed_files": item["changed_files"], "session_id": previous["session_id"],
            "summary": summary, "open_assumptions": previous["open_assumptions"],
            "repair": {"n": entry["n"], "mode": entry["mode"], "base_kind": entry["base_kind"], "base_commit": entry["base_commit"],
                       "previous_commit": item["previous_commit"], "source_commit": entry["source_commit"], "fix_files": item["fix_files"],
                       "reason": entry["reason"], "recorded_at": entry["recorded_at"]}}


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
        return f"{executable} -m workflow automatic {directory} --live"
    return f"{executable} -m workflow retry {directory}"


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


def blocked_step(runtime, state) -> dict:
    """The check verdict the run stopped at: a blocked packet of the candidate, or of a failed verify_<lane>."""
    directory = runtime.directory
    pending = [item.value.get("kind") for task in state.tasks for item in task.interrupts]
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
                raise ValueError(f"Interrupted check at {folder}; use retry --phase {phase} --node {node}")
    failed = [task.name for task in state.tasks if task.error and task.name in state.next]
    verifies = {f"verify_{node}" for node in runtime.workers}
    if failed == ["candidate"] and tuple(state.next) == ("candidate",):
        phase, nodes = "candidate", runtime.workers
    elif failed and set(state.next) <= verifies:
        phase, nodes = "worker", [name.removeprefix("verify_") for name in failed]
    else:
        raise ValueError("The run did not stop at a check verdict of the candidate or a verify_<lane> step; inspect, then retry")
    packets = []
    for node in nodes:
        attempt = raw_attempt(directory, phase, node)
        path = directory / "verification" / phase / node / str(attempt) / "packet.json"
        packet = read_json(path) if path.exists() else None
        if packet and packet["gate"]["status"] == "blocked":
            packets.append({"phase": phase, "node_id": node, "path": str(path.relative_to(directory)), "sha256": digest_file(path),
                            "attempt": attempt, "output_commit": packet["expected"]["output_commit"], "reasons": packet["gate"]["reasons"]})
    if not packets:
        raise ValueError("The failed step has no blocked packet at its current attempt, so it is not a check verdict "
                         "(an infrastructure error, a cherry-pick conflict, a partial candidate); inspect, then retry")
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


def blocked_run(runtime, graph, config, applied: list[dict]) -> tuple:
    """Every state refusal. Returns the head, the blocked step, the fork point and the effective snapshots."""
    state = graph.get_state(config)
    check_before_review(runtime, state)
    if len(applied) >= MAX_REPAIRS:
        raise ValueError(f"{len(applied)} repairs are already applied to this run (at most {MAX_REPAIRS}); start a revised run")
    # A failed verify superstep writes no checkpoint: a continuation that failed a lane's check again leaves the fork as
    # the head with the error pending. Only a fork nothing has failed from is a repair not yet continued.
    if applied and state.config["configurable"]["checkpoint_id"] == applied[-1]["head_after"] and not any(task.error for task in state.tasks):
        raise ValueError(f"Repair {applied[-1]['n']} is applied and the run has not continued from it; an applied repair is not "
                         f"replaced. Continue with: {continuation(runtime)}")
    blocked = blocked_step(runtime, state)
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
            handle.write(subprocess.check_output(["git", "-C", runtime.plan["repository"], "diff", "--binary", item["previous_commit"], item["commit"]]))


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
    answers = " ".join(f"Answers {packet['phase']}/{packet['node_id']} attempt {packet['attempt']}: {'; '.join(packet['reasons'])}."
                       for packet in entry["blocked"]["packets"])
    for lane, item in entry["lanes"].items():
        runtime.event(f"verify_{lane}", "paused", f"Repair {n} by the operator: snapshot {item['commit'][:8]} = {item['previous_commit'][:8]} + "
                                                  f"{entry['source_commit'][:8]} on {entry['base_kind']} {entry['base_commit'][:8]} "
                                                  f"({', '.join(item['fix_files'])}). Reason: {entry['reason']}. {answers} "
                                                  f"Continue with {continuation(runtime, 'python')}")
    superseded = candidate_paths(directory, n - 1)[0]
    if superseded.exists():
        runtime.event("candidate", "paused", f"Repair {n} supersedes combined revision {read_json(superseded)['commit'][:8]}; "
                                             f"candidate-{n} is built after the lanes re-verify")
    runtime.event("controller", "running", f"Repair {n} applied: checkpoint forked from {entry['fork_from'][:8]} (after handoff); attempts "
                                           + ", ".join(f"{key} {value}" for key, value in entry["attempt_targets"].items()))
    entry.update(status="applied", applied_at=now(), head_after=head_after)
    save_entry(directory, entry)
    report(runtime, graph.get_state(config))


def apply_repair(runtime, graph, config, lanes: list[str], commit: str, reason: str, dry_run: bool) -> None:
    directory, repo = runtime.directory, Path(runtime.plan["repository"])
    source = resolve_commit(repo, commit)
    entries = load_repairs(directory)
    applied = [entry for entry in entries if entry["status"] == "applied"]
    recorded = next((entry for entry in entries if entry["status"] == "recorded"), None)
    if recorded is None:
        state, blocked, fork, previous = blocked_run(runtime, graph, config, applied)
    elif list(recorded["lanes"]) != lanes or recorded["source_commit"] != source or recorded["reason"] != reason:
        raise RuntimeError(f"Repair {recorded['n']} is recorded but not applied; only the identical command completes it: "
                           f"{repair_command(directory, recorded)}")
    else:
        # Completing a crashed repair: the head may already be its fork, so the recorded step and fork point stand.
        check_before_review(runtime, graph.get_state(config))
        check_source(runtime)
        blocked, previous = recorded["blocked"], effective_snapshots(directory, applied)
        fork = fork_point(graph, config, runtime, previous, recorded["fork_from"])
    derived = derive(runtime, lanes, source, blocked["packets"][0]["phase"], previous)
    if recorded is None:
        targets = attempt_targets(directory, lanes, runtime.workers)
        entry = {"n": len(entries) + 1, "status": "recorded", "mode": "commit", "reason": reason, "recorded_at": now(), "blocked": blocked,
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
        return
    if recorded is None:
        record_repair(directory, entry)                                                   # S1
    commit_snapshots(runtime, entry, derived)                                             # S2
    save_lanes(runtime, entry, derived)                                                   # S3
    raise_attempts(directory, entry)                                                      # S4
    snapshots = effective_snapshots(directory, applied + [entry])
    finish_repair(runtime, graph, config, entry, fork_run(graph, config, runtime, entry, fork, snapshots))  # S5, S6
    print(f"Repair {entry['n']} applied: {reason}\n{describe(entry, derived, dry_run)}\n  checkpoint forked from {entry['fork_from']} "
          f"(after handoff); nothing launched, no check run\nContinue with: {continuation(runtime)}")


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


def make_workspace(runtime, graph, config, lanes: list[str], reason: str | None) -> None:
    """A detached worktree at the base the fix belongs on, with a brief of what blocked the run. No journal, no graph state."""
    directory, repo = runtime.directory, Path(runtime.plan["repository"])
    refuse_recorded(directory)
    applied = applied_repairs(directory)
    _, blocked, _, previous = blocked_run(runtime, graph, config, applied)
    if blocked["packets"][0]["phase"] == "candidate":
        base = read_json(candidate_paths(directory, len(applied))[0])["commit"]
        what = "the combined candidate that failed"
    elif len(lanes) == 1:
        base, what = previous[lanes[0]]["commit"], f"the {lanes[0]} snapshot"
    else:
        raise ValueError("A worker-phase block has no combined candidate: a fix on a lane snapshot repairs one lane only; name one lane")
    number = 1
    while (directory / f"repair-workspace-{number}").exists() or (directory / f"repair-workspace-{number}.brief.md").exists():
        number += 1
    path = directory / f"repair-workspace-{number}"
    git_worktree(repo, "add", "--detach", str(path), base)
    command = (f"{sys.executable} -m workflow repair {shlex.quote(str(directory))} {','.join(lanes)} --commit $(git -C {shlex.quote(str(path))} rev-parse HEAD) "
               f"--reason {shlex.quote(reason or '<why the fix is needed>')}")
    brief = [f"# Repair workspace {number} of run {runtime.plan['run_id']}", "",
             f"Detached at {base}, {what}. Commit the fix here, never on the source branch {runtime.plan['source_branch']}: "
             f"integration needs it at the run's base {runtime.plan['base_commit']}.", "", f"## Blocked: {blocked['step']}"]
    for packet in blocked["packets"]:
        folder = (directory / packet["path"]).parent
        evidence = sorted(folder.glob("setup-*.log")) + sorted(folder.glob("check-*.log")) + sorted(folder.glob("browser-report-*.json"))
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


def repair_main(argv=None):
    parser = argparse.ArgumentParser(prog="python -m workflow repair", description="Turn an operator's fix commit into new snapshots of "
                                     "frozen lanes blocked at their checks or at the combined candidate, before review. Launches nothing and "
                                     "runs no check; automatic --live (or retry for a manual run) re-verifies.")
    parser.add_argument("directory", type=Path)
    parser.add_argument("lanes", help="The lane the fix belongs to, or comma-separated lanes for a fix on the combined candidate")
    parser.add_argument("--commit", metavar="SHA", help="The fix commit, on the failing candidate or on the lane's snapshot")
    parser.add_argument("--reason", help="Why: recorded in the journal, the timeline, the snapshot summary and the reviewer prompt")
    parser.add_argument("--workspace", action="store_true", help="Create a detached worktree at the right base, with a brief, to commit the fix in")
    parser.add_argument("--dry-run", action="store_true", help="Validate and print what --commit would do; write nothing")
    args = parser.parse_args(argv)
    directory = args.directory.resolve()
    try:
        if bool(args.commit) == args.workspace:
            raise ValueError("Give exactly one of --commit <sha> (apply a fix) and --workspace (make a worktree to commit one in)")
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
                else:
                    apply_repair(runtime, graph, config, lanes, args.commit, args.reason.strip(), args.dry_run)
    except (ValueError, RuntimeError, OSError, subprocess.SubprocessError) as error:
        parser.exit(1, f"Blocked: {error}\nAll work/evidence retained at {directory}. Nothing launched.\n")
