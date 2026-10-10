// Where the app under test runs. The agent talks to both through the same tools, so the
// bootstrap and sweep prompts do not care whether it is this Mac or the user's server.

export interface ShellResult {
  code: number | null
  output: string
}

export interface BackgroundProcess {
  name: string
  command: string
  logFile: string
}

export interface Runtime {
  kind: 'local' | 'vds'
  label: string
  appDir: string
  run(command: string, timeoutMs?: number): Promise<ShellResult>
  startBackground(name: string, command: string): Promise<BackgroundProcess>
  // Stops a background process this runtime started, with its children.
  stopBackground(name: string): Promise<boolean>
  readLog(name: string, lines?: number): Promise<string>
  // Returns a URL the browser on this Mac can open for a port of the app under test.
  exposePort(port: number): Promise<string>
  background(): BackgroundProcess[]
  dispose(): Promise<void>
}

export const tail = (text: string, max = 8000): string =>
  text.length > max ? `…${text.slice(-max)}` : text
