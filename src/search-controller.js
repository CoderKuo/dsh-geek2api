/**
 * Web search wiring: the two search providers, the user's routing and backend
 * preference, the profile-patch entry that makes DSH reach them, and the
 * projection the settings panel reads.
 *
 * @module dsh-geek2api/search-controller
 */

import {
  createGeek2APIAutoSearchProvider,
  createGeek2APISearchProvider,
  DEFAULT_SEARCH_BACKEND,
  GEEK2API_AUTO_SEARCH_PROVIDER_ID,
  GEEK2API_SEARCH_PROVIDER_ID,
  SEARCH_BACKEND_MODELS,
  SEARCH_BACKENDS,
  SEARCH_MODE_AUTO,
  SEARCH_MODE_DEFAULT,
  SEARCH_MODE_GEEK2API,
  SEARCH_MODES,
} from './search.js'
import { usableFallback } from './search-composition.js'
import { fieldValue } from './preferences.js'

/** Routers other subscription plugins register; shown so the user knows who holds the slot. */
const FOREIGN_ROUTERS = Object.freeze({ codex: 'codex-subscription-auto', kimi: 'kimi-subscription-auto' })

/** Normalize a stored preference; anything unknown reads as the default. */
export function readSearchChoice(value) {
  const provider = fieldValue(value?.searchProvider)
  const selectedBackend = fieldValue(value?.searchBackend)
  const mode = SEARCH_MODES.includes(provider) ? provider : SEARCH_MODE_DEFAULT
  const backend = SEARCH_BACKENDS.includes(selectedBackend) ? selectedBackend : DEFAULT_SEARCH_BACKEND
  return { mode, backend }
}

/** Only sentences this plugin wrote reach the browser. */
function safeMessage(error) {
  const message = error instanceof Error ? error.message : String(error)
  return /^Geek2API /u.test(message) ? message.slice(0, 240) : 'Geek2API web search could not update the profile patch'
}

/**
 * @param options - the key ring and hosts the search runs with, the key-failure
 *   sink and group coverage shared with the model route, the preference reader
 *   and writer, the initiating session's provider and id, the web row's Loader
 *   entry, the profile-patch composition, a logger, and an optional fetch.
 */
export function createSearchController({
  ring,
  hosts,
  onKeyFailure,
  covers,
  readPreference,
  writePreference,
  isWritable = () => typeof writePreference === 'function',
  resolveModelProvider,
  resolveSessionId,
  webEntry = () => undefined,
  composition,
  logger,
  fetchImpl,
}) {
  let web
  let fallbackId
  let applied = { state: 'idle' }
  let chain = Promise.resolve()

  const preference = () => readSearchChoice(readPreference?.())

  const geek2api = createGeek2APISearchProvider({
    ring,
    hosts,
    backend: () => preference().backend,
    onKeyFailure,
    covers,
    resolveSessionId,
    ...(fetchImpl === undefined ? {} : { fetchImpl }),
  })

  const auto = createGeek2APIAutoSearchProvider({
    geek2api,
    resolveModelProvider,
    resolveProvider: id => web?.searchProviders?.get?.(id),
    // Before the first reconcile, the base config may already name this
    // plugin; usableFallback then answers DSH's built-in search.
    resolveFallbackId: () => fallbackId ?? usableFallback(webEntry()?.options?.config?.searchProvider),
  })

  /** Make the profile patch match the preference; serialized, idempotent. */
  const reconcile = () => {
    const run = async () => {
      if (web === undefined || composition === undefined) {
        applied = { state: 'unavailable' }
        return
      }
      const { mode } = preference()
      try {
        if (mode === SEARCH_MODE_DEFAULT) {
          await composition.remove()
          fallbackId = undefined
          applied = { state: 'removed' }
        } else {
          const outcome = await composition.apply(mode === SEARCH_MODE_AUTO ? GEEK2API_AUTO_SEARCH_PROVIDER_ID : GEEK2API_SEARCH_PROVIDER_ID)
          fallbackId = outcome.fallback
          applied = { state: 'applied', fallback: outcome.fallback }
        }
      } catch (error) {
        applied = { state: 'failed', error: safeMessage(error) }
        logger?.warn?.('geek2api: could not apply the web search selection: %s', error?.message ?? String(error))
      }
    }
    const next = chain.then(run)
    chain = next.then(() => undefined, () => undefined)
    return next
  }

  const status = () => {
    const { mode, backend } = preference()
    const entry = webEntry()
    const base = entry?.options?.config?.searchProvider
    const runtime = entry?.fiber?.config?.searchProvider
    return {
      searchProvider: mode,
      searchBackend: backend,
      writable: isWritable() === true,
      available: web !== undefined,
      models: { ...SEARCH_BACKEND_MODELS },
      effective: {
        ...(typeof base === 'string' ? { base } : {}),
        ...(typeof runtime === 'string' ? { runtime } : {}),
      },
      applied: { ...applied },
      foreign: Object.fromEntries(Object.entries(FOREIGN_ROUTERS).map(([name, id]) => [name, web?.searchProviders?.has?.(id) === true])),
    }
  }

  return Object.freeze({
    geek2api,
    auto,
    /**
     * Register both providers with the web service and reconcile once.
     * @param service - the `web` service, as the inject scope hands it over.
     * @param effect - that scope's effect registrar.
     */
    register(service, effect) {
      effect(() => {
        web = service
        const disposeGeek2api = service.registerSearchProvider(geek2api)
        const disposeAuto = service.registerSearchProvider(auto)
        return () => {
          disposeAuto?.()
          disposeGeek2api?.()
          if (web === service) web = undefined
        }
      }, 'geek2api: web search providers')
      void reconcile()
    },
    reconcile,
    status,
    /** Validate, persist, and apply a preference change. */
    async update(patch) {
      const next = {}
      if (patch?.searchProvider !== undefined) {
        if (!SEARCH_MODES.includes(patch.searchProvider)) throw new Error('That Geek2API search option is not supported')
        next.searchProvider = patch.searchProvider
      }
      if (patch?.searchBackend !== undefined) {
        if (!SEARCH_BACKENDS.includes(patch.searchBackend)) throw new Error('That Geek2API search backend is not supported')
        next.searchBackend = patch.searchBackend
      }
      if (Object.keys(next).length === 0) return status()
      if (isWritable() !== true || typeof writePreference !== 'function') {
        throw new Error('Geek2API settings are not writable in this profile')
      }
      try {
        await writePreference(next)
      } catch (error) {
        logger?.warn?.('geek2api: could not save the web search preference: %s', error?.message ?? String(error))
        throw new Error('Geek2API could not save the web search preference', { cause: error })
      }
      await reconcile()
      return status()
    },
  })
}

export { SEARCH_MODE_AUTO, SEARCH_MODE_DEFAULT, SEARCH_MODE_GEEK2API }
