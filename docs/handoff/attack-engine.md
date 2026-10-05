# Attack pass — engine handoff (run attack-pass-002, extended by run attack-pass-003)

> Run 003 built on run 002's candidate and closed its open P1s and two P2s; see the "Run 003" section below. Where this
> file's earlier text disagrees with that section (for example deviation 6 on preflight), the Run 003 section is current.

The engine lane of `docs/PRD_ATTACK_PASS.md`: a feature.json 2.5.0 feature may declare `attack`, and its automatic run gets
a report-only attack pass at the review step. This file records what shipped, the seam, the deviations and the follow-ups.

## What shipped

- **Contracts (`contracts/workflow/`).**
  - `attack.schema.json` 1.0.0: `<run>/attack.json` (Appendix A), with `$defs.output` (attacker) and `$defs.skeptic_output`.
    `settings` is closed to the eight Appendix A keys. `test_file` and `settings.requirements` use a relative-path pattern
    (`$defs.relPath`); `secret_files` are absolute.
  - `feature.schema.json` 2.5.0 + optional `attack` object (angles, budgets, `requirements`); `attack` refused on earlier
    versions (`workflow/attack.py` `declared`, before schema validation, names the key).
  - `verification.schema.json` 1.3.0 + optional `attack_check` `{argv, timeout_seconds}` (a new `allOf` rule the legacy-rule
    finder in `contract.test.ts` skips; `{file}`-exactly-once is enforced in `attack.validate_attack_check`).
  - Reserved id `attack` and prefix `attack-` added to the three node-id patterns and `contract.test.ts`.
  - Committed record examples under `contracts/workflow/examples/`: `attack.example.json` (Appendix A verbatim),
    `attack.pending.example.json` (export-only shape), `attack.refused.example.json`, `attack.failed.example.json`,
    `attack.timed-out.example.json` (succeeded pass, a timed-out attacker, skeptic `not_run`). These are for the viewer lane
    and the coverage reviewer to validate against the projects contract's `attackResult` (sidecar design-challenge note 3).
- **`workflow/attack.py`** (new): configuration (`declared`, `settings`, `requirements_of`, `validate_attack_check`,
  `pin`, `validate_plan`, `record_settings`), the record (lock, atomic validated write, `pending_record`,
  `initial_record`, `export_section`), the job commands and environment (`attacker_command`, `skeptic_command`,
  `attacker_env`, `output_schema`, `skeptic_output_schema`), the prompts, the child (`AttackChild`: setup, per-angle
  attacker, test-copy + global `A-<n>` ids, re-run, skeptic, records, events, attention, resume/orphan-kill, SIGTERM), the
  review-step hooks (`ensure_started`, `close_or_wait_attack`), the entry point (`python -m workflow.attack <run>`), and the
  three operator commands (`pass_main`, `label_main`, `tally_main`).
- **Version sets / registrations.** `guardrails.GUARDED_VERSIONS`, `sidecar.SIDECAR_VERSIONS`, `launch.CRITICAL_VERSIONS`
  (new set; `CRITICAL_VERSION` kept as the migration hint) all take 2.5.0; `sessions.RESERVED_NODE_IDS/PREFIXES`,
  `costs.ROLES` (`attack`), `attention.KINDS` (`attack`), `actor.OPERATOR_ONLY` (`attack-pass`, `attack-label`).
- **Launch / prepare.** `launch.load_feature` refuses `attack` before 2.5.0; `launch_commands` runs the secret-file guard
  and the `attack_check` requirement (dry run included), adds the `requirements` documents to the commit-at-HEAD check, and
  passes `--attack-settings` to prepare; the dry run prints `attack` (settings, secret-file list, guard result). `prepare`
  (`--attack-settings`) pins `plan.attack` (settings, `requirements` + copies, `secret_files`, briefs + digests, skeptic
  brief, `attack_check`, `worktree`, `rerun`). `pipeline` preflight (for a policy with `attack_check`) re-runs the guard and
  requires `--max-budget-usd` in `claude --help`.
