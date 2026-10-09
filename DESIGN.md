---
name: MD Manager Projects viewer (Signal Box)
description: A warm-grey signal box where the run's graph is the page, a small live dock holds the answer, and colour is reserved for state.
colors:
  bg: "#e9ebe6"
  grid: "#d5d9d1"
  surface: "#fbfbf8"
  surface-2: "#f1f2ee"
  fg: "#151b18"
  muted: "#545e58"
  border: "#c8cdc4"
  border-strong: "#a3aaa0"
  edge: "#7d8780"
  edge-soft: "#b8beb5"
  accent: "#5a3ec8"
  accent-fg: "#ffffff"
  accent-soft: "#e7e2fb"
  focus: "#5a3ec8"
  attention: "#c27100"
  ok: "#17663b"
  ok-soft: "#d9f0e1"
  run: "#1d4fc4"
  run-soft: "#dde7fb"
  warn: "#8f4700"
  warn-soft: "#fde6cc"
  fail: "#a51d27"
  fail-soft: "#fadcdf"
  pause: "#714a00"
  pause-soft: "#fbedc4"
  idle: "#56606c"
  idle-soft: "#e4e6e9"
  p0: "#a51d27"
  p1: "#a33806"
  p2: "#4b5563"
  sev-fg: "#ffffff"
typography:
  headline:
    fontFamily: "\"Atkinson Hyperlegible Next\", system-ui, \"Segoe UI\", Roboto, sans-serif"
    fontSize: "20px"
    fontWeight: 700
    lineHeight: 1.2
  run-id:
    fontFamily: "\"Atkinson Hyperlegible Mono\", ui-monospace, Menlo, Consolas, monospace"
    fontSize: "16px"
    fontWeight: 700
    letterSpacing: "-0.01em"
  title:
    fontFamily: "\"Atkinson Hyperlegible Next\", system-ui, \"Segoe UI\", Roboto, sans-serif"
    fontSize: "15.5px"
    fontWeight: 700
    lineHeight: 1.2
  body:
    fontFamily: "\"Atkinson Hyperlegible Next\", system-ui, \"Segoe UI\", Roboto, sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.4
  body-dense:
    fontFamily: "\"Atkinson Hyperlegible Next\", system-ui, \"Segoe UI\", Roboto, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.4
  meta:
    fontFamily: "\"Atkinson Hyperlegible Next\", system-ui, \"Segoe UI\", Roboto, sans-serif"
    fontSize: "12.5px"
    fontWeight: 400
  word:
    fontFamily: "\"Atkinson Hyperlegible Next\", system-ui, \"Segoe UI\", Roboto, sans-serif"
    fontSize: "12px"
    fontWeight: 700
    letterSpacing: "0.02em"
  label:
    fontFamily: "\"Atkinson Hyperlegible Next\", system-ui, \"Segoe UI\", Roboto, sans-serif"
    fontSize: "13px"
    fontWeight: 600
    letterSpacing: "0.08em"
  mono:
    fontFamily: "\"Atkinson Hyperlegible Mono\", ui-monospace, Menlo, Consolas, monospace"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.5
rounded:
  card: "8px"
  node: "10px"
  control: "10px"
  panel: "12px"
  small: "4px"
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
  "24": "24px"
components:
  step-card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.fg}"
    rounded: "{rounded.node}"
    width: "232px"
    height: "136px"
    padding: "11px 14px 9px"
  step-card-pending:
    backgroundColor: "{colors.surface-2}"
  live-dock:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.panel}"
    width: "312px"
  step-sheet:
    backgroundColor: "{colors.surface}"
    width: "440px"
  identity-line:
    backgroundColor: "{colors.surface}"
    padding: "8px 14px"
  state-pill:
    backgroundColor: "{colors.idle-soft}"
    textColor: "{colors.idle}"
    typography: "{typography.word}"
    rounded: "{rounded.pill}"
    padding: "3px 10px 3px 7px"
  chip:
    backgroundColor: "{colors.idle-soft}"
    textColor: "{colors.idle}"
    rounded: "{rounded.pill}"
    padding: "1px 9px"
  severity-chip:
    backgroundColor: "{colors.p2}"
    textColor: "{colors.sev-fg}"
    rounded: "{rounded.small}"
    padding: "1px 6px"
  stage-control:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.control}"
    height: "44px"
  open-page-button:
    backgroundColor: "{colors.fg}"
    textColor: "{colors.bg}"
    rounded: "{rounded.control}"
    height: "48px"
  command-line:
    backgroundColor: "{colors.surface-2}"
    textColor: "{colors.fg}"
    typography: "{typography.mono}"
    rounded: "{rounded.card}"
    padding: "9px 10px"
