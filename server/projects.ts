import { createHash } from 'node:crypto'
import fs, { type FileHandle } from 'node:fs/promises'
import { constants } from 'node:fs'
import { z } from 'zod'
import { validateRunDetail, type Project, type RunDetail, type RunSummary, type WorkflowDefinition } from '../contracts/projects/v1.ts'
import { eventSchema, validateWorkerResult, type RunSnapshot, type WorkerResult, type WorkflowEvent } from '../contracts/workflow/v1.ts'
import { DIRECTORY_FLAGS, at } from './files.ts'
import { ID_PATTERN, publishDefinition, storedDefinitionSchema, type ProjectConfig, type ProjectsConfig, type WorkflowConfig } from './projectsConfig.ts'

/**
 * Read-only access to persisted workflow runs. A run is a directory below a registered workflow's `runs_root`
 * containing the controller's atomic `run-state.json` export (plus `plan.json`, `events.jsonl` and
 * `verification/<phase>/<node>/<attempt>/packet.json` evidence). Nothing here spawns a process, decodes the
 * checkpoint database or writes to run storage; every request re-reads the persisted files and projects them
 * onto the public contract. Missing or contradictory evidence is reported as an error or a paused/failed state,
 * never as success.
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
const EXPORT_VERSION = '1.0.0'
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** Absolute filesystem paths in persisted messages are never forwarded to clients. */
export function redactPaths(text: string): string {
  return text.replace(/(?:^|(?<=[\s"'`(=:;,]))(?:~|\/[A-Za-z0-9._@~+-]+)(?:\/[A-Za-z0-9._@~+-]*)+/g, '<path>')
}

/** `stored` id pattern shared with the registry; also keeps run directories one safe component. */
const id = z.string().regex(ID_PATTERN)
const sha = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)
const hex64 = z.string().regex(/^[a-f0-9]{64}$/)
const timestamp = z.iso.datetime()

const exportSchema = z.object({
  version: z.literal(EXPORT_VERSION),
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

/** A registered packet after loading: either verified content or the reason it cannot be trusted. */
type LoadedPacket = PacketRegistration & (
  | { ok: true; gate: { status: string; reasons: string[] }; result: Record<string, unknown> }
  | { ok: false; reason: string }
)

type Scope = { project: ProjectConfig; workflow: WorkflowConfig }

export type LoadedRun = {
  detail: RunDetail
  events: WorkflowEvent[]
  packets: LoadedPacket[]
}

export type ArtifactContent = {
  artifact_id: string
  kind: 'patch' | 'log' | 'screenshot' | 'test_report' | 'other'
  contentType: string
  disposition: 'inline' | 'attachment'
  bytes: Buffer
}

/** Internal graph node → the LangGraph state key whose presence proves that node completed. */
const EVIDENCE_KEY: Record<string, string> = {
  launch_ui: 'ui', launch_adapter: 'adapter', handoff: 'snapshots', verify_ui: 'ui_packet', verify_adapter: 'adapter_packet',
  candidate: 'bundle', review: 'review', approval: 'approved_bundle', integrate: 'integrated_commit',
}
/** Graph nodes that concern one logical worker (`ui`/`adapter`), whose results are served under that ID. */
const WORKER_OF: Record<string, string> = { launch_ui: 'ui', launch_adapter: 'adapter', verify_ui: 'ui', verify_adapter: 'adapter' }
const VERIFY_NODES = new Set(['verify_ui', 'verify_adapter'])
/** Raw event node aliases → graph nodes. Anything else must already be a graph node or is left unattributed. */
const EVENT_ALIASES: Record<string, string> = { ui: 'launch_ui', adapter: 'launch_adapter', freeze: 'handoff', candidate_ui: 'candidate', candidate_adapter: 'candidate' }
const EVENT_STATUS: Record<string, RunSnapshot['status']> = {
  running: 'running', interactive: 'running', blocked: 'failed', succeeded: 'succeeded', passed: 'succeeded', approved: 'succeeded',
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

  async artifact(scope: Scope, runId: string, artifactId: string): Promise<ArtifactContent> {
    const run = await this.loadRun(scope, runId)
    const registered: { packet: LoadedPacket & { ok: true }; artifact: { kind: ArtifactContent['kind']; uri: string; sha256: string } }[] = []
    let untrusted = false
    for (const packet of run.packets) {
      if (!packet.ok) { untrusted = true; continue }
      const artifacts = Array.isArray(packet.result.artifacts) ? packet.result.artifacts as Record<string, unknown>[] : []
      for (const artifact of artifacts) {
        if (artifact?.artifact_id !== artifactId) continue
        const parsed = artifactRegistrationSchema.safeParse(artifact)
        if (!parsed.success) throw new ProjectApiError(500, 'EVIDENCE_MISMATCH', 'The registered artifact entry is malformed.')
        registered.push({ packet, artifact: parsed.data })
      }
    }
    if (registered.length === 0) {
      if (untrusted) throw new ProjectApiError(500, 'EVIDENCE_MISMATCH', 'A verification packet in this run cannot be trusted, so its artifacts are not served.')
      throw new ProjectApiError(404, 'ARTIFACT_NOT_FOUND', 'No artifact with that ID is registered for this run.')
    }
    const digests = new Set(registered.map(entry => entry.artifact.sha256))
    if (digests.size !== 1) throw new ProjectApiError(500, 'EVIDENCE_MISMATCH', 'The artifact ID is registered with conflicting content hashes.')
    const { packet, artifact } = registered[0]
    const components = ['verification', packet.phase, packet.node_id, String(packet.attempt), 'artifacts', artifact.uri]
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
    if (sha256(bytes) !== artifact.sha256) throw new ProjectApiError(500, 'ARTIFACT_HASH_MISMATCH', 'The artifact content does not match its registered hash and is not served.')
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
    const events = normalizeEvents(state.run_id, definition, rawEvents)
    const snapshot = projectSnapshot(scope, definition, state, rawEvents, packets)
    const created_at = state.created_at
    const updated_at = laterTimestamp(laterTimestamp(state.updated_at, rawEvents.at(-1)?.time ?? created_at), created_at)
    const summary: RunSummary = {
      contract_version: '1.0.0', project_id: scope.project.project_id, workflow_id: scope.workflow.workflow_id,
      definition_revision: definition.definition_revision, run_id: state.run_id, status: snapshot.status, created_at, updated_at,
    }
    let detail: RunDetail
    try {
      detail = validateRunDetail({ summary, definition, snapshot })
    } catch (error) {
      throw invalidRun(runId, `projection violates the contract (${error instanceof z.ZodError ? issueText(error) : (error as Error).message})`)
    }
    return { detail, events, packets }
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
function eventNode(definition: WorkflowDefinition, node: string): string | null {
  const known = new Set(definition.nodes.map(item => item.node_id))
  if (known.has(node)) return node
  const alias = EVENT_ALIASES[node]
  return alias && known.has(alias) ? alias : null
}

function hasEvidence(state: RunExport, key: string | undefined): boolean {
  if (!key) return false
  if (state.values[key] !== undefined && state.values[key] !== null) return true
  return state.tasks.some(task => task.result !== null && task.result[key] !== undefined && task.result[key] !== null)
}

function attemptFromMessage(message: string): number | null {
  const match = /\bAttempt (\d+)\b/.exec(message)
  return match ? Number(match[1]) : null
}

/** Normalizes internal `{sequence,time,node,status,message}` records into workflow-v1 events. */
export function normalizeEvents(runId: string, definition: WorkflowDefinition, raw: readonly RawEvent[]): WorkflowEvent[] {
  const attempts = new Map<string, number>()
  return raw.map(event => {
    const node_id = eventNode(definition, event.node)
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
export function projectSnapshot(scope: Scope, definition: WorkflowDefinition, state: RunExport, rawEvents: readonly RawEvent[], packets: readonly LoadedPacket[]): RunSnapshot {
  const lastEvent = new Map<string, RawEvent>()
  const eventAttempt = new Map<string, number>()
  for (const event of rawEvents) {
    const node = eventNode(definition, event.node)
    if (!node) continue
    lastEvent.set(node, event)
    const attempt = attemptFromMessage(event.message)
    if (attempt !== null) eventAttempt.set(node, Math.max(attempt, eventAttempt.get(node) ?? 0))
  }
  const latestPacket = (phase: 'worker' | 'candidate', worker: string) => packets
    .filter(packet => packet.phase === phase && packet.node_id === worker).sort((a, b) => b.attempt - a.attempt)[0]
  const workers = new Set(packets.map(packet => packet.node_id))
  const nodes = definition.nodes.map(node => {
    const task = state.tasks.find(candidate => candidate.node_id === node.node_id)
    const key = EVIDENCE_KEY[node.node_id]
    const worker = WORKER_OF[node.node_id]
    const workerPacket = worker ? latestPacket('worker', worker) : undefined
    let attempt = 0
    let session_id: string | null = null
    let result_uri: string | null = null
    if (worker) {
      if (workerPacket) {
        attempt = VERIFY_NODES.has(node.node_id) ? workerPacket.attempt : 1
        result_uri = resultRoute(scope, state.run_id, 'worker', worker, workerPacket.attempt)
        const session = workerPacket.ok ? workerPacket.result.session_id : null
        session_id = typeof session === 'string' && session.length > 0 ? session : null
      }
      if (!VERIFY_NODES.has(node.node_id)) {
        const receipt = state.values[worker]
        const session = receipt && typeof receipt === 'object' ? (receipt as Record<string, unknown>).session_id : null
        if (typeof session === 'string' && session.length > 0) session_id = session
      }
    }
    if (node.node_id === 'candidate') attempt = Math.max(0, ...packets.filter(packet => packet.phase === 'candidate').map(packet => packet.attempt))
    if (VERIFY_NODES.has(node.node_id)) attempt = Math.max(attempt, eventAttempt.get(node.node_id) ?? 0)
    let status: NodeStatus
    const event = lastEvent.get(node.node_id)
    const eventStatus = event ? EVENT_STATUS[event.status] ?? null : null
    if (task?.error) status = 'failed'
    else if (task && task.interrupts.length > 0) status = 'awaiting_approval'
    else if (hasEvidence(state, key)) {
      if (VERIFY_NODES.has(node.node_id)) status = workerPacket?.ok && workerPacket.gate.status === 'passed' ? 'succeeded' : 'paused'
      else if (node.node_id === 'candidate') {
        const latest = [...workers].map(candidate => latestPacket('candidate', candidate)).filter(packet => packet !== undefined)
        status = latest.length > 0 && latest.every(packet => packet.ok && packet.gate.status === 'passed') ? 'succeeded' : 'paused'
      } else status = 'succeeded'
    } else if (eventStatus === 'succeeded') status = key ? 'paused' : 'succeeded'
    else if (eventStatus) status = eventStatus
    else status = 'pending'
    if (status !== 'pending' && attempt === 0) attempt = 1
    if (status === 'pending') { attempt = 0; session_id = null; result_uri = null }
    return { node_id: node.node_id, kind: node.kind, depends_on: [...node.depends_on], status, attempt, session_id, result_uri }
  })
  const statuses = new Set(nodes.map(node => node.status))
  const integrated = hasEvidence(state, 'integrated_commit')
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
