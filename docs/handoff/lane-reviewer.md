# Handoff: lane reviewer (feature.json 2.9.0)

A feature.json 2.9.0 lane may declare `lane_review`: 1 to 4 reviewers that review that lane's diff after it passes verification, and a P0/P1 starts one fix round of the lane through the existing repair loop before the candidate. Specification: `docs/PRD_LANE_REVIEWER.md` sections 3, 4, 7; decisions: `features/lane-reviewer/decisions.md`.

## What changed

- **New module `workflow/lane_review.py`** — config validation, the bundled brief pin, the record, the finding adapter, the reviewer subprocess (pi scratch cwd / claude throwaway worktree), the gate predicate and the spent-round marks. It reuses `workflow/panel.py` pieces (`provider_settings`, `pi_command`, `pi_env`, `claude_command`, the claude settings/deny list, `parse_pi_stream`, `normalize_findings`, `review_sections`, `cap_sections`, `deepseek_guard`) without changing the panel's behaviour or its report-only contract.
- **Bundled brief `workflow/prompts/lane-review.md`** — pinned with its sha256 at prepare; says a defect needing a change outside the lane's owned paths is a P2.
- **Record schema `contracts/workflow/lane-review.schema.json`** (`<run>/lane-review/<lane>/<n>.json`); the 2.9.0 example `contracts/workflow/examples/feature.2.9.0.json`; the feature schema's `workers[].lane_review` and version enum; `contract.test.ts` asserts both.
- **Version gates** — 2.9.0 joined every set that listed 2.8.0 (`launch.py` `CRITICAL_VERSIONS`/`LANE_ROLE_VERSIONS`/`SKILLS_VERSIONS` plus the new `LANE_REVIEW_VERSIONS`, `guardrails.GUARDED_VERSIONS`, `sidecar.SIDECAR_VERSIONS`, `attack.ATTACK_VERSIONS`, `panel.PANEL_VERSIONS`, the feature schema, `contract.test.ts`, the contracts README, the grill SKILL.md).
- **`launch.py` / `pipeline.py` (prepare)** — `lane_review.declared` refuses the key before 2.9.0 naming the lane; the transports are proved at launch (`panel.prove_transports`); prepare pins `plan.nodes[<lane>].lane_review` with the brief text + sha256 and the proved pi bin; `launch --dry-run` prints it; `status` shows each lane's last review.
- **`pipeline.py` `Runtime.verify`** — after the lane's checks pass, the review runs inside `verify_<lane>`; a P0/P1 block sets the gate blocked with short `lane-review:` reasons and a structured `lane_review_block` marker on the packet (`recheck_packet` drops the reasons, so the candidate step never re-sees them).
- **`automatic.py`** — `check_retries` skips a lane-review-blocked lane (never a flaky-check retry, so a mixed failure still retries the other lane); `fix_decision` routes a lane-review block to a repair and excludes lane-review sessions from the ordinary count; `fix_round` runs the lane-review round with `origin: "lane-review"`, turns any refusal or a blocked session into a spent round (a mark, then a re-entry to verify), and never `exhausted`; the run reviewers' prompt carries the open lane-review findings as untrusted data.
- **`repair.py`** — `origin` threads through `repair_session`/`launch_session` and joins `SESSION_KEYS`; for `origin: "lane-review"` the round and its cap come from `lane_review.rounds`, not `--fix-rounds`.
- **Docs** — RUNBOOK "Lane reviewer (feature.json 2.9.0)", the README feature.json paragraph, this file.

## The review-only release point

The worker could not commit (controller rules), so there is no review-only SHA. The **review-only slice** is this file set and lands first when split for review: `workflow/lane_review.py`, `workflow/prompts/lane-review.md`, `contracts/workflow/lane-review.schema.json`, the feature-schema/example/contract-test and version-gate edits, the prepare pin and `launch --dry-run`/`status`, the `verify_<lane>` review-and-record hook with the gate **forced off** (no `fix_decision`/`fix_round`/`repair.py` edits), and the review-only tests. The **repair route** is the `automatic.py`/`repair.py` edits and their tests. Run review-only by setting `rounds: 0` on every lane (or launching without `--fix-rounds`): the reviewers run, the findings are recorded and put in the run reviewers' prompt, and nothing ever blocks.

## How to turn it on

Add to a 2.9.0 `feature.json` lane:

```json
"lane_review": {"reviewers": [{"transport": "pi", "model": "openai-codex/gpt-6.1-sol"}], "rounds": 1, "timeout_minutes": 10, "budget_usd": 3}
```

