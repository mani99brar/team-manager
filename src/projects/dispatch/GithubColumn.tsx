/**
 * The project page's GitHub column (docs/PRD_PROJECTS_DISPATCH.md 4.3, Appendix A): four cards — Local and GitHub, Pull
 * requests, Issues, and Also checked out as. Every claim names its source and time; nothing the data does not hold is shown.
 * GitHub's state is said once per page: a project with no GitHub remote reads "no GitHub remote" in the column's one line
 * and has no Pull requests or Issues card; any other not-read status reads "GitHub not read: <reason>" ("GitHub reads are
 * turned off" when off) on the Local and GitHub card, which keeps its local sync, ahead and landing counts ([P29]), and the
 * Pull requests and Issues cards do not repeat it; when it was read but the latest refresh failed the data shows with a
 * "latest refresh failed" line, once ([P12]). PR and issue groups longer than 5 fold ([V8]).
 */
import { useState } from 'react'
import type { Project } from '../api.ts'
import { projectPathname } from '../routes.ts'
import { AppLink } from '../panels.tsx'
import { Time } from '../Time.tsx'
import { githubHeadState, githubNoHeadText, issueGroups, prGroups, prRelation, relatedWhy, relTime, showMoreText, syncAsOf, syncPhrase } from './derive.ts'
import type { GitState, GithubState, Issue, Pr } from './types.ts'

const plural = (n: number, word: string) => `${n} ${n === 1 ? word : `${word}s`}`
const ghUrl = (repo: string, ...rest: string[]) => `https://github.com/${repo}${rest.length ? `/${rest.join('/')}` : ''}`

const REVIEW_WORD: Record<string, [string, string]> = {
  APPROVED: ['ok', 'approved'], CHANGES_REQUESTED: ['fail', 'changes requested'], REVIEW_REQUIRED: ['warn', 'review required'],
}

function PrRow({ pr, defaultBranch, readAt, why }: { pr: Pr; defaultBranch: string | null; readAt: number; why?: string }) {
  const rv = pr.review_decision ? REVIEW_WORD[pr.review_decision] : null
  const when = pr.state === 'MERGED' && pr.merged_at ? `merged ${relTime(pr.merged_at, readAt)}` : `updated ${relTime(pr.updated_at, readAt)}`
  return (
    <li className="dispatch-gh-item">
      <a href={pr.url} target="_blank" rel="noopener"><span className="dispatch-num">#{pr.number}</span> {pr.title}</a>
      <span className="dispatch-gh-meta">
        <span>{pr.author}{pr.author_is_bot ? ' (bot)' : ''}</span>
        {pr.draft && <span className="dispatch-draft">draft</span>}
        {pr.base_ref !== defaultBranch ? <span><code>{pr.head_ref}</code> → <code>{pr.base_ref}</code></span> : null}
        {pr.state === 'OPEN' && rv && <span className={`dispatch-rv tone-${rv[0]}`}>{rv[1]}</span>}
        {pr.state === 'OPEN' && pr.checks && (
          <span className="dispatch-checks">
            {pr.checks.failing > 0 && <span className="tone-fail">{pr.checks.failing} failing</span>}
            {pr.checks.pending > 0 && <span className="tone-run">{pr.checks.pending} pending</span>}
            {pr.checks.passing > 0 && <span className="tone-ok">{pr.checks.passing} passing</span>}
          </span>
        )}
        <span>{when}</span>
      </span>
      {why && <span className="dispatch-gh-why">{why}</span>}
    </li>
  )
}

function IssueRow({ issue, readAt }: { issue: Issue; readAt: number }) {
  return (
    <li className="dispatch-gh-item">
      <a href={issue.url} target="_blank" rel="noopener"><span className="dispatch-num">#{issue.number}</span> {issue.title}</a>
      <span className="dispatch-gh-meta">
        <span>{issue.author}{issue.author_is_bot ? ' (bot)' : ''}</span>
        {issue.assignees.length > 0 && <span>assigned {issue.assignees.join(', ')}</span>}
        {issue.labels.length > 0 && <span>{issue.labels.slice(0, 2).join(', ')}</span>}
        <span>opened {relTime(issue.created_at, readAt)}</span>
      </span>
    </li>
  )
}

