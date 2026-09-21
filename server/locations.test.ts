import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs, { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from './app.ts'
import type { LocationConfig } from './config.ts'
import { LocationRegistry } from './registry.ts'
import { performMutation } from './mutations.ts'

/**
 * Multi-location behaviour: several configured roots per source, none of them a `pi/`+`claude/` pair.
 * Every root is a fresh temporary directory; an `outside/` sentinel proves rejected operations touch nothing.
 */
function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

const PERSONAL = 'pi-personal'
const PACKAGE = 'pi-package'
const CLAUDE_PERSONAL = 'claude-personal'
const PLUGIN = 'claude-plugin'
const MISSING = 'pi-missing'

function locations(root: string, extra: LocationConfig[] = []): LocationConfig[] {
  return [
    { id: PERSONAL, source: 'Pi', label: 'Personal skills', path: join(root, 'pi-personal'), category: 'personal' },
    { id: PACKAGE, source: 'Pi', label: 'Package: demo', path: join(root, 'pi-package'), category: 'package' },
    { id: CLAUDE_PERSONAL, source: 'Claude', label: 'Personal and synced skills', path: join(root, 'claude-personal'), category: 'personal' },
    { id: PLUGIN, source: 'Claude', label: 'Plugin: design', path: join(root, 'claude-plugin'), category: 'plugin' },
    ...extra,
  ]
}

function missingLocation(root: string): LocationConfig {
  return { id: MISSING, source: 'Pi', label: 'Project: gone', path: join(root, 'pi-missing'), category: 'project' }
}

async function withRoots(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'md-manager-locations-test-'))
  try {
    await mkdir(join(root, 'pi-personal', 'review'), { recursive: true })
    await writeFile(join(root, 'pi-personal', 'review', 'SKILL.md'), 'personal review\n')
    await mkdir(join(root, 'pi-package', 'review'), { recursive: true })
    await writeFile(join(root, 'pi-package', 'review', 'SKILL.md'), 'package review\n')
    await mkdir(join(root, 'claude-personal', 'review'), { recursive: true })
    await writeFile(join(root, 'claude-personal', 'review', 'SKILL.md'), 'claude review\n')
    await mkdir(join(root, 'claude-plugin', 'ux-copy'), { recursive: true })
    await writeFile(join(root, 'claude-plugin', 'ux-copy', 'SKILL.md'), 'plugin copy\n')
    await mkdir(join(root, 'outside'))
    await writeFile(join(root, 'outside', 'secret.md'), 'OUTSIDE SENTINEL')
    await run(root)
  } finally {
    for (const name of await readdir(root).catch(() => [] as string[])) await chmod(join(root, name), 0o755).catch(() => undefined)
    await rm(root, { recursive: true, force: true })
  }
}

type App = ReturnType<typeof createApp>

function fileUrl(params: Record<string, string>): string {
  return `/api/file?${new URLSearchParams(params).toString()}`
}

function put(app: App, payload: unknown) {
  return app.inject({ method: 'PUT', url: '/api/file', payload: payload as never })
}

function mutate(app: App, payload: unknown) {
  return app.inject({ method: 'POST', url: '/api/mutate', payload: payload as never })
}

/** Every path under the temp root, including the sentinel, so a snapshot proves nothing changed anywhere. */
async function tree(root: string): Promise<string[]> {
  const out: string[] = []
  async function walk(directory: string, prefix: string) {
    const dirents = await readdir(directory, { withFileTypes: true }).catch(() => [])
    for (const entry of dirents.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name
      out.push(entry.isDirectory() ? `${path}/` : entry.isSymbolicLink() ? `${path}@` : `${path}:${entry.isFile() ? sha256(await readFile(join(directory, entry.name))).slice(0, 8) : '?'}`)
      if (entry.isDirectory()) await walk(join(directory, entry.name), path)
    }
  }
  await walk(root, '')
  return out
}

