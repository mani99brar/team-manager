# Viewer worker: critique evidence on the run page (PRD_USER_CRITIQUE)

## Goal

On the run page, each finding of the critique reviewer shows its proof: its lane, its numbered steps to reproduce and its screenshots (thumbnails with captions that open the full-size dialog), in the current review and in every archived review round. A P1 critique finding without a screenshot says "no screenshot"; other reviewers' findings look exactly as today. `docs/PRD_USER_CRITIQUE.md` section 4.5 and Appendix A are the specification; `features/user-critique/decisions.md` records the operator's decisions.

## Context

- The data: the export 1.11.0 adds `evidence: {steps, screenshots: [{artifact_id, caption}]}` to critique findings (PRD Appendix A). The `engine` lane owns `contracts/projects` and adds a critique finding with evidence to the contract examples (`contracts/projects/examples.ts`); build your fixtures from those examples, and until they land, from Appendix A exactly. `ReviewFinding` comes from `contracts/projects/v1.ts` through `src/projects/api.ts`; a finding without `evidence` (older exports, other reviewers) has none.
- The screens: `src/projects/ReviewDetail.tsx` and `src/projects/findings.ts` render findings; `src/projects/Screenshots.tsx` has the thumbnail and the native-dialog viewer the check rows use, and the artifact URL helper in `paths` (`src/projects/api.ts`). Reuse them; do not add a second dialog.
- The look: Calm tokens in `src/projects/theme.css` and the existing findings styles; `PRODUCT.md` and `DESIGN.md` at the repository root. Read-only viewer: nothing here acts on a run.

## Constraints

- Owned paths only (policy.json `viewer`). Do not edit `src/projects/api.ts`, `contracts/projects`, `server` or `workflow` (the `engine` lane's); a type or route you need that is missing is a `question` completion.
- No new dependency.

## Acceptance

- The `critique-evidence` browser scenario passes through `check-report`, with its screenshot.
- Unit tests in `tests/unit/critique.test.ts` cover the evidence model: steps order, screenshots mapped to artifact URLs, a P1 with no screenshot, a finding without `evidence`, an archived round's finding.
- `frontend-build`, `frontend-lint`, `shared-contract` and `frontend-unit` pass; `docs/handoff/user-critique-viewer.md` says what changed and every open P2.

Run targeted tests while iterating, then this lane's non-browser policy checks once before writing the completion; run browser specs only through check-report on this lane's own specs.

Browser checks: each scenario id appears in exactly one test title as `[scenario:<id>]`, and that test, when it passes, attaches exactly one image/png named `screenshot:<id>` (other attachments are fine). The verifier refuses anything else. Before completing, run the spec files you changed with a JSON report:

```bash
WORKFLOW_VERIFICATION_PHASE=<worker|candidate> PLAYWRIGHT_JSON_OUTPUT_FILE=<tmp>/report.json \
  npx --no-install playwright test --config=tests/project-workflows/playwright.config.ts --reporter=json tests/project-workflows/critique.spec.ts
```

Then check the report with the verifier's own rules: run the exact `check-report` command the controller appends to this task when it pins it.

## Stop

Stop and report `blocked` or `question` when the evidence cannot be shown without editing a file another lane owns, or when the contract examples' shape differs from PRD Appendix A. Do not redesign the review section beyond adding the evidence block.
