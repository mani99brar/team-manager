import type { RunInputs } from './api.ts'
import { ErrorPanel, LoadingPanel } from './panels.tsx'
import { formatTime } from './status.ts'
import type { Resource } from './useResource.ts'

type Challenge = NonNullable<RunInputs['challenge']>
type Concern = Challenge['concerns'][number]

const SEVERITIES: readonly Concern['severity'][] = ['P0', 'P1', 'P2']

const STATUS_WORDING: Record<Challenge['status'], string> = {
  passed: 'Passed: no P0 or P1 concern, so the workers were launched.',
  paused: 'Paused: a P0 or P1 concern stopped the run before any worker was launched. The operator edits the feature files and resumes, or accepts the challenge with a reason, through the workflow CLI.',
  accepted: 'Accepted: the operator overrode the concerns with the reason below, and the workers were launched.',
  disabled: 'Disabled: the feature turned the challenge off, so nothing was challenged.',
}

const KIND_WORDING: Record<Concern['kind'], string> = {
  assumption: 'fragile assumption',
  failure_mode: 'likely failure mode',
  complexity: 'complexity',
  other: 'other',
}

/**
 * The design challenge node's page (PRD_PORTABLE_WORKFLOW 4.5 and 4.8): the outcome, the concerns grouped by severity with
 * their consequences, the strongest simpler alternative, the cheap experiment, the attempts and the operator's accepted
 * reason. It is read from the run inputs, which pin the latest `challenge.json`.
 */
export function ChallengePanel({ inputs, onRetry }: { inputs: Resource<RunInputs | null>; onRetry: () => void }) {
  if (inputs.status === 'loading' || inputs.status === 'idle') return <LoadingPanel>Loading the design challenge…</LoadingPanel>
  if (inputs.status === 'error') return <ErrorPanel error={inputs.error} what="The run inputs" onRetry={onRetry} />
  const challenge = inputs.data?.challenge ?? null
  if (challenge === null) {
    return <p className="projects-muted" data-testid="challenge-none">No design challenge was recorded for this run.</p>
  }
  return (
    <div className="challenge" data-testid="challenge" data-challenge-status={challenge.status}>
      <dl className="projects-facts">
        <div><dt>Outcome</dt><dd data-testid="challenge-status"><strong>{challenge.status}</strong> — {STATUS_WORDING[challenge.status]}</dd></div>
        <div>
          <dt>Attempts</dt>
          <dd data-testid="challenge-attempts">
            {challenge.attempts} {challenge.attempts === 1 ? 'attempt' : 'attempts'}; this is attempt {challenge.attempt}
            {challenge.attempts > 1 && <span className="projects-muted"> (earlier attempts are kept in the run directory)</span>}
          </dd>
        </div>
        <div><dt>Session</dt><dd>{challenge.session_id ? <code>{challenge.session_id}</code> : 'No session recorded'}</dd></div>
        <div><dt>Decided</dt><dd>{challenge.decided_at ? formatTime(challenge.decided_at) : 'Not recorded'}</dd></div>
      </dl>

      {challenge.accepted_reason !== null && (
        <section className="evidence-section" aria-labelledby="challenge-accepted-title" data-testid="challenge-accepted">
          <h4 id="challenge-accepted-title">Accepted by the operator</h4>
          <p className="worker-summary">{challenge.accepted_reason}</p>
        </section>
      )}

      <section className="evidence-section" aria-labelledby="challenge-concerns-title" data-testid="challenge-concerns">
        <h4 id="challenge-concerns-title">Concerns</h4>
        {challenge.concerns.length === 0 ? (
          <p className="projects-muted">The challenge raised no concerns.</p>
        ) : SEVERITIES.filter(severity => challenge.concerns.some(concern => concern.severity === severity)).map(severity => {
          const concerns = challenge.concerns.filter(concern => concern.severity === severity)
          return (
            <div key={severity} className="challenge-severity" data-testid="challenge-severity" data-severity={severity}>
              <h5>{severity}{severity === 'P2' ? '' : ' (pauses the run unless accepted)'} · {concerns.length} {concerns.length === 1 ? 'concern' : 'concerns'}</h5>
              <ul className="evidence-list">
                {concerns.map((concern, index) => (
                  <li key={index} data-testid="challenge-concern" data-severity={concern.severity} data-kind={concern.kind}>
                    <p><span className="finding-severity">{concern.severity}</span> <span className="projects-muted">{KIND_WORDING[concern.kind]}</span> — {concern.message}</p>
                    <p data-testid="challenge-consequence"><strong>Consequence:</strong> {concern.consequence}</p>
                  </li>
                ))}
              </ul>
            </div>
          )
        })}
      </section>

      <section className="evidence-section" aria-labelledby="challenge-alternative-title" data-testid="challenge-alternative">
        <h4 id="challenge-alternative-title">Strongest simpler alternative</h4>
        <p>{challenge.simpler_alternative}</p>
      </section>
      <section className="evidence-section" aria-labelledby="challenge-experiment-title" data-testid="challenge-experiment">
        <h4 id="challenge-experiment-title">Cheap experiment that could change the choice</h4>
        <p>{challenge.cheap_experiment}</p>
      </section>
    </div>
  )
}
