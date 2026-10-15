/**
 * The run stage's model (the Signal Box run page, 2026-10-09): one card per step of the pinned definition, repair nodes
 * included, carrying everything the stage, the live dock and the step sheet show. Every value comes from a served record
 * (the run detail, its events, the run inputs, the review result, the fix loop, the triage timeline); where the records
 * hold nothing the value is null and the UI says "not recorded". Pure, so the unit tests read the same cards.
 */
import type { Attention, AttentionKind, Instant, Now, RunAttention, Timeline } from '../../../contracts/projects/triage.ts'
import { humanizeEvent } from '../../../contracts/projects/triage.ts'
import type { PanelResults, ReviewFinding, ReviewResult, RunDetail, RunInputs, Sessions, WorkflowEvent } from '../api.ts'
import { isProjectedSessionNode, reviewerRowOf, stageCardOf, type StageCard } from '../sessions/model.ts'
import type { RepairEntry } from '../../../contracts/projects/v1.ts'
import { isBlockingFinding } from '../api.ts'
import { advisedWording, reviewerRole } from '../reviewers.ts'
import { isRepairNode } from '../dag.ts'
import { executorCategory, isAttackNode, isChallengeNode, isSidecarNode, KIND_LABEL, STATUS_LABEL, type Executor, type NodeKind, type RunStatus } from '../status.ts'
import type { StepRow } from '../steps.ts'
import { stateTone, TONE_LABEL, type Tone } from '../tone.ts'

export type StageEvent = { sequence: number; at: string; status: RunStatus | null; text: string }

/** `role` is the reviewer's part in a judged review (`reviewerRole`): `advisory` for a built-in, `deciding` for the judge; else null. */
export type StageReviewer = { id: string; verdict: 'approved' | 'blocked' | null; status: string; findings: number; blocking: number; role: 'deciding' | 'advisory' | null }

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
  /** The open P0/P1 count the card shows (the review node's blocking findings, or a projected session card's); null when none. */
  openFindings: number | null
  /** The cost a projected session card shows (PRD 3.1); null for every pinned step. */
  cost: string | null
  /** Which projected session card this is ([L2]); null for every pinned step. */
  projected: 'reviewer' | 'panel' | 'lane_review' | null
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
  /** The run's sessions payload (run-sessions): it enriches the projected reviewer/panel/lane-review cards; null when unread. */
  sessions?: Sessions | null
  /** The panels route's record: the Panel card's state word, answered providers and accepted P0/P1 ([L12] 1); null when unread. */
  panels?: PanelResults | null
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
    // On a judged review the judge decided; the built-ins are listed as advisory, never as deciding (PRD 7.4 and 8).
    const advisory = review.reviewers.filter(entry => reviewerRole(review, entry.reviewer_id) === 'advisory')
    const who = review.reviewers.filter(entry => !advisory.includes(entry)).map(entry => `${entry.reviewer_id} ${entry.verdict ?? entry.status}`).join(', ')
    const advised = advisory.length ? `; the judge decided, advisory: ${advisory.map(entry => `${entry.reviewer_id} ${advisedWording(entry)}`).join(', ')}` : ''
    return `Review ${review.verdict}${reviewRound ? ` (${reviewRound})` : ''} by ${who}${advised}; ${review.findings.length} finding${review.findings.length === 1 ? '' : 's'}, ${blocking} blocking.`
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

/** Which projected session card a node id is ([L2]); null for a pinned step. */
function projectedKindOf(nodeId: string): StageNode['projected'] {
  if (!isProjectedSessionNode(nodeId)) return null
  return nodeId === 'panel' ? 'panel' : nodeId.startsWith('lane-review-') ? 'lane_review' : 'reviewer'
}

/**
 * A built-in reviewer's card on a judged review (PRD 7.4 and 8): it advised and the judge decided, so the card is neutral, says
 * "advised …" and carries no open P0/P1 of its own (its findings went to the judge). Every other card is returned as it is.
 */
function advisoryCard(card: StageCard, review: ReviewResult, nodeId: string, sessions: StageModelInput['sessions']): StageCard {
  const reviewerId = nodeId.slice('reviewer-'.length)
  const entry = review.reviewers.find(item => item.reviewer_id === reviewerId)
  if (!entry || reviewerRole(review, reviewerId) !== 'advisory') return card
  const word = advisedWording(entry)
  const round = sessions ? reviewerRowOf(sessions, nodeId)?.round ?? null : null
  return { ...card, tone: 'idle', word, openP01: null, did: `Round ${round ?? '?'}: ${word} (the judge decided).` }
}

export function stageNodes(input: StageModelInput, span: (ms: number) => string): StageNode[] {
  const { detail, rows, events, inputs, review, attention, reviewRound, sessions, panels } = input
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
    // A projected session card's word, tone, open P0/P1, cost and facts come from the sessions payload (PRD 3.1/3.2), the panel's
    // from its own record ([L12] 1): a blocked reviewer is a finished session (status succeeded) whose card carries the fail tone ([L11] 2). Its served status until it loads.
    const projected = projectedKindOf(node.node_id)
    const sessionCard = projected ? stageCardOf(sessions ?? null, node.node_id, panels ?? null) : null
    const stageCard = projected === 'reviewer' && sessionCard && review ? advisoryCard(sessionCard, review, node.node_id, sessions ?? null) : sessionCard
    const reviewOpen = isReview && review ? review.findings.filter(finding => isBlockingFinding(finding) && finding.disposition !== 'resolved').length : null
    const card: Omit<StageNode, 'facts'> = {
      id: node.node_id,
      label: node.label,
      kind: node.kind,
      kindLabel: kindLabelOf(node, repair),
      exec: executorCategory(node.kind),
      dep: node.depends_on,
      status,
      shown,
      tone: stageCard ? stageCard.tone : tone,
      word: stageCard ? stageCard.word : word,
      attempt,
      lane,
      attention: waits,
      ms: stageCard ? (stageCard.seconds === null ? null : Math.round(stageCard.seconds * 1000)) : row?.ms ?? null,
      live: row?.live ?? false,
      start: stageCard ? (stageCard.startedAt ? { at: stageCard.startedAt, source: 'receipt' } : null) : row?.start ?? null,
      end: row?.end ?? null,
      models: stageCard ? stageCard.models : modelsOf(node, repair, inputs),
      repair,
      round: isReview ? reviewRound : repair ? `round ${repair.round} of ${repair.rounds} · ${repair.trigger}` : null,
      returnTo: repair?.blocked_step ?? null,
      did: stageCard ? stageCard.did : didOf(node, row, repair, inputs, review, reviewRound),
      events: sorted.filter(event => event.node_id === node.node_id).map(event => ({ sequence: event.sequence, at: event.occurred_at, status: event.status, text: humanizeEvent(event) })),
      reviewers: isReview && review ? review.reviewers.map(entry => ({ id: entry.reviewer_id, verdict: entry.verdict, status: entry.status, findings: entry.findings.length, blocking: entry.findings.filter(isBlockingFinding).length, role: reviewerRole(review, entry.reviewer_id) })) : null,
      findings: isReview && review ? review.findings : null,
      questions: worker && worker.questions.length > 0 ? worker.questions : null,
      openFindings: stageCard ? stageCard.openP01 : reviewOpen,
      cost: stageCard ? stageCard.cost : null,
      projected,
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
