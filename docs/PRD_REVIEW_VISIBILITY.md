# PRD: Review Visibility and Run Inputs (umbrella)

Status: Draft for approval — split into three vertical slices on 2026-09-21 after the first live automatic run (project-workflows-001). Each slice has its own PRD and ships on its own.

## 1. Problem

The first live run reached a verified feature branch, but the Projects viewer cannot show why the reviewer let it through or what the workers were asked to build, and the reviewer itself runs headless with no pane to watch.

- The reviewer's verdict and six findings exist only in `review.json`. The viewer's review node shows "No result has been published" and "No session recorded", because the projects contract has no result type for a review and the adapter drops `values.review`.
- The reviewer runs as `claude --print` with no Herdr pane, unlike the two workers.
- The run's inputs are not shown: task text, owned paths, checks, handoff and completion files, launch receipts, deadlines.

## 2. Slices

| Slice | PRD | Kind of work | Ships as | Depends on |
| --- | --- | --- | --- | --- |
| A. Reviewer as an attachable native session | [PRD_REVIEWER_PANE.md](PRD_REVIEWER_PANE.md) | controller (`workflow/`) + completion schema (`contracts/workflow/`) + docs | ordinary commit with offline tests and a controlled live smoke test | nothing |
| B. Review verdict and findings in the viewer | [PRD_REVIEW_RESULT.md](PRD_REVIEW_RESULT.md) | contract 1.1.0 + export + feature run `review-result` | feature run | A on `main` by choice: B's run then exercises the reviewer pane live. Displaying persisted review results does not technically require A |
| C. Run inputs and finding-to-task links | [PRD_RUN_INPUTS.md](PRD_RUN_INPUTS.md) | contract 1.2.0 + export + feature run `run-inputs` | feature run | B merged |

Order: A, then B's run, then C's run. Two runs cost two rounds of `npm ci` and two reviews, but each run has a smaller, focused diff and a blocked run loses one slice, not all three.

## 3. Non-goals across all slices

- No launch, approve or retry controls in the viewer. It stays read-only.
- No change to the reviewer's authority or to how findings gate integration.
- No live streaming of transcripts into the viewer. The Herdr pane is the live view.

## 4. Decisions log

- [x] Reviewer gets the same session interaction and lifecycle as workers (pane, human input, completion protocol, automatic wait, resumable transcript) with restricted reviewer tools: Read, Glob, Grep only (slice A)
- [x] One review per bundle, no retry (slice A)
- [x] Findings carry `worker` and `requirement` from slice A onward; the link is built in slice C
- [x] `workflow export <run>` re-exports old runs so project-workflows-001 shows its own data (slice B)
- [x] Issues #4, #5, #7, #8 stay out of all three slices
- [ ] Task display: exact prompt (proposed) or authored file (slice C)
- [ ] Three-pane layout: same tab at review start (proposed) or separate tab (slice A)
- [x] Issues #3 and #6 stay out of slice B by default; either rides along only if it blocks a named acceptance scenario, and none currently does
