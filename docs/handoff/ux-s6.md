# Handoff: viewer UX slice S6, the run lists and the served fields

Slice S6 of [PRD_VIEWER_UX.md](../PRD_VIEWER_UX.md) (4.1, 6.3, 6.4; section 11; tests 12.2 and 12.3), the `lists` lane of workflow run `viewer-ux-panels-lists-003`, beside the `panels` lane (S4c). `features/viewer-ux-panels-lists/decisions.md` binds it. Nothing outside the lane's owned paths changed; `contracts/projects/triage.ts`, `v1.ts`, `RunView.tsx`, `RunHeader.tsx`, `NodeHeader.tsx` and `WorkerInputs.tsx` are untouched.

Files: new `src/projects/lists.ts`, `RunRow.tsx`, `RunsHome.tsx`, `lists.css`, `tests/unit/lists.test.ts`, `tests/project-workflows/ux-lists.spec.ts`, this note; changed `src/projects/ProjectsView.tsx`, `api.ts`, `NowBanner.tsx`, `CommandBlock.tsx`, `LiveStatus.tsx`, `tests/project-workflows/fixtures/ux-lists.ts`, `tests/project-workflows/projects.spec.ts`.

## What shipped

**Pure rules** (`lists.ts`, no React, unit-tested):
- `workflowTitle(workflow, latestFeature)`: the reordered title rule of decisions.md. A name other than "Feature implementation" is the title; the generic name gives the latest run's `activity.feature`, else the `workflow_id`. Used for crumbs, the feature page heading, project-page group headers and Runs home rows.
- `homeSections(rows, now)`: Needs you (served `attention.kind` of `question`, `pane` or `approval`, longest waiting first), Running (every other unfinished run, latest activity first), Recent (finished runs whose `finished_at`, else `updated_at`, is within 7 days of now, newest first, no cap). A run is in one section only.
- `rowSummary` / `rowTime`: a row's second line and its time. Needs you: `ui asked a question · deadline paused`, `adapter needs attention in its pane`, `<step label> awaits your decision`. Stopped runs: `Failed at <headline>` (the served headline starts with the focus label). A finished run shows its finish, age and duration (`finished_at − created_at`); a live run its start, elapsed time and last activity. **Without `activity`** a row shows only its status and `updated <time> · <age>`: no finish, no duration, no Needs-you grouping, and no run detail is fetched.
- `recordReading` / `controllerSuffix`: the live chip's controller suffix. `running` from the first reading; `not_running` only once the readings have said so for at least 15 s (triage's `controllerNotRunning`); nothing for `unknown`, null or a run not running or paused.
- `servedDisagreement` / `servedNow`: when the Now banner reads the served activity over the export (below).

**Runs home** (`RunsHome.tsx`, `/projects`): heading with the live chip; `needs-you`, `running-runs`, `recent-runs` sections, each a `ul` of `RunRow`s with "Nothing waits on you." / "Nothing is running." / "No run finished in the last 7 days." when empty; an inline notice when some project or workflow list failed to load; then `projects-list`, one compact card link per project (`<id> · N features · last run <age>`). The read-only note (`projects-info`) stays on this page.

**RunRow** (`RunRow.tsx`): one `<a>` in an `<li>` with `data-run-id`, `data-status` and, while something waits on the operator, `data-attention` plus an amber ring and a `?` glyph (`aria-hidden`). The accessible name starts with the run id. Three parts: id + context (title · feature when it differs · project) + status badge; the time; the summary. At ≤760 px the grid becomes one column, so the three parts stack; rows are ≥44 px.

**Project page**: `workflows-list` is now a list of feature groups (`li[data-workflow-id]`): a header link to the feature's runs (`.projects-card-title` = title, then `workflow_id · N runs · N nodes · current revision …`, plus the definition name when the title replaced it) and the first page of that workflow's runs as `RunRow`s (`project-runs`). Runs of any age are listed here.

**Feature page**: `run-list` keeps an `li` per run (now `RunRow`), the "Load more runs" button is unchanged, and "Current definition" is a `<details data-testid="current-definition">` below the list, closed while the workflow has runs and open when it has none. Its summary carries the name, revision and node count.

