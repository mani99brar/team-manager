# Server worker, run 003: make the dispatch API's tests guard what they claim (PRD_PROJECTS_DISPATCH)

## Goal

Runs projects-dispatch-001 and 002 built and fixed the read-only dispatch API, and it is in your base (cb5af748, run 002's candidate): `server/dispatch*.ts`, `contracts/projects/dispatch.ts`, `server/dispatch.test.ts`, `docs/handoff/projects-dispatch-server.md`. Run 002's independent review blocked the candidate on the viewer; on the server it found no behaviour bug, only tests that would still pass if the behaviour they guard broke. `features/projects-dispatch/review-002.md` holds every finding verbatim. This run changes tests and the handoff only, unless a test you write exposes a real bug (then fix the code too and say so in the handoff).

1. **S7 (P1) The spawn test guards the production timeouts.** `server/dispatch.test.ts` ("S5 spawn", about lines 785-821) passes 5000 and 20_000 to `realGitRunner(5000, fakeGit)` and `realGhRunner('gh', 20_000, fakeGh)`, while production calls `realGitRunner()` (`server/index.ts`, `server/dispatch.ts`) and `realGhRunner(env.MD_MANAGER_GH || 'gh')` (`server/dispatchGithub.ts`) and relies on the defaults. Call each runner the way production does, with the default timeout (`realGitRunner(undefined, fakeGit)`, `realGhRunner('gh', undefined, fakeGh)`), and assert the `execFile` options carry 5000 and 20000. Done when changing either default (or removing it) fails the test.
2. **S8 (P1) The recorded-definition test tells the run's kind from the registry's.** "S5: a run carries the label and kind of its own recorded definition" (about lines 990-1007) records the same kinds the registry's `MIN_NODES` has, so a kind taken from the registry passes. Give the recorded definition a node whose recorded `kind` differs from the registry's for the same node id (recorded `kind: 'review'` for `launch_a`, where the registry says `worker`; `repair` is not a valid node kind, `contracts/projects/v1.ts`, and an invalid kind would turn the run into an error) ([L12]), and assert both `label` and `kind` come from the run ([P22], [L2]). Done when taking `kind` from the registry fails the test.
3. **S9 The other S5 proofs, tightened** (P2s of run 002's review and lane review):
   - `isReadOnlyGit` (about lines 758-783) rejects any long option that is an unambiguous prefix of a writing option (`--dele` for `--delete`, `--outp=` for `--output`), not only the exact names; a test feeds it `['symbolic-ref', '--dele', 'HEAD']` and `['log', '--outp=/x']` and expects a rejection.
   - The path scan covers both routes' whole JSON: `/api/dispatch/projects` as well as `/api/dispatch/projects/<p>/steps`, including a workflow-level `error` whose loader message holds a path.
   - S4 counts the warn calls too: two overview requests, one warning for the corrupt run.
   - The GraphQL fixture has one draft PR and one issue with labels, and the mapping asserts `draft: true` and the labels by value.
   - "Runner mode writes only the GitHub cache file" lists every file, recursively, under the test's temporary HOME and a fresh temporary working directory before and after, not only the cache directory. Build the reader from `{ ...githubReaderOptions({ HOME: tmpHome, MD_MANAGER_GITHUB_CACHE: join(tmpHome, 'c', 'github.json') }, now), runner: async () => ghOk() }` (the exported options function `server/index.ts` uses, with an injected runner, so no real `gh` is spawned with the real HOME), and `process.chdir` into the temporary working directory for that test only, restoring it after (the repository worktree is shared with parallel test processes). Done when the listings differ only by the cache file ([L12]).
   - "No local default branch gives null" uses an existing object (a real commit sha in the clone), so the null comes from the missing branch, not a missing object.
4. **S10 The handoff.** Update `docs/handoff/projects-dispatch-server.md`: what run 003 changed, and for every S5 to S9 test the change you made by hand to see it fail ([P37]); keep the open P2s (the untested real `gh` path, which the operator's tryout checks; reftable).

`docs/PRD_PROJECTS_DISPATCH.md` sections 2, 5 and 7 and Appendix A remain the specification; `features/projects-dispatch/decisions.md` wins where they differ. Appendix A stays frozen ([L4], [L10]).

## Context

- **Your base already has the API and its tests.** Read `server/dispatch.test.ts`, `server/dispatchGit.ts`, `server/dispatchGithub.ts`, `server/dispatchSteps.ts`, `server/index.ts` and the handoff before changing anything.
- **Run-controls routes:** `/api/run-controls` (`server/controls*.ts`) is not yours. Do not change it.
- **Tests** create every repository with `git init -b main` (`--initial-branch=main` for a bare one) and commit with explicit `-c user.name=… -c user.email=…`, since `HOME` is isolated. They isolate every path under a temporary directory and `HOME`, with an injected clock and an injected `gh` runner. Never touch the real `~/.config/md-manager/`, `~/.cache`, `~/.local/state` or any real repository.
- **A lane reviewer** (GPT 6.1) reviews your lane's diff after your checks pass, before the candidate. A P0/P1 from it starts one repair round of your lane, and repairs are scarce (three per run), so make each test fail on the regression it names before you complete, and say how in the handoff.
- **The viewer lane** works in parallel on the pages. Do not rename, remove or retype a field.

## Constraints

- Owned paths only (policy.json `server`). Do not touch `src`, `tests/project-workflows`, `tests/unit`, `server/projectRoutes.ts`, `server/projects.ts`, `server/projectsConfig.ts` or the run-controls files. A change you cannot avoid is a `question` completion.
- No behaviour change unless a test exposes a bug; GET and HEAD only; no write anywhere except the GitHub cache file; no `git fetch`, `pull`, `push`, `gc`, `checkout` or any command that writes; no shell.
- No new dependency. No change to Appendix A's shapes.

## Acceptance

- S7, S8 and each S9 test pass on the base's code and fail when the behaviour they guard is broken by hand (the handoff names the change for each, S10); name each test after its item (`S7: …`, `S8: …`, `S9: …`), replacing the S5/S4 test it supersedes.
- The 001 and 002 tests still pass, and `contracts/projects/contract.test.ts` still validates the examples.
- `docs/handoff/projects-dispatch-server.md` is updated (S10).
- `frontend-build`, `frontend-lint`, `shared-contract` and `frontend-unit` pass.

Run targeted tests while iterating, then this lane's non-browser policy checks once before writing the completion.

## Stop

Stop and report `question` in either case:
- a fix needs a change to `server/projects.ts`, `server/projectRoutes.ts` or `server/projectsConfig.ts`;
- a fix needs a change to Appendix A's shapes.

Do not add routes, do not fetch, and do not write anywhere but the GitHub cache.
