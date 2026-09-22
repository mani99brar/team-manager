import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { z } from 'zod'
import { schemas, validateRunSpec, validateWorkerResult } from './v1.js'
import * as examples from './examples.js'

/** The hand-written schemas (not generated from v1.ts) that the Python controller validates with jsonschema. */
function handWritten(name: string) {
  return z.fromJSONSchema(JSON.parse(readFileSync(new URL(`./${name}.schema.json`, import.meta.url), 'utf8')))
}
const readJson = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'))

test('all examples conform and generated JSON schemas are current', () => {
  for (const [name, schema] of Object.entries(schemas)) {
    schema.parse(examples[name as keyof typeof examples])
    const exported = JSON.parse(readFileSync(new URL(`./${name}.schema.json`, import.meta.url), 'utf8'))
    assert.deepEqual(exported, z.toJSONSchema(schema))
  }
  validateRunSpec(examples.runSpec)
  validateWorkerResult(examples.workerResult)
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

test('verification policy 1.2.0 declares lanes from configuration; 1.0.0 and 1.1.0 stay accepted with role-derived kinds', () => {
  // The policy schema uses conditional rules zod cannot import, so its structure is checked directly; the Python
  // controller validates every committed policy against it (workflow/test_verification.py, workflow/test_lanes.py).
  const schema = readJson('./verification.schema.json')
  assert.deepEqual(schema.properties.version.enum, ['1.0.0', '1.1.0', '1.2.0'])
  assert.equal(schema.properties.workers.minItems, 1)
  assert.equal('maxItems' in schema.properties.workers, false)
  const worker = schema.properties.workers.items.properties
  assert.deepEqual(worker.role, { ...worker.role, type: 'string', minLength: 1, maxLength: 40 })
  assert.deepEqual([worker.required_check_kinds.minItems, worker.required_check_kinds.uniqueItems, worker.required_check_kinds.items], [1, true, { $ref: '#/$defs/checkKind' }])
  assert.deepEqual(worker.node_id, { $ref: '#/$defs/nodeId' })
  assert.equal(schema.properties.failure_drill.properties.node_id.$ref, '#/$defs/nodeId')
  const legacyRule = schema.allOf.find((rule: { if: { properties: { version: { enum?: string[] } } } }) => rule.if.properties.version.enum)
  assert.deepEqual(legacyRule.if.properties.version.enum, ['1.0.0', '1.1.0'])
  assert.deepEqual(legacyRule.then.properties.workers.items.properties.role.enum, ['frontend', 'backend'])
  assert.deepEqual(legacyRule.then.properties.workers.items.not, { required: ['required_check_kinds'] })
  assert.deepEqual(legacyRule.else.properties.workers.items.required, ['required_check_kinds'])
  // The lane id pattern is shared by the policy, the feature file and the completion file's attribution (minus multiple/none).
  const lane = new RegExp(schema.$defs.nodeId.pattern)
  assert.equal(readJson('./feature.schema.json').properties.workers.items.properties.node_id.pattern, schema.$defs.nodeId.pattern)
  for (const ok of ['ui', 'adapter', 'docs', 'contracts-lane', 'a', 'a'.repeat(32)]) assert.ok(lane.test(ok), ok)
  for (const bad of ['review', 'candidate', 'handoff', 'approval', 'integrate', 'multiple', 'none', 'both', 'review-x', 'launch_x', 'Docs', '1docs', 'a'.repeat(33), '']) assert.equal(lane.test(bad), false, bad)
  const attribution = new RegExp(readJson('./reviewCompletion.schema.json').properties.findings.items.properties.worker.pattern)
  for (const ok of ['ui', 'docs', 'multiple', 'none']) assert.ok(attribution.test(ok), ok)
  for (const bad of ['both', 'review', 'review-x', 'Docs', '']) assert.equal(attribution.test(bad), false, bad)
  // The committed examples carry the shapes the schema describes.
  const example = readJson('./verification.example.json')
  assert.equal(example.version, '1.2.0')
  assert.ok(example.workers.length >= 3)
  for (const item of example.workers) assert.ok(item.required_check_kinds.every((kind: string) => item.checks.some((check: { kind: string }) => check.kind === kind)), item.node_id)
  const committed = readJson('../../features/project-workflows/policy.json')
  assert.equal(committed.version, '1.2.0')
  assert.deepEqual(committed.workers.map((item: { node_id: string; required_check_kinds: string[] }) => [item.node_id, item.required_check_kinds]), [['ui', ['build', 'browser']], ['adapter', ['unit']]])
})

test('feature file 2.0.0 declares every lane with its task file', () => {
  const feature = handWritten('feature')
  const committed = readJson('../../features/project-workflows/feature.json')
  feature.parse(committed)
  const reject = (label: string, mutate: (value: typeof committed) => void) => {
    const value = structuredClone(committed)
    mutate(value)
    assert.equal(feature.safeParse(value).success, false, label)
  }
  reject('1.0.0 shape', value => { value.version = '1.0.0'; delete value.workers; value.ui_task = 'ui-task.md'; value.adapter_task = 'adapter-task.md' })
  reject('no workers', value => { value.workers = [] })
  reject('reserved lane', value => { value.workers[0].node_id = 'review' })
  reject('blank task', value => { value.workers[0].task = '' })
  reject('unknown key', value => { value.workers[0].role = 'frontend' })
})

test('review completion 1.1.0 attributes a finding to a lane id, multiple or none, never both', () => {
  const completion = handWritten('reviewCompletion')
  const base = {
    version: '1.1.0', run_id: 'run-001', node_id: 'review', launch_token: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    bundle_sha256: 'b'.repeat(64), candidate_commit: 'c'.repeat(40), verdict: 'approved', findings: [] as Record<string, unknown>[],
  }
  const withWorker = (worker: string, version = '1.1.0') => ({ ...base, version, findings: [{ severity: 'P2', message: 'x', disposition: 'open', worker, requirement: null }] })
  for (const worker of ['ui', 'adapter', 'docs', 'multiple', 'none']) completion.parse(withWorker(worker))
  completion.parse(withWorker('docs', '1.0.0'))
  for (const worker of ['both', 'review', 'candidate', 'review-x', 'launch_x', 'Docs', '']) assert.equal(completion.safeParse(withWorker(worker)).success, false, worker)
  assert.equal(completion.safeParse({ ...base, version: '2.0.0' }).success, false)
})
