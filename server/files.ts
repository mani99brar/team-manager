import { createHash, randomBytes } from 'node:crypto'
import fs, { type FileHandle } from 'node:fs/promises'
import { constants } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import type { Source } from './config.ts'
import type { LocationRegistry } from './registry.ts'

export type { Source }

export function isSource(value: unknown): value is Source {
  return value === 'Pi' || value === 'Claude'
}

export function isMarkdownName(name: string): boolean {
  return name.toLowerCase().endsWith('.md')
}

export function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** A rejected request: `status` is the HTTP status, `code` is stable and machine-readable, `message` is safe to send. */
export class RequestError extends Error {
  readonly status: number
  readonly code: string
  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

export class PathError extends RequestError {
  constructor(status: 400 | 404, message: string, code = status === 400 ? 'INVALID_PATH' : 'NOT_FOUND') {
    super(status, code, message)
  }
}

const INVALID_PATH = 'The file path is invalid.'
export const NOT_FOUND = 'The file was not found or is not a Markdown file.'
export const HASH_CONFLICT_MESSAGE = 'This file changed on disk. Reload it or copy your draft.'
/** Version-control internals are never listed, read or changed, however a request addresses them. */
export const EXCLUDED_DIRECTORY = '.git'

/**
 * Splits a relative path into safe components. Rejects before any normalisation: `..` and `.` components,
 * empty components (leading, trailing or doubled separators), backslashes, NULs, absolute forms including
 * Windows drive letters and UNC prefixes, and any `.git` component.
 */
export function splitRelativePath(path: string): string[] {
  if (typeof path !== 'string' || path.length === 0) throw new PathError(400, INVALID_PATH)
  if (path.includes('\0') || path.includes('\\')) throw new PathError(400, INVALID_PATH)
  if (path.startsWith('/') || isAbsolute(path) || /^[A-Za-z]:/.test(path)) throw new PathError(400, INVALID_PATH)
  const components = path.split('/')
  for (const component of components) {
    if (component === '' || component === '.' || component === '..') throw new PathError(400, INVALID_PATH)
    if (component === EXCLUDED_DIRECTORY) throw new PathError(400, `Paths inside ${EXCLUDED_DIRECTORY} are not managed.`)
  }
  return components
}

/** Runs mutations one at a time so two app requests can never interleave their check-then-write steps. */
export class MutationQueue {
  private tail: Promise<unknown> = Promise.resolve()
  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task, task)
    this.tail = result.catch(() => undefined)
    return result
  }
}

export type ReadFile = (file: FileHandle) => Promise<Buffer>
/** The identity of a managed file: never a label, never an absolute path. */
export type Identity = { source: Source; locationId: string; path: string }
export type FileDocument = Identity & { content: string; hash: string }

export const DIRECTORY_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
const FILE_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
export const CREATE_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW

function filesystemError(error: unknown): never {
  const code = (error as NodeJS.ErrnoException)?.code
  if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'ELOOP') {
    throw new PathError(404, NOT_FOUND)
  }
  throw error
}

/** A descriptor-relative path: the parent is an already-open directory, the name is one validated component. */
export function at(parent: FileHandle, name?: string): string {
  const base = `/proc/self/fd/${parent.fd}`
  return name === undefined ? base : `${base}/${name}`
}

/** Validates a request path lexically and returns the safe components. Nothing on disk is touched. */
export function validateEntryPath(path: unknown, kind: 'file' | 'folder' | 'any'): string[] {
  if (typeof path !== 'string') throw new PathError(400, INVALID_PATH)
  const components = splitRelativePath(path)
  // Defence in depth: the validated components must resolve strictly below a root.
  if (!resolve('/root', ...components).startsWith('/root/')) throw new PathError(400, INVALID_PATH)
  const markdown = isMarkdownName(components[components.length - 1])
  if (kind === 'file' && !markdown) throw new PathError(400, 'The file name must end in .md.')
  if (kind === 'folder' && markdown) throw new PathError(400, 'A folder name must not end in .md.')
  return components
}

/** Read/write validation: a non-Markdown name is reported as an unavailable file, not a malformed path. */
export function validateMarkdownPath(path: unknown): string[] {
  const components = validateEntryPath(path, 'any')
  if (!isMarkdownName(components[components.length - 1])) throw new PathError(404, NOT_FOUND)
  return components
}

/**
 * Walks from an open location root to the directory containing the target, one no-follow open per component.
 * O_NOFOLLOW applies to ONE component at each step; the parent is an already-open directory.
 * Rename/symlink replacement can therefore only yield the pinned original or an unavailable target,
 * never re-resolve an earlier component. Keep all handles alive until the operation completes.
 */
