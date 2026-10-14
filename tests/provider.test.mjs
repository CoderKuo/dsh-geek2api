import assert from 'node:assert/strict'
import test from 'node:test'

import { isQuotaExceededError } from '@deepseek-ai/dsh-llm'

import { GEEK2API_MODEL_IDS } from '../src/catalog.js'
import { DISPLAY_NAME, PROVIDER } from '../src/constants.js'
import { createGeek2APIProvider, guardKeyRotation } from '../src/provider.js'

/** A pi-ai shaped stream: an async iterable plus `.result()`. */
function fakeStream(items, { throwAt } = {}) {
  const stream = {
    async *[Symbol.asyncIterator]() {
      for (const [index, item] of items.entries()) {
        if (throwAt === index) throw new Error(throwAt === 0 && items.length === 0 ? 'transport' : 'boom')
        yield item
      }
      if (throwAt !== undefined && throwAt >= items.length) throw new Error('late boom')
    },
    result: async () => ({ ok: true }),
  }
  return stream
}

test('builds one route carrying all three protocols', () => {
  const provider = createGeek2APIProvider()
  assert.equal(provider.id, PROVIDER)
  assert.equal(provider.name, DISPLAY_NAME)
  assert.deepEqual(provider.getModels().map(model => model.id), [...GEEK2API_MODEL_IDS])
  assert.equal(typeof provider.stream, 'function')
  assert.equal(typeof provider.streamSimple, 'function')
})

test('a terminal quota event moves the ring and is rewritten for the classifier', async () => {
  const failures = []
  const event = {
    type: 'error',
    error: { errorMessage: '429 {"error":{"code":"API_KEY_QUOTA_EXHAUSTED","message":"API key 额度已用完"}}' },
  }
  const guarded = guardKeyRotation(fakeStream([event]), {
    key: 'sk-aaaaaaaaaaaaaaaa',
    onKeyFailure: (...args) => failures.push(args),
  })
  const received = []
  for await (const item of guarded) received.push(item)

  assert.equal(failures.length, 1)
  assert.equal(failures[0][0], 'quota')
  assert.equal(failures[0][2], 'sk-aaaaaaaaaaaaaaaa')
  assert.equal(isQuotaExceededError(received[0].error.errorMessage), true)
  // The wrapper keeps `result()` and every other member reachable.
  assert.deepEqual(await guarded.result(), { ok: true })
})

test('a rejected key reported as a terminal event normalizes to auth', async () => {
  const failures = []
  const guarded = guardKeyRotation(fakeStream([
    { type: 'done', message: { errorMessage: '401 {"error":{"code":"INVALID_API_KEY","message":"Invalid API key"}}' } },
  ]), { key: 'sk-bbbbbbbbbbbbbbbbbb', onKeyFailure: (...args) => failures.push(args) })
  const received = []
  for await (const item of guarded) received.push(item)
  assert.equal(failures[0][0], 'invalid-key')
  assert.match(received[0].message.errorMessage, /\b401\b/u)
})

test('a pre-chunk transport failure is attributed and rewritten when it is a key fault', async () => {
  const failures = []
  const guarded = guardKeyRotation(fakeStream([], { throwAt: 0 }), {
    key: 'sk-cccccccccccccccccccc',
    onKeyFailure: (...args) => failures.push(args),
  })
  await assert.rejects(async () => {
    for await (const _item of guarded) void _item
  }, /boom/u)
  // A generic failure names no key condition, so nothing rotates.
  assert.deepEqual(failures, [])
})

test('a mid-stream failure never blames the key', async () => {
  const failures = []
  const guarded = guardKeyRotation(fakeStream([{ type: 'text', text: 'hi' }], { throwAt: 1 }), {
    key: 'sk-dddddddddddddddddddd',
    onKeyFailure: (...args) => failures.push(args),
  })
  await assert.rejects(async () => {
    for await (const _item of guarded) void _item
  }, /late boom/u)
  assert.deepEqual(failures, [])
})

test('an unrelated stream passes through untouched', () => {
  assert.equal(guardKeyRotation(null), null)
  assert.equal(guardKeyRotation('nope'), 'nope')
})

test('a client-policy refusal is explained without touching the key ring', async () => {
  const failures = []
  const policy = '403 {"error":{"type":"geek2api_api_error","message":"This API endpoint is only accessible via the official Claude CLI (request id: 01M4Q6FJ0)"}}'
  const guarded = guardKeyRotation(fakeStream([{ type: 'error', error: { errorMessage: policy } }]), {
    key: 'sk-eeeeeeeeeeeeeeeeeeee',
    onKeyFailure: (...args) => failures.push(args),
  })
  const received = []
  for await (const item of guarded) received.push(item)
  assert.deepEqual(failures, [], 'no key may be disabled for a client-policy refusal')
  assert.match(received[0].error.errorMessage, /这不是 API Key 失效/u)
  assert.equal(isQuotaExceededError(received[0].error.errorMessage), false)
})

