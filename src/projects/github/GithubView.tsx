import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import type { Now } from '../../../contracts/projects/triage.ts'
import { textToString } from '../../../contracts/projects/triage.ts'
import { runSummaryMarkdown, runSummaryTitle } from '../../../contracts/projects/summary.ts'
import type { ReviewResult, RunDetail, RunGithub, RunInputs, RunScope, Sessions, Teams } from '../api.ts'
import type { ControlsState } from '../controls/store.ts'
import { fetchDispatchOverview } from '../dispatch/client.ts'
import { ErrorPanel, LoadingPanel } from '../panels.tsx'
import { Glyph } from '../signal/Glyph.tsx'
import { withoutGlyph } from '../steps.ts'
import { formatAgo, formatClock, formatSpan, type Zone } from '../time.ts'
import { useResource, type Resource, type ResourceMeta } from '../useResource.ts'
import { useRunResults } from '../useRunData.ts'
import { actionNote, PANEL_COPY, panelState, recentRecords, recordLabel, recordShown, UNKNOWN_SENTENCE, unknownLine } from './actions.ts'
import {
  BRANCH_FRESHNESS, checkRowTone, checksLine, COMMANDS_CAPTION, CONNECTION_NOTE, connectionLine, conversationLine, defaultBranchLine, earlierPrsLine, freshness,
  githubSituation, handCommands, headCommitNote, integratedLine, mergeWord, NO_CHECKOUT_NOTE, NO_PR_TEXT, parseReviewers, prStatePill, pushPill, reviewDecisionWord,
  reviewerChip, reviewStateWord, SHARE_TEXT, shasLine, short, summaryInput, unpublishedCount, visibilityWord, type Situation,
} from './model.ts'
import { CommandBox, CopyButton, Pill } from './parts.tsx'
import { openGithubDialog, useGithubActions, type GithubActionsState } from './store.ts'
import './github.css'

/**
 * What the GitHub view reads (docs/PRD_RUN_TEAMS.md 4 "GitHub view"); every run-level resource is created in `RunView` and
 * passed down, and the one clock ticks there. The actions panel reads the run-control pairing itself through the controls
 * store (`useRunControls(scope)`, `controls/store.ts`) and `fetchGithubActions`/`postGithubAction` (`api.ts`), so an
 * unconfigured page asks nothing beyond the status probe.
 */
export type GithubViewProps = {
  scope: RunScope
  detail: RunDetail
  inputs: Resource<RunInputs | null>
  /** The run's sessions payload, for the run summary; null while not loaded or not recorded. */
  sessions: Sessions | null
  /** The teams read, for the run summary; null when not loaded or not served. */
  teams: Teams | null
  /** The run's GitHub read: `ready` with null when the server does not serve it (404 `NOT_RECORDED.runGithub`). */
  runGithub: Resource<RunGithub | null>
  runGithubMeta: ResourceMeta
  /** Reads the GitHub facts again now (after an action record ends). */
  onRetryRunGithub: () => void
  review: ReviewResult | null
  now: Now | null
  clock: number
  zone: Zone
  live: boolean
  nodeHref: (nodeId: string) => string
  onNavigate: (pathname: string) => void
  onAnnounce: (message: string) => void
}

const FOLD_AT = 5

/** A card: a `<section>` with its own `h3`, at its place in the phone's one column (`order`). */
function Card({ id, title, testId, order, children }: { id: string; title: string; testId: string; order: number; children: ReactNode }) {
  return (
    <section className="gh-card" data-testid={testId} aria-labelledby={`${id}-title`} style={{ order }}>
      <h3 className="gh-card-h" id={`${id}-title`}>{title}</h3>
      {children}
    </section>
  )
}

/** A list that folds after five items on a phone (4.1); the toggle shows only there. */
function FoldList({ id, items, className }: { id: string; items: ReactNode[]; className: string }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <ol className={`${className} gh-fold${open ? ' is-open' : ''}`} id={id}>{items}</ol>
      {items.length > FOLD_AT && (
        <button type="button" className="button button-small gh-fold-toggle" aria-expanded={open} aria-controls={id} onClick={() => setOpen(value => !value)}>
          {open ? 'Show fewer' : `Show all ${items.length}`}
        </button>
      )}
    </>
  )
}

const notRecorded = <em className="gh-none">not recorded</em>
const ago = (iso: string | null, now: number) => (iso ? formatAgo(iso, now) : null)

