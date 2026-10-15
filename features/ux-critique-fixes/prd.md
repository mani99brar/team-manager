# PRD: UX critique fixes, stage A (`ux-critique-fixes`)

Status: draft, grill answered by the panel on 2026-10-13 ([O10] to [O15]). Base: md-manager 44b9c24. Source: the Astra + Fable critique of the live dashboard (`~/.local/state/md-manager-ux-critique/2026-10-13/merged.json`, ids M1-M36), the operator's review of it and the operator decisions in `decisions.md` ([O3]-[O9]). This feature is **stage A** of three; stages B and C are separate features (section 4).

## 1. Problem

The operator's words: "There are so many issues i can see. No filteration for runs, running should be show on top be default and readibility sucks." The critique confirmed it on build 44b9c24. Stage A takes the findings that make the first screen untrustworthy or unreadable:

- **The first screen lies while it loads and after.** Every cold open of a Projects page says "cannot be read", "nothing waits", "Triage · 0" and "0 runs" for data that is merely pending (M1). Settled, Triage says "Needs you · 0 · nothing waits on you" while paused runs wait for a decision the run page calls "Likely next step" (M2), but 9 of the 11 paused runs on the live registry are dead: a later run of the same feature exists ([O4]).
- **Triage on a desktop is a 240 px column**; run ids break one letter per line (M5). Stopped runs show ticking clocks like "359h01m" (M14). The paused queue folds to 5 under three empty sections (M18). The rail's "1 paused" badge is green, red or grey depending on the last result (M19). Failed runs say "Watching · updated 2 s ago" (M29). There is no way to keep a run in view on Triage (M20, operator: "I would love a add to triage option").
- **Run detail pages bury the answer.** A blocked review page is 14,768 px with every blocking finding printed twice in bold (M9); a blocking reviewer opens green, "Succeeded · This step completed" (M10); node pages stack five bands before the first finding (M22); the worker page shows the word "completed" as a figure (M35); the Assignment view inlines decisions.md and every task (15,812 px) and its lane table has unlabelled numbers (M27, M28); a storage failure stresses Retry over the configuration fix (M36); finding prose runs 1,300 px wide (M6, measure part).

## 2. Users and surfaces

One operator, on a desktop browser (phone work is out of scope, [O3]). Surfaces: the Projects shell (rail, Projects page, project page, Triage, feature page: lane `lists`) and the run's node pages, review and reviewer pages, the Assignment view and error panels (lane `pages`). The viewer stays read-only toward runs: no write, no new request type, no server or contract change.

## 3. Goals

1. Nothing on the Projects shell claims an empty, failed or all-clear state while its data is still loading.
2. Triage's first section lists exactly the runs that wait on the operator, including a paused run whose served state needs a decision, and never a superseded one.
3. Triage fills the desktop width; times read as dates and days; badges say state, not last result; the operator can pin a run to Triage.
4. A review or reviewer page opens on its verdict and its open blocking findings, each once; node pages reach their content in the first screen; the Assignment view is a summary with folded documents.

## 4. Non-goals (later stages, other features, rejected)

Reviewers: these are planned, not gaps. Do not raise them as missing.

