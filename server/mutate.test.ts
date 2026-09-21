import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs, { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from './app.ts'
import { defaultFixtureRoot, fixtureLocations } from './config.ts'

const PI = 'pi-fixtures'
const CLAUDE = 'claude-fixtures'
import { LocationRegistry } from './registry.ts'
import { performMutation, type MutationRequest } from './mutations.ts'

function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

async function withTempRoot(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'md-manager-mutate-test-'))
  try {
    await mkdir(join(root, 'pi'))
    await mkdir(join(root, 'claude'))
    await run(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

type App = ReturnType<typeof createApp>

function mutate(app: App, payload: unknown, headers: Record<string, string> = {}) {
  return app.inject({ method: 'POST', url: '/api/mutate', payload: payload as never, headers })
}

async function tree(root: string): Promise<string[]> {
  const out: string[] = []
  async function walk(directory: string, prefix: string) {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name
      out.push(entry.isDirectory() ? `${path}/` : entry.isSymbolicLink() ? `${path}@` : path)
      if (entry.isDirectory()) await walk(join(directory, entry.name), path)
    }
  }
  await walk(root, '')
  return out
}

test('create-file creates an empty or filled Markdown file in either source, nested parents and uppercase .MD included', async () => {
  await withTempRoot(async root => {
    await mkdir(join(root, 'claude', 'nested', 'deeper'), { recursive: true })
    const app = createApp(fixtureLocations(root))
    try {
      const empty = await mutate(app, { op: 'create-file', source: 'Pi', locationId: PI, path: 'new.md' })
      assert.equal(empty.statusCode, 201, empty.body)
      assert.deepEqual(empty.json(), { op: 'create-file', source: 'Pi', locationId: PI, path: 'new.md' })
      assert.equal(await readFile(join(root, 'pi', 'new.md'), 'utf8'), '')

      const filled = await mutate(app, { op: 'create-file', source: 'Claude', locationId: CLAUDE, path: 'nested/deeper/NOTE.MD', content: '# Hello\r\n' })
      assert.equal(filled.statusCode, 201, filled.body)
      assert.deepEqual(filled.json(), { op: 'create-file', source: 'Claude', locationId: CLAUDE, path: 'nested/deeper/NOTE.MD' })
      assert.equal(await readFile(join(root, 'claude', 'nested', 'deeper', 'NOTE.MD'), 'utf8'), '# Hello\r\n')

      // The same name in the other source is a different file.
      const duplicate = await mutate(app, { op: 'create-file', source: 'Claude', locationId: CLAUDE, path: 'new.md', content: 'claude' })
      assert.equal(duplicate.statusCode, 201)
      assert.equal(await readFile(join(root, 'pi', 'new.md'), 'utf8'), '')
      assert.equal(await readFile(join(root, 'claude', 'new.md'), 'utf8'), 'claude')

      // Special characters and literal percent signs.
      const special = await mutate(app, { op: 'create-file', source: 'Pi', locationId: PI, path: 'a b#c?d%2e.md' })
      assert.equal(special.statusCode, 201)
      assert.equal(special.json().path, 'a b#c?d%2e.md')
      assert.ok((await tree(join(root, 'pi'))).includes('a b#c?d%2e.md'))

      // The new file is readable and listed.
      const read = await app.inject('/api/file?source=Claude&locationId=claude-fixtures&path=nested%2Fdeeper%2FNOTE.MD')
      assert.equal(read.json().content, '# Hello\r\n')
      const entries = (await app.inject('/api/entries')).json().entries
      assert.ok(entries.some((entry: { source: string; path: string }) => entry.source === 'Pi' && entry.path === 'new.md'))
    } finally { await app.close() }
  })
})

test('create-folder creates one empty directory and never creates parents implicitly', async () => {
  await withTempRoot(async root => {
    const app = createApp(fixtureLocations(root))
    try {
      const created = await mutate(app, { op: 'create-folder', source: 'Claude', locationId: CLAUDE, path: 'topics' })
      assert.equal(created.statusCode, 201, created.body)
      assert.deepEqual(created.json(), { op: 'create-folder', source: 'Claude', locationId: CLAUDE, path: 'topics' })
      assert.ok((await stat(join(root, 'claude', 'topics'))).isDirectory())
      const nested = await mutate(app, { op: 'create-folder', source: 'Claude', locationId: CLAUDE, path: 'topics/inner' })
      assert.equal(nested.statusCode, 201)

      const missingParent = await mutate(app, { op: 'create-folder', source: 'Pi', locationId: PI, path: 'missing/child' })
      assert.equal(missingParent.statusCode, 404)
      assert.equal(missingParent.json().code, 'NOT_FOUND')
      const missingFileParent = await mutate(app, { op: 'create-file', source: 'Pi', locationId: PI, path: 'missing/child.md' })
      assert.equal(missingFileParent.statusCode, 404)
      assert.deepEqual(await tree(join(root, 'pi')), [])
    } finally { await app.close() }
  })
})

test('rename changes the basename within the same parent for files and empty folders', async () => {
  await withTempRoot(async root => {
    await mkdir(join(root, 'pi', 'skills'))
    await writeFile(join(root, 'pi', 'skills', 'review.md'), 'review')
    await chmod(join(root, 'pi', 'skills', 'review.md'), 0o640)
    await mkdir(join(root, 'pi', 'empty'))
    const app = createApp(fixtureLocations(root))
    try {
      const file = await mutate(app, { op: 'rename', source: 'Pi', locationId: PI, path: 'skills/review.md', destinationPath: 'skills/Reviewed.MD' })
      assert.equal(file.statusCode, 200, file.body)
      assert.deepEqual(file.json(), { op: 'rename', source: 'Pi', locationId: PI, path: 'skills/review.md', destinationSource: 'Pi', destinationLocationId: PI, destinationPath: 'skills/Reviewed.MD' })
      assert.equal(await readFile(join(root, 'pi', 'skills', 'Reviewed.MD'), 'utf8'), 'review')
      assert.equal((await stat(join(root, 'pi', 'skills', 'Reviewed.MD'))).mode & 0o777, 0o640)

      const folder = await mutate(app, { op: 'rename', source: 'Pi', locationId: PI, path: 'empty', destinationPath: 'renamed' })
      assert.equal(folder.statusCode, 200, folder.body)
      assert.deepEqual(await tree(join(root, 'pi')), ['renamed/', 'skills/', 'skills/Reviewed.MD'])

      // Different parent is a move, not a rename.
      const elsewhere = await mutate(app, { op: 'rename', source: 'Pi', locationId: PI, path: 'skills/Reviewed.MD', destinationPath: 'Reviewed.MD' })
      assert.equal(elsewhere.statusCode, 400)
      assert.equal(elsewhere.json().code, 'INVALID_PATH')
      // A file must keep a Markdown extension; a folder must not take one.
      const extension = await mutate(app, { op: 'rename', source: 'Pi', locationId: PI, path: 'skills/Reviewed.MD', destinationPath: 'skills/Reviewed.txt' })
      assert.equal(extension.statusCode, 400)
      const folderExtension = await mutate(app, { op: 'rename', source: 'Pi', locationId: PI, path: 'renamed', destinationPath: 'renamed.md' })
      assert.equal(folderExtension.statusCode, 400)
      // Same path is a no-op conflict.
      const same = await mutate(app, { op: 'rename', source: 'Pi', locationId: PI, path: 'skills/Reviewed.MD', destinationPath: 'skills/Reviewed.MD' })
      assert.equal(same.statusCode, 409)
      assert.equal(same.json().code, 'NO_CHANGE')
      assert.deepEqual(await tree(join(root, 'pi')), ['renamed/', 'skills/', 'skills/Reviewed.MD'])
    } finally { await app.close() }
  })
})

test('move relocates files and empty folders within the same source; the destination parent must exist', async () => {
  await withTempRoot(async root => {
    await mkdir(join(root, 'claude', 'a'))
    await mkdir(join(root, 'claude', 'b'))
    await writeFile(join(root, 'claude', 'a', 'doc.md'), 'doc')
    await mkdir(join(root, 'claude', 'a', 'empty'))
    const app = createApp(fixtureLocations(root))
    try {
      const file = await mutate(app, { op: 'move', source: 'Claude', locationId: CLAUDE, path: 'a/doc.md', destinationPath: 'b/moved.md' })
      assert.equal(file.statusCode, 200, file.body)
      assert.deepEqual(file.json(), { op: 'move', source: 'Claude', locationId: CLAUDE, path: 'a/doc.md', destinationSource: 'Claude', destinationLocationId: CLAUDE, destinationPath: 'b/moved.md' })
      const folder = await mutate(app, { op: 'move', source: 'Claude', locationId: CLAUDE, path: 'a/empty', destinationPath: 'empty' })
      assert.equal(folder.statusCode, 200, folder.body)
      assert.deepEqual(await tree(join(root, 'claude')), ['a/', 'b/', 'b/moved.md', 'empty/'])

      const missingParent = await mutate(app, { op: 'move', source: 'Claude', locationId: CLAUDE, path: 'b/moved.md', destinationPath: 'nope/moved.md' })
      assert.equal(missingParent.statusCode, 404)
      assert.equal(missingParent.json().code, 'NOT_FOUND')
      const intoItself = await mutate(app, { op: 'move', source: 'Claude', locationId: CLAUDE, path: 'b', destinationPath: 'b/inner' })
      assert.equal(intoItself.statusCode, 400)
      const crossSource = await mutate(app, { op: 'move', source: 'Claude', locationId: CLAUDE, path: 'b/moved.md', destinationSource: 'Pi', destinationLocationId: PI, destinationPath: 'moved.md' })
      assert.equal(crossSource.statusCode, 400)
      assert.deepEqual(await tree(join(root, 'claude')), ['a/', 'b/', 'b/moved.md', 'empty/'])
      assert.deepEqual(await tree(join(root, 'pi')), [])
    } finally { await app.close() }
  })
})

test('delete removes a Markdown file or an empty folder and never recurses', async () => {
  await withTempRoot(async root => {
    await writeFile(join(root, 'pi', 'gone.md'), 'bye')
    await mkdir(join(root, 'pi', 'empty'))
    await mkdir(join(root, 'pi', 'hidden-only'))
    await writeFile(join(root, 'pi', 'hidden-only', '.keep'), '')
    await mkdir(join(root, 'pi', 'other-only'))
    await writeFile(join(root, 'pi', 'other-only', 'notes.txt'), 'not markdown')
    await mkdir(join(root, 'pi', 'nested'))
    await mkdir(join(root, 'pi', 'nested', 'child'))
    const app = createApp(fixtureLocations(root))
    try {
      const file = await mutate(app, { op: 'delete', source: 'Pi', locationId: PI, path: 'gone.md' })
      assert.equal(file.statusCode, 200, file.body)
      assert.deepEqual(file.json(), { op: 'delete', source: 'Pi', locationId: PI, path: 'gone.md' })
      const folder = await mutate(app, { op: 'delete', source: 'Pi', locationId: PI, path: 'empty' })
      assert.equal(folder.statusCode, 200)
      for (const path of ['hidden-only', 'other-only', 'nested']) {
        const response = await mutate(app, { op: 'delete', source: 'Pi', locationId: PI, path })
        assert.equal(response.statusCode, 409, path)
        assert.equal(response.json().code, 'FOLDER_NOT_EMPTY', path)
      }
      assert.deepEqual(await tree(join(root, 'pi')), ['hidden-only/', 'hidden-only/.keep', 'nested/', 'nested/child/', 'other-only/', 'other-only/notes.txt'])
      const again = await mutate(app, { op: 'delete', source: 'Pi', locationId: PI, path: 'gone.md' })
      assert.equal(again.statusCode, 404)
    } finally { await app.close() }
  })
})

test('nonempty folders cannot be renamed or moved either', async () => {
  await withTempRoot(async root => {
    await mkdir(join(root, 'pi', 'full'))
    await writeFile(join(root, 'pi', 'full', '.hidden'), '')
    const app = createApp(fixtureLocations(root))
    try {
      const rename = await mutate(app, { op: 'rename', source: 'Pi', locationId: PI, path: 'full', destinationPath: 'renamed' })
      assert.equal(rename.statusCode, 409)
      assert.equal(rename.json().code, 'FOLDER_NOT_EMPTY')
      await mkdir(join(root, 'pi', 'target'))
      const move = await mutate(app, { op: 'move', source: 'Pi', locationId: PI, path: 'full', destinationPath: 'target/full' })
      assert.equal(move.statusCode, 409)
      assert.equal(move.json().code, 'FOLDER_NOT_EMPTY')
      assert.deepEqual(await tree(join(root, 'pi')), ['full/', 'full/.hidden', 'target/'])
    } finally { await app.close() }
  })
})

test('copy duplicates the exact bytes of a Markdown file into the other source only', async () => {
  await withTempRoot(async root => {
    const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('---\r\nname: review\r\n---\r\n# Review\r\n', 'utf8')])
    await mkdir(join(root, 'pi', 'skills'))
    await writeFile(join(root, 'pi', 'skills', 'review.md'), bytes)
    await chmod(join(root, 'pi', 'skills', 'review.md'), 0o600)
    await mkdir(join(root, 'claude', 'imported'))
    const app = createApp(fixtureLocations(root))
    try {
      const copied = await mutate(app, { op: 'copy', source: 'Pi', locationId: PI, path: 'skills/review.md', destinationSource: 'Claude', destinationLocationId: CLAUDE, destinationPath: 'imported/review.md' })
      assert.equal(copied.statusCode, 201, copied.body)
      assert.deepEqual(copied.json(), { op: 'copy', source: 'Pi', locationId: PI, path: 'skills/review.md', destinationSource: 'Claude', destinationLocationId: CLAUDE, destinationPath: 'imported/review.md' })
      assert.deepEqual(await readFile(join(root, 'claude', 'imported', 'review.md')), bytes)
      assert.deepEqual(await readFile(join(root, 'pi', 'skills', 'review.md')), bytes)
      assert.equal((await stat(join(root, 'claude', 'imported', 'review.md'))).mode & 0o777, 0o600)

      const sameSource = await mutate(app, { op: 'copy', source: 'Pi', locationId: PI, path: 'skills/review.md', destinationSource: 'Pi', destinationLocationId: PI, destinationPath: 'copy.md' })
      assert.equal(sameSource.statusCode, 400)
      const noDestination = await mutate(app, { op: 'copy', source: 'Pi', locationId: PI, path: 'skills/review.md', destinationPath: 'copy.md' })
      assert.equal(noDestination.statusCode, 400)
      const folder = await mutate(app, { op: 'copy', source: 'Pi', locationId: PI, path: 'skills', destinationSource: 'Claude', destinationLocationId: CLAUDE, destinationPath: 'skills' })
      assert.equal(folder.statusCode, 404)
      const missingParent = await mutate(app, { op: 'copy', source: 'Pi', locationId: PI, path: 'skills/review.md', destinationSource: 'Claude', destinationLocationId: CLAUDE, destinationPath: 'nope/review.md' })
      assert.equal(missingParent.statusCode, 404)
      const extension = await mutate(app, { op: 'copy', source: 'Pi', locationId: PI, path: 'skills/review.md', destinationSource: 'Claude', destinationLocationId: CLAUDE, destinationPath: 'imported/review.txt' })
      assert.equal(extension.statusCode, 400)
      assert.deepEqual(await tree(join(root, 'claude')), ['imported/', 'imported/review.md'])
      assert.deepEqual(await tree(join(root, 'pi')), ['skills/', 'skills/review.md'])
    } finally { await app.close() }
  })
})

