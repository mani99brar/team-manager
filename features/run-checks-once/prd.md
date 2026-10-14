# PRD: run each verification check once

Feature `run-checks-once`, md-manager workflow controller (`workflow/`). Binding decisions: `features/run-checks-once/decisions.md`; they win over this file.

## 1. Problem

A run's checks belong to its lanes. When several lanes declare the same command, the controller runs it once per lane in both verification phases:

- **Worker phase.** Each lane's snapshot is verified on its own, and the verify nodes run in parallel (`graph_config` max_concurrency, `workflow/pipeline.py:1048`). review-panel-registry-001 and -002 ran two `workflow.run_tests --jobs 4` suites at once, next to a 9-minute Playwright suite, on an 8-core host.
  - Each suite took 1031–1188 s, against 365–775 s alone.
  - In -001, the seats lane failed verification on a timeout that only the load caused: one test class took 715 s, against 88 s alone. That cost the run, and the run was abandoned.
- **Candidate phase.** `Pipeline.candidate()` (`pipeline.py:711-785`) runs every lane's checks again, lane by lane, each lane in its own worktree, on **the same combined commit**.
  - Only a one-lane run without a browser check reuses its worker packet (C28, `reusable_packet`, `pipeline.py:698-709`).
  - projects-dispatch-001..005 and run-controls-002..004 ran build, lint, unit and contract checks twice on one candidate commit. review-panel-registry would have run the full Python suite twice there.

The operator asked (2026-10-14): "Why do we need to the same tests 3 time, why dont we only run them once?"

## 2. Users

- **The operator.** Faster runs, no load-induced failures, and no run lost to a suite that ran three times.
- **Policy authors** (/cook, workflow-grill). They need a place for a check that guards the whole run, the full suite, so that lanes can keep only their own targeted tests.
- **The fix loop.** When such a run-wide check fails, it still needs one lane to repair.

## 3. Scope

In scope:
1. **Candidate dedupe (§5).** On the combined revision, each distinct command runs once, and every lane that declares it cites that one result. This holds for every policy version.
2. **Run-level checks (§6).** Policy 1.5.0 `run_checks`: checks that run once per candidate attempt on the combined revision, never per lane.
3. **Attribution (§7).** When a run-level check fails, only its failing tests are rerun on the base, the candidate and each lane snapshot, so the failure is pinned on one lane, or on none.
4. **Test selection (§8).** `python -m workflow.run_tests --tests <id> ...` runs a subset. A failing-test parser understands run_tests' output.
5. Docs (§10) and a lint note (§6.4).

Out of scope; each item is also a limit in decisions.md:
- No viewer, server, `src/`, `contracts/projects` or export-shape change (§9). Run-level checks appear in the viewer only through the lane packets and events that exist today.
- Browser checks are never shared and never run-level (§4, §6.1).
- The worker phase is unchanged: lane checks still run on each lane snapshot. Its saving comes from policies that move the full suite into `run_checks` and give lanes targeted checks.
- Attribution applies to run-level checks only. A shared *lane* check that fails keeps today's rule: the first declaring lane in declared order is blocked.
- No feature.json change (review-panel-registry takes 2.11.0). This run's own policy stays 1.4.0, because ctl at 44b9c24 cannot run 1.5.0.
- The /cook skill and its feature-rules (outside this repository) are not changed here.

## 4. Equivalence contract

Two lane checks share one execution only when all of these hold:
- **E1.** The phase is `candidate`.
- **E2.** They are of the same candidate generation and attempt, so of the same commit.
- **E3.** Their `argv` lists are identical.
- **E4.** Neither is of kind `browser`.
- **E5.** They run in the attempt's one shared verification worktree, after the policy `setup` ran once in it. `setup` is policy-level, so it is the same for every lane.
- **E6.** The environment comes from the same `check_environment` (`checks.py:511`) with the same per-attempt values (phase, cache dirs, TMPDIR inside the shared attempt folder). It carries nothing lane-specific. If the code shows that a check reads a lane-specific value, stop and report.
- **E7.** The execution's timeout is the largest of the declaring lanes' timeouts. Each lane's evaluation still enforces its own timeout, so a lane with a shorter timeout fails exactly as it would have run alone.
- **E8.** Kinds and ids may differ between the lanes. Counts are parsed once (`text_test_counts`), and each lane gates under its own id and kind. Capture and scenario errors are keyed by the shared execution and reach every lane that cites it, under that lane's check id.