export async function withParentDirectory<T>(
  root: FileHandle, components: string[],
  operation: (parent: FileHandle, name: string, track: (handle: FileHandle) => void) => Promise<T>,
): Promise<T> {
  const handles: FileHandle[] = []
  try {
    let parent = root
    for (const component of components.slice(0, -1)) {
      parent = await fs.open(at(parent, component), DIRECTORY_FLAGS)
      handles.push(parent)
    }
    return await operation(parent, components[components.length - 1], handle => handles.push(handle))
  } catch (error) { filesystemError(error) }
  finally { await Promise.all(handles.reverse().map(handle => handle.close())) }
}

/** Opens the final component no-follow and non-blocking and requires a regular file. */
export async function openRegularFile(parent: FileHandle, name: string): Promise<FileHandle> {
  // ENXIO here identifies an unopenable special target (e.g. a socket), not a read failure.
  // O_NONBLOCK lets us fstat/reject FIFOs without waiting for a writer.
  const file = await fs.open(at(parent, name), FILE_FLAGS).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENXIO') throw new PathError(404, NOT_FOUND)
    throw error
  })
  try {
    if (!(await file.stat()).isFile()) throw new PathError(404, NOT_FOUND)
  } catch (error) {
    await file.close()
    throw error
  }
  return file
}

/** Validates location and path, opens the root for this operation only, then runs on the validated descriptor. */
export async function withMarkdownFile<T>(
  registry: LocationRegistry, source: unknown, locationId: unknown, path: unknown,
  operation: (file: FileHandle, identity: Identity) => Promise<T>,
): Promise<T> {
  const location = registry.resolve(source, locationId)
  const components = validateMarkdownPath(path)
  return registry.withRoot(location, root => withParentDirectory(root, components, async (parent, name, track) => {
    const file = await openRegularFile(parent, name)
    track(file)
    return operation(file, { source: location.source, locationId: location.id, path: components.join('/') })
  }))
}

/** Reads from the validated descriptor once; content and SHA-256 use that same buffer. */
export async function readMarkdownFile(
  registry: LocationRegistry, source: unknown, locationId: unknown, path: unknown, readFile: ReadFile = file => file.readFile(),
): Promise<FileDocument> {
  return withMarkdownFile(registry, source, locationId, path, async (file, identity) => {
    const bytes = await readFile(file)
    return { ...identity, content: bytes.toString('utf8'), hash: sha256(bytes) }
  })
}

/** Bounded sibling staging name, independent of the target basename and never Markdown. */
export function temporaryFileName(): string {
  return `.md-manager-${randomBytes(16).toString('hex')}.tmp`
}

export type WriteResult = Identity & { hash: string }

/**
 * Hash-guarded atomic replacement, serialized with every other app mutation:
 * open the pinned original, compare its bytes to the expected hash, stage the new bytes in an exclusively
 * created sibling temp file carrying the original mode, re-verify the original's identity and bytes,
 * then rename the temp file over it. Any handled failure removes the temp file and leaves the original.
 * Residual limit: an external writer racing between the final re-check and the rename is not detected.
 */
export async function writeMarkdownFile(
  registry: LocationRegistry, source: unknown, locationId: unknown, path: unknown, content: string, expectedHash: string,
): Promise<WriteResult> {
  const location = registry.resolve(source, locationId)
  const components = validateMarkdownPath(path)
  return registry.mutations.run(() => registry.withRoot(location, root => withParentDirectory(root, components, async (parent, name, track) => {
    const original = await openRegularFile(parent, name)
    track(original)
    const stats = await original.stat()
    if (sha256(await original.readFile()) !== expectedHash) throw new RequestError(409, 'HASH_CONFLICT', HASH_CONFLICT_MESSAGE)

    const bytes = Buffer.from(content, 'utf8')
    const tempName = temporaryFileName()
    const temp = await fs.open(at(parent, tempName), CREATE_FLAGS, 0o600)
    try {
      await temp.chmod(stats.mode & 0o7777)
      await temp.writeFile(bytes)
      await temp.sync()
      await temp.close()
      // Staging took time: the same name must still be the same regular file with the expected bytes.
      const fresh = await openRegularFile(parent, name).catch(error => {
        const code = (error as NodeJS.ErrnoException)?.code
        if (error instanceof PathError || code === 'ENOENT' || code === 'ENOTDIR' || code === 'ELOOP') {
          throw new RequestError(409, 'HASH_CONFLICT', HASH_CONFLICT_MESSAGE)
        }
        throw error
      })
      track(fresh)
      const freshStats = await fresh.stat()
      const unchanged = freshStats.ino === stats.ino && freshStats.dev === stats.dev && sha256(await fresh.readFile()) === expectedHash
      if (!unchanged) throw new RequestError(409, 'HASH_CONFLICT', HASH_CONFLICT_MESSAGE)
      await fs.rename(at(parent, tempName), at(parent, name))
    } catch (error) {
      await temp.close().catch(() => undefined)
      await fs.unlink(at(parent, tempName)).catch(() => undefined)
      throw error
    }
    return { source: location.source, locationId: location.id, path: components.join('/'), hash: sha256(bytes) }
  })))
}
