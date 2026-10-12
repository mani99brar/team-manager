/**
 * Small shared components of the dispatch pages: the one glyph per tone (colour never carries state alone, PRD 3.4) and a
 * GitHub visibility chip. The tones and fonts are the Signal Box world (`theme.css`). Pure helpers live in `format.ts`.
 */
import { toneClass, TONE_LABEL, type Tone } from '../tone.ts'
import { TONE_GLYPH } from './format.ts'

export function StateGlyph({ tone, live = false, className = '' }: { tone: Tone; live?: boolean; className?: string }) {
  return (
    <span className={`dispatch-glyph ${toneClass(tone)} ${live ? 'live' : ''} ${className}`.trim()} aria-hidden="true" title={TONE_LABEL[tone]}>
      {TONE_GLYPH[tone]}
    </span>
  )
}

const VIS_LABEL: Record<string, string> = { PUBLIC: 'public', PRIVATE: 'private', INTERNAL: 'internal' }

export function VisibilityChip({ visibility }: { visibility: string | null }) {
  if (visibility === null) return null
  const label = VIS_LABEL[visibility] ?? visibility.toLowerCase()
  return <span className="dispatch-vis" data-visibility={visibility}>{label}</span>
}
