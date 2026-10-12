# Handoff: run-sessions (lane `sessions`)

## Run 006 (2026-10-12): the [L12] items closed

Run 006 restored run 005's candidate (c673403) and closed decisions.md [L12] items 1-3 with design-challenge notes 1-4; nothing
else that was green changed.

- **[L12] 1, Panel card from the panel's own record** (`panelCard`/`panelWord`, `src/projects/sessions/model.ts`). The card, its
  step sheet and the run page's stage read the panels route's record, which `RunView` already polls, passed to `SignalRun` as
  `panels`. Word: `running` if any panel runs, `failed` if any panel failed or timed out, `not started` if every panel is
  pending, else `reviewed`. The sheet says "N of M providers answered" (status `ok`). The open P0/P1 count is the panel's
  accepted P0/P1 findings, once each (challenge note 2). The cost comes from the providers (a `pi` estimate covered, `claude`
  metered). The card no longer needs the sessions payload, so both phases draw it the same way. Until the record loads, the
  card keeps the node's served status and never shows a provider-derived "failed". Provider rows keep their own state (a
  timed-out provider reads `stopped`). The seeded sessions run's Panel figures are unchanged (1 open P0/P1). Tests:
  `tests/unit/sessions.test.ts` "panelCard: the word follows the panel's own recorded status…" and "…open P0/P1 counts the
  findings the panel accepted…", and `panel.spec.ts` `panel-section` (the `panel-succeeded` card and sheet, both phases).
- **[L12] 2, resume keeps the quoted form** (`composeResume`, `server/sessions.ts`). `RUN_DIR_PATTERN` no longer applies.
  Spaces, non-ASCII letters and `$` keep `cd ~/'<rest>' && claude --resume <id>`. A single quote, or any `\p{Cc}`/`\p{Cf}`
  character (C0, C1, bidi overrides, zero-width), U+2028 or U+2029 gives the bare form (challenge note 4). Test:
  `server/sessions.test.ts` "resume: the quoted ~/ form keeps spaces, non-ASCII and $…".
- **[L12] 3, archived rounds bounded** (`archivedRoundCount`). The count is the largest k with every `review.round-1..k.json`
  present, taken from the listed files, so a stray `review.round-99999999.json` neither loops the request nor labels the
  running round (challenge note 3). Test: "a stray review.round-99999999.json…" (round 2's live rows, round 1's archive).
- Shared-file edit for the hand merge: `tests/project-workflows/fixtures/sessions.ts` exports `PANEL` (lane-owned module).

### Deliberate follow-ups ([L12]: review-005's P2s, not changed in run 006)
- Resume form, untested and stricter than PRD 3.5's listed fallbacks (closed by [L12] 2).
- Night-shift matching is tested only with paths that exist and need no resolving.
- Worker rows join `<lane>.interactive.json` with `<lane>.cost.json` without checking that their session ids match.
- No bound or test on the archived-round count (closed by [L12] 3).
- [L10] item 4: reviewer rows for round k>1 running are tested only through the projection (now partly covered by the [L12] 3 test).
- [L11] 3's done-criterion: the redaction test does not seed every file type the reader parses.
- The session block is asserted only on the reviewer, critique, hidden-project reviewer and Panel pages.
- [O4]: no test asserts the ended time, the Copy button, the clipboard text or the "Select to copy" fallback.
- The triage advisory rule is never tested in a case that discriminates.
- No server test asserts that the projected `review` also depends on the reviewer and panel nodes.
- The controller section (`controller_blocked`, `review_blocked` decisions) is not rendered by any test.
- The fingerprint cache: a lane-review record rewritten without an event leaves the runs list's summary stale.
- Node pages and the node rail of reviewer and lane-review nodes contradict the stage (header pill and rail chip tone).
- The step sheet of every projected card says "nothing to type here" while the step page offers a resume command.
- Night-shift labels show raw machine kinds (`challenge_paused`, `awaiting_approval`); "model not recorded via native".
- Cognitive load in the Sessions list: a full resume box per row.
- An earlier-round reviewer that ended without a verdict reads "decided", not "failed".
- Night-shift matching treats a named path that no longer resolves as naming no run directory.

## Run 005 (2026-10-12): the [L10] items closed

