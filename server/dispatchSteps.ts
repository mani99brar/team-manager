import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import { join } from 'node:path'
import { ProjectApiError, RunStore, compareRuns, redactPaths, type LoadedRun } from './projects.ts'
import { ID_PATTERN, type ProjectConfig } from './projectsConfig.ts'

/**
 * The per-run step digests for the dispatch step chart (PRD_PROJECTS_DISPATCH Appendix A `ProjectSteps`, decisions.md
 * [L2], design-challenge notes 2 and 3). `RunStore.listRuns` throws for the whole workflow when one run is invalid (only
 * the per-workflow route's `listRunEntries(scope, { collectErrors: true })` names such runs instead, without digests) and
 * does not export `runFingerprint`/`openDirectory`, so this module lists each `runs_root` itself (with `ID_PATTERN`),
 * calls `RunStore.loadRun` per directory, and caches each digest by a short directory fingerprint reimplemented from
 * `projects.ts:672`. Legacy (`plan.json` only) and just-launched (neither file) directories are skipped as `listRuns`
 * does; only runs that are actually invalid go into `errors`. Nothing here writes, fetches or changes `projects.ts`.
 */

/** A run's digest with `updated_at` kept for ordering; `updated_at` is stripped before the contract response is built. */
export type RunDigest = {
  run_id: string
  source_branch: string | null
  base_commit: string | null
  integrated_commit: string | null
  lanes: string[]
  steps: { node_id: string; label: string; kind: string; status: string; attempt: number }[]
  updated_at: string
}

export type WorkflowDigest = {
  workflow_id: string
  error: { code: string; message: string } | null
  runs: RunDigest[]
  errors: { run_id: string; code: string; message: string }[]
}

const FAST_FORWARD = /Fast-forwarded to ([0-9a-f]{7,40})/

/** The short directory fingerprint (reimplemented from `projects.ts:672`): every top-level file's name, size and mtime. */
async function runFingerprint(dir: string): Promise<string | null> {
  try {
    const entries = (await fs.readdir(dir, { withFileTypes: true })).filter(d => d.isFile()).map(d => d.name).sort()
    const hash = createHash('sha256')
    for (const name of entries) {
      try {
        const st = await fs.stat(join(dir, name))
        hash.update(`\0${name}:${st.size}:${st.mtimeMs}`)
      } catch { /* a file removed mid-read does not block the digest */ }
    }
    return hash.digest('hex')
  } catch {
    return null
  }
}

export function buildDigest(loaded: LoadedRun): RunDigest {
  const { detail } = loaded
  const snapByNode = new Map(detail.snapshot.nodes.map(node => [node.node_id, node]))
  // The projected definition inserts each fix-loop repair node with `kind: 'worker'`; lanes exclude them (note 3), steps keep them.
  const repairIds = new Set((loaded.fixLoop?.repairs ?? []).map(repair => repair.node_id))
  const steps = detail.definition.nodes.map(node => {
    const snap = snapByNode.get(node.node_id)
    return { node_id: node.node_id, label: node.label, kind: node.kind, status: snap?.status ?? 'pending', attempt: snap?.attempt ?? 0 }
  })
  const lanes = detail.definition.nodes.filter(node => node.kind === 'worker' && !repairIds.has(node.node_id)).map(node => node.node_id)
  let integrated_commit: string | null = null
  for (const event of loaded.events) {
    if (event.node_id === 'integrate' && event.status === 'succeeded') {
      const match = FAST_FORWARD.exec(event.message)
      if (match) integrated_commit = match[1]
    }
  }
  return {
    run_id: detail.summary.run_id,
    source_branch: loaded.inputs?.source_branch ?? null,
    base_commit: loaded.inputs?.base_commit ?? null,
    integrated_commit, lanes, steps, updated_at: detail.summary.updated_at,
  }
}

/** A run directory resolves to a digest, a cached error, or a skip (legacy / just-launched); errors and digests are cached by fingerprint ([S4]). */
type Resolved =
  | { type: 'digest'; digest: RunDigest }
  | { type: 'error'; error: { run_id: string; code: string; message: string } }
  | { type: 'skip' }

export class StepDigests {
  /** One cached result per run directory, keyed `<project>/<workflow>/<run>`, invalidated by the directory fingerprint. Caches errors too, so a corrupt run is read and warn-logged once per fingerprint ([S4]). */
  private readonly cache = new Map<string, { key: string; resolved: Resolved }>()
  /** In-flight loads per run key, so the un-awaited `warm` at boot and the first request do not both load the same run (design-challenge note 4). */
  private readonly inflight = new Map<string, Promise<Resolved>>()
  private readonly store: RunStore
  private readonly warn?: (message: string, details: Record<string, unknown>) => void

