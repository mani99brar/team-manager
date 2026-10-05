# Handoff: the attack pass in the Projects viewer (lane `viewer`, run attack-pass-001)

Spec: [PRD_ATTACK_PASS.md](../PRD_ATTACK_PASS.md) sections 4.6, 6 items 8 and 9, Appendix A; decisions G9, G10, G12, L1.

## What shipped

- **Contract 1.8.0** (`contracts/projects/v1.ts`): the vocabularies of Appendix A (`ATTACK_PASS_STATUSES` with the export's
  `pending`, attacker, skeptic, severity, re-run status and reason, verdict, finding status, label, angle), `attackRecordSchema`
  (the record as `attack.json` and the export section hold it), `attackResultSchema` = record + `contract_version: "1.8.0"`,
  `node_id: "attack"`, `source: live|export`, registered as `schemas.attackResult` with its generated
  `attackResult.schema.json` (only `tsx contracts/projects/export.ts` was run: `npm run contracts:export` would also rewrite the
  engine's `contracts/workflow/` schemas). `settings` is a strict object of exactly the eight keys (L1); every other object drops
  a key the engine adds, like the sidecar ledger. Cross-field rules live in `validateAttackResult` (not zod refinements, so the
  JSON schema round-trips): unique finding and attacker ids, `rerun.reason` null exactly when reproduced, the skeptic's severity
  never above the finding's, a `pending` record with no attackers or findings. Examples: `examples.attackRecord` (Appendix A
  verbatim) and `examples.attackResult`. README: the route and the 1.8.0 history entry.
- **Server** (`server/projects.ts`, `server/projectRoutes.ts`): `EXPORT_VERSIONS` gains `1.8.0`; the export's `attack` section is
  kept as unknown data (`LoadedRun.attack`) and validated only by the route
  `GET /:project_id/workflows/:workflow_id/runs/:run_id/attack`, which serves the live `<run>/attack.json` (4 MiB cap) when it is
  readable, valid and this run's, else the export section when it is a valid record (`pending` and `failed` included), else 404
  `ATTACK_NOT_FOUND` (export before 1.8.0, `attack: null` without the node, a record invalid both live and in the export). A
  skipped file or section is logged (`Attack pass record skipped`) as the sidecar's is. Texts, the output tail (last 200 lines)
  and `secret_files` are path-redacted; times are normalised to `Z` as the sidecar's. `attack` and `attack-` joined the reserved
  lane ids and prefixes. The run-list headline skips the attack node's rows as it skips the sidecar's.
- **Triage** (`contracts/projects/triage.ts`): `ATTACK_NODE_ID`; every sidecar exclusion (last activity, gaps, scope parents,
  attention, running headline) now covers both through `ADVISORY_NODE_IDS`; the focus never picks the attack node (see deviations).
  `status.ts` (`isAttackNode`, executor wording), `steps.ts` (short label "Attack"), `lists.ts` ("attack pass"),
  `node/model.ts` (`nodePhase` null) mirror the sidecar's.
- **Viewer**: `src/projects/attack.ts` (pure: counts, headline, effective severity, current label, verified and folded orders,
  re-run reason wording, the label command, cost and duration); `src/projects/node/AttackSections.tsx` + `attack.css`
  (`AttackPassBody`: report-only line, status chip and counts, source line, pending note, error line, verified cards with
  severity chip, title, threat, requirement or "No requirement quoted", test file, label or "Unlabelled" with the command and the
  `$PY`/`$RUN` legend, the rest folded under one `<details>`, attackers with status, cost, duration and skeptic, out-of-reach
  notes); `RunView.tsx` polls the route (as the sidecar ledger) only when the graph has the attack node and renders the section
  between the Pipeline/Steps board and Activity; `NodeDetail.tsx` renders the same body on the attack node page, listed in the
  section index as "Attack pass"; `api.ts` `fetchAttackResult`, `NOT_RECORDED.attack`. No execution control: the command is text.
- **Graph**: no layout change was needed: `attack` has `review`'s `depends_on`, so `layoutDag` puts it in the review's column on
  the next row; the legend is unchanged.

## Fixtures built from Appendix A

