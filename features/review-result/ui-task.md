# UI worker: review verdict and findings on the review node

Extend the existing Projects viewer (`src/projects/`) so the review node of a run shows the recorded independent review. The contract is `contracts/projects/README.md` (`reviewResult`, contract 1.1.0, `contracts/projects/examples.ts`). Read `features/review-result/README.md` for the export seam and the seeded-data rules, and `features/project-workflows/README.md` for everything unchanged. Do not redesign the runtime or change contracts, policy or package manifests.

## Ownership

Only edit `src/App.tsx`, `src/App.css`, `src/graph/`, `src/projects/`, `src/index.css` and `tests/project-workflows/`. The backend owns `server/` and `config/projects.example.json`. If a necessary change falls outside ownership, stop and report it rather than crossing the boundary. No new package dependencies.

## Deliverables

- When the review node's `result_uri` is set and starts with the run's own `/reviews/` route, fetch it and validate with `validateReviewResult` before rendering. Any other `result_uri` on a review node is a malformed payload, not something to fetch.
- Findings panel on the review node:
  - verdict pill (`approved` / `blocked`), the reviewer session (`reviewer_session`), the transport, `reviewed_at`;
  - the bundle hash, rendered as a link that selects the candidate node of the same run;
  - one summary line, for example "approved with 6 findings: 4 open, 2 accepted, none blocking" (blocking = P0/P1 not resolved);
  - a findings table grouped by disposition (`open`, `accepted`, `resolved`), each row with severity, message, and the `worker` / `requirement` fields when present (show them plainly; the link to the task is slice C);
  - a "Diff the reviewer saw" link to `diff_artifact.uri` when it is set and it is within the run's own artifacts route; text artifacts already have an on-demand viewer, reuse it.
- Review node with no `result_uri` (legacy run or review not reached): show "No review recorded for this run" as an explicit state, not an error and not a loading spinner.
- A blocked review: verdict `blocked`, the node status the snapshot reports (failed), and the findings that caused it, without implying the run completed.
- Keep every existing view, keyboard access and narrow-screen layout working. No launch, approve, retry or delete controls.

## Browser tests

Extend `tests/project-workflows/` (your config, fixtures, mock, seed and spec). The policy pins ten scenario IDs: the six existing ones (which must keep passing unchanged in meaning) and `review-verdict`, `review-blocked`, `review-legacy`, `paths-redacted`. Each ID appears in exactly one test title with one `screenshot:<id>` PNG attachment, as before.

- `WORKFLOW_VERIFICATION_PHASE=worker`: mock only `/api/projects/**`; add the reviews route with contract-shaped fixtures (an approved review with six findings including `worker`/`requirement` values and nulls, a blocked review with an open P0, and a run whose review node has `result_uri: null`).
- `WORKFLOW_VERIFICATION_PHASE=candidate`: seed run directories in `tests/project-workflows/seed.ts` with `run-state.json` at version `1.2.0` carrying the `review` section exactly as documented in the feature README (`inputs: null`), a `review.diff` file whose SHA-256 matches, and one run with `"review": null`. Do not mock project success responses; the real adapter serves them.
- `paths-redacted`: the seeded review messages and requirement quotes contain absolute paths under the temporary root; assert that no such path appears in the rendered review.

Report checks as not executed if you could not execute them. Never weaken or skip a required scenario.

## Finish

Report a concise summary, the complete changed-file list and open assumptions, then follow the appended completion-file protocol and finish your turn. Do not commit, merge, push, spawn agents or write outside your own worktree.
