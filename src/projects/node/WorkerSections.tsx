import { useState, type ReactNode } from 'react'
import type { NextStep } from '../../../contracts/projects/triage.ts'
import type { RunDetail, RunInputs, RunInputWorker, RunScope, WorkerResult } from '../api.ts'
import { CreatedFiles } from '../CreatedFiles.tsx'
import { AppLink, ErrorPanel, LoadingPanel } from '../panels.tsx'
import { NodeSection } from '../SectionIndex.tsx'
import type { Resource } from '../useResource.ts'
import { LaunchReceipt, ResultReport, StopLine, TaskPanel, WorkerQuestions, WorkerReport } from '../WorkerInputs.tsx'
import { answerNext, launchFilesCount, waitingQuestions } from './launch.ts'
import type { CheckTarget } from './Requirements.tsx'
import { ResultError, ResultFacts } from './ResultFacts.tsx'
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

/**
 * Where the worker's result stands with its verification (docs/PRD_VIEWER_UX.md 8): the revision frozen at handoff, then
 * "verified" only when the verification passed on this result; a failed or unfinished one says so, since the facts and the
 * gate's error it links are shown once, on the verify node.
 */
function VerifiedLine({ result, checksNode, frozenCommit, repairNote, onNavigate }: {
  result: WorkerResult
  checksNode: NonNullable<Props['checksNode']>
  frozenCommit: string | null
  repairNote: string
  onNavigate: (pathname: string) => void
}) {
  const passed = checksNode.status === 'succeeded' && result.status === 'succeeded' && result.error === null
  const failed = !passed && (checksNode.status === 'failed' || result.error !== null || result.status === 'failed')
  const state = passed ? 'verified' : failed ? 'failed' : 'unverified'
  const after = repairNote ? ` ${repairNote}` : ''
  const words = passed ? `verified on attempt ${result.attempt}${after}`
    : failed ? `verification failed on attempt ${result.attempt}${after}`
      : checksNode.status === 'pending' || checksNode.attempt === 0 ? 'not verified yet'
        : `verification attempt ${checksNode.attempt} is ${checksNode.status === 'running' ? 'running' : 'not finished'}`
  const repaired = passed && result.output_commit !== null && frozenCommit !== null && result.output_commit !== frozenCommit
  return (
    <p className="worker-verified" data-testid="worker-verified" data-state={state}>
      {frozenCommit ? <>Frozen at handoff as <code>{frozenCommit.slice(0, 7)}</code>; {words}</> : `${words[0].toUpperCase()}${words.slice(1)}`}
      {repaired && <> as <code>{result.output_commit!.slice(0, 7)}</code></>} ·{' '}
      <AppLink href={checksNode.href} onNavigate={onNavigate}>{failed ? 'the gate\'s reasons' : 'facts and checks'} on {checksNode.label} ›</AppLink>
    </p>
  )
}

/**
 * The Session disclosure, closed (docs/PRD_VIEWER_UX.md 4.5, 7): the launch receipt, the identifiers (the result's facts when
 * no verify node shows them, else the run's base and the revision frozen at handoff), the questions when none waits, and the
 * stop line.
 */
