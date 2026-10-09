/**
 * The run stage's model (the Signal Box run page, 2026-10-09): one card per step of the pinned definition, repair nodes
 * included, carrying everything the stage, the live dock and the step sheet show. Every value comes from a served record
 * (the run detail, its events, the run inputs, the review result, the fix loop, the triage timeline); where the records
 * hold nothing the value is null and the UI says "not recorded". Pure, so the unit tests read the same cards.
 */
import type { Attention, AttentionKind, Instant, Now, RunAttention, Timeline } from '../../../contracts/projects/triage.ts'
import { humanizeEvent } from '../../../contracts/projects/triage.ts'
import type { ReviewFinding, ReviewResult, RunDetail, RunInputs, WorkflowEvent } from '../api.ts'
import type { RepairEntry } from '../../../contracts/projects/v1.ts'
import { isBlockingFinding } from '../api.ts'
import { isRepairNode } from '../dag.ts'
import { executorCategory, isAttackNode, isChallengeNode, isSidecarNode, KIND_LABEL, STATUS_LABEL, type Executor, type NodeKind, type RunStatus } from '../status.ts'
import type { StepRow } from '../steps.ts'
import { stateTone, TONE_LABEL, type Tone } from '../tone.ts'

export type StageEvent = { sequence: number; at: string; status: RunStatus | null; text: string }

export type StageReviewer = { id: string; verdict: 'approved' | 'blocked' | null; status: string; findings: number; blocking: number }

export type StageNode = {
  id: string
  label: string
  kind: NodeKind
  /** What the card calls the step: a repair, the sidecar, the attack pass and the challenge have their own words. */
  kindLabel: string
  exec: Executor
  dep: string[]
  status: RunStatus
  /** The status the card shows: a retry that runs while its step still reads failed shows running. */
  shown: RunStatus
  tone: Tone
  /** The status in words, with "needs you" when the step waits on the operator. Never carried by colour alone. */
  word: string
  attempt: number
  lane: string | null
  attention: Attention | null
  /** From the first start to the last verdict (to now while it runs); null when either end is unknown. */
  ms: number | null
  live: boolean
  start: Instant | null
  end: Instant | null
  models: string[]
  /** A repair node's fix-loop entry; null for every other step. */
  repair: RepairEntry | null
  /** The review node's round line (docs/PRD_VIEWER_REFINE 5.2), null for the others. */
  round: string | null
  /** The step a repair re-enters, for the return mark; null for every other step. */
  returnTo: string | null
  /** One sentence of what the step did, from its records; null when they say nothing yet. */
  did: string | null
  /** The step's events, oldest first, humanized. */
  events: StageEvent[]
  /** The review node's reviewers and findings; null elsewhere. */
  reviewers: StageReviewer[] | null
  findings: ReviewFinding[] | null
  /** A worker's questions to the operator, oldest first; null for a step that asks none. */
  questions: RunInputs['workers'][number]['questions'] | null
  /** The 2 or 3 facts the far view keeps on the card. */
  facts: string
}

export type StageModelInput = {
  detail: RunDetail
  rows: readonly StepRow[]
  timeline: Timeline | null
  events: readonly WorkflowEvent[]
  inputs: RunInputs | null
  review: ReviewResult | null
  attention: RunAttention | null
  /** The review node's label line, as the run view derives it from the fix loop; null when there is none. */
  reviewRound: string | null
}

const shortSha = (value: string) => value.slice(0, 7)
const clock = (iso: string) => iso.slice(11, 16)

/** The lane a step belongs to, from its id (`launch_<lane>`, `verify_<lane>`) or its repair entry. */
export function laneOf(id: string, repair: RepairEntry | null): string | null {
  if (repair) return repair.lane
  const match = /^(?:launch|verify)_([a-z][a-z0-9-]*)$/.exec(id)
  return match ? match[1] : null
}

function kindLabelOf(node: { node_id: string; kind: NodeKind }, repair: RepairEntry | null): string {
  if (repair) return 'repair'
  if (isChallengeNode(node)) return 'design challenge'
  if (isSidecarNode(node)) return 'sidecar'
  if (isAttackNode(node)) return 'attack pass'
  return KIND_LABEL[node.kind].toLowerCase()
}

/** The status word of a step: lower case, "needs you" appended while it waits on the operator; an applied repair says so. */
export function wordOf(status: RunStatus, attention: AttentionKind | null, repair: RepairEntry | null): string {
  let word = STATUS_LABEL[status].toLowerCase()
  if (repair?.status === 'applied') word = 'applied'
  else if (repair?.status === 'blocked') word = 'blocked'
  return attention ? `${word} · ${TONE_LABEL.warn.toLowerCase()}` : word
}

