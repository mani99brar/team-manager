# Task: viewer

## Goal

The Projects run page and runs list show a run accepted by the operator as "integrated (operator override)", visibly distinct from a reviewed integration, with the reason, who and when, the candidate and the findings open at acceptance (docs/PRD_ACCEPT_OVERRIDE.md).

## Context

The engine lane adds the record to the export under a new top-level key; until its handoff (`docs/handoff/accept-engine.md`) exists, build against the shape in the PRD's Record bullet: `{candidate, reason, by, accepted_at, open_findings: [{severity, reviewer, title}]}` and treat any other field as optional. Start from how `tryout` reaches the viewer: `server/projects.ts`, `contracts/projects/v1.ts`, `contracts/projects/triage.ts`, `src/projects/RunHeader.tsx`, `tests/project-workflows/ux-run.spec.ts`. An abandoned run currently reads `cancelled` (FINISHED_STATUSES in `contracts/projects/v1.ts`).

## Constraints

Only your owned paths. No new runtime dependency. A run without the record looks exactly as before.

## Acceptance

- The run page and runs list show the override outcome with its own chip, the reason, actor, time, short candidate sha and each open P0/P1/P2; an accepted run that was abandoned reads as the override, with the abandon reason kept as history.
- `server/projects.test.ts` and `tests/unit` cover the mapping (with and without the record); the browser scenarios `accepted-run-outcome` and `accepted-after-abandon` pass.
- `docs/handoff/accept-viewer.md` lists what you assumed of the export.

Run targeted tests while iterating, then this lane's non-browser policy checks once before writing the completion; run browser specs only through check-report on this lane's own specs.

Browser checks: each scenario id appears in exactly one test title as `[scenario:<id>]`, and that test, when it passes, attaches exactly one image/png named `screenshot:<id>` (other attachments are fine). The verifier refuses anything else. Before completing, run the spec files you changed with a JSON report:

```bash
WORKFLOW_VERIFICATION_PHASE=<worker|candidate> PLAYWRIGHT_JSON_OUTPUT_FILE=<tmp>/report.json \
  npx --no-install playwright test --config=tests/project-workflows/playwright.config.ts --reporter=json <spec files>
```

Then check the report with the verifier's own rules: run the exact `check-report` command the controller appends to this task when it pins it.

## Stop

Stop and report `blocked` if the export shape the engine handoff names cannot be shown without changing a contract file the engine lane owns.
