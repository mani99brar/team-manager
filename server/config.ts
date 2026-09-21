import { readFile, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Startup configuration: which filesystem locations the app manages, grouped under the two agents.
 * Everything here is trusted administrator input read once at startup; requests can never add,
 * change or select a root. Automated tests pass explicit environments so a live config in HOME is
 * never discovered by accident.
 */
export type Source = 'Pi' | 'Claude'
export const SOURCES: readonly Source[] = ['Pi', 'Claude']
export type Category = 'personal' | 'package' | 'plugin' | 'project'
export const CATEGORIES: readonly Category[] = ['personal', 'package', 'plugin', 'project']

export type LocationConfig = {
  /** Stable, URL-safe identity; labels may change, ids must not. */
  id: string
  source: Source
  label: string
  /** Absolute directory, normalized (no trailing separator). */
  path: string
  category: Category
}

export type AppConfig = { mode: 'live' | 'fixture'; locations: LocationConfig[]; configPath?: string }

/** A configuration problem: the message is a local startup diagnostic and may name configured paths. */
export class ConfigError extends Error {}

export const CONFIG_ENV = 'MD_MANAGER_CONFIG'
export const FIXTURE_ENV = 'MD_MANAGER_FIXTURE_ROOT'
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const SUPPORTED_VERSION = 1

export function defaultConfigPath(env: NodeJS.ProcessEnv): string {
  const home = env.HOME?.trim() || homedir()
  return join(home, '.config', 'md-manager', 'sources.json')
}

/** The repository's fixtures/ folder, resolved from this module rather than the shell's working directory. */
export const defaultFixtureRoot = fileURLToPath(new URL('../fixtures/', import.meta.url))

/** Explicit fixture/demo mode: `<root>/pi` and `<root>/claude` become one location per source. */
export function fixtureLocations(root: string): LocationConfig[] {
  const base = resolve(root)
  return [
    { id: 'pi-fixtures', source: 'Pi', label: 'Fixtures', path: join(base, 'pi'), category: 'personal' },
    { id: 'claude-fixtures', source: 'Claude', label: 'Fixtures', path: join(base, 'claude'), category: 'personal' },
  ]
}

function isSource(value: unknown): value is Source {
  return value === 'Pi' || value === 'Claude'
}

function isCategory(value: unknown): value is Category {
  return typeof value === 'string' && (CATEGORIES as readonly string[]).includes(value)
}

/** Lexical validation of every location; nothing on disk is consulted. */
export function validateLocations(locations: unknown): LocationConfig[] {
  if (!Array.isArray(locations)) throw new ConfigError('"locations" must be an array of location objects.')
  if (locations.length === 0) throw new ConfigError('"locations" must contain at least one location.')
  const validated: LocationConfig[] = []
  const ids = new Map<string, number>()
  locations.forEach((entry, index) => {
    const where = `locations[${index}]`
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new ConfigError(`${where} must be an object with id, source, label, path and category.`)
    const record = entry as Record<string, unknown>
    const { id, source, label, path, category } = record
    if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
      throw new ConfigError(`${where}: "id" must be 1-64 characters of letters, digits, ".", "_" or "-", starting with a letter or digit (got ${JSON.stringify(id)}).`)
    }
    if (!isSource(source)) throw new ConfigError(`${where} (id "${id}"): "source" must be "Pi" or "Claude" (got ${JSON.stringify(source)}).`)
    if (typeof label !== 'string' || label.trim().length === 0) throw new ConfigError(`${where} (id "${id}"): "label" must be a non-empty string.`)
    if (typeof path !== 'string' || path.length === 0 || path.includes('\0')) throw new ConfigError(`${where} (id "${id}"): "path" must be a non-empty string without NUL characters.`)
    if (!isAbsolute(path) || path.startsWith('~')) throw new ConfigError(`${where} (id "${id}"): "path" must be absolute; "~", environment variables and relative paths are not expanded (got ${JSON.stringify(path)}).`)
    const normalized = resolve(path)
    if (normalized === sep) throw new ConfigError(`${where} (id "${id}"): "path" must not be the filesystem root.`)
    if (!isCategory(category)) throw new ConfigError(`${where} (id "${id}"): "category" must be one of ${CATEGORIES.join(', ')} (got ${JSON.stringify(category)}).`)
    const previous = ids.get(id)
    if (previous !== undefined) throw new ConfigError(`Duplicate location id "${id}" at locations[${previous}] and ${where}. Ids must be unique and stable.`)
    ids.set(id, index)
    validated.push({ id, source, label: label.trim(), path: normalized, category })
  })
  return validated
}

