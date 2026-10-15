# Decisions: review-panel-registry (configurable review panel, step 1; board [r3])

Every worker and reviewer prompt includes this file. The Operator decisions are the operator's own words and bind the run; they win over the task files and the PRD (`features/review-panel-registry/prd.md`). [O1]-[O11] and [G1]-[G17] are copied from the operator's grill of 2026-10-14 (shared memory `projects/md-manager/review-panel-grill-2026-10-14.md`); the grill's "For the /cook sessions" note is not repeated here.

## Operator decisions

- [O1] The request, from the handoff session on 2026-10-14. Operator: "COol so i ll get it fixed later, i am also planning to add hte metas new AI muse to the review panel. And removing deepseek, then we woudl have 4 independent reviewers i think that would really scale the code quality and security" and "Yes lets get a sessions started on implementing this, ask it to do a grill sessions first. I have other things like i want it to be configurable so taht in future we can add any agent in the panel esily".
- [O2] The operator answers this grill, not the panel. This overrides the 2026-10-13 /cook default (the panel answers the grill). The panel grill covers only what this file leaves open. Operator: "ask it to do a grill sessions first" (2026-10-14).
- [O3] Opening question (what else): panels can be spawned at any review point in the workflow, starting with the design challenge. Operator: "I was thinking of having hte abliity to spwan multip panel anywhere in the workflow where we review stuff. Like in the design challenge, if its the most useful step we should use a pnel review there."
- [O4] Q1 (scope): panels go at the independent run review and at the design challenge, not in lane review (`lane_review` stays as it is). The steps run one after another:
  - Step 1: an md-manager /cook adds the shared reviewer list and the run-review panel. Argon and Muse Wonder join, and DeepSeek leaves.
  - Step 2: an md-manager /cook adds the design-challenge panel.
  - Step 3: /multi-review and idea review read the same list, built as a scripted Workflow followed by /multi-review.
  - Critique, the attack pass and the decision panels (night-shift, /cook decide) stay as they are for now.
  Operator: "1  we dont need the panel in the lane review, they should be at the independent review step, the design challenge step. Thats good for me. Yeah rest sounds good to me, for the critique and night pass eventually we might want to use the panel with additional providers".
- [O5] With Q1 (transport): Argon and Muse run on their own subscriptions, not on OpenRouter. Operator: "We wont be using OpenRouter for muse and argon, we will be using their subscriptions."
- [O6] Q2, option B: the panel may send code to a Muse "contributor" variant (one Meta uses to improve its products) for every repo. Operator: "I think its fine no privacy issues for my code".
- [O7] Q3, the operator's own answer (neither the recommended option nor B or C): panel seats are independent reviewers. They run in parallel with the stage's built-in reviewers, don't change the other reviewers' work and aren't aware of each other. Only after every one has finished are all findings compiled for the judge, which uses all of them. Operator: "No the panel should act as independent verifiers, the judges can will use every reviewers findings etc. But it should not impact the otehr reviwers work, it should all be compiled after each one has finished theier review and they shouldnt be aware of others".
- [O8] Q4, option C: subscription CLIs run with their own tools on by default. Operator: "not an issue by default they should have access to their tools, it will provide better results imo".
- [O9] Q5, option B: the judge rules on every finding, from a panel seat or a built-in reviewer, with equal criticality and priority whatever its source. So a built-in reviewer's P0 or P1 no longer blocks or pauses on its own; the judge decides. Operator: "The judge will use all the findings from either the panel or the independent reviewer and all will be treated with equal critcality and priority no matter where th eifnding came from".

- [O10] Read-back 2026-10-14, settles the Ultra check in [G15]: the operator's Google plan is Google AI Ultra, so Argon has a subscription route through the Antigravity CLI. Operator: "Its Ai Ultra".
- [O11] Read-back 2026-10-14: confirms the read-back as written, with no changes. [G1]-[G17] and Deferred stay as they are. Operator: "yeah confirming others".
- [O12] 2026-10-14, on the VM before the step-1 cook: Argon (the Antigravity CLI) is deferred. Step 1 ships with Argon's list entry `enabled: false`, and the operator plugs it in later as a config change. Muse Code is installed. Operator (transcript `b25cb2bc-5324-4580-9a1e-040e63991820.jsonl:156`): "Muse is installed lets do argon later, it shouldnt matter because we are making it configurable and we can plug it in later".
- [O13] The /cook request, 2026-10-14 (transcript `b25cb2bc-5324-4580-9a1e-040e63991820.jsonl:5`). Operator: "I planned a feature run for multi panel in vps can found it in mermoy we need to cook it, make sure everything is ready with the latest cook skill". On that request the session ran `/cook` with these arguments (the session's words, not the operator's):
  > "Step 1 of the configurable review panel (board [r3]): a shared reviewer list (learnings/skills/review-panel/reviewers.json, synced through agent-memory), a generic cli transport next to claude and pi, and the independent run-review panel whose seats run in parallel with the built-in reviewers and feed one judge that rules on every finding. Seats: Claude, GPT (pi openai-codex/gpt-6.1-sol), Muse Wonder (cli, muse exec --model muse-wonder-1.0), Argon (cli, Antigravity) listed but enabled:false; DeepSeek's entry removed. The operator already ran the grill: carry [O1]-[O12] verbatim and apply [G1]-[G17] from the shared-memory project note projects/md-manager/review-panel-grill-2026-10-14.md (it also holds the Muse probe results); number this cook's own prompt bullet after [O12], do not write the template's [O2], and send the panel grill only what that note leaves open." --repo /home/agentops/dev/md-manager --feature review-panel-registry

  /cook delegates every run decision, and only the grill questions this file leaves open, to the panel (Claude Fable + GPT Astra, Jev on splits); its answers are under Grill decisions and Changes after launch, tagged `(panel …)`. [O2] stands: the operator answered the grill in [O3]-[O11].

