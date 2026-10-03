# PRD: Workflow viewer UX ("Run Story")

Status: Proposed 2026-09-24. Synthesizes the four-lens audit of the Projects viewer (orientation, chronology, detail-density, live-status; screenshots `shots/01`–`14`, payloads `api/*.json`), three redesign proposals (timeline-first, triage-first, graph-inspector) and two judges' verdicts. Both judges picked **timeline-first** as the base. This PRD adds every graft that fits and respects every `must_avoid`. Where the two judges disagree, Appendix B records the decision. Follows [PRD_VIEWER_CLARITY.md](PRD_VIEWER_CLARITY.md), [PRD_RUN_INPUTS.md](PRD_RUN_INPUTS.md), [PRD_REVIEW_VISIBILITY.md](PRD_REVIEW_VISIBILITY.md) and [PRD_WORKER_LANES.md](PRD_WORKER_LANES.md) (all in `docs/`; this file is meant to land as `docs/PRD_VIEWER_UX.md`). Their truthfulness rules still hold. This PRD changes only how compactly they are said.

Revision 2 (2026-09-24) closes the critic's gaps. The changes, each checked against the code:
- Node-level interruptions (review, freeze) and repair continuations now get a next step (6.2 rule 5).
- A new situation covers runs the controller blocked before freeze (6.2 rule 6, reason source 0, B1).
- Pane attention is carried everywhere a question is (6.4, B2 `attention.kind: 'pane'`).
- Controller liveness is read-only and PID-reuse safe (B2 `activity.controller`).
- The first-screen budget is measured against a one-row Projects header, with the tabs above the graph (4.2).
- Slices are file-disjoint when run in parallel, and no slice's test depends on a later slice (11, 12).
- B3 moves to a top-level `viewer` key, which survives re-registration.
- Test migrations are corrected (12.3). The `answer`, `init` and `status` command wording is fixed, gate reasons without a check id are handled, and two API field claims are corrected.

Scope: `src/projects/**`, `src/App.tsx` (Projects header only), `src/App.css` and new per-area stylesheets, `tests/project-workflows/**` and `tests/unit/**`. For backend slice S5: `server/projects.ts`, `server/projectsConfig.ts`, `contracts/projects/**` and a new pure module `contracts/projects/triage.ts`. The Python controller (`workflow/*.py`) is **not** changed here. Controller-side gaps are listed as follow-ups C1–C10 (section 9.4). The viewer stays strictly read-only. It never runs a command and never mutates a run.

## 1. Problem

The user's complaint, verbatim: *"Lets work on making the UX better for the workflow section. Its not good, i need to look around to understand whats where when it happened and overall is just bad."*

The audit confirms each part of the sentence with measurements taken from the live runs.

**"what's where": nothing answers the operator's question where they land.**
- The run page spends its first screen on an 11-fact grid, a 3-sentence legend, a keyboard hint, a duplicate node list and an empty "Select a node…" panel (`04-…-fold.png`, RunView.tsx:98-217). It never names the failing step, the reason or the next command (orientation:run-first-screen-no-answer, live-status:run-why-not-surfaced).
- For skeleton-001, the cause ("general blocked: 1 P1, Private matches can be joined without their code") takes a click and about 1.3 screens of scrolling to reach. For workflow-guardrails-001 it sits inside Candidate › Lane ui › error box.
- No page tells the operator which CLI command to run next (live-status:no-next-action).

**"when it happened": the run has no history view.**
- Events render only per node, at the bottom of each node page (NodeDetail.tsx:466-487).
- Events whose `node_id` is null are dropped everywhere (NodeDetail.tsx:305). In skeleton-001 that is 7 of 26 events, including the controller's diagnosis *"failed identically on attempts 1 and 2 … a code fix is a lane repair (RUNBOOK)"* and *"Repair 1 applied"* (chronology:unattributed-events-hidden, live-status:controller-events-hidden).
- No duration is ever computed. Every time is a full UTC ISO string (status.ts:100-104). "Last event" is shown as a sequence number, and "Updated" trails real activity by 3.5 minutes (orientation:no-run-timeline, chronology:no-durations, chronology:last-activity-misleading, chronology:utc-only-absolute-times).

**"look around": node pages are walls.**
- `launch_game` is 19,834 px tall. 77 file panels take 15,400 px of it, and the Markdown files are auto-rendered (detail-density:launch-files-wall).
- A worker question sits at y≈19,320 (orientation:pending-question-buried).
- On `verify_game` the gate sits behind a repeated worker summary and 10 assumptions (detail-density:worker-narrative-duplicated).
- Earlier failed attempts are served by the API (`results/game/1` and `/2` return 200) but cannot be reached from the viewer (orientation:earlier-attempts-unreachable).
- The node list wastes a third of the width for the whole page. The graph clips "Integrate candidate" at 1440 px (orientation:navigation-model-node-list, orientation:graph-clipped).
- At 390 px the node detail starts at y≈1,975 and the verify page overflows to 427 px wide (orientation:mobile-node-detail-offscreen).

**"overall just bad": live watching is not trustworthy.**
- A worker waiting on a question, or blocked in its pane on a permission prompt or a refusal, looks exactly like a busy one (live-status:question-attention-invisible).
- Polling is silent, and a failed poll keeps stale data with no warning. A dead controller cannot be told from a quiet one: during a worker phase, 28 minutes without events is normal (live-status:no-liveness-indicator).
- A run the controller stopped before freeze, or interrupted during review or freeze, shows no cause and no command. Its reason is only in a node-less controller row that no page renders (live-status:run-why-not-surfaced, live-status:no-next-action).
- Every workflow is titled "Feature implementation" (orientation:naming-feature-implementation).
- Reaching a run takes three clicks through near-empty pages (orientation:hierarchy-depth-empty-levels).

All 23 P1 findings fall into these four themes. Appendix A maps all 72 findings.

## 2. Goals and non-goals

### Goals

1. **Answer first.** The first screen of a run page, at 1440×900 and at 390×844, answers five questions:
   - Where is the run, or where did it stop?
   - Why?
   - Since when?
   - What exactly do I type next, if anything?
   - Is this page current?
2. **One story in time.** At 1440×900 the first screen also shows the Steps table: each step's start, duration and attempt markers. The markers include ⚑ (the controller's diagnosis) and ⚒ (an operator repair) on the step they concern.
   - The full text of the node-less diagnosis and repair rows is in Activity, directly below Steps on the same default tab, never behind a toggle or a tab.
   - The guarantee covers runs with up to 2 lanes: every live run so far, and every fixture except `RUN_THREE_LANES`. For those runs the focus step's row is inside the fold; section 4.2 has the measured budget.
   - With 3 or more lanes the graph grows a row and the focus row can fall below the fold. The Now banner still names the focus step there.
   - At 390×844 the first screen holds the Now banner, and Steps follow directly.
3. **One home per piece of evidence.** Each piece of evidence is shown once, where it answers its question: files on the worker, checks, logs and screenshots on verification, findings on review. Everywhere else it appears as a one-line link or a count.
4. **Short node pages.** A node page's first screen shows its verdict, timing, attempts and a section index with counts. Long lists are collapsed and fetch their content only on demand. No node page needs more than about 3 screens before the operator expands something.
5. **Live-watch trust.** A freshness chip is always visible.
   - While a run is running or paused, the chip also says whether its controller process is alive (B2 `activity.controller`; Linux `/proc`, and "unknown" elsewhere).
   - A worker or reviewer that waits on the operator is visible on the run page, the graph, the Steps and strip rows, the run lists and the browser tab title. That covers a waiting question and a pane that needs attention.
6. **Honesty kept, said once.** The rules survive: a worker's success is not workflow completion, a worker's report is as signalled and not verified, the viewer is read-only, executors are marked, inferred times are marked. Each is said once, compactly.
7. **Shippable slices.** The existing browser suite stays green in both phases (worker mocks and candidate seeds), apart from assertions this PRD migrates explicitly in the same slice.

### Non-goals

- Starting, answering, approving, retrying, repairing or cancelling anything from the viewer. Commands are shown as text to copy.
- Changing the controller, exporter or event vocabulary (`workflow/*.py`). Those gaps are follow-ups C1–C10. Until they land, the viewer infers the missing values and labels every inference.
- A liveness claim from PID existence alone, such as `process.kill(pid, 0)` on a PID parsed from event text. PID reuse would give a false "alive".
  - B2 instead reads `/proc/<pid>/cmdline` and the process start time. It says "running" only for this run's own `automatic-step` child, started before it logged its PID. It says "unknown" whenever it cannot tell.
  - A controller heartbeat (C7) would make this portable.
- The Pi/Claude skills areas.
- Renaming `definition.name`. It feeds `definition_revision` (server/projectsConfig.ts:89-90), so changing it would flag every old run as "definition changed".

### Confirmed decisions

- **The SVG graph stays.** It is fitted to the width by retuning `dag.ts`, not rebuilt as HTML. `.workflow-node-meta`, the aria-label format, `.workflow-node-shape` `stroke-dasharray`, `.is-agent`/`.is-controller` and arrow-key roving are unchanged (clarity.spec.ts:63-109, projects.spec.ts:164-168).
- **A one-row Projects header.** On Projects routes the app header is one 48 px row: title, the Pi/Claude/Projects roots and Refresh. The Pi/Claude subtitle is dropped there. The breadcrumb is the only other chrome (28 px). Today the chrome takes about 150 px, or about 180 px with the info line (`04-…-fold.png`). The skills routes keep their header.
- **Tabs above the graph.** `[Run] [Assignment]` sit directly under the Now banner. The graph lives inside the Run tabpanel, so it disappears on Assignment and comes back on Run (inputs.spec.ts:56, :89).
- **One pipeline view per screen.** On the run page, the graph shows *shape and status* and the Steps table shows *time*. The Steps table is the `run-node-list`, not "the same graph as text". On node pages a sticky step strip replaces the graph, so the graph and the strip never share a screen. There are no lane cards that repeat step durations.
- **Views that need a link live in the path.** Tabs and attempts are URL path segments (`/assignment`, `/nodes/<n>/attempts/<k>`), because App routing is pathname-only (App.tsx:159).
- **Section index, not sub-tabs, on node pages.** Evidence stays in the DOM, Ctrl-F works, and most `toBeVisible` assertions survive.
- **Commands follow the RUNBOOK**: `"$PY" -m workflow <cmd> "$RUN" …`.
  - `$RUN` stays a placeholder unless a workflow opts into serving its run directory (B3, home-relative, off by default).
  - A command appears only when a situation rule in section 6 matches the run's *current* state. Otherwise the viewer says "No known next step matched" and links the RUNBOOK section.
- **The vocabulary is "attempt"**, the word the controller, CLI and RUNBOOK use. The following wordings are retired: "Graph attempt", "Result attempt 3 (graph node attempt is 1)" and "attempt 0".
- **Default times are local**, with the UTC value in the tooltip. A remembered Local/UTC toggle is available.

## 3. Information architecture

### 3.1 Routes

`routes.ts` gains three literals. `parseProjectsPathname`, which today rejects any trailing segment (routes.ts:82), accepts `assignment` after a run id (added in S3) and `attempts/<int>` after a node id (added in S4-core). Every URL that works today keeps working.

| Route | Page | First question it answers |
|---|---|---|
| `/projects` | **Runs home** | Does anything need me, what is running, what finished recently (all projects)? The only page that carries the read-only note (`projects-info`). |
| `/projects/<p>` | Project | The same run rows for one project, grouped by feature. The group header links to the feature's runs (`workflows-list`). |
| `/projects/<p>/workflows/<w>` | Feature runs | Run rows (`run-list`) with where each run stands, its duration and its age. "Current definition" moves into a closed `<details>`, which is open when there are no runs. |
| `/…/runs/<r>` | **Run page** (Run tab, default) | Run header → Now banner → lanes line (2+ lanes) → tabs → Run tabpanel: fitted graph, Steps (with times), Activity. |
| `/…/runs/<r>/assignment` | Run page, Assignment tab (now routed) | What the run was asked to do. |
| `/…/runs/<r>/nodes/<n>` | **Node view**, latest attempt | Verdict, timing, attempts and next step. Evidence sits behind a section index. |
| `/…/runs/<r>/nodes/<n>/attempts/<k>` | Node view, attempt *k* | That attempt's own result (`results/<lane>/<k>`, `results/candidate_<lane>/<k>`). |

### 3.2 What moves where

| Item | Today (where the audit found it) | New home | Elsewhere |
|---|---|---|---|
| Failing or active step, reason, next command | nowhere; event #20 at y≈4,600 of 07 | Now banner | the focus node's header |
| Run history, incl. `node_id: null` events | per node, at the bottom; node-less events never shown | Run tab: Steps (per node) and Activity (chronological) | node History (filtered) |
| 11 run facts | grid at y≈200-490 (RunView.tsx:98-131) | Header facts line plus the `Details ▸` disclosure | Assignment keeps one summary line |
| Node list | left third of the page (App.css:345) | Run page: the Steps table. Node pages: the sticky step strip. Both carry `run-node-list`. | — |
| Graph | 1,680 px wide, clipped | Run page only, fitted. Hidden below 760 px. | Feature runs page: in closed `<details>` |
| Worker question | launch node y≈19,320 | Now banner, `?` on the graph node and step, the Needs-you row, `document.title`, first section of the launch node | — |
| Changed files | 15,400 px of panels | Launch node › Files: dense rows, findings first, content on demand | counts on the node header |
| Worker summary and assumptions | launch ×2, verify ×1 | Launch node › Report, once | verify and candidate: "Worker's report → Launch game worker ›" |
| Checks, logs, screenshots | verify y≈2,480 / 3,165 | Verify node › Gate, Checks, Screenshots | candidate per lane |
| Findings | review table, plus inline under 77 files | Review node | badges on file rows, counts on the Steps row |
| Earlier attempts | unreachable | Attempt strip on the node header, `/attempts/<k>` | Activity rows link to them |
| Launch receipt, stop line, session ids | bottom of the launch node | Timing line in the header, plus a closed "Session" disclosure | — |
| Task | Assignment and launch node | Assignment (the canonical full view, PRD_VIEWER_CLARITY §2), plus a closed Task section on the launch node for the requirement-highlight flow | — |
| Breadcrumb | Home / Projects / p / Feature implementation / run | Projects / p / *feature title* / run ● / *node label* | — |
| App header on Projects | 3 rows: title, Pi/Claude subtitle (App.tsx:635), roots; then breadcrumb and info line (≈150-180 px) | One 48 px row (title · roots · Refresh), then the breadcrumb; the read-only note lives on `/projects` and in each command block | — |

### 3.3 Removed or merged

The following are removed:
- the keyboard hint (RunView.tsx:161; the graph keeps a visually hidden `aria-describedby`)
- the status enum footnote (RunView.tsx:217)
- the node footnote (NodeDetail.tsx:488)
- the empty "Select a node…" panel (`node-hint` becomes the Steps caption)
- the always-empty "Reuse evidence" section (NodeDetail.tsx:340-357; it is shown only when `result_reused` events exist)
- "Findings on this file / No review finding names this file" ×77
- the 4-line findings legend (it moves to a `?` disclosure)
- the info line on run and node pages
- "Home" as the first crumb on Projects routes
- "Last event: sequence N"
- the generic "Marked retryable by the producer" note
- per-kind stroke colours that reuse status colours, and the pending dash override (App.css:325-335)

## 4. Page designs

Wireframes use the real runs. Times in the wireframes are UTC, which is what a viewer in UTC would see. In the product they render in the viewer's local zone (section 5).

### 4.1 Runs home `/projects` (desktop 1440)

```
MD Manager — workflow runs, read-only                 (Pi) (Claude) (Projects)       [Refresh]
Projects                                                          ● Live · updated 3 s ago
Read-only: runs are started, answered and approved in the workflow CLI.        (projects-info)

NEEDS YOU · 1                                                                     (needs-you)
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│ ?  duel-core-001 · Pirate Sea Race duel core · project-B          Waiting on you · 14 min │
│    Launch duel worker asked question 1 of 3 at 11:40 · deadline paused         started 11:08│
└──────────────────────────────────────────────────────────────────────────────────────────┘
RUNNING · 0   nothing is running
RECENT                                                                      (recent-runs)
 ✓ skeleton-fixes-001        Pirate Sea Race skeleton review fixes · project-B   10:14 · 1 h ago  31m50s
   Integrated · no push performed
 ✗ skeleton-001              Pirate Sea Race walking skeleton · project-B        09:32 · 2 h ago  52m51s
   Failed at Independent review
 ✗ workflow-guardrails-001   Workflow guardrails · MD Manager                    yesterday 20:27  54m21s
   Failed at Verify combined candidate · Combined revision 1ab6b95 (ui)
PROJECTS   [project-B · 3 features · last run 1 h ago]   [MD Manager · 2 features · yesterday] (projects-list)
```

