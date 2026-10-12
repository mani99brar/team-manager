import { z } from 'zod'

/**
 * The run-sessions contract (1.13.0, docs/PRD_RUN_SESSIONS.md Appendix A), served at
 * `GET /api/projects/:project_id/workflows/:workflow_id/runs/:run_id/sessions` (GET and HEAD). Every session that worked
 * on a run — the design challenge's print jobs, the lane workers, the fix loop's repairs, the lane reviewers, the
 * independent reviewers and the critique, sidecar passes, attack angles, the multi-provider panel's providers and the
 * night-shift panel's providers — becomes a row, grouped by role, with its model, cost, times and session id; the lane
 * reviews and the night-shift decisions carry their own detail. The server reads the per-session files live from the run
 * directory and the night-shift folder (`server/sessions.ts`, `server/nightShift.ts`); a missing or malformed file makes a
 * fact `null` or drops one row, never an error for the run. Nothing here is a transcript, an absolute path or a credential.
 *
 * This module is self-contained (it imports only zod) so `contracts/projects/v1.ts` can add `sessions: sessionsSchema` to
 * its `schemas` map — the export writer and the contract test cover it — without an import cycle.
 */

/** A graph node id as the run detail pins or projects it (`reviewer-<id>`, `panel`, `lane-review-<lane>-<n>`, `repair-<n>`). */
const nodeId = z.string().min(1)
const timestamp = z.iso.datetime()

/** The roles a session can have (PRD 3.4, 4); every role of a run becomes rows of its kind. */
export const SESSION_ROLES = [
  'challenge', 'worker', 'repair', 'lane_reviewer', 'reviewer', 'critique', 'sidecar', 'attack', 'panel_provider', 'night_shift',
] as const

/** A session's status as its files record it, normalised; `unknown` when no file holds one. */
export const SESSION_STATUSES = ['running', 'succeeded', 'failed', 'stopped', 'unknown'] as const

/**
 * How a session's cost should be read: `metered` dollars a Claude session reported ("reported by Claude", since no file says
 * whether the account pays per token, [L1]), or a `covered` subscription estimate (pi providers such as `openai-codex`, as
 * contract 1.9.0 labels them); null when no cost is recorded ([P11]).
 */
export const SESSION_COST_KINDS = ['metered', 'covered'] as const

/** A finding count split by severity; null when the session records no findings of its own. */
const findingsSchema = z.strictObject({
  p0: z.number().int().nonnegative(),
  p1: z.number().int().nonnegative(),
  p2: z.number().int().nonnegative(),
}).nullable()

/**
 * The copyable resume command for a Claude Code session (PRD 3.5): `dir` is the `~`-relative working directory the command
 * `cd`s into (null when none is composed into the command), `command` the whole line. Composed by the server after redaction
 * and exempt from `redactPaths`; never present for a pi, openrouter or night-shift session.
 */
const resumeSchema = z.strictObject({
  dir: z.string().nullable(),
  command: z.string().min(1),
}).nullable()

export const sessionRowSchema = z.strictObject({
  /** Stable within the run: `worker:server`, `reviewer:general:2`, `lane:viewer:1:1`, `challenge:2`, `night:approval:0`, ... */
  key: z.string().min(1),
  role: z.enum(SESSION_ROLES),
  label: z.string().min(1),
  node_id: nodeId.nullable(),
  lane: z.string().nullable(),
  /** A review round, lane-review round, challenge attempt, repair, sidecar or attack number; null when it carries none. */
  round: z.number().int().positive().nullable(),
  transport: z.string().nullable(),
  model: z.string().nullable(),
  status: z.enum(SESSION_STATUSES),
  /** Reviewers: approved | blocked | late blocked ...; panel and night shift: the chosen option; null otherwise. */
  verdict: z.string().nullable(),
  findings: findingsSchema,
  started_at: timestamp.nullable(),
  ended_at: timestamp.nullable(),
  duration_seconds: z.number().nonnegative().nullable(),
  cost_usd: z.number().nonnegative().nullable(),
  cost_kind: z.enum(SESSION_COST_KINDS).nullable(),
  /** Only an id matching the export's ID pattern; null otherwise. */
  session_id: z.string().min(1).nullable(),
  /** Claude Code sessions only (PRD 3.5); null for every other session. */
  resume: resumeSchema,
})

/** The totals line (PRD 3.4): metered Claude dollars and covered estimates apart, and how many costs are not recorded. */
export const sessionTotalsSchema = z.strictObject({
  metered_usd: z.number().nonnegative(),
  covered_usd: z.number().nonnegative(),
  not_recorded: z.number().int().nonnegative(),
})

export const LANE_REVIEW_SEVERITIES = ['P0', 'P1', 'P2'] as const

