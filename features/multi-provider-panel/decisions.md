# Decisions: multi-provider-panel

From the grill session of 2026-10-06 with the operator.

## Operator decisions

- [O1] Q1: An extra reviewer-like node, reusable at the design challenge and the review stage, customizable per stage. Operator: "It will run as an extra node like a new reviewer, i also plan to use this at the design challenge phase so the best idea is to make it customizable ".
- [O2] Q2: One `panels` config — a single reusable panel node type whose instances are declared per feature, each with its stage, provider list, prompt, budget, timeout, overlap threshold and report-only. Operator: "One panels config".
- [O3] Q3: The pi/claude transport adapter is wired into the panel only this slice; other roles (workers, reviewers, judges) stay on claude. Operator: "Panel only".
- [O4] Q4: Report-only plus cross-provider overlap, with a configurable acceptance threshold selectable per panel (for example accept a finding raised by ≥2 providers, or require all providers, or accept any). Operator: "Do 1 we should be able to select the threshold like a 2>= acceptance or all acceptance ".
- [O5] Q5: Default panel = claude + GPT via pi (`gpt-6-sol`); DeepSeek is supported as a configurable provider but off by default until its key is rotated. Operator: "1 as default but we want DeepSeek support as well ".
- [O6] Read-back 2026-10-06: confirmed the read-back as written (no change). Operator: "Confirm".

## Grill defaults

- [G1] The panel is its own node with its own record (`<run>/panel.json`), not an entry in `plan.reviewers`, so the review-step first-block rule (`automatic.py:918-919`) can never mark its findings superseded. It is exported as a `panel` node (`kind: review`); like the sidecar, the design challenge and the attack pass it is not a LangGraph node, so old plans and their checkpoints keep the same graph.
- [G2] Integration mirrors the attack pass: the panel runs inside its stage under one guard that never raises; a provider or panel failure is recorded `failed`/`timed_out` and the stage continues; a plan without `panels`, an export without the section and a feature before 2.6.0 behave exactly as today.
- [G3] pi transport: `pi -p --mode json --no-session -nt -nc -ns -ne -np --model <provider/model>`, context via `@<file>` (never argv → ARG_MAX), stdin closed (DEVNULL), no tools (`-nt`, the proven path), per-provider timeout → skip. Default usable GPT model `openai-codex/gpt-6-sol` (also `gpt-6.1-sol`, `gpt-5.6-sol`).
- [G4] The controller assembles one context file per stage and passes it to every provider identically, in full, no chunking: challenge → PRD + lane tasks + `decisions.md` + the operator's request; review → candidate diff + the security requirements + PRD + the touched files.
- [G5] Config lives in a target feature's `feature.json` `panels` (new schema 2.6.0, since `attack` took 2.5.0), pinned at prepare into `plan.panels`; each instance `{id, stage, providers:[{transport, model, effort}], prompt, budget_usd, timeout_minutes, overlap_threshold, report_only:true}`. No `policy.json` change is required (a panel runs review jobs, not tests).
- [G6] Overlap threshold default is `>=2` providers; configurable per panel to an integer N, `"all"`, or `1` (any). The overlap match rule is pinned in PRD Appendix A.
- [G7] Secret hygiene: pi gets no tools and only the assembled context file, so it cannot read arbitrary paths; its env is scrubbed to the minimum plus `HOME` (for `~/.pi/agent/auth.json`) and only the configured provider's own credential variable. The claude provider keeps the C14 worker deny-rule `--settings`. DeepSeek stays disabled until its key (C42) is rotated, moved to a 0600 config and deny-listed (launch guard, PRD 4.2). `userEmail` is never sent to any provider.
- [G8] Cost is recorded where the transport reports it: pi `--mode json` `usage.cost`; `openai-codex` runs on a ChatGPT (OAuth) account and is subscription-covered (`usage.cost` 0); DeepSeek (API key) is metered; Claude is covered by the plan. The record shows subscription-covered rather than a false $0 for openai-codex.
- [G9] v1 judging is the overlap annotation plus operator triage; there is no automated skeptic/verifier node.
- [G10] Names (rename freely): feature `multi-provider-panel`, PRD `docs/PRD_MULTI_PROVIDER_PANEL.md`, branch prefix `feature/multi-provider-panel-runs`.
- [G11] [added, not asked] This feature writes critical controller code (the review/challenge/export paths), so `feature.json` sets `"critical": true` and the policy keeps `integration_approval: true`: an automatic run stops after review for the operator's `approve` before any merge. The operator may veto this at the pre-launch read-back.

## Changes after launch

None yet.

## Deferred

- Broadening the transport adapter to workers, reviewers and judges ("switch a worker to pi"): a later slice, after the panel proves the adapter.
- An automated skeptic/verifier node that argues against or code-confirms panel findings.
- Promotion to blocking, and challenge-stage pause teeth: v1 is report-only at both stages.
- Tool-read context for pi (letting pi read files itself): deferred until a pi path-deny mechanism exists on this host; the proven `-nt` + `@file` path is used instead.
- Fixing the review first-block rule (REVIEW.md urgent #1): the own-node design (G1) sidesteps needing it for the panel.
