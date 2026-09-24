/**
 * Fixtures of viewer UX slice S3, the run page (`ux-run.spec.ts`) (docs/PRD_VIEWER_UX.md 12.2), registered as the
 * workflow `ux-run`: mock payloads for the worker phase and a `seed` for the candidate phase, merged by `index.ts`.
 * Empty until its slice adds them. S3 adds node-less diagnosis, repair and PID events; a two-lane candidate that
 * failed identically twice without a review or a diagnosis event; an interrupted run with a controller row, with a
 * review note only and with a freeze note; a repair continuation; a blocked-before-freeze run with a deadline row; and
 * a pane-attention `interactive` event.
 */
import type { UxFixtureModule } from './index.ts'

export const uxRun: UxFixtureModule = {}
