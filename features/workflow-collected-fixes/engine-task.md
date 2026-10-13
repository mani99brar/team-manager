# Engine worker: workflow collected fixes

## Goal

Fix the thirteen open controller items of the collected md-manager issues in `workflow/`, each proven by a unit test that the verifier runs in `.venv/bin/python -m workflow.run_tests`:

- the worker final-turn rule;
- the export and challenge-rerun fixes;
- setuptools in the controller venv;
- the sidecar delivery readback;
- the Claude panel budget default;
- the freeze running events;
- the disk, Herdr-pane and setup preflights;
- the empty-restore refusal;
- `retry --all-failed` with disk-full counted as transient;
- operator `relaunch`.

Then bring `workflow/RUNBOOK.md`, `workflow/README.md` and `docs/BACKLOG.md` up to date and write the handoff.

The specification is `features/workflow-collected-fixes/prd.md`: one "Requirements" section per item id, plus "Interfaces for the server lane" and "RUNBOOK and README changes". `features/workflow-collected-fixes/decisions.md` records the operator's decisions and wins over this task where they differ.

## Context

- **Python and tests.** Your lane worktree has no virtualenv. Create one once, the way the policy setup does (`.venv/` is gitignored):
  - `python3 -m venv .venv && .venv/bin/python -m pip install --quiet -r workflow/requirements.lock`
  - After you pin setuptools (RLC12), reinstall from the lock.
  - Run targeted tests while you work, for example `.venv/bin/python -m unittest workflow.test_export -k <name>`. Bounded output: `.venv/bin/python -m workflow run-report -- <command>`.
  - The verifier runs `npm ci`, builds `.venv` from the lock and runs the full `workflow.run_tests` (2400 s; the pipeline tests need `node_modules`, see [G13]). Run the full suite yourself once before you write the completion.
