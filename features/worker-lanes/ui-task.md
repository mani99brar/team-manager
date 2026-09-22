# UI worker: the Projects viewer shows the lanes a run actually had

Implement the viewer half of slice A of `docs/PRD_WORKER_LANES.md` (umbrella `docs/PRD_CONFIGURABLE_WORKFLOW.md`). Read PRD section 4, subsection "Export 1.3.0 and projects contract 1.3.0", as the data shape you build against, and section 6 for the two browser scenarios you own.

## Ownership

Only edit `src/projects/` and `tests/project-workflows/`. The adapter worker owns `workflow/`, `contracts/`, `server/` and `features/project-workflows/`; do not edit them. Do not edit `src/App.tsx`, `src/App.css`, `src/index.css`, `features/worker-lanes/`, package manifests, the root Playwright configuration or `docs/`. If a necessary change falls outside ownership, stop and ask the operator rather than crossing the boundary.

## Deliverables

- Nothing in `src/projects/` may assume the lanes are `ui` and `adapter`. The graph, Assignment tab, worker inputs and node detail already iterate what they are given; verify that and fix anything that does not, including labels.
- `ReviewDetail.tsx`: findings grouped by the run's lanes (from the run's inputs, in policy order) plus `multiple`, `none` and `unrecorded`. A legacy `both` value renders as "multiple workers". The Worker column and the group-by-worker toggle keep working for any number of lanes. `launchNodeFor` stays the `launch_<id>` convention.
- Fixtures in `tests/project-workflows/fixtures.ts` and `seed.ts`: a three-lane run (lanes `ui`, `adapter`, `docs`) at contract 1.3.0 with `selected_workers`, `excluded_workers`, per-worker `required_check_kinds`, a `docs` finding and a legacy `both` finding, and a one-lane run. Keep the existing two-lane fixtures unchanged so the legacy scenario is honest.
- Browser scenarios `viewer-three-lanes` and `legacy-run` from the policy, in `tests/project-workflows/`, with the same `[scenario:<id>]` title marker and `screenshot:<id>` attachment rules as the existing suite (`workflow/RUNBOOK.md`). Keep the existing six scenarios passing.

## Browser tests and isolation

Read `WORKFLOW_VERIFICATION_PHASE` from the environment exactly as the existing project-workflows suite does: in `worker` phase, mock only `/api/projects/**` from the contract fixtures; in `candidate` phase, seed real run data and start the real combined backend, no mocked project success responses. Choose free ports dynamically, never reuse a running server, clean up owned temporary directories, one Playwright worker. Do not skip tests in candidate mode or weaken assertions.

The adapter worker changes the projects contract to 1.3.0 in parallel with you, following the shape in the PRD. Build your fixtures from that description; if the shape as described is not enough to render a scenario, stop and ask the operator rather than inventing a field.

No new dependencies are authorized. Manual mode disables shell tools; automatic mode grants Bash. The trusted verifier independently runs your build, unit and browser checks after handoff. Report checks as not executed if you could not execute them; never claim success from inspection.

## Finish

Report a summary, all changed files, checks actually executed (or explicitly none) and open assumptions. In manual mode wait for the operator to freeze. In automatic mode follow the appended completion-file protocol and finish your turn without waiting for a human. Do not commit, push, merge, launch other agents or write outside your own worktree. Do not edit shared contracts or fixtures outside your ownership to make tests pass.
