import Anthropic from '@anthropic-ai/sdk'
import { wrapAnthropic, trace } from 'neatlogs'
import type { Project } from '../../shared/types'
import { getSettings, saveSettings } from '../store'
import { setProjectEnvVar, setSecret, getProjectEnv } from '../secrets'
import { postMessage } from '../events'
import { anthropicKey } from './runAgent'
import { AGENT_MODEL } from './models'

// Free-form chat about a project. The assistant can store .env values and VDS credentials
// (encrypted, never echoed back) and can start a run on behalf of the user.

export type StartRunFn = (project: Project, scenarioIds: string[]) => void

const TOOLS: Anthropic.Tool[] = [
  {
    name: 'save_env_var',
    description:
      'Store an environment variable the app under test needs (from the user). Values are encrypted.',
    input_schema: {
      type: 'object',
      properties: { key: { type: 'string' }, value: { type: 'string' } },
      required: ['key', 'value']
    }
  },
  {
    name: 'save_vds',
    description: "Store SSH details of the user's server (VDS) for running scenarios remotely.",
    input_schema: {
      type: 'object',
      properties: {
        host: { type: 'string' },
        port: { type: 'number' },
        username: { type: 'string' },
        password: { type: 'string', description: 'Only if the user gave one' }
      },
      required: ['host', 'username']
    }
  },
  {
    name: 'start_run',
    description:
      'Start running scenarios. Use "P1", "P2", "P3", "all", or explicit ids like ["S-004","S-010"].',
    input_schema: {
      type: 'object',
      properties: { selection: { type: 'array', items: { type: 'string' } } },
      required: ['selection']
    }
  }
]

function context(project: Project): string {
  const inv = project.inventory
  const lines = [`Project: ${project.name} (${project.repoUrl}), phase: ${project.phase}`]
  if (inv)
    lines.push(
      `Summary: ${inv.summary}`,
      `Journeys: ${inv.journeys.join(' → ')}`,
      `Run hints: ${inv.runHints.howToRun}`
    )
  const env = Object.keys(getProjectEnv(project.id))
  lines.push(`Stored env vars: ${env.length ? env.join(', ') : 'none'}`)
  lines.push(`VDS configured: ${getSettings().ssh.host ? 'yes' : 'no'}`)
  for (const s of project.scenarios.slice(0, 400)) {
    lines.push(
      `${s.id} [${s.priority}] [${s.status}] ${s.journey} — ${s.title}${s.finding ? ` — FINDING: ${s.finding.summary}` : ''}`
    )
  }
  return lines.join('\n')
}

function select(project: Project, selection: string[]): string[] {
  return project.scenarios
    .filter(
      (s) => selection.includes('all') || selection.includes(s.priority) || selection.includes(s.id)
    )
    .map((s) => s.id)
}

export async function chat(project: Project, text: string, startRun: StartRunFn): Promise<void> {
  const client = wrapAnthropic(new Anthropic({ apiKey: anthropicKey() }))
  const history: Anthropic.MessageParam[] = project.messages
    .filter((m) => m.role !== 'activity')
    .slice(-20)
    .map((m) => ({
      role: m.role === 'user' ? 'user' : 'assistant',
      content: m.text || '(buttons)'
    }))
  // The latest user message is already in history (posted by the caller).
  const messages: Anthropic.MessageParam[] = history.length
    ? history
    : [{ role: 'user', content: text }]
  if (messages[0].role !== 'user')
    messages.unshift({ role: 'user', content: '(conversation start)' })

  const system =
    'You are Crashtest, an agent that maps every user scenario of an app and runs them for real. ' +
    'Answer briefly and concretely about this project. Never repeat secrets back. ' +
    'When the user gives env values or server credentials, store them with the tools. ' +
    `\n\n${context(project)}`

  await trace({ name: 'project-chat', kind: 'AGENT', sessionId: project.id }, async () => {
    for (let turn = 0; turn < 5; turn++) {
      const res = await client.messages.create({
        model: AGENT_MODEL,
        max_tokens: 1500,
        system,
        messages,
        tools: TOOLS
      })
      const reply = res.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim()
      if (reply) postMessage(project.id, 'agent', reply)
      const calls = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
      if (!calls.length) return
      messages.push({ role: 'assistant', content: res.content })
      const results: Anthropic.ToolResultBlockParam[] = calls.map((call) => {
        const input = call.input as Record<string, unknown>
        if (call.name === 'save_env_var') {
          setProjectEnvVar(project.id, String(input.key), String(input.value))
          postMessage(project.id, 'activity', `Saved ${input.key} (encrypted)`)
          return { type: 'tool_result', tool_use_id: call.id, content: 'saved' }
        }
        if (call.name === 'save_vds') {
          const s = getSettings()
          saveSettings({
            ...s,
            ssh: {
              host: String(input.host),
              port: Number(input.port ?? 22),
              username: String(input.username)
            }
          })
          if (input.password) setSecret('sshPassword', String(input.password))
          postMessage(project.id, 'activity', `Saved VDS ${input.username}@${input.host}`)
          return { type: 'tool_result', tool_use_id: call.id, content: 'saved' }
        }
        const ids = select(project, (input.selection as string[]) ?? [])
        if (ids.length) startRun(project, ids)
        return {
          type: 'tool_result',
          tool_use_id: call.id,
          content: ids.length ? `started ${ids.length} scenarios` : 'no matching scenarios'
        }
      })
      messages.push({ role: 'user', content: results })
    }
  })
}
