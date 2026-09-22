import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { z } from 'zod'
import { schemas, validateReviewCompletion, validateRunSpec, validateWorkerResult } from './v1.js'
import * as examples from './examples.js'

test('all examples conform and generated JSON schemas are current', () => {
  for (const [name, schema] of Object.entries(schemas)) {
    schema.parse(examples[name as keyof typeof examples])
    const exported = JSON.parse(readFileSync(new URL(`./${name}.schema.json`, import.meta.url), 'utf8'))
    assert.deepEqual(exported, z.toJSONSchema(schema))
  }
  validateRunSpec(examples.runSpec)
  validateWorkerResult(examples.workerResult)
  validateReviewCompletion(examples.reviewCompletion)
})

test('rejects mismatched bases, shared worktrees, duplicate IDs and excess workers', () => {
  for (const change of [
    { observed_start_commit: 'd'.repeat(40) },
    { worktree: examples.runSpec.workers[0].worktree },
    { node_id: examples.runSpec.workers[0].node_id },
  ]) {
    const spec = structuredClone(examples.runSpec)
    Object.assign(spec.workers[1], change)
    assert.throws(() => validateRunSpec(spec))
  }
  assert.throws(() => validateRunSpec({ ...examples.runSpec, max_concurrent_workers: 3 }))
})

test('requires join evidence fields, durable output and referenced logs', () => {
  for (const field of ['changed_files', 'checks', 'open_assumptions']) {
    const result: Record<string, unknown> = { ...examples.workerResult }
    delete result[field]
    assert.throws(() => validateWorkerResult(result))
  }
  assert.throws(() => validateWorkerResult({ ...examples.workerResult, output_commit: null }))
  assert.throws(() => validateWorkerResult({ ...examples.workerResult, artifacts: [] }))
  assert.throws(() => validateWorkerResult({ ...examples.workerResult, status: 'failed', error: null }))
})

test('rejects unknown versions, fields, invalid attempts and unsafe file paths', () => {
  for (const change of [
    { contract_version: '2.0.0' }, { unknown: true }, { attempt: 0 },
    ...['/etc/passwd', '../secret', 'src/../../secret', 'C:/secret', 'src\\secret'].map(path => ({ changed_files: [path] })),
  ]) assert.throws(() => validateWorkerResult({ ...examples.workerResult, ...change }))
})

test('records unsuccessful checks without pretending that worker completion is acceptance', () => {
  const result = structuredClone(examples.workerResult)
  result.checks[0].exit_code = 1
  assert.equal(validateWorkerResult(result).checks[0].exit_code, 1)
})

test('review completion binds to run, node, bundle, candidate and reviewer session', () => {
  for (const change of [
    { node_id: 'ui' }, { version: '2.0.0' }, { bundle_sha256: 'x'.repeat(64) }, { candidate_commit: 'b'.repeat(39) },
    { reviewer_session: 'not-a-uuid' }, { verdict: 'maybe' }, { unknown: true },
  ]) assert.throws(() => validateReviewCompletion({ ...examples.reviewCompletion, ...change }))
})

test('review findings name a worker and quote a requirement or null; approval needs resolved P0/P1', () => {
  const base = examples.reviewCompletion.findings[0]
  for (const finding of [
    { ...base, worker: 'reviewer' }, { ...base, requirement: '' }, { ...base, severity: 'P3' },
    Object.fromEntries(Object.entries(base).filter(([key]) => key !== 'worker')),
    Object.fromEntries(Object.entries(base).filter(([key]) => key !== 'requirement')),
  ]) assert.throws(() => validateReviewCompletion({ ...examples.reviewCompletion, findings: [finding] }))
  const blocking = { ...base, severity: 'P1' as const, disposition: 'open' as const }
  assert.throws(() => validateReviewCompletion({ ...examples.reviewCompletion, findings: [blocking] }))
  assert.equal(validateReviewCompletion({ ...examples.reviewCompletion, verdict: 'blocked', findings: [blocking] }).verdict, 'blocked')
  assert.equal(validateReviewCompletion({ ...examples.reviewCompletion, findings: [{ ...blocking, disposition: 'resolved' }] }).findings.length, 1)
})
