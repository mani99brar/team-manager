# PRD: User critique (a reviewer that uses the candidate's frontend as a user)

Status: Proposed 2026-10-09, from the operator's request of 2026-10-09 ("build the new worker or reviewer class ... it would test the product as a user"; "something like a critique ... which would test the frontend as a user and find gaps") and their four shape answers and the grill of the same day (section 2). Ships as feature `user-critique`, two lanes: `engine` and `viewer`. Decisions: `features/user-critique/decisions.md`.

## 1. Problem

Every check a run has today reads code or runs tests the workers wrote. The reviewers (`builtin:general`, `builtin:coverage`) get `Read,Glob,Grep` and no command execution (`workflow/prompts/reviewers/general.md`: "No edits or command execution"). The attack pass (feature.json 2.5.0) runs tests but is offline and report-only, and the panel (2.6.0) reads a text context. Nothing uses the running product.

The only use of the product is the operator's manual tryout (`workflow/tryout.py`, feature.json 2.4.0 `tryout`), after integration, when nothing in the run can act on what it finds. The cost of that gap is on record: project-B's docking feature passed every check and two reviews and failed the operator's first playtest, because the tests drove idealised input (shared memory `player-realistic-input-tests`). On md-manager, UI lanes now load the `impeccable` design skill (2.8.0), but nothing checks the result the way its own `critique` command does: on the rendered page.

## 2. Confirmed shape (operator, 2026-10-09)

| Question | Answer |
|---|---|
| What its findings do | **Feed the in-run fix loop** (`--fix-rounds`, commit dc040f2): its open P0/P1 findings on one lane send that lane a repair session, like a reviewer's. Not report-only, and not a separate gate. |
| When it runs | **The review stage**, on the frozen candidate, beside the reviewers, in its own worktree with the app on its own ports. |
| What it judges | **Flows and design**: (1) use the app as a user to walk each lane's `## Goal` and `verify_yourself` line, looking for broken flows, dead ends, wrong or missing states, console errors; (2) the vendored Impeccable `critique` method (heuristics, cognitive load, the craft floor's refuse list, design issues) on the screens the run changed. |
| Which runs | **Opt-in**: a `critique` key in `feature.json` at a new version **2.9.0**; every other feature launches byte for byte as today. |
| Attack runs (grill Q1) | A feature with `attack` and `critique` **also gets repair rounds** for its critique findings. |
| Evidence (grill Q1) | The viewer shows each critique finding's **screenshots and proof** (steps to reproduce). |
| Bash (grill Q2) | The critique session gets `Bash` in its disposable worktree (4.4). |
| Lanes (grill Q3) | `engine` owns `workflow`, `contracts/workflow`, `contracts/projects`, `server`; `viewer` owns the run page's findings files; both build against Appendix A. |
| P1 (grill Q4) | P1 only for a promised flow that does not work or a UI that misleads the user, with steps and a screenshot; design, heuristics and the craft floor are P2/P3. |
| App start (grill Q5) | Policy 1.4.0 `critique_app` (4.2). |

## 3. Outcome

A 2.9.0 feature that declares `critique` gets one more reviewer at its review step, the **critique reviewer** (reviewer id `critique`), run as a controller-owned headless job (4.4). The controller gives it a disposable worktree of the frozen candidate with the policy `setup` run, starts the app there on free ports, and runs a headless Claude job that may run commands in that worktree and loads the `impeccable` skill. The session drives the app with Playwright from Bash (no MCP browser: reviewer sessions run with an empty MCP config), reads its own screenshots, and returns structured output that the controller turns into an ordinary reviewer decision: verdict, findings with `severity`, `message`, `disposition` and `worker` (the lane whose owned paths render the broken screen). The controller then stops the app and combines the critique's completion with the other reviewers' exactly as today, so:

- an open P0/P1 from the critique blocks the review like any reviewer's, and the fix loop sends it to its lane when all open blockers name one lane;
- the next round's critique gets the previous round's findings and the delta, as the other reviewers do;
- screenshots it cites are kept under `$RUN/critique/<round>/` and listed in its output, so the operator and the viewer can see what it saw: each critique finding shows its steps to reproduce and its screenshots on the run page (Appendix A).

