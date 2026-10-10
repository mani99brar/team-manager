# user-critique

A reviewer that uses the frozen candidate's running app as a user and runs the Impeccable critique; its open P0/P1 findings feed the fix loop. Specification: `docs/PRD_USER_CRITIQUE.md`. One lane, `engine`.

- `feature.json`: the lanes, their task files, the reviewers (`builtin:<id>` names a bundled brief), the `prd` the design challenge reads, `challenge` (default true) and `critical` (false; the workflow-grill skill sets it to true when you confirm the feature's code is critical, and an automatic run then stops after review for your `approve`) and `tryout` (false; set it to true for a user-facing feature: each integrated run then waits for you to try it and record `python -m workflow tryout <run> --result works|broken|skipped --by operator`, and a new tryout launch stops while 3 other features wait for theirs).
- Optional `sidecar` in `feature.json`: a review sidecar, an independent reviewer that reads the lanes' diffs and panes while they work and may message them through the controller (the workflow tool's README, section Review sidecar). Add it as `"sidecar": {"prompt": "builtin:senior-review"}`, optionally with `cadence_seconds` (default 900), `pass_timeout_seconds` (600), `max_passes` (16) and `max_messages_per_lane` (6).
- `policy.json`: each lane's owned paths and the checks the controller runs independently.
- `engine-task.md`: the lane's task as an outcome brief (## Goal, ## Acceptance and ## Stop are required).
- `decisions.md`: from the workflow-grill interview, the operator's decisions (only these bind the run), the grill's defaults, changes after launch and deferrals.

Launch: `python -m workflow launch user-critique --repo <this repository> --dry-run`, then `--live --by operator`.
