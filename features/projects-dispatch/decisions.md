# Decisions: projects-dispatch

From the design session of 2026-10-10/11 with the operator (artifacts "Dispatch Desk" versions 1 to 4, committed as `docs/design/projects-dispatch.html`). Not grilled. [O1] to [O6] are the operator's own words; [D1] to [D9] are Claude's defaults for points the operator did not settle; [P1] to [P23] settle the findings of the panel review the operator asked for. The design challenge tests all of them.

## Operator decisions

- [O1] The direction: Dispatch Desk with the Lines step chart on the project page. Operator: "go with Dispatch Desk plus the Lines step chart in the project page. Now impeove the project page design".
- [O2] A dedicated project page with GitHub pull requests and issues, and a projects-only rail. Operator: "wheres the project page with github PRs and issues? Have a deediacted project page, make the left bar more readbale and with only projet options".
- [O3] The Projects page and the per-project page must be reachable from the first screen. Operator: "Its still missing the per project page?". This was answered in version 4: the Projects page (a card per project) is the landing page, and "All projects" and "Triage" sit at the top of the rail.
- [O4] Version 4 is approved. Operator: "Loks good to me".
- [O5] The slice follows up from the run-controls workflow: its base is run-controls-004's integrated commit (5dc3ae2, branch `observe/projects-dispatch` in `~/dev/md-manager-observe-run-controls`). Operator: "it should follow up from the controls workflow".
- [O6] A panel review before launch, then apply its changes and start the workflow. Operator: "After the PRD is done ask the panel to review it and after that implement the changes and start the workflow".

## Defaults (not grilled)

- [D1] Triage moves to `/projects/-/triage`. A project id cannot start with `-` (`PROJECT_ID_PATTERN`), so the path never collides with a project. `/projects` is the Projects page.
- [D2] One run with `server` and `viewer` lanes in parallel. The viewer mirrors Appendix A and mocks it in the worker phase; the candidate phase runs against the real server, as in run-controls [G1].
- [D3] GitHub is read with the host's `gh` CLI, timer-driven ([P18]):
  - at most once per repository per 15 minutes;
  - the last good read is cached in memory and on disk with its time;
  - `MD_MANAGER_GITHUB=off` turns it off;
  - `MD_MANAGER_GITHUB_FIXTURE` replaces `gh` in tests and in the critique app.
  - Not via a token in the server: `gh` keeps the credential.
- [D4] Sync is computed only from local refs, against the remote-tracking ref as this clone has it, and is dated by that ref's reflog ([P2]). The server never fetches. Commit presence on GitHub is judged against the origin ref, not by calling GitHub for each commit.
- [D5] "Possibly related" PRs are exact branch matches only: the head or base equals the checkout branch or a run's `source_branch`.
- [D6] Rail order: needs you, running, readable before unreadable, then last activity. Badges: "N waits on you", "N paused", "N running", otherwise "N unpushed" on the clone's primary project only.
- [D7] No run controls on the Projects pages. The reading pane's primary action is "Open run page", where the controls are. A Run button in the pane is a follow-up.
- [D8] The run page, node pages and assignment page are unchanged. The rail appears on the Projects page, Triage, the project page and the workflow page.
- [D9] `"tryout": true` (a user-facing feature with browser checks) and `"critical": false` (read-only: GET routes, read-only git and gh commands).

## Panel review (2026-10-11, before launch)

`/multi-review` of the PRD, tasks and policy by Claude (Fable), GPT (gpt-6-astra) and DeepSeek (v4-pro): 36 findings, grouped into 23 issues and checked against the code. 21 were confirmed and 2 plausible ([P11], [P23]); none was refuted. Each is settled below and in the PRD; these win over the mock-up. The report is in the session scratchpad.

