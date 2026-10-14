/**
 * Per-key balance, read from Geek2API's `/v1/usage`.
 *
 * Geek2API is a sub2api gateway. `/v1/usage` answers for the key that
 * authorized it, in one of three shapes:
 * - wallet (`mode: unrestricted`, `planName: 钱包余额`): the key spends the
 *   account wallet, so every key of one account reports the same balance;
 * - subscription (`mode: unrestricted` with `subscription`): the key's group
 *   is a subscription plan with daily/weekly/monthly limits;
 * - key quota (`mode: quota_limited`): the key has its own spending cap and
 *   optional 5h/1d/7d rate windows.
 * All amounts are USD. Lifetime and today's spend through the key come from
 * the `usage` block.
 *
 * Credentials and response bodies stay host-side; the browser receives only
 * the projection built here.
 *
 * @module dsh-geek2api/balance
 */

import { createCachedRead } from './cached-read.js'
import { DEFAULT_BALANCE_TTL_MS, DEFAULT_REQUEST_TIMEOUT_MS } from './constants.js'
import { ambientFetch, boundedFetch } from './request.js'

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)

function number(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

const usd = value => {
  const parsed = number(value)
  return parsed === undefined ? undefined : Math.round(parsed * 1e6) / 1e6
}

const timestamp = value => {
  if (typeof value !== 'string' || value === '') return undefined
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

const defined = object => Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined))

function parseRateLimits(value) {
  if (!Array.isArray(value)) return undefined
  const windows = value.filter(record).map(item => defined({
    window: typeof item.window === 'string' ? item.window : undefined,
    limitUsd: usd(item.limit),
    usedUsd: usd(item.used),
    remainingUsd: usd(item.remaining),
    resetAt: timestamp(item.reset_at),
  })).filter(item => item.window !== undefined)
  return windows.length === 0 ? undefined : windows
}

/** The tightest configured subscription period: what limits the next request. */
function subscriptionPeriod(subscription) {
  const periods = [
    ['daily', subscription.daily_limit_usd, subscription.daily_usage_usd],
    ['weekly', subscription.weekly_limit_usd, subscription.weekly_usage_usd],
    ['monthly', subscription.monthly_limit_usd, subscription.monthly_usage_usd],
  ]
    .map(([period, limit, used]) => ({ period, limit: usd(limit), used: usd(used) ?? 0 }))
    .filter(item => item.limit !== undefined && item.limit > 0)
  if (periods.length === 0) return undefined
  return periods.reduce((tightest, item) => (item.limit - item.used < tightest.limit - tightest.used ? item : tightest))
}

/**
 * Normalize `/v1/usage`.
 * @param payload - the endpoint's body.
 * @returns a small projection, or undefined when the shape is unrecognized.
 */
export function parseKeyUsage(payload) {
  if (!record(payload) || typeof payload.mode !== 'string') return undefined
  const usage = record(payload.usage) ? payload.usage : {}
  const common = defined({
    planName: typeof payload.planName === 'string' && payload.planName !== '' ? payload.planName : undefined,
    valid: payload.isValid === false ? false : undefined,
    status: typeof payload.status === 'string' && payload.status !== 'active' ? payload.status : undefined,
    todayUsd: usd(usage.today?.actual_cost),
    spentUsd: usd(usage.total?.actual_cost),
    todayRequests: number(usage.today?.requests),
    accountRef: typeof payload.account_ref === 'string' && payload.account_ref !== '' ? payload.account_ref : undefined,
    keyName: typeof payload.key?.name === 'string' && payload.key.name !== '' ? payload.key.name : undefined,
  })

  if (payload.mode === 'quota_limited') {
    const quota = record(payload.quota) ? payload.quota : undefined
    const expiresAt = timestamp(payload.expires_at)
    return defined({
      ...common,
      mode: 'quota',
      unlimitedQuota: quota === undefined,
      limitUsd: usd(quota?.limit),
      usedUsd: usd(quota?.used),
      availableUsd: usd(quota?.remaining ?? payload.remaining),
      rateLimits: parseRateLimits(payload.rate_limits),
      expiresAt,
    })
  }

  if (record(payload.subscription)) {
    const period = subscriptionPeriod(payload.subscription)
    return defined({
      ...common,
      mode: 'subscription',
      unlimitedQuota: period === undefined,
      limitUsd: period?.limit,
      usedUsd: period?.used,
      availableUsd: usd(payload.remaining),
      resetPeriod: period?.period,
      expiresAt: timestamp(payload.subscription.expires_at),
    })
  }

  if (payload.mode === 'unrestricted' && record(payload) && (payload.balance !== undefined || payload.remaining !== undefined)) {
    // The wallet has no cap of its own: what remains is all there is.
    return defined({
      ...common,
      mode: 'wallet',
      unlimitedQuota: false,
      availableUsd: usd(payload.balance ?? payload.remaining),
      usedUsd: common.spentUsd,
    })
  }
  return undefined
}

