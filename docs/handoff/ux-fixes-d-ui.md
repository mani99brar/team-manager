# Handoff: UX fixes, stage D, lane `ui`

Verdicts first, a grouped findings row, honest scope lines and filtered blocks, a stopped controller under Needs you, Back to a
run page, the narrow chart, GitHub said once, pins shared across tabs, and the runs a list could not read named. Items D1-D21,
D22 (client half) and D32 of `features/ux-critique-fixes-d/prd.md` section 6; DESIGN.md carries the five sentences of PRD 8's
`:297` amendment. Base: the worktree's main ca5e2bb plus the feature files.

Red = the test on the base `src/` (the new tests in place, `src/` and `DESIGN.md` reverted); green = the same test on this
change. Browser reds ran in the worker phase for every scenario and in the candidate phase for `dock-column-hold`,
`back-to-run`, `reviewer-tones` and `findings-first-screen`.

## What changed, per item

- **D1 (reviewer title row).** `NodeHeader.tsx`: no `StatusBadge` in `.node-title-row` when `definition.node_id` starts with
  `reviewer-` and a verdict is shown ([L1], [L7]); the outcome stays in the muted `node-verdict-outcome`. The review step and every
  other node keep their badge (`panel.spec.ts:166`, `review.spec.ts:115`, `:154` unchanged and green). Checked for [L7]: no seeded
  node outside the sessions projection (`isProjectedSessionNode`) has a `reviewer-` id. Proof: `[scenario:reviewer-tones]`
  (sessions.spec.ts) red (a toned badge in the title row), green in both phases.
