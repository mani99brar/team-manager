# run-checks-once

This feature makes the workflow controller run each verification check once, instead of once per lane.

- **Candidate dedupe.** On the combined candidate revision, each distinct non-browser command runs once in a shared worktree, and every declaring lane cites the result.
- **Run-level checks.** Policy 1.5.0 `run_checks`, such as the full Python suite, run once per candidate attempt.
- **Attribution.** When a run check fails, only its failing tests are rerun on the candidate, the base and each lane snapshot, to name one lane, or none, for the fix loop.
- **`run_tests --tests`** runs a subset.

Specification: `prd.md` in this folder. Binding decisions: `decisions.md`.

- `feature.json`:
  - one lane, `engine` (Opus 5.5, high effort), with GPT lane review;
  - reviewers general and coverage, plus a report-only GPT panel;
  - the design challenge on, `critical: false`, `tryout: false`, no critique (no frontend lane).
- `policy.json` (1.4.0, the newest ctl runs):
  - the engine lane owns `workflow`, `contracts/workflow` and its handoff doc;
  - it runs the workflow suite with `--jobs 4` plus the contract tests, after `npm ci`.
- `engine-task.md`: the lane's task.

Launch: through /cook (`~/.local/state/cook/run-checks-once`). The 1.5.0 behaviour this run builds is active only after integration and the operator's ctl fast-forward.
