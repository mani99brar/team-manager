# Handoff: viewer UX slice S3, the run page (PRD_VIEWER_UX)

Implements row S3 of `docs/PRD_VIEWER_UX.md` section 11 on branch `ux/s3` (worktree `~/dev/mdm-ux-s3`, from `feature/viewer-ux` after S1 and S2 merged), 2026-09-24. S5 ran beside it; S3 changed no file of S5's (`server/**`, `contracts/projects/**` except `triage.ts`, `config/`). Only targeted checks were run (section 3); the orchestrator runs the full suites after merging.

## 1. What shipped

**The run page answers first** (4.2). Top to bottom:

1. **A one-row Projects header** (`App.tsx`, `App.css`): title · Pi/Claude/Projects · Refresh in one 48 px row on Projects routes, without the Pi/Claude subtitle. At ≤760 px it wraps to two rows: title and Refresh, then the roots. The skills routes keep their subtitle, and their roots still sit on a row of their own.
2. **The breadcrumb**: `Projects / project / workflow title / run / node label`. There is no Home crumb; the roots lead home. The workflow title follows rules 2-3 of 4.1 (`workflowTitle` in `status.ts`): the workflow id under the exporter's generic "Feature implementation", else the name. It also applies to the project page's cards and the workflow page's heading. On a phone the trail keeps its last two crumbs. `projects-info` (the read-only note) is shown only on `/projects`.
3. **`RunHeader`** (`RunHeader.tsx`), two lines:
   - Line 1: the feature as title (else the workflow title) and the run id, then `run-status` (the badge plus `run-status-meaning` in a few words, `RUN_STATUS_SHORT`), then the span (`start → end · 52m51s` once finished, `started … · running …` while running, else `started … · last activity …`). The live chip and the Local/UTC toggle move here from S1's `.run-status-row`, with their testids unchanged. A long title is ellipsized, so the status, span, chip and toggle keep one row.
   - Line 2: `run-inputs-facts`, the visible facts line (`branch @ base · mode · deadlines`), the definition chip (`definition-current` / `definition-changed`), and `Details ▸` (`run-details`). The disclosure holds the feature, the full base commit, permission mode, finish, the pinned definition, Created and "Export updated".
   - A run without inputs shows `inputs-none` in place of the facts, with the same chip and Details.
   - At ≤760 px the facts line and the `definition-current` chip go behind Details, but `definition-changed` stays visible: it is a warning.
4. **`NowBanner`** (`NowBanner.tsx`, `run-now[data-situation]`): the headline, the reason and the next step, rendered from `deriveNow`. Rich text parts go through S1's `<Time>`, `formatAgo` and `formatSpan`, against the page's one ticking clock. The status glyph is shown apart and hidden from screen readers.
   - The reason is clamped to two lines, with `More` once it overflows. An "Open <focus step> ›" link sits outside the clamp.
   - The banner waits (`aria-busy`, no `data-situation`) until it has what its rules read: events, inputs, the review, and the `nowResultUris(detail, events)` lane results.
   - Lane results are cached per URI for the page's lifetime (a module cache in `RunView.tsx`). A 404 counts as absent. Another failure counts as settled and is retried by the next Refresh.
   - If the events fail to load, an error panel with Retry takes the banner's place.
5. **`CommandBlock`** (`CommandBlock.tsx`, `now-next`): the label line reads "Likely next step — <label>", then `RUNBOOK “<topic>”` (every reference in its tooltip), then the `$PY/$RUN` legend disclosure (`command-legend`, `COMMAND_LEGEND`).
   - The steps are a numbered list (`now-step`). A command lives in a `<code data-testid="now-command">` outside any button, with its caption inline. Beside it, `copy-command` has the text exactly "Copy" and `aria-label="Copy command"`. It writes to the clipboard, or selects the code where the clipboard API is unavailable, and a small status says "Copied" or "Selected: copy it with Ctrl+C".
   - A text step is plain text. The caveat follows the steps, then the caption `COMMAND_CAPTION`, shown only when the block has a command.
   - On a phone, a command and its Copy button share a line, and the code scrolls sideways inside its own box.
