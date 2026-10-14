# Handoff: ux-critique-fixes stage B, lane `lists`

Findings M4, M3, M16, M7 and M17 of `features/ux-critique-fixes-b/prd.md` section 6, the carried stage A items C1, C3 and C5
(lists-task items 6-8), under [O11]-[O18] and the changes after launch [L1]-[L15]. Stage A's classification (`classifyRuns`) is
read, never changed.

## What changed, per finding

- **M4 one order** (`src/projects/lists.ts`): new exports `lastActivityAt`, `liveRank`, `compareLive(classes)`, `LIST_SORTS` /
  `ListSort`, `compareCreated`, `sortRuns`, `sortHomeSections`, `sectionOrderWords`, `HOME_SECTION_ORDER`. `homeSections` keeps its
  signature and `HomeSections` shape; it now places every unfinished, not-paused run whose class has `needs` null in Running
  whatever day it moved (pending and awaiting-approval rows with it, as before), only runs that finished today in Today, paused
  runs in Paused or the superseded fold (a run paused today included), and orders every section but Needs you by `compareLive`
  (Needs you keeps longest waiting first, [L4]). `dispatch/derive.ts` `railOrder`: waits, running, paused, readable, last activity,
  project id (cards follow it). Feature page (`ProjectsView.tsx`): rows and run-history chips in the chosen sort, sub-header
  `[data-testid=feature-runs-sub]`. Project page (`dispatch/ProjectPage.tsx`, `projectModel.ts` `orderFeatures`,
  `orderFeatureRuns`): features by most urgent run, last activity, `workflow_id`; sub-header `[data-testid=project-features-sub]`.
  Triage (`RunsHome.tsx`): sections and jump links Needs you, Running, Today, Paused, Recent; each sub-header names its order
  beside the step tally.
- **M3 the filter bar**: `src/projects/runFilter.ts` (pure model: `STATUS_FILTERS`, `statusOf`, `runPhase`, `inDateWindow`,
  `matchesText`, `filterItems`, `statusCounts`, `scopeLine`, `DATE_CHOICES`, `SORT_CHOICES`, `filterActive`); `src/projects/FilterBar.tsx`
  (`FilterBar`, `NoMatch`; not a form, Enter handled on the input); `src/projects/dispatch/listState.ts` (`useListState`: the list
  state read from the URL search App passes down, written back by a history replace, the search debounced 250 ms). The bar sits on
  the feature page, the project page (replacing `#dispatch-filter`) and once on Triage above Needs you, filtering the full set
  before sectioning with the classification of the unfiltered set. The feature page's "All time" reads the remaining pages through
  `loadMore` (one request per page, a ref guards a page already being read), "Reading older runs… (<n> read)".
- **M16 Recent**: its search box and All/Failed/Succeeded/Today pills are removed; it keeps "Group by project" and "Show older",
  both written to the URL through the same helper. `RECENT_FILTERS` is `['all', 'failed', 'succeeded']`; `filterRecent` and
  `recentCounts` keep their output for those three.
- **M7 the project page** (`dispatch/StepChart.tsx`, `ProjectPage.tsx`, `dispatch.css`): one header row per feature (link with
  tone, id, state word, count, chips oldest first, "last activity <Mon D>|today"), a "Show runs" / "Hide runs" button beside the
  link inside the `li`; dated run rows (`stops.ts` `runWhen`); one "Steps of this definition" fold per distinct revision above the
  chart (`DefinitionFolds`); `not_github` projects get a one-line GitHub column (`GithubColumn` `compact`) and a one-column body.
- **M17 URL state** (`routes.ts` `parseListSearch`, `listSearchString`, `DEFAULT_LIST_SEARCH`, `keepsListSearch`, `MAX_LIST_PAGES`;
  `App.tsx`): see "URL parameters and the history entry" below.
- **C1 pin toggle** (`RunRow.tsx`, `RunsHome.tsx`, `lists.css`): names "Add to Triage, <run id>" / "In Triage, <run id>" ([L11]),
  visible words "Add to Triage" / "In Triage"; beside a row the toggle is a 24 px borderless control on the row's first line (44 px
  under 760 px); the Pinned sub-header no longer says "pinned in this browser" when storage throws.
