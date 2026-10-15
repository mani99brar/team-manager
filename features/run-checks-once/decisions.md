# Decisions: run-checks-once

Every worker and reviewer prompt includes this file. The Operator decisions are the operator's own words and bind the run; they win over the task file and the PRD (`features/run-checks-once/prd.md`).

## Operator decisions

- [O1] The request, 2026-10-14, after a machine-log check showed two concurrent full suites failing a lane on load (transcript `1a283e24-9b99-4f4a-92f6-3f77af0a1009.jsonl`). Operator, line 268:
  > "Why do we need to the same tests 3 time, why dont we only run them once?"

  Operator, line 356, on the session's offer to build candidate dedupe and to put run-level checks through /cook:
  > "Yes lets cook this"
- [O2] On [O1] the session ran `/cook` on 2026-10-14. Its arguments are the session's words, not the operator's; their substance is in the PRD §1-§3. /cook delegates the grill and every run decision to the panel (Claude Fable + GPT Astra, Jev on splits). Its answers are under Grill decisions and Changes after launch, tagged `(panel …)`.

## Grill decisions

- [G1] **Limits.** These hold as written:
  - browser checks are never shared and never run-level (PRD §4 E4, §6.1);
  - no viewer, server, `src`, `contracts/projects` or export-shape change (§9);
  - the worker phase is unchanged, and this feature claims no worker-phase dedupe;
  - attribution covers run checks only, and a failing shared lane check blocks the first declaring lane (§5);
  - feature.json is untouched, and this run's policy stays 1.4.0;
  - /cook's feature-rules are untouched.

  Each excluded item stays under Deferred. (panel: agree, high; grill q1)
- [G2] **One feature, one engine lane,** delivering all of PRD §4-§8 plus the §9 compatibility rules. The review runs with `--review-timeout-seconds 3600`. (panel: agree, high; grill q2)
- [G3] **Owner fallback.** PRD §7.3 d holds:
  - it applies only after the reproduction and base checks;
  - an id failing on several snapshots, or on none, goes to the lane whose `owned_paths` contain the failing test's file, when exactly one lane owns it, recorded as owner-attributed, distinct from snapshot-attributed;
  - when no lane or several lanes own the file, the failure is unattributed.

  §11.8 d and e prove it. (panel: agree, medium; grill q3)
- [G4] **No parsed ids** (another runner, or nothing parses). The reruns run the whole run check on the candidate, the base and each lane snapshot, one at a time and never concurrently, each capped at the run check's timeout, and §7.3 treats the check as one id. A memory-killed run check takes the transient path first and gets no attribution reruns. This run adds no node:test parser (PRD §7.1, §11.8 i). (panel: fallback:recommended, medium; grill q4)
- [G5] **Base and flaky failures.** Ids pre-existing at base, or not reproducing on the candidate, pick no lane.
  - When no attributable id remains, every lane's packet is blocked with a reason naming those ids, no repair starts, and retries follow `check_retries`, then `controller_blocked`. The candidate gate never passes with a failed run check.
  - This holds on a one-lane run too: an unattributed block carries a marker that the repair path refuses (PRD §6.3, §11.8 h).
  - (panel: agree, high; grill q5)
- [G6] **Equivalence by argv.** Identical non-browser argv within one candidate attempt and its shared setup and environment is the only equality test (PRD §4 E1-E8):
  - ids, kinds and timeouts may differ, and the execution runs with the largest timeout;
  - each lane gates under its own id, kind and timeout, and a lane whose timeout the execution exceeded is blocked (§11.2).

  (panel: agree, high; grill q6)
- [G7] **Launch after 002's candidate gate.** The launch waits until review-panel-registry-002's candidate gate has finished, re-checked every 10 minutes, on base 44b9c24. The worker never starts its own full suite while another `workflow.run_tests` runs on the host. (panel: agree, medium; grill q7)
- [G8] The engine lane runs on `claude-opus-5-5` at effort `high`. (panel: agree, high; grill q8)

## Changes after launch

