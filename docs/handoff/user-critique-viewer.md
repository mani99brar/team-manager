# User critique — viewer handoff (run user-critique-006, follows user-critique-005)

The viewer lane of `docs/PRD_USER_CRITIQUE.md` (4.5, Appendix A; decisions.md [L2]): on the run page each critique finding
shows its proof — its lane, its numbered steps to reproduce and its screenshots (thumbnails with captions that open the
one full-size dialog) — in the live review and in one "Earlier rounds" list of the archived rounds; the critique reviewer
entry is worded as a headless critique job (its launch time and status), never a native session; a critique P1 recorded
without a screenshot says "no screenshot"; every other reviewer's finding looks exactly as before. Built on the engine base
integrated at d7c4aa4 (export 1.11.0, the `evidence`/`critique_artifacts` contract and examples).

Run 006 follows 005 (decisions.md [L7]): the viewer work is restored here from `12aba0a` (005's candidate, which had
already passed every lane check and check-report in both phases). 005's candidate gate was blocked twice — not by viewer
code, but by a defect already on the base: `tests/project-workflows/revamp-lists.spec.ts` "Self-hosted fonts" required
every font response to be 200, yet in the candidate phase the browser revalidates a face and gets 304. [L7] relaxed that
assertion on the base to accept 200 or 304, abandoned 005 and relaunched the viewer as 006 (`--restore-from 12aba0a`). This
run reruns every check on that base and completes; the viewer source is unchanged from 12aba0a (only this handoff's title
and run note changed — worker design-challenge notes 1 and 2).

Earlier lineage: run 005 followed 004 (decisions.md [L6]), which was the same viewer work restored from `a913218`; [L6]
added the two optional fields (`evidence?`, `critique_artifacts?`) to the local test types in `server/projects.test.ts` on
the base so `frontend-build` passes.

## What changed (owned paths only)

- **`src/projects/critique.ts`** (new): the evidence model, pure helpers for the unit tests and the components —
  `isCritiqueReviewer`, `CRITIQUE_JOB_WORDING` ("headless critique job"), `evidenceOf`, `evidenceSteps`,
  `evidenceScreenshots` (maps each screenshot to its artifact-route URL via `paths.artifact`), `missingScreenshot` and
  `archivedRounds` (the loop's `archived === true` review rounds; a restored round is the live review again, so it is left
  out — design challenge note 6). **`missingScreenshot` is reviewer-aware (design challenge note 1):** it is true for a
  **critique** P1 with no screenshot whether its `evidence` is present-but-empty or absent altogether, and false for every
  other reviewer's finding. The engine drops `evidence` for a finding with no steps (a P1 whose digest did not match
  evidence.json included), so a missing key is still a P1 without a screenshot, which the viewer must flag.
- **`src/projects/critique.css`** (new): the evidence block, the "no screenshot" line, the critique reviewer-kind chip and
  the "Earlier rounds" list, from the Calm tokens in `theme.css`. The screenshot grid and dialog are reused from
  `Screenshots.tsx`/`node/verify.css`; nothing new there.
- **`src/projects/Screenshots.tsx`**: the artifact prop is widened to `{artifact_id, sha256?, caption?}` so the one grid
  and the one dialog render both a check capture (with `sha256`) and a critique screenshot (only `artifact_id` + `caption`)
  — design challenge note 4. The check rows are byte-for-byte unchanged: when `sha256` is present and `caption` absent the
  figcaption is `<code>{id}</code>`, the thumbnail title is `id\nsha256 …`, and the dialog head title is `sha256 …`, as
  before. When a `caption` is present the figcaption and the dialog head show it. No second dialog was added.
