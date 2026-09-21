import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'

/** Removes the temporary roots created by playwright.config.ts, whatever the outcome of the run. */
export default async function globalTeardown() {
  const root = process.env.MD_MANAGER_TEST_ROOT
  // Only ever delete a directory this harness created inside the OS temp directory.
  if (root && root.startsWith(`${join(tmpdir(), 'md-manager-e2e-')}`) && !root.endsWith(sep)) {
    rmSync(root, { recursive: true, force: true })
  }
}
