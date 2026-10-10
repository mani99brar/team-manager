# Server worker: the run-control API (PRD_RUN_CONTROLS)

## Goal

With `MD_MANAGER_RUN_CONTROLS=on` (and the environment of PRD Appendix A.3), the API serves `/api/run-controls` (PRD Appendix A): for a registered run, the twelve controls of PRD section 4 with whether each is offered now and why not, and a POST that runs exactly one existing `python -m workflow ...` command as the operator (`--by operator`) from a closed table, after the guards of PRD 5.2 (JSON content type, allowed Host, same Origin, the pairing token, a fresh `request_id`, a current `run_state_token`, one control in flight per run, the control offered, validated parameters). Long commands run as transient user units that outlive the viewer (PRD 5.4); `pause` sends SIGINT to the run's supervisor process group only after the lock probe of PRD 5.3 matches it. Every control leaves a record in the server's own state (PRD 5.5) that the run page reads. With controls off, every route is 404 `CONTROLS_DISABLED` and everything else the server does is unchanged; the Projects API under `/api/projects` stays read-only (405 on POST). `docs/PRD_RUN_CONTROLS.md` sections 3 to 5, 7 and Appendix A are the specification; `features/run-controls/decisions.md` records the operator's decisions and wins over the PRD where they differ.

## Context

- Today's server: `server/app.ts` (Fastify, the Markdown write routes, the error shapes), `server/projectRoutes.ts` (the read-only Projects API, `requireId`, the `{ error: { code, message } }` body, 405 for other methods), `server/projects.ts` (`RunStore`: how a run id resolves to `runs_root/<run_id>` through the registry and how run files are read with byte limits), `server/projectsConfig.ts` (the registry), `server/index.ts` (environment, listens on `127.0.0.1`). Resolve the run directory the same way `RunStore` does; never accept a path from a request.
- The commands and their refusals: `workflow/README.md` (the command table) and `workflow/RUNBOOK.md` ("Who acted: --by and notes", "Status, failures and recovery", "Blocked after freeze: repair a lane", "Follow-up runs", "Cleaning up a run"). The run files the offer rules read: `plan.json` (`automatic`, `workers`), `run-state.json` (`next`, `errors`), `events.jsonl`, `attention.json` (`states`), `abandon.json`, `repairs.json`, `challenge.json`, `<lane>.questions.json`, `review.json`, `approval`/integration records. Read them with the same bounded readers `RunStore` uses.
- The controller's locks: `workflow/sessions.py` `run_lock` takes `fcntl.flock` on `<run>/controller.lock` and `<run>/automatic-supervisor.lock`. The probe reads `/proc/locks` (an `FLOCK` line's inode against the file's `stat().ino`, device included) and `/proc/<pid>/cmdline`; read `/proc` under `MD_MANAGER_CONTROLS_PROC` so tests use a fake tree. Never take the lock.
- The viewer lane mirrors Appendix A's types in `src/projects/controls/types.ts` and mocks your routes in its worker phase; the candidate's browser check runs its specs against your real routes with its fake controller (`tests/project-workflows/fake-controller.py`, the `viewer` lane's) as `MD_MANAGER_WORKFLOW_PYTHON` and `MD_MANAGER_CONTROLS_SPAWN=direct`. Match Appendix A exactly: field names, codes, status values.
- Tests isolate every path under a temporary directory and `HOME`: an injected spawner records argv (no real `systemd-run`, no real controller), an injected clock, a fake `/proc`. Never touch the real `~/.config/md-manager/`, `~/.local/state`, `~/.claude` or systemd.

## Constraints

- Owned paths only (policy.json `server`). Do not touch `src`, `tests/project-workflows` or `tests/unit` other than your own test files, `server/projectRoutes.ts` or `server/projects.ts` (read helpers you need from them are imported, not changed; a change you cannot avoid is a `question` completion). Nothing in `workflow/` except documentation in `workflow/RUNBOOK.md` and `workflow/README.md`.
- No shell anywhere: `spawn`/`execFile` with an argv array. Free text is one argv element. The executable is `MD_MANAGER_WORKFLOW_PYTHON`, the working directory `MD_MANAGER_WORKFLOW_HOME`, the child environment the server's minus `CLAUDECODE`.
- The server never writes into a run directory, never deletes a lock or marker, never retries a refused command by itself.
- The pairing token is never logged, returned or written into a record; compare it in constant time.
- No new dependency.

## Acceptance

PRD section 7, server items 1 to 6, each with a test in `server/controls.test.ts` that `frontend-unit` (`npm run test:unit`) runs:

1. Each control's full argv for given parameters; free text stays one element; invalid lane, phase, NUL, over-long text and wrong typed run id are 400 `INVALID_PARAMS`.
2. Each guard of PRD 5.2 alone refuses with its code and spawns nothing; a repeated `request_id` spawns once and returns the same record; a stale `run_state_token` is 409 `STATE_CHANGED`; a second control in flight is 409 `BUSY`; a control not offered is 422 `NOT_AVAILABLE`; controls off answers 404 on every control route while `/api/projects` still answers 405 to a POST.
3. The lock probe (held, free, unknown) on a fake `/proc`; `pause` signals the matching holder's process group with SIGINT and refuses a holder whose command line does not name this run.
4. A long control builds the exact `systemd-run --user --collect ...` argv of PRD 5.4; the record goes `running` to `succeeded` or `failed` from the exit; a server restart marks a `running` record whose unit is gone `lost`; `MD_MANAGER_CONTROLS_SPAWN=direct` runs a detached child instead.
5. The offer rules of PRD section 4 on seeded run directories for: a stopped automatic run, a running supervisor, a failed verify, `needs_reconciliation`, a paused and a held challenge, a waiting question, `awaiting_approval`, a check block after freeze, an abandoned run and a finished run; each unavailable control carries its reason.
6. `contracts/projects/controls.ts` holds Appendix A's zod schemas; `contract.test.ts` validates every example in `contracts/projects/examples.ts` (one `RunControls` per state of item 5 and one record per status) and the routes conform before sending.
7. `workflow/RUNBOOK.md` gains a section "Run controls in the viewer" (how to turn them on, the token file, what each control runs, what stays in the terminal, the same-account caveat of PRD section 10) and `workflow/README.md` a row; `docs/handoff/run-controls-server.md` says what changed and every open P2.

`frontend-build`, `frontend-lint`, `shared-contract` and `frontend-unit` pass.

Run targeted tests while iterating, then this lane's non-browser policy checks once before writing the completion; run browser specs only through check-report on this lane's own specs.

## Stop

Stop and report `question` when a control cannot be offered or refused correctly without changing `server/projects.ts`, `server/projectRoutes.ts` or anything in `workflow/` beyond documentation, or when an existing command's refusal contradicts the PRD's section 4 (name the command and its output). Stop and report `blocked` when the guards of PRD 5.2 cannot all be enforced behind the Vite proxy (say which header is lost). Do not add a control the PRD's section 4 does not list, a shell, or any write into a run directory.
