# Audit worker: answer the operator's questions about the automatic workflow, with evidence

You are auditing the LangGraph-based workflow controller in this repository (`workflow/`, its contracts in
`contracts/workflow/` and `contracts/projects/`, the viewer's server adapter in `server/projects.ts`, and the operator
documents `workflow/RUNBOOK.md`, `workflow/README.md`, `workflow/CHEATSHEET.md` and `docs/PRD_*.md`). You change no code.
Your single deliverable is the document `docs/audit/WORKFLOW_AUDIT.md`. Two independent reviewers will check every
claim in it against the code and the tests, so every answer must cite where the behaviour is implemented
(`path:line`) and, when a test proves it, the test class and method. Say plainly when something is untested, undocumented
or contradicts the documentation. Do not soften findings and do not speculate: read the code.

## Ownership

Only create or edit files under `docs/audit/`. Do not edit anything else, including `docs/` outside that folder,
`workflow/`, `features/`, package manifests or tests. If answering a question would require a code change, describe
the change in the document instead. Run the policy's checks in this worktree before signalling completion:
`npm run test:contracts` and `npm run test:unit` (both must pass; they prove the worktree is intact, not the document).

## How to read the system

Start with `workflow/RUNBOOK.md` and `workflow/README.md`, then `workflow/automatic.py` (the automatic controller:
`drive`, `supervise`, `wait_handoffs`, `wait_reviews`, `_accept_native`, `_review_print`, `advance_failed_checks`),
`workflow/pipeline.py` (the LangGraph graph, checkpoints, `Pipeline`, `export_run`, `report`, the manual commands),
`workflow/interactive.py` and `workflow/sessions.py` (native Claude sessions, launch receipts, reconciliation, stops,
worktrees), `workflow/checks.py` and `workflow/verification.py` (the trusted verifier, packets, gates, ownership),
`workflow/export_state.py` and `workflow/launch.py`. The tests in `workflow/test_*.py` are the executable specification;
read them to decide what is proven. Also read the recorded evidence of real runs under
`~/.local/state/md-manager-workflows/` (`events.jsonl`, `report.html`, `verification/`, `relaunched/`), read-only: they
show what actually happened, including a run that ended on a transient `blocked` session and a run that burned three
identical candidate attempts.

## The questions to answer

Answer each question in its own section, in this order, with the headings below. For each: the answer in one or two
sentences first; then how it works, with `path:line` citations; then what proves it (test names, or "untested"); then
gaps, risks and what you would change, compared with what you know of good practice for durable agent orchestration
(LangGraph checkpointing and interrupts, idempotent nodes, bounded retries, human-in-the-loop gates, least privilege).

1. **Interrupted runs.** Can an interrupted run be resumed, and how? Cover each interruption point separately: the
   supervisor interrupted with Ctrl-C while workers are running; a controller process crash; an interruption while the
   trusted verifier is running; while the reviewers are running; after a reviewer file was accepted but before the
   decision was persisted; during integration. State what is lost in each case, what the operator must type, and which
   states are documented as retained but not resumable.
2. **Failed checks.** When a verification check fails, does anything go back to the worker? Describe the worker-phase
   gate, the deferred kinds, the combined-candidate gate, the attempt limit, the identical-failure stop, and what an
   operator has to do after a candidate failure. Say whether a lane whose checks passed is affected by a sibling lane's
   failure.
3. **Worktree safety.** Are the per-lane worktrees, the candidate worktree and the reviewer worktree safe? Cover
   isolation from the source checkout, how ownership is enforced against captured files rather than reports, how
   snapshots are made immutable, how evidence is hashed and rechecked, what happens to worktrees after a run, stale
   registrations, and what a worker could do to another lane's tree or to the source checkout.
4. **Blocked and stuck sessions.** What happens when a worker or reviewer session reports `blocked`, asks a question,
   hits a permission prompt or a refusal, disappears from the native inventory, or never writes its completion file?
   Which of these end the run, which wait, and until when? Is the "worker needs attention" grace path tested, and can it
   be proven without a live session?
5. **Session identity and reconciliation.** How does the controller know a completion file came from the session it
   launched? Cover launch tokens, receipts, native UUIDs, `reconcile`, the independence check between workers and
   reviewers, and what a relaunched attempt archives.
6. **Permissions and blast radius.** What can a worker execute and write, what can a reviewer execute and write, and what
   stops a worker from committing, pushing, editing another lane's files or the run directory? What could a hostile
   repository (task text, README, test fixture) make a worker or reviewer do, and what limits it?
7. **Parallel reviewers.** How do several reviewers combine: unanimity, the first block, superseded reviewers,
   per-reviewer deadlines, native versus print transport, manual import per reviewer. Where does print transport differ?
8. **Evidence and the viewer.** Is the exported `run-state.json` a faithful record? Cover legacy carries, contract
   versions, what `workflow status` versus `workflow export` write, and what the viewer can show while a run is live.
9. **What ends a run permanently.** List every condition that stops a run with no in-run recovery, with its message,
   and say for each whether that is a deliberate integrity boundary or an accident of the implementation.
10. **Ranked recommendations.** At most ten, ranked by how much each would reduce operator intervention per run without
    weakening an integrity boundary. Each names the file and function it changes and the test that would prove it.

## Completion

Signal completion only when the document is complete for all ten sections and both checks pass. In your completion
summary list the checks you ran with their results and, as open assumptions, every claim you could not verify from
code or tests.
