# Handoff: viewer UX slice S4c, review, challenge and controller pages (PRD_VIEWER_UX)

Implements row S4c of `docs/PRD_VIEWER_UX.md` section 11 (4.7 Review, 4.8 Challenge, 4.9 Handoff, approval, integrate) as the
`panels` lane of workflow run `viewer-ux-panels-lists-003`, 2026-09-27, in its own worktree. The `lists` lane (S6) ran beside it;
none of its files (`ProjectsView.tsx`, `api.ts`, `NowBanner.tsx`, `CommandBlock.tsx`, `LiveStatus.tsx`, `projects.spec.ts`,
list files) were read or edited. `contracts/projects/triage.ts`, `contracts/projects/v1.ts`, `useRunData.ts`, `NodeHeader.tsx`
and `RunView.tsx` are unchanged. Nothing was committed (the controller owns git).

## 1. What shipped

- **`src/projects/node/panels.ts`** (new, pure, no React): `reviewerTime` (took from `launched_at` to `accepted_at`; "no launch"
  when `launched_at` is null; launch time only when there is no `accepted_at`), `reviewerDeadline` + `deadlineText`
  (`deadline ≈10:40 (26m left)` / `deadline ≈10:10 (passed)`; not rendered yet, see deviation 1), `blockingFindings`,
  `reviewSectionEntries` (Blocking N, Findings N), `challengeHeadline`, `challengeSectionEntries` (Concerns N, Alternative &
  experiment), `concernsBySeverity`, `handoffWait` (latest launch start among the receipts, native start else the launch
  request, to the freeze), `approvalLine` (instant from the timeline, `≈` when inferred, who approved from the finish policy),
  `integratedCommit`, `lastStatusAt`.
