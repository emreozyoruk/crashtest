import { BrowserWindow } from 'electron'
import type { AppEvent, ChatMessage, Project } from '../shared/types'
import { getProject, newMessage, saveProject } from './store'

// Pushes state changes from the agent to every open window.

function send(event: AppEvent): void {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send('app:event', event)
}

export function publishProject(project: Project): void {
  saveProject(project)
  send({ type: 'project', project })
}

export function postMessage(
  projectId: string,
  role: ChatMessage['role'],
  text: string,
  extra: Partial<ChatMessage> = {}
): ChatMessage {
  const project = getProject(projectId)
  const message = newMessage(role, text, extra)
  if (!project) return message
  project.messages.push(message)
  saveProject(project)
  send({ type: 'message', projectId, message })
  return message
}