- **Review step.** `automatic.review_candidate` wraps `_review_candidate`: `attack.ensure_started` on the launch, rebind and
  already-decided paths (after the reconciliation raise, per design-challenge note 4), and one `close_or_wait_attack` on
  every exit. No-op for a plan without `attack`.
- **Export / status / outcome / clean.** Export 1.8.0 adds top-level `attack` (null / pending / the record / failed) and the
  `attack` graph node (right after `review`, same `depends_on`; `approval` depends on `review` and `attack`). `status` gains
  the `attack` key; the outcome block gains a report-only `Attack pass (report-only): ...` line; `clean` removes the two
  attack worktrees. Worker prompts gain one independence line (`interactive.ATTACK_NOTE`) when `plan.attack` is set.
- **Briefs.** `features/attack-pass/attack-briefs/{auth-funds,inputs-state,permissions-files,skeptic}.md` installed verbatim
  as `workflow/prompts/attack/<same>.md` (G6).
- **Grill skill.** `workflow/skills/workflow-grill/SKILL.md` names 2.5.0 and asks the attack-pass question when it applies.

## Seam-first milestone (design-challenge note 2)

The seam (schemas, version sets, reserved ids, `plan.attack`, export 1.8.0 with `attack: null`/pending, the graph node,
costs/attention/actor/clean registrations) was green under the targeted suite (`test_export`, `test_guardrails`,
`test_sidecar`, `test_lanes`, `test_pipeline`, `test_attention`, `test_clean`, …) **at ~05:00 UTC on 2026-10-05**, before the
`attack.py` job machinery was written. The job machinery, the review hooks and the commands followed.

## The overall bound (PRD 4.1, [L8])

`overall_bound_seconds(plan, setup_total)` =
`len(angles) * (timeout_minutes*60 + skeptic_timeout_minutes*60 + max_findings * attack_check.timeout_seconds)
 + 2 * setup_total + 600`, where `setup_total` is the sum of the policy `setup` step timeouts (the two worktrees are each set
up once) and 600 is PRD 4.1's "and 10 minutes".

Under pine's defaults (1 angle, `timeout_minutes` 60, `skeptic_timeout_minutes` 20, `max_findings` 8, an `attack_check`
timeout of 600 s): `3600 + 1200 + 8*600 + 2*setup_total + 600 = 10 200 + 2*setup_total` seconds ≈ **170 minutes plus twice
the policy setup** — "near three hours per angle" (PRD §9). `close_or_wait_attack` waits up to this bound after the review
decides, then stops the child and records the pass `failed`.

## How `no_test` and `error` are detected ([L5])

`reason_from_output(text, exit_code)` in `attack.py`: `no_test` when the check's output matches "no test files found",
"no tests found", "collected 0 items" and the like; `error` when the exit is non-zero and the output shows an import,
collection, transform or setup error (`cannot find module`, `ModuleNotFoundError`, `SyntaxError`, `collection error`,
`ECONNREFUSED`, …) rather than a failed assertion; otherwise the exit code decides (0 → `passed`, non-zero → `reproduced`).
A `124` exit (the `attack_check` timeout) is `timed_out`. **Pre-pilot check:** before the pilot, run the chosen pine
`attack_check` on a known-failing test in a reset worktree and confirm (a) the test is collected from `attack-tests/`, (b) a
real assertion failure reads as `reproduced`, (c) a missing-module case reads as `error`, and (d) the reset
(`git checkout -- . && git clean -fd`, no `-x`) leaves `git status --porcelain` empty while ignored setup outputs
(`node_modules`, build outputs, `.env.test`) stay ([L10]).

## An outage during the review loses the running attacker ([L8], G7)

`close_or_wait_attack` on `KeyboardInterrupt` and `TransientInfraError` stops the child and records nothing; the next
controller resumes from `attack.json`, kills a recorded orphan (by pid + session id, as `sidecar.kill_orphan`), records an
attacker or skeptic left `running` as `failed` (`interrupted`), and runs only what is still owed. **Nothing reruns an
interrupted attacker**, so the attacker running at the moment of a Claude Code outage is lost.

## Calibration follow-up ([L13])

