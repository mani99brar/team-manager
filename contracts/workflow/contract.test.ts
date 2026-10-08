import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { z } from 'zod'
import { schemas, validateRunSpec, validateWorkerResult } from './v1.js'
import * as examples from './examples.js'
import { validateProjectsConfig } from '../../server/projectsConfig.ts'

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

test('captured files: a file artifact carries a safe repo-relative path; older results without them stay valid', () => {
  const legacy: Record<string, unknown> = structuredClone(examples.workerResult)
  delete legacy.files_not_captured
  legacy.artifacts = examples.workerResult.artifacts.filter(a => a.kind !== 'file')
  validateWorkerResult(legacy)
  for (const reason of ['binary', 'too_large', 'missing', 'budget'] as const)
    validateWorkerResult({ ...examples.workerResult, files_not_captured: [{ path: 'public/viewer.png', reason }] })
  const file = examples.workerResult.artifacts[1]
  const withArtifact = (artifact: Record<string, unknown>) => ({ ...examples.workerResult, artifacts: [examples.workerResult.artifacts[0], artifact] })
  const rejected = [
    withArtifact({ ...file, path: undefined }),
    withArtifact({ ...examples.workerResult.artifacts[0], artifact_id: 'x', path: 'src/workflow/Viewer.tsx' }),
    ...['/etc/passwd', '../secret', 'src/../../secret', 'C:/secret', 'src\\secret', ''].map(path => withArtifact({ ...file, path })),
    { ...examples.workerResult, files_not_captured: [{ path: 'public/viewer.png', reason: 'unreadable' }] },
    { ...examples.workerResult, files_not_captured: [{ path: '../viewer.png', reason: 'binary' }] },
    { ...examples.workerResult, files_not_captured: [{ path: 'public/viewer.png' }] },
  ]
  for (const value of rejected) assert.throws(() => validateWorkerResult(value))
  // The exported schema states "path exactly when kind is file" for jsonschema consumers (exercised in workflow/test_checks.py).
  const artifact = readJson('./workerResult.schema.json').properties.artifacts.items
  assert.deepEqual(artifact.properties.kind.enum, ['patch', 'log', 'screenshot', 'test_report', 'other', 'file'])
  assert.equal(artifact.required.includes('path'), false)
  assert.deepEqual(artifact.anyOf, [
    { properties: { kind: { const: 'file' } }, required: ['path'] },
    { properties: { kind: { enum: ['patch', 'log', 'screenshot', 'test_report', 'other'] }, path: { not: {} } } },
  ])
  assert.deepEqual(readJson('./workerResult.schema.json').properties.files_not_captured.items.properties.reason.enum, ['binary', 'too_large', 'missing', 'budget'])
  // Cross-field: every captured or uncaptured path is a changed file, and each appears once.
  assert.throws(() => validateWorkerResult({ ...examples.workerResult, files_not_captured: [{ path: 'src/other.ts', reason: 'missing' }] }))
  assert.throws(() => validateWorkerResult({ ...examples.workerResult, files_not_captured: [{ path: 'docs/VIEWER.md', reason: 'too_large' }] }))
  assert.throws(() => validateWorkerResult(withArtifact({ ...file, path: 'src/unchanged.ts' })))
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
  assert.deepEqual(schema.properties.version.enum, ['1.0.0', '1.1.0', '1.2.0', '1.3.0'])
  // 1.3.0 adds the optional attack_check (docs/PRD_ATTACK_PASS.md section 3), refused before 1.3.0 by a rule the legacy finder skips.
  assert.deepEqual(Object.keys(schema.properties.attack_check.properties).sort(), ['argv', 'timeout_seconds'])
  const attackRule = schema.allOf.find((rule: { if: { not?: unknown }; then: { not?: { required?: string[] } } }) => rule.if.not && rule.then.not?.required?.includes('attack_check'))
  assert.deepEqual(attackRule.if.not, { properties: { version: { const: '1.3.0' } } })
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
  for (const ok of ['ui', 'adapter', 'docs', 'contracts-lane', 'challenger', 'a', 'a'.repeat(32)]) assert.ok(lane.test(ok), ok)
  for (const bad of ['review', 'candidate', 'handoff', 'approval', 'integrate', 'multiple', 'none', 'both', 'challenge', 'challenge-1', 'sidecar', 'sidecar-1', 'attack', 'attack-1', 'review-x', 'launch_x', 'Docs', '1docs', 'a'.repeat(33), '']) assert.equal(lane.test(bad), false, bad)
  assert.ok(lane.test('sidecars'))
  assert.ok(lane.test('attacks'))
  const attribution = new RegExp(readJson('./reviewCompletion.schema.json').properties.findings.items.properties.worker.pattern)
  for (const ok of ['ui', 'docs', 'multiple', 'none']) assert.ok(attribution.test(ok), ok)
  for (const bad of ['both', 'review', 'review-x', 'challenge', 'challenge-1', 'sidecar', 'sidecar-1', 'attack', 'attack-1', 'Docs', '']) assert.equal(attribution.test(bad), false, bad)
  // The committed examples carry the shapes the schema describes.
  const example = readJson('./verification.example.json')
  assert.equal(example.version, '1.2.0')
  assert.ok(example.workers.length >= 3)
  for (const item of example.workers) assert.ok(item.required_check_kinds.every((kind: string) => item.checks.some((check: { kind: string }) => check.kind === kind)), item.node_id)
  const committed = readJson('../../workflow/testdata/project-workflows/policy.json')
  assert.equal(committed.version, '1.2.0')
  assert.deepEqual(committed.workers.map((item: { node_id: string; required_check_kinds: string[] }) => [item.node_id, item.required_check_kinds]), [['ui', ['build', 'browser']], ['adapter', ['unit']]])
})

