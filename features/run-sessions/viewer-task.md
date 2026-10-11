# Viewer worker: show every session of a run on the run page (PRD_RUN_SESSIONS)

## Goal

Make every session that worked on a run visible on the run page (`docs/PRD_RUN_SESSIONS.md` section 3, data in section 4 and Appendix A):

1. **Reviewer and panel nodes** on the Signal Box stage (`src/projects/signal/`): one card per projected `reviewer-<id>` node and the `panel` node, side by side before the review gate, each with its state word, open P0/P1 count and cost (3.1). The `review` gate, repairs and approval keep their places. Scenario `sessions-stage`.
2. **Lane review nodes:** a card per `lane-review-<lane>-<n>` after its verify step with the round's result and whether a fix round started (3.2), and a node page with its reviewers, findings, reviewed snapshot and the repair it started, linked. Scenario `sessions-lane-review`.
3. **Reviewer node pages:** the session block, the verdict, that reviewer's own findings for the latest round, and earlier rounds' verdicts (3.1). Scenario `sessions-reviewer`.
4. **Session block** on every node page that belongs to a session (challenge, worker, repair, reviewer, critique, panel, lane review), with the copyable resume command for Claude sessions (3.4). Scenario `sessions-reviewer`.
5. **Sessions section** on the run page: every session in start order grouped by role, linked nodes, total cost and the count not recorded (3.4). Scenario `sessions-list`.
6. **The panels:** the `Panel` node page with today's provider panel and one session block per provider; the night-shift decisions on the node they decided and the run page's one-line count (3.3). Scenario `sessions-panel`.
7. **Phone (390 px)** and the 44 px targets for the new links and buttons. Scenario `sessions-phone`.
8. **The critique app and the handoff.** `tests/project-workflows/sessions-app.ts` starts the real server on the seeded sessions run (ready at `/api/projects`, as `controls-app.ts` does for its feature) so the critique reviewer can walk the flows; `docs/handoff/run-sessions-viewer.md` says what changed, the test ids, and open items; `docs/VIEWER_SIGNAL_BOX.md` describes the new cards.

## Context

- Read first: `src/projects/signal/` (`model.ts`, `RunStage.tsx`, `layout.ts`, `NodeSheet.tsx`, `SignalRun.tsx`), `src/projects/RunView.tsx`, `src/projects/NodeDetail.tsx`, `src/projects/ReviewDetail.tsx`, `src/projects/node/ReviewSections.tsx`, `src/projects/providerPanel.tsx`, `src/projects/api.ts`, `contracts/projects/triage.ts`, `docs/VIEWER_SIGNAL_BOX.md`, and the harness `tests/project-workflows/` (`mock.ts`, `seed.ts`, `fixtures/index.ts`, `fixtures/ux-panel.ts` and `panel.spec.ts` as the closest precedent, `support.ts` `renderedText`).
- **Data.** Types mirror Appendix A in `src/projects/sessions/types.ts` (the `server` lane writes `contracts/projects/sessions.ts` in parallel; do not import it). Fetch the route with a function in `src/projects/api.ts`. Projected nodes arrive in the run detail as ordinary nodes (PRD 4): build the cards from them and the sessions route, not from event text.
- **Seeds and mocks:** a new fixture module `tests/project-workflows/fixtures/sessions.ts` with the payloads (worker phase) and a seed (candidate phase) that writes a run directory with: two lanes, `challenge-1`/`challenge-2` files, worker and repair files, a lane-review record per lane (server's round started repair 1, viewer's recorded with no fix round), a review with three reviewers (general blocked, coverage late blocked, critique approved) and an archived round, a `panel.json`, and a night-shift folder with one executed `challenge_paused` and one held `awaiting_approval` record for the run; plus an older run with one reviewer and no lane-review records. Register it with one line in `fixtures/index.ts`; set `MD_MANAGER_NIGHT_SHIFT_DIR` for the candidate server in `playwright.config.ts` under the test root. Copy shapes from the real run directory `~/.local/state/md-manager-workflows/projects-dispatch/projects-dispatch-002/` and `~/.local/state/md-manager-workflows/night-shift/`, never their paths, ids or texts.
- **Existing specs that walk the stage** (`ux-run`, `ux-refine`, `revamp-pages`, `reviewers`, `review`, `ux-review`, `panel`, `critique`, `lanes` and others that count `data-node-id` cards) will see the new reviewer nodes. Update each to the new count and the new cards, asserting at least what it asserted before ([O3]); never weaken an assertion, and never remove one without an equivalent.
- **A lane reviewer** (GPT 6.1) reviews your lane's diff after your checks pass. A P0/P1 from it starts one repair round of your lane; repairs are scarce (three per run), so run both phases of your specs and check each item against its words before you complete.
- **The look:** tokens in `src/projects/theme.css`, `DESIGN.md` and `PRODUCT.md`, the Signal Box conventions in `docs/VIEWER_SIGNAL_BOX.md`. Load the `impeccable` skill for layout and copy.

## Constraints

- Owned paths only (policy.json `viewer`). Do not edit `server`, `contracts`, `workflow`, `src/projects/controls`, `src/projects/CommandBlock.tsx`, `src/projects/ProjectsView.tsx`, `src/projects/routes.ts` or `src/App.tsx`: the new views are node pages, sheets and run-page sections on the existing URLs.
- Never claim what the data does not hold: "not recorded" for a missing fact; never render a transcript, an absolute path or a credential.
- Wrap localStorage reads and writes in try/catch. No new dependency.
- The browser check runs the whole `tests/project-workflows` config. The verifier refuses Playwright retries; do not add them. If an unrelated test (for example `controls.spec.ts` `controls-unavailable`) fails under load, report it in the completion's `untested` with the log line.

## Acceptance

- The browser scenarios in `policy.json` pass through `check-report` in both phases (worker: mocked routes; candidate: the real server on the seeded directories): `sessions-stage`, `sessions-lane-review`, `sessions-reviewer`, `sessions-list`, `sessions-panel`, `sessions-phone`. Each appears in exactly one test title as `[scenario:<id>]` with one `screenshot:<id>` attachment; the descriptions are the assertions. The existing specs pass too.
- `tests/unit/sessions.test.ts` covers the card model for reviewer, panel and lane review nodes, the Sessions grouping and total, the resume command text, and the night-shift block's wording (executed, held, Jev error).
- `frontend-build`, `frontend-lint`, `shared-contract` and `frontend-unit` pass; the handoff and `docs/VIEWER_SIGNAL_BOX.md` are updated.

Run targeted tests while iterating, then this lane's non-browser policy checks once before writing the completion; run browser specs only through check-report.

Browser checks: each scenario id appears in exactly one test title as `[scenario:<id>]`, and that test, when it passes, attaches exactly one image/png named `screenshot:<id>`. Before completing, run the spec files you changed with a JSON report:

```bash
WORKFLOW_VERIFICATION_PHASE=<worker|candidate> PLAYWRIGHT_JSON_OUTPUT_FILE=<tmp>/report.json \
  npx --no-install playwright test --config=tests/project-workflows/playwright.config.ts --reporter=json <spec files>
```

Then run the exact `check-report` command the controller appends to this task when it pins it.

## Stop

- Stop with a `question` completion when a page needs a field Appendix A or the run detail does not carry, or a fix needs a file another lane owns.
- Stop and report `blocked` when the `impeccable` skill is not available through the `Skill` tool.
- No actions on these pages (the run controls feature owns actions); no transcripts.
