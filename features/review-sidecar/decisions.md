# Decisions: review-sidecar

From the PRD review of 2026-10-01 with the operator; the operator chose md-manager's own pipeline for this feature and the PRD's defaults for its open questions.

## Decisions

- The sidecar is not a LangGraph node and never blocks the run: it runs inside `automatic.wait_handoffs` as a polled `Popen` child, is shown as node `sidecar` of `kind: review` (the workflow v1 kind enum is frozen), and ends `succeeded` at freeze whatever its ledger holds. A failed, rejected, timed-out or interrupted pass is recorded and the run continues; `test_sidecar` proves a run whose every pass fails still reaches its verified branch.
- Passes, not a long-lived session: each pass is one `claude --print` job with `--tools Read,Glob,Grep`, the ledger is its memory, the controller owns `sidecar.ledger.json` and writes it atomically after schema validation. There is no sidecar pane and no session to attach.
- Messages reach workers only through the controller with the rules of PRD 4.5; a lane with a question waiting is refused (the operator answers questions), a lane that went on is refused, the deadline file is never touched. Workers are told about the sidecar in their prompt and reply in their pane, which the next pass reads.
- The ledger shape is Appendix B of the PRD, `contracts/workflow/sidecar.schema.json` 1.0.0, owned by the `engine` lane; the `viewer` lane builds its fixtures from Appendix B verbatim and both lanes record any deviation in their handoff. Export 1.6.0 adds the top-level `sidecar` section (`null` for runs without); the server reads the live file first, as it does for questions.
- After design challenge attempt 1 (P1: the seam is pinned by one example and the two validators are blind to each other): both schemas carry Appendix B's field rules (string bounds, ids and shas as any non-empty string, `locator` and `evidence` may be empty, the nullable set is `note`, `summary`, pass `session_id`, message `reason`, `handoff`, `closed_at`, no referential checks), each lane keeps a test validating the Appendix B example verbatim, the viewer keeps the `sidecar` section out of the strict export parse and validates it only on the `/sidecar` route (a failure is `SIDECAR_NOT_FOUND`, never a failed run list), and the node's status comes from its events through `EVENT_STATUS` with no ledger branch.
- After design challenge attempt 1 (P1: a typed message could confirm a permission dialog): the delivery gate requires the row state `working` or `idle`, the pane foreground `claude attach <id>` and an empty Claude Code input line (`input_shown(screen, "")`); otherwise `undeliverable` with the new reasons `lane_blocked` or `pane_busy`, nothing typed. A lane that wrote a completion is never messaged (`went_on`), so a completion pass informs the operator only; the RUNBOOK says so.
- After attempt 1's P2s: new findings are cited within an output by `ref` (`new-<k>`); pass inputs use `git diff` without `--binary` under `GIT_OPTIONAL_LOCKS=0`; no model-written text goes into event messages (escalations are `escalation S-n (kind): see the sidecar page`); the viewer's headline last activity and attention skip `sidecar` events; interrupts kill the pass's process group and a restart kills a marker's pid only when its command line holds the pass's session id; when the last completion is accepted in the poll that would start a completion pass, only the final pass runs; the old observer module is never named in code or docs.
- Reserved names: `sidecar` and the `sidecar-` prefix, in `workflow/sessions.py` and the feature schema (`engine`) and in `server/projects.ts` (`viewer`).
- Defaults pinned at prepare: cadence 900 s, pass timeout 600 s, 16 passes plus the final pass, 6 messages per lane; bounds as PRD section 3.
- The post-freeze reviewers do not receive the ledger (independence); it is for the operator, in the run directory and the viewer.
- An escalation is an `interactive` event on the `sidecar` node and a section on its page; no new attention kind and no Now-banner change in this feature.
- `focusOf` never picks the sidecar while a `launch_` or `verify_` node runs; `buildGaps` ignores its span; the run's `activity` with a sidecar equals the same run without one, asserted in `server/projects.test.ts`. The graph legend keeps three entries; the sidecar is an `agent`.
- The pass reads the visible pane text through Herdr when available (`pane_file: null` otherwise); a transcript tail is deferred.
- Both lanes land together in one candidate: the live API is restarted after integration, before any run exports 1.6.0.

- After design challenge attempt 2 (P1: Appendix B could not come out of the defined merge): an upsert overwrites the finding's own fields, and each history entry copies that upsert's disposition, revision, evidence and note (the first entry holds the creation values); Appendix B's S-1 now shows the pass-3 revision and evidence with the pass-1 values in `history[0]`, and the engine's seam test merges three hand-written outputs into Appendix B.
- After attempt 2's P2s: the ledger is bounded at 4 MiB on both sides (the engine rejects an output that would cross it with reason `size`; the viewer's live cap is 4 MiB, not the 256 KiB questions cap); when the last completion is accepted a running pass is terminated and recorded `interrupted`, the final pass runs as a polled child inside the loop and the handoffs are saved after it is recorded; the delivery gate takes a fresh inventory and pane read per message, Herdr calls are bounded to one capture per lane per pass and the first Herdr timeout in a pass skips the pass's remaining Herdr calls.

- After design challenge attempt 3 (P1: a sidecar exception would reach `drive()` and stop every worker): every sidecar step runs under one guard that catches everything except `KeyboardInterrupt` (Herdr errors and timeouts, Git errors, `TransientInfraError`, the engine's own bugs), records the pass `failed` or the message `undeliverable` with the error, writes one `interactive` event and lets `wait_handoffs` continue; `test_sidecar` injects each of these and asserts the lanes keep running and no `controller blocked` event is written.
- After attempt 3's P2s: delivery is crash-consistent (the merged ledger with messages `pending` is written before typing, each delivery flips its message atomically, a restart turns `pending` into `undeliverable`/`interrupted`; `pending` and `interrupted` join the enums on both sides); the `sidecar` node only ever receives `running`, `interactive` and `succeeded`, a run stopped before freeze closes it with `succeeded` and `closed_at`, a controller interrupt writes nothing; the node sits immediately after `challenge` and before every `launch_` in the definition, `handoff.depends_on` ends in `sidecar`, and the viewer excludes the sidecar from the running headline list as well as focus, last activity, attention and gaps, asserted with two lanes and with one lane running; `plan.sidecar` only, never an entry of `plan["nodes"]`; the running marker is created `O_EXCL`, the merge and ledger writes run under `sidecar.lock`, and `sidecar-pass` is refused while the supervisor lock is held.
- Controller-typed delivery stays in this feature (the operator's brief asks for it); the challenge's alternative of relay-only messages is not taken.

## Assumptions

- `WORKFLOW_WORKER_EFFORT`, `ANTHROPIC_MODEL` and the other launch environment apply to the pass as they do to the challenge job; the pass takes no `--effort`.
- The `viewer` lane may add `1.6.0` to `EXPORT_VERSIONS` before any producer writes it; every 1.0.0 to 1.5.0 export keeps loading.
- `init` writes 2.3.0 from now on with the `sidecar` key shown in its README; 2.2.0 features launch unchanged.
- Workers run targeted tests only; the verifier runs every policy check per phase.

## Deferred

- `sidecar.brief_reviewers` (handing unresolved findings to the post-freeze reviewers as claims to verify).
- An `escalation` attention kind for the Now banner and the run lists.
- A transcript tail as a pass input; a Herdr pane tailing the ledger.
- Live smoke of PRD section 8, run by the operator after integration.
