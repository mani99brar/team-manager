# worker-skills

Lets a lane of a feature declare Claude Code skills (`skills: ["impeccable"]`, feature.json 2.8.0) that its worker and repair sessions load through a session-only plugin pinned in the run directory, without `--safe-mode`, with the advisor and the same deny list as today. Specification: `docs/PRD_WORKER_SKILLS.md`. Decisions: `decisions.md` (grill of 2026-10-08). This feature lands on main before `viewer-refine` launches, since that feature's UI lanes declare the skill.

- `feature.json`: one lane, `engine`, the bundled `general` and `coverage` reviewers, no sidecar, `critical: false`, `tryout: false`.
- `policy.json`: `engine` owns `workflow`, `contracts/workflow` and its handoff; checks `workflow-unit` and `shared-contract`.
- `engine-task.md`: the lane's task as an outcome brief.

Launch: `python -m workflow launch worker-skills --repo <this repository> --dry-run`, then `--live --automatic --profile attended --fix-rounds 2 --by operator` (the RUNBOOK canary first: the first run after a controller change).
