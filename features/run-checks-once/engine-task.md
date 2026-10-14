# Engine lane: run each verification check once

## Goal

On the combined candidate revision, each distinct non-browser check command runs once, in one shared verification worktree, and every lane that declares it cites that one result (PRD §4-§5). Policy 1.5.0 adds `run_checks`, which run once per candidate attempt and never per lane (§6). When one of them fails, only its failing tests are rerun on the candidate, the base and each lane snapshot, so the failure blocks exactly one lane for the fix loop, or blocks every lane, with no repair, when no single lane is to blame (§7). `python -m workflow.run_tests --tests <ids>` runs a subset (§8). The viewer and export see nothing new (§9).

Spec: `features/run-checks-once/prd.md`. Binding decisions: `features/run-checks-once/decisions.md`; they win over this task and the PRD.

## Context

- **Follow-up run 003 ([L10]).** Your prompt starts with the restore of your owned paths from run 002's lane snapshot `8eb67b6`, which already meets items 1-15. Make only the [L10] change, then run your checks and hand off.
- **Follow-up run 002 ([L4]-[L9], done at 8eb67b6).** Your prompt starts with the restore of your owned paths from 001's reviewed candidate `f62e844`, which already meets items 1-14 below as 001 delivered them. Then apply `features/run-checks-once/carry/repair-2.diff` ([L4]), and fix [L5]-[L7] and [L8]'s docs. Run 001's review blockers and their triage are summarised in decisions.md [L4]-[L8].
- **Candidate gate** (`workflow/pipeline.py`):
  - `candidate()` :711-785 combines the snapshots, then loops over the lanes. Each lane gets its own `verify_revision(phase="candidate")`, worktree and `npm ci`, and the first blocked lane raises (:763-765). It then writes `review-bundle.json` (:769-784).
  - `reusable_packet` :698-709 is C28: one lane, attempt 1, no repair, no browser check.
  - `validate_bundle` :787-818 wants exactly one worker packet and one candidate packet per lane.
  - `failed_before` :260-270; `retry --phase candidate --node <lane>` :1982-2024.
- **Checks** (`workflow/checks.py`):
  - `verify_revision` :410-492: the packet cache at :418-429, worktree :433-436, environment :449-458, `prune_attempt` :393-407.
  - `run_lane_commands` :546-595: setup, then every check in order; browser runner flags per index :563-566; capture errors keyed by check id :591-594.
  - `check_environment` :511-530 is lane-independent: the per-attempt values are the phase, caches and TMPDIR.
  - `text_test_counts` :80-97.
  - C28: `reuse_packet` :598-629 and `recheck_reused` :632-655 are the pattern for `shared_record`. `recheck_packet` :658-676.
- **Evaluation** (`workflow/verification.py`):
  - `evaluate_worker` :148-262: evidence ids == the lane's ids (:201-204); `command == shlex.join(argv)` and `cwd == expected.verification_cwd` (:221-224); timeout :225-227; counts :230-233.
  - `DEFERRED_WORKER_KINDS` :20-25.
  - `validate_policy` :69-93 (argv distinct within a lane only, :81); lint notes :114-116; `slow_checks` :129.
- **Fix loop and repair:**
  - `automatic.blocked_lanes` :1985-2000 and `fix_decision` :2124-2182 repair a candidate block only when exactly one lane's packet is blocked (:2171).
  - `repair.packet_evidence` :633-639 and `failing_checks` :705-723 read `check-<i>.log` from the packet's folder.
  - `attempt_targets` :441-450 raises every lane's candidate attempt after a repair.
