# Handoff: review-panel seats (feature.json 2.11.0, step 1 seats lane)

The shared reviewer list, the generic `cli` transport, the judged panel's seats and feature.json 2.11.0. Spec:
`features/review-panel-registry/prd.md` sections 4-7 and Appendices A-B; decisions: `features/review-panel-registry/decisions.md`.
The `judge` lane builds the judge and the verdict on the two ports below; the `viewer` lane renders the 1.1.0 record.

## What was built

- **`workflow/reviewers.py`** (new): `load(path=None, env=os.environ) -> dict` and `resolve(listing, seats, *, which, run) -> list[dict]`
  (PRD Appendix A), plus `read` (listing, sha256, path: launch's single read), `check` (schema + the rules a schema cannot
  state), `check_seat` (a resolved seat as --panel-settings and the plan carry it), `cli_env` (a cli seat's environment built
  from nothing) and `label_of`. Default path `~/.local/share/agent-memory/repo/learnings/skills/review-panel/reviewers.json`,
  override `WORKFLOW_REVIEWERS_FILE` (absolute).
- **`contracts/workflow/reviewers.schema.json`** (new, 1.0.0) and **`panel.schema.json`** now `oneOf` record 1.0.0 (unchanged) and
  record 1.1.0 (one judged panel, seat providers, `<prefix><n>` findings, a required `judge` whose status fixes `fallback`,
  `ended_at`, `cost_usd` and whether rulings may exist). `panel.validate_record` validates through the record's own version so
  a 1.0.0 refusal names the same field as before.
- **`workflow/panel.py`**: the judged panel's settings (`judged_settings`, `is_judged`, `judged_item`, `check_alone`), its pin
  (the PRD Appendix B `plan-panel-judged` key set) and `validate_plan`; the seats (`start_seat`, `seat_argv`, `parse_cli`,
  `extract`, `stop_seat`, `cleanup_seat`, `kill_orphan_seat`); `settle`, `record_judge`; the 1.1.0 `pending_record` (judge
  `pending` from the start); `judged_line` for `status`/`outcome`; `ensure_started` and `collect` dispatch to the seat code on
  a judged plan only. Report-only code paths are untouched (golden byte test below).
- **`workflow/prompts/panels/review-judged.md`** (new): the [G13] brief. `review.md` is byte-identical (sha256 pinned in
  `test_panel.Briefs`).
- **`workflow/launch.py`**: reads the list only for a judged panel (dry run included), resolves the seats, needs
  `--judge-model`, puts the resolved item (seats, `reviewers_file {label, sha256}`, `judge {model, effort: high,
  timeout_minutes, budget_usd, input_cap_bytes: 600000}`) in `--panel-settings`, and gives preflight `--panels` from report-only
  panels only. **No `pipeline.py` change**: prepare's pass-through (`panel.settings` → `check_launch` → `pin`) carries it.
- **`workflow/lane_review.py`**: a `cli` reviewer is refused ([O4]).
- **2.11.0** joined every exact-match set: `launch.py` (all four), `guardrails.py`, `sidecar.py`, `attack.py`, `critique.py`,
  `panel.py`, the feature schema enum and its `panels` items (`oneOf` report-only | judged), `contract.test.ts`, the grill
  SKILL.md; new example `contracts/workflow/examples/feature.2.11.0.json`.
- **Fakes** `workflow/testdata/panel/fake-muse` and `fake-agy` print captured-shape output (muse JSONL `payload_type` events
  with `usage` null; agy one JSON object); `report-only-panel.json` is the golden 1.0.0 record written by the code before this
  change.

## Refusals and rules to know

- **Mixed panels are refused ([L5])**: in step 1 a feature that declares a judged panel beside any other panel (report-only or
  judged) is refused at launch and at prepare; a second judged panel is refused too. The 1.1.0 schema holds exactly one panel.
- **A null-model `claude` seat runs the judges' pinned `--model` ([L7])**: the claude seat's argv is today's
  `claude_command`, which takes the judges' pin when the entry has no model. With `--judge-model claude-opus-5-5` every
  null-model claude seat runs Opus 5.5. [G5]'s "Claude Code's default model" is a later config change.
- **`--judge-model` is required** for a judged panel (design-challenge note 3), dry run included: without it the judge's pinned
  model would be null and every judging would fall back.
- A judged panel is refused below 2.11.0, at `stage: challenge`, with `providers`, `overlap_threshold`, a panel-level
  `budget_usd` or `timeout_minutes`, and with a seat object, `reviewers_file` or `judge.model` written in feature.json (note 5:
  only seat names come from the feature; resolved objects only from --panel-settings and the plan).
- The list missing, unreadable, invalid JSON or schema-invalid, or a named seat absent from it, refuses the launch with the
  path. A disabled seat, a missing binary, a failing `version_argv`, a `claude --help` without `--max-budget-usd`, a failing
  `pi --version` or a missing credential file pins the seat `unavailable` and never blocks; an all-unavailable panel launches.
