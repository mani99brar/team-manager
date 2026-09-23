# Workflow audit

A one-lane run whose worker writes `docs/audit/WORKFLOW_AUDIT.md`: evidence-cited answers to the operator's questions
about the automatic workflow (resumability, failed checks, worktree safety, blocked sessions, permissions, parallel
reviewers, evidence, terminal conditions, recommendations). Two declared reviewers, `resilience` and `safety`, check the
answers against the code and tests independently; the run integrates only when both approve. It is also the PRD
`docs/PRD_PARALLEL_REVIEWERS.md` section 8 live smoke: two reviewer sessions and panes over one real bundle.

Launch: `python -m workflow launch workflow-audit --live --automatic --worker-timeout-seconds 5400`; repeat with
`--reviewer-transport print --run-id workflow-audit-002` to exercise the headless transport.
