import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from './app.ts'
import { defaultFixtureRoot, fixtureLocations } from './config.ts'

const PI = 'pi-fixtures'
const CLAUDE = 'claude-fixtures'

const expectedLocations = [
  { id: PI, source: 'Pi', label: 'Fixtures', category: 'personal', status: 'available', error: null },
  { id: CLAUDE, source: 'Claude', label: 'Fixtures', category: 'personal', status: 'available', error: null },
]

const expected = [
  { source: 'Pi', locationId: PI, path: 'skills', kind: 'directory' },
  { source: 'Pi', locationId: PI, path: 'skills/review.md', kind: 'file' },
  { source: 'Pi', locationId: PI, path: 'workflow.md', kind: 'file' },
  { source: 'Claude', locationId: CLAUDE, path: 'empty.md', kind: 'file' },
  { source: 'Claude', locationId: CLAUDE, path: 'subagents', kind: 'directory' },
  { source: 'Claude', locationId: CLAUDE, path: 'subagents/implementer.md', kind: 'file' },
  { source: 'Claude', locationId: CLAUDE, path: 'workflow.md', kind: 'file' },
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

test('lists the committed fixtures as location metadata plus a flat, ordered list of directories and Markdown files', async () => {
  const app = createApp(fixtureLocations(defaultFixtureRoot))
  try {
    const response = await app.inject('/api/entries')
    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json(), { locations: expectedLocations, entries: expected })
    assert.ok(!response.body.includes(defaultFixtureRoot), 'absolute root paths are never exposed')
    // Query parameters cannot select a different root or path.
    assert.equal((await app.inject('/api/entries?root=/tmp&path=..&locationId=x')).body, response.body)
    // The previous endpoint is gone.
    assert.equal((await app.inject('/api/files')).statusCode, 404)
  } finally { await app.close() }
})

test('includes nested, empty and other dot directories and uppercase .MD; excludes .git at any depth, other files and symlinks', async () => {
  await withTempRoot(async root => {
    await mkdir(join(root, 'pi', 'b-empty'))
    await mkdir(join(root, 'pi', 'a-nested', 'deeper'), { recursive: true })
    await writeFile(join(root, 'pi', 'a-nested', 'deeper', 'NOTE.MD'), '')
    await writeFile(join(root, 'pi', 'a-nested', 'ignored.txt'), 'nope')
    await writeFile(join(root, 'pi', 'a-nested', 'archive.md.bak'), 'nope')
    await writeFile(join(root, 'pi', 'zeta.md'), '')
    await mkdir(join(root, 'pi', '.git', 'hooks'), { recursive: true })
    await writeFile(join(root, 'pi', '.git', 'README.md'), 'git internals')
    await mkdir(join(root, 'pi', 'a-nested', '.git'))
    await writeFile(join(root, 'pi', 'a-nested', '.git', 'HEAD.md'), 'nested git')
    await mkdir(join(root, 'pi', '.hidden'))
    await writeFile(join(root, 'pi', '.hidden', 'note.md'), 'dot directories other than .git count')
    await writeFile(join(root, 'outside.md'), 'Not in a source folder')
    await symlink(join(root, 'outside.md'), join(root, 'pi', 'linked.md'))
    await symlink(root, join(root, 'claude', 'linked-directory'))
    await symlink(join(root, 'pi'), join(root, 'claude', 'linked-source'))
    const app = createApp(fixtureLocations(root))
    try {
      const response = await app.inject('/api/entries')
      assert.equal(response.statusCode, 200)
      assert.deepEqual(response.json().entries, [
        { source: 'Pi', locationId: PI, path: '.hidden', kind: 'directory' },
        { source: 'Pi', locationId: PI, path: '.hidden/note.md', kind: 'file' },
        { source: 'Pi', locationId: PI, path: 'a-nested', kind: 'directory' },
        { source: 'Pi', locationId: PI, path: 'a-nested/deeper', kind: 'directory' },
        { source: 'Pi', locationId: PI, path: 'a-nested/deeper/NOTE.MD', kind: 'file' },
        { source: 'Pi', locationId: PI, path: 'b-empty', kind: 'directory' },
        { source: 'Pi', locationId: PI, path: 'zeta.md', kind: 'file' },
      ])
      assert.ok(!response.body.includes('.git'))
    } finally { await app.close() }
  })
})

test('a missing, symlinked or unreadable location is reported unavailable per location; healthy locations still list; refresh recovers', async () => {
  await withTempRoot(async root => {
    await writeFile(join(root, 'pi', 'keep.md'), '')
    await writeFile(join(root, 'claude', 'other.md'), '')
    const app = createApp(fixtureLocations(root))
    try {
      const both = (await app.inject('/api/entries')).json()
      assert.deepEqual(both.locations.map((location: { status: string }) => location.status), ['available', 'available'])

      await rm(join(root, 'claude'), { recursive: true })
      const missing = await app.inject('/api/entries')
      assert.equal(missing.statusCode, 200)
      const missingBody = missing.json()
      assert.deepEqual(missingBody.entries, [{ source: 'Pi', locationId: PI, path: 'keep.md', kind: 'file' }])
      assert.equal(missingBody.locations[0].status, 'available')
      assert.equal(missingBody.locations[1].status, 'unavailable')
      assert.match(missingBody.locations[1].error, /does not exist|not found|missing/i)
      assert.ok(!missing.body.includes(root), 'no absolute path in the unavailable diagnostic')

      await symlink(join(root, 'pi'), join(root, 'claude'))
      const linked = (await app.inject('/api/entries')).json()
      assert.equal(linked.locations[1].status, 'unavailable')
      assert.match(linked.locations[1].error, /symbolic link/i)
      assert.equal(linked.entries.length, 1)

      await rm(join(root, 'claude'))
      await mkdir(join(root, 'claude'))
      await writeFile(join(root, 'claude', 'restored.md'), '')
      const restored = (await app.inject('/api/entries')).json()
      assert.deepEqual(restored.locations.map((location: { status: string }) => location.status), ['available', 'available'])
      assert.ok(restored.entries.some((entry: { locationId: string; path: string }) => entry.locationId === CLAUDE && entry.path === 'restored.md'))
      assert.equal((await app.inject(`/api/file?source=Claude&locationId=${CLAUDE}&path=restored.md`)).statusCode, 200)

      if (process.getuid?.() !== 0) {
        await chmod(join(root, 'pi'), 0o000)
        const unreadable = (await app.inject('/api/entries')).json()
        assert.equal(unreadable.locations[0].status, 'unavailable')
        assert.match(unreadable.locations[0].error, /readable|permission/i)
        assert.equal(unreadable.locations[1].status, 'available')
        await chmod(join(root, 'pi'), 0o755)
        const readable = (await app.inject('/api/entries')).json()
        assert.equal(readable.locations[0].status, 'available')
      }
    } finally { await app.close() }
  })
})
