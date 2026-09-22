"""One-command preparation/start of a committed feature; never skips human gates."""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

from .pipeline import validate_pipeline_policy
from .sessions import read_json


FEATURES = ("project-workflows", "review-result", "run-inputs")
DEFAULT_RUN_ROOT = Path.home() / ".local/state/md-manager-workflows"


def launch_commands(repo: Path, feature: str, run_id: str, run_root: Path, herdr: bool = True, automatic: bool = False,
                    worker_timeout_seconds: int | None = None, review_timeout_seconds: int | None = None,
                    reviewer_transport: str | None = None) -> tuple[Path, list[list[str]]]:
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}", run_id):
        raise ValueError("run-id must be an opaque identifier, not a path")
    folder = repo / "features" / feature
    manifest = read_json(folder / "feature.json")
    files = {}
    for key in ("policy", "ui_task", "adapter_task"):
        path = (folder / manifest[key]).resolve(strict=True)
        if not path.is_relative_to(folder.resolve()):
            raise ValueError("Feature file escapes feature directory")
        files[key] = path
    validate_pipeline_policy(read_json(files["policy"]))
    run = (run_root / run_id).resolve()
    if run == repo or repo in run.parents:
        raise ValueError("Run storage must be outside the repository")
    base = [sys.executable, "-m", "workflow"]
    preflight = [*base, "preflight", str(run), "--repo", str(repo), "--policy", str(files["policy"])]
    start = [*base, "start", str(run), "--live"]
    if herdr:
        preflight.append("--herdr")
        start.append("--herdr")
    branch = f"{manifest['branch_prefix']}/{run_id}"
    commands = [
        preflight,
        ["git", "switch", "-c", branch],
        [*base, "prepare", str(run), "--repo", str(repo), "--policy", str(files["policy"]), "--feature", feature,
         "--ui-task", str(files["ui_task"]), "--adapter-task", str(files["adapter_task"])],
        start,
    ]
    if automatic:
        from .automatic import automatic_settings
        # Reject bad deadlines or transport before any command runs.
        settings = automatic_settings(worker_timeout_seconds, review_timeout_seconds, reviewer_transport)
        commands[0].append("--automatic")
        commands[2].extend(["--automatic", "--worker-timeout-seconds", str(settings["worker_timeout_seconds"]),
                            "--review-timeout-seconds", str(settings["review_timeout_seconds"]),
                            "--reviewer-transport", settings["reviewer_transport"]])
        commands.append([*base, "automatic", str(run), "--live"])
    elif worker_timeout_seconds is not None or review_timeout_seconds is not None or reviewer_transport is not None:
        raise ValueError("Timeouts and reviewer transport apply to --automatic runs only")
    return run, commands


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("feature", choices=FEATURES)
    parser.add_argument("--run-id", help="Opaque run identifier (default <feature>-001)")
    parser.add_argument("--run-root", type=Path, help=f"Run storage parent (default {DEFAULT_RUN_ROOT}/<feature>)")
    parser.add_argument("--live", action="store_true", help="Authorize Claude usage")
    parser.add_argument("--automatic", action="store_true", help="Bypass worker permission prompts; run through independent review to a verified feature branch")
    parser.add_argument("--worker-timeout-seconds", type=int, help="Automatic mode: per-worker deadline from launch to completion signal (default 4h, max 24h)")
    parser.add_argument("--review-timeout-seconds", type=int, help="Automatic mode: reviewer session timeout from launch (default 30m, max 24h)")
    parser.add_argument("--reviewer-transport", choices=["native", "print"], help="Automatic mode: attachable native reviewer session (default) or headless print mode")
    parser.add_argument("--no-herdr", action="store_true", help="Explicitly omit terminal attachments")
    parser.add_argument("--dry-run", action="store_true", help="Validate feature configuration and print commands only")
    args = parser.parse_args(argv)
    repo = Path(__file__).resolve().parents[1]
    run_id = args.run_id or f"{args.feature}-001"
    run_root = (args.run_root or DEFAULT_RUN_ROOT / args.feature).resolve()
    try:
        run, commands = launch_commands(repo, args.feature, run_id, run_root, not args.no_herdr, args.automatic,
                                        args.worker_timeout_seconds, args.review_timeout_seconds, args.reviewer_transport)
        if args.dry_run:
            print(json.dumps({"run_directory": str(run), "commands": commands, "executes": False}, indent=2))
            return
        if not args.live:
            parser.error("Use --live to authorize worker usage, or --dry-run to inspect without running anything")
        if run.exists():
            raise ValueError(f"Run already exists: {run}. Inspect it with status; do not launch duplicate workers.")
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
        print(f"\nRun: {run}\nWorkers are in their dedicated Herdr tab (unless --no-herdr).")
        print("Watch/answer permission prompts. When both finish, return to Pi for handoffs and freeze.")
        print("A policy with a failure drill blocks that lane's first verification attempt; retry that check explicitly after restarting the controller.")
        print(f"Status: {sys.executable} -m workflow status {run}")
        print("Review and integration still require separate explicit approval. Nothing is pushed.")
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        parser.exit(1, f"Launch blocked: {error}\nNo fallback, reset or cleanup was attempted. Inspect any retained branch/run state.\n")


if __name__ == "__main__":
    main()
