# Viewer worker, run 003: close run 002's open review findings on the project page (PRD_PROJECTS_DISPATCH)

## Goal

Runs projects-dispatch-001 and 002 built the Projects page, the rail, Triage and the project page, and they are in your base (cb5af748, run 002's candidate, after its three repairs): `src/projects/dispatch/`, `tests/project-workflows/dispatch.spec.ts`, `fixtures/dispatch.ts`. Run 002's independent review blocked the candidate on four viewer defects; the critique reviewer approved it. `features/projects-dispatch/review-002.md` holds every finding verbatim. Fix the items below, keep what works, and make each one provable by a browser scenario or a unit test that fails without it. This is a small run: change only what these items need.

**The four open P1s:**

1. **V23 (P1) The docked layout follows the space it has, not a guessed viewport width.** `dispatch.css:77` restores the GitHub column beside the chart at `@media (min-width: 1680px)`, but its arithmetic (`main = viewport - 322`) leaves out the Projects workspace's border and padding (`App.css` `.workspace-projects`, 2 + 32 px), so the chart is still under 480 px just above 1680 px. Decide the column count from the project body's own width with a container query (the chart already uses `@container dispatch-chart`), so that three columns appear only when the chart keeps at least 480 px, whatever the shell around it. A container query never styles the container itself, so wrap the body in its own element in `ProjectPage.tsx` with `container-type: inline-size; container-name: dispatch-body`, set the body's two-column template (chart and GitHub column) under `@container dispatch-body (min-width: 876px)` (480 + 16 + 380), and delete the `@media (min-width: 1680px)` rule ([L12]). Scenario `dispatch-dock`: also at 1600, 1680, 1720 and 1760 px, and at each width either the GitHub column sits under the chart or the chart's box is at least 480 px wide; at 1280 and 1440 px the GitHub column is under the chart, and at 1920 px it is beside it.
2. **V24 (P1) A commit that names an older run says so instead of claiming a link** ([L10]: no API change). The fallback in `ProjectPage.tsx:166-172` assumes the steps route carries every run directory; it returns the newest 50 per workflow (`server/dispatchSteps.ts`), the same set as the registry's first page. Resolve a run's workflow from the run lists and the steps, and, when the project has exactly one workflow, from that workflow. When none of these knows the run, show the run id as plain text with "older than the newest 50 runs" (visible text, not only a `title`), never a dead or guessed link. Landings carry `workflow_id` and always link. Correct the false comment. The single-workflow fallback can mislink a run of a clone mate (a shared clone such as Widgets and its worktree project): name that in the handoff as an open P2 ([L12]). A unit test in `tests/unit/dispatch.test.ts` covers the three cases (known from the run lists, single-workflow project, unknown on a multi-workflow project).
3. **V25 (P1) "Needs you and running" never gives an all-clear it cannot know** (V5). `ProjectsView.tsx:322` passes `[]` while the run lists load and after their request fails, and `fetchWorkflowRuns` (`src/projects/api.ts`, not yours) returns a workflow whose run list failed as `{runs: [], error}`, which `ProjectPage.tsx:180-182` ignores. Pass the run lists' state to the page (loading, failed with a reason, ready) and say:
   - while loading: "Reading runs…";
   - when the request failed, or every workflow's run list failed: "Runs not read: <reason>" (the reason is `describeApiError` of the first failed workflow; `fetchWorkflowRuns` turns each workflow's failure into `{runs: [], error}` and rejects only on abort, so "every workflow failed" is how a failed request reaches the page) ([L12]);
   - when every workflow's runs were read and none waits or runs: "Nothing waits on you; nothing running." (unchanged);
   - when some, but not all, workflows' run lists failed: the waiting and running runs of the readable ones, or "Nothing waits on you; nothing running", followed in both cases by " · N feature(s) cannot be read".
   Scenario `dispatch-sections`: Trio (whose `trio-locked` workflow cannot be listed, [P34]) never shows the plain all-clear and says "1 feature cannot be read"; the Busy links carry the `href` of each run page; in the worker phase, a run-list request held open shows "Reading runs…", and failing every `/runs` request of one project shows "Runs not read: <reason>" and no all-clear (route interception in the spec is fine). The Widgets assertion follows what its seed's run lists actually return in each phase; do not weaken it to a substring that the qualified line would also match.
