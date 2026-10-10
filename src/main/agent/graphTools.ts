import { execFile } from 'child_process'
import { promisify } from 'util'
import { z } from 'zod'
import { loadSdk } from './runAgent'

// Entire Graph (https://entire.io) gives the agent a tree-sitter map of the repo under test:
// ranked search, definitions, callers/callees and blast radius, with file:line citations.
// It indexes any git repo locally, so it works on repos that do not use Entire themselves.

const exec = promisify(execFile)

export const GRAPH_TOOLS = ['search', 'definition', 'neighbors', 'impact'].map((t) => `mcp__graph__${t}`)

let available: boolean | undefined

export async function graphAvailable(): Promise<boolean> {
  if (available === undefined) {
    available = await exec('entire', ['graph', 'version'], { timeout: 10_000 }).then(
      () => true,
      () => false
    )
  }
  return available
}

async function graph(repo: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await exec('entire', ['graph', ...args, '--repo', repo], { timeout: 60_000, maxBuffer: 8 * 1024 * 1024 })
    return stdout.length > 12_000 ? `${stdout.slice(0, 12_000)}\n…(truncated)` : stdout
  } catch (err) {
    return `graph query failed: ${(err as Error).message.slice(0, 400)}`
  }
}

const text = (t: string): { content: { type: 'text'; text: string }[] } => ({ content: [{ type: 'text', text: t }] })

export async function graphServer(repo: string): Promise<Record<string, unknown>> {
  if (!(await graphAvailable())) return {}
  const { createSdkMcpServer, tool } = await loadSdk()
  return {
    graph: createSdkMcpServer({
      name: 'graph',
      instructions: 'Entire Graph over the repository under test. Prefer these over grep to find routes, handlers, models and callers.',
      tools: [
        tool('search', 'Ranked semantic + structural code search. Returns code with file:line.', { query: z.string() }, async ({ query }) =>
          text(await graph(repo, ['search', '--query', query, '--format', 'agent']))
        ),
        tool('definition', 'Where a symbol is defined.', { symbol: z.string() }, async ({ symbol }) => text(await graph(repo, ['def', symbol]))),
        tool(
          'neighbors',
          'Callers (direction "in") or callees (direction "out") of a symbol.',
          { symbol: z.string(), direction: z.enum(['in', 'out']) },
          async ({ symbol, direction }) => text(await graph(repo, ['neighbors', '--symbol', symbol, '--relation', 'CALLS', '--direction', direction]))
        ),
        tool('impact', 'Blast radius of a symbol: callers, type consumers and files that change with it.', { symbol: z.string() }, async ({ symbol }) =>
          text(await graph(repo, ['impact', '--symbol', symbol]))
        )
      ]
    })
  }
}
