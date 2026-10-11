import { createHash, timingSafeEqual } from 'node:crypto'
import { constants } from 'node:fs'
import fs from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import type { FastifyRequest } from 'fastify'

/**
 * The browser's side of the run controls (docs/PRD_RUN_CONTROLS.md 5.1 and 5.2, decisions.md [L5]): the startup environment that
 * turns them on, and the header guards every POST passes before anything else happens. The pairing token is read once, compared
 * in constant time and never logged, returned or written anywhere.
 */
export const CONTROLS_PREFIX = '/api/run-controls'
export const TOKEN_HEADER = 'x-mdm-control-token'
export const MIN_TOKEN_LENGTH = 32

export class ControlsError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

export type SpawnMode = 'systemd' | 'direct'

export type ControlsConfig = {
  enabled: true
  /** Absolute executable that runs `-m workflow` (`MD_MANAGER_WORKFLOW_PYTHON`). */
  python: string
  /** Absolute directory the commands run from (`MD_MANAGER_WORKFLOW_HOME`). */
  home: string
  token: Buffer
  /** Where records and logs go; never inside a run directory. */
  stateDir: string
  /** Allowed `host:port` values for the Host header: loopback on the web port and the API port ([L7]). */
  allowedHosts: ReadonlySet<string>
  /** Allowed `host:port` values for the Origin: loopback on the web port only ([L7] 2). */
  allowedOrigins: ReadonlySet<string>
  spawnMode: SpawnMode
  /** The `/proc` root the lock probe reads; `overridden` marks a fake tree (tests, the critique app), where `pause` never signals. */
  procRoot: string
  procOverridden: boolean
  /** `HERDR_ENV=1` in the server's own environment ([L2]); never taken from a request. */
  herdr: boolean
  /** The environment children get: the server's minus `CLAUDECODE`. */
  childEnv: NodeJS.ProcessEnv
}

export type ControlsSetup = { enabled: false; warnings: string[] } | (ControlsConfig & { warnings: string[] })

function disabled(...warnings: string[]): ControlsSetup {
  return { enabled: false, warnings }
}

const DEFAULT_API_PORT = '3001'
const DEFAULT_WEB_PORT = '5173'

/**
 * Reads the A.3 environment. Controls stay off, with a warning naming the failed condition ([L5] 1), unless: `MD_MANAGER_RUN_CONTROLS=on`;
 * the Python is an absolute path that passes `X_OK`; the workflow home is an absolute directory; the token file is a regular file
 * with `(mode & 0o077) === 0` holding at least 32 characters. Unset or any other `MD_MANAGER_RUN_CONTROLS` is off without a warning.
 */
