import { useState, type ReactNode } from 'react'
import type { RunDetail, RunInputs, RunInputWorker, RunScope, WorkerResult } from '../api.ts'
import { CreatedFiles } from '../CreatedFiles.tsx'
import { AppLink, ErrorPanel, LoadingPanel } from '../panels.tsx'
import { NodeSection } from '../SectionIndex.tsx'
import type { Resource } from '../useResource.ts'
import { LaunchReceipt, StopLine, TaskPanel, WorkerQuestions, WorkerSignals } from '../WorkerInputs.tsx'
import { filesCount } from './model.ts'
import type { CheckTarget } from './Requirements.tsx'
import { ResultError, ResultFacts, WorkerNarrative } from './ResultFacts.tsx'
import './worker.css'

type SnapshotNode = RunDetail['snapshot']['nodes'][number]

/** The pinned task behind a disclosure, closed by default and opened when a finding link hands over a quote to highlight. */
function TaskDisclosure({ highlight, children }: { highlight: string | null; children: ReactNode }) {
  const [open, setOpen] = useState(highlight !== null)
  return (
    <details className="evidence-section task-details" data-testid="task-details" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
      <summary id="task-details-summary">Task: what this worker was asked to do</summary>
      {children}
    </details>
  )
}

type Props = {
  scope: RunScope
  /** The node's result as loaded, with its loading, error and absence lines already worded. */
  renderResult: (evidence: (data: WorkerResult) => ReactNode) => ReactNode
  result: Resource<WorkerResult>
  /** Whether this node shows the result's facts (no verify node links the same result) and the worker's narrative. */
  role: { facts: boolean; narrative: boolean }
  /** The verify node that shows the result's facts and executed checks; null when the pinned graph has none. */
  checksNode: CheckTarget | null
  /** "after operator repair 1" when the verify node's latest attempt followed a repair; empty otherwise. */
  repairNote: string
  inputs: Resource<RunInputs | null>
  onRetryInputs: () => void
  worker: RunInputWorker | null
  reviewNode: SnapshotNode | null
  refreshToken: number
  onNavigate: (pathname: string) => void
  highlight: string | null
  onHighlightApplied: () => void
  fileFocus: string | null
  onFileFocusApplied: () => void
}

/**
 * A launch node's sections (docs/PRD_VIEWER_UX.md 4.5): the questions to the operator while there are any, what the worker
 * produced (its narrative, and the result's facts unless the verify node shows them) and the files it created or changed
 * as captured at freeze, then its completion signal, the launch receipt and the task behind a disclosure.
 */
export function WorkerSections({ scope, renderResult, result, role, checksNode, repairNote, inputs, onRetryInputs, worker, reviewNode, refreshToken, onNavigate, highlight, onHighlightApplied, fileFocus, onFileFocusApplied }: Props) {
  const recordedInputs = inputs.status === 'ready' ? inputs.data : null
  const files = result.status === 'ready' ? filesCount(result.data) : 0
  return (
    <>
      {worker !== null && worker.questions.length > 0 && (
        <NodeSection sectionKey="questions" labelledBy="worker-questions-title">
          <WorkerQuestions questions={worker.questions} />
        </NodeSection>
      )}

      <NodeSection sectionKey="result" title="Result">
        {renderResult(data => (
          <div className="worker-evidence" data-testid="worker-result" data-view="produced">
            {!role.facts && checksNode !== null && (
              <p className="worker-verified" data-testid="worker-verified">
                Verified on attempt {data.attempt}{repairNote ? ` ${repairNote}` : ''}
                {data.output_commit ? <> · revision <code>{data.output_commit.slice(0, 7)}</code></> : null} ·{' '}
                <AppLink href={checksNode.href} onNavigate={onNavigate}>facts and checks on {checksNode.label} ›</AppLink>
              </p>
            )}
            {role.narrative && <WorkerNarrative result={data} />}
            {role.facts && <><ResultFacts result={data} /><ResultError result={data} /></>}
          </div>
        ))}
      </NodeSection>

      {result.status === 'ready' && files > 0 && (
        <NodeSection sectionKey="files" labelledBy="evidence-created-files">
          <CreatedFiles scope={scope} result={result.data} reviewNode={reviewNode} refreshToken={refreshToken} focusPath={fileFocus} onFocusApplied={onFileFocusApplied} />
        </NodeSection>
      )}

      {(inputs.status === 'loading' || inputs.status === 'idle') && <LoadingPanel>Loading the run inputs…</LoadingPanel>}
      {inputs.status === 'error' && <ErrorPanel error={inputs.error} what="The run inputs" onRetry={onRetryInputs} />}
      {inputs.status === 'ready' && recordedInputs === null && (
        <p className="projects-muted" data-testid="worker-inputs-none">
          Inputs not recorded for this run (the export predates run inputs; re-export it with the workflow CLI), so the task, launch receipt and completion signal cannot be shown.
        </p>
      )}
      {recordedInputs !== null && worker === null && (
        <p className="projects-muted" data-testid="worker-inputs-unmatched">The run inputs list no worker launched by this node.</p>
      )}
      {worker !== null && (
        <>
          <NodeSection sectionKey="report" labelledBy="worker-completion-title">
            <WorkerSignals completion={worker.completion} handoff={worker.handoff} worker={worker} result={result} checksNode={checksNode} onNavigate={onNavigate} />
          </NodeSection>
          <NodeSection sectionKey="session" labelledBy="launch-receipt-title">
            <LaunchReceipt launch={worker.launch} />
            {worker.questions.length === 0 && <p className="projects-muted" data-testid="worker-questions-none">No questions were recorded for this worker.</p>}
            <StopLine stop={worker.stop} />
          </NodeSection>
          <NodeSection sectionKey="task" labelledBy="task-details-summary">
            <TaskDisclosure highlight={highlight}>
              <TaskPanel worker={worker} result={result} highlight={highlight} onHighlightApplied={onHighlightApplied} checksNode={checksNode} onNavigate={onNavigate} />
            </TaskDisclosure>
          </NodeSection>
        </>
      )}
    </>
  )
}
