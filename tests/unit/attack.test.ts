/**
 * The attack pass section's model (docs/PRD_ATTACK_PASS.md 4.6, Appendix A): counts as the closing event names them, the
 * effective severity of a verified finding, the current label, the verified and folded orders and the label command; and
 * the triage rule that the report-only attack node never takes the run's focus, headline or current step. Read on the
 * Appendix A example and on the records the browser fixtures serve.
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { attackRecord as example } from '../../contracts/projects/examples.ts'
import { deriveAttention, deriveFocus, deriveNow, textToString } from '../../contracts/projects/triage.ts'
import type { AttackFinding } from '../../contracts/projects/v1.ts'
import {
  attackCounts, attackerDuration, attackHeadline, costText, countsText, currentLabel, effectiveSeverity, foldedFindings, labelCommand, rerunLine, rerunReason, unlabelled,
  verifiedFindings,
} from '../../src/projects/attack.ts'
import { nodePhase } from '../../src/projects/node/model.ts'
import { executorOf, isAttackNode } from '../../src/projects/status.ts'
import { shortStepLabel } from '../../src/projects/steps.ts'
import { definition, runDetail, type NodeState } from '../project-workflows/fixtures.ts'
import {
  APPENDIX_A, ATTACK_RESULTS, RUN_ATTACK_BLOCKED, RUN_ATTACK_LIVE, RUN_ATTACK_PENDING, RUN_ATTACK_VERIFIED, attackNodes, resultAfterSkeptic,
} from '../project-workflows/fixtures/ux-attack.ts'

const ids = (findings: readonly AttackFinding[]) => findings.map(finding => finding.id)
const verified = ATTACK_RESULTS[RUN_ATTACK_VERIFIED]

describe('the attack module is pure and the fixtures hold Appendix A', () => {
  test('it imports no React, so the section and these tests read the same values', () => {
    const source = readFileSync(new URL('../../src/projects/attack.ts', import.meta.url), 'utf8')
    assert.doesNotMatch(source, /from 'react'|\.tsx'/)
  })
  test('the browser fixtures\' Appendix A literal is the committed example, which the contract test reads from the PRD', () => {
    assert.deepEqual(APPENDIX_A, example)
  })
})

describe('attackCounts and the headline', () => {
  test('Appendix A: 2 findings, 1 reproduced, 1 verified, in the closing event\'s wording', () => {
    assert.deepEqual(attackCounts(example), { findings: 2, reproduced: 1, verified: 1 })
    assert.equal(countsText(attackCounts(example)), '2 finding(s), 1 reproduced, 1 verified')
    assert.deepEqual(attackHeadline(example), { status: 'Succeeded', counts: '2 finding(s), 1 reproduced, 1 verified' })
  })
  test('the integrated fixture counts a reproduced finding whatever the skeptic said: 5 findings, 4 reproduced, 2 verified', () => {
    assert.deepEqual(attackCounts(verified), { findings: 5, reproduced: 4, verified: 2 })
  })
  test('a pending pass names only its status; a live pass moves to the next counts', () => {
    assert.deepEqual(attackHeadline(ATTACK_RESULTS[RUN_ATTACK_PENDING]), { status: 'Pending: runs at the review step', counts: null })
    assert.deepEqual(attackHeadline(ATTACK_RESULTS[RUN_ATTACK_LIVE]), { status: 'Running', counts: '2 finding(s), 1 reproduced, 0 verified' })
    assert.deepEqual(attackHeadline(resultAfterSkeptic()), { status: 'Succeeded', counts: '2 finding(s), 1 reproduced, 1 verified' })
  })
})

describe('effectiveSeverity and currentLabel', () => {
  test('a verified finding shows the skeptic\'s severity; any other finding its own', () => {
    const a3 = verified.findings.find(finding => finding.id === 'A-3')!
    assert.deepEqual([a3.severity, effectiveSeverity(a3)], ['P0', 'P1'])
    const refuted = verified.findings.find(finding => finding.id === 'A-4')!
    assert.equal(effectiveSeverity({ ...refuted, skeptic: { ...refuted.skeptic!, severity: 'P2' }, severity: 'P1' }), 'P1')
    assert.equal(effectiveSeverity({ ...a3, skeptic: null }), 'P0')
  })
  test('the latest entry of labels is the current label; none is unlabelled', () => {
    const a1 = example.findings[0]
    assert.equal(currentLabel(a1)?.label, 'real')
    const relabelled = { ...a1, labels: [...a1.labels, { label: 'false' as const, review_found: 'yes' as const, note: 'test asserts a rule the PRD lacks', by: 'operator' as const, at: '2026-10-05T13:00:00Z' }] }
    assert.equal(currentLabel(relabelled)?.label, 'false')
    assert.equal(currentLabel(example.findings[1]), null)
    assert.equal(unlabelled(verified), 1)
    assert.equal(unlabelled(example), 0)
  })
})

describe('verifiedFindings and foldedFindings', () => {
  test('verified cards by the severity shown then by id; the rest folded: unjudged, refuted, not reproduced', () => {
    assert.deepEqual(ids(verifiedFindings(verified)), ['A-1', 'A-3'])
    assert.deepEqual(ids(foldedFindings(verified)), ['A-5', 'A-4', 'A-2'])
    const swapped = { findings: verified.findings.map(finding => finding.id === 'A-1' ? { ...finding, skeptic: { ...finding.skeptic!, severity: 'P2' as const } } : finding) }
    assert.deepEqual(ids(verifiedFindings(swapped)), ['A-3', 'A-1'])
    const many = { findings: ['A-10', 'A-2'].map(id => ({ ...example.findings[1], id })) }
    assert.deepEqual(ids(foldedFindings(many)), ['A-2', 'A-10'])
  })
  test('a folded finding names its re-run reason; a reproduced one has none', () => {
    assert.equal(rerunReason(example.findings[1]), 'the test passed on the clean copy')
    assert.equal(rerunReason(example.findings[0]), null)
    assert.equal(rerunReason({ rerun: null }), null)
  })
  test('a not-reproduced finding whose re-run is still owed (rerun null, decisions L15) reads pending on a live pass, not re-run on a terminal one', () => {
    const owed: Pick<AttackFinding, 'status' | 'rerun'> = { status: 'not_reproduced', rerun: null }
    assert.equal(rerunLine({ status: 'running' }, owed), 're-run pending')
    assert.equal(rerunLine({ status: 'pending' }, owed), 're-run pending')
    assert.equal(rerunLine({ status: 'succeeded' }, owed), 'not re-run')
    assert.equal(rerunLine({ status: 'failed' }, owed), 'not re-run')
    // A finding the re-run did reach keeps its reason wording, prefixed `re-run:`, whatever the pass status.
    assert.equal(rerunLine({ status: 'running' }, example.findings[1]), 're-run: the test passed on the clean copy')
    assert.equal(rerunLine({ status: 'succeeded' }, example.findings[0]), null)
  })
})

describe('the label command, cost and duration', () => {
  test('the command names the global id, the three labels and the operator; nothing runs it', () => {
    assert.equal(labelCommand('A-3'), '"$PY" -m workflow attack-label "$RUN" A-3 --label real|false|out-of-scope --by operator')
  })
  test('cost and duration read the record, a missing value says so', () => {
    assert.equal(costText(7.42), '$7.42')
    assert.equal(costText(15), '$15.00')
    assert.equal(costText(null), '—')
    assert.equal(attackerDuration(example.attackers[0]), (39 * 60 + 32) * 1000)
    assert.equal(attackerDuration({ started_at: '2026-10-05T10:00:00Z', finished_at: null }), null)
  })
})

describe('the attack node in the run', () => {
  const NODES = attackNodes(true)
  const pinned = definition('md-manager', 'ux-attack', 'UX attack pass', NODES)
  const done: NodeState = { status: 'succeeded', attempt: 1 }
  const before: Record<string, NodeState> = Object.fromEntries(['launch_ui', 'launch_adapter', 'handoff', 'verify_ui', 'verify_adapter', 'candidate'].map(id => [id, done]))
  const row = (sequence: number, node_id: string, status: 'running' | 'succeeded', message: string) => ({
    contract_version: '1.0.0' as const, run_id: 'r', event_id: `r:${sequence}`, sequence, occurred_at: `2026-10-05T10:${String(30 + sequence).padStart(2, '0')}:00Z`,
    node_id, attempt: 1, type: 'status_changed' as const, status, message, artifact: null, result_uri: null, reused_from_attempt: null,
  })
  test('it is a review-kind node with no phase of its own, its own short label and executor wording', () => {
    const node = NODES.find(candidate => candidate.node_id === 'attack')!
    assert.ok(isAttackNode(node))
    assert.equal(nodePhase(node), null)
    assert.equal(shortStepLabel(node), 'Attack')
    assert.equal(executorOf('review', undefined, 'attack'), 'one print job per angle and a skeptic')
    assert.equal(isAttackNode({ node_id: 'attack', kind: 'worker' }), false)
  })
  test('while the review runs the review is the focus, never the attack node', () => {
    const detail = runDetail('r', 'running', pinned, '2026-10-05T10:00:00Z', '2026-10-05T10:40:00Z', { ...before, review: { status: 'running', attempt: 1 }, attack: { status: 'running', attempt: 1 } }, 2)
    const events = [row(1, 'review', 'running', 'Launching reviewer general'), row(2, 'attack', 'running', 'Attack pass started (auth-funds)')]
    assert.equal(deriveFocus(detail, events)?.node_id, 'review')
  })
  test('after the review decided, the attack node running alone keeps the review as the focus and step, never the attack node', () => {
    const detail = runDetail('r', 'running', pinned, '2026-10-05T10:00:00Z', '2026-10-05T10:40:00Z', { ...before, review: done, attack: { status: 'running', attempt: 1 } }, 3)
    const events = [row(1, 'review', 'running', 'Launching reviewer general'), row(2, 'attack', 'running', 'Attack pass started (auth-funds)'), row(3, 'review', 'succeeded', 'approved')]
    // The run is still in its review step while the controller waits for the report-only pass: the review keeps the focus.
    const focus = deriveFocus(detail, events)
    assert.equal(focus?.node_id, 'review')
    assert.equal(focus?.status, 'succeeded')
    const run = { detail, events, inputs: null, review: null, results: new Map() }
    assert.equal(deriveAttention(run).top, null)
    const now = deriveNow(run)
    assert.equal(now.focus?.node_id, 'review')
    const headline = textToString(now.headline, Date.parse('2026-10-05T10:40:00Z'), { clock: at => at, ago: () => 'now', span: () => '1m' })
    assert.match(headline, /review/i)
    assert.doesNotMatch(headline, /between steps/)
    assert.doesNotMatch(headline, /Attack pass/)
  })
  test('a blocked review keeps the focus too while the attack pass runs on (its blocked event precedes the wait)', () => {
    const detail = runDetail('r', 'running', pinned, '2026-10-05T10:00:00Z', '2026-10-05T10:40:00Z', { ...before, review: { status: 'failed', attempt: 1 }, attack: { status: 'running', attempt: 1 } }, 3)
    const events = [row(1, 'review', 'running', 'Launching reviewer general'), row(2, 'attack', 'running', 'Attack pass started (auth-funds)'), row(3, 'review', 'succeeded', 'blocked')]
    assert.equal(deriveFocus(detail, events)?.node_id, 'review')
  })
  test('the fixtures\' blocked run keeps its record whatever the review decided', () => {
    assert.equal(ATTACK_RESULTS[RUN_ATTACK_BLOCKED].status, 'succeeded')
  })
})
