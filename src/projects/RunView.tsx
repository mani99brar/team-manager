import { useCallback } from 'react'
import { fetchEvents, type RunDetail, type RunScope, type WorkflowDefinition } from './api.ts'
import { NodeDetail } from './NodeDetail.tsx'
import { AppLink, StatusBadge } from './panels.tsx'
import { runPathname } from './routes.ts'
import { formatTime, KIND_LABEL, RUN_STATUS_MEANING, shortRevision, STATUS_LABEL } from './status.ts'
import { useResource } from './useResource.ts'
import { WorkflowGraph, type GraphNodeView } from './WorkflowGraph.tsx'

type Props = {
  scope: RunScope
  detail: RunDetail
  /** The workflow's current definition, when the workflow list loaded; used only to say whether it changed. */
  current: WorkflowDefinition | null
  selectedNodeId: string | null
  refreshToken: number
  onNavigate: (pathname: string) => void
}

/** One run: its summary, its pinned definition graph coloured by actual node statuses, and the selected node. */
export function RunView({ scope, detail, current, selectedNodeId, refreshToken, onNavigate }: Props) {
  const { summary, definition, snapshot } = detail
  const snapshotById = new Map(snapshot.nodes.map(node => [node.node_id, node]))
  const graphNodes: GraphNodeView[] = definition.nodes.map(node => {
    const state = snapshotById.get(node.node_id)!
    return { node_id: node.node_id, label: node.label, kind: node.kind, depends_on: node.depends_on, status: state.status, attempt: state.attempt }
  })
  const selectedDefinition = selectedNodeId === null ? null : definition.nodes.find(node => node.node_id === selectedNodeId) ?? null
  const selectedState = selectedNodeId === null ? null : snapshotById.get(selectedNodeId) ?? null

  const loadEvents = useCallback((signal: AbortSignal) => fetchEvents(scope, signal), [scope])
  const { state: events, reload: reloadEvents } = useResource(`events:${scope.projectId}/${scope.workflowId}/${scope.runId}`, loadEvents, refreshToken)

  const selectNode = (nodeId: string) => onNavigate(runPathname(scope.projectId, scope.workflowId, scope.runId, nodeId))
  const definitionChanged = current !== null && current.definition_revision !== definition.definition_revision

  return (
    <div className="run-view" data-testid="run-view" data-run-id={summary.run_id} data-run-status={summary.status}>
      <section className="run-summary" aria-labelledby="run-summary-title">
        <h2 id="run-summary-title">Run {summary.run_id}</h2>
        <p className="run-status-line" data-testid="run-status">
          <StatusBadge status={summary.status} /> <span data-testid="run-status-meaning">{RUN_STATUS_MEANING[summary.status]}</span>
        </p>
        <dl className="projects-facts">
          <div><dt>Created</dt><dd>{formatTime(summary.created_at)}</dd></div>
          <div><dt>Updated</dt><dd>{formatTime(summary.updated_at)}</dd></div>
          <div><dt>Last event</dt><dd>{snapshot.last_sequence === 0 ? 'none' : `sequence ${snapshot.last_sequence}`}</dd></div>
          <div>
            <dt>Pinned definition</dt>
            <dd data-testid="pinned-definition">
              {definition.name} · revision <code>{shortRevision(definition.definition_revision)}</code>
              {current === null
                ? null
                : definitionChanged
                  ? <span className="projects-warning" data-testid="definition-changed"> — the current workflow definition (revision <code>{shortRevision(current.definition_revision)}</code>) differs; this run is shown against its own pinned graph.</span>
                  : <span className="projects-muted" data-testid="definition-current"> — same as the current workflow definition.</span>}
            </dd>
          </div>
        </dl>
      </section>

      <section className="run-graph" aria-labelledby="run-graph-title">
        <h3 id="run-graph-title">Pinned graph</h3>
        <WorkflowGraph title={`Pinned definition graph of run ${summary.run_id}`} nodes={graphNodes} selectedId={selectedNodeId} onSelect={selectNode} />
        <p className="projects-muted">Keyboard: Tab or arrow keys move between nodes, Enter or Space opens a node. The list below is the same graph as text.</p>
      </section>

      <div className="run-columns">
        <nav className="run-nodes" aria-labelledby="run-nodes-title">
          <h3 id="run-nodes-title">Nodes</h3>
          <ul className="run-node-list" data-testid="run-node-list">
            {graphNodes.map(node => (
              <li key={node.node_id} data-node-id={node.node_id} data-status={node.status}>
                <AppLink href={runPathname(scope.projectId, scope.workflowId, scope.runId, node.node_id)} onNavigate={onNavigate} className="run-node-link" current={node.node_id === selectedNodeId}>
                  <span className="run-node-label">{node.label}</span>
                  <span className="run-node-meta">
                    <StatusBadge status={node.status!} /> {KIND_LABEL[node.kind]} · attempt {node.attempt}
                  </span>
                </AppLink>
              </li>
            ))}
          </ul>
        </nav>

        <div className="run-detail-panel">
          {selectedNodeId === null && (
            <p className="projects-muted" data-testid="node-hint">Select a node in the graph or the list to inspect its attempts, result, evidence and events.</p>
          )}
          {selectedNodeId !== null && (selectedDefinition === null || selectedState === null) && (
            <div className="projects-error" role="alert" data-testid="node-missing">
              <p>Node <code>{selectedNodeId}</code> is not part of this run's pinned definition.</p>
              <p><AppLink href={runPathname(scope.projectId, scope.workflowId, scope.runId)} onNavigate={onNavigate}>Back to the run</AppLink></p>
            </div>
          )}
          {selectedDefinition !== null && selectedState !== null && (
            <NodeDetail scope={scope} definition={selectedDefinition} node={selectedState} events={events} onRetryEvents={reloadEvents} refreshToken={refreshToken} />
          )}
        </div>
      </div>
      <p className="projects-muted run-footnote">Statuses: {Object.entries(STATUS_LABEL).map(([key, label]) => `${label} (${key})`).join(', ')}. Only a succeeded run is a completed workflow.</p>
    </div>
  )
}
