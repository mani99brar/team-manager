import { defineConfig } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ROOT_PREFIX, SKILL_LOCATIONS, verificationPhase } from './harness.ts'
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

const apiEnv: Record<string, string> = {
  MD_MANAGER_CONFIG: join(root, 'sources.json'),
  MD_MANAGER_FIXTURE_ROOT: '',
  MD_MANAGER_API_PORT: String(apiPort),
  MD_MANAGER_WEB_PORT: String(webPort),
  WORKFLOW_VERIFICATION_PHASE: phase,
  ...(projectsConfig ? { MD_MANAGER_PROJECTS_CONFIG: projectsConfig } : {}),
}

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
  },
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
  ],
})
