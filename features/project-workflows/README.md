# Ready-to-launch feature: project workflows and run viewer

This directory is the committed assignment for the two workers, **not** an implementation of the Projects feature. The API contract is `contracts/projects/README.md`.

## Automatic mode: stop at a verified feature branch

```bash
.venv/bin/python -m workflow launch project-workflows --live --automatic
```

This is the user-approved unattended path. Keep the command running in Herdr. Both implementation workers retain their interactive terminals, but have **run-scoped permission bypass and Bash access**. Global Claude settings are untouched. Worktrees are not OS sandboxes: these workers have the account's shell privileges, so only use this mode in a trusted environment.

Workers emit an explicit run/node/token-bound completion file. Idle alone is insufficient. The controller freezes completed work, executes the real isolated and combined checks, and invokes a fresh read-only Claude reviewer from the LangGraph review node. The review is bound to the exact candidate and evidence hash. Only a passing review permits fast-forwarding the newly created `feature/…` branch. **No merge to main and no push.**

The automatic supervisor restarts the controller in a new Python process after a persisted step. The intentional first adapter verification failure is retried using the same SQLite thread; successful sibling work is reused. Controller PIDs are recorded in the event timeline. This is the existing LangGraph pipeline—not Pi subagent orchestration.

Bounds: per-worker deadlines measured from launch to completion signal (default 4 hours, `--worker-timeout-seconds`, at most 24 hours; persisted launch times survive restart and are enforced only while the supervisor is running), a reviewer process timeout (default 30 minutes, `--review-timeout-seconds`), existing per-check timeouts, three check attempts per lane/phase and at most 45 controller-step processes per supervisor invocation. There is no token cap or billing/provider fallback. Ambiguous launches, missing completion signals, quota blocks, reviewer rejection, ownership violations and exhausted retries stop with retained evidence. Review/worker processes are not blindly relaunched. A stopped/crashed controller cannot enforce process deadlines while it is offline.

These retries rerun verification of immutable code; they are **not** an automatic source-repair loop. Persistent code failures or review findings require intervention. Fully automatic means no routine approval prompts on the successful path, not a guarantee that every run succeeds.

Interrupting the supervisor (Ctrl-C, a closed terminal, a dropped SSH session) does **not** stop the workers: they keep running in their native terminals, the timeline records `interrupted`, and the deadline keeps counting from launch. Resume the same run with the command below. Deadline expiry, a worker reporting `blocked`, a native quota block or an invalid completion file **do** stop both workers; those runs are retained for inspection but cannot be resumed, so start a new `--run-id`.

To resume an already-started automatic run after an interruption or after fixing a post-freeze blocker:

```bash
.venv/bin/python -m workflow automatic "$HOME/.local/state/md-manager-workflows/project-workflows/project-workflows-001" --live
```

Do not repeat `launch` for an existing run. Uncertain launches still require explicit reconciliation. New files include `ui.completion.json`, `adapter.completion.json`, `automatic-review.json`, `review.stdout.json`, `review.stderr.log`, `review.diff` and the isolated `review-worktree/`. The reviewer has Read/Glob/Grep only; no shell or edit tools. Synthetic tests of this path are not live Claude validation.

## Manual mode (retained)

From this repository in a Herdr pane, after installing the workflow environment:

```bash
.venv/bin/python -m workflow launch project-workflows --live
```

This validates the committed feature configuration, runs preflight, creates a feature branch, prepares both worktrees at the same commit, then launches native Claude sessions through LangGraph and attaches them in one dedicated Herdr tab. It does not launch Pi skill-based implementation subagents. It never pushes or integrates into main automatically.

Default run: `~/.local/state/md-manager-workflows/project-workflows/project-workflows-001`.
Default integration branch: `feature/project-workflows/project-workflows-001`.
Reusing that run directory is rejected rather than launching duplicates. `--run-id` chooses a deliberate new run; `--no-herdr` explicitly omits attachments. `--dry-run` validates configuration and prints the commands without executing Git, agents or checks.

**Starting is one command; finishing is supervised.** Watch the Claude panes and answer permission prompts. When both workers finish, return to Pi to collect handoffs, freeze, review and approve. The start command returns at the handoff checkpoint rather than waiting forever or treating idle as completion. A separately started CLI process does not automatically wake this Pi chat.

## Frozen backend registry seam

The adapter must load `MD_MANAGER_PROJECTS_CONFIG` independently of existing skills configuration. Unset means `projects: []`. Explicit malformed configuration fails startup. Proposed exact file shape:

```json
{
  "version": 1,
  "projects": [{
    "project_id": "md-manager",
    "name": "MD Manager",
    "repository": "/absolute/repository/path",
    "workflows": [{
      "workflow_id": "feature-implementation",
      "runs_root": "/absolute/path/containing/run-directories",
      "definition": {
        "name": "Feature implementation",
        "nodes": [
          {"node_id": "launch_ui", "label": "Launch UI worker", "kind": "worker", "depends_on": []}
        ]
      }
    }]
  }]
}
```

The single-node definition above illustrates shape, not the full production DAG. Use the full `GRAPH_NODES` from `workflow/export_state.py` for the pipeline definition. Tests may register a smaller valid graph. Project/workflow IDs are unique within their scope. Paths must be operator-supplied absolute canonical directories; never derive registrations from browser parameters or a run's `plan.repository` value. Reject overlapping/ambiguous run registrations. `repository` may differ from `runs_root` (real pipeline data lives outside the repo).

Current definitions come from registry configuration. Each run's pinned definition comes from its persisted export, not the current registry definition. Public definitions add scope/version and compute the definition hash as specified in the project API contract.

## Runtime storage seam

The controller now writes **`run-state.json` atomically** during preparation and each CLI reporting boundary. The adapter must read this file, not launch Python or decode the checkpoint database. Export version 1.0.0 contains:

