# PRD: Lane reviewer (each worker gets its own reviewer before the run's review)

Status: Proposed 2026-10-10, from the operator's idea of 2026-10-09/10 ("first we ask the sonnet worker to run its own sonnet reviere and veriief"; "WE can have GPT reviwer 6.1 sol reviewer which reviwes the workers work directly first"; `agent-workflow/ideas.md`, "Workers run their own review loop"). Ships as feature `lane-reviewer` (one lane, `engine`). Decisions: `features/lane-reviewer/decisions.md`.

## 1. Problem

Today the first independent eyes on a lane's code are the run's reviewers (`general`, `coverage`) and the report-only panel, and they see the whole candidate after every lane is frozen, verified and merged into one commit. A defect in one lane that a quick review would have caught costs a full review round: the review blocks, the in-run fix loop (`fix_round`, RUNBOOK "In-run fix loop") launches a repair session, then every lane is re-verified and fresh reviewers read the whole candidate again.

The panel (`workflow/panel.py`, feature.json 2.6.0) already runs a GPT reviewer through `pi`, but it is report-only by contract ("never a gate"), reads the whole candidate, and its findings never reach a worker.

The idea review of 2026-10-09 (GPT-6.1-sol and Claude, `agent-workflow/runs/ideas/2026-10-09-workers-run-their-own-review-loop/`) agreed on the smallest useful step: one review of each lane's own diff by a *different* model, and one fix round, run by the controller, before the run's review. Not a nested team of agents.

## 2. Outcome

A feature's lane may declare `lane_review` with 1 to 4 reviewers. After that lane's work passes its own verification, those providers (for example `openai-codex/gpt-6.1-sol` through `pi`) review that lane's diff only, against the lane's task and the PRD. When any of them reports a P0 or P1, the lane gets one fix round with those findings as its brief, through the existing repair machinery, and is verified again before the candidate is built. The run's reviewers and panel then see a candidate that has already had one lane-level pass. A lane without `lane_review`, and every feature before 2.9.0, runs exactly as today.

## 3. Configuration (feature.json 2.9.0)

```json
{
  "version": "2.9.0",
  "workers": [
    {"node_id": "engine", "task": "engine-task.md",
     "lane_review": {
       "reviewers": [
         {"transport": "pi", "model": "openai-codex/gpt-6.1-sol"},
         {"transport": "claude", "model": "claude-sonnet-5-5", "effort": "medium"}
       ],
       "rounds": 1, "timeout_minutes": 10, "budget_usd": 3}}
  ]
}
```

