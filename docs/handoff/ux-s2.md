# Handoff: Viewer UX slice S2, the triage model

Slice S2 of [PRD_VIEWER_UX.md](../PRD_VIEWER_UX.md) (section 11). Branch `ux/s2`, made from `feature/viewer-ux`. S2 changes nothing in `src/`, `server/`, `package.json` or any browser spec.

## What shipped

`contracts/projects/triage.ts` is new. It is pure TypeScript: it imports only types and `isBlockingFinding` from `v1.ts`, and it uses no React, no DOM and no I/O. The client (S3) and the server (S5) can both import it. Its exports:

| Export | PRD | What it gives |
|---|---|---|
| `buildTimeline(run)` | 5.1, 5.2 rules 1-11 | `runStart`, `runEnd`, `lastActivity`, `spans` (one per node attempt, per lane for the candidate), `markers`, `gaps`, `byNode` and `activity` (the Activity rows, oldest first, with PID rows flagged `controller_log`). It is memoized per run on the served state. |
| `deriveNow(run)` | 6.2 | `situation` (the `data-situation` id), `interruption` (rule 5 case a-d), `tone`, `glyph`, `focus`, `lane`, `since`, `headline`, `reason` and `reasonSource` (0-4), `next` and `missing` |
| `deriveFocus(detail, events)` | 6.2 focus rule | the focus node with its label, kind, status and `since` |
| `deriveAttention(run)` | 6.4 | `top` (question > pane > approval) and `nodes`, one kind per node, for `data-attention` |
| `humanizeEvent(event)` | 5.3 | known phrases reworded, SHAs cut to 7 characters, session UUIDs kept whole, the B1 `[lane] ` prefix dropped |
| `gateReasonsByCheck(message, checks)` | 4.6 | `reasons`, `gate` (unkeyed) and `byCheck`. A `<path>` tail is attached to a check only when exactly one check's command ends with it. |
| `attemptResultUris(detail, node, {last})` | 4.4 | the `results/<lane>/<k>` and `results/candidate_<lane>/<k>` URIs, oldest first per lane |
| `nowResultUris(detail, events?)` | 6.2 source 2 | what the Now banner and the lanes line read: the failing focus's latest two attempts, plus each lane's candidate result when there are 2 or more lanes. When the events are passed, a verify retry that is still running is left out: its result does not exist until the retry ends. `Now.missing` is always a subset of this list. |
| `laneLines(run)` | 4.2 lanes line | one line per lane (worker · verify · candidate) for runs with 2 or more lanes, else `[]` |
| `controllerNotRunning(readings)` | 6.3 | the 15 s `not_running` debounce, used by rule 5(c) and the S6 chip |
| `textToString(text, now, format)`, `plainTextFormat` | — | flattens the rich `Text` parts. S3 passes S1's zone-aware formatters, or renders the parts itself. |
| `COMMAND_CAPTION`, `COMMAND_LEGEND`, `MAX_QUESTIONS`, `CONTROLLER_DEBOUNCE_MS`, `GAP_MS` | 6.1, 6.3 | fixed wording and limits |

**Next steps are data.** `next` has this shape:

```
{ action: 'required' | 'none' | 'unknown', label, runbook: {section, topic}[], steps: ({kind:'command', text, caption?} | {kind:'text', text})[], caveat }
```

- Commands use the RUNBOOK form, `"$PY" -m workflow <verb> "$RUN" …`.
- Every value the viewer cannot know stays a placeholder: `<fixes-feature>`, `<target repo>`, `<new run id>`, `<sha>`, `"<why>"`, `"<reason>"` and `"<your answer>"`. The one filled-in value is the approval hash, which comes from the review.

**Rich text.** The headline and the reason are arrays of plain strings mixed with these parts:

- `{kind:'clock', at}`: a time of day
- `{kind:'ago', at}`: a relative time
- `{kind:'span', ms}`: a duration
- `{kind:'elapsed', from}`: time since an instant
- `{kind:'left', until}`: time until an instant

The model therefore holds no time zone and no `now`. The UI renders the parts as `<time>` elements with S1's formatters and its ticking `useNow`.

