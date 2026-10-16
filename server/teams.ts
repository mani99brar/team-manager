import fs, { type FileHandle } from 'node:fs/promises'
import { constants, type Dirent } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import { z } from 'zod'
import type { SessionRow } from '../contracts/projects/sessions.ts'
import {
  TEAMS_VERSION, type AgentState, type TeamAgent, type TeamPhase, type TeamSession, type TeamTotals, type TeamWorkflow, type Teams,
  type WorkflowStatus,
} from '../contracts/projects/teams.ts'
import { ID_PATTERN } from './projectsConfig.ts'
import { readBounded, redactText } from './projects.ts'
import { iso } from './sessions.ts'

/**
 * The team reader (docs/PRD_RUN_TEAMS.md "Team reader"): the agent teams a run's Claude sessions fanned out with Claude Code's
 * Workflow tool ("ultracode"), read from Claude Code's own records under `<claudeHome>/projects` and served as the teams
 * contract (`contracts/projects/teams.ts`). Metadata only:
 *
 * - a finished workflow's summary `<slug>/<sid>/workflows/wf_<id>.json` (`record: 'final'`), with its agents from
 *   `workflowProgress`, a journal `failed` line marking an agent failed, and each agent's edited files and shell providers
 *   from its transcript when it is still on disk;
 * - a live workflow's `<slug>/<sid>/subagents/workflows/wf_<id>/` (`record: 'live'`): the journal's `started`, `result` and
 *   `failed` lines, each agent's `agent-<id>.meta.json`, the facts its transcript lines carry (times, model, tool names and
 *   counts, the last context size, the files an Edit or Write named, the providers a Bash command called) and the phase titles
 *   the script's `meta.phases` literal declares (parsed without evaluating anything).
 *
 * A session can own two slug folders (it changed directory after starting: the script sits under the other slug), so every
 * folder named `<sid>` under any slug is read and the union served. Nothing follows a symlink. Transcript text never leaves
 * this module beyond the capped, redacted previews; edited files are relative to the session's (or the isolated agent's)
 * worktree, or redacted. A missing folder or one without workflow records is `records: 'none'`; a folder that cannot be read
 * is `records: 'unreadable'` with a fixed reason, never an error for the run. The roots and the clock are injected so tests
 * read temporary directories.
 */

/** The fixed reason of an unreadable session folder. */
export const UNREADABLE_REASON = 'The session folder could not be read'

/** The roles whose sessions are Claude Code sessions (a pi or openrouter transport excepted). */
const CLAUDE_ROLES = new Set<string>(['worker', 'repair', 'challenge', 'reviewer', 'critique', 'sidecar', 'attack'])
const NON_CLAUDE_TRANSPORTS = new Set(['pi', 'openrouter'])
/** The session statuses that mean the session ended: its unfinished workflows are interrupted, never running. */
const ENDED_STATUSES = new Set<string>(['stopped', 'succeeded', 'failed'])

const INDEX_TTL_MS = 30_000
const MISS_REFRESH_MS = 5_000
const LIVE_WINDOW_MS = 15 * 60_000
const SUMMARY_BYTE_LIMIT = 16 * 1024 * 1024
const META_BYTE_LIMIT = 1024 * 1024
const SCRIPT_BYTE_LIMIT = 4 * 1024 * 1024
const WORKTREE_FILE_BYTE_LIMIT = 4 * 1024 * 1024
/** At most this much of one journal or transcript is read; the rest is ignored as if the file ended there. */
export const TRANSCRIPT_BYTE_LIMIT = 64 * 1024 * 1024
const TRANSCRIPT_CACHE_ENTRIES = 4000
const MAX_AGENTS = 400
const MAX_FILES = 50
const MAX_PROVIDERS = 10
const MAX_LOGS = 50
const LOG_CHARS = 300
const ERROR_CHARS = 300
const WORKFLOW_RESULT_CHARS = 600
const AGENT_PREVIEW_CHARS = 400
const TOOL_SUMMARY_CHARS = 60
/** Raw file paths kept per transcript before the per-agent cap (the count keeps going). */
const RAW_FILES_KEPT = 200

const WORKFLOW_ID = /^wf_[0-9A-Za-z-]{1,64}$/
const AGENT_ID = /^a[0-9a-f]{6,40}$/
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK

/** Where Claude Code keeps its records: `MD_MANAGER_CLAUDE_HOME`, else `CLAUDE_CONFIG_DIR`, else `<home>/.claude`. */
export function claudeHomeOf(env: NodeJS.ProcessEnv, home: string): string {
  return env.MD_MANAGER_CLAUDE_HOME || env.CLAUDE_CONFIG_DIR || join(home, '.claude')
}

/** The sessions payload rows the teams payload lists: Claude sessions with an ID-pattern session id, in the payload's order. */
export function teamSessionRows(rows: readonly SessionRow[]): (SessionRow & { session_id: string })[] {
  return rows.filter((row): row is SessionRow & { session_id: string } =>
    CLAUDE_ROLES.has(row.role) && row.session_id !== null && ID_PATTERN.test(row.session_id) && !NON_CLAUDE_TRANSPORTS.has(row.transport ?? ''))
}

// ---- Small helpers --------------------------------------------------------------------------------------------------

function cap(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text
}

/** Redacted, then cut to `limit`; null for anything that is not a string or is empty. */
function preview(value: unknown, limit: number): string | null {
  if (typeof value !== 'string' || value.length === 0) return null
  return cap(redactText(value), limit)
}

/** A value as preview text: a string as is, anything else as JSON; null when absent. */
function valuePreview(value: unknown, limit: number): string | null {
  if (value === undefined || value === null) return null
  if (typeof value === 'string') return preview(value, limit)
  try {
    return preview(JSON.stringify(value), limit)
  } catch {
    return null
  }
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null
}