- **D2 (failed verdict is a fail).** `node/model.ts` `reviewerLead` gives tone `fail` and verdict `failed` for the word `failed`
  (type widened to `'approved' | 'blocked' | 'failed'`), `RunView.tsx` and `StepStrip.tsx` carry the widened type; the strip swaps
  glyph, glyph class and aria word ("<label>, failed") for every fail-toned verdict and sets `data-verdict` to the verdict word.
  Seed: not added to `fixtures/sessions.ts` (a fourth reviewer moves every count that reads `REVIEWER_IDS`); the sessions answer is
  patched with `page.route` in both phases (reviewer-coverage's row: verdict `failed`, status `failed`), which is all the node
  page and the strip read. Proof: unit `reviewerLead: …` in node.test.ts (red), `[scenario:reviewer-tones]`, and the untagged
  sibling "A reviewer with no verdict keeps data-verdict 'none'…".
- **D3 (findings row), D5 (fail stripe).** `ReviewDetail.tsx`: the row is composed from caption spans and the exported
  `FilterButton` ([L8]): one `role=group` (`findings-filters`, same classes, aria-label, `data-filter` values and button order),
  captions State, Severity, Reviewer, Lane and a second State caption before Open only; every button but All names itself after its
  caption (`aria-labelledby="<caption> <own id>"`, [L14]: "State Open only 3"); Open P0/P1 and Open only release each other, the
  page still opens on Open P0/P1. "More"/"Less" keeps its visible text and has the name "More: rest of the message, files and
  fields"; `aria-controls` lists the `finding-rest` id and the new `finding-body` id. `node/review.css`: `.findings-filter-label`
  (12 px uppercase, the type floor's rule) and `.finding-card.finding-blocking { border-left-color: var(--fail) }` after the `.sev-*`
  rules. `ui/index.tsx`, `findingFilterIds` and `filterFindings` are untouched. Proof: `[scenario:findings-groups]` (revamp-pages.spec.ts).
  Red/green in both phases; the visible-words allow-list test ("Every button on the run and node pages…") is green unchanged.
- **D4 (findings first).** `ReviewDetail.tsx`: verdict line, blocked-by and summary, then `review-findings`, then the facts list and
  the inline diff, then the reviewer entries; `review-result`, its `data-reviewer-count` and the entries stay rendered. First
  `finding-message` bottom: **795.7 px** at 1440x900 with the captions in place (base: **963.4 px**; the card top was 893.6 px).
  Proof: `[scenario:findings-first-screen]`; the M22/M9 assertions in `review-one-list` and `node-compact` now measure the message's
  bottom.
- **D6 (pins across tabs).** `pins.ts`: `add`/`remove` re-parse the storage first; `sync()` re-reads and notifies; `pinStore()` adds
  one window `storage` listener for `PINS_KEY`. Stage A [O10]'s rules unchanged. Proof: three new tests in lists.test.ts
  ("two stores over one storage…", "a storage event…", "a throwing storage still works…"); a two-tab browser check was not made.
- **D7 (head sentence).** `findings.ts`: etc, approx, incl, Mr, Mrs, Ms, Dr, al in `ABBREVIATION`; a `.` followed by whitespace and a
  lowercase letter never ends the head. Proof: node.test.ts "etc., approx. and a full stop before a lowercase word…" (red).
- **D8 (50-run cut), D21 (Triage scope line).** `runFilter.ts`: `projectScopeLine` adds " · the first 50 runs of each feature" when
  some feature has more; Triage reads "<k> of <n> runs · runs updated in the last 7 days and the 50 most recently updated runs of
  each feature". Amendments (PRD 9): stage B [L21]'s closed set. The closed-set test is keyed by surface ([L10]: Triage, project page, All
  time) and rejects 'live runs', 'finished in the last 7 days', 'latest 50', 'first 50 runs' and 'every unfinished run' on Triage.
  `lists.test.ts` strings at the old `:869`, `:982-983` changed; `revamp-lists.spec.ts:1469`, `:1485` carry the new Triage string.
  Proof: lists.test.ts "Triage's scope line…" and the closed-set test (red: the file does not load on the base, see below).
- **D9, D12, D14 (filtered lists).** `ProjectPage.tsx`: the "Needs you and running" block filters with the chart's own
  `matchesFilter`/`itemOf`, heading "Needs you and running · k of n" while filtering (n before the filter, classified before it),
  "No run matches." once and neither all-clear; unfiltered it is byte-identical (`dispatch-sections` green). `RunsHome.tsx`: a section's
  sub says "No run matches." only when the section had no runs to hide; the `NoMatch` body says it otherwise (once). `FeatureGroup`
  gains `outcome` (the latest unfiltered run's word) and `stateWord` (now in `stops.ts`, with `runWord` and `statusCommand`, because
  lint forbids non-component exports from `StepChart.tsx`) uses it. Proof: `[scenario:filtered-lists]` (revamp-lists.spec.ts) and
  dispatch.test.ts "a feature header's state word…".
- **D10, D11 (waits that do not tick).** `stops.ts` `runWhen`: "started Oct 9 · awaiting approval since Oct 11" for an unfinished
  row of kind `updated`; `dockWords.ts`: "<status word> since <Mon D>" for `awaiting_approval` and `pending`, "for <span>" only
  while running. Proof: dispatch.test.ts "an awaiting-approval row…", signal.test.ts "a run waiting to start or on an approval…".
- **D13 (Back to a run page).** `App.tsx`: `scrollRestoration` is `manual` on triage, project, workflow and projects levels and `auto`
  on run and node pages; nothing else of the history code moved. L4's experiment (browser `auto`, run page scrollY > 600, node page,
  Back): **before 1003 px, after 1003 px** in both phases (base: back at 0). Proof: `[scenario:back-to-run]`; stage B's list
  Back-restore tests are green.
