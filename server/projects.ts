import { createHash } from 'node:crypto'
import fs, { type FileHandle } from 'node:fs/promises'
import { constants } from 'node:fs'
import { z } from 'zod'
import {
  CHECK_KINDS, FINDING_ATTRIBUTIONS, LANE_ID_PATTERN, validateReviewResult, validateRunDetail, validateRunInputs,
  type Project, type ReviewResult, type RunDetail, type RunInputs, type RunSummary, type WorkflowDefinition,
} from '../contracts/projects/v1.ts'
import { eventSchema, validateWorkerResult, type RunSnapshot, type WorkerResult, type WorkflowEvent } from '../contracts/workflow/v1.ts'
import { DIRECTORY_FLAGS, at } from './files.ts'
import { ID_PATTERN, publishDefinition, storedDefinitionSchema, type ProjectConfig, type ProjectsConfig, type WorkflowConfig } from './projectsConfig.ts'

/**
 * Read-only access to persisted workflow runs. A run is a directory below a registered workflow's `runs_root`
 * containing the controller's atomic `run-state.json` export (plus `plan.json`, `events.jsonl`,
 * `verification/<phase>/<node>/<attempt>/packet.json` evidence and, once reviewed, `review.diff`). Nothing here
 * spawns a process, decodes the checkpoint database or writes to run storage; every request re-reads the
 * persisted files and projects them onto the public contract. Missing or contradictory evidence is reported as
 * an error or a paused/failed state, never as success.
 *
 * Export versions: 1.0.0 (graph state only), 1.1.0 (adds the `review` section from `review.json`), 1.2.0
 * (adds the `inputs` section pinned from `plan.json`, `policy.json` and the worker receipts) and 1.3.0 (worker
 * lanes from configuration: `inputs.workers` is keyed by any lane ID, `inputs` records the selected and excluded
 * lanes, per-lane graph state lives under `lanes` and `packets`). A section is served only when the export
 * carries it; `values` is never mined for either.
 *
 * The lane list comes from `inputs.workers` (policy order). Exports without an `inputs` section, which only
 * 1.0.0 and 1.1.0 produce, fall back to the fixed `ui`/`adapter` pair those versions always had. The node map
 * follows the `launch_<lane>`, `verify_<lane>` and `candidate_<lane>` naming the controller guarantees.
 */

/** A rejected or failed project request. `message` is safe to send: it never carries absolute paths. */
export class ProjectApiError extends Error {
  readonly status: number
  readonly code: string
  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

export const DEFAULT_EXPORT_BYTE_LIMIT = 16 * 1024 * 1024
export const DEFAULT_PACKET_BYTE_LIMIT = 16 * 1024 * 1024
export const DEFAULT_ARTIFACT_BYTE_LIMIT = 32 * 1024 * 1024
export const DEFAULT_RUN_LIMIT = 50
export const MAX_RUN_LIMIT = 100

const FILE_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
const EXPORT_VERSIONS = ['1.0.0', '1.1.0', '1.2.0', '1.3.0'] as const
/** Exports without an `inputs` section predate configured lanes and always had exactly these two. */
const LEGACY_LANES = ['ui', 'adapter'] as const
/** Node IDs a lane can never take: the fixed graph tail, the finding attributions and the per-lane node prefixes. */
const RESERVED_LANE_IDS = new Set(['review', 'candidate', 'handoff', 'approval', 'integrate', 'multiple', 'none', 'both'])
const RESERVED_LANE_PREFIXES = ['launch_', 'verify_', 'candidate_', 'review-']
/** Required check kinds the controller derived from the role before policies declared them (verification.py before 1.2.0). */
const ROLE_REQUIRED_KINDS: Record<string, readonly (typeof CHECK_KINDS)[number][]> = { frontend: ['build', 'browser'], backend: ['unit'] }
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
/** Task and prompt texts are served up to this many characters; the rest is replaced by a marker. */
const TEXT_LIMIT = 65536
/** The diff the reviewer saw, registered by the export relative to the run root. */
const REVIEW_DIFF_FILE = 'review.diff'
const REVIEW_ARTIFACT_PREFIX = 'patch-review-'

/**
 * Absolute filesystem paths in persisted messages are never forwarded to clients. A path starts at the string start
 * or after any character that cannot be part of a path (so Markdown punctuation such as `[`, `|`, `<`, `*` and `(`
 * counts), or as the target of a `file://` URI, which is redacted together with its scheme.
 */
export function redactPaths(text: string): string {
  return text.replace(/(?:file:\/\/(?=\/)|(?<![A-Za-z0-9._@~+/-]))(?:~|\/[A-Za-z0-9._@~+-]+)(?:\/[A-Za-z0-9._@~+-]*)+/g, '<path>')
}

/** `stored` id pattern shared with the registry; also keeps run directories one safe component. */
const id = z.string().regex(ID_PATTERN)
const sha = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)
const hex64 = z.string().regex(/^[a-f0-9]{64}$/)
const commit = z.string().regex(/^[a-f0-9]{40}$/)
const timestamp = z.iso.datetime()
/** Receipts store `+00:00` offsets; the contract wants a trailing Z, so these are normalised on projection. */
const zonedTimestamp = z.iso.datetime({ offset: true })
const relativePath = z.string().min(1).regex(/^(?!\/)(?![A-Za-z]:)(?!.*\\)(?!.*(?:^|\/)\.\.(?:\/|$)).+$/)
const assumptions = z.array(z.string())
/** A configured lane ID: the policy's pattern, never a reserved graph node, attribution or per-lane node prefix. */
const laneKey = z.string().regex(LANE_ID_PATTERN).refine(lane => !RESERVED_LANE_IDS.has(lane) && !RESERVED_LANE_PREFIXES.some(prefix => lane.startsWith(prefix)), 'reserved lane id')
/** A finding attribution: a lane ID, `multiple`, `none` or the legacy `both`; the lane check happens against the run's lanes later. */
const attribution = z.string().regex(LANE_ID_PATTERN)

/** The export's `review` section: `review.json` plus the reviewer receipt, exactly as workflow/export_state.py writes it. */
const reviewSectionSchema = z.strictObject({
  attempt: z.number().int().positive(),
  transport: z.enum(['native', 'print', 'manual']),
  reviewer_session_id: z.string().min(1),
  independent: z.literal(true),
  bundle_sha256: hex64,
  candidate_commit: commit,
  verdict: z.enum(['approved', 'blocked']),
  findings: z.array(z.strictObject({
    severity: z.enum(['P0', 'P1', 'P2']),
    message: z.string().min(1),
    disposition: z.enum(['open', 'resolved', 'accepted']),
    worker: attribution.nullable(),
    requirement: z.string().min(1).nullable(),
  })),
  reviewed_at: zonedTimestamp,
  diff: z.strictObject({ path: z.literal(REVIEW_DIFF_FILE), sha256: hex64, bytes: z.number().int().nonnegative() }).nullable(),
})

