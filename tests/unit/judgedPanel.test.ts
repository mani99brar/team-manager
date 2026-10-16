/**
 * The judged panel's model (panel record 1.1.0, features/review-panel-registry/prd.md 8): every seat status in words, the
 * rulings' grouping and order, where each source chip points, the fallback banner and the review section's advisory label.
 * The records are the feature's literal examples.
 */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { fallbackReview, judgeStates, panelFallbackExample, panelJudgedExample, reviewJudgedExample, servedReview } from '../../contracts/projects/judgedExamples.ts'
import { reviewerRole as contractReviewerRole, SEAT_STATUSES, type JudgeRuling, type PanelSeat } from '../../contracts/projects/v1.ts'
import {
  fallbackBanner, groupRulings, JUDGE_STATUS_WORDING, judgedOpenP01, judgeReadFindings, laneText, rulingCountsText, rulingLocation, seatAnchorId, seatCostText, seatCounts, seatDuration,
  seatModelText, seatStatusText, SEAT_STATUS_WORDING, sourceTarget,
} from '../../src/projects/node/judgedPanel.ts'
import {
  ADVISORY_FINDINGS_WORDING, ADVISORY_WORDING, advisedWording, advisoryFindingsWording, DECIDING_WORDING, findingsLegend, isJudgedReview, reviewerRole,
} from '../../src/projects/reviewers.ts'
import { findingFilterIds, reviewFigures } from '../../src/projects/node/panels.ts'
import { reviewBlockedBy } from '../../src/projects/critique.ts'

const judged = () => panelJudgedExample().panels[0]
const fallback = () => panelFallbackExample().panels[0]
const seat = (status: PanelSeat['status'], error: string | null = null): PanelSeat => ({ ...judged().providers[2], status, error })

describe('seat status words (PRD 8)', () => {
  test('every seat status has its word; unavailable adds its reason', () => {
    assert.deepEqual(Object.keys(SEAT_STATUS_WORDING).sort(), [...SEAT_STATUSES].sort())
    const words = Object.fromEntries(SEAT_STATUSES.map(status => [status, seatStatusText(seat(status, status === 'unavailable' ? 'disabled in the reviewer list' : null))]))
    assert.deepEqual(words, {
      pending: 'pending', running: 'running', ok: 'ok', timed_out: 'timed out', error: 'error', parse_failed: 'parse failed',
      unavailable: 'unavailable: disabled in the reviewer list', auth_required: 'not logged in', usage_limit: 'usage limit reached', model_mismatch: 'wrong model served',
    })
    assert.equal(seatStatusText(seat('unavailable')), 'unavailable')
  })

  test('the fallback example reads: gpt timed out, muse not logged in, argon unavailable with its reason', () => {
    assert.deepEqual(fallback().providers.map(seatStatusText), ['ok', 'timed out', 'not logged in', 'unavailable: disabled in the reviewer list'])
  })

  test('model, cost and duration lines', () => {
    const [claude, gpt, muse] = judged().providers
    assert.deepEqual([claude, gpt, muse].map(seatModelText), ['default model', 'openai-codex/gpt-6.1-sol', 'muse-wonder-1.0'])
    assert.equal(seatModelText({ model: 'muse-wonder-1.0', served_model: 'muse-lite-0.9' }), 'muse-wonder-1.0 (served muse-lite-0.9)')
    assert.deepEqual([claude, gpt, muse].map(seatCostText), ['$1.82', 'subscription-covered', 'not reported'])
    // The seats' wait: the panel's start (10:02:11) to the judge's start (10:24:03).
    assert.equal(seatDuration(judged(), muse), (21 * 60 + 52) * 1000)
    assert.equal(seatDuration(fallback(), fallback().providers[3]), null, 'an unavailable seat never ran')
    assert.deepEqual(seatCounts(fallback()), { ok: 1, notOk: 3 })
  })
})