4. **V26 (P1) A successful GitHub read with no head is not "GitHub not read".** `GithubColumn.tsx:131-139` renders "GitHub not read: {reason}" whenever `read && github.head` is false; Appendix A allows `status: 'read'` with `head: null` (an empty repository, `server/dispatchGithub.ts:145-146`). With `status` read and no head, the card says "GitHub's <github.default_branch> has no commits" when `github.default_branch` holds a name, and "GitHub's default branch has no commits" when it is null (an empty repository has no `defaultBranchRef`; never fall back to the local branch name), and keeps the PR and issue data and counts ([L12]). A unit test covers four cases (read with head; read without head, branch named; read without head, branch null; not read); `dispatch-github` asserts it in the worker phase from the mocked overview (a repository read with `head: null`); the GitHub fixture file is unchanged ([P35]).

**Small fixes the critique and the lane reviewer named (P2):**

5. **V27** The reading pane's NEXT STEP shows each sentence once: when the CommandBlock already states the lead (ui-polish-001's "Nothing required by the workflow. Merging or pushing is your decision."; Busy ship-001's "Import the independent review" before "Likely next step — import the independent review"), drop the duplicate lead. `dispatch-pane` asserts the lead text appears once and that the CommandBlock's command text equals the run's `NextStep` command for the selected run (by value, from the mock's run detail and the run page's own rendering).
6. **V28** Escape and Close on the "Local commits" pane return focus to the "Commits ahead and landings" button, as the run pane returns it to the row. `dispatch-ahead` asserts `toBeFocused` after each.
7. **V29** GitHub card wording: "3 open", never "3 opens"; the PULL REQUESTS heading does not wrap at 1100 or 1440 px; a landed sha in a run row never breaks mid-sha (`white-space: nowrap` on the sha). `dispatch-github` and `dispatch-chart` assert the wording and that the heading and sha each sit on one line.
8. **V30** A run filter that matches nothing in a feature says "0 of N runs match" in that group's header, not "0 runs". `dispatch-chart` asserts it on ui-polish.
9. **V31** `dispatch-phone`'s 44 px scan also covers the open reading pane (Close, Open run page, Queue, and the CommandBlock's buttons), measured before "Queue" closes it.
10. **V32 The handoff.** `docs/handoff/projects-dispatch-viewer.md` says what run 003 changed, keeps every still-open P2 from `review-002.md` that this run does not fix, and the `on_source` follow-up. `docs/VIEWER_DISPATCH.md` lists any new test ids.

`docs/PRD_PROJECTS_DISPATCH.md` sections 2 to 5 and Appendix A are the specification, `docs/design/projects-dispatch.html` the approved look ([O4]), and `features/projects-dispatch/decisions.md` wins over both. The critique reviewer walks the flows of runs 001 and 002 plus these fixes on the app `dispatch-app.ts` starts, so write your `verify_yourself` lines as the steps a user takes there.

## Context

