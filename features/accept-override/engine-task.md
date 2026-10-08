# Task: engine

## Goal

`python -m workflow accept <run> --candidate <sha> --reason "<text>" --by operator` writes `<run>/accepted.json` and a timeline event, and the export, `status`, the outcome block and the ledger treat the run's candidate as integrated by an operator override (docs/PRD_ACCEPT_OVERRIDE.md).

## Context

Start from `workflow/tryout.py` (an operator-only command with its own record, a timeline event and a re-export) and `workflow/abandon.py` (refusals, the `cancelled` event, `abandoned()`), then `workflow/export_state.py` (EXPORT_VERSION, the top-level sections), `workflow/outcome.py`, `workflow/ledger.py` (`classify`, `base_unreviewed`) and `workflow/__main__.py`. The record's schema goes in `contracts/workflow` beside `attack.schema.json`, with an example the contract tests validate. The viewer lane reads the export key you define: state its exact shape in `docs/handoff/accept-engine.md` before you finish.

## Constraints

Only your owned paths. Do not change review, the fix loop, integration or any Git ref; `accept` reads Git and writes only inside the run directory (unless the decisions say otherwise). Older exports stay valid.

## Acceptance

- Each refusal named in the PRD exits non-zero with a message and writes nothing; a valid accept writes `accepted.json` atomically, validated against its schema, and one event.
- The export carries the record under its new key and raised version; the contract tests validate an example with and without it.
- `status` and the outcome block name the override, the reason and the open findings.
- `workflow ledger` classifies the accepted candidate as accepted (override), not unreviewed, and `base_unreviewed` no longer lists it; a unit test proves it on a temporary repository.
- `docs/handoff/accept-engine.md` names the export key and its fields.
- Proof: `workflow-unit` and `shared-contract`.

Run targeted tests while iterating, then this lane's non-browser policy checks once before writing the completion.

## Stop

Stop and report `blocked` if the ledger cannot tell an accepted candidate apart without changing how approved runs are classified, or if the export cannot carry the record without breaking an existing contract test.
