/**
 * Projects routes (docs/PRD_VIEWER_UX.md 3.1): a run's Assignment view lives in the path, `/runs/<r>/assignment`, and so
 * does one attempt of a node, `/nodes/<n>/attempts/<k>`, so each can be linked and survives a reload; every URL that worked
 * before keeps working, and anything else is malformed.
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { assignmentPathname, attemptPathname, parseProjectsPathname, routeToPathname, runPathname, type ProjectsRoute } from '../../src/projects/routes.ts'

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

  test('`attempts/<k>` after a node id reads that attempt of the node', () => {
    assert.deepEqual(parseProjectsPathname(`${RUN}/nodes/verify_ui/attempts/1`), { level: 'run', projectId: 'alpha', workflowId: 'flow', runId: 'run-1', nodeId: 'verify_ui', tab: 'run', attempt: 1 })
    assert.deepEqual(parseProjectsPathname(`${RUN}/nodes/candidate/attempts/12/`), { level: 'run', projectId: 'alpha', workflowId: 'flow', runId: 'run-1', nodeId: 'candidate', tab: 'run', attempt: 12 })
  })

  test('an attempt is a positive whole number, directly after a node id', () => {
    for (const pathname of [
      `${RUN}/nodes/verify_ui/attempts`,
      `${RUN}/nodes/verify_ui/attempts/0`,
      `${RUN}/nodes/verify_ui/attempts/01`,
      `${RUN}/nodes/verify_ui/attempts/-1`,
      `${RUN}/nodes/verify_ui/attempts/1.5`,
      `${RUN}/nodes/verify_ui/attempts/one`,
      `${RUN}/nodes/verify_ui/attempts/1/extra`,
      `${RUN}/nodes/verify_ui/attempt/1`,
      `${RUN}/attempts/1`,
      `${RUN}/assignment/attempts/1`,
    ]) assert.equal(parseProjectsPathname(pathname), null, pathname)
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

  test('one attempt of a node', () => {
    assert.equal(attemptPathname('alpha', 'flow', 'run-1', 'verify_ui', 2), `${RUN}/nodes/verify_ui/attempts/2`)
  })

  test('every route round-trips through its pathname', () => {
    const routes: ProjectsRoute[] = [
      { level: 'projects' },
      { level: 'project', projectId: 'alpha' },
      { level: 'workflow', projectId: 'alpha', workflowId: 'flow' },
      { level: 'run', projectId: 'alpha', workflowId: 'flow', runId: 'run-1', nodeId: null, tab: 'run' },
      { level: 'run', projectId: 'alpha', workflowId: 'flow', runId: 'run-1', nodeId: null, tab: 'assignment' },
      { level: 'run', projectId: 'alpha', workflowId: 'flow', runId: 'run-1', nodeId: 'verify_ui', tab: 'run' },
      { level: 'run', projectId: 'alpha', workflowId: 'flow', runId: 'run-1', nodeId: 'verify_ui', tab: 'run', attempt: 3 },
    ]
    for (const route of routes) assert.deepEqual(parseProjectsPathname(routeToPathname(route)), route)
  })
})