- **C3 compact chip** (`dispatch/Rail.tsx`, `derive.ts` `compactTriage`): "Triage · N waits · M paused", N the needs-operator count.
- **C5**: the stage A comments in `dispatch/stops.ts`, `dispatch/StepChart.tsx`, `revamp-lists.spec.ts` and `fixtures/dispatch.ts`
  lost their M-ids and kept their wording. The grep, run after the last edit over every lists-owned `src/` and `tests/` path
  (`src/App.tsx src/projects/{lists.ts,lists.css,RunsHome.tsx,RunRow.tsx,ProjectsView.tsx,routes.ts,pins.ts,runFilter.ts,FilterBar.tsx}
  src/projects/dispatch tests/unit/{lists,routes,dispatch,accepted}.test.ts tests/project-workflows/{dispatch,revamp-lists,ux-lists,ux-time,projects,accepted}.spec.ts
  tests/project-workflows/fixtures/{dispatch,ux-lists,ux-revamp-lists,ux-time,ux-accepted,index}.ts tests/project-workflows/{mock,seed,support,dispatch-app}.ts`):
  `grep -rnE "\(M[0-9]+\)|\bM[0-9]{1,2}\b" <paths>` → six hits, all `describe`/`test` titles (`tests/unit/lists.test.ts:491`
  "(M2)", `:617` "(M14)"; `tests/unit/dispatch.test.ts:342`, `:413`, `:439` "(M1)", `:361` "(M19)"), which are not renamed; zero
  comment hits. `git diff -U0` plus the new files, grepped for `[L<n>]`, `[O<n>]` and M-ids on added lines: hits only in this
  handoff (a doc), none in code, fixture or spec comments.

## The comparator's closed set

Groups: 0 a non-null class `needs` (question, pane, approval, decision, interrupted latest run); 1 an unfinished `running` run; 2 an
unfinished `paused` run with `supersededBy` null; 3 the rest (finished, accepted, superseded paused, pending, awaiting approval
without a wait). Inside a group: last activity newest first (`endedAt` finished, `movedAt` unfinished), ties by `run_id`. A failed
run served with `interrupted` attention has `needs` null: group 3, "Failed" only, in no wait count ([O16]). Triage's section order
(Running, then Today, then Paused) is the one exception; Needs you keeps longest waiting first ([L4]).

## Scope strings and read windows

