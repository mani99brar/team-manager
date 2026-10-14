# PRD: UX critique fixes, stage C (`ux-critique-fixes-c`)

Status: grilled (`~/.local/state/cook/ux-critique-fixes/stage-c/grill/q1` to `q6`). The panel chose each question's **Recommended** option (q1 by Jev on a split, q2-q6 by agreement); the answers are [O15]-[O20] in `decisions.md` and their details are applied here. Every requirement a grill question decided names the question. Five points where the q3, q4 and q5 texts differed were settled afterwards (q3 by Jev for Claude's text; q4 by the operator for GPT's text, q5 for Claude's; operator-decisions.md [O14], `stage-c/grill/CONFLICTS.md`) and are applied here. Base: stage B's integrated sha (feature `ux-critique-fixes-b`, which includes stage A). The engine feature `workflow-collected-fixes` integrates separately; its CLI shapes are this stage's interface ([O14]). The facts this PRD takes from stages A and B and from the engine feature's result are listed in `~/.local/state/cook/ux-critique-fixes/stage-c/ASSUMPTIONS.md` and are re-checked at the base before launch. Source: the Astra + Fable critique of the live dashboard (`~/.local/state/md-manager-ux-critique/2026-10-13/merged.json`, ids M1-M36), the collected issues (`~/.local/state/cook/ux-critique-fixes/intake/intake-final.json`), the operator's review and the decisions in `decisions.md` ([O3]-[O14]). This feature is **stage C**, the last of three ([O9]). File:line pointers are at 44b9c24 unless they say otherwise; stages A and B moved many of them, so workers find code by name.

## 1. Problem

The operator's words: "No filteration for runs, running should be show on top be default and readibility sucks." Stages A and B made the lists truthful, filterable and ordered and the run page readable. Stage C takes what is left:

- **Small type.** Rail sub-lines, card lines, run-row step lines, chart axis labels, attempt counts and "ended here" rows are 10-12.5 px and stay that size on a 390 px phone (M6; 114 declarations under 13 px across the stylesheets at stage B's sha, and `App.css:326` shrinks every `<code>` in the Projects shell to 0.85em, about 10.6 px inside 12.5 px lines). DESIGN.md itself sanctions 12.5, 12 and 11 px (`:57-80`, `:227-231`, `:282-285`).
- **The skills home opens on nothing.** Two circles and five disabled file buttons (M30).
- **GitHub and spend wording.** Every project card and three project-page cards repeat "GitHub not read: not a GitHub remote"; every project header ends with a hard-coded "spend not recorded" (M31).
- **Chart words.** The narrow axis reads "Chal. Lau. Frz. Ver. …" with no legend; the "ended here" row shows bare digits (M32).
- **About 90 requests every 15 s.** Each Projects page reads one workflow list per project, one or more run pages per workflow and the dispatch overview, polled every 15 s; a truthful rail took 3-4 s on localhost (M15). Triage's search cannot reach a run older than 7 days whose feature the operator does not know: its registry-wide all-time view waits on this route ([O12]).
- **Server defects** from the collected issues: a passed-gate packet forwards its error unredacted (GH6); reuse evidence is never served (GH7); a controller under a systemd scope dies whole on one OOM kill (RLI21); the viewer guard for stale task errors does not read `next` (GH3's viewer half); no server test pins that a challenge rerun keeps the run list loading (GH12's server half); GH4 is to be closed with its record.
- **Recovery needs the terminal.** A lane whose launch died and a host failure across lanes have controller commands since the engine feature (`relaunch`, `retry --all-failed`), but no run control (RLI16, RLG24 server halves).
- **The root Playwright suite gates nothing.** No feature policy runs `tests/*.spec.ts`, and the root config would also sweep the 26 project-workflows specs (GH8).

## 2. Users and surfaces

One operator, on a desktop browser (phone work is out of scope, [O3]; M6's 14 px phone size is the one phone rule this stage writes, because it is part of the approved M6 fix). Surfaces: every Projects page and the skills home (type, lane `polish`); the skills home (M30, `polish`); the Projects cards, the project page's GitHub column and the step chart (M31 wording, M32, `polish`); the rail, the cards and Triage's data source, Triage's "All time", the project header's spend figure, the run controls and the run, result and event routes (lane `server`). The viewer stays read-only toward runs except through the run controls, which call the controller's CLI as `--by operator` and never edit run files.

## 3. Goals

1. Everything the operator reads is at least 13 px on a desk and 14 px under 720 px, except uppercase labels (at least 11 px); DESIGN.md's type scale says so.
2. The skills home opens on something readable, with no disabled buttons on the first screen; the root suite gates it.
3. GitHub's state is said once, in plain words; the project header states a real spend figure or says honestly that none was recorded.
4. The chart never shows an abbreviation without its meaning; counts say what they count.
5. The rail, the cards and Triage read the registry in one request per poll (the overview is its own request, and the project and feature pages keep their own reads, grill q1) and poll slower when nothing runs; Triage can search every run of every project.
6. The server items GH3 (viewer), GH4, GH6, GH7, GH12 (server test) and RLI21 are closed with tests; the run page offers "Retry all failed checks" and "Relaunch a lane" through the controller's own CLI.

## 4. Non-goals (stages A and B, other features, rejected)

Reviewers: these are planned, not gaps. Do not raise them as missing.

- **Stages A and B** (integrated; the base): every behaviour they built stays, and their scenarios and unit tests stay green. Stage A's classification ([O4], stage A's [O13], [O14], [L3]) and stage B's comparator, filter model, scope strings and URL keys are unchanged except where this PRD adds the "All time" source and its scope pair (section 7.1).
- **The project page and the feature page keep their per-workflow reads** (grill q1): the project page reads the first page of each feature and keeps stage B's scope line; the feature page reads its cursor pages. Only the rail, the cards and Triage switch to the aggregate route.
- **A served `situation` or `follows` field** (stage A's open items "interrupted case (c) never reaches a list row" and the failed-interrupted case of [O13]) is not built in this stage ([G15]).
- **No change under `workflow/`, `docs/BACKLOG.md`, `workflow/RUNBOOK.md` or `workflow/README.md`** ([O9]): the engine lane wrote the rows for GH8, RLI21 and the two run controls, marked "(from ux-critique-fixes-c)"; stage C lanes put their sentences in their handoff docs.
- **No change under `contracts/workflow/`**: the engine's deferred schema items (a sidecar reason `enter_not_submitted`, a disk `transient` value, the panels `budget_usd` default) stay deferred ([G15]).
- **Rejected by the operator (phone):** M11, M12, M13, M24, M25, M26, M34; M30's "(always on phones)" clause. DESIGN.md's phone rules stay ([O5]) except M6's 14 px size; existing phone assertions stay green.
- **No dock "Run" button for the new controls**: no served next step names `relaunch` or `--all-failed`, so `controls/model.ts` `matchStep` is unchanged.
- **No real `systemd-run` or OOM kill in any test**: RLI21 is proven by its argv; the manual probe is the operator's (Deferred).
- **GitHub writes**: closing issues #3, #4, #6, #7, #8, #12 and others is the operator's call; no lane touches GitHub or pushes.
- **No new dependency.**

## 5. Lanes and the contract between them

Two lanes run in parallel and meet only at the candidate (`policy.json` lists the owned paths):

- `polish` (claude-sonnet-5-5, effort medium, skill `impeccable`): M6 (the type floor, every stylesheet and DESIGN.md's scale), M30, M31's GitHub wording, M32, GH8, and the carried desktop fixes ([O21]). It owns `DESIGN.md` in this stage and writes every amendment of section 8, both lanes' ([O5]).
- `server` (claude-opus-5-5, effort medium): M15 with Triage's "All time" (M3's last part, [O12]), M31's spend field and its figure, the run controls "Retry all failed checks" (RLG24) and "Relaunch a lane" (RLI16), RLI21, GH6, GH7, GH3's viewer guard, GH12's server test, GH4's record and the carried list fixes (7.9, [O21]). It owns `contracts/`.

Why the spend figure belongs to `server` (grill q3): a field one lane serves and another renders cannot be built in either worktree (the type does not exist in the renderer's), so the lane that serves `spend` also owns `dispatch/ProjectPage.tsx`, where the figure is shown. `polish`'s M31 work is the GitHub wording, which lives in `dispatch/GithubColumn.tsx` and `dispatch/ProjectsPage.tsx`.

Review and repairs (stages A and B, carried as [G2]): each lane has one GPT 6.1 lane reviewer (pi, 1 round, 15 min). Only a P0/P1 the lane reviewer ties to a line the lane changed starts a repair round; P2/P3 lane-review findings go into the lane's handoff doc (`docs/handoff/ux-fixes-c-polish.md`, `docs/handoff/ux-fixes-c-server.md`) and never spend a repair. Lane review may use up to 2 of the run's 3 repairs. No `panels` review.

Closed set of shared modules (each lane keeps the other's uses working; a test of each lane proves its side):

| Module (owner) | Used by the other lane | Rule |
|---|---|---|
| Every stylesheet `polish` owns (section 6) | `server`'s new elements (Triage's "All runs" list, the relaunch preview, the spend figure) use existing classes only | No class, custom property or selector is renamed or removed; only sizes, line heights and the rules M6, M31 and M32 name change. `server` adds no CSS file and no class that needs a new rule; a style it cannot get from existing classes goes into its handoff. |
| `dispatch/phases.ts` (`polish`) | `runFilter.ts` (`server`) maps a focus to a phase with `PHASES` and the phase map | `PHASES`, `phaseOf`, `CHART_COLUMNS` and their outputs unchanged; `PHASE_SHORT` may change; a legend helper is a new export. |
| `dispatch/StepChart.tsx`, `dispatch/GithubColumn.tsx` (`polish`) | mounted by `dispatch/ProjectPage.tsx` (`server`) | Props unchanged; every test id stage B's `project-collapsed`, `dispatch-*` scenarios read stays. |
| `dispatch/ProjectsPage.tsx` (`polish`) | mounted by `ProjectsView.tsx` (`server`) | Props unchanged (`cards`, `overview`, `repositoryCount`, `runsReadAt`, `runsError`, `onNavigate`). |
| `dispatch/types.ts`, `dispatch/client.ts` (`server`) | `GithubColumn.tsx` and `ProjectsPage.tsx` read `GithubState`, `GithubStatus`, `DispatchOverview` | Every existing type and field unchanged; `spend` and the runs-route types are additions. |
| `src/App.tsx` (`polish`) | mounts `ProjectsView` (`server`); stage B's Projects history (`?search` on Projects pathnames, `onNavigate`) | Only the skills home's initial `expanded`/`mode`, Reset's view and the file-operation group change; every Projects history behaviour and `onNavigate(pathname)` stay byte-identical; stage B's keep-search unit test stays green. |
| `lists.ts`, `routes.ts`, `runFilter.ts` (`server`) | stage B's run lane code (`servedNow`, `stoppedLabel`, `monthDay`) | Every existing export keeps its signature and output, except 7.1's `DATE_CHOICES.triage` gaining `'all'` and a new `ScopeKind`, and 7.9's capped scope string; new exports beside them. |
| `usePoll.ts`, `useResource.ts`, `LiveStatus.tsx` (`server`) | `RunView`, node pages, `IdentityLine.tsx` and `RunHeader.tsx` (frozen callers) | Existing signatures and behaviour for every existing caller unchanged; a variable interval and `LiveStatus`'s optional `pollMs` prop are additions. |

Frozen in stage C (no lane edits them; both read them): `src/projects/time.ts`, `tone.ts`, `panels.tsx`, `status.ts`, `steps.ts`, `CommandBlock.tsx`, `NodeDetail.tsx`, `NodeHeader.tsx`, `StepStrip.tsx`, `ReviewDetail.tsx`, `SectionIndex.tsx`, `Assignment.tsx`, `WorkerInputs.tsx`, `RunView.tsx`, `RunHeader.tsx`, `NowBanner.tsx`, `RunRow.tsx`, `pins.ts`, `useNow.ts`, `findings.ts`, the TypeScript files of `signal/`, `sessions/`, `node/` and `ui/`, `dispatch/{Rail.tsx,ReadingPane.tsx,AheadPane.tsx,common.tsx,derive.ts,format.ts,projectModel.ts}`, `workflow/`, `docs/BACKLOG.md`, and `tests/project-workflows/{fixtures.ts,playwright.config.ts,harness.ts,sessionProjection.ts}` and every spec neither lane owns (`sessions-parity.spec.ts`, `lanes.spec.ts`, `reviewers.spec.ts`, `inputs.spec.ts`, `ux-refine.spec.ts`, `guardrails.spec.ts`, `ux-review.spec.ts`, `ux-node.spec.ts`, `review.spec.ts`, `panel.spec.ts`, `critique.spec.ts`, `clarity.spec.ts`, `ux-verify.spec.ts`, `ux-launch.spec.ts`, `sidecar.spec.ts`, `attack.spec.ts`, `accepted.spec.ts`, `ux-time.spec.ts`, `ux-run.spec.ts`, `revamp-pages.spec.ts`, `sessions.spec.ts`). A failure there caused by a lane's change is fixed in that lane's own code.

DOM hooks each lane keeps for specs it does not own:

- `polish` keeps every test id, class and accessible name that stages A and B assert (its change is sizes and the words M30, M31 and M32 name). Measured limits in specs it does not own still hold after the type change: the run page's one-line Sessions cue (at most 40 px tall, never wrapping at 1024 px and wider), table rows at most 56 px, the 44 px controls at 390 px, the identity line, the dock's bar, the one-line GitHub column at most 48 px tall (`project-collapsed`, `revamp-lists.spec.ts`), no sideways scroll at any width, and the overview chips' at-most-two-line labels (stage B's `graph-readable`). A failure there is fixed in `polish`'s CSS, never by editing the spec.
- `server` keeps stage A's and B's Triage, rail and card hooks (the section test ids, `a.run-row[data-run-id][data-status]`, `data-attention`, `home-quiet`, `lists-incomplete`, `crumb-row`, `dispatch-card-live`, the bar's controls and scope line, the URL keys), `dispatch-figures` with its existing figures, and every control test id (`controls-list`, `control-<id>`, `control-reason`, `control-<id>-button`, `dialog-*`, the clean preview's ids).

New fixture runs go only into the `server` lane's fixture modules (`policy.json`); existing fixture runs are never changed. `server` owns the harness files (`mock.ts`, `seed.ts`, `support.ts`, `fixtures/index.ts`, `dispatch-app.ts`, `controls-app.ts`) and may only add to them. `polish` adds no fixture run; a GitHub state the seeds do not serve is answered with `page.route` on the overview in both phases.

## 6. Requirements: lane `polish`

### M6 The type floor (P1; [O5])

- **The rule.** Every element the operator reads has a computed font size of at least **13 px** when the window is 720 px wide or wider and at least **14 px** under 720 px, except an element whose computed `text-transform` is `uppercase` (a label), which is at least **11 px** at every width. It covers the Projects shell (Triage, the rail, the cards, the project page and its chart, the feature page, run, node and Assignment pages, the dock, the sheet, the controls panel and dialogs, the sessions table) and the skills home.
- **Exempt, by design ([G6]):** text drawn inside a zoomable canvas whose on-screen size follows the zoom: the run stage's graph cards and chips (`signal.css` `.n-chip`, `.n-meta`, `.n-word`, `.n-last` inside `run-stage`) and the skills graph's SVG labels (`App.css` `.node .label`, `.unavailable-tag`, `.empty-tag`). Stage B's M8 settled their legibility (the 0.6 floor, two-line overview labels); a size change there would re-open `graph-readable`. Their sizes stay.
- **Where.** The 114 declarations under 13 px at stage B's sha are in `dispatch/dispatch.css` (42), `signal/signal.css` (23, of which the stage-graph ones are exempt), `run.css` (16), `App.css` (9), `node/*.css` (8), `sessions/sessions.css` (6), `lists.css` (4), `theme.css` (3: `.ui-chip` 12, `.ui-sev` 11, `.ui-figure-label` 11 uppercase), `critique.css` (2) and `assignment.css` (1); about ten of them are uppercase labels (at 44b9c24: `App.css:324`, `critique.css:8`, `dispatch.css:35,98,112,211`, `lists.css:13,75`, `node/review.css:36`, `theme.css:66`) and may stay at 11-12 px. `App.css:326` (`.projects-facts code, .workspace-projects code { font-size: 0.85em }`) is replaced so every `<code>` in the shell is at least 13 px. A severity chip (`.ui-sev`, `.ss-sev`) is not uppercase by transform and moves to 13 px. The phone size is one rule per stylesheet under `@media (max-width: 719px)` (DESIGN.md's phone width), never per element.
- **No layout change beyond what larger type needs:** line heights may follow; nothing is hidden, truncated or moved to make room; a row that grows past a measured limit in another lane's spec (section 5) is fixed with spacing, never by shrinking the text below the floor.
- **DESIGN.md** (section 8): the `typography:` block and the Hierarchy and Components lines that state sizes are rewritten to the floor.

Acceptance: a unit test `tests/unit/typeFloor.test.ts` (new; no existing file covers stylesheets) reads every `.css` file under `src/` and rejects a `font-size` (or `font` shorthand) below 13 px (rem at 16 px; `calc(<n>px * …)` read as `<n>px`) outside a rule that also sets `text-transform: uppercase` and outside the exempt selectors, and a `font-size` in `em` below 1 on a `code` selector; under the `max-width: 719px` query, a size below 14 px outside the same exceptions. Scenario `type-floor` (browser, both phases).

### M30 The skills home opens readable, and the root suite gates it (P2; GH8; grill q6)

- **First view** (grill q6, `expand-one-level`, [O20]): on load, with no click, the graph (`mode` `graph`) opens with both sources expanded exactly one level.
  - Every configured location shows as a node with its counts. The locations come from the loaded data, never hard-coded to this machine's five locations. No folder or file node is expanded or shown.
  - At 1440x900 every location node lies inside the graph canvas with no scroll or zoom change.
  - The initial `mode` and `expanded` are constants, with no window-width or user-agent branch, so the same first view holds at 1440x900 and 360x640 ([O3]: "always on phones" is rejected phone work).
  - Reset returns to that view and announces "Reset: showing the Pi and Claude sources and their locations."
  - Outline stays one click away. It shows the same expansion and selection, and returns to the graph with the view and the selection unchanged.
- **File operations** render only while a source, location, folder or file is selected, and then only the operations that apply to the selection, each enabled under the existing capability checks: New file and New folder where `canCreate` holds, and Rename, Move and Delete on a folder. No disabled file button is ever shown. No mutation permission is broadened, and the existing operation handlers and safeguards are unchanged. The graph controls (Refresh, Zoom in, Zoom out, Fit, Reset, Outline) keep their names and order and stay in the viewport at 360 px. The skills graph's SVG label sizes stay ([G6]).
- **GH8, the root suite.** The root `playwright.config.ts` gains `testIgnore: ['**/project-workflows/**']` (Playwright matches absolute file paths), so `npx playwright test --config=playwright.config.ts --list` lists only the 12 root specs. The lane's policy gains the browser check `root-browser`: `env MD_MANAGER_API_PORT=3014 MD_MANAGER_WEB_PORT=5184 npx --no-install playwright test --config=playwright.config.ts` (the verifier appends its reporter, output, `--workers=1` and `--retries=0`), with scenario `skills-home` tagged in `tests/graph.spec.ts` (root specs have no `[scenario:]` title or screenshot helper today: the lane adds the tag and one `testInfo.attach('screenshot:skills-home', …)`). M30 is itself GH8's acceptance "a deliberate default-mode change in App.tsx turns the check red": the six landing assertions fail on the new default until rewritten.
- **Rewrites, not deletions.** `graph.spec.ts`'s landing assertions (`visibleNodeIds` equal to `['Pi','Claude']` at `:37,104,176,227,276,314`, the Reset announcement) and any root spec that clicks a source to expand it (`openGraph` users: `document`, `operations`, `document-history-review`, `locations`, `document-failure`, `document-review`, `listing-refresh`) are rewritten to the new first view, asserting at least what they asserted; a helper in `tests/helpers.ts` may return the graph to the collapsed view where a test needs it. The landing assertions check the location node ids by value, from the suite's generated `sources.json`, not merely that Pi and Claude are present, so each one fails on the old collapsed default. An assertion that a file button was disabled before a selection becomes one that it is absent. `zz-fixtures-clean.spec.ts` keeps running last.

Acceptance: scenario `skills-home` (check `root-browser`); every root spec passes in that check; the handoff records the base run, the red run on the new default before the rewrite and the green run, and `npx --no-install playwright test --config=playwright.config.ts --list` naming exactly the 12 root spec files; the check's report holds no test from `tests/project-workflows/` (a swept project-workflows spec would fail without its harness, so a green check also proves the `testIgnore`).

### M31 GitHub wording (P3, the UI part; the spend figure is `server`'s, section 7.3)

- A project whose GitHub status is `not_github` reads **"no GitHub remote"**: once in its card's foot on the Projects page, and once on its project page in the GitHub column's one line (stage B's M7 made it one line); its Pull requests and Issues cards do not render. "GitHub not read: not a GitHub remote" appears nowhere.
- Any other not-read status (`unavailable`, `pending`, `off`) is said **once** per page with its served reason: on the project page "GitHub not read: <reason>" in the GitHub column (`off`: "GitHub reads are turned off"), with no separate Pull requests and Issues cards repeating it; on a card, in its foot, as today. A `read` status with a refresh `reason` keeps its data and states the reason once.
- The Projects page meta line: "GitHub read <time>" when any project was read; when none has a GitHub remote it says nothing about GitHub; otherwise "GitHub not read".
- Acceptance: scenario `github-wording`; `dispatch.spec.ts` `dispatch-overview` (`:44`) and `dispatch-github` (`:314-329`) rewritten to the new words, asserting at least what they asserted.

### M32 Chart words (P3)

- **"Ended here"**: every non-empty count cell reads "<n> ended at <phase>" with the full phase name of its column ("<n> landed" under Integrate), wraps inside its column and is never cut; the row label "ended here" stays (`dispatch.spec.ts:173`); its accessible name equals its text.
- **The axis** shows the eight full phase names wherever they fit. Where the chart's container is under 640 px (the `@container dispatch-chart` rule), the axis may show `PHASE_SHORT` only together with a visible legend under the chart naming each short form with its full name ("Chal. Challenge · Lau. Launch · …"). The complete legend may wrap within the chart container; no entry is clipped, ellipsized or scrolled sideways, and no label reads "…". Axis alignment and the type floor are unchanged.
- Stage B's `dispatch-axis` alignment (the Verify count centred under its column at 1440 and 1100 px) still holds.
- Acceptance: scenario `chart-words`, which also asserts at the narrow desktop container width that every legend entry is visible inside the chart container with its full name, not clipped (`scrollWidth <= clientWidth`), without ellipsis and without sideways scroll; `tests/unit/dispatch.test.ts` `PHASE_SHORT` cases (`:116-121`) kept or updated with the legend helper's output.

### Carried desktop fixes ([O21])

Desktop gaps of approved findings carried from stages A and B, in files this lane already edits ([O21] has the full wording); no policy, scenario or owned-path change:

- **C6 (M29):** the live chip's watching dot is neutral (`lists.css` `.live-status-watching`); `LiveStatus.tsx` is untouched.
- **M21:** the Sessions table's header columns line up with the Claude rows' cells, and `.ss-resume-cmd` gets a fitting flex-basis (`sessions.css`, CSS only).
- **M23:** `run-branch` is not cut, and at 1440 the dock's Now message is not squeezed beside its Open link (`signal.css`, CSS only).
- **M7 (`StepChart.tsx`):** run rows carry meaningful identities, never a bare numeric suffix; definition folds are named by their features; landed chips have unique keys and visible separation. The state word follows the unfiltered outcome only if `FeatureGroup` already supplies it; no cross-lane prop.

Acceptance: untagged tests in `tests/project-workflows/dispatch.spec.ts` (which may open Triage, a run page and its Sessions table) or `tests/unit/dispatch.test.ts`, in both browser phases, reject a toned watching dot, misleading run-row identities, unnamed identical folds, duplicate chip keys or joined hashes, and clipping or header/cell misalignment at desktop widths. A part that needs frozen markup or a new prop stays open in the handoff and `## Deferred`, never reported as done.

## 7. Requirements: lane `server`

### 7.1 M15 One request for the rail, the cards and Triage, and Triage's "All time" (P2, and M3's last part, P1; grill q1, q2; [O12])

- **The home route** (grill q1, `summary-rows`): `GET /api/dispatch/runs?since=<ISO 8601 Z time>` returns, in one response, exactly what `fetchRegistryRuns(projects, readsNextPage(since))` assembles today: for each registered project its workflow list as `GET /api/projects/:p/workflows` serves it (or that read's error), and for each workflow the run summaries of its first page (`DEFAULT_RUN_LIMIT`, `compareRuns` order) and of each further page while the previous page's last run has `updated_at >= since`, with that workflow's remaining `next_cursor` (null when all read) or its read error. A run whose storage is invalid fails its workflow's entry only, as `listRuns` fails that workflow's route today. It never filters a row to the cutoff and never replaces summaries with server-computed counts ([O15]). A missing or malformed `since` is 400 `INVALID_SINCE`. The response carries `contract_version` and `read_at`.
- **The registry pages**: `GET /api/dispatch/runs/all?cursor=&limit=` returns `{runs, next_cursor, unreadable}`: every run summary of every readable workflow of every registered project, in one total order (`updated_at` newest first, then `project_id`, `workflow_id`, `run_id`), `limit` 1-100 (default 50) (400 `INVALID_LIMIT` otherwise, never clamped), with a base64url registry cursor (`{v, u, p, w, r}`) that a malformed or foreign value turns into 400 `INVALID_CURSOR`; `unreadable` lists `{project_id, workflow_id, code}` for each workflow that could not be read. Only Triage's "All time" reads it. Both routes are GET/HEAD only (405 otherwise, the dispatch routes' loop), parse their own output against their schemas before sending, and are added to `dispatchSchemas`, `examples.ts` and the exported `*.schema.json`.
- **The client switch.** The rail, the Projects cards and Triage (its sections, counts, Pinned rows and the tab title) read the home route instead of `fetchRegistryRuns`; their inputs are the same rows, so stage A's classification, stage B's comparator and every count are computed by the same functions. The project page and the feature page keep their reads (section 4). "One request" means the registry home read: the overview is its own request, and the project and feature pages keep their own reads ([O15]). The home read and the dispatch overview poll every 15 s (`LISTS_POLL_MS`) while any row read is running or needs the operator, and every 60 s otherwise (a new exported `LISTS_IDLE_POLL_MS`); a run that starts running brings the 15 s cadence back on the next read. The resource key stays the same across polls and cadence changes, so the last rows stay on screen while a read is in flight (`useResource.ts:65` drops to `loading` only on a key change); a failed read keeps the last rows and shows stage A's not-read wording with its reason. Triage's live status (`RunsHome.tsx` renders `LiveStatus`, which today picks `LISTS_POLL_MS` itself, so `staleAfterMs` would read 45 s) is told the cadence in force through a new optional `pollMs` prop on `LiveStatus` (every other caller unchanged; `time.ts`'s `staleAfterMs(pollMs)` already scales with it), so it never reads "Not updating" between two on-time 60 s polls.
- **Triage "All time"** (grill q2, `all-runs-list`, [O16]; [O12]): Triage's date choices become exactly "Any date", "Today", "7 days", "All time".
  - **Reading.** Choosing "All time" reads the registry pages one after another until `next_cursor` is null. It sends one request per page and no other (no per-project or per-workflow read), and shows "Reading older runs… (<n> read)" while reading. The home poll keeps its cadence meanwhile. The pages are read again only on a reload or when "All time" is chosen again.
  - **A failed page.** It shows today's "The next page of runs" panel with Retry, and keeps the rows read and the filters. Retry requests only the failed page, never a page already read. "Load more runs" and Retry appear only when a page failed or a cursor remains.
  - **The All runs list.** While "All time" is chosen, the state sections (Needs you, Running, Today, Paused, Recent) are not rendered. One "All runs" list (`data-testid="all-runs"`) replaces them, with Pinned above it; Pinned may also list a run that is in the list.
    - It holds every run read, from the home window and the pages, each run once by `project_id`, `workflow_id`, `run_id`; when a run is in both, the home row wins.
    - Its rows are the same run rows, in the bar's sort (by default stage B's one ordering: running and waiting first) and filtered by the bar's status, phase and text controls.
  - **The scope line.** `runFilter.ts` gains the source as a new scope kind with one scope pair, where n is the unique runs read and k the matches:
    - "<k> of <n> runs · every project, all loaded" once no cursor remains and every page answered;
    - "<k> of <n> runs · every project · Load more runs" while a cursor remains.

    It never says "all loaded" after a failed page or while a cursor remains. A workflow that a page lists as `unreadable` is named as not read in Triage's Attention section (`lists-errors`, one card "<project> · <workflow>" with its code), kept while "All time" is chosen, so "all loaded" never stands as an unqualified claim of complete history ([O15], [O16]); `lists-incomplete`'s fraction only counts projects read ("<r> of <n> projects read; lists incomplete") and keeps that text (7.9 adds its link and workflow clause).
  - **Leaving and the URL.** Choosing another date restores the sections with no request. `routes.ts` writes `date=all` to the URL on Triage only (stage B's key set); it survives opening a run, Back and reload (a reload reads the pages again). `DATE_CHOICES.triage` gains `'all'`. At stage B's sha `parseListSearch` takes no surface and accepts `today, 7d, 30d, all` on every list (`dispatch/listState.ts`, owned by neither lane, calls it), so the lane adds a pure kind-aware read in `routes.ts` or `runFilter.ts` that turns a date a surface does not offer into `any`, applied in the surfaces it owns.
  - **Counts.** Stage A's classification is computed once over every run read, unfiltered. The tab title's "(n)", the rail and card badges and Pinned are computed from the home read. They never change with the date choice, even when an old needs-operator run is read from a page, and no date, search or sort change by itself changes them.
  - **Other pages.** The date controls of the feature page and the project page are unchanged.

Acceptance:
- `server/dispatch.test.ts`, over one seeded registry with several pages per workflow:
  - The home route equals the per-workflow routes' assembly, by deep equality, for three `since` values. One of them equals a page's last `updated_at` (the `>=` boundary). The comparison includes `next_cursor`, a workflow with an invalid run and a project or workflow read error.
  - The home route serves every row of each page it reads, with no cutoff filter and no server-computed count.
  - The registry pages cover every run exactly once, in the total order, across page boundaries and ties, with `unreadable` listed.
  - 400 for `since` and for a malformed or foreign cursor, and for an invalid `limit`; 405 for POST; `contract.test.ts` examples.
- `tests/unit/lists.test.ts`:
  - the cadence helper: 15 s with a running or waiting row, 60 s otherwise;
  - the "All time" scope pair: never "all loaded" while a cursor remains or after a failed page, and n counts unique runs;
  - dedupe of a run read twice, the home row winning;
  - the merge never changing a classification;
  - a filter, date or sort change never changing the counts or the pinned set.
- `tests/unit/routes.test.ts`: the kind-aware read keeps `date=all` on Triage and reads it as `any` on a surface that does not offer it (the project page).
- Scenarios `one-request` and `triage-all-time`.
- Every stage A and B test that shapes Triage's data with `page.route` on a workflow run-list route (`revamp-lists.spec.ts`'s `isRunList` routes and `editRunLists` helper: `triage-loading`, `rail-state` and Triage's untagged siblings; `triage-desktop` itself routes nothing) is moved to the home route, asserting at least what it asserted; the worker-phase mock serves both routes from the same fixture runs it serves per workflow.

### 7.2 Triage, rail and card hooks stay

Every stage A and B scenario over Triage, the rail and the cards (`triage-attention`, `triage-loading`, `triage-desktop`, `rail-state`, `run-times`, `triage-pins`, `live-first`, `triage-filters`, `list-state-url`, `dispatch-*`) passes in both phases on the new source.

### 7.3 M31 The project spend (P3, the field; grill q3)

- **The field.** The dispatch overview's project entry gains `spend: {claude_usd: number | null, priced_runs: number, runs: number} | null`. It is added `.nullable().optional()` under the 1.10.0 rule, the server always sends it, and it gets an example and an exported JSON schema. The served per-workflow `RunSummary` gains no field ([O17]).
- **What it counts.** It covers every run of every readable workflow of the project: the whole workflow directory, never a page or cursor window, and independent of paging, dates and filters.
  - `runs` counts the runs.
  - `priced_runs` counts those whose export carries a non-null `costs.total_usd`. A recorded 0 is priced; a run with no `costs` or a null total counts in `runs` only.
  - `claude_usd` is their sum rounded to 6 places, null when `priced_runs` is 0.
  - `spend` is null only when the project's workflow list cannot be read ([O17]). A workflow that cannot be read counts in neither `runs` nor `priced_runs`, and the overview's existing report of that workflow's read failure stays.
- **Where it comes from.** It is read from the export's `costs` section (`workflow/costs.py`), in the `run-state.json` that `listRuns` already reads and caches. The cached run summary keeps the total, so a warm overview poll reads no `run-state.json`. No new file is read, and the sessions totals (`server/sessions.ts`) are not read.
- **The figure.** The project header's figures show it in place of the literal "spend not recorded":
  - "$<x> Claude spend · <k> of <n> runs priced", with x to the cent from the served value ("$0.00 Claude spend · 1 of 1 runs priced" when every priced run recorded 0);
  - "no Claude spend recorded" when `priced_runs` is 0;
  - nothing while the overview is unread, or when `spend` is null or absent.

  It is never a covered (pi) estimate, never summed with one, and never called equal to a run page's Spent, which also counts repair, critique and pi sessions. The wording is a pure helper (`src/projects/dispatch/spend.ts`, new).
- **Acceptance:**
  - A server test seeds exports with and without `costs`, a null total, a recorded 0, a covered-only run that adds nothing, an unreadable workflow, a project of 60 runs and two projects. It rejects:
    - a page-limited total (60 runs priced as 50);
    - totals mixed across projects;
    - a missing or null cost counted as priced, or a recorded 0 counted as missing;
    - a covered estimate included;
    - a `run-state.json` read on a warm cache hit (a counting fs or a spy);
    - a stale total after the cache invalidates;
    - one unreadable workflow nulling a project whose other workflow was read, or the unreadable workflow's runs counting in `runs`.
  - `tests/unit/spend.test.ts` (new) tests the wording: rounding to the cent, 0 priced, null spend, k of n.
  - Scenario `project-spend`, in both phases.
  - The seed writer (`seed.ts`) learns to write a `costs` section for the runs this lane adds: a priced project, a project with no costs, a null-total run and an unreadable-workflow case. `mock.ts` `mockDispatchResponse` serves `spend` computed from the same fixture runs.

### 7.4 Run controls "Retry all failed checks" and "Relaunch a lane" (RLG24, RLI16 server halves; grill q4, [O18]; [O14])

- **Two new control ids** appended after `clean`: `retry_all` and `relaunch` (`CONTROL_IDS` 14, `CONTROLS_VERSION` 1.1.0, the existing 12 in their order). These follow: the exact-length schema, `server/controls.ts`'s order check, the client's `ControlId`/`CONTROL_ORDER`, the worker-phase catalog in `fixtures/controls.ts`, the mock's control branch, `examples.ts` and the `[contract]`/`[offer]` tests.
- **`retry_all` "Retry all failed checks"**: short, plain confirm, no parameter; argv `-m workflow retry <run> --phase worker --all-failed --by operator`.
  - **Offer.** Available under Retry's rules (lock first, not abandoned, not finished) when `retryTargets` hold two or more distinct worker-phase lanes; candidate targets never count. Otherwise it is unavailable with "Fewer than two worker checks failed" ([O18]). There is no further offer condition, not even "automatic run": a controller refusal such as the manual-run `Blocked:` line is a failed record with that line first, as today.
  - **Record.** It shows the controller's output (one line per lane, then "Nothing ran. …"); its `effect` names Restart supervisor as what reruns them.
- **`relaunch` "Relaunch a lane"**: short, plain confirm, with a parameter `lane`.
  - **Choices.** The lanes whose `launch_<lane>` is in `next`, whose receipt `<lane>.interactive.json` is `needs_reconciliation` or absent, and that have no completion, handoff or stop file. The control is available under the lock rule when one lane qualifies, else unavailable with "No lane launch is waiting to be relaunched". This cheap-facts filter is a superset and never re-derives the controller's rule: for any lane in the list, the dry run's verdict is final.
  - **Preview.** Its dialog runs `POST …/relaunch-preview` for the chosen lane: body `{run_state_token, lane}`, argv `-m workflow relaunch <run> <lane> --dry-run --by operator`. Like clean-preview, it writes no record and checks the state token; it also keeps the existing control authorization, and a lane outside the choices is 400.
  - **Confirm.** Enabled only on exit 0 for the lane and token currently chosen. Changing either invalidates the preview, and a late answer for an earlier choice never enables Confirm. On any other exit, or a failed preview, the dialog shows the dry run's first output line verbatim (stdout's first line, else the `Blocked:` line from stderr) with Confirm off. An example is "relaunch ui: refused: session <id> ('done') carries the launch name …", the one-shot refusal of [L24]. No dry run runs on a controls GET.
  - **Confirmed relaunch.** It runs `-m workflow relaunch <run> <lane> --by operator` alone, through the existing single-argv runner with no shell. The mutation-time guards and the controller's final verdict stand: a preview never permits bypassing a later refusal. Its record shows "Relaunched <lane> once: …", "Continue the run with:" and the two lines. Its `effect` text names Reconcile and then Restart supervisor as the next two controls, which the existing rules then offer; neither runs automatically, so there is no chaining. A refusal ("Blocked: … Nothing was relaunched.") is a failed record with the `Blocked:` line first, as today.
- **An older controller.** Both controls are offered only when the controller at `MD_MANAGER_WORKFLOW_HOME` has the command. The server reads `-m workflow retry --help` and `-m workflow relaunch --help` once, at server initialization, against `MD_MANAGER_WORKFLOW_HOME`, and caches both results for the process, a failed read included ([O18]). No controls GET, the first one included, spawns a process. A non-zero exit, or a help text without `--all-failed`, means absent, and the read fails closed. An absent control is unavailable with "This controller has no `retry --all-failed` (workflow-collected-fixes is not merged)" or "This controller has no `relaunch` command (…)". So a viewer merged before the engine never offers a control its controller would refuse with exit 2, and a controller merged later is seen after an API restart.
- **[O10] amended for stage C** (grill q4, [O18]): the `server` lane owns `controls.spec.ts`.
  - Its one `toHaveCount(12)` becomes 14 wherever it sits (inside `controls-unavailable`, ASSUMPTIONS S10), and it adds its own tagged scenario.
  - `controls-unavailable`'s `test.slow()` and every other assertion stay byte-identical: the count is the only change to an existing test, and the diff adds only `controls-recovery` and its required untagged worker-phase older-controller sibling.
  - If `controls-unavailable`, which now loads two more pages, exceeds its slow timeout under load, it is reported in `untested`, not edited.
- **Acceptance:**
  - `server/controls.test.ts`:
    - the argv of both controls;
    - the offer matrix: one versus two worker targets, candidate-only targets, lock held, abandoned, finished, and a qualifying and a non-qualifying lane for each relaunch condition;
    - relaunch-preview: exit 0 and exit 1 shown verbatim, a stale token refused, no record written, a lane outside the choices 400;
    - a confirmed relaunch runs no reconcile or automatic command;
    - the capability read: an absent command makes the control unavailable with its reason; the two reads happen once, at app creation, with no repeated probe; no controls GET, the first one included, spawns anything (recording spawner);
    - the 14-id order: a length other than 14 or a changed order is rejected.
  - `tests/unit/controls.test.ts` for the client model, including a lane or token change invalidating the preview and a late preview answer never enabling Confirm.
  - Scenario `controls-recovery`. The older-controller case is a server test and an untagged worker-phase sibling test in `controls.spec.ts`, because the candidate phase runs one fake controller.
  - The fake controller in `fixtures/controls.ts` prints the engine's lines verbatim (ASSUMPTIONS E1-E6). "After which Reconcile is offered" proves the viewer's offer for the receipt state the fake leaves, and the server handoff states that the real continuation after a relaunch is the engine's own.

### 7.5 RLI21 OOMPolicy (server)

`systemdRunArgv` adds `--property=OOMPolicy=continue` before `--`, so one check's OOM kill no longer stops the scope and the supervisor in it (systemd 255 lists `OOMPolicy=` as a scope option). The two tests that compare the whole argv (`server/controls.test.ts` `[long]` and `[L6] 1`) are updated and a direct unit test asserts the property precedes `--`. `docs/handoff/run-controls-server.md` gains one sentence. Acceptance: those tests.

### 7.6 GH6 A contradictory passed packet is served as blocked (grill q5)

A gate-passed packet whose result status is not `succeeded`, or whose error is non-null, is contradictory and is served exactly as a blocked one: status `failed`, `error: {code: 'VERIFICATION_BLOCKED', message, retryable: true}`. The message is 'The gate passed but the result says <status>: <redacted error message>' when the error is non-null, and 'The gate passed but the result says <status>', with no colon and no tail, when it is null ([O19]). Every error message the result route forwards, passed or blocked, is path-redacted. A consistent passed packet (status `succeeded`, error null) is served byte-for-byte as today, and a failed-gate packet is served as today ([O19]).

Acceptance: server tests in `server/projects.test.ts` with a passed gate and:
- result status `failed` with an error message containing `/home/<user>/…`: no home path in the served message, status `failed`, code `VERIFICATION_BLOCKED`;
- result status `succeeded` with a non-null error: the blocked shape, never `succeeded`;
- a status other than `succeeded` with a null error: the blocked shape, with the message 'The gate passed but the result says <status>' (no colon, no tail);
- a consistent passed packet: its served body unchanged byte for byte.

The existing result tests stay green.

### 7.7 GH7 Reuse evidence is served (grill q5)

- **First, confirm the field.** Before seeding, the lane confirms that the controller writes a `reused_from` field into the candidate packet (`verification/candidate/<lane>/<n>/packet.json`; at stage B's sha `workflow/checks.py` `reuse_packet` writes `reused_from: {path, sha256}`), and names the file and field in the handoff. If no packet carries such a field, the lane stops with a question naming the packet file, and never keys on the event message ([O19]; ASSUMPTIONS S2d).
- **The retype.** For each loaded candidate packet that carries `reused_from`, validated as a reference to the same lane's worker packet, the controller's own gate event for that lane's candidate attempt is served with:
  - `type: 'result_reused'`;
  - `reused_from_attempt` = the `<n>` of the reused packet's path `verification/worker/<lane>/<n>/packet.json`;
  - `result_uri` = the result route of that reused worker result (`contracts/workflow/README.md`: "`result_reused`: `result_uri` and `reused_from_attempt`"). [O19]'s condition holds (ASSUMPTIONS S2c): `normalizeEvents` parses `contracts/workflow/v1.ts` `eventSchema`, which already carries `result_uri`, so it is set and no schema key is added.

  The event is `candidate_<lane>` (`workflow/pipeline.py:761`), identified from the packet registry and the event order, never from the message. It keeps its sequence, attempt, status and message, whatever type `normalizeEvents` gives it today (`log` or `status_changed`).
- **What stays.** No contract change, no new event, and `/events?after=` paging unchanged. No viewer code filters on `status_changed` (node statuses come from the snapshot), so the retype loses no transition; the node page's event list labels the event "result reused".
- **When it cannot match.** Nothing is retyped and no reuse is fabricated when the event cannot be identified unambiguously (no gate event for that attempt, or more than one candidate) or the evidence is absent or malformed. The handoff names the matching limits.
- **Tests that change.** `server/projects.test.ts:902` ("every event's `reused_from_attempt` is null") is narrowed to events of runs without reuse. `projects.spec.ts`'s candidate branch (`:256-261`, "The adapter never serves reuse events today") is rewritten to the seeded reuse run.
- **Acceptance:** a server test with a one-lane run whose candidate packet reuses worker attempt 1 (exactly one `result_reused`, with `reused_from_attempt` 1, and `result_uri` the reused worker result's route), a run with several candidate attempts and a run without reuse. It rejects:
  - more than one `result_reused` per lane attempt;
  - a `result_reused` on a run without reuse, or on the wrong lane or attempt;
  - reuse inferred from the message alone;
  - a changed message, status or sequence on the retyped event;
  - an inserted or renumbered event, or a different event count across `/events?after=` boundaries.

  Scenario `reuse-evidence`.

### 7.8 GH3 viewer guard, GH12 load test, GH4 record

- **GH3:** a task error makes a node failed only when that task is in the export's `next` (the controller's own rule), and the 3f58f1a guard (a verify node whose newest packet passed is not failed) stays for exports written before the engine's GH3 fix. Acceptance: a server test with `next` holding only `verify_adapter` and errors on `verify_ui` and `verify_adapter`: `verify_ui` is not failed, `verify_adapter` is; `server/projects.test.ts:1346` (3f58f1a) stays green.
- **GH12:** a server test: a run whose `plan.json` and `run-state.json` share `base_commit` and that holds `challenge.running.json` loads with 200 in the run detail and the workflow run list (`writeRun` with `skipPlan: true` and its own plan, or a `base` option added to `writeRun`); the identity check stays.
- **GH4:** no code. The server handoff records the close text for the operator: 26b5e83 bounded repair-scoped attempts and 216529c anchored `OWN_ATTEMPT`, and the intake's verification dissent verbatim (the graph attempt still takes the max of event and packet attempts, `server/projects.ts:1928,1966`, reachable only by a hand edit of `attempts.json`). Closing the issue is the operator's call.

### 7.9 Carried list fixes ([O21], which has the full wording)

- **C2 (M1, `RunsHome.tsx`):** `lists-incomplete` links to Triage's Attention section (`lists-errors`), and it also reports workflow read failures inside otherwise readable projects (which `lists-errors` already lists but the banner omits). Its project fraction and text stay (7.1, [G23](b)); a workflow count is a separate clause, never mixed into the fraction.
- **[L32] and the dead Retry (the feature page, `ProjectsView.tsx`; `runFilter.ts` where needed):** at the 20-page cap (`atPageCap`) the page says why it stops and that "All time" reads on; it never advertises a Load more it cannot do (button or scope line; a capped scope string is an addition, uncapped outputs stay), and no Retry silently does nothing after leaving "All time". Loaded rows, filters, the cap outside "All time" and "All time"'s reading past it stay.

Acceptance: untagged tests in `revamp-lists.spec.ts` or `ux-lists.spec.ts` (both browser phases) or `tests/unit/lists.test.ts` reject a misleading project or workflow count, a banner with no link to Attention, an unexplained cap, an advertised unavailable Load more and a dead Retry. The rest stays deferred ([O21], `## Deferred`).

## 8. DESIGN.md amendments (lane `polish` writes all of them, [O5])

The `polish` lane writes these sentences and values and no other change; `server` changes no DESIGN.md line, and any further rule it needs goes into its handoff.

- **`typography:` block (`DESIGN.md:36-80`)**: `meta` 12.5px → 13px; `word` 12px → 13px; every other entry unchanged; a comment line: "Nothing the operator reads is under 13px (14px under 720px) except uppercase labels (at least 11px); text inside a zoomable canvas follows its zoom."
- **Hierarchy (`:222-231`)**: "**Meta** (400, 12.5px, Pencil)" → "(400, 13px, Pencil)"; "**Word** (700, 12px, 0.02em, lower case)" → "(700, 13px, 0.02em, lower case)"; "**Mono** (400, 13px): commands, ids, lane chips (600, 12px)" → "lane chips (600, 13px)"; a new line "**Floor**: 13px on a desk, 14px under 720px; only uppercase labels go below it, to 11px; graph text inside a zoomable stage follows the zoom." Stage A's Measure line stays.
- **Components (`:282-285`)**: state pill "12 to 13px 700" → "13px 700"; lane chip "mono 12px 600" → "mono 13px 600"; severity chip "mono 11px" → "mono 13px".
- **Lists, rails, rows… (the paragraph stages A and B extended)**, appended: "Triage's date choice 'All time' replaces the sections with one All runs list over every project, read page by page on request; its scope line says whether every page was read." "A project's header states its Claude spend from the runs' recorded costs and how many runs were priced, or that none was recorded." "GitHub's state is said once per page: 'no GitHub remote', or 'GitHub not read: <reason>'." "The step chart never shows an abbreviation without a legend; a count says what it counts ('2 ended at Review')." "The skills home opens with both sources expanded one level; file operations appear only for a selection they apply to." And the DESIGN.md sentences stage B's `lists` lane left for stage C's DESIGN.md owner in `docs/handoff/ux-fixes-b-lists.md` ("For stage C and DESIGN.md"), verbatim (ASSUMPTIONS B6): the corrected list-order sentence replaces the paragraph's "Lists put the runs that need the operator first, …" sentence, and the other two are appended.
- No token, colour, spacing or phone-layout change beyond the 14 px floor.

## 9. Behaviour on each path

- **Cold open of a Projects page:** one home read and one overview read; stage A's loading states hold until they settle.
- **Poll:** 15 s while any row is running or needs the operator, else 60 s; rows stay on screen during a read; Triage's live status follows the cadence and never reads "Not updating" between on-time polls; a failed read keeps the rows and says it was not read.
- **Triage "All time":** the pages are read only when it is chosen (again on reload); a failed page keeps the rows and the filters and offers Retry, which reads only that page; the scope line never claims "all loaded" while a cursor remains or after a failed page, and an unreadable workflow is named beside it; leaving "All time" restores the sections with no request; reload with `date=all` re-reads the pages.
- **Run controls:** a GET never spawns a process (the capability read runs once, at server start); Relaunch's dialog shows the dry run before Confirm; a refusal is shown verbatim; after a relaunch the operator reconciles and restarts the supervisor with the existing controls; on an older controller both new controls are greyed with their reason.
- **Skills home:** opens expanded one level; Reset returns there; a selection shows its operations.
- **Phone (under 720 px):** text at least 14 px (labels 11 px); no other change; no sideways scroll.

## 10. Risks

- **M6 touches every stylesheet** that stages A and B measured (cue height, table rows, 44 px controls, two-line chips). Larger type can push a measured element past its limit in a spec `polish` does not own; the rule is to fix spacing in `polish`'s CSS, and the exemption of zoomed graph text keeps stage B's M8 out of reach.
- **The aggregate route must equal today's reads**, or stage A's classification and stage B's counts shift silently: the parity test over the same registry and the unchanged stage A/B scenarios are the guard; the worker-phase mock must assemble the same rows.
- **Merge order with the engine feature.** Stage C's tests use a fake controller. If stage C reaches the deployed line before `workflow-collected-fixes`, the capability read greys both controls with a reason (they never fail on click); merge the engine first, or point `MD_MANAGER_WORKFLOW_HOME` at a checkout that has it. The engine's RUNBOOK and README rows marked "(from ux-critique-fixes-c)" are stale until stage C merges.
- **Root suite on fixed ports.** `root-browser` uses 3014/5184 with `reuseExistingServer: false`; a process holding either port fails the check (checked before launch). The `polish` lane now runs two browser suites in sequence; its verify is longer.
- **Two browser suites plus the critique app on a 4-core host**: the browser checks keep 2400 s (project-workflows) and 1200 s (root); a SIGKILL that coincides with memory starvation is retried after memory, never fixed by skipping a check ([O8]).
- **`controls.spec.ts` changes owner** for this stage only ([O10] amended by grill q4): one count, one scenario and its older-controller sibling; its known flake `controls-unavailable` keeps `test.slow()`.
- **Base drift**: drafted while stage A was verifying and stage B not yet launched; `ASSUMPTIONS.md` lists every fact taken from them and from the engine's result, re-checked at the base before launch.
- **Known flakes**: `controls.spec.ts` `controls-unavailable`, `attack.spec.ts` `attack-section`, `ux-run.spec.ts` `run-now-banner` under load: reported in `untested`, not edited to pass.
