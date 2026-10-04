"""What a branch holds that no approved run reviewed (C45).

One classifier over the runs the Projects registry's runs roots hold: each run's `review.json` (its candidate and verdict)
and `plan.json` (its base). It labels each first-parent commit of a branch:

- `reviewed`: a commit of an approved run's candidate (base..candidate), or a merge that brings in only such commits;
- `blocked`: a commit of a blocked run's candidate, or a merge that brings one in;
- `config` or `code`: outside any run, `config` when every file it changes (against its first parent) is under `features/`
  or `docs/`, or is `CLAUDE.md`, and `code` otherwise.

It is used twice. `prepare` pins `base_unreviewed` in plan.json: the commits from the newest approved candidate that is an
ancestor of the base up to the base, without the reviewed ones, capped at LIST_LIMIT with the count of the rest, and prints
them. The review is unchanged; this only says what the run's base holds that its review will not cover. And
`python -m workflow ledger --repo R --branch main [--since sha]` writes the whole classification to `ledger.json` beside
the registry. Both only read the runs and the repository. A run whose commits this repository does not have (another
project's) is ignored.
"""
from __future__ import annotations

import argparse
import json
import subprocess
from datetime import datetime, timezone
from pathlib import Path

LIST_LIMIT = 20   # Commits of base_unreviewed pinned and printed; `more` counts the rest.
FILE_LIMIT = 50   # Files of one pinned commit; `files_more` counts the rest.
SHOWN_FILES = 5   # Files of one commit in a printed line.
CONFIG_PREFIXES = ("features/", "docs/")
CONFIG_FILES = ("CLAUDE.md",)
CLASSES = ("reviewed", "blocked", "config", "code")


def run_git(repo: Path, *arguments: str, input: str | None = None) -> str:
    return subprocess.run(["git", "-C", str(repo), "-c", "core.quotepath=false", *arguments], input=input, capture_output=True,
                          text=True, check=True).stdout


def commit_of(repo: Path, revision: str) -> str:
    try:
        return run_git(repo, "rev-parse", "--verify", "--quiet", f"{revision}^{{commit}}").strip()
    except subprocess.CalledProcessError:
        raise ValueError(f"{revision} is not a commit of {repo}") from None


def runs_roots(env: dict | None = None, extra=()) -> list[Path]:
    """Every workflow's `runs_root` in the Projects registry (registry.registry_path), then `extra`, each once."""
    from .registry import registry_path
    path = registry_path(env)
    roots = []
    if path.exists():
        try:
            document = json.loads(path.read_text())
        except ValueError as error:
            raise ValueError(f"Registry {path} is not valid JSON: {error}") from None
        for project in document.get("projects", []) if isinstance(document, dict) else []:
            for workflow in project.get("workflows", []) if isinstance(project, dict) else []:
                if isinstance(workflow, dict) and isinstance(workflow.get("runs_root"), str):
                    roots.append(Path(workflow["runs_root"]).expanduser())
    roots.extend(Path(root) for root in extra)
    unique, seen = [], set()
    for root in roots:
        key = root.resolve()
        if key not in seen:
            seen.add(key)
            unique.append(root)
    return unique


def read_object(path: Path) -> dict | None:
    try:
        value = json.loads(path.read_text())
    except (OSError, ValueError):
        return None
    return value if isinstance(value, dict) else None


def known_runs(repo: Path, roots: list[Path]) -> list[dict]:
    """`{run_id, directory, base, candidate, verdict}` of each reviewed run under `roots` whose base and candidate this
    repository has; runs without a review, or with an unreadable one, are skipped."""
    found = []
    for root in roots:
        if not root.is_dir():
            continue
        for directory in sorted(root.iterdir()):
            review, plan = read_object(directory / "review.json"), read_object(directory / "plan.json")
            if review is None or plan is None or review.get("verdict") not in {"approved", "blocked"}:
                continue
            base, candidate = plan.get("base_commit"), review.get("candidate_commit")
            if isinstance(base, str) and isinstance(candidate, str):
                found.append({"run_id": str(review.get("run_id") or plan.get("run_id") or directory.name), "directory": str(directory),
                              "base": base, "candidate": candidate, "verdict": review["verdict"]})
    if not found:
        return []
    names = sorted({run[key] for run in found for key in ("base", "candidate")})
    answer = run_git(repo, "cat-file", "--batch-check", input="".join(f"{name}^{{commit}}\n" for name in names)).splitlines()
    present = {name for name, line in zip(names, answer) if not line.endswith(" missing")}
    return [run for run in found if run["base"] in present and run["candidate"] in present]