test('existing destinations, including dangling symlinks and directories, are never overwritten', async () => {
  await withTempRoot(async root => {
    await writeFile(join(root, 'pi', 'source.md'), 'source')
    await writeFile(join(root, 'pi', 'taken.md'), 'taken')
    await mkdir(join(root, 'pi', 'taken-folder'))
    await symlink(join(root, 'nowhere'), join(root, 'pi', 'dangling.md'))
    await symlink(join(root, 'nowhere'), join(root, 'pi', 'dangling-folder'))
    await writeFile(join(root, 'claude', 'taken.md'), 'claude taken')
    await writeFile(join(root, 'pi', 'plain'), 'not markdown')
    await mkdir(join(root, 'pi', 'folder-named.md'))
    await mkdir(join(root, 'pi', 'empty'))
    const app = createApp(fixtureLocations(root))
    const before = await tree(join(root, 'pi'))
    try {
      const cases: Array<[string, unknown]> = [
        ['create-file over file', { op: 'create-file', source: 'Pi', locationId: PI, path: 'taken.md' }],
        ['create-file over dangling symlink', { op: 'create-file', source: 'Pi', locationId: PI, path: 'dangling.md' }],
        ['create-folder over folder', { op: 'create-folder', source: 'Pi', locationId: PI, path: 'taken-folder' }],
        ['create-folder over dangling symlink', { op: 'create-folder', source: 'Pi', locationId: PI, path: 'dangling-folder' }],
        ['create-folder over file', { op: 'create-folder', source: 'Pi', locationId: PI, path: 'plain' }],
        ['create-file over folder', { op: 'create-file', source: 'Pi', locationId: PI, path: 'folder-named.md' }],
        ['rename onto file', { op: 'rename', source: 'Pi', locationId: PI, path: 'source.md', destinationPath: 'taken.md' }],
        ['rename onto dangling symlink', { op: 'rename', source: 'Pi', locationId: PI, path: 'source.md', destinationPath: 'dangling.md' }],
        ['move onto file', { op: 'move', source: 'Pi', locationId: PI, path: 'source.md', destinationPath: 'taken.md' }],
        ['folder rename onto folder', { op: 'rename', source: 'Pi', locationId: PI, path: 'empty', destinationPath: 'taken-folder' }],
        ['folder rename onto dangling symlink', { op: 'rename', source: 'Pi', locationId: PI, path: 'empty', destinationPath: 'dangling-folder' }],
        ['copy onto file', { op: 'copy', source: 'Pi', locationId: PI, path: 'source.md', destinationSource: 'Claude', destinationLocationId: CLAUDE, destinationPath: 'taken.md' }],
      ]
      for (const [label, payload] of cases) {
        const response = await mutate(app, payload)
        assert.equal(response.statusCode, 409, `${label}: ${response.body}`)
        assert.equal(response.json().code, 'DESTINATION_EXISTS', label)
        assert.ok(!response.body.includes(root), label)
      }
      assert.deepEqual(await tree(join(root, 'pi')), before)
      assert.equal(await readFile(join(root, 'pi', 'taken.md'), 'utf8'), 'taken')
      assert.equal(await readFile(join(root, 'pi', 'source.md'), 'utf8'), 'source')
      assert.equal(await readFile(join(root, 'claude', 'taken.md'), 'utf8'), 'claude taken')
      assert.ok((await lstat(join(root, 'pi', 'dangling.md'))).isSymbolicLink())
    } finally { await app.close() }
  })
})

