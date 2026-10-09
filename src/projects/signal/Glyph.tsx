import type { Tone } from '../tone.ts'

/**
 * The six state glyphs of the run stage, drawn once as SVG symbols (`GlyphDefs`, mounted by the run page) and referenced
 * everywhere a tone shows, so every colour on the page comes with a shape: a tick for succeeded, a play mark for running, a
 * diamond with a question for needs you, a crossed square for failed, two bars for paused, a dotted ring for pending.
 */
export function GlyphDefs() {
  return (
    <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden="true" focusable="false">
      <defs>
        <symbol id="sb-g-ok" viewBox="0 0 20 20"><circle cx="10" cy="10" r="8.5" fill="currentColor" /><path d="M5.8 10.4l2.8 2.8 5.6-6" fill="none" stroke="var(--surface)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></symbol>
        <symbol id="sb-g-run" viewBox="0 0 20 20"><circle cx="10" cy="10" r="7.5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeDasharray="30 18" /><path d="M8 6.6v6.8l5.4-3.4z" fill="currentColor" /></symbol>
        <symbol id="sb-g-warn" viewBox="0 0 20 20"><path d="M10 1.5l8.5 8.5-8.5 8.5L1.5 10z" fill="currentColor" /><path d="M7.7 8a2.4 2.4 0 1 1 3.4 2.2c-.7.3-1.1.8-1.1 1.5v.4" fill="none" stroke="var(--surface)" strokeWidth="1.9" strokeLinecap="round" /><circle cx="10" cy="14.4" r="1.1" fill="var(--surface)" /></symbol>
        <symbol id="sb-g-fail" viewBox="0 0 20 20"><rect x="1.8" y="1.8" width="16.4" height="16.4" rx="3" fill="currentColor" /><path d="M6.6 6.6l6.8 6.8M13.4 6.6l-6.8 6.8" stroke="var(--surface)" strokeWidth="2.2" strokeLinecap="round" /></symbol>
        <symbol id="sb-g-pause" viewBox="0 0 20 20"><circle cx="10" cy="10" r="8.5" fill="currentColor" /><path d="M8 6.5v7M12 6.5v7" stroke="var(--surface)" strokeWidth="2.2" strokeLinecap="round" /></symbol>
        <symbol id="sb-g-idle" viewBox="0 0 20 20"><circle cx="10" cy="10" r="7.4" fill="none" stroke="currentColor" strokeWidth="2.2" strokeDasharray="3.2 3" /></symbol>
      </defs>
    </svg>
  )
}

/** One glyph in its tone's colour; decorative, since the word beside it carries the state. */
export function Glyph({ tone, className = 'g', size }: { tone: Tone; className?: string; size?: number }) {
  return (
    <svg className={className} aria-hidden="true" focusable="false" style={size === undefined ? { color: `var(--${tone})` } : { width: size, height: size, color: `var(--${tone})` }}>
      <use href={`#sb-g-${tone}`} />
    </svg>
  )
}
