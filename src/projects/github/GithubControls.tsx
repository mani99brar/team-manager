/**
 * The GitHub actions' dialog and the Controls menu's GitHub group (docs/PRD_RUN_TEAMS.md 4.4 "Controls menu" and 4.5
 * "Dialogs"). The dialog reuses the `ControlDialog` shell's behaviour: a native modal `<dialog>` (focus trapped, Escape and
 * Cancel close it without sending, the opener gets focus back), one `request_id` per dialog open and the actions'
 * `state_token` from when it opened, so a moved branch answers 409 and the dialog says so. Its parts, in order: title,
 * visibility block, what it does (the server's `effect` and one facts line), what it does not do, what becomes visible (with
 * the commit preview for a push, every author in full), the fields, the exact command, the typed `owner/name` when asked
 * for, and the confirm button. The branch facts come from a fresh run GitHub read taken when the dialog opens.
 */
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { fetchRunGithub, postGithubAction, type GithubActionId, type RunGithub, type RunScope } from '../api.ts'
import { ControlError, readToken } from '../controls/client.ts'
import { describeFailure, newRequestId } from '../controls/model.ts'
import { setMenu, unpairBrowser } from '../controls/store.ts'
import {
  actionNote, buildGithubParams, COMMAND_NOTE, confirmLabel, dialogTitle, factsLine, fieldsProblem, hasReviewer, initialDialogValues, outcomeSentence,
  PR_BODY_CAPTION, previewHeading, recordTone, STALE_SENTENCE, toggleReviewer, typedConfirmation, typedMatches, visibilityBlock, type DialogValues,
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

function DialogShell({ scope, id }: { scope: RunScope; id: GithubActionId }) {
  const ref = useRef<HTMLDialogElement>(null)
  useLayoutEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    const opener = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null
    if (!dialog.open) dialog.showModal()
    const onCancel = (event: Event) => {
      event.preventDefault()
      if (dialog.querySelector('[data-testid="gh-dialog-confirm"][aria-busy="true"]') === null) closeGithubDialog(scope)
    }
    dialog.addEventListener('cancel', onCancel)
    return () => {
      dialog.removeEventListener('cancel', onCancel)
      if (dialog.open) dialog.close()
      const target = opener?.isConnected ? opener : document.querySelector<HTMLElement>(FALLBACK_FOCUS)
      target?.focus()
    }
  }, [scope])
  return (
    <dialog ref={ref} className="ctl-dialog gh-dialog" aria-labelledby="gh-dialog-title" data-testid="gh-dialog" data-action={id} onClick={event => { if (event.target === event.currentTarget) closeGithubDialog(scope) }}>
      <DialogBody scope={scope} id={id} onClose={() => closeGithubDialog(scope)} />
    </dialog>
  )
}

const EMPTY_VALUES: DialogValues = { title: '', body: '', reviewers: '', typed: '' }