- **Stage B** (feature `ux-critique-fixes-b`, from this stage's integrated sha): M3 run filters (status, step, date, text, sort) on every run list; M4 one ordering everywhere (running and waiting on top); M7 collapsed feature groups and dated rows on the project page; M16 Recent's "Today" filter; M17 list state in the URL; M8 graph zoom and dock column; M21 sessions cue and table; M23 "Open" navigates; M33 identity line; and the run dock's time words of M14 (`signal/LiveDock.tsx`).
- **Stage C** (feature `ux-critique-fixes-c`): the M6 type floor (13 px, 14 px on phones, 11 px only for uppercase labels) and token changes in `theme.css`; M30 skills home; M31 GitHub and spend wording; M32 chart axis wording; GH8 root Playwright suite in a policy; and the server lane: M15 aggregate runs route, GH4, GH6, GH7, RLI21 and the server halves of GH3, GH12, RLG24 and RLI16.
- **Rejected by the operator (phone):** M11, M12, M13, M24, M25, M26, M34. Existing phone assertions stay green; nothing new is built for phones beyond what M28 and M22 state.
- **Controller fixes** (BL1, BL3, GH3, GH12, RLC12, RLD18, RLD20, RLF1, RLF2, RLF4, RLG23, RLG24, RLI16, RLI17, RLI19) run in the separate, concurrent feature `workflow-collected-fixes`, which owns `workflow/` only.
- **No server or contract change in stage A.** The M2 rule is computed in the client from served data ([O4]); a served `situation` or `follows` field is a stage C option.
- **No landing change for M20.** The Projects tab keeps landing on the project cards ([O6], projects-dispatch [O3]).
- No change to `compareRuns` or any server order (it is the keyset cursor order).

## 5. Lanes and the contract between them

Two lanes run in parallel and meet only at the candidate (`policy.json` lists the owned paths):

- `lists` (claude-opus-5-5, effort medium): M1, M2, M5, M14 (rows and `formatSpan`), M18, M19, M20, M29.
- `pages` (claude-sonnet-5-5, effort medium, skill `impeccable` to check its fixes against DESIGN.md, [O15]): M9, M10, M22, M27, M28, M35, M36 and the M6 prose measure; it owns `DESIGN.md` in this stage ([O5]).

Review and repairs ([O11], [O12]): each lane has one GPT 6.1 lane reviewer (pi, 1 round, 15 min). Only a P0/P1 the lane reviewer ties to a line the lane changed starts a repair round; P2/P3 lane-review findings go into the lane's handoff doc (`docs/handoff/ux-fixes-lists.md`, `docs/handoff/ux-fixes-pages.md`) and never spend a repair. Lane review may use up to 2 of the run's 3 repairs; it replaces neither the general and coverage reviewers nor any acceptance check. There is no `panels` review in stage A.

Closed set of shared modules (each lane keeps the other's uses working; a test of each lane proves its side):

| Module (owner) | Used by the other lane | Rule |
|---|---|---|
| `time.ts` (`lists`) | `NodeHeader`, `ReviewDetail`, `RunView`, `node/*` call `formatSpan`, `formatAgo`, `formatClock` | `formatSpan` is byte-identical below 48 h; at 48 h and over it reads days (`2 d 0 h`). Every other export keeps its signature and its output for existing callers; a new cadence-aware freshness helper (M29) may be added beside them. No `pages` test asserts a span of 48 h or more. |
| `tone.ts` (`lists`) | `NodeHeader`, `StepStrip`, `ReviewDetail`, `RunView`, `node/ReviewSections` | `stateTone`, `toneClass`, `statusTone` keep their outputs for every existing input; new tones come from new functions. |
| `LiveStatus.tsx` (`lists`) | mounted by `RunHeader.tsx` (`pages`) and `signal/IdentityLine.tsx` (unowned) | Props unchanged (`status`, `meta`, `now`); the `data-state` values and the testid `live-status` unchanged; only the visible text changes (M29). |
| `panels.tsx` (`pages`) | `ProjectsView`, `RunsHome`, `RunRow`, `dispatch/*` use `AppLink`, `StatusBadge`, `LoadingPanel`, `EmptyPanel`, `ErrorPanel` | Signatures and output unchanged, except `ErrorPanel` for an error whose `code` is `RUNS_ROOT_UNAVAILABLE` (M36). |
| `ProjectsView.tsx` crumb bar (`lists`) | none | The run-page "Add to Triage" control sits in the crumb bar, outside `[data-testid=projects-workspace]`, so the run and node pages' button allow-list (`revamp-pages.spec.ts`) does not read it. |

DOM hooks each lane keeps for the other lane's specs:

- `pages` keeps, on node pages: `run-status` and `run-status-meaning` with their texts, `node-status-meaning` and its text for worker, verify and integration nodes (a reviewer's meaning text changes with M10), `node-attempt`, `awaiting-notice`, `live-status` (its text is `lists`' and changes with M29), `time-zone-toggle`, `run-node-list` with each `li[data-node-id][data-status]` set to the step's status (never the verdict). On the run page and the Assignment view: the `Run views` tablist and `tab-assignment` (M22 removes tabs from node pages only).
- `lists` keeps, on the feature page and Triage: one `li` per run across the state sections (Triage's Pinned section may list a run a second time, the one authorized shortcut, [O6]), the row link `a.run-row[data-run-id][data-status]` whose accessible name starts with the run id, `data-attention` for question, pane and approval, `run-list`, and the section testids `needs-you`, `today-runs`, `running-runs`, `paused-runs`, `recent-runs`.

Unowned in this stage (neither lane edits them): `src/projects/signal/`, `src/projects/sessions/`, `src/projects/status.ts`, `src/projects/ui/`, `src/projects/theme.css`, `src/App.css`, `contracts/`, `server/`, `tests/project-workflows/{fixtures.ts,playwright.config.ts,harness.ts,sessionProjection.ts,controls.spec.ts}`. New fixture runs go into each lane's own fixture modules; existing fixture runs are never changed.

## 6. Requirements: lane `lists`

### M2 Needs you counts runs that need a decision (P0; [O4], [O13], [O14])

The rule, from the served run list only (`RunSummary.activity`), in one exported function of `lists.ts`. It classifies each run in this order and stops at the first branch that matches:

1. **Superseded** (paused runs only): a run with status `paused` and a later run in its project and workflow is superseded, whatever its attention kind (question, pane, approval, challenge or interrupted): never in Needs you, never in the tab-title count, never in a warn tone or badge, shown in Triage's Paused section inside a closed fold "N superseded" as "superseded by <the greatest later run id>". A later run in another workflow of the same project, or in a same-named workflow of another project, does not supersede.
2. **Waits on the operator** (today's kinds, unchanged): a run that is not finished and whose served attention kind is `question`, `pane` or `approval` needs the operator, whatever its status.
3. **Needs a decision**: a run that is the latest run of its project and workflow and whose served attention is either `{kind: 'paused', node_id: 'challenge'}` with status `paused` (the `challenge_paused` and `challenge_held` situations both serve the challenge node paused) or `{kind: 'interrupted'}` with status `paused` or `running` ([O13]) needs the operator.
4. **Otherwise** today's placement applies (Today, Running, Paused, Recent). Status alone never puts a run in Needs you.

- **Latest run of its project and workflow** ([O14]): no other served run with the same `project_id` and `workflow_id` has a greater (`created_at`, `run_id`), comparing `created_at` chronologically and a tie by the lexicographically greater `run_id`, whatever that run's status. `activity.feature` is never read for this. Supersession is computed against the whole loaded list of each (`project_id`, `workflow_id`), whatever the input order (pages are ordered by `updated_at`, not `created_at`); the classification is computed once per served list and passed to every row, tone and count, never re-derived from `waitingKind(run)` alone ([L4]). Triage and the rail read several pages, the project page reads page 1; the lists handoff records that limit.
- Outside the set: a paused run at any other step (deliberately parked, stays in Paused), a failed, succeeded or cancelled run, an accepted run, a run without `activity`, a running run without interrupted attention (stays in Running or Today), and an interrupted run served as `running` that is not the latest (keeps its Running or Today placement with its interrupted summary; the superseded fold holds paused runs only).
- A needs-operator run is listed **once**: as a Needs-you card, never also under Running or Today (an explicit Pinned shortcut is allowed), and it counts as a wait, not as running, in the Needs-you count, the tab title, the rail and card badges ("N waits on you", not "N running") and the project page's "Needs you and running". When a refresh clears its interrupted attention, an otherwise running run returns to its normal section. The served status is never rewritten.

Rendering: a needs-decision row is a Needs-you card with the chip "decision waits", `data-attention="decision"`, the since-time from `attention.since`, and the next step "resume or accept the challenge on the run page" (challenge) or "resume the run on the run page" (interrupted). The project page's "Needs you and running" lists it; the tab title "(n)" counts it; the project card shows "N paused" for non-superseded paused runs.

Acceptance: a closed-set unit test in `tests/unit/lists.test.ts` covers every row of the set above and rejects ([O13], [O14]):
- an interrupted, running, latest run outside Needs you, or listed in two sections or counted twice;
- a plain running run (no interrupted attention) in Needs you;
- a superseded interrupted run (paused or running) in Needs you;
- non-supersession when the later run's `activity.feature` differs or is missing (the feature text is not the key);
- supersession by a later run in another workflow of the same project, or in the same `workflow_id` of another project, or by an older run;
- a nondeterministic tie: equal `created_at` resolves by `run_id`, and "superseded by" names the greatest later run;
- a superseded run in any attention count (Needs you, tab title, rail and card badges), including a superseded paused run that carries a `question`, `pane` or `approval` attention;
- a running run with a `question`, `pane` or `approval` attention outside Needs you (branch 2 keeps today's rule);
- an interrupted running run that keeps Needs-you placement after a refresh clears its attention;
- a superseded question/pane/approval-paused row rendered in the warn tone or with '?', and a predecessor read as latest when its superseding run comes after it in input order ([L4]).

Scenario `triage-attention` proves it in the app.

### M1 Loading is its own state (P0)

`ProjectRunInfo` gains a three-way state: `loading` (the registry run read has not settled), `failed` (the project's read or all its workflow reads failed), `read`. While loading: rail rows say "reading…" with no badge, the Triage badge and chip say "…", project cards say "reading runs…", the Projects header says "repositories: reading…", and no surface says "cannot be read", "nothing waits", "0 runs" or "Triage · 0". "cannot be read" stays for `failed` only. When some projects' runs failed, Triage says "N of M projects read; lists incomplete" above Needs you (the error details stay where they are). The project page builds its feature rows from the run summaries; the `/steps` tracks enrich them when they arrive and their absence never makes a feature read "0 runs". The feature page shows no reviewer or review-step line until its reviewer read settles (no "Review steps" flicker). Existing wording for a failed read ("cannot be read", "Runs not read: <reason>") and for a held request ("Reading runs…") stays.

Acceptance: unit tests in `tests/unit/dispatch.test.ts` for `projectRunInfo(null)` → loading and an errored entry → failed; scenario `triage-loading`.

### M5 Triage fills the desktop width (P1)

Triage's queue takes the full main column at every desktop width (no `minmax(200px, 240px)` column left from the old in-page rail). In a narrow row the time drops to its own line instead of squeezing the id; no run id breaks inside a word. Acceptance: scenario `triage-desktop`.

### M14 Stopped runs show dates and days, not ticking clocks (P1; rows and `formatSpan`)

- A paused row says "paused 10 d (since Oct 2)" and an interrupted row with status paused or running "interrupted 10 d (since Oct 2)", from `attention.since`, else its last activity, with no span; under a day they read "paused today (since <Mon D>)" and "interrupted today (since <Mon D>)", never "0 d"; a finished row (failed, succeeded, cancelled) keeps its end time and duration whatever attention it carries ([L3]); a ticking span appears only while the run is running without interrupted attention; finished rows keep their end time and duration.
- `formatSpan` reads `10 d 12 h` at 48 h and over; below 48 h it is unchanged (`46s`, `2m29s`, `25h03m`).
- `cardElapsed` and `sincePausedLabel` follow the same words; the one-clock rule stays (only `RunView` and `ProjectsView` own a clock).

Acceptance: `tests/unit/time.test.ts` (both sides of 48 h) and `tests/unit/lists.test.ts` (`rowTime` for paused, interrupted, running, finished); scenario `run-times`.

### M18 Empty sections collapse; Paused unfolds when it is the only work (P2)

When Needs you, Today and Running are all empty, Triage shows one line ("Nothing waits on you, moved today or runs") instead of three headed empty sections, and Paused shows every non-superseded paused run unfolded. Otherwise Paused folds after `PAUSED_SHOWN` as today. Superseded runs are always in their own closed fold ([O4]). Section testids stay in the DOM. Acceptance: scenario `triage-desktop`.

### M19 Badges carry their own state tone (P2)

A rail badge's tone follows what it counts: warn for "N waits on you" (including needs-decision and interrupted runs, which never count as "N running"), pause for "N paused" (non-superseded only), run for "N running", independent of the row's result glyph. When nothing waits or runs and a non-superseded paused run exists, the row glyph and tone are pause. The Triage badge in the rail and the phone chip use the same counts. Rail order stays [D6] of projects-dispatch with the new counts. Acceptance: `tests/unit/dispatch.test.ts` (badge tone per count, glyph rule, a cancelled latest run in another workflow no longer hiding a live paused one, a paused run superseded in its own workflow adding no paused badge); scenario `rail-state`.

### M20 "Add to Triage" (P2; [O6], [O10])

- **Where:** a toggle beside each run row's link inside its `li` (never inside the link) on Triage and the feature page, in the project page's reading pane, and on the run and node pages on the crumb row (outside `projects-workspace`; `lists` may wrap `<Breadcrumbs>` and the toggle in a row styled in `lists.css`, while `.navigation` in `App.css` stays unowned, [L1]), all sharing one store. Its accessible name is "Add <run id> to Triage" or "Remove <run id> from Triage".
- **What:** Triage gets a "Pinned" section at the top listing pinned runs newest first. Pinned is a shortcut list: a pinned run also keeps its place in its state section. A pin whose run is not among the runs Triage read shows its id as a link to its run page with "not among the runs read" (no reason: the client cannot tell age from a failed read, a deleted run or a stopped page, [L2]) and its Remove control.
- **Persistence ([O10]):** `localStorage` key `md-manager:triage-pins:v1`, a JSON array of `{project_id, workflow_id, run_id, pinned_at}` ordered newest first, at most 50 unique runs (pinning a pinned run leaves one entry; the 51st add drops the oldest pin). The store, `src/projects/pins.ts`, takes the storage object as a parameter, keeps every read and write in try/catch and never throws to its caller. A missing, unreadable or malformed value reads as no pins; when storage throws on read or write, pins live in memory for the page session and the Pinned section shows the one line "Pins are not saved in this browser".
- **Read-only:** no request on pin or unpin (no fetch, no XHR, no new route), no `server/` or `contracts/` edit. Pins are per browser and per origin (an SSH tunnel's port, a private window or a port change loses them); the lists handoff records the key and entry shape, so a later server store can keep the shape.
- The Projects tab keeps landing on the project cards.

Acceptance: unit tests of the store with a fake storage in `tests/unit/lists.test.ts` reject a duplicate pin, more than 50 entries, malformed JSON read as pins, a store that throws when storage throws, and a toggle path that issues any request (a counting fake); scenario `triage-pins` rejects an `/api` request on pin or unpin, a pin lost on reload when storage works, and a Pinned section without the note when storage throws; at 1440 px the crumb row that holds the toggle on a run page and a node page is no taller than the greater of that same page's `.breadcrumbs` height and the toggle's height, within 1 px; at 390 px only the toggle's 44 px height and no sideways scroll are asserted ([L1]). The tagged `[scenario:triage-pins]` test is marked `test.slow()` and covers the shared store across the four surfaces, the zero-request windows and reload; the storage-throws, malformed-storage, dedupe and 390 px variants are untagged sibling tests in the same spec file ([L8]).

### M29 The run chip leads with the run's state (P2)

On a run or node page, a failed run's chip reads "Failed Oct 9 · checked 2 s ago" and a paused run's "Paused since Oct 2 · checked 2 s ago", from the served run (`useServedRun()`: status, `finished_at`, `attention.since`, else `updated_at`); `data-state` keeps its values (`watching` for both). A failed run's detail is re-read at the list cadence (`LISTS_POLL_MS`, 15 s), and the chip turns `stale` only after two missed polls at that cadence, never between two on-time polls. Running, succeeded and cancelled runs read as today. Acceptance: `tests/unit/time.test.ts` (stale threshold per cadence); scenario `run-freshness`; `ux-time.spec.ts`'s Watching assertion rewritten to the new text, not deleted, and its `live-freshness` test keeps every assertion and drives its stale and recovery steps with `page.clock`, with no wall-clock wait longer than its old ones ([L6]).

## 7. Requirements: lane `pages`

### M9 One findings list on the review page (P1)

- The review node renders one findings list. It opens filtered to open P0/P1 ("Open P0/P1" on); the filter row adds severity toggles ("P0 n", "P1 n", "P2 n") beside the reviewer and lane toggles; "All n" shows every finding.
- A blocking finding is marked in place ("blocks integration" chip and fail stripe) and listed once; there is no separate "Blocks integration" list repeating it. The section index loses its "Blocking" entry and keeps a count of open P0/P1 on "Findings".
- A card's head is severity, reviewer, lane and the message's first sentence; the rest of the message, the requirement and the fields are behind "More"; all text at normal weight (400).
- `review-blocking-first` is rewritten, not deleted: the first finding card in DOM order is an open blocking one, marked in place, and its top is within the first screen at 1440×900.

Acceptance: scenario `review-one-list`; `review-blocking-first` and `revamp-review` updated to assert at least what they asserted before, against the new structure; the run and node pages' button allow-list (`revamp-pages.spec.ts`, owned by `pages`) extended by name for every new button `pages` renders inside `projects-workspace` on run and node pages: the severity toggles, a renamed open-only toggle, and the per-card "More" expander if it is a `<button>` ("More" and "Less" are already on the list).

### M6 (measure only) Prose at a readable measure (P1, part)

Finding messages, decision and task text and other long prose are capped at `70ch` (`max-width`), at every width. The type floor is stage C. Acceptance: at 1920 px, scenario `review-one-list` measures every `.finding-message` and scenario `assignment-folded` measures the opened decisions and task prose, each at most 70ch.

### M10 A reviewer leads with its verdict (P1)

- On a reviewer's node page (the `review` node and the projected `reviewer-<id>` nodes), the header leads with the verdict: "Blocked · round 2 · 4 open P1", "Approved · round 1", "Late, blocked · …", or "No verdict yet" while it runs; the session's outcome is neutral metadata ("session succeeded"). A reviewer never reads "This step completed." Workers, verify and integration nodes keep their wording.
- The step strip tones a reviewer chip by its verdict (fail for blocked, ok for approved), as the graph already does, with `data-verdict` on the chip; `li[data-status]` stays the step's status.
- The verdict comes from data `RunView` already loads (the review result; `signal/model.ts` may be imported, not edited).

Acceptance: a closed-set unit test of the lead text in `tests/unit/node.test.ts` (blocked, late blocked, approved, running, failed session, no record); scenario `reviewer-verdict`.

### M22 Node pages reach their content (P2)

On node pages only: the Run/Assignment tabs are not rendered (the run bar carries an "Assignment" link); the run bar is one line at desktop widths (run id, status and meaning, the Now headline ellipsized, the live chip, Local/UTC); the step strip is the only sticky band (the section index scrolls with the page); figure tiles sit on one row at 1024 px and wider. The crumbs (`ProjectsView`, lane `lists`) are not changed. Acceptance: scenario `node-compact` (the first finding of the seeded blocked review in the first screen at 1440×900 only, since fitting it at 390×844 would be rejected phone work; no `tablist` on node pages and no sideways scroll at 390×844; exactly one sticky element among the node page's bands).

### M35 Figures are numbers (P3)

The worker page drops the "Completion" figure; the completion status is a chip on the report's heading (completed ok, blocked fail, none yet neutral). Figures show numbers only. Acceptance: scenario `node-compact`; the specs that read `figure-completion` are updated.

### M27 Assignment folds its documents (P2)

The feature title is printed once. Decisions and each worker's task are closed `<details>` whose summaries carry their size ("Decisions · 2,300 words", "Task · 22,364 characters"); owned paths and checks fold the same way. Lane names in the lane table link to their worker sections and move focus there. Opened, decisions and tasks render as inert Markdown exactly as today. Acceptance: scenario `assignment-folded`; `guardrails.spec.ts` `decisions-shown` and `inert-markdown`, `inputs.spec.ts` and `ux-refine.spec.ts` updated to open the fold first, asserting what they asserted before.

### M28 The lane table says what its numbers are (P2)

Column headers "Owned paths", "Checks", "Task (chars)". Below 600 px each lane is a card with those labels and the page does not scroll sideways at 390 px. Acceptance: scenario `assignment-folded`; `tests/unit/assignment.test.ts` keeps passing.

### M36 A missing run storage says what to fix (P3)

For an API error with `code === 'RUNS_ROOT_UNAVAILABLE'`, the error panel leads with "Run storage missing", says to fix the project's `runs_root` entry in the projects registry (`projects.json`) naming the project id parsed from the failed request's path, `ProjectsApiError.path` (`api.ts:56`, e.g. `/api/projects/<encoded id>/workflows/…`; decode the segment), links back to that project's page, and folds the HTTP code and request path under a closed "Technical details". Retry stays as a secondary action. Every other error renders exactly as today (`projects.spec.ts` `request-errors`). Acceptance: scenario `storage-missing` (a mocked 503 via `page.route`, in both phases; seeding a missing runs root needs `seed.ts`, which `pages` does not own); a unit test of the project-id parse in `tests/unit/panels.test.ts` or `node.test.ts`.

## 8. DESIGN.md amendments (lane `pages`, [O5])

- Under "Hierarchy" (DESIGN.md:222-231) add: "**Measure**: long prose (finding messages, decisions and task text) at most 70ch."
- In "Lists, rails, rows, finding cards, section headers, buttons" (DESIGN.md:290-291): a finding card's head is severity, reviewer, lane and first sentence at normal weight, its body behind More; blocking findings are marked in place in the one findings list; figures are numbers only; on node pages the step strip is the only sticky band and there are no tabs (the run page keeps them).
- No token, type-scale or phone rule changes in stage A (the 13 px floor is stage C; the phone rules stay, [O5]).
- `lists` makes no DESIGN.md change; a rule it finds in its way goes into its handoff for stage B.

## 9. Behaviour on each path

- **Cold open:** loading states only (M1); then read or failed per project.
- **Poll refresh (15 s):** the page keeps its last data while re-reading; a pin, a fold's open state and the chip's state do not reset.
- **Read failure:** "cannot be read" or "Runs not read: <reason>" for that project only; Triage's incompleteness line on top.
- **Storage unavailable or corrupt (M20):** pins in memory for the session, a one-line note; nothing breaks.
- **Run moves:** a decision-waiting run that resumes leaves Needs you on the next poll; a follow-up run appearing supersedes its paused predecessor on the next poll.

## 10. Risks

- **`lists` is large** (8 findings over ~3.2 kLOC of hub files) and carries both P0s; Opus is pinned for it. A block past the fix loop costs a follow-up run.
- **Cross-lane spec breaks at the candidate.** Mitigated by the closed set in section 5 and by each lane owning every spec that asserts its strings (`policy.json`); a lane that would have to change a hook in section 5 stops with a question.
- **The M2 rule is a client heuristic.** It reads only served fields, keys supersession on the workflow ([O14]) and is pinned by a closed-set test; a served `situation`/`follows` field is a stage C option that would replace the key.
- **Pins in browser storage** do not follow the operator across browsers, machines or origins ([O10]); a server store is a later option with the same entry shape.
- **Memory on a 4-core host:** two full browser suites plus the critique app; the browser check timeout is 2400 s; a SIGKILL is fixed by headroom, never by skipping a check.
- **Known flakes:** `controls.spec.ts` `controls-unavailable`, `attack.spec.ts` `attack-section`, `ux-run.spec.ts` `run-now-banner` under load: reported in `untested`, not edited to pass.
