# PRD: UX critique fixes, stage D (`ux-critique-fixes-d`)

Status: the grill (`~/.local/state/cook/ux-critique-fixes/stage-d/grill/q1` to `q5`) is answered and applied: q1-q5 are answered ([O11]-[O15] in `decisions.md`; q3 by the operator's pick, the others by panel agreement), and every place a grill answer shapes the text is tagged `<!-- grill qN -->`. Base: main ca5e2bb (stages A-C and the engine feature `workflow-collected-fixes` merged; [O9], operator-decisions.md [O16]). Bare [O<n>], [G<n>] and [L<n>] refer to this feature's `decisions.md`; a decision of another stage names its stage. Scope: the "In scope" items D1-D31 of `~/.local/state/cook/ux-critique-fixes/stage-d/triage.md` (triaged against main, with its operator calls) plus D32, the grill-added item for interrupted case (c). File:line pointers are at ca5e2bb; workers find code by name when a line has moved.

## 1. Problem

Stages A-C and the engine feature built most of the 31 approved findings and the collected issues, but the stage reviews and the triage against main found decided items that were backlogged rather than built, parts of approved findings that are still unmet, and defects in the delivered code ([O9]). On main:

- **Review pages still mislead.** A reviewer's title row shows the session's green "Succeeded" badge ahead of its verdict; a reviewer whose verdict word is `failed` gets the green check glyph and is announced "succeeded" (M10). The findings filter row is about ten toggles under one hidden label with overlapping "Open P0/P1" and "Open only", "More" names neither what it opens nor both regions it toggles (M9), and a blocking P1 card shows the P1 stripe, not the fail stripe. At 1440x900 only the top ~6 px of the first finding card is on the first screen (M22).
- **Lists still say less or more than they read.** A partly failed project page omits the 50-run cut; Triage's scope line claims "live runs" it may not have read; the project page's "Needs you and running" block ignores the filter; a filtered Triage says "No run matches." twice; a feature header's state word comes from the filtered runs; an `awaiting_approval` row has no wait and its dock bar ticks forever (M3, M7, M14, stage C [O12]).
- **A run whose controller died stays under Running** on Triage, in the rail and in the badges while its run page says Interrupted (M2, [O4]).
- **Run page and node page defects:** the dock flips from column to overlay when the Sessions table's scrollbar appears in a 1200-1215 px frame (M8); Back from a node page loses the run page's scroll (M17, a stage B regression); the resume command's Copy button drops below the command on node pages between 481 and 1360 px (M21).
- **Projects and the step chart:** a non-git project says "git not read" and "GitHub not read" twice; while the overview loads every card says "GitHub not read" (M1, M31); at 1024 px with a run selected the chart's run ids break at every hyphen and dates clip; its copyable status command fails as written.
- **Pins** keep a per-tab copy, so a pin made in another tab is invisible and is erased by the stale tab (M20 defect). A finding's head sentence is cut at "etc." (M9 defect).
- **Server and contracts:** one invalid or duplicate run fails its whole workflow's run list (GH12's blast radius); the operator's "Relaunch by the operator" note and the engine's "Panes not attached" note read as controller blocks; a relaunched lane's dead launch session leaves the Sessions list.
- **Engine:** a message typed but not submitted is recorded `pane_busy` and `workflow note` tells the operator to send it again; a disk-killed check is transient only internally; the panel `budget_usd` default is documented as 5; `relaunch` prints "Nothing was relaunched." after it archived; `retry --all-failed` is dispatched before the pending-interrupt guard (RLD18, RLG24, RLD20, RLI16).

## 2. Users and surfaces

One operator, on a desktop browser (phone work stays rejected, [O3]). Surfaces: the review and reviewer node pages, the run page's step strip and dock, Triage, the project and feature pages, the Projects cards and the step chart (lane `ui`); the per-workflow run route, the run page's classification of controller notes, the Sessions route, the projects and workflow contracts and the controller CLI (lane `backend`). The viewer stays read-only toward runs.

## 3. Goals

1. Every review surface states the verdict first and the session outcome as muted metadata; the findings row is grouped, labelled and unambiguous; the first finding's message is on the first screen at 1440x900.
2. Every list's scope line and blocks state what was read and filtered, and never present a subset as complete.
3. A latest running run whose controller has been seen stopped for 15 s needs the operator on every list surface, as on its run page.
4. One unreadable run no longer hides its workflow's other runs, and the page says which run it could not read.
5. Controller notes the operator caused or the engine expects never read as blocks; every launch session of a relaunched lane stays listed.
6. The engine's deferred `contracts/workflow/` items land with their writers, and the CLI's refusal texts tell the truth.

## 4. Non-goals

Reviewers: these are planned, not gaps. Do not raise them as missing.

- **Everything stages A-C and the engine built stays**, with their scenarios and tests green, except where a section below names an amendment (section 9).
- **Out of scope by the triage** (`stage-d/triage.md` "Out of scope"): test-quality notes, items closed by a recorded decision, items already fixed and items found not real. Notably: M8's accepted-blocked first view (B-16/C-46, main meets stage B [O13]); a second Enter re-gate (E-2); a failed run served with `interrupted` attention staying out of Needs you (stage B [O16]); a server store for pins; the project and feature pages on the aggregate route (stage C [O15]).
- **No served `situation` or `follows` field** <!-- grill q1 -->: D32 classifies from the already served `activity.controller` (grill q1).
- **The home route's assembly is unchanged** <!-- grill q3 -->: D21 rewords Triage's scope line instead (grill q3); stage C [O15] stands.
- **Phone:** M11, M12, M13, M24, M25, M26, M34 and phone parts of other findings stay rejected ([O3]); existing phone assertions stay green.
- **Operator steps** ([O9]): turning run controls on, closing GitHub issues, BL1's `workflow accept` on shared-memory-006, merging `fix/multi-lane-repair`, the RLI21 probe (done). No lane pushes, merges or touches GitHub.
- **No new dependency.**

