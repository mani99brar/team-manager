/**
 * Fixtures of viewer UX slice S4-core, the node shell (`ux-node.spec.ts`) (docs/PRD_VIEWER_UX.md 12.2), registered as
 * the workflow `ux-node`: mock payloads for the worker phase and a `seed` for the candidate phase, merged by
 * `index.ts`. Empty until its slice adds them. S4-core adds a verify node at attempt 3 with results 1 to 3, where 1
 * and 2 carry the same `error.message`.
 */
import type { UxFixtureModule } from './index.ts'

export const uxNode: UxFixtureModule = {}
