import assert from 'node:assert/strict'
import test from 'node:test'

import { parseKeyUsage } from '../src/balance.js'
import { isTransportFailure, normalizeHost, normalizeHostList } from '../src/hosts.js'
import { createKeyChooser } from '../src/key-chooser.js'
import { Geek2APIKeyRing } from '../src/key-ring.js'
import { TransportError } from '../src/request.js'

function fakeCredentials() {
  let record
  let chain = Promise.resolve()
  return {
    async readRecord() {
      return record
    },
    modifyRecord(_key, mutate) {
      const run = chain.then(async () => {
        const next = await mutate(record)
        if (next !== undefined) record = next
        return record
      })
      chain = run.then(() => undefined, () => undefined)
      return run
    },
  }
}

const NO_GROUPS = Object.freeze({
  read: async () => ({ keys: [] }),
  hasReading: () => true,
  covers: () => undefined,
  groupsOf: () => undefined,
  requiredGroups: () => undefined,
})

async function chooserWith(clock) {
  const ring = new Geek2APIKeyRing(fakeCredentials())
  await ring.add('sk-first-0000000000000000', 'first')
  await ring.add('sk-second-000000000000000', 'second')
  const keys = createKeyChooser({ ring, groups: NO_GROUPS, now: () => clock.now, skipMs: 1_000 })
  return { ring, keys }
}

test('an empty wallet skips the key for a while and never disables it', async () => {
  const clock = { now: 10_000 }
  const { ring, keys } = await chooserWith(clock)
  const first = await keys.active()
  assert.equal(first.label, 'first')

  keys.onKeyFailure('exhausted', '余额不足，请充值', first.key)
  assert.equal((await keys.active()).label, 'second', 'the next key serves the retry')
  const state = await ring.list()
  assert.equal(state.keys.every(entry => entry.disabled !== true), true, 'nothing was disabled')
  assert.deepEqual(Object.keys(keys.skipped()), [first.id])

  clock.now += 1_001
  assert.equal((await keys.active()).label, 'first', 'the skip ends by itself')
})

test('with every key out of money the active key still answers, so the failure speaks', async () => {
  const clock = { now: 10_000 }
  const { keys } = await chooserWith(clock)
  const first = await keys.active()
  keys.onKeyFailure('exhausted', 'x', first.key)
  const second = await keys.active()
  keys.onKeyFailure('exhausted', 'x', second.key)
  assert.equal((await keys.active()).label, 'first')
})

test('a balance read showing money brings a skipped key back at once', async () => {
  const clock = { now: 10_000 }
  const { keys } = await chooserWith(clock)
  const first = await keys.active()
  keys.onKeyFailure('exhausted', 'x', first.key)
  keys.noteBalances([{ id: first.id, usage: { availableUsd: 0 } }])
  assert.equal((await keys.active()).label, 'second', 'still empty: still skipped')
  keys.noteBalances([{ id: first.id, usage: { availableUsd: 12 }, stale: { fetchedAt: 1 } }])
  assert.equal((await keys.active()).label, 'second', 'a stale reading is no evidence')
  keys.noteBalances([{ id: first.id, usage: { availableUsd: 12 } }])
  assert.equal((await keys.active()).label, 'first')
})

test('a used-up key cap or a rejected key is still disabled', async () => {
  const clock = { now: 10_000 }
  const { ring, keys } = await chooserWith(clock)
  const first = await keys.active()
  keys.onKeyFailure('quota', 'API key 额度已用完', first.key)
  await new Promise(resolve => { setTimeout(resolve, 10) })
  assert.equal((await ring.list()).keys.find(entry => entry.id === first.id).disabled, true)
})

test('hosts keep only an https origin; plain http only on loopback', () => {
  assert.equal(normalizeHost('https://hk.geek2api.com/v1', undefined), 'https://hk.geek2api.com')
  assert.equal(normalizeHost('https://hk.geek2api.com/v1/', undefined), 'https://hk.geek2api.com')
  assert.equal(normalizeHost('http://hk.geek2api.com', undefined), undefined)
  assert.equal(normalizeHost('http://127.0.0.1:8080/x', undefined), 'http://127.0.0.1:8080')
  assert.equal(normalizeHost('http://localhost:3000', undefined), 'http://localhost:3000')
  assert.deepEqual(normalizeHostList(['https://a.example/v1', 'https://a.example', 'http://evil.example']), ['https://a.example'])
})

test('a timeout or an HTTP answer does not set a host aside', () => {
  const timedOut = new TransportError(new Error('aborted'), { aborted: false, timedOut: true, timeoutMs: 1000 })
  assert.equal(isTransportFailure(timedOut), false)
  assert.equal(isTransportFailure('OpenAI API error (502): TLS handshake timeout'), false)
  assert.equal(isTransportFailure('502 Bad Gateway: certificate error upstream'), false)
  assert.equal(isTransportFailure('fetch failed'), true)
  assert.equal(isTransportFailure('Connection error.'), true)
})

test('an inactive subscription is shown as such, not as an unrecognized payload', () => {
  const usage = parseKeyUsage({ mode: 'unrestricted', isValid: true, planName: 'Plus', unit: 'USD', key: { name: 'k' } })
  assert.equal(usage.mode, 'subscription')
  assert.equal(usage.inactive, true)
  assert.equal(usage.availableUsd, 0)
  assert.equal(usage.planName, 'Plus')
})

test('a key with only rate windows is not called unlimited', () => {
  const usage = parseKeyUsage({ mode: 'quota_limited', isValid: true, status: 'active', rate_limits: [{ window: '5h', limit: 5, used: 1, remaining: 4 }] })
  assert.equal(usage.unlimitedQuota, false)
  assert.equal(usage.availableUsd, undefined)
  assert.deepEqual(usage.rateLimits, [{ window: '5h', limitUsd: 5, usedUsd: 1, remainingUsd: 4 }])
})
