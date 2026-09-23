import { useEffect, useRef, useState } from 'react'
import { Markdown } from '../document/Markdown.tsx'
import type { RunInputWorker, WorkerResult } from './api.ts'
import { AppLink } from './panels.tsx'
import { keepInView } from './scroll.ts'
import { formatDuration, formatTime } from './status.ts'
import type { Resource } from './useResource.ts'

type TaskProps = {
  worker: RunInputWorker
  /** The node's published result, when it loaded: required checks are matched to executed checks by exact command. */
  result: Resource<WorkerResult>
  /** A requirement quote to highlight in the task source, handed over by a finding link; null otherwise. */
  highlight: string | null
  /** Called once the highlight has been applied, so the run view forgets it (leaving the node drops it anyway). */
  onHighlightApplied: () => void
  /** The verify node that shows the executed checks with their logs; null when the pinned graph has none. */
  checksNode: CheckTarget | null
  onNavigate: (pathname: string) => void
}

/**
 * The pinned task of a worker: rendered Markdown or the exact source, the ownership boundary and the
 * required checks. When a finding link hands over a quote, the panel opens on the source with the quote
 * marked and scrolled into view. The quote is captured when the panel mounts (the node detail remounts per
 * node), so clearing the pending hand-off afterwards does not remove the mark until the reader leaves.
 */
