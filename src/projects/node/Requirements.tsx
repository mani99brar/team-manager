import type { RunInputWorker, WorkerResult } from '../api.ts'
import { AppLink } from '../panels.tsx'
import { formatDuration } from '../status.ts'
import type { Resource } from '../useResource.ts'

/** Where a check id named by the worker is shown: the verify node, and the executed check it matched by command when known. */
export type CheckTarget = { href: string; label: string }

/** The paths the lane may change, as pinned in the run plan. */
export function OwnedPaths({ paths }: { paths: RunInputWorker['owned_paths'] }) {
  return (
    <>
      <h5 id="task-owned-title">Owned paths</h5>
      {paths.length === 0 ? (
        <p className="projects-muted">No owned paths were pinned.</p>
      ) : (
        <ul className="evidence-list evidence-files" data-testid="task-owned-paths" aria-labelledby="task-owned-title">
          {paths.map(path => <li key={path}><code>{path}</code></li>)}
        </ul>
      )}
    </>
  )
}

/**
 * The lane's required checks: the check kinds it must pass and each declared check, matched to the executed checks of the
 * published result by exact command; a match links to the verify node that shows the check with its log.
 */
export function RequiredChecks({ worker, result, checksNode, onNavigate }: {
  worker: RunInputWorker
  /** The node's published result, when it loaded: required checks are matched to executed checks by exact command. */
  result: Resource<WorkerResult>
  /** The verify node that shows the executed checks with their logs; null when the pinned graph has none. */
  checksNode: CheckTarget | null
  onNavigate: (pathname: string) => void
}) {
  const executed = result.status === 'ready' ? result.data.checks : null
  return (
    <>
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
    </>
  )
}
