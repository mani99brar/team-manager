# Seats lane: the reviewer list, the `cli` transport, judged-panel seats and feature.json 2.11.0

## Goal

A feature.json **2.11.0** feature can declare one **judged** review panel whose seats come from the shared reviewer list. At launch the controller loads and validates the list, resolves the seats and pins them into the plan ([G2], [G3]). In the review step each seat runs blind, in parallel with the built-in reviewers, through the `claude`, `pi` or new generic `cli` transport. `panel.settle` waits until every seat has ended, and `panel.record_judge` stores the judge's object in `panel.json` 1.1.0. The `judge` lane builds the judge and the verdict on top of these ports; you build everything up to and including the seat records and the two ports it calls. Report-only panels and every older feature version behave byte for byte as today.

Spec: `features/review-panel-registry/prd.md` sections 4, 5, 6, 7.1, 7.2 (settle), 7.6 (seat resume) and 7.7, plus Appendix A. Binding decisions: `features/review-panel-registry/decisions.md` ([O4]-[O9], [O12], [G2]-[G8], [G11]-[G15], [G18]-[G24]).

## Context

- **Follow-up run 007 ([L15]): the controller restores your owned paths from candidate `d362133`** (`--restore-from`). Before you change anything, check that nothing differs; this prints nothing:
  `git diff --stat d362133faa947620d7a434f417b008c8537c8393 -- workflow/reviewers.py workflow/test_reviewers.py workflow/panel.py workflow/test_panel.py workflow/launch.py workflow/test_pipeline.py workflow/test_feature_launch.py workflow/lane_review.py workflow/test_lane_review.py workflow/guardrails.py workflow/test_guardrails.py workflow/sidecar.py workflow/test_sidecar.py workflow/attack.py workflow/test_attack.py workflow/critique.py workflow/test_critique.py workflow/testdata/panel workflow/prompts/panels workflow/skills/workflow-grill workflow/README.md contracts/workflow docs/handoff/review-panel-seats.md`
