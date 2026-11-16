/**
 * Which groups each stored key belongs to, and which catalog models it can
 * reach.
 *
 * Geek2API routes a request by the key's group (or, for a multi-group key,
 * its groups in priority order): a key bound to a Claude group is refused for
 * GPT, and so on. None of that is visible from the key itself, so a key that
 * cannot serve the selected model looked exactly like a client fault.
 *
 * Two host-side reads answer it, neither of them billed:
 * - `/v1/models` lists exactly the models the key's groups can serve — this
 *   is what decides coverage;
 * - `/v1/usage` names the key's groups when the gateway reports them
 *   (`key.groups`), which the settings panel shows next to the key.
 *
 * Every request is bounded by a timeout and refuses redirects. Nothing here
 * returns key material: the projection carries group names and per-model
 * booleans.
 *
 * @module dsh-geek2api/groups
 */

import { createCachedRead } from './cached-read.js'
import { GEEK2API_MODEL_IDS } from './catalog.js'
import { DEFAULT_REQUEST_TIMEOUT_MS } from './constants.js'
import { classifyGatewayFailure, INVALID_KEY_FAILURE } from './failures.js'
import { ambientFetch, boundedFetch } from './request.js'

/** Group membership changes rarely; a forced read bypasses this. */
export const DEFAULT_GROUP_TTL_MS = 10 * 60_000

const MAX_GROUPS = 32
const MAX_NAME = 64
/** Keys read at once. */
const KEY_CONCURRENCY = 4

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)

