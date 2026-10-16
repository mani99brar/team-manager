# Handoff: review-panel-registry, viewer lane

Run `review-panel-registry-001`, lane `viewer`. Spec: `features/review-panel-registry/prd.md` 7.4, 7.7, 8 and Appendix A/B; decisions [O7], [O9], [G9], [G10], [G21], [G22], [G26], [L2], [L7].

## What was built

### Contracts (`contracts/projects/v1.ts`)
- Panel record **1.1.0** beside 1.0.0. `judgedPanelRecordSchema`: seats (`name`, `prefix`, transport `claude|pi|cli`, `model`, `served_model`, `cli_version`, `effort`, status, cost, context, finding ids, error); seat statuses are 1.0.0's plus `unavailable`, `auth_required`, `usage_limit`, `model_mismatch`; the panel is `judged: true` with `overlap_threshold: null`; the `judge` object holds the status (`pending|running|judged|failed|timed_out|incomplete`), `fallback`, model, effort, session, times, cost, error, `inputs`, `reviewer_findings` and `rulings` (`confirmed|refuted|deferred`).
- `anyPanelRecordSchema` tells the two versions apart by `version`. A 1.1.0 record outside the schema (for example transport `foo`, an unknown seat status or ruling) is refused whole, so only that record is dropped. The 1.0.0 schema did not change.
- The served `panelResults` keeps `contract_version: '1.9.0'`. The record's own `version` carries the change ([G22]: no EXPORT_VERSION bump, and the record carries its version). The generated `panelResults.schema.json` and `reviewResult.schema.json` were regenerated with `tsx contracts/projects/export.ts` (projects only; `contracts/workflow` untouched).
- **Judged review rule**: `validateReviewResult(input, context?: ReviewPlanContext)`. The context is `{ judgedPanel }`, built from `plan.json` by `reviewPlanContext(plan)`: true exactly when `plan.panels` holds an item with `report_only: false`. A legacy plan, a report-only plan or a missing plan gives false.
  - **Judged-panel context and a `judge` entry:**
    - the reviewers are the built-ins, then `judge`, then `critique`;
    - the built-in verdicts do not gate;
    - the verdict must equal the judge's, combined with critique's (critique still blocks);
    - the findings are only the judge's and critique's;
    - the judge cannot approve with an open P0/P1.
  - **A `judge` entry without that context** is refused, because the id is reserved.
  - **Every other record** validates exactly as before. This includes a fallback record on a judged run.
- Served review results gain an optional `judged_panel: true`, which the server sets from the plan. The client (`src/projects/api.ts`) and the route's re-check pass it back as the context through `servedReviewContext`.
- `contracts/projects/judgedExamples.ts` (Node only) loads the feature's literal examples and the PRD Appendix B blocks (`judge-states`, `plan-panel-judged`) for every test layer.

### Server
- `server/projects.ts`:
  - `projectPanels` accepts both record versions. It redacts and bounds the judge's and rulings' texts, the seat errors and the CLI version.
  - The live-then-export rule is unchanged, and a refused live 1.1.0 file falls back to the export.
  - `loadRun` validates the review section with `reviewPlanContext(plan.json)` and serves `judged_panel`.
- `server/projectRoutes.ts` re-validates with the served context.
- `server/sessions.ts`:
  - **Seats:** a 1.1.0 panel gives one `panel_provider` row per seat, none with a resume command. Each row spans the seats' wait, from the panel's start to the judge's start, because the record keeps no per-seat times.
  - **Judge:** one judge row (`Panel · review · judge`, transport `print`) with the bare `claude --resume <id>`, never a `cd`.
  - **No duplicate:** the reviewer rows skip `judge`, so its session is listed once.

