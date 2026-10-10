import type { Inventory } from '../../shared/types'
import { runAgent, type AgentRunResult } from './runAgent'
import { GRAPH_TOOLS, graphServer } from './graphTools'

const SYSTEM = `You are Crashtest's inventory agent. Your job is Phase 1 of a scenario sweep: build a complete
inventory of what an application can do, read from its CODE, not its docs. Docs describe intent; code is what users get.

Collect every surface that exists, using these places to look:
- screen: routes and pages (router config, pages/, app/, views, navigation), plus tabs, sections, modals, dialogs
- action: every action a user can take (buttons, forms, menus, shortcuts, drag and drop)
- operation: backend operations (API routes, RPC, GraphQL resolvers, server actions)
- job: background work (cron, queues, workers, scheduled tasks, webhooks)
- integration: OAuth providers, API keys, third-party SDKs and the permission level each needs
- role: roles and permission checks (role enums, middleware, guards)
- entity: entity lifecycles (status/stage enums: every state and allowed transition)
- public: surfaces reachable without signing in (share links, tokens, embeds, emails)
- client: other clients over the same backend (mobile, desktop, CLI, public API, MCP)
- limit: quotas, rate limits, cooldowns, size caps, pagination, validation rules
- ai: agents, prompts, tools, approval gates

Rules:
- Be exhaustive. Prefer many precise surfaces over a few vague ones. Do not skip a corner because it is small.
- Every surface must point at the file that defines it ("location": "path/to/file.ts" or "file.ts:42").
- Group surfaces into user journeys, named the way a user would describe them ("Sign up and sign in",
  "Write an article"), and order the journeys in the order a real user meets them.
- If the graph tools are available (Entire Graph), use them first to find routes, handlers, models and callers;
  they return ranked code with file:line and cost far fewer tokens than reading files blindly.
- Work efficiently: list the tree first, then read routers, API route files, models and validation before components.
- In runHints, record how the app is started locally (commands, ports, required env vars), from package.json
  scripts, Dockerfiles, compose files, .env.example and READMEs.`

const SCHEMA = {
  type: 'object',
  properties: {
    productName: { type: 'string' },
    summary: { type: 'string', description: '2-3 sentences: what this product does and for whom' },
    appType: { type: 'string', description: 'web, api, web+api, mobile, desktop, cli, library or other' },
    stack: { type: 'array', items: { type: 'string' } },
    journeys: { type: 'array', items: { type: 'string' }, description: 'Ordered as a user meets them' },
    surfaces: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Short unique id, e.g. op-create-article' },
          kind: {
            type: 'string',
            enum: ['screen', 'action', 'operation', 'job', 'integration', 'role', 'entity', 'public', 'client', 'limit', 'ai']
          },
          name: { type: 'string' },
          location: { type: 'string' },
          details: { type: 'string', description: 'What it does, inputs, rules, states, who may use it' },
          journey: { type: 'string', description: 'One of journeys' }
        },
        required: ['id', 'kind', 'name', 'location', 'details', 'journey']
      }
    },
    runHints: {
      type: 'object',
      properties: {
        howToRun: { type: 'string' },
        ports: { type: 'array', items: { type: 'number' } },
        envVars: { type: 'array', items: { type: 'string' } }
      },
      required: ['howToRun', 'ports', 'envVars']
    }
  },
  required: ['productName', 'summary', 'appType', 'stack', 'journeys', 'surfaces', 'runHints']
}

export async function buildInventory(opts: {
  projectId: string
  workdir: string
  productPaths?: string[]
  signal?: AbortSignal
}): Promise<AgentRunResult<Inventory>> {
  const graph = await graphServer(opts.workdir)
  const scope = opts.productPaths?.length
    ? `Focus on these parts of the repository (the product the user chose): ${opts.productPaths.join(', ')}. ` +
      'Read shared packages they import when needed, but inventory only this product.'
    : 'Inventory the whole repository as one product.'
  return runAgent<Inventory>({
    projectId: opts.projectId,
    cwd: opts.workdir,
    systemPrompt: SYSTEM,
    prompt: `${scope}\n\nBuild the inventory now and return it in the required format.`,
    allowedTools: ['Read', 'Grep', 'Glob', ...(Object.keys(graph).length ? GRAPH_TOOLS : [])],
    mcpServers: graph,
    schema: SCHEMA,
    maxTurns: 80,
    signal: opts.signal
  })
}
