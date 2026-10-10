# Task: engine

## Goal

`python -m workflow accept <run> --candidate <sha> --reason "<text>" --by operator` writes `<run>/accepted.json` and a timeline event, and the export, `status`, the outcome block and the ledger treat the run's candidate as integrated by an operator override (docs/PRD_ACCEPT_OVERRIDE.md).

## Context

Follow-up run accept-override-003 ([L15]). Run accept-override-002 passed review (candidate 6ac7f5c, approved with P2s) but no longer merges: main moved (the Signal Box run page, the Runs home, the user-critique merge at 7d270a4). This run starts from main 7d270a4 and re-applies 002's reviewed engine behavior. The controller restores your owned paths from 47409f3 (`--restore-from`): 002's engine merged into main 7d270a4 in a scratch worktree, where the conflicting engine files were resolved by hand (export version, `accept` in `OPERATOR_ONLY`, the README and RUNBOOK rows, the version asserts of the other tests). In that scratch tree the whole `workflow.run_tests` suite and `npm run test:contracts` passed.

Do not rebuild what passed. Your job is to confirm the restored lane works on this base and fix only what does not:

- The export version is exactly "1.12.0" ([L15] amends [L1]): main is already at 1.11.0 (the fix loop at 1.10.0, the critique evidence at 1.11.0), and `accepted` is the one new key. `docs/handoff/accept-engine.md` and `accept.py`'s docstring say 1.12.0; check that no other file still says 1.10.0 for it.
- Main added session records since 002 (the critique reviewer, the attack pass). `accept.live_nodes` takes its nodes from `abandon.recorded_nodes`; check that a session recorded by those stages is listed the way `abandon` lists it, and add a test only if one is missing.
- `OPERATOR_ONLY` holds `accept`; `PANEL_ACTIONS` (main) does not, so `--by panel` is refused. Keep it so.
- Keep main's text in `workflow/README.md` and `workflow/RUNBOOK.md` (the panel actor, the critique reviewer); the restore carries only the `accept` additions on top.

002's open engine P2s (test gaps: the export-failure paths, the locks, the record-only guarantee, [O2]/[O3]/[O4] end to end) are not part of this run unless a check fails on them; they are listed in 002's review.json.

## Constraints

Only your owned paths. Do not change review, the fix loop, integration or any Git ref; `accept` reads Git and writes only inside the run directory (unless the decisions say otherwise). Older exports stay valid.

## Acceptance

- [L13] (b), (c) and (e) are the engine's: abandon refuses an accepted run, accept is operator-only and refuses while a recorded session is live, the ledger's CLASSES and wording name the override.
- The record, the export key and the schema follow [L8] exactly (contracts/workflow/accepted.schema.json and an example, [L10]); the ledger order and anchor follow [L9]; attention and the guards follow [L11].
- Each refusal named in the PRD exits non-zero with a message and writes nothing; a valid accept writes `accepted.json` atomically, validated against its schema, and one event.
- The export carries the record under the top-level key `accepted` and EXPORT_VERSION is exactly "1.12.0" ([L1], [L15]); the contract tests validate an example with and without it.
- The candidate is `brief.candidate_commit` ([L3]); the open findings and their rules follow [L5]; accept takes the locks and closes the run to mutating commands ([L6]); the ledger handles a run with no review.json ([L4]). Each has a unit test.
- `status` and the outcome block name the override, the reason and the open findings.
- `workflow ledger` classifies the accepted candidate as accepted (override), not unreviewed, and `base_unreviewed` no longer lists it; a unit test proves it on a temporary repository.
- `docs/handoff/accept-engine.md` names the export key and its fields.
- Proof: `workflow-unit` and `shared-contract`.

Run targeted tests while iterating, then this lane's non-browser policy checks once before writing the completion.

## Stop

Stop and report `blocked` if the ledger cannot tell an accepted candidate apart without changing how approved runs are classified, or if the export cannot carry the record without breaking an existing contract test.
