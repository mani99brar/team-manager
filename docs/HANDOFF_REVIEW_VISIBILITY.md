# Handoff: review visibility (PRD_REVIEW_VISIBILITY, slices A, B pre-run, C pre-run)

Date: 2026-09-21. Branch `feature-high`, worktree `~/dev/md-manager-high`. Committed as one change on 2026-09-22; the file groups under "Suggested commits" describe how it splits by slice. No feature run was launched.

## What was built

### Slice A: reviewer as an attachable native session (complete)

Controller + completion schema + docs, as the PRD scopes it.

- `contracts/workflow/v1.ts`, `examples.ts`, `contract.test.ts`, generated `reviewCompletion.schema.json`: the completion-file schema. Findings require `worker` (`ui|adapter|both|none`) and `requirement` (verbatim quote or null).
- `workflow/interactive.py`: `SESSION_NODES` adds `review`; `worktree_of`, `reconcile`, `launch` and `run_reviewer` generalise the native launcher. The reviewer launches as `claude --bg --name workflow-<run>-reviewer` in `review-worktree/` with `--tools Read,Glob,Grep,Write`, `--allowedTools "Edit(//<run>/review.completion.json)"`, `--permission-mode dontAsk`, `--add-dir <run>`, `--safe-mode`, no MCP. `attach_reviewer_pane` splits `Claude: reviewer` off the adapter pane in the run's tab; `attach_panels` and `attach-one --node review` know the third session.
- `workflow/automatic.py`: `reviewer_transport` setting (`native` default, `print` fallback; plans without the key are print-mode runs). `review_candidate` dispatches to `review_native` (launch, pane, `wait_review` poll, identity-checked stop, `finish_review`) or `review_print` (the previous headless path, now sharing `finish_review`). `read_review_completion` validates against the contract schema and binds run, bundle hash, candidate and reviewer UUID (must differ from both worker UUIDs). `review.json` is written for either verdict. `review_resumable` lets `drive` re-enter a review node that a KeyboardInterrupt left with a running reviewer.
- `workflow/pipeline.py`: `stop_session(node)` generalises `stop_workers`; stop markers gain `stopped_at`. `validate_finding` accepts findings with or without the link fields. `prepare --feature/--reviewer-transport`, preflight requires `--allowedTools`. `workflow export <run>` (slice B, see below).
- `workflow/launch.py`: `--reviewer-transport`, `--feature` passthrough, feature choices `project-workflows|review-result|run-inputs`, run id and root default from the feature.
- Docs: `workflow/RUNBOOK.md` ("Automatic review session", export note, test list), `workflow/INTERACTIVE_SESSIONS.md`, `features/project-workflows/README.md`, PRD decision logs.

Decision made during implementation (recorded in both PRDs): the reviewer gets Write allow-listed to the single completion file, because a native session has no structured-output channel and the completion file is the verdict. `dontAsk` denies every other write; worktree and evidence hashes are re-checked after the review.

### Slice B pre-run work (done; run not launched)

- `contracts/projects/v1.ts`: `reviewResult` (contract 1.1.0) with `validateReviewResult`; `examples.ts`, `contract.test.ts`, generated schema; README routes and projection rules.
- `workflow/export_state.py`: `review` section built from `review.json`, `automatic-review.json`, `review.interactive.json`, `review.diff` (transport native/print/manual, session receipt, diff hash, `reviewed_at`).
- `workflow/pipeline.py`: `export_run(directory)` and the `export` CLI action: controller lock, lightweight runtime (no session binding, so a copied run directory exports), structural review-record validation including the bundle file hash, refuses invalid plan/policy/review.
- `workflow/test_export.py`: completed run exports both sections; re-export of a 1.0.0-shaped copy through the CLI; invalid review refused; lock respected; blocked review exported; null sections; task truncation.
- `features/review-result/`: feature.json, policy.json (ten browser scenarios, no failure drill), README, ui-task.md, adapter-task.md.

### Slice C pre-run work (done; run waits for B's merge)

- `contracts/projects/v1.ts`: `runInputs`, `runInputsResponse` (contract 1.2.0), `requirement_verbatim` on review findings; validators, examples, tests, schemas, README.
- `workflow/export_state.py`: `inputs` section (feature, branch, mode, automatic settings, setup, attempt cap, per worker task text with 256 KiB truncation marker, ownership, checks, launch receipt, completion, handoff, stop marker with time). Export version is now 1.2.0.
- `features/run-inputs/`: feature.json, policy.json (fourteen scenarios), README, ui-task.md, adapter-task.md.