- **Shared test fixtures.** Reuse the existing fakes before you write new ones: the fake Herdr in `test_guardrails`/`test_sidecar`, the fake `claude` in `test_interactive`/`test_feature_launch`, and the temporary repositories in `test_feature_launch`. Extend existing test classes (`test_automatic`, `test_repair`, `test_export`, `test_guardrails`, `test_checks`, `test_sidecar`, `test_panel`, `test_pipeline`, `test_feature_launch`, `test_interactive`) rather than adding new files where a class fits. Leave item ids out of test names and comments.
- **Work order.** Each line gives the PRD section, where the change lands at 44b9c24, and what the test proves. Work in small steps, one item at a time. Never commit in your worktree: the freeze snapshots it against the base and refuses a moved HEAD.
  1. **BL3** (`automatic.py:144-190`; `completion_prompt`, :161, :174, :188): the "End your final message without asking or telling the operator…" sentence at 1.0.0 and 1.1.0, and "Put any step for the operator in verify_yourself…" only at 1.1.0. Also in `session_brief` (`test_repair.py` near :1207).
  2. **GH3** (`export_state.py:623`): `error` only for a task in `state.next`. Test: `next=("verify_adapter",)` exports `verify_ui.error == None` and keeps `verify_adapter.error`.
  3. **GH12** (`guardrails.py:1348-1427`, `resume_main` export :1765-1768): export after `repin` (:1423), before `run_challenge` (:1427). Test: stop the fake challenge job while `challenge.running.json` exists; the `base_commit` values match and the challenge is `running`.
  4. **RLC12** (`requirements.txt`, `requirements.lock`, `checks.py:441-451`): pin setuptools. One environment builder for checks. Test: `python3 -c "from distutils.version import StrictVersion"` exits 0 under that environment. It runs under the per-worktree `.venv` the policy setup builds from the lock, and fails (never skips) without setuptools. No absolute controller venv path anywhere ([O10]).
  5. **RLD18** (`sidecar.py:672-725`, `notes.py:81`, `guardrails.py:1716` `input_shown`, `automatic.py:513-521`): re-gate before `send-text`; readback; one extra Enter; `undeliverable`/`pane_busy` plus a `pane` attention record. Three fake-Herdr tests.
  6. **RLD20** (`panel.py:70-71`, :142-170, :650; [O11]):
     - With a claude provider and no `budget_usd`: 25 and `--max-budget-usd 25`, per provider call. pi-only stays 5. A mixed panel gives 25 on claude and no flag on pi.
     - Explicit values and the 0.5-50 bounds are kept.
     - A claude `error_max_budget_usd` failure is recorded naming `budget_usd`, the value, the spent amount ("unavailable" when the output has none) and the feature.json panel entry (max 50). Existing message text only.
     - Update `test_panel.py:174`.
  7. **RLF1** (`pipeline.py:567-570`, :507-523): a `freeze running` event before `stopped`, one line per lane, none on a resumed freeze.
  8. **RLG23** (`pipeline.py:1527-1566`; [O13]):
     - The statvfs floor: 5120 MB and 5 % inodes, checked on the run root's ancestor and on the repository.
     - `WORKFLOW_DISK_FLOOR_MB` and `WORKFLOW_INODE_FLOOR_PCT`: 0 disables a floor, and a non-numeric value is refused naming the variable.
     - It refuses before any Git action or run directory, naming the measured value. `launch --dry-run` prints the same refusal.
     - Tests: each location failing alone, and `f_files == 0`. Patch `statvfs` in every preflight test.
  9. **RLI17** (`pipeline.py:1707-1711`, `launch.py:541-543`, :691, `guardrails.py:277`): `git diff --quiet <base> <restore> -- <owned paths>`, refused when empty, with the recipe. Covers prepare and the launch dry run.
  10. **RLI19** (`pipeline.py:1562`, :2034-2039, `interactive.py:511-527`, `launch.py:763`, :784-786; [O12]):
      - The pane check in preflight; a missing `herdr` is refused too.
      - In `start`, an attach failure prints the attach-one note, writes one timeline event and exits 0. Only attachment failures are downgraded.
      - Without `--herdr`, no `herdr` call happens.
      - Existing `--herdr` preflight tests get a passing fake `pane current`.
  11. **RLF2(a)** (`pipeline.py` preflight, `launch.py`, `checks.py:441-460`, :546-555; [O14]):
      - `preflight --setup` / `launch --preflight-setup` runs setup in a throwaway worktree. It names `setup <index>` on failure and prints `setup: passed`.
      - `git worktree list` and the temporary directories are unchanged after a pass, a fail and a `KeyboardInterrupt`.
      - Without the flag, launch, its dry run and preflight invoke no setup (prove it with a fake that records invocations). No `--no-preflight-setup` flag.
  12. **RLG24** (`pipeline.py:2005-2022`, `automatic.py:1860-1922`, `repair.py:57-86`): `retry --phase worker --all-failed`.
      - Disk-full counts as transient (`ENOSPC`, `No space left on device`, `Disk quota exceeded`), derived from the gate reasons and retained logs.
      - The rerun then waits on RLG23's floors. After 10 minutes still below them it stops with a refusal naming the floor, and it never loosens it.
      - Tests:
        - four `OSError(28)` lanes give four requests, and all four rerun;
        - attempts match single-lane `retry`;
        - each of the four refusals has its text;
        - all three signatures are tested;
        - no repair round and no ordinary attempt is spent;
        - the cap of three transient attempts is shared with memory kills;
        - packets keep `transient` memory-only.
  13. **RLI16** (`interactive.py:235-294`, `pipeline.py` CLI near :1978 and :2017, `actor.py:26`): operator-only `relaunch "$RUN" <lane> [--dry-run]`.
      - Every condition in the PRD is proven before acting. A failing or unparseable `claude agents --json` is a refusal.
      - Archives go to `<lane>.launch-<n>.receipt.json` and `<lane>.launch-<n>.log`, with numbering that keeps older archives. It launches once.
      - Tests: the PRD's refusal matrix, one test per condition. After every refusal and every `--dry-run`, file hashes are unchanged and no `--bg` or stop happens. `--dry-run` exits 0 or 1 with the first refusal on its first line.
  14. **Docs:**
      - the PRD's RUNBOOK/README table, including the GH8 and RLI21 rows phrased "from ux-critique-fixes-c on";
      - the "Recovery without abandon" paragraph (RLF4);
      - a README row and a RUNBOOK section for `relaunch`;
      - `docs/BACKLOG.md` items 1 and 3 removed (item 1 shipped in 6c62677).
