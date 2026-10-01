# PRD: Projects viewer revamp ("Operator's desk")

Status: Proposed 2026-10-01. Follows [PRD_VIEWER_UX.md](PRD_VIEWER_UX.md) (Run Story) and keeps every truthfulness rule it set; this PRD changes layout, hierarchy, colour and the lists, not what the viewer claims. Scope: the Projects viewer only (`src/projects/**`, `src/App.tsx` Projects header, per-area stylesheets, `tests/project-workflows/**`, `tests/unit/**`). No server, contract or controller change. Mockup: the "Projects Viewer Revamp" artifact (Calm/Bold switch, four screens). Ships as the feature run `features/viewer-revamp` on branch `feature/viewer-revamp`, which the operator reviews before any merge.

## 1. Problem

The operator's words (2026-10-01): the manager UI "seems too cluttered and it's still hard to review and manage stuff, plus the new Recents doesn't help. Add some colour and make it good UI and UX." Jobs the viewer must make easy, in their order: see what needs me now; review a run's result; manage many runs and features; watch a live run; and an overall better, more structured layout.

Measured on the live viewer (1440×900, screenshots in the session scratchpad `revamp/shots/`):

- **Runs home is a 4,411 px monochrome list.** 44 Recent rows render flat with the same weight, every row two lines of grey text and a small status pill; nothing is filterable or searchable; the 30 project cards sit at the very bottom (y ≈ 3,900), where the operator never scrolls. "Needs you · 0" takes a section header and a sentence. A failed `RUN_STORAGE_INVALID` run appends a yellow error box the reader meets after 43 rows.
- **No way to narrow.** 27 of the 30 projects are `project-B-*` variants of one game; the operator cannot collapse them, filter by status or project, or see at a glance which project has a failing or waiting run.
- **Colour carries nothing.** Succeeded and Failed differ by a 12 px pill; a paused run waiting three days looks like a finished one. Status is not visible in the rail, the rows, the cards or the graph until the reader focuses on text.
- **The run page is right but dense.** The Run Story structure works (Now banner, graph, Steps, Activity), yet the Activity list is 30 undifferentiated rows, the graph is grey on grey, the header carries two lines of metadata in one weight, and the lanes line is easy to miss.
- **Review findings are a wide table.** Eight P2s render as a 5-column table with 200-word cells, two "Group by" and "Reviewer" toggle rows, and a verdict paragraph above; severity is a plain text cell.
- **At 390 px** the home is 12,703 px tall and the review node 7,204 px.

## 2. Goals

1. **Needs-you first, everywhere.** Runs home opens on what waits on the operator, as cards with the cause and the next command; the project rail marks every project with a waiting, failing or running run; the browser tab title keeps the count.
2. **Narrow in one click.** Search (run id, feature title, outcome text), status filters, a time filter and group-by-project on the lists; project groups in the rail collapsible (a prefix group for `project-B-*`); Recent grouped by day with a "show older" fold.
3. **Colour means state.** One semantic palette (ok, running, needs-you, failed, paused, idle, and P0/P1/P2) used identically on chips, card stripes, rail dots, graph nodes, step bars and finding stripes. The accent hue is separate from the status hues and is never used for status.
4. **Two looks, one switch.** Calm (neutral cool surfaces, one accent, colour only for state) and Bold (warm surfaces, a navy band for section headers, coral accent, tinted cards, a display face). Both are token sets on `:root[data-look]`; a remembered toggle in the Projects header switches them; the operator keeps one after review and the other is deleted in a follow-up. Both have a dark theme.
5. **Review in one flow.** A review node opens on four figures (blocking, open, per reviewer, per lane), then findings as cards with a severity stripe, ordered P0, P1, P2 then lane, with one filter row (reviewer, lane, open only) replacing the two toggle rows; the diff link and reviewer cards follow.
6. **Structure, not walls.** Every page is sections with one header each (small-caps label in Calm, band in Bold), a one-line sub-header with counts, and tools on the right. Activity groups by phase in closed `<details>` with the newest phase open. Tables carry a day or group row. Nothing on a first screen is a paragraph of metadata.
7. **Nothing lost.** Every test id, route, honesty line, inferred-time marker and read-only rule of PRD_VIEWER_UX stays. Both Playwright phases stay green apart from assertions this PRD migrates by name (section 8).

