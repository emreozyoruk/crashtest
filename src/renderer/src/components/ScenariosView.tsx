import { useMemo, useState } from 'react'
import type { Priority, Project, Scenario, ScenarioStatus } from '../../../shared/types'
import { isWorking } from '../working'
import Marker from './Marker'
import ScenarioDetail from './ScenarioDetail'

const STATUS_LABEL: Record<ScenarioStatus, string> = {
  not_run: 'Not run',
  running: 'Running',
  passed: 'Passed',
  broken: 'Broken',
  skipped: 'Skipped'
}

export function StatusGlyph({ status }: { status: ScenarioStatus }): React.JSX.Element {
  if (status === 'running') return <Marker size={12} spin />
  return (
    <span
      className={`status ${status}`}
      title={STATUS_LABEL[status]}
      aria-label={STATUS_LABEL[status]}
    />
  )
}

export default function ScenariosView({ project }: { project: Project }): React.JSX.Element {
  const [priorities, setPriorities] = useState<Set<Priority>>(new Set(['P1', 'P2', 'P3']))
  const [statusFilter, setStatusFilter] = useState<ScenarioStatus | 'all'>('all')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [openId, setOpenId] = useState<string | null>(null)
  const working = isWorking(project)

  const visible = useMemo(
    () =>
      project.scenarios.filter(
        (s) => priorities.has(s.priority) && (statusFilter === 'all' || s.status === statusFilter)
      ),
    [project.scenarios, priorities, statusFilter]
  )
  const journeys = [...new Set(visible.map((s) => s.journey))]
  const count = (st: ScenarioStatus): number =>
    project.scenarios.filter((s) => s.status === st).length
  const open = project.scenarios.find((s) => s.id === openId)

  const togglePriority = (p: Priority): void => {
    const next = new Set(priorities)
    if (next.has(p)) next.delete(p)
    else next.add(p)
    setPriorities(next)
  }
  const toggle = (s: Scenario): void => {
    const next = new Set(selected)
    if (next.has(s.id)) next.delete(s.id)
    else next.add(s.id)
    setSelected(next)
  }
  const allVisibleSelected = visible.length > 0 && visible.every((s) => selected.has(s.id))
  const runIds = selected.size ? [...selected] : visible.map((s) => s.id)

  return (
    <div className={`scenarios ${open ? 'with-detail' : ''}`}>
      <div className="scenario-list">
        <div className="toolbar">
          {(['P1', 'P2', 'P3'] as Priority[]).map((p) => (
            <button
              key={p}
              className={`chip ${priorities.has(p) ? 'on' : ''}`}
              onClick={() => togglePriority(p)}
              aria-pressed={priorities.has(p)}
            >
              {p} <span>{project.scenarios.filter((s) => s.priority === p).length}</span>
            </button>
          ))}
          <select
            className="chip"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as ScenarioStatus | 'all')}
            aria-label="Filter by status"
          >
            <option value="all">Any status</option>
            {Object.entries(STATUS_LABEL).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
          <div className="tally">
            <span>
              <StatusGlyph status="passed" /> {count('passed')}
            </span>
            <span>
              <StatusGlyph status="broken" /> {count('broken')}
            </span>
            <span>
              <StatusGlyph status="skipped" /> {count('skipped')}
            </span>
            <span>
              <StatusGlyph status="not_run" /> {count('not_run')}
            </span>
          </div>
          <div className="grow" />
          {working ? (
            <button className="btn" onClick={() => void window.api.stopRun(project.id)}>
              <Marker size={12} spin /> Stop run
            </button>
          ) : (
            <button
              className="btn primary"
              disabled={!runIds.length}
              onClick={() => void window.api.startRun(project.id, runIds)}
            >
              {selected.size ? `Start ${selected.size} selected` : `Start ${visible.length} shown`}
            </button>
          )}
        </div>
        <div className="table-wrap">
          <label className="select-all">
            <input
              type="checkbox"
              checked={allVisibleSelected}
              onChange={() =>
                setSelected(allVisibleSelected ? new Set() : new Set(visible.map((s) => s.id)))
              }
              aria-label="Select all shown"
            />
            <span>Select all</span>
          </label>
          {journeys.map((journey) => {
            const rows = visible.filter((s) => s.journey === journey)
            return (
              <section key={journey}>
                <h3 className="journey">
                  {journey}
                  <span className="n">{rows.length}</span>
                </h3>
                {rows.map((s) => (
                  <div
                    key={s.id}
                    className={`row ${openId === s.id ? 'selected' : ''}`}
                    onClick={() => setOpenId(s.id)}
                  >
                    <input
                      type="checkbox"
                      checked={selected.has(s.id)}
                      onClick={(e) => e.stopPropagation()}
                      onChange={() => toggle(s)}
                      aria-label={`Select ${s.id}`}
                    />
                    <span className="id">{s.id}</span>
                    <span className={`prio ${s.priority}`}>{s.priority}</span>
                    <span className="title">{s.title}</span>
                    <StatusGlyph status={s.status} />
                  </div>
                ))}
              </section>
            )
          })}
        </div>
      </div>
      {open && <ScenarioDetail project={project} scenario={open} onClose={() => setOpenId(null)} />}
    </div>
  )
}