test('lists every configured location Pi-first in configured order with metadata, keeps identical relative paths distinct, and never exposes roots', async () => {
  await withRoots(async root => {
    const app = createApp(locations(root))
    try {
      const listing = await app.inject('/api/entries')
      assert.equal(listing.statusCode, 200)
      assert.deepEqual(listing.json().locations, [
        { id: PERSONAL, source: 'Pi', label: 'Personal skills', category: 'personal', status: 'available', error: null },
        { id: PACKAGE, source: 'Pi', label: 'Package: demo', category: 'package', status: 'available', error: null },
        { id: CLAUDE_PERSONAL, source: 'Claude', label: 'Personal and synced skills', category: 'personal', status: 'available', error: null },
        { id: PLUGIN, source: 'Claude', label: 'Plugin: design', category: 'plugin', status: 'available', error: null },
      ])
      assert.deepEqual(listing.json().entries, [
        { source: 'Pi', locationId: PERSONAL, path: 'review', kind: 'directory' },
        { source: 'Pi', locationId: PERSONAL, path: 'review/SKILL.md', kind: 'file' },
        { source: 'Pi', locationId: PACKAGE, path: 'review', kind: 'directory' },
        { source: 'Pi', locationId: PACKAGE, path: 'review/SKILL.md', kind: 'file' },
        { source: 'Claude', locationId: CLAUDE_PERSONAL, path: 'review', kind: 'directory' },
        { source: 'Claude', locationId: CLAUDE_PERSONAL, path: 'review/SKILL.md', kind: 'file' },
        { source: 'Claude', locationId: PLUGIN, path: 'ux-copy', kind: 'directory' },
        { source: 'Claude', locationId: PLUGIN, path: 'ux-copy/SKILL.md', kind: 'file' },
      ])
      assert.ok(!listing.body.includes(root), 'absolute roots never appear in responses')
      assert.ok(!listing.body.includes('outside'), 'the sentinel directory is not a location')

      // Same relative path, three different documents.
      const personal = await app.inject(fileUrl({ source: 'Pi', locationId: PERSONAL, path: 'review/SKILL.md' }))
      const pkg = await app.inject(fileUrl({ source: 'Pi', locationId: PACKAGE, path: 'review/SKILL.md' }))
      const claude = await app.inject(fileUrl({ source: 'Claude', locationId: CLAUDE_PERSONAL, path: 'review/SKILL.md' }))
      assert.deepEqual(personal.json(), { source: 'Pi', locationId: PERSONAL, path: 'review/SKILL.md', content: 'personal review\n', hash: sha256('personal review\n') })
      assert.deepEqual(pkg.json(), { source: 'Pi', locationId: PACKAGE, path: 'review/SKILL.md', content: 'package review\n', hash: sha256('package review\n') })
      assert.equal(claude.json().content, 'claude review\n')

      // Saving one of them changes exactly that file.
      const before = await tree(root)
      const saved = await put(app, { source: 'Pi', locationId: PACKAGE, path: 'review/SKILL.md', content: 'package edited\n', expectedHash: pkg.json().hash })
      assert.equal(saved.statusCode, 200, saved.body)
      assert.deepEqual(saved.json(), { source: 'Pi', locationId: PACKAGE, path: 'review/SKILL.md', hash: sha256('package edited\n') })
      assert.equal(await readFile(join(root, 'pi-package', 'review', 'SKILL.md'), 'utf8'), 'package edited\n')
      assert.equal(await readFile(join(root, 'pi-personal', 'review', 'SKILL.md'), 'utf8'), 'personal review\n')
      const after = await tree(root)
      assert.deepEqual(after.filter(entry => !entry.startsWith('pi-package/review/SKILL.md')), before.filter(entry => !entry.startsWith('pi-package/review/SKILL.md')))
    } finally { await app.close() }
  })
})

