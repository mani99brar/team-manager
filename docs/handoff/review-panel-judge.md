# Handoff: the judge lane of review-panel-registry (step 1)

Lane `judge` of run review-panel-registry-001. Spec: `features/review-panel-registry/prd.md` 7.2-7.6, 9 and Appendix A/B; decisions [O7], [O9], [G9]-[G11], [G13], [G21], [G22], [G24], [L1]-[L8]. Operator reference: RUNBOOK "Judged review panel (feature.json 2.11.0)" and the judged-run sentences in "Automatic mode: the review step".

## What I built

- **`workflow/judge.py`** (new):
  - `judged(plan)` is the Appendix A port. It returns the plan's panel item with `report_only: false`, else None.
  - `run(runtime, panel_item, seats, reviewers, *, clock, sleep)` is the judge job. It numbers the findings (`<reviewer_id>-<n>`, plus the seats' own ids), builds the input (the brief, the findings as JSON lines, then the diff, the PRD copy, decisions.md and the requirement docs), cuts the documents to the 600 KB cap (the requirements keep at least half the room after the findings, the diff the rest; a document with no room is named in an `=== omitted: ... ===` line), and refuses the job when the findings alone are over the cap.
  - The job is a read-only print job: `automatic.print_command`, `--effort high`, the pinned model, `--max-budget-usd`. It runs in its own `review-judge-*` worktree with the input on stdin, under a timeout and with an orphan kill on rerun. `judge-<n>.pid` is persisted (worktree, cwd, marker, `pid: null`) before the worktree is added, and the pid is added after launch. A controller crash anywhere in between still leaves the rerun's `kill_orphan` the worktree to remove and the marker to find the job by in `/proc` (lane-review P1, repair 2).
  - `check` applies the output checks: the [G32] completeness check, the evidence rule, `J<n>`, and `worker` from the selected lanes' owned paths.
  - `unjudged` records a failed judge when `panel.settle` raised.
  - The review.json helpers are `verdict`, `message` and `review_findings`.
  - The record is written only through `panel.record_judge`. Nothing raises except `KeyboardInterrupt` and `TransientInfraError`.
- **`workflow/automatic.py`**:
  - `wait_reviews(..., judged=False)` and `collect_print(..., judged=False)` take a judged mode: no early decision, no grace, failures recorded, and the first failure raised only when there is no verdict at all.
  - On a judged print run, a reviewer whose job fails to launch (a non-transient `popen_claude` error) is recorded like a failed job (`blocked`, `Reviewer <id> launch failed: ...`, one `note`), and the other jobs are launched and collected (`collect_print(..., launch_failed=)`). A `TransientInfraError` still ends the step resumable, and a run that is not judged still stops at the first failed launch (lane-review repair, run 008).
  - `judge_outcome` reuses a terminal judge record, or calls `panel.settle` and then `judge.run`, and writes the timeline notes.
  - `combined_review` and `_decide` take an optional judge object. When it ruled: the `judge` entry, the confirmed rulings as findings, the judged blocked event and error, and the built-in statuses left `accepted`. When it fell back: today's code path, unchanged.
  - `_accept_native` and `_review_print` call all of this only when `judged_panel(plan)` is not None.
  - `review_archive` also moves `$RUN/judge/`.
- **`workflow/pipeline.py`**:
  - `check_reviewers` and `check_review` gain an optional keyword `judged=False`, so existing calls are unchanged.
  - `Pipeline.validate_review` (integrate, approve and the step's own check) and `ExportRuntime` pass `judge.judged(self.plan) is not None` ([L3]). A record listing the reserved `judge` without that context is refused.
- **`workflow/sessions.py`**: `RESERVED_REVIEWER_IDS = {"judge"}`, checked by `validate_reviewer_id`, so launch (`launch.py:213`, unchanged) and prepare refuse a reviewer `judge`. A lane may still be called `judge`.
- **`workflow/prompts/judge.md`**: the brief covers the grouping by meaning, the three rulings, the evidence rule, the base-scope rule ([G29]: an untouched file alone does not make a defect pre-existing), the severity rule (a test gap is P2 unless the PRD names the test), equal weight for every source, and repository text as data.
- **Tests**:
  - `workflow/test_judge.py`, with the fakes and goldens in `workflow/testdata/judge/`.
  - Named tests in `test_sessions.py` (`ReservedReviewerIdTests`), `test_accept.py` (`JudgedIntegrateTests`) and `test_export.py` (`JudgedReviewExportTests`).
  - The frozen examples and the PRD are copied byte for byte into `testdata/judge/feature/`, because feature folders are deleted once a feature finishes. `FrozenCopyTests` pins the copies while the folder exists.
- **The 2.10.0 regression** (`NoJudgedPanelRegressionTests`):
  - The goldens `testdata/judge/regression-*.golden.json` were recorded from the controller *before* this lane's change (`JUDGE_RECORD_GOLDEN=1`, on the untouched checkout). They cover review.json, panel.json and the export's review and panels sections of a two-reviewer run with a real report-only panel (fake claude and pi providers), approved and blocked.
  - Timestamps, commits, digests, temp roots and UUIDs are normalized, and key order is kept.
  - The judge ports are patched in and asserted never called.

## How the ports are called

- `panel.settle(runtime)` and `panel.record_judge(runtime, panel_id, judge)` are called only on a judged run (`judge.judged(plan)` is not None). They are not called on the non-judged path, nor on the judged path before every built-in reviewer has a verdict or has failed.
- The `settle` return is consumed as design-challenge note 6 defines it: each provider entry with `name`, `status` and `findings` (`id`, `severity`, `file`, `line`, `title`, `detail`). A seat with no findings is still an input.
- `record_judge` receives `running` first, then a terminal object, both shaped like the PRD Appendix B judge-states and the examples. Tests reproduce `panel-judged`'s and `panel-fallback`'s judge objects and the `running` and `incomplete` literals exactly. A `record_judge` that raises makes the judge `failed`, and today's rule decides.

## Departures, readings and open items

- **Input status of a failed built-in reviewer.** No literal covers it. I used `timed_out` (it missed its deadline) or `error` (any other failure), both from the seat-status vocabulary, so that an enum in `panel.schema.json` 1.1.0 is likely to accept them. If the seats lane's schema enumerates reviewer input statuses as only `approved|blocked`, `record_judge` refuses the object and that round falls back. `JudgedCandidateTests` does not cover a failed reviewer.
- **`session_id` of a timed-out judge is null.** This follows `examples/panel-fallback.example.json`. The job was killed before it reported its session; its id stays in `$RUN/judge/judge-<n>.pid` (`marker`).
- **Malformed structured output is `incomplete`, not `failed`.** This follows the judge-states note "malformed raw rulings never enter rulings". A job that exits non-zero, reports another session or is not a success is `failed`.
- **The over-cap status is `failed`.** The error starts with `judge input over the cap`; `started_at` and `ended_at` are the same instant and `session_id` is null.
- **The judge always runs, even with no findings.** PRD 7.3 says one job per review round, and the brief asks for `{"rulings": []}` when there are none.
- **On a judged review the built-in reviewers' statuses stay `accepted`.** `mark_blockers` is skipped, because their verdicts do not gate. A built-in reviewer that failed keeps its `blocked` status and error.
- **The judged validator rule is a little stricter than PRD 7.4's letter.** A judged record's findings must be the judge's or critique's, and a blocked judged record needs a blocking judge or critique entry. Both hold for every record the controller writes.
- **`JudgedCandidateTests` ([L8]) skips here** with "seats ports absent (lane worktree)". It was run once against stand-in ports to check its own logic. At candidate verification it uses the real `ensure_started`, `settle`, `record_judge` and the 1.1.0 schema, with every seat pinned `unavailable`. It assumes the real `ensure_started`/`settle` accept a runtime of `{directory, plan, sessions.executable}`, a `review-worktree/` and a `review-bundle.json` holding only `run_id` and `candidate_commit`.
- **The graph tests patch the seats lane's hooks.** `panel.ensure_started`, `panel.collect`, the export's panels section and the panel status and outcome lines are patched out, because today's `panel.py` cannot read a judged plan item. The 2.11.0 report-only regression and the judged `panel.json`/export are the seats lane's. The candidate runs both lanes' suites.
- **Design-challenge notes (attempt 2).**
  - Note 1 is marked "Acts: operator": the bundled brief is the seats lane's file, and my work does not depend on it.
  - Notes 2-5 are seats-lane work: `pending_record`, launch's `--panels` list, `--judge-model` required, and seat names only in feature.json. I changed nothing in `pipeline.py`'s preflight, which keeps passing `--panels` to `prove_transports` unchanged.
  - Note 6: my mock of `settle` follows the note's rule (`settled()` in `test_judge.py`).
- Not done: no `costs.py` role and no EXPORT_VERSION bump ([G22]).
- **Hand fix after run 008 (F1, PRD 7.6).** `judge.run`'s finally now SIGKILLs the job's whole process group (`judge.kill_group`) before it removes the worktree, so a group member that ignores SIGTERM no longer outlives a timeout, Ctrl-C or failure once its leader has exited (`test_a_group_member_that_ignores_sigterm_is_killed_when_the_leader_exits_on_it`).
