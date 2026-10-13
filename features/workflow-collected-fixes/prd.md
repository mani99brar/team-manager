# PRD: workflow collected fixes

Feature `workflow-collected-fixes`, base 44b9c24 (2026-10-13). One lane, `engine` (Opus 5.5, medium), owning `workflow/`, `docs/BACKLOG.md` and `docs/handoff/ux-fixes-engine.md`. It is the engine part of the /cook of 2026-10-13 (decisions.md [O7], [O9]); the UI chain `ux-critique-fixes`, `-b`, `-c` runs beside it. Item ids are the intake's (`~/.local/state/cook/workflow-collected-fixes/intake/`): BL = docs/BACKLOG.md, GH = GitHub issue, RL = the run issues log. File:line pointers are at 44b9c24.

## Problem

The workflow controller has open defects that the operator has hit on real runs. Each one costs a run, an abandon or a hand-written fix:

- A worker that ends its turn by addressing the operator stalls as `blocked` until its deadline (BL3).
- A sidecar message can sit unsubmitted in a finished worker's input (RLD18).
- A design-challenge rerun makes the viewer fail the whole workflow's run list for minutes (GH12).
- The export marks verified steps failed from a stale error (GH3).
- node-gyp in any Node target's setup fails on the controller's venv (RLC12).
- The Claude panel provider runs out of budget on exactly the large changes it exists for (RLD20).
- The freeze step is silent for up to a minute (RLF1).
- A full disk, a missing Herdr pane or a broken setup is found only after the workers ran (RLG23, RLI19, RLF2).
- A follow-up from a checkout that already holds the fix reviews an empty diff (RLI17).
- A host failure needs one `retry` per lane (RLG24).
- A lane whose launch died has no recovery but abandon, which repeats the paid design challenge (RLI16).

## Goals

1. Fix the 13 controller items above in `workflow/`, each proven by a unit test in `.venv/bin/python -m workflow.run_tests`.
2. Write the Python side and the CLI shapes that the later server lane (`ux-critique-fixes-c`) builds on: `retry --all-failed`, `relaunch` with `--dry-run`, and the GH3 export rule. Pin them in "Interfaces for the server lane".
3. Keep the operator's documents true: RUNBOOK and README rows for every item, including the server-side items GH8 and RLI21; a RUNBOOK "Recovery without abandon" paragraph that closes RLF4; and BACKLOG items 1 and 3 removed.

## Non-goals (closed list; a reviewer finding that asks for one of these is out of scope)

- Any change under `server/`, `src/`, `tests/`, `contracts/`, `playwright.config.ts`, `package.json` or another feature's folder. The server halves move to `ux-critique-fixes-c` (decisions [O9]):
  - GH12's `server/projects.test.ts` load test;
  - GH3's optional viewer guard on `state.next`;
  - the run controls "Retry all failed checks" (RLG24) and "Relaunch a lane" (RLI16);
  - RLI21's `OOMPolicy=continue`;
  - GH8's root `testIgnore` and its policy check.
- Every UI/UX critique finding (M1-M36) and the phone items. GH4, GH6 and GH7 are server items for stage C.
- RLF2 part (b), a shared package cache per run. RLI16's automatic relaunch without the operator. RLD20's optional launch note about context size.
- A GH8 policy lint keyed on `src/App.tsx`. The workflow tool is portable (`workflow/test_portable.py`), so it never names one target's files.
- A new value in any closed schema under `contracts/workflow/`, which this lane does not own (see Constraints).

## Constraints

- **Owned paths:** `workflow`, `docs/BACKLOG.md` and `docs/handoff/ux-fixes-engine.md`. Freeze refuses anything else.
- **Closed schemas that stay as they are:**
  - `contracts/workflow/workerResult.schema.json` keeps `checks[].transient` as `const "memory"`.
  - `contracts/workflow/sidecar.schema.json` keeps its message `status` and `reason` enums.
  - `contracts/workflow/feature.schema.json` keeps panels `budget_usd` `default: 5`.
  - Every record the lane writes still validates against them.
