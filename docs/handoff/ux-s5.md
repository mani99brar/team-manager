# Handoff: Viewer UX slice S5, the backend

Slice S5 of [PRD_VIEWER_UX.md](../PRD_VIEWER_UX.md) (section 11, and 9.2 B1, B2 and B3). Branch `ux/s5`, made from `feature/viewer-ux`. S5 changes nothing in `src/`, in any browser spec or browser fixture, in `contracts/projects/triage.ts` or in `package.json`.

Files changed: `server/projects.ts`, `server/projectsConfig.ts`, `server/projects.test.ts`, `contracts/projects/v1.ts`, `examples.ts`, `contract.test.ts`, `runList.schema.json`, `runDetail.schema.json`, `contracts/projects/README.md`, `config/projects.example.json`, and this note. Every file is in the S5 row of section 11. `server/app.ts` is untouched: the two new store options are injected in the tests by building a `RunStore` directly.

## What shipped

**B1. Projection fixes** (`server/projects.ts`, no contract change):
- `attemptFromMessage` reads a node's attempt only from the controller's own phrases, at the start of the message: `^(?:Attempt|Design challenge attempt|Feature files re-pinned for design challenge attempt) (\d+)\b`. The served challenge rows of skeleton-001 now read attempts 1, 2, 2, 2, 3, 3, 3 instead of all 1. The snapshot is unchanged, see the guard below.
  - The first commit used the PRD's `/\battempt (\d+)\b/i`. The review found that it also reads the attempts a repair note quotes (see Deviations 8), so the second commit anchors it.
- On a lane named `controller`, a raw `controller` row whose message is a controller-process row is the run's before any lane aliasing, in `normalizeEvents` and in `projectSnapshot` alike. The patterns are those of the PRD: `^Automatic checkpoint controller PID`, `^Supervisor interrupted`, `Claude Code was unavailable`, `failed identically`, `^Repair \d+ applied` and `^\[Errno`. The lane's own `controller` rows (launching, awaiting the signal) stay on `launch_controller`.
- A PID row never sets a node's last status in `projectSnapshot`.
- A combined-check row aliased from `candidate_<lane>` is served with the message prefix `[<lane>] `. S2's `humanizeEvent` already drops it.
- Raw `controller` rows served without a node keep their status (`blocked` → `failed`, `interrupted` → `paused`, `running` → `running`) as `type: 'log'` events. Rows of every other node-less source keep `status: null`.

**B2. `RunSummary.activity`**, contract 1.5.0. `projectRun` computes it from what it already read (export, plan, events, projected inputs and review) plus one bounded read (256 KiB) of `<lane>.questions.json` per selected lane, and only while the run can still move. The rules are S2's, imported from `triage.ts` and not edited:
- `buildTimeline`: `last_activity_at` (`lastActivity`) and `finished_at` (`runEnd`)
- `deriveFocus`: `focus`
- `deriveAttention`: `question`, `pane` and `approval`, and `waiting_questions` (the count of lanes whose question waits)
- `deriveNow`: `interrupted` (rule 5, cases a, b and d) and the source-0 controller row of the headline
- `humanizeEvent`: the headline's message

The fields:
- `attention` precedence: question > pane > approval > interrupted > paused > failed. `paused` and `failed` are the run's own status at its focus.
- `headline`: `<focus label> · <humanized last status message>`, for example `Verify combined candidate · combined revision 1ab6b95 (ui)`. The lane of a prefixed candidate row is kept in parentheses. When a controller row in scope stopped the run (6.2 reason source 0), that row is the message. Without a focus (a succeeded run), the step with the last status row speaks. A focus with no status row uses its latest row. The headline is redacted, collapsed to one line and cut to 160 characters with `…`.
- `waiting_questions` and `attention.kind: 'question'` read each live lane's questions file. Its entries replace the export's by number when the merged list is consistent (numbered from 1, at most 3, only the latest waiting, an answer with its time). A stale export's `question` completion is dropped once the file shows the question recorded. The served `/inputs` stay the export's record.
- `controller`: read only while the run is `running` or `paused` and has a `controller` row `Automatic checkpoint controller PID <n>` (the latest one). The store takes an injectable `procRoot` (default `/proc`).
  - `unknown`: `<procRoot>/self/stat` is unreadable.
  - `not_running`: `/proc/<n>` is gone, or its `cmdline` holds no `automatic-step` followed by an absolute argument whose realpath is this run directory's realpath (the realpath of the opened directory handle).
  - `running`: the argv matches and the start time is no later than the PID row plus 1 s. The start time is `stat` field 22 counted after the last `)` of the command name, at USER_HZ 100, plus `btime` from `/proc/stat`.
  - `unknown`: the argv matches but the process started later, or the start time cannot be read.
  - Nothing ever calls `process.kill`.

