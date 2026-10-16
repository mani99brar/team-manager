import { createHash } from 'node:crypto'
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { closeSync, constants, openSync } from 'node:fs'
import fs, { type FileHandle } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { z } from 'zod'
import { controlRecordSchema, type ControlRecord } from '../contracts/projects/controls.ts'
import type { ControlsConfig } from './controlsGuard.ts'

/**
 * How a control runs and what it leaves behind (docs/PRD_RUN_CONTROLS.md 5.3 to 5.5, decisions.md [L1] 2 and 5): the read-only
 * lock probe over `/proc`, the process group signal for `pause`, short children and long transient units (always an argv array, no
 * shell), and the records in the server's own state directory. Nothing here writes into a run directory or takes a controller lock.
 */
export type RunKey = { project: string; workflow: string; run: string }

/** Node's `spawn`; an injected one may be asynchronous, which is the window `BUSY` covers while a long control is being spawned. */
export type SpawnFn = (command: string, args: string[], options: SpawnOptions) => ChildProcess | Promise<ChildProcess>
export type KillFn = (pid: number, signal: NodeJS.Signals) => void

export const OUTPUT_LINES = 40
export const SHORT_TIMEOUT_MS = 5 * 60 * 1000
const LINE_LIMIT = 1000
const TAIL_BYTES = 128 * 1024
const PROC_LIMIT = 1024 * 1024
const CLOCK_TICKS_PER_SECOND = 100

// ---- The lock probe (PRD 5.3) -------------------------------------------------------------------------------------------

export type LockProbe =
  | { state: 'held'; pid: number }
  | { state: 'free' }
  | { state: 'unknown' }

/**
 * The kernel's split of `st_dev` (glibc's gnu_dev_major/minor), on a BigInt: a JavaScript `number` shifted by 32 is shifted by 0
 * and truncated to 32 bits, which decodes 252:1 as 61692 and makes the probe report every lock free. glibc's `~0xfff` is a 32-bit
 * unsigned mask, so the masks are written out (`~0xfffn` on a BigInt would let the high bits of the other field through).
 */
export function deviceNumbers(dev: bigint): { major: bigint; minor: bigint } {
  return { major: ((dev >> 8n) & 0xfffn) | ((dev >> 32n) & 0xfffff000n), minor: (dev & 0xffn) | ((dev >> 12n) & 0xffffff00n) }
}

async function readProc(path: string): Promise<string | null> {
  let handle: FileHandle
  try {
    handle = await fs.open(path, constants.O_RDONLY)
  } catch {
    return null
  }
  try {
    const buffer = Buffer.alloc(PROC_LIMIT)
    let offset = 0
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, null)
      if (bytesRead === 0) break
      offset += bytesRead
    }
    return buffer.subarray(0, offset).toString('utf8')
  } catch {
    return null
  } finally {
    await handle.close()
  }
}

/** `/proc/locks` lines: `<n>: FLOCK  ADVISORY  WRITE <pid> <major>:<minor>:<inode> 0 EOF` (major and minor hex, inode decimal). */
const FLOCK_LINE = /^\s*\d+:\s+FLOCK\s+\S+\s+\S+\s+(\d+)\s+([0-9a-fA-F]+):([0-9a-fA-F]+):(\d+)\b/

/** Whether `lockFile` is flocked, by its inode and device against `/proc/locks`. It never opens the file for locking. */
export async function probeLock(procRoot: string, lockFile: string): Promise<LockProbe> {
  const locks = await readProc(join(procRoot, 'locks'))
  if (locks === null) return { state: 'unknown' }
  let stat
  try {
    stat = await fs.stat(lockFile, { bigint: true })
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? { state: 'free' } : { state: 'unknown' }
  }
  const { major, minor } = deviceNumbers(stat.dev)
  for (const line of locks.split('\n')) {
    const match = FLOCK_LINE.exec(line)
    if (match && BigInt(match[4]) === stat.ino && BigInt(`0x${match[2]}`) === major && BigInt(`0x${match[3]}`) === minor) return { state: 'held', pid: Number(match[1]) }
  }
  return { state: 'free' }
}

