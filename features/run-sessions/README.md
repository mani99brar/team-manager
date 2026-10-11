# run-sessions

Every session of a workflow run is visible on the run page: the reviewers (general, coverage, critique), the multi-provider panel and each lane's lane reviewer as nodes of the stage, a node page for each, a Sessions list with model, cost and a resume command, and the night-shift panel's decisions on the node they decided. Read-only; no engine change. Specification: `docs/PRD_RUN_SESSIONS.md`. One full-stack lane, `sessions` (PRD section 7, decisions.md [P14]); the critique reviewer walks its flows.

- `feature.json` 2.10.0: the `sessions` lane and its task file, its GPT 6.1 lane reviewer, the reviewers, the `prd`, `critique` on the lane, `tryout: true`.
- `policy.json` 1.4.0: the lane's owned paths and checks, the browser scenarios, and `critique_app` (`tests/project-workflows/sessions-app.ts`, written by the lane, ready at `/api/projects`).
- `sessions-task.md`: the lane's task as an outcome brief.
- `decisions.md`: grilled 2026-10-11 ([O1] to [O6]), then the panel's review of the slice ([P1] to [P14]).

Launch from this repository, with a controller that has feature.json 2.10.0 (md-manager 2dab17c or later): `python -m workflow launch run-sessions --repo <this repository> --dry-run`, then `--live --automatic --fix-rounds 3 --by operator`. This checkout's name is not `md-manager`, so pass `--run-root ~/.local/state/md-manager-workflows/run-sessions`.
