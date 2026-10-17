# Run teams and GitHub: the run page spec

Status: build-ready, 2026-10-16. Merged from six independent designs (Claude Fable, Claude Opus, GPT-6 Astra, DeepSeek, Muse Wonder, Gemini Argon) and fitted to the committed contracts `contracts/projects/teams.ts` (teams 1.0.0), `github.ts` (run GitHub read 1.0.0 and actions 1.0.0), `summary.ts` and `teamExamples.ts`. Those contracts are fixed; every field named below exists in them. Design rules are `DESIGN.md` (Signal Box) and `PRODUCT.md`.

## 1. Goal and scope

**Goal.** A worker lane is becoming a team: one Claude Code lead session that runs Workflow scripts which fan out many agents in named phases. The operator must be able to see, from the run page and often from a phone, what each team is doing now, what it did, and where it went wrong. They must also be able to take the run's branch to GitHub (push it, open a draft pull request, mark it ready, request reviewers) and read back what teammates and checks said. All of it must stay honest: what the records hold, "not recorded" where they hold nothing.

**In scope**

- A view switcher **Run · Team · GitHub · Assignment** in the identity line, with routes `/runs/<r>/team` and `/runs/<r>/github`.
- The **Team view**: every Claude session of the run that has team records, grouped by lane, with workflows, phase strips, a phase-grouped roster, an agent drawer, a cross-lane "Working now" panel, an owned-paths flag and a quiet-agent flag.
- **Run view integration**: a team line and stacked outline on step cards, a Team section in the step sheet, a "Working now" line in the live dock, and a team link in the Sessions table.
- A **Team section on the worker node page**, built from the same component.
- The **GitHub view**: an answer banner, pull request, branch with the commits a push would publish (with authors), connection, actions, commands to run by hand, and Copy run summary.
- **GitHub actions** as controller commands (`python -m workflow github push|pr|ready|reviewers … --by operator`), behind `MD_MANAGER_GITHUB_ACTIONS=on` and the run-control pairing.
- **Steering**: a "Send a note to the lead" control (`workflow note`) in the Controls menu, and the lead's resume command.

**Out of scope**

- A swimlane or Gantt timeline. Inline duration bars in the roster are the most allowed (P2).
- Transcripts. The server never serves them; the page shows the metadata and 400-character previews the contract carries.
- Per-agent dollar cost. It is not recorded; the lead session's cost covers its agents.
- Steering a single agent. A running workflow takes no input.
- Posting a PR comment. Copy run summary replaces it.
- A GitHub App, webhooks, check runs, auto-fix, a merge button, or starting runs from issues.
- Fetching from the remote.
- Agents as graph nodes or as Sessions rows.
- Enabling team lanes in the controller. That is a separate change; until it lands, today's single-session workers render unchanged.

**Contracts in use**

| Data | Route | Contract |
|---|---|---|
| Teams | `GET /api/projects/:p/workflows/:w/runs/:r/teams` | `teamsSchema` + `validateTeams` |
| Run GitHub read | `GET /api/dispatch/projects/:p/workflows/:w/runs/:r/github` | `runGithubSchema` |
| GitHub actions | `GET /api/run-controls/:p/:w/:r/github`, `POST …/github/:action_id` | `runGithubActionsSchema`, `githubActionRequestSchema` |
| Run summary | client-side | `runSummaryMarkdown`, `runSummaryTitle` |
| Note control | existing control routes | **new**: `note` appended to `CONTROL_IDS` (controls 1.2.0) |

## 2. Views and routing

**Routes.** `ProjectsRoute.run.tab` widens to `'run' | 'team' | 'github' | 'assignment'`. Add `TEAM_SEGMENT = 'team'` and `GITHUB_SEGMENT = 'github'`, their pathname builders, the parse branches beside Assignment's, and the `routeToPathname` cases. An extra segment is rejected as malformed. The Team view reads its selection from query parameters:

- `session`: a session key, such as `worker:ui`
- `workflow`: a `run_id`
- `agent`: an agent's `index`
- `state`
- `phase`
- `q`: the search text

Opening an agent pushes a history entry, so Back closes the drawer. Filter changes replace the current entry.

**Switcher.** It replaces the identity line's single `other` pill (`IdentityLine.tsx:99`) and Assignment's separate tablist. It renders on all four views.

- It is a `<nav aria-label="Run views">` of four `AppLink`s. The current one has `aria-current="page"`. It uses links, not a tablist, because each view is its own URL. This also removes the dangling `aria-controls="run-panel-run"`.
- Each segment has a Sheet fill and a 1 px Rule border, at 13px 600. On a desk it is 36 px tall with a 44 px hit area from a pseudo-element.
- The current segment is bold with a 3 px Signal Violet bar along its bottom edge. Selection is never a tone, and the bar keeps the suffix's tone legible.
- On a desk it sits where the pill was: after the Local/UTC toggle, before Controls.

**Labels and suffixes.** Run and Assignment take no suffix. Team and GitHub take one state suffix each: a 13px glyph and a lower-case word, in the tone from section 8.

| Segment | Suffix (first rule that holds) |
|---|---|
| Team | `{n} running` (run, adding ` · {f} failed` when there are failures); `{f} failed` (fail); `interrupted` (pause) when a workflow is interrupted and none runs; `{a} agents` (no tone) when every workflow ended; none when no session has team records or the teams read failed |
| GitHub | the `suffix` column of the GitHub situation table (section 4.2), e.g. `not pushed`, `#531 draft`, `#531 checks failing`, `#531 merged`, `signed out`, `reading` |

GitHub's state is said once per page, here. The identity line gets **no** separate GitHub chip. A suffix longer than 24 characters is ellipsized, with the full text in `title`. The link's accessible name carries the suffix in words: "GitHub view, pull request 531, checks failing". The Team segment always shows, even for runs without teams, so the switcher never changes shape when records appear mid-run.

**Keyboard.** The switcher is in normal Tab order. Enter follows the link. After navigation, focus moves to the new view's visually hidden `h2` (`#run-view-title`). There are no new global letter shortcuts, because the stage already uses arrows, Enter, `+`, `−` and `0`.

**Phone (stage under 720 px).** The switcher gets its own full-width row under the identity line: four equal columns, each 44 px tall, with 14px labels. Team and GitHub show only their 14px glyph as the suffix; the word moves into the accessible name and into each view's first line. The row never scrolls sideways.

**Node pages.** `RunBar` replaces its hard-coded Assignment link with the same four links: plain, no suffix, 44 px on phones.

**Polling.** Teams poll every 5 s while the run is live and the Team view or a worker sheet is open, every 15 s otherwise, and stop once the run has finished and no workflow is `running`. GitHub has its own `usePoll`: every 60 s on the GitHub view and every 120 s on the other run views (for the suffix). It keeps going after the run finishes, because checks and reviews change later. It refetches immediately after a GitHub action record ends.

## 3. Team view

### 3.1 Layout

**Desktop (1440).** A scrolling page inside the run frame, below the identity line, with 16 px gutters and one column at most 1180 px wide. It uses list-page geometry: Sheet panels, hairlines, 12 px panel corners, **no shadows**. The Stage-Is-The-Page rule governs the Run view; this is a sibling view, as Assignment is. From top to bottom:

1. **Head.** A visually hidden `h2` "Team", then one sentence at 15px:
   - With teams: "3 lanes · 2 with teams · 4 workflows · 61 agents · 5 running now · read 8 s ago".
   - Without: "No session of this run has team records; every worker ran as a single session."
   - Under it, once per view, in Pencil: "Context is each agent's last context size, not spend. The lead session's cost in the Sessions table covers its agents."
2. **Working now** panel (section 3.6).
3. **Lane panels**, one per `inputs.workers[]` entry, in definition order (section 3.2).
4. **Other sessions.** Sessions whose `lane` is null (challenge, reviewers, panel and similar) get their own panel only if one has records `found` or `unreadable`. Otherwise they get a single line: "6 other sessions ran without a team."

