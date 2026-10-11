# Decisions: projects-dispatch

From the design session of 2026-10-10/11 with the operator (artifacts "Dispatch Desk" versions 1 to 4, committed as `docs/design/projects-dispatch.html`). Not grilled. [O1] to [O5] are the operator's own words; [D1] to [D9] are Claude's defaults for points the operator did not settle; the design challenge tests them.

## Operator decisions

- [O1] The direction: Dispatch Desk with the Lines step chart on the project page. Operator: "go with Dispatch Desk plus the Lines step chart in the project page. Now impeove the project page design".
- [O2] A dedicated project page with GitHub pull requests and issues, and a projects-only rail. Operator: "wheres the project page with github PRs and issues? Have a deediacted project page, make the left bar more readbale and with only projet options".
- [O3] The Projects page and the per-project page must be reachable from the first screen. Operator: "Its still missing the per project page?". This was answered in version 4: the Projects page (a card per project) is the landing page, and "All projects" and "Triage" sit at the top of the rail.
- [O4] Version 4 is approved. Operator: "Loks good to me".
- [O5] The slice follows up from the run-controls workflow: its base is run-controls-004's integrated commit (5dc3ae2, branch `observe/projects-dispatch` in `~/dev/md-manager-observe-run-controls`). Operator: "it should follow up from the controls workflow".

## Defaults (not grilled)

- [D1] Triage moves to `/projects/-/triage`. A project id cannot start with `-` (`PROJECT_ID_PATTERN`), so the path never collides with a project. `/projects` is the Projects page.
- [D2] One run with `server` and `viewer` lanes in parallel. The viewer mirrors Appendix A and mocks it in the worker phase; the candidate phase runs against the real server, as in run-controls [G1].
- [D3] GitHub is read with the host's `gh` CLI, in the background:
  - at most once per repository per 15 minutes;
  - the last good read is cached in memory and on disk with its time;
  - `MD_MANAGER_GITHUB=off` turns it off;
  - `MD_MANAGER_GITHUB_FIXTURE` replaces `gh` in tests and in the critique app.
  - Not via a token in the server: `gh` keeps the credential.
- [D4] Sync is computed only from local refs against the clone's last fetch, and is named "as last fetched" with the `FETCH_HEAD` time. The server never fetches. Commit presence on GitHub is judged against the origin ref, not by calling GitHub for each commit.
- [D5] "Possibly related" PRs are exact branch matches only: the head or base equals the checkout branch or a run's `source_branch`.
- [D6] Rail order: needs you, running, readable before unreadable, then last activity. Badges: "N waits on you", "N paused", "N running", otherwise "N unpushed" on the clone's primary project only.
- [D7] No run controls on the Projects pages. The reading pane's primary action is "Open run page", where the controls are. A Run button in the pane is a follow-up.
- [D8] The run page, node pages and assignment page are unchanged. The rail appears on the Projects page, Triage, the project page and the workflow page.
- [D9] `"tryout": true` (a user-facing feature with browser checks) and `"critical": false` (read-only: GET routes, read-only git and gh commands).

## Changes after launch

(none yet)
