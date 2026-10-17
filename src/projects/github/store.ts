/**
 * What the run page knows about its GitHub actions (docs/PRD_RUN_TEAMS.md 4.4 and 4.5): one state per run, shared by the
 * GitHub view's "Publish on GitHub" panel, the banner's next action, the Controls menu's GitHub group and the one dialog, so
 * they never disagree. The actions are read only when run controls are on and this browser is paired (the GET needs the
 * pairing token, read from `localStorage` at each request by the controls client, never held here). It polls every 15 s, and
 * every 1.5 s while a record runs; `ended` counts the records seen to end, so the page reads GitHub again right after one.
 */
import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react'
import { fetchGithubActions, type GithubActionId, type GithubActionRecord, type RunGithubActions, type RunScope } from '../api.ts'
import { ControlError, readToken } from '../controls/client.ts'
import { useRunControls } from '../controls/store.ts'

export type GithubActionsState = {
  data: RunGithubActions | null
  /** Why the actions could not be read, when they could not. */
  problem: string | null
  /** This browser's last action, kept until the server's records list it. */
  mine: GithubActionRecord | null
  dialog: { id: GithubActionId } | null
  /** How many records this page saw end; a change asks `RunView` to read GitHub again. */
  ended: number
}

const INITIAL: GithubActionsState = { data: null, problem: null, mine: null, dialog: null, ended: 0 }
const POLL_MS = 15_000
const POLL_RUNNING_MS = 1500

type Entry = { scope: RunScope; state: GithubActionsState; listeners: Set<() => void>; watchers: number; timer: number | null; reading: boolean; running: Set<string> }

const entries = new Map<string, Entry>()
const keyOf = (scope: RunScope) => `${scope.projectId}/${scope.workflowId}/${scope.runId}`

function entryFor(scope: RunScope): Entry {
  const key = keyOf(scope)
  let entry = entries.get(key)
  if (!entry) {
    entry = { scope, state: INITIAL, listeners: new Set(), watchers: 0, timer: null, reading: false, running: new Set() }
    entries.set(key, entry)
  }
  return entry
}

function patch(entry: Entry, change: Partial<GithubActionsState>) {
  entry.state = { ...entry.state, ...change }
  for (const listener of entry.listeners) listener()
}

/** Counts the records that were running and now are not; remembers the ones still running. */
function noteEnded(entry: Entry, records: readonly GithubActionRecord[]): number {
  let ended = 0
  for (const record of records) {
    if (record.status === 'running') entry.running.add(record.record_id)
    else if (entry.running.delete(record.record_id)) ended += 1
  }
  return ended
}

/** Reads the run's GitHub actions and records now. */
export async function refreshGithubActions(scope: RunScope): Promise<void> {
  const entry = entryFor(scope)
  const token = readToken()
  if (token === null || entry.reading) return
  entry.reading = true
  try {
    const data = await fetchGithubActions(entry.scope, token)
    const mineId = entry.state.mine?.record_id
    const mine = mineId === undefined ? null : data.records.find(record => record.record_id === mineId) ?? entry.state.mine
    const ended = noteEnded(entry, mine !== null && !data.records.some(record => record.record_id === mine.record_id) ? [...data.records, mine] : data.records)
    patch(entry, { data, problem: null, mine, ended: entry.state.ended + ended })
  } catch (error) {
    const message = error instanceof ControlError && error.status === 404
      ? 'This server does not offer GitHub actions.'
      : error instanceof Error ? error.message : 'The GitHub actions could not be read.'
    patch(entry, { problem: message })
  } finally {
    entry.reading = false
  }
}

function schedule(entry: Entry) {
  if (entry.timer !== null) window.clearTimeout(entry.timer)
  entry.timer = null
  if (entry.watchers === 0 || readToken() === null) return
  const running = entry.running.size > 0
  entry.timer = window.setTimeout(() => { void refreshGithubActions(entry.scope).then(() => schedule(entry)) }, running ? POLL_RUNNING_MS : POLL_MS)
}

export function openGithubDialog(scope: RunScope, id: GithubActionId) { patch(entryFor(scope), { dialog: { id } }) }
export function closeGithubDialog(scope: RunScope) { patch(entryFor(scope), { dialog: null }) }

/** A record the server just answered with: shown at once, then followed by the polls. */
export function adoptGithubRecord(scope: RunScope, record: GithubActionRecord) {
  const entry = entryFor(scope)
  const ended = noteEnded(entry, [record]) + (record.status === 'running' ? 0 : 1)
  patch(entry, { mine: record, ended: entry.state.ended + ended })
  void refreshGithubActions(scope).then(() => schedule(entry))
}

/** Reads the state without polling (the dialog host and `RunView`'s refetch); `useGithubActions` polls. */
export function useGithubActionsState(scope: RunScope): GithubActionsState {
  const { projectId, workflowId, runId } = scope
  const entry = useMemo(() => entryFor({ projectId, workflowId, runId }), [projectId, workflowId, runId])
  const subscribe = useCallback((listener: () => void) => { entry.listeners.add(listener); return () => { entry.listeners.delete(listener) } }, [entry])
  return useSyncExternalStore(subscribe, () => entry.state, () => entry.state)
}

/**
 * The shared GitHub actions state of one run page, read and polled while this component is mounted and the browser is
 * paired with controls on; with the controls state it was read under.
 */
export function useGithubActions(scope: RunScope) {
  const controls = useRunControls(scope)
  const state = useGithubActionsState(scope)
  const { projectId, workflowId, runId } = scope
  const active = controls.mode === 'on' && controls.paired
  useEffect(() => {
    if (!active) return
    const entry = entryFor({ projectId, workflowId, runId })
    entry.watchers += 1
    void refreshGithubActions(entry.scope).then(() => schedule(entry))
    return () => {
      entry.watchers -= 1
      if (entry.watchers === 0 && entry.timer !== null) { window.clearTimeout(entry.timer); entry.timer = null }
    }
  }, [active, projectId, workflowId, runId])
  return { controls, state }
}

/** Calls `onEnded` each time this page sees a GitHub action record end (docs/PRD_RUN_TEAMS.md 2 "Polling"). */
export function useGithubActionEnded(scope: RunScope, onEnded: () => void) {
  const { ended } = useGithubActionsState(scope)
  useEffect(() => {
    if (ended > 0) onEnded()
    // Only a newly ended record reads GitHub again; a new callback identity does not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ended])
}
