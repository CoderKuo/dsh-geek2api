import assert from 'node:assert/strict'
import test from 'node:test'

import { cappedCatalogModel, GEEK2API_MODELS } from '../src/catalog.js'
import { createGroupReader, parseContextWindows, parseKeyLifetime } from '../src/groups.js'
import { createModelSelectionController } from '../src/model-selection.js'
import { fixedHostPool } from './helpers.mjs'

const DS = 'deepseek-v4.1-flash'

function jsonResponse(payload, status = 200) {
  const body = JSON.stringify(payload)
  return { ok: status >= 200 && status < 300, status, json: async () => JSON.parse(body), text: async () => body }
}

test('per-model context windows are read from the model list, ignoring noise', () => {
  const windows = parseContextWindows([
    { id: DS, context_window: 200000 },
    { id: 'gpt-6.1-sol' },
    { id: 'tiny', context_window: 100 },
    { id: 'bad', context_window: '200000' },
  ])
  assert.deepEqual([...windows], [[DS, 200000]])
  assert.equal(parseContextWindows(undefined).size, 0)
})

test('the key lifetime marks a daily free key and where to renew it', () => {
  const daily = parseKeyLifetime({ key: { expires_at: '2026-11-17T12:00:00Z', purpose: 'free_daily', renew_window_hours: 2, renew_path: '/free-ds' } })
  assert.equal(daily.daily, true)
  assert.equal(daily.expiresAt, Date.parse('2026-11-17T12:00:00Z'))
  assert.equal(daily.renewWindowHours, 2)
  assert.equal(daily.renewPath, '/free-ds')
  const plain = parseKeyLifetime({ key: { expires_at: '2027-01-01T00:00:00Z' } })
  assert.equal(plain.daily, false)
  assert.equal(plain.renewPath, undefined)
  assert.equal(parseKeyLifetime({ key: {} }), undefined)
  assert.equal(parseKeyLifetime({ key: { expires_at: 'soon' } }), undefined)
  assert.equal(parseKeyLifetime({ key: { expires_at: '2026-11-17T12:00:00Z', purpose: 'free_daily', renew_path: 'javascript:alert(1)' } }).renewPath, '/free-ds')
})

test('a capped model keeps a positive compaction budget', () => {
  const ds = GEEK2API_MODELS.find(model => model.id === DS)
  assert.equal(ds.contextWindow, 1_000_000)
  const capped = cappedCatalogModel(ds, 200000)
  assert.equal(capped.contextWindow, 200000)
  assert.equal(capped.maxTokens, 32000)
  // DSH compaction: window - max output - 64K headroom must stay positive.
  assert.ok(capped.contextWindow - capped.maxTokens - 65536 > 90000)
  assert.equal(cappedCatalogModel(ds, undefined), ds)
  assert.equal(cappedCatalogModel(ds, 2_000_000), ds, 'a looser limit never widens the model')
})

test('the free key narrows the catalog model; a paid key alone leaves it at 1M', async () => {
  const lists = {
    'sk-free': [{ id: DS, context_window: 200000 }],
    'sk-paid': [{ id: DS }, { id: 'claude-opus-5-5' }],
  }
  const fetchImpl = async (url, options) => {
    const key = String(options.headers.Authorization).replace('Bearer ', '')
    if (url.endsWith('/v1/models')) return jsonResponse({ object: 'list', data: lists[key] ?? [] })
    if (url.endsWith('/v1/usage?lite=1')) {
      return jsonResponse(key === 'sk-free'
        ? { mode: 'unrestricted', key: { name: 'd', expires_at: '2026-11-17T12:00:00Z', purpose: 'free_daily', renew_window_hours: 2, renew_path: '/free-ds' } }
        : { mode: 'unrestricted', key: { name: 'p' } })
    }
    throw new Error(`unrouted ${url}`)
  }
  let keys = [{ id: 'p', label: 'paid', key: 'sk-paid', disabled: false }]
  const reader = createGroupReader({ listKeys: async () => keys, hosts: await fixedHostPool(), fetchImpl })
  const selection = createModelSelectionController({
    readPreference: () => ({}),
    writePreference: () => {},
    isWritable: () => false,
    contextLimitFor: id => reader.contextLimitFor(id),
  })
  const dsOf = () => selection.models().find(model => model.id === DS)

  await reader.read()
  assert.equal(reader.contextLimitFor(DS), undefined)
  assert.equal(dsOf().contextWindow, 1_000_000)
  const before = selection.models()

  keys = [...keys, { id: 'f', label: 'free', key: 'sk-free', disabled: false }]
  await reader.read({ force: true })
  assert.equal(reader.contextLimitFor(DS), 200000)
  assert.equal(dsOf().contextWindow, 200000)
  assert.equal(dsOf().maxTokens, 32000)
  assert.notEqual(selection.models(), before, 'a new cap is a new catalog, so the route rebuilds')
  assert.equal(selection.models(), selection.models(), 'an unchanged cap keeps the catalog identity')
  assert.equal(reader.lifetimeOf('f').daily, true)
  assert.equal(reader.lifetimeOf('p'), undefined)
  const claude = selection.models().find(model => model.id === 'claude-opus-5-5')
  assert.equal(claude.contextWindow, 1_000_000, 'models without a cap are untouched')
})
