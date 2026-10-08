# Task: prompt

## Goal

Every automatic worker prompt (lane workers and repair sessions) tells the worker to put any step for the operator in its completion's `verify_yourself`, and to end its final turn without asking or telling the operator to do anything, so Claude Code does not list a finished worker as `blocked` and the supervisor accepts its completion (docs/BACKLOG.md item 3, shared-memory-004).

## Context

Find where the controller builds a worker's prompt and the completion protocol (`workflow/pipeline.py`, `workflow/automatic.py`, `workflow/repair.py`; search for `verify_yourself` and `CHECKS_DEFAULT`). The existing prompt tests pin its sentences; add one for the new rule.

## Constraints

Only your owned paths. Change the prompt text and its tests; no change to how completions are read or how sessions are listed. Remove item 3 from `docs/BACKLOG.md` citing "this run" (the operator fills in the commit).

## Acceptance

- A lane worker's prompt and a repair session's brief both contain the rule; a unit test asserts it for each.
- `docs/BACKLOG.md` no longer lists item 3.
- Proof: `workflow-unit`, `shared-contract` and the browser regression check `project-workflows-browser-regression` (scenarios `completion-evidence-shown` and `decisions-shown`, which this lane does not change).

Run targeted tests while iterating, then this lane's non-browser policy checks once before writing the completion. Do not run the browser suite yourself: it is a regression check the controller runs, and this lane changes no spec, so no check-report run is needed.

## Stop

Stop and report `blocked` if the prompt is built in a place outside `workflow/`.
