# Handoff: viewer UX slice S4b, the launch (worker lane) page (PRD_VIEWER_UX)

Implements row S4b of `docs/PRD_VIEWER_UX.md` section 11 (4.5, 7, 8) on branch `ux/s4b` (worktree `~/dev/mdm-ux-s4b`, from `feature/viewer-ux` after S4-core merged), 2026-09-24. S4a ran at the same time in another worktree. Only targeted checks were run, all in the worker phase (section 3). The orchestrator runs the candidate phase and the full suites after merging.

## 1. What shipped

**Section order** on a launch node: Questions (only while one waits) → Report → Files → Task (closed) → Session (closed) → History. The index lists the same order: `Questions n`, `Report`, `Files n`, `Task`, `Session`, `History n`.

**Questions first** (`worker-questions`, `worker-questions-waiting`). While a question waits, the section comes first. It is highlighted with the amber `--warn-*` tokens, lists the questions, and shows both answer forms through `CommandBlock`:
- `"$PY" -m workflow answer "$RUN" <lane> "<your answer>"`
- the same command with `--no-herdr`
- the caveat line

The header's `node-next` no longer repeats these commands when the Now situation is this lane's question. When no question waits, the answered questions (or `worker-questions-none`) move into Session.

**Report, said once** (`worker-completion`). The report reads "Worker's report", then the completion badge, then "as signalled by the session, not verified", said once. The completion summary (`worker-summary`) is clamped to 3 lines, with a More/Less button that appears only when the text overflows. When `result.summary` extends `completion.summary`, only the added text is shown, as `Verifier note: …` (`worker-verifier-note`). A different result summary is kept as one muted line (`worker-result-summary`).

One evidence row follows, with counts behind disclosures:
- `Untested (n) ▸`
- `Falsifying check: <link>`, inline because it is a link
- `Verify yourself ▸`
- `Open assumptions (n) ▸` (`assumptions-details` / `assumptions`)

The `worker-result` block ("Frozen at handoff as …; verified on attempt 3 after operator repair 1 as … · facts and checks on Verify ui ›") sits at the end of Report. A run without inputs shows the result's own summary and assumptions (`ResultReport`) and its facts.

**Files** (`created-files`, `changed-files` > `li[data-testid=created-file]`). Each file is one row of about 32 px, a `<details class="file-row" data-testid="captured-file">` whose `<summary>` holds:
- a disclosure triangle and the most severe finding's severity
- the path (ellipsis)
- `⚒ repair 1 · changed|added`, the first finding's reviewer and lines (`review · lines 44–50`), and `Markdown`

Nothing is fetched until a row opens: the body is not rendered while the row is closed. An opened row shows:
- the sha256 (full value in the tooltip)
- Rendered/Source for Markdown, which starts on Rendered
- the findings as one-line chips: `P1 · general · resolved — <message cut by CSS, full text in the title> [Show lines 44–50]`, or `file-findings-none` / `file-findings-no-review`
- the content, with its own 480 px scroll

Not-captured files are plain rows with their reason. Filters (`file-filters`, aria-pressed): `With findings n`, `Repair 1 · n`, `All n`, each shown only when it has rows. The default is All. The order is: rows with findings first (P0, P1, P2), then the repair's files, then the rest, each group in result order. From 10 rows on, a "Group by folder" checkbox groups the rows under folder headings.

The list comes from the worker's own freeze, `results/<lane>/1` (the verify node's attempt-1 result, already read by NodeDetail through the run cache), plus the paths only the latest result lists. The content shown is the latest result's. Repair marks compare `/1` with the latest result: a different sha256 is "changed", and a path only in the later result is "added". A mark is credited to the verify node's repair markers ("repair 1"). The review is read through `useRunReview` (the S4-core follow-up). A finding's file link from the review opens the row and scrolls it into view with `keepInView`, and focuses its summary.

**Session** (`worker-session`, closed). It holds:
- the launch receipt: "Observed state" becomes "State at launch", and it and the launcher status are hidden once the stop is confirmed
- identifiers: the result facts when no verify node shows them, else the run's base commit and the revision frozen at handoff
- the questions line
- the stop line, now `Stopped 10:20 · stop confirmed`

