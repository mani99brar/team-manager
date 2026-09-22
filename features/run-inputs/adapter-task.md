# Adapter worker: serve run inputs and verbatim finding-to-task matches

Implement the backend side of slice C in `docs/PRD_RUN_INPUTS.md` on the existing Fastify server. The payload is `runInputs` in `contracts/projects/v1.ts` (`validateRunInputs`); `reviewResult` findings gain `requirement_found_in`. The producer shape is the `inputs` section of `run-state.json` version `1.2.0` described in `features/run-inputs/README.md`. Keep the frozen contracts and runtime engine unchanged.

## Ownership

Only edit `server/` and `config/projects.example.json`. Do not modify UI, `workflow/`, contracts, feature policy, package manifests or the root browser configuration. Use existing Node/Fastify/Zod dependencies. Escalate necessary changes outside ownership to Pi/the operator.

## Deliverables

- `exportSchema`: `inputs` optional-or-null; when present it is validated strictly against the section shape in the feature README (`RUN_STORAGE_INVALID` on violation, naming the run but never a path). Versions `1.0.0`, `1.1.0` and `1.2.0` keep loading.
- `GET /api/projects/:project_id/workflows/:workflow_id/runs/:run_id/inputs` returns `runInputs` after `validateRunInputs` and `conform(schemas.runInputs, ...)`: `workers` as an array in policy order with `node_id` = lane and `launch_node_id` = `launch_<lane>` when that node exists in the pinned definition, else the lane; `task`/`prompt` texts through `redactPaths`, truncated to 65536 characters with the marker `\n\n[… truncated by the viewer API: N more characters]` and `truncated: true`; `launch.native_started_at` epoch milliseconds → ISO `Z` string; `launch.launch_requested_at` normalised to `Z`; `setup[].command` and `checks[].command` passed through (never re-joined); `stop.confirmed_at` passed through; receipts null when the run has not produced them. 404 `INPUTS_NOT_FOUND` when the section is absent; 405 for other methods; `HEAD` handled like the existing routes.
- `reviewResult.findings[].requirement_found_in`: computed against the raw (pre-redaction) `inputs.workers.<lane>.task` text, or the `prompt` when the task is missing; a lane is included only when `requirement` is a verbatim substring; empty when `requirement` is null or `inputs` is absent. Never guess a match.
- Error messages never contain paths. Nothing is written into the run root by a read.

## Verification

Extend `server/projects.test.ts` (executed by the policy's tsx command) with disposable roots: inputs projection (task truncation at 65536 characters with the marker, `prompt: null` passthrough, timestamps normalised to `Z`, `stop.confirmed_at`, `launch_node_id`), `requirement_found_in` from verbatim matches only (a quote found in the ui task → `['ui']`, a paraphrase → `[]`, a null requirement → `[]`), redaction of absolute paths in task text and completion summaries, a legacy export → 404 `INPUTS_NOT_FOUND` with detail still 200, malformed sections → 500 `RUN_STORAGE_INVALID` without paths, every payload conforming to the committed schemas and cross-field validators, 405/HEAD on the new route, and nothing written into the run root. Existing app tests must still pass without project configuration.

No new dependencies or changes to global permission settings are authorized. The trusted verifier independently runs your unit/contract/build checks after handoff. Do not claim tests were executed if they were not.

## Finish

Report a summary, all changed files, checks actually executed (or explicitly none) and open assumptions. In manual mode wait for the operator to freeze. In automatic mode follow the appended completion-file protocol and finish your turn without waiting for a human. Do not commit, push, merge, launch other agents or modify shared contracts/runtime.
