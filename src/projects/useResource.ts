import { useCallback, useEffect, useRef, useState } from 'react'

export type Resource<T> =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; data: T }
  | { status: 'error'; error: unknown }

/**
 * Loads one read-only resource identified by `key`. A null key means nothing to load. Changing the key or
 * calling `reload` starts a fresh request and abandons the previous one; a stale response never wins
 * because every settled value is tagged with the request token that produced it.
 * `refreshToken` forces a reload without changing the key (the header Refresh button).
 * `pollToken` reloads in the background (live polling): the last settled value stays shown while it loads, and a
 * failed poll keeps the last loaded data instead of replacing it with an error.
 */
export function useResource<T>(key: string | null, load: (signal: AbortSignal) => Promise<T>, refreshToken = 0, pollToken = 0): { state: Resource<T>; reload: () => void } {
  const [settled, setSettled] = useState<{ base: string; token: string; value: Resource<T> } | null>(null)
  const [attempt, setAttempt] = useState(0)
  const loadRef = useRef(load)
  useEffect(() => { loadRef.current = load }, [load])
  const base = key === null ? null : `${key}\u0000${attempt}\u0000${refreshToken}`
  const token = base === null ? null : `${base}\u0000${pollToken}`

  useEffect(() => {
    if (token === null || base === null) return
    const controller = new AbortController()
    loadRef.current(controller.signal).then(
      data => { if (!controller.signal.aborted) setSettled({ base, token, value: { status: 'ready', data } }) },
      error => {
        if (controller.signal.aborted) return
        setSettled(previous => previous !== null && previous.base === base && previous.value.status === 'ready'
          ? { ...previous, token }
          : { base, token, value: { status: 'error', error } })
      },
    )
    return () => controller.abort()
  }, [base, token])

  const reload = useCallback(() => setAttempt(previous => previous + 1), [])
  const state: Resource<T> = token === null ? { status: 'idle' } : settled !== null && settled.base === base ? settled.value : { status: 'loading' }
  return { state, reload }
}
