# PRD: Run controls (stop, restart, retry and resume a workflow run from the run page)

Status: Draft 2026-10-10, written unattended for the operator's request of 2026-10-09: "Add controls in the md manager like stop and replay or like which may help in resuming the workflow?". Not grilled: section 11 lists the open decisions, each with a recommended default; `/workflow-grill run-controls` settles them into `features/run-controls/decisions.md`. Ships as feature `run-controls`, two lanes: `server` and `viewer` (section 8).

## 1. Problem

The Projects viewer is read-only for runs. Its server writes only Markdown (`PUT /api/file`, `POST /api/mutate` in `server/app.ts`); the Projects API (`server/projectRoutes.ts`) answers GET and HEAD and returns 405 for everything else. When a run stops, stalls or waits, the run page's live dock says why and prints the next command with a Copy button (`src/projects/CommandBlock.tsx`, "Run these in your terminal; this viewer never changes a run"). The operator then has to reach a terminal on the VM, set `PY` and `RUN`, open a Herdr tab and paste. From the phone, through the Mac tunnel, there is no way to act at all.

Runs stop for reasons that need one mechanical command far more often than a decision. From the run issue log (shared learnings `md-manager-run-issues-log.md`, section C and G) and the RUNBOOK ("Status, failures and recovery"):

| What happened | How it was resumed | Who may run it |
|---|---|---|
| Freeze failed: `termination is not established` (004, 005, 006) | marker file, then `automatic --live` | maintainer |
| A verify setup failed identically twice (environment, 004) | fix the host, then `retry --phase worker --node <lane>` for each lane, then `automatic --live` | maintainer |
| Disk/inode exhaustion, every verify task failed (006) | free space, `retry` each failed lane, `automatic --live` | maintainer |
| Claude Code unavailable (exit 75), an update or service restart | wait for `claude --version`, then `automatic --live` | maintainer |
| Source checkout left the run's branch (`interrupted`) | switch it back, then `automatic --live` | maintainer |
| Ambiguous startup | inspect receipts, `reconcile`, then `automatic --live` | maintainer |
| A candidate check failed on a real cross-lane bug (004) | `repair --workspace`, commit, `--commit`, `automatic --live` | operator |
| Design challenge paused or held | edit and `resume`, or `resume --accept-challenge "<reason>"`, or `resume --launch` | operator (panel: accept) |
| A worker asks a question | `answer <lane> "<text>"` | operator (panel) |
| An automatic run stops for approval | `approve` | operator (panel) |
| A run that will not go on | `abandon --reason`, then `clean` | operator |
| The operator wants to stop a supervisor now | Ctrl-C in its Herdr tab; later `automatic --live` | anyone at the terminal |

Every row ends with the same few commands. The viewer already knows which one applies (the dock's `NextStep`, `contracts/projects/triage.ts`). What is missing is a guarded way to run it from the page and see what it did.

"Replay" in the request: the repository's `workflow/replay.py` replays recorded *reviews* with a new reviewer brief to measure it; it does not continue a run. Re-running a finished or abandoned run is a follow-up run (`brief`, then `launch --follows`). Both are covered in section 9 (out of scope for this feature, with the reasons) and in grill question G6.

## 2. Outcome

On a machine where the operator turned run controls on (off by default, section 5.1), the run page offers the controls that apply to the run's current state, beside the commands it prints today:

- the dock's recommended command gets a **Run** button next to Copy when it maps to a control;
- a **Controls** menu on the run page lists every control with whether it is available now and, when not, why;
- each control opens a confirmation that shows the exact command it will run, what it does and what it does not do; destructive ones ask for the run id typed;
- after a click the page shows the control's progress and result (exit code, the last lines of output, the controller's own refusal text when it refused), and the run's timeline shows the controller's own `<Action> by the operator` event as today;
- every control runs the existing controller command, as the operator (`--by operator`), with the same refusals: the viewer adds no new run behaviour, only a guarded way to start what the CLI already does.

