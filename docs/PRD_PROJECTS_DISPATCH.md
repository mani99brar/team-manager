# PRD: Projects dispatch (a Projects page, a dedicated page per project with git and GitHub, a projects-only rail)

Status: Draft 2026-10-11, revised after a three-provider panel review (Claude, GPT, DeepSeek; 23 issues found, all addressed here; see `decisions.md` [P1] to [P23]).

The operator designed this through three rounds of artifacts in a Claude Code session ("Dispatch Desk" with the "Lines" step chart, versions 1 to 4) and approved version 4: "Loks good to me". It is committed as `docs/design/projects-dispatch.html`, the visual and behavioural reference for this feature. The operator asked for this slice to follow up from the run-controls workflow, so it builds on run-controls-004's integrated commit (5dc3ae2).

It was not grilled. `features/projects-dispatch/decisions.md` records:
- the operator's own words, [O1] to [O5];
- Claude's defaults for the open points, [D1] to [D9];
- the panel's findings and how each was settled.

The feature ships as `projects-dispatch`, with two lanes, `server` and `viewer` (section 8).

## 1. Problem

Today `/projects` is the Runs home (`src/projects/RunsHome.tsx`). It shows triage sections, plus a rail of projects grouped by prefix (`projects-rail`, `railEntries`). A project page (`ProjectRunGroups`) is a plain list of run groups. Nothing in the viewer answers three questions the operator asks every morning:

1. **Which of my projects need me?** The rail lists names, not state. Six repositories and nine registered projects (three of them checkouts of `kleros/kleros-v2`) look alike.
2. **What happened to each feature?** A list of runs does not show *where* each run stopped, or how often a step was retried.
3. **Where does the work stand against GitHub?**
   - Local `main` of `team-manager` is 16 commits ahead of `origin/main`, because runs integrate locally and never push.
   - The `kleros-v2` clone is 29 behind `origin/dev`.
   - Two registered projects are worktrees that share another project's clone.
   - Pull requests and issues are only on github.com.

   The viewer reads no git and no GitHub today: there is no `execFile`, `git` or `gh` in `server/`.

## 2. Outcome

The Projects tab opens on a **Projects page**: one card per registered project. Each card opens a **dedicated project page**. Every Projects page except the run page has the same **projects-only rail**. The former Runs home stays available as **Triage**.

- **Projects page** (`/projects`): one card per project, in rail order. Each card shows:
  - the project's state word;
  - its GitHub repository with public or private visibility (for a GitHub project);
  - the checked-out branch, and local default branch against origin (or "shares its clone with <project>");
  - features and run counts by result;
  - the latest run;
  - open PRs and open issues (for a GitHub project that was read).
- **Project page** (`/projects/<p>`):
  - **Header:** repository link, visibility, checkout, sync line, outcome figures, and jump buttons.
  - **Main column:** a "Needs you and running" section, then the **step chart**: every feature's runs on one shared axis of eight phases, each run drawn up to where it stopped.
  - **GitHub column**, with cards for:
    - Local and GitHub;
    - Pull requests;
    - Issues;
    - Also checked out as.
  - **Reading pane:** it docks only while a run is selected.
- **Rail:** "All projects" and "Triage" at the top, then projects only.
- **Triage** (`/projects/-/triage`, [D1]): today's Runs home content, under the new rail.
- **Truth:** the page never fetches, never pushes and never writes to a repository.
  - Every comparison says what it is against, and from when.
  - Anything not read says why.
  - No absolute filesystem path reaches the browser ([P8]).

## 3. Principles

1. **Follow the reference.** `docs/design/projects-dispatch.html` is a static mock-up over a real snapshot. Open it in a browser, and read its script for the rules it already settles:
   - `PHASES` and `phaseIx`: the step-to-phase map;
   - `projOrder`: rail order;
   - `projInfo`: badge words;
   - the GitHub grouping;
   - `syncHTML` / `syncShort`: sync wording.

   Build it in the app's own React, CSS and tokens (`src/projects/theme.css`, `DESIGN.md`), not by pasting its HTML. Where this PRD and the mock-up differ, this PRD wins; the panel fixes in particular change some of the mock-up's wording. Where `decisions.md` and this PRD differ, `decisions.md` wins.
