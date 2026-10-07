# PRD: Attention notifications

Status: specification for feature `attention-notify` (2026-10-07). Decisions: `features/attention-notify/decisions.md`.

## 1. Problem

Every controller appends one line to `attention.jsonl` (beside the projects registry, `workflow/attention.py`) when a run reaches a state that needs the operator: a question, a blocked pane, a paused design challenge, a blocked review or controller, a sidecar escalation, an approval stop, an attack or panel result, or the end of the run. Nothing reads that feed. The operator finds out when they next look at a pane, and the learnings record waits of hours as the largest time loss in the runs.

## 2. Outcome

A oneshot command, run every minute by a systemd user timer, that pushes each new record of the feed to the operator through the notify command already in use, and a presence flag the operator sets so the command knows whether to push everything or only what waits on them.

## 3. Behaviour

- `python -m workflow attention-notify`: reads the feed from a saved byte offset, groups the new records by run, sends one message per run (`[run_id] kind: text`, one line per record) through the argv in `~/.config/md-manager/notify.json` with the title and the body appended as the last two arguments, logs each pushed record to `attention-notified.jsonl`, then saves the offset. All ten kinds are pushed. At most 10 messages per rolling hour; past that, the held lines go as one "N more records" message at a later run. A feed shorter than the offset is read from the start.
- `python -m workflow presence [working|away] [--for <duration>]`: reads or writes `~/.config/md-manager/presence.json`. While away, only `question`, `pane`, `challenge_paused`, `review_blocked`, `controller_blocked` and `awaiting_approval` are pushed at once; `finished`, `sidecar`, `attack` and `panel` are held and sent as one digest when the status returns to working. `--for` sets an expiry after which the status reads working.
- Failures (no or malformed config, unreadable feed, a notify command that fails or times out after 30 s) print one line to stderr and exit 2 with the offset unchanged.
- The command reads no secret file. Delivery, the channels and their tokens stay in the configured command (on this machine, agent-workflow's `runner/notify.sh`).

## 4. Out of scope

A push command for workers or agents; a new channel; changes to the viewer or the Telegram plugin; quiet hours; setting presence from Telegram; automated measurement of finished-to-noticed time (the notified log is the raw material for a by-hand measurement after a week).

## 5. Files

`workflow/attention_notify.py`, `workflow/test_attention_notify.py`, the dispatch in `workflow/__main__.py`, `workflow/systemd/attention-notify.service` and `.timer`, a RUNBOOK section "Attention notifications", two rows in `workflow/README.md`'s command table.
