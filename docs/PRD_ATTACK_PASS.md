# PRD: Attack pass (red-team worker), pilot

Status: Proposed 2026-10-04, from the operator's grill of the brief "Red-team worker for the agent workflow" (source idea: `~/dev/agent-workflow/ideas.md`, "Hidden attacker worker for md-manager runs"). Builds on the review sidecar ([PRD_REVIEW_SIDECAR.md](PRD_REVIEW_SIDECAR.md)), the parallel reviewers ([PRD_PARALLEL_REVIEWERS.md](PRD_PARALLEL_REVIEWERS.md)) and the workflow improvements ([HANDOFF_WORKFLOW_IMPROVEMENTS.md](HANDOFF_WORKFLOW_IMPROVEMENTS.md): C14 guards, C44 attention, C47 cleanup, C49 cost). Pilot project: pine-claims. Revised 2026-10-04 for the build run (`features/attack-pass`): the optional `requirements` key (section 3); the attacker narrowed to a requirement check per angle (sections 1 and 4.3: the bundled briefs ask for one failing test per stated requirement that does not hold); the pass's deadlines beside the reviewers' (4.1); and Appendix A, which pins the record, the export section, the event texts and the graph node that both lanes build to.

## 1. Goal

A feature can opt in to an **attack pass**: after the candidate gate, an independent attacker checks the frozen candidate against the project's stated requirements of one chosen angle, and proves each requirement that does not hold with a failing test. The controller re-runs every test on a clean copy of the candidate, and a skeptic argues against every finding. Only findings that survive both count as verified.

The pilot is report-only. Verified findings go to the attack's own record, an attention record and the run's page. They never block, and reviewers never see them. That keeps one clean comparison: what did the attacker find that the review missed?

Why it is needed:
- Reviews read code; they do not try to break it. In the review replays of 3-4 Oct, pine's security review found the forged-provenance P1 of claims-005 in 0 of 3 samples under the first new prompt, 1 of 3 under the old prompt and 2 of 3 under the fixed one. Recall that depends this much on prompt wording is the gap an attacker with a reproduction fills.
- All 8 player-facing escapes in project-B came from conditions no test drove (audit C7).
- A reproduction is the strongest evidence a finding can carry, and it becomes the fix run's regression test.

Success, for the pilot: on 3 pine-claims runs with the attack pass on, every verified finding has a failing exploit test that the controller re-ran on a clean copy; the operator has labelled every verified finding; and the tally shows verified findings, real and false ones, the ones the review also found, cost and added runtime. A run whose attack pass fails, times out or finds nothing integrates exactly as a run without one.

## 2. Confirmed decisions (grill, 2026-10-04)

| Topic | Decision |
|---|---|
| Secrecy | Independent, not hidden. Workers may know an attack pass can run. They never see its angle, its tests or its findings before freeze. |
| Pilot | pine-claims, angle auth/provenance. |
| Attackers | Configurable, one per angle, default one. |
| Isolation (pilot) | A plain print job, no OS sandbox. Offline exploit tests only, in its own worktree, with a scrubbed environment and the C14 deny rules. Launch refuses while listed secret files exist on the host (section 4.2). The real sandbox (the C14 sudo steps) comes before it attacks live services or blocks anything. |
| Reproduction | A failing exploit test in the project's own harness (pine: vitest, PGlite, `fastify.inject`). It asserts the secure behaviour and fails on the candidate. |
| Skeptic | The controller re-runs each test on a clean copy; then a separate skeptic job, given only the finding, the test and the re-run output, argues against it. Verified only if the test fails for the stated reason and the skeptic cannot refute it. |
| Report-only | Own record only: `attack.json`, an attention record, a section of the run's page. Reviewers do not see it. Nothing blocks. |
| Budget | $15 and 60 minutes per attacker; $5 and 20 minutes per skeptic finding batch. |
| Inputs | Candidate code, the PRD, the project's security requirements, the task Goals and `decisions.md`. Not the workers' completion claims, the sidecar ledger or the review findings. |
| Placement | In parallel with the review, inside the review step. The review step ends when both have finished. |
| Angle | Set per feature in feature.json by the grill: `inputs-state`, `permissions-files` or `auth-funds` (section 3). |
| Promotion | After 3 pilot runs, if it found at least one verified real bug the review missed and has no confirmed false positive, the operator may turn on blocking. Blocking also needs the sandbox. |
| Guard | Launch refuses an attack pass while any file on a configured list exists on the host (default `~/.config/vps-wallet.env`). |
| Labels | The operator labels each verified finding: `real`, `false` or `out-of-scope`, and whether the review also found it. Both the skeptic's verdict and the label are kept, so the pilot measures the skeptic too. |

