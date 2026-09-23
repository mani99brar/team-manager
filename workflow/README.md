# LangGraph workflows

A supervised multi-lane workflow for Claude Code workers. The controller lives in md-manager's `workflow/` and drives any Git repository: one native interactive Claude worker per configured lane, each in its own worktree and Herdr pane, then an explicit freeze, immutable snapshots, isolated checks, a combined-candidate check, independent review (one or more reviewers), approval and a local fast-forward. Automatic mode (`--automatic`) runs the same graph unattended and stops at an independently reviewed, verified feature branch. Nothing ever merges `main` or pushes.

**Procedures, recovery and bounds are in [RUNBOOK.md](RUNBOOK.md).** `report.html` in each run directory is a local graph/results viewer, and `run-state.json` (export 1.4.0) is what md-manager's Projects viewer reads.

## Commands

```bash
PY="$HOME/dev/md-manager/.venv/bin/python"   # run from md-manager's checkout, or anywhere with PYTHONPATH pointing at it
```

| Command | What it does |
| --- | --- |
| `$PY -m workflow init <feature> [--repo X]` | writes `features/<feature>/` in the target (and a starter `CLAUDE.md` when missing); never overwrites |
| `$PY -m workflow launch <feature> [--repo X] --dry-run` | validates the feature and prints the commands and the registry entry; executes nothing |
| `$PY -m workflow launch <feature> [--repo X] --live [--automatic]` | preflight, feature branch, prepare, start (and supervise with `--automatic`) |
| `$PY -m workflow <action> "$RUN"` | one pipeline step: `preflight`, `prepare`, `start`, `automatic`, `freeze`, `review`, `approve`, `retry`, `reconcile`, `attach`, `status`, `export` |
| `$PY -m workflow.interactive attach-one "$RUN" --node <node>` | reconnects one native session in the current terminal (what the Herdr panes run) |

The target is `--repo`, else the current directory when it is a Git repository with a `features/` directory, else md-manager itself; the run records it in `plan.json` (`repository`), so later actions need no flag. A feature is any directory under `<target>/features/` that holds a `feature.json`. Flags, actions and the files of a run directory are listed in [RUNBOOK.md](RUNBOOK.md#command-reference).

## Use it in another project

1. **Prepare the repository.** It must be a Git repository with at least one commit and a named branch. Worker sessions start in worktrees of it and read its `CLAUDE.md`: put the project's conventions there (build and test commands, style, directories a worker must never touch). `init` writes a starter one when there is none.
2. **Scaffold the feature.**

   ```bash
   $PY -m workflow init my-feature --repo ~/dev/project-B
   ```

   This writes `features/my-feature/` with a 2.1.0 `feature.json` (one lane `main`, the bundled `general` and `coverage` reviewers), a 1.2.0 `policy.json` with a placeholder check, `main-task.md` in outcome-brief form (`## Goal`, `## Context`, `## Constraints`, `## Acceptance`, `## Stop`) and a `README.md`. Every value to decide is a `TODO:` line; `launch` refuses the feature and names each one until none is left. Add lanes by adding a `workers` entry to both files and a task file per lane.
3. **Fill in and commit.** Give each lane its owned paths and the checks the controller runs independently (`kind` `unit` needs a Python unittest or Node TAP/spec summary; see "Verification policy and evidence" in the runbook). A reviewer's `prompt` is a feature file or `builtin:general` / `builtin:coverage` (the briefs in `workflow/prompts/reviewers/`). Commit: preparation refuses a dirty tree.
4. **Accept permission bypass once.** Automatic workers start with `--dangerously-skip-permissions`, which Claude asks you to accept interactively the first time. Do it once before the first automatic run, in the target: `cd ~/dev/project-B && claude --dangerously-skip-permissions`, accept, then exit.
5. **Dry run, then launch** from a Herdr pane:

   ```bash
   $PY -m workflow launch my-feature --repo ~/dev/project-B --dry-run
   $PY -m workflow launch my-feature --repo ~/dev/project-B --live --automatic --reviewer-transport print
   ```

   Runs are stored under `~/.local/state/agent-workflows/<repo-name>/<feature>/<run-id>` (`--run-root` overrides; storage must be outside the target). md-manager keeps `~/.local/state/md-manager-workflows/<feature>`.
6. **See it in the Projects viewer.** A live launch adds or updates the target's project in the registry named by `MD_MANAGER_PROJECTS_CONFIG`, else `~/.config/md-manager/projects.json`: project id is the repository name lowercased, the workflow id is the feature, with its runs root and the graph definition. Only that workflow is replaced; every other entry keeps its bytes, and the file is written atomically. A malformed registry blocks the launch before any Git action; a runs root another workflow already covers leaves the file unchanged with a note. The dry run prints the entry it would write. The server reads the registry at startup, so restart it (with `MD_MANAGER_PROJECTS_CONFIG` pointing at the same file) to see a new project.

## Setup

From md-manager's root (Python 3.12 recommended):

```bash
python3 -m venv .venv
.venv/bin/pip install -r workflow/requirements.lock
npm ci
npx --no-install playwright install chromium
.venv/bin/python -m workflow.run_tests   # parallel by test class; or: -m unittest discover -s workflow -t . -v
npm run test:contracts
```

The tests use fake workers and reviewers with real Git worktrees, checks, checkpoints and headless Chromium; they make no Claude model calls. `test_portable.py` covers the portable-workflow scenarios; `testdata/` holds copies of finished features' files the tests read.

## Files

- `launch.py`: target resolution, feature scanning, validation (placeholders, bundled briefs) and the one-command launch.
- `scaffold.py`: `init`. `registry.py`: the Projects registry entry and its atomic merge.
- `sessions.py`: run preparation (one worktree per selected lane), lane id rules, receipts, locking.
- `interactive.py`: native `claude --bg` launches, Herdr panes (one per lane, reviewers to their right), reconciliation, `attach-one`. `herdr.py`: the Herdr CLI helper.
- `pipeline.py`: the supervised graph over the plan's lanes, freeze/ownership, verification, candidate, review, approval, integration and the CLI.
- `automatic.py`: unattended supervision, completion signals, the native/print reviewers (one per declared reviewer, unanimous verdict); `prompts/review.md` is the built-in brief, `prompts/reviewers/` the bundled ones.
- `verification.py`, `checks.py`: policy validation against the bundled `contracts/workflow/` schemas and isolated check execution.
- `export_state.py`: the versioned `run-state.json` export (1.4.0).
- `requirements.txt` / `requirements.lock`: bounded Python dependencies, installed separately from the Node application.
