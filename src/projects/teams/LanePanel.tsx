import { useState, type ReactNode } from 'react'
import type { TeamAgent, TeamSession, TeamWorkflow } from '../../../contracts/projects/teams.ts'
import type { RunScope, Sessions } from '../api.ts'
import { openDialog, useRunControls } from '../controls/store.ts'
import type { ControlId } from '../controls/types.ts'
import { AppLink } from '../panels.tsx'
import { Glyph } from '../signal/Glyph.tsx'
import { STATUS_LABEL } from '../status.ts'
import { stateTone, toneClass } from '../tone.ts'
import { CopyButton } from './CopyButton.tsx'
import { leadRunning, useTeam } from './context.ts'
import { attentionLine, earlierLine, earlierWanted, earlierWorkflows, idPart, laneNoSessionSentence, ownedPathsOf, sessionSentence, viewSearchOf, type LaneGroup, type ToneLine } from './model.ts'
import { WorkflowCard } from './WorkflowCard.tsx'

/** The note control's id (controls 1.2.0). */
const NOTE_CONTROL: ControlId = 'note'
const LEAD_CAPTION = 'A team workflow resumes only inside the session that ran it; resuming the lead does not restart a killed or interrupted workflow by itself.'

/**
 * "Send a note to the lead" (docs/PRD_RUN_TEAMS.md 7): present only when the paired browser's controls offer the `note` control
 * for this lane; it opens the Controls dialog for `note` with the lane preset (the dialog's title, field and outcomes are 7's).
 */
export function NoteButton({ scope, lane }: { scope: RunScope; lane: string }) {
  const controls = useRunControls(scope)
  if (controls.mode !== 'on' || !controls.paired) return null
  const control = controls.data?.controls.find(entry => entry.id === NOTE_CONTROL) ?? null
  if (control === null || !control.available) return null
  const lanes = control.params.find(spec => spec.name === 'lane')
  if (lanes && lanes.kind === 'choice' && !(lanes.choices as readonly string[]).includes(lane)) return null
  return <button type="button" className="team-button" data-testid="control-note" data-lane={lane} onClick={() => openDialog(scope, control.id, { lane })}>Send a note to the lead</button>
}

