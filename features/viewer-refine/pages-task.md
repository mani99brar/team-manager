# Pages worker: the run page shows the fix loop and opens on an answer; Assignment and the inline diff (PRD_VIEWER_REFINE 4, 5.1 to 5.6, 5.8, 5.9)

## Goal

The run page opens on an answer (the state line, the cause, the next step, the lanes with their pins, then the graph; metadata in a closed disclosure), draws the fix loop in the graph (repair sessions as nodes after the step they answer with a dashed return mark, review rounds as attempts of the review node with their delta base, lane pins on the launch nodes), groups the Steps table and the Activity log by phase, attempt and round, gives a repair node and a review round their pages, lands slice S7 (the Assignment tab as one setup line and one row per lane; the review diff inline with the delta diff as the default view when there is one), closes its two P2s (390 px stacking tested, lane chip tones tested failed and running) and holds at 390 px. It is a refinement of the Calm look, made with the impeccable skill as PRD section 4 pins the method. Every older export renders unchanged in content; only the arrangement changes.

## Context

- The data you render is `runDetail` 1.10.0 as PRD_VIEWER_REFINE Appendix A.2 pins it (`fixLoop`, repair nodes in the definition and snapshot with derived statuses, `review.round`, `delta_from`, `delta_diff`, `inputs.workers[].roles` and `.skills`, `inputs.automatic.fix_rounds`), landed on main by the adapter run (`viewer-refine-002`, `--workers adapter`), so your worktree's `contracts/projects` and `server` already serve it; build every fixture from Appendix A's records and the existing `ux-*` fixture modules (`tests/project-workflows/fixtures/`, registered last in `UX_FIXTURE_MODULES` in `fixtures/index.ts`, which you own). Do not invent a field; a field you need and Appendix A lacks is a question to the operator.
- Today's run page: `src/projects/RunView.tsx`, `RunHeader.tsx`, `NowBanner.tsx` (the Now derivation it renders is `contracts/projects/triage.ts` `focus` and `attention`; the banner component belongs to the `shell` lane: you place it and may pass it props it already accepts, you do not edit it), `WorkflowGraph.tsx` and `dag.ts` (layered layout, 83 % fit floor, compact variant, keyboard order, status glyphs, attention ring, executor legend), `StepsTimeline.tsx` and `steps.ts`, `NodeDetail.tsx`, `NodeHeader.tsx` (`statusCause`, repairs after attempts), `node/*Sections.tsx`, `ReviewDetail.tsx`, `Assignment.tsx`, `CreatedFiles.tsx`, `Checks.tsx`. The Run Story rules (docs/PRD_VIEWER_UX.md: truthfulness, the first-screen budget, section 6.2's next-step rules) and the revamp's structure (docs/PRD_VIEWER_REVAMP.md 5.x) still hold.
- S7's original specification: docs/PRD_VIEWER_UX.md 4.10 (Assignment) and the Diff part of 4.7 (Review) and the Files row of section 7; `features/viewer-ux-depth/depth-task.md` as background only (this feature supersedes it; its decisions are PRD 5.5 and 5.6).
- The impeccable skill: available through the `Skill` tool as `workflow-pages:impeccable`; its folder is the run's `skills/pages/skills/impeccable/` (SKILL.md, `reference/operate.md`, `reference/craft-floor.md`, `reference/shape.md`, `layout.md`, `distill.md`, `clarify.md`, `polish.md`, `audit.md`). `PRODUCT.md` and `DESIGN.md` at the repository root are the product and design context the skill reads; both are read-only for you. Mode is Operate.
- Browser harness: `tests/project-workflows/support.ts` (`attach(page, testInfo, id)`, `expectNoExecutionControls`), `harness.ts`, `playwright.config.ts` are shared and not yours to edit; `mock.ts`, `seed.ts` and `fixtures.ts` are yours. Verify with `npx tsc -b --force` in your worktree (a shared tsbuildinfo hides type errors).
- Handoff `docs/handoff/refine-pages.md`: the shape step's result (jobs, the first screen's contents in order, what moved, what was removed) written before the first edit; the inspection round's findings and fixes; the audit's findings; every open P2 with one line each.

## Method (PRD section 4, binding as the task)

