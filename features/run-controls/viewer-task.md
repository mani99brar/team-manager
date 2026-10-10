# Viewer worker: run controls on the run page (PRD_RUN_CONTROLS)

## Goal

The operator can act on a run from its run page, safely, as a user would:

1. **Controls off:** with the API started without `MD_MANAGER_RUN_CONTROLS=on`, the run page is exactly today's: Copy only, the caption "Run these in your terminal; this viewer never changes a run.", no Controls button.
2. **Pair this browser:** with controls on, the identity line has a `Controls` button; unpaired, it opens "Pair this browser" with one token field; a wrong token is refused and asked again; the right one shows the Controls list and survives a reload; the token is never shown again.
3. **Restart a stopped supervisor:** on an automatic run whose supervisor stopped, the dock's command block shows `Run` beside `Copy` on the restart command; `Run` opens a confirmation with the label, the exact redacted command, what it does and what it does not do; `Confirm` sends one request (a second click sends nothing); the dock shows a `Controls` row running with its log tail behind a disclosure, then succeeded; Escape or Cancel sends nothing and returns focus.
4. **See why a control is not offered:** the Controls list shows every control of PRD section 4; unavailable ones are greyed with their reason ("A supervisor is running since 10:42"); `Pause supervisor` says the workers keep running.
5. **Answer a question:** on a run where a lane waits on a question, `Answer the question` shows the question and a text field; Confirm is disabled while empty; the answer is sent once and the record shows the controller's output.
6. **Decisions need the run id typed:** Abandon (with a reason), Approve, Repair a lane and Clean keep Confirm disabled until the typed run id matches; Clean shows its dry-run output first.
7. **Refusals read clearly:** a control the controller refuses shows failed with its `Blocked:` line first; a 409 `STATE_CHANGED` says the run changed since you looked and refreshes the controls without resending; a 409 `BUSY` says another control of this run is running.
8. **On a phone (390 px):** the Controls list is a bottom sheet, the dialog fits with the command wrapped, nothing scrolls sideways.

`docs/PRD_RUN_CONTROLS.md` section 6 and Appendix A are the specification; `features/run-controls/decisions.md` records the operator's decisions and wins over the PRD where they differ. The critique reviewer walks these eight flows on the app `tests/project-workflows/controls-app.ts` starts, so write your `verify_yourself` lines as the steps a user takes there.

## Context

- The run page is the Signal Box design: `docs/VIEWER_SIGNAL_BOX.md` is the reference for its test ids and structure. The dock: `src/projects/signal/LiveDock.tsx`; the identity line: `src/projects/signal/IdentityLine.tsx`; the command block and its Copy button: `src/projects/CommandBlock.tsx` (`COMMAND_CAPTION` comes from `contracts/projects/triage.ts`, which you do not own: when controls are on, render your own caption instead of changing the constant). The dock's recommended command is `NextStep` from `contracts/projects/triage.ts`; the server marks the matching control `recommended`, so put `Run` on the step whose control is `recommended`.
- The API: PRD Appendix A. The `server` lane builds it in the same run; lanes meet only at the candidate, so mirror Appendix A's types in `src/projects/controls/types.ts`, fetch through your own client in `src/projects/controls/` (the token goes in `X-MDM-Control-Token`, the body is JSON with a fresh `request_id` per dialog and the `run_state_token` you rendered from), and in the worker phase mock `/api/run-controls/**` in your spec (or in `mock.ts`) with payloads built from Appendix A. In the candidate phase the real backend serves them: `tests/project-workflows/playwright.config.ts` starts the API with `MD_MANAGER_RUN_CONTROLS=on`, a token file under the test root, `MD_MANAGER_WORKFLOW_PYTHON` set to your fake controller (PRD Appendix A.3), `MD_MANAGER_WORKFLOW_HOME` the test root, `MD_MANAGER_CONTROLS_STATE` under the test root and `MD_MANAGER_CONTROLS_SPAWN=direct`. Seed the runs your scenarios need (a stopped automatic run, a running supervisor via a fake `/proc` under `MD_MANAGER_CONTROLS_PROC`, a waiting question, a finished run, a run id containing `refuse`) through `tests/project-workflows/fixtures/controls.ts` and `fixtures/index.ts`, with the writers of `seed.ts`.
- **The critique app** (policy `critique_app`): `npx --no-install tsx tests/project-workflows/controls-app.ts` runs in the candidate worktree with `CRITIQUE_WEB_PORT` and `CRITIQUE_API_PORT` set. It creates a temporary root, seeds the same runs as your fixtures plus the skills fixtures the harness copies (see `playwright.config.ts` `prepare()`), writes a token file holding `critique-pairing-token-0000000000000000` and the fake controller's environment, starts `npm run start:api` on `$CRITIQUE_API_PORT` and `npm run dev:web` on `$CRITIQUE_WEB_PORT` with the same environment as the candidate-phase config, prints the run page URLs and the pairing token to stdout, forwards SIGTERM/SIGINT to both children and removes the root on exit. `ready_path` is `/api/run-controls/status`, so the app is ready only when the web server proxies to an API with controls on. Say the token and the URLs in your `verify_yourself` lines.
- The look: tokens in `src/projects/theme.css`, `DESIGN.md` and `PRODUCT.md` at the repository root, the existing dialog in `src/projects/Screenshots.tsx` (a native `<dialog>`; reuse its pattern). Load the `impeccable` skill for the controls' design and copy; destructive actions read as such without shouting.

