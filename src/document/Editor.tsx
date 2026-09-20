import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection, highlightSpecialChars } from '@codemirror/view'
import { EditorState, type Extension } from '@codemirror/state'
import { history, historyKeymap, defaultKeymap, indentWithTab } from '@codemirror/commands'
import { HighlightStyle, syntaxHighlighting, bracketMatching } from '@codemirror/language'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { tags } from '@lezer/highlight'
import type { FileRef } from '../graph/model.ts'
import { Markdown } from './Markdown.tsx'
import { canRevert, canSave, hasUnacknowledgedWork, isPending, status, type Session } from './editSession.ts'
import { serializeText, textFromContent, type TextAnalysis } from './serialize.ts'

type Tab = 'edit' | 'preview'
const TABS: ReadonlyArray<{ id: Tab; label: string }> = [
  { id: 'edit', label: 'Edit' },
  { id: 'preview', label: 'Preview' },
]

const STATUS_LABEL: Record<ReturnType<typeof status>, string> = { saved: 'Saved', unsaved: 'Unsaved', saving: 'Saving', error: 'Error' }

/** Theme-neutral Markdown highlighting driven by the app's CSS variables so light and dark both stay readable. */
const markdownHighlight = HighlightStyle.define([
  { tag: tags.heading, fontWeight: 'bold', color: 'var(--md-heading)' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strong, fontWeight: 'bold' },
  { tag: tags.strikethrough, textDecoration: 'line-through' },
  { tag: tags.link, color: 'var(--md-link)' },
  { tag: tags.url, color: 'var(--md-link)', textDecoration: 'underline' },
  { tag: tags.monospace, color: 'var(--md-code)' },
  { tag: tags.quote, color: 'var(--text-muted)' },
  { tag: tags.list, color: 'var(--md-punct)' },
  { tag: tags.processingInstruction, color: 'var(--md-punct)' },
  { tag: tags.meta, color: 'var(--text-muted)' },
  { tag: tags.contentSeparator, color: 'var(--md-punct)' },
])

