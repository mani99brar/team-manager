# Handoff: viewer-refine pages lane (run page, graph, steps, node pages, Assignment, inline diff)

Run `viewer-refine-005`, lane `pages`. A refinement of the Calm look (PRD_VIEWER_REFINE §4, impeccable **Operate** mode). The
adapter already landed 1.10.0 on main: `contracts/projects` and `server` serve `fixLoop`, `review.round/delta_from/delta_diff`,
`inputs.workers[].roles/.skills`, `inputs.automatic.fix_rounds`, and project repair nodes into `definition`/`snapshot`.

## 1. Context step (method step 1)

`skills/pages/skills/impeccable/scripts/impeccable context --target src/projects/RunView.tsx` ran and loaded `PRODUCT.md`,
`DESIGN.md` (the Calm design system) and resolved context. No surface brief found (`surfaceBriefReason: not-found`), which is
expected — the run page is an incumbent surface, refined on its own code. `PRODUCT.md`/`DESIGN.md` read correct; no
`open_assumptions` against them.

## 2. Shape result (method step 2 — written before the first edit)

Surface: the run page (`[data-testid=run-view]`). Mode: Operate. Conclusion: **a refinement meets PRD §2** — this is a reorder
of existing truth into an answer-first column plus two projected additions (repair nodes in the graph, phase groups in the
Steps/Activity) and S7 (Assignment table, inline diff). No redesign; no `question` on §4 step 2.

Jobs on this surface, in order: (1) what does this run need from me now; (2) why; (3) what do I type next; (4) what is the
shape of the run (the graph with its loop); (5) the detail (steps, activity, metadata, assignment).

### First screen, top to bottom, inside `run-view` at 1440 (the breadcrumb above it is the shell's, not asserted)

1. **Title line**: feature name (truncated, `title=` full) + run id in full (`run-id`). The metadata disclosure sits under it.
2. **Metadata disclosure** (`run-details`, closed): branch, commit, mode, definition hash, created/updated. Two **deadline
   chips** (worker, review) stay beside the state line, from `deadlinesLabel` (the only served facts; labelled as the
   deadlines they are — see §6, note 3).
3. **State line** (`run-status-line`): the status chip (`run-status`, the status word) + the served triage headline
   (`now.headline`) in the state's colour **with its own glyph** (no second glyph added), + `run-status-meaning` (the short
   sentence) kept present. `definition-changed` stays here, outside the metadata disclosure (a changed definition is a
   warning). The time-zone toggle stays beside the state line.
