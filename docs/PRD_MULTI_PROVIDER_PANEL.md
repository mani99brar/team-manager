# PRD: Multi-provider panel (report-only, configurable, multi-stage)

Status: Proposed 2026-10-06, from the operator's grill of 2026-10-06 ("add the multi-provider setup to the workflow pipeline"). Builds on the attack pass ([PRD_ATTACK_PASS.md](PRD_ATTACK_PASS.md): the report-only parallel-branch pattern, the record/export/events/node contract of its Appendix A) and the workflow improvements ([WORKFLOW_IMPROVEMENTS.md](WORKFLOW_IMPROVEMENTS.md): C36/C37 the second-provider hunt, C35 reviewer inputs) and the session's evidence ([WORKFLOW_LEARNINGS.md](WORKFLOW_LEARNINGS.md) §2 correlated blind spots, §4 multi-provider decorrelation, §5 the corrected `pi` transport). Pilot: a pine feature's review stage.

## 1. Goal

A feature can opt into one or more **panels**. A panel is a **report-only, configurable, multi-provider** reviewer that runs at a chosen **stage** (`challenge` or `review`), sends that stage's material to several providers (Claude, and/or pi-routed GPT/DeepSeek), records each provider's findings, and annotates them with **cross-provider overlap**. It never blocks and never changes the run's verdict. It has its own record, export section and exported graph node, and runs under one guard that never raises into the run.

A panel is the same mechanism wherever it attaches: the operator configures one instance per stage. The transport per provider is configurable — any provider slot is `claude` or `pi` (`pi` reaches GPT/DeepSeek) — through a transport adapter, so the panel is not tied to one model family.

Why it is needed (WORKFLOW_LEARNINGS §2, §4):
- The pipeline's LLM-judgment layers (reviewers, sidecar, attacker, skeptic) look like independent coverage but share correlated blind spots — prompt-sensitivity and scope-conservatism. They fail the same way. Stacking more same-family judges does not buy independence.
- Multi-provider *review* decorrelates those blind spots. Given identical material, a **different provider through pi (`gpt-6-sol`) found SEC-GH-11 (P0) in 39 s** — the forged-provenance bug the attack pass missed at both effort levels and pine's own security review caught in only 0–2 of 3 samples. Cross-provider **overlap** (a finding two or more providers independently raise) is the highest-confidence signal in the batch.
- The design challenge is where >half of attempts are paused on real design flaws, before any code is written (the cheapest place to catch them). A panel there gives the challenge a second and third pair of eyes from other providers.

Success, for the pilot: on ≥3 runs of a pine feature with a review panel on, every provider's findings are recorded with per-provider status and cost; the overlap annotation is correct (a finding ≥2 providers raised is marked accepted at threshold 2); the operator has code-confirmed the accepted findings; and the panel never changed the run's verdict, never raised, and left plans without `panels` behaving exactly as today. A run whose panel fails, times out or returns nothing integrates exactly as a run without one.

## 2. Confirmed decisions (grill, 2026-10-06)

