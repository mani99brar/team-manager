---
name: MD Manager Projects viewer (Calm)
description: A quiet, cool-neutral desk for reading workflow runs, where colour is reserved for state.
colors:
  bg: "#f4f6f9"
  surface: "#ffffff"
  surface-2: "#eceff4"
  fg: "#1b2130"
  muted: "#5d6675"
  border: "#dde2ea"
  border-strong: "#c4ccd8"
  accent: "#3454d1"
  accent-fg: "#ffffff"
  accent-soft: "#e6ebfb"
  ok: "#1a6b3e"
  ok-soft: "#dff3e6"
  run: "#1f4fc2"
  run-soft: "#e2eafc"
  warn: "#9a4a05"
  warn-soft: "#fdebd6"
  fail: "#a81e27"
  fail-soft: "#fbe1e3"
  pause: "#7a4e00"
  pause-soft: "#fff1cc"
  idle: "#5b6472"
  idle-soft: "#e9ebef"
  p0: "#a81e27"
  p1: "#a93a06"
  p2: "#4b5563"
  sev-fg: "#ffffff"
  focus: "#d2610c"
  attention: "#b86e00"
  edge: "#8a96a3"
  danger-text: "#8a1f1f"
typography:
  headline:
    fontFamily: "system-ui, \"Segoe UI\", Roboto, sans-serif"
    fontSize: "1.15rem"
    fontWeight: 700
    lineHeight: 1.3
  title:
    fontFamily: "system-ui, \"Segoe UI\", Roboto, sans-serif"
    fontSize: "1rem"
    fontWeight: 600
  body:
    fontFamily: "system-ui, \"Segoe UI\", Roboto, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.45
  body-dense:
    fontFamily: "system-ui, \"Segoe UI\", Roboto, sans-serif"
    fontSize: "0.85rem"
    fontWeight: 400
  label:
    fontFamily: "system-ui, \"Segoe UI\", Roboto, sans-serif"
    fontSize: "13px"
    fontWeight: 600
    letterSpacing: "0.08em"
  chip:
    fontFamily: "system-ui, \"Segoe UI\", Roboto, sans-serif"
    fontSize: "12px"
    fontWeight: 600
  figure:
    fontFamily: "system-ui, \"Segoe UI\", Roboto, sans-serif"
    fontSize: "22px"
    fontWeight: 600
    fontFeature: "\"tnum\""
  mono:
    fontFamily: "ui-monospace, Menlo, Consolas, monospace"
    fontSize: "0.8rem"
    fontWeight: 400
    lineHeight: "20px"
rounded:
  card: "6px"
  small: "4px"
  bar: "2px"
  node: "8px"
  pill: "999px"
spacing:
  "2": "2px"
  "4": "4px"
  "6": "6px"
  "8": "8px"
  "10": "10px"
  "12": "12px"
  "14": "14px"
  "16": "16px"
  "20": "20px"