test('feature file 2.0.0 declares every lane with its task file; 2.1.0 adds the reviewers and their briefs', () => {
  const feature = handWritten('feature')
  const committed = readJson('../../workflow/testdata/project-workflows/feature.json')
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
  // 2.1.0: reviewers with the same id rules as lanes; a file without them still validates (the built-in reviewer).
  const reviewed = { ...structuredClone(committed), version: '2.1.0', reviewers: [{ reviewer_id: 'general', prompt: 'reviewers/general.md' }, { reviewer_id: 'coverage', prompt: 'reviewers/coverage.md' }] }
  feature.parse(reviewed)
  feature.parse({ ...structuredClone(committed), version: '2.1.0' })
  // A reviewer brief may name a bundled brief instead of a feature file.
  feature.parse({ ...structuredClone(reviewed), reviewers: [{ reviewer_id: 'general', prompt: 'builtin:general' }] })
  const rejectReviewed = (label: string, mutate: (value: typeof reviewed) => void) => {
    const value = structuredClone(reviewed)
    mutate(value)
    assert.equal(feature.safeParse(value).success, false, label)
  }
  rejectReviewed('no reviewers', value => { value.reviewers = [] })
  rejectReviewed('blank brief', value => { value.reviewers[0].prompt = '' })
  rejectReviewed('unknown reviewer key', value => { (value.reviewers[0] as Record<string, unknown>).transport = 'print' })
  for (const bad of ['review', 'review-x', 'multiple', 'none', 'both', 'challenge', 'challenge-1', 'sidecar', 'sidecar-1', 'launch_x', 'General', '1general', '', 'a'.repeat(33)]) {
    rejectReviewed(`reviewer id ${JSON.stringify(bad)}`, value => { value.reviewers[0].reviewer_id = bad })
  }
  assert.equal(readJson('./feature.schema.json').properties.reviewers.items.properties.reviewer_id.pattern, readJson('./feature.schema.json').properties.workers.items.properties.node_id.pattern)
  assert.deepEqual(readJson('./feature.schema.json').properties.version.enum, ['2.0.0', '2.1.0', '2.2.0', '2.3.0', '2.4.0', '2.5.0', '2.6.0', '2.7.0'])
  // 2.5.0 adds the optional attack pass: false, or an object with 1 to 3 angles and optional bounds (workflow/attack.py refuses it on an earlier version).
  feature.parse({ ...structuredClone(reviewed), version: '2.5.0', attack: { angles: ['auth-funds'], requirements: ['docs/security/requirements.md'] } })
  feature.parse({ ...structuredClone(reviewed), version: '2.5.0', attack: false })
  for (const bad of [{ angles: [] }, { angles: ['nope'] }, { angles: ['auth-funds', 'auth-funds'] }, { budget_usd: 15 }, { angles: ['auth-funds'], budget_usd: 0 }, { angles: ['auth-funds'], extra: true }]) {
    assert.equal(feature.safeParse({ ...structuredClone(reviewed), version: '2.5.0', attack: bad }).success, false, JSON.stringify(bad))
  }
  // 2.6.0 adds the optional multi-provider panels (docs/PRD_MULTI_PROVIDER_PANEL.md section 3; workflow/panel.py refuses them on an earlier version).
  const panelEntry = { id: 'review-panel', stage: 'review', providers: [{ transport: 'claude', effort: 'high' }, { transport: 'pi', model: 'openai-codex/gpt-6-sol' }],
    prompt: 'panels/review.md', requirements: ['docs/security/requirements.md'], budget_usd: 5, timeout_minutes: 15, overlap_threshold: 2, report_only: true }
  feature.parse({ ...structuredClone(reviewed), version: '2.6.0', panels: [panelEntry] })
  feature.parse({ ...structuredClone(reviewed), version: '2.6.0', panels: [{ ...panelEntry, overlap_threshold: 'all', requirements: [] }] })
  feature.parse({ ...structuredClone(reviewed), version: '2.6.0', attack: { angles: ['auth-funds'] }, critical: true, sidecar: { prompt: 'builtin:senior-review' }, panels: [panelEntry] })
  for (const bad of [[], [{ ...panelEntry, report_only: false }], [{ ...panelEntry, stage: 'build' }], [{ ...panelEntry, providers: [] }],
    [{ ...panelEntry, providers: [{ transport: 'codex' }] }], [{ ...panelEntry, overlap_threshold: 0 }], [{ ...panelEntry, budget_usd: 0 }],
    [{ ...panelEntry, timeout_minutes: 0 }], [{ ...panelEntry, extra: true }], [{ ...panelEntry, requirements: ['../x.md'] }]]) {
    assert.equal(feature.safeParse({ ...structuredClone(reviewed), version: '2.6.0', panels: bad }).success, false, JSON.stringify(bad))
  }
  // 2.7.0 adds a lane's own worker model and effort (workflow/launch.py refuses either on an earlier version, naming the lane).
  const pinned = structuredClone(reviewed)
  Object.assign(pinned.workers[0], { model: 'claude-sonnet-5', effort: 'low' })
  feature.parse({ ...pinned, version: '2.7.0', panels: [panelEntry] })
  feature.parse({ ...structuredClone(reviewed), version: '2.7.0' })
  for (const bad of [{ model: 'two words' }, { model: '' }, { model: '-x' }, { effort: 'med' }, { cost: 1 }]) {
    const value = structuredClone(reviewed)
    Object.assign(value.workers[0], bad)
    assert.equal(feature.safeParse({ ...value, version: '2.7.0' }).success, false, JSON.stringify(bad))
  }
  // 2.2.0 (guardrails) adds the optional challenge flag and the PRD path, relative to the target.
  feature.parse({ ...structuredClone(reviewed), version: '2.2.0', challenge: false, prd: 'docs/PRD.md' })
  for (const prd of ['/etc/prd.md', '../prd.md', 'docs/../../prd.md', '']) assert.equal(feature.safeParse({ ...structuredClone(reviewed), version: '2.2.0', prd }).success, false, prd)
  assert.equal(feature.safeParse({ ...structuredClone(reviewed), version: '2.2.0', challenge: 'no' }).success, false)
  // 2.3.0 adds the optional review sidecar: false, or a brief with optional bounds (workflow/sidecar.py refuses it on an earlier version).
  const sidecar = { prompt: 'builtin:senior-review', cadence_seconds: 900, pass_timeout_seconds: 600, max_passes: 16, max_messages_per_lane: 6 }
  feature.parse({ ...structuredClone(reviewed), version: '2.3.0', sidecar })
  feature.parse({ ...structuredClone(reviewed), version: '2.3.0', sidecar: { prompt: 'sidecar-brief.md' } })
  feature.parse({ ...structuredClone(reviewed), version: '2.3.0', sidecar: false })
  // 2.4.0 keeps the sidecar and adds the optional critical flag the grill sets (C51; workflow/launch.py refuses it on an earlier version).
  feature.parse({ ...structuredClone(reviewed), version: '2.4.0', critical: true, sidecar: { prompt: 'builtin:senior-review' } })
  feature.parse({ ...structuredClone(reviewed), version: '2.4.0', critical: false })
  assert.equal(feature.safeParse({ ...structuredClone(reviewed), version: '2.4.0', critical: 'yes' }).success, false)
  // 2.4.0 also adds the optional tryout flag (C7, C29): a user-facing feature the operator tries before the merge to main.
  feature.parse({ ...structuredClone(reviewed), version: '2.4.0', tryout: true })
  feature.parse({ ...structuredClone(reviewed), version: '2.4.0', critical: false, tryout: false })
  assert.equal(feature.safeParse({ ...structuredClone(reviewed), version: '2.4.0', tryout: 'yes' }).success, false)
  for (const bad of [true, {}, { prompt: '' }, { ...sidecar, cadence_seconds: 59 }, { ...sidecar, cadence_seconds: 7201 }, { ...sidecar, pass_timeout_seconds: 3601 },
    { ...sidecar, max_passes: 0 }, { ...sidecar, max_passes: 65 }, { ...sidecar, max_messages_per_lane: 21 }, { ...sidecar, max_passes: 1.5 }, { ...sidecar, extra: 1 }]) {
    assert.equal(feature.safeParse({ ...structuredClone(reviewed), version: '2.3.0', sidecar: bad }).success, false, JSON.stringify(bad))
  }
})

