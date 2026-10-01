# Handoff: review sidecar, lane `engine`

Run `review-sidecar-001`, lane `engine`, carried into runs `review-sidecar-002` and `review-sidecar-003` (see "Run 003" and "Run 002" below) (docs/PRD_REVIEW_SIDECAR.md sections 3, 4.1 to 4.7 and work items 1 to 6). Nothing is committed: the controller snapshots the worktree at freeze.

## Run 003

Run 003 starts from run 002's verified candidate: `git checkout 840787b6b88f36f47e568a480d6db753b6f2e07a -- workflow contracts/workflow docs/handoff/sidecar-engine.md` (tag `workflow/review-sidecar-002-candidate`). Run 003 adds one test and one fake-Herdr option, no change to any non-test file; everything under "Run 002" and "What shipped" still holds.

Run 002's coverage finding for this lane, closed by a test that fails without the behaviour it covers:

| Finding | Test (`workflow/test_sidecar.py`) | What it asserts |
| --- | --- | --- |
| 4. The delivery error path is tested for `TimeoutExpired` only | `Messages.test_each_error_in_the_gate_ends_undeliverable_with_its_own_reason_one_event_and_nothing_typed` | Four subtests, each one pass with one message to `ui` whose capture of both panes works (`pane_captured: true`) and whose gate then fails: the pane closed between capture and delivery (Herdr `CalledProcessError` on the gate's `process-info`) → `pane_unknown`; the pane closed after `process-info` (`CalledProcessError` on the gate's screen read) → `pane_unknown`; the gate's fresh `sessions.inventory()` raises `TransientInfraError` → `lane_blocked`, with no Herdr call after the two captures; Herdr raises a `RuntimeError` → `herdr_unavailable`. In each: the message is `undeliverable` with that reason, the pass `completed`, nothing typed (no `send-text`, no `send-keys`), the exact Herdr calls, exactly one new `interactive` event on `sidecar` (`... message M-n to ui undeliverable after an error (<ErrorType>); see sidecar-<n>.stderr.log`), the summary event counts `1 undeliverable`, the error type in the pass's stderr log, `<lane>.deadline.json` byte-identical, no `controller` event, the ledger valid. |

