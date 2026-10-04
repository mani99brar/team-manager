# Viewer UX step 5: panels and lists

Feature run for step 5 of `docs/PRD_VIEWER_UX.md` section 11: slices S4c and S6 in parallel, on file-disjoint lanes. The `panels` lane (S4c) rebuilds the review, challenge, handoff, approval and integrate node pages. The `lists` lane (S6) adds the Runs home at `/projects`, groups the project page by feature, and makes the lists, the Now banner, the copied commands and the live chip read the served `activity` and `run_dir`. Reviewed by `general` and `coverage`.

Launch from md-manager's main checkout on `feature/viewer-ux` (clean), in a new Herdr tab:

```
WORKFLOW_WORKER_EFFORT=medium DISABLE_AUTOUPDATER=1 .venv/bin/python -m workflow launch viewer-ux-panels-lists --live --by operator --automatic --worker-timeout-seconds 7200 --review-timeout-seconds 3600 --worker-model claude-opus-5-5 --judge-model claude-opus-5-5
```

Approval fast-forwards `feature/viewer-ux`. Step 6 (`features/viewer-ux-depth`) launches after that.
