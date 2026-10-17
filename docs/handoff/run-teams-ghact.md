# Handoff: run-teams lane B2, GitHub actions and the note control (`rt/ghact`)

## What I built

1. **Controller `workflow github`** (`workflow/github.py`, dispatched from `workflow/__main__.py`). Four subcommands on a run's branch, each `<run> --repo <checkout> ... --by operator|maintainer` (the panel is refused):
   - `push --sha S`: only an integrated run (run-state.json `integrated_commit`, no next step) or an accepted one (`accepted.json`). The branch is `plan.source_branch`, a valid ref name, not origin's default (`refs/remotes/origin/HEAD`) nor main/master/dev/develop. `refs/heads/<b>` must be at S (12+ hex prefix). `git ls-remote origin` must show the branch absent or at an ancestor. Then `git push --porcelain --end-of-options origin <full sha>:refs/heads/<b>`. It never forces.
   - `pr --base B --title T --body-file F`: the remote branch must be at the local head, and `gh pr list --repo o/n --head <b> --state open --json number` must be empty. Then `gh pr create --repo o/n --head <b> --base B --draft --title T --body-file F`, and it prints the URL. The title is 1-256 characters on one line; the body file must be at most 60000 bytes.
   - `ready --pr N`: `gh pr view N --repo o/n --json headRefName,isCrossRepository,isDraft,state` must show the run branch, same repository, OPEN and draft. Then `gh pr ready`.
   - `reviewers --pr N --add a,org/team`: logins or `org/team` slugs, at most 15, deduplicated. The PR must be the run branch's and OPEN. Then `gh pr edit N --repo o/n --add-reviewer ...`.
   - Shared rules:
     - `--repo` must share its Git common directory with `plan.repository` while that checkout exists.
     - origin must use one of the three github.com URL forms. It is read with `git config remote.origin.url`, so `insteadOf` is not applied.
     - git and gh run as argv lists with `GIT_TERMINAL_PROMPT=0` and `GH_PROMPT_DISABLED=1`. gh is `MD_MANAGER_GH` or `gh`. Hooks are off through `controller_git_config`.
     - URL credentials are cut from everything printed and recorded.
     - A refusal is one `Blocked: ...` line on stderr with exit 2. A git or gh write that fails after every check passed prints `Failed: ...` and exits 1.
     - Each invocation that names a run appends one line to `<run>/github-actions.jsonl`: time, action, actor/via, args (never the body text, only `body_bytes`), exit, url, reason. The run's `github.lock` is held for the duration (non-blocking: a second action is refused).
2. **Server: `server/githubActions.ts`** holds the pure parts: the offers, the state token, the parameter checks, the argv and its redacted display, the default title and body from `contracts/projects/summary.ts`, and the `GithubRecordStore`. **`server/controls.ts`** registers the routes inside the run-control scope (guards 1-4 and the pairing token apply):
   - `GET /api/run-controls/:p/:w/:r/github` returns `runGithubActionsSchema`.
   - `POST /api/run-controls/:p/:w/:r/github/:action_id` takes `githubActionRequestSchema` and returns `githubActionResponseSchema`.
     - Order of checks: request_id dedupe, the shared one-in-flight-per-run `BUSY` (shared with the controls), `STATE_CHANGED`, `NOT_AVAILABLE`, then `INVALID_PARAMS`.
     - It runs through `Runner.start` as a short child (same spawn path, env, cwd, 5-minute bound and output redaction). Records go to `<state>/<p>/<w>/<run>.github.jsonl`. The `url` is the first `https://github.com/...` in the output of a successful command, and `markDue` is called after a success.
     - The `open_pr` body goes into a mode-600 file `<state>/<p>/<w>/<run>.<g-id>.body.md`, which is removed in a `finally`. Records keep `body_chars`.
   - `server/controlsRunner.ts` change: `redactLine` now also cuts `scheme://user:secret@` credentials, which applies to every control's output.
3. **The note control** (steering) is the 15th control. `CONTROLS_VERSION` goes from 1.1.0 to 1.2.0 and `note` is appended last.
   - argv: `-m workflow note <run> <lane> --by operator -- <text>`. `--` keeps a text such as `--help` as data; `note`'s argparse takes the text positionally.
   - The text is 1-4000 characters (raised from 2000 by the review fixes). The effect and not_effect texts are the ones the brief gives.
   - Offer: lanes with a receipt and no stop, handoff or completion file; not frozen (no `snapshots.json`, no closed `sidecar.ledger.json`); no waiting question; not abandoned or accepted; and a Herdr pane, as for Answer.
   - Reasons, in order: "The run was abandoned", "The run was accepted by the operator", "The workers are frozen: a note reaches a lead only before freeze", "No lane's worker is launched and still working", "Every working lane waits on a question; answer it instead", NOTE_PANE_REASON.
   - The control does not wait for the supervisor to stop.
4. **Docs:**
   - `workflow/README.md`: a command row for `github`, and the run-controls row mentions note and the GitHub actions.
   - `workflow/RUNBOOK.md`:
     - a new "GitHub actions" section (before "Attention notifications");
     - a note row in the run-controls table, with `note` removed from "What stays in the terminal";
     - the three "never pushes" sentences now read "never pushes on its own".
   - `docs/PRD_RUN_CONTROLS.md`: an amendment for note and the GitHub family.

## Files