### UI
- `src/projects/judgedPanel.tsx` with its model `src/projects/node/judgedPanel.ts`. `ProviderPanelBody` branches on `version === '1.1.0'`; the 1.0.0 path and its markup are unchanged.
- **Seats:** each shows name, prefix, transport, model (and the served model when it differs), CLI version, status in PRD 8 words, duration and cost (`not reported` for null).
- **Judge:** status (`judging` while running), model, cost and duration.
- **Rulings:** grouped Confirmed (P0/P1 first), Deferred, Refuted. Each shows its J id, severity, title, `file:line`, lane, requirement, reason and evidence.
- **Source chips:** links with the id as their label, 44 px tall.
  - A seat chip (`C1`) moves to that seat's line in place.
  - A reviewer chip (`general-1`) opens the `reviewer-<id>` node page.
- **Fallback:** the banner `Judge <status>: the built-in reviewers decided (today's rule); panel findings are unjudged`, with the panel findings listed as unjudged.
- **Review section** (`ReviewDetail.tsx`, `reviewers.ts`, `critique.ts`):
  - On a judged review, the judge is labelled `deciding reviewer` and the built-ins `advisory (the judge decided)`.
  - The verdict line says the judge decided.
  - "Blocked by" names only the judge and critique.
  - A fallback record is labelled as today.
- `sessions/model.ts`: the Panel card counts a judged panel's confirmed P0/P1 rulings.

### Tests
- `contracts/projects/contract.test.ts`, section "Panel record 1.1.0 and the judged review": the examples validate, the refusals hold, 1.0.0 is unchanged, the `judge-states` objects validate, and there are direct `validateReviewResult` tests (judged, legacy, report-only and missing plan context; the judge entry removed; fallback).
- `tests/unit/judgedPanel.test.ts`: status words for every seat status, ruling grouping and order, source-chip targets, the fallback banner, and the advisory label.
- `server/projects.test.ts`, tests `[judged panel] …`: live and export reads, a refused live record, 1.0.0 unchanged, a judged review refused on legacy and report-only plans, a fallback that keeps the built-ins, and the sessions rows.
- `tests/project-workflows/judged-panel.spec.ts`: scenarios `panel-judged`, `panel-rulings`, `panel-fallback`, `panel-review-section`, `panel-legacy` and `panel-phone`, over the fixture module `fixtures/ux-judged.ts` (both phases).
  - The module seeds the runs `judged-blocked` and `judged-fallback` from the literal examples, with lanes `engine`/`viewer`.
  - `seed.ts` gained an optional `plan` key, and `fixtures.ts` `projectReview` an optional `judgedPanel`.

## Run 002 ([L9])
- Restored this lane's run-001 snapshot `499ae06` with the one `git restore` line from the task. Every path matched, and `git diff --stat 499ae06 -- <paths>` printed nothing before T1.
- **T1:** every review round's judge keeps its Sessions row. `server/sessions.ts` `panelRows` now also reads each archived round's `panel.round-<k>.json`, through `SessionsInput.archivedPanel`. `server/projects.ts` `readArchivedPanel` fills that, bounded and validated as the live `panel.json` is. A judge object with a session id gives a row keyed `panel:round-<k>:<i>:judge`, labelled `Panel · review · judge · round <k>`, with its round, cost and bare `claude --resume <id>`. The source is the panel record, not `review.round-<k>.json`. A fallback round's review record lists no `judge` entry, but its judge still ran and is listed (design-challenge note 3). The current round's judge row is unchanged. An invalid or missing archived record drops only that round's row.
- Test: `server/projects.test.ts` "[judged panel] every review round keeps its judge row …" seeds two runs, each with one fix round. One has an archived judged round, the other an archived fallback (timed-out) round, and each has a current judged round. It asserts both judge rows with their session ids, resume commands and costs.

## Repair 1 (run 002)
- `revamp-lists.spec.ts` home-sections failed: the two paused `ux-judged` runs were dated 2025-10-05. They sorted ahead of `desk-stale` in the Runs home Paused list, which shows only the first `PAUSED_SHOWN` rows, so `desk-stale` dropped out of it. `tests/project-workflows/fixtures/ux-judged.ts` now dates them 2026-03-11, after `desk-stale` stopped (2026-03-09) and before the Runs home clock. No viewer code changed.

