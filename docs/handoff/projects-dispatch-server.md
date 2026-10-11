# Handoff: the dispatch API (lane `server`, run projects-dispatch-001)

Spec: [PRD_PROJECTS_DISPATCH.md](../PRD_PROJECTS_DISPATCH.md) sections 2, 5, 7 and Appendix A; decisions
`features/projects-dispatch/decisions.md` ([P1]–[P23], [L1]–[L2], and the design-challenge notes bind; where they
differ from the PRD they win). The viewer lane mirrors the types in `src/projects/dispatch/types.ts`; this file is
what it can rely on.

## What changed

| File | What |
|---|---|
| `contracts/projects/dispatch.ts` | Appendix A's zod schemas (`dispatchOverviewSchema`, `projectStepsSchema`, `gitStateSchema`, `githubStateSchema`, `githubRepoReadSchema`), `DISPATCH_VERSION = '1.0.0'`, and the `dispatchSchemas` map |
| `contracts/projects/examples.ts`, `contract.test.ts` | a `DispatchOverview` with one project in each git and GitHub status, a `ProjectSteps` with an `errors` entry; the tests validate each against the generated schema and assert the refusals |
| `contracts/projects/dispatchOverview.schema.json`, `projectSteps.schema.json`, `export.ts` | the generated JSON Schema and the export that writes them (`npm run contracts:export`) |
| `server/dispatchGit.ts` | read-only git: default branch, origin comparison, reflog date, ahead commits and run naming, landings, the GitHub remote parse, `repository_label`, `clone_id`; `GitReader` caches each repository 15 s |
| `server/dispatchGithub.ts` | the `gh` GraphQL read and parse, the timer-driven `GithubReader` (off / fixture / runner), the on-disk cache, the fixed failure reasons |
| `server/dispatchSteps.ts` | the per-run step digests: lists each `runs_root`, calls `RunStore.loadRun`, caches by a reimplemented directory fingerprint |
| `server/dispatch.ts` | the two routes, the per-project git/GitHub degradation, 405 for other methods, 404 `NOT_FOUND` for an unknown project |
| `server/app.ts`, `server/index.ts` | `createApp(..., { dispatch })`; the API resolves `MD_MANAGER_GITHUB*` in `index.ts` and passes the git runner + GitHub reader |
| `server/dispatch.test.ts` | 29 tests, all in `npm run test:unit` |
| `docs/handoff/projects-dispatch-server.md` | this file |

`server/projects.ts`, `server/projectRoutes.ts` and `server/projectsConfig.ts` are unchanged. `RunStore.loadRun`,
`RunStore.scope` and `RunStore.config` are imported as-is; `runFingerprint`/`openDirectory`/`readBounded` are not
exported there, so `dispatchSteps.ts` lists `runs_root` itself (with `ID_PATTERN`) and reimplements the short
fingerprint with a comment citing `projects.ts:672` ([L2]).

## The wire (as built)

- `GET /api/dispatch/projects` → `DispatchOverview` (every registry project, in registry order). `GET` and `HEAD`
  only; any other method is 405 with `Allow: GET, HEAD`.
- `GET /api/dispatch/projects/:projectId/steps` → `ProjectSteps`. An unknown project is 404 `NOT_FOUND` (this
  route's code, not `RunStore`'s `PROJECT_NOT_FOUND`); `POST` is 405. Errors use `{ error: { code, message } }`.
- Each project's `git` and `github` are validated on their own: a git part that fails the contract (a bad sha, an
  unexpected enum) degrades to `unavailable` "git failed"; a GitHub read that cannot be parsed never becomes `read`
  (it stays `unavailable` "gh output was not understood"). One odd field never blanks the whole page (note 6).
- GitHub state per project: `git` unavailable → `unavailable` "git not read"; no GitHub origin → `not_github`
  "not a GitHub remote"; `MD_MANAGER_GITHUB=off` → `off`; before the first read → `pending` "not read yet"; a
  fixture repository missing from the file → `unavailable` "not in the fixture". `repo` ("owner/name") is set for
  every status but `not_github` and a git-unavailable project ([P19]).

## Turning GitHub reads off / configuring them (Appendix A.3)

| Variable | Default | Meaning |
|---|---|---|
| `MD_MANAGER_GITHUB` | on | `off` disables every `gh` call; GitHub states are `off` |
| `MD_MANAGER_GH` | `gh` | the executable for GitHub reads |
| `MD_MANAGER_GITHUB_FIXTURE` | unset | a JSON file `{viewer_login, repos}` read synchronously at start, used instead of `gh`; no cache write |
| `MD_MANAGER_GITHUB_REFRESH_MINUTES` | 15 | minimum minutes between reads of one repository |
| `MD_MANAGER_GITHUB_CACHE` | `~/.cache/md-manager/github.json` | the last good reads, with `read_at` |

Reads are timer-driven only ([P18]): a start read of every registered repository, then a one-minute tick reading
whichever is due, one at a time, 20 s per call. Requests never trigger or wait for a read. The reader is resolved in
`index.ts`, not in `createApp`, so a plain server (and every existing server test) is GitHub-off — no timer, no cache,
no runner (note 7). The timer is `unref`'d and cleared on `onClose`.

## Open items and things to verify (P2)

1. **The real `gh` path is not exercised by any check (design-challenge note 12, Acts: operator).** Unit tests inject
   the runner; the candidate phase and critique app use the fixture. Before or right after integration, run the lane's
   exact query once with the host's `gh` against one registered repository and confirm it parses into every Appendix A
   field, then record the result here. The query text is `GITHUB_QUERY` in `server/dispatchGithub.ts`; `viewer_login`
   comes from `viewer { login }` in the same query (not a separate `gh api user`).
2. **Operator-accepted candidates are not counted as landings (design-challenge note 11).** `integrated_commit` and
   landings come only from an `integrate` message "Fast-forwarded to <sha>". A run the operator accepted by hand
   (export 1.12.0 `accepted.candidate`) has no such message, so it never counts as a landing. Follow-up: read the
   accepted record as a landing source, next to the `on_source` follow-up.
3. **Reflog date on the reftable backend.** `origin.updated_at` is read with
   `git reflog show -1 --date=iso-strict --format=%gd refs/remotes/origin/<d>` (note 10), which reads both the files
   and reftable backends, rather than the `logs/refs/...` file the PRD names. Confirm on a reftable clone if the host
   adopts it.
4. **Run-id membership for naming commits.** A commit "names a run" when its subject's run id is a directory under one
   of the project's `runs_root`s (not only a successfully loaded run), so the count survives legacy and just-launched
   directories and does not depend on a valid export. This is the faithful reading of "one of the project's runs"
   (a run belongs to a workflow solely by living under its `runs_root`).