const workerInputSchema = z.strictObject({
  /** A free label since policy 1.2.0; `frontend`/`backend` before, when it also determined the required check kinds. */
  role: z.string().min(1),
  /** Present from export 1.3.0; derived from the role for earlier exports. */
  required_check_kinds: z.array(z.enum(CHECK_KINDS)).optional(),
  task: z.string(),
  prompt: z.string().nullable(),
  owned_paths: z.array(relativePath),
  /** Check and scenario IDs are the policy's own labels (any non-empty string, as the policy schema allows), never route segments. */
  checks: z.array(z.strictObject({
    id: z.string().min(1),
    kind: z.enum(CHECK_KINDS),
    argv: z.array(z.string()),
    command: z.string().min(1),
    timeout_seconds: z.number().int().positive(),
    scenarios: z.array(z.strictObject({ id: z.string().min(1), description: z.string().min(1) })),
  })),
  launch: z.strictObject({
    session_id: z.string().min(1).nullable(),
    launch_token: z.string().min(1),
    launch_requested_at: zonedTimestamp,
    /** Epoch milliseconds as `claude agents` reports the native start. */
    native_started_at: z.number().int().nonnegative().nullable(),
    observed_state: z.string().min(1).nullable(),
    status: z.string().min(1),
    launcher_invocations: z.number().int().nonnegative(),
    background_id: z.string().nullable(),
  }).nullable(),
  completion: z.strictObject({ status: z.enum(['completed', 'blocked']), summary: z.string().min(1), open_assumptions: assumptions }).nullable(),
  handoff: z.strictObject({ summary: z.string().min(1), open_assumptions: assumptions }).nullable(),
  stop: z.strictObject({ stopped: z.boolean(), confirmed_at: zonedTimestamp.nullable() }).nullable(),
})

/** The export's `inputs` section: what the run was asked to do, pinned from `plan.json`, `policy.json` and receipts. */
const inputsSectionSchema = z.strictObject({
  feature: z.string().min(1),
  policy_version: z.string().min(1),
  base_commit: commit,
  source_branch: z.string().min(1).nullable(),
  mode: z.enum(['automatic', 'manual']),
  automatic: z.strictObject({
    finish: z.string().min(1),
    permission_mode: z.string().min(1),
    worker_timeout_seconds: z.number().int().positive(),
    review_timeout_seconds: z.number().int().positive(),
    /** Null when the plan predates the setting and the run never reviewed; the export never guesses it. */
    reviewer_transport: z.enum(['native', 'print']).nullable(),
  }).nullable(),
  setup: z.array(z.strictObject({ argv: z.array(z.string()), command: z.string().min(1), timeout_seconds: z.number().int().positive() })),
  max_verification_attempts: z.number().int().positive(),
  failure_drill: z.strictObject({ node_id: z.string(), phase: z.string(), attempt: z.number().int() }).nullable(),
  /** The lanes the run launched, in policy order (export 1.3.0); earlier exports describe every lane they have under `workers`. */
  selected_workers: z.array(laneKey).min(1).optional(),
  /** Declared lanes the launch left out (export 1.3.0); absent before, when every declared lane ran. */
  excluded_workers: z.array(laneKey).optional(),
  /** Keyed by the selected lanes in policy order: the run's lane list. */
  workers: z.record(laneKey, workerInputSchema).refine(workers => Object.keys(workers).length > 0, 'at least one worker is required'),
})

const exportSchema = z.object({
  version: z.enum(EXPORT_VERSIONS),
  run_id: id,
  base_commit: sha,
  created_at: timestamp,
  updated_at: timestamp,
  definition: storedDefinitionSchema,
  values: z.record(z.string(), z.unknown()),
  next: z.array(z.string()),
  tasks: z.array(z.object({
    node_id: z.string(),
    error: z.string().nullable(),
    interrupts: z.array(z.record(z.string(), z.unknown())),
    result: z.record(z.string(), z.unknown()).nullable(),
  })),
  events: z.array(z.unknown()),
  verification_packets: z.array(z.object({
    phase: z.enum(['worker', 'candidate']),
    node_id: id,
    attempt: z.number().int().positive(),
    path: z.string().min(1),
    sha256: hex64,
  })),
  /** Absent before 1.1.0; null when the run has no `review.json`. */
  review: reviewSectionSchema.nullable().optional(),
  /** Absent before 1.2.0; null when the run has no `policy.json`. */
  inputs: inputsSectionSchema.nullable().optional(),
})

const rawEventSchema = z.object({
  sequence: z.number().int().positive(),
  time: timestamp,
  node: z.string(),
  status: z.string(),
  message: z.string(),
})

const planSchema = z.object({ run_id: id, base_commit: sha })

const packetSchema = z.object({
  phase: z.enum(['worker', 'candidate']),
  result: z.record(z.string(), z.unknown()),
  gate: z.object({ status: z.string(), reasons: z.array(z.string()) }),
})

type RunExport = z.infer<typeof exportSchema>
type RawEvent = z.infer<typeof rawEventSchema>
type PacketRegistration = RunExport['verification_packets'][number]
type ReviewSection = z.infer<typeof reviewSectionSchema>
type InputsSection = z.infer<typeof inputsSectionSchema>

/** A registered packet after loading: either verified content or the reason it cannot be trusted. */
type LoadedPacket = PacketRegistration & (
  | { ok: true; gate: { status: string; reasons: string[] }; result: Record<string, unknown> }
  | { ok: false; reason: string }
)

/** The review diff as the export registered it; the artifact route serves it only when the bytes still match. */
type ReviewDiffRegistration = { artifact_id: string; sha256: string; bytes: number }

type Scope = { project: ProjectConfig; workflow: WorkflowConfig }

export type LoadedRun = {
  detail: RunDetail
  events: WorkflowEvent[]
  packets: LoadedPacket[]
  /** The projected review result, or null when the export carries no review section. */
  review: ReviewResult | null
  /** The projected run inputs, or null when the export carries no inputs section. */
  inputs: RunInputs | null
  reviewDiff: ReviewDiffRegistration | null
}

export type ArtifactContent = {
  artifact_id: string
  kind: 'patch' | 'log' | 'screenshot' | 'test_report' | 'other'
  contentType: string
  disposition: 'inline' | 'attachment'
  bytes: Buffer
}

/** Fixed graph tail → the LangGraph state key whose presence proves that node completed. */
const TAIL_EVIDENCE_KEY: Record<string, string> = { handoff: 'snapshots', candidate: 'bundle', review: 'review', approval: 'approved_bundle', integrate: 'integrated_commit' }

/**
 * The run's lanes and the graph nodes that concern each of them. Built per run from the export: the lane list is
 * `inputs.workers` in policy order (the fixed pair for exports without `inputs`); `launch_<lane>` and
 * `verify_<lane>` are that lane's nodes, raw events name a lane (`docs`) for its launch, `candidate_<lane>` for
 * the combined check and `freeze` for the handoff.
 */
export type LaneMap = {
  lanes: readonly string[]
  /** Graph node → the lane it concerns, for launch and verify nodes. */
  workerOf: ReadonlyMap<string, string>
  verifyNodes: ReadonlySet<string>
  /** Raw event node aliases → graph nodes. Anything else must already be a graph node or is left unattributed. */
  eventAliases: ReadonlyMap<string, string>
}

