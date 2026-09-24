# Handoff: viewer UX slice S4-core, the node shell (PRD_VIEWER_UX)

Implements row S4-core of `docs/PRD_VIEWER_UX.md` section 11 on branch `ux/s4core` (worktree `~/dev/mdm-ux-s4core`, from `feature/viewer-ux` after S1, S2, S3 and S5 merged), 2026-09-24. No other slice ran beside it. Only targeted checks were run, in the worker phase (section 3); the orchestrator runs the candidate phase and the full suites after merging.

## 1. What shipped

**The split** (code moved, behaviour kept unless a PRD rule below changed it). `NodeDetail.tsx` is now a dispatcher: it picks what the view reads (the latest attempt, or the viewed attempt's own result), builds the section index, and hands each kind to its file:

| File | Holds |
|---|---|
| `node/WorkerSections.tsx` (+ `worker.css`) | the launch node: Questions (only while there are any), Result, Files, Report, Session, Task (`TaskDisclosure` moved here) |
| `node/VerifySections.tsx` (+ `verify.css`) | `VerifiedEvidence` (Gate, Checks, Screenshots, Other artifacts, Result), `TextArtifact`, `ScreenshotArtifact`, the candidate's `CandidateLanes`/`LaneResult`, `WorkerReportLink` |
| `node/ReviewSections.tsx` (+ `review.css`) | the review section around `ReviewPanel` |
| `node/ChallengeSections.tsx` | the challenge section around `ChallengePanel` |
| `node/ControllerSections.tsx` (+ `controller.css`) | handoff, approval, integrate: one panel with no index; `AwaitingNotice` |
| `node/ResultFacts.tsx` | `ResultFacts` (status, attempt, session, commits), `ResultError`, `WorkerNarrative` (summary, assumptions) |
| `node/Requirements.tsx` | `OwnedPaths`, `RequiredChecks` (+ `CheckTarget`), extracted from `WorkerInputs.tsx` `TaskPanel`, which now renders them; nothing else in `WorkerInputs.tsx` changed |
| `node/model.ts` (pure) | `attemptWord`, `nodeTiming`, `attemptStrip`, `resultRole`, `verifiedSections`, `workerSectionEntries`, `filesCount`, `evidenceOf`, `sectionId`, `SectionEntry` |

**`NodeHeader.tsx`** (`node-header`, 4.4 and L1 of 7):
- Title row: the `h3` (`#node-detail-title`, `tabIndex=-1`, unchanged), the status badge and `node-executor`.
- `node-timing`: `attempt <node-attempt>` (or just `not started`), then `start → end · duration · setup · checks` from S2's `buildTimeline` spans. The setup/checks split is read from the attempt's result (5.2 rule 8), and only when the checks ran inside the span. A step recorded by one event shows one time. A source other than an event is named, e.g. `(from the launch receipt and the stop receipt)` or the inferred note; inferred times carry `≈`. A live attempt reads `running 3m…` against the page clock.
- `node-status-meaning`, worded by cause (section 8): `This step failed. <the gate's reasons, or the failing lanes' on the candidate, else the latest status message>`; `Session ended its turn. This is not workflow completion — verified by Verify ui ›`; `Passed on attempt 3 after operator repair 1.`; `Paused: <cause>. Not complete.`; pending, running, awaiting and cancelled keep their old sentences.
- `node-attempts` (only with 2+ attempts): one chip per attempt (`#1 ✗ 09:20 · 1m07s`) linking `/nodes/<n>/attempts/<k>`, rendered only once one of its results (`results/<lane>/<k>`, `results/candidate_<lane>/<k>` per lane) answered 200. A step that keeps no per-attempt result (the challenge) shows unlinked chips. The controller's diagnosis (⚑) and the operator's repairs (⚒ repair n) come from the run-level markers and sit between the attempts they concern. The viewed attempt is `aria-current="page"`.
- `node-next`: when the node is the Now focus (latest attempt only), the Now banner's next step through `CommandBlock`.

**`SectionIndex.tsx`**: `<nav aria-label="Sections of <label>" data-testid="section-index">` of in-page links with counts (`data-section`, `data-count`). It sticks under the step strip (its `top` is measured from the strip with a `ResizeObserver`). A link scrolls its section below the sticky rows and focuses its heading, without touching the path. Sections are `<section aria-labelledby data-section>` (`NodeSection`); a section that holds a panel with its own heading is labelled by that heading. Empty sections get no chip and no body: no reuse section without `result_reused` events, no empty checks, screenshots, artifacts, assumptions or files lines. The honesty lines stay: `result-none`, `worker-inputs-none`, `events-none`, and `screenshots-deferred`. History (`node-events` / `events-none`) is always rendered and always last; the stop line moved from History into Session.

**Dedup by `result_uri`** (7): when the launch and verify nodes link the same result, the verify node shows the facts (status, attempt, session, commits) and the gate's error; the launch node shows the worker narrative (`worker-summary`, `assumptions`) and one line, `Frozen at handoff as abcdef1; verified on attempt 3 after operator repair 1 as 50b14b3 · facts and checks on Verify ui ›` (only when the verification passed; see section 7), which replaces "Result attempt 3 (graph node attempt is 1)". The verify node carries `worker-report-link` ("Worker's report → Launch ui worker ›") on the index row; each candidate lane carries its own. A result no other node links keeps both.

**`useRunData.ts`**: a run-scoped cache of immutable results and reviews by URI (`useRunResults`, `useRunResult`, `useRunReview`), replacing `RunView.tsx`'s module cache. The Now banner, the review, the node's own result, the attempt chips and the candidate lanes all read through it, so a result is fetched once per page lifetime. Only detail, events and inputs poll. A 404 or a failure is asked again when the caller's stamp changes (a Refresh; for the chips also a new `last_sequence`), and stays shown meanwhile.

**The attempt route**: `routes.ts` parses and builds `/nodes/<n>/attempts/<k>` (`attemptPathname`, `ProjectsRoute.attempt`, present only on an attempt page; `k` is a positive whole number without leading zeros). `ProjectsView` passes it to `RunView`, which passes it to `NodeDetail` (keyed per node and attempt). An attempt page shows that attempt's header (status, timing, number) and, for a verification or the candidate, that attempt's own result, under `attempt-banner`: "You are viewing attempt k of N. The latest is attempt N ›". Another kind's earlier attempt shows its times and History only (`attempt-latest-only`). An attempt beyond N says it was not recorded. Activity's attempt rows (`StepsTimeline.tsx`) now open `/nodes/<n>/attempts/<k>`.

**Removed**: the always-empty Reuse evidence section, "(graph node attempt is n)", "0 (not started)", the header's Kind / Depends on / Session facts grid (the session is in Session on a launch node, in Result on a verify node, in the review panel on the review).

## 2. Red evidence (tests first, against the unchanged product)

**Unit**, with skeleton exports (`node/model.ts` functions returning empty values, `attemptPathname` returning the node path, the route type with `attempt?`): `npx tsx --test --test-reporter=spec tests/unit/routes.test.ts tests/unit/node.test.ts` gave **24 tests: 12 failed, 12 passed**. The passes: the 8 existing route tests, and 4 new ones that the skeleton satisfies vacuously (no strip for one attempt, twice; no timing for a pending step; a result nobody else links keeps both roles). Key failing lines:

```
a step that never started reads "not started"     actual: '0'   expected: 'not started'
skeleton-001 verify strip                          actual: []    expected: [ '#1 failed', '#2 failed', 'diagnosis', 'repair', '#3 succeeded' ]
the design challenge                               actual: []    expected: [ '#1 no_record', '#2 failed', '#3 succeeded' ]
launch and verify share results/game/3             actual: { facts: true, narrative: true, partner: null }   expected: { facts: true, narrative: false, partner: 'launch_game' }
`attempts/<k>` after a node id                     actual: null  expected: { …, nodeId: 'verify_ui', tab: 'run', attempt: 1 }
one attempt of a node                              actual: '…/nodes/verify_ui'   expected: '…/nodes/verify_ui/attempts/2'
```
The four `nodeTiming` tests failed on the skeleton's `null` (a TypeError reading its fields), which is the "no timing" reason, not a compile error.

**Browser, worker phase**: `npx playwright test -c tests/project-workflows/playwright.config.ts ux-node.spec.ts --reporter=line` gave **2 failed**, each for the 12.2 reason:
```
node-header:   getByTestId('node-header').locator('.status-badge').first()   element(s) not found      (no header)
node-attempts: getByTestId('node-attempts').locator('a[data-attempt="3"]')   element(s) not found      (no strip; the route unit test shows /attempts/1 parsed as null)
```
**Migrations, red first**: `npx playwright test -c tests/project-workflows/playwright.config.ts projects.spec.ts --reporter=line` gave **2 failed, 8 passed**:
```
run-evidence:       getByTestId('worker-report-link')   Expected: visible   element(s) not found
failed-and-paused:  getByTestId('node-attempt')   Expected: "not started"   Received: "0 (not started)"
```

**Test-authoring mistakes**, not product reds:
1. `node.test.ts` built the guardrails candidate's timeline without results and expected attempts `[1, 2]`. Before B1 a candidate row names no lane, and the timeline matches it to a lane only through the loaded lane results, which the run page does read for a two-lane run (`nowResultUris`). Without them it reads four attempts. The test now builds the timeline with the fixture's results, as the page does.
2. `ux-node.spec.ts` first asserted that opening attempt 1 requests `results/ui/1`. The chip had already fetched it into the cache, so no request follows; the assertion was dropped (the page's content proves which result it shows).

**Found while going green** (product, fixed before the runs in section 3):
- On a verify attempt page, the candidate's lane block was also rendered (lanes were derived for any kind); now only the candidate has lanes.
- A span recorded by its verdict alone (fixture `run-failed`, `verify_adapter`) showed `10:03:00 → 10:03:00 · 0s · setup 2m00s`: an instant now shows one time, and the split needs the checks inside the span.
- The phone section index wrapped each label letter by letter (`overflow-wrap: anywhere` on `.node-detail`); links are `nowrap` and the row scrolls sideways.
- Two hooks reading the same failed URI under different stamps could leave one of them loading; a settled failure is now shown whatever the stamp, and the stamp only decides when to ask again.

## 3. Green evidence (final tree, worker phase only, as instructed)

| Check | Result |
|---|---|
| `npx tsx --test tests/unit/*.test.ts` | 149 passed (node 12, routes 12, steps, time, triage, …) |
| `npx tsx --test server/projects.test.ts` (every seeded fixture, the new `ux-node` run included, serves a valid 1.5.0 summary) | 52 passed |
| `npx tsc -b` | clean |
| `npx eslint <every changed or new .ts/.tsx file>` | clean |
| `npx playwright test -c tests/project-workflows/playwright.config.ts --reporter=line` (worker phase, all 10 spec files: the slice changes every node page) | **45 passed** (3.9m) |

The candidate phase was not run (the orchestrator runs it). **Fixture parity** instead: a throwaway script seeded the candidate registry, projected `run-third-attempt` through the real `RunStore` and compared it with the worker mocks. The snapshot (statuses, attempts, sessions, result URIs) and all 17 events (node, status, attempt, type, time, message) match, and so do `ui/1` to `ui/3`, apart from the artifact `uri` field, which the mocks do not rewrite for any fixture. The mock serves node-less controller rows with their status, as the server does since B1.

`App.tsx` and everything outside `src/projects` and the project-workflows tests are untouched, so the root skills specs were not run. Screenshots of the visual pass: `scratchpad/ux/after/s4-*.png` (launch, verify at 1440 and 390, attempt 1, candidate, review, handoff). At 390 px the verify page is 390 px wide.

## 4. Migrations (same commit as the slice)

| Where | Change | Why |
|---|---|---|
| `projects.spec.ts:214` `worker-summary` on the verify node | `worker-report-link` visible and `worker-summary` count 0 there; `worker-summary` asserted on the launch node | the narrative is said once, on the launch node (12.3) |
| `projects.spec.ts:228` `assumptions` on the verify node | count 0 there; `assumptions` with `UI_ASSUMPTION` asserted on the launch node | same (12.3); S4b adds the "Open assumptions" disclosure, so there is nothing to open yet |
| `projects.spec.ts:233` and `:256` `reuse-none` or `reuse-list` | `reuse-list` count 0 (`:252`, the worker phase's `REUSE_MESSAGE`, unchanged) | the empty reuse section is gone (12.3) |
| `projects.spec.ts:302` `node-attempt` "0 (not started)" | "not started" | "attempt 0" is retired (12.3) |
| `ux-run.spec.ts:192-194` (**not in 12.3**) | the Activity attempt row's `href` and the URL after the click end `/attempts/1` | S4-core retargets Activity attempt rows (section 11, the S3 handoff's follow-up) |
| `ux-time.spec.ts:156-157` (**not in 12.3**) | scroll to 200 px instead of 400 px before Refresh | `run-failed`'s verify node is now 948 px tall at 1280×720 (empty sections absent), so it cannot scroll to 400; the assertion (Refresh keeps the position) is unchanged |

Unchanged and green: `clarity.spec.ts` output-first order (Result, Files, Report, receipt, Task), `verify-shows-checks-not-files`, `lane-files-link`; `review.spec.ts:40` (the first `.projects-facts` in the node is the review panel's, which names the session); `guardrails.spec.ts` `worker-questions-none` (now a line in Session); `inputs.spec.ts` receipts and stop line.

## 5. Deviations from the PRD

1. **Files outside the S4-core list**: `tests/project-workflows/ux-run.spec.ts` and `ux-time.spec.ts` (the two migrations above), and `tests/unit/node.test.ts` plus `src/projects/node/model.ts` (a pure module, so the header rules have unit tests; within `src/projects/**` and `tests/unit/**`).
2. **Launch section order** is Questions, Result, Files, Report, Session, Task, History, not 4.5's Report, Files, Task, Session: `clarity.spec.ts` output-first (unchanged per 12.3) pins the launch receipt before the task. S4b folds the receipt into a closed Session disclosure.
3. **The launch line** (reworked after review, section 7) reads "Frozen at handoff as abcdef1; verified on attempt 3 after operator repair 1 as 50b14b3 · facts and checks on Verify ui ›". Section 8's wording, plus "as <sha>" when a repair changed the verified revision. The frozen revision is the output commit of the verification's attempt-1 result (read through the cache). Until that result loads, the line starts at "Verified…".
4. **No `worker-completion` clamp, no retryable-note removal, no check table, no `Requirements` section**: those are S4a/S4b. `Requirements.tsx` is extracted only.
5. **Stylesheets**: App.css keeps the node rules it had (section 11: only S1 and S3 edit it); the new `node.css` and `node/*.css` hold only the new rules, so `review.css` and `controller.css` are near-empty until S4c.
6. **No Identifiers disclosure** yet on review, challenge and controller nodes; their session ids are in the review and challenge panels. The header's facts grid (Kind, Depends on, Session) is gone.
7. **The attempt crumb** was tried and dropped: a sixth crumb collapsed the trail to "Projects / … / Verify ui / attempt 1", hiding the run; the banner names the attempt.
8. **Attempt pages of other kinds** (launch, challenge, review, controller) show that attempt's header and History, and say only the latest evidence is kept (`attempt-latest-only`).
9. **No `features/viewer-ux-s4core/policy.json`**, as in S1 and S3: the scenario ids are `node-header` and `node-attempts`.

## 6. Follow-ups

- **S4a**: `worker-error` still carries the retryable sentence (`projects.spec.ts:305`); `RequiredChecks` is ready for the Requirements section; the Gate section already lists the error first.
- **S4b**: the launch sections are split into `WorkerSections`; the Session section holds the receipt, the questions-none line and the stop line, ready to become the closed disclosure (and to migrate `lanes.spec.ts:102`, per S1's deviation 1).
- **S4c**: move `ReviewPanel` (`ReviewDetail.tsx`) onto `useRunReview`, and add the Identifiers disclosure on review, challenge and controller nodes (section 7). **S4a**: the same disclosure for the verify facts. **S4b**: `CreatedFiles.tsx` should read the review through `useRunReview`.
- **S4c**: `ReviewSections`/`ChallengeSections`/`ControllerSections` are thin wrappers today; the review's section chip has no count (the review is fetched by `ReviewPanel`, which could read `useRunReview`).
- The strip's `aria-label` on unlinked chips (the challenge) sits on a `span`; S4c's challenge chips could make them list items with visible text only.
- The candidate phase and the full suites are the orchestrator's.

## 7. Review fixes (second commit)

An independent review raised 5 findings and 8 gaps. Each one was checked against the code before it was fixed.

| Item | Outcome |
|---|---|
| P1 `WorkerSections.tsx:69`: the launch line said "Verified on attempt k" even when the shared result had failed the gate or was still being verified | **Fixed.** `VerifiedLine` takes the verify node's status. It says "verified" only when that node succeeded and the result has `status: succeeded` and no error. Otherwise it says "verification failed on attempt k · the gate's reasons on Verify … ›" (`data-state="failed"`), "verification attempt k is running", or "not verified yet". The header's worker-success sentence had the same flaw ("— verified by Verify adapter ›" on `run-failed`). It now words the link by the verify node's status (`verified by`, `verification failed at`, `verification running at`, …). |
| P2 `NodeHeader.tsx:163`: an earlier attempt's status cause was chosen by the served `event.attempt` | **Fixed.** The new pure function `causeOf` (model.ts) is ordered: the failure's error first, then the viewed attempt's span outcome as the timeline re-read it, then that attempt's own status message. Only the latest attempt falls back to the node's last message. On skeleton-001, `/challenge/attempts/2` now quotes "interrupted (KeyboardInterrupt)". |
| P3 `RunView.tsx:154`: focus was lost when moving between attempts of the same node | **Fixed.** The focus effect also tracks `selectedAttempt`, so a chip or the banner link moves focus to the new page's `h3`. The browser test drives this from the keyboard. |
| P3 `ux-node.spec.ts:139`: the attempt page never proved which result it loaded | **Fixed.** The spec now asserts `result-facts` Attempt = 1 on `/attempts/1` both before and after the reload, and asserts that the reload requests `results/ui/1`. |
| P3 `node.test.ts:73`: the regex alternative matched any inferred start | **Fixed.** The test now asserts `/start inferred from Verify combined candidate/`. |
| gap: review fetched through `useResource` in `ReviewDetail.tsx`/`CreatedFiles.tsx` | **Deferred to S4c (`ReviewDetail.tsx`) and S4b (`CreatedFiles.tsx`).** Section 11 lists those files for those slices, and `useRunReview` is ready for them. |
| gap: Review/Challenge chips always listed | **Fixed.** The Review chip appears only once a recorded review loaded. The Challenge chip appears only when the inputs record a challenge. The honesty lines `review-none` / `challenge-none` stay, since review.spec and lanes.spec pin `review-none`. |
| gap: "k of N on this revision" (5.3) | **Fixed.** On a verification or the candidate that is running or failed, `node-timing` adds `node-attempt-revision`, e.g. " (1 of 3 on this revision)". N is `inputs.max_verification_attempts`, and k is counted from the node's latest repair marker before the attempt (`revisionAttempt`). |
| gap: attempt chips carry no reason | **Fixed.** Chips now show `node-attempt-reason` on a failed attempt. It holds the check ids its keyed gate reasons name ("frontend-unit, project-workflows-browser"), or the outcome itself when there are no keyed reasons. A repeat of the previous failure shows "same". The reason is also in the chip's accessible name. |
| gap: "Open assumptions" disclosure (12.3 `projects.spec.ts:228`) | **Fixed.** `WorkerNarrative` puts the assumptions in a closed `<details data-testid="assumptions-details">` whose summary reads "Open assumptions (n)". `projects.spec.ts` and `ux-node.spec.ts` open it before asserting. |
| gap: no "Identifiers" disclosure for other kinds | **Deferred to S4a (verify/candidate `ResultFacts`) and S4c (review, challenge, controller panels).** Collecting session ids and commits in a closed disclosure means moving them out of those panels, and section 11 assigns the panels to those slices. Nothing is lost meanwhile: a verification's `node.session_id` is its result's `session_id`, shown in `result-facts`, and the review and challenge panels name their sessions. |
| gap: 12.2 `loads results/<lane>/1` not asserted | **Fixed** with the P3 test finding. |
| gap: "Frozen at handoff as <sha>" launch line | **Fixed** with P1 (deviation 3, updated). |

**Red** (the new assertions against the previous `src/`, with the tests updated): `git stash push -- src/` and then `npx playwright test -c tests/project-workflows/playwright.config.ts tests/project-workflows/ux-node.spec.ts --reporter=line` gave **2 failed**:
```
node-header:   locator.click: Test timeout of 30000ms exceeded   (no assumptions-details disclosure to open)
node-attempts: getByTestId('node-attempt-reason')  Expected: "frontend-unit, project-workflows-browser"  element(s) not found
```
The reviewer's probes are the red evidence for P1 and P2: `/runs/run-failed/nodes/launch_adapter` showed "Verified on attempt 1 · facts and checks on Verify adapter ›", and the challenge's attempt 2 quoted "attempt 3 passed · 8 P2 concerns". The new unit tests `causeOf` and `revisionAttempt` import functions that did not exist before, so they have no behavioural red.

**Green**, final tree:

| Check | Result |
|---|---|
| `npx tsx --test tests/unit/*.test.ts` | 152 passed (node 15) |
| `npx tsc -b`, `npx eslint` on every changed file | clean |
| `npx playwright test -c tests/project-workflows/playwright.config.ts --reporter=line` (worker phase, all 10 spec files) | **45 passed** (3.9m) |
| `WORKFLOW_VERIFICATION_PHASE=candidate` (same config): `ux-node.spec.ts` and `projects.spec.ts` | **12 passed** (1.1m) |
| `WORKFLOW_VERIFICATION_PHASE=candidate`: the other 8 spec files | **33 passed** (2.9m) |

The fixtures did not change, so `server/projects.test.ts` was not re-run. No file outside the S4-core list was touched beyond those deviation 1 already names.