6. **The lanes line** (`LanesLine`, `run-lanes`), for runs with 2+ lanes: one line per lane from `laneLines`, coloured by status. From the fourth lane on, lanes move behind `+n more`.
7. **Tabs `[Run] [Assignment]` above the graph.** They are routed: `routes.ts` parses and builds `/runs/<r>/assignment` (`assignmentPathname`, `ProjectsRoute.tab`). Selecting a tab, arrow keys, Home and End each navigate. The tabs keep role, `aria-selected`, roving tabindex and `aria-controls`. The graph lives in the Run tabpanel.
8. **The fitted graph** (`WorkflowGraph.tsx`, `dag.ts` 136/28):
   - The SVG has `width="100%"`, a `max-width` of its layout width and a `min-width` of 83 %; below that it scrolls inside its box, and the Now banner's focus step is scrolled into view in the box (only the box scrolls, never the page). It is hidden at ≤760 px.
   - A status glyph (`aria-hidden`) sits in a badge on each node's corner.
   - A node waiting on the operator carries `data-attention`, an amber ring and `?`.
   - Selection is a text-coloured outline plus an offset ring.
   - The keyboard hint is gone from the page; it is now a visually hidden `aria-describedby`.
   - The legend is three `li[data-executor]` items ("Agent session", "Trusted verifier", "Controller"), with the full sentence in `title` and in visually hidden text.
   - The per-kind stroke colours and the pending and awaiting dash overrides are removed. The DAG rules moved from `App.css` to `run.css`.
9. **`StepsTimeline`** (`StepsTimeline.tsx`):
   - **Steps** (`StepsTable`, a `<table data-testid="run-node-list">`): one row per step, `tr[data-node-id][data-status][data-attention]`. Its cells are the step link, Started, Took (`≈` when inferred, with the source in the tooltip), Attempts (`attempt k · ✗✗⚑⚒✓`, one mark per attempt, so a candidate attempt that passed on one lane and failed on another is one `✗`; `—` for a step not started), Outcome (ellipsized, full text in `title`), and an `aria-hidden` bar on the run's time axis.
   - The axis runs from the run's start to its end. A running or awaiting run's axis ends now; any other unfinished run's ends at its last activity. Silences over 30 min become short breaks, marked in the bar track. A controller outage (`controller_down` gap) inside a worker's attempt is hatched over that worker's bar (`outageBands`).
   - `node-hint` is the table's caption, shown below it. On a phone each row wraps to two lines, and explicit ARIA roles keep the table semantics.
   - **Activity** (`Activity`, `run-timeline`): an `<ol>` of `timeline.activity`, oldest first. `activity-order` ("Newest first") is remembered in `localStorage` key `mdm.projects.activityOrder`, with every read and write in try/catch.
   - `activity-controller-log` ("Controller log (n)") shows PID rows, hidden by default. Node-less diagnosis and repair rows are ordinary rows (⚑ Controller, ⚒ Operator).
   - A row that rewords its served message carries an `#n` button (`activity-more`, `aria-expanded`) that opens the event number's full message under the row (`activity-raw`); keyboard and touch reach it.
   - Gap rows are text (`┆ operator time 5m37s`). A failed attempt, or any attempt of a step with more than one, links to `/nodes/<n>` with `open ›`.
   - The model behind both is the new pure `src/projects/steps.ts`: `stepRows`, `timeAxis`, `outageBands`, `shortStepLabel`, `formatShortSpan` and `withoutGlyph`.
10. **Node pages**:
    - **Run bar** (`RunBar`): the run id linking to the run page, `run-status` with its meaning, the Now headline (ellipsized, a link to the run page), then the chip and the toggle.
    - **Tabs**, as on the run page.
    - **`StepStrip`**, sticky (`nav` → `ol[data-testid="run-node-list"]` → `li[data-node-id][data-status][data-attention]` → `<a aria-current>`): chips in the graph's column order, with lanes stacked in their column, and `‹ Run`, `‹ Prev`, `Next ›`. On a phone it is one sideways-scrolling row, with the current chip scrolled into view (the strip scrolls, not the page).
    - **The node area**: today's `NodeDetail`, full width. The node list column and the empty "Select a node…" panel are gone.
