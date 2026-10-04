# Review sidecar

Feature run for `docs/PRD_REVIEW_SIDECAR.md`: an independent senior-engineering reviewer that observes the lanes during the work phase. The `engine` lane (Python controller, workflow contracts, docs) adds the 2.3.0 `sidecar` declaration, the read-only passes, the ledger, the controller-gated messages to workers and export 1.6.0. The `viewer` lane (server, projects contract, UI, browser tests) serves the ledger live and adds the `Review sidecar` node page. The bundled brief `senior-review-brief.md` in this directory becomes `workflow/prompts/sidecar/senior-review.md`. Reviewed by `general` and `coverage`.

This feature does not use a sidecar itself (it does not exist yet). After integration, restart the live API (it does not watch `server/`) and run the live smoke of PRD section 8.

Launch from md-manager's main checkout on `feature/viewer-ux` (clean), in a Herdr pane:

```
WORKFLOW_WORKER_EFFORT=medium DISABLE_AUTOUPDATER=1 .venv/bin/python -m workflow launch review-sidecar --live --automatic --worker-timeout-seconds 14400 --review-timeout-seconds 3600 --worker-model claude-opus-5-5 --judge-model claude-opus-5-5
```

Approval fast-forwards `feature/viewer-ux`.