## Grill decisions

- [G1] Two md-manager features, one after another: `review-panel-registry` (step 1: the list, the transports, and the run review with its seats and judge) and `challenge-panel` (step 2). Step 3 starts after step 1 lands. The operator moved the task to the VM (agent-vm, hostname cryotrack) on 2026-10-14 ("we will move this task to the VM and run it there"), so the cooks run there. Run `preflight` there first, mind that host's own load (`host-capacity-is-an-admission-rule-not-a-panel-vote.md`), and leave its md-manager checkout's branch to /cook's worktree.
- [G2] The reviewer list is one file synced to both machines through agent-memory, for example `learnings/skills/review-panel/reviewers.json`. md-manager's panels, /multi-review and idea review all read it.
  - Each entry has: `name`, `transport`, `model`, credential (a file path or "the CLI's own login", never a key), `prefix`, a cap, and `enabled`.
  - Adding, removing or disabling a reviewer edits only this file. feature.json names seats from the list, and a panel with none named takes every enabled entry.
- [G3] `prepare` pins the list entries a run uses into the plan, so editing the shared file mid-run changes nothing in flight.
- [G4] Transports: `claude` and `pi` stay as they are. A generic `cli` transport is added, whose entry gives the command (argv, with no secrets), how the prompt goes in (stdin or file) and where the findings come out. Argon runs through the Antigravity CLI and Muse Wonder through Muse Code, each a `cli` entry. A new agent with a CLI is then a config change. Only a new protocol is code.
- [G5] First seats: Claude (`claude`, Claude Code's default model), GPT (`pi`, `openai-codex/gpt-6.1-sol`), Argon (`cli`, Antigravity, `gemini-4-argon`) and Muse Wonder (`cli`, Muse Code). Each has its own `prefix` (C, G, A, M), so GPT and Gemini no longer clash on G.
- [G6] DeepSeek's entry comes off the list on both machines. The code keeps its pi transport and fingerprint guard, so adding it back is a config edit. It still works on cryotrack, and it caught the `randomUUID` bug on cl-002.
- [G7] A seat with tools on runs in a throwaway worktree of the reviewed snapshot, removed afterwards (as `lane_review` runs a claude reviewer), so its writes never reach the run branch or the candidate. It also gets the stage's context file.
- [G8] Blindness (O7) is enforced only as far as the prompts and worktrees go. No seat's prompt or worktree carries another reviewer's findings. But a tools-on seat runs as `agentops`, so it could still read the run directory (`~/.local/state/md-manager-workflows/<run>/`). Nothing points it there, and nothing stops it.
- [G9] The judge is one Claude job per stage: the run's pinned judge model, effort high. It runs after every reviewer and seat has finished, failed or timed out.
  - It merges findings by meaning (`llm-review-findings-dedup.md`), checks each finding against the code and grades every severity again, whatever the source (O9).
  - Its confirmed P0 and P1 findings pause the challenge or block the review.
  - Its record keeps every finding, with its sources and the ruling.
- [G10] If the judge errors or times out, the stage falls back to today's rule: a built-in reviewer's P0 or P1 blocks or pauses directly, and panel findings are recorded unjudged. That is no worse than today.
- [G11] Each stage now waits for its slowest seat before any verdict, up to that seat's timeout (15 minutes by default). A seat that times out, fails, hits its plan's usage limit or isn't logged in on the host is recorded and never blocks. The judge goes on with what finished.
- [G12] Subscription seats are capped by timeout and by their plan's usage limits, not by dollars. A metered entry keeps `budget_usd` (the panel's default of 5, bounds 0.5 to 50). The $5 Muse Code plan allows 10 to 50 prompts per 5 hours, so a cook with several challenge attempts and review rounds can use it up, and the seat then fails without blocking.
- [G13] The brief gives each seat the requirements (PRD, `decisions.md`, requirement docs) and asks which ones the change violates. It offers no one-word "none" exit (`review-brief-none-exit.md`), and it pins severity to P0, P1 or P2.
- [G14] Credentials are read from a file or from the CLI's own login. They are never printed, pasted or passed in argv, and the list holds paths, never keys.
- [G15] A check before either cook, on the VM (cryotrack). The operator installs and logs in to the Antigravity CLI and Muse Code with `! <command>`, since the logins are interactive. The session then checks:
  - that each CLI runs on Linux (the Muse Code page names macOS and Windows);
  - that each runs without interaction, with a prompt in and a readable answer out;
  - that Argon appears in the Antigravity model list;
  - which Muse Wonder variant the plan serves.
  A seat that fails stays `enabled: false` in the list, and the cooks go ahead without it.
- [G16] Design check for step 2: the challenge panel was deferred because a report-only panel had to outlive a controller that paused before it finished (detached child, reaper, `panel.lock`; PRD_MULTI_PROVIDER_PANEL §5 step 3, multi-provider-panel [L3]). Under O7 the pause decision now waits for every seat. The step-2 design must first check whether that removes the need for the detached child, and must not rebuild §5 step 3 as written without that check.
- [G17] The decision panels (night-shift, /cook decide) keep two voters, with Jev on splits.

