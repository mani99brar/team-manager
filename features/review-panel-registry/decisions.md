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

None yet.

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