## Evidence

Offline, all from `~/dev/md-manager-high` with `../md-manager/.venv/bin/python` and a `node_modules` symlink to the main checkout:

| Suite | Result |
| --- | --- |
| `python -m unittest workflow.test_graph … workflow.test_automatic workflow.test_export` | 95 tests OK (baseline 70) |
| `npm run test:contracts` | 14 pass (baseline 10) |
| `npm run test:unit` | 130 pass |
| `npm run lint`, `npm run build` | clean |
| `tests/project-workflows` Playwright, worker and candidate phases | 6 + 6 pass (unchanged UI against the changed contract) |
| `workflow launch review-result --dry-run --automatic`, same for `run-inputs` | commands validate; prepare carries `--feature` and `--reviewer-transport native` |

Red before green, observed: with the native default and the old print-mode fakes, four automatic graph tests failed with "Non-retryable graph failure" until the print tests were pinned to `reviewer_transport=print` and the native fakes were written. The first re-export test failed with "Invalid worktree identity/start revision in plan" on a copied run directory, which is why `export_run` takes a directory and a lightweight runtime instead of a `Pipeline`. The first multi-process recovery run interrupted in the second controller process rather than the third; the assertion now checks one interruption and a final success rather than a fixed order.

New offline coverage for slice A: native completion accepted and session stopped; rejected file (wrong bundle hash) blocks without a second reviewer; blocked verdict recorded in `review.json`; idle without a file until the deadline, then stopped; KeyboardInterrupt during the wait leaves the reviewer running and the same run resumes; four-process recovery with one interruption mid-review; `wait_review` unit cases (timeout, file while working, foreign bindings, worker posing as reviewer, missing/blocked reviewer, stopped-reviewer recovery); reviewer launch flags and reconcile; third pane added to the tab and idempotent; `attach` with three sessions.

## Live smoke test (PRD_REVIEWER_PANE section 5)

Scratch run `~/.local/state/md-manager-workflows/smoke/review-smoke-001`: a copy of project-workflows-001's `plan.json` (paths rewritten, run id `review-smoke-001`, `reviewer_transport: native`, `feature: project-workflows`), `policy.json`, `review-bundle.json` (packet paths rewritten, packet hashes recomputed) and the four packets with their artifacts. A placeholder workflow tab with two panes was created through Herdr and recorded in `terminals.json`. The review node was driven alone (`review_candidate` under the controller lock) from a driver script. The real run directory was not touched.

### Attempt 1 (19:41, session dccd22b5): launch and pane worked, the verdict could not be written

- `claude agents --json` showed `workflow-review-smoke-001-reviewer`, kind background, cwd `review-smoke-001/review-worktree` at b5385b3, session `dccd22b5-f90a-4093-9e27-bb9c98b2d915` (distinct from both worker UUIDs), state `working` after launch.
- Timeline: "Reviewer session … launched in review-worktree; awaiting completion file" then "Reviewer pane w5:pV attached in the workflow tab". The pane's foreground process was `claude` (the attach); `terminals.json` recorded the review pane with the session UUID.
- After 513 s and 217 messages the reviewer had read the full diff, packets and screenshots and reached an approved verdict, then had its Write to `review.completion.json` denied twice ("Permission to use Write has been denied because Claude Code is running in don't ask mode"). It ended its turn asking a person to grant the permission or paste the JSON; `claude agents` reported the session as `blocked`; `wait_review` treated `blocked` as fatal, stopped the session (`review.stop.json`) and recorded `automatic-review.json` as blocked. Cost of the session: about USD 6.
- Root cause, confirmed with four print-mode probes (`--tools Read,Write --permission-mode dontAsk --permission-prompts none --add-dir <dir>`): `--allowedTools "Write(//abs/path)"` is ignored (denied, with and without `--safe-mode`); `--allowedTools "Edit(//abs/path)"` allows that one write, and a fifth probe confirmed it still denies a write to a sibling path. Write follows Edit rules.
- Fixes: `run_reviewer` now passes `Edit(//<run>/review.completion.json)`; `wait_review` treats `blocked` as a waiting state (one timeline note, keeps polling until the deadline, accepts the file in that state too). Tests updated (`test_reviewer_launches_…`, `test_blocked_reviewer_is_a_waiting_state_until_the_deadline`).

