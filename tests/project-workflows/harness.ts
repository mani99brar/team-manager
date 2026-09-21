/**
 * Shared knowledge between the suite's Playwright config, teardown and specs: the verification phase,
 * the temporary root layout and the port variables. Kept free of side effects so importing it is safe in
 * every Playwright process (the config module is evaluated in the runner and in each worker).
 */
export const ROOT_PREFIX = 'md-manager-projects-e2e-'

export type Phase = 'worker' | 'candidate'

/** `worker`: no projects backend, mock only /api/projects/**. `candidate`: real combined backend, no success mocks. */
export function verificationPhase(env: NodeJS.ProcessEnv = process.env): Phase {
  const value = env.WORKFLOW_VERIFICATION_PHASE
  if (value === 'candidate') return 'candidate'
  if (value === 'worker' || value === undefined || value === '') return 'worker'
  throw new Error(`Unsupported WORKFLOW_VERIFICATION_PHASE "${value}": expected "worker" or "candidate".`)
}

/** Skills fixture locations mirrored from the root harness so the existing Pi/Claude helpers keep working. */
export const SKILL_LOCATIONS = [
  { id: 'pi-personal', source: 'Pi', label: 'Personal skills', directory: 'pi-personal', category: 'personal' },
  { id: 'pi-package', source: 'Pi', label: 'Package: demo', directory: 'pi-package', category: 'package' },
  { id: 'pi-missing', source: 'Pi', label: 'Project: gone', directory: 'pi-missing', category: 'project' },
  { id: 'claude-personal', source: 'Claude', label: 'Personal and synced skills', directory: 'claude-personal', category: 'personal' },
  { id: 'claude-plugin', source: 'Claude', label: 'Plugin: design', directory: 'claude-plugin', category: 'plugin' },
] as const
