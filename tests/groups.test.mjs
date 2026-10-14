import assert from 'node:assert/strict'
import test from 'node:test'

import { GEEK2API_MODEL_IDS } from '../src/catalog.js'
import { catalogCoverage, createGroupReader, parseKeyGroups, pickKeyForModel } from '../src/groups.js'
import { fixedHostPool } from './helpers.mjs'

test('the key groups are read from /v1/usage when the gateway names them', () => {
  assert.deepEqual(parseKeyGroups({ key: { groups: [{ name: '稳定Claude', platform: 'anthropic' }, { name: 'CodeX' }] } }), ['稳定Claude', 'CodeX'])
  assert.deepEqual(parseKeyGroups({ key: { groups: ['a', 'a', '  b  '] } }), ['a', 'b'])
  assert.deepEqual(parseKeyGroups({ key: { group: { name: 'Gemini' } } }), ['Gemini'])
  assert.deepEqual(parseKeyGroups({ key: { group: 'Grok' } }), ['Grok'])
  assert.equal(parseKeyGroups({ mode: 'unrestricted' }), undefined)
  assert.equal(parseKeyGroups({ key: { groups: [] } }), undefined)
})

test('coverage is the model list itself, and unknown without one', () => {
  const coverage = catalogCoverage(new Set(['claude-opus-5-5', 'gpt-4o']))
  assert.equal(coverage['claude-opus-5-5'], true)
  assert.equal(coverage['gpt-6.1-sol'], false)
  assert.deepEqual(Object.keys(coverage), [...GEEK2API_MODEL_IDS])
  assert.deepEqual(catalogCoverage(undefined), {})
})

function jsonResponse(payload, status = 200) {
  const body = JSON.stringify(payload)
  return { ok: status >= 200 && status < 300, status, json: async () => JSON.parse(body), text: async () => body }
}

const MODELS = { 'sk-claude': ['claude-opus-5-5', 'claude-haiku-4-5-20251001', 'claude-3-old'], 'sk-gpt': ['gpt-6.1-sol', 'gpt-6-astra'] }

function gateway({ usage = {}, models = MODELS, refuse = {} } = {}) {
  const calls = []
  const fetchImpl = async (url, options) => {
    const key = String(options.headers.Authorization).replace('Bearer ', '')
    calls.push({ url, key })
    assert.equal(options.redirect, 'error')
    if (refuse[key] !== undefined) return jsonResponse({ error: { message: refuse[key].message } }, refuse[key].status)
    if (url.endsWith('/v1/models')) return jsonResponse({ object: 'list', data: (models[key] ?? []).map(id => ({ id, type: 'model' })) })
    if (url.endsWith('/v1/usage?lite=1')) return jsonResponse({ mode: 'unrestricted', balance: 1, ...(usage[key] ?? {}) })
    throw new Error(`unrouted ${url}`)
  }
  return { fetchImpl, calls }
}

const KEYS = [
  { id: 'c', label: 'claude', key: 'sk-claude', disabled: false },
  { id: 'g', label: 'gpt', key: 'sk-gpt', disabled: false },
]

test('each key reports its reachable catalog models and groups, with no key material', async () => {
  const { fetchImpl, calls } = gateway({ usage: { 'sk-claude': { key: { groups: [{ name: '稳定Claude' }] } } } })
  const reader = createGroupReader({ listKeys: async () => KEYS, hosts: await fixedHostPool(), fetchImpl })
  const value = await reader.read()
  assert.equal(value.keys[0].coverage['claude-opus-5-5'], true)
  assert.equal(value.keys[0].coverage['gpt-6.1-sol'], false)
  assert.deepEqual(value.keys[0].groups, ['稳定Claude'])
  assert.equal(value.keys[0].extraModels, 1)
  assert.equal(value.keys[1].groups, undefined)
  assert.equal(value.keys[1].coverage['gpt-6-astra'], true)
  assert.doesNotMatch(JSON.stringify(value), /sk-/u)
  assert.ok(calls.every(call => call.url.startsWith('https://h1.example/')))

  assert.equal(reader.covers('c', 'claude-opus-5-5'), true)
  assert.equal(reader.covers('c', 'gpt-6.1-sol'), false)
  assert.equal(reader.covers('nobody', 'gpt-6.1-sol'), undefined)
  assert.deepEqual(reader.groupsOf('c'), ['稳定Claude'])
  assert.equal(reader.requiredGroups('claude-opus-5-5'), undefined)
  assert.equal(reader.hasReading(), true)
})