**Execution order** in the shared worktree:
- Lanes in declared order, each lane's non-browser checks in policy order, skipping an argv that already ran; then `run_checks` in policy order, again skipping an argv that already ran.
- A lane check and a run check with the same argv share one execution within the attempt, at the largest of their timeouts. The lane evaluations and the run-check evaluation stay independent: when the lanes pass on that execution but the run check fails its own gate (for example its own shorter timeout), run-check attribution (§7) still applies.
- The worktree must stay clean between checks as today. Whatever the current code requires of a lane's worktree after a check, it requires of the shared one.

## 5. Candidate dedupe

**Shared execution**
- For each candidate attempt (generation g, the candidate commit), the controller creates one shared verification worktree, runs `setup` once and runs every distinct non-browser command once (§4).
- It writes a **shared record** describing those executions: argv, cwd, times, exit code, log, parsed counts, capture errors and the declaring lanes and ids.
- The record lives at a path that no packet reader matches: never a file named `packet.json`, and never at `verification/<phase>/<lane>/<n>/` (§9). `clean` must handle it, keeping it while any packet cites it.
- The attempt's cache works as for packets (`checks.py:418-429`): a record of the same commit, policy digest and attempt is reused, and anything else reruns.

**Lane packets**
- Each lane still gets `verification/candidate/<lane>/<n>/packet.json`. It is self-contained:
  - its `result.checks` holds the lane's executions in lane order;
  - its logs are copied as `check-<lane index>.log`;
  - its artifacts are copied into its own folder (immutable, as today).
- So `repair.failing_checks`, report.html, export and the viewer read it unchanged.
- It names the record in a **new optional key** `shared_record: {"path": <run-relative>, "sha256": <hex>}`. This is not `reused_from`, whose viewer regex accepts worker paths only (`server/projects.ts:443`).
- `recheck_packet` follows `shared_record` the way C28 follows `reused_from` (`checks.py:632-655`): the path stays inside the run, the sha256 matches, and the lane's executions equal the record's for its argv. It then evaluates the lane under its own policy (`phase="candidate"`).
- **Browser checks.** A lane's browser checks run in that lane's own candidate worktree, as today, with their own setup. Its packet then holds executions from two cwds. A citing packet accepts exactly two: the lane's own worktree for its browser checks, and the cited record's worktree for the rest. An uncited packet keeps today's single-cwd rule.

**Gate semantics**
- Lanes are evaluated in declared order, and the first blocked lane raises, exactly as today (`pipeline.py:763-765`). One shared failure therefore blocks one lane and spends one attempt.
- After a repair, `attempt_targets` raises the lanes' attempts as today, and the next attempt reruns the shared execution once.
- C28 one-lane reuse stays. A 1.5.0 run that reuses its worker packet still runs its `run_checks` once on the candidate (§6.2).

**Events**
- `candidate_<lane>` events keep their texts.
- One extra event on node `candidate` before the lanes: `Shared checks: <k> commands for <m> lane checks on <commit>` (with `; run checks: <r>` on 1.5.0).

## 6. Run-level checks (policy 1.5.0)

### 6.1 Schema

`contracts/workflow/verification.schema.json` gains version `1.5.0` and an optional top-level `run_checks`, allowed only at 1.5.0:
- `run_checks` is an array, 1–20 items, of `{id, kind, argv, timeout_seconds, scenarios: []}` with the lane check shape.
- `kind` is one of `build|typecheck|unit|integration|contract`. It is never `browser`, and `scenarios` is always empty.
- Ids follow the lane check id pattern. They are unique within `run_checks`, and none equals a lane check id. Argvs are distinct within `run_checks`.

The version rules are exact-match sets (learning `version-gates-are-sets-add-a-keeps-everything-test.md`):
- the `attack_check` rule widens to `1.3.0, 1.4.0, 1.5.0`;
- the `critique_app` rule widens from `const "1.4.0"` to `1.4.0, 1.5.0`;
- `contracts/workflow/contract.test.ts` asserts the new enum and rules;
- a keeps-everything test proves that every committed `features/*/policy.json` and every example still validates, and that 1.5.0 accepts everything 1.4.0 accepts.

