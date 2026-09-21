import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { z } from 'zod'
import * as examples from './examples.js'
import { schemas, validateDefinition, validateRunDetail } from './v1.js'

test('project examples and generated schemas agree', () => {
  for (const [name, schema] of Object.entries(schemas)) {
    schema.parse(examples[name as keyof typeof examples])
    const exported = JSON.parse(readFileSync(new URL(`./${name}.schema.json`, import.meta.url), 'utf8'))
    assert.deepEqual(exported, z.toJSONSchema(schema))
  }
  validateRunDetail(examples.runDetail)
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
