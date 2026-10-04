"""Tryouts (C7) and the untried-feature limit (C29).

A user-facing feature (feature.json 2.4.0 `tryout: true`) asks the operator to try its run before the merge to main.
launch passes `--tryout` to prepare, which pins `plan.tryout`. `python -m workflow tryout <run> --result
works|broken|skipped [--note "<text>"] --by operator` appends {result, note, at, by} to `<run>/tryout.json`, writes one
plain record on the timeline and exports the run again, so the viewer drops its Untried chip. It refuses an abandoned run, a
run whose plan does not ask for a tryout, a run with no candidate yet, and the maintainer (actor.OPERATOR_ONLY). The record is advisory:
the controller never merges main, so nothing waits on it but the operator and the limit below.

The limit (C29): a feature is untried when its latest integrated run has `tryout: true` and no verdict. A new tryout launch
stops, before any Git action (launch, its dry run included, and preflight), when 3 other features are untried, counted
across every runs root of the Projects registry (registry.registered_runs). A continuation still launches: a run of a
feature that is itself untried, or one that follows another run (`--follows`). `--allow-untried "<reason>" --by operator`
launches past the limit; prepare pins the reason as `plan.allow_untried` and status prints it.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
from pathlib import Path

from .actor import actor_record, actor_text, add_actor_argument, require_actor
from .checks import now
from .sessions import read_json, save_json

TRYOUT = "tryout.json"
TRYOUT_VERSION = "1.0.0"
RESULTS = ("works", "broken", "skipped")
# New tryout launches stop at this many other untried features (operator decision 10).
UNTRIED_LIMIT = 3
TRYOUT_COMMAND = "python -m workflow tryout <run> --result works|broken|skipped --by operator"


def verdicts(directory: Path) -> list[dict]:
    """The verdicts `<run>/tryout.json` records, oldest first; [] when there is none or the file cannot be read."""
    try:
        record = read_json(Path(directory) / TRYOUT)
    except (OSError, ValueError):
        return []
    items = record.get("verdicts") if isinstance(record, dict) else None
    return [item for item in items if isinstance(item, dict)] if isinstance(items, list) else []


def record_verdict(directory: Path, plan: dict, result: str, note: str | None, actor: str) -> dict:
    """Append one verdict to tryout.json (the history is kept) and return it."""
    if result not in RESULTS:
        raise ValueError(f"--result must be one of {', '.join(RESULTS)}")
    entry = {"result": result, "note": note, "at": now(), **actor_record(actor)}
    save_json(Path(directory) / TRYOUT, {"version": TRYOUT_VERSION, "run_id": plan["run_id"], "verdicts": [*verdicts(directory), entry]})
    return entry


def is_untried(run: dict) -> bool:
    """A run record (registry.run_record) whose plan asks for a tryout and whose tryout.json holds no verdict."""
    return run["plan"].get("tryout") is True and not verdicts(run["directory"])


def latest_integrated(runs: list[dict]) -> dict | None:
    """The run that integrated last, by the time of its `Fast-forwarded to` row, then its plan's created_at; None when none
    integrated. Its last event would not do: a tryout verdict or an action row on an older run moves that, not its integration."""
    integrated = [run for run in runs if run["integration"]["integrated_commit"]]
    floor = datetime.min.replace(tzinfo=timezone.utc)
    return max(integrated, key=lambda run: (run["integration"].get("integrated_at") or floor, str(run["plan"].get("created_at") or "")), default=None)


def untried_features(runs_root: Path, repository: Path | None = None, feature: str | None = None,
                     registry: Path | None = None) -> tuple[list[dict], bool]:
    """(the other features that are untried, whether this feature is untried itself). This feature is the one whose runs
    live in `runs_root`, or, with `repository` and `feature`, the registered workflow `feature` of that project."""
    from .registry import registered_runs, runs_in
    root = Path(runs_root).expanduser().resolve()

    def own(run: dict) -> bool:
        return run["runs_root"] == root or (feature is not None and repository is not None and run.get("workflow_id") == feature
                                            and run.get("project_repository") == str(repository))

    groups: dict[tuple, list[dict]] = {}
    mine: dict[Path, dict] = {run["directory"].resolve(): run for run in runs_in(root)}
    for run in registered_runs(registry):
        if own(run):
            mine.setdefault(run["directory"].resolve(), run)
        else:
            groups.setdefault((run.get("project_id"), run.get("workflow_id"), run["runs_root"]), []).append(run)
    others = []
    for (project, workflow, _), runs in sorted(groups.items(), key=lambda item: tuple(str(part) for part in item[0])):
        latest = latest_integrated(runs)
        if latest is not None and is_untried(latest):
            others.append({"project_id": project, "workflow_id": workflow, "run_id": latest["run_id"], "directory": latest["directory"]})
    latest = latest_integrated(list(mine.values()))
    return others, latest is not None and is_untried(latest)


def untried_check(runs_root: Path, *, repository: Path | None = None, feature: str | None = None, follows: bool = False,
                  allow_untried: str | None = None, registry: Path | None = None) -> str | None:
    """C29, for a tryout launch: ValueError when `UNTRIED_LIMIT` other features are untried and nothing exempts it; a note
    when `allow_untried` launches past them; else None. A continuation (a follow-up run, or a feature untried itself) passes."""
    others, waiting = untried_features(runs_root, repository, feature, registry)
    if len(others) < UNTRIED_LIMIT or follows or waiting:
        return None
    listed = ", ".join(f"{item['project_id']}/{item['workflow_id']} (run {item['directory']})" for item in others)
    if allow_untried is not None:
        return f"Launched past {len(others)} untried features ({listed}): {allow_untried}"
    raise ValueError(f"{len(others)} other features wait for your tryout, and a new tryout launch stops at {UNTRIED_LIMIT}: {listed}. Try each and "
                     f"record it ({TRYOUT_COMMAND}), follow up a waiting run (--follows), or launch past them with --allow-untried \"<reason>\" "
                     "--by operator. Nothing was launched.")


def tryout_main(argv=None):
    parser = argparse.ArgumentParser(prog="python -m workflow tryout", description="Record the operator's tryout of a user-facing run "
                                     "(feature.json tryout: true): works, broken or skipped, with an optional note. The history is kept.")
    parser.add_argument("directory", type=Path)
    parser.add_argument("--result", required=True, choices=RESULTS, help="What you found when you tried the run's candidate")
    parser.add_argument("--note", help="What you tried and saw: recorded with the verdict and on the timeline")
    add_actor_argument(parser)
    args = parser.parse_args(argv)
    directory = args.directory.resolve()
    try:
        actor = require_actor(args, "tryout")
        if not (directory / "plan.json").is_file():
            raise ValueError(f"{directory} has no plan.json: name a run directory")
        from .abandon import refuse_abandoned
        refuse_abandoned(directory)  # An abandoned run changes no more: status, export and brief still read it.
        plan = read_json(directory / "plan.json")
        if plan.get("tryout") is not True:
            raise ValueError("The run's plan does not ask for a tryout (feature.json 2.4.0 tryout: true pins it at launch)")
        from .brief import candidate_commit
        if candidate_commit(directory) is None:
            raise ValueError("The run has no candidate yet: try it once its candidate is built")
        note = args.note.strip() if args.note and args.note.strip() else None
        from .pipeline import ExportRuntime, append_event, persisted_state, report
        from .sessions import run_lock
        with run_lock(directory):
            entry = record_verdict(directory, plan, args.result, note, actor)
            append_event(directory, "controller", "note", f"Tryout recorded by {actor_text(actor)}: {args.result}" + (f". {note}" if note else ""))
            recorded = f"Tryout recorded for {plan['run_id']}: {entry['result']}" + (f" ({note})" if note else "") + f". History: {directory / TRYOUT}"
            try:
                runtime = ExportRuntime(directory)
                report(runtime, persisted_state(runtime))  # run-state.json carries the verdict: the viewer drops the Untried chip.
            except Exception as error:  # The verdict stands: a rerun would record it twice.
                parser.exit(1, f"{recorded}\nThe export failed ({error}): the viewer still shows the run as before. Refresh it with "
                               f'python -m workflow export "{directory}"\n')
    except (ValueError, RuntimeError, OSError) as error:
        parser.exit(1, f"Blocked: {error}\nNothing was recorded.\n")
    print(recorded)