export function laneMap(lanes: readonly string[]): LaneMap {
  const workerOf = new Map<string, string>()
  const verifyNodes = new Set<string>()
  const eventAliases = new Map<string, string>([['freeze', 'handoff']])
  for (const lane of lanes) {
    workerOf.set(`launch_${lane}`, lane)
    workerOf.set(`verify_${lane}`, lane)
    verifyNodes.add(`verify_${lane}`)
    eventAliases.set(lane, `launch_${lane}`)
    eventAliases.set(`candidate_${lane}`, 'candidate')
  }
  return { lanes, workerOf, verifyNodes, eventAliases }
}

/**
 * Per-lane graph state: exports before 1.3.0 store a lane's launch receipt under `<lane>` and its packet under
 * `<lane>_packet`; 1.3.0 stores them under `lanes.<lane>` and `packets.<lane>`. Both spellings are read so a
 * re-exported old run keeps its evidence.
 */
function laneValue(record: Record<string, unknown>, lane: string, kind: 'launch' | 'packet'): unknown {
  const flat = record[kind === 'launch' ? lane : `${lane}_packet`]
  if (flat !== undefined && flat !== null) return flat
  const nested = record[kind === 'launch' ? 'lanes' : 'packets']
  return nested && typeof nested === 'object' ? (nested as Record<string, unknown>)[lane] : undefined
}

/** The state entry whose presence proves a graph node completed, read from `values` or from a preserved task result. */
function nodeEvidence(record: Record<string, unknown>, nodeId: string, map: LaneMap): unknown {
  const lane = map.workerOf.get(nodeId)
  if (lane !== undefined) return laneValue(record, lane, map.verifyNodes.has(nodeId) ? 'packet' : 'launch')
  const key = TAIL_EVIDENCE_KEY[nodeId]
  return key ? record[key] : undefined
}

const EVENT_STATUS: Record<string, RunSnapshot['status']> = {
  running: 'running', interactive: 'running', blocked: 'failed', succeeded: 'succeeded', passed: 'succeeded', approved: 'succeeded',
  /** The controller stepped away (Ctrl-C) while a native session kept running: unresolved until `automatic --live` resumes it. */
  interrupted: 'paused',
}
const CONTENT_TYPES: Record<ArtifactContent['kind'], string> = {
  log: 'text/plain; charset=utf-8', patch: 'text/plain; charset=utf-8', test_report: 'application/json; charset=utf-8',
  screenshot: 'image/png', other: 'application/octet-stream',
}

export function encodeCursor(scope: { project_id: string; workflow_id: string }, run: { updated_at: string; run_id: string }): string {
  return Buffer.from(JSON.stringify({ v: 1, p: scope.project_id, w: scope.workflow_id, u: run.updated_at, r: run.run_id }), 'utf8').toString('base64url')
}

const cursorSchema = z.strictObject({ v: z.literal(1), p: id, w: id, u: timestamp, r: id })

/** Cursors are opaque keyset tokens bound to one workflow; anything else is a 400, never a path or a guess. */
export function decodeCursor(cursor: string, scope: { project_id: string; workflow_id: string }): { updated_at: string; run_id: string } {
  const invalid = new ProjectApiError(400, 'INVALID_CURSOR', 'The cursor is not a paging token issued for this workflow. Restart from the first page.')
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
  } catch {
    throw invalid
  }
  const result = cursorSchema.safeParse(parsed)
  if (!result.success || result.data.p !== scope.project_id || result.data.w !== scope.workflow_id) throw invalid
  return { updated_at: result.data.u, run_id: result.data.r }
}

/** Sort key: newest update first, then run ID ascending; the same order the keyset cursor walks. */
export function compareRuns(a: { updated_at: string; run_id: string }, b: { updated_at: string; run_id: string }): number {
  const byTime = Date.parse(b.updated_at) - Date.parse(a.updated_at)
  if (byTime !== 0) return byTime
  return a.run_id < b.run_id ? -1 : a.run_id > b.run_id ? 1 : 0
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function errno(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException)?.code
}

function isMissing(error: unknown): boolean {
  const code = errno(error)
  return code === 'ENOENT' || code === 'ENOTDIR' || code === 'ELOOP' || code === 'ENXIO'
}

/**
 * Reads `components` below an open directory with one no-follow open per step, so no symlink inside a run can
 * redirect the read outside it. Returns null when any component is missing, a symlink or not the expected kind.
 * The final file is read at most `limit` bytes; a larger file is refused rather than truncated.
 */
async function readBounded(directory: FileHandle, components: readonly string[], limit: number): Promise<Buffer | null> {
  const handles: FileHandle[] = []
  try {
    let parent = directory
    for (const component of components.slice(0, -1)) {
      parent = await fs.open(at(parent, component), DIRECTORY_FLAGS)
      handles.push(parent)
    }
    const file = await fs.open(at(parent, components[components.length - 1]), FILE_FLAGS)
    handles.push(file)
    if (!(await file.stat()).isFile()) return null
    const buffer = Buffer.allocUnsafe(limit + 1)
    let offset = 0
    while (offset < buffer.length) {
      const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset)
      if (bytesRead === 0) break
      offset += bytesRead
    }
    if (offset > limit) throw new ProjectApiError(500, 'FILE_TOO_LARGE', `The file ${components.join('/')} exceeds the ${limit} byte read limit.`)
    return buffer.subarray(0, offset)
  } catch (error) {
    if (isMissing(error)) return null
    throw error
  } finally {
    await Promise.all(handles.reverse().map(handle => handle.close()))
  }
}

async function openDirectory(parent: FileHandle, name: string): Promise<FileHandle | null> {
  try {
    return await fs.open(at(parent, name), DIRECTORY_FLAGS)
  } catch (error) {
    if (isMissing(error)) return null
    throw error
  }
}

function parseJson(bytes: Buffer, describe: string): unknown {
  try {
    return JSON.parse(bytes.toString('utf8'))
  } catch {
    throw new ProjectApiError(500, 'RUN_STORAGE_INVALID', `${describe} is not valid JSON.`)
  }
}

function invalidRun(runId: string, detail: string): ProjectApiError {
  return new ProjectApiError(500, 'RUN_STORAGE_INVALID', `Run "${runId}" has malformed or contradictory persisted state: ${redactPaths(detail)}`)
}

function issueText(error: z.ZodError): string {
  return error.issues.slice(0, 3).map(issue => `${issue.path.length ? issue.path.join('.') : '(root)'}: ${issue.message}`).join('; ')
}

function packetPath(packet: PacketRegistration): string {
  return `verification/${packet.phase}/${packet.node_id}/${packet.attempt}/packet.json`
}

function resultRoute(scope: Scope, runId: string, phase: 'worker' | 'candidate', worker: string, attempt: number): string {
  const node = phase === 'worker' ? worker : `candidate_${worker}`
  return `${runRoute(scope, runId)}/results/${encodeURIComponent(node)}/${attempt}`
}

