/**
 * The node view's header model (docs/PRD_VIEWER_UX.md 4.4, 5.3, 7): the attempt word, the timing line with its source, the
 * attempt strip with the controller's diagnosis and the operator's repairs, and which of two nodes that share one result
 * shows its facts and which its worker narrative. Pure, so the header and the unit tests read the same values.
 */
import { attemptResultUris, humanizeEvent, type Instant, type Span, type SpanStatus, type Timeline } from '../../../contracts/projects/triage.ts'
import type { RunDetail, WorkerResult, WorkflowEvent } from '../api.ts'

/** `reason`: a failed attempt's reasons in a few words ("unit, integration"), "same" when they repeat the attempt before; empty otherwise. */
export type AttemptChip = { attempt: number; status: SpanStatus; start: Instant | null; ms: number | null; outcome: string; reason: string; uris: string[] }
export type StripItem =
  | { kind: 'attempt'; at: string; chip: AttemptChip }
  | { kind: 'diagnosis' | 'repair'; at: string; label: string; message: string }

export type Timing = {
  attempt: number
  start: Instant | null
  end: Instant | null
  ms: number | null
  live: boolean
  setupMs: number | null
  checksMs: number | null
  /** Where the times come from when that is not an event, e.g. "from the launch and stop receipts"; null for events. */
  source: string | null
  inferred: boolean
}

export type ResultRole = { facts: boolean; narrative: boolean; partner: string | null }

/** A node's attempt as the header says it: "not started" for a step that never ran, never "attempt 0" (5.3). */
export function attemptWord(attempt: number): string {
  return attempt === 0 ? 'not started' : String(attempt)
}

const ms = (instant: Instant) => Date.parse(instant.at)
const earliest = (instants: (Instant | null)[]) => instants.reduce<Instant | null>((first, instant) => instant && (first === null || ms(instant) < ms(first)) ? instant : first, null)
const latest = (instants: (Instant | null)[]) => instants.reduce<Instant | null>((last, instant) => instant && (last === null || ms(instant) >= ms(last)) ? instant : last, null)

/** The spans of one node grouped by attempt, oldest first; the candidate runs one span per lane in the same attempt. */
function attemptsOf(timeline: Timeline, nodeId: string): Map<number, Span[]> {
  const groups = new Map<number, Span[]>()
  for (const span of timeline.byNode.get(nodeId) ?? []) groups.set(span.attempt, [...(groups.get(span.attempt) ?? []), span])
  return new Map([...groups.entries()].sort(([a], [b]) => a - b))
}

/** Which lane's verdict an attempt shows when its lanes disagree: the one that needs a look first (as the Steps marks). */
const RANK: SpanStatus[] = ['failed', 'no_record', 'awaiting_approval', 'paused', 'cancelled', 'running', 'pending', 'succeeded']

function attemptStatus(spans: Span[]): SpanStatus {
  if (spans.some(span => span.live)) return 'running'
  return RANK.find(rank => spans.some(span => span.status === rank)) ?? spans[0].status
}

/** Where a time comes from, said in the timing line: the receipts, check times and the review as nouns, inferences as their note. */
function sourceText(instants: (Instant | null)[]): string | null {
  const nouns: string[] = []
  const notes: string[] = []
  for (const instant of instants) {
    if (!instant || instant.source === 'event') continue
    if (instant.source === 'inferred') notes.push(instant.note ?? 'inferred')
    else nouns.push(`the ${instant.note ?? (instant.source === 'check' ? 'check times' : instant.source)}`)
  }
  const unique = [...new Set(nouns)]
  const parts = [...(unique.length ? [`from ${unique.join(' and ')}`] : []), ...new Set(notes)]
  return parts.length ? parts.join('; ') : null
}

/**
 * The timing line of one attempt (the latest when `attempt` is null): its start and end, how long it took, and, once its
 * result is read, the setup before the first check and the checks themselves (5.2 rule 8). Null when nothing recorded it.
 */
