/**
 * The built-in Geek2API model catalog.
 *
 * Geek2API (a sub2api gateway) serves every protocol on every entry point:
 * - OpenAI-style traffic takes `/v1` in the base URL and never an endpoint
 *   path — the SDK appends `/responses` or `/chat/completions` itself.
 * - Anthropic traffic takes the bare origin: the Anthropic client appends
 *   `/v1/messages` itself.
 * The gateway routes by the key's group, and each group's upstream speaks one
 * vendor's dialect best, so every model pins the protocol its vendor serves:
 * GPT and Grok on Responses, Claude on Messages, the rest on Chat Completions.
 *
 * The base URLs below name the first default host; the route rewrites the
 * origin per request to whichever host the pool currently prefers.
 *
 * Effort levels come from each vendor's documentation, because an effort the
 * model does not support is refused before the request is sent. Models whose
 * reasoning control this gateway does not pass through are declared without
 * reasoning, so the picker offers no level the upstream would reject.
 *
 * @module dsh-geek2api/catalog
 */

import { DEFAULT_API_HOST, PROVIDER } from './constants.js'

/** pi-ai never reads this gateway's pricing; the harness zeroes cost anyway. */
const NO_COST = Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })

const OPENAI_BASE = `${DEFAULT_API_HOST}/v1`
const MESSAGES_BASE = DEFAULT_API_HOST

/**
 * pi-ai thinking-level maps. A level pinned to `null` is unsupported; an
 * absent key keeps pi-ai's own default for that level, which is how `off`
 * stays available for DeepSeek (`off` sends nothing and the deepseek dialect
 * then emits `thinking: disabled`).
 */
const DEEPSEEK_LEVELS = Object.freeze({
  minimal: null,
  low: 'low',
  medium: null,
  high: 'high',
  xhigh: null,
  max: 'max',
})

/** Models that cannot disable reasoning: `off` is pinned unsupported. */
const ALWAYS_THINKING_LEVELS = Object.freeze({
  off: null,
  minimal: null,
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: 'max',
})

/** Grok supports low | medium | high | xhigh, with no off or max. */
const GROK_LEVELS = Object.freeze({ ...ALWAYS_THINKING_LEVELS, max: null })

/** Claude Haiku 4.5 takes low | medium | high effort. */
const HAIKU_LEVELS = Object.freeze({ ...ALWAYS_THINKING_LEVELS, xhigh: null, max: null })

const DEEPSEEK_COMPAT = Object.freeze({
  thinkingFormat: 'deepseek',
  maxTokensField: 'max_tokens',
  requiresReasoningContentOnAssistantMessages: true,
  supportsDeveloperRole: false,
})

const CLAUDE_COMPAT = Object.freeze({
  // Adaptive thinking is always on for Claude 5.x: effort is the depth
  // control, and the model rejects temperature outright.
  forceAdaptiveThinking: true,
  supportsTemperature: false,
})

/** Chat Completions models the gateway serves without a reasoning control. */
const PLAIN_COMPAT = Object.freeze({
  maxTokensField: 'max_tokens',
  supportsDeveloperRole: false,
})

const model = fields => Object.freeze({ provider: PROVIDER, cost: NO_COST, input: Object.freeze(['text', 'image']), ...fields })

