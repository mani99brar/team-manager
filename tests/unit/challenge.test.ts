/**
 * The challenge page's earlier attempts (C49, src/projects/Challenge.tsx): each record the shown attempt replaced, with its
 * P0/P1 concerns, rendered to static markup; and the section index entry that points at them.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { RunInputs } from '../../src/projects/api.ts'
import { challengeSectionEntries } from '../../src/projects/node/panels.ts'

type ChallengeModule = { ChallengeHistory: (props: { challenge: Challenge }) => React.ReactNode }

// tsx compiles the component's JSX for the classic runtime here (the app's tsconfig is not the root one): give it React. The
// path is a variable so that tsconfig.node.json, which has no `jsx`, never type-checks the component; tsconfig.app.json does.
Object.assign(globalThis, { React })
const component = '../../src/projects/Challenge.tsx'
const { ChallengeHistory } = await import(component) as ChallengeModule
const { createElement } = React

type Challenge = NonNullable<RunInputs['challenge']>

const challenge = (fields: Partial<Challenge>): Challenge => ({
  status: 'passed', attempt: 3, attempts: 3, session_id: 's', pinned: { tasks_sha256: 'a'.repeat(64), decisions_sha256: 'b'.repeat(64), prd_sha256: null },
  concerns: [], simpler_alternative: 'x', cheap_experiment: 'y', accepted_reason: null, decided_at: '2026-03-05T08:50:49Z', hold: null, history: [], ...fields,
})
const history: Challenge['history'] = [
  { attempt: 1, status: 'paused', decided_at: '2026-03-05T08:45:00Z', concerns: [{ severity: 'P1', kind: 'failure_mode', message: 'Both lanes edit the contract.', consequence: 'The merge conflicts.' }] },
  { attempt: 2, status: 'paused', decided_at: '2026-03-05T08:46:00Z', concerns: [{ severity: 'P0', kind: 'assumption', message: 'The PRD contradicts the task.', consequence: 'Lanes build the wrong page.' }] },
]

test('the challenge page lists each earlier attempt with its P0/P1 concerns', () => {
  const markup = renderToStaticMarkup(createElement(ChallengeHistory, { challenge: challenge({ history }) }))
  assert.match(markup, /data-testid="challenge-history"/)
  assert.match(markup, /Attempt 1 · paused/)
  assert.match(markup, /P1.*Both lanes edit the contract\./)
  assert.match(markup, /The merge conflicts\./)
  assert.match(markup, /Attempt 2 · paused/)
  assert.match(markup, /P0.*The PRD contradicts the task\./)
  assert.ok(markup.indexOf('Attempt 1') < markup.indexOf('Attempt 2'))
  // A single attempt, and a server before 1.7.0 (no history), render nothing.
  assert.equal(renderToStaticMarkup(createElement(ChallengeHistory, { challenge: challenge({}) })), '')
  assert.equal(renderToStaticMarkup(createElement(ChallengeHistory, { challenge: challenge({ history: undefined }) })), '')
})

test('the section index points at the earlier attempts when there are any', () => {
  assert.deepEqual(challengeSectionEntries(challenge({ history })).map(entry => entry.key), ['alternative', 'history'])
  assert.deepEqual(challengeSectionEntries(challenge({ history })).at(-1), { key: 'history', label: 'Earlier attempts', count: 2 })
  assert.deepEqual(challengeSectionEntries(challenge({})).map(entry => entry.key), ['alternative'])
})
