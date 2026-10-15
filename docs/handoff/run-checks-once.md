# Handoff: run each verification check once

On the combined candidate each distinct non-browser check command now runs once, in one shared verification worktree, and every lane that declares it cites that one result. Policy 1.5.0 adds `run_checks`: checks that run once per candidate attempt and never per lane. When a run check fails, only its failing tests are rerun on the candidate, the base and each lane snapshot, so the failure blocks exactly one lane for the fix loop, or blocks every lane with no repair. `python -m workflow.run_tests --tests <ids>` runs a subset. Specification: `features/run-checks-once/prd.md`; decisions: `features/run-checks-once/decisions.md`.

## What changed, file by file

- **New module `workflow/shared_checks.py`**:
  - `planned` (the execution order of PRD 4) and `run_shared` (the shared worktree, setup once, each argv once at the largest timeout, `git status` after each execution, `record.json`);
  - `cited_record` and `gate_run_checks` (what `recheck_packet` does with a citing packet). `cited_record` checks every run check's log in the record against its `log_sha256`, for every citing packet, the reused C28 one too, because a run check's log belongs to no lane ([L6]);
  - `run_check_gates`, the attribution (`runner`, `rerun_argv`, `rerun`, `statuses`, `attribute_check`, `decide`). `statuses` reads the loader's errors (`loader_errors`): an id is *not applicable* only when the error says it is absent (`absent`: no module of a dotted prefix, no attribute of a part); a module that fails to import has failed;
  - an interrupted rerun passes no id ([L7]). After a timeout (exit 124) or a kill, each id without a failure header is `not run`, and so is the whole-check form's one id. A rerun whose setup fails or times out runs no id: every selected id is `not run` there, never `failed`, and the rerun cites `setup-<i>.log` (`setup_failed`, `setup_exit_code`). An id `not run` on the candidate, the base or a lane snapshot gets the outcome class `not run`: it is unattributed, no later target reruns it, and the reason names it (`not run (a rerun timed out, was killed or its setup failed): <ids>`). It never reaches the snapshot or owner rule (challenge note 1 of run 002: a test hanging at base must not be owner-attributed). This departs from [L7]'s words "count as not applicable for the lane choice": an id `not run` on one lane snapshot makes the check unattributed rather than being skipped for that lane;
  - `gate_run_checks` keeps a memory-killed run check transient only when no other run check failed for real; beside a real failure the real one is attributed and the kill only listed, as `repair.transient_packet` reads lane checks;
  - `slow_run_checks`: the lane checks' slow note (C27) for run checks, on a `candidate` event `Run checks on <commit>; slow: ...`. The hook emits it right after the shared execution, so a lane blocked on its own checks still gets it, once ([L5]);
  - `import_root` ([L14]): a plain `unittest discover` run check names its ids from its import root (`-t`/`--top-level-directory` or the third positional, else `-s`/`--start-directory` or the first positional, else `.`, read as unittest's own parser reads `-stests` and `--start-directory=tests`; an absolute or escaping root is `.`). Each `rerun` puts `<worktree>/<root>` first on PYTHONPATH (existing entries after it) and records `import_root` in its entry, `test_file` resolves the id's file under the root (so the owner fallback of [G3] finds it), and the brief's rerun line is `PYTHONPATH=<root> <command>`, run from the worktree root. Before this, `discover -s tests` ids were `not applicable` on every rerun and every lane was blocked unattributed (run 003 triage C). Unlike discover's own `sys.path` entry, PYTHONPATH reaches the processes a test starts too;
  - `SharedCandidate`, the candidate step's hook: lockstep, the shared execution, its event and the slow note, then `finish` once every lane's own checks passed;
  - `brief_lines` (the repair brief of an attributed run check), and the folder helpers `clean` uses.
- **`workflow/checks.py`**:
  - `check_env` takes the environment out of `verify_revision`, unchanged, so the shared execution and every attribution rerun use the same one;
  - `verify_revision(..., shared=)`, `run_lane_commands(..., shared=)` and `cite_execution` copy a cited execution, its log (`check-<i>.log`), counts and errors into the lane's packet. Only a lane with a browser check gets its own worktree, and its setup log is `setup-<i>-browser.log`. When that setup fails no check runs: `cited_record` admits the packet without receipts and `evaluate_worker` blocks it, so the packet is saved;
  - `recheck_packet(..., run_checks=)` follows `shared_record`. On a policy with run checks it refuses a candidate packet that cites no record, regular or reused (C28), so the bundle refuses it too ([L6]). Worker packets cite nothing and stay valid. `cited=False` is passed only by `recheck_reused`'s inner gate of the worker packet (challenge note 2 of run 002);
  - `reuse_packet(..., shared=)` adds `shared_record` beside `reused_from` (C28 on 1.5.0).
- **`workflow/verification.py`**:
  - `evaluate_worker(..., shared_cwd=)`: a citing packet's non-browser checks ran in the record's worktree and its browser checks in its own. An uncited packet keeps the single-cwd rule;
  - `validate_policy`: the 1.5.0 run-check rules;
  - `policy_lint`: note (d), a command two lanes declare.
- **`contracts/workflow/verification.schema.json`**: version `1.5.0`, `run_checks`, the run-checks rule, and the attack and critique rules widened to sets. `contract.test.ts` changes three assertions that the widened rules would fail, and has one new `test` block at the end of the file ([L3]).
- **`workflow/pipeline.py`**: four lines added and two changed in `candidate()`. A comment and the import, then `SharedCandidate(...)` runs before the lanes, `shared=shared.reference` is passed to `verify_revision` and `reuse_packet`, and `shared.finish()` runs before the bundle.
- **`workflow/repair.py`**:
  - `unattributed_block`, the predicate of [L1];
  - `attempt_targets` gives every lane the same candidate floor under lockstep (challenge note 1);
  - `attempt_limit` counts a candidate attempt any lane lost to a memory kill for every lane under lockstep;
  - `packet_evidence` and `failing_checks` include the copied `run-check-<i>.log` and `brief_lines`.
- **`workflow/automatic.py`**: one narrow edit ([L1]). `fix_decision` imports `unattributed_block` and returns None when the single blocked candidate packet carries the unattributed marker. That is two lines: the import, and the existing `len(found) != 1` condition.
- **`workflow/run_tests.py`**: `--tests ID [ID ...]`, with the same output format. An unknown id gives `FAIL <id> (0 tests)` and `    WORKFLOW: no test named <id>: <why>`. `--tests` with `start_dir` is refused.
- **`workflow/run_report.py`**: `failing_ids`, the failing-test parser. It returns method ids, and a class id only for a class with no method-level failure line. A module plain unittest failed to import comes back by its name, never as the loader's `unittest.loader._FailedTest.<name>` pseudo-id. `failures` also reads run_tests' indented headers.
- **`workflow/clean.py`**: a passed shared attempt's worktree and caches are pruned, and a failed one is kept whole. Passed means every declaring check's gate passed on each execution (`execution_passed`: exit 0, clean tree, each declarer's own timeout, test counts for a test kind), not the exit code alone. Each failed run check's reruns sit under `attribution/<policy index>/<target>/`. A leftover attribution worktree is pruned. Records, attributions and logs are never removed.
- **Tests**:
  - `workflow/test_run_checks.py` is new: 61 tests, named in the completion's Proof table;
  - existing tests changed only where lockstep, the new event, the shared worktree or the new lint note changes what they pin:
    - `test_lanes.py` (2 assertions), `test_repair.py` (4) and `test_portable.py` (1);
    - `test_pipeline.py` (a mock's signature and one event expectation, plus the two isolation lines of the merge note below);
    - `test_guardrails.py` (one fixture line: the adapter lane's argv gets its own last argument, so the guarded fixture no longer shares a command and draws the launch note).
  - `workflow/test_env.py` is new, and `test_browser_rules.py` and `test_critique.py` gain a module-level browser queue (merge note below).
- **Docs**:
  - RUNBOOK: §4, "Verification policy and evidence", "What triggers a round", the retry bullet and "Files in a run directory";
  - README: Setup, Files, and `run_tests --tests`;
  - `contracts/workflow/README.md`: policy 1.5.0.

**Overlap with review-panel-registry-002, feature-wide.** Of the files `git diff --stat 44b9c24 -- workflow contracts/workflow docs/handoff/run-checks-once.md` lists, six are on that run's list of changed files, and a hand merge takes both sides of each:

- `contracts/workflow/contract.test.ts` (three changed assertions and one new block at the end);
- `workflow/README.md` (Setup, Files and `run_tests --tests`);
- `workflow/RUNBOOK.md` (the sections above);
- `workflow/automatic.py` (the two lines of [L1]);
- `workflow/pipeline.py` (the `candidate()` lines above);
- `workflow/test_pipeline.py` (the mock's signature, the event expectation and the two isolation lines).

`launch.py`, `lane_review.py`, `guardrails.py`, `test_automatic.py` and `test_export.py` are not changed here. `test_guardrails.py` is not on that run's list.

## Differences on policies 1.0.0-1.4.0 ([L2], [L3])

Candidate dedupe benefits every policy at once: the first controller run after the fast-forward shares the candidate's commands. What else differs:

- **Lockstep retries** ([L2]). On a run whose candidate step wrote a shared record, `retry --phase candidate --node b` also re-verifies lane a at the same new attempt, against one new record. A repair gives every lane the same candidate floor. This is the only retry-target difference (pinned by `test_retrying_one_lane_reverifies_the_other_at_the_same_attempt_on_1_4_0`).
- **Mixed timeouts** ([L3], E7). Two lanes with one argv and different timeouts share one execution at the larger timeout. The shorter-timeout lane is then blocked with `<id>: execution exceeded approved timeout` only. Run alone, it would have been killed at its own timeout and blocked with `Executed check failed: ...`, `<id>: no passing test evidence or failed tests` and `<id>: exit 124` too.
- **Setup runs once** in the shared worktree. A lane with a browser check runs it again in its own worktree.
- **TMPDIR** ([L3]). It is one private `lane_tmpdir()` per shared attempt, outside the run (Unix socket paths), stored in the record as packets store theirs. It is not inside the shared attempt folder.
- **Ignored outputs are shared** ([L3]). Ignored outputs of an earlier shared command (a build's `dist/`, a cache) are visible to the later ones in the same worktree, as they always were within one lane's worktree. Between lanes they are now visible too.
- **Dirty-tree blame** (challenge note 2). A check that changes a tracked file blocks the lanes that declared it and every later execution. The first lane in declared order is no longer blamed.
- **A command that cannot start** (a missing executable) ends the shared execution, as it ended a lane's own attempt. The record keeps the executions before it and names it in `launch_error`. An earlier lane's failure still blocks that lane and enters its repair; the first lane whose command never ran, or the run checks, stop the step without a verdict (`checks.verify_revision`, `SharedCandidate.finish`), and the attempt is kept whole.
- **One extra event** on node `candidate`: `Shared checks: <k> commands for <m> lane checks on <commit>`. On 1.5.0 a slow run check adds `Run checks on <commit>; slow: ...` there.

Worker-phase load does not drop yet. Lane checks still run on every lane snapshot. Load only drops once a policy moves the full suite into `run_checks` and gives its lanes targeted checks (Deferred: /cook's feature-rules).

## How a policy author moves the full suite into `run_checks`

At 1.5.0 each lane keeps a targeted check of its own kind, which its `required_check_kinds` still needs. The full suite runs once, on the candidate:

```json
{
  "version": "1.5.0",
  "feature": "An example with two Python lanes",
  "independent_review": true,
  "integration_approval": true,
  "max_verification_attempts": 3,
  "setup": [{"argv": ["npm", "ci"], "timeout_seconds": 600}],
  "workers": [
    {"node_id": "engine", "role": "backend", "required_check_kinds": ["unit"], "owned_paths": ["workflow/engine.py", "workflow/test_engine.py"],
     "checks": [{"id": "engine-unit", "kind": "unit", "argv": [".venv/bin/python", "-m", "workflow.run_tests", "--tests", "workflow.test_engine"],
                 "timeout_seconds": 600, "scenarios": []}]},
    {"node_id": "export", "role": "backend", "required_check_kinds": ["unit"], "owned_paths": ["workflow/export_state.py", "workflow/test_export.py"],
     "checks": [{"id": "export-unit", "kind": "unit", "argv": [".venv/bin/python", "-m", "workflow.run_tests", "--tests", "workflow.test_export"],
                 "timeout_seconds": 600, "scenarios": []}]}
  ],
  "run_checks": [
    {"id": "workflow-unit", "kind": "unit", "argv": [".venv/bin/python", "-m", "workflow.run_tests", "--jobs", "4"], "timeout_seconds": 1800, "scenarios": []},
    {"id": "workflow-contract", "kind": "contract", "argv": ["npm", "run", "test:contracts"], "timeout_seconds": 180, "scenarios": []}
  ]
}
```

Rules: a run check is never `browser`, has no scenarios, and has an id no lane check has. Run checks never satisfy a lane's required kinds. `launch` prints a note for every command two lanes declare. Attribution parses failing ids from `workflow.run_tests` and `python -m unittest` output. Any other runner's run check is rerun whole, once per target ([G4]).

## Known limit: browser lanes and cited build outputs ([L8])

A browser lane's own candidate worktree runs only its own `setup`, then its browser checks. Its non-browser checks ran in the shared worktree, so their ignored outputs (a build's `dist/`, a generated file) are not in the browser lane's worktree. Before this feature they were, because the lane ran its build in the same worktree before its browser check. A policy whose browser check needs such an output lists the build in the policy's `setup`, which the browser lane's worktree also runs. No committed md-manager policy needs it today. This is not fixed, and no test pins it (Deferred).

## Cost of attribution (challenge note 5)

A failed run check costs at most `lanes + 2` serial reruns, each in a fresh worktree with setup and capped at the run check's timeout. The reruns are short-circuited:

- nothing reproducing on the candidate: no further rerun;
- every reproduced id failing at base: no lane rerun;
- a commit that two targets share runs once;
- an id a rerun never reached (`not run`) is not rerun on a later target, a later lane snapshot included.

Reasons name ids and outcome classes only, never paths or attempts. So a deterministic base failure stops at `check_retries`' identical-failure rule after attempt 2 (challenge note 4).

## Merge note since 8eb67b6 (runs 003 and 004: [L10]-[L14])

Measured after the last code change with `git diff --stat 8eb67b6 -- workflow contracts/workflow docs/handoff/run-checks-once.md`: 9 files. Run 003 isolated the browser queue in the workflow suite ([L10]-[L13]); run 004 kept repair-1 ([L14]: a command that cannot start) and fixed discovery attribution ([L14]). Each file and the lines it adds:

- `workflow/test_env.py` (new, 87 lines added): `isolate_browser_queue(directory)` sets `MD_MANAGER_BROWSER_QUEUE` to `<directory>/browser-queue`. The caller owns the directory and the patch of `os.environ` that restores it. Its proof tests are `BrowserQueueIsolation`.
- `workflow/test_pipeline.py` (2 lines added). **Overlap 1 with review-panel-registry-002**, inside `isolate_registry()` and its imports. A hand merge keeps both lines:
  - `from .test_env import isolate_browser_queue`, after the `from .sessions import ...` line;
  - `    isolate_browser_queue(temp.name)  # Browser checks take this module's own queue, never the operator's (test_env).`, right after `environment.start()` in `isolate_registry()`.
- `workflow/RUNBOOK.md` (2 lines added, 2 removed: two long bullets of "Verification policy and evidence" each gain sentences). **Overlap 2 with review-panel-registry-002.** A hand merge keeps both sentences:
  - in the bullet **Each check runs once on the candidate**, after "Ignored outputs ... visible to later ones": the repair-1 sentence beginning "A command that cannot start (a missing executable) ends the shared execution";
  - in the bullet **Run checks**, after "a module that fails to import has failed.": the import-root sentences beginning "A plain `unittest discover` run check names its ids from its import root" and ending "the variable also reaches the processes a test starts."
- `workflow/checks.py` (4 lines added, 1 changed; repair-1): `verify_revision` imports `launch_failed` and, before the lane's folder exists, raises without a verdict when one of the lane's non-browser argvs never ran because an earlier shared command could not start.
- `workflow/shared_checks.py` (72 lines added, 14 removed):
  - repair-1: `run_shared` catches a command that cannot start (`launch_error` on the record, nothing later runs), `launch_failed`, `SharedCandidate.finish` stops without a verdict when a run check never ran, `passed_record` is false on `launch_error`, and the module docstring says so;
  - discovery attribution: `import_root`, the PYTHONPATH entry and `import_root` field in `rerun`, the `root` argument of `test_file`, and the brief's `PYTHONPATH=<root>` rerun line.
- `workflow/test_run_checks.py` (96 lines added, 1 changed: the `shared_checks` import line): `SharedExecution::test_a_later_command_that_cannot_start_keeps_an_earlier_lanes_failure_and_its_repair`, `SharedExecution::test_a_command_that_cannot_start_after_passing_lanes_stops_the_step_without_a_verdict`, `Attribution::test_a_discover_run_check_reruns_its_ids_from_its_start_directory_and_attributes_the_lane` and `ImportRoot::test_the_import_root_of_a_discover_run_check_reads_unittests_own_forms`.
- `workflow/test_browser_rules.py` (15 lines added, 1 changed): the import line becomes `from contextlib import ExitStack, redirect_stderr, redirect_stdout`. It adds `from unittest.mock import patch`, `from .test_env import isolate_browser_queue`, `MODULE = ExitStack()`, and a `setUpModule` (a temporary directory, `patch.dict(os.environ)`, then the helper) with its `tearDownModule` (`MODULE.close()`).
- `workflow/test_critique.py` (15 lines added): `import contextlib`, `from .test_env import isolate_browser_queue`, `MODULE = contextlib.ExitStack()`, and the same `setUpModule`/`tearDownModule` pair. The two slot tests that set their own queue keep it.
- `docs/handoff/run-checks-once.md`: this merge-note section, the `import_root` bullet, the feature-wide overlap list and the Deferred items of run 004.

`browser_queue.py`, `workflow/README.md`, the policy and feature.json are not changed since 8eb67b6.

## What is left (decisions.md Deferred)

- Showing run-level checks and the shared record in the viewer. That is a later Sonnet follow-up after review-panel-registry lands, owned by `server/` and `src/`.
- Teaching /cook's feature-rules to write `run_checks` and targeted lane checks. That is outside this repository, and it starts once ctl runs policy 1.5.0.
- Attributing a failing *shared lane check* (not a run check) to the lane that caused it. It keeps the first-declaring-lane rule.
- A machine-wide slot for heavy Python suites, like the browser queue.
- The browser-lane build-output limit above ([L8]).
- Triage backlog from run 001 that was not carried: K and L (beyond [L4]'s tests), and M (a viewer change, under the first item).
- **Known limit, not fixed: no clean-tree or HEAD check in an attribution rerun** (run 003 triage D, [L14]). `rerun()` checks neither that its worktree is clean nor that HEAD is still the commit after setup and execution, unlike `run_shared`. A rerun whose tree is dirtied is not detected as such; as [L14] records it, such a rerun fails closed as unattributed, blocking every lane without a repair. No test pins it.
- P2 backlog of run 003, not carried ([L14]): F (the `setUpModule` isolation is untested), G (the held-queue proof is self-reported), H (per module versus per test wording), I (the proof tests live in `test_env.py`), and LR1-2 (an empty record passes `passed_record`).
