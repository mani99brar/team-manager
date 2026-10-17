import { headlineOf, noteOutcome, recordLine, shownRecord } from './model.ts'
import { useRunControls } from './store.ts'
import type { ControlScope } from './types.ts'

/** The dock's `Controls` row (docs/PRD_RUN_CONTROLS.md section 6): label, status and duration, the controller's first line, the log tail behind a disclosure. */
export function ControlsRow({ scope, clock }: { scope: ControlScope; clock: number }) {
  const state = useRunControls(scope)
  const record = state.mode === 'on' && state.paired ? shownRecord(state.data?.records ?? [], state.mine) : null
  if (record === null) return null
  const label = state.data?.controls.find(control => control.id === record.control)?.label ?? record.control
  // A note's outcome reads as its sentence (docs/PRD_RUN_TEAMS.md 7); every other record leads with the controller's line.
  const headline = noteOutcome(record)?.text ?? headlineOf(record)
  return (
    <div className="lv-sec ctl-row" data-testid="controls-row" data-status={record.status} data-control={record.control}>
      <p className="lv-h">Controls</p>
      <p className={`ctl-record is-${record.status}`} data-testid="control-record" role="status">{recordLine(record, label, clock)}</p>
      {headline !== null && <p className="ctl-headline" data-testid="control-headline">{headline}</p>}
      {record.output_tail.length > 0 && (
        <details className="ctl-log" data-testid="control-log">
          <summary>Log tail</summary>
          <pre>{record.output_tail.join('\n')}</pre>
        </details>
      )}
    </div>
  )
}

/** Run Details lists this run's control records, newest first. */
export function ControlsHistory({ scope }: { scope: ControlScope }) {
  const state = useRunControls(scope)
  // Newest first, whatever order the server sent.
  const records = state.mode === 'on' && state.paired ? [...(state.data?.records ?? [])].sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at)) : []
  if (records.length === 0) return null
  return (
    <div className="ctl-history" data-testid="controls-history">
      <h4 className="ctl-h">Control records</h4>
      <ul>
        {records.map(record => (
          <li key={record.record_id} data-testid="control-history-item" data-started-at={record.started_at}>
            <time dateTime={record.started_at}>{record.started_at.slice(11, 16)} UTC</time> · {state.data?.controls.find(control => control.id === record.control)?.label ?? record.control} · {record.status}
          </li>
        ))}
      </ul>
    </div>
  )
}
