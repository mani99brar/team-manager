import { useLayoutEffect, useRef, useState } from 'react'
import { paths, type RunScope, type WorkerResult } from './api.ts'

type Artifact = WorkerResult['artifacts'][number]

/**
 * One screenshot at full size in a native modal dialog (docs/PRD_VIEWER_UX.md 7, 10): rendered only while open, so mounting
 * shows it; the browser traps focus, Escape or Close closes it, and the thumbnail that opened it gets the focus back.
 */
function ScreenshotDialog({ scope, artifact, onClose }: { scope: RunScope; artifact: Artifact; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null)
  const close = useRef(onClose)
  useLayoutEffect(() => { close.current = onClose })
  useLayoutEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    if (!dialog.open) dialog.showModal()
    const onCancel = (event: Event) => { event.preventDefault(); close.current() }
    dialog.addEventListener('cancel', onCancel)
    return () => {
      dialog.removeEventListener('cancel', onCancel)
      if (dialog.open) dialog.close()
      opener?.focus()
    }
  }, [])
  return (
    <dialog
      ref={ref}
      className="screenshot-dialog"
      aria-label={`Screenshot ${artifact.artifact_id}`}
      data-testid="screenshot-dialog"
      // A click on the backdrop lands on the dialog itself.
      onClick={event => { if (event.target === event.currentTarget) onClose() }}
    >
      <div className="screenshot-dialog-head">
        <code title={`sha256 ${artifact.sha256}`}>{artifact.artifact_id}</code>
        <button type="button" className="button button-small" onClick={onClose}>Close</button>
      </div>
      <img src={paths.artifact(scope, artifact.artifact_id)} alt={`Screenshot artifact ${artifact.artifact_id}, full size`} />
    </dialog>
  )
}

function Thumbnail({ scope, artifact, onOpen }: { scope: RunScope; artifact: Artifact; onOpen: () => void }) {
  const [failed, setFailed] = useState(false)
  if (failed) return <p className="projects-error-inline" role="alert">Screenshot {artifact.artifact_id} could not be loaded from the artifact route.</p>
  return (
    <button type="button" className="screenshot-thumb" title={`${artifact.artifact_id}\nsha256 ${artifact.sha256}`} onClick={onOpen}>
      <img
        className="artifact-screenshot"
        src={paths.artifact(scope, artifact.artifact_id)}
        alt={`Screenshot artifact ${artifact.artifact_id}`}
        data-testid={`artifact-screenshot:${artifact.artifact_id}`}
        onError={() => setFailed(true)}
      />
    </button>
  )
}

/**
 * The screenshots a verification published (docs/PRD_VIEWER_UX.md 7): a grid of thumbnails at most 220 px wide, captioned
 * with their artifact id, each opening full size in a dialog. The sha256 is in the tooltip and under Identifiers.
 */
export function Screenshots({ scope, screenshots }: { scope: RunScope; screenshots: readonly Artifact[] }) {
  const [shown, setShown] = useState<Artifact | null>(null)
  return (
    <>
      <ul className="screenshot-grid" data-testid="screenshots">
        {screenshots.map(artifact => (
          <li key={artifact.artifact_id}>
            <figure>
              <Thumbnail scope={scope} artifact={artifact} onOpen={() => setShown(artifact)} />
              <figcaption><code>{artifact.artifact_id}</code></figcaption>
            </figure>
          </li>
        ))}
      </ul>
      {shown !== null && <ScreenshotDialog scope={scope} artifact={shown} onClose={() => setShown(null)} />}
    </>
  )
}
