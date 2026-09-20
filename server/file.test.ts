import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs, { mkdtemp, mkdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { syncBuiltinESMExports } from 'node:module'
import { createApp, defaultFixtureRoot } from './app.ts'

function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

async function withTempRoot(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'md-manager-file-test-'))
  try {
    await mkdir(join(root, 'pi'))
    await mkdir(join(root, 'claude'))
    await run(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

/** Builds the query the same way the client must: URLSearchParams, never string concatenation. */
function fileUrl(params: Record<string, string> | Array<[string, string]>): string {
  return `/api/file?${new URLSearchParams(params).toString()}`
}

test('reads committed fixtures from both sources with exact content and a SHA-256 hash', async () => {
  const app = createApp(defaultFixtureRoot)
  try {
    const pi = await app.inject(fileUrl({ source: 'Pi', path: 'skills/review.md' }))
    assert.equal(pi.statusCode, 200)
    assert.equal(pi.headers['cache-control'], 'no-store')
    assert.match(String(pi.headers['content-type']), /application\/json/)
    const content = '# Sample review skill\n\nCheck the result against the acceptance criteria.\n'
    assert.deepEqual(pi.json(), { source: 'Pi', path: 'skills/review.md', content, hash: sha256(content) })

    // Duplicate filenames in different sources are distinct documents.
    const piWorkflow = (await app.inject(fileUrl({ source: 'Pi', path: 'workflow.md' }))).json()
    const claudeWorkflow = (await app.inject(fileUrl({ source: 'Claude', path: 'workflow.md' }))).json()
    assert.equal(piWorkflow.source, 'Pi')
    assert.equal(claudeWorkflow.source, 'Claude')
    assert.match(piWorkflow.content, /Sample Pi workflow/)
    assert.match(claudeWorkflow.content, /Sample Claude workflow/)
    assert.notEqual(piWorkflow.hash, claudeWorkflow.hash)

    const empty = await app.inject(fileUrl({ source: 'Claude', path: 'empty.md' }))
    assert.equal(empty.statusCode, 200)
    assert.deepEqual(empty.json(), { source: 'Claude', path: 'empty.md', content: '', hash: sha256('') })
    assert.equal(empty.json().hash, 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  } finally { await app.close() }
})

test('preserves whitespace, CRLF and Unicode; hashes the bytes of the same read; uppercase .MD is eligible', async () => {
  await withTempRoot(async root => {
    const crlf = '  \r\n# Title\r\n\r\n\tindented\r\n\r\n  trailing  \r\n\r\n'
    await mkdir(join(root, 'pi', 'nested', 'deeper'), { recursive: true })
    await writeFile(join(root, 'pi', 'nested', 'deeper', 'NOTE.MD'), crlf)
    const unicode = '# Ünïcödé — 日本語 🚀\n'
    await writeFile(join(root, 'claude', 'ünï 日本.md'), unicode)
    const app = createApp(root)
    try {
      const nested = await app.inject(fileUrl({ source: 'Pi', path: 'nested/deeper/NOTE.MD' }))
      assert.equal(nested.statusCode, 200)
      assert.equal(nested.json().content, crlf)
      assert.equal(nested.json().hash, sha256(Buffer.from(crlf, 'utf8')))

      const named = await app.inject(fileUrl({ source: 'Claude', path: 'ünï 日本.md' }))
      assert.equal(named.statusCode, 200)
      assert.deepEqual(named.json(), { source: 'Claude', path: 'ünï 日本.md', content: unicode, hash: sha256(Buffer.from(unicode, 'utf8')) })

      // Changing the bytes on disk changes the hash on the next read (no caching).
      await writeFile(join(root, 'pi', 'nested', 'deeper', 'NOTE.MD'), `${crlf}more`)
      const changed = await app.inject(fileUrl({ source: 'Pi', path: 'nested/deeper/NOTE.MD' }))
      assert.equal(changed.json().content, `${crlf}more`)
      assert.notEqual(changed.json().hash, nested.json().hash)
      assert.equal(changed.json().hash, sha256(`${crlf}more`))
    } finally { await app.close() }
  })
})

test('special characters in names: spaces, #, ?, literal % and an encoded-looking name', async () => {
  await withTempRoot(async root => {
    await mkdir(join(root, 'claude', 'a b'))
    await writeFile(join(root, 'claude', 'a b', 'c#d?e%f.md'), 'special\n')
    await writeFile(join(root, 'pi', '100%.md'), 'percent\n')
    await writeFile(join(root, 'pi', '%2e%2e.md'), 'literal percent name\n')
    const app = createApp(root)
    try {
      const special = await app.inject(fileUrl({ source: 'Claude', path: 'a b/c#d?e%f.md' }))
      assert.equal(special.statusCode, 200)
      assert.equal(special.json().path, 'a b/c#d?e%f.md')
      assert.equal(special.json().content, 'special\n')

      const percent = await app.inject(fileUrl({ source: 'Pi', path: '100%.md' }))
      assert.equal(percent.statusCode, 200)
      assert.equal(percent.json().content, 'percent\n')

      // The query is decoded exactly once: a name that looks encoded is a literal filename.
      const literal = await app.inject(fileUrl({ source: 'Pi', path: '%2e%2e.md' }))
      assert.equal(literal.statusCode, 200)
      assert.equal(literal.json().path, '%2e%2e.md')
      assert.equal(literal.json().content, 'literal percent name\n')
    } finally { await app.close() }
  })
})

test('rejects missing, invalid or duplicate parameters with 400', async () => {
  const app = createApp(defaultFixtureRoot)
  try {
    const cases: string[] = [
      '/api/file',
      '/api/file?source=Pi',
      '/api/file?path=workflow.md',
      fileUrl({ source: 'pi', path: 'workflow.md' }),
      fileUrl({ source: 'Nope', path: 'workflow.md' }),
      fileUrl({ source: '', path: 'workflow.md' }),
      fileUrl({ source: 'Pi', path: '' }),
      fileUrl([['source', 'Pi'], ['source', 'Claude'], ['path', 'workflow.md']]),
      fileUrl([['source', 'Pi'], ['path', 'workflow.md'], ['path', 'skills/review.md']]),
      '/api/file?source[]=Pi&path=workflow.md',
      '/api/file?source=Pi&path[a]=workflow.md',
    ]
    for (const url of cases) {
      const response = await app.inject(url)
      assert.equal(response.statusCode, 400, url)
      assert.equal(typeof response.json().error, 'string', url)
      assert.ok(!response.body.includes(defaultFixtureRoot), url)
    }
  } finally { await app.close() }
})

test('returns 404 for missing files, directories, non-Markdown files and non-regular targets', async () => {
  await withTempRoot(async root => {
    await mkdir(join(root, 'pi', 'folder.md'))
    await mkdir(join(root, 'pi', 'skills'))
    await writeFile(join(root, 'pi', 'notes.txt'), 'not markdown')
    await writeFile(join(root, 'pi', 'archive.md.bak'), 'not markdown')
    await writeFile(join(root, 'pi', 'real.md'), 'real')
    const socketPath = join(root, 'pi', 'socket.md')
    const socket = createServer()
    await new Promise<void>((resolve, reject) => socket.once('error', reject).listen(socketPath, resolve))
    const app = createApp(root)
    try {
      assert.equal((await app.inject(fileUrl({ source: 'Pi', path: 'real.md' }))).statusCode, 200)
      const cases: Array<[string, string]> = [
        ['Pi', 'missing.md'],
        ['Pi', 'skills/missing.md'],
        ['Pi', 'no-such-folder/missing.md'],
        ['Pi', 'real.md/child.md'],
        ['Pi', 'folder.md'],
        ['Pi', 'skills'],
        ['Pi', 'notes.txt'],
        ['Pi', 'archive.md.bak'],
        ['Pi', 'socket.md'],
        ['Claude', 'real.md'],
      ]
      for (const [source, path] of cases) {
        const response = await app.inject(fileUrl({ source, path }))
        assert.equal(response.statusCode, 404, `${source}/${path}`)
        assert.equal(typeof response.json().error, 'string')
        assert.ok(!response.body.includes(root), `${source}/${path}`)
        assert.ok(!response.body.includes('not markdown'))
      }
    } finally {
      await app.close()
      await new Promise<void>(resolve => socket.close(() => resolve()))
    }
  })
})

test('traversal, absolute, Windows/UNC, NUL, backslash and dot components are rejected with 400', async () => {
  await withTempRoot(async root => {
    await writeFile(join(root, 'secret.md'), 'OUTSIDE SOURCE')
    await writeFile(join(root, 'pi', 'real.md'), 'inside')
    await mkdir(join(root, 'pi', 'skills'))
    await writeFile(join(root, 'pi', 'skills', 'review.md'), 'review')
    const app = createApp(root)
    try {
      const rejected: string[] = [
        '../secret.md',
        '..',
        'skills/../../secret.md',
        'skills/../real.md',
        './real.md',
        'skills/./review.md',
        'skills//review.md',
        '/real.md',
        'skills/',
        `${root}/pi/real.md`,
        `${join(root, 'secret.md')}`,
        '\\real.md',
        'skills\\review.md',
        'C:\\real.md',
        'C:/real.md',
        'c:real.md',
        '\\\\server\\share\\real.md',
        '//server/share/real.md',
        'real.md\0',
        'skills/re\0view.md',
        '..\\secret.md',
      ]
      for (const path of rejected) {
        const response = await app.inject(fileUrl({ source: 'Pi', path }))
        assert.equal(response.statusCode, 400, JSON.stringify(path))
        assert.equal(typeof response.json().error, 'string')
        assert.ok(!response.body.includes(root), JSON.stringify(path))
        assert.ok(!response.body.includes('OUTSIDE SOURCE'))
      }
      // The source name can never be used as an arbitrary directory.
      const asDirectory = await app.inject(fileUrl({ source: '..', path: 'secret.md' }))
      assert.equal(asDirectory.statusCode, 400)
      assert.ok(!asDirectory.body.includes('OUTSIDE SOURCE'))
    } finally { await app.close() }
  })
})

test('encoded separators and traversal in the query are decoded once and validated', async () => {
  await withTempRoot(async root => {
    await writeFile(join(root, 'secret.md'), 'OUTSIDE SOURCE')
    await mkdir(join(root, 'pi', 'skills'))
    await writeFile(join(root, 'pi', 'skills', 'review.md'), 'review')
    const app = createApp(root)
    try {
      // A query-encoded slash between safe components is the normal way to address nested files.
      const nested = await app.inject('/api/file?source=Pi&path=skills%2Freview.md')
      assert.equal(nested.statusCode, 200)
      assert.equal(nested.json().content, 'review')

      const rejected = [
        '/api/file?source=Pi&path=..%2Fsecret.md',
        '/api/file?source=Pi&path=%2E%2E%2Fsecret.md',
        '/api/file?source=Pi&path=skills%2F..%2F..%2Fsecret.md',
        '/api/file?source=Pi&path=%2Fskills%2Freview.md',
        '/api/file?source=Pi&path=..%5Csecret.md',
        '/api/file?source=Pi&path=skills%2Freview.md%00',
        '/api/file?source=Pi&path=%2e%2e/secret.md',
      ]
      for (const url of rejected) {
        const response = await app.inject(url)
        assert.equal(response.statusCode, 400, url)
        assert.ok(!response.body.includes('OUTSIDE SOURCE'), url)
      }
      // Double-encoded traversal is not decoded twice: it names a literal (absent) file, never the parent.
      const doubleEncoded = await app.inject('/api/file?source=Pi&path=%252e%252e%252fsecret.md')
      assert.equal(doubleEncoded.statusCode, 404)
      assert.ok(!doubleEncoded.body.includes('OUTSIDE SOURCE'))
    } finally { await app.close() }
  })
})

test('symlinks at the source root, an intermediate directory or the target are rejected with 404', async () => {
  await withTempRoot(async root => {
    await mkdir(join(root, 'outside'))
    await writeFile(join(root, 'outside', 'secret.md'), 'OUTSIDE SOURCE')
    await writeFile(join(root, 'pi', 'inside.md'), 'inside')
    await symlink(join(root, 'outside', 'secret.md'), join(root, 'pi', 'linked-file.md'))
    await symlink(join(root, 'outside'), join(root, 'pi', 'linked-directory'))
    await symlink(join(root, 'pi'), join(root, 'pi', 'self'))
    // Replace the Claude source root with a symlink to an outside directory.
    await rm(join(root, 'claude'), { recursive: true })
    await symlink(join(root, 'outside'), join(root, 'claude'))
    const app = createApp(root)
    try {
      assert.equal((await app.inject(fileUrl({ source: 'Pi', path: 'inside.md' }))).statusCode, 200)
      const cases: Array<[string, string]> = [
        ['Pi', 'linked-file.md'],
        ['Pi', 'linked-directory/secret.md'],
        ['Pi', 'self/inside.md'],
        ['Claude', 'secret.md'],
      ]
      for (const [source, path] of cases) {
        const response = await app.inject(fileUrl({ source, path }))
        assert.equal(response.statusCode, 404, `${source}/${path}`)
        assert.ok(!response.body.includes('OUTSIDE SOURCE'), `${source}/${path}`)
        assert.ok(!response.body.includes(root), `${source}/${path}`)
      }
    } finally { await app.close() }
  })
})

test('an unexpected read failure returns a safe 500 without content or paths', async () => {
  await withTempRoot(async root => {
    await writeFile(join(root, 'pi', 'real.md'), 'real content')
    const app = createApp(root, {
      readFile: async () => { throw new Error(`EIO: i/o error, read ${join(root, 'pi', 'real.md')}`) },
    })
    try {
      const response = await app.inject(fileUrl({ source: 'Pi', path: 'real.md' }))
      assert.equal(response.statusCode, 500)
      assert.equal(typeof response.json().error, 'string')
      assert.ok(!response.body.includes(root))
      assert.ok(!response.body.includes('real content'))
      assert.ok(!response.body.includes('EIO'))
    } finally { await app.close() }
  })
})

test('the file endpoint does not affect the entries listing and ignores unrelated query parameters', async () => {
  const app = createApp(defaultFixtureRoot)
  try {
    const withExtras = await app.inject(fileUrl({ source: 'Pi', path: 'workflow.md', root: '/etc', extra: '1' }))
    assert.equal(withExtras.statusCode, 200)
    assert.equal(withExtras.json().path, 'workflow.md')
    assert.equal((await app.inject('/api/entries')).statusCode, 200)
    // Only GET is available.
    assert.notEqual((await app.inject({ method: 'PUT', url: fileUrl({ source: 'Pi', path: 'workflow.md' }) })).statusCode, 200)
  } finally { await app.close() }
})

for (const component of ['pi', 'pi/nested', 'pi/nested/real.md']) {
  test(`concurrent replacement of ${component} before reading cannot escape through a symlink`, async () => {
    await withTempRoot(async root => {
      await mkdir(join(root, 'pi/nested'))
      await mkdir(join(root, 'outside/nested'), { recursive: true })
      await writeFile(join(root, 'pi/nested/real.md'), 'INSIDE')
      await writeFile(join(root, 'outside/nested/real.md'), 'OUTSIDE SECRET')
      await writeFile(join(root, 'outside/real.md'), 'OUTSIDE SECRET')
      const target = join(root, component)
      const outside = join(root, component === 'pi' ? 'outside' : component.endsWith('.md') ? 'outside/real.md' : 'outside/nested')
      const app = createApp(root, {
        readFile: async file => {
          await rename(target, `${target}.original`)
          await symlink(outside, target)
          return file.readFile()
        },
      })
      try {
        const response = await app.inject(fileUrl({ source: 'Pi', path: 'nested/real.md' }))
        assert.ok(!response.body.includes('OUTSIDE SECRET'))
        assert.equal(response.statusCode, 200)
        assert.equal(response.json().content, 'INSIDE')
      } finally { await app.close() }
    })
  })
}

for (const code of ['ENOENT', 'EIO', 'EACCES', 'ENXIO']) {
  test(`read ${code} is classified safely`, async () => {
    const app = createApp(defaultFixtureRoot, {
      readFile: async () => { throw Object.assign(new Error('private path and content'), { code }) },
    })
    try {
      const response = await app.inject(fileUrl({ source: 'Pi', path: 'workflow.md' }))
      assert.equal(response.statusCode, code === 'ENOENT' ? 404 : 500)
      assert.ok(!response.body.includes('private'))
    } finally { await app.close() }
  })
}

test('metadata EIO is a safe 500, not missing', async () => {
  const fail = async () => { throw Object.assign(new Error('private metadata path'), { code: 'EIO' }) }
  const app = createApp(defaultFixtureRoot)
  try {
    await app.ready()
    mock.method(fs, 'lstat', fail)
    mock.method(fs, 'open', fail)
    syncBuiltinESMExports()
    const response = await app.inject(fileUrl({ source: 'Pi', path: 'workflow.md' }))
    assert.equal(response.statusCode, 500)
    assert.ok(!response.body.includes('private'))
  } finally {
    mock.restoreAll()
    syncBuiltinESMExports()
    await app.close()
  }
})

test('secure reads fail closed at startup when procfs capability is unavailable', async () => {
  mock.method(fs, 'statfs', async () => { throw Object.assign(new Error('no procfs'), { code: 'ENOENT' }) })
  syncBuiltinESMExports()
  const app = createApp(defaultFixtureRoot)
  try { await assert.rejects(async () => { await app.ready() }, /Linux.*procfs/) }
  finally { mock.restoreAll(); syncBuiltinESMExports(); await app.close() }
})

test('hash and content use exactly one descriptor read, including non-round-trippable bytes', async () => {
  const bytes = Buffer.from([0xef, 0xbb, 0xbf, 0x23, 0x0d, 0x0a, 0xff, 0x80])
  let reads = 0
  const app = createApp(defaultFixtureRoot, { readFile: async () => { reads++; return bytes } })
  try {
    const response = await app.inject(fileUrl({ source: 'Pi', path: 'workflow.md' }))
    assert.equal(response.statusCode, 200)
    assert.equal(reads, 1)
    assert.equal(response.json().content, bytes.toString('utf8'))
    assert.equal(response.json().hash, sha256(bytes))
    assert.notEqual(response.json().hash, sha256(bytes.toString('utf8')))
  } finally { await app.close() }
})

for (const timing of ['before', 'after'] as const) {
  for (const component of ['pi', 'nested', 'real.md']) {
    test(`${timing} opening ${component}, replacement cannot redirect the descriptor walk`, async () => {
      await withTempRoot(async root => {
        await mkdir(join(root, 'pi/nested'))
        await mkdir(join(root, 'outside/nested'), { recursive: true })
        await writeFile(join(root, 'pi/nested/real.md'), 'INSIDE')
        await writeFile(join(root, 'outside/nested/real.md'), 'OUTSIDE SECRET')
        await writeFile(join(root, 'outside/real.md'), 'OUTSIDE SECRET')
        const target = join(root, component === 'pi' ? 'pi' : `pi/nested${component === 'real.md' ? '/real.md' : ''}`)
        const outside = join(root, component === 'pi' ? 'outside' : component === 'nested' ? 'outside/nested' : 'outside/real.md')
        const app = createApp(root)
        const open = fs.open
        const handles: Awaited<ReturnType<typeof open>>[] = []
        try {
          await app.ready()
          let replaced = false
          const replace = async () => { await rename(target, `${target}.original`); await symlink(outside, target) }
          mock.method(fs, 'open', async (path: Parameters<typeof open>[0], flags: Parameters<typeof open>[1]) => {
            const swap = !replaced && String(path).endsWith(`/${component}`)
            if (swap) replaced = true
            if (swap && timing === 'before') await replace()
            const handle = await open(path, flags)
            handles.push(handle)
            if (swap && timing === 'after') await replace()
            return handle
          })
          const response = await app.inject(fileUrl({ source: 'Pi', path: 'nested/real.md' }))
          assert.ok(replaced)
          assert.ok(!response.body.includes('OUTSIDE SECRET'))
          assert.equal(response.statusCode, timing === 'before' ? 404 : 200)
          if (timing === 'after') assert.equal(response.json().content, 'INSIDE')
          for (const handle of handles) assert.equal(handle.fd, -1, 'all request descriptors closed')
        } finally { mock.restoreAll(); await app.close() }
      })
    })
  }
}

for (const code of ['ENOENT', 'EIO', 'EACCES']) {
  test(`fstat ${code} is classified safely and all descriptors close`, async () => {
    const app = createApp(defaultFixtureRoot)
    const open = fs.open
    const handles: Awaited<ReturnType<typeof open>>[] = []
    try {
      await app.ready()
      mock.method(fs, 'open', async (path: Parameters<typeof open>[0], flags: Parameters<typeof open>[1]) => {
        const handle = await open(path, flags)
        handles.push(handle)
        if (String(path).endsWith('/workflow.md')) mock.method(handle, 'stat', async () => {
          throw Object.assign(new Error('private metadata details'), { code })
        })
        return handle
      })
      const response = await app.inject(fileUrl({ source: 'Pi', path: 'workflow.md' }))
      assert.equal(response.statusCode, code === 'ENOENT' ? 404 : 500)
      assert.ok(!response.body.includes('private'))
      for (const handle of handles) assert.equal(handle.fd, -1)
    } finally { mock.restoreAll(); await app.close() }
  })
}

test('unsupported platform and non-procfs mounts fail closed', async () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  for (const unsupported of ['platform', 'filesystem']) {
    const app = createApp(defaultFixtureRoot)
    try {
      if (unsupported === 'platform') Object.defineProperty(process, 'platform', { value: 'darwin' })
      else mock.method(fs, 'statfs', async () => ({ type: 0 }))
      await assert.rejects(async () => { await app.ready() }, /Linux.*procfs/)
    } finally {
      Object.defineProperty(process, 'platform', platform)
      mock.restoreAll()
      await app.close()
    }
  }
})


test('unavailable descriptor access fails startup and closes the fixture-root handle', async () => {
  const open = fs.open
  const handles: Awaited<ReturnType<typeof open>>[] = []
  mock.method(fs, 'open', async (path: Parameters<typeof open>[0], flags: Parameters<typeof open>[1]) => {
    if (String(path).startsWith('/proc/self/fd/')) throw Object.assign(new Error('unavailable descriptor access'), { code: 'EACCES' })
    const handle = await open(path, flags)
    handles.push(handle)
    return handle
  })
  const app = createApp(defaultFixtureRoot)
  try {
    await assert.rejects(async () => { await app.ready() }, /Linux.*procfs/)
    assert.equal(handles.length, 1)
    assert.equal(handles[0].fd, -1)
  } finally { mock.restoreAll(); await app.close() }
})
