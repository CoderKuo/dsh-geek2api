import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { DEFAULT_API_HOST } from '../src/constants.js'
import { apply, Config } from '../src/index.js'
import { fakeCredentials } from './helpers.mjs'
import { fieldValue } from '../src/preferences.js'

const USER_PATCH = '- id: permission\n  config:\n    defaultPreset: danger-full-access\n'

/**
 * A context shaped like the DSH host at the seams the search wiring touches:
 * the web service registry, the Loader's web entry, the running profile's
 * patch path, the initiating agent, and one of the two settings generations.
 */
async function makeContext({ settings: generation = '0.2' } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'geek2api-wiring-'))
  const patchPath = join(dir, 'cordis.patch.yml')
  await writeFile(patchPath, USER_PATCH)

  const values = { searchProvider: 'default', searchBackend: 'claude' }
  const seen = { updates: [], configured: [], listeners: new Map(), handler: undefined, section: undefined }
  const providers = new Map()
  const dshSearch = { id: 'deepseek-official', available: () => true, search: async () => ({ sources: [{ url: 'https://dsh.example/' }], truncated: false }) }
  providers.set(dshSearch.id, dshSearch)
  const web = {
    searchProviders: providers,
    registerSearchProvider(provider) {
      if (providers.has(provider.id)) throw new Error(`duplicate ${provider.id}`)
      providers.set(provider.id, provider)
      return () => providers.delete(provider.id)
    },
  }
  const webEntry = {
    options: { id: 'web', config: { searchProvider: 'deepseek-official', fetchProvider: 'http' } },
    fiber: { config: { searchProvider: 'codex-subscription-auto', fetchProvider: 'http' } },
  }
  let modelProvider = 'geek2api'
  const session = { id: 'session-1', requestContext: () => ({ provider: modelProvider }) }
  const services = {
    profileContext: { patchPath },
    loader: { entries: () => [webEntry] },
    agents: { currentInitiator: () => ({ session }) },
  }

  let settings
  if (generation === '0.2') {
    settings = {
      writable: true,
      async update(id, patch) {
        seen.updates.push({ id, patch })
        Object.assign(values, patch)
      },
      configure(presentation, owner) {
        seen.configured.push({ presentation, owner })
        return () => {}
      },
    }
  } else {
    let section
    settings = {
      installSection(_owner, ns, _schema, entry, hooks) {
        section = { ...entry }
        seen.section = { ns, hooks }
        hooks.setSource(() => section)
      },
      async update(ns, patch) {
        seen.updates.push({ id: ns, patch })
        section = { ...section, ...patch }
        seen.section.hooks.onChange()
      },
    }
  }

  const fiber = { entry: { options: { id: 'geek2api' } } }
  const ctx = {
    credentials: fakeCredentials(),
    attachments: undefined,
    logger: { warn: () => {} },
    fiber,
    llm: { registerAdapter: () => () => {}, registerConfigurableProviders: () => () => {} },
    get: name => services[name],
    on(event, callback) {
      seen.listeners.set(event, callback)
      return () => {}
    },
    inject(names, callback) {
      if (names.includes('settings')) return callback({ settings, effect: ctx.effect })
      if (names.includes('web')) return callback({ web, effect: ctx.effect })
      if (names.includes('tools')) return callback({ tools: { register: () => () => {} } })
      if (names.includes('connection')) {
        return callback({ effect: ctx.effect, connection: { rpc: { handle: (_channel, handler) => { seen.handler = handler; return () => {} } } } })
      }
      return callback(ctx)
    },
    effect(callback) {
      const disposer = callback()
      return typeof disposer === 'function' ? disposer : () => {}
    },
  }
  // DSH 0.2 hands volatile fields over as live references.
  const config = generation === '0.2'
    ? { searchProvider: { get: () => values.searchProvider }, searchBackend: { get: () => values.searchBackend } }
    : {}
  return {
    ctx,
    config,
    seen,
    providers,
    values,
    patchPath,
    setModelProvider: value => { modelProvider = value },
    cleanup: () => rm(dir, { recursive: true, force: true }),
  }
}

