/**
 * Failure classification for the conditions that move the key ring along.
 *
 * The gateway reports an exhausted key and a rejected key in Chinese, and the
 * harness classifies failures by fixed English/status wording it recognizes
 * (`isQuotaExceededError`, `\b401\b`). Normalizing here is what makes the
 * harness's retry policy re-run the step — and therefore what lets the retry
 * pick up the next key. Rewriting is honest about what happened: this plugin
 * knows the key's condition from the gateway's own words plus its balance
 * reader, so the sentence it substitutes says no more than that.
 *
 * @module dsh-geek2api/failures
 */

/**
 * The key itself is gone for good: sub2api's own refusals of the credential
 * (`INVALID_API_KEY`, `API_KEY_DISABLED`, an expired key, an inactive user, a
 * deleted or withdrawn group). Only the gateway's own wording counts; a bare
 * 401 may be an upstream account's error passed through, and must not retire
 * the user's key.
 */
const INVALID_KEY_WORDING = /invalid api key|INVALID_API_KEY|api key is disabled|API_KEY_DISABLED|api key\s*已过期|API_KEY_EXPIRED|user account is not active|USER_INACTIVE|user associated with api key not found|所属分组已删除|所属专属分组不再允许|GROUP_NOT_ALLOWED/iu

/**
 * The key's own spending cap is used up (`API key 额度已用完`). It stays used up
 * until someone raises the cap, so the key is moved aside until re-enabled.
 */
const KEY_QUOTA_WORDING = /api key\s*额度已用完|api key quota exhausted|API_KEY_QUOTA_EXHAUSTED/iu

/**
 * Money that comes back on its own or with a top-up: the account wallet
 * (shared by every key of the account), a subscription window, a key's
 * 5h/1d/7d window, or a per-platform daily quota. The key is skipped for a
 * while, never retired: recharging must not leave keys disabled by hand.
 */
const EXHAUSTED_WORDING = /余额不足，?请充值|INSUFFICIENT_BALANCE|no active subscription|SUBSCRIPTION_NOT_FOUND|(?:daily|weekly|monthly) usage limit exceeded|限额已用完|usage quota exhausted for this platform/iu

/**
 * A group that only serves its vendor's official client. These arrive as
 * 403, which the harness reads as an authentication failure and renders as
 * an invalid-API-key problem — the opposite of what happened, and a condition
 * no retry can clear.
 */
const CLIENT_POLICY_WORDING = /only accessible via the official|only accepts requests from the official|official\s+claude(?:\s+code)?\s+cli|官方\s*claude(?:\s*code)?\s*cli/iu

/**
 * The gateway's answer when the key's group does not serve the model. The key
 * is fine for other models, so it is never moved aside for this. (`No
 * available accounts` is not here: sub2api says that when a pool is busy.)
 */
const COVERAGE_WORDING = /model is not allowed|model is not supported|is not supported by any configured account|is not available\. use get \/v1\/models/iu

/**
 * Whether the gateway refused the model for this key's groups.
 * @param message - the failure text.
 * @returns true for a group-coverage refusal.
 */
export function classifyCoverage(message) {
  return COVERAGE_WORDING.test(typeof message === 'string' ? message : '')
}

/** The key's own cap is used up; move to the next key until re-enabled. */
export const QUOTA_FAILURE = 'quota'
/** Wallet, subscription, or window exhausted; skip the key for a while. */
export const EXHAUSTED_FAILURE = 'exhausted'
/** The gateway rejected the key itself; move to the next key. */
export const INVALID_KEY_FAILURE = 'invalid-key'
/** The gateway refuses this client for the route; the key is not at fault. */
export const CLIENT_POLICY_FAILURE = 'client-policy'

/**
 * Whether the gateway is refusing this client rather than this credential.
 * @param message - provider failure text, as pi-ai carries it.
 * @returns true when the route is gated to a vendor's official client.
 */
export function classifyClientPolicy(message) {
  return CLIENT_POLICY_WORDING.test(typeof message === 'string' ? message : '')
}

/**
 * Classify a gateway failure message by sub2api's own wording.
 * @param message - provider failure text, as pi-ai carries it.
 * @returns the failure kind, or undefined when the key is not at fault.
 */
