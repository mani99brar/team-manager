"""One-command preparation/start of a committed feature; never skips human gates."""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

from .pipeline import parse_lane_selection, policy_workers, validate_pipeline_policy
from .sessions import read_json, validate_node_id, validate_reviewer_id
from .verification import validate_schema


FEATURES = ("project-workflows", "worker-lanes", "parallel-reviewers", "parallel-reviewers-align", "workflow-audit", "viewer-clarity", "portable-workflow")
FEATURE_VERSION = "2.0.0"
DEPRECATED_FEATURE_NOTE = ("feature.json version 1.0.0 (ui_task/adapter_task) is deprecated: it is translated to 2.0.0 "
                           "(workers: [{node_id, task}]); migrate the file. See contracts/workflow/feature.schema.json.")


def load_feature(folder: Path) -> tuple[dict, list[str]]:
    """The feature file as 2.0.0 or 2.1.0 plus any deprecation notes; 1.0.0 files are translated in memory.

    2.1.0 adds `reviewers`: one entry per reviewer with its brief file. A file without `reviewers` (2.0.0 or
    2.1.0) runs the single built-in reviewer, so `features/project-workflows` needs no change.
    """
    manifest = read_json(folder / "feature.json")
    notes = []
    if isinstance(manifest, dict) and manifest.get("version") == "1.0.0":
        translated = {key: manifest[key] for key in ("name", "branch_prefix", "policy") if key in manifest}
        translated["version"] = FEATURE_VERSION
        translated["workers"] = [{"node_id": "ui", "task": manifest.get("ui_task")}, {"node_id": "adapter", "task": manifest.get("adapter_task")}]
        manifest = translated
        notes.append(DEPRECATED_FEATURE_NOTE)
    validate_schema("feature", manifest)
    ids = [worker["node_id"] for worker in manifest["workers"]]
    if len(set(ids)) != len(ids):
        raise ValueError("feature.json declares a worker lane twice")
    for node in ids:
        validate_node_id(node)
    reviewers = manifest.get("reviewers")
    if reviewers is not None:
        if manifest["version"] == "2.0.0":
            raise ValueError("feature.json reviewers need version 2.1.0")
        reviewer_ids = [item["reviewer_id"] for item in reviewers]
        for reviewer_id in reviewer_ids:
            validate_reviewer_id(reviewer_id, ids)
        if len(set(reviewer_ids)) != len(reviewer_ids):
            raise ValueError("feature.json declares a reviewer twice")
    return manifest, notes


def feature_file(folder: Path, name: str) -> Path:
    path = (folder / name).resolve(strict=True)
    if not path.is_relative_to(folder.resolve()):
        raise ValueError("Feature file escapes feature directory")
    return path