- [L1] **One narrow `automatic.py` edit for the one-lane refusal.** Supersedes the task's Stop rule sentence that the PRD §6.3 refusal "belongs in `repair.py`" and, for this one change only, the Constraints line "Do not edit `automatic.py`". `repair.py` defines a predicate (for example `unattributed_block(packet)`) that is true when a blocked candidate packet carries the unattributed marker of [G5]. `fix_decision` (automatic.py :2171) calls it and returns None when the single blocked candidate packet matches, so the block falls through to `check_retries` and then `controller_blocked` with zero repair sessions. No other `automatic.py` line changes; `repair_session` never raises for this case and `transient_packet` is never used for it. Touches Acceptance 8 h and PRD §6.3, §11.8 h: the end-to-end test drives a one-lane run through the retries to `controller_blocked` and asserts no `fix loop exhausted` event, no memory-kill event and zero repair sessions. (panel: jev:claude; run-checks-once-001 challenge attempt 1, P1-1)
- [L2] **Lockstep candidate attempts under a shared record.** Supersedes the PRD §4 E2 and §5 wording that keys the shared execution to "the candidate attempt" as if lanes shared one. On any run that would produce a shared record (any policy), the candidate hook first raises every lane's candidate attempt to the highest current candidate attempt among the lanes, then runs the shared execution. Each candidate attempt has exactly one shared record per distinct argv, and every lane packet of that attempt cites that record; a cached packet from an older attempt is never reused beside a newer record. Touches Acceptance 5, 8 and 11 and PRD §11.5, §11.8: a two-lane test retries lane b alone (`retry --phase candidate --node b`) and shows both lanes at the same new attempt, both new packets citing one new record, and a run check failing on that record blocking lane a when attribution names a. The 1.4.0 regression test pins that a single-lane retry re-verifies the other lane too; this is the only retry-target difference allowed on 1.0.0-1.4.0, and the handoff doc names it. (panel: jev:claude; run-checks-once-001 challenge attempt 1, P1-2)
- [L3] **Carried P2s** (worker items, each pinned by a test or named in a doc):
  - the 1.4.0 regression fixture includes two lanes with the same argv and different timeouts, pins the exact gate reasons of the shorter-timeout lane under E7, and the handoff doc states the reason difference (supersedes the Constraints line "Their gate reasons … do not change" for that case only);
  - the shared execution keeps `lane_tmpdir()` outside the run directory, one TMPDIR per shared attempt, stored in the shared record as packets store it (supersedes the PRD §4 E6 phrase "inside the shared attempt folder");
  - the RUNBOOK equivalence section and the handoff doc state that ignored outputs of earlier shared commands are visible to later ones;
  - every attribution rerun (parsed ids too, extending [G4]) runs one at a time, pinned by a test whose counter file shows no overlapping executions;
  - the handoff doc says candidate dedupe benefits every policy at once, and that worker-phase load only drops once a policy moves the suite into `run_checks` (Deferred items);
  - the `contract.test.ts` change is one new `it` block placed apart from the existing version assertions; an existing line changes only where its assertion would otherwise fail against the widened rules.
  (panel: jev:claude; run-checks-once-001 challenge attempt 1, P2 1-6)

- [L4] **Carry repair-2** (run-checks-once-002, follow-up of 001). This supersedes nothing and adds to the engine task's Acceptance.
  - Repair-2's uncommitted fix of 001's review blockers is committed as `features/run-checks-once/carry/repair-2.diff` (355 lines: `shared_checks.py`, `run_report.py`, `test_run_checks.py`, `RUNBOOK.md`, the handoff doc). After the restore from f62e844, apply it first with `git apply features/run-checks-once/carry/repair-2.diff`, byte for byte, resolving conflicts only.
  - Acceptance: its three tests pass:
    - `test_a_memory_kill_beside_a_real_run_check_failure_makes_the_attempt_a_real_failure`;
    - `test_a_module_that_fails_to_import_is_a_failing_id_that_reproduces`;
    - `test_a_slow_run_check_is_named_on_the_candidate_event`.
  - Plus one new test: a lane that attribution clears passes, and the kill is dropped from its packet.
  - Touches PRD §6.2, §7.3 a, §8.2 and §11.8 i. (panel: agree; 001 controller_blocked, triage groups A, B, C)
