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

- After design challenge attempt 1 of viewer-revamp-001 (P1: a fixture module cannot add projects): the `revamp-home` spec adds `project-B-1..3` through a `page.route` override of `/api/projects` inside `revamp-lists.spec.ts` in both phases; every revamp run lives under `alpha-project` with finished runs dated before 2026-03-13 and the spec's clock just after them; tests assert on own run ids only and "Show older" as every own run visible. Running cards name lanes from the definition with no state claim, show elapsed time only and a controller chip only from debounced readings (alive asserted in the worker phase only). Needs you keeps `waitingKind` and `data-attention`; the rail's Needs-you entry sits outside `projects-list`; the live rail is on Runs home only. The tokens are scoped to `.projects-shell` and the look switch sets `data-look` there, so the document and skills areas are untouched; the scaffold's state colours were darkened and severity chips take `--sev-fg` so every chip reads at ≥ 4.5:1 in both looks and both themes, asserted light and dark; `FilterToggles` (several pressed at once) joins the primitives for the findings filter.

- After design challenge attempt 1 of viewer-revamp-002 (P0: the findings redesign breaks four spec files neither lane owned): each lane now owns the spec files its pages are asserted by (`shell`: `ux-lists`, `projects`, `ux-time`; `pages`: `review`, `reviewers`, `lanes`, `clarity`, `inputs`, `guardrails`, `ux-run`, `ux-node`, `ux-verify`, `ux-launch`, `ux-review`, `sidecar`) and migrates assertions to the same facts in the new DOM, each listed in the handoff; findings stay cards with one `FilterToggles` row. Needs-you cards on Runs home show a next-step label and "open run ›", never a command (the command needs the run detail and stays on the run page); their DOM is an `li` with the tone classes and the link as its direct child. The spec's route override also answers `/api/projects/project-B-*/workflows` with an empty list. The look is React state in `App.tsx` passed to `ProjectsView` as a prop, which sets `data-look` on its `main.projects-shell`. Activity groups are all open by default with node-less rows placed by sequence. Fonts are system stacks only, no web font request. Filter buttons may end with a count; the allow-list is PRD section 8's. The pages fixtures follow the same dating rule as the shell's.

- After design challenge attempt 1 of viewer-revamp-003: specs are assigned by the DOM they test (`ux-time.spec.ts` moves to `pages`), each lane keeps the DOM that specs it does not own assert (PRD section 6's list: `.status-badge` on headers and rows, the time-zone toggle beside `run-status`, check cells, `time` attributes, `run-list` as `li` rows, "N nodes", "N features") and runs the other lane's specs read-only before completing; `StatusBadge` is restyled only through `.status-badge` CSS the shell owns and is part of the contrast measurement; the `revamp-home` scenario text says "next-step label" and asserts the Failed filter and Show older on at least one own failed row.

- After design challenge attempt 1 of viewer-revamp-004: the header's first button stays Refresh (the look switch follows it in the DOM); a run row's `<time>` keeps its exact text and the `live-status` chip its exact texts; the shell also runs `ux-time`, `ux-run` and `ux-launch` read-only; the worker-phase route override builds on `mockResponse(url)` and uses `route.fetch()` only in the candidate phase; no `<form>` anywhere and no fixture lane or reviewer id containing a forbidden button word; `revamp-look` measures the token pairs on the shell element in both looks and both themes, not only rendered chips; the PRD's stale sentences (tokens on `:root`, Google Fonts, closed Activity groups, `ux-time` under `shell`) are corrected to match these decisions.

## Assumptions

- Running cards show a deadline-based progress bar only when the served activity carries the deadline; otherwise elapsed time only.
- Project prefix grouping folds families of three or more siblings sharing the prefix before the last `-` segment.
- Fonts are system stacks only in this run; a web font is a follow-up decision for the operator.
- Workers run targeted tests only; the verifier runs every policy check per phase.

## Deferred

- Removing the look the operator does not keep.
- Any server-side list endpoint or new contract field (PRD_VIEWER_UX B4, B5).
- The document and skills areas of the app.
