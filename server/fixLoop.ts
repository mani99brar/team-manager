/**
 * The in-run fix loop (export 1.10.0, docs/PRD_VIEWER_REFINE.md Appendix A): the mapping from the controller's records
 * (`repairs.json`, `review-rounds.json`, the repair receipts and the archived `review.round-<k>.json`) onto the contract's
 * `fixLoop`. It exists twice, here and in `workflow/export_state.py`; both are tested against the same files under
 * `contracts/projects/examples/fix-loop/` (the real journals of run `worker-skills-001` and the record they must produce),
 * so a change that moves one side fails the other's test.
 *
 * The journal is read leniently: the keys the mapping needs are checked and every other key is ignored (the shape of an
 * entry depends on its status and on the controller's version). A needed key that is missing or mistyped is a
 * `FixLoopError`; whether the loop the mapping produced is acceptable is the strict schema's decision (`validateFixLoop`).
 */
import { basename } from 'node:path'
import { REPAIR_STATUSES, REPAIR_TRIGGERS, type FixLoop, type FixLoopReviewRound, type RepairEntry } from '../contracts/projects/v1.ts'

export const REPAIRS_FILE = 'repairs.json'
export const REVIEW_ROUNDS_FILE = 'review-rounds.json'
export const REPAIR_BYTE_LIMIT = 4 * 1024 * 1024
export const DEFAULT_REVIEWER = 'review'

export class FixLoopError extends Error {}

type Json = Record<string, unknown>

function object(value: unknown): Json | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Json : null
}

function text(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function strings(value: unknown): string[] {
  return list(value).filter((item): item is string => typeof item === 'string')
}

function integer(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) ? value : null
}

/** The pinned step a repair answers, as the repair node's `depends_on` names it. */
export function blockedStep(trigger: string, lane: string): string {
  return trigger === 'verify' ? `verify_${lane}` : trigger
}

const DELTA_BRIEF = /^review\.delta(?:\.round-\d+)?\.diff$/

/** The session entries of `repairs.json` (an operator's `--commit` repair has no trigger or round and is never listed). */
export function mapRepairs(raw: unknown, receipt: (n: number) => unknown): RepairEntry[] {
  const journal = object(raw)
  if (!journal || !Array.isArray(journal.repairs)) throw new FixLoopError('repairs.json has no repairs list')
  const repairs: RepairEntry[] = []
  for (const item of journal.repairs) {
    const entry = object(item)
    if (!entry) throw new FixLoopError('repairs.json holds an entry that is not an object')
    if (entry.mode !== 'session') continue
    const n = integer(entry.n)
    if (n === null) throw new FixLoopError('a repair entry has no n')
    const need = (key: string, value: unknown) => {
      if (value === null || value === undefined) throw new FixLoopError(`repair ${n} has no ${key}`)
      return value
    }
    const status = text(entry.status)
    if (status === null || !(REPAIR_STATUSES as readonly string[]).includes(status)) throw new FixLoopError(`repair ${n} has a status the viewer does not know`)
    const trigger = text(entry.trigger)
    if (trigger === null || !(REPAIR_TRIGGERS as readonly string[]).includes(trigger)) throw new FixLoopError(`repair ${n} has no known trigger`)
    const lanes = object(entry.lanes)
    if (!lanes || Object.keys(lanes).length !== 1) throw new FixLoopError(`repair ${n} does not name exactly one lane`)
    const lane = Object.keys(lanes)[0]
    const step = blockedStep(trigger, lane)
    const packets = list(object(entry.blocked)?.packets).map(object).filter((packet): packet is Json => packet !== null)
    const reentered = trigger === 'verify'
      ? [...new Set(packets.flatMap(packet => typeof packet.node_id === 'string' ? [`verify_${packet.node_id}`] : []))]
      : []
    const brief = object(entry.brief)
    const delta = text(brief?.delta)
    const session = object(entry.session)
    const requested = object(object(receipt(n))?.requested)
    const own = packets.find(packet => packet.node_id === lane)
    const round = integer(need('round', entry.round))
    const rounds = integer(need('rounds', entry.rounds))
    if (round === null || rounds === null) throw new FixLoopError(`repair ${n} has a round or rounds that is not a number`)
    repairs.push({
      n, node_id: `repair-${n}`, mode: 'session', lane, trigger: trigger as RepairEntry['trigger'], round, rounds,
      status: status as RepairEntry['status'],
      by: need('by', entry.by) as RepairEntry['by'],
      ...(entry.via !== undefined ? { via: entry.via as 'claude-code' } : {}),
      recorded_at: need('recorded_at', text(entry.recorded_at)) as string,
      applied_at: text(entry.applied_at),
      blocked_step: step, reentered_steps: reentered.length > 0 ? reentered : [step], reason: text(entry.reason),
      workspace_commit: need('workspace_commit', text(entry.workspace_commit)) as string,
      session_id: text(session?.session_id),
      review_round: integer(entry.review_round),
      findings: list(brief?.findings) as RepairEntry['findings'],
      delta: delta !== null && DELTA_BRIEF.test(basename(delta)),
      fix_files: strings(object(lanes[lane])?.fix_files),
      left_behind: strings(entry.left_behind),
      requested: requested ? { model: requested.model as string | null, effort: requested.effort as NonNullable<RepairEntry['requested']>['effort'] } : null,
      gate_reasons: strings(own?.reasons),
    })
  }
  return repairs
}