## 5. Lanes and the contract between them <!-- grill q5 -->

Two lanes run in parallel and meet only at the candidate (grill q5, `two-lanes`; `policy.json` lists the owned paths, exact files for `ui`).

- `ui` (claude-sonnet-5-5, medium, skill `impeccable`, walked by the critique): D1-D21, D22's client half and D32. It owns `DESIGN.md` in this stage ([O5]) and writes every amendment of section 8.
- `backend` (claude-opus-5-5, medium): D22's contract and server half and D23-D31. It owns `server/`, `contracts/` (projects and workflow), `workflow/` and `src/projects/node/sidecar.ts`, so RLD18 (D26) lands in one lane.

Review and repairs (as stages B and C): each lane has one GPT 6.1 lane reviewer (pi, 1 round, 15 min). Only a P0/P1 the lane reviewer ties to a line the lane changed starts a repair round; P2/P3 lane-review findings go into the lane's handoff doc and never spend a repair. No `panels` review.

**Handoff docs.** Each worker writes `docs/handoff/ux-fixes-d-<lane>.md` (`ux-fixes-d-ui.md`, `ux-fixes-d-backend.md`), in its owned paths: for each item it built, what changed (files), the proof (the test names that fail before and pass after, with the red and green runs, or the measured value for a browser item), and anything it could not do with the reason; P2/P3 review findings; sentences for RUNBOOK, README or DESIGN.md it could not write itself.

### 5.1 D22's field, frozen for both lanes <!-- grill q4 -->

`contracts/projects/v1.ts:941` `runList` is a `z.strictObject` and `src/projects/api.ts:160` parses with it, so a field one lane serves and the other reads cannot be built in either worktree by the shared type alone (stage C PRD 5 hit the same with `spend`). The shape is frozen here:

- The per-workflow run list (`GET /api/projects/:p/workflows/:w/runs`) may carry an optional `errors: [{ run_id: string, code: string, message: string }]`, present only when at least one run of the workflow cannot be read, on the first page only (no cursor), `message` redacted as the run detail route redacts it today.
- `backend` adds it to `schemas.runList` in `contracts/projects/v1.ts`, `contracts/projects/runList.schema.json`, an example and the contract test, and serves it (D22).
- `ui` owns `src/projects/api.ts` (backend changes no file under `src/` except `node/sidecar.ts`). `fetchRuns` takes the `errors` key off the raw answer before `schemas.runList.parse`, validates it with a local schema of exactly the frozen shape, and returns it on `RunPage` (and carries it on `WorkflowRuns`), so the `ui` worktree compiles and its strict parse does not throw on a `page.route` answer that has the key. After integration the take-off is a no-op; the handoff names it for a later tidy-up.

### 5.2 Frozen files and hooks

Frozen in stage D (no lane edits them; both read them): every `src/` file not in `ui`'s list except `src/projects/node/sidecar.ts`, in particular `src/projects/signal/layout.ts` (`DOCK_COLUMN_FRAME` stays 1200), `src/projects/sessions/model.ts`, `src/projects/FilterBar.tsx`, `src/projects/LiveStatus.tsx`, `dispatch/Rail.tsx`, `dispatch/derive.ts`, `src/projects/theme.css`, `src/projects/lists.css`; `tests/project-workflows/{mock.ts,seed.ts,support.ts,fixtures/index.ts,dispatch-app.ts,playwright.config.ts}` (`server/projects.test.ts` imports `seed.ts`) and every spec `ui` does not own (`panel.spec.ts:166`, which asserts the panel node's green badge, included); `docs/BACKLOG.md`. A failure there caused by a lane's change is fixed in that lane's own code.

- `ui` keeps every test id, class and accessible name stages A-C assert, except the ones this PRD changes (D3's allow-list at `revamp-pages.spec.ts:829` and its "More" assertion at `:493`, D4's card-top measure at `:487-489` and `:558-559`, D20's command literals at `dispatch.spec.ts:203` and `:209`, D21's Triage string at `revamp-lists.spec.ts:1469` and `:1485`), each changed in the same commit as the code. New seeds go only into `fixtures/sessions.ts` and `fixtures/dispatch.ts`, add-only, in projects and runs no existing assertion reads; a served state the seeds do not give is answered with `page.route` in both phases, and times use `page.clock`. A tagged test that walks several surfaces is `test.slow()` with untagged siblings (stage C [G21](b)).
- `backend` keeps every served field and route shape except D22's addition; `contracts/projects/triage.ts`'s exports keep their signatures. It writes the RUNBOOK and README lines for the CLI texts it changes (D27, D30, D31).

## 6. Requirements: lane `ui`

Each item: files, rule, acceptance, tests. "Both phases" means the worker and candidate phases of the project-workflows suite.

### D1 A reviewer's title row shows no green session badge (M10; triage A-5/B-20/C-38)