**Phone (390).** One column, 16 px gutters, the same order.
- Working now folds to its head line ("5 running · 1 failed ›") when it would show more than three rows.
- Lane heads stack, and their buttons go full width at 44 px.
- The phase strip becomes a list of 44 px rows.
- Roster rows become cards.
- The drawer is a bottom sheet at 78 % of the viewport with 16 px top corners.
- Nothing scrolls sideways.

### 3.2 Lane panel and the attention line

The panel has a Sheet fill and a 5 px top band in the tone of the lane's launch step, taken from `tone.ts` exactly as the graph draws it (One Mapping).

**Lane head** (desktop: one row of 44 px plus one line):
- Left: the lane chip (mono), the launch step's state pill, and either `team · {w} workflows` or `single session`.
- Right:
  - **Send a note to the lead**, only when the note control is offered and the browser is paired; otherwise the button is absent.
  - **Open worker page ›**
  - a **Lead commands** disclosure (section 7).
- Second line: **the attention line**, 13px. It is built from the first two rules below that hold, joined by " · ". The first of them sets the glyph and tone.

| # | Rule | Copy | Tone |
|---|---|---|---|
| 1 | a session of the lane is `unreadable` | "Team records could not be read: {reason}." | idle |
| 2 | an agent `failed` | "{n} agent(s) failed in {phase}" | fail |
| 3 | a workflow `interrupted` | "{name} was interrupted in {phase}; no summary was written" | pause |
| 4 | owned-paths flag (section 3.7) | "{n} file(s) edited outside this lane's paths" | fail |
| 5 | agents `running` | "{k} running in {phase}[, {phase2}] · last activity {age}" | run |
| 6 | quiet flag (section 3.7) | "{q} quiet for {m}m or more" | no tone |
| 7 | a workflow `killed` | "{name} was killed" | idle |
| 8 | every workflow `completed` | "Done · {w} workflow(s) · {a} agents · ran {d}" | ok |
| 9 | records `none`, session `running` | "No team workflow recorded yet; the lead session is working on its own." | idle |
| 10 | records `none`, session ended | "Single session, no team records." | none |

**Body.** One block per session of the lane, in payload order (the worker first, then repairs). When the lane has more than one session, each block gets a subhead with the session's `label` ("Worker · ui", "Repair 1"). How each block renders depends on its records:
- `found`: its workflow cards.
- `none`, while the lead runs: the sentence of rule 9.
- `none`, after the lead ended: "Single session, no team records. This session ran on its own; its row is in the Sessions table."
- `unreadable`: "Team records could not be read: {reason}."

A lane whose sessions are all `none` folds to its head line.

### 3.3 Workflow card

Cards come in contract order (oldest first). The latest card and any `running`, `failed` or `interrupted` card start expanded. The others fold to their head line. A card is a Sheet with 8 px corners, a hairline and a 5 px band in the workflow's tone.

**Head.**
- The name (Title 15.5px). When `name` is null, the `run_id` in mono.
- The status pill.
- The record source, in Pencil: "from the final summary", or "from the live records, read {age}".
- The description, clamped to two lines at 70ch, with a More toggle.

**Facts line** (tabular numbers, `·` separated):
- started time (Local/UTC)
- duration: "for 13m20s" while running (from `started_at` to now), "ran 41m27s" from `duration_ms` once ended, "not recorded" when null
- `{agent_count} agents`, or "400 of 512 agents listed" when `agents_more > 0`
- `{tool_calls} tool calls`
- context: "context 519,890" while recorded; for a live workflow, "context arrives with the final summary"
- `default model {default_model}`

**Status lines.**

| Status | Line under the facts |
|---|---|
| running | — (the caption "Agents waiting to start are not recorded until they start." sits under the phase strip) |
| completed | "Workflow completed; the lane's verification is separate." |
| failed | `error` as one fail-tone finding line, or "The summary records no error text." |
| killed | "This workflow was stopped before it finished (the summary says killed). Agents still running then show interrupted." |
| interrupted | "No summary was written and its records have not changed for 15 minutes: the lead session stopped or went quiet before the workflow finished." |

**Footer.** A **Script log and result** disclosure, present when `logs` or `result_preview` exists: up to 50 log lines, then the result, both as mono pre-wrapped text with the caption "agent text, as recorded".

### 3.4 Phase strip

The strip has one segment per `phases[]` entry, in `index` order. Segments are equal width, at least 140 px, and wrap to further rows rather than scrolling sideways.

- **Segment.** A 44 px button with the phase glyph, `{index} · {title}`, and a count line built from the non-zero counts: "1 running · 1 done", "2 failed · 4 done", "6 queued". A phase where every count is zero reads "not started" and is drawn with a dashed Track Soft border, like an unstarted edge.
- **Tone.** By precedence: fail when `failed > 0`; run when `running > 0`; pause when `interrupted > 0`; ok when `done === agents > 0`; idle otherwise.
- **Detail.** `detail` is the segment's `title` tooltip and, on phones, the row's second line.
- **Filter.** A segment toggles the roster's phase filter (`aria-pressed`, with a 2 px accent outline when pressed) and opens that phase's group.
- **Phone.** A vertical list of 44 px rows: glyph and title on the left, counts on the right.
- **No percentages.** The strip never shows a percentage or a live denominator. A queued agent is absent from the live records, so "6 of 40" would be invented.

### 3.5 Roster: phase-grouped, folding

**Grouping.** Agents are grouped by `phase_index`. Agents with no phase recorded go last, under "No phase recorded". Inside a group, rows keep `index` order, so a row never moves under the pointer when the page polls. Newly listed agents append at the end of their group with a 160 ms fade.

**Group header.** A 44 px button: `{index} · {title}`, the counts, the group's span (first `started_at` to last `last_activity_at`, when recorded) and a fold chevron.

**Folding rules** (keep 60 to 400 agents readable):

1. A group starts open when it holds a `running`, `failed` or `interrupted` agent, or has 6 agents or fewer. Otherwise it folds to its header with "Show {n}".
2. An open group renders at most 20 rows, then "Show {m} more".
3. A filter or search opens every group with a match and shows only the matches. The scope line says "Showing 5 of 61 agents".
4. When `agents_more > 0`, the last line reads "{agents_more} more agents are not listed; the reader lists the first 400."

**Filters.** These appear when the workflow lists more than 12 agents.
- **State**, one choice (`role="radiogroup"`): All {n} · Running {n} · Failed {n} · Interrupted {n} · Queued {n} · Done {n}. Choices with zero agents are hidden, except All.
- **Outside lane paths {n}**, a toggle shown only when the count is above zero.
- **Phase**, a select that mirrors the strip.
- **Find an agent**, a search over label, role, `#index`, agent id and edited file path.

The default is All, with the folding rules doing the work.

**Desktop columns** (`<table>` with a caption naming the workflow; rows are at least 44 px):

| Column | Content |
|---|---|
| State | glyph and lower-case word (`running`, `done`, `failed`, `interrupted`, `queued`); `replayed` chip when `cached` |
| Agent | `label` in mono 600 and `#index` in Pencil mono (labels repeat; `index` is the key); provider chips such as `via gpt-6-astra` from `providers` |
| Model | `model`, or "not recorded" |
| Started | `started_at` (Local/UTC), or "not recorded" |
| Ran | "for 4m10s" while running, else from `duration_ms`; then "quiet 12m" in Pencil when the quiet flag holds |
| Tools | `tool_calls` |
| Last tool | `last_tool` in mono and `last_tool_summary` (at most 60 characters), one line |
| Files | count of `files_edited` plus `files_edited_more`; the fail chip "{k} outside" when flagged |

The label cell holds the row's `<button>`; clicking the row delegates to it. Previews, context and the file list live in the drawer.

**Phone cards** (whole card is the button, at least 44 px):
- Line 1: glyph, `label #index`, state word, duration.
- Line 2: phase · model · `{tool_calls} tools` · `{files} files`.
- Line 3: last tool and its summary, clamped to two lines.
- The outside chip wraps under line 3.

### 3.6 Working now

The panel appears when `totals.running > 0`.
- **Title.** "Working now · {n} running in {L} lane(s)".
- **Rows.** One per `running` agent across every session, sorted by `started_at`, then `index`, so the order is stable. Each row shows:
  - the play glyph
  - `label #index`
  - the lane chip
  - the phase
  - "for 4m10s"
  - `last_tool · last_tool_summary`
  - "quiet 12m" when the quiet flag holds