- [L5] **A slow note on blocked attempts too.** This closes the remaining gap in triage C. When a lane's own check blocks before `finish()`, a run check over SLOW_SHARE still gets its slow note on the candidate event, as lane checks do. Acceptance: a test with a failing lane check and a slow run check asserts the note. Touches PRD §6.2. (panel: agree; triage C)
- [L6] **Run-only logs and missing citations are tamper failures.** This extends the PRD §11.5 tamper rules.
  - `cited_record`/`recheck_packet` verify that every run check's log in the record exists and matches its `log_sha256`, not only the lane's own argvs (triage D).
  - On a policy with non-empty `run_checks`, a candidate packet without `shared_record` fails `recheck_packet` and `validate_bundle`, on both the reused (C28) and the regular path (triage E). Worker packets stay valid without a candidate citation.
  - Acceptance: one test deletes or alters a run-only log and expects recheck to fail. One test removes `shared_record` from a 1.5.0 candidate packet and expects both checks to fail. The 1.4.0 fixtures are unchanged.
  - Touches PRD §6.3, §11.5 and §11.11. (panel: agree; lane review round 2 P1s 1-2, triage D, E)
- [L7] **An interrupted attribution rerun passes no id.** This extends [G4] and PRD §7.3.
  - When a rerun exits on timeout (124) or a kill, every id without a failure header is recorded `not run`, never `passed`. Incomplete evidence never clears a lane and never establishes an attribution: `not run` ids count as not applicable for the lane choice, and the reason names them.
  - Acceptance: a test under the run_tests runner with ids [A, B], where A fails and the rerun is killed before B, asserts that B is `not run`, not `passed`, and that no lane is chosen on B.
  - Touches PRD §7.3 and §11.8 i. (panel: agree; GPT panel f3, triage G)
- [L8] **A known limit, not fixed: browser lanes and cited build outputs** (triage F, PLAUSIBLE only; no committed md-manager policy needs it). The handoff doc and the RUNBOOK equivalence section state that a browser lane's worktree runs only its own `setup`. Ignored outputs of cited non-browser checks (for example a build's `dist/`) are therefore absent there, and a policy that needs them lists the build in the browser lane's `setup`. No test. (panel: agree; GPT panel f1)
- [L9] **Verification hygiene for 002.**
  - Before your full-suite run, run `npm ci` in your worktree. Repair-2's full suite failed only because `node_modules` was missing when it started.
  - Never start a full suite while another `workflow.run_tests --jobs` runs on the host ([G7]).
  - The review needs fresh verification; repair-2's environmental diagnosis does not establish readiness. (panel: agree)

- [L10] **Isolate the browser queue in the workflow suite** (run-checks-once-003: `--follows 002`, `--restore-from 8eb67b6`). This supersedes nothing and adds to the engine task's Acceptance. Run 002's last blocker was environmental (triage group D): its fixture browser checks waited up to 161 s on the operator's live machine-wide queue while another run held it.
  - The change: `isolate_registry()` in `workflow/test_pipeline.py` also sets `MD_MANAGER_BROWSER_QUEUE` to a `browser-queue` directory inside its per-test temporary directory, as `test_browser_queue` and `test_critique` already do. No test then ever waits on `~/.config/md-manager/browser-queue`.
  - Acceptance:
    - one test shows that under `isolate_registry()`, `browser_queue.queue_dir()` lies inside the temporary directory and never under `Path.home()`;
    - fixture subprocesses inherit it;
    - the whole workflow suite passes with the live queue left as it is.
  - Nothing else changes: no other `workflow/` behaviour, no `browser_queue.py` or `checks.py` change, and no change to the policy or feature.json. The fixes of run 002 (triage A-C, at 8eb67b6) stay as they are.
  - The handoff doc names the one-line overlap with review-panel-registry's seats-lane path (`workflow/test_pipeline.py`) for the operator's hand merge.
  - [L9] holds for 003: `npm ci` before your full suite, and never start one while another `workflow.run_tests --jobs` runs on the host. Fresh verification, candidate checks and review follow; 8eb67b6 is not ready until they pass.
  - (panel: agree; 002 controller_blocked, triage group D)