export const GEEK2API_MODELS = Object.freeze([
  model({
    id: 'claude-opus-5-5',
    name: 'Claude Opus 5.5',
    api: 'anthropic-messages',
    baseUrl: MESSAGES_BASE,
    reasoning: true,
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    thinkingLevelMap: ALWAYS_THINKING_LEVELS,
    compat: CLAUDE_COMPAT,
  }),
  model({
    id: 'claude-sonnet-5-5',
    name: 'Claude Sonnet 5.5',
    api: 'anthropic-messages',
    baseUrl: MESSAGES_BASE,
    reasoning: true,
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    thinkingLevelMap: ALWAYS_THINKING_LEVELS,
    compat: CLAUDE_COMPAT,
  }),
  model({
    id: 'claude-haiku-4-5-20251001',
    name: 'Claude Haiku 4.5',
    api: 'anthropic-messages',
    baseUrl: MESSAGES_BASE,
    reasoning: true,
    contextWindow: 200_000,
    maxTokens: 64_000,
    thinkingLevelMap: HAIKU_LEVELS,
  }),
  model({
    id: 'gpt-6.1-sol',
    name: 'GPT-6.1 Sol',
    api: 'openai-responses',
    baseUrl: OPENAI_BASE,
    reasoning: true,
    contextWindow: 1_050_000,
    maxTokens: 128_000,
    thinkingLevelMap: ALWAYS_THINKING_LEVELS,
  }),
  model({
    id: 'gpt-6-astra',
    name: 'GPT-6 Astra',
    api: 'openai-responses',
    baseUrl: OPENAI_BASE,
    reasoning: true,
    contextWindow: 1_050_000,
    maxTokens: 128_000,
    thinkingLevelMap: ALWAYS_THINKING_LEVELS,
  }),
  model({
    id: 'gpt-6-luna',
    name: 'GPT-6 Luna',
    api: 'openai-responses',
    baseUrl: OPENAI_BASE,
    reasoning: true,
    contextWindow: 400_000,
    maxTokens: 128_000,
    thinkingLevelMap: ALWAYS_THINKING_LEVELS,
  }),
  model({
    id: 'deepseek-v4.1-flash',
    name: 'DeepSeek V4.1 Flash',
    api: 'openai-completions',
    baseUrl: OPENAI_BASE,
    reasoning: true,
    contextWindow: 1_000_000,
    maxTokens: 384_000,
    thinkingLevelMap: DEEPSEEK_LEVELS,
    compat: DEEPSEEK_COMPAT,
  }),
  model({
    id: 'deepseek-v4-pro',
    name: 'DeepSeek V4 Pro',
    api: 'openai-completions',
    baseUrl: OPENAI_BASE,
    reasoning: true,
    input: Object.freeze(['text']),
    contextWindow: 1_000_000,
    maxTokens: 384_000,
    thinkingLevelMap: DEEPSEEK_LEVELS,
    compat: DEEPSEEK_COMPAT,
  }),
  model({
    id: 'grok-4.6',
    name: 'Grok 4.6',
    api: 'openai-responses',
    baseUrl: OPENAI_BASE,
    reasoning: true,
    contextWindow: 500_000,
    maxTokens: 500_000,
    thinkingLevelMap: GROK_LEVELS,
    compat: Object.freeze({ supportsLongCacheRetention: false }),
  }),
  model({
    id: 'grok-4.7',
    name: 'Grok 4.7',
    api: 'openai-responses',
    baseUrl: OPENAI_BASE,
    reasoning: true,
    contextWindow: 500_000,
    maxTokens: 500_000,
    thinkingLevelMap: GROK_LEVELS,
    compat: Object.freeze({ supportsLongCacheRetention: false }),
  }),
  model({
    id: 'gemini-3.8-flash',
    name: 'Gemini 3.8 Flash',
    api: 'openai-completions',
    baseUrl: OPENAI_BASE,
    reasoning: false,
    contextWindow: 1_000_000,
    maxTokens: 65_536,
    compat: PLAIN_COMPAT,
  }),
  model({
    id: 'glm-5.3',
    name: 'GLM-5.3',
    api: 'openai-completions',
    baseUrl: OPENAI_BASE,
    reasoning: false,
    input: Object.freeze(['text']),
    contextWindow: 200_000,
    maxTokens: 128_000,
    compat: PLAIN_COMPAT,
  }),
  model({
    id: 'kimi-k3',
    name: 'Kimi K3',
    api: 'openai-completions',
    baseUrl: OPENAI_BASE,
    reasoning: false,
    contextWindow: 256_000,
    maxTokens: 64_000,
    compat: PLAIN_COMPAT,
  }),
])

/** Every model id this catalog advertises, in picker order. */
export const GEEK2API_MODEL_IDS = Object.freeze(GEEK2API_MODELS.map(item => item.id))

/**
 * Point a catalog model at another entry point, keeping its path: `/v1` for
 * OpenAI-style models, the bare origin for Messages models.
 * @param catalogModel - a catalog entry.
 * @param host - the origin to use.
 * @returns the model with its `baseUrl` re-rooted, or the model unchanged.
 */
export function modelForHost(catalogModel, host) {
  if (typeof host !== 'string' || host === '' || typeof catalogModel?.baseUrl !== 'string') return catalogModel
  let path
  try {
    path = new URL(catalogModel.baseUrl).pathname.replace(/\/+$/u, '')
  } catch {
    return catalogModel
  }
  const baseUrl = `${host}${path}`
  return baseUrl === catalogModel.baseUrl ? catalogModel : { ...catalogModel, baseUrl }
}
