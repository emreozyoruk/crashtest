import { z } from 'zod'
import type { Runtime } from '../runtime/types'
import { loadSdk } from './runAgent'

// MCP tools that let the agent operate the app under test through a Runtime (local or VDS).
// Tool names surface to the agent as mcp__app__<name>.

export const APP_TOOLS = ['shell', 'start_background', 'read_log', 'expose_port', 'http_get'].map(
  (t) => `mcp__app__${t}`
)

// Our tools are few and central to each phase, so load them up front instead of behind tool search.
const LOAD = { alwaysLoad: true }

const text = (t: string): { content: { type: 'text'; text: string }[] } => ({
  content: [{ type: 'text', text: t }]
})

export async function appToolsServer(runtime: Runtime): Promise<Record<string, unknown>> {
  const { createSdkMcpServer, tool } = await loadSdk()
  const def: typeof tool = (name, description, schema, handler) =>
    tool(name, description, schema, handler, LOAD)
  return {
    app: createSdkMcpServer({
      name: 'app',
      instructions: `Commands run on ${runtime.label} inside the project folder ${runtime.appDir}.`,
      tools: [
        def(
          'shell',
          'Run a short shell command in the project folder and return its output. Times out after 3 minutes; never use it for servers.',
          { command: z.string() },
          async ({ command }) => {
            const res = await runtime.run(command)
            return text(`exit ${res.code}\n${res.output}`)
          }
        ),
        def(
          'start_background',
          'Start a long-running process (dev server, API, worker). Output goes to a named log you can read with read_log.',
          { name: z.string().describe('Short name, e.g. "api" or "web"'), command: z.string() },
          async ({ name, command }) => {
            const proc = await runtime.startBackground(name, command)
            return text(`started ${proc.name}; log: ${proc.logFile}`)
          }
        ),
        def(
          'read_log',
          'Read the last lines of a background process log.',
          { name: z.string(), lines: z.number().optional() },
          async ({ name, lines }) => text(await runtime.readLog(name, lines))
        ),
        def(
          'expose_port',
          "Get the URL that the test browser on the user's Mac must use for a port the app listens on.",
          { port: z.number() },
          async ({ port }) => text(await runtime.exposePort(port))
        ),
        def(
          'http_get',
          "Fetch a URL from the user's Mac (use URLs returned by expose_port). Returns status and the start of the body.",
          { url: z.string() },
          async ({ url }) => {
            try {
              const res = await fetch(url, { signal: AbortSignal.timeout(10_000) })
              return text(`HTTP ${res.status}\n${(await res.text()).slice(0, 1500)}`)
            } catch (err) {
              return text(`request failed: ${(err as Error).message}`)
            }
          }
        )
      ]
    })
  }
}
