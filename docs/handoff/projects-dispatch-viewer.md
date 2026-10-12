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
- **dispatch.css:** the docked-pane grid (header full width; pane beside the body; the GitHub column stacks under the chart unless there is room for three columns without squeezing the chart under 480px — run 002 shipped this as a viewport media query, replaced in run 003 by the `@container dispatch-body (min-width: 876px)` rule on `.dispatch-body-container`, V23); the axis/ends realignment and the short-label container query; the Needs/ahead/fold styles; phone 44px targets (incl. the pane's `CommandBlock` Copy button and the breadcrumbs); the rail-home/rail-row class fix (`.dispatch-rail a` no longer forces `display:block`, so the rows keep their grid and the home links their flex — V13's glyph-on-the-name's-line and the gap before the count).

Tests: `tests/unit/dispatch.test.ts` adds V3's template/short labels, V14's rule, V6's "and N more", V8's "Show N more", V10's "same repo as"/"update time not recorded", and [L8]'s `projectRunInfo`→`cardStateWord`. `tests/project-workflows/dispatch.spec.ts` migrates the nine scenarios to the new behaviour and adds `dispatch-dock`, `dispatch-axis`, `dispatch-sections`, `dispatch-ahead`, `dispatch-folds`; all 14 pass in both phases. Fixtures (`fixtures/dispatch.ts`): the Busy project (a waiting run, a running run, 52 ahead, no origin reflog), Widgets' two landings ([P25]), Trio's unlistable workflow ([P34]), the unreadable project's own unlistable workflow (so its page renders git-not-read while the rail reads "cannot be read"), the worker-phase failed-refresh on Widgets' GitHub ([P35], not in the GitHub fixture file), run details for the pane ([P31]), and a sixth "Newest from people" issue so that group folds. `mock.ts` answers an unlistable workflow's run list with a 500. `revamp-lists.spec.ts`'s run-list override now passes an error list through untouched (status and all).

**dispatch-app.ts, run by hand (candidate):** `CRITIQUE_WEB_PORT=5417 CRITIQUE_API_PORT=3417 npx --no-install tsx tests/project-workflows/dispatch-app.ts` printed "The dispatch pages are ready." (its readiness requires `/api/dispatch/projects` to list **every** seeded project — including Busy — and every GitHub-backed project to read `status: 'read'`). `GET /api/dispatch/projects` answered **200** with the full overview. The server routes are in this base.

## Run 003: fixes to run 002's blocked review (review-002.md, V23–V32)

Run 002's candidate (cb5af748) was blocked on six viewer defects; run 003 fixes them and the named P2s. Changed in `src/projects/dispatch/`:

- **ProjectPage.tsx / dispatch.css (V23):** the chart/GitHub column count while a run is docked now comes from the project body's own width via a container query, not a viewport media query that left out the Projects workspace's border and padding. `.dispatch-body-container` wraps `.dispatch-project-body` and carries `container-type: inline-size; container-name: dispatch-body` while `.has-pane`; the body is two columns under `@container dispatch-body (min-width: 876px)` (480 + 16 + 380). The `@media (min-width: 1680px)` rule is deleted. Undocked layout (PRD 4.3) is unchanged (per design-challenge note 1: the container rule is scoped to `.has-pane`).
- **ProjectPage.tsx / AheadPane.tsx / derive.ts (V24, [L10]):** a commit's run links when the page can resolve its workflow (`resolveRunWorkflow`: the run lists, then the dispatch steps, then a single-workflow project); otherwise the run id shows as plain text with "older than the newest 50 runs", never a dead or guessed link. A landing always links via its own `workflow_id` (`landingHref`). The false comment ("the dispatch steps carry every run directory") is corrected. The [L12] note-5 concern — that the single-workflow fallback could mislink a clone mate's run — has one status in this handoff: it is recorded under "Open — review-003.md" below as a phantom to drop (review-003.md:19), because the server sets a commit's `run_id` only for this project's own run directories, so a clone mate's run arrives with `run_id` null and the fallback never names it; the only real mislabel is the V24 "older than the newest 50" case, listed there too.
- **ProjectPage.tsx / ProjectsView.tsx (V25, [L12]):** "Needs you and running" takes a `runsState` from `ProjectsView` (`loading` / `failed` with a reason / `ready`) and never claims a plain all-clear it cannot know: "Reading runs…" while the lists load; "Runs not read: <reason>" when the request failed or every workflow's run list failed (`fetchWorkflowRuns` rejects only on abort and turns each workflow's failure into `{runs:[], error}`, so a wholly failed request reaches the page as "every workflow failed"); "Nothing waits on you; nothing running." only when all read and none waits/runs; the waiting/running runs or the clear phrase plus " · N feature(s) cannot be read" when some but not all failed. An empty workflow list is fully read (design-challenge note 5).
- **GithubColumn.tsx / derive.ts (V26):** a GitHub read with no head (`head: null`, an empty repository) says "GitHub's <default branch> has no commits" (named only when `github.default_branch` holds one, never the local branch) instead of "GitHub not read"; the PR and issue data and counts stay. `githubHeadState` / `githubNoHeadText` are unit-tested (four cases).
- **ReadingPane.tsx (V27):** the duplicate NEXT STEP lead paragraph (`dispatch-pane-next-lead`) is removed; the CommandBlock already states the label once.
- **ProjectPage.tsx (V28):** Escape and Close on the Local commits pane return focus to the "Commits ahead and landings" button, as the run pane returns it to the row.
- **GithubColumn.tsx / dispatch.css (V29):** the open count reads "N open", never "N opens"; the card title is a nowrap `span.dispatch-gh-title` so the PULL REQUESTS heading never splits; a landed sha (`.dispatch-res code`, `.dispatch-run-2 code`) is `white-space: nowrap`.
- **StepChart.tsx (V30):** a filter matching none of a feature's runs shows "0 of N runs match" in the group header (`filtering` prop, `FeatureGroup.total`).
- **dispatch.spec.ts (V31):** the phone 44 px scan adds the open reading pane as a root and runs before "Queue" closes it.

