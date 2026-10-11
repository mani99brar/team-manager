# Handoff: run controls, viewer lane (PRD_RUN_CONTROLS)

## What changed

- `src/projects/controls/`: the UI. `types.ts` mirrors Appendix A (and the clean-preview keys of [L4]); `client.ts` fetches
  with the token in `X-MDM-Control-Token` (the only place it is stored is `localStorage`, in try/catch); `store.ts` is one
  shared state per run (status probe once per page load, controls and records polled every 5 s, every 1.5 s while a record
  runs); `model.ts` is the pure logic (dialog values and validation, record wording, 409 handling, which step gets Run);
  `ControlsMenu.tsx` (Controls button, "Pair this browser", the list; a bottom sheet at 720 px and below),
  `ControlDialog.tsx` (native `<dialog>`, one `request_id` per dialog, one request in flight, Clean's dry run first),
  `ControlsRow.tsx` (the dock's `Controls` row and the Run Details history), `questions.ts` (the question the Answer dialog
  shows, read from the run inputs or the live Now), `context.ts` (hands the dock's command block its Run button).
- `IdentityLine.tsx`: the Controls menu and the history under Details. `LiveDock.tsx`: the Run context around the Now banner,
  the Controls row, the dialog host. `CommandBlock.tsx`: `Run` beside `Copy` on the first command, and the caption
  "Run it here, or in your terminal." only when that Run exists. `signal.css`: the `.ctl-*` rules.
- Tests: `tests/unit/controls.test.ts` (16 tests); `tests/project-workflows/controls.spec.ts` (the eight scenarios);
  `fixtures/controls.ts` (seven runs in the workflow `controls`, the fake `/proc`, `controlsEnvironment`, the worker-phase
  payloads), `mock.ts` (`installControlMocks`), `playwright.config.ts` (the candidate-phase controls environment),
  `fake-controller.py`, `controls-app.ts` (the critique app).

## Behaviour worth knowing

- Controls off or unreachable: the status probe is the only request, and nothing renders (no button, no caption change).
- Run and the changed caption appear only when this browser is paired and the server offers the control; the Run goes on
  the dock's first command, matched by verb and flags (`matchStep`, [L1] 3c): `automatic --live` restart, `retry`, `answer
  <lane>`, `approve`, `resume` (plain, `--accept-challenge`, `--launch`), `repair <lane> --session`, `abandon`, `clean`.
  The server's `recommended` is not read.
- The list and the Run button show each control's `available` and `reason` as sent; a `running` record never greys one ([L3]).
- A 409 `STATE_CHANGED` or `BUSY` keeps the dialog open with the sentence, refreshes the controls, sends nothing again and
  gives the next Confirm a new `request_id`. A refused token unpairs the browser.
- Clean: `POST .../clean-preview` with `{ run_state_token }` only; Confirm stays off until its exit code is 0 and the run id is typed.

## Checks run

See the completion file. The browser spec was run in the worker phase (mocked routes). The candidate phase and the critique
app need the server lane: in this worktree `/api/run-controls/status` is a 404, so `controls-app.ts` starts both servers,
seeds the runs (the Projects API serves them), then exits 1 as designed because the controls are not on. It is not run
against the real backend here.

## Open P2s and assumptions

1. **Candidate phase unproven.** Whether the real server offers Approve on `controls-approval` and Repair on `controls-repair`
   depends on its reading of the run files; the fixtures follow `pipeline.awaiting_approval` (finish `approval`, one
   `integration_approval` interrupt with `bundle_sha256` in `run-state.json`) and the triage repair rule (a controller
   diagnosis row, `verify_ui` failed, no review). The fake `/proc` of `controls-running` follows decisions [L1] 3d with the
   kernel's major/minor split in BigInt (`majorMinor`); the server's own decoding must agree.
2. **`controls-unavailable` and the reason.** The candidate assertion is the prefix `A supervisor is running` for Restart,
   Retry, Reconcile, Abandon and Clean on a running run; the `since HH:MM` time is asserted in the worker phase only.
3. **The Answer dialog's question text** is read from the page (run inputs, or the live Now), because Appendix A's `Control`
   carries only the lane choices.
4. **`controls-refused` in the candidate phase** replaces the server's answer with route-fulfilled 409s (error responses
   only); the failed-with-Blocked part runs against the fake controller.
5. The Controls panel on desktop is a popover under the identity line that can cover part of the dock; Escape or Close closes it.
6. Run Details lists control records as time, label and status only.

## run-controls-003 ([L6], viewer half)

Changed only what [L6] lists:

- **3 `fake-controller.py`:** one `argparse.ArgumentParser` per verb (no subparsers), flags copied from PRD section 4 and [L6] 3. A bare leading-dash
  text fails (exit 2) as in the real controller; `answer RUN lane --by operator -- -x`, `--reason=-x` and `--accept-challenge=-x` pass.
  `tests/unit/controls.test.ts` runs the fake with every argv form (`automatic` excepted: it sleeps 3 s).
- **4 Controls list on screen:** `ControlsMenu` places `.ctl-panel` (`--ctl-left`, anchored left in the left half of the page, right otherwise,
  clamped 12 px inside the viewport); the phone sheet is unchanged. `controls-unavailable` asserts the box and the first and last labels for
  `controls-running`, `-finished`, `-repair`, `-question` at 1280, 1400, 1024 and 1920 px (one fresh page per run).
- **5 viewer half:** the worker mock serves a `running` restart with `Supervisor starting`; `controls-restart` asserts it with one
  locator on the row before opening the disclosure, and that the disclosure stays open after `succeeded`.
- **6c** the dialog posts the token it was opened on (`pinToken`; unit test). **6d** opening the list focuses its heading; Escape returns
  focus to the button (asserted in `controls-unavailable`). **6e** the caption sits directly under the first command's Copy/Run pair.
  **6f** `controls-restart` makes two restarts and asserts Run Details lists two records, newest first (sorted by `started_at`).
- Design-challenge note 5: the fixture `command` strings use the [L6] 3 forms. Note 3: not run with `--repeat-each=5` (no server in this worktree).

Checks run: build, lint, test:contracts, test:unit, and `controls.spec.ts` in the worker phase through check-report (8 scenarios pass).
Not run: the candidate phase, and `controls-app.ts` against a real backend (the server lane's routes are absent here).

Open P2s: those above (1 to 6) still stand; the panel clamp is measured in `useLayoutEffect`, so a resize with the panel open re-places it on the next resize event.