Non-goals: controls that start, answer or approve anything; server or contract changes (the lists keep reading the served `activity`); the document and skills areas; changing `definition.name`.

## 3. Information architecture

| Route | Page | What changes |
| --- | --- | --- |
| `/projects` | Runs home | Two-column shell: project rail + content. Content: Needs you (cards) → Running (cards with lane chips) → Recent (searchable, filterable table grouped by day) → Attention (runs that could not be loaded, one card each). The read-only note moves to the rail's foot. |
| `/projects/<p>` | Project | Same shell, rail item selected; content: the project's features as a table (last run status, runs count, last activity), then its runs grouped by feature. |
| `/projects/<p>/workflows/<w>` | Feature | Header card: title, lanes, reviewers, run count, a run-history strip of chips (one per run, status-coloured, linking to the run); runs table ("Where it stands", reviewers, took, started); Definition as a closed section with the status-coloured graph. |
| `/…/runs/<r>` | Run | Rail hidden (full width). Header card with a status-coloured top rule (Bold: band gradient); Now banner; lanes line as chips; tabs; Pipeline and Steps side by side at ≥ 1100 px, stacked below; Activity grouped by phase. |
| `/…/runs/<r>/nodes/<n>` | Node | Sticky step strip as status-coloured chips; header card; figures row where the node has them (review: blocking, open, per reviewer, per lane; verify: checks passed/failed, duration; worker: files, completion state, questions); sections as today, restyled; History last. |

The rail: "Needs you" entry with the count across projects; the projects list with a status dot (needs-you amber, running blue, failed red, idle grey) and run count; projects sharing a prefix before the last `-` segment with three or more siblings fold into a `<details>` group named by the prefix (`project-B` → "project-B (27)"), remembered open or closed; at ≤ 860 px the rail becomes a horizontal chip row.

## 4. Visual system

Tokens, in a new `src/projects/theme.css` imported once by `ProjectsView.tsx`, defined on `:root` with dark overrides under `prefers-color-scheme: dark` guarded by `:root:not([data-theme="light"])` and again under `:root[data-theme="dark"]`, and the Bold set under `:root[data-look="bold"]` with the same dark pattern. Names are fixed by this PRD so both lanes build to them:

- Surfaces and text: `--bg`, `--surface`, `--surface-2`, `--fg`, `--muted`, `--border`, `--border-strong`, `--shadow`, `--radius`.
- Accent: `--accent`, `--accent-fg`, `--accent-soft`.
- State: `--ok`, `--ok-soft`, `--run`, `--run-soft`, `--warn`, `--warn-soft` (needs you), `--fail`, `--fail-soft`, `--pause`, `--pause-soft`, `--idle`, `--idle-soft`.
- Severity: `--p0`, `--p1`, `--p2`.
- Section header band (Bold only; Calm sets it transparent): `--band`, `--band-fg`.
- Type: `--font-display`, `--font-body`, `--font-mono`. Calm: IBM Plex Sans and IBM Plex Mono. Bold: Sora for display, Manrope for body, JetBrains Mono. Fonts load from Google Fonts with system fallbacks; the viewer must look right when the fonts do not load (offline tests).

Mapping of state to colour is one pure function, `stateTone(status | attention | severity)` in `src/projects/tone.ts` (no React), used by chips, card stripes, rail dots, graph nodes and step bars. The look switch sets `data-look` on `<html>` and remembers it in `localStorage` (`mdm-look`), default `calm`; a missing or invalid stored value is `calm`.

Components (`src/projects/ui/`, no React imports in the pure helpers): `Chip` (status, severity, plain), `Card` (tone stripe), `SectionHeader` (label, sub, tools), `Figures` (the KPI row), `FilterRow`, `DayGroupedTable`. Existing components are restyled through these; test ids stay on the elements that carry them today.

## 5. Pages

