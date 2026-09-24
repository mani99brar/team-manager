import type { WorkerResult } from '../api.ts'
import { StatusBadge } from '../panels.tsx'

function shortSha(value: string | null): string {
  return value === null ? 'none' : value.slice(0, 12)
}

/**
 * The facts that anchor a result to its snapshot: status, attempt, session and commits. When a launch node and a verify
 * node link the same result they are shown once, on the verify node (docs/PRD_VIEWER_UX.md 7).
 */
export function ResultFacts({ result }: { result: WorkerResult }) {
  return (
    <dl className="projects-facts" data-testid="result-facts">
      <div><dt>Result status</dt><dd><StatusBadge status={result.status} /></dd></div>
      <div><dt>Attempt</dt><dd>{result.attempt}</dd></div>
      <div><dt>Session</dt><dd><code>{result.session_id}</code></dd></div>
      <div><dt>Base commit</dt><dd><code>{shortSha(result.base_commit)}</code></dd></div>
      <div><dt>Output commit</dt><dd>{result.output_commit ? <code>{shortSha(result.output_commit)}</code> : 'None recorded (no durable output commit)'}</dd></div>
    </dl>
  )
}

/** The error the result recorded: the gate's reasons on a verification, shown with the facts. */
export function ResultError({ result }: { result: WorkerResult }) {
  if (!result.error) return null
  return (
    <div className="projects-error" role="alert" data-testid="worker-error">
      <p><strong>Error {result.error.code}:</strong> {result.error.message}</p>
      <p>{result.error.retryable ? 'Marked retryable by the producer. Retrying is done through the workflow CLI, not this viewer.' : 'Marked not retryable by the producer.'}</p>
    </div>
  )
}

/**
 * The worker's narrative in its result: the summary and the open assumptions behind a count, absent when there are none. Shown
 * once, on the launch node, when it shares the result with its verify node.
 */
export function WorkerNarrative({ result }: { result: WorkerResult }) {
  return (
    <>
      <p className="worker-summary" data-testid="worker-summary">{result.summary}</p>
      {result.open_assumptions.length > 0 && (
        <details className="evidence-section assumptions-details" data-testid="assumptions-details">
          <summary id="evidence-assumptions">Open assumptions ({result.open_assumptions.length})</summary>
          <ul className="evidence-list" data-testid="assumptions">
            {result.open_assumptions.map((assumption, index) => <li key={index}>{assumption}</li>)}
          </ul>
        </details>
      )}
    </>
  )
}
