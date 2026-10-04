"""`workflow clean <run> --by operator` (C47): remove what a run's checkouts take on disk, never its evidence.

It prunes every passed check attempt of the run (checks.prune_attempt, which verify_revision has applied to each new one
since C47), then removes the lane, candidate, review and challenge worktrees and, once the run is finished, its source
checkout `<runs root>/<run id>.source`; then `git worktree prune`. Every removal goes through git_worktree, under the
repository's worktree lock, since running runs add worktrees to the same .git (a leftover Git no longer lists is deleted:
checks.remove_worktree). The repository is the first checkout of the run Git can still read (worktrees.run_checkouts), since
a C56 run's plan.repository is that source checkout; with none left, leftovers Git forgot are deleted and nothing is
pruned, while a folder whose .git file names a gitdir that still exists is refused: Git cannot run there. The
source checkout goes last, only once every other removal succeeded, and never while it holds uncommitted changes or a
rebase or merge in progress (the operator integrates there when --ff-only refuses). Failed attempts are kept whole, and so
are repair workspaces (an operator's fix may sit uncommitted in one), packets, logs, artifacts and every run file.

It refuses while the run's controller or supervisor lock is held, while a receipt cannot be read, or while `claude agents`
lists a live session of the run: by a receipt's IDs, by the ID a never-bound receipt's launch log printed, or by one of
the run's launch names. It lists what it will remove before it removes anything, marking a lane worktree with uncommitted
changes: before freeze the worker's only copy of its edits; after it, captured in the lane's snapshot (freeze leaves the
worktree dirty). Only the operator runs it: cleaning a blocked run removes the lane worktrees a repair would use, so it is
not mechanical recovery (decision 2a), and `--by maintainer` is refused.
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

from .actor import add_actor_argument, require_actor
from .checks import prunable, prune_attempt, remove_tree, remove_worktree
from .guardrails import source_checkout
from .interactive import REVIEW, TERMINAL_STATES, launch_name, recorded_stop
from .sessions import read_json, run_lock
from .worktrees import common_dir, git_worktree, run_checkouts

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


# A receipt's launch log names the ID `claude --bg` printed (InteractiveSessions.locate binds it the same way).
LAUNCHED_ID = re.compile(r"claude attach ([a-f0-9-]{8,36})\s")


def run_nodes(directory: Path, plan: dict) -> set[str]:
    """Every node of the run that may have had a session: the plan's lanes, the reviewers, and each node with a receipt or a
    launch log."""
    nodes = {REVIEW, *(plan.get("nodes") or {}), *(plan.get("workers") or [])}
    nodes |= {path.name.removesuffix(".interactive.json") for path in directory.glob("*.interactive.json")}
    nodes |= {path.name.removesuffix(".launch.log") for path in directory.glob("*.launch.log")}
    return {node for node in nodes if isinstance(node, str)}


def live(directory: Path, node: str, row: dict) -> bool:
    """A listed row counts unless it is in a terminal state, or has no PID and the controller confirmed its stop (as
    stop_session and verified_row judge it)."""
    if row.get("state") in TERMINAL_STATES:
        return False
    if row.get("pid") is None:
        stop = recorded_stop(directory, node)
        return not (stop and stop["confirmed"])
    return True


def listed_sessions(directory: Path, plan: dict, rows: list[dict]) -> list[str]:
    """`<node> (<id>)` for each live session the listing shows of this run: by a receipt's background or session ID, by the
    ID its launch log printed when the receipt was never bound, or by one of the run's launch names (launch refuses on
    that name too). ValueError when a receipt cannot be read, since clean cannot then tell."""
    rows = [row for row in rows if isinstance(row, dict)]
    found = {}
    for path in sorted(directory.glob("*.interactive.json")):
        node = path.name.removesuffix(".interactive.json")
        try:
            receipt = read_json(path)
            if not isinstance(receipt, dict):
                raise ValueError("not an object")
        except (OSError, ValueError) as error:
            raise ValueError(f"receipt {path.name} cannot be read ({error}); clean cannot tell whether its session is live") from None
        ids = {receipt["background_id"]} if receipt.get("background_id") else set()
        log = directory / f"{node}.launch.log"
        if not ids and log.is_file():
            ids = set(LAUNCHED_ID.findall(log.read_text(errors="replace")))
        session = receipt.get("session_id")
        for row in rows:
            if (row.get("id") in ids or (session and row.get("sessionId") == session)) and live(directory, node, row):
                found.setdefault(row.get("id") or row.get("sessionId"), node)
    run_id = plan.get("run_id") or directory.name
    names = {launch_name(run_id, node): node for node in run_nodes(directory, plan)}
    reviewer = launch_name(run_id, "review-")  # Any declared reviewer's name, whether or not it left a receipt.
    for row in rows:
        name = row.get("name")
        node = names.get(name) or (f"review-{name[len(reviewer):]}" if isinstance(name, str) and name.startswith(reviewer) else None)
        if node and live(directory, node, row):
            found.setdefault(row.get("id") or row.get("sessionId"), node)
    return [f"{node} ({identity})" for identity, node in sorted(found.items(), key=lambda item: (item[1], str(item[0])))]


def uncommitted(path: Path) -> int | None:
    """How many changes `git status` shows in a lane worktree or the source checkout; None when Git cannot tell."""
    try:
        # --untracked-files=all overrides status.showUntrackedFiles=no, which would hide an untracked file of the operator's.
        return len(subprocess.run(["git", "-C", str(path), "status", "--porcelain", "--untracked-files=all"], capture_output=True, text=True,
                                  check=True).stdout.splitlines())
    except (OSError, subprocess.SubprocessError):
        return None


def snapshot_commits(directory: Path, plan: dict) -> dict[Path, str]:
    """Each frozen lane's worktree with its snapshot commit, from snapshots.json; {} before freeze or when it cannot be read."""
    try:
        snapshots = read_json(directory / "snapshots.json")
    except (OSError, ValueError):
        return {}
    nodes = plan.get("nodes") or {}
    frozen = {}
    for lane, snapshot in (snapshots.items() if isinstance(snapshots, dict) else []):
        info = nodes.get(lane) if isinstance(nodes, dict) else None
        if isinstance(info, dict) and info.get("worktree") and isinstance(snapshot, dict) and isinstance(snapshot.get("commit"), str):
            frozen[Path(info["worktree"])] = snapshot["commit"]
    return frozen