- **Conventions:** Python standard library plus `workflow/requirements.txt`. Every module the lane touches keeps a docstring that cites the RUNBOOK section it implements.
- **Test isolation:** tests isolate every path under a temporary directory. They use fake `claude`, `herdr` and `git` remotes and never touch `~/.config/md-manager`, `~/.claude`, `~/.pi` or systemd. They never depend on the machine's free disk, memory or `HERDR_ENV`: patch `os.statvfs`, the environment and the clock.
- **Behaviour stays the same:** a run that hits none of these conditions behaves exactly as it does today. The same holds for the completion reader, the review, the sidecar's message rules and the panel's report-only contract.

## Requirements

Each item lists where it lands, the behaviour, and the acceptance tests. "Refused" means a non-zero exit with the quoted message and no change on disk.

### BL3: worker final turn

- **Where:** `workflow/automatic.py:144-190` (`completion_prompt`), reached by lane workers (`workflow/interactive.py:482-483`) and repair briefs (`workflow/repair.py:770`, `session_brief`).
- **Behaviour:**
  - Every completion version ends its shared return, after "finish your turn…" (:188), with: "End your final message without asking or telling the operator to do anything: a final message that waits on a human lists your session as blocked, the controller never accepts a completion from a blocked session, and the run stops at your deadline."
  - Inside the 1.1.0 block (:161), next to the `verify_yourself` description (:174): "Put any step for the operator in verify_yourself, never in your final message."
  - How completions are read stays unchanged (`automatic.py:488`).
- **Acceptance:**
  - `test_automatic`: `completion_prompt` for a lane contains the first sentence at 1.0.0 and at 1.1.0, and the second only at 1.1.0.
  - `test_repair` (near :1207): `session_brief` on a 1.1.0 plan contains both.
  - The portable-prompt tests still pass.

### GH3: export error only for pending tasks

- **Where:** `workflow/export_state.py:623`.
- **Behaviour:** `tasks[].error` is `str(task.error)` only when `task.name in state.next`, otherwise `None`. This is the rule the controller's own classifiers use (`automatic.py:1885` and the other sites; `repair.py:225`). `next` stays exported as it is.
- **Acceptance:** `test_export`: with `state.next=("verify_adapter",)` and errors on `verify_ui` and `verify_adapter`, the export has `verify_ui.error == None` and keeps `verify_adapter.error`. The export still validates against its schema.

### GH12: export right after the challenge re-pin

- **Where:** `workflow/guardrails.py:1348-1427` (`resume_challenge`: `repin` at :1423, `run_challenge` at :1427) and `resume_main`'s `export` helper (:1765-1768).
- **Behaviour:**
  - `resume_challenge` takes an export callback and calls it after `repin(...)` and before `run_challenge(...)`. While a rerun runs, `run-state.json` names the new `base_commit` and shows the challenge `running`.
  - Every other `repin(` caller that is followed by a long job does the same. At 44b9c24 `resume_challenge` is the only caller.
- **Acceptance:** `test_guardrails`:
  - Pause a challenge, edit a task file, `resume`, and stop the fake challenge job while `challenge.running.json` exists.
  - `run-state.json` `base_commit` equals `plan.json` `base_commit`, and its challenge node is `running`.

### RLC12: setuptools in the controller venv

