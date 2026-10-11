import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { canOpen, controlRows, hasSince } from './model.ts'
import { openDialog, pairBrowser, setMenu, useRunControls } from './store.ts'
import type { ControlScope } from './types.ts'

function PairForm({ scope }: { scope: ControlScope }) {
  const [token, setToken] = useState('')
  const [refused, setRefused] = useState(false)
  const [busy, setBusy] = useState(false)
  const field = useRef<HTMLInputElement>(null)
  useEffect(() => { field.current?.focus() }, [])
  const submit = async () => {
    if (busy || token.trim() === '') return
    setBusy(true)
    const ok = await pairBrowser(scope, token.trim())
    setBusy(false)
    if (!ok) { setRefused(true); setToken(''); field.current?.focus() }
  }
  return (
    <div className="ctl-pair" data-testid="controls-pair">
      <h3 className="ctl-h" id="ctl-pair-title">Pair this browser</h3>
      <p className="ctl-note">Paste the pairing token from the controls token file on the machine that runs the viewer. This browser keeps it; the page never shows it again.</p>
      <label className="ctl-field" htmlFor="ctl-pair-token">
        <span>Pairing token</span>
        <input
          id="ctl-pair-token" ref={field} type="password" autoComplete="off" spellCheck={false} data-testid="pair-token"
          value={token} aria-invalid={refused} aria-describedby={refused ? 'ctl-pair-refused' : undefined}
          onChange={event => { setToken(event.target.value); setRefused(false) }}
          onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void submit() } }}
        />
      </label>
      {refused && <p id="ctl-pair-refused" className="ctl-error" role="alert" data-testid="pair-refused">That token was refused. Check it and try again.</p>}
      <button type="button" className="button button-small ctl-primary" data-testid="pair-submit" disabled={busy || token.trim() === ''} onClick={() => void submit()}>Pair</button>
    </div>
  )
}

function ControlList({ scope }: { scope: ControlScope }) {
  const state = useRunControls(scope)
  const data = state.data
  if (data === null) return <p className="ctl-note" role="status">{state.problem ?? 'Reading the controls…'}</p>
  return (
    <>
      <h3 className="ctl-h" id="ctl-list-title" tabIndex={-1}>Controls</h3>
      <p className="ctl-note">Each one runs the controller's own command as the operator. The controller still refuses what it would refuse in a terminal.</p>
      <ul className="ctl-list" data-testid="controls-list">
        {controlRows(data).map(({ control, reason }) => {
          return (
            <li key={control.id} data-testid={`control-${control.id}`} data-available={control.available} className={control.available ? 'ctl-item' : 'ctl-item is-off'}>
              <button
                type="button" className="ctl-item-button" aria-disabled={!control.available} data-testid={`control-${control.id}-button`}
                onClick={() => { if (canOpen(control)) openDialog(scope, control.id) }}
              >
                <span className="ctl-label">{control.label}</span>
                <span className="ctl-sub" data-testid={control.available ? 'control-effect' : 'control-reason'} data-since={hasSince(reason) ? 'true' : undefined}>{reason ?? control.effect}</span>
              </button>
            </li>
          )
        })}
      </ul>
    </>
  )
}

/**
 * The identity line's Controls button and its list (docs/PRD_RUN_CONTROLS.md section 6). Absent while the status probe is
 * out or controls are off, so a page without controls is exactly today's. A browser without the token sees only "Pair this
 * browser"; a paired one sees all twelve controls, the unavailable ones greyed with the server's reason. On a phone the
 * list is a bottom sheet.
 */
export function ControlsMenu({ scope }: { scope: ControlScope }) {
  const state = useRunControls(scope)
  const root = useRef<HTMLDivElement>(null)
  const open = state.menuOpen
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setMenu(scope, false); root.current?.querySelector<HTMLElement>('[data-testid="controls-button"]')?.focus() }
    }
    const onDown = (event: MouseEvent) => { if (root.current && event.target instanceof Node && !root.current.contains(event.target)) setMenu(scope, false) }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onDown)
    return () => { document.removeEventListener('keydown', onKey); document.removeEventListener('mousedown', onDown) }
  }, [open, scope])
  // Keeps the whole panel inside the viewport (decisions [L6] 4): anchored to the button's left edge in the left half of the
  // page, to its right edge otherwise, then clamped. The phone sheet is fixed and full width, so it is left alone.
  const panel = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (!open) return
    const place = () => {
      const element = panel.current
      const menu = root.current
      if (!element || !menu) return
      if (getComputedStyle(element).position === 'fixed') { element.style.removeProperty('--ctl-left'); return }
      const anchor = menu.getBoundingClientRect()
      const width = element.offsetWidth
      const viewport = document.documentElement.clientWidth
      const wanted = anchor.left + anchor.width / 2 < viewport / 2 ? anchor.left : anchor.right - width
      const x = Math.max(12, Math.min(wanted, viewport - width - 12))
      element.style.setProperty('--ctl-left', `${Math.round(x - anchor.left)}px`)
    }
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [open, state.paired, state.data])
  // Opening the list moves keyboard focus into it (the pairing field focuses itself); Escape returns it to the button.
  useEffect(() => {
    if (!open || !state.paired) return
    const heading = panel.current?.querySelector<HTMLElement>('#ctl-list-title')
    if (heading && !panel.current?.contains(document.activeElement)) heading.focus()
  }, [open, state.paired, state.data])
  if (state.mode !== 'on') return null
  return (
    <div className="ctl-menu" ref={root} data-testid="controls-menu">
      <button
        type="button" className="button button-small ctl-open" data-testid="controls-button" aria-expanded={open} aria-haspopup="dialog" aria-controls="ctl-panel"
        onClick={() => setMenu(scope, !open)}
      >Controls</button>
      {open && (
        <>
          <div className="ctl-scrim" aria-hidden="true" />
          <div id="ctl-panel" ref={panel} className="ctl-panel" role="dialog" aria-label={state.paired ? 'Run controls' : 'Pair this browser'} data-testid="controls-panel">
            <button type="button" className="button button-small ctl-close" data-testid="controls-close" onClick={() => { setMenu(scope, false); root.current?.querySelector<HTMLElement>('[data-testid="controls-button"]')?.focus() }}>Close</button>
            {state.paired ? <ControlList scope={scope} /> : <PairForm scope={scope} />}
          </div>
        </>
      )}
    </div>
  )
}