## 3. Principles

1. **The controller stays the judge.** The server maps a control to one fixed `python -m workflow ...` argv and runs it. It never edits run files, never writes a marker, never decides what the controller refuses. Its own availability rules are a convenience that hides buttons that would certainly be refused; the controller's locks and refusals are the guarantee. A refused command is shown with the controller's `Blocked:` text.
2. **A closed table, never a command line.** The request names a control id and typed parameters (a lane from the run's plan, a phase from a fixed set, free text as one argv element). No shell, no request-supplied path, flag or executable. The run directory comes from the registry (`runs_root/<run_id>`), as the read API resolves it.
3. **The operator's actor only.** Every control passes `--by operator`; the viewer is the operator's console. Maintainer and panel actions stay with their sessions.
4. **Same guard as the CLI plus the browser's.** A process of the operator's own account can already run the CLI, so the guards are against what a browser adds: other sites (CSRF), DNS rebinding, an exposed port, a second tab, a double click.
5. **Long-running commands outlive the viewer.** `automatic --live`, `resume` and `repair --session` run for hours; a viewer restart (the dashboard service runs `tsx watch` and restarts on file changes) must not kill them.

## 4. The controls

Each control: the command (with `PY` = `MD_MANAGER_WORKFLOW_PYTHON`, run from `MD_MANAGER_WORKFLOW_HOME`, and `RUN` = the run directory), when the server offers it, the confirmation, and how it runs (`short`: a child of the server with a timeout; `long`: a transient user unit, 5.4).

| Id | Label | Command | Offered when | Confirm | Runs |
|---|---|---|---|---|---|
| `restart` | Restart supervisor | `$PY -m workflow automatic "$RUN" --live --by operator` | an automatic run, not finished, not abandoned, no supervisor running (5.3), no repair `recorded` | plain | long |
| `pause` | Pause supervisor (workers keep running) | SIGINT to the supervisor's process group, as Ctrl-C in its terminal (5.3) | a supervisor of this run is running | plain | signal |
| `retry` | Retry a check | `$PY -m workflow retry "$RUN" --phase <worker\|candidate> --node <lane> --by operator` | a lane's verify or candidate step failed or was interrupted without a verdict (`run-state.json` errors), no supervisor running | plain, lane and phase chosen | short |
| `reconcile` | Reconcile launches | `$PY -m workflow reconcile "$RUN" --by operator` | the run is at `needs_reconciliation` or an `interrupted` event names reconcile, no supervisor running | plain, with the RUNBOOK's "inspect receipts first" | short |
| `resume` | Rerun the design challenge | `$PY -m workflow resume "$RUN" --by operator` | the latest challenge record is paused, held, or an interrupted rerun; no controller running | plain | long |
| `accept_challenge` | Accept the challenge | `$PY -m workflow resume "$RUN" --accept-challenge "<reason>" --by operator` | the latest challenge record is paused and no pinned feature file is edited | reason (required, 10 to 500 chars) | long |
| `release_hold` | Launch the workers | `$PY -m workflow resume "$RUN" --launch [--drop N,M] --by operator` | the challenge passed and is held | plain, optional notes to drop (choices from the held attempt) | long |
| `answer` | Answer the question | `$PY -m workflow answer "$RUN" <lane> "<text>" --by operator` | a lane has an unanswered question | text (required, 1 to 4000 chars) | short |
| `approve` | Approve and integrate | `$PY -m workflow approve "$RUN" --by operator` | the run waits at `approval` (`awaiting_approval`) | typed run id | short |
| `repair_session` | Repair a lane | `$PY -m workflow repair "$RUN" <lane> --session --live --by operator` | an automatic run blocked at a check verdict after freeze, before review, no supervisor running | typed run id, lane chosen | long |
| `abandon` | Abandon the run | `$PY -m workflow abandon "$RUN" --reason "<reason>" --by operator` | not abandoned, not integrated, no controller running | typed run id and reason | short (bounded 5 min) |
| `clean` | Clean worktrees | first `$PY -m workflow clean "$RUN" --by operator --dry-run` (shown), then without `--dry-run` | the run is finished or abandoned and no controller running | dry-run output shown, typed run id | short |

The `Offered when` column is the server's advisory rule (principle 1). Its inputs are the run's files the read API already reads (`plan.json`, `run-state.json`, `events.jsonl`, `attention.json`, `abandon.json`, `repairs.json`, `challenge.json`, `<lane>.questions.json`) plus the lock probe of 5.3. A control the rule does not offer is listed as unavailable with the reason (`A supervisor is running (since 10:42)`, `The run was abandoned`, `No lane has an unanswered question`). The recommended control is the one whose command equals the dock's `NextStep` first command.

What each control does not do, said in its confirmation:

- `pause` does not stop the workers or reviewers: their sessions keep running and a later `restart` waits for them again. To stop everything, `abandon`.
- `restart` relaunches nothing the controller has a receipt for; it continues from the checkpoint.
- `retry` raises an attempt; on an automatic run it prints the restart command, so the dialog offers `restart` next.
- `abandon` stops every recorded session and closes the run for good; worktrees and evidence stay until `clean`.
- Fixes that need edits (a marker file, a lock file, a host fix, a task edit before `resume`) stay in the terminal; the dock keeps printing them.

## 5. Safety

### 5.1 Off by default, on for one host

Controls exist only when the API starts with `MD_MANAGER_RUN_CONTROLS=on`, an absolute `MD_MANAGER_WORKFLOW_PYTHON` and `MD_MANAGER_WORKFLOW_HOME`, and a readable pairing token file (`MD_MANAGER_CONTROLS_TOKEN_FILE`, default `~/.config/md-manager/controls.token`, mode 0600, at least 32 characters). Otherwise every control route answers 404 `CONTROLS_DISABLED` and the page shows no control (the read-only viewer, unchanged). The server refuses to enable controls (a startup warning, controls off) when it listens on a non-loopback address.

### 5.2 Every control request

A `POST` is accepted only when all hold, else it is refused before anything runs, with a stable code and nothing recorded but a refused line in the server log:

1. `Content-Type: application/json` (a cross-site form cannot send it without a CORS preflight, which the server never answers with an allow).
2. `Host` is one of the allowed hosts (`127.0.0.1:<web port>`, `localhost:<web port>`, the API's own, plus `MD_MANAGER_CONTROLS_HOSTS`), which defeats DNS rebinding.
3. `Origin` is present and is `http://<allowed host>`; `Sec-Fetch-Site`, when the browser sends it, is `same-origin`.
4. `X-MDM-Control-Token` equals the pairing token (constant-time compare). The page asks for it once ("Pair this browser": paste the token) and keeps it in `localStorage`; a wrong token is 403 and the page asks again.
5. `request_id` is a fresh UUID; a repeated `request_id` returns the first request's record and runs nothing (a double click, a retried fetch).
6. `run_state_token` equals the server's current token for the run (a digest of the export's `updated_at`, the last event sequence and the questions and attention states): a run that moved since the page rendered is 409 `STATE_CHANGED` ("The run changed since you looked; review it and try again").
7. No other control of this run is in flight in this server (409 `BUSY`), and the control is offered now (422 `NOT_AVAILABLE` with the reason).
8. The parameters validate against the control's spec: a lane among the plan's selected lanes, a phase among `worker`/`candidate`, text within its length, no NUL, the typed run id equal to the run id.

The pairing token file is a secret: the server never logs it, never returns it, and the page never shows it after pairing.

### 5.3 A live controller

Before offering `restart`, `retry`, `reconcile`, `resume`, `repair_session`, `abandon` and `clean`, the server probes the run's `automatic-supervisor.lock` and `controller.lock`: it looks up each file's inode in `/proc/locks` (the `flock` the controller takes, `workflow/sessions.py` `run_lock`) and reads the holder's `/proc/<pid>/cmdline`. A held lock is "a supervisor (or controller) is running"; no `/proc/locks` (not Linux) is `unknown`, which offers the control with a warning and leaves the refusal to the controller. The probe reads; it never takes the lock (taking it would make the controller's own `Another controller owns this run` race the viewer).

