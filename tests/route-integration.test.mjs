import assert from 'node:assert/strict'
import test from 'node:test'

import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'

import { GEEK2API_MODEL_IDS } from '../src/catalog.js'
import { DEFAULT_REASONING_LEVEL, DISPLAY_NAME, PROVIDER } from '../src/constants.js'
import { createGeek2APIProfile } from '../src/index.js'
import { createGeek2APIProvider } from '../src/provider.js'

/**
 * The route composed exactly as `apply()` composes it, driven through the real
 * host adapter. Resolution and call preparation must work without reading a
 * credential or opening a model stream.
 */
function route({ reads = [] } = {}) {
  const provider = createGeek2APIProvider()
  const profile = createGeek2APIProfile(provider)
  const profiles = new Map([[PROVIDER, profile]])
  const adapter = new PiAiAdapter({
    profiles: () => profiles,
    resolveApiKey: async () => {
      reads.push('credential')
      return 'sk-test-not-a-real-key'
    },
    auth: Object.freeze({
      credentials: {
        async read() { return undefined },
        async list() { return [] },
        async modify() { throw new Error('unused') },
        async delete() { throw new Error('unused') },
      },
      authContext: Object.freeze({ env: async () => undefined, fileExists: async () => false }),
    }),
  })
  return { adapter, profile, reads }
}

test('the real adapter advertises the route under its display name', async () => {
  const { adapter, reads } = route()
  assert.deepEqual(adapter.providerInfo(PROVIDER), { id: PROVIDER, name: DISPLAY_NAME })
  const models = await adapter.listModels(PROVIDER)
  assert.deepEqual(models.map(model => model.id), [...GEEK2API_MODEL_IDS])
  // Catalog reads never touch a credential.
  assert.deepEqual(reads, [])
})

test('resolved metadata carries context, modalities, and the vendor efforts', async () => {
  const { adapter } = route()
  const claude = await adapter.resolveModel(PROVIDER, 'claude-opus-5-5')
  assert.equal(claude.context.contextWindow, 1_000_000)
  assert.deepEqual([...claude.inputModalities], ['text', 'image'])
  assert.deepEqual(claude.reasoning.efforts.map(effort => effort.id), ['low', 'medium', 'high', 'xhigh', 'max'])
  assert.equal(claude.reasoning.defaultEffort, DEFAULT_REASONING_LEVEL)
  assert.equal(claude.defaultMaxTokens, undefined)

  const deepseek = await adapter.resolveModel(PROVIDER, 'deepseek-v4.1-flash')
  assert.deepEqual(deepseek.reasoning.efforts.map(effort => effort.id), ['off', 'low', 'high', 'max'])
  assert.deepEqual([...deepseek.inputModalities], ['text', 'image'])

  // A model without a reasoning control still resolves, offering no effort
  // the upstream would reject.
  const gemini = await adapter.resolveModel(PROVIDER, 'gemini-3.8-flash')
  assert.equal(gemini.reasoning?.defaultEffort, undefined)
  assert.ok(!(gemini.reasoning?.efforts ?? []).some(effort => effort.id === DEFAULT_REASONING_LEVEL))
})

test('preparing a call returns the model and a stream, without opening one', async () => {
  const { adapter, reads } = route()
  const prepared = await adapter.prepareCall(PROVIDER, 'gpt-6.1-sol')
  assert.equal(prepared.model.id, 'gpt-6.1-sol')
  assert.equal(typeof prepared.stream, 'function')
  assert.deepEqual(reads, [])
})

test('the profile carries the retry policy that makes rotation reachable', () => {
  const { profile } = route()
  assert.equal(profile.reasoning, DEFAULT_REASONING_LEVEL)
  assert.equal(profile.retryPolicy.mode, 'normal')
  // One route serves every model, so this budget applies to all of them.
  assert.equal(profile.retryPolicy.maxRetries, 20)
  for (const code of ['QUOTA', 'AUTH', 'SERVER', 'TRANSPORT', 'TIMEOUT', 'RATE_LIMIT']) {
    assert.ok(profile.retryPolicy.retryableCodes.includes(code), `${code} must be retryable`)
  }
  // This gateway's 400 means it ("Model 'x' is not available"): no retry helps.
  assert.equal(profile.retryPolicy.retryableCodes.includes('INVALID_REQUEST'), false)
  assert.ok(profile.modelErrors instanceof Map)
  assert.ok(profile.configuredMaxTokens instanceof Map)
})