function Banner({ situation, read, now, actionsState, controls, scope }: { situation: Situation; read: RunGithub; now: number; actionsState: GithubActionsState; controls: ControlsState; scope: RunScope }) {
  const lines = freshness(read, now)
  const offered = situation.next.action !== null && controls.mode === 'on' && controls.paired && actionsState.data?.enabled
    ? actionsState.data.actions.find(action => action.id === situation.next.action && action.available) ?? null
    : null
  const fallback = situation.next.fallback
  const toCommands = (event: MouseEvent) => {
    event.preventDefault()
    const heading = document.getElementById('gh-commands-title')
    heading?.scrollIntoView({ block: 'start' })
    heading?.focus({ preventScroll: true })
  }
  return (
    <section className={`gh-banner tone-${situation.tone}`} data-testid="gh-banner" data-state={situation.id} data-tone={situation.tone} aria-labelledby="gh-banner-title" style={{ order: 0 }}>
      <h3 id="gh-banner-title" className="visually-hidden">Where the run branch stands on GitHub</h3>
      <p className="gh-banner-sentence" data-testid="gh-banner-sentence">
        <Glyph tone={situation.tone} className="gh-banner-glyph" />
        <span>{situation.sentence}</span>
      </p>
      <p className="gh-fresh" data-testid="gh-banner-fresh">{lines.banner}</p>
      {lines.failed && <p className="gh-fresh" data-testid="gh-banner-failed">{lines.failed}</p>}
      {(offered || fallback) && (
        <p className="gh-banner-next" data-testid="gh-banner-next">
          {offered
            ? <button type="button" className="button gh-action-button" data-testid="gh-banner-action" data-action={offered.id} onClick={() => openGithubDialog(scope, offered.id)}>{offered.label}</button>
            : fallback?.kind === 'commands'
              ? <a href="#gh-commands-title" onClick={toCommands} data-testid="gh-banner-link">See the command below ↓</a>
              : fallback?.kind === 'check'
                ? <a href={fallback.url} target="_blank" rel="noopener" data-testid="gh-banner-link">Open the failing check ↗</a>
                : fallback?.kind === 'pr'
                  ? <a href={fallback.url} target="_blank" rel="noopener" data-testid="gh-banner-link">Open #{fallback.number} on GitHub ↗</a>
                  : null}
        </p>
      )}
    </section>
  )
}

