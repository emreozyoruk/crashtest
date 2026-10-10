import type { Scenario } from '../../shared/types'

// Several broken scenarios often share one defect (e.g. every bad-token request hitting the same
// error handler). Grouping them by the file their root cause names turns a long list of ❌ into
// the handful of places a developer actually has to fix.

const LOCATION = /([\w.@/-]+\.[a-z]{1,5}):(\d+)/i

export function rootFile(s: Scenario): string {
  return s.finding?.rootCause?.match(LOCATION)?.[1] ?? 'Root cause not located'
}

export function groupByRootFile(broken: Scenario[]): [string, Scenario[]][] {
  const groups = new Map<string, Scenario[]>()
  for (const s of broken) groups.set(rootFile(s), [...(groups.get(rootFile(s)) ?? []), s])
  return [...groups.entries()].sort((a, b) => b[1].length - a[1].length)
}

export function findingsSummary(broken: Scenario[]): string {
  const groups = groupByRootFile(broken)
  const located = groups.filter(([file]) => file !== 'Root cause not located')
  if (!located.length) return ''
  const top = located
    .slice(0, 5)
    .map(([file, list]) => `- \`${file}\` — ${list.map((s) => s.id).join(', ')}`)
    .join('\n')
  return `\n\nThe ${broken.length} broken scenarios trace back to **${located.length} files**:\n${top}`
}

export function findingsMarkdown(projectName: string, scenarios: Scenario[]): string {
  const broken = scenarios.filter((s) => s.status === 'broken')
  const count = (st: Scenario['status']): number => scenarios.filter((s) => s.status === st).length
  const lines = [
    `# Findings — ${projectName}`,
    '',
    `✅ ${count('passed')} passed · ❌ ${count('broken')} broken · ⏭ ${count('skipped')} skipped · ⬜ ${count('not_run')} not run`,
    ''
  ]
  for (const [file, list] of groupByRootFile(broken)) {
    lines.push(`## \`${file}\` (${list.length})`, '')
    for (const s of list) {
      const f = s.finding
      lines.push(`### ${s.id} [${s.priority}] ${s.title}`, '')
      if (f) {
        lines.push(`**What broke:** ${f.summary}`, '')
        lines.push(`- Expected: ${f.expected}`, `- Actual: ${f.actual}`)
        if (f.rootCause) lines.push(`- Root cause: ${f.rootCause}`)
        if (f.screenshot) lines.push(`- Screenshot: \`${f.screenshot}\``)
        lines.push('')
        if (f.suggestedFix) lines.push('```diff', f.suggestedFix, '```', '')
      }
    }
  }
  return lines.join('\n')
}
