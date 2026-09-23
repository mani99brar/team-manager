# Project workflow viewer contract v1.4.0

Approved first feature: add a **Projects** root alongside the existing **Pi** and **Claude** roots. Browse a project, its workflow definitions, and executions; inspect a graph and run evidence. Existing skills browsing/editing is unchanged.

This commit defines the interface, not the viewer/API implementation. The first slice is read-only. Starting, approving, retrying, deleting or editing runs stays in the workflow CLI. No worker is launched by viewing a page.

## Objects

- **Project:** a configured repository/workflow-storage association. Public payload exposes only an opaque ID and display name.
- **Workflow definition:** project-scoped reusable DAG, display labels and an immutable definition revision.
- **Run:** one execution of a specific definition revision, with its own state, attempts and evidence.

The backend maintains an operator-configured allowlist mapping project IDs to canonical repository paths and workflow roots. Absolute filesystem paths are not API identifiers and are not accepted from browser input. A project can be listed even with no workflows; a workflow can be listed with no runs. This feature initially registers MD Manager but must not hardcode its ID in components or routing.

`v1.ts` is the source for structural Zod schemas and cross-field validators. Generated `*.schema.json` support Python consumers. `examples.ts` contains synthetic fixtures, not actual execution evidence. `contract.test.ts` checks schema drift and invariants. Run `npm run contracts:export` and `npm run test:contracts` from the repository root.

## Read-only API

All IDs are opaque path segments and must be percent-encoded. The server validates the entire project/workflow/run tuple on every nested request.

| Method/path | Response |
| --- | --- |
| `GET /api/projects` | `projectList.schema.json`: `{ projects: Project[] }` |
| `GET /api/projects/{project_id}/workflows` | `workflowList.schema.json`: `{ workflows: WorkflowDefinition[] }` |
| `GET /api/projects/{project_id}/workflows/{workflow_id}/runs?limit=50&cursor=...` | `runList.schema.json`: `{ runs: RunSummary[], next_cursor: string \| null }` |
| `GET /api/projects/{project_id}/workflows/{workflow_id}/runs/{run_id}` | `runDetail.schema.json`: summary + pinned definition + existing workflow-v1 snapshot |
| `GET .../runs/{run_id}/events?after=0` | `{ events: WorkflowEvent[] }`, reusing workflow v1 events |
| `GET .../runs/{run_id}/results/{node_id}/{attempt}` | Existing workflow-v1 `WorkerResult`; worker-phase results also carry captured `file` artifacts with `path` and `files_not_captured` (additive, see below) |
| `GET .../runs/{run_id}/artifacts/{artifact_id}` | Registered immutable artifact content only |
| `GET .../runs/{run_id}/reviews/{attempt}` | `reviewResult.schema.json`: the persisted review verdict, reviewer identity, bundle hash, findings and the diff artifact (1.1.0; finding links 1.2.0; lane attributions 1.3.0; one entry per reviewer and a `reviewer` tag on every finding 1.4.0) |
| `GET .../runs/{run_id}/inputs` | `runInputs.schema.json`: what the run was asked to do, pinned from its own files (1.2.0; selected and excluded lanes 1.3.0; decisions, design challenge, completion evidence and worker questions 1.4.0) |

Workflow lists return current definitions. A run detail returns **that run's pinned definition**, even if the current workflow has changed. The definition revision is a backend-generated SHA-256 of canonical definition JSON excluding `definition_revision` (sorted object keys, compact separators, UTF-8 literal Unicode; retain array order). The server retains historical definitions rather than rendering old runs against the latest graph. Cross-field validators verify scope/revision equality, graph structure and snapshot correspondence; computing/retaining the revision remains a backend responsibility.

Runs sort by `updated_at` descending, then `run_id` ascending; default limit 50, maximum 100. Cursors are opaque paging tokens, never paths. Polling is sufficient initially. Events use the existing monotonically increasing per-run sequence; clients deduplicate and preserve the cursor on transient errors.

Unknown or cross-project/project-workflow-mismatched resources return 404. Invalid IDs/cursors/limits return 400. Methods outside this read-only surface return 405. Backend failures return 5xx, not fabricated empty success. Error body: `{ "error": { "code": string, "message": string } }`, with no sensitive filesystem paths. An empty list is valid only for an existing scope with genuinely no entries. The backend must prevent traversal/symlink escape and reject duplicate run IDs within a workflow.

Artifacts/logs are served only through an allowlisted registry confined to that run, with appropriate content types. Do not fetch arbitrary `uri` values or expose the entire run directory. Render text safely; treat screenshots as images, never arbitrary HTML. Legacy runs require an explicit project/workflow registration or import mapping; do not auto-register a repository from untrusted `plan.json` paths.

