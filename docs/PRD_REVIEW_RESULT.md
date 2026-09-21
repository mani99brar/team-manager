# PRD: Review verdict and findings in the viewer (slice B)

Status: Draft for approval — implementation has not started. Umbrella: [PRD_REVIEW_VISIBILITY.md](PRD_REVIEW_VISIBILITY.md). Ordered after slice A by choice, so this run's own review exercises the reviewer pane live. Displaying persisted review results does not technically require A; the only coupling is that findings' `worker` and `requirement` fields are defined by A's completion schema, and the contract treats both as optional so runs reviewed before A still export.

## 1. Goal

The review node in the Projects viewer shows the verdict, the reviewer session, the bundle hash it reviewed, and every finding with severity and disposition. After this slice merges, project-workflows-001 shows its own six findings.

Success: opening the review node of a completed run answers "did the reviewer approve, who was it, what did it find" without opening the run directory.

## 2. Pre-run work (ours, before `prepare`)

| Where | Change |
| --- | --- |
| `contracts/projects` | new `reviewResult` type: run_id, node_id `review`, attempt, reviewer session, bundle_sha256, candidate_commit, verdict, findings with optional `worker` and `requirement`, reviewed_at, diff artifact reference. Version 1.1.0, additive. Node `result_uri` may point at it; `session_id` is populated for the review node |
| `contracts/projects/examples.ts`, `contract.test.ts` | positive and negative fixtures both workers build against |
| `workflow/export_state.py` | `review` section in `run-state.json` from `review.json` and the reviewer receipt. Export version 1.1.0 |
| `workflow` CLI | `workflow export <run>`: rebuilds `run-state.json` from the run directory under the current export version. Takes the controller lock, launches nothing, refuses a run whose `plan.json` or `review.json` fail validation. Run it on project-workflows-001 after merge |
| `workflow` tests | export test asserting 1.0.0 runs still load; re-export test on a copy of a 1.0.0 run directory |

## 3. Worker assignments

Feature directory `features/review-result/` with the same roles and ownership as project-workflows.

| Worker | Owned paths | Deliverables | Checks |
| --- | --- | --- | --- |
| adapter | `server/`, `config/projects.example.json` | `.../runs/<run>/reviews/<attempt>` route from the export's `review` section; review node `session_id` and `result_uri`; `review.diff` registered as a bounded artifact; `redactPaths` on messages; manual-mode reviews served with the operator's stated identity; old runs without a `review` section serve no result and no error | `backend-unit`, `backend-regression`, `shared-contract`, `backend-build` |
| ui | `src/App.tsx`, `src/App.css`, `src/graph`, `src/projects`, `src/index.css`, `tests/project-workflows` | findings panel on the review node: verdict pill, reviewer session, bundle hash linked to the candidate node, one-line summary such as "approved with 6 findings: 4 open, 2 accepted, none blocking", findings table grouped by disposition, "Diff the reviewer saw" link; worker-mode mocks and candidate-mode seeds for the route | `frontend-build`, `frontend-unit-regression`, `project-workflows-browser` |

Both task files keep the existing boundary: no dependency changes, no edits to contracts, policy, `workflow/` or the root Playwright config, escalate anything outside ownership.

## 4. Acceptance scenarios

| Scenario id | Asserts |
| --- | --- |
| review-verdict | review node shows approved, reviewer session, bundle hash, summary line, and a findings table with severity and disposition |
| review-blocked | a seeded blocked review shows verdict blocked, node failed, and the findings that caused it |
| review-legacy | a seeded run without the `review` export section shows "no review recorded" and no error |
| paths-redacted | no absolute path from the seeded fixtures appears in the rendered review |

Controller acceptance: after `workflow export` on project-workflows-001, the viewer shows its verdict, reviewer dd7bdcd1 and six findings.

## 5. Decided

- Issues #3 (stale task error projects a verified node as failed) and #6 (unredacted raw error) stay out of the adapter task by default, although both touch `server/projects.ts` near this work. Either is added only if it blocks a named acceptance scenario in section 4. None does: #3 concerns verify nodes, not the review node, and #6 concerns error bodies, which `paths-redacted` does not cover.

## 6. How to run

```bash
.venv/bin/python -m workflow launch review-result --live --automatic --worker-timeout-seconds 7200
```

Add `review-result` to the feature choices in `workflow/launch.py` first. The reviewer pane from slice A is exercised live for the first time here.
