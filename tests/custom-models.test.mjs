import assert from 'node:assert/strict'
import test from 'node:test'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'

import { customCatalogModel, GEEK2API_MODEL_IDS } from '../src/catalog.js'
import { PROVIDER } from '../src/constants.js'
import {
  DEFAULT_CUSTOM_CONTEXT_WINDOW,
  DEFAULT_CUSTOM_MAX_TOKENS,
  MAX_CUSTOM_MODELS,
  parseCustomModel,
  readCustomModels,
  validateCustomModels,
} from '../src/custom-models.js'
import { createGroupReader } from '../src/groups.js'
import { createHostPool } from '../src/hosts.js'
import { Geek2APIKeyRing } from '../src/key-ring.js'
import { createModelSelectionController } from '../src/model-selection.js'
import { createRouteAdapter } from '../src/route.js'
import { fakeCredentials, fixedHostPool, stubHostPool } from './helpers.mjs'

test('a custom model needs only an id; everything else has a default', () => {
  assert.deepEqual({ ...parseCustomModel({ id: '  qwen3-max ' }) }, {
    id: 'qwen3-max',
    name: '',
    api: 'openai-completions',
    reasoning: false,
    image: false,
    contextWindow: DEFAULT_CUSTOM_CONTEXT_WINDOW,
    maxTokens: DEFAULT_CUSTOM_MAX_TOKENS,
  })
  // A small window caps the default output.
  assert.equal(parseCustomModel({ id: 'tiny', contextWindow: 8000 }).maxTokens, 8000)
  // The panel's number inputs may arrive as strings.
  assert.equal(parseCustomModel({ id: 'm', contextWindow: '200000', maxTokens: '64000' }).maxTokens, 64_000)
  assert.equal(parseCustomModel({ id: 'org/model:free@v2+x', name: '  My   model ' }).name, 'My model')
})

test('a custom model that cannot be served is refused with a reason the panel may show', () => {
  const refuses = (entry, pattern) => assert.throws(() => parseCustomModel(entry), error => {
    assert.match(error.message, /^Geek2API /u, 'the RPC only lets messages it authored through')
    assert.match(error.message, pattern)
    return true
  })
  refuses({ id: '' }, /needs a model id/u)
  refuses({ id: 'has space' }, /may only use/u)
  refuses({ id: '-leading' }, /may only use/u)
  refuses({ id: 'x'.repeat(129) }, /may only use/u)
  refuses({ id: 'claude-opus-5-5' }, /already a built-in/u)
  refuses({ id: 'm', api: 'google-generative-ai' }, /unsupported protocol/u)
  refuses({ id: 'm', contextWindow: 10 }, /context window/u)
  refuses({ id: 'm', contextWindow: 1.5e4 + 0.5 }, /context window/u)
  refuses({ id: 'm', contextWindow: 16_000, maxTokens: 32_000 }, /max output/u)
  refuses({ id: 'm', maxTokens: 0 }, /max output/u)
  refuses('m', /must be objects/u)

  assert.throws(() => validateCustomModels([{ id: 'a' }, { id: 'a' }]), /listed twice/u)
  assert.throws(() => validateCustomModels(Array.from({ length: MAX_CUSTOM_MODELS + 1 }, (_, i) => ({ id: `m${i}` }))), /at most/u)
  assert.throws(() => validateCustomModels('a'), /must be a list/u)
})

test('a hand-edited list is read leniently: only unservable entries are dropped', () => {
  const read = readCustomModels([{ id: 'ok-1' }, { id: 'gpt-6.1-sol' }, { id: 'bad id' }, null, { id: 'ok-1', name: 'dup' }, { id: 'ok-2', api: 'anthropic-messages' }])
  assert.deepEqual(read.map(entry => entry.id), ['ok-1', 'ok-2'])
  assert.equal(read[0].name, '')
  assert.deepEqual(readCustomModels(undefined), [])
  assert.deepEqual(readCustomModels({ id: 'x' }), [])
})

