import { trace } from 'neatlogs'
import type { Project, RunTarget, Scenario } from '../../shared/types'
import { getSettings } from '../store'
import { getProjectEnv, getSecret } from '../secrets'
import { postMessage, publishProject } from '../events'
import type { Runtime } from '../runtime/types'
import { createLocalRuntime } from '../runtime/local'
import { createSshRuntime, testSsh, type SshTarget } from '../runtime/ssh'
import { ask, guard, isBusy } from './orchestrator'
import { bootApp, type BootResult } from './bootstrap'
import { runScenario } from './sweep'

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
  if (target === 'local') return createLocalRuntime(project.workdir, env)

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
    for (const p of procs) await runtime.startBackground(p.name, p.command)
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
  for (const cmd of entry.cleanup) await entry.runtime.run(cmd, 30_000).catch(() => undefined)
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

    for (const scenario of selected) {
      if (signal.aborted) break
      if (!scenario.runnable) {
        setStatus(project, scenario, {
          status: 'skipped',
          notes: 'Needs something a local test run cannot simulate.'
        })
        continue
      }
      if (!(await isUp(boot.baseUrl)) && !(await recover(project, runtime, boot))) {
        postMessage(
          project.id,
          'agent',
          'The app went down and did not come back after a restart. Stopping the run.'
        )
        break
      }
      setStatus(project, scenario, { status: 'running' })
      postMessage(project.id, 'activity', `${scenario.id} · ${scenario.title}`)
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
              signal
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
        setStatus(project, scenario, {
          status: 'not_run',
          notes: `Runner error: ${(err as Error).message}`
        })
      }
    }

    const count = (st: Scenario['status']): number => selected.filter((s) => s.status === st).length
    postMessage(
      project.id,
      'agent',
      `Run finished: ✅ ${count('passed')} passed · ❌ ${count('broken')} broken · ⏭ ${count('skipped')} skipped · ⬜ ${count('not_run')} not run.` +
        (count('broken')
          ? '\nOpen a broken scenario to see the root cause and the suggested fix.'
          : '')
    )
  } finally {
    await teardown(project.id)
    project.phase = 'done'
    publishProject(project)
  }
}
