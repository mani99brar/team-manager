"""One-command preparation/start of a committed feature in any Git repository; never skips human gates.

The target repository is `--repo`, else the current directory when it is a Git repository with a
`features/` directory, else the repository this tool lives in (md-manager). The feature is any
directory under `<target>/features/` that holds a `feature.json`.
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

from .guardrails import DECISIONS, is_guarded, migration_note, prd_path, refusals
from .pipeline import parse_lane_selection, policy_workers, validate_pipeline_policy
from .registry import merge_registry, read_registry, register, registry_entry, registry_path, repo_name
from .sessions import read_json, validate_node_id, validate_reviewer_id
from .verification import validate_schema

# The repository this tool lives in: the fallback target, and the working directory of every
# `python -m workflow` command a launch runs (it locates the tool, not the target).
TOOL = Path(__file__).resolve().parents[1]
BUILTIN_BRIEFS = Path(__file__).resolve().parent / "prompts" / "reviewers"
BUILTIN_PREFIX = "builtin:"
PLACEHOLDER = "TODO:"
FEATURE_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}")
LEGACY_FEATURE_MESSAGE = ("feature.json version 1.0.0 (ui_task/adapter_task) is no longer supported: rewrite it as version 2.x "
                          "with workers: [{node_id, task}] (contracts/workflow/feature.schema.json)")


def git_root(path: Path) -> Path | None:
    """The working tree containing `path` (a `.git` directory, or the `.git` file of a linked worktree), or None."""
    path = path.resolve()
    for candidate in (path, *path.parents):
        if (candidate / ".git").exists():
            return candidate
    return None


def resolve_target(repo: Path | None, cwd: Path, tool: Path = TOOL) -> Path:
    """`--repo` wins; then a cwd inside a Git repository with `features/`; otherwise the tool's own repository."""
    if repo is not None:
        root = git_root(repo)
        if root is None:
            raise ValueError(f"--repo is not inside a Git repository: {repo}")
        if not (root / "features").is_dir():
            raise ValueError(f"--repo has no features/ directory: {root}")
        return root
    root = git_root(cwd)
    if root is not None and (root / "features").is_dir():
        return root
    return tool.resolve()


def feature_names(target: Path) -> list[str]:
    """Every directory under `<target>/features/` that holds a `feature.json`, sorted."""
    features = target / "features"
    if not features.is_dir():
        return []
    return sorted(item.name for item in features.iterdir() if item.is_dir() and (item / "feature.json").is_file())


def feature_folder(target: Path, feature: str) -> Path:
    names = feature_names(target)
    if feature not in names or not FEATURE_NAME.fullmatch(feature):
        raise ValueError(f"Unknown feature {feature!r} in {target / 'features'}; found: {', '.join(names) or 'none'}")
    return target / "features" / feature


def default_run_root(target: Path, feature: str, tool: Path = TOOL, home: Path | None = None) -> Path:
    """md-manager keeps `~/.local/state/md-manager-workflows/<feature>`; other targets `~/.local/state/agent-workflows/<repo>/<feature>`."""
    home = home or Path.home()
    if target.resolve() == tool.resolve():
        return home / ".local/state/md-manager-workflows" / feature
    return home / ".local/state/agent-workflows" / repo_name(target) / feature


def placeholders(folder: Path) -> list[str]:
    """Every placeholder `init` left in the files it writes, as `<file>:<line>: <text>`.

    Only `feature.json`, `policy.json`, `README.md`, `decisions.md` and the task files `feature.json` names are scanned, and only a
    JSON string value or a Markdown line that begins with `TODO:` counts. Prose that mentions the marker, reviewer
    briefs and any other file are never refused.
    """
    found = []
    tasks = []
    try:
        manifest = json.loads((folder / "feature.json").read_text())
        tasks = [worker["task"] for worker in manifest.get("workers", []) if isinstance(worker, dict) and isinstance(worker.get("task"), str)]
    except (OSError, ValueError, AttributeError):
        pass  # load_feature reports a missing or malformed feature file.
    for name in ["feature.json", "policy.json", "README.md", DECISIONS, *tasks]:
        path = folder / name
        if not path.is_file() or not path.resolve().is_relative_to(folder.resolve()):
            continue
        try:
            lines = path.read_text().splitlines()
        except (UnicodeDecodeError, OSError):
            continue
        json_file = path.suffix == ".json"
        for number, line in enumerate(lines, 1):
            text = line.strip()
            if (f'"{PLACEHOLDER}' in text) if json_file else text.startswith(PLACEHOLDER):
                found.append(f"{name}:{number}: {text}")
    return found


