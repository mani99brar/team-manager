# Ready-to-launch feature: run inputs and finding-to-task links (slice C)

This directory is the committed assignment for the two workers of `docs/PRD_RUN_INPUTS.md`, **not** an implementation. It depends on slice B (`features/review-result`) being merged: the finding-to-task link extends the findings panel. The API contract is `contracts/projects/README.md` (`runInputs`, `.../runs/{run_id}/inputs`; `reviewResult` findings gain `requirement_found_in`). The producer shape is the `inputs` section of `run-state.json` documented in [features/project-workflows/README.md](../project-workflows/README.md#runtime-storage-seam); `workflow export <run>` gives older runs an Assignment view.

```bash
.venv/bin/python -m workflow launch run-inputs --live --automatic --worker-timeout-seconds 7200
```

Default run: `~/.local/state/md-manager-workflows/run-inputs/run-inputs-001`; default branch `feature/run-inputs/run-inputs-001`. `--dry-run` prints the commands without executing anything. Same profile as review-result (policy v1.1.0, `npm ci` setup, three verification attempts per lane/phase, same ownership, no failure drill, native reviewer session with `--reviewer-transport print` as fallback).

## Scenarios

`policy.json` pins the ten review-result scenario IDs plus:

| Scenario id | Asserts |
| --- | --- |
| run-assignment | the Assignment tab shows feature, branch, mode, deadlines, setup commands and both workers' tasks rendered as Markdown |
| worker-inputs | a worker node shows its task, owned paths, required checks linked to executed checks, launch receipt and completion signal |
| finding-to-task | a finding with a verbatim requirement quote links to the worker's Task panel with the quote highlighted; a quote not found is shown without a link |
| inputs-legacy | a seeded run without the `inputs` section shows "inputs not recorded" and no error |
| inputs-paths-redacted | no absolute path from the seeded fixtures appears in the rendered inputs (the PRD table names this `paths-redacted`; the browser suite needs one unique ID per test title, so the inputs variant carries the `inputs-` prefix) |

Every scenario attaches `screenshot:<id>`; both `WORKFLOW_VERIFICATION_PHASE=worker` (mocks) and `candidate` (real backend with seeded runs) must pass without skipping.

## Seeded export shape

Candidate-mode seeds write `run-state.json` with `version: "1.2.0"` and an `inputs` section (raw task texts, so the real adapter redacts absolute paths):

```jsonc
"inputs": {
  "feature": "...", "policy_version": "1.1.0", "base_commit": "<40 hex>", "source_branch": "feature/..." | null,
  "mode": "automatic" | "manual",
  "automatic": {"finish": "verified-feature-branch", "permission_mode": "bypassPermissions",
                "worker_timeout_seconds": 3600, "review_timeout_seconds": 1800, "reviewer_transport": "native" | "print"} | null,
  "setup": [{"argv": ["npm", "ci"], "command": "npm ci", "timeout_seconds": 600}],
  "max_verification_attempts": 3, "failure_drill": null | {"node_id": "adapter", "phase": "worker", "attempt": 1},
  "workers": {
    "ui": {"role": "frontend", "task": "<plan task text>", "prompt": "<exact prompt>" | null,
           "owned_paths": ["src/projects"], "checks": [{"id": "...", "kind": "build", "argv": [...], "command": "npm run build", "timeout_seconds": 180, "scenarios": []}],
           "launch": {"session_id": "<uuid>" | null, "launch_token": "<uuid>", "launch_requested_at": "...Z", "native_started_at": 1790001207771 | null,
                      "observed_state": "working" | null, "status": "attached_session_available", "launcher_invocations": 1, "background_id": "..." | null} | null,
           "completion": {"status": "completed", "summary": "...", "open_assumptions": []} | null,
           "handoff": {"summary": "...", "open_assumptions": []} | null,
           "stop": {"stopped": true, "confirmed_at": "...Z" | null} | null},
    "adapter": {...}
  }
}
```

The adapter serves 404 `INPUTS_NOT_FOUND` for runs without the section, truncates oversized texts with a marker, and computes `requirement_found_in` only from verbatim matches. Seeds use synthetic UUIDs and test-only data.