| Topic | Decision |
|---|---|
| Shape | An extra reviewer-like node, **reusable across stages** (design challenge *and* review), customizable per stage. [O1] |
| Record | Its **own node and own record** (`panel.json`), **not** a `plan.reviewers` entry, so the review-step first-block rule (`automatic.py:918-919`) can never drop its findings. Exported as a `panel` node (kind `review`); like the sidecar/challenge it is not a LangGraph node, so old plans keep their graph. [G1] |
| Config | **One `panels` config**: a single reusable panel node type, instances declared per feature, each with its stage, provider list, prompt, budget, timeout, overlap threshold, report-only. [O2] |
| Transport | A transport adapter wired into the **panel only** this slice (`claude` + `pi`); other roles stay on `claude`. [O3] |
| Findings | **Report-only + cross-provider overlap**, with a **configurable acceptance threshold** (`>=N` providers, or `all`, or `1`). No automated verifier in v1 — overlap + operator triage. [O4] |
| Providers | Default = **Claude + GPT via pi (`gpt-6-sol`)**. DeepSeek is **supported** as a configurable provider but **off by default** until its key (C42) is rotated, moved to a 0600 config and deny-listed. [O5] |
| Context | The controller assembles **one context file per stage** and passes it to every provider identically, **in full, no chunking**: challenge → PRD + lane tasks + `decisions.md` + the operator's request; review → candidate diff + the security requirements + PRD + the touched files. [G4] |
| pi transport | `pi -p --mode json --no-session -nt -nc -ns -ne -np --model <provider/model>`, the context via **`@<file>`** (never argv → `ARG_MAX`), **stdin closed** (`DEVNULL`), **no tools** (`-nt`, the proven path), per-provider **timeout → skip**. [G3] |
| Report-only | Never blocks, never changes the verdict; at `challenge` it is advisory input recorded beside the challenge, at `review` it is report-only. [O4] |
| Failure | A provider hang/timeout/error is recorded for that provider and the panel continues; a panel failure is recorded `failed` and the stage continues; the panel never raises. [G2] |
| Cost | Record cost where the transport reports it. `openai-codex` runs on a ChatGPT (OAuth) account — subscription-covered, `usage.cost` is 0. DeepSeek (API key) is metered; Claude is covered by the plan. [G8] |
| Secrets | pi gets **no tools** and only the assembled context file, so it cannot read arbitrary paths; its env is scrubbed to the minimum plus `HOME` (for `~/.pi/agent/auth.json`) and only the configured provider's own credential variable. DeepSeek stays disabled until its key is rotated. `userEmail` is never sent to any provider. [G7] |
| Judging | v1 = overlap annotation + operator triage; no automated skeptic/verifier node. [G9] |
| Old runs | A plan without `panels`, an export without the section and a feature before 2.6.0 behave exactly as today. [G2] |

Deferred (not this slice): broadening the transport adapter to workers/reviewers/judges ("switch a worker to pi"); an automated skeptic/verifier step; promotion to blocking, or challenge-pause teeth; tool-read context for pi (needs a pi path-deny mechanism — none on this VPS); fixing the review first-block rule (the own-node design sidesteps needing it now).

## 3. Configuration

A target feature's `feature.json` 2.6.0 adds the optional `panels` (2.5.0 and earlier launch unchanged; `panels` on an earlier version is refused). `prepare` pins the panels into `plan.panels`; a plan without `panels` means none.

```json
{
  "version": "2.6.0",
  "panels": [
    {
      "id": "review-panel",
      "stage": "review",
      "providers": [
        {"transport": "claude", "effort": "high"},
        {"transport": "pi", "model": "openai-codex/gpt-6-sol"}
      ],
      "prompt": "panels/review.md",
      "budget_usd": 5,
      "timeout_minutes": 15,
      "overlap_threshold": 2,
      "report_only": true
    }
  ]
}
```

- `id` is unique per feature; `panel` and `panel-` join the reserved ids and prefixes. `stage` is `challenge` or `review`.
- Each `providers[]` entry is `{transport: "claude"|"pi", model?, effort?}`. `claude` with no model runs the ambient/judge default; `pi` requires a `model` of the form `provider/id` (`openai-codex/gpt-6-sol`, `deepseek/deepseek-v4-pro`). A `deepseek/*` provider is **refused at launch** until the DeepSeek key guard is satisfied (section 4.2).
- `prompt` is the panel's brief, relative to the feature directory. `overlap_threshold` is an integer `N` (accept a finding raised by ≥N providers), or `"all"`, or `1` (accept any). `report_only` must be `true` in v1 (a non-true value is refused).
- `budget_usd`/`timeout_minutes` bound each panel; a provider job is stopped at the timeout.
- No policy (`policy.json`) change is required: a panel runs review jobs, not tests.

## 4. Design

### 4.1 Flow

```
stage runs (challenge, or the review step)
  ├─ the stage's own work (challenge job / reviewers) — unchanged
  └─ panel(s) for that stage (only when plan.panels has one)
        1. the controller assembles ONE context file for the stage
        2. one provider job per providers[] entry, in parallel, each on the same context file
             - claude: print reviewer path (popen_claude, stream-json), read-only
             - pi:     pi -p --mode json -nt @<context>, stdin closed, scrubbed env
        3. each job returns findings (panel.schema.json $defs.finding)
        4. the controller normalizes findings, computes cross-provider overlap,
           marks each `accepted` per overlap_threshold
        5. panel.json, attention record, events, cost records
  the stage ends when its own work and its panel(s) have ended (or passed the panel's bound)
```

