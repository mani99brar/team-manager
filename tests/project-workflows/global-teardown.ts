import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { ROOT_PREFIX } from './harness.ts'

/** Removes the temporary root created by this suite's playwright.config.ts, whatever the outcome. */
export default async function globalTeardown() {
  const root = process.env.MD_MANAGER_PROJECTS_TEST_ROOT
  // Only ever delete a directory this harness created inside the OS temp directory.
  if (root && root.startsWith(join(tmpdir(), ROOT_PREFIX)) && !root.endsWith(sep)) {
    rmSync(root, { recursive: true, force: true })
  }
}
