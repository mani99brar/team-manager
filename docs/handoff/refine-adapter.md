# Handoff: adapter lane of viewer-refine (export 1.10.0 and the viewer contract of the fix loop)

PRD: `docs/PRD_VIEWER_REFINE.md` Appendix A. Decisions: `features/viewer-refine/decisions.md` [L1] to [L7]. This lane changed
`workflow/export_state.py`, `contracts/projects`, `server` and `tests/unit/triage.test.ts` only; the controller, `src/` and the
browser fixtures are untouched.

## Which version carries what

- Export `version`: `1.10.0` (`EXPORT_VERSION`); the server accepts every older version too.
- `fixLoop.contract_version` is `"1.10.0"`: **only there**. The run summary's `contract_version` stays `1.0.0 | 1.5.0` (the server still
  sets `1.5.0`), the definition's and the snapshot's stay `1.0.0`; `reviewResult` and `runInputs` keep `1.4.0` (design-challenge note 4;
  the panel's `panelResults` 1.9.0 is the precedent). The existing typed fixtures are therefore untouched.
- Every key added at 1.10.0 on an existing object is `.nullable().optional()` inside the existing `z.strictObject`
  (`RunDetail.fixLoop`, `ReviewResult.round | delta_from | delta_diff`, `RunInputWorker.roles | skills`,
  `RunInputs.automatic.fix_rounds`). Unknown keys are still refused: the strictness is unchanged, and `npm run build` (`tsc -b`, which
  type-checks `tests/project-workflows/` fixtures that build `RunDetail` by hand) passes with no file there changed (note 1). The
  server always sends them for a 1.10.0 export or a live loop, and leaves them out for an export that predates them, so a 1.9.0 run
  renders exactly as before.

## Mapping table (journal key to export key; the same on the TypeScript live path, `server/fixLoop.ts`)

Required (a missing or mistyped one makes the loop invalid; note 3): `n`, `status` (launched, captured, recorded, applied, blocked),
`mode` (`session` only; a `--commit` entry is skipped before the check), `trigger`, `round`, `rounds`, `lanes` (exactly one key; the lane),
`recorded_at`, `workspace_commit`, and `by`. Every other mapped key defaults to `null` or `[]` when absent, so a `launched` entry is valid.

| Export key | Source |
| --- | --- |
| `n`, `status`, `mode`, `trigger`, `round`, `rounds`, `recorded_at`, `workspace_commit`, `by` (`via` when written) | `repairs.json` entry, as written |
| `node_id` | `repair-<n>` (derived) |
| `lane` | the one key of `lanes` |
| `blocked_step` | derived from `trigger` and `lane`: `verify_<lane>`, `candidate`, `review` (the journal's `blocked.step` string is never copied) |
| `reentered_steps` | `verify_<node_id>` for every `blocked.packets[]` (deduplicated, in order), `[blocked_step]` when there is none and for the other triggers |
| `reason`, `applied_at` | `reason`, `applied_at` (string or `null`) |
| `session_id` | `session.session_id` (`null` until the receipt binds) |
| `review_round` | `review_round` (int or `null`) |
| `findings` | `brief.findings` verbatim (`[]` without a brief) |
| `delta` | `true` only when the basename of `brief.delta` is `review.delta.diff` or `review.delta.round-<k>.diff` |
| `fix_files` | `lanes.<lane>.fix_files` (`[]` until `recorded`) |
| `left_behind` | `left_behind` |
| `requested` | `repair-<n>.interactive.json` `requested` as `{model, effort}`; `null` when the receipt is missing |
| `gate_reasons` | `reasons` of the `blocked.packets[]` entry whose `node_id` is the lane (`[]` for a review round) |
| `review_rounds[]` | `review-rounds.json` `rounds[]` as written (`round`, `verdict`, `candidate`, `lane`, `findings`, `reviewer_sessions`, `started_at`, `archived`), `restored_at` (`null` unless a restore wrote it) |
| `review_rounds[].repair_n` | the repair whose `review_round` names the round |
| `review_rounds[].reviewers` | `reviewers[]` of `review.round-<k>.json` as `{reviewer_id, verdict (approved or blocked or null), session_id}`; a record before parallel reviewers has the single reviewer `review`; `[]` for a restored round or an unreadable archive |
| `rounds` | `plan.automatic.fix_rounds`; else (server, live) the export's, else the last entry's `rounds` |
| `review.round` | 1 + the `review_rounds` with `archived: true` |
| `review.delta_from` | `automatic-review.json` `delta_from` when a string, else `plan.follows.candidate_commit` when `review.delta.diff` exists, else `null` |
| `review.delta_diff` | `{path, sha256, bytes}` of `review.delta.diff`, `null` without the file (served like `review.diff` through the artifact route) |
| `inputs.automatic.fix_rounds` | `plan.automatic.fix_rounds`, left out for a plan without it |
| `inputs.workers.<lane>.roles` | `plan.nodes.<lane>.roles` as `{model, effort}`, `null` without lane pins |
| `inputs.workers.<lane>.skills` | `plan.nodes.<lane>.skills`, `[]` without |

`fix_loop` is `null` for a plan without `automatic.fix_rounds` and without `repairs.json`; the empty loop (`repairs: []`, `review_rounds: []`) for
a plan with `fix_rounds` and no journal yet; the error form `{version, error, rounds: null, repairs: [], review_rounds: []}` for a journal or a
round list that does not parse or whose entries lack a required key. The `review` section never fails because of `review-rounds.json`.

Live reads (server): `repairs.json`, `review-rounds.json`, each `review.round-<k>.json` and each `repair-<n>.interactive.json` are read for every
registered project (no `expose_run_dir` condition) on every projection, the list included. `fixLoop.source` is `live` when `repairs.json` was read
and valid, `export` otherwise; the round list, the archived reviewers and the receipts each fall back to the export's record on their own and that
does not change `source`. Neither valid: the error form (`source: "export"`) with a `warn`, never `RUN_STORAGE_INVALID`. No session repair
anywhere and no export record: no `fixLoop` key at all.

## Derived status of a repair node (A.1 item 5)

`launched | captured | recorded` is `running`, `applied` is `succeeded`, `blocked` is `failed`; attempt 1, `session_id` the entry's, no result. A repair
node's status never enters the run's status (`projectSnapshot` folds the pinned steps only). While a repair is `running`, every step of its
`reentered_steps` reads `running` (attempt and result unchanged). Repair nodes are inserted right after the step they answer, after the
definition hash, so `definition_revision` does not move. A loop whose repair answers a step the definition lacks, or whose node id collides with
one, is invalid as a whole (error form), never half projected.

## Fixture files and tests

`contracts/projects/examples/fix-loop/` holds the real files of `worker-skills-001` copied verbatim (`repairs.json`, `review-rounds.json`,
`review.round-1.json`, `repair-1.interactive.json`, `repair-2.interactive.json`, `automatic-review.json` for `delta_from`,
`review.delta.diff` for `delta_diff`, all 29 KB at most, none truncated) and `expected.json` (the record both mappings must produce; derived
by a separate script from the mapping table, then read by hand). `review.json` was **not** copied: `ExportRuntime` validates it against the
run's bundle and run id, so the export test keeps the legacy run's own `review.json` and takes `round`, `delta_from` and `delta_diff` from the
copied files. `review.diff` is not copied either (`review.diff` is `null` in that test).

- Python: `workflow/test_export.py::FixLoopExportTests`.
- TypeScript: `server/projects.test.ts` `[fix loop]` cases (the pure mapping against `expected.json`; the whole run directory through the server;
  statuses; re-entry; failure isolation; events; review rounds), `contracts/projects/contract.test.ts` (Appendix A's records and the real
  run's record validate; strictness; DAG), `tests/unit/triage.test.ts` (spans, markers, review attempts, focus, the Now sentence).
- Render Appendix A's real-run example through the server: `npx tsx --test --test-name-pattern "real run directory of worker-skills" server/projects.test.ts`
  (it writes the run directory, serves `GET .../runs/<run>`, `/reviews/2`, and the delta artifact, and asserts the detail).

## Contract and triage details

- `fixLoop` is `{contract_version: "1.10.0", source, version: "1.0.0", rounds, repairs, review_rounds}` or the error form (`version`, `error`, `rounds: null`,
  empty lists). Every session-entry field is present in every status. A round reviewer's verdict is `approved | blocked | null`.
  `validateFixLoop` adds the cross-field rules (unique `n`, node id and blocked step follow from the entry, `applied_at` exactly when applied).
- `/reviews/<round>`: the live review is served at the projected attempt (`review.round`, else 1 + the archived rounds); `/reviews/1` is a 404 when
  the live review is round 2. Earlier rounds are read from `fixLoop.review_rounds` on the run detail: the archive has no `bundle_sha256` or
  `reviewed_at`, so no `ReviewResult` is invented for it.
- `repair_<lane>` timeline rows map to their `repair-<n>` node by the `repair-<n>` token first, then by `round <r>` counted per lane
  (`eventGraphNode`, not `eventNode`). A repair row ending `failed` is served `failed` (no other node's row says it).
- `triage.ts`: a repair session is a span of its node (built from the journal entry when the log lacks it); its `repair` marker has
  `node_id` = `blocked_step` and `repair: {n, snapshot, files, session: true, round, trigger}`; the review node has one attempt per archived round (round k
  ends at `review_rounds[k-1].started_at`) plus the live one; a running repair is the focus (the steps it re-enters come second) and `deriveNow`
  says "● Running: repair N of <lane> (round R of M) after <trigger> blocked"; a blocked repair is a focus candidate only while no pinned node runs or
  awaits approval and the run has not succeeded; a run-level `controller_blocked` marker carries `cause: {node_id, repair_n, lane}` when a repair blocked.

## Interim rendering (A.1 item 11)

Between this run's merge and the UI run's merge, main serves `repair-<n>` nodes of kind `worker` to today's viewer, which renders them as generic
worker nodes (the label "Repair <lane> <n>", the status of the journal). `fixLoop` is ignored by the current `src/`.

## Open P2s and assumptions (one line each)

- Operator: `docs/PRD_VIEWER_REFINE.md` line 63 still says repair nodes "come from the export's definition"; rewrite it to "projected by the server from `fixLoop` (Appendix A.1 item 1)" before the `--workers pages,shell` run (decisions.md [L7](d) is about the pages scenario text, not this line).
- Engine follow-up (deferred in decisions.md): the controller does not export right after a round's `launched` entry or on the blocked path; a non-live reader sees the loop only through the live files this server reads.
- `by` is required in the mapping (every `launch_session` entry writes it) although note 3's list does not name it; a missing one is the error form.
- The error form carries `version: "1.0.0"` as the controller writes it ([L8]); A.2's literal omits it, the schema requires it (a contract test covers both). The summary's `contract_version` stays `1.0.0 | 1.5.0`: A.2's heading "run detail `contract_version: 1.10.0`" means the `fixLoop` record's (note 2; the 33 typed fixtures under `tests/project-workflows/` stay valid).
- `controller_blocked` "attention": the controller's attention.json records are not read; the cause is carried on the run-level `controller_blocked` marker (and the focus rules above), which is what `triage.ts` derives attention from.
- `review.json` is not part of the copied fixture (see above); the export test stages `automatic-review.json` and `review.delta.diff` from the folder.
- `test_guardrails`, `test_lanes`, `test_panel`, `test_pipeline` and `test_sidecar` are owned for their seven `EXPORT_VERSION` assertions only; the literal is now `1.10.0`.
- `fix_files` and `left_behind` keep only string items on both paths (Python `strings`, TypeScript `strings`); a test on each side asserts the same output. Absolute paths are redacted on the served record only.
