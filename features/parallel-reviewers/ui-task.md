# UI worker: the review node shows every reviewer of a run

Implement the viewer half of slice B of `docs/PRD_PARALLEL_REVIEWERS.md` (umbrella `docs/PRD_CONFIGURABLE_WORKFLOW.md`). Read PRD section 4, subsection "Export 1.4.0 and projects contract 1.4.0", as the data shape you build against, and the `viewer-two-reviewers` row of section 6 for the browser scenario you own.

## Ownership

Only edit `src/projects/` and `tests/project-workflows/`. The adapter worker owns `workflow/`, `contracts/`, `server/` and `features/project-workflows/`; do not edit them. Do not edit `src/App.tsx`, `src/App.css`, `src/index.css`, `features/parallel-reviewers/`, package manifests, the root Playwright configuration or `docs/`. If a necessary change falls outside ownership, stop and ask the operator rather than crossing the boundary.

## Deliverables

- `ReviewDetail.tsx`: a reviewer strip above the findings table with one entry per reviewer from the review section's `reviewers` list (id, verdict, finding counts by severity, status), a Reviewer column in the findings table, and a filter by reviewer that works alongside the existing group-by-worker toggle. The combined verdict stays the headline; a blocked run says which reviewer blocked or timed out. A review section without `reviewers` never reaches the viewer (the adapter fills a one-entry list named `review` for old exports), so there is one code path; do not add a legacy branch.
- Fixtures in `tests/project-workflows/fixtures.ts` and `seed.ts`: a two-reviewer run at contract 1.4.0 (`general` approved, `coverage` approved with findings, so the union carries both `reviewer` tags and duplicate findings from different reviewers stay separate), a two-reviewer run where one reviewer blocked while the other was superseded, and a legacy single-reviewer export that renders one entry named `review`. Keep the existing runs unchanged so the earlier scenarios stay honest.
- Browser scenario `viewer-two-reviewers` from the policy, in `tests/project-workflows/`, with the same `[scenario:<id>]` title marker and `screenshot:<id>` attachment rules as the existing suite (`workflow/RUNBOOK.md`). Keep every existing scenario passing in both phases.
- Nothing in `src/projects/` may assume a single reviewer or a reviewer named `review`; the review node's session, verdict and links iterate what the section gives them.

## Browser tests and isolation

Read `WORKFLOW_VERIFICATION_PHASE` from the environment exactly as the existing project-workflows suite does: in `worker` phase, mock only `/api/projects/**` from the contract fixtures; in `candidate` phase, seed real run data and start the real combined backend, no mocked project success responses. Choose free ports dynamically, never reuse a running server, clean up owned temporary directories, one Playwright worker. Do not skip tests in candidate mode or weaken assertions.

The adapter worker changes the projects contract to 1.4.0 in parallel with you, following the shape in the PRD. Build your fixtures from that description; if the shape as described is not enough to render a scenario, stop and ask the operator rather than inventing a field. Your isolated worker-phase build and browser checks are expected to fail until the adapter's contract change is present; they are recorded there and gated at the combined candidate, where both lanes are verified together. The unit check gates in both phases.

No new dependencies are authorized. Manual mode disables shell tools; automatic mode grants Bash. The trusted verifier independently runs your build, unit and browser checks after handoff. Report checks as not executed if you could not execute them; never claim success from inspection.

## Finish

Report a summary, all changed files, checks actually executed (or explicitly none) and open assumptions. In manual mode wait for the operator to freeze. In automatic mode follow the appended completion-file protocol and finish your turn without waiting for a human. Do not commit, push, merge, launch other agents or write outside your own worktree. Do not edit shared contracts or fixtures outside your ownership to make tests pass.
