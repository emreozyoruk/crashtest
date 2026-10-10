import { writeFileSync } from 'fs'
import { join } from 'path'
import { trace } from 'neatlogs'
import type { Project, RunTarget, Scenario } from '../../shared/types'
import { getSettings } from '../store'
import { getProjectEnv, getSecret } from '../secrets'
import { postMessage, publishProject } from '../events'
import type { Runtime } from '../runtime/types'
import { createLocalRuntime } from '../runtime/local'
import { createSshRuntime, testSsh, type SshTarget } from '../runtime/ssh'
import { reapStale } from '../runtime/reap'
import { ask, guard, isBusy } from './orchestrator'
import { bootApp, type BootResult } from './bootstrap'
import { runScenario } from './sweep'
import { unsafeCommand } from './runtimeTools'
import { findingsMarkdown, findingsSummary } from './report'
import { pickParallel } from './capacity'

// Start → choose Local/VDS → boot the app → run each scenario → recover if the app dies → report.

function sshTarget(): SshTarget {
  const { ssh } = getSettings()
  return { ...ssh, password: getSecret('sshPassword'), privateKey: getSecret('sshPrivateKey') }
}

async function chooseTarget(project: Project): Promise<RunTarget> {
  const preset = getSettings().defaultRunTarget
  if (preset !== 'ask') return preset
  const choice = await ask(project.id, 'Where should I run the app for these scenarios?', [
    { id: 'local', label: 'Local (this Mac)' },
    { id: 'vds', label: 'VDS (my server)' }
  ])
  return choice as RunTarget
}

async function openRuntime(project: Project, target: RunTarget): Promise<Runtime | undefined> {
  const env = getProjectEnv(project.id)
  if (target === 'local') {
    const local = createLocalRuntime(project.workdir, env)
    await reapLeftovers(project, local)
    return local
  }

  const ssh = sshTarget()
  postMessage(
    project.id,
    'activity',
    `Checking the connection to ${ssh.username || '?'}@${ssh.host || '?'}`
  )
  const problem = await testSsh(ssh)
  if (problem) {
    postMessage(
      project.id,
      'agent',
      `I can't use the VDS yet: ${problem}\nFix it in **Settings → VDS** (or tell me the details here), then press Start again.`
    )
    return undefined
  }
  const appDir = `~/crashtest/${project.name.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '')}`
  const runtime = await createSshRuntime(ssh, appDir, env)
  await reapLeftovers(project, runtime)
  postMessage(
    project.id,
    'activity',
    `Connected to ${runtime.label}. Copying the repo to ${appDir}`
  )
  const token = getSecret('githubToken')
  const remote = token
    ? project.repoUrl.replace('https://', `https://x-access-token:${token}@`)
    : project.repoUrl
  const res = await runtime.run(
    `cd .. && rm -rf ${appDir} && git clone --depth 1 ${remote}.git ${appDir}`,
    300_000
  )
  if (res.code !== 0) {
    await runtime.dispose()
    throw new Error(
      `Cloning on the server failed: ${res.output.replaceAll(token ?? '\u0000', '***').slice(-400)}`
    )
  }
  return runtime
}

const SCENARIO_LIMIT_MS = 15 * 60_000

async function reapLeftovers(project: Project, runtime: Runtime): Promise<void> {
  const n = await reapStale(runtime)
  if (n) postMessage(project.id, 'activity', `Stopped ${n} processes an earlier run left behind`)
}

async function isUp(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8_000) })
    return res.status < 500
  } catch {
    return false
  }
}

// Brings dead background processes back by re-running the commands the bootstrap agent used.
async function recover(project: Project, runtime: Runtime, boot: BootResult): Promise<boolean> {
  postMessage(project.id, 'activity', 'The app stopped answering — restarting it')
  return trace({ name: 'app-recovery', kind: 'CHAIN', sessionId: project.id }, async () => {
    const procs = [...runtime.background()]
    // Stop first: after a dropped link the old process may still hold its port.
    for (const p of procs) {
      await runtime.stopBackground(p.name)
      await runtime.startBackground(p.name, p.command)
    }
    for (let i = 0; i < 20; i++) {
      if (await isUp(boot.baseUrl)) return true
      await new Promise((r) => setTimeout(r, 3_000))
    }
    return false
  })
}

// Runtimes with a live app, so quitting Crashtest mid-run still stops what the agent started.
const live = new Map<string, { runtime: Runtime; cleanup: string[] }>()

async function teardown(projectId: string): Promise<void> {
  const entry = live.get(projectId)
  if (!entry) return
  live.delete(projectId)
  // Cleanup commands come from the agent, so they pass the same guard as its shell. Processes it
  // started with start_background are stopped by dispose() anyway; name-matched kills are skipped.
  for (const cmd of entry.cleanup) {
    if (unsafeCommand(cmd)) continue
    await entry.runtime.run(cmd, 30_000).catch(() => undefined)
  }
  await entry.runtime.dispose()
}

export async function teardownAll(): Promise<void> {
  await Promise.all([...live.keys()].map(teardown))
}

function setStatus(project: Project, scenario: Scenario, patch: Partial<Scenario>): void {
  Object.assign(scenario, patch)
  publishProject(project)
}

export function startRun(project: Project, scenarioIds: string[]): void {
  if (isBusy(project.id)) {
    postMessage(
      project.id,
      'agent',
      'I am still working on the previous task. Stop it first or wait for it to finish.'
    )
    return
  }
  const selected = project.scenarios.filter((s) => scenarioIds.includes(s.id))
  if (!selected.length) return
  void guard(project, (signal) => sweep(project, selected, signal))
}