Rules:
- **Row link.** Each row is one `<a>` (`data-run-id`, `data-status`, `data-attention`), wrapped in an `<li>`. projects.spec.ts:142 counts `run-list li`. Its accessible name starts with the run id, which `run-list` tests rely on (projects.spec.ts:152).
- **Needs you.** It lists runs whose `activity.attention.kind` is `question`, `pane` or `approval`. The row's line 2 names the lane and what waits, for example `game needs attention in its pane (native state blocked)`.
- **Line 2 with B2.** It shows `activity.focus` plus `activity.headline`. The time and duration come from `activity.finished_at` (or `last_activity_at` while live) and `created_at`. For skeleton-001 that is `09:32 · 52m51s`. The headline is the focus node's last status message, which is why the guardrails row names a revision, not the gate reason. The reason appears on the run page, which reads the lane results.
- **Line 2 without B2.** RunSummary has only `created_at`/`updated_at`, and `updated_at` is `max(export rewrite, last event)` (server/projects.ts:936). For skeleton-001 that is 09:36:07, 3.5 minutes after the run stopped, which is the misleading value that chronology:last-activity-misleading is about. So the fallback row claims no finish and no duration: `Failed · updated 09:36 · 2 h ago`. B2 lands before the lists do (S5 before S6), so this fallback only covers a server without B2.
- **Fetching without B2 or B4.** Fan-out goes projects → workflows → first run page per workflow, polled every 15 s. Run detail is fetched only for non-terminal latest runs. With B4 this becomes one request.
- **Project page.** It shows the same rows filtered to one project and grouped by feature. The group header (`workflows-list` link) reads `Pirate Sea Race walking skeleton · skeleton · 1 run`.
- **Feature runs page.** It is the same row component (`run-list`). The "Current definition" graph moves into a closed `<details>` below the list (`current-definition`).
- **Workflow title rule** (cards, headings, crumbs):
  1. the latest run's `activity.feature` (B2), else
  2. the `workflow_id` when `definition.name` is the exporter's generic `"Feature implementation"` (export_state.py:84), else
  3. `definition.name`.

  "Feature implementation", node counts and revisions become secondary text. Fixture names ("Feature flow", …) are not generic, so `currentCrumb` assertions stay green.
- **At 390 px.** Each row stacks into three short lines, and the whole row is the tap target (≥44 px).

### 4.2 Run page: desktop first screen (1440×900, skeleton-001)

```
y0    MD Manager   (Pi) (Claude) (Projects)                                                       [Refresh]   <- one row on Projects routes
y52   Projects / project-B / Pirate Sea Race walking skeleton / skeleton-001 ✗
y88   Pirate Sea Race walking skeleton  skeleton-001  [✗ Failed]  08:39 → 09:32 · 52m51s   ● Watching · updated 2 s ago  (Local|UTC)
      feature/skeleton/skeleton-001 @ 313eb87418e2 · automatic · worker 3h · review 1h · definition ccdd5a54711d (current)  [Details ▸]
y152 ┌ NOW (run-now data-situation="review_blocked") ──────────────────────────────────────────────────────────┐
     │ ✗ Blocked by review at Independent review · 09:32 (2 h ago). The workflow did not complete.             │
     │   general blocked the candidate: 1 open P1 — Private matches can be joined without their code          │
     │   (apps/server/src/MatchRoom.ts:44-50). coverage was superseded (no verdict).        [Open finding ›]   │
     │ Likely next step — findings after review are fixed in a new run · RUNBOOK "Changed code" · $PY/$RUN ▸   │
     │   1 $ "$PY" -m workflow init <fixes-feature> --repo <target repo>                              [Copy]   │
     │   2   fill in its TODOs (/workflow-grill <fixes-feature> writes decisions.md), commit them in the target │
     │   3 $ "$PY" -m workflow launch <fixes-feature> --repo <target repo> --live --automatic         [Copy]   │
y333 └─ Run these in your terminal; this viewer never changes a run. ────────────────────────────────────────────┘
y341  [Run] [Assignment]                                          (tablist; the Run tabpanel starts below)
y381  [✓ Design challenge]→[✓ Launch game worker]→[✓ Freeze worker…]→[✓ Verify game]→[✓ Verify comb…]→[✗ Independent…]→[○ Integration…]→[○ Integrate…]
      Succeeded · attempt 3 · agent     … agent        … controller     … attempt 3 · verifier  …            Failed · attempt 1 · agent
y477  ▭ Agent session   ┅ Trusted verifier   ┈ Controller   (?)                        (graph-legend, 3 li)
y505  Step (run-node-list)   Started  Took      Attempts          Outcome                          08:39 ──── 52m51s ──── 09:32
y533  ✓ Design challenge     08:39    11m07s    attempt 3 · ?✗✓   passed · 8 P2 notes              ▇▇
      ✓ Launch game worker   08:50    28m21s    attempt 1         worked · stopped cleanly           ▇▇▇▇▇▇▇▇
      ✓ Freeze handoffs      09:19    0s        attempt 1         snapshots captured                        ▏
      ✓ Verify game          09:19    10m02s    attempt 3 · ✗✗⚑⚒✓ passed after operator repair 1            ▇▇▇
      ✓ Verify candidate    ≈09:29   ≈1m06s    attempt 1         game ✓ 5 checks                              ▇
y673  ✗ Independent review  ≈09:30   ≈2m10s    attempt 1         blocked by general · 1 P1 · 3 P2              ▇   <- focus row, bottom y701
      ○ Integration approval   —        —       —                 not reached
y729  ○ Integrate candidate    —        —       —                 not reached
y765  Select a step to open its evidence. ≈ = inferred, no event recorded (hover for the source).  (node-hint)
y793  ACTIVITY … (the first 4 rows fit above y900)
```

**Fold budget at 1440×900.** The Now banner, the lanes line and the graph height vary by run. Everything else is fixed.

| Block | Height (px) | Rule that bounds it |
|---|---|---|
| App header row + breadcrumb | 48 + 4 + 28 | one row on Projects routes (S3, App.tsx) |
| Run header | 56 | 2 lines; everything else is in `Details ▸` |
| Now banner | 16 + 21 per line + 18 for the one-line caption "Run these in your terminal; this viewer never changes a run", ≤ 9 lines (≤ 223) | headline 1, reason ≤ 2 (clamped, `More`), next-step label 1, command steps ≤ 5. The `$PY/$RUN` legend is a disclosure on the label line. |
| Tabs | 40 | — |
| Lanes line | 0, or 48 for 2 lanes (≤ 3 lines, then `+n more`) | only for runs with 2+ lanes |
| Graph | 96 for 1 row, 176 for 2 rows | `dag.ts` 56 px nodes, 24 px row gap, 16 px padding, plus 8 px box padding |
| Legend | 28 | 3 chips on one line |
| Steps header | 28 | the `<caption>` is visually hidden; the time axis is the bar column's header |
| Steps rows | 28 each | one line per row; the outcome cell ellipsizes, and its full text stays in the DOM |
| Gaps | 8 between the run header, Now, lanes and tabs blocks | — |

Two runs checked against the budget:
- **skeleton-001** (1 lane, 8 steps, a 7-line banner): the focus row (review, row 6) spans y673-701, and the last row ends at y757.
- **workflow-guardrails-001** (2 lanes, 9 steps, a 9-line banner for the repair steps): banner y152-375, lanes line 383-431, tabs 439-479, graph 479-655, legend 659-687, Steps header 687-715. The focus row (candidate, row 6) spans y855-883, inside 900.

The `run-steps-timeline` scenario asserts this with the fixtures (12.2).

Below the fold, on the same default tab (`run-timeline`):

```
ACTIVITY  oldest first · [Newest first]  [ ] Controller log (5)            (run-timeline)
 08:39:42  Design challenge   attempt 1 started (print job)                 ended without a record · 6m13s
 08:45:55  Design challenge   attempt 2 started after re-pinning feature files
 08:46:41  Design challenge   ✗ attempt 2 interrupted (KeyboardInterrupt) · 46s
 08:48:20  Design challenge   attempt 3 started
 08:50:49  Design challenge   ✓ attempt 3 passed · 8 P2 notes · 2m29s
 08:50:52  Launch game worker  session started (from launch receipt)
           ┆ worker working 28m21s
 09:19:13  Launch game worker  stopped cleanly (from stop receipt) · snapshots frozen
 09:19:13  Verify game        attempt 1 started · revision 5c1a734
 09:20:20  Verify game        ✗ attempt 1 failed · unit, integration: no passing test evidence · 1m07s  [open ›]
 09:20:23  Verify game        attempt 2 started · same revision
 09:21:30  Verify game        ✗ attempt 2 failed · same reasons · 1m07s                                 [open ›]
 09:21:32  ⚑ Controller       diagnosis: game failed identically on attempts 1 and 2; not transient.
                              Before review a code fix is a lane repair (RUNBOOK).
           ┆ operator time 5m37s
 09:27:09  ⚒ Operator         repair 1: snapshot 50b14b3 = 5c1a734 + b27d726 (2 files added, 1 changed)
 09:28:00  Verify game        attempt 3 started · revision 50b14b3
 09:29:15  Verify game        ✓ attempt 3 passed · build, browser gated at the candidate · 1m15s
 09:30:21  Verify candidate   ✓ combined revision 0bc381f · ≈1m06s (start inferred from Verify game)
 09:32:31  Independent review ✗ blocked by general (1 P1) · coverage superseded · ≈2m10s
                              (print transport records no start; start inferred from the candidate)
```

**Variants.**
- **Succeeded run** (skeleton-fixes-001):
  - Now banner: `✓ Integrated ee742989 into feature/skeleton-fixes/skeleton-fixes-001 · no push performed · took 31m50s · review approved by general and coverage · 2 open P2 [view]`.
  - "Next: nothing required by the workflow; merging or pushing the branch is your decision." No `git push` command is shown.
  - Live chip: `○ Finished · not polling`.
- **Two-lane run** (workflow-guardrails-001):
  - The Steps table has one row per lane node, and the bars overlap for the two workers from 19:32:57 to 20:08:49.
  - Below the Now banner a one-line-per-lane block appears. It shows only for runs with ≥2 lanes, and repeats no step durations:
    ```
    Lanes   controller  worker ✓ · verify ✓ attempt 2 (1 failed) · candidate ✓ 5 checks
            ui          worker ✓ · verify ✓ · candidate ✗ attempt 2 of 3: project-workflows-browser — screenshot missing for inert-markdown
    ```
  - Now banner: `✗ Blocked at Verify combined candidate · lane ui failed identically on attempts 1 and 2 · 20:27`. The reason is taken from `results/candidate_ui/1` and `/2` `error.message`.
  - Next, as five numbered lines (the 9-line banner in the fold budget). This is RUNBOOK "Blocked after freeze: repair a lane", which uses this exact run as its example:
    1. `"$PY" -m workflow repair "$RUN" ui --workspace`
    2. commit the fix in `$RUN/repair-workspace-<n>`, never on the source branch
    3. `"$PY" -m workflow repair "$RUN" ui --commit <sha> --reason "<why>" --dry-run`
    4. the same command without `--dry-run`
    5. `"$PY" -m workflow automatic "$RUN" --live`
  - Activity shows the controller outages as gap rows. Example: `┆ controller not running 4m56s ([Errno 2] 'claude' not found) → restarted 19:47`. The outage is also drawn as a hatched band on the overlapping worker bars.
- **Live run** (for example duel-core-001 while its worker runs):
  - Now: `● Running · Launch duel worker · working 5m · deadline 14:12 (2h55m left) · last activity 40 s ago: waiting for the worker's completion signal`.
  - "No action needed: the controller is supervising."
  - An optional `$ "$PY" -m workflow.interactive attach-one "$RUN" --node duel [Copy]` is offered to watch the pane.
  - The running Steps row's bar grows to *now*.
  - Chip: `● Live · updated 2 s ago · controller running`. With B2 `activity.controller` it reads `not_running` on polls spanning at least 15 s. The chip then turns amber, `▲ controller not running`, and the Now banner switches to rule 5 (Interrupted) with `"$PY" -m workflow automatic "$RUN" --live`.
- **Interrupted** (Ctrl-C, a closed terminal, Claude Code unavailable). The banner reads `‖ Interrupted at <focus step> · <time>: the controller stopped; sessions keep running`, with the same `automatic --live` command. The interruption can be recorded in three places, and 6.2 rule 5 lists them: a run-level controller row, the review node itself, or the freeze on the handoff node.
- **Blocked before freeze** (a worker deadline, a `status: blocked` completion, a fourth question, a rejected completion file, a vanished session). The banner reads `✗ Blocked before freeze at Freeze worker handoffs · Worker game deadline exhausted; no automatic relaunch`. The next step is a new run (6.2 rule 6); `repair` refuses these runs.

In S3 an Activity attempt row's `[open ›]` opens its node, `/nodes/<n>`. S4-core retargets it to `/nodes/<n>/attempts/<k>` when it adds that route.

### 4.3 Run page at 390×844

```
┌──────────────────────────────────────┐
│ MD Manager                 [Refresh] │
│ (Pi) (Claude) (Projects)             │
│ ‹ skeleton / skeleton-001 ✗          │
├──────────────────────────────────────┤
│ Pirate Sea Race walking skeleton     │
│ skeleton-001  [✗ Failed]             │
│ 08:39 → 09:32 · 52m51s   [Details ▸] │
│ ● Watching · updated 2 s ago         │
│┌ NOW ───────────────────────────────┐│
││ ✗ Blocked by review                ││
││   Independent review · 09:32       ││
││   (2 h ago)                        ││
││ general: 1 open P1 — Private       ││
││ matches can be joined without      ││
││ their code          [Open ›]       ││
││ Next: a new run for the fixes      ││
││ (3 steps, RUNBOOK "Changed code")  ││
││ ┌────────────────────────────────┐ ││
││ │1 $ "$PY" -m workflow init <fix…│→│ │  <- the code box scrolls sideways, the page does not
││ └────────────────────────────────┘ ││
││ [Copy]                             ││
│└────────────────────────────────────┘│
│ [Run] [Assignment]                   │
│ STEPS  (graph hidden < 760 px)       │
│ ✓ Design challenge   08:39   11m07s  │
│   attempt 3 · ?✗✓ · passed · 8 P2    │
│ ✓ Launch game worker 08:50   28m21s  │
│ ✓ Freeze handoffs    09:19   0s      │
│ ✓ Verify game        09:19   10m02s  │
│   attempt 3 · ✗✗⚑⚒✓ · after repair 1 │
│ ✓ Verify candidate  ≈09:29  ≈1m06s   │
│ ✗ Independent review≈09:30  ≈2m10s   │
│   blocked by general · 1 P1          │
│ ○ Integration approval · not reached │
│ ○ Integrate candidate · not reached  │
└──────────────────────────────────────┘
```

Tapping a step opens the node view. It scrolls to the top and moves focus to the node heading (`h3`, `tabIndex=-1`), so the detail is never about 2,000 px down. Going back restores focus to the originating Steps row.

### 4.4 Node view shell (all kinds)

```
Projects / project-B / Pirate Sea Race walking skeleton / skeleton-001 ✗ / Verify game
┌ sticky (run-node-list, 44 px) ───────────────────────────────────────────────────────────────────────┐
│ ‹ Run │ ✓ Challenge 11m │ ✓ Launch game 28m │ ✓ Freeze │ ◉ Verify game 10m │ ✓ Candidate ≈1m │ ✗ Review ≈2m │ ○ Approval │ ○ Integrate │ ‹ Prev  Next › │
└──────────────────────────────────────────────────────────────────────────────────────────────────────┘
skeleton-001 [✗ Failed] Did not complete · Blocked by review at Independent review · 2 h ago · Next step ›   ● Watching
  (run-status, run-status-meaning: one line; the full Now banner is on the run page)
```

**Sticky step strip.**
- It carries `run-node-list`. Each `li[data-node-id][data-status][data-attention]` holds an `<a aria-current>`.
- Lanes are stacked within a column, in the same column order as `layoutDag`. Labels are shortened.
- At ≤760 px it becomes a horizontally scrollable chip row with the current chip scrolled into view. Only the strip scrolls sideways, never the page.
- There is no SVG graph on node pages (Appendix B, decision 2).

The node header follows (`node-detail`):

```
Verify game                                         [✓ Succeeded] · trusted verifier (node-executor)
attempt 3 (node-attempt) · 09:28:00 → 09:29:15 · 1m15s · setup 42s · checks 33s       (node-timing)
Gate passed after operator repair 1; build and browser recorded here, gated at the candidate.
Attempts  [#1 ✗ 09:19 · 1m07s · unit, integration]  [#2 ✗ 09:20 · 1m07s · same]  ⚑  ⚒ repair 1  [#3 ✓ 09:28 · 1m15s]
[Gate] [Checks 5] [Screenshots 2] [Artifacts 2] [Requirements] [History 7]   Worker's report → Launch game worker ›
```

**Header rules.**
- **Status line.** It is worded by cause and keeps `node-status-meaning` (section 8).
- **Timing line.** It names its source only when that source is not an event, for example "(from launch and stop receipts)" or "≈ start inferred from the candidate".
- **Attempt strip** (`node-attempts`):
  - It appears only when the attempt count is above 1.
  - Chips are links to `/attempts/<k>`. A chip is rendered only after its `results/<lane>/<k>` fetch returns 200 (for the candidate, `results/candidate_<lane>/<k>` per lane).
  - Diagnosis ⚑ and repair ⚒ markers come from the run-level rows (section 5).
- **Section index** (`section-index`):
  - It is a row of in-page anchor links with counts, and it sticks under the strip once scrolled.
  - An empty section gets no chip and no body.
  - History is always last and always rendered (`node-events` / `events-none`).
- **Next step.** When this node is the run's focus, a `node-next` line repeats the Now banner's next step.

### 4.5 Worker lane: `launch_<lane>` (launch_game)

