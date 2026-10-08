# PRD: Accepted by the operator (an operator-override run outcome)

Source: docs/BACKLOG.md item 1 (added 2026-10-06). Decisions: `features/accept-override/decisions.md` (they win over this file).

## Problem

agent-memory's `shared-memory` feature shipped through six runs (shared-memory-001 to -006). The last candidate, `89b1032`, was verified and approved by `general`; `coverage` blocked it on one fail-safe P1, and the operator merged it into `main` by hand. The workflow has no record of that: the Projects viewer shows all six runs as cancelled with review failed, and `workflow ledger` reports `89b1032` as unreviewed code on `main`. Any time the operator ships over a minor block, the record says the feature failed.

## What

```bash
python -m workflow accept <run> --candidate <sha> --reason "<why>" --by operator
```

records that the operator merged a blocked (or abandoned) run's candidate, and why. Operator only: `--by maintainer` is refused, as `approve`, `abandon` and `tryout` refuse it.

- **Record.** `<run>/accepted.json`: the candidate, the reason, the actor, the time, and the open findings at that moment (every open P0/P1/P2, verbatim from the run's review record, with severity, reviewer and title). One timeline event. The candidate must be the run's own candidate commit (`candidate.json`, or the candidate ref); the command refuses a run that integrated normally, a run with no candidate, a second accept, and a `--candidate` that is not the run's.
- **Export.** The export carries the record (a new top-level key, schema in `contracts/workflow`, export version raised); the run's outcome reads "integrated (operator override)", visibly distinct from a reviewed integration, with the reason and every open P0/P1/P2 listed. `status` and the outcome block (`workflow/outcome.py`) say it too.
- **Ledger.** `workflow ledger` and `prepare`'s `base_unreviewed` count the commit as accepted, marked as an override, so it stops being flagged as unreviewed while the override stays visible in the ledger's output.
- **Viewer.** The Projects run page and runs list show the override outcome from the export (lane `viewer`).

## Open questions (for the grill)

- May `accept` also fast-forward or merge the candidate, or only record a merge the operator did?
- Does an override need a minimum (for example at least one reviewer accepted)?
- May `accept` follow `abandon` (shared-memory-006 was abandoned before the hand merge), or does the operator accept instead of abandoning?
- How the attention record and the outcome block word it.

## Out of scope

Changing review, the fix loop or integration; any push; rewriting old runs' records beyond the one accepted run.
