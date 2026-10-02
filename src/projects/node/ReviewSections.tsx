import type { ReviewResult, RunDetail, RunInputs, RunScope } from '../api.ts'
import { runLanes } from '../findings.ts'
import { BlockingFindings, ReviewPanel } from '../ReviewDetail.tsx'
import { NodeSection } from '../SectionIndex.tsx'
import { Figures } from '../ui/index.tsx'
import type { Resource } from '../useResource.ts'
import { blockingFindings, reviewFigures } from './panels.ts'
import './review.css'

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
 * The independent review's sections (docs/PRD_VIEWER_UX.md 4.7, docs/PRD_VIEWER_REVAMP.md 5.4): four figures, then what blocks
 * integration, one card per unresolved P0 or P1 before the findings, then the recorded verdict, the findings as cards with
 * their filter row and the reviewer cards. The node page holds the review; these sections only render it.
 */
export function ReviewSections({ scope, review, onRetryReview, unscopedUri, definitionNodes, snapshotNodes, inputs, refreshToken, onNavigate, onOpenRequirement, onOpenFile }: {
  scope: RunScope
  review: Resource<ReviewResult>
  onRetryReview: () => void
  unscopedUri: string | null
  definitionNodes: DefinitionNode[]
  snapshotNodes: SnapshotNode[]
  inputs: Resource<RunInputs | null>
  refreshToken: number
  onNavigate: (pathname: string) => void
  onOpenRequirement: (nodeId: string, quote: string) => void
  onOpenFile: (nodeId: string, path: string) => void
}) {
  const recorded = review.status === 'ready' ? review.data : null
  return (
    <>
      {recorded !== null && <ReviewFigures review={recorded} lanes={runLanes(definitionNodes, inputs)} />}
      {recorded !== null && blockingFindings(recorded).length > 0 && (
        <NodeSection sectionKey="blocking" title="Blocks integration" className="blocking-section" testId="blocking-findings">
          <BlockingFindings review={recorded} scope={scope} definitionNodes={definitionNodes} inputs={inputs} onOpenRequirement={onOpenRequirement} />
        </NodeSection>
      )}
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
    </>
  )
}
