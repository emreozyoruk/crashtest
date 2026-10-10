import { cpus, totalmem } from 'os'
import type { Runtime } from '../runtime/types'

// Picks how many scenarios to run at once from what the machines can hold. Each scenario may start
// its own copy of the app (~400 MB where the app runs) and always drives a browser plus an agent on
// this Mac (~500 MB). Agents mostly wait on the model, so two per core is fine.
const APP_MB = 400
const BROWSER_MB = 500
const MAX = 6

export interface Capacity {
  parallel: number
  why: string
}

async function remoteSpecs(runtime: Runtime): Promise<{ cores: number; freeMb: number } | null> {
  const res = await runtime.run(
    "nproc 2>/dev/null || sysctl -n hw.ncpu; awk '/MemAvailable/ {print int($2/1024)}' /proc/meminfo 2>/dev/null",
    15_000
  )
  const [cores, freeMb] = res.output.trim().split(/\s+/).map(Number)
  return cores > 0 && freeMb > 0 ? { cores, freeMb } : null
}

export async function pickParallel(runtime: Runtime): Promise<Capacity> {
  // macOS reports cached memory as used, so budget a third of this Mac instead of "free" memory.
  const macMb = Math.round((totalmem() / 2 ** 20) * 0.35)
  const macCores = cpus().length
  if (runtime.kind === 'local') {
    const n = Math.max(1, Math.min(MAX, Math.floor(macMb / (APP_MB + BROWSER_MB)), macCores))
    return {
      parallel: n,
      why: `This Mac has ${macCores} cores and ${Math.round(totalmem() / 2 ** 30)} GB of memory, enough for ${n} at once.`
    }
  }
  const server = await remoteSpecs(runtime).catch(() => null)
  if (!server) return { parallel: 1, why: 'Could not read the server specs, so one at a time.' }
  const byMem = Math.floor(server.freeMb / APP_MB)
  const byCpu = server.cores * 2
  const byMac = Math.floor(macMb / BROWSER_MB)
  const n = Math.max(1, Math.min(MAX, byMem, byCpu, byMac))
  const limit =
    n === byMem
      ? 'its free memory'
      : n === byCpu
        ? 'its cores'
        : n === byMac
          ? "this Mac's memory"
          : 'the cap'
  return {
    parallel: n,
    why:
      `Your server has ${server.cores} cores and ${(server.freeMb / 1024).toFixed(1)} GB free; ` +
      `${limit} sets the limit at ${n} at once.`
  }
}
