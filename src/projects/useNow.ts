/**
 * Clock hooks for the Projects viewer (docs/PRD_VIEWER_UX.md 5.3 and 6.3): the ticking current time, the page's
 * visibility, which day is today, the remembered Local/UTC preference shared by every shown time, and the instant a run
 * page reads its times against.
 */
import { createContext, useContext, useEffect, useState, useSyncExternalStore } from 'react'
import type { Zone } from './time.ts'

/** The current time, re-read every `intervalMs` while `active` and the page is visible; it does not tick otherwise. */
export function useNow(active: boolean, intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const tick = () => { if (document.visibilityState === 'visible') setNow(Date.now()) }
    const timer = window.setInterval(tick, intervalMs)
    document.addEventListener('visibilitychange', tick)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', tick)
    }
  }, [active, intervalMs])
  return now
}

/** Whether the page is visible, and since when: the moment it last became visible, or the first render. */
export function usePageVisibility(): { visible: boolean; since: number } {
  const [state, setState] = useState(() => ({ visible: document.visibilityState === 'visible', since: Date.now() }))
  useEffect(() => {
    const update = () => setState({ visible: document.visibilityState === 'visible', since: Date.now() })
    document.addEventListener('visibilitychange', update)
    return () => document.removeEventListener('visibilitychange', update)
  }, [])
  return state
}

// Today, for every time read against it (lists, a run's start): one value for the whole page that changes only when the
// local or the UTC date does. It is re-checked every minute and when the tab becomes visible again, so a page left open
// past midnight relabels its days without re-rendering every second.
const DAY_CHECK_MS = 60_000
let today = Date.now()
const todayListeners = new Set<() => void>()
let dayTimer: number | undefined

const dayOf = (time: number) => {
  const date = new Date(time)
  return `${date.toDateString()}|${date.toISOString().slice(0, 10)}`
}

function checkDay() {
  const now = Date.now()
  if (dayOf(now) === dayOf(today)) return
  today = now
  todayListeners.forEach(listener => listener())
}

function subscribeToday(listener: () => void): () => void {
  todayListeners.add(listener)
  if (todayListeners.size === 1) {
    checkDay()
    dayTimer = window.setInterval(checkDay, DAY_CHECK_MS)
    document.addEventListener('visibilitychange', checkDay)
  }
  return () => {
    todayListeners.delete(listener)
    if (todayListeners.size > 0) return
    window.clearInterval(dayTimer)
    document.removeEventListener('visibilitychange', checkDay)
  }
}

/** An instant of today (epoch milliseconds), for reading which day a time falls on; it changes once the date does. */
export function useToday(): number {
  return useSyncExternalStore(subscribeToday, () => today, () => today)
}

/** Where the Local/UTC choice is remembered in this browser. */
export const TIME_ZONE_STORAGE_KEY = 'mdm.projects.timezone'

// One preference for the whole page, so the toggle switches every shown time at once. Storage can be unavailable (a
// private window, blocked site data): reads then fall back to Local and a choice lasts until the page is left.
let storedZone: Zone | null = null
const zoneListeners = new Set<() => void>()

function currentZone(): Zone {
  if (storedZone === null) {
    try {
      storedZone = window.localStorage.getItem(TIME_ZONE_STORAGE_KEY) === 'utc' ? 'utc' : 'local'
    } catch {
      storedZone = 'local'
    }
  }
  return storedZone
}

function subscribeZone(listener: () => void): () => void {
  zoneListeners.add(listener)
  return () => { zoneListeners.delete(listener) }
}

function setZone(zone: Zone) {
  storedZone = zone
  try {
    window.localStorage.setItem(TIME_ZONE_STORAGE_KEY, zone)
  } catch {
    // Not remembered; the page still switches.
  }
  zoneListeners.forEach(listener => listener())
}

/** The remembered zone every time is shown in, and the setter the toggle uses. */
export function useTimeZone(): [Zone, (zone: Zone) => void] {
  const zone = useSyncExternalStore(subscribeZone, currentZone, () => 'local' as const)
  return [zone, setZone]
}

/** The instant a run page reads its times against (the run's start): a time on another day shows its date. Null reads against today. */
export const TimeReferenceContext = createContext<string | null>(null)

export function useTimeReference(): string | null {
  return useContext(TimeReferenceContext)
}
