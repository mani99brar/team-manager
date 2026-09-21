/**
 * Projects routes: `/projects[/<project>[/workflows/<workflow>[/runs/<run>[/nodes/<node>]]]]`.
 *
 * Every ID is an opaque contract identifier: it must match the shared ID pattern and is percent-encoded
 * as one path segment. Anything else is malformed rather than looked up. This domain is read-only and
 * separate from the Pi/Claude skill sources; nothing here names a filesystem path.
 */

/** Same pattern as the shared projects contract (`contracts/projects/v1.ts`). */
export const PROJECT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

export const PROJECTS_ROUTE = 'projects'

export type ProjectsRoute =
  | { level: 'projects' }
  | { level: 'project'; projectId: string }
  | { level: 'workflow'; projectId: string; workflowId: string }
  | { level: 'run'; projectId: string; workflowId: string; runId: string; nodeId: string | null }

export function isContractId(value: string): boolean {
  return PROJECT_ID_PATTERN.test(value)
}

function encode(segments: string[]): string {
  return `/${segments.map(encodeURIComponent).join('/')}`
}

export function projectsPathname(): string {
  return `/${PROJECTS_ROUTE}`
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

export function routeToPathname(route: ProjectsRoute): string {
  switch (route.level) {
    case 'projects': return projectsPathname()
    case 'project': return projectPathname(route.projectId)
    case 'workflow': return workflowPathname(route.projectId, route.workflowId)
    case 'run': return runPathname(route.projectId, route.workflowId, route.runId, route.nodeId)
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
  const [projectId, workflowsLiteral, workflowId, runsLiteral, runId, nodesLiteral, nodeId, ...rest] = segments
  if (!isContractId(projectId)) return null
  if (workflowsLiteral === undefined) return { level: 'project', projectId }
  if (workflowsLiteral !== 'workflows' || workflowId === undefined || !isContractId(workflowId)) return null
  if (runsLiteral === undefined) return { level: 'workflow', projectId, workflowId }
  if (runsLiteral !== 'runs' || runId === undefined || !isContractId(runId)) return null
  if (nodesLiteral === undefined) return { level: 'run', projectId, workflowId, runId, nodeId: null }
  if (nodesLiteral !== 'nodes' || nodeId === undefined || !isContractId(nodeId) || rest.length > 0) return null
  return { level: 'run', projectId, workflowId, runId, nodeId }
}