- **D15 (dock column).** Per [L6], [L11], [L16], [L17], [L18] (the hysteresis of PRD 6 D15, the 15 px resize-hold and 1176 px clauses
  and the `DESIGN.md:242` amendment are withdrawn, so they are absent on purpose): `SignalRun.tsx` keeps `frameWidth` raw, reads
  `window.innerWidth - document.documentElement.clientWidth` inside `measure()` on every call and adds it only in the column
  comparison (`frameWidth + gutter >= DOCK_COLUMN_FRAME`). `[scenario:dock-column-hold]` (ux-run.spec.ts) is a plain test that
  launches its own Chromium without `--hide-scrollbars`, with `timezoneId: 'UTC'`, `locale: 'en-GB'`, `reducedMotion: 'reduce'`
  and `installProjectMocks` in the worker phase, holds `/sessions`, and closes the browser in `finally`. Measured: gutter **15 px**,
  run-board clientWidth **1190 px** (1205 px without the scrollbar) before the sessions arrive and the same after. The page already
  scrolls before the sessions load (the workspace's padding sits below the frame), so the flip happens as soon as the stage has its
  height; the sessions only keep the scrollbar. Base: overlay ("the column holds before the sessions arrive" fails) in both
  phases; green three times in a row in both phases. Resizing still switches at exactly 1199 → overlay, 1200 → column (frame plus
  gutter). `graph-readable`, `graph-fits`, `dispatch-dock` pass unchanged (the default launch hides scrollbars: gutter 0).
- **D16 (Copy on its row).** `sessions.css`: `.ss-row .ss-resume-cmd { flex-basis: 100% }` inside the 1360 px query. The PRD stops
  there, but with the seeded worker-form command (1050 px wide) the Copy button still wraps below it, because a flex line wraps
  on the items' hypothetical sizes; so the node-page block's command also gets `flex: 1 1 20ch` from 481 px (phone unchanged),
  which lets it shrink beside Copy. Proof: `[scenario:resume-copy-row]` (red: Copy 10 px below the first line), both phases.
- **D17, D20 (narrow chart rows, status command).** `dispatch.css` under the 640 px container query: the first line wraps, the id
  keeps its width, the date wraps, the landing note wraps on its own line. `statusCommand()` in `stops.ts`: `python -m workflow
  status <runs root>/<run id> --by operator`, `<run-id>` when none is known. `dispatch.spec.ts:203` and `:209` carry the new
  literals. Proof: `[scenario:narrow-chart-rows]` and the untagged sibling "The chart's status command reads <runs root>/…"
  (the Widgets `broken-001` row) (both red).
- **D18, D19 (GitHub said once, reading).** `ProjectsPage.tsx`, `GithubColumn.tsx`: every site keys on `git?.status === 'unavailable'`
  (no GitHub not-read text); the card foot says "GitHub: reading…" while the overview loads and the header's "GitHub not read" waits
  for it. Proof: `[scenario:github-once]` (red).
- **D22 (client).** `api.ts`: `fetchRuns` takes `errors` off the raw answer before `schemas.runList.parse`, validates it with the
  local strict schema of PRD 5.1 and returns it on `RunPage`; `WorkflowRuns` carries `errors`; an empty list with errors gets an
  `error` built from the first entry ([L5]: a list with readable runs keeps `error: null`, `runsRead='read'`, and counts in
  `unreadFeatures`). `ProjectsView.tsx` (feature page): the line `feature-unread-runs` under the list, in place of `empty-runs`
  when none is readable. `ProjectPage.tsx`/`StepChart.tsx`: `dispatch-unread-runs` under the feature, without ids the steps rows
  already name. **For a later tidy-up: the `errors` take-off in `fetchRuns` (and the local `runReadErrors` schema) is a no-op once
  `contracts/projects/v1.ts` lists the key.** Proof: `[scenario:unread-runs]`; `dispatch-sections` green in both phases.
- **D32 (stopped controller).** `lists.ts`: `classifyRuns(runs, stopped = ∅)`; a latest, running run in the set with no other need
  classifies `interrupted`; `stoppedRunKeys` builds the set from `controllerNotRunning` over the readings. `ProjectsView.tsx` keeps
  the readings with `recordHomeReadings`, stamped `new Date(homeMeta.settledAt).toISOString()` ([L12]) from each successful home
  poll, and passes the set to the rail badge, the feature page, `RunsHome`, `projectRunInfo` and `ProjectPage`. "Stale" is a reading
  older than the last successful home poll, never extended; no new staleness check or debounce ([L13]); a failed poll keeps the last
  classification. The card wording is the interrupted kind's ("run interrupted", "Interrupted at … · the controller stopped", next
  step "resume the run on the run page"). Proof: lists.test.ts "a running latest run whose controller has read not_running…" (six
  tests, including the identical-input check against `servedDisagreement`) and `[scenario:triage-controller-stopped]` (title
  "(n)", rail Triage badge, project rail row and card waits move by one; a later `running` reading, one reading, unknown and null
  leave everything as it was; the non-latest run never moves; passes three times in each phase).

## Scenarios

| scenario | spec |
|---|---|
| `reviewer-tones`, `resume-copy-row` | sessions.spec.ts |
| `findings-groups`, `findings-first-screen` | revamp-pages.spec.ts |
| `filtered-lists`, `back-to-run`, `triage-controller-stopped`, `unread-runs` | revamp-lists.spec.ts |
| `dock-column-hold` | ux-run.spec.ts |
| `narrow-chart-rows`, `github-once` | dispatch.spec.ts |