`pause` signals only a holder whose command line names `-m workflow`, `automatic` (or `launch`, `resume`) and this run's directory, and only its process group, the group a terminal's Ctrl-C reaches; the controller's existing `KeyboardInterrupt` paths record `interrupted` and keep the sessions. A holder that does not match is reported, never signalled.

### 5.4 Running a long command

A `long` control runs as a transient user unit, outside the dashboard service's cgroup, so a restart of the viewer does not kill it: `systemd-run --user --collect --unit=mdm-control-<run-id-hash>-<n> --property=StandardOutput=append:<log> --property=StandardError=append:<log> --working-directory=<MD_MANAGER_WORKFLOW_HOME> -- <argv>`. The environment is the server's minus `CLAUDECODE` (a viewer control is not a Claude Code session, so the controller records no `via: claude-code`). The control record (5.5) keeps the unit name; `systemctl --user status <unit>` and the log are what the page reads for progress. When `systemd-run` is unavailable, long controls are unavailable with that reason and the page keeps the copy command. Short controls run as a child with no shell, a 5-minute bound (killed by process group after it), output to the same log.

Grill question G2 offers a Herdr tab instead of a unit (the operator's habit for long commands).

### 5.5 The record

Each control writes one record to the server's own state, never into the run directory: `<MD_MANAGER_CONTROLS_STATE>/<project>/<workflow>/<run>.jsonl` (default `~/.local/state/md-manager/controls/`), one line per change: `{record_id, request_id, control, params, argv, status, exit_code, unit, started_at, ended_at, output_tail}` with status `running`, `succeeded`, `failed` (non-zero exit; the controller's `Blocked:` line first in `output_tail`), `refused` (5.2 or a failed spawn) or `lost` (a server restart found a `running` record whose unit or process is gone without an exit code). The output tail is the last 40 lines with the home directory replaced by `~` and the pairing token, if it ever appears, replaced by `[token]`. Free text the operator typed is kept, as the controller keeps it in its own records.