/** A GitHub group that shows its first five items and folds the rest behind "Show N more", which expands in place (V8). */
function Group({ title, items, render, note }: { title: string; items: readonly unknown[]; render: (item: never, i: number) => React.ReactNode; note?: string }) {
  const [expanded, setExpanded] = useState(false)
  if (items.length === 0) return null
  const shown = expanded ? items : items.slice(0, 5)
  const more = showMoreText(items.length, 5)
  return (
    <div className="dispatch-gh-group">
      <h4>{title} <span>{items.length}</span>{note && <span className="dispatch-gh-note">{note}</span>}</h4>
      <ul className="dispatch-gh-list">{shown.map((item, i) => render(item as never, i))}</ul>
      {more && !expanded && <button type="button" className="dispatch-show-more" data-testid="dispatch-show-more" onClick={() => setExpanded(true)}>{more}</button>}
    </div>
  )
}

/** How a project's GitHub state is said when its data was not read: the one sentence a card or page carries. */
// eslint-disable-next-line react-refresh/only-export-components
export function githubNotReadText(github: GithubState | null): string {
  if (github?.status === 'not_github') return 'no GitHub remote'
  if (github?.status === 'off') return 'GitHub reads are turned off'
  if (github === null) return 'GitHub not read: GitHub state not available'
  return `GitHub not read: ${github.reason ?? 'not read yet'}`
}

type Props = {
  project: Project
  git: GitState | null
  github: GithubState | null
  /** The source branches of this project's runs, for "possibly related" PRs. */
  runBranches: ReadonlySet<string>
  others: { project: Project; cloneId: string | null; checkout: string | null }[]
  primaryName: string | null
  viewerLogin: string | null
  readAt: number
  /** Opens the commits-ahead and landings view in the reading pane (V6). */
  onShowAhead: () => void
  /** Whether the ahead view is the one currently docked, for the button's pressed state. */
  aheadOpen: boolean
  onNavigate: (pathname: string) => void
  /** A project without a GitHub remote: the column is one line under the header (its local sync and the not-read reason). */
  compact?: boolean
}

