# Engine worker: the review sidecar in the controller (PRD_REVIEW_SIDECAR sections 3, 4.1 to 4.7, 5 items 1 to 6)

## Goal

A feature.json 2.3.0 feature can declare `sidecar`, and an automatic run of it runs an independent senior-engineering review pass beside its workers on a cadence and on every claimed completion: each pass is one read-only `claude --print` job that reads the lanes' diffs, panes and the existing ledger, returns findings, messages and a summary against `contracts/workflow/sidecar.schema.json`, and the controller merges them into `<run>/sidecar.ledger.json`, types allowed messages into the responsible lane's pane with the `answer` safety checks, records events on the `sidecar` node, runs a final pass before freeze and closes the node `succeeded` at freeze. Export 1.6.0 carries the ledger. The sidecar never blocks, pauses or approves anything, and a feature without `sidecar` runs byte-for-byte as today.

## Context

- `docs/PRD_REVIEW_SIDECAR.md` is the specification; its Appendix B pins the ledger shape the `viewer` lane builds its fixtures from, and Appendix A names the bundled brief: install `features/review-sidecar/senior-review-brief.md` as `workflow/prompts/sidecar/senior-review.md` unchanged. `decisions.md` in this feature records the operator's decisions.
- The two analogs to reuse, not copy: the design challenge in `workflow/guardrails.py` (`run_challenge`, `print_command`, `output_schema`, `validate_output`, the running marker, the worktree rules) for the read-only job, and `answer` in the same file (`deliver_answer`, `pane_attachment`, `went_on`, `question_lock`) for typing into a pane. `automatic.wait_handoffs` is where passes are scheduled; it must keep handling completions, questions and deadlines while a pass runs (a `Popen` child polled each loop, never a blocking wait).
- Reserved names live in `workflow/sessions.py` (`RESERVED_NODE_IDS`, `RESERVED_NODE_PREFIXES`), `contracts/workflow/feature.schema.json` and the docs; `server/projects.ts` has its own copy that the `viewer` lane updates.
- Tests to model on: `workflow/test_guardrails.py` (`GuardedFeature` fake print job, `AnswerDelivery` fake Herdr, `ExportSeam`), `workflow/test_automatic.py` (`GraphFixture`, faked clocks), `workflow/test_export.py` (`legacy_run`).
- The old read-only observer (`git show a3ef78d^:workflow/observer.py`) has `safe_text` for stripping escape bytes from pane text; `test_portable.py:418-428` and `test_interactive.py:278` pin that the observer module and panes stay removed, so do not bring them back.

## Constraints

- Only edit the paths your lane owns in the pinned policy: `workflow/`, `contracts/workflow/` and `docs/handoff/sidecar-engine.md`. `server/`, `contracts/projects/`, `src/`, `tests/` belong to the `viewer` lane: do not edit them or read its worktree. The ledger file and `contracts/workflow/sidecar.schema.json` are the seam: keep them to Appendix B; if a field must change, record the exact change in your handoff and in the schema's description.
- The job is read-only: `--tools Read,Glob,Grep`, no `--bg`, no Bash, structured output only, the same flags the challenge asserts. The controller writes the ledger atomically after validating it against the schema; a rejected output leaves the file byte-identical.
- Message delivery follows PRD 4.5 exactly: refused for a lane that is not launched, went on (`went_on`), has a question waiting, already got a message this pass or reached `max_messages_per_lane`, and for anything after freeze; undeliverable when the pane is unknown, closed, not showing `claude attach <id>`, or Herdr is unavailable or times out; the text typed is `[Review sidecar S-n] ` plus the text with newlines flattened; `<lane>.deadline.json` is never touched. Never type into a shell.
- Bounds are pinned in `plan.sidecar` at prepare; the final pass is the only pass allowed past `max_passes`; a run keeps at most the last eight `sidecar-inputs/<n>/` directories.
- A feature without `sidecar`, a 2.2.0 feature and every run prepared before this change keep their commands, plan keys, graph, exports (`null` section) and events; `test_guardrails.ExportSeam` moves to 1.6.0 and every other existing test stays green unchanged except where it pins the export version or the node list of a sidecar run.
- Follow the repository's conventions: no new dependency, docstring version history in `export_state.py`, the RUNBOOK and `workflow/README.md` updated (a "Review sidecar" section: files, bounds, the message rules, `sidecar-pass`, the manual-mode final pass), `contracts/workflow/README.md` for the two schemas. If the PRD is ambiguous, choose, record the choice as an open assumption in your handoff, and keep going.

## Acceptance

- `workflow/test_sidecar.py` covers PRD section 6's engine scenarios (declare, graph, pass-inputs, ledger-merge, messages, scheduling, never-blocks, freeze, worker-prompt) with a fake print job and a fake Herdr, no model calls; `test_export.py` and `test_portable.py` gain the 1.6.0 and registry cases.
- `python -m workflow init` writes a 2.3.0 feature whose README shows the `sidecar` key; `launch --dry-run` of a 2.3.0 feature with `sidecar` prints the plan's sidecar settings; the same dry run of `features/viewer-ux-depth` (2.2.0, no sidecar) is unchanged.
- Red first: run the new tests against the pre-change code and record that they fail for the right reason; then green. Write `docs/handoff/sidecar-engine.md` with what shipped, the red and green runs, every deviation from the PRD and the exact ledger example you committed.
- Run targeted tests only: `.venv/bin/python -m unittest workflow.test_sidecar workflow.test_export workflow.test_portable workflow.test_guardrails -v` and `npm run test:contracts`; run `python -m workflow.run_tests` once at the end. The verifier runs every policy check on your snapshot and on the combined candidate. Report exactly what you ran, with results.

## Stop

Finish within the worker deadline. If a check keeps failing after three honest attempts, write the completion with status `blocked`, the exact failing command and output, and what you tried. Do not weaken or delete a test to make it pass, and do not edit the other lane's paths to make yours pass.
