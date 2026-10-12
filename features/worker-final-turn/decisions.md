# Decisions: worker-final-turn

From the operator's choices of 2026-10-08 (pilot planning); no separate grill: BACKLOG 3 is a small direct fix.

## Operator decisions

- [O1] 2026-10-08: this fix is pilot C, run under a cgroup memory cap with the browser queue off, to exercise the memory-kill transient rule. Operator: "BACKLOG 3 under a cap (Recommended)".

## Grill defaults

- [G1] One lane `prompt` owning `workflow` and `docs/BACKLOG.md`; reviewer `general` only; design challenge off (a one-sentence prompt change). [added, not asked]
- [G2] The browser check is a regression check over the existing project-workflows suite; the lane writes no spec. [added, not asked]

## Changes after launch

None yet.

## Deferred

- Nothing.