- **Docstrings.** Each module you touch keeps its opening docstring, which cites the RUNBOOK section it implements. A new function's docstring states its behaviour.

## Constraints

- **Owned paths only:** `workflow`, `docs/BACKLOG.md` and `docs/handoff/ux-fixes-engine.md`. Do not touch `server/`, `src/`, `tests/`, `contracts/`, `playwright.config.ts`, `package.json`, `CLAUDE.md`, `DESIGN.md` or anything under `features/`. The server halves belong to a later run (PRD "Non-goals").
- **Closed schemas stay as they are.** Every record you write must still validate against the schemas under `contracts/workflow/`, which you do not own:
  - `workerResult.schema.json`: `transient` is `const "memory"`, so never write a new value and never label a disk failure `memory`;
  - `sidecar.schema.json`: the message `reason` enum, so use `pane_busy`;
  - `feature.schema.json`.
- **Unchanged behaviour:** a run that hits none of the new conditions behaves exactly as today. The completion reader, the review, the sidecar's message rules, the panel's report-only contract and every printed command a viewer test parses keep their shapes. Add to messages; do not reword existing ones that `contracts/projects/triage.ts` matches, for example "failed identically on attempts … not transient".
- **Dependencies:** the standard library, plus setuptools in the lock. No new runtime dependency.
- **Tests never reach the machine.** Every path lives under a temporary directory. Use fake `claude` and `herdr` on a temporary PATH under a temporary `HOME`. Never touch `~/.config/md-manager`, `~/.claude`, `~/.pi`, `~/.config/pi/*.env` or systemd. Never read the real free disk, memory, clock or `HERDR_ENV`.
- **No secrets:** never read or copy one (`~/.claude/channels/*/.env`, `*/notify.env`, `~/.config/pi/*.env`).

## Acceptance

- Every "Acceptance" bullet of the PRD's Requirements, BL3 through RLI16, has a unit test, and the full `workflow-unit` check passes.
- **Docs:** RUNBOOK and README carry every row of the PRD's "RUNBOOK and README changes" table. `relaunch` has a README row and a RUNBOOK section. `grep -n "Accepted by the operator\|## 3\." docs/BACKLOG.md` prints nothing.
- **Handoff:** `docs/handoff/ux-fixes-engine.md` exists and records:
  - what changed, per item id, with the test that proves it;
  - the "Interfaces for the server lane", as built: argv, exit codes, refusal texts, archive names;
  - every sentence the stage C lanes must keep true (the GH8, RLI21 and run-control rows);
  - that item 1 of `docs/BACKLOG.md` shipped in 6c62677;
  - the operator step for RLC12: reinstall `~/dev/md-manager/.venv` and `~/dev/md-manager-ctl/.venv` from `workflow/requirements.lock`;
  - every open P2 you leave.
- **Completion evidence:**
  - `verify_yourself` names the RLC12 reinstall and one assumption to check, such as RLI16's "done with no PID" row shape against a real `claude agents --json`.
  - `untested` lists what only a real host proves: a real cold background service, a real full disk, and a real Herdr pane outside a session.
- **Your final message:** end it without asking or telling the operator to do anything. Any step for the operator goes in `verify_yourself`. A final message that waits on a human lists your session as `blocked`, the controller never accepts a completion from a blocked session, and the run stops at your deadline. This is the rule BL3 adds to the prompt, and your own prompt predates it.

Run targeted tests while iterating, then this lane's non-browser policy check (`workflow-unit`) once before writing the completion.

## Stop

Report `blocked` only for a real implementation blocker:

- The fail-closed behaviour the PRD specifies cannot be delivered within your owned paths. A typical case is that a record you must write would need a new value in a closed schema under `contracts/workflow/`.
- A change would alter how an existing feature launches, verifies or reviews when none of the new conditions applies.

