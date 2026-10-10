import type { Inventory, Priority, Scenario, Surface } from '../../shared/types'
import { structuredCall } from './llm'
import { SCENARIO_MODEL } from './models'

const SYSTEM = `You are Crashtest's scenario writer. A scenario is ONE user, in ONE situation, trying to do ONE thing,
with an expected result a person can check on screen (or in an API response).

Imagine as widely as you can. Cross every surface you are given with these dimensions:
- who: new user, returning user, user with no data, user with a lot of data, each role, an outsider with a shared link, an attacker
- starting state: empty, half set up, fully set up, integration connected or not, expired session, each lifecycle state
- happy path: it works as designed
- the other answer: reject instead of approve, cancel instead of confirm, skip instead of fill
- wrong input: empty, too long, negative, past dates, malformed, unusual characters, duplicates
- interruption: reload mid-action, close the tab, lose the network, session expires, dependency down
- concurrency: two tabs, two users on the same record, double clicks
- time: after a day, across time zones, on a deadline, during a cooldown
- scale: zero, one, many, past the page size, past the limit
- trust and safety: someone else's id in the URL, an action the role should not allow, injected content
- AI behavior (only if the app has AI): asks, needs approval, is refused, is wrong, runs long, provider overloaded

Priorities: P1 = the core journey, money, data loss, security, permissions, anything a user cannot undo.
P2 = secondary features and common edge cases. P3 = rare paths and polish.

"runnable" is true when the scenario can be checked by driving the web UI in a browser or calling the HTTP API
of a locally running copy with test data. It is false when it needs a physical device, a real third-party reply,
a paid plan, real money, or waiting real days.

Write as many scenarios as the surfaces honestly produce. Do not pad with near-duplicates, and do not cut real ones.`

const SCHEMA = {
  type: 'object',
  properties: {
    scenarios: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: {
            type: 'string',
            description: 'Imperative, specific: "Reject an approval with a reason"'
          },
          who: { type: 'string' },
          startingState: { type: 'string' },
          steps: { type: 'array', items: { type: 'string' } },
          expected: { type: 'string', description: 'Observable result a person can check' },
          priority: { type: 'string', enum: ['P1', 'P2', 'P3'] },
          dimension: {
            type: 'string',
            description: 'Which dimension this exercises, e.g. "wrong input"'
          },
          surfaceIds: { type: 'array', items: { type: 'string' } },
          runnable: { type: 'boolean' }
        },
        required: [
          'title',
          'who',
          'startingState',
          'steps',
          'expected',
          'priority',
          'dimension',
          'surfaceIds',
          'runnable'
        ]
      }
    }
  },
  required: ['scenarios']
}

type Draft = Omit<Scenario, 'id' | 'journey' | 'status'>