def candidate_commits(repo: Path, runs: list[dict]) -> tuple[dict, dict]:
    """`{commit: run_id}` of the approved runs' candidates (base..candidate), and of the blocked runs' (an approved one wins)."""
    approved, blocked = {}, {}
    for run in runs:
        target = approved if run["verdict"] == "approved" else blocked
        for commit in run_git(repo, "rev-list", f"{run['base']}..{run['candidate']}").split():
            target.setdefault(commit, run["run_id"])
    return approved, {commit: run_id for commit, run_id in blocked.items() if commit not in approved}


def is_config(path: str) -> bool:
    return path.startswith(CONFIG_PREFIXES) or path in CONFIG_FILES


def first_parent_log(repo: Path, tip: str, since: str | None) -> list[dict]:
    """`{commit, parents, subject, files}` of each first-parent commit, newest first; a merge's files against its first parent."""
    output = run_git(repo, "log", "--first-parent", "--diff-merges=first-parent", "--name-only", "--no-renames",
                     "--format=%x1e%H%x1f%P%x1f%s", f"{since}..{tip}" if since else tip, "--")
    commits = []
    for chunk in output.split("\x1e")[1:]:
        header, _, rest = chunk.partition("\n")
        commit, parents, subject = header.split("\x1f", 2)
        commits.append({"commit": commit, "parents": parents.split(), "subject": subject, "files": [line for line in rest.splitlines() if line]})
    return commits


def classify(repo: Path, tip: str, since: str | None, runs: list[dict]) -> list[dict]:
    """`{commit, subject, class, run, files}` for each first-parent commit of `since..tip` (all of tip's without `since`), newest first."""
    tip = commit_of(repo, tip)
    since = commit_of(repo, since) if since else None
    approved, blocked = candidate_commits(repo, runs)
    entries = []
    for item in first_parent_log(repo, tip, since):
        commit, parents = item["commit"], item["parents"]
        label, run = None, None
        if commit in approved:
            label, run = "reviewed", approved[commit]
        elif commit in blocked:
            label, run = "blocked", blocked[commit]
        elif len(parents) > 1:
            introduced = run_git(repo, "rev-list", f"^{parents[0]}", *parents[1:]).split()
            from_blocked = [blocked[other] for other in introduced if other in blocked]
            if from_blocked:
                label, run = "blocked", from_blocked[0]
            elif introduced and all(other in approved for other in introduced):
                label, run = "reviewed", approved[introduced[0]]
        if label is None:
            label = "config" if all(is_config(path) for path in item["files"]) else "code"
        entries.append({"commit": commit, "subject": item["subject"], "class": label, "run": run, "files": item["files"]})
    return entries


def newest_approved_ancestor(repo: Path, base: str, runs: list[dict]) -> dict | None:
    """The approved run whose candidate is an ancestor of `base` with the fewest commits between them."""
    best, distance = None, None
    for run in runs:
        if run["verdict"] != "approved":
            continue
        if subprocess.run(["git", "-C", str(repo), "merge-base", "--is-ancestor", run["candidate"], base], capture_output=True).returncode != 0:
            continue
        count = int(run_git(repo, "rev-list", "--count", f"{run['candidate']}..{base}"))
        if distance is None or count < distance:
            best, distance = run, count
    return best