test('invalid or missing fields, unknown ops, bad sources and malformed paths are rejected with 400 and no disk change', async () => {
  await withTempRoot(async root => {
    await writeFile(join(root, 'pi', 'real.md'), 'real')
    const app = createApp(fixtureLocations(root))
    try {
      const cases: Array<[string, unknown]> = [
        ['array', [{ op: 'create-file', source: 'Pi', locationId: PI, path: 'x.md' }]],
        ['null', 'null'],
        ['no op', { source: 'Pi', locationId: PI, path: 'x.md' }],
        ['unknown op', { op: 'truncate', source: 'Pi', locationId: PI, path: 'real.md' }],
        ['op case', { op: 'Create-File', source: 'Pi', locationId: PI, path: 'x.md' }],
        ['missing source', { op: 'create-file', path: 'x.md' }],
        ['bad source', { op: 'create-file', source: 'pi', path: 'x.md' }],
        ['missing path', { op: 'create-file', source: 'Pi', locationId: PI }],
        ['empty path', { op: 'create-file', source: 'Pi', locationId: PI, path: '' }],
        ['numeric path', { op: 'create-file', source: 'Pi', locationId: PI, path: 3 }],
        ['non-string content', { op: 'create-file', source: 'Pi', locationId: PI, path: 'x.md', content: 1 }],
        ['create non-md', { op: 'create-file', source: 'Pi', locationId: PI, path: 'x.txt' }],
        ['create md folder', { op: 'create-folder', source: 'Pi', locationId: PI, path: 'x.md' }],
        ['traversal', { op: 'create-file', source: 'Pi', locationId: PI, path: '../x.md' }],
        ['absolute', { op: 'create-file', source: 'Pi', locationId: PI, path: '/x.md' }],
        ['backslash', { op: 'create-file', source: 'Pi', locationId: PI, path: 'a\\x.md' }],
        ['NUL', { op: 'create-file', source: 'Pi', locationId: PI, path: 'x.md\0' }],
        ['dot', { op: 'create-folder', source: 'Pi', locationId: PI, path: '.' }],
        ['drive', { op: 'create-folder', source: 'Pi', locationId: PI, path: 'C:/x' }],
        ['UNC', { op: 'create-folder', source: 'Pi', locationId: PI, path: '\\\\server\\share' }],
        ['trailing slash', { op: 'create-folder', source: 'Pi', locationId: PI, path: 'x/' }],
        ['rename missing destination', { op: 'rename', source: 'Pi', locationId: PI, path: 'real.md' }],
        ['rename numeric destination', { op: 'rename', source: 'Pi', locationId: PI, path: 'real.md', destinationPath: 5 }],
        ['rename traversal destination', { op: 'rename', source: 'Pi', locationId: PI, path: 'real.md', destinationPath: '../real.md' }],
        ['rename absolute destination', { op: 'rename', source: 'Pi', locationId: PI, path: 'real.md', destinationPath: '/tmp/real.md' }],
        ['rename to empty', { op: 'rename', source: 'Pi', locationId: PI, path: 'real.md', destinationPath: '' }],
        ['move traversal destination', { op: 'move', source: 'Pi', locationId: PI, path: 'real.md', destinationPath: 'a/../../real.md' }],
        ['move destination source mismatch', { op: 'move', source: 'Pi', locationId: PI, path: 'real.md', destinationSource: 'Claude', destinationLocationId: CLAUDE, destinationPath: 'real.md' }],
        ['copy bad destination source', { op: 'copy', source: 'Pi', locationId: PI, path: 'real.md', destinationSource: 'Nope', destinationPath: 'real.md' }],
        ['copy traversal destination', { op: 'copy', source: 'Pi', locationId: PI, path: 'real.md', destinationSource: 'Claude', destinationLocationId: CLAUDE, destinationPath: '../real.md' }],
        ['copy NUL destination', { op: 'copy', source: 'Pi', locationId: PI, path: 'real.md', destinationSource: 'Claude', destinationLocationId: CLAUDE, destinationPath: 'x\0.md' }],
        ['delete non-md file', { op: 'delete', source: 'Pi', locationId: PI, path: 'notes.txt' }],
      ]
      for (const [label, payload] of cases) {
        const response = typeof payload === 'string'
          ? await app.inject({ method: 'POST', url: '/api/mutate', payload, headers: { 'content-type': 'application/json' } })
          : await mutate(app, payload)
        assert.ok(response.statusCode === 400 || (label === 'delete non-md file' && response.statusCode === 404), `${label}: ${response.statusCode} ${response.body}`)
        assert.equal(typeof response.json().code, 'string', label)
        assert.equal(typeof response.json().error, 'string', label)
        assert.ok(!response.body.includes(root), label)
      }
      const malformed = await app.inject({ method: 'POST', url: '/api/mutate', payload: '{"op": ', headers: { 'content-type': 'application/json' } })
      assert.equal(malformed.statusCode, 400)
      assert.deepEqual(await tree(join(root, 'pi')), ['real.md'])
      assert.deepEqual(await tree(join(root)), ['claude/', 'pi/', 'pi/real.md'])
    } finally { await app.close() }
  })
})

