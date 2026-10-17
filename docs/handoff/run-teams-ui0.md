# Handoff: run-teams lane C0, frontend scaffold (routes, switcher, clients, mocks, tones)

Branch `rt/ui`, worktree `/home/agentops/dev/md-manager-rt-ui`. Spec: `docs/PRD_RUN_TEAMS.md` sections 2, 8, 10 and 11 (P0 item 1). No contract changed.

## What is built

- **Routes** (`src/projects/routes.ts`). `RUN_TABS`/`RunTab` = `'run' | 'team' | 'github' | 'assignment'`. Added `TEAM_SEGMENT`, `GITHUB_SEGMENT`, `teamPathname()`, `githubPathname()` and `runViewPathname(p, w, r, tab)`. They parse beside Assignment, and an extra segment, another spelling or a view under a node is malformed.
  - **Team selection.** `TeamQuery` = `{session, workflow, agent, state, phase, q}`. `parseTeamQuery(search)` checks each value's shape: a bad value reads as absent, and unknown keys are ignored. `teamQuerySearch(query)` writes the keys in a fixed order and never writes defaults. `teamHref(p, w, r, query)` builds a link and `splitHref(href)` splits one.
  - **Search on the route.** `parseProjectsPathname(pathname, search?)` attaches `teamQuery` to a Team route only when it is given the search. App still parses the pathname alone, and `routeToPathname` never writes the search.
  - **`TeamQueryMode`** is `'push' | 'replace'`.
- **Switcher** (`src/projects/RunViews.tsx` and `src/projects/runViews.css`).
  - Markup: `<nav aria-label="Run views" data-testid="run-views">` holding four `AppLink`s (`data-testid="run-view-link"`, `data-view`). The current one has `aria-current="page"` and a 3 px accent bar. Each link's accessible name is `"{Label} view[, {suffix.spoken}]"`.
  - Suffixes come from the `suffixes={{team, github}}` prop, each a `Suffix` (`{tone, word, spoken}`, defined in `tone.ts`). A suffix shows a `Glyph` and the word. Words over 24 characters get an ellipsis, with the full text in `title`. On phones only the glyph shows.
  - **Phone layout (≤720 px):** a 4-column grid with 44 px links. On the identity line the row runs edge to edge (`margin: 2px -12px`, tracking −0.02em, no padding) so that "Assignment" fits a quarter of a 390 px screen. The `run-views-phone` scenario asserts that no label is cut.
  - **Node pages:** `RunBar` takes `views` and renders `<RunViews current={null} plain>`, giving four plain links with no suffix and no `aria-current`.
  - **Identity line:** `IdentityLine` takes `views: ReactNode` in place of `other`. It renders where the pill was, after `.sb-fresh` and before `ControlsMenu`. The `.sb-other` CSS is gone.
  - **Accessibility:** the Assignment tablist and its dangling `aria-controls="run-panel-run"` are gone.
- **RunView** (`src/projects/RunView.tsx`).
  - **Views:** branches for `team` and `github`. Each renders the identity line with the switcher, then `<GlyphDefs />`, a visually hidden `<h2 id="run-view-title" tabIndex={-1}>`, then `TeamView` or `GithubView`. Assignment and Run have the hidden h2 too.
  - **Focus:** focus moves to `#run-view-title` whenever `tab` changes and no node page is shown. Coming back from a node page to the Run view still focuses the step's card.
  - **Assignment:** `AssignmentPanel` now gets `tabId="run-view-title"`, so its `aria-labelledby` resolves.
  - **Teams resource:** `teams:<run>` from `orNotRecorded(fetchTeams, NOT_RECORDED.teams)` on its own `usePoll`. It polls every 5 s while the run is live and the Team view or a worker's node page is open, and every 15 s otherwise. It stops when the run is succeeded or cancelled and `totals.workflows_running === 0`.
  - **GitHub resource:** `run-github:<run>` from `orNotRecorded(fetchRunGithub, NOT_RECORDED.runGithub)` on its own `usePoll`. It polls every 60 s on the GitHub view and every 120 s elsewhere, and keeps going after the run finishes.
  - **Suffixes:** computed by `teamSuffix(teamsData)` and `githubSuffix(runGithubData)`.