export function classifyGatewayFailure(message) {
  const text = typeof message === 'string' ? message : ''
  if (text === '') return undefined
  if (classifyClientPolicy(text)) return undefined
  if (INVALID_KEY_WORDING.test(text)) return INVALID_KEY_FAILURE
  if (KEY_QUOTA_WORDING.test(text)) return QUOTA_FAILURE
  if (EXHAUSTED_WORDING.test(text)) return EXHAUSTED_FAILURE
  return undefined
}

/**
 * Explain that no stored key can use the requested model.
 *
 * The sentence carries no status token, so the harness does not retry it:
 * no retry gives a key access to a model its group does not serve.
 * @param modelId - the requested model.
 * @param message - the gateway's own words.
 * @returns the replacement sentence.
 */
export function explainUncoveredModel(modelId, message) {
  const model = typeof modelId === 'string' && modelId !== '' ? modelId : '所选模型'
  const detail = (typeof message === 'string' ? message : '').replace(/\b(?:400|401|403|404)\b/gu, 'HTTP').slice(0, 300)
  return `Geek2API：你保存的 Key 都不能使用 ${model}（Key 所在分组不提供这个模型）。`
    + '请在 设置 → Geek2API 查看每个 Key 后面的 ✓ / ✕，添加一个能用该模型的分组的 Key，或换一个模型。'
    + ` / None of the stored Geek2API keys can use ${model}. Gateway said: ${detail}`
}

/**
 * Explain a client-policy refusal so the user reads the real cause.
 *
 * The sentence must not read as any other failure the harness knows: it
 * deliberately carries no HTTP status and none of the words the classifier
 * matches for auth, quota, rate limits, timeouts, or transport faults. That
 * keeps the failure out of the retry policy — no retry can talk a group into
 * serving an API client — and lets the sentence reach the user verbatim, in
 * place of the "API key is invalid" the bare 403 would have produced.
 * @param keyName - the account name the balance reader saw, when known.
 * @returns the replacement sentence.
 */
export function explainClientPolicyFailure() {
  return 'Geek2API 拒绝了这个客户端：这个 Key 所在分组只允许官方客户端调用'
    + '（例如只允许官方 Claude Code CLI）。'
    + '这不是 API Key 失效，重试也不会成功。'
    + '请在 设置 → Geek2API 把「Claude 运行方式」改为「本机 Claude Code CLI」，'
    + '或换一个允许 API 调用的分组的 Key。'
    + ' / This group only serves the vendor’s official client; the API key is fine and retrying cannot help.'
}

/**
 * The gateway is out of capacity for the moment: its Claude pool's
 * per-account wait queue is full, or it throttled or shed the request. The
 * CLI retries these on its own; this matches what is left when it gave up.
 */
const CAPACITY_WORDING = /no available accounts|concurrency limit exceeded|concurrency_queue_full|并发排队已满|wait queues? (?:are|is) full|负载已饱和|overloaded|rate[_\s-]?limit|API Error:\s*(?:429|502|503|504|529)\b/iu

/**
 * Whether a CLI failure is the gateway being busy rather than a fault of the
 * key, the client, or the request.
 * @param message - the CLI failure text.
 * @returns true for throttling and capacity refusals.
 */
export function classifyCapacity(message) {
  return CAPACITY_WORDING.test(typeof message === 'string' ? message : '')
}

/**
 * Explain a CLI turn that failed because the gateway stayed busy.
 * @param message - the CLI failure text.
 * @param retries - how many retries the CLI reported before giving up.
 * @returns the replacement sentence, with the gateway's own words kept.
 */
export function explainCliCapacityFailure(message, retries) {
  const detail = (typeof message === 'string' ? message : '').replace(/^Claude Code CLI failed:\s*/u, '').slice(0, 600)
  const tried = typeof retries === 'number' && retries > 0 ? `Claude Code CLI 已自动重试 ${retries} 次仍未成功。` : ''
  return `Geek2API 的 Claude 上游暂时繁忙（并发排队已满或被限流）。${tried}`
    + '这不是 API Key 或插件的问题，稍后再发一次即可；着急的话可以先切到 gpt-6.1-sol 或 deepseek-v4.1-flash。'
    + ` / Geek2API's Claude upstream is busy right now; retry shortly. Gateway said: ${detail}`
}

