/**
 * The run page's Steps model (docs/PRD_VIEWER_UX.md 4.2, 5.3): one row per step of the pinned definition, in definition
 * order, read from the triage timeline. A row says when the step first started, how long it took from there to its last
 * verdict (to now while it runs), its attempt, one mark per attempt in time order (✗ failed, ? ended without a record,
 * ✓ passed; the candidate's lanes share one) with ⚑ the controller's diagnosis and ⚒ an operator repair, its outcome and whether it waits on the operator. Also
 * the time axis of the Steps bars, which turns silences over 30 minutes into short breaks, and the step strip's labels.
 * Pure, so the Steps table, the step strip and the unit tests read the same rows.
 */
import type { RunDetail } from './api.ts'
import type { AttentionKind, Gap, Instant, NodeStatus, RunAttention, Span, SpanStatus, Text, Timeline } from '../../contracts/projects/triage.ts'

type DefinitionNode = RunDetail['definition']['nodes'][number]

export type StepRow = {
  node_id: string
  label: string
  kind: DefinitionNode['kind']
  /** The served status (`data-status`). */
  status: NodeStatus
  /** The status to show: a retry that runs while its node still reads failed is shown running. */
  shown: NodeStatus
  /** The latest attempt, 0 when the step never started. */
  attempt: number
  spans: Span[]
  /** The first attempt's start; null when nothing recorded one. */
  start: Instant | null
  /** The last verdict; null while the step runs or when none was recorded. */
  end: Instant | null
  /** From the start to the end (to now while the step runs); null when either is unknown. */
  ms: number | null
  live: boolean
  /** A start or an end was inferred rather than recorded: shown with `≈`, its source in the tooltip. */
  inferred: boolean
  /** The attempt marks in time order, empty for a single attempt with nothing to mark. */
  marks: string
  outcome: string
  attention: AttentionKind | null
}

/** A status as one glyph; colour never carries it alone (PRD_VIEWER_UX section 10). */
export const STATUS_GLYPH: Record<NodeStatus, string> = { pending: '○', running: '●', awaiting_approval: '?', paused: '‖', succeeded: '✓', failed: '✗', cancelled: '○' }
const SPAN_MARK: Record<SpanStatus, string> = { ...STATUS_GLYPH, no_record: '?' }
const MARKER_MARK = { diagnosis: '⚑', repair: '⚒' } as const

const ms = (instant: Instant) => Date.parse(instant.at)

/** Which lane's verdict an attempt shows when its lanes disagree: the one that needs a look first. */
const MARK_RANK: SpanStatus[] = ['failed', 'no_record', 'awaiting_approval', 'paused', 'cancelled', 'running', 'pending', 'succeeded']

/**
 * One mark per attempt. The candidate runs one span per lane in the same attempt; the attempt reads running while a lane
 * runs, else the worst lane verdict, so a two-lane attempt that passed on one lane and failed on the other is one ✗.
 */
function attemptMarks(spans: readonly Span[]): { at: string; mark: string }[] {
  const byAttempt = new Map<number, Span[]>()
  for (const span of spans) byAttempt.set(span.attempt, [...(byAttempt.get(span.attempt) ?? []), span])
  return [...byAttempt.values()].map(group => {
    const at = group.map(span => span.end?.at ?? span.start?.at ?? '').sort((a, b) => Date.parse(a) - Date.parse(b)).at(-1) ?? ''
    if (group.some(span => span.live)) return { at, mark: STATUS_GLYPH.running }
    const status = MARK_RANK.find(rank => group.some(span => span.status === rank)) ?? group[0].status
    return { at, mark: SPAN_MARK[status] }
  })
}

export function stepRows(detail: RunDetail, timeline: Timeline, { now, attention }: { now: number; attention?: RunAttention }): StepRow[] {
  const snapshot = new Map(detail.snapshot.nodes.map(node => [node.node_id, node]))
  return detail.definition.nodes.map(node => {
    const status = snapshot.get(node.node_id)?.status ?? 'pending'
    const spans = timeline.byNode.get(node.node_id) ?? []
    const last = spans.at(-1)
    const live = spans.some(span => span.live)
    const starts = spans.flatMap(span => span.start ? [span.start] : [])
    const ends = spans.flatMap(span => span.end ? [span.end] : [])
    const start = starts.reduce<Instant | null>((first, instant) => first === null || ms(instant) < ms(first) ? instant : first, null)
    const end = live ? null : ends.reduce<Instant | null>((latest, instant) => latest === null || ms(instant) >= ms(latest) ? instant : latest, null)
    const finish = end ? ms(end) : live ? now : null
    const markers = timeline.markers.filter(marker => (marker.kind === 'diagnosis' || marker.kind === 'repair') && marker.node_id === node.node_id)
    const attempts = attemptMarks(spans)
    const marks = attempts.length > 1 || markers.length > 0
      ? [
        ...attempts,
        ...markers.map(marker => ({ at: marker.at, mark: MARKER_MARK[marker.kind as keyof typeof MARKER_MARK] })),
      ].sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).map(item => item.mark).join('')
      : ''
    // The step's latest state: a status row that closed no attempt (a repair note, a resumed step) is newer than the last verdict.
    const settled = spans.reduce((latest, span) => Math.max(latest, Date.parse(span.end?.at ?? span.start?.at ?? '') || 0), 0)
    const update = timeline.activity.filter(row => row.node_id === node.node_id && row.kind === 'update' && row.status !== null && row.marker === null).at(-1)
    let outcome: string
    if (update && Date.parse(update.at) > settled) outcome = update.text
    else if (last?.outcome) outcome = node.node_id === 'candidate' && last.lane ? `${last.lane}: ${last.outcome}` : last.outcome
    else outcome = status === 'pending' ? 'not started' : `${status.replace('_', ' ')} · no event recorded`
    return {
      node_id: node.node_id, label: node.label, kind: node.kind, status, shown: live ? 'running' : status,
      attempt: status === 'pending' ? 0 : Math.max(snapshot.get(node.node_id)?.attempt ?? 0, last?.attempt ?? 0),
      spans, start, end, ms: start && finish !== null ? Math.max(0, finish - ms(start)) : null, live,
      inferred: spans.some(span => span.start?.source === 'inferred' || span.end?.source === 'inferred'),
      marks, outcome, attention: attention?.nodes.get(node.node_id)?.kind ?? null,
    }
  })
}

