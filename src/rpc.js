/**
 * The loopback RPC surface behind the settings panel and the composer chip.
 *
 * Every reply carries only what this plugin owns: key labels and state, the
 * balance and group projections the host built, host overrides, whether this
 * device has the Claude Code CLI, the plugin version, and the web search
 * preference and model visibility. Key material never crosses this boundary.
 *
 * @module dsh-geek2api/rpc
 */

import { DEFAULT_API_HOSTS } from './constants.js'
import { normalizeHostList } from './hosts.js'

export { normalizeHost, normalizeHostList } from './hosts.js'

const ok = value => ({ ok: true, value })
// Connection 0.2 validates all three error fields, even on plugin channels.
const failed = message => ({ ok: false, error: { code: 'geek2api/request-failed', message, details: {} } })

/** Only sentences this plugin authored may reach the browser. */
const SAFE_MESSAGE = /^(?:Geek2API|That |Unknown |Geek2API's |add |the |no Geek2API host)[\s\S]{0,400}$/u

const keyId = payload => String(payload?.id ?? '')

/**
 * Build the RPC handler.
 * @param options - the key ring, the balance and group readers, the host
 *   preference, and the optional Claude Code CLI manager, plugin manager, and
 *   web search controller (without one, its endpoints refuse).
 * @returns a handler for `connection.rpc.handle(CHANNEL, handler)`.
 */
export function createGeek2APIRpc({ ring, balance, groups, hosts, keys, preference, claudeRuntime, claudeCli, pluginManager, search, modelSelection }) {
  const need = (service, message) => {
    if (service === undefined) throw new Error(message)
    return service
  }
  const cli = () => need(claudeCli, 'Geek2API Claude Code CLI support is unavailable in this runtime')
  const manager = () => need(pluginManager, 'Geek2API plugin version is unavailable')
  const webSearch = () => need(search, 'Geek2API web search is unavailable in this runtime')
  const groupReader = () => need(groups, 'Geek2API key groups are unavailable in this runtime')
  const models = () => need(modelSelection, 'Geek2API model selection is unavailable in this runtime')

  const status = async () => ({
    ...(await ring.list()),
    hosts: hosts.status(),
    writable: preference.writable === true,
    defaults: { apiHosts: [...DEFAULT_API_HOSTS] },
    claudeRuntime: typeof claudeRuntime === 'function' ? claudeRuntime() : 'http',
    skipped: typeof keys?.skipped === 'function' ? keys.skipped() : {},
  })
  const writable = () => {
    if (preference.writable !== true) throw new Error('Geek2API settings are not writable in this profile')
  }

  /**
   * Key mutations, each answered with the new status. Every one drops the
   * cached balance; one that changes which keys exist also drops the groups.
   */
  const keyMutations = {
    'keys/add': { run: payload => ring.add(payload?.key, payload?.label), changesKeys: true },
    'keys/rename': { run: payload => ring.rename(keyId(payload), payload?.label) },
    'keys/remove': { run: payload => ring.remove(keyId(payload)), changesKeys: true },
    'keys/remove-all': { run: () => ring.removeAll(), changesKeys: true },
    'keys/select': { run: payload => ring.select(keyId(payload)) },
    'keys/enable': { run: payload => ring.enable(keyId(payload)) },
  }

  const endpoints = {
    status: () => status(),
    balance: async payload => {
      const [value, state] = await Promise.all([balance.read({ force: payload?.force === true }), ring.list()])
      return { ...value, activeId: state.activeId }
    },
    groups: payload => groupReader().read({ force: payload?.force === true }),
    'hosts/update': async payload => {
      writable()
      await preference.set({ apiHosts: normalizeHostList(payload?.apiHosts) })
      balance.invalidate()
      groups?.invalidate()
      await hosts.probe({ force: true }).catch(() => undefined)
      return status()
    },
    'hosts/probe': async () => {
      await hosts.probe({ force: true })
      return status()
    },
    'claude-runtime/update': async payload => {
      writable()
      if (payload?.runtime !== 'http' && payload?.runtime !== 'cli') throw new Error('That Geek2API Claude runtime is not supported')
      await preference.set({ claudeRuntime: payload.runtime })
      return status()
    },
    'claude-cli/status': payload => cli().status({ force: payload?.force === true }),
    // Starts the install and answers at once; the panel polls the status
    // instead of holding one request open for minutes.
    'claude-cli/install': () => {
      cli().install()
      return cli().status()
    },
    'plugin/version': (payload, signal) => manager().read({ force: payload?.force === true, signal }),
    'plugin/update': (_payload, signal) => manager().update({ signal }),
    'search/status': () => webSearch().status(),
    'search/update': payload => webSearch().update({
      searchProvider: payload?.searchProvider,
      searchBackend: payload?.searchBackend,
    }),
    'models/status': () => models().status(),
    'models/update': payload => models().update({ selectedIds: payload?.selectedIds }),
  }

  return async (endpoint, payload, signal) => {
    try {
      const mutation = Object.hasOwn(keyMutations, endpoint) ? keyMutations[endpoint] : undefined
      if (mutation !== undefined) {
        await mutation.run(payload)
        balance.invalidate()
        if (mutation.changesKeys) groups?.invalidate()
        return ok(await status())
      }
      const handle = Object.hasOwn(endpoints, endpoint) ? endpoints[endpoint] : undefined
      if (handle === undefined) return failed('Unknown Geek2API endpoint')
      return ok(await handle(payload, signal))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return failed(SAFE_MESSAGE.test(message) ? message : 'Geek2API request failed')
    }
  }
}