**Fixtures.** Three trimmed fixtures are in `tests/unit/fixtures/runs/`: `skeleton-001.json`, `skeleton-fixes-001.json` and `workflow-guardrails-001.json`.
- Each holds `{detail, events, inputs, review, results}`, taken from the captured `ux/api/*.json` payloads.
- Only text the tests never read was shortened: task and prompt texts, `decisions.md`, long summaries and file artifacts.
- The test validates every fixture against the contracts when it loads it.
- The capture has no `results/game/1` for skeleton-001, and no `results/controller/1` or `results/candidate_ui/1` for guardrails. The test derives each of them from a captured sibling result plus the event that recorded its verdict. The test file's header documents this.

## Red evidence

The tests were written first against a skeleton `triage.ts`. Its types were final and its functions returned empty values, or `no_rule_matched` with no RUNBOOK section. It was run with:

```
npx tsx --test tests/unit/triage.test.ts
ℹ tests 46   ℹ pass 1   ℹ fail 45        (42 AssertionError, 3 TypeError from destructuring empty span lists)
```

Key failing lines:

```
re-reads challenge attempts 1-3 …        actual: []  expected: [[1,'no_record'],[2,'failed'],[3,'succeeded']]
times the verify attempts …              actual: []  expected: [[1,'failed',67],[2,'failed',67],[3,'succeeded',75]]
diagnosis and repair markers …           actual: undefined  expected: 'game'
spans the run … 52m51s                   actual: undefined  expected: '2026-09-24T09:32:31.411386Z'
keeps PID checkpoints in the controller log   actual: 0  expected: 5
is memoized …                            Values have same structure but are not reference-equal
deriveNow review_blocked … (all 20 cases)     AssertionError: names its RUNBOOK section   (the stub answers no_rule_matched with no section)
gateReasonsByCheck (3 cases)             actual: []  expected: ['unit','integration'] / ['project-workflows-browser'] / gate-level + attached
deriveAttention orders question > pane > approval   actual: undefined  expected: 'question'
humanizeEvent                            actual: 'Awaiting explicit completion signal; idle is not acceptance'  expected: "waiting for the worker's completion signal …"
laneLines                                actual: []  expected: two lane lines
```

Only one test passed against the skeleton, and it passed vacuously: "clears a pane once any later event names that node" asserts that there is no attention, which is exactly what the stub returns.

The first red run was made before the Activity-ordering test existed. That test was added after green, to pin the polish described below. The whole final test file was then run again against the saved skeleton, which gave the counts above, and the implementation was restored (its sha256 was checked).

**Test-authoring mistakes, fixed before the first red run and not product reds:**
1. The synthetic runs inherited skeleton-001's launch receipt at 08:50, so the expected deadline in the `running` case was wrong. `synthetic()` now puts `native_started_at` at the run's t0.
2. The scope case built an event tuple with a `null as never` placeholder. It was rewritten as a plain sorted list.
3. The approval case expected "(12 min)" and the running case expected "5m ago", which assumed a coarser duration format than the model's parts render. They now expect the relative part ("12 min ago") and the span part ("5m00s").

**Product bugs found on the way to green:**
1. The first full run failed 4 tests with `TypeError … reading 'status'`: the candidate-result lookup built nested arrays. It is fixed with a flat map.
2. `tsc` then reported an unused parameter, which was removed.
3. A read-through of the model's output on the three real runs found four rough edges, all fixed and now pinned by the Activity test:
   - An event that ended one attempt and opened the next showed as a single "end" row.
   - The review's closing row showed raw session ids instead of the verdict.
   - The inferred approval row sorted after the integrate row that shares its instant.
   - The repair note carried a "(restated)" suffix.

### Review round

An independent review reported seven defects and four gaps in 12.1 and 6.2. All of them were checked against `server/projects.ts` (`projectSnapshot`, `EVENT_STATUS`) and `workflow/automatic.py`, and all were real. The cause of most of them: `projectSnapshot` serves a node as `failed` while its task keeps a graph error. It ranks `task.error` first, and any failed node makes the run `failed`. That error stays until the step that re-enters the node ends:
- `retry_check` clears nothing, and `advance()` re-exports only after a step;
- the freeze and review outage notes keep the task error.