/**
 * The controller outages a worker's bar spans (5.2 rule 6): each `controller_down` gap clipped to the row's attempts, in
 * epoch milliseconds, drawn as hatched bands on the bar. Only worker rows: they keep running while the controller is down.
 */
export function outageBands(row: Pick<StepRow, 'kind' | 'spans'>, gaps: readonly Gap[], now: number): { start: number; end: number }[] {
  if (row.kind !== 'worker') return []
  const outages = gaps.filter(gap => gap.kind === 'controller_down').map(gap => ({ start: Date.parse(gap.from), end: Date.parse(gap.to) }))
  return row.spans.flatMap(span => {
    const start = span.start ?? span.end
    if (!start) return []
    const from = Date.parse(start.at)
    const to = span.end ? Date.parse(span.end.at) : span.live ? now : from
    return outages.flatMap(outage => {
      const band = { start: Math.max(from, outage.start), end: Math.min(to, outage.end) }
      return band.end > band.start ? [band] : []
    })
  })
}

/** A silence with no step working that lasts longer than this becomes a break on the time axis (5.2 rule 6). */
export const AXIS_BREAK_MS = 30 * 60_000
/** How much time a break keeps on the axis, so it stays visible without squashing the steps around it. */
const BREAK_SHOWN_MS = 2 * 60_000

export type TimeAxis = {
  from: number
  to: number
  /** Where an instant sits on the axis, from 0 (the run's start) to 1 (its end, or now); outside values are clamped. */
  position(at: number): number
  /** The silences shown as breaks: where each starts on the axis and how long it really was. */
  breaks: { at: number; ms: number }[]
}

/** The Steps bars' time axis from `from` to `to`; `busy` are the steps' working intervals (epoch milliseconds). */
export function timeAxis(from: number, to: number, busy: readonly { start: number; end: number }[]): TimeAxis {
  const clamp = (at: number) => Math.min(to, Math.max(from, at))
  const merged: { start: number; end: number }[] = []
  for (const interval of busy.map(item => ({ start: clamp(item.start), end: clamp(item.end) })).filter(item => item.end >= item.start).sort((a, b) => a.start - b.start)) {
    const previous = merged.at(-1)
    if (previous && interval.start <= previous.end) previous.end = Math.max(previous.end, interval.end)
    else merged.push({ ...interval })
  }
  const silences: { start: number; end: number }[] = []
  let cursor = from
  for (const interval of merged) {
    if (interval.start - cursor > AXIS_BREAK_MS) silences.push({ start: cursor, end: interval.start })
    cursor = Math.max(cursor, interval.end)
  }
  if (to - cursor > AXIS_BREAK_MS) silences.push({ start: cursor, end: to })
  // Axis time: real time minus what each break leaves out; inside a break, its shown length is spread evenly.
  const axisTime = (at: number) => {
    let value = at - from
    for (const silence of silences) {
      const length = silence.end - silence.start
      if (at >= silence.end) value -= length - BREAK_SHOWN_MS
      else if (at > silence.start) value -= (at - silence.start) * (1 - BREAK_SHOWN_MS / length)
    }
    return value
  }
  const total = Math.max(1, axisTime(to))
  const position = (at: number) => Math.min(1, Math.max(0, axisTime(clamp(at)) / total))
  return { from, to, position, breaks: silences.map(silence => ({ at: position(silence.start), ms: silence.end - silence.start })) }
}

const FIXED_LABELS: Record<string, string> = { handoff: 'Freeze', candidate: 'Candidate', review: 'Review', approval: 'Approval', integrate: 'Integrate', challenge: 'Challenge', sidecar: 'Sidecar', attack: 'Attack' }