const editorTheme = EditorView.theme({
  '&': { backgroundColor: 'var(--surface)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: '6px', fontSize: '0.95rem' },
  '&.cm-focused': { outline: '3px solid var(--focus)', outlineOffset: '2px' },
  '.cm-content': { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', caretColor: 'var(--text)', padding: '8px 0' },
  '.cm-gutters': { backgroundColor: 'var(--surface-alt)', color: 'var(--text-muted)', border: 'none' },
  '.cm-activeLine': { backgroundColor: 'transparent' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent' },
  '.cm-cursor': { borderLeftColor: 'var(--text)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': { backgroundColor: 'var(--selection)' },
  '.cm-scroller': { overflow: 'auto', maxHeight: 'calc(100vh - 320px)', minHeight: '240px', lineHeight: '1.5' },
})

type CodeMirrorProps = {
  /** The session draft; only read when the editor is created or `generation` changes (Revert, Reload). */
  content: string
  generation: number
  analysis: TextAnalysis
  /** Fires with the serialized document (original line ending and BOM restored) after every change. */
  onChange: (content: string) => void
  onSave: () => void
  label: string
}

function CodeMirror({ content, generation, analysis, onChange, onSave, label }: CodeMirrorProps) {
  const host = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const latest = useRef({ onChange, onSave, content })
  // Layout effect, declared first: the replacement effect below must see this render's content.
  useLayoutEffect(() => { latest.current = { onChange, onSave, content } })
  useEffect(() => {
    const extensions: Extension[] = [
      lineNumbers(), highlightSpecialChars(), history(), drawSelection(), highlightActiveLine(), bracketMatching(),
      markdown({ base: markdownLanguage }), syntaxHighlighting(markdownHighlight), editorTheme, EditorView.lineWrapping,
      EditorView.contentAttributes.of({ 'aria-label': label }),
      keymap.of([{ key: 'Mod-s', run: () => { latest.current.onSave(); return true } }, ...defaultKeymap, ...historyKeymap, indentWithTab]),
      EditorView.updateListener.of(update => {
        if (update.docChanged) latest.current.onChange(serializeText(update.state.doc, analysis))
      }),
    ]
    const view = new EditorView({ state: EditorState.create({ doc: textFromContent(content, analysis), extensions }), parent: host.current! })
    viewRef.current = view
    return () => { view.destroy(); viewRef.current = null }
    // The editor is created once per editing session; afterwards CodeMirror owns the text and the effect below syncs it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  // Keystrokes flow editor → session only. The session replaces the editor text solely on a generation change,
  // so a render that lags behind fast typing can never overwrite newer keystrokes. It runs before paint so no
  // keystroke can land between the new status being visible and the replacement.
  useLayoutEffect(() => {
    const view = viewRef.current
    if (!view || generation === 0) return
    const next = latest.current.content
    if (serializeText(view.state.doc, analysis) === next) return
    const replacement = textFromContent(next, analysis)
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: replacement }, selection: { anchor: Math.min(view.state.selection.main.head, replacement.length) } })
  }, [generation, analysis])
  return <div ref={host} className="editor-host" />
}

type Props = {
  fileRef: FileRef
  session: Session
  analysis: TextAnalysis
  onEdit: (content: string) => void
  onSave: () => void
  onRevert: () => void
  onReload: () => void
  onCopyDraft: () => void
  onExit: () => void
  /** Optional recovery panel shown by the parent (conflict/copy state). */
  recovery?: React.ReactNode
}

/** Editing shell: Edit/Preview tabs, Save/Revert/Done controls, accessible status and error guidance. */
export function Editor({ fileRef, session, analysis, onEdit, onSave, onRevert, onReload, onCopyDraft, onExit, recovery }: Props) {
  const [tab, setTab] = useState<Tab>('edit')
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([])
  const current = status(session)
  const pending = isPending(session)
  const saveEnabled = canSave(session)

  // Ctrl/Cmd+S anywhere in editing mode saves and never triggers the browser's Save Page.
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && !event.altKey && (event.key === 's' || event.key === 'S')) {
        event.preventDefault()
        if (saveEnabled) onSave()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onSave, saveEnabled])

  // Warn on supported browser departures while there is unsaved or unacknowledged work.
  const dirty = hasUnacknowledgedWork(session)
  useEffect(() => {
    if (!dirty) return
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])

  const onTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const index = TABS.findIndex(candidate => candidate.id === tab)
    let next: number | null = null
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (index + 1) % TABS.length
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (index - 1 + TABS.length) % TABS.length
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = TABS.length - 1
    if (next === null) return
    event.preventDefault()
    setTab(TABS[next].id)
    tabRefs.current[next]?.focus()
  }

  const preview = useMemo(() => (tab === 'preview'
    ? session.draft === '' ? <p className="document-message">This draft is empty.</p> : <Markdown content={session.draft} />
    : null), [tab, session.draft])

  const error = session.error
  let guidance: React.ReactNode = null
  if (error) {
    const explanation = error.kind === 'conflict'
      ? 'This file changed on disk since it was last read. Your draft is kept but cannot be saved over the newer version. Reload to discard the draft and edit the current file, or copy the draft first.'
      : error.kind === 'too-large'
        ? `${error.message} Your draft is unchanged.`
        : error.kind === 'missing'
          ? 'The file no longer exists on disk, so the draft cannot be saved there. Copy the draft to keep it.'
          : `The save failed: ${error.message} Your draft, including edits made during the failed save, is unchanged. Retry with the last acknowledged version; if the earlier write did reach the disk, the retry reports a conflict instead of silently overwriting it.`
    guidance = (
      <div className="document-message document-error editor-error" role="alert">
        <p>{explanation}</p>
        <p className="document-actions">
          {error.kind === 'conflict' && <button type="button" className="button" onClick={onReload}>Reload</button>}
          {(error.kind === 'failed' || error.kind === 'too-large') && <button type="button" className="button" onClick={onSave}>Retry</button>}
          <button type="button" className="button" onClick={onCopyDraft}>Copy draft</button>
        </p>
      </div>
    )
  }

  return (
    <div className="editor" data-testid="editor" data-save-status={current}>
      <div className="editor-toolbar">
        <div className="tabs" role="tablist" aria-label="Editor">
          {TABS.map((candidate, index) => (
            <button
              key={candidate.id}
              ref={element => { tabRefs.current[index] = element }}
              type="button"
              role="tab"
              id={`editor-tab-${candidate.id}`}
              className="tab"
              aria-selected={tab === candidate.id}
              aria-controls="editor-panel"
              tabIndex={tab === candidate.id ? 0 : -1}
              onClick={() => setTab(candidate.id)}
              onKeyDown={onTabKeyDown}
            >
              {candidate.label}
            </button>
          ))}
        </div>
        <div className="editor-actions">
          <span className={`save-status save-status-${current}`} data-testid="save-status" aria-live="polite" aria-atomic="true">
            {STATUS_LABEL[current]}
          </span>
          <button type="button" className="button" onClick={onSave} disabled={!saveEnabled} aria-keyshortcuts="Control+S Meta+S">Save</button>
          <button type="button" className="button" onClick={onRevert} disabled={!canRevert(session)}>Revert</button>
          <button type="button" className="button" onClick={onExit} disabled={pending} title={pending ? 'Wait for the save to finish.' : undefined}>Done</button>
        </div>
      </div>
      {guidance}
      {recovery}
      <div className="editor-panel" role="tabpanel" id="editor-panel" aria-labelledby={`editor-tab-${tab}`}>
        <div hidden={tab !== 'edit'}>
          <CodeMirror content={session.draft} generation={session.generation} analysis={analysis} onChange={onEdit} onSave={onSave} label={`Editing ${fileRef.path}`} />
        </div>
        {preview}
      </div>
    </div>
  )
}
