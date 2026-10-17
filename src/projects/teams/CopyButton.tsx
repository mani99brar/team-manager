import { useEffect, useRef, useState } from 'react'

/**
 * A Copy button for a short text the Team view shows (a lead's resume command, an agent id), following the Sessions pattern
 * (docs/PRD_RUN_TEAMS.md 7): it says "Copied", or "Select to copy" when the clipboard is unavailable, and keeps its own polite
 * live span, so the page's announcer is never used for it.
 */
export function CopyButton({ text, label, what, testId }: { text: string; label: string; what: string; testId?: string }) {
  const [copied, setCopied] = useState<'copied' | 'failed' | null>(null)
  const timer = useRef<number | null>(null)
  useEffect(() => () => { if (timer.current !== null) window.clearTimeout(timer.current) }, [])
  const copy = async () => {
    let outcome: 'copied' | 'failed' = 'copied'
    try {
      if (!navigator.clipboard) throw new Error('The clipboard is unavailable.')
      await navigator.clipboard.writeText(text)
    } catch {
      outcome = 'failed'
    }
    setCopied(outcome)
    if (timer.current !== null) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setCopied(null), 2500)
  }
  return (
    <>
      <button type="button" className="team-copy" aria-label={label} data-testid={testId} onClick={() => void copy()}>
        {copied === 'copied' ? 'Copied' : copied === 'failed' ? 'Select to copy' : 'Copy'}
      </button>
      <span className="team-sr" aria-live="polite">{copied === 'copied' ? `${what} copied` : copied === 'failed' ? `Copy failed; select the ${what.toLowerCase()} to copy it` : ''}</span>
    </>
  )
}