const CHUNK = 18
const CONCURRENCY = 5

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++
      results[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

function chunks(inv: Inventory): { journey: string; surfaces: Surface[] }[] {
  const out: { journey: string; surfaces: Surface[] }[] = []
  const journeys = [
    ...inv.journeys,
    ...new Set(inv.surfaces.map((s) => s.journey).filter((j) => !inv.journeys.includes(j)))
  ]
  for (const journey of journeys) {
    const surfaces = inv.surfaces.filter((s) => s.journey === journey)
    for (let i = 0; i < surfaces.length; i += CHUNK)
      out.push({ journey, surfaces: surfaces.slice(i, i + CHUNK) })
  }
  return out
}

const isText = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0
const PRIORITIES: Priority[] = ['P1', 'P2', 'P3']

// The model occasionally drops a required field even with a schema. One bad draft must not
// sink a whole analysis: drop drafts without a title or expected result, default the rest.
function clean(d: Partial<Draft>): Draft | null {
  if (!isText(d.title) || !isText(d.expected)) return null
  return {
    title: d.title.trim(),
    who: isText(d.who) ? d.who : 'Any user',
    startingState: isText(d.startingState) ? d.startingState : 'Not specified',
    steps: Array.isArray(d.steps) ? d.steps.filter(isText) : [],
    expected: d.expected.trim(),
    priority: PRIORITIES.includes(d.priority as Priority) ? (d.priority as Priority) : 'P2',
    dimension: isText(d.dimension) ? d.dimension : 'happy path',
    surfaceIds: Array.isArray(d.surfaceIds) ? d.surfaceIds.filter(isText) : [],
    runnable: d.runnable !== false
  }
}

const normalize = (t: string): string =>
  t
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()

export interface ScenarioProgress {
  done: number
  total: number
  journey: string
  found: number
}

export async function generateScenarios(
  inv: Inventory,
  onProgress: (p: ScenarioProgress) => void
): Promise<Scenario[]> {
  const parts = chunks(inv)
  const context =
    `Product: ${inv.productName}\nWhat it does: ${inv.summary}\nApp type: ${inv.appType}\nStack: ${inv.stack.join(', ')}\n` +
    `All journeys, in order: ${inv.journeys.join(' → ')}`
  let done = 0
  let found = 0

  const drafts = await mapLimit(parts, CONCURRENCY, async (part) => {
    const res = await structuredCall<{ scenarios: Partial<Draft>[] }>({
      model: SCENARIO_MODEL,
      system: SYSTEM,
      prompt:
        `${context}\n\nJourney: "${part.journey}"\nSurfaces in this journey:\n${JSON.stringify(part.surfaces, null, 1)}\n\n` +
        'Write the scenarios for these surfaces.',
      toolName: 'report_scenarios',
      schema: SCHEMA,
      maxTokens: 16000
    })
    const valid = (Array.isArray(res.scenarios) ? res.scenarios : [])
      .map(clean)
      .filter((d): d is Draft => d !== null)
    done += 1
    found += valid.length
    onProgress({ done, total: parts.length, journey: part.journey, found })
    return valid.map((s) => ({ ...s, journey: part.journey }))
  })

  // Merge near-identical titles produced by overlapping chunks, keep journey order, then number.
  const seen = new Set<string>()
  const order: Record<Priority, number> = { P1: 0, P2: 1, P3: 2 }
  const merged = drafts.flat().filter((s) => {
    const key = `${s.journey}|${normalize(s.title)}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  const journeyIndex = (j: string): number => {
    const i = inv.journeys.indexOf(j)
    return i === -1 ? inv.journeys.length : i
  }
  merged.sort(
    (a, b) =>
      journeyIndex(a.journey) - journeyIndex(b.journey) || order[a.priority] - order[b.priority]
  )
  return merged.map((s, i) => ({
    ...s,
    id: `S-${String(i + 1).padStart(3, '0')}`,
    status: 'not_run'
  }))
}

export function scenariosMarkdown(
  projectName: string,
  inv: Inventory,
  scenarios: Scenario[]
): string {
  const icon = { not_run: '⬜', running: '🔄', passed: '✅', broken: '❌', skipped: '⏭' }
  const counts = inv.surfaces.reduce<Record<string, number>>(
    (acc, s) => ({ ...acc, [s.kind]: (acc[s.kind] ?? 0) + 1 }),
    {}
  )
  const lines = [
    `# Scenarios — ${projectName}`,
    '',
    `> ${inv.summary}`,
    '',
    '## Inventory',
    Object.entries(counts)
      .map(([k, v]) => `${v} ${k}`)
      .join(' · '),
    ''
  ]
  for (const journey of [...new Set(scenarios.map((s) => s.journey))]) {
    lines.push(
      `## ${journey}`,
      '',
      '| ID | P | Scenario | Expected | Status |',
      '|---|---|---|---|---|'
    )
    for (const s of scenarios.filter((x) => x.journey === journey)) {
      lines.push(
        `| ${s.id} | ${s.priority} | ${s.title} | ${s.expected.replace(/\|/g, '/')} | ${icon[s.status]} |`
      )
    }
    lines.push('')
  }
  return lines.join('\n')
}