`tests/project-workflows/fixtures/ux-attack.ts` (workflow `ux-attack`, all 1.8.0 exports, lanes `ui`/`adapter`, no inputs
section) holds Appendix A as a local literal `APPENDIX_A` (kept local so a red run fails only the new tests; `tests/unit/attack.test.ts`
asserts it deep-equals `examples.attackRecord`, which the contract test reads from the PRD). Runs: `attack-verified` (Appendix A's
attacker plus `inputs-state` timed out; A-1 verified labelled real, A-2 not reproduced, A-3 verified at the skeptic's P1 from P0,
unlabelled, no requirement, A-4 refuted, A-5 unjudged), `attack-pending` (G10 pending record), `attack-live` (pending export, newer
live running record), `attack-waiting` (review approved, pass still running), `attack-blocked`, `attack-failed` (failed record for an
invalid file), `attack-refused`, `attack-invalid` (garbage section and live file → 404), and `-plain` twins with `attack: null` for
the first five. The node's events use Appendix A's texts only. The runs are dated 2025-10-05 (the records keep Appendix A's
2026-10-05 times): a first version dated 2026-10-05 put six finished runs at the top of Runs home's Recent (no upper time bound,
ten rows shown) and pushed `ux-lists.spec.ts`'s March runs out of view; a targeted run of the list specs caught it. `seed.ts` accepts `version: '1.8.0'` (writes `sidecar` and
`attack` sections, `workers` in the plan) and `attackFile` (live `attack.json`); `fixtures.ts` gained `attackResults`,
`fixtures/index.ts` its type entry and merge line, `mock.ts` the `attack` route answering `ATTACK_NOT_FOUND`.

## Red, then green

Red: a copy of HEAD under the job's tmp directory with only the new and changed tests and test infra copied in.
- `contracts/projects/contract.test.ts`: fails, `./v1.js does not provide an export named 'ATTACK_ATTACKER_STATUSES'`.
- `tests/unit/attack.test.ts`: fails, `Cannot find module src/projects/attack.ts`.
- `server/projects.test.ts` (copy given the new contract and, as a load shim only, the `ATTACK_BYTE_LIMIT` constant): 11 fail,
  68 pass: all 8 `[attack]` tests (a 1.8.0 export `RUN_STORAGE_INVALID`, the route 404 instead of 405, a lane named `attack`
  accepted: `200 !== 500`) and 3 existing seeded-fixture tests (`[B1]`, `[B2]`, the sidecar twins), because the old server
  refuses every seeded 1.8.0 run: the failure `EXPORT_VERSIONS` fixes.
- `attack.spec.ts`, worker phase: both scenarios fail, the Attack pass section is not found.

Green (this worktree): `npm run build` 0, `npm run lint` 0, `npm run test:contracts` 28 pass, `tsx --test server/projects.test.ts`
79 pass, `npm run test:unit` 407 pass; `attack.spec.ts` with `--reporter=json` in both phases: 2 passed each, and `workflow
check-report` on each report: "The scenarios in this report follow the verifier's rules". One existing test changed: the
"malformed or contradictory ... RUN_STORAGE_INVALID" test used `1.8.0` as its unknown export version; it now uses `1.9.0`
(it pins the export version list, as the task allows). Because `ux-attack.ts` feeds every spec's mocks and seed, I also ran
the whole Projects browser suite once per phase after the date fix: 78 passed in each (worker and candidate).

## Deviations and choices (open assumptions)

1. Focus (reading of "mirror each for `attack`"): the sidecar is the focus when nothing else runs; the attack node never is,
   because the task also says it "never becomes the run's headline, Now banner or current step". When the review has decided and
   only the pass still runs, the focus is null, the Now banner reads "Running · between steps" and the list headline falls back
   to the review's last row. Tested in `tests/unit/attack.test.ts` and by the seeded `attack-waiting` twin.
2. `secret_files` are served path-redacted (`<path>`), like every absolute path the server serves; so the contract checks them
   only as non-empty strings, not as absolute paths. The viewer does not show them.
3. Field rules: ids, `ref`, `attacker`, `run_id`, `candidate_commit` and `session_id` are non-empty; `title`, `threat`, texts and
   times are plain strings (review sidecar S-1, applied: schema re-exported, an accepted contract case added). Settings carry the PRD section 3 bounds and the three angles; a record outside
   them is skipped (404), never a failed run.
4. "Listed in the section index": the run page has no section index, so the entry is on the attack node's page; on the run page
   the section sits between the board and Activity.
