import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { z } from 'zod'
import { schemas, validateRunSpec, validateWorkerResult, validateReviewCompletion } from './v1.js'
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

test('review completions stay bound to one run, bundle and candidate', () => {
  for (const change of [
    { contract_version: '1.1.0' }, { node_id: 'candidate' }, { launch_token: '' },
    { bundle_sha256: 'e'.repeat(63) }, { candidate_commit: 'not-a-sha' },
    { verdict: 'approved_with_comments' }, { reviewer: 'someone' },
  ]) assert.throws(() => validateReviewCompletion({ ...examples.reviewCompletion, ...change }))
})

test('review findings carry the worker and requirement a task link needs', () => {
  for (const finding of [
    { severity: 'P2', message: 'Missing worker attribution', disposition: 'open' },
    { severity: 'P2', message: 'Unknown worker', disposition: 'open', worker: 'reviewer', requirement: null },
    { severity: 'P2', message: 'Empty quote', disposition: 'open', worker: 'ui', requirement: '' },
  ]) assert.throws(() => validateReviewCompletion({ ...examples.reviewCompletion, findings: [finding] }))
  const unattributed = { severity: 'P2', message: 'Applies to no single task', disposition: 'accepted', worker: 'none', requirement: null }
  assert.equal(validateReviewCompletion({ ...examples.reviewCompletion, findings: [unattributed] }).findings.length, 1)
})

test('a verdict cannot contradict its own findings', () => {
  assert.throws(() => validateReviewCompletion({ ...examples.reviewCompletion, verdict: 'blocked', findings: [] }))
  const open = { ...examples.reviewCompletion.findings[1], disposition: 'open' }
  assert.throws(() => validateReviewCompletion({ ...examples.reviewCompletion, findings: [open] }))
  const blocked = validateReviewCompletion({ ...examples.reviewCompletion, verdict: 'blocked', findings: [open] })
  assert.equal(blocked.verdict, 'blocked')
})
