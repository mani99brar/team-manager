# Handoff: projects-dispatch viewer lane

The viewer half of projects-dispatch-001 (PRD_PROJECTS_DISPATCH, decisions.md). The Projects page, a projects-only rail,
Triage, and a dedicated project page with the step chart, the GitHub column and a reading pane. DOM contract: `docs/VIEWER_DISPATCH.md`.

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
- Ran `npx --no-install tsx tests/project-workflows/dispatch-app.ts` by hand: it starts the servers and seeds the repositories,
  but **its `/api/dispatch/projects` readiness check fails in this worktree because the dispatch routes live in the `server`
  lane and are not present here** — expected until the lanes meet. The git-seeding path was validated standalone (the primary
  clone reads 2 ahead, 1 behind `origin/main`, origin URL `https://github.com/acme/widgets.git`, fixture repos present).

## Open assumptions / debts (P2s)

- **Candidate phase is untested in this worktree.** The dispatch routes are the `server` lane's; the candidate browser checks,
  `dispatch-app.ts`'s readiness, and the real git/gh reads can only be verified once both lanes merge. The controller must run
  the candidate phase. The candidate run-seeding is minimal (empty `runs_root` directories): the candidate project pages will
  show git/GitHub but no run rows / step-chart runs for the dispatch projects unless the run directories are seeded; this is a
  follow-up for the candidate phase to match the worker phase. The worker phase is complete.
- **Reading pane command** ([D7] reading): the pane shows a lightweight copyable `python -m workflow status <run> --by operator`
  command, not the run page's full `CommandBlock`, whose `NextStep`/served-run/controls contexts belong to the run page; the
  pane's primary action opens the run page where those live.
- **Dispatch run dates** are set to 2025-01-01 so the shared-registry projects never pollute other specs' Today/Recent windows.
