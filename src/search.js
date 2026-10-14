/**
 * Geek2API web search for the DSH `web` seam.
 *
 * Two search providers register with `ctx.web`:
 * - `geek2api` searches through Geek2API for every request.
 * - `geek2api-auto` searches through Geek2API only when the initiating
 *   session runs on a Geek2API model, and hands every other request to the
 *   provider DSH would have used without this plugin.
 *
 * Geek2API has no dedicated search endpoint; a search is one model call with
 * the vendor's server-side search tool. The user picks the backend:
 * - `claude`: Anthropic Messages at `/v1/messages`, `claude-haiku-4-5-20251001`, with
 *   the `web_search_20250305` server tool. Results come from its structured
 *   `web_search_tool_result` blocks, never from prose.
 * - `gpt`: OpenAI Responses at `/v1/responses`, `gpt-6.1-sol`, with the
 *   hosted `web_search` tool. Results come from `url_citation` annotations and
 *   the `web_search_call` actions.
 *
 * Only keys stored in this plugin's key ring authenticate a search; there is no
 * fallback to another credential. A key the gateway reports as exhausted or
 * rejected is moved aside exactly as on the model route, and the search tries
 * the next usable key.
 *
 * @module dsh-geek2api/search
 */

import { AsyncLocalStorage } from 'node:async_hooks'

import { HarnessError } from '@deepseek-ai/dsh-llm'

import { PROVIDER } from './constants.js'
import { classifyClientPolicy, classifyCoverage, classifyGatewayFailure, explainClientPolicyFailure } from './failures.js'
import { isTransportFailure } from './hosts.js'
import { ambientFetch, boundedFetch } from './request.js'

/** Search provider that always searches through Geek2API. */
export const GEEK2API_SEARCH_PROVIDER_ID = 'geek2api'
/** Search provider that routes by the initiating session's model provider. */
export const GEEK2API_AUTO_SEARCH_PROVIDER_ID = 'geek2api-auto'
/** Both ids this plugin registers; neither may serve as its own fallback. */
export const OWN_SEARCH_PROVIDER_IDS = Object.freeze([GEEK2API_SEARCH_PROVIDER_ID, GEEK2API_AUTO_SEARCH_PROVIDER_ID])
/** DSH's built-in search provider, the fallback when nothing else is known. */
export const DSH_SEARCH_PROVIDER_FALLBACK = 'deepseek-official'

/** Search routing the user picks. */
export const SEARCH_MODE_DEFAULT = 'default'
export const SEARCH_MODE_AUTO = 'auto'
export const SEARCH_MODE_GEEK2API = 'geek2api'
export const SEARCH_MODES = Object.freeze([SEARCH_MODE_DEFAULT, SEARCH_MODE_AUTO, SEARCH_MODE_GEEK2API])

/** Search backends the user picks between. */
export const SEARCH_BACKEND_CLAUDE = 'claude'
export const SEARCH_BACKEND_GPT = 'gpt'
export const SEARCH_BACKENDS = Object.freeze([SEARCH_BACKEND_CLAUDE, SEARCH_BACKEND_GPT])
/**
 * Claude is the default: Haiku 4.5 runs the server tool for about 8.5K input
 * tokens per search in the live check. GPT search reads far more (about 26K
 * input tokens). DeepSeek is not offered: this gateway's DeepSeek groups drop
 * the server tool and the model answers without searching.
 */
export const DEFAULT_SEARCH_BACKEND = SEARCH_BACKEND_CLAUDE

/** The model each backend searches with. */
export const SEARCH_BACKEND_MODELS = Object.freeze({
  [SEARCH_BACKEND_CLAUDE]: 'claude-haiku-4-5-20251001',
  [SEARCH_BACKEND_GPT]: 'gpt-6.1-sol',
})

/** Bound on one search request, below the `web_search` tool's 60 s budget. */
export const DEFAULT_SEARCH_TIMEOUT_MS = 55_000
/** Upper bound on server-side searches inside one DeepSeek request. */
const MESSAGES_MAX_USES = 3
const MAX_OUTPUT_TOKENS = 4096
const ANTHROPIC_VERSION = '2023-06-01'
/** Distinct keys one search may try before reporting the last failure. */
const MAX_KEY_ATTEMPTS = 4
const MAX_CONTENT_CHARS = 4000
const MAX_SNIPPET_CHARS = 500
const MAX_TITLE_CHARS = 200
const MAX_SOURCES = 20
const MAX_ERROR_DETAIL_CHARS = 400

