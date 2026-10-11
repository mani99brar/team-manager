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

- [L1] lane-reviewer-001, design challenge attempt 1 (3 P1s; the night-shift panel, Claude and GPT, agreed to hold for the operator). The operator approved the proposed fix on 2026-10-11. Operator: "go". It changes [G2] and settles the three P1s:
  (a) Placement: the lane review runs inside the lane's own `verify_<lane>` step, after its policy checks pass (so lanes are reviewed in parallel, by the existing verify fan-out). No new graph node.
  (b) Gate: while the lane's lane-review rounds are not used up, a P0/P1 from any lane reviewer makes that verify packet `blocked`, with one gate reason per finding, prefixed `lane-review:` and marked so that `check_retries` / `advance_failed_checks` never treat it as a flaky check to rerun; the fix loop then repairs it as any failed `verify_<lane>` (trigger `verify`). Once the rounds are used up, the packet passes and the open findings are recorded and passed to the run reviewers ([O4]).
  (c) Export: no change ([O1] holds): the repair keeps trigger `verify`; its `repairs.json` entry gains `origin: "lane-review"` (a key the export ignores). An acceptance test exports a run with a lane-review repair and gets a fix-loop section without `error`.
  (d) Budgets ([O5]): repairs with `origin: "lane-review"` count against `lane_review.rounds` and not against `--fix-rounds` (`fix_decision`'s per-lane count skips them); they do count against the run-wide `MAX_REPAIRS`, and lane-review repairs per run are capped at `MAX_REPAIRS - 1` so the fix loop always keeps one (past that the lane passes with its findings recorded). `launch_session`'s `round`/`rounds` for a lane-review repair come from `lane_review.rounds`.
  (e) Challenge P2s, all taken: reviewer findings are untrusted data (each field capped in length, quoted as data in the repair brief and the run reviewers' prompt, the brief says they are claims to check against the code; adapter test with an oversized and an injected-instruction finding); provider process groups are killed in a `finally` (test with a fake provider that ignores SIGTERM); the handoff records the wall-time cost (one extra review after the last fix); the lane lands review-only (`rounds: 0`) with its tests first, then the repair route.
- [L2] lane-reviewer-001, design challenge attempt 2 (1 P1, 5 P2s). Decided on the advisor's recommendation, as the operator asked on 2026-10-11. Operator: "For any other blockers ask the advisor and continue". It changes [L1](b) and [L1](d):
  (a) Changes [L1](b): the lane review gates (blocks the verify packet) only when the plan is automatic and `fix_rounds(plan) > 0`. Otherwise the effective `rounds` is 0: review-only, the packet passes, and the findings are recorded and passed to the run reviewers.
  (b) A lane-review repair that ends blocked (timeout, no change, refused change) counts as a spent round: `fix_round` does not raise `exhausted` for `origin: "lane-review"`, the lane's packet then passes with its findings recorded, and `fix_decision` leaves lane-review sessions out of both its per-lane count and its last-session-blocked test.
  (c) Changes [L1](d): a lane-review repair starts only when `len(applied repairs) + 1 < MAX_REPAIRS` (the run-wide applied count, not a lane-review tally); otherwise the round is skipped and the findings are recorded.
  (d) For `origin: "lane-review"`, `fix_round` passes the adapted, capped findings as `findings=` so the repair brief renders them as review findings; the gate reasons stay short (`lane-review: <severity> <file>:<line> <title, capped>`), and no raw detail text reaches events, gate reasons or the `exhausted` message.
  (e) The verify packet is saved once, after the review verdict; the review record is keyed by (lane, snapshot commit), and a terminal record is reused (a fork or a sibling failure does not restart reviewers of an unchanged lane); a `running` event is emitted when the review starts.
  (f) The task and PRD are rewritten to [L1] and [L2] (no trigger `lane-review`, no node after `verify_<lane>`).

## Deferred

- A viewer section and export of lane reviews.
- A verifier agent that checks each P0/P1 against the code before it starts a round.
- Resuming the original worker session with findings instead of a repair session.
- Lane reviewers at the challenge stage or before a lane's first verification.