test('review sidecar ledger 1.0.0: the PRD Appendix B example validates verbatim and the field rules hold', () => {
  const ledger = handWritten('sidecar')
  const prd = readFileSync(new URL('../../docs/PRD_REVIEW_SIDECAR.md', import.meta.url), 'utf8')
  const example = JSON.parse(prd.split('## Appendix B')[1].split('```json\n')[1].split('\n```')[0])
  ledger.parse(example)
  const reject = (label: string, mutate: (value: typeof example) => void) => {
    const value = structuredClone(example)
    mutate(value)
    assert.equal(ledger.safeParse(value).success, false, label)
  }
  reject('unknown key', value => { value.extra = true })
  reject('empty id', value => { value.findings[0].id = '' })
  reject('problem over 2,000', value => { value.findings[0].problem = 'p'.repeat(2001) })
  reject('file over 512', value => { value.findings[0].file = 'f'.repeat(513) })
  reject('null evidence', value => { value.findings[0].evidence = null })
  reject('unknown disposition', value => { value.findings[0].disposition = 'fixed' })
  reject('unknown message reason', value => { value.messages[1].reason = 'busy' })
  reject('no finding cited', value => { value.messages[0].finding_ids = [] })
  reject('summary over 4,000', value => { value.passes[0].summary = 's'.repeat(4001) })
  reject('cadence below its bound', value => { value.settings.cadence_seconds = 59 })
  // Empty strings where the rules allow them, the nullable set, no referential check.
  ledger.parse({ ...structuredClone(example), findings: [{ ...structuredClone(example.findings[1]), locator: '', evidence: '' }] })
  ledger.parse({ ...structuredClone(example), messages: [{ ...structuredClone(example.messages[0]), status: 'pending', finding_ids: ['S-99'] }], closed_at: '2026-10-01T14:00:00Z',
    handoff: { unresolved: ['S-2'], structural: [], verified_resolved: [], withdrawn: [], gaps: [] } })
  const schema = readJson('./sidecar.schema.json')
  assert.deepEqual(schema.properties.passes.items, { $ref: '#/$defs/pass' })
  assert.deepEqual(schema.$defs.pass.properties.status.enum, ['completed', 'rejected', 'failed', 'timed_out', 'interrupted'])
  assert.deepEqual(schema.$defs.message.properties.status.enum, ['pending', 'delivered', 'undeliverable', 'refused'])
})

