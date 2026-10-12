import { defineConfig } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ROOT_PREFIX, SKILL_LOCATIONS, verificationPhase } from './harness.ts'
import { controlsEnvironment } from './fixtures/controls.ts'
import { seedCandidate } from './seed.ts'

/**
 * Dedicated configuration for the Projects viewer scenarios (`features/project-workflows/policy.json`).
 *
 * - Its own temporary root (skills fixtures for Pi/Claude and, in candidate mode, the seeded project
 *   registry and run directories) and its own dynamically chosen API/web ports, so it never touches live
 *   skills, live project storage or a developer's running servers. `global-teardown.ts` removes the root.
 * - `WORKFLOW_VERIFICATION_PHASE=worker` (default): the backend has no projects routes; specs mock only
 *   `/api/projects/**` with the explicit contract fixtures.
 * - `WORKFLOW_VERIFICATION_PHASE=candidate`: the real combined backend is started with the seeded registry;
 *   no project success responses are mocked.
 *
 * Playwright evaluates this module in the runner and again in every worker process; the root and ports are
 * prepared once and handed down through the environment.
 */
const phase = verificationPhase()

function freePort(): number {
  const script = "const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>{process.stdout.write(String(s.address().port));s.close()})"
  return Number(execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' }).trim())
}

function prepare(): { root: string; apiPort: number; webPort: number; projectsConfig: string | null } {
  const existing = process.env.MD_MANAGER_PROJECTS_TEST_ROOT
  if (existing) {
    return {
      root: existing,
      apiPort: Number(process.env.MD_MANAGER_API_PORT),
      webPort: Number(process.env.MD_MANAGER_WEB_PORT),
      projectsConfig: process.env.MD_MANAGER_PROJECTS_CONFIG || null,
    }
  }
  const root = mkdtempSync(join(tmpdir(), ROOT_PREFIX))
  const fixtures = fileURLToPath(new URL('../../fixtures/', import.meta.url))
  cpSync(join(fixtures, 'pi'), join(root, 'pi-personal'), { recursive: true })
  cpSync(join(fixtures, 'claude'), join(root, 'claude-personal'), { recursive: true })
  mkdirSync(join(root, 'pi-package', 'review'), { recursive: true })
  writeFileSync(join(root, 'pi-package', 'review', 'SKILL.md'), '# Package review skill\n\nInstalled by a package.\n')
  mkdirSync(join(root, 'claude-plugin', 'review'), { recursive: true })
  writeFileSync(join(root, 'claude-plugin', 'review', 'SKILL.md'), '# Plugin review skill\n\nInstalled by a plugin.\n')
  // pi-missing is configured but deliberately not created: an unavailable location, as in the root harness.
  const sources = { version: 1, locations: SKILL_LOCATIONS.map(({ id, source, label, directory, category }) => ({ id, source, label, path: join(root, directory), category })) }
  writeFileSync(join(root, 'sources.json'), `${JSON.stringify(sources, null, 2)}\n`)
  const projectsConfig = phase === 'candidate' ? seedCandidate(join(root, 'projects')) : null
  let apiPort = freePort()
  let webPort = freePort()
  while (webPort === apiPort) webPort = freePort()
  if (apiPort === webPort) apiPort = freePort()
  process.env.MD_MANAGER_PROJECTS_TEST_ROOT = root
  // The root skills helpers read this to locate the seeded location directories.
  process.env.MD_MANAGER_TEST_ROOT = root
  process.env.MD_MANAGER_CONFIG = join(root, 'sources.json')
  process.env.MD_MANAGER_API_PORT = String(apiPort)
  process.env.MD_MANAGER_WEB_PORT = String(webPort)
  process.env.WORKFLOW_VERIFICATION_PHASE = phase
  if (projectsConfig) process.env.MD_MANAGER_PROJECTS_CONFIG = projectsConfig
  else delete process.env.MD_MANAGER_PROJECTS_CONFIG
  return { root, apiPort, webPort, projectsConfig }
}

const { root, apiPort, webPort, projectsConfig } = prepare()
const baseURL = `http://127.0.0.1:${webPort}`

// Candidate phase: the API starts with the run controls on (decisions [L5]) and the fake controller; the worker phase has no
// controls backend, and controls.spec.ts mocks /api/run-controls/** there.
const controlsEnv: Record<string, string> = phase === 'candidate' ? controlsEnvironment(root, join(root, 'projects')) : {}
if (phase === 'candidate') process.env.MD_MANAGER_FAKE_CONTROLLER_LOG = controlsEnv.MD_MANAGER_FAKE_CONTROLLER_LOG

const apiEnv: Record<string, string> = {
  MD_MANAGER_CONFIG: join(root, 'sources.json'),
  MD_MANAGER_FIXTURE_ROOT: '',
  MD_MANAGER_API_PORT: String(apiPort),
  MD_MANAGER_WEB_PORT: String(webPort),
  WORKFLOW_VERIFICATION_PHASE: phase,
  // run-sessions: the candidate server reads the night-shift folder the sessions seed wrote under the test root.
  MD_MANAGER_NIGHT_SHIFT_DIR: join(root, 'projects', 'night-shift'),
  ...(projectsConfig ? { MD_MANAGER_PROJECTS_CONFIG: projectsConfig } : {}),
}

// Only controls.spec.ts sees the controls: every other spec reads pages without a Controls button (their allow-lists predate
// it), so the candidate phase runs a second API and web server with the controls on for that one spec.
function ports(): { apiPort: number; webPort: number } {
  if (process.env.MD_MANAGER_CONTROLS_API_PORT) return { apiPort: Number(process.env.MD_MANAGER_CONTROLS_API_PORT), webPort: Number(process.env.MD_MANAGER_CONTROLS_WEB_PORT) }
  const taken = new Set([apiPort, webPort])
  const next = () => { let port = freePort(); while (taken.has(port)) port = freePort(); taken.add(port); return port }
  const chosen = { apiPort: next(), webPort: next() }
  process.env.MD_MANAGER_CONTROLS_API_PORT = String(chosen.apiPort)
  process.env.MD_MANAGER_CONTROLS_WEB_PORT = String(chosen.webPort)
  return chosen
}
const controlsPorts = phase === 'candidate' ? ports() : null
const controlsURL = controlsPorts ? `http://127.0.0.1:${controlsPorts.webPort}` : baseURL

export default defineConfig({
  testDir: '.',
  testMatch: '**/*.spec.ts',
  globalTeardown: './global-teardown.ts',
  outputDir: process.env.MD_MANAGER_PROJECTS_OUTPUT ?? join(process.cwd(), 'test-results', 'project-workflows'),
  workers: 1,
  fullyParallel: false,
  retries: 0,
  use: {
    baseURL,
    browserName: 'chromium',
    reducedMotion: 'reduce',
    // The viewer shows times in the local zone (docs/PRD_VIEWER_UX.md 5.3): pin it so every clock the specs read is UTC.
    timezoneId: 'UTC',
    locale: 'en-GB',
  },
  projects: phase === 'candidate'
    ? [
      { name: 'pages', testIgnore: '**/controls.spec.ts' },
      { name: 'controls', testMatch: '**/controls.spec.ts', use: { baseURL: controlsURL } },
    ]
    : [{ name: 'all' }],
  webServer: [
    {
      command: 'npm run start:api',
      url: `http://127.0.0.1:${apiPort}/api/entries`,
      env: apiEnv,
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: 'npm run dev:web',
      url: baseURL,
      env: { MD_MANAGER_API_PORT: String(apiPort), MD_MANAGER_WEB_PORT: String(webPort) },
      reuseExistingServer: false,
      timeout: 30_000,
    },
    ...(controlsPorts ? [
      {
        command: 'npm run start:api',
        url: `http://127.0.0.1:${controlsPorts.apiPort}/api/entries`,
        env: { ...apiEnv, ...controlsEnv, MD_MANAGER_API_PORT: String(controlsPorts.apiPort), MD_MANAGER_WEB_PORT: String(controlsPorts.webPort) },
        reuseExistingServer: false,
        timeout: 30_000,
      },
      {
        command: 'npm run dev:web',
        url: controlsURL,
        env: { MD_MANAGER_API_PORT: String(controlsPorts.apiPort), MD_MANAGER_WEB_PORT: String(controlsPorts.webPort) },
        reuseExistingServer: false,
        timeout: 30_000,
      },
    ] : []),
  ],
})
