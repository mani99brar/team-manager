# Backlog

Work for md-manager that is decided but not started. Each item becomes a feature run (`python -m workflow init <feature>`, then `/workflow-grill`) or a small direct fix, as its line says. Remove an item when it ships, citing the commit.

## 1. "Accepted by the operator": a run outcome for a candidate merged by hand

**Status:** todo. **Size:** a feature run (CLI, export, viewer, ledger). **Added:** 2026-10-06.

**Why.** agent-memory's `shared-memory` feature shipped through six runs (shared-memory-001 to -006). The last candidate, `89b1032`, was verified and approved by `general`; `coverage` blocked it on one fail-safe P1, and the operator merged it into `main` by hand ([O13] in agent-memory's `features/shared-memory/decisions.md`). The workflow has no record of that: the Projects viewer shows all six runs as cancelled with review failed, and `workflow ledger` reports `89b1032` as unreviewed code on `main`. Any time the operator ships over a minor block, the record says the feature failed.

**What.** A command such as

```bash
python -m workflow accept <run> --candidate <sha> --reason "<why>" --by operator
```

records that the operator merged a blocked (or abandoned) run's candidate, and why. Operator only (`--by maintainer` refused), like `approve`.

- **Record:** an `accepted.json` in the run directory (candidate, reason, actor, time, the open findings at that moment) and a timeline event; the candidate must be the run's own candidate commit, and the command refuses a run that integrated normally.
- **Export and viewer:** the run's outcome reads "integrated (operator override)", visibly distinct from a reviewed integration, with the reason and every open P0/P1/P2 listed.
- **Ledger:** the commit counts as accepted, marked as an override, so `base_unreviewed` stops flagging it while the override stays visible.
- **Abandoned runs:** decide whether `accept` may follow `abandon` (shared-memory-006 was abandoned before the hand merge) or whether the operator accepts instead of abandoning.

**Open questions for the grill:** may `accept` also merge (fast-forward) the candidate, or only record a merge the operator did; does an override need a minimum (for example at least one reviewer accepted); how the attention record and the outcome block word it.

## 2. Freeze: wait for a stopped session before declaring termination not established

**Status:** todo. **Size:** a small direct fix with a test. **Added:** 2026-10-06.

`stop_session` (`workflow/pipeline.py`) checks once, right after `claude stop`, whether the session is gone. A session still exiting fails the freeze as "termination is not established", a non-retryable graph failure, and `automatic --live` only repeats it (shared-memory-003). Poll the listing and the PID for a few seconds before giving up. Today's recovery, once the PID is gone: write `<run>/freeze-interrupted.json` `{"error": "<why>"}` and run `automatic --live`.

## 3. Worker prompt: end the turn without addressing the operator

**Status:** todo. **Size:** a small direct fix with a test. **Added:** 2026-10-06.

A worker whose final message ends with a request ("Your next step: run …") is listed by Claude Code as state `blocked`, and the supervisor never accepts a completion from a blocked session: the run waits for the worker deadline (shared-memory-004; `workflow note` is refused once the lane finished, so the operator must type into the pane). The worker prompt should say: put steps for the operator in `verify_yourself`, and end the final turn without asking or telling the operator to do anything.