function DialogBody({ scope, id, onClose }: { scope: RunScope; id: GithubActionId; onClose: () => void }) {
  const state = useGithubActionsState(scope)
  // The offers the dialog opened on: their state_token is the one posted, so a branch that moved answers 409.
  const [opened] = useState(() => state.data)
  const action = opened?.actions.find(item => item.id === id)
  const [values, setValues] = useState<DialogValues>(() => (action ? initialDialogValues(action) : EMPTY_VALUES))
  const [requestId, setRequestId] = useState(newRequestId)
  const [read, setRead] = useState<RunGithub | 'loading' | 'failed'>('loading')
  const [sending, setSending] = useState(false)
  const [alert, setAlert] = useState<string | null>(null)
  const [stale, setStale] = useState(false)
  const [recordId, setRecordId] = useState<string | null>(null)
  const inFlight = useRef(false)
  const fieldId = useId()
  useEffect(() => {
    const controller = new AbortController()
    fetchRunGithub(scope, controller.signal).then(setRead, () => { if (!controller.signal.aborted) setRead('failed') })
    return () => controller.abort()
  }, [scope])

  if (opened === null || action === undefined) {
    return (
      <>
        <h2 className="ctl-title" id="gh-dialog-title">GitHub</h2>
        <p className="ctl-note">The GitHub actions are not read yet. Close this and try again.</p>
        <div className="ctl-actions"><button type="button" className="button button-small" data-testid="gh-dialog-cancel" onClick={onClose}>Close</button></div>
      </>
    )
  }
  const facts = typeof read === 'object' ? read : null
  const repo = opened.repo ?? facts?.repo.owner_name ?? null
  const repoName = repo ?? 'the repository'
  const visibility = opened.visibility
  const commits = facts ? unpublishedCount(facts.branch) : 0
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

  const confirm = async () => {
    if (inFlight.current || !canConfirm) return
    const token = readToken()
    if (token === null) return
    inFlight.current = true
    setSending(true)
    setAlert(null)
    try {
      const answer = await postGithubAction(scope, id, { request_id: requestId, state_token: opened.state_token, params: buildGithubParams(action, values) }, token)
      adoptGithubRecord(scope, answer)
      setRecordId(answer.record_id)
    } catch (error) {
      if (error instanceof ControlError && error.code === 'STATE_CHANGED') {
        setStale(true)
        setAlert(STALE_SENTENCE)
        void refreshGithubActions(scope)
      } else {
        const outcome = describeFailure(error)
        setAlert(outcome.message)
        if (outcome.unpair) { unpairBrowser(scope); onClose() }
        if (outcome.refresh) void refreshGithubActions(scope)
        if (outcome.retryable) setRequestId(newRequestId())
      }
    } finally {
      inFlight.current = false
      setSending(false)
    }
  }

  return (
    <>
      <h2 className="ctl-title" id="gh-dialog-title">{dialogTitle(id, repoName, facts)}</h2>
      <div className={`gh-visibility${block.band ? ' has-band' : ''}`} data-testid="gh-visibility-block" data-band={block.band}>
        {block.band && <Glyph tone="warn" className="gh-glyph" />}
        <p>{block.heading !== null && <><strong>{block.heading}</strong>{' '}</>}{block.body}</p>
      </div>
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
        {id === 'push_branch' && facts !== null && (
          <div className="gh-preview" data-testid="gh-commit-preview">
            <h4 className="gh-dialog-h">{previewHeading(visibility, commits)}</h4>
            <ol className="gh-commits">
              {facts.branch.unpublished.map(commit => (
                <li key={commit.sha} className="gh-commit" data-testid="gh-commit-row">
                  <code className="gh-sha">{short(commit.sha)}</code>
                  <span className="gh-commit-subject">{commit.subject}</span>
                  <span className="gh-commit-author" data-testid="gh-commit-author">{commit.author}</span>
                  <time className="gh-commit-time" dateTime={commit.committed_at}>{commit.committed_at.slice(0, 16).replace('T', ' ')} UTC</time>
                </li>
              ))}
            </ol>
            {facts.branch.unpublished_more > 0 && <p className="ctl-note">and {facts.branch.unpublished_more} more not listed</p>}
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
              <span className="ctl-hint" data-testid="gh-body-counter">{values.body.length} of {bodySpec.max_length} characters</span>
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
        <code data-testid="gh-dialog-command">{action.command}</code>
        <CopyButton text={action.command} accessibleName="Copy the exact command" testId="gh-dialog-command-copy" />
        <span className="ctl-hint">{COMMAND_NOTE}</span>
      </div>
      {typed && !record && (
        <label className="ctl-field gh-typed" htmlFor={`${fieldId}-typed`} data-testid="gh-typed-confirm">
          <span>Type <strong>{repoName}</strong> to confirm</span>
          <input id={`${fieldId}-typed`} type="text" data-testid="gh-typed-input" autoComplete="off" autoCapitalize="off" spellCheck={false} value={values.typed} onChange={event => set({ typed: event.target.value })} />
        </label>
      )}
      {!action.available && <p className="ctl-error" role="alert" data-testid="gh-dialog-unavailable">Not offered: {action.reason}</p>}
      {record && (
        <div className="gh-outcome" data-testid="gh-dialog-outcome" data-state={record.status} role="status">
          <Pill tone={recordTone(record.status).tone} word={recordTone(record.status).word} />
          <p>{outcomeSentence(record)}</p>
          {record.status === 'succeeded' && record.url && <a href={record.url} target="_blank" rel="noopener" data-testid="gh-dialog-url">{record.url} ↗</a>}
          {record.status === 'failed' && record.output_tail.length > 0 && <pre className="gh-output">{record.output_tail.join('\n')}</pre>}
        </div>
      )}
      {alert !== null && <p className="ctl-error" role="alert" data-testid="gh-dialog-alert">{alert}</p>}
      <div className="ctl-actions">
        <button type="button" className="button button-small" data-testid="gh-dialog-cancel" onClick={onClose}>{record || stale ? 'Close' : 'Cancel'}</button>
        {!record && (
          <button
            type="button" className={`button button-small ctl-primary${typed ? ' is-destructive' : ''}`} data-testid="gh-dialog-confirm"
            disabled={!canConfirm} aria-busy={sending} onClick={() => void confirm()}
          >{sending ? 'Sending…' : confirmLabel(id, repoName, facts, values)}</button>
        )}
      </div>
    </>
  )
}
