# Handoff: Projects viewer revamp, lane `shell` (rail, Runs home, lists, the two looks)

Lane `shell` of workflow runs `viewer-revamp-004` to `viewer-revamp-008` (run 005 restored this lane's owned paths from run 004's candidate `63c9c464` and closed its coverage findings; run 006 restored them from run 005's candidate `09fafd8b` and closed the general reviewer's P2 findings; run 008 restored them from run 006's candidate `9823632c` and closes that run's coverage findings for this lane; see "Run 005", "Run 006" and "Run 007" at the end), implementing [PRD_VIEWER_REVAMP.md](../PRD_VIEWER_REVAMP.md) sections 3, 4 (the look switch and the primitives), 5.1, 5.2 and 5.5, scenarios `revamp-home` and `revamp-look` (section 7). `features/viewer-revamp/decisions.md` binds it. Only owned paths changed. `NowBanner.tsx`, `CommandBlock.tsx` and `LiveStatus.tsx` are **unchanged**: the `LanesLine` DOM the pages lane styles through `:has()` (`ul.run-lanes-list > li[data-lane]`, `span.run-lane-step.status-text-<status>`) and every `live-status` text are as they were. Only the live chip's colours moved to tokens, in `lists.css`. `fixtures/index.ts`, `mock.ts`, `panels.tsx` and every pages-lane file are untouched.

Files changed: `src/App.tsx`, `src/App.css`, `src/projects/ProjectsView.tsx`, `RunsHome.tsx`, `RunRow.tsx`, `lists.ts`, `lists.css`, `theme.css`, `tone.ts`, `ui/index.tsx`, `tests/project-workflows/fixtures/ux-revamp-lists.ts`, `tests/unit/lists.test.ts`. New: `tests/project-workflows/revamp-lists.spec.ts`, `tests/unit/tone.test.ts`, this note.

## What shipped

**Look switch** (`App.tsx`, `App.css`): on Projects routes the header carries a `role="group"` named "Look" with two `aria-pressed` buttons, `Calm` and `Bold`. In the DOM they come *after* Refresh, so `.app-header button` is still Refresh; CSS `order` places them before it. The choice is React state, read once from `localStorage['mdm-look']` through `lookFromStored` (try/catch, default `calm`) and written on change. It is passed to `ProjectsView` as the `look` prop, which sets `data-look` on `main.projects-shell`. Nothing is written on `<html>` or `<body>`. At 760 px and below, the switch shares the roots row, so the header stays two rows (96 px at 390 px, as before).

**Tokens** (`theme.css`): unchanged except:
- Bold-light `--accent` goes from `#c8461c` to `#b23e18`, because links on `--bg` read 4.37:1 and now read 5.28:1.
- Inside the shell, the app-wide names the existing Projects rules use are aliased to the look's tokens (`--text: var(--fg)`, `--text-muted: var(--muted)`, `--surface-alt: var(--surface-2)`), and the shell takes `--font-body`.

Every pair the primitives use measures ≥ 4.5:1 in both looks and both themes. The lowest is Bold-light `--idle` on `--idle-soft` at 4.86.

**`tone.ts`** (additive):
- `TONE_LABEL`, the words for each tone, used as rail dot titles.
- `parseColor` and `contrastRatio` (WCAG 2), used by the `revamp-look` test.
- **Bug fix:** `statusTone` and `attentionTone` looked values up on a plain object, so `'toString'` returned a function instead of `idle`. They now check `Object.hasOwn`.