- `lane_review.reviewers`: 1 to 4 reviewers (the panel's provider cap, decisions.md [O3]), each `{transport: pi|claude, model, effort?}` exactly as a panel provider, distinct by model; the transports are proved at launch by `panel.prove_transports`. All review the lane's diff in parallel.
- `rounds`: fix rounds this lane may get from its reviewers, 0 to 2, default 1 (0 is review-only), separate from `--fix-rounds` ([O5]). `timeout_minutes`: 1 to 30, default 10. `budget_usd`: 0.5 to 20, default 3, per reviewer (passed as the claude transport's `--max-budget-usd`).
- Refused on a version before 2.9.0, naming `workers[<lane>].lane_review`: 2.9.0 joins every exact-match version set that lists 2.8.0 (shared learning `version-gates-are-sets-add-a-keeps-everything-test.md`).
- `prepare` pins it into `plan.nodes[<lane>].lane_review` with the `pi` bin it proved, like the panel's `pi_bin`; `launch --dry-run` prints it per lane; DeepSeek models stay behind `panel.deepseek_guard`.

## 4. Design (decisions.md [L1], [L2], [L3])

### 4.1 Where it runs

Inside the lane's own `verify_<lane>` step, after its policy checks pass, so lanes are reviewed in parallel by the existing verify fan-out; no new graph node. The lane-review block is re-derived from the (lane, snapshot) record on every entry to `verify_<lane>`, after `verify_revision` returns, never read back from the saved packet, and a `running` event is emitted when the review starts. The controller builds the lane's review context with the panel's own pieces, restricted to that lane's owned paths (`panel.review_sections(worktree, base, snapshot, paths=automatic.lane_paths(runtime, lane))`, `cap_sections`), plus the lane's task, `decisions.md` and the PRD; it runs each reviewer in-process as a bounded subprocess the way the panel does (`pi_command`, `pi_env`, `start_provider`, `parse_pi_stream`, `normalize_findings`), with a bundled lane-review brief. The record is keyed by (lane, snapshot commit): a resume, a fork or a sibling's failure reuses a terminal record instead of restarting reviewers.

### 4.2 The fix round

A P0 or P1 from any lane reviewer blocks the lane's verify packet only when the plan is automatic, `fix_rounds(plan) > 0`, the lane has `rounds` left and `len(applied repairs) + 1 < MAX_REPAIRS`. The gate reasons are short (`lane-review: <severity> <file>:<line> <title, capped>`). The existing fix loop then repairs it as any failed `verify_<lane>`: trigger `verify`, `origin: "lane-review"` in its `repairs.json` entry (the export is unchanged), the findings passed to `session_brief` as `findings=` in the six-key review-finding shape (`{severity, message, disposition: "open", worker: <lane>, requirement: null, reviewer: "lane-review-<n>"}`, `message` folding `file:line`, title and detail, capped; the lane-review record keeps the full panel shape), and the lane verified again. Lane-review repairs count against `lane_review.rounds`, not `--fix-rounds`: `fix_decision` recognises the block by its `lane-review:` gate reasons, and a resumed round takes `origin` and the findings from the open journal entry. A lane-review repair that ends blocked counts as a spent round and never exhausts the fix loop. When no round can start (rounds used up, fix loop off, manual plan, repair cap), the packet passes and the open findings are recorded and put in the run reviewers' prompt. P2s never start a round; they are recorded and passed on.

### 4.3 Never a failure of the run

A reviewer that fails to start, times out, or returns no parseable findings is recorded (`failed`, with its error); the others still count, and if all fail the lane goes on unreviewed, exactly as the panel swallows failures; the run does not block on its lane reviewer. A KeyboardInterrupt leaves the record non-terminal so `resume` reruns it.

### 4.4 Records

- `<run>/lane-review/<lane>/<n>.json` per review round: per reviewer its provider, model, status (`ok`, `failed`), findings, cost, duration, the snapshot reviewed, and the repair it started (if any). A schema under `contracts/workflow/` that `test:contracts` validates.
- An event `lane_review` on the lane: started, findings count by severity, repair started or not.
- `status` prints per lane its last lane review.
- The export and the viewer are not changed by this feature.

## 5. Out of scope

A worker spawning its own agents (the controller runs the reviewers). More than four reviewers per lane. A separate findings verifier. Changing the panel's report-only contract. Viewer and export. Reviewers before a lane's first verification passes.

## 6. Files

`workflow/pipeline.py` and `workflow/automatic.py` (the review inside `verify_<lane>`, the gate, the round and repair caps, `fix_decision`/`fix_round` for `origin: "lane-review"`), `workflow/repair.py` (the `origin` key, the finding adapter), a new `workflow/lane_review.py` (context, provider run, record), `workflow/panel.py` (reuse only; the pieces may move into a shared module without changing the panel's behaviour), `workflow/launch.py`, `workflow/pipeline.py` (validate, pin, dry-run), the version-gate sets, `contracts/workflow/feature.schema.json`, `contracts/workflow/examples/feature.2.9.0.json`, `contracts/workflow/contract.test.ts`, a lane-review record schema, `workflow/RUNBOOK.md` ("Lane reviewer (feature.json 2.9.0)"), `workflow/README.md`, `workflow/skills/workflow-grill/SKILL.md` (2.9.0), tests, `docs/handoff/lane-reviewer.md`.

## 7. Acceptance (what the verifier and reviewers check)

1. A 2.9.0 feature with `lane_review` (two reviewers) on one of two lanes prepares: `plan.nodes.<lane>.lane_review` pinned; five reviewers, duplicate models, and out-of-range `rounds` are refused naming the key; the other lane has none; `launch --dry-run` prints both.
2. In an offline automatic run (fake provider), two fake reviewers, one returning a P1 and one P2-only, start exactly one repair of that lane with the finding in its brief, the lane is re-verified, and the candidate is built after it; a P2-only reply starts none.
3. A second P1 after the round is used up starts no repair; the finding is recorded and appears in the run reviewers' prompt.
4. One reviewer that times out and one that returns garbage are both recorded `failed` and the run goes on to the candidate.
5. A lane without `lane_review` and every 2.8.0 feature run byte for byte as today (the gate-set test; the plain lane's flow has no lane-review step).
6. A 2.8.0 feature with `lane_review` is refused, naming the lane.
7. A `--fix-rounds 0` automatic run (and a manual plan) with a reviewer P1 reaches the candidate with the P1 recorded and no blocked packet.
8. A fake lane-review repair session that times out counts as the spent round; the run reaches the candidate.
9. With two earlier verify repairs applied, the lane-review round is skipped and its findings recorded; a later review block can still be repaired.
10. A run with a lane-review repair exports a fix-loop section without `error`, and every exported `fix_loop` finding validates (jsonschema `Draft202012Validator`, as `workflow/verification.py` uses) against the finding item schema of `contracts/projects/runDetail.schema.json`, read-only; the test fails on a `{severity, worker, message, disposition}` finding.
11. The repair brief for a lane-review repair holds the findings only in the quoted findings block; an oversized and an injected-instruction finding are capped and quoted; events and gate reasons carry no raw detail text.
12. The controller killed between the blocked packet and `fix_round` and resumed at the same attempt still gets the blocked packet. `--fix-rounds 1` with one ordinary repair applied: a lane-review P1 starts a repair without `exhausted`, recorded with `round`/`rounds` from `lane_review.rounds`.
13. Lane A passes and is reviewed, lane B blocks, the run forks: A's reviewers are not started again; a fake provider that ignores SIGTERM is killed with its process group.
14. `test:contracts` validates the 2.9.0 example and the record schema; the full workflow suite is green.