- **Policy schema:** `contracts/workflow/verification.schema.json`. The version enum is at :142. The `attack_check` rule is `["1.3.0","1.4.0"]`, and the `critique_app` rule is `const "1.4.0"`. `contracts/workflow/contract.test.ts:95-107` asserts them. Precedent: commit d7c4aa4 (policy 1.4.0); learning `version-gates-are-sets-add-a-keeps-everything-test.md`.
- **run_tests** (`workflow/run_tests.py`, 139 lines): positional `start_dir`, `--jobs`, hidden `--child`. It runs one subprocess per class. It prints `ok|FAIL <module.Class> (N tests)` lines, then the failed class's output indented 4 spaces, then `Ran …` and `OK`/`FAILED (…)`.
- **run_report** (`workflow/run_report.py:67-118`): `UNITTEST_HEADER` is anchored at column 0, so it misses run_tests' indented failure lines.
- **Readers you must not break** (PRD §9):
  - `export_state.py:627-632` globs `verification/*/*/*/packet.json`;
  - `server/projects.ts:388-394` (phase and lane-id rules), :443 (`reused_from` accepts worker paths only), :1442-1452 (artifacts per packet folder), :326-372 (strict `inputs`);
  - `clean.py:157-174` globs `verification/*/*/*` and expects a packet.json;
  - report.html, `pipeline.py:1053-1107`.
- **Tests to copy:**
  - `test_checks.ReusedPacketTests` :249-341, the C28 model;
  - `test_lanes.LaneRun`/`ThreeLaneRun` :76/:165, with `three_lane_policy` :53-73 (fast fake commands) and `test_two_lanes_run_the_candidate_checks_even_when_one_lane_changes_nothing` :342;
  - `test_repair.FixLoop` :1384 and `CandidateRepairEndToEnd` :175;
  - `test_verification.PolicyLintTests` :214;
  - `test_run_tests.py`;
  - `test_export.py:708`, a literal key-set test.
- **Lessons:**
  - Cross-lane failures pass on every snapshot (gbb-004: 2 of 286 failed only on the combined candidate).
  - A base failure caused a pointless repair (user-critique-005); it should have been a retry.
  - A memory-killed check under a fixed cap is not transient in practice.

## Constraints

- **Owned paths only:** `workflow`, `contracts/workflow`, `docs/handoff/run-checks-once.md`. Never edit `server`, `src`, `contracts/projects`, `tests` or `features`.
- **Keep the overlap small.** Run review-panel-registry-002 is changing `workflow/pipeline.py`, `workflow/automatic.py`, `workflow/RUNBOOK.md`, `workflow/README.md`, `workflow/launch.py`, `workflow/lane_review.py`, `workflow/guardrails.py`, `workflow/test_pipeline.py`, `workflow/test_automatic.py`, `workflow/test_export.py` and `contracts/workflow/contract.test.ts`, and the operator merges by hand.
  - Put the logic in `checks.py`, `verification.py`, `repair.py`, `run_tests.py`, `run_report.py`, `clean.py` and new modules (for example `workflow/shared_checks.py`).
  - Give `candidate()` a thin hook.
  - Do not edit `automatic.py`, `launch.py`, `lane_review.py`, `guardrails.py` or `sessions.py`. If the PRD cannot hold without one of them, stop (see Stop).
  - Put new tests in a new module, `workflow/test_run_checks.py`, and add to existing test modules only where a fixture forces it.
  - In RUNBOOK and README, edit only the sections PRD §10 names.
- **No viewer or export change:** PRD §9, every rule pinned by a test. No export version bump. The citation key is `shared_record`, never `reused_from`.
- **Behaviour on older policies.** Runs at policy 1.0.0-1.4.0 behave as today apart from the shared execution (§5). Their gate reasons, events and fix-loop decisions do not change. Pin this with a regression test on a two-lane 1.4.0 fixture.
- **Equivalence contract** (PRD §4): browser checks are never shared and are never run-level. A shared execution runs with the largest timeout, and each lane still enforces its own timeout.
- **Tests:**
  - Tests run in temporary directories, never touch `~/.config/md-manager/`, `~/.claude` or systemd, and clear the `WORKFLOW_*` variables they read (`patch.dict(os.environ, …, clear=True)`).
  - No wall-clock assertions. Count executions with a counter file written by a fake command.
  - No hard-coded count of `features/*`.
- **Run targeted tests while you build,** for example `/home/agentops/dev/md-manager/.venv/bin/python -m unittest workflow.test_run_checks workflow.test_checks workflow.test_verification workflow.test_lanes workflow.test_repair workflow.test_run_tests`. Run your two lane checks once, at the end, before you write the completion. The host is shared with another run, so never run two full suites at once ([G7]): before your full-suite run, check `pgrep -fa 'workflow.run_tests'`, and wait while another full suite is running.

## Acceptance