```
Launch game worker                                       [✓ Succeeded] · agent session
Worked 08:50:52 → 09:19:13 · 28m21s · stopped cleanly (from launch and stop receipts)
Session ended its turn. This is not workflow completion — verified by Verify game ›          (node-status-meaning)
Frozen at handoff as 5c1a734; verified on attempt 3 after operator repair 1 ›
[Report] [Files 75 · 3 with findings · +3 repair] [Task] [Session] [History 3]
── Report (worker-completion) · completed · as signalled by the session, not verified ─────────────────
Implemented the Pirate Sea Race walking skeleton: Colyseus MatchRoom with private join codes, input gate
at 30 frames, Phaser client…                                                                  [More]
Untested (2) ▸   Falsifying check: browser → Verify game ›   Verify yourself ▸   Open assumptions (10) ▸
── Files (changed-files) · 75 frozen at handoff ─────────────────────────────────────────────────────
Show: (With findings 3) (Repair 1 · 3) (All 78)                                     [ ] Group by folder
 ▸ P1  apps/server/src/MatchRoom.ts                         captured      general · lines 44–50
 ▸ P2  apps/server/src/inputGate.ts                         captured
 ▸ P2  apps/web/src/connection.ts                           captured
 ▾ ⚒   vitest.config.ts                                     changed by repair 1
     sha256 3f9a1c… (tooltip) · (Source) (Rendered)   file-findings-none: No review finding names this file.
     │ 1 │ import { defineConfig } from 'vitest/config' …          (max-height 480 px, own scroll)
 ▸ ⚒   tests/reporters/testSummary.ts                       added by repair 1
 ▸     CLAUDE.md                                            captured · Markdown (opens Rendered)
 …
── Task ▸ (task-details, closed; a finding's requirement link opens it)
── Session ▸ (launch-receipt, worker-stop, session id, base/output commit; closed)
── History (node-events) · 08:50 launching · 08:50 waiting for the completion signal · 09:19 stopped, snapshot frozen
```

**Report and files.**
- **File list source.** The file list comes from the worker's own freeze, `results/<lane>/1`. When the node's latest result is a later attempt, paths whose `sha256` differs, or which exist only in the later result, get a `⚒ repair n` badge (detail-density:repair-files-misattributed).
- **Row expansion.** Rows are `<summary>` elements, never buttons whose text is a path. Nothing is fetched until a row opens, and Markdown files start closed.
- **Finding links.** A finding link from the review node opens the row and scrolls it into view (existing `keepInView`).
- **Report text.** "Reported by the worker" is shown once. When `result.summary` extends `completion.summary`, only the added text is shown, as `Verifier note: Operator repair 1 …`.
- **"State at launch".** The Session disclosure relabels `observed_state` as "State at launch" and hides it, and the launcher status, once `stop.confirmed_at` is set.

**Question waiting** (fixture `RUN_GUARDED_ASKING`, live `duel-core-001`). A highlighted Questions section (`worker-questions`, `worker-questions-waiting`) comes first, above Report:

```
? Question 2 of 3 · asked 11:40 (14 min ago) · deadline paused
  "Keep the seed on rematch, or reroll it?"
  Inside Herdr, with the lane's pane showing its session:
  $ "$PY" -m workflow answer "$RUN" duel "<your answer>"                                   [Copy]
  From any other shell (SSH from the Mac): record it, then type it into the session it prints
  $ "$PY" -m workflow answer "$RUN" duel "<your answer>" --no-herdr                        [Copy]
  Outside Herdr the first form records the answer and restarts the deadline, then exits 1: the worker
  has not received it. (RUNBOOK "Guardrails › Worker questions")
```

The two forms follow guardrails.py:996-1001 (`directory node text`, `--no-herdr`) and RUNBOOK:56. The first form types into the lane's pane only while running inside Herdr (`HERDR_ENV=1`) and while that pane shows `claude attach <id>` in its foreground. `--no-herdr` prints `claude attach <id>`, and typing the answer there counts as the delivery.

When a worker is running, the header shows `Working 12m · deadline 11:50 (2h38m left)`, or `deadline paused while question 2 waits`.

### 4.6 Verification: `verify_<lane>` and candidate

`verify_game`, latest attempt (see 4.4 for the header). Its sections:

```
── Gate (gate-outcome) · passed · 3 gating checks; build and browser gated at the candidate (deferred-checks)
── Checks (checks-list) ─────────────────────────────────────────────────────────────────────────────
 ✓ typecheck    npm run typecheck                          +0:42   3s   exit 0   [Show contents]
 ✓ unit         npm run test:unit                          +0:45   2s   exit 0   [Show contents]
 ✓ integration  npm run test:integration                   +0:47   5s   exit 0   [Show contents]
 ◐ build        npm run build          gated at candidate  +0:52   4s   exit 0   [Show contents]
 ◐ browser      npx --no-install playwright test …  gated  +0:56  19s   exit 0   [Show contents]
   Setup npm ci 42s (log) · cwd and artifact ids in each row's tooltip
── Screenshots (screenshots) · 2  [thumb 220px] [thumb 220px]   click: full size in <dialog>
── Artifacts ▸ (artifacts, closed) · test report (JSON) · log (not a check log)
── Requirements ▸ lane game: typecheck · unit · integration · build (candidate) · browser (candidate:
   join-private-match, two-ships-sync) · timeouts · attempt cap 3 per revision · owned paths (16)
── History (node-events) · attempt 1 09:19–09:20 ✗ · attempt 2 09:20–09:21 ✗ · ⚑ diagnosis · ⚒ repair 1 · attempt 3 ✓
```

**Attempt 1** (`/nodes/verify_game/attempts/1`, served `results/game/1`):
- Header: `✗ Failed · attempt 1 · 09:19:13 → 09:20:20 · 1m07s`.
- Gate: `Failed: 2 checks rejected`, with one bullet per reason from `error.message` split on `"; "` and keyed by its `<check id>:` prefix.
- The rejected rows are red: `exit 0 · rejected by the gate: no passing test evidence` (`check-rejected`), with their log tails open.
- Banner: `You are viewing attempt 1 of 3. The latest is attempt 3 ›`.

**Reasons without a check id.** Some segments carry no `<check id>:` prefix. For example, workflow-guardrails-001 `results/controller/1` has `error.message` = `Executed check failed: <path> -m workflow.run_tests; workflow-unit: no passing test evidence or failed tests; workflow-unit: exit 1`.
- The message is redacted, but `checks[].command` is not (`/home/…/.venv/bin/python -m workflow.run_tests`). So neither a prefix match nor an exact command match finds the check.
- Such segments are listed as gate-level reasons, above the check table (`gate-reason` with `data-check-id` absent).
- When the text after `<path>` (here ` -m workflow.run_tests`) is the tail of exactly one check's `command`, the reason is also attached to that row. For `controller/1` that is the `workflow-unit` row, which exited 1 and is red anyway.
- With two or more matching tails, or none, the reason stays gate-level only. The viewer never guesses between checks.

**Candidate** (workflow-guardrails-001, `candidate` at attempt 2). The node starts with a lane table (`lane-results`), failing lanes first:

```
Lane        Gate  Checks  Reason                                                        Screenshots
ui          ✗     3 of 3 exit 0, 1 rejected   project-workflows-browser: Expected one screenshot    0
                  attempt 2 of 3 · failed identically on attempts 1 and 2 → repair (see Now)
controller  ✓     5 of 5                                                                             —
```

- Each lane expands to the same Gate, Checks and Screenshots blocks (`lane-result:<lane>`). Failing lanes open, passing lanes stay closed.
- These are dropped: the fixed "Trusted candidate check capture…" summary, "No open assumptions were recorded." and the per-lane ownership sentence (which becomes a tag in the gate line).

### 4.7 Review

```
Independent review                  [✗ Failed] Blocked by review · one print job per reviewer (node-executor)
≈09:30:21 → 09:32:31 · ≈2m10s (print transport records no start; start inferred from the candidate)
This step failed. 1 finding blocks integration.                                      (node-status-meaning)
Next · findings after review are fixed in a new run (RUNBOOK › Changed code)                  (node-next)
┌ P1 · open · general · lane game ───────────────────────────── apps/server/src/MatchRoom.ts:44–50 ┐
│ Private matches can be joined without their code.                                                │
│ authorizeEntry (apps/server/src/MatchRoom.ts:44-50) treats any request whose options lack `code`…│
│ [More]   [Open file at lines 44–50 ›]   [Requirement in the game task ›]                         │
└──────────────────────────────────────────────────────────────────────────────────────────────────┘
Reviewers (reviewer-strip)
  general   ✗ blocked      1 P1 · 3 P2   verdict 09:32:31   launch time not recorded (print)
  coverage  – superseded   no verdict    stopped when general's block decided the run
[Blocking 1] [Findings 4] [Diff 21 files] [History 0]
── Findings (review-findings) · Group: (Disposition)(Worker)(Reviewer)  Reviewer: All ▾  [?]
   table above 760 px, cards at 760 px and below (`finding` on both); P2 rows one line with [More]
── Diff (review-diff) · per file, collapsed; raw patch link kept
── History (events-none) · No events were recorded for this review (print transport). Verdict 09:32:31.
```

**Native review** (skeleton-fixes-001): `general ✓ approved 3m49s · coverage ✓ approved 2m04s`. While reviewers run, each shows elapsed time and time left, for example `working 3m · deadline 11:10 (56m left)`.
- The deadline is `reviewers[].launched_at + inputs.automatic.review_timeout_seconds`. `reviewerEntrySchema` serves `launched_at` and `accepted_at` only (contracts/projects/v1.ts:94-106). The controller counts from the receipt's `launch_requested_at` (RUNBOOK "Automatic mode: the review step › Deadline"), so the shown deadline carries `≈`.
- With `launched_at` null (print transport, skeleton-001), no deadline is shown: "launch time not recorded".

Hiding single-value columns is decided over the whole review, not per group, and never hides the header row. reviewers.spec.ts:86 asserts all five headers on a multi-valued fixture, and it must stay green.

### 4.8 Challenge

```
Design challenge                                         [✓ Succeeded] · one print job
Passed on attempt 3 · 8 P2 notes · decided 08:50:49 · 11m07s over 3 attempts
Attempts  [#1 ? 08:39 · ended without a record]  [#2 ✗ 08:45 · 46s · interrupted]  [#3 ✓ 08:48 · 2m29s]
[Concerns 8] [Alternative & experiment] [History 7]
── Concerns: P0/P1 open by default; P2 one line each, expandable to message and consequence
```

**Paused** (skeleton-fixes-001 at 09:44): `‖ Paused: the design challenge found 1 P1; no worker was launched.` The P1 is shown in full, with next steps:
- edit the feature files, then `"$PY" -m workflow resume "$RUN"`; or
- `"$PY" -m workflow resume "$RUN" --accept-challenge "<reason>"`.

Earlier challenge attempts show only what the events say. The concern lists of earlier attempts are not served (follow-up C8), so their chips have no link.

### 4.9 Handoff, approval, integrate

A single panel with no index. The History section is inline.

```
Freeze worker handoffs     [✓ Succeeded] · controller
09:19:13 · workers stopped and snapshots captured (game) · waited 28m21s for the completion signal
                                                  (wait = latest launch start → freeze; from receipts)
Integration approval       [✓ Succeeded] · controller
≈10:14:07 · approved automatically by the finish policy (verified-feature-branch) · no approval event recorded
Integrate candidate        [✓ Succeeded] · controller
10:14:07 · fast-forwarded feature/skeleton-fixes/skeleton-fixes-001 to ee742989 · no push performed
```

**Awaiting approval** (manual runs, `awaiting-notice`, which keeps "Viewing does not approve it"):
- Text: `Awaiting your approval since 10:14 (12 min)`, taken from the node's last status event.
- Command: `"$PY" -m workflow approve "$RUN" --bundle-sha256 <hash>`, with the hash filled in from the review result's `bundle_sha256`.
- A manual run's handoff awaiting the operator shows `"$PY" -m workflow freeze "$RUN" --handoff <lane>=<handoff.json>` once per lane (RUNBOOK §4).

### 4.10 Assignment tab (`/runs/<r>/assignment`)

Keeps `tab-run`/`tab-assignment` (`role=tab`, `aria-selected`, arrow keys, Home/End), the `assignment` tabpanel with `aria-controls`, and every `assignment-*` testid. The graph is not rendered on this view (inputs.spec.ts:56). Order:

1. One summary line: feature · branch · mode · deadlines · reviewer transport · `Attempt cap 3 per lane and phase`. This replaces the 7 repeated facts, and every string inputs.spec.ts:57-64 asserts stays.
2. Lanes table: lane · role · required check kinds · owned-path count · link to the lane's Task on its launch node.
3. `decisions.md`, collapsed, with a heading outline.
4. Setup commands.
5. Per lane (`assignment-worker`): the task rendered (headings stay visible). The appended "Approved ownership and checks" JSON is folded into a `<details>` whose summary keeps that text. Owned paths are an inline wrapped list. Required checks are one line with scenarios. `id · kind` collapses to one word when the two are equal.

## 5. Timeline and time display rules

### 5.1 Model

`contracts/projects/triage.ts` (pure, no React, shared with the server for B2) exports:

```ts
buildTimeline({ definition, snapshot, events, inputs, review?, laneResults?, now }): {
  runStart: Instant; runEnd: Instant | null;             // runEnd = last non-controller activity, never updated_at
  spans: Span[];      // one per node attempt: node_id, lane, attempt, start, end, status, outcome, live
  markers: Marker[];  // diagnosis | repair | controller_start | controller_error | interrupted | question | answer | log
  gaps: Gap[];        // operator | controller_down | waiting_worker | idle, with from/to/ms
  byNode: Map<string, Span[]>;
}
type Instant = { at: string; source: 'event' | 'receipt' | 'check' | 'review' | 'inferred'; note?: string }
```

It is memoized on `(snapshot.last_sequence, inputs identity, review identity)`, so a 5 s poll that brings nothing new does not rebuild it.

### 5.2 Derivation rules

Each rule carries its source tag, which the UI shows in a tooltip. Each rule has a unit test on the captured payloads.

1. **Attempt number.** Re-read it from the message with `/\battempt (\d+)/i` before falling back to `event.attempt`. The server parser is case-sensitive (server/projects.ts:1067-1070), so every challenge event reads "attempt 1" today. Expected on skeleton-001: challenge attempts 1, 2, 3.
2. **Controller rows.** On any node, a message matching `^Automatic checkpoint controller PID \d+` is a `controller_start` marker, never a node status. A `^\[Errno \d+\]` failure on a node that later succeeded is a `controller_error` marker. This fixes guardrails `launch_controller` #5-#17/#24/#29/#32 until B1 lands.
3. **Spans.** A `running` status event opens a span for (node, attempt). The next terminal status (succeeded, failed, paused, cancelled) closes it. A new attempt that opens while the previous one is still open closes it as "ended without a record". Example: challenge attempt 1, 08:39:42 → 08:45:55.
4. **Receipts and evidence.** When events are missing:
   - A worker span runs from `native_started_at` (else `launch_requested_at`) to `stop.confirmed_at`, or to *now* while running. The source is "receipt". Example: 08:50:52 → 09:19:13 = 28m21s.
   - A review without events ends at `reviewed_at`. Its start is the earliest `reviewers[].launched_at`, else the end of the step it depends on, marked ≈ inferred.
   - A candidate without a `running` event starts ≈ at the end of the last verify step. Example: 09:29:15 → 09:30:21.
   - An approval without an event is ≈ an instant at the integrate event's time, with the note "no approval event recorded".
5. **Run-level rows** (`node_id` null):
   - `failed identically` becomes a **diagnosis** marker (⚑), attached to the lane named in `<phase>/<lane>`.
   - `^Repair (\d+) applied` becomes a **repair** marker (⚒). It carries the snapshot and files from the node's `paused` "Repair n by the operator" event (#20).
   - `Supervisor interrupted` / `Claude Code was unavailable` become an **interrupted** marker.
   - A controller row whose raw status was `blocked` becomes a **controller_blocked** marker (✗). With B1 it is served as `status: 'failed'` on a node-less row. Before B1, it is recognised as a node-less row that is not one of the running-type messages: the PID checkpoint, `^Rerunning `, `^Resuming `, `^Repair \d+ applied`. Examples: `Worker game deadline exhausted; no automatic relaunch` (automatic.py:1284), `… failed identically on attempts 1 and 2 …` (advance_or_block, :1011; this one is also the diagnosis), and `… ended on it in a state no resume continues` (:1323).
   - Anything else is a plain log row.
6. **Gaps.** A stretch of more than 120 s with no event becomes a gap row, classified by what surrounds it:
   - after a diagnosis, failure or pause and before a repair or resume: **operator time**. Example: skeleton-001, 5m37s.
   - after a `controller_error` and before a `controller_start`: **controller not running**. Example: guardrails, 4m56s and 6m35s. This applies even inside a worker span, where it is drawn as a hatched band on that bar.
   - inside a worker span with no other cause: **worker working**. Example: 28m21s.
   - otherwise: **no activity**.

   Silences over 30 min get an axis break in the Steps bars, so overnight gaps do not squash the chart.
