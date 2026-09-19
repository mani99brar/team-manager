import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createApp, defaultFixtureRoot, resolveFixtureRoot } from './app.ts'

const expected = [
  { source: 'Pi', path: 'skills', kind: 'directory' },
  { source: 'Pi', path: 'skills/review.md', kind: 'file' },
  { source: 'Pi', path: 'workflow.md', kind: 'file' },
  { source: 'Claude', path: 'empty.md', kind: 'file' },
  { source: 'Claude', path: 'subagents', kind: 'directory' },
  { source: 'Claude', path: 'subagents/implementer.md', kind: 'file' },
  { source: 'Claude', path: 'workflow.md', kind: 'file' },
]

async function withTempRoot(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'md-manager-test-'))
  try {
    await mkdir(join(root, 'pi'))
    await mkdir(join(root, 'claude'))
    await run(root)
  } finally {
    await chmod(join(root, 'pi'), 0o755).catch(() => undefined)
    await rm(root, { recursive: true, force: true })
  }
}

test('lists the committed fixtures as a flat, ordered list of directories and Markdown files', async () => {
  const app = createApp(defaultFixtureRoot)
  try {
    const response = await app.inject('/api/entries')
    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json(), { entries: expected })
    // Query parameters cannot select a different root or path.
    assert.equal((await app.inject('/api/entries?root=/tmp&path=..')).body, response.body)
    // The previous endpoint is gone.
    assert.equal((await app.inject('/api/files')).statusCode, 404)
  } finally { await app.close() }
})

test('fixture root comes from MD_MANAGER_FIXTURE_ROOT or the repository default', () => {
  assert.equal(resolveFixtureRoot({}), defaultFixtureRoot)
  assert.equal(resolveFixtureRoot({ MD_MANAGER_FIXTURE_ROOT: '   ' }), defaultFixtureRoot)
  assert.equal(resolveFixtureRoot({ MD_MANAGER_FIXTURE_ROOT: 'scratch/root' }), resolve('scratch/root'))
})

test('includes nested and empty directories and uppercase .MD, excludes other files and symlinks', async () => {
  await withTempRoot(async root => {
    await mkdir(join(root, 'pi', 'b-empty'))
    await mkdir(join(root, 'pi', 'a-nested', 'deeper'), { recursive: true })
    await writeFile(join(root, 'pi', 'a-nested', 'deeper', 'NOTE.MD'), '')
    await writeFile(join(root, 'pi', 'a-nested', 'ignored.txt'), 'nope')
    await writeFile(join(root, 'pi', 'a-nested', 'archive.md.bak'), 'nope')
    await writeFile(join(root, 'pi', 'zeta.md'), '')
    await writeFile(join(root, 'outside.md'), 'Not in a source folder')
    await symlink(join(root, 'outside.md'), join(root, 'pi', 'linked.md'))
    await symlink(root, join(root, 'claude', 'linked-directory'))
    await symlink(join(root, 'pi'), join(root, 'claude', 'linked-source'))
    const app = createApp(root)
    try {
      const response = await app.inject('/api/entries')
      assert.equal(response.statusCode, 200)
      assert.deepEqual(response.json(), {
        entries: [
          { source: 'Pi', path: 'a-nested', kind: 'directory' },
          { source: 'Pi', path: 'a-nested/deeper', kind: 'directory' },
          { source: 'Pi', path: 'a-nested/deeper/NOTE.MD', kind: 'file' },
          { source: 'Pi', path: 'b-empty', kind: 'directory' },
          { source: 'Pi', path: 'zeta.md', kind: 'file' },
        ],
      })
    } finally { await app.close() }
  })
})

test('missing, unreadable or symlinked sources fail the whole listing without exposing paths', async () => {
  await withTempRoot(async root => {
    await writeFile(join(root, 'pi', 'keep.md'), '')
    const app = createApp(root)
    try {
      await rm(join(root, 'claude'), { recursive: true })
      const missing = await app.inject('/api/entries')
      assert.equal(missing.statusCode, 500)
      assert.match(missing.json().error, /Unable to read the Claude fixture folder/)
      assert.ok(!missing.body.includes(root))

      await symlink(join(root, 'pi'), join(root, 'claude'))
      const linked = await app.inject('/api/entries')
      assert.equal(linked.statusCode, 500)
      assert.match(linked.json().error, /Claude fixture folder/)

      await rm(join(root, 'claude'))
      await mkdir(join(root, 'claude'))
      if (process.getuid?.() !== 0) {
        await chmod(join(root, 'pi'), 0o000)
        const unreadable = await app.inject('/api/entries')
        assert.equal(unreadable.statusCode, 500)
        assert.match(unreadable.json().error, /Unable to read the Pi fixture folder/)
        assert.ok(!unreadable.body.includes(root))
      }
    } finally { await app.close() }
  })
})
