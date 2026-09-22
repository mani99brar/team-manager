# Adapter worker: worker lanes from configuration (controller, contracts, server)

Implement slice A of `docs/PRD_WORKER_LANES.md` (umbrella `docs/PRD_CONFIGURABLE_WORKFLOW.md`) on the controller, the contracts and the viewer's server adapter. Read the PRD's sections 2 to 5 as the specification and section 6 as the test list. The lane inventory that motivated it is summarised in the umbrella's section 1.

## Ownership

Only edit `workflow/`, `contracts/`, `server/` and `features/project-workflows/`. The UI worker owns `src/projects/` and `tests/project-workflows/`; do not edit them. Do not edit `features/worker-lanes/`, package manifests, the root Playwright configuration or `docs/`. If a necessary change falls outside ownership, stop and ask the operator rather than crossing the boundary.

## Deliverables

- `contracts/workflow/verification.schema.json` 1.2.0, a new `contracts/workflow/feature.schema.json`, `reviewCompletion.schema.json` 1.1.0, updated examples, README and `contract.test.ts`, exactly as PRD section 3 specifies (unbounded `workers`, id pattern and reserved ids, free `role`, `required_check_kinds`, `failure_drill.node_id` any declared lane, finding `worker` as lane id, `multiple` or `none`). Versions 1.0.0 and 1.1.0 stay accepted.
- `contracts/projects` 1.3.0, additive, as PRD section 4 specifies: `inputs.workers` keyed by any lane id with `required_check_kinds`, `selected_workers`, `excluded_workers`, `role` as string, finding `worker` as string, `requirement_found_in` as an array of lane ids. Regenerate the exported JSON schemas with `npm run contracts:export`. The UI worker builds against this description, so do not deviate from it without recording the deviation in your completion summary.
- `workflow/`: delete `NODES` and every two-lane assumption listed in PRD section 4; plan-driven `prepare`, `ClaudeSessions`, `build_pipeline(plan)`, per-lane state keys, `--task <id>=<path>`, `--handoff <id>=<path>`, `launch --workers`, ownership against excluded lanes, ordered candidate, plan-driven panes and `--node`, reviewer prompt vocabulary and print-mode schema from the plan, dynamic export definition at export version 1.3.0, computed report positions. Feature file 2.0.0 with 1.0.0 translation and a deprecation line. Delete `graph.py`, `demo.py` and `test_graph.py`; move `SessionState` into `sessions.py` and delete the rest of `live.py` with its tests.
- `server/projects.ts`: accept exports 1.0.0 to 1.3.0; derive the lane list from `inputs.workers` and the node map from the `launch_<id>`, `verify_<id>` and `candidate_<id>` naming; keep the fixed two-lane map only as the fallback for 1.0.0 exports without `inputs`; accept legacy `both` findings. Extend `server/projects.test.ts` with a three-lane export and a one-lane export.
- Migrate `features/project-workflows/feature.json` to 2.0.0 and its `policy.json` to 1.2.0 with `required_check_kinds` (ui: build, browser; adapter: unit). Update `workflow/RUNBOOK.md`, `workflow/CHEATSHEET.md`, `features/project-workflows/README.md` and `contracts/workflow/README.md` for the new flags and files.
- Offline tests for every scenario in PRD section 6 that is not marked live or viewer: three-lane-run, one-lane-run, subset-pinned, excluded-ownership, unknown-worker, required-kinds, reserved-id, retry-any-lane, drill-skipped, finding-lane, legacy-feature and the export half of legacy-run.

## Verification

The policy runs the whole workflow unit suite with the controller interpreter, the contract tests, the existing unit suite and the build in an isolated worktree. Keep the existing tests passing; `ui` and `adapter` remain a valid configuration, so most existing fixtures stay valid once the validators change. Do not run the workflow suite concurrently with a browser suite. Report checks as not executed if you could not execute them; never claim success from inspection.

No new dependencies or changes to global permission settings are authorized. Manual mode disables shell tools; automatic mode grants run-scoped permission bypass and Bash access. The trusted verifier independently runs your checks after handoff.

## Finish

Report a summary, all changed files, checks actually executed (or explicitly none), any deviation from the contract shapes in the PRD, and open assumptions. In manual mode wait for the operator to freeze. In automatic mode follow the appended completion-file protocol and finish your turn without waiting for a human. Do not commit, push, merge, launch other agents or write outside your own worktree.
