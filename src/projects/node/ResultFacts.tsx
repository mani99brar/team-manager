import type { WorkerResult } from '../api.ts'
import { StatusBadge } from '../panels.tsx'

/**
 * The facts that anchor a result to its snapshot: its status and attempt, then its identifiers behind one closed disclosure.
 * When a launch node and a verify node link the same result they are shown once, on the verify node (docs/PRD_VIEWER_UX.md 7).
 */
export function ResultFacts({ result }: { result: WorkerResult }) {
  return (
    <>
      <dl className="projects-facts" data-testid="result-facts">
        <div><dt>Result status</dt><dd><StatusBadge status={result.status} /></dd></div>
        <div><dt>Attempt</dt><dd>{result.attempt}</dd></div>
      </dl>
      <Identifiers result={result} />
    </>
  )
}

/**
 * A result's identifiers, each said once and closed by default (L3, docs/PRD_VIEWER_UX.md 7): the session, the base and
 * output commits and the sha256 of every artifact it published other than captured files (those are the launch node's).
 */
function Identifiers({ result }: { result: WorkerResult }) {
  const artifacts = result.artifacts.filter(artifact => artifact.kind !== 'file')
  return (
    <details className="identifiers" data-testid="identifiers">
      <summary>Identifiers</summary>
      <dl className="projects-facts identifiers-facts">
        <div><dt>Session</dt><dd><code>{result.session_id}</code></dd></div>
        <div><dt>Base commit</dt><dd><code>{result.base_commit}</code></dd></div>
        <div><dt>Output commit</dt><dd>{result.output_commit ? <code>{result.output_commit}</code> : 'None recorded (no durable output commit)'}</dd></div>
      </dl>
      {artifacts.length > 0 && (
        <ul className="identifiers-artifacts" aria-label="Artifact sha256">
          {artifacts.map(artifact => <li key={artifact.artifact_id}><code>{artifact.artifact_id}</code> sha256 <code>{artifact.sha256}</code></li>)}
        </ul>
      )}
    </details>
  )
}

/** The error the result recorded, with its code; a verification's gate reasons are listed by the Gate section instead. */
export function ResultError({ result }: { result: WorkerResult }) {
  if (!result.error) return null
  return (
    <div className="projects-error" role="alert" data-testid="worker-error">
      <p><strong>Error {result.error.code}:</strong> {result.error.message}</p>
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