- **Limit.** Six rows on a desk and three on a phone, then "Show all {n} running".
- **Opening.** Each row opens the agent drawer, which sets `session`, `workflow` and `agent`.

When no agent runs, the panel depends on the run:
- **Run live, workflows exist.** One line: "Nothing is running in any team. Last activity {age}."
- **Run finished.** One line: "Nobody is working. {w} team workflows ran in {L} lane(s)."
- **No session has team records.** The panel is absent.

### 3.7 Computed flags

**Owned-paths flag.** This is computed client-side from inputs the run export already carries. It applies only to sessions with `role === 'worker'`, because ownership is enforced at the worker handoff (`workflow/verification.py`, `enforce_ownership` when the phase is `worker`).

- `worker = inputs.workers.find(w => w.node_id === session.lane)`.
- A path `f` in `agent.files_edited` is **outside** when no `p` in `worker.owned_paths` gives `f === p || f.startsWith(p + '/')`. That is the controller's own `owns()` rule.
- Paths that are not worktree-relative are **not compared**: those starting with `/` or `~`, or carrying the redaction marker.
- Only the listed 50 files are compared; `files_edited_more` stays uncompared.
- When `inputs` is not loaded, or the worker has no entry, there is no flag. The drawer then says "This lane's owned paths are not recorded."

The flag shows in four places:
- the row chip "{k} outside" (fail tone, crossed-square glyph)
- the drawer's file list, with an `outside` chip on each such path
- rule 4 of the lane's attention line
- the step card (section 5)

The step's tone never changes because of the flag.

Copy: "Edited outside this lane's paths. Verification refuses a changed file outside them. This lane owns: {owned_paths joined by ', '}."

**Quiet-agent flag.** An agent is quiet when all three hold:
- `agent.state === 'running'`
- `agent.last_activity_at !== null`
- `teams.read_at − last_activity_at ≥ 10 minutes`

It shows as words only: "quiet 12m" in Pencil. It is not a state and changes no tone, because a long test command is a normal reason for silence. The server already turns a whole workflow `interrupted` after 15 quiet minutes. When `last_activity_at` is null there is no flag; nothing is guessed.

### 3.8 Agent drawer

On a desk it is a 440 px sheet on the right edge of the viewport, under the identity line, with the float shadow. On a phone it is a bottom sheet at 78 %. Either way it is `role="dialog" aria-modal="false"` with `aria-labelledby` pointing at its title.

**Head.**
- the 5 px band
- the title `label #index` (20px 700)
- the state pill
- the line "{phase} · {model} · attempt {attempt}"
- the agent id in mono with Copy, or "never started" when `agent_id` is null
- a 44 px Close button

**Fact tiles** (Inset):
- Started
- Last activity
- Ran
- Tool calls
- Context: "{n} tokens · last context size, not spend"
- Worktree: "own worktree" when `isolated`, else "the lead's worktree"
- Replayed, shown only when `cached`: "replayed from an earlier attempt, not run again"

Every null field reads "not recorded" in italic Pencil.

**Sections**, in order:
1. **Last tool**: `last_tool` and `last_tool_summary`.
2. **Asked to do**: `prompt_preview`, captioned "first 400 characters, agent text as recorded". For a live agent it may say "not recorded".
3. **Returned**: `result_preview`. Otherwise "No result yet." while running, "failed · no reason recorded" when failed, or "never finished" when interrupted.
4. **Files edited**: mono list, with `outside` chips and "and {files_edited_more} more not listed". Caption: "Only Edit and Write calls are recorded; changes made through shell commands are not. The worker page's Files created or changed is the full diff."
5. **Other providers**: the `providers` chips, captioned "called through the agent's shell".
6. A Pencil footer: "The transcript stays on this machine; this page shows metadata only."

All agent text renders as plain pre-wrapped text. It is never Markdown or HTML, and links are not made clickable.

**Footer.**
- **Previous agent** and **Next agent**, which walk the currently filtered roster.
- **Open worker page ›**

Escape closes the drawer and returns focus to the row that opened it.

### 3.9 View states

| State | Shows |
|---|---|
| Loading | `LoadingPanel` "Reading team records…" |
| Not loaded (fetch error, malformed) | `ErrorPanel` "Team records were not loaded: {describeApiError}." with a **Read again** button. A failed poll keeps the last data, plus the Pencil line "Last read failed; showing the read from {age}." |
| Not served (404 → `NOT_RECORDED.teams`) | "This server does not serve team records; update md-manager to see teams." |
| No sessions (`sessions: []`) | "No Claude session of this run has started yet." |
| Session `none` / `unreadable` | Section 3.2 |
| Workflow `running` / `completed` / `failed` / `killed` / `interrupted` | Section 3.3, with tones from section 8 |

## 4. GitHub view

### 4.1 Layout and card order

**Desktop.**
- The answer banner across the full width.
- Below it, two columns: a main column (`minmax(0, 720px)`) and a 360 px side column.
  - Main: **Pull request** then **Branch** when a PR exists; **Branch** then **No pull request** otherwise.
  - Side: **Publish on GitHub** (actions), then **Share with teammates**, then **Connection**.
- Below both columns, at full width: **Commands to run by hand**.

**Phone.** One column: banner, Publish on GitHub, Pull request, Branch, Share, Commands, Connection. Lists fold after five items.

**Banner.** It uses the Now-banner component: soft fill and glyph in the situation's tone, with the sentence at 14px 700. Under the sentence, a freshness line in Pencil: "GitHub read {age} · local git read {age}". After that comes the single next action: the offered action's button, or a link "See the command below ↓", "Open the failing check ↗" or "Open #{n} on GitHub ↗".

**Freshness rules.**
- Each GitHub-sourced card carries "read from GitHub {age}" (from `github.read_at`). Local facts carry "local git, read {age}" (from `read_at`).
- When `github.reason` is set while `status === 'read'`: "Last read failed: {reason}; showing the read from {age}."
- The Branch card always says "Remote-tracking facts are as fresh as your last fetch or push; this page never fetches."

### 4.2 The GitHub situation (banner and switcher suffix)

`githubSituation(runGithub)` is a pure function in `src/projects/github/model.ts`. It returns `{id, tone, sentence, suffix, next}`. **The first row that holds wins.** In the copy, `{repo}` is `repo.owner_name`, `{branch}` is `branch.name` and `{n}` is `pr.number`.