- `run_id`, `base_commit`, stable `created_at`, persisted `updated_at` (unchanged exports do not bump it).
- `definition: {name, nodes}`: pinned graph structure with node IDs, labels, kinds and dependencies.
- `values`: LangGraph state; completed launch receipts at `ui`/`adapter`, frozen `snapshots`, successful `ui_packet`/`adapter_packet` paths, candidate `bundle`, accepted `review`, `approved_bundle`, and final `integrated_commit` as stages complete.
- `next`: pending internal graph node IDs.
- `tasks`: `{node_id, error: string|null, interrupts: object[], result: object|null}`. Interrupts include their `kind`; a task result can preserve a successful sibling's pending writes after another branch failed.
- `events`: persisted internal `{sequence,time,node,status,message}` events; normalize to workflow-v1 events at the API boundary.
- `verification_packets`: `{phase,node_id,attempt,path,sha256}` entries. `path` is relative to the run root and `phase` is worker/candidate.

Never return raw `values` directly: it can contain absolute paths. Project APIs must produce the committed public schemas and scoped artifact/result URLs. Resolve only registered packets inside the run, verify their hash, and resolve artifacts through their registry with containment checks. Packet format is defined in `workflow/checks.py` and documented in `workflow/RUNBOOK.md`.

Internal node IDs and state keys are not identical: `launch_ui` completes when `values.ui` exists; `launch_adapter` uses `values.adapter`; `handoff` uses `snapshots`; `verify_ui`/`verify_adapter` use the corresponding packet keys; `candidate` uses `bundle`; `review`, `approval`, `integrate` use `review`, `approved_bundle`, `integrated_commit`. Task errors override inferred completion; an interrupt marks its node awaiting approval. Nodes with no progress remain pending. Launch-node success means a session launched, not successful implementation. The graph is succeeded only when integrated with no pending work.

Logical worker result IDs are `ui` and `adapter`; verification-node detail may link to those workers' result routes. Worker results and candidate recheck evidence are distinct; do not present a candidate packet as the worker's own changed-file set. Raw event node aliases (`ui`, `adapter`, `freeze`, `candidate_ui`, `candidate_adapter`) map to the corresponding graph nodes; unknown aliases must not invent graph nodes. Required nullable v1 event fields remain explicit.

API error events/log messages must be sanitized according to the public contract. Native observed states are historical observations, not a guarantee that a process is currently alive. Unsupported older run directories need explicit import support; do not fabricate a successful run or infer a pinned historical graph from the latest definition.

## Browser fixtures and the combined candidate

UI worker checks run without the new backend. Their Playwright config must explicitly mock **only** project API success responses when `WORKFLOW_VERIFICATION_PHASE=worker`. Use the committed response schemas/examples for these mocks.

When `WORKFLOW_VERIFICATION_PHASE=candidate`, the same scenarios must exercise the real backend, with no mock project success routes. Seed a disposable configuration in the registry shape above and disposable run folders containing `plan.json`, `run-state.json` and any packet/artifact files needed. Register fixtures for completed, failed and awaiting-approval runs, an empty workflow, and an empty project. Use synthetic UUIDs/revisions and clearly test-only data, not real session paths. Backend tests independently seed the same documented format. The project error scenario may intentionally simulate a network error; other scenarios must use the candidate API.

Both configs must leave existing Pi/Claude browsing usable via temporary skills fixtures. Do not use live skills or reuse a developer's server. The UI owns its dedicated test configuration under `tests/project-workflows/`; the root Playwright config is not shared worker ownership.

Every scenario must assert behavior and attach its PNG using `[scenario:<id>]` and `screenshot:<id>`. Six IDs are pinned in `policy.json`. The verifier enforces their presence and successful assertions, and records whether it checked the worker or the combined candidate.

## Failure/checkpoint exercise and limits

This feature uses verification policy v1.1.0. It intentionally blocks the adapter's **first worker-verification attempt**, after executing and preserving the real checks. The packet labels this as an injected gate failure, not a failing implementation test or a failed Claude worker. Genuine check failures remain visible too.

In manual mode the freeze command exits with a blocked result; reopen the same run using the command below. Automatic mode performs this recovery itself in a new controller process.

```bash
.venv/bin/python -m workflow retry "$HOME/.local/state/md-manager-workflows/project-workflows/project-workflows-001" --phase worker --node adapter
```

This is a new controller process using the same persisted LangGraph thread/checkpoint. Expected: no worker relaunch; successful UI verification reused; adapter verification attempt 2 runs. Record the actual evidence, not only this expectation. `failure-drill.json` preserves pre-retry native identities; `failure-report.json` and the review bundle record post-retry identities and check-attempt directories. Null native launch time/count fields mean unavailable evidence, not a guessed count. Out-of-band manual native restarts are not certified by this report.

Hard bounds in this profile:
- Two graph implementation workers; no nested agent tool. Bash is enabled only in automatic mode.
- One pipeline-issued initial launch per worker intent; ambiguous launches never auto-retry.
- At most **three verification attempts per lane/phase**, including the first; retry beyond this is rejected.
- Each setup/check has a real process timeout; Playwright has one worker and zero retries per invocation.

Interactive Claude conversations have no hard turn/token cap. Manual mode also has no session-lifetime cap; automatic mode enforces the deadlines described above while its controller runs. The operator remains responsible for included-usage decisions. Size requests in task prompts are not resource caps. When usage runs out, preserve the run and choose an explicitly approved plan or wait—no silent billing/provider switch.

During the long worker phase, do another independent task and write `$RUN/return-note.md` with the current run, task and next action. Herdr is the chosen substitute for the lab's literal macOS/cmux tool requirement.