/** Let the reconcile chain started by a registration settle. */
const settle = () => new Promise(resolve => { setTimeout(resolve, 20) })

test('the search preference fields are part of the plugin Config', () => {
  const resolved = new Config({})
  assert.equal(fieldValue(resolved.searchProvider), 'default')
  assert.equal(fieldValue(resolved.searchBackend), 'claude')
  assert.throws(() => new Config({ searchProvider: 'everything' }))
})

test('DSH 0.2: both providers register, and the panel switches routing through the profile patch', async t => {
  const env = await makeContext({ settings: '0.2' })
  t.after(env.cleanup)
  apply(env.ctx, env.config)
  await settle()

  assert.ok(env.providers.has('geek2api'))
  assert.ok(env.providers.has('geek2api-auto'))
  // The Geek2API panel is the editor; the generated page is hidden for this fiber.
  assert.deepEqual(env.seen.configured, [{ presentation: { auto: false }, owner: env.ctx.fiber }])
  assert.equal(typeof env.seen.listeners.get('loader/volatile-update'), 'function')

  const initial = await env.seen.handler('search/status', {})
  assert.equal(initial.ok, true)
  assert.equal(initial.value.searchProvider, 'default')
  assert.equal(initial.value.searchBackend, 'claude')
  assert.equal(initial.value.writable, true)
  assert.equal(initial.value.available, true)
  assert.deepEqual(initial.value.effective, { base: 'deepseek-official', runtime: 'codex-subscription-auto' })
  assert.deepEqual(initial.value.models, { claude: 'claude-haiku-4-5-20251001', gpt: 'gpt-6.1-sol' })
  assert.equal(await readFile(env.patchPath, 'utf8'), USER_PATCH, 'the default selection writes nothing')

  const auto = await env.seen.handler('search/update', { searchProvider: 'auto' })
  assert.equal(auto.ok, true)
  // DSH 0.2 writes a volatile field of the plugin's own row.
  assert.deepEqual(env.seen.updates, [{ id: 'geek2api', patch: { searchProvider: 'auto' } }])
  assert.equal(auto.value.searchProvider, 'auto')
  assert.deepEqual(auto.value.applied, { state: 'applied', fallback: 'deepseek-official' })
  const patched = await readFile(env.patchPath, 'utf8')
  assert.ok(patched.startsWith(USER_PATCH))
  assert.match(patched, /- id: web\n {2}config:\n {4}fetchProvider: http\n {4}searchProvider: geek2api-auto\n/u)

  const backend = await env.seen.handler('search/update', { searchBackend: 'gpt' })
  assert.equal(backend.value.searchBackend, 'gpt')
  const refused = await env.seen.handler('search/update', { searchBackend: 'bing' })
  assert.equal(refused.ok, false)
  assert.match(refused.error.message, /not supported/u)

  const back = await env.seen.handler('search/update', { searchProvider: 'default' })
  assert.deepEqual(back.value.applied, { state: 'removed' })
  assert.equal(await readFile(env.patchPath, 'utf8'), USER_PATCH)
})

test('DSH 0.2: a volatile change made elsewhere is followed without a restart', async t => {
  const env = await makeContext({ settings: '0.2' })
  t.after(env.cleanup)
  apply(env.ctx, env.config)
  await settle()
  env.values.searchProvider = 'geek2api'
  env.seen.listeners.get('loader/volatile-update')([['searchProvider']])
  await settle()
  assert.match(await readFile(env.patchPath, 'utf8'), /searchProvider: geek2api\n/u)
})

