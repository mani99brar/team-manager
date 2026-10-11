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

## Run 003: fixes to run 002's blocked review (review-002.md, V23–V32)

Run 002's candidate (cb5af748) was blocked on six viewer defects; run 003 fixes them and the named P2s. Changed in `src/projects/dispatch/`:

- **ProjectPage.tsx / dispatch.css (V23):** the chart/GitHub column count while a run is docked now comes from the project body's own width via a container query, not a viewport media query that left out the Projects workspace's border and padding. `.dispatch-body-container` wraps `.dispatch-project-body` and carries `container-type: inline-size; container-name: dispatch-body` while `.has-pane`; the body is two columns under `@container dispatch-body (min-width: 876px)` (480 + 16 + 380). The `@media (min-width: 1680px)` rule is deleted. Undocked layout (PRD 4.3) is unchanged (per design-challenge note 1: the container rule is scoped to `.has-pane`).
- **ProjectPage.tsx / AheadPane.tsx / derive.ts (V24, [L10]):** a commit's run links when the page can resolve its workflow (`resolveRunWorkflow`: the run lists, then the dispatch steps, then a single-workflow project); otherwise the run id shows as plain text with "older than the newest 50 runs", never a dead or guessed link. A landing always links via its own `workflow_id` (`landingHref`). The false comment ("the dispatch steps carry every run directory") is corrected. **Open P2 ([L12]):** the single-workflow fallback can mislink a run of a clone mate (a shared clone such as Widgets and its worktree) — the page cannot tell which clone a bare run id belongs to, so on a single-workflow project it attributes any named run to that workflow.
- **ProjectPage.tsx / ProjectsView.tsx (V25, [L12]):** "Needs you and running" takes a `runsState` from `ProjectsView` (`loading` / `failed` with a reason / `ready`) and never claims a plain all-clear it cannot know: "Reading runs…" while the lists load; "Runs not read: <reason>" when the request failed or every workflow's run list failed (`fetchWorkflowRuns` rejects only on abort and turns each workflow's failure into `{runs:[], error}`, so a wholly failed request reaches the page as "every workflow failed"); "Nothing waits on you; nothing running." only when all read and none waits/runs; the waiting/running runs or the clear phrase plus " · N feature(s) cannot be read" when some but not all failed. An empty workflow list is fully read (design-challenge note 5).
- **GithubColumn.tsx / derive.ts (V26):** a GitHub read with no head (`head: null`, an empty repository) says "GitHub's <default branch> has no commits" (named only when `github.default_branch` holds one, never the local branch) instead of "GitHub not read"; the PR and issue data and counts stay. `githubHeadState` / `githubNoHeadText` are unit-tested (four cases).
- **ReadingPane.tsx (V27):** the duplicate NEXT STEP lead paragraph (`dispatch-pane-next-lead`) is removed; the CommandBlock already states the label once.
- **ProjectPage.tsx (V28):** Escape and Close on the Local commits pane return focus to the "Commits ahead and landings" button, as the run pane returns it to the row.
- **GithubColumn.tsx / dispatch.css (V29):** the open count reads "N open", never "N opens"; the card title is a nowrap `span.dispatch-gh-title` so the PULL REQUESTS heading never splits; a landed sha (`.dispatch-res code`, `.dispatch-run-2 code`) is `white-space: nowrap`.
- **StepChart.tsx (V30):** a filter matching none of a feature's runs shows "0 of N runs match" in the group header (`filtering` prop, `FeatureGroup.total`).
- **dispatch.spec.ts (V31):** the phone 44 px scan adds the open reading pane as a root and runs before "Queue" closes it.

Tests: `tests/unit/dispatch.test.ts` adds V24's `resolveRunWorkflow` (three cases) and V26's `githubHeadState`/`githubNoHeadText` (four cases). `tests/project-workflows/dispatch.spec.ts` extends `dispatch-dock` (the 1600–1760 band and the column-placement by value, V23), `dispatch-ahead` (V28 focus return), `dispatch-sections` (Busy link hrefs, Trio's "1 feature cannot be read", and — worker phase, route interception — a held-open run list → "Reading runs…" and a fully failed project → "Runs not read:", V25), `dispatch-github` (V26 head-null via a worker-phase overview override, "N open" and the one-line heading, V29), `dispatch-pane` (V27 lead-once and the command by value against the run page's rendering), `dispatch-chart` (V30 filter wording and V29 sha on one line), and `dispatch-phone` (V31 pane scan). No fixture file changed; the head-null and run-list-failure cases are injected by route interception in the worker phase only.

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
