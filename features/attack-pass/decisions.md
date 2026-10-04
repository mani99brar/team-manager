# Decisions: attack-pass

From the grill session of 2026-10-04 with the operator, held on the brief "Red-team worker for the agent workflow" before `docs/PRD_ATTACK_PASS.md` was written; the PRD's section 2 records the same answers. The feature files were written on 2026-10-04 by a Claude session acting on the operator's request to run this PRD through the workflow overnight; the operator was asleep, so the read-back of the grill defaults below has not happened yet.

## Operator decisions

- [O1] Isolation: a plain print job (a subagent), offline exploit tests only, in its own worktree, with a scrubbed environment and the C14 deny rules; no OS sandbox for the pilot. Operator: "CAnt we just run a claude subagent shouldnt that be sufficient why do we need a sandbox?", then "Subagent, offline (Recommended)".
- [O2] Secrecy: independent, not hidden. Workers may know an attack pass can run; they never see its angle, its tests or its findings before freeze. Operator: "Brief: independent (Recommended)".
- [O3] Pilot project: pine-claims. Operator: "pine-claims (Recommended)".
- [O4] Attackers: configurable, one per angle, default one. Operator: "COnfigurable, start with one ".
- [O5] Reproduction: a failing test in the project's own harness that asserts the required behaviour and fails on the candidate. Operator: "Failing exploit test (Recommended)".
- [O6] Verification: the controller re-runs each test on a clean copy, then a separate skeptic job judges each reproduced finding. Operator: "Re-run plus judge (Recommended)".
- [O7] Report-only: findings go to the pass's own record only (`attack.json`, an attention record, the run page); reviewers never see them and nothing blocks. Operator: "Own record only (Recommended)".
- [O8] Budget: $15 and 60 minutes per attacker; $5 and 20 minutes for the skeptic. Operator: "$15 / 60 min (Recommended)".
- [O9] Inputs: candidate code and specifications only; not the workers' completion claims, the sidecar ledger or the review. Operator: "Code + specs only (Recommended)".
- [O10] Placement: in parallel with the review, inside the review step. Operator: "Parallel with review (Recommended)".
- [O11] Angle: set per feature in feature.json by the grill. Operator: "feature.json, set by grill (Recommended)".
- [O12] Promotion to blocking: after 3 pilot runs, then the operator's call. Operator: "3 runs + your call".
- [O13] Launch guard: launch refuses an attack pass while a listed secret file exists on the host. Operator: "Refuse while secrets exist (Recommended)".
- [O14] Labels: the operator labels each verified finding. Operator: "You confirm each (Recommended)".
- [O15] 2026-10-04, after the PRD: build the PRD through the workflow in automatic mode, unattended. Operator: "Lets finish the prd @/home/agentops/dev/mdm-attack/docs/PRD_ATTACK_PASS.md using the latest workflow on automatic mode. I am going to sleep and i want you to run it."

## Grill defaults

- [G1] Lanes: `engine` owns `workflow/`, `contracts/workflow/` and `docs/handoff/attack-engine.md`; `viewer` owns `server/`, `contracts/projects/`, `src/projects/`, `tests/unit/`, `tests/project-workflows/` and `docs/handoff/attack-viewer.md`. The seam is PRD Appendix A (attack.json 1.0.0 and the export 1.8.0 `attack` section): the engine writes it, the viewer builds its fixtures from it, and neither changes it without recording the exact change in its handoff.
- [G2] Not critical: md-manager has no `CLAUDE.md`, so no critical-paths list; the automatic run integrates without an approval stop. Integration fast-forwards only the run's branch; nothing merges into `main`.
- [G3] No tryout: the Attack pass section shows data only once a pilot run has a pass, so the pilot's first run is its tryout (`"tryout": false`).
- [G4] The run is observed by the review sidecar (`builtin:senior-review`), as the viewer revamp was.
- [G5] [added, not asked] `attack.requirements`: an optional list (0 to 10) of repository-relative paths of the project's requirements documents (pine: `docs/security/requirements.md`), pinned at prepare and given to the attacker and the skeptic beside the PRD, the task Goals and `decisions.md`. Launch refuses a listed path that is not committed at HEAD, as it does for the PRD. It is how "the project's security requirements" of PRD section 2 reach both jobs.
- [G6] [added, not asked] The bundled briefs in `features/attack-pass/attack-briefs/` become `workflow/prompts/attack/<angle>.md` and `workflow/prompts/attack/skeptic.md` unchanged. They are requirement checks: list the stated requirements of the area, write one test per requirement that asserts it, report the ones whose test fails. The engine worker installs them as written and does not extend them.
- [G7] [added, not asked] The review step runs the pass as one child process (`python -m workflow.attack <run>`, its own process group, recorded in `<run>/attack.running.json`) and polls it in the review step's wait loops (print and native transports) as it polls print reviewers, never blocking on it; after the review decides, the step keeps polling until the pass ends or passes its overall bound (PRD 4.1, Deadlines). A controller interrupt or exit terminates the child, as it terminates print reviewers. The child resumes from `attack.json`: the next controller starts it again, it keeps every finished step, records an attacker or skeptic left `running` as `failed` (error `interrupted`), and runs only what is still owed (re-runs, skeptics, the closing records). Nothing reruns an interrupted attacker. Why a child process: setup, the jobs and the re-runs can each run for minutes; in a child they run straight through, with no state machine inside the review loops, and an error in them can never raise into the controller.
- [G8] [added, not asked] Manual runs: the controller runs no pass by itself. `python -m workflow attack-pass "$RUN" --by operator` runs it once in the foreground at the review gate; it is refused while a controller holds the run, for a plan without `attack`, before a candidate exists, and when `attack.json` already exists. It is also how a staged copy of an old run is calibrated (PRD 5.0).
- [G9] Finding ids are global per run: `A-1`, `A-2`, ... in attacker order then the attacker's own order; the attacker's own id is kept as `ref`. `attack-label` takes the global id.
- [G10] While the plan has `attack` and no `attack.json` exists yet, the export's `attack` section is a `pending` record of the Appendix A shape (no attackers, no findings), so the run page can say the pass runs at the review step.
- [G11] PRD open question 2: `attack-tally` does not decide "review also found" by itself; `attack-label` prints the review's findings in the same files as a hint and the operator's `--review-found` is the record.
- [G12] Event messages on the `attack` node are written by the controller with counts, ids and angles only; no model-written text goes into `events.jsonl`.
- [G13] The pilot steps of PRD section 5 (the calibration, moving the wallet file, the three pine-claims runs, the promotion review) are operator steps after this run, not part of it.

## Changes after launch

None yet.

## Deferred

- The OS sandbox (the C14 sudo steps), blocking mode and the `blocking` key (PRD section 7), and attacks on live services.
- PRD open question 1 (a second calibration on project-B) and the calibration itself (needs the operator's OK for about $20).
- Automatic "review also found" matching in `attack-tally` (PRD open question 2).
