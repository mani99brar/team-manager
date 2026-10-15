# Handoff: UX fixes, stage C, lane `polish`

Readable type everywhere, a skills home that opens on its locations, GitHub and chart words that say what they mean, and the
root Playwright suite as a gate. Findings M6, M30, M31 (the wording), M32, GH8 and the carried desktop fixes ([O21]) of
`features/ux-critique-fixes-c/prd.md` section 6; DESIGN.md carries every amendment of PRD 8.

## What changed, per finding

- **GH8 (the gate).** `playwright.config.ts` gains `testIgnore: ['**/project-workflows/**']` and nothing else.
- **M30 The skills home** (`src/App.tsx`, `App.css`, `tests/*`).
  - `INITIAL_MODE = 'graph'` and `INITIAL_EXPANDED = ['Pi', 'Claude']` are constants: both sources open one level, so every
    location of the loaded listing is a node with its counts, from the data (no location is named in the code). No width or
    user-agent branch exists. The constant applies on every load, direct links included ([L2](a)).
  - Reset sets the same `expanded` set, calls `navigate(null)` (which already requests a fit) and announces "Reset: showing the
    Pi and Claude sources and their locations." Outline is unchanged: it reads the same `expanded` and `selectedId`.
  - The File operations toolbar renders only when an operation applies, and only those that do: New file and New folder where
    `canCreate`, Rename, Move and Delete where the selection is a folder. No disabled file button is rendered. Handlers and
    safeguards are untouched. A selected unavailable location (`pi-missing`) offers none, so no toolbar renders ([L2](b)).
  - `App.css` holds the canvas still when the toolbar appears ([L4](a)): `.toolbars { min-height: 36px }`; under 720 px it
    reserves the second row (`min-height: 78px`) and `.folder-info { min-height: 2lh }`, because the one-line "3 locations" of
    a selected source replaces a two-line hint at 360 px and would otherwise move the canvas by one line. This is the
    reservation [L4](a) requires at 360x640, not phone work.
  - `FIT_PADDING` is unchanged: every location node's group box (circle and label) lies inside the canvas at 1440x900 as it is
    ([L2](c)); the test measures it on load and after Reset following two zoom-ins.
- **M6 The type floor** (every stylesheet under `src/`, `index.css`, `DESIGN.md`).
  - One custom property: `--type-floor` is `13px` on `:root` and `14px` inside the single `@media (max-width: 719px)` rule of
    `src/index.css` ([L2](e)). Every declaration that was under 14 px and is not an uppercase label or exempt now uses
    `var(--type-floor)`; every declaration between 13 and 14 px (0.85rem, 13.5px, 13.6px) is written
    `max(<its old value>, var(--type-floor))`, so no desktop size at or above 13 px shrank (design note 1). Sizes of 14 px and
    more are untouched. 193 declarations changed across 16 stylesheets (94 were under 13 px; the rest sat between 13 and 14 px and
    needed the phone size).
  - `code` in the shell (`.projects-facts code, .workspace-projects code`, was `0.85em`) is `max(1em, var(--type-floor))`;
    `.markdown code` and the broken-image alt are `max(0.9em, var(--type-floor))`.
  - `.dispatch-run` is a `<button>`, whose default 13.33 px fell under the 14 px phone size: `max(13.3333px, var(--type-floor))`.
  - Severity chips (`.ui-sev`, `.ss-sev`) are 13 px. No class, custom property or selector was renamed or removed.
  - Uppercase labels keep 11-12 px (their own rules set `text-transform: uppercase`): `.ss-head` and `.ss-group h4` kept their
    size and uppercase in one rule; `.dispatch-axis-l`, `.dispatch-def-phase`, `.dispatch-rail-h`, `.dispatch-pane-sec h3`,
    `.rail-title`, `.critique-evidence-label`, `.finding-field-label`, `.ui-figure-label`, `.projects-facts dt` and the list
    group headers.
  - Static check, design note 4: at the base `typeFloor.test.ts` rejected 193 declarations. No rule was rejected because its uppercase came from another rule, and no sub-13 text inside `.sb-stage`
    outside the zoomed `.n-*` chips needed an exemption: every `.sb-*` rule listed there was raised (`.sb-feature`, `.sb-def`,
    `.sb-branch`, `.sb-cue`, `.sb-hint`, `.sb-level`, `.sb-legend*`, `.sb-live*`, `.sb-other`, `.sb-details`).
  - Design note 1: the unit test and the `type-floor` scenario both pass and no desktop size at 1440 on the measured pages
    shrank (13px stays 13px; 13.6px stays 13.6px).
  - Definition graph (design note 2d): `run.css` `.workflow-node-label`, `-glyph`, `-meta` and the compact label moved to the
    floor. The test "The current definition's node labels, glyphs and meta lines stay inside their node" opens the
    `feature-flow` definition and measures every label, glyph and meta line against its node rect (1 px tolerance): all inside, so
    nothing was exempted and no question was needed.
