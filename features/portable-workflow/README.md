# Portable workflow (slice 1)

Feature run for slice 1 of `docs/PRD_PORTABLE_WORKFLOW.md`. One lane, `controller`, makes the workflow drive any repository (`--repo`, feature scanning, bundled schemas and reviewer briefs, registry auto-registration, `workflow init`) and trims the legacy code, the finished feature directories and five workflow docs. Reviewed by `general` and `coverage` over the print transport, which makes this run the first live test of that transport.

Launch from md-manager's main checkout, in a new Herdr tab:

```
ANTHROPIC_MODEL=claude-opus-5-5 .venv/bin/python -m workflow launch portable-workflow --live --automatic --reviewer-transport print --worker-timeout-seconds 5400 --review-timeout-seconds 3600
```

The lane task is written as an outcome brief (Goal, Context, Constraints, Acceptance, Stop), the form slice 2 will enforce.