/** What a step did, in one sentence from its records; the step's outcome line when nothing richer is recorded. */
function didOf(node: { node_id: string; kind: NodeKind }, row: StepRow | undefined, repair: RepairEntry | null, inputs: RunInputs | null, review: ReviewResult | null, reviewRound: string | null): string | null {
  if (repair) {
    const trigger = repair.trigger === 'verify' ? `the ${repair.lane} verification` : repair.trigger === 'candidate' ? 'the candidate' : `review round ${repair.review_round ?? '?'}`
    const outcome = repair.status === 'applied' && repair.applied_at ? `Applied at ${clock(repair.applied_at)} UTC; ${repair.blocked_step} re-entered.`
      : repair.status === 'blocked' ? `Blocked${repair.reason ? `: ${repair.reason}` : ''}.`
        : `${STATUS_LABEL[row?.shown ?? 'running']}.`
    return `Repair session ${repair.round} of ${repair.rounds} for lane ${repair.lane}, triggered by ${trigger}. ${outcome}`
  }
  if (node.kind === 'worker') {
    const worker = inputs?.workers.find(entry => entry.launch_node_id === node.node_id)
    if (worker?.completion) return `${worker.completion.status === 'question' ? 'Asked a question' : worker.completion.status === 'blocked' ? 'Blocked' : 'Completed'}: ${worker.completion.summary}`
    if (worker?.handoff) return `Handed off: ${worker.handoff.summary}`
  }
  if (node.node_id === 'review' && node.kind === 'review' && review) {
    const blocking = review.findings.filter(isBlockingFinding).length
    const who = review.reviewers.map(entry => `${entry.reviewer_id} ${entry.verdict ?? entry.status}`).join(', ')
    return `Review ${review.verdict}${reviewRound ? ` (${reviewRound})` : ''} by ${who}; ${review.findings.length} finding${review.findings.length === 1 ? '' : 's'}, ${blocking} blocking.`
  }
  if (isChallengeNode(node) && inputs?.challenge) {
    const challenge = inputs.challenge
    if (challenge.status === 'disabled') return 'The design challenge was disabled for this run.'
    const blocking = challenge.concerns.filter(concern => concern.severity !== 'P2').length
    return `Design challenge ${challenge.status} at attempt ${challenge.attempt} of ${challenge.attempts}, ${challenge.concerns.length} concern${challenge.concerns.length === 1 ? '' : 's'}, ${blocking} P0/P1${challenge.accepted_reason ? `; accepted: ${challenge.accepted_reason}` : ''}.`
  }
  if (!row) return null
  if (row.status === 'pending' && row.spans.length === 0) return null
  return row.outcome
}

/** A role's pin as the sheet shows it: the model, then its effort when one was pinned; null without a model. */
function pinText(pin: { model: string | null; effort: string | null } | null | undefined): string | null {
  if (!pin?.model) return null
  return pin.effort ? `${pin.model} · ${pin.effort}` : pin.model
}

/** The models a step ran on, from the run inputs' pins (model and effort); empty when none is recorded. */
function modelsOf(node: { node_id: string; kind: NodeKind }, repair: RepairEntry | null, inputs: RunInputs | null): string[] {
  let pin: string | null = null
  if (repair) pin = pinText(repair.requested)
  else if (node.kind === 'worker') {
    const worker = inputs?.workers.find(entry => entry.launch_node_id === node.node_id)
    pin = pinText(worker?.roles) ?? pinText(inputs?.roles?.worker)
  } else if (node.kind === 'review') pin = pinText(inputs?.roles?.judges)
  return pin ? [pin] : []
}

/** The far view's facts: what waits, else how the step ended, else its lane, attempt and duration. */
export function factsOf(node: Pick<StageNode, 'tone' | 'word' | 'attention' | 'attempt' | 'lane' | 'ms'>, span: (ms: number) => string): string {
  if (node.attention) return node.attention.kind === 'question' ? 'question waiting' : node.word
  if (node.tone === 'fail' || node.tone === 'pause') return node.word + (node.attempt > 1 ? ` · #${node.attempt}` : '')
  const bits: string[] = []
  if (node.lane) bits.push(node.lane)
  if (node.attempt > 1) bits.push(`#${node.attempt}`)
  if (node.ms !== null) bits.push(span(node.ms))
  if (bits.length === 0) bits.push(node.word)
  return bits.slice(0, 3).join(' · ')
}

