# LangGraph workflows

A supervised multi-lane workflow for Claude Code workers. The controller lives in md-manager's `workflow/` and drives any Git repository: one native interactive Claude worker per configured lane, each in its own worktree and Herdr pane, then an explicit freeze, immutable snapshots, isolated checks, a combined-candidate check, independent review (one or more reviewers), approval and a local fast-forward. Automatic mode (`--automatic`) runs the same graph unattended and stops at an independently reviewed, verified feature branch. Nothing ever merges `main` or pushes.

**Procedures, recovery and bounds are in [RUNBOOK.md](RUNBOOK.md).** `report.html` in each run directory is a local graph/results viewer, and `run-state.json` (export 1.5.0) is what md-manager's Projects viewer reads.

Features at `feature.json` 2.2.0 (what `init` writes) run with enforced guardrails: tasks written as outcome briefs, a `decisions.md` from an interview before launch, a design challenge before any worker starts, and worker completions that say what would prove them wrong (see "Guardrails" below).

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
| `$PY -m workflow resume "$RUN" [--accept-challenge "<reason>"] [--herdr]` | 2.2.0: commits the edited feature files on the run's branch and reruns a paused design challenge on them, or accepts it with a reason; then launches the workers (and supervises an automatic run) |
| `$PY -m workflow answer "$RUN" <lane> "<text>" [--no-herdr]` | 2.2.0: answers a worker's question, restarts its deadline and types the answer into its pane |
| `$PY -m workflow check-report <feature-dir or policy.json> <lane> <report.json> [--all]` | checks a Playwright JSON report against the lane's browser scenarios with the verifier's own rules; exits 1 on any problem (a browser lane's pinned task spells out the command it runs before completing) |
| `$PY -m workflow.interactive attach-one "$RUN" --node <node>` | reconnects one native session in the current terminal (what the Herdr panes run) |

The target is `--repo`, else the current directory when it is a Git repository with a `features/` directory, else md-manager itself; the run records it in `plan.json` (`repository`), so later actions need no flag. A feature is any directory under `<target>/features/` that holds a `feature.json`. Flags, actions and the files of a run directory are listed in [RUNBOOK.md](RUNBOOK.md#command-reference).

## Use it in another project

1. **Prepare the repository.** It must be a Git repository with at least one commit and a named branch. Worker sessions start in worktrees of it and read its `CLAUDE.md`: put the project's conventions there (build and test commands, style, directories a worker must never touch). `init` writes a starter one when there is none.
2. **Scaffold the feature.**

   ```bash
   $PY -m workflow init my-feature --repo ~/dev/project-B
   ```

   This writes `features/my-feature/` with a 2.2.0 `feature.json` (one lane `main`, the bundled `general` and `coverage` reviewers, a `prd` to name or delete), a 1.2.0 `policy.json` with a placeholder check, `main-task.md` in outcome-brief form (`## Goal`, `## Context`, `## Constraints`, `## Acceptance`, `## Stop`), a `decisions.md` placeholder and a `README.md`. Every value to decide is a `TODO:` placeholder; `launch` refuses the feature and names each one until none is left. It checks only the files `init` writes (`feature.json`, `policy.json`, `README.md`, `decisions.md` and the task files), and only JSON values or Markdown lines that begin with `TODO:`, so prose that mentions the marker is fine. Add lanes by adding a `workers` entry to both files and a task file per lane.
3. **Interview.** Run the `workflow-grill` skill (below) in Claude Code in the target: `/workflow-grill my-feature`. It asks at most five questions and writes `decisions.md`.
4. **Fill in and commit.** Give each lane its owned paths and the checks the controller runs independently (`kind` `unit` needs a Python unittest or Node TAP/spec summary; see "Verification policy and evidence" in the runbook). A `browser` check names its `scenarios`: each id must appear in exactly one test title as `[scenario:<id>]`, and that test, when it passes, must attach exactly one `image/png` named `screenshot:<id>` (other attachments are fine). The task `init` writes states this with the Playwright JSON report command a browser lane runs before completing, and the controller appends the exact `check-report` command to a browser lane's pinned task (see "Playwright evidence convention" in the runbook); delete the paragraph for a lane without browser checks. A reviewer's `prompt` is a feature file or `builtin:general` / `builtin:coverage` (the briefs in `workflow/prompts/reviewers/`). Commit: preparation refuses a dirty tree.
5. **Accept permission bypass once.** Automatic workers start with `--dangerously-skip-permissions`, which Claude asks you to accept interactively the first time. Do it once before the first automatic run, in the target: `cd ~/dev/project-B && claude --dangerously-skip-permissions`, accept, then exit.
6. **Dry run, then launch** from a Herdr pane:

   ```bash
   $PY -m workflow launch my-feature --repo ~/dev/project-B --dry-run
   $PY -m workflow launch my-feature --repo ~/dev/project-B --live --automatic --reviewer-transport print
   ```

   A 2.2.0 launch runs the design challenge before any worker; when it pauses, the launch exits 0 and prints the concerns and the `resume` commands. Otherwise an automatic launch keeps printing the run's timeline in that pane, one line per event (UTC time, node, status, message); a resumed `automatic --live` starts with the last five events. Runs are stored under `~/.local/state/agent-workflows/<repo-name>/<feature>/<run-id>` (`--run-root` overrides; storage must be outside the target). md-manager keeps `~/.local/state/md-manager-workflows/<feature>`.
7. **See it in the Projects viewer.** A live launch adds or updates the target's project in the registry named by `MD_MANAGER_PROJECTS_CONFIG`, else `~/.config/md-manager/projects.json`: project id is the repository name lowercased, the workflow id is the feature, with its runs root and the graph over every lane the feature declares (a `--workers` subset launch registers the same graph). Only that workflow is replaced, and its stored labels are kept while its nodes are unchanged; every other entry keeps its bytes. The file is written atomically under a lock on its directory, so launches in parallel tabs cannot drop each other's entries, and a symlinked registry stays a symlink with its target updated. Runs roots are compared after resolving symlinks, as the server does. A malformed registry blocks the launch before any Git action; a runs root another workflow already covers leaves the file unchanged with a note. The dry run prints the entry it would write. The server reads the registry at startup, so restart it (with `MD_MANAGER_PROJECTS_CONFIG` pointing at the same file) to see a new project.

## Guardrails (feature.json 2.2.0)

`init` writes 2.2.0; a 2.0.0 or 2.1.0 feature (md-manager's existing ones) still launches exactly as before, with the same commands and graph, and the launch prints a note that no guardrail is enforced and how to migrate: set `"version": "2.2.0"`, give every task the three required sections and write `decisions.md`. Runs prepared before the guardrails keep their commands, exports and 1.0.0 completion files unchanged. For a 2.2.0 feature:

- **Outcome briefs.** Every lane task needs `## Goal`, `## Acceptance` and `## Stop`, each with at least one non-blank line before the next `## ` heading (`## Context`, `## Constraints` and `## Process` are optional; three one-line sections are a valid task). `launch` refuses a task that lacks one or leaves one empty, naming the file and the headings, before any Git action. The worker prompt repeats the `## Stop` section as the bound on the work.
- **Decisions.** `features/<feature>/decisions.md` must exist and be non-empty; the `workflow-grill` skill writes it (`## Decisions`, `## Assumptions`, `## Deferred`). It is pinned into `plan.json` at prepare and every worker and reviewer prompt includes it after the task. An optional `prd` in `feature.json` (relative to the target, any format Claude can read, PDFs included) must exist; it is copied into the run for the challenge.
- **Design challenge.** It runs inside `start` and `resume`, not as a LangGraph node: it must decide before any worker session exists, and it pauses and resumes on its own. The exported graph shows it as the first node, `challenge` ("Design challenge"), and every launch depends on it. Before any worker session, one read-only `claude --print` job (Read, Glob and Grep only, a worktree at the base commit) reads the pinned PRD, tasks and decisions and returns concerns (severity P0, P1 or P2, each with its consequence), the strongest simpler alternative and one cheap experiment; the controller validates it against `contracts/workflow/challenge.schema.json` and writes `challenge.json`. Only P2 concerns: `passed`, the workers launch. A P0 or P1: `paused`, no worker is launched, the timeline records the pause and the launch exits 0 printing the concerns and the commands. Then either edit the task files, `decisions.md` or the PRD and run `$PY -m workflow resume "$RUN"` (re-reads them from the paths pinned at prepare, commits them on the run's branch, moves the run to that commit so the source checkout stays clean for integration, updates the plan's copies and reruns the challenge as the next attempt; earlier attempts stay as `challenge-<n>.json`; the policy is never re-pinned; any other change in the source checkout, or a run worktree that is not the clean base, is refused before anything is committed; until the move is pinned, `challenge-revision.json` makes `start` and the override refuse and a rerun continues it), or run `$PY -m workflow resume "$RUN" --accept-challenge "<reason>"` to record `accepted` with the reason and continue without rerunning (refused while a pinned feature file no longer holds the plan's copy, and when the paused attempt read other files than the plan now pins because a later rerun failed). Add `--herdr` to attach the worker panes. `"challenge": false` in `feature.json` records `disabled` and the graph has no challenge node.
- **Completion 1.1.0.** A worker's completion file adds `untested` (behaviours no executed check covers; may be empty), `falsifying_check` (the check id or command that would fail if the work were wrong) and `verify_yourself` (one assumption the operator should verify), plus `question` (null). A `completed` file without the evidence is refused, and a 2.2.0 run refuses a 1.0.0 file; runs prepared before keep reading 1.0.0. The commands actually executed remain the verifier's evidence, not the worker's claim.
- **Questions.** A worker may end its turn with `status: question` and the text in `question`. The controller keeps the file as `<lane>.question-<n>.json`, lists it in `<lane>.questions.json`, records an event and pauses only that lane's deadline (persisted in `<lane>.deadline.json` as `paused_seconds`, so a restarted controller computes the same deadline); the other lanes keep running. Answer with `$PY -m workflow answer "$RUN" <lane> "<text>"`: it records the answer, restarts the deadline and types it into the lane's Herdr pane (`herdr pane send-text`, then Enter); with `--no-herdr` it prints the `claude attach <id>` command to type it yourself. A failed delivery (no Herdr pane, a closed pane) keeps the answer recorded and the deadline running; rerun the same command, or with `--no-herdr`, to deliver it once. Typing the answer straight into the pane works too: the controller records it when the session works again. At most three questions per worker: the prompt says so from the start, and a fourth is treated as `blocked`.

The export (1.5.0) carries all of it for the viewer: `inputs.decisions`, `inputs.challenge` (the latest `challenge.json` without `run_id`/`version`, plus `attempts`), on `inputs.workers.<lane>.completion` its `version`, the three evidence fields (null for a 1.0.0 completion), the `question` status and `question` (the text of a question not recorded yet), and `inputs.workers.<lane>.questions` (`{n, question, asked_at, answer, answered_at}`, `[]` for older runs). A completion is exported only as the controller reads it: a file it refuses (another version, stale or foreign) is null, and a fourth question is exported as `blocked` with its text. The Projects API serves them as run inputs 1.4.0.

### The workflow-grill skill

The interview ships with the tool as a Claude Code skill in `workflow/skills/workflow-grill/SKILL.md`. Link it once into your personal skills so every repository can use it:

```bash
mkdir -p ~/.claude/skills
ln -s "$HOME/dev/md-manager/workflow/skills/workflow-grill" ~/.claude/skills/workflow-grill
```

Then, in Claude Code inside the target repository: `/workflow-grill <feature>`. It reads the PRD and the lane tasks, asks at most five questions one at a time (each with a recommended default and its consequence), resolves or defers anything still open after the fifth, and writes `features/<feature>/decisions.md`. It never writes code.

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

The tests use fake workers and reviewers with real Git worktrees, checks, checkpoints and headless Chromium; they make no Claude model calls. `test_portable.py` covers the portable-workflow scenarios, `test_guardrails.py` the guardrail scenarios (with a fake challenge job and a fake Herdr), `test_browser_rules.py` `check-report` and the browser scenario rules; `testdata/` holds copies of finished features' files the tests read.

## Files

- `launch.py`: target resolution, feature scanning, validation (placeholders, bundled briefs, the 2.2.0 guardrails) and the one-command launch.
- `guardrails.py`: outcome briefs, decisions pinning, the design challenge and `resume`, worker questions, the persisted deadline pause and `answer`. `skills/workflow-grill/`: the interview skill.
- `scaffold.py`: `init`. `registry.py`: the Projects registry entry and its atomic merge.
- `sessions.py`: run preparation (one worktree per selected lane), lane id rules, receipts, locking.
- `interactive.py`: native `claude --bg` launches, Herdr panes (one per lane, reviewers to their right), reconciliation, `attach-one`. `herdr.py`: the Herdr CLI helper.
- `pipeline.py`: the supervised graph over the plan's lanes, freeze/ownership, verification, candidate, review, approval, integration and the CLI.
- `automatic.py`: unattended supervision, completion signals, the native/print reviewers (one per declared reviewer, unanimous verdict); `prompts/review.md` is the built-in brief, `prompts/reviewers/` the bundled ones.
- `verification.py`, `checks.py`: policy validation against the bundled `contracts/workflow/` schemas and isolated check execution; `checks.py` also holds the browser scenario rules that the verifier and `check-report` share.
- `export_state.py`: the versioned `run-state.json` export (1.5.0).
- `worktrees.py`: every `git worktree` change, one at a time per repository, retrying Git's own lock errors.
- `requirements.txt` / `requirements.lock`: bounded Python dependencies, installed separately from the Node application.
