# run-sessions

Every session of a workflow run is visible on the run page: the reviewers (general, coverage, critique), the multi-provider panel and each lane's lane reviewer as nodes of the stage, a node page for each, a Sessions list with model, cost and a resume command, and the night-shift panel's decisions on the node they decided. Read-only; no engine change. Specification: `docs/PRD_RUN_SESSIONS.md`. Two lanes, `server` and `viewer` (PRD section 7); the critique reviewer walks the `viewer` lane's flows.

- `feature.json` 2.10.0: the lanes, their task files, one GPT 6.1 lane reviewer per lane, the reviewers, the `prd`, `critique` on the `viewer` lane, `tryout: true`.
- `policy.json` 1.4.0: each lane's owned paths and checks, the browser scenarios, and `critique_app` (`tests/project-workflows/sessions-app.ts`, written by the `viewer` lane, ready at `/api/projects`).
- `server-task.md`, `viewer-task.md`: the lanes' tasks as outcome briefs.
- `decisions.md`: grilled 2026-10-11 ([O1] to [O6]).

Launch from this repository, with a controller that has feature.json 2.10.0 (md-manager 2dab17c or later): `python -m workflow launch run-sessions --repo <this repository> --dry-run`, then `--live --automatic --fix-rounds 3 --by operator`. This checkout's name is not `md-manager`, so pass `--run-root ~/.local/state/md-manager-workflows/run-sessions`.
