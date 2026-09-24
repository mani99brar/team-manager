/**
 * The run-scoped cache of immutable evidence (docs/PRD_VIEWER_UX.md 7): worker and candidate results (`results/<lane>/<k>`)
 * and recorded reviews (`reviews/<n>`) never change once served, so each URI is read once and kept for as long as the page
 * lives, shared by the run page's Now banner, the node pages and their attempt strips. Only the run detail, its events and
 * its inputs poll. A URI that answered 404 or failed is asked again when the caller's `stamp` changes: a Refresh, or new
 * events, after which a result that did not exist yet may.
 */
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import {
  fetchReviewResult, fetchWorkerResult, NOT_RECORDED, orNotRecorded, ProjectsApiError, scopedResultPath, scopedReviewPath,
  type ReviewResult, type RunScope, type WorkerResult,
} from './api.ts'
import type { Resource } from './useResource.ts'

type Entry =
  | { status: 'ready'; value: unknown }
  /** A 404: not there (yet); asked again under another stamp. */
  | { status: 'absent'; error: unknown; stamp: string }
  | { status: 'failed'; error: unknown; stamp: string }

/** Enough for every attempt of a long run's steps; the oldest entries go first. */
const CACHE_LIMIT = 400
const cache = new Map<string, Entry>()
const inflight = new Set<string>()
const listeners = new Set<() => void>()
let version = 0

function settle(key: string, entry: Entry) {
  cache.delete(key)
  cache.set(key, entry)
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!)
  version += 1
  listeners.forEach(listener => listener())
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

type Fetcher = (uri: string) => Promise<unknown>

/** Fetches every URI the cache does not hold under this stamp; re-renders whenever any entry settles. */
function useCached(kind: 'result' | 'review', uris: readonly string[], stamp: string, fetcher: Fetcher): (uri: string) => Entry | undefined {
  const current = useSyncExternalStore(subscribe, () => version, () => version)
  const key = uris.join('\n')
  useEffect(() => {
    for (const uri of key === '' ? [] : key.split('\n')) {
      const cacheKey = `${kind}:${uri}`
      const known = cache.get(cacheKey)
      if (inflight.has(cacheKey) || (known && (known.status === 'ready' || known.stamp === stamp))) continue
      inflight.add(cacheKey)
      fetcher(uri).then(
        value => settle(cacheKey, { status: 'ready', value }),
        (error: unknown) => settle(cacheKey, error instanceof ProjectsApiError && error.notFound ? { status: 'absent', error, stamp } : { status: 'failed', error, stamp }),
      ).finally(() => inflight.delete(cacheKey))
    }
    // The fetcher is rebuilt per render; the scope it closes over is part of every URI.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, key, stamp])
  // `current` re-reads the cache whenever an entry settles.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useCallback((uri: string) => cache.get(`${kind}:${uri}`), [kind, current])
}

/** A result URI outside this run's results route is never fetched; it reads as absent. */
function resultFetcher(scope: RunScope): Fetcher {
  return uri => {
    const path = scopedResultPath(scope, uri)
    if (path === null) return Promise.reject(new ProjectsApiError('http', `The result link ${uri} is outside this run's results route.`, uri, { status: 404 }))
    return fetchWorkerResult(scope, path)
  }
}

/**
 * Several results at once: those that loaded, and how many were never answered yet. A result that answered 404 counts as
 * absent, not as loading; another failure counts as settled and is asked again under the next stamp.
 */
export function useRunResults(scope: RunScope, uris: readonly string[], stamp: string): { results: ReadonlyMap<string, WorkerResult>; pending: number } {
  const read = useCached('result', uris, stamp, resultFetcher(scope))
  const key = uris.join('\n')
  return useMemo(() => {
    const results = new Map<string, WorkerResult>()
    let pending = 0
    for (const uri of key === '' ? [] : key.split('\n')) {
      const entry = read(uri)
      if (entry?.status === 'ready') results.set(uri, entry.value as WorkerResult)
      else if (!entry) pending += 1
    }
    return { results, pending }
  }, [key, read])
}

/** A settled failure stays shown while a later stamp asks again, like a failed background reload. */
function asResource<T>(entry: Entry | undefined): Resource<T> {
  if (entry?.status === 'ready') return { status: 'ready', data: entry.value as T }
  if (entry) return { status: 'error', error: entry.error }
  return { status: 'loading' }
}

/** One result, as a resource: a node's own result, where a 404 is an error to show rather than an absence. `reload` asks again. */
export function useRunResult(scope: RunScope, uri: string | null, stamp: string): { state: Resource<WorkerResult>; reload: () => void } {
  const [retry, setRetry] = useState(0)
  const full = `${stamp}:${retry}`
  const read = useCached('result', uri === null ? [] : [uri], full, resultFetcher(scope))
  const reload = useCallback(() => setRetry(previous => previous + 1), [])
  return { state: uri === null ? { status: 'idle' } : asResource<WorkerResult>(read(uri)), reload }
}

/** The recorded review, read once per URI; a run whose export predates reviews has none (null). */
export function useRunReview(scope: RunScope, uri: string | null, stamp: string): Resource<ReviewResult | null> {
  const fetcher: Fetcher = reviewUri => {
    const path = scopedReviewPath(scope, reviewUri)
    if (path === null) return Promise.reject(new ProjectsApiError('http', `The review link ${reviewUri} is outside this run's reviews route.`, reviewUri, { status: 404 }))
    return orNotRecorded(fetchReviewResult(scope, path), NOT_RECORDED.review)
  }
  const read = useCached('review', uri === null ? [] : [uri], stamp, fetcher)
  return uri === null ? { status: 'idle' } : asResource<ReviewResult | null>(read(uri))
}