| id | Condition | Tone | Banner sentence (exact) | Suffix |
|---|---|---|---|---|
| no-branch | `branch.name === null` | idle | This run records no branch, so there is nothing to compare with GitHub. | no branch |
| no-remote | `repo.status === 'no_remote'` | idle | This project has no Git remote, so the run branch exists only on this machine. | no remote |
| not-github | `repo.status === 'not_github'` or `github.status === 'not_github'` | idle | This project's remote is not on GitHub, so there is nothing here to read. | not GitHub |
| repo-unread | `repo.status === 'unavailable'` | idle | The repository could not be read: {repo.reason}. | not read |
| reads-off | `github.status === 'off'` | idle | GitHub reads are turned off on this server; the branch facts below are local only. | reads off |
| gh-missing | `unavailable`, reason `gh is not installed` | warn | The gh CLI is not installed on this machine, so this page cannot read {repo}. | not read |
| gh-logged-out | `unavailable`, reason `gh is not logged in` | warn | gh is not signed in on this machine, so this page can neither read {repo} nor publish to it. | signed out |
| gh-unread | `unavailable`, any other reason | idle | GitHub was not read: {github.reason}. The branch facts below are local only. | not read |
| pending | `github.status === 'pending'` | idle | Reading {repo} for this branch; the first read lands within two minutes. | reading |
| no-local-branch | `push_state === 'no_local_branch'` | idle | The run branch {branch} is not in this repository, so there is nothing to push. | no branch |
| merged | `pr.state === 'MERGED'` | ok | #{n} was merged into {base_ref} {age of merged_at}. | #{n} merged |
| closed | `pr.state === 'CLOSED'` | idle | #{n} was closed without merging {age of updated_at}. | #{n} closed |
| diverged | `push_state === 'diverged'` | fail | The run branch and GitHub's copy have diverged; this page will not push over GitHub's commits. | diverged |
| remote-ahead | `push_state === 'remote_ahead'` | warn | GitHub's copy of the branch has {behind_remote} commit(s) the run branch lacks; this page will not push over them. | behind GitHub |
| conflicts | `pr.mergeable === 'CONFLICTING'` | fail | #{n} has conflicts with {base_ref}; GitHub cannot merge it as it is. | #{n} conflicts |
| checks-failing | `pr.checks.failing > 0` | fail | {Draft #n / #n} has {failing} failing check(s): {first two names}{, and m more}. | #{n} checks failing |
| changes-requested | `review_decision === 'CHANGES_REQUESTED'` | fail | {author of the latest CHANGES_REQUESTED review, else "A reviewer"} asked for changes on #{n} {age}{; u unresolved thread(s)}. | #{n} changes requested |
| pr-behind-local | PR open and `push_state === 'local_ahead'` | idle | #{n} is open, but {ahead_of_remote} commit(s) on the run branch are not on GitHub yet. | #{n} · {k} to push |
| approved | `review_decision === 'APPROVED'` | ok | #{n} is approved{ by author}; checks {passing / pending / not recorded}. | #{n} approved |
| draft | `pr.draft` | idle | Draft #{n} is open; checks: {passing} passing, {pending} pending. A draft notifies no reviewer until you mark it ready. | #{n} draft |
| in-review | PR open | run | #{n} waits for review{ from reviewer1, reviewer2}; checks: {passing} passing, {pending} pending. | #{n} in review |
| not-pushed | `push_state === 'not_pushed'` | idle | Not on GitHub yet: {unpublished count incl. more} commit(s) would become public on {repo}. (Private repo: "…would be published to {repo}, a private repository.") | not pushed |
| local-ahead | `push_state === 'local_ahead'`, no PR | idle | GitHub has an older copy of the branch; {ahead_of_remote} commit(s) are not pushed yet, and there is no pull request. | {k} to push |
| pushed-no-pr | `push_state === 'up_to_date'`, no PR | ok | The branch is on GitHub at {github_sha 7}; there is no pull request yet. | pushed |
| unknown | otherwise | idle | Where the branch stands against GitHub is unknown: git could not compare it with the remote. | unknown |

Every row has a unit test and a Playwright fixture. GitHub status never changes the run's own status or verdict.

### 4.3 Cards

**Pull request.**
- **Head.** `#{n} {title} ↗` (accent link) and the state pill: `draft` idle, `open` run, `merged` ok, `closed` idle. Then `{head_ref} → {base_ref}` in mono and "by {author} · updated {age}".
- **Head commit.** When `pr.head_sha` differs from `branch.local_sha`: "The pull request shows {head_sha 7}; the run branch is at {local_sha 7}."
- **Review decision.** Uses the project page's `REVIEW_WORD` mapping: `approved` ok, `changes requested` fail, `review required` idle.
- **Merge.** `can merge` (Pencil); `conflicts with {base_ref}` (fail); `GitHub is still checking` (idle); "not recorded".
- **Checks.**
  - The line "{failing} failing · {pending} pending · {passing} passing · {skipped} skipped".
  - One row per `checks.items` entry, in the contract's order (failing first): glyph by `bucket`, `name`, the lower-cased conclusion, and "details ↗" when `url` is set.
  - Passing rows fold behind "Show {passing} passing" when more than five rows exist.
  - `checks === null`: "No checks on the head commit."
- **Reviewers.**
  - Requested reviewers as chips: a user by login, a team as `team kleros/vea-maintainers`, a bot as `bot {login}`.
  - Latest reviews as rows: "{author} · {approved / changes requested / commented / dismissed / pending} · {age}".
- **Conversation.** "{comments} comments · {review_threads} review threads{, u unresolved}".
- **Earlier PRs.** When there are any: "Earlier pull requests from this branch: #520 closed, #511 merged".

**No pull request** (when `pr` is null). "There is no pull request whose head is this branch." The Open draft pull request action sits in the actions card.

**Branch.**
- **Name.** `branch.name` in mono, wrapping, with Copy. The push-state pill (tones in section 8): `not pushed`, `up to date`, `{k} ahead of GitHub`, `{k} behind GitHub`, `diverged`, `not in this repository`, `unknown`.
- **Shas.** "local {local_sha 7} · remote-tracking {tracking_sha 7} · GitHub {github_sha 7}", with "none" for null.
- **Default branch.** "{ahead_of_default} ahead of {default_branch}, {behind_default} behind".
- **Integrated commit.**
  - "Contains the run's integrated commit {integrated_commit 7}."
  - "Does not contain the run's integrated commit {sha}." (warn)
  - "The run has no integrated commit."
- **Commits a push would publish ({count}).** Newest first. Each row: `sha 7` in mono, the subject, `author` exactly as recorded (`Name <email>`), and the time. Then "and {unpublished_more} more not listed".

**Connection.**
- `{repo} ↗` and a neutral `public` / `private` / `internal` chip. Visibility is a fact, not a state, so the chip is untoned, as on the project page.
- "signed in to gh as {viewer_login} · permission {viewer_permission lower-cased} · remote {remote} · default branch {default_branch}"
- "md-manager reads GitHub through the gh CLI signed in on this machine. It keeps no GitHub token."

**Share with teammates.**
- **Copy run summary.** It runs `runSummaryMarkdown(input)` client-side. The button says "Copied", or "Select to copy" when the clipboard fails.
- Text: "One Markdown text for a chat, an issue or the pull request. Facts this run did not record are left out; the draft pull request starts from the same text."
- A **Show the text** disclosure with the exact Markdown in a mono box.
- **Input mapping:**
  - `runId`, `workflowId`, `feature` (the feature title), `status`, `headline` (the Now headline)
  - `branch` (`inputs.source_branch`), `baseCommit`, `integratedCommit`
  - `review` (verdict, reviewers, open P0/P1/P2)
  - `lanes[]`: each `{lane, summary: the worker report's first paragraph, team: {workflows, agents, failed} from the worker session, or null}`
  - `costUsd` (the run's recorded Claude spend, or null)
  - `pr` from `runGithub.pr`

### 4.4 Publish on GitHub (actions panel)

The panel reads `runGithubActions` only when run controls are on and the browser is paired, because the GET needs the token. It has four states:

| Condition | Panel copy |
|---|---|
| Run controls off (`/status` `enabled: false`) | "Run controls are off on this server, so nothing is published from this page. The commands below do the same by hand." |
| Not paired | "Pair this browser in the Controls menu to publish from this page, or run the commands below." |
| `enabled: false` | "GitHub actions are off. Start the dashboard with MD_MANAGER_GITHUB_ACTIONS=on to publish from this page; the commands below do the same by hand." |
| Enabled | One row per action, in contract order: push_branch, open_pr, mark_ready, request_reviewers |

**Action rows.**
- **Available.** A 44 px button with the server's `label`, and `publishes` beneath it in Pencil.
- **Unavailable.** The label as plain text (not a disabled button), and "Not offered: {reason}".
- **Recent GitHub actions.** Up to five records: label · status word (`running` run, `succeeded` ok, `failed` fail, `refused` warn, `lost` idle) · time · the `url` link. Failed and refused records add an "Output" fold with `output_tail`.

**Controls menu.** It gains a "GitHub" group that lists the same four actions and opens the same dialog. The page never decides what is offered: the server's `available`/`reason` does. Offer rules such as integrated-only, write permission, not diverged and never the default branch live there.

### 4.5 Dialogs (exact copy)

The dialogs reuse the `ControlDialog` shell (modal, focus trap, Cancel, the opener gets focus back).

Every GitHub dialog has these parts, in order:
1. title
2. visibility block
3. "What it does": the server's `effect`, plus one facts line
4. "What it does not do": `not_effect`
5. "What becomes visible": `publishes`, plus the commit preview for a push
6. fields
7. "The exact command": the server's `command`, with Copy and the caption "The controller checks the branch and the commit again before it runs git or gh."
8. the typed confirmation when `confirm === 'typed_repo'`
9. the confirm button

**Visibility block.** It is a Sheet with a 5 px warn band (the Band Rule; no tinted box) and the question-diamond glyph.

- **PUBLIC**, push:
  - Heading: "**kleros/vea is public.**"
  - Body: "After this push anyone on the internet can read these {k} commits: their messages, their authors' names and email addresses, and every line they change. A push cannot be taken back: deleting the branch later does not remove copies already fetched or forked."
- **PUBLIC**, open_pr:
  - Heading: "**kleros/vea is public.**"
  - Body: "Anyone on the internet can read the title and the text below, and the pull request stays listed on the repository even if you close it."
- **Unknown visibility** (`visibility === null`): "The repository's visibility was not read, so treat it as public." The confirmation is typed.
- **PRIVATE / INTERNAL**: "{repo} is private: what this publishes is visible to everyone with access to the repository." This form has no band.

**Push the run branch to {repo}.**
- **Facts line.** "{branch} at {local_sha 7} → {remote} on github.com/{repo}. A plain push: never forced."
- **Commit preview.**
  - Heading: "Commits that become {public / visible} ({count})".
  - Rows as on the Branch card, with each row's **author** in full.
  - The list comes from the same `runGithub` read. The request carries the actions' `state_token`, so if the branch moved, the POST answers 409 and the dialog says so.
- **Typed field.** Its label is "Type **kleros/vea** to confirm". It matches exactly and case-sensitively, and is never prefilled.
- **Button.** "Push {k} commit(s) to kleros/vea". It stays disabled until the typed text matches.

**Open a draft pull request on {repo}.**
- **Facts line.** "From {branch} into {default_branch}. Always a draft: GitHub asks no one to review until you mark it ready."
- **Fields.**
  - **Title**: text, prefilled from `defaults.title`, which is `runSummaryTitle`.
  - **Body**: multiline and editable, prefilled from `defaults.body`, which is the run summary. A counter shows "{n} of {max_length} characters". Caption: "Local paths are already removed. It includes the run's recorded Claude spend when there is one; delete that line if you prefer."
- **Typed confirmation**, then the button **Open draft pull request**.

**Mark #{n} ready for review.** A plain confirmation. Facts line: "GitHub notifies the requested reviewers: {requested_reviewers, or 'nobody is requested yet'}." Button: **Mark ready for review**.

**Request reviewers on #{n}.**
- **Field.** One login or `org/team` per line, validated against `OWNER_NAME`-like shapes, up to `max_items`. `suggestions` appear as toggle chips. The field is never prefilled; `defaults.reviewers` is empty.
- **Facts line.** "GitHub notifies each person, and every member of each team, now."
- **Button.** "Request {k} reviewer(s)".

**Outcomes** (in the dialog, then in the records list):

| Outcome | Copy |
|---|---|
| running | "The controller is running it; this takes up to a minute." |
| succeeded | "Done. GitHub is read again within two minutes." and the `url` |
| failed | "The command failed (exit {code})." with `output_tail` |
| refused | "The controller refused it: {last output line}." |
| 409 `STATE_CHANGED` | "The branch or the pull request changed since this dialog opened. Close it and open it again to see the new facts." |

### 4.6 Commands to run by hand

This card is always present, also when actions are on. Its caption: "Run these yourself in a terminal on this machine. They skip this page's checks; the page reads GitHub again within two minutes."

Each command sits in a `command-line` box with Copy. Values are real and shell-quoted, and `{checkout}` is the project's checkout as the project page shows it (`~/dev/vea-cook-relayer-revert-shapes`). Which commands show depends on the situation:

| When | Commands |
|---|---|
| gh-missing, gh-logged-out | `gh auth status --hostname github.com` · `gh auth login --hostname github.com --git-protocol https` · `gh auth setup-git --hostname github.com`, then "Then reload this page." |
| no-remote | `git -C {checkout} remote -v`, then "Add a GitHub remote yourself; this page never changes remotes." |
| not-pushed, local-ahead, pr-behind-local | `git -C {checkout} push origin {local_sha}:refs/heads/{branch}` (never `--force`) |
| pushed and no open PR | the `gh pr create` heredoc below |
| draft | `gh pr ready {n} --repo {repo}` |
| PR open | `gh pr edit {n} --repo {repo} --add-reviewer {reviewers}` |
| diverged, remote-ahead | `git -C {checkout} log --oneline --left-right {local_sha}...origin/{branch}`, then "Resolve it yourself; this page offers nothing that overwrites GitHub's copy." |

**Reviewers command.** The reviewer list comes from a small field above the command. While the field is empty, Copy is disabled with "Name a reviewer first". No placeholder ever reaches the clipboard.

**Draft PR command.** The body is the run summary, inlined through a quoted heredoc so it copies in one go:

```sh
gh pr create --repo kleros/vea --head feature/relayer-revert-shapes/relayer-revert-shapes-002 --base dev --draft --title 'relayer-revert-shapes: relayer-revert-shapes-002' --body-file - <<'MD_MANAGER_SUMMARY'
### relayer-revert-shapes: relayer-revert-shapes-002
…the run summary…
MD_MANAGER_SUMMARY
```

There is no PR comment command.

## 5. Run view integration

The identity line gets only the switcher (section 2). The stage layout does not change. Everything below is silent when the matching team session's records are `none` (a team session is mapped to its card by `session.node_id`). A pixel and DOM snapshot of run 002 must not change.

**Step card** (the session's records are `found`):
- Row two reads `worker · team` (a new `stageExecutor` word, `team`, with the phrase "a lead session with a team of agents").
- Row three keeps the lane chip and the duration, then adds:
  - `{agents} agents` and `· {k} running` (run word), or `· {f} failed` (fail word and glyph)
  - `· {o} outside paths` (fail) in the open-P1 slot when the owned-paths flag holds
- Row four (full detail, 125 % zoom and above), while an agent runs: "{phase} · {label} · {last_tool}: {summary}" for the most recently active running agent. Otherwise row four keeps the last event.
- The overview chip adds "team · {k} running".
- The accessible name gains ", team of {a} agents, {k} running, {f} failed".
- The card keeps 232 × 136 px and grows to its 176 px maximum only when its lines wrap.
- The outline is the stacked deck (section 8). The legend gains "Stacked edge · a lead session with a team of agents".

**Step sheet** (`sheetExtras`): a `Team` section before Events (`data-testid="sheet-team-section"`).
- Content, in order:
  - the lane's attention line
  - one line per workflow: name, pill, "{a} agents · {k} running · for 12m"
  - the latest workflow's phases as wrapping chips (glyph, title, count)
  - up to three running agents: label · phase · last tool
  - **Open in Team view ›**, which links to `/team?session={key}`
  - **Send a note to the lead**, when offered and paired
- A worker with records `none` shows the rule 9 or rule 10 sentence. `unreadable` shows the reason.
- Non-worker nodes show the section only when their session's records are `found` or `unreadable`.

**Live dock.** A `.lv-sec` row between the Now banner and Latest events (`data-testid="live-dock-working-now"`). It is one 44 px button, clamped to one line on phones:
- While `totals.running > 0`: "Working now · {n} agents in {L} lane(s) · {phase}, {phase} +{m} · last activity {age} ›". It opens `/team?state=running`.
- While the run is live and a workflow is `interrupted`: "A team workflow in {lane} was interrupted · Team ›", with the pause glyph.
- Otherwise the row is absent. `Ran · Spent · Deadlines` do not change. Spent's tooltip adds "covers each lead session and its agents; per-agent cost is not recorded".

**Sessions table.** A session row whose records are `found` shows, after the model, in Pencil: "team · {w} workflows · {a} agents" and a **Team ›** link to `/team?session={key}` (`data-testid="session-team-link"`). An `unreadable` row shows "team records not read". The table gains no agent rows.

## 6. Worker node page: Team section

- **Index.** `launchSectionEntries()` gains `{key: 'team', label: 'Team', count: agents}` after Files and before Task. For a records-`none` worker the entry carries no count.
- **Section.** `WorkerSections` renders `<NodeSection sectionKey="team" title="Team" testId="team-section">`, holding the **lane panel body** of section 3.2 scoped to this node's sessions: the attention line, the workflow cards, the phase strips, the roster with filters and folding.
- **Repair nodes.** These get the same section for their own session when its records are `found` or `unreadable`.
- **Drawer.** The agent drawer opens as on the Team view. Its selection is local to the page, and **Open in Team view ›** carries it to `/team?session&workflow&agent`.
- **Unchanged.** The step strip, the run bar (with the four links) and the other sections.
- **Data.** Teams come from the run-level resource created in `RunView` and passed down. `NodeDetail` fetches nothing new.

## 7. Steering

**Send a note to the lead.** This is a new run control: `note` is appended to `CONTROL_IDS` (controls 1.2.0), with the same guard and pairing as every control.

- **Server spec:** `id: 'note'`, `label: 'Send a note to the lead'`, `runs: 'short'`, `confirm: 'plain'`, `params: [lane choice, textSpec('text', 1, 4000)]`.
- **Command:** `display` is `$PY -m workflow note "$RUN" {lane} --by operator -- "<text>"`, the same shape as `answer`.
- **Effect:** "Types your note into the lane's lead session pane as an operator note and records it in the lane's notes."
- **Not effect:** "A running team workflow takes no input: its agents never see the note, and the lead reads it when its current turn ends. It stops and restarts nothing."

It is offered for a launched lane that is not frozen, not finished and not waiting on a question. Otherwise it is unavailable with the server's reason (for a waiting lane: "The lane waits on its question; answer it instead.").

**Where it opens.** It is in the Controls menu. The lane-head button (Team view), the sheet's Team section and the node page open the same dialog with the lane preset.

**Dialog copy.**
- Title: "Send a note to the lead of {lane}".
- Field: "Your note", with the helper "Plain text, up to 4,000 characters. The lead reads it as an operator note, which may amend its task."
- Then What it does, What it does not do, and the exact command.
- Button: **Send note**.

**Outcomes.**

| Outcome | Copy |
|---|---|
| succeeded | "Typed into {lane}'s pane." |
| recorded `undeliverable` | "Not delivered: the pane was busy, not attached, or the lane was not working or idle. Nothing was typed; look at the pane, then send it again." |
| exit 1 `enter_not_submitted` | "The note is still in {lane}'s input line: submit or clear it in the pane, and do not send it again." |

**Lead commands** (a disclosure on the Team lane head, also in the sheet's Command section):
- `claude --resume {session_id}` with **Copy** and **Show command**, following the Sessions pattern, and "run it in the session's worktree".
- Caption: "A team workflow resumes only inside the session that ran it; resuming the lead does not restart a killed or interrupted workflow by itself."
- Button text never contains "resume", so `expectNoExecutionControls` stays green.

## 8. Visual language and tokens

**No new tokens or colours.** Every tone comes from `tone.ts` via new `agentTone`, `workflowTone`, `phaseTone`, `pushTone`, `prTone` and `checkTone` functions. Each is repeated by a `Glyph` and a lower-case word.

| Tone | Agents | Workflows | Phases | Branch | PR / review / checks |
|---|---|---|---|---|---|
| ok (tick) | done | completed | all done | up to date | merged, approved, pass |
| run (play) | running | running | any running | — | open, pending check, in review |
| warn (diamond) | — | — | — | behind GitHub | gh missing or signed out; refused record |
| fail (crossed square) | failed | failed | any failed | diverged | conflicts, changes requested, failing check; outside-paths chip |
| pause (bars) | interrupted | interrupted | any interrupted | — | — |
| idle (dotted ring) | queued | killed | not started, only queued | not pushed, ahead, unknown, not in repo | draft, closed, review required, skip, neutral |

**Precedence** within a container is fail > run > pause > ok > idle, so a failure is never hidden by activity. Rows are never tinted: only pills, the Now-banner GitHub answer and finding lines take soft fills, and containers take the 5 px band.

**Team executor outline.** The card keeps the **solid** 1.5 px Rule outline, because the lead is an agent session. It adds a stacked "deck": a copy of the card's edge offset 6 px right and 6 px down behind it, with a Sheet fill and a 2 px Rule edge, at the same 10 px radius, drawn as two offset box-shadows because the card clips a `::before` (as built; the first draft said a 4 px `::before`, too faint at 100 % zoom). It sits inside the 72/44 px gaps and below the float shadow, so hover still lifts. Dashed (verifier) and dotted (controller) are unchanged, no colour joins the outline, and a single-session worker keeps the plain card. The word `team` on row two repeats it.

**Density.**
- Rows: at least 44 px.
- Type:
  - text: Body dense 13px on a desk, 14px under 720 px
  - labels, ids, paths and commands: mono 13px
  - numbers: tabular
  - previews: at most 70ch
- Classes: `.team-*` and `.gh-*` in `src/projects/teams/teams.css` and `src/projects/github/github.css`, each with a copy of `sessionsStyle.test.ts`. Font sizes come from {11, 13, 13.5, 14, 15, 15.5, 16, 20}, radii from {4, 8, 10, 12, 999}, with no literal colours and no thick coloured left borders. `typeFloor.test.ts` covers both files.

**Surfaces.** The Team and GitHub views are list pages: no shadows. Only the agent drawer floats, because it is a sheet.

**Motion.** All of it sits under `prefers-reduced-motion: no-preference`:
- A running agent's play glyph breathes: opacity 1 → .55 over 2.4 s, ease-in-out.
- New roster rows fade in over 160 ms.
- The drawer slides in over 240 ms.

There are no spinners, no progress bars and no flashing failures.

## 9. Copy glossary

| Say | Not | Meaning |
|---|---|---|
| team | ultracode, swarm, crew | the agents one session fanned out |
| lead, lead session | parent, orchestrator | the worker (or repair) session that runs the team |
| workflow | wf_, script run | one run of a team script; `run_id` in mono only when unnamed |
| phase | stage, step | a named group of the script's agents |
| agent | subagent, teammate, sidechain | one Workflow agent |
| running · done · failed · queued · interrupted · killed | thinking, busy, crashed, orphaned | the contract's words, lower case |
| replayed | cached | an agent reused from an earlier attempt |
| context | tokens spent, usage, cost | last context size |
| files edited | files changed | Edit or Write calls only (the worker page's diff is "files changed") |
| outside this lane's paths | scope creep, violation | the owned-paths flag |
| quiet 12m | stalled, stuck, idle | the quiet flag |
| not recorded | —, 0, n/a, unknown | absence, italic Pencil |
| live records · final summary | journal, wf json | the two sources |
| push · draft pull request · mark ready · request reviewers | publish PR, ship, sync | the four GitHub actions |
| commits that become public | changes, diff | the push preview |
| Copy run summary | export, share link | the Markdown text |
| Send a note to the lead | message the team, chat | the note control |

On screen, `ultracode` never appears. Button text never uses the words `approve`, `retry`, `launch`, `start`, `resume`, `delete`, `cancel`, `integrate`, `edit` or `save` outside paired dialogs.

## 10. Accessibility

- **Landmarks.**
  - The switcher is a `<nav aria-label="Run views">` with `aria-current="page"`.
  - Each view has a visually hidden `h2#run-view-title`.
  - Every panel is a `<section aria-labelledby>` with its own heading: lane panels `h3`, workflow cards `h4`.
- **Controls.**
  - Phase segments are buttons with `aria-pressed`.
  - The state filter is a `role="radiogroup"` of `role="radio"` buttons.
  - Fold toggles carry `aria-expanded` and `aria-controls` that point at existing ids.
- **Roster.** Desktop rows are a `<table>` with a `<caption>`, and one `<button>` per row in the label cell. Its accessible name reads "impl:frontend #3, running, Implement, 4 minutes, 96 tool calls, 2 files outside lane paths". Phone cards are a `<ul>` of buttons with the same names.
- **Focus.**
  - Opening the drawer focuses its Close button.
  - Escape closes the drawer and returns focus to the opener.
  - Dialogs trap focus as `ControlDialog` does.
  - After a view switch, focus goes to `#run-view-title`.
  - Every control shows the 2 px accent focus outline.
- **Announcer.** The app's single polite announcer is used through `onAnnounce`, and nothing is announced on first load. It speaks at most once per poll and at most every 10 s, coalescing what remains. In priority order:
  1. a workflow's status change ("Workflow fix-review-findings in ui completed")
  2. a newly failed agent ("review:gpt #5 failed in Review")
  3. a change of GitHub situation ("GitHub: #531 checks failing")

  It never announces tool calls or counts ticking. Copy buttons keep their local `aria-live` span.
- **No colour alone.** Every tone has a glyph and a word, and every "not recorded" is text.
- **Test ids.** They are kebab-case `<area>-<thing>[-<part>]`. Identity goes in `data-*` (`data-session`, `data-workflow`, `data-index`, `data-lane`, `data-view`, `data-action`) and state goes in `data-state` and `data-tone`:

| Area | Test ids |
|---|---|
| Switcher | `run-views`, `run-view-link` (`data-view`), `run-view-suffix` |
| Team view | `team-view`, `team-head`, `team-working-now`, `team-working-row`, `team-lane` (`data-lane`), `team-attention`, `team-session` (`data-session`), `team-session-empty`, `team-workflow` (`data-workflow`, `data-state`), `team-phase-strip`, `team-phase` (`data-index`, `data-tone`), `team-filters`, `team-phase-group`, `team-agent-row` (`data-index`, `data-state`), `team-outside-chip`, `team-quiet`, `team-agent-drawer`, `team-lead-commands` |
| Run view | `stage-team-line`, `sheet-team-section`, `live-dock-working-now`, `session-team-link` |
| Node page | `team-section` |
| GitHub view | `gh-view`, `gh-banner` (`data-state` = situation id), `gh-pr-card`, `gh-check-row`, `gh-branch-card`, `gh-commit-row`, `gh-connection-card`, `gh-share-card`, `gh-summary-copy`, `gh-actions`, `gh-action` (`data-action`), `gh-action-record`, `gh-dialog`, `gh-visibility-block`, `gh-commit-preview`, `gh-typed-confirm`, `gh-commands`, `gh-command` (`data-command`) |
| Note control | `control-note` |

## 11. Build list

Playwright scenarios run against the mock API (`tests/project-workflows/mock.ts`), with new `kind === 'teams'`, `'run-github'` and `'run-github-actions'` branches and contract-shaped 404s. Fixtures extend `teamExamples.ts`:
- `teams` itself
- `teams-large`: 6 phases, 400 listed agents, `agents_more` 112
- `teams-killed`, `teams-interrupted`, `teams-none` (the run 002 shape), `teams-unreadable`
- one `runGithub` per situation in section 4.2

Every scenario runs at 1440 × 900 and 390 × 844 and asserts no horizontal page overflow.

### P0: read side complete, plus the note

| # | Item | Acceptance criteria | Scenarios |
|---|---|---|---|
| 1 | Routes and switcher | `/team` and `/github` parse and build, and malformed paths are rejected (`routes.test.ts`). Four links on all four views and on `RunBar`, with `aria-current`. No `aria-controls` points at a missing id. The suffixes follow section 2. Phone: one row, four 44 px columns. Back and forward work. | `run-views-switcher`, `run-views-phone` |
| 2 | Teams client | A `fetchTeams` validated with `validateTeams`, with the scope check `run_id`. `NOT_RECORDED.teams` for a 404. Polls as section 2. A malformed payload shows the not-loaded state. | `team-view-not-loaded`, `team-view-not-served` |
| 3 | Team view | Section 3 complete. The `teams` fixture shows a completed and a running workflow, Repair 1's "Single session" line and the challenge's unreadable reason. `teams-large` opens no more than 20 rows of any group, folds done-only groups and shows the `agents_more` line. Duplicate labels open distinct drawers by `index`. Agent text renders as text (a `<b>` in a preview stays literal). No percentage appears. | `team-view-running`, `team-view-completed`, `team-view-failed`, `team-view-killed`, `team-view-interrupted`, `team-view-single-session`, `team-view-unreadable`, `team-view-large-folding`, `team-filters`, `team-agent-drawer`, `team-working-now` |
| 4 | Flags | Unit tests in `teams/model.test.ts`. An agent editing `server/x.ts` in a lane owning `src/projects` is outside; `src/projects` and `src/projects/a.ts` are inside; `~/x` and `/x` are not compared. Quiet holds at 10 minutes and not at 9. A null `last_activity_at` raises no flag. Neither flag changes a step's tone. | `team-owned-paths-flag`, `team-quiet-agent` |
| 5 | Run view integration | Section 5. Run 002 (records `none`) is DOM- and pixel-identical to today. The team card shows the deck, `worker · team`, the counts and the accessible-name suffix. The sheet, the dock line and the Sessions link appear only with records. | `run-card-team-line`, `run-sheet-team-section`, `run-dock-working-now`, `sessions-team-link`, `run-legacy-unchanged` |
| 6 | Node page Team section | An index entry after Files. The same component, scoped to the node. The drawer opens, and the Team view link carries the selection. | `node-team-section` |
| 7 | GitHub read view | `githubSituation` has a unit test per row of section 4.2, each banner sentence exact. Section 4.3 cards. Freshness lines. The commands card per section 4.6, with no placeholder copyable. Its own poll, which continues after the run finishes. Public and private chips are untoned. | `github-no-branch`, `github-no-remote`, `github-not-github`, `github-reads-off`, `github-gh-missing`, `github-gh-logged-out`, `github-pending`, `github-not-pushed`, `github-local-ahead`, `github-remote-ahead`, `github-diverged`, `github-pushed-no-pr`, `github-draft`, `github-in-review`, `github-checks-failing`, `github-changes-requested`, `github-approved`, `github-conflicts`, `github-merged`, `github-closed`, `github-commands-card` |
| 8 | Copy run summary | The clipboard receives exactly `runSummaryMarkdown(input)` for the fixture, and **Show the text** matches it. A unit test shows the client input contains no absolute path. | `github-copy-summary` |
| 9 | Note control | `note` in `CONTROL_IDS` (1.2.0) and in `SPECS`, with argv `[-m, workflow, note, runDir, lane, --by, operator, --, text]`. Offered or unavailable per section 7. The dialog copy is exact. The undeliverable and `enter_not_submitted` outcomes show their sentences. With controls off, no note button exists, and `expectNoExecutionControls` passes. | `note-control`, `note-control-undeliverable` |

### P1: GitHub writes, doubly gated

| # | Item | Acceptance criteria | Scenarios |
|---|---|---|---|
| 10 | Actions panel | The four panel states of section 4.4. Rows in contract order. Unavailable rows show their reason as text. The records list. The Controls menu's GitHub group opens the same dialog. | `github-actions-controls-off`, `github-actions-unpaired`, `github-actions-off`, `github-actions-offered`, `github-action-record` |
| 11 | Dialogs | The exact copy of section 4.5. The public push lists every unpublished commit with its author, and its button stays disabled until `kleros/vea` is typed exactly. The private form has no band. Unknown visibility asks for the typed name. The PR body is editable and prefilled. A 409 shows the stale sentence. Every request carries `request_id` and `state_token`. | `github-push-public-dialog`, `github-push-private-dialog`, `github-open-pr-dialog`, `github-mark-ready`, `github-request-reviewers`, `github-action-stale` |
| 12 | Controller and server (dependency) | `workflow github push|pr|ready|reviewers` exists, with a README row and a RUNBOOK section. Tests use a temporary bare remote and a fake `gh`, never GitHub. The server spawns no git or gh itself (the housekeeping test). | covered by the workflow suite and `server/` tests |
| 13 | Doc copy | `PRODUCT.md` principle 5, `DESIGN.md`'s "Don't put a control…" line, RUNBOOK :205/:435, and `GithubColumn.tsx`'s "Runs never push." become "The workflow never pushes on its own; pushing and pull requests are the operator's explicit, paired actions." | `project-github-column-copy` |

### P2

| # | Item | Acceptance criteria | Scenarios |
|---|---|---|---|
| 14 | Inline duration bars | A 48 × 6 px bar in the Ran cell, proportional to `duration_ms` / the workflow's maximum, in the state's tone. Absent when the duration is null. No time axis. | `team-duration-bars` |
| 15 | Role filter | Chips from `agent.role`, shown when a workflow has three roles or more. | `team-role-filter` |
| 16 | Isolated agent diff | For `isolated` agents, a link to their worktree's diff once a contract serves it. | — |
| 17 | Team failure notices | A failed agent or an interrupted workflow writes through attention-notify (Telegram). | — |

## 12. Disagreements and picks

| Question | Positions | Pick and why |
|---|---|---|
| Switcher semantics | tablist (Fable, DeepSeek, Argon) · route links (Opus, Astra) | **Links with `aria-current`.** Each view is a URL, and this removes the dangling `aria-controls`. |
| Current-segment style | Ink fill (Fable) · accent fill (Argon) · bold plus violet underline (Opus) | **Underline.** Selection stays violet, and a filled segment would swallow the suffix glyph's tone. |
| GitHub chip in the identity line | chip (Fable, Astra, DeepSeek, Muse, Argon) · switcher suffix (Opus) | **Suffix only** (decision already taken): GitHub's state is said once per page. |
| Team segment visibility | only with team records (Opus) · always (the rest) | **Always.** A stable switcher, honest empty states, and no layout jump when records appear mid-run. |
| Phone switcher | scrolling row (Fable) · wrap (DeepSeek) · own row of four (Opus, Astra) | **Own row, glyph suffixes.** Nothing hides off-screen, and the 44 px targets fit at 390. |
| Team executor drawing | double rule (Fable) · stacked deck (Opus, Argon) · corner mark (Muse) · word only (Astra, DeepSeek) | **Deck plus the word `team`.** It says "many" by shape, keeps solid/dashed/dotted for who executes, and adds no colour. |
| Team view desktop layout | sticky right column (Fable) · lane rail (Astra) · one column (Opus, DeepSeek, Muse, Argon) | **One column.** The same order as the phone, and room for the roster. |
| Lane order | attention-sorted (Opus, Muse) · definition order (Fable) | **Definition order, plus attention lines and Working now.** Lanes are few, and positions should not move between polls. |
| Roster row order | state-sorted or failed pinned (Opus, DeepSeek, Argon) · stable (Astra, Muse) | **Stable `index` order.** Failures surface through group folding, the filter counts and the attention line, without rows jumping under the finger. |
| Default filter | changes with the workflow's state (Astra, Fable) · All | **All, with folding.** Nothing is hidden by a default the operator did not choose; folding keeps 400 agents short. |
| Quiet agent | amber (Fable) · words only (Opus) · none (others) | **Words only, at 10 minutes.** Amber means waiting on the operator; a long test is silence, not a question. The server marks the whole workflow interrupted at 15 minutes. |
| Owned-paths flag | Opus only | **Adopted, fail chip only.** It predicts a handoff refusal from data already served, and it never retones the step. |
| `killed` tone | pause (Fable, Muse, Argon) · idle (Opus) | **Idle.** DESIGN maps cancelled to idle and interrupted to pause, and the contract separates killed from interrupted; distinct tones keep them apart. |
| Changes-requested tone | warn (Fable, DeepSeek) · fail (Opus, Muse, Argon) | **Fail.** It matches the project page's `REVIEW_WORD`: one mechanism everywhere. |
| Typed confirmation | run id (Fable, DeepSeek, Muse, Argon, Astra) · `owner/name` (Opus) | **`owner/name`.** The contract fixes `typed_repo`, and the name is what is at stake. |
| Push preview source | separate preview route (Opus, Argon) · the read's `unpublished` list | **The read, plus `state_token`.** It carries the authors, and a moved branch is a 409. |
| PR body | read-only (Opus) · editable (Muse, Astra) | **Editable.** The contract's `body` is `multiline` with server defaults. |
| Who decides what is offered | UI rules (several) · server | **Server `available`/`reason`.** The UI shows the reason verbatim; integrated-only and permission rules live there. |
| "Send PR feedback to lead" | Argon | **Not adopted.** Notes reach only a running lead before freeze, and PRs exist after integration, so the button would almost always be unavailable. |
| Note placement | Controls menu only (DeepSeek) · also on the lane, sheet and node (others) | **Both, one dialog.** Steering sits where the team is seen; the guard and the pairing are unchanged. |
| Timeline | all cut it | **Cut.** Inline duration bars at P2 (Fable, Argon) are the most allowed. |
| Node page position | before Session (Fable) · between Report and Files (Opus) · after Files (Muse, Argon) | **After Files.** The report and files stay the worker's verified answer; the team explains how. |
| Phone drawer | full screen (Astra) · 78 % bottom sheet (others) | **78 % bottom sheet**, as the step sheet. |
| Motion | 1.2 s pulse (Fable) · 1.6 s (Muse, Argon) · 2.4 s breathe (Opus) · none (Astra) | **2.4 s breathe on the play glyph only.** Sixteen agents pulsing fast is noise. |
| GitHub card order | branch first (Fable, Muse) · PR first (DeepSeek, Argon, Opus) | **PR first when one exists, Branch first otherwise** (Astra). The outcome leads once there is one. |

## Appendix A. Team reader (server)

`GET /api/projects/:p/workflows/:w/runs/:r/teams` serves `teamsSchema` (`contracts/projects/teams.ts`), built by `server/teams.ts` from Claude Code's own records of each Claude session the run's sessions payload names:

- **Where.** The Claude home is `MD_MANAGER_CLAUDE_HOME`, else `CLAUDE_CONFIG_DIR`, else `~/.claude`; a session's folders are found by its id under `projects/*/` (a session that changed folder has two). Symlinks are never followed. The test harnesses point the Claude home at a seeded folder, so tests never read the operator's records.
- **Final records.** `<session>/workflows/wf_<id>.json`, written once when a workflow ends: name, description, status, times, phases, per-agent progress.
- **Live records.** `<session>/subagents/workflows/<wf>/journal.jsonl` (started, result, failed lines), each agent's `meta.json`, and the facts an agent transcript line carries without its text: times, model, tool-call count, last tool, last context size, files an Edit or Write named, and other providers called through the shell. Phase titles of phases not yet reached come from the script's `meta.phases` literal.
- **Status.** A live workflow is `running` while its records changed in the last 15 minutes and its lead session has not stopped; otherwise `interrupted`.
- **Never served.** Transcripts, absolute paths and credentials. Previews are cut (60/400/600 characters) and redacted, files are worktree-relative or redacted, and results are untrusted text.

## Appendix B. Run GitHub read (server)

`GET /api/dispatch/projects/:p/workflows/:w/runs/:r/github` serves `runGithubSchema` (`contracts/projects/github.ts`):

- **Local facts.** Read per request from the project's repository with read-only git (cached seconds). The page never fetches; remote-tracking facts are as fresh as the last fetch or push.
- **GitHub facts.** From the timer-driven gh reader. A requested branch key is read with one GraphQL query per repository, with branch names passed as variables, about every 90 seconds while someone views it. A GitHub action marks it due at once.

## Appendix C. GitHub actions (controller and server)

- **Controller.** `python -m workflow github push|pr|ready|reviewers <run> --repo <path> … --by operator` re-checks the run's branch and commit, refuses with `Blocked: …` on any mismatch, and runs git or gh without a shell. It never force-pushes, never pushes the default branch, and always opens drafts. It appends a record to `<run>/github-actions.jsonl`. RUNBOOK "GitHub actions".
- **Server.** `GET /api/run-controls/:p/:w/:r/github` offers the four actions (`runGithubActionsSchema`); `POST …/github/:action_id` runs one. Both routes are in the run-control scope, so they keep the browser guards and the pairing token. Each action maps to one fixed controller argv. They are off unless the dashboard runs with `MD_MANAGER_GITHUB_ACTIONS=on` and run controls on. A stale `state_token` is a 409.