function PrCard({ read, now, order }: { read: RunGithub; now: number; order: number }) {
  const [showPassing, setShowPassing] = useState(false)
  const pr = read.pr
  if (pr === null) return null
  const pill = prStatePill(pr)
  const decision = reviewDecisionWord(pr.review_decision)
  const merge = mergeWord(pr)
  const head = headCommitNote(pr, read.branch)
  const earlier = earlierPrsLine(read.earlier_prs)
  const items = pr.checks?.items ?? []
  const passingCount = items.filter(item => item.bucket === 'pass').length
  const foldPassing = items.length > FOLD_AT && passingCount > 0
  const shownChecks = foldPassing && !showPassing ? items.filter(item => item.bucket !== 'pass') : items
  return (
    <Card id="gh-pr" title="Pull request" testId="gh-pr-card" order={order}>
      <p className="gh-pr-head">
        <a className="gh-link" href={pr.url} target="_blank" rel="noopener" data-testid="gh-pr-link">#{pr.number} {pr.title} ↗</a>
        <Pill tone={pill.tone} word={pill.word} testId="gh-pr-state" />
      </p>
      <p className="gh-line"><code className="gh-mono gh-wrap">{pr.head_ref} → {pr.base_ref}</code></p>
      <p className="gh-line gh-muted">by {pr.author} · updated {ago(pr.updated_at, now)}</p>
      {head && <p className="gh-line" data-testid="gh-pr-head-commit">{head}</p>}
      <dl className="gh-facts">
        <div><dt>Review</dt><dd data-testid="gh-pr-review">{decision ? <Pill tone={decision.tone} word={decision.word} /> : notRecorded}</dd></div>
        <div><dt>Merge</dt><dd data-testid="gh-pr-merge">{merge === null ? notRecorded : merge.tone === null ? <span className="gh-muted">{merge.word}</span> : <Pill tone={merge.tone} word={merge.word} />}</dd></div>
        <div><dt>Conversation</dt><dd data-testid="gh-pr-conversation">{conversationLine(pr)}</dd></div>
      </dl>
      <h4 className="gh-sub-h">Checks</h4>
      {pr.checks === null ? <p className="gh-line gh-muted" data-testid="gh-pr-no-checks">No checks on the head commit.</p> : (
        <>
          <p className="gh-line" data-testid="gh-checks-line">{checksLine(pr.checks)}</p>
          <ul className="gh-rows" id="gh-check-rows">
            {shownChecks.map((check, index) => {
              const tone = checkRowTone(check.bucket)
              return (
                <li key={`${check.name}-${index}`} className="gh-row" data-testid="gh-check-row" data-tone={tone.tone}>
                  <Glyph tone={tone.tone} className="gh-glyph" />
                  <span className="gh-row-name">{check.name}</span>
                  <span className="gh-muted">{check.conclusion ? check.conclusion.toLowerCase() : tone.word}</span>
                  {check.url && <a className="gh-link" href={check.url} target="_blank" rel="noopener">details ↗</a>}
                </li>
              )
            })}
          </ul>
          {foldPassing && (
            <button type="button" className="button button-small" data-testid="gh-checks-fold" aria-expanded={showPassing} aria-controls="gh-check-rows" onClick={() => setShowPassing(value => !value)}>
              {showPassing ? 'Hide passing' : `Show ${passingCount} passing`}
            </button>
          )}
        </>
      )}
      <h4 className="gh-sub-h">Reviewers</h4>
      {pr.requested_reviewers.length === 0 && pr.latest_reviews.length === 0 && <p className="gh-line gh-muted">Nobody is requested and nobody has reviewed yet.</p>}
      {pr.requested_reviewers.length > 0 && (
        <p className="gh-chips" data-testid="gh-pr-requested">{pr.requested_reviewers.map(reviewer => <span key={`${reviewer.kind}-${reviewer.login}`} className="gh-chip">{reviewerChip(reviewer)}</span>)}</p>
      )}
      {pr.latest_reviews.length > 0 && (
        <ul className="gh-rows">
          {pr.latest_reviews.map((review, index) => (
            <li key={`${review.author}-${index}`} className="gh-row" data-testid="gh-pr-review-row">{review.author} · {reviewStateWord(review.state)}{review.submitted_at ? ` · ${ago(review.submitted_at, now)}` : ''}</li>
          ))}
        </ul>
      )}
      {earlier && <p className="gh-line gh-muted" data-testid="gh-pr-earlier">{earlier}</p>}
      <p className="gh-fresh">{freshness(read, now).github ?? 'not read from GitHub yet'}</p>
    </Card>
  )
}

function BranchCard({ read, now, zone, order }: { read: RunGithub; now: number; zone: Zone; order: number }) {
  const name = useRef<HTMLElement>(null)
  const { branch } = read
  const pill = pushPill(branch)
  const integrated = integratedLine(branch)
  const defaults = defaultBranchLine(branch, read.repo.default_branch)
  const count = unpublishedCount(branch)
  return (
    <Card id="gh-branch" title="Branch" testId="gh-branch-card" order={order}>
      {branch.name === null ? <p className="gh-line gh-muted">This run records no branch.</p> : (
        <p className="gh-branch-name">
          <code ref={name} className="gh-mono gh-wrap" data-testid="gh-branch-name">{branch.name}</code>
          <CopyButton text={branch.name} target={name} accessibleName="Copy the branch name" testId="gh-branch-copy" />
        </p>
      )}
      <p className="gh-line"><Pill tone={pill.tone} word={pill.word} testId="gh-push-state" /></p>
      <p className="gh-line gh-mono" data-testid="gh-branch-shas">{shasLine(branch)}</p>
      {defaults && <p className="gh-line" data-testid="gh-branch-default">{defaults}</p>}
      <p className={`gh-line${integrated.tone ? ` gh-tone-text tone-${integrated.tone}` : ''}`} data-testid="gh-branch-integrated">
        {integrated.tone && <Glyph tone={integrated.tone} className="gh-glyph" />}{integrated.text}
      </p>
      <h4 className="gh-sub-h">Commits a push would publish ({count})</h4>
      {branch.unpublished.length === 0 ? <p className="gh-line gh-muted">None listed.</p> : (
        <FoldList id="gh-branch-commits" className="gh-commits" items={branch.unpublished.map(commit => (
          <li key={commit.sha} className="gh-commit" data-testid="gh-commit-row">
            <code className="gh-sha">{short(commit.sha)}</code>
            <span className="gh-commit-subject">{commit.subject}</span>
            <span className="gh-commit-author" data-testid="gh-commit-author">{commit.author}</span>
            <time className="gh-commit-time" dateTime={commit.committed_at}>{formatClock(commit.committed_at, { zone, now })}</time>
          </li>
        ))} />
      )}
      {branch.unpublished_more > 0 && <p className="gh-line gh-muted">and {branch.unpublished_more} more not listed</p>}
      <p className="gh-fresh">{freshness(read, now).local}. {BRANCH_FRESHNESS}</p>
    </Card>
  )
}