- Credentials: the controller only `os.stat`s a credential file and passes its path in the entry's env name, on every
  transport (claude: today's job env plus it; pi: `pi_env` plus it; cli: below); the env name may not be PATH, HOME, LANG or
  TMPDIR. No argv holds a prompt (cli), a credential or a run-directory path. The cli env is PATH, HOME, LANG, TMPDIR,
  `env.pass`, `env.set` and the credential env, nothing else.
- Cleanup: an exited seat's process group is SIGKILLed when it is reaped (a background process it spawned dies with it, ok or
  not); a KeyboardInterrupt while the seats start stops the ones already started, saves them `running` and propagates.
- Cap watchdog (run 005, [L12] B1 / [L13]): `start_seat` arms a daemon timer (`panel.watchdog_timer`, patchable) at the seat's
  own `cap.timeout_minutes`, so the cap holds from the seat's start while the built-in reviewers run, not only inside `settle`.
  At the cap it does nothing if the seat has exited or been reaped; otherwise it sets `job.expired`, SIGTERMs the group and
  SIGKILLs it `KILL_GRACE_SECONDS` later unless cancelled in the grace (it waits on an event that the cancel sets: challenge
  note 1). The reap, the `timed_out` record and the cleanup stay on the main thread. Before the reap only `job.expired` makes
  a seat `timed_out`: an exited seat without it keeps its result however late `settle` starts, and the clock check applies
  only to a seat still running. `_reap_seat` and `stop_seat` cancel the timer. The no-review.json / interrupt branch of
  `collect` records an expired, exited seat `timed_out`, not `error: exit -15` (challenge note 2).
- **The cap now ends `claude` and `pi` seats too** (challenge note 3): the watchdog is armed for every transport, so a
  `claude` or `pi` seat still running 15 minutes after its own start is killed and recorded `timed_out` with its findings
  dropped. Before run 005 such a seat that exited before `settle` was kept. No judged run has seat-duration data yet. If the
  first judged runs see the Claude seat time out on a large diff, raise that entry's `cap.timeout_minutes` in the reviewer list.

## How the judge lane calls the ports

- `panel.settle(runtime, *, clock=time.time, sleep=time.sleep) -> list[dict]`: call it after the built-in reviewers are done.
  It starts the non-terminal seats itself when nothing was started in this process (resume), waits for each seat to its end or
  its own `cap.timeout_minutes`, writes the terminal seat part of panel.json and returns **every pinned seat** in plan order as
  its `providers[]` record plus `findings` = the panel findings whose ids are in its `finding_ids`, cut to exactly
  `{id, severity, file, line, title, detail}` (note 6). Unavailable seats are included, with `findings: []`. A terminal record is
  returned again without rerunning anything. KeyboardInterrupt / TransientInfraError stop the seats (groups killed, worktrees
  removed), leave them non-terminal and propagate; any other failure records the panel `failed` and still returns. After
  `settle`, `panel.collect` is a no-op.
- `panel.record_judge(runtime, panel_id, judge) -> None`: any judge status (`pending`, `running`, `judged`, `failed`,
  `timed_out`, `incomplete`); validated against record 1.1.0 before the write, `ValueError` (nothing written) when it breaks it.
  It sets each finding's `accepted` (true exactly for the sources of a `confirmed` ruling of a `judged`, non-fallback judge)
  and the panel's `ended_at` to the judge's `ended_at` (null for `pending`/`running`) ([L4]). `reviewer_findings[].worker`
  may be null (review.json's `worker` is optional).
- Before the first `record_judge`, panel.json (and the export's `pending` record) already carries the `pending` judge of PRD
  Appendix B with the plan's judge model (note 2).

## Open, untested or departed

- **Design-challenge note 1 (panel answer, option A; worker question 002 was answered by the cook's panel, not the operator: G8)**: the [G13] brief lives in `review-judged.md`, the judged panel's
  default (`builtin:review` or no prompt); `review.md` stays the report-only brief. This departs from the seats task's
  Constraints line and PRD 5.2, which named `review.md`. The plan's `prompt.source` is the resolved brief path, as today.
- The brief asks seats to name the violated requirement at the start of `detail` rather than in a separate `requirement`
  key (PRD 5.2 lists one): the claude seat's `--json-schema` is today's (closed finding keys, [L1] keeps its argv), and the
  1.1.0 finding has no `requirement` key, so the requirement reaches the judge inside `detail`.
- The 1.1.0 record's panel-level `budget_usd` is the panel default 5 (seats carry their own caps).
- The test harness (`test_pipeline.isolate_registry`) points `WORKFLOW_REVIEWERS_FILE` at a non-existent temp file rather than
  unsetting it, so a test that forgets its own list can never fall back to the operator's real list.
- Not run against the real `muse` or `agy`: argv, output shapes and failure texts follow the 2026-10-14 probe notes in the
  task; the first live judged run should be watched (Muse's shell still fails in its sandbox on cryotrack).
- Not proved here (judge lane / candidate): the automatic-mode wiring (`automatic.py` calls `settle`/`record_judge`), the
  judge's rulings, review.json, and `test_judge.JudgedCandidateTests` ([L8]), which runs at candidate verification.
- Hand fix after run 008 (F2, F3): `stop_seat` now SIGKILLs the seat's process group even when the leader exited on the SIGTERM (a child ignoring SIGTERM no longer outlives the seat), and `parse_cli` returns `parse_failed` when a findings entry is not an object (`parse_reply` and `normalize_findings` unchanged).