/**
 * Error shape of the DSH web seam. `@deepseek-ai/dsh-web` defines `WebError`
 * as a bare `HarnessError` subclass with a machine-routable `code`; consumers
 * route on that code, so this mirror avoids a peer dependency on the package.
 */
export class WebError extends HarnessError {}

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const text = value => (typeof value === 'string' ? value : '')

function bounded(value, maximum) {
  const clean = text(value).replace(/\s+/gu, ' ').trim()
  if (clean === '') return undefined
  return clean.length <= maximum ? clean : `${clean.slice(0, maximum - 1)}…`
}

function boundedBlock(value, maximum) {
  const clean = text(value).trim()
  if (clean === '') return undefined
  return clean.length <= maximum ? clean : `${clean.slice(0, maximum - 1)}…`
}

function httpUrl(value) {
  const url = text(value)
  if (url === '') return undefined
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed : undefined
  } catch {
    return undefined
  }
}

/** Accumulates sources by URL, first sighting wins, missing fields filled later. */
function sourceList() {
  const byUrl = new Map()
  return {
    add({ url, title, snippet, publishedAt }) {
      const parsed = httpUrl(url)
      if (parsed === undefined) return
      const key = parsed.href
      const existing = byUrl.get(key)
      if (existing === undefined) {
        if (byUrl.size >= MAX_SOURCES) return
        byUrl.set(key, {
          url: text(url),
          title: bounded(title, MAX_TITLE_CHARS) ?? parsed.hostname,
          ...(bounded(snippet, MAX_SNIPPET_CHARS) === undefined ? {} : { snippet: bounded(snippet, MAX_SNIPPET_CHARS) }),
          ...(bounded(publishedAt, 64) === undefined ? {} : { publishedAt: bounded(publishedAt, 64) }),
        })
        return
      }
      if (existing.title === parsed.hostname && bounded(title, MAX_TITLE_CHARS) !== undefined) existing.title = bounded(title, MAX_TITLE_CHARS)
      if (existing.snippet === undefined && bounded(snippet, MAX_SNIPPET_CHARS) !== undefined) existing.snippet = bounded(snippet, MAX_SNIPPET_CHARS)
      if (existing.publishedAt === undefined && bounded(publishedAt, 64) !== undefined) existing.publishedAt = bounded(publishedAt, 64)
    },
    values: () => [...byUrl.values()],
  }
}

function result(sources, content) {
  return {
    ...(content === undefined ? {} : { content }),
    sources,
    truncated: false,
  }
}

/**
 * Map an Anthropic Messages response with native search to a search result.
 * Sources come from `web_search_tool_result` blocks; a text block's citation
 * excerpt becomes its source's snippet; the answer text becomes `content`.
 * @param response - parsed Messages response body.
 * @returns the normalized search result.
 * @throws {WebError} when the response carries no search result block.
 */
export function parseMessagesSearchResponse(response) {
  const blocks = Array.isArray(response?.content) ? response.content : []
  const resultBlocks = blocks.filter(block => block?.type === 'web_search_tool_result')
  if (resultBlocks.length === 0) {
    throw new WebError('Geek2API search returned no web_search_tool_result block; the model did not run a web search', 'WEB_PROVIDER_ERROR')
  }
  const sources = sourceList()
  const errors = []
  for (const block of resultBlocks) {
    if (!Array.isArray(block.content)) {
      if (record(block.content) && text(block.content.error_code) !== '') errors.push(block.content.error_code)
      continue
    }
    for (const item of block.content) {
      if (item?.type !== 'web_search_result') continue
      sources.add({ url: item.url, title: item.title, publishedAt: item.page_age })
    }
  }
  for (const block of blocks) {
    if (block?.type !== 'text' || !Array.isArray(block.citations)) continue
    for (const cite of block.citations) sources.add({ url: cite?.url, title: cite?.title, snippet: cite?.cited_text })
  }
  const found = sources.values()
  if (found.length === 0 && errors.length > 0) {
    throw new WebError(`Geek2API search failed upstream (${errors.join(', ')})`, 'WEB_PROVIDER_ERROR')
  }
  const answer = boundedBlock(blocks.filter(block => block?.type === 'text').map(block => text(block.text)).join(''), MAX_CONTENT_CHARS)
  return result(found, answer)
}

/**
 * Map an OpenAI Responses response with the hosted search tool to a search
 * result. Cited URLs come first with their titles, then every other URL the
 * search actions surfaced; the final message becomes `content`.
 * @param response - parsed Responses body.
 * @returns the normalized search result.
 * @throws {WebError} when the model ran no web search.
 */
