# Decisions: viewer-ux-panels-lists

From the grill session of 2026-09-27 with the operator.

## Decisions

- Runs home's Recent section lists every finished run of the last 7 days across all projects, newest first, with no count cap: the `lists` lane filters on `activity.finished_at` (else `updated_at`), and `runs-home` asserts a run older than 7 days is absent from Recent while it stays on its project page.
- No client fan-out fallback: the `lists` lane reads the served `activity` only. A run without `activity` shows `<Status> · updated <time>` with no finish time, no duration and no Needs-you grouping, and nothing polls per workflow or per run to reconstruct it.
- The operator's live registry will serve run directories (`viewer.expose_run_dir` for `project-b` and `md-manager`) after this run lands: the `lists` lane only reads `run_dir`; it changes no registry file outside the test harness, and its fixtures set the key in their own temp registry.

## Assumptions

- `contracts/projects/triage.ts` (`deriveNow`) and `contracts/projects/v1.ts` are read-only for both lanes; a wording or field that seems missing is recorded in the lane's handoff as a follow-up, not added.
- Needs you lists runs whose `activity.attention.kind` is `question`, `pane` or `approval`; Running lists non-terminal runs not already in Needs you; a run appears in one section only.
- Reviewer deadlines use `inputs.automatic.review_timeout_seconds` and carry `≈`; with `launched_at` null the `panels` lane shows "launch time not recorded" and no deadline.
- Both lanes keep every existing test id; new test ids follow the PRD's names where it gives one.

## Deferred

- The one-request list endpoint (PRD B4) and the evidence detail fields (B5).
- Slice S7 (Assignment reorder, review diff inline): the separate feature `viewer-ux-depth` after this run is integrated.
- Controller and exporter follow-ups C1 to C10 of PRD section 9.4.
