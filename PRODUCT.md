# Product

<!-- impeccable:product-schema 1 -->

<!-- Written 2026-10-08 by the operator's Claude Code session from the repository and the grill of 2026-10-08 (features/viewer-refine/decisions.md). The operator was asked the three init questions on Telegram; until an answer lands, every line marked (inferred) is the session's reading of the repository, not a confirmed fact. -->

## Platform

web

## Users

- The operator: one person who runs AI coding workflows (the md-manager workflow controller, `workflow/`) against several repositories on two Linux VPS hosts, and reads the Projects viewer to steer them. Single user, no accounts, localhost only, reached through an SSH tunnel from a laptop and, (inferred) from a phone. No second audience: the viewer is never customer-facing.
- Situations (inferred): a run is live and the operator checks what it is doing between other work; a run stopped and waits on a decision (a question from a worker, a design-challenge pause, a review block, an approval); the morning after unattended runs, reviewing results across projects; and reviewing a candidate's evidence before merging.
- The same operator also uses the first part of the app, the Pi and Claude skill-directory explorer and Markdown editor, which this product record covers only as context: the Projects viewer is the surface being refined.

## Product Purpose

MD Manager is a local Vite/React viewer over two things: the Pi and Claude skill directories on the machine (browse, read, edit Markdown with explicit save, bounded file operations), and the runs of the workflow controller (the Projects viewer, read-only). The Projects viewer exists so the operator can tell, from the run's own records, what every run needs from them now, what a finished run produced and whether its evidence holds, and how a live run is moving, without opening the run directory or the terminal. Success is the operator finding the answer on the first screen and reaching the next command in one copy.

## Positioning

The viewer renders only what the workflow's own records contain (`run-state.json` exports, verification packets, review records, attention records) and never acts on a run: every command it shows is one the operator runs in their terminal. That is the mechanism a dashboard that polls agents or lets you click "retry" cannot truthfully claim: what the page says is what the controller recorded, with "not recorded" where it recorded nothing. The truthfulness rules of `docs/PRD_VIEWER_UX.md` (no inferred states, the source of each time, no next step the RUNBOOK does not back) are product law.

## Operating Context

- The workflow controller (Python, `workflow/`) runs features as runs: grill, design challenge, worker lanes in worktrees, freeze, verification, candidate, independent reviewers (plus optional sidecar, attack pass, multi-provider panel), approval, integration; since 2026-10-08 also an in-run fix loop (repair sessions, review rounds, delta review) and per-lane model pins. Runs live under `~/.local/state/md-manager-workflows/<feature>/<run>`; the viewer reads their exports through the Fastify API (`server/`), registered in `~/.config/md-manager/projects.json`.
- The operator's terminal is the acting surface: `python -m workflow <command> --by operator`. Attention records are also pushed to Telegram (`attention-notify`); the viewer and the Telegram relay show the same records.
- Dev servers run permanently under user systemd (web 5190, API 3090); Playwright specs under `tests/project-workflows/` run against a mock API with fixture modules; the viewer must stay testable that way.
- Documents the viewer renders: the lanes' task files, `decisions.md`, review findings, check logs, screenshots, captured files, the review diff. All text, often long.

## Capabilities and Constraints

- Read-only by design: no control on any page acts on a run; specs assert it (`expectNoExecutionControls`).
- Export contract versions are additive (1.0.0 to 1.9.0 today, 1.10.0 with viewer-refine); every older run must render unchanged. Missing evidence renders as "not recorded", never guessed.
- Terminology, fixed by the controller: run, feature, lane (a worker's scope, with owned paths), attempt, candidate, verify, review, reviewer, sidecar, attack pass, panel, challenge, repair, round, delta, attention (question, pane, approval, paused, failed, interrupted), handoff, integrate.
- Single column at 390 px with 16 px gutters and no horizontal page scroll; 44 px tap targets; tables scroll inside their container; light and dark themes (`prefers-color-scheme`) both required.
- Performance is bounded by fixture size, not traffic: one user, a few dozen runs, pages of a few hundred rows at most.
- Undecided (recorded, not invented): whether the viewer will ever act on runs (deferred in every PRD so far); whether a redesign of the look is wanted (the operator chose a refinement on 2026-10-08, a redesign stays possible as a separate decision).

## Brand Commitments

- Name: MD Manager. No logo, no marketing surface, no external audience.
- Voice: plain, factual, operator-to-operator; sentences, not labels with colons; commands shown verbatim with Copy; the RUNBOOK's words for things.
- Replaced on 2026-10-09: the operator's design 4, "Signal Box Live", is the binding look (`DESIGN.md`); the Calm look below is history.
- The "Calm" look chosen on 2026-10-02 over "Bold" (`docs/PRD_VIEWER_REVAMP.md`; Bold removed in ce23d44): neutral cool surfaces, one accent, colour only for state, a semantic state palette (ok, running, needs-you, failed, paused, idle, P0/P1/P2) used identically on chips, stripes, rail dots, graph nodes and finding stripes; the accent never carries state. Binding for refinements; `DESIGN.md` records it.

## Evidence on Hand

- Real runs: about 60 under `~/.local/state/md-manager-workflows/`, exported, with every state the viewer must show (paused challenges, blocked reviews, succeeded integrations, cancelled runs, attack passes, panels). No run with a repair session yet: the fix-loop fixture is PRD_VIEWER_REFINE Appendix A.
- Screenshots of the current viewer at 1440 and 390 in the operator's session scratchpad (2026-10-08); earlier audits in `docs/PRD_VIEWER_UX.md` and `docs/PRD_VIEWER_REVAMP.md` with measurements.
- Reviewer findings on the viewer: `viewer-revamp-008/review.json` (8 P2s), earlier runs' reviews.
- No testimonials, metrics, customers or benchmarks exist; none may be invented.

## Product Principles

1. Answer first: the first screen of any page states what the operator must know and do; everything else is below or folded.
2. Only recorded truth: nothing is shown that the run's records do not contain; absence is said in words.
3. Colour means state, and only state; structure comes from sections and weight, not from decoration.
4. One mechanism everywhere: the same state palette, glyphs and words on the home, the graph, the steps, the nodes and the findings.
5. Read-only, always: the viewer informs; the terminal acts.

## Accessibility & Inclusion

Keyboard operation of the run graph (every node focusable, Enter opens), status never carried by colour alone (a glyph repeats it), `prefers-reduced-motion` honoured, 44 px targets at phone width, both colour schemes. No further standard has been named.
