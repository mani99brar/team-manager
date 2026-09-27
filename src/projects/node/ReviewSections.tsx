import type { ReviewResult, RunDetail, RunInputs, RunScope } from '../api.ts'
import { BlockingFindings, ReviewPanel } from '../ReviewDetail.tsx'
import { NodeSection } from '../SectionIndex.tsx'
import type { Resource } from '../useResource.ts'
import { blockingFindings } from './panels.ts'
import './review.css'

type DefinitionNode = RunDetail['definition']['nodes'][number]
type SnapshotNode = RunDetail['snapshot']['nodes'][number]

/**
 * The independent review's sections (docs/PRD_VIEWER_UX.md 4.7): what blocks integration first, one card per unresolved P0
 * or P1 before the findings table, then the recorded verdict, its reviewers and their findings. The node page holds the
 * review; these sections only render it.
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
