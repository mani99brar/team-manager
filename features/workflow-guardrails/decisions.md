# Decisions: workflow guardrails (slice 2)

From the grill session of 2026-09-23 with the operator.

## Decisions

- Outcome briefs are enforced with required headings `## Goal`, `## Acceptance` and `## Stop`; Context, Constraints and Process are optional.
- The interview happens before launch through the `workflow-grill` skill, which writes this file; workers may also ask mid-run with a `question` completion, at most three per worker, with that worker's deadline paused and answers given by `workflow answer`.
- A pre-implementation challenge node runs before any worker. A P0 or P1 pauses the run; `resume` re-pins the edited feature files, and `--accept-challenge` records an override with a reason.
- Completion 1.1.0 requires `untested`, `falsifying_check` and `verify_yourself`. Which commands ran stays the verifier's evidence.
- The guardrails apply to `feature.json` 2.2.0. md-manager's 2.1.0 features keep working, with a migration note.

## Assumptions

- Answers reach a worker by typing into its Herdr pane; without Herdr, the operator types them after `claude attach`.
- The challenge reads the PRD named by `prd` in `feature.json`, the lane tasks and this file, and nothing else it is told about.

## Deferred

- Reusing worker-phase check results at the candidate phase for single-lane runs: its own slice after this one.
- A structured file and line location on review findings.
