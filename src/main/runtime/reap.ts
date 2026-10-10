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
