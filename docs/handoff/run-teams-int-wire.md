# Handoff: run-teams integration lane I1 (wiring and polish on the merged tree)

Branch `rt/int-wire` (from 475fd33), worktree `/home/agentops/dev/md-manager-rt-int-wire`. Spec: `docs/PRD_RUN_TEAMS.md` sections 2, 3.5, 5, 7, 4.5 and 11 (P0 item 9, P2 items 14-15). No contract changed.

## What is built

1. **Back closes the agent drawer.** `src/App.tsx` gains `pushListSearch(pathname, search)`, defined next to `replaceListSearch` and passed to `ProjectsView` as `onPushSearch`. It pushes a new entry with the same pathname, and refuses a write when the pathname is not the current one. It is not wrapped in `guardLeave`, which is declared later in App, and a Projects page never holds an edited document. `teams.spec.ts` `team-agent-drawer` now checks the round trip: open an agent, Back closes the drawer and keeps the Team view (no `agent=` in the URL, Team still `aria-current`), and Forward opens the drawer again.
2. **Note control end to end.**
   - `NoteButton` no longer casts: `NOTE_CONTROL` is typed as `ControlId`. The button carries `data-lane`.
   - `ControlDialog` changes for `note`:
     - title "Send a note to the lead of {lane}" once a lane is chosen;
     - field "Your note" with the section 7 helper, tied to the field through `aria-describedby`;
     - button **Send note**.
   - A finished note record stays in the dialog (`dialog-outcome`, with `data-tone` set) together with its sentence and an Output fold, and Close replaces Cancel. This matters because the Team view and the node page have no dock to show the record afterwards. Other controls close as before.
   - `controls/model.ts` `noteOutcome(record)` maps `workflow note`'s own lines (workflow/notes.py `note_main`):
     - success: "Typed into {lane}'s pane.";
     - `is recorded undeliverable and was not typed`: the undeliverable sentence;
     - `was typed but Enter did not submit it`: the enter_not_submitted sentence.
     - Anything else keeps the record's own line. The dock's Controls row uses the same mapping.
   - **The Controls dialog now mounts off the Run view too.** `RunView` renders `ControlDialogHost` on the Team, GitHub and Assignment views and on node pages; the Run view keeps the one in `LiveDock`. Before this, choosing a control from the Controls menu on the Team, GitHub or Assignment view did nothing.
3. **Read-only guard.** `expectNoExecutionControls` (support.ts) leaves out `[data-team-select]` buttons. The local copies in `run-views.spec.ts` and `teams.spec.ts` are gone, so both now also assert that the page has no `<form>`.
4. **Unknown publish outcome.** `github/actions.ts`:
   - `unknownLine(record)` returns the `Unknown:` line of a `failed` record (controller exit 3, or the server's 6-minute stop).
   - `recordShown(record)` gives such a record `{tone: 'warn', word: 'unknown'}`.
   - `outcomeSentence` returns `UNKNOWN_SENTENCE` ("The outcome is unknown: it may have been published. Check GitHub before you try again.") instead of "The command failed".
   - The dialog shows that sentence in a warn-tinted line (`gh-unknown`) with the raw `Unknown:` line under it. The records list adds the same warn line (`gh-record-unknown`) and the `unknown` pill.
5. **Lead commands in the step sheet.** `SheetTeamSection` renders the `LeadCommands` disclosure after its links. `LeadCommands` now takes `rows` (the sessions payload) as a prop instead of reading the Team context, so the sheet can use it.
6. **Teams poll while a worker sheet is open.** `SignalRun` takes `onSheetNode(nodeId | null)`: it reports the open sheet and reports null on unmount. `RunView` counts a worker's open sheet in `teamsWatched`, so the poll runs every 5 s while the run is live.
7. **P2.**
   - **Duration bars (item 14).** A 48 × 6 px `team-bar` sits in the Ran cell and on phone cards. Its fill is `duration_ms` over the workflow's longest recorded `duration_ms` (`longestDuration`, `durationFraction`), in the row's state tone. There is no bar when the duration is null, and a running agent's growing span is not drawn, so the scale never moves. There is no axis.
   - **Role filter (item 15).** `roleChoices` builds chips (`team-role-filter`, a `role="group"` of `aria-pressed` buttons, `data-team-select`), shown when a workflow has three roles or more, in first-seen index order with counts. `RosterFilter.role` is the card's own state, like the outside toggle; it is not in the URL. Pressing a chip again clears it.
8. **Assignment panel.** It is now a plain `<section id aria-labelledby>`, and the prop `tabId` is renamed `labelledBy`. No test queried the tabpanel role in the projects suite.

## Tests (worker phase, all on this host, every browser run through the flock lock)

| Command | Result |
|---|---|
| `npx --no-install tsx --test tests/unit/*.test.ts` | 756 pass, 0 fail (new: note copy/outcomes in `controls.test.ts`, unknown outcome in `github.test.ts`, P2 bars/roles/role filter in `teams.test.ts`) |
| `npx --no-install tsc -b` | clean |
| `npx --no-install eslint .` | clean |
| playwright `note.spec.ts teams.spec.ts` | 25 passed (new `note-control`, `note-control-undeliverable`, `team-duration-bars`, `team-role-filter`; extended `team-agent-drawer`) |
| playwright `run-views.spec.ts github.spec.ts controls.spec.ts inputs.spec.ts revamp-pages.spec.ts ux-run.spec.ts sessions.spec.ts` | 88 passed |

`note.spec.ts` layers its own `page.route` over `installControlMocks`. For the teams run it serves the worker-phase catalog (`controlsFor(RUN_STOPPED)`) with `note` offered for lane ui and the section 7 effect texts, and answers the note POST with the record `workflow note` would leave. It also covers controls off (no note button, `expectNoExecutionControls`), the lane head, the sheet, the node page, the Controls menu and the dock's Controls row. No fixture file was edited.

Not run: the candidate phase, the full browser suite, `npm run build` and `workflow.run_tests`.

## Known gaps / for the integrator

- **The server's note effect texts are not section 7's.** `server/controls.ts` serves "Types your note into the lane's lead session between its turns and records it in <lane>.notes.json." and "It does not interrupt a running tool call; a team workflow that is running takes no input until it returns." The dialog shows them verbatim, as the brief asks. Section 7's wording ("...as an operator note and records it in the lane's notes." / "A running team workflow takes no input: its agents never see the note...") would be a server change, outside this lane.
- **Dialog order.** The shared Controls dialog shows title, effect, not-effect, command, then the fields. Section 7 lists the field before "What it does". I kept the shared order.
- **Closing the drawer** (Close or Escape) replaces the entry instead of going back. After a Close, one Back press lands on the same view without an agent.
- **The role and outside filters are per card** and not in the URL. The drawer's Previous/Next walk ignores both, as it already ignored the outside toggle.
- **The unknown outcome** has no Playwright scenario; it is unit-tested only, as the brief asked.
