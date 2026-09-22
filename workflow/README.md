# LangGraph workflows

**First feature is configured:** [Projects/workflow viewer](../features/project-workflows/README.md). Start it from Herdr with `.venv/bin/python -m workflow launch project-workflows --live --automatic`; use `--dry-run` to inspect without execution. Automatic mode grants run-scoped worker permission bypass and stops at an independently reviewed, verified feature branch—no main merge or push. Omit `--automatic` to retain manual handoff/review/approval gates.

**Start with [RUNBOOK.md](RUNBOOK.md).** `python -m workflow` now runs the complete supervised pipeline: two interactive Claude workers in one Herdr tab, explicit freeze, immutable snapshots, isolated checks/screenshots, combined-candidate checks, independent review, approval and local fast-forward integration. `preflight`/`prepare` do not launch agents; `start --live` is explicitly required.

`report.html` in each run directory provides a local graph/results viewer. The full pipeline is tested offline with fake workers, real Git/unit/Playwright checks, screenshot artifacts, approval gates and forced-check-failure recovery. No live feature run is needed to run the tests.

In automatic mode the independent reviewer is a third native Claude session (`workflow-<run>-reviewer`, read-only tools, its own `Claude: reviewer` pane) that reports its verdict only through a completion file bound to the run, launch token, bundle hash and candidate commit; the controller validates it against `contracts/workflow/reviewCompletion.schema.json`, stops the reviewer with an identity re-check, and never launches a second one. `--reviewer-transport print` keeps the headless fallback. `run-state.json` is exported at version 1.2.0 with `review` and `inputs` sections for the Projects viewer, and `python -m workflow export <run>` re-exports older runs without launching anything. Details: [RUNBOOK.md](RUNBOOK.md) ("Automatic mode: the review step") and [features/project-workflows/README.md](../features/project-workflows/README.md). Later features: [review-result](../features/review-result/README.md) and [run-inputs](../features/run-inputs/README.md).

The following are building-block/historical slice documentation; the runbook supersedes their statements about unfinished pipeline wiring:
- [INTERACTIVE_SESSIONS.md](INTERACTIVE_SESSIONS.md): native interactive launcher/Herdr attachment.
- [LIVE_SESSIONS.md](LIVE_SESSIONS.md): optional headless print-mode launcher/log panes.
- [VERIFICATION.md](VERIFICATION.md): policy and evidence validation boundaries.

## Original recovery lab (stub executors)

This first graph proves independent branches, durable checkpoints, a join, and human approval. It does **not** launch Claude, create worktrees, run a browser, perform an agent review, merge commits, or publish UI events yet. Gate labels and results explicitly identify stub evidence. Approval completes only the simulation.

```text
START ─┬─ ui ────── browser_gate ─┐
       └─ adapter ─ adapter_gate ─┴─ review ─ integrate (interrupt) ─ END
```

## Setup

From the repository root (Python 3.12 recommended):

```bash
python3 -m venv .venv
.venv/bin/pip install -r workflow/requirements.txt
.venv/bin/python -m unittest workflow.test_graph -v
```

## Forced-failure experiment

Use a fresh run ID. Each invocation can be a separate process/SSH session:

```bash
.venv/bin/python -m workflow.demo start --run-id lab-001 --fail-adapter-once
# Expected exit 1: adapter's first attempt fails.
.venv/bin/python -m workflow.demo status --run-id lab-001
.venv/bin/python -m workflow.demo resume --run-id lab-001
# Expected: UI starts = 1, adapter starts = 2; approval interrupt.
.venv/bin/python -m workflow.demo approve --run-id lab-001
.venv/bin/python -m workflow.demo status --run-id lab-001
```

Omit `--fail-adapter-once` for a happy-path run. Runtime files live in ignored `.workflow-state/`, configurable with `--data-dir`. Keep the same data directory and run ID to resume. Only one controller process may operate on a given run at a time; distributed locking is not implemented.

`checkpoints.sqlite` stores LangGraph checkpoints/pending writes. `attempts.sqlite` separately records actual worker starts even when the graph superstep fails. A new graph instance can reopen the databases and reuse the successful UI result. This is LangGraph recovery, not Claude workflow relaunch semantics. The ledger is diagnostic, not an exactly-once external-session manager.

## Files

- `graph.py`: state, graph wiring, synthetic workers, placeholder verification/review, approval interrupt, durable attempt ledger.
- `demo.py`: start/resume/status/approve commands with a persistent thread ID.
- `test_graph.py`: failure/recovery across graph recreation, successful sibling reuse, happy path, rejected approval.
- `requirements.txt`: bounded Python dependencies, installed separately from the Node application.

## Contract integration and next steps

Stub worker payloads validate against `contracts/workflow/workerResult.schema.json`. They use the base revision as the output revision because no files change, and explicitly report no checks/artifacts. The demo reads repository HEAD; it does not establish real worker start-revision verification. Schema checks and the simple join are not full production acceptance.

Before replacing stubs with independent Claude sessions:

1. Accept and validate `runSpec`, implement all cross-field contract rules, create/verify isolated worktrees at the pinned contract revision, and enforce path ownership.
2. Implement a runner adapter with durable session identity, reconnect/reconciliation and partial-result capture. Do not blindly relaunch an external agent after a checkpoint replay.
3. Implement browser/test gates with preserved evidence and a fresh-context review session in an isolated worktree; reserve integration for Pi.
4. Persist contract events/artifacts, expose snapshots and authorized controls, and enforce replay/idempotency rules for the UI.
5. Add usage-exhaustion pause/approval policy, safe cancellation and return-note recording. Herdr can monitor sessions, but cannot replace persisted workflow state.
6. Pin a fully resolved dependency lock before production deployment.

The runtime is deliberately separate from the current app; no web server routes or UI behavior have changed.