describe('judge status and the fallback banner', () => {
  test('a running judge reads "judging" ([L2]); every status has a word', () => {
    assert.equal(JUDGE_STATUS_WORDING[judgeStates().running.status], 'judging')
    assert.equal(JUDGE_STATUS_WORDING[judgeStates().pending.status], 'not started')
    assert.equal(JUDGE_STATUS_WORDING.judged, 'judged')
  })

  test('the banner names the judge status and today\'s rule, only on a fallback', () => {
    assert.equal(fallbackBanner(fallback().judge), 'Judge timed out: the built-in reviewers decided (today\'s rule); panel findings are unjudged')
    assert.equal(fallbackBanner(judgeStates().incomplete), 'Judge incomplete: the built-in reviewers decided (today\'s rule); panel findings are unjudged')
    assert.equal(fallbackBanner({ status: 'failed', fallback: true }), 'Judge failed: the built-in reviewers decided (today\'s rule); panel findings are unjudged')
    assert.equal(fallbackBanner(judged().judge), null)
    assert.equal(fallbackBanner(judgeStates().running), null)
    assert.equal(fallbackBanner(undefined), null)
  })
})

describe('rulings', () => {
  test('grouped Confirmed (P0/P1 first), then Deferred, then Refuted', () => {
    const groups = groupRulings(judged().judge!.rulings)
    assert.deepEqual(groups.map(group => [group.label, group.rulings.map(ruling => ruling.id)]), [['Confirmed', ['J1', 'J2']], ['Deferred', ['J4']], ['Refuted', ['J3']]])
    // Inside a group a P0/P1 comes before a P2 whatever the J order.
    const base = judged().judge!.rulings[0]
    const rulings: JudgeRuling[] = [
      { ...base, id: 'J1', severity: 'P2' }, { ...base, id: 'J2', severity: 'P1' }, { ...base, id: 'J3', severity: 'P0' }, { ...base, id: 'J10', severity: 'P1' },
    ]
    assert.deepEqual(groupRulings(rulings)[0].rulings.map(ruling => ruling.id), ['J3', 'J2', 'J10', 'J1'])
    assert.deepEqual(groupRulings([]), [])
  })

  test('location, lane and counts', () => {
    const [j1, j2] = judged().judge!.rulings
    assert.equal(rulingLocation(j1), 'workflow/panel.py:212')
    assert.equal(rulingLocation(j2), 'tests/unit/panels.test.ts')
    assert.equal(rulingLocation({ file: null, line: null }), null)
    assert.deepEqual([laneText('engine'), laneText('none'), laneText(null)], ['lane engine', 'no lane', 'no lane'])
    assert.equal(rulingCountsText(judged().judge!.rulings), '2 confirmed (1 P0/P1), 1 deferred, 1 refuted')
    assert.equal(judgedOpenP01(judged()), 1)
    assert.equal(judgedOpenP01(fallback()), null)
  })

  test('source chips: a seat prefix points at that seat, <reviewer_id>-<n> at that reviewer', () => {
    const panel = judged()
    assert.deepEqual(panel.judge!.rulings[0].sources.map(source => sourceTarget(source, panel)), [
      { kind: 'reviewer', reviewerId: 'general' }, { kind: 'seat', name: 'claude' }, { kind: 'seat', name: 'muse' },
    ])
    assert.deepEqual(sourceTarget('G1', panel), { kind: 'seat', name: 'gpt' })
    assert.deepEqual(sourceTarget('coverage-1', panel), { kind: 'reviewer', reviewerId: 'coverage' })
    // Not read by the judge, but in the `<reviewer_id>-<n>` form: still that reviewer; a hyphenated id keeps its hyphen.
    assert.deepEqual(sourceTarget('lane-check-3', panel), { kind: 'reviewer', reviewerId: 'lane-check' })
    // A prefix no seat carries, or neither form: no target.
    assert.equal(sourceTarget('Z1', panel), null)
    assert.equal(sourceTarget('J1', panel), null)
    assert.equal(sourceTarget('???', panel), null)
    assert.equal(seatAnchorId('review', 'muse'), 'panel-review-seat-muse')
  })
})

