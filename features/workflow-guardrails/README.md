# Workflow guardrails (slice 2)

Feature run for slice 2 of `docs/PRD_PORTABLE_WORKFLOW.md`. The `controller` lane enforces outcome-brief tasks and `decisions.md` for 2.2.0 features, ships the `workflow-grill` skill, adds the pre-worker design challenge with pause and resume, and moves worker completions to 1.1.0 with evidence fields and bounded questions, exported as 1.5.0. The `ui` lane shows the challenge, the evidence, the questions and the decisions in the Projects viewer, and makes run-served Markdown inert. Reviewed by `general` and `coverage` over the print transport.

This feature is itself 2.1.0, because the launcher that runs it predates 2.2.0; its tasks already follow the brief form, and `decisions.md` records the grill session.

Launch from md-manager's main checkout, in a new Herdr tab:

```
ANTHROPIC_MODEL=claude-opus-5-5 .venv/bin/python -m workflow launch workflow-guardrails --live --automatic --reviewer-transport print --worker-timeout-seconds 7200 --review-timeout-seconds 3600
```
