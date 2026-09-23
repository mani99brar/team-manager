/**
 * Human wording for run and node states. The wording deliberately separates "this node finished" from
 * "this workflow is complete": only a `succeeded` run is complete, and a worker node's success only means
 * its native session launched and ended its turn.
 */
import { isBlockingFinding, type ReviewResult, type RunDetail } from './api.ts'

export type RunStatus = RunDetail['summary']['status']
export type NodeKind = RunDetail['definition']['nodes'][number]['kind']

export const STATUS_LABEL: Record<RunStatus, string> = {
  pending: 'Pending',
  running: 'Running',
  awaiting_approval: 'Awaiting approval',
  paused: 'Paused',
  succeeded: 'Succeeded',
  failed: 'Failed',
  cancelled: 'Cancelled',
}

/** What a run in this status means for the workflow as a whole. */
export const RUN_STATUS_MEANING: Record<RunStatus, string> = {
  pending: 'Nothing has started yet.',
  running: 'Work is in progress. The workflow is not complete.',
  awaiting_approval: 'Stopped at a decision that has not been made. The workflow is not complete; nothing is approved by viewing it.',
  paused: 'Paused with unresolved state (for example a session that could not be reconciled). The workflow is not complete.',
  succeeded: 'Integration was confirmed and no graph work remains.',
  failed: 'A graph step or check failed. The workflow did not complete.',
  cancelled: 'The run was cancelled before completion.',
}

/** What a node in this status means, given its kind. */
export function nodeStatusMeaning(kind: NodeKind, status: RunStatus): string {
  switch (status) {
    case 'pending': return 'Not started: no attempt has run.'
    case 'running': return kind === 'worker' ? 'The native worker session is running or its turn has not been signalled complete.' : 'In progress.'
    case 'awaiting_approval': return 'Waiting for an explicit decision recorded outside this viewer. Not complete.'
    case 'paused': return 'Paused with unresolved evidence. Not complete.'
    case 'succeeded':
      return kind === 'worker'
        ? 'The worker session launched and ended its turn. This is not workflow completion; verification, review and integration are separate nodes.'
        : kind === 'integration'
          ? 'This integration step completed.'
          : 'This step completed.'
    case 'failed': return 'This step failed. The run cannot succeed without intervention.'
    case 'cancelled': return 'This step was cancelled.'
  }
}

export const KIND_LABEL: Record<NodeKind, string> = {
  prepare: 'Preparation',
  worker: 'Worker',
  verification: 'Verification',
  review: 'Review',
  integration: 'Integration',
}

/**
 * Who executes a node, derived from its kind (PRD_VIEWER_CLARITY 4.3): a worker is an agent session, a review is one
 * agent session per reviewer (one print job per reviewer when the review ran with the print transport), a
 * verification is the trusted verifier, and preparation and integration are the controller itself.
 */
export type Executor = 'agent' | 'verifier' | 'controller'

export const EXECUTOR_LABEL: Record<NodeKind, string> = {
  prepare: 'controller',
  worker: 'agent session',
  verification: 'trusted verifier',
  review: 'one agent session per reviewer',
  integration: 'controller',
}

/** The executor category of a node kind: agents are drawn solid, the verifier and the controller dashed. */
export function executorCategory(kind: NodeKind): Executor {
  if (kind === 'worker' || kind === 'review') return 'agent'
  return kind === 'verification' ? 'verifier' : 'controller'
}

/** The design challenge node of a guarded run (PRD_PORTABLE_WORKFLOW 4.5): kind `review`, but not the independent review. */
export const CHALLENGE_NODE_ID = 'challenge'

export function isChallengeNode(node: { node_id: string; kind: NodeKind }): boolean {
  return node.node_id === CHALLENGE_NODE_ID && node.kind === 'review'
}

/**
 * The executor wording for a node; a review names print jobs when the served review result's transport is `print`, and
 * the design challenge is always one print job.
 */
export function executorOf(kind: NodeKind, transport?: ReviewResult['reviewer']['transport'], nodeId?: string): string {
  if (nodeId !== undefined && isChallengeNode({ node_id: nodeId, kind })) return 'one print job'
  if (kind === 'review' && transport === 'print') return 'one print job per reviewer'
  return EXECUTOR_LABEL[kind]
}

export function shortRevision(revision: string): string {
  return revision.slice(0, 12)
}

export function formatTime(iso: string): string {
  const time = Date.parse(iso)
  if (Number.isNaN(time)) return iso
  return new Date(time).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC')
}

/** Compact duration for deadlines and timeouts: 14400 → "4h", 5400 → "1h30m", 45 → "45s". */
export function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const rest = seconds % 60
  const parts: string[] = []
  if (hours > 0) parts.push(`${hours}h`)
  if (minutes > 0) parts.push(`${minutes}m`)
  if (rest > 0 || parts.length === 0) parts.push(`${rest}s`)
  return parts.join('')
}

/** The automatic profile's deadlines as one phrase, e.g. "worker 4h · review 30m". */
export function deadlinesLabel(automatic: { worker_timeout_seconds: number; review_timeout_seconds: number }): string {
  return `worker ${formatDuration(automatic.worker_timeout_seconds)} · review ${formatDuration(automatic.review_timeout_seconds)}`
}

const DISPOSITIONS = ['open', 'resolved', 'accepted'] as const

/** One line for a recorded review: verdict, finding counts by disposition and how many block integration (unresolved P0/P1). */
export function reviewSummary(review: ReviewResult): string {
  const { verdict, findings } = review
  if (findings.length === 0) return `${verdict} with no findings`
  const counts = DISPOSITIONS
    .map(disposition => [disposition, findings.filter(finding => finding.disposition === disposition).length] as const)
    .filter(([, count]) => count > 0)
    .map(([disposition, count]) => `${count} ${disposition}`)
  const blocking = findings.filter(isBlockingFinding).length
  return `${verdict} with ${findings.length} ${findings.length === 1 ? 'finding' : 'findings'}: ${counts.join(', ')}, ${blocking === 0 ? 'none blocking' : `${blocking} blocking`}`
}
