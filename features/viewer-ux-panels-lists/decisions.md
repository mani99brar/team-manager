# Decisions: viewer-ux-panels-lists

From the grill session of 2026-09-27 with the operator.

## Decisions

- Runs home's Recent section lists every finished run of the last 7 days across all projects, newest first, with no count cap: the `lists` lane filters on `activity.finished_at` (else `updated_at`), and `runs-home` asserts a run older than 7 days is absent from Recent while it stays on its project page.
- No client fan-out fallback: the `lists` lane reads the served `activity` only. A run without `activity` shows `<Status> · updated <time>` with no finish time, no duration and no Needs-you grouping, and no run detail is fetched to reconstruct it.
- The operator's live registry will serve run directories (`viewer.expose_run_dir` for `project-b` and `md-manager`) after this run lands: the `lists` lane only reads `run_dir`; it changes no registry file outside the test harness, and its fixtures set the key in their own temp registry.
- After design challenge attempt 1 of viewer-ux-panels-lists-001 (P1: the sections cannot get the data they need), the `panels` lane owns `src/projects/NodeDetail.tsx`, `src/projects/node/model.ts` and `tests/unit/model.test.ts`: NodeDetail passes inputs, events, timeline, clock and node to the sections, and pure helpers in `src/projects/node/panels.ts` compute the headline, wait, approval instant and deadline wording.
- Tests that the other lane's fixtures can change assert only on their own run ids: `runs-home` never asserts whole-section counts (`Needs you · N`, `Running · N`, 'nothing is running') or the full contents of Recent, because the combined candidate also lists the `panels` lane's runs; the `panels` lane asserts commands with `toContainText` on `node-next`, not on `CommandBlock`'s inner structure.
- Time-dependent text (a running reviewer's elapsed time and deadline, the 7-day Recent window, the 15 s controller debounce) is tested with `page.clock` set to a fixed instant, as `ux-time.spec.ts` does, in both phases; a deadline already passed reads `deadline <time> (passed)`.

- After design challenge attempt 1 of viewer-ux-panels-lists-002 (P1: a live review serves no reviewers): the per-reviewer live elapsed time and deadline of PRD 4.7 are deferred until the controller serves reviewer receipts during the wait; `review-blocking-first` covers decided and print reviews and a `pending` reviewer with no ticking clock.
- The blocking card sits outside `review-findings` and carries no `finding` test id; narrow widths restyle the one findings DOM as cards (no second copy), so every existing `finding` count in `review.spec.ts`, `lanes.spec.ts`, `inputs.spec.ts`, `reviewers.spec.ts` and `clarity.spec.ts` stays unchanged.
- NodeDetail holds the review resource with `ReviewDetail.tsx`'s current key and fallback (`result_uri`, else `paths.review(scope, attempt)`, re-read when `node.status` changes) and passes the result to `ReviewPanel` and to the section index (Blocking N, Findings N) and the approval's bundle hash; `ReviewPanel` stops fetching on its own. The run cache (`useRunData.ts`, owned by neither lane) is not used for reviews, so an export without a link keeps its review and a review opened before its verdict updates when it lands.
- `served-activity` asserts 'controller running' only in the worker phase (mocks); in the candidate phase a seeded PID gives `not_running`, and the test asserts the 15 s debounce with `page.clock.install` and `fastForward` (not `setFixedTime`, under which 15 s never pass).
- Runs home gets its rows from the run lists: projects, then workflows, then each workflow's runs, paging until `updated_at` falls below the 7-day cutoff, polled every 15 s. "No fan-out" means no per-run detail request: every row renders from the run summary's served `activity`. The handoff records the request count.

- After design challenge attempt 1 of viewer-ux-panels-lists-003 (P1: rule 1 renames the seeded workflows), the workflow title rule is reordered: a generic `definition.name` ("Feature implementation") gives the latest run's `activity.feature`, else the `workflow_id`; any other `definition.name` is the title. `activity.feature` stays secondary text on Runs home rows and project cards. Every `currentCrumb`, `workflows-list` and 'Current definition graph of …' assertion, including `lanes.spec.ts:182`, stays green in both phases.
- The `lists` lane delivers `activity` and `run_dir` to `LiveStatus`, `NowBanner` and `CommandBlock` through a React context provided in `ProjectsView.tsx`, following `TimeReferenceContext` in `useNow.ts`; `RunView.tsx`, `RunHeader.tsx`, `NodeHeader.tsx` and `WorkerInputs.tsx` are not edited. The `RUN=` line then also appears in `node-next` for exposed runs, so the `panels` lane asserts commands with `toContainText` on the command itself, never exact text of `node-next`.
- The blocking card reuses none of `finding`, `finding-task-link`, `review-verdict` or `review-blocked-by`; reviewer durations and 'launch time not recorded' stay in their own element beside `reviewer-status`, whose exact text is unchanged.
- Red evidence names the assertions that actually fail before the change (for `review-blocking-first`: the blocking card's position, 'launch time not recorded', the 390 px cards); parts that already pass, such as 'took <span>' and 'no verdict recorded yet', are listed as already green.

## Assumptions

- `contracts/projects/triage.ts` (`deriveNow`) and `contracts/projects/v1.ts` are read-only for both lanes; a wording or field that seems missing is recorded in the lane's handoff as a follow-up, not added.
- Needs you lists runs whose `activity.attention.kind` is `question`, `pane` or `approval`; Running lists non-terminal runs not already in Needs you; a run appears in one section only.
- Reviewer deadlines use `inputs.automatic.review_timeout_seconds` and carry `≈`; with `launched_at` null the `panels` lane shows "launch time not recorded" and no deadline.
- Both lanes keep every existing test id; new test ids follow the PRD's names where it gives one.

## Deferred

- The one-request list endpoint (PRD B4) and the evidence detail fields (B5).
- Slice S7 (Assignment reorder, review diff inline): the separate feature `viewer-ux-depth` after this run is integrated.
- Controller and exporter follow-ups C1 to C10 of PRD section 9.4.