function runRoute(scope: Scope, runId: string): string {
  return `/api/projects/${encodeURIComponent(scope.project.project_id)}/workflows/${encodeURIComponent(scope.workflow.workflow_id)}/runs/${encodeURIComponent(runId)}`
}

function reviewRoute(scope: Scope, runId: string, attempt: number): string {
  return `${runRoute(scope, runId)}/reviews/${attempt}`
}

function artifactRoute(scope: Scope, runId: string, artifactId: string): string {
  return `${runRoute(scope, runId)}/artifacts/${encodeURIComponent(artifactId)}`
}

/** The review diff's artifact ID is derived from its registered content hash, so it changes whenever the diff does. */
function reviewArtifactId(sha256: string): string {
  return `${REVIEW_ARTIFACT_PREFIX}${sha256.slice(0, 12)}`
}

/** Receipts record `+00:00`; the contract wants a trailing Z. Other offsets are converted, dropping sub-millisecond digits. */
function utcTimestamp(value: string): string {
  if (value.endsWith('Z')) return value
  if (value.endsWith('+00:00')) return `${value.slice(0, -6)}Z`
  return new Date(value).toISOString()
}

/** Redacts, then bounds a persisted text so a cut can never expose a partial path; the marker counts what was dropped. */
function boundedText(raw: string): { text: string; truncated: boolean } {
  const text = redactPaths(raw)
  if (text.length <= TEXT_LIMIT) return { text, truncated: false }
  let cut = TEXT_LIMIT
  const last = text.charCodeAt(cut - 1)
  if (last >= 0xd800 && last <= 0xdbff) cut -= 1
  return { text: `${text.slice(0, cut)}\n\n[… truncated by the viewer API: ${text.length - cut} more characters]`, truncated: true }
}

function nonBlank(items: readonly string[]): string[] {
  return items.filter(item => item.trim().length > 0)
}

/**
 * The lanes whose pinned task text (or, when the task is empty, prompt) contains the reviewer's quote verbatim.
 * Matching runs on the raw texts before redaction, so a quote that names a path still links and a quote written
 * with the redaction marker does not; the redacted quote must also survive in the served (bounded) text, so a
 * link never points at a task whose visible text cannot show the quote. Nothing is inferred.
 */
function lanesQuoting(requirement: string | null, inputs: InputsSection | null): string[] {
  if (requirement === null || inputs === null) return []
  const served = redactPaths(requirement)
  return Object.entries(inputs.workers).filter(([, worker]) => {
    const text = worker.task.length > 0 ? worker.task : worker.prompt ?? ''
    return text.includes(requirement) && boundedText(text).text.includes(served)
  }).map(([lane]) => lane)
}

/** Projects the export's review section onto the review-result contract; the caller applies the cross-field rules. */
function projectReview(scope: Scope, runId: string, section: ReviewSection, inputs: InputsSection | null): ReviewResult {
  return {
    contract_version: '1.3.0', run_id: runId, node_id: 'review', attempt: section.attempt,
    reviewer: { session_id: redactPaths(section.reviewer_session_id), transport: section.transport, independent: true },
    bundle_sha256: section.bundle_sha256, candidate_commit: section.candidate_commit, verdict: section.verdict,
    findings: section.findings.map(finding => ({
      severity: finding.severity, message: redactPaths(finding.message), disposition: finding.disposition, worker: finding.worker,
      requirement: finding.requirement === null ? null : redactPaths(finding.requirement),
      requirement_found_in: lanesQuoting(finding.requirement, inputs),
    })),
    reviewed_at: utcTimestamp(section.reviewed_at),
    diff: section.diff === null ? null : reviewDiffArtifact(scope, runId, section.diff.sha256),
  }
}

/** The review diff as a scoped patch artifact link; its content is served only through the artifact route's registry checks. */
function reviewDiffArtifact(scope: Scope, runId: string, sha256: string): NonNullable<ReviewResult['diff']> {
  const artifact_id = reviewArtifactId(sha256)
  return { artifact_id, kind: 'patch', uri: artifactRoute(scope, runId, artifact_id), sha256 }
}

/** Projects the export's inputs section onto the run-inputs contract: policy order, redacted and bounded texts, Z timestamps. */
function projectInputs(runId: string, definition: WorkflowDefinition, section: InputsSection): RunInputs {
  const nodes = new Set(definition.nodes.map(node => node.node_id))
  const workers = Object.entries(section.workers).map(([lane, worker]) => ({
    node_id: lane,
    launch_node_id: nodes.has(`launch_${lane}`) ? `launch_${lane}` : lane,
    role: worker.role,
    // Exports before 1.3.0 carry no required kinds; the controller derived them from the role exactly like this.
    required_check_kinds: worker.required_check_kinds ? [...worker.required_check_kinds] : [...(ROLE_REQUIRED_KINDS[worker.role] ?? [])],
    task: boundedText(worker.task),
    prompt: worker.prompt === null ? null : boundedText(worker.prompt),
    owned_paths: [...worker.owned_paths],
    checks: worker.checks.map(check => ({
      id: check.id, kind: check.kind, command: check.command, timeout_seconds: check.timeout_seconds,
      scenarios: check.scenarios.map(scenario => ({ id: scenario.id, description: scenario.description })),
    })),
    launch: worker.launch === null ? null : {
      session_id: worker.launch.session_id, launch_requested_at: utcTimestamp(worker.launch.launch_requested_at),
      native_started_at: worker.launch.native_started_at === null ? null : new Date(worker.launch.native_started_at).toISOString(),
      observed_state: worker.launch.observed_state, status: worker.launch.status, launcher_invocations: worker.launch.launcher_invocations,
    },
    completion: worker.completion === null ? null : { status: worker.completion.status, summary: redactPaths(worker.completion.summary), open_assumptions: nonBlank(worker.completion.open_assumptions).map(redactPaths) },
    handoff: worker.handoff === null ? null : { summary: redactPaths(worker.handoff.summary), open_assumptions: nonBlank(worker.handoff.open_assumptions).map(redactPaths) },
    stop: worker.stop === null ? null : { stopped: worker.stop.stopped, confirmed_at: worker.stop.confirmed_at === null ? null : utcTimestamp(worker.stop.confirmed_at) },
  }))
  return {
    contract_version: '1.3.0', run_id: runId, feature: redactPaths(section.feature), base_commit: section.base_commit, source_branch: section.source_branch,
    mode: section.mode, automatic: section.automatic === null ? null : { ...section.automatic },
    setup: section.setup.map(step => ({ command: step.command, timeout_seconds: step.timeout_seconds })),
    max_verification_attempts: section.max_verification_attempts,
    // Exports before 1.3.0 describe every lane they ran and excluded nothing.
    selected_workers: section.selected_workers ? [...section.selected_workers] : Object.keys(section.workers),
    excluded_workers: section.excluded_workers ? [...section.excluded_workers] : [],
    workers,
  }
}

/**
 * The lanes of a run: `inputs.workers` in policy order, or the fixed pair for exports without an `inputs` section.
 * A definition whose per-lane nodes name a lane the export does not describe is contradictory once `inputs` exists.
 */
