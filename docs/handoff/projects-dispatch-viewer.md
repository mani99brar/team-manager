# Handoff: projects-dispatch viewer lane

The viewer half of projects-dispatch (PRD_PROJECTS_DISPATCH, decisions.md). The Projects page, a projects-only rail,
Triage, and a dedicated project page with the step chart, the GitHub column and a reading pane. DOM contract: `docs/VIEWER_DISPATCH.md`.

## Run 002: fixes to run 001's blocked review (review-001.md, V1–V22)

Run 001's candidate (f4623a4) was blocked; run 002 fixes the viewer P1s and the test-gap/critique P2s on the behaviours it touches. Changed in `src/projects/dispatch/`:

- **ReadingPane.tsx (V2):** the pane now reads the run detail with `fetchRunDetail` and runs `deriveNow` (events empty, as `servedNow` does) to render **today's `CommandBlock`** fed by the run's `NextStep` and its lead sentence — the same commands the run page shows — instead of a hand-made status line. Loading and failure states keep "Open run page". The pane is keyed by run id in the page, so it mounts fresh per run (no setState-in-effect). On a phone "Queue" now returns to the list (`onClose`), never the previous run.
- **AheadPane.tsx (new, V6):** the commits-ahead/landings view the Local and GitHub card's button docks: the commits ahead (short sha, subject, the run a commit names linking to it) with "and N more" when `ahead` exceeds the listed commits, and every landing with its local/origin state (unknown shown as unknown). Selection is now `{kind:'run'} | {kind:'ahead'} | null`.
- **ProjectPage.tsx:** a **"Needs you and running"** section before the chart (V5); the header's **"same repo as …"** addendum and **"update time not recorded"** when the reflog time is missing (V10); a **git-not-read** header that never says "checkout detached" (V10); the four **jump buttons move focus** to their section (each target carries `tabindex="-1"`, V4).
- **StepChart.tsx (V3, V7):** the axis, every run track and the "ended here" row share one grid template (`CHART_COLUMNS`, set inline) and the same side padding, so a stop glyph sits in its phase's column; narrow columns use fixed short forms (`PHASE_SHORT`) with the full name as the accessible name and `title` — never an ellipsis. Each feature group has a **"Steps of this definition"** fold reading the current definition.
- **GithubColumn.tsx (V8, V9, V11, V14):** PR/issue groups longer than five fold to "Show N more" (expand in place); the merged group names its scope "among the 20 shown"; the Local and GitHub card says "GitHub not read: <reason>" where its GitHub line would be while keeping local sync/ahead/landing counts; "Possibly related" follows [L5] and names the match ("head is <b>"/"base is <b>").
- **derive.ts:** `prRelation`/`relatedWhy` ([L5]), `commitsAheadMore`, `showMoreText`, `sameRepoText`, `UPDATE_TIME_NOT_RECORDED`; `prGroups` takes `defaultBranch`.
- **phases.ts:** `CHART_COLUMNS` and `PHASE_SHORT`.
- **projectModel.ts (V18/[L8]):** `readableFeatures`; `ProjectsPage` feeds it to `cardStateWord`, so "1 of 3 features failed last" counts only readable workflows and an unreadable one stays in the "· N cannot be read" suffix.
- **ProjectsPage.tsx (V15):** the header's "runs read <time>" is the read time (`homeMeta.settledAt`), not a ticking clock, and says "runs not read: <reason>" when the read failed.
- **dispatch.css:** the docked-pane grid (header full width; pane beside the body; the GitHub column stacks under the chart unless the viewport has room for three columns without squeezing the chart under 480px, `@media (min-width:1600px)`); the axis/ends realignment and the short-label container query; the Needs/ahead/fold styles; phone 44px targets (incl. the pane's `CommandBlock` Copy button and the breadcrumbs); the rail-home/rail-row class fix (`.dispatch-rail a` no longer forces `display:block`, so the rows keep their grid and the home links their flex — V13's glyph-on-the-name's-line and the gap before the count).

Tests: `tests/unit/dispatch.test.ts` adds V3's template/short labels, V14's rule, V6's "and N more", V8's "Show N more", V10's "same repo as"/"update time not recorded", and [L8]'s `projectRunInfo`→`cardStateWord`. `tests/project-workflows/dispatch.spec.ts` migrates the nine scenarios to the new behaviour and adds `dispatch-dock`, `dispatch-axis`, `dispatch-sections`, `dispatch-ahead`, `dispatch-folds`; all 14 pass in both phases. Fixtures (`fixtures/dispatch.ts`): the Busy project (a waiting run, a running run, 52 ahead, no origin reflog), Widgets' two landings ([P25]), Trio's unlistable workflow ([P34]), the unreadable project's own unlistable workflow (so its page renders git-not-read while the rail reads "cannot be read"), the worker-phase failed-refresh on Widgets' GitHub ([P35], not in the GitHub fixture file), run details for the pane ([P31]), and a sixth "Newest from people" issue so that group folds. `mock.ts` answers an unlistable workflow's run list with a 500. `revamp-lists.spec.ts`'s run-list override now passes an error list through untouched (status and all).

**dispatch-app.ts, run by hand (candidate):** `CRITIQUE_WEB_PORT=5417 CRITIQUE_API_PORT=3417 npx --no-install tsx tests/project-workflows/dispatch-app.ts` printed "The dispatch pages are ready." (its readiness requires `/api/dispatch/projects` to list **every** seeded project — including Busy — and every GitHub-backed project to read `status: 'read'`). `GET /api/dispatch/projects` answered **200** with the full overview. The server routes are in this base.

## Open P2s (run 002)

- **`on_source` landing** is a follow-up: a contract field for an integrated run that fast-forwarded only its source branch, so the page could say "landed on its source branch" instead of reading false on both default refs. Needs an Appendix A change (a `question`, out of this lane).
- The real `gh` path is still unexercised by a check (the operator's tryout covers it).
- `controls-unavailable` in `controls.spec.ts` (not owned) timed out under load once in run 001; the verifier refuses Playwright retries — report, do not edit.
- The GitHub `open_prs`/`open_issues` fixture counts are illustrative and need not match the seeded PR/issue lists' lengths.

## What changed

### New (`src/projects/dispatch/`)
- `types.ts` — Appendix A mirrored (the `server` lane owns `contracts/projects/dispatch.ts`).
- `client.ts` — `fetchDispatchOverview`, `fetchProjectSteps` (GET only, light shape check).
- `phases.ts` — the eight-phase axis and `phaseOf` (node_id first, kind fallback; sidecar→Launch, repair→Verify, [L2]/[P22]).
- `derive.ts` — pure logic: sync wording, landing wording, rail order + badges, card state word, PR/issue grouping, relative time.
- `projectModel.ts` — per-project run state from the registry runs (reuses `lists.ts`); project tone is the worst feature tone.
- `common.tsx` / `format.ts` — tone glyph, visibility chip, date helper.
- `Rail.tsx`, `ProjectsPage.tsx`, `ProjectPage.tsx`, `StepChart.tsx`, `GithubColumn.tsx`, `ReadingPane.tsx`, `dispatch.css`.

### Changed
- `routes.ts` — the `triage` route `/projects/-/triage` ([D1]); `triagePathname`.
- `ProjectsView.tsx` — loads the dispatch overview and steps; renders `ProjectsPage` at `/projects`, `RunsHome` at Triage,
  `ProjectPage` at `/projects/<p>`; wraps the Projects page, Triage, the project page and the workflow page in the new `Rail`.
- `RunsHome.tsx` — dropped its own prefix rail (the shared `Rail` wraps it); it now renders only the Runs-home content, with the
  read-only note at its foot. `ProjectRunGroups` is kept for `lists.ts` export parity but is no longer rendered.
- `lists.ts` — unchanged exports (`accepted.test.ts` and the migrated specs still import them).

### Tests (owned)
- `tests/unit/dispatch.test.ts` — phase map, landing on neither ref, rail order + badges, card word, PR/issue grouping, relative
  time with the year, sync wording for every origin state.
- `tests/unit/routes.test.ts` — the `triage` route, and that no project id can produce `/projects/-/triage`.
- `tests/project-workflows/dispatch.spec.ts` — the nine `[scenario:dispatch-*]` browser scenarios.
- `tests/project-workflows/fixtures/dispatch.ts` — worker-phase overview/steps + new registry projects and runs; candidate-phase
  git repositories and the GitHub fixture (`seedDispatchCandidate`).
- `mock.ts` — `/api/dispatch/**` mocks in `installProjectMocks` (so every spec gets them, design-challenge note 1); the run mock
  now serves any registered project, not only `alpha-project`.
- `fixtures/index.ts`, `seed.ts`, `playwright.config.ts`, `support.ts` — register the dispatch projects; `seedCandidate(root, { dispatch })`
  opt-in; candidate `MD_MANAGER_GITHUB_FIXTURE`/`MD_MANAGER_GITHUB_CACHE` under the test root; `triageUrl` helper.
- Migrated specs (open the Runs home → Triage, new rail/chart selectors): `ux-lists.spec.ts`, `revamp-lists.spec.ts`,
  `projects.spec.ts`, `lanes.spec.ts`. (`revamp-pages.spec.ts` needed no change.)

## Checks

- `frontend-build`, `frontend-lint`, `shared-contract`, `frontend-unit`: pass.
- Browser (worker phase): the nine dispatch scenarios pass, and the full worker-phase suite passes (migrated specs included).
- Ran `npx --no-install tsx tests/project-workflows/dispatch-app.ts` by hand in run 002: it reached "The dispatch pages are
  ready" and `/api/dispatch/projects` answered 200 with every seeded project and every GitHub repo `read` (see the run-002
  section above). The server routes are in this base.

## Open assumptions / debts (P2s)

- **The candidate phase runs in this worktree now** (the server routes are in the base): `seedDispatchCandidate` writes real
  run directories in the documented storage format (`writeDispatchRun`), so the candidate project pages show the step-chart
  runs, not empty `runs_root` directories. Run 002's `dispatch.spec.ts` passes in both phases here.
- **Reading pane command** (run 002): the pane now shows today's `CommandBlock` fed by the run's `NextStep`, the same commands
  the run page shows for that run (V2). `CommandBlock.tsx` is unchanged.
- **Dispatch run dates** are set to 2025-01-01 so the shared-registry projects never pollute other specs' Today/Recent windows.