**`ui/index.tsx`** (additive): `Section` takes an optional `headingId` (the `h2` id and the section's `aria-labelledby`), and `children` is optional. No name or prop was renamed.

**Pure rules** (`lists.ts`, no React, unit-tested):
- `searchRows`: every word of the query must occur in the run id, title, feature, project, served headline or row summary.
- `filterRecent` and `recentCounts` (`all`, `failed`, `succeeded`, `today`; Today is in the reader's zone).
- `dayKey`, `dayLabel` (`Today`, `Yesterday`, `Mar 10`, `Dec 31 2025`), `groupByDay`, `groupByProject`.
- `firstRows` and `RECENT_SHOWN = 10`.
- `projectPrefix`, `railEntries` and `PREFIX_GROUP_MIN = 3`.
- `projectTone`, in this priority: warn if any run waits; else fail if the latest finished run failed; else the most pressing live run's own tone (awaiting approval, running, paused); else ok if the latest finished run succeeded; else idle. A paused-only project shows **Paused**, not Running (review sidecar S-1).
- `NEXT_STEP`, `laneNamesOf` and `recordHomeReadings`.

**Runs home** (`RunsHome.tsx`, `lists.css`): a two-column layout, the rail beside the sections.
- **Rail** (`projects-rail`):
  - The `rail-needs-you` link ("Needs you · N"), outside `projects-list`, jumps to the section.
  - `projects-list` holds one link per project: name, then a `.rail-dot` with `data-tone` and a `title` (plus visually hidden words), then "N features · M runs". M is the runs Runs home read, with `+` when more pages exist.
  - Families of three or more ids sharing the prefix before the last `-` fold into `<details class="rail-group" data-prefix>`, with a summary such as "project-B (3)". It is closed by default and remembered open or closed in `localStorage['mdm-rail-open']`.
  - The read-only note (`projects-info`) moved to the rail's foot. Pages without the rail still show it under the breadcrumb.
- **Needs you** (`needs-you`, a `Section` titled "Needs you · N"; the sub-header says "nothing waits on you" when empty): one `li.ui-card.tone-warn` per `waitingKind` run, with `a[data-run-id][data-status][data-attention]` as its direct child. The link holds, in order:
  - the run id, then a chip naming what waits, and the status badge;
  - the title, feature and project;
  - the row summary, then the served headline (`run-cause`);
  - "Next: answer the question / attend the pane / approve the candidate" (`next-step`), since-when with its age, and "open run ›".
  - It has no command, no `CommandBlock` and no button.
- **Running** (`running-runs`): one card per other live run, toned by `stateTone`. Each card has:
  - the run id and status badge;
  - lane chips named from the workflow definition's `launch_<lane>` nodes (`[data-lane]`, no state claim);
  - "running for 1h00m · started 19:00" (`run-elapsed`);
  - a controller chip only from debounced readings, recorded once per settled poll during render: `controller running` from the served value, `▲ controller not running` only after 15 s.
- **Recent** (`recent-runs`, "Recent · N", sub "finished in the last 7 days"):
  - Tools: a labelled search input `#runs-search` with no form, a `FilterRow` (`All`, `Failed N`, `Succeeded N`, `Today`) and a `Group by project` toggle.
  - Rows are grouped under `.recent-group[data-day]` (or `[data-group]` by project) with a `.recent-group-label`.
  - The first 10 rows show; the rest sit behind `Show older N`, which resets when the search, filter or grouping changes.
  - Rows stay `RunRow`s (`li > a`), now with a tone stripe and the outcome on one ellipsised line with its full text in `title`. Their `<time>` texts and titles are unchanged.
- **Attention** (`lists-errors`, `role="alert"`): one fail-tone card per list that could not be loaded. It replaces the yellow box.
- **Tab title**: "(N) …" while N runs wait.
- **Status pills**: `StatusBadge` is restyled only through `.projects-shell .status-badge.status-*` in `lists.css` (tone soft background and tone text). It is measured by `revamp-look`.

**Project and feature pages** (`ProjectsView.tsx`, `RunsHome.tsx`):
- The project page is a `Section` ("<project>: features", "N features"). Each feature group header is a toned card that keeps `.projects-card-title` and its "id · N runs · N nodes · revision" text, and adds "last run <status> · last activity <age>".
- The feature page is a `Section` ("<feature>: runs", "N runs, newest first") with the lane chips, a run-history strip (one toned glyph chip link per run, `aria-label="Run <id>, <status>"`), then `run-list` (`li` rows, unchanged) and the closed `current-definition` with its "N nodes".
- Neither page has the rail or any registry-wide data; the breadcrumb is their navigation.

## Fixtures (`fixtures/ux-revamp-lists.ts`)

Workflow `ux-revamp-lists` under `alpha-project`, named "Operator desk", lanes `ui` and `adapter`. The spec clock is `REVAMP_NOW = 2026-03-12T20:00:00Z`; every run is dated before 2026-03-13 and every id starts with `desk-`.
- `desk-pane`: running; adapter's pane needs attention. Needs you, `pane`.
- `desk-live-1` and `desk-live-2`: running. The worker mock serves `controller: running` for the first.
- 14 finished runs over Mar 10, 11 and 12: `desk-ok-1..8` succeeded after 40 min, `desk-fail-1..6` failed after 52m51s.

The candidate seed writes the same records. Failed runs follow `ux-lists`' failed runs. Succeeded runs follow `RUN_SUCCEEDED`: lane receipts, snapshots, worker and candidate packets with passing gates, bundle, review, approval and integrated commit. Both phases list them identically.

## Tests

- `tests/unit/tone.test.ts` (new): every status, attention kind and severity maps; unknowns (including `toString`) are idle; attention wins; every tone has a label; `lookFromStored`; `parseColor` and `contrastRatio`.
- `tests/unit/lists.test.ts` (additions): search, filters and counts, day keys and labels, day and project grouping, `firstRows`, prefix grouping with the threshold of three, `projectTone` (paused included), `NEXT_STEP`, `laneNamesOf`, `recordHomeReadings` with the 15 s debounce.
- `tests/project-workflows/revamp-lists.spec.ts`, `[scenario:revamp-home]`:
  - Route overrides: `/api/projects` adds `project-B-1..3`, built from `mockResponse(url)` in the worker phase and `route.fetch()` in the candidate phase; `/api/projects/project-B-*/workflows` answers `{"workflows": []}`.
  - Rail: the entry sits outside `projects-list`; the alpha dot is warn and titled; the folded group opens to three idle, titled dots; no load errors.
  - Needs-you card: `li.ui-card.tone-warn > a`, the name starts with the run id and contains the cause, title and project; `next-step`; no command or button.
  - Running cards: lane chips `ui`, `adapter`; elapsed `1h00m` and `1h30m`; `controller running` in the worker phase only.
  - Recent search: `desk-fail-3` gives exactly one row. Searching `desk-` shows the first 10 own rows, then `Show older 4` shows all 14 under Today, Yesterday and Mar 10.
  - Failed: exactly the own failed runs, and only failed rows. Then, without the search, after Show older: every own failed run and no own succeeded one.
  - Today and Succeeded; Group by project.
  - Show older on the whole list makes every own run visible.
  - Button-text allow-list; `expectNoExecutionControls`.
  - At 390 px: the rail sits above the sections and nothing overflows. The group's open state survives a reload.
- `[scenario:revamp-look]`:
  - Default `calm` with no stored value; the header's first button is Refresh; Calm's section header is transparent.
  - `Bold` sets `data-look="bold"` on the shell and nothing on `<html>` or `<body>`; it is stored. The section header background equals the resolved `--band`, and the Needs-you card background equals `--warn-soft`. The choice survives a reload.
  - For light and dark (`emulateMedia`) × Calm and Bold: every PRD token pair is read through `getComputedStyle(shell)` and must be ≥ 4.5:1 (the band only where it is opaque; Calm's must be transparent). Every rendered `.ui-chip`, `.ui-sev` and `.status-badge` keeps its text and must be ≥ 4.5:1 against its effective background.

## Red, then green

Red, before the change:
- Unit tests: `SyntaxError: … does not provide an export named 'NEXT_STEP'` / `'TONE_LABEL'`.
- After adding only the pure `tone.ts` helpers, the tone tests failed on `statusTone('toString')` (the bug above). The browser spec failed in both phases for the right reason:
  - `getByTestId('projects-rail').getByTestId('rail-needs-you')` → element(s) not found (revamp-home);
  - `getByTestId('projects-workspace')` expected `data-look` `"calm"`, received `""` (revamp-look).

  The fixtures loaded in both phases.

Green, final, all run in this worktree:
- `npm run build`: exit 0. `npm run lint`: exit 0.
- `npx tsx --test tests/unit/tone.test.ts tests/unit/lists.test.ts`: 53 pass, 0 fail. `npm run test:unit`: 352 pass, 0 fail.
- `WORKFLOW_VERIFICATION_PHASE=worker` with `revamp-lists`, `ux-lists`, `projects`, `ux-time`, `ux-run`, `ux-launch`, `lanes` and `reviewers`: **30 passed, 0 failed**.
- `WORKFLOW_VERIFICATION_PHASE=candidate`, same files: 29 passed and 1 failed in my own `revamp-look`. Chips were measured before the reloaded runs rendered. The test now waits for the runs after the reload; `revamp-lists.spec.ts` then passed 2/2 in both phases. Only the test changed after that run.
- `workflow check-report ../policy.json shell <report>` on the worker and candidate `revamp-lists` JSON reports: both "follow the verifier's rules", `revamp-home: ok`, `revamp-look: ok`.

One read-only regression was found and fixed on the way. `ux-run` `[scenario:narrow-run]` failed with the Now banner bottom at 881 px > 844, because the look switch had pushed Refresh onto a third header row at 390 px. The switch now shares the roots row on phones; the banner ends at 830 px.

## Migrations

None. `ux-lists.spec.ts` and `projects.spec.ts` pass unchanged in both phases:
- the Needs-you and Running cards keep `li > a[data-run-id]` with the same attributes and texts;
- `projects-list` keeps two links named "<project> … N features" for every other spec;
- `projects-info` still contains "Read-only";
- `run-list`, `current-definition`, `workflows-list` and `.projects-card-title` are kept.

The `Needs you · N` wording stays, and the empty state moved to the sub-header ("nothing waits on you"). No spec asserted the old sentence.

## Deviations and open assumptions

- **Recent is not a `<table>`.** Its rows stay `li > a` `RunRow`s laid out as a striped grid under day rows. `ux-lists` asserts the `li` parent and the stacked `.run-row-*` parts at 390 px, and PRD 5.1 asks for "an li-equivalent row".
- **Show older wording.** The button reads `Show older N` (the section 8 word plus a trailing count), not "Show N older runs".
- **The project page's features "table"** is the existing feature-group header cards with the last run's chip, the run count and the last activity. There is no separate table, so the links `workflows-list` asserts are not duplicated.
- **Project and feature pages have no rail.** The PRD allows a rail built from data already loaded; I kept the breadcrumb as their navigation instead.
- **The rail's run count** is what Runs home read: pages back to the Recent cutoff, with `+` when more exist. It is not a registry total.
- **Group dot.** A rail group's own dot takes its members' most pressing tone.
- **Legacy colour names follow the look.** Aliasing `--text`, `--text-muted` and `--surface-alt` inside the shell also moves the pages lane's existing colours (`run.css`) to the look's tokens. That is consistent with PRD 4, but it is a visible change on pages this lane does not own.
- **Phone tap target.** On phones the look switch buttons are 34 px tall (44 px wide), so the header stays two rows and the Now banner stays in the first screen.

## Run 005

Run 005 restored every owned path from run 004's candidate (`git checkout 63c9c464 -- <owned paths>`). No product code changed: run 004's coverage findings were test gaps, so this run adds fixtures and tests only. The changed files are `tests/project-workflows/fixtures/ux-revamp-lists.ts`, `tests/project-workflows/revamp-lists.spec.ts` and this note. No `useNow` was added anywhere; `ux-lists.spec.ts` and `projects.spec.ts` are unchanged, so there are no new migrations.

### Fixtures added

- `desk-interrupted`: running, then a controller row "Supervisor interrupted…" at 16:20. It is served `paused` with attention `interrupted`.
- `desk-paused`: the handoff froze and nothing followed. It is served `paused` with attention `paused`.

Both are under `alpha-project` and dated 2026-03-12, before 2026-03-13. In the candidate phase the server derives them from the seeded records, and the worker-phase payloads mirror what the server serves. That includes the paused headline, which the server humanizes to "snapshots captured (worker-reported checks are not trusted)".

The fixtures also export `REVAMP_LATEST_RUN`, the run updated last.

### Findings closed

Each finding below has a test, and each test fails against a mutation that removes the behaviour it covers. Red was taken in the worker phase, and each mutation was reverted afterwards.

| Run 004 finding | Test (in `revamp-lists.spec.ts`) | Red: mutation, then failure |
|---|---|---|
| Attention card has no positive test | "Runs home with a run list that failed to load…". The `ux-revamp-lists` run list answers 500 `{code: revamp_test}`. It asserts `lists-errors` with `role=alert`, "Attention · N" and its sub; one `li.ui-card.tone-fail` naming "Alpha project · ux-revamp-lists" and "The run list could not be read (revamp_test, HTTP 500)"; own runs absent while other lists still render; in Bold the card's background is `--fail-soft` and its text reads at ≥ 4.5:1. | Card toned `warn` → `Expected /\bui-card\b.*\btone-fail\b/, Received "ui-card tone-warn home-card home-error"` |
| Empty Needs-you state untested | "Runs home with nothing waiting…". Every run list is rewritten without `waitingKind` runs. It asserts heading "Needs you · 0", sub-header "nothing waits on you", no card, rail "Needs you · 0", no "(N)" tab prefix, while Running still lists `desk-live-1`. | Sub text changed → `Expected "nothing waits on you", Received "all clear"` |
| Paused/interrupted Running cards untested | `[scenario:revamp-home]`: `desk-interrupted` (4h00m) and `desk-paused` (3h30m) are Running cards with `data-status=paused`. Each is `ui-card tone-pause` and no other tone, with a "Paused" status badge, lane chips, "paused · 4h00m" or "paused · 3h30m", and the summary "Paused at Freeze worker handoffs · <cause>". They are absent from Needs you and Recent. No own failed run is a Running card. | Running tone forced to `run` → `desk-interrupted: Expected /tone-pause/, Received "ui-card tone-run home-card"` |
| 5.2 project and feature additions untested | "Project and feature pages (PRD_VIEWER_REVAMP 5.2)…" asserts:<br>• the feature card's "last run <label>" equals `REVAMP_LATEST_RUN` (badge `data-status` and card tone);<br>• no rail on either page;<br>• lane chips `ui`, `adapter`;<br>• one history chip per run with glyph, `title` "<id> · <label>", name "Run <id>, <label>" and tone, in the same order as `run-list`;<br>• the definition is closed with runs and open on `empty-flow`, with no strip there;<br>• every rendered chip (history, lane, status badge) is ≥ 4.5:1 in Calm/Bold × light/dark. | • aria-label removed → `desk-pane … element(s) not found`<br>• `open={false}` → `Expected true, Received false`<br>• lanes hidden → `toHaveText` failed<br>• history chip colour `#bbb` → `calm light: "●" (… run-history-chip) … Received 1.59`<br>• `latestRun` picking the oldest → `Expected /^last run Running · …/, Received "last run Failed · …"` (review sidecar S-1) |
| Dark theme never confirmed | `[scenario:revamp-look]`: after `emulateMedia`, `matchMedia('(prefers-color-scheme: dark)')` matches the scheme. In each look, `--bg`, `--fg`, `--surface` and the shell's painted background differ between light and dark, the dark `--bg` is darker and the dark `--fg` lighter. | Both dark `@media` blocks disabled → `calm: bg changes with the theme — Expected: not "#f4f6f9"`. Before this run, the same mutation left `revamp-look` green. |
| Storage guard untested | "The look switch keeps working when storage throws…": a stored `neon` reads Calm, and Bold then stores `bold`. With `Storage.prototype.getItem/setItem` throwing (`SecurityError`), the page renders Calm although `bold` is stored, the switch still moves Calm→Bold→Calm, and there are no page errors. | try/catch removed → app fails to render (`projects-workspace` not found); `lookFromStored` bypassed → `Expected "calm", Received "neon"` |

### Checks run in this worktree (final state)

- `npm run build`: exit 0. `npm run lint`: exit 0.
- `npx tsx --test tests/unit/tone.test.ts tests/unit/lists.test.ts`: 53 pass, 0 fail. `npm run test:unit`: 352 pass, 0 fail.
- Both phases with `--reporter=json`, on `revamp-lists`, `ux-lists`, `projects`, `ux-time`, `ux-run`, `ux-launch`, `lanes` and `reviewers` (the last four read-only): **34 passed, 0 failed**. `check-report ../policy.json shell`: `revamp-home: ok`, `revamp-look: ok`, "follow the verifier's rules".
- After review sidecar S-1's fix, `revamp-lists`, `ux-lists` and `projects` were rerun in both phases: 18 passed, 0 failed, and `check-report` ok in both.

### Deviations and assumptions (run 005)

- **No Running card for "failed before finishing".** The served data has no such card: a failed run is finished (`lists.ts` `FINISHED`) and lists in Recent. The Running tones asserted are pause (paused) and pause (interrupted).
- **The four new tests are untagged.** They carry no `[scenario:…]` title because each scenario id must appear in exactly one test. The verifier's browser check runs the whole config, so they gate the lane all the same.
- **The Attention route answers its error directly in both phases.** It reads no original body, so neither `mockResponse` nor `route.fetch()` is used. The empty-Needs-you route builds on `mockResponse(url)` in the worker phase and on `route.fetch()` in the candidate phase.
- **The read-only check of `ux-time`, `ux-run` and `ux-launch` ran against this worktree's copy of the pages lane's files.** That copy is the base, not the pages lane's run 005 work. The combined candidate is where they meet.

## Run 006

Run 006 restored every owned path from run 005's candidate (`git checkout 09fafd8ba80b477b09162ddc09dbb250c808a512 -- <owned paths>`) and closes the three findings the general reviewer's file listed for this lane. No `useNow` was added; times still come from the list clock. `ux-lists.spec.ts` and `projects.spec.ts` are unchanged, so there are no new migrations.

Files changed in this run: `src/projects/lists.ts`, `RunsHome.tsx`, `RunRow.tsx`, `lists.css`, `ui/index.tsx`, `tests/unit/lists.test.ts`, `tests/project-workflows/revamp-lists.spec.ts`, this note. New: `src/projects/ui/props.check.ts`.

### Findings closed

| General review finding (run 005) | Fix | Test, and its red |
|---|---|---|
| A paused or interrupted Running card read "paused · 4h00m", which says "paused for 4h" when it is the age since creation. | New pure `cardElapsed(run, now)` in `lists.ts`. A running run says "running for 4h00m". A live run that stopped says "paused · started 4h00m ago" and, when the served attention carries `since`, "since 16:20" (`.home-card-since`) instead of the start time. A finished run has no line. | `lists.test.ts` "a Running card names a stopped run's age as since it started…" (red: `SyntaxError … does not provide an export named 'cardElapsed'`). `[scenario:revamp-home]`: `desk-interrupted` reads "paused · started 4h00m ago" and "since 16:20"; `desk-paused` reads "paused · started 3h30m ago" and "since 17:00". Red against run 005's code: `Expected "paused · started 4h00m ago", Received "paused · 4h00m"`. |
| `FilterToggles` intersected `onToggle: (id, pressed) => void` with the `div`'s DOM `onToggle`, so a correctly typed handler did not compile (the pages lane worked around it with `(id: unknown, on?: unknown)`). | `FilterToggles` now takes `Omit<DivProps, 'onToggle'>`. `FilterRow` had the same defect with the DOM `onSelect` and now takes `Omit<DivProps, 'onSelect'>`. No name or prop was renamed. | `src/projects/ui/props.check.ts`, compile-time assertions read by `tsc -b` in `npm run build`: the `onToggle` prop type equals `(id: string, pressed: boolean) => void`, and `onSelect` equals `(id: string) => void`. Red against run 005's code: `TS2344: Type 'false' does not satisfy the constraint 'true'` on both lines. I also typechecked the run 005 candidate's whole `src` with this run's shell files overlaid: `tsc -p tsconfig.app.json` exit 0. The pages lane's `(id: unknown, on?: unknown)` handler stays assignable, so the combined candidate compiles; that lane can now drop its workaround. |
| On desktop rows waiting on the operator, the trailing " · since <time>" was the first text the ellipsis cut, and the `title` held only the summary. | `RunRow`'s `.run-row-detail` is a flex line. The outcome is in `.run-row-summary`, which ellipsises and carries the `title`. The since time is in `.run-row-since` (`flex: none`) and is never cut. On phones (≤ 760 px) both wrap as before. Text content and accessible names are unchanged. | "Project and feature pages…" test: the run list is narrowed to 340 px with a test style tag, keeping the desktop layout. The `desk-pane` row's `.run-row-since` reads " · since 17:10", its summary is truncated (`scrollWidth > clientWidth`), the since box ends inside the detail box, and the summary's `title` holds the full outcome. Red against run 005's code: `.run-row-since` element(s) not found. Mutation red, with the since span moved back inside the ellipsised span: `the since time is not clipped — Expected <= 383.48, Received 424.48`. |

My own spec's assertion of the row title moved from `.run-row-detail[title]` to `.run-row-summary[title]`, with the same `/^Failed at Verify ui/`. That spec belongs to this lane, so this is not a section 8 migration.

### Checks run in this worktree (final state)

- `npm ci` first: the worktree had no `node_modules`.
- `npm run build`: exit 0. `npm run lint`: exit 0.
- `npx tsx --test tests/unit/tone.test.ts tests/unit/lists.test.ts`: 54 pass, 0 fail. `npm run test:unit`: 353 pass, 0 fail.
- Both phases, `--reporter=json`, on `revamp-lists`, `ux-lists`, `projects`, `ux-time`, `ux-run`, `ux-launch`, `lanes` and `reviewers` (the last five read-only): worker 34 expected, 0 unexpected; candidate 34 expected, 0 unexpected.
- `check-report ../policy.json shell`:
  - candidate report: `revamp-home: ok`, `revamp-look: ok`, "follow the verifier's rules".
  - worker report: refused at first, because the candidate run had cleared `test-results/` and the worker screenshots were gone. I reran the worker phase on `revamp-lists`, `ux-lists` and `projects` (18 passed); its report then gave `revamp-home: ok`, `revamp-look: ok`, "follow the verifier's rules".

### Deviations and assumptions (run 006)

- **Wording of a stopped card.** It reads "paused · started 4h00m ago · since 16:20". When `since` is served, the start clock time gives way to it; without `since`, it reads "· started <time>". This follows the reviewer's first suggestion. I did not use a pause duration, because the served data has no pause start other than attention `since`.
- **The read-only checks of the pages lane's specs ran against this worktree's base copy of that lane's files**, as in run 005.

## Run 007

Run 006's candidate (`9823632c`, tag `workflow/viewer-revamp-006-candidate`) was blocked by its coverage reviewer. Run 007 did not produce a candidate of its own, so this work was done in run `viewer-revamp-008`. The base branch already carried `theme.css`, `tone.ts`, `ui/index.tsx` and `ui/props.check.ts` from that candidate. I restored every other owned path from it (`git checkout 9823632c149b22d5bdb2f3684c191f492090c254 -- <owned paths>`) and closed the seven findings run 006's coverage reviewer raised for this lane. The P1 (the step strip) is in the pages lane.
- No `useNow` was added; every time still comes from the list clock.
- `ux-lists.spec.ts` and `projects.spec.ts` are unchanged, so there are no new section 8 migrations.

Files changed in this run:
- Product: `src/projects/lists.ts`, `RunsHome.tsx`, `ProjectsView.tsx`, `lists.css`.
- Tests and fixtures: `tests/project-workflows/fixtures/ux-revamp-lists.ts`, `tests/project-workflows/revamp-lists.spec.ts`, `tests/unit/lists.test.ts`.
- This note.

### New fixture: `desk-held`

`desk-held` is a paused run served **without** `attention.since`. It is under `alpha-project`, created 2026-03-12 15:00. Both lanes launched (their receipts are the evidence) and nothing followed: no handoff row, no next step, no tasks.

The server then pauses the run by its fallback rule. No step is failed, paused, awaiting or running, so there is no focus. It serves `status: paused`, `attention: { kind: 'paused', node_id: null, since: null }`, `last_activity_at` 15:00:14 and headline "Launch adapter worker · waiting for the worker's completion signal (idle is not acceptance)". I read those values from the candidate-phase server with a throwaway probe, since removed. The worker-phase payload mirrors them.

**How `waitingKind` treats it.** `waitingKind` only counts `question`, `pane` and `approval`, so the run is not in Needs you. It is a Running card in the pause tone. This is asserted in `[scenario:revamp-home]` and in the unit test "a paused run served without attention.since waits on nobody".

Adding the run moves three numbers, each derived from the fixture's own exports, so no other spec's count changed:
- The feature now has 20 runs (`REVAMP_OWN_RUNS`).
- The history map has one more Paused chip.
- `OWN` has 20 ids.

`REVAMP_LATEST_RUN` is still `desk-live-1`.

### Findings closed

| Run 006 coverage finding | Fix | Test, and its red |
|---|---|---|
| A stopped Running card without `since` read "paused · started 4h00m ago · started 16:00". | `cardElapsed` now returns `started`: the start time a card adds after the line, for a **running** run only. A stopped run's line already says when it started, so without `since` nothing follows it. A running card still reads "running for 1h00m · started 19:00". | `lists.test.ts`: the paused-without-since case gives `started: null`, and a running run gives `started: created`. Red: `expected … started: '2026-03-12T16:00:00Z'`, actual had no `started`. `[scenario:revamp-home]` checks the `desk-held` card: `.home-card-when` is exactly "paused · started 5h00m ago", with no `time` and no `.home-card-since`. The running cards' full line now includes the start time. Mutation red (old fallback restored): `Expected "paused · started 5h00m ago", Received "paused · started 5h00m ago · started 15:00"`. |
| The Runs home sections were not named regions. | `headingId` on each Runs home `Section`: `needs-you-title`, `running-title`, `recent-title`, `attention-title`. | `[scenario:revamp-home]`: `getByRole('region', { name: /^Needs you · \d+$/ })`, then the same for Running and Recent; each has count 1 and the expected `data-testid`. The Attention tests use `getByRole('alert', { name: /^Attention · \d+$/ })`; `role="alert"` replaces the region role, and the heading names it. Red against `9823632c`: `Error: needs-you … toHaveCount: Expected 1, Received 0`, and `lists-errors` element(s) not found. |
| No test asserted that no web font is requested. | None: the product already uses system stacks. | New test "No web font…", on Runs home, the project page and the feature page, in Calm and Bold. It checks four things:<br>• `page.on('request')` sees nothing matching `fonts.googleapis`, `fonts.gstatic` or `.woff`/`.woff2`, and no request of type `font`;<br>• `document.fonts` is empty after `document.fonts.ready`;<br>• no `CSSFontFaceRule` is in any stylesheet, nested rules included;<br>• no `link[href]` mentions font.<br>Mutation red (an `@font-face` with a `.woff2` source used by the section headings, added to `theme.css`): `/projects in calm` failed on the declared faces. |
| The Needs-you card's since/age line was not asserted. | None: the behaviour already shipped. | `[scenario:revamp-home]`: `desk-pane`'s `.home-card-when` reads exactly "since 17:10 · 2 h ago", and its `time` has `datetime="2026-03-12T17:10:00Z"`. Mutation red (age removed): `Expected "since 17:10 · 2 h ago", Received "since 17:10"`. |
| The narrow rail was not checked as a row of chips. | At ≤ 860 px the project list is one row that does not wrap (`flex-wrap: nowrap`, `overflow-x: auto`). An open group's projects follow its summary on the same row. `contain: inline-size` keeps the row from sizing the page. `position: relative` keeps the absolutely positioned visually hidden words inside the scroller; without it they widened the page by 453 px, which the test caught. | `[scenario:revamp-home]` at 390 px, with the project-B group open:<br>• each `projects-list` entry's left is greater than the one before;<br>• Needs you plus the entries have at most two distinct tops;<br>• the list's `overflow-x` is `auto` and its `scrollWidth` is greater than its `clientWidth`, so the row scrolls inside the rail;<br>• the list's right edge is ≤ 390;<br>• the page has no sideways overflow.<br>Mutation red (run 006's wrapping CSS): `entry 2 lies right of entry 1 — Expected > 192.89, Received 23`. |
| The Attention card was tested for HTTP 500 with a JSON body only. | None: the behaviour already shipped. | Three new tests, one per failure, each on the same fail-tone card in both phases, with the exact message:<br>• `route.abort('connectionrefused')` → "The API could not be reached. Check that the server is running, then retry.";<br>• a 502 `text/html` page → "The API responded with status 502. (HTTP 502)";<br>• a 200 `text/plain` body → "The API returned data that does not match the projects contract: the response body is not JSON."<br>Mutation red (the card's text fixed to "The list could not be loaded."): all three failed with their expected message. |
| Nothing asserted the reviewers in the feature header card. | The feature page now shows a "Review" line beside "Lanes": one chip per `review`-kind node of the definition (`reviewStepsOf`, pure, in `lists.ts`), e.g. "Independent review", or "Design challenge" and "Independent review" on a guarded graph. | `lists.test.ts` "the review steps a feature declares…": red `does not provide an export named 'reviewStepsOf'`. The 5.2 browser test asserts `.feature-reviews` contains "Review" and its `.review-step-chip`s read `['Independent review']`; the chip is also in the 4.5:1 loop over both looks and both themes. Red against `9823632c`: `.feature-reviews` element(s) not found. |

### Checks run in this worktree (final state)

- `npm ci` first: the worktree had no `node_modules`.
- `npm run build`: exit 0. The first attempt failed with TS2304/TS2584 because the browser-side code in the new tests used DOM names the spec tsconfig does not include. It now uses `ownerDocument.defaultView`, plus a string `page.evaluate` for the font scan. `npm run lint`: exit 0.
- `npx tsx --test tests/unit/tone.test.ts tests/unit/lists.test.ts`: 56 pass, 0 fail. `npm run test:unit`: 355 pass, 0 fail.
- Both phases with `--reporter=json`, on `revamp-lists`, `ux-lists`, `projects`, `ux-time`, `ux-run`, `ux-launch`, `lanes` and `reviewers` (the last five read-only):
  - worker: 38 expected, 0 unexpected, 0 flaky;
  - candidate: 38 expected, 0 unexpected, 0 flaky.
- `check-report ../policy.json shell` on each phase's report, run straight after that phase: `revamp-home: ok`, `revamp-look: ok`, "follow the verifier's rules".
- The red runs and mutation reds are in the table above. They were run in the worker phase with `-g`, and each mutation was reverted afterwards.

### Deviations and open assumptions (run 008)

- **The feature header names its review steps, not reviewer ids.** PRD 3 says "reviewers". A feature's reviewer ids (for example `general` and `coverage`) are recorded only in each run's review result (`/review` of a run). The definition has a single `review` node whatever the reviewers, and the run list's `activity` does not carry them either. Showing the ids would need one review fetch per run on the feature page, which the lists' data rule forbids (served activity only, no per-run fetch). So the header shows the review steps the definition declares, labelled "Review". The run's review page shows the reviewers, and that page belongs to the pages lane. A future served field (for example the reviewer ids in the definition or in `activity`) would let the header show them. Review sidecar S-1 asked for this to be recorded.
- **A stopped card with no `since` shows no start time after its line.** It reads "paused · started 5h00m ago" and nothing else. I chose to drop the start time rather than reword it to "· at <time>", because "at 15:00" would read as the stop time, which the served data does not have.
- **The "at most two distinct tops" bound** covers Needs you on its own line above the row of project chips; the chips themselves share one top.
- **The no-web-font mutation red failed on the declared `@font-face` first.** The request listener is asserted at the end of the same test, so a font request with no `@font-face` (for example a preload link) is still caught.
- **The read-only checks of the pages lane's specs** (`ux-time`, `ux-run`, `ux-launch`, `lanes`, `reviewers`) ran against this worktree's base copy of that lane's files, as in runs 005 and 006.
- **Look switch on phones stays 34 px tall (review sidecar S-2, new-1).** This is the run 004 deviation "Phone tap target", kept as it was. The sidecar suggested 44 px. Run 004 measured that ux-run `[scenario:narrow-run]` (pages lane) requires the Now banner to end at or above 844 px at 390 px. With a 34 px switch it ends at 830 px, so a 44 px switch would leave about 4 px of margin on a scenario this lane does not own. The time-zone toggle keeps 44 px. The operator should decide whether to give the switch 44 px once a look is chosen and one of the two buttons goes away.