/** One lead's resume command: the sessions payload's composed command when it has one, else `claude --resume {session_id}`. */
function LeadCommand({ session, sessions }: { session: TeamSession; sessions: Sessions | null }) {
  const [shown, setShown] = useState(false)
  const row = sessions?.sessions.find(entry => entry.key === session.key) ?? null
  const command = row?.resume?.command ?? `claude --resume ${session.session_id}`
  const bare = row?.resume == null || row.resume.dir === null
  return (
    <div className="team-lead" data-session={session.key}>
      <span className="team-lead-label">{session.label}</span>
      <span className="team-lead-actions">
        <CopyButton text={command} label={`Copy the lead command for ${session.label}`} what="Lead command" />
        <button type="button" className="team-copy" aria-expanded={shown} aria-label={`${shown ? 'Hide' : 'Show'} the lead command for ${session.label}`} onClick={() => setShown(value => !value)}>{shown ? 'Hide command' : 'Show command'}</button>
      </span>
      {shown && <code className="team-command">{command}</code>}
      {bare && <span className="team-caption">run it in the session's worktree</span>}
    </div>
  )
}

/**
 * The Lead commands disclosure (7) on the Team lane head, the node page and the step sheet's Team section: each lead's resume
 * command with Copy and Show command, and the caption. `rows` is the run's sessions payload, whose composed command wins.
 */
export function LeadCommands({ sessions, rows }: { sessions: readonly TeamSession[]; rows: Sessions | null }) {
  if (sessions.length === 0) return null
  return (
    <details className="team-lead-commands" data-testid="team-lead-commands">
      <summary>Lead commands</summary>
      {sessions.map(session => <LeadCommand key={session.key} session={session} sessions={rows} />)}
      <p className="team-caption">{LEAD_CAPTION}</p>
    </details>
  )
}

/** An attention line (3.2) with its glyph; a line with no tone is plain text. */
export function AttentionLine({ line }: { line: ToneLine }) {
  return (
    <p className={`team-attention${line.tone ? ` ${toneClass(line.tone)}` : ''}`} data-testid="team-attention" data-tone={line.tone ?? 'none'}>
      {line.tone && <Glyph tone={line.tone} className="team-glyph" />}<span>{line.text}</span>
    </p>
  )
}

/** The lane's attention line from its sessions. */
function useAttention(sessions: readonly TeamSession[]): ToneLine | null {
  const context = useTeam()
  return attentionLine(sessions, { owned: session => ownedPathsOf(session, context.workers), running: session => leadRunning(context, session), readAt: context.teams.read_at, clock: context.clock })
}

/**
 * A session's workflow cards (3.3) in payload order. With more than four workflows, the older completed or killed ones that are
 * not the latest sit under one "Show {n} earlier workflows" disclosure (in their order, opened in place); the latest and every
 * running, failed or interrupted card stay out of it. The disclosure opens by itself when the selection or a view-wide search
 * names one of the workflows it holds.
 */
function SessionWorkflows({ session, owned, onOpen }: { session: TeamSession; owned: readonly string[] | null; onOpen: (session: TeamSession, workflow: string, agent: TeamAgent) => void }) {
  const { query, wide = false, idPrefix } = useTeam()
  const earlier = earlierWorkflows(session.workflows)
  const tucked = new Set(earlier.map(workflow => workflow.run_id))
  const viewQ = viewSearchOf(query, wide).trim()
  const wanted = earlierWanted(earlier, query, session.key, viewQ)
  // Open at mount when the URL already names a tucked workflow or the search matches one (a deep link, a reload), then once for
  // each new selection or search that does, so the operator can still fold it again.
  const [expanded, setExpanded] = useState(() => wanted)
  const cue = `${query.session}|${query.workflow}|${viewQ}`
  const [seen, setSeen] = useState(cue)
  if (seen !== cue) {
    setSeen(cue)
    if (wanted && !expanded) setExpanded(true)
  }
  const last = session.workflows.length - 1
  const card = (workflow: TeamWorkflow, index: number) => (
    <WorkflowCard key={workflow.run_id} session={session} workflow={workflow} latest={index === last} owned={owned} onOpen={agent => onOpen(session, workflow.run_id, agent)} />
  )
  if (earlier.length === 0) return <>{session.workflows.map(card)}</>
  const id = `${idPrefix}-earlier-${idPart(session.key)}`
  return (
    <>
      <button type="button" className="team-earlier" aria-expanded={expanded} aria-controls={id} data-testid="team-earlier" data-team-select="" onClick={() => setExpanded(value => !value)}>
        <svg className={`team-chev${expanded ? ' open' : ''}`} viewBox="0 0 20 20" aria-hidden="true"><path d="M7 5l5 5-5 5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
        {expanded ? `Hide ${earlier.length} earlier ${earlier.length === 1 ? 'workflow' : 'workflows'}` : earlierLine(earlier.length)}
      </button>
      <div id={id} className="team-earlier-list" hidden={!expanded} data-testid="team-earlier-list">
        {session.workflows.map((workflow, index) => (tucked.has(workflow.run_id) ? card(workflow, index) : null))}
      </div>
      {session.workflows.map((workflow, index) => (tucked.has(workflow.run_id) ? null : card(workflow, index)))}
    </>
  )
}

/**
 * The lane panel's body (3.2), shared by the Team view, the node page's Team section (6) and, in part, the step sheet: one block
 * per session in payload order (a subhead with the session's label when the lane has more than one, and always in Other
 * sessions, whose sessions share no lane): its workflow cards for records `found`, else the sentence of its records. On the node
 * page the attention line and then the section's actions (`actions`) lead it.
 */
export function LaneBody({ sessions, attention, onOpen, actions }: { sessions: readonly TeamSession[]; attention: boolean; onOpen: (session: TeamSession, workflow: string, agent: TeamAgent) => void; actions?: ReactNode }) {
  const context = useTeam()
  const line = useAttention(sessions)
  return (
    <div className="team-lane-body">
      {attention && line && <AttentionLine line={line} />}
      {actions}
      {sessions.map(session => {
        const sentence = sessionSentence(session, leadRunning(context, session))
        const owned = ownedPathsOf(session, context.workers)
        return (
          <div key={session.key} className="team-session" data-testid="team-session" data-session={session.key} data-records={session.records} id={`${context.idPrefix}-session-${idPart(session.key)}`}>
            {(sessions.length > 1 || session.lane === null) && <h4 className="team-session-title">{session.label}</h4>}
            {sentence !== null && <p className="team-session-empty" data-testid="team-session-empty">{sentence}</p>}
            <SessionWorkflows session={session} owned={owned} onOpen={onOpen} />
          </div>
        )
      })}
    </div>
  )
}

/**
 * One lane's panel on the Team view (3.2): a Sheet with a 5 px band in the tone of the lane's launch step; the head (the lane
 * chip, the step's pill, "team · {w} workflows" or "single session", then Send a note to the lead, Open worker page › and Lead
 * commands) with the attention line under it; then the body. A lane whose sessions all have records `none` folds to its head.
 */
export function LanePanel({ group, onOpen }: { group: LaneGroup; onOpen: (session: TeamSession, workflow: string, agent: TeamAgent) => void }) {
  const context = useTeam()
  const step = group.launchNodeId === null ? null : context.detail.snapshot.nodes.find(node => node.node_id === group.launchNodeId) ?? null
  const status = step?.status ?? 'pending'
  const tone = stateTone({ status })
  const workflows = group.sessions.reduce((sum, session) => sum + session.workflows.length, 0)
  const line = useAttention(group.sessions)
  const folded = group.sessions.every(session => session.records === 'none')
  const id = `${context.idPrefix}-lane-${idPart(group.lane)}`
  return (
    <section className={`team-lane ${toneClass(tone)}`} data-testid="team-lane" data-lane={group.lane} aria-labelledby={`${id}-title`}>
      <span className="team-band" aria-hidden="true" />
      <div className="team-lane-head">
        <h3 id={`${id}-title`} className="team-lane-title">
          <span className="team-lane-chip">{group.lane}</span>
          <span className={`team-pill ${toneClass(tone)}`}><Glyph tone={tone} className="team-glyph" />{STATUS_LABEL[status].toLowerCase()}</span>
          <span className="team-lane-kind">{workflows > 0 ? `team · ${workflows} ${workflows === 1 ? 'workflow' : 'workflows'}` : 'single session'}</span>
        </h3>
        <div className="team-lane-actions">
          <NoteButton scope={context.scope} lane={group.lane} />
          {group.launchNodeId !== null && <AppLink href={context.nodeHref(group.launchNodeId)} onNavigate={context.onNavigate} className="team-button team-link">Open worker page ›</AppLink>}
          <LeadCommands sessions={group.sessions} rows={context.sessions} />
        </div>
      </div>
      {line && <AttentionLine line={line} />}
      {group.sessions.length === 0 && <p className="team-session-empty" data-testid="team-session-empty">{laneNoSessionSentence(status, group.launchNodeId === null ? null : context.sessions?.sessions.find(row => row.node_id === group.launchNodeId) ?? null)}</p>}
      {!folded && <LaneBody sessions={group.sessions} attention={false} onOpen={onOpen} />}
    </section>
  )
}
