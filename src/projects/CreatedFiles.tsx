import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { Markdown } from '../document/Markdown.tsx'
import {
  fetchArtifactText,
  fetchReviewResult,
  NOT_RECORDED,
  orNotRecorded,
  paths,
  scopedReviewPath,
  type ReviewFinding,
  type RunDetail,
  type RunScope,
  type WorkerResult,
} from './api.ts'
import { capturedFiles, fileAnchorId, isMarkdownPath, NOT_CAPTURED_WORDING, notCapturedFiles, recordsCapture, type CapturedFile } from './files.ts'
import { findingsForFile, linesNamed } from './findings.ts'
import { ErrorPanel, LoadingPanel } from './panels.tsx'
import { keepInView } from './scroll.ts'
import { useResource, type Resource } from './useResource.ts'

type SnapshotNode = RunDetail['snapshot']['nodes'][number]
type Range = [number, number]

type Props = {
  scope: RunScope
  result: WorkerResult
  /** The run's review node, whose recorded findings are shown on the files they name; null when the graph has none. */
  reviewNode: SnapshotNode | null
  refreshToken: number
  /** A captured file to scroll to, handed over by a review finding's file link; null otherwise. */
  focusPath: string | null
  onFocusApplied: () => void
}

/** The review a finding list comes from, the same way the review node finds it; null when none is recorded. */
function reviewPathOf(scope: RunScope, node: SnapshotNode | null): string | null {
  if (node === null) return null
  if (node.result_uri !== null) return scopedReviewPath(scope, node.result_uri)
  return node.status === 'pending' ? null : paths.review(scope, Math.max(node.attempt, 1))
}

function rangeText([from, to]: Range): string {
  return from === to ? `line ${from}` : `lines ${from}–${to}`
}

/** The review findings that name this file: severity, reviewer, disposition and message, and a control to mark the lines a finding names. */
function FileFindings({ findings, path, onShowLines }: { findings: Resource<ReviewFinding[] | null>; path: string; onShowLines: (ranges: Range[]) => void }) {
  if (findings.status === 'idle') return <p className="projects-muted" data-testid="file-findings-no-review">No review is recorded for this run, so no findings are shown on its files.</p>
  if (findings.status === 'loading') return <LoadingPanel>Loading the review findings…</LoadingPanel>
  if (findings.status === 'error') return <p className="projects-error-inline" role="alert">The recorded review could not be loaded, so findings on this file are not shown.</p>
  if (findings.data === null) return <p className="projects-muted" data-testid="file-findings-no-review">No review is recorded for this run, so no findings are shown on its files.</p>
  const named = findingsForFile(findings.data, path)
  if (named.length === 0) return <p className="projects-muted" data-testid="file-findings-none">No review finding names this file.</p>
  return (
    <ul className="evidence-list" data-testid="file-findings">
      {named.map((finding, index) => {
        const ranges = linesNamed(finding.message, path)
        return (
          <li key={index} data-testid="file-finding" data-severity={finding.severity} data-reviewer={finding.reviewer} data-disposition={finding.disposition}>
            <span className="finding-severity">{finding.severity}</span>
            {' '}· <span data-testid="file-finding-reviewer">{finding.reviewer}</span> · {finding.disposition} — {finding.message}
            {ranges.length > 0 && (
              <>
                {' '}
                <button type="button" className="button button-small" data-testid="show-lines" onClick={() => onShowLines(ranges)}>
                  Show {ranges.map(rangeText).join(', ')}
                </button>
              </>
            )}
          </li>
        )
      })}
    </ul>
  )
}

/** The exact file content, one element per line; lines a finding names are marked. */
function FileSource({ text, marked, preRef }: { text: string; marked: Range[]; preRef: RefObject<HTMLPreElement | null> }) {
  const lines = text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n')
  const isMarked = (line: number) => marked.some(([from, to]) => line >= from && line <= to)
  return (
    <pre className="artifact-log" data-testid="file-source" tabIndex={0} ref={preRef}>
      {lines.map((line, index) => {
        const number = index + 1
        return isMarked(number)
          ? <mark key={number} data-line={number} data-finding-line="true">{line}{'\n'}</mark>
          : <span key={number} data-line={number}>{line}{'\n'}</span>
      })}
    </pre>
  )
}

/**
 * One captured file: the findings that name it, then its content. Markdown is rendered inline with a Source view; any other
 * text is shown as source on demand. "Show lines" switches to the source, the only view where line numbers mean anything.
 */
