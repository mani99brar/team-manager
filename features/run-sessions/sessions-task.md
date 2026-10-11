# Sessions worker: make every session of a run visible on the run page, server to page (PRD_RUN_SESSIONS)

## Goal

Every session that worked on a run is visible on the run page (`docs/PRD_RUN_SESSIONS.md`; its Appendix A is the route's shape). You own the whole stack in one lane ([P14]): build the server side first, then the pages on it, and prove both phases of the browser specs in your own worktree.

**Server**

1. **Sessions route.** `GET /api/projects/:project_id/workflows/:workflow_id/runs/:run_id/sessions` (GET and HEAD) answers Appendix A, contract 1.13.0, defined in a new `contracts/projects/sessions.ts` (zod, `strictObject`) with its generated `sessions.schema.json` (through `contracts/projects/export.ts`) and an example in `contracts/projects/examples.ts`. An unknown project, workflow or run is a 404 with the existing error shape. Readers go in `server/sessions.ts` (run directory) and `server/nightShift.ts` (the night-shift folder); the route is registered in `server/projectRoutes.ts`.
2. **Every role** of PRD 4 becomes rows, from the sources PRD 4 lists: challenge attempts, workers, repairs, lane reviewers, reviewers (latest and archived rounds; `late` from `automatic-review-<id>.json`), critique, sidecar passes, attack angles, panel providers, night-shift providers (Claude, GPT and Jev as rows of role `night_shift`). A missing or malformed file makes that fact `null` (or drops that one row), never an error for the run. `totals` split metered and covered costs (PRD 3.4).
3. **Lane reviews.** One `lane_reviews` entry per `lane-review/<lane>/<n>.json` record: its reviewers (`model` nullable), findings, and `fix_round` from the record's own `repair` number (`repair-<n>`), or the recorded reason (PRD 3.2): the `lane_review:` event's words on `verify_<lane>` when the gate refused, "no P0/P1" for a clean round, "the review failed: <first line>" for a failed record.
4. **Night shift.** `server/nightShift.ts` reads `MD_MANAGER_NIGHT_SHIFT_DIR` (default `~/.local/state/md-manager-workflows/night-shift`, resolved from `HOME`) and maps records onto `night_shift` with the matching, `decided_at`, `confidence` and `jev` rules of PRD 4. The folder may be missing: then the list is empty.
5. **Projected nodes** (PRD 4): `reviewer-<id>` per entry of the export's `review.reviewers` of the latest round, `panel` exactly when the panels route answers, `lane-review-<lane>-<n>` per record, following `insertRepairs`/`projectedDefinition`/`checkLoopGraph` in `server/projects.ts`; snapshot status from the records; `session_id` only when it matches the export's ID pattern. Triage (`contracts/projects/triage.ts`) keeps them advisory.
6. **Resume and redaction** exactly as PRD 3.5 and 4: the command composed after redaction and gated on `viewer.expose_run_dir`; every other text through `redactPaths` and the credential filter.

**Pages**

7. **Reviewer and panel nodes** on the Signal Box stage (`src/projects/signal/`), side by side before the review gate, each with its state word, open P0/P1 count and cost (PRD 3.1). Scenario `sessions-stage`.
8. **Lane review nodes** after each verify step, and their node page (PRD 3.2). Scenario `sessions-lane-review`.
9. **Reviewer node pages** with the session block, verdict, own findings and earlier rounds (PRD 3.1). Scenario `sessions-reviewer`.
10. **Session block** on every node page that belongs to a session, with the resume command for Claude sessions (PRD 3.4, 3.5). Scenario `sessions-reviewer`.
11. **Sessions section** on the run page with both totals (PRD 3.4). Scenario `sessions-list`.
12. **The panels:** the `Panel` node page, and the night-shift decisions on the node they decided with the run page's one-line count (PRD 3.3). Scenario `sessions-panel`.
13. **Phone (390 px)** and 44 px targets for the new links and buttons. Scenario `sessions-phone`.
14. **The critique app and the handoff.** `tests/project-workflows/sessions-app.ts` starts the real server on the seeded sessions run (ready at `/api/projects`, as `controls-app.ts` does for its feature); `docs/handoff/run-sessions.md` says what changed, the test ids and open items; `docs/VIEWER_SIGNAL_BOX.md` describes the new cards.

## Context

- Read first: `server/projects.ts` (export parsing, `insertRepairs`, `projectedDefinition`, `checkLoopGraph`, the reviewer projection, `redactPaths`, the panel and fix-loop readers, `run_dir` and `viewer.expose_run_dir`), `server/projectRoutes.ts`, `contracts/projects/v1.ts` and `README.md` (1.9.0 panels, `PANELS_NOT_FOUND`), `contracts/projects/triage.ts`, `workflow/lane_review.py`, `workflow/panel.py`, `workflow/costs.py`, `workflow/export_state.py`; `src/projects/signal/` (`model.ts`, `RunStage.tsx`, `layout.ts`, `NodeSheet.tsx`, `SignalRun.tsx`), `src/projects/RunView.tsx`, `NodeDetail.tsx`, `ReviewDetail.tsx`, `node/ReviewSections.tsx`, `providerPanel.tsx`, `api.ts`, `docs/VIEWER_SIGNAL_BOX.md`; the harness `tests/project-workflows/` (`mock.ts`, `seed.ts`, `fixtures/index.ts`, `fixtures/ux-panel.ts` and `panel.spec.ts` as the closest precedent, `support.ts` `renderedText`).
- Real data to copy shapes from (read-only; never copy their paths, ids or texts into fixtures): the run directory `~/.local/state/md-manager-workflows/projects-dispatch/projects-dispatch-002/` (two lane-review rounds per lane, three repairs, two review rounds, critique, a late coverage reviewer), the night-shift folder `~/.local/state/md-manager-workflows/night-shift/` (records whose `jev` is `{}`, `false`, `null`, an error or missing; word confidences), and Jev's output shape in `~/.local/share/agent-memory/repo/learnings/skills/night-shift/scripts/night_shift_jev.py` (`pick`, `confidence`, `probabilities`, `floor`, `pass_floor`).
- **Seeds and mocks.** A fixture module `tests/project-workflows/fixtures/sessions.ts` with the payloads (worker phase) and a seed (candidate phase) that writes a run directory with two lanes, challenge, worker and repair files, a lane-review record per lane (one whose `repair` is set, one recorded with no fix round), a review with three reviewers (general blocked, coverage late blocked, critique approved) and an archived round, a 1.9.0+ export with a multi-provider panel, and a night-shift folder with one executed `challenge_paused` and one held `awaiting_approval` record for the run (plus one record of another run with the same id in another directory, which must not show); plus an older run with one reviewer and no lane-review records. Register it in `fixtures/index.ts`; add the sessions route to `mock.ts` as a small hook (as the controls slice added `installControlMocks`); set `MD_MANAGER_NIGHT_SHIFT_DIR` for the candidate server in `playwright.config.ts` under the test root; list the sessions project under `viewer.expose_run_dir` in the candidate registry and keep one project that does not expose it. The worker-phase mock serves the run detail with the projected nodes exactly as the server would project them for the same seed.
- **Existing specs that walk the stage** (`ux-run`, `ux-refine`, `revamp-pages`, `reviewers`, `review`, `ux-review`, `panel`, `critique`, `lanes` and others that count `data-node-id` cards or reviewer chips) will see the new reviewer nodes in both phases. Update each to the new count and the new cards, asserting at least what it asserted before ([O3]); never weaken an assertion, and never remove one without an equivalent. Keep these edits small: the in-flight projects-dispatch feature also edits `mock.ts`, `seed.ts` and `fixtures/index.ts`, and the two will be merged by hand.
- **A lane reviewer** (GPT 6.1) reviews your diff after your checks pass. A P0/P1 from it starts one repair round; repairs are scarce (three per run), so run both phases of your specs and check each item against its words before you complete.
- **The look:** tokens in `src/projects/theme.css`, `DESIGN.md` and `PRODUCT.md`, the Signal Box conventions in `docs/VIEWER_SIGNAL_BOX.md`. Load the `impeccable` skill for layout and copy.

## Constraints

- Owned paths only (policy.json `sessions`). Do not edit `workflow/`, `contracts/workflow/`, `server/app.ts`, `server/index.ts`, `src/projects/controls`, `src/projects/CommandBlock.tsx`, `src/projects/ProjectsView.tsx`, `src/projects/routes.ts` or `src/App.tsx`: the new views are node pages, sheets and run-page sections on the existing URLs.
- Read-only server: no write, no spawn, no network; GET and HEAD only. The export schema and the existing run-detail contract keep their shapes; projected nodes use existing entries.
- Never claim what the data does not hold: "not recorded" for a missing fact; never render a transcript, an absolute path or a credential.
- Wrap localStorage reads and writes in try/catch. No new dependency.
- The browser check runs the whole `tests/project-workflows` config. The verifier refuses Playwright retries; do not add them. If an unrelated test (for example `controls.spec.ts` `controls-unavailable`) fails under load, report it in the completion's `untested` with the log line, and do not edit it.

## Acceptance

- `server/sessions.test.ts` builds run directories under a temporary root (and a temporary night-shift folder through the env variable) and proves: each role's rows from its files; `null` facts for missing or malformed files; both totals; lane-review `fix_round` from the record's `repair` and each no-fix reason; night-shift matching (directory realpath; the no-directory case served only when the run id is unique in the registry; another run's record not served), `decided_at` from the key, word confidence, every `jev` form; the projected nodes and their dependencies (a collision refused; no reviewer node when the export lists no reviewers; no `panel` node when the panels route would answer `PANELS_NOT_FOUND`); triage never focusing a projected node; the resume command for an exposed and an unexposed project and a quote in the directory; no absolute path and no credential-shaped string in any string of the response.
- `contracts/projects/contract.test.ts` validates the sessions example against the schema.
- The browser scenarios in `policy.json` pass through `check-report` in both phases, run by you in your worktree: `sessions-stage`, `sessions-lane-review`, `sessions-reviewer`, `sessions-list`, `sessions-panel`, `sessions-phone`. Each appears in exactly one test title as `[scenario:<id>]` with one `screenshot:<id>` attachment; the descriptions are the assertions. The existing specs pass too.
- `tests/unit/sessions.test.ts` covers the card model for reviewer, panel and lane review nodes, the Sessions grouping and totals, the resume command text, and the night-shift block's wording (executed, held, Jev error, Jev not called).
- `frontend-build`, `frontend-lint`, `shared-contract` and `frontend-unit` pass; the handoff and `docs/VIEWER_SIGNAL_BOX.md` are updated.

Run targeted tests while iterating, then the non-browser policy checks once before writing the completion; run browser specs through check-report.

Browser checks: each scenario id appears in exactly one test title as `[scenario:<id>]`, and that test, when it passes, attaches exactly one image/png named `screenshot:<id>`. Before completing, run the spec files you changed in both phases with a JSON report:

```bash
WORKFLOW_VERIFICATION_PHASE=<worker|candidate> PLAYWRIGHT_JSON_OUTPUT_FILE=<tmp>/report.json \
  npx --no-install playwright test --config=tests/project-workflows/playwright.config.ts --reporter=json <spec files>
```

Then run the exact `check-report` command the controller appends to this task when it pins it.

## Stop

- Stop with a `question` completion when a fact the PRD asks for is in no file of the run directory or the night-shift folder, or a fix needs a file outside your owned paths (the export, the controller, `server/app.ts`, `src/projects/routes.ts`).
- Stop and report `blocked` when the `impeccable` skill is not available through the `Skill` tool.
- No actions on these pages (the run controls feature owns actions); no transcripts.
