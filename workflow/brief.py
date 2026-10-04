"""`python -m workflow brief <run>` (C30): what a follow-up run of a finished run needs, as Markdown on stdout.

A run blocked by its review (or by a usage limit, or approved with open P2s) is followed up by a new run of the same
feature, launched with `launch --run-id <feature>-00N --follows <run>`. The brief is what the operator pastes into that
run's tasks, lane by lane: the restore recipe of the lane's owned paths from the candidate (or the lane's snapshot when
there is no candidate), every reviewer's findings verbatim, the worker's own claims, and the review sidecar's unresolved
handoff. It reads the run's files and writes nothing; a file it cannot read is named, never raised.

The restore recipe is `git restore --source=<sha> --staged --worktree -- <paths>`: unlike `git checkout <sha> -- <paths>`
(overlay mode) it deletes a file the candidate removed. The paths are the followed run's pinned policy's, so a follow-up
whose policy moved them needs the recipe adjusted.
"""
from __future__ import annotations

import argparse
import shlex
import subprocess
import sys
from collections import Counter
from pathlib import Path

from .pipeline import CANDIDATE_REF, digest_file, run_ref
from .sessions import plan_excluded, plan_workers, read_json, review_node, reviewer_ids

def optional_json(path: Path):
    """The file's JSON, or None when it is missing or unreadable."""
    try:
        return read_json(path) if path.is_file() else None
    except (OSError, ValueError):
        return None


def candidate_commit(directory: Path) -> str | None:
    """The run's candidate: the reviewed one (review.json, then review-bundle.json), else the latest candidate generation."""
    for name in ("review.json", "review-bundle.json"):
        item = optional_json(directory / name)
        if isinstance(item, dict) and isinstance(item.get("candidate_commit"), str):
            return item["candidate_commit"]
    generations = sorted(directory.glob("candidate*.json"), key=lambda path: int(path.stem.partition("-")[2] or 0) if path.stem.partition("-")[2].isdigit() else -1)
    for path in reversed(generations):
        item = optional_json(path)
        if isinstance(item, dict) and isinstance(item.get("commit"), str):
            return item["commit"]
    return None


def follows_record(directory: Path) -> dict:
    """plan.follows of a run that follows `directory`: {run_id, verdict or null, candidate_commit or null}. Refused only when
    `directory` has no plan.json; a run without review.json (a usage limit, a block before review) has verdict null."""
    directory = Path(directory).resolve()
    if not (directory / "plan.json").is_file():
        raise ValueError(f"The followed run {directory} has no plan.json: name a run directory")
    plan = read_json(directory / "plan.json")
    review = optional_json(directory / "review.json")
    verdict = review.get("verdict") if isinstance(review, dict) and review.get("verdict") in {"approved", "blocked"} else None
    return {"run_id": plan.get("run_id", directory.name), "verdict": verdict, "candidate_commit": candidate_commit(directory)}


class ReadOnlyRun:
    """The little of a Pipeline the controller's reviewer readers use: the run's directory, plan, lanes and bundle."""

    def __init__(self, directory: Path, plan: dict):
        self.directory, self.plan, self.workers = directory, plan, plan_workers(plan)

    def validate_bundle(self) -> tuple[dict, str]:
        path = self.directory / "review-bundle.json"
        return read_json(path), digest_file(path)


def reviewer_file(run: ReadOnlyRun, reviewer_id: str) -> tuple[str | None, list, str | None]:
    """(file name, findings, why it was not read) of the reviewer's bound file: its native completion file, its print job's
    stdout.json or a manual import, validated as the controller does. Never raises."""
    from .automatic import check_finding_lanes, read_review_completion, review_schema, reviewer_status_path
    node = review_node(reviewer_id)
    directory = run.directory
    for name in (f"{node}.completion.json", f"{node}.stdout.json", f"{node}.imported.json"):
        if (directory / name).exists():
            break
    else:
        return None, [], None
    try:
        if name.endswith(".completion.json"):
            return name, read_review_completion(run, reviewer_id)["findings"], None
        if name.endswith(".stdout.json"):
            from jsonschema import validate
            result, status = read_json(directory / name), read_json(reviewer_status_path(run, reviewer_id))
            if result.get("session_id") != status.get("session_id") or result.get("is_error") is not False or result.get("subtype") != "success":
                raise RuntimeError("the print job did not succeed with its own session")
            decision = result.get("structured_output")
            validate(decision, review_schema(run))
            check_finding_lanes(run, decision["findings"])
            return name, decision["findings"], None
        imported = read_json(directory / name)
        return name, list(imported["review"]["findings"]), None  # Validated against the exact bundle when it was imported.
    except Exception as error:  # Any refusal of the controller's readers: the brief names it and goes on.
        return name, [], str(error) or type(error).__name__