7. **Questions.** Each `asked_at` gets a row ("duel asked question 2 · waited 5m"), and so does each `answered_at`. While `answer === null` the row is live. When the export is stale, the question event message is the fallback (section 6.2, rule 1).
8. **Setup and check split** (node view only): attempt start → first `checks[].started_at` is setup; first `started_at` → last `finished_at` is checks. Example: 42 s + 33 s.
9. **Worker deadline**: `native_started_at + worker_timeout_seconds + Σ(question waits)`. **Reviewer deadline**: `launched_at + review_timeout_seconds`.
10. **Run span**: `created_at` → the last non-controller activity (events, `reviewed_at`, `stop.confirmed_at`). For skeleton-001 that is 52m51s ending 09:32:31, not "Updated 09:36:07".
11. **Lane on candidate events.** Until B1 prefixes the lane, candidate failures are matched to lane results by comparing an event's time with each lane result's last `checks[].finished_at`. Guardrails #28 → `candidate_ui/1`, #31 → `candidate_ui/2`.

### 5.3 Display rules

| Rule | Detail |
|---|---|
| Element | Every time is `<time dateTime={iso} title="2026-09-24 09:32:31 UTC">`. `src/projects/Time.tsx` replaces the ~20 `formatTime` call sites. |
| Zone | Local by default. The Local/UTC toggle (`time-zone-toggle`) sits on the run header, next to the live chip; S1 puts it beside the chip on today's run title row, and S3 moves both into `RunHeader` without changing their testids. It is stored in `localStorage` key `mdm.projects.timezone`. Every read and write is wrapped in try/catch, and the page renders correctly without it. In UTC mode the Steps "Started" header and the Activity heading say "UTC"; times are not suffixed one by one. |
| Clock | `HH:MM` in headers, Steps and lists. `HH:MM:SS` in Activity rows and node timing lines. The date is prefixed (`Sep 23`, or `yesterday` in lists) only when it differs from the run's start day or today. |
| Relative | "3 min ago" appears on headers, Now, list rows and the live chip for items under 24 h. Activity rows use durations and gaps instead. |
| Durations | `formatSpan`: `46s`, `2m29s`, `28m21s`, `1h05m`. It is shown on the run header, Steps rows, bars, node timing, check rows, reviewers and run-list rows. Inferred values get a `≈` prefix plus a source tooltip. Missing values show `—` or "not recorded", never a guess. |
| Attempts | "attempt k" everywhere. Verification and candidate add "k of N on this revision" (N = `inputs.max_verification_attempts`, restarted by a repair) while the node is live or failed. Steps markers: `✗` failed, `?` ended without a record, `⚑` diagnosis, `⚒` repair, `✓` passed. Pending: "not started", never "attempt 0". |
| Ticking | One `useNow` at RunView. It ticks every 1 s while the run is not terminal and the tab is visible, and does not tick otherwise. |
| Order | Activity is oldest first by default, with a remembered "Newest first" toggle. The Now banner always carries the latest state. |
| Humanized messages | SHAs are cut to 7 characters. Known phrases are mapped, for example "Awaiting explicit completion signal; idle is not acceptance" → "waiting for the worker's completion signal (idle is not acceptance)". The sequence number and full message sit in an expander. |

## 6. Live state and next action

### 6.1 Command form

- **Syntax.** Commands use the RUNBOOK's own convention: `"$PY" -m workflow <cmd> "$RUN" …` (RUNBOOK.md:110-111, 261, 269, 301).
- **Legend.** Each command block has a `$PY/$RUN ▸` disclosure on its label line: *PY: md-manager's `.venv/bin/python`, run from its checkout. RUN: this run's directory.*
- **With B3.** A second copyable line, `RUN=~/.local/state/agent-workflows/project-B/skeleton/skeleton-001`, makes the command paste-ready.
- **Without B3.** The disclosure says that RUN is `<runs root of this workflow>/<run id>`, and that the path is not served by default.
- **Placeholders.** They stay visible as `<…>`. The viewer never invents a feature name, run id, commit or reason.
- **Multi-step next steps.** They are a numbered list. Each command line has its own Copy button, and a step that is not a command is plain text ("commit the fix in …").
- **Copy.** The Copy button's text is exactly "Copy" (aria-label "Copy command"). The command lives in `<code>` outside any button, so `expectNoExecutionControls` (support.ts:32-36) still passes. When the clipboard API is unavailable (a non-secure http origin), Copy selects the `<code>` text instead.
- **Label.** The block is always labelled "Likely next step" and names its RUNBOOK section. Its one-line caption is the command-block honesty statement: "Run these in your terminal; this viewer never changes a run."
- **`status` is not described as read-only.** It "reports the run's state and changes no run progress; it refreshes `report.html` in the run directory" (RUNBOOK:268-272).

### 6.2 Situations

`deriveNow()` in `triage.ts` checks the rules in this order, and the first match wins. Each rule sets `run-now[data-situation]` to the id in the Situation column.

**Scope rule.** The classifier reads only:
- each node's snapshot status;
- the focus node's latest status event, result and lane results;
- the run's `inputs` (questions, completion, challenge);
- run-level rows (`node_id: null`) inside the **scope window**. The window opens at the focus node's latest `running` status event. If it has none, it opens at the latest status event of any node it depends on, which for `handoff` means the lanes' launch events.

It never matches older `[Errno …]`, `KeyboardInterrupt` or `blocked` rows. Guardrails has four stale Errno failures between 19:33 and 20:03, and skeleton-001 has one at 08:46.

**Focus node.** The first node in definition order whose status is `failed`, `paused` or `awaiting_approval`, else the first `running` node. Ties go to the latest event.

| # | Situation (`data-situation`) | Detected from (current state only) | Now headline | Likely next step (verified against the CLI) | RUNBOOK |
|---|---|---|---|---|---|
| 1 | **Question waiting** (`question`) | Any of: B2 `activity.waiting_questions > 0` (live `<lane>.questions.json`); `inputs.workers[].questions` whose last `answer === null`; `completion.status === 'question'`. Fallback: the lane's latest event is `Worker <lane> asked question N of 3` (guardrails.py:760) with no later status event for that lane, labelled "from the event log; answered state not yet exported". | `? Waiting on you: game asked question 2 of 3 · 14 min ago · deadline paused` + question text | Inside Herdr: `"$PY" -m workflow answer "$RUN" game "<your answer>"`. From any other shell: the same with `--no-herdr`, then type the answer into the session it prints. One caveat line: outside Herdr the first form records the answer and exits 1 undelivered (guardrails.py:996-1001, RUNBOOK:56). | Guardrails › Worker questions |
| 2 | **Pane needs attention** (`pane_attention`) | The latest event of `launch_<lane>` or `review` says `needs attention in its pane` (automatic.py:281, :556), with no later event for that node; or B2 `activity.attention.kind === 'pane'` | `? Waiting on you: game needs attention in its pane (native state blocked) · since 11:41` | `"$PY" -m workflow.interactive attach-one "$RUN" --node game` (reviewer: `--node review-<id>`) (interactive.py:644-650) | 3. Start and interact; One-command launch |
| 3 | **Awaiting approval** (`awaiting_approval`) | A node with status `awaiting_approval` | `Awaiting your approval since 10:14 (12 min)` | Approval: `"$PY" -m workflow approve "$RUN" --bundle-sha256 <review.bundle_sha256>`, with the hash filled in. Manual handoff: `"$PY" -m workflow freeze "$RUN" --handoff <lane>=<path>`, once per lane. | 6. Approve; 4. Handoff |
| 4 | **Challenge paused** (`challenge_paused`) | Challenge node `paused`, or `inputs.challenge.status === 'paused'` | `‖ Paused: design challenge found 1 P1; no worker launched` | Edit the feature files, then `"$PY" -m workflow resume "$RUN"`; or `"$PY" -m workflow resume "$RUN" --accept-challenge "<reason>"` (guardrails.py:935-941) | Guardrails › design challenge |
| 5 | **Interrupted, or waiting to continue** (`interrupted`) | Run status `paused` or `running`, and one of the four cases below | `‖ Interrupted at <focus step> · 10:02: the controller stopped; sessions keep running`. For case (d): `‖ Repair 1 applied; the run continues when you resume it` | Cases (a)-(c): once `claude --version` works, `"$PY" -m workflow automatic "$RUN" --live`. Case (d): the command the message names, `automatic "$RUN" --live` for an automatic run or `retry "$RUN"` for a manual one (repair.py:109-114). | Status, failures and recovery › Claude Code unavailable (exit 75); 5. Automatic mode: the review step › Interruption; Blocked after freeze |
| 6 | **Blocked before freeze** (`blocked_before_freeze`) | Automatic run; the focus is `handoff` or a `launch_<lane>` with status `failed`; no `verify_*` node has started; and either a `controller_blocked` row is inside the scope window (reason source 0), or `inputs.workers[].completion.status === 'blocked'` | `✗ Blocked before freeze at Freeze worker handoffs · <cause>`. Examples of `<cause>`: `Worker game deadline exhausted; no automatic relaunch`; `game reported blocked: <completion.summary>`; `game asked a fourth question: <text>` | "`repair` refuses a lane blocked before freeze; an automatic run then needs a new run." Steps: (1) if a `Could not confirm worker stop` row is in scope, stop those sessions by their exact ids first (RUNBOOK "Stopping an unfinished run"; text, no command); (2) fix the cause in the feature files if it lies there, and commit; (3) `"$PY" -m workflow launch <feature> --repo <target repo> --run-id <new run id> --live --automatic` | Status, failures and recovery › Blocked after freeze (Refused, RUNBOOK:315); One-command launch |
| 7 | **Blocked, identical failure before review** (`blocked_identical`) | The focus is a failed `verify_<lane>` or `candidate`; **and** either the diagnosis marker for that lane is in scope, **or** its latest two attempt results (`results/<lane>/<k-1>`, `/<k>` or `candidate_<lane>/…`) have the same `error.message`; **and** no review has started (review node `pending`, no review result). This catches guardrails, which has no diagnosis event. | `✗ Blocked at Verify combined candidate · lane ui failed identically on attempts 1 and 2 · 20:27` + reason | (1) `"$PY" -m workflow repair "$RUN" ui --workspace`; (2) commit the fix in `$RUN/repair-workspace-<n>`; (3) `"$PY" -m workflow repair "$RUN" ui --commit <sha> --reason "<why>" --dry-run`; (4) the same without `--dry-run`; (5) `"$PY" -m workflow automatic "$RUN" --live` (repair.py:560-569). Manual runs use `retry "$RUN"` in place of `automatic`. | Blocked after freeze: repair a lane |
| 8 | **Check failed, attempts left** (`check_failed`) | Failed verify or candidate below the attempt cap, not identical | `✗ Verify game failed attempt 1 of 3: unit, integration — no passing test evidence` | Automatic run: "No action: the supervisor retries by itself within the limit." Manual run: `"$PY" -m workflow retry "$RUN" --phase worker\|candidate --node <lane>` (pipeline.py:881-882) | Status, failures and recovery › Failed verification |
| 9 | **Review blocked** (`review_blocked`) | `review.verdict === 'blocked'` | `✗ Blocked by review at Independent review · general: 1 open P1 — <first sentence>` + reviewer statuses | "Review findings are fixed in a new run, not repaired in place." Three steps: (1) `"$PY" -m workflow init <fixes-feature> --repo <target repo>` (scaffold.py:101-104); (2) fill in the TODOs it writes (`/workflow-grill <fixes-feature>` writes `decisions.md`), then commit the feature files in the target (launch refuses a TODO placeholder and an unknown feature, launch.py:68, :171); (3) `"$PY" -m workflow launch <fixes-feature> --repo <target repo> --live --automatic` (launch.py:250-263) | Status, failures and recovery › Changed code; 5. Automatic mode: the review step › Verdict; 1. Define and commit the feature contract |
| 10 | **Running** (`running`) | Any node `running` | `● Running · <active steps with elapsed and deadline> · last activity 40 s ago: <message>` | "No action needed: the controller is supervising." Optional: `"$PY" -m workflow.interactive attach-one "$RUN" --node <lane>` to watch a pane | — |
| 11 | **Succeeded** (`succeeded`) | Run `succeeded` | `✓ Integrated <commit7> into <source_branch> · no push performed · took 31m50s · review approved · 2 open P2 [view]` | "Nothing required by the workflow. Merging or pushing is your decision." **No command is shown.** | 6. Approve local integration |
| 12 | **Cancelled / pending** (`inactive`) | Run status | One plain line | None | — |
| 13 | **No rule matched** (`no_rule_matched`) | A failed or paused run that none of rules 1-9 matched | Failed: `✗ Failed at <focus step> · <reason>`. Paused: `‖ Paused at <focus step> · <reason>`. Never "Failed" for a paused run. | "No known next step matched." `"$PY" -m workflow status "$RUN"` (reports state and changes no run progress; refreshes `report.html`), plus a RUNBOOK link | Status, failures and recovery |

**Rule 5, the four cases.** All four look only inside the scope window, and the headline says which one matched.
- **(a) Controller interrupted.** A run-level `interrupted` marker, with no later status event:
  - `RESUME_NOTE`: Ctrl-C while waiting on the workers (automatic.py:1116, emitted at :1272).
  - `UNAVAILABLE_NOTE`: Claude Code was unavailable (:1121, emitted at :1278 and :1316).
  - With B1 these rows are served as `status: 'paused'`. `projectSnapshot` already shows the handoff as `paused` from them (server/projects.ts:1116, :1133-1137).
  - `resumable_stop`: drive stopped before any step, at a target checkout off the run's source branch or at a start that did not complete, and stopped or relaunched nothing. Its row names what comes before the resume, and the next step offers that first: switching the checkout back to the run's `source_branch` (RUNBOOK "Source feature branch changed"), or `reconcile "$RUN"`, or `start "$RUN" --live` for a run that was never started (RUNBOOK "Ambiguous startup"); then `automatic "$RUN" --live`.
- **(b) Recorded on the focus node itself.** The focus node is `paused`, its latest status event is the last event for that node, and the message contains `interrupted` or `resume with: python -m workflow automatic`. The redacted `<path>` keeps that substring. This covers two notes:
  - `REVIEW_RESUME_NOTE`, recorded on `review` at automatic.py:624, :738, :804 and :811.
  - `FREEZE_RESUME_NOTE`, recorded on the freeze, which is aliased to `handoff`, at :1314.

  For the review case the controller deliberately writes no controller row (comment at :1315). The server maps the raw `interrupted` status to `paused` on that node (`EVENT_STATUS`, server/projects.ts:377). Before this revision no rule matched these runs, and the fallback printed "✗ Failed at …" with only `status`.
- **(c) Controller not running.** The run status is `running`, and B2 `activity.controller === 'not_running'` on polls spanning at least 15 s (6.3). Examples: a closed terminal or a dropped SSH session that killed the controller without an event (RUNBOOK "Interruption").
- **(d) Repair applied, not yet continued.** The focus is `verify_<lane>` or `candidate`, `paused`, and its latest message contains `Continue with python -m workflow automatic` or `Continue with python -m workflow retry` (repair.py:445). Seen on skeleton-001 #20 until 09:28.

**Reason sources,** in order. Rules 5 (a), 6 and 13 start at source 0; the other rules start at source 1, so a controller row never replaces a review verdict or a gate reason.
0. The latest `controller_blocked` or `interrupted` run-level row inside the scope window (5.2 rule 5), quoted with its time. It is the only source for rule 5 case (a), and the first for rules 6 and 13. An example for rule 13 is `… ended on it in a state no resume continues; inspect retained evidence` (automatic.py:1323), which can happen after freeze.
   - The controller writes these as `runtime.event("controller", "blocked", str(error))` at automatic.py:1284 (the wait for handoffs: deadline, `status: blocked`, a fourth question, a rejected completion file, a session that is gone), :1011 and :1323.
   - `projectSnapshot` already uses the same raw row to mark the handoff failed (`lastController` → `waitingHandoff`, server/projects.ts:1116, :1133-1137). Until B1, `normalizeEvents` serves that row with `status: null` and `type: 'log'` (:1084), so no other source could see why the handoff failed.
1. The review verdict, the blocking findings (`isBlockingFinding`) and each reviewer's `status`.
2. The failing lane result's `error.message`. This is the only extra fetch: one or two lane results, and only when the focus is a failed verify or candidate. Results are cached by URI (section 7).
3. The worker's own completion when `completion.status` is `blocked` or `question`: `completion.summary` or `completion.question`.
4. The focus node's last status event message.

**Wording rules.**
- The generic "Marked retryable by the producer. Retrying is done through the workflow CLI" (NodeDetail.tsx:103-107) is replaced by the matching situation. `server/projects.ts:1235` hard-codes `retryable: true`, so the flag carries no information.
- A viewer message never says "retry" when rule 6 or rule 7 applies.
- The status word follows the run's status: `✗ Failed`, `✗ Blocked`, `‖ Paused` or `‖ Interrupted`. A paused run is never called failed.

### 6.3 Freshness and controller liveness

The live chip is `LiveStatus.tsx` (`live-status`, with `data-state` and, when known, `data-controller`). It sits on the run header next to the Local/UTC toggle, on the one-line run bar of node pages, and on the Runs home heading.

