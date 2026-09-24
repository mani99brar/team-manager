# Handoff: viewer UX slice S1, time, freshness and trim (PRD_VIEWER_UX)

Implements row S1 of `docs/PRD_VIEWER_UX.md` section 11 on branch `ux/s1` (worktree `~/dev/mdm-ux-s1`, from `feature/viewer-ux`), 2026-09-24. Scope: client code and test plumbing only. It shares no file with S2 (`contracts/projects/triage.ts`, `tests/unit/triage.test.ts`, `tests/unit/fixtures/runs/*`). Only targeted checks were run (section 3). The full suites are left to the orchestrator after merge.

An independent review of the first two commits found five defects and five gaps. Section 7 lists each finding with its outcome, and the sections below describe the final tree.

## 1. What shipped

**Time helpers** (PRD 5.3)
- `src/projects/time.ts` (pure):
  - `formatClock` gives `HH:MM`, or `HH:MM:SS` on request, in the local zone or UTC. The date is prefixed only when the day differs from the reference day: the run's start on run pages, today in lists, where the day before reads "yesterday". Another year adds the year.
  - On a run page, the run's start itself (the Created fact) is read against today, so the page always names the day its run started ("yesterday 02:00", "Mar 1 10:00") unless that is today. Every other time on the page is read against that start day.
  - `formatAgo`: "just now", "3 s ago", "14 min ago", "2 h ago", "1 d ago".
  - `formatSpan`: "46s", "1m00s", "28m21s", "1h05m", rounded to the second, so 2.54 s reads "3s".
  - `spanBetween`: null when an end is missing or unreadable, or the end precedes the start.
  - `utcTitle`: "2026-09-24 09:32:31 UTC".
  - `freshnessState`: the live chip's state rules from 6.3.
- `src/projects/useNow.ts`:
  - `useNow(active)`: ticks every 1 s only while active and the tab is visible.
  - `usePageVisibility()`: whether the tab is visible, and since when.
  - `useToday()`: one page-wide "today" that changes only when the local or UTC date does. It is re-checked every minute and whenever the tab becomes visible, so a list left open past midnight relabels its days without remounting and without re-rendering every second.
  - `useTimeZone()`: one page-wide Local/UTC store, kept in `localStorage` key `mdm.projects.timezone`. Every read and write is in try/catch, and it falls back to Local.
  - `TimeReferenceContext`: the instant a run page reads its times against.
- `src/projects/Time.tsx`: `<time dateTime={iso} title="… UTC">clock</time>`. `anchor` marks the run's start, which is read against today rather than against itself.
- `src/projects/TimeZoneToggle.tsx`: `time-zone-toggle`, a `role="group"` holding two `aria-pressed` buttons, "Local" and "UTC". At ≤760 px they are at least 44×44 px (PRD section 10).
- `src/projects/LiveStatus.tsx`: `live-status` with `data-state` set to `live`, `watching`, `stale`, `finished` or `hidden`, using the texts of the 6.3 table.
  - The chip is not a live region.
  - A separate visually hidden `role="status"` carries a constant sentence while the run is stale, so the stale state is announced once.
  - The 15 s rule counts from the later of the last success and the moment the tab became visible again. A tab coming back from the background does not flash "Not updating".

**All 18 `formatTime` call sites now render `<Time>`:**
- `RunView`: created, updated.
- `ProjectsView`: the run rows.
- `NodeDetail`: check start and end, reuse, approvals, events.
- `WorkerInputs`: launch requested, native start, question asked and answered, stop.
- `ReviewDetail`: reviewer launched and accepted, reviewed at.
- `Challenge`: decided.

`formatTime` is removed from `status.ts`, and no import of it is left.

**Clock precision**
- Seconds are shown on check rows, events, receipts, reviewer and review times, and the challenge decision.
- `HH:MM` everywhere else.

**Placement.** The chip and the toggle sit beside the status line of today's run header, in `.run-status-row`. S3 moves both into `RunHeader`.

