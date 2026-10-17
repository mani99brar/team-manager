/**
 * Small shared pieces of the GitHub view (docs/PRD_RUN_TEAMS.md 4): a toned pill with its glyph and word, a Copy button that
 * says "Copied" or, when the clipboard is unavailable, selects the text and says "Select to copy", and one copyable command
 * line. Copy only ever writes text the page shows; it acts on nothing.
 */
import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { Glyph } from '../signal/Glyph.tsx'
import type { Tone } from '../tone.ts'

const COPIED_MS = 2500

/** A state pill: glyph and lower-case word in its tone, so no state is shown by colour alone. */
export function Pill({ tone, word, testId }: { tone: Tone; word: string; testId?: string }) {
  return (
    <span className={`gh-pill tone-${tone}`} data-tone={tone} data-testid={testId}>
      <Glyph tone={tone} className="gh-glyph" />
      <span>{word}</span>
    </span>
  )
}

function select(element: HTMLElement) {
  const selection = element.ownerDocument.getSelection()
  if (!selection) return
  const range = element.ownerDocument.createRange()
  range.selectNodeContents(element)
  selection.removeAllRanges()
  selection.addRange(range)
}

/**
 * A Copy button: writes `text` (null keeps it off, with `waiting` beside it), says "Copied" in its live span, or selects
 * `target` and says "Select to copy" when the clipboard cannot be written.
 */
export function CopyButton({ text, target, label = 'Copy', accessibleName, testId, waiting, className = '' }: {
  text: string | null
  target?: RefObject<HTMLElement | null>
  label?: string
  accessibleName?: string
  testId?: string
  waiting?: string
  className?: string
}) {
  const [outcome, setOutcome] = useState<'copied' | 'selected' | null>(null)
  useEffect(() => {
    if (outcome === null) return
    const timer = window.setTimeout(() => setOutcome(null), COPIED_MS)
    return () => window.clearTimeout(timer)
  }, [outcome])
  const copy = async () => {
    if (text === null) return
    try {
      if (!window.isSecureContext || !navigator.clipboard) throw new Error('The clipboard is unavailable.')
      await navigator.clipboard.writeText(text)
      setOutcome('copied')
    } catch {
      if (target?.current) select(target.current)
      setOutcome('selected')
    }
  }
  return (
    <span className={`gh-copy ${className}`.trim()}>
      <button type="button" className="button button-small gh-copy-button" data-testid={testId} aria-label={accessibleName} disabled={text === null} onClick={() => void copy()}>
        {outcome === 'copied' ? 'Copied' : outcome === 'selected' ? 'Select to copy' : label}
      </button>
      <span className="gh-copied" role="status">{text === null && waiting ? waiting : outcome === 'copied' ? 'Copied' : outcome === 'selected' ? 'Select the text to copy it' : ''}</span>
    </span>
  )
}

/** One command in a `command-line` box with its own Copy; `text` null shows `waiting` and keeps Copy off. */
export function CommandBox({ id, text, waiting, children }: { id: string; text: string | null; waiting?: string; children?: ReactNode }) {
  const code = useRef<HTMLElement>(null)
  return (
    <div className="gh-command" data-testid="gh-command" data-command={id}>
      {children}
      {text !== null && (
        <span className="command-line gh-command-line">
          <span className="command-prompt" aria-hidden="true">$ </span>
          <code ref={code} data-testid="gh-command-text">{text}</code>
        </span>
      )}
      <CopyButton text={text} target={code} accessibleName={`Copy command: ${id.replace(/-/g, ' ')}`} testId="gh-command-copy" waiting={waiting} />
    </div>
  )
}
