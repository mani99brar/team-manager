import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Breadcrumbs, type PathCrumb } from '../graph/Breadcrumbs.tsx'
import type { ControllerReading } from '../../contracts/projects/triage.ts'
import {
  describeApiError, fetchHomeRuns, fetchProjects, fetchReviewResult, fetchRunDetail, fetchRuns, fetchWorkflowRuns, fetchWorkflows, ProjectsApiError,
  type RunPage, type RunSummary,
} from './api.ts'
import { classifyRuns, classOf, endedAt, isFinished, laneNamesOf, latestFeature, LISTS_POLL_MS, listsPollMs, RECENT_WINDOW_MS, recordHomeReadings, recordReading, registryKey, reviewStepsOf, stoppedRunKeys, sortRuns, unreadRunsText, workflowTitle, type ServedRun } from './lists.ts'
import { FilterBar, NoMatch } from './FilterBar.tsx'
import { useListState } from './dispatch/listState.ts'
import { cappedScopeLine, filterItems, scopeLine, statusCounts } from './runFilter.ts'
import './theme.css'
import './lists.css'
import { ServedRunContext } from './LiveStatus.tsx'
import { AppLink, EmptyPanel, ErrorPanel, LoadingPanel } from './panels.tsx'
import { MAX_LIST_PAGES, parseTeamQuery, projectPathname, projectsPathname, routeToPathname, runPathname, splitHref, teamQuerySearch, triagePathname, workflowPathname, type ProjectsRoute, type TeamQuery, type TeamQueryMode } from './routes.ts'
import { PinToggle, RunRow } from './RunRow.tsx'
import { RunsHome } from './RunsHome.tsx'
import { fetchDispatchOverview } from './dispatch/client.ts'
import { fetchProjectSteps } from './dispatch/client.ts'
import { Rail, type RailRow } from './dispatch/Rail.tsx'
import { ProjectsPage, type CardData } from './dispatch/ProjectsPage.tsx'
import { ProjectPage, type RunsState } from './dispatch/ProjectPage.tsx'
import { FAILED_RUN_INFO, projectRunInfo } from './dispatch/projectModel.ts'
import { everyRunListFailed, railBadge, railBadgeTone, railOrder, type RailInfo } from './dispatch/derive.ts'
import { dateOnly } from './dispatch/format.ts'
import './dispatch/dispatch.css'
import { RunView } from './RunView.tsx'
import { OVERRIDE_LABEL, shortRevision, STATUS_LABEL } from './status.ts'
import { STATUS_GLYPH } from './steps.ts'
import { Time } from './Time.tsx'
import { stateTone, toneClass, TONE_LABEL } from './tone.ts'
import { Chip, Section } from './ui/index.tsx'
import { TimeReferenceContext, useNow, useTimeZone } from './useNow.ts'
import { POLL_INTERVAL_MS, usePoll } from './usePoll.ts'
import { useResource } from './useResource.ts'
import { WorkflowGraph } from './WorkflowGraph.tsx'

const LOADING_FAILED = 'Loading failed.'

/** The feature page's order in words: its sub-header and the run history's name. */
const FEATURE_ORDER = {
  live: { sub: 'needs you and running first, then latest activity', history: 'needs you and running first' },
  newest: { sub: 'newest created first', history: 'newest created first' },
  oldest: { sub: 'oldest created first', history: 'oldest created first' },
} as const

type Props = {
  /** Null when the pathname is under /projects but malformed. */
  route: ProjectsRoute | null
  refreshToken: number
  /** Whether a header Refresh is still loading in the background, for the button's busy state. */
  onRefreshingChange: (refreshing: boolean) => void
  onNavigate: (pathname: string) => void
  onAnnounce: (message: string) => void
  /** The URL's search on this Projects pathname: the shown list's state (filters, sort, grouping, loaded pages). */
  search?: string
  /** Replaces the current entry's search with a list's new state (no new history entry). */
  onSearch?: (pathname: string, search: string) => void
  /**
   * Pushes a new history entry for the same pathname with another search: the Team view's agent drawer opens this way, so
   * Back closes it (docs/PRD_RUN_TEAMS.md 2). Without it the selection replaces the current entry's search.
   */
  onPushSearch?: (pathname: string, search: string) => void
  /** The scroll position and opened folds recorded in the history entry Back returned to, once per return. */
  restore?: { key: string; memory: ListMemory } | null
  /** Reports the shown list's opened folds, so they are recorded in its history entry when the operator leaves. */
  onFolds?: (folds: Record<string, boolean>) => void
  /** Registers the shown list's flush of a pending search, so a link outside the list (a root) writes it before leaving. */
  onFlush?: (flush: (() => void) | null) => void
}