function runLanes(runId: string, definition: WorkflowDefinition, inputs: InputsSection | null): LaneMap {
  const map = laneMap(inputs ? Object.keys(inputs.workers) : LEGACY_LANES)
  if (inputs) {
    for (const node of definition.nodes) {
      const prefix = ['launch_', 'verify_'].find(candidate => node.node_id.startsWith(candidate))
      if (prefix && !map.workerOf.has(node.node_id)) throw invalidRun(runId, `graph node ${node.node_id} names a lane the inputs section does not describe`)
    }
  }
  return map
}

/** Splits `ui`/`candidate_ui` result route IDs back into a registered packet phase and worker. */
function parseResultNode(nodeId: string): { phase: 'worker' | 'candidate'; worker: string } {
  return nodeId.startsWith('candidate_') ? { phase: 'candidate', worker: nodeId.slice('candidate_'.length) } : { phase: 'worker', worker: nodeId }
}

function laterTimestamp(a: string, b: string): string {
  return Date.parse(b) > Date.parse(a) ? b : a
}

export type RunStoreOptions = {
  exportByteLimit?: number
  packetByteLimit?: number
  artifactByteLimit?: number
  /** Receives skipped legacy directories and unexpected failures for logging; details may name run directories. */
  warn?: (message: string, details: Record<string, unknown>) => void
}

export class RunStore {
  readonly config: ProjectsConfig
  private readonly projectsById = new Map<string, ProjectConfig>()
  private readonly options: Required<Omit<RunStoreOptions, 'warn'>> & Pick<RunStoreOptions, 'warn'>

  constructor(config: ProjectsConfig, options: RunStoreOptions = {}) {
    this.config = config
    for (const project of config.projects) this.projectsById.set(project.project_id, project)
    this.options = {
      exportByteLimit: options.exportByteLimit ?? DEFAULT_EXPORT_BYTE_LIMIT,
      packetByteLimit: options.packetByteLimit ?? DEFAULT_PACKET_BYTE_LIMIT,
      artifactByteLimit: options.artifactByteLimit ?? DEFAULT_ARTIFACT_BYTE_LIMIT,
      warn: options.warn,
    }
  }

  projects(): Project[] {
    return this.config.projects.map(project => ({ project_id: project.project_id, name: project.name }))
  }

  project(projectId: string): ProjectConfig {
    const project = this.projectsById.get(projectId)
    if (!project) throw new ProjectApiError(404, 'PROJECT_NOT_FOUND', 'No project with that ID is registered.')
    return project
  }

  workflows(projectId: string): WorkflowDefinition[] {
    return this.project(projectId).workflows.map(workflow => workflow.definition)
  }

  scope(projectId: string, workflowId: string): Scope {
    const project = this.project(projectId)
    const workflow = project.workflows.find(candidate => candidate.workflow_id === workflowId)
    if (!workflow) throw new ProjectApiError(404, 'WORKFLOW_NOT_FOUND', 'No workflow with that ID is registered in this project.')
    return { project, workflow }
  }

  /** Opens the workflow's configured run root no-follow for one operation. An unusable root is a 503, never an empty list. */
  private async withRunsRoot<T>(scope: Scope, operation: (root: FileHandle) => Promise<T>): Promise<T> {
    let root: FileHandle
    try {
      root = await fs.open(scope.workflow.runs_root, DIRECTORY_FLAGS)
    } catch (error) {
      const code = errno(error)
      const reason = code === 'ENOENT' ? 'does not exist' : code === 'EACCES' || code === 'EPERM' ? 'is not readable' : 'is not a directory (symbolic links are never followed)'
      if (!isMissing(error) && code !== 'EACCES' && code !== 'EPERM') throw error
      throw new ProjectApiError(503, 'RUNS_ROOT_UNAVAILABLE', `The configured run storage for this workflow ${reason}. Check the registry configuration.`)
    }
    try {
      return await operation(root)
    } finally {
      await root.close()
    }
  }

  /** Every run under the workflow root, newest first. Legacy directories without a supported export are skipped with a warning. */
  async listRuns(scope: Scope): Promise<RunSummary[]> {
    return this.withRunsRoot(scope, async root => {
      const names = (await fs.readdir(at(root), { withFileTypes: true }))
        .filter(dirent => dirent.isDirectory() && ID_PATTERN.test(dirent.name)).map(dirent => dirent.name).sort()
      const summaries: RunSummary[] = []
      const seen = new Set<string>()
      for (const name of names) {
        const directory = await openDirectory(root, name)
        if (!directory) continue
        try {
          const state = await readBounded(directory, ['run-state.json'], this.options.exportByteLimit)
          if (state === null) {
            if (await readBounded(directory, ['plan.json'], this.options.exportByteLimit) !== null) {
              this.options.warn?.('Skipping run directory without a supported run-state.json export; explicit import is required', { project_id: scope.project.project_id, workflow_id: scope.workflow.workflow_id, run: name })
            }
            continue
          }
          const run = await this.projectRun(scope, name, directory, state)
          if (seen.has(run.detail.summary.run_id)) throw invalidRun(name, 'duplicate run ID within the workflow')
          seen.add(run.detail.summary.run_id)
          summaries.push(run.detail.summary)
        } finally {
          await directory.close()
        }
      }
      return summaries.sort(compareRuns)
    })
  }

  async loadRun(scope: Scope, runId: string): Promise<LoadedRun> {
    return this.withRunsRoot(scope, async root => {
      const directory = await openDirectory(root, runId)
      if (!directory) throw new ProjectApiError(404, 'RUN_NOT_FOUND', 'No run with that ID exists in this workflow.')
      try {
        const state = await readBounded(directory, ['run-state.json'], this.options.exportByteLimit)
        if (state === null) {
          if (await readBounded(directory, ['plan.json'], this.options.exportByteLimit) !== null) {
            throw new ProjectApiError(404, 'RUN_UNSUPPORTED', 'This run predates the supported state export and needs an explicit import; it is not displayed.')
          }
          throw new ProjectApiError(404, 'RUN_NOT_FOUND', 'No run with that ID exists in this workflow.')
        }
        return await this.projectRun(scope, runId, directory, state)
      } finally {
        await directory.close()
      }
    })
  }

  async workerResult(scope: Scope, runId: string, nodeId: string, attempt: number): Promise<WorkerResult> {
    const run = await this.loadRun(scope, runId)
    const { phase, worker } = parseResultNode(nodeId)
    const packet = run.packets.find(candidate => candidate.phase === phase && candidate.node_id === worker && candidate.attempt === attempt)
    if (!packet) throw new ProjectApiError(404, 'RESULT_NOT_FOUND', 'No verified result is registered for that node and attempt.')
    if (!packet.ok) throw new ProjectApiError(500, 'EVIDENCE_MISMATCH', `The registered verification packet for ${nodeId}/${attempt} cannot be trusted: ${packet.reason}`)
    return projectWorkerResult(scope, runId, nodeId, packet)
  }

