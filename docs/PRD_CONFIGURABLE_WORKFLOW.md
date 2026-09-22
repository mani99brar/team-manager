# PRD: Configurable workflow (umbrella)

Status: Proposed 2026-09-22, after the review visibility merge (`af119c7`). Split into two vertical slices, each with its own PRD, each shipped as an ordinary commit with offline tests and a controlled live smoke test, like [PRD_REVIEWER_PANE.md](PRD_REVIEWER_PANE.md). No feature run is needed for either slice; the next real feature run is their first full live exercise.

## 1. Problem

A feature run always launches exactly two workers, `ui` and `adapter`, and exactly one reviewer. The operator cannot choose which workers run a task, cannot add a third lane, and cannot add a second reviewer with a different brief.

The lane names are fixed in two named constants (`NODES` in `workflow/sessions.py`, `WORKER_LANES` in `contracts/projects/v1.ts`) and spelled out inline in about 53 quoted literals, about 91 composite names (`launch_ui`, `verify_adapter`, `--ui-task`, `ui_packet`) and 41 references to `NODES` across the controller. The feature file names `ui_task` and `adapter_task`. The policy schema caps `workers` at two entries with roles limited to `frontend` and `backend`, and the pipeline validator pins the pair to exactly `ui/frontend` and `adapter/backend`. The reviewer is a singleton: one `review` node, one `review-worktree`, one `review.completion.json`, one `automatic-review.json`, one receipt, one pane. The completion schema fixes `node_id: "review"` and the finding `worker` enum to `ui`, `adapter`, `both`, `none`.

What is already generic and stays: `policy.workers[]` with per-lane `owned_paths` and `checks[]`, ownership overlap and check execution (`checks.py`, `verification.py` key everything off `node_id`), the export's `inputs.workers[]` with `launch_node_id`, and the viewer's DAG layout, Assignment tab, worker inputs panel and node detail, which all iterate whatever they are given.

## 2. Slices

| Slice | PRD | Kind of work | Ships as | Depends on |
| --- | --- | --- | --- | --- |
| A. Worker lanes from configuration | [PRD_WORKER_LANES.md](PRD_WORKER_LANES.md) | controller (`workflow/`), policy schema 1.2.0, feature file 2.0.0, review completion 1.1.0, export 1.3.0, projects contract 1.3.0, viewer adapter and review detail, docs | ordinary commit, offline tests, live smoke with a three-lane scratch feature | nothing |
| B. Parallel reviewers | [PRD_PARALLEL_REVIEWERS.md](PRD_PARALLEL_REVIEWERS.md) | controller review path, review completion 1.2.0, export 1.4.0, projects contract 1.4.0, viewer review node, docs | ordinary commit, offline tests, live smoke with two reviewers over a copied bundle | A merged |

Order: A then B. A is a generalisation of what exists and touches almost every controller file mechanically. B introduces a new concept (a set of reviewers and a combined verdict) on top of A's naming scheme, so doing B first would mean doing its file naming twice.

## 3. Decisions (confirmed 2026-09-22)

- [x] Worker scope: lanes from configuration only. Any number of lanes, each with node id, role, task file, owned paths and checks. Every lane runs as a native Claude session exactly as `ui` and `adapter` do today, with the same tools, permission mode and timeout. No per-lane model, tool set or runner.
- [x] Graph shape stays fixed: parallel lanes, one verification gate per lane, then candidate, review, approval, integrate. Only the lane list varies. No dependencies between lanes, no custom nodes.
- [x] Reviewers: several reviewers in parallel over the same bundle, each with its own prompt, session, receipt and completion file.
- [x] Verdict rule: unanimous. Every reviewer must approve. Any blocked verdict, any unresolved P0/P1 from any reviewer, any rejected completion file or any reviewer deadline blocks the run. Findings from all reviewers are unioned and tagged with the reviewer id. No advisory reviewers, no quorum.
- [x] Roles: `role` becomes a free label used in prompts and the viewer. Each lane declares its own `required_check_kinds`; the frontend/backend rule that derived required kinds from the role is removed.
- [x] Configuration lives in `features/<name>/feature.json`, which declares every lane and reviewer. `launch --workers a,b` runs a subset of the declared lanes and the selection is pinned into `plan.json`. No reusable catalogue.
- [x] Excluded lanes' owned paths stay off-limits: ownership is enforced from the full declared policy, and the candidate is built from the selected lanes only.
- [x] Delivery: two slices, each an ordinary commit with offline tests and a live smoke test.
- [x] Backward compatibility is required in both directions: the committed `features/project-workflows` launches unchanged after its feature file is migrated, and every existing run export (1.0.0 to 1.2.0, including project-workflows-001) still loads in the viewer without re-export.