/** What a list's history entry keeps for Back within the page session: its scroll position and its opened folds. */
export type ListMemory = { scroll: number; folds: Record<string, boolean> }

const NO_SEARCH = () => undefined

/**
 * The Projects root: registered projects, their workflow definitions and runs, read-only. Every level
 * loads from the scoped API and shows loading, empty, not-found and failure states in place; nothing
 * is ever substituted from fixtures.
 */
export function ProjectsView({ route, refreshToken, onRefreshingChange, onNavigate: navigateTo, onAnnounce, search = '', onSearch = NO_SEARCH, onPushSearch, restore = null, onFolds = NO_SEARCH, onFlush = NO_SEARCH }: Props) {
  // The shown list's state lives in the URL; a search still being typed is written before the operator leaves the list.
  const pagePath = route === null ? null : routeToPathname(route)
  const list = useListState(search, pagePath, onSearch)
  const flushList = list.flush
  // An href with a search (a link into the Team view with its selection, `/team?session=worker:ui`) navigates to its pathname
  // and then writes the search into the entry it arrived at; every other href is a pathname, as before.
  const onNavigate = useCallback((href: string) => {
    flushList()
    const { pathname, search: hrefSearch } = splitHref(href)
    navigateTo(pathname)
    if (hrefSearch !== '') onSearch(pathname, hrefSearch)
  }, [flushList, navigateTo, onSearch])
  // The Team view's selection lives in the URL's search (docs/PRD_RUN_TEAMS.md 2): opening an agent pushes, filters replace.
  const teamQuery: TeamQuery | undefined = useMemo(() => (route?.level === 'run' && route.tab === 'team' ? parseTeamQuery(search) : undefined), [route, search])
  const onTeamQuery = useCallback((query: TeamQuery, mode: TeamQueryMode) => {
    if (pagePath === null) return
    const next = teamQuerySearch(query)
    if (mode === 'push' && onPushSearch) onPushSearch(pagePath, next)
    else onSearch(pagePath, next)
  }, [pagePath, onPushSearch, onSearch])
  useEffect(() => {
    onFlush(flushList)
    return () => onFlush(null)
  }, [onFlush, flushList])
  // The opened folds of the shown list (the project page's features, Paused's "Show all", the superseded fold): a new page
  // starts with none, a return through Back with the ones its entry recorded.
  const [foldState, setFoldState] = useState<{ path: string | null; folds: Record<string, boolean> }>(() => ({ path: pagePath, folds: restore?.memory.folds ?? {} }))
  if (foldState.path !== pagePath) setFoldState({ path: pagePath, folds: restore?.memory.folds ?? {} })
  const folds = foldState.folds
  const setFold = useCallback((key: string, open: boolean | null) => setFoldState(previous => {
    const next = { ...previous.folds }
    if (open === null) delete next[key]
    else next[key] = open
    return { ...previous, folds: next }
  }), [])
  const clearFolds = useCallback((prefix: string) => setFoldState(previous => ({ ...previous, folds: Object.fromEntries(Object.entries(previous.folds).filter(([key]) => !key.startsWith(prefix))) })), [])
  useEffect(() => { onFolds(folds) }, [folds, onFolds])

  const projectId = route && route.level !== 'projects' && route.level !== 'triage' ? route.projectId : null
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
  // A failed run can still be repaired or resumed, so it is re-read, at the lists' slower cadence (the live chip's stale
  // threshold follows that cadence, LiveStatus).
  const [runFailed, setRunFailed] = useState(false)
  const runPoll = usePoll(route?.level === 'run' && !finished, runFailed ? LISTS_POLL_MS : POLL_INTERVAL_MS)
  const { state: firstPage, reload: reloadRuns, meta: runsMeta } = useResource(runsKey, loadRuns, refreshToken, listPoll)
  const scope = useMemo(() => (projectId === null || workflowId === null || runId === null ? null : { projectId, workflowId, runId }), [projectId, workflowId, runId])
  const loadDetail = useCallback((signal: AbortSignal) => fetchRunDetail({ projectId: projectId!, workflowId: workflowId!, runId: runId! }, signal), [projectId, workflowId, runId])
  const { state: detail, reload: reloadDetail, meta: detailMeta } = useResource(scope === null ? null : `run:${scope.projectId}/${scope.workflowId}/${scope.runId}`, loadDetail, refreshToken, runPoll)
  const detailStatus = detail.status === 'ready' ? detail.data.summary.status : null
  useEffect(() => { setRunFailed(detailStatus === 'failed') }, [detailStatus])
  useEffect(() => { setFinished(detailStatus === 'succeeded' || detailStatus === 'cancelled') }, [detailStatus])

  // The lists (docs/PRD_VIEWER_UX.md 4.1) read run lists only, never a run detail, and re-read them every 15 s. Runs home
  // reads every project's workflows and each workflow's run pages back to the Recent cutoff; the project page reads the
  // first page of each of its workflows.
  // The rail and the Projects cards show state for every project; it is loaded whenever the rail is shown (the Projects page,
  // Triage, the project page and the workflow page), not only on the Projects root ([D6], [O2]).
  const railLevel = route?.level === 'projects' || route?.level === 'triage' || route?.level === 'project' || route?.level === 'workflow'
  const [zone] = useTimeZone()
  const listClock = useNow(railLevel, LISTS_POLL_MS)
  const projectsData = projects.status === 'ready' ? projects.data : null
  // One request reads every project's runs back to the Recent cutoff (the registry home read); it and the overview poll every
  // 15 s while any row read runs or needs the operator, else every 60 s. The key never carries the cadence, so the last rows
  // stay shown while a poll reads.
  const [homeCadence, setHomeCadence] = useState(LISTS_POLL_MS)
  const homePoll = usePoll(railLevel, homeCadence)
  const loadHome = useCallback((signal: AbortSignal) => fetchHomeRuns(projectsData ?? [], Date.now() - RECENT_WINDOW_MS, signal), [projectsData])
  const homeKey = railLevel && projectsData !== null ? `home:${projectsData.map(project => project.project_id).join('\u0000')}` : null
  const { state: homeRuns, meta: homeMeta } = useResource(homeKey, loadHome, refreshToken, homePoll)
  const homeRows = homeRuns.status === 'ready' ? homeRuns.data : null
  useEffect(() => {
    if (homeRows !== null) setHomeCadence(listsPollMs(homeRows.flatMap(entry => entry.workflows.flatMap(item => item.runs))))
  }, [homeRows])
  // The dispatch overview (git and GitHub per project) for the rail badges, the cards and the project page; at the home read's cadence.
  const overviewPoll = usePoll(railLevel, homeCadence)
  const { state: overview, meta: overviewMeta } = useResource(railLevel ? 'dispatch-overview' : null, fetchDispatchOverview, refreshToken, overviewPoll)
  const overviewData = overview.status === 'ready' ? overview.data : null
  // The project page's step chart, one read per project.
  const stepsPoll = usePoll(route?.level === 'project', LISTS_POLL_MS)
  const loadSteps = useCallback((signal: AbortSignal) => fetchProjectSteps(projectId!, signal), [projectId])
  const { state: projectSteps } = useResource(route?.level === 'project' && projectId !== null ? `steps:${projectId}` : null, loadSteps, refreshToken, stepsPoll)
  const projectStepsData = projectSteps.status === 'ready' ? projectSteps.data : null
  // Which of loading, failed or read a missing step entry means in the reading pane: a failed read never says "reading…".
  const projectStepsRead = projectSteps.status === 'ready' ? 'read' as const : projectSteps.status === 'error' ? 'failed' as const : 'loading' as const
  const workflowsData = workflows.status === 'ready' ? workflows.data : null
  const projectRunsPoll = usePoll(route?.level === 'project', LISTS_POLL_MS)
  const loadProjectRuns = useCallback((signal: AbortSignal) => fetchWorkflowRuns(projectId!, workflowsData ?? [], () => false, signal), [projectId, workflowsData])
  const projectRunsKey = route?.level === 'project' && workflowsData !== null ? `project-runs:${projectId}:${workflowsData.map(workflow => workflow.workflow_id).join('\u0000')}` : null
  const { state: projectRuns, meta: projectRunsMeta } = useResource(projectRunsKey, loadProjectRuns, refreshToken, projectRunsPoll)
  // The run lists' state for the project page's "Needs you and running" section (V25, [L12]): loading while they load, failed
  // when the request failed or every workflow's run list failed (so the all-clear is never claimed falsely), ready otherwise.
  // `fetchWorkflowRuns` rejects only on abort and turns each workflow's failure into `{runs: [], error}`, so a wholly failed
  // request reaches the page as "every workflow failed"; an empty workflow list is fully read, not failed (design note 5).
  const projectRunsState: RunsState = useMemo(() => {
    if (projectRuns.status === 'loading' || projectRuns.status === 'idle') return { kind: 'loading' }
    if (projectRuns.status === 'error') return { kind: 'failed', reason: describeApiError(projectRuns.error) }
    if (everyRunListFailed(projectRuns.data)) return { kind: 'failed', reason: describeApiError(projectRuns.data.find(workflow => workflow.error !== null)!.error) }
    return { kind: 'ready' }
  }, [projectRuns])

  // The rail rows and the Projects cards: every project's run state (from the registry runs) joined with the dispatch
  // overview's git and GitHub, ordered needs-you, running, readable, unreadable, then by last activity ([D6]).
  const homeRunsData = homeRuns.status === 'ready' ? homeRuns.data : null
  // The controller readings of every listed run, one per successful home poll (the same clock as the run page's own reading), so a
  // latest running run whose controller read `not_running` for 15 s needs the operator on every list, as on its run page. A failed
  // poll adds no reading and the last successful classification stays until the next successful poll.
  const [homeReadings, setHomeReadings] = useState<Map<string, ControllerReading[]>>(() => new Map())
  useEffect(() => {
    if (homeRunsData === null || homeMeta.settledAt === null) return
    const at = new Date(homeMeta.settledAt).toISOString()
    const served = homeRunsData.flatMap(entry => entry.workflows.flatMap(item => (item.error === null ? item.runs : []))).map(run => ({ key: registryKey(run), value: run.activity?.controller ?? null }))
    setHomeReadings(previous => recordHomeReadings(previous, served, at))
  }, [homeRunsData, homeMeta.settledAt])
  const stopped = useMemo(() => stoppedRunKeys(homeReadings), [homeReadings])
  const overviewMap = useMemo(() => new Map((overviewData?.projects ?? []).map(entry => [entry.project_id, entry])), [overviewData])
  // Until the registry run read settles, every project is `loading` (no "cannot be read", no zero counts); a failed request
  // is a failed read for every project.
  const homeFailed = homeRuns.status === 'error'
  const dispatchProjects = useMemo(() => {
    if (projectsData === null) return []
    const runsByProject = new Map((homeRunsData ?? []).map(entry => [entry.project.project_id, entry]))
    return projectsData.map(project => {
      const entry = runsByProject.get(project.project_id) ?? null
      const info = homeFailed && entry === null ? FAILED_RUN_INFO : projectRunInfo(entry, stopped)
      const dispatch = overviewMap.get(project.project_id) ?? null
      const git = dispatch?.git ?? null
      const isPrimary = git !== null && git.clone_primary === project.project_id
      const unpushed = isPrimary && git?.origin?.compare === 'compared' ? git.origin.ahead : null
      const primaryName = git?.clone_primary && git.clone_primary !== project.project_id
        ? projectsData.find(p => p.project_id === git.clone_primary)?.name ?? git.clone_primary : null
      const railInfo: RailInfo = { projectId: project.project_id, name: project.name, waits: info.waits, paused: info.paused, running: info.running, allBad: info.allBad, lastActivity: info.lastActivity, unpushed, loading: info.state === 'loading' }
      return { project, dispatch, info, primaryName, railInfo, unpushed }
    })
  }, [projectsData, homeRunsData, overviewMap, homeFailed, stopped])
  const orderedProjects = useMemo(() => {
    const byId = new Map(dispatchProjects.map(entry => [entry.project.project_id, entry]))
    return railOrder(dispatchProjects.map(entry => entry.railInfo)).map(railInfo => byId.get(railInfo.projectId)!).filter(Boolean)
  }, [dispatchProjects])
  const railRows: RailRow[] = useMemo(() => orderedProjects.map(entry => ({
    projectId: entry.project.project_id, name: entry.project.name, tone: entry.info.tone,
    badge: railBadge(entry.railInfo), badgeTone: railBadgeTone(entry.railInfo), loading: entry.info.state === 'loading', repoShort: entry.dispatch?.github.repo ? entry.dispatch.github.repo.split('/')[1] : entry.dispatch?.git.repository_label ?? null,
    features: entry.info.features, allBad: entry.info.allBad,
    date: entry.info.lastActivity ? dateOnly(new Date(entry.info.lastActivity).toISOString(), zone) : null,
    worst: TONE_LABEL[entry.info.tone],
  })), [orderedProjects, zone])
  const triageBadge = useMemo(() => (homeRunsData === null || dispatchProjects.some(entry => entry.info.state === 'loading') ? null : {
    waits: dispatchProjects.reduce((sum, entry) => sum + entry.info.waits, 0),
    paused: dispatchProjects.reduce((sum, entry) => sum + entry.info.paused, 0),
  }), [dispatchProjects, homeRunsData])
  const cards: CardData[] = useMemo(() => orderedProjects.map(entry => ({ project: entry.project, dispatch: entry.dispatch, info: entry.info, primaryName: entry.primaryName })), [orderedProjects])
  // Null until the dispatch overview is read: the header says "repositories: reading…", never a count it has not read; a
  // failed overview read says the repositories were not read, never that they are still reading.
  const overviewFailed = overview.status === 'error'
  const repositoryCount = useMemo(() => (overviewData !== null ? new Set(overviewData.projects.map(entry => entry.git.clone_id ?? entry.project_id)).size : overviewFailed ? 'failed' as const : null), [overviewData, overviewFailed])

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
  const refreshing = projectsMeta.refreshing || workflowsMeta.refreshing || runsMeta.refreshing || detailMeta.refreshing || homeMeta.refreshing || projectRunsMeta.refreshing || overviewMeta.refreshing
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

  // The feature header names the run's actual reviewers, not the definition's review steps (PRD_VIEWER_REFINE 5.7, [L10]a):
  // the latest finished run's reviewer ids, one fetch cached per feature. The run detail carries no review section, so this
  // reads the review node's result_uri (contracts/projects/v1.ts:105) and then the review result; an unreviewed run, a run
  // with no review result, or a pending/failed fetch yields none, and the header falls back to the definition's review steps.
  const latestReviewedId = useMemo(() => {
    let best: RunSummary | null = null
    for (const run of runs) if (isFinished(run) && (best === null || Date.parse(endedAt(run)) > Date.parse(endedAt(best)))) best = run
    return best?.run_id ?? null
  }, [runs])
  const loadReviewers = useCallback(async (signal: AbortSignal): Promise<string[]> => {
    const reviewScope = { projectId: projectId!, workflowId: workflowId!, runId: latestReviewedId! }
    const reviewed = await fetchRunDetail(reviewScope, signal)
    const reviewNode = reviewed.snapshot.nodes.find(node => node.node_id === 'review')
    if (!reviewNode?.result_uri) return []
    const result = await fetchReviewResult(reviewScope, reviewNode.result_uri, signal)
    return result.reviewers.map(entry => entry.reviewer_id)
  }, [projectId, workflowId, latestReviewedId])
  const reviewersKey = projectId !== null && workflowId !== null && latestReviewedId !== null ? `feature-review:${projectId}/${workflowId}/${latestReviewedId}` : null
  const { state: featureReviewers } = useResource(reviewersKey, loadReviewers, refreshToken)
  const reviewers = featureReviewers.status === 'ready' ? featureReviewers.data : []
  // Neither the reviewers nor the review steps show until the reviewer read has settled (or there is none to make).
  const reviewersSettled = reviewersKey === null || featureReviewers.status === 'ready' || featureReviewers.status === 'error'
  const featureClasses = useMemo(() => classifyRuns(runs, stopped), [runs, stopped])
  // "All time" reads every remaining page; otherwise the list never reads past the page count its URL can restore.
  const allTime = route?.level === 'workflow' && list.search.date === 'all'
  const atPageCap = pages.length >= MAX_LIST_PAGES && !allTime
  // One request per page: a page already being read is never asked for again.
  const reading = useRef<string | null>(null)
  const loadMore = async () => {
    if (!nextCursor || atPageCap || projectId === null || workflowId === null || firstPageData === null || reading.current === nextCursor) return
    reading.current = nextCursor
    setMorePages({ ...extra, base: firstPageData, loading: true, error: null })
    try {
      const page = await fetchRuns(projectId, workflowId, { cursor: nextCursor })
      setMorePages(previous => (previous.base === firstPageData ? { ...previous, pages: [...previous.pages, page], loading: false } : previous))
    } catch (error) {
      setMorePages(previous => (previous.base === firstPageData ? { ...previous, loading: false, error } : previous))
    } finally {
      reading.current = null
    }
  }
  // The feature page reads the pages its URL asks for ("Load more runs" writes them), and every remaining page under "All
  // time", one after another through the same cursor path; a failed page stops it until Retry.
  const wantedPages = route?.level !== 'workflow' ? 1 : allTime ? Number.POSITIVE_INFINITY : list.search.pages
  const moreWanted = route?.level === 'workflow' && firstPageData !== null && nextCursor !== null && !extra.loading && extra.error === null && pages.length < wantedPages
  useEffect(() => { if (moreWanted) void loadMore() })

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
    else if (route.level === 'triage' && homeRuns.status === 'ready') message = 'Loaded Triage.'
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
  }, [route, projects, workflows, firstPage, detail, homeRuns, projectName, workflowName, refreshing, refreshFailed, onAnnounce])

  // Back to a list puts its scroll position back once the list's first read has settled (its appended pages included).
  const settled = route?.level === 'triage' ? homeRuns.status === 'ready' || homeRuns.status === 'error'
    : route?.level === 'project' ? workflows.status === 'error' || (workflows.status === 'ready' && (projectRuns.status === 'ready' || projectRuns.status === 'error'))
      : route?.level === 'workflow' ? firstPage.status === 'error' || (firstPage.status === 'ready' && !moreWanted && !extra.loading)
        : route?.level === 'projects' ? projects.status !== 'loading' && projects.status !== 'idle'
          : false
  const scrolled = useRef<string | null>(null)
  useEffect(() => {
    if (restore === null || !settled || scrolled.current === restore.key) return
    scrolled.current = restore.key
    const top = restore.memory.scroll
    requestAnimationFrame(() => window.scrollTo(0, top))
  }, [restore, settled])

  // The Projects trail starts at Projects (the roots strip leads Home) and ends at the node a node page shows.
  const crumbs: PathCrumb[] = [{ id: 'projects', label: 'Projects', pathname: projectsPathname() }]
  if (route?.level === 'triage') crumbs.push({ id: 'triage', label: 'Triage', pathname: triagePathname() })
  if (projectId !== null) crumbs.push({ id: `project:${projectId}`, label: projectName ?? projectId, pathname: projectPathname(projectId) })
  if (projectId !== null && workflowId !== null) crumbs.push({ id: `workflow:${workflowId}`, label: workflowName ?? workflowId, pathname: workflowPathname(projectId, workflowId) })
  if (projectId !== null && workflowId !== null && runId !== null) crumbs.push({ id: `run:${runId}`, label: runId, pathname: runPathname(projectId, workflowId, runId) })
  if (projectId !== null && workflowId !== null && runId !== null && nodeId !== null) {
    const node = detail.status === 'ready' ? detail.data.definition.nodes.find(candidate => candidate.node_id === nodeId) : undefined
    crumbs.push({ id: `node:${nodeId}`, label: node?.label ?? nodeId, pathname: runPathname(projectId, workflowId, runId, nodeId) })
  }
  if (route === null) crumbs.push({ id: 'invalid', label: 'Invalid link' })

  const notFound = (error: unknown) => error instanceof ProjectsApiError && error.notFound

  // The read-only note is said once, on Triage (the former Runs home, docs/PRD_VIEWER_UX.md 3.2); each command block repeats it in one line.
  const info = route?.level === 'triage' ? 'Read-only: runs are started, answered and approved in the workflow CLI, never from this page.' : null
  // The rail carries the read-only note at its foot on every rail page, so the standalone note is never shown alongside it.
  const homeShown = railLevel
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
    } else content = <ProjectsPage cards={cards} overview={overviewData} repositoryCount={repositoryCount}
      runsReadAt={homeMeta.settledAt} runsError={homeRuns.status === 'error' ? describeApiError(homeRuns.error) : null} onNavigate={onNavigate} />
  } else if (route.level === 'triage') {
    if (projects.status === 'loading' || projects.status === 'idle') content = <LoadingPanel>Loading registered projects…</LoadingPanel>
    else if (projects.status === 'error') content = <ErrorPanel error={projects.error} what="The project list" onRetry={reloadProjects} />
    else if (projects.data.length === 0) {
      content = (
        <EmptyPanel title="No projects are registered." testId="empty-projects">
          <p>The backend's project registry is empty. Projects are registered by the operator in the server configuration, not from this page.</p>
        </EmptyPanel>
      )
    } else content = <RunsHome projects={projects.data} runs={homeRuns} stopped={stopped} meta={homeMeta} now={listClock} pollMs={homeCadence} note={info} onNavigate={onNavigate} list={list} folds={folds} onFold={setFold} />
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
      const projectEntry = projectsData?.find(p => p.project_id === route.projectId) ?? { project_id: route.projectId, name: projectName ?? route.projectId }
      content = (
        <ProjectPage key={route.projectId} project={projectEntry} workflows={workflows.data} list={list} folds={folds} onFold={setFold} onClearFolds={clearFolds}
          projectRuns={projectRuns.status === 'ready' ? projectRuns.data : []}
          runsState={projectRunsState} stopped={stopped}
          steps={projectStepsData} stepsRead={projectStepsRead} dispatch={overviewMap.get(route.projectId) ?? null} overview={overviewData}
          allProjects={projectsData ?? []} now={listClock} zone={zone} onNavigate={onNavigate} />
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
      const items = runs.map(run => ({ run, cls: classOf(featureClasses, run), kindOf: (nodeId: string) => currentWorkflow?.nodes.find(node => node.node_id === nodeId)?.kind }))
      const context = { now: listClock, zone }
      const shown = sortRuns(filterItems(items, list.filter, context), list.filter.sort, featureClasses)
      const order = FEATURE_ORDER[list.filter.sort]
      // At the page cap (outside "All time") a cursor remains that this list cannot follow: it says why, never "Load more runs".
      const capped = atPageCap && nextCursor !== null
      const scope = capped ? cappedScopeLine(shown.length, runs.length, MAX_LIST_PAGES) : scopeLine('feature', shown.length, runs.length, nextCursor !== null)
      // Runs the server could not read (the first page names them): one line, never a run row.
      const unreadRuns = (firstPageData?.errors ?? []).map(entry => entry.run_id)
      const unreadLine = unreadRuns.length === 0 ? null : <p className="projects-muted feature-unread-runs" role="status" data-testid="feature-unread-runs">{unreadRunsText(unreadRuns)}</p>
      const readingOlder = allTime && extra.loading ? `Reading older runs… (${runs.length} read)` : null
      content = (
        <div className="workflow-view">
          <Section headingId="runs-title" className="feature-runs" title={`${workflowName}: runs`}
            sub={runs.length > 0 ? <span data-testid="feature-runs-sub">{`${runs.length} ${runs.length === 1 ? 'run' : 'runs'} · ${order.sub}`}</span> : undefined}>
            {currentWorkflow && laneNamesOf(currentWorkflow.nodes).length > 0 && (
              <p className="feature-lanes">
                <span className="projects-muted">Lanes</span>
                {laneNamesOf(currentWorkflow.nodes).map(lane => <Chip key={lane} plain className="lane-chip">{lane}</Chip>)}
              </p>
            )}
            {currentWorkflow && reviewersSettled && (reviewers.length > 0
              ? (
                // The run's actual reviewers, from the latest finished run's review result (PRD_VIEWER_REFINE 5.7).
                <p className="feature-reviewers">
                  <span className="projects-muted">Reviewers</span>
                  {reviewers.map(reviewer => <Chip key={reviewer} plain className="reviewer-chip" data-reviewer={reviewer}>{reviewer}</Chip>)}
                </p>
              )
              : reviewStepsOf(currentWorkflow.nodes).length > 0 && (
                // No reviewed run yet (or the fetch is pending/failed): the review steps the definition declares, never called reviewers.
                <p className="feature-reviews">
                  <span className="projects-muted">Review steps</span>
                  {reviewStepsOf(currentWorkflow.nodes).map(step => <Chip key={step} plain className="review-step-chip">{step}</Chip>)}
                </p>
              ))}
            {runs.length > 0 && (
              <FilterBar kind="feature" state={list.filter} counts={statusCounts(items, list.filter, context)} scope={scope} active={list.active}
                onChange={(next, options) => list.change(next, options)} onCommit={list.flush} onClear={list.clear} reading={readingOlder} />
            )}
            {shown.length > 0 && (
              // The run history at a glance: one chip per shown run, in the list's order, its status in colour, glyph and title.
              <ol className="run-history" aria-label={`Run history, ${order.history}`}>
                {shown.map(({ run }) => (
                  <li key={run.run_id}>
                    <AppLink href={runPathname(route.projectId, route.workflowId, run.run_id)} onNavigate={onNavigate}
                      className={`ui-chip plain ${toneClass(stateTone({ status: run.status, accepted: run.accepted }))} run-history-chip`} title={`${run.run_id} · ${run.accepted ? OVERRIDE_LABEL : STATUS_LABEL[run.status]}`}
                      aria-label={`Run ${run.run_id}, ${run.accepted ? OVERRIDE_LABEL : STATUS_LABEL[run.status]}`}>
                      {run.accepted ? '◆' : STATUS_GLYPH[run.status]}
                    </AppLink>
                  </li>
                ))}
              </ol>
            )}
            {runs.length === 0 ? (
              // A list whose every run could not be read says so in place of "no runs": it is not a workflow that never ran.
              unreadRuns.length > 0 ? unreadLine : (
                <EmptyPanel title="No runs have been recorded for this workflow." testId="empty-runs">
                  <p>The workflow definition exists (see its current graph below) but it has never been run, or its runs are stored elsewhere. Runs are started from the workflow CLI.</p>
                </EmptyPanel>
              )
            ) : (
              shown.length === 0 ? <NoMatch onClear={list.clear} /> : (
                <ul className="run-rows run-list" data-testid="run-list">
                  {shown.map(({ run, cls }) => (
                    <RunRow key={run.run_id} run={run} cls={cls} labels={labels} now={listClock} onNavigate={onNavigate} href={runPathname(route.projectId, route.workflowId, run.run_id)} />
                  ))}
                </ul>
              )
            )}
            {runs.length > 0 && unreadLine}
            {nextCursor && !capped && (
              <div className="projects-actions">
                <button type="button" className="button" disabled={extra.loading} aria-busy={extra.loading}
                  onClick={() => { list.change({ pages: Math.min(MAX_LIST_PAGES, pages.length + 1) }); void loadMore() }}>
                  {extra.loading ? 'Loading more runs…' : 'Load more runs'}
                </button>
              </div>
            )}
            {capped && (
              <p className="projects-muted lists-empty" data-testid="feature-page-cap">
                {`This list stops after ${MAX_LIST_PAGES} pages, the most a link can restore; choose "All time" in Date to read every older run.`}
              </p>
            )}
            {/* Retry reads the failed page again; at the cap it cannot, so the panel says what failed and offers none. */}
            {extra.error !== null && <ErrorPanel error={extra.error} what="The next page of runs" onRetry={capped ? undefined : () => void loadMore()} />}
          </Section>
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
            teamQuery={teamQuery}
            onTeamQuery={onTeamQuery}
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
      <div className={`navigation${route?.level === 'projects' || route?.level === 'triage' || route?.level === 'project' ? ' navigation-dispatch' : ''}`}>
        {scope !== null ? (
          // On run and node pages the crumbs share their row with the run's "Add to Triage" toggle, outside the workspace.
          <div className="crumb-row" data-testid="crumb-row">
            <Breadcrumbs custom={{ crumbs, onNavigate }} selected={null} index={null} onNavigate={() => undefined} />
            <PinToggle target={{ project_id: scope.projectId, workflow_id: scope.workflowId, run_id: scope.runId }} className="crumb-pin" />
          </div>
        ) : <Breadcrumbs custom={{ crumbs, onNavigate }} selected={null} index={null} onNavigate={() => undefined} />}
        {/* Runs home says it at the rail's foot (docs/PRD_VIEWER_REVAMP.md 3); a Projects root without the rail says it here. */}
        {info !== null && !homeShown && <p className="folder-info" data-testid="projects-info">{info}</p>}
      </div>
      <main className="workspace workspace-projects projects-shell" aria-busy={busy} data-testid="projects-workspace">
        {refreshFailure !== null && (
          <div className="projects-notice" role="alert" data-testid="refresh-failed">
            <p>
              <strong>Refresh failed.</strong> {describeApiError(refreshFailure.refreshError)} The page still shows the data loaded
              {refreshFailure.settledAt === null ? ' before' : <> at <Time iso={new Date(refreshFailure.settledAt).toISOString()} seconds /></>}, which may be outdated.
            </p>
          </div>
        )}
        {railLevel && route !== null ? (
          <div className="dispatch-shell">
            <Rail rows={railRows} projectCount={projectsData?.length ?? 0} triage={triageBadge}
              current={{ kind: route.level as 'projects' | 'triage' | 'project' | 'workflow', projectId: projectId ?? undefined }} onNavigate={onNavigate} />
            <div className="dispatch-shell-main">{content}</div>
          </div>
        ) : content}
      </main>
    </>
  )
}
