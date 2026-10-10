# PRD: Lane reviewer (each worker gets its own reviewer before the run's review)

Status: Proposed 2026-10-10, from the operator's idea of 2026-10-09/10 ("first we ask the sonnet worker to run its own sonnet reviere and veriief"; "WE can have GPT reviwer 6.1 sol reviewer which reviwes the workers work directly first"; `agent-workflow/ideas.md`, "Workers run their own review loop"). Ships as feature `lane-reviewer` (one lane, `engine`). Decisions: `features/lane-reviewer/decisions.md`.

## 1. Problem

Today the first independent eyes on a lane's code are the run's reviewers (`general`, `coverage`) and the report-only panel, and they see the whole candidate after every lane is frozen, verified and merged into one commit. A defect in one lane that a quick review would have caught costs a full review round: the review blocks, the in-run fix loop (`fix_round`, RUNBOOK "In-run fix loop") launches a repair session, then every lane is re-verified and fresh reviewers read the whole candidate again.

The panel (`workflow/panel.py`, feature.json 2.6.0) already runs a GPT reviewer through `pi`, but it is report-only by contract ("never a gate"), reads the whole candidate, and its findings never reach a worker.

The idea review of 2026-10-09 (GPT-6.1-sol and Claude, `agent-workflow/runs/ideas/2026-10-09-workers-run-their-own-review-loop/`) agreed on the smallest useful step: one review of each lane's own diff by a *different* model, and one fix round, run by the controller, before the run's review. Not a nested team of agents.

## 2. Outcome

A feature's lane may declare a `reviewer`. After that lane's work passes its own verification, one provider (for example `openai-codex/gpt-6.1-sol` through `pi`) reviews that lane's diff only, against the lane's task and the PRD. When it reports a P0 or P1, the lane gets one fix round with those findings as its brief, through the existing repair machinery, and is verified again before the candidate is built. The run's reviewers and panel then see a candidate that has already had one lane-level pass. A lane without `reviewer`, and every feature before 2.9.0, runs exactly as today.

## 3. Configuration (feature.json 2.9.0)

```json
{
  "version": "2.9.0",
  "workers": [
    {"node_id": "engine", "task": "engine-task.md",
     "reviewer": {"transport": "pi", "model": "openai-codex/gpt-6.1-sol", "rounds": 1, "timeout_minutes": 10}}
  ]
}
```

- `reviewer.transport`: `pi` or `claude`, the two transports the panel already proves at launch (`panel.prove_transports`). `model`: as a panel provider's (`provider/id` for `pi`; a Claude model id for `claude`). `rounds`: fix rounds this lane may get from its reviewer, 0 to 2, default 1 (0 is review-only). `timeout_minutes`: 1 to 30, default 10.
- Refused on a version before 2.9.0: 2.9.0 joins every exact-match version set that lists 2.8.0 (shared learning `version-gates-are-sets-add-a-keeps-everything-test.md`).
- `prepare` pins the reviewer into `plan.nodes[<lane>].reviewer` and the `pi` bin it proved, like the panel's `pi_bin`; `launch --dry-run` prints it per lane; DeepSeek models stay behind `panel.deepseek_guard`.

## 4. Design (default; the grill decides the open points)

### 4.1 Where it runs

After `verify_<lane>` passes for a lane with a reviewer, and before `candidate`. The controller builds the lane's review context with the panel's own pieces, restricted to that lane's owned paths (`panel.review_sections(worktree, base, snapshot, paths=automatic.lane_paths(runtime, lane))`, `cap_sections`), plus the lane's task, `decisions.md` and the PRD; it runs the provider in-process as a bounded subprocess the way the panel does (`pi_command`, `pi_env`, `start_provider`, `parse_pi_stream`, `normalize_findings`), with a bundled lane-review brief.

### 4.2 The fix round

Any P0 or P1 from the lane reviewer starts a repair of that lane through the existing fix loop (`repair.repair_session`, trigger `lane-review`), with the findings adapted to the repair brief's finding shape (`session_brief` takes `findings`; the reviewer schema's `severity`, `worker`, `message` are filled from the panel finding's `severity`, the lane, `title` + `detail` + `file:line`). The repair is journaled in `repairs.json` like every repair, and the lane is verified again. A lane whose reviewer `rounds` are used up goes on with its open findings recorded; the run's reviewers see them in their prompt. P2s never start a round; they are recorded and passed on.

The alternative the grill weighs: send the findings to the *original* worker session (same context) instead of a repair session, through `claude --bg --resume <session id>` or the `answer` path's pane typing. Nothing in the controller resumes a finished worker today, and the receipt model assumes one session per node; the repair route reuses everything.

### 4.3 Never a failure of the run

A provider that fails to start, times out, or returns no parseable findings is recorded (`failed`, with its error) and the lane goes on unreviewed, exactly as the panel swallows failures; the run does not block on its lane reviewer. A KeyboardInterrupt leaves the record non-terminal so `resume` reruns it.

### 4.4 Records

- `<run>/lane-review/<lane>/<n>.json` per review: provider, model, status (`ok`, `failed`), findings, cost, duration, the snapshot reviewed, and the repair it started (if any). A schema under `contracts/workflow/` that `test:contracts` validates.
- An event `lane_review` on the lane: started, findings count by severity, repair started or not.
- `status` prints per lane its last lane review.
- The export and the viewer are not changed by this feature.

## 5. Out of scope

A worker spawning its own agents (the controller runs the reviewer). More than one reviewer per lane. A separate findings verifier. Changing the panel's report-only contract. Viewer and export. Reviewers before a lane's first verification passes.

## 6. Files

`workflow/automatic.py` (placement after `verify_<lane>`, the round cap), `workflow/repair.py` (trigger `lane-review`, finding adapter), a new `workflow/lane_review.py` (context, provider run, record), `workflow/panel.py` (reuse only; the pieces may move into a shared module without changing the panel's behaviour), `workflow/launch.py`, `workflow/pipeline.py` (validate, pin, dry-run), the version-gate sets, `contracts/workflow/feature.schema.json`, `contracts/workflow/examples/feature.2.9.0.json`, `contracts/workflow/contract.test.ts`, a lane-review record schema, `workflow/RUNBOOK.md` ("Lane reviewer (feature.json 2.9.0)"), `workflow/README.md`, `workflow/skills/workflow-grill/SKILL.md` (2.9.0), tests, `docs/handoff/lane-reviewer.md`.

## 7. Acceptance (what the verifier and reviewers check)

1. A 2.9.0 feature with a `reviewer` on one of two lanes prepares: `plan.nodes.<lane>.reviewer` pinned; the other lane has none; `launch --dry-run` prints both.
2. In an offline automatic run (fake provider), a lane reviewer returning a P1 starts exactly one repair of that lane with the finding in its brief, the lane is re-verified, and the candidate is built after it; a P2-only reply starts none.
3. A second P1 after the round is used up starts no repair; the finding is recorded and appears in the run reviewers' prompt.
4. A provider that times out or returns garbage is recorded `failed` and the run goes on to the candidate.
5. A lane without `reviewer` and every 2.8.0 feature run byte for byte as today (the gate-set test; the plain lane's flow has no lane-review step).
6. A 2.8.0 feature with `reviewer` is refused, naming the lane.
7. `test:contracts` validates the 2.9.0 example and the record schema; the full workflow suite is green.