## 3. Configuration

feature.json 2.5.0 adds the optional `attack` (2.4.0 and earlier launch unchanged; `attack` on an earlier version is refused):

```json
{
  "version": "2.5.0",
  "attack": {
    "angles": ["auth-funds"],
    "budget_usd": 15,
    "timeout_minutes": 60,
    "skeptic_budget_usd": 5,
    "skeptic_timeout_minutes": 20,
    "max_findings": 8,
    "requirements": ["docs/security/requirements.md"]
  }
}
```

- `angles`: 1 to 3 distinct values from `inputs-state`, `permissions-files`, `auth-funds`. One attacker runs per angle. The pilot uses one.
- `requirements`: optional, 0 to 10 distinct repository-relative paths of the project's requirements documents, default none. Launch refuses a path that is not committed at HEAD, as it does for the PRD. Prepare pins their copies; the attacker and the skeptic get them beside the PRD (section 2, Inputs).
- Budgets are passed to each job as `--max-budget-usd`; the timeouts stop the job's process group.
- Bounds: `budget_usd` 1..50, `timeout_minutes` 5..180, `skeptic_budget_usd` 1..20, `skeptic_timeout_minutes` 5..60, `max_findings` 1..20.
- `blocking` is not a key yet. It arrives with promotion (section 7).
- policy.json 1.3.0 (`contracts/workflow/verification.schema.json`) adds the optional `attack_check`, the command that runs one exploit test file: `{"argv": ["pnpm", "--filter", "@pine/api", "exec", "vitest", "run", "{file}"], "timeout_seconds": 600}`. `{file}` must appear exactly once. A feature with `attack` and no `attack_check` is refused at launch.
- `prepare` pins the settings, the angle briefs and the secret-file list into `plan.attack`. A plan without `attack` means none.
- The workflow-grill skill asks once, when the feature touches a listed critical path or the target has a security requirements document: "Run an attack pass on this feature? Which angle?" A yes writes the block.
- `attack` and `attack-` join the reserved ids and prefixes.

## 4. Design

### 4.1 Flow

```
candidate gate passes
  └─ review step starts
       ├─ reviewers (unchanged)
       └─ attack pass (only when plan.attack is set)
            1. attack worktree at the candidate commit, policy setup runs
            2. one attacker print job per angle  → findings with test files
            3. controller re-run of each test on a clean copy
            4. one skeptic print job per attacker → verdict per finding
            5. attack.json, attention record, events, cost records
  └─ review step ends when both are done; the review verdict alone decides the run
```

The attack pass is not a LangGraph node, as the sidecar and the design challenge are not. Old plans and their checkpoints keep the same graph. The exported graph shows a node `attack` ("Attack pass") of `kind: review`, as the sidecar does.

It never raises into the run. Every step runs under one guard like the sidecar's: a failure is recorded `failed` with its error in `attack.json` and one event, and the review step continues. A run with a failed attack pass integrates exactly as one without.