**B3. Opt-in run directory.**
- `server/projectsConfig.ts` `fileSchema` accepts an optional top-level `"viewer": {"expose_run_dir": ["<project id>", …]}`. It is a strict object of ID-pattern strings; an ID may name a project not registered yet. Unknown top-level keys, unknown `viewer` keys and non-ID entries are still refused.
- `ProjectsConfig.viewer` is present only when the file has the key, so `{ projects: [] }` stays deep-equal. `assertProjectsConfig` keeps it, so the hot-reloaded registry (`projectsConfigReloader` → `app.ts` → `assertProjectsConfig`) carries it. A registry edited while the viewer runs takes effect on the next request (tested).
- `RunDetail.run_dir` is `~/<path>` when the project is listed and the run directory's realpath lies under the realpath of `$HOME`. The store takes an injectable `home`. It is null otherwise: an unlisted project, a directory outside home, an unresolvable path, or a path that would not paste unquoted (see Deviations).
- `config/projects.example.json` shows the key with an empty list: off.

**Contract 1.5.0** (`v1.ts`, both schema JSONs regenerated with `npx tsx contracts/projects/export.ts`, `examples.ts`, `contract.test.ts` and `README.md` updated together):
- `runSummarySchema.contract_version` is `'1.0.0' | '1.5.0'`. The server serves `1.5.0` with `activity`. A 1.0.0 summary (an older server, and every worker-phase mock in `tests/project-workflows/fixtures.ts`) carries neither `activity` nor a `run_dir` beside it, and stays valid.
- New exports: `runActivitySchema`, `ATTENTION_KINDS`, `CONTROLLER_STATES`, `RUN_DIR_PATTERN` and `type RunActivity`.
- Cross-field rules:
  - On the summary schema, so run lists get them too: `activity` is present exactly on 1.5.0; `finished_at` only on a succeeded, failed or cancelled run; `controller` only on a running or paused run; `attention.kind === 'question'` exactly when `waiting_questions > 0`.
  - In `validateRunDetail`: `run_dir` is present exactly with a 1.5.0 summary; `focus` names a node in its snapshot status; `attention.node_id` is a node of the definition.

## Red evidence

The tests were written first. The only product code touched before the red run was a skeleton export in `v1.ts`: the constants `ATTENTION_KINDS` and `CONTROLLER_STATES`, which the contract test imports.

```
npx tsx --test server/projects.test.ts
ℹ tests 51   ℹ pass 40   ℹ fail 11          (the 40 existing tests pass; all 11 new ones fail)
```

Key failing lines:

```
[B1] attempts … case-insensitively      skeleton-001  actual [1,1,1,1,1,1,1]  expected [1,2,2,2,3,3,3]
[B1] on a lane named controller …       actual [5,'launch_controller','running','status_changed',1] [6,'launch_controller','failed','status_changed',1]
                                        expected [5,null,'running','log',0] [6,null,'failed','log',0]
[B1] candidate events name the lane     actual 'Combined revision bbbb…'  expected '[ui] Combined revision bbbb…'
[B1] node-less controller rows …        actual [null,null,'log',0,'Worker ui deadline exhausted; …']  expected [null,'failed','log',0,…]
[B2] a run summary carries its activity AssertionError: fresh  '1.0.0' !== '1.5.0'
[B2] waiting questions … live file      AssertionError: asking: the run summary carries its activity
[B2] a pane that needs attention …      AssertionError: pane: the run summary carries its activity
[B2] controller liveness …              AssertionError: …/proc-running: the run summary carries its activity
[B2] every browser fixture run …        AssertionError: feature-flow/run-awaiting  '1.0.0' !== '1.5.0'
[B3] run_dir is served with ~ …         ProjectsConfigError: viewer registry: (root): Unrecognized key: "viewer"
[B3] the registry accepts … viewer key  ProjectsConfigError: viewer: (root): Unrecognized key: "viewer"
```

