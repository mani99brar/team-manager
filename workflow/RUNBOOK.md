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

This performs preflight, creates a feature branch (not main), prepares worktrees, starts the two interactive workers with run-scoped permission bypass/Bash access, and supervises them through checks and independent automated review. The command remains running until it stops on a verified feature branch or a blocker. It never pushes or merges main. Use `--dry-run` instead of `--live` to inspect without execution. Omit `--automatic` for the original manual gates. See the feature README for completion signals, recovery and privilege boundaries. The later features `review-result` and `run-inputs` launch the same way (`features/<feature>/README.md`); `--run-id` defaults to `<feature>-001` and the run root to `~/.local/state/md-manager-workflows/<feature>`.

The profile includes a deliberate first adapter-verification gate failure and a hard limit of three verification attempts per lane/phase. Read the feature README for the exact retry and evidence procedure. Automatic mode adds persisted per-worker deadlines (default 4 hours, `--worker-timeout-seconds`) enforced by the running supervisor and a reviewer deadline (default 30 minutes, `--review-timeout-seconds`, counted from the reviewer's launch). Interrupting the supervisor leaves the workers running and the run resumable; only deadline expiry or a blocked worker stops them. It does not impose token caps or automatically repair code. Manual mode retains operator-controlled worker lifetimes. The independent review runs as a third native session by default; `--reviewer-transport print` keeps the headless `claude --print` reviewer for environments without Herdr (see "Automatic mode: the review step").

## Guarantees and boundaries

- At most two implementation workers; each is a native interactive Claude background terminal in its own worktree. A dedicated Herdr tab attaches both terminals with keyboard input enabled.
- Exact shared starting Git revision is recorded and verified. Frozen ownership is checked against actual captured files, not just agent reports. The fixed graph requires `ui/frontend` and `adapter/backend` policies; relabelling a worker cannot bypass required tests.
- **Idle is not complete.** The operator gathers handoff summaries/assumptions and explicitly freezes the run. The runtime stops both worker processes before snapshotting. Source ownership violations or uncertain termination block capture.
- Verification runs in fresh worktrees, with separate cache, temp, browser-output and artifact directories. Installed Python/Node/browser executables may be shared read-only; do not share mutable dependency installations.
- Frontend: build plus real Playwright scenarios and a PNG attachment per scenario. Backend: unit tests, plus any configured contract/integration checks. Missing tests, skipped required scenarios, flaky browser retries, nonzero exits and missing/tampered artifacts block the graph.
- Both worker snapshots are checked separately, then the combined integration candidate is checked again. Thus individually passing workers are not sufficient for integration.
- Review is performed by Pi/a fresh reviewer or a human against the exact bundle and candidate. The CLI imports that review; it does not spawn an unconfigured Pi model or fabricate independent review. Review identity is an operator attestation, not a cryptographic identity service.
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

The tests use fake workers, a fake reviewer session and mocked native lifecycle controls. The end-to-end test uses real temporary Git worktrees, Python unit tests, headless Chromium, screenshot files, review/approval interrupts and a fast-forward of a **temporary test repository**. It makes no Claude model calls. A second test injects a check failure, reopens checkpoints and verifies that only the failed verification attempt reruns. The automatic tests run once with the native reviewer protocol and once with the print-mode fallback, including a controller interrupted while waiting for the reviewer and every rejected completion file.

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
- `run-state.json`: atomic, versioned private state export for the upcoming read-only project adapter; created during preparation and updated at reporting boundaries.
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

Findings, if present, contain `severity` (`P0`, `P1`, `P2`), `message`, and `disposition` (`open`, `resolved`, `accepted`), optionally `worker` (`ui`, `adapter`, `both`, `none`) and `requirement` (a verbatim quote from that worker's task text in `plan.json`, or null) so the viewer can link a finding to the task it concerns. P0/P1 must be resolved. Do not relabel a rejected review as approved. Code changes require new snapshots, verification and review—start a revised run rather than mutate an approved bundle.

```bash
"$PY" -m workflow review "$RUN" --review-file /path/to/independent-review.json
```

Review does not integrate. The graph then waits at a separate approval interrupt.

### Automatic mode: the review step

In an automatic run the review node launches the reviewer itself, once per bundle, and waits for its verdict exactly as it waits for worker completion signals:

- **Native reviewer session (default).** `claude --bg --name workflow-<run>-reviewer` starts in `$RUN/review-worktree/` (a detached checkout of the candidate commit) with tools Read, Glob, Grep and Write, permission mode `dontAsk`, no MCP servers, the run directory added as a readable path, and a single allowed write: `$RUN/review.completion.json`. The receipt is `review.interactive.json` (same keys as a worker receipt plus `candidate_commit`), the prompt is kept in `review.prompt.txt`, the launch output in `review.launch.log`. Its session UUID is recorded in the timeline (`Reviewer session <uuid> launched; awaiting review.completion.json`) and must differ from both worker UUIDs.
- **Third pane.** When the run's Herdr tab exists, a `Claude: reviewer` pane is split to the right of the adapter pane and attaches with `attach-one --node review`. You can answer a question the reviewer asks there, exactly as for workers; the transcript is the record, the verdict is only the file. A missing pane never fails the review; `python -m workflow.interactive attach-one "$RUN" --node review` reconnects in any available terminal, and `attach` adds the pane when the reviewer already exists, also to a workflow tab whose worker panes were attached earlier.
- **Completion protocol.** The reviewer writes `review.completion.json` once, as its last action, then ends its turn. The controller accepts the file only when it validates against `contracts/workflow/reviewCompletion.schema.json`, its `run_id`, `node_id: "review"`, `launch_token`, `bundle_sha256` and `candidate_commit` match the run, the session is `idle` or `done`, the reviewer identity is unchanged and independent, and the review worktree, bundle and `review.diff` hashes are unchanged. Findings carry `worker` and `requirement`. Any rejected file blocks the run with the reason in `automatic-review.json`; nothing is relaunched.
- **Verdict.** `review.json` is written for every verdict. `approved` with no unresolved P0/P1 finding continues to the verified feature branch; `blocked`, or an approval that still carries an unresolved P0/P1 (recorded as `verdict: "blocked"` with the reviewer's raw decision kept in `automatic-review.json`), ends the run. Fixing findings means a new run with a new bundle.
- **Deadline.** `review_timeout_seconds` counts from the reviewer's launch (`launch_requested_at`) and survives controller restarts. A reviewer that idles without a file until the deadline blocks the run; **no second reviewer is ever launched**.
- **Stop.** After acceptance or a block the controller stops the reviewer with the same identity re-check as for workers (`review.stop.json`); the transcript stays resumable. A stop that cannot be confirmed after acceptance ends the controller with the verdict kept (`automatic-review.json` stays `succeeded`, `review.stop.json` absent or unconfirmed, the reason on the timeline); `python -m workflow automatic "$RUN" --live` retries the stop before continuing and launches nothing.
- **Interruption.** Ctrl-C, a closed terminal or a dropped SSH session while the controller waits leaves the reviewer running with `automatic-review.json` at `running`; `python -m workflow automatic "$RUN" --live` resumes waiting for the same session's file. The same holds inside the launch window once `claude --bg` was issued (`review.interactive.json` exists): the receipt is `running`, without `session_id` when the interrupt hit the settle poll, and resume first binds that one session through reconciliation, never a relaunch. An interrupt before the launch was issued leaves `needs_reconciliation`.
- **Print fallback.** `--reviewer-transport print` (at `launch` or `prepare`, pinned into `plan.automatic`) keeps the headless `claude --print --json-schema` reviewer: no pane, no human input, `review.stdout.json`/`review.stderr.log`, the same bundle binding and verdict rules. Plans pinned before the setting existed validate as `native` (they never launch a new reviewer); their exported inputs report the transport their recorded review used, or null.

To read or continue a reviewer's transcript after the run:

```bash
cd "$RUN/review-worktree" && claude --resume <reviewer-uuid>
```

The UUID is `session_id` in `$RUN/review.interactive.json` (or `reviewer` in `review.json`). Claude keeps transcripts under `~/.claude/projects/<encoded worktree path>/<uuid>.jsonl`, keyed by the worktree the session ran in, which is why the resume must start from `review-worktree`.

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

```bash
"$PY" -m workflow export "$RUN"
```

Export rebuilds `run-state.json` from the run directory under the current export version (1.2.0: the `review` and `inputs` sections the Projects viewer reads, see the feature README's runtime storage seam). It takes the controller lock, reads the persisted checkpoint without invoking any node, constructs no sessions (a copied run whose worktrees are gone still exports), launches nothing, and refuses a run whose `plan.json`, pinned policy or `review.json` fail validation. Unchanged content does not bump `updated_at`. Run it on runs recorded before a newer export version, such as project-workflows-001, so the viewer shows their review and inputs.

- **Failed verification:** inspect its packet/log. Attempts default to a hard limit of three per lane/phase; policy v1.1.0 can explicitly set `max_verification_attempts`. For a transient check/environment failure at the same immutable revision, explicitly retry only that lane:
  `python -m workflow retry "$RUN" --phase worker --node adapter`.
- **Failed combined check:** use `--phase candidate --node ui` (or adapter). Already successful candidate checks are reused after artifact validation.
- **Failure after stopping/snapshotting or integrating:** `retry "$RUN"` resumes only failed graph steps; it never launches a new Claude worker. Stop-intent recovery checks whether the prior stop already completed before issuing another native stop.
- **Ambiguous startup:** inspect receipts/native inventory, then `reconcile "$RUN"`. It only permits existing durable launch intents and exact surviving sessions; no new native process is launched during reconciliation. Missing proof remains blocked.
- **Changed code/policy:** create a new run. Do not modify frozen snapshots/evidence and reuse approvals.
- **Partial candidate/worktree allocation:** preserve and inspect it. Automatic destructive cleanup or speculative Git conflict resolution is intentionally unavailable.
- **Usage exhausted:** workers stay at the manual terminal/handoff boundary. Preserve their receipts/worktrees, record the decision, and ask the owner to wait or approve a new plan/provider. The system never switches to another payment/provider mode or replays an opaque Claude workflow automatically.
- **Stopping an unfinished run:** use the exact native IDs from its receipts (`ui`, `adapter` and, in automatic mode, `review.interactive.json`) with Claude's `stop` command after verifying identity. Closing Herdr alone is not a stop. All run artifacts/worktrees are retained; cleanup is a separate operator decision.
- **Reviewer needs reconciliation:** `automatic-review.json` at `needs_reconciliation` or `blocked` never relaunches a reviewer. Inspect `review.interactive.json`, `review.launch.log` and `claude agents --json`, stop a stray reviewer by its exact ID, and start a new run for a fresh review.

The two-worker limit is a training constraint, not an optimality claim. Selective check recovery is tested independently of Claude's own workflow-relaunch semantics.
