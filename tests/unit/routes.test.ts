/**
 * Projects routes (docs/PRD_VIEWER_UX.md 3.1): a run's Assignment view lives in the path, `/runs/<r>/assignment`, so it
 * can be linked and survives a reload; every URL that worked before keeps working, and anything else is malformed.
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { assignmentPathname, parseProjectsPathname, routeToPathname, runPathname, type ProjectsRoute } from '../../src/projects/routes.ts'

const RUN = '/projects/alpha/workflows/flow/runs/run-1'

describe('parseProjectsPathname', () => {
  test('a run page reads the Run view', () => {
    assert.deepEqual(parseProjectsPathname(RUN), { level: 'run', projectId: 'alpha', workflowId: 'flow', runId: 'run-1', nodeId: null, tab: 'run' })
  })

  test('`assignment` after the run id reads the Assignment view', () => {
    assert.deepEqual(parseProjectsPathname(`${RUN}/assignment`), { level: 'run', projectId: 'alpha', workflowId: 'flow', runId: 'run-1', nodeId: null, tab: 'assignment' })
    assert.deepEqual(parseProjectsPathname(`${RUN}/assignment/`), parseProjectsPathname(`${RUN}/assignment`))
  })

  test('a node page is part of the Run view', () => {
    assert.deepEqual(parseProjectsPathname(`${RUN}/nodes/verify_ui`), { level: 'run', projectId: 'alpha', workflowId: 'flow', runId: 'run-1', nodeId: 'verify_ui', tab: 'run' })
  })

  test('the levels above a run are unchanged', () => {
    assert.deepEqual(parseProjectsPathname('/projects'), { level: 'projects' })
    assert.deepEqual(parseProjectsPathname('/projects/alpha'), { level: 'project', projectId: 'alpha' })
    assert.deepEqual(parseProjectsPathname('/projects/alpha/workflows/flow'), { level: 'workflow', projectId: 'alpha', workflowId: 'flow' })
  })

  test('`assignment` anywhere else, another literal or a trailing segment is malformed', () => {
    for (const pathname of [
      `${RUN}/assignment/extra`,
      `${RUN}/nodes/verify_ui/assignment`,
      `${RUN}/Assignment`,
      `${RUN}/inputs`,
      `${RUN}/nodes`,
      `${RUN}/nodes/verify_ui/extra`,
      '/projects/alpha/workflows/flow/assignment',
      '/projects/alpha/assignment',
    ]) assert.equal(parseProjectsPathname(pathname), null, pathname)
  })

  test('a run whose id is `assignment` is still a run', () => {
    assert.deepEqual(parseProjectsPathname('/projects/alpha/workflows/flow/runs/assignment'), { level: 'run', projectId: 'alpha', workflowId: 'flow', runId: 'assignment', nodeId: null, tab: 'run' })
  })
})

describe('building pathnames', () => {
  test('the Assignment view of a run', () => {
    assert.equal(assignmentPathname('alpha', 'flow', 'run-1'), `${RUN}/assignment`)
    assert.equal(assignmentPathname('a b', 'flow', 'run-1'), '/projects/a%20b/workflows/flow/runs/run-1/assignment')
  })

  test('a run and a node, as before', () => {
    assert.equal(runPathname('alpha', 'flow', 'run-1'), RUN)
    assert.equal(runPathname('alpha', 'flow', 'run-1', 'verify_ui'), `${RUN}/nodes/verify_ui`)
  })

  test('every route round-trips through its pathname', () => {
    const routes: ProjectsRoute[] = [
      { level: 'projects' },
      { level: 'project', projectId: 'alpha' },
      { level: 'workflow', projectId: 'alpha', workflowId: 'flow' },
      { level: 'run', projectId: 'alpha', workflowId: 'flow', runId: 'run-1', nodeId: null, tab: 'run' },
      { level: 'run', projectId: 'alpha', workflowId: 'flow', runId: 'run-1', nodeId: null, tab: 'assignment' },
      { level: 'run', projectId: 'alpha', workflowId: 'flow', runId: 'run-1', nodeId: 'verify_ui', tab: 'run' },
    ]
    for (const route of routes) assert.deepEqual(parseProjectsPathname(routeToPathname(route)), route)
  })
})
