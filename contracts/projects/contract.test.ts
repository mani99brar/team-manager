import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { z } from 'zod'
import * as examples from './examples.js'
import type { RunInputs } from './v1.js'
import { validateWorkerResult } from '../workflow/v1.js'
import {
  ATTACK_ATTACKER_STATUSES, ATTACK_FINDING_STATUSES, ATTACK_PASS_STATUSES, ATTACK_RERUN_REASONS, ATTACK_SKEPTIC_STATUSES, attackRecordSchema,
  ATTENTION_KINDS, CONTROLLER_STATES, isBlockingFinding, PANEL_PROVIDER_STATUSES, PANEL_SEVERITIES, PANEL_STAGES, PANEL_STATUSES, PANEL_TRANSPORTS, panelRecordSchema, schemas,
  sidecarLedgerFileSchema, SIDECAR_MESSAGE_REASONS, SIDECAR_MESSAGE_STATUSES, validateAttackResult, validateDefinition, validatePanelResults, validateReviewResult,
  validateRunDetail, validateRunInputs, validateSidecarLedger, type PanelResults,
} from './v1.js'

test('project examples and generated schemas agree', () => {
  for (const [name, schema] of Object.entries(schemas)) {
    schema.parse(examples[name as keyof typeof examples])
    const exported = JSON.parse(readFileSync(new URL(`./${name}.schema.json`, import.meta.url), 'utf8'))
    assert.deepEqual(exported, z.toJSONSchema(schema))
  }
  validateRunDetail(examples.runDetail)
  validateReviewResult(examples.reviewResult)
  validateRunInputs(examples.runInputs)
  validateSidecarLedger(examples.sidecarLedger)
  validateAttackResult(examples.attackResult)
  validatePanelResults(examples.panelResults)
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

test('run lists and details 1.5.0: activity with every attention kind and controller value, and run_dir, validate; 1.0.0 carries neither', () => {
  const detail = validateRunDetail(examples.runDetail)
  assert.equal(detail.summary.contract_version, '1.5.0')
  assert.equal(schemas.runList.parse(examples.runList).runs[0].activity?.attention?.kind, 'question')
  // A server before 1.5.0, and the viewer's worker-phase mocks, serve a 1.0.0 summary without either field.
  validateRunDetail(examples.legacyRunDetail)
  schemas.runList.parse({ runs: [examples.legacyRunDetail.summary], next_cursor: null })
  for (const kind of ATTENTION_KINDS) {
    const value = structuredClone(examples.runDetail)
    value.summary.activity!.attention = { kind, node_id: kind === 'approval' ? 'review' : 'adapter', since: null }
    value.summary.activity!.waiting_questions = kind === 'question' ? 1 : 0
    assert.equal(validateRunDetail(value).summary.activity!.attention!.kind, kind)
  }
  for (const controller of [...CONTROLLER_STATES, null]) {
    const value = structuredClone(examples.runDetail)
    value.summary.activity!.controller = controller
    validateRunDetail(value)
  }
  // Nothing needs the operator, the run is finished (it has a finish time, no focus and no controller), the directory is not served.
  const finished = structuredClone(examples.runDetail)
  finished.summary.status = finished.snapshot.status = 'succeeded'
  Object.assign(finished.summary.activity!, { focus: null, attention: null, waiting_questions: 0, headline: null, controller: null, finished_at: '2026-01-01T12:01:00Z' })
  finished.run_dir = null
  validateRunDetail(finished)
  const cases: [string, (value: typeof examples.runDetail) => void][] = [
    ['activity on a 1.0.0 summary', value => { value.summary.contract_version = '1.0.0'; delete value.run_dir }],
    ['a 1.5.0 summary without activity', value => { delete value.summary.activity }],
    ['a 1.5.0 detail without run_dir', value => { delete value.run_dir }],
    ['run_dir beside a 1.0.0 summary', value => { value.summary = structuredClone(examples.legacyRunDetail.summary) }],
    ['an unknown summary version', value => { (value.summary as Record<string, unknown>).contract_version = '1.4.0' }],
    ['an unknown activity key', value => { (value.summary.activity as Record<string, unknown>).eta = null }],
    ['an unknown focus key', value => { (value.summary.activity!.focus as Record<string, unknown>).kind = 'worker' }],
    ['an unknown attention kind', value => { (value.summary.activity!.attention as Record<string, unknown>).kind = 'blocked' }],
    ['an unknown controller value', value => { (value.summary.activity as Record<string, unknown>).controller = 'alive' }],
    ['a negative question count', value => { value.summary.activity!.waiting_questions = -1 }],
    ['a headline over 160 characters', value => { value.summary.activity!.headline = 'x'.repeat(161) }],
    ['an empty headline', value => { value.summary.activity!.headline = '' }],
    ['a zoned timestamp', value => { value.summary.activity!.last_activity_at = '2026-01-01T12:00:50+00:00' }],
    ['an absolute run_dir', value => { value.run_dir = '/home/you/.local/state/run-001' }],
    ['a run_dir that leaves the home', value => { value.run_dir = '~/../other/run-001' }],
    ['a run_dir the shell would split', value => { value.run_dir = '~/runs with space/run-001' }],
    ['a focus the definition lacks', value => { value.summary.activity!.focus!.node_id = 'docs' }],
    ['a focus status the snapshot does not show', value => { value.summary.activity!.focus!.status = 'failed' }],
    ['attention on a node the definition lacks', value => { value.summary.activity!.attention!.node_id = 'docs' }],
    ['a finish time on a running run', value => { value.summary.activity!.finished_at = '2026-01-01T12:01:00Z' }],
    ['a controller reading on a finished run', value => { value.summary.status = value.snapshot.status = 'failed' }],
    ['a waiting question without question attention', value => { value.summary.activity!.attention = null }],
    ['question attention without a waiting question', value => { value.summary.activity!.waiting_questions = 0 }],
  ]
  for (const [label, mutate] of cases) {
    const value = structuredClone(examples.runDetail)
    mutate(value)
    assert.throws(() => validateRunDetail(value), label)
  }
  // The run list reads each summary with the same rules.
  const list = structuredClone(examples.runList)
  delete list.runs[0].activity
  assert.throws(() => schemas.runList.parse(list), 'a 1.5.0 list row without activity')
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
  // 1.7.0: roles, controller and profile are null for a run prepared before them, and absent from a server before 1.7.0.
  const prepared = structuredClone(examples.runInputs)
  prepared.roles = null
  prepared.controller = { commit: null, dirty: null, claude_version: null }
  prepared.automatic!.profile = null
  validateRunInputs(prepared)
  delete prepared.roles
  delete prepared.controller
  delete prepared.automatic!.profile
  validateRunInputs(prepared)
  // Within 1.7.0 (C7, C29): the tryout a run asks for, the operator's verdicts and any launch past the untried limit; null or
  // absent for a run prepared before it.
  const tried = structuredClone(examples.runInputs)
  tried.tryout = { required: true, verdicts: [], allow_untried: null }
  validateRunInputs(tried)
  tried.tryout = {
    required: true, allow_untried: { reason: 'The demo is tomorrow', by: 'operator', at: '2026-10-04T08:00:00.000Z' },
    verdicts: [{ result: 'broken', note: 'Empty list', by: 'operator', at: '2026-10-04T09:00:00.000Z' }, { result: 'works', note: null, by: 'operator', at: '2026-10-04T10:00:00.000Z' }],
  }
  validateRunInputs(tried)
  tried.tryout = null
  validateRunInputs(tried)
  for (const broken of [
    (inputs: RunInputs) => { inputs.tryout = { required: true, verdicts: [{ result: 'fine' as never, note: null, by: 'operator', at: '2026-10-04T09:00:00.000Z' }], allow_untried: null } },
    (inputs: RunInputs) => { inputs.tryout = { required: true, verdicts: [{ result: 'works', note: null, by: 'someone' as never, at: '2026-10-04T09:00:00.000Z' }], allow_untried: null } },
    (inputs: RunInputs) => { inputs.tryout = { required: 'yes' as never, verdicts: [], allow_untried: null } },
    (inputs: RunInputs) => { inputs.tryout = { required: true, verdicts: [], allow_untried: { reason: '', by: 'operator', at: '2026-10-04T08:00:00.000Z' } } },
  ]) {
    const bad = structuredClone(examples.runInputs)
    broken(bad)
    assert.throws(() => validateRunInputs(bad))
  }
  for (const broken of [
    (inputs: RunInputs) => { inputs.automatic!.profile = 'supervised' as never },
    (inputs: RunInputs) => { inputs.roles!.worker.effort = 'extreme' as never },
    (inputs: RunInputs) => { inputs.roles!.judges.model = '' },
    (inputs: RunInputs) => { (inputs.roles as Record<string, unknown>).reviewer = { model: null, effort: null } },
    (inputs: RunInputs) => { inputs.controller!.commit = 'abc' },
  ]) {
    const bad = structuredClone(examples.runInputs)
    broken(bad)
    assert.throws(() => validateRunInputs(bad))
  }
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

/** The example run after its ui worker asked a fourth question: three answered, the fourth served as blocked with its text. */
function fourthQuestion() {
  const value = structuredClone(examples.runInputs)
  value.workers[0].questions = [1, 2, 3].map(n => ({ n, question: `Question ${n}?`, asked_at: '2026-01-01T12:05:00Z', answer: 'Yes.', answered_at: '2026-01-01T12:06:00Z' }))
  value.workers[0].completion = { version: '1.1.0', status: 'blocked', summary: 'Asked a fourth question.', open_assumptions: [], untested: null, falsifying_check: null, verify_yourself: null, question: 'And a fourth?' }
  return value
}

test('[scenario:export-seam] inputs 1.4.0 serve decisions, the challenge, completion evidence and questions; older runs serve nulls and []', () => {
  const inputs = validateRunInputs(examples.runInputs)
  assert.equal(inputs.contract_version, '1.4.0')
  assert.ok(inputs.decisions?.includes('## Decisions'))
  assert.deepEqual([inputs.challenge?.status, inputs.challenge?.attempt, inputs.challenge?.attempts, inputs.challenge?.accepted_reason], ['accepted', 1, 1, 'The contract is split by file.'])
  assert.deepEqual(inputs.workers[0].completion && [inputs.workers[0].completion.version, inputs.workers[0].completion.untested, inputs.workers[0].completion.falsifying_check, inputs.workers[0].completion.question],
    ['1.1.0', ['Findings wider than the viewport'], 'review-browser', null])
  assert.deepEqual(inputs.workers.map(worker => worker.questions.map(question => question.answer)), [['By severity.'], [null]])
  // What an export before 1.5.0 (or a feature before 2.2.0) serves: nulls and [] everywhere, still valid.
  const older = structuredClone(examples.runInputs)
  older.decisions = null
  older.challenge = null
  for (const worker of older.workers) worker.questions = []
  older.workers[0].completion = { version: '1.0.0', status: 'completed', summary: 'Done.', open_assumptions: [], untested: null, falsifying_check: null, verify_yourself: null, question: null }
  validateRunInputs(older)
  // Each challenge status, a question completion and a disabled challenge are valid.
  for (const [status, severity, reason] of [['passed', 'P2', null], ['paused', 'P0', null], ['accepted', 'P1', 'Known risk']] as const) {
    const value = structuredClone(examples.runInputs)
    value.challenge!.status = status
    value.challenge!.accepted_reason = reason
    value.challenge!.concerns = [{ severity, kind: 'other', message: 'm', consequence: 'c' }]
    validateRunInputs(value)
  }
  // C8 (1.7.0): a passed attempt the plan holds carries its hold, released or not; the status stays passed.
  for (const hold of [{ held_at: '2026-01-01T12:00:00Z', released_at: null, released_by: null, dropped: [] },
    { held_at: '2026-01-01T12:00:00Z', released_at: '2026-01-01T12:30:00Z', released_by: 'operator', dropped: [2] }] as const) {
    const held = structuredClone(examples.runInputs)
    held.challenge = { ...held.challenge!, status: 'passed', accepted_reason: null, concerns: [{ severity: 'P2', kind: 'other', message: 'm', consequence: 'c' }],
      hold: { ...hold, dropped: [...hold.dropped] } }
    assert.deepEqual(validateRunInputs(held).challenge!.hold, hold)
  }
  // C49 (1.7.0): the records an attempt replaced, with their P0/P1; the example's accepted attempt keeps its paused record.
  assert.deepEqual(validateRunInputs(examples.runInputs).challenge!.history!.map(entry => [entry.attempt, entry.status, entry.concerns.length]), [[1, 'paused', 1]])
  const before = structuredClone(examples.runInputs)
  delete before.challenge!.history
  assert.equal(validateRunInputs(before).challenge!.history, undefined)  // A server before 1.7.0 omits it.
  const disabled = structuredClone(examples.runInputs)
  disabled.challenge = { ...disabled.challenge!, status: 'disabled', attempt: 0, attempts: 0, session_id: null, concerns: [], simpler_alternative: null, cheap_experiment: null, accepted_reason: null, history: [] }
  validateRunInputs(disabled)
  // A question the controller has not recorded yet carries its text; a fourth one is served as blocked, with its text.
  const asking = structuredClone(examples.runInputs)
  asking.workers[0].completion = { version: '1.1.0', status: 'question', summary: 'Waiting.', open_assumptions: [], untested: null, falsifying_check: null, verify_yourself: null, question: 'Split the panel?' }
  validateRunInputs(asking)
  validateRunInputs(fourthQuestion())
  // A 1.1.0 blocked completion need not carry evidence.
  const blocked = structuredClone(examples.runInputs)
  blocked.workers[0].completion = { version: '1.1.0', status: 'blocked', summary: 'Stuck.', open_assumptions: [], untested: null, falsifying_check: null, verify_yourself: null, question: null }
  validateRunInputs(blocked)
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
    ['hold with an unknown actor', value => { value.challenge!.hold = { held_at: '2026-01-01T12:00:00Z', released_at: '2026-01-01T12:30:00Z', released_by: 'bot' as 'operator', dropped: [] } }],
    ['hold dropping note 0', value => { value.challenge!.hold = { held_at: '2026-01-01T12:00:00Z', released_at: null, released_by: null, dropped: [0] } }],
    ['hold without its time', value => { value.challenge!.hold = { released_at: null, released_by: null, dropped: [] } as never }],
    ['history with a P2 note', value => { value.challenge!.history![0].concerns[0].severity = 'P2' as 'P1' }],
    ['history after the attempt shown', value => { value.challenge!.history![0].attempt = 2 }],
    ['history without its time', value => { delete (value.challenge!.history![0] as Record<string, unknown>).decided_at }],
    ['unknown concern kind', value => { (value.challenge!.concerns[0] as Record<string, unknown>).kind = 'style' }],
    ['concern without consequence', value => { value.challenge!.concerns[0].consequence = '' }],
    ['question numbering', value => { value.workers[0].questions[0].n = 2 }],
    ['answer without time', value => { value.workers[0].questions[0].answered_at = null }],
    ['earlier question waiting', value => { value.workers[1].questions.push({ n: 2, question: 'q', asked_at: '2026-01-01T12:11:00Z', answer: null, answered_at: null }) }],
    ['four questions', value => { value.workers[0].questions = [1, 2, 3, 4].map(n => ({ n, question: 'q', asked_at: '2026-01-01T12:11:00Z', answer: 'a', answered_at: '2026-01-01T12:12:00Z' })) }],
    ['completion version missing', value => { delete (value.workers[0].completion as Record<string, unknown>).version }],
    ['unknown completion version', value => { (value.workers[0].completion as Record<string, unknown>).version = '1.2.0' }],
    ['question missing', value => { delete (value.workers[0].completion as Record<string, unknown>).question }],
    ['1.0.0 completion with evidence', value => { value.workers[0].completion!.version = '1.0.0' }],
    ['1.0.0 question completion', value => { value.workers[0].completion = { version: '1.0.0', status: 'question', summary: 's', open_assumptions: [], untested: null, falsifying_check: null, verify_yourself: null, question: 'q' } }],
    ['question completion without its text', value => { Object.assign(value.workers[0].completion!, { status: 'question', question: null }) }],
    ['question completion after three questions', value => { value.workers[0] = fourthQuestion().workers[0]; value.workers[0].completion!.status = 'question' }],
    ['completed completion with a question', value => { value.workers[0].completion!.question = 'q' }],
    ['blocked completion with a question before the third', value => { Object.assign(value.workers[0].completion!, { status: 'blocked', question: 'q' }) }],
  ]
  for (const [label, mutate] of cases) {
    const value = structuredClone(examples.runInputs)
    mutate(value)
    assert.throws(() => validateRunInputs(value), label)
  }
})

/** The ledger example of docs/PRD_REVIEW_SIDECAR.md Appendix B, read from the PRD itself so the two cannot drift apart. */
function appendixBLedger(): unknown {
  const prd = readFileSync(new URL('../../docs/PRD_REVIEW_SIDECAR.md', import.meta.url), 'utf8')
  const appendix = prd.slice(prd.indexOf('## Appendix B'))
  const block = /```json\n([\s\S]*?)\n```/.exec(appendix)
  assert.ok(block, 'Appendix B holds a JSON block')
  return JSON.parse(block[1])
}

test('sidecar ledger 1.6.0: the Appendix B example validates verbatim and is the committed example', () => {
  const ledger = appendixBLedger()
  // Parsing keeps every field: nothing of Appendix B is dropped as unknown.
  assert.deepEqual(sidecarLedgerFileSchema.parse(ledger), ledger)
  assert.deepEqual(ledger, examples.sidecarLedgerFile)
  const served = validateSidecarLedger({ ...(ledger as object), contract_version: '1.6.0', node_id: 'sidecar', source: 'export' })
  assert.equal(served.source, 'export')
  // S-1's own fields are its latest values; its creation values are history[0].
  const s1 = served.findings[0]
  assert.equal(s1.revision, 'b2c3d4e')
  assert.equal(s1.history[0].revision, 'a1b2c3d')
})

test('sidecar ledger 1.6.0: Appendix B field rules, no format or referential checks, unknown keys dropped', () => {
  const base = () => structuredClone(examples.sidecarLedger)
  // Accepted: ids and shas of any shape, an empty locator and evidence, every nullable field null, empty arrays,
  // references the ledger does not hold, `pending` and `interrupted`, a handoff of five lists, and a key the engine adds.
  const accepted: [string, (value: ReturnType<typeof base>) => void][] = [
    ['any-shaped ids and shas', value => { value.findings[0].id = 'finding one'; value.passes[0].lanes.engine.head_commit = 'HEAD~1'; value.findings[0].revision = 'x' }],
    ['empty locator and evidence on a closed finding', value => { value.findings[0].locator = ''; value.findings[0].evidence = ''; value.findings[0].disposition = 'verified_resolved' }],
    ['unresolved references', value => { value.messages[0].finding_ids = ['S-99']; value.findings[0].history[0].pass = 42; value.findings[0].messages = ['M-77'] }],
    ['a pending message', value => { value.messages[0].status = 'pending' }],
    ['every message reason', value => { value.messages = SIDECAR_MESSAGE_REASONS.map((reason, index) => ({ ...value.messages[1], id: `M-${index + 1}`, reason })) }],
    ['every message status', value => { value.messages = SIDECAR_MESSAGE_STATUSES.map((status, index) => ({ ...value.messages[0], id: `M-${index + 1}`, status })) }],
    ['a closed ledger with a handoff', value => { value.closed_at = '2026-10-01T14:00:00Z'; value.handoff = { unresolved: ['S-2'], structural: [], verified_resolved: ['S-1'], withdrawn: [], gaps: ['no pane for viewer'] } }],
    ['an escalation', value => { value.escalations = [{ finding_id: 'S-1', kind: 'security', text: 'Escalated.', pass: 3, at: '2026-10-01T13:05:00Z' }] }],
    ['empty arrays', value => { value.passes = []; value.findings = []; value.messages = []; value.escalations = [] }],
    ['the text bounds exactly', value => { value.findings[0].problem = 'x'.repeat(2000); value.passes[0].summary = 'x'.repeat(4000); value.findings[0].note = 'x'.repeat(1000); value.findings[0].file = 'x'.repeat(512) }],
  ]
  for (const [label, mutate] of accepted) {
    const value = base()
    mutate(value)
    assert.doesNotThrow(() => validateSidecarLedger(value), label)
  }
  const extra = { ...base(), written_by: 'controller' }
  assert.equal('written_by' in validateSidecarLedger(extra), false, 'a key the engine adds is dropped, not refused')
  const refused: [string, (value: ReturnType<typeof base>) => void][] = [
    ['another ledger version', value => { (value as Record<string, unknown>).version = '2.0.0' }],
    ['another contract version', value => { (value as Record<string, unknown>).contract_version = '1.5.0' }],
    ['another node', value => { (value as Record<string, unknown>).node_id = 'review' }],
    ['an unknown source', value => { (value as Record<string, unknown>).source = 'cache' }],
    ['an empty id', value => { value.findings[0].id = '' }],
    ['an empty revision', value => { value.findings[0].revision = '' }],
    ['a null locator', value => { (value.findings[0] as Record<string, unknown>).locator = null }],
    ['a null evidence', value => { (value.findings[0] as Record<string, unknown>).evidence = null }],
    ['a null problem', value => { (value.findings[0] as Record<string, unknown>).problem = null }],
    ['a null pass time', value => { (value.passes[0] as Record<string, unknown>).finished_at = null }],
    ['a problem over 2,000 characters', value => { value.findings[0].problem = 'x'.repeat(2001) }],
    ['a message over 2,000 characters', value => { value.messages[0].text = 'x'.repeat(2001) }],
    ['a summary over 4,000 characters', value => { value.passes[0].summary = 'x'.repeat(4001) }],
    ['a note over 1,000 characters', value => { value.findings[0].note = 'x'.repeat(1001) }],
    ['a file over 512 characters', value => { value.findings[0].file = 'x'.repeat(513) }],
    ['a handoff entry over 4,000 characters', value => { value.handoff = { unresolved: ['x'.repeat(4001)], structural: [], verified_resolved: [], withdrawn: [], gaps: [] } }],
    ['a message citing no finding', value => { value.messages[0].finding_ids = [] }],
    ['an unknown disposition', value => { (value.findings[0] as Record<string, unknown>).disposition = 'resolved' }],
    ['an unknown reason', value => { (value.messages[1] as Record<string, unknown>).reason = 'busy' }],
    ['an unknown pass status', value => { (value.passes[0] as Record<string, unknown>).status = 'running' }],
    ['a cadence out of bounds', value => { value.settings.cadence_seconds = 30 }],
    ['a handoff missing a list', value => { (value as Record<string, unknown>).handoff = { unresolved: [] } }],
    ['duplicate finding ids', value => { value.findings[1].id = 'S-1' }],
    ['duplicate message ids', value => { value.messages[1].id = 'M-1' }],
    ['duplicate pass numbers', value => { value.passes[1].n = 1 }],
  ]
  for (const [label, mutate] of refused) {
    const value = base()
    mutate(value)
    assert.throws(() => validateSidecarLedger(value), label)
  }
})

/** The record example of docs/PRD_ATTACK_PASS.md Appendix A, read from the PRD itself so the two cannot drift apart. */
function appendixARecord(): unknown {
  const prd = readFileSync(new URL('../../docs/PRD_ATTACK_PASS.md', import.meta.url), 'utf8')
  const appendix = prd.slice(prd.indexOf('## Appendix A'))
  const block = /```json\n([\s\S]*?)\n```/.exec(appendix)
  assert.ok(block, 'Appendix A holds a JSON block')
  return JSON.parse(block[1])
}

test('attack result 1.8.0: the Appendix A example validates verbatim as attackResult and is the committed example', () => {
  const record = appendixARecord()
  // Parsing keeps every field: nothing of Appendix A is dropped as unknown.
  assert.deepEqual(attackRecordSchema.parse(record), record)
  assert.deepEqual(record, examples.attackRecord)
  const served = validateAttackResult({ ...(record as object), contract_version: '1.8.0', node_id: 'attack', source: 'export' })
  assert.equal(served.source, 'export')
  assert.equal(served.findings[0].status, 'verified')
  assert.equal(served.findings[0].labels.at(-1)!.label, 'real')
  assert.deepEqual(Object.keys(served.settings), ['angles', 'budget_usd', 'timeout_minutes', 'skeptic_budget_usd', 'skeptic_timeout_minutes', 'max_findings', 'requirements', 'secret_files'])
})

test('attack result 1.8.0: Appendix A field rules, every enum value, pending, no referential checks, unknown keys dropped but settings closed', () => {
  const base = () => structuredClone(examples.attackResult)
  const finding = (value: ReturnType<typeof base>, index: number) => value.findings[index] as Record<string, unknown>
  // Accepted: every value of each enum, every nullable field null, empty arrays, an unresolved attacker, a lower skeptic
  // severity, the export's pending record (G10) and failed record for an invalid file, and a key the engine adds.
  const accepted: [string, (value: ReturnType<typeof base>) => void][] = [
    ['every pass status', value => { for (const status of ATTACK_PASS_STATUSES) { if (status === 'pending') continue; value.status = status; validateAttackResult(value) } }],
    ['every attacker status', value => { value.attackers = ATTACK_ATTACKER_STATUSES.map((status, index) => ({ ...value.attackers[0], id: `a${index}`, status })) }],
    ['every skeptic status', value => { value.attackers = ATTACK_SKEPTIC_STATUSES.map((status, index) => ({ ...value.attackers[0], id: `a${index}`, skeptic: { ...value.attackers[0].skeptic, status } })) }],
    ['every finding status', value => { value.findings = ATTACK_FINDING_STATUSES.map((status, index) => ({ ...value.findings[0], id: `A-${index + 1}`, status })) }],
    ['every not-reproduced reason', value => { value.findings = ATTACK_RERUN_REASONS.map((reason, index) => ({ ...value.findings[1], id: `A-${index + 1}`, rerun: { ...value.findings[1].rerun!, reason } })) }],
    ['every label and review_found', value => { value.findings[0].labels = [
      { label: 'real', review_found: 'yes', note: 'seen', by: 'operator', at: 'x' }, { label: 'false', review_found: null, note: null, by: 'operator', at: 'y' },
      { label: 'out-of-scope', review_found: 'no', note: null, by: 'operator', at: 'z' }] }],
    ['a lower skeptic severity', value => { value.findings[0].skeptic!.severity = 'P2' }],
    ['every nullable field null', value => {
      Object.assign(value, { candidate_commit: null, started_at: null, finished_at: null, error: null })
      Object.assign(value.attackers[0], { started_at: null, finished_at: null, error: null, session_id: null, cost_usd: null, summary: null })
      Object.assign(value.attackers[0].skeptic, { started_at: null, finished_at: null, error: null, session_id: null, cost_usd: null })
      Object.assign(value.findings[1], { requirement: null, rerun: null, skeptic: null })
      value.findings[0].rerun!.exit_code = null
    }],
    ['any-shaped ids, commit, session and times', value => { value.candidate_commit = 'HEAD'; value.findings[0].id = 'finding one'; value.attackers[0].session_id = 'x'; value.started_at = 'yesterday' }],
    ['an unresolved attacker', value => { value.findings[0].attacker = 'nobody' }],
    ['an empty title, threat and times (only ids are non-empty)', value => { value.findings[0].title = ''; value.findings[0].threat = ''; value.findings[0].rerun!.at = ''; value.started_at = '' }],
    ['empty arrays', value => { value.attackers = []; value.findings = []; value.settings.requirements = []; value.settings.secret_files = [] }],
    ['the pending record', value => { Object.assign(value, { status: 'pending', candidate_commit: null, started_at: null, finished_at: null, attackers: [], findings: [] }) }],
    ['the failed record of an invalid file', value => { Object.assign(value, { status: 'failed', error: 'attack.json is not valid: findings[0].status', attackers: [], findings: [] }) }],
  ]
  for (const [label, mutate] of accepted) {
    const value = base()
    mutate(value)
    assert.doesNotThrow(() => validateAttackResult(value), label)
  }
  const extra = { ...base(), written_by: 'controller' }
  assert.equal('written_by' in validateAttackResult(extra), false, 'a key the engine adds is dropped, not refused')
  const refused: [string, (value: ReturnType<typeof base>) => void][] = [
    ['another record version', value => { (value as Record<string, unknown>).version = '2.0.0' }],
    ['another contract version', value => { (value as Record<string, unknown>).contract_version = '1.6.0' }],
    ['another node', value => { (value as Record<string, unknown>).node_id = 'review' }],
    ['an unknown source', value => { (value as Record<string, unknown>).source = 'cache' }],
    ['an unknown pass status', value => { (value as Record<string, unknown>).status = 'timed_out' }],
    ['an unknown attacker status', value => { (value.attackers[0] as Record<string, unknown>).status = 'not_run' }],
    ['an unknown skeptic status', value => { (value.attackers[0].skeptic as Record<string, unknown>).status = 'refused' }],
    ['an unknown angle', value => { (value.attackers[0] as Record<string, unknown>).angle = 'network' }],
    ['an unknown finding severity', value => { finding(value, 0).severity = 'P3' }],
    ['an unknown skeptic severity', value => { (value.findings[0].skeptic as Record<string, unknown>).severity = 'P3' }],
    ['an unknown rerun status', value => { (value.findings[0].rerun as Record<string, unknown>).status = 'failed' }],
    ['an unknown rerun reason', value => { (value.findings[1].rerun as Record<string, unknown>).reason = 'flaky' }],
    ['an unknown verdict', value => { (value.findings[0].skeptic as Record<string, unknown>).verdict = 'unsure' }],
    ['an unknown finding status', value => { finding(value, 0).status = 'reproduced' }],
    ['an unknown label', value => { (value.findings[0].labels[0] as Record<string, unknown>).label = 'maybe' }],
    ['an unknown review_found', value => { (value.findings[0].labels[0] as Record<string, unknown>).review_found = 'perhaps' }],
    ['a label by the maintainer', value => { (value.findings[0].labels[0] as Record<string, unknown>).by = 'maintainer' }],
    ['a skeptic severity above the finding\'s', value => { value.findings[0].skeptic!.severity = 'P0' }],
    ['a reproduced re-run with a reason', value => { (value.findings[0].rerun as Record<string, unknown>).reason = 'passed' }],
    ['a not-reproduced re-run without a reason', value => { (value.findings[1].rerun as Record<string, unknown>).reason = null }],
    ['a settings key beyond the eight (L1)', value => { (value.settings as Record<string, unknown>).attack_check = { argv: ['vitest'] } }],
    ['a settings key missing', value => { delete (value.settings as Record<string, unknown>).secret_files }],
    ['an absolute test file', value => { value.findings[0].test_file = '/tmp/A-1.test.ts' }],
    ['a null attacker skeptic', value => { (value.attackers[0] as Record<string, unknown>).skeptic = null }],
    ['a null title', value => { finding(value, 0).title = null }],
    ['an empty ref', value => { value.findings[0].ref = '' }],
    ['an empty finding id', value => { value.findings[0].id = '' }],
    ['a null labels list', value => { finding(value, 0).labels = null }],
    ['duplicate finding ids', value => { value.findings[1].id = 'A-1' }],
    ['duplicate attacker ids', value => { value.attackers.push({ ...value.attackers[0] }) }],
    ['a pending pass with findings', value => { value.status = 'pending' }],
  ]
  for (const [label, mutate] of refused) {
    const value = base()
    mutate(value)
    assert.throws(() => validateAttackResult(value), label)
  }
})

/**
 * The two records of docs/PRD_MULTI_PROVIDER_PANEL.md Appendix A (the `succeeded` one, then the `pending` one), read from the
 * PRD itself so the two cannot drift apart. Both blocks are indented inside a bullet, so the fences tolerate leading
 * whitespace (the attack helper's bare `\n```` never matches them: design-challenge note 4).
 */
function panelAppendixARecords(): unknown[] {
  const prd = readFileSync(new URL('../../docs/PRD_MULTI_PROVIDER_PANEL.md', import.meta.url), 'utf8')
  const appendix = prd.slice(prd.indexOf('## Appendix A'))
  const blocks = [...appendix.matchAll(/^[ \t]*```json\n([\s\S]*?)\n[ \t]*```/gm)].map(block => JSON.parse(block[1]) as unknown)
  assert.equal(blocks.length, 2, 'Appendix A holds exactly two JSON blocks: the succeeded record and the pending record')
  return blocks
}

test('panel results 1.9.0: both Appendix A records validate verbatim as panelResults and are the committed examples', () => {
  const [succeeded, pending] = panelAppendixARecords()
  // Parsing keeps every field: nothing of Appendix A is dropped as unknown.
  assert.deepEqual(panelRecordSchema.parse(succeeded), succeeded)
  assert.deepEqual(panelRecordSchema.parse(pending), pending)
  assert.deepEqual(succeeded, examples.panelRecord)
  assert.deepEqual(pending, examples.panelPendingRecord)
  for (const [record, source] of [[succeeded, 'export'], [pending, 'export'], [succeeded, 'live']] as const) {
    const served = validatePanelResults({ ...(record as object), contract_version: '1.9.0', source })
    assert.equal(served.source, source)
    assert.equal('node_id' in served, false, 'the panel has no graph node this slice: no node_id')
  }
  const served = validatePanelResults(examples.panelResults)
  assert.deepEqual([served.panels[0].stage, served.panels[0].status, served.panels[0].overlap_threshold], ['review', 'succeeded', 2])
  assert.deepEqual(served.panels[0].findings[0].providers_raised, ['claude', 'openai-codex/gpt-6-sol'])
  assert.deepEqual(served.panels[0].providers.map(provider => [provider.model, provider.cost_usd]), [[null, 0.021], ['openai-codex/gpt-6-sol', 0.0047]])
  const pendingServed = validatePanelResults({ ...examples.panelPendingRecord, contract_version: '1.9.0', source: 'export' })
  assert.deepEqual(pendingServed.panels[0].providers.map(provider => provider.status), ['pending', 'pending'])
})

test('panel results 1.9.0: Appendix A field rules, every enum value, threshold "all" and 1, a challenge stage, a running provider, every nullable null, unknown keys dropped', () => {
  const base = (): PanelResults => structuredClone(examples.panelResults)
  type Panel = PanelResults['panels'][number]
  const panelOf = (value: PanelResults): Panel => value.panels[0]
  const accepted: [string, (value: PanelResults) => void][] = [
    ['every panel status', value => { value.panels = PANEL_STATUSES.filter(status => status !== 'pending').map((status, index) => ({ ...panelOf(value), id: `p${index}`, status })) }],
    ['every provider status', value => { panelOf(value).providers = PANEL_PROVIDER_STATUSES.map(status => ({ ...panelOf(value).providers[0], status })) }],
    ['every stage', value => { value.panels = PANEL_STAGES.map(stage => ({ ...panelOf(value), id: `${stage}-panel`, stage })) }],
    ['every transport', value => { panelOf(value).providers = PANEL_TRANSPORTS.map(transport => ({ ...panelOf(value).providers[0], transport })) }],
    ['every severity', value => { panelOf(value).findings = PANEL_SEVERITIES.map((severity, index) => ({ ...panelOf(value).findings[0], id: `f${index}`, severity })) }],
    // Design-challenge note 3: a live record with a threshold the verbatim records do not carry must not be skipped.
    ['overlap threshold "all"', value => { panelOf(value).overlap_threshold = 'all' }],
    ['overlap threshold 1 (any provider)', value => { panelOf(value).overlap_threshold = 1 }],
    ['overlap threshold 3', value => { panelOf(value).overlap_threshold = 3 }],
    ['a challenge-stage panel', value => { panelOf(value).stage = 'challenge' }],
    ['a running panel with a running provider', value => { Object.assign(panelOf(value), { status: 'running', ended_at: null }); panelOf(value).providers[1].status = 'running' }],
    ['every nullable field null', value => {
      Object.assign(panelOf(value), { context_bytes: null, started_at: null, ended_at: null, error: null })
      Object.assign(panelOf(value).providers[0], { model: null, effort: null, cost_usd: null, context_bytes: null, error: null })
      panelOf(value).findings[0].line = null
    }],
    ['a timed-out panel whose providers all timed out, with errors', value => {
      Object.assign(panelOf(value), { status: 'timed_out', findings: [], error: 'every provider timed out' })
      for (const provider of panelOf(value).providers) Object.assign(provider, { status: 'timed_out', finding_ids: [], error: 'timed out after 15 minutes; its process group was stopped' })
    }],
    ['a failed panel with its error and no provider error', value => { Object.assign(panelOf(value), { status: 'failed', findings: [], providers: [], error: 'context assembly failed: OSError' }) }],
    ['an unanchored, not accepted finding with any file text', value => { panelOf(value).findings.push({ ...panelOf(value).findings[0], id: 'f2', file: '../outside.ts', unanchored: true, accepted: false, providers_raised: ['claude'] }) }],
    ['empty arrays', value => { Object.assign(panelOf(value), { providers: [], findings: [] }) }],
    ['no panels at all', value => { value.panels = [] }],
    ['the pending record', value => { value.panels = structuredClone(examples.panelPendingRecord.panels) }],
    ['any-shaped times and a zero budget', value => { Object.assign(panelOf(value), { started_at: 'yesterday', ended_at: 'today', budget_usd: 0 }) }],
    ['unresolved finding ids and providers', value => { panelOf(value).providers[0].finding_ids = ['nobody']; panelOf(value).findings[0].providers_raised = ['deepseek/deepseek-v4-pro'] }],
  ]
  for (const [label, mutate] of accepted) {
    const value = base()
    mutate(value)
    assert.doesNotThrow(() => validatePanelResults(value), label)
  }
  const extra = base() as PanelResults & { written_by?: string }
  extra.written_by = 'controller'
  ;(panelOf(extra) as Panel & { pid?: number }).pid = 4242
  const served = validatePanelResults(extra)
  assert.equal('written_by' in served, false, 'a key the engine adds is dropped, not refused')
  assert.equal('pid' in served.panels[0], false)

  const refused: [string, (value: PanelResults) => void][] = [
    ['another contract version', value => { (value as Record<string, unknown>).contract_version = '1.8.0' }],
    ['another record version', value => { (value as Record<string, unknown>).version = '1.1.0' }],
    ['a node id (none this slice)', value => { (value as Record<string, unknown>).source = 'node' }],
    ['an unknown panel status', value => { (panelOf(value) as Record<string, unknown>).status = 'refused' }],
    ['an unknown provider status', value => { (panelOf(value).providers[0] as Record<string, unknown>).status = 'succeeded' }],
    ['an unknown stage', value => { (panelOf(value) as Record<string, unknown>).stage = 'integrate' }],
    ['an unknown transport', value => { (panelOf(value).providers[0] as Record<string, unknown>).transport = 'openai' }],
    ['a freelanced severity', value => { (panelOf(value).findings[0] as Record<string, unknown>).severity = 'high' }],
    ['a threshold of 0', value => { (panelOf(value) as Record<string, unknown>).overlap_threshold = 0 }],
    ['a fractional threshold', value => { (panelOf(value) as Record<string, unknown>).overlap_threshold = 1.5 }],
    ['a threshold word other than all', value => { (panelOf(value) as Record<string, unknown>).overlap_threshold = 'some' }],
    ['a missing panel error key', value => { delete (panelOf(value) as Partial<Panel>).error }],
    ['a missing provider error key', value => { delete (panelOf(value).providers[0] as Partial<Panel['providers'][number]>).error }],
    ['a null finding file', value => { (panelOf(value).findings[0] as Record<string, unknown>).file = null }],
    ['an empty panel id', value => { panelOf(value).id = '' }],
    ['a negative cost', value => { panelOf(value).providers[0].cost_usd = -1 }],
    ['duplicate panel ids', value => { value.panels.push(structuredClone(panelOf(value))) }],
    ['duplicate finding ids', value => { panelOf(value).findings.push({ ...panelOf(value).findings[0] }) }],
    ['a pending panel with findings', value => { Object.assign(panelOf(value), { status: 'pending', started_at: null, ended_at: null }) }],
  ]
  for (const [label, mutate] of refused) {
    const value = base()
    mutate(value)
    assert.throws(() => validatePanelResults(value), label)
  }
})
