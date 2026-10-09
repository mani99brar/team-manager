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

A 2.9.0 feature that declares `critique` gets one more reviewer at its review step, the **critique reviewer** (reviewer id `critique`). The controller gives it a disposable worktree of the frozen candidate with the policy `setup` run, starts the app there on free ports, and launches a Claude session that may run commands in that worktree and loads the `impeccable` skill. The session drives the app with Playwright from Bash (no MCP browser: reviewer sessions run with an empty MCP config), reads its own screenshots, and writes an ordinary reviewer completion: verdict, findings with `severity`, `message`, `disposition` and `worker` (the lane whose owned paths render the broken screen). The controller then stops the app and combines the critique's completion with the other reviewers' exactly as today, so:

- an open P0/P1 from the critique blocks the review like any reviewer's, and the fix loop sends it to its lane when all open blockers name one lane;
- the next round's critique gets the previous round's findings and the delta, as the other reviewers do;
- screenshots it cites are kept under `$RUN/critique/<round>/` and listed in its completion, so the operator and the viewer can see what it saw: each critique finding shows its steps to reproduce and its screenshots on the run page (Appendix A).

## 4. Design

### 4.1 Why a reviewer and not a pass beside the review

The fix loop reads only `review.json` (`automatic.open_blockers`, `pipeline.check_review`); the attack pass and the panel are collected after the verdict (`automatic.review_candidate`'s `finally` chain). A finding source outside the reviewers would need a second decision path. As a reviewer, the critique reuses the verdict, the closed `review.json` shape, the per-round archive (`archive_review`), the delta base and the repair brief unchanged. What differs is only how the session is set up and launched (4.2-4.4).

### 4.2 Configuration (feature.json 2.9.0, policy 1.4.0)

```json
{
  "version": "2.9.0",
  "critique": {"lanes": ["pages", "shell"], "skills": ["impeccable"], "timeout_minutes": 45}
}
```

- `lanes`: the lanes whose UI the critique walks (1 or more of the feature's lanes); their Goal and `verify_yourself` lines are its brief, and only they may be named in its findings' `worker`.
- `skills`: as a lane's (2.8.0 rules, pinned at prepare under `plan.critique.skills`), default `["impeccable"]`.
- `timeout_minutes`: 10..120, default 45; past it the session is stopped and its review is recorded as a failed reviewer (as a timed-out reviewer is today).
- Refused before 2.9.0; reviewer id `critique` and the prefix `critique-` are reserved.
- The policy gains `critique_app` (policy 1.4.0, required when the feature declares `critique`): `{"argv": [...], "ready_path": "/", "timeout_seconds": 120}`. The controller runs `argv` in the critique worktree with `CRITIQUE_WEB_PORT` and `CRITIQUE_API_PORT` set to free ports it picks, waits until `http://127.0.0.1:$CRITIQUE_WEB_PORT<ready_path>` answers, gives the session the URL, and stops the process group when the session ends. For md-manager this is a script that seeds a temporary root and starts `start:api` and `dev:web`, as `tests/project-workflows/playwright.config.ts` does.

### 4.3 The worktree and the app

- `<runs root>/<run>.critique/worktree`, pinned at prepare like the attack worktrees; `git worktree add --detach` at the candidate, policy `setup` once (marker file), reset between rounds; removed by `clean`.
- The app and the session's browser hold one browser-queue slot (`browser_queue.browser_slot("<run> critique")`) for the whole span, so a critique and verifier suites take turns when the queue is on.
- The app runs with the verifier's check environment (`checks.check_environment`: secrets scrubbed, private `TMPDIR` and caches).

### 4.4 The session

- `claude --bg` like a native reviewer, with: `--setting-sources "" --plugin-dir <run>/skills/critique` (2.8.0 mechanism, `skills.py` helpers keyed `critique`), `--tools Read,Glob,Grep,Bash,Skill` plus the `Write` of its completion and of `$RUN/critique/<round>/`, the reviewer deny list, empty MCP config, the reviewer role's pinned model and effort, `cwd` the critique worktree.
- Bash is the new power for a reviewer. Bounds: it runs in the disposable worktree; the deny list keeps the secrets out; the worktree is reset before every round, so nothing it changes reaches the candidate; its completion is validated like any reviewer's.
- Its brief (`workflow/prompts/reviewers/critique.md`, `builtin:critique`): the app URL; the lanes' Goals and `verify_yourself` lines; "use it the way a person would: real clicks and typing, the keyboard, a narrow viewport, empty and error states, back and reload"; run Impeccable `critique` on the changed screens (the skill's degraded single-context mode, banner included, since it has no subagents); severity rubric (grill Q4): P1 only for a flow a lane's Goal or `verify_yourself` line promises that does not work, or a UI that misleads the user about what happened (success shown after a failure, data lost without saying so), each with steps to reproduce and a screenshot; design issues, heuristics and the Impeccable craft floor are P2 or P3, never P1; every finding names its lane and the screen; P0 is not used by the critique.

### 4.5 Records, viewer, attention

- The critique is one more entry in `review.json`'s `reviewers` and its findings carry `reviewer: "critique"`; no new attention kind (`review_blocked` covers it). `review.json`'s key sets stay closed: the critique's completion carries each finding's evidence (steps, screenshot files), and the controller writes it to `$RUN/critique/<round>/evidence.json`, registers each screenshot as a run artifact of kind `screenshot` (served by the existing artifact route) and archives the folder with the round.
- The export (1.11.0) adds `evidence` to each critique finding in the review section and in each archived round (Appendix A); the viewer shows the steps and the screenshots on the finding, reusing `Screenshots.tsx`'s thumbnail and dialog.

### 4.6 Attack runs (grill Q1)

The loop skips attack runs today (`automatic.py`, `if lane is None or has_attack(...)`) because `attack.json` is never archived and would never rerun. For a plan with both `attack` and `critique`, the loop runs: the attack pass runs once, on round 1's candidate, and stays report-only; later rounds keep that record, marked with the candidate it judged, and do not rerun it (a pass can take near three hours per angle). A plan with `attack` and no `critique` keeps today's behaviour.

## 5. Work items (engine unless noted)

1. 2.9.0 everywhere a version set lists 2.8.0 (guardrails, launch, attack/panel/sidecar version sets, the feature schema, contract test, an example), the `critique` key and its refusals; policy 1.4.0 `critique_app`.
2. Prepare: pin `plan.critique` (lanes, skills with digests, advisor model, worktree paths, settings digest); add `critique` to the plan's reviewers.
3. Review step: before launching the reviewers, create or reset the critique worktree, run setup, take the browser slot, start the app and wait for ready; launch the critique session with the other reviewers; stop the app and release the slot when it completes, fails or times out, and on Ctrl-C/exit 75 (resume relaunches it like a reviewer).
4. `builtin:critique` brief and the screenshot convention; repair brief unchanged (findings verbatim).
5. `archive_review` and `clean` cover `$RUN/critique/` and the worktree; evidence registered as artifacts.
6. The fix loop on a plan with `attack` and `critique` (4.6).
7. Export 1.11.0 and `contracts/projects` (Appendix A); the server serves the evidence through the existing artifact route.
8. Viewer lane: each critique finding shows its steps and screenshots on the run page, in the review section and in archived rounds.
9. RUNBOOK section and README rows.

## 6. Acceptance (engine, no model calls; fake `claude` and a fake app as the existing tests use)

- A 2.8.0 feature with `critique` is refused; a 2.9.0 feature without it launches byte for byte as a 2.8.0 one.
- A critique run starts the app on free ports, launches the critique session with the pinned flags and stops the app afterwards, also after a timeout and a Ctrl-C.
- A critique completion with an open P1 naming lane `pages` blocks the review and starts a repair of `pages`; the next round relaunches the critique against the repaired candidate with the delta.
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
  "screenshots": [{"artifact_id": "screenshot-3-0a1b2c3d4e5f", "caption": "After clicking Run: spinner never ends"}]
}
```

- `steps`: 1 to 20 strings, each at most 300 characters. `screenshots`: 0 to 6 entries; `artifact_id` resolves through `/api/projects/<project>/workflows/<workflow>/runs/<run>/artifacts/<id>` as check screenshots do; `caption` at most 200 characters.
- A P1 critique finding always has at least one screenshot (the brief requires it; the controller records a P1 without one as given, and the viewer shows "no screenshot").
- Findings of other reviewers carry no `evidence` key. Exports before 1.11.0 have none; the viewer treats a missing key as no evidence.
