/**
 * The launch node's model (docs/PRD_VIEWER_UX.md 4.5, 7, 8): the file rows come from the worker's own freeze
 * (`results/<lane>/1`), with findings first and a `⚒ repair n` mark on each path the latest result changed or added; the
 * report is said once, with only the verifier's added text when the result's summary extends the completion's; the
 * Questions section leads the index only while a question waits, with both `answer` forms. The shapes follow the captured
 * skeleton-001 payloads (its freeze `game/1` against the repaired `game/3`, the review's P1 on `MatchRoom.ts:44-50`).
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import type { ReviewFinding, RunInputWorker, WorkerResult } from '../../src/projects/api.ts'
import { answerNext, fileRows, filterRows, folderOf, launchSectionEntries, repairBadge, repairFilterLabel, repairMarks, repairTitle, reportDelta, waitingQuestions } from '../../src/projects/node/launch.ts'

const sha = (seed: string) => seed.repeat(64).slice(0, 64)
const file = (path: string, seed = 'a') => ({ artifact_id: `file-${path}`, kind: 'file' as const, uri: `/artifacts/file-${path}`, sha256: sha(seed), path })

function result(attempt: number, files: ReturnType<typeof file>[], extra: Partial<WorkerResult> = {}): WorkerResult {
  return {
    contract_version: '1.0.0', run_id: 'skeleton-001', node_id: 'game', attempt, session_id: 's', status: 'succeeded', base_commit: 'b'.repeat(40),
    output_commit: 'c'.repeat(40), changed_files: files.map(entry => entry.path), checks: [], open_assumptions: [], artifacts: files, summary: 'Built it.', error: null,
    files_not_captured: [], ...extra,
  } as WorkerResult
}

const MATCH_ROOM = 'apps/server/src/MatchRoom.ts'
const INPUT_GATE = 'apps/server/src/inputGate.ts'
const VITEST = 'vitest.config.ts'
const REPORTER = 'tests/reporters/testSummary.ts'
const CLAUDE = 'CLAUDE.md'
const PNG = 'assets/exported/ship.png'
const FROZEN = result(1, [file(CLAUDE), file(MATCH_ROOM), file(INPUT_GATE), file(VITEST, '1')], { files_not_captured: [{ path: PNG, reason: 'binary' }], changed_files: [CLAUDE, MATCH_ROOM, INPUT_GATE, VITEST, PNG] })
const REPAIRED = result(3, [file(CLAUDE), file(MATCH_ROOM), file(INPUT_GATE), file(VITEST, '3'), file(REPORTER, '3')], {
  files_not_captured: [{ path: PNG, reason: 'binary' }], changed_files: [CLAUDE, MATCH_ROOM, INPUT_GATE, VITEST, REPORTER, PNG],
})
const finding = (severity: ReviewFinding['severity'], message: string): ReviewFinding => ({
  severity, message, disposition: 'open', worker: 'game', requirement: null, requirement_found_in: [], reviewer: 'general',
} as ReviewFinding)
const FINDINGS = [
  finding('P2', `${INPUT_GATE} drops stale frames without counting them.`),
  finding('P1', `Private matches can be joined without their code. authorizeEntry (${MATCH_ROOM}:44-50) treats any request as a create request.`),
  finding('P2', 'The HUD has no reduced-motion variant.'),
]

describe('repairMarks', () => {
  test('a path whose sha256 differs is changed by the repair; a path only in the later result is added by it', () => {
    const marks = repairMarks(FROZEN, REPAIRED, 'repair 1')
    assert.deepEqual(Object.fromEntries(marks), { [VITEST]: { kind: 'changed', label: 'repair 1' }, [REPORTER]: { kind: 'added', label: 'repair 1' } })
  })
  test('the freeze itself, or a missing freeze, marks nothing', () => {
    assert.equal(repairMarks(FROZEN, FROZEN, 'repair 1').size, 0)
    assert.equal(repairMarks(null, REPAIRED, 'repair 1').size, 0)
  })
})

describe('repair wording', () => {
  test('a recorded repair is named; without one the mark says only that the file changed after the freeze', () => {
    assert.equal(repairBadge({ kind: 'changed', label: 'repair 1' }), '⚒ repair 1 · changed')
    assert.equal(repairTitle({ kind: 'added', label: 'repair 1' }), "Added by the operator's repair 1 after the worker's freeze")
    assert.equal(repairFilterLabel('repair 1'), 'Repair 1')
    assert.equal(repairBadge({ kind: 'changed', label: '' }), '⚒ changed after the freeze')
    assert.equal(repairTitle({ kind: 'added', label: '' }), "Added after the worker's freeze; no repair is recorded for it")
    assert.equal(repairFilterLabel(''), 'After the freeze')
  })
})

describe('fileRows', () => {
  const rows = fileRows(FROZEN, REPAIRED, FINDINGS, 'repair 1')
  test('findings first by severity, then the repair\'s files, then the rest in the freeze\'s order', () => {
    assert.deepEqual(rows.map(row => row.path), [MATCH_ROOM, INPUT_GATE, VITEST, REPORTER, CLAUDE, PNG])
    assert.deepEqual(rows.map(row => row.severity), ['P1', 'P2', null, null, null, null])
    assert.deepEqual(rows.map(row => row.repair?.kind ?? null), [null, null, 'changed', 'added', null, null])
  })
  test('each row says how it was captured; content is the latest result\'s, a Markdown file is marked', () => {
    assert.deepEqual(rows.map(row => row.state), ['captured', 'captured', 'captured', 'captured', 'captured', 'not-captured'])
    assert.equal(rows.find(row => row.path === VITEST)?.file?.sha256, sha('3'))
    assert.equal(rows.find(row => row.path === PNG)?.reason, 'binary')
    assert.deepEqual(rows.filter(row => row.markdown).map(row => row.path), [CLAUDE])
  })
  test('without a review or a freeze the rows keep the result\'s order', () => {
    assert.deepEqual(fileRows(null, FROZEN, null, '').map(row => row.path), [CLAUDE, MATCH_ROOM, INPUT_GATE, VITEST, PNG])
  })
  test('the filters: with findings, repair, all', () => {
    assert.deepEqual(filterRows(rows, 'findings').map(row => row.path), [MATCH_ROOM, INPUT_GATE])
    assert.deepEqual(filterRows(rows, 'repair').map(row => row.path), [VITEST, REPORTER])
    assert.equal(filterRows(rows, 'all').length, 6)
  })
  test('folders group by the directory part of the path', () => {
    assert.equal(folderOf(MATCH_ROOM), 'apps/server/src/')
    assert.equal(folderOf(CLAUDE), '')
  })
})

describe('reportDelta', () => {
  const reported = 'Built the §17 walking skeleton as npm workspaces. Nothing is committed: the task forbids commits.'
  test('a result summary that extends the report shows only the verifier\'s added text', () => {
    assert.deepEqual(reportDelta(reported, `${reported}\n\nOperator repair 1: the verifier parses only unittest summaries.`), { kind: 'extends', note: 'Operator repair 1: the verifier parses only unittest summaries.' })
  })
  test('the same text is said once; a different one is kept', () => {
    assert.deepEqual(reportDelta(reported, reported), { kind: 'same' })
    assert.deepEqual(reportDelta(reported, null), { kind: 'same' })
    assert.deepEqual(reportDelta(reported, 'Trusted worker check capture.'), { kind: 'differs', summary: 'Trusted worker check capture.' })
  })
})

describe('the Questions section', () => {
  const question = (n: number, answer: string | null) => ({ n, question: `Question ${n}?`, asked_at: '2026-09-24T11:40:00Z', answer, answered_at: answer ? '2026-09-24T11:41:00Z' : null })
  const worker = (questions: ReturnType<typeof question>[]) => ({ questions, node_id: 'duel' }) as unknown as RunInputWorker
  test('leads the index only while a question waits', () => {
    const waiting = worker([question(1, 'Keep it.'), question(2, null)])
    assert.equal(waitingQuestions(waiting), 1)
    assert.deepEqual(launchSectionEntries(waiting, null, null).map(entry => entry.key), ['questions', 'report', 'task', 'session'])
    const answered = worker([question(1, 'Keep it.')])
    assert.equal(waitingQuestions(answered), 0)
    assert.deepEqual(launchSectionEntries(answered, null, REPAIRED).map(entry => entry.key), ['report', 'files', 'task', 'session'])
    assert.equal(launchSectionEntries(answered, null, REPAIRED).find(entry => entry.key === 'files')?.count, 6)
  })
  test('the Files chip counts the rows the list shows: the freeze plus what a repair added, or dropped from the later result', () => {
    const answered = worker([question(1, 'Keep it.')])
    const filesChip = (first: WorkerResult | null, latest: WorkerResult) => launchSectionEntries(answered, first, latest).find(entry => entry.key === 'files')?.count
    assert.equal(filesChip(FROZEN, REPAIRED), fileRows(FROZEN, REPAIRED, null, 'repair 1').length)
    assert.equal(filesChip(FROZEN, REPAIRED), 6)
    const dropped = result(3, [file(CLAUDE), file(MATCH_ROOM)], { files_not_captured: [], changed_files: [CLAUDE, MATCH_ROOM] })
    assert.equal(filesChip(FROZEN, dropped), 5)
  })
  test('both answer forms name the lane; --no-herdr is the second', () => {
    const next = answerNext('duel')
    const commands = next.steps.flatMap(step => (step.kind === 'command' ? [step.text] : []))
    assert.deepEqual(commands, ['"$PY" -m workflow answer "$RUN" duel "<your answer>" --by operator', '"$PY" -m workflow answer "$RUN" duel "<your answer>" --by operator --no-herdr'])
    assert.match(next.caveat ?? '', /exits 1/)
  })
})
