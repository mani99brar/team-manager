/**
 * The critique app of the run-controls feature (policy `critique_app`): `npx --no-install tsx tests/project-workflows/controls-app.ts`
 * with `CRITIQUE_WEB_PORT` and `CRITIQUE_API_PORT` set. It builds a temporary root, seeds the same runs as the candidate phase
 * of the browser checks and the skills fixtures, writes the pairing token file (mode 0600, token below) and starts the API
 * and the web server with the controls on and the fake controller. It prints the run page URLs and the token to stdout and
 * exits non-zero unless `/api/run-controls/status` answers `enabled: true` through the web port (decisions [L5] 3), so the
 * critique reviewer's `ready_path` means the controls are on. SIGTERM and SIGINT stop both children; the root is removed.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CONTROLS_RUNS, CONTROLS_WORKFLOW_ID, controlsEnvironment } from './fixtures/controls.ts'
import { PROJECT } from './fixtures.ts'
import { ROOT_PREFIX, SKILL_LOCATIONS } from './harness.ts'
import { seedCandidate } from './seed.ts'

/** The token the critique reviewer pastes into "Pair this browser". */
export const CRITIQUE_TOKEN = 'critique-pairing-token-0000000000000000'
const READY_TIMEOUT_MS = 90_000

const webPort = Number(process.env.CRITIQUE_WEB_PORT)
const apiPort = Number(process.env.CRITIQUE_API_PORT)
if (!Number.isInteger(webPort) || !Number.isInteger(apiPort) || webPort <= 0 || apiPort <= 0) {
  process.stderr.write('controls-app: set CRITIQUE_WEB_PORT and CRITIQUE_API_PORT.\n')
  process.exit(2)
}

const root = mkdtempSync(join(tmpdir(), ROOT_PREFIX))
const children: ChildProcess[] = []
let stopping = false

function stop(code: number): never {
  stopping = true
  // Each child leads its own process group, so `npm` and the server it started both stop.
  for (const child of children) if (child.exitCode === null && child.pid !== undefined) { try { process.kill(-child.pid, 'SIGTERM') } catch { child.kill('SIGTERM') } }
  rmSync(root, { recursive: true, force: true })
  process.exit(code)
}
process.on('SIGTERM', () => stop(0))
process.on('SIGINT', () => stop(0))

function prepareRoot(): Record<string, string> {
  const fixtures = fileURLToPath(new URL('../../fixtures/', import.meta.url))
  cpSync(join(fixtures, 'pi'), join(root, 'pi-personal'), { recursive: true })
  cpSync(join(fixtures, 'claude'), join(root, 'claude-personal'), { recursive: true })
  mkdirSync(join(root, 'pi-package', 'review'), { recursive: true })
  writeFileSync(join(root, 'pi-package', 'review', 'SKILL.md'), '# Package review skill\n\nInstalled by a package.\n')
  mkdirSync(join(root, 'claude-plugin', 'review'), { recursive: true })
  writeFileSync(join(root, 'claude-plugin', 'review', 'SKILL.md'), '# Plugin review skill\n\nInstalled by a plugin.\n')
  const sources = { version: 1, locations: SKILL_LOCATIONS.map(({ id, source, label, directory, category }) => ({ id, source, label, path: join(root, directory), category })) }
  writeFileSync(join(root, 'sources.json'), `${JSON.stringify(sources, null, 2)}\n`)
  const projectsConfig = seedCandidate(join(root, 'projects'))
  return {
    MD_MANAGER_CONFIG: join(root, 'sources.json'),
    MD_MANAGER_FIXTURE_ROOT: '',
    MD_MANAGER_API_PORT: String(apiPort),
    MD_MANAGER_WEB_PORT: String(webPort),
    WORKFLOW_VERIFICATION_PHASE: 'candidate',
    MD_MANAGER_PROJECTS_CONFIG: projectsConfig,
    // The teams reader reads a folder under the test root, never the operator's ~/.claude.
    MD_MANAGER_CLAUDE_HOME: join(root, 'claude-home'),
    ...controlsEnvironment(root, join(root, 'projects'), CRITIQUE_TOKEN),
  }
}

function launch(script: string, env: Record<string, string>) {
  const child = spawn('npm', ['run', script], { env: { ...process.env, ...env }, stdio: ['ignore', 'ignore', 'inherit'], detached: true })
  children.push(child)
  child.on('exit', code => { if (!stopping) { process.stderr.write(`controls-app: npm run ${script} exited with ${code}\n`); stop(1) } })
}

async function controlsOn(): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${webPort}/api/run-controls/status`)
    return response.ok && (await response.json() as { enabled?: boolean }).enabled === true
  } catch {
    return false
  }
}

const apiEnv = prepareRoot()
launch('start:api', apiEnv)
launch('dev:web', { MD_MANAGER_API_PORT: String(apiPort), MD_MANAGER_WEB_PORT: String(webPort) })

const deadline = Date.now() + READY_TIMEOUT_MS
while (!(await controlsOn())) {
  if (Date.now() > deadline) {
    process.stderr.write('controls-app: /api/run-controls/status did not answer enabled: true; the controls are off or the servers did not start.\n')
    stop(1)
  }
  await new Promise(resolve => setTimeout(resolve, 500))
}

const base = `http://127.0.0.1:${webPort}/projects/${encodeURIComponent(PROJECT.project_id)}/workflows/${CONTROLS_WORKFLOW_ID}/runs`
process.stdout.write(`Run controls are on. Pairing token: ${CRITIQUE_TOKEN}\n`)
for (const runId of CONTROLS_RUNS) process.stdout.write(`${runId}: ${base}/${runId}\n`)
setInterval(() => undefined, 1 << 30)
