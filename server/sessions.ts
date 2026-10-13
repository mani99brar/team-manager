import fs, { type FileHandle } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import { z } from 'zod'
import { DEFAULT_REVIEWER_ID, type FixLoop, type PanelResults, type ReviewResult, type WorkflowDefinition } from '../contracts/projects/v1.ts'
import type { RunSnapshot } from '../contracts/workflow/v1.ts'
import {
  laneReviewSchema, nightShiftDecisionSchema, sessionRowSchema, validateSessions,
  type LaneReview, type LaneReviewFinding, type LaneReviewReviewer, type NightShiftDecision, type SessionRow, type Sessions,
} from '../contracts/projects/sessions.ts'
import { at } from './files.ts'
import { ID_PATTERN } from './projectsConfig.ts'
import { readBounded, realpathOrNull, redactCredentials, redactText } from './projects.ts'
import type { NightShiftRead } from './nightShift.ts'

type NodeStatus = RunSnapshot['nodes'][number]['status']

/**
 * The run's sessions, lane reviews and projected stage nodes (docs/PRD_RUN_SESSIONS.md 3.1-3.4, 4). Every session that worked
 * on the run is read live from the run directory — the design challenge's print jobs, the lane workers, the fix loop's
 * repairs, the lane reviewers (one row per reviewer), the independent reviewers and the critique (the latest round from the
 * export, or from the live receipts while a round runs, and every archived round), sidecar passes, attack angles and the
 * panel's providers — and mapped onto a `session` row grouped by role, with its model, cost, times and session id; the
 * night-shift providers and Jev (read by `server/nightShift.ts`) are rows too. A missing or malformed file makes a fact
 * `null` (or drops one row), never an error for the run ([O2]): every row and entry passes one boundary pass (`redactText`
 * over every string but the resume command, then the strict contract) and is dropped alone when it still fails. Costs are
 * split: metered Claude dollars apart from the subscription-covered pi estimates ([P11]); the totals count the costs not
 * recorded.
 *
 * Which nodes exist comes from export-visible facts, so the mocked and the real server agree ([P2], [L1], [L4], [L11]): a
 * reviewer node per raw `review.reviewers` entry of the latest round (none when the review section lists none, and never the
 * adapter's synthetic `review` of an export before 1.4.0); while the review section is null and `review` is not pending, one
 * per `plan.json` reviewer (the single `review` for a 1.4.0+ plan that declares none); a `panel` node exactly when the panels
 * route answers; a lane-review node per `lane-review/<lane>/<n>.json` record. Each node's status comes from its own record
 * (the export entry, the `automatic-review-<id>.json` receipt, the panel record or the lane-review record).
 * `projectSessionNodes` is the one pure function both the server and the worker-phase mock call.
 */

const FIRST_LINE_LIMIT = 200
const FILE_BYTE_LIMIT = 4 * 1024 * 1024

function firstLine(text: string): string {
  return redactText(text).split('\n')[0]!.slice(0, FIRST_LINE_LIMIT)
}

async function readJson(directory: FileHandle, components: string[]): Promise<unknown> {
  let bytes: Buffer | null
  try {
    bytes = await readBounded(directory, components, FILE_BYTE_LIMIT)
  } catch {
    return undefined
  }
  if (bytes === null) return undefined
  try {
    return JSON.parse(bytes.toString('utf8'))
  } catch {
    return undefined
  }
}

/** The names of the regular files in one folder of the run directory (no symlink followed); [] when it is missing. */
async function listFiles(directory: FileHandle, components: readonly string[]): Promise<string[]> {
  try {
    const entries = await fs.readdir(join(at(directory), ...components), { withFileTypes: true })
    return entries.filter(entry => entry.isFile()).map(entry => entry.name)
  } catch {
    return []
  }
}

