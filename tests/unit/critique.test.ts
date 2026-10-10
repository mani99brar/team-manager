/**
 * The critique evidence model (src/projects/critique.ts, docs/PRD_USER_CRITIQUE.md 4.5, Appendix A): a finding's steps in
 * recorded order, its screenshots mapped to the artifact route, the "no screenshot" case of a P1 recorded without one, a
 * finding that carries no evidence, and the archived rounds the "Earlier rounds" list shows.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { FixLoop, FixLoopReviewRound, ReviewFinding } from '../../contracts/projects/v1.ts'
import { paths, type RunScope } from '../../src/projects/api.ts'
import { archivedRounds, critiqueBlockingReason, critiqueOutcomeWording, evidenceOf, evidenceScreenshots, evidenceSteps, isCritiqueReviewer, missingScreenshot, reviewBlockedBy } from '../../src/projects/critique.ts'
import type { Reviewer } from '../../src/projects/reviewers.ts'

const scope: RunScope = { projectId: 'alpha', workflowId: 'ux-critique', runId: 'run-critique' }

const critiqueFinding = (overrides: Partial<ReviewFinding> = {}): ReviewFinding => ({
  severity: 'P1', message: 'The Run button spins forever.', disposition: 'open', worker: 'pages', requirement: null,
  requirement_found_in: [], reviewer: 'critique',
  evidence: { steps: ['Open /projects/alpha', "Click 'Run'", 'Wait 30s'], screenshots: [{ artifact_id: 'critique-2-0a1b2c3d4e5f', caption: 'spinner never ends' }] },
  ...overrides,
})

test('evidenceSteps returns the steps to reproduce in recorded order', () => {
  const finding = critiqueFinding({ evidence: { steps: ['first', 'second', 'third'], screenshots: [] } })
  assert.deepEqual(evidenceSteps(finding), ['first', 'second', 'third'])
})

test('evidenceScreenshots maps each screenshot to its artifact-route URL, in order', () => {
  const finding = critiqueFinding({ evidence: {
    steps: ['x'],
    screenshots: [{ artifact_id: 'critique-2-aaaaaaaaaaaa', caption: 'one' }, { artifact_id: 'critique-2-bbbbbbbbbbbb', caption: 'two' }],
  } })
  const shots = evidenceScreenshots(scope, finding)
  assert.deepEqual(shots.map(shot => shot.artifact_id), ['critique-2-aaaaaaaaaaaa', 'critique-2-bbbbbbbbbbbb'])
  assert.deepEqual(shots.map(shot => shot.caption), ['one', 'two'])
  assert.equal(shots[0].url, paths.artifact(scope, 'critique-2-aaaaaaaaaaaa'))
  assert.match(shots[0].url, /\/runs\/run-critique\/artifacts\/critique-2-aaaaaaaaaaaa$/)
})

test('missingScreenshot is true for a critique P1 with no screenshot, with or without evidence', () => {
  assert.equal(missingScreenshot(critiqueFinding({ severity: 'P1', evidence: { steps: ['x'], screenshots: [] } })), true)
  assert.equal(missingScreenshot(critiqueFinding({ severity: 'P1' })), false)
  // A critique P1 with no `evidence` key at all still warns "no screenshot" (design challenge note 1): the engine drops
  // `evidence` for a finding with no steps, which can include a P1 whose digest did not match evidence.json.
  assert.equal(missingScreenshot(critiqueFinding({ severity: 'P1', evidence: undefined })), true)
  // A P2 recorded without a screenshot is not the P1 "no screenshot" case.
  assert.equal(missingScreenshot(critiqueFinding({ severity: 'P2', evidence: { steps: ['x'], screenshots: [] } })), false)
  // Only the critique reviewer is judged: another reviewer's P1 (which never carries evidence) is never "no screenshot".
  const otherP1: ReviewFinding = { severity: 'P1', message: 'x', disposition: 'open', worker: 'pages', requirement: null, requirement_found_in: [], reviewer: 'general' }
  assert.equal(missingScreenshot(otherP1), false)
})

test('a finding without evidence has none: evidenceOf null, no steps, no screenshots', () => {
  const general: ReviewFinding = { severity: 'P2', message: 'no disposition column', disposition: 'open', worker: 'pages', requirement: null, requirement_found_in: [], reviewer: 'general' }
  assert.equal(general.evidence, undefined)
  assert.equal(evidenceOf(general), null)
  assert.deepEqual(evidenceSteps(general), [])
  assert.deepEqual(evidenceScreenshots(scope, general), [])
  assert.equal(missingScreenshot(general), false)
  assert.equal(isCritiqueReviewer(general.reviewer), false)
})

test('isCritiqueReviewer recognises only the critique reviewer', () => {
  assert.equal(isCritiqueReviewer('critique'), true)
  assert.equal(isCritiqueReviewer('general'), false)
})

// ---- The critique reviewer's entry, worded as a headless job (PRD 4.4/4.5): no completion file, no review deadline ----
const criticReviewer = (overrides: Partial<Reviewer> = {}): Reviewer => ({
  reviewer_id: 'critique', transport: 'native', session_id: '3f0c2a44-9f5b-4d0e-8c0a-5a6b7c8d9e01',
  verdict: 'blocked', findings: [], launched_at: '2026-10-09T09:00:10Z', accepted_at: '2026-10-09T10:40:00Z', status: 'blocked',
  ...overrides,
})

test('critiqueBlockingReason words a failed critique as a job, never a completion file or the review deadline', () => {
  // A blocked verdict blocked the candidate (what the browser spec asserts for this lane's fixture).
  assert.equal(critiqueBlockingReason(criticReviewer({ verdict: 'blocked' })), 'blocked the candidate')
  // A failed critique (null verdict, blocked status) is a headless-job failure, not a native deadline or rejected file.
  const failed = critiqueBlockingReason(criticReviewer({ verdict: null, status: 'blocked', accepted_at: null }))
  assert.equal(failed, 'delivered no verdict: the critique job did not start, timed out, ran out of budget or produced invalid output')
  assert.doesNotMatch(failed ?? '', /review deadline|completion file/)
  // An approved critique with nothing unresolved does not block.
  assert.equal(critiqueBlockingReason(criticReviewer({ verdict: 'approved', status: 'accepted', findings: [] })), null)
})

test('critiqueOutcomeWording is a headless-job line, never the native "completion file accepted"', () => {
  assert.equal(critiqueOutcomeWording(criticReviewer({ verdict: 'approved', status: 'accepted' })), 'the critique job completed')
  assert.equal(critiqueOutcomeWording(criticReviewer({ verdict: 'blocked' })), 'blocked the candidate')
  assert.doesNotMatch(critiqueOutcomeWording(criticReviewer({ verdict: 'approved', status: 'accepted' })), /completion file|native session/)
})

test('reviewBlockedBy words the critique as a job but a native reviewer as before', () => {
  const general: Reviewer = { reviewer_id: 'general', transport: 'native', session_id: 'g', verdict: null, findings: [], launched_at: null, accepted_at: null, status: 'blocked' }
  const review = { verdict: 'blocked' as const, reviewers: [general, criticReviewer({ verdict: null, status: 'blocked', accepted_at: null })] }
  const wording = reviewBlockedBy(review)
  // The native reviewer keeps its own wording; the critique reads as a failed job, not the review deadline.
  assert.match(wording ?? '', /general \(delivered no verdict: the review deadline expired or its completion file was rejected\)/)
  assert.match(wording ?? '', /critique \(delivered no verdict: the critique job did not start, timed out, ran out of budget or produced invalid output\)/)
  // An approved review is never blocked.
  assert.equal(reviewBlockedBy({ verdict: 'approved', reviewers: [] }), null)
})

const round = (overrides: Partial<FixLoopReviewRound> = {}): FixLoopReviewRound => ({
  round: 1, verdict: 'blocked', candidate: 'c'.repeat(40), lane: 'pages',
  findings: [critiqueFinding({ evidence: { steps: ['archived step'], screenshots: [{ artifact_id: 'critique-1-ffffffffffff', caption: 'round 1 shot' }] } })],
  reviewer_sessions: ['3f0c2a44-9f5b-4d0e-8c0a-5a6b7c8d9e01'], started_at: '2026-10-09T09:00:10Z', archived: true, restored_at: null, repair_n: 1,
  reviewers: [{ reviewer_id: 'critique', verdict: 'blocked', session_id: '3f0c2a44-9f5b-4d0e-8c0a-5a6b7c8d9e01' }],
  ...overrides,
})
const loop = (rounds: FixLoopReviewRound[]): FixLoop => ({ contract_version: '1.10.0', source: 'export', version: '1.0.0', rounds: 2, repairs: [], review_rounds: rounds })

test('archivedRounds returns only archived rounds, with their own evidence', () => {
  const archived = round({ round: 1, archived: true })
  const restored = round({ round: 2, archived: false, restored_at: '2026-10-09T11:00:00Z' })
  const rounds = archivedRounds(loop([archived, restored]))
  assert.deepEqual(rounds.map(entry => entry.round), [1])
  // The archived round keeps its own screenshot id and steps, not another finding's.
  assert.equal(evidenceOf(rounds[0].findings[0])?.screenshots[0].artifact_id, 'critique-1-ffffffffffff')
  assert.deepEqual(evidenceSteps(rounds[0].findings[0]), ['archived step'])
})

test('archivedRounds is empty for no loop, a loop with no rounds, and the error form', () => {
  assert.deepEqual(archivedRounds(null), [])
  assert.deepEqual(archivedRounds(undefined), [])
  assert.deepEqual(archivedRounds(loop([])), [])
  const errorForm: FixLoop = { contract_version: '1.10.0', source: 'export', version: '1.0.0', error: 'unprojectable', rounds: null, repairs: [], review_rounds: [] }
  assert.deepEqual(archivedRounds(errorForm), [])
})
