import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { Markdown } from '../document/Markdown.tsx'
import { fetchArtifactText, fetchReviewResult, NOT_RECORDED, orNotRecorded, paths, type ReviewFinding, type RunDetail, type RunScope, type WorkerResult } from './api.ts'
import { fileAnchorId, NOT_CAPTURED_WORDING } from './files.ts'
import { linesNamed } from './findings.ts'
import { fileRows, filterRows, folderOf, repairBadge, repairFilterLabel, repairTitle, type FileFilter, type FileRow } from './node/launch.ts'
import { ErrorPanel, LoadingPanel } from './panels.tsx'
import { keepInView } from './scroll.ts'
import { useResource, type Resource } from './useResource.ts'
import { useRunReview } from './useRunData.ts'

type SnapshotNode = RunDetail['snapshot']['nodes'][number]
type Range = [number, number]

type Props = {
  scope: RunScope
  /** The node's latest result: the content a row opens on, and what a repair changed. */
  result: WorkerResult
  /** The worker's own freeze (`results/<lane>/1`) once loaded, which the rows list; null lists the latest result's. */
  frozen: WorkerResult | null
  /** The repair a changed file is credited to ("repair 1"); empty when no repair is recorded. */
  repairLabel: string
  /** The run's review node, whose recorded findings are shown on the files they name; null when the graph has none. */
  reviewNode: SnapshotNode | null
  refreshToken: number
  /** A captured file to open and scroll to, handed over by a review finding's file link; null otherwise. */
  focusPath: string | null
  onFocusApplied: () => void
}

/** From this many rows on, the list can be grouped by folder. */
const GROUP_MIN = 10

/**
 * Where the review is recorded before the snapshot links it: an older export has no link, so the review node's first attempt
 * is asked for once the node ran, the way the review node finds it. Null when the node links its review, or has not run.
 */
function guessedReviewPath(scope: RunScope, node: SnapshotNode | null): string | null {
  if (node === null || node.result_uri !== null || node.status === 'pending') return null
  return paths.review(scope, Math.max(node.attempt, 1))
}

