# UI worker: review verdict and findings on the review node

Implement the viewer side of slice B in `docs/PRD_REVIEW_RESULT.md`. The payload is `reviewResult` in `contracts/projects/v1.ts` (`validateReviewResult`, `isBlockingFinding`), with a fixture in `contracts/projects/examples.ts`. Read `features/review-result/README.md` for the seeded export shape the candidate-mode tests must write. Do not redesign the runtime or change contracts, policy or package manifests.

## Ownership

Only edit the UI-owned paths in the attached policy: `src/App.tsx`, `src/App.css`, `src/graph/`, `src/projects/`, `src/index.css` and `tests/project-workflows/`. The backend owns `server/` and `config/projects.example.json`; do not edit them. If a necessary change falls outside ownership, stop and ask Pi/the operator rather than crossing the boundary. Reuse `src/document/Markdown.tsx` by import only.

## Deliverables

- `src/projects/api.ts`: `paths.review(scope, attempt)`, `fetchReviewResult(scope, path, signal)` validating with `validateReviewResult` and `run_id === scope.runId`, and `scopedReviewPath(scope, resultUri)` accepting only `${paths.run(scope)}/reviews/<positive int>`. A 404 with code `REVIEW_NOT_FOUND` is the normal "not recorded" state, not an error panel.
- When the selected node's definition kind is `review`, its Result section becomes the review panel (`data-testid="review-result"`):
  - verdict pill `review-verdict` (`Approved` / `Blocked`, reuse `.status-badge` with `status-succeeded` / `status-failed`);
  - reviewer line `review-reviewer`: the session id in `<code>` plus the transport wording ("native session", "print-mode session", "operator-supplied review");
  - bundle hash `review-bundle` (first 12 characters in `<code>`, full hash in `title`) as an `AppLink` to the `candidate` node, and the candidate commit short SHA;
  - one-line summary `review-summary`, for example `approved with 6 findings: 4 open, 2 accepted, none blocking` or `blocked with 2 findings: 1 open, 1 resolved, 1 blocking` (blocking = `isBlockingFinding`); zero findings → `approved with no findings`;
  - findings table `review-findings` grouped by disposition (`open`, `resolved`, `accepted`, in that order; each group a `<section data-disposition>` with a heading and a table whose rows carry `data-testid="finding"`, `data-severity`, `data-disposition`, `data-worker`; columns Severity, Message, Worker, Requirement; an unresolved P0/P1 row gets class `finding-blocking`; a null requirement shows "—");
  - "Diff the reviewer saw" `review-diff`: a link to `diff.uri` (new tab, `rel="noopener"`, plain text) plus the sha prefix, or "No diff artifact was recorded";
  - no review section (404 `REVIEW_NOT_FOUND`) → `<p data-testid="review-none">No review recorded for this run: either the review has not happened or the run's export predates review results (re-export it with the workflow CLI).</p>`; loading and error panels as elsewhere.
- Preserve Pi/Claude browsing, Back/Forward, existing file operations and unsaved-edit guards. Add no launch, approve, retry or delete controls.

## Browser tests and isolation

Extend `tests/project-workflows/` so that every scenario ID in `features/review-result/policy.json` appears in exactly one test title with a `screenshot:<id>` PNG attachment: the six existing scenarios plus `review-verdict`, `review-blocked`, `review-legacy` and `paths-redacted`. Keep `WORKFLOW_VERIFICATION_PHASE` semantics:

- `worker`: mock only `/api/projects/**` success responses from contract-validated fixtures; serve `.../reviews/<attempt>` (404 `REVIEW_NOT_FOUND` when absent or attempt ≠ 1) and the diff artifact as `text/plain`. Mock payloads are already the projected shape, so they carry the literal `<path>`, never a raw path.
- `candidate`: no mocked project success routes. Seed run directories with `run-state.json` version `1.2.0` carrying the `review` section (and `review.diff`) described in the feature README, plus one legacy run whose export is version `1.0.0` without the section; start the real backend and test the same scenarios against it.

Fixtures: an approved run with six findings (4 open, 2 accepted, all P2, transport `native`, reviewer `33333333-3333-4333-8333-333333333333`, a diff artifact), a blocked run (verdict blocked, one P1 open and one P2 resolved, transport `print`, review node `failed`, run `failed`), and a legacy run (integrated, export `1.0.0`, no review section although `values.review` exists). Put an absolute path under the temp root into one finding message so `paths-redacted` can assert that `<path>` appears and no `/tmp/` or `/home/` string does. Update the run-list assertion in `workflow-run-graph` for the added runs. Both phases must pass without skipping.

Pick free ports and temporary roots in the config, never reuse an existing server, clean up owned temporary directories, and do not modify the root Playwright configuration. No new package dependencies are authorized.

## Finish

Report a concise summary, complete changed-file list and open assumptions. In manual mode wait for the operator's explicit freeze. In automatic mode follow the appended completion-file protocol and finish your turn without waiting for a human. Do not commit, merge, push, spawn agents or write outside your own worktree. Do not edit shared verification fixtures/contracts to make tests pass.
