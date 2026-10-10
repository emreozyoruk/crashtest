import { app } from 'electron'
import { join } from 'path'
import type { Finding, Inventory, Scenario } from '../../shared/types'
import type { Runtime } from '../runtime/types'
import { runAgent } from './runAgent'
import { APP_TOOLS, appToolsServer } from './runtimeTools'
import { GRAPH_TOOLS, graphServer } from './graphTools'

export interface SweepVerdict {
  status: 'passed' | 'broken' | 'skipped'
  observed: string
  finding?: Finding
}

const SYSTEM = `You are Crashtest's scenario runner. You run ONE user scenario against a running copy of an app,
the way a real user would, and decide honestly whether it held.

Tools: the Playwright browser tools drive a real browser; the app tools (http_get, read_log, shell) let you call
the API, read server logs, and seed test data. The source code is in your working directory (Read, Grep, Glob).

Rules:
- Set up the starting state the scenario names (create test users and data through the UI or API). Never use real
  people's data.
- Do the steps in the real app. Take a screenshot at the decisive moment and LOOK at it. Read the browser console
  and server logs. A 200 response is not proof; what the user sees is.
- "passed" means you saw it work. If the app behaves differently from the expected result, it is "broken".
  If a step needs something you do not have (a real third-party reply, a paid plan, a device), it is "skipped" —
  say exactly why. Never call a skipped scenario passed.
- If broken: find the cause in the source code (cite file:line) — the graph tools find handlers, callers and
  blast radius fastest — and write a minimal suggested fix as a unified diff.
  Do not edit any files.
- Keep each run short and focused on this one scenario.`

const SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['passed', 'broken', 'skipped'] },
    observed: { type: 'string', description: 'What actually happened, in two or three sentences' },
    finding: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'One line bug title' },
        expected: { type: 'string' },
        actual: { type: 'string' },
        rootCause: { type: 'string', description: 'Why, citing file:line' },
        suggestedFix: { type: 'string', description: 'Unified diff' },
        screenshot: { type: 'string', description: 'Path of the screenshot that shows it' }
      },
      required: ['summary', 'expected', 'actual', 'rootCause', 'suggestedFix']
    }
  },
  required: ['status', 'observed']
}

function playwrightServer(outputDir: string): Record<string, unknown> {
  const cli = join(app.getAppPath(), 'node_modules', '@playwright', 'mcp', 'cli.js')
  return {
    playwright: {
      type: 'stdio',
      command: 'node',
      args: [cli, '--headless', '--isolated', '--viewport-size', '1280,800', '--output-dir', outputDir]
    }
  }
}

export async function runScenario(opts: {
  projectId: string
  scenario: Scenario
  runtime: Runtime
  localWorkdir: string
  baseUrl: string
  apiUrl: string
  inventory?: Inventory
  signal?: AbortSignal
}): Promise<SweepVerdict> {
  const s = opts.scenario
  const outputDir = join(opts.localWorkdir, '.crashtest', 'shots', s.id)
  const graph = await graphServer(opts.localWorkdir)
  const res = await runAgent<SweepVerdict>({
    projectId: opts.projectId,
    cwd: opts.localWorkdir,
    systemPrompt: SYSTEM,
    prompt:
      `App: ${opts.inventory?.productName ?? ''} — ${opts.inventory?.summary ?? ''}\n` +
      `Open the app at ${opts.baseUrl}${opts.apiUrl && opts.apiUrl !== opts.baseUrl ? ` (API at ${opts.apiUrl})` : ''}.\n\n` +
      `Scenario ${s.id} [${s.priority}] — ${s.title}\nWho: ${s.who}\nStarting state: ${s.startingState}\n` +
      `Steps:\n${s.steps.map((x, i) => `${i + 1}. ${x}`).join('\n')}\nExpected: ${s.expected}\n\n` +
      `Save screenshots into ${outputDir}. Run it now and report the verdict.`,
    allowedTools: ['Read', 'Grep', 'Glob', 'mcp__playwright', ...APP_TOOLS, ...(Object.keys(graph).length ? GRAPH_TOOLS : [])],
    mcpServers: { ...playwrightServer(outputDir), ...(await appToolsServer(opts.runtime)), ...graph },
    schema: SCHEMA,
    maxTurns: 40,
    signal: opts.signal
  })
  return res.output
}
