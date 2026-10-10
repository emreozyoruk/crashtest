import type { Runtime } from './types'

// Electron does not wait for teardown on SIGTERM, and a crash or power loss skips it too, so a
// run starts by stopping what an earlier one left. Background processes leave their pid in
// .crashtest/<name>.pid. A process group is stopped only if one of its members still works inside
// the app folder: after a reboot the same pid can belong to something else entirely.
const SCRIPT = `here=$(pwd -P); n=0
for f in .crashtest/*.pid; do
  [ -f "$f" ] || continue
  p=$(tr -dc 0-9 < "$f"); rm -f "$f"; [ -n "$p" ] || continue
  for m in $(pgrep -g "$p" 2>/dev/null); do
    cwd=$(readlink "/proc/$m/cwd" 2>/dev/null || lsof -a -p "$m" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')
    case "$cwd" in "$here"|"$here"/*) kill -- "-$p" 2>/dev/null && n=$((n+1)); break;; esac
  done
done
echo "$n"`

export async function reapStale(runtime: Runtime): Promise<number> {
  const res = await runtime.run(SCRIPT, 30_000)
  return Number(res.output.trim().split('\n').pop()) || 0
}

// Stops what one scenario started and left running (a second app copy, a proxy, a model server).
// Every command a scenario runs carries its tag in the environment; only Linux exposes another
// process's environment reliably (/proc), so on this Mac it does nothing.
const SCENARIO_SCRIPT = (id: string): string => `n=0
[ -d /proc/self ] && for p in $(ls /proc | grep -E '^[0-9]+$'); do
  { tr '\\0' '\\n' < /proc/$p/environ; } 2>/dev/null | grep -qx 'CRASHTEST_SCENARIO=${id}' || continue
  kill "$p" 2>/dev/null && n=$((n+1))
done
echo "$n"`

export async function reapScenario(runtime: Runtime, scenarioId: string): Promise<number> {
  if (!/^[\w-]+$/.test(scenarioId)) return 0
  const res = await runtime.run(SCENARIO_SCRIPT(scenarioId), 30_000)
  return Number(res.output.trim().split('\n').pop()) || 0
}
