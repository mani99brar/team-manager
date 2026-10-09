/** Where the live dock's open or collapsed state is remembered in this browser; the page works the same without it. */
export const LIVE_DOCK_STORAGE_KEY = 'mdm.projects.liveDock'

export function readDockOpen(): boolean {
  try {
    return window.localStorage.getItem(LIVE_DOCK_STORAGE_KEY) !== 'closed'
  } catch {
    return true
  }
}

export function rememberDockOpen(open: boolean) {
  try {
    window.localStorage.setItem(LIVE_DOCK_STORAGE_KEY, open ? 'open' : 'closed')
  } catch {
    // Not remembered; the dock still opens and closes.
  }
}
