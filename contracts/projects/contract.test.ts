import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { z } from 'zod'
import * as examples from './examples.js'
import { validateWorkerResult } from '../workflow/v1.js'
import { isBlockingFinding, schemas, validateDefinition, validateReviewResult, validateRunDetail, validateRunInputs } from './v1.js'

test('project examples and generated schemas agree', () => {
  for (const [name, schema] of Object.entries(schemas)) {
    schema.parse(examples[name as keyof typeof examples])
    const exported = JSON.parse(readFileSync(new URL(`./${name}.schema.json`, import.meta.url), 'utf8'))
    assert.deepEqual(exported, z.toJSONSchema(schema))
  }
  validateRunDetail(examples.runDetail)
  validateReviewResult(examples.reviewResult)
  validateRunInputs(examples.runInputs)
})

test('rejects cyclic, dangling and duplicate graph nodes', () => {
  for (const dependency of ['unknown', 'review']) {
    const definition = structuredClone(examples.runDetail.definition)
    definition.nodes[0].depends_on = [dependency]
    assert.throws(() => validateDefinition(definition))
  }
  const definition = structuredClone(examples.runDetail.definition)
  definition.nodes.push(definition.nodes[0])
  assert.throws(() => validateDefinition(definition))
})

test('rejects cross-project, cross-workflow and stale-definition run detail', () => {
  for (const field of ['project_id', 'workflow_id', 'definition_revision'] as const) {
    const detail = structuredClone(examples.runDetail)
    detail.summary[field] = field === 'definition_revision' ? 'b'.repeat(64) : 'other'
    assert.throws(() => validateRunDetail(detail))
  }
})

test('rejects inconsistent snapshot identity, status, graph and timestamps', () => {
  const mutations = [
    (detail: typeof examples.runDetail) => { detail.snapshot.run_id = 'other' },
    (detail: typeof examples.runDetail) => { detail.snapshot.status = 'failed' },
    (detail: typeof examples.runDetail) => { detail.snapshot.nodes.pop() },
    (detail: typeof examples.runDetail) => { detail.snapshot.nodes[0].depends_on = ['adapter'] },
    (detail: typeof examples.runDetail) => { detail.summary.updated_at = '2025-01-01T00:00:00Z' },
  ]
  for (const mutate of mutations) {
    const detail = structuredClone(examples.runDetail)
    mutate(detail)
    assert.throws(() => validateRunDetail(detail))
  }
})

test('project identifiers are opaque keys, never filesystem paths', () => {
  for (const project_id of ['../repo', '/repo', 'project/repo', 'project\\repo']) {
    assert.throws(() => schemas.projectList.parse({ projects: [{ project_id, name: 'Example' }] }))
  }
})

test('review results: legacy findings without links, blocked verdicts, and the blocking rule', () => {
  // Findings recorded before the reviewer prompt asked for worker/requirement export with nulls and no links.
  const legacy = structuredClone(examples.reviewResult)
  legacy.findings = [{ severity: 'P2', message: 'Legacy finding', disposition: 'open', worker: null, requirement: null, requirement_found_in: [], reviewer: 'review' }]
  legacy.diff = null
  legacy.reviewer = { session_id: 'operator@example', transport: 'manual', independent: true }
  legacy.reviewers = [{ reviewer_id: 'review', transport: 'manual', session_id: 'operator@example', verdict: 'approved', findings: legacy.findings, launched_at: null, accepted_at: legacy.reviewed_at, status: 'accepted' }]
  validateReviewResult(legacy)
  // A blocked verdict may carry unresolved P1 findings; an approved one may not.
  const blocked = structuredClone(examples.reviewResult)
  blocked.verdict = 'blocked'
  blocked.findings[0] = { ...blocked.findings[0], severity: 'P1', disposition: 'open' }
  blocked.reviewers[0].findings[0] = blocked.findings[0]
  assert.ok(isBlockingFinding(blocked.findings[0]))
  assert.equal(validateReviewResult(blocked).verdict, 'blocked')
  const contradictory = structuredClone(blocked)
  contradictory.verdict = 'approved'
  assert.throws(() => validateReviewResult(contradictory), /unresolved P0\/P1/)
  const resolved = structuredClone(contradictory)
  resolved.findings[0].disposition = 'resolved'
  resolved.reviewers[0].findings[0].disposition = 'resolved'
  validateReviewResult(resolved)
})