function ConnectionCard({ read, order }: { read: RunGithub; order: number }) {
  const visibility = visibilityWord(read.github.visibility)
  const name = read.repo.owner_name
  return (
    <Card id="gh-connection" title="Connection" testId="gh-connection-card" order={order}>
      <p className="gh-line gh-repo">
        {name ? (read.repo.url ? <a className="gh-link" href={read.repo.url} target="_blank" rel="noopener">{name} ↗</a> : <span>{name}</span>) : <span className="gh-muted">No GitHub repository</span>}
        {visibility && <span className="gh-chip" data-testid="gh-visibility-chip">{visibility}</span>}
      </p>
      <p className="gh-line gh-muted" data-testid="gh-connection-line">{connectionLine(read)}</p>
      <p className="gh-line gh-muted">{CONNECTION_NOTE}</p>
    </Card>
  )
}

function ShareCard({ markdown, order }: { markdown: string | null; order: number }) {
  const [open, setOpen] = useState(false)
  const text = useRef<HTMLPreElement>(null)
  return (
    <Card id="gh-share" title="Share with teammates" testId="gh-share-card" order={order}>
      <p className="gh-line">{SHARE_TEXT}</p>
      {markdown === null ? <p className="gh-line gh-muted">The run's inputs are still being read.</p> : (
        <>
          <p className="gh-share-actions">
            <CopyButton text={markdown} target={text} label="Copy run summary" testId="gh-summary-copy" />
            <button type="button" className="button button-small" data-testid="gh-summary-toggle" aria-expanded={open} aria-controls="gh-summary-text" onClick={() => setOpen(value => !value)}>{open ? 'Hide the text' : 'Show the text'}</button>
          </p>
          <pre ref={text} id="gh-summary-text" className="gh-summary" data-testid="gh-summary-text" hidden={!open}>{markdown}</pre>
        </>
      )}
    </Card>
  )
}

function CommandsCard({ read, situation, checkout, summary, order }: { read: RunGithub; situation: Situation; checkout: string | null; summary: { title: string; markdown: string } | null; order: number }) {
  const [field, setField] = useState('')
  const parsed = parseReviewers(field)
  const reviewers = parsed.problem === null ? parsed.items : []
  const commands = handCommands(read, situation, { checkout, summary, reviewers })
  const hasGit = commands.some(command => command.text?.startsWith('git ') ?? false)
  return (
    <section className="gh-card gh-commands" data-testid="gh-commands" aria-labelledby="gh-commands-title" style={{ order }}>
      <h3 className="gh-card-h" id="gh-commands-title" tabIndex={-1}>Commands to run by hand</h3>
      <p className="gh-line gh-muted">{COMMANDS_CAPTION}</p>
      {hasGit && checkout === null && <p className="gh-line" data-testid="gh-no-checkout">{NO_CHECKOUT_NOTE}</p>}
      {commands.length === 0 && <p className="gh-line gh-muted" data-testid="gh-commands-none">No command moves this situation on from here.</p>}
      {commands.map(command => (
        <Fragment key={command.id}>
          {command.id === 'add-reviewers' && (
            <label className="gh-field" htmlFor="gh-reviewers-field">
              <span>Reviewers for the command below: logins or org/team names, separated by spaces or commas</span>
              <input id="gh-reviewers-field" type="text" data-testid="gh-reviewers-field" autoComplete="off" autoCapitalize="off" spellCheck={false} value={field} onChange={event => setField(event.target.value)} aria-invalid={parsed.problem !== null} />
              {parsed.problem !== null && <span className="gh-hint" data-testid="gh-reviewers-problem">{parsed.problem}</span>}
            </label>
          )}
          <CommandBox id={command.id} text={command.text} waiting={command.waiting} />
          {command.after && <p className="gh-line gh-after">{command.after}</p>}
        </Fragment>
      ))}
    </section>
  )
}

