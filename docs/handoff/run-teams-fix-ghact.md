# Handoff: run-teams fix-ghact (review-swarm fixes for the GitHub actions)

Branch `rt/fix-ghact`, based on f231656. Fixes the swarm findings F3.1-F3.9, F4.6 (controller side), F7.1-F7.8 and the note text limit
(report: scratchpad `swarm/backend-verify-175144/report.md`).

## What changed

- **Controller (`workflow/github.py`).** Every action takes the confirmed identities `--repo-name o/n --branch B --head <full sha>` and
  refuses on any mismatch: plan `source_branch` must be `--branch`; `refs/heads/B` must be at `--head`; origin's fetch URLs
  (`git remote get-url --all origin`) and push URLs (`--push --all`, so `pushurl`/`insteadOf`/`pushInsteadOf` apply) must all parse
  to one github.com repository equal to `--repo-name` (F7.1, F4.6, F3.3). `--sha` is gone (replaced by `--head`).
  - push: the head must equal or descend from the run's integrated commit (run-state `integrated_commit`, else the integrate
    event, else the accepted candidate) (F7.8); GitHub's default branch comes from `gh api repos/o/n --jq .default_branch`, with
    `refs/remotes/origin/HEAD` only when gh cannot tell, and neither known is a refusal (F7.2); `git push --porcelain
    --no-follow-tags --no-recurse-submodules` (F7.7).
  - pr: `--base` must equal GitHub's default branch (gh required); the remote head must be `--head`; fork PRs are filtered from
    the open-PR check (F7.4); the title goes to gh as `--title=T`.
  - ready/reviewers: `headRefOid` must equal `--head`, and the local branch too (F7.5, F3.4); `isCrossRepository` must be false.
  - Timeouts: reads share a 180 s budget (refusal when spent); a write gets 120 s and a timed-out write is `Unknown: ... may have
    been published; check GitHub`, exit 3, recorded with `outcome: "unknown"` (F7.3). A record append that fails prints a warning
    and never changes the outcome (F7.6).
- **Server (`server/githubActions.ts`, `server/controls.ts`, `server/controlsRunner.ts`).**
  - argv passes `--repo-name`, `--branch`, `--head` (full local sha) for all four actions, and `--title=<title>` as one element (F3.2-F3.4).
  - Offers: nothing is offered while `github.reason` is set (a failed refresh) (F3.7); push needs `github_sha` to agree with the
    tracking ref and `contains_integrated !== false` (F3.1, F3.8); open_pr needs `github_sha === local_sha`; ready/reviewers need
    the PR's `head_ref`/`head_sha` to be the run branch at its local head; every action needs a full 40/64-hex local sha.
  - State token adds the branch name, default branch, read status/reason, integrated facts and the PR head ref (F3.5).
  - Default body truncation is byte-aware (`truncateBytes`, at most 60000 UTF-8 bytes, cut on a code point) (F3.9).
  - The shown command shell-quotes every server-filled value (`shellQuote`, POSIX single quotes; `~/` stays unquoted) (F3.6).
  - GitHub children are bounded by `GITHUB_ACTION_TIMEOUT_MS` = 6 min (> 180 s + 120 s); a bound hit records the
    `Unknown: ...` note, and a bound hit or exit 3 marks the branch due (F7.3). `Runner.start` takes an optional timeout;
    `controlRoutes` takes `githubTimeoutMs` (tests only).
  - Note control: text max 4000 (PRD "Steering" `textSpec('text', 1, 4000)`; `workflow/notes.py` sets no limit of its own).
- Docs: RUNBOOK "GitHub actions" rewritten, the note row in "Run controls in the viewer" says 4000; README command row updated.

## Tests

- `.venv/bin/python -m unittest workflow.test_github`: 39 tests OK (git wrapper on PATH maps `remote get-url`'s bare path back to
  the GitHub URL; gh is the fake script).
- `npx --no-install tsx --test server/githubActions.test.ts`: 22 pass.
- `npx --no-install tsx --test server/controls.test.ts`: 50 pass, 2 fail, see below.
- `npx --no-install tsc -b` clean; eslint clean on the changed TS files.

## For the integrator

- **Out of this lane's owned paths, needed for the note limit:** `contracts/projects/examples.ts` lines 786 and 910 and
  `tests/project-workflows/fixtures/controls.ts` line 451 still say `max_length: 2000` for the note text; change them to 4000.
  Until then `server/controls.test.ts` "[contract] the served RunControls match the committed examples" and "[recovery] the 15
  controls ..." fail on that one number. `docs/handoff/run-teams-ghact.md` line 26 also still says 1-2000.
- The viewer (GitHub view) shows `action.command` as before; it now holds the full head sha and quoted values.
- The contract has no `unknown` record status: an exit 3 or a 6-minute stop is `failed` with the `Unknown:` line in `output_tail`.
  A UI may want to show that line prominently.
- F4.2/F4.3 (server default branch is a local guess) are runGithub.ts findings outside this lane; the controller now refuses a
  `--base` that differs from GitHub's default, so a wrong guess fails closed.