**Freshness data and Refresh** (PRD 6.3)
- `useResource` returns `meta { settledAt, lastError, failures, refreshing, refreshError }`.
- `refreshToken` moved from `base` into `token`. A Refresh now reloads in the background like a poll: the page never blanks to "Loading run…", and scroll position and tab survive.
- **A failed Refresh is never silent.** It keeps the shown data, and `meta.refreshError` holds the error until a later load of that resource succeeds (a poll or another Refresh).
  - `ProjectsView` shows `refresh-failed` at the top of the page, a `role="alert"` notice: "Refresh failed. <reason> The page still shows the data loaded at <time>, which may be outdated."
  - This covers finished runs, whose chip stays "Finished · not polling", and the project and workflow list pages, which have no chip.
- **A Refresh is announced.** The polite announcer says "Refreshing." when it starts, then its outcome once every level has settled: "Refreshed. Loaded run …", "Refresh failed. The page still shows the data loaded before, which may be outdated.", or "Refresh failed." when the page shows an error panel.
- `ProjectsView` passes the run resource's `meta` to `RunView` as `freshness`.
- `ProjectsView` also reports `onRefreshingChange` while any shown level is still refreshing. The App's Projects Refresh button is then `aria-busy` and reads "Refreshing…", like the skills button.
  - It is `aria-disabled`, not `disabled`, and ignores clicks while busy. A disabled button would drop the keyboard focus to `<body>`.
  - `.button[aria-disabled='true']` looks like `.button:disabled`, and the generic hover skips it.
- Polling still stops for succeeded and cancelled runs. Their chip says "○ Finished · not polling".

**Durations**
- Check rows: `02:05:00 → 02:06:00 · 1m00s · cwd …` (`.check-duration`).
- Reviewers: `took 3m49s` (`.reviewer-duration`), from `launched_at` to `accepted_at`, shown only when both were recorded.

**Trim**
- The RunView status enum footnote and the NodeDetail node footnote are removed.
- As section 8 prescribes, each status badge now carries a short `title` (`STATUS_TITLE` in `status.ts`), including "Only a succeeded run is a completed workflow; a succeeded worker step is not."
- `overflow-wrap: anywhere` is set on `.node-detail` (with `min-width: 0`) and `.worker-summary`.
- The `.node-detail-footnote, .run-footnote` rule is removed from `App.css`.

**Test plumbing**
- `tests/project-workflows/playwright.config.ts` uses `timezoneId: 'UTC'` and `locale: 'en-GB'`.
- `package.json` `test:unit` keeps the six `server/*.test.ts` files and replaces the three listed unit files with `tests/unit/*.test.ts`. The glob picks up `time.test.ts` now and S2's `triage.test.ts` once it merges.
- New files: `tests/unit/time.test.ts` (16 tests) and `tests/project-workflows/ux-time.spec.ts`. The spec holds scenarios `time-local-utc` and `live-freshness`, and one untagged test, "A run list left open past midnight re-reads which day is today".
- `fixtures/ux-time.ts` registers the workflow `ux-time` with one run, `run-short-check`, in both phases.
  - The run is shaped like `run-failed`.
  - Its ui verification's first check took 2.54 s, the same span as skeleton-001's first game check, so its row reads `3s`.

**Fixture extension point** (section 11 rules). `tests/project-workflows/fixtures/index.ts` aggregates the seven modules `ux-time`, `ux-run`, `ux-node`, `ux-verify`, `ux-launch`, `ux-review` and `ux-lists`. All are empty except S1's own `ux-time`, which holds `run-short-check` and also serves as a worked example for later slices. Each module is a `UxFixtureModule { payloads?, seed? }`.
- **Worker phase.** When first imported, `index.ts` spreads each module's payloads into the maps `fixtures.ts` exports:
  - it appends the module's workflows to `PROJECT`;
  - it derives their run lists in contract order;
  - it defaults events, results and artifacts to empty for every added run.

  `mock.ts` imports it for that side effect.
