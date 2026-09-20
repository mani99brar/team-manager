import { createHash } from 'node:crypto'
import fs, { type FileHandle } from 'node:fs/promises'
import { constants } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'

export type Source = 'Pi' | 'Claude'

/** The only directories a request can ever address. A request source is mapped, never used as a directory name. */
const SOURCE_DIRECTORIES: Readonly<Record<Source, string>> = { Pi: 'pi', Claude: 'claude' }

export function isSource(value: unknown): value is Source {
  return value === 'Pi' || value === 'Claude'
}

export function isMarkdownName(name: string): boolean {
  return name.toLowerCase().endsWith('.md')
}

/** A rejected request. `status` is the HTTP status; `message` is safe to send to the client. */
export class PathError extends Error {
  readonly status: 400 | 404
  constructor(status: 400 | 404, message: string) {
    super(message)
    this.status = status
  }
}

const INVALID_PATH = 'The file path is invalid.'
const NOT_FOUND = 'The file was not found or is not a Markdown file.'

/**
 * Splits a relative path into safe components. Rejects before any normalisation: `..` and `.` components,
 * empty components (leading, trailing or doubled separators), backslashes, NULs and absolute forms,
 * including Windows drive letters and UNC prefixes.
 */
export function splitRelativePath(path: string): string[] {
  if (typeof path !== 'string' || path.length === 0) throw new PathError(400, INVALID_PATH)
  if (path.includes('\0') || path.includes('\\')) throw new PathError(400, INVALID_PATH)
  if (path.startsWith('/') || isAbsolute(path) || /^[A-Za-z]:/.test(path)) throw new PathError(400, INVALID_PATH)
  const components = path.split('/')
  for (const component of components) {
    if (component === '' || component === '.' || component === '..') throw new PathError(400, INVALID_PATH)
  }
  return components
}

export type FixtureRoot = { directory: string; handle: FileHandle }
export type ReadFile = (file: FileHandle) => Promise<Buffer>
export type FileDocument = { source: Source; path: string; content: string; hash: string }

const DIRECTORY_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
const FILE_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
const CAPABILITY_ERROR = 'Secure file reads require Linux with mounted procfs at /proc/self/fd.'

/** No pathname fallback: Node lacks openat, so descriptor-relative traversal requires Linux procfs. */
export async function openFixtureRoot(directory: string): Promise<FixtureRoot> {
  if (process.platform !== 'linux' || !constants.O_NOFOLLOW || !constants.O_DIRECTORY) {
    throw new Error(CAPABILITY_ERROR)
  }
  try {
    const stats = await fs.statfs('/proc/self/fd')
    if (stats.type !== 0x9fa0) throw new Error('Not procfs')
  } catch (cause) { throw new Error(CAPABILITY_ERROR, { cause }) }
  // The configured root and its ancestors are trusted startup configuration, not request input.
  // Pin it once; every source/descendant is subsequently opened relative to a retained descriptor.
  const handle = await fs.open(resolve(directory), DIRECTORY_FLAGS)
  try {
    const probe = await fs.open(`/proc/self/fd/${handle.fd}`, constants.O_RDONLY | constants.O_DIRECTORY)
    await probe.close()
  } catch (cause) {
    await handle.close()
    throw new Error(CAPABILITY_ERROR, { cause })
  }
  return { directory: resolve(directory), handle }
}

function filesystemError(error: unknown): never {
  const code = (error as NodeJS.ErrnoException)?.code
  if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'ELOOP') {
    throw new PathError(404, NOT_FOUND)
  }
  throw error
}

/**
 * Reusable path validator with a descriptor-scoped operation, never a checked pathname.
 * O_NOFOLLOW applies to ONE component at each step; the parent is an already-open directory.
 * Rename/symlink replacement can therefore only yield the pinned original or an unavailable target,
 * never re-resolve an earlier component. Keep all handles alive until the operation completes.
 */
export async function withMarkdownFile<T>(
  root: FixtureRoot, source: unknown, path: unknown,
  operation: (file: FileHandle, identity: { source: Source; path: string }) => Promise<T>,
): Promise<T> {
  if (!isSource(source)) throw new PathError(400, 'The source must be Pi or Claude.')
  if (typeof path !== 'string') throw new PathError(400, INVALID_PATH)
  const components = splitRelativePath(path)
  const sourceRoot = resolve(root.directory, SOURCE_DIRECTORIES[source])
  const inside = relative(sourceRoot, resolve(sourceRoot, ...components))
  if (!inside || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
    throw new PathError(400, INVALID_PATH)
  }
  if (!isMarkdownName(components[components.length - 1])) throw new PathError(404, NOT_FOUND)

  const handles: FileHandle[] = []
  try {
    let parent = root.handle
    for (const component of [SOURCE_DIRECTORIES[source], ...components.slice(0, -1)]) {
      parent = await fs.open(`/proc/self/fd/${parent.fd}/${component}`, DIRECTORY_FLAGS)
      handles.push(parent)
    }
    // ENXIO here identifies an unopenable special target (e.g. a socket), not a read failure.
    // O_NONBLOCK lets us fstat/reject FIFOs without waiting for a writer.
    const file = await fs.open(`/proc/self/fd/${parent.fd}/${components.at(-1)!}`, FILE_FLAGS).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENXIO') throw new PathError(404, NOT_FOUND)
      throw error
    })
    handles.push(file)
    if (!(await file.stat()).isFile()) throw new PathError(404, NOT_FOUND)
    return await operation(file, { source, path: components.join('/') })
  } catch (error) { filesystemError(error) }
  finally { await Promise.all(handles.reverse().map(handle => handle.close())) }
}

/** Reads from the validated descriptor once; content and SHA-256 use that same buffer. */
export async function readMarkdownFile(
  root: FixtureRoot, source: unknown, path: unknown, readFile: ReadFile = file => file.readFile(),
): Promise<FileDocument> {
  return withMarkdownFile(root, source, path, async (file, identity) => {
    const bytes = await readFile(file)
    return { ...identity, content: bytes.toString('utf8'), hash: createHash('sha256').update(bytes).digest('hex') }
  })
}
