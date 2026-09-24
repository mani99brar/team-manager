/**
 * Fixtures of viewer UX slice S1, time and freshness (`ux-time.spec.ts`) (docs/PRD_VIEWER_UX.md 12.2), registered as the
 * workflow `ux-time`: mock payloads for the worker phase and a `seed` for the candidate phase, merged by `index.ts`. S1's
 * scenarios read the existing runs, so it adds none.
 */
import type { UxFixtureModule } from './index.ts'

export const uxTime: UxFixtureModule = {}
