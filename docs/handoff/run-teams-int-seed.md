# Handoff: run-teams integration lane I2 (candidate-phase coverage for teams and GitHub)

Branch `rt/int-seed`, based on 475fd33. PRD sections: docs/PRD_RUN_TEAMS.md "Team reader", "Team view", "GitHub read", "GitHub view" and "GitHub actions". No contract changed. I did not touch `src/**`, `tests/project-workflows/support.ts` or the Team and GitHub components.

## What was built

- **`tests/project-workflows/fixtures/teamRecords.ts`** (new). It writes Claude Code's own records from a teams payload, in the shapes `server/teams.test.ts` uses:
  - `<claudeHome>/projects/<slug>/<sid>.jsonl` (a transcript stub);
  - finished workflows: `workflows/wf_<id>.json` (summary plus `workflowProgress`). When an agent failed, edited files or called a provider, it also writes the live folder with the journal's `failed` lines and that agent's transcript;
  - live workflows: `subagents/workflows/wf_<id>/{journal.jsonl, agent-<id>.meta.json, agent-<id>.jsonl}` and `workflows/scripts/<name>-wf_<id>.js` with a `meta` literal. A running workflow's files get the current time and an interrupted one's get an old time.
  - It also has `refreshRunningRecords`, which puts the current time back on running workflows' files; `writeLaneSessionFiles` (`<lane>.interactive.json`, `.cost.json` and `.completion.json`); and `comparableTeams`, which drops `read_at` and a live workflow's `last_activity_at` (the server takes that from the journal's file time).
  - It checks that a payload can be written as records, for example that a live agent has times, a last tool and a context size, and throws if not.
- **`fixtures/ux-teams.ts`**:
  - **Candidate seed for every run** (`seed`): all 13 runs get an export (finished runs integrate with packets; running runs launch both lanes, export dated 2024-03-05) and lane session files with their own session ids (`teams-absent` shares `teams-none`'s). `teams-empty` has none, and `teams-base` gets a challenge attempt.
    - Before this, `sessions-parity.spec.ts` failed in the candidate phase, because every ux-teams run answered 404 and the mocked `/sessions` of `teams-base` was never served.
  - **Two new runs served in both phases**, `teams-seeded` and `teams-seeded-live`. Their mock payload is built by `seededTeams()` / `seededLiveTeams()`, and the candidate seed writes that same payload as Claude records:
    - `teams-seeded`: the example's finished workflow and a later killed one in lane ui; lane adapter has none;
    - `teams-seeded-live`: lane ui runs (2 running, 1 done, 1 failed); lane adapter's workflow is interrupted.
  - **Sessions mock**: `teams-base`'s sessions mock is now built from the same files the seed writes (`sessionsOf`), so it equals the server's read. That means challenge `node_id` null, no repair row, and reader-form times.
  - **Session ids**: the seeded sessions use ids of their own. The reader finds records by session id, so records under `UI_SESSION` would appear on every core run.
- **`fixtures/ux-run-github.ts`**:
  - The mock commands now use the controller's current CLI: `$PY -m workflow github <verb> "$RUN" --repo … --repo-name … --branch … --head <full sha> …`, with `--title=<title>` for `pr`. The off, no-PR and push-first reasons are the server's own words.
  - New `seedRunGithubCandidate`, called from `seedCandidate` only with `dispatch: true`, so `controls-app.ts` and `sessions-app.ts` create no repository. It builds the candidate-only project `publish`:
    - its repository is `<seed>/run-github/checkout`, cloned from a bare origin, with origin then set to `https://github.com/acme/publish.git`;
    - run `publish-unpushed` has 3 commits that are not pushed;
    - run `publish-pushed` is pushed, and the GitHub fixture holds draft PR #7 for it (1 pending check, plus team `acme/maintainers` and user `octocat` requested);
    - both exports record `inputs.source_branch` and `Fast-forwarded to <tip>`;
    - the fixture gains repository `acme/publish` and `branches` entries `acme/publish#<branch>`, merged into `github-fixture.json`.
- **`seed.ts`**: `SeedContext.claudeHome` is `<test root>/claude-home`, which the configs already pass as `MD_MANAGER_CLAUDE_HOME`. The context is shared with the GitHub seed, and the GitHub fixture merge is added. **`fixtures/dispatch.ts`**: exports its git helpers (`git`, `gitOut`, `commit`, `initRepo`) for reuse.
- **Specs**:
  - `teams.spec.ts`: the file-wide worker skip is replaced by a `beforeEach` that skips mock-only scenarios in the candidate phase. In the candidate phase the `beforeEach` also refreshes the live records' file times.
    - New `[scenario:team-seeded-finished]` and `[scenario:team-seeded-live]` run in both phases. Each first compares the payload served through the page with the mock's, then checks the visible facts: facts, phases, roster, logs, the killed and interrupted lines, attention, suffix, Working now, the dock row, the card's team line and the Sessions row.
    - `run-legacy-unchanged` now runs in both phases.
  - `github.spec.ts`: candidate-only `[scenario:github-real-not-pushed]`, `[scenario:github-real-draft]` and `[scenario:github-real-commands]` run against the real server. Each asserts the served read is the fixture's: `read_at`, permission, and no `/home/` or `/tmp/`.
  - `controls.spec.ts`: candidate-only `[scenario:github-real-actions]` on the controls pair, using the real `/api/run-controls/.../github` offers:
    - push of the unpushed branch: typed `acme/publish`, the command carries the full head, and it is cancelled, never pushed;
    - Mark ready on #7: confirmed, the record succeeds, and the fake controller's log shows the exact argv (`--repo-name`, `--branch`, full `--head`, `--pr 7`).
  - `revamp-lists.spec.ts` (`filtered-lists`): it now waits for the rail's repository label before its before/after snapshot. Two more registry items made the real overview land after that snapshot (failed 2 of 2 runs in the candidate phase; passes at base and after the wait).
- **`fake-controller.py`**: parses `github push|pr|ready|reviewers` the way `workflow/github.py` does (each action's required options). It refuses a short `--head` with `Blocked:` and exit 2, prints one line and exits 0, and pushes nothing.
- **`playwright.config.ts`**: `MD_MANAGER_GITHUB_ACTIONS=on` on the controls pair only.
- **`tests/unit/teamsSeed.test.ts`** (new), the parity check:
  - runs `seedCandidate` (the browser config's own function) into a temp root and starts the real app with `createApp` and the real `TeamReader`;
  - `GET /teams` for the seeded runs validates and deep-equals the mock payload (only `read_at` and a live `last_activity_at` are left out);
  - every other ux-teams run is served with records `none`;
  - the mocked `/sessions` for `teams-base` and `teams-seeded` equal the server's;
  - it asserts the Claude home resolves under the temp root and never under `~/.claude`.

## Tests

All browser runs went through the flock, with `MD_MANAGER_PROJECTS_OUTPUT` in the scratchpad and `MD_MANAGER_PROJECTS_CONFIG`, `MD_MANAGER_PROJECTS_TEST_ROOT` and `MD_MANAGER_CONTROLS_API_PORT` unset.

| Command | Result |
|---|---|
| `WORKFLOW_VERIFICATION_PHASE=candidate … playwright test teams.spec.ts github.spec.ts controls.spec.ts sessions-parity.spec.ts` | 18 passed, 54 skipped (worker-only) |
| same, worker phase | 67 passed, 5 skipped (candidate-only) |
| candidate: `revamp-lists ux-lists projects dispatch dispatch-server` (+ the four above) | 115 passed, 1 failed (`filtered-lists`, fixed as above, then 51/51 in both phases) |
| candidate: `sessions.spec.ts run-views.spec.ts ux-run.spec.ts` | 31 passed |
| `npx --no-install tsx --test tests/unit/*.test.ts server/teams.test.ts server/runGithub.test.ts` | 804 passed |
| `npx --no-install tsc -b` | clean |
| `npx --no-install eslint` on every changed TS file | clean |

## Known gaps

- Most Team scenarios stay worker-only, because their payloads cannot come from records: a malformed payload, a 404, 400 agents with 112 more, an unreadable folder (that would need chmod 000 under the test root), and ages against a fixed clock. The two seeded scenarios cover the real reader through the page instead.
- The seeded candidate runs' exports are dated 2024-03-05, while the mock's run details keep 2026-10-16. Neither the team nor the session data depends on that date. Using the fixtures' day put 8 finished runs into `ux-lists` Recent under its pinned clock, which broke `runs-home`.
- The `publish` project exists only in the candidate phase, so the worker-phase project lists do not show it. The `github-real-*` scenarios skip in the worker phase.
- The new scenario ids (`team-seeded-finished`, `team-seeded-live`, `github-real-not-pushed`, `github-real-draft`, `github-real-commands`, `github-real-actions`) are not in any feature `policy.json`.
- I ran neither the full browser suite nor `workflow.run_tests`.

## For the integrator

- Nothing to wire. The changed files are test fixtures, specs, the fake controller and the Playwright config, plus one assertion wait in `revamp-lists.spec.ts`.
- If the UI lane changes a Team or GitHub test id or sentence, the seeded and `github-real-*` scenarios assert the same strings as the worker-phase ones.
