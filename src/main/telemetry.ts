import { app } from 'electron'
import { readFileSync } from 'fs'
import { join } from 'path'
import { init, flush, shutdown } from 'neatlogs'

// Crashtest traces its own agent runs to neatlogs so we can debug and improve the agent.
// The key belongs to the Crashtest developers, not to end users.

function readDotEnv(): Record<string, string> {
  try {
    const text = readFileSync(join(app.getAppPath(), '.env'), 'utf8')
    return Object.fromEntries(
      text
        .split('\n')
        .map((line) => line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/))
        .filter((m): m is RegExpMatchArray => m !== null)
        .map((m) => [m[1], m[2].replace(/^["']|["']$/g, '')])
    )
  } catch {
    return {}
  }
}

let enabled = false

export async function initTelemetry(): Promise<void> {
  const apiKey = process.env.NEATLOGS_API_KEY || readDotEnv().NEATLOGS_API_KEY
  if (!apiKey) return
  await init({
    apiKey,
    workflowName: 'crashtest',
    tags: [app.isPackaged ? 'packaged' : 'dev'],
    metadata: { appVersion: app.getVersion() }
  })
  enabled = true
}

export async function shutdownTelemetry(): Promise<void> {
  if (!enabled) return
  await flush()
  await shutdown()
}
