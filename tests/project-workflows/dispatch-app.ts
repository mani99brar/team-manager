/**
 * The critique app of the Projects dispatch feature (policy `critique_app`): `npx --no-install tsx tests/project-workflows/dispatch-app.ts`
 * with `CRITIQUE_WEB_PORT` and `CRITIQUE_API_PORT` set. It builds a temporary root, seeds the same registry, runs, git
 * repositories and GitHub fixture as the candidate browser checks (`seedCandidate(..., { dispatch: true })`), with the GitHub
 * cache under the root, and starts the API and the web server. It exits non-zero unless `/api/dispatch/projects` lists every
 * seeded project and every fixture repository reads `status: 'read'` ([P6]), and every seeded project's run lists have
 * settled (each answers, read or failed, so no project is still loading when the critique opens the pages); it is ready at
 * `/api/dispatch/projects`. It prints
 * the Projects, project and Triage URLs. SIGTERM and SIGINT stop both children; the root is removed on exit.
 *
 * Untested in the viewer worktree (the dispatch routes live in the `server` lane): run by hand once the lanes have met.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PROJECT } from './fixtures.ts'
import { DISPATCH_PROJECTS } from './fixtures/dispatch.ts'
import { ROOT_PREFIX, SKILL_LOCATIONS } from './harness.ts'
import { seedCandidate } from './seed.ts'

const READY_TIMEOUT_MS = 120_000

const webPort = Number(process.env.CRITIQUE_WEB_PORT)
const apiPort = Number(process.env.CRITIQUE_API_PORT)
if (!Number.isInteger(webPort) || !Number.isInteger(apiPort) || webPort <= 0 || apiPort <= 0) {
  process.stderr.write('dispatch-app: set CRITIQUE_WEB_PORT and CRITIQUE_API_PORT.\n')
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
  const projectsConfig = seedCandidate(join(root, 'projects'), { dispatch: true })
  return {
    MD_MANAGER_CONFIG: join(root, 'sources.json'),
    MD_MANAGER_FIXTURE_ROOT: '',
    MD_MANAGER_API_PORT: String(apiPort),
    MD_MANAGER_WEB_PORT: String(webPort),
    WORKFLOW_VERIFICATION_PHASE: 'candidate',
    MD_MANAGER_PROJECTS_CONFIG: projectsConfig,
    MD_MANAGER_GITHUB_FIXTURE: join(root, 'projects', 'github-fixture.json'),
    MD_MANAGER_GITHUB_CACHE: join(root, 'projects', 'github-cache.json'),
    // The teams reader reads a folder under the test root, never the operator's ~/.claude.
    MD_MANAGER_CLAUDE_HOME: join(root, 'claude-home'),
  }
}

function launch(script: string, env: Record<string, string>) {
  const child = spawn('npm', ['run', script], { env: { ...process.env, ...env }, stdio: ['ignore', 'ignore', 'inherit'], detached: true })
  children.push(child)
  child.on('exit', code => { if (!stopping) { process.stderr.write(`dispatch-app: npm run ${script} exited with ${code}\n`); stop(1) } })
}

/** The overview lists every seeded project, and every GitHub-backed project reads `status: 'read'` ([P6]). */
async function dispatchReady(): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${webPort}/api/dispatch/projects`)
    if (!response.ok) return false
    const body = await response.json() as { projects?: { project_id: string; github: { status: string; repo: string | null } }[] }
    const projects = body.projects ?? []
    const ids = new Set(projects.map(project => project.project_id))
    for (const seeded of DISPATCH_PROJECTS) if (!ids.has(seeded.project_id)) return false
    return projects.filter(project => project.github.repo !== null).every(project => project.github.status === 'read')
  } catch {
    return false
  }
}

/** Every seeded project's run lists answer: a workflow list, then each workflow's runs (read, or failed as seeded), never pending. */
async function runListsSettled(): Promise<boolean> {
  try {
    for (const project of [...DISPATCH_PROJECTS, PROJECT]) {
      const base = `http://127.0.0.1:${webPort}/api/projects/${encodeURIComponent(project.project_id)}/workflows`
      const response = await fetch(base)
      if (!response.ok) continue
      const body = await response.json() as { workflows?: { workflow_id: string }[] }
      for (const workflow of body.workflows ?? []) {
        const runs = await fetch(`${base}/${encodeURIComponent(workflow.workflow_id)}/runs`)
        await runs.arrayBuffer()
        if (runs.status === 0) return false
      }
    }
    return true
  } catch {
    return false
  }
}

const apiEnv = prepareRoot()
launch('start:api', apiEnv)
launch('dev:web', { MD_MANAGER_API_PORT: String(apiPort), MD_MANAGER_WEB_PORT: String(webPort) })

const deadline = Date.now() + READY_TIMEOUT_MS
while (!(await dispatchReady()) || !(await runListsSettled())) {
  if (Date.now() > deadline) {
    process.stderr.write('dispatch-app: /api/dispatch/projects did not list every seeded project with its GitHub read; the server did not start or the dispatch routes are absent.\n')
    stop(1)
  }
  await new Promise(resolve => setTimeout(resolve, 500))
}

const web = `http://127.0.0.1:${webPort}`
process.stdout.write('The dispatch pages are ready.\n')
process.stdout.write(`Projects: ${web}/projects\n`)
process.stdout.write(`Triage:   ${web}/projects/-/triage\n`)
for (const project of [...DISPATCH_PROJECTS, PROJECT]) process.stdout.write(`${project.project_id}: ${web}/projects/${encodeURIComponent(project.project_id)}\n`)
setInterval(() => undefined, 1 << 30)
