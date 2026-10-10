// Haiku generates scenarios (many cheap, parallel calls); Sonnet does the multi-step work
// that needs judgement: reading the codebase, booting the app, running and diagnosing.
export const SCENARIO_MODEL = 'claude-haiku-5-5'
export const AGENT_MODEL = 'claude-sonnet-5-5'
export const RUNNER_MODELS = { sonnet: AGENT_MODEL, haiku: SCENARIO_MODEL } as const
