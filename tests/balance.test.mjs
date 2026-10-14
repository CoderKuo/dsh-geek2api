import assert from 'node:assert/strict'
import test from 'node:test'

import { createBalanceReader, parseKeyUsage } from '../src/balance.js'
import { fixedHostPool } from './helpers.mjs'

/** The wallet shape sub2api's `/v1/usage` answers for a balance-mode key. */
const WALLET_USAGE = {
  mode: 'unrestricted',
  isValid: true,
  planName: '钱包余额',
  remaining: 42.5,
  unit: 'USD',
  balance: 42.5,
  usage: {
    today: { requests: 3, actual_cost: 0.12 },
    total: { requests: 90, actual_cost: 17.25 },
  },
}

test('parses the wallet shape: the shared balance, with lifetime and today spend', () => {
  const usage = parseKeyUsage(WALLET_USAGE)
  assert.equal(usage.mode, 'wallet')
  assert.equal(usage.unlimitedQuota, false)
  assert.equal(usage.availableUsd, 42.5)
  assert.equal(usage.usedUsd, 17.25)
  assert.equal(usage.todayUsd, 0.12)
  assert.equal(usage.todayRequests, 3)
  assert.equal(usage.planName, '钱包余额')
  assert.equal('limitUsd' in usage, false)
})

test('parses the subscription shape, limited by its tightest period', () => {
  const usage = parseKeyUsage({
    mode: 'unrestricted',
    isValid: true,
    planName: 'Plus（GPT）',
    remaining: 3,
    subscription: {
      daily_usage_usd: 7,
      daily_limit_usd: 10,
      weekly_usage_usd: 20,
      weekly_limit_usd: 50,
      monthly_usage_usd: 20,
      monthly_limit_usd: null,
      expires_at: '2026-11-01T00:00:00Z',
    },
  })
  assert.equal(usage.mode, 'subscription')
  assert.equal(usage.planName, 'Plus（GPT）')
  assert.equal(usage.resetPeriod, 'daily')
  assert.equal(usage.limitUsd, 10)
  assert.equal(usage.usedUsd, 7)
  assert.equal(usage.availableUsd, 3)
  assert.equal(usage.expiresAt, Date.parse('2026-11-01T00:00:00Z'))
  assert.equal(usage.unlimitedQuota, false)

  const unlimited = parseKeyUsage({ mode: 'unrestricted', remaining: 0, subscription: {} })
  assert.equal(unlimited.unlimitedQuota, true)
})

test('parses the key-quota shape with its rate windows and expiry', () => {
  const usage = parseKeyUsage({
    mode: 'quota_limited',
    isValid: true,
    status: 'active',
    quota: { limit: 500, used: 125.5, remaining: 374.5, unit: 'USD' },
    remaining: 374.5,
    rate_limits: [{ window: '5h', limit: 20, used: 5, remaining: 15, reset_at: '2026-10-14T12:00:00Z' }],
    expires_at: '2027-01-01T00:00:00Z',
  })
  assert.equal(usage.mode, 'quota')
  assert.equal(usage.limitUsd, 500)
  assert.equal(usage.usedUsd, 125.5)
  assert.equal(usage.availableUsd, 374.5)
  assert.equal('status' in usage, false, 'an active status is not worth reporting')
  assert.deepEqual(usage.rateLimits, [{ window: '5h', limitUsd: 20, usedUsd: 5, remainingUsd: 15, resetAt: Date.parse('2026-10-14T12:00:00Z') }])
  assert.equal(usage.expiresAt, Date.parse('2027-01-01T00:00:00Z'))

  const exhausted = parseKeyUsage({ mode: 'quota_limited', isValid: true, status: 'quota_exhausted' })
  assert.equal(exhausted.status, 'quota_exhausted')
  assert.equal(exhausted.unlimitedQuota, true, 'a rate-limit-only key has no total cap')
})

test('an unknown shape is unrecognized', () => {
  assert.equal(parseKeyUsage({ nothing: true }), undefined)
  assert.equal(parseKeyUsage(null), undefined)
  assert.equal(parseKeyUsage({ mode: 'unrestricted' }), undefined)
})

test('carries the account reference and key name when the gateway reports them', () => {
  const usage = parseKeyUsage({ ...WALLET_USAGE, account_ref: 'acct-7', key: { name: 'laptop' } })
  assert.equal(usage.accountRef, 'acct-7')
  assert.equal(usage.keyName, 'laptop')
})

function jsonResponse(payload, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload }
}

function routedFetch(routes) {
  const calls = []
  const fetchImpl = async (url, options) => {
    calls.push(url)
    const route = routes.find(candidate => url.startsWith(candidate.prefix))
    if (route === undefined) throw new Error(`unrouted ${url}`)
    if (typeof route.reply === 'function') return route.reply(url, options)
    return jsonResponse(route.reply, route.status ?? 200)
  }
  return { fetchImpl, calls }
}

const KEYS = [{ id: 'a', label: 'primary', key: 'sk-aaaaaaaaaaaaaaaa', disabled: false }]