Three 12.1 tests passed only because they built snapshots the server never serves: `check_failed` with the run `running`, and interrupted (b) freeze and review with the node `paused`.

The new and corrected tests were written first. The final test file was then run against the committed model (1913c20). After that run, the fixed model was restored and its sha256 was checked.

```
npx tsx --test tests/unit/triage.test.ts
ℹ tests 60   ℹ pass 45   ℹ fail 15        (15 AssertionError)
```

Key failing lines:

```
keeps a retried attempt running … (skeleton #16)          actual: [2,'failed',true,false]   expected: [2,'running',true,true]
check_failed (skeleton-001 as served at #14)              actual: 'no_rule_matched'         expected: 'check_failed'
check_failed: while the retry runs (skeleton #16)         actual: 'no_rule_matched'         expected: 'check_failed'
check_failed: a candidate lane retry (guardrails #30)     actual: 'no_rule_matched'         expected: 'check_failed'
interrupted (a): the resumed controller's PID row ends it actual: 'interrupted'             expected: 'running'
interrupted (a): also on a run served failed (:1316)      actual: 'no_rule_matched'         expected: 'interrupted'
interrupted (b): review outage, served failed (:811)      actual: 'no_rule_matched'         expected: 'interrupted'
interrupted (b): freeze note, served failed               actual: 'no_rule_matched'         expected: 'interrupted'
interrupted (b): a resumed controller's PID row ends it   actual: 'interrupted'             expected: 'running'
interrupted (c): since is the current streak's start      actual: '…T10:00:10…'             expected: '…T10:50:00…'
interrupted (c): also while an automatic retry is served failed   actual: 'no_rule_matched' expected: 'interrupted'
blocked_identical: the same reason on another revision    actual: 'blocked_identical'       expected: 'check_failed'
blocked_identical: attempts on either side of a repair    actual: 'blocked_identical'       expected: 'check_failed'
no_rule_matched: C6 aliased block, as source 4            actual: null                      expected: 4
lanes line, guardrails as served at #25                   actual: 'verify ✗ attempt 2 (2 failed)'   expected: 'verify ● attempt 2 (1 failed)'
```

The positive control passed before the fix and after it. It is two identical failures on one revision with no diagnosis row, which still reads `blocked_identical`.

**Test-authoring mistakes in this round, not product reds:**
- The first draft used an invented outage text, "Claude Code is unavailable.", inside single-quoted strings.
- A stray assertion on a field `Now` does not have was also removed.

Both were fixed before the red run. The real sessions.py:272 wording is now the `OUTAGE` constant. It also showed that the model's `UNAVAILABLE` pattern missed that wording, which is fixed below (deviation 25).

The reviewer's scenarios were then re-derived from the captured payloads as served at each sequence:
- **skeleton-001.** #14 and #15 read `check_failed`, with no command and nothing missing. #16 adds "· attempt 2 running since 09:20" and reads only `game/1`. #17-#19 read `blocked_identical`.
- **guardrails.** #28-#30 read `check_failed` on lane ui.

## Green evidence

```
npx tsx --test tests/unit/triage.test.ts              ℹ tests 60  ℹ pass 60  ℹ fail 0
npx tsc -b                                            exit 0
npx eslint contracts/projects/triage.ts tests/unit/triage.test.ts   exit 0
```

The unit tests cover every case in 12.1:
- **`buildTimeline`.** The 12.1 items, plus a retried attempt that is live while its node reads failed, and that ends at a later PID row.
- **`deriveNow`, one case per `data-situation`:**
  - `review_blocked`;
  - `blocked_identical`, plus the same-revision cases: one revision, another revision, and across a repair;
  - `succeeded`;
  - `question`, from the export and from the event log;
  - `pane_attention`: worker, reviewer, and cleared by a later event;
  - `interrupted`:
    - (a), plus ended by a resumed PID row (without B1 and with it) and on a run served failed;
    - (b) review: Ctrl-C served paused, an outage served failed, and resumed;
    - (b) freeze: served failed, and resumed;
    - (c), plus its `since` and during a served-failed retry;
    - (d): automatic and retry;
  - `blocked_before_freeze` ×4;
  - `challenge_paused`;
  - `awaiting_approval`;
  - `check_failed`: automatic as served at #14 and during the #16 retry, the guardrails candidate retry, manual, and stopped by a controller block;
  - `running`;
  - `inactive`;
  - `no_rule_matched`: failed, paused, and the C6 aliased block;
  - scope.
