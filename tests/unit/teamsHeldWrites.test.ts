/**
 * The Team view's held writes (src/projects/teams/model.ts `foldHeldWrite`, docs/PRD_RUN_TEAMS.md 3.8, final review F4.1):
 * while the Back that leaves a pushed drawer entry is on its way, each further write is folded into the held ones as if Back
 * had landed, so no keystroke is lost and an agent open keeps its push.
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { foldHeldWrite, heldQuery, type HeldWrites } from '../../src/projects/teams/model.ts'

type Q = { session: string | null; workflow: string | null; agent: number | null; state: null; phase: null; q: string }
const EMPTY: Q = { session: null, workflow: null, agent: null, state: null, phase: null, q: '' }
const search = (q: string): Q => ({ ...EMPTY, q })
const opened = (q: string, agent: number): Q => ({ ...EMPTY, session: 'worker:ui', workflow: 'wf_1', agent, q })

describe('F4.1: writes held while the drawer Back is on its way', () => {
  test('keystrokes typed before popstate build on each other: "r", "re", "rev" land as "rev" and show at once', () => {
    let held: HeldWrites<Q, string> | null = foldHeldWrite<Q, string>(null, search('r'), 'replace')
    assert.equal(heldQuery(held).q, 'r', 'the first keystroke shows before Back lands')
    held = foldHeldWrite(held, { ...heldQuery(held), q: heldQuery(held).q + 'e' }, 'replace')
    held = foldHeldWrite(held, { ...heldQuery(held), q: heldQuery(held).q + 'v' }, 'replace')
    assert.equal(heldQuery(held).q, 'rev')
    assert.deepEqual(held, { base: search('rev'), baseThen: null, push: null, pushThen: null })
  })
  test('an agent open (push) during the window is held as a push after the landed selection, with its then', () => {
    let held: HeldWrites<Q, string> | null = foldHeldWrite<Q, string>(null, search('rev'), 'replace')
    held = foldHeldWrite(held, opened('rev', 3), 'push', 'mark')
    assert.deepEqual(held.base, search('rev'), 'the selection to land on is kept')
    assert.deepEqual(held.push, opened('rev', 3))
    assert.equal(held.pushThen, 'mark')
    assert.deepEqual(heldQuery(held), opened('rev', 3), 'the drawer shows at once')
  })
  test('another row (a replace naming an agent) while a push is held rewrites that push, keeping it a push', () => {
    let held: HeldWrites<Q, string> | null = foldHeldWrite<Q, string>(null, search('rev'), 'replace')
    held = foldHeldWrite(held, opened('rev', 3), 'push', 'mark')
    held = foldHeldWrite(held, opened('rev', 4), 'replace')
    assert.deepEqual(held.push, opened('rev', 4))
    assert.equal(held.pushThen, 'mark', 'the push keeps its then when the rewrite brings none')
    assert.deepEqual(held.base, search('rev'))
  })
  test('a replace that clears the agent after a held push drops the push and becomes the selection to land on', () => {
    let held: HeldWrites<Q, string> | null = foldHeldWrite<Q, string>(null, search('rev'), 'replace')
    held = foldHeldWrite(held, opened('rev', 3), 'push', 'mark')
    held = foldHeldWrite(held, search('revi'), 'replace')
    assert.deepEqual(held, { base: search('revi'), baseThen: null, push: null, pushThen: null })
  })
})