export function parseResponsesSearchResponse(response) {
  const output = Array.isArray(response?.output) ? response.output : []
  const calls = output.filter(item => item?.type === 'web_search_call')
  if (calls.length === 0) {
    throw new WebError('Geek2API search returned no web_search_call; the model did not run a web search', 'WEB_PROVIDER_ERROR')
  }
  const sources = sourceList()
  let answer
  for (const item of output) {
    if (item?.type !== 'message' || !Array.isArray(item.content)) continue
    const parts = []
    for (const part of item.content) {
      if (part?.type !== 'output_text') continue
      parts.push(text(part.text))
      for (const annotation of Array.isArray(part.annotations) ? part.annotations : []) {
        if (annotation?.type === 'url_citation') sources.add({ url: annotation.url, title: annotation.title })
      }
    }
    const joined = parts.join('')
    if (joined.trim() !== '') answer = joined
  }
  for (const call of calls) {
    const action = record(call.action) ? call.action : {}
    if (text(action.url) !== '') sources.add({ url: action.url })
    for (const source of Array.isArray(action.sources) ? action.sources : []) sources.add({ url: source?.url, title: source?.title })
  }
  return result(sources.values(), boundedBlock(answer, MAX_CONTENT_CHARS))
}

/** Build one backend's request; the key is attached by the caller. */
export function buildSearchRequest(backend, { apiHost, query, sessionId }) {
  const model = SEARCH_BACKEND_MODELS[backend]
  if (backend === SEARCH_BACKEND_GPT) {
    return {
      url: `${apiHost}/v1/responses`,
      model,
      headers: key => ({ authorization: `Bearer ${key}` }),
      body: {
        model,
        // Message-shaped input is accepted by every Responses upstream.
        input: [{
          role: 'user',
          content: [{
            type: 'input_text',
            text: `Search the web for: ${query}\n\nReply with a concise factual summary of what the sources say, citing them.`,
          }],
        }],
        tools: [{ type: 'web_search' }],
        tool_choice: 'required',
        include: ['web_search_call.action.sources'],
        reasoning: { effort: 'low' },
        max_output_tokens: MAX_OUTPUT_TOKENS,
        store: false,
        ...(typeof sessionId === 'string' && sessionId !== '' ? { prompt_cache_key: sessionId } : {}),
      },
      parse: parseResponsesSearchResponse,
    }
  }
  if (backend === SEARCH_BACKEND_CLAUDE) {
    return {
      url: `${apiHost}/v1/messages`,
      model,
      headers: key => ({ 'x-api-key': key, 'anthropic-version': ANTHROPIC_VERSION }),
      body: {
        model,
        max_tokens: MAX_OUTPUT_TOKENS,
        messages: [{
          role: 'user',
          content: `Perform a web search for the query: ${query}\n\nThen reply with a concise factual summary of what the results say.`,
        }],
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: MESSAGES_MAX_USES }],
      },
      parse: parseMessagesSearchResponse,
    }
  }
  throw new WebError(`Geek2API search backend "${String(backend)}" is not supported`, 'WEB_PROVIDER_UNAVAILABLE')
}

/** Read a failure body as bounded text, preferring the gateway's own message. */
async function failureText(response) {
  let raw = ''
  try {
    raw = await response.text()
  } catch {
    return ''
  }
  try {
    const parsed = JSON.parse(raw)
    const message = typeof parsed?.error === 'string' ? parsed.error : parsed?.error?.message ?? parsed?.message
    if (typeof message === 'string' && message !== '') {
      const code = typeof parsed?.error?.code === 'string' && parsed.error.code !== '' ? `${parsed.error.code}: ` : ''
      return `${code}${message}`.slice(0, MAX_ERROR_DETAIL_CHARS)
    }
  } catch {
    // Not JSON; fall through to the raw text.
  }
  return raw.replace(/\s+/gu, ' ').trim().slice(0, MAX_ERROR_DETAIL_CHARS)
}

const mask = (message, key) => (typeof key === 'string' && key.length >= 8
  ? message.split(key).join(`…${key.slice(-4)}`)
  : message)

function isAbort(error, signal) {
  return signal?.aborted === true || error?.name === 'AbortError'
}

/**
 * Create the provider that searches through Geek2API on every request.
 * @param options - the key ring, the host resolution, the backend preference,
 *   the key-failure sink shared with the model route, and test seams.
 * @returns a DSH web search provider.
 */