export function GithubColumn({ project, git, github, runBranches, others, primaryName, viewerLogin, readAt, onShowAhead, aheadOpen, onNavigate, compact = false }: Props) {
  const notReadText = githubNotReadText(github)
  if (compact) {
    const ahead = git !== null && (git.ahead_commits.length > 0 || git.landings.length > 0 || (git.origin?.compare === 'compared' && (git.origin.ahead ?? 0) > 0))
    return (
      <aside className="dispatch-gh dispatch-gh-line" aria-label="GitHub and local branch" data-testid="dispatch-github">
        <p className="dispatch-gline" id="g-local" data-testid="dispatch-gh-local" tabIndex={-1}>
          <span className="dispatch-gh-title">Local and GitHub</span>
          {' · '}{git === null ? 'git state not available.' : syncPhrase(git, project.project_id, primaryName)}
          {' · '}<span data-testid="dispatch-gh-local-notread">{notReadText}</span>
          {ahead && (
            <> {' · '}<button type="button" className="dispatch-gh-ahead-btn" data-testid="dispatch-ahead-button" aria-pressed={aheadOpen} onClick={onShowAhead}>Commits ahead and landings</button></>
          )}
        </p>
      </aside>
    )
  }
  const read = github?.status === 'read'
  const headState = githubHeadState(github)
  const defaultBranch = git?.default_branch ?? null
  const branches = new Set<string>([...(git?.checkout ? [git.checkout] : []), ...runBranches])
  const asOf = git ? syncAsOf(git) : null
  const isShared = git !== null && git.clone_primary !== null && git.clone_primary !== project.project_id
  const hasAheadOrLandings = git !== null && (git.ahead_commits.length > 0 || git.landings.length > 0 || (git.origin?.compare === 'compared' && (git.origin.ahead ?? 0) > 0))

  // Local and GitHub (always shown; it is the git card).
  const local = (
    <div className="dispatch-gcard" id="g-local" data-testid="dispatch-gh-local" tabIndex={-1}>
      <h3>Local and GitHub</h3>
      {git === null
        ? (
          <>
            <p className="dispatch-muted">git state not available.</p>
            {!read && <p className="dispatch-gsub dispatch-muted" data-testid="dispatch-gh-local-notread">{notReadText}</p>}
          </>
        )
        : (
          <>
            <p className="dispatch-gline">{syncPhrase(git, project.project_id, primaryName)}</p>
            {isShared && <p className="dispatch-gsub">The clone is shared, so these are the same commits.</p>}
            {git.origin !== null && git.origin.compare === 'compared' && (
              <p className="dispatch-gsub">
                Counted against <code>{git.origin.ref}</code> as this clone has it; {asOf && (asOf.updatedAt
                  ? <><code>{git.origin.ref}</code> last updated here <Time iso={asOf.updatedAt} /></>
                  : <>update time not recorded</>)}; this page never fetches.
              </p>
            )}
            {git.origin === null && <p className="dispatch-gsub">not compared with origin.</p>}
            {/* A read with a head shows the head commit; a read with no head (an empty repository, `head: null`) says the
                default branch has no commits, not "GitHub not read" (V26); a not-read project says "GitHub not read". */}
            {headState === 'head' && github?.head
              ? (
                <p className="dispatch-gsub">
                  GitHub <code>{github.default_branch ?? defaultBranch}</code> is at{' '}
                  <a className="dispatch-ext" href={ghUrl(github.repo ?? '', 'commit', github.head.sha)} target="_blank" rel="noopener"><code>{github.head.sha.slice(0, 7)}</code></a>,
                  committed <Time iso={github.head.committed_at} />.
                </p>
              )
              : headState === 'no-head'
                ? (
                  <p className="dispatch-gsub dispatch-muted" data-testid="dispatch-gh-local-nohead">
                    {github?.default_branch ? <>GitHub's <code>{github.default_branch}</code> has no commits.</> : githubNoHeadText(null)}
                  </p>
                )
                : <p className="dispatch-gsub dispatch-muted" data-testid="dispatch-gh-local-notread">{notReadText}</p>}
            {git.origin?.compare === 'compared' && (git.origin.ahead ?? 0) > 0 && (
              <p className="dispatch-gsub" data-testid="dispatch-ahead-naming">
                Of the {git.origin.ahead} ahead, {git.ahead_naming_run} name a run; {(git.origin.ahead ?? 0) - git.ahead_naming_run} do not name a known run. Runs never push.
              </p>
            )}
            {git.landings.length > 0 && (
              <p className="dispatch-gsub" data-testid="dispatch-landings">
                {git.landings.filter(l => l.on_default === true).length} of {plural(git.landings.length, 'landing')} on local <code>{defaultBranch}</code>;
                {' '}{git.landings.filter(l => l.on_origin === true).length} on origin;
                {' '}{git.landings.filter(l => l.on_default === null || l.on_origin === null).length} unknown.
              </p>
            )}
            {hasAheadOrLandings && (
              <button type="button" className="dispatch-gh-ahead-btn" data-testid="dispatch-ahead-button" aria-pressed={aheadOpen} onClick={onShowAhead}>
                Commits ahead and landings
              </button>
            )}
          </>
        )}
    </div>
  )

  // A project whose GitHub was not read has no Pull requests or Issues card: the Local and GitHub card says why, once.
  let prs: React.ReactNode = null
  let issues: React.ReactNode = null
  if (read) {
    const groups = prGroups(github.prs, { branches, viewerLogin, readAt, defaultBranch })
    const relWhy = (pr: Pr) => { const rel = prRelation(pr, branches, defaultBranch); return rel ? `possibly related: ${relatedWhy(rel)}` : '' }
    prs = (
      <div className="dispatch-gcard" id="g-prs" data-testid="dispatch-gh-prs" tabIndex={-1}>
        <h3><span className="dispatch-gh-title">Pull requests</span> <span className="dispatch-aside">{github.open_prs ?? 0} open · showing the 20 most recently updated</span></h3>
        {github.status === 'read' && github.reason && <p className="dispatch-gsub dispatch-stale">Last read <Time iso={github.read_at ?? new Date(readAt).toISOString()} />; the latest refresh failed: {github.reason}</p>}
        <Group title="Possibly related" items={groups.related} render={(pr: Pr) => <PrRow key={pr.number} pr={pr} defaultBranch={defaultBranch} readAt={readAt} why={relWhy(pr)} />} />
        <Group title="Yours, open" items={groups.mine} render={(pr: Pr) => <PrRow key={pr.number} pr={pr} defaultBranch={defaultBranch} readAt={readAt} />} />
        <Group title="Others, open" items={groups.others} render={(pr: Pr) => <PrRow key={pr.number} pr={pr} defaultBranch={defaultBranch} readAt={readAt} />} />
        <Group title="Merged in the last 14 days" items={groups.merged} note="among the 20 shown" render={(pr: Pr) => <PrRow key={pr.number} pr={pr} defaultBranch={defaultBranch} readAt={readAt} />} />
        {github.prs.length === 0 && <p className="dispatch-muted">No pull requests.</p>}
        <p className="dispatch-note">Read <Time iso={github.read_at ?? new Date(readAt).toISOString()} />. Runs integrate locally and never open a pull request; related means a branch name matches.</p>
      </div>
    )
    const ig = issueGroups(github.issues, { viewerLogin })
    issues = (
      <div className="dispatch-gcard" id="g-iss" data-testid="dispatch-gh-issues" tabIndex={-1}>
        <h3><span className="dispatch-gh-title">Issues</span> <span className="dispatch-aside">{github.open_issues ?? 0} open</span></h3>
        <Group title="Assigned to you" items={ig.assigned} render={(issue: Issue) => <IssueRow key={issue.number} issue={issue} readAt={readAt} />} />
        <Group title="Newest from people" items={ig.people} render={(issue: Issue) => <IssueRow key={issue.number} issue={issue} readAt={readAt} />} />
        {ig.botCount > 0 && <p className="dispatch-note">{ig.botCount} from bots among the newest 20 ({ig.botAuthors.join(', ')}).</p>}
        {github.issues.length === 0 && <p className="dispatch-muted">No open issues.</p>}
        {(github.open_issues ?? 0) > 0 && github.repo && <a className="dispatch-ext dispatch-more" href={ghUrl(github.repo, 'issues')} target="_blank" rel="noopener">All {github.open_issues} on GitHub</a>}
      </div>
    )
  }

  const alsoCheckedOut = others.length > 0 && (
    <div className="dispatch-gcard" data-testid="dispatch-gh-others">
      <h3>Also checked out as <span className="dispatch-aside">same repo</span></h3>
      <ul className="dispatch-co">
        {others.map(other => (
          <li key={other.project.project_id}>
            <AppLink href={projectPathname(other.project.project_id)} onNavigate={onNavigate}>{other.project.name}</AppLink>
            <span className="dispatch-muted"> on <code>{other.checkout ?? 'unknown'}</code> · {other.cloneId !== null && other.cloneId === git?.clone_id ? 'same clone' : 'separate clone'}</span>
          </li>
        ))}
      </ul>
    </div>
  )

  return (
    <aside className="dispatch-gh" aria-label="GitHub and local branch" data-testid="dispatch-github">
      {local}{prs}{issues}{alsoCheckedOut}
    </aside>
  )
}
