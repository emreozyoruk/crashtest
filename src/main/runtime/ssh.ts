import { Client, type ConnectConfig } from 'ssh2'
import { createServer, type AddressInfo, type Server } from 'net'
import type { BackgroundProcess, Runtime, ShellResult } from './types'
import { tail } from './types'

// Runs the app under test on the user's server over SSH, and tunnels its ports back so the
// browser on this Mac can drive it.

export interface SshTarget {
  host: string
  port: number
  username: string
  password?: string
  privateKey?: string
}

// Network errors (a Wi-Fi switch, a sleeping Mac) are retried; a rejected key or password is not.
async function connect(target: SshTarget): Promise<Client> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await connectOnce(target)
    } catch (err) {
      if (attempt === 3 || (err as { level?: string }).level === 'client-authentication') throw err
      await new Promise((r) => setTimeout(r, attempt * 3_000))
    }
  }
}

function connectOnce(target: SshTarget): Promise<Client> {
  return new Promise((resolve, reject) => {
    const client = new Client()
    const config: ConnectConfig = {
      host: target.host,
      port: target.port || 22,
      username: target.username,
      readyTimeout: 15_000,
      // Notice a dead link within a minute instead of hanging on it.
      keepaliveInterval: 15_000,
      keepaliveCountMax: 4,
      ...(target.privateKey ? { privateKey: target.privateKey } : { password: target.password })
    }
    client
      .once('ready', () => resolve(client))
      .once('error', reject)
      .connect(config)
  })
}

// Single-quote for the remote shell. Double quotes would let the login shell expand $!, $PWD
// and $(...) before our bash ever runs, in the wrong directory.
const sq = (s: string): string => `'${s.replaceAll("'", "'\\''")}'`

function exec(client: Client, command: string, timeoutMs: number): Promise<ShellResult> {
  return new Promise((resolve) => {
    client.exec(`bash -lc ${sq(command)}`, (err, stream) => {
      if (err) return resolve({ code: -1, output: String(err.message) })
      let output = ''
      const timer = setTimeout(() => {
        stream.close()
        output += `\n[timed out after ${timeoutMs / 1000}s — use background for long-running servers]`
      }, timeoutMs)
      stream.on('data', (d: Buffer) => (output += d.toString()))
      stream.stderr.on('data', (d: Buffer) => (output += d.toString()))
      stream.on('close', (code: number | null) => {
        clearTimeout(timer)
        resolve({ code, output: tail(output) })
      })
    })
  })
}

// Used by Settings and before every VDS run: returns null when the server is reachable.
export async function testSsh(target: SshTarget): Promise<string | null> {
  if (!target.host || !target.username) return 'No server set. Add host and username in Settings.'
  if (!target.password && !target.privateKey)
    return 'No password or private key set for the server.'
  try {
    const client = await connect(target)
    const res = await exec(client, 'uname -sm && (command -v git || echo "git missing")', 15_000)
    client.end()
    return res.code === 0 ? null : `Connected, but a test command failed: ${res.output}`
  } catch (err) {
    return `Could not connect to ${target.username}@${target.host}:${target.port || 22} — ${(err as Error).message}`
  }
}

export async function createSshRuntime(
  target: SshTarget,
  appDir: string,
  env: Record<string, string>
): Promise<Runtime> {
  // Wi-Fi changes and sleep drop the link mid-run. Background processes are setsid'd on the
  // server and keep running, so reconnecting on the next call is all a run needs.
  let client = await connect(target)
  let closed = false
  const track = (c: Client): void => {
    c.on('close', () => (closed = true)).on('error', () => (closed = true))
  }
  track(client)
  let reconnecting: Promise<Client> | undefined
  const live = async (): Promise<Client> => {
    if (!closed) return client
    reconnecting ??= connect(target)
      .then((c) => {
        client = c
        closed = false
        track(c)
        return c
      })
      .finally(() => (reconnecting = undefined))
    return reconnecting
  }
  const sh = async (command: string, timeoutMs: number): Promise<ShellResult> => {
    try {
      return await exec(await live(), command, timeoutMs)
    } catch (err) {
      return { code: -1, output: `Lost the connection to the server: ${(err as Error).message}` }
    }
  }
  const procs: BackgroundProcess[] = []
  const tunnels: Server[] = []
  const exports = Object.entries({ ...env, CI: '1' })
    .map(([k, v]) => `export ${k}=${sq(v)}`)
    .join('; ')
  const inDir = (cmd: string): string => `mkdir -p ${appDir} && cd ${appDir} && ${exports}; ${cmd}`
  const killCommand = (name: string): string =>
    `cd ${appDir} && kill -- -$(cat .crashtest/${name}.pid) 2>/dev/null || kill $(cat .crashtest/${name}.pid) 2>/dev/null`

  return {
    kind: 'vds',
    label: `${target.username}@${target.host}`,
    appDir,
    run: (command, timeoutMs = 180_000) => sh(inDir(command), timeoutMs),
    async startBackground(name, command) {
      const logFile = `${appDir}/.crashtest/logs/${name}.log`
      await sh(
        inDir(
          `mkdir -p .crashtest/logs && (setsid nohup bash -lc ${sq(command)} >> ${logFile} 2>&1 & echo $! > .crashtest/${name}.pid)`
        ),
        20_000
      )
      const proc = { name, command, logFile }
      procs.push(proc)
      return proc
    },
    async stopBackground(name) {
      const i = procs.findIndex((p) => p.name === name)
      if (i === -1) return false
      await sh(killCommand(name), 10_000)
      procs.splice(i, 1)
      return true
    },
    async readLog(name, lines = 80) {
      return (await sh(`tail -n ${lines} ${appDir}/.crashtest/logs/${name}.log`, 15_000)).output
    },
    exposePort(port) {
      return new Promise((resolve, reject) => {
        const server = createServer((socket) => {
          live()
            .then((c) =>
              c.forwardOut('127.0.0.1', 0, '127.0.0.1', port, (err, stream) => {
                if (err) socket.destroy()
                else socket.pipe(stream).pipe(socket)
              })
            )
            .catch(() => socket.destroy())
        })
        server.once('error', reject).listen(0, '127.0.0.1', () => {
          tunnels.push(server)
          resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)
        })
      })
    },
    background: () => procs,
    async dispose() {
      for (const p of procs) {
        await sh(killCommand(p.name), 10_000)
      }
      procs.length = 0
      for (const t of tunnels) t.close()
      client.end()
    }
  }
}
