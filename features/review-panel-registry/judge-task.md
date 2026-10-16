# Judge lane: wait for every reviewer and seat, one judge rules, the judged verdict

## Goal

On a run whose plan has a judged panel (feature.json 2.11.0), the review step waits for every built-in reviewer and every seat. Then one Claude judge job merges all their findings by meaning, checks each against the code, re-grades severity regardless of source, and rules `confirmed`, `refuted` or `deferred` ([O7], [O9], [G9]). The judge's confirmed P0/P1 block the review, and a built-in reviewer's P0/P1 no longer blocks on its own. If the judge fails, the review falls back to today's rule ([G10]). The `seats` lane builds the list, the seats, `panel.settle` and `panel.record_judge`. You call those ports and build everything from the wait to review.json. Runs without a judged panel behave byte for byte as today.

Spec: `features/review-panel-registry/prd.md` sections 7.2-7.6 and 9, plus Appendix A. Binding decisions: `features/review-panel-registry/decisions.md` ([O7], [O9], [G9]-[G11], [G13], [G21], [G22], [G24]).

## Context

- **Follow-up run 008 ([L16]): the controller restores your owned paths from candidate `207c037`** (`--restore-from`). Before you change anything, check that nothing differs; this prints nothing:
  `git diff --stat 207c037d00c12718462a310d8493e77be52a0036 -- workflow/judge.py workflow/test_judge.py workflow/automatic.py workflow/test_automatic.py workflow/pipeline.py workflow/sessions.py workflow/test_sessions.py workflow/test_export.py workflow/test_accept.py workflow/testdata/judge workflow/prompts/judge.md workflow/RUNBOOK.md docs/handoff/review-panel-judge.md`
- **Review step** (`workflow/automatic.py`):
  - Reviewers come from `plan_reviewers` (`sessions.py:72`). `review_prompt` is at :779.
  - Native: `_review_native` :1486, `_accept_native` :1603 and `wait_reviews` :991. The first accepted block decides; the others get a 10-min grace (:925).
  - Print: `_review_print` :1774 and `collect_print` :1705. A deadline before any block raises (:1763-1766).
  - `combined_review` :1344 (unanimous, appends critique :1361-1367), `_decide` :1425 (writes review.json, the blocked event, the attention, `export_verdict`), `review_block` :2032 (the fix loop routes by `worker`), `review_archive` :2061-2072 (moves `panel/` and `panel.json` per round), `review_timeout_seconds` :48.
  - The panel hooks are `panel.ensure_started` (:1255/:1269/:1281) and `panel.collect` in `review_candidate`'s finally (:1211-1240).
