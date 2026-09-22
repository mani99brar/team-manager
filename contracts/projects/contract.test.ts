import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { z } from 'zod'
import * as examples from './examples.js'
import { schemas, validateDefinition, validateReviewResult, validateRunDetail, validateRunInputs } from './v1.js'

test('project examples and generated schemas agree', () => {
  for (const [name, schema] of Object.entries(schemas)) {
    schema.parse(examples[name as keyof typeof examples])
    const exported = JSON.parse(readFileSync(new URL(`./${name}.schema.json`, import.meta.url), 'utf8'))
    assert.deepEqual(exported, z.toJSONSchema(schema))
  }
  validateRunDetail(examples.runDetail)
  validateReviewResult(examples.reviewResult)
  validateRunInputs(examples.runInputs)
  assert.equal(schemas.runInputsResponse.parse({ inputs: null }).inputs, null)
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

test('review results bind to run, node and evidence and keep blocking findings out of approvals', () => {
  for (const change of [
    { contract_version: '1.0.0' }, { node_id: 'ui' }, { attempt: 0 }, { bundle_sha256: 'x'.repeat(64) }, { candidate_commit: 'c'.repeat(64) },
    { transport: 'pi' }, { verdict: 'maybe' }, { reviewed_at: 'yesterday' }, { unknown: true },
    { diff_artifact: { ...examples.reviewResult.diff_artifact, kind: 'log' } },
    { transport: 'manual', independent: false },
    { findings: [{ severity: 'P2', message: 'legacy shape without link fields', disposition: 'open' }] },
    { findings: [{ ...examples.reviewResult.findings[0], worker: 'reviewer' }] },
    { findings: [{ ...examples.reviewResult.findings[0], requirement: '' }] },
    { findings: [{ ...examples.reviewResult.findings[0], requirement: null, requirement_verbatim: true }] },
    { findings: [{ ...examples.reviewResult.findings[0], severity: 'P1', disposition: 'open' }] },
  ]) assert.throws(() => validateReviewResult({ ...examples.reviewResult, ...change }), JSON.stringify(change))
  const blocked = validateReviewResult({ ...examples.reviewResult, verdict: 'blocked', findings: [{ ...examples.reviewResult.findings[0], severity: 'P0', disposition: 'open' }] })
  assert.equal(blocked.verdict, 'blocked')
  const legacy = validateReviewResult({ ...examples.reviewResult, transport: 'print', findings: [{ severity: 'P2', message: 'pre-link finding', disposition: 'open', worker: null, requirement: null }] })
  assert.equal(legacy.findings[0].requirement_verbatim, undefined)
  assert.equal(validateReviewResult({ ...examples.reviewResult, diff_artifact: null }).diff_artifact, null)
})

test('run inputs are pinned per run and stay structurally consistent', () => {
  const ui = examples.runInputs.workers[0]
  for (const change of [
    { contract_version: '1.1.0' }, { mode: 'print' }, { feature: '../escape' }, { base_commit: 'a'.repeat(64) }, { workers: [] }, { unknown: true },
    { automatic: { ...examples.runInputs.automatic, reviewer_transport: 'pi' } },
    { workers: [ui, ui] },
    { workers: [{ ...ui, task: '' }] },
    { workers: [{ ...ui, owned_paths: ['/etc/passwd'] }] },
    { workers: [{ ...ui, checks: [] }] },
    { workers: [{ ...ui, checks: [ui.checks[0], ui.checks[0]] }] },
    { workers: [{ ...ui, checks: [{ ...ui.checks[0], kind: 'shell' }] }] },
    { workers: [{ ...ui, completion: null }] },
    { workers: [{ ...ui, completion: { ...ui.completion, status: 'done' } }] },
    { workers: [{ ...ui, launch: { ...ui.launch, launch_requested_at: 'now' } }] },
  ]) assert.throws(() => validateRunInputs({ ...examples.runInputs, ...change }), JSON.stringify(change))
  const manual = validateRunInputs({ ...examples.runInputs, automatic: null, workers: [{ ...ui, completion: null, handoff: null }] })
  assert.equal(manual.automatic, null)
  assert.equal(validateRunInputs({ ...examples.runInputs, feature: null }).feature, null)
})