## 4. Design

### 4.1 Why a reviewer and not a pass beside the review

The fix loop reads only `review.json` (`automatic.open_blockers`, `pipeline.check_review`); the attack pass and the panel are collected after the verdict (`automatic.review_candidate`'s `finally` chain). A finding source outside the reviewers would need a second decision path. As a reviewer, the critique reuses the verdict, the closed `review.json` shape, the per-round archive (`archive_review`), the delta base and the repair brief unchanged. What differs is how it is launched and supervised (a headless job, 4.4) and how its decision joins `review.json` (4.5).

### 4.2 Configuration (feature.json 2.9.0, policy 1.4.0)

```json
{
  "version": "2.9.0",
  "critique": {"lanes": ["pages", "shell"], "skills": ["impeccable"], "timeout_minutes": 45}
}
```

- `lanes`: the lanes whose UI the critique walks (1 or more of the feature's lanes); their Goal and `verify_yourself` lines are its brief, and only they may be named in its findings' `worker`.
- `skills`: as a lane's (2.8.0 rules, pinned at prepare under `plan.critique.skills`), default `["impeccable"]`.
- `max_budget_usd`: 1..100, default 15: the job's `--max-budget-usd` (4.4).
- `timeout_minutes`: 10..120, default 45: the job's own deadline from its launch (4.4); past it the job is stopped and recorded as a failed critique.
- Refused before 2.9.0; reviewer id `critique`, the prefix `critique-` and (in a feature that declares `critique`) the lane id `critique` are reserved.
- The policy gains `critique_app` (policy 1.4.0, required when the feature declares `critique`): `{"argv": [...], "ready_path": "/", "timeout_seconds": 120}`. The controller runs `argv` in the critique worktree with `CRITIQUE_WEB_PORT` and `CRITIQUE_API_PORT` set to free ports it picks, waits until `http://127.0.0.1:$CRITIQUE_WEB_PORT<ready_path>` answers, gives the session the URL, and stops the process group when the session ends. For md-manager this is a script that seeds a temporary root and starts `start:api` and `dev:web`, as `tests/project-workflows/playwright.config.ts` does.

### 4.3 The worktree and the app

- `<runs root>/<run>.critique/worktree`, pinned at prepare like the attack worktrees; `git worktree add --detach` at the candidate, policy `setup` once (marker file), reset between rounds; removed by `clean`.
- The app and the job's browser hold one browser-queue slot (`browser_queue.browser_slot("<run> critique")`) for the whole span, so a critique and verifier suites take turns when the queue is on.
- The app runs with the verifier's check environment (`checks.check_environment`: secrets scrubbed, private `TMPDIR` and caches).

### 4.4 The critique job (revised after design challenge attempt 1, decisions.md [L1])

The critique is a **controller-owned headless job**, not a native `claude --bg` reviewer session (the challenge's simpler alternative, chosen by the panel). It is one `claude --print --output-format json --json-schema <critique output schema>` process, launched and supervised like an attack-pass attacker (`workflow/attack.py`), in the critique worktree:

- **Argv, pinned at prepare with its digest:** `--setting-sources "" --plugin-dir <run>/skills/critique` (2.8.0 mechanism, `skills.py` helpers keyed `critique`); `--strict-mcp-config --mcp-config '{"mcpServers":{}}'` (O3's empty MCP config); `--tools Read,Glob,Grep,Bash,Skill,Write`; `--settings` = `worker_settings(directory, skills_lane="critique")` (the worker deny list: secret Read/Edit denies, `Bash(pkill:*)`, `Bash(git push:*)`, `Bash(git commit:*)`; Edit/Write denies on `<run>/skills/critique`; the pinned advisor) **plus Edit/Write denies on all of `//$RUN/**`, with no exception** (Claude Code rules have no exception syntax, and the settings must be the same every round so one digest is pinned at prepare; the job writes its screenshots with Bash, its scratch scripts in the critique worktree); the permission mode the attacker uses for Bash and Write under `--print` (`attack.attacker_command`; `dontAsk` cannot grant them); `--model`/`--effort` from the reviewer role's pins (`sessions.role_flags`, G4). The full argv is asserted in a test.
- **Environment:** the attacker's (`ATTACK_ENV_RESTORE` over the scrubbed check environment), so Claude's credentials survive the scrub the app gets (G5).
- **Prompt (stdin):** `builtin:critique` (`workflow/prompts/reviewers/critique.md`), the app URL, each of `critique.lanes`' Goal and `verify_yourself` line, and on round 2 or later the previous round's findings and `review.delta.diff` exactly as `review_prompt` gives the native reviewers.
- **Rubric (amends O5, [L1]):** the output schema allows severity **P1 or P2 only**. P1 only for a flow a lane's Goal or `verify_yourself` line promises that does not work, or a UI that misleads the user about what happened; everything else, including whatever Impeccable would grade P0 to P3, is P2. The brief states the mapping. Each P1's `message` states its numbered steps inline (so the repair brief, which passes findings verbatim, carries them), and has at least one screenshot. The critique never writes P0 (G7) and the schema makes a P3 impossible.
- **Output:** `{verdict, findings: [{severity, worker (one of critique.lanes), message, evidence: {steps[1..20], screenshots[0..6]: [{path, caption}]}}]}`. Each `path` must resolve (symlinks resolved) inside `$RUN/critique/<round>/` and be a PNG; the controller refuses any other path (the finding keeps its text, the screenshot is dropped and the refusal recorded), so no host file is ever read or exported through it.
- **Budget:** `--max-budget-usd` from `critique.max_budget_usd` (default 15, as an attacker's), so a round's spend is capped, not only its time.
- **Timing:** the controller launches the native reviewers first, then runs setup if needed (outside the slot), takes the browser slot, starts `critique_app` and starts the job. The job's deadline is its own `timeout_minutes` from its launch; `wait_reviews` keeps `review_timeout_seconds` and its grace for the native reviewers only. A native block does not stop the job: the review decides once the native reviewers are settled (as today) **and** the critique has a decision or failed, so one round's repair brief carries both. The job's runtime bounds the step.
- **Stop and resume:** Ctrl-C, exit 75, a timeout or any exit kills the job's and the app's process groups and releases the slot. A finished critique's translated decision and evidence are persisted (`$RUN/critique/<round>/status.json` with `accepted_decision`, written before the slot is released); a resume reuses a persisted decision and reruns the job (worktree reset, fresh) only when there is none. The native reviewers are rebound as today.
- **Failure:** an app that never answers, a timeout, a spent budget or an invalid output is a failed critique, recorded like a failed native reviewer: its `review.json` entry has verdict `null` (which `combined_review` counts as blocking), and its status and reason go to `automatic-review-critique.json`, the file the export reads for a reviewer's status, with its launch time. `review.json` is written, so a native reviewer's block on one lane still repairs that lane, and on an attack plan the attack pass is waited for and kept. A failure is not persisted as a decision: a resume before the review decided reruns a failed critique once. There is no "proceed without critique".
- **Transport:** `critique` is refused with `--reviewer-transport print` at prepare (one integration path; RUNBOOK known limits).
- **Bash bounds:** the disposable worktree, reset every round; the deny lists above; nothing it changes reaches the candidate. Bash can still write anywhere the operator's account can outside the denies, so the write limit is advisory for Bash and the RUNBOOK says so.
- The operator cannot attach to the critique's pane (there is none); its evidence is in the viewer.

### 4.5 Records, review.json, viewer, attention

- **Not a native reviewer.** `critique` is not added to the plan's native reviewer list, so `wait_reviews`, `rebind_reviewers`, `check_listed_identity`, receipts and the stop/supersede paths iterate the native reviewers only, unchanged. A plan with `critique` pins `plan.critique`; `review.json`'s `reviewers` list is the declared native reviewers plus `critique`, and `check_reviewers`/`check_review` accept the id `critique` exactly when the plan pins `critique` (every other plan is checked as today).
- **Translation.** The controller turns the job's output into a reviewer decision for `combined_review`: each finding `{severity, message, disposition: "open", worker, requirement: null, reviewer: "critique"}`, verdict derived as for native reviewers (`derived_verdict`); `evidence` is stripped and written to `$RUN/critique/<round>/evidence.json` keyed by the digest of `(severity, worker, message)` plus the finding's occurrence index among critique findings with that digest (so duplicates keep their own evidence); the export resolves an archived round's findings by that key, never by position in the round's filtered list. `reviewCompletion.schema.json` and `review.json`'s closed key sets do not change. The decision does not go through `read_review_completion` (no session binding); a test covers the path.
- No new attention kind (`review_blocked` covers it). `$RUN/critique/` is archived with the round.
- **Artifacts.** The export (1.11.0) carries a separate critique artifact list `{id: "critique-<round>-<sha12>", kind: "screenshot", path (run-relative, after archiving), sha256, bytes}`, registered in the server's `artifact()` lookup; ids cannot collide with `screenshot-<scenario>` ids. Appendix A's `screenshots[].artifact_id` refers to these ids. A `server-projects` test fetches a live and an archived round's screenshot.
- The critique's `reviewers[]` entry keeps the run's `transport` value (the enum is unchanged); the viewer words the critique entry by its id ("headless critique job" with its launch time and status from `automatic-review-critique.json`), never as a native session.
- The viewer shows each critique finding's steps and screenshots (Appendix A), reusing `Screenshots.tsx`'s thumbnail and dialog, in the live review and in one "Earlier rounds" list in the review section that shows each archived round's findings (every reviewer's) with the critique's evidence (decisions.md [L2]).

### 4.6 Attack runs (grill Q1)

The loop skips attack runs today (`automatic.py`, `if lane is None or has_attack(...)`) because `attack.json` is never archived and would never rerun. For a plan with both `attack` and `critique`, the loop runs: the attack pass runs once, on round 1's candidate, and stays report-only; later rounds keep that record, marked with the candidate it judged, and do not rerun it (a pass can take near three hours per angle). A plan with `attack` and no `critique` keeps today's behaviour.

Known limits, stated in the RUNBOOK and the engine handoff: on an attack+critique plan, round 1's review waits for the attack pass (up to its overall bound, hours) before a critique repair starts; a round-1 review that ends without `review.json` records the attack pass `failed` (a failed critique writes `review.json`, so it does not); the critique's browser-slot hold counts against the attack pass's wall-clock overall bound when the attack's reruns queue behind it; the slot wait comes before the critique's own deadline.

### 4.7 Setup and names

- Setup reruns in the critique worktree when the digest of `package.json` and `package-lock.json` (the policy setup's inputs) differs from the one its marker recorded, so a repair that adds a dependency does not fail the app.
- A feature that declares `critique` may not have a lane named `critique` (refused at launch and prepare).

## 4.8 Sequencing (decisions.md [L2])

The lanes run in two runs, as `viewer-refine` did: `engine` alone first (it owns `contracts/projects`, whose strict schema must accept `evidence` before any viewer fixture can carry it, and lanes only meet at the candidate), integrated into the source branch; then `viewer` alone, on a base that already holds the engine's contract, examples and export.

## 5. Work items (engine unless noted)

1. 2.9.0 everywhere a version set lists 2.8.0 (guardrails, launch, attack/panel/sidecar version sets, the feature schema, contract test, an example), the `critique` key and its refusals; policy 1.4.0 `critique_app`.
2. Prepare: pin `plan.critique` (lanes, skills with digests, advisor model, worktree paths, the job's argv and settings digests); `critique` is not added to the native reviewer list (4.5).
3. Review step: launch the native reviewers; then create or reset the critique worktree, run setup when its inputs changed, take the browser slot, start the app and wait for ready, and run the critique job with its own deadline (4.4); persist its decision; stop the app and release the slot on every exit path; the review decides once the native reviewers are settled and the critique has a decision or failed; resume reuses a persisted critique decision and reruns the job only without one.
4. `builtin:critique` brief and the screenshot convention; repair brief unchanged (findings verbatim).
5. `archive_review` and `clean` cover `$RUN/critique/` and the worktree; evidence registered as artifacts.
6. The fix loop on a plan with `attack` and `critique` (4.6).
7. Export 1.11.0 and `contracts/projects` (Appendix A); the server serves the evidence through the existing artifact route.
8. Viewer lane (second run, 4.8): each critique finding shows its steps and screenshots on the run page, in the live review and in the "Earlier rounds" list of archived rounds; the critique reviewer entry worded as a headless job.
9. RUNBOOK section and README rows.

## 6. Acceptance (engine, no model calls; fake `claude` and a fake app as the existing tests use)

- A 2.8.0 feature with `critique` is refused; a 2.9.0 feature without it launches byte for byte as a 2.8.0 one.
- A critique run starts the app on free ports, launches the critique session with the pinned flags and stops the app afterwards, also after a timeout and a Ctrl-C.
- A critique output with an open P1 naming lane `pages` blocks the review and starts a repair of `pages`; the next round reruns the critique job against the repaired candidate, its prompt carrying the previous findings and the delta.
- A native reviewer that blocks at minute 5 does not stop the critique job; the round's repair brief carries both reviewers' findings.
- Ctrl-C after the critique finished and before a native reviewer did: resume reuses the persisted critique decision (no rerun); Ctrl-C mid-walk: resume reruns the job once, with a new app process group, and the native reviewers' rebinds are unchanged.
- A 45-minute critique with the default review timeout is still pending at 31 minutes and the native deadlines are unchanged.
- An output with severity P3 or P0, or a screenshot path outside `$RUN/critique/<round>/` (a symlink out included), is refused as specified in 4.4.
- The job argv asserted in full: the empty MCP config, the worker deny list plus the `$RUN/**` denies, the permission mode, model and effort pins.
- Setup reruns after a repair changes `package-lock.json`; a lane named `critique` is refused.
- The app's process group is gone and the browser slot free after every exit path.
- A plan with `attack` and `critique` repairs a lane on a critique P1; the attack record of round 1 stays and is not rerun.
- The export carries each critique finding's `evidence` and the screenshots resolve through the artifact route; the viewer shows them (browser scenario with a screenshot).

## 7. Risks

- **False P1s cost a repair round.** A UX opinion graded P1 sends a worker off; the rubric in 4.4 limits P1 to a broken promised flow, and the fix-round limit bounds the cost. Watch the first runs' critique P1s by hand.
- **Flaky environment read as a defect.** An app that fails to start is a controller failure (the critique is recorded failed), never a finding.
- **Runtime.** A 45-minute default per round adds to every round of a critique feature; the reviewers run in parallel with it, so the step takes the longest of them.

## 8. Settled by the grill

The open questions of the draft were settled on 2026-10-09: see section 2 and `features/user-critique/decisions.md`.

## Appendix A: the export of critique evidence (export 1.11.0)

Each finding in the review section, and in each archived round's findings, whose `reviewer` is `critique` gains:

```json
"evidence": {
  "steps": ["Open /projects/alpha", "Click 'Run' on the first row", "..."],
  "screenshots": [{"artifact_id": "critique-1-0a1b2c3d4e5f", "caption": "After clicking Run: spinner never ends"}]
}
```

- `steps`: 1 to 20 strings, each at most 300 characters. `screenshots`: 0 to 6 entries; `artifact_id` resolves through `/api/projects/<project>/workflows/<workflow>/runs/<run>/artifacts/<id>` as check screenshots do; `caption` at most 200 characters.
- A P1 critique finding always has at least one screenshot (the brief requires it; the controller records a P1 without one as given, and the viewer shows "no screenshot").
- Findings of other reviewers carry no `evidence` key. Exports before 1.11.0 have none; the viewer treats a missing key as no evidence.