Tests: `tests/unit/dispatch.test.ts` adds V24's `resolveRunWorkflow` (three cases) and V26's `githubHeadState`/`githubNoHeadText` (four cases). `tests/project-workflows/dispatch.spec.ts` extends `dispatch-dock` (the 1600–1760 band and the column-placement by value, V23), `dispatch-ahead` (V28 focus return), `dispatch-sections` (Busy link hrefs, Trio's "1 feature cannot be read", and — worker phase, route interception — a held-open run list → "Reading runs…" and a fully failed project → "Runs not read:", V25), `dispatch-github` (V26 head-null via a worker-phase overview override, "N open" and the one-line heading, V29), `dispatch-pane` (V27 lead-once and the command by value against the run page's rendering), `dispatch-chart` (V30 filter wording and V29 sha on one line), and `dispatch-phone` (V31 pane scan). No fixture file changed; the head-null and run-list-failure cases are injected by route interception in the worker phase only.

## Open P2s carried forward (review-002.md and review-003.md)

Every viewer-lane P2 of `features/projects-dispatch/review-002.md` and `review-003.md` that runs 003 and 004 do not fix, so the
follow-up record is complete (V33/V32). Server-lane P2s are in `projects-dispatch-server.md`. Each line names its source and the
one thing still missing. Items run 003 fixed are under "Fixed in run 003" with the item that fixed them; run 004 is docs-only and
fixes none of these.

### Open — review-002.md (viewer)