- **Candidate phase.** `seedCandidate` calls `seedUxFixtures` with a `SeedContext`: `repository`, `runsRoot(workflowId)`, `writeRun`, `writePacket`, `receipt`, `internalEvent` and `leakFor`.
  - The returned registry entries are appended to `PROJECT`'s workflows.
  - A module's `seed` may also return top-level `registry` keys. S6 needs this for `viewer.expose_run_dir`, and cannot edit `seed.ts`.
- **Builders.** `fixtures.ts` now exports the builders later modules need: `definition`, `runDetail`, `event`, `checks`, `artifactRefs`, `logArtifact`, `done`, `candidateOf`, `lanesVerified`, `offset`, `projectReview`, `projectInputs`, and the types `DefinitionNode` and `NodeState`. `projectReview` takes an optional `workflowId`, because a module's run is not in `runDetails` yet when it projects its review.
- **No import cycle.** Modules import `fixtures.ts` builders and only types from `index.ts` and `seed.ts`, and `fixtures.ts` does not import the aggregator.
- **Probe.** I checked end to end with a temporary module (a workflow with no runs) in both phases: the project's workflow list showed it last, and its page showed `empty-runs` and its definition. The probe is not committed.

## 2. Red evidence (against the unchanged product code)

Unit, against a skeleton `time.ts` whose exports return placeholders: `npx tsx --test tests/unit/time.test.ts` gave **16 tests, 15 failed, 1 passed**. The one pass is "an unreadable value is shown as served", which the skeleton's identity return satisfies trivially. Typical failures:
```
actual: '',                      expected: '0s'          (formatSpan)
actual: '2026-03-01T10:20:00Z',  expected: '10:20'       (formatClock)
actual: '2026-09-24T09:32:31.411386Z', expected: '2026-09-24 09:32:31 UTC'
actual: 'live',                  expected: 'watching'    (freshnessState)
```

Browser, worker phase: `npx playwright test -c tests/project-workflows/playwright.config.ts ux-time.spec.ts inputs.spec.ts guardrails.spec.ts --reporter=line` gave **4 failed, 9 passed**:
```
ux-time time-local-utc:      expect(locator).toHaveText("02:00") — element(s) not found   (no <time> elements)
ux-time live-freshness:      expect(locator).toHaveAttribute("data-state", "finished") — element(s) not found   (no live-status)
inputs worker-inputs:        time[datetime="2026-03-01T10:00:00Z"] not found   (migrated assertion)
guardrails worker-questions: time[title="2026-03-01 10:07:00 UTC"] not found   (migrated assertion)
```
The live-freshness test stops at the missing chip. A temporary copy holding only its Refresh part, since deleted, showed the second red reason, "Refresh blanks":
```
expect(getByText('Loading run run-failed')).toHaveCount(0)   Expected: 0   Received: 1
```
The candidate phase (`WORKFLOW_VERIFICATION_PHASE=candidate`) failed the same way: **4 failed, 9 passed**.

**Test-authoring mistakes**, recorded separately from the product reds:
1. The spec used `window` inside `page.evaluate` callbacks. `tsc -b` rejects this, because tests compile without the DOM lib. The spec now uses string expressions, like `document-render.spec.ts`.
2. `refresh.click()` first scrolls the header button into view, which reset the scroll position the test measures. The first green run failed with `Expected: 493, Received: 0`. The spec now uses `dispatchEvent('click')`.
3. The spec read the scroll position before the node page had settled (493 instead of 400). It now waits for `checks-list` and `node-events`, and polls until `scrollY === 400`.

### Review round (tests written first, run against the first two S1 commits)

**Test changes**
- `time-local-utc` now does four things:
  - It fixes the page clock with `page.clock.setFixedTime` and expects the run's Created to read "yesterday 02:00" on the next day, and "Mar 1 10:00" in September.
  - It checks the `3s` row on the new `ux-time` fixture run.
  - It checks the 44 px zone buttons at 390×844.