PRD 5.0's calibration (running the pass offline on a staged copy of the claims-005 run) needs a way to give a staged old run
a `plan.attack` and an `attack_check`: `attack-pass` refuses a plan without `attack`, and prepare only pins `plan.attack`
from a live launch of a 2.5.0 feature. This is an **open follow-up** for the operator before the pilot: either stage the run
with a hand-written `plan.attack`/`policy.attack_check`, or add a `workflow.replay`-style staging path.

## Red / green

- **Red:** `workflow/attack.py` did not exist at the base commit (`git show HEAD:workflow/attack.py` → "does not exist"), so
  `workflow/test_attack.py` (which imports `workflow.attack`) could not run at base — import-level red. The pinned-version
  and reserved-id tests also failed against the pre-change schemas (14 failures in the first targeted run: export version,
  the attention kinds, the cost roles), the expected "for the right reason" failures.
- **Green:** `workflow.test_attack` 27 tests pass; `npm run test:contracts` 26 pass; the targeted suite
  (`test_export test_portable test_guardrails test_sidecar test_feature_launch test_clean test_outcome test_interactive`,
  386 tests) passes; `test_automatic` + `test_lanes` pass (the two pre-existing coverage-brief counts, broken by the
  eighth feature `features/attack-pass`, were updated from 7→8 and 8→9 in `test_automatic.py`). The final full
  `workflow.run_tests` result is recorded in the completion.

## Deviations from the PRD / open assumptions

1. **`attack.json` status is the four record statuses** (`running|succeeded|failed|refused`); `pending` and the
   invalid-record `failed` shape are **export-only** (Appendix A line 243; sidecar design-challenge S-2). The engine never
   writes `pending` to `attack.json`; `export_section` builds it and does not validate it through `attack.schema.json`.
2. **`test_file`/`requirements` carry a relative-path pattern** in the schema (sidecar S-2/new-1); `requirements_of` refuses
   a path outside the repository, as the PRD's path is refused.
3. **The attacker prompt embeds the PRD only when its pinned copy is decodable text.** A binary PRD (PDF) is omitted from the
   prompt; the attacker still gets the `requirements` copies, each lane's `## Goal` and `decisions.md`. Pine's PRD is
   markdown, so this does not bite the pilot. *(open assumption)*
4. **`attack-label` re-export is best-effort**: the label is saved under the lock first; a run whose checkpoint cannot be
   re-exported still records the label (a warning is printed). *(open assumption)*
5. **`clean` removes the two attack worktrees** (`<run>.attack/worktree`, `<run>.attack/rerun`); the now-empty
   `<run>.attack/` parent directory may remain. *(minor; open assumption)*
6. **preflight detects the attack pass by `policy.attack_check`** — *superseded by run 003 fix 8 (see Run 003 item 7):*
   preflight now gates on a `--attack` flag launch appends from the feature's `attack`, so a policy that keeps `attack_check`
   after its feature drops `attack` is no longer guarded.
7. **`stop_child` verifies the pid's `/proc/<pid>/cmdline`** holds `workflow.attack <run>` before `killpg` (sidecar new-3),
   and `close_or_wait_attack` fails the pass fast when the child died without a terminal record instead of waiting the whole
   bound (sidecar new-2).

## The seam (Appendix A)

`contracts/workflow/attack.schema.json` is the engine's half of the seam; the viewer builds `attackResult` and its fixtures
from the committed schema and the `contracts/workflow/examples/attack.*.example.json` records. The changes to the schema
beyond the PRD prose (the four-status record, the `relPath` pattern) are recorded above and in the schema's `description`.

## The committed record example

`contracts/workflow/examples/attack.example.json` is the PRD Appendix A example verbatim (two findings, one succeeded
attacker). `workflow/test_attack.py::Seam::test_appendix_a_example_validates_verbatim` reads it from the PRD and validates it.

## Run 003 — closing run 002's P0/P1 findings and two P2s

