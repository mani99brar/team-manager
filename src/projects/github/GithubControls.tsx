/**
 * The GitHub actions' dialog and the Controls menu's GitHub group (docs/PRD_RUN_TEAMS.md 4.4 "Controls menu" and 4.5
 * "Dialogs"). The dialog reuses the `ControlDialog` shell's behaviour: a native modal `<dialog>` (focus trapped, Escape and
 * Cancel close it without sending, the opener gets focus back; while the action is being sent nothing closes it, and a native
 * close the page could not stop closes the store's dialog too; the focus stays in it, on a pressed Confirm that is aria-disabled,
 * not disabled, through the send and a failed answer, and a close tried mid-send is said in its polite live region, final review
 * F3.1), the `request_id` rule of `nextAttempt` (the same id only for a
 * retry after a lost answer with unchanged fields, so the server's dedup answers it with the first record; a new one after an
 * edit or any answered failure) and the actions' `state_token` from when it opened, so a moved branch answers 409 and the
 * dialog says so. Its parts, in order: title,
 * visibility block, what it does (the server's `effect` and one facts line), what it does not do, what becomes visible (with
 * the commit preview for a push: every unpublished commit with its author, never folded), the fields, the exact command, the
 * typed `owner/name` when asked for, and the confirm button. The title and visibility block stay at the top and the typed
 * name, the outcome and the buttons at the bottom, with one scrolling body between them; on a viewport too short for that, the
 * whole dialog scrolls instead, so the footer is never trapped below the fold. The exact command shows the typed values
 * filled in (the body through a heredoc). The branch facts come from a fresh run GitHub read taken when the dialog opens.
 */
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { fetchRunGithub, postGithubAction, type GithubActionId, type RunGithub, type RunScope } from '../api.ts'
import { ControlError, readToken } from '../controls/client.ts'
import { attemptFingerprint, confirmOff, describeFailure, heldAfterFailure, nextAttempt, SENDING_HINT, type RequestAttempt } from '../controls/model.ts'
import { setMenu, unpairBrowser } from '../controls/store.ts'
import {
  actionNote, BODY_FILE_NOTE, bodyCounter, buildGithubParams, COMMAND_NOTE, confirmLabel, dialogTitle, factsLine, fieldsProblem, filledCommand, hasReviewer,
  initialDialogValues, outcomeSentence, recordShown, unknownLine, PR_BODY_CAPTION, previewHeading, STALE_SENTENCE, toggleReviewer, typedConfirmation, typedMatches, visibilityBlock, type DialogValues,
} from './actions.ts'
import { parseReviewers, short, unpublishedCount } from './model.ts'
import { CopyButton, Pill } from './parts.tsx'
import { adoptGithubRecord, closeGithubDialog, openGithubDialog, refreshGithubActions, useGithubActions, useGithubActionsState } from './store.ts'
import { Glyph } from '../signal/Glyph.tsx'
import './github.css'

const FALLBACK_FOCUS = '[data-testid="controls-button"]'

/**
 * The Controls menu's "GitHub" group: the four actions in contract order, as the server offers them; an unavailable one shows
 * its reason and opens nothing. Choosing one closes the menu and opens the same dialog as the GitHub view's panel. A server
 * that offers no GitHub actions shows nothing here.
 */