test('review results 1.4.0: every reviewer is listed, findings are tagged by reviewer, and approval is unanimous', () => {
  const example = examples.reviewResult
  assert.equal(example.contract_version, '1.4.0')
  assert.deepEqual(example.reviewers.map(entry => entry.reviewer_id), ['general', 'coverage'])
  assert.deepEqual(example.findings.map(finding => finding.reviewer), ['general', 'general', 'coverage', 'coverage'])
  // The same defect reported by two reviewers is kept twice, never merged.
  assert.equal(example.findings[0].message, example.findings[3].message)
  // One reviewer blocks: the combined verdict is blocked while the other reviewer's approval is retained.
  const oneBlocks = structuredClone(example)
  oneBlocks.verdict = 'blocked'
  oneBlocks.reviewers[1].verdict = 'blocked'
  oneBlocks.reviewers[1].status = 'blocked'
  assert.equal(validateReviewResult(oneBlocks).reviewers[0].verdict, 'approved')
  // A reviewer that never produced a verdict (deadline, superseded) is listed with nulls and the run is blocked.
  const timedOut = structuredClone(example)
  timedOut.verdict = 'blocked'
  timedOut.reviewers[1] = { ...timedOut.reviewers[1], verdict: null, accepted_at: null, status: 'blocked', findings: [] }
  timedOut.findings = timedOut.findings.filter(finding => finding.reviewer !== 'coverage')
  validateReviewResult(timedOut)
  const superseded = structuredClone(timedOut)
  superseded.reviewers[1].status = 'superseded'
  validateReviewResult(superseded)
  const cases: [string, (result: typeof example) => void][] = [
    ['approved while a reviewer blocked', result => { result.reviewers[1].verdict = 'blocked' }],
    ['approved while a reviewer has no verdict', result => { result.reviewers[1].verdict = null; result.reviewers[1].status = 'pending' }],
    ['no reviewers', result => { result.reviewers = [] }],
    ['duplicate reviewer', result => { result.reviewers[1].reviewer_id = 'general' }],
    ['shared session', result => { result.reviewers[1].session_id = result.reviewers[0].session_id }],
    ['finding from an unknown reviewer', result => { result.findings[0].reviewer = 'security' }],
    ['reviewer findings differ from the combined list', result => { result.reviewers[0].findings = [] }],
    ['accepted without a verdict', result => { result.verdict = 'blocked'; result.reviewers[1].verdict = null; result.reviewers[1].findings = []; result.findings = result.findings.slice(0, 2) }],
    ['per-reviewer transport differs', result => { result.reviewers[1].transport = 'print' }],
    ['unknown reviewer status', result => { (result.reviewers[0] as Record<string, unknown>).status = 'running' }],
    ['reviewer id that is not an id', result => { result.reviewers[0].reviewer_id = 'General'; for (const finding of result.reviewers[0].findings) finding.reviewer = 'General'; result.findings[0].reviewer = 'General'; result.findings[1].reviewer = 'General' }],
    ['finding without a reviewer', result => { delete (result.findings[0] as Record<string, unknown>).reviewer }],
    ['old contract version', result => { (result as Record<string, unknown>).contract_version = '1.3.0' }],
  ]
  for (const [label, mutate] of cases) {
    const result = structuredClone(example)
    mutate(result)
    assert.throws(() => validateReviewResult(result), label)
  }
})

test('review findings name any configured lane, multiple, none or the legacy both', () => {
  for (const worker of ['docs', 'contracts-lane', 'multiple', 'none', 'both', null]) {
    const result = structuredClone(examples.reviewResult)
    result.findings[1].worker = worker
    result.reviewers[0].findings[1].worker = worker
    assert.equal(validateReviewResult(result).findings[1].worker, worker)
  }
  const linked = structuredClone(examples.reviewResult)
  linked.findings[0].worker = 'docs'
  linked.findings[0].requirement_found_in = ['docs', 'ui']
  linked.reviewers[0].findings[0] = linked.findings[0]
  validateReviewResult(linked)
})

