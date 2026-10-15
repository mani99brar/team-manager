# Handoff: ux-critique-fixes-d, lane `backend`

Base: c482e3a (main ca5e2bb plus the feature files). Every item D22-D31 is done. Each proof below names the tests that fail
on the base code and pass with the change. The red run was taken by reverting only the production files of that item
(`git checkout` of those files, then the named tests, then the patch re-applied). The green run is the full lane check set
listed at the end.

## D23 "Relaunch by the operator" is an action row

- Changed: `contracts/projects/triage.ts` (`ACTION_ROW` gains `Relaunch`); `tests/unit/triage.test.ts`.
- Proof: `tests/unit/triage.test.ts::reads a relaunch by the operator as a log row: no controller block, no blocked-before-freeze, no new-run launch`.
  - Red: the marker was `['controller_blocked', true]`.
  - Green: 97/97 triage tests pass, so every existing triage case is unchanged.

## D24 "Panes not attached" is a launch note

- Changed: `contracts/projects/triage.ts` (`PANES_NOT_ATTACHED = /^Panes not attached \(/`, added to `RUNNING_ROWS` and `CONTROLLER_LANE_ROWS`). The text matches `workflow/pipeline.py` `attach_after_launch`.
- Proof: `tests/unit/triage.test.ts::reads panes not attached as a launch note; a later lane launch failure is quoted, not the note`.
  - Red: on the base, the note was a controller block. The run read `blocked_before_freeze`, and both the headline and the reason quoted the note.
  - Green: no marker. The later `launch_game` failure is quoted in the headline. The reason source is the lane's own row (4). No controller row is left, so `reason` itself is null in `unmatchedNow`.

## D22 per-run list errors (server half)

- Served shape, exactly PRD 5.1: `errors?: [{ run_id: string (min 1), code: string (min 1), message: string }]`, with `.min(1)`, `z.strictObject` entries, and the key optional. Sent only when there is no cursor and at least one run cannot be read. Otherwise the key is absent.
- Variant: `RunStore.listRunEntries(scope, { collectErrors: true })` returns `{ entries, errors }` (overloads, in `server/projects.ts`). Without the option, `listRuns`/`listRunEntries` still throw for the whole workflow. That covers the home route, All time and the spend figure, none of which changed.
- What is caught, per run:
  - a `ProjectApiError` from `projectRun`;
  - the duplicate-id throw (`invalidRun(<dir>, 'duplicate run ID within the workflow')`).
  - The entry is `{ run_id: <directory name>, code, message: redactPaths(message) }`.
- What still fails the whole list:
  - a missing or unusable runs root (503);
  - an oversized `run-state.json` (`FILE_TOO_LARGE`, read before `projectRun`, outside the two catch sites of PRD 7). `projects.test.ts` "unavailable or symlinked run roots…" is unchanged.
- Skips and cache: the legacy and just-launched skips stay skips. An invalid run is never cached.
- Route: `server/projectRoutes.ts` uses the variant. `compareRuns`, paging and the cursor are unchanged.
- Contract:
  - `contracts/projects/v1.ts` (`runList`; the docblock names the stage D additions).
  - `runList.schema.json`, regenerated; the diff only adds `errors`.
  - The `runListWithErrors` example.
  - `contract.test.ts::run list errors: the first page names each unreadable run; the key is optional and its entries are closed`.
  - `contracts/projects/README.md` ("Stage D additions").
- Note: `server/dispatchSteps.ts`'s docblock now names the variant.
- Proof (`server/projects.test.ts`):
  - `one unreadable run no longer fails its workflow's list: the readable runs are served and the first page names it in errors` covers: a copied run with a mismatched `run_id` among valid runs; a cursor page without `errors`; a clean workflow with no key; an all-unreadable workflow (no rows, one entry each); the runs root still a 503.
  - `a duplicate run id is served once and named once in errors; a projection error is redacted; the other readers still fail the workflow`. `projectRun` is overridden on the store instance. It covers: one `dup-a` row; one entry for directory `dup-b`; a projection error message with a home path served as `<path>`; cold and warm reads; `listRuns` and `listRunEntries` still rejecting.
  - Red: all of these, and the two rewritten tests below, fail on the base.