export function nodeTiming(timeline: Timeline, nodeId: string, attempt: number | null, result?: WorkerResult | null): Timing | null {
  const groups = attemptsOf(timeline, nodeId)
  const shown = attempt ?? Math.max(0, ...groups.keys())
  const spans = groups.get(shown)
  if (!spans?.length) return null
  const live = spans.some(span => span.live)
  const start = earliest(spans.map(span => span.start))
  const end = live || spans.some(span => span.end === null) ? null : latest(spans.map(span => span.end))
  const checks = result?.checks ?? []
  let setupMs: number | null = null
  let checksMs: number | null = null
  if (checks.length > 0 && start) {
    const first = Math.min(...checks.map(check => Date.parse(check.started_at)))
    const last = Math.max(...checks.map(check => Date.parse(check.finished_at)))
    // Only when the checks ran inside the attempt: a span recorded by its verdict alone has no start to measure from.
    if (first >= ms(start) && (end === null || last <= ms(end) + 1000)) {
      setupMs = first - ms(start)
      checksMs = Math.max(0, last - first)
    }
  }
  return {
    attempt: shown, start, end, ms: start && end ? Math.max(0, ms(end) - ms(start)) : null, live, setupMs, checksMs,
    source: sourceText([start, end]),
    inferred: start?.source === 'inferred' || end?.source === 'inferred',
  }
}

/**
 * The attempt strip (4.4): one chip per attempt, in time order, with the controller's diagnosis (⚑) and the operator's
 * repairs (⚒) where they happened. Each chip carries the result URIs of its attempt (per lane for the candidate), so the
 * header links it only once one of them loads. Empty for a step with one attempt or none.
 */
export function attemptStrip(detail: RunDetail, timeline: Timeline, nodeId: string): StripItem[] {
  const groups = attemptsOf(timeline, nodeId)
  if (groups.size < 2) return []
  const uris = attemptResultUris(detail, nodeId)
  const items: StripItem[] = [...groups.entries()].map(([attempt, spans]) => {
    const start = earliest(spans.map(span => span.start))
    const live = spans.some(span => span.live)
    const end = live ? null : latest(spans.map(span => span.end))
    const chip: AttemptChip = {
      attempt, status: attemptStatus(spans), start, ms: start && end ? Math.max(0, ms(end) - ms(start)) : null,
      outcome: spans.map(span => span.outcome).filter(Boolean).join('; '),
      reason: '',
      uris: uris.filter(item => item.attempt === attempt).map(item => item.uri),
    }
    return { kind: 'attempt', at: (start ?? end)?.at ?? '', chip }
  })
  let previous: AttemptChip | null = null
  for (const item of items) {
    if (item.kind !== 'attempt') continue
    const { chip } = item
    if (chip.status === 'failed' && chip.outcome) {
      chip.reason = previous?.status === 'failed' && previous.outcome === chip.outcome ? 'same' : reasonWords(chip.outcome)
    }
    previous = chip
  }
  for (const marker of timeline.markers) {
    if (marker.node_id !== nodeId || (marker.kind !== 'diagnosis' && marker.kind !== 'repair')) continue
    items.push({ kind: marker.kind, at: marker.at, label: marker.kind === 'repair' ? `repair ${marker.repair?.n ?? ''}`.trim() : 'diagnosis', message: marker.message })
  }
  return items.sort((a, b) => (Date.parse(a.at) || 0) - (Date.parse(b.at) || 0))
}

/**
 * The cause a header names after its status (8): a failure's own error first; on an earlier attempt's page, that attempt's
 * outcome as the timeline re-read it (served events may all carry one attempt number, 5.2 rule 1); otherwise the latest
 * status message of the attempt, humanized. Null when nothing recorded one.
 */
