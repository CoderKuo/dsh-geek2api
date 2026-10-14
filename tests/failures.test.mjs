import assert from 'node:assert/strict'
import test from 'node:test'

import { isQuotaExceededError } from '@deepseek-ai/dsh-llm'

import {
  CLIENT_POLICY_FAILURE,
  INVALID_KEY_FAILURE,
  QUOTA_FAILURE,
  classifyCapacity,
  classifyClientPolicy,
  classifyCoverage,
  classifyGatewayFailure,
  explainUncoveredModel,
  explainClientPolicyFailure,
  explainCliCapacityFailure,
  normalizeFailureMessage,
} from '../src/failures.js'

const AUTH_STATUS = /\b(?:401|403)\b/u
/** Every wording the harness routes somewhere other than a plain failure. */
const OTHER_CLASSES = [
  /\b(?:401|403)\b/u,
  /\b429\b|rate.?limit/iu,
  /\b413\b|payload too large|request body too large/iu,
  /\b400\b|invalid.?request/iu,
  /\b5\d\d\b/u,
  /\btime(?:d)?\s*out\b|timeout/iu,
  /stream ended (?:before|without)\b/iu,
  /\b(?:network|connection|socket|fetch)\b|\bECONN[A-Z]+\b|\bterminated\b|premature close/iu,
]

test('recognizes an exhausted key from the gateway wording', () => {
  assert.equal(classifyGatewayFailure('402 {"error":{"message":"当前令牌额度已用完"}}'), QUOTA_FAILURE)
  assert.equal(classifyGatewayFailure('insufficient quota'), QUOTA_FAILURE)
  assert.equal(classifyGatewayFailure('余额不足，请充值'), QUOTA_FAILURE)
})

test('recognizes a rejected key from its status or wording', () => {
  assert.equal(classifyGatewayFailure('401 {"error":{"message":"无效的令牌"}}'), INVALID_KEY_FAILURE)
  assert.equal(classifyGatewayFailure('invalid api key'), INVALID_KEY_FAILURE)
  assert.equal(classifyGatewayFailure('api key is invalid'), INVALID_KEY_FAILURE)
})

test('leaves transient gateway faults to the key it already used', () => {
  const channelFault = '400 {"error":{"code":"model_not_found","message":"当前令牌未覆盖供应商 \\"Anthropic\\"（模型=claude-opus-5-5）"}}'
  assert.equal(classifyGatewayFailure(channelFault), undefined)
  assert.equal(classifyGatewayFailure('503 {"error":{"message":"分组 cc-sale 下模型 claude-opus-5-5 无可用渠道"}}'), undefined)
  assert.equal(classifyGatewayFailure(''), undefined)
  assert.equal(classifyGatewayFailure(undefined), undefined)
})

test('a normalized quota failure lands in the harness quota category', () => {
  const raw = '403 {"error":{"message":"当前令牌额度已用完 (request id: 01M4)"}}'
  const kind = classifyGatewayFailure(raw)
  assert.equal(kind, QUOTA_FAILURE)
  const normalized = normalizeFailureMessage(raw, kind)
  assert.equal(isQuotaExceededError(normalized), true)
  // The gateway's 403 must not send this into the auth category first.
  assert.equal(AUTH_STATUS.test(normalized), false)
  // The gateway's own sentence survives, so the user sees what happened.
  assert.match(normalized, /当前令牌额度已用完/u)
  assert.match(normalized, /trying the next key/u)
})

test('a normalized key rejection lands in the harness auth category', () => {
  const raw = '{"error":{"message":"无效的令牌 (request id: 01M4)"}}'
  const kind = classifyGatewayFailure(raw)
  assert.equal(kind, INVALID_KEY_FAILURE)
  const normalized = normalizeFailureMessage(raw, kind)
  assert.equal(AUTH_STATUS.test(normalized), true)
  assert.equal(isQuotaExceededError(normalized), false)
  assert.match(normalized, /invalid_authentication/u)
})

test('a client-policy refusal is never blamed on the key', () => {
  const claude = '403 {"error":{"type":"geek2api_api_error","message":"This API endpoint is only accessible via the official Claude CLI (request id: 01M4Q6FJ05BX8Z4SWZ01RXSNSS)"}}'
  const codex = '403 {"error":{"message":"我们检测到您的客户端存在异常，请使用标准 Codex 客户端请求，请避免任何基于我方 API 二次分发的 API 转接接入。"}}'
  for (const raw of [claude, codex]) {
    assert.equal(classifyClientPolicy(raw), true)
    // Not a key fault: nothing may disable or rotate a key for this.
    assert.equal(classifyGatewayFailure(raw), undefined)
  }
})

