# PRD: Viewer refine (the run page shows the new workflow; a refinement of the Calm look)

Status: Proposed 2026-10-08, from the operator's grill of 2026-10-08 ("The workflow is updated, now we want to update the frontend for it. The frontend is cluttered and now we would have a bigger graph and single runs so we need better design and UX"). Follows [PRD_VIEWER_REVAMP.md](PRD_VIEWER_REVAMP.md) (the Calm look, shipped 2026-10-02) and [PRD_VIEWER_UX.md](PRD_VIEWER_UX.md) (Run Story; its slice S7 is folded in here) and keeps every truthfulness rule they set. Decisions: `features/viewer-refine/decisions.md`. Depends on [PRD_WORKER_SKILLS.md](PRD_WORKER_SKILLS.md) being on main: the two UI lanes declare `skills: ["impeccable"]` (feature.json 2.8.0).

## 1. Problem

The controller gained, on 2026-10-08 (the learnings build, `learnings-impl`): per-lane worker model and effort (feature.json 2.7.0), the `run-report` wrapper, delta review on follow-up runs with a panel byte cap, and the in-run fix loop (repair sessions `repair-<n>` after a verify, candidate or review block, review rounds archived in `review-rounds.json`, `plan.automatic.fix_rounds`). None of it reaches the viewer: the export (`workflow/export_state.py`, 1.9.0) carries nothing about repair sessions, review rounds, delta bases, `fix_rounds` or lane pins, and the run graph is the pinned definition only (11 nodes for a two-lane run).

Measured on the live viewer on 2026-10-08 (1440×900, run `multi-provider-panel-001`, Runs home with 13 running or paused runs):

- **The run page's first screen does not answer "what now" in one glance.** Above the fold: a breadcrumb line, a two-line title, a metadata strip (branch, commit, mode, worker and review durations, definition hash) in one weight, the paused banner with a P1 quote and three copyable commands, a lanes strip, two tabs, then the graph and an 11-row steps table side by side. The banner's answer competes with everything around it.
- **The activity log is one phase of 24 same-weight rows.** Four challenge attempts, their pauses, the operator's edits and the re-pins read as one list; the operator-time gaps are the only structure.
- **The graph is a picture of the definition, not of what happened.** 11 grey nodes with a 10 px meta line each; nothing of the loop the controller now runs can be drawn, and at two lanes with two rounds each a run has up to 15 nodes.
- **Runs home gives every paused run the same weight.** 13 cards, each six lines, nine of them "paused at the design challenge" for days; "Needs you · 0" is a line, the recent list follows below the fold with its filters.
- **Eight review P2s from `viewer-revamp-008` are open** (two real: the Recent filter counts are computed over every row instead of the filtered set; the look switch's 34 px target under 760 px breaks the 44 px rule; six test gaps: phone stacking, lane chip tones, the Runs home data path, the read-only check on the header, the feature header's reviewers). **Slice S7 of the Run Story** (the Assignment tab as one setup line and one row per lane; the review diff inline instead of a download) was never built.

## 2. Goals and non-goals

Jobs, in the operator's order: see what needs me now; review a run's result; watch a live run, including its fix loop; manage many runs.

1. **The run page opens on an answer.** First screen: the run's state in one line (what it is doing, or what it waits on, or how it ended), the cause, the next step, then the graph with the loop. Metadata moves below or into a disclosure.
2. **The graph shows the run that happened.** Repair sessions are nodes; review rounds are attempts of the review node with their delta base; a lane's model pin is on its node; a graph of 15 nodes stays readable at 1440 and scrolls or stacks below.
3. **Steps and activity are grouped by what the operator asks:** phases, attempts and rounds, with the loop's rounds visible as rounds, not as more rows.
4. **Runs home ranks by need:** what waits on the operator, then what runs, then what paused days ago, compactly, with the recent list and its filters correct.
5. **S7 lands:** the Assignment tab as the run's setup page; the review diff inline.
6. **Refinement, not redesign.** The Calm tokens (`src/projects/theme.css`), the state palette, the dark theme, the truthfulness rules and the read-only guarantee stay. The UI lanes work with the impeccable skill in its Operate mode (section 4).

Non-goals: a new visual world (a redesign is a question to the operator with a mockup, never built in this run, decisions.md [G6]); controls that act on a run; the Pi/Claude containment graph (`src/graph/`, `GraphCanvas.tsx`) and the document editor; the controller (`workflow/*` except the export module); the export of anything the run directory does not already record.

## 3. Decisions (grill of 2026-10-08)