export function GithubControlsGroup({ scope }: { scope: RunScope }) {
  const { state } = useGithubActions(scope)
  const data = state.data
  if (data === null) return null
  return (
    <section className="gh-controls-group" data-testid="gh-controls-group" aria-labelledby="gh-controls-title">
      <h3 className="ctl-h" id="gh-controls-title">GitHub</h3>
      <p className="ctl-note">{data.enabled ? 'Each one runs the controller\'s GitHub command as the operator, after a confirmation.' : 'GitHub actions are off on this server.'}</p>
      <ul className="ctl-list">
        {data.actions.map(action => (
          <li key={action.id} data-testid="gh-control" data-action={action.id} data-available={action.available} className={action.available ? 'ctl-item' : 'ctl-item is-off'}>
            <button
              type="button" className="ctl-item-button" aria-disabled={!action.available} data-testid="gh-control-button"
              onClick={() => { if (!action.available) return; setMenu(scope, false); openGithubDialog(scope, action.id) }}
            >
              <span className="ctl-label">{action.label}</span>
              <span className="ctl-sub">{actionNote(action)}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}

/** Mounts the GitHub dialog while an action is chosen (once per run page, beside the Controls menu). */
export function GithubDialogHost({ scope }: { scope: RunScope }) {
  const state = useGithubActionsState(scope)
  if (state.dialog === null) return null
  return <DialogShell key={state.dialog.id} scope={scope} id={state.dialog.id} />
}

/** Whether the dialog's confirm is sending: Escape, Cancel and the backdrop then leave it open. */
const isSending = (dialog: HTMLDialogElement) => dialog.querySelector('[data-testid="gh-dialog-confirm"][aria-busy="true"]') !== null

/**
 * The native modal, opened once per mount: its open/close effect does not depend on the scope object's identity (the identity
 * line builds a new one on every render, every second on a live run), so a parent render never closes, reopens or refetches it.
 * After `showModal` the title takes focus and the body scrolls to its top, so the title and the visibility block are what the
 * operator sees first. A backdrop click closes it only when the press also started on the backdrop (a drag-select that ends
 * outside a field does not), and never while the action is being sent.
 */
function DialogShell({ scope, id }: { scope: RunScope; id: GithubActionId }) {
  const ref = useRef<HTMLDialogElement>(null)
  const scopeRef = useRef(scope)
  const pressed = useRef<EventTarget | null>(null)
  useLayoutEffect(() => { scopeRef.current = scope })
  const close = useCallback(() => closeGithubDialog(scopeRef.current), [])
  // A close tried while the action is sent: the body's live region then says why the dialog stays open (final review F3.1).
  const [blocked, setBlocked] = useState(false)
  useLayoutEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    const opener = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null
    if (!dialog.open) dialog.showModal()
    dialog.querySelector<HTMLElement>('#gh-dialog-title')?.focus({ preventScroll: true })
    const body = dialog.querySelector<HTMLElement>('[data-testid="gh-dialog-body"]')
    if (body) body.scrollTop = 0
    const onCancel = (event: Event) => {
      event.preventDefault()
      if (!isSending(dialog)) closeGithubDialog(scopeRef.current)
      else setBlocked(true)
    }
    // A close the cancel event could not stop (a non-cancelable cancel under the close-watcher rules, a second Escape or a back
    // gesture) still closes the native dialog: the store's dialog closes with it, so the action can be opened again. The close
    // event is queued, so one left over from a remount's own close() (React's strict effects) finds the dialog open again.
    const onNativeClose = () => { if (!dialog.open) closeGithubDialog(scopeRef.current) }
    dialog.addEventListener('cancel', onCancel)
    dialog.addEventListener('close', onNativeClose)
    return () => {
      dialog.removeEventListener('cancel', onCancel)
      dialog.removeEventListener('close', onNativeClose)
      if (dialog.open) dialog.close()
      const target = opener?.isConnected ? opener : document.querySelector<HTMLElement>(FALLBACK_FOCUS)
      target?.focus()
    }
  }, [])
  return (
    <dialog
      ref={ref} className="ctl-dialog gh-dialog" aria-labelledby="gh-dialog-title" data-testid="gh-dialog" data-action={id}
      onPointerDown={event => { pressed.current = event.target }}
      onClick={event => {
        const started = pressed.current
        pressed.current = null
        if (event.target !== event.currentTarget || started !== event.currentTarget) return
        if (isSending(event.currentTarget)) setBlocked(true)
        else close()
      }}
    >
      <DialogBody scope={scope} id={id} onClose={close} blocked={blocked} onBlocked={setBlocked} />
    </dialog>
  )
}

const EMPTY_VALUES: DialogValues = { title: '', body: '', reviewers: '', typed: '' }

function DialogBody({ scope, id, onClose, blocked, onBlocked }: { scope: RunScope; id: GithubActionId; onClose: () => void; blocked: boolean; onBlocked: (on: boolean) => void }) {
  const state = useGithubActionsState(scope)
  // The offers the dialog opened on: their state_token is the one posted, so a branch that moved answers 409.
  const [opened] = useState(() => state.data)
  const action = opened?.actions.find(item => item.id === id)
  const [values, setValues] = useState<DialogValues>(() => (action ? initialDialogValues(action) : EMPTY_VALUES))
  // The last attempt, held only while its answer was lost: a retry with unchanged fields carries the same request_id, so a
  // POST that did reach the controller answers with its first record; an edit or an answered failure starts a new one.
  const held = useRef<RequestAttempt | null>(null)
  const [read, setRead] = useState<RunGithub | 'loading' | 'failed'>('loading')
  const [sending, setSending] = useState(false)
  // Once Confirm was pressed it stays focusable (aria-disabled, `confirmOff`), so a send or a failed answer keeps the focus on it.
  const [pressed, setPressed] = useState(false)
  const sendingHint = useId()
  const [alert, setAlert] = useState<string | null>(null)
  const [stale, setStale] = useState(false)
  const [recordId, setRecordId] = useState<string | null>(null)
  const inFlight = useRef(false)
  const fieldId = useId()
  const { projectId, workflowId, runId } = scope
  useEffect(() => {
    const controller = new AbortController()
    fetchRunGithub({ projectId, workflowId, runId }, controller.signal).then(setRead, () => { if (!controller.signal.aborted) setRead('failed') })
    return () => controller.abort()
  }, [projectId, workflowId, runId])

  if (opened === null || action === undefined) {
    return (
      <>
        <header className="gh-dialog-head"><h2 className="ctl-title" id="gh-dialog-title" tabIndex={-1}>GitHub</h2></header>
        <div className="gh-dialog-body" data-testid="gh-dialog-body"><p className="ctl-note">The GitHub actions are not read yet. Close this and try again.</p></div>
        <footer className="gh-dialog-foot"><div className="ctl-actions"><button type="button" className="button button-small" data-testid="gh-dialog-cancel" onClick={onClose}>Close</button></div></footer>
      </>
    )
  }
  const facts = typeof read === 'object' ? read : null
  const repo = opened.repo ?? facts?.repo.owner_name ?? null
  const repoName = repo ?? 'the repository'
  const visibility = opened.visibility
  const commits = facts ? unpublishedCount(facts.branch) : null
  const block = visibilityBlock(id, repoName, visibility, commits)
  const typed = typedConfirmation(action, visibility)
  const record = recordId === null ? null : state.data?.records.find(item => item.record_id === recordId) ?? (state.mine?.record_id === recordId ? state.mine : null)
  const problem = fieldsProblem(action, values)
  const typedOk = !typed || typedMatches(values.typed, repo)
  const canConfirm = action.available && !stale && !record && !sending && facts !== null && problem === null && typedOk
  const set = (change: Partial<DialogValues>) => setValues(previous => ({ ...previous, ...change }))
  const bodySpec = action.params.find(item => item.name === 'body')
  const titleSpec = action.params.find(item => item.name === 'title')
  const reviewersSpec = action.params.find(item => item.name === 'reviewers')
  const command = filledCommand(action, values)
  const unpublished = facts?.branch.unpublished ?? []

  const confirm = async () => {
    if (inFlight.current || !canConfirm) return
    const token = readToken()
    if (token === null) return
    inFlight.current = true
    setSending(true)
    setPressed(true)
    onBlocked(false)
    setAlert(null)
    const params = buildGithubParams(action, values)
    const attempt = nextAttempt(held.current, attemptFingerprint(opened.state_token, params))
    held.current = attempt
    try {
      const answer = await postGithubAction(scope, id, { request_id: attempt.id, state_token: opened.state_token, params }, token)
      held.current = null
      adoptGithubRecord(scope, answer)
      setRecordId(answer.record_id)
    } catch (error) {
      held.current = heldAfterFailure(attempt, error)
      if (error instanceof ControlError && error.code === 'STATE_CHANGED') {
        setStale(true)
        setAlert(STALE_SENTENCE)
        void refreshGithubActions(scope)
      } else {
        const outcome = describeFailure(error)
        setAlert(outcome.message)
        if (outcome.unpair) { unpairBrowser(scope); onClose() }
        if (outcome.refresh) void refreshGithubActions(scope)
      }
    } finally {
      inFlight.current = false
      setSending(false)
    }
  }

  return (
    <>
      <header className="gh-dialog-head">
        <h2 className="ctl-title" id="gh-dialog-title" data-testid="gh-dialog-title" tabIndex={-1}>{dialogTitle(id, repoName, facts)}</h2>
        <div className={`gh-visibility${block.band ? ' has-band' : ''}`} data-testid="gh-visibility-block" data-band={block.band}>
          {block.band && <Glyph tone="warn" className="gh-glyph" />}
          <p>{block.heading !== null && <><strong>{block.heading}</strong>{' '}</>}{block.body}</p>
        </div>
      </header>
      <div className="gh-dialog-body" data-testid="gh-dialog-body">
        <div className="gh-dialog-part">
          <h3 className="gh-dialog-h">What it does</h3>
          <p className="ctl-lead" data-testid="gh-dialog-effect">{action.effect}</p>
          <p className="ctl-lead" data-testid="gh-dialog-facts">{read === 'loading' ? 'Reading the branch facts…' : read === 'failed' ? 'The branch facts could not be read, so nothing can be sent. Close this and open it again.' : factsLine(id, repoName, facts)}</p>
        </div>
        {action.not_effect !== null && (
          <div className="gh-dialog-part">
            <h3 className="gh-dialog-h">What it does not do</h3>
            <p className="ctl-lead" data-testid="gh-dialog-not-effect">{action.not_effect}</p>
          </div>
        )}
        <div className="gh-dialog-part">
          <h3 className="gh-dialog-h">What becomes visible</h3>
          <p className="ctl-lead" data-testid="gh-dialog-publishes">{action.publishes}</p>
          {id === 'push_branch' && facts !== null && commits !== null && (
            <div className="gh-preview" data-testid="gh-commit-preview">
              <h4 className="gh-dialog-h">{previewHeading(visibility, commits)}</h4>
              {/* Every unpublished commit with its author: a long list scrolls inside its own box (reachable by keyboard). */}
              <ol className="gh-commits" data-testid="gh-commit-list" tabIndex={0} aria-label="Unpublished commits and their authors">
                {unpublished.map(commit => (
                  <li key={commit.sha} className="gh-commit" data-testid="gh-commit-row">
                    <code className="gh-sha">{short(commit.sha)}</code>
                    <span className="gh-commit-subject">{commit.subject}</span>
                    <span className="gh-commit-author" data-testid="gh-commit-author">{commit.author}</span>
                    <time className="gh-commit-time" dateTime={commit.committed_at}>{commit.committed_at.slice(0, 16).replace('T', ' ')} UTC</time>
                  </li>
                ))}
              </ol>
              {facts.branch.unpublished_more > 0 && <p className="ctl-note" data-testid="gh-commit-more">and {facts.branch.unpublished_more} more not listed</p>}
            </div>
          )}
        </div>
        {(titleSpec || bodySpec || reviewersSpec) && (
          <div className="ctl-fields">
            {titleSpec && titleSpec.kind === 'text' && (
              <label className="ctl-field" htmlFor={`${fieldId}-title`}>
                <span>Title</span>
                <input id={`${fieldId}-title`} type="text" data-testid="gh-param-title" value={values.title} maxLength={titleSpec.max_length} onChange={event => set({ title: event.target.value })} />
              </label>
            )}
            {bodySpec && bodySpec.kind === 'multiline' && (
              <label className="ctl-field" htmlFor={`${fieldId}-body`}>
                <span>Body</span>
                <textarea id={`${fieldId}-body`} rows={8} data-testid="gh-param-body" value={values.body} onChange={event => set({ body: event.target.value })} />
                <span className="ctl-hint" data-testid="gh-body-counter">{bodyCounter(values.body, bodySpec.max_length)}</span>
                <span className="ctl-hint">{PR_BODY_CAPTION}</span>
              </label>
            )}
            {reviewersSpec && reviewersSpec.kind === 'list' && (
              <div className="ctl-field">
                <label htmlFor={`${fieldId}-reviewers`}>Reviewers: one login or org/team per line, up to {reviewersSpec.max_items}</label>
                <textarea id={`${fieldId}-reviewers`} rows={3} data-testid="gh-param-reviewers" spellCheck={false} autoCapitalize="off" value={values.reviewers} onChange={event => set({ reviewers: event.target.value })} aria-describedby={`${fieldId}-reviewers-hint`} />
                <span className="ctl-hint" id={`${fieldId}-reviewers-hint`} data-testid="gh-reviewers-hint">{values.reviewers.trim() === '' ? 'Nobody is named yet.' : parseReviewers(values.reviewers, reviewersSpec.max_items).problem ?? `${parseReviewers(values.reviewers, reviewersSpec.max_items).items.length} named.`}</span>
                {reviewersSpec.suggestions.length > 0 && (
                  <div className="gh-chips" role="group" aria-label="Recent reviewers of this repository">
                    {reviewersSpec.suggestions.map(login => (
                      <button key={login} type="button" className="gh-chip-toggle" data-testid="gh-reviewer-suggestion" aria-pressed={hasReviewer(values.reviewers, login)} onClick={() => set({ reviewers: toggleReviewer(values.reviewers, login) })}>{login}</button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
        <div className="ctl-cmd">
          <span className="ctl-cmd-h">The exact command</span>
          <code data-testid="gh-dialog-command">{command.text}</code>
          <CopyButton text={command.copyable ? command.text : null} waiting={command.waiting ?? undefined} accessibleName="Copy the exact command" testId="gh-dialog-command-copy" />
          {command.hasBody && <span className="ctl-hint" data-testid="gh-dialog-body-note">{BODY_FILE_NOTE}</span>}
          <span className="ctl-hint">{COMMAND_NOTE}</span>
        </div>
      </div>
      <footer className="gh-dialog-foot" data-testid="gh-dialog-foot">
        {typed && !record && (
          <label className="ctl-field gh-typed" htmlFor={`${fieldId}-typed`} data-testid="gh-typed-confirm">
            <span>Type <strong>{repoName}</strong> to confirm</span>
            <input id={`${fieldId}-typed`} type="text" data-testid="gh-typed-input" autoComplete="off" autoCapitalize="off" spellCheck={false} value={values.typed} onChange={event => set({ typed: event.target.value })} />
          </label>
        )}
        {!action.available && <p className="ctl-error" role="alert" data-testid="gh-dialog-unavailable">Not offered: {action.reason}</p>}
        {record && (
          <div className="gh-outcome" data-testid="gh-dialog-outcome" data-state={record.status} data-outcome={unknownLine(record) !== null ? 'unknown' : record.status} role="status">
            <Pill tone={recordShown(record).tone} word={recordShown(record).word} testId="gh-dialog-outcome-pill" />
            <p className={unknownLine(record) !== null ? 'gh-unknown' : undefined} data-testid="gh-dialog-outcome-sentence">
              {unknownLine(record) !== null && <Glyph tone="warn" className="gh-glyph" />}<span>{outcomeSentence(record)}</span>
            </p>
            {unknownLine(record) !== null && <p className="gh-muted" data-testid="gh-dialog-unknown-line">{unknownLine(record)}</p>}
            {record.status === 'succeeded' && record.url && <a href={record.url} target="_blank" rel="noopener" data-testid="gh-dialog-url">{record.url} ↗</a>}
            {record.status === 'failed' && record.output_tail.length > 0 && <pre className="gh-output">{record.output_tail.join('\n')}</pre>}
          </div>
        )}
        {alert !== null && <p className="ctl-error" role="alert" data-testid="gh-dialog-alert">{alert}</p>}
        {sending && <p className="ctl-hint" id={sendingHint} data-testid="gh-dialog-sending-hint">{SENDING_HINT}</p>}
        {/* The dialog's polite live region (final review F3.1): Escape, Cancel or the backdrop tried mid-send says why nothing closed. */}
        <p className="visually-hidden" role="status" data-testid="gh-dialog-status">{blocked && sending ? SENDING_HINT : ''}</p>
        <div className="ctl-actions">
          <button
            type="button" className="button button-small" data-testid="gh-dialog-cancel" aria-disabled={sending || undefined} aria-describedby={sending ? sendingHint : undefined}
            onClick={() => { if (!sending && !inFlight.current) onClose(); else onBlocked(true) }}
          >{record || stale ? 'Close' : 'Cancel'}</button>
          {!record && (
            <button
              type="button" className={`button button-small ctl-primary${typed ? ' is-destructive' : ''}`} data-testid="gh-dialog-confirm"
              {...confirmOff(canConfirm, pressed || sending)} aria-busy={sending} onClick={() => void confirm()}
            >{sending ? 'Sending…' : confirmLabel(id, repoName, facts, values)}</button>
          )}
        </div>
      </footer>
    </>
  )
}
