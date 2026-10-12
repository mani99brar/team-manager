# Handoff: the dispatch API (lane `server`, runs projects-dispatch-001, -002, -003 and -004)

Spec: [PRD_PROJECTS_DISPATCH.md](../PRD_PROJECTS_DISPATCH.md) sections 2, 5, 7 and Appendix A; decisions
`features/projects-dispatch/decisions.md` ([P1]–[P37], [L1]–[L16], and the design-challenge notes bind; where they
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
→ a dropped repository is still read. S4 — cache only digests → the corrupt run loads twice (the old S4 test is now
`S9: an unreadable run is cached by fingerprint and warn-logged once across warm and two overview requests`).
`S9: no absolute path appears in either route's whole JSON; per-run and workflow-level error paths are redacted ([L8], [P8])`
(then named S5) — drop `redactPaths` in `dispatchSteps.ts` → the `/tmp/...` path reaches the response.
`S9: every git argv the reader issues is read-only (an allowlist of exact shapes, abbreviations rejected)` (then named S5) — the allowlist test
also fails statically for `remote set-url`, a two-arg `symbolic-ref` and `reflog expire`, so a writing argv in
`dispatchGit.ts` would trip the recording loop.

### Run 002 repair round 1 (lane-review-1 P1s)

The lane reviewer flagged three tests in `server/dispatch.test.ts` that passed without guarding their behaviour.
Strengthened so each now fails on the regression it names (each break reverted after):

- **`S3: the tick discovers the current registry; a repository missing from a discovery keeps its cached data but is not read`.** The test now builds a real `RunStore` over a registry *file* and drives the reader
  wired by `buildDispatch` (`store.sync()` + `discoverGithubRepos`) through `cycle()` with no `app.inject`, rather than
  mutating an injected key array. Confirmed by dropping `await store.sync()` from `buildDispatch`'s discover → the
  rewritten registry never reaches discovery and `o/b` is never read → the test fails.
- **`S9: every git argv the reader issues is read-only (an allowlist of exact shapes, abbreviations rejected)`** (then named S5). `isReadOnlyGit` now rejects a writing *option* (`--output`, `--delete`, …, and short
  `-d`/`-o`/`-f`/`-w`) whatever the verb, so a read verb cannot smuggle a write. New static assertions:
  `symbolic-ref --delete`, `symbolic-ref -d`, `log --output=<file>`, `rev-list --output=<file>` all return `false`
  (each was accepted before). A writing argv in `dispatchGit.ts` still trips the recording loop.
- **`S5: the steps route returns the newest 50 runs, newest first`.** The test now writes 55 runs with strictly increasing `updated_at` and asserts the returned ids
  are *exactly* the newest 50, newest first (`run-054 … run-005`), not merely `runs.length === 50`. Confirmed by
  flipping `compareRuns`' sign / taking the oldest 50 → the `deepEqual` fails.

No production code changed in this repair; the three edits are test-only.

## What run 003 changed (S7–S10)

Run 003 fixes `review-002.md`'s server findings: two lane-review P1s where an S5 test could not fail on its
regression (S7, S8) and the S5/S4 test-strength P2s (S9). All edits are in `server/dispatch.test.ts` only; **no
production code changed** (the read-only abbreviation guard lives in the test file's own `isReadOnlyGit` helper). Each
superseded S5/S4 test was renamed to its S7/S8/S9 item. The GraphQL fixture now has a draft PR (#42 `isDraft: true`)
and an issue with labels (`triage`, `bug`), and `writeRunDir`'s `nodes` type was widened to the `contracts/projects/v1.ts`
kind enum so S8's recorded `kind: 'review'` type-checks under `tsc -b` (design-challenge note 2).

### How each S7–S9 test was seen to fail (P37)

Each break was made by hand, the one test run, and reverted (all four lane checks pass on the unbroken tree):

| Test (in `server/dispatch.test.ts`) | Hand-break that makes it fail |
|---|---|
| `S7: realGitRunner and realGhRunner spawn execFile the way production does — default timeouts 5000/20000, no shell, the env` | Change a default timeout: `realGitRunner(timeoutMs = 5000 → 6000)` (`dispatchGit.ts:53`) or `GH_TIMEOUT_MS = 20_000 → 30_000` (`dispatchGithub.ts:33`). The test now calls the runners the way production does (`realGitRunner(undefined, …)`, `realGhRunner('gh', undefined, …)`) and asserts 5000/20000, so either default change fails it. Confirmed: AssertionError "the production default git timeout is 5 s". |
| `S8: a run carries the label and kind of its own recorded definition, not the registry's ([P22], [L2])` | In `buildDigest` take the kind from a constant instead of the run (`kind: node.kind → kind: 'worker'`, `dispatchSteps.ts:60`). The recorded `launch_a` is `kind: 'review'` while the registry's `MIN_NODES` says `worker`, so an implementation that reads the registry's kind fails. Confirmed: fail 1. |
| `S9: every git argv the reader issues is read-only (an allowlist of exact shapes, abbreviations rejected)` | Revert the test's `isReadOnlyGit` writing-option check from the prefix rule (`WRITING_OPTIONS.some(name => name.startsWith(long[1]))`) to exact-name matching (`.includes(long[1])`). The new assertions `['symbolic-ref','--dele','HEAD']` and `['log','--outp=/x']` then pass the read-only proof and the test fails. Confirmed: fail 1. |
| `S9: no absolute path appears in either route's whole JSON; per-run and workflow-level error paths are redacted ([L8], [P8])` | Forward the swallowed `readdir` error at `dispatchSteps.ts:143` (`message: redactPaths('…') → message: (error as Error).message`). A second workflow whose `runs_root` is a regular file ([P34]) makes `readdir` throw ENOTDIR with an absolute path; the scan of both routes' whole JSON then catches it. Confirmed: fail 1. (Today's code returns a fixed text, so the scan passes.) |
| `S9: an unreadable run is cached by fingerprint and warn-logged once across warm and two overview requests` | Cache digests only, not errors (`dispatchSteps.ts:128`, `resolved.type !== 'skip' → resolved.type === 'digest'`). The corrupt run then reloads and warn-logs on every request, so the warn count (mocked on `app.log.warn` before `app.ready()`, counting only `'Run digest could not be read'`, design-challenge note 6) exceeds 1. Confirmed: fail 1. |
| `S9: the GraphQL query orders PRs and issues, and state() maps every Appendix A field (draft and labels by value) and parses with the contract` | Drop the draft mapping (`draft: Boolean(node.isDraft) → draft: false`, `dispatchGithub.ts:149`) or the issue-label mapping (`labels: (…).map(…) → labels: []`). The fixture's draft PR and labelled issue then mismatch the by-value assertions. Confirmed: fail 1 for each. |
| `S9: runner mode writes only the GitHub cache file — nothing else under HOME or the working directory` | Add a stray write to `join(homedir(), '.cache', …)` in `writeCache` (`dispatchGithub.ts`). The test builds the reader from `githubReaderOptions` with an isolated HOME (set on `process.env.HOME`, which `os.homedir()` reads on POSIX) and an injected runner, `chdir`s into a fresh working directory, and lists every file recursively under both before/after; the stray write appears and the listing differs. Confirmed: fail 1, **and the real `~/.cache` was not touched** (design-challenge note 4). |
| `S9: landings are null (never false) with a missing origin ref and with no local default branch` | Strengthened to ask about a **real object** in the clone (the detached-HEAD commit) rather than a made-up sha, so the `on_default: null` is attributable to the missing local default branch, not a missing object ([L11]). Its falsifying guard is the S1 `localDefaultExists` logic (`dispatchGit.ts:167, 216`): returning `false` instead of `null` when the local default is absent fails the assertion. Confirmed: `on_default = … ? await ancestor(…) : null → : false` (`dispatchGit.ts:216`) fails with AssertionError "no local default branch is null, not false, even for an object the clone has", `false !== null`. |

## Run 004 (S11): every `S5:`–`S9:` test's hand-break re-run, with its command and failing assertion

Run 004 is docs-only: this table is the only change to `server/*.ts` besides the one [P18]-test fix named below.
For each `S5:` to `S9:` title in `server/dispatch.test.ts` (there is no `S4:` title any more — the old S4 tests are
S9), the realistic regression was made by hand in this worktree, the one test run with the command shown, seen to
fail, and the break reverted; the final diff carries no production break ([L14], [L15]). Each command was checked on
the unbroken tree to report `# tests 1` / `# pass 1` (one test selected); the patterns avoid regex metacharacters and
end before any apostrophe so the single-quoted shell argument is safe (design-challenge note 3). The [P18] test was
rewritten (the one allowed `server/dispatch.test.ts` fix, S11): the pre-read is dropped so the unawaited start cycle
performs the first read; the test polls (bounded ~2 s) until `calls` reaches 1, adds one `setImmediate`, then advances
its own mutable gh clock past the refresh window so the repository is due; it was renamed because "inside the refresh
window" no longer fit. It passed 10 targeted runs in a row unbroken, and the single break `await github.refreshDue()`
in the overview handler failed the `calls` assertion in all 10 ([L15]).

| Test (verbatim title in `server/dispatch.test.ts`) | Hand-break (the realistic regression) | Command | Failing assertion (quoted) |
|---|---|---|---|
| `S7: realGitRunner and realGhRunner spawn execFile the way production does — default timeouts 5000/20000, no shell, the env` | `realGitRunner(timeoutMs = 5000 → 6000)` (`server/dispatchGit.ts:53`); equivalently `GH_TIMEOUT_MS = 20_000 → 30_000` (`dispatchGithub.ts:33`) | `npx tsx --test --test-name-pattern 'S7: realGitRunner and realGhRunner spawn execFile the way production does' server/dispatch.test.ts` | `AssertionError: the production default git timeout is 5 s` — `6000 !== 5000` |
| `S5: both routes answer GET and HEAD; every other method is 405 with an Allow header` | `const READ_METHODS = 'GET, HEAD' → 'GET'` (`server/dispatch.ts:22`), so the 405 `Allow` header drops HEAD | `npx tsx --test --test-name-pattern 'S5: both routes answer GET and HEAD' server/dispatch.test.ts` | `AssertionError: Allow on POST /api/dispatch/projects` — `'GET' !== 'GET, HEAD'` |
| `S5: updated_at is the remote-tracking reflog entry time, not FETCH_HEAD` | Read the reflog of `FETCH_HEAD` instead of `originRef` (`server/dispatchGit.ts:176`), i.e. dating by a fetch marker, not origin/<d> | `npx tsx --test --test-name-pattern 'S5: updated_at is the remote-tracking reflog entry time' server/dispatch.test.ts` | `AssertionError: updated_at equals the origin/main reflog entry time` — actual `null`, expected `'2026-05-05T08:00:00.000Z'` |
| `S5: origin/HEAD naming dev outranks a local main` | Resolve the default branch from `HEAD` instead of `refs/remotes/origin/HEAD` (`server/dispatchGit.ts:157`), so the local main wins | `npx tsx --test --test-name-pattern 'S5: origin/HEAD naming dev outranks a local main' server/dispatch.test.ts` | `AssertionError: origin/HEAD outranks the local main` — `'main' !== 'dev'` |
| `S5: a route request never triggers a gh read, even when a repository is due ([P18])` | Add `await github.refreshDue()` at the top of the overview handler (`server/dispatch.ts`, `scope.get(paths.overview …)`) — a request-driven read | `npx tsx --test --test-name-pattern 'S5: a route request never triggers a gh read' server/dispatch.test.ts` | `AssertionError: a request never triggers or waits for a gh read` — `2 !== 1` |
| `S5: githubReaderOptions honours MD_MANAGER_GITHUB=off and reads a fixture file` | `env.MD_MANAGER_GITHUB === 'off' → === 'disabled'` (`server/dispatchGithub.ts:367`), so `off` is no longer honoured | `npx tsx --test --test-name-pattern 'S5: githubReaderOptions honours MD_MANAGER_GITHUB' server/dispatch.test.ts` | `AssertionError: Expected values to be strictly equal` — `'runner' !== 'off'` |
| `S5: the steps route returns the newest 50 runs, newest first` | `runs.sort(compareRuns) → runs.sort(compareRuns).reverse()` (`server/dispatchSteps.ts:156`), so `.slice(0, 50)` keeps the oldest 50 | `npx tsx --test --test-name-pattern 'S5: the steps route returns the newest 50 runs' server/dispatch.test.ts` | `AssertionError: the newest 50 runs, newest first` — actual begins `'run-000', 'run-001', …` not `run-054 … run-005` |
| `S8: a run carries the label and kind of its own recorded definition, not the registry's ([P22], [L2])` | `kind: node.kind → kind: 'worker'` in `buildDigest` (`server/dispatchSteps.ts:60`), i.e. kind from a constant, not the recorded node | `npx tsx --test --test-name-pattern 'S8: a run carries the label and kind of its own recorded definition, not the registry' server/dispatch.test.ts` | `AssertionError: the step kind comes from the run's recorded definition, not the registry's worker` — `'worker' !== 'review'` |
| `S9: an unreadable run is cached by fingerprint and warn-logged once across warm and two overview requests` | Cache digests only, not errors: `resolved.type !== 'skip' → resolved.type === 'digest'` (`server/dispatchSteps.ts:128`) | `npx tsx --test --test-name-pattern 'S9: an unreadable run is cached by fingerprint and warn-logged once' server/dispatch.test.ts` | `AssertionError: the corrupt run is loaded once, then served from the fingerprint cache` — `3 !== 1` |
| `S9: every git argv the reader issues is read-only (an allowlist of exact shapes, abbreviations rejected)` | Test-only helper: revert the prefix rule to exact-name matching — `WRITING_OPTIONS.some(name => name.startsWith(long[1])) → WRITING_OPTIONS.includes(long[1])` (`server/dispatch.test.ts` `isReadOnlyGit`) | `npx tsx --test --test-name-pattern 'S9: every git argv the reader issues is read-only' server/dispatch.test.ts` | `AssertionError: symbolic-ref --dele abbreviates --delete` — `true !== false` |
| `S9: runner mode writes only the GitHub cache file — nothing else under HOME or the working directory` | Add a stray `mkdirSync(join(homedir(), '.cache'), …); writeFileSync(join(homedir(), '.cache', 'stray'), …)` in `writeCache` (`server/dispatchGithub.ts:248`) | `npx tsx --test --test-name-pattern 'S9: runner mode writes only the GitHub cache file' server/dispatch.test.ts` | `AssertionError: the only new file anywhere under HOME or the working directory is the cache file` — `added` lists `…/home-0/.cache/stray` beside the cache file (the real `~/.cache` is untouched: HOME is the temporary root) |
| `S9: landings are null (never false) with a missing origin ref and with no local default branch` | `on_default = … ? await ancestor(…) : null → : false` (`server/dispatchGit.ts:216`), so an absent local default reads false, not null | `npx tsx --test --test-name-pattern 'S9: landings are null' server/dispatch.test.ts` | `AssertionError: no local default branch is null, not false, even for an object the clone has` — `false !== null` |
| `S9: the GraphQL query orders PRs and issues, and state() maps every Appendix A field (draft and labels by value) and parses with the contract` | `draft: Boolean(node.isDraft) → draft: false` (`server/dispatchGithub.ts:149`); equivalently drop the issue-label mapping | `npx tsx --test --test-name-pattern 'S9: the GraphQL query orders PRs and issues, and state' server/dispatch.test.ts` | `AssertionError: a draft PR maps draft:true (guards the isDraft mapping)` — `false !== true` |
| `S9: no absolute path appears in either route's whole JSON; per-run and workflow-level error paths are redacted ([L8], [P8])` | Forward the swallowed `readdir` error: `} catch {` → `} catch (error) {` and `message: redactPaths('The run storage…') → (error as Error).message` (`server/dispatchSteps.ts:143`) | `npx tsx --test --test-name-pattern 'S9: no absolute path appears in either route' server/dispatch.test.ts` | `AssertionError: an absolute path reached the steps response` |

All fourteen distinct `S5:`–`S9:` titles in the file are covered (six `S5:`, one `S7:`, one `S8:`, six `S9:`). Every
break above was reverted; `git status` after Run 004 shows only `docs/handoff/projects-dispatch-server.md` changed and
the [P18] rewrite in `server/dispatch.test.ts`.

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
| `server/dispatch.test.ts` | 46 tests, all in `npm run test:unit` |
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

1. **The runners take an injected `ExecFileLike`, not a `node:child_process` mock, so the default `execFile` binding is
   unproved; and the real `gh` path is not exercised by any check (review-003.md:20, review-003.md:27, review-002.md:39
   part 3; design-challenge note 12, Acts: operator; stays open per [L6]).** Unit tests inject the runner; the candidate
   phase and critique app use the fixture. The query text (`GITHUB_QUERY`), argv (`githubArgv`) and the spawn options
   (argv array, no shell, the 20 s timeout, and `env: { ...process.env }` so
   `GH_TOKEN`/`GH_CONFIG_DIR`/`XDG_CONFIG_HOME`/`HOME`/`PATH` reach gh) are unit-tested with an injected `ExecFileLike`
   in `S7: realGitRunner and realGhRunner spawn execFile the way production does — default timeouts 5000/20000, no shell, the env`.
   But because S7 injects an `ExecFileLike` rather than mocking `node:child_process` (which [L9] asked for), the default
   `execFile` binding (`dispatchGit.ts:53`, `dispatchGithub.ts:41`) is itself unproved, and no check runs the real `gh`
   against live GraphQL. Before or right after integration, run the exact query once with the host's `gh` against one
   registered repository and confirm it parses into every Appendix A field, then record the result here. `viewer_login`
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

### Open server P2s from review-002.md and review-003.md (S13)

Every `lane server` finding of `review-002.md` and `review-003.md` is filed below: still open (runs 003 and 004 do
not fix it), or fixed in run 003 with the S-item that fixed it. Run 004 is docs-only, so it fixes none of the open
ones. Each is cited by its source line.

Still open (runs 003 and 004 do not fix these):

- **The runners inject an `ExecFileLike`, not a `node:child_process` mock, so the default `execFile` binding is unproved**
  — `review-003.md:20` ([P2 general, lane server]); the same gap is `review-002.md:39` part 3 ([P2 coverage, lane
  server]), and [L9] asked for a `node:child_process` mock. Carried as open item 1 above.
- **No executed check spawns the real `gh` and parses a live GraphQL response into every Appendix A field; `origin.updated_at`
  on a reftable clone is not exercised** — `review-003.md:27` ([P2 coverage, lane server]). Carried as open items 1 and 3
  above.

Fixed in run 003 (with the S-item that fixed it; the S-item's full test title and the confirmed hand-break are in the
run-003 table above):

- `review-002.md:11` ([P1 general, lane server], the spawn test did not guard the production timeouts) and its
  lane-review twin `review-002.md:69` — fixed by **S7**: the runners are called with production arguments and
  5000/20000 asserted.
- `review-002.md:12` ([P1 general, lane server], recorded-definition kind from the wrong source) and its lane-review
  twin `review-002.md:70` — fixed by **S8**: the recorded `kind: 'review'` differs from the registry's `worker`.
- `review-002.md:19` ([P2 general, lane server], the read-only allowlist accepts abbreviated writing options), its
  lane-review twin `review-002.md:68`, and part 1 of `review-002.md:39` — fixed by **S9**: the prefix rule rejects
  `--dele`/`--outp`.
- `review-002.md:38` ([P2 coverage, lane server], the warn-once count was untested) — fixed by **S9**: the warn count
  is asserted to be 1 (the old S4 test is now the S9 unreadable-run test).
- `review-002.md:39` part 2 ([P2 coverage, lane server], the spawn test passed the timeouts explicitly) — fixed by
  **S7** (same as `review-002.md:11`).
- `review-002.md:40` ([P2 coverage, lane server], the write test listed only the cache directory) — fixed by **S9**:
  every file under HOME and the working directory is scanned.
- `review-002.md:41` ([P2 coverage, lane server], the path scan covered one route and the workflow-level error
  redaction was untested) — fixed by **S9**: both routes' whole JSON are scanned and the workflow-level error checked.
- `review-002.md:42` ([P2 coverage, lane server], Appendix A mapping asserted only at default values) — fixed by
  **S9**: draft and issue labels by value.
- `review-002.md:43` ([P2 coverage, lane server], recorded kinds equalled the registry's) — fixed by **S8** (same as
  `review-002.md:12`).
