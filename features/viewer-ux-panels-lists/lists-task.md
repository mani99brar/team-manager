# Lists worker: Runs home, run lists and served activity (viewer UX slice S6)

## Goal

An operator who opens `/projects` sees at once whether anything needs them, what is running and what finished recently, across every project, and every list row says what happened, when and for how long. The run page and the lists use the backend's served `activity` so waiting questions, pane attention and a stopped controller are visible without opening a run. Implement slice S6 of `docs/PRD_VIEWER_UX.md`: section 4.1 (Runs home, project page, feature page, workflow title rule), 6.3 (the controller suffix) and 6.4 (attention in lists) are the specification; section 11 lists the slice; sections 12.2 and 12.3 are its tests. `decisions.md` in this feature records the operator's decisions.

## Context

- Steps 1 to 4 of the redesign are merged. The backend slice S5 already serves `activity` (focus, headline, attention, waiting questions, controller liveness, `finished_at`, `last_activity_at`) on run summaries and details, and `run_dir` when a project is listed in the registry's `viewer.expose_run_dir`: see `contracts/projects/v1.ts` (1.5.0) and `docs/handoff/ux-s5.md`.
- The run page pieces you extend: `NowBanner.tsx` (reads `deriveNow` from `contracts/projects/triage.ts`; read it, do not edit it), `CommandBlock.tsx`, `LiveStatus.tsx`, and `ProjectsView.tsx` (the levels: projects, project, feature, run). Polling is `usePoll.ts` and `useResource.ts`.
- Fixtures: `tests/project-workflows/fixtures/ux-lists.ts` is an empty module already registered by `fixtures/index.ts`; its `seed` may return top-level registry keys such as `viewer.expose_run_dir`. Read `index.ts` and a filled module such as `ux-run.ts`. Browser helpers, including `attach(page, testInfo, id)`, are in `tests/project-workflows/support.ts`.
- Handoffs of earlier slices: `docs/handoff/ux-s3.md`, `ux-s5.md` (conventions, red/green evidence format).

## Constraints

- Only edit the paths your lane owns in the pinned policy. The `panels` lane owns the review, challenge and controller node files and `ux-review.*`; do not edit them or read its worktree. Put pure helpers (grouping, title rule, row wording, controller debounce) in `src/projects/lists.ts` (no React import: the unit tests import it) and their tests in `tests/unit/lists.test.ts`.
- Migrate `projects.spec.ts` exactly as PRD 12.3 lists for S6, each change with a one-line reason in the handoff; `run-list li` keeps its count of 5, and `currentCrumb` assertions stay unchanged.
- The viewer stays read-only: every button text is one of those listed at the end of PRD 12.3; no button text holds a path or a command. Keep `expectNoExecutionControls` green.
- When `activity` is absent (an older server), fall back as PRD 4.1 says: no invented finish time or duration.
- If the PRD is ambiguous, choose, record the choice as an open assumption, and keep going.

## Acceptance

- Fixtures in `ux-lists.ts` for both phases: its own run with a live `<lane>.questions.json`, a pane-attention event and a controller PID, plus the `viewer.expose_run_dir` registry entry (the candidate phase's temp roots give `run_dir: null`, so the `RUN=` line is asserted in the worker phase and asserted absent in the candidate phase, per PRD 12.2).
- One browser test per scenario id in `tests/project-workflows/ux-lists.spec.ts`, each title containing `[scenario:<id>]` and attaching `screenshot:<id>`: `runs-home` and `served-activity`, asserting what the pinned policy describes, in both phases.
- Unit tests for the pure helpers, including the 15 s `not_running` debounce and each branch of the title rule.
- At 390 px the list rows stack and the page has no horizontal overflow.
- Red first: run the new tests against the pre-change code and record that they fail for the right reason; then green. Write `docs/handoff/ux-s6.md` with what shipped, both runs, the `projects.spec.ts` migrations and any deviation from the PRD.
- Run targeted tests only: `npm run build`, `npm run lint`, `npx tsx --test tests/unit/lists.test.ts`, and the browser spec files you added or changed (`ux-lists.spec.ts`, `projects.spec.ts`) with `WORKFLOW_VERIFICATION_PHASE=worker` and with `WORKFLOW_VERIFICATION_PHASE=candidate`. The verifier runs every policy check on your snapshot and on the combined candidate. Report exactly what you ran, with results.

## Stop

Finish within the worker deadline. If a check keeps failing after three honest attempts, write the completion with status `blocked`, the exact failing command and output, and what you tried. Do not weaken or delete a test to make it pass.
