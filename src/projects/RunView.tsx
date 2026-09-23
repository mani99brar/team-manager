import { useCallback, useState, type KeyboardEvent } from 'react'
import { fetchEvents, fetchRunInputs, NOT_RECORDED, orNotRecorded, type RunDetail, type RunScope, type WorkflowDefinition } from './api.ts'
import { AssignmentPanel, INPUTS_NONE_SENTENCE } from './Assignment.tsx'
import { NodeDetail } from './NodeDetail.tsx'
import { AppLink, ErrorPanel, LoadingPanel, StatusBadge } from './panels.tsx'
import { runPathname } from './routes.ts'
import { deadlinesLabel, formatTime, KIND_LABEL, RUN_STATUS_MEANING, shortRevision, STATUS_LABEL } from './status.ts'
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

type Tab = 'run' | 'assignment'
type Highlight = { nodeId: string; quote: string }
type FileFocus = { nodeId: string; path: string }

const TABS: { id: Tab; label: string; testId: string }[] = [
  { id: 'run', label: 'Run', testId: 'tab-run' },
  { id: 'assignment', label: 'Assignment', testId: 'tab-assignment' },
]

/** One run: its summary and pinned inputs, its definition graph coloured by actual node statuses, the selected node, and the assignment. */
export function RunView({ scope, detail, current, selectedNodeId, refreshToken, onNavigate }: Props) {
  const { summary, definition, snapshot } = detail
  const snapshotById = new Map(snapshot.nodes.map(node => [node.node_id, node]))
  const graphNodes: GraphNodeView[] = definition.nodes.map(node => {
    const state = snapshotById.get(node.node_id)!
    return { node_id: node.node_id, label: node.label, kind: node.kind, depends_on: node.depends_on, status: state.status, attempt: state.attempt }
  })
  const selectedDefinition = selectedNodeId === null ? null : definition.nodes.find(node => node.node_id === selectedNodeId) ?? null
  const selectedState = selectedNodeId === null ? null : snapshotById.get(selectedNodeId) ?? null

  const runKey = `${scope.projectId}/${scope.workflowId}/${scope.runId}`
  const loadEvents = useCallback((signal: AbortSignal) => fetchEvents(scope, signal), [scope])
  const { state: events, reload: reloadEvents } = useResource(`events:${runKey}`, loadEvents, refreshToken)
  // The inputs are one resource per run; a 404 INPUTS_NOT_FOUND means "not recorded", which loads as null.
  const loadInputs = useCallback((signal: AbortSignal) => orNotRecorded(fetchRunInputs(scope, signal), NOT_RECORDED.inputs), [scope])
  const { state: inputs, reload: reloadInputs } = useResource(`inputs:${runKey}`, loadInputs, refreshToken)

  const [tab, setTab] = useState<Tab>('run')
  // A requirement quote handed from a review finding to a worker's task; it applies to one node and is dropped once applied or when leaving it.
  const [pendingHighlight, setPendingHighlight] = useState<Highlight | null>(null)
  const clearHighlight = useCallback(() => setPendingHighlight(null), [])
  const highlight = pendingHighlight !== null && pendingHighlight.nodeId === selectedNodeId ? pendingHighlight.quote : null
  // A captured file handed from a review finding to the launch node that shows it, applied the same way.
  const [pendingFile, setPendingFile] = useState<FileFocus | null>(null)
  const clearFile = useCallback(() => setPendingFile(null), [])
  const fileFocus = pendingFile !== null && pendingFile.nodeId === selectedNodeId ? pendingFile.path : null

  const nodePathname = (nodeId: string | null = null) => runPathname(scope.projectId, scope.workflowId, scope.runId, nodeId)
  const selectNode = (nodeId: string) => onNavigate(nodePathname(nodeId))
  const navigateToNode = (pathname: string) => {
    setTab('run')
    onNavigate(pathname)
  }
  const openRequirement = useCallback((nodeId: string, quote: string) => {
    setPendingHighlight({ nodeId, quote })
    setTab('run')
    onNavigate(runPathname(scope.projectId, scope.workflowId, scope.runId, nodeId))
  }, [onNavigate, scope])
  const openFile = useCallback((nodeId: string, path: string) => {
    setPendingFile({ nodeId, path })
    setTab('run')
    onNavigate(runPathname(scope.projectId, scope.workflowId, scope.runId, nodeId))
  }, [onNavigate, scope])
  const definitionChanged = current !== null && current.definition_revision !== definition.definition_revision

  const onTabKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    const index = TABS.findIndex(candidate => candidate.id === tab)
    let next: number | null = null
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (index + 1) % TABS.length
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (index - 1 + TABS.length) % TABS.length
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = TABS.length - 1
    if (next === null) return
    event.preventDefault()
    setTab(TABS[next].id)
    event.currentTarget.parentElement?.querySelector<HTMLButtonElement>(`[data-testid="${TABS[next].testId}"]`)?.focus()
  }

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
        {(inputs.status === 'loading' || inputs.status === 'idle') && <LoadingPanel>Loading the run inputs…</LoadingPanel>}
        {inputs.status === 'error' && <ErrorPanel error={inputs.error} what="The run inputs" onRetry={reloadInputs} />}
        {inputs.status === 'ready' && inputs.data === null && <p className="projects-muted" data-testid="inputs-none">{INPUTS_NONE_SENTENCE}</p>}
        {inputs.status === 'ready' && inputs.data !== null && (
          <dl className="projects-facts" data-testid="run-inputs-facts">
            <div><dt>Feature</dt><dd>{inputs.data.feature}</dd></div>
            <div><dt>Base commit</dt><dd><code title={inputs.data.base_commit}>{shortRevision(inputs.data.base_commit)}</code></dd></div>
            <div><dt>Source branch</dt><dd>{inputs.data.source_branch === null ? 'None recorded' : <code>{inputs.data.source_branch}</code>}</dd></div>
            <div><dt>Mode</dt><dd>{inputs.data.mode}</dd></div>
            {inputs.data.automatic && (
              <>
                <div><dt>Deadlines</dt><dd>{deadlinesLabel(inputs.data.automatic)}</dd></div>
                <div><dt>Permission mode</dt><dd><code>{inputs.data.automatic.permission_mode}</code></dd></div>
                <div><dt>Finish</dt><dd>{inputs.data.automatic.finish}</dd></div>
              </>
            )}
          </dl>
        )}
      </section>

      <div className="tabs run-tabs" role="tablist" aria-label="Run views">
        {TABS.map(candidate => (
          <button
            key={candidate.id}
            type="button"
            role="tab"
            id={`run-tab-${candidate.id}`}
            className="tab"
            aria-selected={tab === candidate.id}
            aria-controls={`run-panel-${candidate.id}`}
            tabIndex={tab === candidate.id ? 0 : -1}
            data-testid={candidate.testId}
            onClick={() => setTab(candidate.id)}
            onKeyDown={onTabKey}
          >
            {candidate.label}
          </button>
        ))}
      </div>

      {tab === 'assignment' ? (
        <AssignmentPanel scope={scope} inputs={inputs} onRetry={reloadInputs} onNavigate={navigateToNode} panelId="run-panel-assignment" tabId="run-tab-assignment" />
      ) : (
        <div role="tabpanel" id="run-panel-run" aria-labelledby="run-tab-run" className="run-body">
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
                    <AppLink href={nodePathname(node.node_id)} onNavigate={onNavigate} className="run-node-link" current={node.node_id === selectedNodeId}>
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
                  <p><AppLink href={nodePathname()} onNavigate={onNavigate}>Back to the run</AppLink></p>
                </div>
              )}
              {selectedDefinition !== null && selectedState !== null && (
                <NodeDetail
                  key={selectedNodeId}
                  scope={scope}
                  definition={selectedDefinition}
                  definitionNodes={definition.nodes}
                  snapshotNodes={snapshot.nodes}
                  node={selectedState}
                  events={events}
                  onRetryEvents={reloadEvents}
                  inputs={inputs}
                  onRetryInputs={reloadInputs}
                  refreshToken={refreshToken}
                  onNavigate={onNavigate}
                  highlight={highlight}
                  onHighlightApplied={clearHighlight}
                  onOpenRequirement={openRequirement}
                  fileFocus={fileFocus}
                  onFileFocusApplied={clearFile}
                  onOpenFile={openFile}
                />
              )}
            </div>
          </div>
        </div>
      )}
      <p className="projects-muted run-footnote">Statuses: {Object.entries(STATUS_LABEL).map(([key, label]) => `${label} (${key})`).join(', ')}. Only a succeeded run is a completed workflow.</p>
    </div>
  )
}