- **M31 GitHub wording** (`GithubColumn.tsx`, `ProjectsPage.tsx`). `githubNotReadText(github)` (exported from `GithubColumn.tsx`
  with the lint exemption `LiveStatus.tsx` already uses) is the one sentence: `not_github` "no GitHub remote", `off` "GitHub reads
  are turned off", anything else "GitHub not read: <reason>". The card foot, the compact one-line column and the Local and GitHub
  card use it. The Pull requests and Issues cards render only for a read project (no repeated not-read cards). A read with a
  refresh `reason` keeps its data and states the reason once, in the Pull requests card as before. The Projects page meta line
  says "GitHub read <time>" when a project was read, nothing about GitHub when every project is `not_github`, else "GitHub not
  read". The project header's figures (spend) are `server`'s and untouched.
- **M32 Chart words** (`StepChart.tsx`, `phases.ts`, `dispatch.css`; [L1]).
  - Wide (the chart container over 640 px): the eight full phase names, and every non-empty "ended here" cell reads "<n> ended
    at <phase>" ("<n> landed" under Integrate), wrapping inside its column; `aria-label` and `title` hold the sentence.
  - Narrow (`@container dispatch-chart (max-width: 640px)`): the axis shows `PHASE_SHORT` (now two letters, `Ch La Fr Ve Ca Re Ap
    In`) and a visible legend (`p[data-testid="dispatch-axis-legend"]`, "Ch Challenge · La Launch …", wrapping) names each; the
    cells show their count alone, named by the same sentence. New exports: `phaseLegend`, `endedText`. `PHASES`, `phaseOf` and
    `CHART_COLUMNS` are unchanged.
