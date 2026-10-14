/**
 * The Geek2API pi-ai provider, built in code so the user configures no route.
 *
 * `createProvider` dispatches on `model.api`, which is what lets one route
 * carry a chat/completions model, a Responses model, and an Anthropic Messages
 * model — the gateway refuses each of them over the other protocols.
 *
 * @module dsh-geek2api/provider
 */

import { createProvider } from '@earendil-works/pi-ai'
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy'

import { GEEK2API_MODELS } from './catalog.js'
import { DEFAULT_API_HOST, DISPLAY_NAME, PROVIDER } from './constants.js'
import { classifyClientPolicy, classifyCoverage, classifyGatewayFailure, explainClientPolicyFailure, explainUncoveredModel, normalizeFailureMessage } from './failures.js'
import { isTransportFailure } from './hosts.js'

const TERMINAL_EVENTS = new Set(['error', 'done'])

/**
 * The api-key method pi-ai consults before it honours a request's `apiKey`
 * override. Resolution itself stays empty: this plugin authenticates from its
 * own key ring through the adapter, and ambient `GEEK2API_API_KEY` discovery
 * is disabled at the adapter's auth context.
 * @returns the provider auth for this route.
 */
function keyRingAuth() {
  return {
    apiKey: {
      name: DISPLAY_NAME,
      resolve: () => Promise.resolve({ auth: {}, source: DISPLAY_NAME }),
    },
  }
}

/** Build the route's pi-ai provider (unguarded; the plugin wraps its streams). */
export function createGeek2APIProvider() {
  const provider = createProvider({
    id: PROVIDER,
    name: DISPLAY_NAME,
    baseUrl: DEFAULT_API_HOST,
    auth: keyRingAuth(),
    models: GEEK2API_MODELS,
    api: {
      'openai-completions': openAICompletionsApi(),
      'openai-responses': openAIResponsesApi(),
      'anthropic-messages': anthropicMessagesApi(),
    },
  })
  // Only GPT's Responses route requires prompt_cache_key here. Sending it
  // to Grok makes the gateway return a misleading upstream API-key error.
  // pi-ai's public cacheRetention option omits this field without changing
  // the model, protocol, reasoning, session headers, or credential source.
  const requestOptions = (model, options) => model.api === 'openai-responses' && !model.id.startsWith('gpt-')
    ? { ...options, cacheRetention: 'none' }
    : options
  return Object.freeze({
    ...provider,
    stream: (model, context, options) => provider.stream(model, context, requestOptions(model, options)),
    streamSimple: (model, context, options) => provider.streamSimple(model, context, requestOptions(model, options)),
  })
}

/**
 * Observe a pi-ai event stream and hand a key-level failure to the plugin.
 *
 * pi-ai reports request failures as terminal events carrying the assistant
 * message's `errorMessage`, and transport failures as thrown errors. Both are
 * classified here; the substituted sentence is what makes the harness's retry
 * policy re-run the step, which is the mechanism that reaches the next key. A
 * thrown failure is only attributed to the key when no chunk arrived: a stream
 * that broke mid-answer had already been accepted by the gateway.
 * @param stream - the pi-ai event stream.
 * @param options - the request's key plus the failure sink.
 * @returns the same stream, with key-level failures classified and rewritten.
 */
export function guardKeyRotation(stream, { onKeyFailure, key, onHostFailure, modelId } = {}) {
  if (stream === null || typeof stream !== 'object') return stream
  let observed = false
  let answered = false

  const report = (kind, message) => onKeyFailure?.(kind, message, key)
  /**
   * A request that never reached the gateway is the host's fault, not the
   * key's: set the host aside so the retry goes to another entry point.
   */
  const reportHost = message => {
    if (!answered && isTransportFailure(message)) onHostFailure?.(message)
  }

  const inspect = value => {
    if (value === null || typeof value !== 'object') return value
    if (!TERMINAL_EVENTS.has(value.type)) {
      answered = true
      return value
    }
    for (const carrierKey of ['error', 'message']) {
      const carrier = value[carrierKey]
      if (carrier === null || typeof carrier !== 'object') continue
      if (value.type === 'error') reportHost(carrier.errorMessage)
      // A client-policy refusal is about this client, not this key: explain it
      // and leave the ring alone.
      if (classifyClientPolicy(carrier.errorMessage)) {
        return { ...value, [carrierKey]: { ...carrier, errorMessage: explainClientPolicyFailure() } }
      }
      const kind = classifyGatewayFailure(carrier.errorMessage)
      if (kind === undefined) {
        // The chooser already preferred a key that reaches the model; this
        // refusal means none of the stored keys does.
        if (classifyCoverage(carrier.errorMessage)) {
          return { ...value, [carrierKey]: { ...carrier, errorMessage: explainUncoveredModel(modelId, carrier.errorMessage) } }
        }
        continue
      }
      report(kind, carrier.errorMessage)
      return { ...value, [carrierKey]: { ...carrier, errorMessage: normalizeFailureMessage(carrier.errorMessage, kind) } }
    }
    return value
  }

  return new Proxy(stream, {
    get(target, prop, receiver) {
      if (prop === Symbol.asyncIterator) {
        return () => {
          const iterator = Reflect.get(target, Symbol.asyncIterator).call(target)
          return {
            next: async (...args) => {
              try {
                const item = await iterator.next(...args)
                observed = true
                if (item === null || typeof item !== 'object' || item.done === true) return item
                const value = inspect(item.value)
                return value === item.value ? item : { ...item, value }
              } catch (error) {
                const text = error instanceof Error ? error.message : String(error)
                if (!observed) reportHost(error)
                // The policy refusal is worth explaining even mid-stream; a
                // key fault is only the key's when nothing was answered yet.
                if (classifyClientPolicy(text)) {
                  throw new Error(explainClientPolicyFailure(), { cause: error })
                }
                const kind = observed ? undefined : classifyGatewayFailure(text)
                if (kind !== undefined) {
                  report(kind, text)
                  throw new Error(normalizeFailureMessage(text, kind), { cause: error })
                }
                throw error
              }
            },
            ...(typeof iterator.return === 'function' ? { return: (...args) => iterator.return(...args) } : {}),
            ...(typeof iterator.throw === 'function' ? { throw: (...args) => iterator.throw(...args) } : {}),
          }
        }
      }
      const value = Reflect.get(target, prop, receiver)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}
