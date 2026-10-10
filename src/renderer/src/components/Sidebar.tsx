import type { Project } from '../../../shared/types'
import type { View } from '../App'
import { isWorking } from '../working'
import Marker from './Marker'

const PHASE_LABEL: Record<Project['phase'], string> = {
  cloning: 'Cloning',
  choosing_product: 'Needs your choice',
  inventory: 'Mapping the code',
  scenarios: 'Writing scenarios',
  ready: 'Ready to run',
  bootstrapping: 'Starting the app',
  sweeping: 'Running scenarios',
  done: 'Run finished',
  failed: 'Stopped'
}

export default function Sidebar(props: {
  projects: Project[]
  selectedId: string | null
  view: View
  onSelect: (id: string) => void
  onNew: () => void
  onSettings: () => void
  onDelete: (id: string) => void
}): React.JSX.Element {
  return (
    <nav className="sidebar" aria-label="Projects">
      <div className="brand">
        <Marker size={22} />
        Crashtest
      </div>
      <button
        className={`nav-button new-project ${props.selectedId === null && props.view !== 'settings' ? 'active' : ''}`}
        onClick={props.onNew}
      >
        + New project
      </button>
      {props.projects.map((p) => {
        const broken = p.scenarios.filter((s) => s.status === 'broken').length
        return (
          <button
            key={p.id}
            className={`nav-button ${p.id === props.selectedId && props.view !== 'settings' ? 'active' : ''}`}
            onClick={() => props.onSelect(p.id)}
            onContextMenu={(e) => {
              e.preventDefault()
              if (confirm(`Remove ${p.name} from Crashtest?`)) props.onDelete(p.id)
            }}
            title="Right-click to remove"
          >
            {isWorking(p) ? (
              <Marker size={12} spin />
            ) : (
              <span
                className={`status ${broken ? 'broken' : p.phase === 'done' ? 'passed' : 'not_run'}`}
              />
            )}
            <span className="name">
              {p.name}
              <span className="sub" style={{ display: 'block' }}>
                {broken ? `${broken} broken, ` : ''}
                {PHASE_LABEL[p.phase]}
              </span>
            </span>
          </button>
        )
      })}
      <div className="sidebar-spacer" />
      <button
        className={`nav-button ${props.view === 'settings' ? 'active' : ''}`}
        onClick={props.onSettings}
      >
        Settings
      </button>
    </nav>
  )
}
