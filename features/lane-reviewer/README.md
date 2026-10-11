# lane-reviewer

Gives a lane its own reviewers (`lane_review: {reviewers: [1 to 4], rounds, timeout_minutes, budget_usd}`, feature.json 2.10.0): after the lane passes verification, they (for example `openai-codex/gpt-6.1-sol` through `pi`) review that lane's diff, and a P0/P1 starts one fix round through the repair loop before the candidate is built. Specification: `docs/PRD_LANE_REVIEWER.md`. Decisions: `decisions.md` (grill of 2026-10-10). Origin: `agent-workflow/ideas.md`, "Workers run their own review loop".

- `feature.json`: one lane, `engine`, the bundled `general` and `coverage` reviewers, no sidecar, `critical: false`, `tryout: false`.
- `policy.json`: `engine` owns `workflow`, `contracts/workflow` and its handoff; checks `workflow-unit` and `shared-contract`.
- `engine-task.md`: the lane's task as an outcome brief.

Launch: `python -m workflow launch lane-reviewer --repo <this repository> --dry-run`, then `--live --automatic --profile attended --fix-rounds 2 --by operator`.
