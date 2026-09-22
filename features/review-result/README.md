# Ready-to-launch feature: review verdict and findings in the viewer (slice B)

This directory is the committed assignment for the two workers of `docs/PRD_REVIEW_RESULT.md`, **not** an implementation. The API contract is `contracts/projects/README.md` (`reviewResult`, `.../runs/{run_id}/reviews/{attempt}`). The producer shape is the `review` section of `run-state.json` documented in [features/project-workflows/README.md](../project-workflows/README.md#runtime-storage-seam); `workflow export <run>` re-exports older runs so project-workflows-001 shows its own six findings after this slice merges.

```bash
.venv/bin/python -m workflow launch review-result --live --automatic --worker-timeout-seconds 7200
```

Default run: `~/.local/state/md-manager-workflows/review-result/review-result-001`; default branch `feature/review-result/review-result-001`. `--dry-run` prints the commands without executing anything. The profile is the same as project-workflows (policy v1.1.0, `npm ci` setup, three verification attempts per lane/phase, same ownership) without the checkpoint failure drill. The independent reviewer runs as a native attachable session (slice A): a third `Claude: reviewer` pane appears in the run's tab when the review node starts, and `--reviewer-transport print` keeps the headless fallback. See `workflow/RUNBOOK.md`.

## Scenarios

`policy.json` pins the six project-workflows scenario IDs plus:

| Scenario id | Asserts |
| --- | --- |
| review-verdict | review node shows approved, reviewer session, bundle hash linked to the candidate node, the summary line, and a findings table with severity and disposition (6 rows grouped 4 open + 2 accepted) |
| review-blocked | a seeded blocked review shows verdict blocked, node failed, run failed, and the findings that caused it |
| review-legacy | a seeded run whose export is version 1.0.0 shows "no review recorded" and no error |
| paths-redacted | no absolute path from the seeded fixtures appears in the rendered review (`innerText`), while `<path>` does |

Every scenario attaches `screenshot:<id>`; both `WORKFLOW_VERIFICATION_PHASE=worker` (mocks) and `candidate` (real backend with seeded runs) must pass without skipping.

## Seeded export shape

Candidate-mode seeds write `run-state.json` with `version: "1.2.0"` and a `review` section (or `"1.0.0"` without it for the legacy run):

```jsonc
"review": {
  "attempt": 1, "transport": "native" | "print" | "manual",
  "reviewer_session_id": "<uuid or operator identity>", "independent": true,
  "bundle_sha256": "<64 hex>", "candidate_commit": "<40 hex>",
  "verdict": "approved" | "blocked",
  "findings": [{"severity": "P2", "message": "...", "disposition": "open", "worker": "ui" | null, "requirement": "verbatim quote" | null}],
  "reviewed_at": "2026-09-21T15:42:27.848828Z",
  "diff": {"path": "review.diff", "sha256": "<64 hex>", "bytes": 289187} | null
}
```

The adapter registers `review.diff` as artifact `patch-review-<sha12>`, redacts paths in messages and quotes, and serves 404 `REVIEW_NOT_FOUND` for runs without the section. Seeds use synthetic UUIDs and test-only data.