- **Your base has the pages and their specs.** Read `src/projects/dispatch/` (`ProjectPage.tsx`, `GithubColumn.tsx`, `ReadingPane.tsx`, `AheadPane.tsx`, `StepChart.tsx`, `dispatch.css`), `src/projects/ProjectsView.tsx`, `tests/project-workflows/dispatch.spec.ts`, `fixtures/dispatch.ts`, `docs/VIEWER_DISPATCH.md` and `docs/handoff/projects-dispatch-viewer.md` before changing anything.
- **Data:** `src/projects/api.ts` (not yours) and `src/projects/dispatch/client.ts` (yours). Types mirror Appendix A in `src/projects/dispatch/types.ts`. Appendix A is frozen ([L4], [L10]); the `server` lane changes only tests in this run.
- **Seeds and mocks:** extend `tests/project-workflows/fixtures/dispatch.ts` and the worker-phase mock only as the items need. The candidate seed keeps every count other scenarios assert. Repositories are created with `git init -b main` and an explicit `-c user.name=… -c user.email=…`.
- **Specs and tests you do not own still pass unchanged ([L1]):** `tests/project-workflows/accepted.spec.ts` and `tests/unit/accepted.test.ts`. Before you complete, run `rg -n "projectUrl\(|projectsUrl|lists-group-head|data-workflow-id|projects-rail|from '.*src/projects/(lists|routes|RunsHome)" tests/` and check that every hit outside your owned paths still passes.
- **Run controls:** leave `src/projects/controls/`, `CommandBlock.tsx` and the run page alone; the pane imports `CommandBlock` as it is ([D7]).
- **A lane reviewer** (GPT 6.1) reviews your lane's diff after your checks pass, before the candidate. A P0/P1 from it starts one repair round of your lane. Repairs are scarce (three per run; run 002 spent all three), so run both phases of your specs and check each item against its words before you complete.
- **The look:** tokens in `src/projects/theme.css`, `DESIGN.md` and `PRODUCT.md`. Load the `impeccable` skill for layout and copy.

## Constraints

- Owned paths only (policy.json `viewer`). Do not edit `server`, `contracts`, `src/projects/api.ts`, `src/projects/controls`, `src/projects/signal`, `src/projects/CommandBlock.tsx` or `workflow`. A field or route you need that Appendix A lacks is a `question` completion.
- Never claim what the data does not hold: "Runs not read", "GitHub not read: <reason>", "update time not recorded", "git not read", "older than the newest 50 runs", unknown landings shown as unknown. Never render an absolute path.
- Wrap localStorage reads and writes in try/catch. No new dependency.
- Do not weaken an existing assertion to make it pass; a test you change must still check the behaviour its scenario describes (run 002's review blocked on two weakened assertions).
- The browser check runs the whole `tests/project-workflows` config, including `controls.spec.ts`, whose `controls-unavailable` test timed out once under load in run 001. The verifier refuses flaky retries, so do not add Playwright retries; if that test fails in your runs, report it in the completion's `untested` with the log line, and do not edit it ([L7]).

## Acceptance

- The browser scenarios in `policy.json` pass through `check-report`, in both phases (worker: mocked routes; candidate: the real server, seeded repositories, the GitHub fixture). Each appears in exactly one test title as `[scenario:<id>]`, with one `screenshot:<id>` attachment; the descriptions are the assertions. Run both phases yourself on your final revision before completing.
- `tests/unit/dispatch.test.ts` adds V24's run-link resolution and V26's head-line cases.
- `docs/handoff/projects-dispatch-viewer.md` and `docs/VIEWER_DISPATCH.md` are updated (V32).
- `frontend-build`, `frontend-lint`, `shared-contract` and `frontend-unit` pass.

Run targeted tests while iterating, then this lane's non-browser policy checks once before writing the completion; run browser specs only through check-report on this lane's own specs.

Browser checks: each scenario id appears in exactly one test title as `[scenario:<id>]`, and that test, when it passes, attaches exactly one image/png named `screenshot:<id>` (other attachments are fine). The verifier refuses anything else. Before completing, run the spec files you changed with a JSON report:

```bash
WORKFLOW_VERIFICATION_PHASE=<worker|candidate> PLAYWRIGHT_JSON_OUTPUT_FILE=<tmp>/report.json \
  npx --no-install playwright test --config=tests/project-workflows/playwright.config.ts --reporter=json tests/project-workflows/dispatch.spec.ts
```

Then check the report with the verifier's own rules: run the exact `check-report` command the controller appends to this task when it pins it.

## Stop

- Stop with a `question` completion when a page needs a field or route that Appendix A does not define, or when a fix cannot be made without changing a file another lane owns.
- Stop and report `blocked` when the `impeccable` skill is not available through the `Skill` tool.
- Do not change the run page, node pages or assignment page. Do not add run controls to these pages. Do not add a synthetic "example" mode.
