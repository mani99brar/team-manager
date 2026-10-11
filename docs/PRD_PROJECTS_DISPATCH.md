# PRD: Projects dispatch (a Projects page, a dedicated page per project with git and GitHub, a projects-only rail)

Status: Draft 2026-10-11. The operator designed this through three rounds of artifacts in a Claude Code session ("Dispatch Desk" with the "Lines" step chart, versions 1 to 4) and approved version 4: "Loks good to me". It is committed as `docs/design/projects-dispatch.html`, the visual and behavioural reference for this feature. The operator asked for this slice to follow up from the run-controls workflow, so it builds on run-controls-004's integrated commit (5dc3ae2). It was not grilled. `features/projects-dispatch/decisions.md` records the operator's own words as [O1] to [O5] and Claude's defaults for the open points as [D1] to [D9]; the design challenge tests them. The feature ships as `projects-dispatch`, with two lanes, `server` and `viewer` (section 8).

## 1. Problem

Today `/projects` is the Runs home (`src/projects/RunsHome.tsx`). It shows triage sections, plus a rail of projects grouped by prefix (`projects-rail`, `railEntries`). A project page (`ProjectRunGroups`) is a plain list of run groups. Nothing in the viewer answers three questions the operator asks every morning:

1. **Which of my projects need me?** The rail lists names, not state. Six repositories and nine registered projects (three of them checkouts of `kleros/kleros-v2`) look alike.
2. **What happened to each feature?** A list of runs does not show *where* each run stopped, or how often a lane was retried.
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
  - its GitHub repository with public or private visibility;
  - the checked-out branch, and local default branch against origin "as last fetched" (or "shares its clone with <project>");
  - features and run counts by result;
  - the latest run;
  - open PRs and open issues.
- **Project page** (`/projects/<p>`):
  - **Header:** repository link, visibility, checkout, sync line, outcome figures, and jump buttons ("Runs by feature", "Local and GitHub", "Pull requests · N open", "Issues · N open").
  - **Main column:** a "Needs you and running" section, then the **step chart**: every feature's runs on one shared axis of eight phases, each run drawn up to where it stopped.
  - **GitHub column**, with cards for:
    - Local and GitHub: ahead/behind, commits ahead and which name a run, landings, and where GitHub's default branch is;
    - Pull requests, grouped;
    - Issues, grouped;
    - Also checked out as.
  - **Reading pane:** it docks only while a run is selected. It shows the run's facts, its steps, the commands to copy, and "Open run page".
- **Rail:**
  - "All projects" and "Triage" at the top, then projects only: no workflows, no repository headers, no prefix groups.
  - Each row: a state glyph, the name, a badge, and a sub-line (repository · features or "cannot be read" · last date).
  - Order: needs you, then running, then readable before unreadable, then by recency.
- **Triage** (`/projects/-/triage`, [D1]): today's Runs home content (needs you, today, running, paused, recent), under the new rail.
- **Truth:** the page never fetches, never pushes and never writes to a repository.
  - Ahead/behind is counted against the clone's origin ref "as last fetched", and says when that fetch was.
  - A "possibly related" PR is one whose head or base branch equals the checkout branch or a run's source branch, and nothing looser.
  - Anything not read says so ("GitHub not read: gh is not installed").

## 3. Principles

1. **Follow the reference.** `docs/design/projects-dispatch.html` is a static mock-up over a real snapshot. Open it in a browser, and read its script for the rules it already settles:
   - `PHASES` and `phaseIx`: the step-to-phase map;
   - `projOrder`: rail order;
   - `projInfo`: badge words;
   - `prGroups` / `issueRow`: GitHub grouping;
   - `syncHTML` / `syncShort`: sync wording.

   Build it in the app's own React, CSS and tokens (`src/projects/theme.css`, `DESIGN.md`), not by pasting its HTML. Where this PRD and the mock-up differ, this PRD wins. Where `decisions.md` and this PRD differ, `decisions.md` wins.
2. **Read-only, still.** The Projects API stays read-only. The new routes are GET only. The server runs `git` read commands with `--no-optional-locks` and `gh` read commands only. Run controls (run-controls-004) stay on the run page; the reading pane links to it ([D7]).
3. **Say what is known, and from when.** Every derived claim names its source and time: "as last fetched 9 Oct 11:54", "GitHub read 11 Oct 03:38". A missing value is "not recorded" or a stated reason, never a guess.
4. **State is a glyph plus a word.** This is the Signal Box world:
   - six state tones;
   - violet only for selection and focus;
   - Atkinson Hyperlegible Next and Mono fonts;
   - 44px targets on phones;
   - works at 390px with no horizontal scroll.