**Deadlines.** The pass keeps its own bounds: each attacker's `timeout_minutes`, each re-run's `attack_check` timeout, each skeptic's `skeptic_timeout_minutes`, and one overall bound fixed when the pass starts (those bounds, the policy setup timeouts and 10 minutes; the formula is recorded in the engine handoff), past which the controller stops the pass and records it `failed`. The reviewer deadline never stops the pass, and the pass never extends the reviewer deadline. The review step ends when the review has decided (every reviewer done, or its deadline) and the pass has ended or passed its overall bound.

### 4.2 Launch guard

`launch`, dry runs included, and pipeline preflight refuse a feature with `attack` while any path on the secret-file list exists: "Blocked: an attack pass needs <path> off this host: move it, then launch again". The list defaults to `~/.config/vps-wallet.env` and is extended by `WORKFLOW_ATTACK_SECRET_FILES` (colon-separated), read once at prepare and pinned. The review step checks again before the attacker starts, and records the pass `refused` instead of running when a listed file reappeared.

### 4.3 The attacker job

- **Worktree.** A detached worktree of the candidate commit under the worktree lock, outside the run directory (`<runs root>/<run id>.attack/worktree`, decisions [L2]; `clean` removes it). The policy's `setup` runs there first, as for verification. The attacker gets this worktree only. With several angles, the attackers run one after another in it, reset between angles.
- **Job.** One `claude --print` job per angle, started like a print reviewer (`print_command`, `popen_claude`, `role_flags(plan, "judges")`), with tools `Read,Glob,Grep,Edit,Write,Bash`, the C14 worker settings (deny rules on credential files, no `git push` or `git commit`, no `pkill`/`killall`), and an environment with the verifier's secret names dropped (`*_KEY`, `*_TOKEN`, `*_SECRET`, `*_PASSWORD`, `GH_*`, `GITHUB_*`). Its working directory is the attack worktree; `--add-dir` gives it only that directory.
- **Prompt.** The angle brief (`workflow/prompts/attack/<angle>.md`), then the project conventions (C15), then the inputs (section 2), then the protocol: work offline (no outbound network, no live servers; the harness's in-process app only); write each test as one self-contained file in a directory named `attack-tests` where the `attack_check` collects it (decisions [L5]); a test asserts a stated requirement and must fail on this candidate; run it with the `attack_check` command before reporting it; at most `max_findings` findings; "no finding" is a valid result. The bundled angle briefs are requirement checks (revised 2026-10-04 for the build run): each lists the stated requirements of its angle that the changed code is subject to, writes one test per requirement and reports the ones whose test fails. A wider brief is the operator's to write after the pilot's calibration.
- **Output.** Structured output (`contracts/workflow/attack.schema.json`, `$defs.output`): per finding `id`, `severity` (P0/P1/P2, by the C41 severity rule), `title`, `threat` (who does what, and what they gain), `requirement` (a quoted SEC-*, PRD or task line, or null), `test_file`, `expected` and `observed`. The controller copies each test file to `<run>/attack/<attacker>/<id>.test.*` the moment the job ends.
- **Budget.** The job is stopped at `timeout_minutes`. Its cost comes from its `stdout.json` (C49) under a new role `attack`. Findings returned before a timeout are kept only if the job wrote its output; a stopped job counts as `failed`.

### 4.4 The re-run

For each finding, the controller re-runs the test on a clean copy (decisions [L2], [L5]): one re-run worktree of the candidate commit outside the run directory (`<runs root>/<run id>.attack/rerun`), set up once with the policy's `setup` before the attacker starts and reset between findings (`git checkout -- . && git clean -fdx -e node_modules`, then `git status --porcelain` empty). It copies in only that finding's test file, at its relative path, and runs `attack_check` with `{file}` replaced by the file's absolute path. The result is recorded: exit code, duration, the last 200 lines of output.

A finding whose test passes, or does not run (no test collected, setup error, timeout), is `not_reproduced` and goes no further.

### 4.5 The skeptic

One `claude --print` job per attacker, read-only (`Read,Glob,Grep`), over the reproduced findings only. It gets each finding, its test file, the re-run output, the spec documents and the candidate tree. It does not get the attacker's transcript or reasoning. Its brief: refute each finding. Is the test asserting a requirement the spec does not make? Is the threat outside the feature's scope? Does the failure come from the harness rather than the code? Would the behaviour be acceptable to the stated requirements? It returns per finding `verdict` (`verified` or `refuted`), a reason, and a severity it may lower but never raise.

### 4.6 Records

- **`<run>/attack.json`** (schema 1.0.0): the settings, each attacker's status (`succeeded`, `failed`, `refused`, `timed_out`), and each finding with its test, re-run result, skeptic verdict and the operator's label. The controller is its only writer, under the run lock.
- **Attention.** A new kind `attack`: one record when the pass ends with at least one verified finding, naming the counts and the label command.
- **Events.** `Attack pass started (<angle>)`, `Attack pass: <n> finding(s), <r> reproduced, <v> verified`, and failures. Their texts are added to the viewer's controller-row patterns where needed.
- **Cost.** `<attacker>.cost.json` and the skeptic's, role `attack`; the outcome block's cost line gains `attack $x`.
- **Export 1.8.0.** A top-level `attack` section, null for runs without one. The projects contract gains `attackResult`; the viewer shows an "Attack pass" section on the run page: the verified findings with severity, threat, test file and label, then the refuted and not-reproduced ones folded.
- **Status and outcome.** `status` prints `attack: <v> verified, <u> unlabelled`. The outcome block adds one line after the review lines: `Attack pass (report-only): ...`. It never changes the run's verdict.

### 4.7 Labels

`python -m workflow attack-label <run> <finding> --label real|false|out-of-scope [--review-found yes|no] [--note "<text>"] --by operator`. It appends to the finding's label history in `attack.json`, re-exports the run, and refuses the maintainer. `review-found` is filled in by the operator, who compares the finding with `review.json`; the command prints the review's findings in the same files to help.

### 4.8 Independence

- Worker prompts gain one line when `plan.attack` is set: "After freeze, an independent attack pass tests this candidate. Make the code robust, not just passing." Nothing names the angle.
- The design challenge and the reviewers get nothing about the attack.
- The attacker gets nothing about the workers' claims, the sidecar or the review.
- Attack tests stay in `<run>/attack/` and are never merged into the candidate. After promotion, verified tests enter the fix run through `brief`.

### 4.9 Old runs

A plan without `attack`, an export without the section and a feature before 2.5.0 behave exactly as today.

## 5. Pilot plan (pine-claims)

0. **Calibration on a known bug** (needs the operator's OK for about $20). Run the attack pass offline on the claims-005 candidate with angle `auth-funds`, through a `workflow.replay`-style harness that stages the run copy without verdicts. Pass: it finds the forged-provenance defect as P0/P1 with a failing test, and the skeptic verifies it.
1. Move `~/.config/vps-wallet.env` off the host (the guard refuses until then).
2. Add `attack` to `pine-claims/features/claims/feature.json` (2.5.0) and `attack_check` to its policy.
3. Run 3 claims features with the pass on. Label every verified finding.
4. `python -m workflow attack-tally` prints, across registered runs: runs, findings, reproduced, verified, labelled real / false / out-of-scope, real ones the review also found, cost per run, and added runtime (review step with the pass minus the reviewers' own time).
5. Promotion review with the operator (section 7).

## 6. Work items

Engine:
1. `contracts/workflow/feature.schema.json` 2.5.0 with `attack`; `verification.schema.json` (policy) 1.3.0 with `attack_check`; `contracts/workflow/attack.schema.json` 1.0.0; the README.
2. `workflow/prompts/attack/{inputs-state,permissions-files,auth-funds}.md` and `skeptic.md`.
3. `workflow/launch.py` and `pipeline.py` preflight: validation, the secret-file guard, `prepare` pins `plan.attack`; reserved ids in `sessions.py`.
4. `workflow/attack.py`: worktrees, the attacker job, the re-run, the skeptic job, `attack.json`, the guard wrapper, `attack-label`, `attack-tally`.
5. `workflow/automatic.py` review step: start the pass in parallel, wait for both; `costs.py` role `attack`; `attention.py` kind `attack`; `outcome.py` line; worker prompt line in `pipeline.py`.
6. `workflow/export_state.py` 1.8.0; `workflow/clean.py` removes the attack worktrees; RUNBOOK "Attack pass" section, README.
7. `workflow/test_attack.py`: fake print jobs for attacker and skeptic; a toy repository whose `attack_check` is a shell test.

Viewer:
8. `contracts/projects/v1.ts` `attackResult` and 1.8.0, examples, contract tests; `server/projects.ts` section and route; triage controller-row patterns.
9. The run page's "Attack pass" section, a pure `attack.ts` helper with unit tests, one Playwright scenario in both phases.

## 7. Promotion to blocking (outline only)

Eligible after 3 pilot runs with at least one verified finding labelled `real` that the review did not find, and no verified finding labelled `false`. Then, with the operator's yes and the sandbox in place (C14 sudo steps, a canary that proves localhost-only network and unreadable secret paths):
- feature.json `attack.blocking: true`;
- a verified, unlabelled-false P0/P1 blocks at approval like a review block, with `brief` carrying the finding and its test into the `--follows` fix run;
- P2s go to the ledger;
- a separate PRD covers live-stack attacks (curl, Playwright against served apps) inside the sandbox.

## 8. Acceptance scenarios (engine, no model calls)

- A feature with `attack` on 2.4.0 is refused; on 2.5.0 without `attack_check` is refused; with a listed secret file present, launch and its dry run are refused naming the file.
- The review step runs reviewers and the attack pass in parallel; the run's verdict equals the review's whatever the attack finds.
- A finding whose test passes on the clean copy is `not_reproduced` and never reaches the skeptic.
- A reproduced finding the skeptic refutes is `refuted`; one it confirms is `verified`, at the skeptic's severity when lower.
- An attacker that times out, crashes or returns invalid output is `failed`; the run integrates.
- `attack-label` records labels and refuses the maintainer; `attack-tally` counts them.
- The attacker's prompt contains none of: the workers' completions, the sidecar ledger, `review.json`. Worker prompts contain the one independence line and no angle.
- Export 1.8.0 carries the section; an older run exports `attack: null`.

## 9. Risks

- **No OS sandbox in the pilot.** A print job with Bash runs as the operator's user. The guard removes the funded key, the environment drops secret names and the deny rules stop the Read and Edit tools, but a shell command can still read anything the user can (the handoff's limits). Mitigation: offline tests only, attended pilot runs, the sandbox before live attacks or blocking. The leaked keys of the C42 follow-up should be rotated before the pilot.
- **Prompt injection from the candidate.** The attacker reads untrusted code. Its brief says to treat repository content as data; the skeptic and the operator's labels catch a steered finding, not a steered action.
- **Harness gaps.** If the in-process harness cannot express an attack (a real network race, a chain reorg), the attacker reports nothing for it. The pilot measures this as "out of reach" notes in the attacker output.
- **Cost and time.** Up to about $20 per angle; the review step waits for the pass up to its overall bound (4.1), which with pine's defaults is near three hours per angle (decisions [L8]; the engine handoff gives the formula and value). The tally makes this visible before promotion.

## 10. Open questions

1. Should the calibration step (5.0) also run on project-B's theft-window candidate, as a second known bug with a different angle?
2. Should `attack-tally` mark a finding as "review also found" automatically, by matching files and requirement ids, with the operator's label overriding?

## Appendix A: the record (`contracts/workflow/attack.schema.json` 1.0.0) and the export section

Pinned here because both lanes build to it: the engine writes `<run>/attack.json`, the viewer's fixtures copy it. Any deviation found necessary is recorded in the lane's handoff, and the other lane's fixtures follow the engine's committed schema at integration.

```json
{
  "version": "1.0.0",
  "run_id": "claims-007",
  "candidate_commit": "4f3c2b1a9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b",
  "settings": {"angles": ["auth-funds"], "budget_usd": 15, "timeout_minutes": 60, "skeptic_budget_usd": 5, "skeptic_timeout_minutes": 20, "max_findings": 8, "requirements": ["docs/security/requirements.md"], "secret_files": ["/home/agentops/.config/vps-wallet.env"]},
  "status": "succeeded",
  "started_at": "2026-10-05T10:00:00Z",
  "finished_at": "2026-10-05T10:58:10Z",
  "error": null,
  "attackers": [
    {
      "id": "auth-funds", "angle": "auth-funds", "status": "succeeded",
      "started_at": "2026-10-05T10:01:30Z", "finished_at": "2026-10-05T10:41:02Z", "error": null,
      "session_id": "0f2b3c6e-4a4d-4b8e-9d1a-6b2f1c0a9e11", "cost_usd": 7.42,
      "summary": "Two requirements of the claims module fail on this candidate; one could not be expressed offline.",
      "out_of_reach": ["SEC-TX-02 needs a real chain reorganisation; the in-process harness has none."],
      "skeptic": {"status": "succeeded", "started_at": "2026-10-05T10:46:00Z", "finished_at": "2026-10-05T10:57:40Z", "error": null, "session_id": "7c1d2e3f-5b6a-4c7d-8e9f-0a1b2c3d4e5f", "cost_usd": 1.10}
    }
  ],
  "findings": [
    {
      "id": "A-1", "ref": "f1", "attacker": "auth-funds", "severity": "P1",
      "title": "A claim's provenance can name another account",
      "threat": "A signed-in user files a claim whose provenance names another account; reviewers then trust the claim as that account's.",
      "requirement": "SEC-CLAIM-03: the server derives a claim's author from the session, never from the request body.",
      "test_file": "attack/auth-funds/A-1.test.ts",
      "expected": "403 and no claim row", "observed": "201 and a claim row authored by the other account",
      "rerun": {"status": "reproduced", "reason": null, "exit_code": 1, "duration_seconds": 14.2, "output_tail": "FAIL attack-tests/A-1.test.ts > rejects a body author\nAssertionError: expected 201 to be 403", "at": "2026-10-05T10:44:10Z"},
      "skeptic": {"verdict": "verified", "reason": "SEC-CLAIM-03 states it; the assertion that fails is the status check of the request under test.", "severity": "P1"},
      "status": "verified",
      "labels": [{"label": "real", "review_found": "no", "note": null, "by": "operator", "at": "2026-10-05T12:00:00Z"}]
    },
    {
      "id": "A-2", "ref": "f2", "attacker": "auth-funds", "severity": "P2",
      "title": "A withdrawn claim keeps its evidence link",
      "threat": "A withdrawn claim's evidence stays readable to its former reviewers.",
      "requirement": null,
      "test_file": "attack/auth-funds/A-2.test.ts",
      "expected": "404 after withdrawal", "observed": "200",
      "rerun": {"status": "not_reproduced", "reason": "passed", "exit_code": 0, "duration_seconds": 9.8, "output_tail": "1 passed", "at": "2026-10-05T10:45:01Z"},
      "skeptic": null,
      "status": "not_reproduced",
      "labels": []
    }
  ]
}
```

Enums: pass `status` `running|succeeded|failed|refused` (the export adds `pending`, below); attacker `status` `running|succeeded|failed|refused|timed_out`; skeptic `status` `not_run|running|succeeded|failed|timed_out` (`not_run` when its attacker did not succeed or no finding reproduced); finding `severity` and skeptic `severity` `P0|P1|P2`; `rerun.status` `reproduced|not_reproduced`; `rerun.reason` `null|passed|no_test|setup_failed|timed_out|error` (null exactly when reproduced); skeptic `verdict` `verified|refuted`; finding `status` `not_reproduced|unjudged|verified|refuted` (`unjudged`: reproduced, but the skeptic failed, timed out or returned no verdict for it); label `label` `real|false|out-of-scope`; `review_found` `yes|no|null`; `by` `operator`.

`settings` is exactly these eight keys, in attack.json and in every export record (`pending` and `failed` included): `angles`, `budget_usd`, `timeout_minutes`, `skeptic_budget_usd`, `skeptic_timeout_minutes`, `max_findings`, `requirements` (repository-relative path strings) and `secret_files` (absolute path strings). It is built from `plan.attack`, never a copy of it, and both schemas close it (decisions [L1]). Field rules both validators share: ids, the commit and `session_id` are non-empty strings with no format check; the only nullable fields are `candidate_commit`, every `started_at`, `finished_at` and `error`, `session_id`, `cost_usd`, an attacker's `summary`, a finding's `requirement`, `rerun` and `skeptic`, `rerun.reason`, `rerun.exit_code`, a label's `note` and `review_found` (an attacker's `skeptic` object is never null); a skeptic's `severity` is never above its finding's `severity`; a finding's `test_file` is relative to the run directory; `output_tail` holds at most the last 200 lines; arrays may be empty; no referential check (a finding's `attacker` is not resolved by the schema). The latest entry of `labels` is the current label. A verified finding shows the skeptic's severity.

