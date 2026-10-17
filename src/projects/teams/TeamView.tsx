import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Now } from '../../../contracts/projects/triage.ts'
import type { TeamAgent, TeamSession } from '../../../contracts/projects/teams.ts'
import { describeApiError, type ReviewResult, type RunDetail, type RunInputs, type RunScope, type Sessions, type Teams } from '../api.ts'
import { LoadingPanel } from '../panels.tsx'
import { teamQuerySearch, type TeamQuery, type TeamQueryMode } from '../routes.ts'
import { formatAgo, type Zone } from '../time.ts'
import type { Resource, ResourceMeta } from '../useResource.ts'
import { TeamContext, useRosterExtras, type TeamContextValue } from './context.ts'
import { DrawerHost } from './DrawerHost.tsx'
import { LaneBody, LanePanel } from './LanePanel.tsx'
import { currentHistoryKey, drawerEntryKey, markDrawerEntry, markWideSearch, wideSearchMark } from './history.ts'
import { closeMode, CONTEXT_NOTE, foldHeldWrite, heldQuery, type HeldWrites, frozenAtOf, headSentence, idPart, laneGroups, laneWorkers, needsALook, openMode, openQuery, otherSessionsLine, otherSessionsPanel, ownedPathsOf, teamChanges, teamClockOf, viewScopeLine, viewSearchOf, wideSearch } from './model.ts'
import { NeedsALook } from './NeedsALook.tsx'
import { WorkingNow } from './WorkingNow.tsx'
import './teams.css'

/**
 * What the Team view reads (docs/PRD_RUN_TEAMS.md 3 "Team view"); every run-level resource is created in `RunView` and
 * passed down, and the one clock ticks there (`now`/`clock`), never here.
 */
export type TeamViewProps = {
  scope: RunScope
  detail: RunDetail
  /** The run inputs: `workers[]` orders the lane panels and gives each lane its owned paths. */
  inputs: Resource<RunInputs | null>
  /** The run's sessions payload (lead session ids, resume commands), null while not loaded or not recorded. */
  sessions: Sessions | null
  /** The teams read: `ready` with null when the server does not serve teams (404 `NOT_RECORDED.teams`). */
  teams: Resource<Teams | null>
  /** How fresh the teams read is ("read 8 s ago", "Last read failed; showing the read from …"). */
  teamsMeta: ResourceMeta
  onRetryTeams: () => void
  /** The recorded review, when it loaded. */
  review: ReviewResult | null
  /** The run's Now situation, when it settled. */
  now: Now | null
  /** The page's one clock (epoch ms), ticking while the run can still change. */
  clock: number
  zone: Zone
  /** Whether the run can still change (not succeeded or cancelled). */
  live: boolean
  /** The selection from the URL's search (session, workflow, agent, state, phase, q). */
  query: TeamQuery
  /** Changes the selection: `push` for opening an agent (Back closes the drawer), `replace` for filters and search. */
  onQuery: (query: TeamQuery, mode: TeamQueryMode) => void
  nodeHref: (nodeId: string) => string
  onNavigate: (pathname: string) => void
  /** The page's single polite announcer (docs/PRD_RUN_TEAMS.md 10). */
  onAnnounce: (message: string) => void
  /** Opens a worker page on one of its changed files (the drawer's edited files link there). */
  onOpenFile?: (nodeId: string, path: string) => void
  /** The run results' cache stamp, for the drawer's read of a worker's frozen file list. */
  resultStamp?: string
}

/** What a caller runs once its write is in the history: `moved` is true when the write pushed a new entry. */
type AfterWrite = (moved: boolean) => void

/**
 * The view's query writer with the drawer entry kept in mind (3.8, final review F7.1, F4.1): a `replace` that clears the agent
 * (the view-wide search, another card's filter) while the current entry is the drawer entry the view pushed goes back instead,
 * then writes the new selection onto the landed entry, so no drawer entry is left behind and one Back still leaves the view.
 * Writes that arrive while that Back is on its way (the next keystrokes, an agent open) are folded into the held writes
 * (`foldHeldWrite`) and the view renders the latest of them at once, so the search field shows every keystroke; when Back lands
 * the selection is written with replace and a held agent open is pushed after it, keeping its push.
 */