test('missing, unknown, empty or mismatched location ids are 400 INVALID_LOCATION on every route and touch nothing', async () => {
  await withRoots(async root => {
    const app = createApp(locations(root))
    const before = await tree(root)
    try {
      const reads = [
        fileUrl({ source: 'Pi', path: 'review/SKILL.md' }),
        fileUrl({ source: 'Pi', locationId: '', path: 'review/SKILL.md' }),
        fileUrl({ source: 'Pi', locationId: 'nope', path: 'review/SKILL.md' }),
        fileUrl({ source: 'Pi', locationId: CLAUDE_PERSONAL, path: 'review/SKILL.md' }),
        fileUrl({ source: 'Claude', locationId: PACKAGE, path: 'review/SKILL.md' }),
        fileUrl({ source: 'Pi', locationId: 'PI-PERSONAL', path: 'review/SKILL.md' }),
      ]
      for (const url of reads) {
        const response = await app.inject(url)
        assert.equal(response.statusCode, 400, url)
        assert.equal(response.json().code, 'INVALID_LOCATION', url)
        assert.ok(!response.body.includes(root), url)
      }
      const hash = sha256('personal review\n')
      const writes = [
        { source: 'Pi', path: 'review/SKILL.md', content: 'x', expectedHash: hash },
        { source: 'Pi', locationId: 'nope', path: 'review/SKILL.md', content: 'x', expectedHash: hash },
        { source: 'Pi', locationId: CLAUDE_PERSONAL, path: 'review/SKILL.md', content: 'x', expectedHash: hash },
        { source: 'Pi', locationId: 7, path: 'review/SKILL.md', content: 'x', expectedHash: hash },
      ]
      for (const payload of writes) {
        const response = await put(app, payload)
        assert.equal(response.statusCode, 400, JSON.stringify(payload))
        assert.equal(response.json().code, 'INVALID_LOCATION', JSON.stringify(payload))
      }
      const mutations: unknown[] = [
        { op: 'create-file', source: 'Pi', path: 'new.md' },
        { op: 'create-file', source: 'Pi', locationId: 'nope', path: 'new.md' },
        { op: 'create-folder', source: 'Pi', locationId: CLAUDE_PERSONAL, path: 'new' },
        { op: 'delete', source: 'Claude', locationId: PERSONAL, path: 'review/SKILL.md' },
        { op: 'rename', source: 'Pi', locationId: PERSONAL, path: 'review/SKILL.md', destinationLocationId: 'nope', destinationPath: 'review/RENAMED.md' },
        // Cross-location moves are refused lexically, even between two locations of the same source.
        { op: 'move', source: 'Pi', locationId: PERSONAL, path: 'review/SKILL.md', destinationLocationId: PACKAGE, destinationPath: 'review/MOVED.md' },
        { op: 'move', source: 'Pi', locationId: PERSONAL, path: 'review/SKILL.md', destinationSource: 'Pi', destinationLocationId: PACKAGE, destinationPath: 'moved.md' },
        // Copy must name a destination location that belongs to the other source.
        { op: 'copy', source: 'Pi', locationId: PERSONAL, path: 'review/SKILL.md', destinationSource: 'Claude', destinationPath: 'copied.md' },
        { op: 'copy', source: 'Pi', locationId: PERSONAL, path: 'review/SKILL.md', destinationSource: 'Claude', destinationLocationId: 'nope', destinationPath: 'copied.md' },
        { op: 'copy', source: 'Pi', locationId: PERSONAL, path: 'review/SKILL.md', destinationSource: 'Claude', destinationLocationId: PACKAGE, destinationPath: 'copied.md' },
        { op: 'copy', source: 'Pi', locationId: PERSONAL, path: 'review/SKILL.md', destinationSource: 'Claude', destinationLocationId: PERSONAL, destinationPath: 'copied.md' },
      ]
      for (const payload of mutations) {
        const response = await mutate(app, payload)
        assert.equal(response.statusCode, 400, JSON.stringify(payload))
        assert.equal(response.json().code, 'INVALID_LOCATION', `${JSON.stringify(payload)}: ${response.body}`)
        assert.ok(!response.body.includes(root))
      }
      assert.deepEqual(await tree(root), before)
    } finally { await app.close() }
  })
})

