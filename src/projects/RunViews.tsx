import type { RunScope } from './api.ts'
import { AppLink } from './panels.tsx'
import { RUN_TABS, runViewPathname, type RunTab } from './routes.ts'
import { Glyph } from './signal/Glyph.tsx'
import type { Suffix } from './tone.ts'
import './runViews.css'

/** The switcher's state suffixes: only Team and GitHub take one; null or absent shows none. */
export type RunViewSuffixes = { team?: Suffix | null; github?: Suffix | null }

const LABEL: Record<RunTab, string> = { run: 'Run', team: 'Team', github: 'GitHub', assignment: 'Assignment' }
/** A suffix word longer than this is ellipsized, its full text in `title`. */
const SUFFIX_MAX = 24

type Props = {
  scope: RunScope
  /** The view shown; null on a node page, whose run bar links to all four and marks none as the current page. */
  current: RunTab | null
  suffixes?: RunViewSuffixes
  /** The node page's run bar: four plain links, no suffix. */
  plain?: boolean
  onNavigate: (pathname: string) => void
}

/**
 * The run's view switcher (docs/PRD_RUN_TEAMS.md 2 "Views and routing" and 10): a `<nav aria-label="Run views">` of four
 * links, Run · Team · GitHub · Assignment, because each view is its own URL. The current one carries `aria-current="page"`
 * and a 3 px accent bar (selection is never a tone). Team and GitHub may carry a state suffix, a glyph in its tone and a
 * lower-case word; on a phone only the glyph shows and the word stays in the link's accessible name ("GitHub view, pull
 * request 531, checks failing"). The Team segment always shows, so the switcher never changes shape when records appear.
 */
export function RunViews({ scope, current, suffixes = {}, plain = false, onNavigate }: Props) {
  return (
    <nav aria-label="Run views" data-testid="run-views" className={`run-views-nav${plain ? ' plain' : ''}`}>
      {RUN_TABS.map(tab => {
        const suffix = plain ? null : tab === 'team' ? suffixes.team ?? null : tab === 'github' ? suffixes.github ?? null : null
        const long = suffix !== null && suffix.word.length > SUFFIX_MAX
        return (
          <AppLink
            key={tab}
            href={runViewPathname(scope.projectId, scope.workflowId, scope.runId, tab)}
            onNavigate={onNavigate}
            className="run-view-link"
            current={tab === current}
            aria-label={`${LABEL[tab]} view${suffix ? `, ${suffix.spoken}` : ''}`}
            data-testid="run-view-link"
            data-view={tab}
          >
            <span className="run-view-label">{LABEL[tab]}</span>
            {suffix && (
              <span className="run-view-suffix" data-testid="run-view-suffix" data-tone={suffix.tone ?? 'none'} title={long ? suffix.word : undefined}>
                {suffix.tone && <Glyph tone={suffix.tone} className="run-view-glyph" />}
                <span className="run-view-word">{long ? `${suffix.word.slice(0, SUFFIX_MAX - 1)}…` : suffix.word}</span>
              </span>
            )}
          </AppLink>
        )
      })}
    </nav>
  )
}
