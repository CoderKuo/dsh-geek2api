import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { LlmRuntime } from '@deepseek-ai/dsh-llm'

import { GEEK2API_MODEL_IDS } from '../src/catalog.js'
import { apply, Config } from '../src/index.js'
import { createModelSelectionController, readHiddenModels } from '../src/model-selection.js'
import { fieldValue } from '../src/preferences.js'
import { createRouteAdapter } from '../src/route.js'
import { fakeCredentials } from './helpers.mjs'

/** Exercise both real settings seams and the registered model adapter/RPC. */
function host({ generation = '0.2', writable = true, failWrite = false, initial = {} } = {}) {
  let values = { ...initial }
  const seen = { updates: [], notifications: 0, handler: undefined, adapter: undefined, listeners: new Map() }
  let hooks
  const settings = {
    writable,
    async update(id, patch) {
      assert.equal(id, 'geek2api')
      if (failWrite) throw new Error('fixture: storage failed')
      seen.updates.push(patch)
      values = { ...values, ...patch }
      if (generation === '0.1') hooks.onChange()
      else seen.listeners.get('loader/volatile-update')?.()
    },
    configure: () => () => {},
  }
  if (generation === '0.1') {
    settings.installSection = (_ctx, _ns, _schema, source, callbacks) => {
      values = { ...source, ...values }
      hooks = callbacks
      hooks.setSource(() => values)
    }
  }
  const ctx = {
    credentials: fakeCredentials(),
    logger: { warn() {} },
    fiber: { entry: { options: { id: 'geek2api' } } },
    llm: {
      registerAdapter(_providers, adapter) {
        seen.adapter = adapter
        const handle = () => {}
        handle.replace = providers => {
          assert.deepEqual(providers, ['geek2api'])
          seen.notifications += 1
        }
        return handle
      },
      registerConfigurableProviders: () => () => {},
    },
    get: () => undefined,
    on(event, callback) { seen.listeners.set(event, callback) },
    inject(names, callback) {
      if (names.includes('settings')) return callback({ settings, effect: ctx.effect })
      if (names.includes('connection')) return callback({ effect: ctx.effect, connection: { rpc: { handle(_channel, handler) { seen.handler = handler; return () => {} } } } })
      // These fixtures intentionally mount no search or CLI tool service.
    },
    effect(callback) { return callback() },
  }
  const config = generation === '0.2' ? { hiddenModels: { get: () => values.hiddenModels } } : {}
  apply(ctx, config)
  return {
    seen,
    changeHidden(ids) { values = { ...values, hiddenModels: ids }; seen.listeners.get('loader/volatile-update')() },
    reapply: () => host({ generation, initial: values }),
  }
}

test('model preferences are volatile, default to all models and expose only public descriptors', async () => {
  assert.equal(Config.dict.hiddenModels.meta.volatile, true)
  assert.deepEqual(fieldValue(new Config({}).hiddenModels), [])
  const { seen } = host()
  const reply = await seen.handler('models/status')
  assert.equal(reply.ok, true)
  assert.equal(reply.value.writable, true)
  assert.deepEqual(reply.value.models.map(model => model.id), [...GEEK2API_MODEL_IDS])
  assert.ok(reply.value.models.every(model => model.selected))
  assert.deepEqual(Object.keys(reply.value.models[0]).sort(), ['id', 'name', 'selected'])
  assert.deepEqual((await seen.adapter.listModels('geek2api')).map(model => model.id), [...GEEK2API_MODEL_IDS])
})

for (const generation of ['0.1', '0.2']) {
  test(`DSH ${generation}: checkboxes persist, refresh the picker, and survive plugin reconstruction`, async () => {
    const env = host({ generation })
    const { seen } = env
    const reply = await seen.handler('models/update', { selectedIds: ['grok-4.7', 'deepseek-v4.1-flash', 'grok-4.7'] })
    assert.equal(reply.ok, true)
    assert.deepEqual(reply.value.models.filter(model => model.selected).map(model => model.id), ['deepseek-v4.1-flash', 'grok-4.7'])
    assert.deepEqual(seen.updates, [{ hiddenModels: GEEK2API_MODEL_IDS.filter(id => !['deepseek-v4.1-flash', 'grok-4.7'].includes(id)) }])
    assert.equal(seen.notifications, 1, 'one registry refresh, even when the settings hook fires during the write')
    assert.deepEqual((await seen.adapter.listModels('geek2api')).map(model => model.id), ['deepseek-v4.1-flash', 'grok-4.7'])
    assert.deepEqual((await env.reapply().seen.adapter.listModels('geek2api')).map(model => model.id), ['deepseek-v4.1-flash', 'grok-4.7'])

    // Resolution and preparation use the full catalog for existing sessions.
    const hidden = await seen.adapter.resolveModel('geek2api', 'gpt-6.1-sol')
    assert.equal(hidden.id, 'gpt-6.1-sol')
    assert.equal((await seen.adapter.prepareCall('geek2api', 'gpt-6.1-sol')).model.id, 'gpt-6.1-sol')
    assert.equal((await seen.adapter.resolveModel('geek2api', 'claude-opus-5-5')).id, 'claude-opus-5-5')

    await seen.handler('models/update', { selectedIds: [] })
    assert.deepEqual(await seen.adapter.listModels('geek2api'), [], 'Select none must not revert to all')
    const all = await seen.handler('models/update', { selectedIds: [...GEEK2API_MODEL_IDS] })
    assert.ok(all.value.models.every(model => model.selected))
    assert.deepEqual(seen.updates.at(-1), { hiddenModels: [] })
    assert.equal(seen.notifications, 3)
  })
}

