// Types shared by the main process (agent) and the renderer (UI).

export type Priority = 'P1' | 'P2' | 'P3'
export type ScenarioStatus = 'not_run' | 'running' | 'passed' | 'broken' | 'skipped'
export type RunTarget = 'local' | 'vds'
export type ProjectPhase =
  | 'cloning'
  | 'choosing_product'
  | 'inventory'
  | 'scenarios'
  | 'ready'
  | 'bootstrapping'
  | 'sweeping'
  | 'done'
  | 'failed'

export type SurfaceKind =
  | 'screen'
  | 'action'
  | 'operation'
  | 'job'
  | 'integration'
  | 'role'
  | 'entity'
  | 'public'
  | 'client'
  | 'limit'
  | 'ai'

export interface Surface {
  id: string
  kind: SurfaceKind
  name: string
  location: string
  details: string
  journey: string
}

export interface Inventory {
  productName: string
  summary: string
  appType: string
  stack: string[]
  journeys: string[]
  surfaces: Surface[]
  runHints: { howToRun: string; ports: number[]; envVars: string[] }
}

export interface Finding {
  summary: string
  expected: string
  actual: string
  rootCause?: string
  suggestedFix?: string
  screenshot?: string
}

export interface Scenario {
  id: string
  journey: string
  title: string
  who: string
  startingState: string
  steps: string[]
  expected: string
  priority: Priority
  dimension: string
  surfaceIds: string[]
  runnable: boolean
  status: ScenarioStatus
  notes?: string
  finding?: Finding
}

export interface ChatAction {
  id: string
  label: string
}

export interface ChatMessage {
  id: string
  role: 'user' | 'agent' | 'activity'
  text: string
  createdAt: number
  actions?: ChatAction[]
  // Set once the user picked one of the actions, so the buttons render as used.
  chosenActionId?: string
}

export interface Project {
  id: string
  repoUrl: string
  name: string
  workdir: string
  productPath?: string
  phase: ProjectPhase
  createdAt: number
  inventory?: Inventory
  // How to set the app up, from the user (services to start, flags, test accounts).
  setupNotes?: string
  scenarios: Scenario[]
  messages: ChatMessage[]
}

export interface Settings {
  defaultRunTarget: RunTarget | 'ask'
  ssh: { host: string; port: number; username: string }
}

export interface SecretStatus {
  anthropicKey: boolean
  githubToken: boolean
  sshPassword: boolean
  sshPrivateKey: boolean
}

export type SecretName = keyof SecretStatus

export type AppEvent =
  | { type: 'project'; project: Project }
  | { type: 'message'; projectId: string; message: ChatMessage }