Defaults this cook drafted (not asked; each points to where the detail lives):

- [G18] Credentials ([G2], [G14]): `credential` is `"cli-login"` or `{"file", "env"}`; the controller only stats the file and hands its path to the seat in that env var, never opens it, never puts it in argv. Every shipped entry uses `cli-login` (PRD 4.2).
- [G19] Seat placement ([G4], [G7], [O8]): `claude` and `pi` seats keep today's placement (claude read-only in the review worktree, pi tool-less in a scratch dir); every `cli` seat runs with its own tools in a throwaway worktree of the candidate outside `~/dev` and the run directory, removed on every path (PRD 5.2).
- [G20] Muse entry: `--model muse-wonder-1.0`, sandbox on, `--approval-mode on-request`, `--no-foreign-personal-context`, `--disable-web-tools`, `MUSE_NO_AUTO_UPDATE=1`, and `META_API_KEY` absent by construction (env built from nothing). On cryotrack its file reads work and its shell fails inside the bwrap sandbox (probe 2026-10-14); never `--yolo` (PRD 5, Appendix A).
- [G21] Unchanged: report-only panels (not judged), critique (still blocks on its own), the attack pass, lane review (refuses `cli`); lane-review findings are not judge input (PRD 3, 7.4).
- [G22] Judge defaults: timeout 30 min (5-60), `--max-budget-usd` 15 (1-50), input cap 600 KB. Seat and judge costs live in `panel.json` only: no `costs.py` role and no EXPORT_VERSION bump; the panel record carries version 1.1.0 (PRD 3, 6, 7.3).
- [G23] Lanes write only inside the repo. At finish, and only when the cook ends `done`, the cook copies `examples/reviewers.example.json` byte for byte to `~/.local/share/agent-memory/repo/learnings/skills/review-panel/reviewers.json`, runs the sync secret scan and names it in `learnings/skills/README.md` (PRD 3).
- [G24] 2.11.0 joins every exact-match version set with a keeps-everything test; reviewer id `judge` is reserved; the list holds 1-16 entries and a panel 1-16 seats (PRD 6).
- [G25] This run: feature.json 2.10.0 on ctl's controller (the 2.11.0 behaviour lands only after integration and the operator's ctl fast-forward); `critical: false` (CLAUDE.md lists no critical paths); lane review on every lane; reviewers general and coverage; the report-only GPT panel; critique on the viewer lane; launch with `--judge-model claude-opus-5-5` and `--review-timeout-seconds 3600`, never `--reviewer-transport print`.

Answers to the grill questions this file left open, by the panel (each points to the PRD section that carries the detail):

- [G26] The judge's rulings land in review.json as a `judge` reviewer entry that decides; `findings` holds only the confirmed rulings (tagged `judge`, with lane and sources); built-in entries keep their own verdicts for the record; both validators apply the judged rule only when the plan has a judged panel and the record lists `judge` (PRD 7.4). (panel: agree, high; grill q1)
- [G27] A judged-panel feature refuses to launch when the list is missing, unreadable or invalid, or names a seat absent from it; a disabled seat or a missing CLI is pinned `unavailable` and never blocks (PRD 4.3). (panel: agree, high; grill q2)
- [G28] The judge is a read-only Claude job (Read, Glob, Grep, `--safe-mode`) in its own throwaway worktree of the candidate, with its input on stdin capped at 600 KB; over the cap, today's rule decides (PRD 7.3). (panel: agree, high; grill q3)
- [G29] Base-scope rule: a finding about code unchanged since the run's base that no PRD or decisions line names is ruled `deferred` (recorded, not blocking); "unchanged" means the defect does not arise from the change, not merely that its file is untouched; the rule weighs scope, never source, so [O9] holds (PRD 7.3). (panel: agree, medium; grill q4)
- [G30] On a judged run a built-in reviewer that fails or misses its deadline is recorded and the judge rules on what finished; only a round with no built-in verdict blocks "review step failed", as today (PRD 7.2). (panel: agree, medium; grill q5)
- [G31] Three lanes, `seats`, `judge` and `viewer`, all claude-opus-5-5 (judge at effort high, the others medium), meeting only at the PRD Appendix A signatures and the literal `examples/*.json` (feature.json, policy.json). (panel: agree, medium; grill q6)
- [G32] Strict judge checks: an input finding id missing from, duplicated across or unknown to the rulings' sources makes the judge `incomplete` and today's rule decides; a `refuted` ruling without `path:line` evidence counts as `confirmed` at its highest source severity (PRD 7.3). (panel: agree, high; grill q7)
- [G33] The viewer lane runs claude-opus-5-5 at effort medium with `impeccable`, because it owns the judged-review validator and the record-version contract; its contract tests cover both (viewer-task). (panel: agree, medium; grill q8)

## Changes after launch

Design challenge attempt 1 (3 P1, 7 P2) on run review-panel-registry-001. The bullets below are Claude's revise text plus GPT's concrete additions; they win over the task files and the PRD.

