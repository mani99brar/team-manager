/**
 * The critique app of run-sessions ([G8], docs/PRD_RUN_SESSIONS.md): `npx --no-install tsx tests/project-workflows/sessions-app.ts`
 * with `CRITIQUE_WEB_PORT` and `CRITIQUE_API_PORT` set. It builds a temporary root, seeds the same runs as the candidate phase
 * of the browser checks and the skills fixtures, and starts the API (with `MD_MANAGER_NIGHT_SHIFT_DIR` pointing at the same
 * night-shift folder the sessions seed wrote, as `playwright.config.ts` does) and the web server. It prints the sessions run
 * page URL and exits non-zero unless `/api/projects` answers (the critique reviewer's `ready_path`), so the sessions run page
 * shows "2 panel decisions: 1 executed, 1 held" ([L3]). SIGTERM and SIGINT stop both children; the root is removed.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PROJECT, UNEXPOSED_PROJECT } from './fixtures.ts'
import { RUN_SESSIONS, RUN_SESSIONS_HIDDEN, UX_SESSIONS_HIDDEN_WORKFLOW_ID, UX_SESSIONS_WORKFLOW_ID } from './fixtures/sessions.ts'
import { ROOT_PREFIX, SKILL_LOCATIONS } from './harness.ts'
import { seedCandidate } from './seed.ts'

const READY_TIMEOUT_MS = 90_000

const webPort = Number(process.env.CRITIQUE_WEB_PORT)
const apiPort = Number(process.env.CRITIQUE_API_PORT)
if (!Number.isInteger(webPort) || !Number.isInteger(apiPort) || webPort <= 0 || apiPort <= 0) {
  process.stderr.write('sessions-app: set CRITIQUE_WEB_PORT and CRITIQUE_API_PORT.\n')
  process.exit(2)
}

const root = mkdtempSync(join(tmpdir(), ROOT_PREFIX))
const children: ChildProcess[] = []
let stopping = false

function stop(code: number): never {
  stopping = true
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
    // The sessions seed wrote the night-shift records here, as playwright.config.ts points the browser server.
    MD_MANAGER_NIGHT_SHIFT_DIR: join(root, 'projects', 'night-shift'),
    // The teams reader reads a folder under the test root, never the operator's ~/.claude.
    MD_MANAGER_CLAUDE_HOME: join(root, 'claude-home'),
  }
}

function launch(script: string, env: Record<string, string>) {
  const child = spawn('npm', ['run', script], { env: { ...process.env, ...env }, stdio: ['ignore', 'ignore', 'inherit'], detached: true })
  children.push(child)
  child.on('exit', code => { if (!stopping) { process.stderr.write(`sessions-app: npm run ${script} exited with ${code}\n`); stop(1) } })
}

async function projectsReady(): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${webPort}/api/projects`)
    return response.ok
  } catch {
    return false
  }
}

const apiEnv = prepareRoot()
launch('start:api', apiEnv)
launch('dev:web', { MD_MANAGER_API_PORT: String(apiPort), MD_MANAGER_WEB_PORT: String(webPort) })

const deadline = Date.now() + READY_TIMEOUT_MS
while (!(await projectsReady())) {
  if (Date.now() > deadline) {
    process.stderr.write('sessions-app: /api/projects did not answer; the server did not start.\n')
    stop(1)
  }
  await new Promise(resolve => setTimeout(resolve, 500))
}

const base = `http://127.0.0.1:${webPort}/projects/${encodeURIComponent(PROJECT.project_id)}/workflows/${UX_SESSIONS_WORKFLOW_ID}/runs`
process.stdout.write('The sessions run is ready; its run page shows "2 panel decisions: 1 executed, 1 held".\n')
process.stdout.write(`${RUN_SESSIONS}: ${base}/${RUN_SESSIONS}\n`)
// The same run under the project that does not expose its run directory: the bare resume form.
process.stdout.write(`${RUN_SESSIONS_HIDDEN}: http://127.0.0.1:${webPort}/projects/${encodeURIComponent(UNEXPOSED_PROJECT.project_id)}/workflows/${UX_SESSIONS_HIDDEN_WORKFLOW_ID}/runs/${RUN_SESSIONS_HIDDEN}\n`)
setInterval(() => undefined, 1 << 30)
