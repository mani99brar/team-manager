# Viewer worker: the multi-provider panel in the Projects viewer (PRD_MULTI_PROVIDER_PANEL sections 4.5, 6 item 2, Appendix A)

## Goal

The run page shows a **Panel** section built from Appendix A's export `panels` section (which the `engine` lane adds to `workflow/export_state.py` at export 1.9.0), and a `challenge`-stage panel also shows on the challenge view. The section opens a report-only line (the panel never changes the run's verdict); per panel a headline with the stage, the finding and accepted counts and the overlap threshold; the accepted findings each with severity, `file:line`, title, detail and the providers that raised it (an overlap badge when more than one); the not-accepted and unanchored findings folded below; and each provider with its transport, model, status and cost — the dollar estimate for a metered provider, and the literal **`subscription-covered`** (no dollar amount) for an `openai-codex` provider row (matching the pinned `panel-section` scenario in `policy.json`; the record in `panel.json`/the export keeps the reported estimate either way). A run with `panels` null has no section, the Panel section opens from the run page (there is **no graph node** this slice, so the panel's events render as run-level rows and never become the run's focus/headline — no `triage.ts` change), and every older export renders exactly as today. A *live* `challenge`-stage panel is produced by the engine only in the follow-up slice; this slice's challenge-view test seeds the record.

## Context

- `docs/PRD_MULTI_PROVIDER_PANEL.md` **Appendix A** pins the record, the export section, the events, the live-vs-export rule and the two verbatim JSON records; build every fixture from those records, and consume the export `panels` section and the `panel.json` shape the `engine` lane writes — do not invent fields, and do not edit `workflow/` (the `engine` lane owns the export section and the 1.9.0 bump). There is **no graph node** this slice.
- Analogs to reuse, not copy: the attack pass's viewer section (the run page's "Attack pass" section, its pending/failed/null states, the **live-wins-when-valid** source rule at `server/projects.ts`) is the closest precedent — mirror its structure for the Panel section, but the Panel section opens from the run page (not a graph-node click); `server/projects.*` and `contracts/projects` (the projects contract, the run endpoint); `src/projects` (the run page and the challenge view); `tests/project-workflows` (the Playwright config, candidate-mode-uses-the-real-API, `page.clock`) and `tests/unit`.
- **Live vs export (Appendix A, pinned):** serve the live `panel.json` whenever it is readable and valid, else the export's `panels` — the attack/sidecar precedent, **no mtime comparison**.
- A collision to avoid: `src/projects/panels.tsx` and `tests/unit/panels.test.ts` already exist. Name the new component `src/projects/providerPanel.tsx` and its test `tests/unit/providerPanel.test.ts`.

## Design (settled)

- `server/projects.ts`: **accept export version 1.9.0** on the run endpoint (older versions still accepted); `panelResults` is the verbatim `panel.json` object (`{version, panels:[...]}`), parsed the same whether it comes from the export's `panels` section or the live `panel.json`; overlay the live file when readable and valid (attack precedent, **no mtime**). No reserved-id or graph-node change this slice (no panel node).
- `contracts/projects`: add `panelResults` (the typed shape of the section the viewer reads from the export `panels` section; it accepts both verbatim records of Appendix A).
- `src/projects/providerPanel.tsx`: the run page's Panel section (per panel: report-only line, headline counts, accepted findings with overlap badges, folded not-accepted/unanchored, per-provider transport/model/status/cost — the dollar estimate for a metered provider and `subscription-covered` for an `openai-codex` row); the same section on the challenge view for a `challenge`-stage panel; opened from the run page (no graph node). No horizontal overflow at 390 px.
- Do **not** edit `workflow/`, `workflow/export_state.py`/`workflow/test_export.py` or `contracts/projects/triage.ts` — the export section, the 1.9.0 bump and the `legacy_run` regression are the `engine` lane's, and `triage.ts` is untouched this slice (it arrives with the graph node in the follow-up slice). The viewer consumes the export shape through Appendix A.

## Constraints

- Owned paths only: `server`, `contracts/projects`, `src/projects`, `tests/unit`, `tests/project-workflows`, `docs/handoff/panel-viewer.md`. Do not touch `workflow` or `contracts/workflow` (the `engine` lane owns the record, the schema and the export section); consume them through Appendix A only.
- No "Traceback"/"Error" literal added to the viewer's controller-row monitor patterns (review-sidecar lesson).
- A run with `panels` null and every older export are visually and structurally unchanged.

## Acceptance

The browser scenarios in `policy.json` pass:
1. `panel-section`: a run whose export carries the Appendix A panels record shows the Panel section as described in the Goal (report-only line; per-panel headline; accepted findings with severity, `file:line`, title, detail, raising providers and an overlap badge; folded not-accepted/unanchored; per-provider transport/model/status/cost — dollar estimate for a metered provider, `subscription-covered` for an `openai-codex` row); a pending run says the panel runs at its stage; a failed or timed-out panel shows its error; a provider that timed out or failed shows that state; a run with `panels` null has no section; the Panel section opens from the run page (no graph node); at 390 px no horizontal overflow.
2. `panel-challenge-and-live`: a `challenge`-stage panel renders on the challenge view as well as the run page; candidate phase against the real API shows the live record when `panel.json` is readable and valid and the export's otherwise (no mtime); the worker-phase mocked record moving running → succeeded shows the new accepted counts within one poll without a reload (`page.clock`).

Plus `server/projects.test.ts` for `panelResults`, the 1.9.0 acceptance and that both Appendix A verbatim records parse, `tests/unit/providerPanel.test.ts`, and `frontend-build`/`frontend-lint`/`test:contracts`/`test:unit` green. Write `docs/handoff/panel-viewer.md`: the section's states, the live-vs-export rule (and a note that the pinned `panel-challenge-and-live` scenario's word "newer" is incidental — the implemented rule is live-wins-when-valid, no mtime), the openai-codex `subscription-covered` display vs the record's estimate, and every open P2 with one line each.

## Stop

Do not add controls that act on the panel (re-run, accept, label) — v1 is read-only display; do not render anything the `engine` lane does not put in the export `panels` section; do not edit `workflow/`; do not change the attack-pass or sidecar sections. Report any such ideas as leads in the handoff.
