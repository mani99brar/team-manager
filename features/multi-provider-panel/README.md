# Feature: multi-provider-panel

A report-only, configurable **panel** node for the md-manager workflow. A target feature declares one or more panels in `feature.json` (`panels`, schema 2.6.0); each runs at a stage (`challenge` or `review`), sends that stage's material to several providers through a transport adapter (`claude`, and `pi` for GPT/DeepSeek), and records every provider's findings annotated with cross-provider **overlap**. It never blocks and never changes the run's verdict — it has its own record (`panel.json`), export section and exported `panel` node, and runs under a guard that never raises.

- **Spec:** `docs/PRD_MULTI_PROVIDER_PANEL.md`
- **Decisions (grill 2026-10-06):** `decisions.md`
- **Lanes:** `engine` (the node, transport adapter, config, record — `workflow`, `contracts/workflow`); `viewer` (export + run/challenge page section — `server`, `contracts/projects`, `src/projects`).
- **Why:** WORKFLOW_LEARNINGS §2/§4 — the pipeline's LLM judges share correlated blind spots; multi-provider review decorrelates them. GPT via pi found SEC-GH-11 (P0) that the attack pass missed.

**Transport note:** `pi -p` must run with stdin closed, `-nt` (no tools), context via `@file` (never argv), scrubbed env. `openai-codex` (GPT) is live and subscription-covered; **DeepSeek is supported but off by default** until its key (C42) is rotated. See the PRD §4.2 launch guards.

Launch (operator): `python -m workflow launch multi-provider-panel --repo <target> --dry-run`, then `--live --automatic --by operator`.