def base_unreviewed(repo: Path, base: str, roots: list[Path]) -> dict:
    """What prepare pins: `{since, since_run, total, more, commits}`, the commits after the newest approved ancestor (all of the
    base's history without one) that no approved run reviewed, newest first, at most LIST_LIMIT of them."""
    base = commit_of(repo, base)
    runs = known_runs(repo, roots)
    anchor = newest_approved_ancestor(repo, base, runs)
    since = anchor["candidate"] if anchor else None
    unreviewed = [entry for entry in classify(repo, base, since, runs) if entry["class"] != "reviewed"]
    commits = []
    for entry in unreviewed[:LIST_LIMIT]:
        pinned = {**entry, "files": entry["files"][:FILE_LIMIT]}
        if len(entry["files"]) > FILE_LIMIT:
            pinned["files_more"] = len(entry["files"]) - FILE_LIMIT
        commits.append(pinned)
    return {"since": since, "since_run": anchor["run_id"] if anchor else None, "total": len(unreviewed),
            "more": max(0, len(unreviewed) - LIST_LIMIT), "commits": commits}


def label(entry: dict) -> str:
    if entry["class"] == "blocked":
        return f"from blocked run {entry['run']}"
    return f"{entry['class']} outside any run"


def describe(pinned: dict, base: str) -> str:
    """The lines prepare prints for `base_unreviewed`."""
    short, total = base[:12], pinned["total"]
    since = pinned["since"]
    if since and not total:
        if since == base:
            return f"Base {short} is the candidate approved run {pinned['since_run']} produced; nothing unreviewed."
        return f"Base {short} holds no commit outside an approved run since {since[:12]} ({pinned['since_run']})."
    noun = "commit" if total == 1 else "commits"
    if since:
        lines = [f"Base {short} holds {total} {noun} no approved run reviewed since {since[:12]} ({pinned['since_run']}):"]
    else:
        lines = [f"Base {short} holds {total} {noun} no approved run reviewed; no approved run's candidate is an ancestor of it:"]
    for entry in pinned["commits"]:
        files = entry["files"][:SHOWN_FILES]
        hidden = len(entry["files"]) - len(files) + entry.get("files_more", 0)
        shown = ", ".join(files) + (f", +{hidden} more" if hidden else "")
        lines.append(f"  {entry['commit'][:12]} {label(entry)}: {entry['subject']}" + (f" ({shown})" if shown else ""))
    if pinned["more"]:
        lines.append(f"  ... and {pinned['more']} more (plan.json base_unreviewed.total)")
    return "\n".join(lines)


def ledger_main(argv=None):
    from .registry import locked, registry_path, write_atomic
    parser = argparse.ArgumentParser(prog="python -m workflow ledger", description="Classify each first-parent commit of a branch as "
                                     "reviewed by an approved run, from a blocked run's candidate, or config or code outside any run, "
                                     "over the runs the Projects registry's runs roots hold. Writes ledger.json beside the registry; "
                                     "reads everything else.")
    parser.add_argument("--repo", type=Path, default=Path.cwd())
    parser.add_argument("--branch", default="main", help="The branch (or any commit) whose first-parent history is classified")
    parser.add_argument("--since", metavar="SHA", help="Only the commits after this one")
    args = parser.parse_args(argv)
    repo = args.repo.resolve()
    try:
        tip = commit_of(repo, args.branch)
        since = commit_of(repo, args.since) if args.since else None
        roots = runs_roots()
        entries = classify(repo, tip, since, known_runs(repo, roots))
        counts = {name: sum(1 for entry in entries if entry["class"] == name) for name in CLASSES}
        record = {"repository": str(repo), "branch": args.branch, "tip": tip, "since": since,
                  "generated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
                  "runs_roots": [str(root) for root in roots], "counts": counts, "commits": entries}
        path = registry_path()
        path = path.resolve() if path.is_symlink() else path
        target = path.parent / "ledger.json"
        with locked(path.parent):
            document = read_object(target) if target.exists() else None
            records = document.get("ledgers") if document and isinstance(document.get("ledgers"), list) else []
            records = [item for item in records if not (isinstance(item, dict) and (item.get("repository"), item.get("branch")) == (record["repository"], record["branch"]))]
            write_atomic(target, json.dumps({"version": 1, "ledgers": [*records, record]}, indent=2) + "\n")
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        parser.exit(1, f"Blocked: {error}\n")
    print(f"Ledger of {args.branch} at {tip[:12]}: {counts['reviewed']} reviewed, {counts['blocked']} from blocked runs, "
          f"{counts['config']} config and {counts['code']} code outside any run; written to {target}")
