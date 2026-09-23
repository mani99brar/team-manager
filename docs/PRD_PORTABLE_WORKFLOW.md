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

### 4.3 Slice 2: which features the guardrails apply to

The guardrails apply to features at `feature.json` 2.2.0, which `init` writes from slice 2 on. A 2.1.0 feature (md-manager's existing ones) still launches as today, with a note that no guardrail is enforced and how to migrate. Resuming, retrying and exporting runs are never affected. 2.2.0 adds two optional fields: `challenge` (boolean, default true) and `prd` (a path relative to the target, read by the challenge).

For a 2.2.0 feature, launch refuses before any Git action:

- a lane task without non-empty `## Goal`, `## Acceptance` and `## Stop` sections (a heading followed by at least one non-blank line before the next `## `), naming the file and the missing headings;
- a feature directory without a non-empty `decisions.md`;
- a `prd` that does not exist in the target.

`decisions.md` is pinned into `plan.json` at prepare like the task text, and every worker and reviewer prompt includes it after the task.

### 4.4 Slice 2: the interview skill

The skill ships with the tool at `workflow/skills/workflow-grill/SKILL.md`, and the README says how to link it once into `~/.claude/skills/`. It interviews the operator about the feature named in its argument: it reads the PRD and the lane tasks, asks at most five questions one at a time, each with a recommended default and its consequence, then writes `features/<feature>/decisions.md` with three sections: `## Decisions`, `## Assumptions` and `## Deferred`. It never writes code, and it resolves or defers anything still open after the fifth question.

### 4.5 Slice 2: challenge node

`challenge` is the first node of a 2.2.0 run's graph: kind `review`, label "Design challenge", `depends_on: []`. Every launch node depends on it. A run whose feature sets `challenge: false`, and every 2.1.0 run, has no challenge node, so its graph is unchanged. `export_state.graph_nodes` takes the flag from the plan.

The challenge runs inside `start`, before any worker session is launched. It is one `claude --print` job with Read, Glob and Grep only, run in a read-only worktree at the base commit, using the existing print-job runner, with its output validated against `contracts/workflow/challenge.schema.json`. The controller writes `challenge.json` in the run directory:

```json
{
  "version": "1.0.0",
  "run_id": "…",
  "status": "passed | paused | accepted | disabled",
  "attempt": 1,
  "session_id": "…",
  "pinned": { "tasks_sha256": "…", "decisions_sha256": "…", "prd_sha256": "… or null" },
  "concerns": [
    { "severity": "P0 | P1 | P2", "kind": "assumption | failure_mode | complexity | other", "message": "…", "consequence": "…" }
  ],
  "simpler_alternative": "…",
  "cheap_experiment": "…",
  "accepted_reason": null,
  "decided_at": "…"
}
```

No P0 or P1 concern: `status` is `passed`, and `start` launches the workers. A P0 or P1: `status` is `paused`, no worker is launched, the timeline records the pause, and the launch exits 0 with the concerns and the resume commands printed. `python -m workflow resume <run>` re-reads the task files, `decisions.md` and the PRD from the paths pinned at prepare, updates the plan's pinned copies, and reruns the challenge as the next attempt. `resume <run> --accept-challenge "<reason>"` records `accepted` with the reason and continues without rerunning. The policy is never re-pinned; changing it needs a new run. `disabled` is written when the feature turns the challenge off. Earlier attempts are kept as `challenge-<attempt>.json`.

### 4.6 Slice 2: completion 1.1.0 and questions

The worker completion file moves to version `1.1.0`:

```json
{
  "version": "1.1.0", "run_id": "…", "node_id": "…", "launch_token": "…",
  "status": "completed | blocked | question",
  "summary": "…", "open_assumptions": ["…"],
  "untested": ["…"], "falsifying_check": "…", "verify_yourself": "…",
  "question": null
}
```

For `completed`, `untested` is a list (it may be empty), and `falsifying_check` and `verify_yourself` are non-empty. For `question`, `question` is non-empty and the evidence fields may be empty. A 1.0.0 file is still read for runs that were prepared before slice 2, and only for them: a run pinned at 1.1.0 refuses a 1.0.0 file.

On `question`, the controller moves the file to `<node>.question-<n>.json`, appends `{n, question, asked_at}` to `<node>.questions.json`, records an event and pauses that worker's deadline. The pause is persisted: `paused_seconds` accumulates in `<node>.deadline.json`, so a controller restart computes the same deadline. `python -m workflow answer <run> <node> "<text>"` checks that the node's latest question is unanswered, records `{answer, answered_at}`, and delivers the text to the worker's Herdr pane (`herdr pane send-text` and then Enter). With `--no-herdr` it prints the `claude attach <id>` command for the operator to type the answer. The deadline restarts when the answer is recorded. A fourth question is treated as `blocked`, and the worker prompt says so from the start.

### 4.7 Slice 2: the export seam (both lanes build against exactly this)

The export moves to `1.5.0`, and the served run inputs to `contract_version` `1.4.0`. Every addition is nullable or an empty list, so older exports stay valid:

- `inputs.decisions`: the pinned `decisions.md` text, or `null`.
- `inputs.challenge`: the latest `challenge.json` without `run_id` and `version`, plus `attempts` (an integer), or `null`.
- `inputs.workers.<lane>.completion` gains `untested` (a list of strings or `null`), `falsifying_check` (a string or `null`) and `verify_yourself` (a string or `null`). Its `status` enum gains `question`. A 1.0.0 completion serves the three as `null`.
- `inputs.workers.<lane>.questions`: a list of `{n, question, asked_at, answer, answered_at}`, where `answer` and `answered_at` are `null` while unanswered. It is `[]` for older runs.
- The definition's challenge node is `{node_id: "challenge", label: "Design challenge", kind: "review", depends_on: []}`.

`contracts/projects/v1.ts` and `server/projects.ts` pass these through unchanged. The ui lane builds its fixtures from this section, not from the controller lane's worktree.

### 4.8 Slice 2: viewer

- The challenge node's page shows the status, the concerns grouped by severity, each with its consequence, the simpler alternative, the cheap experiment, the attempt count, and the accepted reason when there is one. Its executor reads "one print job".
- The launch node shows the three evidence fields under the completion. `falsifying_check` links to that check on the verify node when it names a check id. A 1.0.0 completion says the evidence was not recorded for this run. Questions are listed with their answers and times, and an unanswered question is marked as waiting on the operator.
- The Assignment page shows `decisions.md` rendered as Markdown.
- All run-served Markdown (captured files and decisions) renders with images and external links inert: no remote fetch, and links shown as text. This closes the open follow-up from the viewer-clarity review.

## 5. Work items

### Slice 1 (feature `portable-workflow`, one lane `controller`)

1. `--repo` and the cwd rule in `launch.py`; feature scanning; remove `FEATURES`; target-keyed default run root.
2. Drop the pin requirement for `contracts/workflow/workerResult.schema.json` in the target; absolute schema paths in the worker and reviewer prompts; remove md-manager wording.
3. Registry auto-registration on live launch; entry printed on dry run; golden entry plus Python and contract tests.
4. `workflow init`; bundled `general` and `coverage` briefs under `workflow/prompts/reviewers/` and `builtin:<id>` resolution.
5. Trimming as in section 2; test fixtures moved to `workflow/testdata/`.
6. Docs folded into README and RUNBOOK, with a "Use it in another project" section that walks through `init`, `--repo`, the registry and the one-time `claude --dangerously-skip-permissions` acceptance.

### Slice 2 (feature `workflow-guardrails`, lanes `controller` and `ui`)

1. controller: feature 2.2.0 schema and validation (brief headings, `decisions.md`, `prd`); `init` writes 2.2.0 with a `decisions.md` placeholder; decisions pinned and included in the prompts.
2. controller: `workflow/skills/workflow-grill/SKILL.md`.
3. controller: the challenge node, `challenge.schema.json`, the pause, `resume` with the re-pin, and `--accept-challenge`.
4. controller: completion 1.1.0, the `question` status, `workflow answer`, the persisted deadline pause, and delivery through the pane.
5. controller: export 1.5.0, served inputs 1.4.0 (section 4.7), with contracts, server pass-through and tests.
6. ui: the challenge node page, completion evidence, questions, decisions on the Assignment page, inert Markdown, fixtures and browser scenarios.

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

### Slice 2

| Scenario id | Lane | Asserts |
| --- | --- | --- |
| brief-headings | controller (unit) | a 2.2.0 task missing `## Stop`, or with an empty `## Acceptance`, is refused, naming the file and headings; three one-line sections pass; a 2.1.0 feature launches with the migration note |
| decisions-required | controller (unit) | a 2.2.0 feature without `decisions.md` is refused before Git; its text is pinned in the plan and appears in every worker and reviewer prompt |
| challenge-passes | controller (unit) | a fake challenge with only P2 concerns writes `passed`, and workers launch after it; the graph starts with the challenge node; `challenge: false` writes `disabled` with no node |
| challenge-pauses | controller (unit) | a P1 concern writes `paused`, launches no worker session, and exits 0; `resume` after editing a task re-pins it and reruns as attempt 2, keeping `challenge-1.json`; `--accept-challenge "r"` records `accepted` with the reason and launches the workers |
| completion-evidence | controller (unit) | a 1.1.0 `completed` file without `falsifying_check` or `verify_yourself` is refused; a valid one is exported with the three fields; a run pinned before slice 2 still accepts 1.0.0 and exports `null`s |
| worker-question | controller (unit) | a `question` completion pauses only that lane's deadline, which survives a controller restart; `answer` records and delivers it (a fake Herdr receives send-text then Enter), and the deadline resumes; a fourth question blocks |
| export-seam | controller (contract) | a 1.5.0 export with decisions, challenge, evidence and questions validates and serves as inputs 1.4.0; a 1.4.0 export serves `null`s and `[]` |
| served-inputs | controller (server) | `server/projects.test.ts` serves the new fields and keeps older runs valid |
| challenge-node-page | ui (browser) | the seeded run's graph starts with "Design challenge"; its page shows the status, the concerns by severity with consequences, the alternative, the experiment and an accepted reason |
| completion-evidence-shown | ui (browser) | the launch node shows untested, falsifying check (linked to the verify node's check) and verify-yourself; the legacy run says evidence was not recorded |
| worker-questions-shown | ui (browser) | answered and waiting questions are listed with times; the waiting one is marked |
| decisions-shown | ui (browser) | the Assignment page renders decisions.md; a run without it says so |
| inert-markdown | ui (browser) | a captured Markdown file and decisions.md with a remote image and an external link make no network request, and the link renders as text |

### Slice 3

Listed in its own feature directory once the spec PDF is in place.

## 7. Open questions

- Whether `init` should also write a starter `.gitignore` entry for run artifacts. Default: no; runs live outside the target.
- Whether the challenge should also run on a retry after verification failures. Default: no; it runs once per run, and again only on `resume` after an edit.
- Reusing a lane's worker-phase check results at the candidate phase when the candidate's tree equals that lane's snapshot tree (single-lane runs). It would save one full test run per single-lane run, but it changes the verifier's evidence format and gate, so it gets its own slice after slice 2 rather than a patch.
- Whether `decisions.md` should be versioned per run rather than per feature. Default: per feature; the run pins its hash like the other feature files.

## 8. How to run

Slice 2, from md-manager's main checkout after slice 1 is on main, in a new Herdr tab:

```
ANTHROPIC_MODEL=claude-opus-5-5 .venv/bin/python -m workflow launch workflow-guardrails --live --automatic --reviewer-transport print --worker-timeout-seconds 7200 --review-timeout-seconds 3600
```

Slice 1, from md-manager's main checkout in a new Herdr tab, with two print reviewers (this run is also the live smoke test of the print transport, which no run has exercised yet):

```
ANTHROPIC_MODEL=claude-opus-5-5 .venv/bin/python -m workflow launch portable-workflow --live --automatic --reviewer-transport print --worker-timeout-seconds 5400 --review-timeout-seconds 3600
```

On integration, fast-forward main to the feature branch. Then write the slice 2 feature against the new code, and slice 3 once the spec PDF is in place.
