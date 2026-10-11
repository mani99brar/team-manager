# Server worker: the dispatch API (PRD_PROJECTS_DISPATCH)

## Goal

The API serves `GET /api/dispatch/projects` and `GET /api/dispatch/projects/:projectId/steps` (PRD Appendix A) from the Projects registry. For every registered project it returns:
- the git state of its repository: checkout, default branch, the clone and its primary project, ahead/behind against the origin ref as last fetched, the commits ahead and which name a run, and landings;
- the GitHub state of its `origin` repository: visibility, default-branch head, open counts, the 20 most recently updated PRs and the 20 newest open issues, read with `gh` in the background and cached with its read time;
- per workflow, each run's step digest (status and attempt per node), lanes, source branch and integrated commit.

Everything is read-only. The server never fetches, pushes or writes to a repository or a run directory. Where something cannot be read, the response says why in `reason`.

`docs/PRD_PROJECTS_DISPATCH.md` sections 2, 5 and 7 and Appendix A are the specification; `features/projects-dispatch/decisions.md` wins over the PRD where they differ.

## Context

- **Today's server:**
  - `server/app.ts` (Fastify; registers `projectRoutes`; `onReady` calls `store.warmSummaries()`);
  - `server/projectRoutes.ts` (the read-only Projects API, the `{ error: { code, message } }` body, 405 for other methods);
  - `server/projects.ts` (`RunStore`: how a project/workflow/run resolves to a run directory, the bounded readers, `runFingerprint`, the summary cache, `loadRun`);
  - `server/projectsConfig.ts` (the registry: `repository` is registered for each project; today "nothing is read from it", and from now on git reads it);
  - `server/index.ts` (environment, listens on `127.0.0.1`).
- **Run-controls routes:** run-controls-004 added `/api/run-controls` (`server/controls*.ts`). Follow its pattern for a new route module registered in `app.ts`. Do not change it.
- **Step digests:** use `RunStore`'s own run loading (import it; do not change `projects.ts`) and cache each run's digest by its directory fingerprint, as `listRuns` does. The integrated commit is the sha in the run's succeeded `integrate` node message ("Fast-forwarded to <sha>"). `source_branch` and `base_commit` come from the run's inputs.
- **Git:** `execFile('git', ['--no-optional-locks', '-C', repo, ...])` with a 5 s timeout and `GIT_TERMINAL_PROMPT=0`; never a shell. Expand a leading `~` in `repository` from `HOME`. Results are cached 15 s per repository. The commands are in PRD section 5.
- **GitHub:**
  - an injected runner calls the executable `MD_MANAGER_GH` (default `gh`) with an argv array;
  - one repository at a time, at most once per `MD_MANAGER_GITHUB_REFRESH_MINUTES`;
  - a 20 s timeout per call;
  - the last good read is kept in memory and in `MD_MANAGER_GITHUB_CACHE`;
  - `MD_MANAGER_GITHUB=off` means status `off`;
  - `MD_MANAGER_GITHUB_FIXTURE` replaces every `gh` call with the fixture file (Appendix A.3).

  The first request after start may answer `pending` ("not read yet") for a repository whose read has not finished. A request never waits for `gh`. Never log or return a token, an environment value or `gh auth` output beyond the first line of a refusal.
- **The viewer lane** mirrors Appendix A's types in `src/projects/dispatch/types.ts` and mocks your routes in its worker phase. In the candidate phase its browser specs run against your real routes, with git repositories it seeds under the test root and `MD_MANAGER_GITHUB_FIXTURE` set. Match Appendix A exactly: field names, nullability and status values.
- **Tests** isolate every path under a temporary directory and `HOME`: real temporary git repositories (a bare origin, a clone with commits ahead and behind, a `git worktree` of it, a non-GitHub remote, a missing path), an injected clock and an injected `gh` runner. Never touch the real `~/.config/md-manager/`, `~/.cache`, `~/.local/state` or any real repository.

## Constraints

- Owned paths only (policy.json `server`). Do not touch `src`, `tests/project-workflows`, `tests/unit`, `server/projectRoutes.ts`, `server/projects.ts` or the run-controls files. Helpers you need are imported, not changed. A change you cannot avoid is a `question` completion.
- GET and HEAD only; other methods 405. No write anywhere except the GitHub cache file.
- No `git fetch`, `pull`, `push`, `gc`, `checkout` or any command that writes; no shell.
- No new dependency.

## Acceptance

Each item has a test in `server/dispatch.test.ts`, which `frontend-unit` (`npm run test:unit`) runs:

1. Git state on temporary repositories:
   - a clone 2 ahead and 1 behind its origin ref reports `ahead: 2, behind: 1`, `fetched_at` from `FETCH_HEAD`'s mtime, and both commits ahead (the one whose subject is `Workflow <run-id>: …` carries that `run_id`);
   - a worktree of it reports the same `clone` and the first project as `clone_primary`;
   - a repository without an origin ref has `origin: null`;
   - a missing path and a non-repository are `unavailable` with a reason;
   - a detached HEAD has `checkout: null`.
2. Default branch: from `refs/remotes/origin/HEAD`, else `main`, then `master`, else null.
3. Landings: an integrated sha on local and origin is `true/true`; on local only is `true/false`; a sha the clone lacks is `null/null`.
4. GitHub:
   - `off`, `not_github` (an ssh or https non-GitHub remote), `unavailable` (runner exits non-zero: the reason is the first stderr line), `pending` before the first read, and `read` with every Appendix A field;
   - a failed refresh keeps the last good read and its `read_at`, and sets `reason`;
   - a second request within the refresh window calls the runner no more;
   - the fixture file replaces the runner;
   - `open_issues` excludes PRs;
   - a bot author is `author_is_bot: true`.
5. `steps`: per workflow, newest first, at most 50 runs; each run's steps in definition order with status and attempt, lanes, `source_branch`, `integrated_commit`; an unreadable run appears in `errors` and does not fail the response; an unknown project is 404 `NOT_FOUND`; POST is 405.
6. `contracts/projects/dispatch.ts` holds Appendix A's zod schemas (`DISPATCH_VERSION = '1.0.0'`). `contract.test.ts` validates the examples in `contracts/projects/examples.ts`: an overview with one project in each git and GitHub status, and a `ProjectSteps` with an `errors` entry. The routes parse their responses before sending.
7. `docs/handoff/projects-dispatch-server.md` says what changed, how to turn GitHub reads off, and every open P2.

`frontend-build`, `frontend-lint`, `shared-contract` and `frontend-unit` pass.

Run targeted tests while iterating, then this lane's non-browser policy checks once before writing the completion; run browser specs only through check-report on this lane's own specs.

## Stop

Stop and report `question` in either case:
- a field of Appendix A cannot be filled without changing `server/projects.ts` or `server/projectRoutes.ts`;
- the registry gives no repository path for a project and none can be found read-only.

Stop and report `blocked` when `gh` output lacks a field Appendix A requires, naming the field. Do not add routes beyond Appendix A, do not fetch, and do not write anywhere but the GitHub cache.
