# Controller worker: portable workflow, slice 1

## Goal

The workflow in `workflow/` can drive any git repository, and md-manager keeps working exactly as before. Implement slice 1 of `docs/PRD_PORTABLE_WORKFLOW.md`: read sections 1, 2 ("Portability" and "Trimming"), 3, 4.1, 4.2, 5 (slice 1) and 6 (slice 1) as the specification. Sections about slice 2 and slice 3 are context only; do not implement them.

## Context

- Entry point: `workflow/launch.py` (`FEATURES` tuple, `launch_commands`, `main`, which derives the repository from its own path). `workflow/pipeline.py` already accepts `--repo` for `preflight` and `prepare` and records `repository` in `plan.json`.
- Pin requirement to drop: `workflow/sessions.py:187` (`cat-file -e <revision>:contracts/workflow/workerResult.schema.json`).
- Schemas: `workflow/verification.py` `CONTRACTS` already points at the tool's own `contracts/workflow/`.
- Prompts naming "this checkout" or this repository: `workflow/automatic.py` (`completion_prompt`, `review_prompt`, `completion_protocol_prompt`) and `workflow/prompts/review.md`.
- Registry: the format is `server/projectsConfig.ts` (read it; do not edit it). The live file is `~/.config/md-manager/projects.json`; tests must never touch it, so the path is always injectable. The graph definition comes from `export_state.definition`.
- Trimming targets: `workflow/observer.py` (its `herdr` helper is imported by `interactive.py`), the standalone actions of `workflow/interactive.py`, the 1.0.0 translation in `launch.py`, the four finished feature directories, and the docs `CHEATSHEET.md`, `LIVE_SESSIONS.md`, `INTERACTIVE_SESSIONS.md`, `VALIDATION.md`, `VERIFICATION.md`.
- Tests that read the finished feature directories: `workflow/test_lanes.py`, `workflow/test_export.py`, `contracts/workflow/contract.test.ts`. Give them copies under `workflow/testdata/`.
- Reviewer briefs to bundle: `features/project-workflows/reviewers/general.md` and `coverage.md`, made generic (no md-manager paths or stack).

## Constraints

- Only edit `workflow/`, `contracts/workflow/` and the four feature directories you are deleting (`features/project-workflows`, `features/worker-lanes`, `features/parallel-reviewers`, `features/parallel-reviewers-align`). Do not edit `features/portable-workflow/`, `features/viewer-clarity/`, `features/workflow-audit/`, `docs/`, `server/`, `src/`, `tests/` or package manifests. Do not commit or push.
- md-manager compatibility: a launch without `--repo` from md-manager builds the same commands, run root and branch as today. Existing run directories under `~/.local/state/md-manager-workflows` must still `status` and `export` unchanged. Keep `carry_legacy_lanes`, the `both` attribution, the manual operator commands and `attach-one`.
- Before deleting any function in `interactive.py`, confirm nothing reachable from `python -m workflow` (including automatic panes and `start --herdr`) calls it. If something does, keep it and record that as an open assumption.
- Never write to the real registry, `~/.local/state` or `~/.config` from tests; use temporary directories.
- If the PRD is ambiguous, choose, record the choice as an open assumption in your completion summary, and keep going.

## Acceptance

- One unit or contract test per slice 1 scenario id in PRD section 6, with the id in the test name or a comment: `repo-flag`, `cwd-target`, `feature-scan`, `no-target-schema`, `md-manager-defaults`, `registry-entry`, `init-scaffold`, `builtin-briefs`, `legacy-feature-refused`, `trimmed`. Each test must fail if the behaviour were wrong: for example `no-target-schema` prepares a real temporary git target without `contracts/`.
- `contracts/workflow/examples/registry-entry.json` exists; a Python test compares the builder's output with it, and `contracts/workflow/contract.test.ts` parses it with the server's registry schema (import it from `server/projectsConfig.ts`; do not modify that file).
- `workflow/README.md` has a "Use it in another project" section, and `workflow/RUNBOOK.md` absorbs the procedures from the folded docs; no remaining reference in `workflow/` or `contracts/workflow/` points at a deleted file.
- Checks, run in this worktree before signalling completion: `.venv/bin/python -m unittest discover -s workflow -t .` (use the absolute interpreter `/home/agentops/dev/md-manager/.venv/bin/python`), `npm run test:contracts`, `npm run test:unit` and `npm run build`. Report each with its result.

## Stop

Finish within the worker deadline. If a check keeps failing after three honest attempts at a fix, or a constraint makes a required scenario impossible, stop and write the completion with status `blocked`, the exact failing command and output, and what you tried. Do not weaken a test to make it pass.