Your checks pass:
- `/home/agentops/dev/md-manager/.venv/bin/python -m workflow.run_tests --jobs 4`
- `npm run test:contracts`

Each item of PRD §11 is proved by a named test:

1. **Two lanes, one command** (§11.1). The fake command runs once on the candidate. Both lane packets pass `recheck_packet` and `validate_bundle`, each has its own `check-<i>.log` and artifacts, and each cites one `shared_record`.
2. **Different ids, kinds and timeouts** (§11.2). A lane whose own timeout is shorter than the execution's duration is blocked for timeout. A lane check and a run check with the same argv execute once, with independent evaluations.
3. **Browser checks** (§11.3). The same browser argv in two lanes runs twice. A lane with both kinds passes recheck with exactly its two cwds.
4. **A failing shared lane check** (§11.4) blocks the first declaring lane only, and `fix_decision` repairs that lane.
5. **Cache, retry and tamper** (§11.5), with lane attempts in lockstep under a shared record ([L2]).
6. **Policy 1.5.0** (§11.6; the `contract.test.ts` placement per [L3]):
   - schema and `validate_policy`, with their four refusals;
   - the keeps-everything test;
   - `contract.test.ts` assertions for the enum and both widened rules.
7. **Run checks run once on the candidate** (§11.7), never in the worker phase. The C28 one-lane case is included, and its packet carries both `reused_from` and `shared_record`.
8. **Attribution** (§11.8 a-i), each case on a fixture repository whose base and lane snapshots differ in which test fails ([G3]-[G5], [L2]). Every attribution rerun runs one at a time ([L3]).
   - The one-lane case h is end to end: retries run to exhaustion and `controller_blocked`, with zero repair sessions launched, through the narrow `fix_decision` exception of [L1].
   - The owner fallback (d) is recorded as owner-attributed.
9. **`run_tests --tests`** (§11.9).
10. **The failing-id parser** (§11.10) and `run_report.failures`. It returns method ids over class ids, and the class id only for a crashed class.
11. **Compatibility** (§11.11): a literal key-set test on a 1.5.0 fixture run; no `packet.json` outside the lane paths; and citation targets: `reused_from` → a worker packet, `shared_record` → a shared record. Plus the 1.4.0 regression test from Constraints, with the mixed-timeout reasons and the single-lane-retry difference ([L2], [L3]).
12. **The lint note** (§11.12).
13. **Docs:** the RUNBOOK sections, the README setup and files, and contracts/workflow/README (PRD §10).
14. **The handoff doc** `docs/handoff/run-checks-once.md` (with the [L2] and [L3] notes): what changed, file by file; how a policy author moves the full suite into `run_checks` (one example policy at 1.5.0); what is left (decisions.md Deferred).

15. **Run 002 follow-up:**
    - [L4]: the carry diff is applied, its three tests pass, and the new attribution-clears test passes;
    - [L5]: the slow note on a blocked attempt;
    - [L6]: run-only log tamper and missing-citation refusals;
    - [L7]: an interrupted rerun records `not run`;
    - [L8]: the known limit stated in the handoff doc and RUNBOOK;
    - [L9]: `npm ci` before the full suite.

16. **Run 003 follow-up ([L10]):** `isolate_registry()` isolates `MD_MANAGER_BROWSER_QUEUE`, a test proves it, and the full suite passes with the live queue untouched.

The worker's Proof table names a test for each item.

## Stop

Stop and report `blocked`, with what you found, when:
- the PRD cannot hold without editing a file outside your owned paths, or one of `automatic.py`, `launch.py`, `lane_review.py`, `guardrails.py` or `sessions.py`; name the file and the smallest change it needs. This includes the one-lane "no repair" refusal of PRD §6.3, which belongs in `repair.py`;
- a check reads a lane-specific environment value, so E6 cannot hold;
- `evaluate_worker`'s single-cwd rule cannot admit a citing packet's two cwds without weakening the rule for uncited packets;
- the full suite fails for a reason your change did not cause. Report the failing ids and whether they fail at the base.

## Changes after launch

Changes after launch are `[L<n>]` bullets in `decisions.md`, and they win over this task: [L1]-[L3] (challenge attempt 1) [L4]-[L9] (follow-up run 002) and [L10] (follow-up run 003).
