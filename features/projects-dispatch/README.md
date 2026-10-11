# projects-dispatch

The Projects tab opens on a Projects page: one card per registered project. Each card opens a dedicated project page with:
- the step chart of every feature's runs;
- local default branch against origin, as this clone has it;
- landings;
- pull requests and issues read through `gh`.

A projects-only rail sits on every Projects page except run pages. The former Runs home becomes Triage.

Specification: `docs/PRD_PROJECTS_DISPATCH.md`. Visual reference: `docs/design/projects-dispatch.html`. Two lanes run in one run, `server` and `viewer` (PRD section 8). The critique reviewer walks the `viewer` lane's flows.

- `feature.json` 2.10.0: the lanes, their task files, one GPT 6.1 lane reviewer per lane (decisions.md [L3]), the reviewers, the `prd`, `critique` on the `viewer` lane, and `tryout: true` (decisions.md [D9]).
- `policy.json` 1.4.0: each lane's owned paths and checks, the browser scenarios, and `critique_app`. The critique app is `tests/project-workflows/dispatch-app.ts`, written by the `viewer` lane, and is ready at `/api/dispatch/projects`.
- `server-task.md`, `viewer-task.md`: the lanes' tasks, written as outcome briefs.
- `decisions.md`: the operator's words, Claude's defaults, the panel's settlements and the changes after launch ([L1] to [L7]).
- `review-001.md`: run 001's independent review findings, verbatim; run 002 fixes the ones its tasks name.

Runs: projects-dispatch-001 (base eee4e83, review blocked at candidate f4623a4) and projects-dispatch-002 (base: this branch, from f4623a4; [L3]).

Launch from this repository: `python -m workflow launch projects-dispatch --repo <this repository> --dry-run`, then `--live --automatic --fix-rounds 3 --by operator`; run 002 also passes `--run-root ~/.local/state/md-manager-workflows/projects-dispatch` (this checkout's name is not `md-manager`, so the default root would differ). Run 002 needs a controller with feature.json 2.10.0 (md-manager 2dab17c or later): run the command from that checkout.
