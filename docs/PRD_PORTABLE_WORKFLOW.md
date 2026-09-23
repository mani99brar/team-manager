# PRD: Portable workflow with enforced guardrails

Status: Proposed 2026-09-23, after viewer clarity (`054d149`). Decisions confirmed in the grill session of 2026-09-23. Ships as three slices. Slices 1 and 2 are feature runs of the workflow on md-manager itself; slice 3 is the first run on another repository (`~/dev/project-B`).

## 1. Goal

The LangGraph workflow in `workflow/` can drive any git repository, not only md-manager, and it enforces a small set of working rules on every run: tasks written as outcome briefs, an interview before launch, a design challenge before any worker starts, and completion evidence that says what would prove the work wrong. Legacy code and documents that no future project needs are removed on the way.

Success:

- From md-manager's checkout, `.venv/bin/python -m workflow launch <feature> --repo ~/dev/project-B --live --automatic` runs a feature defined in `~/dev/project-B/features/<feature>/`, stores the run under `~/.local/state/agent-workflows/project-B/<feature>/`, and the run appears in the Projects viewer without editing the registry by hand.
- `workflow init <feature> --repo X` writes a feature directory that fails validation until its placeholders are filled in, and passes once they are.
- A lane task missing `## Goal`, `## Acceptance` or `## Stop` is refused at launch.
- A design challenge with a P0 or P1 pauses the run before any worker is launched.
- A worker completion without `untested`, `falsifying_check` and `verify_yourself` is refused.
- md-manager's existing commands, run directories and exports keep working unchanged.

## 2. Confirmed decisions

### Portability (slice 1)

- **The controller stays in md-manager.** `workflow/` keeps its tests and drives other repositories. No new package or repository.
- **Target selection.** `--repo PATH` selects the target. Without it, the current directory is used when it is a git repository with a `features/` directory; otherwise the target is md-manager itself, so every existing command keeps working. The target is recorded in `plan.json` (`repository`, already present), so `automatic`, `retry`, `status` and `export` need no flag.
- **Feature definitions live in the target**, at `<target>/features/<name>/`, found by scanning. The hardcoded `FEATURES` tuple is removed; `launch` accepts any directory name under `<target>/features/` that holds a `feature.json`.
- **Schemas are bundled with the tool.** The verifier already loads them from the tool's own `contracts/workflow/`. The pin step stops requiring `contracts/workflow/workerResult.schema.json` in the target's revision (`workflow/sessions.py:187`). Prompts give workers and reviewers the absolute path of the tool's schema instead of "in this checkout".
- **Run storage is keyed by repository name** for new projects: `~/.local/state/agent-workflows/<repo-name>/<feature>/<run-id>`. md-manager keeps `~/.local/state/md-manager-workflows/<feature>`, so its runs and registry entries stay valid. `--run-root` still overrides.
- **Auto-registration.** A live launch adds or updates the target's project entry in the Projects registry: the file named by `MD_MANAGER_PROJECTS_CONFIG`, else `~/.config/md-manager/projects.json`. It adds the workflow for the feature with its `runs_root` and a definition built by `export_state.definition`, written atomically, and never removes or rewrites other entries. A dry run prints the entry it would write.
- **Scaffolding.** `workflow init <feature> [--repo X]` writes `features/<feature>/` with a 2.1.0 `feature.json`, a `policy.json` with placeholder checks, one lane task template in outcome-brief form, a `README.md`, and a starter `CLAUDE.md` in the target root if none exists. Placeholders (`TODO:`) make launch validation fail with a message naming each one. `init` never overwrites an existing file.
- **Bundled reviewer briefs.** Generic `general` and `coverage` briefs move to `workflow/prompts/reviewers/`, with md-manager specifics removed. A feature's reviewer entry names either a file in its own directory or a bundled brief (`"prompt": "builtin:general"`).
- **Project conventions** come from the target's `CLAUDE.md`, which worker sessions read because they start in the target's worktree, plus the task text. The md-manager wording in the prompts is removed.

### Trimming (slice 1)

- The feature.json 1.0.0 translation (`ui_task`/`adapter_task`, `DEPRECATED_FEATURE_NOTE`) is removed. 1.0.0 files are refused with a message to use 2.x.
- `workflow/observer.py` and the read-only observer panes are removed. The `herdr` helper moves to its own small module. The standalone `python -m workflow.interactive` flow (`prepare`, `run`, `status`, `attach`, `--reuse-observers`) is removed wherever nothing reachable from `python -m workflow` uses it; `attach-one`, which automatic panes run, stays.
- The finished feature directories `features/project-workflows`, `features/worker-lanes`, `features/parallel-reviewers` and `features/parallel-reviewers-align` are deleted. Tests that read their policies or manifests get copies under `workflow/testdata/`. Their runs and exports under `~/.local/state` are untouched and stay viewable.
- The workflow docs become two files: `workflow/README.md` (what it is, the commands, "Use it in another project") and `workflow/RUNBOOK.md` (procedures, recovery, bounds). `CHEATSHEET.md`, `LIVE_SESSIONS.md`, `INTERACTIVE_SESSIONS.md`, `VALIDATION.md` and `VERIFICATION.md` are folded in and deleted.
- Kept on purpose: the export's handling of legacy runs (`carry_legacy_lanes`, the `both` attribution), the manual operator commands, and every existing run directory.

