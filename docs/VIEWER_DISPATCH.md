# The Projects dispatch pages (projects-dispatch-001)

The dispatch slice (docs/PRD_PROJECTS_DISPATCH.md, `features/projects-dispatch/decisions.md`): a Projects page of cards, a
projects-only rail, Triage (the former Runs home), and a dedicated project page with a step chart, a GitHub column and a
reading pane. The viewer code lives in `src/projects/dispatch/`; the look is the Signal Box world (`src/projects/theme.css`,
`DESIGN.md`), styled by `src/projects/dispatch/dispatch.css`. This file is the DOM contract the specs read.

## Routes (`src/projects/routes.ts`)

- `/projects` — the Projects page (`ProjectsPage`), the landing page.
- `/projects/-/triage` — Triage (`RunsHome`, the former Runs home). `-` can never be a project id (`PROJECT_ID_PATTERN`), so
  the path never collides with a project ([D1]). `triagePathname()` builds it; `parseProjectsPathname` returns `{ level: 'triage' }`.
- `/projects/<p>` — the project page (`ProjectPage`).
- `/projects/<p>/workflows/<w>` — the feature (workflow) page, unchanged; it keeps `run-list`, `current-definition`, the
  run-history strip, `feature-lanes`/`feature-reviews`/`feature-reviewers`.

## The rail (`src/projects/dispatch/Rail.tsx`)

Appears on `/projects`, Triage, the project page and the workflow page (`railLevel` in `ProjectsView`). Run pages have no rail.