| State | Text | When |
|---|---|---|
| `live` | `● Live · updated 3 s ago` | Run running or awaiting approval, and the last poll succeeded |
| `watching` | `● Watching · updated 3 s ago` | Run failed or paused. It still polls (ProjectsView.tsx:46-52 stops only for succeeded or cancelled) because it can be repaired or resumed. |
| `stale` | `▲ Not updating · showing data from 11:14:02 · retrying` | 2 consecutive poll failures, or 15 s without a success. Announced once. |
| `finished` | `○ Finished · not polling` | Succeeded or cancelled |
| `hidden` | `Paused while this tab is hidden` | `document.visibilityState === 'hidden'` (usePoll already pauses) |

**Controller suffix** (from S6, which reads B2 `activity.controller`; shown only while the run is running or paused):
- `· controller running`
- `· ▲ controller not running`, amber. It is shown only after `not_running` was served on polls spanning at least 15 s. automatic-step exits at every checkpoint and the supervisor starts the next one within seconds (automatic.py:1096-1114), so a single reading can be a hand-over. When shown during `running`, it triggers rule 5 case (c).
- Nothing when the value is `unknown` or null: a manual run, no PID event, or no `/proc`. The viewer never claims liveness it cannot check.

**Other freshness rules.**
- **Source of the ages.** `useResource` gains `meta { settledAt, lastError, failures }`.
- **Refresh.** Header Refresh becomes a background reload: `refreshToken` moves from `base` into `token` (useResource.ts:22-23). The page no longer blanks to "Loading run…", and the scroll position and tab survive. The Projects Refresh button gets the busy state that skills already use (App.tsx:638 vs :641).

### 6.4 Attention outside the banner

- **Kinds.** `data-attention` takes one of three values:
  - `question`: rule 1.
  - `pane`: rule 2. The latest `needs attention in its pane` interactive event of that node has no later event for the node (automatic.py:281 for workers, :556 for reviewers; the server maps `interactive` to `running`, server/projects.ts:373).
  - `approval`: rule 3.
- **Where it shows.** The kind goes on the graph node, the Steps row, the step-strip chip and the run rows (lists read B2 `activity.attention.kind`). Each gets an amber ring and a `?` glyph. "Running" stays the status: attention is an overlay, never a status change.
- **Lists.** Runs home shows a Needs-you row for all three kinds. The project and feature pages show a `?` badge on the row.
- **Tab title.** `document.title` is prefixed with `? ` while any kind waits, for example `? Waiting · duel-core-001 — MD Manager`.
- **Announcements.** The existing ProjectsView announcer (ProjectsView.tsx:75-89) speaks the Now headline only when the situation changes, never on every poll. The banner is not an `aria-live` region.

## 7. Evidence disclosure rules

**Four levels, each one step deeper:**
- **L0, run page.** Answers only: the Now reason, Steps outcomes, and the lanes line.
- **L1, node header.** Status by cause, timing, attempts, and the section index with counts.
- **L2, sections.** Dense rows.
- **L3, on demand.** Logs, file contents, full screenshots, raw events, identifiers.

**General rules:**
- **Fetch on demand.** Content is fetched when its level opens. The only exception is the immutable results the Now banner needs.
- **Caching.** Results and reviews are immutable per URI (`results/<lane>/<k>`, `reviews/<n>`). A run-scoped cache (`src/projects/useRunData.ts`) keeps them for the run's lifetime. Only detail, events and inputs poll every 5 s.
- **Empty sections are absent.** A section with nothing in it gets no index chip and no body. The following stay as one short line because they are honesty statements:
  - `result-none`: a node that should have a result and has none
  - `inputs-none`
  - `events-none`, with its reason where known, e.g. "print transport records none"
- **Dedup by `result_uri`.** When a launch node and its verify node share a `result_uri`, the result facts (commits, session) are shown once, on the verify node, and the worker narrative once, on the launch node.

**By evidence type:**

| Evidence | Rule |
|---|---|
| Checks (`checks-list`, `.check`, `.check-exit`) | One row each: glyph, check id (matched to `inputs.workers[].checks` by command, as TaskPanel does, WorkerInputs.tsx:91), truncated command, `+offset` from attempt start, duration, `exit N`, and a `Show contents` / `Hide contents` toggle (button names kept, projects.spec.ts:220-223). Gate reasons are mapped onto their check by their `<check id>:` prefix. A segment with no prefix is a gate-level reason, listed above the table. It is also attached to a row only when the text after `<path>` is the tail of exactly one check's `command` (4.6; `results/controller/1`). A rejected check is red even at exit 0 (`check-rejected`), and its log tail opens automatically. cwd, artifact id and absolute times go in the tooltip. Test counts are shown only once B5 serves them. |
| Screenshots (`screenshots`) | A thumbnail grid (max 220 px) under the Screenshots section, and inside the browser check row on candidate lanes. The caption is the short artifact id (with B5: scenario id and pass state). A click opens a native `<dialog>` (Esc closes it and focus returns). sha256 goes in the tooltip. |
| Files (`created-files`, `changed-files` with `li` rows, `created-file`, `captured-file`, `file-rendered`, `file-source`, `show-lines`, `file-findings`, `file-findings-none`) | About 32 px rows. Filters: With findings first, Repair n, All. Optional group-by-folder. No fetch before a row opens. Markdown files start closed and open on Rendered. The findings on a file show inside the opened row as one-line chips (`P1 · general · lines 44–50 [Show lines]`), not the full message. A/M/D marks and per-file diff hunks come from `review.diff` when a review exists (S7). |
| Worker narrative | Launch node only. `worker-completion` is clamped to 3 lines with More. Assumptions and untested items sit behind counts. Verify and candidate show `worker-report-link` instead. |
| Findings (`review-findings`, `finding`, `filter-reviewer`, `group-by-*`) | Blocking findings first, as cards. The others follow in the table or as cards (≤760 px: cards only; this fixes the 560 px `min-width` overflow, App.css:408). The requirement quote is collapsible. The 4-line legend moves to `[?]`. |
| Candidate lanes (`lane-results`, `lane-result:<lane>`) | The table comes first, failing lanes first and open. |
| Questions (`worker-questions`) | First on the launch node while one waits, and in the Now banner. Otherwise one line in Session. |
| Task (`task-details`, `task-panel`, `task-highlight`) | Closed on the launch node. The finding → requirement flow still opens it (PRD_VIEWER_CLARITY §4.2). The full view is on Assignment. |
| Identifiers | Session ids, base and output commits, bundle hash and sha256 go in one closed "Session" disclosure (worker) or "Identifiers" disclosure (other kinds). Each appears once. |
| Other artifacts (`artifacts`) | Closed. The test report attaches to the browser check row. A log that matches no check is labelled "log (not a check log)" until B5 labels setup logs. |
| Reuse (`reuse-list`) | Rendered only when `result_reused` events exist. The server never produces them today (server/projects.ts:1087). |

## 8. Copy and wording

The truthfulness requirements stay. Their wording is said once, and the substrings the tests pin are kept.

| Today | New | Pinned substring kept |
|---|---|---|
| Run failed: "A graph step or check failed. The workflow did not complete." (status.ts:28), identical for every cause | Worded by cause: "Blocked by review…", "Blocked: lane ui failed identically…", "Failed at <step>…". Each is followed by "The workflow did not complete." | `did not complete` (projects.spec.ts:294) |
| Paused: "Paused with unresolved state (for example a session that could not be reconciled)" | Worded by cause:<br>• "Paused: the design challenge found 1 P1; no worker launched."<br>• "Interrupted at Independent review: the controller stopped; sessions keep running."<br>• "Repair 1 applied; the run continues when you resume it."<br>• Unmatched: "Paused at <step> · <reason>". A paused run is never labelled "Failed". | — |
| (none today) a run blocked by the controller before freeze | "Blocked before freeze at Freeze worker handoffs · Worker game deadline exhausted; no automatic relaunch. The workflow did not complete." | `did not complete` |
| (none today) waiting in a pane | "Waiting on you: game needs attention in its pane (native state blocked) · since 11:41" | — |
| (none today) controller liveness | "controller running" / "▲ controller not running" as a suffix of the live chip; nothing when unknown | — |
| Awaiting approval (run) | "Awaiting your approval since 10:14. Not complete until you approve it in the CLI; viewing approves nothing." | `not complete` (projects.spec.ts:313) |
| Worker node succeeded: 5-line sentence (status.ts:40-41) | "Session ended its turn. This is not workflow completion — verified by Verify game ›" | `This is not workflow completion`, `not workflow completion` (projects.spec.ts:172, :322) |
| Node failed: "This step failed. The run cannot succeed without intervention." | "This step failed." plus the cause and the next step | `This step failed` (projects.spec.ts:298, review.spec.ts:103) |
| Awaiting notice | "Awaiting your approval since … Viewing does not approve it; decisions are made in the CLI: <command>" | `Viewing does not approve it` (projects.spec.ts:315) |
| Graph legend: 3 sentences (WorkflowGraph.tsx:29-33) | 3 short `li`: "Agent session", "Trusted verifier", "Controller". The full sentence is in each item's `title` and in visually hidden text. | 3 `li[data-executor]` with those words (clarity.spec.ts:105-109) |
| Status enum footnote (RunView.tsx:217) and node footnote (NodeDetail.tsx:488) | Removed. Each status badge gets a short `title` with its meaning. | — |
| "Reported by the worker" repeated | "Worker's report · completed · as signalled by the session, not verified" (said once) | — |
| "Marked retryable by the producer. Retrying is done through the workflow CLI" | Removed. Replaced by the section 6 situation. | migrated (projects.spec.ts:305) |
| Read-only info line on every level | Once on `/projects` (`projects-info`, "Read-only: runs are started, answered and approved in the workflow CLI."), and once in each command block ("This viewer never changes a run.") | `Read-only` (projects.spec.ts:81) |
| "Observed state: working" after the stop | "State at launch: working", hidden once stopped | migrated (inputs.spec.ts:147) |
| "Result attempt 3 (graph node attempt is 1)" (NodeDetail.tsx:97) | "Frozen at handoff as 5c1a734; verified on attempt 3 after operator repair 1 ›" | — |
| Inferred values | "≈09:30" with the tooltip "start inferred from Verify combined candidate; the print transport records no launch time" | — |
| Empty states | Absent, except the honesty lines in section 7 | — |

Tone: plain words, sentence case, no exclamation marks. Status words are the badge labels (`STATUS_LABEL`), and the cause comes after them.

## 9. Data

### 9.1 Existing fields per element (no backend change)

| Element | Fields |
|---|---|
| Header facts | `summary.status/created_at`, `inputs.feature/base_commit/source_branch/mode/automatic.*`, `definition.definition_revision` vs the current definition |
| Now banner | `snapshot.nodes[].status/attempt/result_uri/lane_results`, `events[]` (incl. `node_id: null`, whose raw controller status B1 keeps), `inputs.workers[].questions/completion/launch/stop`, `inputs.challenge`, `inputs.max_verification_attempts`, `reviews/<n>` (`verdict`, `findings`, `reviewers[].status`, `bundle_sha256`, `reviewed_at`), lane results `error.message` |
| Steps, Activity, bars | `events[].occurred_at/node_id/status/attempt/message`, `launch.native_started_at/launch_requested_at`, `stop.confirmed_at`, `questions[].asked_at/answered_at`, `challenge.decided_at`, `reviewed_at`, `reviewers[].launched_at/accepted_at`, `summary.created_at` |
| Node timing and attempts | the above plus `checks[].started_at/finished_at`, and `results/<lane>/<k>` for k < current (served today: game/1 and game/2 return 200, candidate_ui/1 returns 200) |
| Gate reasons on checks | `error.message` split on `"; "` and keyed by the `<check id>:` prefix; unkeyed segments are gate-level, and matched to a row by the command tail after `<path>` only when exactly one `checks[].command` ends with it; `inputs.workers[].checks[].id/command` |
| Repair badges | `artifacts[kind=file].path/sha256` of `results/<lane>/1` vs the latest result |
| Deadlines | `automatic.worker_timeout_seconds/review_timeout_seconds`, question waits |
| Succeeded outcome | the integrate event message, `inputs.source_branch`, `automatic.finish`, the review verdict and findings |
| Lists (without B2) | `RunSummary.status/created_at/updated_at` via fan-out |

### 9.2 Backend additions (slice S5, additive)

**B1. Projection fixes** (`server/projects.ts`, no contract change, about 60 lines plus tests):
- `attemptFromMessage` becomes `/\battempt (\d+)\b/i` (:1067-1070). **Guard:** `projectSnapshot` shares it through `eventAttempt` and `Math.max` (:1110-1111). A server test must show that the snapshot attempts of the three captured runs and of every fixture are unchanged, or change only where the old value was wrong (challenge). The client re-parse (5.2 rule 1) ships first, so B1 only makes the served events right.
- When a lane is named `controller`, raw `controller` events whose message matches the controller-process patterns become run-level (`node_id: null`) *before* lane aliasing (:341-347 vs :1116). The patterns are: `Automatic checkpoint controller PID`, `Supervisor interrupted`, `Claude Code was unavailable`, `failed identically`, `Repair \d+ applied`, `^\[Errno`, and the two resumable stops, `^Source feature branch changed` and `^Automatic supervision requires a completed start`. Other `controller` events stay on the lane. Separately, PID rows never set a node's last status in `projectSnapshot`.
- Candidate events aliased from `candidate_<lane>` get the message prefix `[<lane>] ` so the timeline can name the failing lane.
- **Node-less controller rows keep their status.** `normalizeEvents` sets `status` only for rows that map to a graph node (`const status = node_id ? EVENT_STATUS[…] : null`, :1084). Raw `controller` rows are the exception: they keep `EVENT_STATUS[event.status]` (`blocked` → `failed`, `interrupted` → `paused`, `running` → `running`) with `node_id: null` and `type: 'log'`. The workflow event schema already allows `status` with a null `node_id` (contracts/workflow/v1.ts:112-115). This is the row `projectSnapshot` already uses to fail or pause the handoff (:1116, :1133-1137). Serving it lets the client quote it (6.2 reason source 0) instead of guessing from message text. A server test covers a deadline block (the handoff fails, and the served node-less row has `status: 'failed'` and its message), and checks that PID rows are served as `running`.

**B2. `RunSummary.activity`** (optional; projects contract 1.5.0; `v1.ts`, `runList.schema.json`, `runDetail.schema.json`, `examples.ts`, `contract.test.ts` and the README updated together):

```ts
activity?: {
  feature: string | null;                 // inputs.feature from the export
  last_activity_at: timestamp | null;     // last raw event that is not a PID checkpoint
  finished_at: timestamp | null;          // terminal runs: last status event or the export's review.reviewed_at
  focus: { node_id; label; status; since: timestamp | null } | null;  // first failed/paused/awaiting node, else first running
  attention: { kind: 'question' | 'pane' | 'approval' | 'interrupted' | 'paused' | 'failed'; node_id: id | null; since: timestamp | null } | null;
  waiting_questions: number;              // live <lane>.questions.json (bounded read) ∪ export
  headline: string | null;                // ≤160 chars, redacted: focus label + its last status message, or the in-scope controller row (6.2 source 0)
  controller: 'running' | 'not_running' | 'unknown' | null;  // null: no PID event (manual run) or a terminal run
}
```

- **`attention` precedence.** `question`, then `pane`, `approval`, `interrupted`, `paused` and `failed`.
  - `pane` is derived per graph node from raw events. It is set by the latest `interactive` event whose message contains `needs attention in its pane` (automatic.py:281 for a lane, mapped to `launch_<lane>`; :556 for `review`), when no later event exists for that node. `node_id` names the node and `since` is that event's time.
- **`controller`.** It is computed only while the snapshot status is `running` or `paused`, and only when the run has an `Automatic checkpoint controller PID <n>` event (automatic.py:1244). That event is logged by the `automatic-step` child, whose argv is `<python> -m workflow automatic-step <run dir> --live` (automatic.py:1103). The run dir is absolute because the CLI resolves it (pipeline.py:889). The child runs on the same host and as the same user as the server. Reading two small files per active run keeps list polls cheap.
  - `unknown`: `/proc/self/stat` is not readable (a host without `/proc`).
  - `not_running`: `/proc/<pid>` does not exist, or its `cmdline` does not contain `automatic-step` followed by an argument whose realpath equals this run directory's realpath. In the second case the PID was reused by another process, so the logged controller is gone.
  - `running`: the `cmdline` matches, and the process start time is at or before the PID event's `time`. The start time is `/proc/<pid>/stat` field 22 (ticks since boot at USER_HZ 100) plus `btime` from `/proc/stat`, with a 1 s tolerance.
  - `unknown`: the `cmdline` matches but the process started after the event. That would need a reused PID running another `automatic-step` of this run without having logged its own PID, and the viewer does not guess.
  - The reader takes an injectable `procRoot` so `server/projects.test.ts` can cover every branch with a fake `/proc` tree.
  - This is not `process.kill(pid, 0)`: PID reuse cannot produce `running`, because both the argv and the start time must match (Appendix B, decision 10).

- **How it is computed.** `projectRun` (:914-940) computes it, and `listRuns` (:788-813) already calls `projectRun` for every run. The inputs are what `projectRun` already reads (`run-state.json`, `plan.json`, `events.jsonl`), plus one bounded read of `<lane>.questions.json` per selected lane. That file is the controller's live question record (guardrails.py:698-703), and `run-state.json` is not re-exported during the handoff wait.
- **What it does not do.** It reads no review files, no lane results and no packets, so list polls stay cheap. It shares `deriveFocus` and `humanizeEvent` with the client through `contracts/projects/triage.ts`, so the list headline and the run page agree by construction. The run page adds only the reason clause.
- **Why.** It gives the lists status, a feature title, recency and attention without N+1 requests. It fixes the question state during a live wait (live-status:question-attention-invisible). It gives feature titles without renaming the definition.