| Topic | Decision |
|---|---|
| Scope | Data plumbing included: an `adapter` lane (export, contracts, server) beside two UI lanes. The run page is primary, Runs home second. [O1] |
| Skills | The UI lanes declare `skills: ["impeccable"]` (PRD_WORKER_SKILLS); the adapter lane does not. [O2, G1] |
| Look | Refinement of Calm; a redesign only as a question to the operator with a mockup. [O3, G6] |
| The loop in the graph | Repair sessions as nodes, review rounds as attempts of the review node with the delta base, lane pins on the nodes; export 1.10.0 (Appendix A). [O4] |
| S7 and the P2s | Folded in: S7's two items join the `pages` lane; the 8 P2s are closed by the lane whose DOM they touch. [O5] |
| Lanes | `adapter` (export, `contracts/projects`, `server`), `pages` (the run page and its node pages), `shell` (Runs home, the rail, the header, lists, tokens); each UI task lists the DOM the other lane owns. [G2] |
| Models | `adapter` on `claude-sonnet-5-5` at medium (the small-lane pilot); `pages` and `shell` on the default worker pin. [G3] |
| Context for the skill | `PRODUCT.md` and `DESIGN.md` at the repository root, written by the operator's session before launch with `/impeccable init` and `/impeccable document`; no lane edits them. [G5] |

## 4. How the UI lanes use the impeccable skill

The skill is available through the `Skill` tool as `workflow-<lane>:impeccable` (its plugin name) and its files sit under the run's `skills/<lane>/skills/impeccable/`. Mode: **Operate** (a tool the operator completes tasks in; scanability and consistency outrank expression). The lane:

1. Runs the skill's `context` step once (`scripts/impeccable context` from the skill folder; the engine binary is already in `~/.impeccable/bin/`, decisions.md [G5]). If the launcher refuses or fails, it says so in its completion and reads `PRODUCT.md`, `DESIGN.md` and the skill's `reference/operate.md` directly, as the skill itself instructs.
2. Runs `shape` on its surface first (the run page, or Runs home) and writes the result of the shape step into its handoff before editing: the surface's jobs, the first screen's contents in order, what moves below the fold, what is removed. A shape step that concludes the refinement cannot meet section 2 stops the lane with a `question` completion for the operator (decisions.md [G6]); it builds no redesign.
3. Builds, then reads `reference/craft-floor.md` immediately before the first UI edit as the skill requires, and uses the refinement playbooks (`layout`, `distill`, `clarify`, `polish`), never `new-work`.
4. Inspects once with a batched round (1440 and 390, light and dark), fixes everything it shows in one batch, confirms with at most one more round, and stops polishing: the skill's bounded-passes rule, which also keeps the browser budget (one Playwright run at a time on this host).
5. Runs `audit` once at the end (accessibility, responsive) and records its findings in the handoff with what was fixed and what was left.

`PRODUCT.md` and `DESIGN.md` are read-only for every lane in this run; a lane that finds them wrong reports it in `open_assumptions`.

## 5. Design

### 5.1 The run page's first screen (`pages`)