5. The label command uses the viewer's convention, `"$PY" -m workflow attack-label "$RUN" <id> --label real|false|out-of-scope --by
   operator`, with the `$PY`/`$RUN` legend below, rather than Appendix A's `python -m workflow attack-label <run> ...`.
6. The route answers 404 for an export before 1.8.0 even when a live `attack.json` exists, and for `attack: null` when the graph
   has no attack node.
7. Superseded PRD text (challenge note 4): Appendix A's `pending` record gives `settings` as `<plan.attack>` (PRD line 252 in the
   challenge's numbering); L1 supersedes it, and this contract closes `settings` to the eight keys. Sections 4.3/4.4 worktree
   layouts (L2, L10) and 4.6 "under the run lock" concern the engine only. No Appendix A field was changed.
8. Challenge notes 1, 2, 3 and 5 concern `workflow/` (engine lane): out of this lane's owned paths, nothing done here.

## Limits and follow-ups

- The node page and run page share one component; the section index lists one "Attack pass" entry, not per-subsection entries.
- Not run by me: a real engine-written `attack.json` or 1.8.0 `run-state.json`; the fixtures follow Appendix A,
  and the engine's committed schema wins at integration if they differ.

## Run 002 (follow-up, decisions O16)

Run 002 carries this lane's finished 001 work forward from commit `2764f65` (001 reached completion but the run stopped at the
engine deadline before freeze, so the controller never verified or reviewed it). This section records the 002 pass over that work.

**What I kept.** Everything. No implementation file changed. I restored the 001 diff verbatim
(`git restore --source=2764f65 ... ; git diff --stat 2764f65 -- <lane paths>` printed nothing), then re-checked it against the
task, Appendix A and decisions.md as they stand now. Two guards confirmed HEAD had not diverged from 001's base in the lane paths
or in `docs/PRD_ATTACK_PASS.md` (the contract test reads Appendix A from that file verbatim): both
`git diff --stat 2764f65^ HEAD -- <lane paths>` and `... -- docs/PRD_ATTACK_PASS.md` printed nothing. Appendix A and the
decisions this lane cites (G9, G10, G12, L1) are unchanged since 001, so nothing in the work "no longer holds".

**What I changed.** Only this handoff section (the sole 002 edit).

**Re-verified the one thing the 001 handoff flagged and 002's challenge note 3 targets** — the two closed schemas disagreeing on
nullability, enums or settings bounds. Checked `attackResultSchema`'s field rules line by line against Appendix A line 245: every
nullable field matches (`candidate_commit`, all `started_at`/`finished_at`/`error`, `session_id`, `cost_usd`, attacker `summary`,
finding `requirement`, `rerun`, finding `skeptic`, `rerun.reason`, `rerun.exit_code`, label `note`, `review_found`), and the
attacker's `skeptic` object is non-nullable as required. The `settings` angle set and numeric bounds
(`attackSettingsSchema`, v1.ts:563) are **not** over-strict: PRD section 3 pins `angles` to exactly 1–3 distinct values from
`inputs-state|permissions-files|auth-funds` and the bounds `budget_usd` 1..50, `timeout_minutes` 5..180, `skeptic_budget_usd`
1..20, `skeptic_timeout_minutes` 5..60, `max_findings` 1..20 — the schema encodes those verbatim. The engine builds `settings`
from `plan.attack`, itself validated at launch against the same section 3 bounds, so the engine cannot legitimately write an
out-of-set angle or out-of-bounds budget that the viewer would then 404 (note 3's failure mode does not reach this lane). Still
`verify_yourself` at integration: the engine's committed `contracts/workflow/attack.schema.json` must agree.

**002's four design-challenge notes.** Note 1 (P2, Acts: operator) is the model-id / safeguard-flag question for the engine
relaunch; this lane's work does not depend on it, nothing done here. Notes 2 and 4 concern `workflow/` (engine lane) only.
Note 3 (Acts: worker, engine) asks the engine to commit the refused/failed/timed-out-attacker/pending records it writes; on the
viewer side those cases are already exercised by the fixtures — `attack-failed` (failed record, invalid file), `attack-refused`,
`attack-pending` (G10), the `inputs-state` attacker `timed_out`, finding A-5 `unjudged`, finding A-2 with a null `skeptic` and
`rerun.reason` `passed` — all validated through `attackResultSchema` in the contract and server tests.

**Red, then green (re-verified for 002).** A clean HEAD checkout under the job tmp (`git archive HEAD | tar -x`, `node_modules`
symlinked) with only the new/changed tests and test infra copied in (`contract.test.ts`, `tests/unit/attack.test.ts`,
`attack.spec.ts`, the `fixtures/` dir, `fixtures.ts`, `mock.ts`), run against the pre-change code:
- `contracts/projects/contract.test.ts` — fail: `SyntaxError: The requested module './v1.js' does not provide an export named 'ATTACK_ATTACKER_STATUSES'`.
- `tests/unit/attack.test.ts` — fail: `ERR_MODULE_NOT_FOUND: Cannot find module '.../src/projects/attack.ts'`.
- `attack.spec.ts` worker phase — fail: `getByTestId('attack-section')` not found; the Attack pass section does not exist in HEAD.
These are the three failures 001 recorded, for the right reasons. The server-test red row (1.8.0 export `RUN_STORAGE_INVALID`,
the route 404 vs 405, a lane named `attack` rejected) is cited from 001's "Red, then green" above; it needs the `ATTACK_BYTE_LIMIT`
load shim and was not re-run for 002.

**What I ran (fresh checkout, after `npm ci`).** All green, counts identical to 001:
- `npm run build` — ok (tsc + vite, 0 errors).
- `npm run lint` — ok (eslint, 0).
- `npm run test:contracts` — 28 pass, 0 fail.
- `npx --no-install tsx --test server/projects.test.ts` — 79 pass, 0 fail.
- `npm run test:unit` — 407 pass, 0 fail.
- `tests/project-workflows/attack.spec.ts`, worker phase — 2 passed; candidate phase — 2 passed; `workflow check-report` on each
  JSON report (against `../policy.json`, node `viewer`): "The scenarios in this report follow the verifier's rules" for both.
  Each scenario attaches exactly one `screenshot:<id>` PNG (`screenshot:attack-section`, `screenshot:attack-live`), plus the
  `state:attack-pending` and `state:attack-section-390` images for the folded/pending/390px states.
  (Note: Playwright clears `test-results/` at the start of each run, so check-report must run right after its own phase, before
  the next phase overwrites the screenshot files the JSON report points at.)

No deviation from 001's recorded deviations and choices; all still apply.

## Run 003 (follow-up of run 002, decisions O16/L17)

Run 003 restores run 002's combined candidate `b567788` in the lane paths (`git restore --source=b567788 … ; git diff --stat b567788 … ` printed nothing) and builds on it. It closes the P1 the run 002 review filed against this lane and triages the lane's P2s and the attempt-3 viewer design-challenge notes. Only the files this change touched are new work; everything else is 002's candidate verbatim.

### What changed

1. **P1 closed — the review keeps the focus, Now banner and current step while the pass runs on** (run-002-review.md lane viewer, the [P1 open] at :94, and S-1). Before: when the review had decided (approved → `review` reads `succeeded`) and only the report-only attack pass still ran, `deriveFocus` returned `null`, the Now banner read "Running · between steps" and the graph highlighted nothing — the run looked "between steps" for the whole post-decision wait (up to ~3 h/angle). Now `focusOf` (`contracts/projects/triage.ts`) adds one fallback: when nothing else is failed/paused/awaiting/running and the `attack` node is `running`, the focus is the `review` node (a blocked review already reads `failed` and was picked by the first `pick`). `runningNow` names that review step instead of "between steps" (and never the attack node — the banner carries no "Attack pass" text), and its `since` is the review's. The report-only attack node still never becomes the focus itself (it is excluded from every `pick`). `src/projects/RunView.tsx` already drives the graph highlight (`focusId`) and the banner from `now.focus`, so the current step follows.
   - **Focus `status`**: the focus the fix returns is the `review` node with its real snapshot status `succeeded` (a decided, approved review), not a faked `running`. Recorded as a deliberate choice.
   - **Red → green**: `tests/unit/attack.test.ts` "after the review decided, the attack node running alone keeps the review as the focus and step" — on 002's candidate it fails `AssertionError: + 'review' - undefined` (deriveFocus returns null) and then `/Review/` not matched (banner reads "between steps"); after the triage.ts change it passes (focus `review`, banner "● Running · Independent review · …"). A second case pins that a blocked review also keeps the focus.

2. **Server twin test updated to match** (`server/projects.test.ts` "[attack] a seeded run with an attack pass has the activity and status of its twin without one"). The seeded `attack-waiting` run now faithfully models decisions L9 / the fixture's own doc ("the review approved … the attack node is the only running step"): `reviewed: true` gives the run the review value so the `review` node reads `succeeded` (not the `paused` the old seed produced, which hid the P1), `next: ['approval']` and `tasks: []`. With the pass, `review` keeps the focus; its twin without a pass has nothing running and reads `null` (between steps) — the one intended difference. The twin loop now deep-equals every activity field **except** `focus` for that pair (status, headline, last-activity, attention, waiting all still read the same), and asserts `focus.node_id === 'review'` with a pass and `focus === null` without. Every other twin pair is still a whole-object deep-equal. This is the only genuine with/without difference and it is the P1 feature working: a run without a pass renders as today ("between steps"); the pass keeps the review step shown. (Why the old seed hid it: `review` is in `TAIL_EVIDENCE_KEY`, so a succeeded review event without the review value derives `paused`, which `focusOf` already picks — the null-focus bug only arises for a `succeeded` review, which the unit test and now the seed both produce.)

3. **Viewer design-challenge note 2 closed — a `not_reproduced` finding with `rerun: null` (decisions L15) renders as a live state, never a crash** (Acts: worker). The contract already allows `rerun: null` (`attackRerunSchema.nullable()`; the cross-field rule only fires on a non-null rerun) and `rerunReason` already optional-chains, so the page did not actually throw; the gap was wording — such a finding showed no re-run text. New pure helper `rerunLine(record.status, finding)` in `src/projects/attack.ts`: a reproduced/other finding keeps its reason prefixed `re-run:`; a `not_reproduced` finding whose `rerun` is still null reads `re-run pending` while the pass is live (`pending`/`running`) and `not re-run` once it is terminal (`succeeded`/`failed`/`refused`). `node/AttackSections.tsx`'s `FoldedLine` takes the record and renders it. Unit test in `tests/unit/attack.test.ts`; the worker-phase `attack-live` mock's running record now has A-2 at `rerun: null` (its re-run owed, the skeptic not yet started), and the spec asserts "not reproduced — re-run pending" before the poll and "re-run: the test passed on the clean copy" after. The candidate seed writes the same live record, so the server serves the `rerun: null` record there too. No contract/schema change, so no `export.ts` re-run was needed.

### P2s triaged

- **Label command `$PY/$RUN` convention vs Appendix A's literal** (run-002-review.md :93) — kept as 001 chose (deviation 5). The `$PY`/`$RUN` placeholders are the viewer's documented convention for every command it prints (triage.ts `COMMAND_LEGEND`, used by every next-step block), and the legend renders below the card; the reviewer's own text concedes it is runnable once the two variables are set. Changing only this command to a bare `python -m workflow …` would break the viewer's one convention for a cosmetic match to the attention record. Left open deliberately.
- **No pending screenshot in a verification packet** (run-002-review.md :95) — left open. The verifier's rule is exactly one `image/png` named `screenshot:<id>` per scenario, and the policy has two attack scenarios (`attack-section`, `attack-live`); a third "pending" packet image would need a third scenario the policy does not define. The pending state is asserted in readable spec source (`attack.spec.ts` "The attack pass runs at the review step…") and attached as `state:attack-pending` beside the section screenshot, so the behaviour is checked and there is an image, just not one check-report reads.
- **Cross-lane: engine-written records never validated against `attackResult`** (run-002-review.md Findings across lanes, first bullet) — left open; out of this lane's owned paths. `contracts/workflow/` is the engine lane and `contracts/workflow/examples/attack.*` are not in this worktree (run 002 never merged), so there is nothing here to validate against. Still the `verify_yourself`: the two closed schemas agree only at integration.
- **Cross-lane: "red is self-report"** (run-002-review.md Findings across lanes, second bullet) — closed for run 003's own new tests: each new assertion was run against 002's restored candidate first and failed for the stated reason (focus `null`/"between steps"; `rerunLine` not exported), quoted above, then passed after the change.

### Notes not acted on (one line each)

- Attempt-3 notes 1 and 5 (attack-tally upper-bound / missing-time handling) and note 3 (feature/brief count assertions) concern `workflow/` (the engine lane): out of this lane's owned paths, nothing done here.
- Attempt-3 note 4 (manual `attack-pass` recovery, Acts: operator) concerns `workflow/` only; nothing done here.
- Note 2 is the one viewer note (Acts: worker) and is closed, above.

### Checks run (this worktree, after `npm ci`)

- `npm run build` — ok (tsc + vite, 0). `npm run lint` — ok (eslint, 0).
- `npm run test:contracts` — 17 pass (the projects contract file; the full policy check runs both contract files).
- `npx --no-install tsx --test server/projects.test.ts` — 79 pass, 0 fail.
- `npm run test:unit` — 409 pass, 0 fail (407 before + the two new attack cases).
- `tests/project-workflows/attack.spec.ts`, worker and candidate phases — 2 passed each; `workflow check-report … viewer <report>` on each: "The scenarios in this report follow the verifier's rules". Full candidate browser suite run once after the seed change as a regression guard (see the completion for the count).

002's recorded deviations and choices still apply; run 003 adds the two above (the waiting-run seed now models a decided review; the focus the fix returns keeps the review's real `succeeded` status).
