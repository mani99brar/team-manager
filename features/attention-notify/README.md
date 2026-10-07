# attention-notify

Why: waiting is the largest time loss in the runs (agent-workflow `runs/learnings/LEARNINGS.md`, learning 1), and nothing reads `attention.jsonl`, the feed every controller writes when a run needs the operator. This feature is the first step the idea review of 2026-10-06 settled on ("Agents push a message when they need me", `agent-workflow/ideas.md`): a oneshot tailer run every minute that pushes each new record through the notify command already in use. Specification: `docs/PRD_ATTENTION_NOTIFY.md`; the operator's decisions: `decisions.md` (grill of 2026-10-07).

- `feature.json`: one lane `main`, the bundled `general` and `coverage` reviewers, the `prd`, `critical: false`, `tryout: false`.
- `policy.json`: the lane owns `workflow`; its check is the workflow unit suite.
- `main-task.md`: the lane's task as an outcome brief.
- `decisions.md`: from the workflow-grill interview, the operator's decisions (only these bind the run), the grill's defaults, changes after launch and deferrals.

Launch: `python -m workflow launch attention-notify --repo <this repository> --dry-run`, then `--live --automatic --by operator`.

After the run, by hand: write `~/.config/md-manager/notify.json`, install the timer (RUNBOOK "Attention notifications"), and add one `notify.sh` call at the end of agent-workflow's `runner/night.sh`.
