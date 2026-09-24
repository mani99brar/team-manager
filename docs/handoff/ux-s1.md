# Handoff: viewer UX slice S1, time, freshness and trim (PRD_VIEWER_UX)

Implements row S1 of `docs/PRD_VIEWER_UX.md` section 11 on branch `ux/s1` (worktree `~/dev/mdm-ux-s1`, from `feature/viewer-ux`), 2026-09-24. Scope: client code and test plumbing only. It shares no file with S2 (`contracts/projects/triage.ts`, `tests/unit/triage.test.ts`, `tests/unit/fixtures/runs/*`). Only targeted checks were run (section 3). The full suites are left to the orchestrator after merge.

## 1. What shipped

**Time helpers** (PRD 5.3)
- `src/projects/time.ts` (pure):
  - `formatClock` gives `HH:MM`, or `HH:MM:SS` on request, in the local zone or UTC. The date is prefixed only when the day differs from the reference day: the run's start on run pages, today in lists, where the day before reads "yesterday". Another year adds the year.
  - `formatAgo`: "just now", "3 s ago", "14 min ago", "2 h ago", "1 d ago".
  - `formatSpan`: "46s", "1m00s", "28m21s", "1h05m", rounded to the second, so 2.54 s reads "3s".
  - `spanBetween`: null when an end is missing or unreadable, or the end precedes the start.
  - `utcTitle`: "2026-09-24 09:32:31 UTC".
  - `freshnessState`: the live chip's state rules from 6.3.
- `src/projects/useNow.ts`:
  - `useNow(active)`: ticks every 1 s only while active and the tab is visible.
  - `usePageVisibility()`: whether the tab is visible, and since when.
  - `useTimeZone()`: one page-wide Local/UTC store, kept in `localStorage` key `mdm.projects.timezone`. Every read and write is in try/catch, and it falls back to Local.
  - `TimeReferenceContext`: the instant a run page reads its times against.
- `src/projects/Time.tsx`: `<time dateTime={iso} title="… UTC">clock</time>`.
- `src/projects/TimeZoneToggle.tsx`: `time-zone-toggle`, a `role="group"` holding two `aria-pressed` buttons, "Local" and "UTC".
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
- `useResource` returns `meta { settledAt, lastError, failures, refreshing }`.
- `refreshToken` moved from `base` into `token`. A Refresh now reloads in the background like a poll: the page never blanks to "Loading run…", and scroll position and tab survive. A failed Refresh keeps the shown data.
- `ProjectsView` passes the run resource's `meta` to `RunView` as `freshness`.
- `ProjectsView` also reports `onRefreshingChange` while any shown level is still refreshing. The App's Projects Refresh button is then `disabled` and `aria-busy`, and reads "Refreshing…", like the skills button.
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
- New files: `tests/unit/time.test.ts` (16 tests) and `tests/project-workflows/ux-time.spec.ts` (scenarios `time-local-utc` and `live-freshness`).

**Fixture extension point** (section 11 rules). `tests/project-workflows/fixtures/index.ts` aggregates the seven empty modules `ux-time`, `ux-run`, `ux-node`, `ux-verify`, `ux-launch`, `ux-review` and `ux-lists`. Each module is a `UxFixtureModule { payloads?, seed? }`.
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

## 3. Green evidence (final tree)

| Check | Result |
| --- | --- |
| `npx tsx --test tests/unit/time.test.ts` | 16 passed |
| `npx tsc -b` | clean |
| `npx eslint <every changed or new .ts/.tsx file>` | clean |
| `npx playwright test -c tests/project-workflows/playwright.config.ts --reporter=line` (worker; all 8 project-workflows spec files, since S1 touched components each of them renders) | 36 passed (3.1m) |
| same with `WORKFLOW_VERIFICATION_PHASE=candidate` | 36 passed (3.3m), then `ux-time`/`inputs`/`guardrails` re-run on the final tree after a hover-only CSS change: 13 passed |
| `MD_MANAGER_WEB_PORT=5184 MD_MANAGER_API_PORT=3014 npx playwright test tests/graph.spec.ts tests/listing-refresh.spec.ts` (App.tsx header changed) | 16 passed |
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
2. **"A check row shows 3s".** No existing fixture has a 3 s check, and the PRD lists no S1 fixture addition. The scenario therefore asserts the existing ui checks, `1m00s` (build) and `5m00s` (browser), on `run-succeeded`/`verify_ui`. The 3 s rounding case (2.54 s gives "3s") is covered by the unit test. `fixtures/ux-time.ts` stays empty.
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
8. **`useResource` meta has a fourth field, `refreshing`.** It drives the Refresh busy state without the App knowing about resources.
9. **`Assignment.tsx` is unchanged.** Section 11 lists it for call sites only, but it has no `formatTime` call site. Its timeouts use `formatDuration`, which stays.
10. **No `features/viewer-ux-s1/policy.json`.** S1 ships as a direct commit (section 11 "Delivery"), and S1's file list does not include one. If the orchestrator wants the ids in a policy, they are `time-local-utc` and `live-freshness`.

## 6. Follow-ups

- **S3.** Move `LiveStatus` and `TimeZoneToggle` into `RunHeader` without changing their testids, then remove `.run-status-row` and `.run-freshness` from `App.css`. `time-local-utc` finds the created time by its UTC tooltip, not by the facts grid, so it survives the header rewrite as long as the created time stays a `<time>` on the run page. The "beside the run status" check expects `run-status` to stay on the toggle's row.
- **S6.** Adds the controller suffix to `LiveStatus` with its 15 s debounce.
- **Pressed-button hover.** The app-wide `.button:hover:not(:disabled)` rule outranks `.button[aria-pressed='true']`. A pressed button under the pointer therefore loses its accent background, so the label washes out. I fixed this only for the zone toggle. A general `.button[aria-pressed='true']:hover` rule would fix the other pressed buttons.
- **Stale "today" in lists.** Lists read dates against the day they were first rendered. A list left open across midnight keeps the old "today" until it re-renders.
- **Cross-tab sync.** The zone preference is not synced between open tabs (no `storage` listener). A reload picks it up.
