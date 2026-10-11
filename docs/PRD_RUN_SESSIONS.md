# PRD: Run sessions (every session of a workflow run is visible)

Status: for the run-sessions workflow, 2026-10-11, after the panel review of the slice (decisions.md [P1] to [P14]). Operator's words: "make the lane review panel as follow and also in the same run update the UI to show different reviwers as different node. Also add the panel. Basically each session part of the workflow shouldb be visible". Decisions: `features/run-sessions/decisions.md`.

## 1. Problem

A workflow run is a dozen agent sessions: the design challenge's print jobs, one worker per lane, the fix loop's repairs, a lane reviewer per lane and round (feature.json 2.10.0), the independent reviewers (general, coverage, critique), sidecar passes and attack angles when a feature has them, the multi-provider review panel when a feature opts in, and the night-shift panel's decisions (Claude, GPT, Jev) when the operator is away. The run page shows some of them and hides the rest:

- The review step is one node. Its reviewers are chips inside the node sheet (`src/projects/signal/NodeSheet.tsx`) and a list on the review node page (`src/projects/ReviewDetail.tsx`); the graph never shows that general blocked while critique approved.
- The lane reviewer is invisible. `workflow/lane_review.py` writes `<run>/lane-review/<lane>/<n>.json` and `lane_review:` event lines on `verify_<lane>`; nothing in `server/` or `src/` reads the records. An operator watching run projects-dispatch-002 could not see that GPT 6.1 blocked both lanes and started two repairs.
- No page lists a run's sessions with their model, cost and session id. Costs live in per-session files; the export's `costs` section is stripped by the server (`server/projects.ts`).
- Night-shift panel decisions live in `~/.local/state/md-manager-workflows/night-shift/<date>/states/<run>-<kind>-<time>/record.json`, outside the run directory. A run's page shows at most an event line such as "accepted by the panel".

## 2. Goal

Every session that worked on a run is visible on the run page, with what it did, what model ran it, what it cost, and how to reopen it; the reviewers, the panel and the lane reviewers are nodes of the graph.

## 3. What the operator sees

### 3.1 Reviewer nodes (the review step)

