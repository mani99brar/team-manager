# Server worker: the dispatch API (PRD_PROJECTS_DISPATCH)

## Goal

The API serves `GET /api/dispatch/projects` and `GET /api/dispatch/projects/:projectId/steps` (PRD Appendix A) from the Projects registry. For every registered project it returns:
- the git state of its repository: checkout, default branch, the clone (as a hash) and its primary project, ahead/behind against the origin ref as this clone has it, dated by that ref's reflog, the commits ahead and how many name a run, and landings (true, false or unknown);
- the GitHub state of its `origin` repository: visibility, default-branch head, open counts, the 20 most recently updated PRs and the 20 newest open issues, read with `gh` on a timer and cached with its read time;
- per workflow, each run's step digest (status and attempt per node), lanes, source branch and integrated commit.

Everything is read-only. The server never fetches, pushes or writes to a repository or a run directory. Where something cannot be read, the response says why in `reason`, using a fixed text. No absolute path ever goes into a response.

`docs/PRD_PROJECTS_DISPATCH.md` sections 2, 5 and 7 and Appendix A are the specification; `features/projects-dispatch/decisions.md` wins over the PRD where they differ.

## Context

- **Today's server:**
  - `server/app.ts` (Fastify; registers `projectRoutes`; `onReady` calls `store.warmSummaries()`);
  - `server/projectRoutes.ts` (the read-only Projects API, the `{ error: { code, message } }` body, 405 for other methods);
  - `server/projects.ts` (`RunStore`: how a project/workflow/run resolves to a run directory, the bounded readers, `runFingerprint`, the summary cache, `loadRun`);
  - `server/projectsConfig.ts` (the registry: `repository` is an absolute path, `~` is rejected, and today "nothing is read from it"; from now on git reads it). Import it, do not change it ([P7]);
  - `server/index.ts` (environment, listens on `127.0.0.1`).
- **Run-controls routes:** run-controls-004 added `/api/run-controls` (`server/controls*.ts`). Follow its pattern for a new route module registered in `app.ts`. Do not change it.
- **Step digests:** use `RunStore`'s own run loading (import it; do not change `projects.ts`) and cache each run's digest by its directory fingerprint, as `listRuns` does. The integrated commit is the sha in the run's succeeded `integrate` node message ("Fast-forwarded to <sha>"). `source_branch` and `base_commit` come from the run's inputs.
- **Git:** `execFile('git', ['--no-optional-locks', '-C', repo, ...])` with a 5 s timeout and the environment `GIT_TERMINAL_PROMPT=0`, `GIT_NO_LAZY_FETCH=1`, `GIT_OPTIONAL_LOCKS=0`; never a shell. Results are cached 15 s per repository. PRD section 5 gives the commands and every rule: default branch, `compare`, the reflog date, landings, `ahead_naming_run`, the GitHub URL forms, `repository_label` and `clone_id`.
- **GitHub:**
  - an injected runner calls the executable `MD_MANAGER_GH` (default `gh`) with an argv array;
  - timer-driven only ([P18]): a read of every registered GitHub repository at start, then a one-minute tick that reads whichever is due (older than `MD_MANAGER_GITHUB_REFRESH_MINUTES`), including repositories the registry reloader adds;
  - one repository at a time, with a 20 s timeout per call;
  - requests never trigger or wait for a read; before a repository's first read its state is `pending` ("not read yet");
  - the last good read is kept in memory and in `MD_MANAGER_GITHUB_CACHE`;
  - a failed refresh keeps status `read` with the data and sets `reason` ([P12]);
  - `MD_MANAGER_GITHUB=off` means status `off`;
  - `MD_MANAGER_GITHUB_FIXTURE` replaces every `gh` call. It is read synchronously before the server listens, so the first response is already `read`, and nothing is written to the cache ([P6], [P20]).

  PRs come from one GraphQL query ordered by `UPDATED_AT` (Appendix A.3, binding). Reasons are the fixed texts of PRD section 5; never return or log stderr, a token or an environment value ([P14]).
