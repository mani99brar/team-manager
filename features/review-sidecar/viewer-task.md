# Viewer worker: the sidecar ledger served and shown (PRD_REVIEW_SIDECAR sections 4.7 to 4.9, 5 items 7 to 10)

## Goal

An operator who opens a run with a review sidecar sees the `Review sidecar` node in the graph and the Steps table, and on its page, in the first screen, how many passes ran, what is open by severity, which messages reached which lane and what the sidecar handed off at freeze, updating live while the workers run. The server serves the ledger from the live run file (falling back to export 1.6.0's `sidecar` section) on a new read-only route with a projects contract 1.6.0 schema, and a run without a sidecar, or an older export, is unchanged everywhere.

## Context

- `docs/PRD_REVIEW_SIDECAR.md` is the specification: 4.7 (export and live file), 4.8 (server, contract, triage), 4.9 (page), section 6's viewer and server scenarios; Appendix B is the ledger shape the `engine` lane writes. Build your fixtures from Appendix B verbatim. `decisions.md` in this feature records the operator's decisions.
- Analogs: the challenge node (`src/projects/Challenge.tsx`, `node/ChallengeSections.tsx`, `challengeHeadline` in `node/panels.ts`, its status branch in `server/projects.ts` `projectSnapshot`) is a non-lane node of `kind: review` read from a section; the live questions read (`server/projects.ts` `readQuestions`, `liveQuestions`) is the live-file pattern; `inputs` in `RunView.tsx` is the polled resource pattern; `ReviewDetail.tsx` and `node/review.css` are the findings table and card restyle at narrow widths.
- `NodeDetail.tsx` today treats every `kind: review` node that is not the challenge as the review (`isReview`, `reviewNode`): the sidecar must be classified by its id `sidecar` before that rule. `contracts/projects/triage.ts` `focusOf` would let a running sidecar steal the focus from `launch_*` nodes; `buildGaps` would hide gaps under its long span.
- The projects contract rules are in `contracts/projects/README.md`: `v1.ts` is the source, `npm run contracts:export` regenerates the JSON schemas, every schema needs an example of the same name, additions are versioned by the release that introduces them (this one is 1.6.0), a missing section is a 404 code mapped to "not recorded" by `src/projects/api.ts`.
- Fixtures: `tests/project-workflows/fixtures/index.ts` registers fixture modules (`payloads`, `seed`); `ux-review.ts` is a filled example; `mock.ts` routes the mocked API and needs the new route; `server/projects.test.ts` seeds every browser fixture (`eachSeededRun`) and pins `SEEDED_SNAPSHOTS` and `SEEDED_ACTIVITY` per seeded run. Browser helpers are in `tests/project-workflows/support.ts`.
- Handoffs of the viewer UX slices (`docs/handoff/ux-s4c.md`, `ux-s6.md`) show the conventions and the red/green evidence format.

## Constraints

- Only edit the paths your lane owns in the pinned policy: `server/`, `contracts/projects/`, `src/projects/`, `tests/unit/`, `tests/project-workflows/` and `docs/handoff/sidecar-viewer.md`. `workflow/` and `contracts/workflow/` belong to the `engine` lane: do not edit them or read its worktree; the Python exporter will write `version: "1.6.0"` and the `sidecar` section exactly as Appendix B, so accept `1.6.0` in `EXPORT_VERSIONS` and keep every 1.0.0 to 1.5.0 export loading unchanged.
- Add `sidecar` and the `sidecar-` prefix to `server/projects.ts`'s reserved lane ids.
- The viewer stays read-only: every button text is one of those PRD_VIEWER_UX 12.3 lists, no button holds a path or a command, `expectNoExecutionControls` stays green. One clock at `RunView` (no `useNow` in sections); pure helpers in `src/projects/node/sidecar.ts` import no React, their tests in `tests/unit/sidecar.test.ts` (collected by the `test:unit` glob).
- The ledger resource is polled like `inputs` (5 s, stops with the run) and never cached as immutable; `useRunReview` is not used for it. A run without a sidecar makes no sidecar request beyond the one that answers 404, shown as "not recorded".
- The graph legend keeps exactly three entries (`clarity.spec.ts`), the sidecar is an `agent` executor; `runActivity` (headline, focus, attention) for a seeded run with a sidecar equals the same run without it, asserted in `server/projects.test.ts`. Keep every existing scenario and test id green; new test ids are those PRD 4.9 names.
- If the PRD is ambiguous, choose, record the choice as an open assumption in your handoff, and keep going.

## Acceptance

- `contracts/projects/v1.ts` gains `sidecarLedgerSchema` and `validateSidecarLedger` at 1.6.0, with `examples.ts`, the regenerated `sidecarLedger.schema.json`, README route table and Versions entries, and `contract.test.ts` green.
- `server/projects.test.ts` covers: a 1.6.0 export with and without the section loads, a 1.5.0 export loads and `/sidecar` is `SIDECAR_NOT_FOUND`, the live file wins over the export and a malformed live file falls back, the snapshot status per ledger state (pending, running, succeeded at `closed_at`), an integrated run with a closed sidecar is `succeeded` never `paused`, the 405 on other methods, and the unchanged activity with and without the sidecar.
- Fixtures in `tests/project-workflows/fixtures/ux-sidecar.ts` for both phases: a running two-lane run with a running sidecar (open P1 and P2, a `fix_reported`, one `verified_resolved`, messages `delivered`, `undeliverable` with reason and `refused` with reason, passes `completed`, `failed` and `timed_out`, one escalation), the same run frozen with a `closed_at` and a handoff, and the matching run without a sidecar. One browser test per scenario id in `tests/project-workflows/sidecar.spec.ts`, each title containing `[scenario:<id>]` and attaching `screenshot:<id>`: `sidecar-node`, `sidecar-live`, `sidecar-run`, asserting what the pinned policy describes, in both phases.
- Unit tests for the pure helpers (headline wording, ordering P0/P1 first then id, grouping by disposition, the focus and gap rules in `triage.test.ts`, the step label in `steps.test.ts`).
- Red first: run the new tests against the pre-change code and record that they fail for the right reason; then green. Write `docs/handoff/sidecar-viewer.md` with what shipped, both runs and any deviation from the PRD.
- Run targeted tests only: `npm run build`, `npm run lint`, `npm run test:contracts`, `npx tsx --test server/projects.test.ts`, `npx tsx --test tests/unit/sidecar.test.ts tests/unit/triage.test.ts tests/unit/steps.test.ts`, and the browser spec files you added or changed with `WORKFLOW_VERIFICATION_PHASE=worker` and with `WORKFLOW_VERIFICATION_PHASE=candidate`. The verifier runs every policy check on your snapshot and on the combined candidate. Report exactly what you ran, with results.

## Stop

Finish within the worker deadline. If a check keeps failing after three honest attempts, write the completion with status `blocked`, the exact failing command and output, and what you tried. Do not weaken or delete a test to make it pass, and do not edit the other lane's paths to make yours pass.