test('source roots cannot be renamed, moved, deleted or copied, and an empty path is never a target', async () => {
  await withTempRoot(async root => {
    await writeFile(join(root, 'pi', 'real.md'), 'real')
    const app = createApp(fixtureLocations(root))
    try {
      const cases: unknown[] = [
        { op: 'rename', source: 'Pi', locationId: PI, path: '', destinationPath: 'renamed' },
        { op: 'move', source: 'Pi', locationId: PI, path: '', destinationPath: 'moved' },
        { op: 'delete', source: 'Pi', locationId: PI, path: '' },
        { op: 'copy', source: 'Pi', locationId: PI, path: '', destinationSource: 'Claude', destinationLocationId: CLAUDE, destinationPath: 'x.md' },
        { op: 'move', source: 'Pi', locationId: PI, path: 'real.md', destinationPath: '' },
        { op: 'create-folder', source: 'Pi', locationId: PI, path: '' },
      ]
      for (const payload of cases) {
        const response = await mutate(app, payload)
        assert.equal(response.statusCode, 400, JSON.stringify(payload))
      }
      assert.deepEqual(await tree(join(root)), ['claude/', 'pi/', 'pi/real.md'])
    } finally { await app.close() }
  })
})

test('missing targets and symlinks anywhere in source or destination paths are rejected with 404 and nothing changes', async () => {
  await withTempRoot(async root => {
    await mkdir(join(root, 'outside'))
    await writeFile(join(root, 'outside', 'secret.md'), 'OUTSIDE SOURCE')
    await writeFile(join(root, 'pi', 'real.md'), 'real')
    await mkdir(join(root, 'pi', 'skills'))
    await symlink(join(root, 'outside', 'secret.md'), join(root, 'pi', 'linked.md'))
    await symlink(join(root, 'outside'), join(root, 'pi', 'linked-dir'))
    await symlink(join(root, 'pi'), join(root, 'pi', 'self'))
    await rm(join(root, 'claude'), { recursive: true })
    await symlink(join(root, 'outside'), join(root, 'claude'))
    const app = createApp(fixtureLocations(root))
    const before = await tree(root)
    try {
      const cases: Array<[string, unknown]> = [
        ['delete missing', { op: 'delete', source: 'Pi', locationId: PI, path: 'missing.md' }],
        ['rename missing', { op: 'rename', source: 'Pi', locationId: PI, path: 'missing.md', destinationPath: 'x.md' }],
        ['move missing folder', { op: 'move', source: 'Pi', locationId: PI, path: 'missing', destinationPath: 'x' }],
        ['copy missing', { op: 'copy', source: 'Pi', locationId: PI, path: 'missing.md', destinationSource: 'Claude', destinationLocationId: CLAUDE, destinationPath: 'x.md' }],
        ['delete symlinked file', { op: 'delete', source: 'Pi', locationId: PI, path: 'linked.md' }],
        ['rename symlinked file', { op: 'rename', source: 'Pi', locationId: PI, path: 'linked.md', destinationPath: 'renamed.md' }],
        ['delete symlinked dir', { op: 'delete', source: 'Pi', locationId: PI, path: 'linked-dir' }],
        ['copy symlinked file', { op: 'copy', source: 'Pi', locationId: PI, path: 'linked.md', destinationSource: 'Claude', destinationLocationId: CLAUDE, destinationPath: 'x.md' }],
        ['create through symlinked dir', { op: 'create-file', source: 'Pi', locationId: PI, path: 'linked-dir/new.md' }],
        ['create through self link', { op: 'create-folder', source: 'Pi', locationId: PI, path: 'self/new' }],
        ['delete through symlinked dir', { op: 'delete', source: 'Pi', locationId: PI, path: 'linked-dir/secret.md' }],
        ['move into symlinked dir', { op: 'move', source: 'Pi', locationId: PI, path: 'real.md', destinationPath: 'linked-dir/real.md' }],
        ['move into self link', { op: 'move', source: 'Pi', locationId: PI, path: 'real.md', destinationPath: 'self/real.md' }],
        ['copy into symlinked source root', { op: 'copy', source: 'Pi', locationId: PI, path: 'real.md', destinationSource: 'Claude', destinationLocationId: CLAUDE, destinationPath: 'real.md' }],
        ['create in symlinked source root', { op: 'create-file', source: 'Claude', locationId: CLAUDE, path: 'new.md' }],
        ['delete in symlinked source root', { op: 'delete', source: 'Claude', locationId: CLAUDE, path: 'secret.md' }],
        ['delete file as folder parent', { op: 'delete', source: 'Pi', locationId: PI, path: 'real.md/child.md' }],
      ]
      for (const [label, payload] of cases) {
        const response = await mutate(app, payload)
        assert.equal(response.statusCode, 404, `${label}: ${response.statusCode} ${response.body}`)
        // The Claude root itself is the symlink: that is an unavailable location, not a missing target.
        assert.equal(response.json().code, label.includes('symlinked source root') ? 'LOCATION_UNAVAILABLE' : 'NOT_FOUND', label)
        assert.ok(!response.body.includes(root), label)
        assert.ok(!response.body.includes('OUTSIDE SOURCE'), label)
      }
      assert.deepEqual(await tree(root), before)
      assert.equal(await readFile(join(root, 'outside', 'secret.md'), 'utf8'), 'OUTSIDE SOURCE')
    } finally { await app.close() }
  })
})

