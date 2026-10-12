/**
 * Parity ([L5], [L11] 2, run-sessions): the worker-phase mock and the real candidate server must project the same
 * reviewer/panel/lane-review nodes with the same statuses for every run the config serves, so the stage specs see the same
 * `data-node-id` cards in both phases. The mock serves `sessionNodePairs(base)`; this spec fetches each run's served detail
 * (the mock's in the worker phase, the server's in the candidate phase) and compares its projected `node_id:status` pairs
 * with the mock's for that run. In the candidate phase it also compares each mocked `/sessions` payload with the server's
 * for the same seed (resume commands compared in the bare form: the candidate test root is outside HOME, [L1]). The
 * worker-phase half passes by construction; the candidate run is the gate. It carries no scenario tag.
 */
import { test, expect } from '@playwright/test'
import { runDetails } from './fixtures.ts'
import { sessionsByRun } from './fixtures/index.ts'
import { sessionNodePairs } from './sessionProjection.ts'
import { isProjectedSessionNode } from '../../src/projects/sessions/model.ts'
import { fetchFromPage, installHooks } from './support.ts'
import type { RunDetail } from '../../contracts/projects/v1.ts'
import type { Sessions, SessionRow } from '../../contracts/projects/sessions.ts'

installHooks()

const phase = process.env.WORKFLOW_VERIFICATION_PHASE === 'candidate' ? 'candidate' : 'worker'

/** Runs another config serves (the controls spec's own app), never this one's server: none today, named here when added. */
const SERVED_ELSEWHERE: readonly string[] = []

test('run-sessions: every served run projects the same session nodes and statuses in both phases', async ({ page }) => {
  await page.goto('/projects')
  const unserved: string[] = []
  let checked = 0
  for (const base of Object.values(runDetails) as RunDetail[]) {
    const { project_id, workflow_id, run_id } = base.summary
    const response = await fetchFromPage(page, `/api/projects/${project_id}/workflows/${workflow_id}/runs/${run_id}`)
    if (response.status !== 200) {
      unserved.push(run_id)
      continue
    }
    const served = JSON.parse(response.text) as RunDetail
    const statusOf = new Map(served.snapshot.nodes.map(node => [node.node_id, node.status]))
    const pairs = served.definition.nodes.map(node => node.node_id).filter(isProjectedSessionNode).map(id => `${id}:${statusOf.get(id)}`).sort()
    expect(pairs, `${project_id}/${workflow_id}/${run_id}`).toEqual(sessionNodePairs(base))
    checked += 1
  }
  expect(unserved.sort(), 'only the runs another config serves answer 404').toEqual([...SERVED_ELSEWHERE].sort())
  expect(checked).toBe(Object.keys(runDetails).length - SERVED_ELSEWHERE.length)
})

/** A row as both phases can agree on it: the resume command in its bare form (the `~/` form needs the real HOME). */
function comparable(sessions: Sessions): Sessions {
  const bare = (row: SessionRow): SessionRow => ({ ...row, resume: row.resume && row.session_id ? { dir: null, command: `claude --resume ${row.session_id}` } : row.resume })
  return { ...sessions, sessions: sessions.sessions.map(bare) }
}

test('run-sessions: the mocked /sessions payload equals the server\'s for the same seed', async ({ page }) => {
  test.skip(phase !== 'candidate', 'the worker phase serves the mock itself')
  await page.goto('/projects')
  for (const [runId, mocked] of Object.entries(sessionsByRun)) {
    const { project_id, workflow_id } = runDetails[runId]!.summary
    const response = await fetchFromPage(page, `/api/projects/${project_id}/workflows/${workflow_id}/runs/${runId}/sessions`)
    expect(response.status, runId).toBe(200)
    expect(comparable(JSON.parse(response.text) as Sessions), runId).toEqual(comparable(mocked))
  }
})