- **The other exports.** `gateReasonsByCheck` ×3, `deriveAttention` ×2, focus, humanize, URIs, and lanes, including a running retry.

Every `deriveNow` case also passes two checks against the real sources:
- **CLI.** Each command's verb and every `--flag` must appear in the argparse of the module that owns the verb: `pipeline.py` `main`, `guardrails.py` `resume_main` and `answer_main`, `repair.py` `repair_main`, `scaffold.py` `main`, `launch.py` `main` and `interactive.py` `main`. `"$RUN"` must directly follow the verb.
- **RUNBOOK.** Each `runbook` reference must be an exact `workflow/RUNBOOK.md` heading, and its topic must be a `**bold**` label inside that section.

No Playwright was run. S2 has no browser scenario in 12.2 and no migration in 12.3, and it changes no component, spec or `src/` file.

## Migrations

None. S2 changes no existing file.

## Deviations from the PRD

**API shape**

1. **`buildTimeline` input.** It takes `{detail, events, inputs?, review?, results?}` instead of `{definition, snapshot, events, inputs, review?, laneResults?, now}`. It takes no `now`: a live span has `end: null` and `live: true`, and the UI measures it with its own clock, so the memoized timeline does not go stale every second.
   - `results` is a map from result URI to result. Lane matching and the setup/check split read it.
2. **Memo key.** It is a superset of the PRD's key: `last_sequence`, the run and node statuses, attempts and result URIs, the event count and last sequence, and the inputs, review and results objects by identity.
3. **`controller_blocked` marker kind.** It is added to the union: 5.2 rule 5 names it, but 5.1's list omits it. A "failed identically" row is one `diagnosis` marker with `blocked: true`, not two markers.
4. **Activity rows.** `Timeline.activity` is an addition beyond 5.1's return shape, so S3 can render Activity directly. `lastActivity` includes the review verdict and the stop receipts; B2's `last_activity_at` is defined over raw events only.
5. **Rich text.** Headlines are rich text. The approval's "(12 min)" renders from an `ago` part as "12 min ago", and "working 5m" renders through the span formatter.

**Classification of controller rows**

6. **Stop-confirmation failures.** A `Could not confirm worker stop: …` failure that the controller recovered from is a `controller_error` marker, not a handoff failure. Recovered means a later PID checkpoint, or the node succeeded later. Guardrails #7, #10, #13 and #16 are examples. PRD rule 2 names only `^[Errno` failures.
7. **B1's rule, applied in the client until B1 lands.** Rows on `launch_controller` that match B1's controller-process patterns are treated as run-level. 5.2 rule 2 intends this.

**Timeline values**

8. **Gap rows.** No gap row is emitted while a non-worker step is running, because that step's bar already shows the time. The PRD's catch-all is "no activity".
   - The PRD's "worker working 28m21s" is the worker's span. The gap itself runs from the last PID row to the stop receipt: 28m18s.
9. **Rounding.** Durations round to the nearest second, which matches the PRD's 1m07s, 1m06s, 2m10s and 52m51s. Two PRD values differ:
   - Challenge attempt 2 is 46.8 s, so it shows as 47s; the wireframe says 46s.
   - Guardrails' run span is 54m20s under rule 10. PRD 4.1 says 54m21s, which counts the trailing PID row that rule 10 excludes.
10. **Focus ties.** "Ties go to the latest event" is read as nodes in the same graph column, meaning parallel lanes. Among those, the latest status event wins, then definition order.

**Situation rules**

11. **Rule 1 (question).** A question counts only while the run is not finished and the lane has not been stopped, because `answer` refuses once the worker went on.
12. **Rule 3 (awaiting approval).** Two command forms go beyond the PRD:
    - A manual review gate that awaits the import gets `review "$RUN" --review-file <review.json>`, with a text step about `--reviewer <id>` (RUNBOOK §5).
    - A manual handoff gets one `freeze "$RUN"` command with a `--handoff <lane>=<lane-handoff.json>` flag per lane, which is the RUNBOOK §4 form.