---

# Design System: MD Manager Projects viewer (Signal Box)

## Overview

**Creative North Star: "The Signal Box"**

_Replaced on 2026-10-09 by the operator's redesign (design 4, "Signal Box Live", of the run-page direction set). The Calm look of 2026-10-02 is the anti-reference: its page of stacked sections is gone from the run page; its product truths (read-only, recorded evidence only, colour means state) stay._

The Projects viewer is a signal box: one operator looks over the track diagram of a run and sees, at a glance, where every train stands. The run's graph is the page. It fills the window under one identity line, pans and zooms like a map, and tells more the closer you get: chips of label and state far out, a card with the step's word, kind, lane and duration at arm's length, the last event up close. Everything else is a small panel on the stage: the live dock in the top-left corner with the run's situation and the next command, and a sheet that slides in from the edge when a step is opened. The home, project and feature pages keep their lists and rails; they take the new ground, faces and tones without changing layout.

The ground is a warm grey under a faint dot grid that moves with the picture, so the eye reads motion as the stage, not the page. Surfaces are an off-white sheet with a hairline rule. One violet accent marks selection, focus and links and says nothing about a run. State is a vocabulary of six tones and three severities, each with a strong colour and a soft fill, drawn on cards, pills, glyphs, dock rows and finding lines alike, and always repeated by a drawn glyph (tick, play, question diamond, crossed square, pause bars, dotted ring) and a word.

The faces are Atkinson Hyperlegible Next for text and Atkinson Hyperlegible Mono for identifiers and commands, self-hosted; the system stack stands in until they load. Numerals are tabular throughout.

**Key Characteristics:**
- The graph is the page: a full-bleed pan and zoom stage with three detail levels, keyboard-walkable.
- Panels, not sections: the identity line, the live dock and the step sheet are the only chrome on the run page.
- A warm, low-chroma ground with a dot grid; off-white sheets; hairline rules; one violet accent.
- Six tones and three severities as strong/soft pairs, each repeated by a drawn glyph and a word.
- Two hyperlegible faces, self-hosted; tabular numerals; lower-case state words.
- 44 px controls, a bottom sheet and a top-to-bottom flow on phones; both colour schemes.

## Colors

All tokens live on `.projects-shell` (`<main data-testid="projects-workspace">` in `src/projects/ProjectsView.tsx`), never on `:root`, so the document and skills areas keep the app's own tokens; the dark scheme redefines every token under `@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) .projects-shell }` and `:root[data-theme="dark"] .projects-shell`. Inside the shell the app-level names alias these tokens (`--text`, `--text-muted`, `--surface-alt`, `--danger-text`, `--focus`, `--attention`, `--edge`).

