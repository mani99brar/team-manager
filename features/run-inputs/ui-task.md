# UI worker: run inputs, worker task panels and finding-to-task links

Extend the Projects viewer (`src/projects/`) so every run and worker node shows what it was given, and each review finding links to the task text it concerns. Contract: `contracts/projects/README.md` (`runInputs`, `runInputsResponse`, `requirement_verbatim`; contract 1.2.0; examples in `contracts/projects/examples.ts`). Read `features/run-inputs/README.md` for the export seam and the seeded-data rules, and the review-result and project-workflows READMEs for everything unchanged. Do not change contracts, policy or package manifests.

## Ownership

Only edit `src/App.tsx`, `src/App.css`, `src/graph/`, `src/projects/`, `src/index.css` and `tests/project-workflows/`. The backend owns `server/` and `config/projects.example.json`. Stop and report anything that needs a change outside ownership. No new package dependencies; `react-markdown` and `remark-gfm` are already available for rendering task text.

## Deliverables

- Fetch `.../runs/{run_id}/inputs` for the selected run, validate with `schemas.runInputsResponse` and `validateRunInputs` when non-null, and keep it in the run view's state. `inputs: null` is an explicit "Inputs were not recorded for this run" state, not an error and not a spinner.
- Run header: feature, base commit, source branch, mode; for automatic runs the worker and review deadlines, permission mode, finish and reviewer transport.
- Run "Assignment" tab: the header facts, setup commands, the verification attempt cap, and each worker's task rendered as Markdown (`react-markdown` with `remark-gfm`, no raw HTML), with the `[task text truncated …]` marker preserved when `task_truncated` is set.
- Worker node "Task" panel: the task rendered as Markdown, owned paths, and the required checks; each check id links to the executed check with the same id in the node's worker result when one exists, and is shown as "not executed" otherwise.
- Worker node launch receipt (session UUID, launch token, requested and native start times, observed state, launcher invocations) replaces "No session recorded" when the receipt exists.
- Worker node "Reported by the worker" panel: completion status, summary and open assumptions; show the handoff separately only when it differs from the completion signal. Show the stop confirmation time in the node timeline when `stopped_at` is set, and "stopped (time not recorded)" when `stopped` is true without a time.
- Findings panel (from slice B): group findings by `worker`; when `requirement_verbatim` is `true`, the quote is a link that opens that worker's Task panel scrolled to the quote with the quote highlighted (`both` links to the first task that contains it); when it is `false` or null, show the quote as plain text with a short note that it was not found verbatim, and never guess a match client-side.
- Everything keyboard-accessible; narrow layout stays usable. No launch, approve, retry or delete controls.

## Browser tests

Extend `tests/project-workflows/`. The policy pins fourteen scenario IDs: the ten from slice B (unchanged in meaning; `paths-redacted` now also asserts over rendered inputs) plus `run-assignment`, `worker-inputs`, `finding-to-task`, `inputs-legacy`. Each ID appears in exactly one test title with one `screenshot:<id>` PNG attachment.

- Worker mode: mock the inputs route with contract-shaped fixtures (one run with inputs, one with `inputs: null`) and review fixtures whose findings carry `requirement_verbatim` true, false and null.
- Candidate mode: seed `run-state.json` `inputs` sections exactly as documented in the feature README, including task text that contains absolute paths under the temporary root and the requirement quotes used by the seeded review (one found verbatim, one not). Do not mock project success responses.
- `finding-to-task`: click a linked quote, assert the Task panel is open, scrolled to the quote and the quote is highlighted; assert the unmatched quote has no link.

Report checks as not executed if you could not execute them. Never weaken or skip a required scenario.

## Finish

Report a concise summary, the complete changed-file list and open assumptions, then follow the appended completion-file protocol and finish your turn. Do not commit, merge, push, spawn agents or write outside your own worktree.
