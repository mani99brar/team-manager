# Decisions: attention-notify

From the grill session of 2026-10-07 with the operator. The feature is the first step the idea review of 2026-10-06 ("Agents push a message when they need me", `agent-workflow/ideas.md`) settled on: a reader of the controller's `attention.jsonl` that pushes each new record to the operator through the notify command already in use.

## Operator decisions

- [O1] Q1: all three limits hold. The controller's `attention.jsonl` is the only source (no worker gets its own push command); delivery is agent-workflow's existing notify script (no new channel); the viewer and the Telegram plugin are untouched. The tailer is the whole feature. Operator: "Yes, all three limits hold (recommended option)."
- [O2] Q2: the notify command is configured, not hardcoded: `~/.config/md-manager/notify.json` holds an argv; this machine's points at agent-workflow's `runner/notify.sh`. Operator: "Configured (recommended): ~/.config/md-manager/notify.json with an argv."
- [O3] Q3: a oneshot command, `python -m workflow attention-notify`, run every minute by a systemd user timer; each run reads from a saved byte offset, folds the new records per run into one message, sends, then saves the offset. Operator: "Oneshot command run every minute by a systemd user timer (recommended)."
- [O4] Q4: all ten record kinds are pushed, one line each inside the run's folded message, as `[run_id] kind: text`. Operator: "All ten kinds, one line each in the run's folded message (recommended)."
- [O5] Q5: no quiet hours, and a cap of 10 messages per hour across all runs; past the cap the rest folds into one "N more records" message at the next minute. Plus a presence flag (working or away) the operator sets, which changes the tailer's behaviour; its design is delegated to the grill ([G1]). Operator: "Any hour (no quiet hours), with the 10/hour cap. But also add a flag that says whether I am working or not (e.g. an 'away'/'working' status I can set), so the tailer can behave differently depending on it. Propose how that flag should work and what it changes."


## Grill defaults

- [G1] Presence flag (delegated by [O5]; covers where the flag lives, how it is set and what it changes). `~/.config/md-manager/presence.json` holds `{"status": "working"|"away", "since": <ISO>, "until": <ISO>|null}`. It is set by `python -m workflow presence working|away [--for 9h]` (prints the current status with no argument); `--for` sets `until`, after which the status reads `working` again, so a forgotten flag flips itself back. A missing or malformed file reads `working`. While **working**, every kind is pushed every minute as [O4] says. While **away**, only the kinds that wait on the operator are pushed at once (`question`, `pane`, `challenge_paused`, `review_blocked`, `controller_blocked`, `awaiting_approval`); the other four (`finished`, `sidecar`, `attack`, `panel`) are held in the state file and sent as one digest message when the status returns to working (set by hand or by `until` passing), so a run that needs a decision still reaches the phone, and the informational lines wait. The cap of [O5] applies in both states. The pushed message carries no presence marker.
- [G2] Message shape: title `md-manager`, body one line per record `[run_id] kind: text`, with each text cut at 300 characters and the body at 3,500 (Telegram's limit is 4,096), ending with `… and N more in the feed` when cut. Records are grouped by run in feed order, one message per run per minute.
- [G3] State: `~/.config/md-manager/attention-notify.state.json` (beside the registry, found as `attention.feed_path` finds the feed) holds the feed offset, the send timestamps of the last hour (for the cap) and the held digest lines. The offset moves only after every message of that run was sent, so a crash or a failed send repeats at the next minute and never skips. A feed shorter than the offset (truncated or replaced) is read again from the start.
- [G4] Measuring finished-to-noticed: every pushed line is appended to `~/.config/md-manager/attention-notified.jsonl` as `{at, sent_at, run_id, kind}`; "noticed" is derived later, by hand, from the run's first `--by operator` timeline event after `sent_at`. No automation of that in this feature.
- [G5] `[added, not asked]` The tailer runs the configured argv with the title and the body appended as its last two arguments, in a subprocess with a 30-second timeout, and reads no secret itself: never `state/notify.env`, never `~/.claude/channels/telegram/.env`. Unit tests use a stub command (a script that records its arguments), a temporary feed and a temporary config folder through `MD_MANAGER_PROJECTS_CONFIG`; no test sends anything.
- [G6] A missing or malformed `notify.json`, or a feed that cannot be read, prints one line to stderr and exits 2 with the offset unchanged, so `systemctl --user status` shows the unit failed. A notify command that exits non-zero or times out is printed the same way; the offset stays, the records are retried next minute, and only sent messages count toward the cap.
- [G7] The lane adds the two unit files as examples, `workflow/systemd/attention-notify.service` and `.timer` (oneshot, `OnCalendar=*-*-* *:*:00`, `Persistent=false`), and a RUNBOOK section "Attention notifications" with the install commands, the `notify.json` and `presence.json` formats and the presence command. Installing the timer, writing this machine's `notify.json` and committing the starter `CLAUDE.md` are the operator's by-hand steps after the run.
- [G8] One lane, `main`, owning `workflow` (the module `workflow/attention_notify.py`, its tests, the `__main__` dispatch, `workflow/systemd/`, `workflow/RUNBOOK.md` and `workflow/README.md`); its check is `workflow-unit` (`.venv/bin/python -m workflow.run_tests`). No browser check, no change under `server/`, `src/` or `contracts/`. The feed's format and `attention.py` are read, not changed.

## Changes after launch

None yet.

## Deferred

- The `notify.sh` call at the end of agent-workflow's `runner/night.sh`: a one-line hand edit outside this target (agent-workflow is not a Git repository).
- A push command for workers and agents (the review's "after a week of measurement" step).
- Quiet hours, and setting the presence flag from Telegram (the plugin is untouched, [O1]).
- Automated finished-to-noticed measurement from the timelines.
- A configurable allowlist of kinds, if a kind proves noisy during the pilot week.
