import { useEffect, useState } from 'react'
import type { Project } from '../../shared/types'
import Sidebar from './components/Sidebar'
import ChatView from './components/ChatView'
import ScenariosView from './components/ScenariosView'
import SettingsView from './components/SettingsView'

export type View = 'chat' | 'scenarios' | 'settings'

const BUSY_PHASES = new Set(['cloning', 'inventory', 'scenarios', 'bootstrapping', 'sweeping'])
export const isWorking = (p?: Project): boolean => Boolean(p && BUSY_PHASES.has(p.phase))

function App(): React.JSX.Element {
  const [projects, setProjects] = useState<Project[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [view, setView] = useState<View>('chat')

  useEffect(() => {
    void window.api.listProjects().then(setProjects)
    return window.api.onEvent((event) => {
      setProjects((prev) => {
        if (event.type === 'project') {
          const exists = prev.some((p) => p.id === event.project.id)
          return exists ? prev.map((p) => (p.id === event.project.id ? event.project : p)) : [event.project, ...prev]
        }
        return prev.map((p) =>
          p.id === event.projectId && !p.messages.some((m) => m.id === event.message.id)
            ? { ...p, messages: [...p.messages, event.message] }
            : p
        )
      })
    })
  }, [])

  const project = projects.find((p) => p.id === selectedId)

  const select = (id: string | null, next: View = 'chat'): void => {
    setSelectedId(id)
    setView(next)
  }

  const remove = async (id: string): Promise<void> => {
    await window.api.deleteProject(id)
    setProjects((prev) => prev.filter((p) => p.id !== id))
    if (selectedId === id) select(null)
  }

  return (
    <div className="app">
      <Sidebar
        projects={projects}
        selectedId={selectedId}
        view={view}
        onSelect={(id) => select(id)}
        onNew={() => select(null)}
        onSettings={() => setView('settings')}
        onDelete={remove}
      />
      <main className="main">
        {view === 'settings' ? (
          <SettingsView />
        ) : (
          <>
            {project && (
              <div className="topbar">
                <h1>
                  {project.name}
                  <span className="repo">{project.repoUrl}</span>
                </h1>
                <div className="tabs" role="tablist">
                  <button className={`tab ${view === 'chat' ? 'active' : ''}`} onClick={() => setView('chat')}>
                    Chat
                  </button>
                  <button
                    className={`tab ${view === 'scenarios' ? 'active' : ''}`}
                    onClick={() => setView('scenarios')}
                    disabled={!project.scenarios.length}
                  >
                    Scenarios<span className="count">{project.scenarios.length || ''}</span>
                  </button>
                </div>
              </div>
            )}
            {view === 'scenarios' && project ? (
              <ScenariosView project={project} />
            ) : (
              <ChatView project={project} onCreated={(id) => select(id)} />
            )}
          </>
        )}
      </main>
    </div>
  )
}

export default App
