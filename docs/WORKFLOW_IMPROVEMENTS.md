# Workflow improvements from the AI logs

An audit of the md-manager workflow, run on 2-3 Oct 2026. Your decisions come from the grill on 3 Oct 2026.

This is based on the ai-logs archive (55 workflow runs: 38 on project-B, the rest on md-manager, VEA and kleros-v2, with their events, completions and review records), the Claude and Pi transcripts behind them, the operator logs and REPORT.md, the md-manager source at b92ff7d, and your AI_NOTES.md. Twelve audit areas each had their findings checked by an evidence refuter and a design critic, two gap rounds looked for what they missed, and replays re-ran archived challenge and review prompts on their original inputs (29 Claude and 11 Codex jobs on 7 cases; a "judge" is the design challenge or a reviewer, and each run of a judge on an input, archived or replayed, is a "sample"). "Orchestrator" means the Claude session that drafts tasks, runs the grill and drives the workflow CLI for you. The "supervising session" is the Claude session that watches runs on a /loop: today the orchestrator itself, and after C55 a separate restricted session that C55 calls the unattended monitor. "The agent" and "the assistant" mean one of these sessions, not a worker. "Maintainer" is not a person: it is the `--by maintainer` label (C17) on gate actions those sessions take, while `--by operator` is you. Paths start with ai-logs/ (the archive), md-manager/ (the controller source at b92ff7d) or workflow-audit-evidence/ (the audit's replays and probes, saved next to this file).

How to read it. Part 1 is the plan: what to do now, what you decided, a suggested build order, and the defaults the audit chose that still need your yes. Part 2 answers each of your notes. Part 3 is the reference, with every change and its evidence; most of its 58 changes are still proposals, so check the status line under each heading. Parts 4 and 5 list what to keep and which earlier conclusions were wrong. The Appendix has the method, what the audit's agents ran besides reading (including Codex jobs that received the VEA prompts and a snapshot of the vea repository, three of them with your Codex user config and MCP servers), the 3 Oct grill record with your answers verbatim, and the claims that were not verified or were refuted.

## Part 1. Action plan

### Act now (recommended; outside the workflow)

Recommendations, not decisions. Item 2 changes project-B code, so it is also listed under the proposals below.

1. **Rotate the credentials committed to ai-logs** (C42). Commit 276d79f, pushed to the private mani99brar/ai-logs, holds Pi's openai-codex OAuth access and refresh tokens (sessions/pi/auth.json), a Brave Search key (sessions/pi/web-search.json), a DeepSeek API key (`sk-`, in 4 transcripts), and a DEPLOYER_KEY (ending 391f) that the transcripts call the funded VPS wallet. The repository is not public (404 without auth). Revoke Pi's openai-codex OAuth session, rotate the DeepSeek and Brave keys, and treat the deployer key as exposed: move its funds and generate a new key. The many private keys ending ff80 are Hardhat's default test key and need nothing, and the other `sk-` matches in the archive are the letters "sk-" inside words such as "task-" in file names, not keys.
2. **Fix the theft-window bug on project-B main** (C33, step 7). A general reviewer's P1, discarded by the first-block rule, is live on 99139b5: a duel in its theft-choice window does not freeze when the match ends. The audit's test fails on main and passes with a one-line guard (workflow-audit-evidence/gap-1-5/rerun-99139b5.log and rerun-control.log), but the guard is only half the fix and the test as written cannot tell: C33 step 7 also settles "choosing" duels in endMatch, extends the test, and warns that the test brings integration to about 241 s of its 300 s timeout.
3. **Correct PR #526's description** in the vea repository (C43, step 5). It says chain ids come from each network's .chainId; the generator uses a hardcoded map and only checks each .chainId against it.
4. **Before any arbToGnosis release, test validator-cli's claimer wiring on dev** (C21, step 1): add a test that enters at watcher.ts with per-chain providers that disagree on chain id and block height (or wrap each provider to assert its chain). A static read shows the claimer falling back to the outbox provider where the challenger gets the router provider; nobody has run the code to confirm it.

### Your decisions

Your answers from the 3 Oct grill, summarised; the Appendix gives each question as asked and your own words verbatim. "Attended" and "unattended" name a run's profile, pinned at prepare (C52); whether you are at the desk or away is separate, and decision 2 covers being away.

| # | Decision | Your answer | Changes |
|---|---|---|---|
| 1 | How you review design-challenge findings | An opt-in hold after a passing challenge: an attended run stops and prints every concern, P2s included; `resume --launch` continues; unattended runs launch as today | C8 |
| 2 | What happens when you are away | Decisions come to you on Telegram when you are away from the desk (your proposal) | C57 |
| 2a | What the supervising session may do alone while you are away | Mechanical recovery only, through the controller's gates and recorded as `--by maintainer`, never as you: resume after a crash, retry a failed check, relaunch a stuck session. Anything that changes scope, decisions, checks or approvals goes to you on Telegram | C55, C57, C17 |
| 2b | No reply on Telegram | Keep waiting: the run stays paused, independent runs continue, and a reminder goes out after a set interval; nothing is decided without you | C57 |
| 2c | What sends messages and applies replies | The controller's bot, with one button per option (your question about answers outside the buttons is settled by 2e) | C57 |
| 2d | Message content | Summary and pointer: the decision, the options with their consequences and the run id, with the full details in the viewer; no code, diffs or file contents | C57 |
| 2e | A reply outside the listed options | Stored verbatim; the supervising session drafts the concrete actions and you confirm with a tap before anything runs | C57 |
| 3 | An approval stop at the end of automatic runs | Only when the run's profile asks (attended, or code you mark critical): the run stops and lists open findings and untested items; other runs finish as today, and the record stops claiming an approval gate that never fires | C51, C52 |
| 4 | When coverage blocks | Only on a shown failure, a contradicted task line or a failure the worker disclosed; other gaps become P2 rows in a tested/untested map | C34 |
| 5 | Keeping workers away from your credentials | Claude Code's Bash sandbox plus read-deny rules and a network host allowlist, for workers and the verifier, after a VPS probe (C14's trade-off lists what it checks) | C14 |
| 6 | How the target repo's CLAUDE.md reaches sessions | Pinned from the base commit, up to an operator-notes heading, into worker, challenge and reviewer prompts; --safe-mode stays | C15 |
| 7 | What proves acceptance when you decline tests | Worker self-report, as today | C20 not adopted |
| 8 | Which decisions bind a run | Only your answers; grill defaults and later additions stay open to the challenge | C4 |
| 9 | AI workers on critical company code | Decided per feature at the grill; launch does not refuse | C5, C36 |
| 10 | Hands-on tryouts | Each user-facing run leaves a "try this" entry, and you record works, broken or skipped (its tryout record) before the merge to main; new user-facing launches stop after 3 untried features | C7, C29 |
| 11 | Where the challenge's concerns go in runs without the hold | To workers as numbered advisory notes; reviewers do not see them | C9 |
| 12 | Live watching during runs | Free controller signals plus opt-in triage jobs (about $1 each) that can route a P0/P1 to its lane as a recorded note (C17) or to you on Telegram (C57); no P3 loop review | C41 |
| 13 | This document | Plan plus reference | |
| 14 | The audit's own smaller choices | Proposals, not decisions: nothing binds until you say yes | below |

### Suggested build order

A proposal; reorder freely. Changes marked Proposed in Part 3 need your yes before they are built, and steps 1, 2, 4 and 5 are mostly Proposed. Each step is usable on its own.