**Task** stays closed (`task-details`), and the finding → requirement flow still opens it.

**New pure module** `src/projects/node/launch.ts`: `repairMarks`, `fileRows`, `filterRows`, `folderOf`, `reportDelta`, `waitingQuestions`, `launchSectionEntries` (replaces `model.ts`'s `workerSectionEntries`, removed in the review fixes with the then-unused `filesCount`), `launchFilesCount`, the repair wording helpers, and `answerNext`.

**Page height**: the launch page of `launch-repaired` (42 files, 3 with findings, 2 touched by repair 1) is **2,248 px** at 1440×900, full page: `scratchpad/ux/after/s4b-launch-files-1440.png`. The question page is 1,382 px: `s4b-launch-question-1440.png`. Before this slice the live 77-file page was about 19,800 px.

## 2. Red evidence (tests first, against the unchanged product)

- **Unit**: `npx tsx --test tests/unit/launch.test.ts`, with skeleton exports in `node/launch.ts`, gave **11 tests: 9 failed, 2 passed**. The 2 passes are vacuous: "the freeze marks nothing", and the result order without a review. Key failing lines:
  ```
  repairMarks        actual: {}   expected: { 'vitest.config.ts': { kind: 'changed', … }, 'tests/reporters/testSummary.ts': { kind: 'added', … } }
  fileRows order     actual: [ 'CLAUDE.md', 'apps/server/src/MatchRoom.ts', … ]   expected: [ 'apps/server/src/MatchRoom.ts', 'apps/server/src/inputGate.ts', 'vitest.config.ts', … ]
  reportDelta        actual: { kind: 'same' }   expected: { kind: 'extends', note: 'Operator repair 1: …' }
  waitingQuestions   actual: 0   expected: 1
  answerNext         actual: []  expected: [ '"$PY" -m workflow answer "$RUN" duel "<your answer>"', '… --no-herdr' ]
  ```
- **Browser, worker phase**: `npx playwright test -c tests/project-workflows/playwright.config.ts ux-launch.spec.ts --reporter=line` gave **2 failed**:
  ```
  files-dense:            rows.first() data-path   Expected: "src/game/room.ts"   Received: "README.md"   (result order, no findings-first rows)
  launch-question-first:  getByTestId('worker-questions').getByTestId('now-command')   Expected: [both answer forms]   Received: []
  ```
  The files-dense red stops at its first assertion. The old page also rendered every Markdown panel open, fetching its content on load, but the run stopped before the no-fetch assertion.
- **Test-authoring changes after the red** (not product reds):
  - The spec first expected `added by repair 1` on the added row. The implementation words both marks `⚒ repair 1 · changed|added`, and the spec now asserts that wording.
  - `evaluateAll`/`evaluate` callbacks were replaced by `nth().toHaveAttribute` and `boundingBox()`, because of the typecheck issue in section 5.

## 3. Green evidence (final tree, worker phase)

| Check | Result |
|---|---|
| `npx tsx --test tests/unit/*.test.ts` | 163 passed (launch 11) |
| `npx tsx --test server/projects.test.ts` (seeds and validates every fixture, `ux-launch` included) | 52 passed |
| `npx eslint` on every changed/new file | clean |
| `npx tsc -b` | no error in any file this slice touched; pre-existing errors elsewhere (section 5) |
| Playwright worker phase: `clarity`, `inputs`, `lanes`, `guardrails`, `ux-launch`, `ux-node` | 22 passed |
| Playwright worker phase: `projects`, `review`, `reviewers`, `ux-run`, `ux-time` | 24 passed |

Those 11 spec files are the whole project-workflows suite. The candidate phase was not run, as instructed. `App.tsx` and everything outside `src/projects` are untouched, so the root skills specs were not run.

## 4. Migrations

| Where | Change | Why |
|---|---|---|
| `clarity.spec.ts` created-file-rendered | open the Markdown row before asserting `file-rendered`; the TS row's source shows when the row opens and disappears when it closes (was "Show source"/"Hide source") | rows start closed; nothing is fetched before a row opens (12.3) |
| `clarity.spec.ts` findings-on-files | open the audit row first; open the TS row before `file-findings-none` (text unchanged); the linked row must be open and its `summary` in view (was its `h5`) | findings show only inside an opened row; rows have no h5 headings (12.3, :268) |
| `clarity.spec.ts` output-first-task-collapsed (**not in 12.3**) | order is now report (`worker-completion`) → `worker-result` → files → task → `launch-receipt` | 4.5 puts Report before Files and Task before Session; the old test pinned files before the report and the receipt before the task. "Report and Files precede the closed Task" still holds |
| `inputs.spec.ts` receipt | open the Session disclosure first; `Observed state`/`State at launch` and `Launcher status` rows have count 0 (the worker is stopped); the `attached_session_available` text assertion is dropped with that row | 12.3 S4b row; 8 "State at launch", hidden once stopped |
| `inputs.spec.ts` stop line | `toHaveText('Stopped 10:20 · stop confirmed')` | S1's deferred wording (12.3 S1 row) |
| `lanes.spec.ts:102` | `'stop confirmed'` | same wording |
| `guardrails.spec.ts` (**not in section 11's S4b list**) | open the Markdown row before `file-rendered` (inert-markdown); open the row before `file-findings`; verify-yourself read from `.evidence-value` (was a `dd`) | rows start closed; the evidence items sit behind disclosures on one row |

## 5. Deviations and notes

1. **Files outside the S4b list:**
   - new `src/projects/node/launch.ts` and `tests/unit/launch.test.ts`: a pure module plus its tests, the same pattern as S4-core's `model.ts`
   - `tests/project-workflows/guardrails.spec.ts`: the migrations above, unavoidable because Markdown rows now start closed
   - `NodeDetail.tsx`: launch entries only; it passes `frozen` and `repairLabel`, uses `launchSectionEntries`, and drops the header's repeated answer commands
   - `model.ts`, `ResultFacts.tsx`, `triage.ts` and `CommandBlock.tsx` are imported, not edited. `WorkerNarrative` in `ResultFacts.tsx` is no longer used by the launch node; S4a owns that file.
2. **Section order** follows 4.5, not the S4-core order that `output-first` pinned (migration above).
3. **Index chip detail.** The Files chip shows only the count, not "· 3 with findings · +3 repair". NodeDetail does not read the review, and `SectionEntry`/`SectionIndex` carry no detail text, so the detail line sits on the Files heading instead (`files-summary`). Since the review fixes the count is the list's own (the freeze plus the repair-added paths).
4. **Findings inside a row stay in review order**, which `findings-on-files` pins. The row's severity is the most severe one.
5. **Show-lines button text.** The button keeps "Show line 3" / "Show lines 12–14" rather than the PRD's bare "[Show lines]", because clarity pins the text.
6. **`answerNext` duplicates the strings of `triage.ts`'s `questionNow`**, which is not exported; section 11 lets only S2 and S3 edit `triage.ts`. Since the review fixes the Questions section uses the Now banner's own step when the Now situation is this lane's question; `answerNext` only serves a second lane whose question waits behind it. Follow-up: export one builder from `triage.ts`.
7. **The worker-header "Working 12m · deadline …" line (end of 4.5) is not done.** `NodeHeader.tsx` is not in this slice.
8. **`npx tsc -b` reports pre-existing errors** in 13 test files this slice did not touch: `tests/document*.spec.ts`, `graph.spec.ts`, `helpers.ts`, `clarity`, `inputs`, `lanes`, `reviewers`, `ux-run`. The message is "Property 'getAttribute' does not exist on type 'SVGElement'" in Playwright `evaluate` callbacks. This looks like a DOM typing change in the shared `node_modules`. No error is in a file or line this slice wrote.
9. **The asking fixture is dated 2026-03-04**, so its "running 4905h26m" reads against the real clock, as in the other synthetic running fixtures.

## 6. Follow-ups

- Export the question next-step builder from `triage.ts` and use it in `answerNext`.
- The worker header's working and deadline line (4.5), in `NodeHeader`.
- S7: A/M/D marks and per-file diff hunks from `review.diff` on the file rows.
- Remove `WorkerNarrative` (`ResultFacts.tsx`, owned by S4a); it is unused now.
- The Files chip detail (`· 3 with findings · +2 repair`, 4.5): needs a `detail` on `SectionEntry`/`SectionIndex` (S4-core files) and the review read in NodeDetail; best done after S4a merges.
- 4.4 says `node-next` repeats the Now banner's next step. On a launch node whose question waits, it does not: the Questions section shows the same step (the S4b brief asked for this). Worth a line in the PRD.

## 7. Review fixes (second commit)

An independent review of the first commit found these; each was verified first.

| Item | Outcome |
|---|---|
| P1 review cache poisoned by a guessed `reviews/<n>` URL | Fixed. The launch Files section read the guessed path (review node not linked yet) through the shared, never-expiring review cache; the 404 became a `ready` null for good, also for the run page's Now banner. Now only the snapshot's linked `result_uri` goes through `useRunReview`; a guessed path is read with `useResource`, keyed on the review node's status and attempt, as before the slice. |
| P3 result summary missing when the inputs record no completion | Fixed. `ResultReport` (the result's summary and assumptions) also shows when the worker's `completion` is null. |
| P3 Files chip counted the latest result | Fixed. `launchFilesCount(frozen, latest)` counts the list's rows; the chip, the Files section and the heading agree. |
| P3 "a repair" fallback | Fixed. Without a repair marker a row reads `⚒ changed after the freeze`, the filter `After the freeze n`, the tooltip "Changed after the worker's freeze; no repair is recorded for it". |
| P3 dead code and duplicated answer step | `workerSectionEntries` and `filesCount` removed from `model.ts`; the Questions section uses the Now banner's step for this lane. Deferred: `WorkerNarrative` (S4a's `ResultFacts.tsx`) and the `triage.ts` export (S2/S3 only). |
| gap: worker header "Working 12m · deadline …" | Deferred: `NodeHeader.tsx` is S4-core's, outside S4b. |
| gap: Files chip detail | Count fixed; the detail is deferred (follow-ups). |
| gap: 44 px tap targets at ≤760 px | Fixed in `worker.css`: file rows, filters, the group toggle, the controls inside an opened row and the Report/Task/Session summaries. |
| gap: `node-next` suppressed on a question | Not a defect: intended by the brief; noted in the follow-ups for the PRD. |
| gap: question header and RUNBOOK line not asserted | Fixed. A waiting question reads `Question 2 of 3 · asked at 09:40 (… ago) · Waiting on the operator · deadline paused`; the scenario asserts that and `RUNBOOK “Worker questions”`. |

**Red** (tests first, against the first commit, with skeleton exports `repairBadge`/`repairTitle`/`repairFilterLabel` returning the old wording and `launchSectionEntries` taking the freeze but ignoring it):
- `npx tsx --test tests/unit/launch.test.ts`: 13 tests, 2 failed: `'⚒ a repair · changed'` vs `'⚒ changed after the freeze'`; the Files chip `2` vs `5` when the later result drops paths.
- `npx playwright test -c tests/project-workflows/playwright.config.ts ux-launch.spec.ts`: 4 failed:
  ```
  files-dense (390 px):       summary height   Expected: >= 44   Received: 30
  launch-review-late:         rows.first() data-path   Expected: "src/game/room.ts"   Received: "vitest.config.ts"   (the 404 stays cached)
  launch-report-no-signal:    worker-summary containing the result's summary   element(s) not found
  launch-question-first:      Expected substring: "Question 2 of 3"   Received: "Question 2 asked at 09:40 · Waiting on the operator…"
  ```

**Green**:
- unit `tests/unit/*.test.ts` 165 passed; `server/projects.test.ts` 52 passed
- `npx tsc -b`: no error in `src/` or in the files changed here (the pre-existing test-file errors of section 5 remain)
- `npx eslint` on every changed file: clean
- Playwright `clarity`, `inputs`, `lanes`, `guardrails`, `ux-node`, `ux-launch`: 25 passed in the worker phase and 25 passed in the candidate phase

Files outside the S4b list touched by the fixes: `src/projects/node/model.ts` (dead code removed only).
