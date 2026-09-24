/**
 * Fixtures of viewer UX slice S4a, verification and the candidate (`ux-verify.spec.ts`) (docs/PRD_VIEWER_UX.md 12.2),
 * registered as the workflow `ux-verify`: mock payloads for the worker phase and a `seed` for the candidate phase,
 * merged by `index.ts`. Empty until its slice adds them. S4a adds a candidate with a rejected exit-0 check, and a
 * worker attempt with an unkeyed `Executed check failed: <path> …` reason.
 */
import type { UxFixtureModule } from './index.ts'

export const uxVerify: UxFixtureModule = {}