  /** The recorded review of a run. Absent sections and other attempts are 404: not recorded, never an error page. */
  async reviewResult(scope: Scope, runId: string, attempt: number): Promise<ReviewResult> {
    const run = await this.loadRun(scope, runId)
    if (!run.review || run.review.attempt !== attempt) {
      throw new ProjectApiError(404, 'REVIEW_NOT_FOUND', 'No review is recorded for that attempt: either the review has not happened or the run export predates review results.')
    }
    return run.review
  }

  /** What the run was asked to do. Absent sections are 404: not recorded, never an error page. */
  async runInputs(scope: Scope, runId: string): Promise<RunInputs> {
    const run = await this.loadRun(scope, runId)
    if (!run.inputs) throw new ProjectApiError(404, 'INPUTS_NOT_FOUND', 'No inputs are recorded for this run: its export predates run inputs.')
    return run.inputs
  }

  /**
   * Serves one registered artifact: a packet artifact beside its verification packet, or the review diff the
   * export registered at the run root. Both registries are consulted; an ID registered with different hashes,
   * a malformed entry or an untrusted packet is refused, and the content is served only when it still hashes
   * (and, for the review diff, measures) as registered.
   */
  async artifact(scope: Scope, runId: string, artifactId: string): Promise<ArtifactContent> {
    const run = await this.loadRun(scope, runId)
    const registered: { components: string[]; kind: ArtifactContent['kind']; sha256: string; bytes: number | null }[] = []
    if (run.reviewDiff && run.reviewDiff.artifact_id === artifactId) {
      registered.push({ components: [REVIEW_DIFF_FILE], kind: 'patch', sha256: run.reviewDiff.sha256, bytes: run.reviewDiff.bytes })
    }
    let untrusted = false
    for (const packet of run.packets) {
      if (!packet.ok) { untrusted = true; continue }
      const artifacts = Array.isArray(packet.result.artifacts) ? packet.result.artifacts as Record<string, unknown>[] : []
      for (const artifact of artifacts) {
        if (artifact?.artifact_id !== artifactId) continue
        const parsed = artifactRegistrationSchema.safeParse(artifact)
        if (!parsed.success) throw new ProjectApiError(500, 'EVIDENCE_MISMATCH', 'The registered artifact entry is malformed.')
        registered.push({ components: ['verification', packet.phase, packet.node_id, String(packet.attempt), 'artifacts', parsed.data.uri], kind: parsed.data.kind, sha256: parsed.data.sha256, bytes: null })
      }
    }
    if (registered.length === 0) {
      if (untrusted) throw new ProjectApiError(500, 'EVIDENCE_MISMATCH', 'A verification packet in this run cannot be trusted, so its artifacts are not served.')
      throw new ProjectApiError(404, 'ARTIFACT_NOT_FOUND', 'No artifact with that ID is registered for this run.')
    }
    const digests = new Set(registered.map(entry => entry.sha256))
    if (digests.size !== 1) throw new ProjectApiError(500, 'EVIDENCE_MISMATCH', 'The artifact ID is registered with conflicting content hashes.')
    const artifact = registered[0]
    const components = artifact.components
    const bytes = await this.withRunsRoot(scope, async root => {
      const directory = await openDirectory(root, runId)
      if (!directory) throw new ProjectApiError(404, 'RUN_NOT_FOUND', 'No run with that ID exists in this workflow.')
      try {
        return await readBounded(directory, components, this.options.artifactByteLimit)
      } catch (error) {
        if (error instanceof ProjectApiError && error.code === 'FILE_TOO_LARGE') throw new ProjectApiError(500, 'ARTIFACT_TOO_LARGE', 'The registered artifact exceeds the size limit for viewing.')
        throw error
      } finally {
        await directory.close()
      }
    })
    if (bytes === null) throw new ProjectApiError(500, 'ARTIFACT_UNAVAILABLE', 'The registered artifact file is missing, is not a regular file or is a symbolic link.')
    if ((artifact.bytes !== null && bytes.length !== artifact.bytes) || sha256(bytes) !== artifact.sha256) {
      throw new ProjectApiError(500, 'ARTIFACT_HASH_MISMATCH', 'The artifact content does not match its registered hash or size and is not served.')
    }
    const png = artifact.kind === 'screenshot' && bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
    const kind = artifact.kind === 'screenshot' && !png ? 'other' : artifact.kind
    return { artifact_id: artifactId, kind: artifact.kind, contentType: CONTENT_TYPES[kind], disposition: kind === 'other' ? 'attachment' : 'inline', bytes }
  }

  /** Validates the export and companion files, then projects them onto the public contract. */
  private async projectRun(scope: Scope, runId: string, directory: FileHandle, stateBytes: Buffer): Promise<LoadedRun> {
    const parsedExport = exportSchema.safeParse(parseJson(stateBytes, `run-state.json of run "${runId}"`))
    if (!parsedExport.success) throw invalidRun(runId, `run-state.json ${issueText(parsedExport.error)}`)
    const state = parsedExport.data
    if (state.run_id !== runId) throw invalidRun(runId, 'run-state.json names a different run_id than its directory')
    const planBytes = await readBounded(directory, ['plan.json'], this.options.exportByteLimit)
    if (planBytes === null) throw invalidRun(runId, 'plan.json is missing')
    const plan = planSchema.safeParse(parseJson(planBytes, `plan.json of run "${runId}"`))
    if (!plan.success) throw invalidRun(runId, `plan.json ${issueText(plan.error)}`)
    if (plan.data.run_id !== state.run_id || plan.data.base_commit !== state.base_commit) throw invalidRun(runId, 'plan.json and run-state.json disagree about the run identity')
    let definition: WorkflowDefinition
    try {
      definition = publishDefinition(scope.project.project_id, scope.workflow.workflow_id, state.definition)
    } catch (error) {
      throw invalidRun(runId, `pinned definition is invalid (${error instanceof z.ZodError ? issueText(error) : (error as Error).message})`)
    }
    const packets = await this.loadPackets(runId, directory, state.verification_packets)
    const rawEvents = await this.readEvents(runId, directory, state)
    const lanes = runLanes(runId, definition, state.inputs ?? null)
    const events = normalizeEvents(state.run_id, definition, rawEvents, lanes)
    const snapshot = projectSnapshot(scope, definition, state, rawEvents, packets, lanes)
    const created_at = state.created_at
    const updated_at = laterTimestamp(laterTimestamp(state.updated_at, rawEvents.at(-1)?.time ?? created_at), created_at)
    const summary: RunSummary = {
      contract_version: '1.0.0', project_id: scope.project.project_id, workflow_id: scope.workflow.workflow_id,
      definition_revision: definition.definition_revision, run_id: state.run_id, status: snapshot.status, created_at, updated_at,
    }
    const contractFailure = (what: string, error: unknown) => invalidRun(runId, `${what} violates the contract (${error instanceof z.ZodError ? issueText(error) : (error as Error).message})`)
    let detail: RunDetail
    try {
      detail = validateRunDetail({ summary, definition, snapshot })
    } catch (error) {
      throw contractFailure('projection', error)
    }
    // Sections are projected eagerly so a contradictory review or assignment fails the run as a whole, like any other malformed export.
    let inputs: RunInputs | null = null
    if (state.inputs) {
      try {
        inputs = validateRunInputs(projectInputs(state.run_id, definition, state.inputs))
      } catch (error) {
        throw contractFailure('inputs section', error)
      }
    }
    let review: ReviewResult | null = null
    if (state.review) {
      try {
        review = validateReviewResult(projectReview(scope, state.run_id, state.review, state.inputs ?? null))
        // A finding names a lane this run had, an attribution (`multiple`, `none`, the legacy `both`) or nothing; anything else is contradictory.
        for (const item of review.findings) {
          if (item.worker !== null && !lanes.lanes.includes(item.worker) && !(FINDING_ATTRIBUTIONS as readonly string[]).includes(item.worker)) {
            throw new Error(`finding names "${item.worker}", which is neither a lane of this run nor an attribution`)
          }
        }
      } catch (error) {
        throw contractFailure('review section', error)
      }
    }
    const reviewDiff = state.review?.diff ? { artifact_id: reviewArtifactId(state.review.diff.sha256), sha256: state.review.diff.sha256, bytes: state.review.diff.bytes } : null
    return { detail, events, packets, review, inputs, reviewDiff }
  }