- `aside[data-testid="dispatch-rail"]` with `a[data-testid="rail-all-projects"]` and `a[data-testid="rail-triage"]` at the top,
  then `ul[data-testid="dispatch-rail-list"]` of `a.dispatch-rail-row[data-project-id]` in rail order ([D6]: needs you, running,
  readable, unreadable, then by last activity). Each row: a glyph, the name, a badge (`.dispatch-rail-badge`: "N waits on you" /
  "N paused" / "N running" / "N unpushed" on the clone's primary only) and a sub-line (repository · "N features" or "cannot be
  read" · date). The current page's row has `aria-current="page"`.
- At 999px and below the rail is hidden and `nav[data-testid="dispatch-chips"]` (a `.dispatch-chip` row, `overflow-x: auto`)
  shows instead, starting "All projects", "Triage · N".

## The Projects page (`src/projects/dispatch/ProjectsPage.tsx`)

- `section[data-testid="dispatch-projects"]`, heading `h1` "Projects", `p[data-testid="dispatch-projects-meta"]` ("N projects in
  M repositories · runs read <time> · GitHub read <time>").
- `ul[data-testid="dispatch-cards"]` of `a.dispatch-card[data-project-id]`, each one link to `/projects/<p>`: the state word
  (`.dispatch-card-word`, e.g. "1 of 3 features failed last"), the repository and `.dispatch-vis` chip for a read GitHub
  project, "on <checkout> · <sync>" (`.dispatch-card-line`), the non-zero run counts, the latest run, and the footer with open
  PR/issue counts or "GitHub not read: <reason>".

## The project page (`src/projects/dispatch/ProjectPage.tsx`)

- `div[data-testid="dispatch-project"]` (adds `.has-pane` while a run is selected).
- Header `header[data-testid="dispatch-project-header"]`: `h1` name, the `https://github.com/<owner>/<name>` link and `.dispatch-vis`
  chip, `p.dispatch-meta` with `span[data-testid="dispatch-sync"]` (the sync phrase + "as of origin/<d> updated here <time>"),
  `p[data-testid="dispatch-figures"]`, the jump buttons ("Runs by feature", "Local and GitHub", "Pull requests · N open", "Issues
  · N open") that move focus to `#dispatch-runs-section`, `#g-local`, `#g-prs`, `#g-iss`, and a filter box `input#dispatch-filter`
  (`/` focuses it, Escape clears it).
- **Step chart** (`src/projects/dispatch/StepChart.tsx`), `div[data-testid="dispatch-chart"]`:
  - `div[data-testid="dispatch-axis"]` — the sticky axis of the eight phase labels (Challenge, Launch, Freeze, Verify, Candidate,
    Review, Approval, Integrate).
  - `ul[data-testid="dispatch-features"]` of `li.dispatch-feature[data-workflow-id]`, each with `a.lists-group-head.ui-card.tone-<tone>`
    (**[L1]: this hook keeps `accepted.spec.ts` passing — the header carries the feature's tone class, `tone-(override|fail|idle)`
    and never `tone-ok` when the latest run was accepted**; the tone is the latest registry run's). The header lists landed shas
    and a chain of run chips.
  - Run rows: `button.dispatch-run[data-run-id]`, `aria-selected`; the stop glyph (`.dispatch-stop-glyph`) sits in the stop phase
    cell (`.dispatch-cell`, one per phase), lane dots (`.dispatch-dot`), `×N` attempts (`.dispatch-att`). A multi-lane phase cell
    carries `.multi` and collapses to one mark at a chart width of 440px or less (container query on `#dispatch-runs-section`).
  - "ended here" counts: `div[data-testid="dispatch-ends"]`. A feature that cannot be read shows a `.dispatch-badrow` with the
    recorded error and `python -m workflow status <run-id> --by operator` (the literal placeholder for a whole-workflow failure).
- **GitHub column** (`src/projects/dispatch/GithubColumn.tsx`), `aside[data-testid="dispatch-github"]`: four cards —
  `#g-local`/`[data-testid="dispatch-gh-local"]` (Local and GitHub, with `[data-testid="dispatch-ahead-naming"]` and
  `[data-testid="dispatch-landings"]`), `#g-prs`/`[data-testid="dispatch-gh-prs"]`, `#g-iss`/`[data-testid="dispatch-gh-issues"]`,
  and `[data-testid="dispatch-gh-others"]`. When GitHub was not read each card says "GitHub not read: <reason>".
- **Reading pane** (`src/projects/dispatch/ReadingPane.tsx`), `aside[data-testid="dispatch-pane"][data-run-id]`, docks only while
  a run is selected: the lead sentence (`[data-testid="dispatch-pane-lead"]`), facts, `[data-testid="dispatch-pane-steps"]`, a
  copyable command (`[data-testid="dispatch-pane-command"]`/`dispatch-pane-copy`), and `a[data-testid="dispatch-open-run"]`.
  `[data-testid="dispatch-pane-close"]` and Escape undock it; j/k move the selection. On a phone it fills the screen with
  `[data-testid="dispatch-pane-queue"]`/`dispatch-pane-next`.

## Shared ids kept

`projects-workspace`, and on Triage the Runs-home ids are unchanged: `needs-you`, `running-runs`, `today-runs`, `paused-runs`,
`recent-runs`, `run-list` (feature page), `projects-info` (the read-only note, now at the foot of the Triage content),
`lists-errors`. `data-workflow-id` and `a.lists-group-head` are reused on the step chart ([L1]).

## Run 002 additions (V1–V22)

New test ids and structure the run 002 scenarios read:

- **Projects page:** `span[data-testid="dispatch-runs-read"]` holds "runs read <time>" (the read time, not a ticking clock) or "runs not read: <reason>" (V15).
- **Project page header:** `span[data-testid="dispatch-same-repo"]` carries "same repo as …" (V10). The four jump buttons move focus to `#dispatch-runs-section`, `#g-local`, `#g-prs`, `#g-iss`, each of which has `tabindex="-1"` (V4). A git-unavailable project's header says "git not read", never "checkout detached".
- **Needs you and running** (`section[data-testid="dispatch-needs"]`, before the chart): links to the waiting and running runs, or `p[data-testid="dispatch-needs-none"]` "Nothing waits on you; nothing running" (V5).
- **Step chart:** the axis (`[data-testid="dispatch-axis"]`), every `.dispatch-track` and the `.dispatch-ends-track` share one grid template (`CHART_COLUMNS` from `phases.ts`, set inline); each `.dispatch-ax[data-phase]` holds `.dispatch-ax-full` and `.dispatch-ax-short` (the short form shows under a container width of 640px via the `dispatch-chart` container query — never an ellipsis, V3). Each feature group has `details[data-testid="dispatch-def"]` ("Steps of this definition", `.dispatch-def-list li[data-node-id]`, V7). A workflow-level `error` still shows one `.dispatch-badrow` with the literal `<run-id>` placeholder.
- **Reading pane (run):** `section[data-testid="dispatch-pane-nextstep"]` holds the run page's `CommandBlock` (`[data-testid="now-next"]`), fed by the run's `NextStep` read with `fetchRunDetail` + `deriveNow` (V2); the separate lead paragraph (`dispatch-pane-next-lead`) was removed in run 003 (V27, below), since the CommandBlock already states the label once; loading/failure say so (`dispatch-pane-next-loading`/`-error`). Close and Escape return focus to the row. On a phone, `dispatch-pane-queue` returns to the list.
- **Reading pane (ahead):** `aside[data-testid="dispatch-pane"][data-pane="ahead"]`, opened by `button[data-testid="dispatch-ahead-button"]` in the Local and GitHub card: `ul[data-testid="dispatch-ahead-commits"]` (short sha, subject, a run link), `p[data-testid="dispatch-ahead-more"]` ("and N more"), and `ul[data-testid="dispatch-ahead-landings"]` (each landing's local/origin state) (V6).
- **GitHub cards:** PR/issue groups longer than five show `button[data-testid="dispatch-show-more"]` ("Show N more", V8); the merged group's `.dispatch-gh-note` says "among the 20 shown" (V9); the Local and GitHub card shows `p[data-testid="dispatch-gh-local-notread"]` when GitHub was not read but keeps its local counts (V11); a "Possibly related" row's `.dispatch-gh-why` names the match ("head is <b>"/"base is <b>", V14).
- **Docked layout:** `.dispatch-project.has-pane` is a two-column grid; the header spans full width and the pane docks beside the body; the GitHub column stacks under the chart unless the viewport has room for three columns (V1, [P26]).
- **Rail:** `a.dispatch-rail-home` (flex, with `.dispatch-rail-home-l` and `.dispatch-rail-home-n`) and `a.dispatch-rail-row` (grid) keep their layout — the base `.dispatch-rail a` rule no longer forces `display:block` (V13).
- **Scenarios:** `dispatch-dock`, `dispatch-axis`, `dispatch-sections`, `dispatch-ahead`, `dispatch-folds` join the nine run-001 scenarios; all 14 pass in both phases.

## Run 003 additions (V23–V32)

Changes and new test ids the run 003 scenarios read:

- **Needs you and running** (`section[data-testid="dispatch-needs"]`, V25): the section now follows the run lists' state. `p[data-testid="dispatch-needs-loading"]` "Reading runs…" while they load; `p[data-testid="dispatch-needs-failed"]` "Runs not read: <reason>" when the request failed or every workflow's run list failed; `p[data-testid="dispatch-needs-none"]` "Nothing waits on you; nothing running." only when every workflow was read and none waits or runs; when some but not all failed, `p[data-testid="dispatch-needs-clear"]` (the all-clear phrase, no period) or the run list, followed by `p[data-testid="dispatch-needs-unread"]` " · N feature(s) cannot be read". `ProjectPage` takes a `runsState` prop (`{kind:'loading'|'failed'|'ready'}`) from `ProjectsView`.
- **Docked layout** (V23): `.dispatch-body-container` wraps `.dispatch-project-body` and, while `.dispatch-project.has-pane`, carries `container-type: inline-size; container-name: dispatch-body`. The chart/GitHub column count comes from the body's own width (`@container dispatch-body (min-width: 876px)`), not a viewport media query; the old `@media (min-width: 1680px)` rule is gone.
- **GitHub head line** (`GithubColumn.tsx`, V26): a read with no head (`head: null`, an empty repository) shows `p[data-testid="dispatch-gh-local-nohead"]` "GitHub's <default branch> has no commits." (or "GitHub's default branch has no commits." when `github.default_branch` is null), never "GitHub not read". The PR/issue cards keep their counts. The card titles are `span.dispatch-gh-title` (nowrap) so "Pull requests" never wraps; the open count reads "N open", never "N opens" (V29).
- **Commits-ahead pane** (`AheadPane.tsx`, V24): a commit whose run the page cannot resolve shows its run id with "older than the newest 50 runs" (`OLDER_THAN_LISTED`), never a dead link; a landing always links via its own `workflow_id` (`landingHref`). Run-to-workflow resolution is `resolveRunWorkflow` (run lists + steps, then a single-workflow project), unit-tested. Escape and Close return focus to `button[data-testid="dispatch-ahead-button"]` (V28).
- **Reading pane** (`ReadingPane.tsx`, V27): the duplicate `dispatch-pane-next-lead` paragraph is removed; the CommandBlock (`[data-testid="now-next"]`, `now-command`) states the next step's label once.
- **Step chart** (`StepChart.tsx`, V30): a filter matching none of a feature's runs shows "0 of N runs match" in the group header; `StepChart` takes a `filtering` prop and each `FeatureGroup` a `total`. A landed sha (`.dispatch-res code`) is `white-space: nowrap` (V29).
- **Phone** (V31): the 44 px scan adds `[data-testid="dispatch-pane"]` as a root and runs while the pane is open, before "Queue" closes it.

## Data

The pages read the existing registry API (`fetchProjects`, `fetchRegistryRuns`, `fetchWorkflowRuns`) for run state and the new
dispatch routes (`src/projects/dispatch/client.ts`, types in `src/projects/dispatch/types.ts`, Appendix A) for git and GitHub
and the step chart. The worker phase mocks `/api/dispatch/**` in `installProjectMocks` (`mock.ts`) from `fixtures/dispatch.ts`,
so every spec gets them. The candidate phase runs against the real server (the `server` lane) with the seeded repositories and
`MD_MANAGER_GITHUB_FIXTURE`.