function SessionDisclosure({ worker, children }: { worker: RunInputWorker; children: ReactNode }) {
  const stopped = worker.stop !== null && worker.stop.stopped && worker.stop.confirmed_at !== null
  return (
    <details className="evidence-section worker-session" data-testid="worker-session">
      <summary id="worker-session-summary">
        Session <span className="projects-muted">· {stopped ? 'stopped' : 'not stopped'} · launch receipt and identifiers</span>
      </summary>
      <LaunchReceipt launch={worker.launch} stopped={stopped} />
      {children}
      {waitingQuestions(worker) === 0 && (worker.questions.length === 0
        ? <p className="projects-muted" data-testid="worker-questions-none">No questions were recorded for this worker.</p>
        : <WorkerQuestions questions={worker.questions} />)}
      <StopLine stop={worker.stop} />
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
  /** The verify node that shows the result's facts and executed checks, with its status; null when the pinned graph has none. */
  checksNode: (CheckTarget & { status: SnapshotNode['status']; attempt: number }) | null
  /** The worker's own freeze (`results/<lane>/1`, the verification's first attempt) once loaded; null otherwise. */
  frozen: WorkerResult | null
  /** The revision the worker handed over (the frozen result's output commit); null until known. */
  frozenCommit: string | null
  /** "after operator repair 1" when the verify node's latest attempt followed a repair; empty otherwise. */
  repairNote: string
  /** The repair a changed file is credited to ("repair 1"); empty when none is recorded. */
  repairLabel: string
  /** The Now banner's next step when it is this lane's waiting question, so both say the same; null otherwise. */
  answer: NextStep | null
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
 * A launch node's sections (docs/PRD_VIEWER_UX.md 4.5): the waiting question first, with both ways to answer it; the
 * worker's report, said once; the files it froze at handoff as dense rows; the task, and the session behind closed
 * disclosures.
 */
export function WorkerSections({ scope, renderResult, result, role, checksNode, frozen, frozenCommit, repairNote, repairLabel, answer, inputs, onRetryInputs, worker, reviewNode, refreshToken, onNavigate, highlight, onHighlightApplied, fileFocus, onFileFocusApplied }: Props) {
  const recordedInputs = inputs.status === 'ready' ? inputs.data : null
  const files = result.status === 'ready' ? launchFilesCount(frozen, result.data) : 0
  const lane = worker?.node_id ?? null
  return (
    <>
      {worker !== null && waitingQuestions(worker) > 0 && (
        <NodeSection sectionKey="questions" labelledBy="worker-questions-title" className="worker-questions-section">
          <WorkerQuestions questions={worker.questions} answer={answer ?? answerNext(lane!)} />
        </NodeSection>
      )}

      <NodeSection sectionKey="report" labelledBy={worker !== null ? 'worker-completion-title' : undefined} title="Worker's report">
        {worker !== null && <WorkerReport completion={worker.completion} handoff={worker.handoff} worker={worker} result={result} checksNode={checksNode} onNavigate={onNavigate} />}
        {renderResult(data => (
          <div className="worker-evidence" data-testid="worker-result" data-view="produced">
            {!role.facts && checksNode !== null && <VerifiedLine result={data} checksNode={checksNode} frozenCommit={frozenCommit} repairNote={repairNote} onNavigate={onNavigate} />}
            {(worker === null || worker.completion === null) && role.narrative && <ResultReport result={data} />}
            {role.facts && <>{worker === null && <ResultFacts result={data} />}<ResultError result={data} /></>}
          </div>
        ))}
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
      </NodeSection>

      {result.status === 'ready' && files > 0 && (
        <NodeSection sectionKey="files" labelledBy="evidence-created-files">
          <CreatedFiles
            scope={scope}
            result={result.data}
            frozen={frozen}
            repairLabel={repairLabel}
            reviewNode={reviewNode}
            refreshToken={refreshToken}
            focusPath={fileFocus}
            onFocusApplied={onFileFocusApplied}
          />
        </NodeSection>
      )}

      {worker !== null && (
        <>
          <NodeSection sectionKey="task" labelledBy="task-details-summary">
            <TaskDisclosure highlight={highlight}>
              <TaskPanel worker={worker} result={result} highlight={highlight} onHighlightApplied={onHighlightApplied} checksNode={checksNode} onNavigate={onNavigate} />
            </TaskDisclosure>
          </NodeSection>
          <NodeSection sectionKey="session" labelledBy="worker-session-summary">
            <SessionDisclosure worker={worker}>
              {role.facts && result.status === 'ready' ? <ResultFacts result={result.data} /> : (
                <dl className="projects-facts" data-testid="worker-identifiers">
                  {recordedInputs !== null && <div><dt>Base commit</dt><dd><code>{recordedInputs.base_commit.slice(0, 12)}</code></dd></div>}
                  {frozenCommit !== null && <div><dt>Frozen at handoff</dt><dd><code>{frozenCommit.slice(0, 12)}</code></dd></div>}
                </dl>
              )}
            </SessionDisclosure>
          </NodeSection>
        </>
      )}
    </>
  )
}