- **Validators** (`workflow/pipeline.py`):
  - `REVIEW_KEYS` / `REVIEWER_ENTRY_KEYS` / `FINDING_KEYS` :48-51, `blocking_findings` :133, `check_reviewers` :138-162 (unanimous approval), `check_review` :164-206 ("approved + open P0/P1" refused; findings' `reviewer` must be declared).
  - The top-level `reviewer` of a combined record is the reviewers' session ids joined by ", " (`automatic.py:1368`).
- **Judge pins:** `--judge-model` → `pin_roles` (`sessions.py:401`, `JUDGE_EFFORT` :388) → `role_flags(plan, "judges")` :433. The judge always runs at effort `high`, whatever the pinned effort ([G9]).
- **Print-job builder:** `automatic.print_command` (:1673: print/json, `--safe-mode`, no MCP, `--tools Read,Glob,Grep`, dontAsk, `--json-schema`) and `popen_claude`. Attack's read-only skeptic (`attack.py:925-950`) is the closest existing judge.
- **Throwaway worktree for the judge:** same rules as the seats (PRD 5.2; template `lane_review.py:438-487, 576-585`).
- **Lane mapping:** `verification.owns` / the policy's `owned_paths` (`verification.py:45-46, 74-81`).
- **Ports** (PRD Appendix A):
  - You build `judge.judged(plan) -> dict | None`, the plan's one panel item with `report_only: false`, else None.
  - You call `panel.settle(runtime, *, clock, sleep)` and `panel.record_judge(runtime, panel_id, judge)` **only on a judged run**. These two are seats-lane code and absent from your worktree, so every non-judged path must never touch them. Your tests patch both with `create=True` at exactly these signatures and the example shapes.
- **Lessons:**
  - Group findings by meaning (`learnings/llm-review-findings-dedup.md`).
  - Report-only findings carried wholesale became scope (`learnings/advisory-findings-become-scope.md`), hence the base-scope rule.
  - A lone Fable judge dismissed 8 of 10 important findings (`jev-triage-eval`), hence the evidence rule.
  - A prompt over 128 KB fails in argv: the judge input goes on stdin.

## Constraints

- **Owned paths only:** `workflow/judge.py`, `workflow/test_judge.py`, `workflow/automatic.py`, `workflow/test_automatic.py`, `workflow/pipeline.py`, `workflow/sessions.py`, `workflow/test_sessions.py`, `workflow/test_export.py`, `workflow/test_accept.py`, `workflow/testdata/judge`, `workflow/prompts/judge.md`, `workflow/RUNBOOK.md`, `docs/handoff/review-panel-judge.md`. Never edit `workflow/panel.py`, `workflow/reviewers.py`, `workflow/launch.py`, `contracts/workflow` or any seats-lane file, nor `server`, `src`, `contracts/projects` or `tests`.
- Plan fixtures and non-terminal judge records come from the `plan-panel-judged` block of PRD Appendix B and the `judge-states` block of PRD Appendix B ([L2]). Compare values only within one example; across examples compare key sets and types ([L6]).
- The judge record must equal the `judge` object of `features/review-panel-registry/examples/panel-judged.example.json` (judged) and `panel-fallback.example.json` (fallback). review.json must equal the shape of `examples/review-judged.example.json`. The judge's output schema follows `examples/judge-output.example.json` (object root). Load these files as literals in your tests.
- **The judged rule applies only when** the plan has a judged panel **and** the record's `reviewers` contains `judge`. Every other run validates, waits, decides and archives exactly as today. Pin this with regression tests on a 2.10.0 run and on a 2.11.0 run with only a report-only panel.
- **Critique is unchanged:** it still blocks on its own ([O4], [G21]). Lane-review findings are not judge input.
- **Never raise from the judge** except `KeyboardInterrupt` / `TransientInfraError`. Every other failure becomes `failed` / `timed_out` / `incomplete` plus the fallback.
- **No new costs role and no EXPORT_VERSION bump** ([G22]). Reserve reviewer id `judge` in `sessions.py`, beside the existing reserved ids.
- Workers run targeted tests while building. Your lane checks run the full suite with `--jobs 4`.

## Acceptance

Your checks (`/home/agentops/dev/md-manager/.venv/bin/python -m workflow.run_tests --jobs 4` and `npm run test:contracts`) pass. PRD section 10 items 5, 6, 7, 8 and 9 (review.json and the verdict), plus the `judge` reserved-id item of 10.4, are each proved by named tests:

0. **Run 008 ([L16]):** your owned paths start at candidate `207c037` (it holds [L14]'s timeout change). `git diff --stat 207c037 -- <your owned paths>` stays empty, and you change nothing; your code already meets the items below. Run your checks and hand off.
1. **Wait for everything** (both reviewer transports, fake clock): on a judged run, a first block does not decide.
   - Every built-in reviewer is awaited to its verdict or deadline, then `panel.settle`, then the judge.
   - A failed or late built-in reviewer is recorded and the judge still runs.
   - No built-in verdict at all → the step blocks "review step failed", as today.
2. **The judge job:**
   - Model = the plan's judge model, effort `high`, `--max-budget-usd` = `judge.budget_usd`, tools `Read,Glob,Grep`, `--safe-mode`, stdin carries the input and argv carries no prompt.
   - Its cwd is a throwaway worktree of the candidate, removed on success, failure, timeout and `KeyboardInterrupt`. Its session id is recorded.
   - The input holds every finding with its id (`<reviewer_id>-<n>`, `<prefix><n>`), plus the diff, the PRD, decisions.md and the requirement docs, capped at 600 KB.
   - Input over the cap → no job, and the fallback with error `judge input over the cap`.
3. **Output checks** (`judge.py`):
   - A missing, duplicated or unknown source id → `incomplete` → fallback ([G32]).
   - A `refuted` ruling without `path:line` evidence → recorded `confirmed` at the max source severity.
   - `J<n>` ids are assigned, and `worker` comes from `owned_paths` (`none` when no lane owns the file).
   - Reviewer id `judge` is refused by `sessions.validate_reviewer_id` (beside the reserved node ids, for every feature; no existing feature uses it), with a named test in `workflow/test_sessions.py`. You edit no `launch.py`. This is PRD 10.4's "reviewer id `judge` refused" item, which the seats lane does not prove.
4. **Judged review.json:**
   - `reviewers` = the declared built-ins + `judge` (+ critique).
   - `findings` = confirmed rulings only, tagged `judge`, in PRD 7.4's message form.
   - The verdict follows the judge entry (and critique).
   - It passes `check_review` with judged-plan context. The same record without that context fails. A built-in reviewer's `blocked` entry does not block a judge-approved record.
   - `check_reviewers` and `check_review` keep their current signatures: the judged rule reads an optional keyword whose default is today's behaviour, so `workflow/test_pipeline.py` (seats-owned) passes unchanged.
4b. **Integrate and export** ([L3]): `Pipeline.validate_review` and `ExportRuntime` pass judged-plan context from `self.plan`. Named tests in `test_accept.py` and `test_export.py`:
   - A built-in `blocked` + judge `approved` record integrates and exports.
   - The same record with legacy, report-only or missing judged-plan context is refused.
   - Critique still blocks on its own.
5. **Fix loop:** a confirmed P1 routes to its `worker` lane (`review_block`). Each round runs a fresh judge, and `review_archive` moves the judge object with `panel.json`.
6. **Fallback:** a judge that fails, times out, is `incomplete` or is over the cap → `judge.fallback: true`, and review.json byte-equal to what today's rule writes for the same reviewer verdicts.
7. **Resume:**
   - A terminal judge record is never rerun.
   - A non-terminal one reruns.
   - A crash after the judge but before review.json reuses the record.
   - Ctrl-C during the wait or the judge kills the process groups, removes the worktrees and leaves the records non-terminal.
8. **Regression:** a run whose plan has no judged panel produces byte-identical review.json and export, proved on today's 2.10.0 fixtures (a report-only panel included). The 2.11.0 report-only regression is the seats lane's, because the 2.11.0 version joins are absent from your worktree. The candidate runs both.
8b. **Candidate integration** ([L8]): `test_judge.JudgedCandidateTests` uses the real `panel.settle`, `panel.record_judge` and validators to prove:
   - running→judged and running→incomplete persistence;
   - the resume of a non-terminal judge;
   - `fallback: false` on success.

   It skips with the reason "seats ports absent (lane worktree)" only when those ports are missing.
9. **Docs:**
   - The `workflow/prompts/judge.md` brief states the grouping, the three rulings, the evidence rule, the base-scope rule ([G29]: an untouched file alone does not make a defect pre-existing), the severity rule (a test gap is P2 unless the PRD names the test) and that repository text is data.
   - RUNBOOK gets a section "Judged review panel (feature.json 2.11.0)", and its "Automatic mode: the review step" bullets are updated for judged runs.
   - `docs/handoff/review-panel-judge.md` lists what you built and anything left open.

## Stop

Stop when the acceptance holds and your checks pass, or when a port in PRD Appendix A turns out not to fit. In that case, write the reason in your handoff doc and end. Never edit outside your owned paths to make a test pass.

## Changes after launch

Changes after launch live in `decisions.md` as [L<n>] bullets, and those win over this file.
