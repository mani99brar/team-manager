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


def launch_commands(repo: Path, feature: str, run_id: str, run_root: Path, herdr: bool = True) -> tuple[Path, list[list[str]]]:
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
    return run, [
        preflight,
        ["git", "switch", "-c", branch],
        [*base, "prepare", str(run), "--repo", str(repo), "--policy", str(files["policy"]),
         "--ui-task", str(files["ui_task"]), "--adapter-task", str(files["adapter_task"])],
        start,
    ]


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("feature", choices=["project-workflows"])
    parser.add_argument("--run-id", default="project-workflows-001")
    parser.add_argument("--run-root", type=Path, default=Path.home() / ".local/state/md-manager-workflows/project-workflows")
    parser.add_argument("--live", action="store_true", help="Authorize two Claude sessions")
    parser.add_argument("--no-herdr", action="store_true", help="Explicitly omit terminal attachments")
    parser.add_argument("--dry-run", action="store_true", help="Validate feature configuration and print commands only")
    args = parser.parse_args(argv)
    repo = Path(__file__).resolve().parents[1]
    try:
        run, commands = launch_commands(repo, args.feature, args.run_id, args.run_root.resolve(), not args.no_herdr)
        if args.dry_run:
            print(json.dumps({"run_directory": str(run), "commands": commands, "executes": False}, indent=2))
            return
        if not args.live:
            parser.error("Use --live to authorize worker usage, or --dry-run to inspect without running anything")
        if run.exists():
            raise ValueError(f"Run already exists: {run}. Inspect it with status; do not launch duplicate workers.")
        for command in commands:
            subprocess.run(command, cwd=repo, check=True)
        print(f"\nRun: {run}\nWorkers are in their dedicated Herdr tab (unless --no-herdr).")
        print("Watch/answer permission prompts. When both finish, return to Pi for handoffs and freeze.")
        print("The intentional adapter verification drill will block its first attempt; retry that check explicitly after restarting the controller.")
        print(f"Status: {sys.executable} -m workflow status {run}")
        print("Review and integration still require separate explicit approval. Nothing is pushed.")
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        parser.exit(1, f"Launch blocked: {error}\nNo fallback, reset or cleanup was attempted. Inspect any retained branch/run state.\n")


if __name__ == "__main__":
    main()
