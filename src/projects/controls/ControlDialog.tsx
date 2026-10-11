import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { ControlError, postCleanPreview, postControl, readToken } from './client.ts'
import { buildParams, describeFailure, dialogValid, initialValues, newRequestId, pinToken, paramProblem, reasonOf, typedConfirm, type DialogPreset, type DialogValues } from './model.ts'
import { adoptRecord, closeDialog, refreshControls, unpairBrowser, useRunControls } from './store.ts'
import type { WaitingQuestion } from './questions.ts'
import type { CleanPreview, Control, ControlId, ControlScope, ParamSpec } from './types.ts'

const FALLBACK_FOCUS = '[data-testid="controls-button"]'

function Field({ spec, values, set, runId }: { spec: ParamSpec; values: DialogValues; set: (change: Partial<DialogValues>) => void; runId: string }) {
  const id = useId()
  const problem = paramProblem(spec, values, runId)
  switch (spec.kind) {
    case 'choice': {
      const value = spec.name === 'lane' ? values.lane : values.phase
      return (
        <label className="ctl-field" htmlFor={id}>
          <span>{spec.name === 'lane' ? 'Lane' : 'Phase'}</span>
          <select id={id} data-testid={`param-${spec.name}`} value={value} onChange={event => set(spec.name === 'lane' ? { lane: event.target.value } : { phase: event.target.value })}>
            {value === '' && <option value="">Choose…</option>}
            {spec.choices.map(choice => <option key={choice} value={choice}>{choice}</option>)}
          </select>
        </label>
      )
    }
    case 'multi':
      return (
        <fieldset className="ctl-field ctl-multi" data-testid="param-drop">
          <legend>Notes to drop (optional)</legend>
          {spec.choices.map(choice => (
            <label key={choice} className="ctl-check">
              <input type="checkbox" checked={values.drop.includes(choice)} onChange={event => set({ drop: event.target.checked ? [...values.drop, choice] : values.drop.filter(item => item !== choice) })} />
              <span>Note {choice}</span>
            </label>
          ))}
        </fieldset>
      )
    case 'text': {
      const value = values[spec.name]
      return (
        <label className="ctl-field" htmlFor={id}>
          <span>{spec.name === 'text' ? 'Your answer' : 'Reason'}</span>
          <textarea id={id} data-testid={`param-${spec.name}`} rows={3} value={value} maxLength={spec.max_length} onChange={event => set(spec.name === 'text' ? { text: event.target.value } : { reason: event.target.value })} />
          <span className="ctl-hint">{value.length}/{spec.max_length}{value.trim().length < spec.min_length && problem ? ` · ${problem}` : ''}</span>
        </label>
      )
    }
    case 'typed':
      return (
        <label className="ctl-field" htmlFor={id}>
          <span>Type the run id to confirm: <code>{runId}</code></span>
          <input id={id} data-testid="param-confirm_run_id" type="text" autoComplete="off" autoCapitalize="off" spellCheck={false} value={values.confirm_run_id} onChange={event => set({ confirm_run_id: event.target.value })} />
        </label>
      )
  }
}