- **`src/projects/ReviewDetail.tsx`**: a `CritiqueEvidence` component (steps as a numbered `<ol>`, then the screenshots via
  `Screenshots`, or "no screenshot"), rendered in the finding card after its fields — and reused by the "Earlier rounds"
  list, never in the blocking card (design challenge note 6). When a finding carries no `evidence` the component renders
  nothing **except** for a critique P1 (via `missingScreenshot`), which still shows the "no screenshot" line (design
  challenge note 1). The critique reviewer is worded by its id in the Reviewers fact (`· headless critique job`, not the
  transport's "native session") and in the reviewer strip (a `reviewer-kind` chip beside its id). Its strip outcome line and
  recorded-time label are worded as a headless job too (repair round 1): the strip uses `critiqueOutcomeWording` instead of
  the native `outcomeWording` (so an approved critique reads "the critique job completed" and a failed one "…the critique job
  did not start, timed out, ran out of budget or produced invalid output", never "completion file accepted" or "the review
  deadline expired"), its `accepted_at` reads `decided` not `file accepted` (`CRITIQUE_DECIDED_WORDING`; the critique has no
  completion file, PRD 4.4), and the review's blocked-by line uses `reviewBlockedBy` so a failed critique is worded as a job
  there as well. All three live in the owned `critique.ts`; the native path still delegates to `reviewers.ts`. `laneWording`
  lives in `findings.ts`.
- **`src/projects/findings.ts`**: `laneWording` added here (it belongs beside `workerWording`), so both the finding card and
  the "Earlier rounds" list use it (keeping `ReviewDetail.tsx` exporting only components — the `react-refresh` rule).
- **`src/projects/node/ReviewSections.tsx`**: an `EarlierRounds` component — one "Earlier rounds" `NodeSection` listing each
  archived round (round, verdict, lane) with its findings (every reviewer's), each a card (its own `earlier-finding` test
  id, never a `finding` row, so the live findings count is untouched); a critique card shows its own `CritiqueEvidence`.
  A new `fixLoop` prop carries the loop in.
- **`src/projects/NodeDetail.tsx`**: passes `detail.fixLoop ?? null` to `ReviewSections` and adds the `earlier-rounds`
  entry (count = archived rounds) to the review node's section index.
- **Tests**: `tests/unit/critique.test.ts` (the evidence model, now including a critique P1 with **no `evidence` key** that
  warns "no screenshot", and a non-critique P1 that does not — design challenge note 1),
  `tests/project-workflows/fixtures/ux-critique.ts` (the `ux-critique` workflow and its one run) registered in
  `tests/project-workflows/fixtures/index.ts`, and `tests/project-workflows/critique.spec.ts` (the `critique-evidence`
  scenario).

## The fixture (design challenge notes 1–3)

`run-critique` is one coherent two-lane run (`pages`, `shell`) derived from the contract examples:
- the live review is **round 2, attempt 2, blocked**: `general` (native) approved with one P2 (no evidence); the **headless
  critique job** blocked on an open P1 of `pages` (steps + one screenshot) and an open P1 of `shell` recorded with **no
  screenshot** (its `evidence` is present with an empty screenshot list);
- one **archived round 1** (`archived: true`, lane `pages`), the fix loop's repair answering the `review` step, carries a
  critique P1 with its **own distinct** screenshot id, caption and steps (not the live finding's — design challenge note 3)
  and a `general` P1 with no evidence (so "Earlier rounds" shows each reviewer's finding).

Both phases run (design challenge note 2): the worker phase serves the `RunDetail` (fix loop projected by `ux-refine`'s
`projectDetail`), a `ReviewResult` built with `validateReviewResult` so it carries `evidence`, and the two critique
screenshots as artifact files (`solidPng`, so the browser decodes them). The candidate phase seeds a **1.10.0** export whose
review section carries the 1.11.0 `evidence` and `critique_artifacts` (the server accepts them on a 1.10.0 seed; it does not
gate them by version — design challenge note 3) and writes the real PNG files under `critique/2/` and `critique/1/` with the
registered sha256/bytes, which the artifact route serves. Steps avoid any path the server would redact to `<path>`
(`FIRST_STEP`), so the same assertions hold in both phases.

## Checks executed

- Run 006, on base d698ac5 (`npm ci` in a fresh worktree) plus the viewer paths restored from 12aba0a:
  `frontend-build` (`npm run build`): **pass** (exit 0). `frontend-lint` (`npm run lint`): pass.
  `shared-contract` (`npm run test:contracts`): pass (35). `frontend-unit` (`npm run test:unit`): pass (585, server + unit).
  Repair round 1 reran all four non-browser checks on the reworded critique entry: build, lint, contracts (35) and unit
  (588, +3 for the critique wording helpers) all pass.
- `critique-evidence` browser scenario through `check-report` in **both** phases (worker and candidate): `ok`. The two
  phases share Playwright's `test-results` output dir, so the second run cleans the first's screenshot files; each phase was
  verified immediately after its own run (one report valid at a time), not from two stale reports side by side.

## Open P2s / assumptions

- **A failed critique's wording is now this lane's, not the engine's (repair round 1, closing the earlier P2).** The strip
  outcome line, the `accepted_at` label and the review's blocked-by line are worded by the critique's reviewer id in the
  owned `critique.ts` (`critiqueOutcomeWording`, `CRITIQUE_DECIDED_WORDING`, `reviewBlockedBy`), so a failed critique (verdict
  null, status blocked) reads as a headless job ("…the critique job did not start, timed out, ran out of budget or produced
  invalid output") and never "the review deadline expired or its completion file was rejected". `reviewBlockedBy` mirrors
  `reviewers.ts`'s `blockedByWording` because that file is not owned, and delegates every *native* reviewer's reason to the
  shared `blockingReason` so the two stay in step; a native reviewer's own wording is unchanged. No browser fixture carries a
  failed critique (this lane's is blocked *with* a verdict), so the failed-critique paths are covered by `tests/unit/critique.test.ts`.
- **Archived-round evidence is P1-only by design (engine seam).** `fix_loop.review_rounds[].findings` hold only each round's
  open P0/P1 blockers, so "Earlier rounds" shows critique **P1** evidence; an archived round's critique P2s are not in the
  export and are out of scope (decisions.md [L5], engine handoff).
- **The candidate seed depends on the server not gating export fields by version (design challenge note 3).** The
  candidate-phase fixture seeds a 1.10.0 export whose review section carries the 1.11.0 `evidence` and `critique_artifacts`;
  it passes only because the server does not check those fields against the export version. A later engine change that
  checked fields by version would fail `critique-evidence` in the candidate phase even though the viewer has no fault; seed
  a 1.11.0 export once the seed helper (`writeRun`, engine-owned) supports that version.
