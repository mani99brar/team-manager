# PRD: Multi-provider panel (report-only, configurable, multi-stage)

Status: Proposed 2026-10-06, from the operator's grill of 2026-10-06 ("add the multi-provider setup to the workflow pipeline"). Revised after design-challenge attempt 1 (see `features/multi-provider-panel/decisions.md` [L1]). Builds on the attack pass ([PRD_ATTACK_PASS.md](PRD_ATTACK_PASS.md): the report-only parallel-branch pattern, the detached child with a running marker and liveness check, the record/export/events/node contract of its Appendix A) and the workflow improvements ([WORKFLOW_IMPROVEMENTS.md](WORKFLOW_IMPROVEMENTS.md): C36/C37 the second-provider hunt, C35 reviewer inputs) and the session's evidence ([WORKFLOW_LEARNINGS.md](WORKFLOW_LEARNINGS.md) §2 correlated blind spots, §4 multi-provider decorrelation, §5 the corrected `pi` transport). Pilot: a pine feature's review stage.

## 1. Goal

A feature can opt into one or more **panels**. A panel is a **report-only, configurable, multi-provider** reviewer that runs at a chosen **stage** (`challenge` or `review`), sends that stage's material to several providers (Claude, and/or pi-routed GPT/DeepSeek), records each provider's findings, and annotates them with **cross-provider overlap**. It never blocks and never changes the run's verdict. It has its own record, export section and exported graph node, and runs as a detached child under one guard that never raises into the run.

A panel is the same mechanism wherever it attaches: the operator configures one instance per stage. The transport per provider is configurable — any provider slot is `claude` or `pi` (`pi` reaches GPT/DeepSeek) — through a transport adapter, so the panel is not tied to one model family.

Why it is needed (WORKFLOW_LEARNINGS §2, §4):
- The pipeline's LLM-judgment layers (reviewers, sidecar, attacker, skeptic) look like independent coverage but share correlated blind spots — prompt-sensitivity and scope-conservatism. They fail the same way. Stacking more same-family judges does not buy independence.
- Multi-provider *review* decorrelates those blind spots. Given identical material, a **different provider through pi (`gpt-6-sol`) found SEC-GH-11 (P0) in 39 s** — the forged-provenance bug the attack pass missed at both effort levels and pine's own security review caught in only 0–2 of 3 samples. Cross-provider **overlap** (a finding two or more providers independently raise) is the highest-confidence signal in the batch.
- The design challenge is where >half of attempts are paused on real design flaws, before any code is written (the cheapest place to catch them). A panel there gives the challenge a second and third pair of eyes from other providers.

Success, for the pilot: on ≥3 runs of a pine feature with a review panel on, every provider's findings are recorded with per-provider status and cost; the overlap annotation is correct (a finding ≥2 providers raised is marked accepted at threshold 2); the operator has code-confirmed the accepted findings; and the panel never changed the run's verdict, never raised, and left plans without `panels` behaving exactly as today. A run whose panel fails, times out or returns nothing integrates exactly as a run without one.

## 2. Confirmed decisions (grill, 2026-10-06; refined by [L1])