- [P1] (x3) The card and the header used different sync wording for the diverged seed. Settled: one wording everywhere, "2 ahead, 1 behind origin/main" (PRD 5, "Sync wording").
- [P2] (x3) `FETCH_HEAD` is rewritten by a fetch of any remote, and never by a clone. Settled: date the comparison by the newest reflog entry of `refs/remotes/origin/<d>` (`origin.updated_at`), worded "as of origin/<d> updated here <time>".
- [P3] (x2) A clone without a local default branch made `rev-list` fail with no contract state. Settled: `origin.compare: 'no_local_branch'`, with null ahead/behind and its own wording.
- [P4] (x2) `pushed_at` and the head commit date do not say when the default branch moved. Settled: show "GitHub <b> is at <sha>, committed <date>"; `pushed_at` is documented as a push to any branch and is not shown as default-branch movement.
- [P5] (x2) "N−K are not from a run" could not be counted past the 50 listed commits, and was not provable anyway. Settled: `ahead_naming_run` is counted over all commits ahead; the others "do not name a known run".
- [P6] (x3) Background GitHub reads raced the candidate specs and the critique app's readiness. Settled: the fixture is read synchronously before the server listens; the critique app also waits until every fixture repository reads `read`.
- [P7] (x3) `~` paths are rejected by the registry schema. Settled: no tilde expansion, no schema change, and `server/projectsConfig.ts` is no longer an owned path.
- [P8] (x2) Absolute paths (`repository`, `clone`, raw git stderr) would reach the browser, against the viewer's redaction rule (`support.ts` `renderedText`) and over the Mac tunnel. Settled: `repository_label` (`~`-relative or basename), `clone_id` (a hash), fixed `reason` texts.
- [P9] Landings could not express "unknown". Settled: `true` is exit 0, `false` is exit 1, and `null` means the ref or object is missing or git errored; shown as unknown, never as not landed.
- [P10] The github.com regex accepted lookalike hosts. Settled: exact host and owner/name validation for three URL forms.
- [P11] (plausible) A partial clone can lazy-fetch on object reads. Settled: `GIT_NO_LAZY_FETCH=1` and `GIT_OPTIONAL_LOCKS=0`; a missing object counts as unknown.
- [P12] The status after a failed refresh was unspecified. Settled: it stays `read`, keeps the data, `read_at` and `viewer_login`, and sets `reason`; the viewer shows a "latest refresh failed" line.
- [P13] `dispatch-overview` asked every card for GitHub fields, including the non-GitHub project. Settled: GitHub fields apply to read GitHub projects; other cards say "GitHub not read: <reason>".
- [P14] Raw first-line stderr could leak a credential URL. Settled: fixed failure texts only.
- [P15] (x2) `gh pr list` orders by creation, and 20 items cannot cover "merged in 14 days". Settled: GraphQL ordered by `UPDATED_AT`; labels say "showing the 20 most recently updated", "among the 20 shown" and "among the newest 20".
- [P16] The seeded registry cannot produce the rail scenario. Settled: the viewer adds new registry projects with their own repositories in `fixtures/dispatch.ts`. Scenario counts are not hard-coded where existing fixtures add waiting runs.
- [P17] No `g h` chord exists today. Settled: no chords in this feature.
- [P18] Request-driven and timer-driven refresh contradicted each other. Settled: timer-driven only; requests never trigger or wait for a read.
- [P19] The nullability of `repo` per status was unspecified. Settled: `repo` is set whenever the remote parsed as GitHub.
- [P20] Candidate runs would write fixture data to the real `~/.cache`. Settled: with a fixture set nothing is written to the cache, and the candidate config also sets `MD_MANAGER_GITHUB_CACHE` under the test root.
- [P21] Workflow-level read failures had no field. Settled: `workflows[].error`; the row shows the literal `<run-id>` placeholder.
- [P22] Older runs' lanes could not be placed. Settled: steps carry `label` and `kind` from the run's own recorded definition, and the phase map uses `kind`.
- [P23] (plausible) The viewer lane is large. Settled: the scenarios are split per page; launching with `--fix-rounds 3` is the operator's call.