/**
 * Explain a client-policy refusal of a request the local Claude Code CLI made.
 *
 * The request did come from the official CLI, so the HTTP-route advice above
 * (switch to a CLI) does not apply. The gateway's own words are kept, without
 * their HTTP status, so a support request can quote the request ids.
 * @param message - the CLI failure text.
 * @returns the replacement sentence.
 */
export function explainCliClientPolicyFailure(message) {
  const detail = (typeof message === 'string' ? message : '')
    .replace(/^Claude Code CLI failed:\s*/u, '')
    .replace(/\b(?:401|403)\b/gu, 'HTTP')
    .slice(0, 600)
  return 'Geek2API 的上游拒绝了这次 Claude Code CLI 请求，认为它不是官方 Claude Code CLI 发出的。'
    + '这不是 API Key 失效。请先把插件和 Claude Code CLI 都更新到最新版本再试；'
    + '仍然失败时，请把下面的原始错误（含 request id）通过 Geek2API 工单发给客服，确认所用分组是否支持 Claude Code 的 -p（非交互）模式。'
    + ` / The gateway refused this Claude Code CLI request as not coming from the official CLI; the API key is fine. Gateway said: ${detail}`
}

/**
 * Explain a CLI refusal that came from the key, not the CLI: the key's groups
 * cannot reach the requested model. Geek2API answers such a Claude request
 * with the same "only the official Claude Code CLI" wording a real client
 * fault gets, so without the key's groups it read as a CLI problem and sent
 * the user to update the CLI.
 * @param key - the run's key: label, groups, the model, and the groups that
 *   can serve it, as the group reader last saw them.
 * @param message - the CLI failure text.
 * @returns the replacement sentence, with the gateway's own words kept.
 */
export function explainCliGroupFailure(key, message) {
  // No retry can change a key's groups: keep every status token out of the
  // sentence so the harness does not read it as a retryable failure.
  const detail = (typeof message === 'string' ? message : '')
    .replace(/^Claude Code CLI failed:\s*/u, '')
    .replace(/\b(?:400|401|403)\b/gu, 'HTTP')
    .slice(0, 400)
  const groups = Array.isArray(key?.groups) && key.groups.length > 0 ? key.groups.join('、') : '未读到'
  const required = Array.isArray(key?.required) && key.required.length > 0 ? key.required.join(' / ') : 'Claude 分组'
  const model = typeof key?.model === 'string' && key.model !== '' ? key.model : 'Claude'
  return `Geek2API 拒绝了这次 ${model} 请求：本轮使用的 Key「${key?.label ?? '?'}」所在分组（${groups}）不包含能用 ${model} 的分组（${required}）。`
    + '这不是 Claude Code CLI 的问题，不需要更新 CLI。'
    + '请在 设置 → Geek2API 添加分组包含上述分组的 Key（每个 Key 后面会列出它的分组），插件会自动用它跑 Claude；或在 Geek2API 控制台给这个 Key 加上对应分组。'
    + ` / The key "${key?.label ?? '?'}" is in no group that serves ${model} (needs one of: ${required}); the CLI is fine. Gateway said: ${detail}`
}

/**
 * Rewrite a failure message so the harness classifies it as quota or auth.
 *
 * A bare status token is neutralized first: an exhausted balance arrives as
 * 402 or 403 on some gateway routes, and the harness's auth rule matches
 * 401/403 before it reads any wording, which would send the failure into a
 * category the retry policy does not re-run.
 * @param message - the original provider failure text.
 * @param kind - the classification of {@link classifyGatewayFailure}.
 * @param options - optional account name for the policy explanation.
 * @returns text the harness routes to QUOTA or AUTH, or a policy explanation.
 */
export function normalizeFailureMessage(message, kind, options = {}) {
  const text = typeof message === 'string' && message.length > 0 ? message : 'Geek2API request failed'
  if (kind === CLIENT_POLICY_FAILURE) return explainClientPolicyFailure(options.keyName)
  if (kind === QUOTA_FAILURE || kind === EXHAUSTED_FAILURE) {
    return `${neutralizeAuthStatus(text)} — Geek2API: insufficient quota for this API key; trying the next key`
  }
  if (kind === INVALID_KEY_FAILURE) {
    return `${neutralizeAuthStatus(text)} — Geek2API: 401 invalid_authentication for this API key; trying the next key`
  }
  return text
}

function neutralizeAuthStatus(text) {
  return text.replace(/\b(?:401|403)\b/gu, 'HTTP')
}
