/**
 * Fixtures of viewer UX slice S6, the run lists (`ux-lists.spec.ts`) (docs/PRD_VIEWER_UX.md 12.2), registered as the
 * workflow `ux-lists`: mock payloads for the worker phase and a `seed` for the candidate phase, merged by `index.ts`.
 * Empty until its slice adds them. S6 adds its own run with a live `<lane>.questions.json`, a pane event and a
 * controller PID, and the registry key `viewer.expose_run_dir` for the seeded project (returned as `registry` from its
 * seed).
 */
import type { UxFixtureModule } from './index.ts'

export const uxLists: UxFixtureModule = {}