### Attempt 2 (19:53, session 5865c9a6): the whole protocol ran; the reviewer blocked the candidate

- Launch and pane as in attempt 1: session `5865c9a6-46df-4c72-9196-f717dc4819b9` in `review-worktree` at b5385b3, pane `w5:pW` attached in the workflow tab.
- After 442 s the reviewer wrote `review.completion.json` (the `Edit(//…)` rule allowed the single write). `wait_review` accepted it once the session was `done`: schema valid, run id, bundle hash `58308a53…` and candidate b5385b3 matched, `reviewer_session` equal to the launched UUID and distinct from both worker UUIDs.
- `stop_session` re-checked identity and stopped the session (`review.stop.json`, `stopped_at` 20:00:27); `claude agents --all` now lists it as `done` with no PID; the pane's foreground process is back to `bash`. Timeline: launched, pane attached, "stopped after its completion file was accepted; transcript remains resumable".
- Verdict: `blocked`, seven findings (one open P1 on reuse evidence never being emitted end-to-end, six P2). `finish_review` wrote `review.json` with the blocked verdict and raised "Independent reviewer blocked the candidate"; `automatic-review.json` is `blocked`, so a rerun would refuse to launch a second reviewer. This is the protocol working, not a smoke failure: the candidate under review is the already-merged project-workflows-001 change, and this reviewer read it more strictly than the first live run's print-mode reviewer did (that run had six P2 findings and approved). The findings are worth reading before slice B's run; the P1 concerns the same reuse-evidence gap that the first review recorded as an accepted P2.
- Every finding carried `worker` and `requirement`; 7 of 7 requirement quotes found verbatim in the named task text. This is the verbatim match rate PRD_RUN_INPUTS asks to measure before deciding on fuzzy matching.
- Not exercised: answering a reviewer question in the pane (this reviewer asked none), and a supervisor interruption during a live review (covered offline only).
- Cleanup: the scratch `review-worktree` was removed from the main repository's worktree list; the scratch run directory and the smoke tab (`Workflow: review-smoke-001`, tab `w5:tF`) are left for inspection.

## What is not done, and why

- The B and C feature runs were not launched: each is a live, multi-hour automatic run (two workers plus the reviewer) and a decision for the operator. Launch commands are in the feature READMEs.
- `workflow export` was not run on project-workflows-001: the adapter on `main` accepts export version 1.0.0 only, so re-exporting the live run before slice B's adapter merges would break the viewer for that run. Run it after B merges (PRD_REVIEW_RESULT, controller acceptance). The re-export path is tested on a copy.
- Between this change landing and B's run merging, new runs export at version 1.2.0, which the current adapter rejects for that run's listing. B's adapter task makes the adapter accept 1.x exports.
- Slice C's contract and export landed with B's, so B's adapter task tells it to ignore the `inputs` section and to accept versions up to 1.2.x. C's finding-to-task link, its viewer work and its verbatim lookup are all in C's run.
- Open PRD question left open: failing earlier than the timeout when a reviewer (or worker) idles without a file for ten minutes.

## Suggested commits

1. Slice A: `contracts/workflow/*`, `workflow/{automatic,interactive,pipeline,launch}.py` (except `export_run`), `workflow/test_{automatic,interactive,pipeline,feature_launch}.py`, `workflow/RUNBOOK.md`, `workflow/INTERACTIVE_SESSIONS.md`, `features/project-workflows/README.md`, `docs/PRD_REVIEWER_PANE.md`, `docs/PRD_REVIEW_VISIBILITY.md`.
2. Slice B pre-run: `contracts/projects/*` (reviewResult), `workflow/export_state.py` (review), `workflow/pipeline.py` (`export_run`, `export` action, `validate_review_record`), `workflow/test_export.py`, `features/review-result/`, `docs/PRD_REVIEW_RESULT.md`.
3. Slice C pre-run: `contracts/projects/*` (runInputs, requirement_verbatim), `workflow/export_state.py` (inputs), `features/run-inputs/`, `docs/PRD_RUN_INPUTS.md`.

The contract and export files are shared between 2 and 3; if separate commits matter, split `v1.ts`/`examples.ts`/`contract.test.ts` and `export_state.py` by hand along the section comments.
