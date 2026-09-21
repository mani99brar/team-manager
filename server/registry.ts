import fs, { type FileHandle } from 'node:fs/promises'
import { constants } from 'node:fs'
import { orderLocations, type Category, type LocationConfig, type Source } from './config.ts'
import { DIRECTORY_FLAGS, EXCLUDED_DIRECTORY, MutationQueue, PathError, RequestError, at, isMarkdownName, isSource } from './files.ts'

/**
 * The set of configured filesystem locations and the only way to reach one of their roots.
 *
 * Roots are trusted administrator configuration; requests select a location by id and are validated
 * lexically against the configured source. A root is opened no-follow for the duration of exactly one
 * operation (a listing, a read or a queued mutation), so a root that is deleted, replaced or turned into a
 * symlink afterwards can never redirect that operation: descriptor-relative steps continue on the pinned
 * original, and the next operation re-opens the configured path and reports it unavailable if it no longer
 * is a directory. No handle outlives the operation that opened it, so there is nothing to leak on shutdown.
 */
export const CAPABILITY_ERROR = 'Secure file reads require Linux with mounted procfs at /proc/self/fd.'
const PROC_SUPER_MAGIC = 0x9fa0

export type EntryKind = 'directory' | 'file'
export type Entry = { source: Source; locationId: string; path: string; kind: EntryKind }
export type LocationStatus = {
  id: string
  source: Source
  label: string
  category: Category
  status: 'available' | 'unavailable'
  /** A safe diagnostic without absolute paths, or null when available. */
  error: string | null
}
export type Listing = { locations: LocationStatus[]; entries: Entry[] }

/** The request named no configured location for its source. Nothing on disk was consulted. */
export class LocationError extends RequestError {
  constructor(message: string) { super(400, 'INVALID_LOCATION', message) }
}

/** The location is configured but its root cannot be used right now (missing, replaced by a symlink, unreadable). */
export class LocationUnavailableError extends RequestError {
  constructor(message: string) { super(404, 'LOCATION_UNAVAILABLE', message) }
}

/**
 * Maps a failed no-follow root open to a user-safe reason, or null when the failure is unexpected (reported as
 * 500). Linux reports a symlink opened with O_NOFOLLOW|O_DIRECTORY as ENOTDIR (or ELOOP), so those two are
 * told apart with an lstat of the configured path; the lstat result is only used for the diagnostic.
 */
export async function unavailableReason(path: string, error: unknown): Promise<string | null> {
  switch ((error as NodeJS.ErrnoException)?.code) {
    case 'ENOENT': return 'The configured folder does not exist.'
    case 'ENOTDIR':
    case 'ELOOP': {
      const symlink = await fs.lstat(path).then(stats => stats.isSymbolicLink(), () => false)
      return symlink ? 'The configured folder is a symbolic link; symlinked roots are never followed.' : 'The configured path is not a folder.'
    }
    case 'EACCES':
    case 'EPERM': return 'The configured folder is not readable (permission denied).'
    default: return null
  }
}

/** No pathname fallback: Node lacks openat, so descriptor-relative traversal requires Linux procfs. */
async function probeCapability(): Promise<void> {
  if (process.platform !== 'linux' || !constants.O_NOFOLLOW || !constants.O_DIRECTORY) throw new Error(CAPABILITY_ERROR)
  try {
    const stats = await fs.statfs('/proc/self/fd')
    if (stats.type !== PROC_SUPER_MAGIC) throw new Error('Not procfs')
  } catch (cause) { throw new Error(CAPABILITY_ERROR, { cause }) }
  // Prove that an open descriptor can be re-opened through its magic link before any root is touched.
  const handle = await fs.open('/proc/self/fd', constants.O_RDONLY | constants.O_DIRECTORY)
  try {
    const probe = await fs.open(at(handle), constants.O_RDONLY | constants.O_DIRECTORY)
    await probe.close()
  } catch (cause) {
    throw new Error(CAPABILITY_ERROR, { cause })
  } finally {
    await handle.close()
  }
}

// Byte-wise ordering keeps the listing deterministic regardless of locale.
function byName(a: { name: string }, b: { name: string }) {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
}

/**
 * Lists directories and regular Markdown files below an open directory, descending through no-follow
 * descriptors. Symlinks and `.git` directories are skipped; a directory that vanishes or becomes a symlink
 * between readdir and open is skipped too; an unreadable directory makes the whole location unavailable
 * rather than showing it as empty.
 */
