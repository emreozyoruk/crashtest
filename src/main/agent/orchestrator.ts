import { randomUUID } from 'crypto'
import { writeFileSync } from 'fs'
import { join } from 'path'
import { trace } from 'neatlogs'
import type { Project } from '../../shared/types'
import { getProject } from '../store'
import { postMessage, publishProject } from '../events'
import { cloneRepo, detectProducts, parseGithubUrl, workdirFor } from './intake'
import { groupProducts, type Product } from './products'
import { buildInventory } from './inventory'
import { generateScenarios, scenariosMarkdown } from './scenarios'
import { MissingKeyError } from './runAgent'

// Drives a project through intake → inventory → scenarios, and routes chat choices.

interface PendingChoice {
  messageId: string
  resolve: (actionId: string) => void
}

const pending = new Map<string, PendingChoice>()
const running = new Map<string, AbortController>()

export function isBusy(projectId: string): boolean {
  return running.has(projectId)
}

export function cancel(projectId: string): void {
  running.get(projectId)?.abort()
}

// Posts a message with buttons and waits until the user clicks one.
export function ask(projectId: string, text: string, actions: { id: string; label: string }[]): Promise<string> {
  const message = postMessage(projectId, 'agent', text, { actions })
  return new Promise((resolve) => pending.set(projectId, { messageId: message.id, resolve }))
}

export function chooseAction(projectId: string, messageId: string, actionId: string): boolean {
  const choice = pending.get(projectId)
  if (!choice || choice.messageId !== messageId) return false
  pending.delete(projectId)
  const project = getProject(projectId)
  const message = project?.messages.find((m) => m.id === messageId)
  if (project && message) {
    message.chosenActionId = actionId
    publishProject(project)
  }
  choice.resolve(actionId)
  return true
}

function update(project: Project, patch: Partial<Project>): Project {
  Object.assign(project, patch)
  publishProject(project)
  return project
}

export async function guard(project: Project, fn: (signal: AbortSignal) => Promise<void>): Promise<void> {
  const controller = new AbortController()
  running.set(project.id, controller)
  try {
    await fn(controller.signal)
  } catch (err) {
    if (controller.signal.aborted) {
      postMessage(project.id, 'agent', 'Stopped.')
    } else {
      const text = err instanceof MissingKeyError ? err.message : `Something went wrong: ${(err as Error).message}`
      postMessage(project.id, 'agent', text)
    }
    update(project, { phase: project.inventory ? 'ready' : 'failed' })
  } finally {
    running.delete(project.id)
  }
}

export function createProject(repoUrlText: string): Project | undefined {
  const ref = parseGithubUrl(repoUrlText)
  if (!ref) return undefined
  const project: Project = {
    id: randomUUID(),
    repoUrl: ref.url,
    name: `${ref.owner}/${ref.repo}`,
    workdir: workdirFor(ref),
    phase: 'cloning',
    createdAt: Date.now(),
    scenarios: [],
    messages: []
  }
  publishProject(project)
  postMessage(project.id, 'user', repoUrlText)
  void guard(project, (signal) => analyze(project, signal))
  return project
}

async function pickProduct(project: Project): Promise<string[] | undefined> {
  const dirs = detectProducts(project.workdir)
  if (dirs.length < 2) return undefined
  postMessage(project.id, 'activity', `Found ${dirs.length} packages — working out which are separate products`)
  const products: Product[] = await trace({ name: 'product-detection', kind: 'CHAIN', sessionId: project.id }, () =>
    groupProducts(project.workdir, dirs)
  )
  if (products.length < 2) return undefined
  update(project, { phase: 'choosing_product' })
  const actions = [
    ...products.map((p, i) => ({ id: String(i), label: p.name })),
    { id: 'all', label: 'All of them' }
  ]
  const list = products.map((p) => `• **${p.name}** — ${p.description}`).join('\n')
  const choice = await ask(project.id, `This repo holds ${products.length} products:\n${list}\n\nWhich one should I map?`, actions)
  if (choice === 'all') return products.flatMap((p) => p.paths)
  const chosen = products[Number(choice)]
  update(project, { productPath: chosen.name })
  return chosen.paths
}

async function analyze(project: Project, signal: AbortSignal): Promise<void> {
  postMessage(project.id, 'agent', `Cloning ${project.repoUrl}…`)
  await cloneRepo(parseGithubUrl(project.repoUrl)!)
  const productPaths = await pickProduct(project)

  update(project, { phase: 'inventory' })
  postMessage(project.id, 'agent', 'Reading the code to map everything this app can do. This takes a few minutes.')
  const inv = await trace({ name: 'repo-inventory', kind: 'WORKFLOW', sessionId: project.id }, () =>
    buildInventory({ projectId: project.id, workdir: project.workdir, productPaths, signal })
  )
  const inventory = inv.output
  update(project, { inventory, name: inventory.productName || project.name })
  const counts = inventory.surfaces.reduce<Record<string, number>>((acc, s) => ({ ...acc, [s.kind]: (acc[s.kind] ?? 0) + 1 }), {})
  postMessage(
    project.id,
    'agent',
    `**${inventory.productName}** — ${inventory.summary}\n\n` +
      `Mapped ${inventory.surfaces.length} surfaces: ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ')}.\n` +
      `Journeys: ${inventory.journeys.join(' → ')}`
  )

  update(project, { phase: 'scenarios' })
  postMessage(project.id, 'agent', 'Now writing every scenario a user could walk through…')
  const scenarios = await trace({ name: 'scenario-generation', kind: 'WORKFLOW', sessionId: project.id }, () =>
    generateScenarios(inventory, (p) =>
      postMessage(project.id, 'activity', `Scenarios ${p.done}/${p.total} · ${p.journey} · ${p.found} so far`)
    )
  )
  update(project, { scenarios, phase: 'ready' })
  writeFileSync(join(project.workdir, 'SCENARIOS.md'), scenariosMarkdown(project.name, inventory, scenarios))

  const by = (p: string): number => scenarios.filter((s) => s.priority === p).length
  postMessage(
    project.id,
    'agent',
    `Wrote **${scenarios.length} scenarios** across ${new Set(scenarios.map((s) => s.journey)).size} journeys ` +
      `(${by('P1')} P1 · ${by('P2')} P2 · ${by('P3')} P3). ` +
      `${scenarios.filter((s) => !s.runnable).length} need something I can't simulate and will be marked ⏭.\n\n` +
      'Open the **Scenarios** tab, pick the ones to run and press **Start**.'
  )
}