**B3. Opt-in run directory** (`server/projectsConfig.ts`, `v1.ts`, `config/projects.example.json`):
- **The flag.** A top-level, viewer-only registry key, `"viewer": { "expose_run_dir": ["project-b", "md-manager"] }`, lists the project ids whose runs serve `RunDetail.run_dir: string | null`, the run directory abbreviated with `~`. S5 extends `fileSchema` (projectsConfig.ts:50, a strict object) with this optional key. Until S5 ships, adding the key breaks config loading, so the operator adds it only after S5 is deployed.
- **Why top-level, and not a per-workflow flag.** A per-workflow key would not survive a launch.
  - On re-registration, `registry.py:184-190` rebuilds the workflow item from the fresh launch entry and keeps only `definition`. The `existing == workflow` check then fails, and the item is rewritten without any extra key.
  - Every new feature is appended without it (registry.py:191).
  - `projectsConfig.ts:37` `workflowSchema` is strict, so the key would also have to be added there.
  - `registry.py` validates only `version` and `projects` (:160-161), and edits byte spans inside `projects`. A top-level `viewer` key therefore survives every launch, and it can express a per-project default.
- **When it is null.** When the project is not listed (the default), when the directory is outside `$HOME` (so the Playwright temp roots always give null), or when the path cannot be resolved.
- `redactPaths` (:75) stays the default for every message.

**B4. Recent runs across the registry** (optional; ship when the fan-out exceeds about 10 workflows): `GET /api/projects/runs?limit=20` returns `RunSummary[]` (with `activity`) merged by `activity.last_activity_at ?? updated_at`.

**B5. Evidence detail** (optional, S7; `contracts/workflow/workerResult.schema.json` additive, like `files_not_captured`): optional result fields `gate_reasons[{check_id, reason}]`, `evidence_checks[{id, tests, scenarios[{id, status, screenshot_artifact_id}]}]` and `setup_logs[{artifact_id, command}]`, taken from the packet the server already reads (~:1215-1235). They give exact rejected-check marks, test counts, scenario-captioned thumbnails and a labelled setup log. Until they exist, the client maps reasons by prefix.

### 9.3 Not added

- A liveness check through `process.kill(pid, 0)`, or any check that trusts a PID alone: PID reuse gives false "alive". B2 `activity.controller` checks the argv and the start time instead (9.2).
- A client-side "next step" served by the server. The table lives in `triage.ts`, which is unit-tested against the RUNBOOK.

### 9.4 Controller and exporter follow-ups (Python; not in these slices)

Until each lands, the viewer shows the matching value as inferred or "not recorded".

| Id | Gap | Viewer workaround until then |
|---|---|---|
| C1 | The print-transport review writes no `running`/verdict events, and `reviewers[].launched_at` is null | ≈ span from the candidate's end to `reviewed_at` |
| C2 | No approval decision event and no actor | ≈ instant at the integrate time, "no approval event recorded" |
| C3 | No candidate `running` event per lane, and no reason in candidate failure events | start inferred; reason from the lane results |
| C4 | No `completion.signalled_at`; no `observed_at` for the launch state | "State at launch", hidden after the stop |
| C5 | `run-state.json` is not re-exported during `wait_handoffs` | B2 live questions read |
| C6 | `controller` is not a reserved lane id (PRD_WORKER_LANES reserved list), so controller-process events collide with a lane of that name | B1 message patterns |
| C7 | No controller heartbeat | B2 `activity.controller` from `/proc` (Linux only; `unknown` elsewhere); a heartbeat file would make it portable and remove the 15 s hand-over debounce |
| C8 | Earlier challenge attempts (`challenge-<n>.json`) are not served | chips without links |
| C9 | No per-lane patch artifact at freeze (diff before review) | A/M/D and diff only once a review exists |
| C10 | Verify packets lack setup start and end, and setup logs are unlabelled | setup = the first check's start minus the attempt start; B5 labels |

## 10. Accessibility and mobile

- **Graph.** The graph keeps its `role="group"`, per-node aria-label (unchanged format), roving arrow keys and Enter/Space (projects.spec.ts:164-168). The new status glyph is `aria-hidden`. Selection uses a thick outline plus an offset ring that does not reuse the running colour (App.css:332 vs :337). Status is shown by glyph and colour, never by colour alone.
- **Steps table.** It is a real `<table>` (`<caption>`, `<th scope>`). The bar cell is `aria-hidden`, and the times are in the text cells. The step link sits in the Step cell, and the row carries `data-node-id`/`data-status`.
- **Activity.** An `<ol>` of rows. Gap rows are `<li>` with text ("operator time 5m37s"), not decoration only.
- **Tabs.** Run/Assignment keep the ARIA tablist pattern (roving tabindex, arrows, Home/End). Selecting a tab updates the URL.
- **Section index.** A `<nav aria-label="Sections of Verify game">` of in-page links. Sections are `<section aria-labelledby>`.
- **Focus.** Selecting a node moves focus to its `h3` (`tabIndex=-1`). Returning to the run page restores focus to the originating Steps row. The screenshot `<dialog>` traps and returns focus.
- **Live updates.** The banner is not `aria-live`. The existing polite announcer speaks only when the situation changes (6.4). The stale chip announces once.
- **Motion.** The running pulse and smooth scrolling apply only under `@media (prefers-reduced-motion: no-preference)`. The Playwright config already sets `reducedMotion: 'reduce'`.
- **Contrast.** Status tokens in `index.css` include a `--warn-*` pair for both themes. Glyphs and text meet 4.5:1, and the amber attention ring meets 3:1 against both backgrounds.
- **App header.** On Projects routes it is one row at ≥760 px (`h1`, the roots `nav`, Refresh; a flex row with `gap`, no subtitle). At ≤760 px it wraps to two rows: title and Refresh, then the roots. Landmarks and the roots `nav` label are unchanged.
- **Mobile, ≤760 px:**
  - The graph is hidden, and the Steps table (run page) and scrollable step strip (node pages) are the navigators.
  - Findings and checks render as cards.
  - `overflow-wrap: anywhere` applies on `.node-detail`, `.worker-summary` and code-free text. This fixes the 427 px overflow caused by the 40-character SHA in the summary.
  - Code blocks and the step strip scroll inside themselves.
  - Tap targets are at least 44 px.
  - The run header collapses to title, status, span and freshness, with `Details ▸`.
  - The Now banner is inside the first 844 px.
- **Graph fit, ≥760 px.** `dag.ts` changes `DAG_NODE_WIDTH` 150 → 136 and `DAG_COLUMN_GAP` 64 → 28, so 8 columns = 1,316 px (fits the ~1,372 px box at 1440) and 7 columns = 1,152 px.
  - The SVG gets `width="100%"` with its viewBox and `max-width: <layout.width>px`, so it scales down to 0.83 at about 1,100 px.
  - Between 760 and 1,100 px it scrolls horizontally inside its box, with the focus node scrolled into view.
  - The pending-node dash override (App.css:335) and the per-kind stroke colours (App.css:325-327) are removed, so dashes mean only the executor and colour means only the status.

## 11. Implementation slices

Each slice ships alone, with its test migrations in the same commit, and leaves every existing route working.

**Rules that keep parallel slices file-disjoint:**
- **Styles.** New styles go in per-area stylesheets imported by their components: `src/projects/run.css`, `node.css`, `node/*.css` and `lists.css`. `App.css` only loses the rules that move, and only S1 and S3 edit it.
- **New browser scenarios.** Each slice puts them in its own spec file, `tests/project-workflows/ux-<slice>.spec.ts`, and its scenario ids in its own `features/viewer-ux-<slice>/policy.json`.
- **Fixture additions.** Each slice has one module, `tests/project-workflows/fixtures/ux-<slice>.ts`. S1 creates all seven modules empty and wires them in once:
  - It adds the aggregator `fixtures/index.ts`. It spreads each module's payloads into the maps that `fixtures.ts` exports (which `mock.ts` already reads for the worker phase). It also calls each module's `seed(root)` from `seedCandidate` (seed.ts:210) for the candidate phase.
  - A module adds its runs as a new workflow `ux-<slice>` appended to `PROJECT`'s workflow list. Existing counts therefore do not change: the projects list stays at 2 (projects.spec.ts:101), and `run-list li` stays at 5 (:142). The workflows list is asserted with an ordered-subset `toContainText` (lanes.spec.ts:182).
  - After S1, no slice edits `fixtures.ts`, `mock.ts` or `seed.ts`.
- **`package.json`.** Only S1 edits it. S1 changes `test:unit` to `tsx --test <the six server/*.test.ts files, unchanged> tests/unit/*.test.ts`. The glob covers the three existing unit files, `time.test.ts` and S2's `triage.test.ts`, so no later slice touches the script.
- **`contracts/projects/triage.ts`.** Only S2 and S3 edit it. S4a-c, S5 and S6 import it; a slice that needs a change there waits for the next sequential step.
- **Existing spec files.** Each migration of an existing spec file belongs to exactly one slice (12.3). Two slices that run at the same time never edit the same file.
- **Concurrency.** At most two slices run at once on the VPS, which is the 2-agent cap per workflow.

| Slice | What ships | Files touched | Size | Depends on |
|---|---|---|---|---|
| **S1 Time, freshness, trim** (client and test plumbing) | The time helpers: `time.ts` (`formatClock/formatAgo/formatSpan/spanBetween`), `Time.tsx`, `useNow`. `TimeZoneToggle` (`time-zone-toggle`) and `LiveStatus` (`live-status`), placed beside the status badge on today's run title row. `useResource` `meta`; `ProjectsView` passes the run resource's `meta` to `RunView`. Refresh without blanking, with the Projects Refresh busy state. Durations on check rows and reviewers. The two footnotes removed. The `overflow-wrap` fix. Playwright `timezoneId: 'UTC'`, `locale: 'en-GB'`. The `test:unit` glob. The fixture extension point. | new `src/projects/time.ts`, `Time.tsx`, `useNow.ts`, `TimeZoneToggle.tsx`, `LiveStatus.tsx`. Changed: `useResource.ts`, `status.ts` (drop `formatTime`), `RunView.tsx` (footnote, chip, toggle), `ProjectsView.tsx` (pass `meta`), `NodeDetail.tsx`, `WorkerInputs.tsx`, `ReviewDetail.tsx`, `Challenge.tsx`, `Assignment.tsx` (call sites only), `App.tsx` (Refresh busy state), `App.css`, `package.json` (`test:unit` only). Tests: `tests/project-workflows/playwright.config.ts`, `inputs.spec.ts`, `guardrails.spec.ts`, `fixtures.ts` + `seed.ts` (extension point only), new `fixtures/index.ts` + seven empty `fixtures/ux-*.ts`, new `ux-time.spec.ts`; `tests/unit/time.test.ts` | M, ~550 | — |
| **S2 Model** (pure) | `contracts/projects/triage.ts`: `buildTimeline`, `deriveNow` with the 6.2 situation/command table, `deriveFocus`, `deriveAttention`, `humanizeEvent`, `gateReasonsByCheck`, `attemptResultUris`, `laneLines`. Unit tests (12.1). Until S1's glob merges, S2 runs its tests with `npx tsx --test tests/unit/triage.test.ts`. | new `contracts/projects/triage.ts`, `tests/unit/triage.test.ts`, `tests/unit/fixtures/runs/*.json` | M, ~400 + ~500 test | — |
| **S3 Run page** | Projects header in one row (App.tsx). `RunHeader`: the facts line (`run-inputs-facts`), `Details ▸` (`run-details`), the definition chip, and the moved toggle and chip. `NowBanner` + `CommandBlock` (`$RUN` form). The lanes line. Tabs above the graph, with the graph inside the Run tabpanel. The fitted graph: `dag.ts`, glyph, `data-attention`, selection ring, compact legend. `StepsTimeline`: the Steps table (`run-node-list`) and Activity (`run-timeline`, controller-log toggle); an Activity attempt row opens `/nodes/<n>`. `StepStrip` on node pages (`run-node-list`). A full-width node area that renders today's `NodeDetail`. The routed Assignment tab (`routes.ts`: `assignment`). The breadcrumb: no Home, a node crumb, the feature-title rule. The info line only on `/projects`. The `document.title` prefix. Focus management. | new `RunHeader.tsx`, `NowBanner.tsx`, `CommandBlock.tsx`, `StepsTimeline.tsx`, `StepStrip.tsx`, `src/projects/run.css`. Changed: `RunView.tsx` (rewrite), `routes.ts`, `dag.ts`, `WorkflowGraph.tsx`, `ProjectsView.tsx` (crumbs, info), `status.ts` (wording), `App.tsx` (header row), `App.css` (header, removals), `contracts/projects/triage.ts` (fixes found while wiring, if any). Tests: `fixtures/ux-run.ts`, new `ux-run.spec.ts`, and the S3 migrations in 12.3 (`clarity.spec.ts`, `review.spec.ts`, `reviewers.spec.ts`, `projects.spec.ts:317-319`) | L, ~1,200 | S1, S2 |
| **S4-core Node shell** | Splits `NodeDetail.tsx` into a thin dispatcher plus per-kind section files. The code is moved, not rewritten:<br>• `node/WorkerSections.tsx`, `worker.css`<br>• `node/VerifySections.tsx`, `verify.css` (verify and candidate)<br>• `node/ReviewSections.tsx`, `review.css`<br>• `node/ChallengeSections.tsx`<br>• `node/ControllerSections.tsx`, `controller.css` (handoff, approval, integrate)<br>• `node/ResultFacts.tsx`<br>It also extracts `node/Requirements.tsx` (`RequiredChecks`, `OwnedPaths`) from `WorkerInputs.tsx` `TaskPanel` (:28-127).<br>New: `NodeHeader` (status by cause, timing line, attempt strip, `node-next`), `SectionIndex`, `useRunData` (URI cache), empty sections absent, dedup by `result_uri`, and the worker narrative only on the launch node. The `/nodes/<n>/attempts/<k>` route: `routes.ts`, and `ProjectsView.tsx` and `RunView.tsx` pass `attempt`. Activity attempt rows are retargeted to it in `StepsTimeline.tsx`. | `NodeDetail.tsx`, new `node/*.tsx` + `node/*.css` (listed left), `NodeHeader.tsx`, `SectionIndex.tsx`, `useRunData.ts`, `node.css`, `routes.ts`, `RunView.tsx`, `ProjectsView.tsx`, `StepsTimeline.tsx`, `WorkerInputs.tsx` (extraction only). Tests: `fixtures/ux-node.ts`, new `ux-node.spec.ts`, S4-core migrations (`projects.spec.ts:214/228/233/256/302`) | M, ~500 (mostly moved code) | S3 |
| **S4a Verify and candidate** | The check table, with keyed and unkeyed gate reasons and `check-rejected`; the default rejected-log tail; thumbnails with a `<dialog>`; the Requirements section (from `node/Requirements.tsx`); the candidate lane table with failing lanes first; the retryable note replaced | `node/VerifySections.tsx`, `node/verify.css`, new `Checks.tsx`, `Screenshots.tsx`. Tests: `fixtures/ux-verify.ts`, new `ux-verify.spec.ts`, `projects.spec.ts:305` | M, ~350 | S4-core |
| **S4b Launch** | Questions first, with both `answer` forms; the Report once, with the verifier-note delta; dense lazy file rows from `results/<lane>/1` with repair badges; the Session disclosure; "State at launch" | `node/WorkerSections.tsx`, `node/worker.css`, `CreatedFiles.tsx`, `WorkerInputs.tsx`. Tests: `fixtures/ux-launch.ts`, new `ux-launch.spec.ts`, `inputs.spec.ts:147`, `clarity.spec.ts` (created-file-rendered, :268) | M, ~350 | S4-core |
| **S4c Review, challenge, controller** | Blocking cards; reviewer durations and deadlines from `launched_at`; cards at ≤760 px; the challenge headline and compact concerns; the handoff, approval and integrate panels, including the handoff wait and approval `≈` labels | `node/ReviewSections.tsx`, `node/ChallengeSections.tsx`, `node/ControllerSections.tsx`, `node/review.css`, `node/controller.css`, `ReviewDetail.tsx`, `Challenge.tsx`. Tests: `fixtures/ux-review.ts`, new `ux-review.spec.ts` | M, ~300 | S4-core |
| **S5 Backend** | B1 projection fixes (incl. node-less controller status), B2 `activity` (incl. `attention.kind: 'pane'` and `controller` from `/proc`), B3 top-level `viewer.expose_run_dir`. **No `src/` file and no browser spec file.** If B1 changes a browser assertion in the candidate phase, S5 waits for S3 to finish instead of running beside it, and makes that change in its own commit. | `server/projects.ts`, `server/projectsConfig.ts`, `server/projects.test.ts`, `contracts/projects/v1.ts`, `examples.ts`, `contract.test.ts`, `runList.schema.json`, `runDetail.schema.json`, `contracts/projects/README.md`, `config/projects.example.json` | M, ~550 | S2 (imports `triage.ts`) |
| **S6 Lists and served fields** | Runs home (Needs you, Running, Recent, compact projects); the project page grouped by feature; `RunRow` in an `<li>` on the feature page; the current definition in `<details>`; the workflow title rule; `?` badges. Client switches to B2/B3: `NowBanner` also reads `activity.waiting_questions` and `attention`; `CommandBlock` adds the `RUN=` line when `run_dir` is set; `LiveStatus` adds the controller suffix with its 15 s debounce. A client fan-out fallback applies when `activity` is absent. | new `RunsHome.tsx`, `RunRow.tsx`, `src/projects/lists.css`. Changed: `ProjectsView.tsx` (levels), `api.ts`, `NowBanner.tsx`, `CommandBlock.tsx`, `LiveStatus.tsx`. Tests: `fixtures/ux-lists.ts` (its own run with a live `<lane>.questions.json`, a pane-attention event and a controller PID), new `ux-lists.spec.ts`, `projects.spec.ts:149` | M, ~550 | S3, S4-core, S5 |
| **S7 Depth** | The Assignment reorder (summary line, lanes table, decisions collapsed, folded JSON); the review diff inline per file; A/M/D marks and +/- counts from `review.diff`; the optional B5 fields; B4 if needed | `Assignment.tsx`, `node/ReviewSections.tsx`, `ReviewDetail.tsx`, `CreatedFiles.tsx`, `Checks.tsx`; optional `server/projects.ts`, `contracts/workflow/workerResult.schema.json` | M, ~500 | all above |