def launch_commands(repo: Path, feature: str, run_id: str, run_root: Path, herdr: bool = True, automatic: bool = False,
                    worker_timeout_seconds: int | None = None, review_timeout_seconds: int | None = None,
                    reviewer_transport: str | None = None, workers: str | None = None) -> tuple[Path, list[list[str]], list[str]]:
    """The exact commands a launch runs, the run directory and any deprecation notes; nothing is executed here."""
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}", run_id):
        raise ValueError("run-id must be an opaque identifier, not a path")
    folder = repo / "features" / feature
    manifest, notes = load_feature(folder)
    policy_path = feature_file(folder, manifest["policy"])
    policy = validate_pipeline_policy(read_json(policy_path))
    declared = policy_workers(policy)
    if [worker["node_id"] for worker in manifest["workers"]] != declared:
        raise ValueError(f"feature.json workers ({', '.join(worker['node_id'] for worker in manifest['workers'])}) must be the policy's lanes in order ({', '.join(declared)})")
    tasks = {}
    for worker in manifest["workers"]:
        path = feature_file(folder, worker["task"])
        if not path.is_file() or not path.read_text().strip():
            raise ValueError(f"Task file for lane {worker['node_id']} is missing or empty: {worker['task']}")
        tasks[worker["node_id"]] = path
    reviewers = {}
    for reviewer in manifest.get("reviewers") or []:
        path = feature_file(folder, reviewer["prompt"])
        if not path.is_file() or not path.read_text().strip():
            raise ValueError(f"Brief for reviewer {reviewer['reviewer_id']} is missing or empty: {reviewer['prompt']}")
        reviewers[reviewer["reviewer_id"]] = path
    # Unknown ids, duplicates and an empty list are refused here, before any Git action.
    selected = parse_lane_selection(workers, declared)
    run = (run_root / run_id).resolve()
    if run == repo or repo in run.parents:
        raise ValueError("Run storage must be outside the repository")
    base = [sys.executable, "-m", "workflow"]
    preflight = [*base, "preflight", str(run), "--repo", str(repo), "--policy", str(policy_path)]
    start = [*base, "start", str(run), "--live"]
    if herdr:
        preflight.append("--herdr")
        start.append("--herdr")
    branch = f"{manifest['branch_prefix']}/{run_id}"
    prepare = [*base, "prepare", str(run), "--repo", str(repo), "--policy", str(policy_path)]
    if workers is not None:
        prepare.extend(["--workers", ",".join(selected)])
    for node in selected:
        prepare.extend(["--task", f"{node}={tasks[node]}"])
    for reviewer_id, path in reviewers.items():
        prepare.extend(["--reviewer", f"{reviewer_id}={path}"])
    commands = [preflight, ["git", "switch", "-c", branch], prepare, start]
    if automatic:
        from .automatic import automatic_settings
        # Reject bad deadlines or an unknown transport before any command runs.
        settings = automatic_settings(worker_timeout_seconds, review_timeout_seconds, reviewer_transport)
        commands[0].append("--automatic")
        commands[2].extend(["--automatic", "--worker-timeout-seconds", str(settings["worker_timeout_seconds"]),
                            "--review-timeout-seconds", str(settings["review_timeout_seconds"]),
                            "--reviewer-transport", settings["reviewer_transport"]])
        commands.append([*base, "automatic", str(run), "--live"])
    elif worker_timeout_seconds is not None or review_timeout_seconds is not None or reviewer_transport is not None:
        raise ValueError("Timeouts and the reviewer transport apply to --automatic runs only")
    drill = policy.get("failure_drill")
    if drill and drill["node_id"] not in selected:
        notes.append(f"Failure drill skipped: its lane {drill['node_id']} is not selected (selected: {', '.join(selected)}).")
    return run, commands, notes


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("feature", choices=FEATURES)
    parser.add_argument("--run-id", help="Opaque run identifier (default: <feature>-001)")
    parser.add_argument("--run-root", type=Path, help="Run storage outside the repository (default: ~/.local/state/md-manager-workflows/<feature>)")
    parser.add_argument("--workers", help="Comma-separated subset of the feature's declared lanes to launch (default: every declared lane)")
    parser.add_argument("--live", action="store_true", help="Authorize Claude usage")
    parser.add_argument("--automatic", action="store_true", help="Bypass worker permission prompts; run through independent review to a verified feature branch")
    parser.add_argument("--worker-timeout-seconds", type=int, help="Automatic mode: per-worker deadline from launch to completion signal (default 4h, max 24h)")
    parser.add_argument("--review-timeout-seconds", type=int, help="Automatic mode: reviewer deadline from its launch to its completion file (default 30m, max 24h)")
    parser.add_argument("--reviewer-transport", choices=["native", "print"], help="Automatic mode: native attachable reviewer session (default) or headless claude --print")
    parser.add_argument("--no-herdr", action="store_true", help="Explicitly omit terminal attachments")
    parser.add_argument("--dry-run", action="store_true", help="Validate feature configuration and print commands only")
    args = parser.parse_args(argv)
    repo = Path(__file__).resolve().parents[1]
    run_id = args.run_id or f"{args.feature}-001"
    run_root = args.run_root or Path.home() / ".local/state/md-manager-workflows" / args.feature
    try:
        run, commands, notes = launch_commands(repo, args.feature, run_id, run_root.resolve(), not args.no_herdr, args.automatic,
                                               args.worker_timeout_seconds, args.review_timeout_seconds, args.reviewer_transport, args.workers)
        prepare = commands[2]
        selected = [prepare[index + 1].split("=", 1)[0] for index, item in enumerate(prepare) if item == "--task"]
        reviewers = [prepare[index + 1].split("=", 1)[0] for index, item in enumerate(prepare) if item == "--reviewer"] or ["review"]
        if args.dry_run:
            print(json.dumps({"run_directory": str(run), "workers": selected, "reviewers": reviewers, "commands": commands, "executes": False, "notes": notes}, indent=2))
            for note in notes:
                print(f"Deprecation: {note}" if note is DEPRECATED_FEATURE_NOTE else f"Note: {note}", file=sys.stderr)
            return
        if not args.live:
            parser.error("Use --live to authorize worker usage, or --dry-run to inspect without running anything")
        if run.exists():
            raise ValueError(f"Run already exists: {run}. Inspect it with status; do not launch duplicate workers.")
        for note in notes:
            print(f"Deprecation: {note}" if note is DEPRECATED_FEATURE_NOTE else f"Note: {note}", file=sys.stderr)
        try:
            for command in commands:
                subprocess.run(command, cwd=repo, check=True)
        except KeyboardInterrupt:
            parser.exit(130, f"Launch interrupted. Nothing was rolled back. If workers were started they are still running;\n"
                             f"inspect with: {sys.executable} -m workflow status {run}\n"
                             + (f"resume with:  {sys.executable} -m workflow automatic {run} --live\n" if args.automatic else ""))
        if args.automatic:
            print(f"\nAutomatic run finished. Evidence: {run / 'report.html'}. No main merge or push.")
            return
        print(f"\nRun: {run}\nWorkers ({', '.join(selected)}) are in their dedicated Herdr tab (unless --no-herdr).")
        print("Watch/answer permission prompts. When every worker finishes, return to Pi for handoffs and freeze.")
        drill_note = next((note for note in notes if note.startswith("Failure drill skipped")), None)
        if drill_note:
            print(drill_note)
        else:
            policy = read_json(feature_file(repo / "features" / args.feature, load_feature(repo / "features" / args.feature)[0]["policy"]))
            drill = policy.get("failure_drill")
            if drill:
                print(f"The intentional {drill['node_id']} verification drill will block its first attempt; retry that check explicitly after restarting the controller.")
        print(f"Status: {sys.executable} -m workflow status {run}")
        print("Review and integration still require separate explicit approval. Nothing is pushed.")
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        parser.exit(1, f"Launch blocked: {error}\nNo fallback, reset or cleanup was attempted. Inspect any retained branch/run state.\n")
    except Exception as error:  # jsonschema ValidationError on the feature file
        from jsonschema.exceptions import ValidationError
        if not isinstance(error, ValidationError):
            raise
        parser.exit(1, f"Launch blocked: feature.json is invalid: {error.message}\nNo fallback, reset or cleanup was attempted.\n")


if __name__ == "__main__":
    main()
