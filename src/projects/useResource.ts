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
 */
export function useResource<T>(key: string | null, load: (signal: AbortSignal) => Promise<T>, refreshToken = 0): { state: Resource<T>; reload: () => void } {
  const [settled, setSettled] = useState<{ token: string; value: Resource<T> } | null>(null)
  const [attempt, setAttempt] = useState(0)
  const loadRef = useRef(load)
  useEffect(() => { loadRef.current = load }, [load])
  const token = key === null ? null : `${key}\u0000${attempt}\u0000${refreshToken}`

  useEffect(() => {
    if (token === null) return
    const controller = new AbortController()
    loadRef.current(controller.signal).then(
      data => { if (!controller.signal.aborted) setSettled({ token, value: { status: 'ready', data } }) },
      error => { if (!controller.signal.aborted) setSettled({ token, value: { status: 'error', error } }) },
    )
    return () => controller.abort()
  }, [token])

  const reload = useCallback(() => setAttempt(previous => previous + 1), [])
  const state: Resource<T> = token === null ? { status: 'idle' } : settled?.token === token ? settled.value : { status: 'loading' }
  return { state, reload }
}
