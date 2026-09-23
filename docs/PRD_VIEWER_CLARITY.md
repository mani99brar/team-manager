# PRD: Viewer clarity (executor marks, created files, task order, findings by reviewer)

Status: Proposed 2026-09-23. Follows [PRD_PARALLEL_REVIEWERS.md](PRD_PARALLEL_REVIEWERS.md) (reviewer strip, `reviewers` in the export) and [PRD_WORKER_LANES.md](PRD_WORKER_LANES.md) (lanes, per-lane packets). Ships through a feature run of the workflow itself (`features/viewer-clarity`, lanes `ui` and `adapter`, reviewers `general` and `coverage`), launched once with native reviewers and once with the print transport (section 8).

## 1. Goal

An operator reading a run in the Projects viewer can tell at a glance which graph nodes were executed by an agent session and which by the controller or the trusted verifier; can open the files a worker created or changed, with Markdown rendered and the reviewers' findings about each file shown on it; reads a worker node's output before its assignment, without the task text twice on the page; and, when a run had several reviewers, sees each reviewer's findings as its own group by default. The purpose is reviewing a run's work in the viewer, not only reading its evidence.

Success: for run `workflow-audit-001`, the graph shows five dashed nodes and two solid ones with a legend; the audit worker's node opens on its result with `docs/audit/WORKFLOW_AUDIT.md` rendered as Markdown, the fourteen findings that name that file listed on it, and the task collapsed below; the verify node shows the verifier's checks and gate, not the file; the review node opens with two groups, `resilience` and `safety`, eight findings each, and each finding that names a captured file links to it.

## 2. Confirmed decisions

- Created files are evidence, captured at freeze. The trusted verifier copies every changed text file from the snapshot worktree into the worker-phase packet as an artifact of kind `file` before it runs any check. The server serves them through the existing artifact route. The server never reads the repository, and no route runs git on demand.
- Every changed text file is viewable, not only Markdown. `.md` is rendered with the existing Markdown component; every other text file is shown as source on demand, the way check logs are. Binary files, files over the size cap and deleted paths are listed with the reason they were not captured.
- Worker-phase capture only. Candidate-phase packets list changed files as today and capture nothing; the candidate node links to the lane's worker-phase files.
- The launch node shows what the worker produced; the verify node shows what the verifier proved. Today both render the same result block. After this slice the launch node carries the result facts, the created files, the completion signal, the launch receipt and the task; the verify node carries the result facts, the checks with their logs, the gate and deferred checks, screenshots and other artifacts, and the ownership outcome. Neither repeats the other's block.
- Output first, task collapsed. On the launch node the result and created files come first; the task follows inside a collapsed disclosure that opens automatically when a finding's requirement link hands over a quote to highlight. The Assignment tab is unchanged and remains the full view of every task.
- Executor is derived from the node kind, not recorded: `worker` is an agent session; `review` is one agent session per reviewer, or one print job per reviewer when the review result's transport is `print`; `verification` is the trusted verifier; `prepare` and `integration` are the controller. Controller and verifier nodes get a dashed outline, an executor word in the node's meta line, a legend under the graph and the executor in the accessible label. Agent nodes keep the solid shape.
- Findings default to grouping by reviewer when the run has more than one reviewer, by disposition otherwise. The Reviewer grouping is a third option beside Disposition and Worker and composes with the existing reviewer filter.
- A finding is tied to a file by verbatim match only. A finding belongs to a captured file when its message contains that file's repo-relative path verbatim; a `path:N` or `path:N-M` occurrence marks lines N to M. Nothing is inferred from similar names or partial paths. The review completion protocol, the briefs and old reviews are unchanged: this is the same rule the requirement link uses for task text, applied to file paths. A structured location on findings is a possible follow-up, not part of this slice.
- Contract versions move only where a message changes shape. Old exports and old packets stay valid; a result without `file` artifacts renders "created files were not captured for this run", the same way pre-1.3.0 exports say inputs are not recorded.
- The viewer's Markdown renderer runs with raw HTML disabled and links rendered as text or relative anchors only. File content is served verbatim, like logs; the path-redaction rule applies to file paths the viewer prints, not to file contents.

## 3. Configuration

No new configuration. The size cap is a controller constant: 512 KiB per file and 8 MiB of captured files per packet, both named in `workflow/checks.py` and stated in the RUNBOOK. A file is text when it decodes as UTF-8 and contains no NUL byte.

`features/viewer-clarity/feature.json` (2.1.0) declares lanes `ui` and `adapter` and reviewers `general` and `coverage` with the briefs in `features/project-workflows/reviewers/`. Its policy is the parallel-reviewers policy with the browser scenarios of section 6.

## 4. Design

### 4.1 Capture (adapter)