test('each protocol gets the base URL and compat its built-in models use', () => {
  const completions = customCatalogModel(parseCustomModel({ id: 'qwen3-max' }))
  assert.equal(completions.provider, PROVIDER)
  assert.equal(completions.name, 'qwen3-max', 'an empty name shows the id')
  assert.equal(completions.baseUrl, 'https://hk.geek2api.com/v1')
  assert.equal(completions.compat.maxTokensField, 'max_tokens')
  assert.equal(completions.reasoning, false)
  assert.deepEqual([...completions.input], ['text'])

  const responses = customCatalogModel(parseCustomModel({ id: 'gpt-x', api: 'openai-responses', reasoning: true, image: true }))
  assert.equal(responses.baseUrl, 'https://hk.geek2api.com/v1')
  assert.equal(responses.compat, undefined)
  assert.deepEqual([...responses.input], ['text', 'image'])
  assert.equal(responses.thinkingLevelMap.minimal, null)

  const messages = customCatalogModel(parseCustomModel({ id: 'claude-x', api: 'anthropic-messages', name: 'Claude X' }))
  assert.equal(messages.baseUrl, 'https://hk.geek2api.com', 'the Anthropic client appends /v1/messages itself')
  assert.equal(messages.name, 'Claude X')
})

/** The controller over an in-memory preference, as `apply()` composes it. */
function selection(initial = {}) {
  let values = { ...initial }
  const seen = { changes: 0, catalogChanges: 0, writes: [] }
  const controller = createModelSelectionController({
    readPreference: () => values,
    writePreference: async patch => {
      seen.writes.push(patch)
      values = { ...values, ...patch }
    },
    isWritable: () => true,
    onChange: () => { seen.changes += 1 },
    onCatalogChange: () => { seen.catalogChanges += 1 },
  })
  return { controller, seen, set: patch => { values = { ...values, ...patch } } }
}

test('custom models join the catalog after the built-in ones, selected by default', async () => {
  const { controller, seen } = selection()
  const before = controller.models()
  assert.equal(controller.models(), before, 'an unchanged catalog keeps its identity')

  const status = await controller.updateCustom({ customModels: [{ id: 'qwen3-max', name: 'Qwen3 Max' }, { id: 'claude-x', api: 'anthropic-messages' }] })
  assert.deepEqual(seen.writes.at(-1).customModels.map(entry => entry.id), ['qwen3-max', 'claude-x'])
  assert.deepEqual(controller.ids(), [...GEEK2API_MODEL_IDS, 'qwen3-max', 'claude-x'])
  assert.notEqual(controller.models(), before)
  assert.equal(seen.changes, 1)
  assert.equal(seen.catalogChanges, 1)
  const qwen = status.models.find(model => model.id === 'qwen3-max')
  assert.deepEqual(qwen, { id: 'qwen3-max', name: 'Qwen3 Max', selected: true, custom: true })
  assert.equal(status.models[0].custom, undefined)
  assert.deepEqual(status.customModels.map(entry => entry.api), ['openai-completions', 'anthropic-messages'])
  assert.deepEqual(status.protocols, ['openai-completions', 'openai-responses', 'anthropic-messages'])

  // A custom model can be hidden like any other.
  await controller.update({ selectedIds: GEEK2API_MODEL_IDS })
  assert.equal(controller.isVisible('qwen3-max'), false)
  assert.equal(seen.catalogChanges, 1, 'hiding a model does not re-read coverage')

  // An invalid list is refused without writing anything.
  const writes = seen.writes.length
  await assert.rejects(controller.updateCustom({ customModels: [{ id: 'gpt-6-luna' }] }), /already a built-in/u)
  assert.equal(seen.writes.length, writes)

  await controller.updateCustom({ customModels: [] })
  assert.deepEqual(controller.ids(), [...GEEK2API_MODEL_IDS])
  assert.equal(seen.catalogChanges, 2)
})

