# Handoff: the dispatch API (lane `server`, runs projects-dispatch-001 and -002)

Spec: [PRD_PROJECTS_DISPATCH.md](../PRD_PROJECTS_DISPATCH.md) sections 2, 5, 7 and Appendix A; decisions
`features/projects-dispatch/decisions.md` ([P1]–[P37], [L1]–[L9], and the design-challenge notes bind; where they
differ from the PRD they win). The viewer lane mirrors the types in `src/projects/dispatch/types.ts`; this file is
what it can rely on. Appendix A's shapes are frozen for run 002 ([L4]): run 002 fixed behaviour only, renaming,
removing or retyping no field.

## What run 002 changed (S1–S6)

Run 002 fixes `review-001.md`'s findings; the response shapes are unchanged.

| Item | File | What |
|---|---|---|
| S1 | `server/dispatchGit.ts` | `localDefaultExists` is resolved from `refs/heads/<d>` independently of the origin ref, so a local-only repository reports `on_default` true/false (never `null`) while `on_origin` stays `null`. |
| S2 | `server/dispatchGithub.ts` | `Entry.attemptedAtMs` records every attempt (success or not); `due()` reads it, so a failed or never-successful read waits a full `MD_MANAGER_GITHUB_REFRESH_MINUTES` window instead of retrying every minute. The start read still runs once per repository (a never-attempted entry is due). |
| S3 | `server/dispatchGithub.ts`, `server/dispatch.ts`, `server/index.ts` | `cycle()` discovers the current registry, registers new keys and reads only *those* that are due; a repository dropped from discovery keeps its entry and cached data but is not read ([P12]). Discovery is wired in `buildDispatch` as `async () => { await store.sync(); return discoverGithubRepos(store.config.projects, gitRunner) }` ([L9]); `GithubReader.setDiscover` receives it there, since the store does not exist where `index.ts` builds the reader. `index.ts` no longer builds `discover` from the start-up registry. |
| S4 | `server/dispatchSteps.ts` | An unreadable run is cached by the directory fingerprint, like a good digest, and warn-logged once per fingerprint; in-flight loads are deduped per run key so the un-awaited boot `warm` and the first request do not both load it (design-challenge note 4). |
| S5 | `server/dispatchSteps.ts` | `ProjectApiError` messages (per-run `errors[]` and the workflow-level `error`) pass through `redactPaths` ([L8]); the recorded text survives, only paths become `<path>`. |
| S5 | `server/dispatchGit.ts`, `server/dispatchGithub.ts` | `realGitRunner`/`realGhRunner` take an optional injected `execFile` (`ExecFileLike`), defaulting to the real one, for the spawn-option test (design-challenge note 2). `realGhRunner` now passes `env: { ...process.env }` so gh keeps its credentials *and* the test can assert `GH_TOKEN` reaches `execFile` (note 3). |
| S5 | `server/dispatchGithub.ts` | The fixture-file / `MD_MANAGER_GITHUB=off` resolution moved into the exported `githubReaderOptions(env, now)` that `index.ts` imports ([P36]); no new file, no `package.json` change. |
| S5 | `server/dispatch.test.ts` | 17 new tests (`S1:`…`S5:`), listed under Acceptance. |

### How each S-test was seen to fail (P37)

The controller reruns the suite; S1–S4 fail on the base and pass here, and each S5 test fails when its behaviour is
broken. Confirmed by hand (each change reverted after): S1 — `localDefaultExists` forced to `false` → `on_default`
`null`. S2 — `due()` back to `readAtMs` → 15 reads per window. S3 — `cycle()` back to `refreshDue()` over all entries
→ a dropped repository is still read. S4 — cache only digests → the corrupt run loads twice. S5 path — drop
`redactPaths` in `dispatchSteps.ts` → the `/tmp/...` path reaches the response. S5 read-only — the allowlist test
also fails statically for `remote set-url`, a two-arg `symbolic-ref` and `reflog expire`, so a writing argv in
`dispatchGit.ts` would trip the recording loop.

### Run 002 repair round 1 (lane-review-1 P1s)

The lane reviewer flagged three tests in `server/dispatch.test.ts` that passed without guarding their behaviour.
Strengthened so each now fails on the regression it names (each break reverted after):

- **S3 registry-reload wiring.** The test now builds a real `RunStore` over a registry *file* and drives the reader
  wired by `buildDispatch` (`store.sync()` + `discoverGithubRepos`) through `cycle()` with no `app.inject`, rather than
  mutating an injected key array. Confirmed by dropping `await store.sync()` from `buildDispatch`'s discover → the
  rewritten registry never reaches discovery and `o/b` is never read → the test fails.
- **S5 read-only allowlist.** `isReadOnlyGit` now rejects a writing *option* (`--output`, `--delete`, …, and short
  `-d`/`-o`/`-f`/`-w`) whatever the verb, so a read verb cannot smuggle a write. New static assertions:
  `symbolic-ref --delete`, `symbolic-ref -d`, `log --output=<file>`, `rev-list --output=<file>` all return `false`
  (each was accepted before). A writing argv in `dispatchGit.ts` still trips the recording loop.
- **S5 newest-50.** The test now writes 55 runs with strictly increasing `updated_at` and asserts the returned ids
  are *exactly* the newest 50, newest first (`run-054 … run-005`), not merely `runs.length === 50`. Confirmed by
  flipping `compareRuns`' sign / taking the oldest 50 → the `deepEqual` fails.

No production code changed in this repair; the three edits are test-only.

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

Reads are timer-driven only ([P18]): a start read of every discovered repository, then a one-minute tick reading
whichever is due, one at a time, 20 s per call. Requests never trigger or wait for a read. Options are resolved by
`githubReaderOptions(process.env, Date.now)` in `index.ts` ([P36]); the reader is passed to `createApp`, so a plain
server (and every existing server test) is GitHub-off — no timer, no cache, no runner (note 7). Each tick discovers
the registry the reloader keeps current (`buildDispatch` wires `store.sync()` + `discoverGithubRepos`, [S3]/[L9]): a
repository registered at runtime is read without a page request, and one unregistered is left alone with its cached
data, never deleted. The timer is `unref`'d and cleared on `onClose`.

## Open items and things to verify (P2)

1. **The real `gh` path is not exercised by any check (design-challenge note 12, Acts: operator; stays open per [L6]).**
   Unit tests inject the runner; the candidate phase and critique app use the fixture. The query text (`GITHUB_QUERY`),
   argv (`githubArgv`) and the spawn options (argv array, no shell, the 20 s timeout, and `env: { ...process.env }` so
   `GH_TOKEN`/`GH_CONFIG_DIR`/`XDG_CONFIG_HOME`/`HOME`/`PATH` reach gh) are now unit-tested with a mocked `execFile`
   (`S5: realGitRunner and realGhRunner spawn execFile …`), but no check runs the real `gh` against live GraphQL.
   Before or right after integration, run the exact query once with the host's `gh` against one registered repository
   and confirm it parses into every Appendix A field, then record the result here. `viewer_login` comes from
   `viewer { login }` in the same query (not a separate `gh api user`).
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