export function createGeek2APISearchProvider({
  ring,
  hosts,
  backend = () => DEFAULT_SEARCH_BACKEND,
  onKeyFailure,
  covers,
  resolveSessionId,
  fetchImpl = ambientFetch,
  timeoutMs = DEFAULT_SEARCH_TIMEOUT_MS,
} = {}) {
  if (ring === undefined || typeof ring.activeKey !== 'function') throw new Error('Geek2API search requires the key ring')
  if (typeof hosts?.current !== 'function') throw new Error('Geek2API search requires the host pool')

  /** One request with one key; classified failures come back as values. */
  const attempt = async (request, key, signal) => {
    // Key resolution is asynchronous; the caller may have given up meanwhile.
    if (signal?.aborted === true) throw new WebError('Geek2API search aborted', 'WEB_ABORTED', { cause: signal.reason })
    let response
    try {
      response = await boundedFetch(request.url, {
        method: 'POST',
        headers: {
          ...request.headers(key),
          accept: 'application/json',
          'content-type': 'application/json',
        },
        body: JSON.stringify(request.body),
      }, { fetchImpl, timeoutMs, signal })
    } catch (error) {
      if (error.aborted) throw new WebError('Geek2API search aborted', 'WEB_ABORTED', { cause: error })
      if (error.timedOut) throw new WebError(`Geek2API search got no answer within ${Math.round(timeoutMs / 1000)}s`, 'WEB_PROVIDER_ERROR', { cause: error })
      throw new WebError(`Geek2API search request failed (${mask(error.code ?? error.message, key)})`, 'WEB_PROVIDER_ERROR', { cause: error })
    }
    if (!response.ok) return { failure: mask(await failureText(response), key), status: response.status }
    let body
    try {
      body = await response.json()
    } catch (error) {
      if (isAbort(error, signal)) throw new WebError('Geek2API search aborted', 'WEB_ABORTED', { cause: error })
      throw new WebError('Geek2API search returned an unreadable response', 'WEB_PROVIDER_ERROR', { cause: error })
    }
    // Some gateway channels answer 200 with an error object.
    if (record(body?.error)) return { failure: mask(text(body.error.message) || JSON.stringify(body.error).slice(0, MAX_ERROR_DETAIL_CHARS), key), status: response.status }
    return { value: request.parse(body) }
  }

  return Object.freeze({
    id: GEEK2API_SEARCH_PROVIDER_ID,
    available: () => true,
    async search(searchRequest, signal) {
      if (signal?.aborted === true) throw new WebError('Geek2API search aborted', 'WEB_ABORTED', { cause: signal.reason })
      const query = text(searchRequest?.query).trim()
      if (query === '') throw new WebError('Geek2API search needs a non-empty query', 'WEB_PROVIDER_ERROR')
      const chosen = SEARCH_BACKENDS.includes(backend()) ? backend() : DEFAULT_SEARCH_BACKEND
      const requestFor = apiHost => buildSearchRequest(chosen, {
        apiHost,
        query,
        // An MCP invocation supplies the originating session captured by
        // the host; HTTP callbacks no longer have the agent's async context.
        sessionId: searchRequest?.sessionId ?? resolveSessionId?.(),
      })
      const request = requestFor(hosts.current())
      /**
       * One key's attempt, moving to the next entry point when a host never
       * answered — the key is not at fault for that.
       */
      const attemptOnHosts = async key => {
        const tries = Math.max(1, hosts.hosts().length)
        let lastError
        for (let index = 0; index < tries; index += 1) {
          const host = hosts.current()
          try {
            return await attempt(requestFor(host), key, signal)
          } catch (error) {
            if (error?.code !== 'WEB_PROVIDER_ERROR' || !isTransportFailure(error.cause)) throw error
            hosts.fail(host, error.cause?.message)
            lastError = error
          }
        }
        throw lastError
      }

      const candidates = await orderedKeys(ring, request.model, covers)
      let lastFailure
      let uncovered = false
      for (const key of candidates.slice(0, MAX_KEY_ATTEMPTS)) {
        const outcome = await attemptOnHosts(key.key)
        if (outcome.value !== undefined) return outcome.value

        const failure = outcome.failure === '' ? `HTTP ${outcome.status}` : outcome.failure
        lastFailure = failure
        if (classifyClientPolicy(failure)) {
          throw new WebError(explainClientPolicyFailure(), 'WEB_PROVIDER_ERROR')
        }
        const kind = classifyGatewayFailure(failure)
        if (kind !== undefined) {
          // The same sink the model route uses: the key moves aside for both.
          onKeyFailure?.(kind, failure, key.key, key.id)
          continue
        }
        if (classifyCoverage(failure)) {
          // This key's groups do not reach the model; another key's might.
          uncovered = true
          continue
        }
        throw new WebError(`Geek2API search failed (HTTP ${outcome.status}): ${failure}`, 'WEB_PROVIDER_ERROR')
      }

      if (candidates.length === 0) {
        throw new WebError('Geek2API search has no usable API key; add one under Settings → Geek2API', 'WEB_PROVIDER_CREDENTIAL_MISSING')
      }
      if (uncovered) {
        const other = chosen === SEARCH_BACKEND_GPT ? SEARCH_BACKEND_CLAUDE : SEARCH_BACKEND_GPT
        throw new WebError(
          `Geek2API search: no stored API key's group covers ${request.model} (${chosen} backend). `
            + `Switch the search backend to "${other}" under Settings → Geek2API → Web search, or add a key whose group includes it. `
            + `Gateway said: ${lastFailure}`,
          'WEB_PROVIDER_ERROR',
        )
      }
      throw new WebError(`Geek2API search: every usable key was refused (${lastFailure ?? 'no detail'})`, 'WEB_PROVIDER_CREDENTIAL_MISSING')
    },
  })
}

