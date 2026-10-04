# Projects viewer revamp

Feature run for `docs/PRD_VIEWER_REVAMP.md`: the Projects viewer rebuilt as an operator's desk with state colour, two looks behind a switch, a project rail, searchable and filterable lists, phase-grouped activity and findings as cards. The `shell` lane owns the tokens, the primitives, the header switch, Runs home and the lists; the `pages` lane owns the run page and the node pages. Reviewed by `general` and `coverage`; observed by the review sidecar (its first live run). The mockup the operator compares against is the "Projects Viewer Revamp" artifact.

Launch from md-manager's main checkout on `feature/viewer-revamp` (clean), in a Herdr pane:

```
WORKFLOW_WORKER_EFFORT=medium DISABLE_AUTOUPDATER=1 .venv/bin/python -m workflow launch viewer-revamp --live --automatic --worker-timeout-seconds 14400 --review-timeout-seconds 3600 --worker-model claude-opus-5-5 --judge-model claude-opus-5-5
```

Run branches are `feature/viewer-revamp-runs/<run>` (a run branch cannot sit under the source branch name). Approval fast-forwards the run branch; the operator fast-forwards `feature/viewer-revamp` and reviews it before any merge into `feature/viewer-ux` or `main`.
