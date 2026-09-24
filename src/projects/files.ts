/**
 * The files a worker created or changed, as the trusted verifier captured them at freeze (PRD_VIEWER_CLARITY 4.1): every
 * changed text file within the caps is a `file` artifact carrying its repo-relative `path`; every other changed file is
 * listed in `files_not_captured` with the reason. Results recorded before capture carry neither. The pure helpers live in
 * capture.ts; this module adds the hook, kept out of the component files so those only export components.
 */
import { useCallback } from 'react'
import { fetchWorkerResult, scopedResultPath, type RunDetail, type RunScope } from './api.ts'
import { capturedFiles } from './capture.ts'
import { useResource } from './useResource.ts'

export * from './capture.ts'

type SnapshotNode = RunDetail['snapshot']['nodes'][number]

/**
 * Every captured file of a run, by path, with the launch node that shows it. Read from the launch nodes' own served worker
 * results through the run's scoped results route; nothing is inferred for a lane whose result is absent or failed to load.
 */
export function useRunCapturedFiles(scope: RunScope, snapshotNodes: SnapshotNode[], refreshToken: number): Map<string, string> {
  const launches = snapshotNodes.flatMap(node => {
    if (node.kind !== 'worker' || node.result_uri === null) return []
    const path = scopedResultPath(scope, node.result_uri)
    return path === null ? [] : [{ nodeId: node.node_id, path }]
  })
  // The launches are serialised into the resource key, so the loader only changes when the linked results do.
  const spec = JSON.stringify(launches)
  const load = useCallback(async (signal: AbortSignal) => {
    const list = JSON.parse(spec) as typeof launches
    const settled = await Promise.allSettled(list.map(async launch => ({ nodeId: launch.nodeId, result: await fetchWorkerResult(scope, launch.path, signal) })))
    const byPath = new Map<string, string>()
    for (const entry of settled) {
      if (entry.status !== 'fulfilled') continue
      for (const file of capturedFiles(entry.value.result)) if (!byPath.has(file.path)) byPath.set(file.path, entry.value.nodeId)
    }
    return byPath
  }, [scope, spec])
  const key = launches.length === 0 ? null : `captured:${spec}`
  const { state } = useResource(key, load, refreshToken)
  return state.status === 'ready' ? state.data : EMPTY
}

const EMPTY: Map<string, string> = new Map()