async function walk(directory: FileHandle, location: LocationConfig, prefix: string, entries: Entry[]): Promise<void> {
  const dirents = (await fs.readdir(at(directory), { withFileTypes: true })).sort(byName)
  for (const dirent of dirents) {
    if (dirent.isSymbolicLink()) continue
    const path = prefix ? `${prefix}/${dirent.name}` : dirent.name
    if (dirent.isDirectory()) {
      if (dirent.name === EXCLUDED_DIRECTORY) continue
      let child: FileHandle
      try {
        child = await fs.open(at(directory, dirent.name), DIRECTORY_FLAGS)
      } catch (error) {
        const code = (error as NodeJS.ErrnoException)?.code
        if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'ELOOP') continue
        if (code === 'EACCES' || code === 'EPERM') throw new LocationUnavailableError(`The folder "${path}" is not readable (permission denied).`)
        throw error
      }
      try {
        entries.push({ source: location.source, locationId: location.id, path, kind: 'directory' })
        await walk(child, location, path, entries)
      } finally {
        await child.close()
      }
    } else if (dirent.isFile() && isMarkdownName(dirent.name)) {
      entries.push({ source: location.source, locationId: location.id, path, kind: 'file' })
    }
  }
}

export type RegistryOptions = {
  /** Receives unexpected (non-availability) listing failures for logging; messages may contain paths. */
  warn?: (error: unknown, location: LocationConfig) => void
}

export class LocationRegistry {
  readonly locations: readonly LocationConfig[]
  /** One serial queue for every mutation across all locations: check-then-write steps never interleave. */
  readonly mutations = new MutationQueue()
  private readonly byId = new Map<string, LocationConfig>()
  private readonly warn?: RegistryOptions['warn']
  private state: 'new' | 'open' | 'closed' = 'new'

  /** Pi first, then Claude, configured order within each source; ids must be unique (config.ts enforces both). */
  constructor(locations: readonly LocationConfig[], options: RegistryOptions = {}) {
    this.locations = orderLocations(locations)
    this.warn = options.warn
    for (const location of locations) {
      if (this.byId.has(location.id)) throw new Error(`Duplicate location id "${location.id}"`)
      this.byId.set(location.id, location)
    }
  }

  /** Verifies the platform capability once. Opens no configured root: availability is checked per operation. */
  async open(): Promise<void> {
    if (this.state === 'closed') throw new Error('The location registry is closed.')
    await probeCapability()
    this.state = 'open'
  }

  async close(): Promise<void> {
    this.state = 'closed'
  }

  /** Lexical lookup of a request's location. Unknown ids or a source mismatch are rejected before any disk access. */
  resolve(source: unknown, locationId: unknown): LocationConfig {
    if (!isSource(source)) throw new PathError(400, 'The source must be Pi or Claude.', 'INVALID_SOURCE')
    if (typeof locationId !== 'string' || locationId.length === 0) {
      throw new LocationError('A locationId naming a configured location is required.')
    }
    const location = this.byId.get(locationId)
    if (!location || location.source !== source) {
      throw new LocationError('That location is not configured for this source. Refresh the listing and choose a configured location.')
    }
    return location
  }

  /**
   * Opens the trusted configured root no-follow for one operation and closes it afterwards. The configured
   * path's ancestors are trusted startup configuration; the final component is never followed as a symlink.
   */
  async withRoot<T>(location: LocationConfig, operation: (root: FileHandle) => Promise<T>): Promise<T> {
    if (this.state !== 'open') throw new Error('The location registry is not open.')
    let root: FileHandle
    try {
      root = await fs.open(location.path, DIRECTORY_FLAGS)
    } catch (error) {
      const reason = await unavailableReason(location.path, error)
      if (reason) throw new LocationUnavailableError(`${reason} Refresh the listing to see which locations are available.`)
      throw error
    }
    try {
      return await operation(root)
    } finally {
      await root.close()
    }
  }

  /** Every location with its current availability, plus the entries of the available ones, in configured order. */
  async list(): Promise<Listing> {
    const locations: LocationStatus[] = []
    const entries: Entry[] = []
    for (const location of this.locations) {
      const found: Entry[] = []
      let error: string | null = null
      try {
        await this.withRoot(location, root => walk(root, location, '', found))
      } catch (cause) {
        if (cause instanceof LocationUnavailableError) {
          error = cause.message
        } else {
          error = (await unavailableReason(location.path, cause)) ?? 'The folder could not be listed. Check that it exists and is readable, then refresh.'
          this.warn?.(cause, location)
        }
      }
      locations.push({
        id: location.id, source: location.source, label: location.label, category: location.category,
        status: error === null ? 'available' : 'unavailable', error,
      })
      if (error === null) entries.push(...found)
    }
    return { locations, entries }
  }
}