test('an unavailable location is 404 LOCATION_UNAVAILABLE for reads, saves and mutations; healthy locations work; restoring it recovers without restart', async () => {
  await withRoots(async root => {
    const app = createApp(locations(root, [missingLocation(root)]))
    const before = await tree(root)
    try {
      const listing = (await app.inject('/api/entries')).json()
      assert.deepEqual(listing.locations.map((location: { id: string; status: string }) => [location.id, location.status]), [
        [PERSONAL, 'available'], [PACKAGE, 'available'], [MISSING, 'unavailable'], [CLAUDE_PERSONAL, 'available'], [PLUGIN, 'available'],
      ])
      assert.match(listing.locations[2].error, /does not exist|not found|missing/i)
      assert.ok(!JSON.stringify(listing).includes(root))
      assert.ok(!listing.entries.some((entry: { locationId: string }) => entry.locationId === MISSING))

      const requests: Array<[string, () => Promise<{ statusCode: number; body: string; json: () => { code: string } }>]> = [
        ['read', () => app.inject(fileUrl({ source: 'Pi', locationId: MISSING, path: 'review/SKILL.md' }))],
        ['save', () => put(app, { source: 'Pi', locationId: MISSING, path: 'review/SKILL.md', content: 'x', expectedHash: sha256('') })],
        ['create-file', () => mutate(app, { op: 'create-file', source: 'Pi', locationId: MISSING, path: 'new.md' })],
        ['create-folder', () => mutate(app, { op: 'create-folder', source: 'Pi', locationId: MISSING, path: 'new' })],
        ['delete', () => mutate(app, { op: 'delete', source: 'Pi', locationId: MISSING, path: 'x.md' })],
        ['rename', () => mutate(app, { op: 'rename', source: 'Pi', locationId: MISSING, path: 'x.md', destinationPath: 'y.md' })],
        ['copy from', () => mutate(app, { op: 'copy', source: 'Pi', locationId: MISSING, path: 'x.md', destinationSource: 'Claude', destinationLocationId: PLUGIN, destinationPath: 'x.md' })],
        ['copy into', () => mutate(app, { op: 'copy', source: 'Claude', locationId: PLUGIN, path: 'ux-copy/SKILL.md', destinationSource: 'Pi', destinationLocationId: MISSING, destinationPath: 'x.md' })],
      ]
      for (const [label, send] of requests) {
        const response = await send()
        assert.equal(response.statusCode, 404, `${label}: ${response.body}`)
        assert.equal(response.json().code, 'LOCATION_UNAVAILABLE', label)
        assert.ok(!response.body.includes(root), label)
      }
      assert.deepEqual(await tree(root), before)
      // Healthy locations are unaffected.
      assert.equal((await app.inject(fileUrl({ source: 'Pi', locationId: PACKAGE, path: 'review/SKILL.md' }))).statusCode, 200)

      // Restore the root: the next request finds it, no restart or re-listing required first.
      await mkdir(join(root, 'pi-missing'))
      await writeFile(join(root, 'pi-missing', 'found.md'), 'found')
      assert.equal((await app.inject(fileUrl({ source: 'Pi', locationId: MISSING, path: 'found.md' }))).json().content, 'found')
      const created = await mutate(app, { op: 'create-file', source: 'Pi', locationId: MISSING, path: 'new.md', content: 'new' })
      assert.equal(created.statusCode, 201, created.body)
      const restored = (await app.inject('/api/entries')).json()
      assert.equal(restored.locations[2].status, 'available')
      assert.equal(restored.locations[2].error, null)
      assert.ok(restored.entries.some((entry: { locationId: string; path: string }) => entry.locationId === MISSING && entry.path === 'new.md'))

      // A root turned into a symlink is unavailable again and nothing behind the link is touched.
      await rm(join(root, 'pi-missing'), { recursive: true })
      await symlink(join(root, 'outside'), join(root, 'pi-missing'))
      const linked = (await app.inject('/api/entries')).json()
      assert.equal(linked.locations[2].status, 'unavailable')
      assert.match(linked.locations[2].error, /symbolic link/i)
      const throughLink = await mutate(app, { op: 'delete', source: 'Pi', locationId: MISSING, path: 'secret.md' })
      assert.equal(throughLink.statusCode, 404)
      assert.equal(throughLink.json().code, 'LOCATION_UNAVAILABLE')
      assert.equal((await app.inject(fileUrl({ source: 'Pi', locationId: MISSING, path: 'secret.md' }))).statusCode, 404)
      assert.equal(await readFile(join(root, 'outside', 'secret.md'), 'utf8'), 'OUTSIDE SENTINEL')

      if (process.getuid?.() !== 0) {
        await chmod(join(root, 'pi-package'), 0o000)
        const unreadable = await mutate(app, { op: 'create-file', source: 'Pi', locationId: PACKAGE, path: 'new.md' })
        assert.equal(unreadable.statusCode, 404, unreadable.body)
        assert.equal(unreadable.json().code, 'LOCATION_UNAVAILABLE')
        assert.match((await app.inject('/api/entries')).json().locations[1].error, /readable|permission/i)
        await chmod(join(root, 'pi-package'), 0o755)
        assert.equal((await mutate(app, { op: 'create-file', source: 'Pi', locationId: PACKAGE, path: 'new.md' })).statusCode, 201)
      }
    } finally { await app.close() }
  })
})