A single relaunch whose safety cannot be established at run time is not a blocker. Unknown or contradictory evidence, such as a failing `claude agents --json`, a receipt in an unexpected state or a worktree you cannot read, means that one `relaunch` refuses without changing anything. That is the specified behaviour; build it and test it.

The work already deferred to the server lane or to a later contracts change is not a stop trigger. Leave it out and name it in the handoff:

- the run controls;
- the GH12 server test;
- the GH3 viewer guard;
- `OOMPolicy`;
- the root Playwright suite;
- new schema enum values.

Do not widen scope:

- no viewer, server or contract change;
- no shared package cache (RLF2 part b);
- no automatic relaunch without the operator;
- no policy lint that names one project's files.

## Changes after launch (binding; they win over anything above)

- [L1] RLI16 name guard (challenge attempt 1, P1). The fresh-launch name guard in `InteractiveSessions.run()` (workflow/interactive.py:320) takes an allow-list of session ids, empty by default, so every launch other than relaunch keeps today's refusal for any inventory row named `workflow-<run>-<lane>`. `relaunch` passes exactly one id: the archived receipt's `background_id`, or, when the receipt has none, the single `claude attach <id>` its launch log printed. The allow-list check is one of the preconditions proven before anything is archived: the id must be listed `stopped`/`failed`/`done` with no PID (the probe may add `--all` for this one read when the id is not listed without it) or be absent from the inventory, and no other row may carry the launch name. Order is prove, then archive, then launch once. Refusals: a live row of the launch name with another id; any row of that name while relaunch has no id to allow; a failing or unparseable inventory. Every refusal leaves the receipt and log in place. Tests in `test_interactive` must reject: the PRD's "launches exactly once" test failing with the fake still listing the dead id as `done` without PID under the launch name; the same test failing when the dead session is absent from the inventory; a launch or an archive written when a live row of the same name but another id is listed; a non-relaunch launch that accepts any id. The real row shape stays a `verify_yourself` assumption. Additions (GPT): relaunch's safety probe reads the complete inventory (`claude agents --json --all`); a failing, unsupported or unparseable inventory refuses without mutation; an absent session is not proof by itself (every other PRD condition must hold and no conflicting launch-name row may exist); `relaunch --dry-run` runs the same validation without mutation; tests prove unchanged receipt and log hashes with no background launch or stop after every refusal and dry run.
- [L2] RLG23 floor placement and test isolation. One floor function is called from both pipeline preflight and `launch_commands` (workflow/launch.py near :542, as `check_restore` is), so `launch --dry-run` prints the refusal without running preflight. Every in-process dry-run or launch test patches `os.statvfs` in a shared base `setUp`; every subprocess preflight test (workflow/test_portable.py:210 and :249 included) sets `WORKFLOW_DISK_FLOOR_MB=0` and `WORKFLOW_INODE_FLOOR_PCT=0` in its env. Done when the full suite passes with `os.statvfs` patched to report 0 bytes free on the real host paths. Addition (GPT): the same floor function also serves retry's bounded disk wait ([L3]); floor-specific tests use controlled readings, never the host's disk.
- [L3] RLG24 disk wait for raised steps. The disk wait runs before rerunning any requested lane whose pending task error is errno 28 or contains one of the three signatures, as well as lanes with a disk-transient packet. The four-lane `automatic --live` test patches `statvfs` healthy; a test with an unrecovered patch must show the four-lane rerun stopping at the 10-minute refusal naming the floor.
- [L4] RLI19 acceptance reading. The bullet "No path exits with workers launched and no supervisor" is read as "no attach failure exits with workers launched and no supervisor" and tested as such. A multi-lane partial `--bg` launch failure keeps today's exit 1 per [O12]; the handoff names it as an open P2.
- [L5] RLD18 readback timing. Before each Enter, the readback is polled over about 2 s with an injectable sleep or clock. A fake-Herdr test in which the input line clears on the second read must record `delivered` with no extra Enter.
- [L6] Locks. RLF2's throwaway `git worktree add` and its removal run under `worktree_lock(repo)` (workflow/launch.py:759-762 pattern). `relaunch` holds `run_lock(directory)` across its checks, archive and launch, as `resume_main` does (workflow/guardrails.py:1771). A test must show relaunch refused while another process holds the run lock.
- [L7] Worker setup. The task's one-time setup runs `npm ci` once in the worker's worktree before the full suite ([G13]); the worker's full-suite run must show no "Install npm dependencies" errors.
- [L8] Handoff note for RLC12. The handoff states, next to the reinstall step, that the setuptools test fails under every venv built before the pin (including precedent policies whose `workflow-unit` points at the controller venv) until that reinstall, so it is not read as a regression.

