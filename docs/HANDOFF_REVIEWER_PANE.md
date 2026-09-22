# Slice A handoff — Reviewer as an attachable native session

Implements [PRD_REVIEWER_PANE.md](PRD_REVIEWER_PANE.md) (slice A of [PRD_REVIEW_VISIBILITY.md](PRD_REVIEW_VISIBILITY.md)) on top of `61e4752`. Controller, completion schema and docs only: no `server/` or `src/` change, so slices B and C are untouched and still need their own feature runs.

Environment: this worktree has no `node_modules` or `.venv`; commands below ran with `ln -s ../md-manager/node_modules node_modules` and the main checkout's interpreter (`../md-manager/.venv/bin/python`), which is what the repository's own `.venv/bin/python` would be.

Baseline before the change: **70 Python tests, 10 contract tests**, both green. After: **94 Python tests, 13 contract tests**, `npx tsc -b` and `npx eslint .` clean.

## What changed

| Area | Change |
|---|---|
| `contracts/workflow/v1.ts`, `examples.ts`, `reviewCompletion.schema.json` | New `reviewCompletion` message plus `validateReviewCompletion`; findings carry `worker` and `requirement` |
| `workflow/sessions.py` | `REVIEWER` node id and `file_prefix`, so the reviewer's files are `review.*` |
| `workflow/interactive.py` | `worktree()`/`receipt_path()` generalise the worker identity checks; `run_reviewer()` launches `claude --bg --name workflow-<run>-reviewer`; `attach_reviewer_pane()` adds the third pane; `attach-one --node reviewer` |
| `workflow/automatic.py` | `reviewer_transport` run setting; `wait_review`, `read_review_completion`, `native_review`, `print_review`, `resumable_review` |
| `workflow/pipeline.py` | `launch_reviewer` (receipt, events, pane), `stop_session`/`stop_reviewer`, findings with `worker`/`requirement` accepted |
| `workflow/launch.py` | `--reviewer-transport` pinned into `prepare` |
| Docs | RUNBOOK reviewer-session section and recovery entry, feature README "The reviewer pane", contract README, INTERACTIVE_SESSIONS, VALIDATION |

## Increment 1 — The completion contract

| Step | Command | Observed |
|---|---|---|
| Red | `npm run test:contracts` (new negative cases, before `v1.ts`) | `validateReviewCompletion is not a function`; the schema-drift test also failed because `reviewCompletion.schema.json` did not exist. |
| Green | `npm run contracts:export && npm run test:contracts` | **13 passed**. Covers the run/bundle/candidate bindings, an unknown field, a finding without `worker`, an empty requirement quote, a blocked verdict with no findings and an approval over an open P1. |

## Increment 2 — The reviewer session and its wait

| Step | Command | Observed |
|---|---|---|
| Red | `.venv/bin/python -m unittest workflow.test_automatic` (after the transport default flipped to native, before the controller work) | **3 errors, 1 failure**. `AttributeError: 'FakeSessions' object has no attribute 'run_reviewer'`, and the resumed controller processes exited 1 with `RuntimeError: Non-retryable graph failure`. This is the real signal that the graph now takes the native path. |
| Green | same command | **31 passed** in that module. |

Behaviour covered: a bound completion file with `worker`/`requirement`; foreign run id, launch token, bundle hash or candidate rejected; schema violations rejected; a blocked verdict with no findings and an approval over an unresolved P1 rejected; a symlinked or oversized file never read; an idle reviewer with no file timing out; a completion written while the session is still `working` not accepted; a missing or blocked session stopping rather than relaunching.

## Increment 3 — Pane, stop and interrupted-review resume

| Step | Command | Observed |
|---|---|---|
| Green | `.venv/bin/python -m unittest workflow.test_interactive` | **17 passed**: the launch command's tools (`Read,Glob,Grep,Write`, no Bash, no `--dangerously-skip-permissions`), `--permission-mode dontAsk`, `--add-dir <run>`, the candidate worktree as cwd, reconciliation without relaunch, a dirty worktree refused, the third pane in the workers' tab, its `attach-one --node reviewer` command, its idempotence, and the two refusals (no tab, unverified session). |
| Green | `.venv/bin/python -m unittest workflow.test_pipeline` | **11 passed**, including the reviewer stop: identity-checked, idempotent, recorded as `review/stopped`, and blocked when the stop fails or termination is unproven. |
| Green | `.venv/bin/python -m unittest workflow.test_automatic.AutomaticGraphTests.test_recovery_in_actual_new_controller_processes` | Four real controller processes, exit codes `[75, 130, 75, 0]`: the third step is interrupted mid-review, the reviewer receipt survives, `automatic-review.json` stays `running`, no `review.stop.json` is written, and the next process re-enters the same session (same launch token, same reviewer in `review.json`) without launching a second reviewer. |

### Mutation checks (the tests fail when the behaviour is removed)

| Removed | Result |
|---|---|
| The run/token/bundle/candidate binding in `read_review_completion` | `ReviewCompletionTests` → `AssertionError: ValueError not raised` |
| The `REVIEWER in mapping` early return in `attach_reviewer_pane` | pane test → `AssertionError: 8 != 4` (a second pane allocated) |
| The `failures == ["review"]` branch in `advance_failed_checks` | `test_only_an_interrupted_review_of_a_live_session_resumes` → failed; the four-process test still passed, because LangGraph records no task error for a `KeyboardInterrupt`. The branch is the guard for a review failure that *is* recorded, and it is now tested directly rather than only by that path. |

## Decisions and deviations worth knowing

- **Reviewer tools are `Read,Glob,Grep,Write`, not read-only.** The PRD asks for both read-only tools and a reviewer-written completion file; those are incompatible. Write is the minimum that makes the protocol work. The containment is elsewhere: no Bash, no agents, no MCP servers, and before any verdict is accepted the reviewer's worktree must still be the clean candidate commit and the bundle and diff hashes must be unchanged. `InteractiveSessions.reviewer_tools` and `reviewer_permission_mode` are single constants if the live smoke test shows `dontAsk` refuses that write; the fallback would be `--add-dir` plus a bypass mode.
- **Third pane in the same tab**, as proposed in the PRD and confirmed by the operator. It is created when the review node starts, not at `start`, so it is `attach_reviewer_pane`, not `attach_panels`. A run with no Herdr tab records `review/detached` and continues unattended.
- **`reviewer_transport` is pinned into `plan.json`** by `prepare`, like the deadlines, so a resumed controller cannot change transport mid-run. Plans prepared before this slice have no key and default to `native`.
- **A deadline does not stop the reviewer.** Workers are stopped when their deadline expires because they keep consuming usage; an idle reviewer does not, and stopping it is left to the operator, as for any unfinished session.
- Findings keep `worker` and `requirement` optional in `Pipeline.validate_review`, so `project-workflows-001`'s existing `review.json` still validates.

## Not done

- **The controlled live smoke test (PRD section 5) has not been run.** Nothing here has talked to a real Claude session: the pane, the `--bg` launch, `dontAsk` plus a write into an `--add-dir` path, and a real model's compliance with the completion protocol are all still unproven. That test is the gate the PRD sets before merging, and it needs an operator in Herdr.
- Slice A's second open question (failing earlier than the timeout when a session is idle with no file) is left open for workers and reviewer together, as the PRD asks.
