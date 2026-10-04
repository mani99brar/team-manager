"""`workflow clean <run> --by operator` (C47): remove what a run's checkouts take on disk, never its evidence.

It prunes every passed check attempt of the run (checks.prune_attempt, which verify_revision has applied to each new one
since C47), then removes the lane, candidate, review and challenge worktrees and, once the run is finished, its source
checkout `<runs root>/<run id>.source`; then `git worktree prune`. Every removal goes through git_worktree, under the
repository's worktree lock, since running runs add worktrees to the same .git. Failed attempts are kept whole, and so are
repair workspaces (an operator's fix may sit uncommitted in one), packets, logs, artifacts and every run file.

It refuses while the run's controller or supervisor lock is held, or while `claude agents` lists a session from one of the
run's receipts, and it lists what it will remove before it removes anything. Only the operator runs it: cleaning a blocked
run removes the lane worktrees a repair would use, so it is not mechanical recovery (decision 2a), and `--by maintainer`
is refused.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

from .checks import PRUNED_CACHES, RAW_BROWSER_OUTPUT, prune_attempt
from .sessions import read_json, run_lock
from .worktrees import WorktreeError, common_dir, git_worktree

RUN_WORKTREES = (("review worktree", "review-worktree"), ("challenge worktree", "challenge-worktree"))


def inventory() -> list[dict]:
    """`claude agents --json`, the sessions it lists now; RuntimeError when it gives no listing, since clean cannot then tell."""
    from .interactive import listed_rows
    from .sessions import run_claude
    try:
        response = run_claude(["claude", "agents", "--json"], capture_output=True, text=True, timeout=15,
                              retry_output=lambda result: listed_rows(result) is None)
    except (OSError, subprocess.SubprocessError) as error:
        raise RuntimeError(f"`claude agents --json` could not run ({error}); clean cannot tell whether a session of this run is live") from error
    rows = listed_rows(response)
    if rows is None:
        raise RuntimeError(f"`claude agents --json` gave no session list (exit {response.returncode}); clean cannot tell whether a session "
                           "of this run is live")
    return rows


def listed_sessions(directory: Path, rows: list[dict]) -> list[str]:
    """`<node> (<background id>)` for each receipt (`<node>.interactive.json`) whose session the listing still shows."""
    found = []
    for path in sorted(directory.glob("*.interactive.json")):
        try:
            receipt = read_json(path)
        except ValueError:
            continue
        background, session = receipt.get("background_id"), receipt.get("session_id")
        if any((background and row.get("id") == background) or (session and row.get("sessionId") == session) for row in rows if isinstance(row, dict)):
            found.append(f"{path.name.removesuffix('.interactive.json')} ({background or session})")
    return found


def finished(directory: Path) -> bool:
    """The run fast-forwarded its branch and has no next step, as its exported run-state.json says."""
    try:
        state = read_json(directory / "run-state.json")
    except (OSError, ValueError):
        return False
    values = state.get("values") if isinstance(state, dict) else None
    return isinstance(values, dict) and bool(values.get("integrated_commit")) and not state.get("next")


def passed_attempts(directory: Path) -> tuple[list[tuple[Path, list[str]]], list[Path]]:
    """Passed attempts with something left to prune (and what), and the attempts kept whole (failed, or no packet)."""
    prune, kept = [], []
    for folder in sorted((directory / "verification").glob("*/*/*")):
        if not folder.is_dir():
            continue
        try:
            status = read_json(folder / "packet.json")["gate"]["status"]
        except (OSError, ValueError, KeyError, TypeError):
            status = None
        if status != "passed":
            kept.append(folder)
            continue
        names = [name for name in ("worktree", *PRUNED_CACHES) if (folder / name).exists() or (folder / name).is_symlink()]
        names += sorted(path.name for path in folder.iterdir() if RAW_BROWSER_OUTPUT.fullmatch(path.name))
        if names:
            prune.append((folder, names))
    return prune, kept


def inside(directory: Path, path: Path) -> bool:
    return path.resolve().parent == directory


def run_worktrees(directory: Path, plan: dict) -> tuple[list[tuple[str, Path]], list[str]]:
    """The lane, candidate, review and challenge worktrees there are, and what is kept with why."""
    remove, kept = [], []
    for node, info in sorted((plan.get("nodes") or {}).items()):
        path = Path(info.get("worktree", "")) if isinstance(info, dict) and info.get("worktree") else None
        if path is None or not path.exists():
            continue
        if not inside(directory, path):
            kept.append(f"{path}: outside the run directory, not a lane worktree of this run")
            continue
        remove.append(("lane worktree", path))
    candidates = [path for path in directory.glob("candidate*") if path.is_dir() and (path.name == "candidate" or path.name.removeprefix("candidate-").isdigit())]
    remove += [("candidate worktree", path) for path in sorted(candidates, key=lambda path: (len(path.name), path.name))]
    remove += [(label, directory / name) for label, name in RUN_WORKTREES if (directory / name).exists()]
    kept += [f"{path}: a repair workspace, which may hold an uncommitted fix" for path in sorted(directory.glob("repair-workspace-*")) if path.is_dir()]
    source = directory.parent / f"{directory.name}.source"
    if source.exists():
        if finished(directory):
            remove.append(("source checkout", source))
        else:
            kept.append(f"{source}: the run is not finished")
    return remove, kept


def clean_main(argv=None):
    parser = argparse.ArgumentParser(prog="python -m workflow clean", description="Remove a finished or abandoned run's checkouts: prune "
                                     "its passed check attempts, then its lane, candidate, review and challenge worktrees (and its source "
                                     "checkout once finished). Keeps every packet, log, artifact, failed attempt and repair workspace. "
                                     "Refuses while the run's controller runs or a session of it is listed.")
    parser.add_argument("directory", type=Path)
    parser.add_argument("--by", required=True, choices=["operator", "maintainer"], help="Who runs it: only the operator may")
    parser.add_argument("--dry-run", action="store_true", help="List what would be removed; remove nothing")
    args = parser.parse_args(argv)
    directory = args.directory.resolve()
    try:
        if args.by != "operator":
            raise ValueError("only the operator runs clean: cleanup is not mechanical recovery, and a blocked run's lane worktrees are "
                             "what a repair uses")
        with run_lock(directory, "automatic-supervisor.lock"), run_lock(directory):
            plan = read_json(directory / "plan.json")
            listed = listed_sessions(directory, inventory())
            if listed:
                raise ValueError(f"claude agents still lists {', '.join(listed)} from this run's receipts; stop it first "
                                 "(RUNBOOK: Stopping an unfinished run)")
            # The main worktree's checkout, which outlives every worktree removed here (a source checkout may be the plan's repository).
            repository = common_dir(plan["repository"]).parent
            attempts, kept_attempts = passed_attempts(directory)
            worktrees, kept = run_worktrees(directory, plan)
            if not attempts and not worktrees:
                print(f"Nothing to remove in {directory}.")
            else:
                print(f"Clean {directory} will remove:")
                for folder, names in attempts:
                    print(f"  passed attempt {folder.relative_to(directory)}: {', '.join(names)}")
                for label, path in worktrees:
                    print(f"  {label} {path}")
            for folder in kept_attempts:
                print(f"Kept: {folder.relative_to(directory)}: an attempt that did not pass, kept whole")
            for line in kept:
                print(f"Kept: {line}")
            print("Kept: every packet, log, artifact, browser report and run file.")
            sys.stdout.flush()
            if args.dry_run:
                print("Dry run: nothing removed.")
                return
            errors = []
            for folder, _ in attempts:
                try:
                    prune_attempt(repository, folder)
                    print(f"Removed: passed attempt {folder.relative_to(directory)} pruned")
                except (WorktreeError, OSError) as error:
                    errors.append(f"{folder}: {error}")
            for label, path in worktrees:
                try:
                    git_worktree(repository, "remove", "--force", str(path))
                    print(f"Removed: {label} {path}")
                except (WorktreeError, OSError) as error:
                    errors.append(f"{path}: {error}")
            if attempts or worktrees:
                git_worktree(repository, "prune")
            if errors:
                raise RuntimeError("some removals failed, the rest are done; rerun clean once fixed:\n" + "\n".join(errors))
    except (ValueError, RuntimeError, OSError, KeyError, json.JSONDecodeError, subprocess.SubprocessError) as error:
        parser.exit(1, f"Blocked: {error}\nEvidence retained at {directory}.\n")
