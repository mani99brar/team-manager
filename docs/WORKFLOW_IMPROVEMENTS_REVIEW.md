# Review of WORKFLOW_IMPROVEMENTS.md

A challenge pass over the 57 changes in `WORKFLOW_IMPROVEMENTS.md`, run on 3 Oct 2026 against main at ce23d44. Eight group reviewers each checked the audit's claims in the current code, and a skeptic per group tried to refute their verdicts. Two whole-plan critics then looked for conflicts and gaps. All agents were read-only.

The audit read the controller at b92ff7d (27 Sep). Since then:
- the review sidecar landed (`workflow/sidecar.py`, feature.json 2.3.0, export 1.6.0);
- about 60 runs have run, 45 of them on pine;
- feature-level coverage briefs with a P0/P1 rule appeared.

Where those change a verdict, the row says so.

## Urgent, outside the controller code

1. **Dropped security verdicts.** Print-transport reviews still let the first blocking reviewer decide (`workflow/automatic.py:918-919`). Later reviewers are marked "superseded" even when their job had already finished. In 5 pine runs a finished security verdict with P0/P1 findings is missing from `review.json`:
   - claims-005 and claims-008: forged GitHub provenance marked verified.
   - platform-004: a P0 SEC-GH-11 bypass; the general reviewer also caught it as a P1.
   - markets-002: an unverified single-RPC oracle selection and a funding lane with no audit entries.
   - assembly-004: every Pine process runs as one OS user, so the database-role separation does not hold.

   The full verdicts are in each run's `review-security.stdout.json`.
2. **C42: nothing has been rotated.** The live Pi Codex tokens, the Brave key and the DeepSeek key are byte-identical to the pushed ai-logs copies. The funded deployer key is still at `~/.config/vps-wallet.env`, readable by every worker. A `veashi-contracts/.env` from 18 Sep is still in `~/dev/vea_validators/vea`.
3. **Host memory.** This morning's OOM (06:23 UTC) happened with at least 5 runs active. Nothing in the controller budgets memory, and several proposals (C12, C13, C15 step 1, C23, C38, C41 Phase 1) add processes that run at the same time.
4. **Other repositories:**
   - project-B: the theft-window P1 is still on main (05ad5e7), C33 step 7.
   - vea: PR #526's description (C43 step 5) and the validator-cli entry-point test (C21).

## Where the audit is wrong or out of date

- **C14 cannot run on this VPS.**
  - bwrap and socat are not installed, and `kernel.apparmor_restrict_unprivileged_userns=1` blocks unprivileged user namespaces.
  - The audit's CLI probes ran on the Mac, where the sandbox is Seatbelt, not this VPS's bwrap.
  - The Bash sandbox never limits Write or Edit under bypassPermissions, so "writes only to the worktree" needs a dontAsk allow-list profile.
  - As written, step 4 would refuse every launch.
- **Decision 12 predates the sidecar.**
  - The sidecar already is most of the "opt-in triage job".
  - It defines no severity: all 23 findings in 35 passes were P2.
  - 20 of its 25 "pane busy" refusals were false, because `input_shown` wants a closing rule below the prompt line.
  - Its escalations reach nobody.
- **C33 is live and worse than reported.** The audit's evidence was native project-B runs. The print transport, which every pine run uses, drops finished verdicts too.
- **C18's "probe the CLI first" is answered.**
  - The stale "working" row recurred in viewer-revamp-005 after the 2.1.287 auto-update.
  - On 2.1.288, rows never report state "idle" but do report status idle, waiting or busy, so f3be881's rule holds.
  - Porting it needs `busy(row)` at automatic.py:248. Without it, a stale row records a false pane answer that restarts a paused question's deadline.
- **Decided items with a false premise:**
  - Decision 10 assumes a merge-to-main step the controller does not own (RUNBOOK.md:339).
  - Decision 2d points to a viewer your phone cannot reach: it listens on 127.0.0.1 behind the Mac tunnel.
  - C57 needs a second bot token, because `panel.service` already polls the plugin bot.
- **Already done or not worth it:**
  - C53's cherry-picks (07029ab, 8508930, 1a39ddb) are already on main.
  - C26 would have saved 3 restarts of about a minute each.
- **C16 steps conflict with existing rules.** Step 2 contradicts decisions 4 and 7, and through drive() it stops every lane. Step 4 breaks the viewer's falsifying-check link. Step 8 reverses your 23 Sep targeted-tests rule.
- **Pause inflation.** About 18 new ways for a run to stop were priced when the session cleared pauses in a median 0.7 min. Under decision 2b each one now waits for your phone.
- **Contract ripple is undercounted.**
  - The server parses exports with strict zod objects, and the version gates are exact matches.
  - A feature.json 2.4.0 silently loses every guardrail (`GUARDED_VERSIONS = {2.2.0, 2.3.0}`) and is refused if it declares a sidecar, unless both gates move with it.
  - Batch the schema bumps: one export bump per slice.
