# Controller worker: workflow guardrails (slice 2)

## Goal

A feature at `feature.json` 2.2.0 can only run when its tasks are outcome briefs and its decisions are written down. It is challenged before any worker starts, and its workers finish with evidence of what would prove them wrong, or ask a bounded question instead of guessing. Implement the controller half of slice 2 of `docs/PRD_PORTABLE_WORKFLOW.md`. Sections 2 ("Guardrails"), 3 and 4.3 to 4.7 are the specification, section 6 (slice 2, lanes `controller`) is the test list, and `decisions.md` in this feature records the operator's decisions.

## Context

- Launch and validation: `workflow/launch.py`, `workflow/scaffold.py`, `contracts/workflow/feature.schema.json`.
- Prompts and completion handling: `workflow/automatic.py` (`completion_prompt`, `read_completion`, `wait_handoffs`, `review_prompt`, `_review_print`, the print-job runner to reuse for the challenge).
- Plan and graph: `workflow/sessions.py` (`prepare`), `workflow/pipeline.py` (`start`, the CLI actions, `graph_nodes` use), `workflow/export_state.py` (`graph_nodes`, `definition`, `completion_signal`, `worker_inputs`, `inputs_section`, `EXPORT_VERSION`).
- Herdr delivery: `workflow/herdr.py`. Pane ids per node are in the run's `terminals.json`.
- Served contract: `contracts/projects/v1.ts` (`runInputWorkerSchema`, `runInputsSchema`, the inputs section), `contracts/projects/README.md`, `contracts/projects/examples.ts`, `server/projects.ts`, `server/projects.test.ts`.
- The tests run in parallel by class (`python -m workflow.run_tests`); keep new test classes independent of each other.

## Constraints

- Only edit `workflow/`, `contracts/` and `server/`. The `ui` worker owns `src/projects/`, `tests/project-workflows/` and `src/document/Markdown.tsx`; do not edit them. Do not edit `features/`, `docs/` or package manifests. Do not commit or push.
- Build the served shape exactly as PRD section 4.7 pins it; the `ui` lane is building fixtures from that paragraph at the same time. Do not read the `ui` lane's worktree.
- 2.1.0 features and every existing run directory keep working unchanged: same commands, same graph and no guardrail refusals, apart from the migration note.
- The challenge and the questions must never launch a worker session before the challenge is `passed`, `accepted` or `disabled`. Keep the existing identity, deadline and single-launch guarantees.
- Tests never call Claude, never touch `~/.config`, `~/.local/state` or the real registry, and never talk to the real Herdr; use the existing fakes.
- If the PRD is ambiguous, choose, record the choice as an open assumption, and keep going.

## Acceptance

- One test per controller scenario id in PRD section 6 (slice 2): `brief-headings`, `decisions-required`, `challenge-passes`, `challenge-pauses`, `completion-evidence`, `worker-question`, `export-seam`, `served-inputs`, with the id in the test name or a comment. Each must fail if the behaviour were wrong.
- `workflow init` writes a 2.2.0 feature with a `decisions.md` placeholder and brief-form tasks, and the placeholder refusal still names every placeholder.
- `workflow/skills/workflow-grill/SKILL.md` exists with valid skill frontmatter (`name`, `description`) and follows PRD 4.4; the README says how to link it into `~/.claude/skills/`.
- README and RUNBOOK describe 2.2.0, the challenge (pause, `resume`, `--accept-challenge`), `workflow answer`, completion 1.1.0 and the export 1.5.0 fields.
- Run every check in this worktree before signalling completion: `/home/agentops/dev/md-manager/.venv/bin/python -m workflow.run_tests`, `npm run test:contracts`, `npx tsx --test server/projects.test.ts`, `npm run test:unit`, `npm run build`. While iterating, run only the affected test modules; run the full suite once at the end. Report each check with its result.

## Stop

Finish within the worker deadline. If a check keeps failing after three honest attempts at a fix, or a constraint makes a scenario impossible, write the completion with status `blocked`, the exact failing command and output, and what you tried. Do not weaken a test to make it pass.