## 4. Pages in detail

### 4.1 Projects page `/projects`

- **Header:** "Projects", then "N projects in M repositories · runs read <time> · GitHub read <time>". Then one line: each card opens the project's page, and cards are ordered as the rail is.
- **Card grid:** `auto-fill`, minimum 330px, one column on a phone.
- **Card contents**, in order. The card is one link to `/projects/<p>`; it contains no other link.
  - name;
  - the state word, which for a project with more than one feature reads "N of M features <result> last" (for example "1 of 3 features failed last");
  - repository and visibility chip;
  - `on <checkout>` · sync, where sync is one of:
    - "16 ahead of origin/main as last fetched";
    - "29 behind origin/dev as last fetched";
    - "level with origin/main as last fetched";
    - "shares its clone with <primary>";
    - "not compared with origin";
  - "N features · N runs: N succeeded, N failed, N cancelled", listing only non-zero results; or "its run state cannot be read by this viewer";
  - latest run id, state word and date;
  - footer: open PRs, open issues, "Open".

### 4.2 Rail

- **Where it appears:** on `/projects`, Triage, the project page and the workflow page. Run pages keep the Signal Box layout without the rail.
- **Rows:**
  - Order: needs you, then running, then readable, then unreadable, each by last activity.
  - Badge: "N waits on you", "N paused" or "N running".
  - Otherwise, "N unpushed" appears only on the clone's primary project (see Appendix A, `clone_primary`).
  - The current page has `aria-current="page"`.
  - A screen-reader suffix gives the worst latest result.
- **Narrower widths:**
  - 1000–1199px: the rail is 240px wide.
  - 999px and below: the rail becomes a horizontal chip row ("All projects", "Triage · N", then the projects).

### 4.3 Project page `/projects/<p>`

- **Layout:**
  - The page uses the full width beside the rail. With no run selected there is no reading pane.
  - At a page width of 980px or more, the body has two columns: main, plus a 380px GitHub column. It stacks below that.
  - Selecting a run docks the reading pane at 380–460px. Esc or Close undocks it and returns focus to the row. j/k moves the selection.
- **Header:**
  - name, a repository link to github.com (only when the GitHub state is `read`), visibility, checkout and clone path, sync line, and "same repo as …" for the other checkouts;
  - figures: waits on you, succeeded, failed, cancelled, median time to land, median time before a stop, "spend not recorded";
  - jump buttons that move focus to their section;
  - a filter box for the runs, with `/` to focus it.
- **Step chart:**
  - A sticky axis of eight phases: Challenge, Launch (with the sidecar), Freeze, Verify, Candidate, Review (with attack, critique and panel), Approval, Integrate.
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
  - A feature whose runs cannot be read shows one row: "cannot be read", with the recorded error and `python -m workflow status <run-id> --by operator`.
  - Older runs draw the lanes recorded for them when these differ from today's definition.
- **GitHub column (Appendix A):**
  - **Local and GitHub:**
    - the sync line in full;
    - "Counted against origin/<b> as this clone last fetched it (<when>); this page never fetches";
    - where GitHub's default branch is (sha, link, and when it last moved);
    - "Of the N ahead, K name a run; N−K are not from a run. Runs never push";
    - landings: "3 of 4 landings on local main; none on origin as last fetched";
    - a button listing the commits ahead and every landing in the reading pane.
  - **Pull requests**, with the aside "N open in the last M · none from a run" and these groups:
    - "Possibly related": head or base equals the checkout branch or a run's source branch;
    - "Yours, open": the author is `viewer_login`;
    - "Others, open";
    - "Merged in the last 14 days".

    Each row: number, title (link), draft, review decision, checks (passing/failing/pending counts), `head → base` when the base is not the default branch, and "updated <rel>". Groups longer than 5 fold to "Show N more".
  - **Issues:**
    - groups: "Assigned to you", then "Newest from people";
    - bot authors (`author_is_bot`, or a login ending `[bot]`) are folded into a count ("N from bots");
    - "All N on GitHub" links to the issues page.

    Each row: number, title, labels, author, and "opened <rel>". A relative time adds the year when it differs from the read year.
  - **Also checked out as:** each other project with the same `github.repo`, with its checkout and "same clone" or "separate clone".
  - **When GitHub was not read:** each card says why, from `reason`, and shows no counts.