- **Carried desktop fixes ([O21]).**
  - C6: `.live-status-watching > [aria-hidden]` is `var(--muted)`, the chip's own colour (`lists.css`; `LiveStatus.tsx` untouched).
  - M21: the Sessions table's last column is a fixed 232 px, so every row's grid (each `.ss-row` is its own grid) lines up with
    the header; `.ss-resume-cmd` is `flex: 0 1 auto; max-width: 100%` (fits its text; the narrow rule's `flex-basis: 100%` stays).
  - M23: `.sb-branch` is no longer clipped (`max-width: 100%`, wraps, no ellipsis). The dock's Now message keeps `flex: 1 1 12em`
    and the Open link may wrap in the dock (`signal.css`). **Measured**: on the seeded revamp runs the message was already
    268 px wide with and without the rule, so the rule has no observable effect on those fixtures; the test pins the 140 px floor
    but I could not reproduce the squeeze, so this half is a guard, not a measured fix.
  - M7 (`StepChart.tsx`): run rows show the whole run id (a header chip stays the run's number, with the whole id in its title, because whole ids in the chain made feature headers wrap and pushed `project-collapsed`'s six-headers-in-the-first-screen limit past it in the candidate phase); each definition fold's summary lists the first three
    features that use it ("and N more"); landed shas are de-duplicated, keyed by sha and sit in `.dispatch-landed` with a gap.
    **Open**: the filtered state word. `FeatureGroup` has `total` but not the unfiltered outcome, and a new prop is out of
    bounds, so `stateWord` is unchanged.
- **DESIGN.md.** Typography block (`meta` 13px, `word` 13px, the floor comment), Hierarchy (Meta, Word, Mono lane chips, a new Floor
  line), Components (state pill 13px 700, lane chip mono 13px 600, severity chip mono 13px) and the Lists paragraph (the
  corrected list-order sentence replacing the old one, stage B's two other sentences, and the five sentences of PRD 8). Nothing else.
- **`docs/VIEWER_DISPATCH.md`** states the new GitHub wording, the chart's labels, legend and "ended here" sentences.

## Scenarios, tests and what they assert

Tagged (one screenshot each): `skills-home` (`tests/graph.spec.ts`, root-browser), `type-floor`, `github-wording`, `chart-words`
(`tests/project-workflows/dispatch.spec.ts`).

Untagged: `tests/graph.spec.ts` "the skills home opens the same at 360x640 …", "selecting the Pi source leaves the graph canvas
where it was at 1440x900 / 360x640", "the missing Pi location offers no file operation and reads as unavailable";
`dispatch.spec.ts` "The live chip's watching dot is neutral …", "The Sessions table's header columns line up …", "The run
page's branch is not cut …", "A run row is named by its whole run id …", "The current definition's node labels …";
`tests/unit/typeFloor.test.ts` (new, 8 tests), `tests/unit/dispatch.test.ts` (`PHASE_SHORT`, `phaseLegend`, `endedText`).

### Specs rewritten, and what each now asserts

- `tests/helpers.ts`: `collapseSources`, `openCollapsedGraph`, `expandSourceIfNeeded`, `configuredLocations` and `landingNodeIds`
  (read from the suite's generated `sources.json`, never typed in), `FILE_OPERATIONS`.
- `graph.spec.ts`: "initial view" asserts `visibleNodeIds` equals `landingNodeIds()` (so it fails on the old two-node default),
  the five containment edges (was zero), the source names and the load announcement, as before; "expansion", "dragging", "keyboard"
  (x2) and "outline mode" start from `openCollapsedGraph` and assert what they did; "selecting …" asserts the landing set after a
  selection (was `['Pi','Claude']`) and drops the Pi click; "direct links" asserts the exact set with the Pi locations
  ([L2](a): `:150-153`); "collapsing an ancestor" asserts Claude's locations stay; Reset asserts `landingNodeIds()` and the new
  announcement (the old text appears nowhere).
- `document-history-review.spec.ts` (x4 tests), `document.spec.ts` outline test, `listing-refresh.spec.ts`, `locations.spec.ts`,
  `operations.spec.ts`: expanding a source goes through `expandSourceIfNeeded` / `openCollapsedGraph`. `locations.spec.ts`'s
  "New file/New folder disabled" on an unavailable location now asserts the File operations toolbar is absent;
  `locations.spec.ts` and `operations.spec.ts` "Rename/Move/Delete disabled" on a location or source now assert those buttons are
  absent and New file / New folder are enabled.
- `projects.spec.ts` `projects-navigation` (both phases): `:58` the landing node set equals the Pi and Claude sources plus each
  `SKILL_LOCATIONS` location (by value, never a count); `:59` no File operations toolbar before a selection; after selecting
  the Pi source the toolbar holds exactly New file and New folder, both enabled, and no disabled button. Nothing else in the file changed.
- `dispatch.spec.ts`: `dispatch-overview` (`no GitHub remote`, never `GitHub not read` on the local card) and `dispatch-github`
  (the one-line column and the Local and GitHub card say `no GitHub remote`).
- `tests/unit/dispatch.test.ts`: the `PHASE_SHORT` cases follow the two-letter forms; `phaseLegend` and `endedText` are new cases.

### Root suite: `--list`, base, red, green

`npx --no-install playwright test --config=playwright.config.ts --list` (after `testIgnore`): `Total: 105 tests in 12 files`:
`document-failure` 5, `document-history-review` 6, `document-render` 8, `document-review` 8, `document` 8, `edit-recovery` 18, `edit` 8,
`graph` 14, `listing-refresh` 2, `locations` 7, `operations` 20, `zz-fixtures-clean` 1. No file of `tests/project-workflows`.

- Base (before any change except `testIgnore`): 105 passed (6.1 min), nothing failed at the base.
- Red (new default, tests not yet rewritten): 87 passed, 18 failed: `document-history-review` (4), `document` outline (1), `graph` (9:
  initial view, expansion, selecting, direct links, collapsing, dragging, keyboard x2, outline), `listing-refresh` (1),
  `locations` (2), `operations` Delete (1).
- Green (rewritten): 110 passed (105 + the 5 new graph tests).
- `projects-navigation`, both phases (worker, candidate): old spec on old App: pass / pass; old spec on the new default (red):
  fail / fail at `projects.spec.ts:58` (expected 2 nodes, received 7); rewritten spec on the old App: fail / fail (expected
  nodes missing); rewritten spec on the new App (green): pass / pass.

### How each binding [L] bullet and design note was followed

| Bullet | Done as | Proving test |
|---|---|---|
| [L1](1) short forms | two letters from `PHASES`, legend names each | `chart-words`; `dispatch.test.ts` `PHASE_SHORT`/`phaseLegend` |
| [L1](2) count-only cells | narrow cell shows `<n>`, name and title the sentence | `chart-words` (narrow part) |
| [L2](a) constant expansion, direct links | `INITIAL_EXPANDED` on every load | `graph.spec.ts` "direct links …" and "initial view …" |
| [L2](b) no toolbar for `pi-missing` | toolbar needs an applicable operation | `graph.spec.ts` "the missing Pi location …", `skills-home` |
| [L2](c) group boxes inside the canvas | measured, `FIT_PADDING` unchanged | `skills-home` (on load and after Reset) |
| [L2](d) definition labels in their node | measured | "The current definition's node labels …" |
| [L2](e) one floor property | `--type-floor`; hand-inserted `font-size: 13px`, `0.85rem` and `font: 12px` fail the unit test (tried in `critique.css`, then reverted) | `typeFloor.test.ts` |
| [L4](a) reserved row | `.toolbars` / `.folder-info` reservation | "selecting the Pi source leaves the graph canvas …" (1440x900, 360x640) |
| [L4](b) counts and `unavailable` | names built from `SEEDED_ENTRIES` / `SEEDED_LOCATIONS` | `skills-home` |
| [L3] `projects-navigation` | rewritten as above | `projects.spec.ts` (both phases) |
| Note 1 | `max(<old>, var(--type-floor))` | `typeFloor.test.ts`, `type-floor` |
| Note 2 | Reset fits (`navigate(null)` requests it) | `skills-home` (zoom in twice, Reset) |
| Note 3 | this table | - |
| Note 4 | counts above | `typeFloor.test.ts` + `type-floor` |

### Exempt selectors (the only ones, [G6])

`signal.css`: `.n-chip`, `.n-meta`, `.n-word`, `.n-last` (the run stage's zoomed graph); `App.css`: `.node .label`,
`.node .unavailable-tag`, `.node .empty-tag` (the skills graph's SVG labels). Their sizes did not change. The browser check skips
`[data-testid="run-stage"] .sb-viewport`.

## Checks run

- `npm run build`, `npm run lint`: exit 0. `npm run test:contracts`: 42 passed. `npm run test:unit`: 882 passed (typeFloor 8, dispatch 54).
- `tests/project-workflows` whole config, worker phase: 174 passed, 1 skipped (the suite's own skip). `dispatch.spec.ts` and
  `projects.spec.ts` through `browser-queue` and `check-report`, both phases: 36 passed each; `type-floor`, `github-wording`,
  `chart-words` ok (re-run after the last change). Candidate phase, whole config (before the header-chip change): 173 passed, 2
  failed: `project-collapsed` (six feature headers in the first screen: 4, caused by whole run ids in the header chips; fixed, passes
  in the candidate phase) and `panel.spec.ts` `panel-section` (30 s timeout on a box at load 10; the test takes 26.8 s alone and passes
  with a longer timeout; not edited).
- Root suite whole, `--workers=1 --retries=0`: 110 passed. `graph.spec.ts` through `check-report`: `skills-home` ok (the screenshot
  is attached by path, as the verifier needs a regular file).

## Open items

- M7's filtered state word (needs the unfiltered outcome on `FeatureGroup`): not done.
- M23's dock squeeze: no seeded run reproduces it; the CSS is a guard (see above). Duplicate-key rejection for landed chips is by
  construction (a Set, keyed by sha), not by a seed that lands one sha twice.
- On a window of 360 px a selected unavailable location replaces the two-line hint with a longer one, which still moves the
  canvas; [L4](a) asks for the Pi source only.
- Sentence for `workflow/RUNBOOK.md` (not edited, [O9]): `root-browser` is `env MD_MANAGER_API_PORT=3014 MD_MANAGER_WEB_PORT=5184 npx
  --no-install playwright test --config=playwright.config.ts`; nothing may hold those ports.
- Lane-review P2/P3 findings: none yet.

## c-003 follow-up ([L8])

- `StepChart.tsx`: each non-empty ended-here cell gains `<span className="visually-hidden">` holding the full sentence; `aria-label`, `title` and the aria-hidden spans are kept (design-challenge note 1).
- `dispatch.spec.ts` chart-words narrow loop: the count is read from `.dispatch-en-count`; new `ariaSnapshot()` assertion contains the sentence. Red at 4f2778a markup (received ""), green after; dispatch.spec.ts 26/26 in worker and candidate phases.
