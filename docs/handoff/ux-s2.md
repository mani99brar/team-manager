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
| `nowResultUris(detail)` | 6.2 source 2 | what the Now banner and the lanes line read: the failing focus's latest two attempts, plus each lane's candidate result when there are 2 or more lanes |
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

## Green evidence

```
npx tsx --test tests/unit/triage.test.ts              ℹ tests 46  ℹ pass 46  ℹ fail 0
npx tsc -b                                            exit 0
npx eslint contracts/projects/triage.ts tests/unit/triage.test.ts   exit 0
```

The unit tests cover every case in 12.1:
- the `buildTimeline` items;
- one `deriveNow` case per `data-situation`: `review_blocked`, `blocked_identical`, `succeeded`, `question` (export and event log), `pane_attention` (worker, reviewer, and cleared by a later event), `interrupted` cases a, b-review, b-freeze, c and d (automatic and retry), `blocked_before_freeze` ×4, `challenge_paused`, `awaiting_approval`, `check_failed` (automatic and manual), `running`, `inactive`, `no_rule_matched` (failed and paused), and scope;
- `gateReasonsByCheck` ×3, `deriveAttention` ×2, focus, humanize, URIs and lanes.

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
15. **Rule 8 (check failed) on an automatic run.** The rule needs the run to be `running`. A failed automatic run with attempts left was stopped by something else, so it falls to rule 13.
16. **Reviewer panes.** The target is `--node review` for the built-in reviewer and `--node review-<id>` for a declared one (interactive.py `--node` help).

**Scope**

17. **Extra exports.** `nowResultUris`, `controllerNotRunning`, `textToString`, `plainTextFormat` and the constants go beyond the PRD's list. Consumers need them, and they keep the rules in one place.
18. **Size.** `triage.ts` is about 1,430 lines against the PRD's estimate of about 400. Most of the difference is the 13 situation builders with their command tables, the Activity rows and the doc comments. The test file is about 760 lines.

## Follow-ups

- **S3.**
  - Fetch `nowResultUris(detail)` before trusting the banner, and treat a non-empty `Now.missing` as "loading". Without `candidate_ui/1`, guardrails reads `no_rule_matched` and lists that URI in `missing`.
  - Render `Text` parts with S1's `Time`, `formatSpan` and `formatAgo`, or pass a `TextFormat`.
  - Hide `controller_log` rows behind "Controller log (n)".
- **S5.** Use `deriveFocus` and `humanizeEvent` for B2's `focus` and `headline`. The client already reads:
  - B1's statuses on node-less rows (`failed` means controller_blocked; `paused` means interrupted);
  - the `[<lane>] ` candidate prefix, both for lane matching and in `humanizeEvent`.

  Once B1 serves correct attempts, the client's re-parse of `attempt N` still agrees with them.
- **S6.**
  - `controllerNotRunning` gives the chip's 15 s debounce.
  - `deriveNow` and `deriveAttention` take a `ServedActivity` (`waiting_questions`, `attention`) as a fallback. It follows B2's field names, so S5's `v1.ts` type should stay assignable to it.
- **Known limit (C6).** Before B1, the lane-specific blocked rows of a lane named `controller` are aliased onto `launch_controller` as node failures. An example is "Worker controller deadline exhausted". Rule 6 cannot quote such a row, so the run falls to rule 13, which still shows the message as reason source 4.
- **`test:unit` glob.** S1 adds `tests/unit/*.test.ts` to it. Until then, run `npx tsx --test tests/unit/triage.test.ts`.