test('a volatile edit elsewhere refreshes only once, without changing other settings', async () => {
  const { seen, changeHidden } = host()
  changeHidden(['gpt-6-astra', 'deepseek-v4.1-flash'])
  assert.equal(seen.notifications, 1)
  changeHidden(['deepseek-v4.1-flash', 'gpt-6-astra', 'deepseek-v4.1-flash', 'future-model'])
  assert.equal(seen.notifications, 1, 'order, duplicates and unknown exclusions do not change the picker')
  assert.deepEqual(seen.updates, [])
  assert.ok((await seen.adapter.listModels('geek2api')).some(model => model.id === 'grok-4.7'), 'new models default to selected')
})

test('unsupported selections are refused without writing preferences', async () => {
  const { seen } = host()
  for (const selectedIds of [undefined, null, 'grok-4.7', ['unknown'], [1], ['grok-4.7', {}]]) {
    const reply = await seen.handler('models/update', { selectedIds })
    assert.equal(reply.ok, false)
    assert.match(reply.error.message, /not supported/u)
    assert.equal(typeof reply.error.code, 'string')
    assert.deepEqual(reply.error.details, {})
  }
  assert.deepEqual(seen.updates, [])
  assert.equal(seen.notifications, 0)
})

for (const generation of ['0.1', '0.2']) {
  test(`DSH ${generation}: read-only and failed saves keep the previous selection`, async () => {
    for (const options of [{ writable: false }, { failWrite: true }]) {
      const { seen } = host({ generation, ...options })
      const before = await seen.handler('models/status')
      assert.equal(before.value.writable, options.writable !== false)
      const failure = await seen.handler('models/update', { selectedIds: [] })
      assert.equal(failure.ok, false)
      assert.equal(typeof failure.error.code, 'string')
      assert.deepEqual(failure.error.details, {})
      assert.deepEqual((await seen.handler('models/status')).value.models, before.value.models)
      assert.deepEqual(seen.updates, [])
      assert.equal(seen.notifications, 0)
    }
  })
}

test('legacy, missing and invalid preference values keep the default; volatile exclusions are read', () => {
  for (const preference of [undefined, {}, { hiddenModels: null }, { hiddenModels: 'grok-4.7' }, { hiddenModels: ['retired-model'] }]) {
    assert.deepEqual(readHiddenModels(preference), [])
  }
  assert.deepEqual(readHiddenModels({ hiddenModels: { get: () => ['grok-4.7', 'unknown'] } }), ['grok-4.7'])
})

test('the actual DSH LLM registry refreshes discovery atomically and keeps a prepared call usable', async () => {
  const ctx = new Context()
  const llm = new LlmRuntime(ctx)
  let preferences = {}
  let registration
  let notifications = 0
  ctx.on('llm/adapters-updated', () => { notifications += 1 })
  const selection = createModelSelectionController({
    readPreference: () => preferences,
    writePreference: async patch => { preferences = { ...preferences, ...patch } },
    isWritable: () => true,
    onChange: () => registration.replace(['geek2api']),
  })
  const adapter = createRouteAdapter({ ring: {}, keys: {}, isModelVisible: selection.isVisible })
  registration = llm.registerAdapter(['geek2api'], adapter)
  const prepared = await adapter.prepareCall('geek2api', 'deepseek-v4.1-flash')
  const before = notifications
  await selection.update({ selectedIds: [] })
  assert.equal(notifications, before + 1)
  assert.deepEqual(await llm.listModels('geek2api'), [])
  assert.equal((await adapter.resolveModel('geek2api', 'deepseek-v4.1-flash')).id, 'deepseek-v4.1-flash')
  assert.equal(prepared.model.id, 'deepseek-v4.1-flash')
  assert.equal(typeof prepared.stream, 'function')
  await selection.update({ selectedIds: ['grok-4.7'] })
  assert.deepEqual((await llm.listModels('geek2api')).map(model => model.id), ['grok-4.7'])
  registration()
})