test('review results reject unknown fields, non-patch diffs, foreign lanes and links without a quote', () => {
  const cases: [string, (result: typeof examples.reviewResult) => void][] = [
    ['unknown field', result => { (result as Record<string, unknown>).summary = 'x' }],
    ['unknown finding field', result => { (result.findings[0] as Record<string, unknown>).line = 12; (result.reviewers[0].findings[0] as Record<string, unknown>).line = 12 }],
    ['wrong node', result => { (result as Record<string, unknown>).node_id = 'candidate' }],
    ['reviewer not independent', result => { (result.reviewer as Record<string, unknown>).independent = false }],
    ['blank reviewer', result => { result.reviewer.session_id = '' }],
    ['short bundle hash', result => { result.bundle_sha256 = 'b'.repeat(63) }],
    ['diff is a log', result => { result.diff!.kind = 'log' }],
    ['link without a quote', result => { result.findings[1].requirement_found_in = ['ui']; result.reviewers[0].findings[1].requirement_found_in = ['ui'] }],
    ['duplicate link lanes', result => { result.findings[0].requirement_found_in = ['ui', 'ui']; result.reviewers[0].findings[0].requirement_found_in = ['ui', 'ui'] }],
    ['lane that is not a lane id', result => { (result.findings[0] as Record<string, unknown>).requirement_found_in = ['Reviewer'] }],
    ['attribution as a matched lane', result => { result.findings[0].requirement_found_in = ['multiple']; result.reviewers[0].findings[0].requirement_found_in = ['multiple'] }],
    ['worker that is not a lane id', result => { (result.findings[0] as Record<string, unknown>).worker = 'Tester' }],
    ['worker with a path', result => { (result.findings[0] as Record<string, unknown>).worker = 'src/ui' }],
    ['empty quote', result => { result.findings[0].requirement = '' }],
    ['old contract version', result => { (result as Record<string, unknown>).contract_version = '1.2.0' }],
  ]
  for (const [label, mutate] of cases) {
    const result = structuredClone(examples.reviewResult)
    mutate(result)
    assert.throws(() => validateReviewResult(result), label)
  }
})

test('served worker results carry captured files and uncaptured reasons; results recorded without them stay valid', () => {
  const served = validateWorkerResult(examples.servedWorkerResult)
  assert.deepEqual(served.artifacts.flatMap(a => a.kind === 'file' ? [a.path] : []), ['src/projects/NodeDetail.tsx', 'docs/VIEWER.md'])
  assert.deepEqual(served.files_not_captured?.map(f => f.reason), ['binary', 'too_large', 'missing'])
  const legacy: Record<string, unknown> = structuredClone(examples.servedWorkerResult)
  delete legacy.files_not_captured
  legacy.artifacts = examples.servedWorkerResult.artifacts.filter(a => a.kind !== 'file')
  validateWorkerResult(legacy)
  // The review diff stays a patch: a captured file is never the review's diff.
  const result = structuredClone(examples.reviewResult)
  result.diff = { ...examples.servedWorkerResult.artifacts[0] }
  assert.throws(() => validateReviewResult(result))
})