async function sweep(project: Project, selected: Scenario[], signal: AbortSignal): Promise<void> {
  const target = await chooseTarget(project)
  const runtime = await openRuntime(project, target)
  if (!runtime) return
  const entry = { runtime, cleanup: [] as string[] }
  live.set(project.id, entry)
  try {
    project.phase = 'bootstrapping'
    publishProject(project)
    postMessage(project.id, 'agent', `Getting the app running on ${runtime.label}…`)
    const boot = await trace(
      { name: 'app-bootstrap', kind: 'WORKFLOW', sessionId: project.id },
      () =>
        bootApp({
          projectId: project.id,
          runtime,
          localWorkdir: project.workdir,
          inventory: project.inventory,
          providedEnv: Object.keys(getProjectEnv(project.id)),
          setupNotes: project.setupNotes,
          signal
        })
    )
    entry.cleanup = boot.cleanup ?? []
    if (!boot.ok) {
      const need = boot.missingEnv.length
        ? `\n\nI need: ${boot.missingEnv.map((v) => `\`${v}\``).join(', ')} — send them here and press Start again.`
        : ''
      postMessage(project.id, 'agent', `I couldn't get the app running: ${boot.reason}${need}`)
      project.phase = 'ready'
      publishProject(project)
      return
    }
    postMessage(
      project.id,
      'agent',
      `App is up at ${boot.baseUrl}. ${boot.notes}\n\nRunning ${selected.length} scenarios…`
    )
    project.phase = 'sweeping'
    publishProject(project)

    // Workers share one queue. Health checks and restarts go through one promise, so two
    // workers never restart the app at the same time.
    const queue = [...selected]
    let stopped = false
    let healing: Promise<boolean> | undefined
    const healthy = async (): Promise<boolean> => {
      if (healing) return healing
      if (await isUp(boot.baseUrl)) return true
      healing ??= recover(project, runtime, boot).finally(() => (healing = undefined))
      return healing
    }
    const fixed = getSettings().parallelRuns
    const capacity = fixed > 0 ? null : await pickParallel(runtime)
    const parallel = capacity ? capacity.parallel : Math.min(6, fixed)
    if (capacity)
      postMessage(project.id, 'activity', `${capacity.why} Running ${parallel} at once.`)

    const worker = async (): Promise<void> => {
      for (let scenario = queue.shift(); scenario; scenario = queue.shift()) {
        if (signal.aborted || stopped) return
        if (!scenario.runnable) {
          setStatus(project, scenario, {
            status: 'skipped',
            notes: 'Needs something a local test run cannot simulate.'
          })
          continue
        }
        if (!(await healthy())) {
          if (!stopped)
            postMessage(
              project.id,
              'agent',
              'The app went down and did not come back after a restart. Stopping the run.'
            )
          stopped = true
          return
        }
        setStatus(project, scenario, { status: 'running' })
        postMessage(project.id, 'activity', `${scenario.id} · ${scenario.title}`)
        // One stuck scenario must not hold a worker for the rest of the run.
        const limit = new AbortController()
        const timer = setTimeout(() => limit.abort(), SCENARIO_LIMIT_MS)
        const stopRun = (): void => limit.abort()
        signal.addEventListener('abort', stopRun)
        try {
          const verdict = await trace(
            {
              name: 'scenario-sweep',
              kind: 'WORKFLOW',
              sessionId: project.id,
              input: { id: scenario.id, title: scenario.title }
            },
            () =>
              runScenario({
                projectId: project.id,
                scenario,
                runtime,
                localWorkdir: project.workdir,
                baseUrl: boot.baseUrl,
                apiUrl: boot.apiUrl,
                inventory: project.inventory,
                bootNotes: boot.notes,
                parallel,
                signal: limit.signal
              })
          )
          setStatus(project, scenario, {
            status: verdict.status,
            notes: verdict.observed,
            finding: verdict.finding
          })
          if (verdict.status === 'broken' && verdict.finding) {
            postMessage(project.id, 'agent', `❌ **${scenario.id}** ${verdict.finding.summary}`)
          }
        } catch (err) {
          if (signal.aborted) throw err
          setStatus(
            project,
            scenario,
            limit.signal.aborted
              ? {
                  status: 'skipped',
                  notes: `Stopped after ${SCENARIO_LIMIT_MS / 60_000} minutes without a verdict.`
                }
              : { status: 'not_run', notes: `Runner error: ${(err as Error).message}` }
          )
        } finally {
          clearTimeout(timer)
          signal.removeEventListener('abort', stopRun)
        }
      }
    }
    await Promise.all(Array.from({ length: parallel }, worker))

    const count = (st: Scenario['status']): number => selected.filter((s) => s.status === st).length
    const broken = selected.filter((s) => s.status === 'broken')
    writeFileSync(join(project.workdir, 'FINDINGS.md'), findingsMarkdown(project.name, selected))
    postMessage(
      project.id,
      'agent',
      `Run finished: ✅ ${count('passed')} passed · ❌ ${count('broken')} broken · ⏭ ${count('skipped')} skipped · ⬜ ${count('not_run')} not run.` +
        findingsSummary(broken) +
        (broken.length
          ? '\n\nOpen a broken scenario to see the root cause and the suggested fix. The full report is in `FINDINGS.md` in the project folder.'
          : '')
    )
  } finally {
    await teardown(project.id)
    project.phase = 'done'
    publishProject(project)
  }
}