/** A non-blank string, redacted; null otherwise. */
function textRedacted(value: unknown): string | null {
  const found = text(value)
  return found === null ? null : redactText(found)
}

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

function positive(value: unknown): number | null {
  const n = count(value)
  return n !== null && n > 0 ? n : null
}

/** An epoch-milliseconds time as the contract's ISO form; null for anything else. */
function epochIso(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 8.64e15) return null
  return new Date(value).toISOString()
}

function laterIso(a: string | null, b: string | null): string | null {
  if (a === null) return b
  if (b === null) return a
  return Date.parse(b) > Date.parse(a) ? b : a
}

function earlierIso(a: string | null, b: string | null): string | null {
  if (a === null) return b
  if (b === null) return a
  return Date.parse(b) < Date.parse(a) ? b : a
}

function roleOf(label: string): string | null {
  const at = label.indexOf(':')
  return at > 0 ? label.slice(0, at) : null
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException)?.code
}

function isGone(error: unknown): boolean {
  const code = errorCode(error)
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/** Whether a listed entry is a real directory (never a symlink); an entry of unknown type is checked with lstat. */
async function isRealDirectory(parent: string, entry: Dirent): Promise<boolean> {
  if (entry.isDirectory()) return true
  if (entry.isSymbolicLink() || entry.isFile() || entry.isFIFO() || entry.isSocket() || entry.isBlockDevice() || entry.isCharacterDevice()) return false
  try {
    return (await fs.lstat(join(parent, entry.name))).isDirectory()
  } catch {
    return false
  }
}

/**
 * A directory's entries when `path` is a real directory (lstat: a symlink is not followed); null when it is missing, a
 * symlink or not a directory. Any other failure (a folder that cannot be read) is thrown.
 */
async function listRealDirectory(path: string): Promise<Dirent[] | null> {
  try {
    const stat = await fs.lstat(path)
    if (!stat.isDirectory()) return null
    return await fs.readdir(path, { withFileTypes: true })
  } catch (error) {
    if (isGone(error)) return null
    throw error
  }
}

/** A regular file's bytes, opened without following a symlink, at most `limit` bytes; null when missing, larger or not a file. */
async function readFileBounded(path: string, limit: number): Promise<Buffer | null> {
  let handle: FileHandle | null = null
  try {
    handle = await fs.open(path, READ_FLAGS)
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size > limit) return null
    const buffer = Buffer.allocUnsafe(Math.min(stat.size, limit) + 1)
    let offset = 0
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset)
      if (bytesRead === 0) break
      offset += bytesRead
    }
    return offset > limit ? null : buffer.subarray(0, offset)
  } catch {
    return null
  } finally {
    await handle?.close()
  }
}

async function readJsonFile(path: string, limit: number): Promise<unknown> {
  const bytes = await readFileBounded(path, limit)
  if (bytes === null) return undefined
  try {
    return JSON.parse(bytes.toString('utf8'))
  } catch {
    return undefined
  }
}

/** A regular file's modification time and size (lstat); null when missing or not a regular file. */
async function fileStat(path: string): Promise<{ mtimeMs: number; size: number } | null> {
  try {
    const stat = await fs.lstat(path)
    return stat.isFile() ? { mtimeMs: stat.mtimeMs, size: stat.size } : null
  } catch {
    return null
  }
}

/**
 * Calls `onLine` for each line of a regular file (no symlink followed), reading at most `TRANSCRIPT_BYTE_LIMIT` bytes; a
 * torn last line is passed like any other (callers tolerate lines that fail to parse). False when the file cannot be opened.
 */
async function eachLine(path: string, onLine: (line: string) => void): Promise<boolean> {
  let handle: FileHandle | null = null
  try {
    handle = await fs.open(path, READ_FLAGS)
    if (!(await handle.stat()).isFile()) return false
    for await (const line of handle.readLines({ start: 0, end: TRANSCRIPT_BYTE_LIMIT - 1, encoding: 'utf8' })) onLine(line)
    return true
  } catch {
    return false
  } finally {
    await handle?.close().catch(() => {})
  }
}