test('reads each key from /v1/usage on the preferred host with its own bearer token', async () => {
  const seen = []
  const { fetchImpl, calls } = routedFetch([{
    prefix: 'https://h1.example/v1/usage',
    reply: (_url, options) => {
      seen.push(options.headers.Authorization)
      assert.equal(options.redirect, 'error')
      return jsonResponse(WALLET_USAGE)
    },
  }])
  const reader = createBalanceReader({ listKeys: async () => KEYS, hosts: await fixedHostPool(), fetchImpl })
  const value = await reader.read()
  assert.equal(value.keys[0].usage.availableUsd, 42.5)
  assert.deepEqual(calls, ['https://h1.example/v1/usage?lite=1'])
  assert.deepEqual(seen, ['Bearer sk-aaaaaaaaaaaaaaaa'])
  assert.ok(Array.isArray(value.hosts))
})

test('a host that never answers is set aside and the next host serves the read', async () => {
  const dnsFailure = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('getaddrinfo ENOTFOUND h1.example'), { code: 'ENOTFOUND' }) })
  const { fetchImpl, calls } = routedFetch([
    { prefix: 'https://h1.example/', reply: () => { throw dnsFailure } },
    { prefix: 'https://h2.example/v1/usage', reply: WALLET_USAGE },
  ])
  const hosts = await fixedHostPool()
  const reader = createBalanceReader({ listKeys: async () => KEYS, hosts, fetchImpl })
  assert.equal((await reader.read()).keys[0].usage.availableUsd, 42.5)
  assert.deepEqual(calls, ['https://h1.example/v1/usage?lite=1', 'https://h2.example/v1/usage?lite=1'])
  assert.equal(hosts.order()[0], 'https://h2.example')
})

test('a rejected key reports its own error, with the gateway message, without failing the read', async () => {
  const keys = [...KEYS, { id: 'b', label: 'second', key: 'sk-bbbbbbbbbbbbbbbb', disabled: false }]
  const { fetchImpl, calls } = routedFetch([{
    prefix: 'https://h1.example/v1/usage',
    reply: (_url, options) => (String(options.headers.Authorization).includes('sk-a')
      ? jsonResponse({ error: { message: 'Invalid API key' } }, 401)
      : jsonResponse({ error: { message: 'API Key 所属分组已删除' } }, 403)),
  }])
  const reader = createBalanceReader({ listKeys: async () => keys, hosts: await fixedHostPool(), fetchImpl })
  const value = await reader.read()
  assert.equal(value.keys[0].usage, undefined)
  assert.match(value.keys[0].error, /rejected \(401\): Invalid API key/u)
  assert.match(value.keys[1].error, /refused this key \(403\): API Key 所属分组已删除/u)
  assert.equal(calls.length, 2, 'an HTTP refusal is an answer, not a reason to try another host')
})

test('an unrecognized payload is reported per key', async () => {
  const { fetchImpl } = routedFetch([{ prefix: 'https://h1.example/v1/usage', reply: { hello: 1 } }])
  const reader = createBalanceReader({ listKeys: async () => KEYS, hosts: await fixedHostPool(), fetchImpl })
  assert.match((await reader.read()).keys[0].error, /unrecognized usage payload/u)
})

test('a read without keys returns an empty list', async () => {
  const reader = createBalanceReader({ listKeys: async () => [], hosts: await fixedHostPool(), fetchImpl: routedFetch([]).fetchImpl })
  assert.deepEqual((await reader.read()).keys, [])
})

test('caches a read, shares one in flight, and forgets on invalidate', async () => {
  let calls = 0
  const { fetchImpl } = routedFetch([{
    prefix: 'https://h1.example/v1/usage',
    reply: () => {
      calls += 1
      return jsonResponse(WALLET_USAGE)
    },
  }])
  const reader = createBalanceReader({ listKeys: async () => KEYS, hosts: await fixedHostPool(), fetchImpl, now: () => 1000 })
  const [first, second] = await Promise.all([reader.read(), reader.read()])
  assert.equal(calls, 1)
  assert.equal(first.fetchedAt, second.fetchedAt)
  await reader.read()
  assert.equal(calls, 1)
  reader.invalidate()
  await reader.read()
  assert.equal(calls, 2)
})

test('a failed read keeps the last balance each key reported, marked stale', async () => {
  let up = true
  let clock = 1_000
  const { fetchImpl } = routedFetch([{
    prefix: 'https://h',
    reply: () => (up ? jsonResponse(WALLET_USAGE) : jsonResponse({ error: 'busy' }, 429)),
  }])
  let keys = KEYS
  const reader = createBalanceReader({ listKeys: async () => keys, hosts: await fixedHostPool(), fetchImpl, now: () => clock })
  const first = await reader.read()
  assert.equal(first.keys[0].stale, undefined)

  up = false
  clock = 99_000
  const second = await reader.read({ force: true })
  assert.equal(second.keys[0].usage.availableUsd, 42.5, 'the last good balance stays visible')
  assert.equal(second.keys[0].stale.fetchedAt, 1_000)
  assert.match(second.keys[0].stale.error, /429/u)
  assert.equal(second.keys[0].error, undefined)

  // A key that is no longer stored takes its last balance with it.
  keys = [{ id: 'b', label: 'other', key: 'sk-bbbbbbbbbbbbbbbb', disabled: false }]
  const third = await reader.read({ force: true })
  assert.equal(third.keys[0].usage, undefined)
  assert.equal(third.keys[0].stale, undefined)
  assert.ok(third.keys[0].error)
})

test('requires a key listing and a host pool', () => {
  assert.throws(() => createBalanceReader({ hosts: {} }), /listKeys/u)
  assert.throws(() => createBalanceReader({ listKeys: async () => [] }), /host pool/u)
})
