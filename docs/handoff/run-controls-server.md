# Handoff: the run-control API (lane `server`, run run-controls-003)

Spec: [PRD_RUN_CONTROLS.md](../PRD_RUN_CONTROLS.md) sections 3 to 5, 7 and Appendix A; decisions `features/run-controls/decisions.md`
(L1 to L6 bind; where they differ from the PRD they win). The viewer lane mirrors the types in `src/projects/controls/types.ts`; this
file is what it can rely on.

## What changed

| File | What |
|---|---|
| `contracts/projects/controls.ts` | Appendix A's zod schemas (`runControlsSchema`, `controlRecordSchema`, the POST and clean-preview bodies, the status and error shapes) |
| `contracts/projects/examples.ts`, `contract.test.ts` | one `RunControls` per offer state (`runControlsStates`), one record per status (`controlRecords`), status, request and preview examples; the tests validate each and the refusals |
| `server/controlsGuard.ts` | the startup environment ([L5]) and the header guards (JSON, Host, Origin, Fetch Metadata, token) |
| `server/controlsRunner.ts` | the lock probe over `/proc`, the record store, short and long children, the `systemd-run` argv |
| `server/controls.ts` | the closed control table, the offer rules, the routes |
| `server/app.ts`, `server/index.ts` | `createApp(..., { controls })`; the API loads `loadControlsConfig(process.env)` and logs one warning per failed condition |
| `workflow/RUNBOOK.md`, `workflow/README.md` | "Run controls in the viewer" and a row |
| `server/controls.test.ts` | 42 tests; every one runs in `npm run test:unit` |

`server/projects.ts` and `server/projectRoutes.ts` are unchanged. `RunStore.loadRun` is used as is (the projection gives the status and
node statuses the rules read); `readBounded` is not exported there, so `controls.ts` has a small no-follow bounded reader of its own.

## The wire (as built)

- `GET /api/run-controls/status` is open: `{version, enabled, paired}`. Controls off: `enabled: false`, and every other route is 404 `CONTROLS_DISABLED`.
- `GET .../:project/:workflow/:run` (token) is `RunControls`; `GET .../records/:record_id` (token) is `{record}`.
- `POST .../:control_id` body `{request_id, run_state_token, params}` (strict): 202 `{record}` for a long control started, 200 for a short or signal one ended (a command the controller refused is a 200 with a `failed` record, `Blocked:` line first). A repeated `request_id` answers with the first record before anything else is checked (202 while it is `running`).
- `POST .../clean-preview` body `{run_state_token}` only ([L4]): `{exitCode, output}`, no record, no `request_id`, no `BUSY`; `clean` must be offered.
- Guards 1 to 4 run in an `onRequest` hook, before the body is read; their codes are 415 `UNSUPPORTED_MEDIA_TYPE`, 403 `FORBIDDEN_ORIGIN` (Host, Origin, Fetch Metadata), 403 `TOKEN_REQUIRED` / `TOKEN_INVALID`. Then: repeated `request_id`, 409 `STATE_CHANGED`, 409 `BUSY`, 422 `NOT_AVAILABLE` (the reason is the message), 400 `INVALID_PARAMS`.
- `recommended` is always `false` ([L1] 3c).
- Allowed hosts ([L7], amending [L6] 2): Host is loopback (`127.0.0.1`, `localhost`) on the web port (`MD_MANAGER_WEB_PORT`, default 5173) or the API port (`MD_MANAGER_API_PORT`, default 3001); Origin is loopback on the web port only (an Origin on the API port is 403). `MD_MANAGER_CONTROLS_HOSTS` is not read (one startup warning when set). The Vite proxy (string shorthand) sets `changeOrigin`, so the API sees its own port as Host while Origin and Sec-Fetch-Site pass through unchanged; no header is lost. **`controls-app.ts` must set `MD_MANAGER_WEB_PORT=$CRITIQUE_WEB_PORT`** for the API child, or every critique POST is 403 `FORBIDDEN_ORIGIN`; `playwright.config.ts` already passes it.
- `run_state_token` is the SHA-256 of: the export's `updated_at`, the last event sequence, the run status, the bytes of `attention.json` and of each lane's `<lane>.questions.json`, whether `abandon.json` and `challenge.running.json` exist, and the lock probe's result and holder start time. Any of them changing is a 409 for a page that rendered before.

## The offer rules and the files they read (design note 3)

Read through the bounded no-follow reader or `RunStore.loadRun` (never a request path):