test('a key the gateway rejects (401, or a deleted group) reaches nothing', async () => {
  const { fetchImpl } = gateway({
    refuse: {
      'sk-claude': { status: 401, message: 'Invalid API key' },
      'sk-gpt': { status: 403, message: 'API Key 所属分组已删除' },
    },
  })
  const reader = createGroupReader({ listKeys: async () => KEYS, hosts: await fixedHostPool(), fetchImpl })
  const value = await reader.read()
  for (const entry of value.keys) {
    assert.equal(entry.rejected, true)
    assert.ok(Object.values(entry.coverage).every(reach => reach === false))
  }
})

test('another refusal of the model list is a failed read, not evidence', async () => {
  const { fetchImpl } = gateway({ refuse: { 'sk-gpt': { status: 403, message: '余额不足，请充值' } } })
  const reader = createGroupReader({ listKeys: async () => KEYS, hosts: await fixedHostPool(), fetchImpl })
  const value = await reader.read()
  assert.equal(value.keys[1].rejected, undefined)
  assert.deepEqual(value.keys[1].coverage, {})
  assert.match(value.keys[1].error, /HTTP 403 for the model list: 余额不足/u)
  assert.equal(reader.covers('g', 'gpt-6.1-sol'), undefined)
})

test('a failed read keeps the last good reading, marked stale; the groups are optional', async () => {
  let down = false
  let usageDown = false
  const inner = gateway()
  const fetchImpl = async (url, options) => {
    if (down) return jsonResponse({ error: { message: 'busy' } }, 503)
    if (usageDown && url.includes('/v1/usage')) return jsonResponse({ error: { message: 'busy' } }, 503)
    return inner.fetchImpl(url, options)
  }
  let clock = 1
  const reader = createGroupReader({ listKeys: async () => KEYS, hosts: await fixedHostPool(), fetchImpl, now: () => clock })
  usageDown = true
  const first = await reader.read()
  assert.equal(first.keys[0].coverage['claude-opus-5-5'], true, 'the model list alone is enough')
  assert.equal(first.keys[0].groups, undefined)

  down = true
  clock = 5
  const second = await reader.read({ force: true })
  assert.equal(second.keys[0].coverage['claude-opus-5-5'], true)
  assert.equal(second.keys[0].stale.fetchedAt, 1)
  assert.match(second.keys[0].stale.error, /503/u)
})

test('requires a key listing and a host pool', () => {
  assert.throws(() => createGroupReader({ hosts: {} }), /listKeys/u)
  assert.throws(() => createGroupReader({ listKeys: async () => [] }), /host pool/u)
})

test('a key is passed over only on evidence, and the active pointer is never moved', () => {
  const usable = [
    { id: 'a', label: 'A', key: 'ka' },
    { id: 'b', label: 'B', key: 'kb' },
    { id: 'c', label: 'C', key: 'kc' },
  ]
  const evidence = { 'a:claude': false, 'b:claude': undefined, 'c:claude': true, 'a:gpt': true }
  const covers = (id, model) => evidence[`${id}:${model}`]
  // The active key serves what it is not known to be excluded from.
  assert.deepEqual(pickKeyForModel('gpt', usable[0], usable, covers), usable[0])
  assert.deepEqual(pickKeyForModel('unknown', usable[0], usable, covers), usable[0])
  // Known excluded: the next key that surely can, ahead of one that may.
  assert.deepEqual(pickKeyForModel('claude', usable[0], usable, covers), { id: 'c', label: 'C', key: 'kc', switchedFrom: { id: 'a', label: 'A' } })
  // With no sure key, one with no evidence either way.
  evidence['c:claude'] = false
  assert.equal(pickKeyForModel('claude', usable[0], usable, covers).id, 'b')
  // With nothing better, the active key, marked uncovered.
  evidence['b:claude'] = false
  assert.deepEqual(pickKeyForModel('claude', usable[0], usable, covers), { ...usable[0], uncovered: true })
  // Ring order starts after the active key.
  evidence['a:claude'] = true
  evidence['c:claude'] = true
  assert.equal(pickKeyForModel('claude', usable[1], usable, covers).id, 'c')
  assert.equal(pickKeyForModel('claude', undefined, usable, covers), undefined)
})
