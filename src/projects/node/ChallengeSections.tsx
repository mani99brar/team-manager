import type { RunInputs } from '../api.ts'
import { ChallengeAccepted, ChallengeAlternative, ChallengeConcerns, ChallengeFacts, ChallengeHistory } from '../Challenge.tsx'
import { ErrorPanel, LoadingPanel } from '../panels.tsx'
import { NodeSection } from '../SectionIndex.tsx'
import type { Resource } from '../useResource.ts'
import './review.css'

/**
 * The design challenge's sections (docs/PRD_VIEWER_UX.md 4.8), read from the run inputs, which pin the latest
 * `challenge.json`: the folded record and the operator's reason, then the concerns (P0/P1 open, P2 one line each), the
 * alternative with the experiment, and the earlier attempts' P0/P1 (C49). The headline above the index is `ChallengeHeadline`, rendered by the node page.
 */
export function ChallengeSections({ inputs, onRetryInputs }: { inputs: Resource<RunInputs | null>; onRetryInputs: () => void }) {
  if (inputs.status === 'loading' || inputs.status === 'idle') return <LoadingPanel>Loading the design challenge…</LoadingPanel>
  if (inputs.status === 'error') return <ErrorPanel error={inputs.error} what="The run inputs" onRetry={onRetryInputs} />
  const challenge = inputs.data?.challenge ?? null
  if (challenge === null) return <p className="projects-muted" data-testid="challenge-none">No design challenge was recorded for this run.</p>
  return (
    <div className="challenge" data-testid="challenge" data-challenge-status={challenge.status}>
      <ChallengeFacts challenge={challenge} />
      <ChallengeAccepted challenge={challenge} />
      {challenge.concerns.length > 0 && (
        <NodeSection sectionKey="concerns" title="Concerns" testId="challenge-concerns">
          <ChallengeConcerns challenge={challenge} />
        </NodeSection>
      )}
      <NodeSection sectionKey="alternative" title="Alternative & experiment">
        <ChallengeAlternative challenge={challenge} />
      </NodeSection>
      {(challenge.history ?? []).length > 0 && (
        <NodeSection sectionKey="history" title="Earlier attempts" testId="challenge-history-section">
          <ChallengeHistory challenge={challenge} />
        </NodeSection>
      )}
    </div>
  )
}