Closed set of seven strings (`runFilter.ts` `scopeLine` and, on the project page, `projectScopeLine`, [L21]): feature page "<k>
of <n> runs · Load more runs" while a cursor remains, "<k> of <n> runs, all loaded" once none does (a failed page or the `pages`
cap never says all loaded); project page "Reading runs…" while its run lists are read, "Runs not read: <reason>" when every list
failed, "<k> of <n> runs · <N> feature(s) cannot be read" (the page's own `unreadText`, `<n>` the runs actually read) when some
feature's list failed, "<k> of <n> runs · the first 50 runs of each feature" while every feature was read and any has more, and
"<k> of <n> runs, all loaded" only when every feature was read and none has more (b-003 fix of b-002's review G4: the line read
"0 of 0 runs, all loaded" while loading and after a failure); Triage "<k> of <n> runs · live runs and runs finished in
the last 7 days". On Triage `<n>` is the number of runs in the state sections before filtering (Needs you, Running, Today, Paused
with its fold counted once, Recent; Pinned excluded, reads older than the 7-day window excluded) and `<k>` the matching runs in
the same sections ([L3]). Read windows: Triage reads every workflow's pages back to the 7-day cutoff (`readsNextPage` stops at the
first page whose last row's `updated_at` is older), so a stale live run beyond that page in a workflow with more than 50 recent
runs is not read while the line says live runs were searched (design note 7; stage C's aggregate route replaces this read); the
project page reads the first 50 runs per feature; the feature page its cursor pages. The feature page's latest-reviewed-run read
(`ProjectsView` `latestReviewedId`) re-runs when an appended page holds a later finished run, so `run-filters`' page 2 is entirely
older than page 1's newest finished run (design note 4).

## URL parameters and the history entry

Keys, in this order, defaults never written: `q`, `status` (comma list of `needs,running,paused,failed,succeeded,override,cancelled`),
`phase` (a `PHASES` name), `date` (`today`, `7d`, `30d`, `all`), `sort` (`live`, `newest`, `oldest`), `group` (`project`),
`older` (`1`), `pages` (2-20). An unknown key is dropped, a malformed value reads as its default. `App.tsx`: the initial
`replaceState`, `writeHistory` (new optional `search` argument) and the popstate fallback keep the search only for Projects
pathnames (`keepsListSearch`); every other write is byte-identical. List writes go through `replaceListSearch` ([L2]): it replaces
the current entry's URL with `{ mdManager: historyKey }`, keeps the record, does not bump `navigationRevision`, and refuses a
write whose pathname is not the current entry's (a late debounced search, design note 1), comparing canonical pathnames (`canonicalPathname`) so a list opened at a trailing-slash URL writes its state and keeps its URL's form. On Back or Forward the popstate handler flushes a pending search into the departing entry's record (`search`), and returning to that entry replaces its URL with the committed search (lane-review repair 1). `ProjectsView` flushes a pending search
before every `onNavigate`; a bare-path link to the list shown clears its search ([L13]); the list state is derived from the search
App passes down, never read once from `window.location` (design note 2). The history record gains `list: { scroll, folds }`
(the project page's `feature:<id>` toggles, `paused-all`, `superseded`), saved when the operator leaves a Projects entry and
restored on Back after the first settled read (`ProjectsView` `settled`); `history.scrollRestoration` is `manual` while a
Projects pathname is shown and restored on leaving (graph pages, `App.css` overflow hidden, are unaffected). A reload restores
the URL state only.

## Seeds

No run was added to any seeded project. The scenarios serve their own projects by `page.route` in both phases
(`support.ts` `installListsWorld`, data in `fixtures/ux-lists.ts` `B_PROJECTS`: `lists-b-order`, `lists-b-fold`, `lists-b-filter`,
`lists-b-runner`, `lists-b-parked`; the unreadable `fold-broken` and page 2 / the failed page of `filter-runs` are routes too).
These ids are appended to the registry's own answer, so no shared project's badge, card order or heading count moves; no
`sessions-parity` change is needed.

## Tests

Scenarios (`revamp-lists.spec.ts`): `[scenario:live-first]`, `[scenario:run-filters]`, `[scenario:triage-filters]`,
`[scenario:project-collapsed]`, `[scenario:list-state-url]`, with untagged siblings (malformed URL values, a run opened inside the
debounce and the rail's bare Triage link, the graph's URL without a search, the pin toggle's name and height, the compact chip at
900 px, the read-only check's exemptions with a bar button, a bar select and a Show runs button carrying an execution word still
counted). `list-state-url` passed three consecutive runs in the worker phase (`--repeat-each=3`, design note 3). Unit: `tests/unit/lists.test.ts` "the one list order (compareLive) and the sorts", "Triage sections: placement, order and
the sorts", "the filter bar model (runFilter)", "the stage B list seeds"; `tests/unit/dispatch.test.ts` railOrder and chip cases,
"the project page order and folds"; `tests/unit/routes.test.ts` "a list's state in the URL search".

Rewritten assertions:
- `revamp-lists.spec.ts` `[scenario:home-sections]`: jump links now Needs you, Running, Today, Paused, Recent; `RUN_DESK_LIVE` and
  `RUN_DESK_LIVE_QUIET` are read in `running-runs` (same lanes, row shape, step-tally sub-header, now ending "· latest activity
  first"), absent from Today; Today holds finished runs only; the superseded fold's order is the comparator's over the same four
  ids (computed from the phase's served list); Recent's Failed/Succeeded counts are read from the bar's toggles and equal the rows
  kept across the state sections over the searched set, Recent keeping only that status.
- `[scenario:run-times]`: the ticking `RUN_DESK_LIVE` span is read in `running-runs`; `REVAMP_FINISHED_RUNS[0]` stays in Today.
- Untagged "Runs home with nothing waiting": `RUN_DESK_LIVE` read in `running-runs`.
- `triage-pins` and siblings: `pinName` is "Add to Triage, <id>" / "In Triage, <id>"; the throws case also rejects "pinned in this
  browser".
- `'Run history, newest first'` → `'Run history, needs you and running first'`.
- `ux-lists.spec.ts` `[scenario:runs-home]`: `RUN_LISTS_LIVE` and `RUN_LISTS_STOPPED` read in `running-runs`, absent from Today.
- `dispatch.spec.ts`: every project page is opened with `gotoProjectOpen` (all features opened once the lists are read); the
  search is the bar's `run-filter-q`; "Steps of this definition" is asserted once per revision above the chart, every feature
  named by a fold, none inside a feature (`dispatch-chart`, `dispatch-folds`); a filtered-to-none feature also stays closed; the
  `not_github` project asserts the one-line column (no PR or issue card, no GitHub count, the reason and the local sync).
- `[scenario:rail-state]`: the order assertion is inverted by M4: `dispatch-busy` (running) now ranks above `dispatch-widgets-wt`
  (paused only); waits first and unreadable last stay asserted.
- Untagged "Triage with runs running: Paused folds after 5": Paused follows the list order, so `fold-006` (the newest) is among the
  first five and `fold-001` (the oldest) is absent until "Show all", then present; the five-row fold and the "Show all N paused"
  wording stay asserted.
- `[scenario:dispatch-chart]`: the filtered-to-none feature is also asserted closed (`data-open="false"`).
- `test.slow()` was added to nine `dispatch.spec.ts` scenarios (they open every feature on each project page) and to
  `projects.spec.ts` `[scenario:request-errors]` (it timed out once at 30 s under load); timeouts only, no assertion changed.
- `support.ts` `expectNoExecutionControls` and `projects.spec.ts`'s helper exempt exactly the bar's `Cancelled` toggle and the
  `run-filter-phase` select with options exactly "Any step" + `PHASES` ([L1], [L15]: `support.ts:64-65` and `projects.spec.ts:44-45`
  include `select` under `hasText`, and `phases.ts` holds "Launch" and "Integrate", so the select exemption applies). The project
  page gets the add-only scoped `expectNoProjectPageExecutionControls` ([L9]); at 0d2408b no spec ran the full check on a project
  page.

## Follow-up b-003 ([L18], [L21], [L19], [L23], [L25])

- Project page scope line ([L18], [L21]): `projectScopeLine` in `runFilter.ts`, called from `dispatch/ProjectPage.tsx`; unit test
  `tests/unit/lists.test.ts` "the project page's scope line never says "all loaded" or "0 of 0 runs" while reading, after a failed
  read or with an unread feature" (each of the seven strings, the closed set over every output, no "all loaded" / "0 of 0 runs"
  while loading, failed or partly failed); browser test `revamp-lists.spec.ts` "The project page's scope line says "Reading
  runs…" while its lists are read, …" (untagged sibling of `run-filters`, both phases): `lists-b-filter`'s run lists held by
  `page.route` ("Reading runs…"), all answered 500 ("Runs not read: …", waiting on the scope text, never on `projectRead`, design
  note 3), and `filter-other` 500 with `filter-runs` read ("9 of 9 runs · 1 feature cannot be read", then "3 of 9 …" under
  Failed). On the restored 22c93c91 `ProjectPage.tsx` it failed in the worker phase (received "0 of 0 runs, all loaded"); with
  the fix it passed in the worker and candidate phases.
- `not_github` with a run selected ([L19], [L23]): the container-query rule (`dispatch.css`) is now
  `.dispatch-project-body:not(.dispatch-project-body-wide)`, so a wide body never opens an empty 380 px column. Check
  `dispatch.spec.ts` "A project without a GitHub remote keeps one body track with a run selected, …": `dispatch-local`, `sync-001`
  selected, the window widened from 1700 px in 200 px steps (capped at 2560 px) until `.dispatch-body-container` is at least 876
  px, then one grid track (`gridTemplateColumns.split(' ').length === 1`) and `.dispatch-project-main` within 1 px of the body's
  width. On the restored `dispatch.css` it failed (two tracks) in the worker phase; with
  the fix it passed in both phases.
- Flakes ([L25]): none seen. `dispatch.spec.ts` and `revamp-lists.spec.ts` passed 54 of 54 in the worker phase and 54 of 54 in
  the candidate phase (JSON reports, `check-report` ok); this lane did not run `controls-unavailable`, `attack-section`,
  `run-now-banner` or `panel.spec.ts:101`. The seven-string closed set is asserted in the unit test beside the four-string
  `scopeLine` test, which is unchanged.
- Open (design note 4, for stage C's scope-string owner): when one feature's list fails while another has more than 50 runs, the
  line reads "<k> of <n> runs · 1 feature cannot be read" and does not also say the other features were cut at 50 runs.

## Follow-up b-004 ([L26], [L31], [L32], design note 5)

- 'Load more runs' never reads past the restorable page count ([L26]): `ProjectsView.tsx` computes `atPageCap`
  (`pages.length >= MAX_LIST_PAGES` and not "All time"); `loadMore` itself returns early on it (design note 5, so the error
  panel's Retry and any later caller are covered, not only the button), and the button stays rendered with the same text but is
  disabled at the cap. "All time" keeps reading through `moreWanted` unchanged; `MAX_LIST_PAGES`, `routes.ts` and the 1-20 cap
  are unchanged.
- Test ([L26], [L31]): `revamp-lists.spec.ts` "'Load more runs' at the restorable page count is disabled and reads no further
  page; a reload and the copied URL show the same rows" (untagged sibling of `list-state-url`, `test.slow()`): `page.route`
  serves `lists-b-filter/filter-runs` as 24 cursor-chained pages of 2 runs keyed by cursor; at `?pages=20` it waits for 40 rows,
  asserts `toBeDisabled()`, presses with `click({ force: true })`, counts zero requests for the 21st page's cursor (`cap-21`) and
  an unchanged row count, then reloads (40 rows, `pages=20` in the URL, still disabled, still no `cap-21`) and opens the copied
  URL in a new page (the same run ids in the same order). With the restored 611032f `ProjectsView.tsx` it failed in the worker
  phase on `toBeDisabled` (line 1690); with the fix it passed alone in the worker phase, and the whole `revamp-lists.spec.ts`
  passed 39 of 39 in the worker and in the candidate phase (JSON reports, `check-report` ok).
- Flakes ([L25]): none seen in b-004's runs.

## For stage C and DESIGN.md (lane `lists` changes no DESIGN.md line)

- Corrected list-order sentence (design note 6): "Lists put the runs that need the operator first, then running, then paused, then
  the rest by latest activity, and the sub-header names the order; Triage keeps fixed sections in the order Pinned, Needs you,
  Running, Today, Paused, Recent, with Needs you longest waiting first."
- "A filtered list says how many of the runs it read match ('3 of 50 runs · Load more runs') and never calls a loaded subset
  complete."
- "A project without a GitHub remote shows its GitHub column as one line under the header."

## Stage C items

- Triage's registry-wide all-time "All runs" view on M15's aggregate route is required stage C acceptance; M3 is not complete
  until it works ([O11]). It adds one scope string to `scopeLine`.
- Failed runs served with `interrupted` attention stay out of Needs you ([O16]), beside stage A's "interrupted case (c) never
  reaches a list row"; a served `situation` or `follows` field decides both.
- Triage's read window over-claims for a workflow with more than 50 runs updated in the window (design note 7).
- At 20 pages the disabled 'Load more runs' button has no explanation, the scope line still names it, and 'All time' is the only
  way to read further ([L32]); b-004 adds no hint ([L29]).
- b-003 review P2s carried by [L29], none fixed in b-004: the `StepChart` state word; rows with numeric-suffix run ids; this
  handoff's flake-log entry and candidate-phase record; the partly-failed project scope line (also design note 4 above);
  scrollRestoration on run pages (G6, `App.tsx`).

## The first-screen measurement ([L14])

Measured in the worker phase before the rest of M7 was finished, with a probe of the element boxes at 1440x900 on `lists-b-fold`
(three open features of one run each, four closed): the first feature header started at 866 px (header 256 px, "Needs you and
running" 106 px, seven definition folds 250 px stacked, 30 px between features), so no header fit. Compressed, desktop only
(the 390 px rules unchanged): the definition folds wrap on one flex row with the order sub-header above them; "Needs you and
running" lists its runs on one wrapping line (same `li` per run); the project meta sits beside the title; feature rows are 36 px
with 6 px between them; run rows have 4 px padding; the filter bar's scope line shares the status row. After it the sixth header
ends at 898 px in the worker phase; the candidate phase once fitted only five (the same seed, a few pixels taller), so the axis,
the feature rows (32 px), the bar's desktop controls (28 px) and the track spacing were trimmed by about 40 px more. The probe
measured the candidate phase too (sixth header bottom at 876 px before that trim). `project-collapsed` asserts six or more.

## Open items

- `untested`: Paused's "Show all" and the superseded fold restored on Back (the code records them as `paused-all` and
  `superseded`; only the project page's feature toggle is asserted on Back); `sessions-parity.spec.ts` not run (no fixture run was
  seeded, every new run is a route); the known flakes (`controls-unavailable`, `attack-section`, `run-now-banner`) were not run by
  this lane.
- A Triage section filtered to nothing says "No run matches." twice (its sub-header and the paragraph under it).
- One worker run overlapped this lane's targeted runs (20 min instead of 12.5) and timed out three tests under load
  (`accepted-run-outcome`, `dispatch-git-truth`, `live-freshness`); the next worker run, alone, passed 70 of 70.
- Recent's `older` URL state on reload is asserted only when the seed shows "Show older" (the sibling's branch); its execution
  was not confirmed.
- `run-filters` failed once in the candidate phase in a five-test `-g` run right after a CSS edit (the error was not captured);
  it passed in every other run (the full candidate run before it, the run after it, `--repeat-each=3` and two more `-g` runs).
  Recorded as an intermittent to watch; the controller's own runs decide.
- The six-headers clause holds by a few pixels with this seed; a project with longer wording in its figures may need one more line.

- An unreadable feature stays open under any filter and never shows "0 of 0 runs match" (design note 5,
  `tests/unit/dispatch.test.ts` "open by default …").
- If the lane blocks past its repairs, M17's scroll and fold restore, then C1, C3, C5, drop first into the follow-up ([L8]).
