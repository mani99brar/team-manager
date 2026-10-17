import { useEffect, useMemo, useRef, type ReactNode } from 'react'
import { attemptResultUris } from '../../../contracts/projects/triage.ts'
import type { TeamAgent, TeamSession, TeamWorkflow } from '../../../contracts/projects/teams.ts'
import { AppLink } from '../panels.tsx'
import { Glyph } from '../signal/Glyph.tsx'
import { Time } from '../Time.tsx'
import { formatSpan } from '../time.ts'
import { toneClass } from '../tone.ts'
import { useRunResults } from '../useRunData.ts'
import { CopyButton } from './CopyButton.tsx'
import { useTeam } from './context.ts'
import { agentPhase, agentRanMs, agentState, AT_LAST_READ, isComparablePath, isOutside, noResultText, outsideCopy, quietMinutes } from './model.ts'

const NR = <span className="team-nr">not recorded</span>

function Tile({ label, children }: { label: string; children: ReactNode }) {
  return <div className="team-tile"><dt>{label}</dt><dd>{children}</dd></div>
}

/**
 * The files a lane's worker handed over (its verification's first attempt, the snapshot frozen at handoff), read through the run
 * results' cache; null while not read, for a session that is not a worker's, or where the page cannot open a file.
 */
function useWorkerFiles(session: TeamSession, enabled: boolean): ReadonlySet<string> | null {
  const { scope, detail, resultStamp } = useTeam()
  const verifyId = enabled && session.lane !== null && detail.definition.nodes.some(node => node.node_id === `verify_${session.lane}`) ? `verify_${session.lane}` : null
  const uri = verifyId === null ? null : attemptResultUris(detail, verifyId).find(item => item.attempt === 1)?.uri ?? null
  const uris = useMemo(() => (uri === null ? [] : [uri]), [uri])
  const { results } = useRunResults(scope, uris, resultStamp ?? '')
  const result = uri === null ? null : results.get(uri) ?? null
  return useMemo(() => (result === null ? null : new Set(result.changed_files)), [result])
}

type Props = {
  session: TeamSession
  workflow: TeamWorkflow
  agent: TeamAgent
  owned: readonly string[] | null
  /** The agent before and after this one in the filtered roster; null at either end. */
  previous: TeamAgent | null
  next: TeamAgent | null
  onWalk: (agent: TeamAgent) => void
  onClose: () => void
}

/**
 * The agent drawer (docs/PRD_RUN_TEAMS.md 3.8): a 440 px sheet on the right edge (a 78 % bottom sheet on a phone), the only
 * floating surface of the Team view, `role="dialog" aria-modal="false"` named by its title. Its head (band, `label #index`,
 * state pill, phase · model · attempt, the agent id with Copy, Close), the fact tiles (every null "not recorded"), then Last
 * tool, Asked to do, Returned, Files edited (with `outside` chips), Other providers and the metadata-only footer. Agent text
 * is plain pre-wrapped text: never Markdown or HTML, links never clickable. Opening focuses Close; Escape closes and the caller
 * returns the focus to the row that opened it; Previous and Next walk the filtered roster.
 */
