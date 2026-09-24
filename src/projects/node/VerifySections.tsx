import { useMemo, type ReactNode } from 'react'
import { scopedResultPath, type RunInputWorker, type RunScope, type WorkerResult } from '../api.ts'
import { Checks, TextArtifact } from '../Checks.tsx'
import { AppLink, ErrorPanel, LoadingPanel } from '../panels.tsx'
import { runPathname } from '../routes.ts'
import { Screenshots } from '../Screenshots.tsx'
import { NodeSection } from '../SectionIndex.tsx'
import { useRunResult, useRunResults } from '../useRunData.ts'
import { checkGate, type CheckGate, type DeclaredCheck } from './gate.ts'
import { evidenceOf, sectionId } from './model.ts'
import { OwnedPaths, RequiredChecks } from './Requirements.tsx'
import { ResultFacts } from './ResultFacts.tsx'
import './verify.css'

type Phase = 'worker' | 'candidate'

/** What a verify node's Requirements section reads: the lane as the run plan pinned it and the attempt cap per revision. */
export type LaneRequirements = { worker: RunInputWorker; cap: number | null }

/**
 * A failed gate (docs/PRD_VIEWER_UX.md 4.6, 8): how many checks it rejected, its error code, and one bullet per reason in the
 * order it recorded them. A keyed reason names its check; a reason without a check id stays a gate-level reason (no
 * `data-check-id`), and the check its command tail names, if exactly one, lists it too.
 */
