# PRD: Run inputs and finding-to-task links in the viewer (slice C)

Status: Pre-run work done 2026-09-21 (contract 1.2.0 `runInputs`, export `inputs` section, feature directory `features/run-inputs/`); the feature run waits for slice B's run to merge. See [HANDOFF_REVIEW_VISIBILITY.md](HANDOFF_REVIEW_VISIBILITY.md). Umbrella: [PRD_REVIEW_VISIBILITY.md](PRD_REVIEW_VISIBILITY.md). Depends on slice B, because the finding-to-task link needs the findings panel.

## 1. Goal

Every run and every worker node shows its inputs: what the worker was asked to do, under what rules, and what it reported back. Each review finding links to the task text it relates to, so a reader can judge whether a finding is about something the worker was actually asked to do.

Success: on a worker node, a reader sees the task, owned paths and checks beside the executed checks; on the review node, clicking a finding's requirement quote opens that worker's task scrolled to the quote.

## 2. Confirmed decisions

- Findings link to tasks through the `worker` and `requirement` fields the reviewer already fills in (slice A). A quote that is not found verbatim is shown without a link; the adapter never guesses a match.
- `workflow export <run>` (slice B) re-exports old runs, so project-workflows-001 gains an Assignment view after this merges.

## 3. Pre-run work (ours, before `prepare`)

| Where | Change |
| --- | --- |
| `contracts/projects` | new `runInputs` type: feature, base_commit, source_branch, mode, automatic settings, per-worker task, owned_paths, checks, launch receipt, completion, handoff. Version 1.2.0, additive |
| `contracts/projects/examples.ts`, `contract.test.ts` | fixtures including a run with `inputs: null` |
| `workflow/export_state.py` | `inputs` section in `run-state.json` from `plan.json`, `policy.json`, launch receipts, completion, handoff and stop files. Export version 1.2.0 |
| `workflow` tests | export and re-export tests extended for `inputs` |

## 4. What is shown

| Input | Producer file | Shown where |
| --- | --- | --- |
| Feature name, base commit, source branch, mode | `plan.json` | run header |
| Automatic settings: deadlines, permission mode, finish | `plan.automatic` | run header, automatic runs only |
| Task text per worker, rendered as Markdown | `plan.nodes.<worker>.task` | worker node "Task" panel; run "Assignment" tab |
| Owned paths and required checks | `policy.json` | worker node beside the task; check ids link to executed checks |
| Setup commands and attempt cap | `policy.json` | Assignment tab |
| Launch receipt: session UUID, requested and native start time, observed state | `<worker>.interactive.json` | worker node, replaces "No session recorded" |
| Completion signal: status, summary, open assumptions | `<worker>.completion.json` | worker node "Reported by the worker" |
| Handoff as accepted | `<worker>.handoff.json` | worker node, only when it differs from the completion signal |
| Stop confirmation time | `<worker>.stop.json` | worker node timeline |

Rules: task text is the exact prompt the worker received, including the appended policy JSON; absolute paths pass through `redactPaths`; reads are bounded and oversized task text is truncated with a marker; inputs are pinned per run from the run's own files.

## 5. Worker assignments

Feature directory `features/run-inputs/`, same roles and ownership.

| Worker | Owned paths | Deliverables | Checks |
| --- | --- | --- | --- |
| adapter | `server/`, `config/projects.example.json` | `.../runs/<run>/inputs` route from the export's `inputs` section; redaction and bounded reads; `inputs: null` for runs without the section; requirement-quote lookup exposed as a verbatim match flag per finding | `backend-unit`, `backend-regression`, `shared-contract`, `backend-build` |
| ui | `src/App.tsx`, `src/App.css`, `src/graph`, `src/projects`, `src/index.css`, `tests/project-workflows` | Assignment tab on the run; Task and Reported-by-worker panels on worker nodes; findings grouped by worker with requirement quotes that open the Task panel scrolled to the quote; mocks and seeds | `frontend-build`, `frontend-unit-regression`, `project-workflows-browser` |

## 6. Acceptance scenarios

| Scenario id | Asserts |
| --- | --- |
| run-assignment | the Assignment tab shows feature, branch, mode, deadlines, setup commands and both workers' tasks rendered as Markdown |
| worker-inputs | a worker node shows its task, owned paths, required checks linked to executed checks, launch receipt and completion signal |
| finding-to-task | a finding with a verbatim requirement quote links to the worker's Task panel and the quote is highlighted there; a finding whose quote is not found shows the quote without a link |
| inputs-legacy | a seeded run without the `inputs` section shows "inputs not recorded" and no error |
| paths-redacted | no absolute path from the seeded fixtures appears in the rendered inputs |

## 7. Open questions

- Task display: decided for the export, the assignment text as prepared (task file plus the appended policy JSON block); the controller's fixed preamble and completion-protocol sentences are generated per launch and are not exported. The viewer renders that text.
- Measure the verbatim match rate of requirement quotes on this run before deciding whether fuzzy matching is worth building.

## 8. How to run

```bash
.venv/bin/python -m workflow launch run-inputs --live --automatic --worker-timeout-seconds 7200
```

Add `run-inputs` to the feature choices in `workflow/launch.py` first.
