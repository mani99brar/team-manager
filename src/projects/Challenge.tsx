import type { Span } from '../../contracts/projects/triage.ts'
import type { RunInputs } from './api.ts'
import { challengeHeadline } from './node/panels.ts'
import { Time } from './Time.tsx'
import { formatSpan } from './time.ts'

type Challenge = NonNullable<RunInputs['challenge']>
type Concern = Challenge['concerns'][number]

const SEVERITIES: readonly Concern['severity'][] = ['P0', 'P1', 'P2']

const STATUS_WORDING: Record<Challenge['status'], string> = {
  passed: 'Passed: no P0 or P1 concern, so the workers were launched.',
  paused: 'Paused: a P0 or P1 concern stopped the run before any worker was launched. The operator edits the feature files and resumes, or accepts the challenge with a reason, through the workflow CLI.',
  accepted: 'Accepted: the operator overrode the concerns with the reason below, and the workers were launched.',
  disabled: 'Disabled: the feature turned the challenge off, so nothing was challenged.',
}

/** The outcome in words; a passed attempt the plan holds (C8) launched nothing until `resume --launch` released it. */
function statusWording(challenge: Challenge): string {
  if (challenge.status === 'passed' && challenge.hold) {
    return challenge.hold.released_at === null
      ? 'Passed and held: no P0 or P1 concern, and the run holds for the operator to read every concern. No worker launches until the operator releases it through the workflow CLI (resume --launch).'
      : 'Passed and held, then released by the operator, so the workers were launched.'
  }
  return STATUS_WORDING[challenge.status]
}

const KIND_WORDING: Record<Concern['kind'], string> = {
  assumption: 'fragile assumption',
  failure_mode: 'likely failure mode',
  complexity: 'complexity',
  other: 'other',
}

/**
 * The challenge's one headline (docs/PRD_VIEWER_UX.md 4.8): its outcome on its attempt, the P2 notes, when it was decided
 * and how long it took over every attempt ("Passed on attempt 3 · 8 P2 notes · decided 08:50:49 · 11m07s over 3 attempts").
 */
export function ChallengeHeadline({ challenge, spans }: { challenge: Challenge; spans: readonly Span[] }) {
  const { lead, notes, decidedAt, totalMs, attempts } = challengeHeadline(challenge, spans)
  return (
    <p className={`challenge-headline challenge-headline-${challenge.status}`} data-testid="challenge-headline" data-challenge-status={challenge.status}>
      {(challenge.status === 'paused' || (challenge.status === 'passed' && challenge.hold && challenge.hold.released_at === null)) && <span aria-hidden="true">‖ </span>}
      {lead}
      {notes && <> · {notes}</>}
      {decidedAt && <> · decided <Time iso={decidedAt} seconds /></>}
      {totalMs !== null && <> · {formatSpan(totalMs)} over {attempts} {attempts === 1 ? 'attempt' : 'attempts'}</>}
    </p>
  )
}

/**
 * The record behind the headline, folded: the outcome in words, the attempts, the session and the decision time. Earlier
 * attempts' P0/P1 are listed by `ChallengeHistory`; their P2 notes stay in the run directory.
 */
export function ChallengeFacts({ challenge }: { challenge: Challenge }) {
  return (
    <details className="challenge-facts">
      <summary>Outcome, attempts and session</summary>
      <dl className="projects-facts">
        <div><dt>Outcome</dt><dd data-testid="challenge-status"><strong>{challenge.status}</strong> — {statusWording(challenge)}</dd></div>
        {challenge.hold && (
          <div>
            <dt>Hold</dt>
            <dd data-testid="challenge-hold">
              Held <Time iso={challenge.hold.held_at} seconds />
              {challenge.hold.released_at === null ? '; not released yet'
                : <>; released <Time iso={challenge.hold.released_at} seconds /> by the {challenge.hold.released_by ?? 'operator'}{challenge.hold.dropped.length > 0 && `, notes ${challenge.hold.dropped.join(', ')} left out of the workers' prompts`}</>}
            </dd>
          </div>
        )}
        <div>
          <dt>Attempts</dt>
          <dd data-testid="challenge-attempts">
            {challenge.attempts} {challenge.attempts === 1 ? 'attempt' : 'attempts'}; this is attempt {challenge.attempt}
            {challenge.attempts > 1 && <span className="projects-muted">{(challenge.history ?? []).length > 0
              ? " (earlier attempts' P0/P1 are listed below; their full records stay in the run directory)"
              : ' (earlier attempts are kept in the run directory)'}</span>}
          </dd>
        </div>
        <div><dt>Session</dt><dd>{challenge.session_id ? <code>{challenge.session_id}</code> : 'No session recorded'}</dd></div>
        <div><dt>Decided</dt><dd>{challenge.decided_at ? <Time iso={challenge.decided_at} seconds /> : 'Not recorded'}</dd></div>
      </dl>
    </details>
  )
}

