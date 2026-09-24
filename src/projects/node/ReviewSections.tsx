import type { RunDetail, RunInputs, ReviewResult, RunScope } from '../api.ts'
import { ReviewPanel } from '../ReviewDetail.tsx'
import { NodeSection } from '../SectionIndex.tsx'
import type { Resource } from '../useResource.ts'
import './review.css'

type DefinitionNode = RunDetail['definition']['nodes'][number]
type SnapshotNode = RunDetail['snapshot']['nodes'][number]

/** The independent review's section: the recorded verdict, its reviewers and their findings (docs/PRD_VIEWER_UX.md 4.7). */
export function ReviewSections({ scope, node, definitionNodes, snapshotNodes, inputs, refreshToken, onNavigate, onOpenRequirement, onOpenFile, onTransport }: {
  scope: RunScope
  node: SnapshotNode
  definitionNodes: DefinitionNode[]
  snapshotNodes: SnapshotNode[]
  inputs: Resource<RunInputs | null>
  refreshToken: number
  onNavigate: (pathname: string) => void
  onOpenRequirement: (nodeId: string, quote: string) => void
  onOpenFile: (nodeId: string, path: string) => void
  /** Called with the served review's transport, which decides the executor wording ("one print job per reviewer"). */
  onTransport: (transport: ReviewResult['reviewer']['transport']) => void
}) {
  return (
    <NodeSection sectionKey="review" title="Review result">
      <ReviewPanel
        scope={scope}
        node={node}
        definitionNodes={definitionNodes}
        snapshotNodes={snapshotNodes}
        inputs={inputs}
        refreshToken={refreshToken}
        onNavigate={onNavigate}
        onOpenRequirement={onOpenRequirement}
        onOpenFile={onOpenFile}
        onTransport={onTransport}
      />
    </NodeSection>
  )
}
