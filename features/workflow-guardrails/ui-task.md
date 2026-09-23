# UI worker: workflow guardrails in the viewer (slice 2)

## Goal

An operator reading a guarded run in the Projects viewer sees the design challenge and its outcome, each worker's completion evidence and questions, and the run's decisions. Every Markdown the viewer renders from run data is inert. Implement the viewer half of slice 2 of `docs/PRD_PORTABLE_WORKFLOW.md`. Sections 4.5 to 4.8 are the specification, section 6 (slice 2, lane `ui`) is the test list, and `decisions.md` in this feature records the operator's decisions.

## Context

- Pages: `src/projects/WorkflowGraph.tsx`, `src/projects/NodeDetail.tsx`, `src/projects/WorkerInputs.tsx`, `src/projects/Assignment.tsx`, `src/projects/CreatedFiles.tsx`, `src/projects/status.ts` (`EXECUTOR_LABEL`, `executorOf`).
- Markdown: `src/document/Markdown.tsx` renders remote `https://` images as `<img>` and makes links live. Captured files already use it.
- Fixtures and seeds: `tests/project-workflows/fixtures.ts` and `seed.ts`, with the existing specs beside them. `features/project-workflows` no longer exists; the suite's README content moved into `workflow/README.md` and `workflow/RUNBOOK.md`.
- The served shape is PRD section 4.7 exactly: export 1.5.0 and run inputs `contract_version` 1.4.0, with `inputs.decisions`, `inputs.challenge`, completion `untested`, `falsifying_check`, `verify_yourself` and status `question`, `inputs.workers.<lane>.questions`, and the `challenge` node of kind `review`.

## Constraints

- Only edit `src/projects/`, `tests/project-workflows/` and `src/document/Markdown.tsx`. In `Markdown.tsx` add an opt-in inert mode; its default behaviour and every existing caller outside `src/projects/` stay unchanged. The `controller` worker owns `workflow/`, `contracts/` and `server/`; do not edit them or read its worktree. Do not edit `features/`, `docs/`, package manifests, `src/App.*` or `src/index.css`. Do not commit or push.
- Build fixtures from PRD 4.7 and from the contract as it exists in your worktree. Until the controller's contract lands, the build and the candidate-phase browser run may fail on the new fields. Report that honestly with the exact error; the controller reruns build and browser checks on the combined candidate and gates on them there.
- Keep every existing scenario passing, in particular `executor-marks`, `created-file-rendered`, `output-first-task-collapsed`, `findings-on-files`, `findings-by-reviewer`, `legacy-run` and `paths-redacted`.
- If the PRD is ambiguous, choose, record the choice as an open assumption, and keep going.

## Acceptance

- A seeded guarded run in `fixtures.ts` and `seed.ts`: a challenge node with an accepted P1 and a P2 concern, a lane with a 1.1.0 completion whose `falsifying_check` names a real check id, one answered and one waiting question, `decisions.md` with a remote image and an external link, and a captured Markdown file with the same. Keep a legacy run without any of these.
- One browser test per scenario id, each title containing `[scenario:<id>]`: `challenge-node-page`, `completion-evidence-shown`, `worker-questions-shown`, `decisions-shown`, `inert-markdown`. Each asserts what PRD section 6 lists, in both phases. `inert-markdown` fails the test on any request to a non-local host.
- Run targeted tests only: `npm run build`, and the browser spec files you added or changed (pass them to `npx --no-install playwright test --config=tests/project-workflows/playwright.config.ts <files>`) with `WORKFLOW_VERIFICATION_PHASE=worker` and with `WORKFLOW_VERIFICATION_PHASE=candidate`. Do not run the whole browser suite or `npm run test:unit`: the trusted verifier runs every policy check on your snapshot and again on the combined candidate. Report exactly what you ran, with results.

## Stop

Finish within the worker deadline. If a check keeps failing for a reason other than the controller's pending contract after three honest attempts, write the completion with status `blocked`, the exact failing command and output, and what you tried. Do not weaken a test to make it pass.