```
npx tsx --test contracts/projects/contract.test.ts
ℹ tests 13   ℹ pass 11   ℹ fail 2
✖ project examples and generated schemas agree      ZodError: runs.0.contract_version invalid_value (expected "1.0.0"); runs.0 unrecognized_keys ["activity"]
✖ run lists and details 1.5.0 …                     ZodError: summary.contract_version invalid_value; summary unrecognized_keys ["activity"]
```

The B1 guard part of the first test (snapshot attempts of the captured runs and of every seeded fixture) passes before and after, which is its purpose. Its red is the served challenge attempts.

**Test-authoring mistakes, not product reds:**
1. The first contract red run failed to import (`SyntaxError: … does not provide an export named 'ATTENTION_KINDS'`): my edit adding the skeleton constants to `v1.ts` had not applied. I added it and re-ran; the lines above are that run.
2. In the first server red run, the question, pane and controller tests failed with `TypeError: Cannot read properties of undefined` further on instead of an assertion. A helper `activityOf()` now asserts that the summary carries its activity first. The server lines above are from the re-run after that change.

## Green evidence

```
npx tsx --test server/projects.test.ts                    ℹ tests 51  ℹ pass 51  ℹ fail 0
npx tsx --test contracts/projects/contract.test.ts        ℹ tests 13  ℹ pass 13  ℹ fail 0
npx tsx --test contracts/projects/contract.test.ts contracts/workflow/contract.test.ts   ℹ tests 23  ℹ pass 23
npx tsx --test server/app.test.ts server/config.test.ts   ℹ tests 12  ℹ pass 12
npx tsx --test tests/unit/triage.test.ts                  ℹ tests 60  ℹ pass 60   (its fixtures validate against the bumped contract)
npx tsc -b                                                clean
npx eslint server/projects.ts server/projectsConfig.ts server/projects.test.ts contracts/projects/v1.ts contracts/projects/examples.ts contracts/projects/contract.test.ts   clean
WORKFLOW_VERIFICATION_PHASE=candidate npx playwright test -c tests/project-workflows/playwright.config.ts --reporter=line   37 passed (3.0m)
npx playwright test -c tests/project-workflows/playwright.config.ts --reporter=line                                         37 passed (2.8m)
```

**The candidate phase is unchanged by B1.** It runs the whole project-workflows suite against the real server and seeded runs, and no browser assertion changed:
- The seeds write combined-check rows under the raw node `candidate`, never `candidate_<lane>`, so none gets the prefix.
- The one seeded `controller` row (the fourth question of `run-guarded-blocked`) is now served with `status: 'failed'`. Today's UI drops node-less rows.

**The worker phase** confirms that the 1.0.0 mocks still validate.

## Migrations

None. No existing assertion changed. The 40 existing server tests, the 12 existing contract tests and the 37 browser scenarios in both phases pass unchanged. The contract examples changed shape (`runDetail` and `runList` are now 1.5.0, and `legacyRunDetail` is the 1.0.0 form), and the existing 'examples and generated schemas agree' test reads them as before.

## Review fixes (second commit)

An independent review raised four items:

| Item | Outcome |
|---|---|
| P2: B1's `/\battempt (\d+)\b/i` reads a repair note's quoted attempts | Fixed with anchored phrases (Deviation 8) |
| P3: the operator follow-up names only two project IDs | Fixed: the follow-up lists every ID and gives a command to list them |
| Gap: no guard case with a repair note that quotes another node's attempt | Fixed: new test `[B1] a repair note's quoted attempts and reason are not its node's attempt; …` |
| Gap: the seeded-fixture test pins only attention and the headline length | Fixed: `SEEDED_ACTIVITY` pins every field. A live `questions.json` fixture is S6's (12.3) |

**Red.** The new B1 test, run against the first commit:

```
npx tsx --test --test-name-pattern="repair note" server/projects.test.ts
✖ [B1] a repair note's quoted attempts and reason are not its node's attempt; …
  AssertionError: the repair note keeps the attempt its node was on
  actual:   [ [ 1, 1 ], [ 2, 1 ], [ 7, 4 ], [ 10, 2 ] ]
  expected: [ [ 1, 1 ], [ 2, 1 ], [ 7, 1 ], [ 10, 2 ] ]
```

