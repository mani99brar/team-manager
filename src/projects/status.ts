/**
 * Human wording for run and node states. The wording deliberately separates "this node finished" from
 * "this workflow is complete": only a `succeeded` run is complete, and a worker node's success only means
 * its native session launched and ended its turn.
 */
import { ATTACK_NODE_ID, SIDECAR_NODE_ID } from '../../contracts/projects/triage.ts'
import { isBlockingFinding, type ReviewResult, type RunDetail, type RunInputs } from './api.ts'

export { ATTACK_NODE_ID, SIDECAR_NODE_ID }

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

/**
 * A status badge's tooltip, true of a run and of one of its steps alike. It replaces the status footnotes the run and node
 * pages used to repeat (docs/PRD_VIEWER_UX.md section 8).
 */
export const STATUS_TITLE: Record<RunStatus, string> = {
  pending: 'Pending: not started.',
  running: 'Running: in progress, not complete.',
  awaiting_approval: 'Awaiting approval: waits on a decision made in the workflow CLI; viewing approves nothing.',
  paused: 'Paused: stopped with unresolved state, not complete.',
  succeeded: 'Succeeded. Only a succeeded run is a completed workflow; a succeeded worker step is not.',
  failed: 'Failed: not complete.',
  cancelled: 'Cancelled before completion.',
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

/**
 * A run's status in a few words, beside its badge in the run header and the node pages' run bar (section 8). The cause and
 * the next step are the Now banner's; a paused run is never called failed.
 */
export const RUN_STATUS_SHORT: Record<RunStatus, string> = {
  pending: 'not started',
  running: 'in progress, not complete',
  awaiting_approval: 'waits on you, not complete',
  paused: 'stopped, not complete',
  succeeded: 'integrated, complete',
  failed: 'did not complete',
  cancelled: 'cancelled before completion',
}

/** The exporter's generic definition name (workflow/export_state.py), which every workflow registered by a launch carries. */
export const GENERIC_WORKFLOW_NAME = 'Feature implementation'

/**
 * A workflow's title in crumbs, headings and cards (section 4.1, rules 2 and 3; rule 1, the latest run's feature, needs the
 * served `activity.feature`): its id when its name is the exporter's generic one, else its name.
 */
export function workflowTitle(workflow: { workflow_id: string; name: string }): string {
  return workflow.name === GENERIC_WORKFLOW_NAME ? workflow.workflow_id : workflow.name
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
 * The review sidecar's node (docs/PRD_REVIEW_SIDECAR.md 4.1): kind `review` like the challenge, but neither the challenge
 * nor the independent review. An agent (its passes are print jobs) with no new legend entry.
 */
export function isSidecarNode(node: { node_id: string; kind: NodeKind }): boolean {
  return node.node_id === SIDECAR_NODE_ID && node.kind === 'review'
}

/**
 * The attack pass's node (docs/PRD_ATTACK_PASS.md Appendix A): kind `review` beside the independent review, report-only. An
 * agent (one print job per angle, then a skeptic) with no new legend entry.
 */
export function isAttackNode(node: { node_id: string; kind: NodeKind }): boolean {
  return node.node_id === ATTACK_NODE_ID && node.kind === 'review'
}

/**
 * The executor wording for a node; a review names print jobs when the served review result's transport is `print`, the
 * design challenge is always one print job and the review sidecar one print job per pass.
 */
export function executorOf(kind: NodeKind, transport?: ReviewResult['reviewer']['transport'], nodeId?: string): string {
  if (nodeId !== undefined && isChallengeNode({ node_id: nodeId, kind })) return 'one print job'
  if (nodeId !== undefined && isSidecarNode({ node_id: nodeId, kind })) return 'one print job per pass'
  if (nodeId !== undefined && isAttackNode({ node_id: nodeId, kind })) return 'one print job per angle and a skeptic'
  if (kind === 'review' && transport === 'print') return 'one print job per reviewer'
  return EXECUTOR_LABEL[kind]
}

export function shortRevision(revision: string): string {
  return revision.slice(0, 12)
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

type RolePin = { model: string | null; effort: string | null }

/**
 * The run inputs' profile and roles on one line (export 1.7.0): an automatic run's profile, then the workers' and the judges'
 * (the design challenge, the reviewers and the review sidecar) pinned model and effort, "default" where the CLI's own applies.
 * A run prepared before the pins says so; a manual run has no profile.
 */
export function rolesLabel(inputs: Pick<RunInputs, 'automatic'> & { roles?: RunInputs['roles'] }): string {
  const pin = (role: RolePin) => `${role.model ?? 'default model'}, ${role.effort ? `effort ${role.effort}` : 'default effort'}`
  const parts = inputs.automatic ? [inputs.automatic.profile ?? 'profile not pinned'] : []
  parts.push(inputs.roles ? `workers ${pin(inputs.roles.worker)} · judges ${pin(inputs.roles.judges)}` : 'roles not pinned')
  return parts.join(' · ')
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
