# UI worker: run inputs, worker task panels and finding-to-task links

Implement the viewer side of slice C in `docs/PRD_RUN_INPUTS.md`. The payload is `runInputs` in `contracts/projects/v1.ts` (`validateRunInputs`) with a fixture in `contracts/projects/examples.ts`; `reviewResult` findings now carry `requirement_found_in`. Read `features/run-inputs/README.md` for the seeded export shape the candidate-mode tests must write. The review panel from slice B already exists; extend it, do not rebuild it.

## Ownership

Only edit the UI-owned paths in the attached policy: `src/App.tsx`, `src/App.css`, `src/graph/`, `src/projects/`, `src/index.css` and `tests/project-workflows/`. The backend owns `server/` and `config/projects.example.json`; do not edit them. Render Markdown with `src/document/Markdown.tsx` by import only. If a necessary change falls outside ownership, stop and ask Pi/the operator rather than crossing the boundary.

## Deliverables

- `src/projects/api.ts`: `paths.inputs(scope)` and `fetchRunInputs(scope, signal)` validating with `validateRunInputs`. A 404 with code `INPUTS_NOT_FOUND` is the normal "not recorded" state, not an error panel.
- Run view: tabs above the graph (`role="tablist"`, `aria-label="Run views"`) `Run` (`data-testid="tab-run"`) and `Assignment` (`data-testid="tab-assignment"`), default Run. When inputs load, the run header facts gain Feature, Base commit (short), Source branch, Mode (`automatic` / `manual`) and, for automatic runs, Deadlines (`worker 4h · review 30m`, computed from seconds), Permission mode and Finish (`data-testid="run-inputs-facts"`). When inputs are absent: `<p data-testid="inputs-none">Inputs not recorded for this run (the export predates run inputs; re-export it with the workflow CLI).</p>` in the header and on the Assignment tab.
- Assignment tab (`data-testid="assignment"`): feature, branch, mode, deadlines, setup commands (`assignment-setup`, each as `<code>`), attempt cap, and one section per worker (`assignment-worker` with `data-worker`) with the task rendered as Markdown inside `assignment-task`, owned paths and required checks.
- Worker nodes (`launch_ui` / `launch_adapter`, matched by `worker.launch_node_id === node.node_id`):
  - "Task" panel `task-panel` with a `Rendered` / `Source` toggle (buttons with `aria-pressed`); source is `<pre data-testid="task-source">` with the exact text; a `truncated: true` text shows a note. When a highlight quote is active the panel is forced to Source, the quote is wrapped in `<mark data-testid="task-highlight">` and scrolled into view (`scrollIntoView({block: 'center'})`) once mounted. Below the task: owned paths (`task-owned-paths`) and required checks (`task-checks`, each row `data-check-id`; when the node's worker result is loaded, a check whose `command` equals an executed check's `command` links to it by `href="#check-<index>"` and shows its exit code, otherwise "not executed in this result"). The executed checks list gets `id="check-<index>"` anchors.
  - "Exact prompt" `<details data-testid="task-prompt">` when `prompt` is not null.
  - "Launch receipt" `launch-receipt`: session id, requested and native start times, observed state, launcher invocations; replaces "No session recorded" when present.
  - "Reported by the worker" `worker-completion`: status, summary, open assumptions; "No completion signal recorded" when null.
  - "Handoff as accepted" `worker-handoff` only when it differs from the completion.
  - Timeline addition `worker-stop`: "Stop confirmed at …" or "Stop not confirmed".
- Review panel: each finding's Requirement cell shows the quote in `<q data-testid="finding-requirement">`; when `requirement_found_in` includes a lane, an `AppLink` `finding-task-link` with `data-lane` to that lane's launch node that also asks the run view to highlight the quote there (`RunView` keeps `pendingHighlight: {nodeId, quote} | null`; the link sets it and navigates; `NodeDetail` receives the highlight for the selected node and clears it once applied; navigating elsewhere clears it). A quote not found verbatim shows the quote and `<span data-testid="finding-task-unlinked">not found verbatim in the task</span>`. A null requirement shows "—".
- Preserve Pi/Claude browsing, Back/Forward, existing file operations and unsaved-edit guards. Add no launch, approve, retry or delete controls.

## Browser tests and isolation

Extend `tests/project-workflows/` so that every scenario ID in `features/run-inputs/policy.json` appears in exactly one test title with a `screenshot:<id>` PNG attachment: the ten scenarios carried over from `review-result` plus `run-assignment`, `worker-inputs`, `finding-to-task`, `inputs-legacy` and `inputs-paths-redacted` (the PRD table calls the last one `paths-redacted`; the browser suite needs a unique ID per test title, hence the prefix). Keep `WORKFLOW_VERIFICATION_PHASE` semantics:

- `worker`: mock only `/api/projects/**` success responses from contract-validated fixtures; serve `.../inputs` (404 `INPUTS_NOT_FOUND` when absent). Mock payloads are already the projected shape, so they carry the literal `<path>`.
- `candidate`: no mocked project success routes. Seed `run-state.json` version `1.2.0` with the `inputs` section from the feature README (raw task texts containing an absolute path so the real adapter redacts it), keep the legacy `1.0.0` run without the section, start the real backend and test the same scenarios against it.

Inputs fixtures: automatic runs with realistic worker tasks (Markdown with headings, a list and the appended `Approved ownership and checks:` JSON line), one worker with a `prompt` and one with `prompt: null`, launch receipts, completion signals, a handoff that differs from the completion for one worker, stop confirmed for both. At least two review findings carry `worker: 'ui'` and a `requirement` that is a verbatim substring of the seeded ui task (`requirement_found_in: ['ui']`), one a quote that is not found (`[]`), one `worker: 'none'` with a null requirement. `finding-to-task` clicks a linked quote, lands on `/nodes/launch_ui`, asserts `task-highlight` contains the quote and is visible, and that the unlinked quote shows `finding-task-unlinked`. Both phases must pass without skipping.

Pick free ports and temporary roots in the config, never reuse an existing server, clean up owned temporary directories, and do not modify the root Playwright configuration. No new package dependencies are authorized.

## Finish

Report a concise summary, complete changed-file list and open assumptions. In manual mode wait for the operator's explicit freeze. In automatic mode follow the appended completion-file protocol and finish your turn without waiting for a human. Do not commit, merge, push, spawn agents or write outside your own worktree. Do not edit shared verification fixtures/contracts to make tests pass.