function ActionsPanel({ scope, state, controls, now, order }: { scope: RunScope; state: GithubActionsState; controls: ControlsState; now: number; order: number }) {
  const panel = panelState(controls, state.data, state.problem)
  const records = recentRecords(state.data, state.mine)
  return (
    <section className="gh-card gh-actions" data-testid="gh-actions" data-state={panel} aria-labelledby="gh-actions-title" style={{ order }}>
      <h3 className="gh-card-h" id="gh-actions-title">Publish on GitHub</h3>
      {panel === 'loading' && <p className="gh-line gh-muted">Reading the run controls…</p>}
      {panel === 'controls-off' && <p className="gh-line" data-testid="gh-actions-copy">{PANEL_COPY.controlsOff}</p>}
      {panel === 'unpaired' && <p className="gh-line" data-testid="gh-actions-copy">{PANEL_COPY.unpaired}</p>}
      {panel === 'actions-off' && <p className="gh-line" data-testid="gh-actions-copy">{PANEL_COPY.actionsOff}</p>}
      {panel === 'unreadable' && <p className="gh-line" data-testid="gh-actions-copy">The GitHub actions could not be read: {state.problem} The commands below do the same by hand.</p>}
      {panel === 'offered' && state.data && (
        <ul className="gh-action-list">
          {state.data.actions.map(action => (
            <li key={action.id} className="gh-action" data-testid="gh-action" data-action={action.id} data-available={action.available}>
              {action.available
                ? <button type="button" className="button gh-action-button" data-testid="gh-action-button" onClick={() => openGithubDialog(scope, action.id)}>{action.label}</button>
                : <span className="gh-action-label">{action.label}</span>}
              <span className="gh-action-note" data-testid="gh-action-note">{actionNote(action)}</span>
            </li>
          ))}
        </ul>
      )}
      {records.length > 0 && (panel === 'offered' || panel === 'actions-off') && (
        <>
          <h4 className="gh-sub-h">Recent GitHub actions</h4>
          <ul className="gh-rows">
            {records.map(record => {
              const tone = recordShown(record)
              const unknown = unknownLine(record)
              return (
                <li key={record.record_id} className="gh-record" data-testid="gh-action-record" data-state={record.status} data-outcome={unknown !== null ? 'unknown' : record.status}>
                  <span className="gh-record-line">
                    <span>{recordLabel(record, state.data)}</span>
                    <Pill tone={tone.tone} word={tone.word} />
                    <span className="gh-muted">{formatAgo(record.started_at, now)}</span>
                    {record.url && <a className="gh-link" href={record.url} target="_blank" rel="noopener">{record.url.replace(/^https:\/\/github\.com\//, '')} ↗</a>}
                  </span>
                  {unknown !== null && <p className="gh-unknown" data-testid="gh-record-unknown"><Glyph tone="warn" className="gh-glyph" /><span>{UNKNOWN_SENTENCE}</span></p>}
                  {(record.status === 'failed' || record.status === 'refused') && record.output_tail.length > 0 && (
                    <details className="gh-output-fold"><summary>Output</summary><pre className="gh-output">{record.output_tail.join('\n')}</pre></details>
                  )}
                </li>
              )
            })}
          </ul>
        </>
      )}
    </section>
  )
}

/** The project's checkout as the project page shows it (`~/dev/...`), from the dispatch overview; null when it is not read. */
function useCheckout(projectId: string): string | null {
  const load = useCallback((signal: AbortSignal) => fetchDispatchOverview(signal), [])
  const { state } = useResource('dispatch-overview:github-view', load, 0, 0)
  if (state.status !== 'ready') return null
  const git = state.data.projects.find(project => project.project_id === projectId)?.git
  return git?.status === 'read' && git.repository_label.startsWith('~/') ? git.repository_label : null
}

function GithubBody(props: GithubViewProps & { read: RunGithub }) {
  const { scope, detail, inputs, sessions, teams, read, review, now: nowBanner, clock, zone, onAnnounce } = props
  // Ages read against the later of the page's clock and the read itself: a finished run's clock stops, the poll does not.
  const now = Math.max(clock, Date.parse(read.read_at))
  const situation = githubSituation(read, now)
  const { controls, state } = useGithubActions(scope)
  const checkout = useCheckout(scope.projectId)
  const inputsData = inputs.status === 'ready' ? inputs.data : null
  // Each lane's worker report: the result of its launch step, read once per URI through the run's cache.
  const reportUris = useMemo(() => (inputsData?.workers ?? []).map(worker => detail.snapshot.nodes.find(node => node.node_id === worker.launch_node_id)?.result_uri ?? null), [inputsData, detail.snapshot.nodes])
  const fetchUris = useMemo(() => reportUris.filter((uri): uri is string => uri !== null), [reportUris])
  const { results } = useRunResults(scope, fetchUris, '0')
  const headline = useMemo(() => (nowBanner === null ? null : textToString(withoutGlyph(nowBanner.headline, nowBanner.glyph), Date.parse(read.read_at), { clock: (at: string) => formatClock(at, { zone }), ago: formatAgo, span: formatSpan })), [nowBanner, read.read_at, zone])
  const summary = useMemo(() => {
    if (inputs.status !== 'ready' && inputs.status !== 'error') return null
    const reports = new Map<string, string>()
    for (const [index, worker] of (inputsData?.workers ?? []).entries()) {
      const uri = reportUris[index]
      const result = uri ? results.get(uri) : undefined
      if (result) reports.set(worker.node_id, result.summary)
    }
    const input = summaryInput({ detail, inputs: inputsData, review, headline, teams, sessions, runGithub: read, reports })
    return { title: runSummaryTitle(input), markdown: runSummaryMarkdown(input) }
  }, [inputs.status, inputsData, reportUris, results, detail, review, headline, teams, sessions, read])
  // The polite announcer speaks a change of GitHub situation, never the first read (docs/PRD_RUN_TEAMS.md 10).
  const spoken = useRef<string | null>(null)
  useEffect(() => {
    const previous = spoken.current
    spoken.current = situation.id
    if (previous !== null && previous !== situation.id) onAnnounce(`GitHub: ${situation.suffix}`)
  }, [situation.id, situation.suffix, onAnnounce])
  const hasPr = read.pr !== null
  return (
    <div className="gh-layout" data-testid="gh-layout">
      <Banner situation={situation} read={read} now={now} actionsState={state} controls={controls} scope={scope} />
      <div className="gh-columns">
        <div className="gh-col gh-main">
          {hasPr && <PrCard read={read} now={now} order={2} />}
          <BranchCard read={read} now={now} zone={zone} order={3} />
          {!hasPr && (
            <Card id="gh-nopr" title="No pull request" testId="gh-no-pr-card" order={4}>
              <p className="gh-line">{NO_PR_TEXT}</p>
              <p className="gh-fresh">{freshness(read, now).github ?? 'not read from GitHub yet'}</p>
            </Card>
          )}
        </div>
        <div className="gh-col gh-side">
          <ActionsPanel scope={scope} state={state} controls={controls} now={now} order={1} />
          <ShareCard markdown={summary?.markdown ?? null} order={5} />
          <ConnectionCard read={read} order={7} />
        </div>
      </div>
      <CommandsCard read={read} situation={situation} checkout={checkout} summary={summary} order={6} />
    </div>
  )
}

/**
 * The GitHub view (docs/PRD_RUN_TEAMS.md 4): the answer banner (the situation's tone and sentence, the freshness line and
 * the single next action), then the Pull request and Branch cards (Branch and No pull request without one) beside Publish on
 * GitHub, Share with teammates and Connection, and the commands to run by hand across the bottom. On a phone it is one
 * column: banner, Publish, Pull request, Branch, Share, Commands, Connection. `RunView` renders the identity line, the
 * switcher and the visually hidden `h2#run-view-title` above it; the read has its own poll, which keeps going after the run.
 */
export function GithubView(props: GithubViewProps) {
  const { runGithub, onRetryRunGithub } = props
  let body: ReactNode
  if (runGithub.status === 'idle' || runGithub.status === 'loading') body = <LoadingPanel>Reading where the run branch stands against GitHub…</LoadingPanel>
  else if (runGithub.status === 'error') body = <ErrorPanel error={runGithub.error} what="The run's GitHub read" onRetry={onRetryRunGithub} />
  else if (runGithub.data === null) body = <p className="gh-line gh-muted" data-testid="gh-not-served">This server does not serve the run's GitHub read: it predates the GitHub view. Nothing about GitHub is shown rather than guessed.</p>
  else body = <GithubBody {...props} read={runGithub.data} />
  return (
    <section className="gh-view" data-testid="gh-view" aria-labelledby="run-view-title">
      {body}
    </section>
  )
}
