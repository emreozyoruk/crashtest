import { contextBridge, ipcRenderer } from 'electron'
import type { AppEvent, Project, SecretName, SecretStatus, Settings } from '../shared/types'

const api = {
  listProjects: (): Promise<Project[]> => ipcRenderer.invoke('projects:list'),
  deleteProject: (id: string): Promise<void> => ipcRenderer.invoke('projects:delete', id),
  openFolder: (id: string): Promise<void> => ipcRenderer.invoke('projects:open-folder', id),
  send: (projectId: string | null, text: string): Promise<{ projectId?: string; error?: string }> =>
    ipcRenderer.invoke('chat:send', projectId, text),
  chooseAction: (projectId: string, messageId: string, actionId: string): Promise<boolean> =>
    ipcRenderer.invoke('chat:action', projectId, messageId, actionId),
  startRun: (projectId: string, scenarioIds: string[]): Promise<void> => ipcRenderer.invoke('run:start', projectId, scenarioIds),
  imageData: (projectId: string, path: string): Promise<string | null> => ipcRenderer.invoke('files:image', projectId, path),
  stopRun: (projectId: string): Promise<void> => ipcRenderer.invoke('run:stop', projectId),
  getSettings: (): Promise<{ settings: Settings; secrets: SecretStatus }> => ipcRenderer.invoke('settings:get'),
  saveSettings: (settings: Settings): Promise<void> => ipcRenderer.invoke('settings:save', settings),
  setSecret: (name: SecretName, value: string): Promise<SecretStatus> => ipcRenderer.invoke('secrets:set', name, value),
  testVds: (): Promise<string | null> => ipcRenderer.invoke('vds:test'),
  onEvent: (fn: (event: AppEvent) => void): (() => void) => {
    const listener = (_: unknown, event: AppEvent): void => fn(event)
    ipcRenderer.on('app:event', listener)
    return () => ipcRenderer.removeListener('app:event', listener)
  }
}

export type Api = typeof api

contextBridge.exposeInMainWorld('api', api)