1. `context` once (the skill's launcher from its folder; if it refuses or fails, say so in the completion and read `PRODUCT.md`, `DESIGN.md` and `reference/operate.md` directly). 2. `shape` on the run page; write its result into the handoff before any edit; if the shape step concludes the refinement cannot meet PRD section 2, stop with a `question` completion describing what a redesign would change, with a mockup under your handoff, and build no redesign. 3. Read `reference/craft-floor.md` immediately before the first UI edit; use `layout`, `distill`, `clarify` and `polish`; never `new-work`. 4. One batched inspection round at 1440 and 390, light and dark; one batch of fixes; at most one confirmation round; stop polishing. 5. `audit` once at the end; record it.

## Constraints

- Owned paths only (policy.json lists every file). The `shell` lane owns the Projects header, the project rail, Runs home, `RunRow`, `lists.*`, `NowBanner.tsx`, `CommandBlock.tsx`, `LiveStatus.tsx`, `Time.tsx`, `TimeZoneToggle.tsx`, `time.ts`, `theme.css`, `tone.ts`, `ui/`, `App.tsx`, `App.css`, `index.css`, `routes.ts` and the hooks (`useRunData.ts`, `usePoll.ts`, `useResource.ts`, `resource.ts`, `scroll.ts`): do not edit them; use their exports as they are, and ask through a `question` completion if one must change. The `adapter` lane owns `contracts/projects`, `server` and the export. Do not edit `PRODUCT.md`, `DESIGN.md`, `support.ts`, `harness.ts`, `playwright.config.ts`.
- Tokens: use the Calm tokens of `theme.css` and the state palette; add no new colour literal (a new semantic token is a question to the operator). The dark theme must hold on every new element.
- The contract graph stays acyclic: the return mark is a drawing from `fixLoop`, never a `depends_on` edge; the layout keeps keyboard order, status glyphs, the attention ring and the legend (which gains the return mark).
- Truthfulness: nothing is shown the export does not carry; a run without `fixLoop` has no repair rows, no round labels, no pins; "not recorded" is the word for absent evidence.
- The viewer stays read-only: no control acts on a run (the read-only check in every spec stays).
- Existing specs you own stay green or their assertions are rewritten to the DOM you changed; a spec you do not own that breaks is a question, not an edit.
- No "Traceback" or "Error" literal is added to the controller-row monitor patterns (review-sidecar lesson).

## Acceptance

The browser scenarios in `policy.json`, each in exactly one test title as `[scenario:<id>]` with one `screenshot:<id>` attachment: `run-first-screen`, `fix-loop-graph`, `assignment-and-diff`, `run-phone` (their descriptions are the assertions). Unit tests: `tests/unit/dag.test.ts` (repair node placement, 15 nodes in 8 columns, the fit), `tests/unit/steps.test.ts` (phase groups, repair rows, round rows), `tests/unit/diff.test.ts` (the parser: files, counts, hunks, the 2,000-line rule), `tests/unit/assignment.test.ts` (the setup line and the lane rows from a 1.10.0 and a 1.9.0 detail). `frontend-build`, `frontend-lint`, `shared-contract`, `frontend-unit` green.

Run targeted tests while iterating, then this lane's non-browser policy checks once before writing the completion; run browser specs only through check-report on this lane's own specs.

Browser checks: each scenario id appears in exactly one test title as `[scenario:<id>]`, and that test, when it passes, attaches exactly one image/png named `screenshot:<id>` (other attachments are fine). The verifier refuses anything else. Before completing, run the spec files you changed with a JSON report:

```bash
WORKFLOW_VERIFICATION_PHASE=<worker|candidate> PLAYWRIGHT_JSON_OUTPUT_FILE=<tmp>/report.json \
  npx --no-install playwright test --config=<config> --reporter=json <spec files>
```

Then check the report with the verifier's own rules: run the exact `check-report` command the controller appends to this task when it pins it.

## Stop

Stop with a `question` completion when the shape step calls for a redesign (PRD section 4 step 2), when a component the `shell` lane owns must change for the first screen to work, or when Appendix A lacks a field the design needs. Stop and report `blocked` when the impeccable skill is not available through the `Skill` tool and its folder is not under the run's `skills/pages/` either (say what you found). Do not add controls that act on a run, do not touch Runs home, do not change the tokens.
