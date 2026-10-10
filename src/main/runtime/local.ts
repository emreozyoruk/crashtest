import { spawn } from 'child_process'
import { mkdirSync, openSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import type { BackgroundProcess, Runtime, ShellResult } from './types'
import { tail } from './types'

// Runs the app under test on this Mac, inside its cloned workdir.

export function createLocalRuntime(appDir: string, env: Record<string, string>): Runtime {
  const logDir = join(appDir, '.crashtest', 'logs')
  mkdirSync(logDir, { recursive: true })
  const procs: (BackgroundProcess & { pid: number })[] = []
  const shellEnv = { ...process.env, ...env, CI: '1', BROWSER: 'none' }

  const run = (command: string, timeoutMs = 180_000): Promise<ShellResult> =>
    new Promise((resolve) => {
      const child = spawn('/bin/zsh', ['-lc', command], { cwd: appDir, env: shellEnv })
      let output = ''
      const onData = (d: Buffer): void => {
        output += d.toString()
      }
      child.stdout.on('data', onData)
      child.stderr.on('data', onData)
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        output += `\n[timed out after ${timeoutMs / 1000}s — use background for long-running servers]`
      }, timeoutMs)
      child.on('close', (code) => {
        clearTimeout(timer)
        resolve({ code, output: tail(output) })
      })
    })

  return {
    kind: 'local',
    label: 'this Mac',
    appDir,
    run,
    async startBackground(name, command) {
      const logFile = join(logDir, `${name}.log`)
      const fd = openSync(logFile, 'a')
      // detached gives the process its own group so dispose() can stop its children too.
      const child = spawn('/bin/zsh', ['-lc', command], { cwd: appDir, env: shellEnv, detached: true, stdio: ['ignore', fd, fd] })
      child.unref()
      const proc = { name, command, logFile, pid: child.pid ?? -1 }
      procs.push(proc)
      return proc
    },
    async readLog(name, lines = 80) {
      const file = join(logDir, `${name}.log`)
      if (!existsSync(file)) return `(no log named ${name})`
      return readFileSync(file, 'utf8').split('\n').slice(-lines).join('\n')
    },
    async exposePort(port) {
      return `http://localhost:${port}`
    },
    background: () => procs,
    async dispose() {
      for (const p of procs) {
        try {
          process.kill(-p.pid, 'SIGTERM')
        } catch {
          /* already exited */
        }
      }
      procs.length = 0
    }
  }
}