function useDrawerAwareQuery(query: TeamQuery, write: (query: TeamQuery, mode: TeamQueryMode) => void): [TeamQuery, (query: TeamQuery, mode: TeamQueryMode, then?: AfterWrite) => void] {
  const held = useRef<HeldWrites<TeamQuery, AfterWrite> | null>(null)
  // The ref folds writes synchronously (two keystrokes in one task); the state renders the latest of them.
  const [shown, setShown] = useState<TeamQuery | null>(null)
  const writeNow = useCallback((next: TeamQuery, mode: TeamQueryMode, then: AfterWrite | null) => {
    const before = currentHistoryKey()
    write(next, mode)
    then?.(mode === 'push' && currentHistoryKey() !== before)
  }, [write])
  const onQuery = useCallback((next: TeamQuery, mode: TeamQueryMode, then?: AfterWrite) => {
    if (held.current !== null) { held.current = foldHeldWrite(held.current, next, mode, then ?? null); setShown(heldQuery(held.current)); return }
    if (mode !== 'replace' || next.agent !== null || closeMode(currentHistoryKey(), drawerEntryKey()) !== 'back') { writeNow(next, mode, then ?? null); return }
    held.current = foldHeldWrite(null, next, mode, then ?? null)
    window.addEventListener('popstate', () => {
      const landed = held.current!
      held.current = null
      if (teamQuerySearch(landed.base) !== window.location.search) write(landed.base, 'replace')
      landed.baseThen?.(false)
      if (landed.push !== null) writeNow(landed.push, 'push', landed.pushThen)
      setShown(null)
    }, { once: true })
    setShown(next)
    window.history.back()
  }, [write, writeNow])
  return [shown ?? query, onQuery]
}

/** The announcer speaks at most every 10 s, coalescing what remains (docs/PRD_RUN_TEAMS.md 10). */
const ANNOUNCE_GAP_MS = 10_000

/**
 * The Team view (docs/PRD_RUN_TEAMS.md 3), a sibling view of the run like Assignment, one column of list-page panels: the head
 * sentence and the context note, Working now, one lane panel per `inputs.workers[]` entry in definition order, then the other
 * sessions (a panel when one has records, else one line), and the agent drawer of the selection. `RunView` renders the identity
 * line, the switcher and the visually hidden `h2#run-view-title` above it. The view states of 3.9: loading, not loaded (with
 * Read again; a failed poll keeps the last read and says so), not served, and no sessions yet.
 */
