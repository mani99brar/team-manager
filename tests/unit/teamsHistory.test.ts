/**
 * The Team view's drawer history, deep links and view-wide search after the final review (src/projects/teams/model.ts,
 * docs/PRD_RUN_TEAMS.md 2, 3.3, 3.5, 3.8): an open pushes only when no drawer is open and Close goes back only from the drawer
 * entry the view pushed (F8.1, F10.1); a card and the earlier-workflows disclosure open at mount for a selection or search the
 * URL already holds (F9.1); a drawer opened from a view-wide search keeps the search view-wide (F11.1).
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { teams as example } from '../../contracts/projects/teamExamples.ts'
import type { TeamWorkflow } from '../../contracts/projects/teams.ts'
import { cardOpensAtMount, closedQuery, closeMode, earlierWanted, filterFor, openMode, openQuery, viewSearchOf, wideSearch } from '../../src/projects/teams/model.ts'

const EMPTY = { session: null, workflow: null, agent: null, state: null, phase: null, q: '' }
const [finished, live] = example.sessions[0]!.workflows as [TeamWorkflow, TeamWorkflow]
const SESSION = example.sessions[0]!.key

describe('F8.1 / F10.1: the drawer history', () => {
  test('an open pushes with no drawer open and replaces while one is open', () => {
    assert.equal(openMode(EMPTY), 'push')
    const open = { ...EMPTY, session: SESSION, workflow: finished.run_id, agent: 5 }
    assert.equal(openMode(open), 'replace')
  })
  test('Close goes back only from the drawer entry the view pushed; any other entry is replaced', () => {
    assert.equal(closeMode('k2', 'k2'), 'back')
    assert.equal(closeMode('k3', 'k2'), 'replace', 'a deep link or another entry')
    assert.equal(closeMode('k2', null), 'replace', 'nothing pushed (a reload)')
    assert.equal(closeMode(null, null), 'replace', 'an entry without a key')
  })
  test('Close lands on the selection without the agent, keeping the filters set while the drawer was open', () => {
    const open = { ...EMPTY, session: SESSION, workflow: finished.run_id, agent: 5, state: 'failed' as const, q: 'gpt' }
    assert.deepEqual(closedQuery(open, false), { ...open, agent: null })
  })
})

describe('F9.1: deep links open what they name at mount', () => {
  test('a folded card opens at mount when the selection names it or the view-wide search matches it', () => {
    assert.equal(cardOpensAtMount(finished, false, EMPTY, SESSION, ''), false, 'an older completed card folds')
    assert.equal(cardOpensAtMount(finished, false, { session: SESSION, workflow: finished.run_id }, SESSION, ''), true)
    assert.equal(cardOpensAtMount(finished, false, { session: 'worker:other', workflow: finished.run_id }, SESSION, ''), false)
    assert.equal(cardOpensAtMount(finished, false, EMPTY, SESSION, 'review'), true)
    assert.equal(cardOpensAtMount(finished, false, EMPTY, SESSION, 'no-such-agent'), false)
    assert.equal(cardOpensAtMount(live, true, EMPTY, SESSION, ''), true, 'the latest card always starts open')
  })
  test('the earlier-workflows disclosure opens for a selected tucked workflow or a search matching one', () => {
    const earlier = [finished]
    assert.equal(earlierWanted(earlier, EMPTY, SESSION, ''), false)
    assert.equal(earlierWanted(earlier, { session: SESSION, workflow: finished.run_id }, SESSION, ''), true)
    assert.equal(earlierWanted(earlier, { session: SESSION, workflow: live.run_id }, SESSION, ''), false)
    assert.equal(earlierWanted(earlier, EMPTY, SESSION, 'review'), true)
  })
})

describe('F11.1: a drawer opened from a view-wide search', () => {
  const search = { ...EMPTY, q: 'review' }
  const opened = openQuery(search, SESSION, finished.run_id, 5, true)
  const mark = { key: 'k2', q: 'review' }
  test('the open keeps the search, and opening another workflow\'s agent from it keeps it too', () => {
    assert.equal(opened.q, 'review')
    assert.equal(openQuery(opened, SESSION, live.run_id, 2, true).q, 'review')
    assert.equal(openQuery(opened, SESSION, live.run_id, 2).q, '', 'a card-scoped search still resets for another workflow')
  })
  test('the search stays view-wide while the marked entry is current with the same text, no state or phase, and an agent', () => {
    assert.equal(wideSearch(opened, mark, 'k2'), true)
    assert.equal(wideSearch(opened, mark, 'k3'), false, 'another entry')
    assert.equal(wideSearch(opened, null, 'k2'), false)
    assert.equal(wideSearch({ ...opened, q: 'gpt' }, mark, 'k2'), false, 'a new search text')
    assert.equal(wideSearch({ ...opened, state: 'failed' }, mark, 'k2'), false, 'a card filter')
    assert.equal(wideSearch({ ...opened, agent: null }, mark, 'k2'), false, 'the drawer closed')
  })
  test('the field keeps its text and every card stays filtered while wide; Close returns to the view-wide search', () => {
    assert.equal(viewSearchOf(opened, true), 'review')
    assert.equal(viewSearchOf(opened, false), '')
    assert.equal(filterFor(opened, { key: SESSION }, live, false, null, true).q, 'review')
    assert.equal(filterFor(opened, { key: SESSION }, live, false, null, false).q, '')
    assert.deepEqual(closedQuery(opened, true), search)
  })
})
