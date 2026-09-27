/**
 * The review, challenge and controller pages' pure model (src/projects/node/panels.ts, docs/PRD_VIEWER_UX.md 4.7-4.9):
 * reviewer durations and deadlines only from served fields, the challenge headline, the handoff's wait from the launch
 * receipts, the approval's instant and wording, the integrated commit and the section index entries.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Span } from '../../contracts/projects/triage.ts'
import type { ReviewFinding, ReviewResult, RunInputs } from '../../contracts/projects/v1.ts'
import type { WorkflowEvent } from '../../contracts/workflow/v1.ts'
import {
  approvalLine, blockingFindings, challengeHeadline, challengeSectionEntries, deadlineText, handoffWait, integratedCommit, lastStatusAt,
  reviewerDeadline, reviewerTime, reviewSectionEntries,
} from '../../src/projects/node/panels.ts'

type Challenge = NonNullable<RunInputs['challenge']>
type Worker = RunInputs['workers'][number]

const finding = (severity: ReviewFinding['severity'], disposition: ReviewFinding['disposition']): ReviewFinding => ({
  severity, disposition, message: `${severity} ${disposition}`, worker: 'ui', requirement: null, requirement_found_in: [], reviewer: 'general',
})
const span = (nodeId: string, attempt: number, start: string | null, end: string | null, source: 'event' | 'inferred' = 'event'): Span => ({
  node_id: nodeId, lane: null, attempt, start: start ? { at: start, source } : null, end: end ? { at: end, source, ...(source === 'inferred' ? { note: 'no approval event recorded' } : {}) } : null,
  ms: start && end ? Date.parse(end) - Date.parse(start) : null, status: 'succeeded', outcome: '', live: false, result_uri: null, split: null,
})
const event = (nodeId: string, sequence: number, at: string, status: WorkflowEvent['status'], message: string): WorkflowEvent => ({
  contract_version: '1.0.0', run_id: 'r', event_id: `r:${sequence}`, sequence, occurred_at: at, node_id: nodeId, attempt: 1,
  type: status ? 'status_changed' : 'log', status, message, artifact: null, result_uri: null, reused_from_attempt: null,
})
const challenge = (fields: Partial<Challenge>): Challenge => ({
  status: 'passed', attempt: 1, session_id: 's', pinned: { tasks_sha256: 'a'.repeat(64), decisions_sha256: 'b'.repeat(64), prd_sha256: null },
  concerns: [], simpler_alternative: 'x', cheap_experiment: 'y', accepted_reason: null, decided_at: '2026-03-05T08:50:49Z', attempts: 1, ...fields,
})
const p2 = (n: number) => Array.from({ length: n }, (_, index) => ({ severity: 'P2' as const, kind: 'complexity' as const, message: `note ${index}`, consequence: 'c' }))
const worker = (id: string, requested: string, started: string | null): Worker => ({
  node_id: id, launch_node_id: `launch_${id}`, role: 'frontend', required_check_kinds: [], task: { text: '', truncated: false }, prompt: null, owned_paths: [], checks: [],
  launch: { session_id: null, launch_requested_at: requested, native_started_at: started, observed_state: 'done', status: 'attached_session_available', launcher_invocations: 1 },
  completion: null, handoff: null, stop: null, questions: [],
})

test('a decided reviewer took from its launch to its accepted file; nothing is invented without a launch time', () => {
  assert.deepEqual(reviewerTime({ launched_at: '2026-03-05T09:40:00Z', accepted_at: '2026-03-05T09:43:49Z', transport: 'native' }), { kind: 'took', ms: 229_000 })
  assert.deepEqual(reviewerTime({ launched_at: null, accepted_at: '2026-03-05T09:44:10Z', transport: 'print' }), { kind: 'no_launch', print: true })
  assert.deepEqual(reviewerTime({ launched_at: null, accepted_at: null, transport: 'native' }), { kind: 'no_launch', print: false })
  // Launched but no verdict (pending or superseded): the launch time, never an elapsed time.
  assert.deepEqual(reviewerTime({ launched_at: '2026-03-05T09:40:00Z', accepted_at: null, transport: 'native' }), { kind: 'no_verdict', launchedAt: '2026-03-05T09:40:00Z' })
})

test('a reviewer deadline is its launch plus the review timeout, only with a launch time, and says when it passed', () => {
  const now = Date.parse('2026-03-05T10:14:00Z')
  const deadline = reviewerDeadline('2026-03-05T09:40:00Z', 3600, now)
  assert.deepEqual(deadline, { at: '2026-03-05T10:40:00.000Z', leftMs: 26 * 60_000, passed: false })
  assert.equal(deadlineText(deadline!, iso => iso.slice(11, 16)), 'deadline ≈10:40 (26m left)')
  const passed = reviewerDeadline('2026-03-05T09:40:00Z', 1800, now)
  assert.equal(passed?.passed, true)
  assert.equal(deadlineText(passed!, iso => iso.slice(11, 16)), 'deadline ≈10:10 (passed)')
  assert.equal(reviewerDeadline(null, 1800, now), null)
  assert.equal(reviewerDeadline('2026-03-05T09:40:00Z', null, now), null)
})

test('blocking findings are the unresolved P0 and P1; the index counts them and every finding', () => {
  const findings = [finding('P1', 'open'), finding('P0', 'accepted'), finding('P1', 'resolved'), finding('P2', 'open')]
  assert.deepEqual(blockingFindings({ findings }).map(item => item.message), ['P1 open', 'P0 accepted'])
  const review = { findings } as ReviewResult
  assert.deepEqual(reviewSectionEntries(review), [{ key: 'blocking', label: 'Blocking', count: 2 }, { key: 'review', label: 'Findings', count: 4 }])
  assert.deepEqual(reviewSectionEntries({ findings: [finding('P2', 'open')] } as ReviewResult), [{ key: 'review', label: 'Findings', count: 1 }])
  assert.deepEqual(reviewSectionEntries(null), [])
})

test('the challenge headline names the outcome, the attempt, the notes, the decision and the span over every attempt', () => {
  const spans = [span('challenge', 1, '2026-03-05T08:39:42Z', '2026-03-05T08:45:00Z'), span('challenge', 2, '2026-03-05T08:45:00Z', '2026-03-05T08:45:46Z'), span('challenge', 3, '2026-03-05T08:48:20Z', '2026-03-05T08:50:49Z')]
  assert.deepEqual(challengeHeadline(challenge({ attempt: 3, attempts: 3, concerns: p2(8) }), spans), {
    lead: 'Passed on attempt 3', notes: '8 P2 notes', decidedAt: '2026-03-05T08:50:49Z', totalMs: 667_000, attempts: 3,
  })
  assert.equal(challengeHeadline(challenge({ concerns: p2(1) }), [])?.notes, '1 P2 note')
  assert.equal(challengeHeadline(challenge({ concerns: [] }), [])?.notes, null)
  assert.equal(challengeHeadline(challenge({}), [])?.totalMs, null)
  const paused = challengeHeadline(challenge({ status: 'paused', concerns: [...p2(1), { severity: 'P1', kind: 'assumption', message: 'm', consequence: 'c' }] }), [])
  assert.equal(paused?.lead, 'Paused: the design challenge found 1 P1; no worker was launched.')
  assert.equal(paused?.notes, '1 P2 note')
  const accepted = challengeHeadline(challenge({ status: 'accepted', attempt: 2, attempts: 2, accepted_reason: 'r', concerns: [{ severity: 'P1', kind: 'assumption', message: 'm', consequence: 'c' }] }), [])
  assert.equal(accepted?.lead, 'Accepted by the operator on attempt 2 over 1 P1')
  assert.equal(challengeHeadline(challenge({ status: 'disabled', attempt: 0, attempts: 0 }), [])?.lead, 'Disabled: nothing was challenged')
  assert.deepEqual(challengeSectionEntries(challenge({ concerns: p2(8) })), [{ key: 'concerns', label: 'Concerns', count: 8 }, { key: 'alternative', label: 'Alternative & experiment' }])
  assert.deepEqual(challengeSectionEntries(challenge({})), [{ key: 'alternative', label: 'Alternative & experiment' }])
  assert.deepEqual(challengeSectionEntries(null), [])
})

test('the handoff waited from the latest launch start (native start, else the request) to the freeze', () => {
  const workers = [worker('ui', '2026-03-05T08:50:58Z', '2026-03-05T08:51:00.000Z'), worker('adapter', '2026-03-05T08:51:28Z', '2026-03-05T08:51:33.000Z')]
  assert.deepEqual(handoffWait(workers, '2026-03-05T09:19:54Z'), { ms: 1_701_000, from: '2026-03-05T08:51:33.000Z', lane: 'adapter' })
  // Without a native start, the launch request is the start.
  assert.deepEqual(handoffWait([worker('ui', '2026-03-05T09:00:00Z', null)], '2026-03-05T09:10:00Z'), { ms: 600_000, from: '2026-03-05T09:00:00Z', lane: 'ui' })
  assert.equal(handoffWait(workers, null), null)
  assert.equal(handoffWait([{ ...workers[0], launch: null }], '2026-03-05T09:19:54Z'), null)
  assert.equal(handoffWait(workers, '2026-03-05T08:00:00Z'), null)
})

test('an approval without an event is inferred at the integration and says so; the finish policy names who approved', () => {
  const inputs = { mode: 'automatic', automatic: { finish: 'verified-feature-branch' } } as RunInputs
  const inferred = [span('approval', 1, '2026-03-05T09:43:52Z', '2026-03-05T09:43:52Z', 'inferred')]
  assert.deepEqual(approvalLine(inferred, [], inputs), { at: '2026-03-05T09:43:52Z', inferred: true, how: 'approved automatically by the finish policy (verified-feature-branch)', recorded: false })
  const recorded = [event('approval', 4, '2026-03-05T10:00:00Z', 'succeeded', 'Approved')]
  assert.deepEqual(approvalLine([span('approval', 1, '2026-03-05T10:00:00Z', '2026-03-05T10:00:00Z')], recorded, { mode: 'manual', automatic: null } as RunInputs),
    { at: '2026-03-05T10:00:00Z', inferred: false, how: 'approved by the operator', recorded: true })
  assert.equal(approvalLine([], [], inputs), null)
})

test('the integrated commit is the one the integration row names, else the reviewed candidate; the last status row dates a wait', () => {
  const commit = 'c'.repeat(40)
  assert.equal(integratedCommit([event('integrate', 1, '2026-03-05T09:43:52Z', 'succeeded', `Fast-forwarded to ${commit}; no push performed`)], null), commit)
  assert.equal(integratedCommit([], { candidate_commit: 'd'.repeat(40) }), 'd'.repeat(40))
  assert.equal(integratedCommit([], null), null)
  assert.equal(lastStatusAt([event('approval', 1, '2026-03-05T10:00:00Z', 'running', 'a'), event('approval', 2, '2026-03-05T10:02:00Z', null, 'log'), event('approval', 3, '2026-03-05T10:01:00Z', 'awaiting_approval', 'b')]), '2026-03-05T10:01:00Z')
  assert.equal(lastStatusAt([]), null)
})
