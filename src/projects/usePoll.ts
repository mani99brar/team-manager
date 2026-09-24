import { useEffect, useState } from 'react'

/** How often a live Projects page re-reads its run state. */
export const POLL_INTERVAL_MS = 5000

/**
 * A counter that ticks every `intervalMs` while `active` and the page is visible, and once more as the page becomes
 * visible again; pass it as a resource's `pollToken` to re-read live state in the background.
 */
export function usePoll(active: boolean, intervalMs = POLL_INTERVAL_MS): number {
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (!active) return
    const next = () => { if (document.visibilityState === 'visible') setTick(previous => previous + 1) }
    const timer = window.setInterval(next, intervalMs)
    document.addEventListener('visibilitychange', next)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', next)
    }
  }, [active, intervalMs])
  return tick
}