This project-scoped read API supersedes the unscoped viewer route proposal in `../workflow/transport.md` for this feature. Existing workflow-v1 message schemas and the CLI are unchanged; execution controls are intentionally excluded from this slice.

## Versions

Existing payloads (`projectList`, `workflowList`, `runList`, `runDetail`, worker results, events) are unchanged and keep `contract_version: "1.0.0"`. Additions are versioned by the release that introduced or last changed their shape:

- **1.1.0**: `reviewResult` (`.../reviews/{attempt}`). The review node's `session_id` is the reviewer session and its `result_uri` points at the review result. Findings carry `worker` and `requirement` as recorded by the reviewer (null for reviews recorded before the reviewer prompt asked for them).
- **1.2.0**: `reviewResult` findings gain `requirement_found_in`, the worker lanes whose task text contains the quote verbatim (the backend never guesses a match); `runInputs` (`.../inputs`) adds the pinned assignment: feature, base commit, branch, mode, automatic settings, per-worker task text and exact prompt, owned paths, required checks, launch receipt, completion signal, accepted handoff and stop confirmation.
- **1.3.0** (additive): worker lanes come from configuration, so nothing names `ui` or `adapter` any more. `runInputs.workers[].node_id` is any lane ID (`^[a-z][a-z0-9-]{0,31}$`), `role` is a free label of 1 to 40 characters, and each worker gains `required_check_kinds`, the check kinds the policy requires that lane to pass (derived from the role for policies before 1.2.0: `frontend` needs `build` and `browser`, `backend` needs `unit`). `runInputs` gains `selected_workers` (the lanes the run launched, in policy order; `workers` describes exactly these) and `excluded_workers` (declared lanes the launch left out). `reviewResult.findings[].worker` is a lane ID, `multiple`, `none`, the legacy `both` (recorded before 1.3.0, rendered as "multiple workers") or null, and `requirement_found_in` is an array of lane IDs. `runInputs` carried `contract_version: "1.3.0"` until 1.4.0.
- **1.4.0** (additive, `reviewResult` only): a run may declare several reviewers (`features/<name>/feature.json` 2.1.0) that review the same bundle in parallel. `reviewResult` gains `reviewers`, one entry per reviewer in declared order: `reviewer_id` (same shape as a lane ID), `transport` (the run-wide transport, the same for every entry), `session_id` (the Claude session UUID, the operator-stated identity for manual imports, or null when the reviewer never got a session), `verdict` (`approved`, `blocked` or null when it produced none), `findings` (that reviewer's own, repeated from the combined list), `launched_at` and `accepted_at` (nullable timestamps) and `status` (`accepted`, `blocked`, `superseded` when the run was decided while it was still working, or `pending`). Every finding in the combined list gains `reviewer`, the ID of the reviewer that wrote it; the same defect reported by two reviewers appears twice, never merged. The verdict is unanimous: `approved` only when every entry approved without an unresolved P0/P1. `reviewer.session_id` lists every reviewer's session, comma-separated, when there are several. A run without declared reviewers, and every export recorded before 1.4.0, has exactly one reviewer named `review`: the backend fills its entry from the single record (its session, verdict, every finding, `accepted_at` = `reviewed_at`, `launched_at` null), so the viewer has one code path. The `reviews/{attempt}` route is unchanged and attempt stays 1. Cross-field rules: unique reviewer IDs and sessions, every finding's `reviewer` is listed, each entry's `findings` equal the combined findings tagged with it, an `accepted` entry has a verdict, and an approved result has no non-approved entry.
- **1.4.0** (additive, `runInputs`; export 1.5.0, docs/PRD_PORTABLE_WORKFLOW.md section 4.7): the guardrails of `feature.json` 2.2.0. `runInputs` carries `contract_version: "1.4.0"` and gains `decisions` (the `decisions.md` text pinned at prepare, Markdown, or null) and `challenge` (the latest design challenge: `status` `passed`/`paused`/`accepted`/`disabled`, `attempt`, `attempts`, `session_id`, `pinned` hashes, `concerns` `{severity, kind, message, consequence}`, `simpler_alternative`, `cheap_experiment`, `accepted_reason`, `decided_at`; or null). `workers[].completion` is served only as the controller reads it (null for a refused file: another version than the run pinned, stale, foreign or malformed) and gains `version` (`1.0.0` or `1.1.0`, the version the run pinned; the backend serves `1.0.0` for exports before 1.5.0, which carry no other), `untested` (a list or null), `falsifying_check` and `verify_yourself` (strings or null; all three null for a 1.0.0 completion and possibly for a 1.1.0 `blocked` one) and `question` (the text of a question the controller has not recorded: a `question` completion it has not polled yet, or a fourth question, served as `blocked` because at most three are answered; null otherwise), and its `status` gains `question`; `falsifying_check` is served verbatim when it names one of the lane's check IDs or commands, so it can link to that check. `workers[].questions` lists `{n, question, asked_at, answer, answered_at}` in order (`answer`/`answered_at` null while it waits; `[]` without questions). Older exports serve null and `[]`. Definitions of 2.2.0 runs start with the node `{node_id: "challenge", label: "Design challenge", kind: "review", depends_on: []}`, on which every launch node depends; its snapshot status is `paused` while the challenge is paused, `succeeded` once passed or accepted, and its attempt and session come from the challenge. Cross-field rules: an accepted challenge, and only one, has a reason; a disabled one ran no job (attempt 0, no session, no concerns); a passed one has no P0/P1 and a paused or accepted one has one; `attempt` never exceeds `attempts`; questions are numbered from 1, at most three, only the latest may wait, and an answer comes with its time; a 1.0.0 completion has no evidence, no question and no `question` status; a `question` completion has its text and follows fewer than three questions; only it, or a `blocked` completion after exactly three questions, has a question.

- **Captured files** (workflow `workerResult` stays 1.0.0; no projects version changes: `reviewResult.schema.json` is regenerated only because `diff` reuses the workflow artifact schema (the `file` kind and the path rule), and the diff must still be a `patch`): a worker-phase result lists the changed text files the verifier captured from the snapshot as artifacts of kind `file` with a repo-relative `path`, and `files_not_captured: [{path, reason}]` (`binary`, `too_large`, `missing`, `budget`) for every other changed path. The adapter passes both through unchanged and serves each file through the artifact route, hash-checked, as `text/plain; charset=utf-8` with `nosniff` and a sandboxing CSP; file content is verbatim and not redacted (path redaction applies to paths the viewer prints). Candidate-phase results and results recorded before capture carry neither; the viewer says the files were not captured. `examples.ts` `servedWorkerResult` shows the shape.

A run whose export predates a section returns a 404 with code `REVIEW_NOT_FOUND` or `INPUTS_NOT_FOUND` for that route, never an error page: the viewer says "no review recorded" / "inputs not recorded". Re-export old runs with `workflow export <run>` to add the sections. Exports recorded under 1.0.0 to 1.4.0 keep loading without re-export (a 1.4.0 export serves the 1.4.0 run-inputs fields as null and `[]`); the backend derives the lane list from the export's `inputs.workers` (or the fixed `ui`/`adapter` pair for exports without an `inputs` section) and the node map from the `launch_<lane>`, `verify_<lane>` and `candidate_<lane>` naming the controller guarantees, and fills the single reviewer `review` for exports before 1.4.0.

## Review results and run inputs

- `reviewResult`: one review per bundle (attempt is 1), by one or more reviewers over the same bundle. `reviewer.transport` is `native` (attachable background sessions), `print` (headless `claude --print`) or `manual` (operator-supplied review files, one per reviewer); `reviewer.session_id` is the Claude session UUID for the first two and the operator-stated identity for the last, comma-separated when there are several reviewers; `reviewers` carries each reviewer's own identity, verdict, findings, times and status. `diff` is the run's `review.diff` registered as a bounded patch artifact served through the artifact route; null when the file is absent. Cross-field rule: an approved review carries no unresolved P0/P1 finding and no reviewer that did not approve. Messages and quotes pass through path redaction.
- `runInputs`: `workers` lists the selected lanes in policy order (`selected_workers` repeats their IDs; `excluded_workers` names declared lanes that did not run and therefore have no node, receipt or result). `workers[].task.text` is the task pinned in `plan.json` (the authored assignment plus the appended ownership/checks JSON), `prompt` the exact prompt the native session received when the run recorded one. Text is bounded: oversized text is truncated with a marker and `truncated: true`. `checks[].command` is the approved argv joined exactly as executed checks record `command`, so a required check links to its execution. Receipts (`launch`, `completion`, `handoff`, `stop`) are null when the run has not produced them; `automatic.reviewer_transport` is null for runs pinned before the setting existed that never reviewed (a reviewed run reports the transport it actually used). Check and scenario IDs are the policy's own labels, not route segments. Absolute paths never appear; nothing here is a filesystem identifier.

## State projection

The backend adapter must project actual persisted pipeline/checkpoint/native-session evidence, not demonstrate live mode with fixtures. Missing or contradictory evidence is an error/paused state, never success.

- Launch-node completion does not mean the worker finished its implementation.
- Native Claude `done` means a completed turn, not workflow success.
- Worker handoff, independent review and integration approval interrupts are `awaiting_approval` (node labels explain which decision).
- Failed graph/check execution is `failed`; unresolved session reconciliation can be `paused`.
- A run is `succeeded` only after confirmed integration with no remaining graph work.
- Use persisted event/checkpoint timestamps for created/updated times, not the time the UI fetched the record.

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
