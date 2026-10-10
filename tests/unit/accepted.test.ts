/**
 * The operator override in the viewer (decisions.md L7, L12, L13): a run with `accepted` is served succeeded, and every
 * status-keyed site checks `accepted` first: the chip tone, the row text, the Recent filters, the project tone, the finished
 * test, the Needs-you and Running sections, the triage headline and the Untried test.
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { acceptedFindingsText, acceptedOf, deriveNow, deriveAttention, isUntried } from '../../contracts/projects/triage.ts'
import { validateRunDetail, type RunAccepted, type RunActivity, type RunSummary } from '../../contracts/projects/v1.ts'
import { filterRecent, homeSections, isFinished, projectTone, rowSummary, rowTime, waitingKind } from '../../src/projects/lists.ts'
import { OVERRIDE_LABEL } from '../../src/projects/status.ts'
import { stateTone, TONE_LABEL } from '../../src/projects/tone.ts'
import { definition, laneGraphNodes, runDetail } from '../project-workflows/fixtures.ts'

const NOW = Date.parse('2026-03-20T12:00:00Z')
const DEFINITION = definition('alpha-project', 'ux-lists', 'Feature implementation', laneGraphNodes(['ui']))
const CANDIDATE = 'b'.repeat(40)

const accepted = (fields: Partial<RunAccepted> = {}): RunAccepted => ({
  candidate: CANDIDATE, reason: 'merged by hand', by: 'operator', accepted_at: '2026-03-20T10:00:00Z', on_main: true, review: 'recorded', abandoned: null,
  open_findings: [{ severity: 'P1', reviewer: 'coverage', title: 'Fail-safe path uncovered', lane: 'ui' }], ...fields,
})
const activity = (fields: Partial<RunActivity> = {}): RunActivity => ({
  feature: 'f', last_activity_at: null, finished_at: '2026-03-20T10:00:00Z', focus: null, attention: null, waiting_questions: 0, headline: null, controller: null, ...fields,
})
function summary(runId: string, status: RunSummary['status'], fields: Partial<RunSummary> = {}): RunSummary {
  return {
    contract_version: '1.0.0', project_id: 'alpha-project', workflow_id: 'ux-lists', definition_revision: DEFINITION.definition_revision, run_id: runId, status,
    created_at: '2026-03-20T09:00:00Z', updated_at: '2026-03-20T10:00:00Z', ...fields,
  }
}
const acceptedDetail = (override: RunAccepted | null, status: RunSummary['status'] = 'succeeded') => {
  const base = runDetail('accepted', status, DEFINITION, '2026-03-20T09:00:00Z', '2026-03-20T10:00:00Z', {}, 4)
  return validateRunDetail({ ...base, summary: { ...base.summary, ...override ? { accepted: override } : {} }, ...override ? { accepted: override } : {} })
}

describe('an accepted run is finished (L7, L12)', () => {
  test('isFinished checks accepted first, for a summary and for a bare status', () => {
    assert.equal(isFinished(summary('a', 'paused', { accepted: accepted() })), true)
    assert.equal(isFinished(summary('a', 'paused')), false)
    assert.equal(isFinished('succeeded'), true)
    assert.equal(isFinished('running'), false)
  })
  test('an accepted run that was never abandoned is neither in Needs you nor running', () => {
    const rows = [
      { run: summary('plain-blocked', 'failed', { contract_version: '1.5.0', activity: activity() }) },
      { run: summary('accepted-running-shape', 'running', { contract_version: '1.5.0', accepted: accepted(), activity: activity({ attention: { kind: 'question', node_id: 'launch_ui', since: null }, waiting_questions: 1 }) }) },
      { run: summary('accepted-plain', 'succeeded', { contract_version: '1.5.0', accepted: accepted(), activity: activity() }) },
    ]
    assert.equal(waitingKind(rows[1].run), null)
    const sections = homeSections(rows, NOW)
    assert.deepEqual(sections.needsYou.map(row => row.run.run_id), [])
    assert.deepEqual(sections.running.map(row => row.run.run_id), [])
    assert.deepEqual(sections.paused.map(row => row.run.run_id), [])
    // They ended today, so they sit under Today (Recent after the day).
    assert.deepEqual([...sections.today, ...sections.recent].map(row => row.run.run_id).sort(), ['accepted-plain', 'accepted-running-shape', 'plain-blocked'])
  })
})

describe('the override reads as its own outcome', () => {
  test('rowSummary names the override, the short candidate and the reason; a run without it reads as before', () => {
    assert.equal(rowSummary(summary('a', 'succeeded', { accepted: accepted() })), `${OVERRIDE_LABEL} bbbbbbb: merged by hand`)
    assert.equal(rowSummary(summary('a', 'succeeded')), 'Succeeded')
    assert.equal(rowSummary(summary('a', 'cancelled')), 'Cancelled')
  })
  test('rowTime treats an accepted run as finished', () => {
    assert.equal(rowTime(summary('a', 'paused', { accepted: accepted() }), NOW).kind, 'updated')
  })
  test('filterRecent: not under Failed, under Succeeded with the marker', () => {
    const rows = [{ run: summary('a', 'succeeded', { accepted: accepted() }) }, { run: summary('b', 'failed') }, { run: summary('c', 'succeeded') }]
    assert.deepEqual(filterRecent(rows, 'failed', NOW, 'utc').map(row => row.run.run_id), ['b'])
    assert.deepEqual(filterRecent(rows, 'succeeded', NOW, 'utc').map(row => row.run.run_id), ['a', 'c'])
    assert.ok(rows[0].run.accepted, 'the marker the row chip reads')
  })
  test('projectTone and stateTone give the override its own tone, not ok', () => {
    assert.equal(projectTone([summary('a', 'succeeded', { accepted: accepted() })]), 'override')
    assert.equal(projectTone([summary('a', 'succeeded')]), 'ok')
    assert.equal(stateTone({ status: 'succeeded', accepted: accepted() }), 'override')
    assert.equal(stateTone({ status: 'succeeded' }), 'ok')
    // A live run keeps its tone above the override; the override sits where ok does.
    assert.equal(projectTone([summary('a', 'succeeded', { accepted: accepted() }), summary('b', 'running')]), 'run')
    assert.equal(projectTone([summary('a', 'succeeded', { accepted: accepted() }), summary('b', 'awaiting_approval')]), 'warn')
    assert.equal(TONE_LABEL.override, 'Integrated (operator override)')
  })
})

describe('triage reads accepted first', () => {
  test('an accepted run (even one that was abandoned) has the override glyph and headline, nothing to do and no attention', () => {
    const detail = acceptedDetail(accepted({ abandoned: 'Abandoned by the operator: usage limit' }))
    assert.deepEqual(acceptedOf(detail), detail.accepted)
    const now = deriveNow({ detail, events: [] })
    assert.equal(now.situation, 'accepted')
    assert.equal(now.glyph, '◆')
    assert.equal(now.tone, 'override')
    assert.equal(now.next.action, 'none')
    assert.ok(JSON.stringify(now.headline).includes('Integrated (operator override) bbbbbbb'))
    assert.equal(deriveAttention({ detail, events: [] }).top, null)
  })
  test('a run without it keeps its situation', () => {
    assert.notEqual(deriveNow({ detail: acceptedDetail(null), events: [] }).situation, 'accepted')
  })
  test('an accepted, tryout-required run with no verdicts is not untried', () => {
    const inputs = { tryout: { required: true, verdicts: [], allow_untried: null } } as never
    assert.equal(isUntried({ detail: acceptedDetail(null), inputs }), true)
    assert.equal(isUntried({ detail: acceptedDetail(accepted()), inputs }), false)
  })
})

describe('the findings line', () => {
  test('lists the severities, says none when none, and says no review when none was recorded', () => {
    assert.equal(acceptedFindingsText(accepted()), '1 open finding at acceptance: P1')
    assert.equal(acceptedFindingsText(accepted({ open_findings: [] })), 'no open findings at acceptance')
    assert.equal(acceptedFindingsText(accepted({ review: 'none', open_findings: [] })), 'no review recorded')
  })
})
