/**
 * The node-page wording of projected session nodes (src/projects/signal/executor.ts, docs/PRD_RUN_SESSIONS.md 3.1-3.2): the
 * header names a reviewer, the panel and a lane review with the same executor phrase as their stage card's accessible name
 * ("executed by one reviewer"), never the review gate's "one agent session per reviewer"; a finished reviewer or lane review
 * says its verdict is on the page rather than "This step completed." beside a blocked verdict; pinned steps keep the kind's
 * wording.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { nodeExecutor, projectedSessionKind, projectedSucceededMeaning, stageExecutor } from '../../src/projects/signal/executor.ts'
import { executorOf } from '../../src/projects/status.ts'

test('nodeExecutor: a projected node names the executor its stage card names; pinned steps keep executorOf', () => {
  for (const [id, phrase] of [['reviewer-general', 'one reviewer'], ['reviewer-critique', 'one reviewer'], ['panel', 'a multi-provider panel'], ['lane-review-viewer-1', 'one lane reviewer']] as const) {
    assert.equal(nodeExecutor('review', undefined, id), phrase)
    assert.equal(nodeExecutor('review', undefined, id), stageExecutor({ projected: projectedSessionKind(id), exec: 'agent', kind: 'review', id }).phrase)
    assert.notEqual(nodeExecutor('review', undefined, id), executorOf('review'))
  }
  assert.equal(nodeExecutor('review', undefined, 'review'), 'one agent session per reviewer')
  assert.equal(nodeExecutor('review', 'print', 'review'), 'one print job per reviewer')
  assert.equal(nodeExecutor('review', undefined, 'challenge'), 'one print job')
  assert.equal(nodeExecutor('worker', undefined, 'launch_server'), 'agent session')
})

test('projectedSucceededMeaning: a finished reviewer or lane review points at its verdict; the panel and pinned steps get none', () => {
  assert.equal(projectedSucceededMeaning('reviewer-general'), 'The reviewer finished; its verdict is below.')
  assert.equal(projectedSucceededMeaning('reviewer-review'), 'The reviewer finished; its verdict is below.')
  assert.equal(projectedSucceededMeaning('lane-review-server-1'), 'The lane review finished; its result is below.')
  for (const id of ['panel', 'review', 'launch_server', 'repair-1']) assert.equal(projectedSucceededMeaning(id), null)
})