4. **Cause** (`now-reason`): one quoted line (the P1 title / gate reason / question) with the focus "Open …" link.
5. **Next step** (`now-next`): the first command with Copy (`now-command`/`command-run`/`run-dir-command` ids kept); the
   remaining commands in a closed **"All steps"** disclosure, in order. When a later command is an **alternative** (its
   caption starts "Or ", or the step pair carries the question's `caveat`), the disclosure summary names it
   ("All steps · or <caption>") and the caveat stays visible as a one-sentence caption under the first command (note 1 — the
   operator's launch reason). A pure sequence keeps the plain "All steps" summary.
6. **Lanes strip** (`run-lanes`): one line per lane with its model pin (`opus-4-8 · medium`) or the executor only when the
   lane has no pin, and its repair round count. Pins come from `/inputs` (`inputs.workers[].roles`), already fetched once.
7. **Graph** (`run-pipeline` + `run-board`): the pipeline with the loop, then the Steps table (side by side where both fit,
   stacked otherwise — `data-layout`).

Below the first screen: attack/panel sections (unchanged), Activity grouped by phase, node pages.

**Moved below / into disclosure**: the metadata strip (branch/commit/mode/hash/created/updated) → `run-details` disclosure.
The later next-step commands → "All steps" disclosure. **Removed**: nothing of content; only arrangement changes. Every older
export renders unchanged in content.

### "Paragraph" definition (shape step; note 6 is context-only, this is the shape's own operational rule)

"Nothing on the first screen is a paragraph" = no text block longer than one sentence rendered as a `<p>`/prose block inside
`run-view` above the graph. The state line and cause are single sentences; the metadata is a `<dl>`/chips, not prose. The
`run-phone`/`run-first-screen` specs assert the state line and cause are single-sentence and that the only multi-line prose
(the honesty caption, the reason when expanded) sits in the next-step block, not above it as a paragraph.

## 3. The graph with the loop (PRD §5.2)

Repair nodes are already in `detail.definition`/`snapshot` (server-projected). The graph draws them like any node plus a
**dashed return mark** from the repair node back to the step it answers, sourced from `fixLoop.repairs[].blocked_step` keyed by
`node_id` — never from `depends_on` (Appendix A's own finding is exactly the depends_on bug). `WorkflowGraph` gains a
`returns: {from,to}[]` prop built in `RunView` from `detail.fixLoop`. Meta line overrides: a repair node says
`round <r> of <rounds> · <trigger>`; a launch node shows its pin (`opus-4-8 · medium`) or the executor; the review node's
label follows the fix loop (see §5). Legend gains the return-mark entry. `dag.ts` places repair nodes in a row after the
pinned rows of their column (the server inserts `repair-N` right after its step in definition order, so it lands in the next
column; placing it after the pinned rows there keeps 8 columns for the 15-node two-lane two-round run and keeps keyboard
order = `nodes` order).

## 4. Steps & activity (PRD §5.3)

`steps.ts` gains a pure `phaseGroups(rows, …)` (additive; existing exports unchanged): groups rows by phase
(Challenge/Work/Verify/Candidate/Review/Integrate), a repair row indented under the step it answers with its round, a review
round row under Review. Counters count pinned steps only (definition minus `repair-` ids).

**Not built this round (repair round 2 of 2):** the Steps phase header does not yet carry the phase's outcome and duration,
`steps.ts` emits no review-round row under Review, and the Activity log does not fold each challenge attempt or repair round
into a one-line sub-group (`StepsTimeline.tsx` / `node/model.ts` `groupActivity` are unchanged). §5.3's folding is still open
(review findings on PRD 5.3; open as of this round).

## 5. Review node label (L12a/L13b, from the fix loop, not `state.attempt`)

- A repair with `trigger: review`, `review_round: k`, status ∈ {launched,captured,recorded} → "round k+1 in review".
- A repair of round k applied and the review not yet served (review `result_uri`/`reviewData` null) → "round k+1 in review".
- Review served → "round <review.round>" + "delta from <7 chars>" when `delta_from`.
- Restored round → "round 1" + the restored note.

## 6. Design-challenge notes (attempt 5)

- **Note 1 (P1, alternatives)** — acted on: the "All steps" summary names the alternative; the caveat stays visible. Operator's
  launch reason binds this. Named open assumption: `firstscreen-alternatives`.
- **Notes 2–6** — the operator accepted these "context only; do not act on them and do not ask". Not acted on. Note 3 (chips are
  deadlines not durations): the chips are labelled as deadlines (truthful), which is what the incumbent `deadlinesLabel` already
  renders; the pinned scenario's "worker and review durations as two chips" is satisfied by two chips carrying those values.

## Inspection round (one batched pass, 1440 and 390, light and dark)

Inspected through the four scenario screenshots (`run-first-screen`, `fix-loop-graph`, `assignment-and-diff` at 1440 light;
`run-phone` at 390 dark) plus the revamp/ux-run scenarios that re-shoot the same surface. Findings and fixes, one batch:

- The deadline chips first sat inside the state-line `<p>`; that reflowed `.run-header-line` and pushed the time-zone
  toggle off the state-line row (ux-time's "toggle beside run-status" assertion). Moved the two chips into the `run-facts`
  row below the title (still beside/under the state line, `run-deadlines` kept), and dropped the duplicate deadline text
  from the facts line. Fixed.
- The run-view buttons were under 44 px at 390 px; added a phone rule (`.run-view button { min-height: 44px }`) in `run.css`.
- The return mark reads as a dashed arc back to the step it answers in the edge tone, distinct from the solid dependency
  edges; the legend gained its entry. Dark theme holds (tokens only; `--edge`, state soft fills).
- The inline diff's add/remove/context rows use the ok/fail soft tones with a sign glyph, so the tone never carries the
  change alone; hunks scroll inside their own box at 390 px.

No new colour literal was added; every new element uses the Calm tokens and both schemes.

## Audit (method step 5)

- Accessibility: the graph keeps its keyboard order (repair nodes sit right after the step they answer, confirmed by
  `fix-loop-graph`); the return mark and status are `aria-hidden` drawings with the meta text carrying the words; the lane
  chips and deadline chips repeat their state/words in text, not colour alone; the diff tabs are `role="tab"` buttons.
- Responsive: 390 px single column, no horizontal page scroll, the graph/diff/steps scroll inside their own boxes, 44 px
  buttons (asserted in `run-phone`).
- Left / not done: a dedicated repair-node page and the superseded review-attempt page (§5.4) — a repair node renders today
  through `WorkerSections` (the interim rendering named below); the graph, Steps and lanes carry the loop. `impeccable
  detect` was not run to avoid a second heavy process while the Playwright suite ran on this single-Playwright host.

## Phase note (important)

The worker-phase mocks (`payloads`) fold the pinned-step statuses by hand and all four scenarios pass there (the controller's
`project-workflows-browser` check runs the worker phase). The candidate-phase seed writes server-valid 1.10.0 exports — the
real server reads and projects them (the full `server/projects.test.ts` suite passes over the seeded runs) — but the seed
writes **no verification packets**, so the server folds the `candidate`/`verify` base statuses to `paused` where the mock
shows `succeeded`. Three of the four scenarios therefore do not pass unchanged in the candidate phase (the fix-loop
projection itself — repair nodes, return marks, re-entered review, review round — is mirrored faithfully; the drift-guard
unit test and the server test cover that). Seeding packets for the ux-refine runs is the remaining candidate-phase work.

## Open P2s carried

- 390 px stacking — closed by `run-phone` scenario.
- Lane chip tones all-passed only — closed by `fix-loop-graph` (a failed `verify_shell` and a running `launch_viewer`).

## Interim state named

Repair nodes render in the graph and node list. A dedicated repair-node page and the superseded review-attempt page (§5.4) are
**not built** — a `repair-<n>` node still opens through the generic `WorkerSections`, with no round/trigger/verbatim
findings/outcome and no "superseded by round k+1" review-attempt page, and a verify attempt after a session repair still reads
"after operator repair" with no link to the repair node. These §5.4 items and the §5.3 folding (above) are open after round 2.
No controller-side export after a round launches (engine follow-up): the server reads the loop live; the viewer shows
`fixLoop.source`-independent content.

## Repair round 2 of 2 (this round): review findings addressed

Fixed, inside owned paths: the truncated task length now shows the pinned "over 65,536 characters (truncated)"
(`status.ts` `taskLengthLabel`, `Assignment.tsx`); the inline diff's `views` array is memoised so the bounded read runs once
per view, not once per run-clock tick (`ReviewDetail.tsx`); an over-1 MB diff now says "over 1 MB, not read" with a
`diff-show-all` button that re-reads it unbounded (`diff.ts` `limit` arg, `ReviewDetail.tsx`); the `run-facts-line`
(branch @ commit · mode) duplicate is removed from the run header's first screen, leaving that metadata only in the closed
`run-details` disclosure (`RunHeader.tsx`); the 18 `var(--token, #hex)` colour-literal fallbacks are dropped from `run.css`
and `assignment.css`. **Not fixed this round** (left open, named above): §5.4 repair-node and superseded review-attempt pages
and the verify-after-repair link; §5.3 Steps phase outcome/duration + review-round row and Activity attempt/round folding; the
`definition-current` chip stays on the first screen because the shell-owned `projects.spec.ts` asserts it visible and this lane
may not edit it (branch/commit/mode did move into the disclosure).
