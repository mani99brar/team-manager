# Ready-to-launch feature: review verdict and findings in the viewer

Slice B of [docs/PRD_REVIEW_VISIBILITY.md](../../docs/PRD_REVIEW_VISIBILITY.md); the PRD is [docs/PRD_REVIEW_RESULT.md](../../docs/PRD_REVIEW_RESULT.md). This directory is the committed assignment for the two workers, not an implementation. The API contract is `contracts/projects/README.md` (contract 1.1.0: `reviewResult`).

Same roles, ownership, checks and boundaries as [project-workflows](../project-workflows/README.md). Read that README first: the registry seam, the runtime storage seam, the browser fixture rules and the failure bounds all still apply. This file records only what changes for this slice.

## Launch

```bash
.venv/bin/python -m workflow launch review-result --live --automatic --worker-timeout-seconds 7200
```

Run directory: `~/.local/state/md-manager-workflows/review-result/review-result-001`. Branch: `feature/review-result/review-result-001`. This run is the first to exercise the native reviewer session (slice A) inside a full run: a third pane `Claude: reviewer` appears in the run's tab when the review node starts. There is no failure drill in this policy.

## Runtime storage seam: export 1.2.0

`run-state.json` is now written at export version **1.2.0**. Everything from 1.0.0 is unchanged; two sections were added, each `null` when its files are absent:

- `review` (added in 1.1.0), built from `review.json`, `automatic-review.json`, `review.interactive.json` and `review.diff`:

```json
{
  "verdict": "approved",
  "reviewer": "dd7bdcd1-adec-4efe-bcd4-bbadc3525d95",
  "independent": true,
  "transport": "native",
  "attempt": 1,
  "bundle_sha256": "<sha256 of review-bundle.json>",
  "candidate_commit": "<40-hex candidate commit>",
  "findings": [
    {"severity": "P2", "message": "…", "disposition": "open", "worker": "adapter", "requirement": "verbatim quote or null"}
  ],
  "reviewed_at": "2026-09-21T15:42:27.848828Z",
  "session": {"session_id": "…", "background_id": "…", "status": "…", "launch_requested_at": "…", "observed_state": "…", "launcher_invocations": 1, "native_started_at": "…"},
  "diff": {"path": "review.diff", "sha256": "<sha256>", "bytes": 12345}
}
```

  `transport` is `native` (slice A reviewer session), `print` (headless `claude --print`, including every run reviewed before slice A) or `manual` (`workflow review --review-file`; `reviewer` is then the operator's stated identity and `session` is null). `worker` and `requirement` are `null` for findings recorded before slice A. `session` is null for print and manual reviews; `diff` is null when `review.diff` is missing. A blocked verdict is recorded too: `verdict` is `blocked` and the graph's review task carries an error.

- `inputs` (added in 1.2.0) is out of scope for this slice; the adapter must tolerate it (present, absent or null) and serve nothing from it. Slice C (`run-inputs`) consumes it.

The adapter must accept any export whose `version` has major 1 and minor ≥ 0 (`1.0.0` through `1.2.x`), treating missing sections as null. `python -m workflow export <run>` rebuilds older exports under the current version; the operator runs it on `project-workflows-001` after this slice merges, so that run's six findings become visible.

## Public API addition

| Method/path | Response |
| --- | --- |
| `GET .../runs/{run_id}/reviews/{attempt}` | `reviewResult.schema.json` (contract 1.1.0). Only attempt `1` exists; anything else is 404. 404 when the export has no `review` section |

The run detail's review node gets `session_id` = the reviewer identity and `result_uri` = the reviews route when a review is recorded, else both null (no error). `review.diff` is registered as a bounded artifact of kind `patch`, served through the artifacts route with the same confinement and hash rules as packet artifacts; `diff_artifact` is null when the file is missing. Finding messages and requirement quotes pass through `redactPaths`.

## Browser scenarios

The policy pins the six existing scenario IDs (which must keep passing) plus four new ones: `review-verdict`, `review-blocked`, `review-legacy`, `paths-redacted`. Worker mode mocks the reviews route with the contract example; candidate mode seeds `run-state.json` at version `1.2.0` with a `review` section (and `inputs: null`) in the shape above, plus a `review.diff` file, and one run without a `review` section.

## Out of scope (decided)

Issues #3 (stale task error projects a verified node as failed) and #6 (unredacted raw error) stay out. No launch, approve or retry controls. No live transcript streaming.
