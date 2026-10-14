import assert from 'node:assert/strict'
import test from 'node:test'

import { getSupportedThinkingLevels } from '@earendil-works/pi-ai'

import { GEEK2API_MODELS, GEEK2API_MODEL_IDS, modelForHost } from '../src/catalog.js'
import { DEFAULT_API_HOST, DEFAULT_REASONING_LEVEL, PROVIDER } from '../src/constants.js'

const byId = id => GEEK2API_MODELS.find(model => model.id === id)
const CLAUDE = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5-20251001']
const RESPONSES = ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-luna', 'grok-4.6', 'grok-4.7']
const COMPLETIONS = ['deepseek-v4.1-flash', 'deepseek-v4-pro', 'gemini-3.8-flash', 'glm-5.3', 'kimi-k3']

test('ships the Geek2API catalog, every model on this route', () => {
  assert.deepEqual([...GEEK2API_MODEL_IDS], [
    'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5-20251001',
    'gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-luna',
    'deepseek-v4.1-flash', 'deepseek-v4-pro',
    'grok-4.6', 'grok-4.7',
    'gemini-3.8-flash', 'glm-5.3', 'kimi-k3',
  ])
  assert.equal(new Set(GEEK2API_MODEL_IDS).size, GEEK2API_MODEL_IDS.length)
  for (const model of GEEK2API_MODELS) {
    assert.equal(model.provider, PROVIDER)
    assert.ok(model.input.includes('text'), model.id)
    assert.ok(model.contextWindow > 0 && model.maxTokens > 0, model.id)
  }
})

test('declares image input only where the model takes it', () => {
  for (const id of ['deepseek-v4-pro', 'glm-5.3']) assert.deepEqual([...byId(id).input], ['text'], id)
  for (const id of [...CLAUDE, ...RESPONSES, 'deepseek-v4.1-flash', 'gemini-3.8-flash', 'kimi-k3']) {
    assert.deepEqual([...byId(id).input], ['text', 'image'], id)
  }
})

test('pins each model to the protocol and base URL the gateway serves', () => {
  // Anthropic traffic carries no /v1: the Anthropic client appends /v1/messages.
  for (const id of CLAUDE) {
    assert.equal(byId(id).api, 'anthropic-messages', id)
    assert.equal(byId(id).baseUrl, DEFAULT_API_HOST, id)
  }
  // OpenAI-style traffic carries /v1 and never an endpoint path.
  for (const id of RESPONSES) {
    assert.equal(byId(id).api, 'openai-responses', id)
    assert.equal(byId(id).baseUrl, `${DEFAULT_API_HOST}/v1`, id)
  }
  for (const id of COMPLETIONS) {
    assert.equal(byId(id).api, 'openai-completions', id)
    assert.equal(byId(id).baseUrl, `${DEFAULT_API_HOST}/v1`, id)
  }
  assert.equal(byId('gpt-6-astra').contextWindow, 1_050_000)
  assert.equal(byId('grok-4.7').contextWindow, 500_000)
  assert.equal(byId('grok-4.7').compat.supportsLongCacheRetention, false)
  assert.equal(byId('grok-4.6').compat.supportsLongCacheRetention, false)
})

test("offers each vendor's documented effort levels", () => {
  for (const id of ['deepseek-v4.1-flash', 'deepseek-v4-pro']) {
    assert.deepEqual(getSupportedThinkingLevels(byId(id)), ['off', 'low', 'high', 'max'], id)
  }
  for (const id of ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-luna', 'claude-opus-5-5', 'claude-sonnet-5-5']) {
    assert.deepEqual(getSupportedThinkingLevels(byId(id)), ['low', 'medium', 'high', 'xhigh', 'max'], id)
  }
  assert.deepEqual(getSupportedThinkingLevels(byId('claude-haiku-4-5-20251001')), ['low', 'medium', 'high'])
  for (const id of ['grok-4.6', 'grok-4.7']) {
    assert.deepEqual(getSupportedThinkingLevels(byId(id)), ['low', 'medium', 'high', 'xhigh'], id)
  }
  // The gateway passes no reasoning control through for these: only `off`.
  for (const id of ['gemini-3.8-flash', 'glm-5.3', 'kimi-k3']) {
    assert.equal(byId(id).reasoning, false, id)
    assert.deepEqual(getSupportedThinkingLevels(byId(id)), ['off'], id)
  }
})

test('every reasoning model accepts the route default effort', () => {
  for (const model of GEEK2API_MODELS.filter(item => item.reasoning)) {
    assert.ok(getSupportedThinkingLevels(model).includes(DEFAULT_REASONING_LEVEL), `${model.id} must support ${DEFAULT_REASONING_LEVEL}`)
  }
})

test('declares the wire dialect each protocol needs', () => {
  for (const id of ['deepseek-v4.1-flash', 'deepseek-v4-pro']) {
    assert.equal(byId(id).compat.thinkingFormat, 'deepseek', id)
    assert.equal(byId(id).compat.maxTokensField, 'max_tokens', id)
    assert.equal(byId(id).compat.requiresReasoningContentOnAssistantMessages, true, id)
  }
  // Claude 5.x always thinks adaptively and rejects temperature.
  for (const id of ['claude-opus-5-5', 'claude-sonnet-5-5']) {
    assert.equal(byId(id).compat.forceAdaptiveThinking, true, id)
    assert.equal(byId(id).compat.supportsTemperature, false, id)
  }
  assert.equal(byId('claude-haiku-4-5-20251001').compat, undefined)
  assert.equal(byId('gpt-6.1-sol').compat, undefined)
  for (const id of ['gemini-3.8-flash', 'glm-5.3', 'kimi-k3']) {
    assert.equal(byId(id).compat.supportsDeveloperRole, false, id)
  }
})

test('modelForHost re-roots the base URL and keeps its path', () => {
  const gpt = byId('gpt-6.1-sol')
  const claude = byId('claude-opus-5-5')
  assert.equal(modelForHost(gpt, 'https://hk2.geek2api.com').baseUrl, 'https://hk2.geek2api.com/v1')
  assert.equal(modelForHost(claude, 'https://hk2.geek2api.com').baseUrl, 'https://hk2.geek2api.com')
  assert.equal(modelForHost(gpt, 'https://hk2.geek2api.com').id, 'gpt-6.1-sol')
  assert.equal(gpt.baseUrl, `${DEFAULT_API_HOST}/v1`, 'the catalog entry is untouched')
  assert.equal(modelForHost(gpt, DEFAULT_API_HOST), gpt, 'same host returns the entry itself')
  assert.equal(modelForHost(gpt, undefined), gpt)
  assert.equal(modelForHost(undefined, 'https://x.example'), undefined)
})
