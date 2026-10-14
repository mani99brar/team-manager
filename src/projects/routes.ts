/**
 * Projects routes: `/projects[/<project>[/workflows/<workflow>[/runs/<run>[/assignment | /nodes/<node>[/attempts/<k>]]]]]`.
 * A run's views live in the path (docs/PRD_VIEWER_UX.md 3.1): the Run view (with its node pages, the latest attempt or an
 * earlier one) and the Assignment view, so each can be linked and survives a reload.
 *
 * Every ID is an opaque contract identifier: it must match the shared ID pattern and is percent-encoded
 * as one path segment. Anything else is malformed rather than looked up. This domain is read-only and
 * separate from the Pi/Claude skill sources; nothing here names a filesystem path.
 */
import { PHASES } from './dispatch/phases.ts'
import { STATUS_FILTERS } from './runFilter.ts'

/** Same pattern as the shared projects contract (`contracts/projects/v1.ts`). */
export const PROJECT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

export const PROJECTS_ROUTE = 'projects'

export type ProjectsRoute =
  | { level: 'projects' }
  /** Triage, `/projects/-/triage` (the former Runs home). `-` cannot start a project id, so the path never collides ([D1]). */
  | { level: 'triage' }
  | { level: 'project'; projectId: string }
  | { level: 'workflow'; projectId: string; workflowId: string }
  /** `attempt` is present only on an attempt's own page, `/nodes/<node>/attempts/<k>`; a node page shows its latest attempt. */
  | { level: 'run'; projectId: string; workflowId: string; runId: string; nodeId: string | null; tab: 'run' | 'assignment'; attempt?: number }

export function isContractId(value: string): boolean {
  return PROJECT_ID_PATTERN.test(value)
}

function encode(segments: string[]): string {
  return `/${segments.map(encodeURIComponent).join('/')}`
}

export function projectsPathname(): string {
  return `/${PROJECTS_ROUTE}`
}

/** The literal after `/projects/-/` that selects Triage. A project id can never be `-`, so this path is unambiguous ([D1]). */
export const TRIAGE_SEGMENT = 'triage'

export function triagePathname(): string {
  return `/${PROJECTS_ROUTE}/-/${TRIAGE_SEGMENT}`
}

export function projectPathname(projectId: string): string {
  return encode([PROJECTS_ROUTE, projectId])
}

export function workflowPathname(projectId: string, workflowId: string): string {
  return encode([PROJECTS_ROUTE, projectId, 'workflows', workflowId])
}

export function runPathname(projectId: string, workflowId: string, runId: string, nodeId: string | null = null): string {
  const segments = [PROJECTS_ROUTE, projectId, 'workflows', workflowId, 'runs', runId]
  if (nodeId !== null) segments.push('nodes', nodeId)
  return encode(segments)
}

/** The literal after a run id that selects its Assignment view. */
export const ASSIGNMENT_SEGMENT = 'assignment'

export function assignmentPathname(projectId: string, workflowId: string, runId: string): string {
  return encode([PROJECTS_ROUTE, projectId, 'workflows', workflowId, 'runs', runId, ASSIGNMENT_SEGMENT])
}

/** The literal after a node id that selects one of its attempts. */
export const ATTEMPTS_SEGMENT = 'attempts'

/** An attempt number in a path: a positive whole number without leading zeros. */
const ATTEMPT_PATTERN = /^[1-9][0-9]{0,5}$/

export function attemptPathname(projectId: string, workflowId: string, runId: string, nodeId: string, attempt: number): string {
  return `${runPathname(projectId, workflowId, runId, nodeId)}/${ATTEMPTS_SEGMENT}/${attempt}`
}

export function routeToPathname(route: ProjectsRoute): string {
  switch (route.level) {
    case 'projects': return projectsPathname()
    case 'triage': return triagePathname()
    case 'project': return projectPathname(route.projectId)
    case 'workflow': return workflowPathname(route.projectId, route.workflowId)
    case 'run':
      if (route.tab === 'assignment') return assignmentPathname(route.projectId, route.workflowId, route.runId)
      if (route.nodeId !== null && route.attempt !== undefined) return attemptPathname(route.projectId, route.workflowId, route.runId, route.nodeId, route.attempt)
      return runPathname(route.projectId, route.workflowId, route.runId, route.nodeId)
  }
}

/** Whether a pathname belongs to the Projects domain at all (decided before any decoding). */
export function isProjectsPathname(pathname: string): boolean {
  const first = pathname.split('/').filter(segment => segment !== '')[0]
  return first === PROJECTS_ROUTE
}

/**
 * Parses a Projects pathname. Returns null when it is not a Projects pathname or when any segment is
 * malformed (bad encoding, an invalid ID, an unexpected literal or trailing segments).
 */
