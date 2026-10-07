# Task: main

## Goal

A new command `python -m workflow attention-notify` that reads the records appended to the controller's `attention.jsonl` since its last run, folds them per run into one message each, sends every message through the notify command configured in `~/.config/md-manager/notify.json`, and saves its offset; plus `python -m workflow presence` for the operator's working/away flag, example systemd user units, and a RUNBOOK section. `decisions.md` holds every rule of the behaviour: [G1] presence, [G2] message shape, [G3] state and offset, [G4] the notified log, [G5] secrets and tests, [G6] failures and exit codes, [G7] units and docs.

## Context

- `workflow/attention.py`: the feed's format (`{at, run_id, run_dir, kind, node, text}` per line), its path (`feed_path`, beside the projects registry: `MD_MANAGER_PROJECTS_CONFIG`'s folder, else `~/.config/md-manager/`) and the ten `KINDS`. Read it; do not change it.
- `workflow/__main__.py`: how `launch`, `init` and the other subcommands are dispatched; add `attention-notify` and `presence` the same way.
- `workflow/test_attention.py`: how the existing tests isolate the feed in a temporary config folder.
- `workflow/run_tests.py`: the unit runner the verifier calls; new test classes are discovered like the others.
- `workflow/RUNBOOK.md`, section "Attention records": the reader's counterpart to document next to.
- `docs/PRD_ATTENTION_NOTIFY.md`: the specification.

## Constraints

- Standard library only, as the rest of `workflow/`.
- Nothing outside `workflow/` changes: no `server/`, `src/`, `contracts/`, no viewer, no Telegram plugin.
- The command reads no secret: it only execs the configured argv (decisions [G5]). No test sends a real notification, writes under the real `~/.config/md-manager/`, or runs `systemctl`.
- The offset moves only after every message of a run was sent (decisions [G3]).

## Acceptance

- `python -m workflow attention-notify` with three new records of two runs in a temporary feed and a stub notify command sends two messages (one per run, each line `[run_id] kind: text`), appends three lines to `attention-notified.jsonl`, and a second run sends nothing; the offset in `attention-notify.state.json` equals the feed's size.
- A notify command that exits non-zero leaves the offset unchanged and the command exits 2 with one stderr line; the next run sends the same records again. A missing or malformed `notify.json`, or an unreadable feed, does the same with no send.
- A feed shorter than the saved offset is read from the start.
- The eleventh message within a rolling hour is held; the next run sends one `N more records` message for the held lines instead; only sent messages count.
- With `presence.json` at `away`, a `question` record is sent at once and a `finished` record is held; after `python -m workflow presence working` (or `until` passing) the next run sends the held lines as one digest. `presence away --for 9h` writes `until` 9 hours ahead and `presence` prints the status; a missing file reads `working`.
- A text over 300 characters is cut, and a body over 3,500 ends with `… and N more in the feed`.
- `workflow/systemd/attention-notify.service` and `.timer` exist (oneshot, every minute, `Persistent=false`), and RUNBOOK has a section "Attention notifications" with the install commands and both file formats; `workflow/README.md`'s command table lists the two commands.
- decisions [L2] (this run's reason to exist; the restored candidate e5db4f7 already satisfies every other line): a retry never loses a record when the feed changed under it. The state identifies what was pushed by record key (`run_id`, `at`, and `kind`, `node`), never by a byte span plus a list of sent run ids; the simplest shape is fine: no saved pending batch at all, every pass reads from the offset to the end of the feed, skips the records whose key is in the pushed set, sends the rest, keeps the offset and the set while a send fails, and moves the offset and clears the set once every message went. A new test writes a failed batch of two runs, deletes the whole poison line from the feed while a later record of the already-sent run was appended, and proves the later record is sent and logged. The RUNBOOK's unstick recipe is rewritten to match (edit the offending line's text, or delete the line; never a state-file deletion) and the README row stays true.
- Unit tests for each line above, in a new `workflow/test_attention_notify.py`, pass under `python -m workflow.run_tests` with the existing suite.

Run targeted tests while iterating, then this lane's non-browser policy checks once before writing the completion.

## Stop

Stop and report `blocked` if delivering the Goal would need a change to `workflow/attention.py`'s feed format, to anything outside `workflow/`, or to a secret file; if a decision in `decisions.md` cannot hold in the code (name it); or if the existing unit suite fails before your first change.
