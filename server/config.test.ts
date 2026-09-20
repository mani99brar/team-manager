import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConfigError, defaultConfigPath, fixtureLocations, loadConfig, parseConfig, validateLocations, type LocationConfig } from './config.ts'

async function withTempDir(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'md-manager-config-test-'))
  try { await run(directory) } finally { await rm(directory, { recursive: true, force: true }) }
}

function config(locations: unknown[], version: unknown = 1): string {
  return JSON.stringify({ version, locations })
}

function location(overrides: Partial<LocationConfig> & { id: string }): LocationConfig {
  return { source: 'Pi', label: `Label ${overrides.id}`, path: `/srv/${overrides.id}`, category: 'personal', ...overrides }
}

test('fixture mode maps a root to two stable locations, Pi first, without touching the environment', () => {
  const locations = fixtureLocations('/tmp/fixtures/')
  assert.deepEqual(locations, [
    { id: 'pi-fixtures', source: 'Pi', label: 'Fixtures', path: '/tmp/fixtures/pi', category: 'personal' },
    { id: 'claude-fixtures', source: 'Claude', label: 'Fixtures', path: '/tmp/fixtures/claude', category: 'personal' },
  ])
  assert.equal(fixtureLocations('relative/root')[0].path, join(process.cwd(), 'relative/root/pi'))
})

test('the default config path lives under $HOME/.config/md-manager and follows the given environment only', () => {
  assert.equal(defaultConfigPath({ HOME: '/home/someone' }), '/home/someone/.config/md-manager/sources.json')
  assert.notEqual(defaultConfigPath({ HOME: '/home/other' }), defaultConfigPath({ HOME: '/home/someone' }))
})

test('parseConfig accepts a valid file and orders locations Pi first, then Claude, keeping configured order within a source', async () => {
  const text = config([
    location({ id: 'claude-b', source: 'Claude', path: '/srv/claude-b', category: 'plugin', label: 'Plugin: b' }),
    location({ id: 'pi-z', path: '/srv/pi/z', category: 'package', label: 'Package: z' }),
    location({ id: 'claude-a', source: 'Claude', path: '/srv/claude-a', label: 'Personal' }),
    location({ id: 'pi-a', path: '/srv/pi/a', category: 'project', label: 'Project: a' }),
  ])
  const locations = await parseConfig(text, 'test config')
  assert.deepEqual(locations.map(entry => entry.id), ['pi-z', 'pi-a', 'claude-b', 'claude-a'])
  assert.deepEqual(locations[0], { id: 'pi-z', source: 'Pi', label: 'Package: z', path: '/srv/pi/z', category: 'package' })
  // Parsing is deterministic: the same text yields the same order every time.
  assert.deepEqual(await parseConfig(text, 'test config'), locations)
  // Trailing separators are normalized so identity never depends on spelling.
  const normalized = await parseConfig(config([location({ id: 'x', path: '/srv/x/' })]), 'test config')
  assert.equal(normalized[0].path, '/srv/x')
})

test('malformed JSON, wrong shapes and unsupported versions fail with actionable ConfigErrors', async () => {
  const cases: Array<[string, string, RegExp]> = [
    ['not JSON', '{"version": 1,', /JSON/],
    ['array root', '[]', /object/],
    ['null root', 'null', /object/],
    ['missing version', JSON.stringify({ locations: [location({ id: 'a' })] }), /version/],
    ['wrong version', config([location({ id: 'a' })], 2), /version/],
    ['string version', config([location({ id: 'a' })], '1'), /version/],
    ['missing locations', JSON.stringify({ version: 1 }), /locations/],
    ['locations not array', JSON.stringify({ version: 1, locations: {} }), /locations/],
    ['empty locations', config([]), /at least one/i],
    ['location not object', config(['x']), /locations\[0\]/],
  ]
  for (const [label, text, pattern] of cases) {
    await assert.rejects(parseConfig(text, 'sources.json'), (error: unknown) => {
      assert.ok(error instanceof ConfigError, `${label}: ${String(error)}`)
      assert.match(error.message, pattern, label)
      assert.match(error.message, /sources\.json/, `${label} names the file`)
      return true
    }, label)
  }
})

