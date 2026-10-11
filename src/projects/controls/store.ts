import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react'
import { ControlError, fetchControls, fetchStatus, readToken, writeToken } from './client.ts'
import type { DialogPreset } from './model.ts'
import type { ControlId, ControlRecord, ControlScope, RunControls } from './types.ts'

/**
 * What the run page knows about its controls (docs/PRD_RUN_CONTROLS.md section 6). One state per run, shared by the identity
 * line's Controls button, the dock's Run button and Controls row and the dialog, so the three never disagree. The pairing
 * token lives in `localStorage` only (client.ts) and is read when a request is made, never held in this state.
 */
export type ControlsState = {
  /** `loading` until the status probe answered; `off` when controls are off (or unreachable): the page is then today's. */
  mode: 'loading' | 'off' | 'on'
  paired: boolean
  data: RunControls | null
  /** Why the controls could not be read, when they could not. */
  problem: string | null
  /** This browser's last action, kept after the list moves on so its result stays on the page. */
  mine: ControlRecord | null
  menuOpen: boolean
  dialog: { id: ControlId; preset: DialogPreset } | null
}

const INITIAL: ControlsState = { mode: 'loading', paired: false, data: null, problem: null, mine: null, menuOpen: false, dialog: null }
const POLL_MS = 5000
const POLL_RUNNING_MS = 1500

type Entry = { scope: ControlScope; state: ControlsState; listeners: Set<() => void>; timer: number | null; reading: boolean }

const entries = new Map<string, Entry>()
let probe: Promise<boolean> | null = null

const keyOf = (scope: ControlScope) => `${scope.projectId}/${scope.workflowId}/${scope.runId}`

function entryFor(scope: ControlScope): Entry {
  const key = keyOf(scope)
  let entry = entries.get(key)
  if (!entry) {
    entry = { scope, state: INITIAL, listeners: new Set(), timer: null, reading: false }
    entries.set(key, entry)
  }
  return entry
}

function patch(entry: Entry, change: Partial<ControlsState>) {
  entry.state = { ...entry.state, ...change }
  for (const listener of entry.listeners) listener()
}

/** The status probe is the only request an unconfigured page makes; it runs once per page load. */
function probeStatus(): Promise<boolean> {
  probe ??= fetchStatus(readToken()).then(status => {
    if (status.enabled && readToken() !== null && !status.paired) writeToken(null)
    return status.enabled
  }, () => false)
  return probe
}

/** Reads the run's controls and records; a refused token unpairs the browser. */
export async function refreshControls(scope: ControlScope): Promise<void> {
  const entry = entryFor(scope)
  const token = readToken()
  if (token === null || entry.reading) return
  entry.reading = true
  try {
    const data = await fetchControls(scope, token)
    const mine = entry.state.mine === null ? null : data.records.find(record => record.record_id === entry.state.mine!.record_id) ?? entry.state.mine
    patch(entry, { data, problem: null, paired: true, mine })
  } catch (error) {
    if (error instanceof ControlError && (error.code === 'TOKEN_INVALID' || error.code === 'TOKEN_REQUIRED')) {
      writeToken(null)
      patch(entry, { paired: false, data: null, problem: null })
    } else {
      patch(entry, { problem: error instanceof Error ? error.message : 'The controls could not be read.' })
    }
  } finally {
    entry.reading = false
  }
}

function schedule(entry: Entry) {
  if (entry.timer !== null) window.clearTimeout(entry.timer)
  entry.timer = null
  if (entry.listeners.size === 0 || entry.state.mode !== 'on' || !entry.state.paired) return
  const running = entry.state.data?.records.some(record => record.status === 'running') || entry.state.mine?.status === 'running'
  entry.timer = window.setTimeout(() => { void refreshControls(entry.scope).then(() => schedule(entry)) }, running ? POLL_RUNNING_MS : POLL_MS)
}

async function start(entry: Entry) {
  const enabled = await probeStatus()
  if (!enabled) { patch(entry, { mode: 'off' }); return }
  const paired = readToken() !== null
  patch(entry, { mode: 'on', paired })
  if (paired) await refreshControls(entry.scope)
  schedule(entry)
}

/** Pairs this browser: the token is checked against the server first and stored only when it matched. */
export async function pairBrowser(scope: ControlScope, token: string): Promise<boolean> {
  const entry = entryFor(scope)
  let status
  try { status = await fetchStatus(token) } catch { return false }
  if (!status.enabled || !status.paired) return false
  writeToken(token)
  patch(entry, { paired: true, menuOpen: true })
  await refreshControls(scope)
  schedule(entry)
  return true
}

export function unpairBrowser(scope: ControlScope) {
  writeToken(null)
  patch(entryFor(scope), { paired: false, data: null, dialog: null })
}

export function setMenu(scope: ControlScope, open: boolean) { patch(entryFor(scope), { menuOpen: open }) }
export function openDialog(scope: ControlScope, id: ControlId, preset: DialogPreset = {}) { patch(entryFor(scope), { dialog: { id, preset }, menuOpen: false }) }
export function closeDialog(scope: ControlScope) { patch(entryFor(scope), { dialog: null }) }

/** A record the server just answered with: shown at once, then followed by the polls. */
export function adoptRecord(scope: ControlScope, record: ControlRecord) {
  const entry = entryFor(scope)
  patch(entry, { mine: record })
  void refreshControls(scope).then(() => schedule(entry))
}

/** The shared controls state of one run page. */
export function useRunControls(scope: ControlScope): ControlsState {
  const { projectId, workflowId, runId } = scope
  const stable = useMemo(() => ({ projectId, workflowId, runId }), [projectId, workflowId, runId])
  const entry = entryFor(stable)
  useEffect(() => {
    const own = entryFor(stable)
    const listener = () => schedule(own)
    own.listeners.add(listener)
    if (own.listeners.size === 1 && own.state.mode === 'loading') void start(own)
    else if (own.state.mode === 'on') { void refreshControls(stable).then(() => schedule(own)) }
    return () => {
      own.listeners.delete(listener)
      if (own.listeners.size === 0 && own.timer !== null) { window.clearTimeout(own.timer); own.timer = null }
    }
  }, [stable])
  const subscribe = useCallback((listener: () => void) => { entry.listeners.add(listener); return () => { entry.listeners.delete(listener) } }, [entry])
  return useSyncExternalStore(subscribe, () => entry.state, () => entry.state)
}

/** Test seam: forgets every run and the probe, as a page load does. */
export function resetControlsStore() {
  for (const entry of entries.values()) if (entry.timer !== null) window.clearTimeout(entry.timer)
  entries.clear()
  probe = null
}