test('a case-only rename succeeds when the filesystem reports the destination absent and is refused when it reports an entry', async () => {
  await withTempRoot(async root => {
    await writeFile(join(root, 'pi', 'Notes.md'), 'notes')
    const app = createApp(fixtureLocations(root))
    try {
      // This runner's fixture filesystem is case-sensitive: the probe finds nothing and the rename proceeds.
      const renamed = await mutate(app, { op: 'rename', source: 'Pi', locationId: PI, path: 'Notes.md', destinationPath: 'notes.md' })
      assert.equal(renamed.statusCode, 200, renamed.body)
      assert.deepEqual(await tree(join(root, 'pi')), ['notes.md'])
      assert.equal(await readFile(join(root, 'pi', 'notes.md'), 'utf8'), 'notes')

      // Simulate a case-insensitive volume: the probe reports an entry at the destination spelling.
      await app.ready()
      const lstatOriginal = fs.lstat
      mock.method(fs, 'lstat', async (path: Parameters<typeof lstatOriginal>[0], options?: Parameters<typeof lstatOriginal>[1]) => {
        if (String(path).endsWith('/NOTES.md')) return lstatOriginal(String(path).replace(/NOTES\.md$/, 'notes.md'), options as never)
        return lstatOriginal(path, options as never)
      })
      const refused = await mutate(app, { op: 'rename', source: 'Pi', locationId: PI, path: 'notes.md', destinationPath: 'NOTES.md' })
      assert.equal(refused.statusCode, 409, refused.body)
      assert.equal(refused.json().code, 'DESTINATION_EXISTS')
      mock.restoreAll()
      assert.deepEqual(await tree(join(root, 'pi')), ['notes.md'])
      assert.equal(await readFile(join(root, 'pi', 'notes.md'), 'utf8'), 'notes')
    } finally { mock.restoreAll(); await app.close() }
  })
})