- [L1] (panel: fallback:revise-merged, challenge 1; decisions/001-challenge_paused) Supersedes the PRD 3 non-goal "never puts a prompt ... in argv", seats Constraints' "no prompt ... in any argv" and seats Acceptance 5's argv clause, but only where they cover `claude`/`pi` seats; [G14] and [G19] stand. The rule:
  - No seat's prompt file (brief or context) names a run-directory path or carries another reviewer's findings.
  - No `cli` seat's argv carries the prompt or a run-directory path.
  - `claude` and `pi` seat argv equal today's `claude_command`/`pi_command` output: claude keeps its RUN_SIBLINGS Read denies, pi keeps the brief as its positional argument.
  - No argv anywhere carries a credential or a credential-derived value.

  Seats lane: a named regression test asserts that claude and pi seat argv equal today's builders; Acceptance 4's argv and prompt assertions stay cli-only. Touches seats Constraints, Acceptance 4-5, PRD 3 and 10.3.
- [L2] (panel: fallback:revise-merged, challenge 1; decisions/001-challenge_paused) New frozen literals, added to PRD 7.3 and Appendix A:
  - the `judge-states` block of PRD Appendix B holds the `pending`, `running` and `incomplete` judge objects.
    - `pending` and `running` have `ended_at` null, `cost_usd` null, `rulings` [] and `fallback` false; `running` has its inputs filled.
    - `incomplete` is terminal, with `ended_at`, an `error`, `rulings` [] and `fallback` true. Malformed raw rulings never enter `rulings`.
  - the `plan-panel-judged` block of PRD Appendix B is the pinned `plan.panels[0]` of a judged panel whose feature names the seats claude, gpt, muse and argon. Every default is filled: the resolved `seats`, `reviewers_file` (label, sha256) and `judge` (model, effort, timeout_minutes, budget_usd, input_cap_bytes).

  Resume refuses new files, so both literals are fenced JSON blocks in PRD Appendix B (`<!-- literal: judge-states -->`, `<!-- literal: plan-panel-judged -->`). Tests parse them from the PRD, as the multi-provider-panel tests parse that PRD's Appendix A.

  `panel.record_judge` accepts every PRD 7.3 status. Per lane:
  - Seats: `panel.schema.json` 1.1.0 accepts the three judge objects and `validate_plan` accepts the plan item, with named tests (also in contract.test.ts).
  - Judge: builds its plan fixtures and its non-terminal records from these literals; its `create=True` mocks use exactly these shapes.
  - Viewer: zod accepts the three objects, and a `running` judge renders as "judging".
- [L3] (panel: fallback:revise-merged, challenge 1; decisions/001-challenge_paused) Extends [G26] and judge Acceptance 4. `Pipeline.validate_review` (what `integrate` calls) and `ExportRuntime` pass judged-plan context from `self.plan` to `check_review`/`check_reviewers`. Named tests in `workflow/test_accept.py` and `workflow/test_export.py`:
  - A judged run whose built-in entry is `blocked` and whose judge entry is `approved` integrates and exports.
  - The same record with legacy, report-only or missing judged-plan context is refused.
  - Critique keeps its own blocking.
  - Non-judged outputs stay byte-identical.

  Amends PRD 7.4: accept reads review.json "as today, with the judged context from the plan".
- [L4] (panel: fallback:revise-merged, challenge 1; decisions/001-challenge_paused) `panel.record_judge` sets each seat finding's `accepted` to true exactly when its id is a source of a `confirmed` ruling in a `judged` record; it is false otherwise, and all false on fallback. It also sets the panel's `ended_at` to the judge's `ended_at`. Named test: feeding `panel-judged.example.json`'s judge object reproduces that example's findings and `ended_at`; the fallback example likewise. Adds to PRD 7.3 and seats Acceptance 7.
- [L5] (panel: fallback:revise-merged, challenge 1; decisions/001-challenge_paused) In step 1 a feature that declares a judged panel beside any other panel is refused at launch, with a named test and a line in `docs/handoff/review-panel-seats.md`. The schemas and the viewer zod pin only the pure judged 1.1.0 record and the 1.0.0 record. Adds to PRD 6 and seats Acceptance 8.
- [L6] (panel: fallback:revise-merged, challenge 1; decisions/001-challenge_paused) Judge tests compare values only within one example. Across `judge-output`, `panel-judged` and `review-judged` they compare key sets and types only; `test_judge.py` has no cross-example value equality. The session does not edit the examples' messages. Judge Acceptance 3-4.
- [L7] (panel: fallback:revise-merged, challenge 1; decisions/001-challenge_paused) In step 1 a `claude` seat with `model: null` runs the judges' pinned `--model`. The seats handoff and PRD 4.2 say so; [G5]'s "Claude Code's default model" becomes a later config change. The viewer handoff records one manual check of `claude --resume <id>` for a print job whose cwd was removed, saying whether it resumes; the sessions row keeps the scenario's wording either way.
- [L8] (panel: fallback:revise-merged, challenge 1; decisions/001-challenge_paused) GPT's addition: a candidate-level integration test. The judge lane adds `test_judge.JudgedCandidateTests`, which uses the real `panel.settle`, `panel.record_judge` and validators (no mocks of these ports) to prove:
  - running→judged and running→incomplete persistence, with `panel.json` validating at each write;
  - the resume of a non-terminal judge;
  - that a successful judging writes `fallback: false` and the judged review.json.

  It skips, with the reason "seats ports absent (lane worktree)", only when `panel.settle` or `panel.record_judge` is missing. It therefore runs at candidate verification, where every lane's suite runs on the merged tree. Adds to PRD 10.5-10.8.

