# Decisions: run-sessions

From the grill session of 2026-10-11 with the operator.

## Operator decisions

- [O1] Q1: Both panels. Night-shift decisions appear on the node they decided (challenge, a question, approval) with each provider's answer, Jev's pick and executed/held; the multi-provider panel becomes its own node next to the reviewers; the server also reads the night-shift folder (outside the run directory) by run id. Operator: "Both (Recommended)".
- [O2] Q2: The server reads the per-session files live from the run folder, as it already does for panel.json and repairs.json; two lanes, `server` and `viewer`; the controller and the export stay unchanged; it works for runs already on disk; a lane reviewer via pi has no session id (only model, status, cost, findings). Operator: "Server reads files (Recommended)".
- [O3] Q3: Reviewers are their own nodes on the stage for all runs: one node per reviewer (general, coverage, critique, and the multi-provider panel when used) side by side, each with status, verdict, findings count, cost and a node page; each lane gets a lane review node right after its verify step, one per round; the server projects them as it projects repair nodes, for every run whose files exist; step counts change, so existing specs that count steps are updated to the new count, not weakened. Operator: "Own nodes, all runs (Recommended)".
- [O4] Q4: Each session shows facts and a resume command: a Sessions list on the run page and a session block on each node page with role, model, transport, status, start/end and duration, cost, session id, and for Claude sessions a copyable `claude --resume <id>` command; no transcript text and no absolute paths. Operator: "Facts + resume command (Recommended)".
- [O5] Q5: Base `sync/vm-vps-2026-10-11` (bf4634a: run controls, the lane reviewer controller); shared harness files get one-line registrations only; launch once projects-dispatch-003 has finished, with GPT 6.1 lane reviewers (rounds 1), critique on the viewer lane and `--fix-rounds 3`; a small merge of the shared harness lines when both land. Operator: "Sync branch, after 003 (Recommended)".
- [O6] 2026-10-11, after the five questions, before the read-back: the operator delegated the remaining decisions. Operator: "Complete the two workflows, take decisions as enabling workflow. For any workflow decsiions you can consult the panel." Applied to: the read-back (the Grill defaults below stand unless the panel review changes them), the slice review before launch, and decisions during the run.

## Grill defaults

- [G1] Feature name `run-sessions`, PRD `docs/PRD_RUN_SESSIONS.md`, branch `observe/run-sessions` in `~/dev/md-manager-run-sessions`, feature.json 2.10.0, policy 1.4.0, `critical: false` (CLAUDE.md lists no critical path), `tryout: true`, no attack pass.
- [G2] The sessions route is `GET /api/projects/:project_id/workflows/:workflow_id/runs/:run_id/sessions`, contract 1.13.0 in a new `contracts/projects/sessions.ts` (PRD Appendix A); the run detail keeps its shape, and projected nodes use existing node entries.
- [G3] Projected node ids: `reviewer-<id>` (including `reviewer-critique`), `panel`, `lane-review-<lane>-<n>`. Reviewer and panel nodes depend on what `review` depends on and `review` also depends on them; lane review nodes depend on `verify_<lane>` and nothing depends on them; all are advisory in triage.
- [G4] The night-shift folder is `MD_MANAGER_NIGHT_SHIFT_DIR` (default `~/.local/state/md-manager-workflows/night-shift`); a record matches a run by `run_id` and by its texts naming this run's directory or none.
- [G5] The resume command is `cd <dir> && claude --resume <id>` with a `~`-relative working directory, or `claude --resume <id>` with "run it in the session's worktree" when the directory is not under HOME or not recorded.
- [G6] The viewer lane owns `tests/project-workflows` and `tests/unit` as directories, because the new reviewer nodes change cards that many existing specs count; it may update them only to the new count and cards, never weaker ([O3]).
- [G7] The viewer mirrors Appendix A in `src/projects/sessions/types.ts` instead of importing the server lane's contract file, so the lanes stay parallel.
- [G8] The critique app is `tests/project-workflows/sessions-app.ts`, ready at `/api/projects`.
- [G9] Herdr pane links and transcripts are out of scope (`terminals.json` goes stale across review rounds) [added, not asked].

## Changes after launch

None yet.

## Deferred

- Recording lane reviewers' session ids for `pi` transports, and exporting session costs in `run-state.json` (a workflow lane; [O2] chose no engine change).
- Night-shift actions from the run page (the run controls feature owns actions).
- Transcript viewing.