## 6. On the run page

- **Run button.** In the dock's command block (`now-command`), when the first command of the `NextStep` maps to an offered control: a `Run` button beside `Copy`. The caption changes from "Run these in your terminal; this viewer never changes a run." to "Run it here, or in your terminal." only when controls are on.
- **Controls menu.** A `Controls` button in the identity line opens a list of the twelve controls: available ones as buttons, unavailable ones greyed with their reason. On a phone it is a bottom sheet.
- **Confirmation.** A dialog: the control's label, the exact command (redacted `$PY ... "$RUN" ...`), what it does and does not do (section 4), the inputs it needs, and Confirm/Cancel. Confirm is disabled until the inputs validate; it is disabled again while the request is in flight (one request per dialog, one `request_id`).
- **Progress and result.** The dock gains a `Controls` row while a record is `running` (`Restart supervisor · running for 2 min`, with its log tail behind a disclosure), then `succeeded`, `failed` (with the controller's first `Blocked:` line) or `lost`. The run's own events keep arriving through the existing polling; a `restart` shows the controller's `Automatic by the operator` event as today.
- **History.** Run Details lists this run's control records, newest first.
- **Pairing.** With controls on and no token in this browser, the menu shows "Pair this browser" and a token field; nothing else.
- **Off.** With controls off, the page is byte for byte today's: no Run button, no menu.

## 7. Test plan

Server lane (`server/controls.test.ts`, `tests/unit` where shared; no real `systemd-run`, no real controller, every path under a temporary root):

1. Each control's argv for given parameters, asserted in full; free text stays one element; a lane not in the plan, a phase not in the set, a NUL, an over-long text and a wrong typed run id are 400.
2. The guards of 5.2, each alone: wrong content type, foreign Host, missing or foreign Origin, `Sec-Fetch-Site: cross-site`, missing and wrong token, repeated `request_id` (one spawn, same record), stale `run_state_token` (409), a second control in flight (409), a control not offered (422). Controls off: every route 404 and the read API unchanged.
3. The lock probe against a fake `/proc` (an injected reader): held, free, unknown; `pause` signals only a matching holder's group (an injected `kill`), never a non-matching one.
4. Long controls build the exact `systemd-run` argv (injected spawner); the record goes `running` to `succeeded`/`failed` from the unit's exit; a restart of the server marks a gone unit `lost`.
5. The availability rules of section 4 on seeded run directories in each state of section 1's table.
6. The contract (Appendix A) validates every route's payload; the read-only Projects API still answers 405 to POST.

Viewer lane (`tests/unit/controls.test.ts`, browser spec `tests/project-workflows/controls.spec.ts`): the scenarios in `features/run-controls/policy.json`, worker phase against mocked control routes from Appendix A's examples, candidate phase against the real backend with the fake controller (Appendix A.3). The critique reviewer walks the viewer lane's `## Goal` and `verify_yourself` flows against the app started by `critique_app`.

## 8. Lanes

- **`server`** owns `server/controls.ts`, `server/controlsGuard.ts`, `server/controlsRunner.ts`, `server/controls.test.ts`, `server/app.ts` (registering the routes), `server/index.ts` (the environment), `contracts/projects/controls.ts`, `contracts/projects/contract.test.ts`, `contracts/projects/examples.ts` (control examples), the RUNBOOK and README rows (`workflow/RUNBOOK.md`, `workflow/README.md` documentation only) and `docs/handoff/run-controls-server.md`.
- **`viewer`** owns the run page's control UI (`src/projects/controls/`, the dock and identity-line hooks in `src/projects/signal/LiveDock.tsx`, `src/projects/signal/IdentityLine.tsx`, `src/projects/signal/signal.css`, `src/projects/CommandBlock.tsx`), its tests (`tests/unit/controls.test.ts`, `tests/project-workflows/controls.spec.ts`), the browser fixtures (`tests/project-workflows/fixtures/controls.ts`, `fixtures/index.ts`, `mock.ts`), the critique app script and the fake controller (`tests/project-workflows/controls-app.ts`, `tests/project-workflows/fake-controller.py`), `tests/project-workflows/playwright.config.ts` (the control environment) and `docs/handoff/run-controls-viewer.md`.

`features/run-controls/policy.json` is the authority for both lists.

Both build against Appendix A. Lanes meet only at the candidate, so in the worker phase the viewer lane mirrors Appendix A's types in `src/projects/controls/types.ts` and mocks the routes; the candidate's browser check against the real backend proves they agree (grill question G1 offers committing the contract before launch instead).

## 9. Out of scope

- **Review replay** (`workflow/replay.py`): a measurement tool for briefs, run on copies; not a run control.
- **Launching runs** from the viewer, including a follow-up run (`launch --follows`): it needs task edits and a commit first; the page keeps printing `brief` and the launch command.
- **Edits**: marker files (`freeze-interrupted.json`), deleting a stale `.lock`, editing tasks or `decisions.md` before `resume`, `repair --workspace`/`--commit` (a commit made by hand).
- `freeze`, `note`, `tryout`, `attack-pass`, `attack-label`, `sidecar-pass`, `browser-queue`, `presence`: possible later controls (grill question G5).
- A stop that stops the sessions but keeps the run resumable: the controller has no such command; `pause` plus `abandon` are what exists.
- Maintainer or panel actions from the viewer; multi-user accounts; any network exposure beyond loopback and the operator's tunnel.
- Engine changes: none. Every control runs an existing command.

## 10. Risks

- **A button makes a decision too easy.** `approve`, `abandon`, `repair_session` and `clean` ask for the run id typed; `accept_challenge` for a reason. The panel and the maintainer are unaffected.
- **Stale page.** The `run_state_token` refuses a control on a run that moved; the controller's own refusals remain.
- **A same-account process can call the API.** It can already run the CLI; the pairing token keeps browsers out, not the operator's own processes (a worker session runs as the operator; RUNBOOK "What a worker can reach").
- **Transient unit leftovers.** `--collect` removes a finished unit; a unit still running when its run is abandoned is the controller's to stop (abandon refuses while it holds the lock).
- **Cost.** `restart`, `resume` and `repair_session` start model sessions. That is what the operator asks for by clicking; the confirmation says it.

## 11. For the grill

Each question has a recommended default; the grill records the operator's choice in `decisions.md`.

- **G1. How the two lanes share the contract.** (a) **Recommended:** one run, both lanes in parallel; the viewer lane mirrors Appendix A's types and mocks the routes in the worker phase; the candidate's real-backend browser check proves agreement. (b) The operator commits `contracts/projects/controls.ts` from Appendix A on the branch before launch, so both lanes import it (a one-file code commit outside a run). (c) Two runs, server first (as user-critique did); the critique cannot run on the server-only run (its `critique.lanes` must be selected), so the first run would need a feature.json without `critique`.
- **G2. Where long commands run.** (a) **Recommended:** a transient user unit (`systemd-run --user`), survives viewer restarts, log on the page. (b) A new Herdr tab `Workflow: <run-id>` running the command (the operator's habit, watchable; needs the server to reach Herdr from the service and a fallback when it cannot). (c) Both: a Herdr tab when reachable, else a unit.
- **G3. Pairing.** (a) **Recommended:** the token file plus Origin/Host checks (5.2). (b) Origin/Host checks only (simpler; any page that defeats them could run a control). (c) A token per action shown in the server log (strongest, clumsy from the phone).
- **G4. Which controls in the first cut.** (a) **Recommended:** the twelve of section 4. (b) Only the mechanical ones (`restart`, `pause`, `retry`, `reconcile`) and `answer`; decisions (`approve`, `accept_challenge`, `release_hold`, `repair_session`, `abandon`, `clean`) stay in the terminal.
- **G5. Later controls.** (a) **Recommended:** none now; record `freeze` (manual runs), `note`, `tryout` and a follow-up `launch` as follow-ups. (b) Add `note` and `tryout` now (both short, low risk).
- **G6. "Replay".** (a) **Recommended:** read it as "continue or run again": `restart`/`resume` continue; running again is a follow-up run, out of scope (section 9). (b) Add a "Prepare follow-up" control that runs `brief` and shows its Markdown on the page (read-only, no launch).
- **G7. Critical and tryout.** (a) **Recommended:** `critical: true` (the feature runs controller commands from a browser; an automatic run stops after review for your `approve`) and `tryout: true` (user-facing). (b) Leave both false, as `feature.json` ships now.
- **G8. Through the Mac tunnel.** (a) **Recommended:** allowed hosts are loopback on the web port only; the tunnel forwards to the same port, so its Origin is `http://localhost:5173` and passes. (b) Also allow named hosts (`MD_MANAGER_CONTROLS_HOSTS`) for another forward.

## Appendix A: the control API (contract 1.0.0, `contracts/projects/controls.ts`)

Mounted at `/api/run-controls`, outside `/api/projects` (which stays read-only). Errors are `{ error: { code, message } }` as the Projects API's; no path or token in any body.

### A.1 Routes

```text
GET  /api/run-controls/status
     -> { version: "1.0.0", enabled: boolean, paired: boolean }        (paired: the X-MDM-Control-Token header matches; false without it)
GET  /api/run-controls/:project_id/:workflow_id/:run_id                (token header required)
     -> RunControls
POST /api/run-controls/:project_id/:workflow_id/:run_id/:control_id    (guards of 5.2)
     body: { request_id: uuid, run_state_token: string, params: Params }
     -> 202 { record: ControlRecord }  (long control started)  |  200 { record: ControlRecord }  (short control ended)
GET  /api/run-controls/:project_id/:workflow_id/:run_id/records/:record_id   (token header required)
     -> { record: ControlRecord }
```

Codes: 404 `CONTROLS_DISABLED`, 404 `NOT_FOUND`, 400 `INVALID_PARAMS`, 400 `INVALID_ID`, 403 `FORBIDDEN_ORIGIN`, 403 `TOKEN_REQUIRED`, 403 `TOKEN_INVALID`, 409 `STATE_CHANGED`, 409 `BUSY`, 415 `UNSUPPORTED_MEDIA_TYPE`, 422 `NOT_AVAILABLE`, 500 `SPAWN_FAILED`.

### A.2 Types

```ts
type ControlId = 'restart' | 'pause' | 'retry' | 'reconcile' | 'resume' | 'accept_challenge' | 'release_hold'
  | 'answer' | 'approve' | 'repair_session' | 'abandon' | 'clean'

type RunControls = {
  version: '1.0.0'
  run_state_token: string                       // opaque, 1-128 chars
  supervisor: 'running' | 'not_running' | 'unknown'
  supervisor_since: string | null               // ISO time the lock holder started, when known
  controls: Control[]                           // all twelve, in the order of section 4
  records: ControlRecord[]                      // this run's, newest first, at most 20
}

type Control = {
  id: ControlId
  label: string
  available: boolean
  reason: string | null                         // null when available
  recommended: boolean                          // equals the dock's NextStep first command
  command: string                               // redacted display: $PY -m workflow ... "$RUN" ... --by operator
  runs: 'short' | 'long' | 'signal'
  confirm: 'plain' | 'typed_run_id'
  params: ParamSpec[]
  effect: string                                // what it does, one sentence
  not_effect: string | null                     // what it does not do (section 4), one sentence
}

type ParamSpec =
  | { name: 'lane'; kind: 'choice'; choices: string[]; required: true }
  | { name: 'phase'; kind: 'choice'; choices: ('worker' | 'candidate')[]; required: true }
  | { name: 'drop'; kind: 'multi'; choices: number[]; required: false }
  | { name: 'text' | 'reason'; kind: 'text'; min_length: number; max_length: number; required: true }
  | { name: 'confirm_run_id'; kind: 'typed'; required: true }

type Params = { lane?: string; phase?: 'worker' | 'candidate'; drop?: number[]; text?: string; reason?: string; confirm_run_id?: string }

type ControlRecord = {
  record_id: string                             // 'c-' + 12 hex
  request_id: string
  control: ControlId
  params: Params                                // confirm_run_id left out
  command: string                               // redacted display, as Control.command with the parameters
  status: 'running' | 'succeeded' | 'failed' | 'refused' | 'lost'
  exit_code: number | null
  started_at: string
  ended_at: string | null
  output_tail: string[]                         // at most 40 lines, home as ~, the token as [token]
}
```

### A.3 Environment

| Variable | Meaning |
|---|---|
| `MD_MANAGER_RUN_CONTROLS` | `on` enables controls; anything else or unset: off |
| `MD_MANAGER_WORKFLOW_PYTHON` | absolute path of the Python that runs `-m workflow` |
| `MD_MANAGER_WORKFLOW_HOME` | absolute directory the commands run from (md-manager's checkout) |
| `MD_MANAGER_CONTROLS_TOKEN_FILE` | the pairing token file (default `~/.config/md-manager/controls.token`) |
| `MD_MANAGER_CONTROLS_STATE` | where records go (default `~/.local/state/md-manager/controls`) |
| `MD_MANAGER_CONTROLS_HOSTS` | extra allowed `host:port` values, comma-separated |
| `MD_MANAGER_CONTROLS_SPAWN` | `systemd` (default) or `direct` (tests and the critique app only: long controls run as a detached child) |
| `MD_MANAGER_CONTROLS_PROC` | the `/proc` root the lock probe reads (tests only) |

The fake controller for browser checks and the critique app (`tests/project-workflows/fake-controller.py`, standard library) is set as `MD_MANAGER_WORKFLOW_PYTHON`: it appends its argv to `$MD_MANAGER_FAKE_CONTROLLER_LOG`, prints a canned line per action (`Automatic by the operator`, or `Blocked: <text>` for a run id containing `refuse`), sleeps 3 seconds for `automatic` so a `running` record is visible, and exits 0 or 1 accordingly. It never touches a run directory.

## Amendment (2026-10-16, docs/PRD_RUN_TEAMS.md "Steering" and "GitHub actions"): `note` and the GitHub family

**Contract 1.2.0** appends a fifteenth control, `note` ("Send a note to the lead"), after `relaunch`; the first fourteen keep their order.

- It runs `$PY -m workflow note "$RUN" <lane> --by operator -- "<text>"` (short, plain confirm). The text is 1 to 2000 characters and travels after `--`, one argv element.
- Effect: "Types your note into the lane's lead session between its turns and records it in <lane>.notes.json." Not: "It does not interrupt a running tool call; a team workflow that is running takes no input until it returns."
- Offered for the lanes `workflow note` would accept as far as the server can see (workflow/sidecar.py `refusal`): a launch receipt and no stop, handoff or completion file, before freeze (no `snapshots.json`, no closed sidecar ledger), no unanswered question (answer it instead), the run neither abandoned nor accepted, and, like Answer, a Herdr pane for the lane (`HERDR_ENV=1` and `terminals.json`). It needs no quiet run: a note reaches a lead while the supervisor runs. The controller still decides; a pane that is busy or detached is recorded `undeliverable` by `note` itself and shown as a failed record.

**The GitHub family** (`contracts/projects/github.ts`, `runGithubActionsSchema` 1.0.0, `server/githubActions.ts`) lives in the same scope, so guards 1 to 4 apply unchanged, and shares the one-in-flight-per-run rule (409 `BUSY`) with the controls:

- `GET /api/run-controls/:p/:w/:r/github` serves the four actions (`push_branch`, `open_pr`, `mark_ready`, `request_reviewers`), a `state_token` (a digest of the branch's local, tracking and GitHub shas and the pull request's number, state, draft flag and head) and the last 20 records.
- `POST .../github/:action_id` takes `{ request_id, state_token, params }`: a repeated `request_id` answers the first record; a stale token is 409 `STATE_CHANGED`; an unavailable action is 422 `NOT_AVAILABLE`; parameters outside the offered spec, or a typed `confirm_repo` that is not exactly the repository's `owner/name`, are 400 `INVALID_PARAMS`.
- Principle 1 holds: each action maps to one fixed argv, `$PY -m workflow github push|pr|ready|reviewers "$RUN" --repo <registered repository> ... --by operator` (workflow/github.py, RUNBOOK "GitHub actions"). The server never runs git or gh for a write. The sha and the pull request number come from the run's GitHub read, never from the request; the controller checks them again.
- Off unless the API starts with `MD_MANAGER_GITHUB_ACTIONS=on` (A.3) and run controls are on. Off, every action is unavailable with "GitHub actions are off on this dashboard: start it with MD_MANAGER_GITHUB_ACTIONS=on".
- A PUBLIC repository, or one whose visibility is unknown, asks for its `owner/name` typed before a push or a pull request; mark ready and request reviewers are plain.
- The `open_pr` body is written to a mode-600 file beside the records for `--body-file` and removed when the command ends; records keep `body_chars`, never the body. Records are `<MD_MANAGER_CONTROLS_STATE>/<p>/<w>/<run>.github.jsonl`; output is capped at 40 lines with home as `~`, the pairing token as `[token]`, and URL credentials (`https://user:token@`) cut, which now applies to every control's output.