def load_feature(folder: Path) -> dict:
    """The feature file as 2.0.0, 2.1.0 or 2.2.0; 1.0.0 files are refused.

    2.1.0 adds `reviewers`: one entry per reviewer with its brief, a feature-relative file or `builtin:<id>`.
    A file without `reviewers` runs the single built-in reviewer. 2.2.0 turns on the guardrails
    (workflow/guardrails.py) and adds the optional `challenge` and `prd`.
    """
    manifest = read_json(folder / "feature.json")
    if isinstance(manifest, dict) and manifest.get("version") == "1.0.0":
        raise ValueError(LEGACY_FEATURE_MESSAGE)
    validate_schema("feature", manifest)
    ids = [worker["node_id"] for worker in manifest["workers"]]
    if len(set(ids)) != len(ids):
        raise ValueError("feature.json declares a worker lane twice")
    for node in ids:
        validate_node_id(node)
    if not is_guarded(manifest) and ("challenge" in manifest or "prd" in manifest):
        raise ValueError("feature.json challenge and prd need version 2.2.0")
    reviewers = manifest.get("reviewers")
    if reviewers is not None:
        if manifest["version"] == "2.0.0":
            raise ValueError("feature.json reviewers need version 2.1.0")
        reviewer_ids = [item["reviewer_id"] for item in reviewers]
        for reviewer_id in reviewer_ids:
            validate_reviewer_id(reviewer_id, ids)
        if len(set(reviewer_ids)) != len(reviewer_ids):
            raise ValueError("feature.json declares a reviewer twice")
    return manifest


def feature_file(folder: Path, name: str) -> Path:
    path = (folder / name).resolve(strict=True)
    if not path.is_relative_to(folder.resolve()):
        raise ValueError("Feature file escapes feature directory")
    return path


def builtin_briefs() -> list[str]:
    return sorted(path.stem for path in BUILTIN_BRIEFS.glob("*.md"))


def reviewer_brief(folder: Path, prompt: str) -> Path:
    """A reviewer's brief: `builtin:<id>` names a brief bundled in workflow/prompts/reviewers/, anything else a feature file."""
    if prompt.startswith(BUILTIN_PREFIX):
        name = prompt[len(BUILTIN_PREFIX):]
        if name not in builtin_briefs():
            raise ValueError(f"Unknown bundled reviewer brief {prompt!r}; bundled: {', '.join(BUILTIN_PREFIX + item for item in builtin_briefs())}")
        return BUILTIN_BRIEFS / f"{name}.md"
    return feature_file(folder, prompt)


def launch_commands(repo: Path, feature: str, run_id: str, run_root: Path, herdr: bool = True, automatic: bool = False,
                    worker_timeout_seconds: int | None = None, review_timeout_seconds: int | None = None,
                    reviewer_transport: str | None = None, workers: str | None = None) -> tuple[Path, list[list[str]], list[str]]:
    """The exact commands a launch runs against the target `repo`, the run directory and any notes; nothing is executed here."""
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}", run_id):
        raise ValueError("run-id must be an opaque identifier, not a path")
    repo = repo.resolve()
    folder = feature_folder(repo, feature)
    left = placeholders(folder)
    if left:
        raise ValueError(f"features/{feature} still has {len(left)} placeholder(s) to fill in:\n  " + "\n  ".join(left))
    manifest = load_feature(folder)
    notes: list[str] = []
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
    # 2.2.0: outcome briefs, decisions.md and the PRD, all refused here, before any Git action.
    refused = refusals(repo, folder, manifest, tasks)
    if refused:
        raise ValueError(f"features/{feature} does not meet the 2.2.0 guardrails:\n  " + "\n  ".join(refused))
    reviewers = {}
    for reviewer in manifest.get("reviewers") or []:
        path = reviewer_brief(folder, reviewer["prompt"])
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
    if is_guarded(manifest):
        prepare.extend(["--guardrails", "--decisions", str(folder / DECISIONS)])
        if "prd" in manifest:
            prepare.extend(["--prd", str(prd_path(repo, manifest["prd"]))])
        if manifest.get("challenge") is False:
            prepare.append("--no-challenge")
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


def challenge_paused(run: Path) -> bool:
    path = run / "challenge.json"
    return path.is_file() and read_json(path).get("status") == "paused"