- **Where:** `workflow/requirements.txt`, `workflow/requirements.lock`, `workflow/checks.py:446-447` (every check's PATH starts with `dirname(sys.executable)`), RUNBOOK beside :221.
- **Behaviour:**
  - `setuptools` is listed in `requirements.txt` with a bounded range and pinned in the lock. Version 84.0.0 restores `import distutils` in a fresh venv on this host (checked 2026-10-13).
  - RUNBOOK §1 gains: "Checks run with the controller's venv first on PATH, so the venv carries setuptools: node-gyp's `import distutils` works on Python 3.12. After pulling this change, reinstall the controller's venv from `workflow/requirements.lock`."
  - The PATH a check gets is built by one function that both `verify_revision` and the test call (refactor :441-451 if needed).
- **Acceptance:**
  - `test_checks`: `python3 -c "from distutils.version import StrictVersion"` run with that environment exits 0. In the verifier it runs under the per-worktree `.venv` that the policy setup builds from the lock ([O10]). It fails, never skips, when setuptools is missing from the lock.
  - `requirements.lock` pins `setuptools==` and `requirements.txt` lists it.
  - No check or test names an absolute controller venv path. The verifier proves the fresh-venv case.

### RLD18: sidecar delivery readback

- **Where:** `workflow/sidecar.py:696-725` (`deliver_text`, used by sidecar messages and `workflow note` through `workflow/notes.py:81`), the gate `refusal` (:672-682), `input_shown` as `answer` uses it (`guardrails.py:1716`), and the pane attention record (`automatic.py:513-521`).
- **Behaviour:**
  1. Check the gate again immediately before `send-text`. A lane that went on is `refused` / `lane_finished` and nothing is typed.
  2. After `send-keys Enter`, read the pane. If `input_shown` still finds the text, press Enter once more and read again.
  3. If the text is still there, the message is `undeliverable` with reason `pane_busy`. The closed enum has no better value, and its meaning ("a draft typed") fits. A `sidecar` event and a `pane` attention record say: "Enter did not submit the message; the text is still in <lane>'s input; clear it in the pane."
- **Acceptance:** `test_sidecar` with a fake Herdr:
  - The first Enter is swallowed: the message is `delivered` after exactly one extra Enter.
  - The text remains after both Enters: `undeliverable`/`pane_busy`, the attention record exists, and the ledger validates.
  - A completion file appears between the first gate and the paste: `refused`/`lane_finished` with no `send-text` call.

### RLD20: Claude panel budget default

- **Where:** `workflow/panel.py:70-71` (`DEFAULTS`, `BOUNDS`), resolution :142-170, argv :650. Approved by [O8].
- **Behaviour:**
  - A panel with a `claude` provider and no `budget_usd` pins `budget_usd: 25`.
  - A pi-only panel without it keeps 5. pi has no budget flag, so the schema default stays true for it.
  - In a mixed claude and pi panel, 25 applies to the claude calls and pi gets no flag. The budget is per provider call, not a panel total.
  - An explicit `budget_usd` is kept. The 0.5-50 bounds are unchanged, so the value stays configurable.
  - **Clear error ([O11]).** A claude call can still end with `error_max_budget_usd`. The panel's recorded failure then names `budget_usd`, the configured value, the spent amount read from the provider output ("spent amount unavailable" when the output has none), and where to raise it: the panel entry in feature.json, maximum 50. This uses the existing event and report text, with no new schema field or value; the panel stays report-only.
  - RUNBOOK "Multi-provider panel" states both defaults (25 with a claude provider, 5 pi-only) and the 50 ceiling.
- **Acceptance:** `test_panel` (update :174):
  - A claude provider without `budget_usd` resolves to 25, and its argv carries `--max-budget-usd 25`.
  - A pi-only panel resolves to 5, and its command has no budget flag.
  - A mixed panel gives 25 on the claude argv and no flag on pi's.
  - An explicit 7 stays 7. 0.4 and 51 are refused.
  - A fake `claude` returning the `error_max_budget_usd` output yields a recorded message naming `budget_usd`, 25 and the spent amount. Output with no spent amount yields "unavailable".

### RLF1: freeze running events

- **Where:** `workflow/pipeline.py:567-570` (`freeze`, `snapshots.json` early return) and :507-523 (`stop_workers`).
- **Behaviour:** after the early return, `event("freeze", "running", "Stopping the workers: <lanes>")`, then one `running` line per lane as its stop is confirmed. The `stopped` and `succeeded` events are unchanged.
- **Acceptance:**
  - A freeze test: a `freeze running` event comes before `freeze stopped`, with one per-lane line for each lane.
  - A freeze resumed with `snapshots.json` present writes no new event.
  - Exact event lists in `test_automatic`/`test_pipeline` are updated, never loosened.

### RLG23: disk and inode floor in preflight

- **Where:** `workflow/pipeline.py:1527-1566` (preflight).
- **Behaviour:**
  - Preflight runs `os.statvfs` on the nearest existing ancestor of the run directory and on the repository.
  - It refuses below 5120 MB free (`f_bavail*f_frsize`), or below 5 % free inodes (`f_favail/f_files`; skipped when `f_files == 0`).
  - The floors are overridable by `WORKFLOW_DISK_FLOOR_MB` and `WORKFLOW_INODE_FLOOR_PCT` ([O13]). A value of 0 disables that floor, and a non-numeric value is refused with a message naming the variable.
  - The message names the path, the floor that failed with the measured value, `df -h`/`df -i` and `python -m workflow clean "$RUN" --by operator`.
  - It refuses before any Git action, so launch creates no branch, worktree or run directory. `launch --dry-run` reports the same refusal. There is no warn-only path.
  - RLG24 reuses these floors.
- **Acceptance:**
  - Patched `statvfs` at 1 % free inodes and plenty of bytes: preflight exits non-zero naming "inodes", the measured value and `workflow clean`, and no run directory, branch or worktree exists afterwards.
  - 1 GB free: refused, naming free space.
  - Each checked location fails alone: the run root's ancestor with the repository healthy, and the reverse.
  - `f_files == 0` passes the inode check.
  - A healthy patch passes, and so does `WORKFLOW_DISK_FLOOR_MB=512` with 1 GB free. `WORKFLOW_DISK_FLOOR_MB=abc` is refused, naming the variable.
  - `launch --dry-run` under the failing patch prints the refusal.
  - Every existing preflight test patches `statvfs`, so the suite passes on a nearly full disk.

### RLI17: refuse an empty restore

- **Where:** prepare (`workflow/pipeline.py:1707-1711`), launch and its dry run (`workflow/launch.py:541-543`, :691), `check_restore` (`workflow/guardrails.py:277`).
- **Behaviour:**
  - With `--restore-from`, before the run directory exists, run `git diff --quiet <base> <restore> -- <owned paths of the selected lanes>`.
  - No difference is refused with: "--restore-from <sha> equals the base over the lanes' owned paths: the run would review an empty diff. Launch from the followed run's candidate (`git worktree add -b <branch> <dir> <candidate>`; `launch --repo <dir>`)".
  - RUNBOOK "Follow-up runs" gets the recipe.
- **Acceptance:** in a temporary repository:
  - `prepare --restore-from HEAD` is refused with that message and creates no run directory. `launch --dry-run` is refused the same way.
  - A restore commit that differs on an owned path is accepted.
  - One that differs only outside the owned paths is refused.

### RLI19: Herdr pane preflight, and supervising after a failed attach

- **Where:**
  - preflight's `HERDR_ENV` check (`workflow/pipeline.py:1562`);
  - `start`'s `attach_panels` (:2034-2039; `workflow/interactive.py:511-527`);
  - launch's step runner (`workflow/launch.py:763`, :784-786).
- **Behaviour:**
  - Preflight with `--herdr` also runs `herdr pane current --current`. A non-zero exit or a missing `herdr` is refused before any Git action: "not in a Herdr pane: launch with --no-herdr".
  - In `start`, an `attach_panels` failure after the workers launched prints `Note: panes not attached (<error>); attach each lane with python -m workflow.interactive attach-one "$RUN" --node <lane>`, writes one timeline event and exits 0. `launch --automatic` then runs `automatic`.
  - Only attachment failures are downgraded; any other launch failure keeps its handling ([O12]).
  - A launch without `--herdr` calls no `herdr` binary and is unchanged. That includes the viewer's run controls under systemd-run.
- **Acceptance:** a fake `herdr` on a temporary PATH with `HERDR_ENV=1`:
  - `pane current` exits 1, or `herdr` is missing: launch is refused at preflight with no branch, worktree or launch.
  - `pane current` succeeds but the attach call fails: `start` exits 0 with the note and one event, and `launch --automatic` goes on to run `automatic`.
  - A launch failure before the attach (the fake `claude --bg` fails) keeps its non-zero exit.
  - A run without `--herdr` records no `herdr` invocation.
  - Every existing preflight test that sets `--herdr` gets a passing fake `pane current`.
  - No path exits with workers launched and no supervisor.

### RLF2 (part a): setup preflight

- **Where:** preflight (`workflow/pipeline.py:1527-1566`), launch (`workflow/launch.py`), the check environment (`workflow/checks.py:441-460`, `run_lane_commands` :546-555).
- **Behaviour:**
  - `preflight --setup` (and `launch --preflight-setup`, which passes it) creates a throwaway detached worktree of the repository's HEAD outside the run directory.
  - It runs the policy's `setup` there once, in order, each command with its timeout and the verifier's own environment: the same builder as `verify_revision`, with fresh temporary `XDG_CACHE_HOME`, `npm_config_cache` and `TMPDIR`.
  - The first failure exits non-zero, naming `setup <index>`, its argv, its exit code and the last 20 lines of its log.
  - All passing prints `setup: passed (<seconds> s)`. A policy without setup prints `setup: none`.
  - The worktree and temporary directories are removed in a `finally`, Ctrl-C included.
  - **Default unchanged ([O14]).** `launch`, `launch --dry-run` and `preflight` without the flag run no setup command and create no worktree. No `--no-preflight-setup` flag exists.
- **Acceptance:**
  - A policy whose setup is `python3 -c "import sys; sys.exit(1)"` makes `preflight --setup` exit non-zero naming `setup 0`.
  - A passing setup prints `setup: passed`.
  - `git worktree list` is the same before and after on a pass, on a fail, and on a setup interrupted by `KeyboardInterrupt`. The temporary directories are gone in all three cases.
  - A fake setup that records its invocation is never invoked by a default `launch`, `launch --dry-run` or `preflight`.
  - `launch --dry-run --preflight-setup` prints the flag on its preflight command.

### RLG24: one retry for every failed lane, and a full disk counted as transient

- **Where:**
  - the retry CLI (`workflow/pipeline.py:2005-2022`);
  - `request_retry` and `check_retries` (`workflow/automatic.py:1860-1922`);
  - `transient_packet` and `attempt_limit` (`workflow/repair.py:57-86`);
  - the memory wait (`automatic.py` `MEMORY_FLOOR_MB`, RUNBOOK:500).
- **Behaviour:**
  1. `retry "$RUN" --phase worker --all-failed --by operator|maintainer`, on an automatic plan, records one retry request for every lane whose `verify_<lane>` is pending with an error. That covers a failed packet and a step that raised before any packet, such as `OSError(28)`.
     - Each lane's attempt is raised exactly as the single-lane `retry` raises it. It prints one line per lane and the continuation.
     - Refusals: none pending, "No verify step failed or was left without a verdict"; `--node` together with `--all-failed`; `--phase candidate`; `--by panel`.
     - `automatic --live` then reruns every requested lane in the same pass.
  2. A failed attempt counts as transient like a memory kill when every gate reason is a setup or check failure whose retained log's last 20 lines contain `ENOSPC`, `No space left on device` or `Disk quota exceeded`.
     - Such an attempt starts no round, does not count toward the identical-failure rule and does not spend the attempt budget. The cap is three transient attempts per lane, phase and revision, shared with memory kills.
     - Before the rerun the controller waits until RLG23's floors (and their env overrides) hold on the run root and the repository, polling up to 10 minutes. It writes at most one `running` event a minute: `waiting for disk: <n> MB, <p> % inodes free`. After 10 minutes with a floor still unmet it stops with a refusal naming that floor. The wait never loosens a floor.
     - The classification is derived by the controller from the packet's gate reasons and retained logs. No packet field changes (Constraints), and nothing is labelled `memory`.
- **Acceptance:**
  - Four lanes whose verify steps raised `OSError(28)`: one `retry --all-failed` records four requests, and `automatic --live` (fake checks pass) reruns all four and proceeds.
  - Each lane's recorded attempt equals what `retry --phase worker --node <lane>` would record.
  - The four refusals each exit non-zero with their quoted text: none pending, `--node` together with `--all-failed`, `--phase candidate`, and `--by panel`.
  - A packet whose setup log ends with `ENOSPC` is transient, and so is one whose check log ends with `No space left on device` or `Disk quota exceeded`.
    - Two such attempts on one revision do not raise "failed identically".
    - They start no repair round and spend no ordinary attempt.
    - A fourth transient attempt on one revision, disk and memory kills counted together, counts like any failure.
  - A real failure next to a disk signature is not transient.
  - Every packet still validates, and `transient` is never anything but `memory` or absent.
  - The disk wait passes once a patched `statvfs` recovers, with a fake clock and at most one event a minute. A patch that never recovers stops at 10 fake minutes with a refusal naming the unmet floor.

### RLI16: operator relaunch of a lane whose launch died

- **Where:**
  - `workflow/interactive.py:235-294` (`settle`, `reconcile`, `launch`; receipt `<lane>.interactive.json`, log `<lane>.launch.log`);
  - the CLI in `workflow/pipeline.py` (reconcile refusals :1978, retry :2017);
  - `workflow/actor.py:26` (`OPERATOR_ONLY`);
  - RUNBOOK "Ambiguous startup" (:449).
- **Behaviour:** `relaunch "$RUN" <lane> --by operator [--dry-run]` is operator-only: maintainer and panel are refused. It is allowed only when every one of these is proven:
  1. `launch_<lane>` is still pending, and the run is neither abandoned nor held by a controller lock.
  2. The receipt is `needs_reconciliation`, or there is none.
  3. The bound or printed session is absent from `claude agents --json`, or listed `stopped`, `failed`, or `done` with no PID. A listing that fails or cannot be parsed proves nothing, so the relaunch is refused.
  4. The lane worktree at `plan.nodes[<lane>].worktree` is present, readable, at `plan.base_commit` (HEAD equal) and clean (`status --porcelain` empty); absent, unreadable, dirty or moved is a refusal ([L10]).
  5. No completion file, handoff or stop record exists for the lane.

  When allowed, it archives the receipt as `<lane>.launch-<n>.receipt.json` and the log as `<lane>.launch-<n>.log`. `n` counts archives from 1, and neither name ends in `.interactive.json` or `.launch.log`. It writes one timeline event naming the actor and the archive, stops nothing, and launches the lane once through the normal launch path. The run then continues through the existing "Ambiguous startup" path: `reconcile "$RUN" --by operator`, then `automatic "$RUN" --live`, the two commands relaunch prints last ([L9]).

  `--dry-run` prints each condition's verdict and what it would archive and launch, then changes nothing. It exits 0 when allowed; otherwise it exits 1 with the first refusal on its first line. The stage C offer rule keys on this.

  Unknown or contradictory evidence refuses that relaunch without changing anything; it is never a reason to guess.
- **Acceptance:** a fake `claude` whose first `--bg` leaves a `done`, PID-less row:
  - `relaunch` launches exactly once (the fake records one more `--bg`); `start` after it still prints "Run already started" and launches nothing; `reconcile` binds the new receipt and `automatic --live` proceeds past the launch step ([L9]).
  - **Refusals.** One test per case, each exiting non-zero with its own message:
    - a controller lock held;
    - an abandoned run;
    - `launch_<lane>` not pending;
    - a receipt in any state but `needs_reconciliation`;
    - a live session (PID);
    - `claude agents --json` failing or unparseable;
    - a worktree with a commit, uncommitted changes, or HEAD on another base;
    - a completion file, a handoff or a stop record;
    - `--by maintainer` and `--by panel`.
  - **No mutation.** After every refusal and every `--dry-run`, the content hash of every file in the run directory is unchanged, and the fake records no `--bg` and no stop.
  - `--dry-run` exits 0 when every condition holds, and 1 with the first refusal on its first line otherwise.
  - **Archives.** With `<lane>.launch-1.*` present, a second relaunch archives as `-2` and leaves `-1` byte for byte unchanged.
  - `clean --dry-run` and `abandon` do not treat an archive as a node.

### BL1 and BL3 cleanup in docs/BACKLOG.md

- **Behaviour:**
  - Delete item 1 (lines 5-24; it shipped in merge 6c62677) and item 3 (shipped by this feature).
  - The file keeps its header and says that nothing is waiting.
  - The handoff doc names 6c62677 for item 1 and this feature for item 3, since the controller writes the commit message.
- **Acceptance:** `grep -n "Accepted by the operator\|## 3\." docs/BACKLOG.md` finds nothing.

### RLF4: recovery without abandon (docs only)

RLF4 closes as covered by RLI16, RLG24 and RLI17. RUNBOOK "Status, failures and recovery" gains a short **Recovery without abandon** paragraph:

- a lane whose launch produced no live session: `relaunch`;
- a host failure across lanes: `retry --phase worker --all-failed`, after `df -h`/`df -i` and `workflow clean`;
- a follow-up whose restore would be empty: the `git worktree add` recipe of RLI17.

It also says that hand-written markers are needed only for the cases listed under "What stays in the terminal".

## Interfaces for the server lane (ux-critique-fixes-c)

Pinned here so stage C's run controls call the CLI and never re-derive its rules.

- **Retry all failed checks:** argv `-m workflow retry "$RUN" --phase worker --all-failed --by operator`. Exit 0 with one line per lane, or a non-zero exit with the refusal text above. The control may offer it when its `retryTargets` hold two or more worker lanes.
- **Relaunch a lane:** argv `-m workflow relaunch "$RUN" <lane> --by operator`. The offer rule runs `relaunch "$RUN" <lane> --dry-run --by operator` the way the Clean control runs `clean --dry-run` (`server/controls.ts:651`), with exit 0 meaning offer. Archives never match `/\.interactive\.json$/` (`server/controls.ts:289`).
- **GH3:** `run-state.json` `tasks[].error` is null for a task not in `next`. The viewer guard (`server/projects.ts:1982-1984`) may also read `next`.
- **GH12:** while a rerun runs, `plan.json` and `run-state.json` share `base_commit`, so the server's load test needs no viewer change.

## RUNBOOK and README changes

| Item | RUNBOOK (`workflow/RUNBOOK.md`) | README (`workflow/README.md`) |
|---|---|---|
| BL3 | "Completion evidence" (:82): the final-turn sentence | – |
| GH3 | "Status, failures and recovery", export paragraph: errors only for pending steps | – |
| GH12 | Guardrails, challenge rerun: `run-state.json` is re-exported once the rerun is pinned | – |
| RLC12 | §1 beside :221: setuptools, reinstall after pull | "Setup": reinstall from the lock |
| RLD18 | "Review sidecar": readback, one extra Enter, `pane_busy` attention | – |
| RLD20 | "Multi-provider panel": default 25 with a claude provider, 5 pi-only, ceiling 50; the budget-failure message | – |
| RLF1 | "Explicit handoff, freeze and verification": the running events | – |
| RLG23 | preflight row (:629) and §2: the disk/inode floor and its env names | – |
| RLI19 | preflight row: the pane check; `start` row: the attach note and exit 0 | – |
| RLF2 | preflight row and §2: `--setup` | `launch` row: `--preflight-setup` |
| RLI17 | "Follow-up runs": the empty-restore refusal and recipe | – |
| RLG24 | "Failed verification" bullet and RUNBOOK:500: `--all-failed`, disk-transient | the `retry` row |
| RLI16 | "Ambiguous startup" (:449) and the command reference: `relaunch` | a new `relaunch` row (operator only) |
| RLF4 | "Recovery without abandon" paragraph | – |
| GH8 | "Verification policy and evidence": md-manager's root Playwright suite runs only when a lane that owns `src/App.tsx` or the skills views declares a browser check `env MD_MANAGER_API_PORT=<p> MD_MANAGER_WEB_PORT=<p> npx --no-install playwright test --config=playwright.config.ts` (root config ignoring `project-workflows/**` from ux-critique-fixes-c on) | one sentence where policy checks are described |
| RLI21 | "Run controls in the viewer": long controls run in a `systemd-run --user --scope`; from ux-critique-fixes-c on with `--property=OOMPolicy=continue`, so one check's OOM kill no longer stops the supervisor; before that, restart it after a memory kill. The table gains "Retry all failed checks" and "Relaunch a lane" marked "(from ux-critique-fixes-c)" | the Run controls row lists both, marked the same way |

A new command (`relaunch`) gets a README row and a RUNBOOK section (CLAUDE.md).

## Risks

- **Docs ahead of code.** The GH8, RLI21 and two run-control rows describe stage C behaviour. Each row names `ux-critique-fixes-c`, so it stays true before and after that stage lands. If stage C is dropped, those rows are stale. The handoff lists them.
- **RLC12 needs an operator step.** The controller's own venvs (`~/dev/md-manager/.venv`, `~/dev/md-manager-ctl/.venv`) lack setuptools until someone reinstalls them from the lock. Until then node-gyp still fails. The handoff and `verify_yourself` say so.
- **RLG23 floors.** A box below 5 GB free refuses every launch after merge. This box had 41 GB and 72 % inodes free on 2026-10-13. The env overrides are the escape.
- **RLI16 double launch.** A relaunch beside a surviving session would run two workers on one lane. Conditions 3-5 and the refusal tests guard it. When in doubt it refuses.
- **Size.** Thirteen items in one lane. Workers run targeted tests; the verifier runs `npm ci` and the full suite (2400 s timeout; [G13]). A block whose open P0/P1 all name this lane is fixed in the run.
- **Schema drift.** The panels `budget_usd` schema default (5) and `contracts/workflow/README.md` describe only pi-only panels after RLD20. That is recorded under Deferred.
