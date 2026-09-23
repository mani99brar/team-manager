/**
 * The files a worker created or changed, as the trusted verifier captured them at freeze (PRD_VIEWER_CLARITY 4.1): every
 * changed text file within the caps is a `file` artifact carrying its repo-relative `path`; every other changed file is
 * listed in `files_not_captured` with the reason. Results recorded before capture carry neither. Pure helpers and one
 * hook, kept out of the component files so those only export components.
 */
import { useCallback } from 'react'
import { fetchWorkerResult, scopedResultPath, type RunDetail, type RunScope, type WorkerResult } from './api.ts'
import { useResource } from './useResource.ts'

type SnapshotNode = RunDetail['snapshot']['nodes'][number]
type Artifact = WorkerResult['artifacts'][number]
export type CapturedFile = Artifact & { kind: 'file'; path: string }
export type NotCapturedFile = NonNullable<WorkerResult['files_not_captured']>[number]

export const NOT_CAPTURED_WORDING: Record<NotCapturedFile['reason'], string> = {
  binary: 'binary file, not captured',
  too_large: 'too large to capture (over the per-file size cap)',
  missing: 'deleted or renamed away in the snapshot, nothing to capture',
  budget: "not captured: the packet's capture budget was already spent",
}

export function capturedFiles(result: WorkerResult): CapturedFile[] {
  return result.artifacts.filter((artifact): artifact is CapturedFile => artifact.kind === 'file' && typeof artifact.path === 'string')
}

export function notCapturedFiles(result: WorkerResult): NotCapturedFile[] {
  return result.files_not_captured ?? []
}

/** Whether the result records file capture at all; a result without either list predates it. */
export function recordsCapture(result: WorkerResult): boolean {
  return capturedFiles(result).length > 0 || result.files_not_captured !== undefined
}

export function isMarkdownPath(path: string): boolean {
  return /\.md$/i.test(path)
}

/** The element id of a captured file's panel on the launch node, the target of a finding's file link. */
export function fileAnchorId(path: string): string {
  return `file-${path.replace(/[^A-Za-z0-9_-]/g, '_')}`
}

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
