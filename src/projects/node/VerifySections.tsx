import { useCallback, useState, type ReactNode } from 'react'
import { fetchArtifactText, paths, scopedResultPath, type RunScope, type WorkerResult } from '../api.ts'
import { AppLink, ErrorPanel, LoadingPanel } from '../panels.tsx'
import { runPathname } from '../routes.ts'
import { NodeSection } from '../SectionIndex.tsx'
import { evidenceOf } from './model.ts'
import { Time } from '../Time.tsx'
import { formatSpan, spanBetween } from '../time.ts'
import { useResource } from '../useResource.ts'
import { useRunResult } from '../useRunData.ts'
import { ResultError, ResultFacts } from './ResultFacts.tsx'
import './verify.css'

type Phase = 'worker' | 'candidate'

/** Text-like artifact kinds are shown as plain text on demand; screenshots are images; anything else is only listed. */
function TextArtifact({ scope, artifactId }: { scope: RunScope; artifactId: string }) {
  const [open, setOpen] = useState(false)
  const load = useCallback((signal: AbortSignal) => fetchArtifactText(scope, artifactId, signal), [scope, artifactId])
  const { state, reload } = useResource(open ? `artifact:${artifactId}` : null, load)
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
          : <pre className="artifact-log" data-testid={`artifact-text:${artifactId}`} tabIndex={0}>{state.data}</pre>
      )}
    </div>
  )
}

function ScreenshotArtifact({ scope, artifactId }: { scope: RunScope; artifactId: string }) {
  const [failed, setFailed] = useState(false)
  if (failed) return <p className="projects-error-inline" role="alert">Screenshot {artifactId} could not be loaded from the artifact route.</p>
  return (
    <img
      className="artifact-screenshot"
      src={paths.artifact(scope, artifactId)}
      alt={`Screenshot artifact ${artifactId}`}
      data-testid={`artifact-screenshot:${artifactId}`}
      onError={() => setFailed(true)}
    />
  )
}

/**
 * What the trusted verifier proved, on a verify node and for each lane of the combined candidate: the gate with the
 * reasons it recorded and its deferred checks, the checks with their logs, screenshots, other artifacts and the result's
 * facts. Empty sections are absent. On the verify node (`anchored`) each block is a section of the page's index; a
 * candidate lane keeps them inside its lane. Captured files are the launch node's; they are not repeated here.
 */
export function VerifiedEvidence({ scope, result, phase, testId = 'worker-result', anchored = false }: { scope: RunScope; result: WorkerResult; phase: Phase; testId?: string; anchored?: boolean }) {
  const { artifactsById, screenshots, others, deferred, passed } = evidenceOf(result)
  const block = (key: string, title: string, children: ReactNode, extra: { testId?: string; passed?: boolean } = {}) => anchored ? (
    <NodeSection key={key} sectionKey={key} title={title} testId={extra.testId} className="evidence-section">
      {children}
    </NodeSection>
  ) : (
    <section key={key} className="evidence-section" aria-labelledby={`${testId}-${key}`} data-testid={extra.testId}>
      <h4 id={`${testId}-${key}`}>{title}</h4>
      {children}
    </section>
  )
  return (
    <div className="worker-evidence" data-testid={testId} data-view="verified">
      <div className="gate-block" data-testid="gate-outcome" data-passed={passed ? 'true' : 'false'}>
        {block('gate', 'Gate', (
          <>
            <ResultError result={result} />
            <p>
              {passed
                ? `Passed: every gating check of this ${phase === 'worker' ? 'isolated lane snapshot' : 'combined candidate'} exited 0.`
                : 'Did not pass: see the error above for the reasons the gate recorded.'}
            </p>
            {deferred.size > 0 && (
              <p className="projects-notice-inline" data-testid="deferred-checks">
                Deferred checks: {[...deferred.values()].join(', ')} — executed and recorded on this isolated lane snapshot, but gated only at the combined candidate, which verifies the whole application.
              </p>
            )}
            <p className="projects-muted" data-testid="ownership-outcome">
              {phase === 'candidate'
                ? 'Ownership: enforced on each lane\'s isolated snapshot, not on the combined candidate.'
                : passed
                  ? 'Ownership: the verifier checked the changed files against the lane\'s owned paths on this snapshot, and the gate passed.'
                  : 'Ownership: checked on this snapshot; an ownership violation, if there was one, is among the reasons in the error above.'}
            </p>
          </>
        ))}
      </div>

      {result.checks.length > 0 && block('checks', 'Checks actually executed', (
        <ul className="evidence-list" data-testid="checks-list">
          {result.checks.map((check, index) => {
            const log = artifactsById.get(check.log_artifact_id)
            const isDeferred = deferred.has(index)
            const exitText = check.exit_code === 0 ? 'exit 0' : `exit ${check.exit_code}`
            const took = spanBetween(check.started_at, check.finished_at)
            return (
              <li key={`${check.log_artifact_id}-${index}`} id={`check-${index}`} tabIndex={-1} className={isDeferred ? 'check check-deferred' : check.exit_code === 0 ? 'check check-passed' : 'check check-failed'} data-exit-code={check.exit_code} data-deferred={isDeferred ? 'true' : undefined}>
                <div className="check-head">
                  <code className="check-command">{check.command}</code>
                  <span className="check-exit">{isDeferred ? `${exitText} · recorded, gated at the combined candidate` : check.exit_code === 0 ? exitText : `${exitText} (failed)`}</span>
                </div>
                <p className="projects-muted check-meta">
                  <Time iso={check.started_at} seconds /> → <Time iso={check.finished_at} seconds />
                  {took !== null && <> · <span className="check-duration">{formatSpan(took)}</span></>} · cwd <code>{check.cwd}</code>
                </p>
                <div className="check-log">
                  <span>Log artifact <code>{check.log_artifact_id}</code>{log ? '' : ' (not listed among the result artifacts)'}</span>
                  {log && <TextArtifact scope={scope} artifactId={log.artifact_id} />}
                </div>
              </li>
            )
          })}
        </ul>
      ))}

      {(screenshots.length > 0 || deferred.size > 0) && block('screenshots', 'Screenshots', screenshots.length === 0 ? (
        <p className="projects-muted" data-testid="screenshots-deferred">No screenshot artifacts were published for this isolated lane run; browser evidence is gated and shown at the combined candidate.</p>
      ) : (
        <ul className="evidence-list evidence-screenshots" data-testid="screenshots">
          {screenshots.map(artifact => (
            <li key={artifact.artifact_id}>
              <p><code>{artifact.artifact_id}</code> <span className="projects-muted">sha256 {artifact.sha256.slice(0, 12)}…</span></p>
              <ScreenshotArtifact scope={scope} artifactId={artifact.artifact_id} />
            </li>
          ))}
        </ul>
      ))}

      {others.length > 0 && block('artifacts', 'Other artifacts', (
        <ul className="evidence-list" data-testid="artifacts">
          {others.map(artifact => (
            <li key={artifact.artifact_id}>
              <p><code>{artifact.artifact_id}</code> · {artifact.kind} · <span className="projects-muted">sha256 {artifact.sha256.slice(0, 12)}…</span></p>
              {artifact.kind === 'other'
                ? <p className="projects-muted">Not rendered: only logs, reports, patches and screenshots are displayed.</p>
                : <TextArtifact scope={scope} artifactId={artifact.artifact_id} />}
            </li>
          ))}
        </ul>
      ))}

      {block('result', 'Result', <ResultFacts result={result} />)}
    </div>
  )
}