- **The viewer lane** mirrors Appendix A's types in `src/projects/dispatch/types.ts` and mocks your routes in its worker phase. In the candidate phase its browser specs run against your real routes, with git repositories it seeds under the test root and `MD_MANAGER_GITHUB_FIXTURE` set. Match Appendix A exactly: field names, nullability and status values.
- **Tests** isolate every path under a temporary directory and `HOME`: real temporary git repositories (a bare origin; a clone with commits ahead and behind and a remote-tracking reflog; a `git worktree` of it; a clone without a local default branch; a non-GitHub remote; a lookalike host such as `https://evilgithub.com/o/n`; a missing path), an injected clock and an injected `gh` runner. Never touch the real `~/.config/md-manager/`, `~/.cache`, `~/.local/state` or any real repository.

## Constraints

- Owned paths only (policy.json `server`). Do not touch `src`, `tests/project-workflows`, `tests/unit`, `server/projectRoutes.ts`, `server/projects.ts`, `server/projectsConfig.ts` or the run-controls files. Helpers you need are imported, not changed. A change you cannot avoid is a `question` completion.
- GET and HEAD only; other methods 405. No write anywhere except the GitHub cache file.
- No `git fetch`, `pull`, `push`, `gc`, `checkout` or any command that writes; no shell.
- No new dependency.

## Acceptance

Each item has a test in `server/dispatch.test.ts`, which `frontend-unit` (`npm run test:unit`) runs:

1. Git state on temporary repositories:
   - a clone 2 ahead and 1 behind reports `compare: 'compared', ahead: 2, behind: 1`, `updated_at` from the newest reflog entry of `refs/remotes/origin/<d>` (a fetch of a second remote does not change it), and both commits ahead; the one whose subject is `Workflow <run-id>: …` carries that `run_id`;
   - with 60 commits ahead, of which 55 name runs, it lists 50 and `ahead_naming_run` is 55;
   - a worktree of it has the same `clone_id` and the first project as `clone_primary`;
   - a clone without a local default branch reports `compare: 'no_local_branch'` with null counts;
   - a repository without an origin ref has `origin: null`;
   - a missing path and a non-repository are `unavailable` with a fixed reason;
   - a detached HEAD has `checkout: null`;
   - no response field holds an absolute path: `repository_label` is `~`-relative under `HOME`, else a basename.
2. Default branch: from `refs/remotes/origin/HEAD`, else `main`, then `master`, else null.
3. Landings: on local and origin is `true/true`; on local only is `true/false`; a sha the clone lacks, or a missing ref, is `null`.
4. GitHub:
   - `off`; `not_github` for a non-GitHub remote and for a lookalike host;
   - `unavailable` with "gh is not installed", "gh is not logged in", "gh timed out after 20 s" or "gh failed (exit n)", where stderr holding a token-looking string never reaches the response;
   - `pending` before the first read, and `read` with every Appendix A field;
   - a failed refresh keeps `read`, the data and `read_at`, and sets `reason`;
   - requests within the refresh window never call the runner, and the tick reads a due repository;
   - the fixture file replaces the runner, is `read` on the first request, and writes no cache;
   - `open_issues` excludes PRs;
   - a bot author is `author_is_bot: true`.
5. `steps`:
   - per workflow, newest first, at most 50 runs;
   - each run's steps carry `label` and `kind` from its own recorded definition, with status and attempt;
   - each run has lanes, `source_branch` and `integrated_commit`;
   - an unreadable run appears in `errors`, and a workflow whose runs cannot be listed sets `error`; neither fails the response;
   - an unknown project is 404 `NOT_FOUND`; POST is 405.
6. `contracts/projects/dispatch.ts` holds Appendix A's zod schemas (`DISPATCH_VERSION = '1.0.0'`). `contract.test.ts` validates the examples in `contracts/projects/examples.ts`: an overview with one project in each git and GitHub status, and a `ProjectSteps` with an `errors` entry. The routes parse their responses before sending.
7. `docs/handoff/projects-dispatch-server.md` says what changed, how to turn GitHub reads off, and every open P2.

`frontend-build`, `frontend-lint`, `shared-contract` and `frontend-unit` pass.

Run targeted tests while iterating, then this lane's non-browser policy checks once before writing the completion; run browser specs only through check-report on this lane's own specs.

## Stop

Stop and report `question` in either case:
- a field of Appendix A cannot be filled without changing `server/projects.ts` or `server/projectRoutes.ts`;
- the registry gives no repository path for a project and none can be found read-only.

Stop and report `blocked` when `gh` output lacks a field Appendix A requires, naming the field. Do not add routes beyond Appendix A, do not fetch, and do not write anywhere but the GitHub cache.