export type Holder = { pid: number; pgrp: number | null; since: string | null; argv: string[] }

function afterName(stat: string): string[] | null {
  const close = stat.lastIndexOf(')')
  return close < 0 ? null : stat.slice(close + 2).split(' ')
}

/** The lock holder's command line, process group and start time from `/proc/<pid>` (stat fields 5 and 22, `btime` of `/proc/stat`). */
export async function readHolder(procRoot: string, pid: number): Promise<Holder> {
  const [cmdline, stat, system] = await Promise.all([readProc(join(procRoot, String(pid), 'cmdline')), readProc(join(procRoot, String(pid), 'stat')), readProc(join(procRoot, 'stat'))])
  const fields = stat === null ? null : afterName(stat)
  const pgrp = fields && /^\d+$/.test(fields[5 - 3] ?? '') ? Number(fields[5 - 3]) : null
  const ticks = fields?.[22 - 3]
  const boot = system === null ? undefined : /^btime (\d+)$/m.exec(system)?.[1]
  const since = ticks && /^\d+$/.test(ticks) && boot ? new Date((Number(boot) + Number(ticks) / CLOCK_TICKS_PER_SECOND) * 1000).toISOString().replace(/\.\d+Z$/, 'Z') : null
  return { pid, pgrp, since, argv: cmdline === null ? [] : cmdline.split('\0').filter(Boolean) }
}

async function realpathOr(path: string): Promise<string> {
  try {
    return await fs.realpath(path)
  } catch {
    return resolve(path)
  }
}

/**
 * PRD 5.3: only a holder whose command line names `-m workflow`, a supervising verb (`automatic`, `launch`, `resume`) and this
 * run's directory may be signalled. Anything else is reported, never signalled.
 */
export async function holderIsSupervisorOf(holder: Holder, runDir: string): Promise<boolean> {
  const { argv } = holder
  const module = argv.findIndex((arg, index) => arg === '-m' && argv[index + 1] === 'workflow')
  if (module < 0) return false
  const rest = argv.slice(module + 2)
  if (!rest.some(arg => arg === 'automatic' || arg === 'launch' || arg === 'resume')) return false
  const wanted = await realpathOr(runDir)
  for (const arg of rest) {
    if (arg.startsWith('-') || !arg.includes('/')) continue
    if (resolve(arg) === resolve(runDir) || await realpathOr(arg) === wanted) return true
  }
  return false
}

// ---- Records (PRD 5.5) --------------------------------------------------------------------------------------------------

