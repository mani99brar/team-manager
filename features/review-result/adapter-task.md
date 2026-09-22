# Adapter worker: serve the persisted review verdict

Implement the backend side of slice B in `docs/PRD_REVIEW_RESULT.md` on the existing Fastify server. The payload is `reviewResult` in `contracts/projects/v1.ts` (`validateReviewResult`) and the producer shape is the `review` section of `run-state.json` version `1.1.0`/`1.2.0` described in `features/review-result/README.md`. Keep the frozen contracts and runtime engine unchanged.

## Ownership

Only edit `server/` and `config/projects.example.json`. Do not modify UI, `workflow/`, contracts, feature policy, package manifests or the root browser configuration. Use existing Node/Fastify/Zod dependencies. Escalate necessary changes outside ownership to Pi/the operator.

## Deliverables

- `exportSchema` accepts export versions `1.0.0` (no `review`/`inputs` keys), `1.1.0` (`review`, no `inputs`) and `1.2.0` (both). `review` is optional-or-null; when present it is validated strictly against the section shape in the feature README. A violation is `RUN_STORAGE_INVALID` naming the run but never a path. Never trust `values.review`.
- `GET /api/projects/:project_id/workflows/:workflow_id/runs/:run_id/reviews/:attempt` returns `reviewResult` after `validateReviewResult` and `conform(schemas.reviewResult, ...)`: `reviewer.session_id` = `reviewer_session_id`, `reviewer.transport` and `independent` passed through, `reviewed_at` passed through, `findings[].message` and `requirement` through `redactPaths`, `requirement_found_in` computed against the raw `inputs.workers.<lane>.task` (or `prompt` when the task is missing) — a lane is included only when `requirement` is a verbatim substring; empty when `requirement` is null or `inputs` is absent. 404 `REVIEW_NOT_FOUND` when the run has no review section or the attempt is not the recorded one; 405 for other methods; `HEAD` handled like the existing routes.
- Run detail: the `review` node gets `session_id = reviewer_session_id` and `result_uri = <run route>/reviews/<attempt>` when the export has a review section; status logic is unchanged (task error → failed, evidence → succeeded, …). Old exports keep `session_id`/`result_uri` null.
- Artifact route: when the review section has `diff`, the artifact id `patch-review-<first 12 hex of sha256>` resolves to `<run>/review.diff`, read bounded by `artifactByteLimit`, hash-verified, served `text/plain; charset=utf-8` inline with the same nosniff/CSP headers as packet artifacts. Mismatch → `ARTIFACT_HASH_MISMATCH`; missing → `ARTIFACT_UNAVAILABLE`; ids matching neither registry → `ARTIFACT_NOT_FOUND`.
- Manual-transport reviews pass the operator-stated identity through as `session_id`. Error messages never contain paths. Nothing is written into the run root by a read.

## Verification

Extend `server/projects.test.ts` (executed by the policy's tsx command) with disposable roots: review served with redaction (a finding message containing an absolute path under the temp root comes back with `<path>`), `requirement_found_in` computed only from verbatim matches, the diff artifact served, hash-checked and bounded, a blocked review served with verdict `blocked` while the node projects `failed` and the run `failed`, a legacy `1.0.0` export → 404 `REVIEW_NOT_FOUND` with detail still 200 and `session_id`/`result_uri` null, a `1.1.0` export loading, manual transport passing through the operator identity, malformed sections → 500 `RUN_STORAGE_INVALID` without paths, every payload conforming to the committed schemas and cross-field validators, and 405/HEAD on the new route. Existing app tests must still pass without project configuration.

No new dependencies or changes to global permission settings are authorized. The trusted verifier independently runs your unit/contract/build checks after handoff. Do not claim tests were executed if they were not.

## Finish

Report a summary, all changed files, checks actually executed (or explicitly none) and open assumptions. In manual mode wait for the operator to freeze. In automatic mode follow the appended completion-file protocol and finish your turn without waiting for a human. Do not commit, push, merge, launch other agents or modify shared contracts/runtime.
