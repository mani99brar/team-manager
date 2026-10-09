/**
 * The review diff, inline (docs/PRD_VIEWER_REFINE.md 5.6, S7 of PRD_VIEWER_UX 4.7). Two parts, both pure of the DOM:
 *
 * - `parseDiff`: a unified-diff parser. It reads a `git diff` patch into files, each with its added/removed counts and its
 *   hunks (old/new line numbers and a tone per line: add, remove or context). A `GIT binary patch` section is kept as a file
 *   with no hunks and `binary: true` (a stat, never rendered line by line). It never throws: text it does not recognise is
 *   ignored, so a malformed patch renders as whatever files it did recognise.
 * - `fetchDiffText`: the bounded read of a diff artifact. It streams `paths.artifact` and cancels the body at
 *   `DIFF_BYTE_LIMIT` (1 MB), so an oversized patch is never fully downloaded; past the limit the caller shows
 *   "over 1 MB, not read" with a show button. `api.ts` is untouched.
 *
 * A file whose diff is longer than `MAX_DIFF_LINES` is shown as a stat with a show button rather than every line (5.6).
 */
import { paths, ProjectsApiError, type RunScope } from './api.ts'

/** Past this many diff lines (added + removed + context) a file is a stat with a show button, not rendered line by line. */
export const MAX_DIFF_LINES = 2000
/** The inline diff reads at most this many bytes of a patch artifact; beyond it the viewer says "over 1 MB, not read". */
export const DIFF_BYTE_LIMIT = 1024 * 1024

export type DiffLineKind = 'add' | 'remove' | 'context'
export type DiffLine = { kind: DiffLineKind; text: string; oldLine: number | null; newLine: number | null }
export type DiffHunk = { header: string; oldStart: number; newStart: number; lines: DiffLine[] }
export type DiffFile = {
  /** The new path (`b/…`), or the old path for a deletion. */
  path: string
  oldPath: string
  /** A rename or copy moved the file. */
  renamedFrom: string | null
  added: number
  removed: number
  binary: boolean
  hunks: DiffHunk[]
  /** Added + removed + context lines; the renderer shows a file over `MAX_DIFF_LINES` as a stat with a show button. */
  lineCount: number
}

