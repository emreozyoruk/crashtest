import { useEffect, useState } from 'react'
import type { Project, Scenario } from '../../../shared/types'
import { StatusGlyph } from './ScenariosView'

function Diff({ text }: { text: string }): React.JSX.Element {
  return (
    <pre className="diff">
      {text.split('\n').map((line, i) => (
        <div key={i} className={line.startsWith('+') && !line.startsWith('+++') ? 'add' : line.startsWith('-') && !line.startsWith('---') ? 'del' : ''}>
          {line || ' '}
        </div>
      ))}
    </pre>
  )
}

export default function ScenarioDetail({ project, scenario: s, onClose }: { project: Project; scenario: Scenario; onClose: () => void }): React.JSX.Element {
  // Keyed by screenshot path so a stale image never shows while the next one loads.
  const shotPath = s.finding?.screenshot
  const [loaded, setLoaded] = useState<{ path: string; data: string | null } | null>(null)
  const shot = loaded && loaded.path === shotPath ? loaded.data : null

  useEffect(() => {
    if (shotPath) void window.api.imageData(project.id, shotPath).then((data) => setLoaded({ path: shotPath, data }))
  }, [project.id, shotPath])

  return (
    <aside className="detail" aria-label={`Scenario ${s.id}`}>
      <header>
        <StatusGlyph status={s.status} />
        <h3>
          {s.id} {s.title}
        </h3>
        <button className="close" onClick={onClose} aria-label="Close">
          ×
        </button>
      </header>
      <dl>
        <dt>Priority</dt>
        <dd className={`prio ${s.priority}`}>{s.priority}</dd>
        <dt>Journey</dt>
        <dd>{s.journey}</dd>
        <dt>Who</dt>
        <dd>{s.who}</dd>
        <dt>Starting state</dt>
        <dd>{s.startingState}</dd>
        <dt>Exercises</dt>
        <dd>{s.dimension}</dd>
        <dt>Steps</dt>
        <dd>
          <ol>
            {s.steps.map((step, i) => (
              <li key={i}>{step}</li>
            ))}
          </ol>
        </dd>
        <dt>Expected</dt>
        <dd>{s.expected}</dd>
      </dl>
      {s.notes && <p className="observed">{s.notes}</p>}
      {s.finding && (
        <div className="finding">
          <h4>{s.finding.summary}</h4>
          <p>
            <strong>Expected:</strong> {s.finding.expected}
          </p>
          <p>
            <strong>Actual:</strong> {s.finding.actual}
          </p>
          {s.finding.rootCause && (
            <p>
              <strong>Root cause:</strong> {s.finding.rootCause}
            </p>
          )}
          {s.finding.suggestedFix && <Diff text={s.finding.suggestedFix} />}
          {shot && <img className="shot" src={shot} alt={`Screenshot for ${s.id}`} />}
        </div>
      )}
    </aside>
  )
}