## 4. Non-goals across both slices

- No lane dependencies, no sequential lanes, no custom graph nodes.
- No per-lane runtime differences: model, tool allow-list, permission mode and deadlines stay run-wide.
- No non-Claude runners: no Pi lane, no human lane, no headless worker.
- No advisory or quorum reviewers, no reviewer chain, no reviewer scoped to a subset of lanes.
- No per-reviewer transport, tools or model. `--reviewer-transport` stays run-wide.
- No launch, approve or retry controls in the viewer. It stays read-only.
- No change to the ownership model, the completion-file binding, the bundle hashing or the no-push rule.

## 5. How much work, and what "fully configurable" would cost

Sizing is relative to the reviewer pane slice (PRD_REVIEWER_PANE, implemented 2026-09-21: `automatic.py`, `interactive.py`, `pipeline.py`, one schema, tests, docs, one live smoke). Counts come from the inventory taken on 2026-09-22 against `af119c7`.

| Work | Touches | Relative size | Why |
| --- | --- | --- | --- |
| Slice A, lanes from configuration | 8 controller modules (`sessions`, `pipeline`, `automatic`, `interactive`, `launch`, `observer`, `export_state`, `verification`; `graph.py`, `demo.py` and `live.py` are two-lane stubs; the first two are deleted and `live.py` loses everything but the `SessionState` type that `interactive.py` imports), 3 schema bumps, `server/projects.ts` node maps and export parser, `ReviewDetail.tsx` groups, 58 of 119 Python tests and 35 of 53 TypeScript tests reference lane names (most keep passing because `ui`/`adapter` remain a valid configuration; the validators, argparse flags and fixture builders change) | about 1.5 to 2 times the reviewer pane slice | mechanical but wide: every `NODES` loop, every `f"{node}..."` file name and the pane layout become plan-driven; the schemas need additive versions; the live smoke needs a scratch three-lane feature |
| Slice B, parallel reviewers | `automatic.py` review path, `interactive.py` reviewer launch and panes, `pipeline.py` review node, manual `review` import, `export_state.py`, review completion schema, projects contract review result, `server/projects.ts` review route, `ReviewDetail.tsx`, tests for every rejected-file and interrupt case times N reviewers | about 1 to 1.5 times the reviewer pane slice | new concept: N launches, N waits, one combined decision, N stops; the interrupt and reconciliation matrix grows with N; the viewer's review node becomes a list |
| Both slices together | | about 3 times the reviewer pane slice, in two independently mergeable commits | |

What lies beyond this PRD, for the question "how much to make the full workflow configurable":

| Tier | Adds | Relative size on top of A and B | What it forces |
| --- | --- | --- | --- |
| Per-lane runtime | model, tool allow-list, permission mode, deadline per lane in the feature file | about 0.5 | preflight must verify every combination's CLI flags; `plan.automatic` becomes per lane; the viewer's run header shows per-lane settings |
| Lane dependencies | `depends_on` between lanes so a lane starts from another lane's handoff | about 2 | worktree bases differ per lane, freeze becomes ordered, the candidate cherry-pick order is a topological sort, retry and resume need per-lane base tracking, the export definition is dynamic; the largest single change to `pipeline.py` since the graph was written |
| Custom nodes and non-Claude runners | user-defined gate nodes, Pi lanes, human lanes, headless print workers | about 3 or more | a runner abstraction under `sessions.py`, a node registry that LangGraph is built from at prepare time, a completion protocol per runner kind; effectively a second workflow engine layer |

In short: choosing which of N declared workers run, and adding reviewers, is about three reviewer-pane slices of work. A fully custom DAG with mixed runners is a further five to six on top, most of it in lane dependencies and the runner abstraction, and is not proposed.

## 6. Decisions log for implementation

- [ ] Reserved node ids (slice A): `review`, `candidate`, `handoff`, `approval`, `integrate`, `multiple`, `none`, and anything starting with `launch_`, `verify_`, `candidate_` or `review-`
- [ ] Finding attribution vocabulary (slice A): `worker` is one lane id, `multiple` or `none`; the legacy `both` is accepted from old exports and rendered as "multiple workers"
- [ ] Reviewer worktree (slice B): shared `review-worktree` for all reviewers, since their tools are read-only and each has its own completion file
- [ ] Default reviewer (slice B): a feature file without `reviewers` declares one reviewer with id `review` and the built-in prompt, so `features/project-workflows` needs no change for B