test('every location field is validated: stable id syntax, known source, non-empty label, absolute path, known category', () => {
  const valid = location({ id: 'ok' })
  assert.deepEqual(validateLocations([valid]), [valid])
  const cases: Array<[string, unknown, RegExp]> = [
    ['missing id', { ...valid, id: undefined }, /id/],
    ['empty id', { ...valid, id: '' }, /id/],
    ['numeric id', { ...valid, id: 7 }, /id/],
    ['id with slash', { ...valid, id: 'a/b' }, /id/],
    ['id with space', { ...valid, id: 'a b' }, /id/],
    ['id with percent', { ...valid, id: 'a%b' }, /id/],
    ['id starting with dot', { ...valid, id: '.hidden' }, /id/],
    ['id starting with dash', { ...valid, id: '-x' }, /id/],
    ['overlong id', { ...valid, id: 'a'.repeat(65) }, /id/],
    ['missing source', { ...valid, source: undefined }, /source/],
    ['lowercase source', { ...valid, source: 'pi' }, /source/],
    ['unknown source', { ...valid, source: 'Nope' }, /source/],
    ['missing label', { ...valid, label: undefined }, /label/],
    ['blank label', { ...valid, label: '   ' }, /label/],
    ['numeric label', { ...valid, label: 1 }, /label/],
    ['missing path', { ...valid, path: undefined }, /path/],
    ['relative path', { ...valid, path: 'skills' }, /absolute/],
    ['tilde path', { ...valid, path: '~/skills' }, /absolute/],
    ['env path', { ...valid, path: '$HOME/skills' }, /absolute/],
    ['NUL path', { ...valid, path: '/srv/a\0b' }, /path/],
    ['root path', { ...valid, path: '/' }, /path/],
    ['missing category', { ...valid, category: undefined }, /category/],
    ['unknown category', { ...valid, category: 'system' }, /category/],
  ]
  for (const [label, entry, pattern] of cases) {
    assert.throws(() => validateLocations([entry]), (error: unknown) => {
      assert.ok(error instanceof ConfigError, label)
      assert.match(error.message, pattern, `${label}: ${(error as Error).message}`)
      return true
    }, label)
  }
  // Extra keys are ignored rather than rejected, so the file can carry comments-as-fields.
  assert.equal(validateLocations([{ ...valid, note: 'ignored' }])[0].id, 'ok')
})

test('duplicate ids and duplicate, nested or aliased roots are rejected, naming the conflicting ids', async () => {
  await withTempDir(async directory => {
    await mkdir(join(directory, 'real', 'child'), { recursive: true })
    await symlink(join(directory, 'real'), join(directory, 'alias'))
    const cases: Array<[string, LocationConfig[], RegExp]> = [
      ['duplicate id', [location({ id: 'same', path: '/srv/a' }), location({ id: 'same', path: '/srv/b', source: 'Claude' })], /same/],
      ['same path', [location({ id: 'one', path: '/srv/a' }), location({ id: 'two', path: '/srv/a', source: 'Claude' })], /one.*two|two.*one/],
      ['trailing slash alias', [location({ id: 'one', path: '/srv/a' }), location({ id: 'two', path: '/srv/a/' })], /one.*two|two.*one/],
      ['nested root', [location({ id: 'parent', path: '/srv/a' }), location({ id: 'child', path: '/srv/a/b/c' })], /parent.*child|child.*parent/],
      ['nested root reversed', [location({ id: 'child', path: '/srv/a/b' }), location({ id: 'parent', path: '/srv/a' })], /parent.*child|child.*parent/],
      ['symlink alias', [location({ id: 'real', path: join(directory, 'real') }), location({ id: 'alias', path: join(directory, 'alias') })], /real.*alias|alias.*real/],
      ['symlink alias child', [location({ id: 'real', path: join(directory, 'real') }), location({ id: 'alias', path: join(directory, 'alias', 'child') })], /real.*alias|alias.*real/],
    ]
    for (const [label, locations, pattern] of cases) {
      await assert.rejects(parseConfig(config(locations), 'sources.json'), (error: unknown) => {
        assert.ok(error instanceof ConfigError, label)
        assert.match(error.message, pattern, `${label}: ${(error as Error).message}`)
        return true
      }, label)
    }
    // Sibling paths with a shared prefix are not overlapping.
    const siblings = await parseConfig(config([location({ id: 'a', path: '/srv/skills' }), location({ id: 'b', path: '/srv/skills-extra' })]), 'sources.json')
    assert.equal(siblings.length, 2)
    // A missing root is a runtime availability problem, not a configuration error.
    const missing = await parseConfig(config([location({ id: 'gone', path: join(directory, 'does-not-exist') })]), 'sources.json')
    assert.equal(missing[0].id, 'gone')
  })
})

