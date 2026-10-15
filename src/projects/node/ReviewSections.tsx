import type { FixLoop } from '../../../contracts/projects/v1.ts'
import type { ReviewResult, RunDetail, RunInputs, RunScope } from '../api.ts'
import { archivedRounds } from '../critique.ts'
import { laneWording, runLanes } from '../findings.ts'
import { CritiqueEvidence, ReviewPanel } from '../ReviewDetail.tsx'
import { NodeSection } from '../SectionIndex.tsx'
import { Figures, SeverityChip } from '../ui/index.tsx'
import { severityClass, severityTone } from '../tone.ts'
import type { Resource } from '../useResource.ts'
import { reviewFigures } from './panels.ts'
import './review.css'
import '../critique.css'

type DefinitionNode = RunDetail['definition']['nodes'][number]
type SnapshotNode = RunDetail['snapshot']['nodes'][number]

/** The four figures a review opens on (docs/PRD_VIEWER_REVAMP.md 5.4): blocking, open, per reviewer and per lane. */
function ReviewFigures({ review, lanes }: { review: ReviewResult; lanes: string[] }) {
  const figures = reviewFigures(review, lanes)
  return (
    <Figures
      className="review-figures"
      data-testid="review-figures"
      items={[
        { testId: 'figure-blocking', value: figures.blocking, label: 'Blocking', tone: figures.blocking > 0 ? 'fail' : 'ok' },
        { testId: 'figure-open', value: figures.open, label: 'Open', tone: figures.open > 0 ? 'warn' : 'ok' },
        {
          testId: 'figure-reviewers',
          label: 'Per reviewer',
          value: <span className="figure-list">{figures.reviewers.map(item => <span key={item.id} data-reviewer={item.id} data-count={item.count}>{item.id} {item.count}</span>)}</span>,
        },
        {
          testId: 'figure-lanes',
          label: 'Per lane',
          value: figures.lanes.length === 0 ? '—' : <span className="figure-list">{figures.lanes.map(item => <span key={item.key} data-lane={item.key} data-count={item.count}>{item.label} {item.count}</span>)}</span>,
        },
      ]}
    />
  )
}

/**
 * The "Earlier rounds" list (docs/PRD_USER_CRITIQUE.md 4.5, decisions.md [L2]): one entry per archived review round, each with
 * its findings (every reviewer's — archived rounds carry the open P0/P1 blockers), and a critique finding keeps its own steps
 * and screenshots. These cards are not `finding` rows (their own test ids), so the live findings count is untouched (design
 * challenge note 6). A run with no archived round renders nothing.
 */
function EarlierRounds({ scope, loop }: { scope: RunScope; loop: FixLoop | null }) {
  const rounds = archivedRounds(loop)
  if (rounds.length === 0) return null
  return (
    <NodeSection sectionKey="earlier-rounds" title="Earlier rounds" testId="earlier-rounds">
      <p className="projects-muted">Each archived review round's findings (every reviewer's); a critique finding keeps its own steps to reproduce and screenshots.</p>
      <ol className="earlier-rounds-list">
        {rounds.map(round => (
          <li key={round.round} className="earlier-round" data-testid="earlier-round" data-round={round.round}>
            <h5 className="earlier-round-head">Round {round.round} · {round.verdict} · lane {round.lane}</h5>
            {round.findings.length === 0 ? (
              <p className="projects-muted" data-testid="earlier-round-empty">This round archived no blocking finding.</p>
            ) : (
              <ul className="earlier-round-findings">
                {round.findings.map((finding, index) => (
                  <li
                    key={index}
                    className={`earlier-finding ui-card ${severityClass(severityTone(finding.severity))}`}
                    data-testid="earlier-finding"
                    data-severity={finding.severity}
                    data-reviewer={finding.reviewer}
                    data-worker={finding.worker ?? 'unrecorded'}
                  >
                    <p className="earlier-finding-head">
                      <SeverityChip severity={finding.severity} className="finding-severity" /> · {finding.disposition} · {finding.reviewer} · {laneWording(finding.worker)}
                    </p>
                    <p className="earlier-finding-message">{finding.message}</p>
                    <CritiqueEvidence scope={scope} finding={finding} />
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ol>
    </NodeSection>
  )
}

/**
 * The independent review's sections (docs/PRD_VIEWER_UX.md 4.7, docs/PRD_VIEWER_REVAMP.md 5.4): four figures, then the
 * recorded verdict, the one findings list (opening on the open P0/P1, each marked in place) with its filter row and the
 * reviewer cards, then the "Earlier rounds" list of archived rounds (PRD_USER_CRITIQUE 4.5). The node page holds the review
 * and the fix loop; these sections only render them.
 */
export function ReviewSections({ scope, review, onRetryReview, unscopedUri, definitionNodes, snapshotNodes, inputs, fixLoop, refreshToken, onNavigate, onOpenRequirement, onOpenFile }: {
  scope: RunScope
  review: Resource<ReviewResult>
  onRetryReview: () => void
  unscopedUri: string | null
  definitionNodes: DefinitionNode[]
  snapshotNodes: SnapshotNode[]
  inputs: Resource<RunInputs | null>
  fixLoop: FixLoop | null
  refreshToken: number
  onNavigate: (pathname: string) => void
  onOpenRequirement: (nodeId: string, quote: string) => void
  onOpenFile: (nodeId: string, path: string) => void
}) {
  const recorded = review.status === 'ready' ? review.data : null
  return (
    <>
      {recorded !== null && <ReviewFigures review={recorded} lanes={runLanes(definitionNodes, inputs)} />}
      <NodeSection sectionKey="review" title="Review result">
        <ReviewPanel
          scope={scope}
          review={review}
          onRetry={onRetryReview}
          unscopedUri={unscopedUri}
          definitionNodes={definitionNodes}
          snapshotNodes={snapshotNodes}
          inputs={inputs}
          refreshToken={refreshToken}
          onNavigate={onNavigate}
          onOpenRequirement={onOpenRequirement}
          onOpenFile={onOpenFile}
        />
      </NodeSection>
      <EarlierRounds scope={scope} loop={fixLoop} />
    </>
  )
}
