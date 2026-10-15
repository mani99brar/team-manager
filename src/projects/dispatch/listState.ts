/**
 * The shown run list's state, read from the URL search App passes down and written back through a history replace: the
 * filter bar's controls, the sort, Recent's grouping and "Show older", the feature page's loaded pages. The search box's
 * words are debounced; a pending search is written before the operator leaves the list (App commits it into the departing
 * entry on Back or Forward) and dropped when the URL changes from elsewhere after that.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { DEFAULT_LIST_SEARCH, listSearchString, parseListSearch, type ListSearch } from '../routes.ts'
import { filterActive, type RunFilterState } from '../runFilter.ts'

/** How long the search box waits after a keystroke before it writes the URL. */
export const SEARCH_DEBOUNCE_MS = 250

/** A list's state read from its URL search, with the search box's unwritten words, and the writers of every change. */
export type ListControl = {
  search: ListSearch
  filter: RunFilterState
  active: boolean
  change: (next: Partial<ListSearch>, options?: { text?: boolean }) => void
  /** Writes a pending search at once (Enter, or before the operator leaves the list). */
  flush: () => void
  clear: () => void
}

/**
 * The list state of the page shown: read from the URL search App passes down (the one source of truth), every change written
 * back through `onSearch` (a history replace), the search box's words debounced. App flushes a pending search before Back
 * or Forward changes the list; one still pending when the URL changes from elsewhere is dropped, never written late.
 */
export function useListState(search: string, pathname: string | null, onSearch: (pathname: string, search: string) => void): ListControl {
  const parsed = useMemo(() => parseListSearch(search), [search])
  const [draft, setDraft] = useState<{ base: string; q: string } | null>(null)
  const pending = useRef<{ pathname: string; search: string } | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const write = useRef(onSearch)
  useEffect(() => { write.current = onSearch }, [onSearch])
  const cancel = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current)
    timer.current = null
    pending.current = null
  }, [])
  const flush = useCallback(() => {
    const next = pending.current
    cancel()
    if (next !== null) write.current(next.pathname, next.search)
  }, [cancel])
  // The URL changed without this list writing it: a pending search belongs to the list it was typed in, so it is dropped.
  useEffect(() => { cancel() }, [search, pathname, cancel])
  // Words typed against an earlier search are stale once the URL moved on (written, or changed from elsewhere).
  // The base carries the pathname too: two bare lists share the empty search, and words typed in one never show in the other.
  const base = `${pathname ?? ''}?${search}`
  if (draft !== null && draft.base !== base) setDraft(null)
  const q = draft !== null && draft.base === base ? draft.q : parsed.q
  const current: ListSearch = useMemo(() => ({ ...parsed, q }), [parsed, q])
  const change = useCallback((next: Partial<ListSearch>, options: { text?: boolean } = {}) => {
    if (pathname === null) return
    const text = listSearchString({ ...current, ...next })
    if (options.text) {
      setDraft({ base, q: next.q ?? current.q })
      if (timer.current !== null) clearTimeout(timer.current)
      pending.current = { pathname, search: text }
      timer.current = setTimeout(flush, SEARCH_DEBOUNCE_MS)
      return
    }
    cancel()
    setDraft(null)
    write.current(pathname, text)
  }, [pathname, current, base, flush, cancel])
  const clear = useCallback(() => change({ q: '', status: [], phase: null, date: DEFAULT_LIST_SEARCH.date }), [change])
  const filter: RunFilterState = useMemo(() => ({ q: current.q, status: current.status, phase: current.phase, date: current.date, sort: current.sort }), [current])
  const active = filterActive(filter)
  return { search: current, filter, active, change, flush, clear }
}