- **Reading pane:**
  - title, state, the project and feature links, and the facts that exist: started, finished, wall time, mode/profile, lanes, worker/judges;
  - the steps with attempts;
  - the lead sentence: where it stopped and why, or "Integrated: fast-forwarded to <sha>" and which branches hold it;
  - commands to copy: today's `NextStep` and `CommandBlock`, unchanged;
  - "Open run page", the primary button, which opens the run page, where run controls live.
  - On a phone, tapping a run fills the screen with "Queue" and "Next".

### 4.4 Triage `/projects/-/triage`

Today's `RunsHome` content and behaviour (sections, jumps, NeedsCard, polling) move here unchanged, except that the old rail is replaced by the new one. The `g h` shortcut opens Triage; `g p` opens the Projects page.

## 5. Data rules

- **Clone identity:** the real path of `git rev-parse --git-common-dir`. The clone's primary is the first project, in registry order, whose clone matches.
- **Default branch:**
  - `refs/remotes/origin/HEAD` with the remote name removed;
  - otherwise `main`, then `master`, whichever exists locally;
  - otherwise null.
- **Ahead/behind:** `git rev-list --left-right --count refs/heads/<d>...refs/remotes/origin/<d>`.
- **"Last fetched":** the modification time of `<common-dir>/FETCH_HEAD`, or null when it is absent ("last fetch time not recorded").
- **Landing:** a run's integrated commit is the sha in its `integrate` step's succeeded message ("Fast-forwarded to <sha>"). It is "on local <d>" when `git merge-base --is-ancestor <sha> refs/heads/<d>` succeeds, and "on origin as last fetched" when the same check against the origin ref succeeds. A sha the clone does not have is `null`, shown as "not in this clone".
- **Commit naming a run:** a subject matching `^Workflow (<run-id>)[: ]`, where the run id is one of the project's runs.
- **GitHub repository:** parsed from `git remote get-url origin` (`github.com[:/]<owner>/<name>(.git)?`). Anything else is `not_github`.
- **GitHub cadence:**
  - Each repository is read at most once per `MD_MANAGER_GITHUB_REFRESH_MINUTES` (default 15).
  - Reads happen in the background: once at start, then on schedule.
  - Repositories are read one at a time, with a 20 s timeout per `gh` call.
  - The last good read is kept, in memory and in `MD_MANAGER_GITHUB_CACHE` (default `~/.cache/md-manager/github.json`), with its `read_at`. A failed refresh keeps the last good read and adds a `reason`.
- **Turning GitHub reads off or faking them:**
  - `MD_MANAGER_GITHUB=off` turns GitHub reads off; the status is `off`.
  - `MD_MANAGER_GH` names the executable; the default is `gh` on PATH.
  - `MD_MANAGER_GITHUB_FIXTURE=<file>` replaces every `gh` call with a JSON file holding `{viewer_login, repos: {"<owner>/<name>": GithubRepoRead}}`. Tests and the critique app use it.
- **Git command limits:** a 5 s timeout, `GIT_TERMINAL_PROMPT=0`, `--no-optional-locks`, and `execFile` with an argv array. Never `fetch`, `pull`, `push`, `gc`, or any command that writes. Results are cached for 15 s per repository.

## 6. Non-goals

- No fetching, pushing, PR creation or issue editing.
- No new run controls, and no Run button on the Projects pages ([D7]; this is a follow-up).
- No change to the run page, the node pages, the assignment page or the feature (workflow) page beyond adding the rail.
- No change to the workflow engine or the export.
- No cost figures ("spend not recorded" stays).
- No "Example morning" synthetic mode. The mock-up's Snapshot/Example switch is a design aid only.

## 7. Test plan

- **Server** (`server/dispatch.test.ts`, run by `npm run test:unit`):
  - temporary git repositories: a bare "origin", a clone, and a worktree of it;
  - an injected clock and an injected `gh` runner.
- **Contract:** `contracts/projects/dispatch.ts` zod schemas, examples in `contracts/projects/examples.ts`, validated in `contract.test.ts`.
- **Viewer:** the browser scenarios in `policy.json`, in both phases:
  - worker phase: mocked `/api/dispatch/**` from Appendix A;
  - candidate phase: the real server, seeded git repositories under the test root, and `MD_MANAGER_GITHUB_FIXTURE`.
- **Unit tests:** the phase map, rail order, badge words, PR and issue grouping, and the relative time with year.
- **Existing specs:** those that open the Runs home move to Triage. They are listed in `viewer-task.md`.

## 8. Lanes

One run, with `server` and `viewer` in parallel ([D2]). The viewer lane mirrors Appendix A's types in `src/projects/dispatch/types.ts` and mocks the routes in the worker phase. The candidate's real-backend browser check proves the two lanes agree, as in run-controls.

