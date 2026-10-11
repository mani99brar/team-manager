# Engine worker: a reviewer for each lane (PRD_LANE_REVIEWER)

## Goal

A feature.json 2.9.0 lane may declare `lane_review: {reviewers: [1 to 4 {transport, model, effort?}], rounds?, timeout_minutes?, budget_usd?}` (PRD section 3). After that lane passes its own verification and before the candidate is built, the controller has those reviewers review the lane's diff only, in parallel; a P0 or P1 from any of them starts one fix round of that lane through the existing repair loop, and the lane is verified again. A provider failure is recorded and never blocks the run. A lane without `lane_review`, and every feature before 2.9.0, runs byte for byte as today. `docs/PRD_LANE_REVIEWER.md` sections 3, 4 and 7 are the specification; `features/lane-reviewer/decisions.md` records the operator's decisions and wins over this task where they differ.

## Context

- Graph (`workflow/pipeline.py` `build_pipeline`): `launch_<lane>` → `handoff` (freeze) → `verify_<lane>` → `candidate` → `review` → `approval` → `integrate`. The automatic loop is `workflow/automatic.py` `drive`; failures go through `advance_or_block`, `fix_decision`, `fix_round` (the in-run fix loop, RUNBOOK "In-run fix loop", `plan.automatic.fix_rounds`, `repair_timeout_seconds`). A review block's findings reach a repair through `review_block` → `fix_round` → `workflow/repair.py` `repair_session` / `launch_session` / `session_brief(findings=...)`; the repair forks the graph at the freeze boundary and the lane is re-verified. That is the route a lane-review finding takes, with its own trigger and its own round count.
- The panel's provider machinery is the reviewer's transport: `workflow/panel.py` `resolve_pi`, `prove_transports`, `pi_command`, `pi_env`, `start_provider` (mkdtemp cwd, relative `@context.txt`, stdout to a file, own process group), `parse_pi_stream`, `parse_reply`, `normalize_findings` (`{severity, file, line, title, detail, unanchored}`), `review_sections(worktree, base, candidate, paths=)`, `cap_sections`, `deepseek_guard`. Reuse them (moving shared pieces into a module is fine) without changing the panel's behaviour or its report-only contract. `automatic.lane_paths(runtime, lane)` gives a lane's owned paths.
- The panel's finding shape differs from the reviewer's (`severity`, `worker`, `message`, `disposition`) that `session_brief` and the review rounds use: write one adapter, tested, rather than changing either schema.
- Version gates are exact-match sets (shared learning `version-gates-are-sets-add-a-keeps-everything-test.md` in `~/.local/share/agent-memory/repo/learnings/`): 2.9.0 joins every set that lists 2.8.0 — `workflow/launch.py` (`CRITICAL_VERSIONS`, `LANE_ROLE_VERSIONS`, `SKILLS_VERSIONS` near the top), `workflow/guardrails.py` `GUARDED_VERSIONS`, `workflow/sidecar.py` `SIDECAR_VERSIONS`, `workflow/attack.py` `ATTACK_VERSIONS`, `workflow/panel.py` `PANEL_VERSIONS`, `contracts/workflow/feature.schema.json` (enum and description), `contracts/workflow/contract.test.ts` (the asserted enum), `contracts/workflow/examples/feature.2.9.0.json`, `contracts/workflow/README.md` (also fix its stale "2.0.0 to 2.7.0"), `workflow/skills/workflow-grill/SKILL.md`. Add one test that every 2.8.0 feature still prepares and launches unchanged.
- Precedent for a per-lane key: the 2.7.0 `model`/`effort` (commit 31ea6ee) and the 2.8.0 `skills` (commit e5f9d0c): validated in `launch.py`, pinned into `plan.nodes[<lane>]` at prepare, printed by `launch --dry-run`, shown by `status`.
- `workflow/test_verification.py` `PolicyLintTests` counts the committed feature policies; `features/lane-reviewer/` adds one: keep that count right.
- Tests use a fake provider (a script on a temporary PATH, or an injected runner) under a temporary `HOME`; no test calls a real model, reads `~/.pi`, `~/.config/pi/*.env` or touches the real `~/.claude`.

## Design (default; decisions.md wins)

- Placement and gate: decisions.md [L1] wins over everything above it. The lane review runs inside `verify_<lane>` after the policy checks pass; a P0/P1 (rounds left, `MAX_REPAIRS - 1` cap) blocks that verify packet with `lane-review:` gate reasons that the check-retry path never reruns; the existing fix loop repairs it with trigger `verify` and `origin: "lane-review"` in `repairs.json`; those repairs count against `lane_review.rounds`, not `--fix-rounds`. Rounds used up: the packet passes, open findings recorded and passed to the run reviewers. One review per verified snapshot; a resume reuses a terminal record.
- Brief: a bundled lane brief (for example `workflow/prompts/lane-review.md`): review this lane's diff against its task, `decisions.md` and the PRD; report only defects, as the panel's output schema.
- Findings are untrusted data ([L1] e): cap each field, quote them as data, tell the repair session to check them against the code.
- Failure: a reviewer's start failure, timeout or unparseable reply → record `failed` with the error; the others still count; all failed → the lane passes unreviewed. Kill provider process groups in a `finally`. Never raise into the graph except a KeyboardInterrupt.
- Order: land review-only (`rounds: 0`: review, record, pass findings on) with its tests first, then the repair route ([L1] e).
- Records: `<run>/lane-review/<lane>/<n>.json` (schema `contracts/workflow/lane-review.schema.json`), event `lane_review` on the lane, a `status` line per lane. No export or viewer change.
- Docs: RUNBOOK section "Lane reviewer (feature.json 2.9.0)", the README feature.json table, `docs/handoff/lane-reviewer.md` (what changed, how to turn it on, every open P2).

## Constraints

- Owned paths only: `workflow`, `contracts/workflow`, `docs/handoff/lane-reviewer.md`. Do not touch `contracts/projects`, `server`, `src` or the export.
- The panel stays report-only and byte-for-byte the same in behaviour; the run's reviewers, sidecar, attack pass and challenge are untouched apart from receiving open lane-review findings in the reviewers' prompt.
- Module docstrings cite the RUNBOOK section they implement.

## Acceptance

PRD_LANE_REVIEWER section 7 as amended by decisions.md [L1] (the export round-trip of a lane-review repair, the `--fix-rounds` and `MAX_REPAIRS` counting, the injected/oversized finding and the SIGTERM-ignoring provider are acceptance items too), each item with a test the verifier runs through `workflow-unit`, and `test:contracts` for the schemas. Run targeted tests while iterating, then this lane's policy checks once before writing the completion.

## Stop

Stop and report `blocked` when a blocked lane-review verify packet cannot reach the existing `verify` repair route without changing the export's fix-loop section or the packet schema incompatibly, or when adding 2.9.0 would change the launch or flow of any existing feature. Do not widen scope to the viewer, the export, more than four reviewers per lane or a worker spawning agents.