- A new untagged test installs the page clock at 23:59:30 Los Angeles time and fast-forwards one minute. It expects a run-list time to change from "02:45" to "yesterday 02:45" in place.
- `live-freshness` now also checks four things:
  - a failed Refresh on the succeeded run shows `refresh-failed` and announces "Refresh failed";
  - the next successful Refresh clears it and announces "Refreshed. Loaded run …";
  - the keyboard-pressed Refresh keeps the focus;
  - its outcome is announced.

**Worker phase:** `npx playwright test -c tests/project-workflows/playwright.config.ts ux-time.spec.ts --reporter=line` gave **3 failed**:
```
time-local-utc:   created  Expected: "yesterday 02:00"  Received: "02:00"      (the run's day is never named)
midnight test:    updated  Expected: "yesterday 02:45"  Received: "02:45"      (Time's frozen useState "today")
live-freshness:   getByTestId('refresh-failed')  Expected: visible  element(s) not found   (a failed Refresh is silent)
```
Two of those tests stop at their first failure. A temporary probe spec, since deleted, recorded the later reds:
```
zone buttons at 390 px:   Expected: >= 44   Received: 30
focus after Enter on Refresh:   { during: "BODY", after: "BODY" }   expected BUTTON both times
announcer after Refresh:  Expected substring "Refreshed. Loaded run run-failed"   Received "Loaded run run-failed: failed."
3 s check row on ux-time/run-short-check:   passed   (a fixture gap only: the product already rounded 2.54 s to 3s)
```

**Candidate phase:** `WORKFLOW_VERIFICATION_PHASE=candidate`, the same files plus the probe, gave **5 failed, 1 passed**. The failures were the same as in the worker phase. The one pass was the seeded `3s` row, which shows that the new seed works.

## 3. Green evidence (final tree)

| Check | Result |
| --- | --- |
| `npx tsx --test tests/unit/time.test.ts` | 16 passed |
| `npx tsc -b` | clean |
| `npx eslint <every changed or new .ts/.tsx file>` | clean |
| `npx playwright test -c tests/project-workflows/playwright.config.ts --reporter=line` (worker; all 8 project-workflows spec files, since `Time`, `useResource` and `ProjectsView` render on every Projects page) | 37 passed (2.9m) |
| same with `WORKFLOW_VERIFICATION_PHASE=candidate` | 37 passed (3.0m) |
| `MD_MANAGER_WEB_PORT=5184 MD_MANAGER_API_PORT=3014 npx playwright test tests/graph.spec.ts tests/listing-refresh.spec.ts tests/document-failure.spec.ts` (App.tsx header and the global `.button` rules changed) | 21 passed |
| `sh -c 'echo tests/unit/*.test.ts'` (the new glob) | document, editSession, model, time |

The first worker run of the whole set failed 2 tests, and both were fixed before the runs above:
- the scroll test-authoring mistake (item 2 in section 2);
- `lanes.spec.ts:102`, which led to deviation 1 below.

## 4. Migrations (same commit)

| Where | Change | Why |
| --- | --- | --- |
| `inputs.spec.ts:143-144` | `time[datetime="2026-03-01T10:00:00Z"]` has `title` "2026-03-01 10:00:00 UTC"; `time[title="2026-03-01 10:00:02 UTC"]` reads "10:00:02" | receipt times are `<time>` elements, and the long UTC text is only the tooltip |
| `inputs.spec.ts:155` | `worker-stop` contains "Stop confirmed at 10:20.", and its `<time>` title is the UTC value | the stop line shows the clock; wording per deviation 1 |
| `guardrails.spec.ts:56` (`shown()`), `:222`, `:224`, `:231` | `shown(scope, iso)` locates `time[title="<UTC text>"]`; each use asserts "asked at" plus that `<time>` | times are `<time>` elements; the tooltip is phase-independent, and `datetime` is whatever string the phase serves |
| `tests/project-workflows/playwright.config.ts` | `timezoneId: 'UTC'`, `locale: 'en-GB'` | local time is the default, so clocks in specs are pinned; `time-local-utc` overrides the zone to `America/Los_Angeles` |

## 5. Deviations from the PRD