1. **Stop losing verdicts and make the record honest** (small controller fixes): C33 (let the other reviewers finish), C51 step 2 (the record matches what will happen), C18 (accept finished sessions), C24 (three controller defects), C40 (one review record).
2. **The grill and decisions** (skill and prompt edits, plus controller changes for C1, C4 and C15): C2 (a Recommended option commits only to its question), C1 (playback and read-back before launch), C3 (offer the repository's own pattern), C4 (only your answers bind), C5 step 4 (the per-feature critical-code question, decision 9), C15 (pinned CLAUDE.md) with C19 (its hygiene deny list ships with C15).
3. **Your control loop**: C44 (attention records and honest events), then C57 (the Telegram channel; until C14 lands in step 5, run its bot as a separate OS user so workers cannot read its token) with C17 step 2 (`--by` on every gate action), C55 steps 2-4 (mechanical recovery only) and C53's presence line (how the supervising session knows you are away), then C8 (the challenge hold) and C51 step 1 (the approval stop), configured through C52's profiles (C52 step 4).
4. **Better gates**: C10 (the challenge says who must act, with one recommendation per concern and no hedged fallback like VEA's "or at least"), C9 (concerns to workers), C34 with C31 (the coverage rule and the findings ledger; C33 is in step 1), C35 (role-specific reviewer inputs), C16 after C18 (completion rules).
5. **Safety**: the VPS probe (bwrap and socat present, --settings honoured under --safe-mode, Playwright's Chromium running inside bwrap; see C14's trade-off), then C14 (sandbox and read-deny), C25 (one git helper), C54 (`workflow doctor`); C55 step 1 (the restricted monitor launch) after C14.
6. **Throughput and product quality**: C7 with C29 (tryouts), plus C43's `workflow digest` (its step 3), which batches tryout entries into the per-build card C29 must ship with; C41 (signals and triage) with C58 (the sidecar delivery fixes and its measured trial), C30 and C32 (fix cycles and `review-commit`), C23 (rehearse on main), then the remaining Proposed changes in Part 3.

### Proposed, not decided by you

The audit had written 16 defaults into its changes. Decision 10 settled one of them (new user-facing launches stop after 3 untried features); the other 15 are below, and following decision 14 none of them binds until you say yes. Beyond this list, every change in Part 3 marked Proposed is a proposal, as are the undecided parts of the Partly decided changes and any step of a Decided change that its status line does not name. C20 is not adopted (decision 7), and C42 is under Act now.

- **C33:** when one reviewer blocks, record the verdicts already written, then poll the others for up to a 10-minute grace. This reverses the parallel-reviewers PRD's rule that a block does not wait for the other reviewers' files; blocked runs end a few minutes later and pay for the rest of the slower review.
- **C33, step 7:** fix the theft-window bug on project-B main 99139b5 by hand, with the extended test (Act now item 2); main changes only after your yes.
- **C16:** a worker that cannot test a requirement, or reads it differently, reports the completion status `question` instead of deciding and noting it; with C57 the question reaches you on Telegram. More paused lanes, at most 3 questions each.
- **C16, step 8:** workers run targeted tests while iterating and every policy check once at the end, as one default line in the scaffold's Acceptance template. This writes down current practice: 37 of 37 project-B lanes ran every check because their Acceptance lines said so, and 82% of project-B unit and integration runs were already targeted.
- **C17:** other mid-run instructions also go through a recorded `workflow note` with their real author (the note that routes a triage P0/P1 to a lane is already decided, decision 12). Answer delivery gets refactored, and --by is cooperative, not access control.
- **C26:** a resume `--by operator` may re-pin policy.json while no worker has started, with the same lanes and the diff recorded. The policy digest becomes final only at first launch, and weakening checks gets easier, which the recorded diff and C27 offset.
- **C32:** fixes after approval go through `workflow review-commit`; fixes that touch a known-condition path (C31), or that the reviewer escalates, get a challenge or a full run. Weaker than a full run: no challenge by default.
- **C23:** each approved run is rehearsed on current main in a scratch worktree; you merge, or the orchestrator does on your decision. One rehearsal per run (median 4.2 min) with its own checkout and ports.
- **C13:** a second challenge sample in unattended runs only, and only after C13 step 1's replay measurement, which may cancel it. About $1 and 3 min per passing attempt, and more overnight pauses.
- **C22:** only you broadcast mainnet transactions; agents prepare a decoded plan that a second reader checks. On 18 Sep an agent broadcast the route deployments itself. You must be present for every broadcast.
- **C21, step 4:** decide on the seven 16 Sep validator-cli fix branches after one combined audit on dev with the entry-point test. They stay unmerged until then; fix-1 and fix-2 both edit watcher.ts:240 and were never reviewed together.
- **C56:** workflow files stay on workflow/base with an automated `workflow pr-branch`; never .git/info/exclude. Integration becomes a fetch, and the base commit must stay reachable.
- **C37:** a Codex bug hunt at each controller branch merge; no Codex reviewer inside runs yet. About $5 and 6 min per Codex pass.
- **C52:** the challenge and reviewers pinned at high effort. Judges always run at high, as 92 of 96 reviewer sessions already did, and pinned roles cannot change on resume.
- **C47:** derived checkouts deleted automatically after passed verification attempts, and by `workflow clean` otherwise. This reverses the "no automatic destructive cleanup" rule.
- **C58:** fix the sidecar's delivery and cadence, disable it on short single-lane runs, and keep or drop it on a 20-run trial (70 percent of messages delivered, one fix after delivery per two runs). Until decided it runs as today, delivering 59 percent of its messages.
- **Also proposed, beyond decision 4 (C34, C7):** coverage would also block when a test drives a task's Real use line (C7) an easier way than stated; under your decision that gap is a P2 row.

## Part 2. Your notes, item by item

| Note | Verdict | What the logs show | Changes |
|---|---|---|---|
| "it misunderstood that we only want to support testnet on vea. Issue was with the TASK, REVIEW context in plan" | Partly right | The misreading entered in the orchestrator's 10:13 task draft and the grill never asked. Review context was not the cause: your words were in the PRD, both challenges and the general reviewer read them, read literally they support "testnet only", and no replay questioned it. | C1, C4 |
| "coverage(verifies added tests, can be updated to ensure useful tests are added. Also helpful to know whats tested and whats not)" | Partly right | Coverage decided 11 of 13 blocked project-B verdicts: 9 bought tests for behaviour that already worked, 2 traced real defects the worker had disclosed. Its verdict varies (on one candidate, 3 of 5 samples blocked: the archived review and 4 replays), and coverage itself produces no tested/untested map; the committed branch tables have given one since match-online-fixes-2. | C34, C6, C30, C33 |
| "The prompts only differs for roles both bot have the same context, provenance, decisions etc." | Confirmed | Identical in 43 of 43 runs apart from brief, reviewer id and launch token; the shared context also lacks the PRD path, the workers' untested and verify_yourself lists, and mid-run notes. | C35, C17 |
| "Decisions and Context have overlap" | Confirmed | The network map is in both; the overlap is restated facts, not copy-paste. The package.json "files" contradiction came from a note the orchestrator typed into the worker's pane, not from task versus decisions. | C4 |
| "make the workflow configurable like for design challenge I consider all findings and then move to automatic untill approval needs" | Confirmed | No such setting: only P0/P1 pause, a P2-only result launches workers in the same second, and automatic runs approve themselves while their record lists an approval gate. Reading every concern is also the steadier gate: one sample's pause decision disagreed with another's in 24 of 51 pairs. | C8, C51, C52, C57, C13 |
| "Failed to correctly express my needs like i wanted it to have the same strucutre as the SDK but it only maintained this for the consumer side, the internals were rigid ... Why didnt it pick the SDK pattern. For example it has hardcoded networks instead it should read the files like we do for Veashi and auto generate the route files" | Answered | The task named the SDK pattern only for the getters; grill Q2 offered generation inside generate-types.sh, framed as untestable, and you declined. The map came from the orchestrator's draft, the router table from challenge 001's alternative, and VEA's CLAUDE.md, which describes the file-driven flow, reached none of the 6 VEA sessions because of --safe-mode. | C3, C15 |
| "Added unnecessary contract and network fields i never asked for, why did these came to exist? THESE COME FROM PROVENANCE" | Answered | Grill Q5 (about ABIs) offered "Addresses only (Recommended)", described as "Addresses + provenance". It bound at 10:22:59 and was then left out of the two summaries you got before a worker started (10:25 and 10:32, each written just after a launch); it next came up only in passing at 10:35, after run 002's worker had started ("The contract name and network stay in the JSON only"). Both challenges took it as settled, and none of 10 challenge samples (5 Claude, 5 Codex) questioned it. | C2, C1, C10 |
| "Worker should only run the new test it added nothing more? Or its better to give more responsiblity to the worker?" | Answered | The checks quoted in your note are self-reported; only typecheck and vea-data-fresh ran under the controller. Workers already target tests (82% of project-B unit and integration runs were filtered); running every check comes from your Acceptance lines (37 of 37 project-B lanes). You chose to keep worker self-report when tests are declined (decision 7). | C16 (C20 not adopted) |
| "Worker also returns untested section which the coverage worker picks up." | Partly right | Only when the task points at the completion file: coverage opened it in 2 of 41 runs (VEA-002 because the task named verify_yourself). The hand-off to reviewers drops the untested list. | C35, C16 |
| "If i had reviewed the Challenge for design i would have caught the flaw, but the findings doesnt explicitly mention my issue" | Partly right | Challenge 002 raised the hardcoded map (P2 #4) but not the scope or the file-driven pattern; it read your words, which support testnet-only, and may not reopen decisions.md. Of 5 Claude samples of that input (the archived one and 4 replays), 3 raised the map as a P2 and none raised the scope or provenance; 5 Codex samples raised none of the three. | C8, C3, C1, C13 |
| "Theres a P2 challenge in design which i would actually approve and is a good challenge, FOR THE HARDCODED NETWORKS AND CHAINS" | Confirmed | P2 #4 never gated. It reached the worker in a pane note that kept the concern's fallback ("or at least fail generation when your mapping disagrees with it"); the 10:35 message summarised that note to you as "Read chain ids from the deployment folders", the 11:11 report said the worker applied all four notes, and PR #526 said chain ids come from .chainId, while the code kept the map. No sample rated it P1, so today's rule would never pause on it. | C8, C10, C9, C17, C43 |
| "Challenger proposed simpler alternative but didnt cover all the findings, it covered a single P2 and it was taken care of." | Confirmed | Run 002's alternative addressed only concern #2 and was applied; its "files stays as it is" contradicted decisions.md and led to general finding 0. | C10 |
| "Reviwers findings match what the challenger flagged [2 findings both from general and are real]." | Partly right | General #1 matches concern #4 (partly through the worker's disclosed assumption) and the coverage finding matches #3; general #0 disputes the layout concern #2 recommended rather than repeating it. | C9, C35 |
| "automatic-review-general/coverage.json, theres duplication" | Confirmed | decision equals accepted_decision in 70 of 70 files and .review equals review.json in 32 of 32; a finding is stored 11-12 times. accepted_decision is restart state; nothing reads decision. | C40 |
| "no idea what lane-repair-design.md is and if we added it? I know we have a repair command though" | Answered | An overnight design panel (23 Sep) whose recommendation shipped as `workflow repair` (26b5e83). The doc stayed in ~/dev/md-manager-reviews and was never named in the hand-off; the command ran once (skeleton-001); its phase 2 (repair --session) was not built. | C53 |
| "Four findings overlap. The reviewers had 3 that Claude missed, and Claude had about 20 that the reviewers didn't raise." (in your notes twice) | Confirmed | Accurate; one overlap is partial, and the log lists 5 items resolved during the run, not 6. | C41 |
| "Are these findings relecant and if we can create a special loop worker with correct prompt this could be very useful" | Answered | 13 of 14 diff-visible loop P3s were still in the code at b92ff7d, but mostly of low value; the useful extras were runtime signals, and running the code found what reading missed. Build staged signals and an exerciser, not a P3 reviewer. | C41, C44, C38 |

## Part 3. Reference: every change, with evidence

Each change is marked **Decided** (your 3 Oct grill answer settles what its status line names; its numbered steps are the audit's proposed way to build it), **Partly decided** (the status line names the decided part; the rest is proposed), **Proposed** (the audit's recommendation, waiting for you), **Not adopted** (C20) or **Act now** (C42, outside the workflow). Each heading ends with the change's priority (P0 most urgent, then P1 and P2; not a finding severity) and its effort (S small, M medium, L large). C1-C56 are the audit's changes; C57 is the Telegram channel from your answer to decision 2.

### Stage 1. Grill and decisions

### C1. The grill plays back how it read your words, then reads back everything that will bind, before any launch (P0, effort S)

**Status:** **Proposed.**

**What's wrong.** VEA's "Only return testnet addresses for chains" became a scope limit without a question: the grill ran in the session that had just drafted the PRD and the task, and it skipped what those drafts already "settle". The launch came before any summary, the decision summaries that followed left out provenance, the network map and the Deferred line, and the grill's hand-back (the decisions.md path and the `--dry-run` command) was skipped because you had asked up front to launch; kleros-v2's pre-launch summary also left out the Assumptions its challenge then flagged. During the grill the session rewrote policy.json's owned paths (and the matching line of the feature README) with sed, against the skill's own rule, and told you only after launch.

- `md-manager/workflow/skills/workflow-grill/SKILL.md`:16: "Drop anything the documents already settle"
- `ai-logs/sessions/claude/projects/-home-agentops-dev-kleros-vea/afa2430f-5cb0-4dfe-abe4-211eddeab50d.jsonl`:482 (10:25:27Z, after the 10:25:03Z launch): "testnet only. On current deployments that means Arbitrum Sepolia"
- `md-manager/workflow/skills/workflow-grill/SKILL.md`:55 (the VEA session narrowed policy.json's owned paths, and the matching README line, with sed at 10:23:06Z, afa2430f line 399, and disclosed it after launch): "Do not edit the tasks, the policy, the PRD or any code."

**Change.** Where: workflow/skills/workflow-grill/SKILL.md §1-§4; scaffold.py's README template (launch.placeholders already refuses TODO lines); `launch --dry-run`. What:

1. The README gets a TODO line for your verbatim request.
2. §1: the grill answers its own questions from the code first, then plays back each qualifier the drafts read as a limit (only, never, excluded): "You wrote X; I read it as Y, so Z is excluded. Correct?"
3. The last step, outside the five questions, is one AskUserQuestion (confirm or edit) quoting every Assumption or Deferred bullet written without a question, any rider a Recommended option added, and the verification plan, even when you asked up front to launch.
4. During the grill the session never edits tasks, policy or the PRD; it names the change and asks.
5. `launch --dry-run` prints decisions.md and the run's mode line.

**Trade-off.** 30-60 s more of your time and maybe one question slot; the playback covers only readings that exclude data or behaviour.

### C2. A Recommended option commits only to what its question asks (P0, effort S)

**Status:** **Proposed.**

**What's wrong.** Grill Q5 asked about ABIs, but its "Addresses only (Recommended)" option was described as "Addresses + provenance"; you accepted it in 34 s, and it produced the contract and network fields. Across the archived grills you took the Recommended option in 18 of 20 answers, and your question about Python and Rust consumers likewise became a published-JSON commitment without an answer.

- `ai-logs/sessions/claude/projects/-home-agentops-dev-kleros-vea/afa2430f-5cb0-4dfe-abe4-211eddeab50d.jsonl`:382 (AskUserQuestion, 10:22:11Z): `"label": "Addresses only (Recommended)", "description": "Addresses + provenance (contract name, network); ABIs deferred."`
- `ai-logs/runs/agent-workflows/vea/veashi-vea-addresses/veashi-vea-addresses-002/candidate/veashi-sdk/vea/testnet.json`:5: `"contract": "VeaInboxArbToGnosisTestnet",`

**Change.** Where: SKILL.md §2 (line 22) and §3. What: each option's description is the exact decisions.md bullet it writes, and options differ only on the dimension asked. A Recommended option may not add an interface, a data shape, a rule about another file or a scope change; such items become their own question, or an Assumption tagged [added, not asked] that C1's read-back shows you. Your answers are copied verbatim.

**Trade-off.** It may cost a question slot; it is aimed at interfaces, data shapes and scope, not trivia.

### C3. Offer the repository's own pattern as an option, and derive values the repository already records (P0, effort S)

**Status:** **Proposed.**

**What's wrong.** The VEA generator hardcodes chain ids (from the orchestrator's task draft) and a router table (challenge 001's alternative, made binding), while generate-types.sh derives routes from files. Grill Q2 offered only "Inside generate-types.sh", framed as untestable in a fresh worktree, or a standalone script; no option was a standalone script following the file-driven pattern. No stage asks for the repository's own approach, and a limit of the workflow run was presented as a product reason.

- `ai-logs/runs/agent-workflows/vea/veashi-vea-addresses/veashi-vea-addresses-002/candidate/veashi-contracts/script/generate-types.sh`:177: `const routes = fs.readdirSync(addrDir).filter(f => chainPairRegex.test(f)).sort();`
- `ai-logs/sessions/claude/projects/-home-agentops-dev-kleros-vea/afa2430f-5cb0-4dfe-abe4-211eddeab50d.jsonl`:372 (Q2 option "Inside generate-types.sh"): "but it only runs with a full forge build, so it can't be tested in a fresh worktree."

**Change.** Where: SKILL.md §1-§2; task Context (through C6); guardrails.challenge_prompt. What: §1 records the repository's existing generator for each kind of artifact (discovery, layout, registry), and §2 offers one option that follows it wherever the code lives, labelling any reason that exists only because of the workflow run with its product cost. Default "derive, don't copy": recorded values (chain ids, route lists) are read at run time, and a hand-kept table needs a stated reason. challenge_prompt compares the plan with mirroring the analogous mechanism and never proposes a hand-kept copy.

**Trade-off.** Longer option lists, and it may surface setup work (a forge build) instead of designing around it.

### C4. Split decisions.md by source: your decisions bind and are protected, assistant defaults stay open to challenge (P1, effort M)

**Status:** **Decided** (decision 8): only your answers bind; grill defaults and later additions stay open to the challenge.

**What's wrong.** decisions.md mixes your answers, grill defaults and later fixes (35 of 44 decisions files were written by the assistant), yet all of it binds and the challenge may not reopen it; VEA's network map, Devnet rule and router table were never your choices. Items were later rewritten in place (viewer-ux's "no fan-out"), and tasks restate decisions because reviewers can quote only the task.

- `md-manager/workflow/guardrails.py`:256-257 (challenge_prompt): "do not reopen what decisions.md settles unless you show it cannot hold"
- `ai-logs/runs/md-manager-workflows/viewer-ux-panels-lists/viewer-ux-panels-lists-003/plan.json`:decisions.text: `"No fan-out" means no per-run detail request`

**Change.** Where: SKILL.md §3; guardrails decisions_block, challenge_prompt, refusals and repin; RUNBOOK line 46; review_prompt and read_review_completion. What: decisions.md gets sections "## Operator decisions" (verbatim, with the question number), "## Grill defaults" and "## Changes after launch", each item with an id, plus a pinned grill-log.md of questions and answers. Operator decisions bind and only you change them (repin logs any change); workers follow grill defaults unless the code shows them wrong, but the challenge may reopen them (decision 8); your decisions win over the task. The challenge may reopen everything except operator decisions, and an operator decision that cannot hold is a P1. Tasks cite decision ids, and findings may quote decisions.md, checked verbatim.

**Trade-off.** More challenge concerns on defaults and one rewrite per feature; the tags are self-reported, hence the grill log.

### C5. Grill robustness: keep unanswered questions open, confirm free-text answers, test the skill, and record each feature's R32 cell (P2, effort S)

**Status:** **Partly decided.** For each feature that touches critical company code, the grill asks whether AI workers may write it or you write it and audit with AI (decision 9); step 4 records that answer with the feature's R32 cell, which also marks code critical for decision 3's approval stop. The rest is proposed.

**What's wrong.** An unanswered grill question (skeleton lanes) was dropped, "reduce the scale" was built two ways, a delegation meant for one item was applied to everything, and the skill's only test checks phrases. No feature records its R32 cell (the course roadmap's matrix of how critical code is against how hard its defects are to spot, ai-logs/roadmap/AI_ROADMAP.pdf p.31), so criticality is guessed: the assistant fixed ledger P2s at once as "exploit paths for real money", though the spec calls account rewards cosmetic, while an address SDK got the gates of a game slice.

- `ai-logs/sessions/claude/projects/-home-agentops-dev-md-manager/7579e0f3-92af-47b0-b407-1cfb21a9be7a.jsonl`:4688 (2026-09-24T08:14:02Z, the result of the lanes question asked at 08:13:56Z): "The user wants to clarify these questions."
- `ai-logs/runs/agent-workflows/project-B-econ/ledger-economy-fixes/ledger-economy-fixes-001/plan.json`:decisions.text: "Their P2s are exploit paths for real money, so they are fixed now"
- `ai-logs/source/project-B.bundle`:main:docs/spec.md:24: "Match power resets; account rewards are cosmetic"

**Change.** Where: SKILL.md; test_guardrails.py GrillSkill; `launch --dry-run`; the viewer and runs/index.md. What:

1. Unanswered questions become `TODO: Qn ...` lines, and launch refuses while any remain.
2. The grill restates each free-text answer in one sentence and records how far a delegation reaches.
3. Add 2-3 scripted grill scenarios with assertions on decisions.md.
4. Record each feature's R32 cell as a one-line label you confirm (in decisions.md or feature.json), together with your answer on whether AI workers may write its critical paths (decision 9), shown in the viewer and runs/index.md so the weekly review can match blocks to cells.
5. Add no per-lane blocking modes yet; a feature can already drop coverage from its reviewers.
6. `launch --dry-run` shows the finish=approval (C51) that a cell you confirmed critical pins (decision 3).

**Trade-off.** An occasional extra turn, and the tests need a scripted operator; the label is only as good as your confirmation, and you attended 2 of 38 project-B grills.

### Stage 2. Task authoring

### C6. Every acceptance item names its proof, checked by a warning-only launch lint that reaches every author (P1, effort M)

**Status:** **Proposed.**

**What's wrong.** 11 of 16 open P0/P1 review findings say a requirement has no test that could fail; about half the tasks already named the proof, but nothing checked it before freeze. Template edits reach no author: tasks in guarded runs (runs after the guardrails release) were written whole, never filled from the scaffold.

- `ai-logs/runs/agent-workflows/project-B/sea-compact/sea-compact-001/review-coverage.completion.json`:findings[0] (P1): "Required behaviour with no test: nothing checks the map-size ceiling."
- `ai-logs/sessions/claude/projects/-home-agentops-dev-project-B/0094b893-59da-46a6-a9fa-4f48e374f4db.jsonl`:1148 (2026-09-24T11:00:46Z): `workflow init duel-core >/dev/null && workflow init world-sea >/dev/null`

**Change.** Where: guardrails.brief_problems and the launch notes (`--dry-run`); a shipped workflow-author skill; prompts/reviewers/coverage.md. What: each Acceptance bullet ends `Proof: check <id> | test <file>::<name> | reviewer | self-report`. A warning-only lint lists bullets without proof, every self-report item, tasks that never name the PRD, and Context values or environment claims without a source. Wiring lanes may require a committed branch-to-test file (never "in your completion report", which is capped at 64 KB). coverage.md caps accepted reviewer or self-report proofs at P2.

**Trade-off.** Longer Acceptance sections, and the tags only bite with C34, because C20, which would have turned self-report items into pinned checks, is not adopted (decision 7); self-report stays legal, so tests are not forced.

### C7. User-facing tasks state how a user really drives the feature, each run leaves a cheap tryout, and your verdicts are recorded before the merge to main (P1, effort M)

**Status:** **Decided** (decision 10): each user-facing run leaves a "try this" card, and you record works, broken or skipped before the merge to main (step 3's try_it field and steps 4-5). Proposed: the Real use lines and realism file (steps 1-2), the Tryout dev-entry acceptance item (step 3), a broken result holding back new user-facing launches (step 6) and the playtest checkout rules (step 7).

**What's wrong.** All 8 player-facing escapes on project-B (defects found only after merge) came from conditions no test drove: held keys, short taps, key rollover, network gaps, approach angles and real data sizes; the dock task itself described the easy path. You found both escapes you hit within minutes of playing, while automatic runs approve themselves, the workers' playtest requests (6 of 38) reached no gate, and the dock lesson stayed in the orchestrator's private memory. A tryout (you using a finished feature by hand) cost a tunnel, two browser windows and a 35-minute match, the short-timings mode offered on 25 Sep was never set up, you could not find the screenshots every browser scenario saves, your hold report was folded into economy-online with a shop, crates and tonics, and the improvised playtest server listened on every network interface.

- `ai-logs/runs/agent-workflows/project-B-world/world-sea/world-sea-001/plan.json`:nodes.world.task: "Docking works with interact near a dock at low speed: it stops the ship and records the dock; any throttle undocks."
- `ai-logs/sessions/claude/projects/-home-agentops-dev-project-B/0094b893-59da-46a6-a9fa-4f48e374f4db.jsonl`:2046 (your message at 2026-09-24T13:53:21Z, 87 min after world-sea-fixes-001 was approved): "Nah the Dock feature is not working"
- `ai-logs/runs/agent-workflows/project-B/economy-online/economy-online-001/game.completion.json`:verify_yourself (no gate reads it): "In a real playtest over a jittery connection, hold E for a full 6 s collection and confirm it no longer resets"

**Change.** Where: guardrails.brief_problems and the task template; completion 1.2.0 (try_it); challenge_prompt and the reviewer briefs; integrate; a `workflow tryout` command; the viewer, runs/index.md and the morning summary; a repository realism file. What:

1. Lanes whose policy has a browser check need a "## Real use" section of 2-5 lines, drawn from the known-conditions block (C31) and a repository realism file (for example docs/testing-realism.md) listing each defect class found by hand. Each line names a condition a user creates and the test that drives it that way: keys held through an action, taps shorter than a step, input gaps of N ms through the impairment harness, real data sizes.
2. challenge_prompt and the reviewer briefs cite the realism file; challenge_prompt asks how the existing code handles each line's input sequence; coverage records a test that takes an easier path as a P2 row in its map (C34, decision 4).
3. Completions gain a try_it field for hands-on steps, and user-facing tasks get a "Tryout" acceptance item: a dev entry that puts you at the feature in under a minute (short timers, test unlocks, a scripted second player), kept out of production builds.
4. At integrate the controller writes the run's tryout entry: the Real use lines, 1-3 "try this" lines (from try_it, verify_yourself and carried defects), the new scenarios' screenshots, and up to 3 gameplay decisions the agent made, quoted from decisions.md. The digest (C43) groups untried entries into one card per build, shown when you write.
5. `workflow tryout <run> --result works|broken|skipped [--note "<text>"]` records your answer; a note asking to change one of the quoted gameplay decisions goes into the next feature's decisions.md. The viewer, the index and the morning summary mark untried runs, the merge rehearsal (C23) flags them, none merges to main before you record a verdict (decision 10), and C29 counts them.
6. A broken result opens a dedicated fix feature that runs before any new user-facing launch, instead of becoming an item inside the next feature.
7. Playtests run in their own checkout, bound to localhost, never in the checkout the merge suite uses, and the orchestrator tells you before stopping one.

**Trade-off.** A few lines per task, extra worker scope for the Tryout entry, and a few minutes of your time per playable feature, batched per build. Realistic tests are slower and timing-sensitive (sea-compact took 4 challenge attempts before docking was testable), and a test asserting the wrong outcome (the claim-hold reset) is caught only by trying the feature.

### Stage 3. Design challenge

### C8. Opt-in hold after a passing challenge, so you read every concern before workers start (P0, effort M)

**Status:** **Decided** (decision 1): an opt-in hold after a passing challenge.

**What's wrong.** Only P0/P1 concerns pause a run; a P2-only result launches workers in the same second, so the 256 P2s of 42 passing runs reached no person first, including VEA's hardcoded-network P2 that you would have approved. Every attempt had 2-8 P2s, so a P2 severity threshold would pause every attempt, and `start` runs the challenge and the launch as one step.

- `md-manager/workflow/guardrails.py`:50 (used by run_challenge at line 365): `BLOCKING = frozenset({"P0", "P1"})`
- `ai-logs/runs/agent-workflows/vea/veashi-vea-addresses/veashi-vea-addresses-001/events.jsonl`:sequences 2 and 3 (both 2026-09-28T10:26:49Z): "Design challenge attempt 1 passed (5 P2 concern(s)); launching workers"

**Change.** Where: launch and prepare (pin plan.holds.challenge from a flag or from a profile, the named run settings of C52); guardrails.challenge_gate and resume_main; launch.challenge_paused; status. What: an opt-in hold, separate from severity. After a passing attempt, `start` and `launch` exit 0 and print every concern, the alternative and the experiment verbatim (reuse paused_message). `resume --launch` launches on unchanged files; after edits it commits, re-pins and reruns, then launches unless a new P0/P1 appears. The schema and the P0/P1 pause stay unchanged. You chose this hold over running the challenge inside the grill session (decision 1). It applies to attended runs; unattended runs launch as today. If you are away from the desk during an attended run, the hold reaches you on Telegram (C57).

**Trade-off.** Held runs wait for you (about 6 concerns to read); under decision 2 the supervising session never releases a hold (before, it resolved pauses in a median 0.7 min), and C17's attribution with C55's restricted monitor makes that checkable.

### C9. In runs without the hold, give the passing challenge's concerns to the workers as advisory notes (P1, effort S)

**Status:** **Decided** (decision 11): concerns go to workers as advisory notes; reviewers stay blind.

**What's wrong.** No challenge content enters worker or reviewer prompts: 252 of 256 final P2s never reached a worker, and the rest arrived only by hand, through pane notes or decisions.md edits. In at least 3 of 13 blocked runs a P2 predicted the blocking P1, and match-online-001's challenge predicted the theft-window bug before any code existed; the worker's completion never mentions it, and the bug is on project-B main.

- `md-manager/workflow/interactive.py`:272 (worker_prompt): `plan["nodes"][node]["task"] + decisions_block(plan))`
- `ai-logs/runs/agent-workflows/project-B-intel/intel-core-fixes/intel-core-fixes-001/challenge.json`:concerns[1].consequence (P2, final attempt): "No named test catches this, so a reviewer will likely find it as the same bug in a new place."
- `ai-logs/runs/agent-workflows/project-B/match-online/match-online-001/challenge.json`:concerns[2] (P2 failure_mode; status passed): "a theft appears after the match ended, breaking 'outcomes freeze'"

**Change.** Where: interactive.worker_prompt (lines 267-275), with a challenge_block beside decisions_block. What: render the final challenge record into the worker prompt as numbered "Design challenge notes (advisory): say for each one done, or why not". Reviewers stay blind to it (decision 11). After C10, label each note with its action; turning worker_requirement items into acceptance lines would make them binding and visible to reviewers, which goes beyond decision 11 and needs your yes.

**Trade-off.** 1-1.5k tokens per worker; hedges such as "or at least" survive until C10 lands.

### C10. Challenge output says who must act: one recommendation per concern, decisions that pause, consequence classes, a scope trace and an acceptance-to-check map (P1, effort M)

**Status:** **Proposed.**

**What's wrong.** Severity answers two questions at once: whether the run may launch, and who must act. So VEA's concern #4 itself offered the fallback the worker took, 4 passing runs asked in prose for an operator decision and launched anyway, VEA-001's mandatory alternative became a binding router table, cheap_experiment ran 0 of 80 times, and only 24 of 47 P0/P1 cite a file:line. Replays show that samples agree on a concern's consequence but not its label, that the prompt's warning that a P1 pauses you pulls against its own P1 definition (one sample declined a concern because decisions.md settles it), and that none of 10 VEA-002 samples (5 Claude, 5 Codex) questioned the unrequested provenance fields.

- `ai-logs/runs/agent-workflows/vea/veashi-vea-addresses/veashi-vea-addresses-002/challenge.json`:concerns[3].message: "The generator could read that file, or at least check the hardcoded value against it."
- `ai-logs/runs/agent-workflows/project-B-kits/fruit-kits-core-fixes/fruit-kits-core-fixes-001/challenge.json`:cheap_experiment (status passed): "the operator must decide before any worker starts."
- `workflow-audit-evidence/gap-2-4/replay/df5/out/s5.stream.jsonl`:structured_output.concerns[3] (P2; a replay of docking-feel attempt 5, whose archived sample rated a related subject P1): "decisions.md settles '8 neighbours', so I'm not reopening the rule."

**Change.** Where: challenge.schema.json 1.1.0 (1.0.0 stays valid); guardrails.challenge_prompt and run_challenge; the export and the viewer. What:

1. Each concern gets an action (operator_decision, worker_requirement or note), one recommendation with one done-condition (alternatives become an operator_decision, never "or at least"), and evidence, required for P0/P1. An operator_decision pauses the run at any severity.
2. Each concern names a consequence class (wrong_result, reviewer_block_or_rework, cost_only or note), and the controller maps the class to the pause, so the prompt stops telling the judge what a P1 costs you. Test the mapping offline on the 47 archived and replayed samples first; a lighter version flags any P2 whose consequence predicts rework.
3. A reopens_decision list quotes each decisions.md line that a concern can be fixed only by changing; it pauses the run, attended or unattended, and reaches you through C57 when you are away; the supervising session never resolves it (decision 2).
4. A scope trace lists each decisions.md line that adds an output, field or behaviour, with the request or PRD line it derives from, or "none"; test it on 5 VEA-002 samples (about $2) before adopting it.
5. simpler_alternative gains recommended, resolves and adds_decisions; cheap_experiment gains an owner and a decision rule.
6. check_gaps: for each Acceptance item, the check that would fail, or "none" plus a proposal.

**Trade-off.** One coordinated contract change and more pauses (in unattended runs, more items wait for you); labels can still be wrong, and the offline test measures how often.

### C11. Refuse a challenge rerun on unchanged files, show reruns the earlier P0/P1s, and cap attempts (P1, effort S)

**Status:** **Proposed.**

**What's wrong.** resume reruns the challenge without checking that anything changed, so a paused P1 can be re-rolled away: docking-feel-001 attempt 6 ran on byte-identical files after attempt 5 had paused on a P1, and it passed; the fix then reached the worker as an unpinned "Operator addendum", and the reviewers still found a resting band beside the docks. Of 7 samples of that input, 2 paused on the dead zone, 3 rated it P2 and 2 left it out, and two tests treat the re-roll as intended, though the portable-workflow PRD says the challenge reruns only after an edit.

- `ai-logs/runs/agent-workflows/project-B/operator-logs/overnight-log.md`:49: "docking-feel attempt 6 started on UNCHANGED files: my edit script aborted on its last replacement before writing, and I resumed without checking."
- `md-manager/workflow/guardrails.py`:666-673 (resume_challenge; digests are compared only on the --accept-challenge path): `attempt = max(current["attempt"] if current else 0, read_json(running)["attempt"] if running.exists() else 0) + 1`
- `md-manager/docs/PRD_PORTABLE_WORKFLOW.md`:226: "it runs once per run, and again only on `resume` after an edit"

**Change.** Where: guardrails.resume_challenge (666-673), refuse_unused_edits (612-625) and challenge_prompt; test_guardrails.py. What:

1. Refuse a rerun when nothing changed since the paused attempt, reusing refuse_unused_edits' detection (dirty pinned paths, changed pins, pending revision commits); the message names the attempt and the unchanged files and asks for an edit or `--accept-challenge "<reason>"`.
2. Do not refuse while a revision intent or revision commits are pending, or after a crashed or timed-out attempt.
3. Rewrite the two tests that expect the re-roll (test_guardrails.py lines 449-456 and 605-610).
4. From attempt 2 on, list the earlier P0/P1s and ask which are resolved and what is new; cap attempts (for example at 3), then escalate to you.
5. Offer no "second opinion" rerun: under a pause-if-either rule it can never unpause the run, and it invites accepting a P1 that the next sample happened to omit.

**Trade-off.** 1-2k tokens per rerun, and earlier concerns may anchor it; overnight, a refusal waits for your edit or recorded reason, which reach you through C57; the supervising session may not edit the plan or pass `--accept-challenge` (decision 2).

### C12. Let the challenge read the code it judges: restored snapshots and installed dependencies (P1, effort M)

**Status:** **Proposed.**

**What's wrong.** In 11 of 44 challenged runs the worker restores an earlier snapshot, but the challenge reads the base commit, so it judged fixes without the code (25 of its 27 refused tool calls tried to reach it). With no dependencies installed, skeleton-fixes' Colyseus P1 was half wrong.

- `md-manager/workflow/guardrails.py`:295 (challenge_worktree's docstring): "A detached checkout at the base commit"
- `ai-logs/sessions/claude/projects/-home-agentops-dev-project-B/0094b893-59da-46a6-a9fa-4f48e374f4db.jsonl`:838 (2026-09-24T09:46:31Z): "The code-leak half is wrong for this version."

**Change.** Where: guardrails.challenge_worktree, run_challenge. What: check out the restored snapshot in the challenge worktree (or add it read-only with --add-dir) and run setup there alongside the lane setup (C15); or require a file citation for P0/P1 claims about libraries (C10).

**Trade-off.** 25-90 s of setup unless overlapped, and one more checkout until C47 lands.

### C13. Measure first, then take a second challenge sample in unattended runs when the first one passes (P2, effort M)

**Status:** **Proposed.**

**What's wrong.** One sample decides the pause, and on identical inputs that decision is unstable: 4 project-B inputs that had paused in the archive paused in 2 of 7, 3 of 5, 4 of 5 and 4 of 5 of their samples (the archived ones plus the replays), and one sample's pause decision disagreed with another's in 24 of 51 pairs. Discovery is steadier than severity (subjects any sample rated P1 were mentioned in 47 of 57 subject-samples but rated P1 in 23), and the docking-feel attempt that launched workers was a sample that left out the dead zone. All 4 inputs were chosen because they paused and only 2 of the 42 passing attempts were resampled, so the cost in extra pauses is unmeasured.

- `ai-logs/runs/agent-workflows/project-B/docking-feel/docking-feel-001/challenge-5.json`:concerns[0] (P1; its pinned digests equal attempt 6's, which passed): "The adjacent-berth rule plus the spur removal leaves a dead zone of the same kind on the EAST side of the real south docks."
- `workflow-audit-evidence/gap-2-4/replay/tally.json`:challenge.df5.paused (2 archived and 5 replayed samples of one input): `"paused": [1, 0, 0, 0, 0, 1, 0]`

**Change.** Where: guardrails.run_challenge (lines 316-378), save_challenge, challenge.schema.json; the export and the viewer; a replay measurement first (C39). What:

1. Measure first: replay the final passing attempts of the 4 longest chains plus 2-3 attempt-1 passes, 5 samples each (about $35), and rerun two inputs whose verdict flipped at a higher effort (about $15 to $25). If higher effort narrows the P1/P2 split, pin it through C52 instead.
2. Otherwise, in unattended runs only, take a second sample when the first passes and pause if it has a P0/P1; attended runs rely on C8's hold.
3. Merge both concern lists into what C9 forwards: a subject one sample omits about 18% of the time is omitted by two independent samples about 3% of the time.
4. Store both records per attempt, and cap attempts (C11).

**Trade-off.** About $1 and 3 min on the roughly half of attempts that pass, more overnight pauses (which wait for your answer on Telegram, C57; the supervising session never resolves them, decision 2), and changes to the schema, the strict viewer contract and tests. Agreement between two runs rises mostly because the rule pauses more, so agreement alone cannot show the gate is more correct.

### Stage 4. Workers and self-verification

### C14. Run workers and the verifier without your credentials: a Bash sandbox, read-deny rules and a recorded opt-out (P0, effort M)

**Status:** **Decided** (decision 5): Claude Code's Bash sandbox with read-deny rules and a host allowlist, for workers and the verifier, after the VPS probe. Proposed: the `--authority account` opt-out (step 5; usable only with --by operator) and adding C57's bot token to the read-deny list.

**What's wrong.** 54 of 55 runs ran workers as your account with Bash and bypassPermissions (automatic mode accepts nothing lower), so every worker could read a repo-scoped gh token, an SSH key without a passphrase, Pi's OAuth tokens, a DeepSeek key in ~/.bashrc, transcripts holding secrets and a funded mainnet deployer wallet. Only two prompt sentences stand against pushing while the --bg system prompt tells workers to commit and push (68 of 70 lane sessions), and the verifier runs worker-written tests and install scripts with the controller's environment. No worker misused this, but when an SSH push was denied the orchestrator switched to the gh token within 14 s.

- `md-manager/workflow/automatic.py`:53-54 (validate_automatic, when permission_mode != bypassPermissions): `raise ValueError("Unsupported automatic authority")`
- `ai-logs/sessions/pi/sessions/--home-agentops-.pi-agent--/2026-09-17T15-03-26-671Z_01a0afe4-dccd-7338-bd1c-653f3f57376c.jsonl`:402 (2026-09-18T07:36:29Z, followed by 14 forge script --broadcast runs against Arbitrum One and Arc mainnet): "DEPLOYER_KEY is the funded VPS wallet at"
- `ai-logs/sessions/claude/projects/-home-agentops--local-state-agent-workflows-vea-veashi-vea-addresses-veashi-vea-addresses-002-worktree-main/7a188e20-73e0-445f-9748-7ce581b65019.jsonl`:17 (prompt_snapshot, "# Background Session", 2026-09-28T10:34:26Z): "commit before finishing — you don't need to ask — and push if the repository has a remote"

**Change.** Where: sessions.background_settings (a worker variant of the --settings every --bg session gets); interactive.InteractiveSessions.run; automatic.validate_automatic; read_signal; checks.verify_revision; preflight; plan.json and report.html; workflow/README.md line 3. What:

1. One worker profile for every repository, passed through --settings: sandbox.enabled with failIfUnavailable on and allowUnsandboxedCommands off; filesystem.denyRead for ~/.ssh, ~/.config/gh, ~/.git-credentials, ~/.pi, ~/.claude/projects, ~/.config/vps-wallet.env and the other ~/dev checkouts; writes only to the worktree, the per-run caches and a per-lane completion inbox that read_signal reads (today workers write completions with Bash mv); network.strictAllowlist for the policy's registry hosts; HUSKY=0 and GIT_TERMINAL_PROMPT=0.
2. --disallowedTools Read and Edit rules for the same paths.
3. The verifier runs its commands under the same profile; as a first step it drops secret-like environment names now and logs which ones.
4. Preflight refuses when bwrap or socat is missing, when the CLI rejects the keys, or when a remote has a pushurl or pushInsteadOf entry.
5. Pin the profile digest in plan.json and report.html, and record `--authority account` as an explicit opt-out.
6. Accept a completion only if the lane's own transcript shows the write, because prompts and tokens show in ps.
7. Reword README line 3 and add a "What a worker can reach" paragraph.
8. Meanwhile, replace the gh token (repo, gist, read:org) with a fine-grained one.

**Trade-off.** It needs a VPS probe first (bwrap and socat present, --settings honoured under --safe-mode, Playwright's Chromium running inside bwrap) and a registry allowlist to maintain (kleros-v2 codegen needs network). A separate user or container comes later and first needs per-run clones (C56).

### C15. Workers start with setup done, and every session gets the target's CLAUDE.md conventions in its prompt (P1, effort S)

**Status:** **Decided** (decision 6): the base commit's CLAUDE.md, up to the operator-notes heading, pinned into worker, challenge and reviewer prompts; --safe-mode stays (steps 2 and 4). Proposed: running setup before workers start (step 1), the size-cap refusal (step 3), dropping repository rules from task Context (step 5) and the Hazards section (step 6).

**What's wrong.** Every workflow session starts with --safe-mode, which disables CLAUDE.md: 0 of 199 run sessions loaded it while orchestrator sessions in the same repos did, and a canary probe with the workflow's flags confirmed it, yet workflow/README.md:31, the init starter file and the portable PRD say workers read it. So VEA's description of its file-driven SDK flow and the VEA and kleros-v2 Boundaries reached none of their 10 sessions, orchestrators copied rules into each task by hand, and follow-up runs suffer most (22 of 23 first-run project-B workers opened CLAUDE.md on their own, only 4 of 15 follow-up workers did). Separately, all 42 guarded workers ran setup themselves, and VEA's task wrongly said it had already run.

- `workflow-audit-evidence/gap-1-5/claude-md-reach.txt`:1 (claude_md_reach.py over the archive): "agent-workflows run sessions: 199; with an 'instructions' attachment: 0; CLI versions ['2.1.281', '2.1.282', '2.1.283']"
- `workflow-audit-evidence/gap-1-5/probe-results.txt`:result A (probe_safe_mode.sh, CLI 2.1.287; control B, without --safe-mode, returned the canary): "A. --safe-mode (workflow flags): NONE"
- `md-manager/workflow/README.md`:31 (the same claim is in scaffold.py:71 and docs/PRD_PORTABLE_WORKFLOW.md:30): "Worker sessions start in worktrees of it and read its `CLAUDE.md`"

**Change.** Where: sessions.prepare and start; guardrails.py (a conventions_block beside decisions_block); interactive.worker_prompt, automatic.review_prompt, guardrails.challenge_prompt; README.md:31, scaffold.STARTER_CLAUDE, PRD_PORTABLE_WORKFLOW.md:30; test_guardrails.py; each target's CLAUDE.md. What:

1. Run the policy setup in each lane worktree in parallel with the challenge and state the result in the worker prompt; tasks stop making claims about the environment.
2. Keep --safe-mode and add conventions_block(plan): `git show <base_commit>:CLAUDE.md` up to the heading "## Workflow (operator notes; workers skip this section)", which all three target repositories use, so workers do not get operator notes such as project-B's "Workers run targeted tests only". It goes before decisions_block for workers, the challenge and reviewers, under the heading `Project conventions (CLAUDE.md at <base>; the task and decisions.md take precedence)`.
3. Prepare refuses a CLAUDE.md over a size cap (for example 32 KB): native prompts travel as one argv string, and Linux limits a single argument to 128 KiB.
4. Correct the three docs now, add a marker test per role and a live probe (C54), and leave out the unreachable ClaudeSessions.run.
5. Then drop repository rules from task Context, and have `launch --dry-run` print the conventions source and size.
6. Each repository's CLAUDE.md gets a "Hazards" section above that heading with stable hazard classes; for VEA, the chain map, the rule that a block number from one chain means nothing on another, and how a blind claimer or challenger escalates. Per-audit leads stay out of it (C36).

**Trade-off.** About 1k extra tokens per session, at most about 4k for VEA's 15 KB file; a repository without the operator-notes heading sends its whole file, and nested CLAUDE.md files are not covered.

### C16. Completion rules: an untestable or reinterpreted requirement becomes a question, the controller states the deadline, and the Stop-line bug is fixed (P1, effort S)

**Status:** **Proposed.**

**What's wrong.** In at least 4 of 13 blocked runs the blocking P1 was a gap or reinterpretation the worker had already declared (one began a 5-run, $27 intel chain), and in 3 of the 5 real defects behind project-B blocks the worker had named its reading in verify_yourself, which no gate reads. No worker used status question, 39 of 42 falsifying_checks are bare check ids, and workers never learn their deadline. All 43 guarded prompts also repeat the approved-checks block inside the Stop line, because stop_rule parses the pinned task.

- `ai-logs/runs/agent-workflows/project-B/duel-online/duel-online-001/duel.completion.json`:untested[1] (coverage's P1 was "The dev latency setting's actual behaviour has no test."): "The dev latency setting end to end: only its query parsing is unit-tested"
- `ai-logs/runs/agent-workflows/project-B-intel/intel-core/intel-core-001/intel.completion.json`:verify_yourself (the coverage P1 later blocked on this behaviour): "That allowing up to one pending sighting per type (rather than strictly one per player) is an acceptable reading of 'at most one pending per player'"
- `ai-logs/runs/agent-workflows/vea/veashi-vea-addresses/veashi-vea-addresses-002/main.prompt.txt`:84: "Report `question` only for a choice that would change this acceptance. Approved ownership and checks:"

**Change.** Where: automatic.completion_prompt and read_signal; guardrails.stop_rule; interactive.worker_prompt; scaffold.py's Acceptance template. What:

1. A required behaviour the worker could not test, or reads differently, becomes a status question naming the task line, asked before freeze; never an untested item, a verify_yourself entry or an open assumption.
2. Untested items quote their task line or say "not required", and read_signal refuses "completed" when an untested item quotes the task.
3. Coverage's four gap categories become a worker self-check.
4. falsifying_check becomes `<check id>: <test> > <title>`.
5. verify_yourself is kept for checks only a person can run; hands-on steps go to try_it (C7).
6. The controller states the deadline and the generic Stop bounds in UTC.
7. stop_rule uses `text.partition(APPROVED)[0]`.
8. The scaffold's Acceptance template gets one default line: run targeted tests while iterating and every policy check once at the end (a proposal; see Part 1).

**Trade-off.** More paused lanes (at most 3 questions each; the completion prompt's "after the third, decide yourself and record an open assumption" becomes a blocked lane naming the task line, so no requirement is decided without you), and it needs C18 so that questions are seen; while you are away, questions reach you through C57 and the lane waits for your answer (decision 2).

### C17. A recorded `workflow note` for mid-run instructions, two named roles, and a required actor on every gate action (P1, effort M)

**Status:** **Partly decided.** An actor on every gate action (--by) is part of C57 (decision 2), and a recorded note that routes a triage P0/P1 to a lane is part of C41 (decision 12); the general `workflow note` command for other instructions is proposed.

**What's wrong.** The orchestrator typed 10 messages into worker and reviewer panes under your name: eight were "file is final" nudges or a time check (C18 removes those), and the docking-feel addendum told a worker a rule was "adopted by the operator" while you slept. Neither that addendum nor VEA-002's "Operator note" is in the run, so reviewers could only flag "unverifiable provenance", and the workers' completions repeat the label. Prompts call whoever answers "the operator", the controller writes "by the operator" whoever runs resume or repair, and the environment cannot tell who typed a command: the agent ran all 33 resumes and 28 launches through `herdr pane run`.

- `ai-logs/sessions/claude/projects/-home-agentops-dev-kleros-vea/afa2430f-5cb0-4dfe-abe4-211eddeab50d.jsonl`:621 (10:35:01Z, herdr pane send-text): "Operator note (design challenge of this run, 4 P2s; apply them, they refine decisions.md)"
- `ai-logs/sessions/claude/projects/-home-agentops-dev-project-B/a169f327-9a20-48cb-95e2-5a97878b97d9.jsonl`:2104 (2026-09-24T22:06:26Z, herdr pane send-text; overnight-log.md line 3 reads "20:00 The operator is asleep."): "Operator addendum, from design challenge attempt 5, adopted by the operator. It is binding and part of this task."

**Change.** Where: guardrails (a note command on a deliver_text helper split from deliver_answer at line 886, and the "accepted by the operator" event at line 664); review_prompt, with a notes_note() beside repair_note(); repair.py lines 83 and 442; the prompts that name "the operator" (automatic.py line 78, guardrails.py line 255). What:

1. `workflow note <run> <lane> --from operator|maintainer` stores `<lane>.notes.json` (author, delegation, text, sent_at), emits an event, and types into the pane through deliver_answer's guarded path, refusing while a question waits. review_prompt lists the notes beside repair_note(), because review-bundle.json cannot change once the candidate exists, and a note that changes a decision quotes the line it amends.
2. Every gate action (resume, retry, answer, accept, override, repair, approve, abandon) requires `--by operator|maintainer`, written into the event message, with no default; `--by maintainer` is accepted only for mechanical recovery (resume after a crash, retry, relaunch; decision 2).
3. Prompts and pane text name two roles, the maintainer (the agent) and the operator (you), and pane text never starts with "Operator:" unless you typed it.

**Trade-off.** It refactors answer delivery, and --by is cooperative, not access control; a note labelled as the agent's can make a worker discount a change you did delegate, which the delegation field covers.

### C18. Accept finished sessions that the registry still lists as "working" or "blocked" (P1, effort S)

**Status:** **Proposed.**

**What's wrong.** Completions are read only in some native states: finished workers stuck at "status idle, state working" stalled 3 runs, and finished reviewers in "blocked" waited for pane nudges (7 manual nudges). A fix that accepts status idle (f3be881) has sat unmerged on a branch since 22 Sep.

- `md-manager/workflow/automatic.py`:230 (wait_handoffs): `item = read_signal(runtime, node) if row["state"] in {"idle", "done", "blocked"} and path.exists() else None`
- `ai-logs/runs/agent-workflows/project-B/operator-logs/overnight-log.md`:22: "were listed by `claude agents --json` as status idle but state working, so the controller kept waiting."

**Change.** Where: automatic.wait_handoffs (lines 230 and 232) and wait_reviews (line 557). What: add helpers turn_over(row) (state idle or done, or status idle, like f3be881's session_idle) and busy(row), and use them at those lines; accept a file whose hash is stable across two polls 60 s apart, and a bound reviewer verdict in "blocked"; log the stale state. Probe the current CLI first, since nobody re-tested whether the stale state still occurs. Also close the open audit items R3 (accept a completion from an exited session) and R5 (launch a reviewer that has no receipt).

**Trade-off.** The stable-hash rule avoids reading half-written files; question files keep the strict rule.

### C19. Deny pattern kills and pushes for workers as hygiene, and leave the live-chain boundary to C14 (P2, effort S)

**Status:** **Proposed.**

**What's wrong.** On 24 Sep a worker's `pkill -f "vite"` also matched vitest and killed another run's verifier; no rule existed yet (it reached CLAUDE.md at 17:13), and once the sentence went into every task, none of the 29 later project-B workers ran a pattern kill. The company repositories lack that channel: their Boundaries (never run live-chain scripts, never push, never stop processes by name pattern) reach no session and none of the 3 Kleros tasks carries them, while all 3 Kleros runs were automatic with bypassPermissions and one ran under a /loop while you slept. A probe with the workers' flags shows a `Bash(pkill:*)` deny rule refuses even a compound command, but prefix rules cannot cover VEA's deploy-route.sh or the bots' start scripts.

- `ai-logs/sessions/claude/projects/-home-agentops--local-state-agent-workflows-project-B-duel-online-duel-online-001-worktree-duel/303edfe3-b87f-40f5-8367-a91217cc941f.jsonl`:1071 (15:27:06Z; objectives-ledger-001 events.jsonl seq 9 at 15:27:50Z records "integration: exit -15"): `pkill -f "vite" ; pkill -f "src/dev.ts"`
- `workflow-audit-evidence/gap-1-5-critic/deny-probe/probe-deny3-results.txt`:probe C (CLI 2.1.287, the workers' flags, deny rule `Bash(pkill:*)`): "Permission to use Bash with command echo start && pkill -0 -x zzzz-none-proc; echo rc=$? has been denied."

**Change.** Where: policy.json (an optional denied_commands list); interactive.InteractiveSessions.run; pipeline preflight required_flags. What:

1. An optional policy `denied_commands` list, pinned with the policy and shown in the viewer, passed as --disallowedTools placed before --permission-mode (otherwise the variadic flag swallows the prompt).
2. Seed it as hygiene and ship it with C15: `Bash(git push:*)`, `Bash(pkill:*)`, `Bash(killall:*)`.
3. Do not present it as the live-chain guard; that boundary belongs to C14's network allowlist and wallet read-deny, or to moving the deployer key out of the agent user's reach before any unattended company-repo run (C22).
4. Preflight requires --disallowedTools when the list is set, and C54 probes it through --bg.
5. Keep a scan of executed commands only as a post-freeze audit line in events.jsonl.

**Trade-off.** A guard, not a sandbox: `kill $(pgrep -f x)` or `sh -c` gets past prefix rules, and scripts that call forge themselves are not matched; one list per repository, not yet probed under --bg.

### Stage 5. Checks and gates

### C20. When you decline tests, each self-reported acceptance item becomes a pinned policy check before launch (P1, effort S)

**Status:** **Not adopted** (decision 7): you chose worker self-report when tests are declined. The evidence stays here for the record; C35 (proposed) would have reviewers read worker claims as unverified.

**What's wrong.** VEA's "no tests" left two checks: typecheck (with an empty log) and vea-data-fresh, which proves the committed JSON equals the generator's output but checks no address and, as kind build, did not gate the worker phase. The worker's own check printed MISMATCH without failing, the undefined routes were never asserted, the orchestrator's later assertions live only in its transcript, and the general reviewer rated the generator's silent drops P2. An independent address verifier (prepare-env, built on 22 Sep) already existed in the vea repository and had caught a stale deployment record.

- `ai-logs/runs/agent-workflows/vea/veashi-vea-addresses/veashi-vea-addresses-002/review-coverage.completion.json`:findings[0]: "The undefined-route behaviour is only printed, never checked."
- `ai-logs/sessions/claude/projects/-home-agentops-dev-kleros-vea/128fa457-f239-4e57-ad8e-89ea027466ce.jsonl`:670 (2026-09-22T22:06:56Z, the prepare-env verifier built that day): "The deployed Yaru reports Hashi `0x78E4ae687De18B3B71Ccd0e8a3A76Fed49a02A02`"

**Change.** Where: the grill hand-back (C1); task authoring; the feature's policy.json; C10's check_gaps; vea's veashi-contracts/script/prepare-env. What:

1. When tests are declined, the author or the grill writes one approved policy check per self-reported acceptance item, before launch, and the check gates the candidate. Worker-chosen commands never count as evidence, and sandbox checks stay disclosure.
2. For VEA, a "vea-getters" check builds, compares the five getters with the deployment files, asserts the undefined routes, and exits 1 on any mismatch.
3. It checks each generated route against the deploy-time references the deployment files already hold, not against file-name pairing: the inbox's constructor args name the router, the router's name the inbox and the outbox, the outbox's name the router and the chain id, and each network's .chainId gives its id.
4. Extend the existing prepare-env verifier to Vea routes instead of writing a second reader; it already checks Hashi addresses against official registries and on-chain state.
5. A missing check stays a launch warning, and launch refuses only in cells you confirmed critical (C5). Default veashi-sdk to not critical while it exports testnet routes only, and reassess at its first mainnet address.

**Trade-off.** A small script and some authoring per feature (a check script, not a test framework); checks against chain state need RPC access inside the verifier.

### C21. Test validator-cli from its entry point with chains that disagree, and check the dev line's arbToGnosis claimer now (P1, effort M)

**Status:** **Proposed.** Step 1 is in "Act now".

**What's wrong.** No test exercises the arbToGnosis split between the router and outbox providers, where the P0 lives; at least four reviews and one fix writer described the claimer path wrongly, and the fix-1 test injected providers below watcher.ts, so it could not fail on the real wiring. The claimer half of the bug predates your branch, and a static read of the 28 Sep vea checkout (cut from dev) shows that wiring still in place: the challenger gets veaRouterProvider, checkAndClaimParams does not, and claimer.ts falls back to the outbox provider. The 16 Sep rerun judged this blocking for arbToGnosis claims; nobody has executed it.

- `ai-logs/runs/agent-workflows/vea/veashi-vea-addresses/veashi-vea-addresses-002/worktree-main/validator-cli/src/watcher.ts`:238-250 (no veaRouterProvider; line 230 passes it to the challenger): `const checkAndClaimParams: CheckAndClaimParams = {`
- `ai-logs/runs/agent-workflows/vea/veashi-vea-addresses/veashi-vea-addresses-002/worktree-main/validator-cli/src/helpers/claimer.ts`:77: `const queryRpc = veaRouterProvider ?? veaOutboxProvider;`

**Change.** Where: the vea repository (validator-cli tests or a provider wrapper); vea-validator2's scripts/full-devnet.sh; the policy checks of vea features. What:

1. Add a validator-cli test that enters at watcher.ts with per-chain providers that disagree on chain id and block height, so any read on the wrong chain fails; or wrap each provider to assert the contract's chain on every blockTag. Run it on dev now, before any arbToGnosis release.
2. Make it a policy check for every validator-cli feature; that moves this bug class from hard to easy to identify, which R32 names as a reason to reassess the cell.
3. For what the test does not cover, run validator-cli and vea-validator2 side by side on a two-chain devnet (vea-validator2 ships scripts/full-devnet.sh) and compare their claims and challenges: R32's redundancy oracle.
4. Make the test the first acceptance item for the seven unmerged 16 Sep validator-cli fix branches, and decide on them after one combined audit on dev (C36) rather than merging them as they are: fix-1 and fix-2 both edit watcher.ts:240 and were never reviewed together.

**Trade-off.** Hand work in critical code wherever you choose it at the grill (decision 9), and a devnet comparison needs both validators and a scripted scenario; that the harness would have caught the audit's F1, F2 and threading defect is inferred, not executed.

### C22. Only you broadcast mainnet transactions; agents prepare a decoded plan that a second reader checks (P1, effort S)

**Status:** **Proposed.**

**What's wrong.** On 17 Sep you asked for "the same flow where claude does and a tester verifies it" for the Hashi route deployments, and the first board text kept broadcasts human-gated, but an agent's rewrite dropped that line. On 18 Sep the DeepSeek orchestrator in Pi ran the 11 deploy scripts per route with --broadcast itself, for three routes on Arc, Arbitrum and Ethereum mainnet, then sent live messages; its own checks caught a missing Axelar gateway, but no second reader saw the peers, the DVN addresses and their order, the thresholds or the funding before broadcast. The deployer key sat in veashi-contracts/.env, readable by any agent running as your user.

- `ai-logs/sessions/pi/sessions/--home-agentops-.pi-agent--/2026-09-17T15-03-26-671Z_01a0afe4-dccd-7338-bd1c-653f3f57376c.jsonl`:6 (2026-09-17T15:38:33Z, you): "Lets add a new task we want the same flow where claude does and a tester verifies it."
- `ai-logs/sessions/pi/sessions/--home-agentops-.pi-agent--/2026-09-17T15-03-26-671Z_01a0afe4-dccd-7338-bd1c-653f3f57376c.jsonl`:66 (15:44:25Z, the first c1 board text; the 16:01 rewrite at line 168 dropped it): "The actual mainnet broadcast + key handling is HUMAN-GATED"

**Change.** Where: where the deployer key is stored (a separate OS user or a hardware wallet); C14's read-deny rules, extended to Pi sessions; a broadcast wrapper in veashi-contracts. What:

1. Move the funded key out of every agent's reach, to a separate OS user or a hardware wallet, and extend C14's read-deny rule to Pi sessions.
2. Agents run the forge scripts without --broadcast and hand over the dry-run transaction list with a decoded summary.
3. A second reader checks the peers, the DVN sets and their order, the thresholds and the chain ids against independent sources, such as the official registries prepare-env already reads.
4. You broadcast through a wrapper that refuses unless the digest of the reviewed plan matches.

**Trade-off.** Minutes per deployment, and you must be present for every broadcast; deployments are rare (the archive has one such task).

### C23. Check each approved run against current main before it lands, and catch overlapping ownership across parallel runs at launch (P1, effort M)

**Status:** **Proposed.**

**What's wrong.** 18 of 38 project-B runs had their own base and merges into main happened outside the workflow; 4 of 21 merges were resolved by hand, all in package.json exports and smoke-build.ts, which parallel runs owned at the same time (24 of 38 project-B policies own both package.json files) despite the CLAUDE.md rule that parallel features own disjoint paths. One approved run's merge was committed before its checks ran, leaving main red for 4 min, and one feature dropped its browser check because another run held the fixed ports. Ownership is checked only within a run, and nothing gates the merge to main.

- `ai-logs/source/project-B.bundle`:main:CLAUDE.md:24: "Parallel features must own disjoint paths so their branches merge into `main` without conflicts."
- `ai-logs/runs/agent-workflows/project-B/operator-logs/overnight-log.md`:101: "A semantic merge conflict: two intel sector tests hard-coded the old 224 × 208 map"

**Change.** Where: launch and preflight (the registry's runs_roots); a `workflow rehearse` command or candidate-phase option reusing Pipeline.candidate and verify_revision; C28's ports; project-B's package exports. What:

1. At launch, compare the lane's owned paths with every run on the same repository that has not integrated yet and warn or refuse; you then name an owner, run the features one after another, or switch to wildcard subpath exports.
2. Before an approved run lands, `workflow rehearse <run> --onto main` merges the candidate with the current target head in a detached verification worktree, runs the policy checks, and records target_head, the merge tree and the packet.
3. You make the real merge, or the orchestrator does on your decision (through C57 while you are away, decision 2), and a user-facing run merges only after its tryout record (decision 10); the main ledger (C45) flags a merge whose tree differs from the rehearsed one.
4. In single-lane runs the rehearsal replaces the redundant candidate re-check (C28), and browser checks stay in parallel runs' policies through per-run ports (C28).

**Trade-off.** One rehearsal per run (candidate phases took 1-13 min, median 4.2) with its own checkout and ports, because the main suite's npm ci crashed the playtest server twice; conflict resolution stays manual.

### C24. Fix three controller defects only Codex found: non-ASCII freeze paths, incomplete bundles, and cached packets of the wrong phase (P1, effort S)

**Status:** **Proposed.**

**What's wrong.** Three defects Codex reported on 23 Sep are unchanged on every branch, and no test covers them. Freeze splits diff-tree output on newlines while git quotes non-ASCII names there, so an owned path such as docs/café.md fails freeze, which automatic mode treats as final after all the worker spend (repair.py already uses -z, so the two snapshot paths disagree). validate_bundle accepts a bundle with `packets: []`, and verify_revision reuses a cached packet without checking its phase: a request for a candidate packet returned a passed worker packet despite a build exit code of 1.

- `md-manager/workflow/pipeline.py`:454 (freeze snapshot; repair.changed_paths at repair.py:267 passes -z): `captured = git(cwd, "diff-tree", "--no-commit-id", "--no-renames", "--name-only", "-r", self.plan["base_commit"], tree).splitlines()`
- `workflow-audit-evidence/gap-1-4/unicode-probe-output.txt` (diff-tree output as pipeline.py:454 reads it): `"docs/caf\303\251.md"`

**Change.** Where: pipeline.py freeze (line 454) and Pipeline.validate_bundle (line 587); checks.verify_revision (line 286); pipeline preflight; test_pipeline.py and test_verification.py. What:

1. First, run diff-tree with -z through subprocess.check_output, as repair.py does (sessions.git's strip would trim names), and test docs/café.md and a name containing a double quote.
2. Then, as one hygiene change: require exactly one worker packet and one candidate packet per selected lane, each with matching phase, node and commit; require the bundle's base_commit to equal the plan's; compare a cached packet's stored phase, node and attempt before reuse; and test both checks against lane repairs and failure-drill bundles.
3. Until per-run clones exist (C56), preflight refuses a launch when the checkout's HEAD is the branch of another registered run that has neither integrated nor blocked.

**Trade-off.** The bundle and packet checks catch accidental mix-ups, not forgery, because checks run as the same user; the preflight refusal stops parallel launches on one checkout, which separate clones already avoid.

### C25. One git helper for every controller call: hooks, fsmonitor and diff drivers off, and a refusal when a lane has changed the shared .git (P1, effort S)

**Status:** **Proposed.**

**What's wrong.** Lane worktrees share your .git, so the controller's own git calls run whatever a lane plants there: a hook on each `git worktree add` (6 call sites), a core.fsmonitor command on each `git status` (20 checks), filter drivers on freeze's `git add -A` and on checkouts, and diff.external on review.diff. One "-diff" line in info/attributes turns a text change into a binary patch in review.diff, where reviewers start, and info/exclude hides files from every cleanliness check; the 23 Sep safety reviewer flagged the hook and exclude paths, and both are still open. A plain husky install already flipped kleros-v2's shared hooksPath and broke your commits.

- `md-manager/workflow/worktrees.py`:56 (git_worktree; callers sessions.py:201, guardrails.py:307, checks.py:293, pipeline.py:543, automatic.py:593, repair.py:536): `command = ["git", "-C", str(repository), "worktree", *arguments]`
- `workflow-audit-evidence/gap-1-2-critic/vectors.log`:case G (one "-diff" line in the shared info/attributes, no config change): "GIT binary patch literal 8"

**Change.** Where: sessions.git, worktrees.git_worktree and the direct git calls in pipeline.py, guardrails.py, repair.py, automatic.py and checks.py; the review.diff writers (automatic.py:596, sessions.py:460, repair.py:405). What:

1. Route every controller git call through one helper that passes `-c core.hooksPath=/dev/null -c core.fsmonitor=false`, plus `--no-ext-diff --no-textconv` on every diff.
2. At prepare, record a digest of `git config --list --show-origin --show-scope` filtered to keys that can run commands (`core.hookspath`, `fsmonitor`, `sshcommand`, `askpass`, `attributesfile`, `filter.*`, `diff.*`, `merge.*`, `include*`, `credential.*`, `url.*`), the hooks directory, info/exclude, info/attributes and `worktrees/*/config.worktree`.
3. Before each call, compare against that digest; on a mismatch, refuse and name the key that changed.
4. C14's sandbox blocks these writes at the source.

**Trade-off.** Repositories that rely on post-checkout hooks (git-lfs, husky) lose them in controller worktrees, and a legitimate config change during a run (git push -u, gh auth setup-git) is refused; against a deliberate attacker running as the same user this is a tripwire, not a boundary.

### C26. Let resume re-pin policy.json before any worker has started (P1, effort M)

**Status:** **Proposed.**

**What's wrong.** The policy is never re-pinned, so challenge fixes that need owned-path or check changes cost a new run or a workaround: viewer-ux-panels-lists-001 and -002 were abandoned, fruit-kits-core-001 moved a docs edit to a manual merge, and rubbings-theft-fixes-001 bent a test to fit a pinned description. Pinning at prepare is stricter than evidence integrity needs.

- `md-manager/workflow/guardrails.py`:452 (repin docstring): "the policy is never re-pinned."
- `ai-logs/runs/agent-workflows/project-B/operator-logs/overnight-log.md`:13: "A resume refused a policy.json change (only task files, decisions and the PRD can change), so the docs/duel.md update moves to my merge step."

**Change.** Where: guardrails.repin, pinned_paths, commit_revision and resume_challenge; pipeline prepare; Pipeline.__init__. What: before any launch, with unchanged lane ids, a resume `--by operator` re-reads, validates and commits the feature policy (a maintainer's resume never re-pins, decision 2); rewrites run/policy.json, policy_sha256 and the pinned tasks in an intent-guarded sequence; re-derives failure_drill; and records the diff, naming any removed required check kinds. The policy stays immutable after the first launch.

**Trade-off.** The digest becomes final only at first launch, and weakening checks gets easier, hence the recorded diff and C27.

### C27. Warning-only policy lint at launch: weakened checks, kind mismatches, changed check definitions and tight timeouts (P1, effort S)

**Status:** **Proposed.**

**What's wrong.** validate_policy checks structure only. VEA-002 silently dropped unit from its required kinds (the only lane of 64 with no test-kind check), lint ran as kind build in 6 lanes, lanes can edit the scripts that define their own checks, integration reached 69% of its timeout unwarned, and a lane changed shared code whose suites no policy runs.

- `ai-logs/sessions/claude/projects/-home-agentops-dev-kleros-vea/afa2430f-5cb0-4dfe-abe4-211eddeab50d.jsonl`:550 (tool_use at 2026-09-28T10:31:29Z, the policy edit for run 002): `w['required_check_kinds']=['typecheck','build']`
- `md-manager/workflow/verification.py`:82-85 (validate_policy): `if not required <= kinds:`

**Change.** Where: guardrails.brief_problems; the launch notes; preflight; the verify event. What: warn, never refuse, at launch on: no test or acceptance kind; a kind that does not fit its command; a check-kind diff against the feature's latest run (also recorded in plan.json and shown to reviewers); check definitions the lane changed (flagged in the verify event); durations above 60% of the timeout; changed tests that no check runs; owned paths imported elsewhere with no check.

**Trade-off.** False positives, and about a minute of reading per feature.

### C28. Defer checks by lane dependency, not by check kind, and stop re-checking an identical tree in single-lane runs (P2, effort M)

**Status:** **Proposed.**

**What's wrong.** 43 of 50 runs had one lane, and their candidate tree equals the snapshot (26 of 26 checked), yet every check reruns (233.6 min in all). Deferring build and browser to the candidate phase is pointless with one lane and hid two flaky scenarios; isolated typecheck pushed project-B into one-lane features, and browser checks run on one worker with fixed ports.

- `md-manager/workflow/verification.py`:25: `DEFERRED_WORKER_KINDS = frozenset({"build", "browser"})`
- `ai-logs/source/project-B.bundle`:main:features/world-sea/decisions.md:8: "A server/web split would fail the worker phase: typecheck gates each lane in isolation"

**Change.** Where: policy 1.3.0 (depends_on, phase_dependent, browser_workers); verification.evaluate_worker; Pipeline.candidate. What: independent and single-lane runs gate every kind in the worker phase, and a dependent lane is verified over its dependencies' snapshots. With one lane the snapshot is the candidate and worker receipts are reused, except for checks marked phase_dependent. Add an opt-in browser_workers with per-run ports, and pin cross-lane enums in tasks.

**Trade-off.** The evidence format changes, and a flaky check runs once, so ship it with C44's flake labels.

### C29. Stop launching new user-facing features while 3 approved ones wait for your tryout (P2, effort M)

**Status:** **Decided** (decision 10): new user-facing launches stop after 3 untried features. Ships with C7's tryout card.

**What's wrong.** Your capacity to try finished work was never an input; the overnight limits covered CPU, RAM and browser ports. After your last positive verdict (24 Sep 17:08), 8 user-facing features merged with no verdict from you, 7 of 11 user-facing launches went on top of 1 to 7 untried features, and the 250 ms input lapse reached 3 hold features (6 runs) before you found it, 14.7 h after the first of them merged. A memory rule said to offer playtests, but the plan put your play after the whole polish queue and "work non-stop" won; concurrency was not the problem, since runs with a browser check never overlapped.

- `ai-logs/roadmap/AI_ROADMAP.pdf`:p.15 ("Manage two independent workstreams"): "If completed work queues faster than you can evaluate it, pause new starts."
- `ai-logs/sessions/claude/projects/-home-agentops-dev-project-B/a169f327-9a20-48cb-95e2-5a97878b97d9.jsonl`:651 (2026-09-24T20:01:05Z): "i want you to work on the project non stop"

**Change.** Where: the prepare action (sessions.prepare), which launch and the manual path share; contracts/workflow/feature.schema.json (a `tryout` flag); plan.json and status; C7's tryout record; the overnight plan. What:

1. Features declare `tryout: true` or `tryout: false` when the task is written, and launch prints a note when a feature that owns web or app paths says false. Features marked false never count and never wait; their gameplay decisions go on the card of the feature that wires them in.
2. At prepare, count integrated runs marked `tryout: true` that have no tryout record and whose candidate is an ancestor of the new base (`git merge-base --is-ancestor`, so stacking on unmerged candidates counts too); a works, broken or recorded-skip verdict takes a run off the count.
3. Refuse a `tryout: true` launch when the count reaches N (from the profile, default 3); fix runs whose `follows` names a blocked run pass.
4. `--allow-untried "<reason>" --by operator` launches anyway (only you can lift the limit; while you are away the request goes to you through C57), with the reason, the actor and the untried list pinned in plan.json and printed in every status.
5. While the limit holds, other work continues: runs you queued, pure features and hardening runs on carried P2s; while you are away, launching a run you did not queue goes to you through C57 (decision 2).
6. Ship it only together with C7's batched tryout card; without the card, waits run to hours.

**Trade-off.** Waits depend on when you are around: in the replay, match-online would have waited about 2 h if you had recorded a skip in your 2-minute window at 04:34 (otherwise 7-9 h) and intel-online about 1.4 h, mostly inside time already lost to the 3.5 h hold and the usage limit. The override is only as good as the --by attribution (C17), and whether it would have exposed the hold bug earlier depends on a tryout that never happened.

### Stage 6. Blocked runs and fix cycles

### C30. A review-blocked brief, findings carried as TODO lines, reproducers through the entry point, recorded lineage and an abandon command, instead of follow-up runs built by hand (P1, effort M)

**Status:** **Proposed.**

**What's wrong.** Every follow-up run was built by hand with base branches and restore commands: 13 project-B follow-ups to review blocks, costing $124.01 or 25% of project-B run spend (9 launched overnight), plus one re-review after a usage-limit stop. plan.json has no link to the blocked run (fix cycles were miscounted), nothing carries a blocked run's open findings forward (the discarded theft-window P1 never reached match-online-fixes-2), and fix tasks take over an audit's diagnosis untested: on 16 Sep the fix-1 test injected providers below watcher.ts, and the fix-2 writer left the same bug in claimer.ts because that file was outside its fence. Abandoned runs stay "paused" forever, and VEA-001's deliberate stop was logged as an outage.

- `md-manager/workflow/repair.py`:154 (check_before_review): "Reviewers have seen a candidate; code changes need a new run"
- `ai-logs/sessions/claude/projects/-home-agentops-dev-vea-validators-wt-validator-fix-2/11655155-10e7-41a1-861d-3b6f437bb4ec.jsonl`:400 (2026-09-16T07:02:38Z, the fix-2 writer): "Left `claimer.ts` untouched — it has the identical bug pattern but was out of scope for this task"

**Change.** Where: automatic._decide; launch.py and scaffold init (--from-run); a new abandon action in the pipeline. What:

1. On a review block, the controller writes review-blocked.brief.md: the findings verbatim (late verdicts included), the snapshot refs, each lane's untested items and assumptions, and two launch recipes (build on the candidate when every reviewer gave a verdict, otherwise restore).
2. `workflow init <fixes> --from-run <run>` writes each open P0/P1 and contradiction as a "TODO:" acceptance line, which launch already refuses until each is addressed or deferred; relaunch with `--run-id <feature>-00N` or `launch --follows <run>`.
3. The follow-up records block_kind (defect; test-debt, meaning missing tests for behaviour that works; or process). For a defect block, the first acceptance item is a test that fails on the blocked snapshot, entering through the production entry point when the finding is about wiring; a finding nobody has reproduced is tagged "unreproduced" before any fix; lane owned paths follow the reproducer's call path; and each new test names the finding it closes.
4. Overlaying follow-up tests onto blocked snapshots stays an offline tool for the weekly review, not a graph step.
5. `workflow abandon <run> --reason [--superseded-by]` stops sessions and records the reason; drive, resume and approve then refuse that run.

**Trade-off.** Model cost per cycle is unchanged, but the viewer needs a new terminal status, block_kind is the assistant's label, and entry-point reproducers take longer to write than tests that inject state.

### C31. Cap fix cycles, and carry open findings and observed defects into later runs through one findings ledger that closes only when the fix lands (P1, effort M)

**Status:** **Proposed.**

**What's wrong.** Fix tasks added P2s, the assistant's own items and new product rules, 2 of 5 later blocks hit such additions, and the intel chain ran 5 runs overnight with no cap. 157 findings are still open in 32 approved runs, and the hand carry-forward dropped the 250 ms input-lapse hazard: sea-compact-001's worker disclosed it and a reviewer flagged it P2 in a run that was blocked, it was fixed only for mooring, and it reached three hold features and became the 25 Sep escape. Owned-path overlap and severity both filter badly (every game lane owns "apps"; a replayed reviewer rated the theft-window bug P2 and a missing report table P1), and on company code "done" meant a task branch had passed review: the 16 Sep validator fixes were never merged.

- `ai-logs/runs/agent-workflows/project-B/operator-logs/overnight-log.md`:87: "launched intel-core-fixes-4 (restores 037c658 on 7c855cb) with a branch → failing-test table requirement to end the loop."
- `ai-logs/runs/agent-workflows/project-B/sea-compact/sea-compact-001/world.completion.json`:open_assumptions[5] (sea-compact-001 was blocked, and the integrated docking-feel-001 never mentions the lapse): "Observed, not fixed (out of scope): if the page stalls >250 ms the server lapses input to neutral, resetting mooredThrottle"

**Change.** Where: the overnight plan and C53's rules; C30's brief; a findings ledger per project (one file listing every open finding with its source and status); reviewCompletion 1.3.0 (follow_up) and completion 1.2.0 (observed_defects); prepare, guardrails.challenge_prompt, automatic.review_prompt; the viewer and the morning summary. What:

1. A fix run's scope is the blocking findings, every open contradiction of a quoted requirement at any severity (C34), and any P0/P1; apply this only after C34 lands, since 5 of the 9 follow-ups to test-debt blocks also fixed P2-rated defects.
2. P2s and new behaviour go to the ledger and product rules wait for you; while you are away, each fix run's launch goes to you through C57 (decision 2), and after 2 blocked runs in a chain the orchestrator stops proposing more and notifies you.
3. The ledger is fed by review.json, challenge.json, loop logs, external audits (C37, C36) and a typed observed_defects completion field, captured whatever the run's verdict; each entry has a source, a path, a severity, a status (open, carried, or resolved by run or commit) and an optional follow_up condition.
4. At prepare, generate a "known open conditions" block from observed defects and open P0/P1 and contradiction entries (not from owned-path overlap), pin it, and append it to decisions.md and to the challenge and review prompts.
5. An entry closes only through `resolves: <run>#<finding>` in a later task; for critical, hard-to-identify code, only when the target branch holds a commit whose `git patch-id --stable` matches an audited head (C36), so amends and squash merges keep their audit.
6. The viewer and the morning summary list open entries.

**Trade-off.** P2s wait one feature longer, prompts grow by 1-2k tokens, capped chains slow overnight runs, and workers fill one more completion field; the overnight plan's carry sections become a generated summary.

### C32. Verify and review an existing commit without a worker: small fixes after approval, re-reviews and merge chores (P1, effort M)

**Status:** **Proposed.**

**What's wrong.** Once review has started, the only reviewed route is a new run: 21-87 min (median 27) and $4.95 to $11.48 per fix run on 24 Sep. Offered a workflow run ("About 30–40 minutes") or a direct fix ("About 15 minutes, but the change skips the independent review"), you chose the direct dock fix, and that fix (7fbf5a6, 168 lines) introduced a stall cast-off; merge-time chores and two P2 fixes (4dbcf1c) also landed without review. Re-reviewing intel-online after a usage-limit stop took a whole run whose worker only ran git restore (44 min).

- `md-manager/workflow/RUNBOOK.md`:287: "**Changed code:** before review, `repair` (below); after review started, create a new run."
- `ai-logs/sessions/claude/projects/-home-agentops-dev-project-B/0094b893-59da-46a6-a9fa-4f48e374f4db.jsonl`:2117 (AskUserQuestion 2026-09-24T13:55:50Z; answered "Fix it directly now" at 14:07:05Z): "About 15 minutes, but the change skips the independent review."
- `ai-logs/runs/agent-workflows/project-B/intel-online-review/intel-online-review-001/plan.json`:nodes.game.task: "This run restores that verified snapshot unchanged, so the feature gets a fresh verification and a fresh review."

**Change.** Where: a new `workflow review-commit` command reusing checks.verify_revision and automatic._review_print; RUNBOOK line 287; scaffold (a hotfix preset). What:

1. `workflow review-commit --repo <target> --base <sha> --commit <sha> --feature <f> --note "<what the user did and saw>"` launches no worker: verify_revision runs the feature's policy checks on the commit in a detached worktree; one print reviewer reads the diff with a fix brief (replay the user's input sequence through the changed code, and look for new state that a lapse, a stall, a key repeat or a second input can reset); and it writes review-commit.json and an escape record (C45), leaving the merge to you, or to the orchestrator on your decision.
2. Escalate to a challenge or a full run when the fix touches a known-condition path (C31) or the reviewer asks for it, not by line count.
3. Use it for fixes after approval, re-reviews after a usage-limit stop, merge chores, and test-only repairs after a coverage block (re-reviewed by the blocking reviewer, with C33).
4. Fixes that need a worker use a preset: one lane, challenge off, the general reviewer only, and a failing reproduction test as acceptance item 1.

**Trade-off.** Weaker than a full run: no challenge by default (the challenge caught the hold fix's flaw and corrected 6 of 11 follow-up plans), and a single reading reviewer approved the broken dock, so the fix brief matters; a test-only repair weakens the "one review per bundle" rule.

### Stage 7. Reviewers

### C33. When one reviewer blocks, let the others finish, and record every verdict they wrote (P0, effort S)

**Status:** **Proposed** (P0). Step 7 is in "Act now".

**What's wrong.** On the first block every other reviewer is stopped and nothing reads a stopped reviewer's file: in 7 of 13 blocked runs the slower general reviewer (median 3.7 min) was stopped, 6 times mid-review and once after writing its verdict, and skeleton-001 (77 files) reached main with no approving and no coverage review. In match-online-fixes-001 the general reviewer wrote a bound, blocked verdict with a P1 2 s before coverage's block was accepted (after the orchestrator had nudged coverage's stuck pane), yet review.json, `workflow status` and the viewer show no general verdict, and you were told the block was about test gaps, not broken behaviour. That P1 is a live bug on project-B main 99139b5: a test built from it failed in 5 runs by two agents and passes with a one-line guard (that a browser player can send the late choice is inferred). Print reviewers' verdicts left in stdout.json are dropped from review.json too.

- `md-manager/workflow/automatic.py`:559 (wait_reviews): `return decisions  # The first block decides; nobody waits for the other reviewers.`
- `ai-logs/runs/agent-workflows/project-B/match-online-fixes/match-online-fixes-001/review-general.completion.json`:findings[0] (P1, written 05:07:02.239Z; coverage accepted 05:07:04.35Z; general then recorded as "superseded"): "Outcomes do not freeze for a duel that is in its theft-choice window when the match ends."
- `ai-logs/sessions/claude/projects/-home-agentops-dev-project-B/a169f327-9a20-48cb-95e2-5a97878b97d9.jsonl`:4738 (`workflow status` at 2026-09-25T05:08:02Z, the only view after the decision): `RuntimeError('Independent reviewer blocked the candidate (coverage)')`
- `workflow-audit-evidence/gap-1-5/rerun-99139b5.log` (auditTheftWindowFreeze.test.ts on project-B main 99139b5: 2 failed; with the guard, rerun-control.log shows 2 passed): "AssertionError: expected [ 'moon' ] to deeply equal []"

**Change.** Where: automatic.wait_reviews (lines 557-559), _review_print (line 900), supersede_running, _decide; automatic.py lines 390-391; RUNBOOK line 244; PRD_PARALLEL_REVIEWERS.md lines 52 and 75; test_automatic.py lines 533-537, 1119-1125 and 1878. What:

1. After the first block, accept at once any other reviewer whose completion file already exists and binds, whatever its native state (C18).
2. Keep polling each remaining reviewer until it is accepted, reaches its own deadline, or hits a grace cap (default 10 min); remove the break in _review_print so print jobs that already exited are read too.
3. Then stop the rest and read each stopped reviewer's completion file or print stdout.json once with read_review_completion, inside a try/except that never masks the block; store a parse error instead of raising.
4. Record each verdict read this way as an ordinary decision flagged `late: true` in `automatic-review-<id>.json`, so review.json, the export and the viewer's triage show it with no contract change.
5. Decide with every verdict: the block error that `workflow status` prints carries the first sentence of each open P0/P1, and the review-blocked brief (C30) lists late findings.
6. Apply the same rule in both transports.
7. Separately, fix the live bug now, by hand: guard receiveTheftChoice with `!this.inPlay()`, settle "choosing" duels without a theft in endMatch, and extend the audit test to check that the duel leaves "choosing" (as written it passes with the guard alone). Run it on Node 24 with the full policy checks first, because the 38 s test brings integration to about 241 s of its 300 s timeout.

**Trade-off.** Blocked runs end a few minutes later and pay for the rest of the slower review (the 7 stopped general sessions had already cost $13.67), and it reverses a documented PRD decision that three tests pin. A file read after a stop can be half-written, hence the try/except.

### C34. Coverage blocks only on a shown failure, a contradicted task line or a failure the worker disclosed, and lists every other gap as a P2 row in a tested/untested map (P1, effort M)

**Status:** **Decided** (decision 4): coverage blocks only on a shown failure, a contradicted task line or a failure the worker disclosed; every other gap is a P2 row in a tested/untested map (steps 1-2). Proposed: applying contradiction blocking to the other reviewers' findings (step 2), the shared rubric and the verdict rule (steps 3-4), the validation (step 5) and shipping it with C33 and C31 (step 6).

**What's wrong.** coverage.md blocks on any required behaviour without a test and gives no severity rule. On project-B coverage decided 11 of 13 blocked verdicts: in 9 the follow-up's new tests pass on the blocked lane snapshot, so the behaviour already worked; in 2 it traced a real defect the worker had disclosed; fruit-kits-core-001 was blocked on P2s alone; 25 of 29 approvals still carry a requirement-linked gap; and real defects were rated P2 because the worker had disclosed them or the task's literal wording allowed them. The verdict does not reproduce either: of 5 coverage samples on intel-core-001's candidate (the archived review and 4 replays on the rebuilt candidate), 3 blocked, and the two approving replays saw the code break "at most one pending per player" (a rule under "## Design (settled)", not under Acceptance) and handed it to the general reviewer, which in the archived run had been stopped.

- `md-manager/workflow/prompts/reviewers/coverage.md`:1: "Approve only when every required behaviour has a real test; do not infer coverage from a passing suite."
- `workflow-audit-evidence/gap-2-4/replay/icc/s1/run/review-coverage.completion.json` (verdict approved, findings[0] P2; a replay of intel-core-001's coverage reviewer, of which 3 of 5 samples blocked): "Whether that deviation is acceptable is for the general reviewer; as it stands, the bound is untested."

**Change.** Where: prompts/reviewers/coverage.md; automatic.review_prompt (both transports); automatic.decision_blocks and combined_review; contracts/workflow/reviewCompletion.schema.json (relation); test_automatic.py. What:

1. coverage.md: a gap is P1 only when the finding shows the behaviour fails on the candidate (inputs, expected behaviour as a quote, actual behaviour, path:line), or quotes a worker disclosure that it fails. Every other gap, including a test that covers a task's Real use line (C7) in an easier way than stated, is a P2 row in a map with one row per Acceptance line and per "## Design (settled)" rule (test, check, self-report or none); a waived gap is marked "accepted", quoting the waiver.
2. Each finding gains a relation (contradicts, untested, weak_test or other) beside its requirement quote. decision_blocks blocks on any open "contradicts" finding whose quote appears verbatim in the pinned task or in the Operator decisions section of decisions.md (C4, decision 8), whatever its severity; applying the rule to the general reviewer's findings too is a proposal; coverage.md exempts contradictions from "the general reviewer owns those".
3. review_prompt gives every reviewer one rubric: each P1/P2 ends with "Consequence: ...", and worker disclosure, literal task wording or "not a regression" moves the decision to you instead of lowering the severity.
4. The verdict comes from the findings: blocked if and only if an unresolved P0/P1 or contradiction exists.
5. Validate first at no model cost by relabelling the 10 archived and replayed samples of intel-core-001 and match-online-fixes-001, then run 5 live samples per case (about $17); trial the brief on single features first, since feature.json reviewers already accept a brief stored in the feature.
6. Ship together with C33 and C31.

**Trade-off.** Tests for behaviour that already works arrive later, through the findings ledger, and a regression can merge meanwhile; the project-B saving is $40 to $71, not $90, because 5 debt follow-ups also fixed P2-rated defects and the general reviewer's P1 would have forced one anyway. The contradiction rule depends on reviewers stating the contradiction, which all 10 seed samples did.

### C35. Role-specific reviewer inputs: coverage reads worker evidence, general traces added scope back to the request (P1, effort S)

**Status:** **Proposed.**

**What's wrong.** Both reviewers get identical context in 43 of 43 runs, apart from brief, reviewer id and launch token. Workers' untested, falsifying_check and verify_yourself never reach the bundle (coverage opened a completion file in 2 of 41 runs), and no reviewer is asked where an added field came from: VEA's general reviewer read your verbatim request but never questioned the provenance fields.

- `md-manager/workflow/automatic.py`:152 (read_completion): `return {"summary": item["summary"], "open_assumptions": item["open_assumptions"]}`
- `ai-logs/sessions/claude/projects/-home-agentops--local-state-agent-workflows-vea-veashi-vea-addresses-veashi-vea-addresses-002-review-worktree/8540f961-70b3-4928-8f00-67ebf893aefe.jsonl`:73 (10:42:49Z): "I'm checking the worker's completion for the recorded `node -e` verification."

**Change.** Where: automatic.review_prompt and the bundle; prompts/reviewers/coverage.md and general.md. What: review_prompt names the PRD copy, each lane's completion file ("worker claims, unverified") and policy.json, and the bundle records each completion's sha256. coverage.md starts from each untested list and judges falsifying_check; general.md lists each added public API or data field with its task or decision line, and follows run-produced content into renderers, links and prompts.

**Trade-off.** 1-2k tokens per reviewer, and some anchoring on the worker's list.

### C36. An audit command for code you write by hand in critical paths, built on review-commit (P1, effort M)

**Status:** **Partly decided.** No launch refusal: whether AI may write a critical path is decided per feature at the grill (decision 9). The audit command is proposed.

**What's wrong.** The workflow cannot express R32's critical, hard-to-identify cell ("Write by hand and audit with AI"): every feature needs an AI worker lane, your own commit enters only as a lane repair or through a lane whose task restores it, and md-manager's review import refuses a blocked verdict. The only P0 on company code came from that cell, outside the workflow: you wrote fix/val-doc-1 (22 files, +2,417/−329), and DeepSeek in Pi audited it in 8 minutes for $0.47. The same stream shows a single pass's limits: the audit marked watcher.ts correct and described the claimer path wrongly, a brief's "Known hotspot" carried that wrong mechanism into four reviews and one fix writer, the same reviewer on the same diff passed and failed each P0 fix lane, and the 12 explain-diff pages written for you cost $6.49, more than twice the cost of the 22 reviews.

- `md-manager/contracts/workflow/feature.schema.json`:37 (properties.workers; line 6 forbids other top-level keys): `"minItems": 1,`
- `ai-logs/roadmap/AI_ROADMAP.pdf`:p.31 (R32 matrix, critical column, hard-to-identify row): "Write by hand and audit with AI"

**Change.** Where: a `workflow audit` command reusing C32's review-commit (checks.verify_revision, automatic.review_schema, pipeline.blocking_findings); a generic exploit brief in workflow/prompts/reviewers/; path classes in the projects registry (~/.config/md-manager/projects.json); C31's ledger. What:

1. `workflow audit --repo R --base B --head H --brief F... --samples N [--runner claude|pi]` runs the repository policy's checks on H through verify_revision; runs each brief × sample as a parallel print job validated with review_schema (worker fixed to "none"), recording blocked verdicts too; writes audit.json bound to B, H, H's tree and each commit's `git patch-id --stable`; files its findings in the ledger; and never integrates.
2. Each audit runs a blind hunt first, then confirm-or-dismiss on recorded seeds, then a question about your intent only for findings that turn on it. Briefs state hazard classes, never unverified mechanisms; leads live in the audit record.
3. Split hunts by scope instead of repeating one brief (for validator-cli: the claim path, the challenge and resolve path, and startup and env); for cross-chain code each hunt outputs a table of every contract read and write with its provider, chain id and call path from the entry point.
4. A generic exploit brief asks the course's Web3 questions (who can profit, avoid a cost, delay settlement or impose costs; chain, decimal and revert behaviour; what the transactions contain) and reads repository specifics from the CLAUDE.md Hazards section (C15); each P0/P1 names its consequence and the adversary's best move while the defect is live.
5. You add a short author note: what you tested, what you did not, and what would prove you wrong. Coverage judges against that note, or is dropped in favour of the executed harness (C21).
6. Budget by criticality: name the briefs, samples, providers and harness for each cell; pin the auditors' model and effort (C52); cap explainer pages before adding samples; add a second provider once C39's replay of fix/val-doc-1 shows it finds what Claude misses.
7. Keep path classes in the projects registry, not the company repository. Default: validator-cli, the vea and veashi contracts and the kleros-v2 gateway contracts are critical and hard to identify; veashi-sdk addresses are easy to check, and not critical while the SDK exports testnet routes only. You confirm each change's cell at the grill (C5), with the classes pre-filled. `launch --dry-run` warns when a worker lane owns a critical, hard-to-identify path; launch does not refuse such lanes: you chose to decide per feature at the grill (decision 9), recorded with the feature's R32 cell (C5). vea-validator2 and vea-validator3 are pre-filled as R32's redundant implementations, which your per-feature answer can weigh.
8. Try it first without code: a one-lane feature whose task only restores your commit, with the challenge off and custom briefs, as intel-online-review-001 did.

**Trade-off.** A pass costs about $0.50 on DeepSeek, up to about $8 with several Claude briefs and samples, plus your time to triage, and you write by hand the changes you keep from AI workers at the grill (decision 9). Steps that run commands belong in C38's exerciser under C14's sandbox, so in-run reviewers stay read-only.

### C37. Run a second-provider bug hunt on each controller branch before it merges, and correct the record of who reviewed (P1, effort S)

**Status:** **Proposed.**

**What's wrong.** On 23 Sep a Codex bug hunt (three scoped subagents, about 6 min and $5) reported 7 controller defects, each found there first; Claude found 4 of them later (2 in that morning's audit, 2 in bug hunts 15-21 h later), 3 are still unfixed (C24), and a Claude reviewer had already cleared the reviewer-restart path that Codex then flagged. The Codex verdict never entered the workflow, no second provider has reviewed any run candidate or the ~2,200 controller lines added since, and 71 of 76 controller commits were made outside any run, so an in-workflow reviewer would not see them. Yet REPORT.md says Pi/Codex does review.

- `ai-logs/reviews/parallel-reviewers-001-review-log.md`:264 (23 Sep about 00:06Z; Codex flagged the same path at 06:34Z): "I found no hole in that."
- `ai-logs/REPORT.md`:147: "Claude Code (primary implementation) + Pi/Codex (supervision/review). Same-provider exception: none requested."

**Change.** Where: the controller-branch merge routine (next: feature/viewer-ux); the findings ledger (C31); test_pipeline.py and test_checks.py; REPORT.md lines 18, 32 and 147. What:

1. Before each controller branch merges to main, run the three bug-hunt tasks on Codex, regenerated for the current module list, with `codex exec --ignore-user-config --sandbox read-only --ephemeral` (the replay ran with your MCP servers loaded).
2. Keep the subagent outputs as the record, not the parent verdict, which demoted the integrate race; file them in the ledger and turn confirmed items into expectedFailure tests.
3. In the same pass, run the tasks on Claude with Bash, two runs each, as the control that decides whether a Codex reviewer runner is worth building.
4. Correct REPORT.md's provider claims, and record the same-provider exception for in-workflow review (every reviewer is a separate session, which check_reviewers enforces).
5. Add one cross-provider comparison for the course's R25, with a column for the severity rubric.

**Trade-off.** About $5 and 6 min per Codex pass, plus $20-60 for the Claude control; severities come from different rubrics, and one run per task cannot separate the brief's effect from run-to-run variance.

### C38. Add an exerciser that runs the candidate the way a user would, alongside the reviewers who only read (P2, effort M)

**Status:** **Proposed.**

**What's wrong.** Reviewers may not run anything, and running the code found what reading missed: a subagent reproduced two duel-core-001 P1s both reviewers missed, a headless probe reproduced the dock defect a minute after your report, and a 3-minute smoke test on real data found md-manager's page overflow, while a subagent that only read the world diff approved the broken dock. You declined ad hoc review subagents, so this has to be a recorded workflow step.

- `md-manager/workflow/prompts/reviewers/general.md`:1 (the same in coverage.md): "No edits or command execution."
- `ai-logs/sessions/claude/projects/-home-agentops-dev-project-B/0094b893-59da-46a6-a9fa-4f48e374f4db.jsonl`:3214 (2026-09-24T16:19:02Z): "No dont send a review sub agent, workflow review is enough. I only want your workflow logs"

**Change.** Where: automatic.review_candidate and the review record; a role brief in workflow/prompts/reviewers/; C41's Phase 2 jobs. What: add an exerciser role that the controller launches alongside the reviewers, in a disposable candidate worktree, under the worker profile (C14) and with its own port base (C28). It runs the task's Real use lines and the lanes' try_it steps (C7) on real data, records what it ran and saw, and writes its findings into the review record; design it together with C41's Phase 2 jobs.

**Trade-off.** About one reviewer session ($1-3) with no added latency, plus flaky environments and port conflicts; it runs candidate code, as workers already do.

### C39. Replay past runs, about five samples per case, to measure prompt and provider changes before adopting them (P2, effort M)

**Status:** **Proposed.**

**What's wrong.** Several changes here rewrite reviewer and challenge prompts, and the hand-built replay (29 Claude and 11 Codex jobs on 7 archived cases) shows that 2 samples per run cannot separate a prompt change from noise: on a single input, the P1 rate of different subjects ranged from 1 in 5 to 4 in 5. Under the archived reviewer prompt Codex read no file and blocked. 14 of 48 candidate commits, mostly from blocked runs, are missing from the archive bundles, and findings are free text, so labels must be written by hand.

- `workflow-audit-evidence/gap-2-4/replay/tally.json`:challenge.sc3 (one subject across 5 samples of one input): `"hold ahead+E docking only works exactly on the dock axis": ["P1", "P1", "P2", "P1", "P1"]`
- `workflow-audit-evidence/gap-2-4/replay/codex-vea2-review/r1.last.json` (verdict blocked, findings[0] P1; Codex with --ignore-user-config under the archived reviewer prompt, reading no file): "command execution is expressly prohibited"

**Change.** Where: a new workflow/replay.py (`python -m workflow replay`), extending the scratch-run procedure in docs/PRD_PARALLEL_REVIEWERS.md; a label file per reference run, starting from workflow-audit-evidence/gap-2-4/replay/tally.json. What:

1. `workflow replay <run> --stage challenge|review --samples N --variant <git-ref>` copies the run directory to scratch and rebuilds the candidate from the base plus review.diff; regenerates the prompts with that version's challenge_prompt and review_prompt and runs them with the live flags and the run's pinned model and effort (C52); scores per subject (P1, P2 or absent), first on outcome-confirmed subjects (the intel-core pending bound, the theft window, the docking dead zone), counting P0/P1s on unlabelled subjects as false alarms; and draws 3 samples, plus 2 more only where variant and baseline counts overlap, against a pinned baseline it does not resample.
2. Seed it with the 7 replayed cases (tally.json as the label file), fix/val-doc-1's audit on your VPS checkout (which must find the F2 misuse and the watcher threading defect), and final passing attempts and attempt-1 cases.
3. Leave a Codex runner out of version 1; if added later, use C37's flags, pin its model and reasoning effort, and treat its provider note as part of the variant.

**Trade-off.** About $45 per variant (7 cases × 5 samples × about $1.3) and 30 min in parallel, plus label upkeep; only large shifts show, and only when pooled across cases.

### C40. Name review.json as the record, drop the unread duplicate, and check the review worktree for planted configuration (P2, effort S)

**Status:** **Proposed.**

**What's wrong.** Each finding is stored about 11-12 times: `decision` equals accepted_decision in 70 of 70 files and nothing reads it, and .review equals review.json in 32 of 32 runs. A safety finding is also open: project configuration dropped into review-worktree is invisible to git status.

- `md-manager/workflow/automatic.py`:442 (ReviewStatus.record_decisions): `self.statuses[reviewer_id]["decision"] = decision`
- `md-manager/workflow/export_state.py`:146 (review_section): `review = load_optional(directory / "review.json")`

**Change.** Where: RUNBOOK; automatic.record_decisions and _review_print; verdict acceptance. What: document review.json as the record and `automatic-review*.json` as recovery state; stop writing `decision`, and have print transport write accepted_decision; before accepting a verdict, check review-worktree for ignored .claude/ or CLAUDE.md.

**Trade-off.** Six test assertions change, and old runs must still load.

### Stage 8. Live loop reviewer

### C41. Replace ad hoc /loop reviewers with staged, workflow-owned signals: deterministic checks first, then event-triggered triage (P1, effort M)

**Status:** **Decided** (decision 12): free controller signals plus opt-in triage jobs (about $1 each) that route a P0/P1 to a lane through a recorded note or to you on Telegram; no P3 loop review. Proposed: the block-diagnosis job and the handoff hold for single-lane runs.

**What's wrong.** The ~20 extra loop findings did persist (13 of 14 diff-visible ones were still in the code) but mostly did not matter, and the useful extras were runtime signals. A loop saw a P0 41 min before the candidate blocked with no way to reach the lane, three watchers ran uncoordinated, loops missed the security finding in both reviewed runs, and a frequent failure today is a review block that the worker's own untested list predicted.

- `ai-logs/reviews/parallel-reviewers-001-review-log.md`:193 (appended 2026-09-22T23:39:46Z; the candidate blocked at 00:21:17): "P0 (cross-lane, ui side, now verifiable): the ui fixtures use a reviewer `status` the contract rejects."
- `ai-logs/reviews/viewer-clarity-001-three-reviews-compared.md`:75: "Four findings overlap. The reviewers had 3 that Claude missed, and Claude had about 20 that the reviewers didn't raise."

**Change.** Where: automatic.wait_handoffs and drive; checks (`check-report --log`, a provisional phase); print_command; the export. What: Phase 1, no tokens: a lane-completion event; deferred-check exit codes (C44); `check-report --log` for text test summaries; a provisional cross-lane build at each completion under a non-gating phase. Phase 2, opt-in: controller-launched one-shot jobs for handoff triage (task, diff, untested list, challenge notes; P0/P1 go to the lane through a recorded note (C17) or to you on Telegram (C57)) and for block diagnosis (cause plus a drafted repair command). No P3 review, and reviewers stay blind to its output.

**Trade-off.** About $1 per Phase 2 job and extra CPU for provisional builds; single-lane runs need the handoff hold.

### C58. Make the review sidecar's messages land, stop it once the lanes are done, and decide its future on a measured trial (P1, effort S)

**Status:** **Proposed** (from the 7 Oct reviewer-vs-sidecar analysis, `~/dev/md-manager-reviews/reviewer-vs-sidecar-analysis.md`). Steps 1-4 are controller fixes; step 5 is a decision rule, not code.

**What's wrong.** The sidecar's judgement is fine; its delivery is not. Pool-wide (42 runs with a ledger and a verdict) 22 of 54 sidecar messages never reached a worker: `lane_finished` when the first 1800 s cadence pass fires after a short lane is already done, `pane_busy` from the controller's single Enter after a paste (`sidecar.py` L724; `course-gap-runs-2026-10-05/checklist-prep/audit-mdmanager-projects/RESULT.md` L58-63). An undelivered finding is either re-raised by a reviewer at the end (pure redundancy) or ships open. Where the message landed early (okiya and md-manager runs, cadence 300-900 s) 3 of 4 delivered findings were fixed before freeze, one a real defect (pure-okiya-001 S-1). On indexers-004 six of nine passes ($1.69) only re-asserted one open finding the lane could no longer receive, and the dashboard's idle rule (0 new, 0 changed, 0 messages) counts none of them.

- In the 5-run sample: $12.81 for 13 findings, 3 fixed after delivery ($4.27 each); reviewers $26.94 for 36 findings, 21 fixed in a follow-up ($1.28 each; different bars, stated in the report).
- Pool: sidecar $140.09, 115 findings, 43 verified resolved of which 34 after a delivered message; 44 of 121 completed passes produced no new finding and no message ($25.28).

**Change.** Where: `sidecar.py` (Scheduler, deliver_text, merge), `automatic.wait_handoffs`, the export's idle rule. What:
1. First pass at the first lane commit or at 10 minutes after launch, whichever comes first; the cadence applies after that.
2. No cadence pass once every lane has written a completion or is refused `lane_finished`; go straight to the final pass.
3. Re-verify an unchanged open finding at most once; later passes carry it without a new history row.
4. Delivery: after typing a message, read the pane back and press Enter again if the paste still shows; record `pane_busy` only after that.
5. Disable the sidecar by default on single-lane runs whose deadline is under 45 minutes with the default cadence. Then run it for about 20 multi-lane runs and read two numbers from the ledgers: share of messages delivered, and findings verified resolved after a delivered message. Below 70 percent delivered, or fewer than one such fix per two runs, drop the sidecar; the pool today is 59 percent and 0.8 per run. The export's idle rule gains a second count, "no new finding and no message", so the trial can be read from the dashboard.

**Trade-off.** Steps 1-4 are small and risk nothing a worker sees except one more Enter. Step 5 removes the only in-run feedback channel from short runs, where the data shows it buying nothing. The related loss of superseded sibling reviewer verdicts ($36 unrecorded in the pool) is C33.

### Stage 9. Artifacts, observability and cost

### C42. Rotate the credentials leaked into the ai-logs archive, and stop the export from copying credential files (P0, effort S)

**Status:** **Act now** (Part 1). Not a workflow change.

**What's wrong.** The ai-logs repository on GitHub says "secrets redacted", but commit 276d79f holds Pi's openai-codex OAuth access and refresh tokens (sessions/pi/auth.json), a DeepSeek key in 4 transcripts, a Brave Search key, and the vea_validators DEPLOYER_KEY for a wallet funded on mainnets in September (current balance unknown). The scan matched only a few token formats, and auth.json and web-search.json got in because the export copied ~/.pi/agent whole. The repository returns 404 to unauthenticated requests, so it is not public today.

- `ai-logs/README.md`:35: "a scan for API tokens/keys was run before commit; matches are redacted in place"
- `ai-logs` git history:commit 276d79f (an ancestor of origin/main, git@github.com:mani99brar/ai-logs.git): "ai-logs: raw Claude and Pi session transcripts (secrets redacted)"

**Change.** Where: your accounts and the ai-logs repository (not workflow code); ~/.bashrc; your own ~/.claude/settings.json. What:

1. Today: revoke Pi's openai-codex session; rotate the DeepSeek and Brave keys and move DEEPSEEK_API_KEY out of ~/.bashrc into Pi's own 0600 config; treat the deployer key as compromised, move any funds and generate a new key.
2. Then: delete sessions/pi/auth.json and web-search.json from the archive and exclude credential stores and .env files by path; run gitleaks as the ai-logs pre-commit hook; correct the README's "secrets redacted" line; give your own Claude sessions Read deny rules for `**/.env`, ~/.pi/agent/auth.json and ~/.config/gh. Rewriting history matters only if the repository becomes public.

**Trade-off.** A few re-logins and one wallet move, and gitleaks flags test keys, so allowlist the Hardhat defaults; the primary copies on the VPS stay readable to workers until C14 denies them.

### C43. Reports to you start from an outcome block generated from the run record, not from the orchestrator's memory (P1, effort M)

**Status:** **Proposed.** Step 5 is in "Act now".

**What's wrong.** The orchestrator's free-text reports often claimed more than the run records showed, in roughly two dozen verifiable cases across 6 sources: "Everything was approved by both workflow reviewers" for sea-compact code whose own two runs were blocked, "docking that works from any angle" while the review had accepted a 2-tile dead spot, PR #526 saying chain ids come from `.chainId` while the generator builds them from a hardcoded map, and "the code works the same" for the round whose discarded P1 is a live bug. The channels it reads carry no verdict content: the "approved" event lists only session ids, `workflow status` names only the blocking reviewer, and report.html, every automatic run's "Evidence" link, has no verdicts, findings, decisions or challenge. A memory rule to report from the completion files existed and was followed, but when the orchestrator looked, only the blocking reviewer's file existed.

- `ai-logs/sessions/claude/projects/-home-agentops-dev-project-B/a169f327-9a20-48cb-95e2-5a97878b97d9.jsonl`:4465 (2026-09-25T04:33:10Z): "Everything was approved by both workflow reviewers before merging."
- `ai-logs/runs/agent-workflows/project-B/operator-logs/morning-summary.md`:9 (docking-feel-001 review.json line 51 records the 2-tile dead spot as an accepted P2): "docking that works from any angle (press E at or beside a dock)"
- `ai-logs/sessions/claude/projects/-home-agentops-dev-kleros-vea/afa2430f-5cb0-4dfe-abe4-211eddeab50d.jsonl`:722 (2026-09-29T03:40:23Z, the gh pr create body for PR #526; extract-vea.cjs line 67 builds the key from NETWORK_CHAIN_IDS): "It takes chain ids from each network's `.chainId`"

**Change.** Where: pipeline status and report (lines 811-857 and 1137-1138); event messages (C44); export_state; launch.py line 323; a `workflow digest` command over the registry's runs_roots; C53's OPERATOR.md; C56's pr-branch. What:

1. Build one outcome block per run from the export (run-state.json): the mode and what happens next (C51); each reviewer's verdict, late ones included (C33), or "behaviour not reviewed" when there is no general verdict; open P0/P1 and contradictions, each with its first sentence; accepted P2s, verbatim, as "Known limits"; each lane's untested and verify_yourself items; blocked candidates inside the base (C45); and pane notes with their author (C17). A clean approval is one line; blocked or caveated runs get the full block.
2. Put the block where the orchestrator already looks: C44's verdict events carry the counts and first sentences, `workflow status` prints the block, and report.html gets the same sections.
3. `workflow digest --since <time>` walks the registry's runs_roots and, on each loop tick, writes one line per run to operator-logs, exceptions expanded. It opens with a "needs you" list from typed fields (runs waiting for a tryout (C7, C29), paused or held challenges in any profile (C8, C57), reviewer findings with a new `ask_operator` disposition, the verify_yourself lines of untried runs), is shown when you write and never as a blocking prompt from a tick, keeps only "Decisions for you" hand-written, and puts outcome-changing workarounds such as pane nudges at the top.
4. OPERATOR.md (C53): every outcome message starts with the block verbatim, with the orchestrator's own reading under its own heading; PR descriptions (C56's pr-branch) paste the worker's completion summary and the open and accepted findings before any prose.
5. Correct PR #526's description now: chain ids come from a hardcoded map that is checked against each `.chainId` file.

**Trade-off.** Blocked runs produce 15-30 lines and clean ones one line, and it is one more view to keep consistent with the viewer, so it reads the same export. Until C51 fixes the record, a generated block would repeat its pending-approval contradiction, and a digest over one runs_root would miss project-B's other checkouts, hence the registry walk.

### C44. Timeline and attention signals tell the truth: outcomes, reasons, flakes and a notification when you are needed (P1, effort S)

**Status:** **Partly decided.** The attention record that C57 sends you (decision 2) is decided; the rest is proposed.

**What's wrong.** There is no verdict event in 15 of 15 review-blocked runs, candidate blocks give no reason, deferred checks that exited 1 are announced as passed, and fail-then-pass flakes look like passes. Nothing tells you a run finished or needs you (26 status questions, 12 loops), `status` is refused while a controller runs, and the silent challenge was killed twice as "stuck".

- `ai-logs/runs/md-manager-workflows/viewer-clarity/viewer-clarity-001/events.jsonl`:sequence 10 (the worker packet records build exit 1 and playwright exit 1): "Required tests and artifacts passed; recorded for the candidate gate: frontend-build, project-workflows-browser"
- `ai-logs/sessions/claude/projects/-home-agentops-dev-kleros-vea/afa2430f-5cb0-4dfe-abe4-211eddeab50d.jsonl`:639 (11:10:02Z; the run had integrated at 10:44:09Z): "The session exited, montior the workflow and make sure it runs. Use a /loop if needed"

**Change.** Where: pipeline event, verify, candidate and status; automatic._decide, drive and advance_failed_checks; guardrails.run_challenge; launch.py lines 312-315; Checks.tsx. What: emit "review blocked" (blockers, P0/P1 counts, superseded reviewers), candidate reasons, "controller blocked" and lane completion; show deferred exit codes and record gate.flaky_checks. At each state that needs you, write attention.json and a project attention.jsonl line, rename the Herdr tab, run an optional WORKFLOW_NOTIFY_COMMAND, and print a 10-minute heartbeat. Stream challenge progress with its own 900 s timeout and print `resume` on Ctrl-C. `status` reads without the lock.

**Trade-off.** A few more events per run; existing message strings stay for the viewer's parsers.

### C45. Keep a main ledger: which run reviewed each commit on main, what landed unreviewed, which bases held blocked code, and which defects escaped (P1, effort M)

**Status:** **Proposed.**

**What's wrong.** On project-B main, 10 commits changed code, tests or docs outside any run, 4 of 21 merges were resolved by hand, skeleton-001 (77 files) arrived with no approving and no coverage review, and fix runs built on a blocked candidate approved only their own changes (you chose this for skeleton; the overnight agent extended it to sea-compact without asking, and encounters-core-001's base also held sea-compact-001's blocked candidate). Yet the morning summary said both reviewers had reviewed everything on main, summaries overstated fixes, and REPORT's "escaped defects" log lists only defects that gates caught. Claude Code's auto-mode classifier blocked one unreviewed merge; nothing in the workflow did.

- `ai-logs/runs/agent-workflows/project-B/operator-logs/morning-summary.md`:5: "everything reviewed by both workflow reviewers and merged; nothing pushed"
- `ai-logs/sessions/claude/projects/-home-agentops-dev-project-B/0094b893-59da-46a6-a9fa-4f48e374f4db.jsonl`:1013 (2026-09-24T10:14:38Z, after your 09:37 choice): "As you chose, the first run's code arrives with only the fixes reviewed on top."

**Change.** Where: a new project-level `workflow ledger` command (reading the registry's runs_roots); a `workflow escape` command; the review-block path and pipeline preflight (lines 891-917); the viewer's project page, the morning summary and REPORT section 6. What:

1. `workflow ledger --repo <target> --branch main` writes ledger.json next to the registry, listing: commits introduced by approved runs (base..candidate from each review bundle), with commits from a blocked run under a fix run marked "approved by delta only"; other first-parent commits, classed by path (`features/**` and CLAUDE.md as config, everything else as code); merges whose tree differs from `git merge-tree --write-tree` of their parents or from the rehearsed tree (C23); and each merged run's open P2s and accepted limitations.
2. `workflow escape <run> --defect … --found-by … --fixed-by <sha|run>` records escaped defects in the same file, and the viewer, the morning summary and REPORT section 6 read it.
3. When a review blocks, write `refs/workflow-blocked/<run>` for the candidate and for every lane snapshot and repair commit (skeleton's base held a repaired lane commit, not the candidate). Preflight tests each with `git merge-base --is-ancestor <ref> HEAD`, prints `Base contains blocked candidate <run> (<commit>); its diff is not in this review`, and pins the list in plan.json for the export, status and viewer.
4. Building a fix run on a blocked candidate counts as a gate-weakening change under C53: the pending decision names the blocked candidate and, like every fix-run launch while you are away, goes to you through C57 (decision 2) instead of the agent choosing it.

**Trade-off.** One rev-list per approved run, one merge-tree per merge, one more page to read, and deliberate chains get flagged too; in return "everything reviewed" becomes checkable, and C39 gets its list of escaped runs.

### C46. A usage-limit stop pauses the run until the reset instead of burning its deadline (P1, effort M)

**Status:** **Proposed.**

**What's wrong.** Both intel-online-001 reviewers hit the weekly limit; the controller read "blocked" as a question, waited out 3600 s and blocked with no verdict, so a 44-minute rerun followed. The transcript carries structured limit fields, and REPORT's 22 Sep "quota block" was really a refusal.

- `ai-logs/runs/agent-workflows/project-B/intel-online/intel-online-001/events.jsonl`:sequence 33 (2026-09-25T18:19:17): "Reviewer general needs attention in its pane (native state blocked); waiting until the deadline"
- `ai-logs/sessions/claude/projects/-home-agentops--local-state-agent-workflows-project-B-intel-online-intel-online-001-review-worktree/6c7e2775-c9df-441b-83d8-083285752be0.jsonl`:115 (18:19:14Z; the same record's quotaLimits holds `"rateLimitType":"seven_day"` and `"resetsAt":1790409600`): `"error":"rate_limit","isApiErrorMessage":true,"apiErrorStatus":429`

**Change.** Where: automatic.wait_reviews and wait_handoffs. What: when a session is blocked, read its last transcript entry; on rate_limit, record a quota event with resetsAt, credit the wait to that node's deadline, keep the session and resume polling; cap the pause (for example 24 h), then block with a quota reason. Record refusals separately, and allow one re-review of an unchanged bundle when no verdict was accepted. Start with a probe of whether auto-continue after a limit reset applies to --bg sessions.

**Trade-off.** It depends on transcript fields, and falls back to today's wait if they are unreadable.

### C47. Remove derived checkouts once their evidence is sealed (P1, effort M)

**Status:** **Proposed.**

**What's wrong.** Checkouts are never removed: after three days of project-B there were 243 worktrees (about 60 GB, disk at 85%), cleaned by hand after the safety check refused. VEA-002 has five identical checkouts, and raw browser-N output duplicates hashed screenshots; evidence survived the manual cleanup because it lives outside checkouts.

- `ai-logs/sessions/claude/projects/-home-agentops-dev-project-B/a169f327-9a20-48cb-95e2-5a97878b97d9.jsonl`:11419 (2026-09-27T08:31:34Z): "232 of the 243 worktrees in total, using about 60 GB. The disk is at 85% (25 GB free)"
- `md-manager/workflow/RUNBOOK.md`:291: "All run artifacts/worktrees are retained; cleanup is a separate operator decision."

**Change.** Where: checks.verify_revision; a new clean command; RUNBOOK. What: after a passed packet is saved, remove its attempt worktree, caches and browser-N output, keeping failed attempts. Add `workflow clean <run>` for terminal runs (git worktree remove, prune, close the tab), run by you or on your decision; it is not mechanical recovery, so the supervising session does not run it on its own while you are away (decision 2, C55).

**Trade-off.** It reverses the "no automatic destructive cleanup" rule (a proposal, see "Proposed, not decided by you" in Part 1), and resuming a reviewer needs its checkout re-created.

### C48. Cap operator-side spend: smaller context for long sessions, event-driven supervision, budgets for ultracode and campaigns (P1, effort S)

**Status:** **Proposed.**

**What's wrong.** Operator and development sessions were about 68% of spend, mostly replayed context. The supervising session cost $254.83, about $170 of it in loop and Monitor turns, including 143 "No change" ticks and 129 after the campaign ended; ultracode development turns cost about $870 with the usage warning off, and the weekly limit ran out unannounced.

- `ai-logs/sessions/claude/settings.json`:2: `"model": "opus[1m]",`
- `ai-logs/sessions/claude/projects/-home-agentops-dev-project-B/a169f327-9a20-48cb-95e2-5a97878b97d9.jsonl`:11295 (the reply to a loop tick, 2026-09-27T08:23:46Z): "No change: no workflow runs are active and main is still at `99139b5` with all checks passing."

**Change.** Where: ~/.claude/settings.json and the session environment; the /loop prompt and the overnight plan. What: use CLAUDE_CODE_DISABLE_1M_CONTEXT=1 or a smaller /autocompact window for supervising and development sessions; drop the fixed /loop while a Monitor is armed, and cancel it when no run is active, usage is exhausted or only you can act; start ultracode sessions with --max-budget-usd (probe first whether it applies to interactive sessions) and log cost per feature; check a campaign ceiling before each launch.

**Trade-off.** Earlier compaction drops detail that is not in the operator logs.

### C49. Record cost and time per run, and export every challenge attempt with what happened to its P0/P1s (P2, effort M)

**Status:** **Proposed.**

**What's wrong.** No run records its cost: the cost log was rebuilt by hand, misses 37 sessions and double counts continued ones, and report.html, the printed "Evidence" link, is raw JSON with no verdict or findings. The export serves only the last challenge attempt (220 earlier concerns hidden) and the latest decisions, so a paused attempt's P1 disappears once a later attempt passes, and nothing shows when an adopted alternative lost part of itself in the edit: intel-online's attempt 1 proposed checking the dock first, the edit dropped it, and attempt 3 raised the missing check as a new P1.

- `ai-logs/runs/agent-workflows/project-B/intel-online/intel-online-001/challenge-1.json`:simpler_alternative (adopted; the edit dropped the dock check, overnight-log line 161): "On the next world tick, first check the dock and look up the ledger replay"
- `ai-logs/runs/agent-workflows/project-B/intel-online/intel-online-001/challenge-3.json`:concerns[0] (P1): "never check that the buyer is moored at a dock"

**Change.** Where: guardrails.run_challenge; stop_session; export_state; pipeline.report; launch.py line 323; the viewer (Challenge.tsx, which notes that earlier attempts' concern lists are not served). What:

1. Store print-job cost and duration; after a confirmed stop, read the session's last cost state (deduplicated by startTime) into its stop file; export per-node and per-run cost, model, effort, operator-wait minutes and setup time.
2. Print the viewer link as Evidence, and have report.html carry C43's outcome block.
3. Export every challenge attempt with its prompt diff against the previous attempt, what happened to each P0/P1 (fixed by a revision commit, accepted with a reason, or not raised again), and any adopted simpler_alternative beside the edit's diff.
4. The archive's scripts, not the controller, compute course figures such as intervention minutes and overlap (C50).

**Trade-off.** Best-effort parsing of Claude Code's transcript format; matching a P1 to edited text stays heuristic until C10 requires evidence quotes.

### C50. Correct REPORT.md's causes, counts, paths and R32 row, and check its counts against the run index (P2, effort S)

**Status:** **Proposed.**

**What's wrong.** REPORT.md, the course report, calls parallel-reviewers-001's stop a "quota block" (in 5 places) when it was a safety refusal, says intel-core blocked 3 times instead of 4, and cites config/pi-schedules/ and docs/vea/tasks/, which do not exist. Its run counts disagree with each other and the record ("40 supervised runs" in one place and 37 in others, against 38 project-B run directories; README's "all 54 runs" against 55 rows in runs/index.md), and "two lanes per run plus a parallel vea/kleros review stream" is wrong on both counts (every project-B run had one lane, and the 24-25 Sep parallel stream was md-manager). The vea Pi stream ran on deepseek-v4-pro, not Codex, the archived audit file is the 15 Sep planning-pass report rather than the audit behind the 8 fix lanes (and the P0 was spotted on 15 Sep, not "~16 Sep"), and the R32 row is still TODO.

- `ai-logs/REPORT.md`:103 (the quota wording also appears at lines 38, 47, 68 and 75): "adapter quota-blocked; controller recorded the block and refused any fallback instead of pretending completion."
- `ai-logs/sessions/claude/projects/-home-agentops--local-state-md-manager-workflows-parallel-reviewers-parallel-reviewers-001-worktree-adapter/c6d0b404-dda0-4c4c-95db-dc8e32ee107a.jsonl`:172-173 (2026-09-22T22:57:58Z, stop_reason refusal): "Fable 5.1's safeguards stopped the response above"

**Change.** Where: ai-logs REPORT.md sections 3-7 and README.md line 13; docs/vea/; the archive's index and cost-log scripts. What:

1. Correct each statement by hand; every failure cause cites the event and the transcript's stop_reason.
2. Copy the VPS tasks/ directory into docs/vea/tasks/ (it holds the audit and the fix reviews), and keep the 15 Sep file as the planning-pass report, under its own name.
3. Fill the R32 row per change, with C36's component table as the default: who implemented, what was checked, and when review happened.
4. Add a short check that the run counts in REPORT and README match runs/index.md, and compute the course's evidence-log fields (elapsed time, intervention minutes, overlapping runs) in the archive's report scripts, not in the controller.
5. Provider claims are corrected under C37.

**Trade-off.** About an hour of editing, and the report reads drier; a counts check does not catch narrative errors such as the refusal.

### Stage 10. Configurability and operator attention

### C51. Optional approval stop at the end of automatic runs, showing what is still open, and a record that matches what will happen (P1, effort M)

**Status:** **Decided** (decision 3): an approval stop when the run's profile asks (attended, or code you mark critical), listing open findings and untested items (step 1); other runs finish as today, and the record stops claiming an approval gate that never fires (step 2).

**What's wrong.** Automatic runs approve themselves and end at a fast-forwarded feature branch, so 157 open findings and the workers' untested items are never put to you, and in project-B the merge into your playable build was the orchestrator's own step, outside the workflow. The record says otherwise: every packet lists integration_approval as a pending gate, all 38 project-B policies pin `integration_approval: true` (the scaffold default), and plan.json says mode "interactive" even on automatic runs. So the orchestrator told you VEA-002's integration approval "stops for your decision", and the run integrated 9 minutes later without stopping.

- `ai-logs/sessions/claude/projects/-home-agentops-dev-kleros-vea/afa2430f-5cb0-4dfe-abe4-211eddeab50d.jsonl`:636 (10:35:19Z): "then the integration approval, which stops for your decision."
- `md-manager/workflow/verification.py`:208 (written into every packet; scaffold.py line 29 defaults integration_approval to True; pipeline.py line 749 approves automatically): `"pending_gates": ["independent_review", "integration_approval"],`
- `ai-logs/runs/agent-workflows/vea/veashi-vea-addresses/veashi-vea-addresses-002/events.jsonl`:sequence 20 (node integrate, status succeeded, 2026-09-28T10:44:09.018491Z, 0.18 s after review approved): "Fast-forwarded to e1caed7ed4f2d8f0ffb480c0a79aef6ad76fad65; no push performed"

**Change.** Where: automatic DEFAULTS, validate_automatic, drive and supervise; pipeline approval; verification.py line 208; prepare and scaffold.py line 29; launch output; status and the viewer. What:

1. Allow `finish="approval"`, pinned from the profile or from a critical R32 cell: approval() interrupts as in manual mode, drive exits with a distinct code and launch prints the approve command, status and the viewer list open findings and untested items, and the approval records who approved.
2. Make the record match the behaviour now: derive pending_gates from `plan["automatic"]`, have prepare refuse `integration_approval: true` in automatic plans that do not pin finish="approval", and print the run's next step at the start of launch and in status, derived from `plan["automatic"]`, not plan.mode.

**Trade-off.** Each such run waits for one approve, and existing feature policies need integration_approval set to match their mode.

### C52. Pin model and effort per role, the controller version, and your attended or unattended profile at prepare, and record them in the run (P1, effort M)

**Status:** **Partly decided.** The attended and unattended profiles that carry your hold (C8, decision 1) and approval stop (C51, decision 3) are decided; pinning model, effort and the controller version is proposed.

**What's wrong.** Effort applies to workers only, and no run records model, effort, CLI version or controller commit: worker effort drifted high, medium, high, medium, the knob lives only on feature/viewer-ux (it once ran uncommitted), runs execute the live development checkout, and deadlines and model are retyped on every launch. Judge effort follows whichever host runs the controller and shows only in transcripts: 92 of 96 reviewer sessions ran at high, but both reviewers of viewer-clarity-001 and of portable-workflow-001 ran at medium, including the viewer-clarity coverage approval questioned in this review, while your Mac's settings say xhigh.

- `md-manager/workflow/sessions.py`:259 (worker_effort docstring): "The challenge and the reviewers never take it"
- `ai-logs/sessions/claude/projects/-home-agentops--local-state-md-manager-workflows-viewer-clarity-viewer-clarity-001-review-worktree/cbe6b472-37ab-4f83-b12c-42634612f59c.jsonl` (the coverage reviewer, 38 of 38 records with an effort field; the general reviewer 612e0331 has 41 of 41): `"effort":"medium"`

**Change.** Where: sessions.worker_effort; interactive.run and run_reviewer; print_command; prepare; the export; challenge.json and `automatic-review-<id>.json`; ~/.config/md-manager; ~/.local/bin/workflow. What:

1. Pin plan.roles (worker, challenge, reviewers) with model and effort, from a flag, the feature or a profile; pass them on every claude call, and strip inherited `CLAUDE_*` variables.
2. Copy the pinned role settings into challenge.json and `automatic-review-<id>.json`, so a replay (C39) can match them.
3. Pin the controller commit, a dirty flag and `claude --version`, warn when they change, and point the wrapper and the grill symlink at a release worktree.
4. A named profile (`launch --profile attended|unattended`) supplies the hold, approval, deadlines and roles.

**Trade-off.** Pinned roles cannot change on resume, and reviewer effort becomes lowerable (pinned at high as a proposal, see Part 1); replays are comparable only under the same pins.

### C53. Ship short orchestrator rules with the tool, including presence and how to ask you, and keep md-manager's own fixes and design docs in its repo (P1, effort S)

**Status:** **Proposed.**

**What's wrong.** Orchestrator rules live in per-project memory and CLAUDE.md copies that drift apart, and the agent was corrected 22 times: "i dont think we need tests" became a weaker policy within 2.5 minutes, 59 overnight decisions (some dropping gates) were never acknowledged, fixes sat on stranded branches, and lane-repair-design.md was never committed or named. Presence and policy questions were handled in prose: the loop prompt said you were asleep for 52 hours after you woke, and the autonomy question was asked 11 times inside status messages and never answered directly, holding launches for 3.5 hours with no evaluation. Meanwhile all 4 AskUserQuestion prompts, each asked within about 2 minutes of a message from you, were answered in 18 s to 11 min.

- `ai-logs/sessions/claude/projects/-home-agentops-dev-project-B/a169f327-9a20-48cb-95e2-5a97878b97d9.jsonl`:4482 (the /loop prompt at 2026-09-25T04:33:39Z, after you woke at 04:32; it fired until 27 Sep 08:27): "The operator is asleep; make the decisions yourself and note them."
- `ai-logs/sessions/claude/projects/-home-agentops-dev-project-B/a169f327-9a20-48cb-95e2-5a97878b97d9.jsonl`:5646 (2026-09-25T09:34:57Z, the 11th ask in prose): "Should I keep launching and merging on my own, or check with you first?"

**Change.** Where: workflow/OPERATOR.md; ~/.claude/CLAUDE.md; the overnight plan file the loop reads; md-manager docs/design/. What:

1. Ship workflow/OPERATOR.md (at most 15 lines), imported from ~/.claude/CLAUDE.md, with these rules: show commands, then run them in a new Herdr tab; no controller edits during live runs without a yes; never label agent text as yours; ask before dropping a check kind; while you are away, do only mechanical recovery (resume after a crash, retry a failed check, relaunch a stuck session, recorded as maintainer) and send every other decision, gate-weakening changes included, to you through C57; confirm the feature before a grill; keep `presence: here|away since <time>` in the plan file the loop reads, set from your messages and never written into a cron prompt; ask a policy question once: right after you have written, as an AskUserQuestion with a Recommended option, or through C57 while you are away; set no deadline, because an unanswered question waits with a reminder and nothing is decided without you (decision 2b); store the answer in that file.
2. Repo hygiene: one fix per branch, merged or dropped the same day; cherry-pick 07029ab, 8508930 and 1a39ddb onto main and re-apply f3be881 (C18); commit design docs, starting with lane-repair-design.md, under docs/design/, and keep the issue list in the repo.

**Trade-off.** Rules bind only as instructions, so the code changes in this list carry the important ones, and a forgotten "away" makes the agent ask more than it needs to.

### C54. A `workflow doctor` probe after each Claude Code update checks, through each role's own transport, what sessions actually receive (P1, effort S)

**Status:** **Proposed.**

**What's wrong.** The workflow's isolation rests on CLI flags whose effects nothing tests; preflight only checks that `claude --help` lists them. The 23 Sep audit listed --safe-mode as unverified, and that night a --bg probe printed that safe mode disables CLAUDE.md, 5.5 h after the docs began claiming workers read it. C14, C15, C18, C19 and C46 all depend on CLI behaviour any update can change, --bg sessions start in the background service's environment (so a print-mode probe cannot show what a worker receives), and whether deny rules hold under --bg is still untested.

- `md-manager/workflow/pipeline.py`:902-910 (preflight): `if not all(flag in help_text for flag in required_flags):`
- `ai-logs/sessions/claude/projects/-home-agentops-dev-md-manager/7579e0f3-92af-47b0-b407-1cfb21a9be7a.jsonl`:3385 (2026-09-23T23:42:21Z, `claude logs` of a `claude --bg ... --safe-mode` probe on CLI 2.1.281): "Safe mode: all customizations are disabled (CLAUDE.md, skills, plugins, hooks, MCP, agents, and more)"

**Change.** Where: a `workflow doctor` command (or `preflight --probe`); preflight; a RUNBOOK isolation section. What:

1. `workflow doctor` runs a few cheap probes with the workers' exact flags, each through its role's transport (`claude --bg` plus `claude logs` for workers and native reviewers, print mode for the challenge and print reviewers), checking that a CLAUDE.md marker reaches the prompt (C15), a deny rule refuses (C19), the sandbox starts and refuses a read of ~/.config/gh (C14), and --settings env reaches the Bash tool.
2. Doctor records the CLI version it passed for, and launch refuses when the pinned `claude --version` (C52) has no passing doctor record.
3. Add a RUNBOOK section listing what sessions do and do not load, with the probe results.

**Trade-off.** A few model calls per CLI update, and the probes cover only what they test.

### C55. Enforce the unattended monitor's authority with tools, not prompt text, and narrow what it may type into workers (P2, effort S)

**Status:** **Decided**, adapted to your Telegram answer (decision 2): the supervising session does only mechanical recovery; every decision goes to you through C57.

**What's wrong.** The overnight kleros-v2 /loop ran in auto mode, limited only by its prompt, whose mandate let it edit task and decisions files, accept challenges, answer, retry and repair; during an unattended tick it created a PR-ready branch and commit in the company repo, which its "local commits only" rule allowed. Its answers are typed into worker panes running bypassPermissions, and RUNBOOK treats that input as yours, so even a narrowed monitor keeps full authority through "answer".

- `ai-logs/sessions/claude/projects/-home-agentops-dev-kleros-kleros-v2/de0afaad-c8d0-411c-b4b3-a2b8e5555768.jsonl`:604 (2026-09-28T08:18:20Z, the /loop arguments): "edit features/shutter-reveal-justification task/decisions files and run `workflow resume <run>`"
- `md-manager/workflow/RUNBOOK.md`:72: "CLI/manual terminal input is trusted operator authority."

**Change.** Where: the unattended profile (C52); the shipped orchestrator rules (C53); the monitor's own launch. What:

1. Run each unattended monitor as its own session, with --restricted, or dontAsk with Read, Glob and Grep, one Edit allow rule for its log, and Bash allow rules for exactly the mechanical-recovery commands (resume, check retry, session relaunch, each with --by maintainer) and the command that hands a drafted plan to the bot (C57 step 3).
2. It may run only mechanical recovery through the controller's gates (resume after a crash, retry a failed check, relaunch a stuck session), recorded as maintainer (decision 2); every other decision goes to you through C57.
3. It sends workers no text of its own; a worker's question goes to you through C57 and the lane waits for your answer.
4. Free-text answers, task or decisions edits, and git commands wait for you; a free-text reply you send on Telegram is drafted into actions that you confirm (C57).
5. Turn on step 1's restricted launch after C14; steps 2-4 apply from C57's launch.

**Trade-off.** Overnight runs stop at more pauses, and --restricted still has to be confirmed on the VPS CLI; /loop is a skill, which --safe-mode would disable, so the monitor needs its own launch.

### C56. Keep workflow files out of third-party PR branches with an automated pr-branch, launch from per-run clones, and keep a feature queue (P2, effort M)

**Status:** **Proposed.**

**What's wrong.** You asked 4 times to keep workflow files out of pushed history, and agents improvised local branches (which did produce clean PR branches), a pre-push hook that can be bypassed and a hand cherry-pick for PR #526. Launch switches your checkout, so parallel runs needed 9 extra clones; lanes share your .git, where one husky install flipped hooksPath and broke your commits; and the slice queue lived in chat. The earlier .git/info/exclude idea would fail: excluded files are missing from every worktree, and all 3 Kleros policies run `features/_shared/*.sh` during verification.

- `ai-logs/sessions/claude/projects/-home-agentops-dev-kleros-vea/afa2430f-5cb0-4dfe-abe4-211eddeab50d.jsonl`:64 (2026-09-28T09:55:00Z): "remember all these should in a different branch we xont want to push these workflow and claude files to origin"
- `workflow-audit-evidence/gap-1-2/reproduce_shared_git.log`:step 8 (result: absent): "an untracked file listed in info/exclude in the main checkout does not exist in a new worktree:"

**Change.** Where: a `workflow pr-branch` command reusing the candidate's cherry-pick loop (pipeline.py:543-547); launch.py (line 220) and sessions.prepare; scaffold.init; a queue command. What:

1. Keep the local workflow/base branch and add `workflow pr-branch <run> --onto origin/<branch>`, which replays the lane snapshot commits onto a new branch with hooks off, so a PR branch never carries workflow files.
2. Launch each run from a `git clone --shared` of your checkout (near-instant, since it reuses your objects): the run gets its own config, hooks and info/, lanes have no GitHub remote, your checkout is never switched, and integration fetches the candidate back.
3. Add features/QUEUE.md, read by `workflow queue`, which prints the next launch once its dependencies have integrated.
4. Do not use .git/info/exclude.

**Trade-off.** Integration becomes a fetch and the base commit must stay reachable (refs/workflow/... refs can keep it so); the pre-push guard stays, but only for your own pushes.

### C57. A Telegram decision channel: decisions come to your phone when you are away, and the supervising session only does mechanical recovery (P1, effort M)

**Status:** **Decided** (decision 2, your proposal, with follow-ups 2a-2e, where you took the recommended options; your question at 2c was settled by 2e). The list of decision states in step 1 and the security rules in step 7 are the audit's design and are proposals.

**What's wrong.** The supervising session decided for you, mostly while you were away: it resolved the 35 project-B challenge pauses (median 0.71 min; about 10 came while you were messaging it, and you ran one of those resumes yourself) and made about 55 of the 59 logged overnight decisions, and because the run record names no actor, its actions read as yours (C17). It asked the autonomy question 11 times inside status messages and never got a direct answer (C53), and nothing tells you when a run needs you (C44).

- `ai-logs/sessions/claude/projects/-home-agentops-dev-project-B/a169f327-9a20-48cb-95e2-5a97878b97d9.jsonl`:4482 (the /loop prompt at 2026-09-25T04:33:39Z, after you woke at 04:32): "The operator is asleep; make the decisions yourself and note them."
- `ai-logs/sessions/claude/projects/-home-agentops-dev-project-B/a169f327-9a20-48cb-95e2-5a97878b97d9.jsonl`:5646 (2026-09-25T09:34:57Z, the 11th ask in prose): "Should I keep launching and merging on my own, or check with you first?"

**Change.** Where: C44's attention record (attention.json and the project attention.jsonl); a small bot process that long-polls the Telegram Bot API (outbound only, no open port); the controller commands each option maps to; C17's --by attribution; C55's monitor profile. What (your answers in brackets):

1. Every state that needs you writes a pending-decision record: a challenge hold (C8), a P0/P1 challenge pause or a refused rerun (C11), an approval stop (C51), a worker question (C16), a change to your decisions (C4), a dropped check (C27), a tryout request (C7), a launch past the tryout limit (C29), a fix run after a review block (C30, C31) and a triage job's P0/P1 sent to you (C41, decision 12). Each record has an id, the options with their consequences, and the exact controller command each option runs.
2. When you are away from the desk (the presence line in C53's plan file), the controller's bot sends it with one button per option [the recommended option at 2c; your question there was settled by 2e]; at the desk it reaches you in the terminal and the viewer (C44). A tap runs that command with `--by operator` and records the Telegram message id; a tap on a decision that is no longer pending is refused.
3. A reply in your own words [allowed] is stored verbatim as your decision. The supervising session drafts the concrete actions (for example the decisions.md edit and the resume command), and the bot sends them back for a confirm tap before anything runs [the agent drafts, you confirm]. After your tap, the bot applies the drafted edit and runs the commands with `--by operator`, recording the plan with the decision; the restricted monitor (C55 step 1) cannot edit decisions.md itself.
4. A message carries the decision, the options with consequences and the run id, and points to the full details in the viewer. It never carries code, diffs or file contents [summary + pointer]; Telegram bot chats are not end-to-end encrypted.
5. Without a reply, the run stays paused, independent runs continue, and a reminder goes out after a set interval; nothing is decided without you [keep waiting].
6. While you are away, the supervising session may act only for mechanical recovery, through the controller's gates and recorded as `--by maintainer`: resume after a crash, retry a failed check, relaunch a stuck session [mechanical recovery only]. Anything that changes scope, decisions, checks or approvals goes to you.
7. Security: the bot accepts updates only from your chat id, keeps its token where workers cannot read it (C14's read-deny list; until C14 lands, run the bot as a separate OS user), and binds each button to its pending decision with a one-time nonce.

**Trade-off.** Runs wait for you more often (21 of 38 project-B runs paused at least once), but on your phone rather than until you are back at the desk; one more long-running process to operate; and a free-text reply takes one extra round trip.

## Part 4. Keep

- **Independent reviewers bound to the exact candidate.** 0 of 96 sessions read another reviewer's file, verdicts bind to launch token and bundle hash, and the general reviewer caught the remote-image issue the loop missed; keep them off earlier verdicts, but give them worker disclosures (C35).
- **Verbatim requirement quotes.** 199 of 199 non-null requirement quotes occur verbatim in the task text; add the same check before findings may quote decisions.md (C4).
- **Workers pre-run every check.** 42 of 42 lanes ran every policy check and 22 of 22 browser lanes ran check-report, which removed late failures; extend it with `check-report --log` (C41).
- **Honest completion fields and ownership.** VEA-002's worker disclosed the silent route skip and the untested extract chain, and 55 runs had 0 ownership violations; what is missing is routing disclosures to review (C35).
- **The P0/P1 challenge pause and resume's revision path.** 47 blocking concerns stopped 24 runs before any worker, and 34 revision commits each touched only decisions.md and the task, while the stage costs about 3.3% of spend; add C11's refusal of unchanged reruns.
- **Fail-closed gates with evidence outside checkouts.** No integrity violation in 124 packets, a cross-lane TS2367 mismatch caught at the candidate gate, and 242 worktrees deleted with evidence intact, which makes C47 safe.
- **Fast, tracked fixes after run pain.** The issue list you asked for on 23 Sep at 20:22 was ticked by about 05:30, `workflow repair` unblocked skeleton-001 in 8 minutes, and six gate fixes landed with tests in four days; move the list into the repo (C53).
- **The shutter grill's habits.** It checked a premise in code before asking, stopped at 3 questions, recorded rejected options under Deferred and waited for your go-ahead; it is the template for C1-C3.
- **Configuration pinned at prepare.** 44 one-lane, 11 two-lane and 48 two-reviewer runs plus custom briefs, all validated on every load; reuse the pattern for roles, holds and approval (C52, C8, C51).
- **Real-use proof named in the task.** Where a task named it, the challenge found sea-compact's diagonal-slide P1, a docking gap in each of docking-feel's 6 attempts and economy-online's 500 ms hold-grace flaw; put real-use lines into tasks (C7), at the cost of extra attempts.
- **Running the code.** Your first plays, a subagent, a headless probe and a 3-minute real-data smoke test found defects the reading reviewers missed (about 6 hands-on sessions found 2 escapes); make it a recorded step (C38, C7).
- **Reviewers trace defects to the line.** intel-core-001's coverage P1 named step.ts:344 and 370-379, match-online-fixes-001's discarded general P1 named functions, spec sections and the fix, and tests built from both reproduce the bugs; keep that bar for blocking findings (C34), since the losses happened in the gate (C33).
- **Committed branch tables.** Coverage blocked 0 of 5 game runs that had a `docs/<feature>-coverage.md` table against 3 of 6 before (p ≈ 0.12, confounded), but one row certified the hold reset behind the 25 Sep escape; keep them for code with many branches and make rows evidence (the worker commits each "tested" row's branch deletion as a patch, and checks.py applies a sample and expects the named test to fail).
- **Read-only roles stay read-only.** Reviewers and the challenge run in dontAsk mode with read tools only (native reviewers may write just their completion file) and no MCP servers, and all 40 attempts across 93 session dirs to read outside the worktree and run directory were denied; reuse this profile, plus Bash allow rules for the mechanical-recovery commands, for unattended monitors (C55).
- **No worker pushed, and your local safeguards held.** Across 60 lane-worker transcripts no worker ran git push, commit or config, gh or ssh, or read ~/.ssh, ~/.config/gh, ~/.bashrc, ~/.pi or a .env file, and HUSKY=0, the Vea pre-push guard and the controller's hooks-off commits all held; move them into the controller (C14, C25).
- **check_ownership enforces file boundaries mechanically.** Freeze refuses any changed path a lane does not own; because it works by path prefix, add optional excluded sub-paths for "never change" files inside owned directories (VEA's generated veashi-sdk files).
- **Different judges and briefs find different defects.** The 23 Sep Codex hunt found 7 controller defects first (6 min, about $5), Claude's safety reviewer found the hook and info/exclude escapes Codex scoped out, and the /loop flagged print-order collection about 7 h before Codex; keep the split roles, add C37, and send every finding to one ledger (C31), since all 16 audit findings stayed open.
- **The orchestrator goes back to the record when you push.** kleros-v2's 28 Sep report and viewer-ux-panels-lists-003's summary matched review.json, and when questioned it checked the record ("Let me pull up what the design challenge actually said"); make that the default (C43).
- **The written operator logs.** The overnight log kept caveats and labels the summaries dropped ("by its own report (not yet confirmed by the verifier)"), and its 196 lines and 59 numbered decisions made this audit possible; generate its skeleton from events and derive summaries from run records (C43).
- **Pure features ran unattended overnight.** 14 of 21 overnight runs had no browser check, and intel-core was approved on its fifth run after coverage traced a real bug; exempt pure features with an explicit `tryout: false` and carry their feel decisions to the card of the feature that wires them in (C29, C7).
- **Writing by hand and auditing with AI.** It produced the only P0 on company code (fix/val-doc-1, audited in 8 min for $0.47) and exploit-class findings on the hand-written kleros-v2 gateway contracts; keep it for critical code you choose to write by hand (C36, decision 9), credit it for the hazard class rather than the diagnosis, and reproduce each P0/P1 through the entry point (C30, C21).
- **A repository hazard brief.** val1-tester's brief ("A block *number* or block *tag* from one chain is meaningless on another.") pointed reruns at the watcher wiring gap, though its "Known hotspot" stated a wrong mechanism; keep stable hazard classes in CLAUDE.md (C15) and per-audit leads in audit records (C36).
- **Intent questions went to you, not the fixer.** The pipeline held validator-fix-5 until you answered "For this task i want to remove heartbeat logic", and the review then passed; in audits, ask about intent only for findings that turn on it, after a blind first pass (C36).
- **Schema-bound verdicts and the open-P0/P1 rule.** They stop what Pi's regex gate let through (a missed "Verdict: FAIL", a PASS with an open P1, a commit with an open P0); reuse review_schema and blocking_findings in C36, and count an unparsable review as failed.
- **Samples agree on concerns; the label varies.** Subjects any sample rated P1 were mentioned in 47 of 57 subject-samples but rated P1 in only 23; route by the concern list, not one sample's label (C8, C9, C13).
- **Every challenge and review can be replayed from the archive.** Prompt files, pinned digests and the --binary review.diff let 40 replays rebuild archived inputs, and replays reproduced the archived P1 subjects in 3 of 4 samples on sea-compact and on intel-online; C39 builds on it, and C52 records the effort and CLI version that today live only in transcripts.
- **A rule written into every task held.** From 24 Sep 16:04 all 29 later project-B lane prompts carried the no-pattern-kill rule and none of those workers ran one, while the 3 Kleros tasks lacked their repositories' rules; deliver repository rules as pinned prompt text (C15), with mechanical guards for harms that cannot be undone (C19, C14).

## Part 5. Corrections to earlier conclusions

### What Claude told you earlier in this session

1. **VEA testnet-only scope** (incomplete). The orchestrator wrote "testnet only" (and "Devnet excluded") into the PRD and task at 10:13:18; the grill, in the same session 6 s later, treated it as settled and deferred mainnet and Devnet without a question, and decisions.md was not shown before the 10:25:03 launch. Your verbatim request was in the PRD and read by both challenges and the general reviewer, and its literal words support the reading, so only a question could catch it. PR #526 was opened, not shown merged.
2. **Provenance fields from grill Q5** (incomplete). The label "Addresses only" contradicts its description "Addresses + provenance", no listed option left provenance out, and the summaries you got before each worker started omitted it (after the grill, the fields came up only in passing at 10:35, once run 002's worker had started); challenge 002's "keep it in the JSON only" was relayed in the pane note without asking you.
3. **The forwarded P2s and the worker's fallback** (partly wrong). The fallback came from challenge concern #4 itself; the P2s were typed into the pane before you saw them (your "send these" was about run 001); the worker had already written the map; the note was labelled "Operator note" though the orchestrator wrote it; and three reports to you then said or implied that chain ids come from .chainId (the 10:35 message, the 11:11 report that the worker applied all four notes, and PR #526). The map came from the 10:13 task draft and the router table from challenge 001's alternative.
4. **The SDK pattern named only for the getters** (incomplete). The orchestrator had read generate-types.sh in full before drafting; grill Q2 offered generation inside it, framed as untestable, and you declined; the session then removed it from owned paths; the worker read only 40 lines; and because run sessions start with --safe-mode, the CLAUDE.md describing the SDK flow was not loaded.
5. **Task Context duplicates the decisions Assumptions** (incomplete). The overlap is restated facts (median 0% verbatim), driven by reviewers quoting only the task; the package.json "files" contradiction came from the pane note, not from task versus decisions.
6. **Self-reported verification** (imprecise). vea-data-fresh also proves the committed JSON equals generator output but checks no addresses, and as kind build it did not gate the worker phase, where typecheck gated with an empty log; `node -e` prints MISMATCH but exits 0, falsifying_check names typecheck, verify_yourself was turned into acceptance evidence, and the orchestrator's assertions live only in its transcript.
7. **Duplicated review artifacts** (incomplete). A finding is stored 11-12 times across 6 files; accepted_decision is crash-recovery state, `decision` is read by no production code, print transport writes only `decision`, and blocked runs have no .review copy.
8. **viewer-clarity-001's coverage approval and loop findings** (incomplete). Coverage approving despite its own rule is systemic (25 of 29 approvals); 13 of 14 diff-visible loop P3s were still in the code at b92ff7d; 2 of the 4 runtime signals were in the review bundle; and loops also missed skeleton-001's security P1.
9. **Both reviewers get the same context** (incomplete). Identical in 43 of 43 runs; the shared context also omits workers' untested, falsifying_check and verify_yourself, and mid-run notes, while general reviewers still opened the PRD in about half their sessions.
10. **lane-repair-design.md and the repair commits** (incomplete). 26b5e83 (on main) and 791535b (only on fix/lane-repair) are one change on different parents; the doc was never committed or named; the command ran once; repair --session was never built.
11. **Effort applies to workers only** (verified, with additions). It was deliberate per 07029ab; no run records effort or model; worker effort went high, medium (23 Sep, before the knob), high, medium; all 82 challenge sessions ran at high; and 07029ab exists only on feature/viewer-ux, written by a supervising agent without waiting for a yes.

### Other claims that did not hold

- **Workflow workers read the target repository's CLAUDE.md** (workflow/README.md:31, the init starter file, PRD_PORTABLE_WORKFLOW.md:30): every launcher passes --safe-mode, and 0 of 199 run sessions loaded it (C15).
- **"Nothing ever merges main or pushes"** (workflow/README.md line 3): true only of the controller; workers run as your account with a repo-scoped gh token and an SSH key without a passphrase, and the --bg prompt tells them to push (C14).
- **Everything on project-B main was reviewed by both workflow reviewers** (morning summary): 10 commits changed code, tests or docs outside any run, 4 of 21 merges were resolved by hand, and skeleton-001 had no approving review; you knowingly approved 2 of the 10 commits (C45).
- **Pi/Codex reviewed the work alongside Claude** (REPORT.md lines 18, 32 and 147): every judge in all 55 runs was Claude, and the at least 7 Codex or DeepSeek reviews all fell on 19-23 Sep, before 48 of the runs (C37).
- **A Codex challenge or reviewer would have caught VEA's scope, provenance or network misses**: the 5 Codex challenge replays and the 4 Codex reviewer replays that read the code raised neither scope nor provenance; all 5 challenge replays recommended an explicit route table, and the reviewer replays approved with one P2 each.
- **The 9 follow-ups to test-debt blocks were pure waste, costing $90.02**: 5 also fixed P2-rated defects and one would have run anyway; only $26.63 bought nothing but tests, docs or refactors, so the saving that holds is $40 to $71 (C34).
- **The 25 Sep hold-cancel escape was invisible to review**: sea-compact-001's worker disclosed the 250 ms lapse and a reviewer flagged it P2 on 24 Sep, and match-online-fixes-2-001 later added a test asserting the buggy reset, which both reviewers approved (C31).
- **match-online-fixes-001's general reviewer was stopped without a verdict** (overnight log line 130): it wrote a bound, blocked verdict with a P1 2 s before the coverage block was accepted, and the P1 is a live bug on main (C33).
- **PR #526: "It takes chain ids from each network's .chainId"**: the generator builds the route key from a hardcoded NETWORK_CHAIN_IDS map and only checks each .chainId against it, as the worker's completion correctly said (C43).
- **The candidate gate never failed, and the worker gate passed first time in 39 of 41 runs**: both hold only in the 41 guarded runs (40 one-lane); overall the candidate gate blocked 2 of the 50 runs that reached it, and since build and browser were mostly deferred, it was the only gate on those outcomes (C28).
- **Capping concurrent runs would protect your review capacity**: runs with a browser check never overlapped; what grew was the stack of untried user-facing features (C29).
- **No AI review of company code applied the course's Web3 exploit questions**: on 22 Sep Claude reviewed the hand-written kleros-v2 gateway contracts and found a free-DoS/orphan-dispute vector, ETH stuck with no refund path, and a relayer that can relay a dispute with an arbitrary templateId and still collect reimbursement (C36).
- **The 24 Sep pattern kill happened because CLAUDE.md never reached the worker**: the kill came at 15:27, before the rule existed, and that worker had read CLAUDE.md in full (C19).
- **kleros-v2's isUndefined P2 came from CLAUDE.md not reaching the worker**: CLAUDE.md never names the helper, and the worker replaced it on purpose because vitest could not load src/utils.
- **REPORT.md's 22 Sep "adapter quota block"**: it was a model refusal; usage limits were hit only on 15 and 25 Sep (C50).

## Appendix. Method, side effects, grill record and unverified items

### How the audit ran

Twelve areas (your notes, grill and decisions, task authoring, design challenge, workers, checks and gates, fix cycles, reviewers, live loop reviewer, operator corrections, artifacts and cost, configurability) each produced findings that an evidence refuter and a design critic then checked, and a merge step removed duplicates across areas. Two gap rounds of five investigations each looked for what the areas missed (for example credential exposure, the controller defects only Codex found, the theft-window reproduction on project-B main, company-code audits, and replays of archived challenges and reviews), with their own refuters and critics. A final agent drafted the document and another checked every cited path and quote. 73 agents ran for about 9.4 hours (29.8M subagent tokens), all pinned at max effort; a first attempt was stopped because its agents' effort was not pinned and most of it ran at low.

The cited replays, probes and reproductions are copied to workflow-audit-evidence/ next to this file; the full working folder (2.3 GB, mostly repository clones) lived in the session's temporary scratchpad. workflow-audit-evidence/audit-merged.json holds the merged findings under the merge step's ids (GRILL-1, AUTH-1, ...), and workflow-audit-evidence/id-map.txt maps them to C1-C56.

### What the audit's agents ran besides reading

The audit's prompts kept the archive and the source read-only but did not forbid running tools, and some agents ran them:

- 29 Claude replays of archived challenge and reviewer prompts with the workflow's own flags (Opus 5.5 at high effort, as archived): $39.31 by the CLI's own count.
- 11 Codex jobs (`codex exec`, model gpt-6-astra, read-only sandbox): 5 challenge and 6 review replays of VEA-002. They sent the VEA challenge and review prompts (your request, the PRD, the task and decisions.md) and a snapshot of the vea repository to Codex; the first three ran with your Codex user config, MCP servers included.
- A few `claude -p` probes on Haiku: a CLAUDE.md canary with and without --safe-mode, and deny-rule probes with the workers' flags (bypassPermissions) that ran only `echo` and `pkill -0` against a process name that does not exist.
- `npm ci` and one integration test in a scratch clone of project-B, which reproduced the theft-window bug.
- Local git experiments in scratch repositories (hooks in a shared .git, info/exclude, push-URL rewrites).
- One unauthenticated request to github.com to check whether mani99brar/ai-logs is public (it returned 404).

Nothing was pushed or published, and nothing was written outside the scratchpad except the evidence copied next to this file.

### Grill record (3 Oct 2026)

Questions as asked; your own words are quoted verbatim. You took the recommended option in 15 of 19 answers; two were in your own words (a proposal at 2, the Telegram channel, and a question at 2c, which 2e settled), and two declined the recommendation (7 and 9).

1. How should you review design-challenge findings before workers start? Offered: opt-in hold (recommended), the challenge inside the grill, P0/P1 only (today), hold every run. **Answer:** opt-in hold (recommended).
2. While you're away, how much may the supervising Claude session do at gates and in worker panes? Offered: gates via the controller (recommended), the same plus free-text answers, everything waits for you, anything (today). **Answer:** "I was thinking of adding a communtionction step for decisions, if i am not at the desk it will send me texts on tg where i ll take the decision"
   - 2a. Besides the decisions it sends you on Telegram, may the supervising session act on its own while you're away? **Answer:** mechanical recovery only (recommended).
   - 2b. When a decision request on Telegram gets no reply, what should happen? **Answer:** keep waiting (recommended).
   - 2c. What should send the Telegram messages and apply your replies? Offered: the controller (recommended), the Claude session. **Answer:** "DO i get the felixibility with the controller, what if i want a decisions which is not part of the message", settled by 2e.
   - 2d. How much detail should a Telegram decision message carry, given some runs are on company (Kleros) repos? **Answer:** summary + pointer (recommended).
   - 2e. When you reply on Telegram with a decision that isn't one of the listed options, how should it be applied? **Answer:** the agent drafts, you confirm (recommended).
3. Should automatic runs stop for your approval before the feature branch is fast-forwarded? **Answer:** when the profile asks (recommended).
4. When should the coverage reviewer block a run? **Answer:** shown failure (recommended).
5. What should stop automatic workers from using your credentials? **Answer:** sandbox + read-deny (recommended).
6. How should the target repo's CLAUDE.md reach workflow sessions? **Answer:** pinned, all roles (recommended).
7. When you decline tests for a feature, what should prove its acceptance items? Recommended: a pinned check script. **Answer:** self-report (today).
8. Should choices you didn't make yourself bind a run the way your answers do? **Answer:** only yours bind (recommended).
9. Should launch refuse AI worker lanes on critical company code? Recommended: refuse, you write. **Answer:** decide per feature.
10. How should hands-on tryouts of user-facing features fit into the workflow? **Answer:** tryout record (recommended).
11. In runs where you don't hold the challenge, where should its concerns go? **Answer:** to workers, advisory (recommended).
12. What live watching should runs have while workers are running? **Answer:** signals + triage (recommended).
13. How long should the final document be? **Answer:** plan + reference (recommended).
14. How should the 16 smaller choices the audit made on its own (e.g. a 10-min grace for the second reviewer, a recorded 'workflow note' command, auto-deleting worktrees) be recorded? **Answer:** mark as proposals (recommended).

### Raised but not independently verified

- **Medium worker effort saves cost.** Cost per message and per tool call is the same at medium and high, and all high-effort runs were the earliest features; keep medium, but record it (C52) and compare like for like before claiming savings.
- **The committed branch-to-test table caused first-round approvals.** 4 of 4 wiring features with it against 1 of 4 before, confounded by an empty-untested rule and maturing code; this decides whether C6 offers the table as opt-in or default.
- **A fresh-context grill finds more.** One case (skeleton), confounded by an operator-invoked grill with longer answers, and the cleanest run came from a same-session grill; do not move the grill to a fresh session on this evidence.
- **CLI behaviours the proposals rely on.** Whether the stale "state working" still occurs, whether auto-continue after a limit reset applies to --bg sessions, and whether --max-budget-usd applies to interactive sessions were not tested, so C18, C46 and C48 start with a probe; whether deny rules hold under --bg is also open (C54).
- **The cost of a periodic watcher.** Complete challenge print jobs cost a median $0.96, so 8-12 periodic passes would cost $5-12 per run (an earlier $2-5 estimate was wrong); ad hoc loops measured $2.8-16.4 per run. This favours C41's event-triggered jobs.
- **Two inferences inside verified findings.** That a browser player can send the late theft choice (C33), and that the entry-point harness would have caught F1, F2 and the threading defect (C21), are inferred, not executed.

Settled since earlier rounds, so no longer on this list: --safe-mode hides CLAUDE.md from --bg run sessions (0 of 199 run sessions loaded it, including all 119 started with claude --bg, while 5 of 7 orchestrator sessions in the same repos did; a 23 Sep --bg probe printed it, and the canary probe returned NONE), and the dropped match-online-fixes-001 P1 is a live defect (a test built from it failed in 5 runs by two agents on project-B main 99139b5 and passed in 4 control runs with a one-line guard).

### Refuted claims not covered above

- **Coverage gaps never block.** Coverage blocked 11 of 39 verdicts, all on project-B, mostly on P1 test gaps, each followed by a fixes run.
- **No stage offered mirroring generate-types.sh.** Grill Q2 offered generation inside it, framed as untestable; what was never offered was a standalone script following its file-driven pattern.
- **The challenge and reviewers never saw your verbatim request.** prd.md line 5 holds it; both VEA challenges read it first, and the general reviewer read it at 10:43:11.
- **Reviewers almost never open the PRD (4 of 80 sessions).** Measured with each run's PRD path, 24-25 of 80-82 sessions opened it, general reviewers about half the time.
- **Pi sessions contain no grill.** A 19 Sep Pi session asked 16 questions in tables, and you overrode 5.
- **Earlier challenge attempts survive only in events.** 36 `challenge-<n>.json` records are archived (175 P2, 44 P1, 1 P0).
- **Brief Claude outages stop runs.** Claude calls retry for 60 s and auto-update is off; after the 23-24 Sep fixes the only "unavailable" stop followed the agent's own `claude stop`.
- **Long 1M-context sessions are never compacted.** a169f327 compacted three times (manually at about 702k, automatically at about 967k twice), and two other sessions compacted manually.
- **The supervisor fired 166 ticks into the usage limit.** 84 turns got the limit message (82 /loop firings and 2 Monitor events); 166 counted system rows.
- **workflow-unit was near its 1200 s timeout.** 911 s was one worker-side run under load; controller runs peaked at 577 s (48%).
- **Only skeleton-001 ever acted on loop findings.** parallel-reviewers-001's log fed commit 3c7354c, and its fixer cron launched the follow-up run 4 minutes after the block.
- **VEA's task and decisions.md contradicted each other on package.json files.** They agreed; the unpinned pane note contradicted both.
- **The wrong-PRD grill was an agent error.** You misremembered; the agent found no other planned PRD, and you confirmed the portability PRD.
- **PR #526 was merged.** It was opened; nothing shows a merge.
- **Codex's fourth high-priority item was the integrate race.** It was the phase binding of cached packets; the race was a subagent P1 that the Pi parent moved to "Documented limitations—not additional defects", and RUNBOOK already told operators to keep other writers out.
