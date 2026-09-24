/**
 * The node view's header model (docs/PRD_VIEWER_UX.md 4.4, 5.3, 7): the attempt word, the timing line with its source, the
 * attempt strip with the controller's diagnosis and the operator's repairs, and which of two nodes that share one result
 * shows its facts and which its worker narrative. Pure, so the header and the unit tests read the same values.
 */
import { attemptResultUris, type Instant, type Span, type SpanStatus, type Timeline } from '../../../contracts/projects/triage.ts'
import type { RunDetail, RunInputWorker, WorkerResult } from '../api.ts'

export type AttemptChip = { attempt: number; status: SpanStatus; start: Instant | null; ms: number | null; outcome: string; uris: string[] }
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
      uris: uris.filter(item => item.attempt === attempt).map(item => item.uri),
    }
    return { kind: 'attempt', at: (start ?? end)?.at ?? '', chip }
  })
  for (const marker of timeline.markers) {
    if (marker.node_id !== nodeId || (marker.kind !== 'diagnosis' && marker.kind !== 'repair')) continue
    items.push({ kind: marker.kind, at: marker.at, label: marker.kind === 'repair' ? `repair ${marker.repair?.n ?? ''}`.trim() : 'diagnosis', message: marker.message })
  }
  return items.sort((a, b) => (Date.parse(a.at) || 0) - (Date.parse(b.at) || 0))
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

/** The index entries of a verified result's sections: only those with something in them. */
export function verifiedSections(result: WorkerResult): SectionEntry[] {
  const { screenshots, others, deferred } = evidenceOf(result)
  return [
    { key: 'gate', label: 'Gate' },
    ...(result.checks.length > 0 ? [{ key: 'checks', label: 'Checks', count: result.checks.length }] : []),
    ...(screenshots.length > 0 || deferred.size > 0 ? [{ key: 'screenshots', label: 'Screenshots', count: screenshots.length }] : []),
    ...(others.length > 0 ? [{ key: 'artifacts', label: 'Artifacts', count: others.length }] : []),
    { key: 'result', label: 'Result' },
  ]
}

/** How many rows "Files created or changed" lists: every changed file, then any captured or listed path they do not name. */
export function filesCount(result: WorkerResult): number {
  // As `capturedFiles` and `notCapturedFiles` (files.ts) read them; that module holds a hook, which this pure one avoids.
  const captured = result.artifacts.flatMap(artifact => (artifact.kind === 'file' && typeof artifact.path === 'string' ? [artifact.path] : []))
  return new Set([...result.changed_files, ...captured, ...(result.files_not_captured ?? []).map(entry => entry.path)]).size
}

/** The index entries of a launch node's sections, in page order; empty ones are absent. */
export function workerSectionEntries(worker: RunInputWorker | null, result: WorkerResult | null): SectionEntry[] {
  const files = result === null ? 0 : filesCount(result)
  return [
    ...(worker !== null && worker.questions.length > 0 ? [{ key: 'questions', label: 'Questions', count: worker.questions.length }] : []),
    ...(result !== null ? [{ key: 'result', label: 'Result' }] : []),
    ...(files > 0 ? [{ key: 'files', label: 'Files', count: files }] : []),
    ...(worker !== null ? [{ key: 'report', label: 'Report' }, { key: 'session', label: 'Session' }, { key: 'task', label: 'Task' }] : []),
  ]
}