1. **Stop line wording.**
   - The line reads "Stop confirmed at 10:20.", not "Stopped 10:20 · stop confirmed" (12.3). `lanes.spec.ts:102` pins the substring "Stop confirmed", and 12.3 does not list it.
   - Section 8 keeps pinned substrings, so I kept the wording instead of editing a spec outside S1's list.
   - When S4b rewrites the stop line into the Session disclosure, it must migrate `lanes.spec.ts:102` too.
2. **"A check row shows 3s": resolved in the review round.** `fixtures/ux-time.ts` adds the run `run-short-check` (workflow `ux-time`) in both phases. `time-local-utc` asserts its `3s` row beside the existing `1m00s` and `5m00s` rows.
3. **`mock.ts` edited**, one side-effect import. It is not in S1's file list, and it was unavoidable:
   - The modules need `fixtures.ts`'s builders.
   - So `fixtures.ts` cannot import the aggregator without an import cycle, whose failure would depend on which file a spec imports first.
   - Instead, the aggregator merges into `fixtures.ts`'s own maps, and `mock.ts` loads it.
   - Later slices still never edit `fixtures.ts`, `mock.ts` or `seed.ts`.
4. **`panels.tsx` edited**, to add the `title` attribute on `StatusBadge`. It is not in S1's file list, but section 8 pairs removing the footnotes with "each status badge gets a short `title` with its meaning". Neither S2 nor any later slice lists `panels.tsx`.
5. **Extension-point extras**, all in files S1 owns:
   - `fixtures.ts` exports its builders;
   - `seed.ts` exports `SeedContext`, `RunOptions` and `InternalEvent`;
   - a module's `seed` returns `{ workflows, registry? }`, so S6 can add `viewer.expose_run_dir`.
6. **Time reference provider.** The `TimeReferenceContext` provider is placed where `ProjectsView` renders `RunView`, not inside `RunView`. This is the same scope, and it avoids re-indenting the body of `RunView`, which S3 rewrites anyway.
7. **Chip placement.** The chip and toggle sit in a row with the `run-status` line, right under the `h2`. Today the status badge lives in `run-status`, not on the `h2` row. `time-local-utc` asserts that the toggle's box vertically overlaps `run-status`.
8. **`useResource` meta has two extra fields.**
   - `refreshing` drives the Refresh busy state without the App knowing about resources.
   - `refreshError` drives the failed-Refresh notice. It holds the error of a Refresh that failed while data was shown, until a later load of that resource succeeds.
9. **`Assignment.tsx` is unchanged.** Section 11 lists it for call sites only, but it has no `formatTime` call site. Its timeouts use `formatDuration`, which stays.
10. **No `features/viewer-ux-s1/policy.json`.** S1 ships as a direct commit (section 11 "Delivery", open question 5), and S1's file list does not include one. A feature directory holding only a `policy.json`, with no `feature.json` or tasks, would be malformed. The ids are `time-local-utc` and `live-freshness`. The first feature policy whose `project-workflows-browser` check runs the whole config (S3's) can list them.
11. **The run's start names its day.** Section 5.3 prefixes the date "only when it differs from the run's start day or today".
    - Read literally, the Created fact is compared with itself and never shows a date. I read the rule as two parts:
      - the run's start is read against today;
      - every other run-page time is read against the start's day.
    - The PRD's wording should say so.
12. **Refresh is `aria-disabled` while busy, not `disabled`.** Section 6.3 asks for the busy state that the skills Refresh uses, and that button is `disabled`. A disabled button drops the keyboard focus to `<body>`, so the Projects Refresh stays focusable, ignores clicks while busy and looks disabled. The skills Refresh is unchanged; see section 6.
13. **Refresh announcements.** The PRD does not word them. They follow the skills Refresh: "Refreshing." when it starts, then "Refreshed. <what loaded>" or "Refresh failed. …".

## 6. Follow-ups

