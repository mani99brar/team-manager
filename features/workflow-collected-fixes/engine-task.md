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
