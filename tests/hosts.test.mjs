import assert from 'node:assert/strict'
import test from 'node:test'

import { DEFAULT_API_HOSTS } from '../src/constants.js'
import { createHostPool, isTransportFailure, normalizeHost, normalizeHostList } from '../src/hosts.js'
import { TransportError } from '../src/request.js'

const HOSTS = ['https://a.example', 'https://b.example', 'https://c.example']

/** A /health fetch with a scripted latency (ms) or failure per host. */
function healthFetch(plan, clock) {
  const calls = []
  const fetchImpl = async url => {
    const host = new URL(url).origin
    calls.push(url)
    const step = plan[host]
    if (step === 'down') throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })
    if (step === 502) return { ok: false, status: 502 }
    clock.t += step ?? 0
    return { ok: true, status: 200 }
  }
  return { fetchImpl, calls }
}

const transport = () => new TransportError(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }), { aborted: false, timedOut: false, timeoutMs: 1000 })

test('normalizes host lists, keeping order and falling back to the defaults', () => {
  assert.equal(normalizeHost(' https://x.example/ ', 'f'), 'https://x.example')
  assert.equal(normalizeHost('ftp://x.example', 'f'), 'f')
  assert.deepEqual(normalizeHostList(['https://b.example/', 'nonsense', 'https://a.example', 'https://b.example']), ['https://b.example', 'https://a.example'])
  assert.deepEqual(normalizeHostList('https://a.example\nhttps://b.example, https://c.example'), HOSTS)
  assert.deepEqual(normalizeHostList([]), [...DEFAULT_API_HOSTS])
  assert.deepEqual(normalizeHostList(undefined), [...DEFAULT_API_HOSTS])
})

test('the defaults are Geek2API entry points only', () => {
  assert.ok(DEFAULT_API_HOSTS.length >= 2)
  for (const host of DEFAULT_API_HOSTS) assert.match(host, /^https:\/\/[a-z0-9]+\.geek2api\.com$/u)
})

test('only failures that never reached the host count as transport failures', () => {
  assert.equal(isTransportFailure(transport()), true)
  assert.equal(isTransportFailure(new TransportError(new Error('x'), { aborted: true, timedOut: false, timeoutMs: 1 })), false, 'the caller cancelling is not the host failing')
  assert.equal(isTransportFailure(new Error('fetch failed')), true)
  assert.equal(isTransportFailure('Connection error.'), true)
  assert.equal(isTransportFailure(new Error('this API key was rejected (401)')), false)
  assert.equal(isTransportFailure(new Error('400 Model is not available')), false)
})

test('before any probe the configured order stands', () => {
  const pool = createHostPool({ listHosts: () => HOSTS, fetchImpl: async () => { throw new Error('no probe expected') }, probeIntervalMs: 1e12 })
  assert.deepEqual(pool.order(), HOSTS)
})

test('a probe ranks reachable hosts by latency, unreachable ones after them', async () => {
  const clock = { t: 0 }
  const { fetchImpl } = healthFetch({ 'https://a.example': 'down', 'https://b.example': 90, 'https://c.example': 20 }, clock)
  // Each probe measures its own round trip on the shared clock.
  const pool = createHostPool({ listHosts: () => HOSTS, fetchImpl, now: () => clock.t })
  await pool.probe({ force: true })
  const order = pool.order()
  assert.equal(order.at(-1), 'https://a.example')
  assert.deepEqual(new Set(order.slice(0, 2)), new Set(['https://b.example', 'https://c.example']))
  const status = pool.status()
  assert.equal(status.find(entry => entry.host === 'https://a.example').latencyMs, undefined)
  assert.equal(status.filter(entry => entry.current).length, 1)
})

