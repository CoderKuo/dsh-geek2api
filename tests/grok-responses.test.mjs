import assert from 'node:assert/strict'
import test from 'node:test'

import { DEFAULT_API_HOST } from '../src/constants.js'
import { createGeek2APIProvider } from '../src/provider.js'

/** An actual Responses SSE stream, parsed by pi-ai's real OpenAI SDK path. */
function responseStream() {
  const item = { type: 'message', id: 'msg_fixture', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'ok', annotations: [] }] }
  const events = [
    { type: 'response.created', response: { id: 'resp_fixture', status: 'in_progress', output: [] } },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } },
    { type: 'response.content_part.added', output_index: 0, content_index: 0, item_id: item.id, part: { type: 'output_text', text: '', annotations: [] } },
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, item_id: item.id, delta: 'ok' },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: { id: 'resp_fixture', status: 'completed', output: [item], usage: { input_tokens: 8, output_tokens: 2, total_tokens: 10 } } },
  ]
  return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n', {
    headers: { 'Content-Type': 'text/event-stream' },
  })
}

test('Grok uses Responses and its four efforts without the cache key this gateway rejects', async () => {
  const provider = createGeek2APIProvider()
  const model = provider.getModels().find(model => model.id === 'grok-4.7')
  for (const reasoning of ['low', 'medium', 'high', 'xhigh']) {
    const requests = []
    const stream = provider.streamSimple(model, { messages: [{ role: 'user', content: 'Reply with ok', timestamp: 1 }] }, {
      apiKey: 'sk-fixture-only-not-a-real-key', reasoning,
      sessionId: 'grok-fixture-session', cacheRetention: 'long', maxTokens: 2048,
      fetch: async (url, init) => {
        requests.push({ url: String(url), key: new Headers(init.headers).get('authorization'), body: JSON.parse(init.body) })
        if (requests.at(-1).body.prompt_cache_key !== undefined) {
          return Response.json({ error: { message: 'Incorrect API key provided', type: 'geek2api_invalid-argument', code: 'invalid-argument' } }, { status: 400 })
        }
        return responseStream()
      },
    })
    const chunks = []
    for await (const chunk of stream) chunks.push(chunk)
    const result = await stream.result()
    assert.equal(result.stopReason, 'stop', result.errorMessage)
    assert.equal(chunks.filter(chunk => chunk.type === 'text_delta').map(chunk => chunk.delta).join(''), 'ok')
    assert.equal(requests.length, 1)
    assert.equal(requests[0].url, `${DEFAULT_API_HOST}/v1/responses`)
    assert.equal(requests[0].key, 'Bearer sk-fixture-only-not-a-real-key')
    assert.equal(requests[0].body.model, 'grok-4.7')
    assert.equal(requests[0].body.reasoning.effort, reasoning)
    assert.equal(requests[0].body.prompt_cache_key, undefined, 'the gateway refuses Grok when this field is present')
    assert.equal(requests[0].body.prompt_cache_retention, undefined, 'Grok must not receive OpenAI 24h retention')
    assert.equal(requests[0].body.max_output_tokens, 2048)
    assert.ok(requests[0].body.include.includes('reasoning.encrypted_content'))
  }
})

test('GPT keeps the session cache key its gateway route requires', async () => {
  const provider = createGeek2APIProvider()
  const model = provider.getModels().find(model => model.id === 'gpt-6.1-sol')
  let payload
  const stream = provider.streamSimple(model, { messages: [{ role: 'user', content: 'Reply with ok', timestamp: 1 }] }, {
    apiKey: 'sk-fixture-only-not-a-real-key', sessionId: 'gpt-session', reasoning: 'high',
    fetch: async (_url, init) => { payload = JSON.parse(init.body); return responseStream() },
  })
  await stream.result()
  assert.equal(payload.prompt_cache_key, 'gpt-session')
})

test('a future non-GPT Responses model also defaults to omitting the GPT cache key', async () => {
  const provider = createGeek2APIProvider()
  // A descriptor from another family catches a Grok-only special case.
  const model = { ...provider.getModels().find(model => model.id === 'grok-4.7'), id: 'another-responses-model', name: 'Another model' }
  let payload
  const stream = provider.streamSimple(model, { messages: [{ role: 'user', content: 'Reply with ok', timestamp: 1 }] }, {
    apiKey: 'sk-fixture-only-not-a-real-key', sessionId: 'other-session', reasoning: 'high',
    fetch: async (_url, init) => { payload = JSON.parse(init.body); return responseStream() },
  })
  assert.equal((await stream.result()).stopReason, 'stop')
  assert.equal(payload.prompt_cache_key, undefined)
})
