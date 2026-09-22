import { useEffect, useRef, useState, type MouseEvent } from 'react'
import { Markdown } from '../document/Markdown.tsx'
import type { RunInputWorker, WorkerResult } from './api.ts'
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
}

/** Scrolls to and focuses an executed check in the evidence list without touching the history. */
function jumpToCheck(event: MouseEvent<HTMLAnchorElement>, id: string) {
  const target = document.getElementById(id)
  if (!target) return
  event.preventDefault()
  target.scrollIntoView({ block: 'center' })
  target.focus()
}

/**
 * The pinned task of a worker: rendered Markdown or the exact source, the ownership boundary and the
 * required checks. When a finding link hands over a quote, the panel opens on the source with the quote
 * marked and scrolled into view. The quote is captured when the panel mounts (the node detail remounts per
 * node), so clearing the pending hand-off afterwards does not remove the mark until the reader leaves.
 */
export function TaskPanel({ worker, result, highlight, onHighlightApplied }: TaskProps) {
  const [view, setView] = useState<'rendered' | 'source'>(() => (highlight === null ? 'rendered' : 'source'))
  const [activeQuote] = useState(() => highlight)
  const markRef = useRef<HTMLElement>(null)
  useEffect(() => {
    if (activeQuote === null) return
    markRef.current?.scrollIntoView({ block: 'center' })
    onHighlightApplied()
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
        <div className="task-rendered"><Markdown content={text} /></div>
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
                  ) : (
                    <a href={`#check-${executedIndex}`} onClick={event => jumpToCheck(event, `check-${executedIndex}`)}>
                      executed as check {executedIndex + 1}: exit {executed[executedIndex].exit_code}
                    </a>
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

/** The worker's own completion signal, and the accepted handoff only when it differs from it. */
export function WorkerSignals({ completion, handoff }: { completion: RunInputWorker['completion']; handoff: RunInputWorker['handoff'] }) {
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
              <span className={`status-badge ${completion.status === 'completed' ? 'status-succeeded' : 'status-failed'}`} data-status={completion.status}><span>{completion.status}</span></span>
              {' '}<span className="projects-muted">as signalled by the session itself, not a verified result.</span>
            </p>
            <p className="worker-summary">{completion.summary}</p>
            <Assumptions items={completion.open_assumptions} />
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