Each has one `screenshot:<id>`; untagged siblings: "A reviewer with no verdict keeps data-verdict 'none'…" (sessions),
"The chart's status command reads <runs root>/…" (dispatch).

## Existing assertions I changed (each follows from an item)

- revamp-pages.spec.ts: `review-one-list` (`:487-489`) and `node-compact` (`:558-559`) measure the first `finding-message`'s bottom
  (D4); `review-one-list` `:245-246`: the blocking P1 card's stripe is `--fail`, not `--p1` (D5 makes the old line false; the
  non-blocking P1 keeps `--p1`, asserted in `findings-groups`).
- revamp-lists.spec.ts: `triage-filters` `:1469`, `:1485` (D21's string); `:1478` (D12: the section's sub no longer says
  "No run matches."; the section's `run-filter-none` does, once); `run-filters` "project page's scope line…" (`:1437`, `:1441`: D8's
  " · the first 50 runs of each feature" on the partly read page that has a next page).
- dispatch.spec.ts: `:203` and `:209` (D20's literals).
- lists.test.ts: the Triage strings and the closed-set test (D8, D21, [L10]).

## D32 seed survey ([L3], [L9], [L12])

Latest running runs with a served `not_running`: `lists-live` (`ux-lists`: worker mock `running`; the candidate's seeded PID is dead, so
`not_running`) and `desk-live-1` (`ux-revamp-lists`: the same), the only two seeds that D32 can move, and only after two home polls 15 s
apart. Not moved: `lists-asking` and `lists-answered` (served `not_running`, but a question and a pane need the operator already),
`lists-stopped` (running, created before `lists-live`, so not the latest), `desk-live-quiet-1` (non-latest, controller null),
`desk-pane`, `desk-interrupted`, `desk-paused`, `desk-held` (pane, or paused status). Specs frozen with `page.clock.setFixedTime`
(most of `revamp-lists.spec.ts`, `ux-lists.spec.ts:29`, `ux-time.spec.ts:39`, `:67`) cannot reach the debounce (every reading has the
same `at`): inert. Specs that advance time on a Triage or rail page: `run-times` (`fastForward('01:00')`), `one-request`
(`advance(15_000)`), `ux-time.spec.ts` (run pages only, which take no home poll). In the candidate phase `run-times`, `one-request`,
`triage-attention`, `live-first`, `rail-state`, `home-sections`, `dispatch-sections` and the new scenario passed three times in a row
with the real seeded readings; no count, seed or frozen assertion moved for D32.

## Runs

- Final checks on this tree: `npm run build`, `npm run lint`, `npm run test:contracts` (44) and `npm run test:unit` (932 passed) all exit 0.
- Unit reds: on the base `node.test.ts` fails 2 and `signal.test.ts` 1
  of their tests, and `lists.test.ts` and `dispatch.test.ts` do not load (the new exports are missing), so their new tests are red.
- Worker phase, whole suite once on this change before the last fixes: 196 passed, 2 genuine failures (D8's browser string, fixed;
  `dock-column-hold`'s resize step, made robust) and 3 30 s timeouts under load (`legacy-run` 19 s alone, `panel-section` the known
  flake, `revamp-review` 19 s alone), each green when run alone. Candidate phase, whole suite: 201 passed, 1 failure (`github-once`
  read the non-git project page before the git read answered; the test now waits for the header's "git not read"), 1 skipped.
  Final: the five changed spec files (sessions, revamp-pages, revamp-lists, dispatch, ux-run) ran in both phases with the JSON
  report: 118 passed, 0 failed in each, and `check-report` says the scenarios follow the verifier's rules (all eleven ok).

## Open points

- None of D1-D22 or D32 is left open. PRD 6 D15's hysteresis and `DESIGN.md:242` were withdrawn by [L6]/[L11], not forgotten.
- Not tested: pins shared between two real tabs (unit only); the `impeccable` skill was not run as a separate pass (the screenshots of
  the scenarios were checked against DESIGN.md's rules by eye); the phone layout is untouched.
- P2/P3 lane-review findings: none received at the time of writing.
- Sentences for RUNBOOK/README: none.
