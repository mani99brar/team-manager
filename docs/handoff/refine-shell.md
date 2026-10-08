# Handoff: refine-shell (Runs home ranked by need, the header's P2s, the shell at 390 px)

Lane `shell` of `viewer-refine-005`. Surface: Runs home (`/projects`) and the Projects header.
Impeccable method, Operate mode. `context` ran once (PRODUCT.md + DESIGN.md + Calm tokens loaded).

## Shape step (written before any edit)

No human interview is available in automatic mode, so the brief is asserted from PRODUCT.md,
DESIGN.md and PRD_VIEWER_REFINE §2, §5.7–5.9. Conclusion: the goals of §2 are met by a
**refinement** of the Calm look — Running and Paused become compact rows of the existing `.run-row`
design (DESIGN.md already specifies that row), the header gains a 44 px floor under 760 px, the
feature header reads real reviewers. No redesign is needed, so no `question`/mockup stop.

Jobs, in the operator's order on Runs home: (1) see what needs me now; (2) see what is running;
(3) see what paused days ago; (4) find a finished run. The first screen answers (1) then (2)/(3)
compactly, with Recent and its filters below.

First screen order at 1440, top to bottom, unchanged from the revamp except where noted:
- **Needs you** — warn cards with cause and next-step label, as the revamp built them (unchanged).
  One line "nothing waits on you" when zero.
- **Running** — one compact `.run-row` per non-finished, non-waiting, non-paused run (id, context,
  step glyph, since/elapsed, lane chips). Sub-header counts the step each row sits at.
- **Paused** — a separate section of compact `.run-row` rows for `status === 'paused'` runs that
  wait on nobody, sorted **oldest first**, each showing "since <n> days" in the paused tone. Its own
  sub-header counts the step each row sits at.
- **Recent** — unchanged structure (day groups, search, filters, group-by); the Failed/Succeeded
  filter counts now reflect the **searched** set, not every row.

What stays: the project rail with state dots, search, filters, group-by, the day groups, the
read-only note at the rail foot, the tab-title needs-you count, the controller liveness chip.

### Pinned definitions (so the reviewer and the spec share one reading)

- **Running vs Paused partition.** `running` = not finished, not waiting, `status !== 'paused'`.
  `paused` = `status === 'paused'` and `waitingKind === null`. A waiting run (question/pane/approval)
  is always Needs you, whatever its status. Pending/awaiting-without-attention stay in Running.
- **Paused sort.** Oldest first by `attention.since ?? movedAt` ascending (ties by run id).
- **"since <n> days".** `sincePausedLabel(since, now)` = whole days floored from `since` to `now`:
  `n >= 1` → `since <n> day` / `since <n> days`; `n === 0` → `since today`. The paused tone colours it.
- **Step tally (sub-header).** `stepTally(rows)` groups rows by `activity.focus.label` in first-seen
  order and renders `"<count> at <label>"` joined by `", "`; rows with no focus label render
  `"<count> without a step"`. Zero rows render the section's empty sub-header
  ("nothing is running" / "nothing is paused").
- **Recent filter counts over the filtered set.** `recentCounts` is computed over
  `searchRows(rows, query)` — the set the search narrowed to — so the Failed/Succeeded numbers on the
  buttons equal the rows a reader sees when that filter is pressed. (The status filter is not folded
  into the count; folding it would zero the other button.)

### Feature header reviewers (P2, two findings) — contract note

