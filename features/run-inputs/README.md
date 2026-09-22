# Ready-to-launch feature: run inputs and finding-to-task links

Slice C of [docs/PRD_REVIEW_VISIBILITY.md](../../docs/PRD_REVIEW_VISIBILITY.md); the PRD is [docs/PRD_RUN_INPUTS.md](../../docs/PRD_RUN_INPUTS.md). Depends on slice B ([review-result](../review-result/README.md)) being merged: the finding-to-task link extends the findings panel. This directory is the committed assignment for the two workers, not an implementation. The API contract is `contracts/projects/README.md` (contract 1.2.0: `runInputs`, `runInputsResponse`, and `requirement_verbatim` on review findings).

Same roles, ownership, checks and boundaries as [project-workflows](../project-workflows/README.md); read that README and the review-result README first.

## Launch

```bash
.venv/bin/python -m workflow launch run-inputs --live --automatic --worker-timeout-seconds 7200
```

Run directory: `~/.local/state/md-manager-workflows/run-inputs/run-inputs-001`. Branch: `feature/run-inputs/run-inputs-001`. No failure drill.

## Runtime storage seam: the `inputs` section (export 1.2.0)

`run-state.json` carries an `inputs` section, `null` for runs exported before 1.2.0 until `python -m workflow export <run>` rebuilds them. It is built from `plan.json`, `policy.json`, `<worker>.interactive.json`, `<worker>.completion.json`, `<worker>.handoff.json` and `<worker>.stop.json`:

```json
{
  "feature": "review-result",
  "base_commit": "<40-hex>",
  "source_branch": "feature/review-result/review-result-001",
  "mode": "interactive",
  "created_at": "2026-09-21T14:33:23.528543Z",
  "automatic": {"finish": "verified-feature-branch", "permission_mode": "bypassPermissions", "worker_timeout_seconds": 7200, "review_timeout_seconds": 1800, "reviewer_transport": "native"},
  "setup": [{"command": "npm ci", "timeout_seconds": 600}],
  "max_verification_attempts": 3,
  "workers": [
    {
      "node_id": "ui", "role": "frontend",
      "task": "<the assignment text exactly as prepared, ending with the appended policy JSON block>",
      "task_truncated": false,
      "owned_paths": ["src/App.tsx", "..."],
      "checks": [{"id": "frontend-build", "kind": "build", "command": "npm run build", "timeout_seconds": 180, "scenarios": []}],
      "launch": {"status": "attached_session_available", "session_id": "…", "launch_token": "…", "launch_requested_at": "…Z", "native_started_at": "…Z", "observed_state": "working", "launcher_invocations": 1},
      "completion": {"status": "completed", "summary": "…", "open_assumptions": []},
      "handoff": {"summary": "…", "open_assumptions": []},
      "stopped": true,
      "stopped_at": "…Z"
    }
  ]
}
```

Rules the export already applies: `feature` is null for runs prepared without `--feature`; `automatic` is null for manual runs; `reviewer_transport` is absent from `automatic` for runs prepared before slice A (treat as `print`); `launch`, `completion`, `handoff` and `stopped` are null when their file is absent; `stopped_at` is null for stop markers written before 1.2.0; task text over 256 KiB is cut and ends with a `[task text truncated …]` marker with `task_truncated: true`. Task text is the exact assignment the worker received in its prompt (task file plus the appended `Approved ownership and checks:` JSON); the controller's fixed preamble and completion-protocol sentences are not part of it.

## Public API additions

| Method/path | Response |
| --- | --- |
| `GET .../runs/{run_id}/inputs` | `runInputsResponse`: `{ "inputs": RunInputs \| null }` (contract 1.2.0). `null` when the export has no `inputs` section; 404 only for an unknown run |
| `GET .../runs/{run_id}/reviews/1` | as in slice B, plus `requirement_verbatim` on each finding: `true` when the quote is found verbatim in the named worker's task text (both tasks for `both`), `false` when it is not, `null` when `requirement` or `worker` is null or `worker` is `none` |

Redaction: task text, summaries, assumptions, finding messages and requirement quotes all pass through `redactPaths`; the verbatim lookup compares redacted quote to redacted task so the flag stays consistent with what the viewer shows. Reads are bounded; the adapter never guesses a fuzzy match.

## Browser scenarios

The policy pins the ten scenario IDs from slice B (unchanged in meaning; `paths-redacted` now also covers rendered inputs) plus `run-assignment`, `worker-inputs`, `finding-to-task`, `inputs-legacy`. Candidate mode seeds `inputs` in the shape above for at least one run, `inputs: null` for one run, findings whose quotes are and are not found verbatim, and absolute paths inside seeded task text.

## Out of scope

Fuzzy matching of requirement quotes (measure the verbatim match rate on this run first). Launch, approve, retry controls. Live transcript streaming.
