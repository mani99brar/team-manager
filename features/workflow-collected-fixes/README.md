# workflow-collected-fixes

This feature carries the controller items of the md-manager issues collected up to 2026-10-13 from the GitHub issues, `docs/BACKLOG.md` and the run issues log: BL3, GH3, GH12, RLC12, RLD18, RLD20, RLF1, RLF2(a), RLG23, RLG24, RLI16, RLI17 and RLI19. It also carries the BACKLOG cleanup (BL1) and the RUNBOOK/README rows for every collected item, including GH8, RLI21 and RLF4. It is the engine part of the /cook of 2026-10-13 and runs beside the UI chain `ux-critique-fixes`, `-b` and `-c`; the server halves of these items wait for `-c`.

- Specification: `prd.md`.
- Decisions: `decisions.md` ([O9] is the panel's plan decision that set this feature's contract).

Files:

- `feature.json` (2.10.0): one lane, `engine`, on `claude-opus-5-5` at medium effort, with a GPT 6.1 lane reviewer through `pi` (1 round). It sets the bundled `general` and `coverage` reviewers, `challenge: true`, `critical: false` and `tryout: false`.
- `policy.json` (1.4.0): `engine` owns `workflow`, `docs/BACKLOG.md` and `docs/handoff/ux-fixes-engine.md`. Setup builds `.venv` from `workflow/requirements.lock`, and the check `workflow-unit` runs `.venv/bin/python -m workflow.run_tests`.
- `engine-task.md`: the lane's task, in the PRD's item order.

Launch: `python -m workflow launch workflow-collected-fixes --repo <this repository> --dry-run`, then `--live --automatic --by operator`.
