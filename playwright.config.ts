import { defineConfig } from '@playwright/test'
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Browser tests run against isolated temporary roots, never the repository fixtures or any live skill directory.
 * The root is created once, in the runner process, before the API web server starts; workers inherit its path
 * through the environment and reuse it. `tests/global-teardown.ts` removes it, and every spec removes the
 * scratch artifacts it adds. The generated config mirrors a realistic live layout: two Pi locations, one of
 * them a package, a missing project location, and two Claude locations, one of them a plugin.
 */
export const TEST_LOCATIONS = [
  { id: 'pi-personal', source: 'Pi', label: 'Personal skills', directory: 'pi-personal', category: 'personal' },
  { id: 'pi-package', source: 'Pi', label: 'Package: demo', directory: 'pi-package', category: 'package' },
  { id: 'pi-missing', source: 'Pi', label: 'Project: gone', directory: 'pi-missing', category: 'project' },
  { id: 'claude-personal', source: 'Claude', label: 'Personal and synced skills', directory: 'claude-personal', category: 'personal' },
  { id: 'claude-plugin', source: 'Claude', label: 'Plugin: design', directory: 'claude-plugin', category: 'plugin' },
] as const

function prepareTestRoot(): string {
  const existing = process.env.MD_MANAGER_TEST_ROOT
  if (existing) return existing
  const root = mkdtempSync(join(tmpdir(), 'md-manager-e2e-'))
  const fixtures = fileURLToPath(new URL('./fixtures/', import.meta.url))
  cpSync(join(fixtures, 'pi'), join(root, 'pi-personal'), { recursive: true })
  cpSync(join(fixtures, 'claude'), join(root, 'claude-personal'), { recursive: true })
  mkdirSync(join(root, 'pi-package', 'review'), { recursive: true })
  writeFileSync(join(root, 'pi-package', 'review', 'SKILL.md'), '# Package review skill\n\nInstalled by a package.\n')
  mkdirSync(join(root, 'claude-plugin', 'review'), { recursive: true })
  writeFileSync(join(root, 'claude-plugin', 'review', 'SKILL.md'), '# Plugin review skill\n\nInstalled by a plugin.\n')
  // pi-missing is configured but deliberately not created: an unavailable location.
  const config = {
    version: 1,
    locations: TEST_LOCATIONS.map(({ id, source, label, directory, category }) => ({ id, source, label, path: join(root, directory), category })),
  }
  writeFileSync(join(root, 'sources.json'), `${JSON.stringify(config, null, 2)}\n`)
  process.env.MD_MANAGER_TEST_ROOT = root
  process.env.MD_MANAGER_CONFIG = join(root, 'sources.json')
  return root
}

const testRoot = prepareTestRoot()
const preview = process.env.MD_MANAGER_TEST_PREVIEW === '1'
const baseURL = `http://127.0.0.1:${process.env.MD_MANAGER_WEB_PORT ?? (preview ? 4173 : 5173)}`

export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.spec.ts',
  globalTeardown: './tests/global-teardown.ts',
  // Browser tests mutate (and then clean) the shared temporary roots, so they must never run concurrently.
  workers: 1,
  fullyParallel: false,
  use: {
    baseURL,
    browserName: 'chromium',
    // Reduced motion makes the force layout settle synchronously, so nothing waits on animation.
    reducedMotion: 'reduce',
  },
  webServer: [
    {
      command: 'npm run start:api',
      url: `http://127.0.0.1:${process.env.MD_MANAGER_API_PORT ?? 3001}/api/entries`,
      env: { MD_MANAGER_CONFIG: join(testRoot, 'sources.json'), MD_MANAGER_FIXTURE_ROOT: '' },
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: preview ? 'npm run preview' : 'npm run dev:web',
      url: baseURL,
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
})
