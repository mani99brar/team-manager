# Decisions: user-critique

From the grill session of 2026-10-09 with the operator.

## Operator decisions

- [O1] Shape, before the PRD (2026-10-09, four questions at once): the critique's findings feed the in-run fix loop (its P0/P1 send their lane a repair, like a reviewer's); it runs at the review stage on the frozen candidate in its own worktree and ports; it judges flows (each lane's Goal and `verify_yourself` walked as a user) and design (the Impeccable `critique` method); it is opt-in through a `critique` key at feature.json 2.9.0. Operator chose "Feeds the fix loop", "Review stage", "Flows + design", "Opt-in key"; their request: "Now lets build the new worker or reviewer class we have decided, it would test the product as a user", "the idea was something like a critique or somehting which would test the frontend as a user and find gaps".
- [O2] Q1 (limits): the drafts' exclusions changed. A feature with `attack` and `critique` also gets repair rounds for critique findings; the viewer shows each critique finding's screenshots and proofs (the viewer and the export are in scope). Claude only, and no md-manager `critique_app` script in this feature, stand as drafted. Operator: "It should get a repair as well," and "For the prev Q it should show screeenshots and proofs for its findings".
- [O3] Q2: the critique session gets `Bash` inside its disposable worktree, with the reviewer deny list, an empty MCP config, writes limited to its completion and `$RUN/critique/<round>/`, and the worktree reset every round. Operator: "FOr this one yes Give it access".
- [O4] Q3: two lanes. `engine` owns `workflow`, `contracts/workflow`, `contracts/projects` and `server`; `viewer` owns the run page's findings files and their specs; both build against the export shape pinned in PRD Appendix A. Operator: "yes".
- [O5] Q4: P1 only for a flow a lane's Goal or `verify_yourself` line promises that does not work, or a UI that misleads the user about what happened, each with steps to reproduce and a screenshot; design issues, heuristics and the Impeccable craft floor are P2 or P3. Operator: "yes".
- [O6] Q5: the app starts from a new policy key `critique_app` (policy 1.4.0, required with `critique`): `{"argv", "ready_path", "timeout_seconds"}`, run in the critique worktree with `CRITIQUE_WEB_PORT`/`CRITIQUE_API_PORT` set to free ports, process group stopped afterwards. Operator: "yes".

## Grill defaults

- [G1] The critique is a reviewer (id `critique`, brief `builtin:critique`) rather than a pass beside the review, so its findings use `review.json`, the archive, the delta base and the repair brief unchanged (PRD 4.1) [added, not asked].
- [G2] On a plan with `attack` and `critique`, the attack pass runs once on round 1's candidate, stays report-only, keeps its record (marked with the candidate it judged) and is not rerun in later rounds; a plan with `attack` and no `critique` keeps today's behaviour (PRD 4.6) [added, not asked].
- [G3] Evidence travels outside `review.json`'s closed key sets: `$RUN/critique/<round>/evidence.json`, screenshots registered as run artifacts of kind `screenshot`, export 1.11.0 adds `evidence` to critique findings (PRD Appendix A) [added, not asked].
- [G4] `critique` settings: `lanes` (which lanes' UI it walks and may name), `skills` default `["impeccable"]`, `timeout_minutes` 10..120 default 45; a timed-out or failed critique (app not starting included) is a failed reviewer, never a finding. Model and effort are the reviewer role's pins [added, not asked].
- [G5] The critique holds one browser-queue slot for its whole span and runs the app with the verifier's check environment [added, not asked].
- [G6] The feature file stays at 2.8.0 (the controller on main launches it); the `viewer` lane declares no skills. Before the first run of a feature that declares `critique`, the host needs `~/.claude/skills/impeccable` linked (`ln -sfn ~/.local/share/agent-memory/repo/learnings/skills/impeccable ~/.claude/skills/impeccable`) and its launcher made executable and run once: on this VM (2026-10-09) neither is done [added, not asked].
- [G7] The critique does not use P0 [added, not asked].

## Changes after launch

None yet.

## Deferred

- md-manager's own `critique_app` start script and the first 2.9.0 feature that declares `critique` (a follow-up after merge).
- A non-Claude critique provider.
- Rerunning the attack pass per fix round.