test('DSH 0.1.5: the preference lives in the installed section and its change hook reconciles', async t => {
  const env = await makeContext({ settings: '0.1' })
  t.after(env.cleanup)
  apply(env.ctx, {})
  await settle()
  assert.equal(env.seen.section.ns, 'geek2api')
  const updated = await env.seen.handler('search/update', { searchProvider: 'geek2api', searchBackend: 'gpt' })
  assert.equal(updated.ok, true)
  assert.deepEqual(env.seen.updates, [{ id: 'geek2api', patch: { searchProvider: 'geek2api', searchBackend: 'gpt' } }])
  assert.equal(updated.value.searchProvider, 'geek2api')
  assert.equal(updated.value.searchBackend, 'gpt')
  assert.match(await readFile(env.patchPath, 'utf8'), /searchProvider: geek2api\n/u)
})

test('the registered providers search with ring keys and route by the initiating model', async t => {
  const env = await makeContext({ settings: '0.2' })
  t.after(env.cleanup)
  apply(env.ctx, env.config)
  await settle()
  const added = await env.seen.handler('keys/add', { key: 'sk-search-key-0001', label: 'search' })
  assert.equal(added.ok, true)

  const original = globalThis.fetch
  const requests = []
  globalThis.fetch = async (url, init) => {
    // Every probe answers alike, so the configured order decides the host.
    if (String(url).endsWith('/health')) return { ok: false, status: 503 }
    requests.push({ url, key: new Headers(init.headers).get('x-api-key') })
    return {
      ok: true,
      status: 200,
      json: async () => ({
        content: [
          { type: 'web_search_tool_result', content: [{ type: 'web_search_result', url: 'https://geek2api.example/', title: 'Geek2API result' }] },
          { type: 'text', text: 'summary' },
        ],
      }),
    }
  }
  t.after(() => { globalThis.fetch = original })

  const direct = await env.providers.get('geek2api').search({ query: 'q' })
  assert.equal(direct.sources[0].url, 'https://geek2api.example/')
  assert.deepEqual(requests, [{ url: `${DEFAULT_API_HOST}/v1/messages`, key: 'sk-search-key-0001' }])

  const auto = env.providers.get('geek2api-auto')
  assert.equal((await auto.search({ query: 'q' })).sources[0].url, 'https://geek2api.example/')
  env.setModelProvider('anthropic')
  assert.equal((await auto.search({ query: 'q' })).sources[0].url, 'https://dsh.example/')
  assert.equal(requests.length, 2, 'the non-Geek2API request never reached the gateway')
})

test('patch writes run inside DSH\'s reload lock, and unlocked when that lock refuses to nest', async t => {
  const env = await makeContext({ settings: '0.2' })
  t.after(env.cleanup)
  let nested = false
  let locked = 0
  env.ctx.get = (original => name => (name === 'hmr'
    ? {
        async runExclusive(operation) {
          if (nested) throw new Error('HMR transactions cannot be nested')
          locked += 1
          return operation()
        },
      }
    : original(name)))(env.ctx.get)
  apply(env.ctx, env.config)
  await settle()
  const before = locked
  await env.seen.handler('search/update', { searchProvider: 'auto' })
  assert.equal(locked, before + 1)
  assert.match(await readFile(env.patchPath, 'utf8'), /searchProvider: geek2api-auto\n/u)

  nested = true
  const updated = await env.seen.handler('search/update', { searchProvider: 'geek2api' })
  assert.equal(updated.value.applied.state, 'applied')
  assert.match(await readFile(env.patchPath, 'utf8'), /searchProvider: geek2api\n/u)
})

test('a profile without the web service keeps its route and reports search unavailable', async t => {
  const env = await makeContext({ settings: '0.2' })
  t.after(env.cleanup)
  const inject = env.ctx.inject
  env.ctx.inject = (names, callback) => (names.includes('web') ? undefined : inject(names, callback))
  apply(env.ctx, env.config)
  const status = await env.seen.handler('search/status', {})
  assert.equal(status.value.available, false)
  assert.equal(env.providers.has('geek2api'), false)
})