`$defs.output` is what an attacker job returns: `{summary, findings: [{id, severity, title, threat, requirement, test_file, expected, observed}], out_of_reach: [string]}`, where `id` is the attacker's own (it becomes `ref`) and `test_file` is a path under `attack-tests/` in the attack worktree; at most `max_findings` findings. `$defs.skeptic_output` is what the skeptic returns: `{verdicts: [{id, verdict, reason, severity}]}`, keyed by the global id.

**Export 1.8.0** adds the top-level `attack`:
- `null` when the plan has no `attack` (every older run, every run without the key);
- the `attack.json` object as read, when it exists and validates;
- while the plan has `attack` and no `attack.json` exists, a `pending` record: `{"version": "1.0.0", "run_id": <run>, "candidate_commit": null, "settings": <the eight settings, built from plan.attack>, "status": "pending", "started_at": null, "finished_at": null, "error": null, "attackers": [], "findings": []}`;
- when `attack.json` exists and does not validate, the same record with `"status": "failed"` and `"error": "attack.json is not valid: <reason>"`.

**Attention record** kind `attack`: written once, when a pass ends with at least one verified finding: `Attack pass (report-only): <v> verified finding(s) to label: python -m workflow attack-label <run> <id> --label real|false|out-of-scope --by operator`.

**Events** on the node `attack`, written by the controller with counts, ids and angles only: `running` `Attack pass started (<angles, comma-separated>)`; `interactive` `Attack pass attacker <angle> <failed|timed_out>: see attack/<angle>.stderr.log`, `Attack pass skeptic for <angle> <failed|timed_out>: see attack/<angle>.skeptic.stderr.log`, `Attack pass refused: <path> exists on this host` and `Attack pass failed: <error class>`; then exactly one closing `succeeded` event for every pass: `Attack pass: <n> finding(s), <r> reproduced, <v> verified` for a pass that reached its end, `Attack pass ended: refused` or `Attack pass ended: failed` otherwise. The node never gets `failed` or `blocked` and is never left `running` once the review step ends, so the run's state is the review's (the viewer maps `blocked` to failed, and a node left running reads as a paused run).

**Graph.** For a plan with `attack`, the exported definition (and the registry entry a launch writes) has the node `attack` ("Attack pass", kind `review`) right after `review`, with the same `depends_on` as `review`; `approval` then depends on both. Every other graph is unchanged.