const laneReviewFindingSchema = z.strictObject({
  severity: z.enum(LANE_REVIEW_SEVERITIES),
  file: z.string().nullable(),
  line: z.number().int().nonnegative().nullable(),
  title: z.string(),
  detail: z.string(),
})

const laneReviewReviewerSchema = z.strictObject({
  transport: z.string(),
  model: z.string().nullable(),
  status: z.string(),
  duration_seconds: z.number().nonnegative().nullable(),
  cost_usd: z.number().nonnegative().nullable(),
  error: z.string().nullable(),
})

/**
 * Whether a lane-review round started a fix round (PRD 3.2): `started` with the repair node the record's own `repair` number
 * names, else `not started` with the reason the engine recorded — the `lane_review:` event's words when the gate refused,
 * "no P0/P1" for a clean round, "the review failed: <first line>" for a failed record, else the round's own latest event
 * words or "not recorded".
 */
const fixRoundSchema = z.union([
  z.strictObject({ started: z.literal(true), repair_node_id: nodeId.nullable() }),
  z.strictObject({ started: z.literal(false), reason: z.string().min(1) }),
])

export const laneReviewSchema = z.strictObject({
  lane: z.string().min(1),
  round: z.number().int().positive(),
  node_id: nodeId,
  snapshot: z.string(),
  status: z.string(),
  started_at: timestamp.nullable(),
  ended_at: timestamp.nullable(),
  fix_round: fixRoundSchema,
  reviewers: z.array(laneReviewReviewerSchema),
  findings: z.array(laneReviewFindingSchema),
})

const nightShiftProviderSchema = z.strictObject({
  name: z.string().min(1),
  option: z.string().nullable(),
  text: z.string().nullable(),
  /** The record's own word ("high", "medium") or null (PRD 4, [P1]). */
  confidence: z.string().nullable(),
  needs_operator: z.boolean().nullable(),
  /** The provider's metered cost for the decision; null when the record holds none (note 1d). */
  cost_usd: z.number().nonnegative().nullable(),
  error: z.string().nullable(),
})

/** Jev's pick (from `jev.json`), its error form, or null when the empty forms or a missing key ([P1]). */
const jevSchema = z.union([
  z.strictObject({ pick: z.string().min(1), confidence: z.number().nullable(), pass_floor: z.boolean().nullable() }),
  z.strictObject({ error: z.string().min(1) }),
]).nullable()

export const nightShiftDecisionSchema = z.strictObject({
  kind: z.string().min(1),
  node_id: nodeId.nullable(),
  /** The time in the record's `key`, else null. */
  decided_at: timestamp.nullable(),
  providers: z.array(nightShiftProviderSchema),
  /** agree | split | one provider ... (the record's own word). */
  agreement: z.string().min(1),
  jev: jevSchema,
  decision: z.enum(['executed', 'held']),
  option: z.string().nullable(),
  /** The redacted command that was run; null when held. */
  command: z.string().nullable(),
  held_reason: z.string().nullable(),
})

export const sessionsSchema = z.strictObject({
  contract_version: z.literal('1.13.0'),
  sessions: z.array(sessionRowSchema),
  totals: sessionTotalsSchema,
  lane_reviews: z.array(laneReviewSchema),
  night_shift: z.array(nightShiftDecisionSchema),
})

export type SessionRow = z.infer<typeof sessionRowSchema>
export type SessionTotals = z.infer<typeof sessionTotalsSchema>
export type LaneReview = z.infer<typeof laneReviewSchema>
export type LaneReviewFinding = z.infer<typeof laneReviewFindingSchema>
export type LaneReviewReviewer = z.infer<typeof laneReviewReviewerSchema>
export type NightShiftDecision = z.infer<typeof nightShiftDecisionSchema>
export type NightShiftProvider = z.infer<typeof nightShiftProviderSchema>
export type Sessions = z.infer<typeof sessionsSchema>

/**
 * The served sessions payload's cross-field rules: unique session keys and unique lane-review node ids, a decided/held
 * decision carries a command exactly when it executed, and the totals' `not_recorded` counts the rows with no cost.
 */
export function validateSessions(input: unknown): Sessions {
  const payload = sessionsSchema.parse(input)
  const keys = payload.sessions.map(session => session.key)
  if (new Set(keys).size !== keys.length) throw new Error('Duplicate session keys')
  const laneNodes = payload.lane_reviews.map(review => review.node_id)
  if (new Set(laneNodes).size !== laneNodes.length) throw new Error('Duplicate lane-review node ids')
  for (const decision of payload.night_shift) {
    if ((decision.decision === 'executed') !== (decision.command !== null)) {
      throw new Error('A night-shift decision carries a command exactly when it executed')
    }
  }
  return payload
}
