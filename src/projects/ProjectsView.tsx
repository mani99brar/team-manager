import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Breadcrumbs, type PathCrumb } from '../graph/Breadcrumbs.tsx'
import type { ControllerReading } from '../../contracts/projects/triage.ts'
import {
  describeApiError, fetchProjects, fetchRegistryRuns, fetchRunDetail, fetchRuns, fetchWorkflowRuns, fetchWorkflows, ProjectsApiError,
  type RunPage, type RunSummary,
} from './api.ts'
import { latestFeature, LISTS_POLL_MS, readsNextPage, RECENT_WINDOW_MS, recordReading, workflowTitle, type ServedRun } from './lists.ts'
import './theme.css'
import './lists.css'
import { ServedRunContext } from './LiveStatus.tsx'
import { AppLink, EmptyPanel, ErrorPanel, LoadingPanel } from './panels.tsx'
import { projectPathname, projectsPathname, runPathname, workflowPathname, type ProjectsRoute } from './routes.ts'
import { RunRow } from './RunRow.tsx'
import { ProjectRunGroups, RunsHome } from './RunsHome.tsx'
import { RunView } from './RunView.tsx'
import { shortRevision } from './status.ts'
import { Time } from './Time.tsx'
import { TimeReferenceContext, useNow } from './useNow.ts'
import { usePoll } from './usePoll.ts'
import { useResource } from './useResource.ts'
import { WorkflowGraph } from './WorkflowGraph.tsx'

const LOADING_FAILED = 'Loading failed.'

type Props = {
  /** Null when the pathname is under /projects but malformed. */
  route: ProjectsRoute | null
  refreshToken: number
  /** Whether a header Refresh is still loading in the background, for the button's busy state. */
  onRefreshingChange: (refreshing: boolean) => void
  onNavigate: (pathname: string) => void
  onAnnounce: (message: string) => void
}

/**
 * The Projects root: registered projects, their workflow definitions and runs, read-only. Every level
 * loads from the scoped API and shows loading, empty, not-found and failure states in place; nothing
 * is ever substituted from fixtures.
 */