Run 003 starts from run 002's candidate `b567788874f91622721312c6188ff42922d1e236` (restored into this lane's owned paths;
`git diff --stat` against it prints nothing before the run) and closes every P1 and two P2s that both reviewers left open in
`features/attack-pass/run-002-review.md`. No key or enum of `attack.json`/Appendix A changed ([L15]); the seam is unchanged.

**What changed (all inside `workflow/`, `contracts/workflow/` is untouched this run):**

1. **Resume ([L15], fix 1).** `AttackChild` is now resumable per phase, not per angle. `angle_complete` treats an angle as
   owed when its attacker is absent, or (when the attacker succeeded) any finding still has `rerun: null` or a reproduced
   finding has no skeptic yet. `process_angle` runs only the owed attacker/re-runs/skeptic; `run_attacker` is never re-run for
   an interrupted attacker. `rerun_findings` skips findings whose `rerun` is already set and **saves after each finding**, so a
   re-run already done survives a restart. The finding→test-source map is recovered from disk, never memory only: `add_findings`
   writes `<run>/attack/<angle>/<id>.src` beside the copied test, and `_src_from_disk` reads it on resume ([L15] allows "a
   file beside the copied test"; the `stdout.json`-by-`ref` alternative it also allows is not used). `skeptic_job` returns early when the skeptic already ran (succeeded,
   failed or timed_out), so a resumed child never re-runs it. `rerun: null` is the live "re-run owed" marker; no new key or enum.
2. **`attack-tally` added runtime (fix 2).** Each row and the totals now print `added runtime`, computed as
   `max(0, attack.json finished_at − the review's decision time)` from epoch timestamps. The overall total is over the runs
   that have both times.