`verification.validate_policy` enforces the same id, argv and kind rules. A lane's `required_check_kinds` must still be met by its own lane checks, so `contracts/projects/v1.ts:1104-1107` keeps holding. A run check never satisfies a lane's required kind.

### 6.2 When they run

- Once per candidate attempt, in the shared worktree after the lanes' shared commands (§4). They run on every 1.5.0 run, the one-lane C28 case included.
- A run check whose argv equals a lane check's shares that lane check's execution (§4). It is never executed twice in one attempt.
- Never in the worker phase. That phase has no combined commit.
- Every run check gates in the candidate phase: build kinds need exit 0, and test kinds need parsed counts with `passed ≥ 1` and `failed == 0`. Their slow note and memory-kill (transient) handling are the lane checks' (`slow_checks`, `transient_checks`).

### 6.3 Gate and evidence

- The shared record holds the run checks' executions and evidence.
- **Every lane's candidate packet of a 1.5.0 run cites the record** (`shared_record`), so the review bundle binds it through the lane packets. The bundle's shape is unchanged (`pipeline.py:769-784`).
- **Order of evaluation.** A lane's own checks come first: lanes are evaluated in declared order, and the first lane whose own checks fail is blocked and raises, as today (§5). Attribution (§7) runs only when every lane's own checks pass and a run check failed.
- `recheck_packet` of a citing packet also rechecks the record's run checks and the record's attribution:
  - **All run checks passed:** the lane packet passes on its own checks.
  - **A run check failed and the record attributes it to lane L:** L's packet is blocked, with the §7.4 reason, and every other lane's packet passes. The block is carried by a marker on the packet that recheck reproduces, the way `lane_review_block` is.
  - **A run check failed unattributed:** every lane's packet is blocked with the same reason. The fix loop then finds several blocked lanes and takes today's path for that case: no repair, retries per `check_retries`, then `controller_blocked` (`automatic.py:2171`).
  - **A one-lane run** has only one blocked lane, so the fix loop would repair it. An unattributed block must therefore carry its own marker, and the repair path must refuse to start a repair session for a packet that carries it ([G5]).
    - The lifecycle is the same as on a multi-lane run: no repair session is ever launched, retries follow `check_retries`, and the run then reaches `controller_blocked`.
    - Put that refusal in `repair.py` (engine-owned, no overlap) if it preserves this lifecycle.
    - If it cannot without editing `automatic.py` or another file the task forbids, take the task's Stop rule. Never substitute an immediate stop.
  - After a run-check failure, every lane's packet is written before the step raises.

### 6.4 Lint note

When two or more lanes declare the same non-browser argv, `verification` emits a policy note, through the same channel as the existing "requires no test kind" note (`verification.py:114-116`):

`lanes <a>, <b> declare <argv>: it runs once at the candidate but once per lane in the worker phase; move it to run_checks (policy 1.5.0) and give the lanes targeted checks`

## 7. Attribution of a run-level failure

When a run check fails on the candidate, the controller decides which lane, if any, to block. This happens inside the same candidate attempt; it costs no extra attempt and no repair.

1. **Failing ids.**
   - Parse them from the run check's log with the parser of §8.2: Python unittest-family output (`workflow.run_tests` and `python -m unittest`). A crashed class yields its class id.
   - For any other runner, or when no id parses, the "ids" are the whole run check. The reruns below then run the whole run check, one at a time, never concurrently, each capped at the run check's timeout, and step 3 treats the check as one id ([G4]).
   - This run adds no node:test parser.
   - A memory-killed run check takes the transient path first (`transient_checks`) and gets no attribution reruns.
2. **Reruns.** Rerun only those ids:
   - on the **candidate** (did the failure reproduce?), the **base** commit, and **each lane's snapshot**;
   - each in a fresh worktree with `setup`, through the same Python as the run check's argv;
   - with `workflow.run_tests --tests <ids>` when the check is run_tests, and `-m unittest <ids>` when it is plain unittest. On a commit whose `run_tests` has no `--tests` (an argparse usage error), use `-m unittest <ids>`;
   - each rerun capped at the run check's timeout.
   - A test id that does not exist on a snapshot (a loader `_FailedTest`, or an ImportError/AttributeError while loading it) counts as **not applicable** there, not as failing.