/** The reviewers of an archived round (`review.round-<k>.json`); a record before parallel reviewers has the single reviewer `review`. */
export function mapRoundReviewers(archive: unknown): FixLoopReviewRound['reviewers'] {
  const review = object(archive)
  if (!review) return []
  const recorded = Array.isArray(review.reviewers) ? review.reviewers : [{ reviewer_id: DEFAULT_REVIEWER, session_id: review.reviewer, verdict: review.verdict }]
  return recorded.flatMap(item => {
    const entry = object(item)
    if (!entry || typeof entry.reviewer_id !== 'string') return []
    return [{ reviewer_id: entry.reviewer_id, verdict: entry.verdict === 'approved' || entry.verdict === 'blocked' ? entry.verdict : null, session_id: text(entry.session_id) }]
  })
}

export function mapReviewRounds(raw: unknown, repairs: readonly RepairEntry[], archive: (round: number) => unknown): FixLoopReviewRound[] {
  const record = object(raw)
  if (!record || !Array.isArray(record.rounds)) throw new FixLoopError('review-rounds.json has no rounds list')
  return record.rounds.map(item => {
    const entry = object(item)
    const round = integer(entry?.round)
    if (!entry || round === null) throw new FixLoopError('review-rounds.json holds a round without a number')
    for (const key of ['verdict', 'candidate', 'lane', 'started_at'] as const) {
      if (typeof entry[key] !== 'string') throw new FixLoopError(`review round ${round} has no ${key}`)
    }
    if (!Array.isArray(entry.findings) || !Array.isArray(entry.reviewer_sessions) || typeof entry.archived !== 'boolean') {
      throw new FixLoopError(`review round ${round} has no findings, sessions or archived flag`)
    }
    return {
      round, verdict: entry.verdict as FixLoopReviewRound['verdict'], candidate: entry.candidate as string, lane: entry.lane as string,
      findings: entry.findings as FixLoopReviewRound['findings'], reviewer_sessions: strings(entry.reviewer_sessions),
      started_at: entry.started_at as string, archived: entry.archived, restored_at: text(entry.restored_at),
      repair_n: repairs.find(repair => repair.review_round === round)?.n ?? null,
      reviewers: entry.archived ? mapRoundReviewers(archive(round)) : [],
    }
  })
}

/** Archived rounds counted for the review node's attempt: one plus the rounds with `archived: true`. */
export function archivedRounds(loop: FixLoop | null | undefined): number {
  return loop && 'review_rounds' in loop ? loop.review_rounds.filter(round => round.archived).length : 0
}

/** Every string of a value with absolute paths redacted (the project API never forwards one). */
export function redactDeep<T>(value: T, redact: (text: string) => string): T {
  if (typeof value === 'string') return redact(value) as T
  if (Array.isArray(value)) return value.map(item => redactDeep(item, redact)) as T
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactDeep(item, redact)])) as T
  return value
}
