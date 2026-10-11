# Viewer worker: the Projects page, the project page, the rail and Triage (PRD_PROJECTS_DISPATCH)

## Goal

The operator opens the Projects tab and, as a user would:

1. **Sees every project at once:** `/projects` is the Projects page. It has one card per registered project, in rail order. Each card shows:
   - the state word ("1 of 3 features failed last" for a multi-feature project);
   - for a GitHub project, the repository and visibility;
   - `on <checkout>` with the sync, worded as PRD section 5 "Sync wording" says, the same on cards and headers ("2 ahead, 1 behind origin/main", "16 ahead of origin/main", "level with origin/main", "origin/dev at <sha>; no local dev to compare", "shares its clone with <primary>", "not compared with origin");
   - the non-zero run counts and the latest run;
   - open PRs and issues when GitHub was read, else "GitHub not read: <reason>".

   A card is one link to the project page.
2. **Uses a readable, projects-only rail:** on the Projects page, Triage, the project page and the workflow page, the rail shows "All projects" and "Triage", then only projects. Order: needs you, running, readable, unreadable, then by last activity.
   - Each row: a glyph, the name, a badge, and a sub-line (repository · features or "cannot be read" · date).
   - The badge: "N waits on you", "N paused", "N running", or "N unpushed" on the clone's primary only.
   - The current page is marked.
   - At 999px and below it becomes a chip row.
3. **Opens Triage:** `/projects/-/triage` shows today's Runs home content (needs you, today, running, paused, recent) unchanged, under the new rail. There are no keyboard chords ([P17]).
4. **Reads a project's header:** the repository link and visibility, checkout, sync line, figures, and jump buttons ("Runs by feature", "Local and GitHub", "Pull requests · N open", "Issues · N open") that move focus to their section.
5. **Reads where each run stopped:** the step chart has a sticky axis of eight phases and one group per feature. Each group has a header with landed shas, a chain line of run chips, and run rows whose track is solid up to the stop and dotted after it.
   - Lanes show as dots; `×N` marks attempts.
   - The state glyph sits at the stop.
   - At a chart width of 440px or less, multi-lane phases collapse to one mark.
   - The "ended here" counts sit under each group.
   - A feature that cannot be read shows its recorded error and the status command.