## Run 005 ([L12])
- Restored this lane's owned paths from the run-004 candidate `9245e1e` with the task's `git restore` line. `git diff --stat 9245e1e -- <paths>` printed nothing before B2.
- **B2:** a judged run's graph draws no `reviewer-judge` card. In `server/sessions.ts`, `drawnReviewerIds` now filters out `JUDGE_REVIEWER_ID` (the previous body is `reviewerIdsToDraw`). This mirrors the archived-round skip, so `projectedReviewerIds`, `projectSessionNodes` and the reviewer rows' `node_id` lookup all leave the judge out. The judge is still reached through the Panel section (judge block, rulings) and the Review section (the deciding `judge` entry). Its one Sessions row, `panel:0:judge` on node `panel`, is unchanged.
- The worker-phase mock projects cards through the server's own `projectSessionNodes` (`sessionProjection.ts`), so `fixtures/ux-judged.ts` needed no data change, only a header note that says so.
- Tests:
  - `server/projects.test.ts` "[judged panel] a judged run's graph draws no reviewer-judge card …" asserts no `reviewer-judge` node in the definition or the snapshot, the built-in reviewers' and the panel's nodes present, the judge's session row on `panel`, and the judge entry in the review. It fails when the filter is removed: I checked by reverting the line, and it reported `reviewer-judge drawn: … reviewer-judge, panel`.
  - `judged-panel.spec.ts` `[scenario:panel-review-section]` also asserts the graph has `reviewer-general`, `reviewer-coverage` and `panel` cards and no `reviewer-judge` card.

