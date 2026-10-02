import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { GateReason } from '../../contracts/projects/triage.ts'
import { fetchArtifactText, type RunScope, type WorkerResult } from './api.ts'
import type { CheckGate } from './node/gate.ts'
import { ErrorPanel, LoadingPanel } from './panels.tsx'
import { Time } from './Time.tsx'
import { toneClass, type Tone } from './tone.ts'
import { formatSpan, spanBetween, utcTitle } from './time.ts'
import { useResource } from './useResource.ts'

type Check = WorkerResult['checks'][number]

/** How long after the attempt started a check started: "+0:42", "+1:02:03". */
function formatOffset(ms: number): string {
  const total = Math.round(ms / 1000)
  const pad = (value: number) => String(value).padStart(2, '0')
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  return `+${hours > 0 ? `${hours}:${pad(minutes)}` : minutes}:${pad(total % 60)}`
}

/**
 * A text artifact (a log, a report, a patch) fetched only once it is opened. `tail` opens it at once and scrolls to its
 * end, where a failing check's log says why (a rejected check's log tail opens by default).
 */
export function TextArtifact({ scope, artifactId, tail = false }: { scope: RunScope; artifactId: string; tail?: boolean }) {
  const [open, setOpen] = useState(tail)
  const load = useCallback((signal: AbortSignal) => fetchArtifactText(scope, artifactId, signal), [scope, artifactId])
  const { state, reload } = useResource(open ? `artifact:${artifactId}` : null, load)
  const log = useRef<HTMLPreElement>(null)
  const ready = state.status === 'ready'
  useEffect(() => {
    if (tail && ready && log.current) log.current.scrollTop = log.current.scrollHeight
  }, [tail, ready])
  return (
    <div className="artifact-text">
      <button type="button" className="button button-small" aria-expanded={open} onClick={() => setOpen(previous => !previous)}>
        {open ? 'Hide contents' : 'Show contents'}
      </button>
      {open && state.status === 'loading' && <LoadingPanel>Loading artifact {artifactId}…</LoadingPanel>}
      {open && state.status === 'error' && <ErrorPanel error={state.error} what={`Artifact ${artifactId}`} onRetry={reload} />}
      {open && state.status === 'ready' && (
        state.data.length === 0
          ? <p className="projects-muted">This artifact is empty.</p>
          : <pre ref={log} className="artifact-log" data-testid={`artifact-text:${artifactId}`} data-tail={tail ? 'true' : undefined} tabIndex={0}>{state.data}</pre>
      )}
    </div>
  )
}

type State = 'passed' | 'failed' | 'rejected' | 'deferred'
const GLYPH: Record<State, string> = { passed: '✓', failed: '✗', rejected: '✗', deferred: '◐' }
/** The tone of a row's exit chip (docs/PRD_VIEWER_REVAMP.md 5.4); the glyph and the words say the same. */
const STATE_TONE: Record<State, Tone> = { passed: 'ok', failed: 'fail', rejected: 'fail', deferred: 'idle' }

/**
 * The checks the verifier executed (docs/PRD_VIEWER_UX.md 7), one row each: glyph, declared check id, the command
 * (truncated), when it started after the attempt did, how long it took and its exit code, then the gate's reasons about it
 * and its log on demand. A check the gate rejected is red even at exit 0; its log tail is open, as a failed check's is. The row's tooltip names
 * the command, cwd, log artifact and absolute times; the times are also read out to screen readers.
 */
export function Checks({ scope, result, gate, deferred, attemptStart, idPrefix = 'check', extras }: {
  scope: RunScope
  result: WorkerResult
  gate: CheckGate
  /** Executed checks recorded here but gated at the combined candidate, by index. */
  deferred: ReadonlyMap<number, string>
  /** When the attempt started, for each row's offset; null when unknown. */
  attemptStart: string | null
  /** Row ids are `<prefix>-<index>`; the verify node's are `check-<index>`, which the task links target. */
  idPrefix?: string
  /** Evidence shown inside a row, by check index: a candidate lane's screenshots in its browser check's row. */
  extras?: ReadonlyMap<number, ReactNode>
}) {
  const logs = new Set(result.artifacts.map(artifact => artifact.artifact_id))
  const started = attemptStart === null ? Number.NaN : Date.parse(attemptStart)
  return (
    <ul className="evidence-list check-list" data-testid="checks-list">
      {result.checks.map((check: Check, index) => {
        const id = gate.ids[index]
        const reasons: GateReason[] = id === null ? [] : gate.reasons.byCheck.get(id) ?? []
        const isDeferred = deferred.has(index)
        const state: State = isDeferred ? 'deferred' : check.exit_code !== 0 ? 'failed' : reasons.length > 0 ? 'rejected' : 'passed'
        const rejected = !isDeferred && reasons.length > 0
        const tail = rejected || state === 'failed'
        const exitText = `exit ${check.exit_code}`
        const took = spanBetween(check.started_at, check.finished_at)
        const offset = Date.parse(check.started_at) - started
        const hasLog = logs.has(check.log_artifact_id)
        const tooltip = [
          check.command, `cwd ${check.cwd}`, `log ${check.log_artifact_id}${hasLog ? '' : ' (not listed among the result artifacts)'}`,
          `${utcTitle(check.started_at)} → ${utcTitle(check.finished_at)}`,
        ].join('\n')
        return (
          <li
            key={`${check.log_artifact_id}-${index}`}
            id={`${idPrefix}-${index}`}
            tabIndex={-1}
            className={`check check-${state}${rejected && state !== 'rejected' ? ' check-rejected' : ''}`}
            data-state={state}
            data-check-id={id ?? undefined}
            data-exit-code={check.exit_code}
            data-deferred={isDeferred ? 'true' : undefined}
          >
            <div className="check-head" title={tooltip}>
              <span className="check-glyph" aria-hidden="true">{GLYPH[state]}</span>
              {id !== null && <span className="check-id">{id}</span>}
              <code className="check-command">{check.command}</code>
              {offset >= 0 && <span className="check-offset">{formatOffset(offset)}</span>}
              {took !== null && <span className="check-duration">{formatSpan(took)}</span>}
              <span className="visually-hidden">, started <Time iso={check.started_at} seconds />, ended <Time iso={check.finished_at} seconds /></span>
              <span className={`check-exit ui-chip ${toneClass(STATE_TONE[state])}`} data-tone={STATE_TONE[state]}>
                {isDeferred ? `${exitText} · recorded, gated at the combined candidate` : check.exit_code !== 0 ? `${exitText} (failed)` : rejected ? `${exitText} · rejected by the gate` : exitText}
              </span>
            </div>
            {reasons.length > 0 && (
              <ul className="check-reasons">
                {reasons.map((reason, position) => <li key={position}>{reason.check_id === null ? reason.text : reason.reason}</li>)}
              </ul>
            )}
            {/* Keyed by its mode: the declared checks may arrive after the result and turn a row rejected, which opens its tail. */}
            {hasLog && <TextArtifact key={tail ? 'tail' : 'log'} scope={scope} artifactId={check.log_artifact_id} tail={tail} />}
            {extras?.get(index)}
          </li>
        )
      })}
    </ul>
  )
}
