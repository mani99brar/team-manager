# Handoff: UX fixes, stage B, lane `run`

The run page opens readable, says when a run stopped, announces its sessions, opens the page "Open" names and shows the branch
instead of the definition hash. Findings M8, M14 (the dock), M21, M23 and M33; DESIGN.md carries every amendment of PRD 8.

## What changed, per finding

- **M8 The graph opens readable.**
  - `signal/layout.ts`: pure `fitView` (first view: whole fit clamped to [0.6, 1.4], placed on the step the run is at, else the
    first step, wholly inside the part right of the reserve; "Fit the graph" is `first: false`, 0.15 to 1.4), `dockReserve`
    (0 from a 1200 px frame, 336 px under it while the dock is open), `DOCK_COLUMN_FRAME` and friends.
  - `signal/RunStage.tsx`: the first view is fitted on mount, when the stage's width changes (also when the cue arrives or goes)
    and when the graph's shape changes; a height change alone does not re-fit. A first view the operator has not touched also
    moves onto the step the run is at when it arrives with the page's later reads. A phone keeps its fit on every size change.
    The world sits in an `.sb-viewport` (absolute, `overflow: hidden`) so the stage's `scrollWidth` never exceeds its
    `clientWidth` even when the graph is wider than the stage. Overview chips: `--inv` capped at 2.4, smaller type, labels wrap
    (`overflow-wrap: anywhere`), a label over 18 characters reads `shortStepLabel` (the accessible name keeps the full label).
  - `signal/SignalRun.tsx`: the dock is a child of the run frame (`run-board`), no longer of the stage. The frame is a grid; from
    a measured `clientWidth` of 1200 px the dock is a 312 px column left of the stage (`data-dock="column"`), under it an overlay
    (`data-dock="overlay"`). The frame's width comes from a `ResizeObserver`, never from the viewport.
- **M14 The dock's words.** `signal/dockWords.ts` (pure): running "for <span>", paused / interrupted "paused 12 d (since Oct 2)"
  through `stoppedLabel`, finished "<outcome> <age> · ran <span>", accepted keeps "integrated (operator override)" and adds only
  "<age> · ran <span>". The helper returns the word that replaces the step's word and the since text. `LiveDock.tsx` reads
  `useTimeZone` and the `clock` prop only; no timer added.
