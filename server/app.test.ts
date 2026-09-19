import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from './app.ts'

const expected = [
  { source: 'Pi', path: 'skills/review.md' },
  { source: 'Pi', path: 'workflow.md' },
  { source: 'Claude', path: 'empty.md' },
  { source: 'Claude', path: 'subagents/implementer.md' },
  { source: 'Claude', path: 'workflow.md' },
]

test('API lists exactly all five fixture Markdown files, including empty/nested files', async () => {
  const app = createApp()
  try {
    const response = await app.inject('/api/files')
    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json(), { files: expected })
    assert.equal((await app.inject('/api/files?root=/tmp')).body, response.body)
  } finally { await app.close() }
})

test('empty folders, symlink exclusion, and unreadable/missing source errors', async () => {
  const root = await mkdtemp(join(tmpdir(), 'md-manager-test-'))
  const app = createApp(root)
  try {
    await mkdir(join(root, 'pi'))
    await mkdir(join(root, 'claude'))
    await writeFile(join(root, 'outside.md'), 'Not in a source folder')
    await symlink(join(root, 'outside.md'), join(root, 'pi', 'linked.md'))
    await symlink(root, join(root, 'claude', 'linked-directory'))
    const empty = await app.inject('/api/files')
    assert.equal(empty.statusCode, 200)
    assert.deepEqual(empty.json(), { files: [] })
    await rm(join(root, 'claude'), { recursive: true })
    const failed = await app.inject('/api/files')
    assert.equal(failed.statusCode, 500)
    assert.match(failed.json().error, /both fixture folders are readable/)
    assert.ok(!failed.body.includes(root))
  } finally {
    await app.close()
    await rm(root, { recursive: true, force: true })
  }
})