### Primary
- **Signal Violet** (#5a3ec8): the accent. Links, the hot edge of a selected step, the selection ring, the focus outline of every Projects control, the pressed time-zone toggle. Dark: #a995ff.
- **Violet Ink** (#ffffff): text on the accent (`accent-fg`). Dark: #0d1210.
- **Violet Wash** (#e7e2fb): the accent's soft fill, for text selection. Dark: #2a2347.

### Secondary
The state palette. Each tone is a pair: the strong colour for text, glyphs, bands and strokes, and its soft fill for pills and the dock's Now banner. Every strong colour keeps at least 5.1:1 on its own soft fill and 5.3:1 on the ground in light, 6.5:1 and 8.3:1 in dark (checked with `contrastRatio` of `tone.ts` on 2026-10-09).
- **Clear Green** (#17663b on #d9f0e1): succeeded, applied, a return mark. Dark: #62d08f on #163323.
- **Running Blue** (#1d4fc4 on #dde7fb): running. Dark: #89abff on #19264a.
- **Needs-You Amber** (#8f4700 on #fde6cc): a question, a pane, an approval, awaiting approval. Dark: #f6ad5c on #3c2811.
- **Stop Red** (#a51d27 on #fadcdf): failed, blocked, a blocking finding. Dark: #ff8a92 on #44181c.
- **Hold Ochre** (#714a00 on #fbedc4): paused, interrupted. Dark: #ecc24a on #392f12.
- **Idle Slate** (#56606c on #e4e6e9): pending, cancelled, not recorded. Dark: #a9b2bf on #262d33.
- **Attention Ring** (#c27100): the 3 px ring around a card that waits on the operator, over its own tone. Dark: #f0a23b.

### Tertiary
Severities, on severity chips only, with `sev-fg` text: **P0 Red** (#a51d27), **P1 Rust** (#a33806), **P2 Graphite** (#4b5563); dark #ff8a92, #f6ad5c, #a9b2bf with near-black text.

### Neutral
- **Ground** (#e9ebe6): the page and the stage (`bg`). Dark: #0f1312.
- **Grid** (#d5d9d1): the stage's dots. Dark: #1c2320.
- **Sheet** (#fbfbf8): cards, the dock, the sheet, the identity line, the home's rows (`surface`). Dark: #171c1a.
- **Inset** (#f1f2ee): a pending card, the sheet's fact tiles, hover (`surface-2`). Dark: #1e2522.
- **Ink** (#151b18): text, the open-page button's fill (`fg`). Dark: #e6ebe7.
- **Pencil** (#545e58): secondary text, labels, times (`muted`). Dark: #9ba7a0.
- **Hairline** (#c8cdc4): every 1 px rule (`border`). Dark: #2b3430.
- **Rule** (#a3aaa0): card outlines and control borders (`border-strong`). Dark: #3e4944.
- **Track** (#7d8780) and **Track Soft** (#b8beb5): graph edges and their arrowheads; the soft one, dashed, leads to a step that has not started (`edge`, `edge-soft`). Dark: #7f8b85, #3b4641.

### Named Rules

**The State-Only Colour Rule.** Colour on a Projects page means state and only state: the six tones and the three severities. Structure comes from panels, weight and rules.

**The Accent-Is-Not-A-State Rule.** Signal Violet marks selection, focus and links; no status borrows it, and Running Blue is its own token.

**The One Mapping Rule.** Every element drawn in a tone takes it from `src/projects/tone.ts`; an attention wins over a status, so a running step that waits on the operator is amber everywhere.

**The Glyph Repeats Rule.** Wherever a tone appears, the drawn glyph of `signal/Glyph.tsx` (or a status word) says the same state: tick, play, question diamond, crossed square, pause bars, dotted ring. Colour never carries state alone.

## Typography

**Display and body:** Atkinson Hyperlegible Next (`--font-display`, `--font-body`). **Mono:** Atkinson Hyperlegible Mono (`--font-mono`). Both self-hosted from `public/fonts/` (variable weight, latin subset, SIL OFL 1.1), declared in `src/projects/theme.css` with `font-display: swap`; the system stack is the fallback.

**Character:** a face built to be told apart at a glance, so that lane ids, commits and commands read right the first time; hierarchy comes from weight and size, with the run id and every identifier in the mono face.

### Hierarchy
- **Headline** (700, 20px, 1.2): the sheet's step title.
- **Run id** (mono 700, 16px): the identity line's run id.
- **Title** (700, 15.5px, 1.2, two lines at most): a card's label.
- **Body** (400, 15px, 1.4): the sheet's prose ("What it did").
- **Body dense** (400, 13px to 13.5px): the dock, the sheet's lists, the identity line's facts.
- **Meta** (400, 12.5px, Pencil): a card's meta lines, the hint, the dock's source line.
- **Word** (700, 12px, 0.02em, lower case): the state word in its pill.
- **Label** (600, 13px, 0.08em, uppercase, Pencil): section headers on the list pages (unchanged).
- **Mono** (400, 13px): commands, ids, lane chips (600, 12px), the sheet's file lists.

**The Lower-Case Word Rule.** State words on cards, pills and the sheet are lower case (`succeeded`, `running · needs you`); only the list pages' status badges keep their capitalised labels.

**The Tabular Numbers Rule.** The shell sets `font-variant-numeric: tabular-nums`; durations, counts and times align.

## Layout

The run page is a frame that takes the window below the identity line (measured on mount and on resize, never under 420 px) and never scrolls the page: the stage pans and zooms inside it. The identity line is one wrapping row; Details folds the pinned facts under it. The dock sits 16 px from the stage's top-left at 312 px wide (its body scrolls past the stage's height minus 100 px); the sheet is 440 px on the right edge; the controls sit bottom right, the legend bottom left, the keyboard hint top right.

Cards are 232 × 136 px (growing to 176 px when their lines wrap); columns are 72 px apart along the flow and rows 44 px apart across it; a column is centred on the tallest one. The fit leaves the dock's 336 px clear on a desk and scales between 15 % and 140 %; the three detail levels switch at 60 % and 125 %.

Responsive behaviour:
- **Stage under 720 px (phones):** the flow runs top to bottom; the hint, the detail-level tag and the definition chip hide (a changed definition stays, as a warning); the dock folds when a step opens; the sheet rises from the bottom to 78 % of the stage with 16 px top corners; the legend stacks in one column; the identity line puts the feature on its own last line and hides the live chip.
- **The list pages** keep their breakpoints of the Calm look (860 px rail, 760 px phone rules).
- The page never scrolls sideways; a command scrolls inside its box.

**The Stage Is The Page Rule.** Nothing on the run page sits below the stage; what is not a card lives in the dock or the sheet.

## Elevation & Depth

Flat surfaces with one floating level. Cards, the dock, the sheet and the stage controls float over the ground with the **float shadow** (`0 10px 30px -12px rgba(20,30,25,.28), 0 2px 6px -2px rgba(20,30,25,.12)`; deeper and darker in dark: `0 14px 34px -12px rgba(0,0,0,.7), 0 2px 6px -2px rgba(0,0,0,.5)`). A card lifts to the float shadow on hover; a selected card adds a 3 px accent ring under it. The list pages keep the Calm hairline lift (`0 1px 2px rgba(20,30,25,.06)`, none in dark).

**The Panels Float Rule.** Only things that sit on the stage float; nothing on the list pages gains a shadow.

## Shapes

Cards and the open-page button are 10 px; the dock and the legend 12 px; the sheet's fact tiles and command boxes 8 px; pills 999 px; severity chips 4 px. A card's state band is a 5 px strip across its top edge; the sheet repeats it. Edges are 2.2 px orthogonal tracks with 12 px rounded elbows and a filled arrowhead; a return mark is a 2.4 px dashed green curve under the cards; an edge to a step that has not started is dashed in Track Soft.

**The Dash-For-Executor Rule.** A card's outline says who executes the step: solid for an agent session, dashed for the trusted verifier, dotted (2 px) for the controller. Colour says the state. Neither carries the other's meaning.

**The Band Rule.** A container shows its state as the 5 px band on its top edge and the pill beside its title; only pills, the Now banner and finding lines fill with a soft tone.

## Components

### Identity line
One row on a Sheet with a hairline below: the run id (mono 700), the status badge and its short meaning, the Untried chip, the feature title ellipsized with its full text in the tooltip, the pinned definition (`definition <sha> · current|changed since`), the live chip and the Local/UTC toggle, a pill link to the other view (Assignment or Run graph), and a `Details` disclosure that opens the pinned facts beneath. On the Assignment page the same line sits over the tabs and the assignment.

### Step card
232 × 136 px, Sheet fill (Inset when pending), 1.5 px Rule outline in the executor's dash, 10 px corners, a 5 px band in the tone. Row one: the 18 px glyph and the label (two lines). Row two: the state word pill (soft fill), `kind · executor`, `attempt n` and the round line of a repair or the review. Row three: the lane in a mono chip, the duration, the open P1 count. Row four (full detail only): the last event's time and text, or what the step did. At the overview level the card shows a chip: glyph and label, then two or three facts. A card that waits on the operator adds the 3 px Attention Ring; the step the run is at adds an Ink outline; a selected card the accent ring. Keyboard focus is the 2 px accent outline. Hover lifts.

### Live dock
A floating panel: the bar (44 px, the tone's glyph, the step the run is at in bold, its word in the tone's colour, "for 41m15s", a chevron) folds the body. The body: the Now banner (4 px left rule and the tone's soft fill, 13 px, the headline at 14 px, More, "Open <step> ›" which centres the step, and the command block with one Copy per command), "Latest events" as five rows (14 px glyph, the step in bold, the age, the message clamped to two lines; a row is a button that centres its step), the figures `Ran · Spent · Deadlines` with "not recorded" in italic Pencil where nothing is recorded, and one Pencil source line.

### Step sheet
A 440 px Sheet with a hairline on its stage side and the float shadow: a head with the 5 px band, the title (20px 700), the state pill, `kind · executor` and the id in mono, and a 44 px close button; a scrolling body of sections separated by hairlines (What it did, Facts as Inset tiles, Command, Reviewers as toned pills, Findings as severity-chip lines with "Show all", Repair, Questions to you, the attack pass or the panel where the step owns it, Events with mono times); a footer with the full-width Ink "Open step page" button. A phone shows it as a bottom sheet.

### Stage controls
44 px floating controls bottom right: `Legend` (toggles the legend panel), the detail-level tag (`39% Overview`) and a three-button zoom group (−, fit, +), on Sheet with a Rule border and the float shadow. The legend lists the six glyphs with their words, the three outlines and the return mark.

### Chips and pills
- **State pill** (sheet, dock, cards): glyph plus lower-case word, the tone's colour on its soft fill, 12 to 13px 700.
- **Status badge** (identity line, list pages): the Calm badge, unchanged, on the new tone pairs.
- **Lane chip**: mono 12px 600 in a 1 px Rule box with 4 px corners.
- **Severity chip**: solid P0/P1/P2 with `sev-fg` text, mono 11px.

### Command line
Mono 13px on an Inset box with a hairline, 8 px corners; a Copy button beside it that says "Copied" or "Selected"; the honesty caption under the block. Unchanged in content from the Calm look.

### Lists, rails, rows, finding cards, section headers, buttons
The home, project, feature and node pages keep the Calm components (run rows with a 4 px tone stripe, finding cards, figures, section headers, filter pills, the step strip, tabs) on the new tokens and faces.

**The Selection Is Not State Rule.** Selection and the current item are drawn in Signal Violet (the ring, the hot edge) or Ink (the "now" outline), never in a tone.

## Do's and Don'ts

### Do:
- **Do** take every colour inside the Projects viewer from the tokens on `.projects-shell`, and give a new token a dark counterpart under both dark selectors.
- **Do** route every state through `tone.ts`, draw it with the tone classes, and repeat it with a `Glyph` or a word.
- **Do** keep the run page to the identity line, the stage, the dock and the sheet; put a new run-level record in the sheet of the step that owns it.
- **Do** show "not recorded" in italic Pencil wherever the records hold nothing; never guess a time, a cost or a model.
- **Do** keep every control at 44 px, the stage keyboard-walkable, and the page free of sideways scroll at 390 px.
- **Do** self-host any face and never let the page ask another host for anything.
- **Do** gate motion behind `prefers-reduced-motion: no-preference`.

### Don't:
- **Don't** use the accent for a status, or a tone for selection.
- **Don't** add sections, tables or lists under the stage; the stage is the page.
- **Don't** tint the ground, a card or a panel for grouping or emphasis.
- **Don't** add a web-font request, a third face or an icon font; glyphs are the drawn symbols of `Glyph.tsx`.
- **Don't** put a control on any page that acts on a run.