def collect_findings(run: ReadOnlyRun, review: dict | None) -> tuple[list[dict], list[str]]:
    """Every finding of review.json, then those of each reviewer's bound file that review.json does not hold (unrecorded)."""
    recorded = list(review.get("findings") or []) if isinstance(review, dict) else []
    findings = [{**finding, "source": None} for finding in recorded if isinstance(finding, dict)]
    held = Counter((finding.get("reviewer"), finding.get("severity"), finding.get("message"), finding.get("disposition"), finding.get("worker"))
                   for finding in findings)
    notes = []
    declared = reviewer_ids(run.plan)
    for reviewer_id in declared:
        name, found, error = reviewer_file(run, reviewer_id)
        if error:
            notes.append(f"Reviewer {reviewer_id}'s {name} was not read: {error}")
            continue
        for finding in found:
            key = (reviewer_id, finding.get("severity"), finding.get("message"), finding.get("disposition"), finding.get("worker"))
            # Single-reviewer records written before reviewer tags hold the finding without one.
            untagged = (None, *key[1:])
            if held[key] > 0:
                held[key] -= 1
            elif held[untagged] > 0:
                held[untagged] -= 1
            else:
                findings.append({**finding, "reviewer": reviewer_id, "source": name})
    return findings, notes


def finding_line(finding: dict) -> str:
    """`- [P1 open] <message, verbatim> (reviewer general; requirement: "…")`, unrecorded ones marked with their file."""
    extra = [f"reviewer {finding['reviewer']}" if finding.get("reviewer") else None,
             f"lane {finding['worker']}" if finding.get("worker") in {"multiple", "none"} else None,
             f"requirement: {finding['requirement']!r}" if finding.get("requirement") else None]
    text = str(finding.get("message", "")).replace("\n", "\n  ")
    line = f"- [{finding.get('severity')} {finding.get('disposition')}] {text}"
    if any(extra):
        line += f" ({'; '.join(item for item in extra if item)})"
    if finding.get("source"):
        line += f" (unrecorded: from {finding['source']}, not in review.json)"
    return line


def existing_paths(repository: str, revisions: list[str], paths: list[str]) -> tuple[list[str], list[str], str | None]:
    """The owned paths at one of `revisions` (a path in neither would fail `git restore`), the others, and why nothing was checked."""
    present, absent = [], []
    for path in paths:
        name = path.rstrip("/") or "."
        try:
            found = any(subprocess.run(["git", "-C", repository, "cat-file", "-e", f"{revision}:{name}"], capture_output=True, timeout=30).returncode == 0
                        for revision in revisions)
        except (OSError, subprocess.SubprocessError) as error:
            return list(paths), [], str(error)
        (present if found else absent).append(path)
    if not present and absent:
        try:
            subprocess.run(["git", "-C", repository, "rev-parse", "--git-dir"], capture_output=True, timeout=30, check=True)
        except (OSError, subprocess.SubprocessError):
            return list(paths), [], f"{repository} is not a readable Git checkout any more"
    return present, absent, None


def lane_claims(directory: Path, lane: str, snapshot: dict | None) -> list[str]:
    """The worker's untested, verify_yourself and open_assumptions, from its completion file (the snapshot's assumptions otherwise)."""
    completion = optional_json(directory / f"{lane}.completion.json")
    completion = completion if isinstance(completion, dict) else {}
    lines = []
    untested = completion.get("untested")
    if isinstance(untested, list):
        lines.append("- Untested: " + ("; ".join(str(item) for item in untested) if untested else "nothing listed"))
    if isinstance(completion.get("verify_yourself"), str) and completion["verify_yourself"].strip():
        lines.append(f"- Verify yourself: {completion['verify_yourself']}")
    assumptions = completion.get("open_assumptions")
    if not isinstance(assumptions, list) and isinstance(snapshot, dict):
        assumptions = snapshot.get("open_assumptions")
    if isinstance(assumptions, list):
        lines.append("- Open assumptions: " + ("; ".join(str(item) for item in assumptions) if assumptions else "none"))
    return lines


def candidate_ref(plan: dict, directory: Path, candidate: str) -> str:
    """` (kept as refs/workflow/<hash>/candidate)` when that ref holds the candidate; runs from before the ref have none."""
    ref = run_ref(directory, CANDIDATE_REF)
    try:
        held = subprocess.run(["git", "-C", str(plan.get("repository")), "rev-parse", "--verify", "-q", ref], capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.SubprocessError):
        return ""
    return f" (kept as {ref})" if held.returncode == 0 and held.stdout.strip() == candidate else ""


def lane_snapshots(directory: Path) -> dict:
    """The lanes' frozen snapshots with every applied repair, or {} before freeze."""
    if not (directory / "snapshots.json").exists():
        return {}
    try:
        from .repair import applied_repairs, effective_snapshots
        return effective_snapshots(directory, applied_repairs(directory))
    except Exception:
        snapshots = optional_json(directory / "snapshots.json")
        return snapshots if isinstance(snapshots, dict) else {}


