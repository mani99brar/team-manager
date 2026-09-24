/**
 * Fixtures of viewer UX slice S4b, the launch node (`ux-launch.spec.ts`) (docs/PRD_VIEWER_UX.md 12.2), registered as
 * the workflow `ux-launch`: mock payloads for the worker phase and a `seed` for the candidate phase, merged by
 * `index.ts`. Empty until its slice adds them. S4b adds a result pair with a repair-changed file, a waiting question
 * and a running worker.
 */
import type { UxFixtureModule } from './index.ts'

export const uxLaunch: UxFixtureModule = {}