const stripPrefix = (path: string) => path.replace(/^[ab]\//, '').replace(/^"(.*)"$/, '$1')

/** The `@@ -a,b +c,d @@` hunk header's old and new starting line numbers. */
function parseHunkHeader(line: string): { oldStart: number; newStart: number } | null {
  const match = /^@@+ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
  return match ? { oldStart: Number(match[1]), newStart: Number(match[2]) } : null
}

/**
 * Parses a unified `git diff` into files and hunks. Each file starts at a `diff --git` line (or, for a bare patch, at the
 * first `---`/`+++` pair). Within a hunk, `+`/`-`/space classify the line and carry its old and new line numbers; `\ No
 * newline at end of file` and metadata lines (index, mode, similarity) are ignored.
 */
export function parseDiff(text: string): DiffFile[] {
  const files: DiffFile[] = []
  let file: DiffFile | null = null
  let hunk: DiffHunk | null = null
  let oldLine = 0
  let newLine = 0
  const start = (oldPath: string, newPath: string): DiffFile => {
    const next: DiffFile = { path: newPath, oldPath, renamedFrom: null, added: 0, removed: 0, binary: false, hunks: [], lineCount: 0 }
    hunk = null
    files.push(next)
    return next
  }
  for (const raw of text.split('\n')) {
    const gitHeader = /^diff --git (.+) (.+)$/.exec(raw)
    if (gitHeader) {
      file = start(stripPrefix(gitHeader[1]), stripPrefix(gitHeader[2]))
      continue
    }
    if (raw.startsWith('rename from ') && file) file.renamedFrom = raw.slice('rename from '.length)
    else if (raw.startsWith('copy from ') && file) file.renamedFrom = raw.slice('copy from '.length)
    else if (raw.startsWith('--- ') && raw !== '--- ') {
      const path = stripPrefix(raw.slice(4))
      if (!file) file = start(path, path)
      else if (path !== '/dev/null') file.oldPath = path
    } else if (raw.startsWith('+++ ')) {
      const path = stripPrefix(raw.slice(4))
      if (file && path !== '/dev/null') file.path = path
    } else if (/^(GIT binary patch|Binary files )/.test(raw)) {
      if (file) file.binary = true
      hunk = null
    } else if (raw.startsWith('@@')) {
      const header = parseHunkHeader(raw)
      if (header && file) {
        oldLine = header.oldStart
        newLine = header.newStart
        hunk = { header: raw, oldStart: header.oldStart, newStart: header.newStart, lines: [] }
        file.hunks.push(hunk)
      }
    } else if (hunk && file && (raw.startsWith('+') || raw.startsWith('-') || raw.startsWith(' '))) {
      const body = raw.slice(1)
      if (raw.startsWith('+')) {
        hunk.lines.push({ kind: 'add', text: body, oldLine: null, newLine })
        file.added += 1
        file.lineCount += 1
        newLine += 1
      } else if (raw.startsWith('-')) {
        hunk.lines.push({ kind: 'remove', text: body, oldLine, newLine: null })
        file.removed += 1
        file.lineCount += 1
        oldLine += 1
      } else {
        hunk.lines.push({ kind: 'context', text: body, oldLine, newLine })
        file.lineCount += 1
        oldLine += 1
        newLine += 1
      }
    }
    // `\ No newline…`, `index …`, `old mode`, `new mode` and any unrecognised line are ignored.
  }
  return files
}

/** The totals across a parsed diff, for the file-list header. */
export function diffTotals(files: readonly DiffFile[]): { files: number; added: number; removed: number } {
  return { files: files.length, added: files.reduce((sum, file) => sum + file.added, 0), removed: files.reduce((sum, file) => sum + file.removed, 0) }
}

export type DiffBody = { text: string; bytes: number; overLimit: boolean }

/**
 * Reads a diff artifact's body, cancelling the stream once `DIFF_BYTE_LIMIT` bytes have arrived so an oversized patch is
 * never fully downloaded. `overLimit` says the body was cut; the caller then shows "over 1 MB, not read" with a show button
 * and does not render the partial text. When the stream is unavailable (a test environment or a tiny body) it falls back to
 * reading the whole response, still refusing to render past the limit.
 */
export async function fetchDiffText(scope: RunScope, artifactId: string, signal?: AbortSignal, limit: number = DIFF_BYTE_LIMIT): Promise<DiffBody> {
  // The bounded read owns its fetch so it can cancel the body stream at the limit; `api.ts` stays unchanged (it has no
  // streaming reader). Same relative path and error shape as `api.ts`'s own `request`.
  const path = paths.artifact(scope, artifactId)
  let response: Response
  try {
    response = await fetch(path, { signal, headers: { Accept: 'text/plain, */*' } })
  } catch (error) {
    if (signal?.aborted) throw error
    throw new ProjectsApiError('network', error instanceof Error ? error.message : 'Network failure', path)
  }
  if (!response.ok) throw new ProjectsApiError('http', `The API responded with status ${response.status}.`, path, { status: response.status })
  const body = response.body
  if (!body || typeof body.getReader !== 'function') {
    const text = await response.text()
    const bytes = new TextEncoder().encode(text).length
    return bytes > limit ? { text: '', bytes, overLimit: true } : { text, bytes, overLimit: false }
  }
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) {
        bytes += value.byteLength
        if (bytes > limit) {
          await reader.cancel()
          return { text: '', bytes, overLimit: true }
        }
        chunks.push(value)
      }
    }
  } finally {
    reader.releaseLock?.()
  }
  return { text: new TextDecoder().decode(concat(chunks)), bytes, overLimit: false }
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}