3. **Outcome**, in this order:
   - a. Ids that do not fail on the candidate rerun are **did not reproduce**.
   - b. Ids that fail on the base are **pre-existing at base**.
   - c. Each remaining id is attributed to the lane on whose snapshot alone it fails.
   - d. An id failing on several snapshots, or on none (a cross-lane interaction), goes to the lane whose `owned_paths` contain the failing test's file, when exactly one lane owns it ([G3]).
     - This runs only after the reproduction and base checks (a, b).
     - The record and the reason mark it **owner-attributed**, distinct from snapshot-attributed.
     - When no lane, or several, own the file, the id is unattributed.
   - e. Otherwise it is unattributed.
4. **Result.**
   - If every attributed id names one and the same lane L, and no id is unattributed, **L is blocked**, with reason `run check <id> failed: <n> test(s) attributed to <L>: <ids, first 5>`.
   - Ids pre-existing at base or not reproducing are listed in the reason, and they never pick a lane.
   - Ids naming two or more lanes, or any unattributed id, or only base and did-not-reproduce ids, make the failure **unattributed** (§6.3), with a reason that names each class of id.
5. **Recording.**
   - The record keeps the attribution: per id, its outcome on the candidate, the base and each snapshot, plus the rerun logs.
   - One event on node `candidate`: `Run check <id> failed; <outcome summary>`.
   - The blocked lane's packet folder gets a copy of the failing run check's log, and `repair.failing_checks` includes it, so the repair brief shows the failure.

## 8. Test selection and failing-test parsing

### 8.1 `run_tests --tests`

`python -m workflow.run_tests [--jobs N] [--tests ID [ID ...]] [start_dir]`:
- `--tests` runs only the named ids (module, class or method), each class in its own subprocess as today.
- The output format is unchanged (class lines, indented failure output, the `Ran …`/`OK`/`FAILED (…)` summary), so `text_test_counts` parses it.
- An unknown id is reported as a failing class line, never a crash.
- `--tests` and `start_dir` together is an argparse error.

### 8.2 Failing-id parser

One function (in `workflow/run_report.py` or beside the attribution code) returns the failing test ids of:
- run_tests output: the **indented** `    FAIL: name (id)` / `    ERROR: name (id)` lines, and the `FAIL <module.Class> (N tests)` class lines;
- plain unittest output (`FAIL:`/`ERROR:` at column 0).

It returns the specific failing method ids when there are any. It uses a class id only for a failed class that has no method-level failure line, such as a class that crashed or failed to import. Attribution therefore reruns only the failing methods of a class that also has passing methods.

`run_report.failures` (`run_report.py:67`, anchored at column 0 today) uses it, so `run-report` also lists run_tests failures.

## 9. Compatibility contract (no viewer or export change)