11. **Focus**: selecting a step scrolls to the top and focuses `#node-detail-title` (`tabIndex=-1`). Coming back to the run page focuses the step's link in the Steps table. Nothing moves on first load or on Refresh.
12. **Attention**: `document.title` becomes `? Waiting · <run> — <title>` while a question, pane or approval waits, and is restored after. The polite announcer says `Now: <headline>` only when the situation changes after the first derivation.
13. **Removed**: the keyboard hint, the "Select a node" panel, "Last event: sequence N", the Updated fact on the first screen (it is in Details as "Export updated"), and the info line on every level but `/projects`.
14. **`triage.ts` fix, found while wiring.** `review_blocked` names the reviewers that blocked first. `reviewers-flow` declares the superseded `general` before the blocking `coverage`, so the reason used to open with "general was superseded". Pinned by a new unit test.

## 2. Red evidence (against the unchanged product)

**Unit tests.** They ran against skeleton `steps.ts` exports (final types, empty functions) and a routes skeleton (the `tab` field typed, `assignmentPathname` returning the run path). Command: `npx tsx --test --test-reporter=spec tests/unit/routes.test.ts tests/unit/steps.test.ts`, which gave **25 tests: 18 failed, 7 passed**.

The 7 passes: 6 routes tests that pin unchanged URLs, and "nothing waits on the operator in a finished run", which passes vacuously on an empty row list. Key failing lines:

```
`assignment` after the run id …   actual: null   expected: { level: 'run', …, tab: 'assignment' }
the Assignment view of a run      actual: '/projects/alpha/workflows/flow/runs/run-1'   expected: '…/run-1/assignment'
one row per step …                actual: []     expected: [ 'challenge', 'launch_game', 'handoff', … ]
timeAxis …                        actual: -1     expected: 0
the step strip shortens …         actual: 'Launch game worker?'
```

**The triage fix, test first.** `npx tsx --test tests/unit/triage.test.ts` gave 61 tests, 1 failed:
`actual: 'coverage was superseded (no verdict). general blocked the candidate: …'   expected: /^general blocked the candidate: …/`.

**The step outcome rule, test first**, added during the visual pass: a paused, repaired step's outcome is its latest state. `npx tsx --test tests/unit/steps.test.ts` gave 17 tests, 1 failed:
`actual: 'unit: no passing test evidence or failed tests; integration: …'   expected: /^repair 1: snapshot 50b14b3/`.

**Browser, worker phase.** `npx playwright test -c tests/project-workflows/playwright.config.ts ux-run.spec.ts --reporter=line` gave **6 failed**, one per scenario, each for the reason in the 12.2 table:

```
run-now-banner, run-steps-timeline, narrow-run, question-attention:
    expect(locator).toHaveAttribute("data-situation", …) — element(s) not found     (no run-now)
graph-fits:        the graph must not scroll sideways at 1280 px   Expected: <= 1212   Received: 1688   (the 1,680 px layout)
assignment-routed: expect(page).toHaveURL(/…\/run-succeeded\/assignment$/)
                   Received: "…/runs/run-succeeded"                                   (tab in component state)
```

**Browser, candidate phase** (`WORKFLOW_VERIFICATION_PHASE=candidate`, same command): the same **6 failed**, with the same messages.

The migrated assertions were not red. The old node list also carried `run-node-list [data-node-id][data-status]` on node pages, so the migrations passed before and after.

**Test-authoring mistakes**, not product reds:

1. `ux-run.spec.ts` asserted the legend with `toHaveText` of the short labels. The `li` also holds the visually hidden sentence, so it now uses `toContainText`, plus a one-line check.
2. Two `banner = await openRun(...)` assignments were unused (`no-useless-assignment`). Those cases now assert on the banner.
3. `steps.test.ts` expected `2m17s` for skeleton-001's verify span at #21. The real span is 09:19:13.95 → 09:21:30.18, which is `2m16s`. I had carried the browser fixture's value over.

## 3. Green evidence (final tree)

| Check | Result |
|---|---|
| `npx tsx --test tests/unit/routes.test.ts tests/unit/steps.test.ts tests/unit/triage.test.ts tests/unit/time.test.ts` | 103 passed |
| `npx tsc -b` | clean |
| `npx eslint <every changed or new .ts/.tsx file>` | clean |
| `npx playwright test -c tests/project-workflows/playwright.config.ts --reporter=line` (worker, all 9 spec files: the slice changes every run and node page) | **43 passed** (4.2m) |
| same with `WORKFLOW_VERIFICATION_PHASE=candidate` | **43 passed** (3.7m) |
| `MD_MANAGER_WEB_PORT=5184 MD_MANAGER_API_PORT=3014 npx playwright test tests/graph.spec.ts tests/listing-refresh.spec.ts tests/document-failure.spec.ts` (the `App.tsx` header) | 21 passed |

**Fixture parity.** A throwaway script seeded the candidate registry, projected the eight `ux-run` runs through the real `RunStore`, and compared them field by field with the worker mocks: statuses, attempts, result URIs, lane results and sessions; every event's node, status, attempt, type, time and message; results; inputs; and the review. It found **0 differences**. The first comparison differed only in the verify nodes' session ids, which were then fixed.

**Measured fold at 1440×900.**

| Run | Focus row | Bottom (budget ≤ 900) |
|---|---|---|
| `run-reviewer-blocked` | review, row 7 of 9 | 870 |
| `run-identical` | candidate, row 6 of 9 | 892 |

At 390×844, the Now banner of `run-reviewer-blocked` ends at 827. Screenshots: `scratchpad/ux/after/s3-run-1440.png`, `s3-run-390.png` (plus `-full`), `s3-node-1440.png`, `s3-node-390.png`, `s3-identical-1440.png` and `s3-repaired-1440.png`.

**The visual pass** fixed these problems before the green runs above:
- the graph's status glyph collided with two-line labels (it moved to a corner badge);
- a paused run's bar axis ran to now, months away (it now ends at the last activity);
- the attempt marks were clipped;
- a repaired step showed the verdict of the attempt before the repair;
- the title pushed the status away from it, and the header row wrapped at 1280 px;
- phone Steps rows ellipsized their labels;
- phone tap targets were under 44 px.

## 4. Migrations (same commit as the slice)

| Where | Change | Why |
|---|---|---|
| `clarity.spec.ts:118` (loop over node pages) | `nodeListItem(page, id).getByRole('link').click()` | node pages show the step strip, not the graph (12.3) |
| `review.spec.ts:104-106` | `nodeListItem(...)` `data-status` | same (12.3) |
| `reviewers.spec.ts:135-136` | `nodeListItem(...)` `data-status` | same (12.3) |
| `projects.spec.ts:317-319` | `nodeListItem(...)` `data-status` | same (12.3) |
| `lanes.spec.ts:250-251` (**not in 12.3**) | the graph count and `inputs-none` are asserted on the run page; the node page asserts the strip's 9 items and `data-status` | the same node-URL graph assertion, which the PRD's list missed; the node page no longer carries the run header |

These stay unchanged, as 12.3 says:
- `inputs.spec.ts` tabs, `:56` and `:89`;
- `node-hint`;
- `definition-changed` and `definition-current`;
- `run-inputs-facts`: its `toContainText` reads the nested Details;
- S1's `ux-time.spec.ts`.

## 5. Deviations from the PRD

**Files and slice boundaries**

1. **Files outside the S3 list:**
   - `src/projects/NodeDetail.tsx`: one attribute, `tabIndex={-1}` on the node heading, which focus management needs.
   - `tests/project-workflows/lanes.spec.ts`: the migration above.
   - New `src/projects/steps.ts`, `tests/unit/routes.test.ts` and `tests/unit/steps.test.ts`, inside S3's `src/projects/**` and `tests/unit/**` scope.