export function causeOf({ timeline, nodeId, attempt, events, latest, error }: {
  timeline: Timeline | null
  nodeId: string
  /** The viewed earlier attempt; null for the latest. */
  attempt: number | null
  /** The node's events; the latest attempt's are those of `latest`. */
  events: WorkflowEvent[]
  latest: number
  error: string | null
}): string | null {
  if (error) return error
  if (attempt !== null && timeline !== null) {
    const outcome = (attemptsOf(timeline, nodeId).get(attempt) ?? []).map(span => span.outcome).filter(Boolean).join('; ')
    if (outcome) return outcome
  }
  const shown = attempt ?? latest
  const own = events.filter(event => event.status !== null && (event.attempt === shown || shown === 0))
  // Only the latest attempt falls back to the node's last status message; an earlier one never quotes a later attempt.
  const last = own.at(-1) ?? (attempt === null ? events.findLast(event => event.status !== null) : undefined)
  return last ? humanizeEvent(last) : null
}

/** A failure's reasons in a few words: the checks its keyed gate reasons name ("unit, integration"), else the outcome itself. */
function reasonWords(outcome: string): string {
  const segments = outcome.split(';').map(segment => segment.trim()).filter(Boolean)
  const keys = segments.map(segment => /^([\w.-]+):\s/.exec(segment)?.[1] ?? null)
  return keys.length > 0 && keys.every(key => key !== null) ? [...new Set(keys)].join(', ') : outcome
}

/**
 * Which attempt of a verification this is on its revision (5.3): counted from the operator's latest repair before it, since
 * a repair restarts the attempt cap. Without a repair it is the attempt itself.
 */
export function revisionAttempt(timeline: Timeline, nodeId: string, attempt: number): number {
  const groups = attemptsOf(timeline, nodeId)
  const at = (value: number) => {
    const spans = groups.get(value) ?? []
    const instant = earliest(spans.map(span => span.start)) ?? earliest(spans.map(span => span.end))
    return instant ? ms(instant) : null
  }
  const shown = at(attempt)
  if (shown === null) return attempt
  const repaired = timeline.markers
    .filter(marker => marker.kind === 'repair' && marker.node_id === nodeId && Date.parse(marker.at) <= shown)
    .reduce((last, marker) => Math.max(last, Date.parse(marker.at)), -Infinity)
  if (repaired === -Infinity) return attempt
  return [...groups.keys()].filter(value => value <= attempt && (at(value) ?? shown) >= repaired).length
}

/**
 * Dedup by `result_uri` (7): when a launch node and a verify node link the same result, the verify node shows its facts
 * (status, session, commits, the gate's error) and the launch node the worker's narrative (summary, assumptions). A result
 * no other node links keeps both.
 */
export function resultRole(detail: RunDetail, nodeId: string): ResultRole {
  const nodes = detail.snapshot.nodes
  const node = nodes.find(candidate => candidate.node_id === nodeId)
  const uri = node?.result_uri ?? null
  const kind = detail.definition.nodes.find(candidate => candidate.node_id === nodeId)?.kind
  if (uri === null || (kind !== 'worker' && kind !== 'verification')) return { facts: true, narrative: true, partner: null }
  const partnerKind = kind === 'worker' ? 'verification' : 'worker'
  const partner = nodes.find(candidate => candidate.node_id !== nodeId && candidate.result_uri === uri && candidate.kind === partnerKind)?.node_id ?? null
  if (partner === null) return { facts: true, narrative: true, partner: null }
  return kind === 'worker' ? { facts: false, narrative: true, partner } : { facts: true, narrative: false, partner }
}

// ---- The section index (4.4, 7) ----------------------------------------------------------------------------------

/** One section of a node page: its anchor key, its name in the index and, when it lists items, how many. */
export type SectionEntry = { key: string; label: string; count?: number }

export const sectionId = (key: string) => `node-section-${key}`