- **C15 coverage gaps.** pine and vea have no operator-notes heading, so their whole CLAUDE.md would be sent. md-manager has no CLAUDE.md at all.
- **C55's allow-list would let a monitor re-roll a paused challenge.** `workflow resume` reruns or accepts a paused challenge; crash recovery is `automatic --live`.

## Verdicts

Legend: **Build** means as proposed; **Narrow** means build the smaller scope stated; **Decided** means you decided it on 3 Oct and only the build design is reviewed here.

### Slice 1: keep every verdict (no contract change)

| Id | Verdict | What to build | Challenge |
|---|---|---|---|
| C33 | Build (urgent) | Both transports. Print: read every finished job and let running jobs finish within their own deadline. Native: a grace (default 10 min) that is continued after a restart. Late verdicts are recorded as accepted or blocked, and can add blockers but never produce "approved". The block error names every blocker and the first sentence of each P0/P1. | Reverses PRD_PARALLEL_REVIEWERS 52/75/90, RUNBOOK 258 and three tests. Effort M, not S. |
| C34 | Decided | Stage 1 only. Bundled `coverage.md` rewritten per decision 4. One rubric for every reviewer: disclosure, literal wording or "not a regression" never lowers a severity. Derived verdict: blocked only with an unresolved P0/P1; a blocked verdict with no findings still blocks. The feature briefs in review-sidecar and viewer-revamp are aligned. The Proof table goes in the completion summary. | The relation field (reviewCompletion 1.3.0) waits for the replay. okiya and pine pin `builtin:coverage`, so validate before shipping (C39). |
| C35 | Narrow | Inline each lane's open_assumptions, untested, falsifying_check and verify_yourself, labelled "Worker claims (unverified)". Name the PRD copy and policy.json. Drop the bundle sha256 and the provenance trace. | Some anchoring on the worker's list, about 1k tokens per reviewer. |
| C40 | Narrow | Delete `record_decisions` (it writes `decision`, which nothing reads). Print writes `accepted_decision`. The RUNBOOK names review.json as the record. | The planted-config check adds nothing under --safe-mode. |
| C18 | Narrow | Port f3be881: `turn_over(row)` (state idle/done or status idle) and `busy(row)`, used at automatic.py:246, 248 and 576. One stall event per lane. No stable-hash acceptance. | f3be881 cannot be cherry-picked; the wait loops were rewritten since. |
| C11 | Narrow | Refuse a bare rerun when the paused attempt's pinned digests equal the current ones, nothing changed, and there is no intent or newer running file. Rerun prompts list the earlier P0/P1s. No cap. | The digest condition avoids a deadlock after a crash between repin and run. Rewrites 3 tests. |
| C24 | Narrow | `diff-tree -z` in freeze. validate_bundle requires one worker and one candidate packet per lane and a matching base. The cache refuses a packet from the wrong phase or node. | Preflight refusal (step 3) waits for C56. |
| C16 | Narrow | stop_rule uses `partition(APPROVED)[0]`. The deadline is stated in UTC, and answers restate it. One sentence: ask before building on a reinterpretation. | Step 2 rejected; step 4 dropped (it breaks the viewer link); step 8 is a question for you. |
| C44 | Narrow (attention decided) | Events for "review blocked" and "controller blocked" with reasons, deferred-check exit codes, and flake lines. `attention.json` per run plus one `attention.jsonl` next to the registry. A lock-free `status`. A challenge heartbeat. | Keep triage.ts's event patterns in the same commit. |
| C51 step 2 | Decided | Derive pending_gates from plan.automatic, or drop it. `status` prints the real next step. | Refusing `integration_approval: true` would refuse all 64 policies; warn instead. |
| C39 | Narrow | Before C34 ships, a small replay of 3 samples on 7 cases (about $28): revamp-004, revamp-006, sidecar-001, sidecar-002, pure-okiya-001, icc and mofg. | No standing CLI with adaptive sampling yet. |

### Slice 2: grill and prompts

