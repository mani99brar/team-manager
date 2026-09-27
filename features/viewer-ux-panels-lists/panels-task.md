# Panels worker: review, challenge and controller pages (viewer UX slice S4c)

## Goal

An operator who opens a review, challenge, handoff, approval or integrate node in the Projects viewer sees in the first screen what was decided, what blocks, how long it took and what to do next, without scanning a table. Implement slice S4c of `docs/PRD_VIEWER_UX.md`: section 4.7 (Review), 4.8 (Challenge) and 4.9 (Handoff, approval, integrate) are the specification; section 11 lists the slice; sections 12.2 and 12.3 are its tests. `decisions.md` in this feature records the operator's decisions.

## Context

- Steps 1 to 4 of the redesign are merged: the node shell (`src/projects/NodeDetail.tsx` dispatcher, `NodeHeader.tsx`, `SectionIndex.tsx`, `useRunData.ts`) and the per-kind section files in `src/projects/node/`. You fill in `node/ReviewSections.tsx`, `node/ChallengeSections.tsx` and `node/ControllerSections.tsx`; the header, attempt strip and `node-next` already come from the shell.
- Time: use `time.ts` (`formatClock`, `formatAgo`, `formatSpan`, `spanBetween`), `Time.tsx` and `useNow`. The next action and commands come from `deriveNow` in `contracts/projects/triage.ts` and `CommandBlock.tsx`; read them, do not edit them.
- Fixtures: `tests/project-workflows/fixtures/ux-review.ts` is an empty module already registered by `fixtures/index.ts` (read that file for the payload and `seed` shape, and `ux-verify.ts` or `ux-launch.ts` for a filled example). Browser helpers, including `attach(page, testInfo, id)`, are in `tests/project-workflows/support.ts`.
- Handoffs of earlier slices: `docs/handoff/ux-s4core.md`, `ux-s4a.md`, `ux-s4b.md` (conventions, red/green evidence format).

## Constraints

- Only edit the paths your lane owns in the pinned policy. The `lists` lane owns `ProjectsView.tsx`, `api.ts`, `NowBanner.tsx`, `CommandBlock.tsx`, `LiveStatus.tsx`, `projects.spec.ts` and the list files; do not edit them or read its worktree. Put pure helpers in `src/projects/node/panels.ts` (no React import: the unit tests import it) and their tests in `tests/unit/panels.test.ts`, which the `test:unit` glob already collects.
- The viewer stays read-only: every button text is one of those listed at the end of PRD 12.3, and no button text holds a path or a command. Keep `expectNoExecutionControls` green.
- Keep every existing scenario passing, in particular `reviewers.spec.ts:86` (all five findings column headers on a multi-valued review) and `review.spec.ts`.
- Durations and deadlines only from served fields (PRD 4.7: `reviewers[].launched_at` plus `inputs.automatic.review_timeout_seconds`, shown with `≈`; nothing when `launched_at` is null). Never invent a time.
- If the PRD is ambiguous, choose, record the choice as an open assumption, and keep going.

## Acceptance

- Fixtures in `ux-review.ts` for both phases: a native review with one running reviewer and one approved, a print review blocked by a P1, a challenge that passed on attempt 3 with P2 notes, a paused challenge with one P1, and a succeeded approval with no event beside a handoff with launch receipts.
- One browser test per scenario id in `tests/project-workflows/ux-review.spec.ts`, each title containing `[scenario:<id>]` and attaching `screenshot:<id>`: `review-blocking-first`, `challenge-headline`, `controller-panels`, asserting what the pinned policy describes, in both phases.
- Unit tests for the pure helpers (deadline and duration, headline wording, wait from receipts).
- Red first: run the new tests against the pre-change code and record that they fail for the right reason; then green. Write `docs/handoff/ux-s4c.md` with what shipped, both runs and any deviation from the PRD.
- Run targeted tests only: `npm run build`, `npm run lint`, `npx tsx --test tests/unit/panels.test.ts`, and the browser spec files you added or changed with `WORKFLOW_VERIFICATION_PHASE=worker` and with `WORKFLOW_VERIFICATION_PHASE=candidate`. The verifier runs every policy check on your snapshot and on the combined candidate. Report exactly what you ran, with results.

## Stop

Finish within the worker deadline. If a check keeps failing after three honest attempts, write the completion with status `blocked`, the exact failing command and output, and what you tried. Do not weaken or delete a test to make it pass.
