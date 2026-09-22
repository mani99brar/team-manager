# Adapter worker: run inputs route and verbatim requirement lookup

Extend the Fastify project API (`server/`) so a run's inputs are served and each review finding says whether its requirement quote is found verbatim in the named worker's task text. Contract: `contracts/projects/README.md` (`runInputs`, `runInputsResponse`, `requirement_verbatim`; contract 1.2.0; `contracts/projects/runInputs.schema.json`). Read `features/run-inputs/README.md` for the `inputs` export section, and the review-result and project-workflows READMEs for everything unchanged. Keep the frozen contracts and the runtime engine unchanged.

## Ownership

Only edit `server/` and `config/projects.example.json`. Do not modify UI, `workflow/`, contracts, feature policy, package manifests or the root browser configuration. Use existing Node/Fastify/Zod dependencies. Escalate necessary changes outside ownership rather than making them.

## Deliverables

- `GET .../runs/{run_id}/inputs`: `{ "inputs": RunInputs | null }` from the export's `inputs` section, validated against `runInputsResponse` before sending. `null` when the section is absent or null (exports before 1.2.0); 404 only for an unknown run. Map the section's fields one to one; `contract_version` is `1.2.0` and `run_id` is the run's id. Automatic settings without `reviewer_transport` (runs prepared before slice A) are served with `reviewer_transport: "print"`.
- Bounded reads and redaction: task text, summaries, open assumptions and any free text pass through `redactPaths`; the export already caps task text at 256 KiB and marks truncation, and the adapter must not read beyond its existing byte limits.
- Reviews route: set `requirement_verbatim` on each finding. `true` when the redacted quote is a verbatim substring of the redacted task text of the named worker (`ui` or `adapter`; for `both`, of either task), `false` when it is not, `null` when `requirement` or `worker` is null, `worker` is `none`, or the run has no inputs. Exact substring only; no normalisation beyond the identical redaction, no fuzzy matching.
- Old runs (no `inputs` section) serve `inputs: null`; nothing else about the run detail, events, worker results or reviews changes.

## Verification

Extend `server/projects.test.ts` with disposable roots: an export with a full `inputs` section (both workers, launch/completion/handoff/stop present and absent), one with `inputs: null`, one at export 1.0.0 without the key; response conformance to `runInputsResponse`; redaction of task text and assumptions; truncation marker passthrough; `requirement_verbatim` true, false and null cases including `both` and `none`, and the null case when inputs are missing; unknown run is 404. Existing tests must keep passing. `backend-regression`, `shared-contract` and `backend-build` run unchanged.

Do not claim tests were executed if they were not.

## Finish

Report a summary, all changed files, checks actually executed and open assumptions, then follow the appended completion-file protocol and finish your turn. Do not commit, push, merge, launch other agents or modify shared contracts/runtime.
