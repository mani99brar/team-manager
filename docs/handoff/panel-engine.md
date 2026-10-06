# Multi-provider panel — engine handoff (run multi-provider-panel-002)

The engine lane of `docs/PRD_MULTI_PROVIDER_PANEL.md` (sections 3, 4, 6 item 1, Appendix A): a feature.json 2.6.0 feature may
declare `panels`, and its automatic run gets a report-only, in-process multi-provider panel at the **review** step. This file
records what shipped, the record shape, the adapter interface, the review-step mechanism, the launch guards, what the viewer
consumes, the measured facts of the fixture step, and every open lead.

## What shipped

- **Contracts (`contracts/workflow/`).** `panel.schema.json` 1.0.0 (`<run>/panel.json`, Appendix A, plus `$defs.output`, the
  claude provider's object-root job schema). `feature.schema.json` gains version `2.6.0` and the optional `panels` key.
  `contract.test.ts` asserts the 2.6.0 enum, the `panels` shape, and parses **both** Appendix A records from the PRD (the
  fences sit indented in a bullet, so the extractor tolerates leading whitespace) plus a running record, `"all"`/`1`
  thresholds, a `challenge` stage and every nullable field null.
- **`workflow/panel.py`** (new): configuration (`declared`, `settings`, `provider_settings`, `brief_path`), the launch guards
  (`check_launch`, `deepseek_guard`, `prove_transports`, `resolve_pi`), the prepare pin (`pin`, `validate_plan`), the record
  (`pending_record`, `save_record`, `export_section`), context assembly (`assemble_review_context`, `review_sections`,
  `context_labels`), the transport adapter (`claude_command`, `panel_settings`, `pi_command`, `pi_env`, `ClaudeTransport`,
  `PiTransport`, `parse_pi_stream`, `parse_reply`, `strip_fence`), the findings (`normalize_findings`, `overlap`), the jobs
  (`start_provider`, `kill_orphan`, `Job`) and the two review-step hooks (`ensure_started`, `collect`), plus the `status`
  and outcome lines.
- **Version sets.** `2.6.0` joined `guardrails.GUARDED_VERSIONS`, `sidecar.SIDECAR_VERSIONS`, `attack.ATTACK_VERSIONS` and
  `launch.CRITICAL_VERSIONS`, so a 2.6.0 feature carrying `prd` + `sidecar` + `attack` + `critical` + `panels` launches
  (`test_pipeline.PanelLaunchGuards`). `attention.KINDS` gains `panel`.
- **Launch / prepare.** `launch.load_feature` refuses `panels` before 2.6.0 (naming the key, before schema validation).
  `launch_commands` runs `panel.check_launch` (stage, DeepSeek guard), resolves each brief, adds the requirement documents
  and feature-file briefs to the committed-at-HEAD check, runs the two transport probes through `panel.prove_transports`
  (injectable `prove=`; the dry run included — its docstring now names them), passes `--panels <transports>` to preflight
  (which proves them again) and `--panel-settings {panels, pi_bin}` to prepare. The dry run prints `panels`. `prepare`
  validates the settings, reads each brief's text and pins `plan.panels` **last** (`feature_version` = 2.6.0), with the
  brief `{source, text, sha256}`, `requirement_docs`, `pi_bin` and the PRD's repository label.
- **Review step.** `automatic._review_candidate` calls `panel.ensure_started` right after each `attack.ensure_started` (the
  fresh path at the former line 1086, on both reviewer transports, and the two re-entry paths; never on the reconciliation
  raise). `automatic.review_candidate`'s `finally` is `try: attack.close_or_wait_attack(...) except BaseException: error =
  error or caught; raise finally: panel.collect(runtime, error)`.
- **Export / status / outcome.** Export **1.9.0** adds the top-level `panels` section (null / pending / the record verbatim /
  a failed record with the error when panel.json does not validate); `graph_nodes()`/`definition()` and the C49 `costs`
  section are untouched (`test_export` asserts both byte-identical with and without a panel). `status` prints
  `panel <id>: <a> accepted of <n>` (the `panels` key); the outcome block adds one `Panel <id> (report-only): …` line per
  panel after the attack line.
- **Briefs.** `features/multi-provider-panel/panels/{review,challenge}.md` installed as `workflow/prompts/panels/<stage>.md`;
  the review brief gained the object-form sentence ("or, when a structured-output schema is supplied, the object
  `{"findings":[...]}`") and the note that a section holds the file's diff hunks then its full text.
- **Fixtures (`workflow/testdata/panel/`).** `pi-mode-json.jsonl` (the real capture, header lines `#`), `brief-noenum.md`
  (the enum-removed brief used for that one extra capture), `claude-print-probe.json` (the real `claude --print` probe:
  argv, object-root stdout, array-root failure, the read-above-cwd result).
- **Grill skill.** `workflow/skills/workflow-grill/SKILL.md` names 2.6.0 in its version sentence.

## The record (`<run>/panel.json`, Appendix A)

`{version: "1.0.0", panels: [ {id, stage, status, overlap_threshold, context_bytes, providers: [...], findings: [...],
started_at, ended_at, budget_usd, error} ]}`; a provider is `{transport, model, effort, status, cost_usd, context_bytes,
finding_ids, error}`; a finding `{id, severity, file, line, title, detail, providers_raised, accepted, unanchored}`.

- Panel `status`: `pending` (export-only, before the step), `running` (written at start, `started_at` set), `succeeded`
  (≥1 provider `ok`), `timed_out` (every provider timed out), `failed` (an assembly throw, an internal exception, a
  non-interrupt exit with no review.json — or, my call where Appendix A is silent, every provider `error`/`parse_failed`
  with none `ok`; the `error` then lists each provider's status).
- Provider `status`: `pending`, `running`, `ok`, `timed_out`, `error`, `parse_failed` (the raw reply text, clipped, is in
  `error` prefixed `parse_failed (<n> context bytes):`; the full stream stays in its stdout file). Every provider error text
  carries the context byte size. `cost_usd` is pi's `usage.cost.total` or claude's `total_cost_usd`, recorded as reported.
- A provider is named `model`, or `claude` for a default claude (`providers_raised`, the side files, the attention text).
- Finding ids are `f1..fn` in cluster order; an `unanchored` finding is folded and never accepted, whatever the threshold.
- Files: `<run>/panel/<id>/context.txt`; per provider `<slug>-<n>.stdout.{json|jsonl}`, `<slug>-<n>.stderr.log`,
  `<slug>-<n>.pid` (the orphan guard), `claude-<n>.prompt.txt` (claude: the brief then the context), `scratch-<slug>/`
  (pi: the cwd, holding only `context.txt`), and `<slug>.findings.json` (the provider's normalized findings, kept so a
  resume re-merges the overlap with the providers it did not rerun). Nothing of the panel is written to the run root
  except `panel.json`, so `costs.numbered` never counts a panel job.

## The transport adapter

One command-builder and one output-parser per transport (`panel.TRANSPORT`):

- `claude`: `claude_command` = `automatic.print_command` (Read,Glob,Grep, dontAsk, no prompts, no MCP) with **no
  `--add-dir`**, `panel_settings(directory)` (the C14 `worker_settings` deny rules plus `Read(/<run>/<sibling>)` denies on
  `*.json`, `*.jsonl`, `*.txt`, `*.log`, `*.diff`, `*.sqlite`, `panel/**`, `attack/**`, `challenge-inputs/**`,
  `verification/**`), the entry's `--effort` **replacing** the judges' pin (exactly one), the entry's `--model` (else the
  judges' pin), the panel's `--max-budget-usd`, and the object-root `$defs.output` schema; cwd = `<run>/review-worktree`;
  env = `sessions.job_env()`; the prompt (pinned brief + `=== MATERIAL ===` + the context file) on stdin; started with
  `popen_claude(..., start_new_session=True)`. `ClaudeTransport.parse` wants exit 0, its own `session_id`, `is_error`
  false, `subtype` success and `structured_output.findings`; else it tries `result` as a reply; `cost_usd` =
  `total_cost_usd`.
- `pi`: `pi_command` = `<pi_bin>/pi -p --mode json --no-session -nt -nc -ns -ne -np --model <provider/id> <brief text>
  @context.txt`; cwd = the scratch dir; stdin `DEVNULL`; plain `subprocess.Popen` (never `popen_claude`, whose
  `claude_env` would add variables) with `pi_env`: exactly `PATH` (`<pi_bin>:/usr/local/bin:/usr/bin:/bin` — the nvm bin
  holds `node`, which pi's shebang needs), `HOME`, `LANG`, `TMPDIR`, plus the one credential variable of the model's
  provider prefix (`deepseek` → `DEEPSEEK_API_KEY`; `openai-codex` none). `PiTransport.parse` skips non-JSON lines and
  `thinking*` events, takes the **last assistant** `message_end` (the first is the user echo), joins its `text` parts
  (thinking parts skipped), strips one code fence, parses a bare array or `{findings}`, and reads
  `message.usage.cost.total`.

## The in-process review-step mechanism

`ensure_started` (idempotent per controller process, handles on `runtime.panel_jobs`, injectable `clock`): for every panel
that is not terminal it assembles the context once (an existing `context.txt` is reused — the candidate is frozen), writes
the `running` record (the original `started_at` kept on a rerun), and starts only the providers whose status is not
terminal — a fresh panel starts them all, a non-terminal record (Ctrl-C/crash) only the `pending`/`running` ones, each into
a new numbered output file after `kill_orphan` has stopped a live pid left by a crashed controller (its `.pid` file's pid
whose `/proc/<pid>/cmdline` carries the provider marker — `--session-id <sid>` or `--model <m>` — and whose `/proc/<pid>/cwd`
is the recorded cwd; a zombie counts as gone). An assembly throw records the panel `failed`; a launch failure records that
provider `error`; nothing raises.

`collect` (injectable `clock`/`sleep`; `collect_print` semantics): with a `KeyboardInterrupt`/`TransientInfraError` as the
exit error it reaps the providers that already exited (their findings and side files kept), terminates the rest (process
groups, `sessions.terminate`), leaves the record non-terminal and returns at once; with any other exit and **no
review.json** it reaps the exited ones, terminates the running ones (`error: terminated: …`) and records the panel `failed`
with the exit's error; with review.json it polls: every exited provider is reaped first (findings kept whatever the clock),
a provider still running past `launched + timeout_minutes*60` is terminated and `timed_out` (its cost read from whatever it
wrote); then the overlap runs over every provider's findings (reaped now, or the side file of a kept terminal provider),
the panel status is derived, `ended_at` set, the record validated and saved, and one `panel` attention record written when
≥1 finding is accepted. A fresh `KeyboardInterrupt` inside the wait terminates the jobs, saves the non-terminal record and
propagates. Any other exception is recorded `failed` on every non-terminal panel.

Why in-process (and why the detached child is deferred): a *review* panel lives inside one review step of one controller
process, so the controller can start the jobs beside the reviewers, hold `controller.lock`, and be the sole writer of
`panel.json` — no running marker, pid-cmdline liveness, `panel.lock`, events or exported node ([L6], [L7]). A *challenge*
panel must outlive a paused controller (the challenge pauses and the operator resumes later), which needs the detached
child, its own lock, the reaper and the live-record path; that is the follow-up slice (PRD §5 step 3), and the config,
schema and record stay stage-agnostic for it.

## The launch guards (PRD 4.2)

- `panels` on a version before 2.6.0 → "feature.json panels needs version 2.6.0".
- `report_only` not `true`; a `pi` entry without a `provider/id` model; an `effort` on a `pi` entry; an unknown key; an
  out-of-range bound; an `overlap_threshold` that is neither an integer ≥ 1 nor `"all"`; duplicate panel ids; providers not
  distinct by name (`model`, or `claude` for a default claude).
- `stage` must be `review` this slice ("a panel runs at the review stage only").
- **DeepSeek key guard** (`deepseek_guard`): a `deepseek/*` provider needs `WORKFLOW_PANEL_ALLOW_DEEPSEEK=1`, a non-empty
  `DEEPSEEK_API_KEY`, and `~/.config/md-manager/panel-deepseek.fingerprint` readable with mode `0600` (no group/other bits)
  whose trimmed content equals `sha256(DEEPSEEK_API_KEY)` (hex, case-insensitive); otherwise the one refusal of PRD 4.2.
  The fingerprint file does not exist on the pilot host today; configure `claude` + `openai-codex/*` only.
- **Transport proofs** (`prove_transports`, in `launch_commands`, dry run included; preflight repeats them from
  `--panels`): a claude provider needs `--max-budget-usd` in `claude --help`; a pi provider needs `pi` on the controller's
  PATH or under `~/.nvm/versions/node/*/bin` and `pi --version` exiting 0; the bin directory is pinned as
  `plan.panels[].pi_bin`.

## What the viewer lane consumes

- The export's top-level `panels` section (1.9.0): the `panel.json` object verbatim, the `pending` record built from
  `plan.panels`, or null. Live-vs-export: serve `<run>/panel.json` whenever it reads and validates, else the export.
- The attention record kind `panel`, node `null`, text `Panel <id> (report-only): <a> accepted finding(s) of <n> across <k>
  responding provider(s): read <run>/panel.json`.
- No panel events and no graph node this slice; the Panel section opens from the run page.
- **The operator restarts the viewer service after integration**: the running viewer accepts exports ≤ 1.8.0.

## Fixture step: measured facts (2026-10-06, pi 0.85.1, claude 2.1.291)

- Realistic review context (pine `d055235`: 10 touched text files, each as diff hunks + full file, plus
  `docs/security/requirements.md` and `docs/prd/PRD-03-claims.md`): **`context_bytes` = 427 378**, 12 labelled sections.
  `openai-codex/gpt-6-sol` reviewed it in 39–61 s (three brief-compliant calls: P0,P0,P1 / P0,P0 / P1; costs reported
  0.228 / 0.040 / 0.241 USD — the pi estimate, non-zero). The raw stream was **1.44 MB** (the `@file` content echoed three
  times), which is why provider output goes to files, never a PIPE.
- None of the three brief-compliant calls freelanced a severity; the one extra capture with the enum sentence removed
  returned `"high"` twice (cost 0.235) and is the committed fixture (its echoed context is cut to 1 200 characters per
  copy; everything else verbatim). The parser test maps `high` → P1 from it.
- pi 0.85.1's stream carried no separate `thinking*` events; the thinking is content parts of the assistant message (the
  parser skips both). Two `message_end` events (user echo, assistant). The reply was a bare array, not fenced.
- pi expands `@context.txt` to its **absolute path** inside the `<file name="…">` tag it sends: the scratch directory's
  absolute path (`<run>/panel/<id>/scratch-<slug>/context.txt`) reaches the provider. No pi flag avoids it; recorded as a lead.
- claude: an **array-root** `--json-schema` fails (`API Error: 400 … input_schema.type: Input should be 'object'`), so the
  provider uses the object root. On a tiny labelled context both the real pi and the real claude cited the section label
  verbatim (`workflow/x.py`; pine's `packages/api/src/modules/claims/reconcile.ts`).
- claude read-outside-cwd probe (design-challenge note 2): with cwd = the review worktree and **no** sibling deny rules,
  `Read ../review.json` and `Read ../attack.json` were **denied** ("permission denied in don't-ask mode"); `Glob ../*.json`
  returned nothing; `Read workflow/x.py` succeeded. So the cwd restriction holds on claude 2.1.291 by itself; the sibling
  `Read(/<run>/…)` deny rules are kept as belt and braces, and PRD 4.6 may name both. This is version-dependent behaviour.

## Accepted-finding count

Filled after pilot run 1 (PRD §5 step 2) — not produced in this build run. Note that `accepted` counts **responding**
providers: with `overlap_threshold` 2 and one provider timed out, nothing can be accepted; with `"all"`, every configured
provider must have raised the finding.

## Open leads (each one line)

- **`timeout_minutes` bounds the collect**, not the clock: a provider still running is terminated at collect (after the
  review's own wait and the attack close), so a 15-minute timeout may stop it well after 15 minutes of wall time; a
  provider that exited by then keeps its findings whatever the clock.
- **Per-panel context cap**: 427 KB (~107 k tokens) went through `gpt-6-sol`, but nothing caps a larger candidate; add a
  `max_context_bytes` setting that records `failed` with the size instead of sending an over-window file.
- **Rerun on changed pins**: a resumed rerun reuses `context.txt` and the pinned brief; a feature re-prepared with other
  briefs/requirements is a new run, never a rerun — the record carries no brief sha to detect drift.
- **Scratch path reaches the pi provider** (the `<file name>` tag): harmless today (a state path, no secret), but it is a
  host path outside the candidate tree; a pi flag to name the file logically would close it.
- **Panel `failed` when no provider is `ok` and not all timed out**: my call where Appendix A is silent; the viewer shows
  the error line listing each provider's status.
- **`panel-<id>` lane-name collision**: no reserved id is added this slice; a lane named `panel` or `panel-x` is legal
  today and will collide with the follow-up slice's exported node — reserve it then (sessions.RESERVED_NODE_IDS/PREFIXES,
  the three schema patterns, `triage.ts`).
- **Costs live in `panel.json` only**: the run total (`costs.total_usd`) excludes the panel; add a role once old exports
  may change.
- **Sibling deny rules depend on Claude Code's pattern semantics**: proven for `Read` of `../review.json` with and
  without them; `Glob`/`Grep` path denies were not probed separately.
- **Attention node is `null`**: one state per panel text; a second panel's record replaces the first's `states` entry only
  when its text is identical (it never is), so both lines are written.
- **Orphan guard needs `/proc`**: `kill_orphan` matches the recorded cwd and argv marker through `/proc/<pid>`; on a host
  without it the rerun starts beside a live orphan (the attack pass has the same limit).
- **A non-terminal panel whose providers all exited** (an interrupt or crash between the last exit and the terminal save) is
  finalized by the next `ensure_started` from the side files, with no rerun; the attention record is written only for a
  panel that ends `succeeded` (a `failed` panel of a non-decided exit may still list accepted findings in the record).
- **`panel.validate_plan` is not wired into `Pipeline.__init__`** (parity with `attack.validate_plan`, also unwired): a
  hand-edited `plan.panels` fails inside `ensure_started`, which records the panel `failed` instead of refusing the run.
- **Host-sensitive guardrails assertions**: `test_guardrails` asserted the word `Traceback` was absent from `start`'s
  output, but the stale-Claude-session warning echoes every running session's argv (a sibling worker's prompt contained
  the word); the three assertions now look for `Traceback (most recent call last)`.
- **`test_verification.PolicyLintTests`** counts the feature policies under `features/`; this feature is the tenth.
- **Deferred by decisions.md** (reported, not built): the verifier/skeptic node, promotion to blocking, challenge-pause
  teeth, switching workers/reviewers/judges to pi, tool-read context for pi, the challenge-stage panel (detached child,
  `panel.lock`, events, exported node, the `triage.ts` whitelist line).