export function TaskPanel({ worker, result, highlight, onHighlightApplied, checksNode, onNavigate }: TaskProps) {
  const [view, setView] = useState<'rendered' | 'source'>(() => (highlight === null ? 'rendered' : 'source'))
  const [activeQuote] = useState(() => highlight)
  const markRef = useRef<HTMLElement>(null)
  useEffect(() => {
    if (activeQuote === null) return
    const stop = markRef.current ? keepInView(markRef.current, { block: 'center' }) : undefined
    onHighlightApplied()
    return stop
  }, [activeQuote, onHighlightApplied])

  const text = worker.task.text
  const index = activeQuote === null ? -1 : text.indexOf(activeQuote)
  const executed = result.status === 'ready' ? result.data.checks : null

  return (
    <section className="evidence-section task-panel" aria-labelledby="task-title" data-testid="task-panel">
      <div className="task-head">
        <h4 id="task-title">Task</h4>
        <div role="group" aria-label="Task view" className="task-toggle">
          <button type="button" className="button button-small" aria-pressed={view === 'rendered'} onClick={() => setView('rendered')}>Rendered</button>
          <button type="button" className="button button-small" aria-pressed={view === 'source'} onClick={() => setView('source')}>Source</button>
        </div>
      </div>
      <p className="projects-muted">The assignment pinned in the run plan: the authored task plus the appended ownership and checks.</p>
      {worker.task.truncated && (
        <p className="projects-notice" role="note" data-testid="task-truncated">The task text was truncated by the viewer API; the marker at its end says how many characters were left out.</p>
      )}
      {activeQuote !== null && index === -1 && (
        <p className="projects-muted" data-testid="task-highlight-missing">The quoted requirement was not found in this task text, so nothing is highlighted.</p>
      )}
      {view === 'rendered' ? (
        <div className="task-rendered"><Markdown content={text} inert /></div>
      ) : (
        <pre className="task-source" data-testid="task-source" tabIndex={0}>
          {index === -1 ? text : (
            <>
              {text.slice(0, index)}
              <mark ref={markRef} className="task-highlight" data-testid="task-highlight">{activeQuote}</mark>
              {text.slice(index + activeQuote!.length)}
            </>
          )}
        </pre>
      )}

      <h5 id="task-owned-title">Owned paths</h5>
      {worker.owned_paths.length === 0 ? (
        <p className="projects-muted">No owned paths were pinned.</p>
      ) : (
        <ul className="evidence-list evidence-files" data-testid="task-owned-paths" aria-labelledby="task-owned-title">
          {worker.owned_paths.map(path => <li key={path}><code>{path}</code></li>)}
        </ul>
      )}

      <h5 id="task-checks-title">Required checks</h5>
      <p className="projects-muted" data-testid="task-required-kinds">
        Required check kinds for this lane: {worker.required_check_kinds.length === 0 ? 'none pinned' : worker.required_check_kinds.join(', ')}
      </p>
      {worker.checks.length === 0 ? (
        <p className="projects-muted">No checks were required.</p>
      ) : (
        <ul className="evidence-list task-checks" data-testid="task-checks" aria-labelledby="task-checks-title">
          {worker.checks.map(check => {
            const executedIndex = executed === null ? -1 : executed.findIndex(candidate => candidate.command === check.command)
            return (
              <li key={check.id} data-check-id={check.id}>
                <code>{check.command}</code>
                <span className="projects-muted"> · {check.id} · {check.kind} · timeout {formatDuration(check.timeout_seconds)}</span>
                {check.scenarios.length > 0 && (
                  <span className="projects-muted"> · {check.scenarios.length} {check.scenarios.length === 1 ? 'scenario' : 'scenarios'}: {check.scenarios.map(scenario => scenario.id).join(', ')}</span>
                )}
                <div className="task-check-status">
                  {executed === null ? (
                    <span className="projects-muted">{result.status === 'loading' ? 'Loading the published result to compare…' : 'No published result to compare against.'}</span>
                  ) : executedIndex === -1 ? (
                    <span className="projects-muted">not executed in this result</span>
                  ) : checksNode === null ? (
                    <span>executed as check {executedIndex + 1}: exit {executed[executedIndex].exit_code}</span>
                  ) : (
                    <AppLink href={checksNode.href} onNavigate={onNavigate} data-check-index={executedIndex} title={`The check and its log are shown on ${checksNode.label}`}>
                      executed as check {executedIndex + 1}: exit {executed[executedIndex].exit_code} (on {checksNode.label})
                    </AppLink>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      )}

      {worker.prompt === null ? (
        <p className="projects-muted" data-testid="task-prompt-none">The exact prompt was not recorded for this run (it predates prompt capture).</p>
      ) : (
        <details className="task-prompt" data-testid="task-prompt">
          <summary>Exact prompt the session received{worker.prompt.truncated ? ' (truncated by the viewer API)' : ''}</summary>
          <pre className="task-source">{worker.prompt.text}</pre>
        </details>
      )}
    </section>
  )
}

export function LaunchReceipt({ launch }: { launch: RunInputWorker['launch'] }) {
  return (
    <section className="evidence-section" aria-labelledby="launch-receipt-title" data-testid="launch-receipt">
      <h4 id="launch-receipt-title">Launch receipt</h4>
      {launch === null ? (
        <p className="projects-muted" data-testid="launch-none">No launch receipt recorded.</p>
      ) : (
        <dl className="projects-facts">
          <div><dt>Session</dt><dd>{launch.session_id === null ? 'Not yet reported by the launcher' : <code>{launch.session_id}</code>}</dd></div>
          <div><dt>Launch requested</dt><dd>{formatTime(launch.launch_requested_at)}</dd></div>
          <div><dt>Native start</dt><dd>{launch.native_started_at === null ? 'Not reported' : formatTime(launch.native_started_at)}</dd></div>
          <div><dt>Observed state</dt><dd>{launch.observed_state ?? 'Not observed'}</dd></div>
          <div><dt>Launcher status</dt><dd><code>{launch.status}</code></dd></div>
          <div><dt>Launcher invocations</dt><dd>{launch.launcher_invocations}</dd></div>
        </dl>
      )}
    </section>
  )
}

function Assumptions({ items }: { items: string[] }) {
  if (items.length === 0) return <p className="projects-muted">No open assumptions.</p>
  return <ul className="evidence-list">{items.map((item, index) => <li key={index}>{item}</li>)}</ul>
}

type Completion = NonNullable<RunInputWorker['completion']>
/** Where a check id named by the worker is shown: the verify node, and the executed check it matched by command when known. */
export type CheckTarget = { href: string; label: string }

const COMPLETION_BADGE: Record<Completion['status'], string> = { completed: 'status-succeeded', blocked: 'status-failed', question: 'status-awaiting_approval' }

/**
 * The falsifying check the worker named: a declared check id links to the verify node that shows that check executed; a
 * command equal to a declared check's command is treated the same; anything else is shown as the worker wrote it.
 */
function FalsifyingCheck({ value, worker, result, checksNode, onNavigate }: {
  value: string
  worker: RunInputWorker
  result: Resource<WorkerResult>
  checksNode: CheckTarget | null
  onNavigate: (pathname: string) => void
}) {
  const check = worker.checks.find(candidate => candidate.id === value) ?? worker.checks.find(candidate => candidate.command === value) ?? null
  if (check === null) {
    return <span data-testid="falsifying-check-text"><code>{value}</code> <span className="projects-muted">(not a check id declared for this lane)</span></span>
  }
  const executed = result.status === 'ready' ? result.data.checks.findIndex(candidate => candidate.command === check.command) : -1
  const where = executed === -1 ? '' : `, executed as check ${executed + 1}`
  const label = <><code>{check.id}</code> · <code>{check.command}</code></>
  if (checksNode === null) return <span data-testid="falsifying-check-text" data-check-id={check.id}>{label}</span>
  return (
    <AppLink
      href={checksNode.href}
      onNavigate={onNavigate}
      data-testid="falsifying-check-link"
      data-check-id={check.id}
      data-check-index={executed === -1 ? undefined : executed}
      title={`The executed check and its log are shown on ${checksNode.label}`}
    >
      {label} (on {checksNode.label}{where})
    </AppLink>
  )
}

/**
 * The evidence a 1.1.0 completion carries (PRD_PORTABLE_WORKFLOW 4.6): what no executed check covers, the check that would
 * fail if the implementation were wrong, and one assumption to verify independently. A 1.0.0 completion serves all three
 * as null, which is stated rather than shown as empty; so is a 1.1.0 `blocked` one that recorded none. A question the
 * controller has not recorded is shown with its text: still pending, or a fourth one the controller treated as blocked.
 */
function CompletionEvidence({ completion, worker, result, checksNode, onNavigate }: {
  completion: Completion
  worker: RunInputWorker
  result: Resource<WorkerResult>
  checksNode: CheckTarget | null
  onNavigate: (pathname: string) => void
}) {
  const { untested, falsifying_check: falsifying, verify_yourself: verify } = completion
  if (completion.question !== null) {
    const pending = completion.status === 'question'
    return (
      <div data-testid={pending ? 'completion-question-pending' : 'completion-question-refused'}>
        <p className={pending ? 'projects-muted' : 'projects-notice'} role={pending ? undefined : 'note'}>
          {pending
            ? 'No completion evidence yet: the worker ended its turn with this question, which the controller has not recorded as a question to the operator yet:'
            : 'Treated as blocked: the worker asked a fourth question, and at most three are answered, so the controller blocked this lane. The question:'}
        </p>
        <p className="worker-question-text" data-testid="completion-question-text">{completion.question}</p>
      </div>
    )
  }
  if (completion.version === '1.0.0') {
    return (
      <p className="projects-muted" data-testid="completion-evidence-none">
        Completion evidence was not recorded for this run: its completion predates the untested, falsifying-check and verify-yourself fields.
      </p>
    )
  }
  if (completion.status === 'blocked' && untested === null && falsifying === null && verify === null) {
    return (
      <p className="projects-muted" data-testid="completion-evidence-blocked">
        No completion evidence recorded: the worker blocked, and a blocked completion need not carry it.
      </p>
    )
  }
  return (
    <dl className="projects-facts completion-evidence" data-testid="completion-evidence">
      <div data-testid="evidence-untested">
        <dt>Untested</dt>
        <dd>
          {untested === null ? <span className="projects-muted">Not recorded</span>
            : untested.length === 0 ? <span className="projects-muted">Nothing: the worker names no behaviour outside its executed checks.</span>
              : <ul className="evidence-list">{untested.map((item, index) => <li key={index}>{item}</li>)}</ul>}
        </dd>
      </div>
      <div data-testid="evidence-falsifying-check">
        <dt>Falsifying check</dt>
        <dd>
          {falsifying === null || falsifying === ''
            ? <span className="projects-muted">Not recorded</span>
            : <FalsifyingCheck value={falsifying} worker={worker} result={result} checksNode={checksNode} onNavigate={onNavigate} />}
        </dd>
      </div>
      <div data-testid="evidence-verify-yourself">
        <dt>Verify yourself</dt>
        <dd>{verify === null || verify === '' ? <span className="projects-muted">Not recorded</span> : verify}</dd>
      </div>
    </dl>
  )
}

/** The questions the worker asked mid-run, with the operator's answers and times; an unanswered one is waiting on the operator. */
export function WorkerQuestions({ questions }: { questions: RunInputWorker['questions'] }) {
  const waiting = questions.filter(question => question.answer === null).length
  return (
    <section className="evidence-section" aria-labelledby="worker-questions-title" data-testid="worker-questions">
      <h4 id="worker-questions-title">Questions to the operator</h4>
      {questions.length === 0 ? (
        <p className="projects-muted" data-testid="worker-questions-none">No questions were recorded for this worker.</p>
      ) : (
        <>
          {waiting > 0 && (
            <p className="projects-notice" role="status" data-testid="worker-questions-waiting">
              {waiting === 1 ? 'One question is' : `${waiting} questions are`} waiting on the operator. Answers are given through the workflow CLI (<code>workflow answer</code>), not this viewer; the worker's deadline is paused meanwhile.
            </p>
          )}
          <ol className="evidence-list worker-questions" data-testid="worker-question-list">
            {questions.map(question => {
              const answered = question.answer !== null
              return (
                <li key={question.n} data-testid="worker-question" data-question={question.n} data-answered={answered ? 'true' : 'false'}>
                  <p>
                    <strong>Question {question.n}</strong> <span className="projects-muted">asked at {formatTime(question.asked_at)}</span>
                    {!answered && <> · <span className="status-badge status-awaiting_approval" data-testid="question-waiting"><span>Waiting on the operator</span></span></>}
                  </p>
                  <p className="worker-question-text">{question.question}</p>
                  {answered && (
                    <p className="worker-question-answer" data-testid="question-answer">
                      <strong>Answer</strong> <span className="projects-muted">at {question.answered_at === null ? 'an unrecorded time' : formatTime(question.answered_at)}</span>: {question.answer}
                    </p>
                  )}
                </li>
              )
            })}
          </ol>
        </>
      )}
    </section>
  )
}

/**
 * The worker's own completion signal with its evidence, and the accepted handoff only when it differs from it. `worker`,
 * `result` and `checksNode` let the falsifying check link to the executed check.
 */
export function WorkerSignals({ completion, handoff, worker, result, checksNode, onNavigate }: {
  completion: RunInputWorker['completion']
  handoff: RunInputWorker['handoff']
  worker: RunInputWorker
  result: Resource<WorkerResult>
  checksNode: CheckTarget | null
  onNavigate: (pathname: string) => void
}) {
  const handoffDiffers = handoff !== null && (
    completion === null || handoff.summary !== completion.summary || JSON.stringify(handoff.open_assumptions) !== JSON.stringify(completion.open_assumptions)
  )
  return (
    <>
      <section className="evidence-section" aria-labelledby="worker-completion-title" data-testid="worker-completion">
        <h4 id="worker-completion-title">Reported by the worker</h4>
        {completion === null ? (
          <p className="projects-muted">No completion signal recorded.</p>
        ) : (
          <>
            <p>
              <span className={`status-badge ${COMPLETION_BADGE[completion.status]}`} data-status={completion.status}><span>{completion.status}</span></span>
              {' '}<span className="projects-muted">as signalled by the session itself, not a verified result.</span>
            </p>
            <p className="worker-summary">{completion.summary}</p>
            <Assumptions items={completion.open_assumptions} />
            <CompletionEvidence completion={completion} worker={worker} result={result} checksNode={checksNode} onNavigate={onNavigate} />
          </>
        )}
      </section>
      {handoffDiffers && (
        <section className="evidence-section" aria-labelledby="worker-handoff-title" data-testid="worker-handoff">
          <h4 id="worker-handoff-title">Handoff as accepted</h4>
          <p className="projects-muted">The accepted handoff differs from what the worker reported.</p>
          <p className="worker-summary">{handoff.summary}</p>
          <Assumptions items={handoff.open_assumptions} />
        </section>
      )}
    </>
  )
}

export function StopLine({ stop }: { stop: RunInputWorker['stop'] }) {
  const confirmed = stop !== null && stop.stopped && stop.confirmed_at !== null
  return (
    <p className="worker-stop" data-testid="worker-stop">
      {confirmed
        ? `Stop confirmed at ${formatTime(stop.confirmed_at!)}.`
        : stop === null ? 'Stop not confirmed: no stop receipt was recorded.' : 'Stop not confirmed: the stop receipt records no confirmation.'}
    </p>
  )
}
