# Handoff: run-teams lane C2, the GitHub view, actions panel and dialogs, Copy run summary, doc copy

Branch `rt/ui-gh` (from the scaffold `rt/ui`, 0f7f88a), worktree `/home/agentops/dev/md-manager-rt-ui-gh`. Spec: `docs/PRD_RUN_TEAMS.md` sections 4, 8, 9, 10 and 11 (P0 items 7-8, P1 items 10, 11 and 13). No contract changed.

## What is built

- **Model** (`src/projects/github/model.ts`, pure).
  - `githubSituation(read, now)` implements the section 4.2 table: the first matching row wins, with the exact sentence, tone, suffix and next action (`{action, fallback}`; the fallback is the commands link, the failing check or the PR).
  - `githubSuffix` now comes from the situation and replaces the scaffold's provisional one. Its spoken form reads "pull request 531, checks failing".
  - Card words for section 4.3: the PR pill, review decision, merge, checks line, reviewer chips, conversation, earlier PRs, head-commit note, push pill, shas, default-branch counts, integrated commit, the connection line, an untoned visibility word and the freshness lines (including "Last read failed: …").
  - `handCommands` builds the section 4.6 card. Values are shell-quoted (`shellQuote`/`shellPath`, keeping `~/` expandable), `--force` is never used, and the reviewers command has `text: null` and "Name a reviewer first" until its field names someone. The draft-PR command is a quoted heredoc of `runSummaryMarkdown`, and its delimiter is renumbered if the text contains it.
  - `summaryInput` follows the 4.3 input mapping from the data `RunView` holds. Every free text goes through `redactPaths` (home → `~`, temp dirs → "(temporary path)").
- **Actions model** (`src/projects/github/actions.ts`, pure).
  - The panel's four states and their exact copy, record tones and the outcome sentences, including the 409 stale sentence.
  - Each dialog's exact copy: the visibility block (band or none), titles, facts lines and the preview heading.
  - The typed confirmation is exact and case-sensitive and never prefilled. It is also asked for when visibility is unknown.
  - Field validation, plus `buildGithubParams`, which sends only the params the action names.
- **Shared state** (`src/projects/github/store.ts`).
  - One store per run page holds the offers, records, the open dialog and a counter of ended records.
  - It reads `GET …/github` only when run controls are on and the browser is paired. It polls every 15 s, and every 1.5 s while a record runs.
  - `useGithubActionEnded` lets `RunView` refetch the GitHub read as soon as a record ends.
- **Views** (`src/projects/github/GithubView.tsx`, `parts.tsx`, `github.css`).
  - The answer banner: tone fill and glyph, the sentence, "GitHub read … · local git read …", the failed-refresh line, and one next action. That action is the offered action's button, or else the commands, failing-check or PR link.
  - Cards: Pull request, Branch (unpublished commits with full authors, folding after five on a phone), No pull request, Connection (an untoned chip), Share (Copy run summary, with "Select to copy" as the fallback, plus Show the text) and Commands to run by hand. The reviewers field sits just above its command.
  - Publish on GitHub has states `controls-off`, `unpaired`, `actions-off` and `offered`. An unreadable offers read gets an extra `unreadable` line. Action rows are 44 px buttons or plain text with "Not offered: {reason}". Up to five records show, with an Output fold for failed and refused ones.
  - Desk layout is a 720/360 two-column grid. Under 720 px it is one column in the spec's order, set with `order`.
  - The announcer speaks a change of situation ("GitHub: …"), and never the first read.
- **Dialogs and the Controls menu group** (`src/projects/github/GithubControls.tsx`).
  - `GithubDialogHost` is a native modal `<dialog>` that behaves like `ControlDialog`: the focus is trapped, Escape and Cancel close it, and the opener gets the focus back.
  - Its parts appear in the section 4.5 order. Branch facts come from a fresh run GitHub read taken when the dialog opens.
  - Each open gets one `request_id`, and the POST sends the `state_token` of the offers seen at open. A 409 `STATE_CHANGED` shows the stale sentence and disables the confirm button.
  - `GithubControlsGroup` is the "GitHub" group in the Controls menu. It lists the same four actions and opens the same dialog.
  - `ControlsMenu.tsx` mounts the group under the existing list when paired, plus the host. Nothing else in that file changed.
- **RunView**: one added line, `useGithubActionEnded(scope, reloadRunGithub)`.
- **Doc copy (P1 item 13)**:
  - `PRODUCT.md` principle 5, plus the capabilities line on the paired exceptions and a line on the four run views.
  - `DESIGN.md`'s "Don't put a control…" line, plus new notes on the team deck and the GitHub view.
  - The two sentences in `GithubColumn.tsx`. The PR note gained `data-testid="dispatch-gh-prs-note"`.
