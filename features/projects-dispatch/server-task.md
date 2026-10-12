# Server worker, run 005: finish the server handoff (PRD_PROJECTS_DISPATCH)

## Goal

**Run 005 (follows projects-dispatch-004).** Run 004's candidate d688375 passed every check and its lane review (no findings); its independent review never ran: Claude subscription access failed for every session on 2026-10-11 18:44-18:52 UTC and the reviewer deadline ran out ([L16]). Your prompt first restores your owned paths at d688375, which is run 004's finished work for the items below. Check each acceptance line against the restored files and change only what fails it; an unchanged restore is the expected outcome. Say in the completion what you checked.

Run projects-dispatch-003's code passed every check, both lane reviews and the critique; its independent review blocked only on the handoffs (`features/projects-dispatch/review-003.md`). Your base is 003's candidate. Change `docs/handoff/projects-dispatch-server.md` only, unless a test turns out not to fail when you break its behaviour (then fix the test and say so).

1. **S11 (P1, S10 of run 003) Every S5 test names its hand-break.** For each of these tests in `server/dispatch.test.ts`, break the behaviour it guards by hand in your worktree, run the test, see it fail, undo the break, and write in the handoff the exact change and the failure line it produced:
   - `S5: both routes answer GET and HEAD; every other method is 405 with an Allow header`;
   - `S5: updated_at is the remote-tracking reflog entry time, not FETCH_HEAD`;
   - `S5: origin/HEAD naming dev outranks a local main`;
   - `S5: a route request inside the refresh window never calls the runner ([P18])`;
   - `S5: githubReaderOptions honours MD_MANAGER_GITHUB=off and reads a fixture file`;
   - and any other `S4:`/`S5:`/`S7:`/`S8:`/`S9:` test in the file whose break the handoff does not yet name.

   The break must be the realistic regression, not an artificial one. For `S5: a route request inside the refresh window never calls the runner ([P18])` that is a route handler calling `github.refreshDue()` (or `void github.cycle()`) per request: with today's fixed clock that break does not fail, so change the test so the repository is due when the requests arrive, and rename it if its name no longer fits. `createApp`'s `onReady` fires the start cycle without awaiting it (`server/app.ts`, `server/dispatchGithub.ts` `start()`), so after `await app.ready()` first poll until the start read has happened (`calls` reaches its expected value) and give it one more `setImmediate`; only then advance the mutable clock past `refreshMinutes`, take `before` and inject. The single break is `await github.refreshDue()` in the overview handler. Done when the unbroken test passes 10 targeted runs in a row and that break fails the `calls` assertion in every one ([L14], [L15]). The handoff gets a Run 004 table with one row per `S5:` to `S9:` title in the file (re-run every break, the run-002 and run-003 ones included; there is no `S4:` title any more, the old S4 tests are S9): the change, the command `npx tsx --test --test-name-pattern '<regex-escaped title or a unique metacharacter-free prefix>' server/dispatch.test.ts` (titles hold regex metacharacters such as `([P18])`; check that the command reports `# tests 1` and `# pass 1` on the unbroken tree), and the failing assertion's message quoted ([L15]).
2. **S12** Correct the handoff's stale names: open item 1 still cites `S5: realGitRunner and realGhRunner spawn execFile …`, now `S7: …`. Every test name the handoff cites matches `server/dispatch.test.ts` exactly: the names cited in the run-002 and run-003 sections (cut with `…`, or retired labels such as "S5 path" and "S5 read-only") are replaced with the full verbatim titles, the prose otherwise unchanged; the S9 landings row gets a confirmed failure line. Done when no backticked `S<n>:` name in the handoff is anything but a full test title.
3. **S13 (P1) The server handoff keeps every open server P2.** List as open, each with its source line, every server P2 of `review-002.md` and `review-003.md` that runs 003 and 004 do not fix, starting with review-003.md's `node:child_process` gap (S7 injects an `ExecFileLike`, so the default `execFile` binding is unproved); reword open item 1 to say the runners take an injected `ExecFileLike`, not a `node:child_process` mock. A P2 that run 003 fixed goes under "fixed in run 003" with the item that fixed it. Done when each open server P2 appears with its source ([L14]).

## Context

- Read `docs/handoff/projects-dispatch-server.md`, `server/dispatch.test.ts` and `review-003.md` first. The run-002 and run-003 sections of the handoff stay; add a "Run 004" section with the table of breaks (test name, the change, the failing assertion).
- A lane reviewer (GPT 6.1) reads your diff after your checks pass.

## Constraints

- Owned paths only (policy.json `server`); in practice `docs/handoff/projects-dispatch-server.md`, and `server/dispatch.test.ts` only where a test cannot fail on its realistic regression (the [P18] test, S11). Leave every hand-break undone: the final diff has no change to `server/*.ts` other than such a test fix.
- No new dependency; no change to Appendix A.

## Acceptance

- The handoff's Run 004 table names a hand-break, its command and its failure line for every `S5:` to `S9:` test in `server/dispatch.test.ts`; every test name it cites exists verbatim; every open server P2 of review-002.md and review-003.md is listed (S13).
- `frontend-build`, `frontend-lint`, `shared-contract` and `frontend-unit` pass.

Run the tests you break one at a time with targeted runs, then this lane's non-browser policy checks once before writing the completion.

## Stop

Stop and report `question` when a test cannot be made to fail without changing code outside your owned paths.