2. **Read-only, still.** The Projects API stays read-only. The new routes are GET and HEAD only. The server runs read-only `git` commands, with no locks taken and no lazy fetch (section 5), and read-only `gh` commands. Run controls (run-controls-004) stay on the run page; the reading pane links to it ([D7]).
3. **Say what is known, and from when.** Every derived claim names its source and time: "as of origin/main updated here 9 Oct 11:54", "GitHub read 11 Oct 03:38". A missing value is "not recorded" or a stated reason, never a guess. An unknown comparison is shown as unknown, never as false ([P9]).
4. **State is a glyph plus a word.** This is the Signal Box world:
   - six state tones;
   - violet only for selection and focus;
   - Atkinson Hyperlegible Next and Mono fonts;
   - 44px targets on phones;
   - works at 390px with no horizontal scroll.

## 4. Pages in detail

### 4.1 Projects page `/projects`

- **Header:** "Projects", then "N projects in M repositories · runs read <time> · GitHub read <time>". The GitHub time is the oldest `read_at` among the GitHub projects that were read; if none were read, the header says "GitHub not read". Then one line: each card opens the project's page, and cards are ordered as the rail is.
- **Card grid:** `auto-fill`, minimum 330px, one column on a phone.
- **Card contents**, in order. The card is one link to `/projects/<p>`; it contains no other link.
  - name;
  - the state word, which for a project with more than one feature reads "N of M features <result> last" (for example "1 of 3 features failed last");
  - for a GitHub project: repository (`owner/name`) and visibility chip;
  - `on <checkout>` · sync. The sync wording is the same on cards and headers ([P1]); see section 5, "Sync wording";
  - "N features · N runs: N succeeded, N failed, N cancelled", listing only non-zero results; or "its run state cannot be read by this viewer";
  - latest run id, state word and date;
  - footer, which depends on the GitHub state:
    - `read`: open PRs and open issues, then "Open";
    - otherwise: "GitHub not read: <reason>" and "Open".

### 4.2 Rail

- **Where it appears:** on `/projects`, Triage, the project page and the workflow page. Run pages keep the Signal Box layout without the rail.
- **Rows:**
  - Order: needs you, then running, then readable, then unreadable, each by last activity.
  - Badge: "N waits on you" or "N paused" when runs wait, else "N running".
  - Otherwise, "N unpushed" appears only on the clone's primary project (`clone_primary`) when its `origin.ahead` > 0.
  - Sub-line: repository short name · "N features" or "cannot be read" · last activity date.
  - The current page has `aria-current="page"`.
  - A screen-reader suffix gives the worst latest result.
- **Narrower widths:**
  - 1000–1199px: the rail is 240px wide.
  - 999px and below: the rail becomes a horizontal chip row ("All projects", "Triage · N", then the projects).

### 4.3 Project page `/projects/<p>`

- **Layout:**
  - The page uses the full width beside the rail. With no run selected there is no reading pane.
  - At a page width of 980px or more, the body has two columns: main, plus a 380px GitHub column. It stacks below that.
  - Selecting a run docks the reading pane at 380–460px. Esc or Close undocks it and returns focus to the row. j/k moves the selection; the keys are ignored while focus is in a text field.
- **Header:**
  - name;
  - for a GitHub project that was read: a link to `https://github.com/<owner>/<name>` and the visibility chip;
  - the checkout branch, the repository label (`~`-relative or basename, [P8]), the sync line, and "same repo as …" for the other checkouts;
  - figures: waits on you, succeeded, failed, cancelled, median time to land, median time before a stop, "spend not recorded";
  - jump buttons ("Runs by feature", "Local and GitHub", and for a read GitHub project "Pull requests · N open" and "Issues · N open"), which move focus to their section;
  - a filter box for the runs, with `/` to focus it and Escape to clear it.
- **Step chart:**
  - A sticky axis of eight phases: Challenge, Launch (with the sidecar), Freeze, Verify, Candidate, Review (with attack, critique and panel), Approval, Integrate.
  - **Phase map:** by the step's `kind` and `node_id` from the run's own recorded definition ([P22]):
    - `review` → Review, except `challenge` → Challenge;
    - `worker` → Launch;
    - `prepare` → Freeze;
    - `verification` → Verify (`verify_*`) or Candidate (`candidate*`);
    - `integration` → Approval (`approval`) or Integrate (`integrate`);
    - repair steps → the phase of the check they repair, else Verify;
    - `sidecar` → Launch;
    - `attack`, `critique`, `panel` → Review.
  - Each feature is a group: a header row (feature id, "nothing landed" or the landed shas, run count, step count), then a chain line of run chips (`001 ✕`, `002 ✓ 6ac7f5c` …).
  - **Each run row:**
    - the run number, its state word, any repairs, the result (landed sha with "local" or "on origin", or where it stopped), and the duration;
    - line two: the focus step and the headline;
    - the track: a solid line up to the stop, dotted after it.
  - **Inside a phase on the track:**
    - Lanes show as dots: filled when reached, outlined when not.
    - `×N` marks a step attempted N times (N ≥ 2).
    - The state glyph sits at the phase where the run stopped.
    - At a chart width of 440px or less, a multi-lane phase collapses to one mark.
  - Under each group, "ended here" counts how many runs ended in each phase. A "Steps of this definition" fold lists the definition's steps.
  - **A feature that cannot be read:**
    - When the whole workflow fails (`error` set), it shows one row: "cannot be read", the recorded error, and `python -m workflow status <run-id> --by operator`, with the literal placeholder `<run-id>`.
    - When single runs fail, it shows one such row per entry in `errors`, with the real run id ([P21]).
  - Older runs place their lanes from their own recorded steps (label and kind), so a lane renamed or removed since still draws ([P22]).