/** A credential in a URL (`https://user:token@host`, as git and gh may print a remote): the user and secret are cut. */
const URL_CREDENTIAL = /(\b[a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi

/** Replaces the home directory with `~`, the pairing token with `[token]` and cuts URL credentials; cuts a line at 1000 characters. */
export function redactLine(line: string, secrets: { home: string; token: string | null }): string {
  let text = line.replace(URL_CREDENTIAL, '$1')
  if (secrets.token) text = text.split(secrets.token).join('[token]')
  if (secrets.home && secrets.home !== '/') text = text.split(secrets.home).join('~')
  return text.length > LINE_LIMIT ? `${text.slice(0, LINE_LIMIT)}…` : text
}

/** Home as `~` and the token as `[token]`, without cutting the text (an argv element is data, not a log line). */
export function redactText(text: string, secrets: { home: string; token: string | null }): string {
  let out = text
  if (secrets.token) out = out.split(secrets.token).join('[token]')
  if (secrets.home && secrets.home !== '/') out = out.split(secrets.home).join('~')
  return out
}

export function tailLines(text: string, secrets: { home: string; token: string | null }, limit = OUTPUT_LINES): string[] {
  const lines = text.split(/\r?\n/)
  while (lines.length && lines[lines.length - 1] === '') lines.pop()
  const tail = lines.slice(-limit).map(line => redactLine(line, secrets))
  const blocked = tail.findIndex(line => line.startsWith('Blocked:'))
  return blocked > 0 ? [tail[blocked], ...tail.slice(0, blocked), ...tail.slice(blocked + 1)] : tail
}

export function runKeyOf(key: RunKey): string {
  return `${key.project}/${key.workflow}/${key.run}`
}

export function newRecordId(): string {
  return `c-${createHash('sha256').update(`${Math.random()}${process.hrtime.bigint()}${process.pid}`).digest('hex').slice(0, 12)}`
}

/** [L6] 1: the stored line is Appendix A's record plus the argv the server ran and the transient unit (null unless a systemd long control). */
export const storedRecordSchema = controlRecordSchema.extend({ argv: z.array(z.string()), unit: z.string().nullable() })
export type StoredRecord = ControlRecord & { argv: string[]; unit: string | null }

/** Reads strip `argv` and `unit`: the wire record stays Appendix A's strict shape. */
export function publicRecord(record: StoredRecord): ControlRecord {
  const { argv: _argv, unit: _unit, ...rest } = record
  void _argv
  void _unit
  return rest
}

/** `<MD_MANAGER_CONTROLS_STATE>/<project>/<workflow>/<run>.jsonl`, one line per change; the last line of a record wins. */
export class RecordStore {
  private readonly chains = new Map<string, Promise<void>>()
  private readonly stateDir: string
  private readonly now: () => Date
  private readonly secrets: { home: string; token: string | null }

  constructor(stateDir: string, now: () => Date, secrets: { home: string; token: string | null } = { home: '', token: null }) {
    this.stateDir = stateDir
    this.now = now
    this.secrets = secrets
  }

  private folder(key: RunKey): string {
    return join(this.stateDir, key.project, key.workflow)
  }

  file(key: RunKey): string {
    return join(this.folder(key), `${key.run}.jsonl`)
  }

  logPath(key: RunKey, recordId: string): string {
    return join(this.folder(key), `${key.run}.${recordId}.log`)
  }

  async prepare(key: RunKey): Promise<void> {
    await fs.mkdir(this.folder(key), { recursive: true, mode: 0o700 })
  }

  private async fold(file: string): Promise<StoredRecord[]> {
    let text: string
    try {
      text = await fs.readFile(file, 'utf8')
    } catch {
      return []
    }
    const byId = new Map<string, StoredRecord>()
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try {
        const parsed = storedRecordSchema.safeParse(JSON.parse(line))
        if (parsed.success) byId.set(parsed.data.record_id, parsed.data)
      } catch { /* a torn line is skipped */ }
    }
    return [...byId.values()]
  }

  /** The wire record; a `running` one carries the log's tail as of now ([L6] 5). */
  private async expose(key: RunKey, record: StoredRecord): Promise<ControlRecord> {
    const wire = publicRecord(record)
    if (record.status !== 'running') return wire
    return { ...wire, output_tail: tailLines(await readLogTail(this.logPath(key, record.record_id)), this.secrets) }
  }

  /** The run's records, newest first. */
  async list(key: RunKey, limit = 20): Promise<ControlRecord[]> {
    const stored = (await this.fold(this.file(key))).reverse().slice(0, limit)
    return Promise.all(stored.map(record => this.expose(key, record)))
  }

  async all(key: RunKey): Promise<StoredRecord[]> {
    return this.fold(this.file(key))
  }

  async get(key: RunKey, recordId: string): Promise<ControlRecord | null> {
    const record = (await this.fold(this.file(key))).find(candidate => candidate.record_id === recordId)
    return record ? this.expose(key, record) : null
  }

  async byRequest(key: RunKey, requestId: string): Promise<ControlRecord | null> {
    const record = (await this.fold(this.file(key))).find(candidate => candidate.request_id === requestId)
    return record ? this.expose(key, record) : null
  }

  async write(key: RunKey, record: StoredRecord): Promise<void> {
    const file = this.file(key)
    const line = `${JSON.stringify(storedRecordSchema.parse(record))}\n`
    const previous = this.chains.get(file) ?? Promise.resolve()
    const next = previous.then(async () => {
      await this.prepare(key)
      await fs.appendFile(file, line, { mode: 0o600 })
    })
    this.chains.set(file, next.catch(() => undefined))
    await next
  }

  /** A server restart cannot observe a child it did not wait for: every `running` record becomes `lost`. */
  async recoverLost(): Promise<number> {
    let lost = 0
    for (const project of await fs.readdir(this.stateDir).catch(() => [])) {
      for (const workflow of await fs.readdir(join(this.stateDir, project)).catch(() => [])) {
        const folder = join(this.stateDir, project, workflow)
        for (const name of await fs.readdir(folder).catch(() => [])) {
          if (!name.endsWith('.jsonl')) continue
          const key = { project, workflow, run: name.slice(0, -'.jsonl'.length) }
          for (const record of await this.all(key)) {
            if (record.status !== 'running') continue
            await this.write(key, { ...record, status: 'lost', ended_at: this.now().toISOString().replace(/\.\d+Z$/, 'Z') })
            lost += 1
          }
        }
      }
    }
    return lost
  }
}

// ---- Children (PRD 5.4) -------------------------------------------------------------------------------------------------

export type ChildResult =
  | { kind: 'exit'; code: number | null; signal: NodeJS.Signals | null; timedOut: boolean }
  | { kind: 'error'; code: string }

export type RunningChild = { pid: number | undefined; done: Promise<ChildResult> }

export type RunnerOptions = {
  spawn?: SpawnFn
  kill?: KillFn
  /** The bound on a short control; tests lower it. */
  timeoutMs?: number
  /** Whether `systemd-run` can be found; probed on PATH when omitted. */
  systemdRun?: boolean
}

export function killProcessGroup(pid: number, signal: NodeJS.Signals): void {
  process.kill(-pid, signal)
}

/** `systemd-run` on the PATH of the server's environment. */
export async function findSystemdRun(env: NodeJS.ProcessEnv): Promise<boolean> {
  for (const folder of (env.PATH ?? '').split(delimiter).filter(Boolean)) {
    try {
      await fs.access(join(folder, 'systemd-run'), constants.X_OK)
      return true
    } catch { /* next */ }
  }
  return false
}

export class Runner {
  readonly config: ControlsConfig
  readonly spawn: SpawnFn
  readonly kill: KillFn
  readonly timeoutMs: number
  readonly systemdRun: boolean | undefined
  readonly killInjected: boolean

  constructor(config: ControlsConfig, options: RunnerOptions = {}) {
    this.config = config
    this.spawn = options.spawn ?? ((command, args, spawnOptions) => nodeSpawn(command, args, spawnOptions))
    this.kill = options.kill ?? killProcessGroup
    this.killInjected = options.kill !== undefined
    this.timeoutMs = options.timeoutMs ?? SHORT_TIMEOUT_MS
    this.systemdRun = options.systemdRun
  }

  async longAvailable(): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (this.config.spawnMode === 'direct') return { ok: true }
    const found = this.systemdRun ?? await findSystemdRun(this.config.childEnv)
    return found ? { ok: true } : { ok: false, reason: 'systemd-run is not available on this host; run the command in your terminal' }
  }

  /** Starts one child with stdout and stderr appended to `logPath`; a synchronous failure to start is thrown. */
  async start(command: string, args: string[], logPath: string, bound: boolean): Promise<RunningChild> {
    const fd = openSync(logPath, 'a', 0o600)
    let child: ChildProcess
    try {
      child = await this.spawn(command, args, { cwd: this.config.home, env: this.config.childEnv, detached: true, stdio: ['ignore', fd, fd], shell: false })
    } finally {
      closeSync(fd)
    }
    child.unref?.()
    let timedOut = false
    let timer: NodeJS.Timeout | undefined
    const done = new Promise<ChildResult>(resolveDone => {
      let settled = false
      const settle = (result: ChildResult) => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        resolveDone(result)
      }
      child.once('error', error => settle({ kind: 'error', code: (error as NodeJS.ErrnoException).code ?? 'ERROR' }))
      child.once('exit', (code, signal) => settle({ kind: 'exit', code, signal, timedOut }))
    })
    if (bound && child.pid !== undefined) {
      const pid = child.pid
      timer = setTimeout(() => {
        timedOut = true
        try { this.kill(pid, 'SIGKILL') } catch { /* already gone */ }
      }, this.timeoutMs)
      timer.unref()
    }
    return { pid: child.pid, done }
  }

  /** A short child whose stdout and stderr come back as text (the clean preview); bounded like every short control. */
  /** `capture` with stdout and stderr kept apart (the relaunch dry run's verdict is stdout's first line, else stderr's `Blocked:` line). */
  async captureStreams(command: string, args: string[]): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
    const child = await this.spawn(command, args, { cwd: this.config.home, env: this.config.childEnv, detached: true, stdio: ['ignore', 'pipe', 'pipe'], shell: false })
    return new Promise((resolveCapture, reject) => {
      const chunks: { stdout: Buffer[]; stderr: Buffer[] } = { stdout: [], stderr: [] }
      let size = 0
      for (const name of ['stdout', 'stderr'] as const) {
        child[name]?.on('data', (chunk: Buffer) => {
          if (size < PROC_LIMIT) { chunks[name].push(Buffer.from(chunk)); size += chunk.length }
        })
      }
      const timer = setTimeout(() => { if (child.pid !== undefined) { try { this.kill(child.pid, 'SIGKILL') } catch { /* gone */ } } }, this.timeoutMs)
      timer.unref()
      child.once('error', error => { clearTimeout(timer); reject(error) })
      child.once('exit', code => {
        clearTimeout(timer)
        setImmediate(() => resolveCapture({ exitCode: code, stdout: Buffer.concat(chunks.stdout).toString('utf8'), stderr: Buffer.concat(chunks.stderr).toString('utf8') }))
      })
    })
  }

  async capture(command: string, args: string[]): Promise<{ exitCode: number | null; output: string }> {
    const child = await this.spawn(command, args, { cwd: this.config.home, env: this.config.childEnv, detached: true, stdio: ['ignore', 'pipe', 'pipe'], shell: false })
    return new Promise((resolveCapture, reject) => {
      const chunks: Buffer[] = []
      let size = 0
      for (const stream of [child.stdout, child.stderr]) {
        stream?.on('data', (chunk: Buffer) => {
          if (size < PROC_LIMIT) { chunks.push(Buffer.from(chunk)); size += chunk.length }
        })
      }
      const timer = setTimeout(() => { if (child.pid !== undefined) { try { this.kill(child.pid, 'SIGKILL') } catch { /* gone */ } } }, this.timeoutMs)
      timer.unref()
      child.once('error', error => { clearTimeout(timer); reject(error) })
      child.once('exit', code => {
        clearTimeout(timer)
        // Let the pipes drain before reading what they held.
        setImmediate(() => resolveCapture({ exitCode: code, output: Buffer.concat(chunks).toString('utf8') }))
      })
    })
  }
}

