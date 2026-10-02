/**
 * Shared primitives of the Projects viewer revamp (docs/PRD_VIEWER_REVAMP.md section 4). Styled by `theme.css`
 * through tone classes from `tone.ts`; they carry no data logic. Test ids stay on the elements that carry them
 * today, so callers pass `data-testid` through `rest`.
 */
import type { ReactNode, ButtonHTMLAttributes, HTMLAttributes } from 'react'
import { severityClass, severityTone, toneClass, type Tone } from '../tone'

type DivProps = HTMLAttributes<HTMLDivElement>

export function Chip({ tone = 'idle', plain = false, live = false, className = '', children, ...rest }: { tone?: Tone; plain?: boolean; live?: boolean; children: ReactNode } & HTMLAttributes<HTMLSpanElement>) {
  const classes = ['ui-chip', toneClass(tone), plain ? 'plain' : '', live ? 'live' : '', className].filter(Boolean).join(' ')
  return <span className={classes} {...rest}>{children}</span>
}

export function SeverityChip({ severity, className = '', ...rest }: { severity: string } & HTMLAttributes<HTMLSpanElement>) {
  const classes = ['ui-sev', severityClass(severityTone(severity)), className].filter(Boolean).join(' ')
  return <span className={classes} {...rest}>{severity}</span>
}

export function Card({ tone = 'idle', className = '', children, ...rest }: { tone?: Tone; children: ReactNode } & DivProps) {
  const classes = ['ui-card', toneClass(tone), className].filter(Boolean).join(' ')
  return <article className={classes} {...rest}>{children}</article>
}

/** A page section with one header: its title, a one-line sub-header (counts, an empty state) and tools on the right. `headingId` names the section by its title. */
export function Section({ title, sub, tools, headingId, className = '', children, ...rest }: { title: ReactNode; sub?: ReactNode; tools?: ReactNode; headingId?: string; children?: ReactNode } & HTMLAttributes<HTMLElement>) {
  const classes = ['ui-section', className].filter(Boolean).join(' ')
  return (
    <section className={classes} aria-labelledby={headingId} {...rest}>
      <header className="ui-section-header">
        <h2 id={headingId}>{title}</h2>
        {sub ? <span className="ui-sub">{sub}</span> : null}
        {tools ? <div className="ui-tools">{tools}</div> : null}
      </header>
      {children}
    </section>
  )
}

export type Figure = { value: ReactNode; label: ReactNode; tone?: Tone; testId?: string }

export function Figures({ items, className = '', ...rest }: { items: readonly Figure[] } & DivProps) {
  const classes = ['ui-figures', className].filter(Boolean).join(' ')
  return (
    <div className={classes} {...rest}>
      {items.map((item, index) => (
        <div key={index} className={['ui-figure', item.tone ? toneClass(item.tone) : ''].filter(Boolean).join(' ')} data-testid={item.testId}>
          <span className="ui-figure-value">{item.value}</span>
          <span className="ui-figure-label">{item.label}</span>
        </div>
      ))}
    </div>
  )
}

export type Filter = { id: string; label: ReactNode; count?: number }

export function FilterRow({ filters, selected, onSelect, className = '', ...rest }: { filters: readonly Filter[]; selected: string; onSelect: (id: string) => void } & Omit<DivProps, 'onSelect'>) {
  const classes = ['ui-filters', className].filter(Boolean).join(' ')
  return (
    <div className={classes} role="group" {...rest}>
      {filters.map((filter) => (
        <FilterButton key={filter.id} pressed={filter.id === selected} onClick={() => onSelect(filter.id)} data-filter={filter.id}>
          {filter.label}
          {filter.count !== undefined ? ` ${filter.count}` : ''}
        </FilterButton>
      ))}
    </div>
  )
}

/** Several filters pressed at once (a reviewer, a lane and "Open only" together); each button toggles independently. */
export function FilterToggles({ filters, selected, onToggle, className = '', ...rest }: { filters: readonly Filter[]; selected: ReadonlySet<string>; onToggle: (id: string, pressed: boolean) => void } & Omit<DivProps, 'onToggle'>) {
  const classes = ['ui-filters', className].filter(Boolean).join(' ')
  return (
    <div className={classes} role="group" {...rest}>
      {filters.map((filter) => {
        const pressed = selected.has(filter.id)
        return (
          <FilterButton key={filter.id} pressed={pressed} onClick={() => onToggle(filter.id, !pressed)} data-filter={filter.id}>
            {filter.label}
            {filter.count !== undefined ? ` ${filter.count}` : ''}
          </FilterButton>
        )
      })}
    </div>
  )
}

export function FilterButton({ pressed, children, ...rest }: { pressed: boolean; children: ReactNode } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type="button" aria-pressed={pressed} {...rest}>{children}</button>
}
