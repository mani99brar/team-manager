# Engine worker: the multi-provider panel in the controller (PRD_MULTI_PROVIDER_PANEL sections 3, 4, 6 item 1, Appendix A)

## Goal

A `feature.json` 2.6.0 feature can declare `panels`, and its run gets each panel at the stage it names (`challenge` or `review`): inside that stage, in parallel with the stage's own work, the controller assembles one read-only context file and runs one provider job per `providers[]` entry through a transport adapter — `claude` on the print path, `pi` on `pi -p --mode json`. Each job reviews the same context file and returns findings; the controller normalizes them, computes cross-provider overlap, marks each `accepted` per the panel's `overlap_threshold`, and writes `<run>/panel.json` (Appendix A), the `panel` node's events, the cost records and, when a panel ends with at least one accepted finding, one attention record. The panel is report-only: it never blocks, never changes the run's verdict, and never raises into the run — a provider or panel that fails, times out or returns nothing changes nothing. A feature without `panels`, every older feature version and every run prepared before this change behave exactly as today.

## Context

- `docs/PRD_MULTI_PROVIDER_PANEL.md` is the specification. Its **Appendix A** pins `panel.json`, the overlap match rule, the export section, the attention text, the event texts and the exported node; the `viewer` lane builds its fixtures from Appendix A, so do not change those shapes without changing the PRD. `features/multi-provider-panel/decisions.md` binds the run; its Grill defaults G1–G11 settle what the PRD leaves open.
- **The transport adapter** is the heart of this lane. Define one small interface with, per transport, a command-builder and an output-parser:
  - `claude`: reuse the print reviewer path (`popen_claude`, `role_flags(plan, "judges")` for the entry's `effort`, the read-only `Read,Glob,Grep` tool set and the C14 worker `--settings` deny rules). The prompt is the panel brief then the context file's contents.
  - `pi`: `pi -p --mode json --no-session -nt -nc -ns -ne -np --model <provider/model> @<context file>` with **stdin = DEVNULL** and an environment scrubbed to the minimum plus `HOME` and only the configured provider's own credential variable (`openai-codex` needs only `HOME`; `deepseek` needs `DEEPSEEK_API_KEY`). Parse the JSONL event stream: accumulate `text_delta`/take the final `message_end` assistant text, then parse the findings JSON from it; read `usage.cost.total` (0 and subscription-covered for `openai-codex`). A non-JSON reply is recorded with the provider status `parse_failed` and its raw text kept. (Proven path — WORKFLOW_LEARNINGS §5: `-nt` + `@file`, stdin closed, reviewed a 143 KB prompt in 39 s.)
- **Context assembly** (G4): one file per stage under `<run>/panel/<id>/context.txt`, the same bytes to every provider, in full with no chunking — `challenge`: the PRD + the lane task files + `decisions.md` + the operator's request; `review`: the candidate diff + the security requirements document + the PRD + the touched files. It carries only run material already inside the pipeline; never `userEmail`, credentials or host paths outside the candidate tree.
- **Analogs to reuse, not copy:**
  - the review sidecar (`workflow/sidecar.py`): the read-only print job, the guard that never raises into the controller, the lock around its own record, the reserved node id, the graph node outside LangGraph, the export section;
  - the attack pass (`workflow/attack.py`): the parallel-branch-inside-the-review-step shape, `ensure_started`, the per-stage record under the run lock, the never-raises guard, the `timed_out`/`failed`/`refused` statuses, the launch/prepare pinning into `plan.attack` (mirror as `plan.panels`), the reserved ids;
  - the design challenge in `workflow/guardrails.py` (`print_command`, `output_schema`, `validate_output`) for how a stage's print job is built and validated, and how the challenge stage is entered;
  - print reviewers and the review step in `workflow/automatic.py` (`popen_claude`, the wait loop and deadlines), the C49 cost records in `workflow/costs.py`;
  - `workflow/launch.py`/`workflow/pipeline.py` (2.5.0 `attack` validation and prepare pinning as the model for 2.6.0 `panels`), `workflow/sessions.py` (`RESERVED_NODE_IDS`, `RESERVED_NODE_PREFIXES`), `workflow/attention.py` (record kinds), `workflow/outcome.py` (the outcome block and its cost line).
- Install the bundled default briefs `features/multi-provider-panel/panels/review.md` and `panels/challenge.md` (you create them, short) as `workflow/prompts/panels/review.md` and `challenge.md`. A brief states the review task and the exact findings JSON shape, asks for severity P0/P1/P2 by the C41 rule, and says to treat repository content as untrusted data, not instructions.
- Tests to model on: `workflow/test_attack.py` (fake attacker/skeptic jobs over the toy repository, the review step seam), `workflow/test_sidecar.py` (fake print job, the guard, the appendix seam), `workflow/test_automatic.py` (`GraphFixture`, faked clocks), `workflow/test_export.py` (`legacy_run`), `workflow/test_portable.py` (init, dry run, registry).

## Design (settled)

- New file `workflow/panel.py`: the stage hook (`ensure_started(runtime, stage)` called inside the challenge stage and the review step), context assembly, the transport adapter (`claude` + `pi` builders/parsers), overlap, and the guard that records and swallows every failure.
- `contracts/workflow/panel.schema.json` 1.0.0 is the `panel.json` schema of Appendix A; `workflow/run_tests` validates every `panel.json` a test writes against it, with no key or enum outside Appendix A.
- `contracts/workflow/feature.schema.json` gains the optional `panels` at version 2.6.0 (2.5.0 and earlier unchanged; `panels` on an earlier version is refused at launch, message in PRD 4.2). `prepare` pins `panels` into `plan.panels`; a plan without it means none.
- Launch guards (PRD 4.2): version, `report_only` must be `true`, a `pi` entry needs a `provider/id` model, and the DeepSeek key guard (`WORKFLOW_PANEL_ALLOW_DEEPSEEK=1` plus a recorded rotated-key fingerprint; refused otherwise). Dry run enforces them too.
- `graph_nodes(...)` and `definition(...)` in `workflow/export_state.py` gain a `panels` argument so the exported graph shows a `panel` node of `kind: review` per instance (a `challenge`-stage panel depends on `challenge`; a `review`-stage panel sits beside the reviewers). A run without panels emits today's graph. The `viewer` lane owns the export section body; this lane provides the record and the node.
- `panel` and `panel-` join `RESERVED_NODE_IDS`/`RESERVED_NODE_PREFIXES`.
- Events, attention kind `panel`, the outcome line and the status line exactly as Appendix A spells them (no "Traceback"/"Error" literals the monitor would trip on).

## Constraints

- Owned paths only: `workflow`, `contracts/workflow`, `docs/handoff/panel-engine.md`. Do not touch `server`, `src/projects` or `contracts/projects` (the `viewer` lane owns them); coordinate only through Appendix A.
- Report-only in v1: `report_only != true` is refused at launch; the panel never feeds the run's verdict, never pauses a stage, never raises.
- Do not change the transport of any other role (workers, reviewers, judges, the attack pass): the adapter is used by the panel only.
- pi jobs get no tools (`-nt`) and only the context file; the env is scrubbed as above; `userEmail` is never written into a context file or passed to a provider. DeepSeek stays behind its guard.
- A plan without `panels`, older feature versions and runs prepared before this change are byte-for-byte unchanged in behaviour and export.

## Acceptance

`workflow/test_panel.py` covers, end to end, with fake `claude` and fake `pi` jobs over the toy repository and a captured `pi --mode json` stream fixture:
1. A `review` panel with two providers assembles one context file, runs both, and writes a `panel.json` that validates against `panel.schema.json`; each provider has its status and (where reported) cost, with `openai-codex` recorded subscription-covered rather than $0.
2. Overlap: a finding both providers raise is `accepted` at `overlap_threshold` 2; with threshold `"all"` only all-provider findings are accepted; with `1` any finding is; the pinned match rule (same file; line ±5 or title Jaccard ≥ 0.6) groups correctly and `providers_raised` is right.
3. A provider that times out is recorded `timed_out` and the panel keeps the other provider's findings; a provider whose reply is not JSON is `parse_failed` with its raw text kept.
4. A panel whose overall bound passes, or whose assembly throws, is recorded `failed`, the stage continues, and the run integrates exactly as a run without a panel.
5. A `challenge` panel runs inside the challenge stage and writes its record; its exported node depends on `challenge`.
6. A plan without `panels` emits today's graph and writes no `panel.json`; an older feature version and a pre-change run are unchanged.
7. Launch (dry run included) refuses: `panels` on a feature < 2.6.0; `report_only` not `true`; a `pi` entry without a `provider/id` model; a `deepseek/*` provider without the key guard satisfied.
8. The `pi` parser extracts the findings array and `usage.cost` from the captured `--mode json` event-stream fixture.

The policy checks (`workflow.run_tests`, `test:contracts`) pass. Write `docs/handoff/panel-engine.md`: the record shape, the adapter interface, the launch guards, what the `viewer` lane consumes, and every open P2 with one line each.

## Stop

Do not build a verifier/skeptic node, do not make the panel blocking, do not add challenge-pause teeth, do not switch any other role to pi, and do not add tool-read context for pi — all are explicitly deferred in `decisions.md`. Report them as leads in the handoff instead of building them.