## 9. Risks

- **`gh` auth on the host.** If `gh` is not logged in, every repository reads as `unavailable` with the reason. The page must still read well.
- **Slow `git` on a big clone.** The 5 s timeout and 15 s cache apply. A timeout is an `unavailable` git state for that project, not a failed page.
- **Run-step digests for many runs.** The digests reuse `RunStore`'s fingerprint cache idea: cache per run directory fingerprint, with at most 50 runs per workflow.
- **The Runs home moves.** Bookmarks of `/projects` now land on the Projects page; Triage is one click away in the rail.

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
  viewer_login: string | null       // `gh api user` login (or the fixture's); null when GitHub is off/unavailable
  projects: ProjectDispatch[]       // registry order
}

interface ProjectDispatch {
  project_id: string
  git: GitState
  github: GithubState
}

interface GitState {
  status: 'read' | 'unavailable'
  reason: string | null             // why unavailable ("not a git repository", "git timed out after 5 s", "repository path not set")
  repository: string | null         // as registered (may start with ~)
  checkout: string | null           // branch name; null when detached or unavailable
  head: Sha | null
  default_branch: string | null
  clone: string | null              // absolute real path of the git common dir
  clone_primary: string | null      // project_id of the first registry project with the same clone
  origin: null | {                  // null: no refs/remotes/origin/<default_branch>
    ref: string                     // "origin/main"
    sha: Sha
    fetched_at: Ts | null           // FETCH_HEAD mtime
    ahead: number
    behind: number
  }
  ahead_commits: { sha: Sha; subject: string; committed_at: Ts; run_id: string | null }[]   // newest first, at most 50
  landings: { workflow_id: string; run_id: string; sha: Sha; on_default: boolean | null; on_origin: boolean | null }[]
  read_at: Ts
}

interface GithubState {
  status: 'read' | 'pending' | 'off' | 'not_github' | 'unavailable'
  reason: string | null             // "gh is not installed", "gh: not logged in", "not a GitHub remote", "not read yet"
  repo: string | null               // "owner/name"
  read_at: Ts | null                // time of the last good read (kept when a refresh fails; reason then says why)
  visibility: 'PUBLIC' | 'PRIVATE' | 'INTERNAL' | null
  default_branch: string | null
  pushed_at: Ts | null
  head: { sha: Sha; committed_at: Ts } | null      // GitHub's default branch head
  open_prs: number | null
  open_issues: number | null        // issues only, PRs excluded
  prs: Pr[]                          // at most 20, most recently updated, any state
  issues: Issue[]                    // at most 20, newest open
}

interface Pr {
  number: number; title: string; url: string
  state: 'OPEN' | 'MERGED' | 'CLOSED'; draft: boolean
  author: string; author_is_bot: boolean
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
    runs: {                         // newest first, at most 50
      run_id: string
      source_branch: string | null  // inputs.source_branch
      base_commit: Sha | null
      integrated_commit: Sha | null
      lanes: string[]               // the run's own worker node ids, as recorded for it
      steps: { node_id: string; status: string; attempt: number }[]   // the run's nodes in definition order
    }[]
    errors: { run_id: string; code: string; message: string }[]       // runs that could not be read
  }[]
}
```

### A.3 Environment

| Variable | Default | Meaning |
|---|---|---|
| `MD_MANAGER_GITHUB` | on | `off` disables every `gh` call; GitHub states are `off` |
| `MD_MANAGER_GH` | `gh` | the executable for GitHub reads |
| `MD_MANAGER_GITHUB_FIXTURE` | unset | a JSON file `{viewer_login, repos}` used instead of `gh` |
| `MD_MANAGER_GITHUB_REFRESH_MINUTES` | 15 | minimum minutes between reads of one repository |
| `MD_MANAGER_GITHUB_CACHE` | `~/.cache/md-manager/github.json` | the last good reads, with `read_at` |

Suggested `gh` calls, which are not binding; the fields in A.2 are what binds:
- `gh api user --jq .login`;
- `gh repo view <r> --json visibility,defaultBranchRef,pushedAt`;
- `gh pr list --repo <r> --state all --limit 20 --json number,title,url,state,isDraft,author,headRefName,baseRefName,updatedAt,mergedAt,reviewDecision,statusCheckRollup,labels`;
- `gh issue list --repo <r> --state open --limit 20 --json number,title,url,author,labels,assignees,createdAt,updatedAt`;
- `gh api graphql` for the open PR and open issue totals and the default branch head.
