/**
 * The Panel section's model (docs/PRD_MULTI_PROVIDER_PANEL.md 4.5, Appendix A): counts and headline, the overlap threshold in
 * words, the accepted and folded orders, `file:line`, the provider's name and cost line (`subscription-covered` for an
 * openai-codex row, the dollar estimate for a metered one) and the per-stage filter the challenge view uses. Read on the
 * Appendix A records and on the records the browser fixtures serve, which every route-shaped fixture must validate.
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { panelPendingRecord, panelRecord } from '../../contracts/projects/examples.ts'
import { validatePanelResults, type PanelFinding } from '../../contracts/projects/v1.ts'
import {
  acceptedFindings, contextText, costText, countsText, fileLocation, foldedFindings, isSubscriptionCovered, overlapCount, PANEL_STATUS_WORDING, panelCounts, panelDuration, panelHeadline,
  panelsAtStage, PROVIDER_STATUS_WORDING, providerCostText, providerName, stageText, TERMINAL_PANEL, thresholdText,
} from '../../src/projects/node/providerPanel.ts'
import {
  APPENDIX_A, APPENDIX_A_PENDING, PANEL_RESULTS, RUN_PANEL_CHALLENGE, RUN_PANEL_FAILED, RUN_PANEL_LIVE, RUN_PANEL_PENDING, RUN_PANEL_SUCCEEDED, RUN_PANEL_TIMED_OUT, resultAfterProviders, runningRecord,
  succeededRecord,
} from '../project-workflows/fixtures/ux-panel.ts'

const ids = (findings: readonly PanelFinding[]) => findings.map(finding => finding.id)
const example = panelRecord.panels[0]
const succeeded = succeededRecord().panels[0]

describe('the panel model is pure and the fixtures hold Appendix A', () => {
  test('it imports no React, so the section and these tests read the same values', () => {
    const source = readFileSync(new URL('../../src/projects/node/providerPanel.ts', import.meta.url), 'utf8')
    assert.doesNotMatch(source, /from 'react'|\.tsx'/)
  })
  test('the browser fixtures start from the committed Appendix A records, which the contract test reads from the PRD', () => {
    assert.deepEqual(APPENDIX_A, panelRecord)
    assert.deepEqual(APPENDIX_A_PENDING, panelPendingRecord)
    assert.deepEqual(PANEL_RESULTS[RUN_PANEL_PENDING], { contract_version: '1.9.0', source: 'export', ...panelPendingRecord })
  })
  test('every record the fixtures serve validates as panelResults, the live ones as live', () => {
    for (const [runId, result] of Object.entries(PANEL_RESULTS)) assert.doesNotThrow(() => validatePanelResults(result), runId)
    assert.equal(PANEL_RESULTS[RUN_PANEL_LIVE].source, 'live')
    assert.equal(PANEL_RESULTS[RUN_PANEL_SUCCEEDED].source, 'export')
    assert.doesNotThrow(() => validatePanelResults(resultAfterProviders()))
    assert.deepEqual(resultAfterProviders().panels, panelRecord.panels)
  })
})

describe('panelCounts, the headline and the threshold', () => {
  test('Appendix A: 1 finding, 1 accepted; the integrated fixture counts the unanchored finding too: 3 findings, 1 accepted', () => {
    assert.deepEqual(panelCounts(example), { findings: 1, accepted: 1 })
    assert.equal(countsText(panelCounts(example)), '1 finding(s), 1 accepted')
    assert.deepEqual(panelCounts(succeeded), { findings: 3, accepted: 1 })
    assert.deepEqual(panelHeadline(example), { status: 'Succeeded', stage: 'review stage', counts: '1 finding(s), 1 accepted' })
  })
  test('a pending panel says it runs at its stage and names no counts; a running one counts what it has so far', () => {
    assert.deepEqual(panelHeadline(panelPendingRecord.panels[0]), { status: 'Pending: runs at the review stage', stage: 'review stage', counts: null })
    assert.deepEqual(panelHeadline({ ...panelPendingRecord.panels[0], stage: 'challenge' }), { status: 'Pending: runs at the challenge stage', stage: 'challenge stage', counts: null })
    assert.deepEqual(panelHeadline(runningRecord().panels[0]), { status: 'Running', stage: 'review stage', counts: '0 finding(s), 0 accepted' })
    assert.equal(panelHeadline(PANEL_RESULTS[RUN_PANEL_TIMED_OUT].panels[0]).status, 'Timed out')
    assert.equal(panelHeadline(PANEL_RESULTS[RUN_PANEL_FAILED].panels[0]).status, 'Failed')
    assert.equal(stageText({ stage: 'challenge' }), 'challenge stage')
  })
  test('the overlap threshold in words: ≥N providers, every provider, any provider', () => {
    assert.equal(thresholdText(example), 'accepted when raised by ≥2 providers')
    assert.equal(thresholdText({ ...example, overlap_threshold: 3 }), 'accepted when raised by ≥3 providers')
    assert.equal(thresholdText({ ...example, overlap_threshold: 'all' }), 'accepted when raised by every provider (2)')
    assert.equal(thresholdText({ ...succeeded, overlap_threshold: 'all' }), 'accepted when raised by every provider (3)')
    assert.equal(thresholdText({ ...example, overlap_threshold: 1 }), 'accepted when raised by any provider')
  })
  test('every status has a wording; the terminal statuses are succeeded, failed and timed out', () => {
    assert.deepEqual(Object.keys(PANEL_STATUS_WORDING), ['pending', 'running', 'succeeded', 'failed', 'timed_out'])
    assert.deepEqual(Object.keys(PROVIDER_STATUS_WORDING), ['pending', 'running', 'ok', 'timed_out', 'error', 'parse_failed'])
    assert.deepEqual([...TERMINAL_PANEL].sort(), ['failed', 'succeeded', 'timed_out'])
    assert.equal(PROVIDER_STATUS_WORDING.parse_failed, 'parse failed')
  })
})

describe('acceptedFindings and foldedFindings', () => {
  test('accepted cards by severity then id; the rest folded: anchored not accepted first, then unanchored', () => {
    assert.deepEqual(ids(acceptedFindings(succeeded)), ['f1'])
    assert.deepEqual(ids(foldedFindings(succeeded)), ['f2', 'f3'])
    const many = { findings: [
      { ...succeeded.findings[2], id: 'f10', severity: 'P0' as const },
      { ...succeeded.findings[1], id: 'f9', severity: 'P1' as const },
      { ...succeeded.findings[1], id: 'f2', severity: 'P1' as const },
      { ...succeeded.findings[0], id: 'f4', severity: 'P2' as const },
      { ...succeeded.findings[0], id: 'f3', severity: 'P0' as const },
    ] }
    assert.deepEqual(ids(acceptedFindings(many)), ['f3', 'f4'])
    assert.deepEqual(ids(foldedFindings(many)), ['f2', 'f9', 'f10'])
    assert.deepEqual(ids(acceptedFindings(panelPendingRecord.panels[0])), [])
  })
  test('file:line, the file alone without a line, and the overlap count', () => {
    assert.equal(fileLocation(example.findings[0]), 'packages/api/src/modules/claims/reconcile.ts:52')
    assert.equal(fileLocation(succeeded.findings[2]), '.github/workflows/ci.yml')
    assert.equal(overlapCount(example.findings[0]), 2)
    assert.equal(overlapCount(succeeded.findings[1]), 1)
  })
})

describe('providers: name, cost line, context and duration', () => {
  test('a provider is named as providers_raised spells it: the model, or the transport for a default claude', () => {
    assert.deepEqual(example.providers.map(providerName), ['claude', 'openai-codex/gpt-6-sol'])
    assert.deepEqual(example.findings[0].providers_raised, example.providers.map(providerName))
  })
  test('an openai-codex row is subscription-covered, whatever estimate the record keeps; a metered provider shows its estimate', () => {
    const [claude, codex, deepseek] = succeeded.providers
    assert.equal(isSubscriptionCovered(codex), true)
    assert.equal(codex.cost_usd, 0.0047, 'the record keeps pi\'s reported estimate')
    assert.equal(providerCostText(codex), 'subscription-covered')
    assert.equal(isSubscriptionCovered(claude), false)
    assert.equal(providerCostText(claude), '$0.021')
    assert.equal(providerCostText(deepseek), '—')
    assert.equal(providerCostText({ ...deepseek, cost_usd: 0.0047 }), '$0.0047')
    assert.equal(isSubscriptionCovered({ model: 'openai-codex' }), false, 'only a provider/id model of the openai-codex provider')
  })
  test('costText keeps small estimates visible and rounds dollars to cents', () => {
    assert.deepEqual([null, 0, 0.021, 0.0047, 0.5, 0.00001, 1.234, 5, 15].map(costText), ['—', '$0.00', '$0.021', '$0.0047', '$0.50', '$0.00', '$1.23', '$5.00', '$15.00'])
  })
  test('context bytes and the panel duration', () => {
    assert.deepEqual([null, 512, 48213, 150_000].map(contextText), [null, '512 B', '48.2 kB', '150.0 kB'])
    assert.equal(panelDuration(example), 39_000)
    assert.equal(panelDuration(panelPendingRecord.panels[0]), null)
    assert.equal(panelDuration({ started_at: 'yesterday', ended_at: 'today' }), null)
  })
})

describe('panelsAtStage', () => {
  test('the challenge view shows only the challenge-stage panels; the run page every panel', () => {
    const record = PANEL_RESULTS[RUN_PANEL_CHALLENGE]
    assert.deepEqual(panelsAtStage(record.panels, 'challenge').map(panel => panel.id), ['challenge-panel'])
    assert.deepEqual(panelsAtStage(record.panels, 'review').map(panel => panel.id), ['review-panel'])
    assert.deepEqual(panelsAtStage(panelRecord.panels, 'challenge'), [])
  })
})
