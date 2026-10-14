/**
 * Identities and defaults this plugin owns.
 *
 * @module dsh-geek2api/constants
 */

/** LLM provider route key; the model picker groups models under this id. */
export const PROVIDER = 'geek2api'
/** Display name of the route in the picker and settings. */
export const DISPLAY_NAME = 'Geek2API'
/** Loader row id, settings namespace, and credential-record scope. */
export const PLUGIN_ID = 'geek2api'
/** Loopback RPC channel the browser half talks to. */
export const CHANNEL = '/geek2api'
/** Settings namespace carrying host overrides. */
export const SETTINGS_NAMESPACE = 'geek2api'
/** Credential record id inside the plugin's own scope. */
export const KEY_RECORD_ID = 'keys'

/**
 * Geek2API entry points, in the order they are tried. Every one fronts the
 * same gateway: models (`/v1/chat/completions`, `/v1/responses`,
 * `/v1/messages`), the per-key balance (`/v1/usage`), the key's model list
 * (`/v1/models`) and an unauthenticated `/health`. A host that fails in
 * transit is set aside for a while and the next one serves the retry.
 */
export const DEFAULT_API_HOSTS = Object.freeze([
  'https://hk.geek2api.com',
  'https://hk2.geek2api.com',
  'https://hk3.geek2api.com',
  'https://hk4.geek2api.com',
  'https://www.geek2api.com',
])
/** The first default host; what a single-host caller uses. */
export const DEFAULT_API_HOST = DEFAULT_API_HOSTS[0]

/** How long a host that failed in transit is passed over. */
export const HOST_COOLDOWN_MS = 2 * 60_000
/** How often the reachable hosts are re-ranked by `/health` latency. */
export const HOST_PROBE_INTERVAL_MS = 10 * 60_000
/** Bound on one `/health` probe. */
export const HOST_PROBE_TIMEOUT_MS = 5_000

/** Balance cache lifetime; a forced read bypasses it. */
export const DEFAULT_BALANCE_TTL_MS = 60_000
/** Bound on every account request this plugin makes. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 20_000

/** Effort level the route requests when a session names none. */
export const DEFAULT_REASONING_LEVEL = 'high'