export function stageNodes(input: StageModelInput, span: (ms: number) => string): StageNode[] {
  const { detail, rows, events, inputs, review, attention, reviewRound } = input
  const snapshot = new Map(detail.snapshot.nodes.map(node => [node.node_id, node]))
  const rowOf = new Map(rows.map(row => [row.node_id, row]))
  const repairs = detail.fixLoop && 'repairs' in detail.fixLoop ? detail.fixLoop.repairs : []
  const sorted = [...events].sort((a, b) => a.sequence - b.sequence)
  return detail.definition.nodes.map(node => {
    const state = snapshot.get(node.node_id)
    const row = rowOf.get(node.node_id)
    const repair = isRepairNode(node.node_id) ? repairs.find(entry => entry.node_id === node.node_id) ?? null : null
    const status = state?.status ?? 'pending'
    // The served status is the card's word; only a retry that runs while its step still reads failed shows running (the
    // timeline also counts a wait for approval as live, which keeps the duration ticking but never rewrites the status).
    const shown: RunStatus = status === 'failed' && row?.live ? 'running' : status
    const waits = attention?.nodes.get(node.node_id) ?? null
    const tone = stateTone({ status: shown, attention: waits?.kind ?? null })
    const word = wordOf(shown, waits?.kind ?? null, repair)
    const lane = laneOf(node.node_id, repair)
    const attempt = Math.max(state?.attempt ?? 0, row?.attempt ?? 0)
    const isReview = node.node_id === 'review' && node.kind === 'review'
    const worker = node.kind === 'worker' && !repair ? inputs?.workers.find(entry => entry.launch_node_id === node.node_id) ?? null : null
    const card: Omit<StageNode, 'facts'> = {
      id: node.node_id,
      label: node.label,
      kind: node.kind,
      kindLabel: kindLabelOf(node, repair),
      exec: executorCategory(node.kind),
      dep: node.depends_on,
      status,
      shown,
      tone,
      word,
      attempt,
      lane,
      attention: waits,
      ms: row?.ms ?? null,
      live: row?.live ?? false,
      start: row?.start ?? null,
      end: row?.end ?? null,
      models: modelsOf(node, repair, inputs),
      repair,
      round: isReview ? reviewRound : repair ? `round ${repair.round} of ${repair.rounds} · ${repair.trigger}` : null,
      returnTo: repair?.blocked_step ?? null,
      did: didOf(node, row, repair, inputs, review, reviewRound),
      events: sorted.filter(event => event.node_id === node.node_id).map(event => ({ sequence: event.sequence, at: event.occurred_at, status: event.status, text: humanizeEvent(event) })),
      reviewers: isReview && review ? review.reviewers.map(entry => ({ id: entry.reviewer_id, verdict: entry.verdict, status: entry.status, findings: entry.findings.length, blocking: entry.findings.filter(isBlockingFinding).length })) : null,
      findings: isReview && review ? review.findings : null,
      questions: worker && worker.questions.length > 0 ? worker.questions : null,
    }
    return { ...card, facts: factsOf(card, span) }
  })
}

export type LatestEvent = { key: string; at: string; nodeId: string | null; label: string; status: RunStatus | null; text: string }

/** The run's latest moments, newest first: every timeline row that is not a PID checkpoint, named by its step. */
export function latestEvents(timeline: Timeline | null, labels: ReadonlyMap<string, string>, limit = 5): LatestEvent[] {
  if (timeline === null) return []
  return timeline.activity
    .filter(row => !row.controller_log && row.kind !== 'gap')
    .slice(-limit)
    .reverse()
    .map((row, index) => ({
      key: `${row.sequence ?? 'r'}-${row.at}-${index}`,
      at: row.at,
      nodeId: row.node_id,
      label: row.node_id === null ? 'Controller' : labels.get(row.node_id) ?? row.node_id,
      status: row.status === 'no_record' ? null : row.status,
      text: row.text,
    }))
}

/** The step the live dock calls "now": the Now's focus when it names a step of the run, else the first step that waits, else null. */
export function nowNodeId(now: Now | null, attention: RunAttention | null, nodes: readonly StageNode[]): string | null {
  const focus = now?.focus?.node_id ?? attention?.top?.node_id ?? null
  if (focus !== null && nodes.some(node => node.id === focus)) return focus
  return nodes.find(node => node.attention !== null)?.id ?? null
}

/** The commit a repair worked in, short, for the sheet. */
export const repairCommit = (repair: RepairEntry) => shortSha(repair.workspace_commit)