  constructor(store: RunStore, warn?: (message: string, details: Record<string, unknown>) => void) {
    this.store = store
    this.warn = warn
  }

  private async runDirs(runsRoot: string): Promise<string[]> {
    return (await fs.readdir(runsRoot, { withFileTypes: true }))
      .filter(entry => entry.isDirectory() && ID_PATTERN.test(entry.name)).map(entry => entry.name)
  }

  /**
   * Loads one run directory, caching the digest or the error by the directory fingerprint and deduping concurrent
   * loads of the same key. A newly computed error is warn-logged once; a cached error is reused silently ([S4]).
   * `ProjectApiError` messages pass through `redactPaths` so no absolute path reaches the response ([L8], [P8]).
   */
  private async resolve(scope: ReturnType<RunStore['scope']>, dir: string, key: string, name: string, logDetails: Record<string, unknown>): Promise<Resolved> {
    const fingerprint = await runFingerprint(dir)
    const cached = fingerprint === null ? undefined : this.cache.get(key)
    if (cached && cached.key === fingerprint) return cached.resolved
    const pending = this.inflight.get(key)
    if (pending) return pending
    const task = (async (): Promise<Resolved> => {
      try {
        return { type: 'digest', digest: buildDigest(await this.store.loadRun(scope, name)) }
      } catch (error) {
        const code = error instanceof ProjectApiError ? error.code : 'RUN_READ_FAILED'
        // Legacy (plan.json only) and just-launched (neither file) directories are not failures (note 2).
        if (code === 'RUN_UNSUPPORTED' || code === 'RUN_NOT_FOUND') return { type: 'skip' }
        this.warn?.('Run digest could not be read', { ...logDetails, run: name, code })
        const message = error instanceof ProjectApiError ? redactPaths(error.message) : 'The run could not be read.'
        return { type: 'error', error: { run_id: name, code, message } }
      }
    })()
    this.inflight.set(key, task)
    try {
      const resolved = await task
      if (fingerprint !== null && resolved.type !== 'skip') this.cache.set(key, { key: fingerprint, resolved })
      return resolved
    } finally {
      this.inflight.delete(key)
    }
  }

  async workflows(project: ProjectConfig): Promise<WorkflowDigest[]> {
    const result: WorkflowDigest[] = []
    for (const workflow of project.workflows) {
      const scope = this.store.scope(project.project_id, workflow.workflow_id)
      let names: string[]
      try {
        names = await this.runDirs(workflow.runs_root)
      } catch {
        result.push({ workflow_id: workflow.workflow_id, error: { code: 'RUNS_ROOT_UNAVAILABLE', message: redactPaths('The run storage for this workflow could not be listed.') }, runs: [], errors: [] })
        continue
      }
      const runs: RunDigest[] = []
      const errors: WorkflowDigest['errors'] = []
      const logDetails = { project_id: project.project_id, workflow_id: workflow.workflow_id }
      for (const name of names) {
        const dir = join(workflow.runs_root, name)
        const key = `${project.project_id}/${workflow.workflow_id}/${name}`
        const resolved = await this.resolve(scope, dir, key, name, logDetails)
        if (resolved.type === 'digest') runs.push(resolved.digest)
        else if (resolved.type === 'error') errors.push(resolved.error)
      }
      runs.sort(compareRuns)
      result.push({ workflow_id: workflow.workflow_id, error: null, runs: runs.slice(0, 50), errors })
    }
    return result
  }

  /** The project's run ids (every run directory) and landings (runs with an integrated commit), for the git state. */
  async facts(project: ProjectConfig): Promise<{ runIds: Set<string>; landings: { workflow_id: string; run_id: string; sha: string }[] }> {
    const runIds = new Set<string>()
    for (const workflow of project.workflows) {
      try {
        for (const name of await this.runDirs(workflow.runs_root)) runIds.add(name)
      } catch { /* an unreadable root contributes no run ids */ }
    }
    const landings: { workflow_id: string; run_id: string; sha: string }[] = []
    for (const workflow of await this.workflows(project)) {
      for (const run of workflow.runs) {
        if (run.integrated_commit) landings.push({ workflow_id: workflow.workflow_id, run_id: run.run_id, sha: run.integrated_commit })
      }
    }
    return { runIds, landings }
  }

  async warm(projects: readonly ProjectConfig[]): Promise<void> {
    for (const project of projects) {
      try {
        await this.workflows(project)
      } catch (error) {
        this.warn?.('Step digests could not be warmed for a project', { project_id: project.project_id, message: (error as Error).message })
      }
    }
  }
}