- **Stubs** for the two view lanes:
  - `src/projects/teams/TeamView.tsx` exports `TeamView` and `TeamViewProps`. Props: scope, detail, inputs, sessions, teams Resource + teamsMeta + onRetryTeams, review, now, clock, zone, live, query, onQuery(query, mode), nodeHref, onNavigate, onAnnounce.
  - `src/projects/github/GithubView.tsx` exports `GithubView` and `GithubViewProps`. Props: scope, detail, inputs, sessions, teams, runGithub Resource + runGithubMeta + onRetryRunGithub, review, now, clock, zone, live, nodeHref, onNavigate, onAnnounce.
  - Bodies are minimal: `data-testid="team-view"` and `"gh-view"`, each with an `h3`.
- **Models.**
  - `src/projects/teams/model.ts`: `teamSuffix` is complete per section 2. `{n} running[ · {f} failed]` (run), else `{f} failed` (fail), else `interrupted` (pause) when a workflow is interrupted and none runs, else `{a} agents` (no tone). It returns none when teams is null or `sessions_with_teams === 0`. A workflow that runs with no running agent also falls to `{a} agents`.
  - `src/projects/github/model.ts`: `githubSuffix` is **provisional**, all untoned. It returns `reading` while pending, `#n` when a PR exists, else the push word, and null when the read is not served.
- **Clients** (`src/projects/api.ts`).
  - New paths: `paths.teams`, `paths.runGithub` (the dispatch path), `paths.githubActions` and `paths.githubAction`.
  - `fetchTeams` uses `validateTeams` and checks `run_id`. `fetchRunGithub` uses `runGithubSchema` and checks project, workflow and run.
  - New codes `NOT_RECORDED.teams` and `NOT_RECORDED.runGithub`, both `'NOT_FOUND'`. That is the catch-all 404 of an older server's projects and dispatch scopes; it loads as null, meaning "not served".
  - `fetchGithubActions(scope, token, signal)` and `postGithubAction(scope, actionId, body, token, signal)` send the `X-MDM-Control-Token` header and throw the controls client's `ControlError`. An unreachable server is `NETWORK`, a server error keeps the server's code (`STATE_CHANGED`, `TOKEN_INVALID`…), and an answer outside the contract is `UNKNOWN` with what did not match. The POST body is validated with `githubActionRequestSchema` and the answer with `githubActionResponseSchema`; the function returns the record.
- **ProjectsView** (`src/projects/ProjectsView.tsx`).
  - Its `onNavigate` now accepts an href with a search (`/team?session=worker:ui`). It navigates to the pathname, then writes the search into the entry it arrived at through `onSearch`.
  - It computes `teamQuery` from `search` on Team routes and passes `teamQuery` and `onTeamQuery` to `RunView`.
  - It has a new optional prop, `onPushSearch(pathname, search)`; see "Integrator must wire" below.
- **Tones** (`src/projects/tone.ts`): `agentTone`, `workflowTone`, `phaseTone`, `pushTone`, `prTone`, `checkTone` (each returns `{tone, word}`, per the section 8 table) and `precedenceTone(tones)` (fail > run > pause > ok > idle). `prTone` takes `{state, draft, mergeable?, review_decision?}`.
- **Mocks and fixtures.**
  - `fixtures/index.ts` has new `UxPayloads` keys `teams`, `runGithub` and `runGithubActions`, merged into the exported `teamsByRun`, `runGithubByRun` and `runGithubActionsByRun`.
  - `mock.ts`:
    - `/teams` answers the payload, or 404 `NOT_FOUND` when there is none.
    - The dispatch route `/projects/:p/workflows/:w/runs/:r/github` answers the payload when p and w match, else 404 `NOT_FOUND`.
    - `installControlMocks` handles `GET …/github`: the offers, with the records this page posted put in front.
    - `POST …/github/:action_id` answers a canned `succeeded` record. It answers 409 `STATE_CHANGED` when `state_token` differs from the payload's, and 422 `NOT_AVAILABLE` for an unavailable action. Every POST is pushed to `ControlMock.githubPosts`, and `failNext('github:<id>', …)` makes the next one fail.
  - One fixture module, `fixtures/run-views.ts`: the example `teams` and `runGithub` on core run `run-succeeded`. It has worker-phase payloads only and no seed.
- **Test helper:** `support.ts` gained `runViewLink(scope, view)`.