function rangeText([from, to]: Range): string {
  return from === to ? `line ${from}` : `lines ${from}–${to}`
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`

/** The review findings that name this file, one line each: severity, reviewer, disposition, and the message cut to the row. */
function FileFindings({ findings, row, onShowLines }: { findings: Resource<ReviewFinding[] | null>; row: FileRow; onShowLines: (ranges: Range[]) => void }) {
  if (findings.status === 'idle' || (findings.status === 'ready' && findings.data === null)) {
    return <p className="projects-muted" data-testid="file-findings-no-review">No review is recorded for this run, so no findings are shown on its files.</p>
  }
  if (findings.status === 'loading') return <LoadingPanel>Loading the review findings…</LoadingPanel>
  if (findings.status === 'error') return <p className="projects-error-inline" role="alert">The recorded review could not be loaded, so findings on this file are not shown.</p>
  if (row.findings.length === 0) return <p className="projects-muted" data-testid="file-findings-none">No review finding names this file.</p>
  return (
    <ul className="file-findings" data-testid="file-findings">
      {row.findings.map((finding, index) => {
        const ranges = linesNamed(finding.message, row.path)
        return (
          <li key={index} className="file-finding" data-testid="file-finding" data-severity={finding.severity} data-reviewer={finding.reviewer} data-disposition={finding.disposition}>
            <span className="finding-severity">{finding.severity}</span>
            <span className="file-finding-who">· <span data-testid="file-finding-reviewer">{finding.reviewer}</span> · {finding.disposition} —</span>
            <span className="file-finding-message" title={finding.message}>{finding.message}</span>
            {ranges.length > 0 && (
              <button type="button" className="button button-small" data-testid="show-lines" onClick={() => onShowLines(ranges)}>
                Show {ranges.map(rangeText).join(', ')}
              </button>
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
    <pre className="artifact-log file-content" data-testid="file-source" tabIndex={0} ref={preRef}>
      {lines.map((line, index) => {
        const number = index + 1
        return isMarked(number)
          ? <mark key={number} data-line={number} data-finding-line="true">{line}{'\n'}</mark>
          : <span key={number} data-line={number}>{line}{'\n'}</span>
      })}
    </pre>
  )
}

/** What a row says after its path: how a repair touched the file, and where its first finding points. */
function RowMarks({ row }: { row: FileRow }) {
  // The most severe finding names the row's severity; its reviewer and lines follow the path.
  const first = row.findings.find(entry => entry.severity === row.severity)
  const lines = first ? linesNamed(first.message, row.path) : []
  const hint = first ? [first.reviewer, ...(lines.length > 0 ? [rangeText(lines[0])] : []), ...(row.findings.length > 1 ? [`+${row.findings.length - 1} more`] : [])].join(' · ') : null
  return (
    <span className="file-row-meta">
      {row.repair && (
        <span className="file-repair" title={repairTitle(row.repair)}>{repairBadge(row.repair)}</span>
      )}
      {hint && <span>{hint}</span>}
      {row.markdown && <span>Markdown</span>}
    </span>
  )
}

/**
 * One captured file as a dense row (docs/PRD_VIEWER_UX.md 4.5, 7): a `<details>` whose summary is its path. Nothing is
 * fetched until the row opens. An opened row shows the sha256, the findings on the file as one-line chips, then the content:
 * Markdown on Rendered with a Source view, anything else as source. "Show lines" switches to the source and marks them.
 */
function CapturedFileRow({ scope, row, findings, focused }: { scope: RunScope; row: FileRow; findings: Resource<ReviewFinding[] | null>; focused: boolean }) {
  const file = row.file!
  const [open, setOpen] = useState(focused)
  const [view, setView] = useState<'rendered' | 'source'>(row.markdown ? 'rendered' : 'source')
  const [marked, setMarked] = useState<Range[]>([])
  const [scrollRequest, setScrollRequest] = useState(0)
  const preRef = useRef<HTMLPreElement>(null)
  const rowRef = useRef<HTMLDetailsElement>(null)
  const load = useCallback((signal: AbortSignal) => fetchArtifactText(scope, file.artifact_id, signal), [scope, file.artifact_id])
  const { state, reload } = useResource(open ? `file:${file.artifact_id}` : null, load)

  useEffect(() => {
    const element = rowRef.current
    if (!focused || !element) return
    element.querySelector('summary')?.focus({ preventScroll: true })
    return keepInView(element, { block: 'start' })
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
  return (
    <details
      ref={rowRef}
      id={fileAnchorId(row.path)}
      className="file-row"
      data-testid="captured-file"
      data-path={row.path}
      data-view={open ? view : 'closed'}
      open={open}
      onToggle={event => setOpen(event.currentTarget.open)}
    >
      <summary className="file-row-summary">
        <span className="file-row-severity">{row.severity}</span>
        <code className="file-row-path" title={row.path}>{row.path}</code>
        <RowMarks row={row} />
      </summary>
      {open && (
        <div className="file-row-body">
          <div className="file-row-facts">
            <span className="projects-muted">sha256 <code title={file.sha256}>{file.sha256.slice(0, 12)}…</code>{row.repair && ` · as ${row.repair.label ? `after ${row.repair.label}` : 'changed after the freeze'}`}</span>
            {row.markdown && (
              <span role="group" aria-label={`View of ${row.path}`} className="task-toggle">
                <button type="button" className="button button-small" aria-pressed={view === 'rendered'} onClick={() => setView('rendered')}>Rendered</button>
                <button type="button" className="button button-small" aria-pressed={view === 'source'} onClick={() => setView('source')}>Source</button>
              </span>
            )}
          </div>
          <FileFindings findings={findings} row={row} onShowLines={showLines} />
          {state.status === 'loading' && <LoadingPanel>Loading {row.path}…</LoadingPanel>}
          {state.status === 'error' && <ErrorPanel error={state.error} what={`The captured file ${row.path}`} onRetry={reload} />}
          {state.status === 'ready' && (
            state.data.length === 0
              ? <p className="projects-muted">This file is empty.</p>
              : view === 'rendered'
                ? <div className="task-rendered file-content" data-testid="file-rendered"><Markdown content={state.data} inert /></div>
                : <FileSource text={state.data} marked={marked} preRef={preRef} />
          )}
        </div>
      )}
    </details>
  )
}

function FileRowItem({ scope, row, findings, focused }: { scope: RunScope; row: FileRow; findings: Resource<ReviewFinding[] | null>; focused: boolean }) {
  return (
    <li data-testid="created-file" data-path={row.path} data-state={row.state} data-reason={row.reason ?? undefined} data-repair={row.repair?.kind} data-findings={row.findings.length}>
      {row.file ? (
        <CapturedFileRow scope={scope} row={row} findings={findings} focused={focused} />
      ) : (
        <div className="file-row-summary file-row-static">
          <span className="file-row-severity">{row.severity}</span>
          <code className="file-row-path" title={row.path}>{row.path}</code>
          <span className="file-row-meta">
            {row.reason && <span data-testid="not-captured-reason">{NOT_CAPTURED_WORDING[row.reason]}</span>}
            {row.state === 'unlisted' && <span>not captured, and no reason was recorded</span>}
          </span>
        </div>
      )}
    </li>
  )
}

/**
 * "Files created or changed" on a launch node (docs/PRD_VIEWER_UX.md 4.5, 7): one dense row per file the worker froze at
 * handoff (`results/<lane>/1`), plus any file a repair added, with the review's findings first. Filters narrow the list to
 * the files with findings or those the repair touched, and a long list can be grouped by folder. A result recorded before
 * capture lists the paths and says the files were not captured.
 */
export function CreatedFiles({ scope, result, frozen, repairLabel, reviewNode, refreshToken, focusPath, onFocusApplied }: Props) {
  const listed = frozen ?? result
  const recorded = listed.files_not_captured !== undefined || listed.artifacts.some(artifact => artifact.kind === 'file')
  // A linked review is immutable: read once through the run's cache. A guessed path is not linked yet and may not exist, so
  // it is read outside that cache and asked again when the review node moves on or on Refresh; a 404 there reads as none.
  const linked = recorded ? reviewNode?.result_uri ?? null : null
  const guessed = recorded ? guessedReviewPath(scope, reviewNode) : null
  const cached = useRunReview(scope, linked, String(refreshToken))
  const loadGuessed = useCallback((signal: AbortSignal) => orNotRecorded(fetchReviewResult(scope, guessed!, signal), NOT_RECORDED.review), [scope, guessed])
  const { state: fallback } = useResource(guessed === null ? null : `${guessed}|${reviewNode?.status}:${reviewNode?.attempt}`, loadGuessed, refreshToken)
  const review = linked !== null ? cached : fallback
  const findings: Resource<ReviewFinding[] | null> = review.status === 'ready' ? { status: 'ready', data: review.data?.findings ?? null } : review
  const findingList = findings.status === 'ready' ? findings.data : null
  const rows = useMemo(() => fileRows(frozen, result, findingList, repairLabel), [frozen, result, findingList, repairLabel])
  const withFindings = rows.filter(row => row.findings.length > 0).length
  const repaired = rows.filter(row => row.repair !== null).length
  const [filter, setFilter] = useState<FileFilter>('all')
  const [grouped, setGrouped] = useState(false)
  const shown = filterRows(rows, filter)

  // A file link is applied once: the target row opens and scrolls into view when it mounts, and the run view forgets it.
  const [focus] = useState(() => focusPath)
  useEffect(() => {
    if (focus !== null) onFocusApplied()
  }, [focus, onFocusApplied])

  const filters: { key: FileFilter; label: string; count: number }[] = [
    ...(withFindings > 0 ? [{ key: 'findings' as const, label: 'With findings', count: withFindings }] : []),
    ...(repaired > 0 ? [{ key: 'repair' as const, label: `${repairFilterLabel(repairLabel)}${repairLabel ? ' ·' : ''}`, count: repaired }] : []),
  ]
  const item = (row: FileRow) => <FileRowItem key={row.path} scope={scope} row={row} findings={findings} focused={focus === row.path} />
  return (
    <section className="evidence-section launch-files" aria-labelledby="evidence-created-files" data-testid="created-files" data-captured={rows.filter(row => row.file).length}>
      <div className="launch-files-head">
        <h4 id="evidence-created-files">Files created or changed</h4>
        <span className="projects-muted" data-testid="files-summary">
          {plural(rows.length, 'file')} {frozen ? 'frozen at handoff' : 'in the result'}
          {withFindings > 0 && ` · ${withFindings} with findings`}
          {repaired > 0 && ` · ${repaired} ${repairLabel ? `by ${repairLabel}` : 'changed after the freeze'}`}
        </span>
      </div>
      {rows.length === 0 ? (
        <p className="projects-muted" data-testid="changed-files-empty">No changed files were recorded.</p>
      ) : (
        <>
          {!recorded && (
            <p className="projects-muted" data-testid="files-not-captured">
              Created files were not captured for this run (its results predate file capture), so only their paths are listed.
            </p>
          )}
          {(filters.length > 0 || rows.length >= GROUP_MIN) && (
            <div className="launch-files-tools">
              {filters.length > 0 && (
                <div role="group" aria-label="Show files" className="task-toggle" data-testid="file-filters">
                  {[...filters, { key: 'all' as const, label: 'All', count: rows.length }].map(entry => (
                    <button key={entry.key} type="button" className="button button-small" aria-pressed={filter === entry.key} onClick={() => setFilter(entry.key)}>
                      {entry.label} {entry.count}
                    </button>
                  ))}
                </div>
              )}
              {rows.length >= GROUP_MIN && (
                <label className="launch-files-group">
                  <input type="checkbox" checked={grouped} onChange={event => setGrouped(event.currentTarget.checked)} /> Group by folder
                </label>
              )}
            </div>
          )}
          <ul className="file-rows" data-testid="changed-files">
            {grouped
              ? [...new Set(shown.map(row => folderOf(row.path)))].sort().map(folder => {
                const inFolder = shown.filter(row => folderOf(row.path) === folder)
                return (
                  <li key={folder} className="file-group" data-folder={folder}>
                    <span className="file-group-name">{folder === '' ? 'Repository root' : folder} <span className="projects-muted">{inFolder.length}</span></span>
                    <ul className="file-rows">{inFolder.map(item)}</ul>
                  </li>
                )
              })
              : shown.map(item)}
          </ul>
          {focus !== null && !rows.some(row => row.path === focus && row.file) && (
            <p className="projects-muted" data-testid="file-focus-missing">The linked file <code>{focus}</code> is not among this node's captured files.</p>
          )}
        </>
      )}
    </section>
  )
}
