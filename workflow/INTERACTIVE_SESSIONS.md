# Interactive Claude workers in a dedicated Herdr tab

This is the preferred path when you want to **type into Claude**, not view streamed logs. It uses Claude Code's native persistent background terminals (tested with CLI 2.1.278).

```text
LangGraph launch_ui      → claude --bg → persistent UI terminal/worktree
LangGraph launch_adapter → claude --bg → persistent adapter terminal/worktree
                                     ↑
Herdr workflow tab → claude attach <id> in each pane (keyboard input enabled)
```

Herdr attaches to terminals that LangGraph already launched. It does not submit the initial tasks, launch replacement workers, or decide that work is accepted. Claude's background service owns the persistent PTY/process; LangGraph owns the launch intent, task/worktree binding and workflow checkpoints.

## Start a run

From this source checkout, with the workflow Python environment active:

```bash
python -m workflow.interactive prepare /path/outside-repo/my-run \
  --repo "$PWD" --base HEAD \
  --ui-task /path/to/ui-task.txt --adapter-task /path/to/adapter-task.txt \
  --allow-edits

python -m workflow.interactive run /path/outside-repo/my-run --live --herdr
python -m workflow.interactive status /path/outside-repo/my-run
```

Source repository must be clean and the shared contract must exist at the pinned revision. Both worktrees are created at that exact commit. Do not reuse a print-mode run directory: interactive sessions are new native terminals, not conversions of completed `--print` conversations.

`--live` authorizes Claude usage. `--allow-edits` enables Read/Glob/Grep/Edit/Write; omit it for read-only tools. Permission mode is **manual**, so you can answer permission prompts yourself. Shell tools and nested agents remain disabled in this initial slice. No bypass-permissions mode or automatic provider/budget fallback is configured. This is worktree isolation, not an OS sandbox.

## Use the panels

A dedicated `Workflow: <run-name>` tab contains `Claude: ui` and `Claude: adapter`. Your original tab is not split and focus is preserved. Select either worker pane and type at Claude's normal prompt. In an automatic pipeline run a third pane, `Claude: reviewer`, is added to the same tab when the review node launches its native reviewer session (see `RUNBOOK.md`, "Automatic review session"); `attach-one --node review` reconnects it.

- **Ctrl+Z** detaches to the pane's shell; Claude documents that the background session keeps running.
- Closing the attachment pane does not intentionally stop the worker. A client/SSH disconnect should leave the native background session available to reattach; recovery still verifies its identity.
- **Ctrl+C inside Claude** can interrupt its current turn. This is deliberately real interactive control, not a read-only viewer.
- Do not type `/exit` unless you mean to end the native worker session. Exited/missing/uncertain workers require reconciliation, not blind restart.
- Direct human messages consume Claude usage and can change work outside a LangGraph node execution. They are recorded by Claude, not individually checkpointed as LangGraph state transitions. Do not assume the graph knows those instructions or has validated their results.

To reconnect in an available terminal:

```bash
python -m workflow.interactive attach-one /path/outside-repo/my-run --node ui
```

This validates the native session ID, worktree, name, live inventory state and PID before `exec`-ing `claude attach`. A terminal is required. Never type this command into a pane already occupied by another program. The programmatic pane adapter also checks that only the pane's shell is in the foreground before submitting a command.

To create the dedicated tab after launching without `--herdr`:

```bash
python -m workflow.interactive attach /path/outside-repo/my-run
```

The recorded `terminals.json` prevents automatically opening duplicate attachments. A failed partial layout is retained for inspection. To deliberately replace the two old, idle log observers, supply `--reuse-observers /old/run/observers.json` to `attach` or to `run --live --herdr`. The adapter checks distinct pane identities, same dedicated tab/current workspace, and shell availability, then records the ownership transfer. It never closes or repurposes an unrelated pane.

## Identity and recovery

Native `--bg` **ignores `--session-id`** and assigns its own ID. The `session_id` reserved in the common preparation plan is therefore a launch token for interactive mode, not the final Claude identity. The launcher writes intent before calling Claude, retains its stdout/stderr, extracts the ID from that launch receipt, and resolves the exact UUID through `claude agents --json`. It cross-checks the worktree and launch name. Actual IDs live in `*.interactive.json` and `terminals.json`.

If the controller fails after launching, rerunning may reconcile the **same** terminal from the retained launch ID and native inventory. It does not launch again when an existing receipt lacks conclusive evidence. Neither a guessed UUID nor a name-only match is sufficient. CLI output format changes or unsupported states fail closed.

`done` in the native inventory means a finished model turn, not necessarily an exited process. Attachment requires a live native PID in addition to the matching session/worktree identity. A final existence check cannot eliminate every race between checking and native attach; do not concurrently stop/restart sessions while attaching. PIDs are not used as authority to kill processes.

## Workflow handoff

The graph has two independent **launch** nodes and then interrupts at `interactive_workers_active`. Finishing a launch node does not mean the implementation is finished. Neither idle/done state nor human typing triggers integration. The implementation does not yet offer a final evidence/verification/approval command, automated stop, or merge.

Before integration is added, we still need to freeze further terminal edits, capture contract-complete results, run isolated tests/browser checks and obtain independent review. There is no claim of successful verification from these launch receipts.

## Validation

```bash
python -m unittest workflow.test_interactive workflow.test_sessions workflow.test_graph -v
```

Coverage includes native launch flags, assigned-ID binding, exact surviving-session reconciliation, refusal to retry ambiguous launches, identity/worktree checks, occupied-pane rejection, dedicated-tab attachment and the human-handoff interrupt. Live testing launched two native background workers via LangGraph, reconciled their assigned IDs without additional launches, and verified real `claude attach` processes and interactive prompts in the existing workflow tab.

`workflow.live` / `LIVE_SESSIONS.md` remain the separate headless print-mode/log-viewer path. They are not the interactive terminal path.
