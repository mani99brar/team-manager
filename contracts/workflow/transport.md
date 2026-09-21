# Local workflow transport, initial implementation

This document pins the UI/backend seam for the first implementation. Existing v1 schemas remain unchanged.

## Boundaries

- Python owns `workflow/`: LangGraph, executor/session persistence, worktree allocation, verification, HTTP API, backend tests.
- UI owns `src/workflow/`, a minimal navigation hook in `src/App.tsx`, workflow-only styles/tests, and a Vite proxy configuration. Existing Markdown-manager behavior must remain intact.
- The backend listens on loopback port 8766. The UI uses same-origin `/api/workflows` requests (Vite proxies to loopback). No public agent execution endpoint is enabled by default.

## Read API

- `GET /api/workflows/runs` -> `{ "runs": RunSnapshot[] }`
- `GET /api/workflows/runs/{run_id}` -> `RunSnapshot`
- `GET /api/workflows/runs/{run_id}/events?after=0` -> `{ "events": WorkflowEvent[] }`, ordered by sequence. Polling is acceptable initially; clients deduplicate and advance the cursor only for accepted events.
- `GET /api/workflows/runs/{run_id}/results/{node_id}/{attempt}` -> `WorkerResult`
- `GET /api/workflows/runs/{run_id}/artifacts/{artifact_id}` -> immutable artifact content, resolved only from a backend-owned registry; never arbitrary filesystem paths.
- Errors -> `{ "error": { "code": string, "message": string } }` with appropriate HTTP status.
- IDs used in URL paths are opaque and percent-encoded by the client. Backend validates identity and prevents path traversal.

`result_uri` and artifact `uri` exposed to this UI should use these same-origin API paths. Payloads conform to the committed schemas. Raw logs/paths/secrets must not be published without sanitization.

## Controls

`POST /api/workflows/runs/{run_id}/controls` accepts the v1 `ControlRequest`, returns `202 { "request_id": string, "accepted": true }` only after validation/persistence. Duplicate identical requests are idempotent; conflicting reuse or stale sequence returns 409. Unsupported actions fail explicitly, never imply execution.

Controls require an explicitly configured backend token sent as `Authorization: Bearer ...`; the UI accepts an optional in-memory token entered by the user, never persists it. Server checks Origin (same-origin only), binds loopback and rejects controls if no token is configured. CLI is the initial authority for starting runs and explicitly enabling live Claude execution. Remote clients use an SSH tunnel; do not expose an unauthenticated execution service.

## Acceptance

Viewer shows graph/dependencies, timeline, attempts/reuse, checks, changed files, assumptions, artifacts, approval/failure states and connection errors. Include explicitly labelled fixture/demo mode for offline development, never silently substitute demo data for a failed live request.

Backend supports a tested fake executor plus opt-in real Claude runner. Preserve session identity and partial diffs; uncertain process recovery must block rather than relaunch writers blindly. Verification cannot pass without executed required checks; browser checks and review remain explicit gates. Human/Pi approval is distinct from actual merge; do not silently merge or push.

Document unsupported controls or live integration limitations honestly. No worker may change the frozen contract during this implementation wave; report necessary changes to the parent.
