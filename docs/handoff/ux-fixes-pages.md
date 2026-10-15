# Handoff: UX critique fixes, stage A, lane `pages`

Findings M9, M10, M22, M27, M28, M35, M36 and the M6 prose measure, with the DESIGN.md amendments of PRD 8.

## What changed per finding

- **M9 one findings list.** `ReviewDetail.tsx`: `FindingCard` head is severity, reviewer (`finding-reviewer`), lane (`finding-worker`), disposition, a "blocks integration" chip (`finding-blocks`) and the first sentence (`splitFirstSentence`, `findings.ts`); the rest of the message, captured-file links, the requirement and evidence sit behind a More/Less `<button>` (`finding-more`, `aria-expanded`). `BlockingFindings` and the `blocking-*` CSS are gone; `ReviewSections` renders no second list. The filter row is `All n`, `Open P0/P1 n` (id `blocking`), `P0/P1/P2 n` (`severity:<P>`), reviewers, lanes, `Open only n`. A review with something blocking opens with `blocking` pressed (reading: a review with no blocking finding opens on all findings, since "open P0/P1" would be empty); All clears the row. The section index lost "Blocking"; `Findings` keeps the total count and a `note` "n open P0/P1" (`SectionEntry.note`).
- **M6 measure.** `.finding-message`, `.task-rendered`, challenge concerns, earlier-finding messages, worker summary and question text: `max-width: 70ch`; finding messages at weight 400. No font-size change.
- **M10 verdict first.** `reviewerLead` (`node/model.ts`) builds the lead; `NodeDetail` passes it to `NodeHeader` for the `review` node (from the review result) and `reviewer-<id>` nodes (from the sessions' reviewer row, the graph's own source). `node-status-meaning` holds `node-verdict` plus muted `node-verdict-outcome` ("session succeeded"). `StepStrip` takes `verdicts` (from `stageCardOf`, as the graph) and sets `data-verdict` and the tone on reviewer chips; `li[data-status]` is unchanged. Worker, verify and integration wording is untouched.
- **M22 compact node pages.** `RunView`: no tabs/tabpanel on node pages; `RunBar` has an `Assignment` link (`tab-assignment`) and is one line at 761 px and wider; the section index is no longer sticky (the step strip is the one sticky band); figures share one row at 1024 px and wider.
- **M35.** `figure-completion` is gone; `WorkerReport` heading carries `report-completion` chip (completed ok, blocked fail, question warn, none yet idle).
- **M27/M28 Assignment.** The `Feature` fact is gone (the setup line prints it once). Decisions, each task, owned paths and required checks are closed `<details class="assignment-fold">` with sizes ("Decisions · 2,300 words", "Task · 22,364 characters", "Owned paths · n", "Required checks · n"). Lane names are links (`assignment-lane-link`) that focus the worker's `h4`. Headers: Owned paths, Checks, Task (chars). Below 600 px each lane row is a card with `data-label` labels (`assignment.css`).
- **M36.** `ErrorPanel` renders `StorageMissingPanel` for `RUNS_ROOT_UNAVAILABLE`: "Run storage missing", the project id (`projectIdFromPath`, `node/errors.ts`), `runs_root` in `projects.json`, a plain link to `/projects/<id>`, Retry secondary, HTTP code and path in a closed `technical-details`. Other errors are unchanged.

## Test ids added

`finding-message`, `finding-more`, `finding-blocks`, `data-blocking`, `node-verdict`, `node-verdict-outcome`, `data-verdict` (step chip), `report-completion`, `assignment-decisions-fold`, `assignment-task-fold`, `assignment-owned-fold`, `assignment-checks-fold`, `assignment-lane-link`, `storage-project`, `storage-project-link`, `technical-details`.

## Specs rewritten, and what they now assert

- `ux-review.spec.ts` `review-blocking-first`: the same facts against one list (opens on the blocking finding, All shows both, blocking card first, marked in place, in the first screen, requirement link after More, no Blocking index entry, the approved run has none, 390 px cards).
- `revamp-pages.spec.ts` `revamp-review`: figures, order, striping, combined filters (now with severities and Open P0/P1), blocking card first; strip tone test, worker figures (completion chip), button allow-list (`Open P0/P1 n`, `P0/P1/P2 n`; More/Less/All were already listed), contrast roots.
- `guardrails.spec.ts` `decisions-shown`, `inert-markdown`; `inputs.spec.ts` `run-assignment`; `lanes.spec.ts` three-lane assignment: open the folds first, then assert what they asserted.
- New scenarios: `review-one-list`, `node-compact` (revamp-pages), `reviewer-verdict` (sessions), `assignment-folded` (guardrails), `storage-missing` (ux-run).
- Unit: `node.test.ts` (`reviewerLead`, `splitFirstSentence`), `panels.test.ts` (filters, section entries, `projectIdFromPath`).

## DESIGN.md

Hierarchy gains the Measure line; "Lists, rails, rows, finding cards, section headers, buttons" gains the finding card, blocking-in-place, figures-are-numbers and node-pages-without-tabs sentences. Nothing else.

## Open items

- The first finding of the seeded blocked review sits about 800 px down at 1440x900 (annotation `first-finding-top` in `review-one-list`); lists' crumb toggle adds height at the candidate.
- "More" and the filter buttons carry no 44 px phone floor beyond the existing `.button-small` rules (phone work was rejected).
- `splitFirstSentence` splits at the first `.`/`!`/`?` followed by whitespace except after e.g./i.e./vs./cf./no./fig.; other abbreviations split early.
- Design-challenge notes 1, 2 and 4 concern `lists`' fixtures and handoff; no `pages` fixture run was added or changed. Note 3: the crumb toggle is `lists`'; the run bar keeps its height at 1440 px.
- Impeccable check against DESIGN.md: card head weight 400, tones via tokens, no new colours or type sizes; nothing flagged.

## Follow-up 002 (test updates only)

- clarity.spec.ts: the finding task and file links are clicked after the card's `finding-more`.
- critique.spec.ts: `finding-more` opens before the thumbnail click, and "All" is pressed before the general P2 card is read, because the review opens on open P0/P1.
- lanes.spec.ts: `openFolds` re-queries the closed folds on every pass; `finding-more` opens before the docs `finding-task-link`.
- revamp-pages.spec.ts: the command check exempts only the `Open P0/P1 <n>` label.
- sessions.spec.ts: the worker-wording check uses RUN_SUCCEEDED `launch_adapter`, which has an attempt in both phases.
- Seen once under load, passing alone: lanes `legacy-run` and revamp-pages `check-exit` (the 4.5:1 contrast test).
