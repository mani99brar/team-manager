# Engine worker: the critique reviewer (PRD_USER_CRITIQUE)

## Goal

A feature.json 2.9.0 feature may declare `critique` (`lanes`, `skills`, `timeout_minutes`) with a policy 1.4.0 `critique_app`. Its automatic run's review step then has one more reviewer, `critique`: the controller gives it a disposable worktree of the frozen candidate with the policy `setup` run, starts the app there on free ports under a browser-queue slot, and launches a Claude session with `Bash`, the pinned skills and the `builtin:critique` brief. The session uses the app as a user and writes an ordinary reviewer completion whose open P0/P1 findings block the review and feed the fix loop exactly as another reviewer's do, on attack runs too (PRD 4.6). The export (1.11.0) carries each critique finding's steps and screenshots (PRD Appendix A), which the `viewer` lane renders. Every feature before 2.9.0, and a 2.9.0 one without `critique`, launches byte for byte as today. `docs/PRD_USER_CRITIQUE.md` sections 3 to 6 are the specification; `features/user-critique/decisions.md` records the operator's decisions.

## Context

- Why a reviewer (PRD 4.1): the fix loop reads only `review.json` (`workflow/automatic.py` `open_blockers` around line 1979, `fix_decision`, `fix_round`, `start_review_round`, `archive_review`; `workflow/pipeline.py` `check_review` and its closed key sets). The attack pass and panel are collected after the verdict in `review_candidate`'s `finally` chain and are the model for a child with a worktree, a bound and a resume, not for the decision.
- Reviewer launch: `workflow/interactive.py` `run_reviewer` (read-only tools today). Skills: `workflow/skills.py` helpers (keyed by a string; `critique` gives `<run>/skills/critique`), pinning in `workflow/pipeline.py` around 1598-1635, flags in `InteractiveSessions.worker_launch_flags`, settings in `workflow/sessions.py` `worker_settings`.
- Worktrees: the attack pass pins `<runs root>/<run>.attack/{worktree,rerun}` at prepare (pipeline.py around 1670) and `AttackChild.ensure_worktrees` (attack.py around 696) adds and sets them up; `clean.run_worktrees` removes them. Browser slot: `workflow/browser_queue.py` `browser_slot`. Check environment: `workflow/checks.py` `check_environment`.
- Version gates are exact-match sets spread over `workflow/` and `contracts/workflow/` (shared learning `version-gates-are-sets-add-a-keeps-everything-test.md`): 2.9.0 joins every set that lists 2.8.0 (guardrails `GUARDED_VERSIONS`, launch's version sets, attack/panel/sidecar version sets, the feature schema, the contract test's version list, a 2.9.0 example).
- Tests isolate every path under a temporary directory and `HOME`, use a fake `claude` and a fake app (a tiny HTTP server script), and never touch the real `~/.claude`, `~/.config/md-manager/` or systemd.

## Constraints

- Owned paths only: `workflow`, `contracts/workflow`, `contracts/projects`, `server`, `docs/handoff/user-critique-engine.md`. Do not touch `src` or `tests/project-workflows` (the `viewer` lane's). The `viewer` lane builds against PRD Appendix A in parallel: export exactly that shape, add a critique finding with evidence to the run-detail contract examples (`contracts/projects/examples.ts`) early, and do not change the shape after; a needed change is a `question` completion.
- The other reviewers, the challenge, sidecar, attack and panel keep today's launch bytes. The critique's deny list is the reviewer deny list plus denies on its pinned plugin; its `Write` is limited to its completion file and `$RUN/critique/<round>/`.
- An app that fails to start or answer is a failed critique reviewer recorded with the reason, never a finding.
- `builtin:critique` holds the P1 rubric of PRD 4.4 (decisions.md [O4]) verbatim in substance: P1 only for a promised flow that does not work or a UI that misleads the user, with steps and a screenshot; design, heuristics and the craft floor P2/P3.
- A plan with `attack` and no `critique` keeps today's fix-loop behaviour exactly.

## Acceptance

PRD_USER_CRITIQUE section 6, each with a test the verifier runs through `workflow-unit`:
1. A 2.8.0 feature with `critique` is refused, as is `critique` without a policy `critique_app`, a `lanes` entry that is not a lane, and the reserved id `critique` used by another reviewer; a 2.9.0 feature without `critique` launches byte for byte as a 2.8.0 one (assert the full argv and plan).
2. A critique run creates and sets up the worktree, starts the fake app on free ports, waits for ready, launches the critique session with the pinned argv (asserted in full), and stops the app's process group and releases the browser slot after a completion, a timeout and a Ctrl-C.
3. A critique completion with an open P1 naming lane `pages` blocks the review and starts a repair of `pages`; the next round archives `$RUN/critique/<round>/`, resets the worktree and relaunches the critique against the repaired candidate with the delta.
4. A plan with `attack` and `critique` repairs a lane on a critique P1; round 1's `attack.json` stays, records the candidate it judged and is not rerun; a plan with `attack` only still skips the loop.
5. The export 1.11.0 carries `evidence` on critique findings (review section and archived rounds), the screenshots are registered artifacts the server route serves (`server-projects` test), and `contracts/projects` validates the shape with an example.
6. `builtin:critique` exists under `workflow/prompts/reviewers/critique.md` with the PRD 4.4 brief; `launch --dry-run` prints the critique settings.
7. `test:contracts` validates the 2.9.0 example; the full workflow suite is green.
8. RUNBOOK section "Critique reviewer (feature.json 2.9.0)" and README rows; `docs/handoff/user-critique-engine.md` with what changed and every open P2.

Run targeted tests while iterating, then this lane's non-browser policy checks once before writing the completion; run browser specs only through check-report on this lane's own specs.

## Stop

Stop and report `blocked` when the critique cannot enter the fix loop without changing how the other reviewers' findings are decided, when giving the critique session `Bash` would need the deny list to lose an entry, or when adding 2.9.0 would change the launch of any existing feature. Do not widen scope to the viewer (`src`), a non-Claude provider, or rerunning the attack pass per round.
