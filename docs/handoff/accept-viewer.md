# Handoff: accept-override viewer (run accept-override-003)

What the viewer lane assumed of the export. The engine's own handoff (`docs/handoff/accept-engine.md`) and
`contracts/workflow/accepted.schema.json` state the producer side; decisions.md [L8], [L12] and [L15] bind both.

## The export

- Export version `1.12.0` is accepted by `server/projects.ts` (`EXPORT_VERSIONS`). The top-level key `accepted` is the
  `accepted.json` object exactly as written, or `null` for a run without one; exports before 1.12.0 omit the key. All three
  load (`server/projects.test.ts`, "a 1.12.0 export with accepted ...").
- The object is parsed with `z.strictObject` (`acceptedRecordSchema` in `contracts/projects/v1.ts`): `version` ("1.0.0"),
  `run_id`, `candidate` (40-hex), `reason`, `by`, `accepted_at`, `on_main` (boolean), `review` ("recorded" | "none") and
  `open_findings` are required; `via` is optional; no other key. Each finding is `{severity: P0|P1|P2, reviewer, title, lane: string|null}`
  with all four keys required.
- `accepted_at` is a UTC ISO date-time (`2026-10-08T09:30:00Z`); a non-ISO value or an offset form is refused as an invalid run.
- `open_findings` are taken as already computed by the engine ([L5]): the viewer lists them verbatim and never recomputes from `review`.
- An abandoned run keeps its `cancelled` controller row; the viewer serves the run as `succeeded` with `accepted.abandoned` set to
  that row's (redacted) message. The accept row (`Accepted by the operator: ...`) is a controller process row, not a lane's.

## What the viewer serves (viewer-owned, [L12])

- `RunSummary.accepted` and `RunDetail.accepted` (same value, otherwise the detail is refused): `{candidate, reason, by, accepted_at,
  on_main, review, open_findings, abandoned}`. The run's status stays `succeeded`; the engine's run-status enum is unchanged.
- Every status-keyed site checks `accepted` first: the chip, triage glyph and headline, `projectTone`, `filterRecent`,
  `isFinished`, `stateTone` (including the project page's group-head card), the live dock's bar and `finished`.