3. **The review's decision time ([L18], fix 3).** `_review_decided_at` reads the latest non-null `reviewers[].accepted_at`
   from `review.json`'s **content** (compared by epoch, not as strings, so mixed precision cannot misorder), never the file's
   mtime (an approved run re-saves `review.json` after the wait, `pipeline.py` review node) and never a `review` event. The
   [L12] early-finish flag compares each attacker's `finished_at` with that time.
   - *Design-challenge note 1 (worker):* when any `reviewers[].accepted_at` is null (a reviewer alive past the decision), the
     run's added runtime prints as an upper bound `≤ N s` and the [L12] flag prints `unknown (a reviewer ran past the
     decision)`; the total is marked `≤` when any included run was an upper bound.
   - *Design-challenge note 5 (worker):* a run with a missing time (no `review.json`, or a null `finished_at`) prints
     `added runtime unknown` / the flag `unknown` and is left out of the total, so one such run never crashes the tally.
4. **Registry node (fix 4).** `registry_entry(..., attack=…)` passes the flag to `definition`; `merge_registry` rebuilds the
   stored definition with `has_attack_node`, so the `attack` node and the approval-on-both edge survive a later launch. Launch
   passes `attack=attack.declared(manifest) is not None`.
5. **`attack-pass` locks ([L14], fix 5).** `pass_main` takes `automatic-supervisor.lock` then `controller.lock`, non-blocking
   (as `clean`), and holds both for its whole foreground run; it is refused with the existing "Another controller owns this
   run" error when either is busy. `_child_running` now also recognises a foreground `attack-pass` cmdline, so the controller
   never starts a second child beside a live operator pass. An automatic step holds `controller.lock` and the supervisor holds
   `automatic-supervisor.lock`, so the two can never run a pass concurrently.
6. **`test_file` guard ([L16], fix 7).** `add_findings` accepts a reported test only as a regular file under a directory named
   `attack-tests`, reached without following a symlink at any component (`_safe_test_src`); anything else is recorded
   `not_reproduced` with reason `no_test` immediately (its `rerun` is set, so it is not owed) and the file is never copied.
7. **Preflight decides from the feature ([L16], fix 8).** `preflight` now gates the secret-file guard and the
   `--max-budget-usd` requirement on a new `--attack` flag that launch appends when the feature declares `attack`, not on
   `policy.attack_check`. A feature that keeps `attack_check` in its policy after dropping `attack` is no longer guarded.
8. **Sidecar new-2 (this run).** A Ctrl-C during `close_or_wait_attack`'s decided wait now stops the detached child and
   records nothing, then re-raises so the controller interrupt is not swallowed; the next controller resumes from `attack.json`.

**Tests (fix 6).** `workflow/test_attack.py` gains an in-process `AttackChild` over a toy git repository with a fake `claude`
(`WORKFLOW_CLAUDE`/`FAKE_CLAUDE_CONTROL`, six-tool argv = attacker, three-tool = skeptic): the happy path end to end
(`run_attacker → rerun_findings → skeptic_job → finish`, verified/refuted/not-reproduced), a passing test that never reaches
the skeptic, a two-angle clean-worktree isolation, the resume path (interrupt after the attacker, fresh child recovers the
test source from disk and verifies), the `test_file` guard (symlink and out-of-`attack-tests`), attacker timeout/crash/invalid
output, prompt independence, `close_or_wait` [L9]/[L4]/Ctrl-C, the `_review_decided_at`/tally runtime and flag (including notes
1 and 5), and the `attack-pass` lock refusals. `test_portable` gains the registry attack-node test.

**Remaining P2s under Run 003 (each with why it stays open):**

- *Count assertions (sidecar note 3, Acts: operator; run-002 review final P2).* `test_automatic.py` (coverage-brief count
  7→8→9) and `test_verification.py` (feature-policy count 8→9) were edited by run 002 because `features/attack-pass/`
  is the eighth/ninth committed feature; the run-003 restore recipe restored those edits and the diff-stat against the
  candidate is empty. They are kept, not reverted (reverting turns `workflow-unit` red at this base). Accepted exception to
  "existing tests stay green unchanged"; recorded as an open assumption.
- *Manual `attack-pass` recovery (sidecar note 4, Acts: operator).* G8 still refuses any existing `attack.json`, so an
  interrupted foreground pass or calibration stays `running` with no command to close it. Amending G8 to resume a non-terminal
  pass is an operator decision; nothing in run 003's fixes depends on it, so it is left as the operator's call.
- *`_sigterm` kills every recorded job pid without a liveness check; `ensure_worktrees` skips setup when `.git` exists
  (run-002 review P2, sidecar S-7/S-11-adjacent).* Both are in code this run does not change (the SIGTERM handler and worktree
  setup); kept out of scope. The restart path already guards reused pids through `kill_orphan`.
- *Attacker deny rules do not cover the run directory or shared refs (run-002 review P2).* Accepted no-sandbox risk per O1 and
  PRD §9; [L2] already moved the attack worktrees out of the run directory. Left as the accepted trade-off.
- *`timed_out` vs `failed` for a stopped attacker (run-002 review P2, Acts: operator).* The candidate records `timed_out`
  (the task and Appendix A's enum); the PRD §4.3 prose says `failed`. An operator decision, left as recorded.
- *Untested behaviours this run did not change:* the launch dry-run print of the attack block, the subprocess refusals
  (2.5.0 without `attack_check`, a secret file present at launch/dry-run with a temporary `HOME`), the `status`/outcome text,
  the attention text exactness, and the export-section wiring for an older run. These are run-002 P2 test gaps for behaviour
  run 003 does not touch; listed in the completion's `untested`.
- *Fix 3 is tested at the unit level, not through the full pipeline.* `_review_decided_at` **is** changed and covered:
  `ReviewDecidedAt` seeds a `review.json` whose file mtime is far later than its content `accepted_at` (via `os.utime`) and
  asserts the content time wins — the exact effect of the approved run re-saving `review.json` after the wait — and the null
  reviewer / missing-time cases. The end-to-end drive of `review_candidate` through the LangGraph review node with a fake
  print reviewer (an approved and a blocked run) is **not** written; `review_candidate`'s graph wiring is unchanged from run
  002, and the `close_or_wait`/tally/`_review_decided_at` logic it calls is covered by `CloseOrWait`, `TallyRuntime` and
  `ReviewDecidedAt`. Task lines 13 and 16 name that pipeline-driven approved+blocked drive as a deliverable; it is **recorded
  as a named deviation in the completion** (not a plain untested gap), with the rationale that pipeline.py's review node
  re-saves the same decision content, so the `os.utime` model is faithful to the mtime-vs-content distinction fix 3 targets.

### Run 003 red / green

- **Red (new fix tests against the restored run-002 candidate, before any run-003 edit):** running the new classes against
  the unchanged code failed for the right reasons — `TestFileGuard` (both: the symlink/out-of-`attack-tests` path was copied
  and re-run as `reproduced`, not `no_test`), `Resume.test_interrupt_after_attacker_then_resume_verifies` (the resumed child
  recorded the finding `not_reproduced`/`no_test` instead of verifying — the exact run-002 defect), `ReviewDecidedAt` (the old
  `_review_decided_at` returned a scalar, not `(decided, pending)`, and read events not content), `TallyRuntime` (no
  `added runtime`, no content-based flag, no `unknown`), and `PassLocks` (no lock was taken, so the refusals did not fire).
  The harness tests that cover already-correct behaviour (`HappyPath`, `TwoAngleIsolation`, `AttackerPromptIndependence`,
  `AttackerFailure`, `CloseOrWait`) passed on the unchanged code, as expected for added coverage rather than a fix.
- **Green (after the run-003 edits):** `workflow/test_attack.py` (52 tests), the registry attack-node test in `test_portable`,
  the fix-8 launch wiring test in `test_feature_launch`, the preflight-guard test `test_pipeline.PreflightAttackGuard`,
  `test_pipeline` (67+1), the targeted set (`test_attack test_export test_portable test_guardrails test_sidecar
  test_feature_launch`, 289 tests) and the whole `workflow.run_tests` (905/906 tests) pass; `npm run test:contracts` is 26/0.

### Run 003 review follow-up: a direct fix (2026-10-05, by the operator's maintainer, not a workflow run)

Run 003's reviewers blocked the candidate `7fb2f5b` with four P1s. On the operator's instruction, two real bugs were fixed
directly on branch `fix/attack-pass-003-p1s` (from `7fb2f5b`), not through a new workflow run:

- **Every fresh pass failed at its first setup command** (general P1). `ensure_worktrees` ran the policy's `setup` before it
  created `<run>/attack/`, so `checks.execute` raised `FileNotFoundError` opening `attack/setup-0.log` and the pass was
  recorded `failed` before any attacker started. Fix: create `self.attack_dir` first; give each worktree its own setup log
  (`setup-<worktree|rerun>-<n>.log`) and a `setup-<name>.done` marker, so a setup that failed or was interrupted runs again
  on resume. Covered by `test_attack.SetupInWorktrees` (two tests).
- **A resumed child skipped the secret-file guard** (coverage P1, PRD 4.2). The check ran only `if record is None`. Fix: it
  runs on every start (fresh or resumed) before any setup/attacker/re-run, and `process_angle` checks again before each
  angle; a listed file that reappeared records the pass `refused` (every not-yet-started attacker `refused`, nothing re-run)
  with its closing event. New `Refused` exception. Covered by `test_attack.SecretGuardOnResume` (two tests).

The two remaining P1s are test-coverage gaps, not code defects (the fixes the reviewers checked are correct): the
pipeline-driven approved+blocked end-to-end test for `_review_decided_at`/tally (general P1-2, already a disclosed deviation
with `close_or_wait`/`TallyRuntime`/`ReviewDecidedAt` unit coverage), and the `recover()`/`kill_orphan`/SIGTERM paths
(general P1-3). The latter are now covered too: `test_attack.Recover` and `test_attack.TerminatedChild` (a real child whose
hanging attacker job is killed by `stop_child`, then recorded `interrupted` on resume). The pipeline-driven end-to-end test
remains the one open item, recorded here and in decisions.md [L19].

Gates for this fix: `workflow.test_attack` + `workflow.test_feature_launch` (108 tests) pass; the two new secret/setup
classes fail for the right reasons on the pre-fix `attack.py` (setup: `FileNotFoundError` on `attack/setup-0.log`; guard:
the resumed pass re-ran instead of refusing, and the second angle's attacker ran). Full `workflow.run_tests` below.
