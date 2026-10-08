# Decisions: accept-override

From the grill session of 2026-10-08 with the operator.

## Operator decisions

- [O1] Q1: Correct: record only. `accept` reads Git and writes only inside the run directory; it never merges, fast-forwards or pushes, and never rewrites other runs' records (shared-memory-001..005 stay as they are). Operator: "Correct: record only (Recommended)".
- [O2] Q2: Any candidate may be accepted, with no minimum (every reviewer blocked or an open P0 still allowed); the override lists every open finding. Operator: "Any candidate; findings listed (Recommended)".
- [O3] Q3: Yes, accept may follow abandon: it is the one command an abandoned run still allows; the outcome becomes the override and the abandon reason stays as history. Operator: "Yes, accept after abandon (Recommended)".
- [O4] Q4: accept checks whether the candidate is an ancestor of the target's main; when it is not, it still records the override with `on_main: false` and prints a warning line. Operator: "Warn, record what it found (Recommended)".

## Grill defaults

- [G1] The record is `<run>/accepted.json` with `candidate`, `reason`, `by`, `accepted_at`, `on_main` and `open_findings` (each `{severity, reviewer, title}` plus the finding's lane when the review record names one); the export carries it as the top-level key `accepted` (null when absent) and raises EXPORT_VERSION by one minor version. The engine lane's handoff states the final shape and the viewer follows it.
- [G2] "The target's main" in [O4] is its `main`, else `master`, else the branch `prepare` recorded as the base; the check never fetches.
- [G3] accept writes one timeline event (node `controller`, status `succeeded`, message `Accepted by the operator: <reason>`) and resolves the run's open `review_blocked` / `controller_blocked` attention records; it writes no new attention record. [added, not asked]
- [G4] The outcome block's first line reads `integrated (operator override): <reason>`, followed by the findings open at acceptance; `status` adds `accepted` beside `abandoned`. [added, not asked]
- [G5] The ledger classifies an accepted candidate as `accepted (override)`, a class of its own: it ends `base_unreviewed` as an approved candidate does, and `workflow ledger` prints it with the run id and `override`. [added, not asked]
- [G6] Run settings for pilot A: lane `viewer` on `claude-sonnet-5-5` at medium (feature.json 2.7.0), `engine` on the run-wide worker model; launched with `--fix-rounds 2 --profile attended`. [added, not asked]

## Changes after launch

None yet.

## Deferred

- Accepting shared-memory-006 itself (a separate operator action once this lands).
- Back-filling or superseding sibling runs of an accepted feature (excluded by [O1]).