test('.git is excluded from listings and refused as a read or mutation target at any depth without touching disk', async () => {
  await withRoots(async root => {
    await mkdir(join(root, 'pi-personal', '.git', 'hooks'), { recursive: true })
    await writeFile(join(root, 'pi-personal', '.git', 'README.md'), 'git internals')
    await mkdir(join(root, 'pi-personal', 'review', '.git'))
    await writeFile(join(root, 'pi-personal', 'review', '.git', 'HEAD.md'), 'nested git')
    await mkdir(join(root, 'pi-personal', '.github'))
    await writeFile(join(root, 'pi-personal', '.github', 'notes.md'), 'other dot directories stay')
    const app = createApp(locations(root))
    const before = await tree(root)
    try {
      const listing = await app.inject('/api/entries')
      assert.deepEqual(listing.json().entries.filter((entry: { locationId: string }) => entry.locationId === PERSONAL), [
        { source: 'Pi', locationId: PERSONAL, path: '.github', kind: 'directory' },
        { source: 'Pi', locationId: PERSONAL, path: '.github/notes.md', kind: 'file' },
        { source: 'Pi', locationId: PERSONAL, path: 'review', kind: 'directory' },
        { source: 'Pi', locationId: PERSONAL, path: 'review/SKILL.md', kind: 'file' },
      ])
      assert.ok(!listing.json().entries.some((entry: { path: string }) => entry.path.split('/').includes('.git')))

      for (const path of ['.git/README.md', 'review/.git/HEAD.md', '.git', 'review/.git']) {
        const read = await app.inject(fileUrl({ source: 'Pi', locationId: PERSONAL, path }))
        assert.equal(read.statusCode, 400, path)
        assert.equal(read.json().code, 'INVALID_PATH', path)
        assert.ok(!read.body.includes('git internals'))
        const save = await put(app, { source: 'Pi', locationId: PERSONAL, path, content: 'x', expectedHash: sha256('git internals') })
        assert.equal(save.statusCode, 400, path)
      }
      const mutations: unknown[] = [
        { op: 'create-file', source: 'Pi', locationId: PERSONAL, path: '.git/new.md' },
        { op: 'create-folder', source: 'Pi', locationId: PERSONAL, path: '.git/refs' },
        { op: 'create-folder', source: 'Pi', locationId: PACKAGE, path: '.git' },
        { op: 'create-folder', source: 'Pi', locationId: PACKAGE, path: 'review/.git' },
        { op: 'delete', source: 'Pi', locationId: PERSONAL, path: '.git/README.md' },
        { op: 'delete', source: 'Pi', locationId: PERSONAL, path: 'review/.git' },
        { op: 'rename', source: 'Pi', locationId: PERSONAL, path: '.git/README.md', destinationPath: '.git/OTHER.md' },
        { op: 'move', source: 'Pi', locationId: PERSONAL, path: 'review/SKILL.md', destinationPath: '.git/SKILL.md' },
        { op: 'move', source: 'Pi', locationId: PERSONAL, path: 'review/SKILL.md', destinationPath: 'review/.git/SKILL.md' },
        { op: 'copy', source: 'Pi', locationId: PERSONAL, path: '.git/README.md', destinationSource: 'Claude', destinationLocationId: PLUGIN, destinationPath: 'copied.md' },
        { op: 'copy', source: 'Pi', locationId: PERSONAL, path: 'review/SKILL.md', destinationSource: 'Claude', destinationLocationId: PLUGIN, destinationPath: '.git/copied.md' },
      ]
      for (const payload of mutations) {
        const response = await mutate(app, payload)
        assert.equal(response.statusCode, 400, `${JSON.stringify(payload)}: ${response.body}`)
        assert.equal(response.json().code, 'INVALID_PATH', JSON.stringify(payload))
      }
      assert.deepEqual(await tree(root), before)
    } finally { await app.close() }
  })
})

