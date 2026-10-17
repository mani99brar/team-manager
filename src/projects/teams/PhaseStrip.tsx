import type { TeamPhase } from '../../../contracts/projects/teams.ts'
import { Glyph } from '../signal/Glyph.tsx'
import { toneClass } from '../tone.ts'
import { phaseSegments } from './model.ts'

/**
 * A workflow's phase strip (docs/PRD_RUN_TEAMS.md 3.4): one 44 px segment per phase in `index` order, equal width (at least
 * 140 px) and wrapping rather than scrolling; each a button with the phase glyph, `{index} · {title}` and its non-zero counts,
 * "not started" with a dashed border when no agent reached it. A segment toggles the roster's phase filter (`aria-pressed`).
 * On a phone it is a list of 44 px rows with the phase's detail as the second line. Never a percentage: a queued agent is
 * absent from the live records, so a denominator would be invented.
 */
export function PhaseStrip({ phases, pressed, onToggle, label }: { phases: readonly TeamPhase[]; pressed: number | null; onToggle: (index: number) => void; label: string }) {
  const segments = phaseSegments(phases)
  if (segments.length === 0) return null
  return (
    <div className="team-phase-strip" data-testid="team-phase-strip" role="group" aria-label={`Phases of ${label}`}>
      {segments.map(segment => (
        <button
          key={segment.index}
          type="button"
          className={`team-phase ${toneClass(segment.tone)}${segment.notStarted ? ' not-started' : ''}`}
          data-testid="team-phase"
          data-index={segment.index}
          data-tone={segment.tone}
          data-team-select=""
          aria-pressed={pressed === segment.index}
          aria-label={`Phase ${segment.index}, ${segment.title}: ${segment.counts}${segment.detail ? `. ${segment.detail}` : ''}`}
          title={segment.detail ?? undefined}
          onClick={() => onToggle(segment.index)}
        >
          <Glyph tone={segment.tone} className="team-glyph" />
          <span className="team-phase-title">{segment.index} · {segment.title}</span>
          <span className="team-phase-counts">{segment.counts}</span>
          {segment.detail && <span className="team-phase-detail">{segment.detail}</span>}
        </button>
      ))}
    </div>
  )
}
