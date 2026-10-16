# Handoff: run-teams lane B1, the run's GitHub read

Branch `rt/ghread`. Implements `GET /api/dispatch/projects/:project_id/workflows/:workflow_id/runs/:run_id/github` (+ HEAD) against
the committed contract `contracts/projects/github.ts` (`runGithubSchema`, 1.0.0). The contract is unchanged.

## What was built

- **`server/runGithub.ts`** (new)
  - `validBranchName`: git's ref rules, slightly stricter. Rejects leading `-` or `/`, `..`, `//`, `@{`, control characters, space, `~^:?*[\`, a component starting with `.` or ending `.lock`, a trailing `/` or `.`, and names over 255 characters. An invalid name never reaches an argv.
  - `readRunBranch(runner, repo, branch, defaultBranch, integratedCommit)` reads the local branch facts with read-only git, always on fully qualified refs:
    - `local_sha` and `tracking_sha` (`rev-parse --verify --quiet <ref>^{commit}`);
    - `push_state`, ahead/behind against the remote branch and against `origin/<default>` (`rev-list --left-right --count`);
    - `unpublished`: up to 50 commits, with `unpublished_more` taken from an exact `rev-list --count ... --not ...`. Each commit has sha, subject, `Name <email>` and `cI`;
    - `contains_integrated` (`merge-base --is-ancestor`).
    Nothing fetches.
  - `readRunRepo` gives the repository status (`github`, `not_github`, `no_remote`, `unavailable`, each with a fixed reason), `owner/name` via `parseGithubRemote`, and the default branch (origin/HEAD, else main, then master).
  - `RunBranchReader` caches repo and branch reads for 10 s per (repo, branch, integrated commit, fallback default). `invalidate(repo, branch)` drops them.
  - `createRunGithubSource({store, github, branches})` returns the `RunGithubSource` the brief specified:
    ```ts
    export type RunGithubSource = { read(projectId, workflowId, runId): Promise<RunGithub>; markDue(projectId, workflowId, runId): void }
    ```
    - `read` checks the IDs (400 `INVALID_ID`), loads the run (404s from `RunStore`), and takes `source_branch` and the integrated commit from `buildDigest` (the integrate event's `Fast-forwarded to <sha>`). It assembles the payload and validates it (500 `RESPONSE_INVALID` on a violation).
    - `markDue` invalidates the local cache and calls `GithubReader.markDue('owner/name#branch')`. If the run was never read, it first resolves it with one read.
- **`server/dispatchGithub.ts`**: run branch keys `owner/name#<branch>` in `GithubReader`.
  - `branchState(repo, branch)` answers from the cache only. It registers the key and stamps its request time; `pending` before the first read; a failed refresh keeps `read` with the data plus a reason; a failure with no data is `unavailable`. Visibility comes from the branch read, else the repository read.
  - `markDue(key)`; `cycleBranches()` / `refreshBranches()`. A 30 s branch tick is added to `start()` and stopped by `stop()`.
  - A key is due when its last attempt is older than `MD_MANAGER_GITHUB_BRANCH_REFRESH_SECONDS` (default 90) and it was requested in the last 15 minutes.
  - One GraphQL query per repository (at most 10 branches each), aliases `b<i>`/`p<i>`. Every branch name is a `-f` variable (`q<i>=refs/heads/<b>`, `h<i>=<b>`) and never part of the query text.
  - `parseBranches` drops cross-repository PRs and picks the newest OPEN PR, else the newest; the rest become `earlier_prs` (max 10).
  - `checkBucket` assigns pass, fail, pending, skip or neutral by the brief's table. Checks are sorted fail, then pending, then by name. Teams are written `org/slug`; Mannequins count as users.
  - `githubBranchReadSchema` is the stored per-branch shape, used by the cache (`branches` map), the fixture (`branches` map) and memory. Files without `branches` still load. The cache keeps at most 200 branch reads.
  - Also added: `mode` getter, `repoFacts(repo)`, `branchDefault(repo, branch)`, and `githubReaderOptions` reading `MD_MANAGER_GITHUB_BRANCH_REFRESH_SECONDS` and the fixture's `branches`.
- **`server/dispatch.ts`**: the route, in `paths` (so other methods get 405) and validated with `conform(runGithubSchema, …)`.
  - `DispatchDeps` gains `runGithub: RunGithubSource`, built once in `buildDispatch`.
  - A `declare module 'fastify'` augmentation types `app.runGithub`. `RunGithubSource` is re-exported.
- **`server/app.ts`**: one line, `app.decorate('runGithub', dispatch.runGithub)`.
- **`tests/project-workflows/fixtures/dispatch.ts`**: the GitHub fixture gains a `branches` entry `acme/widgets#feature/ui-polish-002`, plus the type `FixtureBranchRead`. No seeded run records a `source_branch` yet, so no run serves it today; see the gaps below.
- **`docs/PRD_PROJECTS_DISPATCH.md`**: the route in A.1, a "Runs now read their branch" note, and the A.3 env row and fixture/cache wording.

## Status rules (as implemented)

- **`repo.status`:**
  - `unavailable`: the repository is missing, unreadable or not a repository;
  - `no_remote`: there is no origin;
  - `not_github`;
  - `github`.
- **`github.status`**, checked in this order:
  1. repo unavailable gives `unavailable` "git not read";
  2. a non-GitHub repo gives `not_github`;
  3. `MD_MANAGER_GITHUB=off` gives `off`;
  4. a run with no branch or an invalid one gives `unavailable` with "the run records no branch" or "the run branch is not a valid git branch name" (`viewer_login` and `visibility` are kept when known);
  5. otherwise the reader's branch state: `pending`, `read`, or `unavailable` with the gh reason.
- **`branch`:** with no local branch, `push_state` is `no_local_branch`, but `tracking_sha` is still reported. When git cannot tell, the facts are null and `push_state` is `unknown`. Values are never guessed.

## Tests

- `npx --no-install tsx --test server/runGithub.test.ts`: 20 pass, 0 fail.
  - Real temp repos (bare origin and clones, `GIT_CONFIG_GLOBAL=/dev/null`) cover every push state, unpublished commits with author, more than 50 commits, contains_integrated true/false/null, invalid names refused before git, the repo statuses and the 10 s cache.
  - Canned GraphQL covers: a draft PR with failing checks and team/user/bot reviewers; check buckets; merged PR plus earlier PRs; a cross-repository PR ignored; no PR; branch names only in variables; the due window and markDue; 15-minute interest; logged out → unavailable, then the last data kept; off; fixture `branches` and an old fixture; cache write and restart; an old cache.
  - Route tests: GET and HEAD 200 validated; 405 on POST/PUT/PATCH/DELETE; unknown run 404; unknown project 404; no branch; a GitLab origin is `not_github`; runner mode is `pending` with no gh call from a request; `app.runGithub.markDue` causes a reread; a missing repo is `unavailable`.
- `npx --no-install tsx --test server/dispatch.test.ts`: 52 pass, 0 fail. The 51 existing tests are unchanged, and one new test proves every argv of the run reader passes the `isReadOnlyGit` allowlist with fully qualified refs. No new verb was needed.
- `npx --no-install tsc -b`: clean. `npx --no-install eslint` on every changed file: clean.

## For the integrator and the actions lane

- The controls plugin can use `app.runGithub` (decorated on the root instance before `controlRoutes` is registered, so it is visible inside the plugin as `scope.runGithub`). Alternatively, pass `dispatch.runGithub` explicitly in `app.ts`.
- After a push or a PR, call `runGithub.markDue(p, w, run)`. The next 30 s branch tick rereads the branch, and the local git cache is dropped immediately.
- The UI lane's client should call the route above. The e2e mock (`tests/project-workflows/mock.ts`) does not serve it; that is the UI lane's file.

## Known gaps

- `contracts/projects/README.md` has no row for the route. That file is not owned by this lane, so the row went into the dispatch PRD's A.1 instead.
- The e2e fixture's `branches` entry is served only once a seeded dispatch run records `inputs.source_branch` (`feature/ui-polish-002`). `writeDispatchRun` writes no `inputs` section today.
- The integrated commit comes from the integrate event (`Fast-forwarded to <sha>`, as the step digests do), not from `values.integrated_commit`, which `RunStore` does not expose.
- `unresolved_threads` is null when a PR has more than 100 review threads, because only the first 100 are read.
