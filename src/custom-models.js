/**
 * Models the user adds by id, next to the built-in catalog.
 *
 * Geek2API serves more models than the catalog declares (a key's
 * `/v1/models` lists them). A user-added model names its id, the protocol the
 * gateway serves it over, and whether it takes a reasoning effort or images;
 * the route then serves it exactly like a built-in one, with the same keys,
 * endpoints, failover, and key rotation.
 *
 * The list is a volatile preference (`customModels`). Writes from the panel
 * are validated strictly and refused with a reason; a hand-edited profile is
 * read leniently, dropping only the entries that cannot be served.
 *
 * @module dsh-geek2api/custom-models
 */

import z from '@deepseek-ai/schemastery'

import { CUSTOM_MODEL_BASES, GEEK2API_MODEL_IDS } from './catalog.js'

/** The protocols a custom model can use, in the order the panel offers them. */
export const CUSTOM_MODEL_PROTOCOLS = Object.freeze(Object.keys(CUSTOM_MODEL_BASES))
/** How many custom models one profile may declare. */
export const MAX_CUSTOM_MODELS = 32
export const DEFAULT_CUSTOM_CONTEXT_WINDOW = 128_000
export const DEFAULT_CUSTOM_MAX_TOKENS = 32_000
const MIN_CONTEXT_WINDOW = 1_000
const MAX_CONTEXT_WINDOW = 10_000_000
const MAX_NAME = 64
/** Gateway model ids: letters, digits and `. _ - : / @ +`, starting with a letter or digit. */
const ID_PATTERN = /^[A-Za-z0-9][\w.:/@+-]{0,127}$/u

/** The stored shape; every field but the id has a default. */
export const CustomModelSchema = z.object({
  id: z.string(),
  name: z.string().default(''),
  api: z.union([...CUSTOM_MODEL_PROTOCOLS]).default('openai-completions'),
  reasoning: z.boolean().default(false),
  image: z.boolean().default(false),
  contextWindow: z.natural().default(DEFAULT_CUSTOM_CONTEXT_WINDOW),
  maxTokens: z.natural().default(DEFAULT_CUSTOM_MAX_TOKENS),
})

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)

/** A positive integer field, its default when absent, or undefined when invalid. */
function integerField(value, fallback, min, max) {
  if (value === undefined || value === null || value === '') return fallback
  const number = typeof value === 'string' ? Number(value.trim()) : value
  return Number.isInteger(number) && number >= min && number <= max ? number : undefined
}

/**
 * Validate one entry.
 * @param entry - a stored or submitted entry.
 * @returns the normalized descriptor.
 * @throws an Error naming what is wrong; the message is safe for the panel.
 */
export function parseCustomModel(entry) {
  if (!record(entry)) throw new Error('Geek2API custom model entries must be objects')
  const id = typeof entry.id === 'string' ? entry.id.trim() : ''
  if (id === '') throw new Error('Geek2API custom model needs a model id')
  if (!ID_PATTERN.test(id)) throw new Error(`Geek2API custom model id "${id.slice(0, 128)}" may only use letters, digits and . _ - : / @ +`)
  if (GEEK2API_MODEL_IDS.includes(id)) throw new Error(`Geek2API custom model "${id}" is already a built-in model`)
  const api = entry.api ?? 'openai-completions'
  if (!CUSTOM_MODEL_PROTOCOLS.includes(api)) throw new Error(`Geek2API custom model "${id}" names an unsupported protocol`)
  const contextWindow = integerField(entry.contextWindow, DEFAULT_CUSTOM_CONTEXT_WINDOW, MIN_CONTEXT_WINDOW, MAX_CONTEXT_WINDOW)
  if (contextWindow === undefined) {
    throw new Error(`Geek2API custom model "${id}" needs a context window between ${MIN_CONTEXT_WINDOW} and ${MAX_CONTEXT_WINDOW} tokens`)
  }
  const maxTokens = integerField(entry.maxTokens, Math.min(DEFAULT_CUSTOM_MAX_TOKENS, contextWindow), 1, contextWindow)
  if (maxTokens === undefined) throw new Error(`Geek2API custom model "${id}" needs max output tokens between 1 and its context window`)
  const name = typeof entry.name === 'string' ? entry.name.replace(/\s+/gu, ' ').trim().slice(0, MAX_NAME) : ''
  return Object.freeze({
    id,
    name,
    api,
    reasoning: entry.reasoning === true,
    image: entry.image === true,
    contextWindow,
    maxTokens,
  })
}

/**
 * Validate a list the panel submitted: every entry must be servable.
 * @param list - the submitted entries.
 * @returns the normalized descriptors, in order.
 * @throws on the first invalid entry, a duplicate, or too many entries.
 */
export function validateCustomModels(list) {
  if (!Array.isArray(list)) throw new Error('Geek2API custom models must be a list')
  if (list.length > MAX_CUSTOM_MODELS) throw new Error(`Geek2API allows at most ${MAX_CUSTOM_MODELS} custom models`)
  const seen = new Set()
  return list.map(entry => {
    const parsed = parseCustomModel(entry)
    if (seen.has(parsed.id)) throw new Error(`Geek2API custom model "${parsed.id}" is listed twice`)
    seen.add(parsed.id)
    return parsed
  })
}

/**
 * Read the stored list leniently: an entry that cannot be served, or repeats
 * an id, is dropped instead of taking the whole route down.
 * @param value - the `customModels` preference.
 * @returns the servable descriptors, in order.
 */
export function readCustomModels(value) {
  if (!Array.isArray(value)) return []
  const seen = new Set()
  const models = []
  for (const entry of value) {
    if (models.length >= MAX_CUSTOM_MODELS) break
    let parsed
    try {
      parsed = parseCustomModel(entry)
    } catch {
      continue
    }
    if (seen.has(parsed.id)) continue
    seen.add(parsed.id)
    models.push(parsed)
  }
  return models
}