**Served activity on the run page**, through `ServedRunContext` (declared in `LiveStatus.tsx`, provided by `ProjectsView.tsx` around `RunView`, the pattern of `TimeReferenceContext`): `{ detail, activity, runDir, controller readings }`. ProjectsView records one `{at: settledAt, value: activity.controller}` reading per successful detail poll.
- `LiveStatus`: `· controller running` or `· ▲ controller not running` (amber) with `data-controller`, on the run header and the node pages' run bar.
- `CommandBlock`: when `run_dir` is served and a command uses `$RUN`, a first copyable line `RUN=<run_dir>` (`command-run`, `run-dir-command`, button "Copy"/`copy-run-dir`) and a legend that says the first line sets RUN. It appears in the Now banner, in `node-next` and in the question panel, as decisions.md anticipates. The existing `now-command` / `copy-command` counts are unchanged.
- `NowBanner`: `servedNow` keeps the export-derived Now unless the server's live reading disagrees, then derives the situation from the served fields alone (`deriveNow({ detail, events: [], inputs: null, activity, controller })`):
  - `question-answered`: the export shows a waiting question, the served `waiting_questions` is 0 (the live `<lane>.questions.json` answered it);
  - `question-asked`: the served activity has a waiting question the export does not show, or for another lane;
  - `controller-stopped`: the run is running, the controller has read `not_running` for 15 s, and the export's situation comes after rule 5 (a question, pane, approval, paused challenge or interruption is never hidden). This gives rule 5 case (c).
  The "Open <focus> ›" link follows the re-derived focus.

**Loaders** (`api.ts`): `fetchRegistryRuns(projects, more)` and `fetchWorkflowRuns(projectId, workflows, more)` read run lists only, in parallel, keep per-project and per-workflow errors beside the other rows, and page while `more` (`readsNextPage`: the last run read is inside the 7-day window) says so.

**Requests.** Runs home, per 15 s poll: `1 + P + W` requests plus one per extra page (P projects, W workflows; a page is only read while its predecessor's last run is inside 7 days). The candidate registry (2 projects, 12 workflows in this lane's tree) makes 15 requests per poll. `/api/projects` is also polled every 5 s as before. No run detail, event, input or result request is made for a row. The project page makes 1 run-list request per workflow per 15 s besides its 5 s workflow-list poll.

## Fixtures (`fixtures/ux-lists.ts`)