const sseCompletion = model => new Response([
  { id: 'c1', object: 'chat.completion.chunk', created: 1, model, choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: null }] },
  { id: 'c1', object: 'chat.completion.chunk', created: 1, model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
].map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } })

async function routeAdapter(hosts) {
  const { Geek2APIKeyRing } = await import('../src/key-ring.js')
  const { createRouteAdapter } = await import('../src/route.js')
  const { fakeCredentials } = await import('./helpers.mjs')
  const ring = new Geek2APIKeyRing(fakeCredentials())
  await ring.add('sk-fixture-only-not-a-real-key', 'fixture')
  const failures = []
  const adapter = createRouteAdapter({
    ring,
    hosts,
    keys: { active: () => ring.activeKey(), forRequest: (_model, key) => key, onKeyFailure: (...args) => failures.push(args) },
    fallbackSessionId: 'route-fixture',
  })
  return { adapter, failures }
}

async function runTurn(adapter, model, extra = {}) {
  const { createUserMessage } = await import('@deepseek-ai/dsh-llm')
  const prepared = await adapter.prepareCall(PROVIDER, model)
  const chunks = []
  for await (const chunk of prepared.stream({
    provider: PROVIDER, model, sessionId: 'route-fixture', maxTokens: 64,
    messages: [createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } })],
    ...extra,
  })) chunks.push(chunk)
  return chunks.at(-1)
}

test('a model without reasoning is asked for `off`, so the route default effort cannot fail it', async t => {
  const { createHostPool } = await import('../src/hosts.js')
  const { stubHostPool } = await import('./helpers.mjs')
  const requests = []
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    const request = new Request(input, init)
    requests.push({ url: request.url, body: await request.json() })
    return sseCompletion('gemini-3.8-flash')
  })
  const { adapter } = await routeAdapter(stubHostPool(createHostPool))
  // No effort named: the profile default ('high') would be refused for this model.
  assert.equal((await runTurn(adapter, 'gemini-3.8-flash')).reason.kind, 'stop')
  // Even an explicit effort from a stale session is turned into `off`.
  assert.equal((await runTurn(adapter, 'glm-5.3', { reasoningEffort: 'high' })).reason.kind, 'stop')
  assert.equal(requests.length, 2)
  for (const { body } of requests) {
    assert.equal(body.reasoning_effort, undefined)
    assert.equal(body.thinking, undefined)
  }
  assert.equal(requests[0].url, 'https://h1.example/v1/chat/completions')
})

test('a request that never reached its host sets the host aside; the retry lands on the next one', async t => {
  const { createHostPool } = await import('../src/hosts.js')
  const { stubHostPool } = await import('./helpers.mjs')
  const urls = []
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    const request = new Request(input, init)
    urls.push(request.url)
    if (request.url.startsWith('https://h1.example/')) {
      throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) })
    }
    return sseCompletion('deepseek-v4.1-flash')
  })
  const hosts = stubHostPool(createHostPool)
  const { adapter, failures } = await routeAdapter(hosts)
  const first = await runTurn(adapter, 'deepseek-v4.1-flash', { reasoningEffort: 'off' })
  assert.equal(first.reason.kind, 'error')
  assert.deepEqual(failures, [], 'a transport failure never blames the key')
  assert.equal(hosts.order()[0], 'https://h2.example')
  const second = await runTurn(adapter, 'deepseek-v4.1-flash', { reasoningEffort: 'off' })
  assert.equal(second.reason.kind, 'stop')
  assert.ok(urls[0].startsWith('https://h1.example/'))
  assert.equal(urls.at(-1), 'https://h2.example/v1/chat/completions')
})

test('a model no stored key can use is explained, without blaming or retrying the key', async t => {
  const { createHostPool } = await import('../src/hosts.js')
  const { stubHostPool } = await import('./helpers.mjs')
  t.mock.method(globalThis, 'fetch', async () => Response.json(
    { error: { message: "Model 'kimi-k3' is not available. Use GET /v1/models to see supported models.", type: 'invalid_request_error' } },
    { status: 400 },
  ))
  const { adapter, failures } = await routeAdapter(stubHostPool(createHostPool))
  const finish = await runTurn(adapter, 'kimi-k3')
  assert.equal(finish.reason.kind, 'error')
  assert.match(finish.reason.failure.message, /你保存的 Key 都不能使用 kimi-k3/u)
  assert.deepEqual(failures, [])
})