export function ProjectsView({ route, refreshToken, onRefreshingChange, onNavigate, onAnnounce }: Props) {
  const projectId = route && route.level !== 'projects' ? route.projectId : null
  const workflowId = route && (route.level === 'workflow' || route.level === 'run') ? route.workflowId : null
  const runId = route && route.level === 'run' ? route.runId : null
  const nodeId = route && route.level === 'run' ? route.nodeId : null
  const attempt = route && route.level === 'run' ? route.attempt ?? null : null

  // The registry itself changes while the viewer runs (a launch registers its workflow); both lists are cheap to re-read.
  const registryPoll = usePoll(route?.level === 'projects' || route?.level === 'project')
  const { state: projects, reload: reloadProjects, meta: projectsMeta } = useResource('projects', fetchProjects, refreshToken, registryPoll)
  const loadWorkflows = useCallback((signal: AbortSignal) => fetchWorkflows(projectId!, signal), [projectId])
  const { state: workflows, reload: reloadWorkflows, meta: workflowsMeta } = useResource(projectId === null ? null : `workflows:${projectId}`, loadWorkflows, refreshToken, registryPoll)
  const loadRuns = useCallback((signal: AbortSignal) => fetchRuns(projectId!, workflowId!, {}, signal), [projectId, workflowId])
  const runsKey = workflowId === null ? null : `runs:${projectId}/${workflowId}`
  // Run lists and run details re-read themselves while shown (a finished run no longer changes). A list stops polling
  // while it loads or shows appended pages, since a new first page would drop them.
  const [morePages, setMorePages] = useState<{ base: RunPage | null; pages: RunPage[]; loading: boolean; error: unknown }>({ base: null, pages: [], loading: false, error: null })
  const [finished, setFinished] = useState(false)
  // Appended pages belong to one list generation (this workflow, this Refresh); a new one starts without them.
  const listGeneration = `${runsKey}\u0000${refreshToken}`
  useEffect(() => { setMorePages({ base: null, pages: [], loading: false, error: null }) }, [listGeneration])
  const listPoll = usePoll(route?.level === 'workflow' && !morePages.loading && morePages.pages.length === 0)
  const runPoll = usePoll(route?.level === 'run' && !finished)
  const { state: firstPage, reload: reloadRuns, meta: runsMeta } = useResource(runsKey, loadRuns, refreshToken, listPoll)
  const scope = useMemo(() => (projectId === null || workflowId === null || runId === null ? null : { projectId, workflowId, runId }), [projectId, workflowId, runId])
  const loadDetail = useCallback((signal: AbortSignal) => fetchRunDetail({ projectId: projectId!, workflowId: workflowId!, runId: runId! }, signal), [projectId, workflowId, runId])
  const { state: detail, reload: reloadDetail, meta: detailMeta } = useResource(scope === null ? null : `run:${scope.projectId}/${scope.workflowId}/${scope.runId}`, loadDetail, refreshToken, runPoll)
  const detailStatus = detail.status === 'ready' ? detail.data.summary.status : null
  useEffect(() => { setFinished(detailStatus === 'succeeded' || detailStatus === 'cancelled') }, [detailStatus])

  // The lists (docs/PRD_VIEWER_UX.md 4.1) read run lists only, never a run detail, and re-read them every 15 s. Runs home
  // reads every project's workflows and each workflow's run pages back to the Recent cutoff; the project page reads the
  // first page of each of its workflows.
  const listClock = useNow(route?.level === 'projects' || route?.level === 'project' || route?.level === 'workflow', LISTS_POLL_MS)
  const projectsData = projects.status === 'ready' ? projects.data : null
  const homePoll = usePoll(route?.level === 'projects', LISTS_POLL_MS)
  const loadHome = useCallback((signal: AbortSignal) => {
    const cutoff = Date.now() - RECENT_WINDOW_MS
    return fetchRegistryRuns(projectsData ?? [], (runs, cursor) => readsNextPage(runs, cursor, cutoff), signal)
  }, [projectsData])
  const homeKey = route?.level === 'projects' && projectsData !== null ? `home:${projectsData.map(project => project.project_id).join('\u0000')}` : null
  const { state: homeRuns, meta: homeMeta } = useResource(homeKey, loadHome, refreshToken, homePoll)
  const workflowsData = workflows.status === 'ready' ? workflows.data : null
  const projectRunsPoll = usePoll(route?.level === 'project', LISTS_POLL_MS)
  const loadProjectRuns = useCallback((signal: AbortSignal) => fetchWorkflowRuns(projectId!, workflowsData ?? [], () => false, signal), [projectId, workflowsData])
  const projectRunsKey = route?.level === 'project' && workflowsData !== null ? `project-runs:${projectId}:${workflowsData.map(workflow => workflow.workflow_id).join('\u0000')}` : null
  const { state: projectRuns, meta: projectRunsMeta } = useResource(projectRunsKey, loadProjectRuns, refreshToken, projectRunsPoll)

  // What the run page reads beyond its export (B2, B3): the served activity and run directory, and the controller reading of
  // every poll, so the live chip and the Now banner believe `not_running` only once it has held for 15 s (6.3).
  const runKey = scope === null ? null : `${scope.projectId}/${scope.workflowId}/${scope.runId}`
  const detailData = detail.status === 'ready' ? detail.data : null
  const controllerValue = detailData?.summary.activity?.controller ?? null
  const [readings, setReadings] = useState<{ key: string | null; list: ControllerReading[] }>({ key: null, list: [] })
  useEffect(() => {
    if (runKey === null || detailMeta.settledAt === null) return
    const reading: ControllerReading = { at: new Date(detailMeta.settledAt).toISOString(), value: controllerValue }
    setReadings(previous => ({ key: runKey, list: recordReading(previous.key === runKey ? previous.list : [], reading) }))
  }, [runKey, detailMeta.settledAt, controllerValue])
  const controllerReadings = readings.key === runKey ? readings.list : null
  const served: ServedRun | null = useMemo(() => (detailData === null ? null : {
    detail: detailData, activity: detailData.summary.activity ?? null, runDir: detailData.run_dir ?? null, controller: controllerReadings ?? [],
  }), [detailData, controllerReadings])

  // A Refresh re-reads every shown level in the background; the header button stays busy until they have all settled.
  const refreshing = projectsMeta.refreshing || workflowsMeta.refreshing || runsMeta.refreshing || detailMeta.refreshing || homeMeta.refreshing || projectRunsMeta.refreshing
  useEffect(() => { onRefreshingChange(refreshing) }, [refreshing, onRefreshingChange])
  useEffect(() => () => onRefreshingChange(false), [onRefreshingChange])
  // A failed Refresh keeps the page as it was, so it says so until a later load of that level succeeds.
  const refreshFailure = [detailMeta, runsMeta, workflowsMeta, projectsMeta].find(meta => meta.refreshError !== null) ?? null
  const refreshFailed = refreshFailure !== null

  // Additional run pages are appended on demand; they belong to exactly one loaded first page and are dropped with it.
  const firstPageData = firstPage.status === 'ready' ? firstPage.data : null
  const extra = morePages.base !== null && morePages.base === firstPageData ? morePages : { base: firstPageData, pages: [], loading: false, error: null }
  const pages: RunPage[] = firstPageData ? [firstPageData, ...extra.pages] : []
  const runs: RunSummary[] = pages.flatMap(page => page.runs)
  const nextCursor = pages.length ? pages[pages.length - 1].nextCursor : null
  const loadMore = async () => {
    if (!nextCursor || projectId === null || workflowId === null || firstPageData === null) return
    setMorePages({ ...extra, base: firstPageData, loading: true, error: null })
    try {
      const page = await fetchRuns(projectId, workflowId, { cursor: nextCursor })
      setMorePages(previous => (previous.base === firstPageData ? { ...previous, pages: [...previous.pages, page], loading: false } : previous))
    } catch (error) {
      setMorePages(previous => (previous.base === firstPageData ? { ...previous, loading: false, error } : previous))
    }
  }

  const projectName = projects.status === 'ready' && projectId !== null ? projects.data.find(project => project.project_id === projectId)?.name ?? projectId : projectId
  const currentWorkflow = workflows.status === 'ready' && workflowId !== null ? workflows.data.find(workflow => workflow.workflow_id === workflowId) ?? null : null
  const labels = useMemo(() => new Map((currentWorkflow?.nodes ?? []).map(node => [node.node_id, node.label])), [currentWorkflow])
  // The workflow title rule (docs/PRD_VIEWER_UX.md 4.1): a workflow under the exporter's generic name is named by its latest
  // run's feature, else by its id. A run page names it by its own run's feature, the only run it reads.
  const titleFeature = route?.level === 'run' ? detailData?.summary.activity?.feature ?? null : latestFeature(runs)
  const workflowName = currentWorkflow ? workflowTitle(currentWorkflow, titleFeature) : workflowId

  // A background poll re-announces only what changed; a load the reader started (navigation, Refresh) always announces.
  // A Refresh announces that it started and then its outcome, even when the page did not change.
  const announced = useRef<string | null>(null)
  const refreshAnnounced = useRef(false)
  useEffect(() => {
    if (refreshing) {
      if (!refreshAnnounced.current) onAnnounce('Refreshing.')
      refreshAnnounced.current = true
      return
    }
    let message: string | null = null
    if (route === null) message = 'This Projects link is invalid.'
    else if (route.level === 'projects' && projects.status === 'ready') message = `Loaded ${projects.data.length} ${projects.data.length === 1 ? 'project' : 'projects'}.`
    else if (route.level === 'project' && workflows.status === 'ready') message = `Loaded ${workflows.data.length} ${workflows.data.length === 1 ? 'workflow' : 'workflows'} for ${projectName ?? route.projectId}.`
    else if (route.level === 'workflow' && firstPage.status === 'ready') message = `Loaded ${firstPage.data.runs.length} ${firstPage.data.runs.length === 1 ? 'run' : 'runs'} for ${workflowName ?? route.workflowId}.`
    else if (route.level === 'run' && detail.status === 'ready') message = `Loaded run ${route.runId}: ${detail.data.summary.status.replace('_', ' ')}.`
    else if ((projects.status === 'error') || workflows.status === 'error' || firstPage.status === 'error' || detail.status === 'error') message = LOADING_FAILED
    if (refreshAnnounced.current) {
      refreshAnnounced.current = false
      announced.current = message
      if (refreshFailed) onAnnounce('Refresh failed. The page still shows the data loaded before, which may be outdated.')
      else if (message === LOADING_FAILED) onAnnounce('Refresh failed.')
      else onAnnounce(message === null ? 'Refreshed.' : `Refreshed. ${message}`)
      return
    }
    if (message === null) { announced.current = null; return }
    if (message === announced.current) return
    announced.current = message
    onAnnounce(message)
  }, [route, projects, workflows, firstPage, detail, projectName, workflowName, refreshing, refreshFailed, onAnnounce])

  // The Projects trail starts at Projects (the roots strip leads Home) and ends at the node a node page shows.
  const crumbs: PathCrumb[] = [{ id: 'projects', label: 'Projects', pathname: projectsPathname() }]
  if (projectId !== null) crumbs.push({ id: `project:${projectId}`, label: projectName ?? projectId, pathname: projectPathname(projectId) })
  if (projectId !== null && workflowId !== null) crumbs.push({ id: `workflow:${workflowId}`, label: workflowName ?? workflowId, pathname: workflowPathname(projectId, workflowId) })
  if (projectId !== null && workflowId !== null && runId !== null) crumbs.push({ id: `run:${runId}`, label: runId, pathname: runPathname(projectId, workflowId, runId) })
  if (projectId !== null && workflowId !== null && runId !== null && nodeId !== null) {
    const node = detail.status === 'ready' ? detail.data.definition.nodes.find(candidate => candidate.node_id === nodeId) : undefined
    crumbs.push({ id: `node:${nodeId}`, label: node?.label ?? nodeId, pathname: runPathname(projectId, workflowId, runId, nodeId) })
  }
  if (route === null) crumbs.push({ id: 'invalid', label: 'Invalid link' })

  const notFound = (error: unknown) => error instanceof ProjectsApiError && error.notFound

  // The read-only note is said once, on the Projects root (docs/PRD_VIEWER_UX.md 3.2); each command block repeats it in one line.
  const info = route?.level === 'projects' ? 'Read-only: runs are started, answered and approved in the workflow CLI, never from this page.' : null

  const busy = projects.status === 'loading' || workflows.status === 'loading' || firstPage.status === 'loading' || detail.status === 'loading'

  let content: React.ReactNode
  if (route === null) {
    content = (
      <div className="projects-error" role="alert">
        <p>This Projects link is invalid and could not be read. Links look like /projects/&lt;project&gt;/workflows/&lt;workflow&gt;/runs/&lt;run&gt;.</p>
        <p className="projects-actions"><AppLink href={projectsPathname()} onNavigate={onNavigate}>Go to Projects</AppLink></p>
      </div>
    )
  } else if (route.level === 'projects') {
    if (projects.status === 'loading' || projects.status === 'idle') content = <LoadingPanel>Loading registered projects…</LoadingPanel>
    else if (projects.status === 'error') content = <ErrorPanel error={projects.error} what="The project list" onRetry={reloadProjects} />
    else if (projects.data.length === 0) {
      content = (
        <EmptyPanel title="No projects are registered." testId="empty-projects">
          <p>The backend's project registry is empty. Projects are registered by the operator in the server configuration, not from this page.</p>
        </EmptyPanel>
      )
    } else content = <RunsHome projects={projects.data} runs={homeRuns} meta={homeMeta} now={listClock} onNavigate={onNavigate} />
  } else if (route.level === 'project') {
    if (workflows.status === 'loading' || workflows.status === 'idle') content = <LoadingPanel>Loading workflows of {projectName}…</LoadingPanel>
    else if (workflows.status === 'error' && notFound(workflows.error)) {
      content = (
        <div className="projects-error" role="alert" data-testid="not-found">
          <p><strong>Project “{route.projectId}” is not registered.</strong> The API has no project with this ID; it may have been removed from the registry or the link may be wrong.</p>
          <p className="projects-actions"><AppLink href={projectsPathname()} onNavigate={onNavigate}>Go to Projects</AppLink></p>
        </div>
      )
    } else if (workflows.status === 'error') content = <ErrorPanel error={workflows.error} what={`The workflows of ${projectName}`} onRetry={reloadWorkflows} />
    else if (workflows.data.length === 0) {
      content = (
        <EmptyPanel title={`${projectName} has no workflow definitions.`} testId="empty-workflows">
          <p>The project is registered but no workflow is configured for it, so there is nothing to run or inspect here.</p>
        </EmptyPanel>
      )
    } else {
      content = (
        <section aria-labelledby="workflows-title">
          <h2 id="workflows-title">{projectName}: features</h2>
          <ProjectRunGroups projectId={route.projectId} workflows={workflows.data} runs={projectRuns} now={listClock} onNavigate={onNavigate} />
        </section>
      )
    }
  } else if (route.level === 'workflow') {
    if (firstPage.status === 'loading' || firstPage.status === 'idle') content = <LoadingPanel>Loading runs of {workflowName}…</LoadingPanel>
    else if (firstPage.status === 'error' && notFound(firstPage.error)) {
      content = (
        <div className="projects-error" role="alert" data-testid="not-found">
          <p><strong>Workflow “{route.workflowId}” was not found in project “{route.projectId}”.</strong> Either the project is not registered or this workflow does not belong to it.</p>
          <p className="projects-actions">
            <AppLink href={projectPathname(route.projectId)} onNavigate={onNavigate}>Go to the project</AppLink>
            <AppLink href={projectsPathname()} onNavigate={onNavigate}>Go to Projects</AppLink>
          </p>
        </div>
      )
    } else if (firstPage.status === 'error') content = <ErrorPanel error={firstPage.error} what={`The runs of ${workflowName}`} onRetry={reloadRuns} />
    else {
      content = (
        <div className="workflow-view">
          <section aria-labelledby="runs-title">
            <h2 id="runs-title">{workflowName}: runs</h2>
            {runs.length === 0 ? (
              <EmptyPanel title="No runs have been recorded for this workflow." testId="empty-runs">
                <p>The workflow definition exists (see its current graph below) but it has never been run, or its runs are stored elsewhere. Runs are started from the workflow CLI.</p>
              </EmptyPanel>
            ) : (
              <ul className="run-rows run-list" data-testid="run-list">
                {runs.map(run => (
                  <RunRow key={run.run_id} run={run} labels={labels} now={listClock} onNavigate={onNavigate} href={runPathname(route.projectId, route.workflowId, run.run_id)} />
                ))}
              </ul>
            )}
            {nextCursor && (
              <div className="projects-actions">
                <button type="button" className="button" onClick={() => void loadMore()} disabled={extra.loading} aria-busy={extra.loading}>
                  {extra.loading ? 'Loading more runs…' : 'Load more runs'}
                </button>
              </div>
            )}
            {extra.error !== null && <ErrorPanel error={extra.error} what="The next page of runs" onRetry={() => void loadMore()} />}
          </section>
          <section aria-label="Current definition" className="workflow-definition">
            {workflows.status === 'loading' && <LoadingPanel>Loading the current definition…</LoadingPanel>}
            {workflows.status === 'error' && <ErrorPanel error={workflows.error} what="The current definition" onRetry={reloadWorkflows} />}
            {workflows.status === 'ready' && currentWorkflow === null && <p className="projects-error-inline" role="alert">The workflow list does not contain “{route.workflowId}”, so its current definition cannot be shown.</p>}
            {currentWorkflow && (
              // Folded away below the runs while there are any (docs/PRD_VIEWER_UX.md 4.1); open when the workflow never ran.
              <details className="lists-definition" data-testid="current-definition" open={runs.length === 0}>
                <summary>
                  <h3 id="definition-title">Current definition</h3>
                  <span className="projects-muted">{currentWorkflow.name} · revision <code>{shortRevision(currentWorkflow.definition_revision)}</code> · {currentWorkflow.nodes.length} nodes</span>
                </summary>
                <p className="projects-muted">Runs started before a definition change keep their own pinned graph.</p>
                <WorkflowGraph title={`Current definition graph of ${currentWorkflow.name}`} nodes={currentWorkflow.nodes} selectedId={null} />
              </details>
            )}
          </section>
        </div>
      )
    }
  } else {
    const loading = detail.status === 'loading' || detail.status === 'idle'
    if (loading) content = <LoadingPanel>Loading run {route.runId}…</LoadingPanel>
    else if (detail.status === 'error' && notFound(detail.error)) {
      content = (
        <div className="projects-error" role="alert" data-testid="not-found">
          <p><strong>Run “{route.runId}” was not found in workflow “{route.workflowId}” of project “{route.projectId}”.</strong> Runs are only served under the project and workflow they belong to; a run of another project is not shown here.</p>
          <p className="projects-actions">
            <AppLink href={workflowPathname(route.projectId, route.workflowId)} onNavigate={onNavigate}>Go to the workflow's runs</AppLink>
            <AppLink href={projectsPathname()} onNavigate={onNavigate}>Go to Projects</AppLink>
          </p>
        </div>
      )
    } else if (detail.status === 'error') content = <ErrorPanel error={detail.error} what={`Run ${route.runId}`} onRetry={reloadDetail} />
    else {
      // Every time on the run page reads against the run's start day: only a time on another day shows its date. The start
      // itself (the Created fact) is read against today, so the page names the day its run started.
      content = (
        <TimeReferenceContext value={detail.data.summary.created_at}>
          <ServedRunContext value={served}>
          <RunView
            key={`${route.projectId}/${route.workflowId}/${route.runId}`}
            scope={scope!}
            detail={detail.data}
            current={currentWorkflow}
            selectedNodeId={nodeId}
            selectedAttempt={attempt}
            tab={route.tab}
            refreshToken={refreshToken}
            pollToken={runPoll}
            freshness={detailMeta}
            onNavigate={onNavigate}
            onAnnounce={onAnnounce}
          />
          </ServedRunContext>
        </TimeReferenceContext>
      )
    }
  }

  return (
    <>
      <div className="navigation">
        <Breadcrumbs custom={{ crumbs, onNavigate }} selected={null} index={null} onNavigate={() => undefined} />
        {info !== null && <p className="folder-info" data-testid="projects-info">{info}</p>}
      </div>
      <main className="workspace workspace-projects" aria-busy={busy} data-testid="projects-workspace">
        {refreshFailure !== null && (
          <div className="projects-notice" role="alert" data-testid="refresh-failed">
            <p>
              <strong>Refresh failed.</strong> {describeApiError(refreshFailure.refreshError)} The page still shows the data loaded
              {refreshFailure.settledAt === null ? ' before' : <> at <Time iso={new Date(refreshFailure.settledAt).toISOString()} seconds /></>}, which may be outdated.
            </p>
          </div>
        )}
        {content}
      </main>
    </>
  )
}