components:
  chip:
    backgroundColor: "{colors.idle-soft}"
    textColor: "{colors.idle}"
    typography: "{typography.chip}"
    rounded: "{rounded.pill}"
    padding: "1px 9px"
  chip-ok:
    backgroundColor: "{colors.ok-soft}"
    textColor: "{colors.ok}"
  chip-run:
    backgroundColor: "{colors.run-soft}"
    textColor: "{colors.run}"
  chip-warn:
    backgroundColor: "{colors.warn-soft}"
    textColor: "{colors.warn}"
  chip-fail:
    backgroundColor: "{colors.fail-soft}"
    textColor: "{colors.fail}"
  chip-pause:
    backgroundColor: "{colors.pause-soft}"
    textColor: "{colors.pause}"
  severity-chip:
    backgroundColor: "{colors.p2}"
    textColor: "{colors.sev-fg}"
    rounded: "{rounded.small}"
    padding: "1px 6px"
  severity-chip-p0:
    backgroundColor: "{colors.p0}"
    textColor: "{colors.sev-fg}"
  severity-chip-p1:
    backgroundColor: "{colors.p1}"
    textColor: "{colors.sev-fg}"
  card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.fg}"
    rounded: "{rounded.card}"
    padding: "12px 14px"
  run-row:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.fg}"
    rounded: "{rounded.card}"
    padding: "8px 12px"
    height: "44px"
  run-row-hover:
    backgroundColor: "{colors.surface-2}"
  now-banner:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.fg}"
    rounded: "{rounded.card}"
    padding: "8px 12px"
  now-banner-waiting:
    backgroundColor: "{colors.warn-soft}"
    textColor: "{colors.warn}"
  now-banner-running:
    backgroundColor: "{colors.run-soft}"
  now-banner-failed:
    backgroundColor: "{colors.fail-soft}"
    textColor: "{colors.fail}"
  now-banner-paused:
    backgroundColor: "{colors.pause-soft}"
    textColor: "{colors.pause}"
  now-banner-succeeded:
    backgroundColor: "{colors.ok-soft}"
  command-line:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.fg}"
    typography: "{typography.mono}"
    rounded: "{rounded.small}"
    padding: "0 6px"
  section-header:
    textColor: "{colors.muted}"
    typography: "{typography.label}"
  figure:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.fg}"
    typography: "{typography.figure}"
    rounded: "{rounded.card}"
    padding: "10px 12px"
  button:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.fg}"
    rounded: "{rounded.card}"
    padding: "6px 12px"
    height: "36px"
  button-hover:
    backgroundColor: "{colors.surface-2}"
  button-pressed:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.accent-fg}"
  button-small:
    padding: "4px 10px"
    height: "30px"
  filter-button:
    textColor: "{colors.fg}"
    rounded: "{rounded.pill}"
    padding: "4px 12px"
  filter-button-pressed:
    backgroundColor: "{colors.fg}"
    textColor: "{colors.bg}"
  step-chip:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.fg}"
    rounded: "{rounded.pill}"
    padding: "1px 8px"
    height: "22px"
  graph-node:
    backgroundColor: "{colors.idle-soft}"
    textColor: "{colors.fg}"
    rounded: "{rounded.node}"
    width: "136px"
    height: "56px"
  search-field:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.fg}"
    rounded: "{rounded.pill}"
    padding: "4px 12px"
    height: "36px"
---

# Design System: MD Manager Projects viewer (Calm)

## Overview

**Creative North Star: "The Operator's Desk"**

_The qualitative language in this file (the North Star, the descriptive names, the philosophy lines) was inferred by the documenting session on 2026-10-08 from the code and `docs/PRD_VIEWER_REVAMP.md`, and can be revised by the operator._

The Projects viewer is a desk one operator sits at between other work: a cool, neutral surface where every sheet is laid out the same way and nothing competes for the eye except what changed. The look is the "Calm" set of tokens chosen on 2026-10-02 (the "Bold" alternative was removed); it is flat, dense and quiet, so that the few coloured marks on a page are the answer to "what needs me, what failed, what is moving".

Structure comes from sections, weight and hairline borders, never from decoration. Every page is a stack of sections with one small-caps header each, cards and rows with a 4 px stripe in their state's tone, and monospace for identifiers and commands. Colour is a vocabulary of six state tones and three severities, applied identically on chips, stripes, rail dots, graph nodes, step bars and finding cards; the single cool-blue accent is kept for links, focus and pressed controls and never says anything about a run.

Both colour schemes are first-class. The light values in the frontmatter are canonical; the dark scheme redefines every Calm token on the same element with lighter, desaturated tones over a near-black blue surface, and drops the only shadow.

**Key Characteristics:**
- Cool neutral surfaces (page, card, inset) separated by 1 px hairlines; effectively flat.
- One accent hue, never used for state.
- Six state tones plus three severities, each as a strong colour and a soft background pair.
- A 4 px tone stripe on the left of cards, rows and activity groups, and on the top of run and node headers.
- A text glyph or a word repeats every state that colour shows.
- System font stacks only; small uppercase labels for section headers; tabular numbers for times and counts.
- Dense desktop rhythm (2 to 20 px), 44 px tap targets and a single column on phones.

## Colors

A cool, low-chroma neutral base with one blue accent, and a separate semantic palette that carries run state and finding severity.

