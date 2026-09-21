/**
 * Human wording for run and node states. The wording deliberately separates "this node finished" from
 * "this workflow is complete": only a `succeeded` run is complete, and a worker node's success only means
 * its native session launched and ended its turn.
 */
import type { RunDetail } from './api.ts'

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

export function shortRevision(revision: string): string {
  return revision.slice(0, 12)
}

export function formatTime(iso: string): string {
  const time = Date.parse(iso)
  if (Number.isNaN(time)) return iso
  return new Date(time).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC')
}