test('a thrown client-policy refusal is explained too', async () => {
  const failures = []
  const guarded = guardKeyRotation(fakeStream([], { throwAt: 0 }), {
    key: 'sk-ffffffffffffffffffff',
    onKeyFailure: (...args) => failures.push(args),
  })
  // Replace the transport failure with the policy error for this case.
  const policyStream = {
    async *[Symbol.asyncIterator]() {
      throw new Error('403 {"error":{"message":"This API endpoint is only accessible via the official Claude CLI"}}')
    },
  }
  const guardedPolicy = guardKeyRotation(policyStream, {
    key: 'sk-ffffffffffffffffffff',
    onKeyFailure: (...args) => failures.push(args),
  })
  await assert.rejects(async () => {
    for await (const _item of guardedPolicy) void _item
  }, /这不是 API Key 失效/u)
  assert.deepEqual(failures, [])
  // The original key-fault path is unchanged for a generic failure.
  await assert.rejects(async () => {
    for await (const _item of guarded) void _item
  }, /boom/u)
})

/** A stream that throws `error` at `index` (after yielding the items before it). */
function throwingStream(items, index, error) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const [at, item] of items.entries()) {
        if (at === index) throw error
        yield item
      }
      if (index >= items.length) throw error
    },
  }
}

const transportError = () => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) })

test('a request that never reached the host reports the host, not the key', async () => {
  const hostFailures = []
  const keyFailures = []
  const guarded = guardKeyRotation(throwingStream([], 0, transportError()), {
    key: 'sk-hostfault000000000',
    onKeyFailure: (...args) => keyFailures.push(args),
    onHostFailure: reason => hostFailures.push(reason),
  })
  await assert.rejects(async () => {
    for await (const _item of guarded) void _item
  }, /fetch failed/u)
  assert.equal(hostFailures.length, 1)
  assert.deepEqual(keyFailures, [])
})

test('a terminal transport error event before any answer reports the host', async () => {
  const hostFailures = []
  const guarded = guardKeyRotation(fakeStream([{ type: 'error', error: { errorMessage: 'Connection error.' } }]), {
    onHostFailure: reason => hostFailures.push(reason),
  })
  for await (const _item of guarded) void _item
  assert.deepEqual(hostFailures, ['Connection error.'])
})

test('a host that already answered is never set aside for a later break', async () => {
  const hostFailures = []
  const answered = guardKeyRotation(throwingStream([{ type: 'text_delta', delta: 'hi' }], 1, transportError()), {
    onHostFailure: reason => hostFailures.push(reason),
  })
  await assert.rejects(async () => {
    for await (const _item of answered) void _item
  }, /fetch failed/u)
  const afterChunk = guardKeyRotation(fakeStream([
    { type: 'text_delta', delta: 'hi' },
    { type: 'error', error: { errorMessage: 'Connection error.' } },
  ]), { onHostFailure: reason => hostFailures.push(reason) })
  for await (const _item of afterChunk) void _item
  assert.deepEqual(hostFailures, [])
})

test('an HTTP refusal is the gateway answering: the host stays', async () => {
  const hostFailures = []
  const guarded = guardKeyRotation(fakeStream([{ type: 'error', error: { errorMessage: '503 Upstream service temporarily unavailable' } }]), {
    onHostFailure: reason => hostFailures.push(reason),
  })
  for await (const _item of guarded) void _item
  assert.deepEqual(hostFailures, [])
})

test('a model no stored key reaches is explained in place of the raw refusal', async () => {
  const keyFailures = []
  const raw = `400 {"error":{"message":"Model 'kimi-k3' is not available. Use GET /v1/models to see supported models."}}`
  const guarded = guardKeyRotation(fakeStream([{ type: 'error', error: { errorMessage: raw } }]), {
    key: 'sk-uncovered0000000000',
    modelId: 'kimi-k3',
    onKeyFailure: (...args) => keyFailures.push(args),
  })
  const received = []
  for await (const item of guarded) received.push(item)
  assert.match(received[0].error.errorMessage, /你保存的 Key 都不能使用 kimi-k3/u)
  assert.deepEqual(keyFailures, [], 'coverage is not a key fault')
})

test('sub2api key faults move the ring: invalid, disabled, deleted group, and empty balance', async () => {
  const cases = [
    ['401 {"error":{"message":"Invalid API key"}}', 'invalid-key'],
    ['401 {"error":{"message":"API key is disabled"}}', 'invalid-key'],
    ['403 {"error":{"message":"API Key 所属分组已删除"}}', 'invalid-key'],
    ['403 {"error":{"message":"余额不足，请充值"}}', 'exhausted'],
    ['429 {"error":{"message":"API key 额度已用完"}}', 'quota'],
  ]
  for (const [message, kind] of cases) {
    const failures = []
    const guarded = guardKeyRotation(fakeStream([{ type: 'error', error: { errorMessage: message } }]), {
      key: 'sk-fault000000000000',
      onKeyFailure: (...args) => failures.push(args),
    })
    for await (const _item of guarded) void _item
    assert.equal(failures[0]?.[0], kind, message)
  }
})
