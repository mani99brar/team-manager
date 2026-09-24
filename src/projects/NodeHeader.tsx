import type { ReactNode } from 'react'
import type { Now, SpanStatus, Timeline } from '../../contracts/projects/triage.ts'
import type { ReviewResult, RunDetail } from './api.ts'
import { CommandBlock } from './CommandBlock.tsx'
import { attemptWord, type StripItem, type Timing } from './node/model.ts'
import { AppLink, StatusBadge } from './panels.tsx'
import { executorCategory, executorOf, STATUS_LABEL } from './status.ts'
import { STATUS_GLYPH } from './steps.ts'
import { Time } from './Time.tsx'
import { formatSpan } from './time.ts'

type DefinitionNode = RunDetail['definition']['nodes'][number]
type NodeStatus = RunDetail['snapshot']['nodes'][number]['status']
type Link = { href: string; label: string }
/** The verification that proves a worker's result, with its own status: only a passed one "verified" it. */
type VerifyLink = Link & { status: NodeStatus }

/** The words of a span status, for attempt chips; "ended without a record" has no badge of its own. */
const SPAN_WORD: Record<SpanStatus, string> = { ...Object.fromEntries(Object.entries(STATUS_LABEL).map(([key, label]) => [key, label.toLowerCase()])) as Record<NodeStatus, string>, no_record: 'ended without a record' }
const SPAN_GLYPH: Record<SpanStatus, string> = { ...STATUS_GLYPH, no_record: '?' }

/** How a worker's success names its verification: "verified by" only once the verification passed. */
const VERIFY_WORD: Record<NodeStatus, string> = {
  succeeded: 'verified by',
  failed: 'verification failed at',
  cancelled: 'verification cancelled at',
  pending: 'not verified yet by',
  running: 'verification running at',
  awaiting_approval: 'verification waiting at',
  paused: 'verification paused at',
}

const sentence = (text: string) => (/[.!?]$/.test(text) ? text : `${text}.`)

/**
 * What the step's status means, worded by its cause (docs/PRD_VIEWER_UX.md 8). The pinned phrases stay: "This step failed",
 * "This is not workflow completion". A worker's success links the verification that proves it; a verification that passed
 * after earlier attempts says so, and after which repair.
 */
function statusCause({ kind, status, attempt, cause, repairs, verifyNode, onNavigate }: {
  kind: DefinitionNode['kind']
  status: NodeStatus | 'no_record'
  attempt: number
  /** The latest status message of the shown attempt, humanized; null when none was recorded. */
  cause: string | null
  /** The operator's repairs recorded before the shown attempt. */
  repairs: number[]
  verifyNode: VerifyLink | null
  onNavigate: (pathname: string) => void
}): ReactNode {
  switch (status) {
    case 'pending': return 'Not started: no attempt has run.'
    case 'running': return kind === 'worker' ? 'The native worker session is running or its turn has not been signalled complete.' : `In progress${cause ? `: ${sentence(cause)}` : '.'}`
    case 'awaiting_approval': return 'Waiting for an explicit decision recorded outside this viewer. Not complete.'
    case 'paused': return `Paused${cause ? `: ${sentence(cause)}` : ' with unresolved evidence.'} Not complete.`
    case 'no_record': return 'This attempt ended without a record: a later attempt replaced it before any verdict.'
    case 'cancelled': return 'This step was cancelled.'
    case 'failed': return `This step failed.${cause ? ` ${sentence(cause)}` : ' The run cannot succeed without intervention.'}`
    case 'succeeded':
      if (kind === 'worker') {
        if (!verifyNode) return 'Session ended its turn. This is not workflow completion; verification, review and integration are separate steps.'
        return <>Session ended its turn. This is not workflow completion — {VERIFY_WORD[verifyNode.status]} <AppLink href={verifyNode.href} onNavigate={onNavigate}>{verifyNode.label} ›</AppLink></>
      }
      if (kind === 'integration') return 'This integration step completed.'
      if (attempt > 1) return `Passed on attempt ${attempt}${repairs.length ? ` after operator ${repairs.map(n => `repair ${n}`).join(', ')}` : ''}.`
      return 'This step completed.'
  }
}

/** The timing line's times: start → end, how long, and the setup and check split; `≈` and a tooltip for inferred times. */
function TimingText({ timing, clock }: { timing: Timing; clock: number }) {
  const { start, end, live } = timing
  const elapsed = live && start ? Math.max(0, clock - Date.parse(start.at)) : null
  // A step recorded by one event (the freeze, a verdict with no start) is an instant: one time, no duration.
  const instant = start !== null && end !== null && start.at === end.at
  const took = instant ? null : timing.ms ?? elapsed
  return (
    <>
      {start && <> · <span title={start.note}>{start.source === 'inferred' ? '≈' : ''}<Time iso={start.at} seconds /></span></>}
      {end && !instant && <> → <span title={end.note}>{end.source === 'inferred' ? '≈' : ''}<Time iso={end.at} seconds /></span></>}
      {took !== null && <> · <span className="node-timing-took">{live ? 'running ' : ''}{timing.inferred ? '≈' : ''}{formatSpan(took)}</span></>}
      {timing.setupMs !== null && <> · setup {formatSpan(timing.setupMs)}</>}
      {timing.checksMs !== null && <> · checks {formatSpan(timing.checksMs)}</>}
      {timing.source && <span className="projects-muted node-timing-source"> ({timing.source})</span>}
    </>
  )
}

/**
 * The attempt strip (docs/PRD_VIEWER_UX.md 4.4): each attempt as a chip that links its own page, once its result loaded
 * (a chip whose results are loading or missing is not shown; a step that keeps no results shows its chips unlinked), with
 * the controller's diagnosis (⚑) and the operator's repairs (⚒) between the attempts they concern.
 */
