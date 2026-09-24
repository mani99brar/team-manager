/**
 * Fixtures of viewer UX slice S4c, review, challenge and controller nodes (`ux-review.spec.ts`) (docs/PRD_VIEWER_UX.md
 * 12.2), registered as the workflow `ux-review`: mock payloads for the worker phase and a `seed` for the candidate
 * phase, merged by `index.ts`. Empty until its slice adds them. S4c adds a native review with one running reviewer,
 * and a succeeded approval with no event.
 */
import type { UxFixtureModule } from './index.ts'

export const uxReview: UxFixtureModule = {}
