# PRD: Review sidecar

Status: Proposed 2026-10-01. Umbrella: [PRD_CONFIGURABLE_WORKFLOW.md](PRD_CONFIGURABLE_WORKFLOW.md). Builds on the design challenge ([PRD_PORTABLE_WORKFLOW.md](PRD_PORTABLE_WORKFLOW.md) section 4.5), worker questions and `answer` (same PRD, 4.7), the parallel reviewers ([PRD_PARALLEL_REVIEWERS.md](PRD_PARALLEL_REVIEWERS.md)) and the viewer's Run Story ([PRD_VIEWER_UX.md](PRD_VIEWER_UX.md)). Ships as the feature run `features/review-sidecar` (two lanes, section 11).

## 1. Goal

A feature can declare a **review sidecar**: an independent senior-engineering reviewer that observes the implementation workers *while they work*, instead of only after freeze. Every few minutes, and whenever a lane claims completion, it reads each lane's diff and pane, keeps one deduplicated ledger of findings with explicit dispositions, sends focused messages to the responsible worker through the controller, verifies reported fixes against the next revision, and hands off a summary at freeze. The Projects viewer shows the sidecar as a node of the run with its ledger, messages and passes, live during the work phase.

Success: an automatic run of a two-lane feature with the sidecar on shows, in the viewer while the workers are still running, a `Review sidecar` node whose page lists its open findings by severity with the message each worker received; the ledger records a finding moving from `open` to `fix_reported` to `verified_resolved` across passes with the revision and evidence of each transition; the run freezes, is reviewed and integrated exactly as a run without a sidecar; and a run whose sidecar passes all fail still reaches its verified branch.

The sidecar is an advisor. It never blocks, approves, freezes or integrates anything. The independent reviewers after freeze remain the gate.

## 2. Confirmed decisions

- **Not a LangGraph node.** Like the design challenge, the sidecar runs inside the controller's own loop: during `wait_handoffs` in automatic mode, and on demand (`sidecar-pass`) in manual mode. The exported graph shows it as a node `sidecar` ("Review sidecar") of `kind: review`, because the workflow v1 node-kind enum is frozen ([contracts/workflow/README.md](../contracts/workflow/README.md)), exactly as the challenge is `kind: review` with the reserved id `challenge`.
- **Passes, not a long-lived session.** Each pass is one `claude --print` job with `--tools Read,Glob,Grep`, structured output validated against a schema, like the challenge. The controller owns the ledger file; the job never writes anything. The ledger is the sidecar's memory between passes (it is an input to every pass), so no `--resume` and no session binding is needed, and a lost pass loses nothing but itself.
- **The controller delivers messages.** The job returns messages addressed to lanes; the controller decides whether each one may be typed into the lane's pane, with rules stricter than `answer` (section 4.5). The sidecar never touches a pane, a shell or a session.
- **Never blocks the run.** A failed, timed-out, malformed or interrupted pass is recorded in the ledger and in an event and the run continues. The sidecar node ends `succeeded` at freeze whatever its ledger says; its findings are information for the operator and (section 7, open) the reviewers. The viewer makes the honesty visible: "3 of 5 passes failed" is on the node page.
- **Bounded.** Cadence, pass timeout, passes per run and messages per lane are pinned in `plan.json` at prepare with defaults that cap a 4-hour run at about 16 passes; a `--print` job without Bash cannot run tests or install anything.
- **Reserved id.** `sidecar` joins the reserved ids and `sidecar-` the reserved prefixes in every place that lists them (section 4.1). A feature that already has a lane named `sidecar` is refused at launch with the usual message.
- **Older runs and features unchanged.** A feature without `sidecar` has no sidecar node, the same graph, the same files and the same exports as today. Export 1.6.0 adds a top-level `sidecar` section that is `null` for every run prepared before, and older servers ignore an unknown top-level section (`exportSchema` is not strict). The server ships before the exporter version bump reaches a live run: once `EXPORT_VERSIONS` lacks `1.6.0`, one such run makes the run list fail (`server/projects.ts:819-846`); both lanes of this feature land together, and the live API is restarted after integration.