### 5.1 Runs home

- **Needs you**: one `Card` per run with `activity.attention` (`question`, `pane`, `approval`, plus `paused`, `interrupted`, `failed` when the run is not terminal), warn tone, the cause line from `activity.headline`, the next command as a `CommandBlock` with Copy, since-when and age, "open run ›". Empty state is one line in the section sub-header ("nothing waits on you"), no card.
- **Running**: a `Card` per non-terminal run not in Needs you, run tone, the current step, one `lane` chip per lane with a thin progress bar (elapsed over the worker deadline when the served activity has it; otherwise elapsed only) and "not launched" for lanes without a session, the controller chip (alive / not running / unknown).
- **Recent**: search input (`id="runs-search"`, filters rows client-side on id, feature title and outcome), filter chips `All`, `Failed N`, `Succeeded N`, `Today`, `Group by project`; a table with Run (chip + id), Feature (title · project), Outcome (one line, ellipsised, full text in `title`), Took, Finished (clock · ago); rows grouped under day rows (`Today`, `Yesterday`, then the date); the first 10 rows render, the rest behind "Show N older runs". Rows stay one link each in an `li`-equivalent row whose accessible name starts with the run id (the existing `runs-home` assertions).
- **Attention**: runs that failed to load, one fail-tone card each, with the error code; replaces the yellow box.
- Polling and data: unchanged (`lists.ts`, 15 s, served `activity` only, no per-run fetch).

### 5.2 Project and feature

- Project: features table (feature, last run chip, runs, last activity) then runs grouped by feature as on Runs home.
- Feature: header card (title rule: unchanged), run-history chips, runs table, Definition section closed by default (open when there are no runs), graph status-coloured.

### 5.3 Run page

- Header card: status chip, run id as the title, dates and duration, mode; second line branch @ commit, worker and review deadlines, definition revision, `Details ▸`. Top rule in the run's tone (Bold: band to accent gradient).
- Now banner: unchanged content, tone-coloured left rule and soft background.
- Lanes line as chips (`lane`), each `worker ✓ · verify ✓ · candidate ✓ · N checks` as today.
- Pipeline (the SVG graph, kept) and Steps side by side at ≥ 1100 px: graph nodes take `--<tone>-soft` fills and `--<tone>` strokes by status, the dash patterns by executor stay, the legend stays three entries; the Steps table keeps its columns and bars with tone colours.
- Activity: grouped by phase (challenge, workers, freeze and verification, review and integration) into `<details>`, newest phase open, "Expand all" and the controller-log toggle in the tools; rows keep their test ids and text.

### 5.4 Node pages

- Step strip chips in tone. Header card as the run page.
- Review: `Figures` (Blocking, Open, per reviewer, per lane), the diff link in the header; findings as cards (severity stripe, `data-severity`, `data-disposition`, `data-worker`, `data-reviewer` kept), order P0, P1, P2 then lane then reviewer; one `FilterRow` (All, each reviewer, each lane, Open only) replacing the Reviewer and Group-by rows; the blocking card stays outside `review-findings` as today; reviewer cards; History.
- Verify: figures (checks passed / failed, took), the gate line, the check table restyled with tone chips.
- Worker: figures (files, completion state, questions), then the existing sections.
- Challenge, controller and sidecar pages: restyled through the same components, content unchanged.

### 5.5 Mobile (390 px)

Rail becomes a chip row; cards stack; tables keep their day rows and ellipsis; findings cards stack; no horizontal overflow on any page.

## 6. Lanes

Two file-disjoint lanes, both on `feature/viewer-revamp`:

- `shell`: `src/projects/theme.css`, `src/projects/tone.ts`, `src/projects/ui/**`, `src/App.tsx` (Projects header: the look switch and the needs-you count), `src/App.css` (Projects rules only), `src/projects/ProjectsView.tsx`, `RunsHome.tsx`, `RunRow.tsx`, `lists.ts`, `lists.css`, `NowBanner.tsx`, `CommandBlock.tsx`, `LiveStatus.tsx`, `tests/project-workflows/fixtures/ux-revamp-lists.ts`, `tests/project-workflows/revamp-lists.spec.ts`, `tests/unit/tone.test.ts`, `tests/unit/lists.test.ts`, `docs/handoff/revamp-shell.md`.
- `pages`: `src/projects/RunView.tsx`, `RunHeader.tsx`, `StepStrip.tsx`, `StepsTimeline.tsx`, `WorkflowGraph.tsx`, `NodeDetail.tsx`, `NodeHeader.tsx`, `SectionIndex.tsx`, `ReviewDetail.tsx`, `Checks.tsx`, `WorkerInputs.tsx`, `node/**`, `run.css`, `node.css`, `tests/project-workflows/fixtures/ux-revamp-pages.ts`, `tests/project-workflows/revamp-pages.spec.ts`, `tests/unit/panels.test.ts`, `tests/unit/steps.test.ts`, `docs/handoff/revamp-pages.md`.

The seam: the token names and the `tone.ts` signature in section 4, and the `ui/` component props pinned in the `shell` task's Context. `pages` imports `tone.ts` and `ui/` by the names this PRD fixes and, until the candidate combines the lanes, verifies against its own snapshot where those modules do not exist yet: the `pages` lane therefore ships a minimal `src/projects/ui/index.ts` and `tone.ts` **only if** they are absent in its worktree, and the `shell` lane's versions win at the candidate (owned paths decide; the `pages` lane must not list them). Simpler and the chosen rule: the `shell` lane commits `theme.css`, `tone.ts` and `ui/` **first** on the feature branch before launch, as a scaffold commit this PRD's author writes from the mockup; both lanes then build on it and only `shell` may change those files.

## 7. Acceptance scenarios (browser, both phases)

| Scenario id | Lane | Asserts |
| --- | --- | --- |
| revamp-home | shell | Runs home shows the rail with project dots and the folded `project-B` group, Needs you cards with cause and command, Running cards with lane chips, Recent grouped by day with the search narrowing to one row, `Failed` filter leaving only failed rows, "Show older" revealing the rest; existing `runs-home` assertions hold; 390 px has no horizontal overflow |
| revamp-look | shell | the look switch sets `data-look="bold"`, section headers take the band, the card background takes the soft tone, the setting survives a reload; `calm` is the default without a stored value; dark theme renders both looks with readable text (contrast check on chip text over its soft background ≥ 4.5:1 computed in the test) |
| revamp-run | pages | the run page shows the toned header rule, lane chips, Pipeline and Steps side by side at 1440 px and stacked at 390 px, graph nodes filled by status, Activity grouped by phase with the newest open and every existing event row still present after Expand all; every existing `ux-run` assertion holds |
| revamp-review | pages | the review node opens on the four figures, findings as cards in P0/P1/P2 then lane order with their data attributes, one filter row (reviewer, lane, open only) narrowing the cards, the blocking card first on a blocked review, reviewer cards; `reviewers.spec.ts` and `review.spec.ts` counts unchanged |

Unit: `tone.test.ts` (every status, attention kind and severity maps to a tone; unknown maps to idle), `lists.test.ts` (search, filters, day grouping, prefix grouping of projects), `steps.test.ts` (phase grouping of events).

## 8. Migrations

Assertions that change, each named in the lane's handoff with its new form: `clarity.spec.ts` legend (three entries stay; node fill colour assertions, if any, move to tone classes); `ux-lists.spec.ts` section headers (`Needs you · N` wording kept; empty-state sentence moves to the sub-header); `review.spec.ts` toggle rows (the Reviewer and Group-by buttons are replaced by the filter row; button texts listed in PRD_VIEWER_UX 12.3 gain `Open only`, `Show older`, `Expand all`, `Calm`, `Bold`, and every reviewer and lane id as a filter label; no button holds a path or a command).

## 9. Open questions (defaults taken)

- Which look to keep: both ship behind the switch; the operator decides after review. Default if no decision: Calm.
- Whether Running cards show a deadline-based progress bar: only when the served activity carries the deadline; otherwise elapsed only.
- Project prefix grouping threshold: three or more siblings.
