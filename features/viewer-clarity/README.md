# Viewer clarity

Feature run for `docs/PRD_VIEWER_CLARITY.md`: the `adapter` lane captures a lane's created and changed text files as `file` artifacts at freeze and serves them; the `ui` lane marks agent versus controller nodes on the graph, renders captured files with the reviewers' findings on them, puts a worker node's output before its task, splits the launch and verify pages, and groups findings by reviewer by default. Reviewed by `general` and `coverage`.

Run 1 (native reviewers, panes): `python -m workflow launch viewer-clarity --live --automatic --worker-timeout-seconds 5400 --review-timeout-seconds 3600`.
Run 2 (print transport, PRD_PARALLEL_REVIEWERS section 8): `python -m workflow launch viewer-clarity --live --automatic --run-id viewer-clarity-002 --reviewer-transport print --worker-timeout-seconds 5400 --review-timeout-seconds 3600`.
