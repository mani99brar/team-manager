# Handoff: viewer UX slice S4a, verification and candidate pages (PRD_VIEWER_UX)

Implements row S4a of `docs/PRD_VIEWER_UX.md` section 11 (4.6, the Checks, Screenshots, Candidate lanes, Identifiers and Other-artifacts rows of 7, and 8) on branch `ux/s4a` (worktree `~/dev/mdm-ux-s4a`, from `feature/viewer-ux` after S4-core merged), 2026-09-24. S4b ran at the same time in another worktree; none of its files were touched. The first commit ran worker-phase checks only; the review-fix commit (section 7) ran the affected specs in both phases. The orchestrator runs the full suites.

## 1. What shipped

- **`src/projects/Checks.tsx`** (new). `Checks` renders one row per executed check (`checks-list`, `li.check#check-<n>`, `data-state` = passed / failed / rejected / deferred, `data-check-id`). Each row shows, in order:
  - a glyph;
  - the declared check id, matched by exact command against `inputs.workers[].checks`, as TaskPanel matches them;
  - the command, truncated with an ellipsis;
  - `+m:ss` from the attempt start (the header's timing start);
  - the duration and `exit N`;
  - the gate's reasons about that check (`.check-reasons`);
  - the `Show contents` / `Hide contents` log toggle.

  The row's tooltip names the command, cwd, log artifact id and absolute UTC times. The times in the chosen zone are also written as visually hidden `<time>` elements for screen readers, which also keeps `ux-time.spec.ts` unchanged. A rejected check is red even at exit 0 (`check-rejected`, `exit 0 · rejected by the gate`). Its log opens by default and scrolls to the end. A failed check (non-zero exit) opens the same way. `TextArtifact` moved here from `VerifySections.tsx`.
- **`src/projects/node/gate.ts`** (new, pure). `checkGate(result, declared)` returns the declared id of each executed check, S2's `gateReasonsByCheck`, and the rejected count (the distinct checks a reason names). The check rows, the Gate section and the lane table all count from it. Deviation 1 explains why this is a separate file.
- **`src/projects/Screenshots.tsx`** (new). A grid of thumbnails, each at most 220 px wide (`screenshots`, one `li` each), captioned with the artifact id. The sha256 is in the tooltip. Clicking a thumbnail (a button) opens a native modal `<dialog data-testid="screenshot-dialog">`. Escape, Close or a backdrop click closes it, and focus returns to the thumbnail.
- **Gate section.**
  - A failed gate is one `worker-error` alert: `Failed: N checks rejected · <code>`, with one `gate-reason` bullet per reason in the recorded order. A keyed bullet carries `data-check-id`.
  - An unkeyed reason has no `data-check-id` and is listed above the table. When its `<path>` tail matches exactly one check's command, it is also listed on that check's row, and its tooltip says so.
  - With no reason tied to a check (for example when the run's inputs, which name the checks, did not load), the headline counts the reasons (`Failed: the gate recorded 2 reasons`) and claims no rejection.
  - The retryable sentence is gone. On the failed focus verification, `node-next` now shows the situation's next step, including "No action: the supervisor retries by itself…".
  - A passing gate reads `Passed: all N gating checks … exited 0.` `deferred-checks` is unchanged. `ownership-outcome` stays on verify nodes only (`clarity.spec.ts` pins it). On candidate lanes it became a tag in the gate line.
- **Artifacts** is a closed `<details>` whose summary (`artifacts-summary`) holds the section heading and the kinds it holds (`test_report · log (not a check log) ×2`). A log that belongs to no check reads `log (not a check log)`. The kind text is kept (`clarity.spec.ts` asserts `test_report`).
- **Requirements** (verify node only, closed, `requirements`). The summary names the lane and its checks, marking those this result recorded for the candidate gate and a browser check's scenarios (`frontend-build (candidate) · … · project-workflows-browser (candidate: review-verdict, finding-to-task) · timeouts · attempt cap 3 per revision · owned paths (2)`). `node/model.ts` `verifiedSections(result, { requirements })` lists its index entry. Opened, it shows `requirements-cap` ("Attempt cap: 3 per revision"), `RequiredChecks` (scenarios, timeouts, the executed match) and `OwnedPaths`, both from `node/Requirements.tsx`. The index lists it before Result.
- **Identifiers** (`ResultFacts.tsx`). `result-facts` keeps status and attempt. A closed `identifiers` disclosure holds the session, the full base and output commits, and each non-file artifact's sha256, each shown once. The sha256 no longer appears in the screenshot or artifact rows. `ResultError` (used by the launch node) no longer carries the retryable sentence.
- **Candidate lanes** (`lane-results`).
  - The table comes first. A header row names the columns: Lane, Gate, Checks, Reason, Screenshots.
  - Each lane is a `<details data-testid="lane-result:<lane>" data-passed>`. Its summary row shows `Lane <x> · attempt k`, ✓/✗, `n of m exit 0, r rejected`, the gate's reasons, the screenshot count, and a `Files ›` link (`lane-files-link`, to the launch node). A failing lane's row adds a note (`lane-note`): `attempt k of N` on the lane's revision and, when the run's situation is `blocked_identical` for that lane, `· failed identically on attempts a and b → repair (see Now)`; its name then drops the attempt.
  - Lanes are sorted failing first, then still loading, then passing. A failing lane starts open and a passing lane starts closed.
  - The lane's body starts with `worker-report-link` (Worker's report → Launch <lane> worker ›). Its check offsets count from the start of the lane's own candidate attempt (`lane_results[].attempt`), not the shown attempt's.
  - On a lane with exactly one declared `browser` check, the screenshots sit in that check's row instead of a Screenshots block.
  - Dropped: the introduction sentence ("The combined candidate verified every lane…") and the per-lane ownership sentence. The "Trusted candidate check capture…" summary and "No open assumptions were recorded." were no longer rendered after S4-core.
  - At ≤760 px the rows wrap as cards and the page does not scroll sideways (asserted).
- **`NodeDetail.tsx`** (verify and candidate only):
  - passes the lane's declared checks, the attempt start and the requirements to `VerifiedEvidence`, and the declared checks, timeline, attempt cap and the lanes Now sends to a repair to `CandidateLanes`;
  - asks `verifiedSections` for the Requirements index entry;
  - widens the `node-next` condition to a failed focus verification or candidate.

## 2. Red evidence (tests first, against the unchanged product)

- **Browser**: `npx playwright test -c tests/project-workflows/playwright.config.ts ux-verify.spec.ts --reporter=line` gave **2 failed**:
  ```
  gate-rejected-checks:  getByTestId('worker-error')  Expected substring: "Failed: 2 checks rejected"
                         Received: "Error VERIFICATION_BLOCKED: frontend-unit: no passing …; project-workflows-browser: no passing …Marked retryable by the producer. Retrying is done through the workflow CLI, not this viewer."
  candidate-lanes-table: lane-results [data-testid^="lane-result:"].first()  Expected: "lane-result:adapter"  Received: "lane-result:ui"
  ```
- **Migration**: `projects.spec.ts -g failed-and-paused` gave 1 failed: `worker-error` `not.toContainText('Marked retryable by the producer')`, received "…Marked retryable by the producer. Retrying is done through the workflow CLI, not this viewer."
- **Unit**: `tests/unit/gate.test.ts` (not in 12.1; it covers the new pure `checkGate`) ran against a skeleton `checkGate` that returned no ids and a count of 0. `npx tsx --test --test-reporter=spec tests/unit/gate.test.ts` gave **4 tests, 4 failed**, for example `actual: [] expected: [ 'frontend-build', … ]`, `actual: undefined expected: 'workflow-unit'`, `actual: 0 expected: 2`.
- **Test-authoring mistakes** (not product reds):
  1. `gate.test.ts` expected the guardrails ui check id `frontend-unit`; the captured inputs declare `frontend-unit-regression`.
  2. `ux-verify.spec.ts` used `lane.locator('summary')`, which also matched the nested Artifacts and Identifiers summaries; it now uses `:scope > summary`.
  3. The first 390 px probe found my own `.gate-tag` (`white-space: nowrap`) overflowing at 413 px. That was a product bug and was fixed.
- **Found while going green** (product): a rejected row did not open its log when the inputs, which name the checks, arrived after the result. `TextArtifact` is now keyed by its mode.

## 3. Green evidence (final tree, worker phase)

| Check | Result |
|---|---|
| `npx tsx --test tests/unit/*.test.ts` | 156 passed (gate 4 new) |
| `npx tsx --test server/projects.test.ts` (validates every seeded fixture, the new `ux-verify` run included) | 52 passed |
| `npx tsc -b` | clean |
| `npx eslint` on every changed or new file | clean |
| `npx playwright test -c tests/project-workflows/playwright.config.ts --reporter=line`: all 11 spec files, because `VerifiedEvidence`, `ResultFacts` and `NodeDetail` render on most node pages | **47 passed** (5.0m) |

**Fixture parity instead of the candidate phase.** A throwaway script seeded the candidate registry and projected `run-rejected-checks` through the real `RunStore`. It matched the worker mocks on the snapshot (status, attempts, sessions, result URIs, lane results), all 20 events (node, status, attempt, type, time, message), the inputs, and all six results. The only differences are fields the mocks do not rewrite for any fixture: artifact `uri`, and the candidate results' `node_id` (`candidate_<lane>` served vs `<lane>` mocked). This covers the unkeyed reason: the seeded raw path `/srv/ci/.venv/bin/python` is redacted to `<path>` in `error.message`, and the check command is served verbatim.

`App.tsx` and everything outside `src/projects` and the tests are untouched, so the root skills specs were not run.

## 4. Migrations

| Where | Change | Why |
|---|---|---|
| `projects.spec.ts:313-314` (12.3) | drop "Retrying is done through the workflow CLI"; keep `worker-error` ⊇ `injected_gate_failure`; assert it lacks "Marked retryable by the producer"; assert `node-next` ⊇ "the supervisor retries by itself" | the retry note is replaced by the section 6 situation |
| `projects.spec.ts:417` candidate-evidence (**not in 12.3**) | assert the passing ui lane starts closed, open its summary, then assert `lane-result-evidence:ui` and the screenshot visible | passing lanes are closed (4.6) |
| `ux-time.spec.ts:158` (**not in 12.3**, S1's file; review-fix commit) | scroll to 120 px instead of 200 before Refresh | the compact verify page (closed Artifacts, Identifiers, Requirements) has only about 183 px to scroll at 720 px in the candidate phase, so `scrollTo(0, 200)` stopped at 183. Fails at the first S4a commit, passes at `25b1b32` |
| `ux-node.spec.ts:165` (**not in 12.3**, S4-core's file) | `worker-error` ⊇ the joined `NODE_VERIFY_FAILURE` → `gate-reason` texts equal its `"; "` segments | the gate now lists one bullet per reason instead of the joined string |

## 5. Deviations from the PRD

1. **Files outside the S4a list.** New `src/projects/node/gate.ts` and `tests/unit/gate.test.ts`: the `react-refresh/only-export-components` lint rule forbids exporting a function from `Checks.tsx` or `VerifySections.tsx`. `src/projects/node/model.ts` (review fix: `verifiedSections` takes `{ requirements }`; a separate hunk from `workerSectionEntries`, which S4b may edit). Also `tests/project-workflows/ux-node.spec.ts` and `ux-time.spec.ts` (migrations above). `clarity.spec.ts`, `ux-time.spec.ts`, `inputs.spec.ts`, `guardrails.spec.ts` and `lanes.spec.ts` were **not** edited and stay green.
2. **`node-next` on an "action: none" focus.** `NodeDetail.tsx` also shows `node-next` for a failed focus verification or candidate whose situation has no command (`check_failed`, automatic). Without this, 12.3's "assert node-next" could not hold on `run-failed`. It is a one-line condition next to the verify entries.
3. **Lane links.** `lane-files-link` (`Files ›`) sits in the summary row, since `clarity.spec.ts:246` resolves it with `getByRole('link')`, which skips the hidden body of a closed passing lane. `worker-report-link` is in the lane's body.
4. **The test report stays among Other artifacts** instead of attaching to the browser check row: `clarity.spec.ts:224` asserts `artifacts` contains `test_report` on `verify_ui`, and `clarity.spec.ts` is S4b's file in this step. Candidate-lane screenshots now sit in the browser check row (review fix); when the declared checks are unknown, or a lane declares zero or several browser checks, they stay in a Screenshots block.
5. **Absolute check times** are in the row tooltip (UTC) and in visually hidden `<time>` elements (chosen zone), not visible text. `ux-time.spec.ts` reads those elements.
6. **Offsets on candidate lanes** are measured from the start of the candidate attempt each lane was verified on (`lane_results[].attempt`), which may be inferred (≈).
7. **Not done:** the "Setup npm ci 42s (log)" line (the header already shows `setup 42s`; naming the setup command and its log needs B5's setup-log labels, S7), test counts (B5), and `features/viewer-ux-s4a/policy.json` (like S1/S3/S4-core, the scenario ids are `gate-rejected-checks` and `candidate-lanes-table`).
8. **The identical-failure note** reads the attempts from the controller's diagnosis row for the lane when there is one, else the lane's last two attempts, as `deriveNow` does; it shows only when Now's situation is `blocked_identical` for that lane (on the latest attempt's page).

## 6. Follow-ups

- **S4c / S7**: `Checks.tsx` is ready for B5's test counts and scenario pass states. `Screenshots.tsx` can take a scenario caption.
- **Merge with S4b**: the Identifiers disclosure (`ResultFacts.tsx`) also appears on a launch node that shows the facts (no verify partner). Section 7 wants worker results in a "Session" disclosure, which is S4b's; `WorkerSections.tsx` decides whether the launch node renders `ResultFacts`. Fold the identifiers into S4b's Session disclosure when both merge.
- **After S4b** (or S7, which owns `Checks.tsx`): attach the test report to the browser check row and migrate `clarity.spec.ts:224` in the same commit.

## 7. Review fixes (second commit)

An independent review listed 15 items. Outcomes:

| Item | Outcome |
|---|---|
| P2 gate headline "no check was rejected" when the inputs are unknown | fixed: the headline counts the reasons (`Failed: the gate recorded N reasons`) whenever no reason is tied to a check |
| P3 candidate lane offsets from one attempt start | fixed: each lane counts from its own candidate attempt's start (`nodeTiming(timeline, 'candidate', lane.attempt)`) |
| P3 lane grid overflows at 761 px | fixed: narrower minimum columns and a wrapping lane name; the table fits at 761 px (asserted) |
| P3 missing-log explanation only in the tooltip | not a defect: `validateWorkerResult` rejects a result whose check log is not a listed `log` artifact ("Every executed check requires a log artifact", contracts/workflow/v1.ts:165), so such a row never renders |
| Setup line | deferred to S7 (B5 setup-log labels) |
| Identical-failure lane note | fixed (`lane-note`) |
| Screenshots in the browser check row on candidate lanes | fixed |
| Test report on the browser check row | deferred: needs the `clarity.spec.ts:224` migration, S4b's file in this step |
| `worker-report-link` on candidate lanes | fixed: in the lane's body; the row keeps `Files ›` |
| Artifacts summary kinds | fixed (`artifacts-summary`) |
| Requirements summary marks | fixed |
| Session disclosure on worker results | deferred to the S4b merge (S4b owns the Session disclosure and `WorkerSections.tsx`) |
| `verifiedSections` lacks Requirements | fixed in `node/model.ts` |
| Browser coverage of the no-match unkeyed reason | fixed: the candidate adapter lane's first reason (`Executed check failed: <path> -m workflow.lint_contract`) ends no check's command and stays gate-level only |
| Candidate phase not run | fixed: run for every affected spec (below) |

**Fixture changes** (`fixtures/ux-verify.ts`): `verify_ui` attempt 2 records `deferred_checks` (build and browser; the seeded gate names them `check-0`, `check-2`), and the candidate adapter lane's failure starts with the no-match unkeyed reason. `ux-verify.spec.ts` also reads `run-identical` from `fixtures/ux-run.ts` (read only).

**Red** (tests first, against the first S4a commit; a copy of the spec with soft assertions, so every failing line shows):
```
worker-error  Expected substring: "Failed: the gate recorded 2 reasons"
              Received: "Failed: no check was rejected; the gate recorded these reasons · VERIFICATION_BLOCKED…"
requirements > summary  Expected substring: "frontend-build (candidate) · … · timeouts · attempt cap 3 per revision · owned paths (2)"
                        Received: "Requirements lane ui: frontend-build · frontend-unit · frontend-typecheck · project-workflows-browser · attempt cap 3 · 2 owned paths"
lane-result:adapter artifacts-summary / worker-report-link / lane-note   element(s) not found
lane-result:ui browser check row > screenshots img                         element(s) not found
761 px: lane-results scrollWidth - clientWidth  Expected: <= 0  Received: 30
run-identical lane-result:ui lane-note                                     element(s) not found
run-identical lane-result:adapter first .check-offset                      element(s) not found (negative offset hidden)
```
Test-authoring mistake: a first probe of the missing-log row served a result without the check's log through `page.route`; the viewer rejected it as off-contract, which is what showed the item was not a defect. The probe was removed.

Found while going green: `ux-time.spec.ts` live-freshness fails in the **candidate** phase at the first S4a commit (`scrollTo(0, 200)` reached 183) and passes at `25b1b32`; migrated (section 4).

**Green** (final tree):

| Check | Result |
|---|---|
| `npx tsx --test tests/unit/*.test.ts` | 156 passed |
| `npx tsx --test server/projects.test.ts` | 52 passed |
| `npx tsc -b` | clean |
| `npx eslint` on every changed file | clean |
| worker phase: `ux-verify projects ux-node clarity lanes ux-run ux-time` | 31 passed |
| candidate phase (`WORKFLOW_VERIFICATION_PHASE=candidate`), same seven specs | 30 passed, `ux-time` failed before its migration; after it, `ux-time` 3 passed in both phases |