## Repair 1 (run 006): reviewer source links
- Lane review P1: a ruling's reviewer chip (`general-1`, `coverage-1`) opened the reviewer page, and that page said "recorded no findings". On a judged review, `review.findings` holds only the judge's and critique's findings. The reviewer's own finding exists only in the panel's `judge.reviewer_findings`.
- Fix: `judgeReadFindings` (`src/projects/node/judgedPanel.ts`) picks out that reviewer's `reviewer_findings` from a 1.1.0 record's review-stage panels. `ReviewerFindings` (`src/projects/ReviewDetail.tsx`) lists them under `reviewer-judge-read`, with id, severity, lane and message, marked as advisory. `NodeDetail` passes them in from the polled panel record. The "recorded no findings" line now shows only when neither source has anything.
- Tests: `tests/unit/judgedPanel.test.ts` "a reviewer's findings as the judge read them". `judged-panel.spec.ts` `[scenario:panel-rulings]` now follows the `general-1` chip and asserts its message on the reviewer page.
- Repair 2 (lane review P1): on a fallback run (judge `timed_out`, `failed` or `incomplete`, `fallback: true`) the judge object still holds `reviewer_findings`, so the reviewer page listed the built-in's findings twice and called them advisory. Fix: `judgeReadFindings` reads only a judge with status `judged` and `fallback: false`, and `NodeDetail` passes `judgeRead` only when `isJudgedReview(review)` holds. Test: `tests/unit/judgedPanel.test.ts` "a judge that did not decide (fallback, or any status but judged) labels none of its reviewer_findings advisory" (fallback records that carry reviewer findings).
- Hand fix after run 008 (C1-C4, operator-approved, from the run's user-critique findings on the judged review): one role helper, `reviewerRole` with `ADVISORY_WORDING`/`DECIDING_WORDING`, now lives in `contracts/projects/v1.ts` next to `judgeDecided` (an archived round passes the run's plan context), and `src/projects/reviewers.ts` re-exports it. C1: on a judged record the timeline outcome and archived rounds (`triage.ts` `reviewOutcome`/`roundOutcome`), the Now banner (`reviewBlockedNow`, which adds "general and coverage advised (the judge decided)") and the succeeded headline name only the deciding reviewers. The step sheet's "What it did" says the judge decided and lists the built-ins as advisory, and its pills read `· advisory` in a neutral tone. A ReviewerStrip advisory card is neutral and reads "advised blocking"/"advised approval", keeping its verdict badge and `data-status`. C2: a judge row's resume note reads "its worktree was removed; run it from any directory", which closes the left-open note below. C3: an advisory card reads "findings passed to the judge", and `reviewFigures`/`findingFilterIds` leave the advisory built-ins out. C4: `findingsLegend` (`data-testid="findings-legend"`) gives the judged wording and keeps the unjudged legend byte for byte. `fixtures/ux-judged.ts` now serves the review's result URI (`review: 1`), so the run page reads the judged review. Tests: `tests/unit/triage.test.ts`, `signal.test.ts`, `judgedPanel.test.ts` and `sessions.test.ts` (judged and unjudged), `judged-panel.spec.ts` `[scenario:panel-review-section]`, and the unjudged legend in `review.spec.ts` `[scenario:review-verdict]`.
- Hand fix, second round (V1-V5, from the review of the C1-C4 fix): V1: an archived round takes its plan context from the served review, or, when none is served (review.json is archived while round k>1 runs), from its own `judge` entry, so a judged round 1 reads "round 1 blocked by judge" during the repair too (`triage.ts` `roundOutcome`; the timeline and the server's run-list activity share it). V2: on a judged review the graph's projected `reviewer-<id>` cards of the advisory built-ins are neutral, read "advised blocking"/"advised approval" and carry no open P0/P1 of their own, with "Round <k>: advised … (the judge decided)." (`signal/model.ts` `advisoryCard`). V3: an advisory built-in with no verdict reads "gave no verdict (the judge ruled on the others)"; its pill reads "<id> no verdict · advisory", its card keeps its own counts instead of "findings passed to the judge", and the Now banner names it "<id> gave no verdict" apart from the reviewers that advised. V4: the judged fixtures (`fixtures/ux-judged.ts`, `judgedExamples.ts` `servedReview` with the judged flag) give a built-in with a verdict status `accepted`, as the engine writes it. V5: critique stays a decider on a judged record ("blocked by critique", its reason first, `reviewFigures` keeps judge and critique; "approved by judge and critique"); no code change was needed. Tests: `triage.test.ts`, `signal.test.ts`, `judgedPanel.test.ts`, `judged-panel.spec.ts` `[scenario:panel-review-section]`.

## Manual check ([L7])
I ran `claude -p` (Claude Code 2.1.289, Haiku) in a scratch directory and recorded its session id. I then deleted that directory and ran `claude -p --resume <id> "…"` from another directory. **It resumed:** it answered from the first turn's context, with the same session id. A judge print job whose throwaway worktree was removed can still be resumed with the bare `claude --resume <id>`. The sessions row keeps the scenario's wording, the command without a `cd`.

## Left open
- Closed by the hand fix after run 008 (C2): the judge row's resume note reads "its worktree was removed; run it from any directory"; every other bare command keeps "run it in the session's worktree".
- A seat's duration is the seats' wait (`≤ 21m52s`), not its own time: the 1.1.0 record has no per-seat times. A later record field would fix this.
- Run 005 B2 closed the earlier note about a projected `reviewer-judge` card: none is drawn now.
- The full Playwright suite was not run in this worktree. I ran `judged-panel.spec.ts` (worker and candidate phases) and `sessions.spec.ts` (candidate phase). The full suite runs at the viewer verify and the candidate gate.
- The viewer accepts a judged 1.1.0 record without a `judge` object and reads it as "the judge has not started". Design-challenge note 2 asks the seats lane to always write the `pending` object; the viewer does not depend on it.
- `judge.model` may be null (design-challenge note 3) and renders `not pinned`.
- Archived rounds give only the judge's row. Earlier rounds' seat rows are not listed, because T1 names only the judge. The record keeps no seat session to resume.