In `verify_revision` (`workflow/checks.py`), after the verification worktree is confirmed clean at the snapshot commit and before `run_lane_commands`, and only when `phase == "worker"`: for each path in `changed`, in order, if the file exists in the worktree, is a regular file, is text and is within the caps, `capture.add(path, "file")` and record `path` on the artifact; otherwise append `{path, reason}` to a `files_not_captured` list, where reason is one of `binary`, `too_large`, `missing` (deleted or renamed away), `budget` (the packet total is spent). The capture happens before checks so a check that rewrites a file cannot change what is recorded; the post-check cleanliness rule already invalidates the evidence if that happens.

Artifact schema, pinned so both lanes build against the same shape: `contracts/workflow/workerResult.schema.json` stays at `contract_version` `1.0.0` (additive optional fields, the precedent set by `deferred_checks`). The artifact `kind` enum gains `file`; artifacts gain an optional `path` (repo-relative, no `..`, no leading `/`) that is required when and only when `kind` is `file`; the result gains an optional `files_not_captured` array of `{path, reason}` with `reason` one of `binary`, `too_large`, `missing`, `budget`. The served worker result is validated by that same schema (`workerResultSchema` from `contracts/workflow/v1.ts` in `server/projectRoutes.ts`), so the projects contract changes only in its README, examples and tests. `recheck_packet` verifies each `file` artifact's sha256 against the retained copy exactly as for other artifacts. The export stays at 1.4.0: results are served from packets. The ui lane builds its fixtures from this paragraph, not from the adapter's worktree.

### 4.2 Node pages (ui)

`NodeDetail.tsx` splits `WorkerEvidence` into `ProducedEvidence` (result facts, created files, completion, receipt, task) used by launch nodes and `VerifiedEvidence` (result facts, checks, gate, deferred, screenshots, other artifacts) used by verify nodes. The result facts (status, attempt, session, base and output commit) appear on both because they anchor the two pages to the same snapshot. Created files: a section "Files created or changed" listing every `changed_files` entry; entries with a `file` artifact render inline for `.md` (`Markdown` component) and behind a disclosure for other text; entries in `files_not_captured` show the reason; a result with neither says the files were not captured for this run.

The task disclosure: `TaskPanel` is wrapped in `<details data-testid="task-details">`, closed by default, forced open when `highlight` is non-null, and the existing scroll-into-view of the quote runs after it opens.

### 4.3 Executor marks (ui)

`status.ts` gains `EXECUTOR_LABEL: Record<NodeKind, string>` and `executorOf(kind, transport?)`. `WorkflowGraph.tsx` adds the class `is-agent` or `is-controller` to each node, includes the executor in the meta line when no status is shown and after the status otherwise, includes it in `aria-label`, and renders a legend (`data-testid="graph-legend"`) with three entries: agent session, trusted verifier, controller. `index.css` is not in either lane's ownership; the dashed outline uses an inline SVG attribute on the node shape (`stroke-dasharray`) toggled by the class, so no global stylesheet change is needed. `NodeDetail` adds an "Executed by" fact.

### 4.4 Findings on files (ui)

`findings.ts` gains `findingsForFile(findings, path)` and `linesNamed(message, path)`: the first returns the findings whose message contains `path` verbatim, in review order; the second returns the `[from, to]` ranges from every `path:N` and `path:N-M` occurrence. Both are pure and unit-tested through the browser fixtures. On a created file's panel, a "Findings on this file" list precedes the content: one row per finding with its severity, reviewer, disposition and message, and a "show lines" control when the finding names lines. Activating it switches the file to the source view, marks those lines (`data-finding-line`), and scrolls the first into view; for Markdown this means leaving the rendered view for the source, which is the only view where line numbers mean anything. A file with no matching finding says so. In the review node's findings list, every finding whose message names a captured file of the run gains a link to that file's panel on the launch node, in the same way the requirement link opens the task. The review result does not change: the link is computed in the viewer from the served result's file artifacts and the findings' text.

### 4.5 Findings by reviewer (ui)

`ReviewDetail.tsx`: `GroupBy` gains `'reviewer'`; groups are the run's reviewers in declared order, each labelled with the reviewer id, its own verdict and its severity counts, plus a trailing group for findings whose `reviewer` matches no entry (the contract forbids this, so the group is a guard that stays hidden when empty). Initial state is `'reviewer'` when `review.reviewers.length > 1`, else `'disposition'`. The per-reviewer filter continues to hide rows in every grouping.

## 5. Work items