- Files: `src/projects/NodeHeader.tsx:181-183`.
- Rule: when `verdict` is non-null (the review node and `reviewer-<id>` nodes), do not render the toned `<StatusBadge status={status}/>` in `.node-title-row`; the session outcome stays muted in `node-verdict-outcome` (`:193`): "· session succeeded" on reviewer-general and reviewer-critique, "· session failed" on the failed-verdict reviewer (`server/sessions.ts` serves its session status as `failed`). If a badge must stay for layout it uses a neutral/idle class, never `status-succeeded`/`--ok`. Non-reviewer nodes are unchanged (`panel.spec.ts:166`). `li[data-status]` and the `node-verdict` test ids stay.
- Acceptance and tests: scenario `reviewer-tones` (sessions.spec.ts); a unit or browser check on a reviewer whose verdict word is `failed`.

### D2 A `failed` reviewer verdict is a fail everywhere (M10; A-6/B-21/C-39)

- Files: `src/projects/node/model.ts:385-386` (`reviewerLead`), `src/projects/RunView.tsx:163-171`, `NodeHeader.tsx` (`data-verdict`), `src/projects/StepStrip.tsx:50-51`, `:64-69`; seed in `tests/project-workflows/fixtures/sessions.ts` if none exists.
- Rule: `reviewerLead` returns tone `fail` and verdict `failed` for the word `failed`, matching `reviewerTone` (`sessions/model.ts:141`). The verdict type widens to `'approved' | 'blocked' | 'failed'`. The strip swaps the glyph (`STATUS_GLYPH.failed`), the aria word and the glyph class for every fail-toned reviewer verdict, not only `blocked`, and sets `data-verdict` to the verdict word; a reviewer with no verdict keeps `data-verdict='none'` (`reviewers.spec.ts:169`).
- Acceptance: `tests/unit/node.test.ts`: `reviewerLead({verdict:'failed',…})` gives tone `fail`, verdict `failed`; scenario `reviewer-tones`; stage A's blocked/approved assertions still pass.

### D3 The findings filter row: groups, one state choice, a "More" that says what it opens (M9; A-9/B-23/C-41)

- Files: `src/projects/node/panels.ts:267-275`, `src/projects/ReviewDetail.tsx:493-500`, `:145-151`; `tests/project-workflows/revamp-pages.spec.ts`.
- Rule: split the single `FilterToggles` row into several `FilterToggles` (each already `role=group`, `src/projects/ui/index.tsx:74-77`, which stays frozen), each with a visible label styled in `node/review.css` (state: Open P0/P1, Open only; severity; reviewer; lane). The state group is a single choice, so Open P0/P1 and Open only are never both on; the page still opens on Open P0/P1. "More" keeps its visible "More"/"Less" text; its accessible name starts with the visible word and says what opens (e.g. "More: rest of the message, files and fields"); `.finding-body` (`:151`) gets an id and `aria-controls` lists both the `finding-rest` id and that id. The `finding-more` test id stays (`lanes`, `inputs`, `clarity`, `critique` and `ux-review` specs click it). Keep `findingFilterIds`' return shape (`{blocking, severities, reviewers, lanes, open}`) and `filterFindings` as they are, because `tests/unit/panels.test.ts:182-209` (frozen) asserts them; split the row and make the state group one choice in `ReviewDetail.tsx` (`:493-500`) alone.
- **Amendment**: the visible-words allow-list at `revamp-pages.spec.ts:829` and the "More" assertion at `:493` are edited in the same change if a toggle text or label changes (section 9).
- Acceptance: scenario `findings-groups`.

### D4 Findings come before the review record (M22; A-10/B-22/C-40)

- Files: `ReviewDetail.tsx:436-486`, `src/projects/node/ReviewSections.tsx`; `revamp-pages.spec.ts:487-489`, `:558-559`.
- Rule: the verdict line, blocked-by and summary stay on top, then the findings (`review-findings`); the facts dl (reviewer session ids, reviewed at, bundle, diff) and the inline diff follow the findings. `ReviewSections`' figures and next-step block must not push the first finding's message below 900 px. The `review-result` test id, its `data-reviewer-count` and its reviewer entries stay rendered and visible, because frozen specs read them (`review.spec.ts:22-174`, `reviewers.spec.ts:31-215`, `clarity.spec.ts:136`, `:363`, `guardrails.spec.ts:114`, `sessions.spec.ts`); a closed disclosure is not used for anything those specs read. If the order cannot change without moving one of their assertions, the worker stops with a question naming the line.
- Tests: the M22/M9 tests measure the first finding's `finding-message` bottom, not the card top (main measured the card top at 893.6 px).
- Acceptance: scenario `findings-first-screen`.

### D5 A blocking finding wears the fail stripe (M9 defect; A-15)

- Files: `src/projects/node/review.css` after `:16-18`.
- Rule: `.projects-shell .finding-card.finding-blocking { border-left-color: var(--fail); }` after the `.sev-*` rules, so the blocking mark wins (DESIGN.md:297 already says so; no DESIGN.md change).
- Acceptance: scenario `findings-groups` (computed colour of the blocking P1 card is `--fail`'s; a non-blocking P1 keeps `--p1`'s).

### D6 Pins are shared across tabs (M20 defect; A-14)

- Files: `src/projects/pins.ts`; `tests/unit/lists.test.ts`.
- Rule: `add`/`remove` read-modify-write: re-parse `storage.getItem(PINS_KEY)` before computing the next list (memory fallback when storage throws). `pinStore()` adds a window `storage` listener for `PINS_KEY` that re-parses, replaces the list and notifies subscribers. Stage A [O10]'s rules stay: key `md-manager:triage-pins:v1`, at most 50, try/catch on every access.
- Acceptance: unit: two stores over one fake storage; A adds run 1, B (created earlier) adds run 2, storage holds both; removing run 2 in B keeps run 1; a storage event updates B's `list()` and calls its subscribers. A two-page browser check is optional.

