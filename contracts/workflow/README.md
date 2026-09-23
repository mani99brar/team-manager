# Workflow contract v1.0.0

Reusable data boundary for a LangGraph backend, independent Claude sessions, and a workflow viewer. This directory defines data, not an executor, server, or authorization mechanism. No workers are launched by these files.

## Files and usage

- `v1.ts`: authoritative Zod schemas, inferred TypeScript types, cross-field validators.
- `*.schema.json`: generated JSON Schema (2020-12) for Python and other consumers.
- `examples.ts`: synthetic fixtures for every message (not execution evidence).
- `contract.test.ts`: positive/negative validation and schema-drift tests.
- `verification.schema.json`: the separately authored verification policy (see below).
- `feature.schema.json`: the committed feature file `<target>/features/<name>/feature.json` (versions 2.0.0, 2.1.0 and 2.2.0, hand-written): `workers` declares every lane with its `node_id` and task file; the ids must match the policy's `workers[].node_id`. 2.1.0 adds the optional `reviewers`: every reviewer of the run with a `reviewer_id` (same rules as a lane id: `^[a-z][a-z0-9-]{0,31}$`, unique, never a lane id of the policy nor a reserved name) and its brief (`prompt`: a file relative to the feature directory, existing and non-empty, or `builtin:<id>` for a brief bundled in `workflow/prompts/reviewers/`, today `general` and `coverage`). A file without `reviewers` runs the single built-in reviewer (`workflow/prompts/review.md`) with id `review`. `workflow launch` validates it, refuses a 1.0.0 `ui_task`/`adapter_task` file with a message to use 2.x, refuses `reviewers` on a 2.0.0 file and an unknown `builtin:` id, and `--workers a,b` selects a subset of the declared lanes. 2.2.0 turns on the guardrails (docs/PRD_PORTABLE_WORKFLOW.md section 4.3) and adds the optional `challenge` (boolean, default true) and `prd` (a path relative to the target, no leading `/` or `..` segment); `launch` then refuses a task without non-empty `## Goal`, `## Acceptance` and `## Stop` sections, a missing or empty `decisions.md` and a `prd` that does not exist, and refuses `challenge` or `prd` on an earlier version.
- `challenge.schema.json`: the design challenge record `<run>/challenge.json` (version 1.0.0, hand-written) a 2.2.0 run writes before any worker launch: `status` (`passed`, `paused`, `accepted`, `disabled`), `attempt`, the print job's `session_id`, the `pinned` hashes of the tasks, decisions.md and PRD it read, `concerns` (`severity` P0/P1/P2, `kind`, `message`, `consequence`), `simpler_alternative`, `cheap_experiment`, `accepted_reason` (exactly when accepted) and `decided_at`. `$defs.output` is the job's structured output (`--json-schema`). The controller validates with `validate_schema("challenge", ...)`; its conditionals (`if`/`then`) are JSON Schema only, so `zod.fromJSONSchema` cannot read this file.
- Worker completion files (`<run>/<lane>.completion.json`) are validated in Python (`workflow/automatic.py` `read_signal`): version 1.0.0 `{version, run_id, node_id, launch_token, status (completed|blocked), summary, open_assumptions}` for runs prepared before the guardrails; 1.1.0 for 2.2.0 runs adds `untested` (list), `falsifying_check` and `verify_yourself` (non-empty when `completed`) and `question`, and the status `question`. A run accepts only the version it pinned.
- `examples/registry-entry.json`: the golden Projects registry entry a live `workflow launch` writes (`workflow/registry.py`); the Python test compares the builder's output with it and `contract.test.ts` parses it with the server's registry schema (`server/projectsConfig.ts`).
- `reviewCompletion.schema.json`: the completion file a native reviewer session writes to `<run>/<node>.completion.json` (version 1.2.0, hand-written, not generated from `v1.ts`), where `<node>` is `review` for the default reviewer and `review-<reviewer_id>` for a declared one (`node_id` pattern `^review(-[a-z0-9-]{1,32})?$`; files spelling 1.0.0 or 1.1.0 stay accepted). The Python controller validates it with `workflow.verification.validate_schema("reviewCompletion", ...)` and additionally binds `run_id`, that reviewer's `node_id` and `launch_token`, `bundle_sha256` and `candidate_commit` to the run before accepting a verdict (a file naming another reviewer's node is rejected and blocks the run); findings carry `worker` (one of the run's selected lane ids, `multiple` or `none`; the controller rejects a lane the run did not select, and the legacy `both` is refused) and `requirement` for the viewer's finding-to-task links. Every declared reviewer must approve; any block, unresolved P0/P1, rejected file or deadline from any reviewer ends the run.

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

Artifact `kind` is `patch`, `log`, `screenshot`, `test_report`, `other` or `file`. A `file` artifact is a changed text file the trusted verifier copied from the frozen snapshot before any check ran (worker phase only); it carries `path`, the repo-relative path (no leading `/`, no `..` segment, no backslash or drive letter), and no other kind may carry `path`. The optional `files_not_captured: [{path, reason}]` lists the other changed paths with `reason` `binary` (not UTF-8 or contains NUL), `too_large` (over 512 KiB), `missing` (deleted, renamed away or not a regular file) or `budget` (over the 8 MiB packet total). Both are additive: `contract_version` stays `1.0.0` and a result without them is valid. The exported JSON Schema states the path rule as an `anyOf` on the artifact object (TypeScript enforces it by refinement). Because `event.artifact` and the projects review `diff` reuse the artifact schema, their exported schemas gain the same kind and rule; the review diff remains a `patch` by its own cross-field rule.

Cross-field validation requires unique artifact IDs, a referenced log artifact for every executed check, chronological check timestamps, every `file` artifact `path` and every `files_not_captured` path naming a distinct entry of `changed_files`, an error for failure, no error for success, and an output commit for success. Failed/cancelled attempts may have no output commit; preserve partial work as a patch artifact when available. Checks record actual commands, working directories, times and exit codes, not proposed commands.

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

Policy v1.2.0 declares worker lanes from configuration: `workers` has one or more entries; `node_id` matches `^[a-z][a-z0-9-]{0,31}$`, is unique and is never a reserved name (`review`, `candidate`, `handoff`, `approval`, `integrate`, `multiple`, `none`, `both`, `challenge`, or anything starting with `launch_`, `verify_`, `candidate_`, `review-` or `challenge-`: the design challenge owns the node `challenge` and the run files `challenge.json`, `challenge-<n>.*`, `challenge-inputs/` and `challenge-worktree/`); `role` is a free label of 1 to 40 characters; `required_check_kinds` lists one or more check kinds that must each appear in that lane's `checks`; `failure_drill.node_id` is any declared lane. Owned paths stay pairwise disjoint across all declared lanes. Versions 1.0.0 and 1.1.0 stay accepted so pinned policies in old runs still validate; for those `role` is `frontend` or `backend`, `required_check_kinds` is absent and the controller derives it from the role (frontend: build and browser; backend: unit). Every committed feature uses v1.2.0; `workflow/RUNBOOK.md` describes the launch and the checkpoint drill.

## Versioning

Every message carries an exact `contract_version`. Unknown versions and unknown fields are rejected. Keep v1 immutable once consumers depend on it; publish compatible/additional formats under an explicitly negotiated new version rather than silently changing existing payloads. Each run pins its contract through its base Git revision.