The first match wins, so the note got attempt 4, from the operator's reason. A scratch script ran the same rows through `projectSnapshot` and printed `verify_game snapshot running attempt 4`. After the fix it prints `attempt 2`.

The stronger seeded-fixture test passes on the first commit as well. It pins what the first commit already served, so it has no product red.

**Green.**

```
npx tsx --test server/projects.test.ts                    ℹ tests 52  ℹ pass 52  ℹ fail 0
npx tsx --test contracts/projects/contract.test.ts        ℹ tests 13  ℹ pass 13  ℹ fail 0
npx tsc -b                                                clean
npx eslint server/projects.ts server/projects.test.ts     clean
WORKFLOW_VERIFICATION_PHASE=candidate npx playwright test -c tests/project-workflows/playwright.config.ts --reporter=line   37 passed (4.1m)
npx playwright test -c tests/project-workflows/playwright.config.ts --reporter=line                                         37 passed (5.5m)
```

The first worker-phase run of this round ended at 24 passed and 13 failed. The host's load average was 7-8 at the time, with S3's Playwright run and an `npm ci` beside it. I did not keep the failure output.
- A `--last-failed` re-run passed all 13.
- A full worker-phase re-run then passed all 37 (the line above).
- The worker phase serves mocks, and this round changed no contract and no mock, so the failures were not this change. They are worth watching if they recur on an idle host.

The candidate phase still changes no browser assertion. No seed writes a repair note, and every seeded challenge row starts with an anchored phrase.

The first B1 test was renamed `[B1] the design challenge's lower-case attempt phrases are read; …`, because attempts are no longer read case-insensitively anywhere in a message.

## Deviations from the PRD

1. **Per-message version.** The PRD calls `activity` optional. Following the per-message convention (`runInputs` carried 1.3.0 until 1.4.0), a summary that has `activity` says `contract_version: "1.5.0"`, and a 1.0.0 summary has none.
   - The schema accepts both versions, so S1's worker-phase mocks, built by `fixtures.ts` `runDetail()` at 1.0.0, validate unchanged.
   - "Optional" therefore means "absent at 1.0.0". At 1.5.0, `activity` on every summary and `run_dir` on every detail are required by cross-field rules.
   - S6's mocks that carry `activity` must say `1.5.0`, and their details need `run_dir` (null is fine).
2. **`run_dir` is also null for paths a shell would split**, and for `.`/`..` segments: any character outside `[A-Za-z0-9._@+/-]`. The PRD lists only unlisted, outside `$HOME` and unresolvable. A served `RUN=~/a b/…` would not be paste-ready. `RUN_DIR_PATTERN` is shared by the schema and the server.
3. **`last_activity_at` and `finished_at` come from S2's timeline**, not only from raw events. `last_activity_at` also counts stop receipts and the review verdict; `finished_at` is the last non-controller moment of a succeeded, failed or cancelled run. The PRD says "last raw event that is not a PID checkpoint" and "last status event or review.reviewed_at". The timeline is what the run page shows, so the two agree. For skeleton-001 it gives 09:32:31 (the print review's verdict), as 5.2 rule 10 requires.
4. **Headline wording.** It includes the focus label, as the PRD's field comment says. A focus without a status row falls back to its latest row, for example the failure-drill row `Injected gate failure (failure drill); checks preserved`, whose raw status maps to none. Without a focus, the step with the last status row speaks, so a succeeded run reads `Integrate candidate · fast-forwarded to …`.
5. **`attention.kind: 'interrupted'`** comes from `deriveNow`'s situation, cases (a), (b) and (d). Case (c) needs readings over 15 s, which only the client has.
6. **The "every fixture" guard** is a table in `server/projects.test.ts`. It pins the pre-B1 snapshot `node:status:attempt` of every browser fixture run, seeded with `seedCandidate` as the candidate phase seeds it. It also reconstructs the raw rows of the three captured runs from their served events, and checks that each verification node's event-derived attempt equals the served attempt. `projectSnapshot` reads message attempts only there, through `eventAttempt` and `Math.max`.
   - The same test file seeds every browser fixture again and checks that each run serves a valid 1.5.0 summary whose list row equals its detail. The whole activity of the 15 current runs is pinned (`SEEDED_ACTIVITY`): feature, `last_activity_at`, `finished_at`, focus with its `since`, attention with its `since`, `waiting_questions`, the exact headline, and a null `controller`.
   - Runs added by later slices are loaded and validated, but not pinned.
   - The captured runs have no repair note that quotes another node's attempt: in skeleton-001 #20, the quoted `worker/game attempt 2` is the lane's own. A separate test builds that case (Deviation 8).