2. **Tabs on node pages.** The tabs also show on node pages, where Run is selected and the node area is its panel. `guardrails.spec.ts:297` clicks `tab-assignment` from a node page and is not in 12.3. The 4.4 wireframe shows no tabs there.
3. **Warning tokens.** `--warn-bg/-border/-text` and `--attention` are defined in `run.css` for both schemes, not in `index.css`, which is outside S3's files.
4. **No `features/viewer-ux-s3/policy.json`.** As in S1's deviation 10, a lone `policy.json` would be a malformed feature directory. The ids are `run-now-banner`, `run-steps-timeline`, `graph-fits`, `assignment-routed`, `narrow-run` and `question-attention`.

**Header, breadcrumb and run bar**

5. **The roots `nav` moved into `<header>` on every route.** On Projects the DOM order matches the one row (title, roots, Refresh). On the skills routes CSS puts the roots on their own row under the title and Refresh, so the look is unchanged, but the keyboard now reaches the roots before Refresh. Re-mounting the nav per domain would drop the focus from a clicked root link.
6. **No status glyph on the run crumb.** `Breadcrumbs.tsx` (in `src/graph/`) takes plain-string labels, and a bare `✗` would be read aloud. The header badge sits right below the crumb.
7. **Run status wording.** `run-status-meaning` now shows the short `RUN_STATUS_SHORT` ("did not complete", "waits on you, not complete", …), with the cause in the banner. `RUN_STATUS_MEANING` stays for the run lists' badges (S6). On a phone the header's phrase is visually hidden, since the banner headline repeats it, so the badge and the span share a line.
8. **Run bar.** On node pages it shows the Now headline as a link to the run page, not the PRD's "Next step ›".

**Now banner and command block**

9. **The RUNBOOK is named, not linked.** The viewer cannot serve `workflow/RUNBOOK.md`, so the block shows `RUNBOOK “<topic>”` with every section in the tooltip.

**Graph**

10. **The status glyph sits in a corner badge** on each node, not inside the label area. With the fitted 136 px node, an inline glyph overlapped two-line labels.

**Steps and Activity**

11. *(Resolved in the review round, section 7: Activity has an expander.)*
12. *(Resolved in the review round, section 7: outages are hatched on worker bars.)*
13. **Steps "Took"** is the first attempt's start to the last verdict, as in the 4.2 wireframe (`11m07s` for three challenge attempts).
14. **Steps "Outcome"** is the step's latest status row when that is newer than its last verdict. A repaired step waiting for its continuation shows the repair, not the failure before it.
15. **The Steps caption** reads "Select a step to open its evidence. ≈ marks a time no event recorded: it is inferred (hover for the source)."

**Tab title**

16. **`document.title`** keeps whatever title the page had after its `? Waiting · <run> — ` prefix. The static title in `index.html` is `md-manager`.

**Fixtures**

17. **The worker-phase events** of `fixtures/ux-run.ts` are derived from the same raw records the seed writes, through a small in-module mirror of the adapter's pre-B1 `normalizeEvents`. The fixtures are therefore written once, and the parity check in section 3 confirms that both phases agree.

## 6. Follow-ups

- **After S5 merges.** Rerun both phases. With B1, node-less controller rows are served with a status and candidate rows with `[lane] `. The triage model reads both forms, and my fixtures' raw nodes are `candidate_<lane>`, so the candidate phase should keep passing. B1 is not in this tree, so this is unverified.
- **S4-core:**
  - Retarget Activity `open ›` to `/nodes/<n>/attempts/<k>` (`StepsTimeline.tsx`, `Activity`).
  - Share `RunView.tsx`'s result cache (`cachedResults`, `useRunResults`) through `useRunData.ts`.
  - `node-next` can reuse `CommandBlock`.
