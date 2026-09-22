import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { z } from 'zod'
import * as examples from './examples.js'
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
  legacy.findings = [{ severity: 'P2', message: 'Legacy finding', disposition: 'open', worker: null, requirement: null, requirement_found_in: [] }]
  legacy.diff = null
  legacy.reviewer = { session_id: 'operator@example', transport: 'manual', independent: true }
  validateReviewResult(legacy)
  // A blocked verdict may carry unresolved P1 findings; an approved one may not.
  const blocked = structuredClone(examples.reviewResult)
  blocked.verdict = 'blocked'
  blocked.findings[0] = { ...blocked.findings[0], severity: 'P1', disposition: 'open' }
  assert.ok(isBlockingFinding(blocked.findings[0]))
  assert.equal(validateReviewResult(blocked).verdict, 'blocked')
  const contradictory = structuredClone(blocked)
  contradictory.verdict = 'approved'
  assert.throws(() => validateReviewResult(contradictory), /unresolved P0\/P1/)
  const resolved = structuredClone(contradictory)
  resolved.findings[0].disposition = 'resolved'
  validateReviewResult(resolved)
})

test('review results reject unknown fields, non-patch diffs, foreign lanes and links without a quote', () => {
  const cases: [string, (result: typeof examples.reviewResult) => void][] = [
    ['unknown field', result => { (result as Record<string, unknown>).summary = 'x' }],
    ['unknown finding field', result => { (result.findings[0] as Record<string, unknown>).line = 12 }],
    ['wrong node', result => { (result as Record<string, unknown>).node_id = 'candidate' }],
    ['reviewer not independent', result => { (result.reviewer as Record<string, unknown>).independent = false }],
    ['blank reviewer', result => { result.reviewer.session_id = '' }],
    ['short bundle hash', result => { result.bundle_sha256 = 'b'.repeat(63) }],
    ['diff is a log', result => { result.diff!.kind = 'log' }],
    ['link without a quote', result => { result.findings[1].requirement_found_in = ['ui'] }],
    ['duplicate link lanes', result => { result.findings[0].requirement_found_in = ['ui', 'ui'] }],
    ['unknown lane', result => { (result.findings[0] as Record<string, unknown>).requirement_found_in = ['reviewer'] }],
    ['unknown worker', result => { (result.findings[0] as Record<string, unknown>).worker = 'tester' }],
    ['empty quote', result => { result.findings[0].requirement = '' }],
    ['old contract version', result => { (result as Record<string, unknown>).contract_version = '1.0.0' }],
  ]
  for (const [label, mutate] of cases) {
    const result = structuredClone(examples.reviewResult)
    mutate(result)
    assert.throws(() => validateReviewResult(result), label)
  }
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
  const cases: [string, (inputs: typeof examples.runInputs) => void][] = [
    ['automatic without settings', inputs => { inputs.automatic = null }],
    ['manual with settings', inputs => { inputs.mode = 'manual' }],
    ['unknown field', inputs => { (inputs as Record<string, unknown>).repository = '/home/x' }],
    ['duplicate worker', inputs => { inputs.workers[1].node_id = 'ui' }],
    ['duplicate launch node', inputs => { inputs.workers[1].launch_node_id = 'ui' }],
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