function GateFailure({ result, gate, tag }: { result: WorkerResult; gate: CheckGate; tag: ReactNode }) {
  const { reasons } = gate.reasons
  const headline = gate.rejected > 0
    ? `Failed: ${gate.rejected} ${gate.rejected === 1 ? 'check' : 'checks'} rejected`
    : reasons.length > 0 ? `Failed: no check was rejected; the gate recorded ${reasons.length === 1 ? 'this reason' : 'these reasons'}` : 'Failed: the gate recorded no reason'
  return (
    <div className="projects-error gate-failure" role="alert" data-testid="worker-error">
      <p className="gate-line">
        <strong>{headline}</strong>
        {result.error && <> <span className="gate-code">· <code>{result.error.code}</code></span></>}
        {tag}
      </p>
      {reasons.length > 0 && (
        <ul className="gate-reasons" data-testid="gate-reasons">
          {reasons.map((reason, index) => (
            <li
              key={index}
              data-testid="gate-reason"
              data-check-id={reason.check_id ?? undefined}
              title={reason.attached_to ? `Also listed on the ${reason.attached_to} check, the only one whose command ends like this` : undefined}
            >
              {reason.check_id === null ? reason.text : <><span className="check-id">{reason.check_id}</span>: {reason.reason}</>}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** Requirements (4.6): the lane's checks with their scenarios and timeouts, the attempt cap and the owned paths, closed. */
function Requirements({ result, requirements }: { result: WorkerResult; requirements: LaneRequirements }) {
  const { worker, cap } = requirements
  const titleId = `${sectionId('requirements')}-title`
  const paths = worker.owned_paths.length
  return (
    <NodeSection sectionKey="requirements" labelledBy={titleId}>
      <details className="evidence-section closed-section" data-testid="requirements">
        <summary>
          <h4 id={titleId} className="node-section-title">Requirements</h4>{' '}
          <span className="projects-muted">
            lane {worker.node_id}: {worker.checks.map(check => check.id).join(' · ') || 'no checks'}{cap !== null ? ` · attempt cap ${cap}` : ''} · {paths} owned {paths === 1 ? 'path' : 'paths'}
          </span>
        </summary>
        {cap !== null && <p data-testid="requirements-cap">Attempt cap: {cap} per revision</p>}
        <RequiredChecks worker={worker} result={{ status: 'ready', data: result }} checksNode={null} onNavigate={() => {}} />
        <OwnedPaths paths={worker.owned_paths} />
      </details>
    </NodeSection>
  )
}

/**
 * What the trusted verifier proved, on a verify node and for each lane of the combined candidate: the gate with the
 * reasons it recorded and its deferred checks, the checks with their logs, screenshots, other artifacts (closed), the
 * lane's requirements (verify node only, closed) and the result's facts. Empty sections are absent. On the verify node
 * (`anchored`) each block is a section of the page's index; a candidate lane keeps them inside its lane. Captured files
 * are the launch node's; they are not repeated here.
 */
export function VerifiedEvidence({ scope, result, phase, testId = 'worker-result', anchored = false, declared = null, attemptStart = null, requirements = null }: {
  scope: RunScope
  result: WorkerResult
  phase: Phase
  testId?: string
  anchored?: boolean
  /** The lane's declared checks, which name the executed ones and key the gate's reasons; null when the inputs are unknown. */
  declared?: readonly DeclaredCheck[] | null
  /** When the attempt started, for each check's offset. */
  attemptStart?: string | null
  requirements?: LaneRequirements | null
}) {
  const { screenshots, others, deferred, passed } = evidenceOf(result)
  const gate = useMemo(() => checkGate(result, declared ?? []), [result, declared])
  const block = (key: string, title: string, children: ReactNode) => anchored ? (
    <NodeSection key={key} sectionKey={key} title={title} className="evidence-section">
      {children}
    </NodeSection>
  ) : (
    <section key={key} className="evidence-section" aria-labelledby={`${testId}-${key}`}>
      <h4 id={`${testId}-${key}`}>{title}</h4>
      {children}
    </section>
  )
  // On the candidate, ownership is a tag of the gate line: it was enforced on each lane's own snapshot.
  const ownershipTag = phase === 'candidate' ? <span className="gate-tag">ownership checked on the lane's snapshot, not here</span> : null
  const gating = result.checks.length - deferred.size
  const artifactsTitle = `${testId}-artifacts-title`
  const otherArtifacts = others.length > 0 && (
    <ul className="evidence-list" data-testid="artifacts">
      {others.map(artifact => (
        <li key={artifact.artifact_id}>
          <p><code>{artifact.artifact_id}</code> · {artifact.kind === 'log' ? 'log (not a check log)' : artifact.kind}</p>
          {artifact.kind === 'other'
            ? <p className="projects-muted">Not rendered: only logs, reports, patches and screenshots are displayed.</p>
            : <TextArtifact scope={scope} artifactId={artifact.artifact_id} />}
        </li>
      ))}
    </ul>
  )
  const artifactsSummary = (heading: ReactNode) => (
    <details className="evidence-section closed-section">
      <summary>{heading} <span className="projects-muted">{others.length}</span></summary>
      {otherArtifacts}
    </details>
  )
  return (
    <div className="worker-evidence" data-testid={testId} data-view="verified">
      <div className="gate-block" data-testid="gate-outcome" data-passed={passed ? 'true' : 'false'}>
        {block('gate', 'Gate', (
          <>
            {passed ? (
              <p className="gate-line">
                <strong>Passed:</strong> {gating === 1 ? 'the gating check' : `all ${gating} gating checks`} of this {phase === 'worker' ? 'isolated lane snapshot' : 'combined candidate'} exited 0.
                {ownershipTag}
              </p>
            ) : <GateFailure result={result} gate={gate} tag={ownershipTag} />}
            {deferred.size > 0 && (
              <p className="projects-notice-inline" data-testid="deferred-checks">
                Deferred checks: {[...deferred.values()].join(', ')} — executed and recorded on this isolated lane snapshot, but gated only at the combined candidate, which verifies the whole application.
              </p>
            )}
            {phase === 'worker' && (
              <p className="projects-muted" data-testid="ownership-outcome">
                {passed
                  ? 'Ownership: the verifier checked the changed files against the lane\'s owned paths on this snapshot, and the gate passed.'
                  : 'Ownership: checked on this snapshot; an ownership violation, if there was one, is among the reasons above.'}
              </p>
            )}
          </>
        ))}
      </div>

      {result.checks.length > 0 && block('checks', 'Checks', (
        <Checks scope={scope} result={result} gate={gate} deferred={deferred} attemptStart={attemptStart} idPrefix={anchored ? 'check' : `${testId}-check`} />
      ))}

      {(screenshots.length > 0 || deferred.size > 0) && block('screenshots', 'Screenshots', screenshots.length === 0 ? (
        <p className="projects-muted" data-testid="screenshots-deferred">No screenshot artifacts were published for this isolated lane run; browser evidence is gated and shown at the combined candidate.</p>
      ) : <Screenshots scope={scope} screenshots={screenshots} />)}

      {otherArtifacts && (anchored ? (
        <NodeSection sectionKey="artifacts" labelledBy={artifactsTitle}>
          {artifactsSummary(<h4 id={artifactsTitle} className="node-section-title">Artifacts</h4>)}
        </NodeSection>
      ) : artifactsSummary(<h4 id={artifactsTitle}>Other artifacts</h4>))}

      {anchored && requirements !== null && <Requirements result={result} requirements={requirements} />}

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

type LaneContext = {
  scope: RunScope
  /** The graph node that launched the lane, which shows the files it created and its report; null when the pinned graph has none. */
  launchNodeOf: (lane: string) => { node_id: string; label: string } | null
  /** The lane's declared checks; null when the inputs are unknown. */
  declaredOf: (lane: string) => readonly DeclaredCheck[] | null
  attemptStart: string | null
  stamp: string
  onNavigate: (pathname: string) => void
}

/**
 * One lane of the combined candidate, read through the run's cache of immutable results: a row of the lane table (lane,
 * gate, checks, reason, screenshots, and a link to the lane's files and report) that expands to the lane's Gate, Checks
 * and Screenshots. A failing lane starts open, a passing one closed.
 */
function LaneResult({ lane, context }: { lane: LaneEntry; context: LaneContext }) {
  const { scope, launchNodeOf, declaredOf, attemptStart, stamp, onNavigate } = context
  const resultPath = scopedResultPath(scope, lane.result_uri)
  const { state, reload } = useRunResult(scope, resultPath, stamp)
  const declared = declaredOf(lane.worker)
  const launchNode = launchNodeOf(lane.worker)
  const name = <span className="lane-name">Lane {lane.worker} <span className="projects-muted">· attempt {lane.attempt}</span></span>
  if (resultPath === null || state.status !== 'ready') {
    return (
      <div className="lane-result lane-result-pending" data-testid={`lane-result:${lane.worker}`}>
        {name}
        {resultPath === null && <p className="projects-error-inline" role="alert">The result link <code>{lane.result_uri}</code> is outside this run's results route and was not fetched.</p>}
        {resultPath !== null && (state.status === 'loading' || state.status === 'idle') && <LoadingPanel>Loading the {lane.worker} lane result…</LoadingPanel>}
        {resultPath !== null && state.status === 'error' && <ErrorPanel error={state.error} what={`The ${lane.worker} lane result`} onRetry={reload} />}
      </div>
    )
  }
  const result = state.data
  const { screenshots, passed } = evidenceOf(result)
  const gate = checkGate(result, declared ?? [])
  const exitZero = result.checks.filter(check => check.exit_code === 0).length
  return (
    <details className="lane-result" data-testid={`lane-result:${lane.worker}`} data-lane={lane.worker} data-passed={passed ? 'true' : 'false'} open={!passed}>
      <summary className="lane-summary">
        <span className="lane-toggle" aria-hidden="true">▸</span>
        {name}
        <span className="lane-gate" data-passed={passed ? 'true' : 'false'}>{passed ? '✓ passed' : '✗ failed'}</span>
        <span className="lane-checks">{exitZero} of {result.checks.length} exit 0{gate.rejected > 0 ? `, ${gate.rejected} rejected` : ''}</span>
        <span className="lane-reason" title={passed ? undefined : result.error?.message}>
          {passed ? '' : gate.reasons.reasons.map(reason => reason.text).join('; ') || result.error?.message}
        </span>
        <span className="lane-screenshots">{screenshots.length === 0 ? 'no screenshots' : `${screenshots.length} ${screenshots.length === 1 ? 'screenshot' : 'screenshots'}`}</span>
        {launchNode !== null && (
          <span className="lane-links" data-testid="lane-files-link">
            <AppLink
              href={runPathname(scope.projectId, scope.workflowId, scope.runId, launchNode.node_id)}
              onNavigate={onNavigate}
              title={`Files are captured on the lane's worker snapshot only: the files the ${lane.worker} lane created or changed, and its worker's report, are on ${launchNode.label}`}
            >
              Files and report ›
            </AppLink>
          </span>
        )}
      </summary>
      <VerifiedEvidence scope={scope} result={result} phase="candidate" testId={`lane-result-evidence:${lane.worker}`} declared={declared} attemptStart={attemptStart} />
    </details>
  )
}

/**
 * The combined candidate's lanes (docs/PRD_VIEWER_UX.md 4.6): a table of every lane verified on one revision, failing lanes
 * first and open, passing lanes closed, each expanding to its own checks and screenshots.
 */
export function CandidateLanes({ scope, lanes, launchNodeOf, declaredOf, attemptStart, stamp, onNavigate }: {
  scope: RunScope
  lanes: LaneEntry[]
  launchNodeOf: LaneContext['launchNodeOf']
  declaredOf: LaneContext['declaredOf']
  attemptStart: string | null
  stamp: string
  onNavigate: (pathname: string) => void
}) {
  const { results } = useRunResults(scope, useMemo(() => lanes.map(entry => entry.result_uri), [lanes]), stamp)
  // Failing lanes first, then lanes still loading, then passing ones; the plan's order otherwise.
  const rank = (entry: LaneEntry) => {
    const result = results.get(entry.result_uri)
    return result === undefined ? 1 : evidenceOf(result).passed ? 2 : 0
  }
  const sorted = lanes.map((entry, index) => ({ entry, index })).sort((a, b) => rank(a.entry) - rank(b.entry) || a.index - b.index).map(item => item.entry)
  const context: LaneContext = { scope, launchNodeOf, declaredOf, attemptStart, stamp, onNavigate }
  return (
    <NodeSection sectionKey="lanes" title="Lanes">
      <div className="lane-results" data-testid="lane-results">
        <div className="lane-results-head" aria-hidden="true">
          <span />
          <span>Lane</span>
          <span>Gate</span>
          <span>Checks</span>
          <span>Reason</span>
          <span>Screenshots</span>
          <span />
        </div>
        {sorted.map(lane => <LaneResult key={lane.worker} lane={lane} context={context} />)}
      </div>
    </NodeSection>
  )
}
