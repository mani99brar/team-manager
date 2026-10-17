# Handoff: run-teams lane C1, the Team view, run-view integration and the node-page Team section

Branch `rt/ui`, worktree `/home/agentops/dev/md-manager-rt-ui`. It is built on the scaffold (C0, `docs/handoff/run-teams-ui0.md`) and covers spec `docs/PRD_RUN_TEAMS.md` sections 3, 5, 6, 7 (the note button and lead commands), 8, 9, 10 and 11 (P0 items 2-6). No contract changed.

The lane was built in two sessions. The first was cut off by a usage limit, and its uncommitted work was checkpointed as `8640345` (WIP). The second finished the lane in the commits on top of it.

## What is built

- **Model** `src/projects/teams/model.ts` (pure, with no React and no `.tsx` import). It covers:
  - the Team suffix
  - lane grouping by `inputs.workers[]`, plus other sessions
  - the owned-paths flag (the controller's `owns()` rule: only worker sessions, only the listed files, and `/`, `~` and redacted paths are not compared)
  - the quiet flag (10 minutes or more before `read_at`)
  - the attention-line table 3.2 (the first two rules that hold, with the first one's tone)
  - session sentences
  - card facts and status lines (3.3)
  - phase segments (3.4)
  - roster groups, folding, filters, state choices, the scope line and the `agents_more` line (3.5)
  - Working now (3.6)
  - the head sentence
  - accessible names (10)
  - the announcer diff (10)
  - the step-card facts, dock line, Sessions-row facts, sheet rule and node index entry (5, 6)
- **Views** in `src/projects/teams/`:
  - `TeamView` covers the view states of 3.9 and the announcer, which speaks at most every 10 s and says nothing on the first read.
  - `LanePanel`, `LaneBody`, `NoteButton`, `LeadCommands` and `AttentionLine`.
  - `WorkflowCard`, `PhaseStrip`, and `Roster` (a desk table and phone cards).
  - `AgentDrawer` and `DrawerHost`: a 440 px right sheet, or a 78 % bottom sheet on a phone; `role=dialog aria-modal=false`; focus starts on Close; Escape hands focus back to the opener; Previous and Next walk the filtered roster.
  - `WorkingNow`, `CopyButton` and `context.ts` (the TeamContext, `usePhone`, `leadRunning`).
  - `TeamSections.tsx`: `SheetTeamSection` (the step sheet) and `NodeTeamSection` (the node page, with a local selection and "Open in Team view ›" carrying `session/workflow/agent`).
  - `teams.css`.
  - All agent text is plain pre-wrapped text, and only `now`/`clock` from RunView is used.
- **Run view integration** (5):
  - `signal/model.ts` gives `StageNode.team`. It is `null` unless the node has a session with records `found`.
  - `executor.ts` adds the `team` word.
  - `RunStage.tsx` covers row two, the counts, the outside-paths count, row four (the running agent's line), the overview chip, the accessible-name suffix and the legend entry (only when some card has a team).
  - In `signal.css`, the stacked deck is drawn with two offset `box-shadow`s, not `::before`. The card has `overflow: hidden` (its lines clamp), so a `::before` copy would be clipped. The look is the spec's: a Sheet card offset 4 px by 4 px behind, with a 1.5 px Rule edge, below the float shadow.
  - `LiveDock` gets the Working now row (`live-dock-working-now`, a 44 px link to `/team?state=running`, or the interrupted line while the run is live), and Spent's tooltip gets its note.
  - `SignalRun` takes `teams` and `teamHref`.
  - `RunView.sheetExtras` puts the Team section before the attack and panel records. It shows for a worker with any team session, and for another node only when that node's records are found or unreadable.
  - `Sessions.tsx` gets `session-team-facts` and `session-team-link`.
- **Node page** (6):
  - `launchSectionEntries(…, team)` adds a Team entry after Files and before Task (no count for a records-`none` worker).
  - `WorkerSections` takes `team`, rendered as `NodeSection key=team testId=team-section`.
  - In `NodeDetail`, a non-worker node (repair, challenge) gets the section when its records are found or unreadable.
  - RunView passes `teams`, `onRetryTeams` and `teamHref`, and NodeDetail fetches nothing.
- **Fixtures** `tests/project-workflows/fixtures/ux-teams.ts`: workflow `ux-teams`, registered in `fixtures/index.ts`. Its runs are `teams-base` (the example plus a sessions payload), `teams-live`, `teams-large` (6 phases, 400 listed, 112 more), `teams-failed`, `teams-killed`, `teams-interrupted`, `teams-none`, `teams-absent` (a 404), `teams-unreadable`, `teams-malformed` and `teams-empty`. The outside-paths and quiet cases live in `teams-base` and `teams-live`. Its payload builders (`teamAgent`, `teamWorkflow`, `teamSession`, `teamsPayload`) compute the totals, and the unit tests reuse them.

## Tests (run in this worktree)

- `npx --no-install tsx --test tests/unit/teams.test.ts tests/unit/teamsStyle.test.ts tests/unit/typeFloor.test.ts tests/unit/signal.test.ts tests/unit/sessions.test.ts tests/unit/steps.test.ts`: 153 passed.
  - `teams.test.ts` holds 43 tests and covers every 3.7 case.
  - `signal.test.ts` gained 2 tests, one of which proves that records `none` give a stage model deep-equal to one without teams.
- `npx --no-install tsc -b`: clean. `npx --no-install eslint` on every changed file: clean.
- Playwright `teams.spec.ts`: 21 passed, the full P0 list.
  - Each scenario id is in one test title with one `screenshot:<id>` attachment.
  - Each test checks the desk at 1440×900, then asserts no horizontal overflow at 390×844.
  - The clock is fixed with `page.clock.setFixedTime`.
- Playwright `ux-run.spec.ts sessions.spec.ts revamp-pages.spec.ts run-views.spec.ts`: 40 passed after one fix to `run-views.spec.ts` (below). `revamp-pages` needed no allow-list change.
- Every browser run went through the flock lock.
- Not run: the candidate phase, the full browser suite, `npm run build` and `workflow.run_tests`.

## Deliberate changes to existing tests

- **`run-views.spec.ts` (`run-views-switcher`).** Its `expectNoExecutionControls` on the Team view failed for a reason in the spec itself. Section 3.4 requires a phase segment (a button) to read "not started", and "start" is an execution word.
  - That one call is replaced with the same check, but leaving out `[data-team-select]` buttons. Those buttons only select an agent, a phase or a workflow, and their text is agent data (a phase count, or a tool name such as `Edit`). This is the same way the shared helper leaves out `data-graph-node` step cards.
  - `teams.spec.ts` uses the same local check.
  - The integrator may prefer to add `:not([data-team-select])` to `expectNoExecutionControls` in `support.ts`, which this lane does not own.

## Integrator must wire / known gaps

1. **The `note` control is not in `CONTROL_IDS` in this tree.** `NoteButton` (the lane head, the sheet and the node page) looks for a served control whose id is `note`, so for now it never renders. Once the GitHub-actions lane appends `note`, check that the cast `(entry.id as string)` can drop, and that the dialog's copy is section 7's. No note scenario is in this lane.
2. **Back does not close the drawer yet.** Opening an agent pushes a history entry only if `App.tsx` passes `onPushSearch`; that is the scaffold handoff's item 1, and `App.tsx` is not owned here. Until then the drawer opening replaces the entry, so Back leaves the Team view instead of closing the drawer. Filters replace the entry, as they should, and the spec asserts that `history.length` stays the same.
3. **Lead commands** appear on the Team lane head and on the node page, but not in the step sheet's Command section (`NodeSheet` would have to take the sessions payload).
4. **Teams polling while a sheet is open:** still only on the Team view and a worker's page (scaffold item 3).
5. **The run-legacy-unchanged check is DOM only.** It compares the `run-board` outerHTML of `teams-none` and `teams-absent`, with the run id normalised, and the two are identical. A pixel comparison of the two boards was dropped: two screenshots of the same board differ slightly, probably from stage rendering, and no baseline exists.
6. **A records-`none` worker's sheet and node page show a Team section with the rule 9 or 10 sentence**, which sections 5 and 6 ask for. The closed run page stays identical.
7. **No candidate-phase seed.** The teams reader is not in this tree, so `teams.spec.ts` skips itself outside the worker phase.
8. **The run-views fixture sets the example teams on core run `run-succeeded`**, so that run's stage now shows the team line and deck on `launch_ui`, and a dock row. The touched existing specs still pass.
9. **P2 items 14 and 15** (duration bars and the role filter) are not done.