/** "Worker's report → Launch ui worker ›": where a verified result's worker narrative lives, said once (docs/PRD_VIEWER_UX.md 7). */
export function WorkerReportLink({ href, label, onNavigate }: { href: string; label: string; onNavigate: (pathname: string) => void }) {
  return (
    <p className="worker-report-link" data-testid="worker-report-link">
      Worker's report → <AppLink href={href} onNavigate={onNavigate}>{label} ›</AppLink>
    </p>
  )
}

export type LaneEntry = { worker: string; attempt: number; result_uri: string }

/** One lane's result of the combined candidate, read through the run's cache of immutable results. */
function LaneResult({ scope, lane, launchNode, stamp, onNavigate }: {
  scope: RunScope
  lane: LaneEntry
  /** The graph node that launched the lane, which shows the files it created and its report; null when the pinned graph has none. */
  launchNode: { node_id: string; label: string } | null
  stamp: string
  onNavigate: (pathname: string) => void
}) {
  const resultPath = scopedResultPath(scope, lane.result_uri)
  const { state, reload } = useRunResult(scope, resultPath, stamp)
  return (
    <section className="lane-result" aria-label={`Lane ${lane.worker}`} data-testid={`lane-result:${lane.worker}`}>
      <h5>Lane {lane.worker} <span className="projects-muted">· candidate attempt {lane.attempt}</span></h5>
      {launchNode !== null && (
        <>
          <p className="projects-muted" data-testid="lane-files-link">
            Files are captured on the lane's worker snapshot only:{' '}
            <AppLink href={runPathname(scope.projectId, scope.workflowId, scope.runId, launchNode.node_id)} onNavigate={onNavigate}>open the files the {lane.worker} lane created or changed</AppLink>.
          </p>
          <WorkerReportLink href={runPathname(scope.projectId, scope.workflowId, scope.runId, launchNode.node_id)} label={launchNode.label} onNavigate={onNavigate} />
        </>
      )}
      {resultPath === null && (
        <p className="projects-error-inline" role="alert">The result link <code>{lane.result_uri}</code> is outside this run's results route and was not fetched.</p>
      )}
      {resultPath !== null && state.status === 'loading' && <LoadingPanel>Loading the {lane.worker} lane result…</LoadingPanel>}
      {resultPath !== null && state.status === 'error' && <ErrorPanel error={state.error} what={`The ${lane.worker} lane result`} onRetry={reload} />}
      {resultPath !== null && state.status === 'ready' && <VerifiedEvidence scope={scope} result={state.data} phase="candidate" testId={`lane-result-evidence:${lane.worker}`} />}
    </section>
  )
}

/** The combined candidate's lanes: every lane verified on one revision, each with its checks and screenshots. */
export function CandidateLanes({ scope, lanes, launchNodeOf, stamp, onNavigate }: {
  scope: RunScope
  lanes: LaneEntry[]
  launchNodeOf: (lane: string) => { node_id: string; label: string } | null
  stamp: string
  onNavigate: (pathname: string) => void
}) {
  return (
    <NodeSection sectionKey="lanes" title="Lanes">
      <div className="lane-results" data-testid="lane-results">
        <p className="projects-muted">The combined candidate verified every lane on one revision; each lane's result, with its checks and screenshots, is shown below.</p>
        {lanes.map(lane => (
          <LaneResult key={lane.worker} scope={scope} lane={lane} launchNode={launchNodeOf(lane.worker)} stamp={stamp} onNavigate={onNavigate} />
        ))}
      </div>
    </NodeSection>
  )
}