def in_progress(path: Path) -> bool:
    """A rebase, merge, cherry-pick or revert stopped in this checkout: the operator's integration may be half done there."""
    try:
        gitdir = Path(subprocess.run(["git", "-C", str(path), "rev-parse", "--absolute-git-dir"], capture_output=True, text=True,
                                     check=True).stdout.strip())
    except (OSError, subprocess.SubprocessError):
        return True
    return any((gitdir / name).exists() for name in ("rebase-merge", "rebase-apply", "MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD"))


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
        names = [path.name for path in prunable(folder)]
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
    source = source_checkout(directory)  # launch's own checkout of the run (C56); older runs have none.
    if source.exists():
        # The operator integrates by hand there when --ff-only refuses (RUNBOOK): what it holds uncommitted is their work.
        changes = uncommitted(source) if finished(directory) else 0
        if not finished(directory):
            kept.append(f"{source}: the run is not finished")
        elif changes is None:
            kept.append(f"{source}: Git cannot tell whether it holds uncommitted changes; remove it by hand once checked")
        elif changes:
            kept.append(f"{source}: {changes} uncommitted change{'s' if changes != 1 else ''}; commit or discard it, then rerun clean")
        elif in_progress(source):
            kept.append(f"{source}: a rebase or merge is in progress there; finish or abort it, then rerun clean")
        else:
            remove.append(("source checkout", source))  # Always last: it goes only once every other removal succeeded.
    return remove, kept


def readable(path: str) -> bool:
    """`git -C <path> rev-parse --git-dir` answers: a checkout Git can still read."""
    try:
        return subprocess.run(["git", "-C", path, "rev-parse", "--git-dir"], capture_output=True, timeout=30).returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


def remembered_gitdir(path: Path) -> Path | None:
    """The gitdir a worktree's `.git` file names when that gitdir still exists: Git has not forgotten the worktree, so a
    checkout Git cannot read there means Git cannot run (a broken config or environment), not a leftover. None otherwise."""
    try:
        text = (path / ".git").read_text(errors="replace")
    except OSError:
        return None
    named = text.strip().removeprefix("gitdir:").strip() if text.startswith("gitdir:") else ""
    if not named:
        return None
    gitdir = Path(named) if Path(named).is_absolute() else path / named
    return gitdir if gitdir.exists() else None


def remove_leftover(path: Path) -> None:
    """A worktree's folder when no checkout of the repository is left to ask Git with: deleted, as remove_worktree deletes
    a leftover Git no longer lists, but only when Git forgot it (no `.git` file, or one naming a gitdir that is gone). An
    independent repository (a `.git` directory) is never deleted."""
    if not (path.exists() or path.is_symlink()):
        return
    if (path / ".git").is_dir():
        raise RuntimeError(f"{path} holds its own repository (a .git directory); clean never deletes one")
    gitdir = remembered_gitdir(path) if path.is_dir() and not path.is_symlink() else None
    if gitdir is not None:
        raise RuntimeError(f"Git cannot read {path} although its repository {gitdir} exists: check `git -C {path} status`, "
                           "then rerun clean")
    if path.is_symlink() or path.is_file():
        path.unlink()
    else:
        remove_tree(path)