test('concurrent operations on the same destination or on a file being saved are serialized safely', async () => {
  await withTempRoot(async root => {
    await writeFile(join(root, 'pi', 'a.md'), 'a')
    await writeFile(join(root, 'pi', 'b.md'), 'b')
    await writeFile(join(root, 'pi', 'saved.md'), 'saved')
    const app = createApp(fixtureLocations(root))
    try {
      const creates = await Promise.all([
        mutate(app, { op: 'create-file', source: 'Pi', locationId: PI, path: 'same.md', content: 'one' }),
        mutate(app, { op: 'create-file', source: 'Pi', locationId: PI, path: 'same.md', content: 'two' }),
      ])
      assert.deepEqual(creates.map(response => response.statusCode).sort(), [201, 409])
      const winner = creates.find(response => response.statusCode === 201)!
      assert.equal(await readFile(join(root, 'pi', 'same.md'), 'utf8'), winner === creates[0] ? 'one' : 'two')

      const renames = await Promise.all([
        mutate(app, { op: 'rename', source: 'Pi', locationId: PI, path: 'a.md', destinationPath: 'target.md' }),
        mutate(app, { op: 'rename', source: 'Pi', locationId: PI, path: 'b.md', destinationPath: 'target.md' }),
      ])
      assert.deepEqual(renames.map(response => response.statusCode).sort(), [200, 409])
      const kept = renames[0].statusCode === 200 ? 'b.md' : 'a.md'
      assert.deepEqual(await tree(join(root, 'pi')), [kept, 'same.md', 'saved.md', 'target.md'].sort())
      assert.equal(await readFile(join(root, 'pi', 'target.md'), 'utf8'), kept === 'b.md' ? 'a' : 'b')

      // A save and a delete of the same file: either the save lands first and the delete removes it, or the delete
      // lands first and the save reports the file missing. Never a partial file or a temp artifact.
      const [save, remove] = await Promise.all([
        app.inject({ method: 'PUT', url: '/api/file', payload: { source: 'Pi', locationId: PI, path: 'saved.md', content: 'updated', expectedHash: sha256('saved') } }),
        mutate(app, { op: 'delete', source: 'Pi', locationId: PI, path: 'saved.md' }),
      ])
      assert.equal(remove.statusCode, 200)
      assert.ok(save.statusCode === 200 || save.statusCode === 404, String(save.statusCode))
      assert.ok(!(await tree(join(root, 'pi'))).some(entry => entry.startsWith('saved.md') || entry.endsWith('.tmp')))
    } finally { await app.close() }
  })
})

