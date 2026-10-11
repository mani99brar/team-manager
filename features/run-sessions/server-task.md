# Server worker: read every session of a run and project the reviewer, panel and lane-review nodes (PRD_RUN_SESSIONS)

## Goal

The run page needs every session of a run (`docs/PRD_RUN_SESSIONS.md` sections 1 to 4 and Appendix A). Build the server side, reading the per-session files live from the run directory, with no controller or export change ([O2]):

1. **Sessions route.** `GET /api/projects/:project_id/workflows/:workflow_id/runs/:run_id/sessions` (GET and HEAD) answers Appendix A, contract 1.13.0, defined in a new `contracts/projects/sessions.ts` (zod, `strictObject`) with its generated `sessions.schema.json` (through `contracts/projects/export.ts`) and an example in `contracts/projects/examples.ts`. An unknown project, workflow or run is a 404 with the existing error shape. Readers go in `server/sessions.ts` (run directory) and `server/nightShift.ts` (the night-shift folder); the route is registered in `server/projectRoutes.ts`.
2. **Every role** of PRD 4 becomes rows: challenge attempts, workers, repairs, lane reviewers, reviewers (latest round and archived rounds), critique, panel providers, night-shift providers (Claude, GPT and Jev as rows of role `night_shift`). A missing or malformed file makes that fact `null` (or drops that one row), never an error for the run. `total_cost_usd` sums the known costs; `costs_not_recorded` counts the rows whose cost is `null`.
3. **Lane reviews.** One `lane_reviews` entry per `lane-review/<lane>/<n>.json` record (`contracts/workflow/lane-review.schema.json` 1.0.0): its reviewers, findings and `fix_round` (started, with the repair node id from `repairs.json` whose `origin` is `lane-review` for that lane and round; or not, with the reason the `lane_review:` event line on `verify_<lane>` gives, for example "rounds used up, fix loop off or repair cap").
4. **Night shift.** `server/nightShift.ts` reads `MD_MANAGER_NIGHT_SHIFT_DIR` (default `~/.local/state/md-manager-workflows/night-shift`, resolved from `HOME`): every `<date>/states/*/record.json` whose `run_id` is the run's and whose texts name this run's directory or none, with `claude.json`, `gpt.json` and the record's `jev`. It maps them onto `night_shift` (Appendix A) with `node_id` from the record's `node` when that is a node of the run (else `null`). The folder may be missing: then the list is empty.
5. **Projected nodes.** The run detail's definition and snapshot gain `reviewer-<id>` per reviewer of the latest review round (including `critique`), `panel` when `panel.json` exists, and `lane-review-<lane>-<n>` per lane-review record, following `insertRepairs`/`projectedDefinition` in `server/projects.ts`: existing node shapes and kinds (`review`), `definition_revision` unchanged, an id that collides with a pinned node refused as a colliding repair id is. Reviewer and panel nodes depend on what `review` depends on, and the projected `review` also depends on them; lane review nodes depend on `verify_<lane>` and nothing depends on them. Each projected node's snapshot status comes from its record (a reviewer's verdict and completion, the lane-review record's status), its `session_id` only when it matches the export's ID pattern.
6. **Triage.** `contracts/projects/triage.ts` treats the projected nodes as advisory (`ADVISORY_NODE_IDS` or a prefix rule beside it): never the focus, never the Now banner, never the run's state word.
7. **The handoff.** `docs/handoff/run-sessions-server.md`: the route, each source file per role, what is `null` when, the node projection rule, and open items.

## Context

- Read first: `server/projects.ts` (export parsing, `insertRepairs`, `projectedDefinition`, `checkLoopGraph`, `reviewer_entries` projection, `redactPaths`, the panel and fix-loop readers), `server/projectRoutes.ts`, `contracts/projects/v1.ts`, `contracts/projects/triage.ts`, `workflow/lane_review.py`, `workflow/panel.py`, `workflow/export_state.py`, and a real run directory read-only: `~/.local/state/md-manager-workflows/projects-dispatch/projects-dispatch-002/` (two lane-review rounds per lane, three repairs, two review rounds, critique) and the night-shift folder `~/.local/state/md-manager-workflows/night-shift/` (records for run-controls-004 and others). Copy shapes, never paths or ids, into fixtures.
- Redaction: every text served passes `redactPaths`; working directories become `~`-relative (`~/...`) or `null`; a `resume.command` is `cd <dir> && claude --resume <id>` with that `~`-relative dir, or `claude --resume <id>` when the dir is `null`. No credential, no absolute path anywhere in a response.
- The `viewer` lane works in parallel against Appendix A and PRD 4's projection rule, with mocked routes in its worker phase and your server on seeded run directories in its candidate phase. Do not rename, remove or retype an Appendix A field; a change you cannot avoid is a `question` completion.
- A lane reviewer (GPT 6.1) reviews your lane's diff after your checks pass. A P0/P1 from it starts one repair round of your lane; repairs are scarce (three per run), so make each test fail on the regression it names before you complete.

## Constraints

- Owned paths only (policy.json `server`). Do not touch `workflow/`, `contracts/workflow/`, `src/`, `tests/`, `server/app.ts`, `server/index.ts` or the run-controls files.
- Read-only: no write anywhere, no spawn, no network. GET and HEAD only.
- The export schema and the existing run-detail contract keep their shapes; projected nodes use existing entries.
- No new dependency.

## Acceptance

- `server/sessions.test.ts` builds run directories under a temporary root (and a temporary night-shift folder through the env variable) and proves: each role's rows from its files, `null` facts for missing or malformed files, the cost total and count, lane-review `fix_round` both ways, night-shift matching by run id and directory (a record of another run with the same id in another directory is not served), the projected nodes and their dependencies (and a collision refused), triage never focusing a projected node, and no absolute path in any string of the response.
- `contracts/projects/contract.test.ts` validates the sessions example against the schema.
- The existing server and contract tests still pass.
- `frontend-build`, `frontend-lint`, `shared-contract` and `frontend-unit` pass.

Run targeted tests while iterating, then this lane's non-browser policy checks once before writing the completion.

## Stop

Stop and report `question` when a fact the PRD asks for is in no file of the run directory or the night-shift folder, or when a fix needs a change outside your owned paths (the export, the controller, `server/app.ts`).
