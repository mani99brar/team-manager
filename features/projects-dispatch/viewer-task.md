# Viewer worker, run 005: finish the viewer handoff (PRD_PROJECTS_DISPATCH)

## Goal

**Run 005 (follows projects-dispatch-004).** Run 004's candidate d688375 passed every check and its lane review (no findings); its independent review never ran: Claude subscription access failed for every session on 2026-10-11 18:44-18:52 UTC and the reviewer deadline ran out ([L16]). Your prompt first restores your owned paths at d688375, which is run 004's finished work for the items below. Check each acceptance line against the restored files and change only what fails it; an unchanged restore is the expected outcome. Say in the completion what you checked.

Run projects-dispatch-003's code passed every check, both lane reviews and the critique; its independent review blocked only on the handoffs (`features/projects-dispatch/review-003.md`). Your base is 003's candidate. Change `docs/handoff/projects-dispatch-viewer.md` (and `docs/VIEWER_DISPATCH.md` if it names deleted rules) only.

1. **V33 (P1, V32 of run 003) The handoff keeps every open P2.** List as open, each with its review-002.md or review-003.md source and one line on what is missing, every P2 of `features/projects-dispatch/review-002.md` and `review-003.md` that runs 003 and 004 did not fix. At least, from the reviewers of run 003: V2's loading and failed run-detail states; V3's CSS ellipsis and accessible-name gaps and the glyph tolerance; V6's unknown and uncompared landing wording and per-landing pairs; V7/[P30] definition folds; V10's shared non-GitHub clone and the 'as of' assertion; V11's no-count assertion; V12's Projects page cards; V13's Triage marker and gap; V15's unit test and fixed clock; V16's GitHub sha and pane landing pairs; V17's card counts and rail rows; V18's candidate-phase 440 px collapse; V19's full width and facts; V20's group order and failed-refresh line content; V21's renderedText wait; the pane clipped at 1280x720; the '1 name a run' agreement and Trio's count/list mismatch; the console 500/503 errors; and every open P2 of review-003.md on the viewer.
2. **V34** Correct the stale lines: the run-002 `dispatch.css` bullet still describes the deleted `@media (min-width:1600px)` rule (now the `dispatch-body` container query, V23). Every rule, test id and file the handoff names exists in your base.

## Context

- Read `docs/handoff/projects-dispatch-viewer.md`, `review-002.md`, `review-003.md` and `features/projects-dispatch/decisions.md` first. Check each P2 against the code before you list it as open: a P2 that run 003 fixed is listed under "fixed in run 003" instead, with the item that fixed it.
- A lane reviewer (GPT 6.1) reads your diff after your checks pass.

## Constraints

- Owned paths only (policy.json `viewer`); in practice the two docs above. No code or test change.
- The browser check runs the whole `tests/project-workflows` config; do not add retries. If `controls.spec.ts` `controls-unavailable` or `attack.spec.ts` `[scenario:attack-section]` (a `Protocol error … session closed` in run 003) fails under load, report it in `untested` with the log line, and do not edit it; the machine is shared with another run's worker phase. The browser check on this docs-only diff only re-confirms the unchanged code ([L15]).

## Acceptance

- Every open P2 of review-002.md and review-003.md on the viewer is in the handoff, as open or as fixed by a named item; no stale rule or test id remains.
- `frontend-build`, `frontend-lint`, `shared-contract`, `frontend-unit` and the browser check pass (the code is unchanged; run the browser specs through check-report once in the worker phase).

Run this lane's non-browser policy checks once before writing the completion; run browser specs only through check-report on this lane's own specs.

## Stop

Stop and report `question` when an item needs a code change.