test('unexpected filesystem failures are safe 500 errors without paths', async () => {
  await withTempRoot(async root => {
    await writeFile(join(root, 'pi', 'real.md'), 'real')
    const app = createApp(fixtureLocations(root))
    try {
      await app.ready()
      mock.method(fs, 'mkdir', async () => { throw Object.assign(new Error(`EIO ${root}`), { code: 'EIO' }) })
      const response = await mutate(app, { op: 'create-folder', source: 'Pi', locationId: PI, path: 'new' })
      assert.equal(response.statusCode, 500)
      assert.equal(response.json().code, 'MUTATION_FAILED')
      assert.ok(!response.body.includes(root))
      assert.ok(!response.body.includes('EIO'))
    } finally { mock.restoreAll(); await app.close() }
  })
})

test('the committed fixtures are never changed by the mutation test suite', async () => {
  const app = createApp(fixtureLocations(defaultFixtureRoot))
  try {
    const before = await tree(defaultFixtureRoot)
    const response = await mutate(app, { op: 'delete', source: 'Pi', locationId: PI, path: 'skills' })
    assert.equal(response.statusCode, 409)
    assert.deepEqual(await tree(defaultFixtureRoot), before)
  } finally { await app.close() }
})

for (const op of ['create-file', 'copy'] as const) {
  for (const failure of ['partial-write', ...(op === 'copy' ? ['chmod'] : [])]) {
    test(`${op} ${failure} leaves no partial destination and retry succeeds`, async () => {
      await withTempRoot(async root => {
        await writeFile(join(root, 'pi', 'source.md'), 'complete content')
        const app = createApp(fixtureLocations(root))
        const open = fs.open
        const payload = op === 'copy'
          ? { op, source: 'Pi', locationId: PI, path: 'source.md', destinationSource: 'Claude', destinationLocationId: CLAUDE, destinationPath: 'new.md' }
          : { op, source: 'Claude', locationId: CLAUDE, path: 'new.md', content: 'complete content' }
        try {
          await app.ready()
          let injected = false
          mock.method(fs, 'open', async (path: Parameters<typeof open>[0], flags?: Parameters<typeof open>[1], mode?: Parameters<typeof open>[2]) => {
            const handle = await open(path, flags, mode)
            if (typeof flags === 'number' && (flags & fs.constants.O_EXCL)) {
              const write = handle.writeFile.bind(handle)
              mock.method(handle, failure === 'chmod' ? 'chmod' : 'writeFile', async () => {
                injected = true
                if (failure === 'partial-write') await write('partial')
                throw Object.assign(new Error('injected'), { code: failure === 'chmod' ? 'EPERM' : 'ENOSPC' })
              })
            }
            return handle
          })
          const response = await mutate(app, payload)
          assert.ok(injected)
          assert.equal(response.statusCode, 500)
          assert.deepEqual(await readdir(join(root, 'claude')), [])
          assert.equal(await readFile(join(root, 'pi', 'source.md'), 'utf8'), 'complete content')
          mock.restoreAll()
          assert.equal((await mutate(app, payload)).statusCode, 201)
          assert.equal(await readFile(join(root, 'claude', 'new.md'), 'utf8'), 'complete content')
          assert.equal((await mutate(app, payload)).statusCode, 409)
          assert.equal(await readFile(join(root, 'claude', 'new.md'), 'utf8'), 'complete content')
        } finally { mock.restoreAll(); await app.close() }
      })
    })
  }

  test(`${op} never removes an external destination appearing during staging`, async () => {
    await withTempRoot(async root => {
      await writeFile(join(root, 'pi', 'source.md'), 'source')
      const target = join(root, 'claude', 'new.md')
      const app = createApp(fixtureLocations(root))
      const open = fs.open
      try {
        await app.ready()
        mock.method(fs, 'open', async (path: Parameters<typeof open>[0], flags?: Parameters<typeof open>[1], mode?: Parameters<typeof open>[2]) => {
          const handle = await open(path, flags, mode)
          if (typeof flags === 'number' && (flags & fs.constants.O_EXCL)) {
            mock.method(handle, 'writeFile', async () => {
              await rm(target, { force: true })
              await writeFile(target, 'external')
              throw Object.assign(new Error('full'), { code: 'ENOSPC' })
            })
          }
          return handle
        })
        const payload = op === 'copy'
          ? { op, source: 'Pi', locationId: PI, path: 'source.md', destinationSource: 'Claude', destinationLocationId: CLAUDE, destinationPath: 'new.md' }
          : { op, source: 'Claude', locationId: CLAUDE, path: 'new.md', content: 'content' }
        assert.equal((await mutate(app, payload)).statusCode, 500)
        assert.equal(await readFile(target, 'utf8'), 'external')
        assert.deepEqual(await readdir(join(root, 'claude')), ['new.md'])
      } finally { mock.restoreAll(); await app.close() }
    })
  })
}

