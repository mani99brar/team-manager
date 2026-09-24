/**
 * The files a worker created or changed, as the trusted verifier captured them at freeze (PRD_VIEWER_CLARITY 4.1): every
 * changed text file within the caps is a `file` artifact carrying its repo-relative `path`; every other changed file is
 * listed in `files_not_captured` with the reason. Results recorded before capture carry neither. Pure helpers with no
 * React import, so pure modules and their unit tests can use them (React's types would stub the DOM in the test build).
 */
import type { WorkerResult } from './api.ts'

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