function statusMessage(status) {
  if (status === 401) return 'this API key was rejected (401)'
  if (status === 403) return 'the gateway refused this key (403)'
  if (status === 429) return 'the gateway is rate limiting balance reads (429)'
  return `the gateway answered HTTP ${status}`
}

/**
 * Cached, single-flight balance reader.
 *
 * A read that fails for one key keeps showing the last balance that key did
 * report, marked `stale` with when it was read and why this read failed,
 * instead of blanking the row. These last-good values live in the host
 * process: a page refresh keeps them, a restart does not.
 * @param options - key listing, the host pool, and transport knobs.
 * @returns `{ read({force, signal}), invalidate() }`.
 */
export function createBalanceReader({
  listKeys,
  hosts,
  fetchImpl = ambientFetch,
  now = Date.now,
  ttlMs = DEFAULT_BALANCE_TTL_MS,
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
} = {}) {
  if (typeof listKeys !== 'function') throw new Error('Geek2API balance reader requires listKeys')
  if (typeof hosts?.withFailover !== 'function') throw new Error('Geek2API balance reader requires a host pool')
  /** Last successful per-key usage, by key id. */
  const lastGood = new Map()

  const loadKey = async (entry, signal) => {
    const payload = await hosts.withFailover(async host => {
      const response = await boundedFetch(`${host}/v1/usage?lite=1`, {
        headers: { Authorization: `Bearer ${entry.key}`, Accept: 'application/json' },
      }, { fetchImpl, timeoutMs, signal })
      if (!response.ok) {
        let detail = ''
        try {
          const body = await response.json()
          detail = typeof body?.error?.message === 'string' ? body.error.message : typeof body?.message === 'string' ? body.message : ''
        } catch {
          // No readable body.
        }
        throw new Error(`${statusMessage(response.status)}${detail === '' ? '' : `: ${detail.slice(0, 200)}`}`)
      }
      return response.json()
    }, { signal })
    const usage = parseKeyUsage(payload)
    if (usage === undefined) throw new Error('the gateway returned an unrecognized usage payload')
    return usage
  }

  const load = async signal => {
    signal?.throwIfAborted()
    const keys = await listKeys()
    // A removed key's last balance must not resurface under a later key.
    for (const id of lastGood.keys()) {
      if (!keys.some(entry => entry.id === id)) lastGood.delete(id)
    }
    const entries = await Promise.all(keys.map(async entry => {
      const base = { id: entry.id, label: entry.label, disabled: entry.disabled === true }
      try {
        const usage = await loadKey(entry, signal)
        lastGood.set(entry.id, { usage, fetchedAt: now() })
        return { ...base, usage }
      } catch (error) {
        signal?.throwIfAborted()
        const message = error instanceof Error ? error.message : String(error)
        const previous = lastGood.get(entry.id)
        return previous === undefined
          ? { ...base, error: message }
          : { ...base, usage: previous.usage, stale: { fetchedAt: previous.fetchedAt, error: message } }
      }
    }))
    return { keys: entries, hosts: hosts.status(), fetchedAt: now() }
  }

  const cache = createCachedRead(load, { ttlMs, now })
  return Object.freeze({
    read: options => cache.read(options),
    invalidate: () => cache.invalidate(),
  })
}
