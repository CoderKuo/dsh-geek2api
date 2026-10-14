/**
 * The HTTP model route: the pi-ai provider profile and the adapter that
 * serves the catalog's HTTP models (DeepSeek, GPT and Grok) with the ring's keys.
 *
 * @module dsh-geek2api/route
 */

import { LlmError, QUOTA_EXCEEDED_CODE, resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'

import { DEFAULT_REASONING_LEVEL, DISPLAY_NAME, PLUGIN_ID, PROVIDER } from './constants.js'
import { GEEK2API_MODELS, modelForHost } from './catalog.js'
import { createGeek2APIProvider, guardKeyRotation } from './provider.js'

/**
 * Request-level bounds from the shipped pi-ai adapter: a bounded image payload
 * keeps a long session completing requests instead of being refused by a
 * gateway size cap.
 */
/** Catalog models that take no reasoning control. */
const NON_REASONING_MODEL_IDS = new Set(GEEK2API_MODELS.filter(model => model.reasoning !== true).map(model => model.id))

const REQUEST_LIMITS = Object.freeze({
  streamIdleTimeoutMs: 10 * 60 * 1000,
  maxRequestImageBytes: 20 * 1024 * 1024,
  requestImagePixelBudget: 2048 * 2048,
  requestImageMaxBytes: 1024 * 1024,
})

/**
 * pi-ai's credential store over the key ring.
 *
 * Reads answer with the active key so pi-ai's own auth reporting stays honest,
 * while writes are refused: the ring owns them, because only the ring can move
 * the active pointer past a key the gateway rejected.
 * @param ring - the plugin's key ring.
 * @returns a pi-ai `CredentialStore`.
 */
function ringCredentialStore(ring) {
  const managed = () => {
    throw new Error('Geek2API API keys are managed in the Geek2API settings section')
  }
  return {
    async read() {
      const active = await ring.activeKey()
      return active === undefined ? undefined : { type: 'api_key', key: active.key }
    },
    async list() {
      const active = await ring.activeKey()
      return active === undefined ? [] : [{ providerId: PROVIDER, type: 'api_key' }]
    },
    modify: managed,
    delete: managed,
  }
}

/**
 * The provider profile this route runs on.
 *
 * `modelErrors` and `configuredMaxTokens` are required by the host adapter;
 * they stay empty because the catalog is fixed and no model carries a
 * per-request output cap of its own.
 * @param provider - the route's pi-ai provider.
 * @returns the frozen profile handed to `PiAiAdapter`.
 */
export function createGeek2APIProfile(provider) {
  return Object.freeze({
    provider: PROVIDER,
    displayName: DISPLAY_NAME,
    piProvider: provider,
    reasoning: DEFAULT_REASONING_LEVEL,
    configuredMaxTokens: new Map(),
    modelErrors: new Map(),
    ...REQUEST_LIMITS,
    cacheRetention: 'short',
    retryPolicy: resolveRetryPolicy({
      mode: 'normal',
      // One route carries every model, so this count covers all of them. The
      // gateway drops an upstream channel or key per request, and a retry is
      // also the mechanism that reaches the next key — a long budget is what
      // turns those blips into a slower answer instead of a failed turn.
      // Worst case with the default backoff (0.5s doubling, capped at 10s) is
      // roughly three minutes before the failure is surfaced.
      maxRetries: 20,
      // A retry is the mechanism that reaches the next key (and, after a
      // transport failure, the next host), so the two key-level codes belong
      // here. A 400 is not: this gateway means it ("Model 'x' is not
      // available"), and retrying it would only delay the answer.
      retryableCodes: [
        'EMPTY_RESPONSE',
        'RATE_LIMIT',
        'SERVER',
        'TIMEOUT',
        'TRANSPORT',
        QUOTA_EXCEEDED_CODE,
        'AUTH',
      ],
    }, `${PLUGIN_ID}.retryPolicy`),
  })
}

/**
 * The HTTP route's adapter.
 *
 * Each request resolves the active key, then runs on the key the chooser picks
 * for its model; a key-level failure in the stream moves that key aside.
 * @param options - the key ring and chooser, the session id used when a caller
 *   supplies none, and the attachment store image input is read from.
 * @returns a `PiAiAdapter` serving the `geek2api` route.
 */
export function createRouteAdapter({ ring, keys, hosts, fallbackSessionId, resolveAttachments, isModelVisible = () => true }) {
  const raw = createGeek2APIProvider()
  /**
   * GPT on Responses carries a `prompt_cache_key`, which pi-ai derives from
   * the session id; it keeps one conversation on the same upstream cache.
   * The harness supplies one for every agent turn; the fallback covers a
   * caller that does not, so the route never fails for a missing cache key.
   */
  const requestOptions = (model, options) => {
    const withId = options === undefined || options.sessionId !== undefined
      ? options
      : { ...options, sessionId: fallbackSessionId }
    if (typeof withId?.apiKey !== 'string') return withId
    const key = keys.forRequest(model?.id, withId.apiKey)
    return key === withId.apiKey ? withId : { ...withId, apiKey: key }
  }
  /**
   * Each request goes to the host the pool prefers right now; a request that
   * never reached it sets that host aside, so the harness's retry of the step
   * lands on the next one.
   */
  const guarded = method => (model, context, options) => {
    const routed = requestOptions(model, options)
    const host = hosts?.current()
    const target = modelForHost(model, host)
    return guardKeyRotation(raw[method](target, context, routed), {
      key: routed?.apiKey,
      modelId: model?.id,
      onKeyFailure: keys.onKeyFailure,
      onHostFailure: reason => hosts?.fail(host, reason),
    })
  }
  const provider = Object.freeze({ ...raw, stream: guarded('stream'), streamSimple: guarded('streamSimple') })
  const profiles = new Map([[PROVIDER, createGeek2APIProfile(provider)]])

  // Visibility affects discovery only. Resolution and prepared/in-flight
  // turns still use the complete catalog, including a now-hidden model.
  return new (class extends PiAiAdapter {
    async listModels(provider) {
      return (await super.listModels(provider)).filter(model => isModelVisible(model.id))
    }

    /**
     * A model without reasoning accepts only `off`, but the profile's default
     * effort applies to every model on the route. Ask such a model for `off`
     * so a session that names no effort does not fail before the request.
     */
    streamWithSnapshot(options, snapshot) {
      const model = NON_REASONING_MODEL_IDS.has(options?.model) ? { ...options, reasoningEffort: 'off' } : options
      return super.streamWithSnapshot(model, snapshot)
    }
  })({
    profiles: () => profiles,
    resolveApiKey: async () => {
      const active = await keys.active()
      if (active === undefined) {
        throw new LlmError(
          'No usable Geek2API API key: add one under Settings → Geek2API, or re-enable the keys this plugin moved past.',
          'MISSING_CREDENTIAL',
        )
      }
      return active.key
    },
    auth: Object.freeze({
      credentials: ringCredentialStore(ring),
      // Keys are explicitly stored by this plugin; an ambient
      // GEEK2API_API_KEY must never authenticate a request on its own.
      authContext: Object.freeze({
        env: async () => undefined,
        fileExists: async () => false,
      }),
    }),
    resolveAttachments,
  })
}
