import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs, { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp, defaultFixtureRoot } from './app.ts'

function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

async function withTempRoot(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'md-manager-write-test-'))
  try {
    await mkdir(join(root, 'pi'))
    await mkdir(join(root, 'claude'))
    await run(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

type App = ReturnType<typeof createApp>

function put(app: App, payload: unknown, headers: Record<string, string> = {}) {
  return app.inject({ method: 'PUT', url: '/api/file', payload: payload as never, headers })
}

async function hashOnDisk(path: string): Promise<string> {
  return sha256(await readFile(path))
}

test('PUT writes exact UTF-8 bytes, returns the written hash, and the next read sees the new content', async () => {
  await withTempRoot(async root => {
    const original = '# Original\n'
    await writeFile(join(root, 'pi', 'note.md'), original)
    await mkdir(join(root, 'claude', 'nested'))
    await writeFile(join(root, 'claude', 'nested', 'NOTE.MD'), 'claude original')
    const app = createApp(root)
    try {
      const updated = '# Updated — 日本語 🚀\n\nbody'
      const response = await put(app, { source: 'Pi', path: 'note.md', content: updated, expectedHash: sha256(original) })
      assert.equal(response.statusCode, 200, response.body)
      assert.equal(response.headers['cache-control'], 'no-store')
      assert.deepEqual(response.json(), { source: 'Pi', path: 'note.md', hash: sha256(Buffer.from(updated, 'utf8')) })
      assert.equal((await readFile(join(root, 'pi', 'note.md'))).toString('utf8'), updated)

      const read = await app.inject('/api/file?source=Pi&path=note.md')
      assert.equal(read.json().content, updated)
      assert.equal(read.json().hash, response.json().hash)

      // The returned hash is the acknowledged hash for the next write.
      const again = await put(app, { source: 'Pi', path: 'note.md', content: 'third', expectedHash: response.json().hash })
      assert.equal(again.statusCode, 200)
      assert.equal(await readFile(join(root, 'pi', 'note.md'), 'utf8'), 'third')

      // Nested, uppercase .MD, other source.
      const nested = await put(app, { source: 'Claude', path: 'nested/NOTE.MD', content: 'claude updated', expectedHash: sha256('claude original') })
      assert.equal(nested.statusCode, 200)
      assert.deepEqual(nested.json(), { source: 'Claude', path: 'nested/NOTE.MD', hash: sha256('claude updated') })
      assert.equal(await readFile(join(root, 'claude', 'nested', 'NOTE.MD'), 'utf8'), 'claude updated')
      assert.equal(await readFile(join(root, 'pi', 'note.md'), 'utf8'), 'third')
    } finally { await app.close() }
  })
})

test('PUT preserves empty content, whitespace, CRLF, BOM and a missing final newline byte-for-byte', async () => {
  await withTempRoot(async root => {
    await writeFile(join(root, 'pi', 'note.md'), 'start')
    const app = createApp(root)
    try {
      let hash = sha256('start')
      const contents = [
        '',
        '  \r\n# Title\r\n\r\n\tindented\r\n  trailing  \r\n',
        '\uFEFF# BOM first\r\nno final newline',
        'no final newline',
        '\n\n\n',
        ' ',
        '---\ntitle: kept\n---\n# Frontmatter stays\n',
      ]
      for (const content of contents) {
        const response = await put(app, { source: 'Pi', path: 'note.md', content, expectedHash: hash })
        assert.equal(response.statusCode, 200, JSON.stringify(content))
        const bytes = await readFile(join(root, 'pi', 'note.md'))
        assert.deepEqual(bytes, Buffer.from(content, 'utf8'), JSON.stringify(content))
        assert.equal(response.json().hash, sha256(bytes))
        hash = response.json().hash
      }
    } finally { await app.close() }
  })
})

test('a stale expected hash returns 409 HASH_CONFLICT and leaves the disk bytes untouched', async () => {
  await withTempRoot(async root => {
    await writeFile(join(root, 'pi', 'note.md'), 'first')
    const app = createApp(root)
    try {
      const firstRead = (await app.inject('/api/file?source=Pi&path=note.md')).json()
      const secondRead = (await app.inject('/api/file?source=Pi&path=note.md')).json()
      assert.equal(firstRead.hash, secondRead.hash)
      const saved = await put(app, { source: 'Pi', path: 'note.md', content: 'second', expectedHash: firstRead.hash })
      assert.equal(saved.statusCode, 200)

      const stale = await put(app, { source: 'Pi', path: 'note.md', content: 'LOST UPDATE', expectedHash: secondRead.hash })
      assert.equal(stale.statusCode, 409)
      assert.equal(stale.json().code, 'HASH_CONFLICT')
      assert.equal(typeof stale.json().error, 'string')
      assert.ok(!stale.body.includes(root))
      assert.ok(!stale.body.includes('LOST UPDATE'))
      assert.equal(await readFile(join(root, 'pi', 'note.md'), 'utf8'), 'second')

      // An external change also invalidates the last acknowledged hash.
      await writeFile(join(root, 'pi', 'note.md'), 'external')
      const afterExternal = await put(app, { source: 'Pi', path: 'note.md', content: 'LOST UPDATE', expectedHash: saved.json().hash })
      assert.equal(afterExternal.statusCode, 409)
      assert.equal(afterExternal.json().code, 'HASH_CONFLICT')
      assert.equal(await readFile(join(root, 'pi', 'note.md'), 'utf8'), 'external')
      assert.deepEqual(await readdir(join(root, 'pi')), ['note.md'])
    } finally { await app.close() }
  })
})

test('two concurrent saves with the same hash: exactly one succeeds and the file holds the winner', async () => {
  await withTempRoot(async root => {
    await writeFile(join(root, 'pi', 'note.md'), 'base')
    const app = createApp(root)
    try {
      const hash = sha256('base')
      const [a, b] = await Promise.all([
        put(app, { source: 'Pi', path: 'note.md', content: 'writer A', expectedHash: hash }),
        put(app, { source: 'Pi', path: 'note.md', content: 'writer B', expectedHash: hash }),
      ])
      const statuses = [a.statusCode, b.statusCode].sort()
      assert.deepEqual(statuses, [200, 409])
      const winner = a.statusCode === 200 ? a : b
      const loser = a.statusCode === 200 ? b : a
      assert.equal(loser.json().code, 'HASH_CONFLICT')
      const bytes = await readFile(join(root, 'pi', 'note.md'), 'utf8')
      assert.equal(bytes, winner === a ? 'writer A' : 'writer B')
      assert.equal(winner.json().hash, sha256(bytes))
      assert.deepEqual(await readdir(join(root, 'pi')), ['note.md'])
    } finally { await app.close() }
  })
})

test('the replaced file keeps the original permission mode', async () => {
  await withTempRoot(async root => {
    const app = createApp(root)
    try {
      for (const mode of [0o600, 0o640, 0o664, 0o755]) {
        const name = `mode-${mode.toString(8)}.md`
        await writeFile(join(root, 'pi', name), 'before')
        await chmod(join(root, 'pi', name), mode)
        const response = await put(app, { source: 'Pi', path: name, content: 'after', expectedHash: sha256('before') })
        assert.equal(response.statusCode, 200)
        assert.equal((await stat(join(root, 'pi', name))).mode & 0o777, mode)
        assert.equal(await readFile(join(root, 'pi', name), 'utf8'), 'after')
      }
    } finally { await app.close() }
  })
})

/** Records every exclusive create performed through fs.open during a request. */
function trackTempCreates() {
  const open = fs.open
  const created: string[] = []
  const handles: Array<Awaited<ReturnType<typeof open>>> = []
  mock.method(fs, 'open', async (path: Parameters<typeof open>[0], flags?: Parameters<typeof open>[1], mode?: Parameters<typeof open>[2]) => {
    const handle = await open(path, flags, mode)
    handles.push(handle)
    if (typeof flags === 'number' && (flags & fs.constants.O_EXCL)) created.push(String(path))
    return handle
  })
  return { created, handles }
}

test('the temp file is created exclusively in the same directory, never ends in .md, and leaves no artifact on success', async () => {
  await withTempRoot(async root => {
    await mkdir(join(root, 'pi', 'skills'))
    await writeFile(join(root, 'pi', 'skills', 'review.md'), 'before')
    const app = createApp(root)
    try {
      await app.ready()
      const { created, handles } = trackTempCreates()
      const response = await put(app, { source: 'Pi', path: 'skills/review.md', content: 'after', expectedHash: sha256('before') })
      assert.equal(response.statusCode, 200)
      assert.equal(created.length, 1)
      const tempName = created[0].slice(created[0].lastIndexOf('/') + 1)
      assert.ok(created[0].startsWith('/proc/self/fd/'), created[0])
      assert.ok(!tempName.toLowerCase().endsWith('.md'), tempName)
      assert.notEqual(tempName, 'review.md')
      // Sibling temp name: the directory only contains the original afterwards.
      assert.deepEqual(await readdir(join(root, 'pi', 'skills')), ['review.md'])
      assert.equal(await readFile(join(root, 'pi', 'skills', 'review.md'), 'utf8'), 'after')
      for (const handle of handles) assert.equal(handle.fd, -1, 'all request descriptors closed')
    } finally { mock.restoreAll(); await app.close() }
  })
})

for (const stage of ['write', 'chmod', 'rename'] as const) {
  test(`a simulated ${stage} failure returns a safe 500, keeps the original bytes and removes the temp file`, async () => {
    await withTempRoot(async root => {
      await writeFile(join(root, 'pi', 'note.md'), 'original bytes')
      await chmod(join(root, 'pi', 'note.md'), 0o640)
      const app = createApp(root)
      const open = fs.open
      try {
        await app.ready()
        const failure = Object.assign(new Error(`EIO: private ${join(root, 'pi')} details`), { code: 'EIO' })
        let injected = false
        if (stage === 'rename') {
          mock.method(fs, 'rename', async () => { injected = true; throw failure })
        } else {
          mock.method(fs, 'open', async (path: Parameters<typeof open>[0], flags?: Parameters<typeof open>[1], mode?: Parameters<typeof open>[2]) => {
            const handle = await open(path, flags, mode)
            if (typeof flags === 'number' && (flags & fs.constants.O_EXCL)) {
              const method = stage === 'write' ? 'writeFile' : 'chmod'
              mock.method(handle, method, async () => { injected = true; throw failure })
            }
            return handle
          })
        }
        const response = await put(app, { source: 'Pi', path: 'note.md', content: 'new bytes', expectedHash: sha256('original bytes') })
        assert.ok(injected, 'failure was injected')
        assert.equal(response.statusCode, 500)
        assert.equal(response.json().code, 'WRITE_FAILED')
        assert.equal(typeof response.json().error, 'string')
        assert.ok(!response.body.includes(root))
        assert.ok(!response.body.includes('EIO'))
        assert.ok(!response.body.includes('new bytes'))
        assert.equal(await readFile(join(root, 'pi', 'note.md'), 'utf8'), 'original bytes')
        assert.equal((await stat(join(root, 'pi', 'note.md'))).mode & 0o777, 0o640)
        assert.deepEqual(await readdir(join(root, 'pi')), ['note.md'])
        // The file is still writable afterwards with the unchanged hash.
        mock.restoreAll()
        const retry = await put(app, { source: 'Pi', path: 'note.md', content: 'new bytes', expectedHash: sha256('original bytes') })
        assert.equal(retry.statusCode, 200)
      } finally { mock.restoreAll(); await app.close() }
    })
  })
}

test('an external change during staging is detected before replacement and returns 409 without overwriting it', async () => {
  await withTempRoot(async root => {
    await writeFile(join(root, 'pi', 'note.md'), 'original bytes')
    const app = createApp(root)
    const open = fs.open
    try {
      await app.ready()
      let changed = false
      mock.method(fs, 'open', async (path: Parameters<typeof open>[0], flags?: Parameters<typeof open>[1], mode?: Parameters<typeof open>[2]) => {
        const handle = await open(path, flags, mode)
        if (!changed && typeof flags === 'number' && (flags & fs.constants.O_EXCL)) {
          changed = true
          await writeFile(join(root, 'pi', 'note.md'), 'EXTERNAL WRITER')
        }
        return handle
      })
      const response = await put(app, { source: 'Pi', path: 'note.md', content: 'app writer', expectedHash: sha256('original bytes') })
      assert.ok(changed)
      assert.equal(response.statusCode, 409)
      assert.equal(response.json().code, 'HASH_CONFLICT')
      assert.equal(await readFile(join(root, 'pi', 'note.md'), 'utf8'), 'EXTERNAL WRITER')
      assert.deepEqual(await readdir(join(root, 'pi')), ['note.md'])
    } finally { mock.restoreAll(); await app.close() }
  })
})

test('invalid bodies are rejected with 400 and a stable code, without touching the disk', async () => {
  await withTempRoot(async root => {
    await writeFile(join(root, 'pi', 'note.md'), 'untouched')
    const app = createApp(root)
    try {
      const hash = sha256('untouched')
      const valid = { source: 'Pi', path: 'note.md', content: 'x', expectedHash: hash }
      const cases: Array<[string, unknown]> = [
        ['array', [valid]],
        ['string body', '"text"'],
        ['null', 'null'],
        ['missing source', { ...valid, source: undefined }],
        ['lowercase source', { ...valid, source: 'pi' }],
        ['unknown source', { ...valid, source: 'Nope' }],
        ['missing path', { ...valid, path: undefined }],
        ['empty path', { ...valid, path: '' }],
        ['numeric path', { ...valid, path: 1 }],
        ['missing content', { ...valid, content: undefined }],
        ['numeric content', { ...valid, content: 5 }],
        ['null content', { ...valid, content: null }],
        ['missing hash', { ...valid, expectedHash: undefined }],
        ['uppercase hash', { ...valid, expectedHash: hash.toUpperCase() }],
        ['short hash', { ...valid, expectedHash: hash.slice(1) }],
        ['long hash', { ...valid, expectedHash: `${hash}0` }],
        ['non-hex hash', { ...valid, expectedHash: `${hash.slice(1)}g` }],
        ['prefixed hash', { ...valid, expectedHash: `sha256:${hash}` }],
        ['traversal', { ...valid, path: '../secret.md' }],
        ['dot component', { ...valid, path: './note.md' }],
        ['absolute', { ...valid, path: '/note.md' }],
        ['backslash', { ...valid, path: 'skills\\note.md' }],
        ['NUL', { ...valid, path: 'note.md\0' }],
        ['drive', { ...valid, path: 'C:/note.md' }],
        ['UNC', { ...valid, path: '\\\\server\\share\\note.md' }],
        ['trailing slash', { ...valid, path: 'note.md/' }],
      ]
      for (const [label, payload] of cases) {
        const response = typeof payload === 'string'
          ? await app.inject({ method: 'PUT', url: '/api/file', payload, headers: { 'content-type': 'application/json' } })
          : await put(app, payload)
        assert.equal(response.statusCode, 400, label)
        assert.equal(typeof response.json().code, 'string', label)
        assert.equal(typeof response.json().error, 'string', label)
        assert.ok(!response.body.includes(root), label)
      }
      const malformed = await app.inject({ method: 'PUT', url: '/api/file', payload: '{"source": "Pi",', headers: { 'content-type': 'application/json' } })
      assert.equal(malformed.statusCode, 400)
      assert.equal(typeof malformed.json().code, 'string')
      const wrongType = await app.inject({ method: 'PUT', url: '/api/file', payload: 'source=Pi', headers: { 'content-type': 'text/plain' } })
      assert.ok(wrongType.statusCode === 400 || wrongType.statusCode === 415, String(wrongType.statusCode))
      assert.equal(typeof wrongType.json().code, 'string')
      assert.equal(await readFile(join(root, 'pi', 'note.md'), 'utf8'), 'untouched')
      assert.deepEqual(await readdir(join(root, 'pi')), ['note.md'])
    } finally { await app.close() }
  })
})

test('PUT never creates files and refuses directories, non-Markdown, non-regular and symlinked targets', async () => {
  await withTempRoot(async root => {
    await mkdir(join(root, 'outside'))
    await writeFile(join(root, 'outside', 'secret.md'), 'OUTSIDE SOURCE')
    await mkdir(join(root, 'pi', 'folder.md'))
    await mkdir(join(root, 'pi', 'skills'))
    await writeFile(join(root, 'pi', 'notes.txt'), 'not markdown')
    await writeFile(join(root, 'pi', 'real.md'), 'real')
    await symlink(join(root, 'outside', 'secret.md'), join(root, 'pi', 'linked-file.md'))
    await symlink(join(root, 'outside'), join(root, 'pi', 'linked-directory'))
    await rm(join(root, 'claude'), { recursive: true })
    await symlink(join(root, 'outside'), join(root, 'claude'))
    const socketPath = join(root, 'pi', 'socket.md')
    const socket = createServer()
    await new Promise<void>((resolve, reject) => socket.once('error', reject).listen(socketPath, resolve))
    const app = createApp(root)
    try {
      const cases: Array<[string, string, string]> = [
        ['Pi', 'missing.md', sha256('')],
        ['Pi', 'skills/missing.md', sha256('')],
        ['Pi', 'no-such-folder/missing.md', sha256('')],
        ['Pi', 'real.md/child.md', sha256('')],
        ['Pi', 'folder.md', sha256('')],
        ['Pi', 'skills', sha256('')],
        ['Pi', 'notes.txt', sha256('not markdown')],
        ['Pi', 'socket.md', sha256('')],
        ['Pi', 'linked-file.md', sha256('OUTSIDE SOURCE')],
        ['Pi', 'linked-directory/secret.md', sha256('OUTSIDE SOURCE')],
        ['Claude', 'secret.md', sha256('OUTSIDE SOURCE')],
      ]
      for (const [source, path, expectedHash] of cases) {
        const response = await put(app, { source, path, content: 'WRITTEN BY PUT', expectedHash })
        assert.equal(response.statusCode, 404, `${source}/${path}`)
        assert.equal(response.json().code, 'NOT_FOUND', `${source}/${path}`)
        assert.ok(!response.body.includes(root))
      }
      const piEntries = (await readdir(join(root, 'pi'))).sort()
      assert.deepEqual(piEntries, ['folder.md', 'linked-directory', 'linked-file.md', 'notes.txt', 'real.md', 'skills', 'socket.md'])
      assert.deepEqual(await readdir(join(root, 'pi', 'skills')), [])
      assert.equal(await readFile(join(root, 'pi', 'notes.txt'), 'utf8'), 'not markdown')
      assert.equal(await readFile(join(root, 'outside', 'secret.md'), 'utf8'), 'OUTSIDE SOURCE')
      assert.deepEqual(await readdir(join(root, 'outside')), ['secret.md'])
      assert.deepEqual(await readdir(join(root)), ['claude', 'outside', 'pi'])
    } finally {
      await app.close()
      await new Promise<void>(resolve => socket.close(() => resolve()))
    }
  })
})

test('JSON paths are literal: an encoded-looking filename is written as itself, and special characters work', async () => {
  await withTempRoot(async root => {
    await writeFile(join(root, 'pi', '%2e%2e.md'), 'literal')
    await mkdir(join(root, 'claude', 'a b'))
    await writeFile(join(root, 'claude', 'a b', 'c#d?e%f.md'), 'special')
    const app = createApp(root)
    try {
      const literal = await put(app, { source: 'Pi', path: '%2e%2e.md', content: 'still literal', expectedHash: sha256('literal') })
      assert.equal(literal.statusCode, 200)
      assert.equal(literal.json().path, '%2e%2e.md')
      assert.equal(await readFile(join(root, 'pi', '%2e%2e.md'), 'utf8'), 'still literal')
      assert.deepEqual(await readdir(join(root, 'pi')), ['%2e%2e.md'])

      const special = await put(app, { source: 'Claude', path: 'a b/c#d?e%f.md', content: 'special 2', expectedHash: sha256('special') })
      assert.equal(special.statusCode, 200)
      assert.equal(await readFile(join(root, 'claude', 'a b', 'c#d?e%f.md'), 'utf8'), 'special 2')
    } finally { await app.close() }
  })
})

test('documents over 100 KB save; bodies over the documented limit return 413 without changing the file', async () => {
  await withTempRoot(async root => {
    await writeFile(join(root, 'pi', 'large.md'), 'small')
    const app = createApp(root)
    try {
      const large = `# Large\n${'0123456789 '.repeat(20_000)}\n`
      assert.ok(Buffer.byteLength(large) > 200_000)
      const ok = await put(app, { source: 'Pi', path: 'large.md', content: large, expectedHash: sha256('small') })
      assert.equal(ok.statusCode, 200)
      assert.equal(await readFile(join(root, 'pi', 'large.md'), 'utf8'), large)

      const oversized = 'x'.repeat(9 * 1024 * 1024)
      const tooLarge = await put(app, { source: 'Pi', path: 'large.md', content: oversized, expectedHash: ok.json().hash })
      assert.equal(tooLarge.statusCode, 413)
      assert.equal(tooLarge.json().code, 'REQUEST_TOO_LARGE')
      assert.equal(typeof tooLarge.json().error, 'string')
      assert.equal(await readFile(join(root, 'pi', 'large.md'), 'utf8'), large)
      assert.deepEqual(await readdir(join(root, 'pi')), ['large.md'])
    } finally { await app.close() }
  })
})

test('the committed fixtures are never written by the API test suite', async () => {
  const app = createApp(defaultFixtureRoot)
  try {
    const before = await hashOnDisk(join(defaultFixtureRoot, 'pi', 'workflow.md'))
    const response = await put(app, { source: 'Pi', path: 'workflow.md', content: 'nope', expectedHash: sha256('not the real hash') })
    assert.equal(response.statusCode, 409)
    assert.equal(await hashOnDisk(join(defaultFixtureRoot, 'pi', 'workflow.md')), before)
  } finally { await app.close() }
})

for (const name of ['a'.repeat(231) + '.md', 'a'.repeat(252) + '.md', '文'.repeat(84) + '.md']) {
  test(`PUT supports a ${Buffer.byteLength(name)}-byte ${name.startsWith('文') ? 'UTF-8' : 'ASCII'} basename`, async () => {
    await withTempRoot(async root => {
      await writeFile(join(root, 'pi', name), 'before')
      const app = createApp(root)
      try {
        const response = await put(app, { source: 'Pi', path: name, content: 'after', expectedHash: sha256('before') })
        assert.equal(response.statusCode, 200, response.body)
        assert.equal(await readFile(join(root, 'pi', name), 'utf8'), 'after')
        assert.deepEqual(await readdir(join(root, 'pi')), [name])
      } finally { await app.close() }
    })
  })
}

for (const change of ['delete', 'symlink', 'io-error'] as const) {
  test(`final recheck after staging: ${change} is classified without overwriting`, async () => {
    await withTempRoot(async root => {
      const target = join(root, 'pi', 'note.md')
      await writeFile(target, 'before')
      await writeFile(join(root, 'claude', 'outside.md'), 'outside')
      const app = createApp(root)
      const open = fs.open
      let staged = false
      try {
        await app.ready()
        mock.method(fs, 'open', async (path: Parameters<typeof open>[0], flags?: Parameters<typeof open>[1], mode?: Parameters<typeof open>[2]) => {
          if (staged && String(path).endsWith('/note.md') && change === 'io-error') throw Object.assign(new Error('I/O'), { code: 'EIO' })
          const handle = await open(path, flags, mode)
          if (typeof flags === 'number' && (flags & fs.constants.O_EXCL)) {
            staged = true
            if (change !== 'io-error') await fs.unlink(target)
            if (change === 'symlink') await symlink(join(root, 'claude', 'outside.md'), target)
          }
          return handle
        })
        const response = await put(app, { source: 'Pi', path: 'note.md', content: 'app', expectedHash: sha256('before') })
        assert.ok(staged)
        assert.equal(response.statusCode, change === 'io-error' ? 500 : 409, response.body)
        assert.equal(response.json().code, change === 'io-error' ? 'WRITE_FAILED' : 'HASH_CONFLICT')
        assert.deepEqual(await readdir(join(root, 'pi')), change === 'delete' ? [] : ['note.md'])
        assert.equal(await readFile(join(root, 'claude', 'outside.md'), 'utf8'), 'outside')
        if (change === 'io-error') assert.equal(await readFile(target, 'utf8'), 'before')
        if (change === 'symlink') assert.ok((await fs.lstat(target)).isSymbolicLink())
      } finally { mock.restoreAll(); await app.close() }
    })
  })
}
