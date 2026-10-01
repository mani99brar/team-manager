# Decisions: viewer-revamp

From the operator's answers of 2026-10-01 (scope, jobs, look, delivery) and the PRD defaults; the operator is away and reviews the result on this branch in the morning.

## Decisions

- Scope is the Projects viewer only: `src/projects/**`, the Projects header in `src/App.tsx` and `src/App.css`, the viewer tests. No server, contract or controller change; the lists keep reading the served `activity`.
- The jobs, in the operator's order: see what needs me now; review a run's result; manage many runs and features; watch a live run; an overall better, more structured layout. Runs home leads with Needs you, then Running, then a searchable, filterable Recent grouped by day.
- Two looks ship behind one remembered switch (`data-look`, `localStorage` key `mdm-look`, default `calm`): Calm (neutral cool surfaces, one accent, colour for state only) and Bold (warm paper, navy section bands, coral accent, tinted cards, display face). The operator picks one after review; the other is removed in a follow-up. Both have a dark theme.
- The scaffold commit (`src/projects/theme.css`, `tone.ts`, `ui/index.tsx`, the `theme.css` import in `ProjectsView.tsx`, and the two empty fixture modules registered in `fixtures/index.ts`) is the seam: the `shell` lane owns the three modules and may add to them, the `pages` lane imports them by name and never edits them. Neither lane edits `fixtures/index.ts` or `mock.ts`.
- Colour means state through one mapping (`tone.ts`): status, attention and severity map to the same tones everywhere; the accent is never a tone; nothing shows state by colour alone.
- Every test id, route, honesty line, inferred-time marker and read-only rule of PRD_VIEWER_UX stays; only the assertions PRD_VIEWER_REVAMP section 8 names are migrated, each listed in the lane's handoff.
- This run uses the review sidecar (`builtin:senior-review`, cadence 900 s, 12 passes, 4 messages per lane) as its first live use: it never blocks the run; its ledger is for the operator; workers treat its messages as advice.
- The coverage reviewer follows the controller's verdict rule: an untested Acceptance scenario, check or PRD safety rule (read-only viewer, every existing test id and route, both phases green, one clock, no colour-only state) is P0/P1 and blocks; every other gap is a P2 finding and the reviewer approves with it listed.

## Assumptions

- Running cards show a deadline-based progress bar only when the served activity carries the deadline; otherwise elapsed time only.
- Project prefix grouping folds families of three or more siblings sharing the prefix before the last `-` segment.
- Fonts load from Google Fonts with system fallbacks; offline tests must look right without them.
- Workers run targeted tests only; the verifier runs every policy check per phase.

## Deferred

- Removing the look the operator does not keep.
- Any server-side list endpoint or new contract field (PRD_VIEWER_UX B4, B5).
- The document and skills areas of the app.