Each rule is pinned by an engine test:
- Packets exist only at `verification/{worker,candidate}/<lane>/<n>/packet.json` (`export_state.py:627-632`; `server/projects.ts:388-394`). The shared record is not a packet and is not at that depth or name.
- **Citation targets.** `reused_from`, when present (C28, on a candidate packet), always names a worker packet. `shared_record` always names a shared record. A candidate packet may carry both: a one-lane C28 reuse on a 1.5.0 run also cites the record of its run checks. Tests pin the targets and the recheck of each, not the absence of `reused_from` on candidate packets.
- Every lane packet's `artifact_paths` and its `check-<i>.log` files exist in its own folder.
- `export_state` key sets are unchanged: no new `inputs` keys, no new per-check keys, no export version bump. A 1.5.0 run exports with `policy_version` "1.5.0" and its lane checks only.
- Events use node `candidate_<lane>` (today's texts) or `candidate`.
- Runs of policy 1.0.0–1.4.0 behave as today, apart from §5's shared execution: same gates, same reasons, same fix-loop decisions.

## 10. Docs

- **`workflow/RUNBOOK.md`:**
  - §4 (freeze and verification);
  - "Verification policy and evidence" (the equivalence contract, the shared record, `run_checks`, attribution);
  - the fix loop's "What triggers a round" (attributed and unattributed run-check failures);
  - the retry bullet;
  - the "Files in a run directory" table.
- **`workflow/README.md`:** Setup/Files, and the `run_tests --tests` option.
- **`contracts/workflow/README.md`:** policy 1.5.0.

## 11. Acceptance (each provable by a named test)

1. **Two lanes, one command.** A two-lane run whose lanes declare the same non-browser argv executes it once on the candidate; a fake command appends to a counter file. Both lane packets pass `recheck_packet` and `validate_bundle`, each has its own `check-<i>.log` and artifacts, and each cites one `shared_record`.
2. **Different ids, kinds and timeouts** share one execution. Each lane gates under its own id and kind, and a lane whose own timeout is shorter than the execution's duration is blocked for timeout. A lane check and a run check with the same argv execute once (counter test), with independent evaluations under their differing timeouts.
3. **Browser checks are not shared.** Two lanes with the same browser argv run it twice, each in its own worktree. A lane with both kinds cites the record for its non-browser checks and passes recheck with exactly the two cwds.
4. **A failing shared lane check** blocks the first declaring lane only, and fix_decision repairs that lane, as today.
5. **Cache and retry.** A rerun of the same candidate attempt reuses the shared record. A new attempt (retry or repair) reruns it once. A tampered record (sha256) makes recheck fail.
6. **Policy 1.5.0.**
   - The schema and `validate_policy` accept `run_checks` only at 1.5.0 and refuse: a browser run check, a run check id equal to a lane check id, duplicate run argv, and `run_checks` at 1.4.0.
   - The keeps-everything test passes (every committed policy, example and fixture validates; the attack and critique rules accept 1.5.0).
   - `contract.test.ts` asserts the new enum and rules.
7. **Run checks run once on the candidate,** never in the worker phase, also on a one-lane run that reuses its worker packet (C28). That packet carries both `reused_from` and `shared_record`. On a pass every lane packet cites the record and passes. When the lane evaluations pass on a shared execution and the run check fails its own gate, attribution applies.
8. **Attribution:**
   - a. A run-check test failing only on lane B's snapshot blocks only B, with the §7.4 reason, and the fix loop starts a candidate repair on B.
   - b. A test also failing on the base is "pre-existing at base": every lane is blocked, and no repair starts.
   - c. A test that passes when rerun on the candidate is "did not reproduce": every lane is blocked, and no repair starts.
   - d. A test failing on no snapshot and owned by one lane by path goes to that lane, recorded as owner-attributed. A test file owned by no lane, or by several, makes the failure unattributed.
   - e. Two ids naming two lanes make the failure unattributed.
   - f. A test that does not exist on a snapshot counts as not applicable.
   - g. The blocked lane's repair brief includes the run check's failing log.
   - h. On a **one-lane** run, a base, did-not-reproduce or unattributed failure blocks the lane. An end-to-end test drives the retries to exhaustion and `controller_blocked`, and asserts that zero repair sessions were launched.
   - i. When no id parses, the whole run check reruns on the candidate, the base and each snapshot, one at a time. A memory-killed run check takes the transient path and gets no attribution reruns.
9. **`run_tests --tests`** runs exactly the named module, class and method ids. Its output parses with `text_test_counts`. An unknown id gives a failing class line. `--tests` with `start_dir` is refused.
10. **The failing-id parser** returns the ids of indented run_tests output and of plain unittest output, and `run_report.failures` lists them. For a class with passing and failing methods, it returns only the failing method ids, and attribution reruns only those. A crashed class returns its class id.
11. **Compatibility (§9).** A literal test pins the export key sets on a 1.5.0 fixture run, and asserts that no `packet.json` exists outside the lane paths. A citation test checks that every `reused_from` targets a worker packet and every `shared_record` targets a shared record, both on recheck.
12. **The lint note (§6.4)** appears for two lanes with the same argv and not for one lane.
13. The lane's own checks pass:
    - `/home/agentops/dev/md-manager/.venv/bin/python -m workflow.run_tests --jobs 4`
    - `npm run test:contracts`

## 12. Risks

- **A weaker gate.** A shared result must be the evidence each lane would have produced. §4 is the contract, and anything it does not cover runs per lane.
- **Flaky checks** get one run (the C28 review). Attribution's candidate rerun turns a non-reproducing failure into a stop-and-retry, not a repair.
- **Merge overlap** with review-panel-registry (`pipeline.py`, `automatic.py`, `RUNBOOK.md`, `contracts/workflow`, `README.md`). The logic goes into checks.py, verification.py, repair.py, run_tests.py, run_report.py and new modules. `candidate()` gets a thin hook, `automatic.py` is not touched, and new tests go into a new module.
- **Disk.** Attribution creates up to `lanes + 2` extra worktrees, each pruned on pass as today.