function Body({ scope, id, preset, questions, onClose }: { scope: ControlScope; id: ControlId; preset: DialogPreset; questions: Record<string, WaitingQuestion>; onClose: () => void }) {
  const state = useRunControls(scope)
  const live = state.data?.controls.find(item => item.id === id)
  const [opened] = useState<Control | undefined>(live)
  const control = live ?? opened
  const [values, setValues] = useState<DialogValues>(() => initialValues(control!, preset))
  const [requestId, setRequestId] = useState(newRequestId)
  const [sending, setSending] = useState(false)
  const [alert, setAlert] = useState<string | null>(null)
  const [preview, setPreview] = useState<CleanPreview | 'loading' | 'failed'>('loading')
  const inFlight = useRef(false)
  // The run state token the dialog was opened on (Clean: the one its dry run is fetched under) is the one posted, not the latest polled
  // one (decisions [L6] 6c); a changed run then answers 409 STATE_CHANGED instead of acting on what the operator never saw.
  const latest = state.data?.run_state_token ?? null
  const [pinned, setPinned] = useState<string | null>(latest)
  const token = pinToken(pinned, latest)
  if (pinned === null && latest !== null) setPinned(latest)
  const previewFor = useRef<string | null>(null)
  const clean = id === 'clean'

  // Clean's dry run comes first (decisions [L4]): its own route, the run state token only, no request_id.
  useEffect(() => {
    if (!clean || token === null || previewFor.current !== null) return
    const secret = readToken()
    if (secret === null) return
    previewFor.current = token
    postCleanPreview(scope, secret, token).then(setPreview, error => {
      const outcome = describeFailure(error)
      setAlert(outcome.message)
      setPreview('failed')
      if (outcome.refresh) void refreshControls(scope)
      previewFor.current = null
    })
  }, [clean, scope, token])

  if (control === undefined) return null
  const unavailable = reasonOf(control)
  const valid = dialogValid(control, values, scope.runId)
  const previewReady = !clean || (typeof preview === 'object' && preview.exitCode === 0)
  const canConfirm = valid && !sending && unavailable === null && previewReady && token !== null

  const confirm = async () => {
    if (inFlight.current || !canConfirm || token === null) return
    const secret = readToken()
    if (secret === null) return
    inFlight.current = true
    setSending(true)
    setAlert(null)
    try {
      const { record } = await postControl(scope, secret, id, { request_id: requestId, run_state_token: token, params: buildParams(control, values) })
      adoptRecord(scope, record)
      onClose()
    } catch (error) {
      const outcome = describeFailure(error)
      setAlert(outcome.message)
      if (outcome.unpair) { unpairBrowser(scope); onClose() }
      if (outcome.refresh) {
        const changed = error instanceof ControlError && error.code === 'STATE_CHANGED'
        // The refreshed controls are on screen now: the next Confirm is made on them, so it carries the refreshed token
        // (Clean's dry run is fetched again under it).
        void refreshControls(scope).then(() => {
          if (!changed) return
          if (clean) { previewFor.current = null; setPreview('loading') }
          setPinned(null)
        })
      }
      // Nothing ran, so the next Confirm is a new request.
      if (outcome.retryable) setRequestId(newRequestId())
    } finally {
      inFlight.current = false
      setSending(false)
    }
  }

  return (
    <>
      <h2 className="ctl-title" id="ctl-dialog-title">{control.label}</h2>
      <p className="ctl-lead" data-testid="dialog-effect"><strong>What it does.</strong> {control.effect}</p>
      {control.not_effect !== null && <p className="ctl-lead" data-testid="dialog-not-effect"><strong>What it does not do.</strong> {control.not_effect}</p>}
      <div className="ctl-cmd">
        <span className="ctl-cmd-h">Command</span>
        <code data-testid="dialog-command">{control.command}</code>
      </div>
      {id === 'answer' && (() => {
        const lane = values.lane || Object.keys(questions)[0]
        const question = lane ? questions[lane] : undefined
        return question === undefined ? null : (
          <blockquote className="ctl-question" data-testid="dialog-question">
            <span className="ctl-cmd-h">{question.n === null ? 'Question' : `Question ${question.n}`}{lane ? ` · lane ${lane}` : ''}</span>
            <p>{question.text}</p>
          </blockquote>
        )
      })()}
      {clean && (
        <div className="ctl-preview" data-testid="clean-preview" aria-live="polite">
          <span className="ctl-cmd-h">Dry run: what it would remove</span>
          {preview === 'loading' ? <p className="ctl-note">Running the dry run…</p>
            : preview === 'failed' ? <p className="ctl-note">The dry run could not be read.</p>
              : <pre>{preview.output.trim() === '' ? '(nothing to remove)' : preview.output}{preview.exitCode !== 0 ? `\n(dry run exited ${preview.exitCode}: Confirm stays off)` : ''}</pre>}
        </div>
      )}
      {control.params.length > 0 && (
        <div className="ctl-fields">
          {control.params.map(spec => <Field key={spec.name} spec={spec} values={values} set={change => setValues(previous => ({ ...previous, ...change }))} runId={scope.runId} />)}
        </div>
      )}
      {unavailable !== null && <p className="ctl-error" role="alert" data-testid="dialog-unavailable">{unavailable}</p>}
      {alert !== null && <p className="ctl-error" role="alert" data-testid="dialog-alert">{alert}</p>}
      <div className="ctl-actions">
        <button type="button" className="button button-small" data-testid="dialog-cancel" onClick={onClose}>Cancel</button>
        <button
          type="button" className={`button button-small ctl-primary${typedConfirm(control) ? ' is-destructive' : ''}`} data-testid="dialog-confirm"
          disabled={!canConfirm} aria-busy={sending} onClick={() => void confirm()}
        >{sending ? 'Sending…' : 'Confirm'}</button>
      </div>
    </>
  )
}

/**
 * The confirmation (docs/PRD_RUN_CONTROLS.md section 6): a native modal dialog like the screenshot one, mounted while a control
 * is chosen. It shows the label, the exact redacted command, what the control does and does not do, and the inputs it needs.
 * One `request_id` per dialog, one request in flight; Escape or Cancel closes it without sending and the opener gets focus back.
 */
export function ControlDialogHost({ scope, questions }: { scope: ControlScope; questions: Record<string, WaitingQuestion> }) {
  const state = useRunControls(scope)
  if (state.dialog === null) return null
  return <DialogShell key={state.dialog.id} scope={scope} id={state.dialog.id} preset={state.dialog.preset} questions={questions} />
}

function DialogShell({ scope, id, preset, questions }: { scope: ControlScope; id: ControlId; preset: DialogPreset; questions: Record<string, WaitingQuestion> }) {
  const ref = useRef<HTMLDialogElement>(null)
  const close = useRef<() => void>(() => undefined)
  useLayoutEffect(() => { close.current = () => closeDialog(scope) })
  useLayoutEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    const opener = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null
    if (!dialog.open) dialog.showModal()
    const onCancel = (event: Event) => {
      event.preventDefault()
      if (dialog.querySelector('[data-testid="dialog-confirm"][aria-busy="true"]') === null) close.current()
    }
    dialog.addEventListener('cancel', onCancel)
    return () => {
      dialog.removeEventListener('cancel', onCancel)
      if (dialog.open) dialog.close()
      const target = opener?.isConnected ? opener : document.querySelector<HTMLElement>(FALLBACK_FOCUS)
      target?.focus()
    }
  }, [])
  return (
    <dialog ref={ref} className="ctl-dialog" aria-labelledby="ctl-dialog-title" data-testid="control-dialog" data-control={id} onClick={event => { if (event.target === event.currentTarget) close.current() }}>
      <Body scope={scope} id={id} preset={preset} questions={questions} onClose={() => closeDialog(scope)} />
    </dialog>
  )
}