### D7 A finding's head sentence survives common abbreviations (M9 defect; A-25)

- Files: `src/projects/findings.ts:100-113`; `tests/unit/node.test.ts`.
- Rule: never end the first sentence at a `.` followed by whitespace and a lowercase letter; extend `ABBREVIATION` with etc, approx, incl, Mr, Mrs, Ms, Dr, al.
- Acceptance: `splitFirstSentence('Values a, b, etc. are kept. Second.')` leads with "Values a, b, etc. are kept."; "Takes approx. 5 s here. Then more." leads up to "here."; the e.g./i.e./vs cases pass; lead + rest equals the message.

### D8 A partly failed project page states the 50-run cut (M3, stage C [O12]; B-7/C-42)

- Files: `src/projects/runFilter.ts:181-191` (`projectScopeLine` and its docblock); `tests/unit/lists.test.ts:990-1004`.
- Rule: when `read.unread !== null` and `more` is true: `'<k> of <n> runs · <unread> · the first 50 runs of each feature'`.
- **Amendment**: this is an eighth string in stage B [L21]'s closed set; the closed-set test adds it in the same change (section 9).
- Acceptance: `projectScopeLine({kind:'ready', unread:'1 feature cannot be read'}, 3, 60, true)` contains both clauses; with `more=false` it contains neither "first 50" nor "all loaded".

### D9 The project page's "Needs you and running" block follows the filter (M3; B-9/C-43) <!-- grill q2 -->

- Files: `src/projects/dispatch/ProjectPage.tsx:245-249`, `:301-331`.
- Rule (grill q2, answered `filter-with-count`): while `list.active`, filter `waitingRuns` and `runningRuns` with the same `matchesFilter`/`itemOf` the chart uses (`:126-131`), and the block heading shows `'<k> of <n>'` as Triage's sections do (`RunsHome.tsx:235`); `n` counts the block's runs before the filter. Classify against the unfiltered loaded list before filtering; the heading stays visible at zero matches, and an empty filtered block says "No run matches." once, never the plain all-clear (`dispatch-needs-none`, `dispatch-needs-clear`). Clearing the filter restores the block. Without a filter the block is unchanged; the rail's and the card's counts never follow the filter. Triage still lists every waiting run by default.
- Acceptance: scenario `filtered-lists`: with a text filter alone that matches exactly one of the block's runs, the block lists only that run and its heading reads '1 of <n>'; with q=fail and status Failed, the heading reads '0 of <n>', the block says 'No run matches.' exactly once and shows neither `dispatch-needs-none` nor `dispatch-needs-clear`; clearing the filter restores the block and its heading as on main; the rail's and the project card's counts are the same with and without the filter.

### D10 An `awaiting_approval` row says how long it has waited, without ticking (M7; B-12/C-45)

- Files: `src/projects/dispatch/stops.ts:85-91` (`runWhen`); `tests/unit/dispatch.test.ts`.
- Rule: for row time kind `updated` on an unfinished run, add a non-ticking wait clause from the run's last move: "started Oct 9 · awaiting approval since Oct 11" (`STATUS_LABEL`, `monthDay`). Never a growing span (M14). `lists.ts` `rowTime` is unchanged, so Triage rows keep "updated".
- Acceptance: unit: `runWhen` for an `awaiting_approval` run gives that form; identical text for two `now` values an hour apart on one day; finished, running and paused rows unchanged.

### D11 The dock bar ticks only while running (M14; B-30)

- Files: `src/projects/signal/dockWords.ts:45`; `tests/unit/signal.test.ts`.
- Rule: `for <span>` only when status is `running`; any other unfinished status (`awaiting_approval`, `pending`) gives a non-ticking "since <Mon D>" from `runningSince` with the status word, matching M14's stopped wording.
- Acceptance: unit: `{status:'awaiting_approval', runningSince: 4 days before}` gives `since` without "for ", identical for clocks an hour apart; running still gives "for <span>"; paused, interrupted and finished unchanged.

### D12 A filtered Triage says "No run matches." once (M3; B-13/C-44, narrowed)

- Files: `src/projects/RunsHome.tsx:268-269`, `:317-318` and the Recent section's `:470` (sub) and `:477` (`NoMatch`).
- Rule: each empty filtered section says "No run matches." once (keep the `NoMatch` body; the sub shows the order words or nothing). The jump-link counts stay as they are (operator call: a count k beside a heading "k of n" does not contradict it); making them follow the heading is optional polish.
- Acceptance: scenario `filtered-lists` (Triage clause).

### D13 Back to a run page restores its scroll (M17; B-27/C-48)

- Files: `src/App.tsx:459-467`.
- Rule: set `history.scrollRestoration = 'manual'` only on Projects list levels (`projectsRoute?.level` in triage, project, workflow, projects), so run and node pages keep the browser's `auto` restoration. Every other Projects history behaviour and `onNavigate(pathname)` stay byte-identical; stage B's keep-search unit test stays green.
- **Amendment**: stage C [O20]'s freeze of App.tsx's Projects history is lifted for this change only (section 9).
- Acceptance: scenario `back-to-run`; stage B's list-level Back-restore tests in `revamp-lists.spec.ts` pass.

### D14 A feature header's state word is the feature's, not the filter's (M7; B-35/C-49)

