# The run page as the Signal Box design builds it (2026-10-09)

The operator's redesign of the run page (direction 4, "Signal Box Live", chosen on 2026-10-09 over the Calm layout of
docs/PRD_VIEWER_UX.md 4.2 and docs/PRD_VIEWER_REVAMP.md 5.3): the run's graph is the page, a live dock holds the situation
and the next command, and a step opens in a sheet. Built directly on branch `feature/signal-box-live` (no workflow run);
the code lives in `src/projects/signal/`, the tokens in `src/projects/theme.css`, the look in `DESIGN.md`. This page is the
reference for the specs under `tests/project-workflows/` and for any follow-up run that touches the run page.

## What changed

The run page (`/projects/<p>/workflows/<w>/runs/<r>`) is now **the graph as the page** (`src/projects/signal/`):

1. **Identity line** `header[data-testid="run-header"]` (`src/projects/signal/IdentityLine.tsx`): the run id (`h2#run-summary-title`,
   mono), the status (`p[data-testid="run-status"]` with `.status-badge[data-status]` and `span[data-testid="run-status-meaning"]`,
   which says `needs you: a question waits` / `… a pane needs attention` / `… an approval waits` when the run waits, else the
   old short status wording), the `Untried` chip (`untried-chip`), the feature title (`p[data-testid="run-title"]`, ellipsized,
   full text in `title`), the pinned definition (`span[data-testid="definition-current" | "definition-changed" | "pinned-definition"]`,
   text `definition <short sha> · current|changed since`; on a phone only a changed definition stays visible), the live chip (`live-status`) and the Local/UTC toggle, a pill link to
   the other view (`a[data-testid="tab-assignment"]` "Assignment" on the run page; `a[data-testid="run-graph-link"]` "Run graph" on the
   Assignment page), and a closed `<details data-testid="run-details">` holding everything else: `inputs-none`, the facts
   `dl[data-testid="run-inputs-facts"]` (Feature, Source branch, Base commit, Mode, Deadlines `dd[data-testid="run-deadlines"]`,
   Permission mode, Finish, Pinned definition, Created, Export updated). **`run-inputs-facts` and `run-deadlines` are only
   visible after opening Details** (`openRunDetails(page)` in `support.ts`). There is no `run-span` in the header any more
   (the dock's figures carry `run-span`, see below), no `run-lanes`, no `run-deadlines` chips on the first line.
2. **No tabs on the run page.** `role=tablist "Run views"` exists only on the Assignment page and the node pages. The run page's
   `a[data-testid="tab-assignment"]` navigates to `/assignment`; the Assignment page's `a[data-testid="run-graph-link"]` leads back
   (its tablist also still has `tab-run`/`tab-assignment` buttons).
3. **The stage** `div[data-testid="run-stage"]` inside `div[data-testid="run-board"]` (`RunStage.tsx`): a pan/zoom canvas
   (`data-direction="LR"` on a desk, `"TB"` under 720 px stage width; `data-level` 0 = overview chips, 1 = standard, 2 = full).
   Cards: `div[data-testid="workflow-graph"] > button[data-graph-node="<id>"]`, one per definition node (repair nodes
   included), with `data-node-id`, `data-status` (the shown status), `data-tone` (ok|run|warn|fail|pause|idle), `data-attention`
   (question|pane|approval when the step waits), `data-executor` (agent|verifier|controller), classes `node tone-<tone>
   exec-<executor> is-agent|is-controller is-<status> [attn] [now] [is-selected]`, `aria-current="true"` while its sheet is open,
   and an accessible name `"<label>, <kind>, <status word>[ · needs you], attempt <n>[, <round line>], executed by <executor>[,
   lane <lane>][, <duration>]"` (a repair node's kind reads `repair`) (e.g. `Launch UI worker, worker, succeeded, attempt 1, executed by agent session, lane ui, 2m05s`).
   Edges: `svg.sb-edges path[data-edge="from>to"]` (`.todo` to a pending step), return marks `path[data-return="repair-n>step"]`.
   `graphNode(page, id)` in `support.ts` still resolves a card. Keyboard: arrows walk, Enter opens, +/−/0 zoom/fit, Escape closes.
   Controls bottom right: `button "Legend"` (toggles `ul[data-testid="graph-legend"]`), `span[data-testid="stage-level"]`,
   `button[aria-label="Zoom out" | "Fit the graph" | "Zoom in"]`. The stage fills the window under the identity line (the frame
   is sized to the viewport); the page itself does not scroll on a desk.
4. **The live dock** `section[data-testid="live-dock"][data-open]` top left on the stage (`LiveDock.tsx`): its bar
   `button[data-testid="live-dock-bar"]` (aria-expanded; the step the run is at, its word, "for <span>") folds the body. The body
   holds, in order: the **Now banner exactly as before** (`section[data-testid="run-now"][data-situation]`, `now-headline`,
   `now-reason`, the More button, the "Open <step> ›" link `a[data-testid="now-open"]` which now centres the step on the stage
   and opens its sheet instead of leaving the page, and the command block: `now-next[data-action]`, `command-run`,
   `run-dir-command`, `copy-run-dir`, `now-step[data-kind]`, `now-command`, `copy-command`, `now-all-steps`, `command-legend`,
   the caption); **Latest events** `ul[data-testid="live-dock-events"] > li > button.lv-row[data-go=<node>]` (newest first, at
   most five; a controller row is a span, not a button); **figures** `dl[data-testid="live-dock-figures"]` with `Ran`
   (`dd[data-testid="run-span"]`: a duration like `3h20m`, or `not recorded`), `Spent` (always `not recorded`: the export carries
   no cost the viewer reads) and `Deadlines` (`worker 4h · review 30m` from the inputs, else `not recorded`); and a source line.
   The dock is open by default (remembered in `localStorage` key `mdm.projects.liveDock`); on a phone it folds when a step opens.
5. **The step sheet** `aside[data-testid="node-sheet"][data-node-id]` (`NodeSheet.tsx`) opens when a card is clicked or Enter is
   pressed on it (docked right, 440 px; a bottom sheet under 720 px). Sections: `h3#sb-sheet-title` (label), `sheet-status`
   (glyph + word), kind · executor, the id in `<code>`; "What it did" `p[data-testid="sheet-did"]`; "Facts" `dl[data-testid="sheet-facts"]`
   (Attempt, Lane, Started, Duration|Running for, Models as `<model> · <effort>` from the pins, Round); "Command" (the full command block, same test ids as the
   banner, **only on the step the Now focus names**; else "No command is recorded for this step; the run waits elsewhere.");
   "Reviewers" `sheet-reviewers` and "Findings, n blocking of m" `ul[data-testid="sheet-findings"] li[data-disposition]` with
   `.ui-sev` chips (review node only; `Show all n` past six); "Repair" `section[data-testid="sheet-repair"]` (repair nodes: Trigger,
   Round, Recorded, Applied, Workspace, Left behind, files it fixed, gate reasons); "Questions to you" `sheet-questions`
   (workers that asked); run-level records the step owns: the **attack pass** section `section[data-testid="attack-section"]`
   lives in the attack node's sheet and the **panel** section `section[data-testid="panel-section"]` in the review node's sheet
   (both unchanged inside); "Events, n" `ul[data-testid="sheet-events"]` newest first; and the footer link
   `a[data-testid="sheet-open-page"]` "Open step page" to `/nodes/<id>`. Close: `button[aria-label="Close step details"]`.
   Helpers: `openStepSheet(page, id)`, `openStep(page, id)` (sheet → node page) in `support.ts`.
6. **Removed from the run page**: the Steps table (`run-node-list` with `tr[data-node-id]`, `.step-outcome`, `.step-bar-segment`,
   `steps-phase`, `node-hint`), the Activity list (`run-timeline`, `activity-group`, `activity-order`, `activity-expand`,
   `activity-controller-log`, `activity-more`, `activity-raw`), the lanes line (`run-lanes`, `lane-chip`, `lane-rounds`), the
   old `run-pipeline` section and `run-board[data-layout]` split, the header card (`run-header` is now the identity line) and its
   `run-span` text ("started … · running …"). The **node pages are unchanged** (RunBar, tabs, the step strip
   `ol[data-testid="run-node-list"]` with `.step-chip`, `node-detail`, everything inside), as is the Assignment panel.
7. **Tokens**: the shell's tokens were retoned (warm grey ground, violet accent, the same six tones and three severities, all
   ≥ 4.5:1 on their soft pairs in both schemes) and the faces are now **Atkinson Hyperlegible Next / Mono, self-hosted** from
   `/fonts/*.woff2` (`@font-face` in `src/projects/theme.css`); no request leaves the host. `--focus` inside the shell is the
   accent (the app-level orange no longer applies to Projects controls). Status words on cards are lower case.

## Writing a spec against it

- Keep the scenario's intent and its `[scenario:<id>]` title. Where the UI moved, assert the same fact on its new element
  (the Now banner inside the dock, the sheet instead of the Steps row, Details for the pinned facts, the dock's `run-span`).
- Where the feature was **removed** (Steps table, Activity, lanes line, tabs on the run page), delete the assertions that
  checked it and, when a test only tested a removed feature, replace it with the nearest check on the new page (for example
  the Steps row's start/duration/attempt now live on the card's accessible name and the sheet's Facts; the Activity's latest
  rows live in the dock's `live-dock-events`). Say in your report which assertions you dropped and why.
- Opening a node page from the run page: `await openStep(page, id)` (replaces `nodeListItem(page, id).getByRole('link').click()`
  and clicking a graph node, which now opens the sheet). Coming back from a node page returns the focus to the card.
- Clicking a card with `.click()` can fail when the dock or the sheet overlaps it; `openStepSheet` dispatches the click. To
  check a card's state use its attributes (`data-status`, `data-attention`, `data-tone`, classes) and its accessible name.
- Phone tests (390 px): the stage lays the flow top to bottom; the dock opens over the stage and folds when a step opens; the
  sheet is a bottom sheet; `document.documentElement.scrollWidth` must stay ≤ 390.
- Do not loosen a check that still holds (counts, exact texts, read-only guarantees, no overflow, contrast).