- **GitHub column (Appendix A):**
  - **Local and GitHub:**
    - the sync line in full;
    - "Counted against origin/<b> as this clone has it; origin/<b> last updated here <time> (or 'update time not recorded'); this page never fetches";
    - for a read GitHub project: "GitHub <b> is at <sha> (link), committed <date>" ([P4]: the commit date, never "last moved");
    - "Of the N ahead, K name a run; N−K do not name a known run. Runs never push" ([P5]; K is `ahead_naming_run`, counted over all N);
    - landings: "3 of 4 landings on local main; 0 on origin; 1 unknown", where unknown means not comparable ([P9]);
    - a button listing the commits ahead (up to 50, with "and N more") and every landing in the reading pane.
  - **Pull requests**, with the aside "N open · showing the 20 most recently updated" ([P15]) and these groups:
    - "Possibly related": the head branch equals the checkout branch or a run's `source_branch`, or the base branch does when it is not the project's default branch; the row names the match (decisions.md [L5], run 002);
    - "Yours, open": the author is `viewer_login`;
    - "Others, open";
    - "Merged in the last 14 days", among the 20 shown.

    Each row: number, title (link), draft, review decision, checks (passing/failing/pending counts), `head → base` when the base is not the default branch, and "updated <rel>". Groups longer than 5 fold to "Show N more".
  - **Issues:**
    - groups: "Assigned to you", then "Newest from people";
    - bot authors (`author_is_bot`) are folded into "N from bots among the newest 20";
    - "All N on GitHub" links to the issues page.

    Each row: number, title, labels, author, and "opened <rel>". A relative time adds the year when it differs from the read year.
  - **Also checked out as:** each other project with the same `github.repo`, with its checkout and "same clone" or "separate clone" (by `clone_id`).
  - **GitHub state `read` with `reason` set** (a refresh failed after a good read, [P12]): the data shows with a line "Last read <time>; the latest refresh failed: <reason>".
  - **Any other state:** each card says "GitHub not read: <reason>" and shows no counts.
- **Reading pane:**
  - title, state, the project and feature links, and the facts that exist: started, finished, wall time, mode/profile, lanes, worker/judges;
  - the steps with attempts;
  - the lead sentence: where it stopped and why, or "Integrated: fast-forwarded to <sha>" and whether it is on local and on origin;
  - commands to copy: today's `NextStep` and `CommandBlock`, unchanged;
  - "Open run page", the primary button, which opens the run page, where run controls live.
  - On a phone, tapping a run fills the screen with "Queue" and "Next".

### 4.4 Triage `/projects/-/triage`

Today's `RunsHome` content and behaviour (sections, jumps, NeedsCard, polling) move here unchanged, except that the old rail is replaced by the new one. There are no new keyboard chords ([P17]): the rail's "Triage" entry and the chip reach it.

## 5. Data rules

- **No paths to the browser** ([P8]):
  - `repository_label` is the registered path with `$HOME` replaced by `~` when it is under `HOME`, else its last path segment.
  - Clones are compared by `clone_id`: the first 12 hex characters of the SHA-256 of the real path of `git rev-parse --git-common-dir`.
  - `reason` strings are fixed messages from section 5 and Appendix A, never raw git or gh output.
- **Registry paths:** the registry's `repository` is already absolute (`server/projectsConfig.ts` rejects `~`, [P7]). There is no tilde expansion, and the registry validation does not change.
- **Clone primary:** the first project, in registry order, with the same `clone_id`.
- **Default branch:**
  - `git symbolic-ref --short refs/remotes/origin/HEAD` with the remote name removed;
  - otherwise `main`, then `master`, whichever exists locally or as `refs/remotes/origin/<b>`;
  - otherwise null.