function parseLine(line: string): unknown {
  try {
    return JSON.parse(line)
  } catch {
    return undefined
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

// ---- The script's `meta` literal (no evaluation) --------------------------------------------------------------------

type Token = { kind: 'punct' | 'string' | 'word' | 'other'; value: string }
type Literal = string | number | boolean | null | undefined | Literal[] | { [key: string]: Literal }

const MAX_TOKENS = 200_000

/** Tokens of a JavaScript source from `start`: punctuation, string literals (a template with `${` is `other`), words. */
function* tokens(source: string, start: number): Generator<Token> {
  let i = start
  let produced = 0
  while (i < source.length && produced < MAX_TOKENS) {
    const c = source[i]!
    if (/\s/.test(c)) { i += 1; continue }
    if (c === '/' && source[i + 1] === '/') { const end = source.indexOf('\n', i); i = end < 0 ? source.length : end + 1; continue }
    if (c === '/' && source[i + 1] === '*') { const end = source.indexOf('*/', i + 2); i = end < 0 ? source.length : end + 2; continue }
    produced += 1
    if ('{}[](),:'.includes(c)) { yield { kind: 'punct', value: c }; i += 1; continue }
    if (c === '"' || c === "'" || c === '`') {
      let value = ''
      let j = i + 1
      let template = false
      while (j < source.length && source[j] !== c) {
        if (source[j] === '\\' && j + 1 < source.length) {
          const next = source[j + 1]!
          if (next === 'u' && /^[0-9a-fA-F]{4}$/.test(source.slice(j + 2, j + 6))) { value += String.fromCharCode(parseInt(source.slice(j + 2, j + 6), 16)); j += 6; continue }
          value += next === 'n' ? '\n' : next === 't' ? '\t' : next === 'r' ? '\r' : next
          j += 2
          continue
        }
        if (c === '`' && source[j] === '$' && source[j + 1] === '{') template = true
        if (c !== '`' && source[j] === '\n') break
        value += source[j]
        j += 1
      }
      const closed = j < source.length && source[j] === c
      i = j + 1
      yield template || !closed ? { kind: 'other', value: '' } : { kind: 'string', value }
      continue
    }
    const word = /^[A-Za-z0-9_$.+-]+/.exec(source.slice(i, i + 256))
    if (word) { yield { kind: 'word', value: word[0] }; i += word[0].length; continue }
    yield { kind: 'other', value: c }
    i += 1
  }
}

/** A tolerant parser of object, array, string, number, boolean and null literals; anything else is `undefined`. */
class LiteralParser {
  private readonly iterator: Generator<Token>
  private peeked: Token | null | undefined = undefined
  constructor(iterator: Generator<Token>) {
    this.iterator = iterator
  }

  private peek(): Token | null {
    if (this.peeked === undefined) { const next = this.iterator.next(); this.peeked = next.done ? null : next.value }
    return this.peeked
  }

  private take(): Token | null {
    const token = this.peek()
    this.peeked = undefined
    return token
  }

  private isPunct(token: Token | null, value: string): boolean {
    return token !== null && token.kind === 'punct' && token.value === value
  }

  /** Skips tokens up to (not including) a `,`, `}` or `]` at the current depth. */
  private skipRest() {
    let depth = 0
    for (let token = this.peek(); token !== null; token = this.peek()) {
      if (token.kind === 'punct') {
        if (depth === 0 && (token.value === ',' || token.value === '}' || token.value === ']' || token.value === ')')) return
        if ('{[('.includes(token.value)) depth += 1
        if ('}])'.includes(token.value)) depth -= 1
      }
      this.take()
    }
  }

  /** One value; after a nested one, the next token is a delimiter (or the source ended). The top value ignores what follows it. */
  value(top = false): Literal {
    const token = this.take()
    if (token === null) return undefined
    let result: Literal = undefined
    if (this.isPunct(token, '{')) {
      const object: { [key: string]: Literal } = {}
      for (;;) {
        const next = this.peek()
        if (next === null) return object
        if (this.isPunct(next, '}')) { this.take(); break }
        if (this.isPunct(next, ',')) { this.take(); continue }
        const key = this.take()!
        if ((key.kind === 'word' || key.kind === 'string') && this.isPunct(this.peek(), ':')) {
          this.take()
          const value = this.value()
          if (key.value !== '__proto__') object[key.value] = value
        } else {
          this.skipRest()
        }
        if (this.peek() !== null && !this.isPunct(this.peek(), ',') && !this.isPunct(this.peek(), '}')) this.skipRest()
      }
      result = object
    } else if (this.isPunct(token, '[')) {
      const array: Literal[] = []
      for (;;) {
        const next = this.peek()
        if (next === null) return array
        if (this.isPunct(next, ']')) { this.take(); break }
        if (this.isPunct(next, ',')) { this.take(); continue }
        array.push(this.value())
        if (this.peek() !== null && !this.isPunct(this.peek(), ',') && !this.isPunct(this.peek(), ']')) this.skipRest()
      }
      result = array
    } else if (token.kind === 'string') {
      result = token.value
    } else if (token.kind === 'word') {
      result = token.value === 'true' ? true : token.value === 'false' ? false : token.value === 'null' ? null
        : /^-?\d+(?:\.\d+)?$/.test(token.value) ? Number(token.value) : undefined
    }
    if (top) return result
    const after = this.peek()
    if (after !== null && !(after.kind === 'punct' && ',}])'.includes(after.value))) {
      // `'a' + b`, a call or anything else that is not a plain literal: not a value we can read.
      this.skipRest()
      return undefined
    }
    return result
  }
}

export type ScriptMeta = { name: string | null; description: string | null; phases: { title: string; detail: string | null }[] }

/** The `meta` object literal of a Workflow script (`export const meta = { name, description, phases: [...] }`); null without one. */
export function parseScriptMeta(source: string): ScriptMeta | null {
  const match = /\bmeta\s*=\s*\{/.exec(source)
  if (!match) return null
  const parsed = record(new LiteralParser(tokens(source, match.index + match[0].length - 1)).value(true))
  if (parsed === null) return null
  const phases = Array.isArray(parsed.phases) ? parsed.phases.flatMap(entry => {
    const phase = record(entry)
    const title = text(phase?.title)
    return title === null ? [] : [{ title, detail: typeof phase?.detail === 'string' ? phase.detail : null }]
  }) : []
  return { name: text(parsed.name), description: typeof parsed.description === 'string' ? parsed.description : null, phases }
}

// ---- Transcript facts ---------------------------------------------------------------------------------------------

/** What one agent transcript says without its text. `files` are the raw paths, deduplicated, the first `RAW_FILES_KEPT`. */
export type TranscriptFacts = {
  first: string | null
  last: string | null
  model: string | null
  toolCalls: number
  lastTool: string | null
  context: number | null
  files: string[]
  filesTotal: number
  providers: string[]
}

const COMMAND_BOUNDARY = String.raw`(?:^|[\s;&|(\x60])`
const PI_COMMAND = new RegExp(`${COMMAND_BOUNDARY}pi\\s`)
const MUSE_COMMAND = new RegExp(`${COMMAND_BOUNDARY}muse\\s+exec\\b`)
const AGY_COMMAND = new RegExp(`${COMMAND_BOUNDARY}agy\\s`)
const MODEL_FLAG = /--model(?:=|\s+)['"]?([A-Za-z0-9._:/@+-]+)/

/** The other providers a Bash command called: `pi --model <m>` -> `<m>`, `muse exec` -> `muse[/<m>]`, `agy` -> `agy[/<m>]`. */
export function providersOfCommand(command: string): string[] {
  const model = MODEL_FLAG.exec(command)?.[1] ?? null
  const found: string[] = []
  if (PI_COMMAND.test(command) && model !== null) found.push(model)
  if (MUSE_COMMAND.test(command)) found.push(model === null ? 'muse' : `muse/${model}`)
  if (AGY_COMMAND.test(command)) found.push(model === null ? 'agy' : `agy/${model}`)
  return found
}

function timestampOf(line: string | null): string | null {
  if (line === null) return null
  const parsed = record(parseLine(line))
  return iso(typeof parsed?.timestamp === 'string' ? parsed.timestamp : null)
}

/** Streams one transcript: only lines naming `"tool_use"` are parsed for tool facts; the last usage line is parsed once at the end. */
async function readTranscriptFacts(path: string): Promise<TranscriptFacts | null> {
  const facts: TranscriptFacts = { first: null, last: null, model: null, toolCalls: 0, lastTool: null, context: null, files: [], filesTotal: 0, providers: [] }
  const seenFiles = new Set<string>()
  const seenProviders = new Set<string>()
  let firstPending = true
  const lastLines: string[] = []
  const usageLines: string[] = []
  const ok = await eachLine(path, line => {
    if (line.length === 0) return
    if (firstPending) {
      const at = timestampOf(line)
      if (at !== null) { facts.first = at; firstPending = false }
    }
    lastLines.push(line)
    if (lastLines.length > 2) lastLines.shift()
    if (line.includes('"usage"')) { usageLines.push(line); if (usageLines.length > 2) usageLines.shift() }
    if (!line.includes('"tool_use"')) return
    const parsed = record(parseLine(line))
    const message = record(parsed?.message)
    if (parsed?.type !== 'assistant' || !Array.isArray(message?.content)) return
    for (const block of message.content) {
      const tool = record(block)
      if (tool?.type !== 'tool_use' || typeof tool.name !== 'string') continue
      facts.toolCalls += 1
      facts.lastTool = tool.name
      const input = record(tool.input)
      if (EDIT_TOOLS.has(tool.name)) {
        const file = text(input?.file_path) ?? text(input?.notebook_path)
        if (file !== null && !seenFiles.has(file)) {
          seenFiles.add(file)
          facts.filesTotal += 1
          if (facts.files.length < RAW_FILES_KEPT) facts.files.push(file)
        }
      }
      if (tool.name === 'Bash' && typeof input?.command === 'string') {
        for (const provider of providersOfCommand(input.command)) {
          if (!seenProviders.has(provider) && seenProviders.size < MAX_PROVIDERS) { seenProviders.add(provider); facts.providers.push(provider) }
        }
      }
    }
  })
  if (!ok) return null
  // The last complete line: a torn (or spliced) last line fails to parse, so the one before it is used.
  for (let k = lastLines.length - 1; k >= 0 && facts.last === null; k -= 1) facts.last = timestampOf(lastLines[k]!)
  for (let k = usageLines.length - 1; k >= 0; k -= 1) {
    const parsed = record(parseLine(usageLines[k]!))
    const message = record(parsed?.message)
    const usage = record(message?.usage)
    if (parsed?.type !== 'assistant' || usage === null) continue
    const parts = [usage.input_tokens, usage.cache_creation_input_tokens, usage.cache_read_input_tokens].map(value => count(value) ?? 0)
    facts.context = parts.reduce((sum, part) => sum + part, 0)
    const model = text(message?.model)
    facts.model = model !== null && !model.startsWith('<') ? model : null
    break
  }
  return facts
}

// ---- Journal ------------------------------------------------------------------------------------------------------

type Journal = { started: { agentId: string; label: string | null; phase: string | null }[]; results: Map<string, unknown>; failed: Set<string> }

async function readJournal(path: string): Promise<Journal | null> {
  const journal: Journal = { started: [], results: new Map(), failed: new Set() }
  const seen = new Set<string>()
  const ok = await eachLine(path, line => {
    const entry = record(parseLine(line))
    const agentId = typeof entry?.agentId === 'string' && AGENT_ID.test(entry.agentId) ? entry.agentId : null
    if (entry === null || agentId === null) return
    if (entry.type === 'started' && !seen.has(agentId)) {
      seen.add(agentId)
      journal.started.push({ agentId, label: text(entry.label), phase: text(entry.phase) })
    } else if (entry.type === 'result') {
      journal.results.set(agentId, entry.result)
    } else if (entry.type === 'failed') {
      journal.failed.add(agentId)
    }
  })
  return ok ? journal : null
}

// ---- Record schemas (read permissively) ---------------------------------------------------------------------------

const summarySchema = z.object({
  runId: z.unknown().optional(), timestamp: z.unknown().optional(), startTime: z.unknown().optional(), durationMs: z.unknown().optional(), workflowName: z.unknown().optional(), summary: z.unknown().optional(),
  phases: z.unknown().optional(), defaultModel: z.unknown().optional(), agentCount: z.unknown().optional(), totalTokens: z.unknown().optional(), totalToolCalls: z.unknown().optional(),
  result: z.unknown().optional(), logs: z.unknown().optional(), error: z.unknown().optional(), status: z.unknown().optional(), scriptPath: z.unknown().optional(),
  workflowProgress: z.array(z.unknown().optional()),
})
const metaSchema = z.object({ description: z.unknown().optional(), workflowPhase: z.unknown().optional(), model: z.unknown().optional(), worktreePath: z.unknown().optional() })

// ---- Worktrees of the run's sessions ------------------------------------------------------------------------------

/** The run-directory file that records a session row's worktree: a lane's receipt (current or archived) or a repair's. */
function worktreeFileOf(key: string): string | null {
  let match = /^worker:([^:]+)$/.exec(key)
  if (match && ID_PATTERN.test(match[1]!)) return `${match[1]}.interactive.json`
  match = /^worker:([^:]+):launch-(\d+)$/.exec(key)
  if (match && ID_PATTERN.test(match[1]!)) return `${match[1]}.launch-${match[2]}.receipt.json`
  match = /^repair:(\d+)$/.exec(key)
  if (match) return `repair-${match[1]}.interactive.json`
  return null
}

/**
 * Each session row's worktree as its receipt records it (`<lane>.interactive.json`, `<lane>.launch-<n>.receipt.json`,
 * `repair-<n>.interactive.json`), keyed by row key; a row without one is absent (its edited files are then redacted).
 */
export async function readSessionWorktrees(directory: FileHandle, rows: readonly SessionRow[]): Promise<Map<string, string>> {
  const worktrees = new Map<string, string>()
  for (const row of rows) {
    const file = worktreeFileOf(row.key)
    if (file === null) continue
    let parsed: unknown
    try {
      const bytes = await readBounded(directory, [file], WORKTREE_FILE_BYTE_LIMIT)
      parsed = bytes === null ? undefined : JSON.parse(bytes.toString('utf8'))
    } catch {
      continue
    }
    const worktree = record(parsed)?.worktree
    if (typeof worktree === 'string' && isAbsolute(worktree)) worktrees.set(row.key, worktree)
  }
  return worktrees
}

/** A file an agent edited, relative to the first worktree that holds it; any other path is redacted. */
function servedFile(path: string, bases: readonly string[]): string {
  if (isAbsolute(path)) {
    for (const base of bases) {
      const inside = relative(base, path)
      if (inside && inside !== '..' && !inside.startsWith(`..${sep}`) && !isAbsolute(inside)) return redactText(inside.split(sep).join('/'))
    }
  }
  return redactText(path)
}

// ---- The reader ---------------------------------------------------------------------------------------------------

export type TeamReaderOptions = {
  /** Claude Code's config folder; its `projects/` holds the session records. */
  claudeHome: string
  /** Epoch milliseconds; tests pin it. */
  now?: () => number
}

export type TeamReadInput = {
  runId: string
  /** The sessions payload's rows (all of them; the Claude ones are picked here). */
  rows: readonly SessionRow[]
  /** Each row's worktree by row key (`readSessionWorktrees`). */
  worktrees: ReadonlyMap<string, string>
}

type FolderIndex = { builtAt: number; state: 'ok' | 'missing' | 'unreadable'; folders: Map<string, string[]> }

/** Where a session's records sit: the final summaries, the live agent folders and the scripts, by workflow run id. */
type SessionRecords = { finals: Map<string, string>; lives: Map<string, string>; scripts: Map<string, string> }

type SessionContext = { row: SessionRow; worktree: string | null; now: number }

export class TeamReader {
  private readonly projects: string
  private readonly now: () => number
  private index: FolderIndex | null = null
  private indexing: Promise<FolderIndex> | null = null
  private readonly transcripts = new Map<string, { mtimeMs: number; size: number; facts: TranscriptFacts | null }>()

  constructor(options: TeamReaderOptions) {
    this.projects = join(options.claudeHome, 'projects')
    this.now = options.now ?? Date.now
  }

  /** The teams payload for a run: one entry per Claude session row, in the payload's order, and the totals over every listed agent. */
  async read(input: TeamReadInput): Promise<Teams> {
    const now = this.now()
    const sessions: TeamSession[] = []
    for (const row of teamSessionRows(input.rows)) {
      sessions.push(await this.readSession({ row, worktree: input.worktrees.get(row.key) ?? null, now }))
    }
    return { contract_version: TEAMS_VERSION, run_id: input.runId, read_at: new Date(now).toISOString(), sessions, totals: teamTotals(sessions) }
  }

  // ---- The session-id -> folders index (cached ~30 s, refreshed on a miss at most every 5 s) ----

  private async buildIndex(): Promise<FolderIndex> {
    const folders = new Map<string, string[]>()
    const builtAt = this.now()
    let slugs: Dirent[] | null
    try {
      slugs = await listRealDirectory(this.projects)
    } catch {
      return { builtAt, state: 'unreadable', folders }
    }
    if (slugs === null) return { builtAt, state: 'missing', folders }
    const directories: string[] = []
    for (const slug of slugs) if (await isRealDirectory(this.projects, slug)) directories.push(join(this.projects, slug.name))
    for (let start = 0; start < directories.length; start += 32) {
      await Promise.all(directories.slice(start, start + 32).map(async slug => {
        let entries: Dirent[]
        try {
          entries = await fs.readdir(slug, { withFileTypes: true })
        } catch {
          return
        }
        for (const entry of entries) {
          if (!ID_PATTERN.test(entry.name) || !(await isRealDirectory(slug, entry))) continue
          const list = folders.get(entry.name) ?? []
          list.push(join(slug, entry.name))
          folders.set(entry.name, list)
        }
      }))
    }
    for (const list of folders.values()) list.sort()
    return { builtAt, state: 'ok', folders }
  }

  private async refreshIndex(): Promise<FolderIndex> {
    this.indexing ??= this.buildIndex().then(index => { this.index = index; return index }).finally(() => { this.indexing = null })
    return this.indexing
  }

  private async foldersOf(sessionId: string): Promise<{ state: FolderIndex['state']; folders: string[] }> {
    let index = this.index
    const now = this.now()
    if (index === null || now - index.builtAt >= INDEX_TTL_MS) index = await this.refreshIndex()
    else if (!index.folders.has(sessionId) && now - index.builtAt >= MISS_REFRESH_MS) index = await this.refreshIndex()
    return { state: index.state, folders: index.folders.get(sessionId) ?? [] }
  }

  // ---- One session ----

  private async readSession(context: SessionContext): Promise<TeamSession> {
    const { row } = context
    const base = { key: row.key, role: row.role, label: row.label, node_id: row.node_id, lane: row.lane, session_id: row.session_id! }
    const none: TeamSession = { ...base, records: 'none', reason: null, workflows: [] }
    const unreadable: TeamSession = { ...base, records: 'unreadable', reason: UNREADABLE_REASON, workflows: [] }
    const { state, folders } = await this.foldersOf(row.session_id!)
    if (state === 'unreadable') return unreadable
    if (folders.length === 0) return none
    let records: SessionRecords
    try {
      records = await this.sessionRecords(folders)
    } catch {
      return unreadable
    }
    const ids = [...new Set([...records.finals.keys(), ...records.lives.keys()])]
    const workflows: TeamWorkflow[] = []
    for (const id of ids) {
      const workflow = await this.readWorkflow(id, records, context)
      if (workflow !== null) workflows.push(workflow)
    }
    if (workflows.length === 0) return none
    workflows.sort((a, b) => {
      if (a.started_at !== b.started_at) {
        if (a.started_at === null) return 1
        if (b.started_at === null) return -1
        const delta = Date.parse(a.started_at) - Date.parse(b.started_at)
        if (delta !== 0) return delta
      }
      return a.run_id < b.run_id ? -1 : a.run_id > b.run_id ? 1 : 0
    })
    return { ...base, records: 'found', reason: null, workflows }
  }

  /** The union of every slug folder's records; a folder that cannot be listed throws (the session is unreadable). */
  private async sessionRecords(folders: readonly string[]): Promise<SessionRecords> {
    const records: SessionRecords = { finals: new Map(), lives: new Map(), scripts: new Map() }
    for (const folder of folders) {
      // The folder itself first: a session folder that cannot be read is unreadable even when it holds nothing else.
      if ((await listRealDirectory(folder)) === null) continue
      const workflows = join(folder, 'workflows')
      for (const entry of (await listRealDirectory(workflows)) ?? []) {
        const match = /^(wf_[0-9A-Za-z-]{1,64})\.json$/.exec(entry.name)
        if (match && entry.isFile() && !records.finals.has(match[1]!)) records.finals.set(match[1]!, join(workflows, entry.name))
      }
      const scripts = join(workflows, 'scripts')
      for (const entry of (await listRealDirectory(scripts)) ?? []) {
        const match = /(?:^|-)(wf_[0-9A-Za-z-]{1,64})\.js$/.exec(entry.name)
        if (match && entry.isFile() && !records.scripts.has(match[1]!)) records.scripts.set(match[1]!, join(scripts, entry.name))
      }
      if ((await listRealDirectory(join(folder, 'subagents'))) === null) continue
      const lives = join(folder, 'subagents', 'workflows')
      for (const entry of (await listRealDirectory(lives)) ?? []) {
        if (WORKFLOW_ID.test(entry.name) && (await isRealDirectory(lives, entry)) && !records.lives.has(entry.name)) records.lives.set(entry.name, join(lives, entry.name))
      }
    }
    return records
  }

  private async transcriptFacts(path: string): Promise<{ facts: TranscriptFacts | null; mtimeMs: number | null }> {
    const stat = await fileStat(path)
    if (stat === null) return { facts: null, mtimeMs: null }
    const cached = this.transcripts.get(path)
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return { facts: cached.facts, mtimeMs: stat.mtimeMs }
    const facts = await readTranscriptFacts(path)
    this.transcripts.delete(path)
    this.transcripts.set(path, { ...stat, facts })
    while (this.transcripts.size > TRANSCRIPT_CACHE_ENTRIES) this.transcripts.delete(this.transcripts.keys().next().value!)
    return { facts, mtimeMs: stat.mtimeMs }
  }

  private async scriptMeta(id: string, records: SessionRecords, scriptPath: unknown): Promise<ScriptMeta | null> {
    let path = records.scripts.get(id) ?? null
    if (path === null && typeof scriptPath === 'string' && isAbsolute(scriptPath)) {
      const inside = relative(this.projects, scriptPath)
      if (inside && !inside.startsWith('..') && !isAbsolute(inside)) path = scriptPath
    }
    if (path === null) return null
    const bytes = await readFileBounded(path, SCRIPT_BYTE_LIMIT)
    const meta = bytes === null ? null : parseScriptMeta(bytes.toString('utf8'))
    return meta === null ? null : {
      name: meta.name === null ? null : redactText(meta.name),
      description: meta.description === null ? null : redactText(meta.description),
      phases: meta.phases.map(phase => ({ title: redactText(phase.title), detail: phase.detail })),
    }
  }

  private async readWorkflow(id: string, records: SessionRecords, context: SessionContext): Promise<TeamWorkflow | null> {
    const finalPath = records.finals.get(id)
    const liveDir = records.lives.get(id) ?? null
    if (finalPath !== undefined) {
      const parsed = summarySchema.safeParse(await readJsonFile(finalPath, SUMMARY_BYTE_LIMIT))
      if (parsed.success) return this.finalWorkflow(id, parsed.data, liveDir, records, context)
    }
    return liveDir === null ? null : this.liveWorkflow(id, liveDir, records, context)
  }

  /** Files and providers from an agent's transcript, with the agent's own worktree (isolated) before the session's. */
  private agentFiles(facts: TranscriptFacts | null, bases: readonly string[]): Pick<TeamAgent, 'files_edited' | 'files_edited_more' | 'providers'> {
    if (facts === null) return { files_edited: [], files_edited_more: 0, providers: [] }
    const served = [...new Set(facts.files.map(file => servedFile(file, bases)).filter(file => file.length > 0))]
    const listed = served.slice(0, MAX_FILES)
    return {
      files_edited: listed,
      // The served (deduplicated) files past the first 50, plus any raw paths past those kept from the transcript.
      files_edited_more: served.length - listed.length + Math.max(0, facts.filesTotal - facts.files.length),
      providers: facts.providers.map(provider => redactText(provider)).filter(provider => provider.length > 0).slice(0, MAX_PROVIDERS),
    }
  }

  private async readMeta(liveDir: string | null, agentId: string | null): Promise<z.infer<typeof metaSchema> | null> {
    if (liveDir === null || agentId === null) return null
    const parsed = metaSchema.safeParse(await readJsonFile(join(liveDir, `agent-${agentId}.meta.json`), META_BYTE_LIMIT))
    return parsed.success ? parsed.data : null
  }

  private async finalWorkflow(id: string, summary: z.infer<typeof summarySchema>, liveDir: string | null, records: SessionRecords, context: SessionContext): Promise<TeamWorkflow> {
    const journal = liveDir === null ? null : await readJournal(join(liveDir, 'journal.jsonl'))
    const rawStatus = summary.status
    const status: WorkflowStatus = rawStatus === 'completed' || rawStatus === 'failed' || rawStatus === 'killed' ? rawStatus : 'interrupted'
    // Phases: the summary's `phases`, else its `workflow_phase` entries, else the script's `meta.phases`.
    let phaseList: { title: string; detail: string | null }[] = Array.isArray(summary.phases) ? summary.phases.flatMap(entry => {
      const phase = record(entry)
      const title = text(phase?.title)
      return title === null ? [] : [{ title: redactText(title), detail: typeof phase?.detail === 'string' ? phase.detail : null }]
    }) : []
    if (phaseList.length === 0) {
      phaseList = summary.workflowProgress.flatMap(entry => {
        const phase = record(entry)
        const title = text(phase?.title)
        return phase?.type === 'workflow_phase' && title !== null ? [{ title: redactText(title), detail: null }] : []
      })
    }
    if (phaseList.length === 0) phaseList = (await this.scriptMeta(id, records, summary.scriptPath))?.phases ?? []

    const used = new Set<number>()
    let nextIndex = 1
    const agents: TeamAgent[] = []
    for (const raw of summary.workflowProgress) {
      const entry = record(raw)
      if (entry?.type !== 'workflow_agent') continue
      let index = positive(entry.index)
      if (index === null || used.has(index)) {
        while (used.has(nextIndex)) nextIndex += 1
        index = nextIndex
      }
      used.add(index)
      const agentId = typeof entry.agentId === 'string' && AGENT_ID.test(entry.agentId) ? entry.agentId : null
      let state: AgentState = entry.state === 'done' ? 'done' : entry.state === 'start' ? 'queued' : agentId === null ? 'queued' : 'interrupted'
      if (agentId !== null && journal?.failed.has(agentId)) state = 'failed'
      const label = redactText(text(entry.label) ?? `agent ${index}`)
      const meta = await this.readMeta(liveDir, agentId)
      const worktreePath = text(meta?.worktreePath)
      const transcript = liveDir === null || agentId === null ? null : (await this.transcriptFacts(join(liveDir, `agent-${agentId}.jsonl`))).facts
      const phaseIndex = positive(entry.phaseIndex)
      agents.push({
        agent_id: agentId, index, label, role: roleOf(label),
        phase: textRedacted(entry.phaseTitle) ?? (phaseIndex !== null ? phaseList[phaseIndex - 1]?.title ?? null : null),
        phase_index: phaseIndex,
        model: text(entry.model) ?? transcript?.model ?? null,
        state,
        cached: entry.cached === true,
        attempt: positive(entry.attempt),
        isolated: entry.isolation === 'worktree' || worktreePath !== null,
        started_at: epochIso(entry.startedAt),
        last_activity_at: epochIso(entry.lastProgressAt),
        duration_ms: count(entry.durationMs),
        tool_calls: count(entry.toolCalls),
        context_tokens: count(entry.tokens),
        last_tool: text(entry.lastToolName),
        last_tool_summary: preview(entry.lastToolSummary, TOOL_SUMMARY_CHARS),
        prompt_preview: preview(entry.promptPreview, AGENT_PREVIEW_CHARS),
        result_preview: preview(entry.resultPreview, AGENT_PREVIEW_CHARS),
        ...this.agentFiles(transcript, [...(worktreePath !== null && isAbsolute(worktreePath) ? [worktreePath] : []), ...(context.worktree !== null ? [context.worktree] : [])]),
      })
    }
    agents.sort((a, b) => a.index - b.index)
    const listed = agents.slice(0, MAX_AGENTS)
    const startedAt = epochIso(summary.startTime)
    const endedAt = iso(typeof summary.timestamp === 'string' ? summary.timestamp : null)
    const lastAgent = listed.reduce<string | null>((latest, agent) => laterIso(latest, agent.last_activity_at), null)
    const logs = Array.isArray(summary.logs)
      ? summary.logs.filter((line): line is string => typeof line === 'string').slice(0, MAX_LOGS).map(line => cap(redactText(line), LOG_CHARS))
      : []
    const errorLine = typeof summary.error === 'string' ? summary.error.split('\n').find(line => line.trim().length > 0) ?? null : null
    return {
      run_id: id,
      name: textRedacted(summary.workflowName),
      description: typeof summary.summary === 'string' ? redactText(summary.summary) : null,
      status, record: 'final',
      started_at: startedAt,
      ended_at: endedAt,
      last_activity_at: laterIso(endedAt, lastAgent),
      duration_ms: count(summary.durationMs),
      default_model: text(summary.defaultModel),
      agent_count: count(summary.agentCount) ?? agents.length,
      tool_calls: count(summary.totalToolCalls),
      context_tokens: count(summary.totalTokens),
      phases: phaseCounts(phaseList, listed),
      agents: listed,
      agents_more: agents.length - listed.length,
      logs,
      result_preview: valuePreview(summary.result, WORKFLOW_RESULT_CHARS),
      error: errorLine === null ? null : cap(redactText(errorLine), ERROR_CHARS),
    }
  }

  private async liveWorkflow(id: string, liveDir: string, records: SessionRecords, context: SessionContext): Promise<TeamWorkflow | null> {
    const journalPath = join(liveDir, 'journal.jsonl')
    const journal = await readJournal(journalPath)
    if (journal === null) return null
    const journalStat = await fileStat(journalPath)
    let freshest = journalStat?.mtimeMs ?? 0
    type Started = { entry: Journal['started'][number]; meta: z.infer<typeof metaSchema> | null; facts: TranscriptFacts | null }
    const started: Started[] = []
    for (const entry of journal.started) {
      const meta = await this.readMeta(liveDir, entry.agentId)
      const { facts, mtimeMs } = await this.transcriptFacts(join(liveDir, `agent-${entry.agentId}.jsonl`))
      if (mtimeMs !== null) freshest = Math.max(freshest, mtimeMs)
      started.push({ entry, meta, facts })
    }
    const running = context.now - freshest <= LIVE_WINDOW_MS && !ENDED_STATUSES.has(context.row.status)
    const script = await this.scriptMeta(id, records, null)
    const phaseList = [...(script?.phases ?? [])]
    for (const { entry, meta } of started) {
      const title = textRedacted(entry.phase) ?? textRedacted(meta?.workflowPhase)
      if (title !== null && !phaseList.some(phase => phase.title === title)) phaseList.push({ title, detail: null })
    }
    const agents: TeamAgent[] = started.map(({ entry, meta, facts }, position) => {
      const label = redactText(entry.label ?? text(meta?.description) ?? `agent ${position + 1}`)
      const phase = textRedacted(entry.phase) ?? textRedacted(meta?.workflowPhase)
      const at = phase === null ? -1 : phaseList.findIndex(candidate => candidate.title === phase)
      const worktreePath = text(meta?.worktreePath)
      const state: AgentState = journal.failed.has(entry.agentId) ? 'failed' : journal.results.has(entry.agentId) ? 'done' : running ? 'running' : 'interrupted'
      const first = facts?.first ?? null
      const last = facts?.last ?? null
      const duration = first !== null && last !== null ? Math.max(0, Date.parse(last) - Date.parse(first)) : null
      return {
        agent_id: entry.agentId, index: position + 1, label, role: roleOf(label), phase, phase_index: at < 0 ? null : at + 1,
        model: facts?.model ?? text(meta?.model), state, cached: false, attempt: null, isolated: worktreePath !== null,
        started_at: first, last_activity_at: last, duration_ms: duration,
        tool_calls: facts === null ? null : facts.toolCalls, context_tokens: facts?.context ?? null,
        last_tool: facts?.lastTool ?? null, last_tool_summary: null, prompt_preview: null,
        result_preview: journal.results.has(entry.agentId) ? valuePreview(journal.results.get(entry.agentId), AGENT_PREVIEW_CHARS) : null,
        ...this.agentFiles(facts, [...(worktreePath !== null && isAbsolute(worktreePath) ? [worktreePath] : []), ...(context.worktree !== null ? [context.worktree] : [])]),
      }
    })
    const listed = agents.slice(0, MAX_AGENTS)
    const startedAt = agents.reduce<string | null>((earliest, agent) => earlierIso(earliest, agent.started_at), null)
    const lastAgent = agents.reduce<string | null>((latest, agent) => laterIso(latest, agent.last_activity_at), null)
    const toolCalls = agents.some(agent => agent.tool_calls !== null) ? agents.reduce((sum, agent) => sum + (agent.tool_calls ?? 0), 0) : null
    return {
      run_id: id,
      name: script?.name ?? null,
      description: script?.description ?? null,
      status: running ? 'running' : 'interrupted', record: 'live',
      started_at: startedAt, ended_at: null,
      last_activity_at: laterIso(lastAgent, journalStat === null ? null : epochIso(journalStat.mtimeMs)),
      duration_ms: null, default_model: null,
      agent_count: agents.length, tool_calls: toolCalls, context_tokens: null,
      phases: phaseCounts(phaseList, listed),
      agents: listed, agents_more: agents.length - listed.length,
      logs: [], result_preview: null, error: null,
    }
  }
}

/** Each declared phase with its listed agents counted by state (an agent counts by `phase_index`, else by its phase title). */
function phaseCounts(list: readonly { title: string; detail: string | null }[], agents: readonly TeamAgent[]): TeamPhase[] {
  return list.map((phase, position) => {
    const index = position + 1
    const counts: TeamPhase = { index, title: phase.title, detail: phase.detail === null ? null : redactText(phase.detail), agents: 0, queued: 0, running: 0, done: 0, failed: 0, interrupted: 0 }
    for (const agent of agents) {
      if (agent.phase_index !== null ? agent.phase_index !== index : agent.phase !== phase.title) continue
      counts.agents += 1
      counts[agent.state] += 1
    }
    return counts
  })
}

/** The totals exactly as `validateTeams` recomputes them. */
export function teamTotals(sessions: readonly TeamSession[]): TeamTotals {
  const totals: TeamTotals = { sessions_with_teams: 0, workflows: 0, workflows_running: 0, agents: 0, queued: 0, running: 0, done: 0, failed: 0, interrupted: 0, tool_calls: 0 }
  for (const session of sessions) {
    if (session.workflows.length > 0) totals.sessions_with_teams += 1
    for (const workflow of session.workflows) {
      totals.workflows += 1
      if (workflow.status === 'running') totals.workflows_running += 1
      for (const agent of workflow.agents) {
        totals.agents += 1
        totals[agent.state] += 1
        totals.tool_calls += agent.tool_calls ?? 0
      }
    }
  }
  return totals
}