test('run inputs: manual runs, absent receipts and truncated text are valid; contradictions are not', () => {
  const manual = structuredClone(examples.runInputs)
  manual.mode = 'manual'
  manual.automatic = null
  manual.source_branch = null
  manual.workers[0].task = { text: 'truncated task …', truncated: true }
  manual.workers[0].launch = null
  manual.workers[0].completion = null
  manual.workers[0].handoff = null
  manual.workers[0].stop = { stopped: false, confirmed_at: null }
  validateRunInputs(manual)
  // A run pinned before the reviewer transport setting existed reports null; check and scenario IDs are free-form policy labels.
  const older = structuredClone(examples.runInputs)
  older.automatic!.reviewer_transport = null
  older.workers[0].checks[0].id = 'test:unit'
  older.workers[0].checks[1].scenarios[0].id = 'review verdict / narrow'
  validateRunInputs(older)
  // Any number of lanes with free role labels and their own required kinds; one lane is a valid run.
  const three = structuredClone(examples.runInputs)
  three.selected_workers = ['ui', 'adapter', 'docs']
  three.excluded_workers = []
  three.workers.push({
    node_id: 'docs', launch_node_id: 'launch_docs', role: 'technical writer', required_check_kinds: ['contract'],
    task: { text: '# Docs worker\n\nDocument the lanes.', truncated: false }, prompt: null, owned_paths: ['docs'],
    checks: [{ id: 'docs-contract', kind: 'contract', command: 'npm run test:contracts', timeout_seconds: 120, scenarios: [] }],
    launch: null, completion: null, handoff: null, stop: null, questions: [],
  })
  assert.equal(validateRunInputs(three).workers.length, 3)
  const one = structuredClone(examples.runInputs)
  one.selected_workers = ['adapter']
  one.excluded_workers = ['ui', 'docs']
  one.workers = [one.workers[1]]
  assert.equal(validateRunInputs(one).workers.length, 1)
  const cases: [string, (inputs: typeof examples.runInputs) => void][] = [
    ['automatic without settings', inputs => { inputs.automatic = null }],
    ['selected workers out of order', inputs => { inputs.selected_workers = ['adapter', 'ui'] }],
    ['selected worker without a description', inputs => { inputs.selected_workers = ['ui', 'adapter', 'docs'] }],
    ['described worker not selected', inputs => { inputs.selected_workers = ['ui'] }],
    ['no selected workers', inputs => { inputs.selected_workers = []; inputs.workers = [] }],
    ['lane both selected and excluded', inputs => { inputs.excluded_workers = ['ui'] }],
    ['duplicate excluded lane', inputs => { inputs.excluded_workers = ['docs', 'docs'] }],
    ['attribution as a lane', inputs => { inputs.excluded_workers = ['none'] }],
    ['lane id with upper case', inputs => { (inputs.workers[0] as Record<string, unknown>).node_id = 'UI'; inputs.selected_workers = ['UI', 'adapter'] }],
    ['blank role', inputs => { inputs.workers[0].role = '' }],
    ['role over 40 characters', inputs => { inputs.workers[0].role = 'r'.repeat(41) }],
    ['required kind not declared as a check', inputs => { inputs.workers[1].required_check_kinds = ['browser'] }],
    ['no required kinds', inputs => { inputs.workers[1].required_check_kinds = [] }],
    ['duplicate required kinds', inputs => { inputs.workers[0].required_check_kinds = ['build', 'build'] }],
    ['unknown required kind', inputs => { (inputs.workers[0] as Record<string, unknown>).required_check_kinds = ['lint'] }],
    ['manual with settings', inputs => { inputs.mode = 'manual' }],
    ['unknown field', inputs => { (inputs as Record<string, unknown>).repository = '/home/x' }],
    ['duplicate worker', inputs => { inputs.workers[1].node_id = 'ui' }],
    ['duplicate launch node', inputs => { inputs.workers[1].launch_node_id = 'launch_ui' }],
    ['duplicate check', inputs => { inputs.workers[0].checks[1].id = 'frontend-build' }],
    ['browser check without scenarios', inputs => { inputs.workers[0].checks[1].scenarios = [] }],
    ['unit check with scenarios', inputs => { inputs.workers[1].checks[0].scenarios = [{ id: 'x', description: 'y' }] }],
    ['absolute owned path', inputs => { inputs.workers[0].owned_paths = ['/etc'] }],
    ['traversal owned path', inputs => { inputs.workers[0].owned_paths = ['src/../..'] }],
    ['unconfirmed stop with a time', inputs => { inputs.workers[0].stop = { stopped: false, confirmed_at: '2026-01-01T12:20:00Z' } }],
    ['no workers', inputs => { inputs.workers = [] }],
    ['blank completion summary', inputs => { inputs.workers[0].completion!.summary = '' }],
    ['offset timestamp', inputs => { inputs.workers[0].launch!.launch_requested_at = '2026-01-01T12:00:00+00:00' }],
    ['unknown transport', inputs => { (inputs.automatic as Record<string, unknown>).reviewer_transport = 'manual' }],
  ]
  for (const [label, mutate] of cases) {
    const inputs = structuredClone(examples.runInputs)
    mutate(inputs)
    assert.throws(() => validateRunInputs(inputs), label)
  }
})