- **M21 Sessions.** `a[data-testid=sessions-cue]` directly under `run-stage` in the frame (`sessionsCueText` in
  `sessions/model.ts`); the frame's height subtracts its rendered height (floor 420 + cue). The frame now follows the identity
  line's height (a `ResizeObserver` on the frame's parent) and ends 4 px above the window's bottom (was 8). The cue scrolls to
  and focuses `h3#sessions-title` (`tabindex=-1`), URL and history untouched. `Sessions.tsx`: the Sessions section is a
  compact table (`ul[role=table]`, `li[role=row].ss-row`, `data-fact` cells), one line a row at 1440 px; a Claude row has Copy
  and a `Show command` / `Hide command` toggle (`session-resume-toggle`) that reveals `session-resume-command`. Under 1100 px a
  row reads as one column with each fact prefixed by its name (the grid's columns would scroll the page sideways at 780 px);
  controls are 44 px at 720 px and under.
- **M23.** `NowBanner.tsx`: "Open <step> ›" always navigates through `onNavigate`; in the dock `button[data-testid=
  now-show-in-graph]` "Show in graph" does what Open did.
- **M33.** `IdentityLine.tsx`: `definition current` / `definition changed since` / `pinned definition` without the hash (the
  revision is in the title and in Details); `span[data-testid=run-branch]` "<branch> @ <7 characters>" or "no branch recorded
  @ <sha>", hidden under 720 px with the definition chip. `docs/VIEWER_SIGNAL_BOX.md` updated.
- **DESIGN.md**: Layout (frame and cue, dock column and overlay, first view and overview, 336 px clear), Responsive (branch
  hides), The Stage Is The Page Rule, Identity line, Live dock, new "Sessions table", Lists paragraph (filter bar, order,
  project page, and stage A's four sentences verbatim), Do's and Don'ts.

## Test ids and scenarios

New ids: `sessions-cue`, `run-branch`, `now-show-in-graph`, `session-resume-toggle`, `session-resume-detail`, `[data-chip-label]`,
`run-board[data-dock]`. Kept: every id of PRD 5. Scenarios: `graph-readable`, `dock-times`, `now-open`, `identity-line` (in
`ux-run.spec.ts`), `sessions-cue` (in `sessions.spec.ts`), each with its screenshot. Untagged siblings: a running run's
"for <span>" advancing with the clock (`ux-run.spec.ts`), the cue's transition from unread to loaded, resize and phone
(`sessions.spec.ts`).

## Specs rewritten, and what they now assert

- `ux-run.spec.ts` `graph-fits`: the columns' x order, stage `scrollWidth <= clientWidth`, the page width, the 780 px focus check
  and the legend are unchanged; the last step's viewport check moved behind "Fit the graph" (and the first step's), the stage
  still not scrolling sideways after it. `run-steps-timeline` untouched.
- `revamp-pages.spec.ts` `revamp-run`: same moves (first view at 60 % or more, then "Fit the graph" for the last step; at 1024 px
  the last and the first step after "Fit the graph" plus the no-sideways-scroll check). The allow-list gained "Show in graph",
  "Show command" and "Hide command", and now also walks a Sessions run (table, a command shown) and the dock's "Show in graph"
  (URL unchanged). One clock, contrast and stage A's `review-one-list` and `node-compact` are untouched and pass.
- `sessions.spec.ts` `sessions-list`: the table by value at 1440 px (every row in order, each fact, rows at most 56 px, Claude rows
  have two buttons "Copy" and "Show command", the command after the toggle, none for pi / night-shift rows, the totals, no
  absolute path). `sessions-phone` and `reviewer-verdict` untouched and pass.
- Unit tests: `signal.test.ts` (`fitView`, `dockReserve`, `dockWords`), `sessions.test.ts` (`sessionsCueText`).

## Seeds

- `fixtures/ux-run.ts`: `run-no-branch` (finished, failed, inputs without a source branch; the candidate serves it as such).
  Nothing else added; Triage and the lists' counts do not move (finished run, dated 2026-03-02).
- `dock-times` uses `run-challenge` (ux-refine, paused), `run-review-interrupted` (ux-run, served paused with interrupted attention
  in both phases) and not stage A's M2 seeds: the worker phase serves no run detail for `dispatch-noorigin`. An interrupted run
  that is served `running` is covered by the unit test only. `run-freeze-interrupted` (failed) proves the finished words.
- The "run without sessions" of `sessions-cue` is `run-identical` (the candidate synthesises sessions for ordinary runs such as
  `run-succeeded`, so those carry a cue there).

## Open items

- A different `now` step per phase for `run-guarded-asking` (`handoff` in the worker mock, `launch_adapter` in the candidate), read
  from the page rather than hard-coded.
- Keyboard keys `+`, `-`, `0` no longer reach the stage from inside the dock (the dock is outside the stage); Escape from the dock
  does not close the sheet.
- Overview chips are small at the 15 % end (type scales with a cap of 2.4 so labels stay whole on two lines); P2 for stage C's
  polish.

## Follow-up b-003

- Dock bar (accepted-blocked run, 312 px): the word and the timing were clipped (`.lv-now` `scrollWidth > clientWidth`). `LiveDock.tsx` now wraps `.lv-now` and `.lv-since` in one `.lv-text` column (flex, wraps) beside the fixed chevron column; the word may wrap, no ellipsis on it or the timing; the `{' '}` text node is kept.
- `dock-times` asserts on the accepted run at 1440x900, with `page.clock` fixed: `.lv-now` `scrollWidth <= clientWidth`, `.w` right edge at or left of `.lv-now`'s and of `.lv-chev`'s left, `.lv-since` right edge at or left of `.lv-chev`'s left, and the step label keeps more than 40 px. Result on the restored 22c93c91 CSS (worker phase): failed at "`.lv-now` clips nothing"; after the fix: passes (worker phase; candidate phase below).
- `run-now-banner` is `test.slow()` (no assertion changed).
- Flakes seen: see the checks run below.
- `sessions.spec.ts` "At the overview of the sessions run…" waits for `sessions-cue` before pressing "Fit the graph": in the candidate phase the sessions load re-ran the first fit over the operator's fit (failed at 22c93c91 too, `data-level` 1 instead of 0). Worker-phase flake seen: `revamp-review` timed out once at 30 s under load (passed on rerun).

## Follow-up b-004

- Sessions arriving no longer takes back the operator's view (`signal/RunStage.tsx`): the cue reset only un-readies an untouched view, and once the view is touched a desk re-fits only on a change of flow direction or when the stage width moves 24 px or more from the width it was last fitted at (`fitted.current.width` stays on a kept view, so a slow drag still re-fits once it adds up). The phone branch re-fits on every size change as before. The `sessions.spec.ts` wait for `sessions-cue` before "Fit the graph" is removed.
- Test: `sessions.spec.ts` "An operator's Fit or zoom is kept when the sessions arrive…" (both phases): Fit and zoom to level 0 with the payload held, release, level and transform unchanged for 1 s, then -15 px and +15 px the same, then -60 px changes the transform. Must-fail (worker phase): at 611032f it fails on the first poll (level 1 instead of 0); with only the cue gate applied it fails at the -15 px clause (`sessions.spec.ts:349`); with the whole fix it passes.
- Dock bar (`signal.css` `.lv-bar { flex: none }`): the bar grows to its content and the body scrolls. `dock-times` asserts the bar geometry on accepted-blocked and accepted-abandoned at 1440x900 (`expectBarHoldsItsWords`: no vertical clip, label, word and timing inside the bar, bar above the body). On the restored 611032f CSS the bar clipped at 1440x900 already (`dock-times` failed on "the bar clips nothing vertically", worker phase); with the fix both pass. The untagged sibling "An accepted run's dock bar holds its words whole on a short window" runs the same at 1440x700 (also failed at 611032f).
- Open for stage C: in a run frame of about 1200-1215 px (a 1280 px window with a classic scrollbar) the Sessions table adds a ~15 px scrollbar, `run-board`'s clientWidth drops under 1200, the dock flips from column to overlay after load and the stage re-fits by design.
- P2s from triage, not fixed here ([L29]): sessions header grid drift, `.ss-resume-cmd` flex-basis, `run-branch` max-width, Now block layout, numeric-suffix rows, StepChart state word, `.lv-since` checked on x only, partly-failed scope line, scrollRestoration.
- Flakes: none seen in the targeted runs (candidate phase and full-suite results are in the controller's checks).
