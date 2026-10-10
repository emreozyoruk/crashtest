import { ipcMain, shell } from 'electron'
import type { SecretName, Settings } from '../shared/types'
import { deleteProject, getProject, getSettings, listProjects, saveSettings } from './store'
import { secretStatus, setSecret } from './secrets'
import { postMessage } from './events'
import { cancel, chooseAction, createProject, guard, isBusy } from './agent/orchestrator'
import { chat } from './agent/chat'
import { startRun } from './agent/run'

export function registerIpc(): void {
  ipcMain.handle('projects:list', () => listProjects())

  ipcMain.handle('projects:delete', (_e, id: string) => {
    cancel(id)
    deleteProject(id)
  })

  ipcMain.handle('projects:open-folder', (_e, id: string) => {
    const project = getProject(id)
    if (project) void shell.openPath(project.workdir)
  })

  // A message without a project starts a new one from the GitHub link it contains.
  ipcMain.handle('chat:send', async (_e, projectId: string | null, text: string) => {
    if (!projectId) {
      const project = createProject(text.trim())
      return project ? { projectId: project.id } : { error: 'Paste a GitHub repository link to get started.' }
    }
    const project = getProject(projectId)
    if (!project) return { error: 'Project not found' }
    postMessage(project.id, 'user', text)
    if (isBusy(project.id)) {
      // The agent is mid-task; still answer, but keep it to the chat assistant.
      void chat(project, text, startRun).catch((err) => postMessage(project.id, 'agent', (err as Error).message))
      return { projectId }
    }
    void guard(project, () => chat(project, text, startRun))
    return { projectId }
  })

  ipcMain.handle('chat:action', (_e, projectId: string, messageId: string, actionId: string) =>
    chooseAction(projectId, messageId, actionId)
  )

  ipcMain.handle('run:start', (_e, projectId: string, scenarioIds: string[]) => {
    const project = getProject(projectId)
    if (project) startRun(project, scenarioIds)
  })

  ipcMain.handle('run:stop', (_e, projectId: string) => cancel(projectId))

  ipcMain.handle('settings:get', () => ({ settings: getSettings(), secrets: secretStatus() }))
  ipcMain.handle('settings:save', (_e, next: Settings) => saveSettings(next))
  ipcMain.handle('secrets:set', (_e, name: SecretName, value: string) => {
    setSecret(name, value)
    return secretStatus()
  })
}