/** The last bytes of a log file, empty when it does not exist. */
export async function readLogTail(path: string): Promise<string> {
  let handle: FileHandle
  try {
    handle = await fs.open(path, constants.O_RDONLY)
  } catch {
    return ''
  }
  try {
    const { size } = await handle.stat()
    const length = Math.min(size, TAIL_BYTES)
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, size - length)
    return buffer.toString('utf8')
  } finally {
    await handle.close()
  }
}

/** The transient unit's name: `mdm-control-<hash of the run>-<n>`, unique per run through the run's record count. */
export function unitName(key: RunKey, n: number): string {
  return `mdm-control-${createHash('sha256').update(runKeyOf(key)).digest('hex').slice(0, 8)}-${n}`
}

/**
 * [L1] 2: `systemd-run --user --scope --collect --unit=... --working-directory=<home> --property=OOMPolicy=continue -- <argv>`, the child
 * of this server. `OOMPolicy=continue` keeps the scope, and the supervisor in it, alive when the kernel kills one of its checks for memory.
 */
export function systemdRunArgv(config: Pick<ControlsConfig, 'home'>, unit: string, argv: string[]): string[] {
  return ['--user', '--scope', '--collect', `--unit=${unit}`, `--working-directory=${config.home}`, '--property=OOMPolicy=continue', '--', ...argv]
}

export function userHome(env: NodeJS.ProcessEnv): string {
  return env.HOME || homedir()
}