def render(directory: Path) -> str:
    directory = Path(directory).resolve()
    if not (directory / "plan.json").is_file():
        raise ValueError(f"{directory} has no plan.json: name a run directory")
    plan = read_json(directory / "plan.json")
    run = ReadOnlyRun(directory, plan)
    policy = optional_json(directory / "policy.json") or {}
    owned = {worker.get("node_id"): list(worker.get("owned_paths") or []) for worker in policy.get("workers") or [] if isinstance(worker, dict)}
    review = optional_json(directory / "review.json")
    verdict = review.get("verdict") if isinstance(review, dict) and review.get("verdict") else "none recorded (no review.json)"
    candidate = candidate_commit(directory)
    snapshots = lane_snapshots(directory)
    findings, notes = collect_findings(run, review)
    lanes = run.workers
    lines = [f"# Follow-up brief: {plan.get('run_id', directory.name)}", "",
             f"- Run directory: {directory}",
             f"- Verdict: {verdict}",
             f"- Candidate: {candidate}{candidate_ref(plan, directory, candidate)}" if candidate else "- Candidate: none (the run stopped before its candidate)",
             f"- Base: {plan.get('base_commit')} on {plan.get('source_branch')}",
             f"- Lanes: {', '.join(lanes)}" + (f" (excluded: {', '.join(plan_excluded(plan))})" if plan.get("excluded_workers") else ""), "",
             "Follow it up with a new run of the same feature: `python -m workflow launch <feature> --run-id <feature>-00N "
             f"--follows {shlex.quote(str(directory))} --live --automatic --by operator`. Paste into each lane's task Context what it "
             "needs from this brief. The restore recipe uses the owned paths this run pinned: check them against the follow-up's policy."]
    for note in notes:
        lines += ["", f"Note: {note}."]
    for lane in lanes:
        snapshot = snapshots.get(lane) if isinstance(snapshots.get(lane), dict) else None
        source, kind = (candidate, "the candidate") if candidate else ((snapshot or {}).get("commit"), f"the {lane} lane's snapshot")
        paths = owned.get(lane, [])
        lines += ["", f"## Lane {lane}", "", f"Owned paths (this run's pinned policy): {', '.join(f'`{path}`' for path in paths) or 'none'}", ""]
        if not source:
            lines.append(f"Nothing to restore: the lane was never frozen. Its worktree was {plan.get('nodes', {}).get(lane, {}).get('worktree')}.")
        elif not paths:
            lines.append("Nothing to restore: the pinned policy names no owned path for this lane.")
        else:
            revisions = [source] + ([plan["base_commit"]] if plan.get("base_commit") else [])
            present, absent, unchecked = existing_paths(str(plan.get("repository")), revisions, paths)
            quoted = " ".join(shlex.quote(path) for path in present)
            lines += [f"Restore {kind}'s version of these paths in the follow-up lane's worktree, then check that nothing differs "
                      "(the second command prints nothing once restored):", "", "```sh",
                      f"git restore --source={source} --staged --worktree -- {quoted}",
                      f"git diff --stat {source} -- {quoted}", "```"]
            if absent:
                lines += ["", f"Not in {kind} or the base, so not restored: {', '.join(f'`{path}`' for path in absent)}."]
            if unchecked:
                lines += ["", f"Which paths exist was not checked ({unchecked}); `git restore` refuses a path that exists in neither tree."]
        own = [finding for finding in findings if finding.get("worker") == lane]
        lines += ["", "**Findings on this lane:**", ""] + ([finding_line(finding) for finding in own] or ["- none"])
        claims = lane_claims(directory, lane, snapshot)
        lines += ["", "**The worker's own claims:**", ""] + (claims or ["- none recorded"])
    across = [finding for finding in findings if finding.get("worker") not in lanes]
    if across:
        lines += ["", "## Findings across lanes or on none", ""] + [finding_line(finding) for finding in across]
    ledger = optional_json(directory / "sidecar.ledger.json")
    if ledger is not None:
        handoff = ledger.get("handoff") if isinstance(ledger, dict) else None
        unresolved = handoff.get("unresolved") if isinstance(handoff, dict) else None
        lines += ["", "## Review sidecar: unresolved at handoff", ""]
        if isinstance(unresolved, list):
            lines += [f"- {item}" for item in unresolved] or ["- none"]
        else:
            lines.append("- no handoff recorded (the final pass did not run)")
    return "\n".join(lines) + "\n"


def brief_main(argv=None):
    parser = argparse.ArgumentParser(prog="python -m workflow brief", description="Print what a follow-up run of a finished run needs, "
                                     "lane by lane, as Markdown: the restore recipe, every reviewer's findings, the workers' claims and "
                                     "the sidecar's unresolved handoff. Read-only.")
    parser.add_argument("directory", type=Path)
    args = parser.parse_args(argv)
    try:
        text = render(args.directory)
    except (ValueError, OSError) as error:
        parser.exit(1, f"Blocked: {error}\n")
    sys.stdout.write(text)