## 3. Configuration

feature.json 2.3.0 (what `init` writes from now on; 2.2.0 keeps launching unchanged) adds the optional `sidecar`:

```json
{
  "version": "2.3.0",
  "sidecar": {
    "prompt": "builtin:senior-review",
    "cadence_seconds": 900,
    "pass_timeout_seconds": 600,
    "max_passes": 16,
    "max_messages_per_lane": 6
  }
}
```

Rules: `prompt` is a feature-relative file (existing, non-empty) or `builtin:<id>` for a brief bundled in `workflow/prompts/sidecar/` (today `senior-review`, the brief in Appendix A); everything else is optional with the defaults shown; bounds are `cadence_seconds` 60..7200, `pass_timeout_seconds` 60..3600, `max_passes` 1..64, `max_messages_per_lane` 0..20. `sidecar` on a version before 2.3.0 is refused like `challenge` on 2.1.0. `sidecar: false` or an absent key means no sidecar. `prepare` pins the brief text and the settings into `plan.sidecar` (`{prompt, cadence_seconds, pass_timeout_seconds, max_passes, max_messages_per_lane}`); a plan without `sidecar` means none.

The controller appends to any brief, as it does for reviewers: the run and lane vocabulary, the owned paths, the input layout of the pass (section 4.3), the ledger it already holds, the output schema and these rules: only read; every finding names a lane, a file and a revision; a message is at most 1,200 characters of plain text, one per lane per pass; "no new findings" is a valid pass.

## 4. Design

### 4.1 Identity and files

| Item | Value |
| --- | --- |
| Node id, label | `sidecar`, "Review sidecar", `kind: review`, `depends_on: ["challenge"]` when the run has a challenge node, else `[]`; `handoff.depends_on` gains `sidecar` so the graph draws its handoff as an input to freeze |
| Reserved | `sidecar` in `RESERVED_NODE_IDS`, `sidecar-` in `RESERVED_NODE_PREFIXES` (`workflow/sessions.py`), the `feature.schema.json` regexes, `server/projects.ts` `RESERVED_LANE_IDS`/`RESERVED_LANE_PREFIXES`, `contracts/workflow/README.md`, `workflow/RUNBOOK.md` |
| Ledger | `<run>/sidecar.ledger.json`, controller-written, atomic replace, schema `contracts/workflow/sidecar.schema.json` (hand-written, Appendix B), validated by `workflow.verification.validate_schema("sidecar", ...)` before every write |
| Per pass | `<run>/sidecar-inputs/<n>/` (section 4.3), `<run>/sidecar-<n>.prompt.txt`, `<run>/sidecar-<n>.stdout.json`, `<run>/sidecar-<n>.stderr.log` |
| In flight | `<run>/sidecar.running.json` (`{pass, pid, started_at, trigger}`), removed when the pass is recorded |
| Events | node `sidecar`: `running` when pass 1 starts; one `running` line per recorded pass ("pass 3 (cadence): 2 new findings, 1 verified resolved, 1 message delivered to panels"); `interactive` for an escalation (section 4.6) and for a pass that failed; `succeeded` at freeze with the summary line |
| Pane | none: a pass has no session to attach. `attach` and `attach-one` are unchanged |

### 4.2 When a pass runs