test('a 5xx from the edge counts as down; any other answer as up', async () => {
  const clock = { t: 0 }
  const { fetchImpl } = healthFetch({ 'https://a.example': 502, 'https://b.example': 5, 'https://c.example': 5 }, clock)
  const pool = createHostPool({ listHosts: () => HOSTS, fetchImpl, now: () => clock.t })
  await pool.probe({ force: true })
  assert.equal(pool.order().at(-1), 'https://a.example')
})

test('probes are single-flight and skipped while the ranking is fresh', async () => {
  let calls = 0
  let release
  const gate = new Promise(resolve => { release = resolve })
  const fetchImpl = async () => {
    calls += 1
    await gate
    return { ok: true, status: 200 }
  }
  let clock = 1
  const pool = createHostPool({ listHosts: () => HOSTS, fetchImpl, now: () => clock, probeIntervalMs: 1000 })
  const first = pool.probe()
  const second = pool.probe()
  release()
  await Promise.all([first, second])
  assert.equal(calls, HOSTS.length, 'one probe of each host')
  await pool.probe()
  assert.equal(calls, HOSTS.length, 'fresh ranking is kept')
  clock = 5000
  await pool.probe()
  assert.equal(calls, HOSTS.length * 2)
  await pool.probe({ force: true })
  assert.equal(calls, HOSTS.length * 3)
})

test('a failed host cools down at the back of the order, then returns', () => {
  let clock = 0
  const pool = createHostPool({ listHosts: () => HOSTS, fetchImpl: async () => ({ ok: true, status: 200 }), now: () => clock, cooldownMs: 1000, probeIntervalMs: 1e12 })
  pool.fail('https://a.example', 'reset')
  assert.deepEqual(pool.order(), ['https://b.example', 'https://c.example', 'https://a.example'])
  assert.ok(pool.status().find(entry => entry.host === 'https://a.example').coolingUntil > 0)
  clock = 1001
  assert.equal(pool.order()[0], 'https://a.example')
  pool.fail('https://unknown.example')
  assert.deepEqual(pool.order(), HOSTS, 'a host outside the list is ignored')
})

test('withFailover moves on only after transport failures', async () => {
  const pool = createHostPool({ listHosts: () => HOSTS, fetchImpl: async () => ({ ok: true, status: 200 }), now: () => 1, probeIntervalMs: 1e12 })
  // A ranking exists, so no background probe races the failover below.
  await pool.probe()
  const tried = []
  const value = await pool.withFailover(async host => {
    tried.push(host)
    if (host === 'https://a.example') throw transport()
    return `answered by ${host}`
  })
  assert.equal(value, 'answered by https://b.example')
  assert.deepEqual(tried, ['https://a.example', 'https://b.example'])
  assert.equal(pool.order()[0], 'https://b.example', 'the failing host is now behind')

  // An answer from the gateway, however unwelcome, is the answer.
  const refused = []
  await assert.rejects(pool.withFailover(async host => {
    refused.push(host)
    throw new Error('this API key was rejected (401)')
  }), /rejected \(401\)/u)
  assert.equal(refused.length, 1)

  await assert.rejects(pool.withFailover(async () => { throw transport() }), /no Geek2API host answered/u)
})

test('withFailover honours cancellation', async () => {
  const pool = createHostPool({ listHosts: () => HOSTS, fetchImpl: async () => ({ ok: true, status: 200 }), probeIntervalMs: 1e12 })
  const controller = new AbortController()
  controller.abort(new Error('stop'))
  await assert.rejects(pool.withFailover(async () => 'x', { signal: controller.signal }), /stop/u)
})

test('the host list is read per call, so a settings change applies at once', () => {
  let list = HOSTS
  const pool = createHostPool({ listHosts: () => list, fetchImpl: async () => ({ ok: true, status: 200 }), probeIntervalMs: 1e12 })
  assert.equal(pool.current(), 'https://a.example')
  list = ['https://z.example']
  assert.equal(pool.current(), 'https://z.example')
  assert.deepEqual(pool.hosts(), ['https://z.example'])
})
