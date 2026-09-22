# Adapter worker: parallel reviewers (controller, contracts, server)

Implement slice B of `docs/PRD_PARALLEL_REVIEWERS.md` (umbrella `docs/PRD_CONFIGURABLE_WORKFLOW.md`) on the controller, the contracts and the viewer's server adapter. Read the PRD's sections 2 to 5 as the specification and section 6 as the test list; section 8's live smoke test is the operator's, not yours.

## Ownership

Only edit `workflow/`, `contracts/`, `server/` and `features/project-workflows/`. The UI worker owns `src/projects/` and `tests/project-workflows/`; do not edit them. Do not edit `features/parallel-reviewers/`, package manifests, the root Playwright configuration or `docs/`. If a necessary change falls outside ownership, stop and ask the operator rather than crossing the boundary.

## Deliverables

- `contracts/workflow/reviewCompletion.schema.json` 1.2.0 (`node_id` pattern `^review(-[a-z0-9-]{1,32})?$`) and `contracts/workflow/feature.schema.json` 2.1.0 with `reviewers` exactly as PRD section 3 specifies (at least one entry; ids match `^[a-z][a-z0-9-]{0,31}$`, unique, never a lane id or a reserved id; prompt files exist and are non-empty). Earlier versions stay accepted. Update examples, README and `contract.test.ts`.
- `workflow/prompts/review.md`: the built-in brief extracted from `automatic.review_prompt`; `review_prompt(runtime, patch, reviewer)` appends the same fixed blocks (bundle paths, task locations, lane vocabulary, completion protocol) to any brief, so a custom brief only states what to look for. `prepare` pins each reviewer's id and prompt text into `plan.reviewers`; a plan without `reviewers` means the single default reviewer named `review` with today's file names.
- `automatic.py`: `launch_reviewers` over the shared `review-worktree`, a `wait_reviews` poll over every receipt with a per-reviewer deadline from its own launch, per-reviewer status files plus the combined `automatic-review.json`, `_decide` over the set (unanimous approval, any block, unresolved P0/P1, rejected file or expiry blocks), the combined `review.json` with `reviewers` and `reviewer`-tagged unioned findings, stop of every reviewer after the decision with `superseded` statuses for the rest, and the print-mode fallback per reviewer. Independence: every reviewer UUID differs from every worker and every other reviewer.
- `interactive.py`: per-reviewer launch and `attach-one --node review-<id>`, one `Claude: reviewer <id>` pane per reviewer in declared order, each split right of the previous; resume rebinds every receipt and a reviewer interrupted before its receipt exists goes to `needs_reconciliation` with nothing relaunched.
- `pipeline.py`: the review node launches the set; `check_review` validates the `reviewers` list and the `reviewer` tag on every finding; manual `review --reviewer <id> --review-file`; `approve` refused until every declared reviewer is imported and approved.
- `launch.py`: feature 2.1.0 with `reviewers` validation; 2.0.0 and 1.0.0 files keep working with the default reviewer, so `features/project-workflows` needs no change beyond an example `reviewers/` brief and a README note.
- `workflow/export_state.py` 1.4.0 and `contracts/projects` 1.4.0, additive, as PRD section 4 specifies: the `review` section gains `reviewers` (id, transport, session id, verdict, findings, launch and acceptance times, status) and each combined finding gains `reviewer`; old exports get a one-entry `reviewers` list named `review` filled by the adapter. `server/projects.ts` accepts exports 1.0.0 to 1.4.0 and serves the filled list on the unchanged `reviews/<attempt>` route. Regenerate the exported JSON schemas with `npm run contracts:export`. The UI worker builds against this description, so do not deviate from it without recording the deviation in your completion summary.
- Offline tests for every scenario in PRD section 6 that is not marked live or viewer: two-approve, one-blocks, p1-anywhere, one-times-out, wrong-node, shared-identity, interrupted-launch, default-reviewer and manual-import. Every existing reviewer test runs with one and with two reviewers.
- Docs: the RUNBOOK review section, `workflow/CHEATSHEET.md`, `features/project-workflows/README.md` and `contracts/workflow/README.md`.

## Verification

The policy runs the whole workflow unit suite with the controller interpreter, the contract tests, the existing unit suite and the build in an isolated worktree. Keep the existing tests passing. Do not run the workflow suite concurrently with a browser suite. Report checks as not executed if you could not execute them; never claim success from inspection.

No new dependencies or changes to global permission settings are authorized. Manual mode disables shell tools; automatic mode grants run-scoped permission bypass and Bash access. The trusted verifier independently runs your checks after handoff.

## Finish

Report a summary, all changed files, checks actually executed (or explicitly none), any deviation from the contract shapes in the PRD, and open assumptions. In manual mode wait for the operator to freeze. In automatic mode follow the appended completion-file protocol and finish your turn without waiting for a human. Do not commit, push, merge, launch other agents or write outside your own worktree.