**Order.** No step runs more than two slices.

| Step | Slices | Why the pair shares no file |
|---|---|---|
| 1 | S1 ∥ S2 | S2 touches only `contracts/projects/triage.ts` and `tests/unit/triage.test.ts` + its JSON fixtures; S1 owns `package.json` and everything under `src/` and `tests/project-workflows/` |
| 2 | S3 ∥ S5 | S5 touches only `server/**`, `contracts/projects/**` except `triage.ts`, and `config/`; S3 touches `src/**`, `triage.ts` and browser specs |
| 3 | S4-core (S5 may still be running) | S4-core edits `NodeDetail.tsx`, `RunView.tsx`, `ProjectsView.tsx`, `routes.ts` and `StepsTimeline.tsx`, which later slices also edit, so it runs alone among client slices |
| 4 | S4a ∥ S4b | verify files + `projects.spec.ts` vs launch files + `inputs.spec.ts` / `clarity.spec.ts` |
| 5 | S4c ∥ S6 | review/challenge/controller files vs list files, `ProjectsView.tsx`, `NowBanner`/`CommandBlock`/`LiveStatus` and `projects.spec.ts` |
| 6 | S7 | — |

What each part fixes:
- S3 alone fixes the first-screen, timeline, clipping, wasted-column and mobile-depth P1s.
- S4b alone fixes the 19,834 px launch page.
- S6 completes the list and liveness P1s.

The total is about 4,000 LOC including tests.

**Delivery** (see open question 5): S1 and S2 are small, low-risk direct commits. S3 onward run as workflow feature runs of md-manager itself (`features/viewer-ux-<slice>`, lanes `ui` and, for S5, `adapter`), like viewer-clarity, which also dogfoods the new viewer.

## 12. Test plan

### 12.1 Unit (`tsx --test`, collected by the `test:unit` glob from S1)

**`tests/unit/time.test.ts` (S1):**
- `formatSpan` edges: 0 s, 59 s, 60 s, 59m59s, 1h, 24h+.
- Local vs UTC under `TZ=America/Los_Angeles` and `TZ=UTC`.
- Date prefixing across midnight.

**`tests/unit/triage.test.ts` (S2)**, on the trimmed skeleton-001, skeleton-fixes-001 and workflow-guardrails-001 payloads, plus synthetic runs.

`buildTimeline`:
- Challenge attempts 1-3, with attempt 1 "ended without a record".
- Worker span 28m21s from the receipts.
- Verify attempts of 1m07s, 1m07s and 1m15s, with setup 42 s and checks 33 s.
- Diagnosis and repair markers, and the 5m37s operator gap.
- Review span ≈2m10s, marked inferred.
- Run span 52m51s ending 09:32:31.
- Guardrails:
  - PID rows become markers, never a node running.
  - The controller-down gaps of 4m56s and 6m35s.
  - Parallel lane spans.
  - Candidate #28 and #31 matched to lane ui.
- `controller_blocked` markers from node-less rows: with B1's `status: 'failed'`, and before B1 through the message rule.

`deriveNow` must produce each situation below. One `it` per row, named by its `data-situation`:

| Case | Input | Expected |
|---|---|---|
| `review_blocked` | skeleton-001 | The three-step `init` → fill and commit → `launch` template with `<fixes-feature>` and `<target repo>` placeholders; no concrete feature name or run id |
| `blocked_identical` | guardrails | `repair "$RUN" ui --workspace` … `automatic "$RUN" --live`, **without** a diagnosis event, and **not** "interrupted" or "Claude Code unavailable" despite the four stale Errno rows |
| `succeeded` | skeleton-fixes-001 | No command |
| `question` | synthetic | Both `answer` forms naming the lane; the `--no-herdr` form present |
| `pane_attention` | synthetic `interactive` "needs attention in its pane" on `launch_game`, with no later event | `attach-one "$RUN" --node game`. A later event for that node clears it. |
| `interrupted` (a) | a run-level `Supervisor interrupted … resume with: python -m workflow automatic <path> --live` row after the latest launch event | `automatic "$RUN" --live`; headline "Interrupted" |
| `interrupted` (b), review | review `paused` whose latest event is `Controller interrupted while waiting for the reviewers …` (REVIEW_RESUME_NOTE), with **no** controller row | `automatic "$RUN" --live`; the status word is `‖ Interrupted`, never `✗ Failed` |
| `interrupted` (b), freeze | handoff `paused` whose latest event is `<error>. The freeze was stopping the workers … resume with: python -m workflow automatic <path> --live` (FREEZE_RESUME_NOTE) | `automatic "$RUN" --live` |
| `interrupted` (c) | run `running`, `activity.controller: 'not_running'` on two polls 20 s apart | `automatic "$RUN" --live`. A single poll does **not** match. |
| `interrupted` (d) | `verify_game` paused with `Repair 1 by the operator … Continue with python -m workflow automatic <path> --live` | `automatic "$RUN" --live`. With `… workflow retry <path>` (a manual run): `retry "$RUN"`. |
| `blocked_before_freeze` | handoff failed plus a node-less controller row `Worker game deadline exhausted; no automatic relaunch` | Reason quotes the row. Next step is a new run (`launch <feature> --repo <target repo> --run-id <new run id> --live --automatic`); **no** `repair` command |
| `blocked_before_freeze` | `completion.status: 'blocked'` with a summary | Reason is `game reported blocked: <summary>` |
| `blocked_before_freeze` | a fourth-question controller row | Reason quotes the question |
| `blocked_before_freeze` | an in-scope `Could not confirm worker stop` row | The stop-sessions step comes first |
| `challenge_paused` | synthetic | `resume` and `resume --accept-challenge` |
| `awaiting_approval` | synthetic | Bundle hash filled in |
| `check_failed` | synthetic | Automatic: no command. Manual: `retry … --phase … --node …` |
| `no_rule_matched` | failed | `✗ Failed at …` + `status "$RUN"` described as "changes no run progress" |
| `no_rule_matched` | paused | `‖ Paused at …`, never "Failed" |
| Scope | the same stale `[Errno 2]` row placed before the focus attempt | It is ignored |

`gateReasonsByCheck`:
- skeleton-001 `results/game/1` (keyed `unit:` / `integration:`).
- guardrails `candidate_ui/2` (keyed `project-workflows-browser:`).
- guardrails `results/controller/1`. The unkeyed `Executed check failed: <path> -m workflow.run_tests` is gate-level **and** attached to the single check whose command ends in ` -m workflow.run_tests`. A synthetic variant with two matching tails stays gate-level only.

`deriveAttention`: `question` > `pane` > `approval`. A pane event followed by any event for that node gives no attention.

**`server/projects.test.ts` (S5):**
- B1:
  - Attempts are case-insensitive, and the snapshot attempts of the fixtures are unchanged (the `eventAttempt`/`Math.max` guard).
  - A `controller` lane plus controller PID and Errno rows gives run-level rows, while the lane's own `controller` events stay on the lane.
  - Candidate lane prefix.
  - A deadline block serves the node-less row with `status: 'failed'` and its message, and the handoff as failed.
  - A PID row is served `running`.
- B2:
  - `activity` for each fixture run, including `waiting_questions` from a seeded `<lane>.questions.json`.
  - `attention.kind: 'pane'` from a raw `interactive` "needs attention in its pane" event, cleared by a later event.
  - `controller`, with an injected `procRoot`:
    - `running`: the cmdline has `automatic-step <run dir>` and the start time is before the event.
    - `not_running`: no `/proc/<pid>`.
    - `not_running`: the cmdline is another program (PID reuse).
    - `unknown`: a matching cmdline but a start time after the event.
    - `unknown`: no `/proc/self/stat`.
    - `null`: a manual run with no PID event, or a terminal run.
- B3:
  - `run_dir` is null under the temp roots, and when the project is not in `viewer.expose_run_dir`.
  - A config with the `viewer` key loads.
  - A config with an unknown top-level key is still refused.

**`contracts/projects/contract.test.ts` (S5):** the examples with and without `activity` (every `attention.kind`, each `controller` value) and `run_dir` validate, and strict objects still reject unknown keys.

### 12.2 New browser scenarios

These run in both phases, worker (mocks) and candidate (seeds).
- Each scenario calls `attach(page, testInfo, id)`. It lives in its slice's own spec file, and its id goes in that slice feature's `policy.json` `project-workflows-browser` scenarios.
- Each scenario belongs to exactly one slice, and needs nothing that a later slice ships.

| Slice (spec file) | Scenario id | Asserts | Red before the slice because |
|---|---|---|---|
| S1 (`ux-time.spec.ts`) | `time-local-utc` | Times are `<time datetime title>`. `time-zone-toggle`, beside the run status, switches the run page's `<time>` text to UTC and survives reload. A check row shows `3s`. | no `<time>` elements; no toggle |
| S1 (`ux-time.spec.ts`) | `live-freshness` | A failed run shows `live-status[data-state=watching]`, and a succeeded run shows `finished`. `page.route` aborting two polls shows `stale` while the data stays. Refresh keeps the content and the scroll position. | no `live-status`; Refresh blanks |
| S3 (`ux-run.spec.ts`) | `run-now-banner` | `run-now[data-situation]` on the S3 fixtures, one per situation: `review_blocked`, `blocked_identical` (no diagnosis event), `blocked_before_freeze` (deadline row), `interrupted` (review note on the node, no controller row), `interrupted` (freeze note), `interrupted` (repair continuation), `succeeded`, `awaiting_approval` (bundle hash in `now-command`) and `question`. `copy-command` text is exactly "Copy". A paused run's banner never contains "Failed". The banner box is inside the 900 px fold. | no `run-now` |
| S3 (`ux-run.spec.ts`) | `run-steps-timeline` | Steps rows in definition order with start and duration, and attempt markers (⚑/⚒). **At 1440×900, the focus Steps row's box bottom is ≤ 900**, on `RUN_REVIEWER_BLOCKED` (2 lanes, focus on review, row 7 of 9: budget y841-869) and on the S3 two-lane identical-failure fixture (focus on candidate). Node-less diagnosis and repair rows are visible in Activity without any click. The controller-log toggle shows its count and hides PID rows by default. A gap row appears. An Activity attempt row links to its node, `/nodes/<n>`. | no Steps or `run-timeline`; three-row header |
| S3 (`ux-run.spec.ts`) | `graph-fits` | At 1280 and 1440, `workflow-graph` has `scrollWidth <= clientWidth`, and `integrate` is in view. Guardrails bounding boxes stay in x-order. | 1,680 px layout |
| S3 (`ux-run.spec.ts`) | `assignment-routed` | The Assignment tab URL ends `/assignment`, and reload keeps it. The tabs sit above the graph, and the graph is absent on Assignment. Arrow keys still switch tabs. | tab in component state |
| S3 (`ux-run.spec.ts`) | `narrow-run` | At 390×844, `scrollWidth <= 390` on the run, verify and review pages. The Now banner is within 844 px. Tapping a step focuses its `h3`, whose top is inside the viewport. | detail at y≈1,975; 427 px overflow |
| S3 (`ux-run.spec.ts`) | `question-attention` | On `RUN_GUARDED_ASKING`: a banner with both `answer` forms naming the lane, and `data-attention="question"` on the graph node, Steps row and step strip. On the S3 pane fixture: `data-situation="pane_attention"` with `attach-one --node <lane>`, and `data-attention="pane"` on the same three elements. `document.title` starts with `?` in both cases. | no attention surface |
| S4-core (`ux-node.spec.ts`) | `node-header` | The timing line and the `node-attempt` number. Section index counts equal the section item counts. Empty sections are absent. `node-next` appears on the focus node. | no header |
| S4-core (`ux-node.spec.ts`) | `node-attempts` | The verify attempt strip. `/nodes/verify_<lane>/attempts/1` loads `results/<lane>/1`, and its header reads `Failed · attempt 1`. An Activity attempt row now opens `/nodes/<n>/attempts/<k>`. A chip appears only after its fetch returns 200. | route rejected by `parseProjectsPathname` |
| S4a (`ux-verify.spec.ts`) | `gate-rejected-checks` | On attempt 1, `Failed: 2 checks rejected`, and the `check-rejected` rows are red at exit 0 with their log tails open. The unkeyed reason on the controller-attempt fixture is listed as a gate-level `gate-reason`. | reasons only in a joined error string |
| S4a (`ux-verify.spec.ts`) | `candidate-lanes-table` | The failing lane is sorted first and open; the passing lane is closed. | lane order |
| S4b (`ux-launch.spec.ts`) | `files-dense` | No file-content request before a row opens (`page.on('request')`). "With findings" is listed first. Repair badges appear on a fixture whose `/1` and latest results differ. Markdown opens Rendered only on expand. | eager fetch; one panel per file |
| S4b (`ux-launch.spec.ts`) | `launch-question-first` | With an unanswered question, the Questions section is the first section and shows both `answer` forms. A running worker shows "State at launch". | Questions at the bottom |
| S4c (`ux-review.spec.ts`) | `review-blocking-first` | The blocking card comes before the table. Reviewer durations show, and a deadline from `launched_at` appears on a running native reviewer. Cards at 390 px have no overflow. | table only |
| S4c (`ux-review.spec.ts`) | `controller-panels` | The handoff shows the wait duration from receipts. Approval without an event shows `≈` and "no approval event recorded". | generic panels |
| S6 (`ux-lists.spec.ts`) | `runs-home` | Needs you, Running and Recent are grouped by `data-attention` (question, pane, approval) and status. Titles follow the title rule. The row's accessible name starts with the run id, and rows sit in `li`. | project cards only |
| S6 (`ux-lists.spec.ts`) | `served-activity` | On the S6 fixture run, the candidate phase reads a live `<lane>.questions.json` answered state and shows the `RUN=` line when the project is in `viewer.expose_run_dir`. Worker-phase mocks serve `activity.controller`; the chip shows `controller running`, and `not_running` only after it holds for 15 s (clock mocked). | no served fields |

**Fixture additions.** Each goes in its slice's module, `tests/project-workflows/fixtures/ux-<slice>.ts`, as mock payloads plus a `seed(root)` for the candidate phase:
- **S3 (`ux-run.ts`):**
  - node-less diagnosis, repair and PID events;
  - a two-lane candidate that failed identically twice with no review and no diagnosis event;
  - an interrupted run in three variants: controller row, review note only, and freeze note;
  - a repair continuation;
  - a blocked-before-freeze run with a deadline row;
  - a pane-attention `interactive` event.
- **S4-core (`ux-node.ts`):** a verify node at attempt 3 with results 1-3, where 1 and 2 have identical `error.message`.
- **S4a (`ux-verify.ts`):** a candidate with a rejected exit-0 check, and a worker attempt with an unkeyed `Executed check failed: <path> …` reason.
- **S4b (`ux-launch.ts`):** a result pair with a repair-changed file, a waiting question, and a running worker.
- **S4c (`ux-review.ts`):** a native review with one running reviewer, and a succeeded approval with no event.
- **S6 (`ux-lists.ts`):** its own run with a live `<lane>.questions.json`, a pane event and a controller PID; and a registry `viewer.expose_run_dir` entry for the seeded project. The temp roots sit outside `$HOME` in CI and give `run_dir: null`, so the `RUN=` assertion runs in the worker phase (mocks), and the candidate phase asserts null.

### 12.3 Migrations of existing assertions (same commit as the slice)

