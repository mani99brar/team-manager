# User critique — engine handoff (run user-critique-003, follows user-critique-002)

The engine lane of `docs/PRD_USER_CRITIQUE.md`: a feature.json **2.9.0** feature may declare `critique`, and its automatic
run's review step gains one reviewer, `critique`, run as a controller-owned headless `claude --print --json-schema` job
(PRD 4.4, decisions.md [L1]/[L2]/[L4]). This file records what shipped, the seam the `viewer` lane builds on, the deviations and
every open P2.

## This run (user-critique-003): verification and coverage

Run 003 continues from `730fb4a` (run 002's candidate `f4fbdca` plus its refused repair session 1). The repair fixed the
12 open P1s of 002's review round 1; this run **confirms each is fixed with a test that would fail without the fix**, closes
the P2s it could within the Acceptance, and answers the attempt-2 design-challenge notes. Changes, all in this lane's owned
paths:

- **`pipeline.py` — design-challenge note 1 (code).** `prepare` now refuses a native reviewer named `critique` **only when
  the plan pins the critique reviewer** (`--critique-settings`); the id stays free in a run that does not declare critique,
  and the global `sessions.RESERVED_NODE_IDS/PREFIXES` are unchanged (so a pre-2.9.0 feature with a reviewer or lane named
  `critique` still launches). launch already refused it (`load_feature`); this closes the prepare gap (followup P2 #29).
- **`critique.py` — two P2 hardenings.** `confined_png` now also requires the **PNG magic bytes** (`PNG_SIGNATURE`), so a
  `.png` whose content is a copied host file is dropped on write and on read (followup P2 #31; the Bash write limit stays
  advisory). `CritiqueChild.cleanup` now kills the job's **whole session group even after the job's own process exited**, so
  a background process the job started with Bash (a headless browser, a second dev server) does not outlive the round
  (followup P2 #32).
- **Tests added/strengthened** (each would fail without its fix): the **full job argv** (`--print`, `--output-format json`,
  `--session-id`, `--json-schema` with the P1/P2 enum, `--add-dir`, the reviewer role's `--model`/`--effort`, the worker
  deny list plus the `$RUN/**` and plugin Edit/Write denies — followup P2 #40); the app on **free ports with
  `CRITIQUE_API_PORT`, the worktree cwd and a scrubbed env**, its port free after a completion AND after a timeout, the slot
  free after a timeout (P2 #41/#53); **setup runs before the slot is taken** and a **spent budget** is a failed reviewer
  (P2 #43); **prepare pins `plan.critique`** (skills digest, settings digest, worktree, feature_version 2.9.0) and refuses
  the print transport and the reviewer id `critique` (P2 #44, note 1); the **`builtin:critique` rubric** is read and
  asserted (P2 #55); **clean removes the critique worktree** (P2 #54); an **archived round exports each finding's own
  evidence** (P2 #48, Acceptance 8); the contract examples now hold a **genuine duplicate critique-finding pair** (same
  digest, distinct evidence) that the contract test asserts (P2 #49); a **late critique approval stands while the native
  sessions stay listed** (design-challenge note 2).
- **Docs.** The RUNBOOK critique known limits now state the print-transport refusal, that a round-1 exit with no
  `review.json` records the attack pass `failed`, and the **busy-host browser-queue contention** case with its recourse
  (design-challenge note 3). This handoff's seam and open-P2 sections are updated (notes 2, 3, 5, 6).

Not changed (out of scope, Stop): no attack-pass rerun per round, no non-Claude provider, no `src`/viewer, no change to how
the other reviewers' findings are decided, no worker-deny-list entry removed.

## What shipped

- **Version gates (2.9.0 joins every set that lists 2.8.0).** `guardrails.GUARDED_VERSIONS`, `sidecar.SIDECAR_VERSIONS`,
  `panel.PANEL_VERSIONS`, `attack.ATTACK_VERSIONS`, `launch.CRITICAL_VERSIONS`, `launch.LANE_ROLE_VERSIONS`,
  `launch.SKILLS_VERSIONS`; `contracts/workflow/feature.schema.json` `version` enum and the contract test's version list; a
  committed `contracts/workflow/examples/feature.2.9.0.json`.
- **Configuration.** `feature.schema.json` gains the optional `critique` object (`{lanes, skills?, max_budget_usd?,
  timeout_minutes?}`); the reviewer id `critique` and the prefix `critique-` are reserved in the feature and policy node-id
  patterns. `verification.schema.json` is policy **1.4.0** with the optional `critique_app` (`{argv, ready_path,
  timeout_seconds}`), gated to 1.4.0, and `attack_check` now allowed on 1.3.0 or 1.4.0.
- **`workflow/critique.py`** (new): configuration (`declared`, `settings`, `lanes_of`, `validate_critique_app`, `pin`,
  `validate_plan`, `has_critique`), the output schema (`output_schema`, P1/P2 only), the job settings/command/env
  (`critique_settings`, `critique_command`, `critique_env`), the prompt (`critique_prompt`, `builtin:critique`), the child
  (`CritiqueChild`: worktree + setup, free ports, app start and ready wait under a browser slot, the headless job, the
  translation to a decision, the evidence map and screenshot-path confinement, the process-group stop, the persisted
  decision, resume), the review hooks (`ensure_started`, `wait_for_critique`, `close_or_wait_critique`, `settled`,
  `stop_child`), the review-entry translation (`review_entry`, `current_decision`, `blocks`) and the export helpers
  (`finding_evidence`, `artifacts`, `round_evidence`, `evidence_key`, `artifact_id`), and the entry point
  (`python -m workflow.critique <run>`).
- **Launch / prepare.** `launch.load_feature` refuses `critique` before 2.9.0; `launch_commands` refuses a `critique.lanes`
  entry that is not a lane and a `critique` without a policy `critique_app`, resolves the critique skills on the host, and
  passes `--critique-settings` to prepare; the dry run prints the critique block. `prepare` (`--critique-settings`, guarded)
  pins `plan.critique` (the lanes intersected with the selected lanes — refused when empty, design-challenge note 2 — the
  skills copied into `<run>/skills/critique` and pinned by digest, the advisor, the job's `--settings` digest, the
  `critique_app`, the worktree path) **last** so `plan.feature_version` reads 2.9.0; the **print transport is refused** with
  `critique`.
- **Review step.** `automatic.review_candidate` calls `critique.ensure_started` beside `attack`/`panel` on every path that
  launches or rebinds reviewers, and `critique.close_or_wait_critique` on every exit. `_accept_native` waits for the critique
  (`critique.wait_for_critique`) after the native reviewers settle, then `combined_review`/`_decide`/`blocked_event`/
  `blocked_error` append the critique after the native reviewers (never in `ReviewStatus.ids`, design-challenge note 3), and
  `Pipeline.validate_review` passes the native reviewer list plus `critique`. A failed critique writes `review.json` with a
  `null` verdict (which `combined_review` counts as blocking) and its reason in `automatic-review-critique.json`.
- **Fix loop.** `fix_decision`'s attack gate now loops on a plan with `critique` (attack+critique included) and keeps
  today's no-loop behaviour for an attack-only plan. A critique open P1 naming one lane repairs that lane; the round-scoped
  `$RUN/critique/<round>/` and `review-rounds.json` give the next round the previous findings and the delta.
- **Export / server / contracts.** Export **1.11.0** (`export_state.py`): each critique finding in the review section and in
  each archived round carries `evidence` (keyed by the digest of `(severity, worker, message)` plus the occurrence index),
  and the review section carries the critique artifact list `critique_artifacts` (`{id: critique-<round>-<sha12>, kind:
  screenshot, path, sha256, bytes}`). `server/projects.ts` accepts them and serves each critique screenshot (live and
  archived) through the existing artifact route, with the same hash/size check. `contracts/projects/v1.ts` adds the optional
  `evidence` to the review and fix-loop finding schemas; `contracts/projects/examples.ts` adds `critiqueReviewResult` and
  `critiqueFixLoop` (ids `critique-1-<sha12>`, an archived round included) — the `viewer` lane builds its fixtures from them.
- **`clean`.** `clean.run_worktrees` removes the critique worktree `<runs root>/<run>.critique/worktree`.
- **`builtin:critique`** at `workflow/prompts/reviewers/critique.md` with the PRD 4.4 rubric.
- **Docs.** RUNBOOK "Critique reviewer (feature.json 2.9.0)" (the failure/transport/budget/setup rules and the PRD 4.6 known
  limits, and that `Bash` makes the write limit advisory); README rows.

## The seam (what the `viewer` lane builds on, PRD 4.8)

The `viewer` lane runs alone on the integrated engine base. Its base is:
- `contracts/projects/v1.ts` review/fix-loop finding `evidence` (optional) and the generated `reviewResult.schema.json` /
  `fixLoop.schema.json`.
- `contracts/projects/examples.ts` `critiqueReviewResult` and `critiqueFixLoop` (a critique reviewer entry, a P1 with
  `evidence`, two findings with the same digest keeping their own evidence, and an archived round with its own evidence).
- The export's `review.findings[].evidence`, `review.critique_artifacts`, and the archived rounds' `findings[].evidence`.
- The server's artifact route serving `critique-<round>-<sha12>` screenshots.

**Archived rounds carry only the blockers (design-challenge note 5).** `start_review_round` records an archived round's
**open P0/P1 findings verbatim** in `review-rounds.json` (`automatic.py`), and the export and server build each archived
round from that list. So an archived round's critique **P2s (and their screenshots) are NOT in the export** — the live
round shows them, "Earlier rounds" does not. PRD 4.5 says the viewer shows "each archived round's findings (every
reviewer's)"; read that as every reviewer's **blocking** finding. The `viewer` lane should expect archived-round critique
evidence on P1 findings only and treat the absence of P2 evidence there as intended, not a gap.

**The native reviewer sessions must stay listed while the critique runs (design-challenge note 2).** An approval runs
`check_listed_identity` after `wait_for_critique`, which can be ~50 minutes after the natives were accepted. The approval
stands only while the idle native `claude --bg` sessions are still listed in the inventory; if an idle reviewer session
drops out of the listing during the critique's span, the approved review is refused with no `review.json`. The test
`test_a_late_critique_approval_stands_while_the_native_sessions_stay_listed` proves the path with a still-listing
inventory; it cannot prove the sessions actually stay listed that long (see Open P2s).

## Deviations and open assumptions

1. **Lane id `critique` is reserved globally**, not only in a feature that declares `critique` (the PRD's narrower wording),
   following the `attack` precedent (one node-id pattern, shared by every version). No existing feature has a `critique`
   lane, so this changes no existing launch. *(open assumption)*
2. **`worker_settings(directory, ..., deny_run=True)`** adds the two `$RUN/**` Edit/Write denies in one place; the plain and
   skills-lane callers are byte-for-byte unchanged (the new keyword defaults off). The critique `--settings` is one argument
   with the same digest every round, as design-challenge note 1 requires.
3. **The critique evidence is round-scoped** at `$RUN/critique/<round>/` (not moved by `archive_review`): the round number
   from `review-rounds.json` already separates rounds, so the export reads an archived round's evidence in place. *(open
   assumption; `archive_review` is unchanged for the critique)*

## Panel review of critique.py (10 defects) — fixed in this run, each with a component test

A three-model panel reviewed `workflow/critique.py` and found ten real defects in the untested paths; each is fixed and
covered by a targeted component test in `workflow/test_critique.py` (no automatic-graph e2e needed):

1. **`previous_round` read the archived `review.delta.round-<k-1>.diff`, not the round's live delta.** Fixed to read the
   live `review.delta.diff` the review step wrote for this round (test: a round-2 prompt carries the previous findings and
   the live delta, and no `review.delta.round-1.diff` is read).
2. **`ensure_worktree` checked out before resetting and ignored git exit codes.** Now it resets first, moves to the
   candidate and checks every git call, verifying HEAD and a clean tree or failing the critique (test: a dirty tracked
   file across rounds, HEAD is the new candidate).
3. **`settled()` treated a failed record as settled, so [L2](c)'s rerun-once-on-resume never happened.** A failed critique
   carries `retries`; it is settled only after one rerun or once `review.json` exists (test: fail, not settled; fail again,
   settled, `retries==1`).
4. **`artifacts()`/`round_evidence` trusted paths from `evidence.json`.** The `safe_screenshots` confinement (resolved
   inside `critique/<round>/`, a regular `.png`) is now re-applied on read (test: a rewritten `evidence.json` pointing
   outside is dropped).
5. **An interrupt left the `claude --print` job (its own session) and the app running.** `cleanup()` kills the job's
   process group and stops the app; `start_app` records the process on `self.app` before the ready-wait and `run_job`
   records `self.job_process`, so both are reachable on interrupt (test: `cleanup` kills a job's own-session group and the
   app).
6. **`ensure_started` was not idempotent before `RUNNING` existed.** It now takes a start-lock and waits briefly for the
   child's `RUNNING` marker (test: two calls launch one child).
7. **`stop_child` escalated to SIGKILL after 3 s, before the child's up-to-3 s app stop.** The grace is now 8 s.
8. **`critique.jobs.json` kept a stale pid.** It is keyed by round and session and cleared when the job ends (test:
   absent after a completion).
9. **An interrupt, a native deadline or a partial record left the detached child holding the slot and app for its whole
   deadline.** `close_or_wait_critique` now stops the child on EVERY exit before the critique settled — a Ctrl-C, an exit
   75, a native reviewer's deadline, a rejected file and a `_record_partial` that wrote `review.json` while the critique
   was still running (`review.json` existing is no longer the guard, review round 1 findings 1/2/6). On an interrupt or
   exit 75 it records nothing, so a resume reruns the job with a new app process group (PRD 6); on any other error it
   records the critique failed (tests: a native error stops+records; an interrupt stops without recording; a partial
   record still stops; a settled critique is left alone).
10. **`current_round` fell back to round 1 on a malformed `review-rounds.json`.** It now fails closed (`MalformedRounds`)
    (test: raises on malformed JSON and a bad rounds list).

Repaired in round 1 of user-critique-002 (review findings 3, 4/8, 5, 7, 10, 11, 12):

- **`wait_for_critique` overwrote a failed critique's real reason, session and launch time, and reran it mid-step.**
  `_record_failed` now keeps the child's own failed record (`_failed_this_round`), and `wait_for_critique` does not
  re-`ensure_started` a critique that already failed this round — the one rerun is a resume's, through
  `_review_candidate` (test: `wait_for_critique` keeps the child's reason and does not rerun).
- **The export's critique reviewer entry had the wrong status and no launch time.** `reviewer_entries` now reads the
  critique's launch time from `automatic-review-critique.json` and derives its status from its verdict (a blocking or
  failed critique reads `blocked`), so the viewer names it among the blockers (tests: a blocking and a failed critique
  entry).
- **The server dropped archived-round critique evidence.** `RunStore.fixLoopOf` carries each archived round's critique
  findings' `evidence` from the export onto the live findings, matched by index (server test: an archived round's
  critique finding keeps its evidence).
- **The prompt scraped `verify_yourself` from the task text.** It is a field of the lane worker's completion file;
  `critique_prompt` now reads `$RUN/<lane>.completion.json` (`completion_verify`) (test: the prompt carries the Goal and
  the completion's `verify_yourself`).
- **Timing: the critique started before the native reviewers launched.** `_review_native` starts it right after the
  launch loop (PRD 4.4 Timing), so setup does not compete with the reviewers' launches.
- **A critique finding with no evidence exported `{steps: [], screenshots: []}`.** `finding_evidence` omits the
  `evidence` key for a finding with no steps (Appendix A is 1..20 steps); the contract now requires `steps` min 1
  (test: the export omits evidence when a finding has none).
- **The lane id `critique` was reserved globally in the schema, so a feature before 2.9.0 with such a lane no longer
  launched.** The schema's lane/reviewer pattern no longer reserves `critique`/`critique-`; the reservation is
  conditional, enforced at launch and prepare only when the feature declares `critique` (tests: the schema allows the id;
  launch refuses a `critique` lane only when critique is declared).

Also added earlier in this run: the print-transport refusal (`refuse_print_transport`, called at prepare; unit-tested),
and a review-step-level test that a native P1 on `pages` plus a failed critique writes the block and `fix_decision` picks
`pages`.

## Open P2s

- **Print-mode plugin loading is untested with the real `claude` (design-challenge note 7, P2 #1).** The job loads
  `impeccable` through `--setting-sources "" --plugin-dir` under `claude --print`. Nothing in the repository shows this
  works headless (the existing code says skills load "only through a native `--setting-sources ""` session"); the engine
  tests use a fake `claude`, so they cannot catch it. **Probe it before the first 2.9.0 feature declares `critique`**: run
  the real `claude --print` with the critique argv against a trivial app and confirm the `impeccable` skill loads and the
  app is driven. If print mode does not load the plugin, the critique still walks flows but silently skips the Impeccable
  design half.
- **A native reviewer's deadline before any native block ends the round with no `review.json` and no repair** (design-challenge
  note 8), whatever the critique found. With the 45-minute critique default against a 30-minute review timeout the native
  reviewers usually settle first, so this is rare but asymmetric; documented in the RUNBOOK's critique known limits.
- **The full LangGraph automatic-graph drive is not re-exercised for the critique.** Every unit is covered by a component
  test (the fix_decision gate, the review.json join via `combined_review`, the `CritiqueChild` end to end, the export/server
  seam); the multi-round graph drive would mostly re-exercise the native review graph that `test_automatic` already covers.
  In particular, Acceptance 3's **round archive-then-rerun** (`start_review_round`/`archive_review` then a round-2 critique)
  and Acceptance 4's **round-1 `attack.json` stays and is not rerun** are proven in pieces (the fix_decision gate, the
  round-2 prompt from a hand-written `review-rounds.json`), not through one multi-round graph drive (followup P2 #46, #47).
- **Busy-host browser-queue contention blocks the run with no in-run retry (design-challenge note 3).** The critique takes
  its slot after the natives settle; on a busy host the slot wait can run out, the critique is recorded `failed` (which
  blocks), and with approving natives and no lane to repair the run blocks on host load, not a defect. `settled()` leaves
  it so (a resume does not rerun once `review.json` exists). Recourse, now in the RUNBOOK known limits: `browser-queue on
  --slots N`/`off` before launch, or a follow-up run.
- **The native reviewer sessions must stay listed for the critique's whole span (design-challenge note 2).** If an idle
  `claude --bg` reviewer session drops out of the live inventory during the ~45-minute critique, an otherwise-approved
  review is refused with no `review.json`. Nothing in the plan guarantees an idle reviewer stays listed that long; watch
  the first runs. The seam section records this for the viewer lane.
- **Two liveness mechanisms on the detached child (design-challenge note 6).** The critique runs as a detached child
  (`start_new_session=True`) tracked through a RUNNING marker, `/proc` cmdline matching, a start lock, a startup grace and
  a retries counter. Since repair session 1 `close_or_wait_critique` stops the child on every exit, so the detachment no
  longer keeps it alive across controller restarts — it only adds liveness heuristics (three of round 1's P1s came from
  them). A plain controller-owned subprocess would also get the terminal's SIGINT. The task did not ask for a redesign and
  the restored code is what this run verifies; noted as a simplification for a later run.
- **`O6`/`G5` scrub is tested with one `*_TOKEN` secret only.** `test_app_started_on_free_ports_in_the_worktree_with_a_scrubbed_env`
  asserts a `CRITIQUE_FAKE_SECRET_TOKEN` does not reach the app and the app runs in the worktree with both ports; it does
  not enumerate every secret pattern `checks.check_environment` drops.
- **A manual (non-`--automatic`) launch of a critique feature is not refused (followup P2 #30).** `prepare` pins
  `plan.critique` whatever the mode, and `Pipeline.validate_review` then requires a `critique` reviewer entry, but only the
  automatic review step runs the critique — so a manual run's imported reviews can never validate. Not fixed here (it would
  change the manual-run gating, outside this run's verification scope); an operator should launch a critique feature with
  `--automatic`. Worth an early refusal in a follow-up.
- **`wait_for_critique`'s "still pending at 31 minutes, native deadlines unchanged" is not driven end to end (followup P2
  #42).** The native-block interplay is covered by `combined_review` + `wait_for_critique` component tests and the late-approval
  test; the specific 45-minute-critique/30-minute-review timing is existing `wait_reviews` behaviour, documented in the
  RUNBOOK, not driven by a critique clock test.

## Red / green

`workflow/critique.py` did not exist at the base commit, so `workflow/test_critique.py` could not import it — import-level
red. The version-gate and reserved-id assertions failed against the pre-change schemas (the export, feature and policy
versions), the expected "for the right reason" failures. Green after the change: `workflow.test_critique` (27 tests),
`workflow.test_feature_launch` (56), the review/pipeline/export suites (`test_pipeline test_automatic test_lanes
test_verification test_export`, 397) and the contract and server suites (`test:contracts` 35, `server/projects.test.ts` 98).
The final full `workflow.run_tests` result is in the completion.