### Guardrails (slice 2)

- **Outcome brief.** Every lane task must contain the headings `## Goal`, `## Acceptance` and `## Stop`. `## Context`, `## Constraints` and `## Process` are optional. Launch refuses a task that lacks a required heading or has one with an empty body. A short task stays short: three headings with a line each is valid.
- **Interview before launch.** A `workflow-grill` Claude skill interviews the operator about uncertainties that could change the design or acceptance: at most five questions, one at a time, each with a recommended default and its consequence. It then writes `features/<feature>/decisions.md` with the decisions, the remaining assumptions and anything deferred. Launch refuses a feature without a non-empty `decisions.md`, and every worker and reviewer prompt includes it.
- **Questions mid-run.** A worker may also end its turn with completion status `question` and a `question` text. The controller records an event, pauses that worker's deadline and keeps the other lanes running. The operator answers with `workflow answer <run> <node> "<text>"` (or types in the pane); the controller sends the answer into the worker's session and restarts the deadline. At most three questions per worker; after the third, the prompt tells the worker to decide and record an open assumption, and a fourth `question` is treated as `blocked`.
- **Design challenge node.** A new graph node `challenge` runs after preparation and before any worker launch. One print session reads the PRD named by the feature, the tasks and `decisions.md`, and writes `challenge.json`: fragile assumptions, the strongest simpler alternative, likely failure modes, one cheap experiment that could change the choice, each concern tied to a concrete consequence with a severity. No P0 or P1: the run continues. A P0 or P1: the run pauses at the node, and the viewer shows the concerns. The operator edits the feature files and runs `workflow resume <run>`, which re-pins the feature files and reruns the challenge; or `workflow resume <run> --accept-challenge "<reason>"` records the override and continues. A feature can turn the node off with `"challenge": false` in `feature.json`.
- **Completion evidence.** The worker completion file moves to version `1.1.0` with three required fields: `untested` (behaviours not covered by any executed check), `falsifying_check` (the check that would fail if the implementation were wrong, by check id or command) and `verify_yourself` (one assumption the operator should verify independently). `1.0.0` completions of old runs remain readable. The commands actually executed stay the verifier's evidence, not the worker's claim. The viewer shows the three fields on the launch node.
- **Worker contract.** Already enforced and unchanged: owned paths, independent checks, open assumptions, `blocked`, deadlines and bounded verification attempts. The task's `## Stop` section supplies the bound the prompt repeats to the worker.

### Cross-project smoke (slice 3)

- The target is `~/dev/project-B`, currently empty. The operator shares a spec PDF, saved as `~/dev/project-B/docs/spec.pdf`. The first run builds only the project's skeleton from that spec.
- The slice seeds `git init`, a first commit with the spec, a `CLAUDE.md` and a `features/` directory made with `workflow init`, then goes through the full slice 2 flow: grill, challenge, outcome-brief tasks, print reviewers, and completion 1.1.0.

## 3. Configuration

- `feature.json` stays at 2.1.0 in slice 1. Slice 2 moves it to `2.2.0` with an optional `challenge` (boolean, default true) and an optional `prd` (path, relative to the target, read by the challenge). 2.1.0 files are still accepted and behave as `challenge: true` with no PRD.
- A reviewer `prompt` is a feature-relative file path or `builtin:<id>` for a bundled brief.
- Default run root for targets other than md-manager: `~/.local/state/agent-workflows/<repo-name>/<feature>`. `<repo-name>` is the target directory's name, restricted to `[A-Za-z0-9._-]`.
- Registry file: `MD_MANAGER_PROJECTS_CONFIG`, else `~/.config/md-manager/projects.json`. `project_id` is the repository name, lowercased; `name` is the repository name.

## 4. Design notes

### 4.1 Slice 1: target selection and scanning

