import Anthropic from '@anthropic-ai/sdk'
import { wrapAnthropic } from 'neatlogs'
import { anthropicKey } from './runAgent'

// Single-shot structured calls (no tools to execute): forces the model to answer through one
// tool whose input schema is the shape we want back.

let client: Anthropic | undefined
let clientKey = ''

function getClient(): Anthropic {
  const key = anthropicKey()
  if (!client || key !== clientKey) {
    client = wrapAnthropic(new Anthropic({ apiKey: key }))
    clientKey = key
  }
  return client
}

export async function structuredCall<T>(opts: {
  model: string
  system: string
  prompt: string
  toolName: string
  schema: Record<string, unknown>
  maxTokens?: number
}): Promise<T> {
  const res = await getClient().messages.create({
    model: opts.model,
    max_tokens: opts.maxTokens ?? 8000,
    system: opts.system,
    messages: [{ role: 'user', content: opts.prompt }],
    tools: [{ name: opts.toolName, description: 'Return the result.', input_schema: opts.schema as Anthropic.Tool.InputSchema }],
    tool_choice: { type: 'tool', name: opts.toolName }
  })
  const block = res.content.find((b) => b.type === 'tool_use')
  if (!block || block.type !== 'tool_use') throw new Error('Model did not return structured output')
  return block.input as T
}