| Control | Signals |
|---|---|
| all lock-bound ones (`restart`, `retry`, `reconcile`, `resume`, `accept_challenge`, `release_hold`, `repair_session`, `abandon`, `clean`) | the lock probe first: `automatic-supervisor.lock` held gives `A supervisor is running (since HH:MM UTC)` (without a start time: `A supervisor is running`); only `controller.lock` held gives `A controller is running (...)`. This is the order the design challenge asked for (the challenge's own "L6" label, not decisions.md's [L6]). |
| `restart` | `plan.json` `automatic` (or the export's `inputs.mode`), snapshot status `succeeded`/`cancelled`, `abandon.json`, `repairs.json` entries with status `recorded` (through the fix loop) |
| `pause` | the supervisor lock held and the holder's `/proc/<pid>/cmdline` naming `-m workflow`, `automatic`/`launch`/`resume` and this run's directory; its process group is `/proc/<pid>/stat` field 5 |
| `retry` | snapshot nodes `verify_<lane>` or `candidate` at `failed`/`paused` (the node status the dock's triage reads: a task error, or evidence without a passing gate); the phase is `worker` for a verify node and `candidate` for the candidate |
| `reconcile` | `next` in `run-state.json` still holding a `launch_*` node, a receipt (`*.interactive.json`, `automatic-review*.json`) at `needs_reconciliation`, or one of the last 20 events naming `workflow reconcile` |
| `resume` / `accept_challenge` / `release_hold` | `inputs.challenge` of the export: `paused`; `passed` with a `hold` not yet released; `challenge.running.json` present (an interrupted rerun). `drop` choices are 1..N of the held attempt's concerns |
| `answer` | `<lane>.questions.json` (else the export's questions): the lane's last question has no answer; **and** `HERDR_ENV=1` in the server's environment; **and** `terminals.json` has an object with a string `pane_id` for that lane ([L2]; a missing or malformed file is no pane) |
| `approve` | exactly `pipeline.awaiting_approval`'s inputs: `plan.json` `automatic.finish == "approval"` plus exactly one `integration_approval` interrupt with a 64-hex `bundle_sha256` in `run-state.json` tasks, and the run status `awaiting_approval`. The argv carries that digest ([L1] 1); the dialog shows its first 12 characters |
| `repair_session` | an automatic run, the `handoff` node `succeeded` (frozen), no `review.json`, the `review` node `pending`, and a `verify_<lane>` (or `candidate`) node `failed` — the signals `contracts/projects/triage.ts` `identicalLanes` reads for its repair NextStep. `lane` choices: the failed verify lanes |
| `abandon` | not abandoned (`abandon.json` or a `cancelled` status), status not `succeeded` |
| `clean` | status `succeeded` (also an accepted run) or `cancelled`/abandoned |

The lane list is `plan.json` `workers`, else the export's `selected_workers`. `BUSY` covers a short control in flight and a long control from
the accepted request until its spawn returns and the `running` record is written ([L3]); the spawner may be asynchronous for exactly that reason.

## Changes in run-controls-003 ([L6], server half)

- 1: the stored jsonl line carries `argv` (the command and args the server ran, home as `~`, token as `[token]`) and `unit` (`mdm-control-<hash>-<n>` for a long control in systemd mode, else `null`). `storedRecordSchema` (the strict record plus the two keys) is used by `write`, `fold` and `recoverLost`; `list`/`get`/`byRequest` strip them, so Appendix A and the examples are unchanged. `lost` recovery keeps both.
- 2: allowed hosts, amended by [L7] (above).
- 3: argv forms `answer <run> <lane> --by operator -- <text>`, `abandon <run> --reason=<text> --by operator`, `resume <run> --accept-challenge=<text> --by operator`; the displayed `command` follows. The viewer's `fake-controller.py` and fixtures must use these forms.
- 5: a `running` record read returns `output_tail` from its log at that moment (last 40 lines, redacted, bounded read, missing log `[]`); the final write replaces it.
- 6(a): `HEAD` needs the token on every route but `GET /status`. 6(b): a test shows a refused command (exit 1) is spawned once.

## Decisions applied

- [L1] 2: long controls run as `systemd-run --user --scope --collect --unit=mdm-control-<hash>-<n> --working-directory=<MD_MANAGER_WORKFLOW_HOME> -- <argv>`,
  a detached child of the API with stdout and stderr appended to the record's log. **Acceptance 4 of the task still says "the exact `systemd-run --user --collect ...` argv of PRD 5.4": this is the form built, per [L1] 2 and design note 5** (the PRD's `--property=StandardOutput=append:` service form cannot report an exit status to the API). The unit is `mdm-control-<first 8 hex of sha256("project/workflow/run")>-<records in the run's file + 1>`. The exit status comes from the child, so a `running` record becomes `succeeded` or `failed`; an API restart marks every `running` record `lost`.
  The scope also carries `--property=OOMPolicy=continue` before `--` (ux-critique-fixes-c), so the kernel's OOM kill of one check inside it no longer stops the scope and the supervisor running in it.
- [L1] 5: with `MD_MANAGER_CONTROLS_PROC` set and no kill injected, `pause` records `succeeded` with `SIGINT to group <n> (test /proc: not sent)` and never calls `process.kill` (a test spies on it).
- [L2], [L3], [L4], [L5]: as the task describes; each has a test (`controls.test.ts`: `[offer][L2]`, `[L3]`, `[L4]`, `[L5]`).
- Design note 2 (the lock probe's device decoding): `deviceNumbers` decodes `statSync(path, {bigint: true}).dev` with the kernel's split. The note's text writes the high masks as `~0xfffn` / `~0xffn`; on a BigInt those let the other field's high bits through (a test caught 4660:4295041861 for 4660:74565), so the masks are 32-bit (`0xfffff000n`, `0xffffff00n`) as in glibc. `[probe]` tests cover 252:1, a tmpfs minor above 255 and a real `flock <file> sleep` held on the real `/proc` (read only; skipped without `/proc/locks` or `flock`).
- Design note 4: `MD_MANAGER_WEB_PORT` (see above), with guard tests for the accepted and a refused port.

## Open P2

1. ~~Texts that begin with `-`~~ fixed by [L6] 3 (`--` and `--flag=<text>`).
2. **`accept_challenge` "no pinned feature file is edited".** Not checked: the pins are digests the controller compares, and the controller refuses a resume over an edited pin. The button may show where the controller will refuse.
3. **`refused` records.** PRD 5.2 says a guard refusal records nothing but a log line; Appendix A lists `refused` for "5.2 or a failed spawn". Only a failed spawn writes a `refused` record.
4. **`lost` is unconditional.** The API restarts mark every `running` record `lost` even if its unit is still alive (the transient scope outlives the API, but nothing observes its exit any more). The page tells the operator to check `systemctl --user status 'mdm-control-*'`.
5. **Reconcile signals** are heuristics (a `launch_*` node still in `next`, a receipt at `needs_reconciliation`, a recent event naming reconcile); `reconcile` refuses the rest.
6. **Supervisor reason.** The design challenge's own "L6" label (not decisions.md's [L6] of run-controls-002; the exact `A supervisor is running (since HH:MM UTC)` text and its precedence) was recorded in the design challenge, not in `decisions.md` here. The server follows the recommendation; the viewer should assert the prefix `A supervisor is running`.
7. **Start time** comes from `/proc/<pid>/stat` field 22 and `btime`, at 100 clock ticks per second; a holder whose stat cannot be read has no `supervisor_since` and reads `A supervisor is running` without a time. `pause` is refused for such a holder.
8. **`BUSY` is checked after the stale-state check** (a stale page that also races another control reads `STATE_CHANGED` first); the slot itself is taken synchronously, so two simultaneous requests cannot both run.
9. **`npm run preview`** serves on 4173 and a phone uses a name other than a loopback forward: `MD_MANAGER_WEB_PORT` must match the page's port (Origin) and no other host is allowed (documented in the RUNBOOK).
10. **Not run here:** a real `systemd-run`, a real controller, the Vite proxy and a browser. The viewer's candidate check proves the lanes agree.

## ux-critique-fixes-c: Retry all failed checks and Relaunch a lane (controls 1.1.0)

- Two controls follow `clean` (`CONTROL_IDS` 14, `CONTROLS_VERSION` 1.1.0): `retry_all` runs `-m workflow retry <run> --phase worker --all-failed --by operator` (short, plain, no parameter; offered under Retry's rules when `retryTargets` hold two or more distinct worker-phase lanes, else "Fewer than two worker checks failed"; its `effect` names Restart supervisor as what reruns them), and `relaunch` runs `-m workflow relaunch <run> <lane> --by operator` (short, plain, parameter `lane`; the choices are the lanes whose `launch_<lane>` is in `next`, whose `<lane>.interactive.json` is absent or `needs_reconciliation`, with no completion, handoff or stop file; else "No lane launch is waiting to be relaunched"; its `effect` names Reconcile launches and then Restart supervisor).
- `POST …/relaunch-preview` `{run_state_token, lane}` runs the dry run (`relaunch <run> <lane> --dry-run --by operator`) through `Runner.captureStreams` and answers `{exitCode, line}` (stdout's first line, else stderr's `Blocked:` line); no record, no request_id, the state token checked as for `clean-preview`, a lane outside the choices 400. The dialog enables Confirm only on exit 0 for the lane and token chosen now (`controls/model.ts` `relaunchConfirmable`, `answerCheck`). A confirmed relaunch runs alone; the viewer runs no reconcile or supervisor after it.
- Capability read: `readCapabilities` runs `retry --help` and `relaunch --help` once when the routes start (controls enabled only), through the injected runner, cached for the process (a failed read included); no controls GET spawns anything. An absent command greys its control with "This controller has no `retry --all-failed` (workflow-collected-fixes is not merged)" / "This controller has no `relaunch` command (workflow-collected-fixes is not merged)".
- Long controls' scopes carry `--property=OOMPolicy=continue` before `--` (see [L1] 2 above).