test('[scenario:export-seam] inputs 1.4.0 serve decisions, the challenge, completion evidence and questions; older runs serve nulls and []', () => {
  const inputs = validateRunInputs(examples.runInputs)
  assert.equal(inputs.contract_version, '1.4.0')
  assert.ok(inputs.decisions?.includes('## Decisions'))
  assert.deepEqual([inputs.challenge?.status, inputs.challenge?.attempt, inputs.challenge?.attempts, inputs.challenge?.accepted_reason], ['accepted', 1, 1, 'The contract is split by file.'])
  assert.deepEqual(inputs.workers[0].completion && [inputs.workers[0].completion.untested, inputs.workers[0].completion.falsifying_check], [['Findings wider than the viewport'], 'review-browser'])
  assert.deepEqual(inputs.workers.map(worker => worker.questions.map(question => question.answer)), [['By severity.'], [null]])
  // What an export before 1.5.0 (or a feature before 2.2.0) serves: nulls and [] everywhere, still valid.
  const older = structuredClone(examples.runInputs)
  older.decisions = null
  older.challenge = null
  for (const worker of older.workers) worker.questions = []
  older.workers[0].completion = { status: 'completed', summary: 'Done.', open_assumptions: [], untested: null, falsifying_check: null, verify_yourself: null }
  validateRunInputs(older)
  // Each challenge status, a question completion and a disabled challenge are valid.
  for (const [status, severity, reason] of [['passed', 'P2', null], ['paused', 'P0', null], ['accepted', 'P1', 'Known risk']] as const) {
    const value = structuredClone(examples.runInputs)
    value.challenge!.status = status
    value.challenge!.accepted_reason = reason
    value.challenge!.concerns = [{ severity, kind: 'other', message: 'm', consequence: 'c' }]
    validateRunInputs(value)
  }
  const disabled = structuredClone(examples.runInputs)
  disabled.challenge = { ...disabled.challenge!, status: 'disabled', attempt: 0, attempts: 0, session_id: null, concerns: [], simpler_alternative: null, cheap_experiment: null, accepted_reason: null }
  validateRunInputs(disabled)
  const asking = structuredClone(examples.runInputs)
  asking.workers[1].completion = { status: 'question', summary: 'Waiting.', open_assumptions: [], untested: null, falsifying_check: null, verify_yourself: null }
  validateRunInputs(asking)
  const cases: [string, (value: typeof examples.runInputs) => void][] = [
    ['decisions missing', value => { delete (value as Record<string, unknown>).decisions }],
    ['challenge missing', value => { delete (value as Record<string, unknown>).challenge }],
    ['questions missing', value => { delete (value.workers[0] as Record<string, unknown>).questions }],
    ['evidence missing', value => { delete (value.workers[0].completion as Record<string, unknown>).falsifying_check }],
    ['unknown completion status', value => { (value.workers[0].completion as Record<string, unknown>).status = 'asked' }],
    ['blank falsifying check', value => { value.workers[0].completion!.falsifying_check = '' }],
    ['unknown challenge status', value => { (value.challenge as Record<string, unknown>).status = 'skipped' }],
    ['accepted without a reason', value => { value.challenge!.accepted_reason = null }],
    ['passed with a reason', value => { value.challenge!.status = 'passed' }],
    ['passed with a P1', value => { value.challenge!.status = 'passed'; value.challenge!.accepted_reason = null }],
    ['paused without a P0/P1', value => { value.challenge!.status = 'paused'; value.challenge!.accepted_reason = null; value.challenge!.concerns = [] }],
    ['disabled with a job', value => { value.challenge!.status = 'disabled'; value.challenge!.accepted_reason = null; value.challenge!.concerns = [] }],
    ['attempt beyond attempts', value => { value.challenge!.attempt = 2 }],
    ['unknown concern kind', value => { (value.challenge!.concerns[0] as Record<string, unknown>).kind = 'style' }],
    ['concern without consequence', value => { value.challenge!.concerns[0].consequence = '' }],
    ['question numbering', value => { value.workers[0].questions[0].n = 2 }],
    ['answer without time', value => { value.workers[0].questions[0].answered_at = null }],
    ['earlier question waiting', value => { value.workers[1].questions.push({ n: 2, question: 'q', asked_at: '2026-01-01T12:11:00Z', answer: null, answered_at: null }) }],
    ['four questions', value => { value.workers[0].questions = [1, 2, 3, 4].map(n => ({ n, question: 'q', asked_at: '2026-01-01T12:11:00Z', answer: 'a', answered_at: '2026-01-01T12:12:00Z' })) }],
  ]
  for (const [label, mutate] of cases) {
    const value = structuredClone(examples.runInputs)
    mutate(value)
    assert.throws(() => validateRunInputs(value), label)
  }
})
