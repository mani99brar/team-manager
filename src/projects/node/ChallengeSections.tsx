import type { RunInputs } from '../api.ts'
import { ChallengePanel } from '../Challenge.tsx'
import { NodeSection } from '../SectionIndex.tsx'
import type { Resource } from '../useResource.ts'

/** The design challenge's section: its outcome, concerns, alternative and experiment, from the run inputs (docs/PRD_VIEWER_UX.md 4.8). */
export function ChallengeSections({ inputs, onRetryInputs }: { inputs: Resource<RunInputs | null>; onRetryInputs: () => void }) {
  return (
    <NodeSection sectionKey="challenge" title="Design challenge">
      <ChallengePanel inputs={inputs} onRetry={onRetryInputs} />
    </NodeSection>
  )
}
