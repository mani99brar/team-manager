# Runbook: supervised multi-lane LangGraph workflow

**Entry point: `python -m workflow`.** This is the complete operator-driven path, for md-manager or any other Git repository (the target: `--repo`, else the current directory when it is a Git repository with `features/`, else md-manager; see [README.md](README.md#use-it-in-another-project)). `workflow.interactive` keeps only `attach-one`, which the Herdr panes run.

Worker lanes come from configuration. A feature declares any number of lanes (`<target>/features/<feature>/feature.json` 2.0.0, 2.1.0 or 2.2.0, one `{node_id, task}` per lane; `policy.json` 1.2.0 with each lane's `role` label, `owned_paths`, `checks` and `required_check_kinds`). A launch runs every declared lane or the subset named with `--workers a,b`; the selection is pinned in `plan.json` as `workers` and `excluded_workers`. Every lane gets the same session command, tools, permission mode and deadline. The graph shape is fixed; only the lane list varies:

```text
              launch_<lane> ┐  (one per selected lane)          ┌ verify_<lane> ┐  (one per selected lane)
START ────────              ├─ handoff / freeze ────────────────┤               ├─ candidate + combined checks
              launch_<lane> ┘                                   └ verify_<lane> ┘
                                                                         │
                                                            independent review (interrupt)
                                                                         │
                                                            integration approval (interrupt)
                                                                         │
                                                             fast-forward source branch
```

A `feature.json` 2.2.0 run puts the design challenge before every launch (`challenge ──▶ launch_<lane>`); see "Guardrails" below. Every other run has exactly the graph above.

## One-command launch

A feature is any directory under `<target>/features/` that holds a `feature.json`; an unknown name is refused with the list found. From a clean checkout in Herdr:

```bash
.venv/bin/python -m workflow launch <feature> --live --automatic                       # md-manager's own features
.venv/bin/python -m workflow launch <feature> --repo ~/dev/project-B --live --automatic # any other repository
```

This performs preflight, creates a feature branch (not main) in the target, prepares one worktree per selected lane, starts the interactive workers with run-scoped permission bypass/Bash access, and supervises them through checks and independent automated review. The `python -m workflow` commands run from the tool's directory; `git switch` runs in the target. Add `--workers ui` (or any comma-separated subset of the declared lanes) to run only those lanes: the others are not launched, their owned paths stay off-limits to every running lane, and the candidate is built from the selected lanes only. The command remains running until it stops on a verified feature branch or a blocker. Meanwhile it prints the run's timeline (`events.jsonl`) as it grows, one line per event: `HH:MM:SS` in UTC, node, status, message. It starts with a header and the last five events, so a resumed `automatic --live` shows at once where the run stands; no separate timeline pane is needed. It never pushes or merges main. Use `--dry-run` instead of `--live` to inspect without execution; it also prints the Projects registry entry a live launch writes. Omit `--automatic` for the manual gates. `--run-id` defaults to `<feature>-001`; the run root to `~/.local/state/md-manager-workflows/<feature>` for md-manager and `~/.local/state/agent-workflows/<repo-name>/<feature>` for other targets.

Before launching, `launch` refuses: a feature directory with a `TODO:` placeholder left in a file `init` writes (each is named; see the README), a `feature.json` at version 1.0.0 (rewrite it as 2.x with `workers: [{node_id, task}]`), lanes that differ from the policy's, a missing or empty task or brief file, a reviewer `prompt` naming an unknown bundled brief (`builtin:<id>`), a run directory inside the target, and an existing run directory. For a 2.2.0 feature it also refuses a task without non-empty `## Goal`, `## Acceptance` and `## Stop` sections (naming the file and the headings), a missing or empty `decisions.md`, and a `prd` that does not exist in the target. None of these touches Git. A 2.0.0 or 2.1.0 feature launches as before and prints `Note: feature.json 2.1.0: no guardrail is enforced ...` with the migration steps (the dry run also reports it under `guardrails`).

A policy may declare a `failure_drill`: a deliberate first verification failure of one lane, retried explicitly ("Status, failures and recovery"). Every lane/phase has a hard limit of three verification attempts. Automatic mode adds persisted per-worker deadlines (default 4 hours, `--worker-timeout-seconds`) enforced by the running supervisor and a reviewer deadline (default 30 minutes, `--review-timeout-seconds`, counted from the reviewer's launch). Interrupting the supervisor leaves the workers running and the run resumable; only deadline expiry, a worker that writes `status: blocked`, or a missing native session stops them. A worker whose native state is `blocked` (its turn ended on a question, a permission prompt or a refusal the harness could not continue past) is not a failure: the controller records one `interactive` event naming the lane, keeps the other lanes running and waits until that worker's deadline, so the operator can answer in its pane. It does not impose token caps or automatically repair code. Manual mode retains operator-controlled worker lifetimes. The independent review runs as a third native session by default; `--reviewer-transport print` keeps the headless `claude --print` reviewer for environments without Herdr (see "Automatic mode: the review step").

## Guardrails (feature.json 2.2.0)

The rules are in the README ("Guardrails"); these are the procedures.

**Before launch.** Write the tasks as outcome briefs and run the `workflow-grill` skill (`/workflow-grill <feature>` in Claude Code, linked once as the README says) so that `features/<feature>/decisions.md` exists. Commit. `launch --dry-run` shows `--guardrails --decisions <path> [--prd <path>] [--no-challenge]` on the `prepare` command, the registry graph starting with `challenge`, and `guardrails.enforced: true`.

**The design challenge.** `start` runs it before any worker: one `claude --print` job (Read, Glob, Grep; `--add-dir` only for the run's `challenge-inputs/`, where the PRD copy lives) in `$RUN/challenge-worktree/`, a detached checkout of the base commit; the prompt (kept as `challenge-<n>.prompt.txt`) holds the pinned tasks and decisions and names the PRD copy. Its deadline is the run's review deadline (30 minutes for manual runs). A job that fails, times out, returns output that violates `contracts/workflow/challenge.schema.json` or changes its worktree blocks `start` with a `blocked` event, and no worker is launched. The result is `challenge.json`:

- `passed` (no P0/P1): the timeline records `challenge succeeded`, then the workers launch as usual.
- `paused` (a P0 or P1): the timeline records `challenge paused`, no worker session exists, `start` (and therefore `launch`) exits 0 and prints every concern with its consequence, the simpler alternative, the cheap experiment and the two ways on. `launch --automatic` stops there; the supervisor is not started. `start` again refuses and points at `resume`.
- **Rerun after an edit:** change the task files, `decisions.md` or the PRD in the target (the paths pinned at prepare), then `"$PY" -m workflow resume "$RUN" [--herdr]`. It re-reads them (a task that lost a required section is refused), updates the plan's pinned copies and the PRD copy, reruns the challenge as the next attempt (the previous record is kept as `challenge-<n>.json`) and, when it passes, launches the workers exactly as `start` would and, for an automatic run, supervises it like `automatic --live`. Still paused: it prints the concerns again and exits 0. The policy is never re-pinned; changing it needs a new run. The edits stay uncommitted in the source checkout, and integration refuses a dirty source: stash them (`git stash push -- features/<feature>`) before the run reaches integration and commit them afterwards.
- **Override:** `"$PY" -m workflow resume "$RUN" --accept-challenge "<reason>" [--herdr]` rewrites the paused attempt as `accepted` with the reason (the paused record stays as `challenge-<n>.json`), reruns nothing and launches the workers. The reason is shown in the viewer.
- `resume` refuses once any worker was launched, and for runs without a challenge. `"challenge": false` records `disabled` at `start` and runs no job.

**Worker questions.** A worker that cannot decide alone writes its completion file with `status: question`; the controller keeps it as `<lane>.question-<n>.json`, appends `{n, question, asked_at, answer: null, answered_at: null}` to `<lane>.questions.json`, records an `interactive` event with the question and the `answer` command, and pauses that lane's deadline (`<lane>.deadline.json`: `paused_at` while waiting, `paused_seconds` accumulated). The other lanes and their deadlines keep running; a controller restart reads the same pause. Answer with:

```bash
"$PY" -m workflow answer "$RUN" <lane> "Use option B; record the trade-off as an open assumption."
```

It refuses when the lane has no unanswered question, records the answer and its time, restarts the deadline (the paused time is added to it) and types the text into the lane's pane from `terminals.json` (`herdr pane send-text <pane> <text>`, then `herdr pane send-keys <pane> Enter`; needs `HERDR_ENV=1`). With `--no-herdr`, or if the pane is gone, it prints `claude attach <id>` so you can type the answer yourself; the answer stays recorded. If you type into the pane directly instead, the controller records `(answered by typing in the worker's pane)` as soon as the session works again and restarts the deadline. A worker gets at most three answered questions; a fourth `question` blocks the run like `status: blocked` (the file stays as evidence).

**Completion evidence.** A 2.2.0 run pins completion `1.1.0` (`plan.completion_version`): `completed` needs `untested` (a list, may be empty), non-empty `falsifying_check` and `verify_yourself`, and `question: null`; a file without them, or a 1.0.0 file, blocks the run like any malformed completion. Check `falsifying_check` against the verify node's evidence: the executed checks, not the worker's claim, are what passed.

## Guarantees and boundaries

- One implementation worker per selected lane, as many lanes as the feature declares; each is a native interactive Claude background terminal in its own worktree. A dedicated Herdr tab attaches every terminal with keyboard input enabled: the first lane takes the root pane, each following lane splits right of the previous one, and each reviewer (one per declared reviewer, in declared order) splits right of the previous pane.
- Exact shared starting Git revision is recorded and verified. Frozen ownership is checked against actual captured files, not just agent reports, against the full declared policy: a selected lane that edits a path owned by an excluded lane is an ownership violation naming both lanes. Lane ids follow `^[a-z][a-z0-9-]{0,31}$` and never take a reserved graph name (`review`, `candidate`, `handoff`, `approval`, `integrate`, `multiple`, `none`, `both`, or a `launch_`/`verify_`/`candidate_`/`review-` prefix). `role` is a free label; each lane's `required_check_kinds` decide which check kinds it must pass (policies before 1.2.0 derive them from the role: `frontend` needs `build` and `browser`, `backend` needs `unit`), so relabelling a lane cannot bypass required tests.
- **Idle is not complete.** The operator gathers handoff summaries/assumptions and explicitly freezes the run. The runtime stops every worker process before snapshotting. Source ownership violations or uncertain termination block capture.
- Verification runs in fresh worktrees, with separate cache, temp, browser-output and artifact directories. Installed Python/Node/browser executables may be shared read-only; do not share mutable dependency installations.
- Each lane runs the checks its policy entry lists and must cover its `required_check_kinds` (for example a UI lane that builds and runs real Playwright scenarios with a PNG attachment per scenario, and a backend lane that runs unit tests plus contract/build checks). Missing tests, skipped required scenarios, flaky browser retries, nonzero exits and missing/tampered artifacts block the graph.
- **Created files are evidence.** In the worker phase only, after the verification worktree is confirmed clean at the snapshot commit and before setup or any check runs, the verifier copies each changed file of the snapshot into the packet as an artifact of kind `file` with its repo-relative `path`, in changed-file order. A file is captured when it is a regular file inside the worktree, is text (decodes as UTF-8 and contains no NUL byte) and fits the caps: 512 KiB per file (`FILE_CAPTURE_LIMIT`) and 8 MiB of captured files per packet (`PACKET_FILE_CAPTURE_LIMIT`), both in `workflow/checks.py`. Every other changed path is listed in the result's `files_not_captured` with its reason: `binary` (not UTF-8 or contains a NUL byte), `too_large` (over 512 KiB), `missing` (deleted or renamed away in the snapshot, or not a regular file, such as a symbolic link, which is never followed) or `budget` (it would take the packet's captured total past 8 MiB; a later, smaller file may still fit). A check that rewrites a captured file cannot change what was recorded, and the post-check cleanliness rule blocks the packet. A recheck verifies every `file` artifact's hash like any other artifact, so a retained copy edited after capture blocks the packet. Candidate-phase packets capture nothing and have no `files_not_captured`; packets recorded before capture have neither and stay valid. The Projects viewer serves these files through the artifact route as `text/plain`; nothing reads the repository.
- Every lane's snapshot is checked separately, then the combined integration candidate (the selected lanes cherry-picked in declared order) is checked again per lane. Thus individually passing workers are not sufficient for integration. A run over one lane is valid: its candidate is that lane's snapshot, still verified in the combined phase.
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

.venv/bin/python -m workflow.run_tests   # parallel by test class; or: -m unittest discover -s workflow -t . -v
npm run test:contracts
```

`workflow.run_tests` runs each test class in its own process, as many at a time as there are CPUs (`--jobs N` or `WORKFLOW_TEST_JOBS` to change it), and prints one unittest summary the verifier parses like a plain run; on 4 cores it takes about 3.5 minutes instead of 9.5. Use it as a policy check's argv (`["<venv>/bin/python", "-m", "workflow.run_tests"]`) so the verifier runs the suite in parallel too. A failed class's output is echoed indented, stdout and stderr in the order they were written, with the captured output of a failed command (a `CalledProcessError`'s stderr, such as git's reason for exit 128) noted under its exception line; only the runner's own final summary is counted. Test classes must not share state outside their own temporary directories.

The tests use fake workers, a fake reviewer session and mocked native lifecycle controls. `workflow.test_lanes` covers lanes from configuration: a three-lane run, a one-lane run, a pinned subset, excluded-lane ownership, refused selections, required check kinds, reserved ids, retrying any lane, a skipped drill, finding attribution per lane, the refused 1.0.0 feature file and the export of a run recorded before configured lanes. `workflow.test_portable` covers targets other than md-manager (PRD_PORTABLE_WORKFLOW section 6): `--repo`, the cwd rule, feature scanning, a target without `contracts/`, md-manager's unchanged commands, the registry entry (plus concurrent launches, a symlinked registry, aliased runs roots and subset launches), `init`, placeholders, the bundled briefs and prompts free of md-manager wording. `workflow.test_guardrails` covers the slice 2 controller scenarios of the same section: outcome-brief headings, required decisions, a passing and a pausing design challenge with `resume` and `--accept-challenge`, completion evidence, worker questions with `answer` through a fake Herdr, and the 1.5.0 export seam. The end-to-end test uses real temporary Git worktrees, Python unit tests, headless Chromium, screenshot files, review/approval interrupts and a fast-forward of a **temporary test repository**. It makes no Claude model calls. A second test injects a check failure, reopens checkpoints and verifies that only the failed verification attempt reruns. The automatic tests run once with the native reviewer protocol and once with the print-mode fallback, each with the single built-in reviewer and with two declared reviewers, including a controller interrupted while waiting for the reviewers and every rejected completion file; `ParallelReviewerScenarios` covers PRD_PARALLEL_REVIEWERS section 6 (two approve, one blocks, a P1 anywhere, one times out, a file naming the other reviewer, a shared session UUID, an interrupted second launch) and `test_lanes` the manual import per reviewer.

## 1. Define and commit the feature contract

`python -m workflow init <feature> [--repo X]` writes a starting point (README, "Use it in another project"). Commit shared application types/API expectations and the feature files before any worker starts. The target needs no copy of `contracts/`: the controller validates against the schemas bundled with the tool, and prompts name their absolute paths. Define:

- One task file per lane, with distinct responsibilities, declared in `feature.json` (`contracts/workflow/feature.schema.json`).
- Each lane's owned path prefixes (no globs; pairwise disjoint across all declared lanes, excluded ones included).
- A verification policy matching `contracts/workflow/verification.schema.json` (1.2.0): the same lane ids as `feature.json`, a `role` label, `checks` and `required_check_kinds` per lane.
- Tests for the named browser scenarios, following the attachment convention below. These can be part of the workers' deliverables; required test files missing at verification block the run.

`contracts/workflow/verification.example.json` is illustrative, not a runnable feature test suite. Replace its commands/scenarios with the chosen feature's actual acceptance criteria.

Optional policy `setup` is an array of approved `{ "argv": [...], "timeout_seconds": 300 }` commands, run once in every fresh verification worktree. For a Node project this could be `npm ci`; scripts are trusted code, so do not add setup commands casually. Python checks use the controller's virtualenv through PATH. No dependency directories are symlinked between writers/verifiers.

## 2. Preflight and prepare (no model calls)

Use a new run directory outside the source repository. Keep the source clean, and use a named source branch.

```bash
RUN="$HOME/.local/state/md-manager-workflows/my-feature/my-feature-001"
PY="$PWD/.venv/bin/python"                 # md-manager's interpreter, run from its root
TARGET="$PWD"                              # or the other repository

"$PY" -m workflow preflight "$RUN" --repo "$TARGET" --policy /path/to/policy.json --herdr
"$PY" -m workflow prepare "$RUN" --repo "$TARGET" --policy /path/to/policy.json \
  --task ui=/path/to/ui-task.txt --task adapter=/path/to/adapter-task.txt
```

`--task <lane>=<path>` is given once per selected lane. `--workers ui,docs` (a subset of the policy's lanes; unknown ids, duplicates and an empty list are refused before anything is allocated) selects the lanes to prepare; without it every declared lane is selected and needs a task. A `failure_drill` naming an excluded lane is pinned as `null` and the timeline records that it was skipped.

Preflight checks the policy (lane ids, ownership, required check kinds), source cleanliness, CLI flags/authentication and required executables. It does not run the feature's tests or assume future dependencies are already installed. `prepare` creates verified worktrees and pins the policy digest/starting revision/branch. Run configuration is immutable after preparation; change feature requirements by creating a new run.

## 3. Start and interact (explicit model usage)

```bash
"$PY" -m workflow start "$RUN" --live --herdr
```

This is the only initial launch command. Native Claude assigns actual session IDs; receipts and worktree identity bind them to graph nodes. `start` refuses an already-started run. Keep the initial controller call in a persistent terminal to protect startup from SSH disconnects.

Select a lane's `Claude: <lane>` pane in the dedicated workflow tab and type normally. Manual permission prompts are yours to answer. File read/edit tools are enabled; shell tools and nested agents are disabled in this training profile. The trusted verifier, not the worker, executes tests later.

Ctrl+Z detaches without stopping the native terminal. Closing a panel only detaches it. To reconnect a worker in an available terminal, use the validated attachment entry point:

```bash
"$PY" -m workflow.interactive attach-one "$RUN" --node <lane>
```

If `start` was used without `--herdr`, `python -m workflow attach "$RUN"` creates the dedicated tab. Partial/duplicate panel allocations are preserved and reported, not silently replaced. "Interactive panes and session identity" below covers what typing into a pane does and how sessions are bound.

While workers run, do one independent task outside their worktrees and leave `$RUN/return-note.md` describing the run, independent task, current state and next action.

## 4. Explicit handoff, freeze and verification

Ask each worker for its final summary and open assumptions. The operator saves each handoff as:

```json
{"summary": "Implemented the assigned UI behavior", "open_assumptions": []}
```

Then:

```bash
"$PY" -m workflow freeze "$RUN" \
  --handoff ui=/path/to/ui-handoff.json --handoff adapter=/path/to/adapter-handoff.json
```

One `--handoff <lane>=<path>` per selected lane is required. Every handoff is validated **before stopping** workers. Do not continue typing or manually restart workers after freeze. The runtime stops only the recorded native sessions, establishes termination, captures immutable commits with a private Git index, checks ownership, runs checks, creates an integration candidate and rechecks it.

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

Have your Playwright config start/stop an isolated local web server on a nonconflicting port. Workers are stopped before checks, but the verification lanes can execute concurrently. Never reuse a developer's existing server and call it isolated verification. Process groups are terminated after each check, including timeout cleanup.

Python unittest and Node TAP/spec summaries are supported for non-browser test counts. Unsupported/custom test reporters produce missing test evidence and block rather than infer success. Browser assertions/reporting and screenshot inspection remain the reviewer's responsibility; PNG headers/hashes do not prove visual quality.

## 5. Review the exact candidate

Successful verification interrupts at `independent_review` and produces:

- `review-bundle.json`: frozen revisions, policy digest and packet hashes.
- `verification/worker/.../packet.json`: worker checks, logs, screenshots, file lists and assumptions, the changed text files captured as `file` artifacts and `files_not_captured` with the reason for each other changed path (see "Created files are evidence").
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

Findings, if present, contain `severity` (`P0`, `P1`, `P2`), `message`, and `disposition` (`open`, `resolved`, `accepted`), optionally `worker` (one of the run's lane ids, `multiple` for several lanes, or `none` for cross-cutting findings; the legacy `both` is refused for new runs) and `requirement` (a verbatim quote from that worker's task text in `plan.json`, or null) so the viewer can link a finding to the task it concerns. P0/P1 must be resolved. Do not relabel a rejected review as approved. Code changes require new snapshots, verification and review—start a revised run rather than mutate an approved bundle.

```bash
"$PY" -m workflow review "$RUN" --review-file /path/to/independent-review.json                       # single built-in reviewer
"$PY" -m workflow review "$RUN" --reviewer general  --review-file /path/to/general-review.json        # feature with declared reviewers:
"$PY" -m workflow review "$RUN" --reviewer coverage --review-file /path/to/coverage-review.json       # one approved file per reviewer
```

Each file is one reviewer's review in the shape above. A feature that declares reviewers (`feature.json` 2.1.0 `reviewers`) needs one import per reviewer, named with `--reviewer <id>`; the import is stored as `review-<id>.imported.json` (`review.imported.json` for the built-in reviewer) and the run stays at the review gate until every declared reviewer is imported. The controller then writes the combined `review.json`: `reviewers: [{reviewer_id, session_id, verdict, accepted_at}]` in declared order, the union of the findings each tagged with its `reviewer`, and `reviewer` listing every stated identity. `approve` is refused until every declared reviewer is imported and approved. Review does not integrate. The graph then waits at a separate approval interrupt.

### Automatic mode: the review step

In an automatic run the review node launches every reviewer itself, once per bundle, and waits for all of their verdicts exactly as it waits for worker completion signals. A feature without `reviewers` has one reviewer, the built-in `review`, and behaves exactly as before; a `feature.json` 2.1.0 `reviewers` list runs one session per declared reviewer (`<id>`) in parallel over the same candidate. The default reviewer keeps the unprefixed names below; a declared reviewer's node and files are `review-<id>` (`review-<id>.interactive.json`, `review-<id>.prompt.txt`, `review-<id>.launch.log`, `review-<id>.completion.json`, `review-<id>.stop.json`, and `automatic-review-<id>.json` for its own status), its session is `workflow-<run>-reviewer-<id>` and its pane `Claude: reviewer <id>`.

- **Briefs.** The built-in brief is `workflow/prompts/review.md`; a declared reviewer's brief file replaces it and states only what to look for. The controller appends the same fixed blocks to every brief (diff and bundle paths, task locations, this run's lane vocabulary) and then the completion protocol for that reviewer (its own node id, launch token and completion file; with several reviewers it names the others and tells the reviewer not to read their files). `prepare` pins each reviewer's id and brief text into `plan.reviewers`; the exact prompt each session received is kept in its `.prompt.txt`.
- **Native reviewer sessions (default).** `claude --bg --name workflow-<run>-reviewer[-<id>]` starts in `$RUN/review-worktree/` (one detached checkout of the candidate commit, shared by every reviewer) with tools Read, Glob, Grep and Write, permission mode `dontAsk`, no MCP servers, the run directory added as a readable path, and a single allowed write: that reviewer's completion file. The receipt is `<node>.interactive.json` (same keys as a worker receipt plus `candidate_commit`). Each session UUID is recorded in the timeline (`Reviewer <id> session <uuid> launched; awaiting <node>.completion.json`) and must differ from every worker's and from every other reviewer's: two reviewers sharing a UUID fail the independence check and block the run.
- **Reviewer panes.** When the run's Herdr tab exists, each reviewer gets a `Claude: reviewer [<id>]` pane as it launches: the first splits right of the last lane's pane, each following reviewer right of the previous reviewer, in declared order; each attaches with `attach-one --node <node>`. You can answer a question a reviewer asks there, exactly as for workers, without affecting the others; the transcript is the record, the verdict is only the file. A missing pane never fails the review; `python -m workflow.interactive attach-one "$RUN" --node review-<id>` reconnects in any available terminal, and `attach` adds the missing reviewer panes when the sessions already exist, also to a workflow tab whose worker panes were attached earlier.
- **Completion protocol.** Each reviewer writes its own completion file once, as its last action, then ends its turn. The controller polls every receipt and accepts a file only when it validates against `contracts/workflow/reviewCompletion.schema.json` (1.2.0: `node_id` is `review` or `review-<id>`), its `run_id`, that reviewer's `node_id` and `launch_token`, `bundle_sha256` and `candidate_commit` match the run, the session is `idle` or `done`, every reviewer's identity is unchanged and independent, and the review worktree, bundle and `review.diff` hashes are unchanged. A file whose `node_id` names another reviewer is rejected. Findings carry `worker` (a selected lane id, `multiple` or `none`; the prompt spells out this run's vocabulary, and the print fallback's structured-output schema is generated from it) and `requirement`. Any rejected file, including one naming a lane the run did not select, blocks the run with the reason in `automatic-review.json` (and in that reviewer's status file); nothing is relaunched.
- **Verdict.** Unanimous. The run continues only when every declared reviewer's file was accepted with `approved` and no reviewer left an unresolved P0/P1; the first `blocked` verdict, unresolved P0/P1, rejected file or expired deadline decides at once, without waiting for the other reviewers. `review.json` is then written with the combined `verdict`, `reviewers: [{reviewer_id, session_id, verdict, accepted_at}]` in declared order (`verdict` null for a reviewer that produced none) and the union of the accepted findings, each tagged with its `reviewer` (the same defect reported twice is kept twice), and `reviewer` lists every session UUID. An approval that still carries an unresolved P0/P1 is recorded as `verdict: "blocked"` with that reviewer's raw decision kept in its status file. Each reviewer's status file ends as `succeeded`, `accepted` (its approval was accepted but another reviewer blocked), `blocked` or `superseded` (still working when the run was decided). Fixing findings means a new run with a new bundle.
- **Deadline.** `review_timeout_seconds` counts from each reviewer's own launch (`launch_requested_at`) and survives controller restarts. The first reviewer to idle without a file until its deadline blocks the run; verdicts already accepted from the others are retained in `review.json`; **no second reviewer is ever launched**.
- **Stop.** After the combined decision the controller stops every reviewer with the same identity re-check as for workers (`<node>.stop.json`); the transcripts stay resumable. A stop that cannot be confirmed after acceptance ends the controller with the verdict kept (`automatic-review.json` stays `succeeded`, that reviewer's `stop.json` absent or unconfirmed, the reason on the timeline); `python -m workflow automatic "$RUN" --live` retries the outstanding stops before continuing and launches nothing.
- **Interruption.** Ctrl-C, a closed terminal or a dropped SSH session while the controller waits leaves every reviewer running with `automatic-review.json` at `running`; `python -m workflow automatic "$RUN" --live` resumes waiting for the same sessions' files. The same holds inside a launch window once that reviewer's `claude --bg` was issued (its `.interactive.json` exists): the receipt is `running`, without `session_id` when the interrupt hit the settle poll, and resume rebinds that one session through reconciliation, never a relaunch. An interrupt before a reviewer's launch was issued leaves the run at `needs_reconciliation`: resume rebinds the reviewers that were launched and launches nothing, so the run cannot continue; stop the running reviewers by their exact ids and start a new run.
- **Print fallback.** `--reviewer-transport print` (at `launch` or `prepare`, pinned into `plan.automatic`) keeps the headless `claude --print --json-schema` reviewer, one job per declared reviewer started in parallel: no pane, no human input, `<node>.stdout.json`/`<node>.stderr.log`, the same bundle binding and verdict rules. One difference from native transport: the controller collects the print jobs in declared order, so a later reviewer's block is acted on only after every earlier job has finished or timed out; every job still runs concurrently and keeps its own deadline. Plans pinned before the setting existed validate as `native` (they never launch a new reviewer); their exported inputs report the transport their recorded review used, or null.

To read or continue a reviewer's transcript after the run:

```bash
cd "$RUN/review-worktree" && claude --resume <reviewer-uuid>
```

The UUID is `session_id` in `$RUN/<node>.interactive.json` (or that reviewer's entry in `review.json`). Claude keeps transcripts under `~/.claude/projects/<encoded worktree path>/<uuid>.jsonl`, keyed by the worktree the session ran in, which is why the resume must start from `review-worktree`, the checkout every reviewer of the run shared.

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

Export rebuilds `run-state.json` from the run directory under the current export version (1.5.0: the `review` and `inputs` sections the Projects viewer reads, the lane list, one `reviewers` entry per reviewer, and the guardrails: `inputs.decisions`, `inputs.challenge` with `attempts`, the completion evidence and `inputs.workers.<lane>.questions`, null and `[]` for runs without them). A run recorded before configured lanes keeps its stored graph definition (same node ids, same labels), reports `ui` and `adapter` as its selected lanes and carries its launch receipts and packet paths under `values.lanes` and `values.packets`. It takes the controller lock, reads the persisted checkpoint without invoking any node, constructs no sessions (a copied run whose worktrees are gone still exports), launches nothing, and refuses a run whose `plan.json`, pinned policy or `review.json` fail validation. Unchanged content does not bump `updated_at`. Run it on runs recorded before a newer export version, such as project-workflows-001, so the viewer shows their review and inputs.

- **Failed verification:** inspect its packet/log. Attempts default to a hard limit of three per lane/phase; policy v1.1.0 and later can explicitly set `max_verification_attempts`. For a transient check/environment failure at the same immutable revision, explicitly retry only that lane (`--node` accepts any lane of the run and nothing else):
  `python -m workflow retry "$RUN" --phase worker --node adapter`.
- **Failed combined check:** use `--phase candidate --node <lane>`. Already successful candidate checks are reused after artifact validation.
- **Failure after stopping/snapshotting or integrating:** `retry "$RUN"` resumes only failed graph steps; it never launches a new Claude worker. Stop-intent recovery checks whether the prior stop already completed before issuing another native stop.
- **Ambiguous startup:** inspect receipts/native inventory, then `reconcile "$RUN"`. It only permits existing durable launch intents and exact surviving sessions; no new native process is launched during reconciliation. Missing proof remains blocked.
- **Changed code/policy:** create a new run. Do not modify frozen snapshots/evidence and reuse approvals.
- **Partial candidate/worktree allocation:** preserve and inspect it. Automatic destructive cleanup or speculative Git conflict resolution is intentionally unavailable.
- **Usage exhausted:** workers stay at the manual terminal/handoff boundary. Preserve their receipts/worktrees, record the decision, and ask the owner to wait or approve a new plan/provider. The system never switches to another payment/provider mode or replays an opaque Claude workflow automatically.
- **Stopping an unfinished run:** use the exact native IDs from its receipts (`<lane>.interactive.json` for every selected lane and, in automatic mode, `review.interactive.json` or `review-<id>.interactive.json` for every reviewer) with Claude's `stop` command after verifying identity. Closing Herdr alone is not a stop. All run artifacts/worktrees are retained; cleanup is a separate operator decision.
- **Reviewer needs reconciliation:** `automatic-review.json` at `needs_reconciliation` or `blocked` never relaunches a reviewer. Inspect each reviewer's `.interactive.json`, `.launch.log` and status file (`automatic-review.json` for the built-in reviewer, `automatic-review-<id>.json` per declared reviewer) and `claude agents --json`, stop a stray reviewer by its exact ID, and start a new run for a fresh review.

Lanes are configuration, not a fixed pair: the tests exercise one, two and three. Selective check recovery is tested independently of Claude's own workflow-relaunch semantics.

## Command reference

```bash
PY="$HOME/dev/md-manager/.venv/bin/python"                        # controller interpreter, run from md-manager's root
RUN="$HOME/.local/state/<md-manager-workflows|agent-workflows/<repo>>/<feature>/<run-id>"   # always outside the target
```

Nothing launches a Claude session without `--live`. Nothing ever pushes or merges `main`.

### `launch`

| Flag | Meaning | Default |
| --- | --- | --- |
| `<feature>` | a directory under `<target>/features/` that holds a `feature.json` | required |
| `--repo PATH` | the target Git repository (a path inside it selects its root) | the cwd's repository when it has `features/`, else md-manager |
| `--run-id ID` | opaque run identifier, not a path | `<feature>-001` |
| `--run-root DIR` | run storage outside the target | `~/.local/state/md-manager-workflows/<feature>` (md-manager), `~/.local/state/agent-workflows/<repo>/<feature>` |
| `--workers a,b` | launch only these declared lanes (unknown ids, duplicates and an empty list are refused before any Git action); pinned in `plan.json` | every declared lane |
| `--live` | authorize Claude usage | off |
| `--automatic` | run-scoped permission bypass for workers, automatic freeze, checks, reviewers, verified feature branch | off, manual gates |
| `--worker-timeout-seconds N` | per-worker deadline from launch to completion signal, automatic only | 4 h, max 24 h |
| `--review-timeout-seconds N` | reviewer deadline from its launch to its completion file, automatic only | 30 min, max 24 h |
| `--reviewer-transport native\|print` | attachable reviewer session, or headless `claude --print`, automatic only | `native` |
| `--no-herdr` | omit terminal attachments | attaches |
| `--dry-run` | validate the feature, print the commands and the registry entry | off |

`launch` refuses an existing run directory. It runs, in order: `preflight`, `git switch -c <branch_prefix>/<run-id>` (in the target), `prepare`, then registers the run in the Projects registry, then `start`, and with `--automatic` also `automatic`; when the design challenge paused the run at `start`, it stops there and exits 0. A registry that cannot be updated after `prepare` is reported and the launch continues. A policy `failure_drill` that names a lane the selection leaves out is skipped, with a note and a timeline event.

### Step by step (what `launch` runs for you)

| Action | Required flags | Optional flags | What it does |
| --- | --- | --- | --- |
| `preflight` | `--policy` | `--repo`, `--herdr`, `--automatic` | validates the policy, clean source, installed `git`/`claude`/`node`, the Claude CLI flags the run needs, Claude login; `--herdr` requires a managed Herdr pane (`HERDR_ENV=1`) |
| `prepare` | `--policy`, `--task <lane>=<path>` once per selected lane | `--workers a,b`, `--reviewer <id>=<brief>` once per declared reviewer, `--repo`, `--automatic`, the three automatic settings; for 2.2.0 `--guardrails --decisions <decisions.md> [--prd <path>] [--no-challenge]` (pins completion 1.1.0, the challenge flag, decisions.md, the PRD copy and the task paths) | pins base commit, branch, policy digest, `repository`, `workers`, `excluded_workers` and `reviewers` (ids and brief texts; absent means the single built-in reviewer) into `plan.json`, creates one worktree per selected lane, writes the first `run-state.json`; `--automatic` requires a `feature/` branch |
| `start` | `--live` | `--herdr` | 2.2.0: runs the design challenge first and exits 0 without launching when it pauses; launches every selected lane's native session once; refuses an already-started run; with `--herdr` opens the workflow tab |
| `resume` | | `--accept-challenge "<reason>"`, `--herdr` | 2.2.0, before any worker launch: re-pins the edited feature files and reruns a paused challenge, or records `accepted` with the reason; then launches the workers and, for an automatic run, supervises it |
| `answer` | `<lane> "<text>"` | `--no-herdr` | 2.2.0: records the answer to the lane's waiting question, restarts its deadline and types it into its pane (or prints `claude attach <id>`) |
| `freeze` | `--handoff <lane>=<path>` for every selected lane | | validates every handoff, stops the recorded sessions, snapshots, checks each lane, builds and rechecks the candidate |
| `review` | `--review-file`, `--reviewer <id>` when the run declares reviewers | | stores one reviewer's import; once all are imported, combines them into `review.json` and resumes the graph |
| `approve` | `--bundle-sha256` | | refused until every declared reviewer is imported and approved; then fast-forwards the source branch locally |
| `automatic` | `--live` | | supervises to a verified feature branch, or resumes an interrupted run, printing the timeline as it grows |
| `automatic-step` | `--live` | | one controller step; exit 75 means checkpoint persisted, run again |
| `retry` | | `--phase worker\|candidate`, `--node <lane>` | reruns one failed check at the same revision, or resumes failed post-freeze steps; never relaunches |
| `reconcile` | | | rebinds surviving sessions after an ambiguous launch; never relaunches |
| `attach` | | | creates the run's Herdr tab and panes when `start` ran without `--herdr`, or adds missing reviewer panes |
| `status` | | | next nodes, pending interrupts, errors, `workers`/`excluded_workers`, the challenge status when there is one; refreshes `report.html` |
| `export` | | | rebuilds `run-state.json` at the current export version; launches nothing |

`python -m workflow.interactive attach-one "$RUN" --node <lane>|review|review-<reviewer>` reconnects one session in the current terminal; it needs an interactive terminal and refuses to restart a missing session. Native session controls, from the run's receipts:

```bash
claude agents --json                                  # the run's sessions: workflow-<run-id>-<lane>, workflow-<run-id>-reviewer[-<reviewer>]
claude stop <background_id>                           # stop one session by its exact id from <node>.interactive.json
cd "$RUN/review-worktree" && claude --resume <uuid>   # reread or continue a reviewer transcript
```

### Files in a run directory

| File | Written by | Meaning |
| --- | --- | --- |
| `plan.json`, `policy.json` | `prepare` | pinned repository, base commit, branch, `workers`, `excluded_workers`, `failure_drill`, tasks, `reviewers`, automatic settings, policy; for 2.2.0 also `feature_version`, `completion_version`, `challenge`, `decisions`, `prd`, `task_files` |
| `run-state.json` | every CLI boundary, `export` | versioned export the viewer reads |
| `worktree-<lane>/` | `prepare` | one worktree per selected lane |
| `<node>.interactive.json` | launch | session receipt with UUID, launch token, status (one per lane and per reviewer) |
| `<node>.prompt.txt`, `<node>.launch.log` | launch | exact prompt and launch output |
| `<lane>.completion.json`, `<lane>.handoff.json` | the worker, `freeze` or the controller | automatic completion signal (1.0.0, or 1.1.0 with evidence for 2.2.0 runs), accepted handoff |
| `<lane>.question-<n>.json`, `<lane>.questions.json`, `<lane>.deadline.json`, `questions.lock` | controller, `answer` | a worker's question files, their answers and times, the persisted deadline pause |
| `challenge.json`, `challenge-<n>.json` | `start`, `resume` | the latest design challenge decision and the earlier attempts |
| `challenge-<n>.prompt.txt`, `challenge-<n>.stdout.json`, `challenge-<n>.stderr.log`, `challenge.running.json` | `start`, `resume` | a challenge job's prompt, output and in-flight marker |
| `challenge-worktree/`, `challenge-inputs/` | `start`, `prepare` | the read-only base-commit checkout the challenge reads, the pinned PRD copy |
| `<node>.stop.json` | stop | identity-checked stop marker |
| `review-bundle.json`, `review.diff`, `review-worktree/` | candidate | what every reviewer sees (one shared worktree) |
| `review[-<reviewer>].completion.json`, `<node>.imported.json` | each reviewer, `review --reviewer` | a reviewer's bound verdict file, a manually imported review |
| `automatic-review[-<reviewer>].json`, `review.json` | controller | combined and per-reviewer review status, the combined verdict |
| `verification/<phase>/<node>/<attempt>/packet.json` | checks | check evidence and screenshots; worker phase also the changed text files and `files_not_captured` |
| `report.html`, `events.jsonl`, `terminals.json` | controller | local report, timeline, Herdr pane map |
| `controller.lock`, `pipeline.sqlite` | controller | lock and LangGraph checkpoint |

## Interactive panes and session identity

LangGraph launches each worker with `claude --bg` into a persistent native terminal in its worktree; Herdr only attaches to terminals that already exist (`claude attach <id>` in each pane, keyboard input enabled). Herdr never submits tasks, launches replacements or decides that work is accepted.

- A dedicated `Workflow: <run-name>` tab holds one `Claude: <lane>` pane per lane in declared order, then one `Claude: reviewer [<id>]` pane per reviewer. Your own tab is not split and focus is preserved. Before typing a command into a pane, the adapter checks that only the pane's idle shell is in the foreground; an occupied pane is refused.
- **Ctrl+Z** detaches to the pane's shell; the background session keeps running. Closing a pane or losing SSH does not stop the worker. **Ctrl+C inside Claude** interrupts its current turn. Do not type `/exit` unless you mean to end the session.
- Direct human messages consume Claude usage and change work outside any graph node; the graph does not know them. Idle or done is never completion.
- Native `--bg` ignores `--session-id` and assigns its own id: the plan's `session_id` is a launch token. The launcher writes its intent before calling Claude, keeps the launch output, binds the id printed by that launch and resolves the exact UUID through `claude agents --json`, cross-checking worktree and launch name. A guessed UUID or a name-only match is never adopted; unsupported states fail closed.
- `done` in the native inventory is a finished turn, not an exited process; attaching requires a live native PID as well. PIDs are never authority to kill a process.

## Verification policy and evidence

Feature requirements are supplied per feature; the gates are reusable. The policy (`contracts/workflow/verification.schema.json`, bundled with the tool) gives each lane a node id, a `role` label, exact owned path prefixes (no globs; `src/workflow` owns itself and its descendants, not `src/workflow-other`; lanes never overlap), its checks and `required_check_kinds`. A check has a unique id, a kind (`build`, `typecheck`, `unit`, `integration`, `contract`, `browser`), an argv array, a timeout and, for browser checks only, named scenarios. Every listed check is required.

| Lane kind | Usually required | Add when relevant |
| --- | --- | --- |
| UI | build; browser tests for every named scenario with a PNG screenshot each | typecheck, accessibility, mobile/desktop scenarios |
| Backend | unit tests with a nonzero passing count | contract, integration and failure/recovery tests |
| Every lane | ownership, exact run/attempt/revision identity, executed check logs, matching artifact hashes | task-specific checks |

- Policy commands are operator-approved configuration, never code a worker invents. The runner executes argv without a shell, with timeouts, in a separate verification worktree with isolated caches, ports and artifact paths.
- Test checks need parsed counts (Python unittest or Node TAP/spec summaries); an exit code with zero executed tests is not evidence. Browser checks need exact scenario ids, passed status and a screenshot each. Build and typecheck checks need no counts.
- The evidence sidecar binds the policy SHA-256 (canonical JSON: sorted keys, no whitespace, literal UTF-8), run id, lane, attempt and output commit; each check points to one entry of the worker result, whose command is `shlex.join(argv)` run in the backend-owned worktree.
- The **worker phase** verifies one lane's snapshot in isolation: its `build` and `browser` checks run and are recorded but do not gate (`gate.deferred_checks`), because another lane may be changing what they compile against; `unit`, `contract` and `integration` gate in both phases. The **candidate phase** runs every lane's checks on the combined revision and gates on all of them.
- Artifact paths resolve through a backend-owned registry, constrained to its root and hash-checked. PNG header checks are format sanity only; screenshots are for the reviewers to examine.

## Operator boundaries

- Choose the feature, ownership and acceptance tests before preparing a run; `verification.example.json` is illustrative.
- Tests and setup commands are trusted code, not sandboxed workloads; worktrees are not an OS sandbox.
- Terminal edits must stop before frozen verification. Independent review is a separate session or an imported artifact; the graph never invents approval.
- Ambiguous native sessions, partial candidate allocations, source drift and exhausted usage stop for operator action, never a silent relaunch or provider switch.
- `report.html` is a local snapshot viewer; the controls are local CLI actions, not a web service.
- Run and worktree cleanup, pushing and merging `main` remain separate, explicit actions.