Start with `rounds: 0` (review-only) and read the first run's `<run>/lane-review/<lane>/*.json` and the findings in the run reviewers' prompt before relying on a round.

## The repair route is unproven — read the first review-only run first

**The repair route's value is unproven.** No run has yet shown that a lane reviewer's P0/P1 and a fix round improve the candidate; it may spend a round on a false positive. Run `rounds: 0` first and read the first review-only run's findings (are they real defects the lane can fix inside its owned paths?) before turning on a round. The route stays in scope per the operator's decisions [O2]/[O5].

## Cost and wall time (loosely bounded)

Worst case per run: **lanes × reviewers × (`rounds` + 1) × `budget_usd`** in spend and **lanes × (`rounds` + 1) × `timeout_minutes`** in wall time (the verify superstep waits for its slowest lane, and one extra review runs after the last fix). `budget_usd` is enforced only where the transport supports it (the claude transport's `--max-budget-usd`); **pi reviewers are bounded by `timeout_minutes` only — there is no per-run spend cap.** An operator who turns on four pi reviewers can have a run sit for a long time with no spend cap; the operator's speed note of 2026-10-10 records pi probes that hung to a 300 s timeout, so keep `timeout_minutes` low and watch the first runs.

## Open P2s (design-challenge attempt 5)

1. **Refused round must be persisted (note 1).** Done: a refused round (`except ValueError`) and a blocked session both write a `spent_marks` entry in the `(lane, snapshot)` record, so rounds-left drops and the next entry to `verify_<lane>` re-derives no block. Tests: `OfflineGateTests.test_refused_repair_round_is_a_spent_round...` (the refusal branch), `OfflineGateTests.test_blocked_repair_session_is_a_spent_round...` (the blocked branch), `GateTests.test_rounds_left_drops_with_spent_marks`.
2. **Mixed failure (note 2).** Done: `check_retries` skips a lane-review-blocked lane instead of aborting, so a sibling lane killed for memory still retries. Covered by reasoning and the `check_retries` skip; no offline memory-kill-plus-lane-review test was added (see Untested).
3. **Structured marker, not a prefix (note 3).** Done: the block carries `packet["lane_review_block"]`; `is_lane_review_block` reads it, and the `lane-review:` text is display only. A policy check named `lane-review` would not be misrouted. No dedicated test for a check literally named `lane-review`; `is_lane_review_block` keys on the marker, not the text.
4. **Context from pinned copies only (note 4).** Done: the context is built from the repository's Git objects (the diff), `plan.nodes[<lane>].task`, `plan.decisions.text` and `plan.prd.copy` — never a working checkout. No test edits a checkout between two entries to assert the context bytes are unchanged (see Untested).
5. **Shared fix-loop regression guard (note 5).** The two-commit order is kept in the release-point section above. The ordinary fix loop is exercised green on this branch by `workflow.test_repair` (53 tests), `workflow.test_automatic` and `workflow.test_lanes` run **without `PYTHONSAFEPATH`** (see the note below); the lane-review branches are guarded by the `lane_review_block` marker and `origin == "lane-review"`, so a run with no `lane_review` takes the unchanged path. No byte-identical snapshot test was added; the regression guard is the unchanged ordinary-repair suites passing on this branch.
6. **Cost/wall time in the handoff (note 6).** Done: the section above.

## Untested (no executed check covers these)

- A claude reviewer against a **real** model (every test uses a fake provider under a temporary HOME).
- A mixed offline run with one lane lane-review-blocked and one lane memory-killed reaching both the retry and the repair (the `check_retries` skip is covered by inspection only).
- The context bytes being unchanged across a checkout edit between two entries.
- **Run `workflow-unit` without `PYTHONSAFEPATH`.** The approved `workflow-unit` argv (`.venv/bin/python -m workflow.run_tests`) carries no `PYTHONSAFEPATH`, which is correct: that variable strips the cwd from `sys.path`, so the committed policy checks' subprocesses (for example `python -m unittest discover -s tests`, which does `from backend import VALUE`) cannot import a worktree-root module and the graph/repair tests fail spuriously. Running the suite through `workflow run-report` (as the automatic-mode wrapper does) propagates `PYTHONSAFEPATH=1` into those check subprocesses and produces ~100 spurious `worker/adapter` failures that are identical on pristine HEAD; run the suite directly, without the variable, to see the true result.