- **S3.** Move `LiveStatus` and `TimeZoneToggle` into `RunHeader` without changing their testids, then remove `.run-status-row` and `.run-freshness` from `App.css`. `time-local-utc` finds the created time by its UTC tooltip, not by the facts grid, so it survives the header rewrite as long as the created time stays a `<time>` on the run page. The "beside the run status" check expects `run-status` to stay on the toggle's row.
- **S6.** Adds the controller suffix to `LiveStatus` with its 15 s debounce.
- **Pressed-button hover.** The app-wide `.button:hover:not(:disabled)` rule outranks `.button[aria-pressed='true']`. A pressed button under the pointer therefore loses its accent background, so the label washes out. I fixed this only for the zone toggle. A general `.button[aria-pressed='true']:hover` rule would fix the other pressed buttons.
- **Events and inputs on a failed Refresh.** The `refresh-failed` notice reads the four levels `ProjectsView` loads: the run detail, the run list, the workflows and the projects.
  - `RunView`'s events and inputs also keep their data when a Refresh fails, but they do not raise the notice.
  - The run detail comes from the same API, so an unreachable API is still reported. A failure of only the events or inputs endpoint is not.
  - S3 or S4-core, which rewrite `RunView`, can pass those two metas up.
- **Skills Refresh focus.** The skills Refresh button is still `disabled` while busy, so it drops the keyboard focus to `<body>` the same way. The fix is the same one used for the Projects button: `aria-disabled`, and ignore clicks while busy. It is outside S1's scope.
- **PRD wording.** Two PRD rules need clearer wording:
  - 5.3 should say that the run's start is read against today and a run page's other times against the start's day (deviation 11).
  - 12.3's `worker-stop` wording conflicts with section 8's pinned-substring rule for `lanes.spec.ts:102` (deviation 1). Either list `lanes.spec.ts:102` under S4b or accept "Stop confirmed at 10:20.".
- **Cross-tab sync.** The zone preference is not synced between open tabs (no `storage` listener). A reload picks it up.

## 7. Review findings and outcomes

| # | Finding | Outcome |
| --- | --- | --- |
| 1 | P2: a failed header Refresh is silent (`useResource.ts:53`) | **Fixed.** `meta.refreshError` feeds the `refresh-failed` alert, which shows the reason and the time of the data shown. It appears on finished runs and on list pages too. "Refresh failed…" is announced. |
| 2 | P2: the run page never shows the run's date (`RunView.tsx:115`) | **Fixed.** `<Time anchor>` reads the Created fact against today: "yesterday 02:00", "Mar 1 10:00". `ux-time.spec.ts` now expects this with a fixed page clock, where it used to expect a bare "02:00". |
| 3 | P3: Refresh announces nothing and drops the focus to `<body>` (`ProjectsView.tsx:84`) | **Fixed.** The button is `aria-disabled` while busy, so the focus stays on it. The announcer says "Refreshing." and then the outcome, and its comment is now true. |
| 4 | P3: list "today" frozen by `useState` (`Time.tsx:14`) | **Fixed.** `useToday()` is one shared store, re-checked every minute and on `visibilitychange`. The new midnight test crosses 00:00 with the page clock. |
| 5 | P3: the zone buttons are 30 px tall at ≤760 px (`TimeZoneToggle.tsx:21`) | **Fixed.** At ≤760 px, `.time-zone-toggle .button` has `min-height: 44px; min-width: 44px`, asserted at 390×844. |
| gap | 12.3 `worker-stop` wording | **Deferred to S4b.** S4b rewrites the stop line into the Session disclosure, and must migrate `lanes.spec.ts:102` when it adopts "Stopped 10:20 · stop confirmed". Section 8 keeps pinned substrings, so S1 does not break that assertion (deviation 1). |
| gap | 12.2 "A check row shows `3s`" | **Fixed.** Added the `ux-time` fixture run and the assertion, in both phases. |
| gap | scenario ids in `features/viewer-ux-s1/policy.json` | **Not a defect.** S1 is a direct commit, and a lone `policy.json` would be a malformed feature directory (deviation 10). |
| gap | section 10's 44 px tap targets | **Fixed**, same fix as finding 5. |
| gap | 5.3 "run's start day or today" reading | **Fixed** as described in deviation 11. The PRD's wording is left to its owner (section 6). |
