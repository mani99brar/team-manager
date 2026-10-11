/**
 * The reading pane's commits-ahead view (docs/PRD_PROJECTS_DISPATCH.md 4.3, V6): the Local and GitHub card's button docks this
 * in place of a run. It lists the commits ahead of origin (short sha, subject, the run a commit names linking to that run) with
 * "and N more" when `ahead` exceeds the listed commits ([P33]), and every landing with its local and origin state, an unknown
 * one shown as unknown ([P9]). It reads only the git state the page already holds; it never fetches.
 */
import { useEffect, useRef } from 'react'
import { AppLink } from '../panels.tsx'
import { Time } from '../Time.tsx'
import { commitsAheadMore } from './derive.ts'
import type { GitState, Landing } from './types.ts'

function landingState(landing: Pick<Landing, 'on_default' | 'on_origin'>, defaultBranch: string | null): string {
  const d = defaultBranch ?? 'the default branch'
  const word = (value: boolean | null) => (value === true ? 'yes' : value === false ? 'no' : 'unknown')
  return `local ${d}: ${word(landing.on_default)} · origin/${d}: ${word(landing.on_origin)}`
}

type Props = {
  git: GitState
  onClose: () => void
  runHref: (runId: string) => string | null
  onNavigate: (pathname: string) => void
  phone: boolean
}

export function AheadPane({ git, onClose, runHref, onNavigate, phone }: Props) {
  const closeRef = useRef<HTMLButtonElement>(null)
  useEffect(() => { closeRef.current?.focus() }, [])
  const defaultBranch = git.default_branch
  const compared = git.origin?.compare === 'compared'
  const ahead = compared ? git.origin!.ahead ?? git.ahead_commits.length : git.ahead_commits.length
  const more = commitsAheadMore(ahead, git.ahead_commits.length)
  // With no origin ref (origin null) or no local branch to compare ('no_local_branch'), the server left ahead_commits empty
  // because nothing was compared. Say that, never a measured "no commits ahead" the page has no basis for (V6, redaction rule).
  const emptyNote = compared
    ? 'No commits ahead of origin.'
    : git.origin?.compare === 'no_local_branch'
      ? `No local ${defaultBranch ?? 'branch'} to compare with origin.`
      : 'Not compared with origin.'
  return (
    <aside className={`dispatch-pane dispatch-ahead-pane ${phone ? 'phone' : ''}`} data-testid="dispatch-pane" data-pane="ahead" aria-label="Local commits and landings">
      <header className="dispatch-pane-head">
        <div className="dispatch-pane-top">
          <h2 className="dispatch-pane-id">Local commits</h2>
          <button type="button" ref={closeRef} className="button button-small dispatch-pane-close" data-testid="dispatch-pane-close" onClick={onClose}>Close</button>
        </div>
      </header>
      <div className="dispatch-pane-body">
        <section className="dispatch-pane-sec">
          <h3>Commits ahead of origin</h3>
          {git.ahead_commits.length === 0
            ? <p className="dispatch-muted">{emptyNote}</p>
            : (
              <ul className="dispatch-ahead-list" data-testid="dispatch-ahead-commits">
                {git.ahead_commits.map(commit => {
                  const href = commit.run_id ? runHref(commit.run_id) : null
                  return (
                    <li key={commit.sha}>
                      <code className="dispatch-mono">{commit.sha.slice(0, 7)}</code>
                      <span className="dispatch-ahead-subj">{commit.subject}</span>
                      {commit.run_id && (href
                        ? <AppLink href={href} onNavigate={onNavigate} className="dispatch-ahead-run">{commit.run_id}</AppLink>
                        : <span className="dispatch-muted">{commit.run_id}</span>)}
                      <span className="dispatch-muted"><Time iso={commit.committed_at} /></span>
                    </li>
                  )
                })}
              </ul>
            )}
          {more && <p className="dispatch-muted" data-testid="dispatch-ahead-more">{more}</p>}
        </section>
        <section className="dispatch-pane-sec">
          <h3>Landings</h3>
          {git.landings.length === 0
            ? <p className="dispatch-muted">No integrated runs recorded.</p>
            : (
              <ul className="dispatch-ahead-list" data-testid="dispatch-ahead-landings">
                {git.landings.map(landing => (
                  <li key={landing.run_id}>
                    <code className="dispatch-mono">{landing.sha.slice(0, 7)}</code>
                    {runHref(landing.run_id)
                      ? <AppLink href={runHref(landing.run_id)!} onNavigate={onNavigate} className="dispatch-ahead-run">{landing.run_id}</AppLink>
                      : <span className="dispatch-mono">{landing.run_id}</span>}
                    <span className="dispatch-muted">{landingState(landing, defaultBranch)}</span>
                  </li>
                ))}
              </ul>
            )}
        </section>
      </div>
    </aside>
  )
}