- **`NodeDetail.tsx`** (review, challenge and controller kinds only; worker and verify pages unchanged):
  - holds the review resource with `ReviewDetail.tsx`'s former key and fallback (`result_uri`, else `paths.review(scope,
    attempt)` once the node ran; the key carries `result_uri ?? status`, so a review opened before its verdict is read again when
    the status changes). It is loaded for the review node and, through the review node, for the approval node (its bundle hash).
    The run cache (`useRunData.ts`) is not used for it. `reviewTransport` is derived from it (the `onTransport` effect is gone);
  - builds the review and challenge index entries from `panels.ts`;
  - renders `ChallengeHeadline` between the header and the section index;
  - passes the node, its events, its timeline spans, the inputs and the review to `ControllerSections`, and the node's events
    and the clock to `AwaitingNotice`. No section fetches, polls or calls `useNow`.
- **Review (`ReviewSections.tsx`, `ReviewDetail.tsx`, `review.css`)**:
  - `blocking-findings` section (index `Blocking N`) before `Review result`, one `blocking-finding` card per unresolved P0/P1:
    `P1 · open · coverage · lane ui`, the full message, and `Requirement in the <lane> task ›` links. It sits outside
    `review-findings` and reuses none of `finding`, `finding-task-link`, `review-verdict`, `review-blocked-by`.
  - `ReviewPanel` no longer fetches: it renders the resource `NodeDetail` holds (none / unscoped / loading / error / result).
  - Reviewer strip: a `reviewer-time` element after `reviewer-status` (whose text is unchanged): `took 3m49s`;
    `launch time not recorded (print) · verdict 09:44:10`; or `no verdict · launched 09:40:00` for a pending or superseded
    reviewer (the second line then does not repeat the launch). Nothing ticks.
  - At ≤760 px the same findings table is restyled as cards (rows `display: block`, cells labelled from `data-label`, the
    header row visually hidden but still in the DOM); no second copy of any finding.
- **Challenge (`Challenge.tsx`, `ChallengeSections.tsx`)**: `challenge-headline` (`Passed on attempt 3 · 8 P2 notes · decided
  08:50:49 · 11m07s over 3 attempts`; paused: `‖ Paused: the design challenge found 1 P1; no worker was launched. · …`), the
  record folded in `Outcome, attempts and session` (every existing test id kept), then `Concerns` (P0/P1 `<details open>`, P2
  `<details>` one line each, expandable to message and consequence) and `Alternative & experiment`. The attempt strip and the
  paused challenge's resume / `--accept-challenge` commands come from the shell (`node-attempts`, `node-next`).
- **Controller (`ControllerSections.tsx`, `controller.css`)**: `handoff-summary` (`09:19:54 · workers stopped and snapshots
  captured (ui, adapter) · waited 28m21s for the completion signal`, with `handoff-wait`: `(wait = latest launch start (adapter,
  08:51:33) → freeze; from receipts)`); `approval-summary` (`≈09:43:52 · approved automatically by the finish policy
  (verified-feature-branch) · no approval event recorded · bundle b7b7…`; awaiting: `Waiting for your approval of the reviewed
  bundle 3c3c3c3c3c3c; …`); `integrate-summary` (`09:43:52 · fast-forwarded feature/ux-review/run-review-approved to
  cccccccccccc · no push performed`). `AwaitingNotice` adds `awaiting-since` (`Awaiting your approval since 10:14 (12 min ago)`)
  when the node has a status row; its existing wording is kept.
- **Fixtures (`fixtures/ux-review.ts`)**, workflow `ux-review`, 1.5.0 exports of a guarded two-lane graph, both phases:
  `run-review-approved` (challenge #1 no record, #2 blocked after 46s, #3 passed with 8 P2; receipts ui 08:51:00 and adapter
  08:51:33; freeze 09:19:54; general 3m49s and coverage 2m04s approved; approval with no event; integrated),
  `run-review-pending` (coverage blocked with an open P1 quoting the ui task, general `pending` with `launched_at` 09:40:00),
  `run-review-print` (one print reviewer, no launch time, open P1), `run-challenge-paused` (one P1, one P2). The manual approval
  reuses `run-awaiting-approval` from `fixtures/ux-run.ts` (read only).
- **Tests**: `tests/project-workflows/ux-review.spec.ts` (`review-blocking-first`, `challenge-headline`, `controller-panels`,
  each attaching one `screenshot:<id>`), `tests/unit/panels.test.ts` (7 tests).

## 2. Red evidence (tests first, against the unchanged product)

- **Unit**: `npx tsx --test tests/unit/panels.test.ts` against a skeleton `panels.ts` whose helpers answered `null` / `[]`:
  7 tests, 7 failed (for example `actual: null expected: { kind: 'took', ms: 229000 }`, `actual: [] expected: [ 'P1 open', 'P0
  accepted' ]`, `actual: null expected: { ms: 1701000, from: '2026-03-05T08:51:33.000Z', lane: 'adapter' }`).
- **Browser**, both phases (`WORKFLOW_VERIFICATION_PHASE=worker` and `=candidate`), `ux-review.spec.ts`: 3 failed each, first
  failures `getByTestId('blocking-finding')` expected 1 received 0; `challenge-headline` element not found; `handoff-summary`
  element not found. A temporary soft-assertion copy of the spec (deleted after) listed every failing assertion; the same set in
  both phases:
  ```
  review-blocking-first: blocking-finding count 0 (expected 1); card text / requirement link not found; card-before-table: no card;
    index link blocking not found, review data-count "" (expected 2); reviewer-time not found (took 2m30s, no verdict · launched
    09:40:00, took 3m49s, took 2m04s, launch time not recorded (print)); 390 px: finding row display "table-row" (expected
    "block"), .table-wrap overflow 242 px (expected <= 0)
  challenge-headline: challenge-headline not found (both runs); index link concerns not found; P2 consequence visible (expected
    hidden: no one-line notes); paused P1 has no open attribute
  controller-panels: handoff-summary, handoff-wait, approval-summary (and its <time>), integrate-summary not found; manual
    approval-summary "bundle 3c3c3c3c3c3c" not found
  ```
  **Already green before the change** (listed, not claimed): the three attempt chips of the challenge; the paused challenge's
  `node-next` resume and `--accept-challenge` commands; the manual approval's `awaiting-notice` wording and `node-next` approve
  command with the bundle hash; the finding row counts; page width ≤ 390 at 390 px (the table scrolled inside its wrapper).
  The old strip already printed `took <span>` in its second line, but not in a `reviewer-time` element.
- **Test-authoring mistakes** (not product reds): the first overflow probe measured the table itself, which is 0 even before the
  change; it now measures `.table-wrap`. The first green run failed on my `precedes` helper passing an un-awaited element
  handle. Neither changed what the product must do.

## 3. Green evidence (final tree)

| Command | Result |
|---|---|
| `npm run build` | ok (only the existing chunk-size warning) |
| `npm run lint` | clean |
| `npx tsx --test tests/unit/panels.test.ts` | 7 passed |
| `npm run test:unit` | 278 passed, 0 failed |
| `WORKFLOW_VERIFICATION_PHASE=worker npx --no-install playwright test --config=tests/project-workflows/playwright.config.ts ux-review review reviewers guardrails projects ux-node ux-run clarity lanes inputs` | 45 passed |
| same, `WORKFLOW_VERIFICATION_PHASE=candidate` | 45 passed |
| `… ux-verify ux-launch ux-time`, worker and candidate | 9 passed each |
| `… --reporter=json ux-review.spec.ts` + `python -m workflow check-report ../policy.json panels <report>`, worker and candidate | 3 passed; "The scenarios in this report follow the verifier's rules" |

**Fixture parity.** A throwaway script seeded the candidate registry and projected the four `ux-review` runs through the real
`RunStore`; the snapshot, run status, every event, the review, the inputs and all worker and candidate results equal the
worker-phase mocks (artifact `uri`, check `cwd` and the result `node_id` excluded, as in S4a).

## 4. Migrations

None. Every existing assertion is unchanged: `review.spec.ts`, `reviewers.spec.ts:86` (all five column headers), the `finding`
counts in `review`, `lanes`, `inputs`, `reviewers` and `clarity`, `guardrails.spec.ts` challenge-node-page (its test ids are
kept, the record is folded but read by `toContainText`), `projects.spec.ts:251` (`result-none` on a node without a result stays,
also under the controller summaries).

## 5. Deviations from the PRD and open assumptions

1. **Live reviewer times deferred** (decisions.md, run 002): no per-reviewer elapsed time or deadline is rendered; a review
   serves reviewers only once decided. `reviewerDeadline`/`deadlineText` exist and are unit-tested for when the controller
   serves reviewer receipts during the wait; they carry `≈` and read `(passed)` after the deadline. 12.2's "a deadline from
   `launched_at` appears on a running native reviewer" and 12.2's fixture "a native review with one running reviewer" are
   therefore replaced by the `pending` reviewer with no ticking clock (asserted with `page.clock.fastForward`).
2. **Blocking card links**: the card links the requirement in the lane's task, not "Open file at lines" (the review result
   records no location; the table keeps its file links). No `[More]` on P2 table rows (not in the scenario); the card shows the
   full message.
3. **Section index**: the review lists `Blocking N` (only when N > 0) and `Findings N`; no `Diff` entry (S7 inlines the diff).
   The challenge lists `Concerns N` (only with concerns) and `Alternative & experiment`.
4. **Approval wording**: an automatic run's approval without an event reads "approved automatically by the finish policy
   (<finish>)"; a manual one "approved by the operator". The instant is the timeline's (triage rule 4: ≈ the integration).
5. **Awaiting since** is shown only when the node has a status row; `run-awaiting-approval` has none, so its notice keeps only
   the existing text. The approval command itself comes from `deriveNow` in `node-next`.
6. **Handoff wait** needs the freeze's succeeded row (else the timeline's handoff span end) and at least one launch receipt;
   without either the line has no "waited" part.
7. **Challenge styles** live in `node/review.css` (the challenge is of kind review; no `challenge.css` is in the lane's paths).

## 6. Follow-ups

- Render the reviewer deadline once reviewer receipts are served during the wait (C-follow-up in 9.4); the helper is ready.
- S7: the review diff inline and its `Diff N files` index entry.
