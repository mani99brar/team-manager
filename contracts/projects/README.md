# Project workflow viewer contract v1.2.0

Approved first feature: add a **Projects** root alongside the existing **Pi** and **Claude** roots. Browse a project, its workflow definitions, and executions; inspect a graph and run evidence. Existing skills browsing/editing is unchanged.

This commit defines the interface, not the viewer/API implementation. The first slice is read-only. Starting, approving, retrying, deleting or editing runs stays in the workflow CLI. No worker is launched by viewing a page.

## Objects

- **Project:** a configured repository/workflow-storage association. Public payload exposes only an opaque ID and display name.
- **Workflow definition:** project-scoped reusable DAG, display labels and an immutable definition revision.
- **Run:** one execution of a specific definition revision, with its own state, attempts and evidence.

The backend maintains an operator-configured allowlist mapping project IDs to canonical repository paths and workflow roots. Absolute filesystem paths are not API identifiers and are not accepted from browser input. A project can be listed even with no workflows; a workflow can be listed with no runs. This feature initially registers MD Manager but must not hardcode its ID in components or routing.

`v1.ts` is the source for structural Zod schemas and cross-field validators. Generated `*.schema.json` support Python consumers. `examples.ts` contains synthetic fixtures, not actual execution evidence. `contract.test.ts` checks schema drift and invariants. Run `npm run contracts:export` and `npm run test:contracts` from the repository root.

Versions are per message and additive. Messages unchanged since 1.0.0 keep `contract_version: "1.0.0"`. 1.1.0 added `reviewResult` (the recorded independent review of a run). 1.2.0 added `runInputs` / `runInputsResponse` (what the run and its workers were given) and the optional `requirement_verbatim` flag on review findings. A consumer accepts exactly the version each message declares.

## Read-only API

All IDs are opaque path segments and must be percent-encoded. The server validates the entire project/workflow/run tuple on every nested request.

| Method/path | Response |
| --- | --- |
| `GET /api/projects` | `projectList.schema.json`: `{ projects: Project[] }` |
| `GET /api/projects/{project_id}/workflows` | `workflowList.schema.json`: `{ workflows: WorkflowDefinition[] }` |
| `GET /api/projects/{project_id}/workflows/{workflow_id}/runs?limit=50&cursor=...` | `runList.schema.json`: `{ runs: RunSummary[], next_cursor: string \| null }` |
| `GET /api/projects/{project_id}/workflows/{workflow_id}/runs/{run_id}` | `runDetail.schema.json`: summary + pinned definition + existing workflow-v1 snapshot |
| `GET .../runs/{run_id}/events?after=0` | `{ events: WorkflowEvent[] }`, reusing workflow v1 events |
| `GET .../runs/{run_id}/results/{node_id}/{attempt}` | Existing workflow-v1 `WorkerResult` |
| `GET .../runs/{run_id}/artifacts/{artifact_id}` | Registered immutable artifact content only |
| `GET .../runs/{run_id}/reviews/{attempt}` | `reviewResult.schema.json` (1.1.0): verdict, reviewer session, bundle hash, candidate commit, findings, reviewed time, diff artifact reference. One review per run: only attempt `1`; 404 when no review is recorded |
| `GET .../runs/{run_id}/inputs` | `runInputsResponse`: `{ inputs: RunInputs \| null }` (1.2.0). Feature, branch, mode, automatic settings, setup commands, and per worker the task text, ownership, checks, launch receipt, completion signal, handoff and stop marker. `null` when the run's export has no inputs section |

Workflow lists return current definitions. A run detail returns **that run's pinned definition**, even if the current workflow has changed. The definition revision is a backend-generated SHA-256 of canonical definition JSON excluding `definition_revision` (sorted object keys, compact separators, UTF-8 literal Unicode; retain array order). The server retains historical definitions rather than rendering old runs against the latest graph. Cross-field validators verify scope/revision equality, graph structure and snapshot correspondence; computing/retaining the revision remains a backend responsibility.

