# Server worker, run 002: fix the dispatch API's review findings (PRD_PROJECTS_DISPATCH)

## Goal

Run projects-dispatch-001 built the read-only dispatch API, and it is in your base (f4623a4): `server/dispatch*.ts`, `contracts/projects/dispatch.ts`, `docs/handoff/projects-dispatch-server.md`. Its independent review blocked it. `features/projects-dispatch/review-001.md` holds every finding verbatim. Fix the ones below, keep everything that already works, and prove each fix with a test that fails without it.

1. **S1 (P1) Landings without an origin ref.** In `server/dispatchGit.ts`, `localDefaultExists` is only set inside the origin block, so a repository with `refs/heads/<d>` and no origin ref reports every `on_default` as `null`. Resolve the local default branch independently of the origin ref. Done when a test on a local-only repository with an integrated sha on main reports `on_default: true` (and `false` for a sha not on main) with `on_origin: null`.
2. **S2 (P1) Failed reads retry every tick.** `GithubReader.due()` looks only at `readAtMs`, so a repository whose read failed, or that was never read successfully, is read again every minute. Record the time of every attempt; a repository is due only when its last attempt, successful or not, is older than `MD_MANAGER_GITHUB_REFRESH_MINUTES`. The start read still runs once per repository. Done when a test with a failing runner and the real tick (fake timers, or the injected clock driving `cycle()`) shows one call per refresh window, not one per minute.
3. **S3 Discovery follows the registry as it is now.** `server/index.ts` builds `discover` from the start-up registry. Discover from the registry the reloader keeps current (the `RunStore`'s config), so a repository added at runtime is read by the tick without a page request, and a repository removed from the registry, or present only in the cache file, is no longer read. Done when a test reloads a registry and shows both.
4. **S4 Unreadable runs are cached.** In `server/dispatchSteps.ts`, a run whose `loadRun` throws is retried and warn-logged on every overview request. Cache the error by the run directory's fingerprint, as good digests are cached, and log it once per fingerprint. Done when a test makes two overview requests and the loader is called once for the corrupt run.
5. **S5 Tests that can fail.** Strengthen `server/dispatch.test.ts` so that each of these would fail on a regression:
   - a recording git runner proves every git argv is read-only (never `fetch`, `pull`, `push`, `gc`, `checkout`, `reset`, `update-ref`, `config` with a value, or any other writing command) and that no shell is used;
   - both routes: GET and HEAD answer, every other method is 405 with an `Allow` header; runner mode writes no file but `MD_MANAGER_GITHUB_CACHE`;
   - the reflog date: two fetches at distinct, set times, and `updated_at` equals the remote-tracking reflog entry's time, not `FETCH_HEAD`'s;
   - no absolute path anywhere in either route's whole JSON response (scan every string, including `errors[].message`), for a run whose loader error message holds a path;
   - default branch: an `origin/HEAD` naming `dev` outranks a local `main`;
   - landings: a missing origin ref and a clone without a local default branch give `null`, never `false`;
   - the GraphQL query text has `first: 20` and `orderBy: {field: UPDATED_AT …}` for PRs and the issues order; `reader.state()` output for a full fixture parses with the contract schema and maps every Appendix A field (pushed_at, head.committed_at, read_at, PR title/url/state/draft/head_ref/base_ref/updated_at/merged_at/review_decision/labels, issue labels/assignees/created_at/updated_at);
   - a route request (`app.inject`) inside the refresh window never calls the runner ([P18]);
   - the fixture file: `MD_MANAGER_GITHUB_FIXTURE` read from a file, and `MD_MANAGER_GITHUB=off`, through the same function `server/index.ts` uses (extract it if needed);
   - more than 50 runs: the steps route returns the newest 50;
   - a run whose recorded definition differs from the registry's: its steps carry the recorded `label` and `kind` ([P22]).
6. **S6 The handoff.** Update `docs/handoff/projects-dispatch-server.md`: what run 002 changed, how to turn GitHub reads off, and every open P2, including the untested real `gh` path (the operator's tryout checks it) and the HOME/PATH spawn-option assertion if you do not add it.

`docs/PRD_PROJECTS_DISPATCH.md` sections 2, 5 and 7 and Appendix A remain the specification; `features/projects-dispatch/decisions.md` wins where they differ. The response shapes do not change: Appendix A is frozen for this run ([L4]), so the `viewer` lane can rely on it.

## Context

- **Your base already has the API.** Read `server/dispatch.ts`, `dispatchGit.ts`, `dispatchGithub.ts`, `dispatchSteps.ts`, `server/index.ts`, `server/app.ts` and `docs/handoff/projects-dispatch-server.md` before changing anything. Keep the module boundaries.
- **Run-controls routes:** `/api/run-controls` (`server/controls*.ts`) is not yours. Do not change it.
- **Git:** `execFile('git', ['--no-optional-locks', '-C', repo, ...])` with a 5 s timeout and `GIT_TERMINAL_PROMPT=0`, `GIT_NO_LAZY_FETCH=1`, `GIT_OPTIONAL_LOCKS=0`; never a shell. Cached 15 s per repository.
- **GitHub:** timer-driven only ([P18]); one repository at a time with a 20 s timeout per call; requests never trigger or wait for a read; a failed refresh keeps `read` with the data and sets `reason` ([P12]); fixed reason texts only, never stderr ([P14]).
- **Tests** create every repository with `git init -b main` (`--initial-branch=main` for a bare one) and commit with explicit `-c user.name=… -c user.email=…`, since `HOME` is isolated. They isolate every path under a temporary directory and `HOME`, with an injected clock and an injected `gh` runner. Never touch the real `~/.config/md-manager/`, `~/.cache`, `~/.local/state` or any real repository.
- **A lane reviewer** (GPT 6.1) reviews your lane's diff after your checks pass, before the candidate. A P0/P1 from it starts one repair round of your lane.
- **The viewer lane** works in parallel on the pages against Appendix A as it is. Do not rename, remove or retype a field.

## Constraints

- Owned paths only (policy.json `server`). Do not touch `src`, `tests/project-workflows`, `tests/unit`, `server/projectRoutes.ts`, `server/projects.ts`, `server/projectsConfig.ts` or the run-controls files. Helpers you need are imported, not changed. A change you cannot avoid is a `question` completion.
- GET and HEAD only; other methods 405. No write anywhere except the GitHub cache file.
- No `git fetch`, `pull`, `push`, `gc`, `checkout` or any command that writes; no shell.
- No new dependency. No change to Appendix A's shapes.

## Acceptance

- S1 to S5 each have a test in `server/dispatch.test.ts` (which `frontend-unit` runs) that fails on f4623a4's code and passes on yours. Name each test after its item (`S1: …`).
- The 001 tests still pass, and `contracts/projects/contract.test.ts` still validates the examples.
- `docs/handoff/projects-dispatch-server.md` is updated (S6).
- `frontend-build`, `frontend-lint`, `shared-contract` and `frontend-unit` pass.

Run targeted tests while iterating, then this lane's non-browser policy checks once before writing the completion; run browser specs only through check-report on this lane's own specs.

## Stop

Stop and report `question` in either case:
- a fix needs a change to `server/projects.ts`, `server/projectRoutes.ts` or `server/projectsConfig.ts`;
- a fix needs a change to Appendix A's shapes.

Do not add routes, do not fetch, and do not write anywhere but the GitHub cache.