6. **Opens a run without losing the page:** selecting a run docks the reading pane: facts, steps, lead sentence, the commands to copy (today's `CommandBlock`), and "Open run page". Esc or Close undocks it and returns focus. j/k moves the selection. With nothing selected the page uses the full width.
7. **Reads GitHub truthfully:** the GitHub column holds four cards:
   - Local and GitHub: the sync in full, "origin/<b> last updated here <time>" and "this page never fetches", GitHub's default-branch head with its commit date (never "last moved"), "K name a run; N−K do not name a known run", and landings with unknown shown as unknown;
   - Pull requests ("showing the 20 most recently updated"): "Possibly related" (exact branch match only), "Yours, open", "Others, open", "Merged in the last 14 days" (among the 20 shown), each row with review decision, checks, draft, `head → base` and "updated <rel>";
   - Issues: "Assigned to you", "Newest from people", "N from bots among the newest 20", "All N on GitHub";
   - Also checked out as.

   When GitHub was not read, each card says "GitHub not read: <reason>" and shows no counts. When it was read but the latest refresh failed (`status: 'read'` with `reason`), the data shows with "Last read <time>; the latest refresh failed: <reason>".
8. **On a phone (390px):** chips replace the rail, the cards stack, the project page stacks, a tapped run fills the screen with "Queue" and "Next", every target is at least 44px, and nothing scrolls sideways.

`docs/PRD_PROJECTS_DISPATCH.md` sections 2 to 5 and Appendix A are the specification. `docs/design/projects-dispatch.html` is the approved visual reference: open it in a browser and read its script for the rules it settles. `features/projects-dispatch/decisions.md` wins over both. The critique reviewer walks these eight flows on the app `tests/project-workflows/dispatch-app.ts` starts, so write your `verify_yourself` lines as the steps a user takes there.

## Context

- **Routing:** there is no router library. `src/App.tsx` parses paths with `parseProjectsPathname` (`src/projects/routes.ts`: `ProjectsRoute`, `projectsPathname`, `projectPathname`, `workflowPathname`, `routeToPathname`, `PROJECT_ID_PATTERN`) and renders `ProjectsView` (`src/projects/ProjectsView.tsx`). Add a `triage` route for `/projects/-/triage` ([D1]).
- **Today's pages:**
  - `RunsHome` (`src/projects/RunsHome.tsx`) is the home page with the old rail (`projects-rail`, `railEntries`, `PREFIX_GROUP_MIN`, localStorage `mdm-rail-open`);
  - `ProjectRunGroups` is the project page;
  - the workflow page is inline in `ProjectsView`;
  - `src/projects/lists.ts` holds `homeSections`, `NEXT_STEP`, `projectTone`, `rowSummary`, `LISTS_POLL_MS`;
  - `src/projects/RunRow.tsx` is the run row.

  Reuse what fits; the run page (`RunView`, `signal/`) is not yours.
- **Data:**
  - **Existing API (`src/projects/api.ts`, not yours):** `fetchProjects`, `fetchWorkflows`, `fetchRegistryRuns` (run summaries, `activity`) and the definition per workflow.
  - **New:** `/api/dispatch/projects` and `/api/dispatch/projects/:p/steps` (PRD Appendix A). The `server` lane builds them in the same run, and lanes meet only at the candidate. So mirror Appendix A's types in `src/projects/dispatch/types.ts` and fetch through your own client in `src/projects/dispatch/`. Poll the overview at `LISTS_POLL_MS`.
  - **Worker phase:** mock `/api/dispatch/**` in your spec, or in `mock.ts`, with payloads built from Appendix A.
  - **Candidate phase:** the real server serves them. `tests/project-workflows/playwright.config.ts` must give the API `MD_MANAGER_GITHUB_FIXTURE` and `MD_MANAGER_GITHUB_CACHE`, both files under the test root ([P20]). The server reads the fixture before it listens, so the first response is `read`.
  - **Seed:** today `seed.ts` points every project at one shared non-git `repository`, and `UxSeed` modules add workflows only. Add new registry projects, each with its own repository, in `tests/project-workflows/fixtures/dispatch.ts` (extend `fixtures/index.ts` and `seed.ts` so a fixture module can add projects) ([P16]). The repositories, created with real `git` under the test root:
    - a bare repository as the origin: clone from it, then set `origin`'s URL to `https://github.com/acme/widgets.git`. The server never fetches, so the URL is only parsed, and the remote-tracking reflog comes from the clone and the seed's own fetch from the bare path;
    - a primary clone 2 ahead and 1 behind with no waiting runs, whose integrated runs land one sha on local main and one on origin;
    - a `git worktree` of it registered as a second project;
    - a project whose remote is not GitHub;
    - a project with no origin ref;
    - a project with three features whose worst latest result is failed;
    - an unreadable project.

    Registry paths are absolute (no `~`).

    Tests run with `HOME` isolated, so create every repository with `git init -b main` (`--initial-branch=main` for the bare one) and commit with explicit `-c user.name=… -c user.email=…` ([L2]). `seedCandidate` is also called by `tests/project-workflows/controls-app.ts`, which sets no GitHub fixture or cache: add the dispatch projects only behind an explicit `seedCandidate` option (or a separate seed function) that only `playwright.config.ts` and `dispatch-app.ts` pass, both with `MD_MANAGER_GITHUB_FIXTURE` and `MD_MANAGER_GITHUB_CACHE` set. `controls-app.ts`'s call must seed no git repository ([L2]).
- **Run controls:** the run-controls work (run-controls-004) is in this base. Leave `src/projects/controls/`, `CommandBlock.tsx` and the run page alone. The reading pane shows `CommandBlock` as it is ([D7]).
- **Existing specs:** specs that open the Runs home must move to Triage:
  - `revamp-lists.spec.ts`, `ux-lists.spec.ts` (`[scenario:runs-home]`), `projects.spec.ts`, `lanes.spec.ts`, `revamp-pages.spec.ts`;
  - `support.ts` (`projectsUrl`).

  Update their URLs and rail selectors; keep what they assert about the Runs home content.
- **Specs and tests you do not own still pass unchanged ([L1]):**
  - `tests/project-workflows/accepted.spec.ts:73-76` opens `projectUrl(<project>)` and expects `li[data-workflow-id="<w>"] a.lists-group-head` to carry the feature's `tone-*` class, `tone-(override|fail|idle)` and never `tone-ok` when the latest run was accepted (today `RunsHome.tsx:344-346`, `toneClass(stateTone({ status, accepted }))`). Each step-chart feature group is therefore an `li[data-workflow-id=<w>]` whose header is an `a.lists-group-head` carrying that tone class. List this hook in `docs/VIEWER_DISPATCH.md`.
  - `tests/unit/accepted.test.ts` imports `homeSections`, `projectTone`, `rowSummary`, `rowTime`, `waitingKind`, `filterRecent` and `isFinished` from `src/projects/lists.ts`. Keep those exports with their signatures.
  - Before you complete, run `rg -n "projectUrl\(|projectsUrl|lists-group-head|data-workflow-id|projects-rail|from '.*src/projects/(lists|routes|RunsHome)" tests/` and check that every hit outside your owned paths still passes. A hit you cannot keep passing is a `question` completion. Keep the existing test ids where the meaning is the same (`projects-workspace`, `needs-you`, `running-runs`, `recent-runs`, `today-runs`, `run-list`). Write a short DOM contract for the new pages in `docs/VIEWER_DISPATCH.md` (test ids and structure), like `docs/VIEWER_SIGNAL_BOX.md`.
- **The critique app** (policy `critique_app`): `npx --no-install tsx tests/project-workflows/dispatch-app.ts` runs in the candidate worktree with `CRITIQUE_WEB_PORT` and `CRITIQUE_API_PORT` set. It:
  - creates a temporary root, seeds the same registry, runs, git repositories and GitHub fixture as your candidate fixtures, with `MD_MANAGER_GITHUB_CACHE` under the root;
  - exits non-zero unless `/api/dispatch/projects` lists every seeded project and every fixture repository reads `status: 'read'` ([P6]);
  - starts `npm run start:api` on `$CRITIQUE_API_PORT` and `npm run dev:web` on `$CRITIQUE_WEB_PORT`;
  - prints the Projects, project and Triage URLs;
  - forwards SIGTERM/SIGINT and removes the root on exit;
  - is ready at `/api/dispatch/projects`.
- **Step-to-phase map ([L2], changes [P22]):** match `node_id` first, `kind` only as the fallback. Recorded definitions give the sidecar `kind: review` and repair nodes `kind: worker`, so kind first would put them in the wrong columns. Rules: `challenge`; `launch_*` and `sidecar` → Launch; `handoff`; `verify_*`; `candidate*`; `review*`, `attack*`, `critique*`, `panel*` → Review; `approval`; `integrate`; `repair-*` → Verify; then `kind`; else Verify. Match the mock-up's own map (`docs/design/projects-dispatch.html`, around lines 1004-1013) where it is more specific.
- **Landings on neither ref ([L2]):** integration fast-forwards the run's `source_branch`, not the default branch, so an integrated run can read `on_default: false, on_origin: false`. Word that as "not on local <d> or origin/<d>; integrated into <source_branch>", never as "not landed". Add an `on_source` landing field to the handoff's follow-ups.
- **The look:** tokens in `src/projects/theme.css`, `DESIGN.md` and `PRODUCT.md`. Load the `impeccable` skill for the pages' design and copy, and match the reference's hierarchy, spacing and wording.

## Constraints

- Owned paths only (policy.json `viewer`). Do not edit `server`, `contracts`, `src/projects/api.ts`, `src/projects/controls`, `src/projects/signal`, `src/projects/CommandBlock.tsx` or `workflow`. A field or route you need that Appendix A lacks is a `question` completion.
- Never claim what the data does not hold: "not recorded", "GitHub not read: <reason>", "update time not recorded", unknown landings shown as unknown. Never render an absolute path: `support.ts` `renderedText` must pass on every new page.
- Wrap localStorage reads and writes in try/catch.
- No new dependency.

## Acceptance

- The browser scenarios in `policy.json` pass through `check-report`: `dispatch-overview`, `dispatch-rail`, `dispatch-triage`, `dispatch-project`, `dispatch-chart`, `dispatch-pane`, `dispatch-github`, `dispatch-git-truth` and `dispatch-phone`.
  - Each appears in exactly one test title as `[scenario:<id>]`, with one `screenshot:<id>` attachment; the descriptions are the assertions.
  - They pass in both phases: worker (mocked routes) and candidate (the real server, seeded repositories, the GitHub fixture).
  - The migrated existing specs pass too.
- Unit tests in `tests/unit/dispatch.test.ts` cover:
  - the step-to-phase map, including sidecar, attack, critique, panel and repair: `sidecar` (kind review) → Launch and `repair-1` (kind worker) → Verify;
  - the wording of a landing that is false on both refs;
  - rail order and badge words;
  - the card state word;
  - PR grouping (possibly related by exact branch only) and issue grouping (bots folded);
  - the relative time adding the year;
  - sync wording for diverged, ahead, behind, level, no local branch, shared clone, no origin and git unavailable.

  `tests/unit/routes.test.ts` covers the `triage` route, and that no project id can produce `/projects/-/triage`.
- `tests/project-workflows/dispatch-app.ts` starts the app on the two ports and `/api/dispatch/projects` answers 200. Run it once by hand and say so in the handoff.
- `frontend-build`, `frontend-lint`, `shared-contract` and `frontend-unit` pass. `docs/handoff/projects-dispatch-viewer.md` says what changed and every open P2.

Run targeted tests while iterating, then this lane's non-browser policy checks once before writing the completion; run browser specs only through check-report on this lane's own specs.

Browser checks: each scenario id appears in exactly one test title as `[scenario:<id>]`, and that test, when it passes, attaches exactly one image/png named `screenshot:<id>` (other attachments are fine). The verifier refuses anything else. Before completing, run the spec files you changed with a JSON report:

```bash
WORKFLOW_VERIFICATION_PHASE=<worker|candidate> PLAYWRIGHT_JSON_OUTPUT_FILE=<tmp>/report.json \
  npx --no-install playwright test --config=tests/project-workflows/playwright.config.ts --reporter=json tests/project-workflows/dispatch.spec.ts
```

Then check the report with the verifier's own rules: run the exact `check-report` command the controller appends to this task when it pins it.

## Stop

- Stop with a `question` completion when a page needs a field or route that Appendix A does not define, or when the pages cannot be built without changing a file another lane owns.
- Stop and report `blocked` when the `impeccable` skill is not available through the `Skill` tool.
- Do not change the run page, node pages or assignment page. Do not add run controls to these pages. Do not add a synthetic "example" mode.