- [L11] **Every test module that takes a browser slot runs under an isolated queue** (run-checks-once-003, challenge attempt 1, P1). This extends [L10] and supersedes, for this change only, its sentences "Nothing else changes: no other `workflow/` behaviour" and the acceptance phrase "never under `Path.home()`"; `browser_queue.py`, `checks.py`, the policy and feature.json still do not change. One helper (a new small module under `workflow/`, for example `workflow/test_env.py`, or a function in `test_pipeline.py` only if no other test module must import `test_pipeline` for it) sets `MD_MANAGER_BROWSER_QUEUE` to a `browser-queue` directory inside a temporary directory the caller owns. `isolate_registry()` calls it per test; `test_browser_rules` and `test_critique` call it from a `setUpModule` (with a matching `tearDownModule`) so `WorkerPhaseScenarioEvidence.verify` and `run_child`/`env()` never reach `~/.config/md-manager/browser-queue`; the two tests in `test_critique` that already set their own queue keep theirs. Acceptance (task Acceptance 16, widened): (a) the proof test asserts that under `isolate_registry()` `browser_queue.queue_dir()` is inside the isolate's temporary directory and is neither `Path.home()/'.config/md-manager/browser-queue'` nor under it, and it passes with TMPDIR set to a directory under HOME (P2 1); (b) fixture subprocesses inherit the variable; (c) before the normal full suite, the worker runs the held-queue proof once: a scratch HOME whose `.config/md-manager/browser-queue/settings.json` enables one slot, the slot held by a background `flock … sleep`, then `HOME=<scratch> timeout 600 .venv/bin/python -m workflow.run_tests --jobs 4`; the suite passes and its output has no "Browser queue:" wait line, and the Proof table records the command and the grep; (d) the normal full suite passes with the live queue left as it is, under [L9]. The handoff doc's merge note lists every file this change touches with the exact lines each adds, matching `git diff --stat` of the [L10]/[L11] commit; the overlap with review-panel-registry-002 stays the one line in `workflow/test_pipeline.py` (P2 2). (panel: jev:claude; run-checks-once-003 challenge attempt 1, P1 and P2 1-2)