1. adapter: `checks.py` capture with caps and reasons; `workerResult.schema.json` (`file` kind, `path`, `files_not_captured`); `contracts/projects/v1.ts`, README, examples, contract tests; `server/projects.ts` passes the fields through; RUNBOOK and CHEATSHEET note the captured files and caps; unit tests in `test_checks`/`test_verification` for capture, caps, binary, missing, budget, candidate-phase no-capture, and recheck of a tampered file artifact.
2. ui: `status.ts` executor labels; `WorkflowGraph.tsx` classes, meta, legend, aria-label; `NodeDetail.tsx` split into produced and verified evidence, created-files section, task disclosure, "Executed by" fact; `findings.ts` file matching and line ranges; the findings-on-file list, line marks and the finding-to-file link; `ReviewDetail.tsx` reviewer grouping and default; fixtures gain a run with a `file` artifact for a Markdown file, a `.ts` file, one `too_large` and one `binary` reason, findings whose messages name those files with and without line numbers, and keep a legacy run without them; `seed.ts` writes the same into real packets for the candidate phase; scenarios of section 6.
3. Both: the existing scenarios keep passing, in particular `finding-to-task`, `candidate-evidence`, `deferred-checks`, `viewer-two-reviewers`, `legacy-run`, `paths-redacted`.

## 6. Acceptance scenarios

| Scenario id | Lane | Asserts |
| --- | --- | --- |
| capture-text-files | adapter (unit) | a worker-phase verification of a snapshot with a changed `.md`, a `.ts`, a 600 KiB text file and a PNG yields two `file` artifacts with paths and matching sha256 and two `files_not_captured` entries with reasons `too_large` and `binary`; a path deleted in the snapshot is `missing`; the candidate phase captures nothing |
| capture-before-checks | adapter (unit) | a check that rewrites a captured file leaves the artifact equal to the snapshot content and the packet flagged by the existing "modified the tested source revision" rule |
| tampered-file-artifact | adapter (unit) | `recheck_packet` rejects a packet whose retained `file` artifact bytes no longer match its sha256 |
| served-files | adapter (server) | the results route serves `file` artifacts with `path` and `files_not_captured`; a result recorded without them still validates |
| executor-marks | ui (browser) | the graph of a seeded run has solid worker and review nodes and dashed handoff, verify, candidate, approval and integrate nodes; the legend lists the three executors; each node's accessible name includes its executor; the node page shows "Executed by" |
| created-file-rendered | ui (browser) | the launch node of the seeded run renders the Markdown file's headings, shows the `.ts` file as source on demand, lists the too-large and binary entries with reasons; the legacy run says files were not captured |
| output-first-task-collapsed | ui (browser) | the launch node's result and files precede the task; the task disclosure is closed; following a finding's requirement link opens it and highlights the quote (extends `finding-to-task`) |
| verify-shows-checks-not-files | ui (browser) | the verify node shows checks, gate, deferred checks and screenshots and has no created-files section; the launch node has no checks table |
| findings-on-files | ui (browser) | the seeded Markdown file's panel lists exactly the findings whose messages name its path, with severity and reviewer; a finding naming `path:12-14` switches to the source view with lines 12 to 14 marked and the first in view; a finding naming a similar but different path is not listed; the `.ts` file with no matching finding says so; on the review node, findings that name a captured file link to its panel and findings that do not have no link |
| findings-by-reviewer | ui (browser) | the two-reviewer run opens grouped by reviewer with two groups in declared order, each with its verdict and counts; the reviewer filter hides the other group; the single-reviewer run opens by disposition |
| panes-and-print (live, section 8) | operator | run 1: two native reviewer panes, both files accepted, integrated; run 2 with `--reviewer-transport print`: two print jobs, `review.json` of the same shape, `reviewer.transport` is `print` in the served result |

## 7. Open questions

- Whether to capture files in the candidate phase too when a lane's worker-phase packet is superseded by a later attempt. Default: no; the launch node shows the latest worker-phase packet, which is the one the candidate was built from.
- Whether the executor should be recorded in the export rather than derived, so a future graph with a different node vocabulary stays honest. Default: derive now; the node kind already carries the fact.
- Whether large Markdown should be rendered in full or truncated with a disclosure. Default: full, the cap bounds it.

## 8. How to run

Offline: the workflow unit suite, contract tests, the unit regression and the project-workflows Playwright suite in both phases.

Live, run 1: `python -m workflow launch viewer-clarity --live --automatic --worker-timeout-seconds 5400 --review-timeout-seconds 3600`, in its own Herdr tab. Expect two reviewer panes after the candidate passes. On integration, merge the feature branch to main.

Live, run 2: `python -m workflow launch viewer-clarity --live --automatic --run-id viewer-clarity-002 --reviewer-transport print --worker-timeout-seconds 5400 --review-timeout-seconds 3600`. Expect no reviewer panes, two `review-<id>.stdout.json` files, and a `review.json` with both entries. Compare it with run 1's; the second branch is discarded.