export function AgentDrawer({ session, workflow, agent, owned, previous, next, onWalk, onClose }: Props) {
  const { clock, frozenAt, teams, detail, nodeHref, onNavigate, teamViewHref, idPrefix, currentNodeId, onOpenFile } = useTeam()
  const close = useRef<HTMLButtonElement>(null)
  const body = useRef<HTMLDivElement>(null)
  const key = `${session.key}|${workflow.run_id}|${agent.index}`
  useEffect(() => {
    close.current?.focus()
    if (body.current) body.current.scrollTop = 0
  }, [key])
  const { tone, word } = agentState(agent.state)
  const ran = agentRanMs(agent, clock, frozenAt)
  // An edited path links to the worker page's file (the run page's openFile) when the agent worked in the lead's worktree of a
  // worker and the worker handed that path over; redacted paths and an isolated agent's own worktree stay plain text.
  const workerNode = session.node_id === null ? null : detail.definition.nodes.find(node => node.node_id === session.node_id && node.kind === 'worker') ?? null
  const linkable = onOpenFile !== undefined && workerNode !== null && !agent.isolated
  const handedOver = useWorkerFiles(session, linkable)
  const quiet = quietMinutes(agent, teams.read_at)
  const phase = agentPhase(agent, workflow.phases)
  const titleId = `${idPrefix}-agent-title`
  const files = agent.files_edited
  const outside = owned === null ? [] : files.filter(path => isOutside(path, owned))
  return (
    <aside
      className={`team-drawer ${toneClass(tone)}`}
      data-testid="team-agent-drawer"
      data-session={session.key}
      data-workflow={workflow.run_id}
      data-index={agent.index}
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose() } }}
    >
      <div className="team-drawer-head">
        <span className="team-band" aria-hidden="true" />
        <div className="team-drawer-id">
          <h3 id={titleId} className="team-drawer-title">{agent.label} <span className="team-index">#{agent.index}</span></h3>
          <div className="team-drawer-sub">
            <span className={`team-pill ${toneClass(tone)}`}><Glyph tone={tone} className="team-glyph" />{word}</span>
            {agent.cached && <span className="team-chip">replayed</span>}
            <span>{phase ?? 'no phase recorded'} · {agent.model ?? 'model not recorded'} · attempt {agent.attempt ?? 'not recorded'}</span>
          </div>
          <div className="team-drawer-sub">
            {agent.agent_id === null ? <span className="team-nr">never started</span> : <><code className="team-mono">{agent.agent_id}</code><CopyButton text={agent.agent_id} label={`Copy the agent id of ${agent.label} #${agent.index}`} what="Agent id" /></>}
          </div>
        </div>
        <button ref={close} type="button" className="team-close" aria-label="Close agent details" onClick={onClose}>
          <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 5l10 10M15 5L5 15" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
        </button>
      </div>
      <div ref={body} className="team-drawer-body">
        <dl className="team-tiles">
          <Tile label="Started">{agent.started_at ? <Time iso={agent.started_at} seconds /> : NR}</Tile>
          <Tile label="Last activity">{agent.last_activity_at ? <><Time iso={agent.last_activity_at} seconds />{quiet !== null && <span className="team-quiet" data-testid="team-quiet"> · quiet {quiet}m</span>}</> : NR}</Tile>
          <Tile label="Ran">{ran === null ? NR : agent.state === 'running' ? `for ${formatSpan(ran)}${frozenAt !== null && agent.started_at !== null ? ` ${AT_LAST_READ}` : ''}` : formatSpan(ran)}</Tile>
          <Tile label="Tool calls">{agent.tool_calls ?? NR}</Tile>
          <Tile label="Context">{agent.context_tokens === null ? NR : `${agent.context_tokens.toLocaleString('en-US')} tokens · last context size, not spend`}</Tile>
          <Tile label="Worktree">{agent.isolated ? 'own worktree' : "the lead's worktree"}</Tile>
          {agent.cached && <Tile label="Replayed">replayed from an earlier attempt, not run again</Tile>}
        </dl>
        <section className="team-drawer-sec">
          <h4>Last tool</h4>
          {agent.last_tool === null ? <p className="team-nr-p">not recorded</p> : <p className="team-pre"><code className="team-mono">{agent.last_tool}</code>{agent.last_tool_summary ? ` ${agent.last_tool_summary}` : ''}</p>}
        </section>
        <section className="team-drawer-sec">
          <h4>Asked to do</h4>
          {agent.prompt_preview === null ? <p className="team-nr-p">not recorded</p> : <pre className="team-pre-box" data-testid="team-agent-prompt">{agent.prompt_preview}</pre>}
          <p className="team-caption">first 400 characters, agent text as recorded</p>
        </section>
        <section className="team-drawer-sec">
          <h4>Returned</h4>
          {agent.result_preview === null ? <p className="team-nr-p">{noResultText(agent)}</p> : <pre className="team-pre-box" data-testid="team-agent-result">{agent.result_preview}</pre>}
        </section>
        <section className="team-drawer-sec">
          <h4>Files edited</h4>
          {files.length === 0 ? <p className="team-nr-p">No Edit or Write call is recorded.</p> : (
            <ul className="team-files" data-testid="team-agent-files">
              {files.map(path => (
                <li key={path}>{linkable && workerNode !== null && handedOver !== null && isComparablePath(path) && handedOver.has(path)
                  ? <button type="button" className="team-link-button team-file-link" data-testid="team-agent-file-link" aria-label={`Open ${path} on the worker page`} onClick={() => onOpenFile!(workerNode.node_id, path)}><code className="team-mono">{path}</code></button>
                  : <code className="team-mono">{path}</code>}{outside.includes(path) && <span className="team-outside-chip" data-testid="team-outside-chip"><Glyph tone="fail" className="team-glyph" />outside</span>}</li>
              ))}
              {agent.files_edited_more > 0 && <li className="team-dim">and {agent.files_edited_more} more not listed</li>}
            </ul>
          )}
          {outside.length > 0 && owned !== null && <p className="team-finding tone-fail" data-testid="team-outside-copy"><Glyph tone="fail" className="team-glyph" /><span>{outsideCopy(owned)}</span></p>}
          {owned === null && session.role === 'worker' && <p className="team-caption">This lane's owned paths are not recorded.</p>}
          <p className="team-caption">Only Edit and Write calls are recorded; changes made through shell commands are not. The worker page's Files created or changed is the full diff.</p>
        </section>
        {agent.providers.length > 0 && (
          <section className="team-drawer-sec">
            <h4>Other providers</h4>
            <p className="team-chips">{agent.providers.map(provider => <span key={provider} className="team-chip">{provider}</span>)}</p>
            <p className="team-caption">called through the agent's shell</p>
          </section>
        )}
        <p className="team-caption team-drawer-note">The transcript stays on this machine; this page shows metadata only.</p>
      </div>
      <div className="team-drawer-foot">
        <button type="button" className="team-button" disabled={previous === null} onClick={() => previous && onWalk(previous)}>Previous agent</button>
        <button type="button" className="team-button" disabled={next === null} onClick={() => next && onWalk(next)}>Next agent</button>
        {teamViewHref && <AppLink href={teamViewHref({ session: session.key, workflow: workflow.run_id, agent: agent.index })} onNavigate={onNavigate} className="team-link" data-testid="team-open-in-view">Open in Team view ›</AppLink>}
        {session.node_id !== null && session.node_id !== currentNodeId && <AppLink href={nodeHref(session.node_id)} onNavigate={onNavigate} className="team-link">Open worker page ›</AppLink>}
      </div>
    </aside>
  )
}