## Changes after launch

- [L1] (projects-dispatch-001, design challenge attempt 1, P1) `tests/project-workflows/accepted.spec.ts:73-76`, outside the viewer's owned paths, asserts the project page's `li[data-workflow-id] a.lists-group-head` tone hook, which the step chart would have removed. Settled: each step-chart feature group keeps that structure and tone class, `docs/VIEWER_DISPATCH.md` lists it, and the viewer keeps the `lists.ts` exports `tests/unit/accepted.test.ts` imports (viewer-task.md, "Specs and tests you do not own").
- [L2] (projects-dispatch-001, design challenge attempt 1, P2s folded into the tasks) Changes [P22]: the phase map matches `node_id` first and `kind` only as the fallback (sidecar → Launch, repair → Verify). Also settled: steps list `runs_root` per run instead of `listRuns`, with digests warmed at `onReady`; a null GitHub author is `ghost`, and bad shas make only that project `unavailable`; seeds and tests use `-b main` and an explicit git identity; the dispatch seed is opt-in so `controls-app.ts` never reaches real `gh` or `~/.cache`; a landing false on both refs reads "integrated into <source_branch>"; `NOT_FOUND` is this route's code, and git-unavailable and no-remote GitHub states are fixed.

- [L3] (projects-dispatch-002, follow-up run, 2026-10-11) Run 001's independent review blocked its candidate f4623a4 (general 5 P1, coverage 9 P1, critique 3 P1; 50 P2), after its three repair rounds went to the candidate gate. Operator: "draft the second slice and run it use the panel for my answeres adn run and finish th eworkflow ... use the latest workflow with per lane reviewers and use gpt 6.1 as per lane reviewer". Settled: run 002 starts from f4623a4 on branch `observe/projects-dispatch-002` (the 001 code is the baseline, not rebuilt); `feature.json` moves to 2.10.0 and each lane gets one lane reviewer, `{transport: pi, model: openai-codex/gpt-6.1-sol}`, with `rounds: 1` and `timeout_minutes: 15`; the controller runs from md-manager 2dab17c (`sync/vm-vps-2026-10-11`, lane reviewer); the operator's answers before launch and during the run come from the panel. The findings are in `review-001.md`; the tasks name the ones this run fixes (S1 to S6, V1 to V22).
- [L4] (projects-dispatch-002) Appendix A's shapes are frozen for this run: the `server` lane fixes behaviour (S1 to S5) without renaming, removing or retyping a field, so the `viewer` lane works against the API in its base.
- [L5] (projects-dispatch-002, critique P2 of run 001) Changes [D5]: on a project checked out on its default branch every PR matched "possibly related" by its base. Settled: a PR is possibly related when its head branch equals the checkout branch or a run's `source_branch`, or its base branch does and that base is not the project's default branch; the row names the match ("head is <b>", "base is <b>").
- [L6] (projects-dispatch-002) Scope: every P1 of run 001, the coverage reviewer's test-gap P2s on the behaviours this run touches, and the critique P2s on phone targets, the rail, the "checkout detached" wording, truncated axis labels and the "runs read" clock. The others (the untested real `gh` path, which the operator's tryout checks; the flaky `controls-unavailable` timeout in `controls.spec.ts`, not owned) stay open in the handoffs. The viewer stays one lane: the fixes share `dispatch.css`, `dispatch.spec.ts` and the fixtures, so a split would put two lanes on the same files.
- [L7] (projects-dispatch-002) Repairs: the controller applies at most 3 repairs per run (`workflow/repair.py` `MAX_REPAIRS`), and a lane-review round is a repair. With one lane-review round per lane and `--fix-rounds 3`, the candidate gate and the review keep at least one repair between them only if the lanes pass their own reviewers; the browser scenarios run in both phases in each lane's worktree before completion to keep the candidate gate from spending them.
