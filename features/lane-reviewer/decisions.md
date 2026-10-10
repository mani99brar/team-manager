# Decisions: lane-reviewer

From the grill session of 2026-10-10 with the operator.

## Operator decisions

- [O1] Q1: Scope limits confirmed: the controller (engine) only; reviewers run by the controller (no worker spawning its own agents, no separate verifier); the run's panel stays report-only and unchanged; no viewer or export change. Operator: "Correct (Recommended)". The "one reviewer per lane" part of this answer is changed by [O3].
- [O2] Q2: A fresh repair session of the lane fixes the lane reviewers' P0/P1 findings, through the existing fix loop (repairs.json, timeout, re-verify), not the original worker session. Operator: "Repair session (Recommended)".
- [O3] Q3, changes [O1]: a lane declares 1 to 4 reviewers (`reviewers: [{transport, model}, ...]`, the panel's own cap); all review the lane's diff in parallel, and a P0/P1 from any one starts the fix round. Operator: "It sjou;d be configurable like how many agents the worker can have"; "1–4 reviewers per lane (Recommended)".
- [O4] Q4: When the lane's rounds are used up and its reviewers still report a P0/P1, the lane goes on to the candidate; its open findings are recorded and put in the run reviewers' prompt. Operator: "Go on, flag it (Recommended)".
- [O5] Q5: The lane's fix rounds are its own cap (`rounds`, 0 to 2, default 1), separate from the run's `--fix-rounds`. Operator: "Own cap, default 1 (Recommended)".

## Grill defaults

- [G1] Configuration shape: a 2.9.0 worker gains `lane_review: {reviewers: [{transport: pi|claude, model, effort?}] (1 to 4, distinct by model as panel providers are), rounds? (0..2, default 1), timeout_minutes? (1..30, default 10), budget_usd? (0.5..20, default 3)}`. Refused before 2.9.0, naming `workers[<lane>].lane_review`. [added, not asked]
- [G2] Placement: after `verify_<lane>` passes, before `candidate`; one review per verified snapshot of the lane; a resume reuses a terminal record. [added, not asked]
- [G3] Only P0/P1 start a round; P2s are recorded and passed to the run reviewers with the open P0/P1. Findings from several reviewers are listed per reviewer in the repair brief (no overlap clustering needed for the trigger). [added, not asked]
- [G4] A reviewer that fails to start, times out or returns no parseable findings is recorded `failed` with its error; the others still count; if all fail, the lane goes on unreviewed. Never blocks the run. [added, not asked]
- [G5] Transport reuses the panel's machinery (`pi_command`, `pi_env`, `start_provider`, `parse_pi_stream`, `normalize_findings`, `review_sections(paths=lane_paths)`, `deepseek_guard`), with a bundled lane-review brief; the panel's behaviour and report-only contract are unchanged. [added, not asked]
- [G6] Tests use a fake provider under a temporary `HOME`; no test calls a real model.
- [G7] Operator's speed observation for context (2026-10-10): GPT-6.1-sol answered the idea review in about 20 s and a one-line probe in 7 s; two probes from a scratch directory hung to a 300 s timeout, so `timeout_minutes` and [G4] matter.

## Changes after launch

None yet.

## Deferred

- A viewer section and export of lane reviews.
- A verifier agent that checks each P0/P1 against the code before it starts a round.
- Resuming the original worker session with findings instead of a repair session.
- Lane reviewers at the challenge stage or before a lane's first verification.
