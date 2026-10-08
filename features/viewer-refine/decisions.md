# Decisions: viewer-refine

From the grill session of 2026-10-08 with the operator (one interview for `worker-skills` and `viewer-refine`; the operator decisions are the same in both files, the grill defaults are per feature).

## Operator decisions

- [O1] Q1: The data plumbing is in scope (an adapter lane) and the run page is the primary surface, Runs home second; the operator added a controller change so workers get skills and things like the advisor (that part is `worker-skills`). Operator: "Yeah thats true but we also need the data plumbing and update the workers to give access to skill and other things like advisor".
- [O2] Q2: A controller change in an engine lane: feature.json 2.8.0 adds a per-lane `skills` key; for such a lane the controller builds a session-only plugin from the named folders under `~/.claude/skills/`, launches it without `--safe-mode` but with `--setting-sources ""`, `--plugin-dir` and the `Skill` tool; lanes without the key keep today's launch unchanged. Operator: "sounds good".
- [O3] Q3: A refinement of the Calm look; a redesign stays possible. Operator: "A refinement and a possible redesign, also does all workers run a dockered env?".
- [O4] Q4: The fix loop becomes part of the graph: each repair session its own node, drawn after the step it answers; each review round an attempt of the review node labelled with its delta base; the lane's model pin on its node; the export gains repairs, review rounds and per-lane pins at a new contract version, old exports stay valid. Operator: "Yes".
- [O5] Q5: This feature supersedes the unfinished slice S7 (`features/viewer-ux-depth`: the Assignment tab in one line and one row per lane, the review diff inline) and the 8 open P2s of `viewer-revamp-008`; the operator deletes `viewer-ux-depth` by hand after this feature lands. Operator: "yes".
- [O6] Read-back 2026-10-08: confirmed every grill default and deferral as written (no change). Operator: "looks good to me".

## Grill defaults

- [G1] Two features in order [added, not asked]: `worker-skills` lands on main first; this feature's UI lanes then declare `skills: ["impeccable"]` at feature.json 2.8.0 (the operator raises the version and adds the key before launch, README). The `adapter` lane declares no skill.
- [G2] Lanes split by the DOM they test, as the revamp did: `adapter` (`workflow/export_state.py` and its test, `contracts/projects`, `server`, `tests/unit/triage.test.ts`); `pages` (the run page, its node pages, Assignment, the inline diff, the graph and `dag.ts`, `run.css`, `node.css`, their fixtures, specs and unit tests, the shared browser fixture modules `fixtures/index.ts`, `mock.ts`, `seed.ts`, `fixtures.ts`); `shell` (`src/App.tsx`, `src/App.css`, `src/index.css`, `theme.css`, `tone.ts`, `ui/`, Runs home, the rail, lists, the Now banner, the command block, time, their fixtures, specs and unit tests). Each UI task lists the DOM the other lane owns; the `shell` lane adds projects through spec-level route overrides, never through the fixture modules (revamp lesson).
- [G3] Models: `adapter` on `claude-sonnet-5-5` at medium (the small-lane pilot the operator planned; the lane is an additive export change with a pinned appendix); `pages` and `shell` on the default worker pin (Opus 4.8, the run-wide default). Judges unchanged.
- [G4] Launch flags: `--profile attended` (stops before the workers and after review), `--fix-rounds 2`, the RUNBOOK canary first, launched from `~/dev/md-manager`, not from a worktree, and not on the same box as the three pilots of the learnings build (one Playwright run at a time on this host).
- [G5] `PRODUCT.md` and `DESIGN.md` at the repository root are written by the operator's session before launch (`/impeccable init` for the product context, `/impeccable document` for the Calm look as the code has it) and committed; no lane edits them in this run (they are not in any owned path); a lane that finds them wrong says so in `open_assumptions`. The skill's engine binary is fetched once by the operator (`scripts/impeccable context`) so no worker waits on a download.
- [G6] The possible redesign: a UI lane's `shape` step may conclude the refinement cannot meet PRD section 2; it then stops with a `question` completion to the operator describing what a redesign would change and attaching a mockup (a static HTML or image under its handoff), and builds no redesign in this run. The operator decides; a redesign is a new feature.
- [G7] Export 1.10.0 is the one bump of this pair of features (Appendix A): repair nodes, `fix_loop`, `review.round`, `review.delta_from`, `review.delta_diff`, `inputs.workers.<lane>.roles` and `.skills`, `inputs.automatic.fix_rounds`; `worker-skills` bumps nothing in the export. Old exports stay valid and render unchanged. The viewer contract moves to 1.10.0 with `fixLoop`.
- [G8] `tryout: true` (user-facing: the operator tries the integrated run before the merge), `critical: false` (CLAUDE.md lists no critical path), no attack pass (no security requirements document), no sidecar (its messages did not land in earlier runs; the fix loop is the in-run correction now).
- [G9] The graph: repair nodes depend on the step they answer and nothing depends on them (the contract graph stays acyclic, `layoutDag` and the contract's cycle check are unchanged in kind); the return edge is a drawing from the `fixLoop` section; the pages lane may change `dag.ts` for placement and the fit floor, keeping keyboard order, status glyphs, the attention ring and the executor legend.
- [G10] The impeccable method is pinned in PRD section 4: Operate mode; `context` once; `shape` first with its result in the handoff before any edit; `craft-floor.md` immediately before the first UI edit; refinement playbooks only; one batched inspection round at 1440 and 390 in light and dark, one batch of fixes, at most one confirmation round; `audit` once at the end. `new-work` is never run.
- [G11] The revamp's eight P2s close in the lane whose DOM they touch (PRD 5.8); the six test gaps become assertions in that lane's specs.
- [G12] The two UI lanes keep every existing spec green or rewrite the assertions whose DOM they own; a spec another lane owns that breaks on a shared component is a question, not an edit (revamp lesson: split specs by the DOM they test).

## Changes after launch

None yet.

## Deferred

- A redesign of the look (a new feature, after the operator's decision on a mockup).
- Controls that act on a run from the viewer (the viewer stays read-only).
- The `expose_run_dir` setting, the Pi/Claude containment graph and the document editor.
- A P3 or "nit" severity in the review record (learnings L115).
- Archived challenge attempts and the panel's `context_truncated` on the run page beyond what the export already carries.
