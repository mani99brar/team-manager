# Decisions: review-sidecar

From the PRD review of 2026-10-01 with the operator; the operator chose md-manager's own pipeline for this feature and the PRD's defaults for its open questions.

## Decisions

- The sidecar is not a LangGraph node and never blocks the run: it runs inside `automatic.wait_handoffs` as a polled `Popen` child, is shown as node `sidecar` of `kind: review` (the workflow v1 kind enum is frozen), and ends `succeeded` at freeze whatever its ledger holds. A failed, rejected, timed-out or interrupted pass is recorded and the run continues; `test_sidecar` proves a run whose every pass fails still reaches its verified branch.
- Passes, not a long-lived session: each pass is one `claude --print` job with `--tools Read,Glob,Grep`, the ledger is its memory, the controller owns `sidecar.ledger.json` and writes it atomically after schema validation. There is no sidecar pane and no session to attach.
- Messages reach workers only through the controller with the rules of PRD 4.5; a lane with a question waiting is refused (the operator answers questions), a lane that went on is refused, the deadline file is never touched. Workers are told about the sidecar in their prompt and reply in their pane, which the next pass reads.
- The ledger shape is Appendix B of the PRD, `contracts/workflow/sidecar.schema.json` 1.0.0, owned by the `engine` lane; the `viewer` lane builds its fixtures from Appendix B verbatim and both lanes record any deviation in their handoff. Export 1.6.0 adds the top-level `sidecar` section (`null` for runs without); the server reads the live file first, as it does for questions.
- Reserved names: `sidecar` and the `sidecar-` prefix, in `workflow/sessions.py` and the feature schema (`engine`) and in `server/projects.ts` (`viewer`).
- Defaults pinned at prepare: cadence 900 s, pass timeout 600 s, 16 passes plus the final pass, 6 messages per lane; bounds as PRD section 3.
- The post-freeze reviewers do not receive the ledger (independence); it is for the operator, in the run directory and the viewer.
- An escalation is an `interactive` event on the `sidecar` node and a section on its page; no new attention kind and no Now-banner change in this feature.
- `focusOf` never picks the sidecar while a `launch_` or `verify_` node runs; `buildGaps` ignores its span; the run's `activity` with a sidecar equals the same run without one, asserted in `server/projects.test.ts`. The graph legend keeps three entries; the sidecar is an `agent`.
- The pass reads the visible pane text through Herdr when available (`pane_file: null` otherwise); a transcript tail is deferred.
- Both lanes land together in one candidate: the live API is restarted after integration, before any run exports 1.6.0.

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