export function parseProjectsPathname(pathname: string): ProjectsRoute | null {
  const raw = pathname.split('/').filter(segment => segment !== '')
  if (raw[0] !== PROJECTS_ROUTE) return null
  let segments: string[]
  try {
    segments = raw.slice(1).map(decodeURIComponent)
  } catch {
    return null
  }
  if (segments.length === 0) return { level: 'projects' }
  const [projectId, workflowsLiteral, workflowId, runsLiteral, runId, nodesLiteral, nodeId, attemptsLiteral, attempt, ...rest] = segments
  // Triage lives at `/projects/-/triage`; `-` is never a valid project id, so the match is decided before any id lookup ([D1]).
  if (projectId === '-') return workflowsLiteral === TRIAGE_SEGMENT && workflowId === undefined ? { level: 'triage' } : null
  if (!isContractId(projectId)) return null
  if (workflowsLiteral === undefined) return { level: 'project', projectId }
  if (workflowsLiteral !== 'workflows' || workflowId === undefined || !isContractId(workflowId)) return null
  if (runsLiteral === undefined) return { level: 'workflow', projectId, workflowId }
  if (runsLiteral !== 'runs' || runId === undefined || !isContractId(runId)) return null
  if (nodesLiteral === undefined) return { level: 'run', projectId, workflowId, runId, nodeId: null, tab: 'run' }
  if (nodesLiteral === ASSIGNMENT_SEGMENT && nodeId === undefined) return { level: 'run', projectId, workflowId, runId, nodeId: null, tab: 'assignment' }
  if (nodesLiteral !== 'nodes' || nodeId === undefined || !isContractId(nodeId)) return null
  if (attemptsLiteral === undefined) return { level: 'run', projectId, workflowId, runId, nodeId, tab: 'run' }
  if (attemptsLiteral !== ATTEMPTS_SEGMENT || attempt === undefined || !ATTEMPT_PATTERN.test(attempt) || rest.length > 0) return null
  return { level: 'run', projectId, workflowId, runId, nodeId, tab: 'run', attempt: Number(attempt) }
}

// ---- A list's state in the URL's search -------------------------------------------------------------------------------

/** The status ids, phase names and values a list's search may carry; anything else reads as that key's default. */
const LIST_STATUSES = STATUS_FILTERS
const LIST_PHASES = PHASES
const LIST_DATES = ['today', '7d', '30d', 'all'] as const
const LIST_SORTS = ['live', 'newest', 'oldest'] as const
/** The feature page's loaded pages a URL may ask for. */
export const MAX_LIST_PAGES = 20

/**
 * A run list's state as its URL carries it, on Projects pathnames only: the search words, the status toggles, the
 * stopped-at phase, the date window (`any` is the default), the sort, Recent's grouping by project and its "Show older",
 * and the feature page's loaded pages.
 */
export type ListSearch = {
  q: string
  status: readonly (typeof LIST_STATUSES)[number][]
  phase: (typeof LIST_PHASES)[number] | null
  date: (typeof LIST_DATES)[number] | 'any'
  sort: (typeof LIST_SORTS)[number]
  group: boolean
  older: boolean
  pages: number
}

export const DEFAULT_LIST_SEARCH: ListSearch = { q: '', status: [], phase: null, date: 'any', sort: 'live', group: false, older: false, pages: 1 }

const oneOf = <T extends string>(values: readonly T[], value: string | null): T | null => (value !== null && (values as readonly string[]).includes(value) ? value as T : null)

/** Reads a list's state from a URL search ("?q=…&status=failed"). An unknown key is dropped; a malformed value reads as its default. */
export function parseListSearch(search: string): ListSearch {
  const params = new URLSearchParams(search)
  const statusText = params.get('status')
  const statusIds = statusText === null ? [] : statusText.split(',')
  const statusOk = statusIds.length > 0 && statusIds.every(id => oneOf(LIST_STATUSES, id) !== null)
  const pagesText = params.get('pages')
  const pages = pagesText !== null && /^[1-9][0-9]?$/.test(pagesText) && Number(pagesText) <= MAX_LIST_PAGES ? Number(pagesText) : 1
  return {
    q: params.get('q') ?? '',
    // Each status once, in the bar's order.
    status: statusOk ? LIST_STATUSES.filter(id => statusIds.includes(id)) : [],
    phase: oneOf(LIST_PHASES, params.get('phase')),
    date: oneOf(LIST_DATES, params.get('date')) ?? 'any',
    sort: oneOf(LIST_SORTS, params.get('sort')) ?? 'live',
    group: params.get('group') === 'project',
    older: params.get('older') === '1',
    pages,
  }
}

/**
 * Writes a list's state as a URL search, keys in the fixed order q, status, phase, date, sort, group, older, pages, and
 * defaults never written: a list at its defaults has an empty search.
 */
export function listSearchString(state: ListSearch): string {
  const params = new URLSearchParams()
  if (state.q !== '') params.set('q', state.q)
  if (state.status.length > 0) params.set('status', LIST_STATUSES.filter(id => state.status.includes(id)).join(','))
  if (state.phase !== null) params.set('phase', state.phase)
  if (state.date !== 'any') params.set('date', state.date)
  if (state.sort !== 'live') params.set('sort', state.sort)
  if (state.group) params.set('group', 'project')
  if (state.older) params.set('older', '1')
  if (state.pages > 1) params.set('pages', String(Math.min(MAX_LIST_PAGES, state.pages)))
  const text = params.toString()
  return text === '' ? '' : `?${text}`
}

/** Whether history keeps a pathname's search string: only Projects pathnames carry a list's state; every other write is pathname-only. */
export function keepsListSearch(pathname: string): boolean {
  return isProjectsPathname(pathname)
}

/**
 * A Projects pathname in the form `routeToPathname` writes (a trailing slash or a needlessly encoded segment read the same),
 * so a list's write matches the entry the browser opened; any other pathname is returned unchanged.
 */
export function canonicalPathname(pathname: string): string {
  const route = parseProjectsPathname(pathname)
  return route === null ? pathname : routeToPathname(route)
}