- **V2 loading/failed run-detail state (review-002.md:21):** no scenario covers the pane while the run detail loads or fails, or that "Open run page" still shows then. (The command-by-value gap is fixed in run 003, below.)
- **V3 CSS ellipsis, accessible name, glyph tolerance (review-002.md:22):** dispatch-axis checks `innerText` for "…", which a CSS `text-overflow: ellipsis` would pass; it does not assert that the short forms show at the narrow width or that the full phase name is the accessible name; only one run's glyph is placed, and the "ended here" tolerance is a whole column width, so a count in the adjacent column can pass.
- **V6 unknown/uncompared wording, per-landing pairs (review-002.md:24):** the seeded Widgets landings have 0 unknown, so landingState's "unknown" branch never renders in a scenario; the no-origin / `no_local_branch` empty-list wording is untested; each landing's own local/origin pair is not asserted by value (dispatch-ahead only checks that "local main:"/"origin/main:" appear somewhere). (The older-run link is fixed in run 003 for resolvable runs; the untested parts are review-003.md:22 below.)
- **V7/[P30] definition folds (review-002.md:25):** dispatch-folds opens only the first group's fold; no scenario has a feature whose current definition differs from its latest run's, and nothing checks a no-runs feature's fold lists its steps — a fold built from the latest run would pass.
- **V10 shared non-GitHub clone, 'as of' assertion (review-002.md:26):** only the GitHub-shared Widgets/worktree clone is seeded; a shared non-GitHub clone and separate clones of one GitHub repo (the cases the `clone_id` change was for) are untested; the header's "as of origin/<d> updated here <time>" is asserted only as "as of".
- **V11 no-count assertion (review-002.md:27):** dispatch-github on the non-GitHub project never asserts that no GitHub count appears (no "N open", no jump-button counts, no GitHub head), nor the local ahead/landing counts that should stay (the seed has none).
- **V12 Projects page cards (review-002.md:28):** the phone 44px scan never measures the Projects page cards and header; "fills the screen", "cards are one column" and "the GitHub column stacks" are not asserted (only the `phone` class). (The open-pane targets are fixed in run 003 by V31, below.)
- **V13 Triage marker/gap, glyph placement (review-002.md:29):** the label-to-count gap and visible marker are measured only on "All projects"; "Triage" is checked only for aria-current, with no visible-marker or gap check, and nothing checks the glyph is on the name's line.
- **V15 unit test, fixed clock (review-002.md:30):** there is no unit test of the "runs not read: <reason>" wording; dispatch-overview uses a 1.5 s real wait instead of a fixed clock moved forward, so a per-minute-ticking or relative clock would pass.
- **V16 GitHub sha, pane landing pairs (review-002.md:31):** dispatch-git-truth checks only the word "committed", not GitHub main's sha; the pane's per-landing pairs are never asserted by value (ui-polish-001 should read yes/yes and ui-polish-003 yes/no).
- **V17 card counts, rail rows (review-002.md:32):** no card's run counts are asserted and the latest run only as the "ui-polish-" prefix; "a card holds no other link" is checked on Widgets only; "no workflow rows or repository headers" runs on the Projects page only and only shows that `.dispatch-rail-row` elements have ids; the workflow page checks only the rail's first row.
- **V18 candidate-phase 440px collapse (review-002.md:33):** the multi-lane collapse is asserted only in the worker phase; the candidate seed has single-lane runs, so the collapse against the real server is unproved.
- **V19 full width, facts (review-002.md:34):** dispatch-pane asserts no `has-pane` class with nothing selected but never measures the full width; the pane facts are never asserted and the lead sentence is checked for visibility only, not content.
- **V20 group order, failed-refresh line content (review-002.md:35):** the "Assigned to you"/"Newest from people" order is not asserted; the failed-refresh line is checked only as "the latest refresh failed", without "Last read <time>" or the reason; checks counts only as the word "passing"; "no GitHub counts on a not-read project" is never asserted.
- **V21 renderedText wait (review-002.md:36):** dispatch-git-truth calls `renderedText(workspace(page))` straight after `page.goto` without waiting for content, so a page read while it still shows "Loading workflows…" passes vacuously and a path leak on a late-rendering project page can go undetected.
- **Pane clipped at 1280x720 (review-002.md:46, critique):** the docked pane is clipped and only its inner body scrolls, with no scroll cue, so "Open run page" and the command Copy buttons sit below the fold of the pane until the user scrolls inside it.
- **'1 name a run' agreement (review-002.md:47, critique; still at GithubColumn.tsx:151):** the Local and GitHub card reads "Of the 2 ahead, 1 name a run" — needs the singular "1 names a run". Still present in the base; also raised as review-003.md:16. (The "N opens" and wrapping-heading parts of this bullet are fixed in run 003 by V29, below.)
- **Trio's count/list mismatch (review-002.md:48, critique):** the header and jump button say e.g. "Pull requests · 2 open" while the card lists a different number of PRs/issues; the fixture causes it, but a user sees a count that contradicts the list. The live `gh api graphql` path (review decision, checks, draft, head→base, open counts) is unexercised here and stays an operator step (tryout).
- **Console 500/503 errors (review-002.md:51, critique):** opening a project page logs HTTP 500/503 resource errors for the run-list endpoints of unreadable features (broken, trio-locked, x); the page handles them with a "cannot be read" row, but the console shows red errors on every load of Widgets, Trio and Unreadable.