Run 005 restored run 004's candidate (c99d1ea) and closed decisions.md [L10] items 1-13 with [L11]'s recipes, design-challenge
notes 1-4 and the review-004 P2s. Every check runs green in this worktree: `frontend-build`, `frontend-lint`, `shared-contract`,
`frontend-unit`, and the whole `tests/project-workflows` config in both phases.

### The [L10] items, each with its test

| Item | What changed | Proof |
|---|---|---|
| 1 | `SessionNodeInput` carries `reviewSection` and `exportAtLeast140`; the plan fallback applies only while the section is null and `review` is not pending, `['review']` only for 1.4.0+ exports; a section that lists no reviewers projects none. run 004's specs and SEEDED_SNAPSHOTS that pinned the phantom node are restored to the base counts. | `server/sessions.test.ts` "no reviewer node when the review section lists none…", "an export whose review section lists no reviewers…"; parity spec |
| 2 | Sidecar passes and attack angles are rows (`sidecar-<n>`/`attack-<n>.stdout.json`); the critique reads `automatic-review-critique.json` and `critique/<round>/{status,stdout}.json` (each round its own cost). | "every role of PRD 4 becomes rows…" |
| 3 | Jev is a `night_shift` row when called (a pick from `jev.json` with its model and cost, or a real error); night-shift rows claim no transport. | "night shift: … every jev form" |
| 4 | While the section is null, reviewer rows come from the live receipts (`automatic-review-<id>.json`, `review-<id>.interactive.json`, cost files). | "a running round: reviewer rows from the live receipts…" |
| 5 | Node status from the records: reviewer from the export entry or receipt (`reviewerStateOf`), lane review from its record, panel from the panel record (a failed or timed-out panel is report-only, so a `succeeded` node whose page says "The panel failed: …", PRD 3.2). Parity compares `node_id:status`. | "reviewerStateOf: every word…", "lane reviews: … a failed record is a succeeded node", parity spec |
| 6 | One row per lane reviewer (`lane:<lane>:<round>:<index>`), each its own transport, model, cost kind and duration; a claude reviewer's session id from the entry or its `.pid` `--session-id` marker. | "every role…" (pi + claude reviewer) |
| 7 | The reviewer page renders the review page's finding cards filtered to the reviewer (`ReviewerFindings` in `ReviewDetail.tsx`), its earlier rounds and its session block. | `sessions-reviewer` |
| 8 | The Panel page shows `ProviderPanelBody` and one session block per provider. | `sessions-panel` |
| 9 | The run page's count links to each decided node (`night-shift-link`). | `sessions-panel` |
| 10 | `resolvePanelRecord` (live then export) serves both the panels route and the `panel` node. | "the panel node exists exactly when the panels route answers…" |
| 11 | One boundary pass in `readSessions`: `redactText` over every string except `resume`, then each row/entry through its strict schema, dropped alone on failure. | "a path, a credential and an out-of-range time in every file type…" (route answers 200, neither string in the body) |
| 12 | `iso()` always re-serialises (`new Date(parsed).toISOString()`); `decidedAt` uses it. | same test (Feb 30, hour 24) |
| 13 | Reviewer counts follow `isBlockingFinding`: an accepted P1 counts, a resolved one does not. | "every role…" (`{p0:0,p1:2,p2:1}`) |

Design-challenge notes: (1) status words are the controller's (`pending`, `launching`, `running`, `accepted`, `succeeded`,
`blocked` with/without `error`, `needs_reconciliation`, `superseded`, the critique's `failed`); the seed writes only those.
(2) The third project `gamma-project` (`UNEXPOSED_PROJECT`, `fixtures.ts`) has its own workflow `ux-sessions-hidden` and run
`sessions-hidden-run`; the mock routes runs by their summary's project; `projects`/`ux-lists` count three projects; the parity
spec checks every served run (no `continue`: an explicit `SERVED_ELSEWHERE` list, empty today). (3) The candidate-phase parity
run is the gate: run before and after the status change, both green; it also compares each mocked `/sessions` payload with the
server's (resume compared bare). (4) Route tests (GET, HEAD, 404 shape, 405) and the read-only sweep include `/sessions`; the
browser specs assert every fact their scenario names.

Review-004 critique P2s: blocked reviewer cards carry the fail tone; the step sheet of a projected card shows its session facts
and "not a step the run waits at"; row labels carry the round; the live dock's Spent reads the Sessions totals; the challenge page
says the inputs record no outcome (rather than "no challenge") when its sessions exist and shows one block per attempt; blocks
are titled by the session's label; durations use `formatSpan`; facts on one line with middle dots; Copy says "Copied".

