# Adapter worker: review results on the read-only project API

Extend the existing Fastify project API (`server/`) so a run's recorded independent review is served and the review node points at it. The contract is `contracts/projects/README.md` (`reviewResult`, contract 1.1.0, `contracts/projects/examples.ts`, `contracts/projects/reviewResult.schema.json`). Read `features/review-result/README.md` for the export 1.2.0 seam, and `features/project-workflows/README.md` for everything unchanged. Keep the frozen contracts and the runtime engine unchanged.

## Ownership

Only edit `server/` and `config/projects.example.json`. Do not modify UI, `workflow/`, contracts, feature policy, package manifests or the root browser configuration. Use existing Node/Fastify/Zod dependencies. Escalate necessary changes outside ownership rather than making them.

## Deliverables

- Accept `run-state.json` exports whose `version` has major 1 and minor ≥ 0 (`1.0.0`, `1.1.0`, `1.2.0`, later `1.2.x`). The `review` and `inputs` sections may be absent (1.0.0), `null`, or present; unknown top-level sections are ignored. Everything else about the export is unchanged. `inputs` is not served in this slice.
- `GET .../runs/{run_id}/reviews/{attempt}`: build a `reviewResult` from the export's `review` section. `attempt` other than `1` is 404; a run without a review section is 404 with a code that says no review is recorded. `reviewer_session` is `review.reviewer` (for `manual` transport this is the operator's stated identity); `independent`, `transport`, `bundle_sha256`, `candidate_commit`, `verdict`, `reviewed_at` map directly. Findings map `worker` and `requirement` through, with `null` when the export has null or omits them; do not set `requirement_verbatim` (slice C). Validate the response against the committed schema before sending it, as the other routes do.
- Review node in the run detail snapshot: `session_id` = the reviewer identity and `result_uri` = the scoped reviews route when a review is recorded; both `null` otherwise, with no error. A blocked review keeps the node's failed status from the task error; the review result is still served.
- Register `review.diff` as a bounded artifact of kind `patch` (`artifact_id` of your choice, content type `text/x-diff` or `text/plain`, same confinement, no-follow, byte-limit and hash rules as packet artifacts, hash from the export's `review.diff.sha256`). Serve it through the existing artifacts route and reference it in `diff_artifact`; `diff_artifact` is `null` when the export has no diff or the file fails its checks (the reviews route still succeeds).
- `redactPaths` on finding messages and requirement quotes, as on summaries and gate reasons.
- Old runs (export 1.0.0, no review section): the run detail, events and worker results behave exactly as today. Nothing about worker results changes.
- Update `config/projects.example.json` only if the registry shape needs a comment about export versions; it does not need new fields.

## Verification

Extend `server/projects.test.ts` (executed by the policy's `backend-unit` command) with disposable roots: export versions 1.0.0, 1.1.0 and 1.2.0 all load; a review section with native, print and manual transports; findings with and without `worker`/`requirement`; a blocked review; attempt 2 and missing review are 404; the review node's `session_id`/`result_uri`; the diff artifact's confinement, symlink, hash-mismatch and oversize failures; path redaction in messages and quotes. Existing tests must keep passing without project configuration. `backend-regression`, `shared-contract` and `backend-build` run unchanged.

Do not claim tests were executed if they were not.

## Out of scope (decided)

Issues #3 (stale task error projects a verified node as failed) and #6 (unredacted raw error body) are not part of this task, even though both touch `server/projects.ts` near this work. Do not fix them here.

## Finish

Report a summary, all changed files, checks actually executed and open assumptions, then follow the appended completion-file protocol and finish your turn. Do not commit, push, merge, launch other agents or modify shared contracts/runtime.