describe("a reviewer's findings as the judge read them", () => {
  test('a source chip\'s reviewer page has its finding: the judged record keeps it in reviewer_findings, not in the review', () => {
    const record = panelJudgedExample()
    assert.deepEqual(judgeReadFindings(record, 'general').map(finding => [finding.id, finding.severity, finding.worker]), [['general-1', 'P1', 'engine']])
    assert.match(judgeReadFindings(record, 'general')[0].message, /panel\.settle can return while a resumed seat is still running/)
    assert.deepEqual(judgeReadFindings(record, 'coverage').map(finding => finding.id), ['coverage-1'])
    // The judged review's recorded findings carry none of general's: without these the page would claim it found nothing.
    assert.equal(servedReview(reviewJudgedExample(), { judgedPanel: true }).findings.some(finding => finding.reviewer === 'general'), false)
    assert.deepEqual(judgeReadFindings(record, 'judge'), [])
    assert.deepEqual(judgeReadFindings(panelFallbackExample(), 'general'), [])
    assert.deepEqual(judgeReadFindings(null, 'general'), [])
  })

  test('a judge that did not decide (fallback, or any status but judged) labels none of its reviewer_findings advisory', () => {
    // The judged example's reviewer_findings on a judge that fell back: judge.py sets them before the job starts and on settle failure.
    const record = panelJudgedExample()
    const read = record.panels[0].judge!.reviewer_findings
    assert.ok(read.some(finding => finding.reviewer === 'general'), 'the fixture carries general\'s findings')
    for (const status of ['timed_out', 'failed', 'incomplete'] as const) {
      const fellBack = { ...record, panels: record.panels.map(panel => ({ ...panel, judge: { ...panel.judge!, status, fallback: true } })) }
      assert.deepEqual(judgeReadFindings(fellBack, 'general'), [], status)
    }
    const running = { ...record, panels: record.panels.map(panel => ({ ...panel, judge: { ...panel.judge!, status: 'running' as const, fallback: false } })) }
    assert.deepEqual(judgeReadFindings(running, 'general'), [])
    const fallbackWithFindings = panelFallbackExample()
    fallbackWithFindings.panels[0].judge!.reviewer_findings = read
    assert.deepEqual(judgeReadFindings(fallbackWithFindings, 'general'), [])
    // The served review of a fallback record is not judged, so NodeDetail passes no judge-read findings either.
    assert.equal(isJudgedReview(servedReview(fallbackReview(), { judgedPanel: true })), false)
  })
})

describe('the review section on a judged run', () => {
  test('the judge decides; the built-in reviewers are labelled "advisory (the judge decided)"', () => {
    const review = servedReview(reviewJudgedExample(), { judgedPanel: true })
    assert.equal(isJudgedReview(review), true)
    assert.equal(ADVISORY_WORDING, 'advisory (the judge decided)')
    assert.deepEqual(review.reviewers.map(entry => reviewerRole(review, entry.reviewer_id)), ['advisory', 'advisory', 'deciding'])
    assert.equal(DECIDING_WORDING, 'deciding reviewer')
    // The built-ins' blocked verdicts are not named as blockers: the judge blocked.
    assert.equal(reviewBlockedBy(review), 'Blocked by judge (blocked the candidate).')
  })

  test('a fallback record keeps the built-ins deciding, never advisory; so does a record without the judged flag', () => {
    const fallback = servedReview(fallbackReview(), { judgedPanel: true })
    assert.equal(isJudgedReview(fallback), false)
    assert.deepEqual(fallback.reviewers.map(entry => reviewerRole(fallback, entry.reviewer_id)), [null, null])
    assert.match(reviewBlockedBy(fallback) ?? '', /^Blocked by general .* and coverage/)
    const unflagged = servedReview(reviewJudgedExample())
    assert.equal(isJudgedReview(unflagged), false)
  })
})

