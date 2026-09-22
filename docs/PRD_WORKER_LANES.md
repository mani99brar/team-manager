# PRD: Worker lanes from configuration (slice A)

Status: Proposed 2026-09-22. Umbrella: [PRD_CONFIGURABLE_WORKFLOW.md](PRD_CONFIGURABLE_WORKFLOW.md). Depends on nothing. Ships as an ordinary commit with offline tests and a controlled live smoke test (section 8); no feature run.

This slice is controller work plus schema bumps and the viewer generalisation that keeps new runs readable: `workflow/`, `contracts/workflow/`, `contracts/projects/`, `server/projects.ts`, `src/projects/ReviewDetail.tsx`, `workflow/RUNBOOK.md`, `workflow/CHEATSHEET.md` and the feature README.

## 1. Goal

A feature declares any number of worker lanes in its feature file. A launch runs all of them, or a named subset, and the run behaves exactly as a two-lane run does today: one native session per lane in its own worktree, one handoff and one verification gate per lane, one candidate, one review, a verified feature branch. The Projects viewer shows the lanes the run actually had.

Success: `launch <feature> --workers ui,docs --live --automatic` on a feature that declares `ui`, `adapter` and `docs` runs two sessions, refuses any edit under the adapter's owned paths, verifies both lanes, and reaches a verified branch whose diff contains only those two lanes' work. The viewer renders three launch and verify nodes for a run that selected all three lanes, and the existing project-workflows-001 export renders unchanged.

## 2. Confirmed decisions

- Lanes from configuration only: node id, role label, task file, owned paths, checks and required check kinds. Same session command, tools, permission mode and deadline for every lane.
- Graph shape fixed: `launch_<lane>` fan-out, `handoff`, `verify_<lane>` fan-out, `candidate`, `review`, `approval`, `integrate`.
- `launch --workers a,b` selects a subset; the selection is pinned in `plan.json`. Omitted means every declared lane.
- Excluded lanes' owned paths stay off-limits. Ownership is checked against the full declared policy; the candidate cherry-picks selected lanes only, in declared order.
- `role` is a free label. Each lane declares `required_check_kinds`; the frontend/backend rule in `verification.py` is removed.
- One lane is a valid run. The candidate is then that lane's snapshot, still verified in the combined phase.
- The finding vocabulary changes with the lanes: `worker` is a lane id, `multiple` or `none`. `both` is not written any more, but is accepted from old exports.

## 3. Configuration

### feature.json 2.0.0

```json
{
  "version": "2.0.0",
  "name": "Project workflows and run viewer",
  "branch_prefix": "feature/project-workflows",
  "policy": "policy.json",
  "workers": [
    {"node_id": "ui", "task": "ui-task.md"},
    {"node_id": "adapter", "task": "adapter-task.md"}
  ]
}
```

Rules: `workers` has at least one entry; node ids are unique; the set of node ids equals the set of `policy.workers[].node_id`; task files exist and are non-empty. A `1.0.0` file with `ui_task` and `adapter_task` is translated to this shape by `launch` and reported as deprecated; the committed feature is migrated in this slice. A JSON schema is added at `contracts/workflow/feature.schema.json` and `launch --dry-run` validates against it.

### policy.json 1.2.0 (`contracts/workflow/verification.schema.json`)

| Field | 1.1.0 | 1.2.0 |
| --- | --- | --- |
| `workers` | 1 to 2 items | 1 or more items |
| `workers[].node_id` | any string | `^[a-z][a-z0-9-]{0,31}$`, unique, not reserved |
| `workers[].role` | `frontend` or `backend` | any string, 1 to 40 characters |
| `workers[].required_check_kinds` | absent | required, 1 or more of the check kind enum; every listed kind must appear in that lane's `checks` |
| `failure_drill.node_id` | `ui` or `adapter` | any declared node id |

Reserved node ids: `review`, `candidate`, `handoff`, `approval`, `integrate`, `multiple`, `none`, and any id starting with `launch_`, `verify_`, `candidate_` or `review-`. Owned paths stay pairwise disjoint across all declared lanes (already enforced). Versions 1.0.0 and 1.1.0 stay accepted so pinned policies in old runs still validate; for those, `required_check_kinds` is derived from the role exactly as today, so the export of an old run is unchanged.

### Launch selection

`launch <feature> --workers <id>[,<id>...]`. Unknown ids, duplicates and an empty list are refused before any Git action. `prepare` receives `--task <id>=<path>` once per selected lane (replacing `--ui-task` and `--adapter-task`) and pins into `plan.json`:

```json
{
  "workers": ["ui", "docs"],
  "excluded_workers": ["adapter"],
  "nodes": {"ui": {...}, "docs": {...}}
}
```

Plans without `workers` (every existing run) mean `["ui", "adapter"]` with nothing excluded. The failure drill applies only when its lane is selected; otherwise `plan.failure_drill` is null and the timeline records that the drill was skipped.

## 4. Design

Everything that iterates `NODES` iterates `plan["workers"]` instead, in declared order. `NODES` is deleted; `sessions.prepare` takes a mapping of node id to task text and refuses an empty mapping, a reserved id or an id not in the pinned policy.

| Concern | Today | This slice |
| --- | --- | --- |
| Graph nodes | six named functions, static edges | `build_pipeline(plan)` adds `launch_<id>` and `verify_<id>` per selected lane and wires the same fan-out and fan-in; `PipelineState` keeps per-lane data under `lanes[<id>]` and `packets[<id>]` instead of `ui`, `adapter`, `ui_packet`, `adapter_packet` |
| Per-lane files | `<id>.completion.json`, `<id>.handoff.json`, `<id>.prompt.txt`, `<id>.interactive.json`, `<id>.launch.log`, `<id>.stop.json`, `<id>.snapshot-index`, `worktree-<id>` | unchanged naming, now for any id |
| Session name | `workflow-<run>-<id>` | unchanged |
| Ownership | each lane's snapshot checked against its own `owned_paths` | additionally, any path under an excluded lane's `owned_paths` is an ownership violation for every selected lane |
| Candidate | cherry-pick `ui` then `adapter` | cherry-pick selected lanes in declared order |
| Retry | `--node ui|adapter` | `--node <id>` validated against `plan.workers` at run time; `advance_failed_checks` accepts `verify_<id>` for any selected lane |
| Handoff import (manual) | `--ui-handoff`, `--adapter-handoff` | `--handoff <id>=<path>` once per selected lane, all required |
| Herdr panes | `ui` root, `adapter` split right, reviewer split right of `adapter` | first selected lane is the root, each following lane splits right of the previous, the reviewer splits right of the last lane; `attach_panels` requires one pane per selected lane |
| Reviewer prompt | "ui, adapter, both or none" | the selected lane ids, `multiple` or `none`; requirement quotes are looked up in the named lane's task |
| Review completion | `worker` enum fixed | schema 1.1.0: `worker` is `^[a-z][a-z0-9-]{0,31}$` or `multiple` or `none`; the controller rejects a lane id that is not in `plan.workers`; `REVIEW_SCHEMA` for print mode is generated from the plan |
| Export definition | static `GRAPH_NODES` | built from `plan.workers`: `launch_<id>` (label "Launch <id> worker"), `verify_<id>` ("Verify <id>"), then the fixed tail; old exports keep their stored definition |
| HTML report | hardcoded positions for nine nodes | positions computed per lane column |
| `graph.py`, `demo.py`, `live.py` | two-lane stub lab (`graph.py` used only by `demo.py`) and the older print-mode session graph (`live.py`, whose `SessionState` type `interactive.py` still imports) | `graph.py` and `demo.py` are deleted with `test_graph.py`; `SessionState` moves to `sessions.py` and the rest of `live.py` is deleted with its tests |

### Export 1.3.0 and projects contract 1.3.0

Additive. `inputs.workers` becomes a record keyed by any lane id in policy order; each worker gains `required_check_kinds` and keeps `launch_node_id`. `inputs` gains `selected_workers` and `excluded_workers`. `review.findings[].worker` becomes a string. `requirement_found_in` becomes an array of lane ids. `role` becomes a string. The viewer adapter keeps accepting 1.0.0 to 1.3.0; for 1.0.0 exports without `inputs` it keeps the fixed two-lane node map as a legacy fallback, and for later exports derives the lane list from `inputs.workers` and the node map from the `launch_<id>`, `verify_<id>` and `candidate_<id>` naming the exporter guarantees. `ReviewDetail.tsx` groups findings by the run's lanes plus `multiple`, `none` and `unrecorded`, rendering legacy `both` as "multiple workers".

## 5. Work items

