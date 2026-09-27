import type { ReactNode } from 'react'
import type { Span } from '../../../contracts/projects/triage.ts'
import type { ReviewResult, RunDetail, RunInputs, RunScope, WorkerResult, WorkflowEvent } from '../api.ts'
import { shortRevision } from '../status.ts'
import { Time } from '../Time.tsx'
import { formatAgo, formatSpan } from '../time.ts'
import { approvalLine, handoffWait, integratedCommit, lastStatusAt } from './panels.ts'
import { VerifiedEvidence } from './VerifySections.tsx'
import './controller.css'

type SnapshotNode = RunDetail['snapshot']['nodes'][number]

/** What the operator is asked to decide at a node, by the node that waits. */
const AWAITING_WORDING: Record<string, string> = { approval: 'Awaiting your approval', handoff: 'Awaiting your handoff', review: 'Awaiting the review import' }

/**
 * A step stopped at a decision nobody recorded yet: since when it waits (its last status row, when one was recorded) and the
 * approval requests of its events. Viewing approves nothing; the decision is made in the workflow CLI.
 */
export function AwaitingNotice({ nodeId, approvals, events, clock }: { nodeId: string; approvals: WorkflowEvent[]; events: WorkflowEvent[]; clock: number }) {
  const since = lastStatusAt(events)
  return (
    <div className="projects-notice" role="status" data-testid="awaiting-notice">
      {since !== null && (
        <p data-testid="awaiting-since">
          <strong>{AWAITING_WORDING[nodeId] ?? 'Awaiting a decision'} since <Time iso={since} /></strong> <span className="projects-muted">({formatAgo(since, clock)})</span>
        </p>
      )}
      <p><strong>Awaiting approval.</strong> This node is stopped at a decision that has not been recorded. Viewing does not approve it; decisions are made through the workflow CLI.</p>
      {approvals.length > 0 && (
        <ul className="evidence-list">
          {approvals.map(event => <li key={event.event_id}>Requested at <Time iso={event.occurred_at} />: {event.message}</li>)}
        </ul>
      )}
    </div>
  )
}

/** The instant a controller step recorded its outcome: its last succeeded row, else the end of its latest span. */
function doneAt(events: WorkflowEvent[], spans: readonly Span[]): string | null {
  return events.filter(event => event.status === 'succeeded').at(-1)?.occurred_at ?? spans.at(-1)?.end?.at ?? null
}

/** The freeze: when the workers were stopped and their snapshots captured, and how long it waited for their signals. */
function HandoffSummary({ node, events, spans, inputs }: { node: SnapshotNode; events: WorkflowEvent[]; spans: readonly Span[]; inputs: RunInputs | null }) {
  if (node.status !== 'succeeded') return null
  const at = doneAt(events, spans)
  const lanes = inputs?.workers.map(worker => worker.node_id) ?? []
  const wait = handoffWait(inputs?.workers ?? [], at)
  return (
    <div className="controller-summary" data-testid="handoff-summary">
      <p className="controller-line">
        {at && <><Time iso={at} seconds /> · </>}workers stopped and snapshots captured{lanes.length > 0 && ` (${lanes.join(', ')})`}
        {wait && <> · waited {formatSpan(wait.ms)} for the completion signal</>}
      </p>
      {wait && (
        <p className="projects-muted controller-source" data-testid="handoff-wait">
          (wait = latest launch start ({wait.lane}, <Time iso={wait.from} seconds />) → freeze; from receipts)
        </p>
      )}
    </div>
  )
}

/** The approval: when (≈ the integration when no event recorded it), who approved, and the reviewed bundle it names. */
function ApprovalSummary({ node, events, spans, inputs, review }: { node: SnapshotNode; events: WorkflowEvent[]; spans: readonly Span[]; inputs: RunInputs | null; review: ReviewResult | null }) {
  const bundle = review ? <>bundle <code title={review.bundle_sha256}>{shortRevision(review.bundle_sha256)}</code></> : null
  if (node.status === 'awaiting_approval') {
    return (
      <div className="controller-summary" data-testid="approval-summary">
        <p className="controller-line">Waiting for your approval of the reviewed {bundle ?? 'bundle (not loaded)'}; approving fast-forwards the source branch, nothing is pushed.</p>
      </div>
    )
  }
  const line = node.status === 'succeeded' ? approvalLine(spans, events, inputs) : null
  if (line === null) return null
  return (
    <div className="controller-summary" data-testid="approval-summary">
      <p className="controller-line">
        {line.at && <><span title={line.inferred ? 'no approval event recorded; the time is the integration\'s' : undefined}>{line.inferred ? '≈' : ''}<Time iso={line.at} seconds /></span> · </>}
        {line.how}
        {!line.recorded && ' · no approval event recorded'}
        {bundle && <> · {bundle}</>}
      </p>
    </div>
  )
}

/** The integration: when, which branch was fast-forwarded to which commit, and that nothing was pushed. */
function IntegrateSummary({ node, events, spans, inputs }: { node: SnapshotNode; events: WorkflowEvent[]; spans: readonly Span[]; inputs: RunInputs | null }) {
  if (node.status !== 'succeeded') return null
  const at = doneAt(events, spans)
  const commit = integratedCommit(events, null)
  return (
    <div className="controller-summary" data-testid="integrate-summary">
      <p className="controller-line">
        {at && <><Time iso={at} seconds /> · </>}fast-forwarded {inputs?.source_branch ?? 'the source branch'}
        {commit && <> to <code title={commit}>{shortRevision(commit)}</code></>} · no push performed
      </p>
    </div>
  )
}

/**
 * The controller's own steps (docs/PRD_VIEWER_UX.md 4.9): the freeze of the handoffs, the approval and the integration. One
 * panel with no index: what each did in one line, what they recorded (usually no result of their own), and their History
 * inline after it.
 */
export function ControllerSections({ scope, node, events, spans, inputs, review, renderResult }: {
  scope: RunScope
  node: SnapshotNode
  /** The node's own events. */
  events: WorkflowEvent[]
  /** The node's spans in the run's timeline. */
  spans: readonly Span[]
  inputs: RunInputs | null
  /** The recorded review, for the approval's bundle; null elsewhere or until it loads. */
  review: ReviewResult | null
  renderResult: (evidence: (data: WorkerResult) => ReactNode) => ReactNode
}) {
  return (
    <div className="controller-panel">
      {node.node_id === 'handoff' && <HandoffSummary node={node} events={events} spans={spans} inputs={inputs} />}
      {node.node_id === 'approval' && <ApprovalSummary node={node} events={events} spans={spans} inputs={inputs} review={review} />}
      {node.node_id === 'integrate' && <IntegrateSummary node={node} events={events} spans={spans} inputs={inputs} />}
      {renderResult(data => <VerifiedEvidence scope={scope} result={data} phase="worker" />)}
    </div>
  )
}