function CapturedFilePanel({ scope, file, findings, focused }: { scope: RunScope; file: CapturedFile; findings: Resource<ReviewFinding[] | null>; focused: boolean }) {
  const markdown = isMarkdownPath(file.path)
  const [view, setView] = useState<'rendered' | 'source' | 'closed'>(markdown ? 'rendered' : 'closed')
  const [marked, setMarked] = useState<Range[]>([])
  const [scrollRequest, setScrollRequest] = useState(0)
  const preRef = useRef<HTMLPreElement>(null)
  const panelRef = useRef<HTMLElement>(null)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const load = useCallback((signal: AbortSignal) => fetchArtifactText(scope, file.artifact_id, signal), [scope, file.artifact_id])
  const { state, reload } = useResource(view === 'closed' ? null : `file:${file.artifact_id}`, load)

  useEffect(() => {
    if (!focused || !headingRef.current) return
    panelRef.current?.focus({ preventScroll: true })
    return keepInView(headingRef.current, { block: 'start' })
  }, [focused])
  useEffect(() => {
    if (scrollRequest === 0 || state.status !== 'ready') return
    preRef.current?.querySelector('[data-finding-line]')?.scrollIntoView({ block: 'center' })
  }, [scrollRequest, state.status])

  const showLines = (ranges: Range[]) => {
    setMarked(ranges)
    setView('source')
    setScrollRequest(previous => previous + 1)
  }
  const headingId = `${fileAnchorId(file.path)}-title`
  return (
    <section
      ref={panelRef}
      id={fileAnchorId(file.path)}
      tabIndex={-1}
      className="captured-file"
      aria-labelledby={headingId}
      data-testid="captured-file"
      data-path={file.path}
      data-view={view}
    >
      <h5 id={headingId} ref={headingRef}><code>{file.path}</code> <span className="projects-muted">· captured at freeze · sha256 {file.sha256.slice(0, 12)}…</span></h5>
      <h6>Findings on this file</h6>
      <FileFindings findings={findings} path={file.path} onShowLines={showLines} />
      <div role="group" aria-label={`View of ${file.path}`} className="task-toggle">
        {markdown ? (
          <>
            <button type="button" className="button button-small" aria-pressed={view === 'rendered'} onClick={() => setView('rendered')}>Rendered</button>
            <button type="button" className="button button-small" aria-pressed={view === 'source'} onClick={() => setView('source')}>Source</button>
          </>
        ) : (
          <button type="button" className="button button-small" aria-expanded={view === 'source'} onClick={() => setView(previous => (previous === 'closed' ? 'source' : 'closed'))}>
            {view === 'closed' ? 'Show source' : 'Hide source'}
          </button>
        )}
      </div>
      {view !== 'closed' && state.status === 'loading' && <LoadingPanel>Loading {file.path}…</LoadingPanel>}
      {view !== 'closed' && state.status === 'error' && <ErrorPanel error={state.error} what={`The captured file ${file.path}`} onRetry={reload} />}
      {view !== 'closed' && state.status === 'ready' && (
        state.data.length === 0
          ? <p className="projects-muted">This file is empty.</p>
          : view === 'rendered'
            ? <div className="task-rendered" data-testid="file-rendered"><Markdown content={state.data} inert /></div>
            : <FileSource text={state.data} marked={marked} preRef={preRef} />
      )}
    </section>
  )
}

/**
 * "Files created or changed" on a launch node: every changed file of the result in order, captured ones with their content
 * and the findings that name them, the others with the reason they were not captured. A result recorded before capture
 * lists the paths and says the files were not captured.
 */
export function CreatedFiles({ scope, result, reviewNode, refreshToken, focusPath, onFocusApplied }: Props) {
  const captured = capturedFiles(result)
  const byPath = new Map(captured.map(file => [file.path, file]))
  const reasons = new Map(notCapturedFiles(result).map(entry => [entry.path, entry.reason]))
  const recorded = recordsCapture(result)
  // Every changed file in the result's order, then any captured or listed path the changed files do not name (never dropped).
  const listed = [...result.changed_files]
  for (const path of [...byPath.keys(), ...reasons.keys()]) if (!listed.includes(path)) listed.push(path)

  const reviewPath = captured.length === 0 ? null : reviewPathOf(scope, reviewNode)
  const loadReview = useCallback(
    (signal: AbortSignal) => orNotRecorded(fetchReviewResult(scope, reviewPath!, signal), NOT_RECORDED.review).then(review => review?.findings ?? null),
    [scope, reviewPath],
  )
  const { state: findings } = useResource(reviewPath, loadReview, refreshToken)

  // A file link is applied once: the target panel scrolls into view when it mounts, and the run view forgets the hand-over.
  const [focus] = useState(() => focusPath)
  useEffect(() => {
    if (focus !== null) onFocusApplied()
  }, [focus, onFocusApplied])

  return (
    <section className="evidence-section" aria-labelledby="evidence-created-files" data-testid="created-files" data-captured={captured.length}>
      <h4 id="evidence-created-files">Files created or changed</h4>
      {listed.length === 0 ? (
        <p className="projects-muted" data-testid="changed-files-empty">No changed files were recorded.</p>
      ) : (
        <>
          {!recorded && (
            <p className="projects-muted" data-testid="files-not-captured">
              Created files were not captured for this run (its results predate file capture), so only their paths are listed.
            </p>
          )}
          <ul className="evidence-list evidence-files" data-testid="changed-files">
            {listed.map(path => {
              const file = byPath.get(path)
              const reason = reasons.get(path)
              const state = file ? 'captured' : reason ? 'not-captured' : recorded ? 'unlisted' : 'not-recorded'
              return (
                <li key={path} data-testid="created-file" data-path={path} data-state={state} data-reason={reason}>
                  {file ? (
                    <CapturedFilePanel scope={scope} file={file} findings={findings} focused={focus === path} />
                  ) : (
                    <>
                      <code>{path}</code>
                      {reason && <span className="projects-muted" data-testid="not-captured-reason"> — {NOT_CAPTURED_WORDING[reason]}</span>}
                      {!reason && recorded && <span className="projects-muted"> — not captured, and no reason was recorded</span>}
                    </>
                  )}
                </li>
              )
            })}
          </ul>
          {focus !== null && !byPath.has(focus) && (
            <p className="projects-muted" data-testid="file-focus-missing">The linked file <code>{focus}</code> is not among this node's captured files.</p>
          )}
        </>
      )}
    </section>
  )
}