/** What one verified result holds, sorted the way its sections show it. */
export function evidenceOf(result: WorkerResult) {
  const artifactsById = new Map(result.artifacts.map(artifact => [artifact.artifact_id, artifact]))
  const checkLogs = new Set(result.checks.map(check => check.log_artifact_id))
  const screenshots = result.artifacts.filter(artifact => artifact.kind === 'screenshot')
  // Check logs are shown with their check and captured files on the launch node; everything else that is not a screenshot is listed here.
  const others = result.artifacts.filter(artifact => artifact.kind !== 'screenshot' && artifact.kind !== 'file' && !checkLogs.has(artifact.artifact_id))
  // Checks the gate recorded on this isolated snapshot but gates only at the combined candidate (build, browser).
  const deferred = new Map((result.deferred_checks ?? []).map(entry => [entry.check_index, entry.id]))
  const passed = result.status === 'succeeded' && result.error === null
  return { artifactsById, screenshots, others, deferred, passed }
}

/**
 * The index entries of a verified result's sections: only those with something in them. A verify node whose lane the run's
 * inputs name lists its Requirements before the Result.
 */
export function verifiedSections(result: WorkerResult, options: { requirements?: boolean } = {}): SectionEntry[] {
  const { screenshots, others, deferred } = evidenceOf(result)
  return [
    { key: 'gate', label: 'Gate' },
    ...(result.checks.length > 0 ? [{ key: 'checks', label: 'Checks', count: result.checks.length }] : []),
    ...(screenshots.length > 0 || deferred.size > 0 ? [{ key: 'screenshots', label: 'Screenshots', count: screenshots.length }] : []),
    ...(others.length > 0 ? [{ key: 'artifacts', label: 'Artifacts', count: others.length }] : []),
    ...(options.requirements ? [{ key: 'requirements', label: 'Requirements' }] : []),
    { key: 'result', label: 'Result' },
  ]
}

// ---- Activity by phase (docs/PRD_VIEWER_REVAMP.md 5.3) -----------------------------------------------------------

/** The stretches of a run Activity groups its rows into; `run` holds a run's rows when no step recorded any. */
export type ActivityPhase = 'challenge' | 'workers' | 'verification' | 'review' | 'run'
export const ACTIVITY_PHASE_LABEL: Record<ActivityPhase, string> = {
  challenge: 'Challenge',
  workers: 'Workers',
  verification: 'Freeze and verification',
  review: 'Review and integration',
  run: 'Run',
}

/**
 * The phase a step belongs to: the design challenge; the workers' launches; the freeze, the verifications and the combined
 * candidate; the review, the approval and the integration. The review sidecar and the attack pass run beside the others and
 * have none of their own, so their rows, like the controller's, join the phase they occur in.
 */
export function nodePhase(node: { node_id: string; kind: RunDetail['definition']['nodes'][number]['kind'] }): ActivityPhase | null {
  if (node.node_id === 'sidecar' && node.kind === 'review') return null
  if (node.node_id === 'attack' && node.kind === 'review') return null
  if (node.node_id === 'challenge' && node.kind === 'review') return 'challenge'
  switch (node.kind) {
    case 'worker': return 'workers'
    case 'prepare': return 'verification'
    case 'verification': return 'verification'
    case 'review': return 'review'
    case 'integration': return 'review'
    default: return null
  }
}

/**
 * One stretch of Activity: consecutive rows of one phase. `key` names it by its phase and the row that opened it, so it stays
 * the same in either order, when the controller log is shown or hidden, and when a poll adds rows before, inside or after it.
 */
export type ActivityGroup<T> = { key: string; phase: ActivityPhase; label: string; rows: T[] }

/** What names a row for a group key: its event number, else its time, step and kind (a receipt or an inferred instant). */
type KeyedRow = { node_id: string | null; sequence?: number | null; at?: string; kind?: string }
const rowKey = (row: KeyedRow, index: number) => row.sequence != null ? `#${row.sequence}`
  : row.at !== undefined ? `${row.at}/${row.node_id ?? ''}/${row.kind ?? ''}` : `@${index}`

/**
 * Activity's rows (oldest first) cut into consecutive stretches of one phase, keeping every row once and in order. A row
 * without a step of a phase (the controller's, the diagnosis, a repair, a silence, the sidecar's) joins the stretch it
 * occurs in, or, before any step, the first phase that follows; a run whose rows name no step is one `run` stretch.
 * A stretch is keyed by its phase and its first row of that phase (never a node-less row, which the controller log toggle
 * hides), not by its position, so a stretch the reader closed stays closed when rows come or go elsewhere.
 */
