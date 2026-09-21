# Ready-to-launch feature: project workflows and run viewer

This directory is the committed assignment for the two workers, **not** an implementation of the Projects feature. The API contract is `contracts/projects/README.md`.

## One command to start

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

The freeze command exits with a blocked result. Reopen the same run using:

```bash
.venv/bin/python -m workflow retry "$HOME/.local/state/md-manager-workflows/project-workflows/project-workflows-001" --phase worker --node adapter
```

This is a new controller process using the same persisted LangGraph thread/checkpoint. Expected: no worker relaunch; successful UI verification reused; adapter verification attempt 2 runs. Record the actual evidence, not only this expectation. `failure-drill.json` preserves pre-retry native identities; `failure-report.json` and the review bundle record post-retry identities and check-attempt directories. Null native launch time/count fields mean unavailable evidence, not a guessed count. Out-of-band manual native restarts are not certified by this report.

Hard bounds in this profile:
- Two graph implementation workers; no nested agent/shell tools in Claude sessions.
- One pipeline-issued initial launch per worker intent; ambiguous launches never auto-retry.
- At most **three verification attempts per lane/phase**, including the first; retry beyond this is rejected.
- Each setup/check has a real process timeout; Playwright has one worker and zero retries per invocation.

Interactive Claude conversations do **not** have a hard turn/token/session-lifetime cap. The operator remains responsible for manual interaction and included-usage decisions. Size requests in task prompts are not resource caps. When usage runs out, preserve the run and choose an explicitly approved plan or wait—no silent billing/provider switch.

During the long worker phase, do another independent task and write `$RUN/return-note.md` with the current run, task and next action. Herdr is the chosen substitute for the lab's literal macOS/cmux tool requirement.
