# Depth worker: Assignment reorder and the review diff inline (viewer UX slice S7)

## Goal

An operator reading a run's Assignment tab sees the run's setup in one line and each lane in one table row before any long text, and an operator reading a review sees which files changed and how, inline, without downloading the raw patch. Implement slice S7 of `docs/PRD_VIEWER_UX.md`: section 4.10 (Assignment tab) and the Diff part of section 4.7 (Review) and the Files row of section 7 are the specification; section 11 lists the slice. `decisions.md` in this feature records the operator's decisions.

## Context

- Steps 1 to 5 of the redesign are merged, including S4c's review node sections (`src/projects/node/ReviewSections.tsx`, `ReviewDetail.tsx`). The Assignment tab is `src/projects/Assignment.tsx`, routed at `/runs/<r>/assignment`. Changed files on the launch node are `src/projects/CreatedFiles.tsx`; checks are `src/projects/Checks.tsx`.
- `review.diff` is the diff the review result serves (`contracts/projects/v1.ts`); parse it on the client.
- Fixtures: no module exists for this slice yet. Add `tests/project-workflows/fixtures/ux-depth.ts` in the shape of the other `ux-*.ts` modules and register it last in `UX_FIXTURE_MODULES` in `fixtures/index.ts` (the only change there). Browser helpers, including `attach(page, testInfo, id)`, are in `tests/project-workflows/support.ts`.
- Handoffs of earlier slices: `docs/handoff/ux-*.md` (conventions, red/green evidence format).

## Constraints

- Only edit the paths your lane owns in the pinned policy. Put pure helpers (diff parsing, A/M/D and +/- counts, the assignment summary) in `src/projects/diff.ts` (no React import) and test them in `tests/unit/diff.test.ts` and `tests/unit/assignment.test.ts`.
- Every `assignment-*` test id, the tab roles and keys, and every string `inputs.spec.ts:57-64` asserts stay. `reviewers.spec.ts:86` (five column headers on a multi-valued review) stays green. A migrated assertion changes in the same commit with a one-line reason in the handoff.
- The optional backend fields B5 and B4 of the PRD are out of scope: client only.
- The viewer stays read-only: every button text is one of those listed at the end of PRD 12.3; no button text holds a path or a command.
- If the PRD is ambiguous, choose, record the choice as an open assumption, and keep going.

## Acceptance

- Fixtures in `ux-depth.ts` for both phases: a two-lane run with decisions and setup commands, and a review whose diff adds, modifies and deletes files.
- One browser test per scenario id in `tests/project-workflows/ux-depth.spec.ts`, each title containing `[scenario:<id>]` and attaching `screenshot:<id>`: `assignment-summary-first` and `review-diff-inline`, asserting what the pinned policy describes, in both phases.
- Unit tests for the diff parser (added, modified, deleted, renamed and binary files, and counts) and the assignment summary.
- Red first: run the new tests against the pre-change code and record that they fail for the right reason; then green. Write `docs/handoff/ux-s7.md` with what shipped, both runs and any deviation from the PRD.
- Run targeted tests only: `npm run build`, `npm run lint`, your unit test files, and the browser spec files you added or changed with `WORKFLOW_VERIFICATION_PHASE=worker` and with `WORKFLOW_VERIFICATION_PHASE=candidate`. The verifier runs every policy check. Report exactly what you ran, with results.

## Stop

Finish within the worker deadline. If a check keeps failing after three honest attempts, write the completion with status `blocked`, the exact failing command and output, and what you tried. Do not weaken or delete a test to make it pass.