test('multi-provider panel record 1.0.0: both Appendix A records validate verbatim and the field rules hold', () => {
  const panel = handWritten('panel')
  const prd = readFileSync(new URL('../../docs/PRD_MULTI_PROVIDER_PANEL.md', import.meta.url), 'utf8')
  // Both JSON blocks sit indented inside a bullet of Appendix A, so the fences tolerate leading whitespace; the first is `succeeded`, the second `pending`.
  const blocks = [...prd.split('## Appendix A')[1].matchAll(/```json\n([\s\S]*?)\n\s*```/g)].map(match => JSON.parse(match[1]))
  assert.equal(blocks.length, 2)
  const [succeeded, pending] = blocks
  assert.equal(succeeded.panels[0].status, 'succeeded')
  assert.equal(pending.panels[0].status, 'pending')
  panel.parse(succeeded)
  panel.parse(pending)
  const reject = (label: string, mutate: (value: typeof succeeded) => void) => {
    const value = structuredClone(succeeded)
    mutate(value)
    assert.equal(panel.safeParse(value).success, false, label)
  }
  reject('unknown key', value => { value.extra = true })
  reject('unknown panel status', value => { value.panels[0].status = 'blocked' })
  reject('unknown provider status', value => { value.panels[0].providers[0].status = 'succeeded' })
  reject('unknown transport', value => { value.panels[0].providers[0].transport = 'codex' })
  reject('freelanced severity', value => { value.panels[0].findings[0].severity = 'high' })
  reject('threshold 0', value => { value.panels[0].overlap_threshold = 0 })
  reject('threshold word', value => { value.panels[0].overlap_threshold = 'any' })
  reject('no provider raised', value => { value.panels[0].findings[0].providers_raised = [] })
  reject('error over 4,000', value => { value.panels[0].error = 'e'.repeat(4001) })
  reject('negative cost', value => { value.panels[0].providers[0].cost_usd = -1 })
  // A running record, the "all" and 1 thresholds, a challenge stage, a timed-out provider and every nullable field null.
  const running = structuredClone(pending)
  running.panels[0].status = 'running'
  running.panels[0].started_at = '2026-10-06T07:00:00Z'
  running.panels[0].providers.forEach((provider: { status: string }) => { provider.status = 'running' })
  panel.parse(running)
  panel.parse({ ...structuredClone(succeeded), panels: [{ ...structuredClone(succeeded.panels[0]), overlap_threshold: 'all', stage: 'challenge' }] })
  panel.parse({ ...structuredClone(succeeded), panels: [{ ...structuredClone(succeeded.panels[0]), overlap_threshold: 1 }] })
  const nulls = structuredClone(succeeded)
  nulls.panels[0].providers[1] = { ...nulls.panels[0].providers[1], status: 'timed_out', cost_usd: null, context_bytes: null, finding_ids: [], error: 'timed_out after 900 s' }
  nulls.panels[0].providers[0] = { ...nulls.panels[0].providers[0], model: null, effort: null }
  nulls.panels[0].findings[0].line = null
  nulls.panels[0].findings[0].unanchored = true
  nulls.panels[0].findings[0].accepted = false
  nulls.panels[0].status = 'failed'
  nulls.panels[0].error = 'an assembly throw'
  panel.parse(nulls)
  const schema = readJson('./panel.schema.json')
  assert.deepEqual(schema.$defs.panel.properties.status.enum, ['pending', 'running', 'succeeded', 'failed', 'timed_out'])
  assert.deepEqual(schema.$defs.provider.properties.status.enum, ['pending', 'running', 'ok', 'timed_out', 'error', 'parse_failed'])
  assert.deepEqual(Object.keys(schema.$defs.finding.properties), ['id', 'severity', 'file', 'line', 'title', 'detail', 'providers_raised', 'accepted', 'unanchored'])
  assert.equal(schema.$defs.output.type, 'object')  // The claude provider's --json-schema needs an object root.
})