All Calm colours are CSS custom properties defined on the Projects shell element (`.projects-shell`, the `<main data-testid="projects-workspace">` rendered by `ProjectsView.tsx`), never on `:root`, so the document and skills areas keep the app's own tokens of `src/index.css`. The dark scheme is applied under `@media (prefers-color-scheme: dark)` guarded by `:root:not([data-theme="light"]) .projects-shell`, and again under `:root[data-theme="dark"] .projects-shell`. Inside the shell the older app-wide names alias these tokens (`--text` is `--fg`, `--text-muted` is `--muted`, `--surface-alt` is `--surface-2`). Four tokens the viewer uses are not Calm tokens but app-level ones on `:root` (`focus`, `attention`, `edge`, `danger-text`); they are listed below where they act.

### Primary
- **Desk Blue** (#3454d1): the one accent. Links, the "open run ›" affordance, disclosure summaries, the 2 px focus outline of Calm's own controls, and the pressed state of a toolbar button. In dark it lifts to a soft periwinkle (#7b96ff).
- **Desk Blue Ink** (#ffffff): text on the accent when a button is pressed (`accent-fg`); near-black (#0d1220) in dark.
- **Desk Blue Wash** (#e6ebfb): the accent's soft background (`accent-soft`); a deep indigo wash (#232c4d) in dark. Defined in the token set; no rule uses it today.

### Secondary
The semantic state palette. Each tone is a pair: the strong colour for text, dots, stripes and strokes, and its `-soft` background for chips, banners and node fills. Every strong colour keeps at least 4.5:1 against its own soft background in both schemes (5.0:1 to 6.4:1 light, 6.1:1 to 7.6:1 dark, checked with the WCAG formula of `tone.ts`).
- **Ledger Green** (#1a6b3e on #dff3e6): succeeded. Dark: #5fd08c on #173424.
- **Signal Blue** (#1f4fc2 on #e2eafc): running. Close to the accent in hue but a separate token, used only for the running state. Dark: #86aaff on #1a2746.
- **Needs-You Amber** (#9a4a05 on #fdebd6): waiting on the operator (a question, a pane, an approval) and awaiting approval. Dark: #f5ab5a on #3d2a12.
- **Stop Red** (#a81e27 on #fbe1e3): failed, blocked, a blocking finding. Dark: #ff8b93 on #45191d.
- **Hold Ochre** (#7a4e00 on #fff1cc): paused or interrupted. Dark: #ecc24a on #3b3113.
- **Idle Slate** (#5b6472 on #e9ebef): pending, cancelled, no record, and anything unknown. Dark: #a9b2c2 on #2a3140.

### Tertiary
Review severities, used only on severity chips and finding-card stripes, always with `sev-fg` text on the solid colour.
- **P0 Red** (#a81e27): the same value as Stop Red. Dark: #ff8b93.
- **P1 Rust** (#a93a06): a browner red-orange, distinct from Needs-You Amber. Dark: #f5ab5a.
- **P2 Graphite** (#4b5563): a neutral grey; P2 never reads as an alarm. Dark: #a9b2c2.
- **Severity Ink** (#ffffff): text on a severity chip; near-black (#0d1220) in dark.

### Neutral
- **Cool Paper** (#f4f6f9): the page background (`bg`). Dark: #121620.
- **Sheet White** (#ffffff): cards, rows, banners, the graph box, inputs (`surface`). Dark: #1a1f2b.
- **Inset Grey** (#eceff4): hover on rows and rail items, inline code, the inset tier (`surface-2`). Dark: #232a38.
- **Desk Ink** (#1b2130): all body text and the pressed filter chip's fill (`fg`). Dark: #e8ecf3.
- **Pencil Grey** (#5d6675): secondary text, section labels, time stamps, captions (`muted`), 5.35:1 on the page. Dark: #9aa4b5.
- **Hairline** (#dde2ea): every 1 px card, row, table and section border (`border`). Dark: #2c3444.
- **Rule Grey** (#c4ccd8): the default (idle) stripe, filter-chip and search outlines, button-like pills (`border-strong`). Dark: #3b4556.
- **Edge Grey** (#8a96a3): graph edges and arrowheads (`edge`, app-level, `index.css :root`). Dark: #7c8894.

### App-level signals used inside the shell
- **Focus Orange** (#d2610c): the 3 px dashed or solid focus outline of toolbar buttons, links, graph nodes and disclosure summaries (`focus`, `index.css :root`). Dark: #ffb15c.
- **Attention Amber** (#b86e00): the ring, glyph and badge of a step that waits on the operator, drawn over whatever tone the step has (`attention`, `run.css :root`). Dark: #f0a93b.
- **Warning Ink** (#8a1f1f): legacy error and warning text (`danger-text`, `index.css :root`): a paused challenge headline, load errors. Dark: #ffb3b3.

### Named Rules

**The State-Only Colour Rule.** Colour on a Projects page means state and only state: the six tones and three severities. Structure, grouping and emphasis come from sections, weight and borders, never from a tint.

**The Accent-Is-Not-A-State Rule.** The accent hue is never a tone. A link, a focus ring or a pressed button is blue; a running run is Signal Blue from its own token, and no status ever borrows `accent`.

**The One Mapping Rule.** Every element drawn in a tone takes it from the one mapping in `src/projects/tone.ts` (`statusTone`, `attentionTone`, `severityTone`, `stateTone`); an unknown status is idle, an unknown severity is P2, and an attention wins over a status, so a running run that waits on the operator is Needs-You Amber everywhere.

**The Soft-Pair Rule.** Tone text sits only on its own soft background, at 4.5:1 or better in both schemes. A link on a tinted card takes Desk Ink, underlined, because the accent can fall under 4.5:1 there.

## Typography

**Display Font:** system-ui (with "Segoe UI", Roboto, sans-serif)
**Body Font:** system-ui (with "Segoe UI", Roboto, sans-serif)
**Label/Mono Font:** ui-monospace (with Menlo, Consolas, monospace)

**Character:** One system face for everything, so the page reads like the operator's own desktop; hierarchy comes from size, weight and the uppercase label, and the monospace marks anything the operator might copy or match against a terminal.

The display and body stacks are separate tokens (`--font-display`, `--font-body`) with identical values; no web font is requested. A few older rules spell the monospace stack out with `SFMono-Regular` added (`run.css`, `App.css`); new rules use `--font-mono`.

### Hierarchy
- **Headline** (700, 1.15rem, 1.3): the page title (`h2`): the run id and feature title in the run header, the Runs home heading.
- **Title** (600, 1rem): an `h3` or `h4` inside a node, an activity phase name, a card's summary line.
- **Body** (400, 1rem, 1.45): running text, finding messages, the Now banner headline (at 600).
- **Body Dense** (400, 0.85rem): the most-used size on the viewer: run facts, captions, card context lines, finding fields, section-index links. Close siblings at 0.9rem (card causes, row times, the Now banner) and 0.875rem (Steps table, Activity, buttons) are the same role.
- **Label** (600, 13px, 0.08em, uppercase): section headers, in Pencil Grey. Smaller variants of the same voice: rail titles and day rows (12px, 0.06 to 0.08em), figure labels and finding field labels (11px or 0.75rem, 0.06em).
- **Chip** (600, 12px): status chips, lane chips; status pills elsewhere at 0.8rem.
- **Figure** (600, 22px, tabular numbers): the value of a figure in a node's figures row (blocking, open, checks passed).
- **Mono** (400, 0.8rem, 20px line): commands in the command block, raw event messages. Run ids in rows and cards use the same stack at 0.95rem and 600 to 700; severity chips at 11px and 600.

### Named Rules

**The System Stack Rule.** System font stacks only; no web font request. A new face is a separate decision, not a refinement.

**The Small-Caps Header Rule.** A section is named by one uppercase 13 px Pencil Grey label at 600 with 0.08em tracking, with an optional one-line sub-header of counts and tools pushed right. Section headers are never coloured and never banded.

**The Tabular Numbers Rule.** Times, durations, counts and figures set `font-variant-numeric: tabular-nums` so columns of them align.

## Layout

The viewer is a single scrolling workspace with 16 px padding (10 px at phone width). Runs home, the project page and the feature page use a two-column grid: a sticky project rail (200 to 240 px) and the content, 20 px apart. The run page and node pages hide the rail and run full width: header card, Now banner, lanes line, tabs, then Pipeline and Steps side by side when the board fits the compact graph at its 83 % floor beside a 400 px Steps column (measured in `node/board.ts`, about 1,100 px), stacked otherwise, then Activity grouped by phase.

Cards on Runs home flow in an auto-fill grid of `minmax(min(100%, 320px), 1fr)`; figures in `minmax(150px, 1fr)`; reviewer cards in `minmax(280px, 1fr)`. Lists of rows are flex columns with 4 px gaps; sections stack with 10 px between header and body and 20 px between sections.

Spacing has no token set: the frontmatter `spacing` steps are the rhythm observed in the code (2, 4, 6, 8, 10, 12, 14, 16, 20 px). Gaps of 6 and 8 px dominate; 2 and 4 px separate lines inside a card; 12 to 14 px pad a card; 16 to 20 px separate page regions.

Responsive behaviour:
- **860 px and below:** the rail moves above the content and becomes one horizontal row of pill chips that scrolls inside itself; project facts fold away.
- **760 px and below (phone):** the workflow graph is hidden and the Steps table and step strip become the navigators; run rows stack into three short lines; the run header keeps title, status, span and freshness and folds the rest behind Details; every control grows to a 44 px tap target; a command and its Copy button share one line and the command scrolls sideways inside its box.
- **Steps container under 680 px:** each step row wraps to two lines (container query on the Steps section).
- The page itself never scrolls sideways at any width; wide things (tables, the graph, chip rows, commands) scroll inside their own box.

**The No Page Scroll Rule.** Nothing widens the page: anything wider than the column scrolls inside its own container.

## Elevation & Depth

The system is flat. Depth comes from tonal layering (Cool Paper page, Sheet White cards, Inset Grey for hover and inset) and 1 px Hairline borders. One hairline shadow exists for cards, figures, the run header and the node area in light; the dark scheme sets it to none and relies on the surface steps alone. The inset `box-shadow` rules in the code (the 3 px tone rule before a Steps row, the amber inset on a waiting run row, the current step chip's inner ring) are stripes and rings, not elevation. The only layering is positional: the step strip sticks to the top of a node page (z-index 3) with the section index sticking under it (z-index 2), both on Sheet White with a Hairline bottom border.

### Shadow Vocabulary
- **Hairline lift** (`box-shadow: 0 1px 2px rgba(20, 30, 50, 0.06)`): cards, figures, the run header and the node area in the light scheme. `none` in dark.

### Named Rules

**The Flat Desk Rule.** Surfaces do not lift on hover or focus; hover changes the fill to Inset Grey, focus draws an outline. No new shadow is added for state.

## Shapes

Gently rounded rectangles for containers and fully rounded pills for anything that labels or filters. Cards, rows, banners, figures, the graph box, buttons and activity groups take the one radius token (6 px). Chips, status pills, filter buttons, the search field, lane chips, step chips and the rail at phone width are pills (999 px). Small inset things are 4 px: the severity chip, the command line, section-index links, the activity event button. Step bars are 2 px. Status dots are circles (7 px in a chip, 8 px in a status pill, 9 px in the rail). Graph nodes are 136 by 56 px rectangles with an 8 px corner (112 px wide in the compact board), a 6 px status bar with a 3 px corner on the left edge, a status badge circle of radius 8 on the top-right corner, and an attention ring 5 px outside the node at a 12 px corner.

Borders are 1 px Hairline everywhere; the tone is added as a heavier edge: a 4 px left stripe on cards, run rows, the Now banner and activity groups, and a 4 px top rule on the run and node headers (3 px on phones).

**The Stripe Rule.** A container shows its state as one 4 px edge in its tone (left on cards and rows, top on headers) over a neutral Sheet White body; only the Now banner, blocking cards and chips fill with the soft tone.

**The Dash-For-Executor Rule.** On the workflow graph the outline's dash says who executes a step (solid for an agent, `8 4` for the trusted verifier, `3 3` for the controller) and colour says its status; neither ever carries the other's meaning.

## Components

Restrained and uniform: every component is a neutral sheet with a hairline border, a tone edge or a soft tone fill when it has a state, and a text glyph that repeats it.

### Buttons
- **Shape:** gently rounded (6 px), 1 px Hairline border, minimum 36 px tall and 40 px wide; 44 px at phone width.
- **Default:** Sheet White fill, Desk Ink text at 0.875rem, 6 px by 12 px padding.
- **Hover / Focus:** hover fills Inset Grey; focus draws a 3 px Focus Orange outline 2 px outside. Disabled or busy buttons drop to 50 % opacity (busy ones stay focusable as `aria-disabled`).
- **Pressed (toggle):** Desk Blue fill with white text, for header toggles such as the time zone.
- **Small:** 30 px tall, 4 px by 10 px, 0.8rem; the Copy and More buttons shrink further to 22 px and 0.75rem beside a command or a clamped reason.
- No button on any page acts on a run.

### Filter buttons
- **Style:** pill outline in Rule Grey, transparent fill, inherited text, 4 px by 12 px; a count may follow the label (`Failed 3`).
- **State:** pressed inverts to a Desk Ink fill with Cool Paper text; focus is a 2 px Desk Blue outline. One selected in a filter row; several pressed at once in a toggle row (reviewer, lane, Open only).

### Chips
- **Status chip:** a pill with a 7 px dot in `currentColor`, 12 px 600 text, the tone's colour on its soft fill; idle by default. A `plain` chip drops the dot (lane names, dispositions, "▲ controller not running"). A live running chip pulses its dot (opacity to 0.35 every 1.6 s) only when reduced motion is not requested.
- **Status pill:** the older `StatusBadge` (8 px dot, 0.8rem) restyled to the same tone pairs, everywhere in the shell.
- **Severity chip:** a 4 px-cornered solid block in P0, P1 or P2 with Severity Ink, monospace 11px 600, the severity's name as its text.
- **Step chip:** a pill outline with the tone's border and soft fill, 22 px tall (44 px on phones); the current step adds a Desk Ink inner ring and 600 weight, a waiting step a 2 px Attention Amber ring.

### Cards / Containers
- **Corner Style:** 6 px.
- **Background:** Sheet White; a blocking card fills Stop Red's soft tone.
- **Shadow Strategy:** the hairline lift in light, none in dark (see Elevation & Depth).
- **Border:** 1 px Hairline plus a 4 px left stripe in the card's tone (Rule Grey when idle).
- **Internal Padding:** 12 px by 14 px, 8 px between lines. A card that is a link makes the whole card the tap target and draws a 2 px Desk Blue focus outline.

### Inputs / Fields
- **Style:** the Runs search is a pill (999 px) with a 1 px Rule Grey border on Sheet White, 36 px tall, 4 px by 12 px, up to 360 px wide (full width on phones).
- **Focus:** a 2 px Desk Blue outline, 1 px outside.

### Navigation
- **Project rail:** a sticky column with a "Needs you" entry (Needs-You Amber soft fill and border when something waits), an uppercase rail title, then one 40 px row per project with its name at 600, a 9 px tone dot (its title says the state in words) and muted facts; prefix groups fold under a `<details>` with a 2 px Hairline indent rule. Hover fills Inset Grey. At 860 px and below it becomes a scrolling row of pills.
- **Tabs:** text tabs with a 6 px top corner; the selected tab joins its panel (Sheet White, Hairline border, 600).
- **Step strip:** the sticky row of step chips on node pages, laid out in the graph's column order.

### Section header
One uppercase Pencil Grey label (the Label role), a one-line muted sub-header with counts or the empty state ("nothing waits on you"), and tools pushed to the right (filters, Expand all). No band, no fill, no rule.

### Run row
One link per row, the whole row its 44 px tap target: Sheet White, 1 px Hairline, 4 px tone stripe, 8 px by 12 px. Line one is the status glyph (✓ ✗ ● ○ ‖ in the tone colour, or `?` when waiting), the run id in monospace 600, its context in Pencil Grey and the status pill; the time sits right in tabular numbers; line two is the outcome ellipsised on one line with the full text in its title, the waiting-since time never cut. A run that waits on the operator gets a Needs-You Amber border, an inset amber rule and amber outcome text, while its status pill keeps its own status. Hover fills Inset Grey.

### Now banner and command block
The run page's answer-first strip: 4 px left rule in the situation's tone over that tone's soft fill (Sheet White when idle), 8 px by 12 px, 0.9rem. The headline is 1rem 600 with its glyph first, coloured for failed, blocked, paused and waiting situations. The reason clamps to two lines with a small More button. Under it the command block: "Likely next step" in bold with the RUNBOOK section in Pencil Grey, numbered steps, each command in a 4 px-cornered Sheet White box with a Hairline border, a muted `$ ` prompt that is not selected with the text, monospace 0.8rem on a 20 px line, and a small Copy button beside it that reports "Copied" or "Selected" in muted text; a one-line muted caption closes it.

### Workflow graph node
A 136 by 56 px SVG rectangle with an 8 px corner, filled with its tone's soft colour and stroked 1.5 px in the tone; a 6 px status bar on the left in the tone; the label in 12 px 600 Desk Ink at x 14 (two lines at most); a meta line in 10 px ("Succeeded · attempt 1 · agent"); a badge circle of radius 8 on the top-right corner with the status glyph in the tone. Definition-only nodes stay Sheet White with a muted bar. Selection draws a 3 px Desk Ink outline plus a ring, never the running colour; keyboard focus a dashed 3 px Focus Orange ring; a waiting step a 3 px Attention Amber ring and a `?` badge. The legend has three entries (agent, trusted verifier, controller), one per dash pattern.

### Finding card
A card whose 4 px left stripe takes the severity colour (P0, P1, P2), with a head row of the severity chip, a plain disposition chip (open in amber, resolved in green, accepted idle) and, for an unresolved P0 or P1, a "blocks integration" fail chip. Then the message, then a row of fields (Worker, Reviewer, Requirement) with 0.75rem uppercase Pencil Grey labels. Ordered P0, P1, P2, then lane, then reviewer.

### Steps table and Activity
The Steps table has one 28 px line per step: a 3 px inset tone rule before the step name, a bold glyph, tabular times, and a 10 px bar track in Idle Slate's soft tone with segments in the status colour. Activity groups are `<details>` cards (open by default) with a 4 px tone stripe and a ▸ / ▾ marker; diagnosis and repair rows take Needs-You Amber's soft fill.

**The Glyph Repeats Rule.** Wherever a tone appears, a glyph or a word says the same state: ✓ succeeded, ✗ failed, ● running, ○ pending or cancelled, ‖ paused, ? waiting on the operator, plus the chip text or a dot's title. Colour never carries state alone.

**The Attention Ring Rule.** A step or run that waits on the operator keeps its own status colour and adds Attention Amber on top (a ring, a `?` glyph, an inset rule); the wait is shown, the status is not rewritten.

**The Selection Is Not State Rule.** Selection and the current item are drawn in Desk Ink (a thick outline, an inner ring, 600 weight), never in a tone and never in Signal Blue.

## Do's and Don'ts

### Do:
- **Do** take every colour inside the Projects viewer from the Calm tokens on `.projects-shell`, and define new tokens there with a dark counterpart under both dark selectors.
- **Do** route every state through `tone.ts` and draw it with the tone classes (`tone-ok`, `tone-run`, `tone-warn`, `tone-fail`, `tone-pause`, `tone-idle`, `sev-p0` to `sev-p2`).
- **Do** pair every tone with a glyph or a word, and keep tone text on its own soft background at 4.5:1 or better in both schemes.
- **Do** show a container's state as a 4 px stripe in its tone over Sheet White, and use the soft fill only for chips, the Now banner and blocking cards.
- **Do** name each section with one uppercase 13 px Pencil Grey label, a one-line sub-header and tools on the right.
- **Do** set identifiers and commands in the monospace stack, and give every command its own Copy button outside the command text.
- **Do** keep 44 px tap targets and a single scroll-free column at phone width; let wide content scroll inside its own box.
- **Do** gate any motion behind `prefers-reduced-motion: no-preference`.

### Don't:
- **Don't** use the accent (Desk Blue) for any status, and don't use Signal Blue for anything but running.
- **Don't** tint a surface, header or section for emphasis or grouping; colour is for state only.
- **Don't** let colour carry a state alone, or draw selection in a tone colour.
- **Don't** define Projects tokens on `:root`; the document and skills areas use the same names for their own values.
- **Don't** add shadows for hover, focus or emphasis, and don't add a shadow in the dark scheme.
- **Don't** request a web font or add a second display face.
- **Don't** reuse the graph's dash patterns for anything but the executor.
