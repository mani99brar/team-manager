# Handoff: viewer revamp, lane `pages` (PRD_VIEWER_REVAMP 5.3, 5.4, 5.5)

Lane `pages` of workflow run `viewer-revamp-004`, 2026-10-01, in its own worktree on the scaffold commit; run `viewer-revamp-005`
restored this lane's paths from run 004's candidate (`63c9c464`) and closed the coverage findings (section 7). The `shell` lane's
files (`theme.css`, `tone.ts`, `ui/`, `App.tsx`, `App.css`, `ProjectsView.tsx`, the lists, `NowBanner.tsx`, `CommandBlock.tsx`,
`LiveStatus.tsx`, `ux-lists.spec.ts`, `projects.spec.ts`) were imported or run, never edited; its worktree was not read. Nothing
was committed (the controller owns git).

## 1. What shipped

- **Run page** (`RunView.tsx`, `RunHeader.tsx`, `StepsTimeline.tsx`, `WorkflowGraph.tsx`, `run.css`)
  - Header card (`run-header`, `data-tone`, `tone-<tone>`): a 4 px top rule in the run's tone, `stateTone({ status, attention })`
    (what waits on the operator wins); Bold draws the rule as tone → band → accent. Content, `.status-badge`, `run-status`,
    `run-status-meaning`, the time-zone toggle beside `run-status` and every `<time>` unchanged.
  - Now banner: unchanged markup (shell's), restyled in `run.css` with a tone left rule over the tone's soft background.
  - Lanes line as chips: unchanged markup (`NowBanner.tsx` `LanesLine`, shell-owned); `run.css` styles each `li` as a chip and
    tones it from its steps' `status-text-*` classes with `:has()` (failed > running > paused/awaiting > all passed = ok).
  - Board (`run-board`, `data-layout="side-by-side" | "stacked"`): Pipeline (`run-pipeline`, header "Pipeline · N steps") and
    Steps (`run-steps`, header "Steps · n of N done"). Side by side when the board is wide enough for the compact graph at its
    83 % floor plus a 400 px Steps column (`node/board.ts` `boardSplitWidth`, measured on the board with a ResizeObserver),
    stacked otherwise; at ≤760 px the graph stays hidden. In the narrow column Steps rows go to two lines (container query),
    hint below the rows.
  - Graph: `compact` prop (112 px nodes, 16 px gaps; same columns, rows, meta line, legend, dash patterns, aria-label format,
    roving keys and 83 % floor) used only by the run page; the feature page keeps the default geometry. Every node of a run
    carries `data-tone` and `tone-<tone>` (`stateTone({ status, attention })`): soft fill, tone stroke, status bar and glyph;
    the amber attention ring and `?` stay on top.
  - Steps rows: a 3 px rule in the row's tone (attention keeps its amber rule); bars and glyphs through the tone tokens
    (`status-fill-*`, `status-text-*` now map to `--ok/--run/--warn/--fail/--pause/--idle`).
  - Activity: one `<details data-testid="activity-group" data-phase data-tone open>` per consecutive phase stretch
    (`groupActivity`: challenge, workers, freeze and verification, review and integration; node-less rows, sidecar rows and
    gaps join the stretch they occur in, before any step the first phase). All open by default; "Collapse all"/"Expand all"
    (`activity-expand`); Newest first reverses groups and rows (`orderActivityGroups`), so the first `li` is the last event.
    Each summary says the phase, its event count and where it stands in words (`phaseState`: "2 failed", "waiting on you",
    "paused", "running", "all passed"), so a closed group is never colour only. Rows, test ids and texts unchanged.
- **Node pages** (`NodeDetail.tsx`, `NodeHeader.tsx`, `StepStrip.tsx`, `node.css`)
  - Header card with a top rule in the node's tone; step strip chips toned (`stateTone`); attempt chips tinted by status;
    Bold section titles take the band.
  - Review (`node/ReviewSections.tsx`, `ReviewDetail.tsx`, `node/review.css`): `review-figures` (`figure-blocking`,
    `figure-open`, `figure-reviewers` with `[data-reviewer][data-count]`, `figure-lanes` with `[data-lane][data-count]`), then
    the blocking card(s) outside `review-findings`, then the verdict, facts (bundle, diff link), the findings as `Card`s
    (`finding` test id; `data-severity`, `data-disposition`, `data-worker`, `data-reviewer`; `finding-blocking`; severity
    stripe `--p0/--p1/--p2`; `SeverityChip`, disposition chip, "blocks integration" chip; `finding-worker`, `finding-reviewer`,
    requirement with `finding-task-link`/`finding-task-unlinked`/`finding-requirement-none`; file links unchanged), ordered P0,
    P1, P2, then lane (run lanes, other lanes, multiple, none, not recorded), then declared reviewer, else record order
    (`orderFindings`). One `FilterToggles` row (`findings-filters`): each reviewer (`reviewer:<id>`), each populated lane group
    (`lane:<key>`, labelled by its id), `Open only` (`open`), each with its count; within a kind they add up, across kinds they
    narrow (`filterFindings`); `review-findings[data-filters]` names the pressed ids or `all`. Reviewer cards
    (`reviewer-entry`, toned by the reviewer's own outcome) follow the findings.
  - Verify: `verify-figures` (`figure-checks-passed`, `figure-checks-failed`, `figure-checks-deferred` when any, `figure-took`),
    counted like the check rows (`node/gate.ts` `checkTally`).
  - Worker: `worker-figures` (`figure-files` from the freeze, else the result; `figure-completion`; `figure-questions`, "n
    waiting" in warn when a question waits).
  - Challenge, controller and sidecar pages: restyled only through shared CSS; content and test ids unchanged.
- **Pure helpers**: `node/model.ts` `nodePhase`, `groupActivity`, `orderActivityGroups`, `phaseState`, `ACTIVITY_PHASE_LABEL`;
  `node/panels.ts` `orderFindings`, `filterFindings`, `reviewFigures`, `findingFilterIds`, `OPEN_ONLY`, `reviewerFilterId`,
  `laneFilterId`; `node/board.ts` (new) the compact geometry and `boardSplitWidth`; `node/gate.ts` `checkTally`.
- **Fixtures** `fixtures/ux-revamp-pages.ts` (workflow `revamp-pages` of `alpha-project`, both phases): `revamp-done`
  (succeeded 2026-03-11, challenge, two lanes, general + coverage approved with a resolved P1 and two P2s over both lanes),
  `revamp-blocked` (failed 2026-03-12, coverage blocked with an open P1 on ui and an open P2 on adapter, general approved with
  an open P2 on ui and an accepted P2 on adapter), `revamp-running` (running 2026-03-12, adapter's question 1 waiting, in the
  export and the live `adapter.questions.json`; worker-phase detail is contract 1.5.0 with its served `activity`). The spec's
  clock is `2026-03-12T12:00:00Z`.

## 2. Red, then green

- Unit, before the helpers existed: `npx tsx --test tests/unit/steps.test.ts tests/unit/panels.test.ts` failed to load:
  `does not provide an export named 'OPEN_ONLY'` (panels.ts) and `... 'ACTIVITY_PHASE_LABEL'` (model.ts). After: 40 pass, 0 fail.
- Browser, before the page changes (worker phase, `revamp-pages.spec.ts` only): `revamp-run` failed at
  `getByTestId('run-header')` "element(s) not found" after the run had loaded to `data-situation="succeeded"`; `revamp-review`
  failed at `review-figures .ui-figure` expected 4, received 0, with the review's rows present. After: both pass in both phases.

## 3. Checks run (final)

- `npm run build`: passes (only Vite's chunk-size warning). `npm run lint`: clean.
- `npx tsx --test tests/unit/steps.test.ts tests/unit/panels.test.ts`: 40 pass. `npm run test:unit`: 337 pass, 0 fail.
- Full `tests/project-workflows` suite with the JSON reporter (every spec this lane changed, `ux-run`, `ux-time`, `ux-node`,
  `ux-verify`, `ux-launch`, `guardrails`, `sidecar`, and the shell's `projects.spec.ts` and `ux-lists.spec.ts` read-only):
  `WORKFLOW_VERIFICATION_PHASE=worker` 61 expected, 0 unexpected; `WORKFLOW_VERIFICATION_PHASE=candidate` 61 expected,
  0 unexpected; `workflow check-report ../policy.json pages` on the candidate report: "The scenarios in this report follow the
  verifier's rules".
- The candidate run cleared `test-results`, which removed the worker report's screenshots, so the worker phase was run again
  on the changed and touched spec files (`revamp-pages`, `review`, `reviewers`, `lanes`, `clarity`, `inputs`, `ux-review`,
  `ux-run`, `ux-time`): 32 expected, 0 unexpected; `check-report` on it: follows the verifier's rules.

## 4. Migrations (PRD_VIEWER_REVAMP section 8): old → new, same fact

| Spec | Old | New |
| --- | --- | --- |
| `review.spec.ts` review-verdict | `section[data-disposition=open]` heading "Open", 4 rows; accepted 2; no resolved; `section` count 2 | cards `[data-disposition=open]` 4 (its chip says `open`), accepted 2, resolved 0; the set of dispositions is {open, accepted} |
| `review.spec.ts` review-verdict | `columnheader` = Severity, Message, Worker, Reviewer, Requirement | every card has one `.ui-sev`, one `.finding-message` and labels Worker, Reviewer, Requirement |
| `review.spec.ts` review-verdict | `group-by-disposition` pressed; `group-by-worker` → 4 `section[data-worker-group]`, ui 3, none heading "No worker"; back | `figure-lanes [data-lane]` 4, ui `data-count` 3, none says "no worker"; `lane:ui` toggled by keyboard → 3 cards all `data-worker=ui`; Enter again → 6; open 4 |
| `review.spec.ts` review-blocked | `section[data-disposition=open/resolved/accepted]` rows | cards by `data-disposition` (open 1 P1 blocking, resolved 1 P2, accepted 0) |
| `reviewers.spec.ts` | `data-group-by=reviewer`, click `group-by-disposition`, `data-reviewer-filter=all`, `columnheader`s | reviewer toggles `reviewer:general`, `reviewer:coverage` in declared order; `data-filters=all`; each card's field labels |
| `reviewers.spec.ts` | `filter-reviewer` All pressed; `general (2)`, `coverage (3)`; single-select | reviewer toggles unpressed; `general 2`, `coverage 3`; toggles add up (both = 5), none = all |
| `reviewers.spec.ts` | coverage filter → `section[data-disposition]` open 2 accepted 1; `group-by-worker` → `section[data-worker-group]` ui 2 adapter 1 | coverage pressed → cards by `data-disposition` open 2 accepted 1, by `data-worker` ui 2 adapter 1; plus `lane:ui` narrows to 2 (`data-filters="reviewer:coverage lane:ui"`) |
| `reviewers.spec.ts` | general filter → worker groups ui 1 adapter 1, 2 rows; All → 5, ui 3, open 3 | only general pressed → `data-worker` ui 1 adapter 1, 2 cards all general; none pressed → 5, ui 3, open 3 |
| `reviewers.spec.ts` blocked | click general (0, empty line), then click coverage (2) | press general (0, "Reviewer general recorded no findings."), release it, press coverage (2) |
| `reviewers.spec.ts` legacy | `filter-reviewer` count 2 (All + review), `review (2)` | one reviewer toggle, `review 2` |
| `lanes.spec.ts` three lanes | `group-by-worker`; 5 `section[data-worker-group]` in order; headings `Worker <lane> (1)`, `Multiple workers (2)`, `No worker (cross-cutting) (1)`; Worker column `td:nth(2)` | `figure-lanes [data-lane]` in the same order; texts `<lane> 1`, `multiple workers 2`, `no worker 1`; each lane 1 card; `lane:multiple` → 2 cards (legacy `both` and `multiple`); `finding-worker` text unchanged |
| `lanes.spec.ts` one lane / legacy-run | `section[data-worker-group]` order `[docs, none]` / `[ui, adapter, multiple, none]` with `Worker ui (3)`… | `figure-lanes [data-lane]` order; `ui 3`, `adapter 1`, `multiple workers 1`, `no worker 1`; `lane:ui` → 3 cards; card counts per `data-worker` |
| `clarity.spec.ts` findings-by-reviewer | `data-group-by=reviewer`, `section[data-reviewer-group]` in declared order with h5 `general · approved · 2 P2 (2)`, `coverage · approved · 1 P1, 2 P2 (3)`; filter vs. grouping; single reviewer opens by disposition | reviewer toggles and reviewer cards in declared order; card verdict `Approved` and counts `2 P2` / `1 P1, 2 P2`; toggles `general 2` / `coverage 3`; cards per `data-reviewer` 2/3; the coverage filter holds while Open only is pressed and released; single reviewer: one toggle, one reviewer card, `data-filters=all`. Title reworded, scenario id kept |
| `clarity.spec.ts` legend | three entries | unchanged (three entries; no fill assertion existed) |
| `inputs.spec.ts` finding-to-task | `td` last = `—` | `finding-requirement-none` = `—` |
| `ux-review.spec.ts` review-blocking-first | blocking card precedes `findings table`; at 390 px row `display: block`, 5 `columnheader`s, `.table-wrap` no overflow | precedes the first `finding` card; card `display: flex`, one `.ui-sev` and labels Worker, Reviewer, Requirement; no card overflows. Title says "before the finding cards" |

No other assertion changed: `ux-run`, `ux-time`, `ux-node`, `ux-verify`, `ux-launch`, `guardrails`, `sidecar` pass unmodified.
(Run 005 only added assertions to `ux-verify.spec.ts` `gate-rejected-checks`; none was changed or removed.)

## 5. Deviations from the PRD and open assumptions

1. **Side by side is measured, not a fixed 1,100 px breakpoint.** At the default 136 px nodes the two-lane guarded graph is
   1,316 px wide with an 83 % floor of ≥1,092 px, so it cannot sit beside Steps at 1,440 px while `graph-fits` (no sideways
   scroll at 1,280/1,440, columns in order) holds. The run page therefore draws a compact graph (112 px nodes) and splits when
   the board fits floor + 400 px Steps (1,289 px of board for an 8-column graph, a window of about 1,325 px): side by side at
   1,440, stacked at 1,280 and below for that graph (narrower graphs split earlier). The node meta line keeps its full text (`clarity` asserts it), so in compact nodes it is squeezed harder than
   before (about 2.8 px per character vs 3.6); it is `aria-hidden`, the glyph, outline and accessible name carry the same.
2. **Phases are consecutive stretches**, not buckets: a phase that recurs (e.g. a re-launch after verification) is a second
   group with the same title, so rows never leave chronological order.
3. **Lane filter toggles are labelled by their group id** (`ui`, `multiple`, `none`, `unrecorded`), per the button allow-list
   ("each reviewer or lane id"); the Per lane figure uses words for the specials ("multiple workers", "no worker").
4. Disposition chips: `open` warn, `resolved` ok, `accepted` idle; the severity stripe carries the severity, the blocking card
   and the "blocks integration" chip carry fail.
5. Reviewer cards come after the findings and the facts (bundle, diff link) stay right after the summary rather than in the
   node header.

## 6. For the `shell` lane (seam notes)

- Settled in run 008: `ui/index.tsx` `FilterToggles` takes `Omit<DivProps, 'onToggle'>` (asserted by `ui/props.check.ts`), and
  `ReviewDetail.tsx` passes a handler typed `(id: string, on: boolean) => void`, with no guard (section 10).
- `tone.ts` imports `'../../contracts/projects/v1'` without the `.ts` extension, which fails `tsc -b` under
  `tsconfig.node.json` (`nodenext`) as soon as a file under `tests/` imports `tone.ts` (directly or through a module). So
  `node/model.ts` takes the tone mapping as a parameter (`phaseState(rows, toneOf)`) instead of importing it.
- The lane chips' tones read `NowBanner.tsx` `LanesLine`'s `status-text-<status>` classes on `.run-lane-step` (shell-owned
  markup); renaming those classes would leave the chips idle-grey.
- `run.css` restyles the Now banner's `run-now-<tone>` classes and the lanes line; their markup is untouched.

## 7. Run 005

Run `viewer-revamp-005` started from run 004's verified candidate: every path this lane owns was restored with
`git checkout 63c9c464e6787bf7f538a51cfae4fb628faab408 -- <owned paths>`, then the coverage reviewer's findings on this lane were
closed. Each new check was run against the code it guards before the change (red) and after (green).

| Finding (run 004 `review.json`) | What closes it | Red (before) | Green |
| --- | --- | --- | --- |
| P1: the one-clock rule has no test; `WorkerQuestions` (`WorkerInputs.tsx:285`) kept its own `useNow(waiting > 0, 30_000)` | `WorkerQuestions` takes `clock` (from `RunView` through `NodeDetail` → `WorkerSections` → `SessionDisclosure`); no `useNow` import left. Static check in `tests/unit/steps.test.ts` ("one clock: useNow is called only in RunView.tsx and ProjectsView.tsx"): scans every `.ts`/`.tsx` under `src/projects` and fails on any `useNow(` call or any import naming `useNow` (whole-source match, so multi-line and aliased imports count; `ns.useNow(` counts) outside `RunView.tsx`, `ProjectsView.tsx` and the hook's own `useNow.ts`; self-tests on run 004's shape, a multi-line `useNow as tick` import, a namespace call, and `useTimeZone` (not a clock). Browser test "One clock: …" in `revamp-pages.spec.ts`: the waiting question's age moves from "(4 min ago)" to "(5 min ago)" within 3 s of the minute turning (clock paused at 10:24:58, a 30 s section clock started at 10:24:20 cannot tick before 10:25:20); the running header span moves after a minute; a succeeded run's page and its review node read the same text after two minutes (polls included) | with run 004's `WorkerInputs.tsx` restored: unit `actual: ['WorkerInputs.tsx:12', 'WorkerInputs.tsx:285'], expected: []`; browser `Expected substring: "(5 min ago)"`, received `… (4 min ago) …` | both pass |
| P2: untested node-page restyles (worker Files figure, verify gate line and check tone chips, step strip in tone, Now banner rule and soft background) | The gate line and check table were not restyled on run 004's candidate, so this run ships them: `.gate-line` carries `data-tone` (`ok` passed / `fail` failed) and `tone-*`, a 4 px left rule in the tone over the tone's soft background, the verdict word in the tone; each check's `.check-exit` is a `ui-chip` with `data-tone` (passed ok, failed/rejected fail, deferred idle), text unchanged; check glyphs, rejected rows and the candidate lane table read `--ok`/`--fail` instead of the app's `--danger-*`/`--node-location-stroke`. Assertions (`revamp-review`): gate line rule/background/word colours = `--ok`/`--ok-soft`; three check chips `exit 0`, `ui-chip`, `data-tone=ok`, colour/background = `--ok`/`--ok-soft`, glyph `--ok`; every step strip chip `tone-ok` with `--ok-soft`, one current; on the running run `launch_adapter` warn (`--warn-soft`), `launch_ui` run (`--run-soft`), challenge ok; the Files figure = 3 with "Files changed" on `revamp-done/launch_ui` (the fixture now freezes `UI_CHANGED_FILES`/`ADAPTER_CHANGED_FILES`; it froze none before, so the figure read 0) and "—" / "Files (not frozen yet)" on the running worker; completion `completed` in ok. `revamp-run`: the Now banner's left rule and background = `--ok`/`--ok-soft` (succeeded) and `--warn`/`--warn-soft` (question) | the new `.gate-line`/`.check-exit` assertions fail on run 004's markup (no `data-tone`, no `ui-chip`); the Files assertion failed on the fixture with no frozen files (`created-file` count 0) | pass |
| Review sidecar S-4: the gate line and check chips tested on the passing path only | `ux-verify.spec.ts` `gate-rejected-checks` (scenario id and every existing assertion unchanged, assertions added): the failed gate's `.gate-line` has `data-tone=fail`, `tone-fail`, left rule `--fail`, background `--fail-soft`, verdict word `--fail`; the passing build's exit chip `ui-chip` `data-tone=ok` in `--ok`/`--ok-soft`; each rejected row's exit chip `data-tone=fail` in `--fail`/`--fail-soft`, its stripe and background `--fail`/`--fail-soft`, its reasons and glyph `--fail`; on verify_adapter the non-zero exit's chip fail and the passing contract check's ok. The contrast sweep also reads this failed-gate page (gate line, exit chips, reasons, rejected row heads) | mutation `STATE_TONE.rejected = 'ok'` in `Checks.tsx`: `Expected: "fail"`, received `"ok"`; `GateFailure` without `tone-fail`/`data-tone`: `Expected: "fail"`, received `""` | pass |
| P2: run and node pages only measured in Calm light | Test "The run and node pages' chips, figures, phase summaries, cards and step strip read at 4.5:1 in Calm and Bold, light and dark": `emulateMedia` light/dark (dark asserted to change `--bg`) × Calm/Bold (Bold set as `data-look="bold"` on `main.projects-shell` after each navigation, `--band` asserted non-transparent; Calm asserted transparent); on five pages (run done, run running, blocked review, verify_ui, running launch_adapter) every element with its own text under the header card, Now banner, lane chips, phase summaries, section headers, figures, finding card heads (`.ui-sev`, disposition and blocking chips), filter toggles (also pressed), reviewer cards, blocking card, gate line, check chips and step strip chips; contrast of the text colour (with opacity) over the composited background ≥ 4.5:1; > 200 readings | failed once in Bold light: the blocking card's "Requirement in the ui task ›" link, accent `rgb(200, 70, 28)` on `--fail-soft` `rgb(252, 218, 218)`, 3.72:1 | links in the blocking card take `--fg`, underlined (`node/review.css`); passes |
| P2: the button allow-list asserted on Runs home only | Test "Every button on the run and node pages is on the read-only allow-list …": three run pages (also collapsed and newest first), every step of `revamp-done`, the blocked review and the waiting worker; each button's text must match PRD_VIEWER_UX 12.3 + PRD_VIEWER_REVAMP section 8 + the controls PRD_VIEWER_UX specifies on these pages (see assumption 6), each filter label a reviewer or lane id with its count, and must not hold a path or command (no slash, backslash, dollar sign or backtick, and none of the words npm, npx, git, workflow, node, python, bash); `expectNoExecutionControls` on each; the new tools (`Collapse all`, `Expand all`, `Newest first`) and the filter labels must be among those read | passes on run 004's candidate too (its buttons already complied); it fails on a button that does not, e.g. one reading `Retry` or holding a path | pass |
| P2: `phaseState` unit tests used a hand-copied `STATUS_TONE` | `steps.test.ts` loads `src/projects/tone.ts` itself (dynamic `import()` by URL, so `tsc -b` under nodenext does not follow the scaffold's extensionless contract import) and passes `statusTone` / `stateTone` as `StepsTimeline` does; a new test checks each status' phase tone equals `statusTone(status)` | — (no mapping drift exists to show red; a change to `tone.ts` now changes these results) | pass |

Checks run in run 005 (final): see section 8.

### Answer to the review sidecar (S-2, S-3)

The scanner matched imports per line; it now matches over the whole source and the multi-line aliased import and namespace-call
cases are asserted (the duplicated `useTimeZone` line became the multi-line case). The debug `console.log` lines were removed
before the suite runs.

### Open assumptions added in run 005

6. **The allow-list on the run and node pages** is PRD_VIEWER_UX 12.3 (`Copy`, `Show contents`, `Show lines`, `More`, `Run`,
   `Assignment`, `Local`, `UTC`) plus section 8's (`Open only`, `Expand all`, `Collapse all`, reviewer and lane ids with counts)
   plus the controls PRD_VIEWER_UX itself specifies on these pages and 12.3's summary sentence omits: `Newest first` (the
   Activity order, `ux-run`), `Controller log (N)`, an event's `#N`/`message`, `Less` after `More`, `Hide contents` after `Show
   contents`, `Rendered`/`Source`, a screenshot dialog's `Close`, a file filter's `All N`; screenshot thumbnails are image
   buttons with no text.
7. **Gate line and check chips** take the tone of the outcome (ok/fail; deferred idle); the failed gate keeps its
   `projects-error` box around the toned line.

## 8. Checks run in run 005 (final, on this snapshot)

- `npm run build`: passes (Vite's chunk-size warning only). `npm run lint`: clean.
- `npx tsx --test tests/unit/steps.test.ts tests/unit/panels.test.ts`: 43 pass, 0 fail. `npm run test:unit`: 340 pass, 0 fail.
- The whole `tests/project-workflows` suite (every spec of this lane, and the shell's `projects.spec.ts`, `ux-lists.spec.ts`,
  `revamp-lists.spec.ts` read-only) with the JSON reporter: `WORKFLOW_VERIFICATION_PHASE=worker` 64 expected, 0 unexpected;
  `WORKFLOW_VERIFICATION_PHASE=candidate` 64 expected, 0 unexpected; `workflow check-report ../policy.json pages` on each:
  "The scenarios in this report follow the verifier's rules".
- A throwaway copy of this snapshot with run 004's shell files laid over it (`theme.css`, `tone.ts`, `ui/`, `App.*`,
  `ProjectsView.tsx`, the lists) ran `revamp-pages.spec.ts` and `ux-verify.spec.ts` in the worker phase: 7 passed. This
  approximates the combined candidate; run 005's shell files may differ.
- One flake fixed along the way: the allow-list test first read buttons one by one while the review's filter row was still
  re-rendering; it now reads every button text in one `evaluateAll` after waiting for the full filter row.

## 9. Run 006

Restored every owned path from run 005's candidate (`09fafd8b`, tag `workflow/viewer-revamp-005-candidate`) and closed the
general reviewer's one P2 for this lane.

**Finding (P2): Activity's collapsed state was keyed by position** (`${phase}-${groups.length}` in `node/model.ts`
`groupActivity`), so a poll that inserts a row inside a stretch (rows are sorted by time, and receipts, inferred instants and
silences can arrive late) split it and renumbered every later key: a group the reader closed could reopen, or another close.
**Fix:** `groupActivity` now keys a group as `<phase>-<opener>`, where the opener is the group's first row *of that phase*
(its event number `#n`, else `at/node/kind`), never a node-less row, so hiding or showing the controller log also cannot change
it. A run whose rows name no step stays `run-start`. `StepsTimeline.tsx`'s `closed` set is unchanged and now holds stable keys.

**Red by mutation.** I put back run 005's `model.ts` (the positional key) and ran
`npx tsx --test tests/unit/steps.test.ts tests/unit/panels.test.ts`: 43 passed and 1 failed. The failing test is the
**regression test**: the new `steps.test.ts` case "a group keeps its key when the controller log is toggled or a poll adds
rows before, inside or after it (run 006)", whose split part fails with `the group holding candidate keeps its key` (actual
`'verification-3'`, expected `'verification-1'`). Green with the fix: 44 passed, 0 failed. That test's log-toggle and append
parts already pass under the positional key, because PID checkpoints are node-less and appended rows never renumber earlier
groups. They are guards, not red evidence.

**Browser guard (not red evidence):** `ux-run.spec.ts` `run-steps-timeline` now closes the verification group (the one holding
the diagnosis), toggles the controller log on, off and on again, and asserts that the group count is unchanged, that the group
stays closed and that exactly one group is closed. It would pass with run 005's key too (see above). It pins the behaviour so
that a future key built from the first row, a log row, would fail. Migration: none. The assertion is added and nothing is
changed or removed.

**Seam note (shell), superseded in run 008 (section 10):** in run 006's snapshot `ReviewDetail.tsx` keeps its loosely typed `onToggle(id: unknown, on?: unknown)`
handler, because the scaffold's `FilterToggles` still declares its `onToggle` over the div's own event prop. The shell lane
fixes that with `Omit<DivProps, 'onToggle'>` on the combined candidate only. Typing the handler as `(id: string, on: boolean)`
is deferred to a follow-up after the merge. The comment at `ReviewDetail.tsx:233` will be stale there.

### Checks run in run 006 (on this snapshot)

- `npm run build`: ok. Only the existing chunk-size warning.
- `npm run lint`: ok, no output.
- `npx tsx --test tests/unit/steps.test.ts tests/unit/panels.test.ts`: 44 passed, 0 failed.
- `WORKFLOW_VERIFICATION_PHASE=worker` and then `=candidate` with `npx --no-install playwright test
  --config=tests/project-workflows/playwright.config.ts --reporter=json`. Spec files: `revamp-pages`, `ux-run`, `ux-review`,
  `review`, `reviewers`, `clarity`, `lanes`, `inputs` and `ux-verify` (mine), plus `projects` and `ux-lists` (shell's, run
  read-only). Result: 46 passed, 0 failed, 0 skipped in each phase. `workflow check-report … pages` on both reports:
  `revamp-run: ok`, `revamp-review: ok`.
- `npm run test:unit`: 341 passed, 0 failed.

## 10. Run 007 / run 008

Restored every owned path from run 006's candidate (`9823632c`, tag `workflow/viewer-revamp-006-candidate`); run 007's design
challenge stopped before the workers, so this run (008) closes the run 006 coverage and general review findings for this lane.
The base now carries the shell's `ui/index.tsx` and `ui/props.check.ts` from that candidate (`FilterToggles` props
`Omit<DivProps, 'onToggle'>`), so this snapshot builds with the typed handler on its own.

**Finding (P2): ReviewDetail's loosely typed findings handler.** `ReviewResultView` typed `onToggle` as
`(id: unknown, on?: unknown)` with a `typeof id !== 'string'` guard and a comment that was no longer true. **Fix:** the handler is
`(id: string, on: boolean) => void`, with no guard and no comment (`ReviewDetail.tsx`, `onToggle` above the returned JSX).
**Evidence:** `npm run build` (`tsc -b`) passes on this snapshot, and `ui/props.check.ts` pins the prop type exactly. Red is not
reproducible as a test failure, because the old loose handler also compiled, which was the finding. The filter behaviour stays
covered by `revamp-review` (toggles combine and narrow the cards) and `clarity`/`lanes`/`reviewers`, all green in both phases.

**Finding (P1): the step strip's non-colour status carriers were untested.** `revamp-pages.spec.ts` `revamp-review` now
asserts the following:
- On `revamp-done/verify_ui`, every chip's `.step-glyph` is `✓` and its accessible name ends `, succeeded`, plus a
  `getByRole('link', { name: /^Verify .*, succeeded$/ })` lookup.
- On `revamp-running/launch_adapter`, the waiting lane's chip has `?` and the name `/, running, waits on you$/`, and exactly one link
  in the strip is named `/waits on you/`. The running lane `launch_ui` has `●` and `/, running$/`, and `challenge` has `✓` and `/, succeeded$/`.
- On `revamp-blocked/verify_ui`, the failed `review` chip is `tone-fail` with `✗` and `/, failed$/`, and exactly one strip link is
  named `/, failed$/`.

**Red by mutation** (`WORKFLOW_VERIFICATION_PHASE=worker … revamp-pages.spec.ts -g revamp-review`, `StepStrip.tsx` restored
after each):
1. Removing the `.step-glyph` span makes it fail at `expect(locator).toHaveText` with Expected `"✓"` and `element(s) not found`.
2. Making `aria-label={row.label}` (no status words) makes it fail at `toHaveAccessibleName` with Expected `/, succeeded$/` and Received `"Design challenge"`.
3. Dropping `, waits on you` makes it fail at `toHaveAccessibleName` with Expected `/, running, waits on you$/` and Received
   `"Launch adapter worker, running"`.

**Green:** all 5 `revamp-pages` tests passed (worker phase).

Migration: none. Assertions were only added.

### Checks run in run 008 (on this snapshot)

- `npm run build`: ok. Only the existing chunk-size warning.
- `npm run lint`: ok.
- `npx tsx --test tests/unit/steps.test.ts tests/unit/panels.test.ts`: 44 passed, 0 failed. `npm run test:unit`: 341 passed, 0 failed.
- Browser, `WORKFLOW_VERIFICATION_PHASE=worker` and then `=candidate`, with `--reporter=list,json` in two chunks per phase. The first chunk was
  `revamp-pages ux-run ux-review review reviewers clarity` (25 passed). The second was `lanes inputs guardrails ux-node ux-verify
  ux-launch sidecar ux-time projects ux-lists` (39 passed; `projects` and `ux-lists` are the shell's, run read-only). Result:
  64 passed, 0 failed in each phase. `workflow check-report … pages` on each phase's first-chunk report: `revamp-run: ok`,
  `revamp-review: ok`, "The scenarios in this report follow the verifier's rules".

