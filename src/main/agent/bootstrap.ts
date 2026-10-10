import type { Inventory } from '../../shared/types'
import type { Runtime } from '../runtime/types'
import { runAgent } from './runAgent'
import { APP_TOOLS, appToolsServer } from './runtimeTools'

export interface BootResult {
  ok: boolean
  baseUrl: string
  apiUrl: string
  missingEnv: string[]
  reason: string
  notes: string
  cleanup: string[]
}

const SYSTEM = `You are Crashtest's bootstrap agent. Get the application in the project folder running so its
scenarios can be tested in a browser. You operate it only through the app tools (shell, start_background,
read_log, expose_port, http_get).

How to work:
1. Read package.json / README / Dockerfile / compose / .env.example (use shell: cat, ls) to learn how it starts.
2. Install dependencies (npm ci or npm install, pnpm, yarn, pip, etc.).
3. Prefer zero-dependency local options: SQLite or in-memory databases over Postgres/MySQL when the code supports
   it, and dev-safe secrets (e.g. JWT secrets) you generate yourself. Write them into the app's .env file.
4. Ports may already be taken on this machine. Check with "lsof -iTCP:<port> -sTCP:LISTEN" and pick free ports;
   pass explicit ports and strict-port flags so servers fail loudly instead of drifting.
5. Start servers with start_background, never with shell. Then poll: read_log and http_get the exposed URL until
   the app answers. If a server crashes, read its log, fix the cause, and start it again. Keep going until it
   works or you hit a real blocker.
6. Only report missingEnv for values you truly cannot invent (third-party API keys, OAuth client secrets).
7. Do not modify application source code. Config files and .env are fine.
8. Everything you start must be stoppable by Crashtest. Run databases and services in the FOREGROUND through
   start_background (e.g. "postgres -D .crashtest/pg -p 5544", "redis-server --port 6390"), never as daemons
   (no pg_ctl start, brew services, docker run -d). Keep data directories inside .crashtest/ in the project folder.
   If you could not avoid starting something detached, put the exact commands that stop it in cleanup
   (e.g. "pg_ctl stop -D .crashtest/pg"). Never pkill/killall: processes from start_background are stopped for you.

Return baseUrl = the URL the browser should open (from expose_port) and apiUrl = the API base URL if separate.`

const SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    baseUrl: { type: 'string' },
    apiUrl: { type: 'string' },
    missingEnv: { type: 'array', items: { type: 'string' } },
    reason: { type: 'string', description: 'If not ok: what blocked you, in one or two sentences' },
    notes: {
      type: 'string',
      description: 'What you did to get it running (ports, DB choice, env written)'
    },
    cleanup: {
      type: 'array',
      items: { type: 'string' },
      description: 'Shell commands that stop anything started detached'
    }
  },
  required: ['ok', 'baseUrl', 'apiUrl', 'missingEnv', 'reason', 'notes', 'cleanup']
}

export async function bootApp(opts: {
  projectId: string
  runtime: Runtime
  localWorkdir: string
  inventory?: Inventory
  providedEnv: string[]
  signal?: AbortSignal
}): Promise<BootResult> {
  const hints = opts.inventory
    ? `Hints from reading the code: ${opts.inventory.runHints.howToRun}\nPorts seen: ${opts.inventory.runHints.ports.join(', ') || 'none'}\n` +
      `Env vars referenced: ${opts.inventory.runHints.envVars.join(', ') || 'none'}`
    : ''
  const res = await runAgent<BootResult>({
    projectId: opts.projectId,
    cwd: opts.localWorkdir,
    systemPrompt: SYSTEM,
    prompt:
      `The app runs on ${opts.runtime.label} in ${opts.runtime.appDir}.\n${hints}\n` +
      `Env vars the user already provided (already exported for every command): ${opts.providedEnv.join(', ') || 'none'}.\n` +
      'Get it running now.',
    allowedTools: APP_TOOLS,
    mcpServers: await appToolsServer(opts.runtime),
    schema: SCHEMA,
    maxTurns: 70,
    signal: opts.signal
  })
  return res.output
}