| Id | Verdict | What to build | Challenge |
|---|---|---|---|
| C2 | Build | A decisions.md bullet commits to nothing its option did not state. Riders become their own question or `[added, not asked]`. Answers are recorded verbatim. | Your 34 s acceptance saw the rider, so this improves visibility more than accuracy. |
| C1 | Narrow | A limit (only, never, except, excluded, deferred) is never "settled by the documents", even in your own words, and is played back. Before hand-back, one message lists every bullet you did not choose, then one confirm question. Always on. | README TODO line, no-edit rule (already at SKILL.md:55) and dry-run printing dropped. |
| C3 | Narrow | The grill reads the target's CLAUDE.md and flags hand-kept copies of values the repository records. It offers the repository's mechanism and labels run limits as run limits. | "Derive, don't copy" goes in each repository's CLAUDE.md, not a global default. |
| C4 | Decided | Four sections: `## Operator decisions` ([O-n], never edited in place), `## Grill defaults`, `## Changes after launch`, `## Deferred`. Wording keyed on the heading; legacy files bind as today, with a Note. | No parser, grill-log or verbatim-quote check. Workers may depart from defaults only to apply a challenge note, or when the code shows a default cannot hold. |
| C5 | Narrow | Unanswered questions become `TODO: Qn`, and resume refuses TODO lines too. Free-text answers are restated. Delegation scope is recorded. The critical-code question per decision 9. | Scripted grill tests belong to C39. |
| C9 | Decided | `challenge_block` in the worker prompt: numbered as in challenge.json, advisory, without the alternative or the experiment. Ship with C10's prompt change. | Alone it forwards hedges such as "or at least". |
| C10 | Narrow | Prompt only: each concern ends with "Recommendation:" and "Acts: operator\|worker\|note", never a fallback; P0/P1 cite file:line. | No schema change and no new pause. The audit's structured fields wait for data. |
| C15 | Decided | `git show <base>:CLAUDE.md`, cut at the operator-notes heading and pinned in the plan, goes into the worker, challenge, reviewer and sidecar prompts. A 120 KB argv guard. Fix README:32, the starter CLAUDE.md and the PRD. Workers are told that setup has not run. | pine and vea lack the heading; md-manager has no CLAUDE.md. |
| C19 | Narrow | `worktree.bgIsolation: none` removes the --bg "commit and push" paragraph. A built-in deny list: Bash(pkill:\*), Bash(killall:\*), Bash(git push:\*), Bash(git commit:\*). | Prefix rules leak; they are hygiene only. Check the next transcript. |
| C14 (no-root) | Decided | worker_settings with Read/Edit deny rules (credential paths, ~/.claude/.credentials.json, the wallet file) and HUSKY=0, GIT_TERMINAL_PROMPT=0. The verifier drops secret-like environment names but keeps `*_URL`. The plan records `authority: account`. README line 3 fixed. | Deny rules do not stop a Bash `cat`; only moving secrets off this account does. |
| C25 | Narrow | GIT_CONFIG_COUNT sets hooks and fsmonitor off at controller entry, stripped again in claude_env and the check env. `--no-ext-diff --no-textconv` on every diff writer. A .git config digest at prepare, with a warning at freeze, review and integrate. | A tripwire, not a boundary. |

### Slice 3: control at the desk

| Id | Verdict | What to build | Challenge |
|---|---|---|---|
| C56 | Narrow | launch creates `git worktree add -b <branch> <runs_root>/<run>.source`, so your checkout never switches. pr-branch later. No clones, no QUEUE.md. | A ref-only design breaks resume, accept and repair. |
| C52 | Narrow (profiles decided) | `launch --profile attended\|unattended`, unattended when omitted. `plan.roles` holds worker and judges (judges at high effort, pending your yes). A scrub_env denylist that keeps auth variables. Record the controller commit, `claude --version` and the observed model. | A CLAUDE_* prefix scrub would drop auth; CLAUDE_EFFORT is an output variable. |
| C8 | Decided | `--hold-challenge`, or the attended profile, writes challenge-hold.json. `resume --launch` reruns if files changed. A plain resume after edits reruns and holds again. Shown in the viewer as paused with a `challenge_held` situation. | challenge.json stays "passed", so the challenge contract does not change. |
| C51 step 1 | Decided | finish="approval" (attended, or a feature marked critical). A new AWAITING_APPROVAL exit code. The approve command and the open items are printed. approve records the actor. | Approval gates the run branch only; the merge to main stays a rule. |
| C17 | Decided (--by) / Narrow (note) | `--by operator\|maintainer` on every gate action, passed through by launch. A maintainer may not answer, accept, repair, approve, launch, or resume a paused challenge. `workflow note` on the sidecar's delivery gate. | Cooperative, not access control; workers share your uid. |
| C43 | Narrow | An outcome block built from export_state's section builders. Printed on success, on block and by status, and at the top of report.html. Says "file written, never accepted" when a reviewer's file was never accepted. | The digest and PR pasting wait. |
| C12 | Narrow | `launch --restore-from <commit>`: a read-only copy of the restored owned paths for the challenge, and each worker's prompt prints its restore command. | Not a second git worktree, which would break move_base. |
| new | Build | Host memory gate: one heavy verification at a time, host-wide (question 4). | Not in the audit. |

### Slice 4: when you are away