In automatic mode, `wait_handoffs` runs the sidecar beside its 2 s poll. A pass starts when all of these hold: no pass is running, the number of recorded passes is below `max_passes`, at least one lane has a launched session and no accepted completion, and either the cadence elapsed since the previous pass ended (or since the first lane's launch for pass 1) or a lane wrote a `completed` completion since the previous pass started (a **completion pass**, so work claimed complete is reviewed at once). The pass is a `Popen` child polled by the loop, never a blocking wait: completions, questions and deadlines are handled as today while it runs. Past `pass_timeout_seconds` the child's process group is terminated and the pass is recorded as `timed_out`.

The **final pass** runs once every lane's completion is accepted and before `wait_handoffs` returns, regardless of cadence and even at `max_passes` (it is the only pass allowed past the budget); its output fills `handoff` in the ledger. A manual run gets it from `$PY -m workflow sidecar-pass "$RUN" --final` before `freeze`; `freeze` then closes the node from the ledger as it stands and records "no final pass" in the `succeeded` event when none ran.

`$PY -m workflow sidecar-pass "$RUN" [--final]` runs one pass synchronously in any mode (refused while one is running, after freeze, or when the plan has no sidecar); automatic runs use it only for debugging.

A controller stopped during a pass (Ctrl-C, exit 75): on restart, a `sidecar.running.json` whose process is gone is recorded as an `interrupted` pass and removed; the loop continues. `drive()`'s error path terminates a running pass before stopping the workers.

### 4.3 What a pass reads

The controller writes `<run>/sidecar-inputs/<n>/`:

- `manifest.json`: run id, pass number, trigger (`cadence`, `completion`, `final`, `manual`), base commit, per lane `{worktree, head_commit, state (idle|working|blocked|done|stopped|unknown), completion (null or the accepted or pending status), question_waiting, deadline, diff_file, pane_file, untracked}`, and the paths below.
- `<lane>.diff`: `git diff --binary <base_commit>` in the lane's worktree (tracked changes, committed or not) plus the list of untracked files (`git ls-files --others --exclude-standard`); the files themselves are readable in the worktree.
- `<lane>.pane.txt`: the visible pane text (`herdr pane read <pane> --source visible`, passed through the escape stripping the old observer used) when Herdr and `terminals.json` are available; otherwise absent and `pane_file: null` in the manifest. The transcript tail is deferred (section 7).
- `<lane>.completion.json` and `<lane>.questions.json`: copies when they exist.
- `ledger.json`: the ledger as it stands before the pass.
- `tasks/`: the pinned task files, `decisions.md`, the pinned policy (owned paths and checks) and the challenge record.

The job's `--add-dir` lists the inputs directory and every lane worktree (read-only by construction: the job has no Write, Edit or Bash). It never sees the controller's own files beyond these. The inputs of finished passes are kept for the viewer and the tests; a run keeps at most the last eight inputs directories (older ones are deleted when a new pass starts, the ledger keeps their summaries).

### 4.4 What a pass returns and how the ledger changes

Output (`$defs.output` of the schema): `summary` (one paragraph), `findings[]` (upserts), `messages[]`, `escalations[]`, `handoff` (null except on the final pass). Each finding upsert has `id` (`null` for a new one, else an existing `S-<n>`), `category` (`defect`, `risk`, `structure`, `operational`, `suggestion`), `severity` (`P0`, `P1`, `P2`), `lane`, `file`, `locator` (line or symbol), `revision` (the lane head commit or `working-tree`), `problem`, `evidence`, `remedy`, `disposition`, `note`.

The controller merges, refusing the whole output (pass `rejected`, ledger unchanged) when: an id is unknown; a lane is not in the plan; a transition is illegal (`verified_resolved` and `withdrawn` need a non-empty `evidence`; `accepted_trade_off` needs a non-empty `note` naming the owner decision; a terminal disposition (`verified_resolved`, `withdrawn`, `accepted_trade_off`) is reopened only with a new `evidence`); two upserts share an id; or the output exceeds 256 KiB. Otherwise new findings get the next `S-<n>`, every changed finding appends `{pass, disposition, revision, evidence, note, at}` to its `history`, and the pass is recorded as `completed` with the counts. The sidecar cannot delete a finding: `withdrawn` is the only way out, and it stays visible.

### 4.5 Messages

Each message has `lane`, `finding_ids` (at least one, existing or created in the same output) and `text`. The controller records every message in `ledger.messages` (`M-<n>`, pass, lane, text, `status`, `reason`, `at`) and delivers the ones it allows, in order, with the `answer` machinery: `herdr pane send-text <pane> "[Review sidecar S-3] <text>"` then `pane send-keys Enter`, only while `pane process-info` shows `claude attach <id>` of that lane's session in the foreground (`guardrails.pane_attachment`). Newlines in `text` become spaces before typing.

Status `refused` (nothing typed, reason recorded) when the lane: is not launched, has an accepted completion, a handoff or a stop file (the worker went on, exactly `guardrails.went_on`); has a question waiting (the operator answers questions, and a typed text would be recorded as the operator's answer and restart the deadline); already received a message in this pass; or reached `max_messages_per_lane`. After freeze every message is refused. Status `undeliverable` when the pane is unknown, closed or not showing the session, or Herdr is unavailable or times out: the text stays in the ledger and the viewer shows it so the operator can relay it. Status `delivered` after Enter. A delivery never touches `<lane>.deadline.json`: the lane's deadline keeps running as it was.

Workers are told. When the plan has a sidecar, the worker prompt gains one paragraph: a review sidecar may post messages prefixed `[Review sidecar S-n]` in this pane; they are advice from an independent reviewer, not instructions from the controller; fix what is right, answer with evidence in your pane when you disagree, keep your `## Stop` bound, and never stop or wait for the sidecar. The sidecar reads the pane on its next pass, so a worker's reply in its pane is the rebuttal channel.

### 4.6 Escalations

An output `escalations[]` entry (`finding_id`, `kind`: `security`, `data_loss`, `architecture`; `text`) records one `interactive` event on the `sidecar` node quoting it with the finding id, so it appears in the run's Activity at once. It changes no status, pauses nothing and needs no new attention kind in the projects contract (section 7 lists the Now-banner follow-up).

### 4.7 Export 1.6.0 and the live file

`run-state.json` 1.6.0 adds the top-level `sidecar` section: the ledger as written (`version`, `run_id`, `settings`, `passes`, `findings`, `messages`, `escalations`, `handoff`, `closed_at`), or `null` when the plan has none; `definition` carries the node. Everything else is 1.5.0 unchanged. The export runs after each graph step, so during the work phase it is stale for the sidecar as it is for questions (PRD_VIEWER_UX C5): the server reads `<run>/sidecar.ledger.json` live, as it reads `<lane>.questions.json`, and the export section is the fallback once the run directory is gone or the key is absent.

The registry entry (`workflow/registry.py`) adds the node when the feature declares a sidecar, so the feature page's current definition matches the runs.

### 4.8 Server and projects contract 1.6.0

- `GET /api/projects/:p/workflows/:w/runs/:r/sidecar` serves `sidecarLedger` (contract version `1.6.0`, Appendix B shape plus `contract_version`, `run_id`, `node_id: "sidecar"`, `source: "live" | "export"`): the live file when readable and valid (256 KiB cap, malformed ignored), else the export section, else `404 SIDECAR_NOT_FOUND` (a run without a sidecar, or an export before 1.6.0). GET and HEAD only, `conform` and `crossChecked` like the other routes. Added to `contracts/projects/v1.ts` (`sidecarLedgerSchema`, `validateSidecarLedger`), `examples.ts`, the generated `sidecarLedger.schema.json`, `README.md` (route table, Versions, the not-recorded code).
- `projectSnapshot`: the `sidecar` node's status comes from the ledger: `pending` with no pass, `running` with a pass or a running marker and no `closed_at`, `succeeded` with `closed_at`; never `failed`. `EXPORT_VERSIONS` gains `1.6.0`; a section schema for `sidecar` (strict inside, nullable).
- `triage.ts`: `focusOf` never picks `sidecar` while any `launch_` or `verify_` node is running (it is never failed or paused, so it can only steal the running focus); `buildGaps` ignores the sidecar span when deciding whether a silence is a gap; `lists.ts` `who()` says "review sidecar" for it. The run's `activity` (headline, attention, focus) for a run with a sidecar equals the same run without it, and `server/projects.test.ts` asserts that on the seeded sidecar runs.

### 4.9 Viewer

The node page `/nodes/sidecar` follows the node shell (PRD_VIEWER_UX 4.3): header with `Review sidecar`, status by cause, timing from the `running` and `succeeded` events, executor "agent" (solid outline, no new legend entry: `clarity.spec.ts` keeps three). Above the section index, one headline: `5 passes · 2 open (1 P1) · 3 messages delivered, 1 undeliverable · last pass 12:40 UTC (4 min ago)`; a run whose sidecar has not run yet says `no pass yet`; failed passes are counted in the headline (`2 of 5 passes failed`). Sections, each absent when empty, History last:

- **Open** (`sidecar-open`): findings with disposition `open`, `acknowledged` or `fix_reported`, P0 and P1 first, then by id; each a card with severity, category, id, lane, `file:locator`, revision, problem, evidence, remedy, disposition chip and the ids of the messages sent for it.
- **Escalations** (`sidecar-escalations`): kind, finding, text, time.
- **Resolved** (`sidecar-resolved`): `verified_resolved`, `accepted_trade_off` and `withdrawn`, one line each (id, severity, lane, file, disposition, the evidence of the last transition), the list closed by default.
- **Messages** (`sidecar-messages`): time, lane, status chip (`delivered`, `undeliverable` with its reason, `refused` with its reason), finding ids, text.
- **Passes** (`sidecar-passes`): a table of n, trigger, start, duration, status (`completed`, `rejected`, `failed`, `timed_out`, `interrupted`), lanes read (with "pane not captured" when absent), summary.
- **Handoff** (`sidecar-handoff`): the five final lists when the final pass ran, else "no final pass recorded".
- **History**: the node's events, as every node.

Data: `RunView` polls the ledger every 5 s like inputs (`usePoll`), passes it to `NodeDetail`, and stops polling with the run; it is never cached as immutable (`useRunReview` is not used). The graph shows the node in the launch column; the Steps table gets its row and span from the events with no new code. At 390 px the cards stack, no horizontal overflow. The viewer stays read-only (`expectNoExecutionControls`). Test ids: `sidecar-headline`, `sidecar-finding` (with `data-severity`, `data-disposition`, `data-lane`), `sidecar-message` (`data-status`), `sidecar-pass` (`data-status`), `sidecar-escalation`.

## 5. Work items

Lane `engine` (Python, workflow contracts, docs):

1. `contracts/workflow/feature.schema.json` 2.3.0 with `sidecar`; `contracts/workflow/sidecar.schema.json` (Appendix B, `$defs.output`); `contracts/workflow/README.md`; `workflow/prompts/sidecar/senior-review.md` from Appendix A.
2. `workflow/launch.py` validation and `prepare --sidecar-brief <path> --sidecar-settings <json>` (or the plan key written by `prepare`), `workflow/scaffold.py` writes 2.3.0 with the sidecar commented in the README, `workflow/sessions.py` reserved names.
3. `workflow/sidecar.py`: inputs, prompt, the print job (reuse `guardrails.print_command` and `popen_claude`), output validation, ledger merge, message gating and delivery (reuse `guardrails.pane_attachment`, `question_lock`, `went_on`), the running marker, `sidecar-pass`.
4. `workflow/automatic.py`: the pass scheduling in `wait_handoffs`, the final pass, the error path; `workflow/pipeline.py`: `freeze` closes the node, the CLI action, the worker prompt paragraph; `workflow/interactive.py`: the pane capture helper.
5. `workflow/export_state.py` 1.6.0, `workflow/registry.py`, `workflow/README.md`, `workflow/RUNBOOK.md` (a "Review sidecar" section: files, bounds, the message rules, the manual command), `test_guardrails.ExportSeam` to 1.6.0.
6. `workflow/test_sidecar.py` (section 6) with a fake print job in the style of `test_guardrails.GuardedFeature` and a fake Herdr in the style of `AnswerDelivery`; `test_export.py` and `test_portable.py` additions.

Lane `viewer` (server, projects contract, UI, browser tests):

7. `contracts/projects/v1.ts` `sidecarLedgerSchema` and 1.6.0, `examples.ts`, regenerated schema, `README.md`, `contract.test.ts`.
8. `server/projects.ts` (`EXPORT_VERSIONS`, reserved ids, the section, the snapshot status, the live read, `RunStore.sidecarLedger`), `server/projectRoutes.ts` route, `server/projects.test.ts` (parsing, live-over-export precedence, 404 codes, snapshot status, `SEEDED_SNAPSHOTS`/`SEEDED_ACTIVITY` entries for the new fixtures, unchanged activity with and without the sidecar).
9. `contracts/projects/triage.ts` focus and gap rules, `src/projects/lists.ts`, `status.ts` (`SIDECAR_NODE_ID`, `isSidecarNode`, executor wording), `steps.ts` labels, `api.ts` (`paths.sidecar`, `fetchSidecarLedger`, `NOT_RECORDED`), `RunView.tsx` polled resource, `NodeDetail.tsx` classification (a review-kind node is the review only when its id is `review`), `node/SidecarSections.tsx`, pure `node/sidecar.ts` (headline, ordering, grouping; no React import), `node/sidecar.css`.
10. `tests/unit/sidecar.test.ts`, additions to `triage.test.ts` and `steps.test.ts`; `tests/project-workflows/fixtures/ux-sidecar.ts` registered in `fixtures/index.ts`, the `mock.ts` route, `tests/project-workflows/sidecar.spec.ts` (section 6, both phases).

## 6. Acceptance scenarios

Engine (`workflow/test_sidecar.py`, no model calls):

| Scenario | Asserts |
| --- | --- |
| declare | 2.3.0 with `builtin:senior-review` and with a file brief launches; `sidecar` on 2.2.0, an unknown builtin, an empty file, a value out of bounds and a lane named `sidecar` are refused before any Git action with the file and key named; a feature without `sidecar` is unchanged (same commands, graph, plan keys) |
| graph | the plan, the export definition and the registry entry carry the `sidecar` node after `challenge` and `handoff` depends on it; with `challenge: false` it depends on nothing; a feature without it has the 1.5.0 node list |
| pass-inputs | the fake job sees `--tools Read,Glob,Grep`, no `--bg`, `--add-dir` with the inputs and every worktree, a manifest naming both lanes, their diffs with an uncommitted change and an untracked file, the pane text when the fake Herdr serves it and `pane_file: null` when not |
| ledger-merge | a new finding gets `S-1`; the next pass moves it to `fix_reported` and then `verified_resolved` with evidence and a two-entry history; `verified_resolved` without evidence, an unknown id, an unknown lane and a duplicate id each reject the output and leave the ledger byte-identical |
| messages | a message to a working lane with its pane attached is `delivered` (send-text with the prefix, then Enter); a lane with a question waiting, a lane whose completion was accepted, a second message to the same lane in one pass and the seventh message of a run are `refused` with the reason and nothing typed; a pane in its shell and a Herdr timeout give `undeliverable`; `<lane>.deadline.json` is unchanged after every case |
| scheduling | with a fake clock, pass 1 starts at launch plus cadence, pass 2 at once when a lane writes `completed`, nothing starts while a pass runs, nothing past `max_passes` except the final pass, and the final pass runs after the last completion is accepted and before freeze; a pass past its timeout is `timed_out` and the next one runs |
| never-blocks | a job that exits 1, returns malformed output, returns another session id or is interrupted (a stale running marker) records that pass status, an `interactive` event, and the run reaches its verified branch |
| freeze | the `succeeded` event at freeze carries the counts; a manual run without a final pass says "no final pass"; `sidecar-pass` is refused after freeze; export 1.6.0 carries the ledger and `null` for a run prepared without (`ExportSeam`) |
| worker-prompt | the worker prompt holds the sidecar paragraph only when the plan has a sidecar |

Viewer (`tests/project-workflows/sidecar.spec.ts`, both phases, one `[scenario:<id>]` test each with `screenshot:<id>`):

| Scenario id | Asserts |
| --- | --- |
| sidecar-node | the sidecar page shows the headline counts from the fixture, Open before Resolved with P1 before P2, each open card's lane, file and evidence, the messages with `delivered`, `undeliverable` (reason) and `refused` (reason) chips, the passes table with a `failed` and a `timed_out` row, the handoff lists, History last, `expectNoExecutionControls`; at 390 px no horizontal overflow |
| sidecar-live | worker phase: after the mocked ledger changes a finding to `verified_resolved`, the page shows it under Resolved within one poll without reload (`page.clock`); candidate phase: a seeded run whose live `sidecar.ledger.json` is newer than its export shows the live counts and `source: live` |
| sidecar-run | the run page graph has the `sidecar` node in the launch column with the agent outline and the legend still has three entries; the Steps table has its row and span; with the sidecar and two lanes running the Now banner names a lane, not the sidecar, and the run headline equals the no-sidecar fixture's; a run without a sidecar has no such node and `/sidecar` answers 404 shown as "not recorded" |

Server (`server/projects.test.ts`): a 1.6.0 export with and without the section loads; a 1.5.0 export still loads and `/sidecar` is `SIDECAR_NOT_FOUND`; the live file wins over the export and a malformed live file falls back; the snapshot status per ledger state; the integrated run with a closed sidecar is `succeeded`, never `paused`.

## 7. Open questions

- **Reviewers and the sidecar's handoff.** Default: the post-freeze reviewers do not receive the ledger (independence, as PRD_PARALLEL_REVIEWERS decided for reviewers among themselves); it sits in the run directory and the viewer for the operator. A later `sidecar.brief_reviewers: true` could append the unresolved findings as claims to verify.
- **Now banner.** Default: an escalation is an event and a section, not an attention kind; adding `escalation` to `ATTENTION_KINDS` is a projects contract change for a later slice.
- **Transcript tail.** The visible pane is a thin rebuttal channel. Default: deferred; the input layout leaves room for a `<lane>.transcript.txt`.
- **Worker effort and model.** Default: the pass uses `ANTHROPIC_MODEL` like the challenge and takes no `--effort`.
- **Pane for the sidecar.** Default: none; a Herdr pane tailing the ledger is a convenience for later.

## 8. How to run

Offline: `python -m workflow.run_tests`, `npm run test:contracts`, `npx tsx --test server/projects.test.ts`, `npm run test:unit`, the project-workflows Playwright suite in both phases.

Live smoke after integration, before relying on it: a scratch feature in a scratch repository (`init`, two trivial lanes, `sidecar: {"prompt": "builtin:senior-review", "cadence_seconds": 120}`), `launch --live --automatic`; expect `sidecar-inputs/1/` within two minutes of the launches, a message typed into one pane with the `[Review sidecar S-1]` prefix, the ledger on the node page while the lanes run, the final pass before freeze, and the run reaching its verified branch. Then restart the live API (it does not watch `server/`).

## Appendix A: the bundled brief `builtin:senior-review`

The text of `features/review-sidecar/senior-review-brief.md` (the operator's brief, verbatim), installed as `workflow/prompts/sidecar/senior-review.md`. The controller appends the protocol block of section 3; the brief states only what to look for and how to behave.

## Appendix B: the ledger (`contracts/workflow/sidecar.schema.json` 1.0.0)

Pinned here because both lanes build to it: the engine writes it, the viewer's fixtures copy it. Any deviation found necessary is recorded in the lane's handoff and the other lane's fixtures follow the engine's committed schema at integration.

```json
{
  "version": "1.0.0",
  "run_id": "review-sidecar-smoke-001",
  "settings": {"cadence_seconds": 900, "pass_timeout_seconds": 600, "max_passes": 16, "max_messages_per_lane": 6},
  "passes": [
    {"n": 1, "trigger": "cadence", "started_at": "2026-10-01T12:10:00Z", "finished_at": "2026-10-01T12:14:20Z", "status": "completed", "session_id": "0f2b3c6e-4a4d-4b8e-9d1a-6b2f1c0a9e11", "lanes": {"engine": {"head_commit": "a1b2c3d", "pane_captured": true}, "viewer": {"head_commit": "a1b2c3d", "pane_captured": true}}, "counts": {"new": 1, "changed": 0, "messages": 1}, "summary": "One P1 in the engine lane's merge; the viewer lane has no diff yet."},
    {"n": 2, "trigger": "completion", "started_at": "2026-10-01T12:40:00Z", "finished_at": "2026-10-01T12:50:00Z", "status": "timed_out", "session_id": null, "lanes": {"engine": {"head_commit": "b2c3d4e", "pane_captured": false}, "viewer": {"head_commit": "c3d4e5f", "pane_captured": true}}, "counts": {"new": 0, "changed": 0, "messages": 0}, "summary": null}
  ],
  "findings": [
    {
      "id": "S-1", "category": "defect", "severity": "P1", "lane": "engine",
      "file": "workflow/sidecar.py", "locator": "merge_output", "revision": "a1b2c3d",
      "problem": "A rejected output still appends the pass to the ledger before validation, so a malformed output leaves a half-written pass.",
      "evidence": "merge_output writes passes[] at line 88 and validates at line 102; test_sidecar has no case for it.",
      "remedy": "Validate first, then write the pass and the findings in one atomic replace.",
      "disposition": "fix_reported",
      "note": null,
      "messages": ["M-1"],
      "history": [
        {"pass": 1, "disposition": "open", "revision": "a1b2c3d", "evidence": "see finding", "note": null, "at": "2026-10-01T12:14:20Z"},
        {"pass": 3, "disposition": "fix_reported", "revision": "b2c3d4e", "evidence": "pane: 'fixed S-1, validating before the write'", "note": null, "at": "2026-10-01T13:05:00Z"}
      ]
    }
  ],
  "messages": [
    {"id": "M-1", "pass": 1, "lane": "engine", "finding_ids": ["S-1"], "text": "merge_output appends the pass before validating the output; a malformed output leaves a half-written ledger. Validate first and write once.", "status": "delivered", "reason": null, "at": "2026-10-01T12:14:21Z"},
    {"id": "M-2", "pass": 3, "lane": "viewer", "finding_ids": ["S-2"], "text": "…", "status": "refused", "reason": "question_waiting", "at": "2026-10-01T13:05:01Z"}
  ],
  "escalations": [],
  "handoff": null,
  "closed_at": null
}
```

Enums: pass `trigger` `cadence|completion|final|manual`; pass `status` `completed|rejected|failed|timed_out|interrupted`; `category` `defect|risk|structure|operational|suggestion`; `severity` `P0|P1|P2`; `disposition` `open|acknowledged|fix_reported|verified_resolved|withdrawn|accepted_trade_off`; message `status` `delivered|undeliverable|refused`; message `reason` `null|question_waiting|lane_finished|lane_not_launched|rate_limited|after_freeze|pane_unknown|pane_not_attached|herdr_unavailable|herdr_timeout`; escalation `kind` `security|data_loss|architecture`. `handoff` is `null` or `{unresolved: [...], structural: [...], verified_resolved: [...], withdrawn: [...], gaps: [...]}` of strings. `closed_at` is set at freeze. `$defs.output` is what the job returns: `{summary, findings: [upsert], messages: [{lane, finding_ids, text}], escalations: [{finding_id, kind, text}], handoff}` where an upsert is a finding without `messages`, `history` and with `id` nullable.