/**
 * The keys one search tries, in order: the active key, then the other usable
 * keys in ring order — except that a key the group reading shows cannot reach
 * the backend's model goes last, behind every key that can or may.
 * @param ring - the key ring.
 * @param modelId - the backend's model.
 * @param covers - `(keyId, modelId) => true | false | undefined`, optional.
 * @returns the candidates, without key material beyond what the request needs.
 */
async function orderedKeys(ring, modelId, covers) {
  const active = await ring.activeKey()
  if (active === undefined) return []
  const usable = typeof ring.secrets === 'function' ? (await ring.secrets()).filter(entry => !entry.disabled) : []
  const start = usable.findIndex(entry => entry.id === active.id)
  const rest = start < 0 ? usable.filter(entry => entry.id !== active.id) : [...usable.slice(start + 1), ...usable.slice(0, start)]
  const rank = entry => {
    const value = covers?.(entry.id, modelId)
    return value === true ? 0 : value === false ? 2 : 1
  }
  return [active, ...rest]
    .map((entry, index) => ({ entry, index, rank: index === 0 && rank(entry) !== 2 ? -1 : rank(entry) }))
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .map(({ entry }) => ({ id: entry.id, label: entry.label, key: entry.key }))
}

/** Marks a request already passing through the auto provider's fallback. */
const delegating = new AsyncLocalStorage()

/**
 * Create the provider that searches through Geek2API for Geek2API sessions
 * only. Every other request goes to the fallback provider: the search provider
 * the web row selected before this plugin's patch, or DSH's built-in search.
 *
 * Another plugin's router may delegate back to this one (its own fallback is
 * the web row's base, which this plugin's patch points here). A request that
 * re-enters while already delegating goes straight to DSH's built-in search
 * instead of looping.
 * @param options - the Geek2API provider, the initiating model provider, a
 *   lookup of registered search providers, and the fallback id.
 * @returns a DSH web search provider.
 */
export function createGeek2APIAutoSearchProvider({ geek2api, resolveModelProvider, resolveProvider, resolveFallbackId }) {
  return Object.freeze({
    id: GEEK2API_AUTO_SEARCH_PROVIDER_ID,
    available: () => true,
    async search(request, signal) {
      if (resolveModelProvider?.() === PROVIDER) return geek2api.search(request, signal)
      const reentered = delegating.getStore() === true
      const wanted = reentered ? DSH_SEARCH_PROVIDER_FALLBACK : (resolveFallbackId?.() ?? DSH_SEARCH_PROVIDER_FALLBACK)
      const id = OWN_SEARCH_PROVIDER_IDS.includes(wanted) ? DSH_SEARCH_PROVIDER_FALLBACK : wanted
      const provider = resolveProvider?.(id)
      if (provider === undefined || OWN_SEARCH_PROVIDER_IDS.includes(provider.id) || provider.available?.() !== true) {
        throw new WebError(`Geek2API auto search: the fallback search provider "${id}" is unavailable`, 'WEB_PROVIDER_UNAVAILABLE')
      }
      return delegating.run(true, () => provider.search(request, signal))
    },
  })
}
