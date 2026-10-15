/**
 * The runs the operator pinned to Triage ("Add to Triage", decisions.md [O6], [O10]), kept in the browser only: no request
 * is ever made to pin or unpin, the viewer stays read-only toward runs. The store takes the storage object as a parameter,
 * so the unit tests pass a fake. Every storage access is inside try/catch and the store never throws: a missing, unreadable
 * or malformed value reads as no pins, and when the storage throws the pins live in memory for the page session and
 * `saved` turns false (the Pinned section then says so).
 *
 * Persistence: `localStorage` key `md-manager:triage-pins:v1`, a JSON array of `{project_id, workflow_id, run_id, pinned_at}`
 * newest first, at most 50 unique runs (pinning a pinned run leaves one entry; the 51st pin drops the oldest). Storage is per
 * origin, so another port, a tunnel or a private window starts without pins. The module imports no React (the `usePins`
 * hook is in RunRow.tsx), so the DOM-less unit-test type-check never loads React's DOM stubs.
 */
export const PINS_KEY = 'md-manager:triage-pins:v1'
export const PINS_MAX = 50

export type Pin = { project_id: string; workflow_id: string; run_id: string; pinned_at: string }
export type PinTarget = Pick<Pin, 'project_id' | 'workflow_id' | 'run_id'>
/** The part of the Web Storage interface the store uses. */
export type PinStorage = Pick<Storage, 'getItem' | 'setItem'>

const same = (a: PinTarget, b: PinTarget) => a.project_id === b.project_id && a.workflow_id === b.workflow_id && a.run_id === b.run_id
const isText = (value: unknown): value is string => typeof value === 'string' && value.length > 0

/** The stored pins, or null when the value is not a well-formed pin list (read as no pins). */
function parsePins(text: string | null): Pin[] | null {
  if (text === null) return []
  let value: unknown
  try { value = JSON.parse(text) } catch { return null }
  if (!Array.isArray(value)) return null
  const pins: Pin[] = []
  for (const item of value) {
    if (typeof item !== 'object' || item === null) return null
    const { project_id, workflow_id, run_id, pinned_at } = item as Record<string, unknown>
    if (!isText(project_id) || !isText(workflow_id) || !isText(run_id) || !isText(pinned_at)) return null
    const pin = { project_id, workflow_id, run_id, pinned_at }
    if (!pins.some(other => same(other, pin))) pins.push(pin)
  }
  return pins.slice(0, PINS_MAX)
}

export type PinStore = {
  /** The pins, newest first; the same array until they change. */
  list: () => readonly Pin[]
  has: (target: PinTarget) => boolean
  /** Pins a run at the head of the list (a pinned run moves there, once); the oldest pin beyond 50 drops. */
  add: (target: PinTarget) => void
  remove: (target: PinTarget) => void
  toggle: (target: PinTarget) => void
  /** False once the storage could not be read or written: the pins then last for this page session only. */
  saved: () => boolean
  subscribe: (listener: () => void) => () => void
}

/** A pin store over `storage` (null when there is none, as when reading `window.localStorage` itself throws). */
export function createPinStore(storage: PinStorage | null, clock: () => Date = () => new Date()): PinStore {
  let saved = storage !== null
  let pins: readonly Pin[] = []
  if (storage !== null) {
    try { pins = parsePins(storage.getItem(PINS_KEY)) ?? [] } catch { saved = false }
  }
  const listeners = new Set<() => void>()
  const write = (next: readonly Pin[]) => {
    pins = next
    if (storage !== null && saved) {
      try { storage.setItem(PINS_KEY, JSON.stringify(next)) } catch { saved = false }
    }
    for (const listener of [...listeners]) {
      try { listener() } catch { /* a listener's failure never reaches the caller */ }
    }
  }
  const has = (target: PinTarget) => pins.some(pin => same(pin, target))
  const add = (target: PinTarget) => {
    const pin: Pin = { project_id: target.project_id, workflow_id: target.workflow_id, run_id: target.run_id, pinned_at: clock().toISOString() }
    write([pin, ...pins.filter(other => !same(other, pin))].slice(0, PINS_MAX))
  }
  const remove = (target: PinTarget) => { if (has(target)) write(pins.filter(pin => !same(pin, target))) }
  return {
    list: () => pins,
    has,
    add,
    remove,
    toggle: target => (has(target) ? remove(target) : add(target)),
    saved: () => saved,
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
  }
}

let shared: PinStore | null = null

/** The page's one store over `window.localStorage`; every toggle and the Pinned section share it. */
export function pinStore(): PinStore {
  if (shared === null) {
    // Reached through globalThis so the unit tests (which type-check without the DOM) can import this module.
    let storage: PinStorage | null
    try { storage = (globalThis as unknown as { localStorage: PinStorage }).localStorage ?? null } catch { storage = null }
    shared = createPinStore(storage)
  }
  return shared
}