test('copy lands in the chosen destination location under the other source and reports both locations', async () => {
  await withRoots(async root => {
    const app = createApp(locations(root))
    try {
      const toPlugin = await mutate(app, { op: 'copy', source: 'Pi', locationId: PACKAGE, path: 'review/SKILL.md', destinationSource: 'Claude', destinationLocationId: PLUGIN, destinationPath: 'ux-copy/review.md' })
      assert.equal(toPlugin.statusCode, 201, toPlugin.body)
      assert.deepEqual(toPlugin.json(), { op: 'copy', source: 'Pi', locationId: PACKAGE, path: 'review/SKILL.md', destinationSource: 'Claude', destinationLocationId: PLUGIN, destinationPath: 'ux-copy/review.md' })
      assert.equal(await readFile(join(root, 'claude-plugin', 'ux-copy', 'review.md'), 'utf8'), 'package review\n')
      assert.deepEqual(await readdir(join(root, 'claude-personal')), ['review'])

      const toPersonal = await mutate(app, { op: 'copy', source: 'Claude', locationId: CLAUDE_PERSONAL, path: 'review/SKILL.md', destinationSource: 'Pi', destinationLocationId: PERSONAL, destinationPath: 'review/from-claude.md' })
      assert.equal(toPersonal.statusCode, 201, toPersonal.body)
      assert.equal(await readFile(join(root, 'pi-personal', 'review', 'from-claude.md'), 'utf8'), 'claude review\n')
      assert.deepEqual(await readdir(join(root, 'pi-package', 'review')), ['SKILL.md'])

      // The destination is the same identity next time: a repeat collides there and only there.
      const again = await mutate(app, { op: 'copy', source: 'Pi', locationId: PACKAGE, path: 'review/SKILL.md', destinationSource: 'Claude', destinationLocationId: PLUGIN, destinationPath: 'ux-copy/review.md' })
      assert.equal(again.statusCode, 409)
      assert.equal(again.json().code, 'DESTINATION_EXISTS')
      const elsewhere = await mutate(app, { op: 'copy', source: 'Pi', locationId: PACKAGE, path: 'review/SKILL.md', destinationSource: 'Claude', destinationLocationId: CLAUDE_PERSONAL, destinationPath: 'review/review.md' })
      assert.equal(elsewhere.statusCode, 201)

      // Rename and move report the (unchanged) destination location.
      const moved = await mutate(app, { op: 'move', source: 'Pi', locationId: PERSONAL, path: 'review/from-claude.md', destinationLocationId: PERSONAL, destinationPath: 'from-claude.md' })
      assert.equal(moved.statusCode, 200, moved.body)
      assert.deepEqual(moved.json(), { op: 'move', source: 'Pi', locationId: PERSONAL, path: 'review/from-claude.md', destinationSource: 'Pi', destinationLocationId: PERSONAL, destinationPath: 'from-claude.md' })
    } finally { await app.close() }
  })
})

