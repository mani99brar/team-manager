# Task: viewer

## Goal

The Projects run page and runs list show a run accepted by the operator as "integrated (operator override)", visibly distinct from a reviewed integration, with the reason, who and when, the candidate and the findings open at acceptance (docs/PRD_ACCEPT_OVERRIDE.md).

## Context

Follow-up run accept-override-003 ([L15]). Run accept-override-002 passed review (candidate 6ac7f5c, approved with P2s) but its viewer half no longer merges: main moved under it (the Signal Box run page, the Runs home rework, the user-critique merge at 7d270a4). This run starts from main 7d270a4. The controller restores your owned paths from 47409f3, whose viewer-owned paths are exactly main's, so you start from main's viewer with none of 002's viewer code; you re-do it against the current pages.

**The reference** is `features/accept-override/viewer-reference-002.diff`: 002's whole reviewed viewer change (`git diff 8289856 6ac7f5c` over your owned paths, the generated `contracts/projects/*.schema.json` left out; regenerate those with `npm run contracts:export`). It was written against the old run page, so apply its behavior, not its hunks: the same record parse, mapping, tone, chip, triage and tests, placed where main now has them. Where main moved the code:

- The run header is the Signal Box one (`src/projects/RunHeader.tsx`, `RunView.tsx`, `run.css`, `theme.css`); the runs list rows live in `RunRow.tsx` and `lists.ts`, and the Runs home is `RunsHome.tsx` (with `lists.css`). The override chip, reason, actor, time, short sha and open findings go on those surfaces as they are now laid out, in the Signal Box design language; do not restore the old layout.
- `contracts/projects/v1.ts`, `triage.ts` and `server/projects.ts` gained the critique evidence (export 1.11.0), the fix loop (1.10.0) and the attack/panel records. Add `accepted` beside them; EXPORT_VERSIONS gains exactly "1.12.0" ([L15] amends [L1]).
- `tests/project-workflows/fixtures/index.ts` and `seed.ts` changed; add the accepted fixtures (`ux-accepted.ts`, seeded at 1.12.0) and register them as main's fixtures are. Existing specs and fixtures of main must still pass untouched.

002's reviewed behavior to carry over is [L1]-[L14] as the Acceptance below states it, plus the two viewer fold-ins [L14] named: the runs list shows `accepted.by` and the open findings (reuse `acceptedFindingsText`), and `projectTone` keeps live-run tones above the override. Fold in two of 002's open viewer P2s, which sit in your paths: `accepted_at` is parsed as a UTC ISO date-time and a test shows a non-ISO value rejected; and the runs-list assertion in `accepted.spec.ts` covers actor and findings (the task text and the browser scenario below say the list shows them).

The engine lane adds the record to the export under the top-level key `accepted`; build against the exact key set in decisions.md [L8]; its handoff (`docs/handoff/accept-engine.md`) only confirms it. An abandoned run currently reads `cancelled` (FINISHED_STATUSES in `contracts/projects/v1.ts`).

Version: the engine raises the export version to exactly "1.12.0": add it to EXPORT_VERSIONS in `server/projects.ts` (an export outside that list is rejected as an invalid run), seed every accepted fixture at 1.12.0, and have `server/projects.test.ts` load a 1.12.0 export with `accepted` present, null and absent ([L1], [L15]). Each open finding is `{severity, reviewer, title, lane}` ([L5]).

## Constraints

Only your owned paths. No new runtime dependency. A run without the record looks exactly as before.

## Acceptance

- An accepted run is `succeeded` with a viewer-owned `accepted` field on RunSummary and RunDetail ([L12]); chip, triage glyph and headline, projectTone, filterRecent and isFinished check `accepted` first; [L13] (a) and (d) are yours.
- The export's `accepted` object is parsed with exactly the key set of [L8] (z.strictObject, `via` optional), not the PRD bullet; fixtures use that exact shape.
- The run page and runs list show the override outcome with its own chip, the reason, actor, time, short candidate sha and each open P0/P1/P2; an accepted run that was abandoned reads as the override, with the abandon reason kept as history.
- `server/projects.test.ts` and `tests/unit` cover the mapping (with and without the record); the browser scenarios `accepted-run-outcome` and `accepted-after-abandon` pass.
- A run with `accepted` counts as finished in the project snapshot, triage and `src/projects/lists.ts`: an accepted run that was never abandoned is neither in Needs you nor running, shown by a unit test ([L7]).
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
