# Viewer UX step 6: depth

Feature run for step 6 of `docs/PRD_VIEWER_UX.md` section 11: slice S7. The `depth` lane reorders the Assignment tab (summary line, lanes table, decisions collapsed, folded ownership JSON) and shows the review diff inline per file with A/M/D marks and +/- counts. Client only; the optional backend fields B4 and B5 are out of scope. Reviewed by `general` and `coverage`.

Launch after step 5 (`features/viewer-ux-panels-lists`) is integrated, from md-manager's main checkout on `feature/viewer-ux` (clean), in a new Herdr tab:

```
WORKFLOW_WORKER_EFFORT=medium DISABLE_AUTOUPDATER=1 .venv/bin/python -m workflow launch viewer-ux-depth --live --automatic --worker-timeout-seconds 7200 --review-timeout-seconds 3600 --worker-model claude-opus-5-5 --judge-model claude-opus-5-5
```