`workflow/launch.py` resolves the target first (flag, then cwd rule, then the tool's own repository), then the feature folder under `<target>/features/`. `argparse` no longer uses `choices`; an unknown feature is refused with the list of feature directories found. The commands it builds already pass `--repo` to `preflight` and `prepare`; they receive the target, and `git switch -c` runs with `cwd=<target>`. The Herdr panes keep using the tool's directory for the `python -m workflow` commands they run, which is correct: it locates the tool, not the target.

The rule that run storage is outside the repository applies to the target.

### 4.2 Slice 1: registry entry

A pure function builds the entry from the target, feature, runs root and lanes; a separate function merges it into the registry document and writes it atomically. Merging replaces only the workflow with the same `workflow_id` (the feature name) under the same `project_id`, and adds the project if absent. A golden example of the entry is checked in as `contracts/workflow/examples/registry-entry.json`; the Python test compares the builder's output with it, and the contract test parses it with the server's registry schema (`server/projectsConfig.ts`) so both sides agree.

### 4.3 Slice 2: challenge node

`challenge` is a node of kind `review` in the stored definition, labelled "Design challenge", placed between preparation and the launch nodes. It uses the print transport and the existing `claude --print` job runner, with Read, Glob and Grep only. `challenge.json` has its own schema, `contracts/workflow/challenge.schema.json`. The viewer shows it with the existing review components where they fit; its executor label reads "one print job".

### 4.4 Slice 2: questions and deadlines

The deadline pause is persisted: the controller records `paused_at` and the accumulated pause time per worker in the run directory, so a controller restart keeps the correct deadline. `workflow answer` validates the run, the node, and that the node's latest completion is an unanswered `question`, writes `<node>.answer.json`, and the controller delivers it into the native session.

## 5. Work items

### Slice 1 (feature `portable-workflow`, one lane `controller`)

1. `--repo` and the cwd rule in `launch.py`; feature scanning; remove `FEATURES`; target-keyed default run root.
2. Drop the pin requirement for `contracts/workflow/workerResult.schema.json` in the target; absolute schema paths in the worker and reviewer prompts; remove md-manager wording.
3. Registry auto-registration on live launch; entry printed on dry run; golden entry plus Python and contract tests.
4. `workflow init`; bundled `general` and `coverage` briefs under `workflow/prompts/reviewers/` and `builtin:<id>` resolution.
5. Trimming as in section 2; test fixtures moved to `workflow/testdata/`.
6. Docs folded into README and RUNBOOK, with a "Use it in another project" section that walks through `init`, `--repo`, the registry and the one-time `claude --dangerously-skip-permissions` acceptance.

### Slice 2 (feature to be written after slice 1 lands)

1. Outcome-brief validation and the `init` template in brief form.
2. The `workflow-grill` skill, `decisions.md` enforcement and its inclusion in prompts.
3. The `challenge` node, schema, pause, `resume` re-pin and `--accept-challenge`.
4. Completion 1.1.0 and the `question` status with `workflow answer` and the persisted deadline pause.
5. Viewer: challenge node, completion evidence fields and question events.

### Slice 3 (after slice 2, needs the spec PDF)

1. Seed `~/dev/project-B` and write its skeleton feature with `init`, the grill and the brief.
2. Run it with `--repo ~/dev/project-B --reviewer-transport print`.

## 6. Acceptance scenarios

### Slice 1

| Scenario id | Asserts |
| --- | --- |
| repo-flag | `launch <feature> --repo <tmp target> --dry-run` resolves the feature from the target's `features/`, passes the target to `preflight` and `prepare`, and uses `~/.local/state/agent-workflows/<name>/<feature>` as the run root |
| cwd-target | with no `--repo`, a cwd that is a git repository with `features/` is the target; any other cwd falls back to the tool's repository; `--repo` wins over cwd |
| feature-scan | an unknown feature name is refused with the list found; a directory without `feature.json` is not listed; md-manager's `viewer-clarity` still launches by name |
| no-target-schema | preflight and prepare succeed on a target that has no `contracts/` directory; verification validates results against the tool's bundled schemas |
| md-manager-defaults | a launch without `--repo` from md-manager produces the same commands and run root as before, apart from the removed tuple |
| registry-entry | a dry run prints the entry; a live-launch registration adds a new project, updates only its own workflow on a second launch, keeps other projects byte-identical, and writes atomically; the golden entry parses with the server's registry schema |
| init-scaffold | `init` writes the listed files, refuses to overwrite, creates `CLAUDE.md` only when missing; launch refuses the scaffold and names every `TODO:` placeholder; filling them makes the dry run pass |
| builtin-briefs | `"prompt": "builtin:general"` resolves to the bundled brief; an unknown `builtin:` id is refused before any git action |
| legacy-feature-refused | a 1.0.0 `feature.json` is refused with a message to use 2.x |
| trimmed | `workflow/observer.py` and the five folded docs are gone; the four finished feature directories are gone; the unit suite passes with fixtures from `workflow/testdata/`; old runs still export |

### Slice 2 and slice 3

Listed in their own feature directories when they are written, from section 2 and section 5.

## 7. Open questions

- Whether `init` should also write a starter `.gitignore` entry for run artifacts. Default: no; runs live outside the target.
- Whether the challenge should also run on a retry after verification failures. Default: no; it runs once per run, and again only on `resume` after an edit.
- Whether `decisions.md` should be versioned per run rather than per feature. Default: per feature; the run pins its hash like the other feature files.

## 8. How to run

Slice 1, from md-manager's main checkout in a new Herdr tab, with two print reviewers (this run is also the live smoke test of the print transport, which no run has exercised yet):

```
ANTHROPIC_MODEL=claude-opus-5-5 .venv/bin/python -m workflow launch portable-workflow --live --automatic --reviewer-transport print --worker-timeout-seconds 5400 --review-timeout-seconds 3600
```

On integration, fast-forward main to the feature branch. Then write the slice 2 feature against the new code, and slice 3 once the spec PDF is in place.