- [L12] **A held-queue proof that can fail only on a leak** (run-checks-once-003, challenge attempt 2, P1 and P2 1-4). This supersedes [L11](c) and, for this change only, [L11]'s sentence that the overlap "stays the one line in `workflow/test_pipeline.py`" and its merge-note sentence "matching `git diff --stat` of the [L10]/[L11] commit". Touches task Acceptance 16 and [L11] (a)-(c).
  - (c) becomes: before the normal full suite, the worker runs the held-queue proof once. A scratch HOME has `.config/md-manager/browser-queue/settings.json` = `{"enabled": true, "slots": 1}`; slot-1 is held by `flock <scratch>/.config/md-manager/browser-queue/slot-1.lock sleep 3600 &` (longer than the cap, so a leaking test hangs instead of passing after a wait); then `HOME=<scratch> GIT_CONFIG_GLOBAL=<real HOME>/.gitconfig timeout 1800 .venv/bin/python -m workflow.run_tests --jobs 4` (the cap equals the lane check's timeout; the PRD measured the suite at 365-775 s alone). Exit code 0 is the proof. The grep for a "Browser queue:" wait line is supporting evidence only, since run_tests prints a class's output only when it fails. The Proof table records the full command, the exit code, the `Ran N tests in Xs` line and the grep. The worker captures the real HOME before changing it, confirms the holder has acquired the lock before starting the suite (for example a non-blocking `flock -n` on the same file fails), keeps the holder active throughout, and kills the `sleep` afterwards. [L9] still applies, and (d), the normal full suite, is still required. An exit 124 here counts as a leak, not as the Stop rule's unrelated failure, unless the same ids fail at 8eb67b6 without a held slot.
  - (a) the proof test sets `tempfile.tempdir` alongside TMPDIR when it places the temporary directory under HOME, restores both afterwards, and fails if the helper falls back to `Path.home()` (P2 4). Proof (b), subprocess inheritance, is still required.
  - The helper lives in the new module; `isolate_registry()` gains a top-level import plus the call, and the hand-merge overlap with review-panel-registry-002 is those two lines in `workflow/test_pipeline.py` (P2 3).
  - The merge note measures with `git diff --stat 8eb67b6 -- workflow contracts/workflow docs/handoff/run-checks-once.md`, lists every file in that output with the lines each adds, and lists the handoff doc as "this merge-note section" (P2 2).
  - (panel: agree; run-checks-once-003 challenge attempt 2, P1 and P2 1-4)

- [L13] **A held-queue proof over the browser-slot modules only, with the real Chromium and git identity** (run-checks-once-003, challenge attempt 3, P1 and P2 1). This supersedes [L12](c) (and so [L11](c)); [L12](a), (b), the helper placement, the merge note and (d) stay as written. Touches task Acceptance 16 and [L11] (c).
  - (c) becomes: before the normal full suite, the worker runs the held-queue proof once over the modules that take a browser slot: `workflow.test_pipeline.PipelineTests`, `workflow.test_critique`, `workflow.test_browser_rules`, plus every other test module the worker finds reaching `browser_queue`/`browser_slot` (directly, or through a fixture policy with a `browser` kind check, or through `checks.run_lane_commands`); the Proof table lists the grep used and the modules found. Before HOME changes, capture `REAL_HOME=$HOME`. A scratch HOME has `.config/md-manager/browser-queue/settings.json` = `{"enabled": true, "slots": 1}`; slot-1 is held by `flock <scratch>/.config/md-manager/browser-queue/slot-1.lock sleep 3600 &`, confirmed held with `flock -n` on the same file failing; then `HOME=<scratch> GIT_CONFIG_GLOBAL=$REAL_HOME/.gitconfig PLAYWRIGHT_BROWSERS_PATH=${PLAYWRIGHT_BROWSERS_PATH:-$REAL_HOME/.cache/ms-playwright} timeout 900 .venv/bin/python -m workflow.run_tests --tests <those ids>` (the holder outlives the cap, so a leaking test hangs to 124 instead of passing after a wait). Exit code 0 is the proof; the Proof table records the full command, the exit code, the `Ran N tests in Xs` line and the "Browser queue:" grep as supporting evidence. The worker keeps the holder active throughout and kills the `sleep` afterwards.
  - On exit 124, the Proof table names the first class missing from the output (`pool.map` prints in submission order, run_tests.py:163-171) and whether that class takes a browser slot: a browser-slot class is a leak to fix under [L11]; any other class is slowness, and the worker reruns that class alone without the holder before invoking the Stop rule. On any other non-zero exit, the worker reruns the same command without the holder: a failure that repeats without the holder is environmental (for example a missing Chromium executable) and is reported under the Stop rule with its ids, never fixed by widening [L10]/[L11].
  - Before holding the slot, the worker runs the same `run_tests --tests <those ids>` command under the same scratch HOME and environment, without the holder. It must pass, and the Proof table records its command and result, so a scratch-environment failure is caught before the held run (GPT's addition).
  - The full suite is not run under the scratch HOME: (d), the normal full suite with the live queue untouched under [L9], is the only full suite in the worker phase. This keeps one heavy suite at a time on the shared host ([G7]). (panel: fallback:revise-merged, Claude's text plus GPT's concrete addition; run-checks-once-003 challenge attempt 3, P1 and P2 1-2)

## Deferred

- Showing run-level checks and the shared record in the viewer: a later Sonnet follow-up, after review-panel-registry lands, owned by server/ and src/.
- Teaching /cook's feature-rules to write `run_checks` and targeted lane checks. This is outside this repository, and it starts once ctl runs policy 1.5.0.
- Attributing a failing *shared lane check* (not a run check) to the lane that caused it. It keeps today's first-declaring-lane rule.
- A machine-wide slot for heavy Python suites, like the browser queue.
- The browser-lane build-output limit of [L8].
- Triage backlog from run 001, not carried: K and L (beyond [L4]'s tests), and M (a viewer change, under the first Deferred item).