Order, top to bottom at 1440, inside the run view (the breadcrumb line above it is the shell's): the run title on the first line (the feature name truncated, the run id in full); the **state line**: one sentence in the state's colour with its glyph, built from the existing Now derivation (`contracts/projects/triage.ts` `focus`, `attention`): "Paused at the design challenge: attempt 4 found 1 P1, no worker launched" / "Running: repair 2 of viewer (round 2 of 2) after verify blocked" / "Succeeded: integrated as a90624d"; the **cause** (the P1's title, the gate reason, the question) as one quoted line with its "open" link; the **next step**: its first command with Copy and its remaining steps, in their order, in a closed disclosure "All steps" (the steps of a next step are a sequence, never alternatives); then the lanes strip with each lane's model pin and round count; then the graph. The metadata strip (branch, commit, mode, durations, definition hash, "Details") moves into a disclosure under the title, closed by default, with the durations kept as two chips (worker, review) beside the state line. Nothing on the first screen is a paragraph.

### 5.2 The graph with the loop (`pages`, data from `adapter`)

- Repair nodes come from the run detail's `definition` and `snapshot`, where the server projects them from `fixLoop` (Appendix A.1 item 1; the export's own definition is unchanged): `repair-<n>` of kind `worker`, depending on the step that blocked (`verify_<lane>`, `candidate` or `review`), labelled "Repair <lane> <n>", status from `fixLoop.repairs[].status`. The graph draws the dependency edge as every other edge, plus a **return mark**: a dashed edge from the repair node back to the step it answers, drawn from the fix-loop section, not from `depends_on` (the contract graph stays acyclic; the return mark is a drawing). The repair node's meta line says `round <r> of <rounds> · <trigger>`; its ring and glyph follow its status like every node.
- A lane's launch node meta line shows its pin when the export has one (`opus-4-8 · medium`, `sonnet-5-5 · medium`), the executor word stays; a lane without a pin shows the executor only.
- The review node shows `round <k>` and, when a delta base exists, `delta from <7 chars>` in its meta line; each round is an attempt (`/nodes/review/attempts/<k>`), with the archived round's verdict and findings on its attempt page (Appendix A `fix_loop.review_rounds`).
- Layout (`dag.ts`): repair nodes are placed in the column after the step they answer, in a row of their own below that step's lane row, so a two-lane, two-round run (15 nodes) keeps 8 columns; the fit floor stays 83 % at 1440, then the box scrolls with the focus step in view, as today. Keyboard focus order, the status glyphs, the amber attention ring and the executor legend stay; the legend gains the return mark.
- The compact variant beside the Steps keeps the same columns.

### 5.3 Steps and activity (`pages`)

- The Steps table groups rows by phase (Challenge, Work, Verify, Candidate, Review, Integrate) with a one-line phase header carrying the phase's outcome and duration; a repair session is a row under the step it answers, indented, with its round; a review round is a row under Review. The 0-of-11 counter becomes "<done> of <steps>, <rounds> repair rounds", counting the pinned steps only (never the projected `repair-*` nodes).
- Activity groups by phase in `<details>` (all open) as the revamp specified, and additionally folds each challenge attempt and each repair round into its own sub-group with a one-line summary (attempt, outcome, duration), so a four-attempt challenge is four lines until opened. The operator-time gaps stay as rows. "Newest first" and "Collapse all" stay.

### 5.4 Node pages (`pages`)

- A repair node's page: the round, its trigger, the gate reasons or the findings it was given (verbatim, from the fix-loop section), the session's completion facts (the same result block a worker node has when the export carries them; else "not recorded"), the captured files (`fix_files`) and the leftovers (`left_behind`), the outcome (applied, blocked with why), and what happened next (the re-verify attempt it led to, linked).
- The review node's attempt pages: round k shows that round's verdict, findings and reviewers as the review node does today, with "superseded by round k+1" at the top and the delta base; the latest round is the node page.
- The verify node's attempt caused by a repair says so ("attempt 2 after repair 1", the existing `statusCause` wording extended), linking to the repair node.

### 5.5 Assignment (`pages`, S7 section 4.10 of PRD_VIEWER_UX)

One setup line (feature, mode, profile, base commit, `fix_rounds`, and the reviewers from the latest review result, "reviewers not recorded" before a review; no follows link: the contract carries no follows field, an adapter follow-up), then one table row per lane (lane, role, model and effort, skills, owned paths count, checks count, task length) before any long text; each lane's task, prompt and decisions in disclosures below, closed by default except the one a requirement link hands over a quote to.

### 5.6 The review diff inline (`pages`, S7's Diff part of PRD_VIEWER_UX 4.7)

The review node's Diff section renders `review.diff` inline: a file list with added and removed counts (from the diff text, a pure parser in `src/projects/diff.ts`), each file a disclosure with its hunks, line numbers, no syntax colouring beyond add, remove and context tones, the raw patch still downloadable. On a run with a delta (Appendix A `review.delta_from`), the delta diff is the default view and the full diff a second tab. Files over 2,000 diff lines are shown as a stat with a "show" button.

### 5.7 Runs home (`shell`)

- Order: **Needs you** as cards with cause and next-step label (as today; when zero, one line); **Running** as one compact row per run (id, feature, step, since, lanes as chips), not six-line cards; **Paused** as a separate section of compact rows sorted oldest first with "since <n> days" in the paused tone; **Recent** as today with the day groups. A section header carries its count and, for Running and Paused, a one-line sub-header ("3 at the design challenge, 1 at verify").
- The Recent filter counts are computed over the filtered set (P2 1). The look switch is gone with Bold; the header's remaining controls meet 44 px under 760 px (P2 3). The feature header fetches the latest reviewed run's review result (one request, cached per feature) and lists its reviewer ids under "Reviewers"; while no run is reviewed, or the fetch is pending or failed, it shows the definition's review steps labelled "Review steps" and never calls them reviewers (P2 2 and 8); the run list itself carries no reviewers.
- The project rail, the header, search, filters and group-by stay as the revamp built them; the rail's state dots stay.

### 5.8 The eight P2s

| P2 | Lane | Where it closes |
|---|---|---|
| Recent filter counts over every row | shell | 5.7, `lists.ts`, a unit test |
| Feature header names definition review steps, not reviewers (two findings) | shell | 5.7, a browser assertion |
| 34 px look-switch target under 760 px | shell | 5.7, the header at 390 |
| Read-only check does not cover the Projects header | shell | `projects.spec.ts` extends `expectNoExecutionControls` to the header |
| No browser test of the Runs home data path | shell | `ux-lists.spec.ts` or `revamp-lists.spec.ts` records one fetch against the mock |
| 390 px stacking untested | pages | the `run-phone` scenario |
| Lane chip tones tested only all-passed | pages | the `fix-loop-graph` scenario (a failed and a running lane) |

### 5.9 Phone (both UI lanes)

At 390 px: single column, 16 px gutters, no horizontal page scroll (the graph box scrolls inside itself), 44 px tap targets, tables scroll inside their container, the state line and next step above the graph. Playwright asserts it per surface.

## 6. Lanes and files

- `adapter`: `workflow/export_state.py`, `workflow/test_export.py`, `contracts/projects/**` (schemas, `v1.ts`, `triage.ts`, `examples.ts`, `contract.test.ts`), `server/**`, `tests/unit/triage.test.ts`, `docs/handoff/refine-adapter.md`.
- `pages`: the run page, its node pages, Assignment, the inline diff, the graph and its layout, their styles, fixtures and specs (the policy lists every file), `docs/handoff/refine-pages.md`.
- `shell`: `src/App.tsx`, `src/App.css`, `src/index.css`, `src/projects/theme.css`, `tone.ts`, `ui/`, Runs home, the rail, lists, the Now banner and command block components, time, their fixtures, specs and unit tests, `docs/handoff/refine-shell.md`.
- Unowned in this run: `PRODUCT.md`, `DESIGN.md`, `tests/project-workflows/support.ts`, `harness.ts`, `playwright.config.ts`, `global-teardown.ts`, `src/document/**`, `src/graph/**`, `workflow/**` except the export module and its test.

## 7. Acceptance

Browser scenarios (policy.json; each id in exactly one test title as `[scenario:<id>]`, one `screenshot:<id>` attachment):

- `pages`: `run-first-screen` (5.1 at 1440 on a paused, a running and a succeeded fixture); `fix-loop-graph` (5.2 to 5.4 on the Appendix A fixture: two repair nodes with their return marks and meta lines, the review node at round 2 with its delta base, the lane pins, the keyboard order, the legend; a failed and a running lane chip); `assignment-and-diff` (5.5, 5.6); `run-phone` (5.9 on the run page, including the stacked layout).
- `shell`: `home-sections` (5.7 at 1440: the four sections, compact running and paused rows, correct filter counts, the reviewers in the feature header); `home-phone` (5.9 on Runs home: 44 px targets, no horizontal scroll); the read-only check over the header.
- `adapter` (landed by run 003): `workflow/test_export.py` (1.10.0 on the copied worker-skills-001 journals; the 1.9.0 content plus the version and the new keys on a run without them); `server/projects.test.ts` (1.10.0 accepted, repair nodes projected with their statuses, `fixLoop` live and from the export, `review.round` and `delta_from`, `roles` and `skills` per worker; 1.9.0 exports unchanged); `contracts/projects/contract.test.ts` with the Appendix A records as examples; `tests/unit/triage.test.ts` for the repair-session markers and the state line's inputs.

Every lane: `npm run build`, `npm run lint`, `npm run test:unit`, `npm run test:contracts` green on its own worktree; browser specs only through `check-report`.

## Appendix A: export 1.10.0 and the viewer contract (pinned; the UI lanes build fixtures from these records only)

Revised after design-challenge attempt 1 of `viewer-refine-001` (2026-10-08, `features/viewer-refine/decisions.md` [L1]): the lanes run in **two runs**, the `adapter` lane alone first (`launch viewer-refine --workers adapter`), merged to main, then `pages` and `shell` (`--workers pages,shell`) against a main that already serves 1.10.0. A UI lane never builds against a contract another lane changes in the same run: `runDetailSchema` is strict and `fetchRunDetail` validates every response, so a fixture with keys the base contract lacks is rejected.

### A.1 Export (`workflow/export_state.py`, `EXPORT_VERSION = "1.10.0"`, additive)

Every key below is left out or `null` exactly as stated for a run that lacks the record, so a 1.9.0 run re-exports with the same content apart from the version and the new keys.

1. **Repair nodes are projected by the server, not written by the export.** `definition.nodes` in `run-state.json` is unchanged (so stored definitions, the comparison in `definition()` and every older export stay as they are). The server adds one node per **session** repair of `fixLoop` (A.2) to the run detail's `definition` and `snapshot`: `{"node_id": "repair-<n>", "label": "Repair <lane> <n>", "kind": "worker", "depends_on": [<step>]}` where `<n>` is the journal's `n` (gaps are possible, since `n` counts commit repairs too), `<step>` is `verify_<lane>` for trigger `verify`, `candidate` for `candidate`, `review` for `review`; inserted right after that step. No other node depends on a repair node (the graph stays acyclic; the re-verify is a new attempt of the existing step). One source only: the `fixLoop` the server chose (live or export), never both.
2. Top-level `fix_loop` (`null` for a run whose plan has no `automatic.fix_rounds` and no `repairs.json`). The worked example below is the state after a verify block repaired in round 1 and a review block repaired in round 2, with round 2's reviewers approving:

```json
{
  "version": "1.0.0",
  "rounds": 2,
  "repairs": [
    {
      "n": 1, "node_id": "repair-1", "mode": "session", "lane": "viewer", "trigger": "verify", "round": 1, "rounds": 2,
      "status": "applied", "by": "controller", "recorded_at": "2026-10-09T08:12:40Z", "applied_at": "2026-10-09T08:31:02Z",
      "blocked_step": "verify_viewer", "reentered_steps": ["verify_viewer"], "reason": "repair session round 1: verify",
      "workspace_commit": "3f1c9a2b7d4e5f60718293a4b5c6d7e8f9012345", "session_id": "6a1d2c3b-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
      "review_round": null, "findings": [], "delta": false,
      "fix_files": ["src/projects/WorkflowGraph.tsx"], "left_behind": [],
      "requested": {"model": "claude-opus-4-8", "effort": "medium"},
      "gate_reasons": ["frontend-unit-regression failed: 1 of 42 tests failed (steps.test.ts: repair row order)"]
    },
    {
      "n": 2, "node_id": "repair-2", "mode": "session", "lane": "viewer", "trigger": "review", "round": 2, "rounds": 2,
      "status": "applied", "by": "controller", "recorded_at": "2026-10-09T09:40:11Z", "applied_at": "2026-10-09T10:02:48Z",
      "blocked_step": "review", "reentered_steps": ["review"], "reason": "repair session round 2: review",
      "workspace_commit": "5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f", "session_id": "0c9b8a7d-6e5f-4a3b-9c2d-1e0f9a8b7c6d",
      "review_round": 1, "findings": [{"severity": "P1", "message": "src/projects/WorkflowGraph.tsx:118 the return mark is drawn from depends_on, so a repair node with no fix_loop entry gets an edge to nowhere", "disposition": "open", "worker": "viewer", "requirement": "PRD_VIEWER_REFINE 5.2: the return mark is a drawing from the fix-loop section, never a dependency edge", "reviewer": "general"}],
      "delta": false, "fix_files": ["src/projects/WorkflowGraph.tsx", "tests/unit/dag.test.ts"], "left_behind": ["coverage/"],
      "requested": {"model": "claude-opus-4-8", "effort": "medium"}, "gate_reasons": []
    }
  ],
  "review_rounds": [
    {"round": 1, "verdict": "blocked", "candidate": "5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f", "lane": "viewer",
     "findings": [{"severity": "P1", "message": "src/projects/WorkflowGraph.tsx:118 the return mark is drawn from depends_on, so a repair node with no fix_loop entry gets an edge to nowhere", "disposition": "open", "worker": "viewer", "requirement": "PRD_VIEWER_REFINE 5.2: the return mark is a drawing from the fix-loop section, never a dependency edge", "reviewer": "general"}],
     "reviewer_sessions": ["d1e2f3a4-b5c6-4d7e-8f9a-0b1c2d3e4f5a", "e2f3a4b5-c6d7-4e8f-9a0b-1c2d3e4f5a6b"],
     "started_at": "2026-10-09T09:40:10Z", "archived": true, "restored_at": null, "repair_n": 2,
     "reviewers": [{"reviewer_id": "general", "verdict": "blocked", "session_id": "d1e2f3a4-b5c6-4d7e-8f9a-0b1c2d3e4f5a"}, {"reviewer_id": "coverage", "verdict": "approved", "session_id": "e2f3a4b5-c6d7-4e8f-9a0b-1c2d3e4f5a6b"}]}
  ]
}
```

   **The same run mid-round, as the live read serves it** (item 6), at 09:40:12, right after round 2 launched and before the receipt bound the session: the entry has `status: "launched"`, `session_id: null`, no fix files, no outcome yet, and the export of the moment still carries the review step's task error:

```json
{"n": 2, "node_id": "repair-2", "mode": "session", "lane": "viewer", "trigger": "review", "round": 2, "rounds": 2,
 "status": "launched", "by": "controller", "recorded_at": "2026-10-09T09:40:11Z", "applied_at": null,
 "blocked_step": "review", "reentered_steps": ["review"], "reason": null, "workspace_commit": "5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f", "session_id": null,
 "review_round": 1, "findings": [{"severity": "P1", "message": "src/projects/WorkflowGraph.tsx:118 the return mark is drawn from depends_on, so a repair node with no fix_loop entry gets an edge to nowhere", "disposition": "open", "worker": "viewer", "requirement": "PRD_VIEWER_REFINE 5.2: the return mark is a drawing from the fix-loop section, never a dependency edge", "reviewer": "general"}],
 "delta": false, "fix_files": [], "left_behind": [], "requested": null, "gate_reasons": []}
```

   Every field of a session entry is present in every status; the ones the journal has not written yet are `null` or `[]` (`session_id` until the receipt binds, and still `null` after a launch failure; `fix_files` from `lanes.<lane>.fix_files` once the repair is `recorded` (not at capture); `left_behind`, `reason`, `applied_at` at close; `requested` once the receipt exists).

   Mapping from the journal (`repairs.json`, `workflow/repair.py`): `n`, `status`, `mode`, `trigger`, `round`, `rounds`, `recorded_at`, `workspace_commit`, `session.session_id`, `review_round`, `brief.findings`, `lanes.<lane>.fix_files`, `left_behind` are read as written. The journal's `blocked` key is the blocked-step object (`{step, packets, ...}`) whose `step` may name several steps at once (`"verify_pages, verify_shell"` when two lanes fail in one superstep); the export never copies it. `blocked_step` is derived from `trigger` and `lane` exactly as the node's `depends_on` in item 1 (`verify_<lane>`, `candidate`, `review`), so it is always one node id; the raw step string stays out of the contract. The text of the outcome is the journal's `reason` (set by `close_session` on a blocked entry and by `apply_repair` on an applied one): exported as `reason` (string or `null`). `applied_at` is the journal's `applied_at` when it records one, else `null`. `delta` is `true` only when `brief.delta` names a `review.delta.diff` or `review.delta.round-<k>.diff` (the fallback to the full `review.round-<k>.diff` exports `false`). `requested` is the repair receipt's `requested` (`null` when the receipt is missing); `gate_reasons` is the verbatim list of the packet the round answered (`[]` for a review round); `node_id` is derived. A `review_rounds` entry is `review-rounds.json` as written (`round`, `verdict`, `candidate`, `lane`, `findings`, `reviewer_sessions`, `archived`, `started_at`, and `restored_at` only when a restore wrote it, exported as `null` otherwise) plus `repair_n` (the repair whose `review_round` names it, else `null`) and `reviewers` (from the archived `review.round-<k>.json`: id, verdict as the controller derives it, `approved | blocked | null`, never a status word such as `accepted`; session id; `[]` when the archive is unreadable or the round was restored). A finding is the review finding's verbatim object as the controller writes it: `{severity, message, disposition, worker, requirement}` (`contracts/workflow/reviewCompletion.schema.json`, `additionalProperties: false`) plus the `reviewer` the combine step adds; no `file` or `line` field exists, the location lives in `message`. A malformed journal exports `{"version": "1.0.0", "error": "<why>", "rounds": null, "repairs": [], "review_rounds": []}` and no repair nodes.

   **The blocked cases, as the controller produces them.** A review-round repair that ends blocked restores the round (`unarchive_round`): the entry has `archived: false` and `restored_at` set, `review.round-<k>.json` is `review.json` again, no later review round runs, and the run stops `controller_blocked` (fix loop exhausted). A verify- or candidate-trigger repair that ends blocked also exhausts the loop and stops the run; the review record is whatever it was. In both cases the repair entry is `status: "blocked"` with its `reason`, and its node reads `failed` (item 5), while the run's own status comes from the pinned steps only. The restored-round record, pinned:

```json
{"version": "1.0.0", "rounds": 2,
 "repairs": [
  {"n": 1, "node_id": "repair-1", "mode": "session", "lane": "viewer", "trigger": "review", "round": 1, "rounds": 2,
   "status": "blocked", "by": "controller", "recorded_at": "2026-10-09T11:02:40Z", "applied_at": null,
   "blocked_step": "review", "reentered_steps": ["review"], "reason": "the repair session repair-1 ended without a completion file",
   "workspace_commit": "5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f", "session_id": "0c9b8a7d-6e5f-4a3b-9c2d-1e0f9a8b7c6d",
   "review_round": 1, "findings": [{"severity": "P1", "message": "src/projects/WorkflowGraph.tsx:118 the return mark is drawn from depends_on, so a repair node with no fix_loop entry gets an edge to nowhere", "disposition": "open", "worker": "viewer", "requirement": "PRD_VIEWER_REFINE 5.2: the return mark is a drawing from the fix-loop section, never a dependency edge", "reviewer": "general"}],
   "delta": false, "fix_files": [], "left_behind": [], "requested": {"model": "claude-opus-4-8", "effort": "medium"}, "gate_reasons": []}
 ],
 "review_rounds": [
  {"round": 1, "verdict": "blocked", "candidate": "5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f", "lane": "viewer",
   "findings": [{"severity": "P1", "message": "src/projects/WorkflowGraph.tsx:118 the return mark is drawn from depends_on, so a repair node with no fix_loop entry gets an edge to nowhere", "disposition": "open", "worker": "viewer", "requirement": "PRD_VIEWER_REFINE 5.2: the return mark is a drawing from the fix-loop section, never a dependency edge", "reviewer": "general"}],
   "reviewer_sessions": ["d1e2f3a4-b5c6-4d7e-8f9a-0b1c2d3e4f5a", "e2f3a4b5-c6d7-4e8f-9a0b-1c2d3e4f5a6b"],
   "started_at": "2026-10-09T11:02:39Z", "archived": false, "restored_at": "2026-10-09T11:40:12Z", "repair_n": 1, "reviewers": []}
 ]}
```

   Here `review.round` is 1 (no archived round), `review.json` is the restored round's record, and the review node has one attempt.
3. `review` gains `round` (one plus the number of `review_rounds` entries with `archived: true`; `1` for every run without rounds, and `1` again after a restore), `delta_from` (the combined status's `delta_from` when recorded, else `plan.follows.candidate_commit` when `review.delta.diff` exists, else `null`) and `delta_diff`: an artifact reference to `review.delta.diff`, served exactly as `review.diff` is (never inlined into `run-state.json`), `null` without the file. While the reviewers of a round k > 1 are running, `review.json` is archived and the `review` section is `null`, as it is for every run before its review: `fix_loop.review_rounds` is the live signal of the round, and the viewer labels the review node "round k in review" from it.
4. `inputs.automatic` gains `fix_rounds` (`plan.automatic.fix_rounds`, left out for a plan without it). `inputs.workers.<lane>` gains `roles` (`plan.nodes.<lane>.roles` as `{"model": ..., "effort": ...}`, `null` for a plan without lane pins) and `skills` (`plan.nodes.<lane>.skills`, `[{"name": "impeccable", "sha256": "<64 hex>"}]`, `[]` when the plan has none).
5. Repair nodes have no rows in the controller's graph tasks: the server derives their status from `fix_loop.repairs[].status` (`launched`, `captured`, `recorded` → `running`; `applied` → `succeeded`; `blocked` → `failed`), `since` from `recorded_at`, attempt `1`. **A repair node's status never enters the run's status fold** (`projectSnapshot`): the run's status is folded from the pinned steps only, so a run whose round ended blocked and that the operator then repaired by hand and integrated reads `succeeded`, not `failed`. The repair sessions' own timeline rows are written to node `repair_<lane>` (`repair.py`): the server's `eventNode` maps a `repair_<lane>` row to that lane's `repair-<n>` node by the `round <r>` its message carries, so the launch and the passed or failed rows of a round sit on the repair node.

6. **Live while a round runs.** The controller rewrites `run-state.json` only at step ends: after a round's `launched` entry it waits on the session, and on the blocked path nothing exports. So the export alone shows a repair node only after the round applied, or after the operator's next `status`/`export`; and for the whole round the export carries the task error of the step the round answers. The server therefore reads the fix loop **live for every registered project**, as it reads `attack.json` and `panel.json` (through `withRunsRoot`, no `expose_run_dir` condition, which gates only the `run_dir` string), in **one helper** that `projectRun` calls (so `listRuns`, `loadRun`, `reviewResult`, `artifact`, `workerResult` and `runInputs` all see the same `fixLoop`): `repairs.json` is read live whenever readable and valid (one small file per run; the list polls pay that read, which is what keeps a list row and the detail from contradicting each other for a whole round), and `review-rounds.json` plus `repair-<n>.interactive.json` are read live too, each falling back to the export's `fix_loop` when unreadable or invalid (live wins when valid, no mtime comparison); `fixLoop.source` is `live` when `repairs.json` was read live and `export` otherwise (the round list and the receipts each fall back on their own, and that fallback does not change `source`; the handoff's mapping table says so). The live helper reads the raw journal **leniently**: it takes the keys it maps (item 2) and ignores every other key (the journal's shape depends on the entry's status and on the controller's version: `blocked`, `workspace`, `what`, `brief`, `source_commit`, `base_kind`, `expected_candidate_tree`, `attempt_targets`, `fork_from`, `head_before`, `head_after`, `closed_at`, `stop_pending`, `stop_retried`, per-lane `commit` and `changed_files`, and the different shape of a `--commit` entry); an entry is invalid only when a key the mapping needs is missing or of the wrong type, and the strict schema of A.2 applies to the `fixLoop` the server produces, never to the journal. A run directory that holds session entries in `repairs.json` is read live whatever its export's version: runs the controller wrote at 1.9.0 since the fix loop landed (`worker-skills-001` is one) show their loop too, and "every 1.9.0 export renders exactly as today" holds for every run without session repairs. The controller-side fix (an export right after a round's `launched` entry and on the blocked path) is a follow-up for an engine lane, recorded in the handoff, not this lane's.
7. **The steps a running repair re-enters.** While a repair node of a lane is `running`, every pinned step whose task error belongs to the same block is treated as re-entered, not only the step the round answers. Which steps those are is a field of the entry, `reentered_steps`, derived once by the mapping on both paths (A.1 item 2): for a verify trigger, `verify_<node_id>` for every packet of the journal's `blocked.packets` (the export path reads the same journal at export time, so both paths agree); for a candidate trigger, `["candidate"]`; for a review trigger, `["review"]`. A re-entered step is projected with status `running` (its attempt and `result_uri` unchanged, so its last packet stays reachable), so `projectSnapshot`'s fold reads `running`, the run is not finished, keeps its live questions and controller liveness, and `focusOf` gives the focus to the running repair node. A blocked repair node is a focus candidate only while no pinned node is `running` or `awaiting_approval` and the run has not succeeded (an operator `--commit` repair or a retry that re-verifies the lanes takes the focus away even though item 9 lists no commit repair); a succeeded run with an earlier blocked repair has no repair focus. `tests/unit/triage.test.ts` and `server/projects.test.ts` cover the two-lane verify case, the review case and both focus rules.
8. **The review node's attempt and result.** The export's `review.attempt` stays `1` (additive only; its meaning is unchanged). The server projects the review node's snapshot attempt and `ReviewResult.attempt` from `review.round`, and, when the `review` section is `null` during round k > 1 or carries no `round` (a 1.9.0 export of a run with session repairs, read live), from `1 + the archived rounds` of `fixLoop.review_rounds`. The live review is served at `/reviews/<round>` (`result_uri` and `reviewResult` keyed on the projected attempt), and the pages of rounds before the latest read from `fixLoop.review_rounds`; the handoff's mapping table records the row. A server test of the A.1 fixture resolves `/reviews/2`, and a round-2-in-review state shows attempt 2 with `review` null.
9. **Only session repairs are listed.** `fix_loop.repairs` holds `mode: "session"` entries only; an operator's `--commit` repair (which has no `trigger`, `round` or session and may name several lanes) stays the timeline's `repair` marker as today. A commit-only `repairs.json` exports `repairs: []` and no repair node.
10. **Record facts the strict schema must admit** (each with a test): `by` is `controller`, `operator` or `maintainer`, with an optional `via` (`"claude-code"`); `requested` is `{model: null, effort: null}` for a plan pinned before roles, `null` only when the receipt is missing; `brief.delta` is an absolute path, so the `delta` rule matches on the basename; `blocked.packets` may hold several lanes' packets, so `gate_reasons` takes the packet whose `node_id` is the entry's lane; rounds count per lane, so the `round <r>` mapping of timeline rows is per lane; two `repair_<lane>` rows carry no `round <r>` (the stop-not-confirmed warning and the retried stop) and name `repair-<n>` directly, so the mapping is by the `repair-<n>` token first, then by round; the mapping needs the message, so it lives in the server's `eventGraphNode`, not `eventNode`; an archived round predating parallel reviewers has no `reviewers` list, and `reviewers` falls back as `reviewer_entries` does.
12. **One fixture for both mappings.** The journal-to-`fix_loop` mapping exists twice, in Python (`export_state.py`) and in TypeScript (the live helper). Both are tested against the same files: the real journals of run `worker-skills-001` (readable by the worker as the operator's account; the design challenge's sandbox could not read them) copied verbatim into `contracts/projects/examples/fix-loop/` (`repairs.json`, `review-rounds.json`, `review.round-1.json`, the two repair receipts) with the expected `fix_loop` record beside them; a change to the mapping that moves one side fails the other's test. The expected record of that run is also a second contract example, and the restored-round case (A.1 item 2) is pinned as a record below.
13. **Projected nodes and the definition revision.** `publishDefinition` hashes the pinned definition only: repair nodes are projected after the hash, so a run's `definition_revision` never changes because a round landed, and RunHeader's "changed since" logic is untouched.
11. **Interim rendering.** Between this run's merge and the UI run's merge, main serves repair nodes of kind `worker` to today's viewer, which renders them as generic worker nodes; the handoff names that state.

### A.2 Viewer contract (`contracts/projects`, run detail `contract_version: "1.10.0"`)

- `server/projects.ts` accepts export `1.10.0` (older versions still accepted). `definition.nodes` may include `repair-<n>` nodes of kind `worker` (the node id pattern already allows them); `snapshot.nodes` carries their derived status (A.1 item 5); the review node's snapshot `attempt` is projected from `review.round` (A.1 item 8).
- `runDetail` gains `fixLoop`: `{contract_version: "1.10.0", source: "live"|"export", ...fix_loop}` (A.1 item 6), or `null`. `review` gains `round`, `delta_from`, `delta_diff`. `inputs.workers[]` gains `roles` and `skills`; `inputs.automatic.fix_rounds` optional. The schema stays strict and is written from the records above, including `reviewer_sessions`, `restored_at: null`, a round reviewer's verdict as `approved | blocked | null`, and every session-entry field in every status (nulls and empty lists for what is not written yet).
- `triage.ts`: a repair session is a span of its node (from its `repair_<lane>` rows mapped as A.1 item 5) with a `repair` marker on the step it answers, whose `node_id` is the entry's `blocked_step` from `fixLoop` (the controller's "Repair <n> by ..." row sits on `verify_<lane>` for every trigger, so the row's node is not used for a session repair; `repair: {n, snapshot, files}` as today, plus `session: true`, `round`, `trigger`); the review node's attempts are the archived rounds plus the live one (round k's span ends at `review_rounds[k-1].started_at`; a restored round is one attempt); the `focus`/`attention` derivation treats a running repair node as the run's focus ("Running: repair 2 of viewer (round 2 of 2) after review blocked"), and a blocked repair as the cause of the `controller_blocked` attention the controller records. The fixture of A.1 is the contract example and the unit test's input; a second example carries the restored-round case.
- The pages lane's diff parser treats a `GIT binary patch` section as a stat with no hunks.
- **Failure isolation.** The live helper reads the journal leniently (A.1 item 6), so an unknown journal key is never an error. What can fail is the **projected** `fixLoop`: an entry whose mapped key is missing or mistyped (no `n`, a `status` outside the journal's words, a `by` or `via` value the contract lacks, a finding of another shape, `trigger` absent, or `lanes` empty: the lane is the one key of the journal's `lanes` object, never a `lane` key), from the live records or from the export's `fix_loop`. When neither source projects a valid `fixLoop`, the server serves the error form `{contract_version, source, error, rounds: null, repairs: [], review_rounds: []}` with no repair nodes and a `warn`, never `RUN_STORAGE_INVALID`: a `server/projects.test.ts` case with a `repairs.json` entry whose `status` is a word the mapping does not know, and the export's `fix_loop` absent, gets 200 on both the run list and the detail with `fixLoop.error` set; a second case with an extra unknown key in an otherwise valid entry gets `source: "live"` and no error. The fix loop can never fail a run or the run list, as the sidecar, attack and panel records cannot.
- Every 1.9.0 export renders exactly as today.
