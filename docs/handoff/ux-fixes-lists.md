# Handoff: ux-critique-fixes stage A, lane `lists`

Findings M1, M2, M5, M14 (rows and `formatSpan`), M18, M19, M20 and M29 of `features/ux-critique-fixes/prd.md` section 6, under
[O4], [O6], [O10], [O13], [O14] and the changes after launch [L1] to [L8].

## M2 reclassification of the existing seeded runs ([L5])

Listed from the served run lists of both phases with the new rule (`classifyRuns` in `src/projects/lists.ts`, keyed on
`project_id` and `workflow_id`, latest by `created_at` then `run_id`). "Paused/Today" and "Running/Today" mean the old
placement still applies (Today when it moved today under the spec's clock, else Paused or Running).

| Run (project/workflow/run) | Module (owner) | Status, attention | Worker phase | Candidate phase |
|---|---|---|---|---|
| alpha-project/ux-revamp-lists/desk-stale | ux-revamp-lists.ts (lists) | paused, paused@handoff | superseded by desk-live-1 (was Paused) | same |
| alpha-project/ux-revamp-lists/desk-held | ux-revamp-lists.ts (lists) | paused, paused@null | superseded by desk-live-1 (was Today) | same |
| alpha-project/ux-revamp-lists/desk-interrupted | ux-revamp-lists.ts (lists) | paused, interrupted@handoff | superseded by desk-live-1 (was Today) | same |
| alpha-project/ux-revamp-lists/desk-paused | ux-revamp-lists.ts (lists) | paused, paused@handoff | superseded by desk-live-1 (was Today) | same |
| alpha-project/controls/controls-stopped | controls.ts (unowned) | paused, interrupted@handoff | Needs you (interrupted) | same |
| alpha-project/controls/controls-refuse | controls.ts (unowned) | paused, interrupted@handoff | superseded by controls-stopped | same |
| alpha-project/ux-review/run-challenge-paused | ux-review.ts (pages) | paused; no activity in the mock, paused@challenge served | superseded by run-review-print | superseded by run-review-print |
| alpha-project/ux-refine/run-challenge | ux-refine.ts (pages) | paused; no activity in the mock, paused@challenge served | superseded by run-loop-running | same |
| alpha-project/ux-run/run-review-interrupted | ux-run.ts (pages) | paused; no activity in the mock, interrupted@review served | Paused/Today (no activity: out) | **Needs you (interrupted)** |
| alpha-project/ux-run/run-controller-interrupted | ux-run.ts (pages) | paused; interrupted@handoff served | superseded by run-review-interrupted | same |
| alpha-project/ux-run/run-repaired | ux-run.ts (pages) | paused; interrupted@verify_ui served | superseded by run-review-interrupted | same |
| alpha-project/ux-run/run-freeze-interrupted | ux-run.ts (pages) | failed, interrupted@handoff | finished: out ([O13]) | same |

So the global "Needs you · n" and the tab title's "(n)" differ by phase (one more in the candidate, `run-review-interrupted`),
and `pages` may add runs to alpha-project: no spec of this lane asserts them against a constant; the global count is compared
with the DOM's card count, and every by-value count is scoped to `dispatch-noorigin` and `dispatch-widgets-wt`, which only
`fixtures/dispatch.ts` populates (design challenge note 1).

The new M2 seeds (`fixtures/dispatch.ts`, `M2_RUNS`), confirmed served in the candidate phase with the probe of [L7]:

| Run | Status, served attention | Placement |
|---|---|---|
| dispatch-noorigin/decide/decide-001 | paused, paused@challenge | Needs you (decision); its only later run, redo-002, is in another workflow |
| dispatch-noorigin/redo/redo-001 | paused, paused@challenge | superseded by redo-002 (feature text "Redo" vs "Redo, second take" in the worker phase; both null in the candidate, which serves no `inputs.feature` for these seeds) |
| dispatch-noorigin/redo/redo-002 | failed after 50 h | Recent never (2024); its row reads "2 d 2 h" |
| dispatch-noorigin/halt/halt-001 | paused, interrupted@verify_ui | Needs you (interrupted) |
| dispatch-noorigin/halt-live/halt-live-001 | **running, interrupted@launch_ui** | Needs you (interrupted) |
| dispatch-noorigin/rerun-live/rerun-live-001 | **running, interrupted@launch_ui** | superseded, keeps Running |
| dispatch-noorigin/parked/parked-001 | paused, paused@review | Paused |
| dispatch-widgets-wt/wt-parked/wt-parked-001 | paused, paused@review | Paused; the project's only live run |
| dispatch-widgets-wt/wt-dropped/wt-dropped-001 | cancelled | the project's newest run |

The running + interrupted shape comes from rule 5 case (a): a run-level controller row "Supervisor interrupted…" with nothing
after it while no step is paused (these seeds have no automatic `inputs`, so the handoff never pauses on the controller row).

## What changed, per finding

- **M2 Needs you** (`src/projects/lists.ts` `classifyRuns`, `classOf`, `rowLook`, `NeedKind`, `RunClass`): one classification
  per served list, in PRD 6 M2's order (superseded paused runs first, then question/pane/approval, then the latest run's
  challenge-paused or interrupted attention, then today's placement). It is computed once per list and passed to `RunRow`
  (`cls` prop), `NeedsCard`, `ReadingPane` (`cls`), the step chart's rows and header tone, `projectTone`, `featureTone`,
  `projectRunInfo` and the project page's "Needs you and running" and figures. New kinds: chip "decision waits" /
  "run interrupted", `data-attention="decision"` / `"interrupted"`, next steps "resume or accept the challenge on the run
  page" / "resume the run on the run page". Superseded paused runs sit in a closed `details[data-testid=superseded-runs]`
  "N superseded" inside Paused, each row "superseded by <id>" (`data-superseded-by`), never warn, in no count.
- **M1 Loading** (`dispatch/projectModel.ts` `ProjectRunInfo.state`, `FAILED_RUN_INFO`; `Rail.tsx`; `ProjectsPage.tsx`;
  `ProjectsView.tsx`; `ProjectPage.tsx`, `StepChart.tsx`): "reading…" rail rows without badges, "…" Triage count and chip,
  "reading runs…" cards, "repositories: reading…", feature rows from run summaries (steps join later; "reading runs…" while
  the lists load; a row without its steps names no stop, says "reading steps…" while the steps load, "steps not read" only when
  the read failed and "no steps recorded" when the read holds none for it (`noStopWording`), and counts in no "ended here" phase,
  `dispatch/stops.ts`), no reviewer/review-step line until the reviewer read settles, and `[data-testid=lists-incomplete]`
  "N of M projects read; lists incomplete" above Needs you (the Attention details stay at the foot).
- **M5** (`RunsHome.tsx`, `lists.css`): Triage is one column (`.triage-layout`, no `.home-layout` grid); `.run-rows` is a
  container (`run-rows`) and under 900 px the time drops under the id; `.run-row-id` no longer breaks per letter.
- **M14** (`time.ts` `formatSpan`; `lists.ts` `rowTime` kind `stopped`, `stoppedLabel`, `monthDay`, `sincePausedLabel`,
  `cardElapsed`; `RunRow.tsx` `StoppedSince`): "paused 10 d (since Oct 2)", "interrupted …" for paused or running rows,
  "today" under a day, a span only while running (pending and awaiting-approval rows say "updated …"); `formatSpan` "2 d 0 h" from 48 h, byte-identical below.
- **M18**: one line `[data-testid=home-quiet]` "Nothing waits on you, moved today or runs" when Needs you, Today and Running
  are empty (their sections stay in the DOM, `hidden`), never when no run list was read; Paused then unfolded.
- **M19** (`derive.ts` `railBadgeTone`, `cardStateWord` paused/loading; `Rail.tsx`; `dispatch.css`): badges carry
  `tone-warn` / `tone-pause` / `tone-run` (`badge-neutral` for unpushed); a live paused run sets the pause glyph when nothing
  waits or runs; cards add `[data-testid=dispatch-card-live]` "N waits on you · N running · N paused".
- **M20** (`src/projects/pins.ts`, `RunRow.tsx` `PinToggle`, `RunsHome.tsx` `Pinned`, `ReadingPane.tsx`, `ProjectsView.tsx`
  `[data-testid=crumb-row]`): see "Pins" below.
- **M29** (`time.ts` `staleAfterMs`, `freshnessStateAt`; `LiveStatus.tsx`; `ProjectsView.tsx` run poll): "Failed Oct 9 ·
  checked 2 s ago", "Paused since Oct 2 · checked …" (data-state stays `watching`); a failed run is re-read every
  `LISTS_POLL_MS`; the stale threshold is three polls (15 s at 5 s, 45 s at 15 s; Triage's own chip, which has no served
  run, uses the 15 s cadence too).

- **Follow-up 002, M1 ([L15], [L16])**: `ProjectsView` derives the `/steps` read state (`loading | failed | read`, type
  `StepsRead` in `dispatch/ReadingPane.tsx`) and passes it through `ProjectPage` to `ReadingPane`. With no step entry for the
  run the pane says "reading…" / "Reading the recorded steps…" only while the read loads, "not read" / "The recorded steps
  could not be read." when it failed, and "not recorded" / "No steps recorded for this run." when it was read without an
  entry (`[data-testid=dispatch-pane-steps-state]`). A failed overview read makes the Projects header say "N projects ·
  repositories not read", never "repositories: reading…" (`repositoryCount` is `number | null | 'failed'`).

## Test ids

Scenarios: `revamp-lists.spec.ts` `[scenario:triage-attention]`, `[scenario:triage-loading]`, `[scenario:triage-desktop]`,
`[scenario:rail-state]`, `[scenario:run-times]`, `[scenario:triage-pins]` (with untagged siblings: failed project list,
quiet Triage, Paused fold after 5, storage throws, malformed storage and dedupe, 390 px); `ux-time.spec.ts`
`[scenario:run-freshness]`. Unit: `tests/unit/lists.test.ts` "Needs you: the closed set …", "a row's time …", "the Triage
pin store"; `tests/unit/dispatch.test.ts` "a project's run state while it loads …", "badges carry their own state tone";
`tests/unit/time.test.ts` "from 48 h …", "the stale threshold follows the poll cadence".
Follow-up 002: `dispatch.spec.ts` "A failed steps read on a cold project page …" ([L15], the 503 installed before the first
load) and "A failed overview read on a cold Projects page …" ([L16]); both fail at 0d4c80e.

## The M2 closed set and its key

In: latest challenge-paused (`{kind:'paused', node_id:'challenge'}` with status paused, which is how both `challenge_paused`
and `challenge_held` are served), latest interrupted (status paused or running), and any unfinished question/pane/approval.
Out: a superseded paused run (whatever its attention), a superseded interrupted running run (keeps Running/Today), a plain
running run, a run paused at another step, failed/succeeded/cancelled, accepted, no activity. "Latest" and "superseded" read
only `project_id`, `workflow_id`, `created_at` (then the greater `run_id`), never `activity.feature`. A served `follows` field
(a stage C option) would replace this workflow key. Paging limit: Triage and the rail read several pages per workflow (back
to the Recent cutoff), the project page reads page 1 and the feature page the pages it has loaded, so a run whose later run
sits on an unread page is classified as latest there.

## Pins

`localStorage` key `md-manager:triage-pins:v1`, a JSON array of `{project_id, workflow_id, run_id, pinned_at}` newest first,
at most 50 unique runs; malformed or missing reads as no pins; when storage throws the pins live in memory and the Pinned
section says "Pins are not saved in this browser". No request on pin or unpin. localStorage is per origin: an SSH tunnel's
port, a private window or a port change starts without pins. A pin Triage did not read shows its id as a link with "not
among the runs read".

The run's pinned `policy.json` still carries the `triage-pins` text as prepared: "adds no line to the crumb bar at 1440 or
390 px (its height equals the crumb bar's height on the workflow page)" and "'not among the runs read (older than 7 days)'".
Both clauses are overridden by decisions.md "Changes after launch" [L1] and [L2] and its 13:08 note: the crumb row is
measured against its own page (no taller than the greater of that page's `.breadcrumbs` and the toggle, within 1 px, at
1440 px; at 390 px only the 44 px toggle and no sideways scroll), and the unread pin says "not among the runs read" with no
reason. The tests assert the [L1]/[L2] wording; that is the contract.

## For stage B and DESIGN.md (lane `lists` changes no DESIGN.md line)

Sentences stage B may consider for DESIGN.md:
- "A stopped run (paused, or interrupted while paused or running) reads as days since it stopped, 'paused 10 d (since Oct 2)';
  only a running run shows a ticking span. Spans of 48 h and more read in days and hours."
- "A badge is toned by what it counts (warn waits, pause paused, run running), never by the row's last result."
- "Pinned is a shortcut list at the top of Triage; a pinned run keeps its place in its state section."
- "On run and node pages the crumbs share one row with the run's 'Add to Triage' toggle, outside the workspace."

## Open items

- **Interrupted case (c) never reaches a list row** (design challenge note 2): the list's `activity.attention` is derived
  from `deriveNow` with no controller readings, so a running run whose controller process is gone stays in Running on Triage
  while its run page says Interrupted. Serving `activity.controller` per row and feeding `recordHomeReadings` into the
  classification (or a served `situation`) would close it; stage B or C.
- **Failed runs served with `interrupted` attention** stay out of Needs you ([O13], [L3]): the freeze or review interrupted
  by an outage is served failed. Stage B should decide whether such a run needs the operator.
- **The running + interrupted seed shape is rule 5 case (a)** (a run-level controller row nothing followed, no step paused);
  the live controller usually writes that row with a paused step, so live data reaches running + interrupted rarely.
- **Feature text in the candidate**: the dispatch seeds carry no `inputs.feature`, so the candidate serves `feature: null` for
  `redo-001` and `redo-002`; the "later run's feature text differs" case is exercised by value in the worker phase and the
  unit test, and as "missing" in the candidate phase.
- **Paging**: the project page classifies page 1 of each workflow; a run whose later run lies on page 2 or beyond reads as
  latest there (Triage and the rail read more pages).
- **The step chart's run row** (`dispatch/StepChart.tsx`) follows the project's `loading | failed | read` steps state like the
  reading pane (repair round 1 of 002): "reading steps…" under a held read (`triage-loading`), "steps not read" under a failed
  one (`dispatch.spec.ts`, "A failed steps read: a run row …"); the "no steps recorded" wording has only a unit test.
- **Backlog from 001's lane review round 2 (P2)**: pins keep a per-tab copy without a `storage` listener, so a pin made in
  one tab shows in another only after its reload.
- **The Needs-you cards carry a toggle too** (below the card's link, inside its `li`): an addition beyond the RunRow rows.
- **Order of work ([L5])**: the reclassification inventory above was taken from both phases' served lists after the
  classifier was written, but before any spec was edited; it was not written before the first UI edit.
