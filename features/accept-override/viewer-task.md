# Task: viewer

## Goal

The Projects run page and runs list show a run accepted by the operator as "integrated (operator override)", visibly distinct from a reviewed integration, with the reason, who and when, the candidate and the findings open at acceptance (docs/PRD_ACCEPT_OVERRIDE.md).

## Context

Follow-up run accept-override-002 ([L14]): this run starts from accept-override-001's candidate a8d43fc, restored into your owned paths by the controller. Fix only the findings below that name your lane (and the P2s [L14] folds in); do not rebuild what passed. What `python -m workflow brief` printed for your lane of 001, verbatim:

## Lane viewer

Owned paths (this run's pinned policy): `server`, `contracts/projects`, `src/projects`, `tests/unit`, `tests/project-workflows`, `docs/handoff/accept-viewer.md`

Restore the candidate's version of these paths in the follow-up lane's worktree (a path it does not have is removed), then check that nothing differs (the last command prints nothing once restored):

```sh
git restore --source=a8d43fc91653511b100253c2d4d9729e9fe0d646 --staged --worktree -- server contracts/projects src/projects tests/unit tests/project-workflows docs/handoff/accept-viewer.md
git diff --stat a8d43fc91653511b100253c2d4d9729e9fe0d646 -- server contracts/projects src/projects tests/unit tests/project-workflows docs/handoff/accept-viewer.md
```

**Findings on this lane:**

- [P1 open] The runs list does not show who accepted the run or the findings open at acceptance. The row for an accepted run (src/projects/RunRow.tsx:41-51) shows the override chip, the finish time and rowSummary. rowSummary (src/projects/lists.ts, the `if (run.accepted)` branch) returns only `integrated (operator override) <sha7>: <reason>`. Neither the actor (`accepted.by`) nor the open findings (severities or a count; acceptedFindingsText exists in triage.ts but only the run page uses it) appear anywhere in the row. Inputs: the ux-accepted fixture `accepted-blocked` (one P1 and one P2 open, by operator) on the workflow runs list. Expected (task): "The run page and runs list show the override outcome with its own chip, the reason, actor, time, short candidate sha and each open P0/P1/P2". Actual: the list row has no actor and no findings. accepted.spec.ts only checks the chip and the reason in the list, so the browser scenario passes without them. Consequence: an operator scanning the runs list sees an override with its reason but cannot tell who accepted it or that open P0/P1 findings came with it without opening each run. (reviewer general; requirement: 'The run page and runs list show the override outcome with its own chip, the reason, actor, time, short candidate sha and each open P0/P1/P2')
- [P2 open] projectTone ranks the override above live runs. In projectTone (src/projects/lists.ts) `if (latest?.accepted) return 'override'` comes before the live-run tones. When a project's latest finished run is accepted, the project reads 'override' even while another run is running, paused or awaiting approval. Before this change a succeeded latest run let the live tone win; only a failed latest run beat it. An accepted run is served as succeeded and is not a failure, so its tone belongs where 'ok' sits, after the live tones. Untested: accepted.test.ts only checks a single accepted run. Consequence: the rail and the project card hide an active or awaiting-approval run behind the purple override tone until the operator opens the project. (reviewer general; requirement: 'chip, triage glyph and headline, projectTone, filterRecent and isFinished check `accepted` first')
- [P2 open] The runs-list half of this line is weakly covered. On the run page, accepted.spec.ts '[scenario:accepted-run-outcome]' asserts the chip, reason, actor, time, short sha and two findings. In the runs list it asserts only the override chip and the reason. RunRow shows rowSummary (src/projects/lists.ts:1308: label, short sha, reason) plus the run's finish time, but not who accepted it, accepted_at, or the open findings. No fixture has a P0, so the P0 rendering is never exercised. If the line means the list must also show actor, time and every open finding, the list does not. If it means only the run page, the list part is unasserted beyond chip and reason. Consequence: someone scanning the runs list cannot see who overrode the review or which findings were open without opening the run, and a regression in list or P0 rendering would not be caught. (reviewer coverage; requirement: 'The run page and runs list show the override outcome with its own chip, the reason, actor, time, short candidate sha and each open P0/P1/P2; an accepted run that was abandoned reads as the override, with the abandon reason kept as history.')
- [P2 open] [L13](d) has no test. The regex /^Accepted by the (?:operator|maintainer)\b/ was added to CONTROLLER_PROCESS_ROWS (server/projects.ts:493). It only takes effect in eventGraphNode (server/projects.ts:1452), when the run has a lane named `controller`. No server/projects.test.ts case seeds such a lane together with the accept row. The [accepted] tests use the default lanes, so they pass with or without the regex. Consequence: removing or mistyping the pattern would attribute an accepted run's `Accepted by the operator` row to a lane named controller, and no check would fail. (reviewer coverage; requirement: 'An accepted run is `succeeded` with a viewer-owned `accepted` field on RunSummary and RunDetail ([L12]); chip, triage glyph and headline, projectTone, filterRecent and isFinished check `accepted` first; [L13] (a) and (d) are yours.')

**The worker's own claims:**

- Untested: The real engine export (no engine example available to parse here); Dark-theme contrast of the override chip colours; Runs home Recent/Needs-you rendering of an accepted run in the browser (covered by unit tests only)
- Verify yourself: That the engine's accepted.json/export key set is exactly decisions.md L8 (a strict parse rejects any extra key and makes the whole run invalid).
- Open assumptions: reading: 'a viewer-owned `accepted` field on RunSummary and RunDetail': both carry it (detail.accepted equals detail.summary.accepted, validated); the served shape drops version/run_id and adds `abandoned`.; reading: 'visibly distinct ... its own tone': added a new Tone 'override' (purple, theme.css) and glyph '◆'; tests/unit/tone.test.ts TONES list extended.; The engine's accepted*.json example does not exist in this worktree; the L13(a) test passes vacuously outside the candidate phase and fails in it if absent (note 6).; Notes 3, 5 and 7 are engine-lane work; not done here. For note 7 the viewer keeps the strict parse, so an invalid accepted.json makes the run RUN_STORAGE_INVALID.

The engine lane adds the record to the export under a new top-level key; build against the exact key set in decisions.md [L8]; the engine's handoff (`docs/handoff/accept-engine.md`) only confirms it. Start from how `tryout` reaches the viewer: `server/projects.ts`, `contracts/projects/v1.ts`, `contracts/projects/triage.ts`, `src/projects/RunHeader.tsx`, `tests/project-workflows/ux-run.spec.ts`. An abandoned run currently reads `cancelled` (FINISHED_STATUSES in `contracts/projects/v1.ts`).

Version: the engine raises the export version to exactly "1.10.0": add it to EXPORT_VERSIONS in `server/projects.ts` (an export outside that list is rejected as an invalid run), seed every accepted fixture at 1.10.0, and have `server/projects.test.ts` load a 1.10.0 export with `accepted` present, null and absent ([L1]). Each open finding is `{severity, reviewer, title, lane}` ([L5]).

## Constraints

Only your owned paths. No new runtime dependency. A run without the record looks exactly as before.

## Acceptance

- An accepted run is `succeeded` with a viewer-owned `accepted` field on RunSummary and RunDetail ([L12]); chip, triage glyph and headline, projectTone, filterRecent and isFinished check `accepted` first; [L13] (a) and (d) are yours.
- The export's `accepted` object is parsed with exactly the key set of [L8] (z.strictObject, `via` optional), not the PRD bullet; fixtures use that exact shape.
- The run page and runs list show the override outcome with its own chip, the reason, actor, time, short candidate sha and each open P0/P1/P2; an accepted run that was abandoned reads as the override, with the abandon reason kept as history.
- `server/projects.test.ts` and `tests/unit` cover the mapping (with and without the record); the browser scenarios `accepted-run-outcome` and `accepted-after-abandon` pass.
- A run with `accepted` counts as finished in the project snapshot, triage and `src/projects/lists.ts`: an accepted run that was never abandoned is neither in Needs you nor running, shown by a unit test ([L7]).
- `docs/handoff/accept-viewer.md` lists what you assumed of the export.

Run targeted tests while iterating, then this lane's non-browser policy checks once before writing the completion; run browser specs only through check-report on this lane's own specs.

Browser checks: each scenario id appears in exactly one test title as `[scenario:<id>]`, and that test, when it passes, attaches exactly one image/png named `screenshot:<id>` (other attachments are fine). The verifier refuses anything else. Before completing, run the spec files you changed with a JSON report:

```bash
WORKFLOW_VERIFICATION_PHASE=<worker|candidate> PLAYWRIGHT_JSON_OUTPUT_FILE=<tmp>/report.json \
  npx --no-install playwright test --config=tests/project-workflows/playwright.config.ts --reporter=json <spec files>
```

Then check the report with the verifier's own rules: run the exact `check-report` command the controller appends to this task when it pins it.

## Stop

Stop and report `blocked` if the export shape the engine handoff names cannot be shown without changing a contract file the engine lane owns.
