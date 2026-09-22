# PRD: Parallel reviewers (slice B)

Status: Proposed 2026-09-22. Umbrella: [PRD_CONFIGURABLE_WORKFLOW.md](PRD_CONFIGURABLE_WORKFLOW.md). Depends on slice A ([PRD_WORKER_LANES.md](PRD_WORKER_LANES.md)) for the lane vocabulary and the plan-driven pane layout. Ships as an ordinary commit with offline tests and a controlled live smoke test (section 8); no feature run.

## 1. Goal

A feature declares one or more reviewers, each with its own brief. The review node launches all of them over the same bundle, waits for all of them, and the run continues only when every reviewer approves and no reviewer leaves an unresolved P0 or P1. The viewer shows each reviewer's verdict and findings and the combined result.

Success: a feature with a general reviewer and a test-coverage reviewer runs both as native sessions with their own panes, both completion files are accepted, `review.json` carries the union of findings tagged by reviewer, and the review node in the viewer lists both reviewers with their verdicts.

## 2. Confirmed decisions

- Unanimous verdict. Every declared reviewer must write an accepted `approved` file. Any `blocked`, any unresolved P0/P1 from any reviewer, any rejected file, or any reviewer reaching `review_timeout_seconds` blocks the run. No advisory reviewers, no quorum.
- Findings are unioned. Each finding gains `reviewer` (the reviewer id). Duplicate findings from different reviewers are kept, not merged.
- Reviewers run in parallel, all launched by the one `review` graph node, all over the same shared `review-worktree` at the candidate commit. Their tools stay Read, Glob, Grep plus exactly one allowed write, their own completion file.
- One review per bundle per reviewer. Nothing is relaunched. A blocked run means a new run.
- Run-wide `--reviewer-transport` applies to every reviewer. No per-reviewer transport, tools or model.
- A feature file without `reviewers` declares one reviewer with id `review` and the built-in prompt. `features/project-workflows` needs no change.

## 3. Configuration

feature.json 2.1.0 adds:

```json
{
  "reviewers": [
    {"reviewer_id": "general", "prompt": "reviewers/general.md"},
    {"reviewer_id": "coverage", "prompt": "reviewers/coverage.md"}
  ]
}
```

Rules: at least one entry; ids match `^[a-z][a-z0-9-]{0,31}$`, are unique, and are not a lane id or a reserved id; prompt files exist and are non-empty. The built-in prompt moves to `workflow/prompts/review.md` and is what a custom prompt replaces; the controller appends the same blocks it appends today (bundle paths, task locations, lane vocabulary, completion protocol) to every prompt, so a custom brief only states what to look for. `prepare` pins each reviewer's id and prompt text into `plan.reviewers`, and `plan.json` without `reviewers` means the single default reviewer.

## 4. Design

| Item | Single reviewer today | Per reviewer `<id>` |
| --- | --- | --- |
| Node id in the completion file | `review` | `review-<id>`; the default reviewer keeps `review` |
| Session name | `workflow-<run>-reviewer` | `workflow-<run>-reviewer-<id>` |
| Files | `review.interactive.json`, `review.prompt.txt`, `review.launch.log`, `review.completion.json`, `review.stop.json`, `review.stdout.json`, `review.stderr.log` | `review-<id>.*` with the same suffixes; the default reviewer keeps the unprefixed names |
| Status file | `automatic-review.json` | `automatic-review-<id>.json` per reviewer, plus `automatic-review.json` holding the combined status |
| Verdict file | `review.json` | `review.json` stays the single accepted record for `approve` and the viewer: combined `verdict`, `reviewers: [{reviewer_id, session_id, verdict, accepted_at}]`, unioned `findings` each with `reviewer` |
| Bundle binding | run id, node, launch token, bundle hash, candidate | same, with a launch token per reviewer |
| Independence | reviewer UUID differs from every worker | differs from every worker and every other reviewer |
| Deadline | from the reviewer's launch | from each reviewer's own launch; the first expiry blocks the run |
| Pane | `Claude: reviewer` right of the last worker | `Claude: reviewer <id>` panes in declared order, each split right of the previous |
| Stop | identity re-checked stop after acceptance or block | every reviewer stopped after the combined decision; a stop that cannot be confirmed is retried by `automatic --live` as today |
| Interruption | resume waits for the same session | resume rebinds every reviewer receipt; a reviewer whose launch was interrupted before the receipt exists goes to `needs_reconciliation` and no other reviewer is relaunched |
| Manual mode | `review --review-file` imports one review | `review --reviewer <id> --review-file` imports one per reviewer; `approve` requires every declared reviewer imported and approved |

Decision: after the last completion file is accepted or the first block or rejection is recorded, the controller writes `review.json` with the combined verdict, then stops every reviewer. A block does not wait for the other reviewers' files; their sessions are stopped and their status files record `superseded`.