for (const entry of ['file', 'symlink'] as const) {
  test(`exclusive publish refuses an external ${entry} installed during staging`, async () => {
    await withTempRoot(async root => {
      const target = join(root, 'pi', 'new.md')
      const outside = join(root, 'claude', 'outside.md')
      await writeFile(outside, 'outside')
      const app = createApp(fixtureLocations(root))
      const open = fs.open
      try {
        await app.ready()
        mock.method(fs, 'open', async (path: Parameters<typeof open>[0], flags?: Parameters<typeof open>[1], mode?: Parameters<typeof open>[2]) => {
          const handle = await open(path, flags, mode)
          if (typeof flags === 'number' && (flags & fs.constants.O_EXCL)) {
            if (entry === 'file') await writeFile(target, 'external')
            else await symlink(outside, target)
          }
          return handle
        })
        const response = await mutate(app, { op: 'create-file', source: 'Pi', locationId: PI, path: 'new.md', content: 'app' })
        assert.equal(response.statusCode, 409, response.body)
        assert.equal(response.json().code, 'DESTINATION_EXISTS')
        assert.equal(await readFile(target, 'utf8'), entry === 'file' ? 'external' : 'outside')
        assert.equal((await lstat(target)).isSymbolicLink(), entry === 'symlink')
        assert.equal(await readFile(outside, 'utf8'), 'outside')
        assert.deepEqual(await readdir(join(root, 'pi')), ['new.md'])
      } finally { mock.restoreAll(); await app.close() }
    })
  })
}


for (const op of ['create-file', 'copy'] as const) {
  for (const scenario of ['published-EIO', 'published-ENOENT', 'collision', 'partial-write'] as const) {
    test(`${op} preserves its primary result when staging cleanup fails: ${scenario}`, async () => {
      await withTempRoot(async directory => {
        await writeFile(join(directory, 'pi', 'source.md'), 'complete content')
        const registry = new LocationRegistry(fixtureLocations(directory))
        await registry.open()
        const target = join(directory, 'claude', 'new.md')
        const request: MutationRequest = op === 'copy'
          ? { op, source: 'Pi', locationId: PI, path: 'source.md', destinationSource: 'Claude', destinationLocationId: CLAUDE, destinationPath: 'new.md' }
          : { op, source: 'Claude', locationId: CLAUDE, path: 'new.md', content: 'complete content' }
        const unlink = fs.unlink
        const open = fs.open
        const writeFailure = Object.assign(new Error('primary write failure'), { code: 'ENOSPC' })
        let cleanupAttempts = 0
        const warnings: unknown[][] = []
        try {
          mock.method(console, 'warn', (...args: unknown[]) => { warnings.push(args) })
          mock.method(fs, 'unlink', async (path: Parameters<typeof unlink>[0]) => {
            cleanupAttempts++
            if (scenario === 'published-ENOENT') await unlink(path)
            throw Object.assign(new Error('cleanup failure'), { code: scenario === 'published-ENOENT' ? 'ENOENT' : 'EIO' })
          })
          mock.method(fs, 'open', async (path: Parameters<typeof open>[0], flags?: Parameters<typeof open>[1], mode?: Parameters<typeof open>[2]) => {
            const handle = await open(path, flags, mode)
            if (typeof flags === 'number' && (flags & fs.constants.O_EXCL)) {
              if (scenario === 'collision') await writeFile(target, 'external')
              if (scenario === 'partial-write') {
                const write = handle.writeFile.bind(handle)
                mock.method(handle, 'writeFile', async () => { await write('partial'); throw writeFailure })
              }
            }
            return handle
          })
          if (scenario === 'collision') {
            await assert.rejects(performMutation(registry, request), { code: 'DESTINATION_EXISTS' })
            assert.equal(await readFile(target, 'utf8'), 'external')
          } else if (scenario === 'partial-write') {
            await assert.rejects(performMutation(registry, request), error => error === writeFailure)
            await assert.rejects(lstat(target), { code: 'ENOENT' })
          } else {
            assert.equal((await performMutation(registry, request)).status, 201)
            assert.equal(await readFile(target, 'utf8'), 'complete content')
          }
          assert.equal(cleanupAttempts, 1)
          assert.equal(warnings.length, scenario === 'published-ENOENT' ? 0 : 1)
          if (warnings.length) assert.equal((warnings[0][1] as NodeJS.ErrnoException).code, 'EIO')
          assert.equal(await readFile(join(directory, 'pi', 'source.md'), 'utf8'), 'complete content')
        } finally { mock.restoreAll(); await registry.close() }
      })
    })
  }
}
