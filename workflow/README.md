# LangGraph workflows

**First feature is configured:** [Projects/workflow viewer](../features/project-workflows/README.md). Start it from Herdr with `.venv/bin/python -m workflow launch project-workflows --live --automatic`; use `--dry-run` to inspect without execution. Automatic mode grants run-scoped worker permission bypass and stops at an independently reviewed, verified feature branch—no main merge or push. Omit `--automatic` to retain manual handoff/review/approval gates.

**Start with [RUNBOOK.md](RUNBOOK.md).** `python -m workflow` now runs the complete supervised pipeline: one interactive Claude worker per configured lane in one Herdr tab, explicit freeze, immutable snapshots, isolated checks/screenshots, combined-candidate checks, independent review, approval and local fast-forward integration. `preflight`/`prepare` do not launch agents; `start --live` is explicitly required.

`report.html` in each run directory provides a local graph/results viewer. The full pipeline is tested offline with fake workers, real Git/unit/Playwright checks, screenshot artifacts, approval gates and forced-check-failure recovery. No live feature run is needed to run the tests.

In automatic mode the independent reviewer is a third native Claude session (`workflow-<run>-reviewer`, read-only tools, its own `Claude: reviewer` pane) that reports its verdict only through a completion file bound to the run, launch token, bundle hash and candidate commit; the controller validates it against `contracts/workflow/reviewCompletion.schema.json`, stops the reviewer with an identity re-check, and never launches a second one. `--reviewer-transport print` keeps the headless fallback. `run-state.json` is exported at version 1.3.0 with `review` and `inputs` sections and the run's lane list for the Projects viewer, and `python -m workflow export <run>` re-exports older runs without launching anything. Details: [RUNBOOK.md](RUNBOOK.md) ("Automatic mode: the review step") and [features/project-workflows/README.md](../features/project-workflows/README.md). Later features: [review-result](../features/review-result/README.md) and [run-inputs](../features/run-inputs/README.md).

The following are building-block/historical slice documentation; the runbook supersedes their statements about unfinished pipeline wiring:
- [INTERACTIVE_SESSIONS.md](INTERACTIVE_SESSIONS.md): native interactive launcher/Herdr attachment.
- [LIVE_SESSIONS.md](LIVE_SESSIONS.md): the removed headless print-mode launcher (historical).
- [VERIFICATION.md](VERIFICATION.md): policy and evidence validation boundaries.

## Setup

From the repository root (Python 3.12 recommended):

```bash
python3 -m venv .venv
.venv/bin/pip install -r workflow/requirements.lock
npm ci
npx --no-install playwright install chromium
.venv/bin/python -m unittest discover -s workflow -t . -v
```

The original two-lane stub lab (`graph.py`, `demo.py`) and the headless print-mode launcher (`live.py`) were removed with the worker-lanes slice; the production pipeline's offline tests cover selective branch recovery. Worker lanes now come from configuration (`features/<name>/feature.json` 2.0.0 and `policy.json` 1.2.0): any number of lanes, each with its task, owned paths, checks and required check kinds; `launch --workers a,b` runs a subset. See [RUNBOOK.md](RUNBOOK.md) and [CHEATSHEET.md](CHEATSHEET.md).

## Files

- `sessions.py`: run preparation (one worktree per selected lane), lane id rules, receipts, locking.
- `interactive.py`: native `claude --bg` launches, Herdr panes (one per lane, reviewer to their right), reconciliation.
- `pipeline.py`: the supervised graph over the plan's lanes, freeze/ownership, verification, candidate, review, approval, integration and the CLI.
- `automatic.py`: unattended supervision, completion signals, the native/print reviewer and its per-run finding vocabulary.
- `verification.py`, `checks.py`: policy validation (required check kinds) and isolated check execution.
- `export_state.py`: the versioned `run-state.json` export (1.3.0) the Projects viewer reads.
- `launch.py`: one-command launch of a committed feature.
- `requirements.txt` / `requirements.lock`: bounded Python dependencies, installed separately from the Node application.

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