export async function loadControlsConfig(env: NodeJS.ProcessEnv): Promise<ControlsSetup> {
  if (env.MD_MANAGER_RUN_CONTROLS !== 'on') return disabled()
  const python = env.MD_MANAGER_WORKFLOW_PYTHON
  if (!python || !isAbsolute(python)) return disabled('Run controls are off: MD_MANAGER_WORKFLOW_PYTHON must be an absolute path.')
  try {
    const stat = await fs.stat(python)
    if (!stat.isFile()) return disabled('Run controls are off: MD_MANAGER_WORKFLOW_PYTHON is not a file.')
    await fs.access(python, constants.X_OK)
  } catch {
    return disabled('Run controls are off: MD_MANAGER_WORKFLOW_PYTHON is not an executable file.')
  }
  const home = env.MD_MANAGER_WORKFLOW_HOME
  if (!home || !isAbsolute(home)) return disabled('Run controls are off: MD_MANAGER_WORKFLOW_HOME must be an absolute directory.')
  try {
    if (!(await fs.stat(home)).isDirectory()) return disabled('Run controls are off: MD_MANAGER_WORKFLOW_HOME is not a directory.')
  } catch {
    return disabled('Run controls are off: MD_MANAGER_WORKFLOW_HOME does not exist.')
  }
  const userHome = env.HOME || homedir()
  const tokenFile = env.MD_MANAGER_CONTROLS_TOKEN_FILE || join(userHome, '.config', 'md-manager', 'controls.token')
  let token: string
  try {
    const handle = await fs.open(tokenFile, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const stat = await handle.stat()
      if (!stat.isFile()) return disabled('Run controls are off: the pairing token file is not a regular file.')
      if ((stat.mode & 0o077) !== 0) return disabled('Run controls are off: the pairing token file must not be readable by group or others (chmod 600).')
      token = (await handle.readFile({ encoding: 'utf8' })).trim()
    } finally {
      await handle.close()
    }
  } catch {
    return disabled('Run controls are off: the pairing token file cannot be read.')
  }
  if (token.length < MIN_TOKEN_LENGTH) return disabled(`Run controls are off: the pairing token must be at least ${MIN_TOKEN_LENGTH} characters.`)
  const stateDir = env.MD_MANAGER_CONTROLS_STATE || join(userHome, '.local', 'state', 'md-manager', 'controls')
  if (!isAbsolute(stateDir)) return disabled('Run controls are off: MD_MANAGER_CONTROLS_STATE must be an absolute directory.')
  const web = env.MD_MANAGER_WEB_PORT || DEFAULT_WEB_PORT
  const api = env.MD_MANAGER_API_PORT || DEFAULT_API_PORT
  // [L7]: the Vite proxy (string shorthand) sets changeOrigin, so the API sees its own port as Host while Origin and
  // Sec-Fetch-Site stay the browser's web-port values. Host: loopback on the web or API port; Origin: loopback on the web port. No header is lost.
  const allowedOrigins = new Set([`127.0.0.1:${web}`, `localhost:${web}`])
  const allowedHosts = new Set([...allowedOrigins, `127.0.0.1:${api}`, `localhost:${api}`])
  const warnings = (env.MD_MANAGER_CONTROLS_HOSTS ?? '').trim() ? ['MD_MANAGER_CONTROLS_HOSTS is ignored: run controls accept 127.0.0.1 and localhost only (Host on the web or API port, Origin on the web port).'] : []
  const { CLAUDECODE: _dropped, ...childEnv } = env
  void _dropped
  return {
    enabled: true, python, home: resolve(home), token: Buffer.from(token, 'utf8'), stateDir: resolve(stateDir), allowedHosts, allowedOrigins,
    spawnMode: env.MD_MANAGER_CONTROLS_SPAWN === 'direct' ? 'direct' : 'systemd',
    procRoot: env.MD_MANAGER_CONTROLS_PROC || '/proc', procOverridden: Boolean(env.MD_MANAGER_CONTROLS_PROC),
    herdr: env.HERDR_ENV === '1', childEnv, warnings,
  }
}

function digest(value: Buffer | string): Buffer {
  return createHash('sha256').update(value).digest()
}

/** Constant-time comparison: both sides are hashed to the same length first, so neither length nor content leaks through timing. */
export function tokenMatches(config: Pick<ControlsConfig, 'token'>, supplied: unknown): boolean {
  if (typeof supplied !== 'string' || supplied.length === 0) return false
  return timingSafeEqual(digest(supplied), digest(config.token))
}

export function isPaired(config: Pick<ControlsConfig, 'token'>, request: FastifyRequest): boolean {
  return tokenMatches(config, request.headers[TOKEN_HEADER])
}

/** Guard 4: the pairing token. A missing header and a wrong one are told apart so the page knows to ask again. */
export function requireToken(config: Pick<ControlsConfig, 'token'>, request: FastifyRequest): void {
  const supplied = request.headers[TOKEN_HEADER]
  if (supplied === undefined || supplied === '') throw new ControlsError(403, 'TOKEN_REQUIRED', 'Pair this browser with the run-controls token first.')
  if (!tokenMatches(config, supplied)) throw new ControlsError(403, 'TOKEN_INVALID', 'The pairing token is not accepted. Paste the current token again.')
}

/** Guards 1 to 3 of PRD 5.2: JSON content type, an allowed Host (DNS rebinding), a same-origin Origin and Fetch Metadata. */
export function requireBrowserGuards(config: Pick<ControlsConfig, 'allowedHosts' | 'allowedOrigins'>, request: FastifyRequest): void {
  const type = request.headers['content-type']
  if (typeof type !== 'string' || !/^application\/json\s*(;|$)/i.test(type)) {
    throw new ControlsError(415, 'UNSUPPORTED_MEDIA_TYPE', 'The request body must be application/json.')
  }
  const host = request.headers.host
  if (typeof host !== 'string' || !config.allowedHosts.has(host.toLowerCase())) throw new ControlsError(403, 'FORBIDDEN_ORIGIN', 'This host is not allowed to use run controls.')
  const origin = request.headers.origin
  if (typeof origin !== 'string' || !origin.toLowerCase().startsWith('http://') || !config.allowedOrigins.has(origin.slice('http://'.length).toLowerCase())) {
    throw new ControlsError(403, 'FORBIDDEN_ORIGIN', 'Run controls accept requests from the viewer page only.')
  }
  const site = request.headers['sec-fetch-site']
  if (site !== undefined && site !== 'same-origin') throw new ControlsError(403, 'FORBIDDEN_ORIGIN', 'Run controls accept same-origin requests only.')
}
