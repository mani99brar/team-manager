# run-controls

The run page runs the controller's own recovery and decision commands (restart or pause the supervisor, retry a check, reconcile, resume or accept the design challenge, release a hold, answer, approve, repair a lane, abandon, clean) as the operator, behind pairing, origin, host and stale-state guards, and shows each control's progress and result. Off by default; no engine change. Specification: `docs/PRD_RUN_CONTROLS.md`. Two lanes, `server` and `viewer`, in one run (PRD section 8, grill question G1); the critique reviewer walks the `viewer` lane's flows.

- `feature.json` 2.9.0: the lanes, their task files, the reviewers, the `prd`, `critique` on the `viewer` lane, `critical` and `tryout` (both false until the grill settles G7).
- `policy.json` 1.4.0: each lane's owned paths and checks, the browser scenarios, and `critique_app` (`tests/project-workflows/controls-app.ts`, written by the `viewer` lane, ready at `/api/run-controls/status`).
- `server-task.md`, `viewer-task.md`: the lanes' tasks as outcome briefs.
- `decisions.md`: not yet written. `/workflow-grill run-controls` writes it from PRD section 11 ("For the grill").

Launch: `python -m workflow launch run-controls --repo <this repository> --dry-run`, then `--live --automatic --by operator`.
