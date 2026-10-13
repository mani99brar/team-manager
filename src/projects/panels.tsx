import type { AnchorHTMLAttributes, ReactNode } from 'react'
import { describeApiError, ProjectsApiError } from './api.ts'
import { projectIdFromPath, RUNS_ROOT_UNAVAILABLE } from './node/errors.ts'
import { projectPathname } from './routes.ts'
import { OVERRIDE_LABEL, OVERRIDE_TITLE, RUN_STATUS_MEANING, STATUS_LABEL, STATUS_TITLE, type RunStatus } from './status.ts'

export function StatusBadge({ status, explain = false, accepted = false }: { status: RunStatus; explain?: boolean; accepted?: boolean }) {
  // The operator override (L12) is served as succeeded but has its own chip: never the reviewed-integration style.
  if (accepted) {
    return (
      <span className="status-badge status-override" data-status={status} data-outcome="override" data-testid="override-chip" title={OVERRIDE_TITLE}>
        <span>{OVERRIDE_LABEL}</span>
        {explain && <span className="visually-hidden">. {OVERRIDE_TITLE}</span>}
      </span>
    )
  }
  return (
    <span className={`status-badge status-${status}`} data-status={status} title={STATUS_TITLE[status]}>
      <span>{STATUS_LABEL[status]}</span>
      {explain && <span className="visually-hidden">. {RUN_STATUS_MEANING[status]}</span>}
    </span>
  )
}

export function LoadingPanel({ children }: { children: ReactNode }) {
  return <p className="projects-loading" aria-busy="true">{children}</p>
}

/** A failed request: what failed, why, and what the reader can do. Never replaced by sample data. */
export function ErrorPanel({ error, what, onRetry, children }: { error: unknown; what: string; onRetry?: () => void; children?: ReactNode }) {
  const api = error instanceof ProjectsApiError ? error : null
  if (api?.kind === 'http' && api.code === RUNS_ROOT_UNAVAILABLE) return <StorageMissingPanel error={api} onRetry={onRetry}>{children}</StorageMissingPanel>
  return (
    <div className="projects-error" role="alert" data-testid="projects-error" data-error-kind={api?.kind ?? 'unknown'}>
      <p><strong>{what} could not be loaded.</strong> {describeApiError(error)}</p>
      {api?.kind === 'http' && api.status !== null && api.status >= 500 && <p>The server reported a failure; nothing was substituted for the missing data. Retry once it has recovered.</p>}
      {api?.kind === 'malformed' && <p>The response was rejected rather than rendered, because it might be incomplete or from an incompatible server version.</p>}
      {api && <p className="projects-error-path">Request: <code>{api.path}</code></p>}
      <div className="projects-actions">
        {onRetry && <button type="button" className="button" onClick={onRetry}>Retry</button>}
        {children}
      </div>
    </div>
  )
}

/**
 * A workflow whose run storage cannot be opened: it leads with the fix (the project's `runs_root` entry in the projects
 * registry), links back to the project and keeps the HTTP code and request path behind a closed disclosure.
 */
function StorageMissingPanel({ error, onRetry, children }: { error: ProjectsApiError; onRetry?: () => void; children?: ReactNode }) {
  const projectId = projectIdFromPath(error.path)
  return (
    <div className="projects-error" role="alert" data-testid="projects-error" data-error-kind={error.kind} data-error-code={error.code ?? undefined}>
      <p>
        <strong>Run storage missing.</strong>{' '}
        {projectId === null ? 'Fix the failing project\'s' : <>The run storage of project <code data-testid="storage-project">{projectId}</code> cannot be opened. Fix its</>}{' '}
        <code>runs_root</code> entry in the projects registry (<code>projects.json</code>), then retry.
      </p>
      <p className="projects-muted">{error.message}</p>
      <details className="projects-error-details" data-testid="technical-details">
        <summary>Technical details</summary>
        <p>HTTP {error.status} · <code>{error.code}</code></p>
        <p className="projects-error-path">Request: <code>{error.path}</code></p>
      </details>
      <div className="projects-actions">
        {projectId !== null && <a href={projectPathname(projectId)} data-testid="storage-project-link">Back to project {projectId}</a>}
        {onRetry && <button type="button" className="button button-small" onClick={onRetry}>Retry</button>}
        {children}
      </div>
    </div>
  )
}

export function EmptyPanel({ title, children, testId }: { title: string; children?: ReactNode; testId?: string }) {
  return (
    <div className="projects-empty" data-testid={testId}>
      <p><strong>{title}</strong></p>
      {children}
    </div>
  )
}

type AppLinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href' | 'onClick'> & {
  href: string
  onNavigate: (pathname: string) => void
  children: ReactNode
  current?: boolean
}

/** A link that navigates inside the app through history rather than reloading. Other anchor attributes (title, data-*) pass through. */
export function AppLink({ href, onNavigate, className, children, current = false, ...rest }: AppLinkProps) {
  return (
    <a
      {...rest}
      href={href}
      className={className}
      aria-current={current ? 'page' : undefined}
      onClick={event => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return
        event.preventDefault()
        onNavigate(href)
      }}
    >
      {children}
    </a>
  )
}
