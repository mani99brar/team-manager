# Workflow contract v1.0.0

Reusable data boundary for a LangGraph backend, independent Claude sessions, and a workflow viewer. This directory defines data, not an executor, server, or authorization mechanism. No workers are launched by these files.

## Files and usage

- `v1.ts`: authoritative Zod schemas, inferred TypeScript types, cross-field validators.
- `*.schema.json`: generated JSON Schema (2020-12) for Python and other consumers.
- `examples.ts`: synthetic fixtures for every message (not execution evidence).
- `contract.test.ts`: positive/negative validation and schema-drift tests.
- `verification.schema.json`: the separately authored verification policy (see below).
- `feature.schema.json`: the committed feature file `features/<name>/feature.json` (version 2.0.0, hand-written): `workers` declares every lane with its `node_id` and task file; the ids must match the policy's `workers[].node_id`. `workflow launch` validates it (translating a deprecated 1.0.0 `ui_task`/`adapter_task` file first) and `--workers a,b` selects a subset of the declared lanes.
- `reviewCompletion.schema.json`: the completion file a native reviewer session writes to `<run>/review.completion.json` (version 1.1.0, hand-written, not generated from `v1.ts`). The Python controller validates it with `workflow.verification.validate_schema("reviewCompletion", ...)` and additionally binds `run_id`, `node_id`, `launch_token`, `bundle_sha256` and `candidate_commit` to the run before accepting a verdict; findings carry `worker` (one of the run's selected lane ids, `multiple` or `none`; the controller rejects a lane the run did not select, and the legacy `both` is refused) and `requirement` for the viewer's finding-to-task links.

Run `npm run contracts:export` after editing schemas, and `npm run test:contracts` to validate. Non-TypeScript consumers must implement the cross-field and runtime invariants below in addition to JSON Schema validation.

## Message boundaries

| Message | Purpose |
| --- | --- |
| `runSpec` | Per-run objective, immutable base revision, worker assignments, isolation paths, acceptance criteria, usage policy |
| `workerResult` | Immutable result of one worker attempt, including changed files, executed checks, assumptions and durable artifacts |
| `runSnapshot` | Current run/node projection, dependency edges, latest attempt/session and replay cursor |
| `event` | Append-only status/log/artifact/result/reuse/approval/return-note timeline |
| `controlRequest` | Idempotent request for an authorized backend action; not proof that it was accepted |

Task-specific application types and APIs belong in their own contract. This workflow envelope does not replace them.

## Revision and isolation rules

1. Commit this contract and the task-specific shared interface before worker launch.
2. Set `base_commit` in the runtime run specification to that full Git SHA. Do not attempt to embed a commit's own SHA into files inside that commit.
3. Create each worktree from that revision. The launcher must actually run `git rev-parse HEAD`, verify a clean worktree, and record `observed_start_commit`; never trust an agent's assertion alone.
4. `validateRunSpec` requires unique worker IDs, distinct worktree strings and identical base SHAs. The launcher must additionally resolve real paths, check independent Git worktrees and reject overlapping ownership boundaries. Schema validation cannot prove filesystem isolation.
5. The `runSpec` envelope of this lab profile allows at most two concurrent implementation workers; the pipeline's worker lanes come from the verification policy and are not bounded by it (see below). Review follows worker verification, in its own worktree; Pi is the sole integration authority. Cache/test/browser isolation applies to review too.
6. Worktree paths and execution sessions are backend-only information. Redact sensitive paths, credentials and logs before publishing UI data.

## Results and join rules

Attempts start at 1; 0 in snapshots/events means not started or run-scoped. A new actual execution increments the attempt, including retry after failure. Record external session identity before allowing duplicate launches.

Required result arrays may be empty, but must be present. Empty `checks` means **no checks executed**, not a pass. `succeeded` means the worker completed its assignment, not that integration is approved. The join applies task-specific required checks and assumptions policy. Browser verification is a separate gate; repeat an integration smoke test against the real adapter.

Cross-field validation requires unique artifact IDs, a referenced log artifact for every executed check, chronological check timestamps, an error for failure, no error for success, and an output commit for success. Failed/cancelled attempts may have no output commit; preserve partial work as a patch artifact when available. Checks record actual commands, working directories, times and exit codes, not proposed commands.

The join additionally verifies run/node/attempt identity, matching base revision, file ownership, complete diff against base, output commit availability, artifact hashes and required gate outcomes. References are not evidence until resolved and verified. Artifacts must be immutable and retained across process restarts. `artifact://` is an opaque example locator; the backend resolves it to authorized content, not an arbitrary browser-fetchable URL.

### Phases, deferred checks and the candidate's lane results

The controller verifies each lane's snapshot in isolation (the worker phase) and then every lane on one combined revision (the candidate phase). A lane's `build` and `browser` checks need the whole application, so on the isolated snapshot they are executed and recorded but do not gate; the packet gate lists them in `deferred_checks`, and the adapter serves them on that `workerResult` as `deferred_checks[] = {id, check_index}` (`check_index` names the entry of `checks` that ran). The field is absent when nothing was deferred, and the immutable capture itself never carries it. The candidate phase gates on every check.

Because the combined candidate holds one verified result per lane, its `runSnapshot` node carries `lane_results[] = {worker, attempt, result_uri}` in lane order at the latest candidate attempt, each served under `results/candidate_<lane>/<attempt>`; every other node has an empty `lane_results`.

## Events, controls and recovery

The backend persists events with a unique event ID and strictly increasing per-run `sequence`. Deliveries may repeat: consumers deduplicate by event ID. Fetch a snapshot at `last_sequence`, then replay events after that cursor; preserve replay across reconnects. The transport (SSE/WebSocket/HTTP) is deliberately not fixed yet.

Event payload requirements enforced by the backend:
- `status_changed`: non-null `status`.
- `artifact_published`: non-null `artifact`.
- `result_published`: non-null immutable `result_uri`.
- `result_reused`: `result_uri` and `reused_from_attempt`; reuse is not a new worker execution.
- `approval_requested`: describe the pending decision in `message`.
- `return_note`: describe current run state, independent task and next action.
- `log`: sanitized message; full output may live in a log artifact.

Run-scoped events use `node_id: null` and `attempt: 0`. All other event fields are explicitly nullable rather than implicit.

Control request IDs are idempotency keys. The backend authenticates and authorizes callers, checks `expected_sequence` against current state and rejects stale/illegal actions. Acknowledgement is not completion; publish resulting state events. Pause must preserve partial evidence and reach a safe execution boundary. Never automatically approve budget/provider changes. On exhausted usage, pause and request the configured alternative plan.

Use a durable LangGraph checkpointer and explicit session/artifact tracking. A checkpoint does not preserve a Git worktree or make an external Claude launch exactly-once. On recovery reconcile existing session and artifact identity before relaunching. Preserve successful branch results only after checking they match this run's base, assignment and contract. Record forced failure and actual starts/reuse in events; do not assume Claude workflow relaunch and LangGraph node resume have the same replay semantics.

## Verification policy extension

The separately authored `verification.schema.json` accepts policies v1.0.0, v1.1.0 and v1.2.0. Only v1.1.0 and later may specify `max_verification_attempts` and the explicit first-attempt `failure_drill`. Workflow message envelopes and worker-result schemas remain v1.0.0.

Policy v1.2.0 declares worker lanes from configuration: `workers` has one or more entries; `node_id` matches `^[a-z][a-z0-9-]{0,31}$`, is unique and is never a reserved name (`review`, `candidate`, `handoff`, `approval`, `integrate`, `multiple`, `none`, `both`, or anything starting with `launch_`, `verify_`, `candidate_` or `review-`); `role` is a free label of 1 to 40 characters; `required_check_kinds` lists one or more check kinds that must each appear in that lane's `checks`; `failure_drill.node_id` is any declared lane. Owned paths stay pairwise disjoint across all declared lanes. Versions 1.0.0 and 1.1.0 stay accepted so pinned policies in old runs still validate; for those `role` is `frontend` or `backend`, `required_check_kinds` is absent and the controller derives it from the role (frontend: build and browser; backend: unit). The configured Projects-viewer feature uses v1.2.0; see `features/project-workflows/README.md` for the launch and checkpoint drill.

## Versioning

Every message carries an exact `contract_version`. Unknown versions and unknown fields are rejected. Keep v1 immutable once consumers depend on it; publish compatible/additional formats under an explicitly negotiated new version rather than silently changing existing payloads. Each run pins its contract through its base Git revision.