- **Fixtures** (`tests/project-workflows/fixtures/ux-run-github.ts`, registered in `fixtures/index.ts`).
  - One read per 4.2 situation on `controls/controls-finished`, a private not-pushed read, and a read with many checks.
  - `GITHUB_ACTIONS` covers: off, pushPublic, pushPrivate, openPr, markReady, requestReviewers, and records (failed, refused, succeeded).
  - The spec swaps payloads per test in `runGithubByRun` / `runGithubActionsByRun` and restores them in `afterEach`.

## Tests (run on cryotrack in this worktree, worker phase)

- `npx --no-install tsx --test tests/unit/github.test.ts tests/unit/githubStyle.test.ts tests/unit/typeFloor.test.ts tests/unit/runSummary.test.ts`: 53 passed.
  - `github.test.ts` has one test per 4.2 row with the exact sentence, plus tests for first-row precedence, quoting (slashes, quotes, `$()`), that no placeholder or absolute path reaches a copyable command, that the summary input holds no absolute path, the panel states, the dialog copy, typed matching, and params.
  - `githubStyle.test.ts` is a copy of `sessionsStyle.test.ts`.
- `npx --no-install tsx --test tests/unit/*.test.ts`: 701 tests. One failed: the scaffold's `tone.test.ts` case for the provisional `githubSuffix`. I updated it to the situation-derived suffix, and `tone.test.ts` now passes (17 passed).
- `npx --no-install tsc -b`: clean. `npx --no-install eslint` on every changed file: clean.
- Playwright (through the shared flock, `MD_MANAGER_PROJECTS_OUTPUT` in the scratchpad), `github.spec.ts dispatch.spec.ts run-views.spec.ts controls.spec.ts`: 75 passed.
  - `github.spec.ts` alone has 33 tests, one per scenario id: `github-no-branch` … `github-closed`, `github-commands-card`, `github-copy-summary`, `github-actions-controls-off|unpaired|off|offered`, `github-action-record`, `github-push-public-dialog`, `github-push-private-dialog`, `github-open-pr-dialog`, `github-mark-ready`, `github-request-reviewers` and `github-action-stale`.
  - Each test attaches one `screenshot:<id>` at the desk size, then checks 390 × 844 with no sideways scroll.
  - `project-github-column-copy` is in `dispatch.spec.ts`.
- Not run: the candidate phase, `npm run build`, the full browser suite and `revamp-pages.spec.ts` (I did not touch it).

## Decisions and deviations

- `github.spec.ts` is skipped in the candidate phase (`test.skip(phase !== 'worker')`), because its payloads are worker-phase mocks. The column-copy scenario runs in both phases.
- I did not change the `revamp-pages.spec.ts` allow-list. That test never opens the GitHub view. Instead, `github-copy-summary` checks that the unpaired GitHub view's buttons are only Copy, Copy run summary, Show/Hide the text and fold toggles. Every situation scenario also runs `expectNoExecutionControls`.
- I did not reuse the `ControlDialog` component, because its body is control-specific. The GitHub dialog is a sibling with the same shell classes (`ctl-dialog`, `ctl-actions`…) and the same modal and focus behaviour.
- When the dispatch overview does not name the project's checkout as `~/…`, the git commands run in the current directory. The card then says "Run the git commands in the project's checkout: the project page does not name it." It never prints a placeholder.
- An INTERNAL repository gets its own wording ("… an internal repository", "{repo} is internal: …"), next to the spec's private form.

## Known gaps

- The banner reuses the Now-banner pattern (tone fill, glyph, 14px 700 sentence) in its own `gh-banner` classes, not the Now-banner component itself.
- Commit times in the push dialog are UTC strings; the Branch card uses the page's zone.
- The `lost` record status has a sentence I wrote myself, because the spec gives none: "The controller stopped answering before it finished; whether it ran is not recorded. Check GitHub before you run it again."
- The real server's actions routes and controller commands belong to other lanes. These views were tested only against the mocks in `mock.ts`.

## Integrator must wire

- Nothing beyond merging. `RunView.tsx` has one added hook line near the GitHub resource, so watch for a conflict with the Team lane's edits there. `ControlsMenu.tsx` changes the paired branch of the panel and adds `<GithubDialogHost>` at the end of the menu.
- `tests/unit/tone.test.ts` changed in one case: the provisional GitHub suffix test now expects the situation's suffix.