test('loadConfig: missing configuration fails startup with the path and the env vars, never falling back to fixtures', async () => {
  await withTempDir(async home => {
    await assert.rejects(loadConfig({ HOME: home }), (error: unknown) => {
      assert.ok(error instanceof ConfigError)
      assert.match(error.message, /sources\.json/)
      assert.match(error.message, /MD_MANAGER_CONFIG/)
      assert.match(error.message, /MD_MANAGER_FIXTURE_ROOT/)
      assert.doesNotMatch(error.message, /fixtures\/pi/)
      return true
    })
    await assert.rejects(loadConfig({ HOME: home, MD_MANAGER_CONFIG: join(home, 'nope.json') }), /nope\.json/)
    await writeFile(join(home, 'bad.json'), '{')
    await assert.rejects(loadConfig({ HOME: home, MD_MANAGER_CONFIG: join(home, 'bad.json') }), /bad\.json.*JSON|JSON.*bad\.json/)
  })
})

test('loadConfig: setting both MD_MANAGER_CONFIG and MD_MANAGER_FIXTURE_ROOT is an error; each alone selects its mode', async () => {
  await withTempDir(async home => {
    const file = join(home, 'sources.json')
    await writeFile(file, config([location({ id: 'pi-live', path: join(home, 'pi-live') })]))
    await assert.rejects(loadConfig({ HOME: home, MD_MANAGER_CONFIG: file, MD_MANAGER_FIXTURE_ROOT: join(home, 'fixtures') }), (error: unknown) => {
      assert.ok(error instanceof ConfigError)
      assert.match(error.message, /MD_MANAGER_CONFIG/)
      assert.match(error.message, /MD_MANAGER_FIXTURE_ROOT/)
      return true
    })
    const live = await loadConfig({ HOME: home, MD_MANAGER_CONFIG: file })
    assert.equal(live.mode, 'live')
    assert.equal(live.configPath, file)
    assert.deepEqual(live.locations.map(entry => entry.id), ['pi-live'])
    const fixture = await loadConfig({ HOME: home, MD_MANAGER_FIXTURE_ROOT: join(home, 'fixtures') })
    assert.equal(fixture.mode, 'fixture')
    assert.deepEqual(fixture.locations.map(entry => entry.id), ['pi-fixtures', 'claude-fixtures'])
    assert.equal(fixture.locations[0].path, join(home, 'fixtures', 'pi'))
    // Blank values count as unset.
    const blank = await loadConfig({ HOME: home, MD_MANAGER_CONFIG: file, MD_MANAGER_FIXTURE_ROOT: '   ' })
    assert.equal(blank.mode, 'live')
  })
})

test('loadConfig: the default path under HOME is used only when nothing explicit is set, so tests can isolate themselves', async () => {
  await withTempDir(async home => {
    await mkdir(join(home, '.config', 'md-manager'), { recursive: true })
    await writeFile(join(home, '.config', 'md-manager', 'sources.json'), config([location({ id: 'from-home', path: join(home, 'skills') })]))
    const fromHome = await loadConfig({ HOME: home })
    assert.equal(fromHome.mode, 'live')
    assert.deepEqual(fromHome.locations.map(entry => entry.id), ['from-home'])
    assert.equal(fromHome.configPath, join(home, '.config', 'md-manager', 'sources.json'))

    const explicit = join(home, 'explicit.json')
    await writeFile(explicit, config([location({ id: 'explicit', path: join(home, 'other') })]))
    const isolated = await loadConfig({ HOME: home, MD_MANAGER_CONFIG: explicit })
    assert.deepEqual(isolated.locations.map(entry => entry.id), ['explicit'])
    const fixture = await loadConfig({ HOME: home, MD_MANAGER_FIXTURE_ROOT: join(home, 'fixtures') })
    assert.ok(!fixture.locations.some(entry => entry.id === 'from-home'))
  })
})