test('a root replaced by another directory or a symlink during a read never redirects the in-flight read', async () => {
  for (const replacement of ['directory', 'symlink'] as const) {
    await withRoots(async root => {
      const target = join(root, 'pi-personal')
      await mkdir(join(root, 'replacement', 'review'), { recursive: true })
      await writeFile(join(root, 'replacement', 'review', 'SKILL.md'), 'REPLACEMENT')
      await mkdir(join(root, 'outside', 'review'))
      await writeFile(join(root, 'outside', 'review', 'SKILL.md'), 'OUTSIDE SENTINEL')
      let replaced = false
      const app = createApp(locations(root), {
        readFile: async file => {
          await rename(target, `${target}.original`)
          if (replacement === 'directory') await rename(join(root, 'replacement'), target)
          else await symlink(join(root, 'outside'), target)
          replaced = true
          return file.readFile()
        },
      })
      try {
        const response = await app.inject(fileUrl({ source: 'Pi', locationId: PERSONAL, path: 'review/SKILL.md' }))
        assert.ok(replaced)
        assert.equal(response.statusCode, 200, response.body)
        assert.equal(response.json().content, 'personal review\n')
        assert.ok(!response.body.includes('OUTSIDE SENTINEL') && !response.body.includes('REPLACEMENT'))
        if (replacement === 'symlink') {
          const next = await app.inject(fileUrl({ source: 'Pi', locationId: PERSONAL, path: 'review/SKILL.md' }))
          assert.equal(next.statusCode, 404)
          assert.equal(next.json().code, 'LOCATION_UNAVAILABLE')
          assert.ok((await lstat(target)).isSymbolicLink())
        }
      } finally { await app.close() }
    })
  }
})

test('every descriptor opened for listing, reads and mutations is closed afterwards; a closed registry refuses work', async () => {
  await withRoots(async root => {
    const app = createApp(locations(root, [missingLocation(root)]))
    const open = fs.open
    const handles: Array<Awaited<ReturnType<typeof open>>> = []
    try {
      await app.ready()
      mock.method(fs, 'open', async (path: Parameters<typeof open>[0], flags?: Parameters<typeof open>[1], mode?: Parameters<typeof open>[2]) => {
        const handle = await open(path, flags, mode)
        handles.push(handle)
        return handle
      })
      assert.equal((await app.inject('/api/entries')).statusCode, 200)
      assert.equal((await app.inject(fileUrl({ source: 'Claude', locationId: PLUGIN, path: 'ux-copy/SKILL.md' }))).statusCode, 200)
      assert.equal((await app.inject(fileUrl({ source: 'Claude', locationId: PLUGIN, path: 'ux-copy/missing.md' }))).statusCode, 404)
      assert.equal((await put(app, { source: 'Pi', locationId: PERSONAL, path: 'review/SKILL.md', content: 'edited', expectedHash: sha256('personal review\n') })).statusCode, 200)
      assert.equal((await mutate(app, { op: 'copy', source: 'Pi', locationId: PERSONAL, path: 'review/SKILL.md', destinationSource: 'Claude', destinationLocationId: PLUGIN, destinationPath: 'copied.md' })).statusCode, 201)
      assert.equal((await mutate(app, { op: 'create-file', source: 'Pi', locationId: MISSING, path: 'x.md' })).statusCode, 404)
      assert.ok(handles.length >= 8, `expected root and descendant descriptors, saw ${handles.length}`)
      for (const handle of handles) assert.equal(handle.fd, -1, 'every request descriptor is closed')
    } finally { mock.restoreAll(); await app.close() }

    const registry = new LocationRegistry(locations(root))
    await registry.open()
    await registry.close()
    await assert.rejects(performMutation(registry, { op: 'create-file', source: 'Pi', locationId: PERSONAL, path: 'after-close.md', content: '' }))
    assert.deepEqual((await readdir(join(root, 'pi-personal'))).sort(), ['review'])
  })
})

test('a failed capability probe closes what it opened and never opens a configured root', async () => {
  await withRoots(async root => {
    const open = fs.open
    const opened: string[] = []
    const handles: Array<Awaited<ReturnType<typeof open>>> = []
    mock.method(fs, 'open', async (path: Parameters<typeof open>[0], flags?: Parameters<typeof open>[1], mode?: Parameters<typeof open>[2]) => {
      opened.push(String(path))
      if (String(path).startsWith('/proc/self/fd/')) throw Object.assign(new Error('unavailable descriptor access'), { code: 'EACCES' })
      const handle = await open(path, flags, mode)
      handles.push(handle)
      return handle
    })
    const registry = new LocationRegistry(locations(root))
    try {
      await assert.rejects(registry.open(), /Linux.*procfs/)
      assert.ok(!opened.some(path => path.startsWith(root)), 'no configured root was opened')
      for (const handle of handles) assert.equal(handle.fd, -1)
    } finally { mock.restoreAll(); await registry.close() }
  })
})