describe('one role helper for the viewer and the triage model (C1)', () => {
  test('src/projects/reviewers.ts re-exports the contract\'s reviewerRole: one definition', () => {
    assert.equal(reviewerRole, contractReviewerRole)
    // An archived round carries no judged flag: the caller passes the run's context.
    const round = { reviewers: [{ reviewer_id: 'general' }, { reviewer_id: 'judge' }] }
    assert.deepEqual(round.reviewers.map(entry => contractReviewerRole(round, entry.reviewer_id, { judgedPanel: true })), ['advisory', 'deciding'])
    assert.deepEqual(round.reviewers.map(entry => contractReviewerRole(round, entry.reviewer_id)), [null, null])
  })
})

describe('an advisory card on the judged review (C1 d, C3)', () => {
  test('an advisory verdict reads "advised", never "blocked the candidate"', () => {
    assert.equal(advisedWording({ status: 'blocked', verdict: 'blocked' }), 'advised blocking')
    assert.equal(advisedWording({ status: 'accepted', verdict: 'approved' }), 'advised approval')
    assert.equal(advisedWording({ status: 'superseded', verdict: null }), 'stopped after the combined decision, no advice recorded')
    assert.equal(ADVISORY_FINDINGS_WORDING, 'findings passed to the judge')
  })

  test('an advisory built-in with no verdict (deadline expired or file rejected) says it gave none, never "blocked" or "passed to the judge" (V3)', () => {
    const silent = { status: 'blocked' as const, verdict: null, findings: [] }
    assert.equal(advisedWording(silent), 'gave no verdict (the judge ruled on the others)')
    assert.equal(advisoryFindingsWording(silent), 'no findings')
    assert.equal(advisoryFindingsWording({ ...silent, verdict: 'blocked' }), ADVISORY_FINDINGS_WORDING)
  })

  test('the figures and filter toggles leave out the advisory built-ins on a judged review; an unjudged record keeps every reviewer', () => {
    const review = servedReview(reviewJudgedExample(), { judgedPanel: true })
    assert.deepEqual(reviewFigures(review, ['engine', 'viewer']).reviewers, [{ id: 'judge', count: 2 }])
    assert.deepEqual(findingFilterIds(review, ['engine', 'viewer']).reviewers.map(toggle => toggle.label), ['judge'])
    const unjudged = servedReview(reviewJudgedExample())
    assert.deepEqual(reviewFigures(unjudged, ['engine', 'viewer']).reviewers, [{ id: 'general', count: 0 }, { id: 'coverage', count: 0 }, { id: 'judge', count: 2 }])
    assert.deepEqual(findingFilterIds(unjudged, ['engine', 'viewer']).reviewers.map(toggle => toggle.label), ['general', 'coverage', 'judge'])
  })
})

describe('the Findings legend (C4)', () => {
  test('an unjudged record keeps today\'s legend, byte for byte', () => {
    assert.equal(findingsLegend(false, false, ['engine', 'viewer']),
      'A finding links to a captured file only where its message names the file\'s path verbatim. Blocking means an unresolved P0 or P1 finding from any reviewer; a quote links only where the task text contains it verbatim. Workers are the lanes this run had (engine, viewer); “multiple workers” covers findings that concern more than one lane. Reviewer names the reviewer that raised the finding; the same finding raised by several reviewers is listed once per reviewer, never merged.')
    assert.equal(findingsLegend(false, true, []), findingsLegend(false, false, []))
    assert.match(findingsLegend(false, false, []), /Workers are the lanes this run had; /)
  })

  test('a judged record: blocking is a confirmed P0/P1 ruling (or a critique P0/P1); the built-ins are advisory; a ruling names what it merged', () => {
    const legend = findingsLegend(true, false, ['engine'])
    assert.match(legend, /Blocking means an unresolved P0 or P1 ruling the judge confirmed; the built-in reviewers are advisory and reach this list only through a ruling;/)
    assert.match(legend, /Each ruling's Reviewer is the judge, and its \[J<n> from …\] prefix names the findings it merged\.$/)
    assert.doesNotMatch(legend, /from any reviewer|never merged/)
    assert.match(findingsLegend(true, true, ['engine']), /ruling the judge confirmed, or an unresolved P0 or P1 critique finding;/)
  })
})