Workflow `ux-lists` under the generic name "Feature implementation" (so its title is the runs' feature, "Runs home lists"), 8 runs around `LISTS_NOW = 2026-03-20T12:00:00Z`:

| Run | State | What it covers |
|---|---|---|
| `lists-asking` | running | ui's question 1 only in the live `ui.questions.json` (C5): Needs you `question`; banner `question` |
| `lists-answered` | running | export shows ui's question 1 waiting; live `ui.questions.json` answered it; adapter's `needs attention in its pane` event: Needs you `pane`; banner `pane_attention` |
| `lists-approval` | awaiting approval | manual run, handoff interrupt: Needs you `approval` |
| `lists-live` | running | Running; the worker mock serves `controller: running` |
| `lists-stopped` | running | `controller: not_running` in both phases: the 15 s debounce and rule 5 (c) |
| `lists-failed`, `lists-failed-earlier` | failed 1 and 3 days before | Recent, newest first; `52m51s` |
| `lists-old` | failed 10 days before | absent from Runs home, present on the project page |

Every running run logs `Automatic checkpoint controller PID 2000000000`, above any Linux `pid_max`, so the candidate server reads `not_running`. The seed returns `registry: { viewer: { expose_run_dir: ['alpha-project'] } }`; the temporary roots are outside `$HOME`, so the candidate serves `run_dir: null`. The worker mocks are contract 1.5.0 details with the activity the server computes from the same records (checked field by field against `RunStore` on a seeded root; the only intended difference is `lists-live`'s mocked `controller: running`) and `run_dir: ~/.local/state/agent-workflows/alpha-project/ux-lists/<run>`. `server/projects.test.ts` (which seeds every browser fixture and validates it) passes 52/52 with them.

## Red evidence

Written first and run against the unchanged product code (only `lists.ts` absent; `api.ts` had no behavioural change).

```
npx tsx --test tests/unit/lists.test.ts
Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…/src/projects/lists.ts' imported from …/tests/unit/lists.test.ts
ℹ tests 1  ℹ pass 0  ℹ fail 1
```

Browser, `ux-lists.spec.ts`, both phases, same first failures:

```
[scenario:runs-home]       ux-lists.spec.ts:38  expect(locator).toHaveAttribute("question")  Error: element(s) not found   (no needs-you section)
[scenario:served-activity] ux-lists.spec.ts:130 expect(run-now).toHaveAttribute('data-situation', 'pane_attention')  Received: "question"
2 failed   (worker and candidate)
```

A second red run with the same spec switched to soft assertions (a temporary edit of this lane's own spec, restored) listed every failing assertion, identical in both phases except the worker-only ones:
- runs-home: no `needs-you` rows (`question`, `pane`, `approval`, `awaiting_approval` not found; the run-id link count 0); the test then timed out on the missing sections.
- served-activity: `lists-answered` banner `question` with the answered question's text (`“Should the project cards show the number of features?”`) instead of the pane; `lists-asking` banner `running` instead of `question`; worker only: no `RUN=~/…/lists-asking` line, no `controller running` (chip read `● Live · updated 4 s ago`); both: no `▲ controller not running` after 16 s, banner `running` instead of `interrupted`, first command `attach-one` instead of `automatic "$RUN" --live`.
- Already green before the change: the chip did not say "controller not running" before 15 s (trivially), and in the candidate phase the `RUN=` line was absent.

## Green evidence

```
npx tsx --test tests/unit/lists.test.ts                                   ℹ tests 27  ℹ pass 27  ℹ fail 0
npm run test:unit                                                         ℹ tests 298 ℹ pass 298 ℹ fail 0
npx tsx --test server/projects.test.ts                                    ℹ tests 52  ℹ pass 52  ℹ fail 0
npm run build                                                             exit 0 (the existing >500 kB chunk warning)
npm run lint                                                              exit 0
WORKFLOW_VERIFICATION_PHASE=worker    playwright … ux-lists.spec.ts       2 passed
WORKFLOW_VERIFICATION_PHASE=candidate playwright … ux-lists.spec.ts       2 passed
WORKFLOW_VERIFICATION_PHASE=worker    playwright … projects.spec.ts       10 passed
WORKFLOW_VERIFICATION_PHASE=candidate playwright … projects.spec.ts       10 passed
```

The first green worker run of `ux-lists.spec.ts` failed once on a test-authoring mistake: `^lists-failed\b` also matched `lists-failed-earlier` (a hyphen is a word boundary). The patterns now end in `(?:\s|$)`.

Regression check beyond the targeted files, since rows and the project and feature pages are shared by other specs (`lanes.spec.ts`, `reviewers.spec.ts`, `ux-time.spec.ts`):

```
WORKFLOW_VERIFICATION_PHASE=worker    playwright --config=tests/project-workflows/playwright.config.ts   53 passed (6.1m)
WORKFLOW_VERIFICATION_PHASE=candidate playwright --config=tests/project-workflows/playwright.config.ts   53 passed (7.7m)
```

The verifier's report rules, on JSON reports of `ux-lists.spec.ts` and `projects.spec.ts` (12 tests each phase):

```
python -m workflow check-report ../policy.json lists report-worker.json      runs-home: ok, served-activity: ok, 12 passed
python -m workflow check-report ../policy.json lists report-candidate.json   runs-home: ok, served-activity: ok, 12 passed
```

The `panels` lane's fixtures (`ux-review.ts`) were empty in this tree, so the combined candidate adds their runs to Runs home; the tests assert only on `ux-lists` run ids and never on section counts (decisions.md).

## Migrations of `projects.spec.ts`

| Where | Change | Reason |
|---|---|---|
| `:149` `getByRole('group', { name: 'Current definition graph of Feature flow' })` | click `current-definition`'s `<summary>` first | the definition is a closed `<details>` while the workflow has runs, and role queries skip hidden content (PRD 12.3) |
| `:142` `run-list li` count 5 | unchanged | each `RunRow` is an `li` |
| `:148` `current-definition` contains `9 nodes`; `:277/283-284` the empty workflow | unchanged | textContent includes the closed summary; with no runs the details are open |
| `currentCrumb` assertions | unchanged | the fixture names are not the generic name |
| `projects-list` links (count 2), `workflows-list` links in order, `.projects-card-title` "Fixes" | unchanged | cards stay one link each; group headers are links with the title in `.projects-card-title` |

## Deviations and open assumptions

1. **The Now banner re-derives from served fields alone** when they disagree with the export (decisions.md routes `activity` to `NowBanner` through context, and `RunView` is not edited, so the banner has no events). The re-derived banner names the served question, pane or stopped controller but not the event-derived reason, and for a served question it cannot name the question's number or text (`activity` carries neither). `document.title`, the graph and Steps attention still come from `RunView`'s export-derived `deriveAttention`.
2. **Run pages title the workflow by their own run's feature** (a run page reads no run list); the lists and the feature page use the latest run's.
3. **Section order**: Needs you is longest-waiting first; Running is latest activity first. The PRD does not say.
4. **Needs-you wording** has no question number (`ui asked a question`): `activity` serves only the count and the node.
5. **Project page** reads the first run page per workflow (`N+ runs` when more exist) and shows runs of any age; its heading reads "<project>: features".
6. **Runs home's live chip** shows freshness of the list resource (`live` / `stale` / `hidden`) and no controller suffix.
7. **Paging** stops when the last run of a page was updated before the 7-day cutoff (decisions.md), so a still-running run last updated more than 7 days ago on a later page is not listed on Runs home; it stays on its project and feature pages.

## Follow-ups

- `activity` could carry the waiting question's number and text, so the banner and Needs-you rows need no re-derivation for the live-question case (contract change; owner of `v1.ts`).
- Add a `SEEDED_ACTIVITY` row for the `ux-lists` runs in `server/projects.test.ts` (owner of the server tests), as ux-s5.md suggested.
- `RunView` could pass `activity` and the controller readings into `deriveNow`/`deriveAttention` itself, which would also give `document.title`, the graph and Steps the served attention (S7 or a later slice; `RunView.tsx` is outside this lane).