def clean_main(argv=None):
    parser = argparse.ArgumentParser(prog="python -m workflow clean", description="Remove a finished or abandoned run's checkouts: prune "
                                     "its passed check attempts, then its lane, candidate, review and challenge worktrees (and its source "
                                     "checkout once finished). Keeps every packet, log, artifact, failed attempt and repair workspace. "
                                     "Refuses while the run's controller runs or a session of it is listed.")
    parser.add_argument("directory", type=Path)
    add_actor_argument(parser)
    parser.add_argument("--dry-run", action="store_true", help="List what would be removed; remove nothing")
    args = parser.parse_args(argv)
    directory = args.directory.resolve()
    try:
        # Only the operator: cleanup is not mechanical recovery, and a blocked run's lane worktrees are what a repair uses.
        require_actor(args, "clean")
        with run_lock(directory, "automatic-supervisor.lock"), run_lock(directory):
            plan = read_json(directory / "plan.json")
            listed = listed_sessions(directory, plan, inventory())
            if listed:
                raise ValueError(f"claude agents still lists {', '.join(listed)} from this run's receipts; stop it first "
                                 "(RUNBOOK: Stopping an unfinished run)")
            # Git's common directory itself, which outlives every worktree removed here (a source checkout may be the plan's
            # repository) and is the repository whatever its layout (--separate-git-dir, a bare repository's worktrees). Found
            # from the first checkout of the run Git can still read: a C56 run's plan.repository is its source checkout, which
            # an earlier clean or the operator may have removed. None when none is left: leftovers Git forgot are then deleted
            # as such, and a folder whose .git file still names an existing gitdir is refused (Git cannot run here).
            repository = next((common_dir(path) for path in run_checkouts(plan, directory) if Path(path).exists() and readable(path)), None)
            attempts, kept_attempts = passed_attempts(directory)
            worktrees, kept = run_worktrees(directory, plan)
            if not attempts and not worktrees:
                print(f"Nothing to remove in {directory}.")
            else:
                print(f"Clean {directory} will remove:")
                for folder, names in attempts:
                    print(f"  passed attempt {folder.relative_to(directory)}: {', '.join(names)}")
                frozen = snapshot_commits(directory, plan)
                for label, path in worktrees:
                    changes = uncommitted(path) if label == "lane worktree" else 0
                    plural = "s" if changes != 1 else ""
                    # Freeze commits a lane's edits to its snapshot ref and leaves the worktree dirty: only an unfrozen lane's
                    # changes are their only copy.
                    note = (" (Git cannot tell whether it holds uncommitted changes)" if changes is None else
                            f" ({changes} uncommitted change{plural}, captured in snapshot {frozen[path][:12]})" if changes and path in frozen else
                            f" ({changes} uncommitted change{plural}: the lane's only copy of them)" if changes else "")
                    print(f"  {label} {path}{note}")
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
                    if repository is None:
                        remove_leftover(folder / "worktree")
                    prune_attempt(repository, folder)
                    print(f"Removed: passed attempt {folder.relative_to(directory)} pruned")
                except Exception as error:  # Whatever one removal raises, the others still run.
                    errors.append(f"{folder}: {error}")
            for label, path in worktrees:
                if label == "source checkout" and errors:
                    # The source checkout names the repository for every later clean: it goes last, once the rest is gone.
                    print(f"Kept: source checkout {path}: another removal failed; rerun clean once fixed")
                    continue
                try:
                    if repository is None:
                        remove_leftover(path)
                    else:
                        remove_worktree(repository, path)
                    print(f"Removed: {label} {path}")
                except Exception as error:
                    errors.append(f"{path}: {error}")
            if (attempts or worktrees) and repository is not None:
                try:
                    git_worktree(repository, "prune")
                except Exception as error:  # Reported with the removals that failed, never in their place.
                    errors.append(f"git worktree prune: {error}")
            if errors:
                raise RuntimeError("some removals failed, the rest are done; rerun clean once fixed:\n" + "\n".join(errors))
    except (ValueError, RuntimeError, OSError, KeyError, json.JSONDecodeError, subprocess.SubprocessError) as error:
        parser.exit(1, f"Blocked: {error}\nEvidence retained at {directory}.\n")