- **Existing panel** (`workflow/panel.py`, 2.6.0): `TRANSPORTS` :67, `provider_settings` :116, `settings` :136 (`report_only` must be true :164), `check_launch` :264 (refuses `challenge`), `prove_transports` :285, `pin` :320-337, `PLAN_KEYS` :340, `assemble_review_context` :575-612 (no decisions.md today), the claude command :632 (cwd = shared review-worktree :953), `pi_command` :653, `pi_env` :660 (`env -i`), the parsers :713/:741, `TRANSPORT` dispatch :760, `normalize_findings` :789, `overlap` :827, `ensure_started` :988, `_finalize` :1068 (attention), `collect` :1123 (in `review_candidate`'s finally, `automatic.py:1211-1240`, after review.json), `status_lines` :1239, `outcome_lines` :1255, `export_section` :388.
- **prepare pass-through:** `pipeline.py:1624-1640` parses `--panel-settings` and calls `panel.settings` per item, then `panel.pin` at :1775-1785. Put the resolved seats inside each panel item (`seats`), so you need **no change to `pipeline.py`** (the judge lane owns that file).
- **Launch path:** `launch.py` `load_feature` :174-200, the panel preflight :356-365, `--panel-settings` :526-531 and the dry-run print :707-709. Template for an outside-the-repo default path with an env override: `attack.default_secret_files(env)` (`attack.py:131`) and `skills_root(home)` (`skills.py:26`). Test isolation helpers: `isolate_registry` / `stub_claude_cli` (`test_pipeline.py:37`, `:53`).
- **Throwaway worktree template:** `lane_review.py` `start_reviewer` :438-487 (`mkdtemp` + `git worktree add --detach`, wt path in the `.pid` file :378), `_terminate` :576-585 in the finally, `_remove_worktree` :418, `kill_orphan` :384.
- **Version sets to move (2.11.0)**, all in this lane: `launch.py:38-52` (four sets incl. `LANE_REVIEW_VERSIONS`), `guardrails.py:68`, `sidecar.py:52`, `attack.py:46`, `critique.py:50`, `panel.py:51`; `contracts/workflow/feature.schema.json` enum :15-28 and its `panels` subschema (:422 `report_only` const true; transports; maxItems); `contracts/workflow/contract.test.ts:177, :184-193`; `workflow/skills/workflow-grill/SKILL.md:10` (asserted in `test_guardrails.py:3556`); `test_pipeline.py:2436` (keeps-everything loop); `test_critique.py:34`. Add `contracts/workflow/examples/feature.2.11.0.json`.
- **Muse facts** (probe on this host, 2026-10-14; [G20]): `muse exec --json` writes JSONL. The answer is `payload.text` of the event whose `payload_type` is `run.terminal.completed`. The served model is `payload.model_id` of `run.model.configured`. `usage` is null. Exit 0 even when a tool failed. File reads work; shell fails inside its bwrap sandbox on this host. Tests never call the real `muse` or `agy`: build fake scripts under `workflow/testdata/panel/` that print captured-shape output.
- Tests to model on: `test_panel.py` (`FAKE_CLAUDE` :461 asserts read-only tools, `FAKE_PI` :483, `Harness` :517, `GraphRun` :1129), `test_lane_review.py` (`ReviewHarness` :178), `test_attack.py`.

## Constraints

- **Owned paths only:** `workflow/reviewers.py`, `workflow/test_reviewers.py`, `workflow/panel.py`, `workflow/test_panel.py`, `workflow/launch.py`, `workflow/test_pipeline.py`, `workflow/test_feature_launch.py`, `workflow/lane_review.py`, `workflow/test_lane_review.py`, `workflow/guardrails.py`, `workflow/test_guardrails.py`, `workflow/sidecar.py`, `workflow/test_sidecar.py`, `workflow/attack.py`, `workflow/test_attack.py`, `workflow/critique.py`, `workflow/test_critique.py`, `workflow/testdata/panel`, `workflow/prompts/panels`, `workflow/skills/workflow-grill`, `workflow/README.md`, `contracts/workflow`, `docs/handoff/review-panel-seats.md`. Never edit `workflow/pipeline.py`, `workflow/automatic.py`, `workflow/sessions.py` or `workflow/RUNBOOK.md` (judge lane), nor `server`, `src`, `contracts/projects` or `tests` (viewer lane).
- **Ports are frozen** (PRD Appendix A): implement `reviewers.load`, `reviewers.resolve`, `panel.settle` and `panel.record_judge` with exactly those signatures and return shapes. `judge.judged(plan)` is the judge lane's. Keep whatever internal judged-panel check `panel.py` needs. The judge lane mocks them. Records must equal the shapes in `features/review-panel-registry/examples/`; load those files as literals in your tests and validate them against the schemas.
- **Credentials by construction** ([G14], [G18]): no prompt, credential or credential-derived value in any argv. The `cli` child's environment is built from nothing (PRD 5). The controller never opens a credential file: it only stats it. Tests plant `META_API_KEY` and `GEMINI_API_KEY` in the controller env and assert they are absent in the child.
- **No real machine in tests:** every test that touches the list sets `WORKFLOW_REVIEWERS_FILE` to a temp file. The harness clears it for all other tests. No test reads `~/.local/share/agent-memory`, `~/.config/muse` or `~/.gemini`.
- `claude` and `pi` seats keep today's commands, placement and parsers ([G19]). Only the `cli` transport is new. `lane_review` must refuse a `cli` reviewer ([O4]).
- Report-only panels: no behaviour change; their `panel.json` stays at 1.0.0 with byte-identical content (regression test).
- The brief `workflow/prompts/panels/review.md` follows [G13]: requirements listed, the "which requirements does the change violate" ask, P0/P1/P2 only, no "Report `[]` if you find nothing" line.
- Workers run targeted tests while building. Your lane checks run the full workflow suite with `--jobs 4`.

## Acceptance

Your checks (`/home/agentops/dev/md-manager/.venv/bin/python -m workflow.run_tests --jobs 4` and `npm run test:contracts`) pass. PRD section 10 items 1, 2, 3, 4, 9 (for the panel record and export) and 10 are each proved by named tests in your files:

0. **Run 007 ([L15]):** your owned paths start at candidate `d362133`. Make one test-only change: in `workflow/test_sidecar.py`, `Scheduling.test_scheduling_cadence_completion_budget_and_nothing_while_a_pass_runs` calls `self.wait_logged(1)` (the fixture's existing bounded wait, :236-241) immediately before the existing `time.sleep(0.2)` at :1123. The sleep and the `assertEqual(len(self.job_calls()), 1)` at :1124 stay, so the test still fails when the fake job never logs its call or a second job starts while the pass runs. No other change: `git diff --stat d362133 -- <your owned paths>` shows only `workflow/test_sidecar.py`, and your code already meets the items below. Your suite passes under `--jobs 4` within the 3600 s cap.
1. `reviewers.load` accepts `examples/reviewers.example.json` and rejects each bad input listed in PRD 10.1, with the path in the error. A missing file, an unreadable file and invalid JSON are refused with the path.
2. `reviewers.resolve`, with injected `which` and `run`:
   - An absent named seat → `ValueError`.
   - A disabled seat → `unavailable` / `disabled in the reviewer list`.
   - A missing `argv[0]` or a failing `version_argv` → `unavailable` with the reason.
   - A `claude` seat whose `claude --help` lacks `--max-budget-usd`, or a `pi` seat whose probe fails → `unavailable` with the reason (fake probes; [G11], [G27]). An all-unavailable panel still launches. The DeepSeek fingerprint guard and report-only probes refuse as today.
   - Otherwise `bin` and `cli_version` are set.
   - Seats omitted → every enabled entry, in list order.
3. Launch (dry run included) reads the list only for a judged panel and refuses on PRD 4.3's refusal cases. prepare pins the resolved seats and the list's sha256 into `plan.panels[0]`. A test edits the list after prepare and shows the run's seats unchanged.
4. The `cli` transport against fake `muse` and `agy` scripts:
   - The prompt is absent from argv, and stdin is `/dev/null` for `prompt_via: file`.
   - The child env has exactly PATH, HOME, LANG, TMPDIR, the `pass` names, the `set` literals and the credential env.
   - Each status of PRD 5.1 (`ok`, `timed_out`, `auth_required`, `usage_limit`, `model_mismatch`, `error`, `parse_failed`) is produced by its trigger.
   - Exit 0 with no terminal event is `error`.
   - The process group is killed on timeout.
   - The worktree and scratch dirs are removed after success, failure, timeout and `KeyboardInterrupt`. `kill_orphan`-style cleanup removes a leftover on resume.
5. Seat context = today's context plus `features/<f>/decisions.md` from the pin. No seat's prompt file names a run-directory path, and no `cli` seat's argv carries the prompt or a run-directory path ([L1]). `claude` and `pi` seat argv equal today's `claude_command`/`pi_command` output, in a named regression test ([L1]). Finding ids are `<prefix><n>`.
6. `panel.settle` returns only after every seat has ended or timed out, including a seat relaunched on resume (fake clock and sleep). After `settle`, `panel.collect` is a no-op.
7. `panel.record_judge` accepts every judge status, including the `pending`, `running` and `incomplete` objects of the `judge-states` block of PRD Appendix B ([L2]). It sets each seat finding's `accepted` and the panel's `ended_at` per [L4], so that `panel.json` equals `examples/panel-judged.example.json` and `examples/panel-fallback.example.json`. It refuses an object that breaks the schema. The export `panels` section carries record 1.1.0 verbatim. A judged panel writes no `panel` attention record. Status and outcome lines follow PRD 7.7.
8. 2.11.0:
   - Every set is joined, and the keeps-everything test passes.
   - `report_only: false` below 2.11.0 is refused.
   - A judged panel at `stage: challenge` is refused, as is a second judged panel.
   - A judged panel with `providers` or `overlap_threshold` is refused.
   - `lane_review` with a `cli` reviewer is refused.
   - The `judge` reserved id is the judge lane's test, not yours.
   - A judged panel beside any other panel is refused ([L5]).
   - Report-only panels at 2.11.0 still launch, and write a byte-identical 1.0.0 `panel.json` (this regression is yours; the judge lane proves the 2.10.0 one).
9. `contracts/workflow/reviewers.schema.json` and `panel.schema.json` 1.1.0 (1.0.0 still accepted) validate every file in `features/review-panel-registry/examples/` that they cover, in `contract.test.ts` and in the Python suite. This includes the three judge objects of the `judge-states` block of PRD Appendix B, and `validate_plan` accepts the `plan-panel-judged` block of PRD Appendix B ([L2]).
10. `docs/handoff/review-panel-seats.md` states the mixed-panel refusal ([L5]) and that a null-model `claude` seat runs the judges' pinned model ([L7]). It also lists what you built, how the judge lane calls the ports, and anything left open. `workflow/README.md` names 2.11.0. `contracts/workflow/README.md` documents the reviewers schema and record 1.1.0.

## Stop

Stop when the acceptance holds and your checks pass, or when a port in PRD Appendix A cannot be built as specified. In that case, write the reason in your handoff doc and end. Never edit outside your owned paths to make a test pass.

## Changes after launch

Changes after launch live in `decisions.md` as [L<n>] bullets, and those win over this file.