function AttemptStrip({ items, loaded, shown, attemptHref, onNavigate }: {
  items: StripItem[]
  loaded: (uri: string) => boolean
  shown: number
  attemptHref: (attempt: number) => string
  onNavigate: (pathname: string) => void
}) {
  return (
    <div className="node-attempts" data-testid="node-attempts">
      <span className="node-attempts-label">Attempts</span>
      <ul className="node-attempts-list">
        {items.map(item => {
          if (item.kind !== 'attempt') {
            return (
              <li key={`${item.kind}-${item.at}`}>
                <span className={`node-attempt-marker node-attempt-${item.kind}`} data-item={item.kind} title={item.message}>
                  <span aria-hidden="true">{item.kind === 'diagnosis' ? '⚑' : '⚒'}</span> {item.label}
                </span>
              </li>
            )
          }
          const { chip } = item
          const linked = chip.uris.length > 0
          if (linked && !chip.uris.some(loaded)) return null
          const content = (
            <>
              <span className={`status-text-${chip.status === 'no_record' ? 'pending' : chip.status}`} aria-hidden="true">#{chip.attempt} {SPAN_GLYPH[chip.status]}</span>
              {chip.start && <> <Time iso={chip.start.at} /></>}
              {chip.ms !== null && <> · {formatSpan(chip.ms)}</>}
              {chip.reason && <> · <span className="node-attempt-reason" data-testid="node-attempt-reason">{chip.reason}</span></>}
            </>
          )
          const name = `Attempt ${chip.attempt}, ${SPAN_WORD[chip.status]}${chip.ms !== null ? `, ${formatSpan(chip.ms)}` : ''}${chip.reason ? `: ${chip.reason === 'same' ? 'the same reasons as the attempt before' : chip.reason}` : ''}`
          return (
            <li key={`attempt-${chip.attempt}`}>
              {linked ? (
                <AppLink href={attemptHref(chip.attempt)} onNavigate={onNavigate} current={chip.attempt === shown} className="node-attempt-chip" data-item="attempt" data-attempt={chip.attempt} aria-label={name} title={chip.outcome || undefined}>
                  {content}
                </AppLink>
              ) : (
                <span className="node-attempt-chip" data-item="attempt" data-attempt={chip.attempt} aria-label={name} title={chip.outcome || undefined}>{content}</span>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}

type Props = {
  definition: DefinitionNode
  /** The status and attempt shown: the node's own, or the viewed earlier attempt's. */
  status: NodeStatus | 'no_record'
  attempt: number
  timing: Timing | null
  clock: number
  /** What the status is worded by (`causeOf`): the failure's error, the viewed attempt's outcome or its last status message. */
  cause: string | null
  /** A live or failed verification's attempt on its revision and the cap ("1 of 3 on this revision", 5.3); null otherwise. */
  revision: { attempt: number; of: number } | null
  timeline: Timeline | null
  reviewTransport: ReviewResult['reviewer']['transport'] | undefined
  verifyNode: VerifyLink | null
  strip: StripItem[]
  loaded: (uri: string) => boolean
  attemptHref: (attempt: number) => string
  /** The run's likely next step when this node is its focus and the latest attempt is shown; null otherwise. */
  next: Now['next'] | null
  onNavigate: (pathname: string) => void
}

/**
 * The node header (docs/PRD_VIEWER_UX.md 4.4, L1 of section 7): the step, its status and who executed it; the attempt with
 * its times (the source named when it is not an event); what the status means, worded by its cause; the attempt strip
 * when there were several; and the run's next step when this node is where the run stopped.
 */
export function NodeHeader({ definition, status, attempt, timing, clock, cause, revision, timeline, reviewTransport, verifyNode, strip, loaded, attemptHref, next, onNavigate }: Props) {
  const starts = timing?.start ? Date.parse(timing.start.at) : Infinity
  const repairs = (timeline?.markers ?? []).filter(marker => marker.kind === 'repair' && marker.node_id === definition.node_id && Date.parse(marker.at) <= starts).map(marker => marker.repair?.n ?? 0).filter(n => n > 0)
  return (
    <header className="node-header" data-testid="node-header">
      <div className="node-title-row">
        <h3 id="node-detail-title" tabIndex={-1}>{definition.label} <span className="projects-muted node-detail-id">({definition.node_id})</span></h3>
        {status === 'no_record'
          ? <span className="status-badge status-cancelled" data-status="no_record" title="Ended without a record: a later attempt replaced it before any verdict."><span>No record</span></span>
          : <StatusBadge status={status} />}
        <span className="node-executor-line"><span aria-hidden="true">· </span><span data-testid="node-executor" data-executor={executorCategory(definition.kind)}>{executorOf(definition.kind, reviewTransport, definition.node_id)}</span></span>
      </div>
      <p className="node-timing" data-testid="node-timing">
        {attempt === 0 ? <span data-testid="node-attempt">{attemptWord(0)}</span> : <>attempt <span data-testid="node-attempt">{attemptWord(attempt)}</span></>}
        {revision && <span data-testid="node-attempt-revision"> ({revision.attempt} of {revision.of} on this revision)</span>}
        {timing && <TimingText timing={timing} clock={clock} />}
      </p>
      <p className="node-status-meaning" data-testid="node-status-meaning">
        {statusCause({ kind: definition.kind, status, attempt, cause, repairs, verifyNode, onNavigate })}
      </p>
      {strip.length > 0 && <AttemptStrip items={strip} loaded={loaded} shown={attempt} attemptHref={attemptHref} onNavigate={onNavigate} />}
      {next && (
        <div className="node-next" data-testid="node-next">
          <CommandBlock next={next} />
        </div>
      )}
    </header>
  )
}
