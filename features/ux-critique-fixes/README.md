# ux-critique-fixes

Stage A of the fixes for the 2026-10-13 Astra + Fable critique of the md-manager dashboard: the Projects shell's first screen tells the truth (loading states, Needs you with decision-waiting paused runs and no superseded ones, full-width Triage, dates and days, state-toned badges, Add to Triage pins, the run chip's state) and run detail pages reach their answer (one findings list, verdict-led reviewers, compact node pages, folded Assignment, a storage error that says what to fix). Read-only; no server or contract change. Stages B and C are separate features; the controller items run in `workflow-collected-fixes`.

- `prd.md`: problem, non-goals (the later stages), the cross-lane contract (section 5), one requirement per finding with its acceptance, the DESIGN.md amendments and risks.
- `feature.json` 2.10.0: lanes `lists` (claude-opus-5-5, medium) and `pages` (claude-sonnet-5-5, medium, loading the `impeccable` skill), each with a GPT 6.1 lane reviewer; no `panels` review; reviewers general and coverage; the design challenge; the critique on both lanes.
- `policy.json` 1.4.0: owned paths, the checks (build, lint, contracts, unit, the project-workflows browser suite with each lane's scenarios) and `critique_app` (`tests/project-workflows/dispatch-app.ts`).
- `lists-task.md`, `pages-task.md`: the lanes' outcome briefs.
- `decisions.md`: the operator's prompt and decisions ([O1] to [O8]), the panel's plan ([O9]) and grill answers ([O10] to [O15]), the grill defaults and what is deferred.

Launch from this checkout: `python -m workflow launch ux-critique-fixes --repo <this repository> --dry-run`, then `--live --automatic --fix-rounds 3 --judge-model claude-opus-5-5 --review-timeout-seconds 3600 --by operator`; both pass `--run-root ~/.local/state/md-manager-workflows/ux-critique-fixes`, because this checkout's name is not `md-manager` and the default root would differ.