/** Resolves aliases where the path exists so two spellings of one directory are caught. */
async function canonical(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch {
    return path
  }
}

function contains(parent: string, child: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : `${parent}${sep}`)
}

/** Rejects identical, nested or aliased roots: every file must belong to exactly one location. */
export async function assertDisjointRoots(locations: readonly LocationConfig[]): Promise<void> {
  const canonicals = await Promise.all(locations.map(location => canonical(location.path)))
  for (let i = 0; i < locations.length; i += 1) {
    for (let j = i + 1; j < locations.length; j += 1) {
      const a = { ...locations[i], canonical: canonicals[i] }
      const b = { ...locations[j], canonical: canonicals[j] }
      if (contains(a.canonical, b.canonical) || contains(b.canonical, a.canonical)) {
        throw new ConfigError(`Locations "${a.id}" (${a.path}) and "${b.id}" (${b.path}) overlap: roots must be distinct directories, not the same directory, aliases of each other or nested.`)
      }
    }
  }
}

/** Pi first, then Claude; configured order is preserved within each source. */
export function orderLocations(locations: readonly LocationConfig[]): LocationConfig[] {
  return SOURCES.flatMap(source => locations.filter(location => location.source === source))
}

/** Parses and fully validates configuration text. `describe` names the file for diagnostics. */
export async function parseConfig(text: string, describe: string): Promise<LocationConfig[]> {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new ConfigError(`${describe} is not valid JSON: ${(error as Error).message}`)
  }
  try {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new ConfigError('the top level must be an object with "version" and "locations".')
    const record = parsed as Record<string, unknown>
    if (record.version !== SUPPORTED_VERSION) throw new ConfigError(`"version" must be the number ${SUPPORTED_VERSION} (got ${JSON.stringify(record.version)}).`)
    const locations = orderLocations(validateLocations(record.locations))
    await assertDisjointRoots(locations)
    return locations
  } catch (error) {
    if (error instanceof ConfigError) throw new ConfigError(`${describe}: ${error.message}`)
    throw error
  }
}

function setting(env: NodeJS.ProcessEnv, name: string): string | null {
  const value = env[name]?.trim()
  return value ? value : null
}

/**
 * Resolves the startup mode from an explicit environment object. Live mode reads MD_MANAGER_CONFIG or the
 * default file; fixture mode is only ever selected explicitly. Missing or invalid configuration fails
 * startup: there is no silent fallback to the repository fixtures.
 */
export async function loadConfig(env: NodeJS.ProcessEnv): Promise<AppConfig> {
  const configSetting = setting(env, CONFIG_ENV)
  const fixtureSetting = setting(env, FIXTURE_ENV)
  if (configSetting && fixtureSetting) {
    throw new ConfigError(`Set only one of ${CONFIG_ENV} (live locations) and ${FIXTURE_ENV} (fixture demo mode); both are set.`)
  }
  if (fixtureSetting) return { mode: 'fixture', locations: fixtureLocations(fixtureSetting) }
  const configPath = configSetting ? resolve(configSetting) : defaultConfigPath(env)
  let text: string
  try {
    text = await readFile(configPath, 'utf8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    const reason = code === 'ENOENT' ? 'does not exist' : `could not be read (${code ?? 'unknown error'})`
    throw new ConfigError(
      `Configuration file ${configPath} ${reason}. Create it from config/sources.example.json (see README "Live skills"), `
      + `point ${CONFIG_ENV} at another file, or set ${FIXTURE_ENV} for the fixture demo. The app never falls back to fixtures on its own.`,
    )
  }
  return { mode: 'live', configPath, locations: await parseConfig(text, configPath) }
}