/** The operator's reason for accepting the challenge over its concerns, when recorded. */
export function ChallengeAccepted({ challenge }: { challenge: Challenge }) {
  if (challenge.accepted_reason === null) return null
  return (
    <section className="evidence-section" aria-labelledby="challenge-accepted-title" data-testid="challenge-accepted">
      <h4 id="challenge-accepted-title">Accepted by the operator</h4>
      <p className="worker-summary">{challenge.accepted_reason}</p>
    </section>
  )
}

/**
 * The concerns by severity, the most severe first: a P0 or P1 opens in full (it pauses the run unless accepted); a P2 note is
 * one line, expandable to its message and consequence.
 */
export function ChallengeConcerns({ challenge }: { challenge: Challenge }) {
  return (
    <>
      {SEVERITIES.filter(severity => challenge.concerns.some(concern => concern.severity === severity)).map(severity => {
        const concerns = challenge.concerns.filter(concern => concern.severity === severity)
        const note = severity === 'P2'
        return (
          <div key={severity} className="challenge-severity" data-testid="challenge-severity" data-severity={severity}>
            <h5>{severity}{note ? ' notes' : ' (pauses the run unless accepted)'} · {concerns.length} {concerns.length === 1 ? 'concern' : 'concerns'}</h5>
            <ul className="challenge-concern-list">
              {concerns.map((concern, index) => (
                <li key={index}>
                  <details className={`challenge-concern${note ? ' challenge-note' : ''}`} data-testid="challenge-concern" data-severity={concern.severity} data-kind={concern.kind} open={!note}>
                    <summary>
                      <span className="finding-severity">{concern.severity}</span> <span className="projects-muted">{KIND_WORDING[concern.kind]}</span> — <span className="challenge-concern-message">{concern.message}</span>
                    </summary>
                    <p data-testid="challenge-consequence"><strong>Consequence:</strong> {concern.consequence}</p>
                  </details>
                </li>
              ))}
            </ul>
          </div>
        )
      })}
    </>
  )
}

/** The strongest simpler alternative and the cheap experiment that could change the choice. */
export function ChallengeAlternative({ challenge }: { challenge: Challenge }) {
  return (
    <>
      <section className="evidence-section" aria-labelledby="challenge-alternative-title" data-testid="challenge-alternative">
        <h5 id="challenge-alternative-title">Strongest simpler alternative</h5>
        <p>{challenge.simpler_alternative}</p>
      </section>
      <section className="evidence-section" aria-labelledby="challenge-experiment-title" data-testid="challenge-experiment">
        <h5 id="challenge-experiment-title">Cheap experiment that could change the choice</h5>
        <p>{challenge.cheap_experiment}</p>
      </section>
    </>
  )
}

/**
 * The records the shown attempt replaced (C49), in attempt order: each one's outcome, decision time and P0/P1 concerns. An
 * accepted attempt keeps its paused record under the same number. Nothing for a single attempt or a server before 1.7.0.
 */
export function ChallengeHistory({ challenge }: { challenge: Challenge }) {
  const history = challenge.history ?? []
  if (history.length === 0) return null
  return (
    <ol className="challenge-history" data-testid="challenge-history">
      {history.map((entry, index) => (
        <li key={index} data-testid="challenge-history-attempt" data-attempt={entry.attempt} data-challenge-status={entry.status}>
          <h5>Attempt {entry.attempt} · {entry.status} · decided <Time iso={entry.decided_at} seconds /></h5>
          {entry.concerns.length === 0 ? <p className="projects-muted">No P0 or P1 concern.</p> : (
            <ul className="challenge-concern-list">
              {entry.concerns.map((concern, position) => (
                <li key={position} className="challenge-concern" data-testid="challenge-history-concern" data-severity={concern.severity}>
                  <span className="finding-severity">{concern.severity}</span> <span className="projects-muted">{KIND_WORDING[concern.kind]}</span> — <span className="challenge-concern-message">{concern.message}</span>
                  <p><strong>Consequence:</strong> {concern.consequence}</p>
                </li>
              ))}
            </ul>
          )}
        </li>
      ))}
    </ol>
  )
}