### Open — review-003.md (viewer)

- **V24 false "older than the newest 50" (review-003.md:13):** `workflowOfRun` ignores `steps.workflows[].errors[].run_id`, so a commit ahead that names an unreadable recent run (e.g. Widgets' broken-001), and every named commit while the run lists and steps load or fail, renders as "<run-id> · older than the newest 50 runs" though the page holds that run's workflow.
- **V29 "on one line" cannot fail (review-003.md:14):** the `getClientRects().length === 1` checks on `.dispatch-gh-title` (child of a `display:flex` h3) and `.dispatch-res code` (`display:inline-flex`) always return one rect even when the text wraps, so removing `white-space: nowrap` still passes dispatch-github / dispatch-chart. A height/line-count measure would detect a wrap.
- **V23 container rule overrides the narrow stack (review-003.md:15):** `@container dispatch-body (min-width: 876px)` (specificity 0,4,0) beats the `@media (max-width: 999px)` stack (0,2,0), so docked from ~950–999px the body shows chart + GitHub column side by side while the same page undocked stacks it, contradicting PRD 4.3 below 980px. The chart stays ≥480px so the [P26] squeeze does not return, and no dispatch-dock test is under 1280px.
- **Byte-identical screenshots (review-003.md:17):** dispatch-pane, dispatch-git-truth and dispatch-sections shared one sha256 in the run-003 candidate packet (the added `page.goto` before `attach()` captured the undocked Widgets page, not the docked pane, the Busy list, Trio's "1 feature cannot be read" or the failed-run-list state), so the packet has no visual evidence for V25 or V27.
- **attack-section flake under load (review-003.md:18, :26):** the worker-phase full `tests/project-workflows` config exited 1 with two timeouts in unowned specs — `attack.spec.ts` `[scenario:attack-section]` ("Protocol error … session closed") and the known `controls.spec.ts` `[scenario:controls-unavailable]` (page.goto timeout). All 14 dispatch scenarios passed; the gate deferred the browser check. Report, do not edit (the verifier refuses Playwright retries).
- **Phantom [L12] note-5 defect (review-003.md:19):** the V24 bullet above records that "the single-workflow fallback can mislink a run of a clone mate", but the server sets `ahead_commits[].run_id` only for this project's own run directories, so a clone mate's run arrives with `run_id` null and the fallback only ever names this project's own runs — the recorded defect cannot occur. The real mislabel is the V24 P2 above; treat the note-5 line as a phantom to drop, not a defect to chase.
- **V23 no falsifying check (review-003.md:21):** the new dispatch-dock band and the beside/under assertion pass on the base's old `@media (min-width: 1680px)` rule too (under Playwright's hidden scrollbars the chart is ≥494px at 1680px); nothing asserts that the column count comes from the body's width (a container query) rather than a viewport media query, e.g. by narrowing the body without changing the viewport.
- **V24 rendered behaviour untested (review-003.md:22):** no test renders AheadPane with an unresolved run, so nothing checks the visible "<run-id> · older than the newest 50 runs" text (vs a link or title); dispatch-ahead never asserts each landing is a link built from its own `workflow_id` (`landingHref`); the single-workflow clone-mate mislink has no check.
- **V25 only partly asserted (review-003.md:23):** the failed-list case checks only the "Runs not read:" prefix, not that a reason follows; the "some but not all failed, with waiting/running runs listed, then ' · N feature(s) cannot be read'" case has no test (Trio and candidate Widgets have no waiting/running runs); the `projectRuns.status 'error'` branch is not exercised.
- **V29 sha check may not fail (review-003.md:24):** dispatch-chart measures ui-polish-001's `.dispatch-res code` at 1100px, but the wrap the critique saw was in ui-polish-003's longer row ("on local main, not on origin/main"); no hand-break or base failure is reported and `.dispatch-run-2 code` is not measured, so removing `white-space: nowrap` may leave dispatch-chart green.
- **Ahead pane in the loading/failed window (review-003.md:25):** with `projectRuns=[]` while the lists load or after they fail, `resolveRunWorkflow` returns null on a multi-workflow project (Widgets), so opening the Commits ahead pane then labels even the newest run (ui-polish-001) "older than the newest 50 runs"; no test covers the ahead pane in that state.
- **Needs qualifier orphaned dot (review-003.md:28, critique):** on a project with some unreadable features the " · N feature(s) cannot be read" qualifier wraps onto its own line, starting with an orphaned middle dot; the wording matches the spec, the layout is the issue (Widgets, Trio).
- **Phone pane scroll/dash (review-003.md:29, critique):** at 390px the open reading pane is a nested scroll region with its own scrollbar, the NEXT STEP lead wraps as "Likely next step" / "— import the independent review" with the dash starting a new line, and the CommandBlock command is clipped behind a tiny horizontal scrollbar. It works but is cramped and the dash looks like a glitch.
- **1280px docked chart under 480px (review-003.md:30, critique — observation, no broken flow):** docked at 1280px the chart is 475px with the GitHub column stacked, under the 480px floor; the container-query rule is satisfied, so this is recorded as an observation, not a broken promise.

### Fixed in run 003 (for reference)

- **V1 dock band (review-002.md:20):** dispatch-dock gained the 1600–1760px band and the beside/under column placement by value (V23). Residual coverage weakness tracked as review-003.md:21 above.
- **V5 link hrefs / all-clear (review-002.md:23):** dispatch-sections asserts the Busy waiting/running links' hrefs, and V25 adds the failed and loading run-list cases. Residual tracked as review-003.md:23.
- **V2 command by value (review-002.md:21):** V27's dispatch-pane asserts the pane's CommandBlock command text equals the selected run's NextStep command by value. The loading/failed run-detail state stays open above.
- **V12 open-pane targets (review-002.md:28):** V31 adds the open reading pane (Close, Open run page, Queue, CommandBlock buttons) to the phone 44px scan, before Queue closes it. The Projects page cards stay open above.
- **V30 filter "0 runs" (review-002.md:44):** a filter matching none of a feature's runs shows "0 of N runs match" in the group header (StepChart.tsx:219).
- **NEXT STEP duplicate sentence (review-002.md:45):** the `dispatch-pane-next-lead` paragraph is removed (V27); the CommandBlock states the next step's label once.
- **Local-commits pane focus (review-002.md:49):** Escape and Close on the ahead pane return focus to `dispatch-ahead-button` (ProjectPage.tsx:128, V28), as the run pane returns it to the row.
- **"N opens" count and PULL REQUESTS wrap (review-002.md:47):** the open count reads "N open" (GithubColumn.tsx:194) and `.dispatch-gh-title` is `white-space: nowrap` (dispatch.css:177), so the heading never splits (V29). The "1 name a run" agreement stays open above.
- **1100px sha wrap (review-002.md:50):** `.dispatch-res code, .dispatch-run-2 code` are `white-space: nowrap` (dispatch.css:128, V29). Residual coverage weakness tracked as review-003.md:24.
- **Both phases verified (review-002.md:37):** [L7] now requires each lane to run both the worker and candidate phases of its browser specs before completing, so run 003 ran dispatch.spec.ts in both; the run-002 concern that the repaired spec was proved in one phase no longer applies.

## Other open (from run 002, not a review-002/003 P2 finding)

- **`on_source` landing** is a follow-up: a contract field for an integrated run that fast-forwarded only its source branch, so the page could say "landed on its source branch" instead of reading false on both default refs. Needs an Appendix A change (a `question`, out of this lane).
- The real `gh` path is still unexercised by a check (the operator's tryout covers it; also review-003.md:27 on the server lane).
- `controls-unavailable` in `controls.spec.ts` and `[scenario:attack-section]` in `attack.spec.ts` (neither owned) time out under load; the verifier refuses Playwright retries — report, do not edit ([L15]).
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
- `tests/project-workflows/dispatch.spec.ts` — the 14 `[scenario:dispatch-*]` browser scenarios.
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
- Browser (worker phase): the 14 dispatch scenarios pass, and the full worker-phase suite passes (migrated specs included).
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