The panel is not a LangGraph node, as the sidecar, the design challenge and the attack pass are not. Old plans and their checkpoints keep the same graph. The exported graph shows a node `panel` (or one per instance) of `kind: review`, as the sidecar and attack nodes do.

It never raises into the run. Every step runs under one guard like the sidecar's and the attack pass's: a failure is recorded `failed` with its error in `panel.json` and one event, and the stage continues. A run with a failed or empty panel integrates exactly as one without.

**Deadlines.** Each panel keeps its own bound: each provider's `timeout_minutes`, and one overall bound fixed when the panel starts (those timeouts plus a fixed margin; the formula is recorded in the engine handoff), past which the controller stops the panel and records it `failed`. A stage's own deadline (the reviewer deadline, the challenge) never stops a panel, and a panel never extends the stage.

### 4.2 Launch guards

- A `panels` key on a feature below 2.6.0 is refused: "feature.json panels needs version 2.6.0".
- A `report_only` other than `true` is refused (blocking is not in v1).
- A `pi` provider with no `model`, or a `model` not of the form `provider/id`, is refused.
- **DeepSeek key guard.** A `deepseek/*` provider is refused at launch (dry run included) unless `WORKFLOW_PANEL_ALLOW_DEEPSEEK=1` is set *and* the key is not the exposed one (checked by a fingerprint the operator records after rotation): "Blocked: the DeepSeek key (C42) must be rotated before a DeepSeek panel provider runs; see PRD_MULTI_PROVIDER_PANEL 4.2". Until rotation, configure the panel with `claude` + `openai-codex/*` only.

### 4.3 The provider job