- Files: `src/projects/dispatch/StepChart.tsx:159-176`, `:201-208`; `ProjectPage.tsx:107-116`, `:130`; `tests/unit/dispatch.test.ts`.
- Rule: `FeatureGroup` gains `outcome: string | null`, the latest unfiltered run's word, computed in `ProjectPage.tsx` before the filter (like `rank` at `:114`); `stateWord` uses `group.outcome`.
- Acceptance: scenario `filtered-lists`; a unit test: latest run succeeded, filtered to Failed or to nothing, header says "succeeded", never "no runs"; unfiltered output unchanged.

### D15 The dock keeps its column through a scrollbar (M8; B-47/C-47)

- Files: `src/projects/signal/SignalRun.tsx:68-80`, `:112`.
- Rule: hysteresis on the column decision: switch to column at a run frame >= `DOCK_COLUMN_FRAME` (1200, `layout.ts:199`, unchanged); once in column mode stay there until the frame is under `DOCK_COLUMN_FRAME - 24` (1176, the same 24 px scrollbar allowance as stage B [L30]).
- **Amendment**: this amends stage B [O13]'s 1200 px column rule; DESIGN.md:242 changes with it (sections 8 and 9).
- Acceptance: scenario `dock-column-hold`.

### D16 The resume command's Copy button stays on its row on node pages (M21; B-48)

- Files: `src/projects/sessions/sessions.css:92`.
- Rule: scope the rule inside `@media (max-width: 1360px)` to the table (`.ss-row .ss-resume-cmd { flex-basis: 100%; }`), so `SessionBlock`'s `ResumeCommand` on node pages keeps the base `flex: 0 1 auto` (`:43`).
- Acceptance: scenario `resume-copy-row`.

### D17 The narrow step chart lays out run rows (C-8)

- Files: `src/projects/dispatch/dispatch.css` under `@container dispatch-chart (max-width: 640px)` (`:146`), `StepChart.tsx:103-134` if needed.
- Rule: `.dispatch-run-when` (`:126`) may wrap; the run id gets its own line or the row's width, never a 2-3 character column; the landing note wraps inside the chart (`min-width: 0`, `overflow-wrap`). No new breakpoint; stage C [L1]'s short axis forms, count-only cells and legend stay.
- Acceptance: scenario `narrow-chart-rows`.

### D18 A non-git project says so once (M31; C-10)

- Files: `src/projects/dispatch/ProjectsPage.tsx:51-55`, `:76-80`; `src/projects/dispatch/GithubColumn.tsx:84-88`, `:116`, `:140`, `:171`.
- Rule: when `git?.status === 'unavailable'` the card foot renders no GitHub not-read text (the git line gives the reason); the project page's Local and GitHub card follows the same rule. Key every site on `git?.status === 'unavailable'`, never on the GitHub reason (the worker mock serves 'git is unavailable', `fixtures/dispatch.ts:455`; the server 'git not read', `server/dispatchGithub.ts:29`): `ProjectsPage.tsx:79` and `GithubColumn.tsx:116`, `:140` and `:171`. `not_github` keeps "no GitHub remote" once; other not-read reasons keep "GitHub not read: <reason>" (stage C [G7]).
- Acceptance: scenario `github-once`.

### D19 While the overview loads, cards say "reading", not "not read" (M1; C-19)

- Files: `ProjectsPage.tsx:30`, `:76-80`, `:94-96`, `:110-114`.
- Rule: pass the overview's loading state (`repositoryCount === null`) into `Card`; while loading, the foot reads "GitHub: reading…" and the meta line leaves out "GitHub not read"; a failed or unread overview (`repositoryCount === 'failed'`) keeps "GitHub not read: <reason>". Props of `ProjectsPage` unchanged.
- Acceptance: scenario `github-once`.

### D20 The step chart's status command runs as written (K-3)

- Files: `StepChart.tsx:281`, `:295`; `tests/project-workflows/dispatch.spec.ts:203` and `:209`.
- Rule: show `python -m workflow status <runs root>/<run-id> --by operator`, the run id filled in, the runs root a named placeholder (the served project has no `runs_root`; `workflow/pipeline.py:1480` takes a directory). The literals at `dispatch.spec.ts:203` (`DISPATCH_WIDGETS`' `broken` feature, run `broken-001`, `fixtures/dispatch.ts:756`) and `:209` (`DISPATCH_TRIO`'s `trio-locked`, no run id) change with it.
- Acceptance: scenario `narrow-chart-rows` (command clause); the reviewer fills the placeholder for a real run under `~/.local/state/md-manager-workflows` and gets exit 0.

### D21 Triage's scope line says what it read (M3, stage C [O12]; B-33) <!-- grill q3 -->

- Files: `src/projects/runFilter.ts:161`; `tests/unit/lists.test.ts` (the closed-set scope-string test at `:985-1007`, and `:869`, `:982-983`); `tests/project-workflows/revamp-lists.spec.ts:1469`, `:1485`.
- Rule (grill q3, `reword-scope`): keep the home route's assembly as stage C [O15] fixed it, and reword Triage's scope line to exactly '<k> of <n> runs · runs updated in the last 7 days and the 50 most recently updated runs of each feature' (never 'latest 50' or 'first 50 runs' on Triage: the read is by updated_at). Triage's "All time" view already reaches every run.
- **Amendment**: changes the Triage string stage B [O11] fixed and stage C [O12] carried, and stage B [L21]'s closed set (section 9).
- Acceptance: a unit test pins that string. The closed-set test (`lists.test.ts:985-1007`) lists it and rejects any Triage string containing 'live runs', 'finished in the last 7 days', 'latest 50' or 'first 50 runs', and any string claiming the default view holds every unfinished run; D8's project-page string stays in the set. `lists.test.ts:869` and `:982-983`, and `revamp-lists.spec.ts:1469` and `:1485`, assert the new clause.