The run **list** carries no reviewers, and `runDetail` (contracts/projects/v1.ts:105) carries **no
`review` section** — reviewer ids live only on the review-result endpoint
(`fetchReviewResult`, reached through the review node's `result_uri`). So the plain words of the
task ("`fetchRunDetail`, one request ... `review.reviewers[].reviewer_id`") cannot be met: the run
detail has no `review.reviewers`. Per decisions **[L10](a)** ("fetches the latest reviewed run's
**review result** and lists its reviewer ids"), the feature page therefore:
1. picks the feature's latest run whose summary status is succeeded/failed/cancelled ([L13](c));
2. fetches that run's detail (cached per feature), reads the `review` node's `result_uri`;
3. if present, fetches the review result and lists `reviewers[].reviewer_id` under **"Reviewers"**;
4. otherwise (no reviewed run, no `result_uri`, or a pending/failed fetch) shows the definition's
   review steps under **"Review steps"**, never calling them reviewers.
This is a named departure from the task's "one request / `review.reviewers`" wording, recorded in
the completion's open_assumptions; it is lane-local (ProjectsView.tsx + api.ts, both shell-owned)
and changes nothing another lane reads.

## Inspection round (batched, 1440 + 390, light + dark)

One batched inspection, no open-ended loop:
- **1440 (home-sections screenshot).** Needs you cards, then Running and Paused as compact `.run-row`
  rows with lane chips and step sub-headers, then Recent. The rows reuse the Calm run-row the revamp
  already ships (4 px tone stripe, glyph-repeats, 44 px target), so the refinement adds no new visual
  idiom — only the lane chips (existing `.lane-chip`) and the paused "since <n> days" in the pause token.
- **390 (home-phone screenshot, dark).** Single column, 16 px gutter, no horizontal scroll, every
  header control and row control ≥ 44 px, the rail collapsed to a scrolling row of pills above the
  sections, dark theme with no overflow.
- **Both themes.** The `revamp-look` scenario still measures every rendered chip at ≥ 4.5:1 in light
  and dark; the new lane chips and reviewer chips are `.ui-chip.plain` (idle token), covered by it.
- **Mechanical detector.** `impeccable detect` over the changed targets reports only advisory/warning
  findings on pre-existing lines (the DESIGN.md-mandated 4 px tone stripe and the Calm 0.9rem secondary
  size); nothing new was introduced. No fix batch was needed.
- **Both screenshots viewed** (home-sections at 1440, home-phone at 390 dark): lane chips sit tidily
  beside the status badge without awkward wrapping, the "· since <n> days" reads as a distinct pause-tone
  clause (not part of the outcome sentence), the paused tone is legible in dark, and the phone is a
  single column with the rail collapsed to pills and no horizontal overflow. No fix needed.

## Audit

- **Accessibility.** Colour never carries state alone (glyph-repeats kept on every row; the paused tone
  pairs with the word "paused"/"since"); 44 px targets at 390 asserted; read-only header asserted; tab
  title keeps the needs-you count. No new colour literal or token (constraint honoured).
- **Responsive.** 390 single column, 16 px gutters, no page scroll, rail collapse — all asserted in
  `home-phone`, light and dark.
- **Left for the operator to eyeball.** The exact visual density of the step sub-header at a real
  13-run home (fixtures are smaller); and the compact-row controller-liveness omission (below).

## P2s closed here

- Recent filter counts over every row → the filtered (searched) set. (`lists.ts`, unit test)
- Feature header named definition review steps as reviewers → real reviewers from the review result.
- 34 px look-switch target under 760 px → the look switch is gone; every header control ≥ 44 px.
- Read-only check did not cover the Projects header → `projects.spec.ts` covers the header.
- No browser test of the Runs home data path → `home-sections` records one fetch against the mock.

## Open P2s / debts

- None of the five shell P2s is left open.
- **Controller-liveness chip dropped from the home compact rows.** The revamp's six-line Running card
  showed a "controller running" / "▲ controller not running" chip (PRD_VIEWER_UX 6.3). PRD 5.7 specifies
  the compact row as "id, feature, step, since, lanes as chips" with no controller chip, so the compact
  Running/Paused rows omit it; the controller-liveness signal remains on the run page (`LiveStatus`), and
  `controllerSuffix`/`recordHomeReadings` stay exported and unit-tested. Recorded as a refinement
  consequence, not a P2. If the operator wants it back on home, it can return as a row chip later.
- **Feature-header "one request" wording.** The header makes two cached fetches per feature
  (run detail → review result), not one, because the run detail carries no reviewers; see the contract
  note above. Lane-local, named in the completion's open_assumptions.
- **Pages-lane P2s (not shell):** 390 stacking (`run-phone`) and lane-chip tones (`fix-loop-graph`)
  close in the pages lane per PRD 5.8.
