/**
 * The review sidecar's page model (docs/PRD_REVIEW_SIDECAR.md 4.9): the one headline, open findings P0/P1 first then by id,
 * the closed ones apart, a finding's latest values against its history, message and pass wording, and the section index.
 * Read on the Appendix B example and on the live ledger the browser fixtures serve.
 */
import { afterEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { sidecarLedger as example } from '../../contracts/projects/examples.ts'
import { validateSidecarLedger, type SidecarFinding, type SidecarLedger } from '../../contracts/projects/v1.ts'
import {
  failedPasses, findingGroups, headlineText, lastTransition, messageStatusWording, openFindings, passDuration, passLanes, resolvedFindings, sidecarHeadline,
  sidecarSectionEntries,
} from '../../src/projects/node/sidecar.ts'
import { fetchSidecarLedger, NOT_RECORDED, orNotRecorded, ProjectsApiError } from '../../src/projects/api.ts'
import { RUN_SIDECAR, SIDECAR_LEDGERS, ledgerAfterNextPass } from '../project-workflows/fixtures/ux-sidecar.ts'

const live = SIDECAR_LEDGERS[RUN_SIDECAR]
const format = { clock: (iso: string) => `${iso.slice(11, 16)} UTC`, ago: (iso: string) => `${Math.round((Date.parse('2026-10-01T13:54:00Z') - Date.parse(iso)) / 60_000)} min ago` }
const finding = (overrides: Partial<SidecarFinding>): SidecarFinding => ({ ...example.findings[1], history: [], messages: [], ...overrides })
const ids = (findings: readonly SidecarFinding[]) => findings.map(item => item.id)

describe('the sidecar module is pure', () => {
  test('it imports no React, so the page and these tests read the same values', () => {
    const source = readFileSync(new URL('../../src/projects/node/sidecar.ts', import.meta.url), 'utf8')
    assert.doesNotMatch(source, /from 'react'|\.tsx'/)
  })
})

describe('sidecarHeadline', () => {
  test('passes, open findings by severity, messages and the last pass, in one line', () => {
    assert.equal(headlineText(sidecarHeadline(example), format), '1 of 3 passes failed · 2 open (1 P1) · 1 message delivered, 1 refused · last pass 13:05 UTC (49 min ago)')
  })

  test('failed passes are counted: every pass that did not complete (failed, timed out, rejected, interrupted)', () => {
    assert.equal(failedPasses(live), 2)
    assert.equal(headlineText(sidecarHeadline(live), format), '2 of 6 passes failed · 3 open (2 P1) · 2 messages delivered, 1 undeliverable, 1 refused · last pass 13:50 UTC (4 min ago)')
    const allCompleted = structuredClone(example)
    allCompleted.passes = allCompleted.passes.filter(pass => pass.status === 'completed')
    assert.equal(sidecarHeadline(allCompleted).passes, '2 passes')
    const kinds = structuredClone(example)
    for (const [index, status] of (['rejected', 'interrupted', 'timed_out'] as const).entries()) kinds.passes[index].status = status
    assert.equal(sidecarHeadline(kinds).passes, '3 of 3 passes failed')
  })

  test('no pass yet: a ledger without passes, and no ledger at all', () => {
    const empty = { ...structuredClone(example), passes: [], findings: [], messages: [] }
    assert.equal(headlineText(sidecarHeadline(empty), format), 'no pass yet')
    assert.equal(headlineText(sidecarHeadline(null), format), 'no pass yet')
  })

  test('P0s are named before P1s; nothing open says so; no message says so', () => {
    const value = structuredClone(example)
    value.findings.push(finding({ id: 'S-3', severity: 'P0' }), finding({ id: 'S-4', severity: 'P1', disposition: 'acknowledged' }))
    assert.equal(sidecarHeadline(value).open, '4 open (1 P0, 2 P1)')
    value.findings = value.findings.map(item => ({ ...item, disposition: 'withdrawn' as const }))
    value.messages = []
    assert.equal(sidecarHeadline(value).open, 'nothing open')
    assert.equal(sidecarHeadline(value).messages, 'no message')
  })
})

describe('ordering and grouping', () => {
  test('open findings: P0 and P1 first, then by id (S-10 after S-9)', () => {
    const value = structuredClone(example)
    value.findings = [
      finding({ id: 'S-10', severity: 'P2' }), finding({ id: 'S-9', severity: 'P2' }), finding({ id: 'S-11', severity: 'P1', disposition: 'fix_reported' }),
      finding({ id: 'S-2', severity: 'P0', disposition: 'acknowledged' }), finding({ id: 'S-1', severity: 'P2', disposition: 'verified_resolved' }),
    ]
    assert.deepEqual(ids(openFindings(value)), ['S-2', 'S-11', 'S-9', 'S-10'])
    assert.deepEqual(ids(openFindings(live)), ['S-1', 'S-3', 'S-2'])
  })

  test('grouping by disposition: open, acknowledged and fix_reported are open; the rest are resolved, by id', () => {
    const value = structuredClone(example)
    value.findings = (['open', 'acknowledged', 'fix_reported', 'verified_resolved', 'withdrawn', 'accepted_trade_off'] as const)
      .map((disposition, index) => finding({ id: `S-${6 - index}`, disposition }))
    const groups = findingGroups(value)
    assert.deepEqual(groups.open.map(item => item.disposition).sort(), ['acknowledged', 'fix_reported', 'open'])
    assert.deepEqual(ids(groups.resolved), ['S-1', 'S-2', 'S-3'])
    assert.deepEqual(groups.resolved.map(item => item.disposition), ['accepted_trade_off', 'withdrawn', 'verified_resolved'])
    assert.deepEqual(ids(resolvedFindings(live)), ['S-4'])
  })

  test('after the next pass S-1 moves from open to resolved', () => {
    const next = validateSidecarLedger(ledgerAfterNextPass())
    assert.deepEqual(ids(openFindings(next)), ['S-3', 'S-2'])
    assert.deepEqual(ids(resolvedFindings(next)), ['S-1', 'S-4'])
  })
})

describe('a finding, its messages and its passes', () => {
  test('a finding shows its latest values; the last transition is the latest history entry, the creation values history[0]', () => {
    const s1 = example.findings[0]
    assert.equal(s1.revision, 'b2c3d4e')
    assert.deepEqual(lastTransition(s1), { pass: 3, disposition: 'fix_reported', revision: 'b2c3d4e', evidence: s1.evidence, at: '2026-10-01T13:05:00Z' })
    const s4 = live.findings.find(item => item.id === 'S-4')!
    assert.equal(lastTransition(s4).evidence, s4.history.at(-1)!.evidence)
    // Without history the finding's own values stand in.
    assert.deepEqual(lastTransition(finding({ id: 'S-9', evidence: 'seen' })), { pass: null, disposition: 'open', revision: 'working-tree', evidence: 'seen', at: null })
  })

  test('message statuses with their reasons, in words', () => {
    assert.equal(messageStatusWording(example.messages[0]), 'delivered')
    assert.equal(messageStatusWording(example.messages[1]), 'refused: a question was waiting')
    assert.equal(messageStatusWording(live.messages.find(item => item.status === 'undeliverable')!), 'undeliverable: the pane was busy (a dialog, a menu or a draft)')
    assert.equal(messageStatusWording({ ...example.messages[0], status: 'pending', reason: null }), 'pending')
    assert.equal(messageStatusWording({ ...example.messages[0], status: 'undeliverable', reason: 'interrupted' }), 'undeliverable: interrupted before delivery')
  })

  test('a pass: its duration and the lanes it read, naming a pane not captured', () => {
    assert.equal(passDuration(example.passes[0]), 260_000)
    assert.equal(passDuration({ ...example.passes[0], finished_at: 'not a time' }), null)
    assert.deepEqual(passLanes(example.passes[1]), [{ lane: 'engine', head: 'b2c3d4e', pane: false }, { lane: 'viewer', head: 'c3d4e5f', pane: true }])
  })
})

describe('sidecarSectionEntries', () => {
  test('Open, Escalations, Resolved, Messages, Passes and Handoff with their counts, each only when it holds something', () => {
    assert.deepEqual(sidecarSectionEntries(live).map(entry => [entry.key, entry.count]), [
      ['sidecar-open', 3], ['sidecar-escalations', 1], ['sidecar-resolved', 1], ['sidecar-messages', 4], ['sidecar-passes', 6], ['sidecar-handoff', undefined],
    ])
    assert.deepEqual(sidecarSectionEntries(example).map(entry => entry.key), ['sidecar-open', 'sidecar-messages', 'sidecar-passes', 'sidecar-handoff'])
    assert.deepEqual(sidecarSectionEntries(null), [])
  })
})

// The served shape is the contract's: both ledgers above validate.
for (const ledger of [example, live] as SidecarLedger[]) validateSidecarLedger(ledger)

describe('the ledger resource: SIDECAR_NOT_FOUND is "not recorded"', () => {
  const scope = { projectId: 'md-manager', workflowId: 'ux-sidecar', runId: RUN_SIDECAR }
  const answer = (status: number, body: unknown) => async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
  // RunView's loader: a run whose ledger answers 404 SIDECAR_NOT_FOUND loads as null (the page's `sidecar-none`), not an error.
  const load = () => orNotRecorded(fetchSidecarLedger(scope), NOT_RECORDED.sidecar)
  const original = globalThis.fetch
  afterEach(() => { globalThis.fetch = original })

  test('a 404 SIDECAR_NOT_FOUND loads as null', async () => {
    globalThis.fetch = answer(404, { error: { code: 'SIDECAR_NOT_FOUND', message: 'No review sidecar ledger is recorded for this run.' } })
    assert.equal(NOT_RECORDED.sidecar, 'SIDECAR_NOT_FOUND')
    assert.equal(await load(), null)
  })

  test('the ledger loads as itself; any other failure stays an error', async () => {
    globalThis.fetch = answer(200, live)
    assert.equal((await load())!.passes.length, live.passes.length)
    globalThis.fetch = answer(404, { error: { code: 'RUN_NOT_FOUND', message: 'No such run.' } })
    await assert.rejects(load(), (error: unknown) => error instanceof ProjectsApiError && error.code === 'RUN_NOT_FOUND')
    globalThis.fetch = answer(500, { error: { code: 'RUN_STORAGE_INVALID', message: 'Unreadable.' } })
    await assert.rejects(load(), (error: unknown) => error instanceof ProjectsApiError && error.status === 500)
  })
})
