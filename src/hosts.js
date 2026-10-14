/**
 * Which Geek2API entry point a request goes to.
 *
 * Every entry point fronts the same gateway, so any of them can serve any
 * request. The pool keeps them ordered: hosts are ranked by their last
 * `/health` latency (configured order breaks ties and stands in before the
 * first probe), and a host that failed in transit is passed over for a
 * cooldown, so the next attempt — a harness retry for a model request, the
 * next iteration for a host-side read — goes to another one.
 *
 * Only transport failures move a host aside. An HTTP answer, whatever its
 * status, proves the host is reachable; what it says is the gateway's
 * business, and every host would say the same.
 *
 * @module dsh-geek2api/hosts
 */

import {
  DEFAULT_API_HOSTS,
  HOST_COOLDOWN_MS,
  HOST_PROBE_INTERVAL_MS,
  HOST_PROBE_TIMEOUT_MS,
} from './constants.js'
import { ambientFetch, boundedFetch, TransportError } from './request.js'

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]'])

/**
 * Accept an https origin, keeping only the origin: a pasted `/v1` (the base
 * URL OpenAI clients use) would otherwise double every path. Plain http is
 * refused outside loopback, because the key travels in a header.
 */
export function normalizeHost(value, fallback) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (text === '') return fallback
  let url
  try {
    url = new URL(text)
  } catch {
    return fallback
  }
  if (url.protocol === 'https:') return url.origin
  if (url.protocol === 'http:' && LOOPBACK.has(url.hostname)) return url.origin
  return fallback
}

/**
 * Normalize a host list: valid origins only, no duplicates, configured order
 * kept. An empty or unusable list means "the defaults".
 * @param value - an array of hosts, or a newline/comma separated string.
 * @returns at least one host.
 */
export function normalizeHostList(value) {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[\s,，]+/u) : []
  const hosts = [...new Set(raw.map(item => normalizeHost(item, undefined)).filter(host => host !== undefined))]
  return hosts.length === 0 ? [...DEFAULT_API_HOSTS] : hosts
}

/**
 * Whether a failure means the host never answered. A timeout is not: the
 * host accepted the connection and the gateway behind it is slow, which every
 * host would be. Text that carries an HTTP status is the gateway's answer,
 * whatever words it uses.
 */
export function isTransportFailure(error) {
  if (error instanceof TransportError) return error.aborted !== true && error.timedOut !== true
  const text = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  if (/^\s*\d{3}\b|\(\d{3}\)|status code \d{3}|HTTP \d{3}/u.test(text)) return false
  return /fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|UND_ERR_|socket hang up|network error|other side closed|certificate|TLS|connect timeout|Connection error|ConnectTimeout|getaddrinfo/iu.test(text)
}

/**
 * The host pool.
 * @param options - the configured host list, transport knobs, and a logger.
 * @returns `{ current, order, fail, succeed, probe, status, withFailover }`.
 */
export function createHostPool({
  listHosts = () => DEFAULT_API_HOSTS,
  fetchImpl = ambientFetch,
  now = Date.now,
  cooldownMs = HOST_COOLDOWN_MS,
  probeIntervalMs = HOST_PROBE_INTERVAL_MS,
  probeTimeoutMs = HOST_PROBE_TIMEOUT_MS,
  logger,
} = {}) {
  /** host → epoch ms until which it is passed over. */
  const cooling = new Map()
  /** host → last `/health` round trip in ms; absent means unreachable or unprobed. */
  const latency = new Map()
  let probedAt = 0
  let probing

  const configured = () => normalizeHostList(listHosts())

  const isCooling = host => (cooling.get(host) ?? 0) > now()

  /**
   * Every configured host, best first: reachable before cooling, then by
   * probed latency, then in configured order. A probed-unreachable host sorts
   * after the probed-reachable ones but before cooling hosts.
   */
  const order = () => {
    const hosts = configured()
    const rank = host => {
      if (isCooling(host)) return 3
      if (probedAt === 0) return 0
      return latency.has(host) ? 1 : 2
    }
    return hosts
      .map((host, index) => ({ host, index }))
      .sort((a, b) => rank(a.host) - rank(b.host)
        || (latency.get(a.host) ?? Infinity) - (latency.get(b.host) ?? Infinity)
        || a.index - b.index)
      .map(item => item.host)
  }

  const probeOne = async host => {
    const started = now()
    try {
      const response = await boundedFetch(`${host}/health`, { headers: { Accept: 'application/json' } }, { fetchImpl, timeoutMs: probeTimeoutMs })
      // Any HTTP answer means the host is up; only a 5xx from the edge says otherwise.
      if (response.status >= 500) throw new Error(`HTTP ${response.status}`)
      latency.set(host, Math.max(0, now() - started))
      cooling.delete(host)
    } catch {
      latency.delete(host)
    }
  }

  /**
   * Re-rank the hosts by `/health` latency. Single-flight; a recent ranking is
   * kept unless forced.
   */
  const probe = async ({ force = false } = {}) => {
    if (!force && probedAt !== 0 && now() - probedAt < probeIntervalMs) return
    if (probing !== undefined) return probing
    probing = (async () => {
      const hosts = configured()
      for (const host of [...latency.keys()]) if (!hosts.includes(host)) latency.delete(host)
      await Promise.all(hosts.map(probeOne))
      probedAt = now()
    })().finally(() => {
      probing = undefined
    })
    return probing
  }

  /** Refresh the ranking in the background when it is due; never blocks a request. */
  const maybeProbe = () => {
    if (probedAt !== 0 && now() - probedAt < probeIntervalMs) return
    void probe().catch(() => undefined)
  }

  const fail = (host, reason) => {
    if (typeof host !== 'string' || !configured().includes(host)) return
    cooling.set(host, now() + cooldownMs)
    latency.delete(host)
    logger?.warn?.('geek2api: host %s failed in transit (%s); the next host serves the retry', host, reason ?? 'transport')
  }

  const succeed = host => {
    if (typeof host === 'string') cooling.delete(host)
  }

  const current = () => {
    maybeProbe()
    return order()[0]
  }

  /**
   * Run a host-side request against the hosts in order until one answers.
   * Only transport failures move on; any other error is the answer.
   * @param task - `(host) => Promise<value>`.
   * @param options - the caller's signal.
   * @returns the first answer.
   */
  const withFailover = async (task, { signal } = {}) => {
    maybeProbe()
    const tried = []
    for (const host of order()) {
      signal?.throwIfAborted()
      try {
        const value = await task(host)
        succeed(host)
        return value
      } catch (error) {
        signal?.throwIfAborted()
        if (!isTransportFailure(error)) throw error
        fail(host, error instanceof Error ? error.message : String(error))
        tried.push(`${host}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    throw new Error(`no Geek2API host answered (${tried.join('; ')})`)
  }

  /** What the settings panel shows: each host, its latency, and whether it is set aside. */
  const status = () => {
    const best = order()[0]
    return configured().map(host => ({
      host,
      current: host === best,
      probed: probedAt !== 0,
      ...(latency.has(host) ? { latencyMs: latency.get(host) } : {}),
      ...(isCooling(host) ? { coolingUntil: cooling.get(host) } : {}),
    }))
  }

  return Object.freeze({ current, order, fail, succeed, probe, status, withFailover, hosts: configured })
}
