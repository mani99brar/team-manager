# projects-dispatch

The Projects tab opens on a Projects page: one card per registered project. Each card opens a dedicated project page with:
- the step chart of every feature's runs;
- local default branch against origin, as this clone has it;
- landings;
- pull requests and issues read through `gh`.

A projects-only rail sits on every Projects page except run pages. The former Runs home becomes Triage.

Specification: `docs/PRD_PROJECTS_DISPATCH.md`. Visual reference: `docs/design/projects-dispatch.html`. Two lanes run in one run, `server` and `viewer` (PRD section 8). The critique reviewer walks the `viewer` lane's flows.

- `feature.json` 2.9.0: the lanes, their task files, the reviewers, the `prd`, `critique` on the `viewer` lane, and `tryout: true` (decisions.md [D9]).
- `policy.json` 1.4.0: each lane's owned paths and checks, the browser scenarios, and `critique_app`. The critique app is `tests/project-workflows/dispatch-app.ts`, written by the `viewer` lane, and is ready at `/api/dispatch/projects`.
- `server-task.md`, `viewer-task.md`: the lanes' tasks, written as outcome briefs.
- `decisions.md`: the operator's words and Claude's defaults (not grilled).

Launch from this repository: `python -m workflow launch projects-dispatch --repo <this repository> --dry-run`, then `--live --automatic --by operator`.
