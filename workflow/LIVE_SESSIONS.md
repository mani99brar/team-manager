# LangGraph-owned Claude sessions with passive Herdr panels

This is an initial live-launch slice, separate from the original stub demo. LangGraph launches two independent Claude processes in verified Git worktrees. Herdr runs only observers. No Pi subagent runner is used for execution.

## Ownership

```text
Python controller / LangGraph
  ├─ ui node      → Claude UUID → worktree-ui
  └─ adapter node → Claude UUID → worktree-adapter
            ↓ private persisted streams/receipts
Herdr panes → python -m workflow.observer ... (read only)
```

Closing an observer or disconnecting a Herdr client does not signal Claude. Graceful SIGINT/SIGTERM to the **controller** cancels its child process groups and preserves partial work. Run the controller in a persistent terminal session to survive SSH disconnection; it is not a daemon. After an abrupt controller death, a child may still be running. Existing launching/running/blocked receipts prevent blind relaunch. PIDs are diagnostic, not sufficient authority to kill or reattach processes after a restart.

## Prepare and launch

Use a trusted clean repository with the shared contract committed. Install dependencies as described in README.md. Run all commands from this source checkout with the same Python environment:

```bash
# Put two scoped task prompts in files outside the repository.
# Each should name file ownership, acceptance criteria and stop conditions.
python -m workflow.live prepare /absolute/path/outside-repo/my-run \
  --repo "$PWD" --base HEAD \
  --ui-task /path/to/ui-task.txt --adapter-task /path/to/adapter-task.txt

# Explicitly authorizes Claude usage. Defaults to read-only tools.
python -m workflow.live run /absolute/path/outside-repo/my-run --live --herdr

python -m workflow.live status /absolute/path/outside-repo/my-run
```

`prepare` creates the run directory, resolves the exact commit, journals both worktree allocations, verifies their clean HEADs and allocates separate Claude UUIDs. Partial allocations are retained on error, never destructively cleaned up. The run plan, prompts and logs live in a private mode-0700 directory. Use unique run directory names.

`--allow-edits` is an explicit **prepare-time** option. Default tools: Read/Glob/Grep. With edits: Read/Glob/Grep/Edit/Write. Shell execution, nested agents and MCP servers are not enabled. Claude `--safe-mode` disables customizations/hooks; `--permission-prompts none` avoids unattended permission dialogs. Installed CLI must support these flags (tested with the local CLI, inspect `claude --help`). Authentication is the CLI's existing auth/environment; the launcher never changes provider, model or payment plan.

This is not an OS sandbox: Git worktrees isolate tracked edits, not arbitrary filesystem access. Task ownership is currently a prompt boundary, not enforced path-level authorization. Keep live edit mode for trusted tasks until ownership enforcement and evidence gates are implemented. There is no arbitrary extra-arguments escape hatch or bypass-permissions flag.

## Herdr observers

`--herdr` requires `HERDR_ENV=1`, so invoke it from an actual Herdr-managed pane. The adapter discovers the caller's workspace and creates one dedicated tab named `Workflow: <run-name>` with `--no-focus`. It uses that tab's root pane for the UI observer and splits it to the right for the adapter observer, running **only** `workflow.observer` in both. All worker observers for a run stay together in that tab; the caller's tab is not split or repurposed. Pane and tab IDs are retained in `observers.json`.

Observer mappings are saved to `observers.json`. Opening a second set automatically is refused. If partial panel setup fails, inspect the mapping and panes; preserve the mapping and close only the panes you own before deliberately retrying. Herdr command failures do not authorize launching Claude through Herdr instead.

Observers render assistant text, tool names, final output and persisted lifecycle status. Control/escape sequences are stripped from displayed text. Completion/block notifications are best-effort, never execution authority. Raw files may contain private model/tool output; this is a local private viewer, not a redacted public API.

You can open observers separately (before or during a run, subject to controller lock):

```bash
python -m workflow.live observe /absolute/path/outside-repo/my-run
# Or reopen a single passive observer manually in an available pane:
python -m workflow.observer /absolute/path/outside-repo/my-run ui
```

The CLI `observe` action takes the controller lock and cannot create panes during an active controller run. The standalone observer can attach anytime; it takes no lifecycle lock and writes no run state. Ctrl-C in that observer only exits the observer.

## Recovery and results

- Successful session receipts are reused only with an unchanged plan digest.
- An OS exit code of 0 alone is insufficient: require a matching session UUID and successful terminal Claude result.
- Failed, timed out or ambiguous launches block further automatic execution. Usage/auth/permission errors preserve output and require owner reconciliation; there is no fallback plan/provider or automatic retry.
- A filesystem run lock prevents simultaneous CLI controllers. Direct library callers must use `run_lock` too.
- `*.patch` captures tracked diffs; untracked files remain in retained worktrees and are listed in the receipt's Git status.
- Session receipt success means **Claude finished**, not task acceptance. These internal receipts are not v1 `WorkerResult` evidence.
- The graph stops at `verification_required` after both sessions finish. Repeating `run --live` there does not launch new workers. There is intentionally no approve/merge command yet.

Still to implement: contract-complete worker results and immutable artifacts; required shell/browser checks in isolated validation environments; fresh Pi review and approved integration; safe operator reconciliation/retry; runtime UI/event API. The existing stub failure demo remains useful for checking LangGraph selective branch recovery, but is not evidence of live Claude retry behavior.

## Checks

```bash
python -m unittest workflow.test_sessions workflow.test_graph -v
```

Tests use a fake executable for deterministic process lifecycle coverage. A live smoke test additionally exercised two authenticated, read-only Claude sessions from LangGraph and real Herdr observers. Both read the shared contract heading, exited successfully with distinct UUIDs, left worktrees clean, and reached the verification interrupt. Re-invoking the run did not relaunch them. No implementation/browser checks or merge were claimed by this smoke test.