def command_cwd(command: list[str], target: Path, tool: Path = TOOL) -> Path:
    """`git switch` runs in the target; the `python -m workflow` commands run from the tool's directory."""
    return target if command[0] == "git" else tool


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("feature", help="A directory under <target>/features/ that holds a feature.json")
    parser.add_argument("--repo", type=Path, help="Target Git repository (default: the current directory when it is a Git repository "
                                                  "with features/, otherwise this tool's own repository)")
    parser.add_argument("--run-id", help="Opaque run identifier (default: <feature>-001)")
    parser.add_argument("--run-root", type=Path, help="Run storage outside the target (default: ~/.local/state/md-manager-workflows/<feature> "
                                                      "for md-manager, ~/.local/state/agent-workflows/<repo>/<feature> otherwise)")
    parser.add_argument("--workers", help="Comma-separated subset of the feature's declared lanes to launch (default: every declared lane)")
    parser.add_argument("--live", action="store_true", help="Authorize Claude usage")
    parser.add_argument("--automatic", action="store_true", help="Bypass worker permission prompts; run through independent review to a verified feature branch")
    parser.add_argument("--worker-timeout-seconds", type=int, help="Automatic mode: per-worker deadline from launch to completion signal (default 4h, max 24h)")
    parser.add_argument("--review-timeout-seconds", type=int, help="Automatic mode: reviewer deadline from its launch to its completion file (default 30m, max 24h)")
    parser.add_argument("--reviewer-transport", choices=["native", "print"], help="Automatic mode: native attachable reviewer session (default) or headless claude --print")
    parser.add_argument("--no-herdr", action="store_true", help="Explicitly omit terminal attachments")
    parser.add_argument("--dry-run", action="store_true", help="Validate feature configuration and print commands and the registry entry only")
    args = parser.parse_args(argv)
    run_id = args.run_id or f"{args.feature}-001"
    try:
        repo = resolve_target(args.repo, Path.cwd())
        feature_folder(repo, args.feature)  # An unknown name is refused with the features found, before anything else.
        run_root = args.run_root or default_run_root(repo, args.feature)
        run, commands, notes = launch_commands(repo, args.feature, run_id, run_root.resolve(), not args.no_herdr, args.automatic,
                                               args.worker_timeout_seconds, args.review_timeout_seconds, args.reviewer_transport, args.workers)
        prepare = commands[2]
        selected = [prepare[index + 1].split("=", 1)[0] for index, item in enumerate(prepare) if item == "--task"]
        reviewers = [prepare[index + 1].split("=", 1)[0] for index, item in enumerate(prepare) if item == "--reviewer"] or ["review"]
        registry = registry_path()
        # The registered graph is the feature's (every declared lane), not this launch's `--workers` subset.
        manifest = load_feature(feature_folder(repo, args.feature))
        declared = [worker["node_id"] for worker in manifest["workers"]]
        challenge = is_guarded(manifest) and manifest.get("challenge", True) is True
        entry = registry_entry(repo, args.feature, run_root.resolve(), declared, challenge=challenge)
        # Before 2.2.0 nothing is refused; the launch says so once, beside (not among) its notes.
        migration = migration_note(manifest)
        if args.dry_run:
            print(json.dumps({"repository": str(repo), "run_directory": str(run), "workers": selected, "reviewers": reviewers, "commands": commands,
                              "executes": False, "notes": notes, "registry": {"path": str(registry), "entry": entry},
                              "guardrails": {"feature_version": manifest["version"], "enforced": migration is None, "challenge": challenge,
                                             "migration_note": migration}}, indent=2))
            for note in notes + ([migration] if migration else []):
                print(f"Note: {note}", file=sys.stderr)
            return
        if not args.live:
            parser.error("Use --live to authorize worker usage, or --dry-run to inspect without running anything")
        if run.exists():
            raise ValueError(f"Run already exists: {run}. Inspect it with status; do not launch duplicate workers.")
        # A malformed registry blocks the launch here, before any Git action; it is never rewritten.
        merge_registry(read_registry(registry), entry)
        for note in notes + ([migration] if migration else []):
            print(f"Note: {note}", file=sys.stderr)
        try:
            for index, command in enumerate(commands):
                subprocess.run(command, cwd=command_cwd(command, repo), check=True)
                if index == 2:
                    # The run directory exists now: make the run visible in the Projects viewer.
                    try:
                        print(f"Projects registry {registry}: {register(registry, entry)}", flush=True)
                    except (ValueError, OSError) as error:
                        print(f"Projects registry {registry} not updated: {error}", file=sys.stderr, flush=True)
                if index == 3 and challenge_paused(run):
                    # `start` printed the concerns and the resume commands; nothing else runs until the operator decides.
                    print(f"\nLaunch paused at the design challenge; no worker was launched. Run: {run}")
                    return
        except KeyboardInterrupt:
            parser.exit(130, f"Launch interrupted. Nothing was rolled back. If workers were started they are still running;\n"
                             f"inspect with: {sys.executable} -m workflow status {run}\n"
                             + (f"resume with:  {sys.executable} -m workflow automatic {run} --live\n" if args.automatic else ""))
        except subprocess.CalledProcessError as error:
            if not (args.automatic and error.returncode == 75):
                raise
            # `automatic` exits 75 when Claude Code itself was unavailable: nothing was stopped and the run is resumable.
            parser.exit(75, f"Launch interrupted: Claude Code was unavailable; nothing was stopped. Once `claude` works,\n"
                            f"resume with:  {sys.executable} -m workflow automatic {run} --live\n")
        if args.automatic:
            print(f"\nAutomatic run finished. Evidence: {run / 'report.html'}. No main merge or push.")
            return
        print(f"\nRun: {run}\nWorkers ({', '.join(selected)}) are in their dedicated Herdr tab (unless --no-herdr).")
        print("Watch/answer permission prompts. When every worker finishes, return to Pi for handoffs and freeze.")
        drill_note = next((note for note in notes if note.startswith("Failure drill skipped")), None)
        if drill_note:
            print(drill_note)
        else:
            folder = feature_folder(repo, args.feature)
            drill = read_json(feature_file(folder, load_feature(folder)["policy"])).get("failure_drill")
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