| Id | Verdict | What to build | Challenge |
|---|---|---|---|
| C57 | Decided | v1a: notices for decisions still pending after N minutes, `/away`, reminders, a heartbeat and an orphaned-supervisor scan. v1b: buttons bound to your chat id, the bot's recorded unedited message, a one-time nonce and a state recheck. A second bot, with its token in a mode-600 file. Messages decidable on their own, with a Details button. v2: free-text drafting (2e). | A nonce alone is replayable on a spoofed or edited message. |
| C55 | Decided | No LLM monitor by default. supervise retries exit 69, bounded. The bot resumes runs whose supervisor died (capped, recorded as maintainer). Retry and relaunch are one-tap decisions. Merge 312a96d with C18. RUNBOOK:86 rewritten. | One-tap retries and relaunches are narrower than 2a. |
| C53 | Narrow | `workflow/OPERATOR.md` (12 lines or fewer), imported from ~/.claude/CLAUDE.md; trim the panel's CLAUDE.md. Commit lane-repair-design.md under docs/design/. Delete fix/* branches whose content is on main (with your yes). | No presence line: C57's delay rule replaces it. |
| C41 | Decided | The sidecar is the triage job. A completion-accepted event. A severity rule from decisions 4 and 12 in the pass prompt. Undeliverable P0/P1s and escalations go to the attention record. Fix the `input_shown` gate. | No provisional builds or extra triage jobs. Handoff hold deferred. |
| C46 | Narrow | Classify usage limits and refusals for print jobs. For native sessions, read the transcript on blocked; block at once if the reset falls after the deadline. | No deadline pause until a probe shows resume works. |

### Slice 5: fix cycles, tryouts, housekeeping

| Id | Verdict | What to build | Challenge |
|---|---|---|---|
| C30 | Narrow | Read-only `workflow brief <run>` and a candidate ref. `launch --follows <run>`. `workflow abandon <run> --reason` (status "cancelled"). | No `init --from-run`, block_kind or reproducer rules. "cancelled" already exists. |
| C32 | Narrow | `launch --restore <sha>`: a run with no worker through the normal graph, checks and reviewers. | No separate review-commit record. |
| C7 | Decided | feature.json `tryout` flag. `workflow tryout <run> --result works\|broken\|skipped`. An "Untried" chip; try-this lines from verify_yourself and each lane's Goal. | Enforcement is a chip plus a rule until a merge step exists. |
| C29 | Decided | Refuse a 4th untried tryout feature, counted across all projects; continuation runs pass; `--allow-untried`. | feature.json 2.4.0 needs the version gates updated. |
| C23 | Narrow | A launch warning for owned-path overlap with other features' unlanded runs (`registered_runs()`). | Pine's 10 parallel merges were clean; rehearse waits. |
| C27 | Narrow | Notes for: no test kind, removed kinds or checks, and checks above 60% of their timeout. | The other 4 heuristics are noise on md-manager's own policies. |
| C28 | Narrow | Single lane: the candidate cherry-pick with `--ff` reuses the worker packet when there is no browser check. Measured 377 candidate minutes, 179 reusable. | A flaky check gets one run. |
| C45 | Narrow | At prepare, pin and print `base_unreviewed`. A read-only `workflow ledger`. | Would have flagged 12f6056, copied from a blocked candidate. |
| C47 | Narrow | Auto-delete passed verification attempts only (about 21 GB of 29); `workflow clean <run>` for the rest. | Reverses your "no automatic cleanup" rule. |
| C49 | Narrow | Per-session cost from cost-state rows at stop; `challenge.history`; export 1.7.0. | Print jobs are only 22-72% of spend. |

### Deferred

| Id | Why |
|---|---|
| C6 | Under decisions 4 and 7 nothing enforces Proof tags. One OPERATOR.md sentence instead. |
| C13 | No replay harness and no data on passing attempts; each extra pause waits for your phone. |
| C26 | Would have saved 3 one-minute restarts. Ship only a clearer refusal message. |
| C31 | Most drops trace to C33 and to hand-carrying (C30). Measure after both land. |
| C36 | A RUNBOOK recipe now (restore commit, challenge off, tree-equality check). The command comes after C32. |
| C38 | Needs C7's try_it, C28's ports and C14. Encode real-use misses as browser scenarios meanwhile. |
| C54 | Waits for C14. C52 records the CLI version and model per job. |
| C14 sandbox | Needs sudo (bubblewrap, socat, an AppArmor profile) and a --bg canary first. |

### External (not md-manager code)

C21 (vea test), C22 (move the deployer key; only you broadcast), C42 (rotate keys), C48 (your settings), C50 (REPORT.md), C33 step 7 (project-B fix), C43 step 5 (PR #526), C37 (a Codex hunt on controller merges; codex is not installed).

C20 is not adopted (decision 7).
