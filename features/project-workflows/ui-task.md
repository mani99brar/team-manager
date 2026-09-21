# UI worker: Projects, workflow graphs and run inspection

Implement the read-only feature specified by `contracts/projects/README.md`. Read `features/project-workflows/README.md` for the frozen producer/registry seam and test requirements. Do not redesign the runtime or change contracts/policy/package manifests.

## Ownership

Only edit the UI-owned paths in the attached policy: `src/App.tsx`, `src/App.css`, `src/graph/`, `src/projects/`, `src/index.css`, and `tests/project-workflows/`. The backend owns `server/` and `config/projects.example.json`; do not edit them. If a necessary change falls outside ownership, stop and ask Pi/the operator rather than crossing the boundary.

## Deliverables

- Add a Projects root alongside Pi and Claude in the existing browsing experience. Keep the Pi/Claude Source type and filesystem-mutation restrictions intact; Projects is a different read-only domain, not a third writable skills source.
- Project → workflow → run navigation, pinned definition graph, run list and node/evidence details. Use committed project/workflow schemas to validate data before rendering.
- Show statuses, attempts, explicit reuse evidence, changed files, actual checks, assumptions, logs and screenshots. A native worker turn ending is not workflow completion.
- Loading, empty-project, empty-run-list, failed/awaiting-approval and backend-error views. No silent demo fallback. Preserve browser Back/Forward, existing file operations and unsaved-edit guards.
- Accessible keyboard navigation, labels and a practical narrow-screen layout. Do not add launch, approve, retry or deletion controls.

## Browser tests and isolation

Create `tests/project-workflows/playwright.config.ts` and browser tests containing all six scenario IDs from `features/project-workflows/policy.json`.

Read `WORKFLOW_VERIFICATION_PHASE` from the environment:

- `worker`: backend implementation is absent in this worktree. Mock only the new `/api/projects/**` endpoints using explicit contract fixtures. Still run the real UI in Chromium and leave existing Pi/Claude routes backed by the isolated existing API harness.
- `candidate`: **do not mock project success responses**. Seed temporary project/run/artifact data and the registry configuration according to the feature README, start the real combined backend, and test the same scenarios against it. Intentional network-error injection is allowed only for the error scenario.

Create your own temporary roots/server ports for this config. Use `MD_MANAGER_API_PORT` and `MD_MANAGER_WEB_PORT` consistently with Vite and server configuration, never reuse an existing server, and clean up owned temporary directories. You can reuse the existing fixtures and helper patterns, but do not modify the root Playwright configuration or use live skills/project storage. Choose ports dynamically in test setup and retain the values for both started servers and browser context.

Each required test title must include exactly one `[scenario:<id>]` marker and attach one PNG named `screenshot:<id>` using `testInfo.outputPath` and `testInfo.attach`. See `workflow/RUNBOOK.md`. Do not skip tests in candidate mode, weaken assertions, or substitute a screenshot for testing interactions. Exercise registration isolation and run selection through the real adapter in candidate mode.

No new package dependencies are authorized. Existing React, d3-force, Zod and Playwright are available. Manual mode disables shell tools; automatic mode enables Bash as stated in your startup instructions. The trusted verifier independently executes checks after handoff regardless. Report checks as not executed if you could not execute them—never claim success from inspection.

## Finish

Report a concise summary, complete changed-file list and open assumptions. In manual mode wait for the operator's explicit freeze. In automatic mode follow the appended completion-file protocol and finish your turn without waiting for a human. Do not commit, merge, push, spawn agents or write outside your own worktree. Do not edit shared verification fixtures/contracts to make tests pass.