## Integrator must wire

1. **Push for the Team selection (App.tsx, which this lane does not own).** `ProjectsView` calls `onPushSearch(pathname, search)` for `onTeamQuery(query, 'push')` when App passes it. Without it, opening an agent replaces the entry instead of pushing, so Back would not close the drawer. A minimal App change, next to `replaceListSearch`:
   ```ts
   const pushListSearch = useCallback((pathname: string, search: string) => {
     guardLeave(() => {
       if (canonicalPathname(window.location.pathname) !== canonicalPathname(pathname)) return
       writeHistory({ search }, window.location.pathname, false, search)
       setProjectsSearch(search)
     })
   }, [guardLeave, writeHistory])
   // <ProjectsView … onSearch={replaceListSearch} onPushSearch={pushListSearch} … />
   ```
   Back to the previous entry already restores its search (`popstate` sets `projectsSearch` from `window.location.search`).
2. **Assignment panel role.** `AssignmentPanel` still renders `role="tabpanel"` with no tablist (`Assignment.tsx` is not owned here). Its `aria-labelledby` now points at `#run-view-title`. A follow-up should change the role to a plain `<section>`.
3. **Teams poll while a step sheet is open.** Section 2 asks for 5 s polling while "a worker sheet is open". The sheet's state lives inside `SignalRun`, so the scaffold polls fast only on the Team view and on a worker's node page. The Team lane can lift the sheet state, or add a callback, if it needs the sheet case too.
4. **Hidden view heading.** `RunView` already renders `h2#run-view-title` ("Team", "GitHub"). The Team and GitHub views should not add another `h2` with that id. Section 3.1's visually hidden "Team" h2 is this one.

## Tests (all run on cryotrack in this worktree, worker phase)

- `npx --no-install tsx --test tests/unit/routes.test.ts tests/unit/tone.test.ts tests/unit/steps.test.ts tests/unit/typeFloor.test.ts`: 90 passed.
- `npx --no-install tsx --test tests/unit/*.test.ts`: 658 passed. This was an extra check, since several unit tests scan the source.
- `npx --no-install tsc -b`: clean. `npx --no-install eslint` on every changed or new file: clean.
- `playwright … run-views.spec.ts`: 2 passed (`run-views-switcher`, `run-views-phone`). Each attaches one `screenshot:<id>`.
- `playwright … ux-run.spec.ts revamp-pages.spec.ts inputs.spec.ts lanes.spec.ts guardrails.spec.ts projects.spec.ts ux-refine.spec.ts`: 53 passed and 1 failed. The failure was `narrow-run`, fixed as below and then passed when re-run alone.
- `playwright … controls.spec.ts review.spec.ts ux-time.spec.ts sessions.spec.ts`: 35 passed.
- The candidate phase was not run, and neither were `npm run build` or the whole browser suite; the verifier runs those.

## Spec changes to existing tests (deliberate)

- **Selectors.** `tab-assignment` / `tab-run` / `run-graph-link` became `runViewLink(page, 'assignment' | 'run')` in lanes, ux-refine, guardrails, projects, inputs, ux-run and revamp-pages.
  - `assignment-routed` and `run-assignment` now assert links with `aria-current` instead of a tablist with `aria-selected`. Their keyboard part is Tab/Enter on links (the arrow-key tab pattern is gone), plus Back/Forward and focus on `#run-view-title`.
  - `run-assignment` checks `aria-labelledby="run-view-title"` and that nothing carries `aria-controls="run-panel-run"`.
- **`narrow-run` (ux-run.spec.ts).** At 390×844 the switcher's own 44 px row, required by section 2, pushes the bottom of the banner's box about 53 px below the first screen. The commands under "Likely next step" now continue below the fold. The assertion now checks that the banner's headline (`now-headline`) is in the first screen. This trades away part of the old first-screen guarantee; the operator may want to win back a row elsewhere on the phone identity line, for example the Details summary's own 44 px row.

## Known gaps

- `githubSuffix` is provisional; the GitHub lane implements the section 4.2 table.
- On a 1440 px desk the identity line wraps: the switcher, with its suffixes, starts its second row, ahead of the branch and Details. The DOM order still follows the spec.
- No candidate-phase seed for teams or GitHub. In the candidate phase the switcher spec checks the links, focus and history, but not the suffix words.
