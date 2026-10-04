/**
 * The challenge page's earlier attempts (C49): which records the page lists, and the section index entry that points at them.
 * The rendered section is covered by [scenario:challenge-history] in tests/project-workflows/guardrails.spec.ts; unit tests
 * never import React.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as examples from '../../contracts/projects/examples.ts'
import type { RunInputs } from '../../src/projects/api.ts'
import { challengeSectionEntries, earlierAttempts } from '../../src/projects/node/panels.ts'

type Challenge = NonNullable<RunInputs['challenge']>

const challenge = (fields: Partial<Challenge>): Challenge => ({
  status: 'passed', attempt: 3, attempts: 3, session_id: 's', pinned: { tasks_sha256: 'a'.repeat(64), decisions_sha256: 'b'.repeat(64), prd_sha256: null },
  concerns: [], simpler_alternative: 'x', cheap_experiment: 'y', accepted_reason: null, decided_at: '2026-03-05T08:50:49Z', hold: null, history: [], ...fields,
})
const history: NonNullable<Challenge['history']> = [
  { attempt: 1, status: 'paused', decided_at: '2026-03-05T08:45:00Z', concerns: [{ severity: 'P1', kind: 'failure_mode', message: 'Both lanes edit the contract.', consequence: 'The merge conflicts.' }] },
  { attempt: 2, status: 'paused', decided_at: '2026-03-05T08:46:00Z', concerns: [{ severity: 'P0', kind: 'assumption', message: 'The PRD contradicts the task.', consequence: 'Lanes build the wrong page.' }] },
]

test('the earlier attempts are the records before the shown attempt, in order', () => {
  assert.deepEqual(earlierAttempts(challenge({ history })).map(entry => entry.attempt), [1, 2])
  // No archived record, and a server before 1.7.0 (no history), list nothing.
  assert.deepEqual(earlierAttempts(challenge({})), [])
  assert.deepEqual(earlierAttempts(challenge({ history: undefined })), [])
  // An accepted attempt keeps its own paused record under its number: that is the shown attempt's first decision, whose
  // concerns the page already shows, not an earlier attempt.
  const accepted = examples.runInputs.challenge!
  assert.deepEqual([accepted.status, accepted.attempt, accepted.history!.map(entry => entry.attempt)], ['accepted', 1, [1]])
  assert.deepEqual(earlierAttempts(accepted), [])
  const third = challenge({ status: 'accepted', history: [...history, { ...history[1], attempt: 3 }] })
  assert.deepEqual(earlierAttempts(third).map(entry => entry.attempt), [1, 2])
})

test('the section index points at the earlier attempts when there are any', () => {
  assert.deepEqual(challengeSectionEntries(challenge({ history })).map(entry => entry.key), ['alternative', 'challenge-history'])
  assert.deepEqual(challengeSectionEntries(challenge({ history })).at(-1), { key: 'challenge-history', label: 'Earlier attempts', count: 2 })
  assert.deepEqual(challengeSectionEntries(challenge({})).map(entry => entry.key), ['alternative'])
  // The contract's accepted example: its only record is its own first decision, so no Earlier attempts chip.
  assert.deepEqual(challengeSectionEntries(examples.runInputs.challenge!).map(entry => entry.key), ['concerns', 'alternative'])
  const third = challenge({ status: 'accepted', history: [...history, { ...history[1], attempt: 3 }] })
  assert.deepEqual(challengeSectionEntries(third).at(-1), { key: 'challenge-history', label: 'Earlier attempts', count: 2 })
  // NodeDetail ends every index with the node's own event History ('history'): the keys stay distinct, so each chip finds its section.
  const keys = [...challengeSectionEntries(challenge({ history, concerns: [history[0].concerns[0]] })), { key: 'history' }].map(entry => entry.key)
  assert.equal(new Set(keys).size, keys.length)
})