### D22 (client half) The run lists say which runs cannot be read (GH12; C-34) <!-- grill q4 -->

- Files: `src/projects/api.ts` (section 5.1), `src/projects/ProjectsView.tsx` (feature page, the run list at about `:446`, `empty-runs` at `:500`), `ProjectPage.tsx` (under the feature's runs; `unreadFeatures` at `:136`).
- Rule (grill q4, `per-run-errors`): when the run list carries `errors`, the feature page shows its readable runs and one line "<n> run(s) cannot be read: <run ids>" under the list; the project page shows the same line for that feature. When `runs` is empty and `errors` is not, the feature page shows the line in place of `empty-runs`, never "No runs have been recorded…" or an empty list. The line is not a run row (no `li` in `run-list`, no `data-run-id`), and the scope line and run counts count served rows only. On the project page, a workflow whose run list carries a non-empty `errors` counts as a feature that cannot be read, exactly as a failed list does (`unreadFeatures`, `ProjectPage.tsx:136`), so `dispatch-needs-unread` and `projectScopeLine`'s "<n> feature(s) cannot be read" still show and the needs block never shows the plain all-clear for it; `dispatch-sections`' candidate branch (`dispatch.spec.ts:655-665`, Widgets' `broken`/`broken-001`) passes unchanged against both today's server (the list fails) and the integrated one (the list is served with `errors`). On the project page the line names only run ids that the chart's steps-error rows (`StepChart.tsx:289-296`) do not already name, so no run is called unreadable twice. Without the key both pages are as on main. The server half is section 7, D22. For the project page's read state, a workflow whose list is `runs: []` with non-empty `errors` counts as a failed list too: in ui-owned code (`api.ts`'s `fetchWorkflowRuns` or `ProjectsView.tsx`), give its `WorkflowRuns` a non-null `error` built from the first entry's code and message, and keep `errors`, so `everyRunListFailed` (`src/projects/dispatch/derive.ts:117`, frozen; called at `ProjectsView.tsx:179`) reads it as failed.
- Acceptance: scenario `unread-runs` (page.route in both phases).

### D32 A running run whose controller is gone needs the operator on every list (M2/[O4]; A-16/C-25) <!-- grill q1 -->

- Files: `src/projects/lists.ts` (`classifyRuns`, `recordHomeReadings` at `:627`), `src/projects/ProjectsView.tsx` (the home poll at `:149-151`, the rail badge at `:217`, the feature page's classes at `:280`), `src/projects/RunsHome.tsx:195-196`, `:519`, `src/projects/dispatch/projectModel.ts:26`, `:79`, `ProjectPage.tsx:93`; `tests/unit/lists.test.ts`.
- Rule (grill q1, `client-readings`): `ProjectsView` keeps a readings map across list polls with `recordHomeReadings`, fed by the served `activity.controller` of each listed run. `classifyRuns` gains an optional second argument (the run keys whose controller has read `not_running` for at least `CONTROLLER_DEBOUNCE_MS`, 15 s, by `controllerNotRunning`), default empty, so every caller that does not pass it behaves as today. A latest run with status `running` whose key is in that set classifies `needs: 'interrupted'`; `null`, `unknown`, malformed or stale readings, or fewer than 15 s of `not_running`, leave it under Running (fail toward today's behaviour); a later reading of `running` (or the run finishing) moves it back under Running on that poll. Triage, the rail and card counts, the tab title and the project and feature pages pass the set. The wording is the run page's ("controller not running", next step "resume the run on the run page"). No contract or server change; stage A [O13]'s "status alone never puts a run in Needs you" still holds, because a debounced served controller reading is not status alone.
- Acceptance: unit (`tests/unit/lists.test.ts`): `classifyRuns` with a running latest row and a 15 s `not_running` reading gives `interrupted`; one reading, `unknown` and `null` do not; a non-latest running row is never moved; after a qualifying 15 s `not_running` pair, a later `running` reading leaves the row under Running; for the same running row (no attention) and the same readings, `classifyRuns` gives `interrupted` exactly when `servedDisagreement` gives 'controller-stopped' (one test over identical inputs). Scenario `triage-controller-stopped`.

## 7. Requirements: lane `backend`

### D22 (server half) One unreadable run no longer fails its workflow's list (GH12; C-34) <!-- grill q4 -->

- Files: `server/projects.ts:1119-1157` (`listRuns`, `listRunEntries`), `server/projectRoutes.ts:145`, `contracts/projects/v1.ts:941`, `contracts/projects/runList.schema.json`, `contracts/projects/examples.ts`, `contracts/projects/contract.test.ts`, `server/projects.test.ts`.
- Rule (grill q4, `per-run-errors`): catch `ProjectApiError` from `projectRun` (`:1149`) and the duplicate-id throw (`:1154`) per run; serve the readable runs and the frozen optional `errors` list of section 5.1 (the home route's `unreadable` pattern, `server/dispatch.ts:142`); an entry's `run_id` is the run's directory name, even when its recorded id differs. Workflow- and storage-level failures keep today's behaviour. The run detail route keeps its own error. Only the per-workflow route (`server/projectRoutes.ts:145`) changes: `listRuns`/`listRunEntries` are also read by the home route (`server/dispatch.ts:206`), All time (`:229`) and the spend figure (`:280`), which keep today's behaviour (a workflow with an unreadable run stays an `unreadable` entry, or is skipped for spend), so the per-run catch goes in a variant the per-workflow route alone calls (for example `listRunEntries(scope, { collectErrors: true })`). <!-- grill q4 --> `server/dispatchSteps.ts:9-13`'s note is updated if it no longer holds.
- Acceptance: `server/projects.test.ts`: a workflow with two valid runs and one whose `run-state.json` names a different `run_id` lists the two (200) with one `errors` entry; a duplicate run id gives exactly one served row with that id and exactly one errors entry for it (run directories alone cannot produce a duplicate, because `projectRun` refuses a run_id that differs from its directory, `server/projects.ts:1506`; reach the branch in the test by overriding `projectRun` on the store instance so that two directories return one run_id, never by changing production code); a workflow with no bad run serves no `errors` key; the answer parses with `schemas.runList`. `server/dispatch.test.ts`: the home route still serves that workflow as an `unreadable` entry. Contract test: an example with `errors` parses and one with an extra key in an entry is refused.

### D23 "Relaunch by the operator" is an action row, not a block (RLI16; K-4)

- Files: `contracts/projects/triage.ts:285`; `tests/unit/triage.test.ts` (beside `:451`).
- Rule: `ACTION_ROW` gains `Relaunch`: `/^(?:Start|Automatic|Retry|Reconcile|Approve|Resume|Relaunch) by the (?:operator|maintainer)\b/`, covering `RUNNING_ROWS` (`:296`) and `CONTROLLER_LANE_ROWS` (`:298`).
- Acceptance: a run whose timeline holds "Relaunch by the operator: game: archived …; launching it once" (status null, as served) has no `controller_blocked` marker, its situation is not `blocked_before_freeze`, and its next step is not the new-run launch command.

### D24 "Panes not attached" is a launch note, not a block (RLI19; K-5)

- Files: `contracts/projects/triage.ts:296`, `:298`; `tests/unit/triage.test.ts`.
- Rule: `PANES_NOT_ATTACHED = /^Panes not attached \(/` joins `RUNNING_ROWS` and `CONTROLLER_LANE_ROWS` beside `LAUNCH_NOTES` and `TRYOUT_ROW` (the note is `workflow/pipeline.py:1101`).
- Acceptance: a running run with "Panes not attached (…); the workers run. Attach each lane with: …" has no `controller_blocked` marker; after a later `launch_<lane>` failure row the headline and reason quote the lane's row, not the note.

### D25 Archived launch sessions stay listed (RLI16; K-7)

- Files: `server/sessions.ts:610-633` (`workerRows`); `server/sessions.test.ts`.
- Rule: also read each `<lane>.launch-<n>.receipt.json` (n ascending, `workflow/interactive.py:1009` writes them) and emit one ended row per archive before the lane's current row: key `worker:<lane>:launch-<n>`, label "Worker · <lane> (launch <n>)", its session id and resume line, status from the archived receipt. The Sessions contract is unchanged unless a field must be added; if one must, it is optional and added in `contracts/projects` with its test.
- Acceptance: a run directory with `ui.launch-1.receipt.json` (session A) and `ui.interactive.json` (session B) serves two worker rows for `ui` with ids A and B; without an archive the output is unchanged.

### D26 `enter_not_submitted` (RLD18; C-27/E-5) <!-- grill q5 -->

- Files: `contracts/workflow/sidecar.schema.json:129-130`, `contracts/projects/v1.ts:504-507` (`SIDECAR_MESSAGE_REASONS`), `contracts/projects/sidecarLedger.schema.json` (~`:383`), `src/projects/node/sidecar.ts:22-35` (`REASON_WORDING`: "Enter did not submit it; the text is still in the input line"), `workflow/sidecar.py:770`; `workflow/test_sidecar.py`, `tests/unit/sidecar.test.ts`.
- Rule: a typed message whose two Enters were swallowed is recorded `('undeliverable', 'enter_not_submitted')`; `pane_busy` stays for a busy input before typing (`:757`). Every file lands in this one lane (grill q5), so no half contract ships (stage C [G15]).
- Acceptance: test_sidecar: a fake Herdr that swallows both Enters records undeliverable/`enter_not_submitted`, the record validates against `sidecar.schema.json`, and the pane attention record is written; busy input before typing still records `pane_busy`; the contracts' schema-drift tests pass; a unit test of the node sidecar wording gives the new label.

### D27 `workflow note` says the text is still in the input line (RLD18; E-1)

- Files: `workflow/notes.py:82-92`, `:136-138`; workflow tests.
- Rule: when the text was typed but not submitted (the collected `unsubmitted`, or the new reason), print "Blocked: note <id> to <lane> was typed but Enter did not submit it; the text is still in <lane>'s input line. Submit or clear it in the pane; do not send it again." Not-typed and refused notes keep today's text.
- Acceptance: with a fake Herdr that swallows both Enters, `workflow note` exits 1 and stderr contains "still in" and "Submit or clear it in the pane; do not send it again." and neither "was not typed" nor the old instruction "Look at the pane, then send it again as a new note." (the new message's own "do not send it again" is required, not rejected); a refused or not-typed note keeps today's message.

### D28 A disk-killed check records `transient: 'disk'` (RLG24; C-28/E-6)

- Files: `contracts/workflow/workerResult.schema.json:89-92` (enum `['memory','disk']`), `contracts/workflow/v1.ts:41` (`z.enum(['memory','disk']).optional()`), `workflow/checks.py:488-495`, `:589`, `workflow/repair.py:90-99`, `:154-157`; `server/projects.test.ts` (parse case).
- Rule: write `disk` when the retained log tail matches `repair.DISK_SIGNATURES` (memory takes precedence) and include disk-killed checks in `transient_checks`; `repair.py` reads the recorded value, keeping the log fallback for older packets, and its comment at `:90-91` is corrected.
- Acceptance: test_checks: a check whose log ends "No space left on device" records `disk` and the packet validates against `workerResult.schema.json` and `validateWorkerResult`; test_repair: such a packet is transient and does not count toward the identical-failure rule; a server test parses a packet with `transient: 'disk'`.

### D29 The panel budget default is documented as the controller applies it (RLD20; C-29/E-7)

- Files: `contracts/workflow/feature.schema.json:395-400`, `contracts/workflow/README.md:12`.
- Rule: drop the single `"default": 5` (or keep a description only) and state the conditional rule: 25 when any provider uses the claude transport, else 5, informational for pi (`workflow/panel.py:70-74`, `:172-173`; [O8], the operator's approval of the Claude panel budget). No `default: 25`.
- Acceptance: `contract.test.ts` and the workflow schema tests pass; schema and README text match `panel.py`; test_panel's default assertions unchanged.

### D30 `relaunch` says what it archived when the launch fails (RLI16; C-31/E-3)

- Files: `workflow/interactive.py:1023-1031`; `workflow/test_interactive.py`.
- Rule: a flag set inside `archive()` once the renames and the action event are done; when set, the except branch prints "Blocked: <error>\nArchived <a> as <b>; the launch did not complete and <lane>.interactive.json is needs_reconciliation. Continue with: <python> -m workflow reconcile <run> --by operator". Refusals before `archive()` keep "Nothing was relaunched." (`server/controls.ts:745` relays the first "Blocked:" line; no server change).
- Acceptance: with a fake claude whose `--bg` exits non-zero after the archive, relaunch exits 1, stderr has no "Nothing was relaunched", names the archived files and the reconcile command, and the archive files exist; a refusal before the archive (dirty worktree, live session) still prints "Nothing was relaunched.".

### D31 `retry --all-failed` refuses on a pending interrupt like single-lane retry (RLG24; C-30/E-4)

- Files: `workflow/pipeline.py:2076-2079`; workflow tests.
- Rule: run the single-lane retry's pending-interrupt guard before the `--all-failed` dispatch, so both refuse the same way with the same exit code (operator call: harmless today, but [O9] names the relayed engine P2s).
- Acceptance: a test seeds a pending interrupt and asserts `retry --all-failed` refuses with the guard's message and exit code and writes nothing.

## 8. DESIGN.md amendments (lane `ui` writes them, [O5])

- **Run page (`DESIGN.md:242`)**: "When the run frame is 1200 px wide or wider the dock is a 312 px column …" gains: "once a column, it stays one until the frame is under 1176 px, so a scrollbar appearing after load does not flip it" (D15).
- **Lists, rails, rows… paragraph (`:297`)**, appended: "A reviewer's verdict leads its node; the session's outcome is muted metadata, never a green badge." "The findings filter groups its toggles under visible labels (state, severity, reviewer, lane); the state is one choice." "A review page shows the verdict, blocked-by and summary, then the findings; the review record's facts follow them." "A running run whose controller has been seen stopped for 15 s needs the operator, as on its run page." "A list that could not read some runs says which, under the runs it read."
- No token, colour, spacing or phone change. The fail-stripe sentence at `:297` already holds (D5 restores it in code).

## 9. Amendments to prior decisions (each made in the same change as its code)

- **Stage B [L21]'s closed set of scope strings**: D8 adds the 50-run clause to the partial-read string, and D21 rewords Triage's string <!-- grill q3 -->; the closed-set unit test is updated in the same change. Justified by stage C [O12] ("every surface states its actual scope"), reopened by [O9].
- **Stage B [O13]'s 1200 px column rule**: D15 adds hysteresis (column from 1200 px, overlay only under 1176 px); the threshold constant stays.
- **Stage C [O20]'s freeze of App.tsx's Projects history**: lifted for D13's `scrollRestoration` change only.
- **M9's "More" rename**: edits the allow-list at `tests/project-workflows/revamp-pages.spec.ts:493` and `:829` in the same change (D3).
- **Stage C [G15]** (a served `situation` field and the engine's `contracts/workflow/` items deferred): the contracts items land in D26, D28 and D29 with their writers; the served field stays deferred, D32 reads `activity.controller` instead <!-- grill q1 -->.
- **Stage C [G17]** (GH12's blast radius unchanged for the per-workflow route): replaced by D22 <!-- grill q4 -->.

## 10. Risks

- **D22 crosses lanes** <!-- grill q4 -->: the field is frozen in 5.1; the ui worktree reads it before the strict parse. If the backend lane cannot serve the exact shape, it stops with a question rather than changing it. D22 turns the integrated candidate's Widgets `broken` feature from a failed list into a list with errors; `dispatch-sections` reads it (D22's client rule keeps it counted as a feature that cannot be read).
- **D32 changes Needs you counts**: a stale or flaky controller reading could move a run; the 15 s debounce and the fail-to-Running rule bound it, and the existing seeds without controller readings must keep every count (stage A-C scenarios stay green).
- **revamp-pages.spec.ts and revamp-lists.spec.ts carry stage A-C assertions**: `ui` changes only the lines this PRD names; any other moved assertion is a stop-with-question.
- **One browser suite plus the workflow suite and the critique app on a 4-core host**: the browser check keeps 2400 s and workflow-unit 3600 s; a kill that coincides with memory starvation is retried after memory, never fixed by skipping a check (stage C [O8]).
- **Known flakes** (`controls-unavailable`, `attack-section`, `run-now-banner`, `panel-section`): reported, not edited.