/** Run `task` over `items`, at most `limit` at a time, keeping their order. */
async function mapLimited(items, limit, task) {
  const results = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const index = next
      next += 1
      results[index] = await task(items[index], index)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

/** The gateway refused the key itself; it reaches no model at all. */
class RejectedKeyError extends Error {
  constructor() {
    super('the gateway rejected this key')
  }
}

/** The gateway's error message from a failed response, bounded. */
async function errorText(response) {
  let text = ''
  try {
    text = await response.text()
  } catch {
    return ''
  }
  try {
    const parsed = JSON.parse(text)
    const message = parsed?.error?.message ?? parsed?.message
    if (typeof message === 'string') return message.slice(0, 200)
  } catch {
    // Not JSON.
  }
  return text.slice(0, 200)
}

const cleanName = value => (typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim().slice(0, MAX_NAME) : '')

/**
 * Read the key's groups from `/v1/usage`. The gateway may name them as
 * `key.groups` (`[{ name, platform }]` or names), or as a single `key.group`.
 * @param payload - the usage body.
 * @returns group names in priority order, or undefined when none are named.
 */
export function parseKeyGroups(payload) {
  const key = record(payload?.key) ? payload.key : undefined
  if (key === undefined) return undefined
  const raw = Array.isArray(key.groups) ? key.groups : record(key.group) || typeof key.group === 'string' ? [key.group] : []
  const names = raw.map(item => cleanName(record(item) ? item.name : item)).filter(name => name !== '')
  return names.length === 0 ? undefined : [...new Set(names)].slice(0, MAX_GROUPS)
}

/** Smallest context window the gateway may report for a model; anything smaller is ignored as noise. */
const MIN_REPORTED_CONTEXT_WINDOW = 8_192

/**
 * Per-model context windows from a `/v1/models` body. sub2api reports
 * `context_window` when the key's group caps the input per request (the free
 * DeepSeek group allows 200K although the model itself takes 1M).
 * @param data - the `data` array of the model list.
 * @returns model id → context window, only for models that report one.
 */
export function parseContextWindows(data) {
  const windows = new Map()
  if (!Array.isArray(data)) return windows
  for (const item of data) {
    const id = item?.id
    const value = item?.context_window
    if (typeof id === 'string' && Number.isInteger(value) && value >= MIN_REPORTED_CONTEXT_WINDOW) windows.set(id, value)
  }
  return windows
}

/**
 * The key's lifetime from `/v1/usage`: when it expires and whether it is a
 * daily free key that is re-claimed on the website.
 * @param payload - the usage body.
 * @returns `{ expiresAt, daily, renewWindowHours, renewPath }`, or undefined when the key never expires.
 */
export function parseKeyLifetime(payload) {
  const key = record(payload?.key) ? payload.key : undefined
  if (key === undefined || typeof key.expires_at !== 'string') return undefined
  const expiresAt = Date.parse(key.expires_at)
  if (!Number.isFinite(expiresAt)) return undefined
  const daily = key.purpose === 'free_daily'
  const renewWindowHours = Number.isInteger(key.renew_window_hours) && key.renew_window_hours > 0 ? key.renew_window_hours : 2
  const renewPath = typeof key.renew_path === 'string' && /^\/[a-z0-9/_-]{1,64}$/iu.test(key.renew_path) ? key.renew_path : '/free-ds'
  return Object.freeze({ expiresAt, daily, ...(daily ? { renewWindowHours, renewPath } : {}) })
}

/**
 * Which catalog models a key can reach, from its model list. A model is
 * only marked unreachable on evidence; with no list it is left unknown.
 * @param models - the key's model ids, or undefined.
 * @param ids - the catalog's ids, built-in and custom.
 * @returns catalog model id → reachable.
 */
export function catalogCoverage(models, ids = GEEK2API_MODEL_IDS) {
  if (models === undefined) return {}
  return Object.fromEntries(ids.map(id => [id, models.has(id)]))
}

/**
 * Cached, single-flight group reader.
 * @param options - key listing, the host pool, the catalog's ids (built-in and
 *   custom; drop the reading when they change), and transport knobs.
 * @returns `{ read, snapshot, hasReading, covers, contextLimitFor, lifetimeOf, requiredGroups, groupsOf, invalidate }`.
 */
export function createGroupReader({
  listKeys,
  hosts,
  modelIds = () => GEEK2API_MODEL_IDS,
  fetchImpl = ambientFetch,
  now = Date.now,
  ttlMs = DEFAULT_GROUP_TTL_MS,
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
} = {}) {
  if (typeof listKeys !== 'function') throw new Error('Geek2API group reader requires listKeys')
  if (typeof hosts?.withFailover !== 'function') throw new Error('Geek2API group reader requires a host pool')
  /** Last good reading per key id, kept when a later read of that key fails. */
  const lastGood = new Map()

  const get = (path, entry, signal) => hosts.withFailover(host => boundedFetch(`${host}${path}`, {
    headers: { Authorization: `Bearer ${entry.key}`, Accept: 'application/json' },
  }, { fetchImpl, timeoutMs, signal }), { signal })

  /** The models the key can reach. */
  const loadModels = async (entry, signal) => {
    const response = await get('/v1/models', entry, signal)
    if (response.status === 401) throw new RejectedKeyError()
    if (!response.ok) {
      const message = await errorText(response)
      // A key whose group was deleted or withdrawn reaches nothing either.
      if (classifyGatewayFailure(message) === INVALID_KEY_FAILURE) throw new RejectedKeyError()
      throw new Error(`the gateway answered HTTP ${response.status} for the model list${message === '' ? '' : `: ${message}`}`)
    }
    const payload = await response.json()
    if (!Array.isArray(payload?.data)) throw new Error('the gateway returned an unrecognized model list')
    return {
      ids: new Set(payload.data.map(item => item?.id).filter(id => typeof id === 'string')),
      windows: parseContextWindows(payload.data),
    }
  }

  /** The key's groups, when the gateway names them. */
  const loadGroups = async (entry, signal) => {
    const response = await get('/v1/usage?lite=1', entry, signal)
    if (response.status === 401) throw new RejectedKeyError()
    if (!response.ok) return undefined
    const payload = await response.json()
    return { groups: parseKeyGroups(payload), lifetime: parseKeyLifetime(payload) }
  }

  /**
   * One key's model list and groups. The two are independent: the groups are
   * decoration, the model list is the evidence, and a rejection from either
   * means the gateway refuses the key itself.
   */
  const readKey = async (entry, signal) => {
    const [models, groups] = await Promise.allSettled([loadModels(entry, signal), loadGroups(entry, signal)])
    if ([models, groups].some(result => result.status === 'rejected' && result.reason instanceof RejectedKeyError)) return { rejected: true }
    if (models.status === 'rejected') throw models.reason
    const usage = groups.status === 'fulfilled' ? groups.value : undefined
    return { models: models.value.ids, windows: models.value.windows, groups: usage?.groups, lifetime: usage?.lifetime }
  }

  const load = async signal => {
    signal?.throwIfAborted()
    const keys = await listKeys()
    for (const id of lastGood.keys()) {
      if (!keys.some(entry => entry.id === id)) lastGood.delete(id)
    }
    const readings = await mapLimited(keys, KEY_CONCURRENCY, entry => readKey(entry, signal).then(value => ({ value }), error => ({ error })))
    signal?.throwIfAborted()
    const ids = modelIds()
    const entries = keys.map((entry, index) => {
      const { value, error } = readings[index]
      if (value?.rejected === true) {
        // Evidence, not a failed read: a rejected key reaches nothing.
        lastGood.delete(entry.id)
        return { id: entry.id, rejected: true, coverage: Object.fromEntries(ids.map(id => [id, false])), error: new RejectedKeyError().message }
      }
      if (value !== undefined) {
        const reading = {
          id: entry.id,
          ...(value.groups === undefined ? {} : { groups: value.groups }),
          ...(value.lifetime === undefined ? {} : { lifetime: value.lifetime }),
          ...(value.windows.size === 0 ? {} : { contextWindows: Object.fromEntries(value.windows) }),
          coverage: catalogCoverage(value.models, ids),
          extraModels: [...value.models].filter(id => !ids.includes(id)).length,
        }
        lastGood.set(entry.id, { value: reading, fetchedAt: now() })
        return reading
      }
      const message = error instanceof Error ? error.message : String(error)
      const previous = lastGood.get(entry.id)
      return previous === undefined
        ? { id: entry.id, coverage: {}, error: message }
        : { ...previous.value, stale: { fetchedAt: previous.fetchedAt, error: message } }
    })
    return { keys: entries, descriptions: {}, requirements: {}, fetchedAt: now() }
  }

  const cache = createCachedRead(load, { ttlMs, now })
  const keyEntry = keyId => cache.peek()?.keys.find(candidate => candidate.id === keyId)

  return Object.freeze({
    /** Read every key's coverage; cached for the TTL unless forced. */
    read: options => cache.read(options),
    /** The last reading, however old, without touching the network. */
    snapshot: () => cache.snapshot(),
    /** Whether any reading exists yet. */
    hasReading: () => cache.peek() !== undefined,
    /**
     * Whether a key reaches a model, from the last reading.
     * @returns true, false, or undefined when there is no evidence.
     */
    covers(keyId, modelId) {
      const value = keyEntry(keyId)?.coverage?.[modelId]
      return typeof value === 'boolean' ? value : undefined
    },
    /** Geek2API publishes no per-model group table; always undefined. */
    requiredGroups: () => undefined,
    /**
     * The tightest context window any key that reaches `modelId` reports, from
     * the last reading. A key that reports none is not limited by its group.
     * @returns the window in tokens, or undefined when no covering key reports one.
     */
    contextLimitFor(modelId) {
      let limit
      for (const entry of cache.peek()?.keys ?? []) {
        if (entry.rejected === true || entry.coverage?.[modelId] !== true) continue
        const value = entry.contextWindows?.[modelId]
        if (Number.isInteger(value) && (limit === undefined || value < limit)) limit = value
      }
      return limit
    },
    /** When a key expires and whether it is a daily free key, from the last reading. */
    lifetimeOf(keyId) {
      return keyEntry(keyId)?.lifetime
    },
    /** The groups the last reading found for a key. */
    groupsOf(keyId) {
      const groups = keyEntry(keyId)?.groups
      return Array.isArray(groups) ? [...groups] : undefined
    },
    /** Drop the reading so the next read goes to the network. */
    invalidate: () => cache.invalidate(),
  })
}

/**
 * Pick the key a request for `modelId` runs with.
 *
 * The active key serves every model it is not known to be excluded from.
 * When the last reading shows it cannot reach the model, the next usable key
 * in ring order that can — or, failing that, one with no evidence either way
 * — serves this request instead. The active pointer itself does not move;
 * with no better key the active one is returned, marked uncovered.
 * @param modelId - the catalog model of this request.
 * @param active - the ring's active key.
 * @param usable - the ring's usable keys, in ring order.
 * @param covers - `(keyId, modelId) => true | false | undefined`.
 * @returns the chosen key, with `switchedFrom` or `uncovered` when it is not
 *   simply the active key.
 */
export function pickKeyForModel(modelId, active, usable, covers) {
  if (active === undefined) return undefined
  if (typeof modelId !== 'string' || covers(active.id, modelId) !== false) return { ...active }
  const start = usable.findIndex(entry => entry.id === active.id)
  const others = start < 0 ? usable.filter(entry => entry.id !== active.id) : [...usable.slice(start + 1), ...usable.slice(0, start)]
  const pick = others.find(entry => covers(entry.id, modelId) === true) ?? others.find(entry => covers(entry.id, modelId) === undefined)
  if (pick === undefined) return { ...active, uncovered: true }
  return { id: pick.id, label: pick.label, key: pick.key, switchedFrom: { id: active.id, label: active.label } }
}