13. **Rule 5 (d), repair continuation.** The rule also matches a paused candidate after a candidate repair. It takes the `Continue with …` text from the latest `Repair n by the operator` note on a `verify_<lane>` node, because repair.py:442 writes the note there. The candidate's own note is "Repair n supersedes …".
14. **Rule 7 (blocked, identical failure).** Step 4, "the same without --dry-run", is a copyable command with a caption rather than plain text.
15. **Rule 8 (check failed) matches the served state.** This replaces the first round's reading, "a failed automatic run falls to rule 13", which was wrong.
    - **Why.** An automatic run is served `failed` for its whole retry, so a rule that needs the run `running` never matched.
    - **When it matches.** Rule 8 matches a failed run when the focus is a failed verify or candidate below its cap on the lane's revision, not identical (rule 7), with no controller block in scope. A block in scope goes to rule 13 as source 0, for example "… ended on it in a state no resume continues".
    - **While a retry runs.** The headline names the failed attempt and adds "· attempt k running since HH:MM". The running attempt's result 404s until it ends and is never read.
    - **Manual runs.** A manual run whose retry is running gets `action: 'none'`, "No action needed while attempt k runs", instead of `retry`.
16. **Reviewer panes.** The target is `--node review` for the built-in reviewer and `--node review-<id>` for a declared one (interactive.py `--node` help).
17. **Rule 5 also applies to failed runs.** The PRD says "run status paused or running". Several resumable interruptions are served `failed` because the task keeps its graph error:
    - an outage during the freeze (FREEZE_RESUME_NOTE, :1314);
    - an outage during the review (:624, :811);
    - the UNAVAILABLE_NOTE row after a reviewer stop that was not confirmed (:1316).

    Cases (a) and (b) therefore match a failed run too. Case (c) matches whenever the run moves by itself (deviation 20).
18. **Rule 5 (b) premise.** The PRD says the server maps the raw `interrupted` status to `paused` on that node. It does so on the row, but the node keeps its task error, which `projectSnapshot` ranks first. Case (b) now:
    - reads the note from the focus's latest row, which is served `paused`;
    - accepts a focus served `paused` (Ctrl-C, :804) or `failed` (an outage).
19. **Rule 5 (a) and (b) end when a controller resumes.** The PRD's (a) says "no later status event".
    - **What ends them.** Case (a) also ends at a later PID row (a `controller_start` marker, which B1 serves as `running`) or at a later controller block. Case (b) ends at a PID row after its note.
    - **Why.** Without this, (a) stayed on "Interrupted … resume" through a whole worker phase, and (b) stayed on it through a whole review: a resumed review writes no review row until its verdict. The `automatic --live` it offered fails with "Another controller owns this run".
20. **Rule 10 covers resumed and re-entered steps.**
    - **A resumed focus.** When a controller start follows the focus's interruption note, it reads "● Running · <step> · resumed at HH:MM". The server keeps that node paused until its next row.
    - **A re-entered step.** A step re-entered while its node still reads failed, such as a resumed freeze or review, counts as a running node (deviation 24).
    - **Case (c)'s "moves by itself".** It uses the same notion: the run is served running, the supervisor retries a check (rule 8's premise), the focus was resumed, or a re-entered span is live.
21. **Rule 5 (c) `since`.** It is the first reading of the current `not_running` streak, not the first such reading in the history.
22. **Rule 7 needs one revision.** The PRD's fallback is "the latest two attempt results have the same error.message". The controller also requires `same_revision` (automatic.py:980). So:
    - the previous attempt is read only when it is on the lane's current revision, meaning above the repair floor;
    - the two results need equal `output_commit`, where an unknown commit counts as the same, as in `same_revision`.
23. **Rule 13, reason source 4 when the focus has no row.** A focus with no status row of its own takes the failed dependency row that opened the scope window. This keeps the cause when a controller block is aliased onto a lane named `controller`: see the C6 limit below.

**Timeline, re-entered steps**

