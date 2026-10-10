# Decisions: run-controls

From the grill session of 2026-10-10 with the operator.

## Operator decisions

- [O1] Grill 2026-10-10: the operator delegated every open question to the PRD's recommended defaults (`docs/PRD_RUN_CONTROLS.md` section 11, G1 to G8), recorded below as [G1] to [G8]; the delegation covers those eight items only. Operator: "Take all PRD defaults (Recommended)" (asked: "Build the run-controls UI now as a workflow run. How should its decisions be settled?"; operator's request: "We need to build the UI now").

## Grill defaults

- [G1] PRD G1 (a): one run, `server` and `viewer` lanes in parallel; the viewer lane mirrors Appendix A's types and mocks the routes in the worker phase; the candidate's real-backend browser check proves the two agree.
- [G2] PRD G2 (a): long commands (`restart`, `resume`, `accept_challenge`, `release_hold`, `repair_session`) run as transient user units (`systemd-run --user`), survive viewer restarts, and show their log on the page.
- [G3] PRD G3 (a): pairing is the token file plus Origin/Host checks (PRD 5.2).
- [G4] PRD G4 (a): the first cut has all twelve controls of PRD section 4.
- [G5] PRD G5 (a): no later controls now; `freeze` (manual runs), `note`, `tryout` and a follow-up `launch` are recorded as follow-ups.
- [G6] PRD G6 (a): "replay" means continue or run again: `restart`/`resume` continue; running again is a follow-up run, out of scope (PRD section 9).
- [G7] PRD G7 (a): `"critical": true` and `"tryout": true` in `feature.json` (the feature runs controller commands from a browser; an automatic run stops after review for the operator's `approve`, and the operator tries it before integrating).
- [G8] PRD G8 (a): allowed hosts are loopback on the web port only; the Mac tunnel forwards to the same port, so its Origin `http://localhost:5173` passes.

## Changes after launch

- [L1] run-controls-001, design challenge attempt 1 (paused, 5 P1): the challenger's recommendations are adopted; these bind both lanes and win over the PRD and the task files. Operator, 2026-10-10: "Fix the issues ad then ressume".
  1. **approve** runs `$PY -m workflow approve "$RUN" --bundle-sha256 <digest> --by operator`; the server reads the digest from `run-state.json` as `pipeline.awaiting_approval` does (workflow/pipeline.py:1109-1123), never from the request; `approve` is offered only when a digest is present; the dialog shows its first 12 characters. An argv unit test asserts the digest element.
  2. **Long commands** use `systemd-run --user --scope --collect --unit=mdm-control-<hash>-<n> --working-directory=<HOME> -- <argv>`, spawned detached by the server with stdout/stderr appended to the record's log, so the command inherits the server's environment minus `CLAUDECODE` and the server reads the exit status from its own child (a server restart while it runs marks the record `lost`). An argv unit test asserts this argv.
  3. **Appendix A additions.** (a) `POST /api/run-controls/:runId/clean-preview` returns `{exitCode, output}` from `clean --dry-run`; Clean's dialog shows it first. (b) Controls off: `GET /api/run-controls/status` answers 200 `{enabled:false}`, every other run-controls route 404 `CONTROLS_DISABLED`. (c) The server never computes `recommended`; the viewer places Run by matching the dock's NextStep first command verb (and lane) to an offered control. (d) The fake `/proc` follows proc(5): `/proc/locks` lines `<n>: FLOCK  ADVISORY  WRITE <pid> <major>:<minor>:<inode>` (major/minor hex, inode decimal), `/proc/<pid>/cmdline` NUL-separated, `/proc/<pid>/stat` with pgrp field 5 and starttime field 22, `/proc/stat` with `btime <seconds>`.
  4. **Caption and Run button** change only when this browser is paired and a control is offered; an unpaired page keeps today's caption, so `run-now-banner` (tests/project-workflows/ux-run.spec.ts) passes with controls on. In the candidate phase `controls-off` routes only `/api/run-controls/status` to `{enabled:false}` and asserts nothing else is requested.
  5. **pause under a fake /proc:** with `MD_MANAGER_CONTROLS_PROC` set, `pause` never calls the real `process.kill`; it records `succeeded` with "SIGINT to group <n> (test /proc: not sent)". A unit test proves the real kill is never reached.
- [L2] run-controls-001, design challenge attempt 2 (paused, 2 P1 marked `Acts: operator`): the challenge's recommendation for its first P1 is adopted as written; it binds both lanes and wins over the PRD and the task files. The night-shift panel (2026-10-10 14:47Z, Claude and GPT) held the decision for the operator and recommended the same rule; the operator's terminal /goal of 2026-10-10 asked for this run (run-controls-002, `--follows run-controls-001`, Sonnet workers, Opus reviewers and judges). This is the challenge's recommendation, not an approval of it by the operator. It changes the `answer` row of PRD section 4 and keeps [G4] (a): all twelve controls stay in the first cut.
  1. `answer` is offered only when a lane has an unanswered question (unchanged) and the server's own process environment has `HERDR_ENV=1` and the run's `terminals.json` records a pane (an entry with a string `pane_id`) for that lane. Its `lane` choices are the waiting lanes with a recorded pane. Otherwise the control is listed `available: false` with the reason "Typing the answer needs the lane's Herdr pane; answer in your terminal" (a POST is 422 `NOT_AVAILABLE`, nothing spawned). A missing, unreadable or malformed `terminals.json` counts as no pane. The environment is read from the server's own process, never from a request.
  2. The `controls-answer` fixture seeds `terminals.json` with a pane for the waiting lane, and the candidate-phase API environment and the critique app set `HERDR_ENV=1`.
  3. A server test shows `answer` unavailable (exact reason, 422 on POST, nothing spawned) without `HERDR_ENV=1`, and with it but without a recorded pane for the lane; and available with both.
- [L3] run-controls-001, design challenge attempt 2 (paused, 2 P1 marked `Acts: operator`): the challenge's recommendation for its second P1 is adopted as written; it binds both lanes and wins over the PRD and the task files. Same provenance as [L2]: the panel held the decision for the operator and recommended the same narrowing, the operator's /goal asked for the run, and this is not an approval by the operator. It changes guard 7 of PRD 5.2 ("one control in flight per run") and the server task's Goal and Acceptance 2.
  1. 409 `BUSY` applies while a short control of the run is in flight and while a long control of the run is being spawned (from the accepted request until the spawn call, [L1] item 2, returns and the `running` record is written). A `running` record of a long control (`restart`, `resume`, `accept_challenge`, `release_hold`, `repair_session`) does not hold `BUSY`: `pause` and `answer` are accepted while it runs, subject to their own guards.
  2. What `BUSY` no longer decides is decided by the offer rules, the lock probe of PRD 5.3 and the controller's own locks: a second `restart` while the first one's supervisor holds the lock is 422 `NOT_AVAILABLE` ("A supervisor is running"), not 409 `BUSY`.
  3. A server test with a `running` restart record accepts `pause` and `answer` and still refuses a second `restart` as `NOT_AVAILABLE` from the probe, and a test shows `BUSY` while a short control is in flight and while a long control's spawn has not returned.
  4. The viewer shows each control's `available` and `reason` as the server sent them and never disables a control itself because a record is `running`.

## Deferred

- `freeze`, `note`, `tryout` and follow-up `launch` controls [G5].
- Running a run again as a new follow-up run from the page [G6].
- Named hosts beyond loopback [G8].