Test helper changed (test file only): `FakeHerdr.fail_after` maps a key to `(n, error)` so the first `n` matching calls succeed (the capture reads the pane, the gate's read is refused).

### Red, then green (run 003)

As in run 002, the behaviour exists in the restored candidate, so red is shown by mutating `workflow/sidecar.py` in scratch copies of the tree (the job's tmp directory, never this worktree) and running the new test there:

| Mutation | Result |
| --- | --- |
| `failure_reason()` returns `herdr_timeout` for every error (the finding's example) | FAIL, all four subtests: `('undeliverable', 'herdr_timeout') != ('undeliverable', 'pane_unknown')` (and `lane_blocked`, `herdr_unavailable`) |
| The `CalledProcessError` branch removed | FAIL, both pane-closed subtests: `herdr_unavailable != pane_unknown` |
| The `TransientInfraError` branch removed | FAIL, inventory subtest: `herdr_unavailable != lane_blocked` |
| The fallback returns `herdr_timeout` instead of `herdr_unavailable` | FAIL, Herdr-error subtest |
| `Pass.deliver()` catches only `ZeroDivisionError` (the error escapes to the pass) | FAIL, all four: the message stays `pending` |
| `Pass.deliver()` no longer writes the error event | FAIL, all four: `[] != ['Review sidecar pass n (manual): message M-n ...']` |

Green, in this worktree: `workflow.test_sidecar.Messages` (4 tests) OK; then the checks under "Checks run (run 003)".

### Checks run (run 003)

With `/home/agentops/dev/md-manager/.venv/bin/python`, from this worktree; `npm ci` first for `node_modules`.

- `python -m unittest workflow.test_sidecar workflow.test_export workflow.test_portable workflow.test_guardrails -v`: Ran 100 tests, OK (29 in `test_sidecar`).
- `npm run test:contracts`: 24 tests, 24 pass, 0 fail.
- `python -m workflow.run_tests` (once, at the end): Ran 416 tests (108 classes, 4 jobs), OK.

### Open assumptions (run 003)

- "The pane closed between the capture and the delivery" is simulated by Herdr refusing the gate's call for that pane (`CalledProcessError`, as `herdr` raises for a closed or unknown pane); a real closed pane's exact Herdr exit is not exercised.
- A `CalledProcessError` from `send-text` itself (the pane closing after the gate passed) maps through the same `failure_reason()` and is not a separate subtest: by then a partial typing cannot be ruled out, which the PRD does not address.

## Run 002

Run 002 starts from run 001's verified candidate: `git checkout 5e569c31e4a44ad7976c3d327dcf78dba7b7b083 -- workflow contracts/workflow docs/handoff/sidecar-engine.md` (tag `workflow/review-sidecar-001-candidate`). The restored tree is exactly that commit's for these paths; run 002 adds only tests, no change to any non-test file. Everything below "What shipped" is run 001's record and still holds.

The three coverage findings of run 001's `review.json` for this lane, each closed by a test that fails without the behaviour it covers:

| Finding | Test (`workflow/test_sidecar.py`) | What it asserts |
| --- | --- | --- |
| 1. No test holds `sidecar.lock` | `LedgerLock.test_the_merge_a_delivery_flip_recover_and_close_wait_for_sidecar_lock` | The test takes `<run>/sidecar.lock` (`flock`, its own open file) and runs, in a thread: a whole pass (`run_pass`) until its job has returned its output, then a delivery `flip()`, `recover()` with a running marker, and `close()` at freeze. While the lock is held each one is still running after 0.5 s and the ledger is byte-identical (and `recover` has not removed the marker); once released each finishes and writes the expected change (pass 1 `completed` with `M-1` `delivered`; `M-1` flipped; pass 2 `interrupted`; `closed_at` and the `succeeded` event). |
| 2. No controller interrupt while a pass runs | `SidecarGraph.test_a_controller_interrupt_while_a_pass_runs_terminates_its_process_group_and_writes_nothing_for_the_sidecar` | Through `drive()` and the real `wait_handoffs`, a cadence pass's job (which starts a child in its process group, then hangs) is running when the poll raises `KeyboardInterrupt`, and in a second subtest the resumable `TransientInfraError`. `drive()` re-raises it; the job and its child are both gone; the only `sidecar` event is pass 1's `running` start written before the interrupt (no `interactive`, no `succeeded`); the ledger file is byte-identical (no pass, no `closed_at`); the running marker stays for the next controller; the last event is `controller interrupted`; no `blocked`/`stopped` event and no `<lane>.stop.json`. |
| 3. No first-Herdr-timeout test | `Messages.test_the_first_herdr_timeout_of_a_pass_skips_every_later_herdr_call_of_that_pass` | Lane `ui`'s pane capture times out (`FakeHerdr.fail["read pane-ui"]`, a new per-pane key). The pass still completes; Herdr saw exactly one call (that read): lane `adapter`'s pane is not read, both lanes `pane_captured: false`, both `pane_file: null` in the manifest; the pass's message to `adapter` is `undeliverable`/`herdr_timeout` with no `process-info`, `read`, `send-text` or `send-keys`, and no error event. The next pass has its own budget: both panes read and its message typed. |

Test helpers changed for these (test file only): the fake job accepts a `child` step (a child process in its own process group, its pid written to a file), `FakeHerdr.fail` also accepts a `"<verb> <pane>"` key, and `kill_quietly` cleans up the child should the interrupt test fail.

### Red, then green (run 002)

The behaviour already exists in the restored candidate, so "red" is shown by mutating the covered behaviour in scratch copies of the tree (in the job's tmp directory, never in this worktree) and running the new test there:

| Mutation | Test | Result |
| --- | --- | --- |
| `ledger_lock` body replaced by a bare `yield` (every `with ledger_lock(...)` a no-op) | `LedgerLock` | FAIL: `the ledger write did not wait for sidecar.lock` |
| `drive()`'s `KeyboardInterrupt` branch calls `sidecar.close(runtime, "stopped")` | interrupt test | FAIL (KeyboardInterrupt): `['running', 'interactive', 'succeeded'] != ['running']` |
| `drive()`'s `TransientInfraError` branch writes a `sidecar` `interactive` event | interrupt test | FAIL (TransientInfraError): `['running', 'interactive'] != ['running']` |
| `Scheduler.abandon` drops the pass without stopping its job | interrupt test | FAIL (both subtests): `process <pid> of the pass survived the interrupt` |
| `Pass.stop` terminates the job's pid only, not its process group | interrupt test | FAIL (both subtests): the child in the group survived |
| `Herdr.call` no longer sets `timed_out` on a timeout | Herdr timeout test | FAIL: `('delivered', None) != ('undeliverable', 'herdr_timeout')` |

Green, in this worktree: the five tests (`LedgerLock`, `Messages`, the interrupt test) OK; then the checks under "Checks run (run 002)".

### Checks run (run 002)

With `/home/agentops/dev/md-manager/.venv/bin/python`, from this worktree; `npm ci` first for `node_modules`.

- `python -m unittest workflow.test_sidecar workflow.test_export workflow.test_portable workflow.test_guardrails -v`: Ran 99 tests, OK (28 in `test_sidecar`).
- `npm run test:contracts`: 24 tests, 24 pass, 0 fail.
- `python -m workflow.run_tests` (once, at the end): Ran 415 tests (108 classes, 4 jobs), OK, exit 0.

### Open assumptions (run 002)

- "Waits for the lock" is asserted as "still running 0.5 s after it reached its write, the ledger unchanged". Correct code passes deterministically (it cannot write until the test releases the lock); the mutation fails because the unlocked write finishes in milliseconds, so a pathologically slow machine could at worst hide a regression, never fail a correct tree.
- The interrupt test keeps run 001's choice that a controller interrupt leaves the running marker in place (recorded `interrupted` by the next controller's `recover`), which it asserts.

## What shipped

| Path | What |
| --- | --- |
| `workflow/sidecar.py` (new) | The whole sidecar: the 2.3.0 declaration (`declared`, `brief_path`), `plan.sidecar` (`pin`, `validate_plan`), the ledger (`initial_ledger`, `ledger_lock`, `save_ledger` with schema validation and the 4 MiB bound, the pure `merge`), the pass inputs (`write_inputs`, `safe_text`, the per-pass `Herdr` budget), the job's schema and prompt, the polled print job (`Pass`), gated delivery (`deliver_one`, `flip`), restart recovery (`recover`, `kill_orphan`), closing the node (`close`), the automatic `Scheduler` and `sidecar-pass` (`pass_main`). |
| `workflow/prompts/sidecar/senior-review.md` (new) | `features/review-sidecar/senior-review-brief.md`, byte-identical (`cmp` and a test check it). |
| `contracts/workflow/sidecar.schema.json` (new) | The ledger 1.0.0 with Appendix B's field rules, plus `$defs.output`. |
| `contracts/workflow/feature.schema.json` | 2.3.0 and `sidecar` (false or `{prompt, bounds}`); `sidecar`/`sidecar-` reserved in both id patterns. |
| `contracts/workflow/verification.schema.json`, `reviewCompletion.schema.json` | `sidecar`/`sidecar-` reserved in the lane id and attribution patterns (the contract test pins them equal). |
| `contracts/workflow/contract.test.ts` | 2.3.0 feature cases, the reserved names, and the Appendix B example validated verbatim with zod's reader of the schema, plus negative field-rule cases. |
| `contracts/workflow/README.md` | Feature 2.3.0, the ledger schema, the reserved names. |
| `workflow/sessions.py` | `sidecar` in `RESERVED_NODE_IDS`, `sidecar-` in `RESERVED_NODE_PREFIXES`. |
| `workflow/guardrails.py` | `is_guarded` accepts 2.2.0 and 2.3.0 (`GUARDED_VERSIONS`). |
| `workflow/launch.py` | `load_feature` checks `sidecar` first (refusals name `feature.json` and the key), the brief is resolved before any Git action, `prepare` gets `--sidecar-brief <path> --sidecar-settings <json>`, the dry run prints `sidecar` (only when declared), the registry entry carries the node; a schema error now names its JSON path `(at workers/0/node_id)`. |
| `workflow/pipeline.py` | `prepare --sidecar-brief/--sidecar-settings` (pins `plan.sidecar`, `feature_version` 2.3.0, writes the empty ledger), `Pipeline` validates `plan.sidecar`, `freeze` closes the node before stopping the workers. |
| `workflow/automatic.py` | `wait_handoffs` runs `sidecar.Scheduler` beside its poll (the loop moved unchanged into `_poll_handoffs` so a `finally` can stop a running job); `drive()`'s stop path closes the node `succeeded`. |
| `workflow/interactive.py` | `SIDECAR_NOTE`, the worker prompt paragraph, only when the plan has a sidecar. |
| `workflow/export_state.py` | Export 1.6.0 (docstring history), the `sidecar` section, the `sidecar` node in the definition. |
| `workflow/registry.py` | `registry_entry(..., sidecar=)`, `has_sidecar_node` so a merge keeps it. |
| `workflow/scaffold.py` | `init` writes 2.3.0; its README shows the optional `sidecar` key (no `TODO:` line added). |
| `workflow/__main__.py` | `python -m workflow sidecar-pass`. |
| `workflow/README.md`, `workflow/RUNBOOK.md` | "Review sidecar" sections (files, bounds, message rules, `sidecar-pass`, the manual final pass, recovery), versions, reserved names, command and file tables. |
| `workflow/test_sidecar.py` (new) | PRD section 6's engine scenarios (below). |
| `workflow/test_export.py`, `workflow/test_portable.py` | Export 1.6.0 with and without the section; the registry entry with the node and an existing entry gaining it; `init`'s 2.3.0 and README. |
| Version pins only | `test_guardrails.ExportSeam` (1.6.0, `sidecar` null), `test_export`, `test_lanes`, `test_pipeline` (export 1.6.0), `test_portable.InitScaffold` (init 2.3.0). No other existing test changed. |

## Scenarios and where they are tested (`workflow/test_sidecar.py`)

| Scenario | Test |
| --- | --- |
| declare | `Declare` (builtin and file briefs launch; 2.2.0, unknown builtin, empty and missing file, every bound, an unknown key, `true`, lanes `sidecar`/`sidecar-x` refused before Git with the key named; no sidecar or `sidecar: false` gives the 2.2.0 commands) |
| graph | `Graph` (plan keys, `plan["nodes"]` lanes only, node order and `handoff.depends_on`, registry entry equal, `challenge: false`, the 1.5.0 node list, `sidecar-pass` refused under the supervisor lock, `O_EXCL` marker) |
| pass-inputs | `PassInputs` (flags, `--add-dir`, cwd, manifest of both lanes, uncommitted, untracked and binary changes, the pane text stripped of escapes, `pane_file: null` without Herdr, `GIT_OPTIONAL_LOCKS=0` on every Git call, no `--binary`, eight inputs directories kept) |
| ledger-merge | `LedgerMerge` (S-1, open → fix_reported → verified_resolved with history; nine rejected outputs each leave the file byte-identical; refs resolved within an output; the merge is pure) |
| messages | `Messages` (delivered to working and idle lanes with the prefix and flattened text, then Enter; refused for a question, a completion, a second message in a pass, a lane not launched, the seventh message, after freeze; undeliverable for a blocked row, a permission dialog, a draft, a pane in its shell, a Herdr timeout, no Herdr, no pane; resolved ids for `S-1` plus a ref; `<lane>.deadline.json` byte-identical after every case) |
| seam | `Seam` (Appendix B verbatim; three hand-written outputs merged into Appendix B timestamps aside; a real pass whose output would cross 4 MiB is rejected `size` and the file stays byte-identical) |
| scheduling | `Scheduling` (fake clock: pass 1 at launch + cadence, nothing while a pass runs, a completion pass at once, `max_passes`, the final pass past it; timeout → `timed_out` then the next pass; the last completion interrupts a running pass and only the final pass runs; handoffs saved only after the final pass while a deadline still ends the wait and kills the job; one inventory and one pane read per message) |
| never-blocks | `NeverBlocks` and `SidecarGraph` (exit 1, raw output, another session id, malformed output, an interrupted `sidecar-pass`; Herdr `CalledProcessError` on capture, `TimeoutExpired` on typing, a Git error on the inputs, `TransientInfraError` from the job and an exception in the merge, each through a full automatic run to its verified branch with no `blocked` event and the workers stopped only by freeze; Ctrl-C between merge and delivery then a restart: `undeliverable`/`interrupted`, nothing typed; stale markers: a gone pid only recorded, the job holding the session id killed, another command left alone; a deadline while a pass runs: job killed, pass recorded `interrupted`, node closed `succeeded`; escalation event in fixed form and no model text in any event; node statuses only `running`, `interactive`, `succeeded`) |
| freeze | `Freeze`, `SidecarGraph` (closing event with counts, `no final pass`, closed once, `sidecar-pass` refused after freeze and without a sidecar, manual and `--final` passes, budget refusal), `ExportsAndPrompt` and `test_guardrails.ExportSeam` (1.6.0 with the ledger, null without) |
| worker-prompt | `ExportsAndPrompt.test_worker_prompt_holds_the_sidecar_paragraph_only_when_the_plan_has_a_sidecar` |

## Red, then green

Red: the new tests run against the pre-change tree (`git archive HEAD` into the job's tmp directory, plus only the new test files):

- `python -m unittest workflow.test_sidecar`: `ImportError: cannot import name 'sidecar' from 'workflow'` (1 error): the module does not exist.
- `test_export...test_export_1_6_0_...`: `ModuleNotFoundError: No module named 'workflow.sidecar'`; `test_portable.SidecarRegistry`: `ValidationError: Additional properties are not allowed ('sidecar' was unexpected)`; `test_portable.InitScaffold`: the README has no `sidecar` key (FAILED, failures=1, errors=2).
- `npx tsx --test contracts/workflow/contract.test.ts`: 3 of 11 fail (`sidecar` accepted as a lane id and a reviewer id; `sidecar.schema.json` missing).

Green: see "Checks run" below.

## Deviations from the PRD and choices it left open

1. **A rejected output is in no ledger.** PRD section 2 says a malformed pass "is recorded in the ledger", while 4.4 ("ledger unchanged"), section 6 ledger-merge and this task ("a rejected output leaves the file byte-identical") require the file unchanged. I kept the file byte-identical: a rejection is an `interactive` event (`... output rejected (<reason>); the ledger is unchanged, see sidecar-<n>.stderr.log`) and the reason and detail go to `sidecar-<n>.stderr.log`. The pass number is consumed (the next pass is `n+1`, so the ledger's `passes` can skip a number) and counts against `max_passes`. The schema keeps `rejected` in the pass status enum; this engine never writes it. **Viewer impact:** the passes table never shows a `rejected` row from this engine; a failed, timed-out or interrupted pass is in the ledger. Reasons: `schema`, `output_size`, `size`, `unknown_id`, `unknown_ref`, `unknown_lane`, `duplicate`, `transition`.
2. **Escalation shape.** Appendix B pins only the `kind` enum and an empty list; a stored escalation is `{pass, finding_id, kind, text, at}` (no id, `finding_id` resolved). Recorded in the schema's description.
3. **History.** Each upsert that changes a finding appends one entry, so open → fix_reported → verified_resolved holds three entries (section 6 mentions "a two-entry history"; I read it as after the first move). An upsert identical to the stored finding changes nothing and appends nothing.
4. **Pass `session_id`, `summary`.** Set only for a `completed` pass (Appendix B's timed-out pass is null); `failed` summaries are `failed: <ErrorType>: <text>`, `interrupted` ones `interrupted: <why>`, `timed_out` null.
5. **A Herdr `CalledProcessError` while capturing a pane fails the pass**, as section 6 lists it. Consequence: a pane closed for good makes every later pass fail until `terminals.json` no longer names it or Herdr is unavailable; the run is unaffected. A Herdr timeout instead skips the pass's remaining Herdr calls (no capture, messages `herdr_timeout`).
6. **`max_messages_per_lane` counts delivered messages** of the run; refused and undeliverable ones do not count.
7. **Typed text.** Besides newlines (and tabs) becoming spaces, escape and control bytes are dropped before typing; several cited findings are typed as `[Review sidecar S-1, S-2] `.
8. **Undeliverable reasons for errors in the gate:** `TimeoutExpired` → `herdr_timeout`, `CalledProcessError` → `pane_unknown`, `TransientInfraError` (the inventory) → `lane_blocked`, any other → `herdr_unavailable`; a row the inventory does not list → `lane_blocked`. The gate also re-checks the refusal rules right before typing (a pending message may become `refused`).
9. **Manifest `completion`** is `null` or `{status, accepted}` (the file's status, and whether the controller accepted it: deadline met or handoff saved).
10. **`handoff` of a non-final pass is ignored**, not a rejection.
11. **`ref`** must match `^new-[0-9]+$`; the `--json-schema` given to the CLI drops the `if/then` (ref required when id is null) and the merge enforces it (reason `schema`).
12. **Plan keys.** `feature_version` becomes `2.3.0` only for a plan with a sidecar: a 2.3.0 feature without one runs exactly the 2.2.0 commands and plan keys (`feature_version` `2.2.0`).
13. **Prepare writes the empty ledger**, and the export serves the empty ledger for a sidecar plan whose file is missing, so the viewer can show "no pass yet"; a ledger failing its schema is exported as `null`.
14. **`sidecar-pass`** exits 1 when its pass is not `completed`, refuses a second `--final`, refuses past `max_passes` except `--final`, and on Ctrl-C stops the job and records the pass `interrupted` (it is the operator's own command; the automatic controller's interrupt path records nothing).
15. **Final pass when the scheduler itself errs** while every lane is done: the error is recorded and freeze is not held for a final pass.
16. **Launch error text.** A `feature.json` schema error now ends with `(at <json path>)` so a refused lane id names its key; the existing message prefix is unchanged.

## Ledger example committed

`contracts/workflow/sidecar.schema.json` validates the PRD's Appendix B verbatim; the engine's test reads it from `docs/PRD_REVIEW_SIDECAR.md` and the contract test does the same, so no copy can drift. No field of Appendix B changed. Its text, as committed in the PRD:

```json
{
  "version": "1.0.0",
  "run_id": "review-sidecar-smoke-001",
  "settings": {"cadence_seconds": 900, "pass_timeout_seconds": 600, "max_passes": 16, "max_messages_per_lane": 6},
  "passes": [
    {"n": 1, "trigger": "cadence", "started_at": "2026-10-01T12:10:00Z", "finished_at": "2026-10-01T12:14:20Z", "status": "completed", "session_id": "0f2b3c6e-4a4d-4b8e-9d1a-6b2f1c0a9e11", "lanes": {"engine": {"head_commit": "a1b2c3d", "pane_captured": true}, "viewer": {"head_commit": "a1b2c3d", "pane_captured": true}}, "counts": {"new": 1, "changed": 0, "messages": 1}, "summary": "One P1 in the engine lane's merge; the viewer lane has no diff yet."},
    {"n": 2, "trigger": "completion", "started_at": "2026-10-01T12:40:00Z", "finished_at": "2026-10-01T12:50:00Z", "status": "timed_out", "session_id": null, "lanes": {"engine": {"head_commit": "b2c3d4e", "pane_captured": false}, "viewer": {"head_commit": "c3d4e5f", "pane_captured": true}}, "counts": {"new": 0, "changed": 0, "messages": 0}, "summary": null},
    {"n": 3, "trigger": "cadence", "started_at": "2026-10-01T13:00:00Z", "finished_at": "2026-10-01T13:05:00Z", "status": "completed", "session_id": "7c1d2e3f-5b6a-4c7d-8e9f-0a1b2c3d4e5f", "lanes": {"engine": {"head_commit": "b2c3d4e", "pane_captured": true}, "viewer": {"head_commit": "d4e5f6a", "pane_captured": true}}, "counts": {"new": 1, "changed": 1, "messages": 1}, "summary": "S-1 reported fixed in the engine pane; one P2 in the viewer's fixture seeding."}
  ],
  "findings": [
    {
      "id": "S-1", "category": "defect", "severity": "P1", "lane": "engine",
      "file": "workflow/sidecar.py", "locator": "merge_output", "revision": "b2c3d4e",
      "problem": "A rejected output still appends the pass to the ledger before validation, so a malformed output leaves a half-written pass.",
      "evidence": "pane: 'fixed S-1, validating before the write'",
      "remedy": "Validate first, then write the pass and the findings in one atomic replace.",
      "disposition": "fix_reported",
      "note": null,
      "messages": ["M-1"],
      "history": [
        {"pass": 1, "disposition": "open", "revision": "a1b2c3d", "evidence": "merge_output writes passes[] at line 88 and validates at line 102; test_sidecar has no case for it.", "note": null, "at": "2026-10-01T12:14:20Z"},
        {"pass": 3, "disposition": "fix_reported", "revision": "b2c3d4e", "evidence": "pane: 'fixed S-1, validating before the write'", "note": null, "at": "2026-10-01T13:05:00Z"}
      ]
    },
    {
      "id": "S-2", "category": "suggestion", "severity": "P2", "lane": "viewer",
      "file": "tests/project-workflows/fixtures/ux-sidecar.ts", "locator": "", "revision": "working-tree",
      "problem": "The seeded ledger's timestamps are written by hand and drift from the events the same fixture seeds.",
      "evidence": "",
      "remedy": "Derive the ledger times from the fixture's event times.",
      "disposition": "open",
      "note": null,
      "messages": ["M-2"],
      "history": [
        {"pass": 3, "disposition": "open", "revision": "working-tree", "evidence": "", "note": null, "at": "2026-10-01T13:05:00Z"}
      ]
    }
  ],
  "messages": [
    {"id": "M-1", "pass": 1, "lane": "engine", "finding_ids": ["S-1"], "text": "merge_output appends the pass before validating the output; a malformed output leaves a half-written ledger. Validate first and write once.", "status": "delivered", "reason": null, "at": "2026-10-01T12:14:21Z"},
    {"id": "M-2", "pass": 3, "lane": "viewer", "finding_ids": ["S-2"], "text": "The seeded ledger times in ux-sidecar.ts drift from the seeded events; derive one from the other.", "status": "refused", "reason": "question_waiting", "at": "2026-10-01T13:05:01Z"}
  ],
  "escalations": [],
  "handoff": null,
  "closed_at": null
}
```

## Checks run

All from this worktree, with `/home/agentops/dev/md-manager/.venv/bin/python` (the worktree has no `.venv`); `npm ci` was run first for `node_modules` (gitignored), as the policy's setup does.

- `python -m unittest workflow.test_sidecar workflow.test_export workflow.test_portable workflow.test_guardrails -v`: Ran 96 tests, OK (25 in `test_sidecar`).
- `npm run test:contracts`: 24 tests, 24 pass, 0 fail.
- `python -m workflow.run_tests` (once, at the end): Ran 412 tests (107 classes, 4 jobs), OK.
- `python -m workflow launch viewer-ux-depth --repo . --dry-run --automatic` and the same for `workflow-guardrails`: stdout and stderr byte-identical before and after the change (`cmp`); `viewer-ux-depth` is refused before and after for its missing `decisions.md`, `workflow-guardrails` (2.2.0) prints the same commands, graph and registry entry.
- A scratch copy of this feature at 2.3.0 with `"sidecar": {"prompt": "builtin:senior-review", "cadence_seconds": 120}`: `launch --dry-run` prints `sidecar` (`cadence_seconds` 120, the other defaults, the bundled brief's path), the prepare command carries `--sidecar-brief` and `--sidecar-settings`, and the registry entry's nodes start `challenge, sidecar, launch_engine, launch_viewer`.

## Not covered by an executed check

- A live run: real `claude --print` structured output against this `--json-schema` (the fake job does not validate the schema the CLI receives), real Herdr panes and a real permission dialog's screen. PRD section 8's live smoke is the operator's, after integration.
- The viewer's parse of the engine's ledger (the seam is the shared Appendix B example and the schema).