1. `contracts/workflow/verification.schema.json` 1.2.0, `feature.schema.json`, `reviewCompletion.schema.json` 1.1.0, examples and `contract.test.ts`.
2. `sessions.py`: delete `NODES`; plan-driven `prepare`, `ClaudeSessions`, `run`.
3. `pipeline.py`: `validate_pipeline_policy` checks required kinds and reserved ids instead of the fixed pair; `build_pipeline(plan)`; per-lane state keys; `--task`, `--handoff`, `--workers`; ownership against excluded lanes; ordered candidate; report positions.
4. `automatic.py`: `wait_handoffs`, `stop_workers`, `advance_failed_checks`, review prompt vocabulary and print-mode schema from the plan; lane validation of `worker` in completion files.
5. `interactive.py`, `observer.py`: plan-driven panes and `--node`.
6. `launch.py`: feature 2.0.0 with 1.0.0 translation, `--workers`, drill skip message.
7. `verification.py`: required kinds from `required_check_kinds`, with the role-derived fallback for policies before 1.2.0.
8. `export_state.py`: dynamic definition, `selected_workers`, `excluded_workers`, version 1.3.0.
9. `contracts/projects` 1.3.0, `server/projects.ts`, `ReviewDetail.tsx`, fixtures in `tests/project-workflows/fixtures.ts` and `seed.ts` gain a three-lane run.
10. Migrate `features/project-workflows/feature.json` and `policy.json` (add `required_check_kinds`: ui `build`, `browser`; adapter `unit`).
11. Docs: RUNBOOK, CHEATSHEET, feature README, `contracts/workflow/README.md`.

## 6. Acceptance scenarios

Offline unless marked live.

| Scenario id | Asserts |
| --- | --- |
| three-lane-run | a `FakeSessions` automatic run with lanes `ui`, `adapter`, `docs` reaches a verified branch whose commits are the three lane snapshots in declared order; every per-lane file exists under its lane id |
| one-lane-run | a run selecting one lane verifies it in both phases and integrates it |
| subset-pinned | `launch --workers ui,docs` pins `workers` and `excluded_workers`; `prepare` creates two worktrees; `status` and the export list two lanes |
| excluded-ownership | a selected lane whose snapshot touches a path owned by an excluded lane blocks at freeze with an ownership violation naming both lanes |
| unknown-worker | `--workers ui,nope` and `--workers ui,ui` are refused before `git switch` |
| required-kinds | a policy whose lane lists `browser` in `required_check_kinds` but has no browser check fails validation; a 1.1.0 policy still derives kinds from role |
| reserved-id | a lane named `review`, `none` or `launch_x` is refused at validation |
| retry-any-lane | `retry --phase worker --node docs` reruns that lane's failed check and nothing else |
| drill-skipped | a drill naming an excluded lane is recorded as skipped and no injected failure occurs |
| finding-lane | a completion file naming `worker: "docs"` is accepted on a run that selected `docs` and rejected on one that did not; `multiple` and `none` are always accepted; `both` is rejected |
| legacy-feature | a 1.0.0 feature file dry-runs with the same commands as 2.0.0 plus a deprecation line |
| legacy-run | project-workflows-001 exports at 1.3.0 with an unchanged definition and the viewer renders it identically to 1.2.0; a stored 1.2.0 export still loads without re-export |
| viewer-three-lanes | a seeded three-lane run shows three launch and verify nodes in the graph, three workers in the Assignment tab and findings grouped by lane, with an old `both` finding shown under "multiple workers" |
| panes (live) | the smoke run's tab holds one pane per selected lane and the reviewer pane to their right; `attach-one --node docs` reconnects |

## 7. Open questions

- Whether the stub lab (`graph.py`, `demo.py`) is worth keeping as a two-lane recovery demo. Default: delete; the production pipeline's offline tests cover recovery. `live.py` cannot simply be deleted because `interactive.py` imports `SessionState` from it; that type moves first.
- Whether `--workers` should also be accepted by `prepare` for the step-by-step path, or only by `launch`. Default: both, since `launch` only forwards.
- Whether the pane row should wrap after four lanes. Default: no wrapping in this slice; more than four lanes gets narrow panes.

## 8. How to run

Offline: `.venv/bin/python -m unittest discover -s workflow` and `npm run test:unit`, `npm run test:contracts`, then the project-workflows Playwright suite on free ports.

Live smoke, before merging: a scratch feature directory `features/lanes-smoke/` (not committed) copied from project-workflows with a third lane `contracts` owning `contracts/projects` and one `contract` check (`npm run test:contracts`), tiny tasks (add one sentence to a file the lane owns), `--worker-timeout-seconds 900`, on a scratch `--run-root`. Run once with all three lanes and once with `--workers ui,contracts`. Expect a verified branch each time, three then two panes, and a refused edit if a task deliberately asks a lane to touch another lane's file. Nothing is integrated into main; the scratch branches are deleted afterwards.
