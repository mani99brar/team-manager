import { useCallback, useEffect, useRef, useState } from 'react'
import type { Resource } from './resource.ts'

export type { Resource } from './resource.ts'

/** How fresh a resource is (docs/PRD_VIEWER_UX.md 6.3): the live chip's ages, the Refresh button's busy state and the failed-Refresh notice read it. */
export type ResourceMeta = {
  /** When the shown data last loaded successfully (epoch milliseconds); null before the first success. */
  settledAt: number | null
  /** The error of the latest load while loads fail; null once one succeeds. */
  lastError: unknown
  /** Loads that failed since the last success; a failed background load keeps the data shown. */
  failures: number
  /** A Refresh is loading in the background while the previous value stays shown. */
  refreshing: boolean
  /** The error of a Refresh that failed while data was shown, until a later load succeeds; null otherwise. */
  refreshError: unknown
}

type Settled<T> = { base: string; refresh: number; value: Resource<T>; settledAt: number | null; lastError: unknown; failures: number; refreshError: unknown }

/**
 * Loads one read-only resource identified by `key`. A null key means nothing to load. Changing the key or
 * calling `reload` starts a fresh request and abandons the previous one; a stale response never wins
 * because every request is aborted once the next one starts, and a settled value is tagged with the key and attempt
 * that produced it.
 * `refreshToken` (the header Refresh button) and `pollToken` (live polling) both reload in the background: the last
 * settled value stays shown while it loads, and a failed reload keeps the last loaded data instead of replacing it with an
 * error. `meta` says when the data last loaded, how many loads failed since, whether a Refresh is still loading, and
 * whether the last Refresh failed, so the page can say that what it shows may be outdated.
 */
export function useResource<T>(key: string | null, load: (signal: AbortSignal) => Promise<T>, refreshToken = 0, pollToken = 0): { state: Resource<T>; reload: () => void; meta: ResourceMeta } {
  const [settled, setSettled] = useState<Settled<T> | null>(null)
  const [attempt, setAttempt] = useState(0)
  const loadRef = useRef(load)
  useEffect(() => { loadRef.current = load }, [load])
  const base = key === null ? null : `${key}\u0000${attempt}`
  const token = base === null ? null : `${base}\u0000${refreshToken}\u0000${pollToken}`

  useEffect(() => {
    if (token === null || base === null) return
    const controller = new AbortController()
    loadRef.current(controller.signal).then(
      data => {
        if (controller.signal.aborted) return
        setSettled({ base, refresh: refreshToken, value: { status: 'ready', data }, settledAt: Date.now(), lastError: null, failures: 0, refreshError: null })
      },
      error => {
        if (controller.signal.aborted) return
        setSettled(previous => {
          const same = previous !== null && previous.base === base ? previous : null
          const failures = (same?.failures ?? 0) + 1
          // The first load to settle after a Refresh answers it; a failed poll keeps the outcome of the last Refresh.
          const answersRefresh = same !== null && same.refresh !== refreshToken
          return same !== null && same.value.status === 'ready'
            ? { ...same, refresh: refreshToken, lastError: error, failures, refreshError: answersRefresh ? error : same.refreshError }
            : { base, refresh: refreshToken, value: { status: 'error', error }, settledAt: same?.settledAt ?? null, lastError: error, failures, refreshError: null }
        })
      },
    )
    return () => controller.abort()
  }, [base, token, refreshToken])

  const reload = useCallback(() => setAttempt(previous => previous + 1), [])
  const current = settled !== null && settled.base === base ? settled : null
  const state: Resource<T> = token === null ? { status: 'idle' } : current !== null ? current.value : { status: 'loading' }
  const meta: ResourceMeta = {
    settledAt: current?.settledAt ?? null,
    lastError: current?.lastError ?? null,
    failures: current?.failures ?? 0,
    refreshing: current !== null && current.refresh !== refreshToken,
    refreshError: current?.refreshError ?? null,
  }
  return { state, reload, meta }
}