| Slice | Where | Change |
|---|---|---|
| S1 | `inputs.spec.ts:143-144` (receipt times), `:155` (`worker-stop` "Stop confirmed at 2026-03-01 10:20:00 UTC") | assert `time[datetime="2026-03-01T10:00:00Z"]` and its `title`; `worker-stop` text becomes "Stopped 10:20 · stop confirmed" |
| S1 | `guardrails.spec.ts:56` (`shown()` helper), `:222`, `:224`, `:231` | the helper checks `time[title]` or `datetime` instead of the long UTC text |
| S1 | `tests/project-workflows/playwright.config.ts` `use` | add `timezoneId: 'UTC'`, `locale: 'en-GB'` |
| S3 | `clarity.spec.ts:118` (loop `graphNode(page, id).click()` from node pages) | `nodeListItem(page, id).getByRole('link').click()`, since the graph is not on node pages |
| S3 | `review.spec.ts:104-106`, `reviewers.spec.ts:135-136`, `projects.spec.ts:317-319` (`graphNode(...).toHaveAttribute('data-status')` on node URLs) | `nodeListItem(page, id)` `toHaveAttribute('data-status', …)` (the strip carries it) |
| S3 | `inputs.spec.ts:84-89` and `:56` | unchanged: the tabs keep role, arrows and `aria-selected`, and the graph lives in the Run tabpanel, so it is absent on Assignment (:56) and visible again on Run (:89) |
| S3 | `projects.spec.ts:162/179` `node-hint` | unchanged (Steps caption) |
| S3 | `projects.spec.ts:157/184`, `lanes.spec.ts:56/153/194` `definition-changed`/`definition-current` visible | unchanged (definition chip on the facts line) |
| S3 | `inputs.spec.ts:40-47/94-95/263`, `lanes.spec.ts:68/195` `run-inputs-facts` | unchanged: the element is the visible facts line; permission mode and finish sit in its nested `run-details`, and `toContainText` reads textContent |
| S4-core | `projects.spec.ts:214` `worker-summary` on the verify node | `worker-report-link` visible; `worker-summary` asserted on the launch node |
| S4-core | `projects.spec.ts:228` `assumptions` on the verify node | moved to the launch node (open "Open assumptions") |
| S4-core | `projects.spec.ts:233/256` `reuse-none` or `reuse-list` | `reuse-list` count 0, or visible in the worker phase (`:252` keeps `REUSE_MESSAGE`) |
| S4-core | `projects.spec.ts:302` `node-attempt` "0 (not started)" | "not started" |
| S4a | `projects.spec.ts:305` "Retrying is done through the workflow CLI" | drop the sentence; keep `worker-error` containing `injected_gate_failure`; assert `node-next` |
| S4b | `inputs.spec.ts:146` `receiptRow('Observed state')` and `:148` `receiptRow('Launcher status')` | the fixture's worker is stopped (`:155`), so both rows have count 0; `:147` (invocations) is unchanged; the receipt sits in the closed Session disclosure (open it before any `toBeVisible`). "State at launch" on a running worker is asserted in `launch-question-first`. |
| S4b | `clarity.spec.ts` `created-file-rendered` (130-176) | open the Markdown row first, then assert `file-rendered` |
| S4b | `clarity.spec.ts:268` `file-findings-none` | open the file row first; exact text unchanged |
| S4b | `clarity.spec.ts` `output-first-task-collapsed` (177-195), `verify-shows-checks-not-files` | unchanged: Report and Files precede the closed Task; verify has no `changed-files` |
| S6 | `projects.spec.ts:142` `run-list li` count 5 | unchanged: each `RunRow` stays wrapped in an `<li>` |
| S6 | `projects.spec.ts:149` `getByRole('group', { name: 'Current definition graph of …' })` on a workflow with 5 runs | "Current definition" is a closed `<details>` while runs exist, and role queries skip its hidden content, so first click the `current-definition` `<summary>`. `:148` (`toContainText('9 nodes')`) reads textContent and is unchanged; `:277` (the empty workflow) is unchanged because the details are open when there are no runs |
| S6 | `projects.spec.ts:133/138/181/263/271` `currentCrumb` | unchanged (the fixture names are not the generic name) |
| S7 | `reviewers.spec.ts:86` column headers | must stay green; hiding columns never applies when values differ across the review |

**All suites keep `expectNoExecutionControls`.**
- Step, attempt and file rows are links or `<summary>`.
- Buttons read "Copy", "Show contents", "Show lines", "More", "Run", "Assignment", "Local" and "UTC".
- No button text holds a path or a command.

**Red/green evidence per slice.**
1. Write the slice's new scenarios and unit tests first, and run them against the pre-slice build in both phases. They must fail for the reason in the table: red.
2. Implement the slice. The new tests pass, every untouched existing scenario passes, and each migrated assertion is changed in the same commit with a one-line reason: green.
3. The handoff note records both runs (per the repo's PRD/TDD workflow).
4. Workers run their slice's targeted tests; the verifier runs the full suites.

## 13. Open questions (defaults recommended)

1. **Default time zone.** Local time with the UTC tooltip and a remembered toggle, or UTC by default to match `events.jsonl` and CLI output? *Default: Local.*
2. **Serve the run directory (B3) for your projects?** It makes every command paste-ready, but reveals the home-relative layout to anyone who can reach the viewer. *Default: the code default is off. Once S5 is deployed, add `"viewer": {"expose_run_dir": ["project-b", "md-manager"]}` at the top level of your local registry (`~/.config/md-manager`), since the viewer is bound to localhost and tunnelled. Launches keep the key, because `registry.py` rewrites only spans inside `projects`.*
3. **Review-blocked next step.** Show the three-step template with placeholders (`init <fixes-feature> --repo <target repo>`, fill in and commit, then `launch <fixes-feature> --repo <target repo> --live --automatic`), or text only ("fix in a new run")? *Default: the template, labelled "Likely next step", with the placeholders visible.*
4. **Activity order.** Oldest first everywhere (the story reads top-down, and the Now banner carries the latest state), or newest first while a run is live? *Default: oldest first, with a remembered "Newest first" toggle.*
5. **How to ship.** S1–S2 as direct commits and S3–S7 as workflow feature runs (dogfooding the viewer), or everything as direct commits? *Default: the mixed plan in section 11.*

---

## Appendix A. Audit finding map

Every finding id (`lens:id`) and the section that addresses it.

| Finding | Addressed in |
|---|---|
| orientation:run-first-screen-no-answer | 4.2 Now banner and measured fold budget (one-row Projects header, tabs above the graph); 6.2; 3.2 (facts → header line + Details) |
| orientation:no-run-timeline | 4.2 Steps + Activity; 5 |
| orientation:node-page-mega-scroll | 4.4 section index; 4.5 dense files; 7 |
| orientation:pending-question-buried | 6.2 rules 1-2; 6.4 (`question` and `pane`); 4.5 Questions first with both `answer` forms; B2 |
| orientation:navigation-model-node-list | 4.4 sticky step strip + prev/next; 3.2; decision "one pipeline view per screen" |
| orientation:evidence-duplicated-and-scattered | 3.2 one home per item; 7 dedup by `result_uri` |
| orientation:naming-feature-implementation | 4.1 workflow title rule; B2 `activity.feature` |
| orientation:hierarchy-depth-empty-levels | 4.1 Runs home; project page grouped by feature; S6 |
| orientation:times-no-durations | 5.3; durations everywhere |
| orientation:earlier-attempts-unreachable | 4.4 attempt strip; `/attempts/<k>`; 4.6 attempt 1 view |
| orientation:graph-clipped | 10 graph fit (`dag.ts` 136/28, viewBox scaling) |
| orientation:boilerplate-disclaimers | 3.3; 8 |
| orientation:mobile-node-detail-offscreen | 4.3; 10 mobile; focus to the node heading |
| orientation:assignment-tab | 4.10 routed tab, reordered, duplicated facts removed |
| orientation:breadcrumb-route | 3.2 breadcrumb (node crumb, status dot, no Home); info line only on `/projects` |
| orientation:attempt-numbering | 5.3 attempts vocabulary; 5.2 rule 1; B1 |
| orientation:event-data-gaps | 5.2 rules 2, 4, 11 (client workarounds); B1; C1-C3 |
| chronology:no-run-timeline | 4.2; 5 |
| chronology:unattributed-events-hidden | 5.2 rule 5; Activity rows visible by default |
| chronology:no-durations | 5.3 durations |
| chronology:last-activity-misleading | 5.2 rule 10; header "took"; B2 `last_activity_at`/`finished_at`; 4.1 fallback row claims no finish or duration from `updated_at` |
| chronology:utc-only-absolute-times | 5.3 `<time>`, local, toggle; S1 |
| chronology:review-approval-no-events | 5.2 rule 4 (≈ inferred, labelled); 4.9; C1, C2 |
| chronology:questions-wait-time-buried | 6.2 rule 1 (asked N min ago, deadline paused); 5.2 rule 7 |
| chronology:attempt-numbers-wrong | 5.2 rule 1; B1 |
| chronology:earlier-attempts-unreachable | 4.4 attempt strip; 4.6 |
| chronology:lane-aliasing-scrambles-history | 5.2 rules 2, 11; B1 (controller rows, lane prefix); C6 |
| chronology:worker-live-progress | 4.5 working N min + deadline; 5.2 rule 9. Partial: `signalled_at` needs C4 |
| chronology:idle-gaps-invisible | 5.2 rule 6 gap rows and axis break |
| chronology:live-freshness-unknown | 6.3 live chip |
| chronology:awaiting-approval-since-never-shown | 4.9; 6.2 rule 3 (since the node's last status event) |
| chronology:check-setup-candidate-start | 5.2 rules 4, 8; 4.6 setup/checks split; C3, C10 |
| chronology:no-recency-on-project-levels | 4.1 rows with age and duration; B2 |
| chronology:event-row-noise | 5.3 humanized messages; Activity rows |
| chronology:reviewer-timing-partial | 4.7 reviewer durations, deadline ≈ `launched_at + review_timeout_seconds`; C1 for print |
| detail-density:launch-files-wall | 4.5 dense lazy rows; 7 Files |
| detail-density:gate-reason-not-on-check | 4.6 rejected checks, and unkeyed reasons as gate-level (command-tail match only when unique); 7 Checks; B5 |
| detail-density:verify-attempts-hidden | 4.4 attempt strip; 4.6 |
| detail-density:verdict-strip-missing | 4.4 node header; 4.3 focus |
| detail-density:worker-narrative-duplicated | 4.5 Report once plus verifier-note delta; 7 dedup |
| detail-density:repair-files-misattributed | 4.5 files from `results/<lane>/1` plus repair badges |
| detail-density:no-diff-view | S7 A/M/D and per-file diff from `review.diff`. Partial: a diff before review needs C9 |
| detail-density:screenshots-full-size-unlabeled | 7 thumbnails plus `<dialog>`; scenario captions with B5 |
| detail-density:checks-verbose-no-durations | 4.6 checks table; 7 |
| detail-density:findings-table-density | 4.7 blocking cards, cards ≤760, legend in `[?]` |
| detail-density:assignment-task-triplicated | 4.10; 3.2 (Assignment canonical, launch Task closed, JSON folded) |
| detail-density:node-header-noise | 4.4 header; 8; identifiers disclosure |
| detail-density:node-timing-gaps | 4.4 timing line with source; 5.2 rule 4 |
| detail-density:wasted-left-column | 4.4 full-width node view; left column removed |
| detail-density:mobile-overflow-and-depth | 10 mobile (`overflow-wrap`, cards, header collapse) |
| detail-density:candidate-lane-boilerplate | 4.6 lane table, failing first, boilerplate dropped |
| detail-density:artifacts-unlabeled | 7 Other artifacts. Partial: the setup log label needs B5/C10 |
| detail-density:challenge-verbose | 4.8 |
| live-status:run-why-not-surfaced | 4.2 Now banner; 6.2 reason sources 0-4. Source 0 quotes the in-scope controller row for runs blocked before freeze (rule 6); B1 serves that row's status |
| live-status:no-next-action | 6.1, 6.2 command table, including node-level review and freeze interruptions and repair continuations (rule 5), runs blocked before freeze (rule 6), the `--no-herdr` answer form and the three-step new-run template (rule 9) |
| live-status:controller-events-hidden | 5.2 rule 5; Activity; B1 |
| live-status:question-attention-invisible | 6.2 rules 1 (question) and 2 (pane); 6.4 `data-attention` `question`/`pane`/`approval` on the graph, Steps row, strip chip, run rows and `document.title`; B2 live questions and `attention.kind: 'pane'` |
| live-status:no-time-dimension | 5; 4.2 live variant (elapsed, deadline) |
| live-status:no-liveness-indicator | 6.3 freshness chip (poll half) and controller suffix (controller half) from B2 `activity.controller`, which checks `/proc/<pid>/cmdline` for this run's `automatic-step` plus the start time, so PID reuse cannot read as running; 6.2 rule 5 (c). Partial: Linux only (`unknown` elsewhere), and a heartbeat (C7) would remove the 15 s hand-over debounce |
| live-status:run-list-uninformative | 4.1; B2 |
| live-status:graph-tail-clipped | 10 graph fit |
| live-status:graph-encoding-collisions | 10 (status glyph, dash only for executor, distinct selection ring, no kind strokes) |
| live-status:status-wording-mismatch | 8; 6.2 wording rules (a paused run is never "Failed") |
| live-status:event-attempts-wrong-and-incomplete | 5.2 rules 1, 3, 4; B1; C1-C2 |
| live-status:controller-lane-alias-collision | 5.2 rule 2; B1; C6 |
| live-status:retryable-hint-misleading | 6.2 rules 7-8 and wording rules; 4.6 rejected checks |
| live-status:fold-spent-on-static-facts | 4.2 (one-row app header, run header line, Details, compact legend, fold budget) |
| live-status:succeeded-outcome-not-summarised | 6.2 rule 11; 4.2 succeeded variant |
| live-status:refresh-blanks-page | 6.3 Refresh as background reload |
| live-status:identical-workflow-names | 4.1 title rule; B2 |
| live-status:observed-state-stale | 4.5 "State at launch", hidden after stop. Partial: live native state needs C4 |
| live-status:attempt-counters-unexplained | 5.3 attempts plus markers; pending "not started" |

## Appendix B. Judge constraints and how they were reconciled

1. **Graph: SVG or HTML strip?** The feasibility judge's graft wins. `WorkflowGraph` stays SVG and is fitted through `dag.ts`, and every pinned attribute and keyboard behaviour is unchanged. The operator judge's goal of no clipping and no inner scroll at desktop is met by the fit.
2. **The graph on node pages.** The operator judge requires one pipeline view per screen, and node pages need a sticky, clickable step list, which the tests use at 420 px too. So node pages show the step strip (`run-node-list`), not the graph. This deviates from the feasibility graft that keeps the graph on node pages. Its `must_avoid` is still honoured: every node-page `graphNode` assertion (clarity.spec.ts:118, review.spec.ts:104-106, reviewers.spec.ts:135-136, projects.spec.ts:317-319) moves to the strip's `data-status` in the same S3 commit.
3. **`run-node-list` without double testids.** It is its own element on each page: the Steps `<table>` on the run page and the strip `<ol>` on node pages. The graph keeps `workflow-graph`. No element carries two testids.
4. **Chronology is the default view.** Steps with starts, durations, attempt markers and ⚑/⚒, plus the Activity rows with node-less diagnosis and repair, are on the default Run tab with no toggle. Only PID checkpoint noise sits behind "Controller log (n)".
5. **No lane cards.** A one-line-per-lane block appears only for runs with ≥2 lanes and repeats no durations. This is the operator judge's lane graft without the triage-first duplication.
6. **Commands.** Only RUNBOOK-prescribed commands, and only for a situation matched from current state (6.2 scope rule).
   - The identical-failure rule also covers runs without a diagnosis event (guardrails).
   - There is no `git push`, and no relaunch of the same feature to fix review findings. The review-blocked template goes through `init <fixes-feature>`.
   - A new run of the run's own feature is suggested only for a run blocked before freeze, which RUNBOOK:315 says "then needs a new run". Even there `<feature>`, `<new run id>` and `<target repo>` stay placeholders.
   - `answer` shows the `--no-herdr` form next to the Herdr form, because the operator often works from a plain SSH shell.
7. **Section index, not sub-tabs, on node pages.** This keeps Ctrl-F working and the evidence in the DOM (both judges' `must_avoid`).
8. **Assignment tab kept and routed.** It is not folded into per-node Inputs tabs (feasibility must_avoid: no big-bang Assignment removal). The verify node gets a Requirements section, which is the graph-inspector graft.
9. **Server list headlines.** B2 computes them only from what `projectRun` already reads (`run-state.json`, which includes the review section, plus `plan.json` and `events.jsonl`), plus the lanes' questions files. There are no review-file or lane-result reads per list poll (feasibility `must_avoid`).
10. **Controller liveness.** The feasibility judge's `must_avoid` is against `process.kill` on a PID parsed from event text, because PID reuse gives a false "alive". The operator's P1 needs the controller half anyway: during a worker phase, 28 minutes without events is normal, so a dead controller would otherwise look healthy until its deadline (3-4 h).
    - B2 answers the objection read-only. It says `running` only when `/proc/<pid>/cmdline` is this run's `automatic-step <run dir>`, the argv the controller itself spawns (automatic.py:1103), and the process started at or before the PID event (automatic.py:1244).
    - A reused PID fails the argv or the start-time check, and gives `not_running` or `unknown`, never `running`. `unknown` is never shown. `not_running` is shown only when it holds for 15 s, which covers the checkpoint hand-over between two `automatic-step` processes.
11. **The first screen is measured, not assumed.** The earlier budget assumed a one-row header that no slice built, and put the tabs below the graph, although inputs.spec.ts:56 and :89 require the graph to disappear on Assignment. S3 now makes the Projects header one row and puts the tabs above the graph, inside whose Run tabpanel the graph lives. `run-steps-timeline` asserts the focus row inside 1440×900. Goal 2 states the lane limit (≤2) that the budget in 4.2 supports.