test('a hand edit of the custom list is followed on reconcile', () => {
  const { controller, seen, set } = selection()
  set({ customModels: [{ id: 'kimi-k4' }] })
  controller.reconcile()
  assert.equal(seen.changes, 1)
  assert.equal(seen.catalogChanges, 1)
  assert.ok(controller.ids().includes('kimi-k4'))
  controller.reconcile()
  assert.equal(seen.changes, 1, 'the same list is no change')
})

test('the route serves a custom model on its protocol and refreshes with the catalog', async t => {
  const { controller } = selection()
  const ring = new Geek2APIKeyRing(fakeCredentials())
  await ring.add('sk-fixture-only-not-a-real-key', 'fixture')
  const adapter = createRouteAdapter({
    ring,
    hosts: stubHostPool(createHostPool),
    keys: { active: () => ring.activeKey(), forRequest: (_model, key) => key, onKeyFailure: () => {} },
    fallbackSessionId: 'custom-fixture',
    listModels: controller.models,
  })
  assert.ok(adapter instanceof PiAiAdapter)
  await assert.rejects(adapter.resolveModel(PROVIDER, 'qwen3-max'), /no configured model/u)

  await controller.updateCustom({ customModels: [{ id: 'qwen3-max', contextWindow: 256_000 }, { id: 'think-x', api: 'openai-responses', reasoning: true }] })
  assert.deepEqual((await adapter.listModels(PROVIDER)).slice(-2).map(model => model.id), ['qwen3-max', 'think-x'])
  const qwen = await adapter.resolveModel(PROVIDER, 'qwen3-max')
  assert.equal(qwen.context.contextWindow, 256_000)
  assert.equal(qwen.reasoning?.defaultEffort, undefined)
  const think = await adapter.resolveModel(PROVIDER, 'think-x')
  assert.deepEqual(think.reasoning.efforts.map(effort => effort.id), ['off', 'low', 'medium', 'high'])

  const requests = []
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    const request = new Request(input, init)
    requests.push({ url: request.url, body: await request.json() })
    const chunks = [
      { id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'qwen3-max', choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: null }] },
      { id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'qwen3-max', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    ]
    return new Response(chunks.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } })
  })
  const { createUserMessage } = await import('@deepseek-ai/dsh-llm')
  const prepared = await adapter.prepareCall(PROVIDER, 'qwen3-max')
  let last
  for await (const chunk of prepared.stream({
    provider: PROVIDER,
    model: 'qwen3-max',
    sessionId: 'custom-fixture',
    maxTokens: 64,
    // A non-reasoning custom model is asked for `off` like a built-in one.
    reasoningEffort: 'high',
    messages: [createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } })],
  })) last = chunk
  assert.equal(last.reason.kind, 'stop')
  assert.equal(requests.length, 1)
  assert.equal(requests[0].url, 'https://h1.example/v1/chat/completions')
  assert.equal(requests[0].body.model, 'qwen3-max')
  assert.equal(requests[0].body.reasoning_effort, undefined)

  await controller.updateCustom({ customModels: [] })
  await assert.rejects(adapter.resolveModel(PROVIDER, 'qwen3-max'), /no configured model/u, 'a removed model never falls back to another')
})

test('key coverage is measured for custom models too', async () => {
  const { controller } = selection({ customModels: [{ id: 'qwen3-max' }] })
  const fetchImpl = async url => {
    const body = url.endsWith('/v1/models')
      ? { object: 'list', data: ['qwen3-max', 'claude-opus-5-5', 'other'].map(id => ({ id })) }
      : { mode: 'unrestricted', balance: 1 }
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) }
  }
  const reader = createGroupReader({
    listKeys: async () => [{ id: 'k', label: 'k', key: 'sk-fixture', disabled: false }],
    hosts: await fixedHostPool(),
    modelIds: () => controller.ids(),
    fetchImpl,
  })
  const value = await reader.read()
  assert.equal(value.keys[0].coverage['qwen3-max'], true)
  assert.equal(value.keys[0].coverage['gpt-6.1-sol'], false)
  assert.equal(value.keys[0].extraModels, 1, 'a custom model is no longer "outside the list"')
  assert.equal(reader.covers('k', 'qwen3-max'), true)
})
