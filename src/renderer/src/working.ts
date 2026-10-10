import type { Project } from '../../shared/types'

const BUSY_PHASES = new Set(['cloning', 'inventory', 'scenarios', 'bootstrapping', 'sweeping'])
export const isWorking = (p?: Project): boolean => Boolean(p && BUSY_PHASES.has(p.phase))