export function groupActivity<T extends KeyedRow>(rows: readonly T[], phaseOf: (nodeId: string) => ActivityPhase | null): ActivityGroup<T>[] {
  const phases = rows.map(row => (row.node_id === null ? null : phaseOf(row.node_id)))
  const first = phases.find(phase => phase !== null) ?? 'run'
  const groups: (ActivityGroup<T> & { opener: string | null })[] = []
  let current: ActivityPhase = first
  rows.forEach((row, index) => {
    current = phases[index] ?? current
    let last = groups.at(-1)
    if (!last || last.phase !== current) {
      last = { key: '', opener: null, phase: current, label: ACTIVITY_PHASE_LABEL[current], rows: [] }
      groups.push(last)
    }
    last.rows.push(row)
    if (last.opener === null && phases[index] !== null) last.opener = rowKey(row, index)
  })
  return groups.map(({ opener, ...group }) => ({ ...group, key: `${group.phase}-${opener ?? 'start'}` }))
}

/** The groups as shown: oldest first as built, or newest first with the groups and the rows inside them reversed. */
export function orderActivityGroups<T>(groups: readonly ActivityGroup<T>[], newestFirst: boolean): ActivityGroup<T>[] {
  return newestFirst ? [...groups].reverse().map(group => ({ ...group, rows: [...group.rows].reverse() })) : [...groups]
}

/** A tone as `tone.ts` names it; the mapping is passed in (`statusTone`), so this module stays free of it. */
type PhaseTone = 'ok' | 'run' | 'warn' | 'fail' | 'pause' | 'idle'
const PHASE_TONE_RANK: readonly PhaseTone[] = ['fail', 'warn', 'pause', 'run', 'ok', 'idle']

/**
 * Where a phase stands, from each step's latest status in it (a step that failed and then passed counts as passed), through
 * `toneOf` (the page's `stateTone`, so a step that waits on the operator is warn whatever its status): its tone
 * (failed first, then waiting on the operator, paused, running; ok once every step passed) and the same in words for the
 * group's summary, so a closed group never says it by colour alone. Empty words when no step in it recorded a status.
 */
export function phaseState<T extends PhaseTone>(rows: readonly { at: string; sequence: number | null; node_id: string | null; lane: string | null; kind: string; status: string | null }[], toneOf: (status: string, nodeId: string) => T): { tone: PhaseTone; words: string } {
  // The latest by time, then event number, so the rows may come in either order (Activity's newest first reverses them).
  const later = (a: { at: string; sequence: number | null }, b: { at: string; sequence: number | null }) => {
    const difference = Date.parse(a.at) - Date.parse(b.at)
    return difference !== 0 ? difference > 0 : (a.sequence ?? -1) >= (b.sequence ?? -1)
  }
  const latest = new Map<string, (typeof rows)[number]>()
  for (const row of rows) {
    if (row.node_id === null || row.status === null || row.kind === 'gap') continue
    const key = `${row.node_id}/${row.lane ?? ''}`
    const known = latest.get(key)
    if (known === undefined || later(row, known)) latest.set(key, row)
  }
  const tones: PhaseTone[] = [...latest.values()].map(row => toneOf(row.status!, row.node_id!))
  if (tones.length === 0) return { tone: 'idle', words: '' }
  const found = PHASE_TONE_RANK.find(rank => tones.includes(rank)) ?? 'idle'
  // Green only once every step in it passed: a phase with a step not started or ended without a record is idle.
  const tone = found === 'ok' && !tones.every(item => item === 'ok') ? 'idle' : found
  const count = tones.filter(item => item === tone).length
  const words = tone === 'fail' ? `${count} failed`
    : tone === 'warn' ? 'waiting on you'
      : tone === 'pause' ? 'paused'
        : tone === 'run' ? 'running'
          : tone === 'ok' ? 'all passed' : ''
  return { tone, words }
}