  private async loadPackets(runId: string, directory: FileHandle, registrations: PacketRegistration[]): Promise<LoadedPacket[]> {
    const keys = new Set<string>()
    const packets: LoadedPacket[] = []
    for (const registration of registrations) {
      const key = `${registration.phase}:${registration.node_id}:${registration.attempt}`
      if (keys.has(key)) throw invalidRun(runId, `duplicate verification packet registration ${key}`)
      keys.add(key)
      if (registration.path !== packetPath(registration)) throw invalidRun(runId, `verification packet ${key} is registered outside the run's verification directory`)
      let bytes: Buffer | null
      try {
        bytes = await readBounded(directory, registration.path.split('/'), this.options.packetByteLimit)
      } catch (error) {
        if (!(error instanceof ProjectApiError)) throw error
        packets.push({ ...registration, ok: false, reason: 'packet exceeds the read limit' })
        continue
      }
      if (bytes === null) { packets.push({ ...registration, ok: false, reason: 'packet file is missing or not a regular file' }); continue }
      if (sha256(bytes) !== registration.sha256) { packets.push({ ...registration, ok: false, reason: 'packet content does not match its registered hash' }); continue }
      let parsed: unknown
      try {
        parsed = JSON.parse(bytes.toString('utf8'))
      } catch {
        packets.push({ ...registration, ok: false, reason: 'packet is not valid JSON' })
        continue
      }
      const packet = packetSchema.safeParse(parsed)
      if (!packet.success) { packets.push({ ...registration, ok: false, reason: `packet ${issueText(packet.error)}` }); continue }
      if (packet.data.phase !== registration.phase) { packets.push({ ...registration, ok: false, reason: 'packet phase differs from its registration' }); continue }
      packets.push({ ...registration, ok: true, gate: packet.data.gate, result: packet.data.result })
    }
    return packets
  }

  /** `events.jsonl` is the live append-only log; the export's embedded copy is the fallback when it is absent. */
  private async readEvents(runId: string, directory: FileHandle, state: RunExport): Promise<RawEvent[]> {
    const bytes = await readBounded(directory, ['events.jsonl'], this.options.exportByteLimit)
    let raw: unknown[]
    if (bytes === null) {
      raw = state.events
    } else {
      const text = bytes.toString('utf8')
      const lines = text.split('\n')
      // A partially appended final line (no trailing newline) is in flight, not corruption.
      if (lines.length && lines[lines.length - 1] !== '' && !text.endsWith('\n')) lines.pop()
      raw = []
      for (const line of lines) {
        if (line.trim() === '') continue
        try {
          raw.push(JSON.parse(line))
        } catch {
          throw invalidRun(runId, 'events.jsonl contains a malformed line')
        }
      }
    }
    const events: RawEvent[] = []
    for (const [index, item] of raw.entries()) {
      const parsed = rawEventSchema.safeParse(item)
      if (!parsed.success) throw invalidRun(runId, `event ${index} ${issueText(parsed.error)}`)
      if (events.length && parsed.data.sequence <= events[events.length - 1].sequence) throw invalidRun(runId, 'event sequence numbers are not strictly increasing')
      events.push(parsed.data)
    }
    return events
  }
}

const artifactRegistrationSchema = z.object({
  artifact_id: z.string().min(1),
  kind: z.enum(['patch', 'log', 'screenshot', 'test_report', 'other']),
  /** Producer registries store the artifact's basename beside the packet; anything else is not followed. */
  uri: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/),
  sha256: hex64,
})

/** Maps a raw event node name onto the pinned graph, or null when it names nothing in this definition. */
function eventNode(definition: WorkflowDefinition, node: string, map: LaneMap): string | null {
  const known = new Set(definition.nodes.map(item => item.node_id))
  if (known.has(node)) return node
  const alias = map.eventAliases.get(node)
  return alias && known.has(alias) ? alias : null
}

function present(value: unknown): boolean {
  return value !== undefined && value !== null
}

function hasEvidence(state: RunExport, nodeId: string, map: LaneMap): boolean {
  if (present(nodeEvidence(state.values, nodeId, map))) return true
  return state.tasks.some(task => task.result !== null && present(nodeEvidence(task.result, nodeId, map)))
}

function attemptFromMessage(message: string): number | null {
  const match = /\bAttempt (\d+)\b/.exec(message)
  return match ? Number(match[1]) : null
}

/** Normalizes internal `{sequence,time,node,status,message}` records into workflow-v1 events. */
export function normalizeEvents(runId: string, definition: WorkflowDefinition, raw: readonly RawEvent[], map: LaneMap = laneMap(LEGACY_LANES)): WorkflowEvent[] {
  const attempts = new Map<string, number>()
  return raw.map(event => {
    const node_id = eventNode(definition, event.node, map)
    let attempt = 0
    if (node_id) {
      const parsed = attemptFromMessage(event.message)
      if (parsed !== null) attempts.set(node_id, parsed)
      attempt = attempts.get(node_id) ?? 1
    }
    // A status only means something for a node in the pinned graph; unattributed records are plain log lines.
    const status = node_id ? EVENT_STATUS[event.status] ?? null : null
    return eventSchema.parse({
      contract_version: '1.0.0', run_id: runId, event_id: `${runId}:${event.sequence}`, sequence: event.sequence, occurred_at: event.time,
      node_id, attempt, type: status ? 'status_changed' : 'log', status, message: redactPaths(event.message),
      artifact: null, result_uri: null, reused_from_attempt: null,
    })
  })
}

type NodeStatus = RunSnapshot['nodes'][number]['status']

/**
 * Projects the persisted graph state onto the pinned definition. Precedence per node: a task error is failed, an
 * interrupt is awaiting approval, confirmed completion evidence is succeeded (verification nodes additionally need
 * their registered packet to load, match its hash and have passed), then the last persisted event, then pending.
 * The run succeeds only once integrated with nothing pending; contradictory evidence is paused.
 */
