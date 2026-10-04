# Attack pass

Feature run for `docs/PRD_ATTACK_PASS.md`: an opt-in, report-only attack pass in the review step. One print job per angle checks the frozen candidate against the project's stated requirements and proves each break with a failing test; the controller re-runs each test on a clean copy and a skeptic job judges the reproduced ones. The `engine` lane (Python controller, workflow contracts, bundled briefs, docs) adds feature.json 2.5.0 `attack`, policy 1.3.0 `attack_check`, the launch guard, `workflow/attack.py`, `attack-pass`, `attack-label`, `attack-tally` and export 1.8.0. The `viewer` lane (server, projects contract, UI, browser tests) serves the record and adds the run page's Attack pass section. The briefs in `attack-briefs/` become `workflow/prompts/attack/` unchanged. Reviewed by `general` and `coverage`; observed by the review sidecar.

This feature does not use an attack pass itself (it does not exist yet). Launch from the `~/dev/mdm-attack` checkout on `feature/attack-pass` (clean), in a Herdr pane:

```
DISABLE_AUTOUPDATER=1 ~/dev/md-manager/.venv/bin/python -m workflow launch attack-pass --live --by operator --automatic --worker-timeout-seconds 14400 --review-timeout-seconds 3600 --reviewer-transport print --worker-model claude-opus-5-5 --worker-effort medium --judge-model claude-opus-5-5
```

Run branches are `feature/attack-pass-runs/<run>`. Integration fast-forwards the run branch; the operator fast-forwards `feature/attack-pass` and decides any merge into `main`.
