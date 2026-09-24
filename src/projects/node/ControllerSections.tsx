import type { ReactNode } from 'react'
import type { RunScope, WorkerResult, WorkflowEvent } from '../api.ts'
import { Time } from '../Time.tsx'
import { VerifiedEvidence } from './VerifySections.tsx'
import './controller.css'

/**
 * A step stopped at a decision nobody recorded yet: the approval requests of its events. Viewing approves nothing; the
 * decision is made in the workflow CLI.
 */
export function AwaitingNotice({ approvals }: { approvals: WorkflowEvent[] }) {
  return (
    <div className="projects-notice" role="status" data-testid="awaiting-notice">
      <p><strong>Awaiting approval.</strong> This node is stopped at a decision that has not been recorded. Viewing does not approve it; decisions are made through the workflow CLI.</p>
      {approvals.length > 0 && (
        <ul className="evidence-list">
          {approvals.map(event => <li key={event.event_id}>Requested at <Time iso={event.occurred_at} />: {event.message}</li>)}
        </ul>
      )}
    </div>
  )
}

/**
 * The controller's own steps (docs/PRD_VIEWER_UX.md 4.9): the freeze of the handoffs, the approval and the integration. One
 * panel with no index: what they recorded, which is usually no result of their own, and their History inline.
 */
export function ControllerSections({ scope, renderResult }: { scope: RunScope; renderResult: (evidence: (data: WorkerResult) => ReactNode) => ReactNode }) {
  return (
    <div className="controller-panel">
      {renderResult(data => <VerifiedEvidence scope={scope} result={data} phase="worker" />)}
    </div>
  )
}