Runs sort by `updated_at` descending, then `run_id` ascending; default limit 50, maximum 100. Cursors are opaque paging tokens, never paths. Polling is sufficient initially. Events use the existing monotonically increasing per-run sequence; clients deduplicate and preserve the cursor on transient errors.

Unknown or cross-project/project-workflow-mismatched resources return 404. Invalid IDs/cursors/limits return 400. Methods outside this read-only surface return 405. Backend failures return 5xx, not fabricated empty success. Error body: `{ "error": { "code": string, "message": string } }`, with no sensitive filesystem paths. An empty list is valid only for an existing scope with genuinely no entries. The backend must prevent traversal/symlink escape and reject duplicate run IDs within a workflow.

Artifacts/logs are served only through an allowlisted registry confined to that run, with appropriate content types. Do not fetch arbitrary `uri` values or expose the entire run directory. Render text safely; treat screenshots as images, never arbitrary HTML. Legacy runs require an explicit project/workflow registration or import mapping; do not auto-register a repository from untrusted `plan.json` paths.

This project-scoped read API supersedes the unscoped viewer route proposal in `../workflow/transport.md` for this feature. Existing workflow-v1 message schemas and the CLI are unchanged; execution controls are intentionally excluded from this slice.

## State projection

The backend adapter must project actual persisted pipeline/checkpoint/native-session evidence, not demonstrate live mode with fixtures. Missing or contradictory evidence is an error/paused state, never success.

- Launch-node completion does not mean the worker finished its implementation.
- Native Claude `done` means a completed turn, not workflow success.
- Worker handoff, independent review and integration approval interrupts are `awaiting_approval` (node labels explain which decision).
- Failed graph/check execution is `failed`; unresolved session reconciliation can be `paused`.
- A run is `succeeded` only after confirmed integration with no remaining graph work.
- Use persisted event/checkpoint timestamps for created/updated times, not the time the UI fetched the record.
- The review node's `session_id` is the reviewer identity and its `result_uri` the reviews route once a review is recorded, for either verdict; both are null otherwise, with no error. Findings' `worker` and `requirement` are null when the review predates the reviewer link fields; `requirement_verbatim` is set only by an adapter that looked the quote up in the worker's task text, and is never a fuzzy guess.
- Run inputs are pinned from the run's own files, never from the current feature directory. Task text is the assignment the worker received, including the appended policy JSON; absolute paths are redacted; oversized text is truncated with a marker.

Every snapshot contains every node in the pinned definition, with matching kind/dependencies. Nodes not started have attempt 0, pending status and nullable session/result references. Result/artifact links use the scoped API paths. Distinguish graph-node attempts from native-worker attempts and display explicit reuse evidence rather than guessing from status.

## Worker boundaries for implementation

**Backend worker:** project registry, scoped read API and projection of actual pipeline run records; schema/contract tests, project isolation, missing/malformed/stale data and artifact path safety.

**Frontend worker:** Projects root and project/workflow/run navigation; definition graph, run list, node detail (attempts/reuse, changed files, checks, assumptions, logs and screenshots); loading, empty, disconnected/error states. Preserve existing Pi/Claude behavior. Demo fixtures may be used for development only through an explicitly labelled mode.

Exact file ownership and executable check commands are supplied in the feature's run policy before launching workers; this API contract does not authorize overlapping edits.

## Acceptance criteria

1. Pi/Claude browsing and editing still work; Projects appears as an additional root.
2. A registered project with no workflows and a workflow with no runs show different useful empty states.
3. Selecting a run renders its pinned graph and actual statuses, not the latest definition or a global run with a matching basename.
4. Selecting a worker shows its results/checks/assumptions and linked log/screenshot artifacts; absent evidence is explicit.
5. Loading, 404, unavailable backend and malformed payloads are handled without silently falling back to demo data.
6. Browser tests with screenshots cover navigation, graph/run selection, failed/awaiting-approval states, result details and empty/error states.
7. Backend unit/contract tests cover registration, cross-project isolation, definition revisions, pagination, state projection and artifact confinement.
8. No view action launches, stops, resumes, approves or integrates an agent/workflow.
