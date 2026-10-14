# Decisions: run-checks-once

Every worker and reviewer prompt includes this file. The Operator decisions are the operator's own words and bind the run; they win over the task file and the PRD (`features/run-checks-once/prd.md`).

## Operator decisions

- [O1] The request, 2026-10-14, after a machine-log check showed two concurrent full suites failing a lane on load (transcript `1a283e24-9b99-4f4a-92f6-3f77af0a1009.jsonl`). Operator, line 268:
  > "Why do we need to the same tests 3 time, why dont we only run them once?"

  Operator, line 356, on the session's offer to build candidate dedupe and to put run-level checks through /cook:
  > "Yes lets cook this"
- [O2] On [O1] the session ran `/cook` on 2026-10-14. Its arguments are the session's words, not the operator's; their substance is in the PRD §1-§3. /cook delegates the grill and every run decision to the panel (Claude Fable + GPT Astra, Jev on splits). Its answers are under Grill decisions and Changes after launch, tagged `(panel …)`.

## Grill decisions

- [G1] **Limits.** These hold as written:
  - browser checks are never shared and never run-level (PRD §4 E4, §6.1);
  - no viewer, server, `src`, `contracts/projects` or export-shape change (§9);
  - the worker phase is unchanged, and this feature claims no worker-phase dedupe;
  - attribution covers run checks only, and a failing shared lane check blocks the first declaring lane (§5);
  - feature.json is untouched, and this run's policy stays 1.4.0;
  - /cook's feature-rules are untouched.

  Each excluded item stays under Deferred. (panel: agree, high; grill q1)
- [G2] **One feature, one engine lane,** delivering all of PRD §4-§8 plus the §9 compatibility rules. The review runs with `--review-timeout-seconds 3600`. (panel: agree, high; grill q2)
- [G3] **Owner fallback.** PRD §7.3 d holds:
  - it applies only after the reproduction and base checks;
  - an id failing on several snapshots, or on none, goes to the lane whose `owned_paths` contain the failing test's file, when exactly one lane owns it, recorded as owner-attributed, distinct from snapshot-attributed;
  - when no lane or several lanes own the file, the failure is unattributed.

  §11.8 d and e prove it. (panel: agree, medium; grill q3)
- [G4] **No parsed ids** (another runner, or nothing parses). The reruns run the whole run check on the candidate, the base and each lane snapshot, one at a time and never concurrently, each capped at the run check's timeout, and §7.3 treats the check as one id. A memory-killed run check takes the transient path first and gets no attribution reruns. This run adds no node:test parser (PRD §7.1, §11.8 i). (panel: fallback:recommended, medium; grill q4)
- [G5] **Base and flaky failures.** Ids pre-existing at base, or not reproducing on the candidate, pick no lane.
  - When no attributable id remains, every lane's packet is blocked with a reason naming those ids, no repair starts, and retries follow `check_retries`, then `controller_blocked`. The candidate gate never passes with a failed run check.
  - This holds on a one-lane run too: an unattributed block carries a marker that the repair path refuses (PRD §6.3, §11.8 h).
  - (panel: agree, high; grill q5)
- [G6] **Equivalence by argv.** Identical non-browser argv within one candidate attempt and its shared setup and environment is the only equality test (PRD §4 E1-E8):
  - ids, kinds and timeouts may differ, and the execution runs with the largest timeout;
  - each lane gates under its own id, kind and timeout, and a lane whose timeout the execution exceeded is blocked (§11.2).

  (panel: agree, high; grill q6)
- [G7] **Launch after 002's candidate gate.** The launch waits until review-panel-registry-002's candidate gate has finished, re-checked every 10 minutes, on base 44b9c24. The worker never starts its own full suite while another `workflow.run_tests` runs on the host. (panel: agree, medium; grill q7)
- [G8] The engine lane runs on `claude-opus-5-5` at effort `high`. (panel: agree, high; grill q8)

## Changes after launch

- [L1] **One narrow `automatic.py` edit for the one-lane refusal.** Supersedes the task's Stop rule sentence that the PRD §6.3 refusal "belongs in `repair.py`" and, for this one change only, the Constraints line "Do not edit `automatic.py`". `repair.py` defines a predicate (for example `unattributed_block(packet)`) that is true when a blocked candidate packet carries the unattributed marker of [G5]. `fix_decision` (automatic.py :2171) calls it and returns None when the single blocked candidate packet matches, so the block falls through to `check_retries` and then `controller_blocked` with zero repair sessions. No other `automatic.py` line changes; `repair_session` never raises for this case and `transient_packet` is never used for it. Touches Acceptance 8 h and PRD §6.3, §11.8 h: the end-to-end test drives a one-lane run through the retries to `controller_blocked` and asserts no `fix loop exhausted` event, no memory-kill event and zero repair sessions. (panel: jev:claude; run-checks-once-001 challenge attempt 1, P1-1)
- [L2] **Lockstep candidate attempts under a shared record.** Supersedes the PRD §4 E2 and §5 wording that keys the shared execution to "the candidate attempt" as if lanes shared one. On any run that would produce a shared record (any policy), the candidate hook first raises every lane's candidate attempt to the highest current candidate attempt among the lanes, then runs the shared execution. Each candidate attempt has exactly one shared record per distinct argv, and every lane packet of that attempt cites that record; a cached packet from an older attempt is never reused beside a newer record. Touches Acceptance 5, 8 and 11 and PRD §11.5, §11.8: a two-lane test retries lane b alone (`retry --phase candidate --node b`) and shows both lanes at the same new attempt, both new packets citing one new record, and a run check failing on that record blocking lane a when attribution names a. The 1.4.0 regression test pins that a single-lane retry re-verifies the other lane too; this is the only retry-target difference allowed on 1.0.0-1.4.0, and the handoff doc names it. (panel: jev:claude; run-checks-once-001 challenge attempt 1, P1-2)
- [L3] **Carried P2s** (worker items, each pinned by a test or named in a doc):
  - the 1.4.0 regression fixture includes two lanes with the same argv and different timeouts, pins the exact gate reasons of the shorter-timeout lane under E7, and the handoff doc states the reason difference (supersedes the Constraints line "Their gate reasons … do not change" for that case only);
  - the shared execution keeps `lane_tmpdir()` outside the run directory, one TMPDIR per shared attempt, stored in the shared record as packets store it (supersedes the PRD §4 E6 phrase "inside the shared attempt folder");
  - the RUNBOOK equivalence section and the handoff doc state that ignored outputs of earlier shared commands are visible to later ones;
  - every attribution rerun (parsed ids too, extending [G4]) runs one at a time, pinned by a test whose counter file shows no overlapping executions;
  - the handoff doc says candidate dedupe benefits every policy at once, and that worker-phase load only drops once a policy moves the suite into `run_checks` (Deferred items);
  - the `contract.test.ts` change is one new `it` block placed apart from the existing version assertions; an existing line changes only where its assertion would otherwise fail against the widened rules.
  (panel: jev:claude; run-checks-once-001 challenge attempt 1, P2 1-6)

## Deferred

- Showing run-level checks and the shared record in the viewer: a later Sonnet follow-up, after review-panel-registry lands, owned by server/ and src/.
- Teaching /cook's feature-rules to write `run_checks` and targeted lane checks. This is outside this repository, and it starts once ctl runs policy 1.5.0.
- Attributing a failing *shared lane check* (not a run check) to the lane that caused it. It keeps today's first-declaring-lane rule.
- A machine-wide slot for heavy Python suites, like the browser queue.
