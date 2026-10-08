# Shell worker: Runs home ranked by need, the header's P2s, the shell at 390 px (PRD_VIEWER_REFINE 4, 5.7 to 5.9)

## Goal

Runs home opens on what needs the operator, then Running as compact rows, then Paused as compact rows sorted oldest first with "since <n> days", then Recent with correct filter counts; the feature header lists the run's actual reviewers from the export; every header control meets 44 px under 760 px; the Runs home data path and the header's read-only check are tested; Runs home and the Projects header hold at 390 px in light and dark. A refinement of the Calm look, made with the impeccable skill as PRD section 4 pins the method. The project rail, search, filters, group-by and the day groups stay as the revamp built them.

## Context

- Today's shell: `src/App.tsx` (the Projects header), `src/projects/ProjectsView.tsx` (the rail, the routes), `RunsHome.tsx`, `RunRow.tsx`, `lists.ts` (`recentCounts`, the filters, `readsNextPage`), `lists.css`, `LiveStatus.tsx`, `theme.css` (the Calm tokens; Bold was removed in ce23d44), `tone.ts`, `ui/`. The revamp's structure: docs/PRD_VIEWER_REVAMP.md 5.1 and 5.2 (Runs home, the rail, the lists); the Run Story rules of docs/PRD_VIEWER_UX.md still hold (truthfulness, read-only).
- The eight P2s of `viewer-revamp-008` that are yours (PRD 5.8): the Recent filter counts over every row (`lists.ts`), the feature header naming the definition's review steps as if they were the run's reviewers (two findings): the run list carries no reviewers, so the feature page fetches the latest reviewed run's **detail** (`fetchRunDetail`, one request, cached per feature; the summary carries no attempt, so `/reviews/<attempt>` cannot be chosen from it) and lists `review.reviewers[].reviewer_id` under the label "Reviewers"; while no run of the feature is reviewed, or while the fetch is pending or failed, it shows the definition's review steps labelled "Review steps" and never calls them reviewers (this is the home-sections scenario's "actual reviewers from the export"), the 34 px target under 760 px, the read-only check not covering the header (`expectNoExecutionControls` in `support.ts` is shared and not yours: call it on the header from `projects.spec.ts`), no browser test of the Runs home data path (record one fetch against the mock in `ux-lists.spec.ts` or `revamp-lists.spec.ts`).
- Data: `runList` and `runDetail` as `contracts/projects` serve them on main, where the adapter run (`viewer-refine-002`, `--workers adapter`) already landed 1.10.0; it adds `inputs.workers[].roles` and `.skills` and `fixLoop` (Appendix A.2), which exist on the run detail only: the run list (`runSummary`) carries no roles, fix loop or reviewers, so the compact rows show nothing of them (no per-row detail fetch). Build fixtures from the existing `ux-lists.ts`, `ux-revamp-lists.ts` and Appendix A's records; add projects through a spec-level `/api/projects` route override, never through the fixture modules (revamp lesson). Verify with `npx tsc -b --force` in your worktree.
- The impeccable skill: available through the `Skill` tool as `workflow-shell:impeccable`; its folder is the run's `skills/shell/skills/impeccable/`. `PRODUCT.md` and `DESIGN.md` at the repository root are read-only for you. Mode is Operate.
- Handoff `docs/handoff/refine-shell.md`: the shape step's result written before the first edit; the inspection round's findings and fixes; the audit's findings; which P2 closed where; every open P2 with one line each.

## Method (PRD section 4, binding as the task)

1. `context` once (if the launcher refuses or fails, say so in the completion and read `PRODUCT.md`, `DESIGN.md` and `reference/operate.md` directly). 2. `shape` on Runs home; write its result into the handoff before any edit; if it concludes the refinement cannot meet PRD section 2, stop with a `question` completion and a mockup under your handoff, and build no redesign. 3. Read `reference/craft-floor.md` immediately before the first UI edit; use `layout`, `distill`, `clarify` and `polish`; never `new-work`. 4. One batched inspection round at 1440 and 390, light and dark; one batch of fixes; at most one confirmation round. 5. `audit` once at the end; record it.

## Constraints

- The pages lane's new fixture workflows appear on Runs home in the candidate phase: assert counts derived from the DOM, never literal totals.

- Owned paths only (policy.json lists every file). The `pages` lane owns the run page and everything under it (`RunView.tsx`, `RunHeader.tsx`, the graph, `dag.ts`, the Steps, the node pages, Assignment, `ReviewDetail.tsx`, `run.css`, `node.css`, the `node/` sections, the shared browser fixture modules `fixtures/index.ts`, `mock.ts`, `seed.ts`, `fixtures.ts`): do not edit them. `NowBanner.tsx` and `CommandBlock.tsx` are the pages lane's in this run. Components you own that the run page places (`LiveStatus.tsx`, `Time.tsx`) keep their props and exported names; an extension is additive and optional. You own the run-page rules that still live in `App.css`, including the 44 px `TimeZoneToggle` rule under 760 px (`App.css:404`): keep them, since the pages lane's `run-phone` scenario relies on them without asserting their source. You own the page gutter: `.workspace-projects` padding becomes 16 px at 760 px and below (`App.css`), which the pages lane relies on and does not assert. The `adapter` lane owns `contracts/projects`, `server` and the export. Do not edit `PRODUCT.md`, `DESIGN.md`, `support.ts`, `harness.ts`, `playwright.config.ts`.
- Tokens: the Calm tokens of `theme.css` and the state palette; add no new colour literal (a new semantic token is a question to the operator); the dark theme holds on every new element. The accent hue never carries state.
- Truthfulness and read-only as before: nothing shown that the data does not carry; no control acts on a run; the browser tab title keeps the needs-you count.
- Existing specs you own stay green or their assertions are rewritten to the DOM you changed; a spec you do not own that breaks is a question, not an edit.

## Acceptance

The browser scenarios in `policy.json`, each in exactly one test title as `[scenario:<id>]` with one `screenshot:<id>` attachment: `home-sections`, `home-phone` (their descriptions are the assertions); the read-only check over the Projects header in `projects.spec.ts`; one recorded fetch of the Runs home data path. Unit tests: `tests/unit/lists.test.ts` (filter counts over the filtered set; the Running and Paused partition and the paused sort), `tests/unit/tone.test.ts` if a tone is added. `frontend-build`, `frontend-lint`, `shared-contract`, `frontend-unit` green.

Run targeted tests while iterating, then this lane's non-browser policy checks once before writing the completion; run browser specs only through check-report on this lane's own specs.

Browser checks: each scenario id appears in exactly one test title as `[scenario:<id>]`, and that test, when it passes, attaches exactly one image/png named `screenshot:<id>` (other attachments are fine). The verifier refuses anything else. Before completing, run the spec files you changed with a JSON report:

```bash
WORKFLOW_VERIFICATION_PHASE=<worker|candidate> PLAYWRIGHT_JSON_OUTPUT_FILE=<tmp>/report.json \
  npx --no-install playwright test --config=<config> --reporter=json <spec files>
```

Then check the report with the verifier's own rules: run the exact `check-report` command the controller appends to this task when it pins it.

## Stop

Stop with a `question` completion when the shape step calls for a redesign, when a run-page component the `pages` lane owns must change for Runs home to work, or when a P2 cannot close without a contract field Appendix A lacks. Stop and report `blocked` when the impeccable skill is not available through the `Skill` tool and its folder is not under the run's `skills/shell/` either. Do not touch the run page, do not add controls that act on a run, do not change the tokens.