| Topic | Decision |
|---|---|
| Shape | An extra reviewer-like node, **reusable across stages** (design challenge *and* review), customizable per stage. [O1] |
| Record | Its **own node and own record** (`panel.json`), **not** a `plan.reviewers` entry, so the review-step first-block rule (`automatic.py:918-919`) can never drop its findings. Exported as a `panel-<id>` node (kind `review`); like the sidecar/challenge/attack pass it is not a LangGraph node, so old plans keep their graph. [G1] |
| Config | **One `panels` config**: a single reusable panel node type, instances declared per feature, each with its stage, provider list, prompt, requirements, budget, timeout, overlap threshold, report-only. [O2] |
| Transport | A transport adapter wired into the **panel only** this slice (`claude` + `pi`); other roles stay on `claude`. [O3] |
| Findings | **Report-only + cross-provider overlap**, with a **configurable acceptance threshold** (`>=N` providers, or `all`, or `1`). No automated verifier in v1 — overlap + operator triage. [O4] |
| Providers | Default = **Claude + GPT via pi (`gpt-6-sol`)**. DeepSeek is **supported** as a configurable provider but **off by default** until its key (C42) is rotated, moved to a 0600 config and deny-listed. [O5] |
| Architecture | The panel is a **detached child** (`python -m workflow.panel <run> <stage>`) with a running marker + liveness check, exactly like the attack pass. The **review** stage waits for it up to its overall bound after the review has decided (the `close_or_wait_attack` pattern). **This slice produces live panels at the `review` stage only** (a `stage: challenge` panel is refused at launch); the engine `challenge`-stage wiring (its no-wait path, its reaper, its pinned-sources context) is the follow-up slice, though the **viewer already renders a `challenge`-stage record** (from the export) so the follow-up is engine-only. Config/schema stay stage-agnostic so `[O1]` holds. [G1, L1, L3] |
| Context | The controller assembles **one context file per stage**, each section labelled with one canonical repo-relative path, and passes it to every provider identically, **in full, no chunking**: challenge → PRD + lane tasks + `decisions.md` + the operator's request (the feature.json `name`); review → candidate diff + the requirements docs (`plan.panels[].requirements`) + PRD + the touched files. [G4, L1] |
| pi transport | `pi -p --mode json --no-session -nt -nc -ns -ne -np --model <provider/model>`, the context via **`@<file>`** (never argv → `ARG_MAX`), **stdin closed** (`DEVNULL`), **no tools** (`-nt`, the proven path), per-provider **timeout → skip**. The parser skips `thinking*` events and takes the **assistant** `message_end` text (there are two `message_end` events). [G3, L1] |
| Report-only | Never blocks, never changes the verdict; at `challenge` it is advisory input recorded beside the challenge, at `review` it is report-only. [O4] |
| Failure | A provider hang/timeout/error is recorded for that provider and the panel continues; a panel failure is recorded `failed` and the stage continues; the panel never raises. [G2] |
| Cost | Record cost where the transport reports it. pi `--mode json` reports `usage.cost.total` for **every** provider, including `openai-codex` — a **non-zero estimate** (~$0.005 for a tiny review; the ChatGPT/OAuth account is flat-rate, so it is pi's estimate, recorded as reported, not actual out-of-pocket). The **record** (`panel.json`/export) keeps the estimate; the **viewer displays `subscription-covered`** (no dollar amount) for an `openai-codex` provider row — matching the pinned `panel-section` scenario — and the dollar estimate for metered providers. DeepSeek (API key) is metered; Claude is covered by the plan. [G8, refined by L1/L2] |
| Secrets | pi gets **no tools** and only the assembled context file, so it cannot read arbitrary paths; its env is `env -i` with `PATH` (including the nvm node bin), `HOME`, `LANG`, `TMPDIR` and only the configured provider's own credential variable. The claude provider's cwd is the stage worktree only, with no `--add-dir` into the run directory. DeepSeek stays disabled until its key is rotated (4.2). `userEmail` is never sent to any provider. [G7, refined by L1] |
| Judging | v1 = overlap annotation + operator triage; no automated skeptic/verifier node. [G9] |
| Old runs | A plan without `panels`, an export without the section and a feature before 2.6.0 behave exactly as today. [G2] |

Deferred (not this slice): broadening the transport adapter to workers/reviewers/judges ("switch a worker to pi"); an automated skeptic/verifier step; promotion to blocking, or challenge-pause teeth; tool-read context for pi (needs a pi path-deny mechanism — none on this VPS); fixing the review first-block rule (the own-node design sidesteps needing it now).

## 3. Configuration

A target feature's `feature.json` 2.6.0 adds the optional `panels` (2.5.0 and earlier launch unchanged; `panels` on an earlier version is refused). `prepare` pins the panels into `plan.panels` (including each panel's `requirements`, resolved to repo-relative paths, exactly as the attack pass pins `requirement_docs`); a plan without `panels` means none.

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
      "requirements": ["docs/security/requirements.md"],
      "budget_usd": 5,
      "timeout_minutes": 15,
      "overlap_threshold": 2,
      "report_only": true
    }
  ]
}
```

- `id` is unique per feature. `stage` is `challenge` or `review` (a `stage: challenge` panel is refused at launch this slice). The panel's events use node id `panel-<id>` but add **no graph node and no reserved id** this slice.
- Each `providers[]` entry is `{transport: "claude"|"pi", model?, effort?}`. `claude` with no model runs the ambient/judge default; its `effort` is taken from the entry (the model may fall back to the judges pin). `pi` requires a `model` of the form `provider/id` (`openai-codex/gpt-6-sol`, `deepseek/deepseek-v4-pro`). A `deepseek/*` provider is **refused at launch** until the DeepSeek key guard is satisfied (section 4.2).
- `prompt` is the panel's brief, relative to the feature directory. `requirements` is 0–10 repo-relative paths pinned at prepare and placed in the context file (the review stage's requirements docs; for the challenge stage it may be empty). `overlap_threshold` is an integer `N` (accept a finding raised by ≥N providers), or `"all"`, or `1` (accept any). `report_only` must be `true` in v1 (a non-true value is refused).
- `budget_usd` bounds the claude provider via `--max-budget-usd`; pi has no budget flag, so for a pi provider `budget_usd` is informational and the `timeout_minutes` is the only bound. A provider job is stopped at the timeout.
- No policy (`policy.json`) change is required: a panel runs review jobs, not tests.

## 4. Design

### 4.1 Flow

```
stage runs (challenge, or the review step)
  ├─ the stage's own work (challenge job / reviewers) — unchanged
  └─ panel(s) for that stage (only when plan.panels has one)
       the controller starts a DETACHED child  `python -m workflow.panel <run> <stage>`
       (a running marker + pid-cmdline liveness check, exactly like the attack pass), which:
        1. assembles ONE context file for the stage, each section labelled with a canonical path
        2. runs one provider job per providers[] entry, in parallel, on the same context file
             - claude: print reviewer path (popen_claude, stream-json), read-only, cwd = stage worktree
             - pi:     pi -p --mode json -nt @<context>, stdin closed, scrubbed env
        3. each job returns findings (panel.schema.json $defs.finding)
        4. normalizes findings (canonical-path anchoring), computes cross-provider overlap,
           marks each `accepted` per overlap_threshold
        5. writes panel.json, the attention record, events, cost records
```

**Who waits.** `panel.ensure_started` is called at the same three points as the attack pass (after `review.diff` and the review worktree exist). The REVIEW stage, after the reviewers decide, waits for the attack child and the panel child in **one** loop bounded by `max(attack bound, panel bound)` — not the sum — before the review step closes (the `close_or_wait_attack` pattern); the panel never delays the review's own verdict, only the step's close. The CHALLENGE stage does **not** wait: a paused or passed challenge records its result and the controller exits, and the detached panel child outlives it; its record reaches the viewer through the live-vs-export rule (Appendix A). Either way the panel's result never gates the stage's decision.

The panel is not a LangGraph node, as the sidecar, the design challenge and the attack pass are not. Old plans and their checkpoints keep the same graph. **This slice adds no exported graph node either** — `definition()` is byte-identical for every run; the panel's events render as run-level rows (an exported `panel-<id>` node is the follow-up slice with the challenge stage).

It never raises into the run. The child runs under one guard like the sidecar's and the attack pass's: a failure is recorded `failed` with its error in `panel.json` and one event, and the stage continues. A run with a failed or empty panel integrates exactly as one without.

**Deadlines.** Each panel keeps its own bound: each provider's `timeout_minutes`, and one overall bound fixed when the panel starts (those timeouts plus a fixed margin; the formula is recorded in the engine handoff), past which the child stops the panel and records it `failed`. A stage's own deadline (the reviewer deadline, the challenge) never stops a panel; at the review stage the panel may hold the step's *close* up to its overall bound, but never the review verdict.

### 4.2 Launch guards

- A `panels` key on a feature below 2.6.0 is refused: "feature.json panels needs version 2.6.0".
- A `report_only` other than `true` is refused (blocking is not in v1).
- A `pi` provider with no `model`, or a `model` not of the form `provider/id`, is refused.
- **DeepSeek key guard.** A `deepseek/*` provider is refused at launch (dry run included) unless `WORKFLOW_PANEL_ALLOW_DEEPSEEK=1` is set *and* the live key's SHA-256 equals the fingerprint the operator recorded after rotation. The fingerprint lives in `~/.config/md-manager/panel-deepseek.fingerprint` (0600, the SHA-256 of the allowed/rotated key); the guard refuses when the file is absent, unreadable, or does not match: "Blocked: the DeepSeek key (C42) must be rotated and its fingerprint recorded before a DeepSeek panel provider runs; see PRD_MULTI_PROVIDER_PANEL 4.2". Until then, configure the panel with `claude` + `openai-codex/*` only.
- **The transport proofs run inside `launch_commands` (dry run included), not preflight** — a dry run never reaches preflight (`executes: False`), and the attack pass likewise runs its guard in `launch_commands`. When a panel declares a `claude` provider, the check requires `--max-budget-usd` in `claude --help` and a valid `effort`; when it declares a `pi` provider, it resolves `pi` (controller `PATH`, then the nvm bin), runs `pi --version`, and passes the resolved bin directory to `prepare` (pinned into `plan.panels` for the child's `env -i` `PATH`); preflight re-checks. Launch (dry run included) is refused otherwise.
- **Version enums.** 2.6.0 joins the `feature.schema` version enum **and** every per-module version set a 2.6.0 feature may also use — `GUARDED_VERSIONS` (prd/challenge), `SIDECAR_VERSIONS`, `ATTACK_VERSIONS`, `CRITICAL_VERSIONS` — so a 2.6.0 feature carrying `prd`, `sidecar`, `attack`, `critical` and `panels` launches (the pilot pine feature carries `attack`, PRD §5 step 2). `panels` on 2.5.0 and earlier is still refused.
- **Stage, this slice.** `stage` must be `review`; a `stage: challenge` panel is refused at launch — the challenge-stage wiring is the follow-up slice (PRD §5 step 3). The challenge default is `manifest.get("challenge", True)`, so a feature with no `challenge` key is normal and never blocks a review-stage panel.

### 4.3 The provider job

- **Context.** The child assembles one read-only context file for the stage (section 2, [G4]) under the run directory (`<run>/panel/<id>/context.txt`). Every section is headed by **one canonical repo-relative label** — review stage: the file's repo-relative path; challenge stage: the PRD's repo path, `features/<f>/<lane>-task.md`, `features/<f>/decisions.md`, and the literal `operator-request`. For the `challenge` stage the child reads the **same pinned sources** as `challenge_prompt` (the pinned PRD copy in `challenge-inputs`, the plan's pinned task text, `decisions_text(plan)`), not the worktree, so it critiques exactly what the challenge judged. It contains only run material already inside the pipeline; it never contains `userEmail`, credentials or host paths beyond the candidate tree.
- **claude job.** Started like a print reviewer (`print_command`, `popen_claude`), read-only (`Read,Glob,Grep`), the panel brief then the context file's contents as the prompt, the C14 worker `--settings` (deny rules on credential files). Its `--effort` comes from the `providers[]` entry and **replaces** the judges' `--effort` that `print_command` would append through `pins` (exactly one `--effort` in the argv); `--max-budget-usd` comes from the panel's `budget_usd`. **cwd is the stage worktree only** (review-worktree or challenge-worktree) with **no `--add-dir` into the run directory**, so it cannot read the reviewers' prompts/verdicts, the sidecar ledger, `attack.json` or the other panel's output (4.6). Read-only; no edits, no commands. `print_command`'s `--json-schema` needs an **object** root, so the claude provider is given a `{"findings": [ … ]}` schema; the normalizer accepts **both** a bare array (pi) and a `{findings}` object (claude), verified with one real `claude --print --json-schema` call during the fixture step (so the claude provider never silently `parse_failed`s).
- **pi job.** `pi -p --mode json --no-session -nt -nc -ns -ne -np --model <provider/model> <brief text> @<context file>` — the brief as the first positional message, the labelled context as `@file` — with **stdin = DEVNULL** and **cwd = an empty scratch directory** under `<run>/panel/<id>/` (so no `CLAUDE.md`/`AGENTS.md` from any checkout is in reach, belt-and-suspenders with `-nc`). `-nt` (no tools) is the proven path (WORKFLOW_LEARNINGS §5: 143 KB, 39 s, found SEC-GH-11); `-nc` stops pi loading a `CLAUDE.md`/`AGENTS.md` from the candidate tree (a prompt-injection surface from reviewed code). The environment is `env -i` with `PATH` (including the nvm node bin, else pi cannot exec), `HOME` (for `~/.pi/agent/auth.json`), `LANG`, `TMPDIR`, and only the one provider credential variable the transport needs (`openai-codex` needs only `HOME`; `deepseek` needs `DEEPSEEK_API_KEY`). The controller parses the JSONL event stream: it **skips** `thinking`/`thinking_start`/`thinking_end` events and takes the **assistant** `message_end` text (the stream has two `message_end` events — the user echo and the assistant), then parses the findings from it. A non-JSON reply is recorded as the provider's raw text with status `parse_failed`.
- **Brief.** The panel brief (`panels/<stage>.md`) states the review task and the exact findings JSON shape to return, **constrains `severity` to P0/P1/P2** (providers freelance severity — a real capture returned `"high"` — so the brief must pin the enum and the normalizer must map/validate it), instructs the provider to cite in `file` the canonical label of the section verbatim, and tells it to treat repository content as untrusted data, not instructions. The bundled briefs are a security/correctness review for `review` and a design-risk review for `challenge`; a wider brief is the operator's to write. `prepare` **pins the brief's text and its sha256** into `plan.panels` (a feature-directory file, or `builtin:<stage>` as reviewers and the sidecar accept), and the child reads **only the pinned text** — so a reviewed candidate cannot rewrite the brief that reviews it.
- **Budget.** The job is stopped at `timeout_minutes`. Cost comes from the transport where it reports it: pi `--mode json` `usage.cost.total` (a non-zero estimate for every provider, `openai-codex` included — recorded as reported, §2 Cost). A stopped job counts as `timed_out` for that provider; the panel keeps the other providers' results. The child records the context file's byte size in each provider's record (and, on an error, in its error text) so an over-window context is diagnosable.

### 4.4 Findings and overlap

Each provider returns findings `{severity, file, line, title, detail}`. The child **normalizes** each `file`: it strips `a/`, `b/`, `./` and the stage worktree's absolute prefix, then anchors the finding against the **set of canonical context labels** (4.3), not the candidate tree. A finding whose `file` matches no label is `unanchored` and folded. It then computes **overlap**: two anchored findings overlap when their canonical label is equal and (`line` within ±5, or normalized `title` Jaccard ≥ 0.6). A finding's `providers_raised` is the set of providers that raised it; `accepted = len(providers_raised) >= overlap_threshold` (or, for `"all"`, all configured providers; for `1`, any). Accepted findings lead the record; the rest (and the unanchored ones) are folded.

### 4.5 Records — see Appendix A.

### 4.6 Independence

- The panel's providers each get only the assembled context file and the brief; they do not get each other's output, the workers' completion claims, the sidecar ledger, the reviewers' findings or the attack pass. The claude provider's cwd is the stage worktree with no run-directory `--add-dir` (4.3), which enforces this.
- The reviewers, the design challenge job and the attack pass get nothing about the panel.
- The panel never writes to the candidate; its record stays in `<run>/panel/` and is never merged.

### 4.7 Old runs

A plan without `panels`, an export without the `panels` section and a feature before 2.6.0 behave exactly as today.

## 5. Rollout

1. Build this feature (two lanes, section 6) on the md-manager controller — the **review stage only** this slice; validate with `launch --dry-run`.
2. Pilot a **review** panel on a pine feature: providers `claude` + `openai-codex/gpt-6-sol`, `overlap_threshold` 2, report-only. Run ≥3 times; the operator code-confirms the accepted findings and compares them with `review.json` and `attack.json`.
3. **Follow-up slice (engine-only):** add the **challenge** stage's `ensure_started`, its no-wait/live-record path, the reaper for a child that outlives a paused controller, and the pinned-sources challenge context — once the review panel's record, adapter and viewer are trusted. The challenge **view** already renders a record this slice, and the config/schema are already stage-agnostic, so this is engine wiring, not a redesign.
4. Rotate the DeepSeek key (C42), record its fingerprint in `~/.config/md-manager/panel-deepseek.fingerprint`, set `WORKFLOW_PANEL_ALLOW_DEEPSEEK=1`, and add `deepseek/deepseek-v4-pro` as a third provider — once DeepSeek's transport is confirmed live again (it was hanging on 2026-10-06).

Deferred to later slices: broaden the transport adapter to other roles; add a verifier/skeptic node; promotion to blocking or challenge-pause teeth; tool-read context for pi.

## 6. Build: two lanes

- **engine** (`workflow`, `contracts/workflow`): the `panels` manifest key and the 2.6.0 bump **joined into the `feature.schema` enum and into `GUARDED_VERSIONS`/`SIDECAR_VERSIONS`/`ATTACK_VERSIONS`/`CRITICAL_VERSIONS`** (4.2), prepare pinning into `plan.panels` (requirements resolved like `requirement_docs`), the launch guards (4.2, incl. the review-only stage guard and preflight proving the transports), `workflow/panel.py` (the detached child + running marker + liveness for the **review** stage, context assembly with canonical labels, the transport adapter with `claude` and `pi` builders/parsers, overlap, the never-raises guard, the pinned node statuses of Appendix A), `panel.json` and `contracts/workflow/panel.schema.json` (plus the `contracts/workflow/contract.test.ts` version-enum assertion updated to include `2.6.0`), events (run-level, no graph node) and cost records, **the `panels` export section and the `EXPORT_VERSION` 1.9.0 bump in `workflow/export_state.py`, and the `legacy_run`/panel-null/`by_role`-unchanged regression in `workflow/test_export.py`** — `graph_nodes()`/`definition()` are left untouched. Handoff: `docs/handoff/panel-engine.md`.
- **viewer** (`server`, `contracts/projects`, `src/projects`, tests): accept export **1.9.0** in `server/projects.ts`, `panelResults` in the `contracts/projects` contract, and the run page's "Panel" section (per panel: accepted findings with overlap badges and per-provider status/cost, the rest folded), opened from the run page (there is **no** graph node this slice, so no `triage.ts`/reserved-id change). The UI component is `src/projects/providerPanel.tsx` with `tests/unit/providerPanel.test.ts` (the names `panels.tsx`/`panels.test.ts` already exist and must not be reused). The run page **and the challenge view** both render the Panel section from the export record (the pinned `panel-challenge-and-live` scenario seeds a `challenge`-stage record; the engine produces a *live* challenge-stage panel only in the follow-up slice). The viewer does **not** edit `workflow/`, `workflow/test_export.py` or `contracts/projects/triage.ts` (triage arrives with the node in the follow-up slice). Handoff: `docs/handoff/panel-viewer.md`.

## Appendix A — the record, export, events and node both lanes build to

- **`<run>/panel.json`** (schema `contracts/workflow/panel.schema.json` 1.0.0). Per panel: `{id, stage, status, overlap_threshold, context_bytes|null, providers: [...], findings: [...], started_at|null, ended_at|null, budget_usd, error|null}`. `status` is `pending|running|succeeded|failed|timed_out`. Each provider: `{transport, model|null, effort|null, status: pending|running|ok|timed_out|error|parse_failed, cost_usd|null, context_bytes|null, finding_ids: [...], error|null}` (`model` null for a default `claude`; `effort` null for `pi`). Each finding: `{id, severity, file, line|null, title, detail, providers_raised: [...], accepted: bool, unanchored: bool}`. `context_bytes`, `started_at`, `ended_at` are null until the child starts. A **panel-level `error`** (string or null) carries the failure reason when a panel fails before or without a provider error — an assembly throw, a dead child, a passed bound, or an unreadable/invalid `panel.json` the export reads (as the attack pass builds a `failed` record with `error`). The detached child is its only writer, under its own blocking **`panel.lock`** (an flock modelled on the attack pass's `record_lock`, a separate file) — **never** the controller's non-blocking `run_lock`/`controller.lock`, which the controller holds for the whole step. The schema and the viewer's `panelResults` parser both validate these two records verbatim (the contract test compares them, as the attack pass does):

  ```json
  {
    "version": "1.0.0",
    "panels": [
      {
        "id": "review-panel", "stage": "review", "status": "succeeded",
        "overlap_threshold": 2, "context_bytes": 48213,
        "providers": [
          {"transport": "claude", "model": null, "effort": "high", "status": "ok", "cost_usd": null, "context_bytes": 48213, "finding_ids": ["f1"], "error": null},
          {"transport": "pi", "model": "openai-codex/gpt-6-sol", "effort": null, "status": "ok", "cost_usd": 0.0047, "context_bytes": 48213, "finding_ids": ["f1"], "error": null}
        ],
        "findings": [
          {"id": "f1", "severity": "P1", "file": "packages/api/src/modules/claims/reconcile.ts", "line": 52, "title": "mined set from non-final evidence", "detail": "A reorg can strand a mined publication.", "providers_raised": ["claude", "openai-codex/gpt-6-sol"], "accepted": true, "unanchored": false}
        ],
        "started_at": "2026-10-06T07:00:00Z", "ended_at": "2026-10-06T07:00:39Z", "budget_usd": 5, "error": null
      }
    ]
  }
  ```

  The `pending` record the export builds from `plan.panels` before the child writes (a `running` record is the same with `status`/provider `status` = `running` and `started_at` set, `ended_at` null):

  ```json
  {
    "version": "1.0.0",
    "panels": [
      {
        "id": "review-panel", "stage": "review", "status": "pending",
        "overlap_threshold": 2, "context_bytes": null,
        "providers": [
          {"transport": "claude", "model": null, "effort": "high", "status": "pending", "cost_usd": null, "context_bytes": null, "finding_ids": [], "error": null},
          {"transport": "pi", "model": "openai-codex/gpt-6-sol", "effort": null, "status": "pending", "cost_usd": null, "context_bytes": null, "finding_ids": [], "error": null}
        ],
        "findings": [], "started_at": null, "ended_at": null, "budget_usd": 5, "error": null
      }
    ]
  }
  ```
- **Overlap rule (pinned):** normalize each `file` by stripping `a/`, `b/`, `./` and the stage worktree's absolute prefix, then anchor it to the set of canonical context labels; a finding matching no label is `unanchored: true` and folded. Two anchored findings match when their label is equal and (`line` within ±5, or normalized `title` Jaccard ≥ 0.6). `providers_raised` lists each matching provider once. `accepted` per `overlap_threshold`.
- **Export** bumps to **1.9.0** (engine-owned, in `workflow/export_state.py`): a top-level `panels` section that is the `panel.json` record **verbatim** (the object `{version, panels: [...]}`), the same object the viewer serves live; a **`pending`** record built from `plan.panels` before `panel.json` exists; **null** for a run without `plan.panels`. The projects contract's `panelResults` (viewer-owned) parses that object.
- **Cost:** panel costs live in `panel.json` only; the C49 `ROLES`/`by_role` cost export is **not** changed, so every old run's `costs` section stays byte-for-byte unchanged.
- **Dead child → failed.** This slice is review-only, so `close_or_wait` already records a review child that is not alive past the startup grace as `failed` (the attack precedent). The challenge-stage reaper (for a child that outlives a paused controller) is the follow-up slice.
- **Viewer section.** The viewer shows a "Panel" section on the run page and, for a `challenge`-stage record, on the challenge view: per panel the accepted findings (severity, file:line, title, detail, the providers that raised it), then the folded rest, then each provider's status and cost (`subscription-covered` for an `openai-codex` row, the estimate for a metered one). A pending run says the panel runs at its stage; a failed panel shows its error; a run with `panels` null has no section; the section opens from the run page (**no graph node** this slice); at 390 px no horizontal overflow.
- **Live vs export (pinned):** the viewer serves the live `panel.json` whenever it is readable and valid, else the export's `panels` — the attack/sidecar precedent, **no mtime comparison**.
- **Attention:** a new kind `panel`: one record when a panel ends with at least one accepted finding, naming the counts.
- **Events and node statuses (pinned, mirroring the attack pass PRD_ATTACK_PASS "node").** On node `panel-<id>`: `running` on start; `interactive` for any provider or panel failure; exactly **one** closing `succeeded`; **never** `failed` or `blocked`; and never left `running` after the review step — so the run's state stays the review's, never the panel's. The record status in `panel.json` (`failed`/`timed_out`/`succeeded`) is separate from the node event, which is always advisory. The reaper, when it records a panel `failed` in `panel.json`, still emits the node's closing `succeeded` event. Event texts: `Panel <id> started (<stage>)`, `Panel <id>: <n> finding(s), <a> accepted (overlap>=<t>)`. They are added to the viewer's controller-row patterns where needed (no "Traceback"/"Error" literals that trip the monitor). Because this slice adds **no graph node**, these events render as run-level rows and are never the run's focus, headline or Now banner — **no `triage.ts` change is needed** this slice (it arrives with the node in the follow-up slice).
- **Challenge rerun:** on a second `ensure_started` (challenge attempt 2 after an edit) the child skips a panel whose record is already terminal (`succeeded`/`failed`/`timed_out`), as `attack.ensure_started` does; rerun-on-changed-pins is a handoff lead.
- **Status/outcome:** `status` prints `panel <id>: <a> accepted of <n>`; the outcome block adds one line per panel after the review lines: `Panel <id> (report-only): ...`. It never changes the run's verdict.
- **No exported graph node this slice.** `graph_nodes()`/`definition()` are **unchanged** — byte-identical for every run, panels or not, and `approval.depends_on` is untouched. The panel's events carry node id `panel-<id>` but map to no graph node, so the viewer renders them as run-level rows (the server returns null for an unknown node); the Panel section opens from the run page, not a graph-node click. An exported `panel-<id>` node (and the `triage.ts` advisory handling it would need) is the follow-up slice with the challenge stage, where a node that outlives the controller needs a graph place. The panel pin still runs **last** at prepare so `plan.feature_version` is `2.6.0` (not overwritten by the attack/sidecar/challenge pins).