### Shared-file edits for the hand merge (projects-dispatch also edits these)
- `tests/project-workflows/fixtures.ts`: `UNEXPOSED_PROJECT` (+ `projectList`, `workflowLists`), `sessionFactsOf`, one type import.
- `tests/project-workflows/fixtures/index.ts`: `sessions` and `reviewerIds` payload keys, `SessionFacts`, workflows join their own
  project's list, the `viewer.expose_run_dir` lists merge across modules.
- `tests/project-workflows/mock.ts`: run details by summary project; `injectSessionNodes` on every run detail; the `/sessions` route.
- `tests/project-workflows/seed.ts`: `nightShiftDir` in the seed context; the third project in the registry.
- `tests/project-workflows/playwright.config.ts`: `MD_MANAGER_NIGHT_SHIFT_DIR` for the candidate server.
- Fixture modules filling `reviewerIds` from their own seed builders: `ux-run`, `ux-sidecar`, `ux-revamp-pages`, `ux-critique`,
  `ux-refine`, `ux-attack`, `ux-panel`, `ux-accepted`, `controls`, `ux-revamp-lists`, `ux-review`, `sessions`.
- Plan-derived reviewer nodes (section null, `review` not pending, 1.4.0+): `reviewer-review` on the ux-attack, ux-panel,
  ux-accepted, controls, ux-revamp-lists, ux-sidecar (integrated) and ux-run (interrupted) runs and `run-loop-running`.
- Server: `contracts/projects/v1.ts` (import + `schemas.sessions`), `contracts/projects/triage.ts` (advisory ids),
  `server/projects.ts` (`resolvePanelRecord`, `sessionNodeInput`, `sessions`, `nightShiftFacts`, `LoadedRun.sessionInput/panelRecord`),
  `server/projectRoutes.ts` (the route).

### Test ids and keys
- Session keys: `challenge:<n>`, `worker:<lane>`, `repair:<n>`, `lane:<lane>:<round>:<index>`, `reviewer:<id>:<round>` (role
  `critique` for `critique`), `sidecar:<n>`, `attack:<n>`, `panel:<panel>:<provider>`, `night:<i>:<provider>`, `night:<i>:jev`.
- Page ids: `sessions-section`, `session-group-<role>`, `session-row` (`data-session-key`, facts `[data-fact=model|status|started|
  duration|cost|session]`), `session-row-link`, `sessions-totals`, `session-block` (`session-model`, `-transport`, `-status`,
  `-started`, `-duration`, `-cost`, `-findings`, `-id`), `session-resume`, `session-resume-command`, `session-resume-copy`,
  `session-resume-note`, `reviewer-body`, `reviewer-verdict`, `reviewer-findings`, `reviewer-earlier`, `lane-review-body`,
  `lane-reviewer`, `lane-review-finding`, `lane-review-fix-round`, `lane-review-repair-link`, `lane-review-snapshot`,
  `panel-sessions`, `night-shift-decision` (`-kind`, `-outcome`, `-provider`, `-agreement`, `-jev`, `-command`),
  `night-shift-count`, `night-shift-count-text`, `night-shift-link`, `run-spent`, `sheet-session-note`.

### Bare vs `~/` resume
The `~/'…'` form only for an exposed project whose recorded directory still exists under HOME. Always bare: every challenge
attempt, sidecar pass and attack angle (print jobs record no directory), the critique (records none) and every archived round
(its review worktree is removed). Never a resume: pi/openrouter sessions, panel providers, night-shift rows. The candidate test
root is outside HOME, so the candidate phase sees only the bare form ([L1]); the worker phase and `server/sessions.test.ts` prove
the `~/` form.

### Open items
- Jev's and non-Claude night-shift providers' costs count as `covered` (no file says how Jev is billed; the contract has two kinds).
- The fingerprint cache keys on top-level files only; a lane-review record changing in its subfolder without an event refreshes
  on the next top-level write.

## Earlier runs (history)
- Run 004 built the whole lane; review blocked three rounds on the gaps above (`features/run-sessions/review-004.md`).
- Run 003 built the server and contract half (saved as 7a46eeb); runs 001-002 were lost to an access outage and a relaunch.