test('the policy explanation reaches the user instead of an API-key error', () => {
  const raw = '403 {"error":{"message":"This API endpoint is only accessible via the official Claude CLI"}}'
  const normalized = normalizeFailureMessage(raw, CLIENT_POLICY_FAILURE)
  assert.equal(normalized, explainClientPolicyFailure())
  assert.match(normalized, /这不是 API Key 失效/u)
  assert.match(normalized, /Claude 运行方式/u)
  // It must not read as any category the retry policy re-runs.
  assert.equal(isQuotaExceededError(normalized), false)
  for (const pattern of OTHER_CLASSES) {
    assert.equal(pattern.test(normalized), false, `${pattern} must not match the policy sentence`)
  }
})

test('the upstream wording for a Claude Code-only route is a client-policy refusal, not a key fault', () => {
  const raw = '403 {"error":{"type":"geek2api_<nil>","message":"Request blocked: this endpoint only accepts requests from the official Claude Code CLI. (request id: x)"}}'
  assert.equal(classifyClientPolicy(raw), true)
  assert.equal(classifyGatewayFailure(raw), undefined)
})

test('a busy gateway is told apart from key, quota, and client faults', () => {
  assert.equal(classifyCapacity('API Error: 503 {"error":{"type":"geek2api_concurrency_queue_full","message":"账号并发排队已满，请稍后重试。"}}'), true)
  assert.equal(classifyCapacity('API Error: 429 rate_limit_error'), true)
  assert.equal(classifyCapacity('API Error: 529 overloaded_error'), true)
  assert.equal(classifyCapacity('API Error: 401 无效的令牌'), false)
  assert.equal(classifyCapacity('Request blocked: official Claude Code CLI only'), false)
  const text = explainCliCapacityFailure('Claude Code CLI failed: API Error: 503 queue full', 10)
  assert.match(text, /已自动重试 10 次/u)
  assert.match(text, /Gateway said: API Error: 503 queue full$/u)
  assert.equal(explainCliCapacityFailure('x', 0).includes('已自动重试'), false)
})

test('classifies the sub2api gateway wording', () => {
  // Key faults that move the ring along.
  assert.equal(classifyGatewayFailure('401 {"code":"INVALID_API_KEY","message":"Invalid API key"}'), INVALID_KEY_FAILURE)
  assert.equal(classifyGatewayFailure('401 {"code":"API_KEY_DISABLED","message":"API key is disabled"}'), INVALID_KEY_FAILURE)
  assert.equal(classifyGatewayFailure('403 {"code":"API_KEY_EXPIRED","message":"API key 已过期"}'), INVALID_KEY_FAILURE)
  assert.equal(classifyGatewayFailure('403 {"message":"API Key 所属分组已删除"}'), INVALID_KEY_FAILURE)
  assert.equal(classifyGatewayFailure('403 {"code":"GROUP_NOT_ALLOWED","message":"API Key 所属专属分组不再允许当前用户使用"}'), INVALID_KEY_FAILURE)
  assert.equal(classifyGatewayFailure('403 {"code":"INSUFFICIENT_BALANCE","message":"余额不足，请充值"}'), QUOTA_FAILURE)
  assert.equal(classifyGatewayFailure('403 {"code":"SUBSCRIPTION_NOT_FOUND","message":"No active subscription found for this group"}'), QUOTA_FAILURE)

  // A model the key's group does not serve is coverage, never a key fault.
  const missing = `400 {"error":{"message":"Model 'kimi-k3' is not available. Use GET /v1/models to see supported models.","type":"invalid_request_error"}}`
  assert.equal(classifyGatewayFailure(missing), undefined)
  assert.equal(classifyCoverage(missing), true)
  assert.equal(classifyCoverage('503 No available accounts'), true)
  assert.equal(classifyCoverage('Model is not allowed'), true)
  assert.equal(classifyCoverage('500 upstream exploded'), false)
})

test('an uncovered model is explained without any wording the harness retries', () => {
  const raw = `400 {"error":{"message":"Model 'kimi-k3' is not available. Use GET /v1/models to see supported models."}}`
  const explained = explainUncoveredModel('kimi-k3', raw)
  assert.match(explained, /你保存的 Key 都不能使用 kimi-k3/u)
  assert.match(explained, /is not available/u, 'the gateway words are kept')
  assert.equal(isQuotaExceededError(explained), false)
  assert.doesNotMatch(explained, /\b(?:400|401|403)\b/u)
  assert.match(explainUncoveredModel(undefined, ''), /所选模型/u)
})