24. **A re-entered span is live.** 5.2 rule 3 is extended to spans whose node is served `failed`:
    - **The rule.** An open span is live, with status `running`, when its row is the node's latest status row. In an automatic run, no PID row may follow it: automatic-step exits only once its step ended, so a later PID row means the attempt ended, and it keeps the node's `failed`. In a manual run the span must be a retry, meaning an earlier attempt failed.
    - **Where it shows.** The lanes line shows such a verify as ●, and `nowResultUris(detail, events)` skips its attempt.
25. **Outage wording.** The "Once `claude --version` works:" caption now also matches the outage errors that a node's note quotes:
    - "Claude Code unavailable for 60s …" (sessions.py:272);
    - "Claude session inventory unavailable" (interactive.py:63).

    Before, it matched only UNAVAILABLE_NOTE's "Claude Code was unavailable".

**Scope**

26. **Extra exports.** `nowResultUris`, `controllerNotRunning`, `textToString`, `plainTextFormat` and the constants go beyond the PRD's list. Consumers need them, and they keep the rules in one place.
27. **Size.** `triage.ts` is about 1,590 lines against the PRD's estimate of about 400. Most of the difference is the 13 situation builders with their command tables, the Activity rows and the doc comments. The test file is about 990 lines.

## Follow-ups

- **S3.**
  - Fetch `nowResultUris(detail, events)` before trusting the banner, passing the events, and treat a non-empty `Now.missing` as "loading". Without `candidate_ui/1`, guardrails reads `no_rule_matched` and lists that URI in `missing`.
  - A result that answers 404 should count as absent, not as still loading. `attemptResultUris` also lists an attempt that is still running.
  - Render `Text` parts with S1's `Time`, `formatSpan` and `formatAgo`, or pass a `TextFormat`.
  - Hide `controller_log` rows behind "Controller log (n)".
- **S5.** Use `deriveFocus` and `humanizeEvent` for B2's `focus` and `headline`. The client already reads:
  - B1's statuses on node-less rows (`failed` means controller_blocked; `paused` means interrupted);
  - the `[<lane>] ` candidate prefix, both for lane matching and in `humanizeEvent`.

  Once B1 serves correct attempts, the client's re-parse of `attempt N` still agrees with them.
- **S6.**
  - `controllerNotRunning` gives the chip's 15 s debounce.
  - `deriveNow` and `deriveAttention` take a `ServedActivity` (`waiting_questions`, `attention`) as a fallback. It follows B2's field names, so S5's `v1.ts` type should stay assignable to it.
- **Known limit (C6).** On a run with a lane named `controller`, the controller's own `blocked` rows are aliased onto `launch_controller` as node failures. B1 does not change this.
  - **Example.** A deadline row before the freeze, such as "Worker ui deadline exhausted; no automatic relaunch". It matches none of B1's controller-process patterns, so B1 leaves it on the lane.
  - **What the viewer shows.** Rule 6 cannot see such a row as a controller row, so the run falls to rule 13. Since the review round, rule 13 quotes the row as reason source 4, as the failed dependency row that opened the scope window. The first round printed "no reason was recorded" instead, not the message this note first claimed.
  - **What would fix it.** Only reserving the `controller` lane id (C6), or a B1 pattern for the wait-for-handoffs errors, would let rule 6 match.
- **Known limit (a killed manual retry).** A manual `retry` killed while it runs keeps its attempt live (● running), because a manual run has no PID row to show that its process exited. Any manual step killed while running already behaves this way. Automatic runs are exact.
- **PRD corrections proposed (not applied).** The PRD is not in S2's files, so it was left unchanged. The owner should apply these:
  - **6.2 rule 5.** Accept a `failed` run for (a) and (b), and let (c) apply whenever the run moves by itself (deviations 17 and 20).
  - **6.2 rule 5 (b).** Correct the premise: the node keeps its task error and is served `failed` after an outage (deviation 18).
  - **6.2 rule 5 (a).** Say that a resumed controller's PID row or a controller block ends it (deviation 19).
  - **6.2 rule 7.** Add the same-revision condition (deviation 22).
  - **6.2 rule 8.** Say that an automatic run is served `failed` for its whole retry (deviation 15).
  - **12.1.** `check_failed` and interrupted (b) should use the served states (run `failed`), as the tests now do.
- **`test:unit` glob.** S1 adds `tests/unit/*.test.ts` to it. Until then, run `npx tsx --test tests/unit/triage.test.ts`.
