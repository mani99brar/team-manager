# Adapter worker: project registry and read-only workflow/run APIs

Implement `contracts/projects/README.md` using the existing Fastify server. Read `features/project-workflows/README.md` for the exact registry and runtime export seam. Keep the frozen contracts and runtime engine unchanged.

## Ownership

Only edit `server/` and `config/projects.example.json`. Do not modify UI, `workflow/`, contracts, feature policy, package manifests, or the root browser configuration. Use existing Node/Fastify/Zod dependencies. Escalate necessary changes outside ownership to Pi/the operator.

## Deliverables

- Optional startup configuration `MD_MANAGER_PROJECTS_CONFIG`, with the exact shape in the feature README. Unset means an empty project registry; invalid explicitly supplied configuration fails startup. Keep existing skill-location configuration and API behavior unchanged.
- All project-scoped read endpoints in the committed API contract: projects, definitions, paginated runs, pinned run detail, events, worker results and registered artifacts.
- Inject registry configuration through an optional `createApp` option for tests; preserve existing `createApp(locations, options)` compatibility and legacy route error shapes. New endpoints use the new contract's error shape.
- Read actual persisted `run-state.json`, `plan.json`, events and verification packets under configured run roots. Do not execute Python, spawn processes or write run storage in response to a read request. Do not decode SQLite or infer successful work from a CLI exit/Claude idle state.
- Associate runs solely through the configured project/workflow/root tuple. Reject malformed or contradictory identity/definitions. Keep run definitions pinned even if a workflow's current definition changes. Legacy runs without supported exports must not be silently displayed as successful.
- Map registered artifacts safely through packet registries: path confinement, symlink escape protection, hash checks, bounded reads, correct MIME types and safe errors without absolute path disclosure. No arbitrary URI fetches or raw directory serving.
- Support an empty project and an empty workflow; distinguish those from missing scopes/errors. Do not silently substitute demo data in production.
- Include an illustrative `config/projects.example.json` explaining configurable repository/run paths without embedding this machine's private paths as defaults.

## Verification

Create `server/projects.test.ts`, executed directly by the policy's tsx command. Tests must use disposable roots, not live application or workflow data. Cover configuration, read-only methods, schema conformance, project/workflow/run isolation, graph/summary identity, actual runtime state projection, old/pinned definitions, pagination, malformed/missing files, and artifact traversal/symlink/hash failures. Existing app tests must still pass without project configuration.

Use producer fixtures described in the feature README, not a newly invented storage format. Frontend candidate-mode browser tests will start your real API with that registry format. Your isolated worker checks do not depend on frontend changes; combined-candidate checks validate integration later.

No new dependencies or permission bypasses are authorized. Shell tools are disabled in your worker session; the trusted verifier runs your unit/contract/build checks after handoff. Do not claim tests were executed if they were not.

## Finish

Report a summary, all changed files, checks actually executed (or explicitly none), and open assumptions. Wait for the operator to freeze. Do not commit, push, merge, launch other agents or modify shared contracts/runtime.