- [L9] (panel: fallback:narrowest-scope, run 001 blocked; decisions/003-controller_blocked) Follow-up run `review-panel-registry-002` follows run 001. There is no candidate yet, so each lane restores its own run-001 snapshot of its owned paths: seats `3abe03d`, judge `bbd0deb`, viewer `499ae06`. The exact lines are in each task's Context. Supersedes nothing in the specification; it adds one item:
  - **viewer, T1 (confirmed P1):** in `server/sessions.ts` (the archived-round loop at :745/:778 skips `JUDGE_REVIEWER_ID`; `panelRows`/`judgedPanelRows` at :826/:871 read only the current round), every review round's judge keeps its Sessions row, with its session id, resume command and cost. Earlier rounds' judge records come from the archived round files (`review.round-<k>.json` and `panel.round-<k>.json`). A server test seeds a judged run with one fix round and asserts that both rounds' judge rows render (PRD 8; `docs/PRD_RUN_SESSIONS.md` "every session of a run is listed").

  Run 001's seats check failure was environmental (one test's 90 s timeout under browser-queue contention; 1300 of 1301 passed). Seats and judge carry no code items. Their verification, and seats' first lane review, run again. No policy or check change.

- [L10] (panel: agree, follow-up, run 002 blocked; decisions/004-controller_blocked) Follow-up run `review-panel-registry-003` follows run 002 and restores every lane from the kept candidate `f05855e` (`refs/workflow/7944df79a4611cc5/candidate`) with `--restore-from`. It supersedes [L9]'s run-001 snapshot restore lines and changes nothing in the specification. Seats and judge carry no code items: they restore and verify again. The viewer lane carries one item, in its owned `tests/project-workflows`:
  - **viewer, the flaky gate test:** in `controls.spec.ts`, the `[scenario:controls-unavailable]` test calls `test.setTimeout(90_000)` as its first line, as `home-sections` does at `revamp-lists.spec.ts:89`. No product code, fixture or assertion changes, and the test must still fail on a missing Controls button. Acceptance: the full Playwright suite passes at the viewer verify and at the candidate gate (PRD 10.11 unchanged).

  Run 002's candidate failure was a load timeout on that unchanged test: the suite ran 907 s against about 380 s normally, and the same timeout hit 6 earlier verifications. It was not a product defect: 123 of 124 browser tests passed, and seats, judge and `JudgedCandidateTests` passed on the merged tree. Every required gate runs again, including `JudgedCandidateTests` on the merged tree. Host-capacity admission (`cook.py reserve` and preflight) is checked before launch. No policy, check or feature.json change.

- [L11] (panel: agree, follow-up, run 003 blocked; decisions/005-controller_blocked) Follow-up run `review-panel-registry-004` follows run 003 and restores every lane from candidate `f05855e` with `--restore-from`, plus the viewer's [L10] timeout line in `controls.spec.ts` (the viewer redoes it). It supersedes [L10]'s "no policy change" clause and changes nothing in the specification. Seats, judge and viewer carry no code items, and the viewer's lane-review P1 is refuted (the same claim as run 002's, triage 005 V1).
  - **The one policy.json change:** `timeout_seconds` becomes 3600, the policy cap, for `seats-workflow-unit` and `judge-workflow-unit`. The argv keeps `--jobs 4`. No other check, lane or feature.json change.
  - **Launch condition:** host-capacity admission (`cook.py reserve` and preflight) passes first. The launch waits while another cook's test suite (a run-checks-once repair, verify or candidate) is running or the 1-minute load is above about 5. If run-checks-once enters a fix round, the launch waits for that round's suite to end; its independent review does not delay the launch.
  - Every required gate runs again, including `JudgedCandidateTests` on the merged tree.
  - **Why:** both run-003 timeouts were environmental. Nothing had failed at the kill (1279/1304 and 1119/1324 tests done), and the code is byte-identical to run 002's verified tree.

