# review-panel-registry

Step 1 of the configurable review panel (board [r3]). It adds four things:
- A shared reviewer list, `learnings/skills/review-panel/reviewers.json` in agent-memory, pinned at prepare.
- A generic `cli` transport, so a subscription CLI such as Muse Code or the Antigravity CLI can sit on the panel.
- A **judged** run-review panel at feature.json 2.11.0. Blind seats run beside the built-in reviewers, then one Claude judge rules on every finding with equal weight.
- The run page view of the seats and the judge's rulings.

Specification: `prd.md` in this folder. Binding decisions: `decisions.md`, which holds the operator's own grill of 2026-10-14 ([O1]-[O13]). Frozen record shapes: `examples/`.

- `feature.json`: three lanes, `seats`, `judge` and `viewer`, each with GPT lane review. Reviewers general and coverage, a report-only GPT panel, critique on `viewer`, the design challenge on, `critical: false` and `tryout: false`.
- `policy.json`: each lane's owned paths and checks. The engine lanes run the workflow suite with `--jobs 4` plus the contract tests. The viewer runs build, lint, contracts, unit and Playwright.
- `seats-task.md`, `judge-task.md` and `viewer-task.md`: one per lane.

Launch: run through /cook (`~/.local/state/cook/review-panel-registry`). This run is feature.json 2.10.0 on ctl's controller. The 2.11.0 behaviour it builds is active only after integration and the operator's ctl fast-forward.
