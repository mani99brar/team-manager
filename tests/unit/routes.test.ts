/**
 * Projects routes (docs/PRD_VIEWER_UX.md 3.1): a run's Assignment view lives in the path, `/runs/<r>/assignment`, and so
 * does one attempt of a node, `/nodes/<n>/attempts/<k>`, so each can be linked and survives a reload; every URL that worked
 * before keeps working, and anything else is malformed.
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { assignmentPathname, attemptPathname, canonicalPathname, DEFAULT_LIST_SEARCH, keepsListSearch, listSearchString, parseListSearch, parseProjectsPathname, routeToPathname, runPathname, triagePathname, type ListSearch, type ProjectsRoute } from '../../src/projects/routes.ts'

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

  test('`/projects/-/triage` is Triage ([D1])', () => {
    assert.deepEqual(parseProjectsPathname('/projects/-/triage'), { level: 'triage' })
    assert.deepEqual(parseProjectsPathname('/projects/-/triage/'), { level: 'triage' })
  })

  test('no project id can produce `/projects/-/triage`: `-` is not a valid id and only `triage` follows it', () => {
    // `-` fails the project id pattern, so no real project routes through it; any other literal after `-` is malformed.
    assert.equal(parseProjectsPathname('/projects/-'), null)
    assert.equal(parseProjectsPathname('/projects/-/workflows/flow'), null)
    assert.equal(parseProjectsPathname('/projects/-/triage/extra'), null)
    assert.equal(parseProjectsPathname('/projects/-/other'), null)
    // A project literally named "triage" is a project, never Triage; Triage is only ever under `-`.
    assert.deepEqual(parseProjectsPathname('/projects/triage'), { level: 'project', projectId: 'triage' })
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

  test('Triage round-trips through its pathname', () => {
    assert.equal(triagePathname(), '/projects/-/triage')
    assert.deepEqual(parseProjectsPathname(triagePathname()), { level: 'triage' })
  })

  test('every route round-trips through its pathname', () => {
    const routes: ProjectsRoute[] = [
      { level: 'projects' },
      { level: 'triage' },
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

describe('a list\'s state in the URL search', () => {
  const full: ListSearch = { q: 'run 42', status: ['needs', 'failed'], phase: 'Review', date: '7d', sort: 'newest', group: true, older: true, pages: 3 }

  test('every key round-trips, in the fixed order q, status, phase, date, sort, group, older, pages', () => {
    const search = listSearchString(full)
    assert.equal(search, '?q=run+42&status=needs%2Cfailed&phase=Review&date=7d&sort=newest&group=project&older=1&pages=3')
    assert.deepEqual(parseListSearch(search), full)
    for (const date of ['today', '7d', '30d', 'all'] as const) assert.equal(parseListSearch(listSearchString({ ...DEFAULT_LIST_SEARCH, date })).date, date)
    for (const sort of ['newest', 'oldest'] as const) assert.equal(parseListSearch(listSearchString({ ...DEFAULT_LIST_SEARCH, sort })).sort, sort)
    // Status ids are written once each, in the bar's order, whatever order they were pressed in.
    assert.equal(listSearchString({ ...DEFAULT_LIST_SEARCH, status: ['cancelled', 'running'] }), '?status=running%2Ccancelled')
  })
  test('defaults are never written: a list at its defaults has an empty search', () => {
    assert.equal(listSearchString(DEFAULT_LIST_SEARCH), '')
    assert.equal(listSearchString({ ...DEFAULT_LIST_SEARCH, sort: 'live', date: 'any', pages: 1 }), '')
    assert.deepEqual(parseListSearch(''), DEFAULT_LIST_SEARCH)
  })
  test('an unknown key is dropped and a malformed status, phase, date, sort or pages reads as its default', () => {
    assert.deepEqual(parseListSearch('?foo=bar&q=x'), { ...DEFAULT_LIST_SEARCH, q: 'x' })
    assert.equal(listSearchString(parseListSearch('?foo=bar&q=x')), '?q=x')
    assert.deepEqual(parseListSearch('?status=failed,bogus').status, [])
    assert.deepEqual(parseListSearch('?status=').status, [])
    assert.equal(parseListSearch('?phase=Nowhere').phase, null)
    assert.equal(parseListSearch('?date=yesterday').date, 'any')
    assert.equal(parseListSearch('?sort=random').sort, 'live')
    for (const pages of ['0', '21', '-1', 'two', '1.5', '007', '']) assert.equal(parseListSearch(`?pages=${pages}`).pages, 1, pages)
    assert.equal(parseListSearch('?pages=20').pages, 20)
    assert.equal(parseListSearch('?group=day').group, false)
    assert.equal(parseListSearch('?older=yes').older, false)
  })
  test('a Projects pathname with a search parses as its pathname; the keep-search helper is true for Projects pathnames only', () => {
    assert.deepEqual(parseProjectsPathname(new URL(`http://x${RUN}?q=a&status=failed`).pathname), parseProjectsPathname(RUN))
    for (const pathname of ['/projects', triagePathname(), '/projects/alpha', '/projects/alpha/workflows/flow', RUN]) assert.equal(keepsListSearch(pathname), true, pathname)
    for (const pathname of ['/', '/pi', '/claude', '/pi/skills', '/claude/agents/x.md', '/documents/a', '/skills', '/projectsx', '/pi/projects']) assert.equal(keepsListSearch(pathname), false, pathname)
  })
  test('a Projects pathname with a trailing slash has the canonical pathname a list writes; any other pathname is unchanged', () => {
    assert.equal(canonicalPathname(`${triagePathname()}/`), triagePathname())
    assert.equal(canonicalPathname('/projects/'), '/projects')
    assert.equal(canonicalPathname('/projects/alpha/workflows/flow/'), '/projects/alpha/workflows/flow')
    assert.equal(canonicalPathname(RUN), RUN)
    for (const pathname of ['/', '/pi/', '/claude/agents/x.md', '/projects/alpha/bogus']) assert.equal(canonicalPathname(pathname), pathname, pathname)
  })
})
