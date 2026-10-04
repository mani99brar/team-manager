"""`workflow init <feature> [--repo X]`: write a feature directory to fill in; never overwrite a file.

The scaffold is a 2.3.0 `feature.json` with one lane, the bundled reviewers and a `prd` to name (its README shows
the optional review `sidecar` key, which the feature file leaves out), a 1.2.0
`policy.json` with a placeholder check, the lane's task in outcome-brief form (with the browser scenario rules
and the Playwright report command, to delete for a lane without browser checks), a `decisions.md` for the
workflow-grill skill to fill in and a `README.md`, plus a starter `CLAUDE.md` in the target root when it
has none. Every value to decide is a `TODO:` placeholder, and `launch` refuses the feature, naming each
one, until none is left; the 2.2.0 guardrails then apply (workflow/guardrails.py).
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

from .guardrails import CHECKS_DEFAULT
from .launch import FEATURE_NAME, git_root
from .sessions import validate_node_id

LANE = "main"


def feature_files(feature: str) -> dict[str, str]:
    """The feature directory's files by relative path."""
    manifest = {"version": "2.3.0", "name": f"TODO: one line saying what {feature} delivers", "branch_prefix": f"feature/{feature}",
                "prd": "TODO: the specification the design challenge reads, relative to the repository root (or delete this key)",
                "policy": "policy.json", "workers": [{"node_id": LANE, "task": f"{LANE}-task.md"}],
                "reviewers": [{"reviewer_id": "general", "prompt": "builtin:general"}, {"reviewer_id": "coverage", "prompt": "builtin:coverage"}]}
    policy = {"version": "1.2.0", "feature": "TODO: the feature's name", "independent_review": True, "integration_approval": True,
              "max_verification_attempts": 3,
              "workers": [{"node_id": LANE, "role": "TODO: a short role label, for example backend",
                           "required_check_kinds": ["unit"], "owned_paths": ["TODO: a repository-relative path this lane may change"],
                           "checks": [{"id": "unit", "kind": "unit", "argv": ["TODO: the test command, one argument per item"],
                                       "timeout_seconds": 600, "scenarios": []}]}]}
    task = ("# Task: " + LANE + "\n\n"
            "## Goal\n\nTODO: the outcome this lane delivers, in one or two sentences.\n\n"
            "## Context\n\nTODO: where to start reading, or delete this section.\n\n"
            "## Constraints\n\nTODO: what the lane must not change, or delete this section.\n\n"
            "## Acceptance\n\nTODO: the observable results and the checks that prove them (the worker's Proof table names a proof for each).\n\n"
            + CHECKS_DEFAULT + "\n\n"  # Process, not a result: alone it leaves the Acceptance empty (brief_problems).
            "Browser checks (delete this paragraph, the command and the line after it if the lane has none): each scenario id appears in "
            "exactly one test title as `[scenario:<id>]`, and that test, when it passes, attaches exactly one image/png named "
            "`screenshot:<id>` (other attachments are fine). The verifier refuses anything else. Before completing, run the spec "
            "files you changed with a JSON report:\n\n"
            "```bash\n"
            "WORKFLOW_VERIFICATION_PHASE=<worker|candidate> PLAYWRIGHT_JSON_OUTPUT_FILE=<tmp>/report.json \\\n"
            "  npx --no-install playwright test --config=<config> --reporter=json <spec files>\n"
            "```\n\n"
            "Then check the report with the verifier's own rules: run the exact `check-report` command the controller appends to "
            "this task when it pins it.\n\n"
            "## Stop\n\nTODO: when to stop and report `blocked` instead of continuing.\n")
    decisions = (f"# Decisions: {feature}\n\n"
                 f"Written with the workflow-grill skill (`/workflow-grill {feature}`) before launch. Every worker and reviewer "
                 "prompt includes this file, and launch refuses the feature while it is empty. Only the Operator decisions bind the "
                 "run and win over the task; the design challenge may question the rest.\n\n"
                 "## Operator decisions\n\nTODO: each answer of the operator as [O<n>], with its question number, the chosen option's "
                 "text and the operator's words verbatim; never edited in place.\n\n"
                 "## Grill defaults\n\nTODO: each default the grill chose as [G<n>], delegations with the items they cover and riders "
                 "tagged [added, not asked], or \"None\".\n\n"
                 "## Changes after launch\n\nNone yet.\n\n"
                 "## Deferred\n\nTODO: what this feature leaves for later, or \"Nothing\".\n")
    readme = (f"# {feature}\n\n"
              "TODO: why this feature exists and where its specification lives.\n\n"
              "- `feature.json`: the lanes, their task files, the reviewers (`builtin:<id>` names a bundled brief), the `prd` the design "
              "challenge reads and `challenge` (default true).\n"
              "- Optional `sidecar` in `feature.json`: a review sidecar, an independent reviewer that reads the lanes' diffs and panes "
              "while they work and may message them through the controller (the workflow tool's README, section Review sidecar). Add it as "
              "`\"sidecar\": {\"prompt\": \"builtin:senior-review\"}`, optionally with `cadence_seconds` (default 900), "
              "`pass_timeout_seconds` (600), `max_passes` (16) and `max_messages_per_lane` (6).\n"
              "- `policy.json`: each lane's owned paths and the checks the controller runs independently.\n"
              f"- `{LANE}-task.md`: the lane's task as an outcome brief (## Goal, ## Acceptance and ## Stop are required).\n"
              "- `decisions.md`: from the workflow-grill interview, the operator's decisions (only these bind the run), the grill's "
              "defaults, changes after launch and deferrals.\n\n"
              f"Launch: `python -m workflow launch {feature} --repo <this repository> --dry-run`, then `--live`.\n")
    return {"feature.json": json.dumps(manifest, indent=2) + "\n", "policy.json": json.dumps(policy, indent=2) + "\n",
            f"{LANE}-task.md": task, "decisions.md": decisions, "README.md": readme}