- New: `workflow/github.py`, `workflow/test_github.py`, `server/githubActions.ts`, `server/githubActions.test.ts`, this handoff.
- Changed:
  - `workflow/__main__.py`, `workflow/README.md`, `workflow/RUNBOOK.md`
  - `server/controls.ts`, `server/controlsRunner.ts`, `server/controls.test.ts`
  - `contracts/projects/controls.ts`, `contracts/projects/examples.ts` (controls part: a `note` base, version 1.2.0, a `steering` state, and the reasons note now gets in `needsReconciliation`, `recovery`, `abandoned` and `finished`), `contracts/projects/contract.test.ts` (controls assertions)
  - `src/projects/controls/types.ts` (`ControlId`, version, `CONTROL_ORDER`)
  - `tests/unit/controls.test.ts` (count 15)
  - `tests/project-workflows/fixtures/controls.ts` (the note entry in the worker-phase catalog, version 1.2.0)
  - `tests/project-workflows/controls.spec.ts` (count 14 to 15)
  - `docs/PRD_RUN_CONTROLS.md`
- The controls schemas are not exported to JSON (`export.ts` exports only schemas/dispatch/github), so no `*.schema.json` changed. I ran `npm run contracts:export`; it produced no diff.

## How it is tested

| Command | Result |
|---|---|
| `.venv/bin/python -m unittest workflow.test_github -v` | 21 tests OK: a real push into a temp bare repo, the fake gh's argv asserted exactly, every refusal, the lock, the record, credential scrubbing, and dispatch through `python -m workflow github` |
| `.venv/bin/python -m unittest workflow.test_attention_notify workflow.test_github` | 43 OK (README/RUNBOOK text checks still pass) |
| `npx --no-install tsx --test server/githubActions.test.ts server/controls.test.ts` | 64 pass, 0 fail |
| `npx --no-install tsx --test tests/unit/controls.test.ts tests/unit/runSummary.test.ts` | 26 pass |
| `npm run test:contracts` | 58 pass |
| `npx --no-install tsc -b` | clean |
| `npx --no-install eslint` on every changed TS file | clean |
| project-workflows `controls.spec.ts`, candidate phase | 9 passed, 1 skipped |
| project-workflows `controls.spec.ts`, worker phase | 10 passed |

`workflow.test_notes` does not exist. The note control's behaviour is covered by `server/controls.test.ts` `[note]` and by the controller's own existing note tests.

What the server tests cover:
- the offers matrix: flag off, controls off, PUBLIC/PRIVATE/unknown confirm, READ permission, GitHub pending, run not integrated, not pushed, pushed, PR open draft or ready, a missing or failing source;
- the exact argv for each action;
- the guards on the new routes;
- STATE_CHANGED, BUSY (shared in-flight), request dedupe, typed repo mismatch and parameter bounds;
- the body file's mode 600 and its removal after both success and failure;
- the record validated against the contract, the URL extracted, markDue only on success;
- redaction of a token URL and the home path, and the 40-line cap.

## What the integrator must wire

1. **`server/app.ts`** (not my file):
   - pass the GitHub source into the controls scope: extend `AppOptions.controls` with `github?: GithubSource` (and optionally `githubActions?: boolean`);
   - change the register call to `app.register(controlRoutes, { prefix: CONTROLS_PREFIX, store, setup, runner, now, github: options.controls?.github ?? <the ghread lane's source> })`.

   The source is `{ read(projectId, workflowId, runId): Promise<RunGithub>; markDue(projectId, workflowId, runId): void; recentAuthors?(projectId): string[] | Promise<string[]> }`, built by the GitHub-read lane from its `RunGithub` builder and the GithubReader branch keys. `recentAuthors` should return the authors of the repo's PRs in the dispatch cache, which feed the reviewer suggestions. Without a source, every action is unavailable with "This dashboard has no run GitHub read to offer actions from".
2. **The flag.** `MD_MANAGER_GITHUB_ACTIONS` is read from `config.childEnv`, which is the server's env minus `CLAUDECODE`, so no change to `controlsGuard.ts` is needed. Add it to `server/index.ts` docs and to the dashboard service env when the operator wants it on.
3. **The viewer (UI lane).**
   - `note` is a plain lane+text control, which the existing ControlDialog already renders, as it does for Answer.
   - The GitHub view's client should call the two routes with the pairing-token header. It should:
     - pin the `state_token` from when the dialog opened;
     - send `confirm_repo` when `confirm === 'typed_repo'`;
     - render `defaults.title` and `defaults.body` in the dialog;
     - treat 409 STATE_CHANGED and BUSY like the controls do.
   - Commands display as `$PY -m workflow github <action> "$RUN" --repo ~/... --by operator`. This follows the controls style; the `teamExamples.ts` example uses `python -m workflow github push run-001 ...`, which is only an example.
4. **The summary's lane `team`** is always `null` in the default PR body. The store does not load teams; when the teams lane exposes a per-lane `{workflows, agents, failed}`, fill it in `summaryInput` (`server/githubActions.ts`).

## Known gaps and choices

- The brief said "no token 401". The run-control guard answers **403 TOKEN_REQUIRED** (as every control route does), and the tests assert that.
- `--by maintainer` is accepted by the controller (the brief says `operator|maintainer`), and the panel is refused. The page always passes `--by operator`. If publishing should be operator-only, add `github push`/`github pr` etc. to `actor.OPERATOR_ONLY` (actor.py is not my file).
- `ready` also reads `isCrossRepository`, so a fork's same-named branch is refused. That field is beyond the brief's three.
- The controller refuses a push when origin already has the head ("nothing to push"). The server does not offer push then anyway (`up_to_date`).
- The server's `isBranchName` is a conservative subset of `git check-ref-format`; the controller runs the real check.
- The note offer requires a Herdr pane, as Answer does. Without one, `workflow note` would record the note `undeliverable` and exit 1, so the control is not offered.
- I ran neither the full browser suite nor `workflow.run_tests`, only the two controls spec phases and the targeted suites above.
