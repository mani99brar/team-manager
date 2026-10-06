# Viewer worker: the multi-provider panel in the Projects viewer (PRD_MULTI_PROVIDER_PANEL sections 4.5, 6 item 2, Appendix A)

## Goal

Export bumps to 1.9.0 and carries a top-level `panels` section (null for runs without one); the projects contract gains `panelResults`; the run page shows a **Panel** section built from Appendix A, and a `challenge`-stage panel also shows on the challenge view. The section opens a report-only line (the panel never changes the run's verdict); per panel a headline with the stage, the finding and accepted counts and the overlap threshold; the accepted findings each with severity, `file:line`, title, detail and the providers that raised it (an overlap badge when more than one); the not-accepted and unanchored findings folded below; and each provider with its transport, model, status and cost (`openai-codex` shown subscription-covered, not a dollar amount). A run with `panels` null has no section, the graph's `panel` node opens the section, and every older export renders exactly as today.

## Context

- `docs/PRD_MULTI_PROVIDER_PANEL.md` **Appendix A** pins the record, the export section, the events and the node; build every fixture from it, and consume the `panel.json` shape the `engine` lane writes — do not invent fields.
- Analogs to reuse, not copy: the attack pass's viewer section (the run page's "Attack pass" section, its pending/failed/null states, the live-vs-export source rule, the graph node that opens the section) is the closest precedent — mirror its structure for the Panel section; `workflow/export_state.py` (the export sections, `challenge_section`, the version bump pattern to 1.8.0 → do 1.9.0); `server/projects.*` and `contracts/projects` (the projects contract and the run endpoint); `src/projects` (the run page and the challenge view); `tests/project-workflows` (the Playwright config, candidate-mode-uses-the-real-API, `page.clock`) and `tests/unit`.
- The live-vs-export rule: when a run's live `panel.json` is newer than its export, the run page shows the live record (source live); otherwise the export's.

## Design (settled)

- `workflow/export_state.py`: add the `panels` section at export 1.9.0 (null when the run has no panel), from `panel.json`; a `challenge`-stage panel's record is reachable from the challenge view too. Keep everything else 1.8.0-unchanged; `legacy_run` still renders.
- `contracts/projects`: add `panelResults` (the typed shape of the section the viewer reads).
- `src/projects`: the run page's Panel section (per panel: report-only line, headline counts, accepted findings with overlap badges, folded rest, per-provider status + cost with the subscription-covered label for `openai-codex`); the same section on the challenge view for a `challenge`-stage panel; the graph `panel` node opens the section. No horizontal overflow at 390 px.
- `server/projects`: serve `panelResults` on the run endpoint; the live `panel.json` overrides the export when newer.

## Constraints

- Owned paths only: `server`, `contracts/projects`, `src/projects`, `tests/unit`, `tests/project-workflows`, `docs/handoff/panel-viewer.md`. Do not touch `workflow` or `contracts/workflow` (the `engine` lane owns the record and schema); consume them through Appendix A only.
- No "Traceback"/"Error" literal added to the viewer's controller-row monitor patterns (review-sidecar lesson).
- A run with `panels` null and every older export are visually and structurally unchanged.

## Acceptance

The browser scenarios in `policy.json` pass:
1. `panel-section`: a run whose export carries the Appendix A panels record shows the Panel section as described in the Goal (report-only line; per-panel headline; accepted findings with severity, `file:line`, title, detail, raising providers and an overlap badge; folded not-accepted/unanchored; per-provider transport/model/status/cost with `openai-codex` subscription-covered); a pending run says the panel runs at its stage; a failed or timed-out panel shows its error; a provider that timed out or failed shows that state; a run with `panels` null has no section; the graph's `panel` node opens the section; at 390 px no horizontal overflow.
2. `panel-challenge-and-live`: a `challenge`-stage panel renders on the challenge view as well as the run page; candidate phase against the real API shows the live record when `panel.json` is newer than the export and the export's otherwise; the worker-phase mocked record moving running → succeeded shows the new accepted counts within one poll without a reload (`page.clock`).

Plus `server/projects.test.ts` for `panelResults`, a `tests/unit` export regression that `legacy_run` and a panel-null run are unchanged, and `frontend-build`/`frontend-lint`/`test:contracts`/`test:unit` green. Write `docs/handoff/panel-viewer.md`: the section's states, the live-vs-export rule, and every open P2 with one line each.

## Stop

Do not add controls that act on the panel (re-run, accept, label) — v1 is read-only display; do not render anything the `engine` lane does not put in `panel.json`; do not change the attack-pass or sidecar sections. Report any such ideas as leads in the handoff.