/** The step strip's short name of a step: "Launch game", "Verify game", "Freeze", "Candidate", "Sidecar"; anything else keeps its label. */
export function shortStepLabel(node: { node_id: string; label: string }): string {
  if (node.node_id.startsWith('launch_')) return `Launch ${node.node_id.slice('launch_'.length)}`
  if (node.node_id.startsWith('verify_')) return `Verify ${node.node_id.slice('verify_'.length)}`
  return FIXED_LABELS[node.node_id] ?? node.label
}

/** A duration for the step strip: "46s", "28m", "1h05m". */
export function formatShortSpan(duration: number): string {
  const seconds = Math.max(0, Math.round(duration / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`
}

/** A Now headline without its leading status glyph, which the banner shows apart and hides from screen readers. */
export function withoutGlyph(text: Text, glyph: string): Text {
  const [first, ...rest] = text
  return typeof first === 'string' && first.startsWith(`${glyph} `) ? [first.slice(glyph.length + 1), ...rest] : text
}

// ---- Steps grouped by phase, with the fix loop's repairs and rounds (docs/PRD_VIEWER_REFINE 5.3) -----------------

/** The phases the Steps table groups its rows into, in order. */
export type StepPhase = 'challenge' | 'work' | 'verify' | 'candidate' | 'review' | 'integrate'
export const STEP_PHASE_LABEL: Record<StepPhase, string> = {
  challenge: 'Challenge', work: 'Work', verify: 'Verify', candidate: 'Candidate', review: 'Review', integrate: 'Integrate',
}
export const STEP_PHASE_ORDER: readonly StepPhase[] = ['challenge', 'work', 'verify', 'candidate', 'review', 'integrate']

/** The phase a pinned step belongs to; a `repair-<n>` takes the phase of the step it answers (resolved by the caller). */
export function stepPhase(node: { node_id: string; kind: DefinitionNode['kind'] }): StepPhase {
  if (node.node_id === 'challenge' && node.kind === 'review') return 'challenge'
  if (node.node_id === 'candidate') return 'candidate'
  switch (node.kind) {
    case 'worker': return 'work'
    case 'prepare': return 'verify'
    case 'verification': return 'verify'
    case 'review': return 'review'
    case 'integration': return 'integrate'
    default: return 'work'
  }
}

/** A session repair as the Steps and the node pages read it, by its `repair-<n>` node id. */
export type RepairMark = { n: number; round: number; rounds: number; trigger: 'verify' | 'candidate' | 'review'; blocked_step: string }

/** The repair marks of a run's fix loop, keyed by repair node id (`[]` for a run without one). */
export function repairMarks(detail: RunDetail): Map<string, RepairMark> {
  const repairs = detail.fixLoop && 'repairs' in detail.fixLoop ? detail.fixLoop.repairs : []
  return new Map(repairs.map(repair => [repair.node_id, { n: repair.n, round: repair.round, rounds: repair.rounds, trigger: repair.trigger, blocked_step: repair.blocked_step }]))
}

/** One Steps row with what it is: a pinned step, or a repair session beneath the step it answers (with its round). */
export type StepItem = { row: StepRow; phase: StepPhase; repair: RepairMark | null }

/**
 * The Steps rows tagged with their phase and, for a `repair-<n>` row, its repair mark; the phase of a repair is the phase
 * of the step it answers, so a repair sits in its parent's phase. Order is the row order (the server places each repair
 * right after the step it answers), so consecutive grouping keeps a repair under its step.
 */
export function stepItems(rows: readonly StepRow[], detail: RunDetail): StepItem[] {
  const marks = repairMarks(detail)
  const phaseOf = new Map(detail.definition.nodes.map(node => [node.node_id, stepPhase(node)]))
  return rows.map(row => {
    const repair = marks.get(row.node_id) ?? null
    const phase = repair ? phaseOf.get(repair.blocked_step) ?? 'work' : phaseOf.get(row.node_id) ?? 'work'
    return { row, phase, repair }
  })
}

export type StepPhaseGroup = { phase: StepPhase; label: string; items: StepItem[] }

/** The step items cut into consecutive phase groups, in phase order (challenge → integrate). */
export function stepGroups(items: readonly StepItem[]): StepPhaseGroup[] {
  const groups: StepPhaseGroup[] = []
  for (const item of items) {
    const last = groups.at(-1)
    if (!last || last.phase !== item.phase) groups.push({ phase: item.phase, label: STEP_PHASE_LABEL[item.phase], items: [item] })
    else last.items.push(item)
  }
  return groups
}

/** The pinned-step counts for the Steps header, never counting the projected repair rows (5.3). */
export function pinnedStepCounts(items: readonly StepItem[]): { done: number; total: number; failed: number } {
  const pinned = items.filter(item => item.repair === null)
  return {
    done: pinned.filter(item => item.row.shown === 'succeeded').length,
    failed: pinned.filter(item => item.row.shown === 'failed').length,
    total: pinned.length,
  }
}

/** How many repair rounds a run's fix loop recorded (the highest round of its session repairs); 0 without one. */
export function repairRoundCount(detail: RunDetail): number {
  const repairs = detail.fixLoop && 'repairs' in detail.fixLoop ? detail.fixLoop.repairs : []
  return repairs.reduce((max, repair) => Math.max(max, repair.round), 0)
}