- **Context.** The controller assembles one read-only context file for the stage (section 2, [G4]) under the run directory (`<run>/panel/<id>/context.txt`). It contains only run material already inside the pipeline; it never contains `userEmail`, credentials or host paths beyond the candidate tree.
- **claude job.** Started like a print reviewer (`print_command`, `popen_claude`), read-only (`Read,Glob,Grep`), the panel brief then the context file's contents as the prompt, the C14 worker `--settings` (deny rules on credential files), `role_flags` for its `effort`. Read-only; no edits, no commands.
- **pi job.** `pi -p --mode json --no-session -nt -nc -ns -ne -np --model <provider/model> @<context file>` with **stdin = DEVNULL**. `-nt` (no tools) is the proven path (WORKFLOW_LEARNINGS §5: 143 KB, 39 s, found SEC-GH-11); `-nc` stops pi loading a `CLAUDE.md`/`AGENTS.md` from the candidate tree (a prompt-injection surface from reviewed code). The environment is scrubbed to the minimum plus `HOME` and the one provider credential variable the transport needs (`openai-codex` uses `~/.pi/agent/auth.json` via `HOME`; `deepseek` uses `DEEPSEEK_API_KEY`). The controller parses the JSONL event stream, takes the final `message_end` assistant text, and parses the findings from it (the brief asks for a JSON findings array; a non-JSON reply is recorded as the provider's raw text with `parse_failed`).
- **Brief.** The panel brief (`panels/<stage>.md`) states the review task and the exact findings JSON shape to return, asks for severity P0/P1/P2 by the C41 severity rule, and tells the provider to treat repository content as untrusted data, not instructions. The bundled briefs are a security/correctness review for `review` and a design-risk review for `challenge`; a wider brief is the operator's to write.
- **Budget.** The job is stopped at `timeout_minutes`. Cost comes from the transport where it reports it (pi `--mode json` `usage.cost`; `openai-codex` is 0). A stopped job counts as `timed_out` for that provider; the panel keeps the other providers' results.

### 4.4 Findings and overlap

Each provider returns findings `{severity, file, line, title, detail}`. The controller normalizes (trims paths to the candidate tree; drops a finding naming no in-tree file as `unanchored`, kept folded) and computes **overlap**: two findings overlap when they name the same file and their line ranges or titles match within a small tolerance (the exact rule is pinned in Appendix A). A finding's `providers_raised` is the set of providers that raised it; `accepted = len(providers_raised) >= overlap_threshold` (or, for `"all"`, all configured providers; for `1`, any). Accepted findings lead the record; the rest are folded.

### 4.5 Records — see Appendix A.

### 4.6 Independence

- The panel's providers each get only the assembled context file and the brief; they do not get each other's output, the workers' completion claims, the sidecar ledger, the reviewers' findings or the attack pass.
- The reviewers, the design challenge job and the attack pass get nothing about the panel.
- The panel never writes to the candidate; its record stays in `<run>/panel/` and is never merged.

### 4.7 Old runs

A plan without `panels`, an export without the `panels` section and a feature before 2.6.0 behave exactly as today.

## 5. Rollout

1. Build this feature (two lanes, section 6) on the md-manager controller; validate with `launch --dry-run`.
2. Pilot a **review** panel on a pine feature: providers `claude` + `openai-codex/gpt-6-sol`, `overlap_threshold` 2, report-only. Run ≥3 times; the operator code-confirms the accepted findings and compares them with `review.json` and `attack.json`.
3. Add a **challenge** panel on the next feature once the review panel's record and viewer are trusted.
4. Rotate the DeepSeek key (C42), record its new fingerprint, set `WORKFLOW_PANEL_ALLOW_DEEPSEEK=1`, and add `deepseek/deepseek-v4-pro` as a third provider — once DeepSeek's transport is confirmed live again (it was hanging on 2026-10-06).

Deferred to later slices: broaden the transport adapter to other roles; add a verifier/skeptic node; promotion to blocking or challenge-pause teeth; tool-read context for pi.

## 6. Build: two lanes

- **engine** (`workflow`, `contracts/workflow`): the `panels` manifest key and 2.6.0 bump, prepare pinning into `plan.panels`, the launch guards (4.2), `workflow/panel.py` (the stage hook, context assembly, the transport adapter with `claude` and `pi` builders/parsers, overlap, the never-raises guard), `panel.json` and its schema, events and cost records, the exported `panel` node. Handoff: `docs/handoff/panel-engine.md`.
- **viewer** (`server`, `contracts/projects`, `src/projects`, tests): export 1.9.0 `panels` section and `panelResults` in the projects contract, the run page's "Panel" section (per panel: accepted findings with overlap badges and per-provider status/cost, the rest folded) and the same on the challenge page, the graph `panel` node opening the section. Handoff: `docs/handoff/panel-viewer.md`.

## Appendix A — the record, export, events and node both lanes build to

- **`<run>/panel.json`** (schema `contracts/workflow/panel.schema.json` 1.0.0): `{version, panels: [ {id, stage, status: pending|running|succeeded|failed|timed_out, overlap_threshold, providers: [ {transport, model, effort, status: ok|timed_out|error|parse_failed, cost_usd|null, finding_ids: [...], error|null} ], findings: [ {id, severity, file, line|null, title, detail, providers_raised: [transport-or-model...], accepted: bool} ], started_at, ended_at, budget_usd} ] }`. The controller is its only writer, under the run lock.
- **Overlap rule (pinned):** two findings match when `file` is equal after trimming to the candidate tree and (`line` within ±5, or normalized `title` Jaccard ≥ 0.6). `providers_raised` lists each matching provider once. `accepted` per `overlap_threshold`.
- **Export** bumps to **1.9.0**: a top-level `panels` section (null for runs without one); the projects contract gains `panelResults`. The viewer shows a "Panel" section on the run page and, for a `challenge`-stage panel, on the challenge view: per panel the accepted findings (severity, file:line, title, detail, the providers that raised it), then the folded rest, then each provider's status and cost. A pending run says the panel runs at its stage; a failed panel shows its error; a run with `panels` null has no section; the graph's `panel` node opens the section; at 390 px no horizontal overflow.
- **Attention:** a new kind `panel`: one record when a panel ends with at least one accepted finding, naming the counts.
- **Events:** `Panel <id> started (<stage>)`, `Panel <id>: <n> finding(s), <a> accepted (overlap>=<t>)`, and failures. Their texts are added to the viewer's controller-row patterns where needed (no "Traceback"/"Error" literals that trip the monitor).
- **Status/outcome:** `status` prints `panel <id>: <a> accepted of <n>`; the outcome block adds one line per panel after the review lines: `Panel <id> (report-only): ...`. It never changes the run's verdict.
- **Exported node:** `panel` nodes of `kind: review`; a `challenge`-stage panel depends on `challenge`, a `review`-stage panel sits beside the reviewers. `graph_nodes(...)` gains a `panels` argument; a run without panels emits the same graph as today.