test('review completion 1.2.0 binds a file to one reviewer node and attributes findings to a lane id, multiple or none, never both', () => {
  const completion = handWritten('reviewCompletion')
  const base = {
    version: '1.2.0', run_id: 'run-001', node_id: 'review', launch_token: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    bundle_sha256: 'b'.repeat(64), candidate_commit: 'c'.repeat(40), verdict: 'approved', findings: [] as Record<string, unknown>[],
  }
  const withWorker = (worker: string, version = '1.2.0') => ({ ...base, version, findings: [{ severity: 'P2', message: 'x', disposition: 'open', worker, requirement: null }] })
  for (const worker of ['ui', 'adapter', 'docs', 'multiple', 'none']) completion.parse(withWorker(worker))
  completion.parse(withWorker('docs', '1.0.0'))
  completion.parse(withWorker('docs', '1.1.0'))
  for (const worker of ['both', 'review', 'candidate', 'review-x', 'launch_x', 'Docs', '']) assert.equal(completion.safeParse(withWorker(worker)).success, false, worker)
  assert.equal(completion.safeParse({ ...base, version: '2.0.0' }).success, false)
  // The node id names the reviewer: the default `review`, or `review-<reviewer_id>` for a declared reviewer.
  for (const node_id of ['review', 'review-general', 'review-coverage', 'review-a', `review-${'a'.repeat(32)}`]) completion.parse({ ...base, node_id })
  for (const node_id of ['reviewer', 'review-', 'review-General', `review-${'a'.repeat(33)}`, 'ui', 'candidate', '']) assert.equal(completion.safeParse({ ...base, node_id }).success, false, node_id)
  assert.equal(readJson('./reviewCompletion.schema.json').properties.node_id.pattern, '^review(-[a-z0-9-]{1,32})?$')
})

test('registry-entry: the golden entry a live launch writes parses with the server registry schema', () => {
  const entry = readJson('./examples/registry-entry.json')
  const config = validateProjectsConfig({ version: 1, projects: [entry] })
  assert.equal(config.projects.length, 1)
  const [project] = config.projects
  assert.deepEqual([project.project_id, project.name, project.repository], [entry.project_id, entry.name, entry.repository])
  assert.deepEqual(project.workflows.map(workflow => [workflow.workflow_id, workflow.runs_root]), [['skeleton', entry.workflows[0].runs_root]])
  assert.deepEqual(project.workflows[0].definition.nodes.map(node => node.node_id), entry.workflows[0].definition.nodes.map((node: { node_id: string }) => node.node_id))
  // The server schema is strict: the golden shape is exact, not merely tolerated.
  assert.throws(() => validateProjectsConfig({ version: 1, projects: [{ ...entry, extra: true }] }))
  assert.throws(() => validateProjectsConfig({ version: 1, projects: [{ ...entry, repository: 'relative/path' }] }))
})