- **The candidate row's outcome** reads "ui: combined revision …". A failed lane could show its gate summary from the lane result, which is already fetched for the banner.
- **Not done yet:**
  - the S1 follow-up that passes the events and inputs `meta` up for the refresh-failed notice.
- **PRD corrections proposed:**
  - add `lanes.spec.ts:250-251` to 12.3's S3 migrations;
  - say whether tabs show on node pages;
  - allow the warning tokens outside `index.css`.
- **Between 760 and ~1,000 px** the Steps table's Outcome column is squeezed to a few characters beside the bar column (seen at 780 px; the full text is in its tooltip). A later layout pass could drop the bar column in that band.
- **No browser fixture has a controller outage inside a worker span**, so the hatched bands are pinned by unit tests on the captured guardrails payload only.
- **S6.** Apply the title rule 1 (`activity.feature`) in `workflowTitle`'s callers once B2 serves it.

## 7. Review round

An independent review listed 3 findings and 10 gaps. Each was checked first.

| Item | Outcome |
|---|---|
| Candidate attempt marks, one per lane span (`✓✗✗` on guardrails) | **Fixed.** `steps.ts` groups spans per attempt: live → `●`, else the worst lane verdict. Guardrails' candidate now reads `attempt 2 · ✗✗`. |
| `definition-changed` hidden at ≤760 px | **Fixed.** Only `definition-current` goes behind Details; the changed chip stays (`narrow-run` asserts it on `run-succeeded` at 390 px). |
| `buildTimeline` not memoized in `RunView` | **Fixed**, though smaller than reported: `buildTimeline` already caches per run on (last_sequence, statuses, inputs, review, results), so `deriveNow` and `laneLines` never rebuilt it; each tick paid only the key check. It is now `useMemo` on `run`. |
| Graph focus not scrolled into view at 760-1,100 px | **Fixed.** `WorkflowGraph` takes `focusId` (the Now focus) and centres it in its box when it starts outside. |
| Hatched outage bands (deviation 12) | **Fixed.** `outageBands` plus `.step-bar-outage`. |
| Activity tooltip, not an expander (deviation 11) | **Fixed.** `#n` button with `aria-expanded`. |
| graph-fits x-order not exercised on two lanes | **Fixed** (test only): `run-succeeded`'s stacked launches and verifications share an x, and the seven columns stay in order. |
| question-attention checks only the first answer form | **Fixed** (test only): both forms are asserted there too. |
| No `policy.json`, no crumb glyph, run bar without "Next step ›", tokens in `run.css`, tab title suffix | Not defects: deviations 4, 6, 8, 3 and 16 stand, for the reasons given there. The step strip right below the run bar has `Next ›`. |

**Red first** (against the tree before this round):
- `npx tsx --test tests/unit/steps.test.ts`: `actual: '✓✗✗'  expected: '✗✗'` (candidate marks); with a skeleton `outageBands` returning `[]`: `actual: []  expected: [ '4m56s', '6m35s' ]`.
- `ux-run.spec.ts -g narrow-run`: `expect(getByTestId('definition-changed')).toBeVisible()` failed with `unexpected value "hidden"`.
- `ux-run.spec.ts -g graph-fits` at 780 px on `run-awaiting-approval`: `the focus step is scrolled into the graph box  Expected: true  Received: false`. (At 900 px, and with `run-reviewer-blocked`'s review focus at 780 px, the step already sat in the box; the assertion was moved to a focus that did not. That was a test-authoring correction, not a product red.)
- `ux-run.spec.ts -g run-steps-timeline`: `getByTestId('activity-more')` not found.
- The two test-only gaps passed immediately: the product already did what they assert.

**Green**: the 4 unit files, 106 passed; `npx tsc -b` clean; `npx eslint` on every touched file clean; the whole project-workflows suite, **43 passed** in the worker phase and **43 passed** with `WORKFLOW_VERIFICATION_PHASE=candidate`. `App.tsx` was not touched in this round. Screenshots: `scratchpad/ux/after/s3-fix-*.png`.