7. **`projectSnapshot`'s `lastController`** still takes any raw `controller` status row, including a controller lane's own rows. That was the behaviour before; B1 names only the node aliasing and the PID rule. C6 (reserve the lane ID) removes the collision.
8. **The attempt of a row comes only from the controller's own anchored phrases**, not from the PRD's `/\battempt (\d+)\b/i`.
   - The PRD pattern also matches the attempts that `repair.py` `finish_repair` quotes on `verify_<lane>`: `Answers <phase>/<lane> attempt N` for every blocked packet, after the operator's free-text `Reason:`.
   - Take a candidate-phase repair, where the reason or a quoted `candidate/<lane> attempt 3` names a higher number than the lane's next attempt. `normalizeEvents` served the note with that number. `projectSnapshot` kept it through `Math.max` after the real `Attempt 2; revision …` row. The node header then showed a phantom attempt, and its result link was a 404.
   - The old case-sensitive `\bAttempt (\d+)\b` had the same fault for a reason that contains `Attempt N`.
   - The anchored phrases are `^Attempt N` (pipeline.py:498), `^Design challenge attempt N` (guardrails.py:333, :373, :376, :664) and `^Feature files re-pinned for design challenge attempt N` (guardrails.py:672). Every other row carries its node's current attempt. The PRD's guard holds unchanged: the served challenge attempts of the captured runs are as before, and so are the snapshots.

## Follow-ups

- **Operator: serving run directories.** Once this is deployed, add a top-level `"viewer": {"expose_run_dir": [...]}` to `~/.config/md-manager/projects.json` (open question 2), listing every project ID whose runs should serve `run_dir`.
  - IDs match exactly, so the PRD's example `["project-b", "md-manager"]` is not enough.
  - The review of this slice found the Project-B runs registered under several IDs. The list for the live registry is therefore `["project-b", "project-b-world", "project-b-ledger", "project-b-claim", "md-manager"]`. S5 did not read the live registry to confirm this, since it is off-limits to the slice.
  - Before pasting the key, list the registered IDs with `python3 -c 'import json,os; print([p["project_id"] for p in json.load(open(os.path.expanduser("~/.config/md-manager/projects.json")))["projects"]])'`.
  - The viewer re-reads the registry on the next request, and `workflow launch` never rewrites the key. Until S6, nothing in the UI reads `run_dir`.
- **Owner of `triage.ts` (S3 now):** S2's client-side `ATTEMPT = /\battempt (\d+)/i` (triage.ts:259, used at :373) over-matches repair notes in the same way (Deviation 8). The timeline then gives a repair note on `verify_<lane>` a quoted attempt (3, or a number from the reason) instead of its lane's own. The server now serves the right `event.attempt` for these rows, so the client can drop its re-parse for them, or anchor its pattern like `OWN_ATTEMPT` in `server/projects.ts`. S5 may not edit `triage.ts`.
- **S6's fixture run with a live `<lane>.questions.json`** (12.3) should get a `SEEDED_ACTIVITY` row in `server/projects.test.ts`. Today, `waiting_questions` from a live file is covered only by the harness test `[B2] waiting questions come from the live <lane>.questions.json`, because no current browser fixture seeds that file.
- **S6** reads `activity` and `run_dir` (see Deviations 1). Worker-phase mocks for the served-activity scenario should build 1.5.0 summaries with a consistent `waiting_questions`/`attention` pair, or the summary schema refuses them.
  - `triage.ts`'s `ServedActivity` type (`attention.kind: string`) is compatible, and needs no change.
- `server/projects.test.ts` now imports `tests/project-workflows/seed.ts`. Every fixture seed a later slice adds is loaded by the server tests too, and must project into a valid 1.5.0 summary.
- `workflow/README.md` step 7 still says the server reads the registry only at startup. That has been out of date since `projectsConfigReloader`, and it is outside this slice.
- **C7.** A controller heartbeat would make `activity.controller` portable, and would remove the reliance on `/proc` and on USER_HZ 100.