- Existing assertions moved to the new rule (D22 requires it; each is equal or stricter):
  - `malformed or contradictory run storage …` and `malformed or contradictory review and inputs sections …`: their list half went from "500 naming the run" to "200, no row for it, exactly one `errors` entry naming it, code `RUN_STORAGE_INVALID`, no path" (`assertListNames`). The detail route keeps its 500 assertions.
  - `server/dispatch.test.ts` `perWorkflowAssembly`: a first page carrying `errors` maps to the workflow error the home route keeps serving (status 500, `errors[0]`'s code and message). The home route's equality with the per-workflow assembly holds for all three cutoffs. The same test now also asserts that the per-workflow route lists `bad-001` and names `bad-002`.
  - The home route's `unreadable` (`registry pages …`) and spend (`overview spend …`) tests are unchanged and green.
- For the `ui` lane: `/api/dispatch/runs` (home) still reports such a workflow as unreadable (`error`), while `/api/projects/:p/workflows/:w/runs` lists its readable runs plus `errors`. After integration, the take-off of the `errors` key in `src/projects/api.ts` before the strict parse becomes a no-op (a later tidy-up).

## D25 archived launch sessions stay listed

- Changed: `server/sessions.ts` `workerRows`. For each lane it reads every `<lane>.launch-<n>.receipt.json` (n ascending, numeric, only the files listed) with `interactiveSchema`, which now also reads `status`. It emits one ended row per archive before the current row:
  - key `worker:<lane>:launch-<n>` and label `Worker · <lane> (launch <n>)`;
  - the lane's launch node;
  - the archive's session id, model, start and resume line;
  - status from the archived receipt: `needs_reconciliation`/`launching` give `failed`, `attached_session_available` gives `stopped`, anything else `unknown`.
  - An archive that does not parse is skipped. The Sessions contract is unchanged; no field was added.
- Ordering: the payload still orders every row by start time (`sortByStart`). A relaunch archive starts before the new launch, so A comes before B.
- Frozen client: no frozen `src/` code looks up the first worker row of a lane. `sessions/model.ts` `sessionsForNode` lists every row on the launch node (archive first, round null), and the Sessions list groups by role. So the run page shows two worker sessions. Not covered by a browser check in this lane; the `ui` successor may want a scenario for it.
- Proof: `server/sessions.test.ts::sessions: a relaunched lane keeps its archived launch sessions, ended, before its current one`. The test uses lane `server`, because the shared seed declares `server`/`viewer`, not `ui`. It covers: A (archive) then B (current); numeric order; an unparsable archive skipped; and a body identical to the one before the archive once the archives are removed.
  - Red: fails on the base.

## D26 `enter_not_submitted`

- Changed:
  - `contracts/workflow/sidecar.schema.json` (message `reason` enum);
  - `contracts/projects/v1.ts` `SIDECAR_MESSAGE_REASONS`, plus the regenerated `sidecarLedger.schema.json`;
  - `src/projects/node/sidecar.ts` `REASON_WORDING.enter_not_submitted = 'Enter did not submit it; the text is still in the input line'`;
  - `workflow/sidecar.py`: the typed-but-unsubmitted branch returns `("undeliverable", "enter_not_submitted")`. The attention record and `on_unsubmitted` stay. `pane_busy` stays for an input line that is busy before typing. The module and `deliver_text` docstrings are updated.
- Other `pane_busy` readers keep their meaning: `guardrails.py:1662` is a docstring count, and the other `test_sidecar.py` cases are drafts found before typing.
- Proof:
  - `workflow/test_sidecar.py::Messages::test_a_text_two_enters_left_in_the_input_is_undeliverable_with_a_pane_record`: its expected reason is now `enter_not_submitted`; it validates the ledger against `sidecar.schema.json` and checks the pane attention record.
  - `Notes::test_a_note_two_enters_left_in_the_input_is_recorded_enter_not_submitted_with_a_pane_record`.
  - `pane_busy` before typing: `test_messages_are_typed_only_through_the_gate_…`, unchanged.
  - `tests/unit/sidecar.test.ts::message statuses with their reasons, in words` (new wording).
  - Red: both workflow tests fail on the base.

## D27 `workflow note` says the text is still in the input line

- Changed: `workflow/notes.py` `note_main`. A note recorded `enter_not_submitted` exits 1 with: `Blocked: note <id> to <lane> was typed but Enter did not submit it; the text is still in <lane>'s input line. Submit or clear it in the pane; do not send it again.` Not-typed and refused notes keep today's text byte for byte. The module docstring is updated.
- Proof: `workflow/test_sidecar.py::Notes::test_the_note_command_records_and_types_it_and_exits_1_when_it_was_not_typed`. It now asserts:
  - the full not-typed (`pane_busy`) message, byte for byte;
  - the new message, with "still in" and "Submit or clear it in the pane; do not send it again.", and without "was not typed" or "Look at the pane, then send it again as a new note.";
  - the refused (`question_waiting`) message, byte for byte.
  - Red: fails on the base.
- Docs:
  - `workflow/README.md` `note` row: "a note typed but left in the input line by both Enters is recorded `enter_not_submitted` and exits 1 saying the text is still there, to submit or clear in the pane, never to send again".
  - RUNBOOK "Who acted: --by and notes": "A note that was typed but that two Enters left in the input line is recorded `undeliverable`/`enter_not_submitted` and `note` exits 1 saying the text is still in the lane's input line: submit or clear it in the pane, and do not send it again."
  - RUNBOOK "Review sidecar" (Messages) now names `enter_not_submitted` instead of "`pane_busy` (the closed enum's nearest value)".
  - README Messages paragraph: one sentence.

## D28 a disk-killed check records `transient: 'disk'`

- Changed:
  - `contracts/workflow/v1.ts` (`z.enum(['memory', 'disk']).optional()`), plus the regenerated `workerResult.schema.json`.
  - `workflow/checks.py`: `disk_killed` reuses `repair.disk_full_text` and `DISK_TAIL_LINES` through a lazy import; nothing is copied. `transient_kind` gives memory first, then disk. `TRANSIENT_KINDS`. `transient_checks` includes `memory` and `disk`, in both phases; the candidate re-derivation calls the same function.
  - `workflow/repair.py`: `transient_packet(path, kinds=("memory",))`, `disk_packet` and `transient_attempt` (details below). The `:90` comment is corrected.
- How repair reads the recorded kind:
  - `transient_packet` reads each listed check's recorded kind. A listed check with no kind counts as memory, the only kind recorded before.
  - `disk_packet` accepts a packet whose checks are recorded `disk` first, then keeps the log fallback for older packets and setup failures.
  - `transient_attempt` accepts memory and disk together.
  - Departure in shape, not behaviour: `automatic.advance_failed_checks` reads `transient_packet` as "memory kill → `wait_for_memory`". If `transient_packet` took `disk` too, a disk kill would wait on memory. So the default stays memory, and disk is read through `disk_packet`, which waits on the disk.
- Not handled: an attempt whose gate reasons are one memory-killed check and one disk-killed check is `transient_attempt` (free, never identical). But `advance_failed_checks` then waits on neither floor: memory-only `transient_packet` is false, and so is `disk_packet`. It is rare and is not tested; it is left as it is.
- Proof:
  - `workflow/test_checks.py::MemoryKilledCheckTests::test_a_log_that_ends_with_a_full_disk_records_disk`: `disk`, `transient_checks`, the packet valid against `workerResult.schema.json`, memory precedence, and the tail window.
  - `workflow/test_repair.py::DiskFullAttempts::test_a_check_recorded_disk_is_a_full_disk_read_from_its_packet`: transient, rerun free three times, waits on the disk and not on memory, no repair round, a real failure beside it is real, an older packet with the signature in its log is still transient.
  - `::test_identical_disk_recorded_failures_are_never_identical`: a recorded disk attempt between two identical real failures is skipped by the identical-failure rule.
  - `server/projects.test.ts::a worker packet whose check ran out of disk is served with transient disk and parses`.
  - `contracts/workflow/contract.test.ts::a check records why it was transient: memory or disk, nothing else`.
  - Red: the checks and repair tests fail on the base, and the server test fails with the base `contracts/workflow/v1.ts`.

## D29 the panel budget default

- Changed: `contracts/workflow/feature.schema.json`. The panel `budget_usd` loses `"default": 5`; there is no `"default": 25`. Its description says: "When absent the controller applies 25 if any provider of the panel uses the claude transport, else 5 (workflow/panel.py)", informational for pi. `contracts/workflow/README.md` says the same in the 2.6.0 `panels` sentence.
- Proof: `contracts/workflow/contract.test.ts::the panel budget documents the default the controller applies, not a single default`. `test_panel.py` is unchanged and green in the workflow suite.

## D30 `relaunch` says what it archived when the launch fails

- Changed: `workflow/interactive.py` `relaunch_main`. `archive()` records its text once the renames and the action event are done. The `except` branch then prints:

  ```
  Blocked: <error>
  Archived <a> as <b>[, <c> as <d>]; the launch did not complete and <lane>.interactive.json is <status>. Continue with: <sys.executable> -m workflow reconcile <run, shlex-quoted> --by operator
  ```

  - `<status>` is read from the receipt after the failure. When `claude --bg` exits non-zero, `InteractiveSessions.launch` saves `needs_reconciliation` in its `finally`, which `test_interactive.py::test_a_relaunch_whose_bg_exits_non_zero_after_the_archive_leaves_a_receipt_needing_reconciliation` confirms on the real launch path. If a step between the archive and the launch fails (the automatic settings, writing the prompt), the receipt stays `launching`, and the message names that state instead.
  - Refusals before `archive()` keep `Blocked: <error>\nNothing was relaunched.` byte for byte.
  - `server/controls.ts` relays the first "Blocked:" line, so the server is unchanged.
- Proof (`workflow/test_interactive.py`):
  - `Relaunch::test_a_launch_that_fails_after_the_archive_names_the_archives_and_the_reconcile_command`: exit 1; no "Nothing was relaunched"; the exact message; the archives exist byte-identical; the receipt is `needs_reconciliation`. Red on the base.
  - `Relaunch::test_a_dirty_worktree_refusal_says_nothing_was_relaunched`.
  - `test_a_refusal_of_the_launch_itself_…`, which now asserts the whole two-line refusal.
- Docs:
  - RUNBOOK "Relaunch a lane whose launch died": "**A launch that fails after the archive** exits 1 with `Blocked: <error>`, then `Archived <a> as <b>; the launch did not complete and <lane>.interactive.json is needs_reconciliation. Continue with: <python> -m workflow reconcile <run> --by operator` (the receipt's actual status is named); a refusal before the archive still ends `Nothing was relaunched.`"
  - README `relaunch` row: "a launch that fails after the archive exits 1 naming the archives, the new receipt's status and the `reconcile` command instead of "Nothing was relaunched.""

## D31 `retry --all-failed` refuses on a pending interrupt

- Changed: `workflow/pipeline.py`, the `retry` branch. With `--all-failed` and a non-empty `pending`, it calls `parser.error("Retry requires a failed graph step, not an interrupt/completed run")` (exit 2) before `retry_all_failed`, after `refuse_recorded` as today.
- Proof: `workflow/test_repair.py::AllFailedAfterAFullDisk::test_a_pending_interrupt_refuses_all_failed_as_single_lane_retry_and_writes_nothing`. The run waits on `worker_handoff`. The test checks: the same exit code (2) and last stderr line as single-lane retry; no stdout; no timeline row; no `retry-requests.json` or `attempts.json`; every non-lock file in the run, `pipeline.sqlite` included, byte-identical.
  - `test_the_refusals` changed. Its first call (before `start`) now asserts the "No verify step failed" refusal (exit 1); before, that call ran without an assertion. The call after `start` (a pending interrupt) now asserts the guard (exit 2). Before, it expected exit 1.
  - Red: both fail on the base.
- Stage C's "Retry all failed checks" control now sees exit 2, with stderr ending `error: Retry requires a failed graph step, not an interrupt/completed run`, for a run waiting on an interrupt. Before, it saw exit 1 with `Blocked: No verify step failed…`.
- Docs: README `retry --all-failed` row: "a run waiting on a pending interrupt is refused before anything is written, exactly as single-lane retry refuses it (exit 2, `Retry requires a failed graph step, not an interrupt/completed run`)".

## Checks run (green, after every change)

- frontend-build `npm run build`: exit 0.
- frontend-lint `npm run lint`: exit 0.
- shared-contract `npm run test:contracts`: 47 passed.
- frontend-unit `npm run test:unit`: 924 passed.
- server-unit (`server/{projects,dispatch,sessions,controls,app}.test.ts`): 240 passed.
- workflow-unit `.venv/bin/python -m workflow.run_tests`: 1314 passed, 0 failed (1063 s), `test_panel.py` unchanged and included.

## Lane review P2/P3 findings ([G1])

None recorded yet; the lane review runs after this handoff.

## DESIGN.md sentence for the `ui` lane's successor

None needed from this lane. PRD 8's sentence "A list that could not read some runs says which, under the runs it read." is backed by the served `errors`.