export function projectSnapshot(scope: Scope, definition: WorkflowDefinition, state: RunExport, rawEvents: readonly RawEvent[], packets: readonly LoadedPacket[], map: LaneMap = laneMap(LEGACY_LANES)): RunSnapshot {
  const lastEvent = new Map<string, RawEvent>()
  const eventAttempt = new Map<string, number>()
  for (const event of rawEvents) {
    const node = eventNode(definition, event.node, map)
    if (!node) continue
    // Only a status-bearing event moves a node; a plain record (`stopped`, a note) never hides the last status.
    if (EVENT_STATUS[event.status] !== undefined) lastEvent.set(node, event)
    const attempt = attemptFromMessage(event.message)
    if (attempt !== null) eventAttempt.set(node, Math.max(attempt, eventAttempt.get(node) ?? 0))
  }
  const latestPacket = (phase: 'worker' | 'candidate', worker: string) => packets
    .filter(packet => packet.phase === phase && packet.node_id === worker).sort((a, b) => b.attempt - a.attempt)[0]
  const workers = new Set(packets.map(packet => packet.node_id))
  const nodes = definition.nodes.map(node => {
    const task = state.tasks.find(candidate => candidate.node_id === node.node_id)
    const evidenced = map.workerOf.has(node.node_id) || node.node_id in TAIL_EVIDENCE_KEY
    const worker = map.workerOf.get(node.node_id)
    const workerPacket = worker ? latestPacket('worker', worker) : undefined
    let attempt = 0
    let session_id: string | null = null
    let result_uri: string | null = null
    if (worker) {
      if (workerPacket) {
        attempt = map.verifyNodes.has(node.node_id) ? workerPacket.attempt : 1
        result_uri = resultRoute(scope, state.run_id, 'worker', worker, workerPacket.attempt)
        const session = workerPacket.ok ? workerPacket.result.session_id : null
        session_id = typeof session === 'string' && session.length > 0 ? session : null
      }
      if (!map.verifyNodes.has(node.node_id)) {
        const receipt = laneValue(state.values, worker, 'launch')
        const session = receipt && typeof receipt === 'object' ? (receipt as Record<string, unknown>).session_id : null
        if (typeof session === 'string' && session.length > 0) session_id = session
      }
    }
    if (node.node_id === 'candidate') attempt = Math.max(0, ...packets.filter(packet => packet.phase === 'candidate').map(packet => packet.attempt))
    if (map.verifyNodes.has(node.node_id)) attempt = Math.max(attempt, eventAttempt.get(node.node_id) ?? 0)
    // The review node names its reviewer and links to the recorded result only from the export's review section, never from `values`.
    if (node.node_id === 'review' && state.review) {
      attempt = state.review.attempt
      session_id = redactPaths(state.review.reviewer_session_id)
      result_uri = reviewRoute(scope, state.run_id, state.review.attempt)
    }
    let status: NodeStatus
    const event = lastEvent.get(node.node_id)
    const eventStatus = event ? EVENT_STATUS[event.status] ?? null : null
    if (task?.error) status = 'failed'
    else if (task && task.interrupts.length > 0) status = 'awaiting_approval'
    else if (hasEvidence(state, node.node_id, map)) {
      if (map.verifyNodes.has(node.node_id)) status = workerPacket?.ok && workerPacket.gate.status === 'passed' ? 'succeeded' : 'paused'
      else if (node.node_id === 'candidate') {
        const latest = [...workers].map(candidate => latestPacket('candidate', candidate)).filter(packet => packet !== undefined)
        status = latest.length > 0 && latest.every(packet => packet.ok && packet.gate.status === 'passed') ? 'succeeded' : 'paused'
      } else status = 'succeeded'
    } else if (eventStatus === 'succeeded') status = evidenced ? 'paused' : 'succeeded'
    else if (eventStatus) status = eventStatus
    else status = 'pending'
    if (status !== 'pending' && attempt === 0) attempt = 1
    if (status === 'pending') { attempt = 0; session_id = null; result_uri = null }
    return { node_id: node.node_id, kind: node.kind, depends_on: [...node.depends_on], status, attempt, session_id, result_uri }
  })
  const statuses = new Set(nodes.map(node => node.status))
  const integrated = hasEvidence(state, 'integrate', map)
  let status: NodeStatus
  if (statuses.has('failed')) status = 'failed'
  else if (statuses.has('awaiting_approval')) status = 'awaiting_approval'
  else if (statuses.has('paused')) status = 'paused'
  else if (integrated && state.next.length === 0 && !statuses.has('running') && !statuses.has('pending')) status = 'succeeded'
  else if (integrated) status = 'paused'
  else if (statuses.has('running') || state.next.length > 0) status = 'running'
  else if (statuses.size === 1 && statuses.has('pending')) status = 'pending'
  else status = 'paused'
  return { contract_version: '1.0.0', run_id: state.run_id, status, last_sequence: rawEvents.at(-1)?.sequence ?? 0, nodes }
}

/** Publishes a verified packet's result: scoped artifact links, no worktree paths, and a failed status when the gate did not pass. */
function projectWorkerResult(scope: Scope, runId: string, nodeId: string, packet: LoadedPacket & { ok: true }): WorkerResult {
  const raw = packet.result
  if (raw.run_id !== runId || raw.node_id !== packet.node_id || raw.attempt !== packet.attempt) {
    throw new ProjectApiError(500, 'EVIDENCE_MISMATCH', 'The verification packet result does not match its registration.')
  }
  const passed = packet.gate.status === 'passed'
  const checks = Array.isArray(raw.checks) ? (raw.checks as Record<string, unknown>[]).map(check => ({ ...check, cwd: `verification/${packet.phase}/${packet.node_id}/${packet.attempt}/worktree` })) : raw.checks
  const artifacts = Array.isArray(raw.artifacts) ? (raw.artifacts as Record<string, unknown>[]).map(artifact => ({
    ...artifact, uri: typeof artifact.artifact_id === 'string' ? `${runRoute(scope, runId)}/artifacts/${encodeURIComponent(artifact.artifact_id)}` : artifact.uri,
  })) : raw.artifacts
  const assumptions = Array.isArray(raw.open_assumptions) ? raw.open_assumptions.filter(item => typeof item === 'string' && item.trim().length > 0) : raw.open_assumptions
  const candidate = {
    contract_version: '1.0.0', run_id: runId, node_id: nodeId, attempt: packet.attempt, session_id: raw.session_id,
    status: passed ? raw.status : 'failed', base_commit: raw.base_commit, output_commit: raw.output_commit,
    changed_files: raw.changed_files, checks, open_assumptions: assumptions, artifacts,
    summary: typeof raw.summary === 'string' ? redactPaths(raw.summary) : raw.summary,
    error: passed ? raw.error : { code: 'VERIFICATION_BLOCKED', message: redactPaths(packet.gate.reasons.join('; ')) || 'Verification did not pass.', retryable: true },
  }
  try {
    return validateWorkerResult(candidate)
  } catch (error) {
    throw new ProjectApiError(500, 'RESULT_INVALID', `The verification packet result does not conform to the worker result contract: ${error instanceof z.ZodError ? issueText(error) : (error as Error).message}`)
  }
}
