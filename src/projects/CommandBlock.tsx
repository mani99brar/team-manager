import { useEffect, useRef, useState } from 'react'
import { COMMAND_CAPTION, COMMAND_LEGEND, type NextStep, type RunbookRef } from '../../contracts/projects/triage.ts'
import { useServedRun } from './LiveStatus.tsx'

/** How long "Copied" stays beside a Copy button. */
const COPIED_MS = 2500
/** The legend once the server serves this run's directory (B3): the RUN= line above the steps sets it. */
const SERVED_LEGEND = 'PY: md-manager\'s .venv/bin/python, run from its checkout. RUN: this run\'s directory, as the first line sets it.'

const runbookText = (ref: RunbookRef) => ref.topic ?? ref.section
const runbookTitle = (refs: RunbookRef[]) => refs.map(ref => `RUNBOOK › ${ref.section}${ref.topic ? ` › ${ref.topic}` : ''}`).join('\n')

/** Selects a command's text, so it can be copied by hand where the clipboard API is unavailable (a non-secure http origin). */
function select(element: HTMLElement) {
  const selection = element.ownerDocument.getSelection()
  if (!selection) return
  const range = element.ownerDocument.createRange()
  range.selectNodeContents(element)
  selection.removeAllRanges()
  selection.addRange(range)
}

/**
 * One copyable command (docs/PRD_VIEWER_UX.md 6.1): the command lives in a `<code>` outside any button, so the viewer offers
 * text to copy, never an action. Copy writes it to the clipboard, or selects it when the clipboard API is unavailable.
 */
function CommandLine({ text, caption, codeTestId = 'now-command', copyTestId = 'copy-command' }: { text: string; caption?: string; codeTestId?: string; copyTestId?: string }) {
  const code = useRef<HTMLElement>(null)
  const [outcome, setOutcome] = useState<'copied' | 'selected' | null>(null)
  useEffect(() => {
    if (outcome === null) return
    const timer = window.setTimeout(() => setOutcome(null), COPIED_MS)
    return () => window.clearTimeout(timer)
  }, [outcome])
  const copy = async () => {
    try {
      if (!window.isSecureContext || !navigator.clipboard) throw new Error('The clipboard is unavailable.')
      await navigator.clipboard.writeText(text)
      setOutcome('copied')
    } catch {
      if (code.current) select(code.current)
      setOutcome('selected')
    }
  }
  return (
    <div className="command-step-body">
      {caption && <span className="command-step-caption">{caption}</span>}
      <span className="command-line"><span className="command-prompt" aria-hidden="true">$ </span><code ref={code} data-testid={codeTestId}>{text}</code></span>
      <button type="button" className="button button-small command-copy" data-testid={copyTestId} aria-label="Copy command" onClick={() => void copy()}>Copy</button>
      <span className="command-copied" role="status">{outcome === 'copied' ? 'Copied' : outcome === 'selected' ? 'Selected: copy it with Ctrl+C' : ''}</span>
    </div>
  )
}

/**
 * The "Likely next step" block (docs/PRD_VIEWER_UX.md 6.1): the step's label and its RUNBOOK section, the `$PY/$RUN` legend,
 * numbered steps where each command has its own Copy button and a text step is plain text, and the one-line honesty
 * caption. A step that needs nothing says so and shows no command unless one is optional. When the server serves the run's
 * directory (B3, `run_dir`), a first copyable `RUN=<run_dir>` line makes every `"$RUN"` command paste-ready.
 */
export function CommandBlock({ next }: { next: NextStep }) {
  const commands = next.steps.some(step => step.kind === 'command')
  const runDir = useServedRun()?.runDir ?? null
  const setRun = runDir !== null && next.steps.some(step => step.kind === 'command' && step.text.includes('$RUN'))
  const lead = next.action === 'required' ? 'Likely next step' : null
  return (
    <div className="command-block" data-testid="now-next" data-action={next.action}>
      <div className="command-label">
        {lead && <strong>{lead}</strong>}
        <span>{lead ? `— ${next.label.charAt(0).toLowerCase()}${next.label.slice(1)}` : next.label}</span>
        {next.runbook.length > 0 && <span className="command-runbook" title={runbookTitle(next.runbook)}>RUNBOOK “{runbookText(next.runbook[0])}”</span>}
        {commands && (
          <details className="command-legend" data-testid="command-legend">
            <summary>$PY/$RUN</summary>
            <span className="command-legend-text">{setRun ? SERVED_LEGEND : COMMAND_LEGEND}</span>
          </details>
        )}
      </div>
      {setRun && (
        <div className="command-run" data-testid="command-run">
          <CommandLine text={`RUN=${runDir}`} caption="First, in the same shell:" codeTestId="run-dir-command" copyTestId="copy-run-dir" />
        </div>
      )}
      {next.steps.length > 0 && (
        <ol className="command-steps">
          {next.steps.map((step, index) => (
            <li key={index} className="command-step" data-testid="now-step" data-kind={step.kind}>
              {step.kind === 'command' ? <CommandLine text={step.text} caption={step.caption} /> : <div className="command-step-body"><span className="command-prose">{step.text}</span></div>}
            </li>
          ))}
        </ol>
      )}
      {next.caveat && <p className="command-caveat">{next.caveat}</p>}
      {commands && <p className="command-caption">{COMMAND_CAPTION}</p>}
    </div>
  )
}
