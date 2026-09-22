# Runbook: supervised two-worker LangGraph workflow

**Entry point: `python -m workflow`.** This is the complete operator-driven path. The older `workflow.demo`, `workflow.live` and `workflow.interactive` entry points remain focused development examples, not the full integration workflow.

```text
              launch_ui ─────┐
START ────────               ├─ handoff / freeze ─┬─ verify_ui ──────┐
              launch_adapter ┘                   └─ verify_adapter ┴─ candidate + combined checks
                                                                         │
                                                            independent review (interrupt)
                                                                         │
                                                            integration approval (interrupt)
                                                                         │
                                                             fast-forward source branch
```

## One-command launch for the first feature

The committed Projects-viewer assignment is in [features/project-workflows](../features/project-workflows/README.md). From a clean checkout in Herdr:

```bash
.venv/bin/python -m workflow launch project-workflows --live --automatic
```

This performs preflight, creates a feature branch (not main), prepares worktrees, starts the two interactive workers with run-scoped permission bypass/Bash access, and supervises them through checks and an independent review by a third native Claude session (see [Automatic review session](#automatic-review-session)). The command remains running until it stops on a verified feature branch or a blocker. It never pushes or merges main. Use `--dry-run` instead of `--live` to inspect without execution. Omit `--automatic` for the original manual gates. See the feature README for completion signals, recovery and privilege boundaries.

The profile includes a deliberate first adapter-verification gate failure and a hard limit of three verification attempts per lane/phase. Read the feature README for the exact retry and evidence procedure. Automatic mode adds persisted per-worker deadlines (default 4 hours, `--worker-timeout-seconds`) enforced by the running supervisor and a reviewer process timeout (default 30 minutes, `--review-timeout-seconds`). Interrupting the supervisor leaves the workers running and the run resumable; only deadline expiry or a blocked worker stops them. It does not impose token caps or automatically repair code. Manual mode retains operator-controlled worker lifetimes.

## Guarantees and boundaries

- At most two implementation workers; each is a native interactive Claude background terminal in its own worktree. A dedicated Herdr tab attaches both terminals with keyboard input enabled.
- Exact shared starting Git revision is recorded and verified. Frozen ownership is checked against actual captured files, not just agent reports. The fixed graph requires `ui/frontend` and `adapter/backend` policies; relabelling a worker cannot bypass required tests.
- **Idle is not complete.** The operator gathers handoff summaries/assumptions and explicitly freezes the run. The runtime stops both worker processes before snapshotting. Source ownership violations or uncertain termination block capture.
- Verification runs in fresh worktrees, with separate cache, temp, browser-output and artifact directories. Installed Python/Node/browser executables may be shared read-only; do not share mutable dependency installations.
- Frontend: build plus real Playwright scenarios and a PNG attachment per scenario. Backend: unit tests, plus any configured contract/integration checks. Missing tests, skipped required scenarios, flaky browser retries, nonzero exits and missing/tampered artifacts block the graph.
- Both worker snapshots are checked separately, then the combined integration candidate is checked again. Thus individually passing workers are not sufficient for integration.
- Review is performed by Pi/a fresh reviewer or a human against the exact bundle and candidate. In manual mode the CLI imports that review; it does not spawn an unconfigured Pi model or fabricate independent review. In automatic mode the review node launches its own native reviewer session (read-only tools, its own worktree) and accepts only that session's completion file. Review identity is an operator attestation, not a cryptographic identity service.
- Explicit approval authorizes a **local fast-forward of the original source branch**. Source drift/dirty state blocks it. Nothing pushes, publishes, deletes worktrees, or changes provider/billing plans automatically.
- This is a trusted local development tool, not a sandbox or multi-tenant service. Tests/configuration are executable code. Review policy commands and task ownership before approving a run. CLI/manual terminal input is trusted operator authority.

## Install and validate without launching workers

Tested environment: Linux, Python 3.12, Claude CLI 2.1.278, Herdr 0.9.0, repository Playwright dependencies.

```bash
python3 -m venv .venv
.venv/bin/pip install -r workflow/requirements.lock
npm ci
npx --no-install playwright install chromium

.venv/bin/python -m unittest \
  workflow.test_graph workflow.test_sessions workflow.test_interactive \
  workflow.test_verification workflow.test_pipeline workflow.test_feature_launch workflow.test_automatic workflow.test_export -v
npm run test:contracts
```

The tests use fake workers and mocked native lifecycle controls. The end-to-end test uses real temporary Git worktrees, Python unit tests, headless Chromium, screenshot files, review/approval interrupts and a fast-forward of a **temporary test repository**. It makes no Claude model calls. A second test injects a check failure, reopens checkpoints and verifies that only the failed verification attempt reruns.

## 1. Define and commit the feature contract

Commit shared application types/API expectations and the workflow contract before either worker starts. Define:

- UI and adapter task files, with distinct responsibilities.
- `ui`/`frontend` and `adapter`/`backend` owned path prefixes (no globs or overlaps).
- A verification policy matching `contracts/workflow/verification.schema.json`.
- Tests for the named browser scenarios, following the attachment convention below. These can be part of the workers' deliverables; required test files missing at verification block the run.

`contracts/workflow/verification.example.json` is illustrative, not a runnable feature test suite. Replace its commands/scenarios with the chosen feature's actual acceptance criteria.

Optional policy `setup` is an array of approved `{ "argv": [...], "timeout_seconds": 300 }` commands, run once in every fresh verification worktree. For a Node project this could be `npm ci`; scripts are trusted code, so do not add setup commands casually. Python checks use the controller's virtualenv through PATH. No dependency directories are symlinked between writers/verifiers.

## 2. Preflight and prepare (no model calls)

Use a new run directory outside the source repository. Keep the source clean, and use a named source branch.

```bash
RUN="$HOME/.local/state/md-manager-workflows/my-feature-001"
PY="$PWD/.venv/bin/python"

"$PY" -m workflow preflight "$RUN" --repo "$PWD" --policy /path/to/policy.json --herdr
"$PY" -m workflow prepare "$RUN" --repo "$PWD" --policy /path/to/policy.json \
  --ui-task /path/to/ui-task.txt --adapter-task /path/to/adapter-task.txt
```

Preflight checks policy roles, source cleanliness, CLI flags/authentication and required executables. It does not run the feature's tests or assume future dependencies are already installed. `prepare` creates verified worktrees and pins the policy digest/starting revision/branch. Run configuration is immutable after preparation; change feature requirements by creating a new run.

## 3. Start and interact (explicit model usage)

```bash
"$PY" -m workflow start "$RUN" --live --herdr
```

This is the only initial launch command. Native Claude assigns actual session IDs; receipts and worktree identity bind them to graph nodes. `start` refuses an already-started run. Keep the initial controller call in a persistent terminal to protect startup from SSH disconnects.

Select `Claude: ui` or `Claude: adapter` in the dedicated workflow tab and type normally. Manual permission prompts are yours to answer. File read/edit tools are enabled; shell tools and nested agents are disabled in this training profile. The trusted verifier, not the worker, executes tests later.

Ctrl+Z detaches without stopping the native terminal. Closing a panel only detaches it. To reconnect a worker in an available terminal, use the validated attachment entry point:

```bash
"$PY" -m workflow.interactive attach-one "$RUN" --node ui
```

If `start` was used without `--herdr`, `python -m workflow attach "$RUN"` creates the dedicated tab. Partial/duplicate panel allocations are preserved and reported, not silently replaced.

While workers run, do one independent task outside their worktrees and leave `$RUN/return-note.md` describing the run, independent task, current state and next action.

## 4. Explicit handoff, freeze and verification

Ask each worker for its final summary and open assumptions. The operator saves each handoff as:

```json
{"summary": "Implemented the assigned UI behavior", "open_assumptions": []}
```

Then:

```bash
"$PY" -m workflow freeze "$RUN" \
  --ui-handoff /path/to/ui-handoff.json --adapter-handoff /path/to/adapter-handoff.json
```

Both handoffs are validated **before stopping** workers. Do not continue typing or manually restart workers after freeze. The runtime stops only the recorded native sessions, establishes termination, captures immutable commits with a private Git index, checks ownership, runs checks, creates an integration candidate and rechecks it.

Worker worktree HEADs are not committed/rewritten; private snapshot refs preserve their captured contents. Source branch integration occurs only after the later approval. All partial worktrees, native logs and check evidence remain available on failure.

### Playwright evidence convention

Every required scenario ID must appear in exactly one test title, and its test must attach a screenshot:

```ts
import { test, expect } from '@playwright/test'

test('[scenario:failed-worker] shows a useful error', async ({ page }, testInfo) => {
  await page.goto(process.env.WORKFLOW_TEST_URL!) // use your isolated local test server
  // Drive and assert the real feature behavior here.
  await expect(page.getByText('Worker failed')).toBeVisible()
  const image = testInfo.outputPath('failed-worker.png')
  await page.screenshot({ path: image, fullPage: true })
  await testInfo.attach('screenshot:failed-worker', { path: image, contentType: 'image/png' })
})
```

The runner adds `--reporter=json`, an isolated `--output`, `--workers=1`, and `--retries=0`, and controls `PLAYWRIGHT_JSON_OUTPUT_FILE`. These trusted additions are recorded separately as `effective_commands`; the v1 command field retains the approved policy argv. Use a distinct scenario ID for each viewport/project variant. Failed/skipped/flaky cases do not satisfy required scenarios. No automatic screenshot is substituted for a missing attachment.

Have your Playwright config start/stop an isolated local web server on a nonconflicting port. Workers are stopped before checks, but the two verification lanes can execute concurrently. Never reuse a developer's existing server and call it isolated verification. Process groups are terminated after each check, including timeout cleanup.

Python unittest and Node TAP/spec summaries are supported for non-browser test counts. Unsupported/custom test reporters produce missing test evidence and block rather than infer success. Browser assertions/reporting and screenshot inspection remain the reviewer's responsibility; PNG headers/hashes do not prove visual quality.

## 5. Review the exact candidate

Successful verification interrupts at `independent_review` and produces:

- `review-bundle.json`: frozen revisions, policy digest and packet hashes.
- `verification/worker/.../packet.json`: worker checks, logs, screenshots, file lists and assumptions.
- `verification/candidate/.../packet.json`: checks of the combined candidate. These are candidate-verification records, not per-worker ownership claims.
- `candidate/`: clean candidate worktree for read-only inspection.
- `report.html`: local visual graph, pending state/errors, timeline, checks and artifact/screenshot links.
- `run-state.json`: atomic, versioned private state export for the read-only project adapter; created during preparation and updated at reporting boundaries. Export 1.1.0 added the `review` section (the recorded verdict, findings, reviewer session and diff hash) and 1.2.0 the `inputs` section (feature, branch, automatic settings, each worker's task text, ownership, checks, launch receipt, completion signal, handoff and stop marker). `workflow export "$RUN"` rebuilds it for older runs.
- `failure-drill.json` / `failure-report.json`: pre/post launch identities and observed verification attempts when the explicit lab drill is configured.

Ask Pi to assign an independent read-only reviewer against these exact artifacts. If the reviewer needs to run commands, give it another isolated worktree; do not let it mutate the captured candidate/check worktrees. The review JSON is:

```json
{
  "run_id": "my-feature-001",
  "bundle_sha256": "<SHA-256 of review-bundle.json>",
  "candidate_commit": "<candidate SHA from bundle>",
  "reviewer": "<independent Pi review run ID or human identity>",
  "independent": true,
  "verdict": "approved",
  "findings": []
}
```

Findings, if present, contain `severity` (`P0`, `P1`, `P2`), `message`, and `disposition` (`open`, `resolved`, `accepted`). P0/P1 must be resolved. Do not relabel a rejected review as approved. Code changes require new snapshots, verification and review—start a revised run rather than mutate an approved bundle.

```bash
"$PY" -m workflow review "$RUN" --review-file /path/to/independent-review.json
```

Review does not integrate. The graph then waits at a separate approval interrupt.

### Automatic review session

In automatic mode the review node does not wait for `workflow review`. It creates `review-worktree/` at the candidate commit, writes `review.diff`, and launches a third native session, `claude --bg --name workflow-<run>-reviewer`, in that worktree with the workers' lifecycle but reviewer tools: Read, Glob and Grep, plus Write allow-listed to exactly one path, `<run>/review.completion.json`. Permission mode is `dontAsk`, so any other write is denied; the worktree and evidence hashes are re-checked after the review regardless. The run directory is an added directory so the reviewer can read packets, screenshots and the diff.

If the run has a Herdr tab (`terminals.json`), a third pane `Claude: reviewer` is split off the adapter pane and attached the same way as the workers. You can type into it: answer a question, point the reviewer at a file. The transcript is the record; the verdict is only the completion file. A pane that fails to attach is recorded in the timeline and does not affect the verdict; reconnect with `workflow.interactive attach-one "$RUN" --node review`.

The allow rule is spelled `Edit(...)` because Write follows Edit rules; a `Write(...)` rule is silently ignored (the first live smoke test ended with the reviewer unable to write its verdict). A reviewer that ends a turn asking a person shows as `blocked` in `claude agents`; the controller records that once in the timeline and keeps waiting until the deadline, so an answer typed in the pane can still lead to the completion file.

Completion protocol (`contracts/workflow/reviewCompletion.schema.json`): the file must validate, name this run, the exact `review-bundle.json` SHA-256 and candidate commit, carry the reviewer's own session UUID (which must differ from both worker UUIDs), and hold a verdict (`approved` or `blocked`) with findings `{severity, message, disposition, worker, requirement}`. `worker` says which assignment a finding concerns (`ui`, `adapter`, `both`, `none`) and `requirement` quotes the task text verbatim or is null. The file is accepted only once the session is `idle` or `done`; idle without a file is not a verdict. Acceptance stops the session (`claude stop`, identity re-checked, `review.stop.json`) and writes `review.json` for either verdict; a blocked verdict or an unresolved P0/P1 ends the run with evidence retained.

Bounds and recovery: one review per bundle, `review_timeout_seconds` from the reviewer's launch (default 30 minutes, `--review-timeout-seconds`). At the deadline the reviewer is stopped and the run is blocked; no second reviewer is launched, and a rejected file (wrong bundle, wrong candidate, wrong or worker UUID, schema violation) blocks the same way. Interrupting the supervisor during the review leaves the reviewer running; `workflow automatic "$RUN" --live` reconciles the same session from `review.interactive.json` and keeps waiting. The transcript stays resumable afterwards like a worker's: `cd "$RUN/review-worktree" && claude --resume <reviewer uuid>`.

`--reviewer-transport print` keeps the previous headless `claude --print` reviewer (structured output, no pane, same acceptance rules) for environments without an attachable terminal. Runs prepared before this transport existed are treated as print-mode runs.

Files: `automatic-review.json` (transport, bundle/patch hashes, status, the accepted review), `review.interactive.json` (launch receipt with the native UUID), `review.launch.log`, `review.completion.json`, `review.stop.json`, `review.json`, `review.diff`, `review-worktree/`; print mode adds `review.stdout.json` and `review.stderr.log`.

## 6. Approve local integration

```bash
"$PY" -m workflow approve "$RUN" --bundle-sha256 <exact-reviewed-bundle-hash>
```

This explicitly authorizes a fast-forward of the original source branch. It checks review, packet/artifact hashes, source branch identity, clean source state and unchanged starting HEAD again. No push occurs. Do not allow another writer in the source checkout during this operation.

## Status, failures and recovery

```bash
"$PY" -m workflow status "$RUN"
```

Status refreshes `report.html`. It is a local snapshot viewer, not a live multi-user HTTP dashboard. Open it where its relative artifact files are accessible, or use your trusted SSH/local file-viewing setup; do not publish the run directory or logs. There are no unauthenticated HTTP execution controls.

- **Failed verification:** inspect its packet/log. Attempts default to a hard limit of three per lane/phase; policy v1.1.0 can explicitly set `max_verification_attempts`. For a transient check/environment failure at the same immutable revision, explicitly retry only that lane:
  `python -m workflow retry "$RUN" --phase worker --node adapter`.
- **Failed combined check:** use `--phase candidate --node ui` (or adapter). Already successful candidate checks are reused after artifact validation.
- **Failure after stopping/snapshotting or integrating:** `retry "$RUN"` resumes only failed graph steps; it never launches a new Claude worker. Stop-intent recovery checks whether the prior stop already completed before issuing another native stop.
- **Ambiguous startup:** inspect receipts/native inventory, then `reconcile "$RUN"`. It only permits existing durable launch intents and exact surviving sessions; no new native process is launched during reconciliation. Missing proof remains blocked.
- **Changed code/policy:** create a new run. Do not modify frozen snapshots/evidence and reuse approvals.
- **Partial candidate/worktree allocation:** preserve and inspect it. Automatic destructive cleanup or speculative Git conflict resolution is intentionally unavailable.
- **Usage exhausted:** workers stay at the manual terminal/handoff boundary. Preserve their receipts/worktrees, record the decision, and ask the owner to wait or approve a new plan/provider. The system never switches to another payment/provider mode or replays an opaque Claude workflow automatically.
- **Stopping an unfinished run:** use the exact native IDs from its receipts with Claude's `stop` command after verifying identity. Closing Herdr alone is not a stop. All run artifacts/worktrees are retained; cleanup is a separate operator decision.
- **Re-exporting a run:** `python -m workflow export "$RUN"` rebuilds `run-state.json` under the current export version from the persisted run files. It takes the controller lock, launches nothing, and refuses a run whose `plan.json`, `policy.json` or `review.json` fail validation.

The two-worker limit is a training constraint, not an optimality claim. Selective check recovery is tested independently of Claude's own workflow-relaunch semantics.