export function TeamView({ scope, detail, inputs, sessions, teams, teamsMeta, onRetryTeams, clock, live, query: urlQuery, onQuery: writeQuery, nodeHref, onNavigate, onAnnounce, onOpenFile, resultStamp }: TeamViewProps) {
  const [query, onQuery] = useDrawerAwareQuery(urlQuery, writeQuery)
  const data = teams.status === 'ready' ? teams.data : null
  const workers = useMemo(() => laneWorkers(inputs.status === 'ready' ? inputs.data : null), [inputs])
  const opener = useRef<Element | null>(null)
  const { extras, onExtras } = useRosterExtras()

  // The polite announcer: a workflow's status change, then a newly failed agent; nothing on the first read, at most every 10 s.
  // What arrives inside the gap is spoken when the gap ends, even when no later read comes (the run finished, polling stopped).
  const previous = useRef<Teams | null>(null)
  const pending = useRef<string[]>([])
  const spokenAt = useRef(0)
  const flushTimer = useRef<number | null>(null)
  useEffect(() => {
    if (data === null) return
    pending.current.push(...teamChanges(previous.current, data))
    previous.current = data
    if (pending.current.length === 0) return
    const flush = () => {
      flushTimer.current = null
      if (pending.current.length === 0) return
      spokenAt.current = Date.now()
      onAnnounce(pending.current.join('. '))
      pending.current = []
    }
    // A flush already waits for the gap to end: it speaks what is queued then, this read's changes included.
    if (flushTimer.current !== null) return
    const elapsed = Date.now() - spokenAt.current
    if (elapsed >= ANNOUNCE_GAP_MS) { flush(); return }
    flushTimer.current = window.setTimeout(flush, ANNOUNCE_GAP_MS - elapsed)
  }, [data, onAnnounce])
  useEffect(() => () => { if (flushTimer.current !== null) window.clearTimeout(flushTimer.current) }, [])

  // A link that names a session ("Open in Team view ›") scrolls its block into view once the records are there.
  const scrolledTo = useRef<string | null>(null)
  useEffect(() => {
    if (data === null || query.session === null || query.agent !== null || scrolledTo.current === query.session) return
    scrolledTo.current = query.session
    document.getElementById(`team-session-${idPart(query.session)}`)?.scrollIntoView({ block: 'start' })
  }, [data, query.session, query.agent])

  if (teams.status === 'idle' || teams.status === 'loading') return <section className="team-view team-tones" data-testid="team-view" data-state="loading" aria-label="Team"><LoadingPanel>Reading team records…</LoadingPanel></section>
  if (teams.status === 'error') {
    return (
      <section className="team-view team-tones" data-testid="team-view" data-state="not-loaded" aria-label="Team">
        <div className="projects-error team-error" role="alert" data-testid="team-not-loaded">
          <p>Team records were not loaded: {describeApiError(teams.error).replace(/\.$/, '')}.</p>
          <div className="projects-actions"><button type="button" className="button" onClick={onRetryTeams}>Read again</button></div>
        </div>
      </section>
    )
  }
  if (data === null) {
    return (
      <section className="team-view team-tones" data-testid="team-view" data-state="not-served" aria-label="Team">
        <p className="team-empty" data-testid="team-not-served">This server does not serve team records; update md-manager to see teams.</p>
      </section>
    )
  }
  if (data.sessions.length === 0) {
    return (
      <section className="team-view team-tones" data-testid="team-view" data-state="no-sessions" aria-label="Team">
        <p className="team-empty" data-testid="team-no-sessions">No Claude session of this run has started yet.</p>
      </section>
    )
  }

  const teamClock = teamClockOf(data, clock)
  // A drawer opened from a view-wide search names the agent's workflow in the URL; the search stays view-wide (3.5).
  const wide = wideSearch(query, wideSearchMark(), currentHistoryKey())
  const context: TeamContextValue = {
    scope, detail, teams: data, workers, sessions, clock: teamClock, live, frozenAt: frozenAtOf(data, live), query, wide, onQuery, nodeHref, onNavigate, idPrefix: 'team',
    currentNodeId: null, extras, onExtras, onOpenFile, resultStamp,
  }
  const { lanes, other } = laneGroups(data, workers)
  // The view-wide search (3.5): one field over every workflow; it names no session or workflow, so each card applies it.
  const viewQ = viewSearchOf(query, wide)
  const open = (session: TeamSession, workflow: string, agent: TeamAgent) => {
    opener.current = document.activeElement
    // No drawer open: push one entry and mark it (Close goes back to the entry before). A drawer open: replace its entry, so one
    // Close closes the drawer; the mark stays, as the entry's key does (3.8).
    const mode = openMode(query)
    const fromWide = viewQ.trim() !== ''
    const q = query.q
    // Marked once the write is in the history (after a held Back lands, F4.1), and the drawer entry only when the push really
    // made a new entry (a host without pushes replaces, and Close must not go back then).
    onQuery(openQuery(query, session.key, workflow, agent.index, fromWide), mode, moved => {
      if (moved) markDrawerEntry()
      markWideSearch(fromWide ? q : null)
    })
  }
  const failedPoll = teamsMeta.failures > 0 && teamsMeta.settledAt !== null
  const look = needsALook([...lanes.flatMap(group => group.sessions), ...other], { owned: session => ownedPathsOf(session, workers), readAt: data.read_at })
  const search = (q: string) => onQuery({ ...query, session: null, workflow: null, agent: null, state: null, phase: null, q }, 'replace')
  const hasTeams = data.totals.sessions_with_teams > 0
  return (
    <TeamContext.Provider value={context}>
      <section className={`team-view team-tones${query.agent !== null ? ' team-drawer-open' : ''}`} data-testid="team-view" data-state="ready" aria-label="Team">
        <div className="team-head" data-testid="team-head">
          <p className="team-head-line">{headSentence(data, lanes, teamClock)}</p>
          {failedPoll && <p className="team-caption" data-testid="team-read-failed">Last read failed; showing the read from {formatAgo(teamsMeta.settledAt!, teamClock)}.</p>}
          {hasTeams && <p className="team-caption">{CONTEXT_NOTE}</p>}
          {hasTeams && (
            <div className="team-view-search">
              <input className="team-search" type="search" aria-label="Find an agent in every workflow" placeholder="Find an agent" data-testid="team-view-search" value={viewQ} onChange={event => search(event.target.value)} />
              {viewQ.trim() !== '' && <p className="team-scope" role="status" data-testid="team-view-scope">{viewScopeLine(data, viewQ)}</p>}
            </div>
          )}
        </div>
        <NeedsALook rows={look} onOpen={open} />
        <WorkingNow onOpen={open} />
        {lanes.map(group => <LanePanel key={group.lane} group={group} onOpen={open} />)}
        {other.length > 0 && (otherSessionsPanel(other) ? (
          <section className="team-lane team-other" data-testid="team-lane" data-lane="other" aria-labelledby="team-other-title">
            <div className="team-lane-head"><h3 id="team-other-title" className="team-lane-title">Other sessions</h3></div>
            <LaneBody sessions={other} attention={false} onOpen={open} />
          </section>
        ) : <p className="team-caption" data-testid="team-other-line">{otherSessionsLine(other.length)}</p>)}
        <DrawerHost opener={opener} history />
      </section>
    </TeamContext.Provider>
  )
}
