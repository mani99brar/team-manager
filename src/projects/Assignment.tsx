import { Markdown } from '../document/Markdown.tsx'
import type { RunInputs, RunScope } from './api.ts'
import { AppLink, ErrorPanel, LoadingPanel } from './panels.tsx'
import { runPathname } from './routes.ts'
import { deadlinesLabel, formatDuration, shortRevision } from './status.ts'
import type { Resource } from './useResource.ts'

type Props = {
  scope: RunScope
  inputs: Resource<RunInputs | null>
  onRetry: () => void
  onNavigate: (pathname: string) => void
  panelId: string
  tabId: string
}

export const INPUTS_NONE_SENTENCE = 'Inputs not recorded for this run (the export predates run inputs; re-export it with the workflow CLI).'

/** The Assignment tab: what the run was asked to do, pinned from its own files, with each worker's task rendered as Markdown. */
export function AssignmentPanel({ scope, inputs, onRetry, onNavigate, panelId, tabId }: Props) {
  let content: React.ReactNode
  if (inputs.status === 'loading' || inputs.status === 'idle') content = <LoadingPanel>Loading the run inputs…</LoadingPanel>
  else if (inputs.status === 'error') content = <ErrorPanel error={inputs.error} what="The run inputs" onRetry={onRetry} />
  else if (inputs.data === null) content = <p className="projects-muted" data-testid="assignment-inputs-none">{INPUTS_NONE_SENTENCE}</p>
  else {
    const data = inputs.data
    content = (
      <>
        <dl className="projects-facts">
          <div><dt>Feature</dt><dd>{data.feature}</dd></div>
          <div><dt>Source branch</dt><dd>{data.source_branch === null ? 'None recorded' : <code>{data.source_branch}</code>}</dd></div>
          <div><dt>Base commit</dt><dd><code title={data.base_commit}>{shortRevision(data.base_commit)}</code></dd></div>
          <div><dt>Mode</dt><dd>{data.mode}</dd></div>
          {data.automatic && (
            <>
              <div><dt>Deadlines</dt><dd>{deadlinesLabel(data.automatic)}</dd></div>
              <div><dt>Permission mode</dt><dd><code>{data.automatic.permission_mode}</code></dd></div>
              <div><dt>Finish</dt><dd>{data.automatic.finish}</dd></div>
              <div><dt>Reviewer transport</dt><dd data-testid="assignment-reviewer-transport">{data.automatic.reviewer_transport ?? <span className="projects-muted">not pinned (the run predates the setting)</span>}</dd></div>
            </>
          )}
          <div><dt>Attempt cap</dt><dd>{data.max_verification_attempts} per lane and phase</dd></div>
        </dl>

        <h4 id="assignment-setup-title">Setup commands</h4>
        {data.setup.length === 0 ? (
          <p className="projects-muted" data-testid="assignment-setup">No setup commands were pinned.</p>
        ) : (
          <ul className="evidence-list" data-testid="assignment-setup" aria-labelledby="assignment-setup-title">
            {data.setup.map((step, index) => (
              <li key={index}><code>{step.command}</code> <span className="projects-muted">· timeout {formatDuration(step.timeout_seconds)}</span></li>
            ))}
          </ul>
        )}

        {data.workers.map(worker => (
          <section key={worker.node_id} className="assignment-worker" data-testid="assignment-worker" data-worker={worker.node_id} aria-labelledby={`assignment-worker-${worker.node_id}`}>
            <h4 id={`assignment-worker-${worker.node_id}`}>
              Worker {worker.node_id} ({worker.role}) · launched by{' '}
              <AppLink href={runPathname(scope.projectId, scope.workflowId, scope.runId, worker.launch_node_id)} onNavigate={onNavigate}>{worker.launch_node_id}</AppLink>
            </h4>
            <div className="task-rendered" data-testid="assignment-task"><Markdown content={worker.task.text} /></div>
            {worker.task.truncated && <p className="projects-notice" role="note">The task text was truncated by the viewer API; the marker at its end says how many characters were left out.</p>}
            <h5 id={`assignment-owned-${worker.node_id}`}>Owned paths</h5>
            {worker.owned_paths.length === 0 ? <p className="projects-muted">No owned paths were pinned.</p> : (
              <ul className="evidence-list evidence-files" aria-labelledby={`assignment-owned-${worker.node_id}`}>
                {worker.owned_paths.map(path => <li key={path}><code>{path}</code></li>)}
              </ul>
            )}
            <h5 id={`assignment-checks-${worker.node_id}`}>Required checks</h5>
            {worker.checks.length === 0 ? <p className="projects-muted">No checks were required.</p> : (
              <ul className="evidence-list" aria-labelledby={`assignment-checks-${worker.node_id}`}>
                {worker.checks.map(check => (
                  <li key={check.id}>
                    <code>{check.command}</code>
                    <span className="projects-muted"> · {check.id} · {check.kind} · timeout {formatDuration(check.timeout_seconds)}</span>
                    {check.scenarios.length > 0 && (
                      <ul className="evidence-list assignment-scenarios">
                        {check.scenarios.map(scenario => <li key={scenario.id}><code>{scenario.id}</code> — {scenario.description}</li>)}
                      </ul>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        ))}
      </>
    )
  }
  return (
    <section role="tabpanel" id={panelId} aria-labelledby={tabId} className="assignment" data-testid="assignment">
      <h3>Assignment</h3>
      <p className="projects-muted">What this run was asked to do, pinned from its own plan, policy and receipts. Nothing here can be changed from the viewer.</p>
      {content}
    </section>
  )
}
