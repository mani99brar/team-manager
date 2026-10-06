# Handoff: the multi-provider panel in the Projects viewer (lane `viewer`, run multi-provider-panel-002)

Spec: [PRD_MULTI_PROVIDER_PANEL.md](../PRD_MULTI_PROVIDER_PANEL.md) sections 4.5, 6 item 2, Appendix A; decisions L1, L2, L4, L5, L6.
No graph node, no events, no `triage.ts` change this slice: the Panel section opens from the run page.

## What shipped

- **Contract 1.9.0** (`contracts/projects/v1.ts`): the vocabularies of Appendix A (`PANEL_STATUSES` with the export's `pending`,
  `PANEL_PROVIDER_STATUSES` incl. `pending`/`running`, `PANEL_STAGES`, `PANEL_TRANSPORTS`, `PANEL_SEVERITIES`),
  `panelRecordSchema` (`{version: "1.0.0", panels: [...]}` as `panel.json` and the export section hold it; `overlap_threshold`
  is an integer ≥ 1 or `"all"`; every nullable field of Appendix A spelled out), `panelResultsSchema` = record +
  `contract_version: "1.9.0"` + `source: live|export` (**no `node_id`**), registered as `schemas.panelResults` with its generated
  `panelResults.schema.json` (only `tsx contracts/projects/export.ts` was run, as the attack lane did; `npm run contracts:export`
  would rewrite the engine's `contracts/workflow/` schemas). Cross-field rules in `validatePanelResults`: unique panel ids,
  unique finding ids per panel, a `pending` panel with no findings and no start time. Examples: `examples.panelRecord` and
  `examples.panelPendingRecord` (Appendix A's two records verbatim) and `examples.panelResults`. README: the route and the
  1.9.0 history entry.
- **Server** (`server/projects.ts`, `server/projectRoutes.ts`): `EXPORT_VERSIONS` gains `1.9.0` (older versions still load; the
  "unknown version" regression now uses `1.10.0`); the export's `panels` section is kept as unknown data (`LoadedRun.panels`) and
  validated only by the route `GET /:project_id/workflows/:workflow_id/runs/:run_id/panels`, which serves the live
  `<run>/panel.json` (4 MiB cap) whenever it is readable and valid, else the export section when it is a valid record
  (`pending` included), else 404 `PANELS_NOT_FOUND`. A skipped file or section is logged (`Panel record skipped`). Free texts
  (`title`, `detail`, `file`, every `error`) are path-redacted; times are normalised to `Z` like the attack's.
- **Viewer**: `src/projects/node/providerPanel.ts` (pure model: counts, headline, threshold wording, accepted/folded orders,
  `file:line`, overlap count, provider name, cost line, context bytes, duration, per-stage filter);
  `src/projects/providerPanel.tsx` + `providerPanel.css` (`ProviderPanelBody`); `RunView.tsx` polls the route for **every** run
  and renders the section after the board (and after the attack section when both exist); `NodeDetail.tsx` renders the same body
  narrowed to `stage: challenge` on the challenge node's page, listed in its section index as "Panel"; `api.ts`
  `fetchPanelResults`, `NOT_RECORDED.panels`. No execution control of any kind: v1 is read-only display.

## The section's states

| State | What the page shows |
| --- | --- |
| `panels` null, export before 1.9.0, record invalid both live and in the export | No section at all (404 `PANELS_NOT_FOUND` loads as null). The run page and every older export render exactly as today. |
| Record loading | Nothing is rendered until the first answer (the run page gates the section on a loaded record); a poll keeps the shown record while it reloads. |
| Request failed (not a 404) | The section with the standard error panel and a Retry button. |
| `pending` panel | Headline `Pending: runs at the <stage> stage`, no counts, "The panel runs at the <stage> stage, beside the reviewers / the design challenge; nothing has run yet.", providers `pending`. |
| `running` panel | Headline `Running · <stage> stage · n finding(s), a accepted · <threshold>`, providers `running` (live chip); updates on each poll. |
| `succeeded` panel | Accepted findings as cards (severity chip, `file:line`, title, detail, "raised by" chips, `overlap ×n` badge when > 1), the not-accepted and unanchored findings folded (closed `<details>`; an unanchored one carries "unanchored: matches no context label"), then the providers. "No finding met the overlap threshold." when findings exist but none is accepted. |
| `failed` / `timed_out` panel | Headline with the status and counts, "The panel failed / timed out: <error or 'no error recorded'>" in the fail tone, then the providers. |
| Provider row | `<name> · transport <t> [(default model)] [· effort e] · <status chip> · cost <…> [· <kB> of context] [· raised f1, f2]`, and "Error: …" below when recorded. Status wording: ok, running, pending, timed out, failed (`error`), parse failed. |
| Challenge view | Only the `challenge`-stage panels, under a "Panel" node section with its index entry; nothing when the record has none. |

Each panel section carries `data-id`, `data-stage`, `data-status`; the wrapper `data-source` says `live` or `export`.

## Live vs export (Appendix A, pinned)

The route serves the live `panel.json` whenever it is readable, within 4 MiB, valid JSON and a valid record; else the export's
`panels` section; else 404. **There is no mtime comparison**: `server/projects.test.ts` sets a live file's mtime an hour before
the export's and asserts the live record is still served. The pinned `panel-challenge-and-live` scenario's wording "newer" is
incidental (it comes from the attack scenario it was modelled on); the implemented and tested rule is live-wins-when-valid.
The candidate phase refutes "newer" against the real API too: `seed.ts` writes `panel.json` before `run-state.json`, so the
seeded live file of `panel-live` is *older* than its export and is still the record served (`source: live`).
Two consequences worth knowing: a stale but valid `panel.json` left from an interrupted run wins over a fresher export until the
engine rewrites it (the engine's resume path rewrites it); and `panels: null` answers 404 even beside a live file, because a run
without `plan.panels` never writes one (the attack's "null without the node" rule, with the section standing in for the node).

## openai-codex: `subscription-covered` vs the record's estimate

pi reports a non-zero `usage.cost.total` for every provider, openai-codex included (decisions G13); the record keeps it as
reported (`cost_usd: 0.0047` in Appendix A, served unchanged by the route and validated field for field). The **viewer** shows
the literal `subscription-covered` for a provider whose `model` starts with `openai-codex/` and never prints that estimate
(`isSubscriptionCovered`, `providerCostText`; the browser spec asserts the row does not contain `0.0047`). A metered provider
shows its estimate with up to four decimals (`$0.021`, `$0.0047`), dollars to cents (`$5.00`), `—` when null.

## Fixtures built from Appendix A

`tests/project-workflows/fixtures/ux-panel.ts` (workflow `ux-panel`, 1.9.0 exports but `panel-old`, lanes `ui`/`adapter`, dated
2025-10-04 so Runs home's Recent window is untouched) starts from the committed examples (the contract test reads them from the
PRD; `tests/unit/providerPanel.test.ts` holds the fixture literals equal to them). Runs: `panel-succeeded` (Appendix A plus a
`deepseek/deepseek-v4-pro` provider that timed out, f2 raised by openai-codex alone, f3 unanchored), `panel-pending`,
`panel-live` (pending export, live running record; the next poll serves Appendix A's succeeded record), `panel-failed`
(panel-level `error`, providers `error`/`parse_failed`), `panel-timed-out`, `panel-challenge` (guarded graph with the
`challenge` node and a run-inputs challenge; a seeded `challenge`-stage panel at threshold `"all"` beside the review stage's
pending panel), `panel-null`, `panel-invalid` (garbage section and live file), `panel-old` (1.8.0 export beside a live file).
Infra: `seed.ts` accepts `version: '1.9.0'`, `panels` and `panelFile`; `fixtures.ts` gained `panelResults`;
`fixtures/index.ts` its type entry, merge line and module; `mock.ts` the `panels` route answering `PANELS_NOT_FOUND`.

## Design-challenge notes (attempt 7)

- Note 3 (viewer, Acts: worker) — closed: `contracts/projects/contract.test.ts` and `server/projects.test.ts` each accept
  `overlap_threshold: "all"` and `1`, `stage: challenge`, a `running` provider and every nullable field null, beside the
  verbatim comparison; the server test serves them live through the route.
- Note 4 (viewer, Acts: worker) — closed: both Appendix A extractors (`panelAppendixARecords`, `panelAppendixA`) tolerate leading
  whitespace on both fences, return both blocks and compare each to the committed examples. The engine's `panel.schema.json`
  validating the same two is the engine lane's half.
- Notes 1, 2, 5 and 6 concern `workflow/` (the engine lane): out of this lane's owned paths, nothing done here.

## Deviations and choices (open assumptions)

1. Route name and code: `/panels` and `PANELS_NOT_FOUND` (plural, after the export section `panels`); the contract is
   `panelResults` as the task names it.
2. Every run page requests the panels route (there is no node to gate on): one extra GET per poll, answered 404 for a run without
   panels or an older export. The DOM of such a run is unchanged; the full browser suite passed in both phases with it.
3. A record invalid both live and in the export shows no section (there is no node to anchor a "not recorded" line to, unlike
   the attack pass); the reason is logged server-side.
4. A `panels: null` export answers 404 even beside a live `panel.json` (see Live vs export).
5. Severity is pinned to `P0|P1|P2` (PRD 4.4's normalizer map), `line` is a non-negative integer or null, `budget_usd`
   non-negative, `context_bytes` non-negative integers, and a finding's `file` (like ids, the stage and the transport) is a
   non-empty string — an unanchored finding whose provider gave no path must still carry its raw text, not `""`. The engine's `contracts/workflow/panel.schema.json` was not in this
   worktree; if it allows something wider, the route skips such a record (404), never a failed run.
6. The section's "Loading" and error states are rendered on the run page only; the challenge view adds its section only once a
   record with a `challenge`-stage panel loaded.
7. The unit test covers the pure model only: `providerPanel.tsx` imports its CSS, which `node --test` cannot load, so the markup
   (`subscription-covered`, the overlap badge, the folded disclosure) is asserted by the browser spec.

## Leads (not done, by the ## Stop bound)

- Controls that act on the panel (re-run a provider, accept/label a finding) — v1 is read-only; a label command like the attack
  pass's would need an engine command first.
- A graph node, panel events and the one `triage.ts` whitelist line arrive with the challenge stage (follow-up slice); the
  `panel`/`panel-` lane-name collision is not reserved this slice.
- A per-panel context cap and a context-size warning in the provider row (the row shows the bytes today).
- A "not recorded" line for a record invalid both ways, once a node exists to anchor it.
- Showing `finding_ids` per provider as links to the cards.

## Checks run (this worktree, after `npm ci`)

- `npm run build` — ok. `npm run lint` — ok.
- `npm run test:contracts` — 30 pass, 0 fail (both contract files; 2 new panel tests).
- `npx --no-install tsx --test server/projects.test.ts` — 84 pass, 0 fail (5 new `[panel]` tests).
- `npm run test:unit` — 423 pass, 0 fail (14 new in `tests/unit/providerPanel.test.ts`).
- `tests/project-workflows/panel.spec.ts` with `--reporter=json`, worker and candidate phases — 2 passed each; `workflow
  check-report … viewer <report>` on each: "The scenarios in this report follow the verifier's rules". Each scenario attaches
  exactly one `screenshot:<id>` PNG plus `state:` images (390 px, pending, the challenge view).
- The full Projects browser suite, both phases, after the infra change (every run page now asks the panels route): **80 passed,
  0 failed in the worker phase (8.5 min) and 80 passed, 0 failed in the candidate phase (10.2 min)**. A first attempt ran while
  the host sat at a load average above 20 (the engine lane's Python suite at 600% CPU on 4 cores): it recorded 2 timeout
  failures of 80 in the worker phase (`ux-run`, `ux-verify`: 5 s expects on a banner that had not settled) and was stopped at
  23/80 in the candidate phase with timeouts in `attack` and `inputs` (30 s test timeouts on the first page loads). Each of
  those specs passed in isolation once the load fell, and `ux-run.spec.ts` behaved the same on a clean HEAD copy under the same
  conditions, so the failures were load, not the change; the clean second run above is the regression evidence.
- After the last code edit (a cosmetic de-duplication in `providerPanel.tsx`), build, lint, contracts, server and unit were run
  again with the same counts, and `panel.spec.ts` once more in both phases with `check-report` green on each report.
