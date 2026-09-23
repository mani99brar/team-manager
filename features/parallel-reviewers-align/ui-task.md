# UI worker: align the viewer with the landed reviewers contract (follow-up to run parallel-reviewers-001)

Your base commit is the combined candidate of run `parallel-reviewers-001`: the ui lane's viewer work for slice B of
`docs/PRD_PARALLEL_REVIEWERS.md` and the adapter lane's contract, server and controller work, applied together. That run
blocked at the combined candidate because the viewer was written against an assumed reviewer-status vocabulary while the
adapter landed a different one. Fix the viewer so the combined revision builds and every browser scenario passes against
the real server. Only the `ui` lane runs in this follow-up; the contract, server and controller are fixed inputs.

## The defect, as recorded by run 001

- `npm run build` fails with `TS2367` at `src/projects/reviewers.ts` lines 48 and 49: the code compares a reviewer's
  `status` with `'timed_out'` and `'rejected'`, but the contract's `Reviewer.status` is
  `'pending' | 'accepted' | 'blocked' | 'superseded'` (`REVIEWER_STATUSES` in `contracts/projects/v1.ts`).
- The browser suite cannot even load its configuration: `tests/project-workflows/fixtures.ts` line 956 (`projectReview`)
  validates a fixture with `validateReviewResult`, which throws `ZodError: Invalid option: expected one of
  "accepted"|"blocked"|"superseded"|"pending"` for `reviewers[0].status`. The fixtures use `succeeded`,
  `needs_reconciliation`, `timed_out` and `rejected`, which the contract does not define.
- Run 001 kept the evidence under `~/.local/state/md-manager-workflows/parallel-reviewers/parallel-reviewers-001/verification/candidate/ui/1/`
  (`check-0.log` is the build, `check-2.log` the browser run). Read it, do not modify it.

## What to do

1. Read the landed contract before changing anything: `contracts/projects/v1.ts` (the `Reviewer` type, `REVIEWER_STATUSES`,
   the verdict and outcome rules in its comments), the 1.4.0 section of `contracts/projects/README.md`, how
   `server/projects.ts` projects `reviewers` from a run's export, and how `workflow/export_state.py` writes the
   `review.reviewers` section of `run-state.json`. The candidate-phase browser run seeds real run folders and reads them
   through the real server, so `tests/project-workflows/seed.ts` must write exactly the shape the server accepts.
2. Align the viewer with that contract: the status vocabulary and wording in `src/projects/reviewers.ts`, the reviewer
   strip, Reviewer column, filter and blocked-by line in `src/projects/ReviewDetail.tsx`, the mock fixtures in
   `tests/project-workflows/fixtures.ts`, the seeded runs in `tests/project-workflows/seed.ts` and the assertions in
   `tests/project-workflows/reviewers.spec.ts`. Derive "timed out", "rejected" and similar wording from the fields the
   contract does define (`status`, `verdict`, `findings`, the timestamps); do not invent status values.
3. Keep every existing scenario, including `[scenario:viewer-two-reviewers]`, and keep the three fixture runs (two
   reviewers approved, one blocked with the other superseded, a legacy single-reviewer export) meaningful under the real
   vocabulary. Do not change `contracts/`, `server/`, `workflow/` or `features/`; if the contract itself is wrong, say so
   in your completion summary as an open assumption instead of working around it.
4. Verify in this worktree before signalling completion: `npm run build`, `npm run test:unit`, and the browser suite in
   both phases as described in `features/project-workflows/README.md` (`WORKFLOW_VERIFICATION_PHASE=worker` and
   `WORKFLOW_VERIFICATION_PHASE=candidate`, the latter against a real server). Report exactly which checks you ran and
   their results; the controller reruns the build and browser checks on the combined candidate and gates on them.
