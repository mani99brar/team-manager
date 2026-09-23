/**
 * Scrolls a handed-over target (a highlighted task quote, a linked file) into view and keeps it there while the page
 * above it is still loading: results, files and Markdown arrive after the target mounts and would push it away. It stops
 * at the first sign of the reader moving (wheel, touch, key, pointer), after a quiet second without layout changes, or
 * after ten seconds.
 */
const QUIET_MS = 1000
const LIMIT_MS = 10_000
const READER_EVENTS = ['wheel', 'touchstart', 'keydown', 'pointerdown'] as const

export function keepInView(target: Element, options: ScrollIntoViewOptions): () => void {
  const view = target.ownerDocument.defaultView
  if (!view) return () => {}
  let quiet = 0
  const stop = () => {
    observer.disconnect()
    view.clearTimeout(quiet)
    view.clearTimeout(limit)
    for (const type of READER_EVENTS) view.removeEventListener(type, stop, true)
  }
  const scroll = () => {
    if (!target.isConnected) return stop()
    target.scrollIntoView(options)
    view.clearTimeout(quiet)
    quiet = view.setTimeout(stop, QUIET_MS)
  }
  // Content loading above the target grows one of its ancestors (the document itself may keep a fixed-height body).
  const observer = new ResizeObserver(scroll)
  for (let element = target.parentElement; element !== null; element = element.parentElement) observer.observe(element)
  const limit = view.setTimeout(stop, LIMIT_MS)
  for (const type of READER_EVENTS) view.addEventListener(type, stop, { capture: true, passive: true })
  scroll()
  return stop
}
