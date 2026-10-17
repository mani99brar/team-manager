/**
 * What every part of the Team view reads (docs/PRD_RUN_TEAMS.md "Team view" 3 and the node page's Team section 6), handed down
 * once through a React context so the lane panel, the workflow cards, the roster and the drawer do not thread a dozen props.
 * The selection (`query`, `onQuery`) is the URL's on the Team view and the page's own state on a node page; the one clock
 * (`clock`) is the run page's.
 */
import { createContext, useContext, useSyncExternalStore } from 'react'
import type { Teams } from '../../../contracts/projects/teams.ts'
import type { RunDetail, RunScope, Sessions } from '../api.ts'
import type { TeamQuery, TeamQueryMode } from '../routes.ts'
import type { LaneWorker } from './model.ts'

export type TeamContextValue = {
  scope: RunScope
  detail: RunDetail
  teams: Teams
  /** The run inputs' workers (lane, launch step, owned paths); null while the inputs are not loaded or not recorded. */
  workers: readonly LaneWorker[] | null
  /** The run's sessions payload (lead resume commands, whether a lead still runs); null when not read. */
  sessions: Sessions | null
  clock: number
  live: boolean
  query: TeamQuery
  onQuery: (query: TeamQuery, mode: TeamQueryMode) => void
  nodeHref: (nodeId: string) => string
  onNavigate: (pathname: string) => void
  /** On a node page: the Team view link that carries a selection ("Open in Team view ›"); absent on the Team view itself. */
  teamViewHref?: (query: Partial<TeamQuery>) => string
  /** A short prefix for element ids, unique per page region (the Team view and a node page may both render a workflow). */
  idPrefix: string
}

export const TeamContext = createContext<TeamContextValue | null>(null)

/** The Team view's context; the components below only render inside a provider. */
export function useTeam(): TeamContextValue {
  const value = useContext(TeamContext)
  if (value === null) throw new Error('A Team view part rendered outside its TeamContext provider')
  return value
}

/** The phone layout's breakpoint (docs/PRD_RUN_TEAMS.md 3.1): the stage under 720 px, as the switcher's own rule. */
export const PHONE_QUERY = '(max-width: 720px)'

function subscribe(listener: () => void) {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => undefined
  const query = window.matchMedia(PHONE_QUERY)
  query.addEventListener('change', listener)
  return () => query.removeEventListener('change', listener)
}
const snapshot = () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(PHONE_QUERY).matches

/** Whether the page is at phone width: the roster renders cards, the drawer a bottom sheet, Working now folds. */
export function usePhone(): boolean {
  return useSyncExternalStore(subscribe, snapshot, () => false)
}

/** Whether a session's lead still runs: the sessions payload's row, else its step on the snapshot. */
export function leadRunning(context: Pick<TeamContextValue, 'sessions' | 'detail'>, session: { key: string; node_id: string | null }): boolean {
  const row = context.sessions?.sessions.find(entry => entry.key === session.key) ?? null
  if (row !== null) return row.status === 'running'
  const node = session.node_id === null ? null : context.detail.snapshot.nodes.find(entry => entry.node_id === session.node_id) ?? null
  return node?.status === 'running'
}
