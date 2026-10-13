# Handoff: workflow-collected-fixes (engine lane)

Run `workflow-collected-fixes-001`, lane `engine`, base 44b9c24, then its follow-up `workflow-collected-fixes-002`, which restored 001's candidate 64644771 over the owned paths (`git diff --stat 64644771 -- workflow docs/BACKLOG.md docs/handoff/ux-fixes-engine.md` was empty before the first edit) and changed only what [L15] to [L29] ask (section "Follow-up 002" below). Owned paths: `workflow/`, `docs/BACKLOG.md` and this file. Specification: `features/workflow-collected-fixes/prd.md`, with `decisions.md` ([O8] to [O15], [L1] to [L29]) winning where they differ. No file under `server/`, `src/`, `tests/`, `contracts/` or `features/` changed.
## What changed, per item, and the test that proves it

| Item | Change | Tests |
|---|---|---|
| BL3 | `automatic.completion_prompt`: every completion version ends its shared return with the final-turn sentence (`FINAL_TURN`); 1.1.0 adds "Put any step for the operator in verify_yourself, never in your final message." next to `verify_yourself`. Repair briefs (`repair.session_brief`) reuse it. | `test_automatic::CompletionTests::test_every_worker_prompt_says_to_end_without_addressing_the_operator`, `test_repair::RepairSession::test_a_1_1_0_session_brief_carries_the_final_turn_rule` (and the final sentence in `test_a_session_repairs_the_candidate_and_the_run_reaches_its_feature_branch`) |
| GH3 | `export_state.export_state`: `tasks[].error` only for a task in `state.next`, else `null`. | `test_export::ExportRunTests::test_a_task_error_is_exported_only_for_a_pending_task` |
| GH12 | `guardrails.resume_challenge(..., export=)`: called after `repin` and the re-pin event, before `run_challenge`; `resume_main` passes its export. `resume_challenge` is the only `repin(` caller. | `test_guardrails::ChallengePauses::test_a_rerun_exports_its_new_base_and_a_running_challenge_while_its_job_runs` (fails without the call: base mismatch) |
| RLC12 | `setuptools>=84,<90` in `requirements.txt`, `setuptools==84.0.0` in the lock; `checks.verification_environment` is the one environment builder (`verify_revision` and `preflight --setup`). | `test_checks::CheckEnvironmentTests::test_a_check_imports_distutils_from_the_controllers_venv` (runs `python3 -c "from distutils.version import StrictVersion"` under that environment; fails, never skips, without setuptools), `test_the_lock_pins_setuptools_and_the_requirements_list_it` |
| RLD18 | `sidecar.deliver_text`: the gate is checked again just before `send-text`; after each Enter the pane is read back up to 5 times 0.5 s apart (`READBACK_READS`, `READBACK_INTERVAL`, injectable `readback_sleep`); a text still shown gets one more Enter; still shown after it: `undeliverable`/`pane_busy`, a `pane` attention record on the lane and (sidecar messages) one `sidecar` `interactive` event; a note says it in its own event. | `test_sidecar::Messages::test_a_swallowed_enter_gets_exactly_one_more`, `test_an_input_that_clears_on_the_second_read_needs_no_extra_enter`, `test_a_text_two_enters_left_in_the_input_is_undeliverable_with_a_pane_record` (ledger validated), `test_a_lane_that_went_on_after_the_gate_read_gets_nothing_typed` |
| RLD20 | `panel.settings`: no `budget_usd` and a claude provider gives `CLAUDE_BUDGET_USD` 25; pi-only keeps 5; explicit values and 0.5-50 kept. A claude `error_max_budget_usd` failure's recorded `error` adds `; the call reached budget_usd <v> (spent <x> USD \| spent amount unavailable): raise budget_usd in the panel entry "<id>" of feature.json panels (maximum 50)`. | `test_panel::Config::test_a_panel_with_a_claude_provider_defaults_to_a_budget_of_25_per_claude_call`, `test_panels_are_refused_before_2_6_0_and_declared_with_defaults_at_2_6_0` (updated to 25), `test_panel::ReviewStep::test_a_claude_call_out_of_budget_names_the_budget_what_it_spent_and_where_to_raise_it` |
| RLF1 | `Pipeline.freeze`: `freeze running "Stopping the workers: <lanes>"` before the stops, then `running "Worker <lane> stopped"` per confirmed stop (only under the freeze), then `stopped`; the `snapshots.json` early return writes nothing. | `test_automatic::ClaudeUnavailableTests::test_an_outage_while_the_freeze_stops_the_workers_is_resumed_and_relaunches_nothing` (exact list, plus no event on a resumed freeze), `test_a_freeze_re_entry_cut_short_is_re_entered_by_the_next_controller` (exact list) |
| RLG23 | `checks.disk_floors`/`disk_shortfalls`/`disk_refusal`: 5120 MB and 5 % inodes on the nearest existing ancestor of the run directory and on the repository; `WORKFLOW_DISK_FLOOR_MB`, `WORKFLOW_INODE_FLOOR_PCT` (0 disables, non-numeric refused naming the variable). Called first in pipeline preflight and in `launch_commands` (so the dry run refuses without preflight). | `test_feature_launch::DiskFloor` (5 tests: inodes on launch, preflight and dry run with no branch, worktree or run directory; free space; each location alone; `f_files == 0`, healthy, floor 512, floor 0 reads nothing; `abc` refused) |
| RLI17 | `guardrails.refuse_empty_restore`: `git diff --quiet --no-ext-diff --no-textconv <base> <restore> -- <owned paths>`; prepare (base `HEAD` of `--repo`) and `launch_commands` (dry run included). | `test_guardrails::RestoreFrom::test_a_restore_equal_to_the_base_over_the_owned_paths_is_refused_before_the_run_exists` (HEAD, outside-only change, candidate accepted); `test_feature_launch::...restore_from_is_resolved...` now restores a commit that differs |
| RLI19 | `pipeline.herdr_pane_refusal` in preflight with `--herdr`; `pipeline.attach_after_launch` in `start` and `start_workers` (resume): only attach errors become the note, one `controller` `note` event, exit 0. | `test_portable::HerdrPanePreflight` (2 tests: `pane current` exit 1 and no `herdr` refuse a live launch with nothing created; a passing fake passes; no call without `--herdr`), `test_guardrails::AttachAfterLaunch` (4 tests: note and exit 0, `launch --automatic` reaches `automatic`, a `--bg` failure keeps exit 1 with no attach, no `herdr` call without `--herdr`) |
| RLF2(a) | `checks.preflight_setup`; `preflight --setup`, `launch --preflight-setup`. Worktree add and remove through `git_worktree`/`remove_worktree`, which lock themselves; setup runs outside the lock (design note 4, not [L6]'s wording). | `test_portable::SetupPreflight` (6 tests: pass, fail naming `setup 1` with argv, exit and log, `KeyboardInterrupt`, `setup: none`, a concurrent `git_worktree` add during setup, no setup without the flag in preflight, launch and dry run, `--setup` on the printed preflight) |
| RLG24 | `retry --phase worker --all-failed` (`pipeline.retry_all_failed`); `repair.disk_packet`, `disk_full_error`, `transient_attempt` at `previous_failure`, the identical-failure rule, `blocked_lanes` and `attempt_limit`; `automatic.wait_for_disk` before rerunning a disk-full packet or a requested lane whose step error is errno 28 or a signature. | `test_repair::AllFailedAfterAFullDisk` (four raised `OSError(28)` lanes: four requests equal to single-lane retry's, all four rerun to the feature branch, no repair round; the 10-minute refusal naming the floor; the refusals), `test_repair::DiskFullAttempts` (the three signatures in setup and check logs, the errno repr forms, a real failure beside one, no identical failure, no memory event or wait, the shared cap, the disk wait with a fake clock) |
| RLI16 | `relaunch` (`interactive.relaunch_main`, `relaunch_conditions`, `InteractiveSessions.inventory_all`, the `allowed_ids` allow-list and the relaunch-only `before_launch` hook on `InteractiveSessions.run`), operator only (`actor.OPERATOR_ONLY`). 002: one name rule, `interactive.ended_row`/`conflicting_rows`, used by `run()`, `relaunch_conditions` and the test fake: an allowed id is exempt only while listed `stopped`/`failed`/`done` without a positive PID. | `test_interactive::Relaunch` (12 tests: launches once with the dead id listed `done` without PID and with it absent; `start` still refuses; the printed reconcile and automatic lines run verbatim to the feature branch; archives `-1`/`-2`; every refusal and dry run leaves every file's hash, no `--bg` and no archive), `test_interactive::LaunchNameGuard` (a non-relaunch launch refuses any row of its launch name; `--all` inventory parsing; 002: `test_an_allowed_id_listed_live_refuses_the_launch`), 002: `test_interactive::Relaunch::test_a_dead_session_listed_live_again_by_the_launch_listing_refuses_before_the_archive` |
| BL1, BL3 | `docs/BACKLOG.md`: items 1 and 3 removed; item 1 shipped in merge 6c62677, item 3 by this feature (BL3 above). | `grep -n "Accepted by the operator\|## 3\." docs/BACKLOG.md` prints nothing |
| RLF4 | RUNBOOK "Recovery without abandon" paragraph (no code). | docs |

## Interfaces for the server lane (ux-critique-fixes-c), as built

All commands run as `<python> -m workflow ...` from md-manager's root; `"$RUN"` is the run directory.

**Retry all failed checks**

- argv: `-m workflow retry "$RUN" --phase worker --all-failed --by operator`
- exit 0: one line per failed lane, `worker/<lane> will run attempt <n>` (or `worker/<lane> attempt <n> is already requested and has not run; nothing changed`), then `Nothing ran. An automatic run continues under its supervisor: <python> -m workflow automatic <run> --live --by operator`. It runs nothing; the supervisor (`automatic --live`, the Restart supervisor control) reruns every requested lane.
- exit 1 (`Blocked: <text>`): `No verify step failed or was left without a verdict; nothing to retry`; `retry --all-failed applies to automatic runs; retry a manual run's lanes one by one with --node <lane>`; `retry is refused for --by panel: ...`; a recorded repair (`refuse_recorded`'s text).
- exit 2 (argparse): `--all-failed retries every failed lane; it takes no --node (retry one lane with --node <lane> alone)`; `--all-failed applies to --phase worker only; a candidate check is retried with --phase candidate --node <lane>`.
- Offer it when the run's retry targets hold two or more worker lanes.

**Relaunch a lane**

- Offer probe: `-m workflow relaunch "$RUN" <lane> --dry-run --by operator`, run the way the Clean control runs `clean --dry-run`. Exit 0 means offer: stdout's first line is `relaunch <lane>: allowed`. Exit 1 means do not offer: the first line is `relaunch <lane>: refused: <reason>`, or, for a held lock, an abandoned run or a maintainer, `Blocked: <reason>` on stderr. It changes no file.
- Action: `-m workflow relaunch "$RUN" <lane> --by operator`. Exit 0 prints `Relaunched <lane> once: session <uuid>; archived <...>.`, `Continue the run with:`, then exactly these two lines last:
  - `<python> -m workflow reconcile <run> --by operator`
  - `<python> -m workflow automatic <run> --live --by operator`
  The control chains them: reconcile binds the new receipt and moves `launch_<lane>` out of `next`; automatic (long, like Restart supervisor) continues. `relaunch` itself never advances the graph, and `start` keeps refusing (`Run already started; use status/explicit controls, never start again`).
- Exit 1 (`Blocked: <reason>\nNothing was relaunched.`) for every refusal, nothing changed:
  - `Another controller owns this run` (the controller or supervisor lock held);
  - `The run was abandoned ...` (and the accepted-run refusal);
  - `launch_<lane> is not pending: the lane launched, or the run moved on`, or `the run has not started: start launches its lanes`;
  - `<lane>'s receipt is '<status>', not needs_reconciliation: reconcile it instead`;
  - `session <id> is listed '<state>' [with pid <n>]: it may still run`;
  - `session <id> ('<state>') carries the launch name workflow-<run>-<lane>[, and no launch id was recorded]`;
  - `<lane>'s launch log printed <n> session ids; which one it launched is unknown`;
  - `the session inventory is unreadable: ...` (`claude agents --json --all` failing, unsupported or unparseable);
  - `<worktree> is absent; relaunch never recreates a worktree`, `<worktree> cannot be read: ...`, `<worktree> is not at the run's base <sha>`, `<worktree> has uncommitted changes`;
  - `<lane>.completion.json[, ...] exists: the lane ran` (completion, handoff or stop);
  - `Unowned session already exists with this launch name` (the launch path's own fresh `claude agents --json` shows the dead session live again, or another row of the launch name, after the conditions held; nothing archived, no `--bg`);
  - the launch path's other refusals (`Worktree changed since preparation`, a prompt too long for argv, a failed trust write), likewise before the archive.
  - `relaunch is the operator's decision: --by maintainer is refused ...` and the same for `--by panel`.
- Archives: `<lane>.launch-<n>.receipt.json` and `<lane>.launch-<n>.log`, `n` from 1 past every earlier archive; never matched by `/\.interactive\.json$/` or `*.launch.log`.
- One relaunch per lane: while `claude agents --json --all` keeps the first relaunch's dead row under the lane's launch name, a second `relaunch` of that lane refuses (`session <id> ('<state>') carries the launch name ...`) and `--dry-run` prints that refusal on its first line; the control shows it as the reason it is not offered.

**GH3.** `run-state.json` `tasks[].error` is `null` for a task not in `next`. The viewer guard in `server/projects.ts` may also read `next`.

**GH12.** While a challenge rerun runs, `plan.json` and `run-state.json` share `base_commit` and the challenge's latest event is `running`; the server's load test needs no viewer change.

## Sentences the stage C lanes must keep true

Stage C does not edit `workflow/RUNBOOK.md` or `workflow/README.md`; these rows were written here and stay true before and after that stage:

- GH8 (RUNBOOK "Verification policy and evidence", README step 4): md-manager's root Playwright suite runs only when a lane that owns `src/App.tsx` or the skills views declares the browser check `env MD_MANAGER_API_PORT=<p> MD_MANAGER_WEB_PORT=<p> npx --no-install playwright test --config=playwright.config.ts`, the root config ignoring `project-workflows/**` from ux-critique-fixes-c on.
- RLI21 (RUNBOOK "Run controls in the viewer"): long controls run in a `systemd-run --user --scope`; from ux-critique-fixes-c on with `--property=OOMPolicy=continue`, so one check's OOM kill no longer stops the supervisor; before that, restart it after a memory kill.
- Run controls (RUNBOOK table, README "Run controls" row): "Retry all failed checks" and "Relaunch a lane" are marked "(from ux-critique-fixes-c)", with the argv and offer rules above. If stage C is dropped, these rows are stale and must be removed.

## Operator steps

- **RLC12.** Reinstall `~/dev/md-manager/.venv` and `~/dev/md-manager-ctl/.venv` from `workflow/requirements.lock` (`.venv/bin/pip install -r workflow/requirements.lock`). Until then node-gyp still fails in a check, and `test_checks::CheckEnvironmentTests::test_a_check_imports_distutils_from_the_controllers_venv` fails under every venv built before the pin, including precedent policies whose `workflow-unit` points at the controller venv: that failure is the missing reinstall, not a regression.
- Verify on the real host that `claude agents --json --all` is supported and exits 0, and the row shape of an ended background session (its `state`, and that it has no `pid`). Relaunch refuses whenever that listing fails, so an unsupported `--all` makes every relaunch refuse.
- BACKLOG: item 1 shipped in merge 6c62677; item 3 ships with this feature. Closing GitHub issues #3 and #12 is the operator's call.

## Follow-up 002 ([L15] to [L29])

| Bullet | Change | Proof |
|---|---|---|
| [L15], [L23] | `interactive.ended_row(row)` (state `stopped`/`failed`/`done`, no positive pid) and `conflicting_rows(rows, name, allowed_ids)`; `InteractiveSessions.run()` refuses on `conflicting_rows(...)` before `before_launch`; `relaunch_conditions`' name rule and the `RelaunchSessions.run` fake call the same helper. The fake's `--all` listing (`listed`) and fresh listing (`listed_fresh`) are separate. | `test_interactive::LaunchNameGuard::test_an_allowed_id_listed_live_refuses_the_launch` (working with pid, done with pid, idle: RuntimeError, `subprocess.run` and the hook not called, receipt unchanged); `test_interactive::Relaunch::test_a_dead_session_listed_live_again_by_the_launch_listing_refuses_before_the_archive` (exit 1, no `ui.launch-*`, no `--bg`, every hash unchanged) |
| [L26] | Mutation checks, run by hand on this tree and reverted: (1) `conflicting_rows` reverted to the old rule (allowed id exempt whatever its state): both tests fail (4 failures); (2) `run()` bypassing `conflicting_rows` with the old inline rule: `LaunchNameGuard` fails (3 subtests); (3) the `RelaunchSessions.run` fake bypassing the helper: the relaunch-level test fails. | self-report |
| [L27] | `relaunch_conditions` keeps its id-based live check and both refusal texts; only `other` (the name rule) uses `conflicting_rows`. | the existing `test_interactive::Relaunch` refusal tests pass unchanged |
| [L16] | No code: the `before_launch=None` hook was already as [L16] describes. RUNBOOK "Relaunch a lane whose launch died" names it in one sentence. | docs |
| [L24] | No code. One sentence each in RUNBOOK "Relaunch a lane whose launch died" and in "Interfaces for the server lane" above. | docs |
| [L17], [L21] | `test_pipeline.isolate_statvfs()` (called by `isolate_registry()`): a module-wide `patch("workflow.checks.os.statvfs", return_value=HEALTHY_DISK)` (100 GB, 50 % inodes free) with its module cleanup. `test_feature_launch` and `test_interactive` now call `isolate_registry()` in `setUpModule` (test_interactive had none). Audit: the modules that reach `disk_refusal`, `launch_commands`, preflight or the disk wait, or clear a floor variable, are test_pipeline, test_repair, test_automatic, test_interactive, test_feature_launch, test_outcome, test_guardrails, test_lanes, test_lane_review, test_portable, test_sidecar and test_panel; every one calls `isolate_registry()` (test_panel through test_pipeline's helpers). test_worktrees reaches only `prepare`, which reads no floor, and keeps `isolate_disk` through `stub_claude_cli`. Floor tests (`DiskFloor`, `DiskFullAttempts`, `AllFailedAfterAFullDisk`) keep their own patches over it. | the proof run below |
| proof run 1 | `test_sidecar::Scheduling::test_scheduling_cadence_completion_budget_and_nothing_while_a_pass_runs` (unchanged since before 001's RLD18 work) counted the fake job's logged calls after a fixed `time.sleep(0.2)`; at load 13 the pass's own job had not logged yet (`0 != 1`). It now first waits for that call with the module's `wait_logged(1)`, then sleeps 0.2 s and still asserts exactly one call. A test-only change; the proof run was repeated after it. | the repeated proof run below |
| [L25] "before" | Not run, as [L25] drops it. The gap was latent: every floor-reaching call in test_repair patches `statvfs` itself, and 001's combined run passed these modules. The 0-bytes-free sitecustomize surfaces every module the raising variant would, because `checks.disk_free` (checks.py, the one `os.statvfs` call in `workflow/`) is the only reader. | self-report |

**Playwright-backed classes ([L28] and challenge note 4)**: every class whose fixture runs `PipelineTests.setUp`: in test_pipeline `PipelineTests`, `BundleTests`, `RecordTests`, `AbandonTests` and `CandidateRefTests`; every `GraphFixture` subclass in test_automatic (`ClaudeUnavailableTests`, `ControllerStopTests`, `ExportAfterVerdictTests`, `ApprovalStopTests` and the reviewer graph classes included); and `test_panel.GraphRun`. A failure of one of these under host load counts as a load failure only when the class then passes alone once, run as `.venv/bin/python -m workflow.run_tests --child workflow.<module>.<Class>` with the same exported floors and sitecustomize.

## Isolation proof ([L2], [L11], [L20] to [L25])

The worker prompt's deadline: 2026-10-14T00:16:35Z (UTC). Every [L25] timing rule used it. All edits under `workflow/` landed before the proof run; after it only this file and the completion changed.

One combined command, run from the worktree root, serves [L2], [L11], [L20], [L21]'s after-check and the task's full-suite run at once: the exported floors make any test that inherits the parent's floors fail, and the sitecustomize makes any in-process floor read that is not patched see a full disk.

```bash
export WORKFLOW_DISK_FLOOR_MB=999999999 WORKFLOW_INODE_FLOOR_PCT=99 PYTHONPATH=<dir>   # <dir> holds the sitecustomize.py below
.venv/bin/python -m workflow run-report -- .venv/bin/python -m workflow.run_tests
```

`<dir>/sitecustomize.py` (checked first: `python -c "import os, workflow; print(workflow.__file__, os.statvfs('/').f_bavail, os.statvfs('/').f_favail)"` printed this worktree's `workflow/__init__.py` and `0 0`):

```python
import os

_real_statvfs = os.statvfs


def _full_disk(path):
    """The host's reading with 0 bytes and 0 inodes free to anyone."""
    real = _real_statvfs(path)
    return os.statvfs_result((real.f_bsize, real.f_frsize, real.f_blocks, 0, 0, real.f_files, 0, 0, real.f_flag, real.f_namemax))


os.statvfs = _full_disk
```

Setup before it: `npm ci`, then `python3 -m venv .venv` and `pip install -r workflow/requirements.lock` in this worktree ([L7]).

Quiet-host waits: 20:25 to 20:55 UTC and 21:21 to 21:51 UTC, polled every 2 minutes; the host never had no `chrome-headless-shell` process with a 1-minute load under 4 at once (load 3.1 to 11.7, 0 to 12 Chromium processes), so each run started at the end of its 30-minute wait.

**Proof run 1** (the original result, kept separate). Start 2026-10-13 20:55:40 UTC, load average 4.88, 7.14, 7.26 (6 Chromium processes); end 21:20:32 UTC, load 13.47, 14.13, 12.86. `exit 1 after 1488.1 s`, `counts: 1305 passed, 1 failed, 0 skipped`: `test_sidecar.Scheduling::test_scheduling_cadence_completion_budget_and_nothing_while_a_pass_runs` (`0 != 1`), outside the Playwright-backed classes, so a lane failure under [L20]. Not a floor failure: a fixed 0.2 s wait for a fake job under load. Fixed in the test (section "Follow-up 002", row "proof run 1"); no isolated rerun counted for it, and the proof run was repeated.

**Proof run 2** (on the final tree; nothing under `workflow/` changed after it: the hash of `git diff 64644771 -- workflow` taken at its start matched the one taken after it, and only this file changed since). Start 2026-10-13 21:51:43 UTC (prompt deadline 2026-10-14T00:16:35Z), load average 3.93, 4.31, 6.38 (7 Chromium processes); end 22:10:14 UTC, load 9.28, 9.43, 8.97. Pass line: `exit 0 after 1110.0 s`, `counts: 1306 passed, 0 failed, 0 skipped` (`Ran 1306 tests in 1109.389s (parallel: 245 classes, 4 jobs)`, `OK`). No "Install npm dependencies" line in its log.

Load-failure list: empty (no Playwright-backed class failed in proof run 2, so no isolated rerun was needed).

### Run 001's record (kept as it was)

Every test module that prepares or launches a run disables both floors for its whole run (`test_pipeline.isolate_disk`, called from `stub_claude_cli`), in process and for its children; floor tests clear or set the variables themselves and patch `os.statvfs` with controlled readings. One full run served both proofs at once (it fails if any test reads the host's disk through a floor, and if any test inherits the parent's floors):

```bash
WORKFLOW_DISK_FLOOR_MB=999999999 WORKFLOW_INODE_FLOOR_PCT=99 PYTHONPATH=<dir holding a sitecustomize.py that makes os.statvfs report 0 bytes and 0 inodes free on every path> \
  .venv/bin/python -m workflow run-report -- .venv/bin/python -m workflow.run_tests
```

Run 001's result (2026-10-13, 2960 s on this 4-CPU host): 1295 passed, 6 failed. The 6 were all in `test_automatic`'s graph classes whose ui lane runs a real Playwright check (`NativeReviewerGraphTests`, `NativeTwoReviewerGraphTests`, `ParallelReviewerScenarios`, `PrintReviewerGraphTests`: "worker/ui failed identically on attempts 1 and 2", and "cannot schedule new futures after shutdown"); none touches a floor. The same 6 tests rerun alone under the same exported environment and patched `statvfs`: 6 passed (123 s). No floor test and no launch or preflight test failed.

Plain full runs: run 2 (while other suites ran beside it) 1299 passed, 2 failed, both `test_recovery_in_actual_new_controller_processes` (in `AutomaticGraphTests` and `AutomaticTwoReviewerGraphTests`: ui's attempt-1 check rerun), which passed 3 of 3 alone; run 1 had passed it. The final plain run (started 15:21 UTC while the box ran at load average about 30 beside the UI chain's verification) had not finished at 16:22: of 220 classes reported, 31 tests failed, all in `test_pipeline.PipelineTests` and the four `test_automatic` reviewer graph classes, every one `worker/ui` or `candidate/ui failed identically on attempts 1 and 2` from the fixture's real Playwright check; the two `PipelineTests` failures rerun alone under that load failed again the same way, and one of them rerun once more passed, its only blocked check being the test's intended one-time adapter failure. These classes passed in run 2. The verifier's own `workflow-unit` run is the evidence that counts.

**Suite duration risk.** The full suite took 1542 s, 2104 s and 2960 s here under load, against the verifier's 2400 s budget of run 001 (3600 s from run 002, [L19]); the new subprocess tests (`SetupPreflight` about 170 s under load, `HerdrPanePreflight`, `AllFailedAfterAFullDisk`) add to it. A verifier that shares the box with the UI chain's browser suites may run close to the limit.

## Open items (P2) and readings

- P2s from 001's review, deferred by [O15] and still open in 002:
  - `retry --all-failed` (`pipeline.retry_all_failed`) skips the pending-interrupt guard the single-lane `retry` has.
  - `relaunch` prints "Nothing was relaunched" even when `before_launch` archived and `claude --bg` then failed; that message should name the archive and the possible session (stage C relays the text).
  - Coverage gaps: `abandon` on a run holding `<lane>.launch-<n>.*` archives; test_export's GH3 test never validates against the runSnapshot schema; no `SetupPreflight` test asserts the setup environment of [O14](2); `AttachAfterLaunch` records but does not run preflight ([O12]).
- [L22]: the policy's `workflow-unit` argv still carries no floor variables; moving `WORKFLOW_DISK_FLOOR_MB=0 WORKFLOW_INODE_FLOOR_PCT=0` into the check argv is deferred.
- [L4] A multi-lane partial `--bg` launch failure (one lane launched, another failed) keeps today's exit 1 from `start`; only attach failures are downgraded. The supervisor does not run for that launch until the operator reconciles or relaunches.
- [L13] A genuine test failure whose own text quotes `ENOSPC`, `No space left on device` or `Disk quota exceeded` is classified disk-transient; the shared cap of three transient attempts (`MAX_TRANSIENT_RERUNS`) bounds the free reruns.
- Design note 6: a raised errno-28 lane (no packet) spends one ordinary attempt when `retry` raises it, exactly as single-lane `retry` does; "no ordinary attempt spent" holds for disk-full packets. The errno predicate matches the checkpoint's repr forms (`OSError(28`, `[Errno 28]`).
- Design note 3: relaunch takes `automatic-supervisor.lock` and `controller.lock` (abandon's order) only when each lock file exists, so a refusal or a dry run never creates a file. A run that never had a supervisor has no supervisor lock file, so a supervisor started in the same instant is not excluded.
- Design note 7 / prd.md: prd.md:240 (an absent worktree allowed), :243 and :249 ("`start` completes") are superseded by [L9] and [L10]: an absent worktree refuses, and `start` keeps refusing after a relaunch. prd.md is outside this lane's paths and was not edited.
- The disk wait reads the run directory and the repository (both exist during a run); preflight reads the run directory's nearest existing ancestor.
- Deferred, unchanged: the run controls and the GH12 server test (stage C), the GH3 viewer guard, `OOMPolicy`, the root Playwright suite, new schema enum values (`enter_not_submitted`, a disk `transient`, the panels `budget_usd` default and `contracts/workflow/README.md`'s "default 5"), RLF2 part (b), an automatic relaunch, RLD20's context-size launch note.
