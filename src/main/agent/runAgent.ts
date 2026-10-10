import { relative } from 'path'
import { wrapClaudeAgentSDK } from 'neatlogs'
import { getSecret } from '../secrets'
import { postMessage } from '../events'
import { AGENT_MODEL } from './models'

// Thin wrapper over the Claude Agent SDK: isolated settings, a phase-specific tool allowlist,
// structured JSON output, and live tool activity streamed into the project chat.

type SDK = typeof import('@anthropic-ai/claude-agent-sdk')
let sdk: SDK | undefined

export async function loadSdk(): Promise<SDK> {
  if (!sdk) sdk = wrapClaudeAgentSDK(await import('@anthropic-ai/claude-agent-sdk'))
  return sdk
}

export interface AgentRunOptions {
  projectId: string
  cwd: string
  prompt: string
  systemPrompt: string
  allowedTools: string[]
  schema?: Record<string, unknown>
  maxTurns?: number
  mcpServers?: Record<string, unknown>
  signal?: AbortSignal
}

export interface AgentRunResult<T> {
  output: T
  text: string
  costUsd: number
  turns: number
}

export class MissingKeyError extends Error {
  constructor() {
    super('Add your Anthropic API key in Settings to let the agent run.')
  }
}

export function anthropicKey(): string {
  const key = getSecret('anthropicKey')
  if (!key) throw new MissingKeyError()
  return key
}

// SDK-internal tools that mean nothing to the user.
const HIDDEN_TOOLS = new Set(['ToolSearch', 'StructuredOutput', 'TodoWrite'])

function describeTool(name: string, input: Record<string, unknown>, cwd: string): string {
  const path = (input.file_path ?? input.path ?? input.pattern) as string | undefined
  const shown = path && path.startsWith('/') ? relative(cwd, path) || '.' : path
  switch (name) {
    case 'Read':
      return `Reading ${shown}`
    case 'Grep':
      return `Searching for "${input.pattern}"`
    case 'Glob':
      return `Listing ${shown}`
    case 'Bash':
      return `Running \`${String(input.command).slice(0, 120)}\``
    case 'mcp__app__shell':
      return `Running \`${String(input.command).slice(0, 120)}\``
    case 'mcp__app__start_background':
      return `Starting ${input.name}: \`${String(input.command).slice(0, 100)}\``
    case 'mcp__app__read_log':
      return `Reading the ${input.name} log`
    case 'mcp__app__expose_port':
      return `Opening port ${input.port}`
    case 'mcp__app__http_get':
      return `Checking ${input.url}`
    case 'mcp__graph__search':
      return `Graph search: "${input.query}"`
    case 'mcp__graph__definition':
    case 'mcp__graph__neighbors':
    case 'mcp__graph__impact':
      return `Graph ${name.replace('mcp__graph__', '')}: ${input.symbol}`
    default:
      return name.startsWith('mcp__playwright__') ? `Browser: ${name.replace('mcp__playwright__browser_', '').replace(/_/g, ' ')}` : name
  }
}

export async function runAgent<T = string>(opts: AgentRunOptions): Promise<AgentRunResult<T>> {
  const { query } = await loadSdk()
  const abortController = new AbortController()
  opts.signal?.addEventListener('abort', () => abortController.abort())

  const stream = query({
    prompt: opts.prompt,
    options: {
      model: AGENT_MODEL,
      cwd: opts.cwd,
      systemPrompt: opts.systemPrompt,
      // Only the built-in tools this phase needs are even offered to the model; MCP tools come from mcpServers.
      tools: opts.allowedTools.filter((t) => !t.startsWith('mcp__')),
      allowedTools: opts.allowedTools,
      // Anything not explicitly allowed is denied instead of prompting.
      permissionMode: 'dontAsk',
      settingSources: [],
      maxTurns: opts.maxTurns ?? 60,
      executable: 'node',
      abortController,
      env: { ...process.env, ANTHROPIC_API_KEY: anthropicKey() } as Record<string, string>,
      ...(opts.mcpServers ? { mcpServers: opts.mcpServers as never } : {}),
      ...(opts.schema ? { outputFormat: { type: 'json_schema', schema: opts.schema } } : {})
    }
  })

  for await (const message of stream) {
    if (message.type === 'assistant') {
      for (const block of message.message.content) {
        if (block.type === 'tool_use' && !HIDDEN_TOOLS.has(block.name)) {
          postMessage(opts.projectId, 'activity', describeTool(block.name, block.input as Record<string, unknown>, opts.cwd))
        }
      }
    }
    if (message.type === 'result') {
      if (message.subtype !== 'success') throw new Error(`Agent stopped: ${message.subtype}`)
      return {
        output: (opts.schema ? message.structured_output : message.result) as T,
        text: message.result,
        costUsd: message.total_cost_usd ?? 0,
        turns: message.num_turns
      }
    }
  }
  throw new Error('Agent ended without a result')
}