### Export 1.4.0 and projects contract 1.4.0

Additive. The `review` section gains `reviewers` (one entry per reviewer: id, transport, session id, verdict, findings, launch and acceptance times, status) and each finding in the combined list gains `reviewer`. Old exports have one reviewer named `review` and the adapter fills `reviewers` from the existing single section, so the viewer has one code path. `ReviewDetail.tsx` shows a reviewer strip (id, verdict, finding counts) above the findings table, a Reviewer column, and a filter by reviewer alongside the existing group-by-worker toggle. The `reviews/<attempt>` route is unchanged; attempt stays 1.

## 5. Work items

1. `contracts/workflow/reviewCompletion.schema.json` 1.2.0: `node_id` pattern `^review(-[a-z0-9-]{1,32})?$`; `contracts/workflow/feature.schema.json` gains `reviewers`.
2. `workflow/prompts/review.md`: the built-in brief extracted from `automatic.review_prompt`; `review_prompt(runtime, patch, reviewer)` appends the fixed blocks to any brief.
3. `automatic.py`: `launch_reviewers`, a `wait_reviews` poll over all receipts, per-reviewer status files, `_decide` over the set, combined `review.json`, stop all, print-mode fallback per reviewer.
4. `interactive.py`: reviewer launch and `attach-one --node review-<id>` per reviewer, panes in order.
5. `pipeline.py`: the review node launches the set, `check_review` validates the `reviewers` list and the `reviewer` tag on findings, manual `review --reviewer`, `approve` requires all.
6. `launch.py`: feature 2.1.0, `reviewers` validation.
7. `export_state.py` 1.4.0, `contracts/projects` 1.4.0, `server/projects.ts`, `ReviewDetail.tsx`, fixtures with a two-reviewer run and a legacy one-reviewer run.
8. Tests: every existing reviewer test runs with one and with two reviewers; interruption during the second reviewer's launch; one reviewer blocks while the other is still working; one reviewer times out; a completion file whose `node_id` names the other reviewer is rejected; two reviewers sharing a session UUID are rejected.
9. Docs: RUNBOOK review section, CHEATSHEET, feature README, an example `reviewers/` brief.

## 6. Acceptance scenarios

| Scenario id | Asserts |
| --- | --- |
| two-approve | two fake reviewers approve; `review.json` has `verdict: approved`, both entries in `reviewers`, unioned findings tagged by reviewer; the run reaches a verified branch |
| one-blocks | the second reviewer writes `blocked` while the first is still running; the run blocks, the first reviewer is stopped, its status is `superseded`, no relaunch |
| p1-anywhere | reviewer A approves, reviewer B approves with an unresolved P1; the combined verdict is `blocked` with B's raw decision kept |
| one-times-out | reviewer B never writes a file; at its deadline the run blocks with A's accepted verdict retained |
| wrong-node | a file with `node_id: review-general` in `review-coverage.completion.json` is rejected and blocks the run |
| shared-identity | two reviewer receipts with the same session UUID fail the independence check |
| interrupted-launch | the controller is interrupted after the first reviewer's `claude --bg` and before the second's; resume reconciles the first and launches nothing |
| default-reviewer | a feature without `reviewers` behaves exactly as slice A: same file names, same `review.json` shape plus a one-entry `reviewers` list |
| manual-import | `review --reviewer general --review-file a.json` then `approve` is refused until `coverage` is imported too |
| viewer-two-reviewers | a seeded two-reviewer run shows both verdicts in the reviewer strip, a Reviewer column, and filtering by reviewer; a legacy single-reviewer export shows one entry named `review` |
| panes (live) | the smoke run's tab holds one pane per reviewer to the right of the worker panes; a question typed into one pane is answered without affecting the other |

## 7. Open questions

- Whether a reviewer may be scoped to a subset of lanes (review only the `ui` diff). Out of scope now; the `requirement` lookup already names a lane, so scoping could be added to the brief without a contract change.
- Whether reviewers should see one another's findings. Default: no, independence is the point.
- Whether a blocked reviewer should let the others finish so their findings are recorded. Default: no, stop them; the retained transcripts hold whatever they found.

## 8. How to run

Offline: the workflow unit suite, contract tests and the project-workflows Playwright suite on free ports.

Live smoke, before merging: a scratch run directory holding a copy of project-workflows-001's `review-bundle.json`, `review.diff` and verification packets, as in the reviewer pane slice, with a scratch feature declaring `general` (the built-in brief) and `coverage` (a short brief asking only about test coverage). Drive the review node alone: two reviewer sessions appear in `claude agents --json` with distinct UUIDs, two panes appear, both completion files are accepted, `review.json` carries both entries, both sessions are stopped. Repeat once with `--reviewer-transport print`. The real run directory is untouched.
