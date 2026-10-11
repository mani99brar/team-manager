/**
 * The projects-only rail (docs/PRD_PROJECTS_DISPATCH.md 4.2, [O2]): "All projects" and "Triage" at the top, then one row per
 * project and nothing else — no workflow rows, no repository headers. Projects are ordered needs-you, running, readable,
 * unreadable, then by last activity ([D6]); each row has a glyph, the name, a badge and a sub-line. The current page is
 * marked. At 999px and below it becomes a chip row.
 */
import { projectPathname, projectsPathname, triagePathname } from '../routes.ts'
import { AppLink } from '../panels.tsx'
import { TONE_LABEL, type Tone } from '../tone.ts'
import { StateGlyph } from './common.tsx'

export type RailRow = {
  projectId: string
  name: string
  tone: Tone
  /** The badge text ("2 waits on you", "1 running", "2 unpushed") or null. */
  badge: string | null
  /** The repository short name ("widgets") for the sub-line, or null. */
  repoShort: string | null
  features: number
  allBad: boolean
  /** The last-activity date label for the sub-line, or null. */
  date: string | null
  /** The worst latest result, read by a screen reader after the name. */
  worst: string
}

type Props = {
  rows: readonly RailRow[]
  projectCount: number
  /** The Triage badge: how many wait on the operator and how many are paused, across the registry. */
  triage: { waits: number; paused: number }
  current: { kind: 'projects' | 'triage' | 'project' | 'workflow'; projectId?: string }
  onNavigate: (pathname: string) => void
}

function triageBadge({ waits, paused }: { waits: number; paused: number }): string {
  const parts = [waits > 0 ? `${waits} waits on you` : '', paused > 0 ? `${paused} paused` : ''].filter(Boolean)
  return parts.length ? parts.join(' · ') : 'nothing waits'
}

export function Rail({ rows, projectCount, triage, current, onNavigate }: Props) {
  const needs = triage.waits + triage.paused
  const home = (
    <>
      <AppLink href={projectsPathname()} onNavigate={onNavigate} className="dispatch-rail-home" current={current.kind === 'projects'} data-testid="rail-all-projects">
        <span className="dispatch-rail-home-l">All projects</span><span className="dispatch-rail-home-n">{projectCount}</span>
      </AppLink>
      <AppLink href={triagePathname()} onNavigate={onNavigate} className="dispatch-rail-home" current={current.kind === 'triage'} data-testid="rail-triage">
        <span className="dispatch-rail-home-l">Triage</span><span className={`dispatch-rail-home-n ${needs ? 'tone-warn' : ''}`}>{triageBadge(triage)}</span>
      </AppLink>
    </>
  )
  return (
    <>
      <aside className="dispatch-rail" aria-label="Projects" data-testid="dispatch-rail">
        {home}
        <h2 className="dispatch-rail-h" id="dispatch-rail-title">Projects <span>{projectCount}</span></h2>
        <ul className="dispatch-rail-list" data-testid="dispatch-rail-list">
          {rows.map(row => {
            const sub = [row.repoShort, row.allBad ? 'cannot be read' : `${row.features} ${row.features === 1 ? 'feature' : 'features'}`, row.date].filter(Boolean).join(' · ')
            return (
              <li key={row.projectId}>
                <AppLink href={projectPathname(row.projectId)} onNavigate={onNavigate} className={`dispatch-rail-row tone-${row.tone}`}
                  current={current.kind !== 'projects' && current.kind !== 'triage' && current.projectId === row.projectId} data-project-id={row.projectId}>
                  <StateGlyph tone={row.tone} live={row.tone === 'run'} />
                  <span className="dispatch-rail-m">
                    <span className="dispatch-rail-top">
                      <span className="dispatch-rail-name">{row.name}</span>
                      {row.badge && <span className="dispatch-rail-badge">{row.badge}</span>}
                    </span>
                    <span className="dispatch-rail-sub">{sub}</span>
                  </span>
                  <span className="visually-hidden"> · {row.badge ?? `worst latest result: ${TONE_LABEL[row.tone].toLowerCase()}`}</span>
                </AppLink>
              </li>
            )
          })}
        </ul>
        <p className="dispatch-rail-foot">Read-only. Runs are started, answered and approved in the workflow CLI; the pages show the commands to copy.</p>
      </aside>
      <nav className="dispatch-chips" aria-label="Projects" data-testid="dispatch-chips">
        <AppLink href={projectsPathname()} onNavigate={onNavigate} className="dispatch-chip" current={current.kind === 'projects'}>All projects</AppLink>
        <AppLink href={triagePathname()} onNavigate={onNavigate} className="dispatch-chip" current={current.kind === 'triage'}>Triage · {needs}</AppLink>
        {rows.map(row => (
          <AppLink key={row.projectId} href={projectPathname(row.projectId)} onNavigate={onNavigate} className={`dispatch-chip tone-${row.tone}`}
            current={current.kind !== 'projects' && current.kind !== 'triage' && current.projectId === row.projectId} data-project-id={row.projectId}>
            <StateGlyph tone={row.tone} />{row.name}
          </AppLink>
        ))}
      </nav>
    </>
  )
}