- The run stage (Signal Box, `src/projects/signal/RunStage.tsx`) shows one node per reviewer of the run's latest review round, side by side in the column before the review gate, like worker lanes: `Reviewer · general`, `Reviewer · coverage`, `Reviewer · critique`, and `Panel` when the run has a multi-provider panel (3.3). Each card shows the reviewer's state word (running, approved, blocked, late blocked, not started, failed), its open P0/P1 count and its cost.
- The `review` node stays the gate: its verdict, the fix loop and the approval follow it as today.
- Each reviewer node has a node page: the reviewer's session block (3.4), its verdict and its own findings for the latest round (the existing finding list, filtered to that reviewer), and earlier rounds' verdicts (from the fix loop's archived rounds).

### 3.2 Lane review nodes

- Each lane with a lane reviewer gets one node per lane-review round, `Lane review · <lane> · round <n>`, right after that lane's verify step (as repair nodes sit after the step they answer). Its card shows the round's result ("0 P0, 3 P1") and whether it started a fix round ("Fix round started: repair 1") or not ("Recorded; no fix round: <reason>"), and the reviewers' cost.
- Its node page lists the round's reviewers (transport, model, status, duration, cost), every finding (severity, file:line, title, detail), the snapshot it reviewed, and the repair it started, linked to that repair node.
- The reason a round started no fix round is what the engine recorded ([P10]): the `lane_review:` event's own words when the gate refused ("rounds used up, fix loop off or repair cap"), "no P0/P1" for a clean round, and "the review failed: <first line of the error>" for a failed record; in any other case (a gate that allowed a fix round no repair followed, a refused repair in `spent_marks`, a pending or running record) that round's own latest `lane_review:` event words verbatim, else "not recorded" ([L3]). Never a more specific cause than the record holds. A failed lane-review record, and any projected node whose failure does not stop the run, has snapshot status `succeeded`, its card and page saying "the review failed: <first line>", so the node header's "This step failed. The run cannot succeed without intervention." never shows for it ([L3]).

### 3.3 The panels

- **Multi-provider review panel** (`workflow/panel.py`, route `/runs/:run_id/panels`): a `Panel` node beside the reviewer nodes, present exactly when that route answers for the run (not merely when `panel.json` exists: an export before 1.9.0 answers `PANELS_NOT_FOUND`, as the `panel-old` fixture asserts) ([P3]). Its node page shows today's panel section (`src/projects/providerPanel.tsx`) and one session block per provider.
- **Night-shift panel**: every decision the night shift recorded for this run appears on the node page of the node it decided (the challenge for `challenge_paused`, the approval for `awaiting_approval`, the asking worker's node for `question`, the controller section for `controller_blocked` and `review_blocked`): the kind, when, each provider's option, text, confidence word ("high", "medium") and "needs the operator", their agreement, Jev's pick with its confidence and whether it passed the floor (or Jev's error, or nothing when Jev was not called), and whether it was executed (with the command) or held (with the reason). The run page shows a one-line count ("2 panel decisions: 1 executed, 1 held") linking to them.

### 3.4 Sessions

- A **Sessions** section on the run page lists every session of the run in start order, grouped by role: design challenge attempts, workers, repairs, lane reviewers, reviewers, critique, sidecar passes, attack angles, panel providers, night-shift providers. Each row: role and label, node (linked), model and transport, status, started, duration, cost, session id. The totals line gives the cost reported by Claude sessions (labelled "reported by Claude", since no file shows whether the account pays per token, [L1]) and, separately, the subscription-covered estimates (pi providers such as `openai-codex`, as contract 1.9.0 already labels them), and how many costs are not recorded ([P11]).
- Every node page that belongs to a session shows the same facts as a **session block**, and for a Claude Code session a copyable resume command (3.5). A Claude Code session is one whose session id matches the export's ID pattern and that either records transport `native`, `print` or `claude` (run reviewers, critique, a claude lane reviewer) or is a worker, repair or challenge receipt (which records no transport); `pi`, `openrouter` and night-shift providers never get one ([L3]).
- Never a transcript, never an absolute path, never a credential. Unknown facts say "not recorded".

### 3.5 The resume command ([P4], [P5], [P6])

- For a project the registry lists under `viewer.expose_run_dir` (the same rule that serves `run_dir`, `server/projects.ts`, docs/PRD_VIEWER_UX.md B3): `cd ~/'<rest of the working directory>' && claude --resume <session id>`, the directory `~`-relative and single-quoted after `~/` so HOME still expands, and only when the recorded directory still exists (a claude lane reviewer's throwaway worktree is deleted after its round) ([L3]); a directory holding a single quote or a control character, or not under HOME, falls back to the form below.
- For every other project, or when the working directory is not recorded or not under HOME: `claude --resume <session id>` with the note "run it in the session's worktree". In the candidate phase of the browser specs the test root is under the system temp directory, outside the real HOME, so the exposed project also gets the bare form there, as `run_dir` is null there (the `ux-lists` precedent); the `~/` form is proven in the worker phase and in `server/sessions.test.ts` with a temporary `home` option ([L1]). The run directory is never revealed for a project that does not expose it.
- The command is composed by the server after redaction and is exempt from `redactPaths` (which turns any `~/…` into `<path>`); no other string is.

## 4. Data (server)

The server reads the per-session files live from the run directory, as it already reads `panel.json` and `repairs.json`; the controller, the export (`run-state.json`, 1.12.0) and `contracts/workflow/` are unchanged ([O2]). It works for every run on disk, including runs that finished before this feature.

- **Which nodes exist** comes from export-visible facts, so the mocked and the real server agree ([P2]): a reviewer node for each entry of the export's `review.reviewers` of the latest round (none when the export has no reviewer list; the raw export list, never the adapter's synthetic `review` reviewer for exports before 1.4.0); while the review section is null and `review` is not pending (round 1 running, or round k > 1 running after its predecessor was archived), one reviewer node per `plan.json` `reviewers` entry, with status running or not started from `automatic-review-<id>.json` and no earlier round's verdict ([L1]); the `panel` node exactly when the panels route answers; a lane review node for each `lane-review/<lane>/<n>.json` record. Per-session files only add facts (cost, model, times, session id, late) to nodes and rows that exist.
- **Sources per role** (field names as the files hold them; a missing or malformed file makes that fact `null`, never an error for the whole run):
  - challenge: `challenge-<n>.json`, `challenge-<n>.stdout.json` (session id, `total_cost_usd`), `challenge-<n>.role.json` (model);
  - worker: `<lane>.interactive.json` (session id, launch time, model, effort, worktree), `<lane>.cost.json`;
  - repair: `repair-<n>.interactive.json`, `repair-<n>.cost.json`, the fix loop journal (`repairs.json`);
  - lane reviewer: `lane-review/<lane>/<n>.json` (`contracts/workflow/lane-review.schema.json` 1.0.0; a reviewer's `model` may be null, [P9]); its fix round is the record's own `repair` number, never a join on lane and round ([P8]); for the `claude` transport the session id from the reviewer entry or the `r<round>-<i>-<k>.pid` `marker`;
  - reviewer: `automatic-review-<id>.json` (status, `late`, session id, round) ([P7]), `review-<id>.interactive.json`, `review-<id>.cost.json`, `review-<id>.completion.json`, `review.json`, archived rounds (`review.round-<n>.json`, `review-round-<n>/`);
  - critique: `automatic-review-critique.json`, `critique/<round>/{status,stdout}.json`;
  - sidecar and attack: `sidecar-<n>.stdout.json`, `attack-<n>.stdout.json` (the roles `workflow/costs.py` already counts) ([P12]);
  - panel provider: `panel.json` through the panels route's own reader;
  - night shift: the records under `MD_MANAGER_NIGHT_SHIFT_DIR` (default `~/.local/state/md-manager-workflows/night-shift`), with `claude.json`, `gpt.json` and `jev.json` beside each record.
- **Night-shift matching** ([P13]): a record belongs to a run when its `run_id` is the run's and a run directory named in its texts resolves (realpath, `~` expanded) to this run's directory; when no text names any run directory, only when exactly one registered run in the whole registry has that `run_id`, checked by listing each registered workflow's `runs_root` directory names, never by loading runs ([L3]). Anything else is omitted. `decided_at` is the time in the record's `key` (`<run>|<time>|<kind>|<node>`), else null. A provider's `confidence` is the record's word (string or null) ([P1]). `jev`: `{error}` when the record holds an error, the pick from `jev.json` (`pick`, `confidence`, `pass_floor`) when that file exists, and null for `{}`, `false`, `null` or a missing key ([P1]).
- **One projection function** ([L1]): the node projection is one pure exported function keyed on the raw export and plan facts, applied by the server to every served run detail and by the worker-phase mock's sessions hook to every mocked run detail, so both phases show the same `data-node-id` cards with no per-fixture node edits.
- **Kind `review` behaviour** ([L1]): wherever kind `review` is matched in the lane's owned files (the judges pin in `src/projects/signal/model.ts`, the agent category, triage's `pick` in `contracts/projects/triage.ts`, and the stage card's executor wording through an owned wrapper in `src/projects/signal/` around `executorOf`), the `reviewer-`, `panel` and `lane-review-` ids are special-cased; `src/projects/status.ts` and `src/projects/NodeHeader.tsx` are not edited, so the node-page header keeps the kind's wording, and `NodeDetail` passes no print transport for projected ids ([L2]). A blocked reviewer or a lane review with P1s is a finished session that found problems, not a failed step: its snapshot status and card say so (the mapping is in the handoff).
- **Projected nodes** join the run detail's definition and snapshot the way repair nodes already do (`insertRepairs`, `projectedDefinition` in `server/projects.ts`): existing node shapes and kinds (`review`), the pinned `definition_revision` unchanged, ids that cannot collide with the export's (`reviewer-<id>`, `panel`, `lane-review-<lane>-<n>`; refused like a colliding repair id). Reviewer and panel nodes depend on what `review` depends on, and the projected `review` also depends on them; lane review nodes depend on `verify_<lane>` and nothing depends on them. Triage keeps them advisory (`contracts/projects/triage.ts`): never the focus, never the Now banner, never the run's state word, and not counted in the depth that picks the focus.
- **Redaction** ([P5], [P6]): every free text served (findings, messages, errors, provider texts, commands) passes `redactPaths` and a credential filter (strings shaped like `ghp_…`, `github_pat_…`, `sk-…`, `xox…-`, `Bearer …`, `token=…`, `password=…` become `<redacted>`, each anchored on a word boundary with a minimum token-length tail such as `\bsk-[A-Za-z0-9_-]{20,}`, so ordinary words such as 'task-file' stay intact ([L1])); a lane reviewer's or provider's `error` is its first line, at most 200 characters. The resume command (3.5) is composed after redaction.

## 5. Out of scope

- Transcript text, Herdr pane links (the `terminals.json` mapping goes stale across review rounds), live token streams.
- Any controller or export change; recording lane reviewers' session ids for `pi` transports (they have none).
- Night-shift actions from the page (the run controls feature owns actions).

## 6. Acceptance

- A seeded run with three reviewers (one late), a lane reviewer per lane (one round that started a repair, one recorded without a fix round), a multi-provider panel and night-shift records shows: the reviewer nodes and the panel node before the gate, a lane review node after each verify step, every session in the Sessions list with its cost and both totals, the night-shift decisions on their nodes, a resume command for each Claude session (the `~/` form for an exposed project, the bare form for another), and no absolute path anywhere (`renderedText`).
- A run without these files (an older export, no lane review, one reviewer) renders as before except for its reviewer node(s); the `panel-old` fixture still has no Panel node or section.
- Both phases of the browser specs pass in the lane's own worktree: worker (mocked routes) and candidate (the real server on seeded run directories and a seeded night-shift folder).

## 7. Lanes

One full-stack lane, `sessions` ([P14]): the server readers, the projected nodes, the route and its contract, triage's advisory rule, the stage cards, the node pages, the Sessions section, the night-shift block, the specs and the critique app. One lane, because the candidate phase of the browser specs needs the new server: a viewer lane in parallel could only meet it at the candidate gate, which is how run projects-dispatch-001 spent all its repairs.

## Appendix A: the sessions route (contract 1.13.0, `contracts/projects/sessions.ts`)

`GET /api/projects/:project_id/workflows/:workflow_id/runs/:run_id/sessions` (GET and HEAD; 404 with the existing error shape for an unknown run):

```ts
{
  contract_version: '1.13.0',
  sessions: Array<{
    key: string                       // stable within the run, e.g. 'worker:server', 'reviewer:general:2', 'lane:viewer:1:1'
    role: 'challenge' | 'worker' | 'repair' | 'lane_reviewer' | 'reviewer' | 'critique' | 'sidecar' | 'attack' | 'panel_provider' | 'night_shift'
    label: string                     // 'Design challenge attempt 2', 'Worker · server', 'Lane review · viewer · round 1 · GPT 6.1'
    node_id: string | null            // the stage node it belongs to (pinned or projected)
    lane: string | null
    round: number | null              // review round, lane-review round, challenge attempt, repair, sidecar or attack number
    transport: string | null          // 'claude', 'pi', 'native', 'openrouter' ... as the record names it
    model: string | null
    status: 'running' | 'succeeded' | 'failed' | 'stopped' | 'unknown'
    verdict: string | null            // reviewers: approved | blocked | late blocked ...; panel and night shift: the option
    findings: { p0: number; p1: number; p2: number } | null
    started_at: string | null         // ISO Z
    ended_at: string | null
    duration_seconds: number | null
    cost_usd: number | null
    cost_kind: 'metered' | 'covered' | null   // covered: a subscription estimate (pi providers), as contract 1.9.0 labels it
    session_id: string | null         // only an id matching the export's ID pattern
    resume: { dir: string | null; command: string } | null   // Claude sessions only; 3.5
  }>
  totals: { metered_usd: number; covered_usd: number; not_recorded: number }
  lane_reviews: Array<{
    lane: string
    round: number
    node_id: string                   // 'lane-review-<lane>-<round>'
    snapshot: string                  // the reviewed snapshot sha
    status: string                    // the record's status
    started_at: string | null
    ended_at: string | null
    fix_round: { started: true; repair_node_id: string | null } | { started: false; reason: string }
    reviewers: Array<{ transport: string; model: string | null; status: string; duration_seconds: number | null; cost_usd: number | null; error: string | null }>
    findings: Array<{ severity: 'P0' | 'P1' | 'P2'; file: string | null; line: number | null; title: string; detail: string }>
  }>
  night_shift: Array<{
    kind: string                      // challenge_paused | awaiting_approval | question | controller_blocked | review_blocked ...
    node_id: string | null
    decided_at: string | null
    providers: Array<{ name: string; option: string | null; text: string | null; confidence: string | null; needs_operator: boolean | null; error: string | null }>
    agreement: string                 // agree | split | one provider
    jev: { pick: string; confidence: number | null; pass_floor: boolean | null } | { error: string } | null
    decision: 'executed' | 'held'
    option: string | null
    command: string | null            // redacted
    held_reason: string | null
  }>
}
```

The run detail is unchanged in shape: projected nodes use the existing node and snapshot entries (`contracts/projects/v1.ts`).