- [L12] (panel: agree, follow-up, run 004 blocked; decisions/006-controller_blocked) Follow-up run `review-panel-registry-005` follows run 004 and restores every lane from candidate `9245e1e` (`refs/workflow/79753a78f6f7de7f/candidate`) with `--restore-from`.
  - **What stays:** it supersedes [L11]'s `f05855e` restore line. [L11]'s policy.json (`timeout_seconds` 3600 for `seats-workflow-unit` and `judge-workflow-unit`, `--jobs 4`) and its launch condition (host-capacity admission; wait while another cook's suite runs or the 1-minute load is above about 5) stand unchanged. No other policy, check or feature.json change.
  - **Gates:** the judge lane carries no code item; it restores and verifies again. Every required gate runs again, including `JudgedCandidateTests` on the merged tree.
  - **seats, B1 (confirmed P1; general, coverage, lane-review round 2):** a seat's cap is enforced from its own start while the built-in reviewers run, not only inside `settle`. Changes go in `workflow/panel.py` only, with no change in `automatic.py`:
    - Arm a per-job watchdog at `start_seat`: a daemon `threading.Timer(job.timeout)` that SIGTERMs the group, SIGKILLs it after `KILL_GRACE_SECONDS`, and sets `job.expired`.
    - In `_wait_seats`, check `job.expired` (or `clock() >= launched + timeout`) before `_reap_seat`. Record `timed_out` and drop that seat's findings.
    - Cancel the timer on reap and on stop.

    Named test in `workflow/test_panel.py`: a `cli` seat outlives its cap while no settle runs. The test must reject an `ok` record or any kept findings, and must show the process group gone at the cap and the record `timed_out`. A seat that finishes in time keeps its result. This makes seats Acceptance 4 ("killed on timeout") hold from the seat's start, per PRD 5.1 and [G11]/[G12]. Scratch and worktree removal on this path stays as Acceptance 4 requires.
  - **viewer, B2 (confirmed P1; critique):** on a judged run the graph draws no `reviewer-judge` card. In `server/sessions.ts`, `drawnReviewerIds` filters out `JUDGE_REVIEWER_ID`, mirroring the archived-round skip at :750. The judge stays reachable through the Panel and Review surfaces, whose rows, session rows and labels do not change. Keep `tests/project-workflows/fixtures/ux-judged.ts` in step. Named server test (`server/projects.test.ts` or `sessions.test.ts`): a seeded judged run's detail has no `reviewer-judge` node, and the test fails if that node is drawn. PRD 8 and 10.11 are otherwise unchanged; the full Playwright suite passes at the viewer verify and at the candidate gate.
  - **Record only, G8:** worker question 002 was answered by the cook's panel (option A, agreement), not by the operator. Judged seats get the [G13] brief from the new `review-judged.md`, `review.md` stays byte-identical, and the pinned `prompt.source` is the value the seats lane recorded. The seats lane corrects `docs/handoff/review-panel-seats.md:79-81` to say "panel answer". No code change.
  - **Why a follow-up and not a hand-fix:** the two confirmed P1s sit in two lanes (seats and viewer), so the one-lane fix loop could not run. The blocking count went 1, 0, 0, 2, never flat at one across two runs.

- [L13] (panel: agree, revise, challenge 1 on run 005; decisions/007-challenge_paused) Supersedes two parts of [L12]'s seats B1: the clause "check `job.expired` (or `clock() >= launched + timeout`) before `_reap_seat`", and its watchdog step order (signals first, `expired` last). The rest of B1 stands: the watchdog is armed at `start_seat`, changes go in `workflow/panel.py` only (tests in `workflow/test_panel.py`), `automatic.py` does not change, and Acceptance 4's cleanup applies on this path. The rule:
  - **Expiry before the reap is decided by `job.expired` alone.** A seat that has exited without `expired` is reaped on its result, whatever the clock says: `settle` may start up to 3600 s after launch, while a seat's cap is 15 minutes. The clock comparison `clock() >= launched + timeout` applies only to seats still running, as today (`panel.py:1816-1822`), and the seat's exit is re-checked before its timeout is handled. An expired seat is recorded `timed_out`, with no findings.
  - **The watchdog callback is narrow.** It first returns without signalling, or marking expiry, when `job.process.poll() is not None` or `job.result is not None`. Otherwise it sets `job.expired = True` before its first `os.killpg`, then SIGTERMs the group, and SIGKILLs it after `KILL_GRACE_SECONDS`. It touches only `os.killpg` and `job.expired`: never `stop_seat`, `cleanup_seat`, the record or the worktree. The reap, the `timed_out` record and the cleanup stay on the main thread, in `_wait_seats`, `settle` and `collect`.
  - **The timer.** It is created through a module-level factory (or seconds hook) that tests patch. It is cancelled in `_reap_seat` and `stop_seat`, so it is cancelled on every path through `_time_out`, `_stop_seats`, `_fail_seats` and the `_collect_seats` branches.
  - **Tests.** Seats Acceptance 0 becomes these named tests in `workflow/test_panel.py`, each under 5 s with the factory and `KILL_GRACE_SECONDS` patched small:
    - `test_completed_seat_survives_late_settle`: a `cli` seat exits at +1 minute with findings, and `settle` starts with the fake clock at launched + cap + 30 minutes. The record is `ok` with its findings; the test rejects `timed_out` or dropped findings.
    - `test_watchdog_expires_without_settle`: a `cli` seat outlives its cap while no settle runs. It is SIGTERMed at the cap and its process group is gone by cap plus grace. The record is then `timed_out` with no findings, and the worktree is removed after `settle`. The test rejects `ok`, `error` or kept findings. It is deterministic (the `expired`-before-signal order guarantees it) and passes 20 times in a row under `--jobs 4`.
    - `test_reaped_seat_watchdog_is_inert`: a seat is reaped, then its timer callback is fired by hand. No signal is sent and `expired` does not change.
    - A test that stopping a seat cancels its timer.

    This touches seats Acceptance 0 and 4 (the timeout path). PRD 5.1 and [G11]/[G12] are unchanged in substance.

- [L14] (panel: agree, follow-up, run 005 blocked; decisions/008-controller_blocked) Follow-up run `review-panel-registry-006` follows run 005. No candidate exists, so each lane restores its own run-005 snapshot of its owned paths, without `--restore-from`: seats `a722738` (never `54226475`), judge `1aa2251`, viewer `a038212`. It supersedes [L12]'s `9245e1e` restore line. For one test-only edit, it also supersedes [L12]'s "the judge lane carries no code item" and judge Acceptance 0. [L11]'s policy.json and [L13] stand; no policy, check or feature.json change.
  - **seats and viewer:** no code item. They restore and verify again, and their lane reviews run again. The viewer's archived-judge-sessions claim (V1) is refuted for the third time (triage 008; `server/projects.ts` is byte-identical to the code refuted in decisions 004 and 005) and is not carried.
  - **judge, the flaky subprocess timeouts (test-only):** in `workflow/test_automatic.py`, the `subprocess` `timeout=90` at :2532 (`test_recovery_in_actual_new_controller_processes`) and at :3533 (`test_interrupted_reviewer_wait_keeps_the_reviewers_and_resumes_in_a_new_process`) becomes `timeout=300`. Nothing else changes, in that file or in any product code; the tests' assertions, fixtures and browser-queue setup stay as they are. Acceptance: both tests still fail on a child that never finishes (the timeout still raises), and the judge suite passes under `--jobs 4` within the 3600 s cap. The judge lane review runs on this snapshot, since it did not run in run 005.
  - **Launch condition:** as in [L11]. Host-capacity admission (`cook.py reserve` and preflight) passes first. The launch waits while any other cook's test suite is running or the 1-minute load is above about 5.
  - Every required gate runs again, including `JudgedCandidateTests` on the merged tree.
  - **Why:** the judge failure was environmental: one child hit its 90 s limit under three concurrent 4-job suites plus Playwright. The test passes alone in 11.7 s and passed at least 10 times in runs 002-005, and the same 90 s family timed out in runs 001, 003 and 005. Raising the test's own timeout is the narrowest durable fix and is easy to revert. The browser-queue isolation in `GraphFixture.setUp` stays deferred.

- [L15] (panel: agree, follow-up, run 006 blocked; decisions/009-controller_blocked) Follow-up run `review-panel-registry-007` follows run 006 and restores every lane from candidate `d362133faa947620d7a434f417b008c8537c8393` (`refs/workflow/65e709ff5afc5522/candidate`) with `--restore-from`. It supersedes [L14]'s per-lane run-005 snapshot restore lines and, for one test-only edit, [L14]'s "seats: no code item". [L11]'s policy.json, [L13] and [L14]'s judge edit stand (d362133 holds it); no policy, check or feature.json change.
  - **seats, the flaky scheduling test (test-only):** in `workflow/test_sidecar.py`, `Scheduling.test_scheduling_cadence_completion_budget_and_nothing_while_a_pass_runs` calls `self.wait_logged(1)` (the fixture's existing bounded wait, `test_sidecar.py:236-241`) immediately before the existing `time.sleep(0.2)` at :1123. The sleep and the `assertEqual(len(self.job_calls()), 1)` at :1124 stay, so the test still rejects a further job starting while the pass runs. Nothing else changes in that file, in `workflow/sidecar.py` or in any product code. Acceptance: the test still fails when the fake job never logs its call (the bounded wait fails) or when a second job starts, and the seats suite passes under `--jobs 4` within the 3600 s cap at the seats verify and at the candidate gate.
  - **judge and viewer:** no code item. They restore d362133 and change nothing: `git diff --stat d362133 -- <owned paths>` stays empty for each. Their verification, lane reviews and candidate gates run again.
  - **Not carried:** the viewer lane-review round-3 P1 (`readArchivedPanel` catches only `ProjectApiError`) is downgraded to P2 on triage 009 and goes under Deferred. The GPT panel's two P1s are Deferred A/G4 and G5. Coverage G9-G14 and the critique P2s stay deferred.
  - **Launch condition:** as in [L11] and [L14]. Host-capacity admission (`cook.py reserve` and preflight) passes first. The launch waits while any other cook's test suite is running, the 1-minute load is above about 5, or swap is in use.
  - Every required gate runs again, including `JudgedCandidateTests` on the merged tree, and review round 2 runs on the new candidate. No readiness claim before these pass.
  - **Why:** blocking now is 0 (triage 009). Run 006 stopped on a pre-existing, load-sensitive flake: the test is unchanged since f3145b6 and identical on main, it passed in 48 other check logs, and the same Python files passed this suite twice at candidate 1 (a70c479). Attempt 2 ran under 1.4-1.6 GB of swap and IO pressure (a 636 s suite). A bounded wait is the narrowest durable fix and is easy to revert.

- [L16] (panel: agree, follow-up, run 007 blocked; decisions/010-controller_blocked) Follow-up run `review-panel-registry-008` follows run 007 and restores every lane from candidate `207c037d00c12718462a310d8493e77be52a0036` with `--restore-from`. It supersedes [L15]'s `d362133` restore line and, for one test-only edit, [L15]'s "judge and viewer: no code item" where it covers the viewer. [L11]'s policy.json, [L13], [L14]'s judge edit and [L15]'s seats edit stand (207c037 holds them); no policy, check or feature.json change.
  - **viewer, the flaky first-load wait (test-only):** in `tests/project-workflows/review.spec.ts`, the `[scenario:paths-redacted]` test's first assert at :169 becomes `await expect(findingRows(page)).toHaveCount(6, { timeout: 15_000 })`, matching the suite's existing 15 s first-answer waits (`projects.spec.ts:474`, `ux-launch.spec.ts:114`, `controls.spec.ts:155`). The 6-card count, the `PATH_TOKEN` and quote asserts, the fixtures and all product code stay as they are, and `playwright.config.ts` does not change (`retries: 0`, no global `expect.timeout`). Acceptance: the test still fails on a wrong finding count or an unredacted absolute path, and the full Playwright suite passes at the viewer verify and at the candidate gate (PRD 10.11 unchanged).
  - **seats and judge:** no code item. They restore 207c037 and change nothing: `git diff --stat 207c037 -- <owned paths>` stays empty for each. Their verification, lane reviews and candidate gates run again.
  - **Not carried:** the new judge lane-review P2 (`workflow/judge.py:185-187`, `fit` can drop a requirement document unnamed; triage 010 J-b) goes under Deferred. V-a (= triage 009 C), V-b (= T2) and J-a (= T4) stay deferred.
  - **Launch condition:** as in [L15]. Host-capacity admission (`cook.py reserve` and preflight) passes first. The launch waits while any other cook's test suite is running, the 1-minute load is above about 5, or swap is actively in use.
  - Every required gate runs again, including `JudgedCandidateTests` on the merged tree, then review round 1 runs on the new candidate. No readiness claim before these pass.
  - **Why:** blocking now is 0 (triage 010). Run 007 stopped on a load-sensitive browser flake: the test passed in all 14 earlier reports and in repair-1's 25 targeted reruns plus a full 124/124 suite on unchanged 207c037; the failing window had the gate's highest CPU stall (cpu_some10 32) with about 920 MB of swap in use; the run-detail path adds only a pure in-memory check (`server/projects.ts:1541`). The test has reached 4530 ms before, so a 15 s first-load wait is the narrowest durable fix and is easy to revert.

Not changed:
- The Muse entry's `env.pass: []` stands. The session ran the challenge's cheap experiment, and the login works with an environment built from nothing (`decisions/001-challenge_paused/extra.md`).
- The seats lane's effort stays medium, because feature.json is frozen after prepare.
- The sequential-lane alternative is not taken; [L2]'s literals carry the cross-lane shapes instead.

## Deferred

- Panels at critique and night-shift, "eventually ... with additional providers" (O4).
- Argon through the Gemini API directly (key at `~/.config/pi/gemini.env`) once billing is linked: a config entry later, if wanted.
- `pi update --models`: not needed for the subscription route, and the operator's call.
- Judging Argon and Muse as seats by unique confirmed findings over about 10 reviews (`md-manager-review-layers.md` §4).
- The Argon seat: install the Antigravity CLI, log in, read the real slug from `agy models`, set it in the shared list and flip `enabled` ([O12]). Set AI Credit Overages to Never first (overage spends real money).
- Muse's shell on cryotrack: `muse sandbox` setup so its shell works inside the sandbox (the operator's call).
- Seat and judge costs in `costs.py` / `status` cost lines.
- A read-only `workflow reviewers check` command.
- Step 2 (`challenge-panel`, [G16]) and step 3 (/multi-review and idea review read the list) ([O4]).
- From run 001's lane review (panel decision 003; deferred by the narrowest-scope fallback):
  - T2 (P2): `server/projects.ts:2279` should pass seat `model` and `served_model` through `redactPaths`, as `cli_version` is.
  - T4 (P2): a print-transport judge that is interrupted cannot resume (`automatic.py:1966-1970`); print never resumed before either, and these runs never use print ([G25]).
  - T5 (P2): resume forgets which built-in reviewers failed (`automatic.py:1072`), a narrow provenance window.
- From run 002's lane review (triage 004; all confirmed P2 that fail safe):
  - A: `workflow/panel.py:1649-1663` `stop_seat` never SIGKILLs the process group when the leader exits on SIGTERM within the grace; the fix is `_kill_group(job)` after the leader's wait.
  - D: `workflow/pipeline.py:170` `JUDGED_GATES` includes `critique` unconditionally, so an undeclared built-in reviewer named `critique` gates approval.
  - E: `workflow/judge.py:44` the citation rule rejects root-level extensionless paths such as `Makefile:8`, so such refuted rulings record as confirmed.
  - F: `workflow/judge.py:482` a whitespace-only `requirement` reaches review.json and is rejected there instead of taking the judge fallback.

  Run 001's T2, T4 and T5 stay deferred.
- From run 004's review (triage 006; all P2, fail safe or test gaps; they stay out of run 005):
  - G3: claude seat `bin` advisory (refuted as P1 twice).
  - G5: `.pid` written after `git worktree add`.
  - G6: `fit` drops requirement blocks within about 200 bytes of the cap; it should raise `OverCap`.
  - G7: the reuse branch skips `kill_orphan`.
  - G9-G14, test gaps:
    - scratch-dir removal on failure, timeout, Ctrl-C and orphan;
    - a fake-clock resume timeout;
    - a `subTest` per refusal;
    - real `settle` in `JudgedCandidateTests`;
    - a 1.0.0 Panel snapshot;
    - a missing-plan seeded run.
  - G15: the judge row's worktree note.
  - G16: the pi `mpp-panel-*` scratch dir is never removed (pre-existing).
  - Critique's two design P2s.

  G4 (= A) and G17 (= the browser-queue/host-load item) stay deferred as before.
- From run 005 (triage 008, plausible P2): the viewer's panel card leaves out the judge's cost.
- Test isolation: the workflow tests wait on the host-wide browser queue (`~/.config/md-manager/browser-queue`), so lane suites contend with live Playwright checks. This was run 001's seats timeout. It goes to a learning, not this cook.
- From run 006 (triage 009, P2): `server/projects.ts:2256-2262` `readArchivedPanel` catches only `ProjectApiError`, so an unreadable `panel.round-<k>.json` (EACCES, EIO) makes `/sessions` return 500. Same-user 0600 files, a loud failure, and the base has the same pattern for the live panel.json. The fix is a one-line `catch { return null }`.
- From run 007 (triage 010, plausible P2, J-b): `workflow/judge.py:185-187` `fit` can drop a requirement document without naming it.
