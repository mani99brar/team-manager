import type { ReactNode } from 'react'
import { describeApiError, ProjectsApiError } from './api.ts'
import { RUN_STATUS_MEANING, STATUS_LABEL, type RunStatus } from './status.ts'

export function StatusBadge({ status, explain = false }: { status: RunStatus; explain?: boolean }) {
  return (
    <span className={`status-badge status-${status}`} data-status={status}>
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

export function EmptyPanel({ title, children, testId }: { title: string; children?: ReactNode; testId?: string }) {
  return (
    <div className="projects-empty" data-testid={testId}>
      <p><strong>{title}</strong></p>
      {children}
    </div>
  )
}

/** A link that navigates inside the app through history rather than reloading. */
export function AppLink({ href, onNavigate, className, children, current = false }: { href: string; onNavigate: (pathname: string) => void; className?: string; children: ReactNode; current?: boolean }) {
  return (
    <a
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
