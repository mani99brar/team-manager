import type { WideMark } from './model.ts'

/**
 * The Team view's history marks (docs/PRD_RUN_TEAMS.md 2 and 3.8 "Team view"): which history entry is the drawer entry the view
 * pushed from a drawer-less entry (so Close goes back to it), and which entry opened a drawer from a view-wide search (so the
 * search stays view-wide while it is open). The app writes an opaque key into every entry's `history.state` (`mdManager`) and
 * keeps it across a replace, so a mark is that key; module state, so a remount of the view (switching run views and Back) keeps
 * it, and a reload (a new key) drops it, which only makes Close replace instead of going back. The rules are `closeMode` and
 * `wideSearch` in `model.ts`.
 */

let drawerKey: string | null = null
let wideMark: WideMark | null = null

/** The current history entry's key, or null when the entry carries none (a page outside the app's history). */
export function currentHistoryKey(): string | null {
  if (typeof window === 'undefined') return null
  const state: unknown = window.history.state
  if (state === null || typeof state !== 'object') return null
  const key = (state as { mdManager?: unknown }).mdManager
  return typeof key === 'string' ? key : null
}

/** After an open pushed the drawer entry: marks the (new) current entry as it. */
export function markDrawerEntry(): void {
  drawerKey = currentHistoryKey()
}

/** The drawer entry's key, or null. */
export const drawerEntryKey = (): string | null => drawerKey

/** After an open from a view-wide search: the current entry and its search text; null forgets it. */
export function markWideSearch(q: string | null): void {
  const key = currentHistoryKey()
  wideMark = q === null || key === null ? null : { key, q }
}

export const wideSearchMark = (): WideMark | null => wideMark
