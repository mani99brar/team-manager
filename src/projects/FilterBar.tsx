import type { KeyboardEvent } from 'react'
import { PHASES, type Phase } from './dispatch/phases.ts'
import type { ListSort } from './lists.ts'
import {
  DATE_CHOICES, DATE_FILTER_LABEL, SORT_CHOICES, STATUS_FILTER_LABEL, STATUS_FILTERS,
  type DateFilter, type RunFilterState, type ScopeKind, type StatusFilter,
} from './runFilter.ts'
import { FilterButton } from './ui/index.tsx'
export type { ListControl } from './dispatch/listState.ts'

type Props = {
  kind: ScopeKind
  state: RunFilterState
  counts: Readonly<Record<StatusFilter, number>>
  /** The scope line: what was searched (`scopeLine`). */
  scope: string
  /** Whether any control narrows the list, so "Clear filters" shows. */
  active: boolean
  /** A change of any control; `text` marks a keystroke in the search box, which the caller debounces. */
  onChange: (next: Partial<RunFilterState>, options?: { text?: boolean }) => void
  /** Enter in the search box: the pending search is written at once. */
  onCommit: () => void
  onClear: () => void
  /** A line beside the scope while older pages are read ("Reading older runs… (120 read)"). */
  reading?: string | null
}

/**
 * The filter bar every run list shares (Triage, the project page, the feature page): status toggles with their counts
 * under the other controls, the stopped-at phase, the date window, a search box and the sort, all combining, and the scope
 * line that says which runs were searched. It is not a form: Enter is handled on the search box itself. Every control is a
 * native button, select or input; it reads and requests nothing.
 */
export function FilterBar({ kind, state, counts, scope, active, onChange, onCommit, onClear, reading = null }: Props) {
  const id = (name: string) => `run-filter-${kind}-${name}`
  const toggle = (status: StatusFilter) => {
    const next = state.status.includes(status) ? state.status.filter(item => item !== status) : [...state.status, status]
    onChange({ status: STATUS_FILTERS.filter(item => next.includes(item)) })
  }
  const onKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') { event.preventDefault(); onCommit() }
  }
  return (
    <div className="run-filter" data-testid="run-filter" data-kind={kind} role="search" aria-label="Filter runs">
      <div className="run-filter-row">
        <label htmlFor={id('q')} className="visually-hidden">Search runs</label>
        <input id={id('q')} className="run-filter-search" type="search" value={state.q} placeholder="Search run id, feature or headline" autoComplete="off"
          onChange={event => onChange({ q: event.target.value }, { text: true })} onKeyDown={onKey} data-testid="run-filter-q" />
        <span className="run-filter-field">
          <label htmlFor={id('phase')}>Stopped at</label>
          <select id={id('phase')} value={state.phase ?? ''} data-testid="run-filter-phase"
            onChange={event => onChange({ phase: event.target.value === '' ? null : event.target.value as Phase })}>
            <option value="">Any step</option>
            {PHASES.map(phase => <option key={phase} value={phase}>{phase}</option>)}
          </select>
        </span>
        <span className="run-filter-field">
          <label htmlFor={id('date')}>Date</label>
          <select id={id('date')} value={state.date} data-testid="run-filter-date" onChange={event => onChange({ date: event.target.value as DateFilter })}>
            {DATE_CHOICES[kind].map(date => <option key={date} value={date}>{DATE_FILTER_LABEL[date]}</option>)}
          </select>
        </span>
        <span className="run-filter-field">
          <label htmlFor={id('sort')}>Sort</label>
          <select id={id('sort')} value={state.sort} data-testid="run-filter-sort" onChange={event => onChange({ sort: event.target.value as ListSort })}>
            {SORT_CHOICES[kind].map(choice => <option key={choice.id} value={choice.id}>{choice.label}</option>)}
          </select>
        </span>
      </div>
      <div className="ui-filters run-filter-status" role="group" aria-label="Status">
        {STATUS_FILTERS.map(status => (
          <FilterButton key={status} pressed={state.status.includes(status)} onClick={() => toggle(status)} data-filter={status}>
            {STATUS_FILTER_LABEL[status]} {counts[status]}
          </FilterButton>
        ))}
        {active && <button type="button" className="run-filter-clear" onClick={onClear} data-testid="run-filter-clear">Clear filters</button>}
        <span className="run-filter-scope" data-testid="run-filter-scope" aria-live="polite">
          {scope}{reading && <span className="run-filter-reading" data-testid="run-filter-reading"> · {reading}</span>}
        </span>
      </div>
    </div>
  )
}

/** What a list shows in place of its rows when the bar matches none of them. */
export function NoMatch({ onClear }: { onClear?: () => void }) {
  return (
    <p className="projects-muted lists-empty run-filter-none" data-testid="run-filter-none">
      No run matches.{onClear && <> <button type="button" className="run-filter-clear" onClick={onClear}>Clear filters</button></>}
    </p>
  )
}
