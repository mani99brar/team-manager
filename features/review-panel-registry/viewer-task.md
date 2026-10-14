# Viewer lane: seats, the judge's rulings and the judged review on the run page

## Goal

The run page shows a judged review panel (feature.json 2.11.0):
- each seat with its name, prefix, transport, model, CLI version, status and cost;
- the judge's rulings, grouped Confirmed, Deferred and Refuted, each with its sources as links to the seats and reviewers that raised them;
- a clear banner when the judge failed and today's rule decided;
- a review section in which the judge is the deciding reviewer.

Panel records 1.0.0 (report-only) render exactly as today. The engine lanes write the records. You read them live and from the export, validate them, and render them.

Spec: `features/review-panel-registry/prd.md` sections 7.4, 7.7 and 8, plus Appendix A. Binding decisions: `features/review-panel-registry/decisions.md` ([O7], [O9], [G9], [G10], [G21], [G22]).

## Context

- **Literal records:** `features/review-panel-registry/examples/`. These are `panel-judged.example.json` (record 1.1.0, judged, blocked by J1), `panel-fallback.example.json` (judge timed out, a seat `auth_required`, Argon `unavailable`), `review-judged.example.json` and `reviewers.example.json`. Load them as literals in your contract and unit tests, and seed the browser runs from them.
- **Panel contract today:** `contracts/projects/v1.ts:754-838` (`PANEL_TRANSPORTS` :767, provider :781, finding :794, entry :808, results `contract_version '1.9.0'` :834) and `validatePanelResults` :1198. The review validator is `validateReviewResult` :1067-1091 (strict `reviewFindingSchema` :204, `reviewerEntrySchema` :221). Generated JSON comes from `npm run contracts:export`.
- **Server:** `server/projects.ts:1317` (the panels route) and :2218 (`resolvePanelRecord`, live `<run>/panel.json` first, then the export's `panels` section). The review sections are `z.strictObject` (`server/projects.ts:188-238`). Sessions: `server/sessions.ts:160/258/823` (`panel` node, `panel_provider` rows).
- **UI:** `src/projects/providerPanel.tsx:63-66`, `src/projects/node/providerPanel.ts:100` (`providerName` = model ?? transport), `NodeDetail.tsx`, `RunView.tsx`, `ReviewDetail.tsx`.
- **Tests:** `contracts/projects/contract.test.ts` (panel :708-760), `tests/unit/panels.test.ts`, `tests/unit/providerPanel.test.ts`, and `tests/project-workflows/panel.spec.ts`. Fixtures are in `tests/project-workflows/seed.ts`, and the app is `tests/project-workflows/sessions-app.ts`.
- Browser tests run on ports 5184/3014 (the dashboard holds 5173/3001).

## Constraints

- **Owned paths only:** `server`, `contracts/projects`, `src/projects`, `tests/unit`, `tests/project-workflows`, `docs/handoff/review-panel-viewer.md`. Never edit `workflow/` or `contracts/workflow` (engine lanes).
- **Record versions:** accept panel records `1.0.0` and `1.1.0`. A 1.0.0 record renders byte for byte as today (a regression test pins it). A 1.1.0 record with a transport outside `claude|pi|cli` or an unknown provider status is rejected by the contract, and that rejection drops only that record.
- **Judged review rule** (PRD 7.4, [G26]):
  - `validateReviewResult` itself takes judged-plan context and applies the judged rule only when that context is given **and** the record's `reviewers` contains `judge`: the built-in entries' verdicts do not gate, and the verdict follows the judge entry (and critique). Server-only gating is not enough.
  - The server passes that context from the run's plan (`plan.json` read as today). So `examples/review-judged.example.json` passes on a judged plan, and the same record fails both with the `judge` entry removed and on a plan without a judged panel (legacy, report-only or missing plan).
  - A fallback record (no `judge` entry) keeps the built-in reviewers' decision authority, as today, and its built-in entries are never labelled advisory.
  - Every other record validates exactly as today.
- **No absolute path rendered.** Seat worktrees are not shown. Status words follow PRD 8, and a null cost reads `not reported`.
- **Accessibility and layout:** every new link and control is at least 44 px tall at 390 px wide. Source chips are links with text labels (`C1`, `general-1`), not colour alone.
- Use the `impeccable` skill for the panel and judge layout. Match the run page's existing components.

## Acceptance

Your checks (build, lint, `npm run test:contracts`, `npm run test:unit` and the Playwright suite) pass, with these named tests and scenarios:

1. **Contracts:**
   - The zod schemas accept every example in `features/review-panel-registry/examples/` that they cover.
   - They reject a 1.1.0 record with transport `foo`, a seat status outside PRD 8's list, and a judge ruling outside `confirmed|refuted|deferred`.
   - A 1.0.0 record still validates.
   - Direct `validateReviewResult` tests: the judged review example is accepted with judged-plan context and rejected with legacy, report-only or missing plan context. A fallback record validates as today.
2. **Server:**
   - The live read and the export fallback both return the judged record with its `judge` object. A 1.0.0 record is returned unchanged.
   - A judged-shape review.json on a run without a judged panel (legacy, report-only or missing plan) is rejected, with a unit test.
   - A fallback review.json keeps the built-ins deciding and is not labelled advisory, with a unit test.
3. **Unit:**
   - Status words for every seat status.
   - Ruling grouping and order (Confirmed P0/P1 first, then Deferred, then Refuted).
   - Source-chip targets (a seat prefix → that seat; `<reviewer_id>-<n>` → that reviewer).
   - The fallback banner text.
   - The review section's `advisory (the judge decided)` label.
4. **Browser scenarios** (seeded runs, listed in `policy.json`):
   - judged panel;
   - rulings with sources;
   - judge fallback;
   - unavailable and disabled seats;
   - review section and sessions rows;
   - a 1.0.0 run unchanged;
   - 390 px.
5. `docs/handoff/review-panel-viewer.md` lists what you built and anything left open.

## Stop

Stop when the acceptance holds and your checks pass, or when an example record cannot be rendered as PRD 8 says. In that case, write the reason in your handoff doc and end. Never edit outside your owned paths.

## Changes after launch

Changes after launch live in `decisions.md` as [L<n>] bullets, and those win over this file.