- **Comparison with origin** ([P3]). `origin` is null when `refs/remotes/origin/<d>` does not exist. Otherwise:
  - when `refs/heads/<d>` exists: `compare: 'compared'`, with `ahead`/`behind` from `git rev-list --left-right --count refs/heads/<d>...refs/remotes/origin/<d>`;
  - when it does not exist: `compare: 'no_local_branch'`, with `ahead`/`behind` null.
- **When origin/<d> was last updated in this clone** ([P2]): the timestamp of the newest entry of `<common-dir>/logs/refs/remotes/origin/<d>` (the remote-tracking ref's reflog, written by every fetch, pull or clone that moved it). It is null when there is no reflog. It is never `FETCH_HEAD`, which any fetch of any remote rewrites.
- **Sync wording** (cards, headers, rail tooltips, [P1], [P3]):
  - "2 ahead, 1 behind origin/main" when both are non-zero;
  - "16 ahead of origin/main" or "29 behind origin/dev" when only one is non-zero;
  - "level with origin/main" when both are zero;
  - "origin/dev at <sha7>; no local dev to compare" for `no_local_branch`;
  - "not compared with origin" when `origin` is null;
  - "shares its clone with <primary>" for a non-primary project of a clone (the header adds the primary's sync in full);
  - "git not read: <reason>" when git is `unavailable`.

  A compared state adds "as of origin/<d> updated here <time>", or "update time not recorded".
- **Landing:** a run's integrated commit is the sha in its succeeded `integrate` step's message ("Fast-forwarded to <sha>"). For each of the local default branch and the origin ref: `true` when `git merge-base --is-ancestor <sha> <ref>` exits 0, `false` when it exits 1, and `null` (unknown) when the ref or the object is missing, git errors or times out ([P9]).
- **Commit naming a run:**
  - A commit names a run when its subject matches `^Workflow (<run-id>)[: ]`, where the run id is one of the project's runs.
  - `ahead_naming_run` counts these over every commit ahead, not only the 50 listed ([P5]).
  - The other commits "do not name a known run": this is not proof they are not from a run.
- **GitHub repository** ([P10]): parsed from `git remote get-url origin`, accepting exactly:
  - `https://github.com/<owner>/<name>(.git)?`
  - `ssh://git@github.com/<owner>/<name>(.git)?`
  - `git@github.com:<owner>/<name>(.git)?`

  The host must be exactly `github.com`. `owner` and `name` must match `^[A-Za-z0-9_.-]{1,100}$` and must not be `.` or `..`. Anything else is `not_github`, with the reason "not a GitHub remote".
- **GitHub cadence** ([P18]): timer-driven only.
  - At start the server schedules a read of every registered GitHub repository.
  - A one-minute tick reads any repository whose last read is older than `MD_MANAGER_GITHUB_REFRESH_MINUTES` (default 15). This includes repositories added at runtime by the registry reloader.
  - Repositories are read one at a time, with a 20 s timeout per `gh` call.
  - Requests never trigger or wait for a read; before a repository's first read its state is `pending` ("not read yet").
  - The last good read is kept in memory and in `MD_MANAGER_GITHUB_CACHE` (default `~/.cache/md-manager/github.json`).
  - A failed refresh keeps status `read`, the last good data, `read_at` and `viewer_login`, and sets `reason` ([P12]).
- **Failure reasons** ([P14]) are fixed strings, never raw stderr:
  - "gh is not installed" (ENOENT);
  - "gh is not logged in" (stderr mentions `auth login`);
  - "gh timed out after 20 s";
  - "gh failed (exit <n>)";
  - "gh output was not understood".
- **Fixture and off switch:**
  - `MD_MANAGER_GITHUB=off` turns GitHub reads off; the status is `off` and the reason is "GitHub reads are turned off".
  - `MD_MANAGER_GH` names the executable; the default is `gh` on PATH.
  - `MD_MANAGER_GITHUB_FIXTURE=<file>` replaces every `gh` call with the JSON file `{viewer_login, repos: {"<owner>/<name>": GithubRepoRead}}`. It is read synchronously before the server listens, so the first response is already `read` for every fixture repository ([P6]). A fixture repository missing from the file is `unavailable` ("not in the fixture"). With a fixture set, nothing is written to the cache ([P20]).
- **Git command limits:**
  - argv is `['--no-optional-locks', '-C', <repo>, ...]` with the environment `GIT_TERMINAL_PROMPT=0`, `GIT_NO_LAZY_FETCH=1` (git ≥ 2.44; the host has 2.50) and `GIT_OPTIONAL_LOCKS=0` ([P11]);
  - a 5 s timeout, `execFile` with an argv array;
  - never `fetch`, `pull`, `push`, `gc`, `checkout`, or any command that writes;
  - results cached for 15 s per repository;
  - a missing object counts as unknown.

## 6. Non-goals

- No fetching, pushing, PR creation or issue editing.
- No new run controls, and no Run button on the Projects pages ([D7]; this is a follow-up).
- No change to the run page, the node pages, the assignment page, or the feature (workflow) page beyond adding the rail.
- No change to the workflow engine, the export or the registry schema.
- No cost figures ("spend not recorded" stays).
- No "Example morning" synthetic mode. The mock-up's Snapshot/Example switch is a design aid only.
- No keyboard chords (`g h`, `g p`).

## 7. Test plan

- **Server** (`server/dispatch.test.ts`, run by `npm run test:unit`):
  - temporary git repositories: a bare origin, a clone with commits ahead and behind and a reflog, a worktree of it, a clone without a local default branch, a non-GitHub remote, a lookalike-host remote;
  - an injected clock and an injected `gh` runner.
- **Contract:** `contracts/projects/dispatch.ts` zod schemas, examples in `contracts/projects/examples.ts`, validated in `contract.test.ts`.
- **Viewer:** the browser scenarios in `policy.json`, in both phases:
  - worker phase: mocked `/api/dispatch/**` from Appendix A;
  - candidate phase: the real server, seeded git repositories under the test root, and `MD_MANAGER_GITHUB_FIXTURE`.
- **Unit tests:** the phase map, rail order, badge words, sync wording, PR and issue grouping, and the relative time with year.
- **Existing specs:** those that open the Runs home move to Triage. They are listed in `viewer-task.md`. Specs using `renderedText` keep passing, because no path is rendered.

## 8. Lanes

One run, with `server` and `viewer` in parallel ([D2]). The viewer lane mirrors Appendix A's types in `src/projects/dispatch/types.ts` and mocks the routes in the worker phase. The candidate's real-backend browser check proves the two lanes agree, as in run-controls.

## 9. Risks

- **`gh` auth on the host.** If `gh` is not logged in, every repository reads as `unavailable` with the reason. The page must still read well.
- **Slow `git` on a big clone.** The 5 s timeout and 15 s cache apply. A timeout is an `unavailable` git state for that project, or an unknown landing; it is never a failed page.
- **Run-step digests for many runs.** Each digest is cached by the run directory's fingerprint, with at most 50 runs per workflow.
- **The Runs home moves.** Bookmarks of `/projects` now land on the Projects page; Triage is one click away in the rail.
- **Viewer lane size** ([P23]). It is the largest single lane yet. Launch with `--fix-rounds 3` (the operator's call). Its scenarios are split so a failure points at one page.

## Appendix A: the dispatch API (contract 1.0.0, `contracts/projects/dispatch.ts`)

### A.1 Routes (GET and HEAD only; other methods 405, body `{ error: { code, message } }`)

- `GET /api/dispatch/projects` returns `DispatchOverview` for every registered project.
- `GET /api/dispatch/projects/:projectId/steps` returns `ProjectSteps`. An unknown project is 404 `NOT_FOUND`.

### A.2 Types

```ts
type Sha = string            // 7 to 40 lowercase hex
type Ts = string             // ISO 8601 UTC

interface DispatchOverview {
  contract_version: '1.0.0'
  read_at: Ts                       // when this response was assembled
  viewer_login: string | null       // `gh api user` login (or the fixture's); null when no GitHub read has ever succeeded or GitHub is off
  projects: ProjectDispatch[]       // registry order
}

interface ProjectDispatch {
  project_id: string
  git: GitState
  github: GithubState
}

interface GitState {
  status: 'read' | 'unavailable'
  reason: string | null             // fixed text when unavailable: "repository not found", "not a git repository", "git timed out after 5 s", "git failed"
  repository_label: string          // "~/dev/vea" when under HOME, else the last path segment; never an absolute path
  checkout: string | null           // branch name; null when detached or unavailable
  head: Sha | null
  default_branch: string | null
  clone_id: string | null           // 12 hex of sha256(realpath(git common dir))
  clone_primary: string | null      // project_id of the first registry project with the same clone_id
  origin: null | {                  // null: no refs/remotes/origin/<default_branch>
    ref: string                     // "origin/main"
    sha: Sha
    updated_at: Ts | null           // newest reflog entry of the remote-tracking ref; null without a reflog
    compare: 'compared' | 'no_local_branch'
    ahead: number | null            // null unless compare === 'compared'
    behind: number | null
  }
  ahead_commits: { sha: Sha; subject: string; committed_at: Ts; run_id: string | null }[]   // newest first, at most 50
  ahead_naming_run: number          // over all commits ahead, not only the 50 listed; 0 when not compared
  landings: { workflow_id: string; run_id: string; sha: Sha; on_default: boolean | null; on_origin: boolean | null }[]   // null = unknown
  read_at: Ts
}

interface GithubState {
  status: 'read' | 'pending' | 'off' | 'not_github' | 'unavailable'
  reason: string | null             // fixed text (PRD section 5); with status 'read', set only when the latest refresh failed
  repo: string | null               // "owner/name" whenever the origin remote parsed as GitHub (every status but not_github and a git-unavailable project)
  read_at: Ts | null                // time of the last good read
  visibility: 'PUBLIC' | 'PRIVATE' | 'INTERNAL' | null
  default_branch: string | null
  pushed_at: Ts | null              // the repository's last push to ANY branch; not shown as default-branch movement
  head: { sha: Sha; committed_at: Ts } | null      // GitHub's default branch head commit
  open_prs: number | null
  open_issues: number | null        // issues only, PRs excluded
  prs: Pr[]                          // the 20 most recently updated, any state (GraphQL orderBy UPDATED_AT DESC)
  issues: Issue[]                    // the 20 newest open issues (orderBy CREATED_AT DESC)
}
// Every field from visibility on is null or [] unless status is 'read'.

interface Pr {
  number: number; title: string; url: string
  state: 'OPEN' | 'MERGED' | 'CLOSED'; draft: boolean
  author: string; author_is_bot: boolean       // GraphQL __typename Bot, or a login ending "[bot]"
  head_ref: string; base_ref: string
  updated_at: Ts; merged_at: Ts | null
  review_decision: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null
  checks: { passing: number; failing: number; pending: number } | null
  labels: string[]
}

interface Issue {
  number: number; title: string; url: string
  author: string; author_is_bot: boolean
  labels: string[]; assignees: string[]
  created_at: Ts; updated_at: Ts
}

// The fixture file and the on-disk cache hold the read per repository:
type GithubRepoRead = Omit<GithubState, 'status' | 'reason' | 'repo'>

interface ProjectSteps {
  contract_version: '1.0.0'
  project_id: string
  workflows: {
    workflow_id: string
    error: { code: string; message: string } | null                  // the workflow's runs could not be listed at all
    runs: {                         // newest first, at most 50
      run_id: string
      source_branch: string | null  // inputs.source_branch
      base_commit: Sha | null
      integrated_commit: Sha | null
      lanes: string[]               // the run's own worker node ids, as recorded for it
      steps: { node_id: string; label: string; kind: string; status: string; attempt: number }[]   // the run's own recorded definition, in its order
    }[]
    errors: { run_id: string; code: string; message: string }[]       // single runs that could not be read
  }[]
}
```

### A.3 Environment

| Variable | Default | Meaning |
|---|---|---|
| `MD_MANAGER_GITHUB` | on | `off` disables every `gh` call; GitHub states are `off` |
| `MD_MANAGER_GH` | `gh` | the executable for GitHub reads |
| `MD_MANAGER_GITHUB_FIXTURE` | unset | a JSON file `{viewer_login, repos}` read synchronously at start and used instead of `gh`; no cache write |
| `MD_MANAGER_GITHUB_REFRESH_MINUTES` | 15 | minimum minutes between reads of one repository |
| `MD_MANAGER_GITHUB_CACHE` | `~/.cache/md-manager/github.json` | the last good reads, with `read_at` |

Binding for PR order: one `gh api graphql` query per repository asks for:
- `pullRequests(first: 20, orderBy: {field: UPDATED_AT, direction: DESC})`;
- `issues(first: 20, states: OPEN, orderBy: {field: CREATED_AT, direction: DESC})`;
- the open PR and open issue `totalCount`s;
- `visibility`, `pushedAt`, and `defaultBranchRef { name target { oid ... on Commit { committedDate } } }`.

`gh api user --jq .login` gives `viewer_login`. The exact query text is the server lane's; the fields and orders above bind.