(design challenge attempt 1, panel: agreement on revise; Claude bullets plus GPT additions; decision dir /home/agentops/.local/state/cook/workflow-collected-fixes/decisions/001-challenge_paused)

- [L9] RLI16 continuation (challenge attempt 2, P1). `relaunch` does not advance the graph. `start` keeps its "Run already started; use status/explicit controls, never start again" guard unchanged, and `Pipeline.launch`, the graph nodes and `InteractiveSessions.run()`'s signature beyond the [L1] allow-list are untouched. The continuation after a successful relaunch is the existing "Ambiguous startup" path (RUNBOOK:449): `python -m workflow reconcile "$RUN" --by operator`, then `python -m workflow automatic "$RUN" --live`. On success relaunch prints exactly those two commands as its last lines. The PRD's acceptance bullet "relaunch launches exactly once, `start` completes and `automatic` proceeds" (prd.md:243, :249) is read as, and tested as: relaunch launches exactly once; `start` after relaunch still prints "Run already started" and launches nothing; `reconcile` binds the new receipt and advances `launch_<lane>` out of `state.next`; `automatic --live` then proceeds past the launch step. The handoff's "Interfaces for the server lane" and the RUNBOOK relaunch section name this two-command chain so stage C's "Relaunch a lane" control chains them. Tests in `test_interactive`/`test_pipeline` must reject: a relaunch after which `reconcile` refuses the lane ("No durable launch intent" or otherwise); a `start` after relaunch that launches a second session; an `automatic --live` that stops on the reconcile note after reconcile ran; any change to `start`'s guard text or to a non-relaunch launch.
- [L10] RLI16 condition 4, worktree state (challenge attempt 2, P1). Condition 4 is read as: the lane worktree at `plan.nodes[<lane>].worktree` is present, readable, has HEAD equal to `plan.base_commit` and `git status --porcelain` empty. An absent, unreadable, dirty or moved worktree is a refusal proven under `run_lock` before anything is archived, with no mutation: receipt and launch log in place, no archive written, no `--bg`, no stop. `relaunch` never creates or recreates a worktree. The refusal matrix gains one test per state (absent, dirty, HEAD not at base) proving unchanged run-directory hashes, no archive files, and no `--bg` call; `relaunch --dry-run` reports the same refusal on its first line.
- [L11] [L2] subprocess isolation proof. In addition to [L2]'s patched-statvfs run, the worker runs the full suite once with `WORKFLOW_DISK_FLOOR_MB=999999999 WORKFLOW_INODE_FLOOR_PCT=99` exported in the parent environment. Floor-specific tests set or clear the two variables themselves and never inherit them. Done when that run passes and the handoff records the command and result.
- [L12] RLG24 classification sites. The worker adds one disk-transient predicate (errno 28 or one of the three signatures in the last 20 lines of every gate reason's retained log) and one combined "transient (memory or disk)" predicate. The combined predicate is applied at automatic.py:1846 (`previous_failure`), :1908 (identical-failure rule), :1996 (`blocked_lanes`) and repair.py:94 (`attempt_limit`). The memory-pressure event and `wait_for_memory` (automatic.py:1967-1970) stay memory-only; the disk wait ([L3]) runs for disk. The packet keeps `transient: "memory"` only ([G4]). Tests must reject: two ENOSPC attempts reported as "failed identically"; a repair round started after a disk-full attempt; a disk-full attempt whose timeline event says memory pressure or that waits on memory; the shared cap of three not counting a memory kill and a disk-full attempt together.
- [L13] Disk-signature false positive. A genuine test failure whose assertion text quotes `ENOSPC`, `No space left on device` or `Disk quota exceeded` (test_sidecar.py:519-524, :930-944; test_automatic.py:599-609; the new RLG24 tests) is classified disk-transient and gets up to MAX_TRANSIENT_RERUNS (3) free reruns. No code change in this feature. The handoff names it as an open P2 with the cap as its bound.
  Addition (GPT, [L9]/[L10]): update prd.md, engine-task.md, workflow/RUNBOOK.md, workflow/README.md and docs/handoff/ux-fixes-engine.md consistently, including the server-lane interface; [L10]'s refusal tests include an unreadable worktree and the dry-run probe.

(design challenge attempt 2, panel: agreement on revise; decision dir /home/agentops/.local/state/cook/workflow-collected-fixes/decisions/002-challenge_paused)

(follow-up run workflow-collected-fixes-002 after 001's independent review blocked; panel split on the timeout, Jev 0.3, decided by the operator as [O15]; decision dir /home/agentops/.local/state/cook/workflow-collected-fixes/decisions/004-review_blocked, triage.md there)

- [L14] Restore. The lane starts from 001's candidate 64644771 (`--restore-from`): `git diff --stat 64644771 -- workflow docs/BACKLOG.md docs/handoff/ux-fixes-engine.md` is empty before the first edit. Everything 001 built stays; only [L15]-[L18] change code, tests and the handoff.
- [L15] G1, RLI16 live-again guard (review P1, general #1 and lane-review round 2). In `InteractiveSessions.run()` (workflow/interactive.py:~342) a fresh-inventory row whose id is in `allowed_ids` is exempt from the lane-name refusal only when its `state` is ended (`stopped`/`failed`/`done`) and it has no positive pid; any other row named for the lane refuses. The refusal happens before `before_launch` is called: no archive, no `claude --bg`, receipt unchanged. Apply the same rule in the `RelaunchSessions.run` test fake (test_interactive.py:~1461) or route both through one shared helper. Tests that fail before the fix: `LaunchNameGuard` with the allowed id listed `working` with a pid (RuntimeError, no `--bg`, receipt unchanged, `subprocess.run` not called), and a relaunch-level case where `claude agents --json --all` lists the dead id `done` with no pid and the fresh `claude agents --json` lists it `idle` with a pid (exit 1, no `<lane>.launch-<n>.*` archive files, no `--bg`).
- [L16] G2, amendment of [L9] (review P1, general #2; operator decision, no code). `InteractiveSessions.run()` may carry the relaunch-only keyword `before_launch=None`, and its existing-receipt reconciliation is skipped only when that hook is set, because `relaunch_main` calls it only after its locked eligibility checks. Every other caller passes neither and behaves exactly as before; launch refusals (the [L15] guard included) precede the archive. RUNBOOK's relaunch section names the hook in one sentence.
- [L17] G4, [O13]/[L2] statvfs isolation (review P1, coverage case 2). `isolate_disk()` (workflow/test_pipeline.py:~53) also starts a module-wide `patch("workflow.checks.os.statvfs", return_value=<a healthy reading>)` next to the env floors, with its cleanup, so in-process code never reads the host disk even when a test clears the floor variables. Floor-specific tests keep their own patches.
- [L18] G3, the [L2]/[L11] isolation proof (review P1, general #3 and coverage case 3). On the follow-up candidate (after [L15]-[L17]), the worker runs the complete suite once with `WORKFLOW_DISK_FLOOR_MB=999999999 WORKFLOW_INODE_FLOOR_PCT=99` exported in the parent environment, only when no Playwright/Chromium process runs on the host (`pgrep -f '[c]hrome-headless-shell'` prints nothing) and the 1-minute load average is below 4; it waits for that, it never runs alongside a browser suite. Done when that run passes with no failures and docs/handoff/ux-fixes-engine.md records the exact command, start/end time, load average and the pass line. Isolated reruns of single classes do not satisfy it. If the host never goes quiet within the worker's time, the worker records that in the handoff and stops; it does not weaken the run.
- [L19] Timeout. policy.json raises `workflow-unit` to 3600 s for this run (001's attempt 1 timed out at 2400 s under another run's browser load; the suite took 1542-2960 s under load, 556-576 s idle).

- [L20] Amends [L18] (challenge attempt 1 of 002, P1; operator decision). The proof run waits for a quiet host (no `chrome-headless-shell` process, 1-minute load under 4), polling every 2 minutes for at most 60 minutes. If no quiet window comes, the worker runs the proof anyway under the suite's own 3600 s timeout and records the load average at start and end. The proof is floor-isolation evidence: it passes when no test outside the Playwright-backed classes (`test_automatic` graph classes, `PipelineTests`) fails, and every Playwright-backed class that failed under load passes alone with the same exported floors and the same sitecustomize; those classes are recorded as load failures with the isolated pass command, not as a lane failure. Any failure outside those classes, or any class that fails alone, is a lane failure. The handoff records the exact command, start and end time, load average, the pass line, and the load-failure list (empty when the host was quiet). Cook-side step, not this lane's code: the session, acting as operator, starts no new UI stage launch or verify while the engine worker's proof run or the engine verify is in progress; a UI verify already running is never paused or shortened ([O9]). If an engine verify attempt fails only on Playwright-backed classes while a UI browser check runs, the session pauses the engine run until that UI run integrates and resumes it (the [O9] memory-rule lever), spending no repair round on it.
- [L21] Amends [L17] (challenge attempt 1 of 002, P1). The module-wide healthy `patch("workflow.checks.os.statvfs", return_value=<healthy reading>)` starts from `isolate_registry()` (or a helper it calls) instead of `isolate_disk()`, with cleanup, so every run-preparing module reaches it. The modules that must reach it: test_pipeline, test_repair, test_automatic, test_interactive, test_feature_launch, test_outcome; where a listed module does not call `isolate_registry()` in setUpModule, the worker adds the call, and audits every other module that reaches `disk_refusal`/`launch_commands` or clears either floor variable (GPT addition). Floor-specific tests (DiskFloor, DiskFullAttempts, AllFailedAfterAFullDisk and the new RLG24 tests) keep their own patches and controlled readings. Done-check, before any edit at 64644771 and again after the fix, minutes and no browser: `.venv/bin/python -m unittest workflow.test_repair workflow.test_automatic workflow.test_interactive workflow.test_checks workflow.test_feature_launch` with `WORKFLOW_DISK_FLOOR_MB=999999999 WORKFLOW_INODE_FLOOR_PCT=99` exported and a PYTHONPATH `sitecustomize.py` that makes `os.statvfs` raise; after the fix no test outside the floor tests may fail. The handoff records both results and the before/after commands.
- [L22] Amends [L18] evidence (challenge attempt 1 of 002, P1). The single [L20] full-suite proof run is 001's combined command: `WORKFLOW_DISK_FLOOR_MB=999999999 WORKFLOW_INODE_FLOOR_PCT=99` exported plus a PYTHONPATH `sitecustomize.py` patching `os.statvfs` to report 0 bytes free (and 0 free inodes) on the host paths, exactly as docs/handoff/ux-fixes-engine.md:81 of 001 recorded it. One run satisfies [L2], [L11] and G3 together; two separate full-suite runs are not required. The handoff names that one command with both parts, next to the [L20] record. The policy's `workflow-unit` argv is not changed in this run (resume does not re-pin policy.json); moving the floors into the check argv is deferred.
- [L23] [L15] single rule (challenge attempt 1 of 002, P2). One pair of helpers in workflow/interactive.py, `ended_row(row)` (state in `stopped`/`failed`/`done` and no positive pid) and `conflicting_rows(rows, name, allowed_ids)`, is used by `InteractiveSessions.run()`, `relaunch_conditions` and the `RelaunchSessions.run` test fake; the fake calls production code, not a copy. The fake gets separate `--all` and fresh inventories so the [L15] relaunch-level case (dead in `--all`, live in the fresh listing) is expressible. Done when the [L15] relaunch-level test fails with the helper reverted to the old rule and the `LaunchNameGuard` test fails with the fake bypassing the helper.
- [L24] Relaunch is one-shot per lane (challenge attempt 1 of 002, P2, no code change). While `claude agents --json --all` keeps launch-1's dead row under the lane name, a second relaunch of the same lane is refused by [L1]'s conflicting-row rule; `relaunch --dry-run` reports that refusal on its first line. The handoff's "Interfaces for the server lane" and the RUNBOOK relaunch section state this in one sentence each, so stage C's "Relaunch a lane" control can show why the probe refuses.

(design challenge attempt 1 of workflow-collected-fixes-002: the panel agreed on revise; the texts differed on whether a Playwright-backed class failing only under load may be recorded as a load failure, and Jev was unsure (0.26), so the operator took Claude's bullets plus GPT's module audit; decision dir /home/agentops/.local/state/cook/workflow-collected-fixes/decisions/005-challenge_paused)

- [L25] One evidence run, not several (challenge attempt 2 of 002, P1). The 4 h lane deadline stands; no extension is made. The worker records the wall clock at its first action and treats that time plus 4 h as its deadline. The evidence work is one combined full-suite run after all code changes: `WORKFLOW_DISK_FLOOR_MB=999999999 WORKFLOW_INODE_FLOOR_PCT=99` exported plus the PYTHONPATH `sitecustomize.py` that reports 0 bytes and 0 inodes free ([L22]). That single run is [L20]'s proof run, [L21]'s after-check and the task's "full suite once before the completion" together; no separate full-suite run and no separate `unittest` done-check is run. [L21]'s "before" run at 64644771 is dropped; the handoff states instead that the gap was latent (every floor-reaching call in test_repair patches statvfs itself; 001's combined run passed these modules) and that the 0-bytes-free sitecustomize surfaces every unreached module the raising variant would, because checks.py:814 is the only `statvfs` caller in workflow/. Pass criterion is [L20]'s rule: no failure outside the Playwright-backed classes, and every Playwright-backed class that failed in that run passes alone once with the same floors and sitecustomize; such classes are recorded as load failures with the isolated command, not as a lane failure. Isolated reruns are limited to those classes, each once. The quiet-host wait is at most 30 minutes, polled every 2 minutes in short Bash calls, never one long sleep. Order of work: code and targeted tests first, then the single proof run, then the handoff and completion. If the deadline is within 75 minutes when the code is done, the worker starts the proof run at once without waiting for quiet. No code edit after the proof run; if one is needed, the proof run is repeated. The handoff records the exact command, start and end time, load average at start and end, the pass line and the load-failure list. GPT additions: the quiet wait also ends as soon as only 75 minutes remain before the deadline; the handoff keeps the original full-suite result separate from the isolated rerun results; missing, interrupted or failing required evidence leaves acceptance unmet, never a pass.
- [L26] [L23] done-condition read as two mutation checks (challenge attempt 2 of 002, P2). `LaunchNameGuard` drives production `InteractiveSessions.run()` and never the fake, so its check is: it fails when `run()` bypasses `conflicting_rows`. The [L15] relaunch-level test fails when the `RelaunchSessions.run` fake bypasses the helper or the helper reverts to the old rule. The handoff records both.
- [L27] `relaunch_conditions` keeps its id-based live check and both published refusal texts ("session <id> is listed '<state>' [with pid <n>]: it may still run" and "session <id> ('<state>') carries the launch name ..."). `ended_row` and `conflicting_rows` serve only the name rule. Done when the existing relaunch refusal tests pass unchanged.
- [L28] Playwright-backed means every class whose fixture runs `PipelineTests.setUp`: PipelineTests, BundleTests, RecordTests and AbandonTests in test_pipeline, every GraphFixture subclass in test_automatic (ClaudeUnavailableTests, ControllerStopTests, ExportAfterVerdictTests, ApprovalStopTests included) and test_panel.GraphRun. The handoff's load-failure record lists them by name.
- [L29] Cook-side note, not this lane's code: the session detects the engine proof run with `pgrep -f '[w]orkflow.run_tests'` on the host and starts no UI launch or verify while it prints anything.

(design challenge attempt 2 of workflow-collected-fixes-002, panel: agreement on revise; Claude bullets plus GPT details; decision dir /home/agentops/.local/state/cook/workflow-collected-fixes/decisions/006-challenge_paused)