## Constraints

- Owned paths only (policy.json `viewer`). Do not edit `server`, `contracts`, `src/projects/api.ts` or `workflow`; a field or route you need that Appendix A lacks is a `question` completion.
- With controls off the page must not change: no extra element, no layout shift, only the status probe request.
- Never store the token anywhere but `localStorage` (wrapped in try/catch: a blocked storage means "not paired"), never render it after pairing, never put it in a URL.
- No new dependency.

## Acceptance

- The browser scenarios in `policy.json` (`controls-off`, `controls-pair`, `controls-restart`, `controls-unavailable`, `controls-answer`, `controls-typed-confirm`, `controls-refused`, `controls-phone`) pass through `check-report`, each in exactly one test title as `[scenario:<id>]` with one `screenshot:<id>` attachment; their descriptions are the assertions. They pass in both phases: worker (mocked routes) and candidate (the real backend and the fake controller).
- Unit tests in `tests/unit/controls.test.ts`: the dialog model (inputs per `ParamSpec`, Confirm enabled only when valid, the typed run id), one `request_id` per dialog, the record's status wording, the 409 handling, and which step gets `Run`.
- `tests/project-workflows/controls-app.ts` starts the app on the two ports and `/api/run-controls/status` answers `enabled: true` (run it once by hand and say so in the handoff).
- `frontend-build`, `frontend-lint`, `shared-contract` and `frontend-unit` pass; `docs/handoff/run-controls-viewer.md` says what changed and every open P2.

Run targeted tests while iterating, then this lane's non-browser policy checks once before writing the completion; run browser specs only through check-report on this lane's own specs.

Browser checks: each scenario id appears in exactly one test title as `[scenario:<id>]`, and that test, when it passes, attaches exactly one image/png named `screenshot:<id>` (other attachments are fine). The verifier refuses anything else. Before completing, run the spec files you changed with a JSON report:

```bash
WORKFLOW_VERIFICATION_PHASE=<worker|candidate> PLAYWRIGHT_JSON_OUTPUT_FILE=<tmp>/report.json \
  npx --no-install playwright test --config=tests/project-workflows/playwright.config.ts --reporter=json tests/project-workflows/controls.spec.ts
```

Then check the report with the verifier's own rules: run the exact `check-report` command the controller appends to this task when it pins it.

## Stop

Stop with a `question` completion when a flow needs a field, code or route Appendix A does not define, or when the controls cannot be added without changing a file another lane owns (`contracts/projects/triage.ts` included). Stop and report `blocked` when the `impeccable` skill is not available through the `Skill` tool. Do not redesign the dock or the identity line beyond the Run button, the Controls button and the Controls row; do not add a control the PRD's section 4 does not list.
