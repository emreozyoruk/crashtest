import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import type { ChatMessage, Project, Settings } from '../shared/types'

// Small JSON-file persistence under the app's userData folder.

export const dataDir = (): string => app.getPath('userData')
export const workspacesDir = (): string => join(dataDir(), 'workspaces')

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(join(dataDir(), file), 'utf8')) as T
  } catch {
    return fallback
  }
}

function writeJson(file: string, value: unknown): void {
  const target = join(dataDir(), file)
  const tmp = `${target}.tmp`
  writeFileSync(tmp, JSON.stringify(value, null, 2))
  renameSync(tmp, target)
}

const DEFAULT_SETTINGS: Settings = {
  defaultRunTarget: 'ask',
  ssh: { host: '', port: 22, username: '' }
}

let projects: Project[] = []
let settings: Settings = DEFAULT_SETTINGS

export function loadStore(): void {
  mkdirSync(workspacesDir(), { recursive: true })
  projects = readJson<Project[]>('projects.json', [])
  settings = { ...DEFAULT_SETTINGS, ...readJson<Partial<Settings>>('settings.json', {}) }
  // A quit or crash mid-task leaves projects and scenarios marked as busy; nothing is running
  // after a restart, so put them back where the user can start again.
  const busy = new Set(['cloning', 'choosing_product', 'inventory', 'scenarios', 'bootstrapping', 'sweeping'])
  for (const p of projects) {
    if (busy.has(p.phase)) p.phase = p.scenarios.length ? 'ready' : 'failed'
    for (const s of p.scenarios) if (s.status === 'running') s.status = 'not_run'
  }
}

export const listProjects = (): Project[] => projects
export const getProject = (id: string): Project | undefined => projects.find((p) => p.id === id)

export function saveProject(project: Project): void {
  const i = projects.findIndex((p) => p.id === project.id)
  if (i === -1) projects.unshift(project)
  else projects[i] = project
  writeJson('projects.json', projects)
}

export function deleteProject(id: string): void {
  projects = projects.filter((p) => p.id !== id)
  writeJson('projects.json', projects)
}

export const getSettings = (): Settings => settings

export function saveSettings(next: Settings): void {
  settings = next
  writeJson('settings.json', settings)
}

export function newMessage(role: ChatMessage['role'], text: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return { id: randomUUID(), role, text, createdAt: Date.now(), ...extra }
}

export const ensureDir = (dir: string): void => {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}