# Workflow sessions start with --safe-mode, which does not load CLAUDE.md. The last heading is the cut point: what is above
# it is the project's conventions, what is under it is for the operator only.
STARTER_CLAUDE = """# Project conventions

Keep this file short and specific. Workflow sessions start with --safe-mode, which does not load this file, so a lane's task states what that lane must follow from it.

- Build and test commands: list them here.
- Code style: what to match, and what to avoid.
- Boundaries: directories and files a worker must never change.

## Workflow (operator notes; workers skip this section)

- Notes for you and the orchestrator about running workflows in this repository. Keep what every session must follow above this heading.
"""


def init(target: Path, feature: str) -> list[Path]:
    """Write the scaffold into `target`; refuses before writing anything if a feature file already exists."""
    if not FEATURE_NAME.fullmatch(feature):
        raise ValueError(f"Feature name must match {FEATURE_NAME.pattern}: {feature!r}")
    validate_node_id(LANE)
    folder = target / "features" / feature
    files = {folder / name: text for name, text in feature_files(feature).items()}
    existing = [str(path) for path in files if path.exists()]
    if existing:
        raise ValueError(f"init never overwrites; already present: {', '.join(existing)}")
    claude = target / "CLAUDE.md"
    if not claude.exists():
        files[claude] = STARTER_CLAUDE
    folder.mkdir(parents=True, exist_ok=True)
    written = []
    for path, text in files.items():
        with path.open("x") as handle:  # Exclusive create: a file that appeared meanwhile is not overwritten.
            handle.write(text)
        written.append(path)
    return written


def main(argv=None):
    parser = argparse.ArgumentParser(prog="python -m workflow init", description=__doc__)
    parser.add_argument("feature")
    parser.add_argument("--repo", type=Path, help="Target Git repository (default: the current directory's repository)")
    args = parser.parse_args(argv)
    try:
        target = git_root(args.repo or Path.cwd())
        if target is None:
            raise ValueError(f"Not inside a Git repository: {args.repo or Path.cwd()}")
        written = init(target, args.feature)
    except (ValueError, OSError) as error:
        parser.exit(1, f"Init blocked: {error}\n")
    for path in written:
        print(f"Wrote {os.path.relpath(path, target)}")
    print(f"Fill in every TODO: line, commit, then: python -m workflow launch {args.feature} --repo {target} --dry-run")