/** The numbers `n` of every `<prefix>-<n><suffix>` file in a folder, ascending. */
function numbered(names: readonly string[], prefix: string, suffix: string): number[] {
  const pattern = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-(\\d+)${suffix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`)
  return names.flatMap(name => {
    const match = pattern.exec(name)
    const n = match ? Number(match[1]) : NaN
    return Number.isSafeInteger(n) && n > 0 ? [n] : []
  }).sort((a, b) => a - b)
}

// ---- The resume command (PRD 3.5) ------------------------------------------------------------------------------

/** A session id the export's ID pattern accepts; null otherwise (never a resume command, [L3]). */
function sessionIdOf(value: unknown): string | null {
  return typeof value === 'string' && ID_PATTERN.test(value) ? value : null
}

export type ResumeContext = { exposed: boolean; home: string }

/**
 * The resume command for a Claude Code session (PRD 3.5, [P4], [P5], [L3], [L6]): `cd ~/'<rest>' && claude --resume <id>` for
 * an exposed project whose recorded working directory still exists under HOME and pastes safely, else `claude --resume <id>`
 * with the dir left null (the page adds "run it in the session's worktree"). Composed after redaction and exempt from it.
 * Returns null when the session id is not an ID-pattern id or is credential-shaped.
 */
export async function composeResume(sessionId: string | null, worktree: string | null, context: ResumeContext): Promise<SessionRow['resume']> {
  if (sessionId === null || !ID_PATTERN.test(sessionId)) return null
  // The command is exempt from redaction, so nothing credential-shaped may enter it: such an id gives no
  // command at all, and a credential-shaped directory the bare form.
  if (redactCredentials(sessionId) !== sessionId) return null
  const bare = { dir: null, command: `claude --resume ${sessionId}` }
  if (!context.exposed || worktree === null) return bare
  const [real, home] = await Promise.all([realpathOrNull(worktree), realpathOrNull(context.home)])
  if (real === null || home === null) return bare
  const inside = relative(home, real)
  if (!inside || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) return bare
  const rest = inside.split(sep).join('/')
  // A single quote or any control or format character (C0, C1, bidi overrides, zero-width, line separators) cannot be
  // pasted safely inside the quotes, or would show a directory other than the one pasted: the bare form ([P5]). Anything
  // else, spaces, non-ASCII letters and `$` included, is literal inside single quotes ([L12] 2).
  if (/['\p{Cc}\p{Cf}\u2028\u2029]/u.test(rest)) return bare
  const quoted = `~/'${rest}'`
  if (redactCredentials(quoted) !== quoted) return bare
  return { dir: quoted, command: `cd ${quoted} && claude --resume ${sessionId}` }
}

// ---- Status words (the controller's own, workflow/automatic.py, critique.py, lane_review.py, panel.py) -------------

/** A reviewer's state on the stage: its snapshot status and the word its card and rows say (PRD 3.1, 4, [L11] 2). */
export type ReviewerState = { status: NodeStatus; word: 'not started' | 'running' | 'decided' | 'failed' }

/**
 * A reviewer's state from the words the controller writes in `automatic-review(-<id>).json` (or the export entry's status):
 * pending or absent → not started; launching or running → running; accepted, succeeded or a `blocked` that records no error
 * → decided (a finished session, `succeeded`, never a failed step); a `blocked` with an `error` (a crash, a deadline, a
 * rejected file), `needs_reconciliation`, `superseded` and the critique's `failed` → decided as `failed`. An unknown word reads
 * as not started rather than claiming a verdict.
 */
export function reviewerStateOf(word: string | null | undefined, hasError: boolean): ReviewerState {
  switch (word) {
    case 'launching':
    case 'running':
      return { status: 'running', word: 'running' }
    case 'accepted':
    case 'succeeded':
      return { status: 'succeeded', word: 'decided' }
    case 'blocked':
      return { status: 'succeeded', word: hasError ? 'failed' : 'decided' }
    case 'needs_reconciliation':
    case 'superseded':
    case 'failed':
      return { status: 'succeeded', word: 'failed' }
    default:
      return { status: 'pending', word: 'not started' }
  }
}

/** A lane-review record's node status (PRD 3.2): running reads running, pending or none not started, decided `succeeded`. */
export function laneReviewNodeStatus(word: string | null | undefined): NodeStatus {
  if (word === 'running') return 'running'
  if (word === 'pending' || word === null || word === undefined) return 'pending'
  return 'succeeded'
}

/**
 * The panel node's status from the record the panels route serves: running while any panel runs, pending while every panel
 * is pending, otherwise decided (`succeeded`). The panel is report-only, so a failed or timed-out panel is a `succeeded` node
 * like a failed lane-review record (PRD 3.2, [L3]): its card says `failed` and its page says "The panel failed: …", and the
 * header's "The run cannot succeed without intervention." never shows for it.
 */
export function panelNodeStatus(panels: Pick<PanelResults, 'panels'>): NodeStatus {
  if (panels.panels.some(panel => panel.status === 'running')) return 'running'
  if (panels.panels.length === 0 || panels.panels.every(panel => panel.status === 'pending')) return 'pending'
  return 'succeeded'
}

// ---- The projected stage nodes ([L1], [P2], [G3]) ---------------------------------------------------------------

/** What `projectSessionNodes` is keyed on: export-visible facts only, so the mock and the server project the same nodes. */
export type SessionNodeInput = {
  /** Whether the export carries a review section (the latest round was decided and not yet archived). */
  reviewSection: boolean
  /** Whether the export is 1.4.0 or later: a plan that declares no reviewers then launches the single reviewer `review`. */
  exportAtLeast140: boolean
  /** The raw export `review.reviewers` of the latest round with each one's status; null when the section lists none. */
  rawReviewers: readonly { reviewer_id: string; status: string | null }[] | null
  /** The `plan.json` `reviewers[].reviewer_id`s as written; [] when the plan declares none. */
  planReviewerIds: readonly string[]
  /** Each reviewer's live receipt (`automatic-review(-<id>).json`): its status word and whether it records an error. */
  receipts: Readonly<Record<string, { status: string | null; error: boolean }>>
  /** The review node's snapshot status: while it is `pending`, no reviewer node is drawn from the plan. */
  reviewNodeStatus: NodeStatus | null
  /** The panel node's status when the panels route answers for this run (the `panel` node exists exactly then, [P3]); else null. */
  panelStatus: NodeStatus | null
  /** One per `lane-review/<lane>/<n>.json` record: its lane, round and recorded status. */
  laneReviews: readonly { lane: string; round: number; status: string | null }[]
  /** Every node id already in the pinned definition plus the repair nodes: a projected id that collides is refused. */
  existingNodeIds: ReadonlySet<string>
}

export type ProjectedNode = {
  node_id: string
  label: string
  kind: 'review'
  depends_on: string[]
  /** The snapshot status from the node's own record; a blocked reviewer or a failed lane review is `succeeded` (finished). */
  status: NodeStatus
  /** Which projected card this is, so owned frontend files can special-case it where kind `review` is matched ([L2]). */
  projected: 'reviewer' | 'panel' | 'lane_review'
  session_id: string | null
}

export const PANEL_NODE_ID = 'panel'
export { DEFAULT_REVIEWER_ID }
export function reviewerNodeId(reviewerId: string): string { return `reviewer-${reviewerId}` }
export function laneReviewNodeId(lane: string, round: number): string { return `lane-review-${lane}-${round}` }

/** Whether a node id is one of the sessions feature's projected cards (advisory in triage, special-cased in owned frontend). */
export function isProjectedSessionNode(nodeId: string | null): boolean {
  return nodeId === PANEL_NODE_ID || (typeof nodeId === 'string' && (nodeId.startsWith('reviewer-') || nodeId.startsWith('lane-review-')))
}

/**
 * The reviewer ids the stage draws (PRD 4, [L1], [L4], [L11] 1): the raw export list of the latest round while the review
 * section is present (none when it lists no reviewers — an export before 1.4.0 — never the adapter's synthetic `review`);
 * while the section is null and `review` is not pending, the plan's reviewers, or the single `review` for a 1.4.0+ plan that
 * declares none; otherwise none.
 */
export function projectedReviewerIds(input: Pick<SessionNodeInput, 'reviewSection' | 'exportAtLeast140' | 'rawReviewers' | 'planReviewerIds' | 'reviewNodeStatus'>): string[] {
  // A reviewer whose `reviewer-<id>` would break the node id pattern (over 128 characters) gets no node; its row falls to `review`.
  return drawnReviewerIds(input).filter(reviewerId => ID_PATTERN.test(reviewerNodeId(reviewerId)))
}

function drawnReviewerIds(input: Pick<SessionNodeInput, 'reviewSection' | 'exportAtLeast140' | 'rawReviewers' | 'planReviewerIds' | 'reviewNodeStatus'>): string[] {
  if (input.reviewSection) return (input.rawReviewers ?? []).map(entry => entry.reviewer_id)
  if (input.reviewNodeStatus === null || input.reviewNodeStatus === 'pending') return []
  if (input.planReviewerIds.length > 0) return [...input.planReviewerIds]
  return input.exportAtLeast140 ? [DEFAULT_REVIEWER_ID] : []
}

/** A projected reviewer's state: the export entry's status while the section is present, else its live receipt's. */
export function projectedReviewerState(input: Pick<SessionNodeInput, 'reviewSection' | 'rawReviewers' | 'receipts'>, reviewerId: string): ReviewerState {
  if (input.reviewSection) {
    const entry = input.rawReviewers?.find(candidate => candidate.reviewer_id === reviewerId)
    // The section's `blocked` hides how the session ended: the round's receipt says whether it recorded an error.
    return reviewerStateOf(entry?.status ?? null, input.receipts[reviewerId]?.error ?? false)
  }
  const receipt = input.receipts[reviewerId]
  return reviewerStateOf(receipt?.status ?? null, receipt?.error ?? false)
}

/**
 * The reviewer, panel and lane-review nodes a run's review step gains (PRD 4): reviewer and panel nodes depend on what
 * `review` depends on and `review` also depends on them; lane-review nodes depend on `verify_<lane>` and nothing depends on
 * them. The ids cannot collide with the export's (refused like a colliding repair id). The caller joins them into the run
 * detail (the way `insertRepairs` joins repair nodes) and gives the frontend mock the same set.
 */
export function projectSessionNodes(definition: WorkflowDefinition, input: SessionNodeInput): ProjectedNode[] {
  const nodes: ProjectedNode[] = []
  const reviewNode = definition.nodes.find(node => node.node_id === 'review')
  if (reviewNode) {
    const reviewDepends = reviewNode.depends_on
    for (const reviewerId of projectedReviewerIds(input)) {
      const id = reviewerNodeId(reviewerId)
      if (input.existingNodeIds.has(id) || nodes.some(node => node.node_id === id)) continue
      const state = projectedReviewerState(input, reviewerId)
      nodes.push({ node_id: id, label: `Reviewer · ${reviewerId}`, kind: 'review', depends_on: [...reviewDepends], status: state.status, projected: 'reviewer', session_id: null })
    }
    if (input.panelStatus !== null && !input.existingNodeIds.has(PANEL_NODE_ID)) {
      nodes.push({ node_id: PANEL_NODE_ID, label: 'Panel', kind: 'review', depends_on: [...reviewDepends], status: input.panelStatus, projected: 'panel', session_id: null })
    }
  }
  for (const record of input.laneReviews) {
    const id = laneReviewNodeId(record.lane, record.round)
    const verifyNode = `verify_${record.lane}`
    if (!ID_PATTERN.test(id) || input.existingNodeIds.has(id) || nodes.some(node => node.node_id === id) || !definition.nodes.some(node => node.node_id === verifyNode)) continue
    nodes.push({ node_id: id, label: `Lane review · ${record.lane} · round ${record.round}`, kind: 'review', depends_on: [verifyNode], status: laneReviewNodeStatus(record.status), projected: 'lane_review', session_id: null })
  }
  return nodes
}

// ---- Facts the projection reads from the run directory ----------------------------------------------------------

/** The `lane-review/<lane>/<n>.json` records on disk for each lane, ascending, with each record's status. */
export async function readLaneReviewFacts(directory: FileHandle, lanes: readonly string[]): Promise<{ lane: string; round: number; status: string | null }[]> {
  const facts: { lane: string; round: number; status: string | null }[] = []
  for (const lane of lanes) {
    const rounds = (await listFiles(directory, ['lane-review', lane]))
      .flatMap(name => /^\d+\.json$/.test(name) ? [Number(name.slice(0, -'.json'.length))] : [])
      .filter(round => Number.isSafeInteger(round) && round > 0)
      .sort((a, b) => a - b)
    for (const round of rounds) {
      const raw = await readJson(directory, ['lane-review', lane, `${round}.json`])
      const status = raw && typeof raw === 'object' && typeof (raw as { status?: unknown }).status === 'string' ? (raw as { status: string }).status : null
      facts.push({ lane, round, status })
    }
  }
  return facts
}

/** Each reviewer's live receipt facts (`automatic-review(-<id>).json`): its status word and whether it records an error. */
export async function readReviewerReceipts(directory: FileHandle, reviewerIds: readonly string[]): Promise<Record<string, { status: string | null; error: boolean }>> {
  const receipts: Record<string, { status: string | null; error: boolean }> = {}
  for (const id of new Set(reviewerIds)) {
    const parsed = automaticReviewSchema.safeParse(await readJson(directory, [reviewFiles(id).auto]))
    if (parsed.success) receipts[id] = { status: parsed.data.status ?? null, error: receiptFailed(parsed.data) }
  }
  return receipts
}

/**
 * Whether a reviewer's receipt records a failure: an error and no accepted verdict. The default reviewer's receipt is the
 * combined `automatic-review.json`, where every block (an ordinary blocked verdict too) writes the round's `error`; a
 * reviewer that recorded its verdict delivered it, so that error is the round's, not its session's.
 */
function receiptFailed(receipt: { error?: string | null; accepted_decision?: { verdict?: string | null } | null } | null): boolean {
  if (typeof receipt?.error !== 'string' || receipt.error.length === 0) return false
  return typeof receipt.accepted_decision?.verdict !== 'string'
}

// ---- File schemas (read permissively: only the mapped keys are typed) --------------------------------------------

const costFileSchema = z.object({ session_id: z.string().nullish(), cost_usd: z.number().nullish(), duration_ms: z.number().nullish(), recorded_at: z.string().nullish(), models: z.array(z.string()).nullish() })
const interactiveSchema = z.object({ session_id: z.string().nullish(), worktree: z.string().nullish(), launch_requested_at: z.string().nullish(), launch_token: z.string().nullish(), requested: z.object({ model: z.string().nullish() }).nullish() })
/** A worker's completion (`<lane>.completion.json`) and stop marker (`<lane>.stop.json`): the evidence a worker ended. */
const completionSchema = z.object({ status: z.string(), launch_token: z.string().nullish() })
const stopSchema = z.object({ stopped: z.boolean(), session_id: z.string().nullish() })
/** A print job's JSON result (a challenge attempt, a print reviewer, the critique, a sidecar pass, an attack angle). */
const printResultSchema = z.object({ session_id: z.string().nullish(), total_cost_usd: z.number().nullish(), duration_ms: z.number().nullish(), is_error: z.boolean().nullish(), modelUsage: z.record(z.string(), z.unknown()).nullish() })
const challengeRoleSchema = z.object({ observed_models: z.array(z.string()).nullish(), requested: z.object({ model: z.string().nullish() }).nullish() })
const decisionSchema = z.object({ verdict: z.string().nullish() }).nullish()
const automaticReviewSchema = z.object({
  status: z.string().nullish(), late: z.boolean().nullish(), session_id: z.string().nullish(), round: z.number().nullish(),
  error: z.string().nullish(), reason: z.string().nullish(), launched_at: z.string().nullish(), accepted_at: z.string().nullish(),
  finished_at: z.string().nullish(), accepted_decision: decisionSchema, transport: z.string().nullish(),
})
const critiqueStatusSchema = z.object({ session_id: z.string().nullish(), launched_at: z.string().nullish(), accepted_decision: decisionSchema })
const laneReviewFindingFile = z.object({ severity: z.enum(['P0', 'P1', 'P2']), file: z.string().nullish(), line: z.number().nullish(), title: z.string().nullish(), detail: z.string().nullish() })
const laneReviewReviewerFile = z.object({
  index: z.number().nullish(), transport: z.string().nullish(), model: z.string().nullish(), status: z.string().nullish(),
  duration_seconds: z.number().nullish(), cost_usd: z.number().nullish(), session_id: z.string().nullish(), cwd: z.string().nullish(),
  error: z.string().nullish(), findings: z.array(laneReviewFindingFile).nullish(),
})
const laneReviewRecordSchema = z.object({
  lane: z.string().nullish(), round: z.number().nullish(), snapshot: z.string().nullish(), status: z.string().nullish(),
  reviewers: z.array(laneReviewReviewerFile).nullish(), started_at: z.string().nullish(), ended_at: z.string().nullish(),
  spent_marks: z.array(z.unknown()).nullish(), repair: z.number().nullish(),
})
const pidFileSchema = z.object({ marker: z.string().nullish(), cwd: z.string().nullish(), worktree: z.string().nullish() })
/** An archived review round (`review.round-<k>.json`): its reviewers' verdicts and the findings each one tagged. */
const archivedRoundSchema = z.object({
  reviewers: z.array(z.object({
    reviewer_id: z.string(), verdict: z.string().nullish(), status: z.string().nullish(), session_id: z.string().nullish(), transport: z.string().nullish(),
    launched_at: z.string().nullish(), accepted_at: z.string().nullish(),
    findings: z.array(z.object({ severity: z.string(), disposition: z.string().nullish() })).nullish(),
  })).nullish(),
  findings: z.array(z.object({ severity: z.string(), disposition: z.string().nullish(), reviewer: z.string().nullish() })).nullish(),
})

/**
 * A timestamp the strict sessions contract (`z.iso.datetime()`) accepts: the UTC normal form of any date V8 parses, else
 * null. Always re-serialised, never passed through: V8 accepts forms the contract rejects (a space for the `T`, hour 24, a
 * day past the month's end, which it rolls over), and one such value in one file must never fail the route ([O2], [L11] 3).
 */
export function iso(value: string | null | undefined): string | null {
  if (typeof value !== 'string' || value.length === 0) return null
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) return null
  try {
    return new Date(parsed).toISOString()
  } catch {
    return null
  }
}

function duration(ms: number | null | undefined): number | null {
  return typeof ms === 'number' && Number.isFinite(ms) && ms >= 0 ? nonNeg(ms / 1000) : null
}

/**
 * Above this a cost or duration is not a recorded fact but a corrupt file: read as not recorded, so the run's totals (summed
 * at micro-dollar precision) stay finite and one absurd file never fails the route ([L11] 3).
 */
const RECORDED_MAX = 1e9

/** A finite, non-negative cost or duration the strict contract accepts, at most `RECORDED_MAX`, else null ([O2]). */
function nonNeg(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= RECORDED_MAX ? value : null
}

/** A line number a finding file holds: a non-negative integer, else null. */
function lineNumber(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null
}

/** The seconds between two served timestamps, when both are known and in order; else null. */
function spanSeconds(start: string | null, end: string | null): number | null {
  if (start === null || end === null) return null
  const seconds = (Date.parse(end) - Date.parse(start)) / 1000
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null
}

/** The subscription-covered transports ([P11]): pi providers (`openai-codex` and the rest) and openrouter estimates. */
function isCovered(transport: string | null): boolean {
  return transport === 'pi' || transport === 'openrouter'
}

/** A cost's kind: `metered` for Claude transports, `covered` for subscription estimates; null when no cost is recorded. */
function costKind(cost: number | null, covered: boolean): SessionRow['cost_kind'] {
  return cost === null ? null : covered ? 'covered' : 'metered'
}

/** The transports a Claude Code session records ([L3]); a worker, repair or challenge receipt records none and is one too. */
const CLAUDE_TRANSPORTS = new Set(['native', 'print', 'claude'])

/** A print job's first model: its `modelUsage` keys, sorted (as `workflow/costs.py` reads them). */
function printModel(result: z.infer<typeof printResultSchema> | null): string | null {
  return result?.modelUsage ? Object.keys(result.modelUsage).sort()[0] ?? null : null
}

/**
 * The open P0/P1 and P2 counts a reviewer's findings hold, by the codebase's blocker rule (`isBlockingFinding`, contracts v1):
 * a finding blocks unless it is resolved, so an accepted P1 still counts ([L10] 13) and the card agrees with the review gate.
 */
function openCounts(findings: readonly { severity: string; disposition?: string | null }[]): SessionRow['findings'] {
  const count = { p0: 0, p1: 0, p2: 0 }
  for (const finding of findings) {
    if (finding.disposition === 'resolved') continue
    if (finding.severity === 'P0') count.p0 += 1
    else if (finding.severity === 'P1') count.p1 += 1
    else if (finding.severity === 'P2') count.p2 += 1
  }
  return count
}

function countSeverities(findings: readonly { severity: string }[]): SessionRow['findings'] {
  const count = { p0: 0, p1: 0, p2: 0 }
  for (const finding of findings) {
    if (finding.severity === 'P0') count.p0 += 1
    else if (finding.severity === 'P1') count.p1 += 1
    else if (finding.severity === 'P2') count.p2 += 1
  }
  return count
}

/** A row with every optional fact unknown; each reader fills what its files hold. */
function row(fields: Pick<SessionRow, 'key' | 'role' | 'label'> & Partial<SessionRow>): SessionRow {
  return {
    node_id: null, lane: null, round: null, transport: null, model: null, status: 'unknown', verdict: null, findings: null,
    started_at: null, ended_at: null, duration_seconds: null, cost_usd: null, cost_kind: null, session_id: null, resume: null,
    ...fields,
  }
}

// ---- Lane reviews (PRD 3.2) -------------------------------------------------------------------------------------

/**
 * The no-fix reason the engine recorded ([P10], [L3]): "the review failed: <first line>" for a failed record, "no P0/P1" for
 * a clean round, else the `lane_review:` event words on `verify_<lane>` for that round (the gate's refusal, or whatever the
 * round's own latest event said), else "not recorded". Never a more specific cause than the record holds.
 */
function noFixReason(record: z.infer<typeof laneReviewRecordSchema>, findings: LaneReviewFinding[], eventWords: string | null): string {
  if (record.status === 'failed') {
    const detail = record.reviewers?.map(reviewer => reviewer.error).find(error => typeof error === 'string' && error.length > 0)
    return `the review failed: ${firstLine(detail ?? 'no reviewer recorded an error')}`
  }
  if (record.status === 'reviewed' && !findings.some(finding => finding.severity === 'P0' || finding.severity === 'P1')) return 'no P0/P1'
  if (eventWords && eventWords.length > 0) {
    // The gate's refusal names its reason in parentheses ("… recorded, no fix round (rounds used up, fix loop off or repair
    // cap)", workflow/lane_review.py): those are the engine's own words; any other event is quoted verbatim.
    const refused = /no fix round \((.+)\)\s*$/.exec(eventWords)
    return refused ? refused[1]! : eventWords
  }
  return 'not recorded'
}

function projectLaneReview(record: z.infer<typeof laneReviewRecordSchema>, lane: string, round: number, eventWords: string | null): LaneReview {
  const findings: LaneReviewFinding[] = (record.reviewers ?? []).flatMap(reviewer => (reviewer.findings ?? []).map(finding => ({
    severity: finding.severity, file: finding.file ?? null, line: lineNumber(finding.line),
    title: finding.title ?? '', detail: finding.detail ?? '',
  })))
  const reviewers: LaneReviewReviewer[] = (record.reviewers ?? []).map(reviewer => ({
    transport: reviewer.transport ?? 'not recorded', model: reviewer.model ?? null, status: reviewer.status ?? 'unknown',
    duration_seconds: nonNeg(reviewer.duration_seconds), cost_usd: nonNeg(reviewer.cost_usd),
    error: reviewer.error != null ? firstLine(reviewer.error) : null,
  }))
  const repair = record.repair
  const fix_round: LaneReview['fix_round'] = typeof repair === 'number' && Number.isSafeInteger(repair) && repair > 0
    ? { started: true, repair_node_id: `repair-${repair}` }
    : { started: false, reason: noFixReason(record, findings, eventWords) }
  return {
    lane, round, node_id: laneReviewNodeId(lane, round), snapshot: record.snapshot ?? '',
    status: record.status ?? 'unknown', started_at: iso(record.started_at), ended_at: iso(record.ended_at),
    fix_round, reviewers, findings,
  }
}

/** A lane reviewer's session status: ok decided, a timeout stopped, an error or parse failure failed, else running/unknown. */
function laneReviewerStatus(word: string | null | undefined): SessionRow['status'] {
  if (word === 'ok') return 'succeeded'
  if (word === 'timed_out') return 'stopped'
  if (word === 'error' || word === 'parse_failed') return 'failed'
  if (word === 'running') return 'running'
  return 'unknown'
}

/** A claude lane reviewer's session id: the reviewer entry's, else the `--session-id` marker of its latest `.pid` file. */
async function laneReviewerSession(input: SessionsInput, lane: string, round: number, index: number, entry: z.infer<typeof laneReviewReviewerFile>, names: readonly string[]): Promise<{ sessionId: string | null; dir: string | null }> {
  let sessionId = sessionIdOf(entry.session_id)
  let dir = entry.cwd ?? null
  const latest = numbered(names, `r${round}-${index}`, '.pid').at(-1)
  if (latest !== undefined) {
    const pid = pidFileSchema.safeParse(await readJson(input.directory, ['lane-review', lane, `r${round}-${index}-${latest}.pid`]))
    if (pid.success) {
      const marker = /--session-id\s+(\S+)/.exec(pid.data.marker ?? '')
      sessionId ??= sessionIdOf(marker?.[1])
      dir = pid.data.worktree ?? pid.data.cwd ?? dir
    }
  }
  return { sessionId, dir }
}

async function laneReviewsAndRows(input: SessionsInput): Promise<{ reviews: LaneReview[]; rows: SessionRow[] }> {
  const reviews: LaneReview[] = []
  const rows: SessionRow[] = []
  for (const fact of await readLaneReviewFacts(input.directory, input.lanes)) {
    const { lane, round } = fact
    const record = laneReviewRecordSchema.safeParse(await readJson(input.directory, ['lane-review', lane, `${round}.json`]))
    if (!record.success) continue
    const review = projectLaneReview(record.data, lane, round, input.laneReviewEventWords.get(`${lane}:${round}`) ?? null)
    reviews.push(review)
    const names = await listFiles(input.directory, ['lane-review', lane])
    const entries = record.data.reviewers ?? []
    for (const [position, entry] of entries.entries()) {
      const index = typeof entry.index === 'number' && Number.isSafeInteger(entry.index) && entry.index > 0 ? entry.index : position + 1
      const transport = entry.transport ?? null
      const claude = transport === 'claude'
      const session = claude ? await laneReviewerSession(input, lane, round, index, entry, names) : { sessionId: null, dir: null }
      const cost = nonNeg(entry.cost_usd)
      rows.push(row({
        key: `lane:${lane}:${round}:${index}`, role: 'lane_reviewer',
        label: `Lane review · ${lane} · round ${round} · ${entry.model ?? transport ?? `reviewer ${index}`}`,
        node_id: review.node_id, lane, round, transport, model: entry.model ?? null,
        status: laneReviewerStatus(entry.status), findings: countSeverities(entry.findings ?? []),
        started_at: review.started_at, ended_at: review.ended_at, duration_seconds: nonNeg(entry.duration_seconds),
        cost_usd: cost, cost_kind: costKind(cost, isCovered(transport)), session_id: session.sessionId,
        // A claude lane reviewer runs in a throwaway worktree removed after its round: the `~/` form only while it exists ([L3]).
        resume: claude ? await composeResume(session.sessionId, session.dir, input.resume) : null,
      }))
    }
  }
  return { reviews, rows }
}

// ---- The whole payload ------------------------------------------------------------------------------------------

export type SessionsInput = {
  directory: FileHandle
  runId: string
  definition: WorkflowDefinition
  lanes: readonly string[]
  /** The adapted review result (the latest decided round), or null while a round runs or before the first. */
  review: ReviewResult | null
  /** The facts the stage projection was keyed on: which reviewer nodes exist and their states. */
  nodes: SessionNodeInput
  fixLoop: FixLoop | null
  panels: PanelResults | null
  /** The `lane_review:` event's words on `verify_<lane>`, keyed `<lane>:<round>` (the latest per round); for the no-fix reason. */
  laneReviewEventWords: ReadonlyMap<string, string>
  nightShift: NightShiftRead[]
  resume: ResumeContext
}

// The controller writes the latest attempt number as `attempt` (contracts/workflow/challenge.schema.json); every attempt has
// its `challenge-<n>.stdout.json`/`.role.json` receipt.
const challengeJsonSchema = z.object({ attempt: z.number().nullish(), status: z.string().nullish() })

async function challengeRows(input: SessionsInput): Promise<SessionRow[]> {
  const parsed = challengeJsonSchema.safeParse(await readJson(input.directory, ['challenge.json']))
  const latest = parsed.success && parsed.data.status !== 'disabled' && typeof parsed.data.attempt === 'number' && Number.isSafeInteger(parsed.data.attempt) ? parsed.data.attempt : 0
  const names = await listFiles(input.directory, [])
  const attempts = [...new Set([...numbered(names, 'challenge', '.stdout.json'), ...Array.from({ length: Math.max(0, Math.min(latest, 50)) }, (_, i) => i + 1)])].sort((a, b) => a - b)
  const node = input.definition.nodes.some(candidate => candidate.node_id === 'challenge') ? 'challenge' : null
  const rows: SessionRow[] = []
  for (const n of attempts) {
    const stdout = printResultSchema.safeParse(await readJson(input.directory, [`challenge-${n}.stdout.json`]))
    const role = challengeRoleSchema.safeParse(await readJson(input.directory, [`challenge-${n}.role.json`]))
    const result = stdout.success ? stdout.data : null
    const sessionId = sessionIdOf(result?.session_id)
    const cost = nonNeg(result?.total_cost_usd)
    rows.push(row({
      key: `challenge:${n}`, role: 'challenge', label: `Design challenge attempt ${n}`, node_id: node, round: n, transport: 'print',
      model: (role.success ? role.data.observed_models?.[0] ?? role.data.requested?.model : null) ?? printModel(result),
      status: result === null ? (n === latest ? 'running' : 'unknown') : result.is_error ? 'failed' : 'succeeded',
      duration_seconds: duration(result?.duration_ms), cost_usd: cost, cost_kind: costKind(cost, false), session_id: sessionId,
      // A challenge receipt records no working directory ([L4], [L6]): always the bare resume form.
      resume: await composeResume(sessionId, null, input.resume),
    }))
  }
  return rows
}

/**
 * A worker session's status from its completion and stop evidence, never from its cost file (a cost is recorded for a running
 * session too): a completion of this launch (the launch token matches when both record one) says `completed` → succeeded,
 * `blocked` → failed, `question` → stopped; else a confirmed stop (`stopped: true`, of this session when both name one) →
 * stopped; else a launch receipt → running; else unknown.
 */
function workerStatus(
  receipt: z.infer<typeof interactiveSchema> | null, completion: z.infer<typeof completionSchema> | null, stop: z.infer<typeof stopSchema> | null,
): SessionRow['status'] {
  const ownLaunch = completion !== null && !(receipt?.launch_token && completion.launch_token && receipt.launch_token !== completion.launch_token)
  if (ownLaunch && completion.status === 'completed') return 'succeeded'
  if (ownLaunch && completion.status === 'blocked') return 'failed'
  if (ownLaunch && completion.status === 'question') return 'stopped'
  const ownStop = stop !== null && stop.stopped && !(receipt?.session_id && stop.session_id && receipt.session_id !== stop.session_id)
  if (ownStop) return 'stopped'
  return receipt !== null ? 'running' : 'unknown'
}

async function workerRows(input: SessionsInput): Promise<SessionRow[]> {
  const rows: SessionRow[] = []
  for (const lane of input.lanes) {
    const interactive = interactiveSchema.safeParse(await readJson(input.directory, [`${lane}.interactive.json`]))
    const cost = costFileSchema.safeParse(await readJson(input.directory, [`${lane}.cost.json`]))
    if (!interactive.success && !cost.success) continue
    const receipt = interactive.success ? interactive.data : null
    // A cost file of another session (an earlier launch of this lane, beside a relaunch's receipt) is not this session's.
    const costFile = cost.success && !(receipt?.session_id && cost.data.session_id && receipt.session_id !== cost.data.session_id) ? cost.data : null
    const sessionId = sessionIdOf(receipt?.session_id ?? costFile?.session_id)
    const costUsd = nonNeg(costFile?.cost_usd)
    const completion = completionSchema.safeParse(await readJson(input.directory, [`${lane}.completion.json`]))
    const stop = stopSchema.safeParse(await readJson(input.directory, [`${lane}.stop.json`]))
    const launchNode = input.definition.nodes.some(node => node.node_id === `launch_${lane}`) ? `launch_${lane}` : input.definition.nodes.some(node => node.node_id === lane) ? lane : null
    const status = workerStatus(receipt, completion.success ? completion.data : null, stop.success ? stop.data : null)
    rows.push(row({
      key: `worker:${lane}`, role: 'worker', label: `Worker · ${lane}`, node_id: launchNode, lane,
      model: receipt?.requested?.model ?? costFile?.models?.[0] ?? null, status,
      // A cost is recorded while the session runs: its time is when it was recorded, not when the session ended.
      started_at: iso(receipt?.launch_requested_at), ended_at: status === 'running' ? null : iso(costFile?.recorded_at),
      duration_seconds: duration(costFile?.duration_ms), cost_usd: costUsd, cost_kind: costKind(costUsd, false), session_id: sessionId,
      resume: await composeResume(sessionId, receipt?.worktree ?? null, input.resume),
    }))
  }
  return rows
}

async function repairRows(input: SessionsInput): Promise<SessionRow[]> {
  const rows: SessionRow[] = []
  const loop = input.fixLoop && 'repairs' in input.fixLoop ? input.fixLoop : null
  for (const repair of loop?.repairs ?? []) {
    const interactive = interactiveSchema.safeParse(await readJson(input.directory, [`repair-${repair.n}.interactive.json`]))
    const cost = costFileSchema.safeParse(await readJson(input.directory, [`repair-${repair.n}.cost.json`]))
    const receipt = interactive.success ? interactive.data : null
    const costFile = cost.success ? cost.data : null
    const sessionId = sessionIdOf(repair.session_id ?? receipt?.session_id)
    const costUsd = nonNeg(costFile?.cost_usd)
    const status: SessionRow['status'] = ['launched', 'captured', 'recorded'].includes(repair.status) ? 'running' : repair.status === 'applied' ? 'succeeded' : 'failed'
    rows.push(row({
      key: `repair:${repair.n}`, role: 'repair', label: `Repair ${repair.n} · ${repair.lane}`, node_id: repair.node_id, lane: repair.lane, round: repair.n,
      model: receipt?.requested?.model ?? repair.requested?.model ?? costFile?.models?.[0] ?? null, status,
      started_at: iso(repair.recorded_at), ended_at: iso(repair.applied_at) ?? iso(costFile?.recorded_at),
      duration_seconds: duration(costFile?.duration_ms), cost_usd: costUsd, cost_kind: costKind(costUsd, false), session_id: sessionId,
      resume: await composeResume(sessionId, receipt?.worktree ?? null, input.resume),
    }))
  }
  return rows
}

/**
 * A reviewer's file names ([L3]): the default reviewer `review` keeps the unprefixed names (`automatic-review.json`,
 * `review.interactive.json`, `review.cost.json`, `review.stdout.json`); a declared reviewer `<id>` owns
 * `automatic-review-<id>.json` and `review-<id>.*`, as `workflow/sessions.py` `review_node` writes them. An archived round's
 * receipt is `automatic-review(-<id>).round-<k>.json`.
 */
function reviewFiles(id: string, round?: number): { auto: string; interactive: string; cost: string; stdout: string } {
  const suffix = round !== undefined ? `.round-${round}` : ''
  const prefix = id === DEFAULT_REVIEWER_ID ? 'review' : `review-${id}`
  const auto = id === DEFAULT_REVIEWER_ID ? `automatic-review${suffix}.json` : `automatic-review-${id}${suffix}.json`
  return { auto, interactive: `${prefix}.interactive.json`, cost: `${prefix}.cost.json`, stdout: `${prefix}.stdout.json` }
}

/** The word a reviewer row says (PRD 3.1): "late blocked", "blocked", "approved", "failed", "running" or "not started". */
function reviewerWord(state: ReviewerState, verdict: string | null | undefined, late: boolean): string {
  if (state.word === 'failed') return 'failed'
  if (state.word === 'running') return 'running'
  if (state.word === 'not started') return 'not started'
  if (verdict === 'blocked') return late ? 'late blocked' : 'blocked'
  if (verdict === 'approved') return late ? 'late approved' : 'approved'
  return 'decided'
}

/** A reviewer session's status: running while it runs, failed when it ended without a verdict, else decided (succeeded). */
function reviewerSessionStatus(state: ReviewerState): SessionRow['status'] {
  return state.word === 'failed' ? 'failed' : state.word === 'running' ? 'running' : state.word === 'not started' ? 'unknown' : 'succeeded'
}

type ReviewerCost = { cost_usd: number | null; model: string | null; duration_seconds: number | null; session_id: string | null; started_at: string | null }

/**
 * A reviewer round's cost facts: the critique's `critique/<round>/{status,stdout}.json` (each round keeps its own), else the
 * round's `.cost.json` (a native reviewer) or `.stdout.json` (a print reviewer): the latest round's in the run directory, an
 * archived round's in `review-round-<k>/`, where `archive_review` moved them (PRD 4).
 */
async function reviewerCost(input: SessionsInput, id: string, round: number, latest: boolean): Promise<ReviewerCost> {
  const none: ReviewerCost = { cost_usd: null, model: null, duration_seconds: null, session_id: null, started_at: null }
  if (id === 'critique') {
    const status = critiqueStatusSchema.safeParse(await readJson(input.directory, ['critique', String(round), 'status.json']))
    const stdout = printResultSchema.safeParse(await readJson(input.directory, ['critique', String(round), 'stdout.json']))
    const result = stdout.success ? stdout.data : null
    if (status.success || result !== null) {
      return {
        cost_usd: nonNeg(result?.total_cost_usd), model: printModel(result), duration_seconds: duration(result?.duration_ms),
        session_id: sessionIdOf(result?.session_id) ?? sessionIdOf(status.success ? status.data.session_id : null),
        started_at: status.success ? iso(status.data.launched_at) : null,
      }
    }
  }
  const files = reviewFiles(id)
  const folder = latest ? [] : [`review-round-${round}`]
  const cost = costFileSchema.safeParse(await readJson(input.directory, [...folder, files.cost]))
  if (cost.success && (cost.data.cost_usd != null || cost.data.models != null)) {
    return { cost_usd: nonNeg(cost.data.cost_usd), model: cost.data.models?.[0] ?? null, duration_seconds: duration(cost.data.duration_ms), session_id: sessionIdOf(cost.data.session_id), started_at: null }
  }
  const stdout = printResultSchema.safeParse(await readJson(input.directory, [...folder, files.stdout]))
  if (stdout.success) {
    return { cost_usd: nonNeg(stdout.data.total_cost_usd), model: printModel(stdout.data), duration_seconds: duration(stdout.data.duration_ms), session_id: sessionIdOf(stdout.data.session_id), started_at: null }
  }
  return none
}

/**
 * The archived review rounds the run directory holds, ascending: the `review.round-<k>.json` files that exist ([L12] 3). The
 * controller numbers a round after every round in `review-rounds.json`, and a restored round's file went back to
 * `review.json`, so a round can be missing: with the fix loop's rounds recorded, a listed k counts when the loop names it;
 * without them, the run of k from 1 without a gap. Bounded by the files listed, so a stray `review.round-99999999.json`
 * neither loops the request nor labels the running round.
 */
async function archivedRounds(input: SessionsInput): Promise<number[]> {
  const listed = numbered(await listFiles(input.directory, []), 'review.round', '.json')
  const recorded = new Set((input.fixLoop?.review_rounds ?? []).map(round => round.round))
  if (recorded.size > 0) return listed.filter(k => recorded.has(k))
  const rounds: number[] = []
  for (const k of listed) {
    if (k !== rounds.length + 1) break
    rounds.push(k)
  }
  return rounds
}

async function reviewerRows(input: SessionsInput): Promise<SessionRow[]> {
  const rows: SessionRow[] = []
  const projected = new Set(projectedReviewerIds(input.nodes))
  const nodeOf = (id: string) => projected.has(id) ? reviewerNodeId(id) : input.definition.nodes.some(node => node.node_id === 'review') ? 'review' : null
  const archived = await archivedRounds(input)
  // The latest round: the export's decided reviewers, or (while a round runs and the section is null) the launched plan reviewers.
  const decided = input.review !== null
  const round = decided ? input.review!.round ?? input.review!.attempt : (archived.at(-1) ?? 0) + 1
  const ids = decided ? input.review!.reviewers.map(entry => entry.reviewer_id) : drawnReviewerIds(input.nodes)
  for (const id of ids) {
    const entry = decided ? input.review!.reviewers.find(candidate => candidate.reviewer_id === id) ?? null : null
    const files = reviewFiles(id)
    const auto = automaticReviewSchema.safeParse(await readJson(input.directory, [files.auto]))
    const receipt = auto.success ? auto.data : null
    const interactive = interactiveSchema.safeParse(await readJson(input.directory, [files.interactive]))
    const launch = interactive.success ? interactive.data : null
    const state = reviewerStateOf(entry ? entry.status : receipt?.status ?? null, receiptFailed(receipt))
    const late = receipt?.late === true
    const verdict = entry?.verdict ?? receipt?.accepted_decision?.verdict ?? null
    const cost = await reviewerCost(input, id, round, true)
    const transport = entry?.transport ?? receipt?.transport ?? (id === 'critique' ? 'print' : null)
    const sessionId = sessionIdOf(entry?.session_id) ?? sessionIdOf(receipt?.session_id) ?? sessionIdOf(launch?.session_id) ?? cost.session_id
    const findings = entry ? openCounts(entry.findings) : null
    const startedAt = iso(entry?.launched_at) ?? iso(receipt?.launched_at) ?? iso(launch?.launch_requested_at) ?? cost.started_at
    const endedAt = iso(entry?.accepted_at) ?? iso(receipt?.accepted_at) ?? iso(receipt?.finished_at)
    const claude = transport === null || CLAUDE_TRANSPORTS.has(transport)
    rows.push(row({
      key: `reviewer:${id}:${round}`, role: id === 'critique' ? 'critique' : 'reviewer',
      label: `Reviewer · ${id} · round ${round}`, node_id: nodeOf(id), round, transport, model: cost.model,
      status: reviewerSessionStatus(state), verdict: reviewerWord(state, verdict, late), findings,
      started_at: startedAt, ended_at: endedAt, duration_seconds: cost.duration_seconds ?? spanSeconds(startedAt, endedAt),
      cost_usd: cost.cost_usd, cost_kind: costKind(cost.cost_usd, isCovered(transport)), session_id: sessionId,
      // A native reviewer resumes from its review worktree ([L6]); the critique records no directory: the bare form.
      resume: claude ? await composeResume(sessionId, launch?.worktree ?? null, input.resume) : null,
    }))
  }
  // Earlier rounds: each archived `review.round-<k>.json` names every reviewer's verdict and findings for that round.
  for (const k of archived.filter(n => n < round)) {
    const parsed = archivedRoundSchema.safeParse(await readJson(input.directory, [`review.round-${k}.json`]))
    if (!parsed.success) continue
    for (const previous of parsed.data.reviewers ?? []) {
      const id = previous.reviewer_id
      const auto = automaticReviewSchema.safeParse(await readJson(input.directory, [reviewFiles(id, k).auto]))
      const receipt = auto.success ? auto.data : null
      const tagged = (parsed.data.findings ?? []).filter(finding => finding.reviewer === id)
      const cost = await reviewerCost(input, id, k, false)
      const transport = previous.transport ?? receipt?.transport ?? (id === 'critique' ? 'print' : null)
      const sessionId = sessionIdOf(previous.session_id) ?? sessionIdOf(receipt?.session_id) ?? cost.session_id
      const state = reviewerStateOf(previous.status ?? receipt?.status ?? 'accepted', false)
      const startedAt = iso(previous.launched_at) ?? iso(receipt?.launched_at) ?? cost.started_at
      const endedAt = iso(previous.accepted_at) ?? iso(receipt?.accepted_at)
      const claude = transport === null || CLAUDE_TRANSPORTS.has(transport)
      rows.push(row({
        key: `reviewer:${id}:${k}`, role: id === 'critique' ? 'critique' : 'reviewer',
        label: `Reviewer · ${id} · round ${k}`, node_id: nodeOf(id), round: k, transport, model: cost.model,
        status: reviewerSessionStatus(state), verdict: reviewerWord(state, previous.verdict ?? receipt?.accepted_decision?.verdict, receipt?.late === true),
        findings: openCounts(previous.findings?.length ? previous.findings : tagged),
        started_at: startedAt, ended_at: endedAt, duration_seconds: cost.duration_seconds ?? spanSeconds(startedAt, endedAt),
        cost_usd: cost.cost_usd, cost_kind: costKind(cost.cost_usd, isCovered(transport)), session_id: sessionId,
        // An archived round's review worktree is removed: the bare form only ([L4], [L6]).
        resume: claude ? await composeResume(sessionId, null, input.resume) : null,
      }))
    }
  }
  return rows
}

/** Sidecar passes and attack angles (`sidecar-<n>.stdout.json`, `attack-<n>.stdout.json`, the roles `workflow/costs.py` counts, [P12]). */
async function printJobRows(input: SessionsInput, prefix: 'sidecar' | 'attack'): Promise<SessionRow[]> {
  const rows: SessionRow[] = []
  const names = await listFiles(input.directory, [])
  const node = input.definition.nodes.some(candidate => candidate.node_id === prefix) ? prefix : null
  for (const n of numbered(names, prefix, '.stdout.json')) {
    const parsed = printResultSchema.safeParse(await readJson(input.directory, [`${prefix}-${n}.stdout.json`]))
    const result = parsed.success ? parsed.data : null
    const sessionId = sessionIdOf(result?.session_id)
    const cost = nonNeg(result?.total_cost_usd)
    rows.push(row({
      key: `${prefix}:${n}`, role: prefix, label: prefix === 'sidecar' ? `Sidecar pass ${n}` : `Attack angle ${n}`,
      node_id: node, round: n, transport: 'print', model: printModel(result),
      status: result === null ? 'unknown' : result.is_error ? 'failed' : 'succeeded',
      duration_seconds: duration(result?.duration_ms), cost_usd: cost, cost_kind: costKind(cost, false), session_id: sessionId,
      // A print job records no working directory: the bare resume form.
      resume: await composeResume(sessionId, null, input.resume),
    }))
  }
  return rows
}

function panelRows(input: SessionsInput): SessionRow[] {
  const rows: SessionRow[] = []
  const node = input.nodes.panelStatus !== null && input.definition.nodes.some(candidate => candidate.node_id === 'review') ? PANEL_NODE_ID : null
  ;(input.panels?.panels ?? []).forEach((panel, panelIndex) => {
    panel.providers.forEach((provider, providerIndex) => {
      const name = provider.model ?? provider.transport
      // The cost kind follows the provider's transport: a `claude` provider is metered even with an explicit model ([P11]).
      const covered = isCovered(provider.transport)
      const raised = provider.model ?? 'claude'
      const findings = panel.findings.filter(finding => finding.providers_raised.includes(raised) || provider.finding_ids.includes(finding.id))
      const cost = nonNeg(provider.cost_usd)
      const startedAt = iso(panel.started_at)
      const endedAt = iso(panel.ended_at)
      rows.push(row({
        key: `panel:${panelIndex}:${providerIndex}`, role: 'panel_provider', label: `Panel · ${panel.stage} · ${name}`, node_id: node,
        transport: provider.transport, model: provider.model,
        status: provider.status === 'ok' ? 'succeeded' : provider.status === 'running' ? 'running' : provider.status === 'pending' ? 'unknown' : provider.status === 'timed_out' ? 'stopped' : 'failed',
        findings: countSeverities(findings), started_at: startedAt, ended_at: endedAt, duration_seconds: spanSeconds(startedAt, endedAt),
        cost_usd: cost, cost_kind: costKind(cost, covered),
      }))
    })
  })
  return rows
}

/**
 * One row per night-shift provider of each decision, and one for Jev when it was called (a pick from `jev.json`, or an error
 * that is not a "not called" note) (PRD 3.4). Night-shift records name no transport, so none is claimed; Claude's dollars are
 * metered, every other provider's and Jev's figure is kept apart as an estimate ([P11]); none of them offers a resume ([L3]).
 */
function nightShiftRows(input: SessionsInput): SessionRow[] {
  const rows: SessionRow[] = []
  input.nightShift.forEach(({ decision, jevRun: jev }, index) => {
    const base = `night:${index}`
    const node = decision.node_id
    decision.providers.forEach((provider, providerIndex) => {
      const cost = nonNeg(provider.cost_usd)
      rows.push(row({
        key: `${base}:${providerIndex}`, role: 'night_shift', label: `Night shift · ${decision.kind} · ${provider.name}`, node_id: node,
        model: provider.name, status: provider.error ? 'failed' : 'succeeded', verdict: provider.option,
        ended_at: decision.decided_at, cost_usd: cost, cost_kind: costKind(cost, provider.name !== 'claude'),
      }))
    })
    const called = decision.jev !== null && !('error' in decision.jev && /^not called\b/i.test(decision.jev.error))
    if (called) {
      const cost = nonNeg(jev?.cost_usd ?? null)
      rows.push(row({
        key: `${base}:jev`, role: 'night_shift', label: `Night shift · ${decision.kind} · Jev`, node_id: node,
        model: jev?.model ?? null, status: decision.jev !== null && 'error' in decision.jev ? 'failed' : 'succeeded',
        verdict: decision.jev !== null && 'pick' in decision.jev ? decision.jev.pick : null,
        ended_at: decision.decided_at, cost_usd: cost, cost_kind: costKind(cost, true),
      }))
    }
  })
  return rows
}

/**
 * The served node a night-shift decision lands on (PRD 3.3): `controller_blocked` and `review_blocked` none (the run page's
 * controller section shows them, whatever node the record names: the controller writes `review_blocked` with node `review`);
 * else the record's `node` when the run's graph serves it (`challenge`, `approval`); a `question`'s logical lane its worker's
 * node (`launch_<lane>`, else the lane's own node, as the worker row links); anything else null, rather than a link to a
 * node page that does not exist.
 */
/** The night-shift kinds the run page's controller section shows (PRD 3.3). */
const CONTROLLER_KINDS: ReadonlySet<string> = new Set(['controller_blocked', 'review_blocked'])

function decisionNodeId(kind: string, node: string | null, input: Pick<SessionsInput, 'definition' | 'lanes'>): string | null {
  if (node === null || CONTROLLER_KINDS.has(kind)) return null
  const served = (id: string) => input.definition.nodes.some(candidate => candidate.node_id === id)
  if (input.lanes.includes(node)) return served(`launch_${node}`) ? `launch_${node}` : served(node) ? node : null
  return served(node) ? node : null
}

function sortByStart(rows: readonly SessionRow[]): SessionRow[] {
  const at = (candidate: SessionRow) => {
    const value = candidate.started_at ?? candidate.ended_at
    return value === null ? Number.POSITIVE_INFINITY : Date.parse(value)
  }
  // Stable: rows with the same (or no) start keep their role order.
  return rows.map((candidate, index) => ({ candidate, index }))
    .sort((a, b) => (at(a.candidate) - at(b.candidate)) || (a.index - b.index))
    .map(item => item.candidate)
}

/** `redactText` over every string of a value, deeply; the resume command is composed after redaction and is exempt (PRD 3.5). */
function redactDeepExceptResume<T>(value: T): T {
  if (typeof value === 'string') return redactText(value) as T
  if (Array.isArray(value)) return value.map(item => redactDeepExceptResume(item)) as T
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, key === 'resume' ? item : redactDeepExceptResume(item)])) as T
  }
  return value
}

/** Each entry through the boundary pass and its strict schema; one that still fails is dropped alone, never the payload. */
function keepValid<T>(items: readonly T[], schema: z.ZodType<T>): T[] {
  return items.flatMap(item => {
    const parsed = schema.safeParse(redactDeepExceptResume(item))
    return parsed.success ? [parsed.data] : []
  })
}

/** Reads the whole run and night-shift state and projects it onto the sessions payload (validated again by the route). */
export async function readSessions(raw: SessionsInput): Promise<Sessions> {
  const input: SessionsInput = {
    ...raw,
    nightShift: raw.nightShift.map(item => ({ ...item, decision: { ...item.decision, node_id: decisionNodeId(item.decision.kind, item.decision.node_id, raw) } })),
  }
  const lane = await laneReviewsAndRows(input)
  const all = [
    ...(await challengeRows(input)),
    ...(await workerRows(input)),
    ...(await repairRows(input)),
    ...lane.rows,
    ...(await reviewerRows(input)),
    ...(await printJobRows(input, 'sidecar')),
    ...(await printJobRows(input, 'attack')),
    ...panelRows(input),
    ...nightShiftRows(input),
  ]
  const seen = new Set<string>()
  const sessions = sortByStart(keepValid(all, sessionRowSchema)).filter(candidate => !seen.has(candidate.key) && seen.add(candidate.key))
  const laneNodes = new Set<string>()
  const laneReviews = keepValid(lane.reviews, laneReviewSchema).filter(review => !laneNodes.has(review.node_id) && laneNodes.add(review.node_id))
  const nightShift = keepValid(input.nightShift.map(item => item.decision), nightShiftDecisionSchema)
    .filter(decision => (decision.decision === 'executed') === (decision.command !== null))
  let metered = 0
  let covered = 0
  let notRecorded = 0
  for (const candidate of sessions) {
    if (candidate.cost_usd === null) notRecorded += 1
    else if (candidate.cost_kind === 'covered') covered = round6(covered + candidate.cost_usd)
    else metered = round6(metered + candidate.cost_usd)
  }
  return validateSessions({
    contract_version: '1.13.0', sessions,
    totals: { metered_usd: round6(metered), covered_usd: round6(covered), not_recorded: notRecorded },
    lane_reviews: laneReviews, night_shift: nightShift,
  })
}

/** Keeps a running cost sum free of binary-float drift, so the totals read as the files' own figures. */
function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6
}

export type { NightShiftDecision }
